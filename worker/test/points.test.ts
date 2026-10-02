// 积分系统：余额 / 流水 / 兑换中转站余额 / 活动发放 / HTTP 接口。
//
// 重点验证四件事（都是「错了会真丢钱或真送钱」的地方）：
//   1. 扣减的原子性：余额不足时不能扣成负数（条件 UPDATE 的 changes=0 分支）
//   2. 幂等：同一 dedup_key 只能落账一次，并发重复不能重复发放
//   3. 兑换的安全顺序：**先扣积分、NewAPI 失败要把积分退回来**，
//      且未绑定中转站时必须在扣分之前就拦住
//   4. 活动奖励 points 类型能正常发到用户余额上
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, setSetting, setPermissions } from "./helpers"
import { applyPoints, getPointsBalance, redeemPoints } from "../src/points"
import { expireRentalOrders } from "../src/points-shop"
import { resetAdminCredentialCache } from "../src/newapi-client"
import { REWARD_HANDLERS } from "../src/event-rewards"

const BASE = "https://api.doulor.cn"

let quotaCalls: { userId: number; value: number; mode: string }[] = []
let subscriptionCalls: { userId: number; planId: number }[] = []
let failManage = false
let failSubscription = false
let restore: (() => void) | null = null

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/** 打桩 Worker 出站 fetch：只接管发往 NewAPI 的请求，其余透传 */
function stubNewApi(): void {
  const original = globalThis.fetch
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(BASE)) return original(input as RequestInfo, init)

    if (url.includes("/api/status")) {
      return jsonResponse({
        success: true,
        data: { quota_display_type: "CNY", quota_per_unit: 500000 },
      })
    }
    if (url.includes("/api/user/manage")) {
      if (failManage) return jsonResponse({ success: false, message: "上游炸了" }, 500)
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        id: number
        value: number
        mode: string
      }
      quotaCalls.push({ userId: body.id, value: body.value, mode: body.mode })
      return jsonResponse({ success: true, data: null })
    }
    // 开通订阅：POST /api/subscription/admin/users/:id/subscriptions
    const subMatch = url.match(/\/api\/subscription\/admin\/users\/(\d+)\/subscriptions/)
    if (subMatch) {
      if (failSubscription) return jsonResponse({ success: false, message: "套餐不存在" }, 400)
      const body = JSON.parse(String(init?.body ?? "{}")) as { plan_id: number }
      subscriptionCalls.push({ userId: Number(subMatch[1]), planId: body.plan_id })
      return jsonResponse({ success: true, data: { message: "" } })
    }
    return original(input as RequestInfo, init)
  }) as typeof fetch
  globalThis.fetch = stub
  restore = () => {
    globalThis.fetch = original
  }
}

/** 给用户绑一个中转站账号（兑换的前置条件） */
async function bindNewApi(userId: string, newapiUserId: number): Promise<void> {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO newapi_accounts
       (user_id, newapi_user_id, username, email, enc_token, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(userId, newapiUserId, `na_${newapiUserId}`, `na_${newapiUserId}@doulor.cn`, "enc", now)
    .run()
}

/** 读某用户的流水条数 */
async function txCount(userId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM point_transactions WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ c: number }>()
  return Number(row?.c ?? 0)
}

beforeEach(async () => {
  quotaCalls = []
  subscriptionCalls = []
  failManage = false
  failSubscription = false
  stubNewApi()
  resetAdminCredentialCache()
  // 每个用例都从「开关开、比例 1 元/积分、不限次」起步，避免相互污染
  await setSetting("points_enabled", "1")
  await setSetting("points_yuan_per_point", "1")
  await setSetting("points_redeem_daily_limit", "0")
})

afterEach(() => {
  restore?.()
  restore = null
})

describe("积分核心：余额与流水", () => {
  it("新用户余额为 0，且不会因为读余额而建行", async () => {
    const u = await makeUser()
    expect(await getPointsBalance(env, u.id)).toBe(0)
    const row = await env.DB.prepare("SELECT 1 AS x FROM user_points WHERE user_id = ?")
      .bind(u.id)
      .first()
    expect(row).toBeNull()
  })

  it("增加积分：余额与流水同时落账", async () => {
    const u = await makeUser()
    const res = await applyPoints(env, {
      userId: u.id,
      delta: 100,
      reason: "event",
      detail: "测试发放",
    })
    expect(res.applied).toBe(true)
    expect(res.balance).toBe(100)
    expect(await getPointsBalance(env, u.id)).toBe(100)
    expect(await txCount(u.id)).toBe(1)
  })

  it("扣减积分：余额足够时正常扣", async () => {
    const u = await makeUser()
    await applyPoints(env, { userId: u.id, delta: 100, reason: "admin" })
    const res = await applyPoints(env, { userId: u.id, delta: -30, reason: "redeem" })
    expect(res.applied).toBe(true)
    expect(res.balance).toBe(70)
    const transactions = await env.DB.prepare(
      "SELECT delta, balance FROM point_transactions WHERE user_id = ? ORDER BY delta DESC"
    ).bind(u.id).all<{ delta: number; balance: number }>()
    expect(transactions.results?.map(({ delta, balance }) => [delta, balance])).toEqual([
      [100, 100],
      [-30, 70],
    ])
  })

  it("余额不足时不扣成负数，且不写流水", async () => {
    const u = await makeUser()
    await applyPoints(env, { userId: u.id, delta: 50, reason: "admin" })
    const res = await applyPoints(env, { userId: u.id, delta: -100, reason: "redeem" })
    expect(res.applied).toBe(false)
    expect(res.reason).toBe("insufficient")
    expect(res.balance).toBe(50)
    expect(await getPointsBalance(env, u.id)).toBe(50)
    // 只有第一笔成功的那条流水
    expect(await txCount(u.id)).toBe(1)
  })

  it("同一 dedup_key 只落账一次（幂等）", async () => {
    const u = await makeUser()
    const first = await applyPoints(env, {
      userId: u.id,
      delta: 20,
      reason: "event",
      dedupKey: "event:evt-1",
    })
    const second = await applyPoints(env, {
      userId: u.id,
      delta: 20,
      reason: "event",
      dedupKey: "event:evt-1",
    })
    expect(first.applied).toBe(true)
    expect(second.applied).toBe(false)
    expect(second.reason).toBe("duplicated")
    // 关键：余额没有被重复加
    expect(await getPointsBalance(env, u.id)).toBe(20)
    expect(await txCount(u.id)).toBe(1)
  })

  it("并发重复发放不会通过回滚窗口制造额外余额", async () => {
    const u = await makeUser()
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        applyPoints(env, { userId: u.id, delta: 20, reason: "event", dedupKey: "event:race" })
      )
    )
    expect(results.filter((r) => r.applied)).toHaveLength(1)
    expect(await getPointsBalance(env, u.id)).toBe(20)
    expect(await txCount(u.id)).toBe(1)
  })
})

describe("兑换中转站余额", () => {
  it("未绑定中转站账号：在扣积分之前就拒绝，余额不变", async () => {
    const u = await makeUser()
    await applyPoints(env, { userId: u.id, delta: 100, reason: "admin" })
    await expect(redeemPoints(env, u.id, u.username, 50)).rejects.toMatchObject({
      code: "NOT_BOUND",
    })
    expect(await getPointsBalance(env, u.id)).toBe(100)
    expect(quotaCalls.length).toBe(0)
  })

  it("积分不足：拒绝且不调用中转站", async () => {
    const u = await makeUser()
    await bindNewApi(u.id, 9001)
    await applyPoints(env, { userId: u.id, delta: 10, reason: "admin" })
    await expect(redeemPoints(env, u.id, u.username, 50)).rejects.toMatchObject({
      code: "INSUFFICIENT_POINTS",
    })
    expect(quotaCalls.length).toBe(0)
  })

  it("成功兑换：按比例扣积分，并按 1 元 = 500000 额度加余额", async () => {
    const u = await makeUser()
    await bindNewApi(u.id, 9002)
    await applyPoints(env, { userId: u.id, delta: 100, reason: "admin" })

    const res = await redeemPoints(env, u.id, u.username, 40)
    expect(res.ok).toBe(true)
    expect(res.balance).toBe(60)
    expect(res.amount).toBe(40)
    // 每 1 积分 = 1 元 ⇒ 40 积分兑 40 元 ⇒ 40 * 500000 原始额度，mode=add
    expect(quotaCalls).toEqual([{ userId: 9002, value: 20_000_000, mode: "add" }])
  })

  it("比例是「每 1 积分值多少元」：填 10 就是 1 积分兑 10 元", async () => {
    // 站长的原始诉求：设置里填 10，表示 1 积分 = 10 元（不是 10 积分 = 1 元）
    await setSetting("points_yuan_per_point", "10")
    const u = await makeUser()
    await bindNewApi(u.id, 9003)
    await applyPoints(env, { userId: u.id, delta: 100, reason: "admin" })

    const res = await redeemPoints(env, u.id, u.username, 40)
    expect(res.amount).toBe(400)
    expect(quotaCalls).toEqual([{ userId: 9003, value: 200_000_000, mode: "add" }])
  })

  it("比例支持小数：0.1 元/积分时，40 积分兑 4 元", async () => {
    // 旧实现（points_per_yuan = 多少积分换 1 元）下「1 积分 = 10 元」要填 0.1，
    // 却被 Math.round + Math.max(1, …) 静默吃成 1 —— 这个用例锁住小数不再被吃掉。
    await setSetting("points_yuan_per_point", "0.1")
    const u = await makeUser()
    await bindNewApi(u.id, 9008)
    await applyPoints(env, { userId: u.id, delta: 100, reason: "admin" })

    const res = await redeemPoints(env, u.id, u.username, 40)
    expect(res.amount).toBe(4)
    expect(quotaCalls).toEqual([{ userId: 9008, value: 2_000_000, mode: "add" }])
  })

  it("中转站加额度失败：积分必须退回（用户不丢积分）", async () => {
    const u = await makeUser()
    await bindNewApi(u.id, 9004)
    await applyPoints(env, { userId: u.id, delta: 100, reason: "admin" })

    failManage = true
    await expect(redeemPoints(env, u.id, u.username, 30)).rejects.toMatchObject({
      code: "REDEEM_FAILED",
    })
    // 退回后余额回到 100
    expect(await getPointsBalance(env, u.id)).toBe(100)
  })

  it("总开关关闭时拒绝兑换", async () => {
    await setSetting("points_enabled", "0")
    const u = await makeUser()
    await bindNewApi(u.id, 9005)
    await applyPoints(env, { userId: u.id, delta: 100, reason: "admin" })
    await expect(redeemPoints(env, u.id, u.username, 10)).rejects.toMatchObject({
      code: "POINTS_DISABLED",
    })
  })

  it("每日兑换次数上限生效", async () => {
    await setSetting("points_redeem_daily_limit", "1")
    const u = await makeUser()
    await bindNewApi(u.id, 9006)
    await applyPoints(env, { userId: u.id, delta: 100, reason: "admin" })

    await redeemPoints(env, u.id, u.username, 10)
    await expect(redeemPoints(env, u.id, u.username, 10)).rejects.toMatchObject({
      code: "REDEEM_LIMIT",
    })
  })
})

describe("活动奖励：points 类型", () => {
  it("发放积分到用户余额", async () => {
    const u = await makeUser()
    const res = await REWARD_HANDLERS.points({
      env,
      userId: u.id,
      username: u.username,
      params: { amount: 30 },
      eventId: "evt-abc",
    })
    expect(res.status).toBe("granted")
    expect(await getPointsBalance(env, u.id)).toBe(30)
  })

  it("同一活动重复发放不会翻倍（dedup 兜底）", async () => {
    const u = await makeUser()
    const ctx = {
      env,
      userId: u.id,
      username: u.username,
      params: { amount: 30 },
      eventId: "evt-dup",
    }
    await REWARD_HANDLERS.points(ctx)
    const again = await REWARD_HANDLERS.points(ctx)
    expect(again.status).toBe("granted")
    expect(await getPointsBalance(env, u.id)).toBe(30)
  })

  it("积分数非法时返回 failed", async () => {
    const u = await makeUser()
    const res = await REWARD_HANDLERS.points({
      env,
      userId: u.id,
      username: u.username,
      params: { amount: 0 },
      eventId: "evt-bad",
    })
    expect(res.status).toBe("failed")
  })
})

describe("HTTP 接口", () => {
  it("GET /api/points 返回余额、配置与流水", async () => {
    const u = await makeUser()
    await applyPoints(env, { userId: u.id, delta: 15, reason: "admin", detail: "手工发放" })

    const res = await fetchSelf(authRequest(u, "/api/points"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      balance: number
      bound: boolean
      config: { enabled: boolean; yuanPerPoint: number }
      transactions: { delta: number; detail: string | null }[]
      products: unknown[]
      orders: unknown[]
    }
    expect(body.balance).toBe(15)
    expect(body.bound).toBe(false)
    expect(body.config.enabled).toBe(true)
    expect(body.config.yuanPerPoint).toBe(1)
    expect(body.transactions.length).toBe(1)
    expect(body.transactions[0].delta).toBe(15)
    // 商城数据随积分概览一起下发，前端一次请求就能把整页画出来
    expect(body.products).toEqual([])
    expect(body.orders).toEqual([])
  })

  it("POST /api/points/redeem 成功并返回到账金额", async () => {
    const u = await makeUser()
    await bindNewApi(u.id, 9007)
    await applyPoints(env, { userId: u.id, delta: 50, reason: "admin" })

    const res = await fetchSelf(
      authRequest(u, "/api/points/redeem", {
        method: "POST",
        body: JSON.stringify({ points: 20 }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { balance: number; amount: number }
    expect(body.balance).toBe(30)
    expect(body.amount).toBe(20)
  })

  it("未登录访问 /api/points 返回 401", async () => {
    const res = await fetchSelf(new Request("https://cloud.doulor.cn/api/points"))
    expect(res.status).toBe(401)
  })

  it("非管理员访问 /api/admin/points 返回 403", async () => {
    const u = await makeUser()
    const res = await fetchSelf(authRequest(u, "/api/admin/points"))
    expect(res.status).toBe(403)
  })
})

describe("管理端调整积分", () => {
  it("管理员发放与扣减，扣减超额时报错", async () => {
    const admin = await makeUser({ role: "admin" })
    const target = await makeUser()

    const grant = await fetchSelf(
      authRequest(admin, "/api/admin/points/adjust", {
        method: "POST",
        body: JSON.stringify({ username: target.username, delta: 80, detail: "活动补发" }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(grant.status).toBe(200)
    expect(((await grant.json()) as { balance: number }).balance).toBe(80)

    const deduct = await fetchSelf(
      authRequest(admin, "/api/admin/points/adjust", {
        method: "POST",
        body: JSON.stringify({ username: target.username, delta: -30 }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(deduct.status).toBe(200)
    expect(((await deduct.json()) as { balance: number }).balance).toBe(50)

    const over = await fetchSelf(
      authRequest(admin, "/api/admin/points/adjust", {
        method: "POST",
        body: JSON.stringify({ username: target.username, delta: -999 }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(over.status).toBe(400)
    expect(await getPointsBalance(env, target.id)).toBe(50)
  })

  it("总览列表包含 0 积分用户", async () => {
    const admin = await makeUser({ role: "admin" })
    const target = await makeUser()

    const res = await fetchSelf(authRequest(admin, "/api/admin/points"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { users: { username: string; balance: number }[] }
    const found = body.users.find((u) => u.username === target.username)
    expect(found).toBeDefined()
    expect(found?.balance).toBe(0)
  })

  it("总览列表带 uid / 邮箱，且按注册时间倒序", async () => {
    const admin = await makeUser({ role: "admin" })
    const first = await makeUser()
    const second = await makeUser()

    const res = await fetchSelf(authRequest(admin, "/api/admin/points"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      users: { username: string; uid: number | null; email: string }[]
    }
    const iFirst = body.users.findIndex((u) => u.username === first.username)
    const iSecond = body.users.findIndex((u) => u.username === second.username)
    expect(iFirst).toBeGreaterThanOrEqual(0)
    expect(iSecond).toBeGreaterThanOrEqual(0)
    // 后注册的排在前面（与「用户」标签的列表一致）
    expect(iSecond).toBeLessThan(iFirst)
    expect(body.users[iSecond].email).toBe(`${second.username}@doulor.cn`)
  })
})

// ---- 积分商城 ----

/** 以管理员身份建一个商品，返回商品对象 */
async function addProduct(
  admin: Awaited<ReturnType<typeof makeUser>>,
  payload: Record<string, unknown>
): Promise<{
  id: string
  name: string
  price: number
  stock: number | null
  icon: string | null
  deliveryParams: { feature?: string; planId?: number; count?: number } | null
}> {
  const res = await fetchSelf(
    authRequest(admin, "/api/admin/points/products", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    })
  )
  expect(res.status).toBe(200)
  return ((await res.json()) as { product: never }).product
}

/** 用户下单，返回原始 Response */
function buy(user: Awaited<ReturnType<typeof makeUser>>, productId: string): Promise<Response> {
  return fetchSelf(
    authRequest(user, "/api/points/shop/buy", {
      method: "POST",
      body: JSON.stringify({ productId }),
      headers: { "Content-Type": "application/json" },
    })
  )
}

describe("积分商城：商品管理", () => {
  it("建商品 → 用户端可见；下架后不可见", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    const p = await addProduct(admin, {
      name: "测试商品",
      price: 10,
      delivery: "manual",
      icon: "gift",
    })

    const list1 = (await (await fetchSelf(authRequest(user, "/api/points"))).json()) as {
      products: { id: string; icon: string | null }[]
    }
    expect(list1.products.map((x) => x.id)).toContain(p.id)
    // 图标要原样带给用户端（前端靠它选 lucide 组件）
    expect(list1.products.find((x) => x.id === p.id)?.icon).toBe("gift")

    // 下架
    const off = await fetchSelf(
      authRequest(admin, `/api/admin/points/products/${p.id}`, {
        method: "PUT",
        body: JSON.stringify({ name: "测试商品", price: 10, delivery: "manual", enabled: false }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(off.status).toBe(200)

    const list2 = (await (await fetchSelf(authRequest(user, "/api/points"))).json()) as {
      products: { id: string }[]
    }
    expect(list2.products.map((x) => x.id)).not.toContain(p.id)
  })

  it("自动充值商品必须填写每件充值金额", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await fetchSelf(
      authRequest(admin, "/api/admin/points/products", {
        method: "POST",
        body: JSON.stringify({ name: "充值卡", price: 10, delivery: "quota" }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(res.status).toBe(400)
  })

  it("售价必须是正整数，名称不能为空", async () => {
    const admin = await makeUser({ role: "admin" })
    for (const bad of [
      { name: "", price: 10, delivery: "manual" },
      { name: "x", price: 0, delivery: "manual" },
      { name: "x", price: -5, delivery: "manual" },
      { name: "x", price: 1.5, delivery: "manual" },
    ]) {
      const res = await fetchSelf(
        authRequest(admin, "/api/admin/points/products", {
          method: "POST",
          body: JSON.stringify(bad),
          headers: { "Content-Type": "application/json" },
        })
      )
      expect(res.status).toBe(400)
    }
  })

  it("图标：合法 slug 原样存、大小写与空格归一化、空值存 null", async () => {
    const admin = await makeUser({ role: "admin" })

    const a = await addProduct(admin, {
      name: "带图标",
      price: 1,
      delivery: "manual",
      icon: "credit-card",
    })
    expect(a.icon).toBe("credit-card")

    // 大小写 + 前后空格都归一化成小写 slug
    const b = await addProduct(admin, {
      name: "大写图标",
      price: 1,
      delivery: "manual",
      icon: "  GIFT  ",
    })
    expect(b.icon).toBe("gift")

    // 没传 / 空串 / null 一律存 null（前端回退默认图标）
    for (const raw of [undefined, "", "   ", null]) {
      const p = await addProduct(admin, {
        name: "无图标",
        price: 1,
        delivery: "manual",
        icon: raw,
      })
      expect(p.icon).toBeNull()
    }
  })

  it("图标：非 slug 的字符串被 400 拒绝（不落库）", async () => {
    const admin = await makeUser({ role: "admin" })
    for (const bad of ["../etc/passwd", "a b", "<script>", "gift;drop", "a".repeat(41)]) {
      const res = await fetchSelf(
        authRequest(admin, "/api/admin/points/products", {
          method: "POST",
          body: JSON.stringify({ name: "x", price: 1, delivery: "manual", icon: bad }),
          headers: { "Content-Type": "application/json" },
        })
      )
      expect(res.status).toBe(400)
    }
  })

  it("编辑商品能改图标，也能清空", async () => {
    const admin = await makeUser({ role: "admin" })
    const p = await addProduct(admin, {
      name: "改图标",
      price: 5,
      delivery: "manual",
      icon: "gift",
    })
    expect(p.icon).toBe("gift")

    const res = await fetchSelf(
      authRequest(admin, `/api/admin/points/products/${p.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: "改图标",
          price: 5,
          delivery: "manual",
          icon: "crown",
        }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { product: { icon: string | null } }
    expect(body.product.icon).toBe("crown")

    // 清空 → null
    const cleared = await fetchSelf(
      authRequest(admin, `/api/admin/points/products/${p.id}`, {
        method: "PUT",
        body: JSON.stringify({ name: "改图标", price: 5, delivery: "manual", icon: null }),
        headers: { "Content-Type": "application/json" },
      })
    )
    const clearedBody = (await cleared.json()) as { product: { icon: string | null } }
    expect(clearedBody.product.icon).toBeNull()
  })

  it("非管理员访问管理端商城接口返回 403", async () => {
    const u = await makeUser()
    const shop = await fetchSelf(authRequest(u, "/api/admin/points/shop"))
    expect(shop.status).toBe(403)
    const create = await fetchSelf(
      authRequest(u, "/api/admin/points/products", {
        method: "POST",
        body: JSON.stringify({ name: "x", price: 1, delivery: "manual" }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(create.status).toBe(403)
  })
})

describe("积分商城：下单", () => {
  it("买人工发放商品：立刻扣积分，订单待发放", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await applyPoints(env, { userId: user.id, delta: 100, reason: "admin" })
    const p = await addProduct(admin, { name: "人工发货", price: 30, delivery: "manual" })

    const res = await buy(user, p.id)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { order: { status: string }; balance: number }
    expect(body.order.status).toBe("pending")
    expect(body.balance).toBe(70)
    expect(await getPointsBalance(env, user.id)).toBe(70)
    expect(await txCount(user.id)).toBe(2) // 发放 + 购买
  })

  it("积分不足：拒绝且不建订单、不扣分", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await applyPoints(env, { userId: user.id, delta: 10, reason: "admin" })
    const p = await addProduct(admin, { name: "太贵了", price: 30, delivery: "manual" })

    const res = await buy(user, p.id)
    expect(res.status).toBe(400)
    expect(await getPointsBalance(env, user.id)).toBe(10)
    const orders = await env.DB.prepare("SELECT COUNT(*) AS c FROM point_orders WHERE user_id = ?")
      .bind(user.id)
      .first<{ c: number }>()
    expect(Number(orders?.c ?? 0)).toBe(0)
  })

  it("每人限购生效", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await applyPoints(env, { userId: user.id, delta: 100, reason: "admin" })
    const p = await addProduct(admin, {
      name: "限购一件",
      price: 10,
      delivery: "manual",
      perUserLimit: 1,
    })

    expect((await buy(user, p.id)).status).toBe(200)
    const again = await buy(user, p.id)
    expect(again.status).toBe(400)
    expect(await getPointsBalance(env, user.id)).toBe(90)
  })

  it("限量商品：卖完后拒绝购买（不扣分）", async () => {
    const admin = await makeUser({ role: "admin" })
    const a = await makeUser()
    const b = await makeUser()
    await applyPoints(env, { userId: a.id, delta: 100, reason: "admin" })
    await applyPoints(env, { userId: b.id, delta: 100, reason: "admin" })
    const p = await addProduct(admin, { name: "只剩一件", price: 10, delivery: "manual", stock: 1 })

    expect((await buy(a, p.id)).status).toBe(200)
    const soldOut = await buy(b, p.id)
    expect(soldOut.status).toBe(400)
    expect(await getPointsBalance(env, b.id)).toBe(100)
  })

  it("自动充值商品：未绑定中转站时在扣分之前拦住", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await applyPoints(env, { userId: user.id, delta: 100, reason: "admin" })
    const p = await addProduct(admin, {
      name: "自动充值",
      price: 50,
      delivery: "quota",
      quotaYuan: 10,
    })

    const res = await buy(user, p.id)
    expect(res.status).toBe(400)
    expect(await getPointsBalance(env, user.id)).toBe(100)
    expect(quotaCalls.length).toBe(0)
  })

  it("自动充值商品：下单即到账，订单直接是已发放", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await bindNewApi(user.id, 9101)
    await applyPoints(env, { userId: user.id, delta: 100, reason: "admin" })
    const p = await addProduct(admin, {
      name: "10 元充值",
      price: 50,
      delivery: "quota",
      quotaYuan: 10,
    })

    const res = await buy(user, p.id)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { order: { status: string }; balance: number }
    expect(body.order.status).toBe("delivered")
    expect(body.balance).toBe(50)
    // 10 元 * 500000 原始额度
    expect(quotaCalls).toEqual([{ userId: 9101, value: 5_000_000, mode: "add" }])
  })

  it("自动充值失败：积分退回、库存还原、订单置已取消", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await bindNewApi(user.id, 9102)
    await applyPoints(env, { userId: user.id, delta: 100, reason: "admin" })
    const p = await addProduct(admin, {
      name: "会失败的充值",
      price: 50,
      delivery: "quota",
      quotaYuan: 10,
      stock: 3,
    })

    failManage = true
    const res = await buy(user, p.id)
    expect(res.status).toBe(502)
    // 积分回到 100
    expect(await getPointsBalance(env, user.id)).toBe(100)
    // 库存还原
    const row = await env.DB.prepare("SELECT stock FROM point_products WHERE id = ?")
      .bind(p.id)
      .first<{ stock: number }>()
    expect(Number(row?.stock)).toBe(3)
    // 订单留痕为 cancelled
    const order = await env.DB.prepare(
      "SELECT status FROM point_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 1"
    )
      .bind(user.id)
      .first<{ status: string }>()
    expect(order?.status).toBe("cancelled")
  })

  it("商品不存在 / 已下架时拒绝下单", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await applyPoints(env, { userId: user.id, delta: 100, reason: "admin" })

    expect((await buy(user, "not-exist")).status).toBe(404)

    const p = await addProduct(admin, {
      name: "已下架",
      price: 10,
      delivery: "manual",
      enabled: false,
    })
    expect((await buy(user, p.id)).status).toBe(400)
  })
})

describe("积分商城：管理端订单", () => {
  it("标记已发放；重复标记报冲突", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await applyPoints(env, { userId: user.id, delta: 100, reason: "admin" })
    const p = await addProduct(admin, { name: "待发货", price: 20, delivery: "manual" })

    const bought = (await (await buy(user, p.id)).json()) as { order: { id: string } }
    const orderId = bought.order.id

    const list = (await (
      await fetchSelf(authRequest(admin, "/api/admin/points/shop?status=pending"))
    ).json()) as { orders: { id: string; status: string }[] }
    expect(list.orders.map((o) => o.id)).toContain(orderId)

    const deliver = await fetchSelf(
      authRequest(admin, `/api/admin/points/orders/${orderId}/deliver`, {
        method: "POST",
        body: JSON.stringify({ note: "已发到邮箱" }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(deliver.status).toBe(200)
    expect(((await deliver.json()) as { order: { status: string } }).order.status).toBe("delivered")

    const again = await fetchSelf(
      authRequest(admin, `/api/admin/points/orders/${orderId}/deliver`, {
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(again.status).toBe(409)
  })

  it("保存兑换配置：比例支持小数，0 / 负数被拒", async () => {
    const admin = await makeUser({ role: "admin" })

    const ok = await fetchSelf(
      authRequest(admin, "/api/admin/points/config", {
        method: "PUT",
        body: JSON.stringify({ yuanPerPoint: 0.5, dailyLimit: 3, enabled: true }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(ok.status).toBe(200)
    const cfg = ((await ok.json()) as { config: { yuanPerPoint: number; dailyLimit: number } })
      .config
    expect(cfg.yuanPerPoint).toBe(0.5)
    expect(cfg.dailyLimit).toBe(3)

    for (const bad of [0, -1, "abc"]) {
      const res = await fetchSelf(
        authRequest(admin, "/api/admin/points/config", {
          method: "PUT",
          body: JSON.stringify({ yuanPerPoint: bad }),
          headers: { "Content-Type": "application/json" },
        })
      )
      expect(res.status).toBe(400)
    }
  })
})

// ---- 新增的三种自动交付方式（权限 / 订阅 / 邀请码额度）----
//
// 这三种都是「下单即真的发出去」，错了会真给用户东西或真丢积分，
// 所以既测成功路径（发了什么、积分扣了多少），也测前置拦截（不该发的必须
// 在扣积分之前拒掉）。
describe("积分商城：权限 / 订阅 / 邀请码额度", () => {
  it("参数校验：模块名、套餐 ID、额度数量非法时拒绝建商品", async () => {
    const admin = await makeUser({ role: "admin" })
    const bad = [
      { delivery: "feature", deliveryParams: {} },
      { delivery: "feature", deliveryParams: { feature: "nope" } },
      { delivery: "feature", deliveryParams: { feature: "../../etc" } },
      { delivery: "subscription", deliveryParams: {} },
      { delivery: "subscription", deliveryParams: { planId: 0 } },
      { delivery: "subscription", deliveryParams: { planId: -3 } },
      { delivery: "subscription", deliveryParams: { planId: 1.5 } },
      { delivery: "invite_quota", deliveryParams: {} },
      { delivery: "invite_quota", deliveryParams: { count: 0 } },
      { delivery: "invite_quota", deliveryParams: { count: 99999 } },
    ]
    for (const p of bad) {
      const res = await fetchSelf(
        authRequest(admin, "/api/admin/points/products", {
          method: "POST",
          body: JSON.stringify({ name: "x", price: 10, ...p }),
          headers: { "Content-Type": "application/json" },
        })
      )
      expect(res.status, JSON.stringify(p)).toBe(400)
    }
  })

  it("参数存得进也读得出：三种方式的 deliveryParams 原样回传", async () => {
    const admin = await makeUser({ role: "admin" })

    const f = await addProduct(admin, {
      name: "买权限",
      price: 10,
      delivery: "feature",
      deliveryParams: { feature: "ai" },
    })
    expect(f.deliveryParams).toEqual({ feature: "ai" })

    const s = await addProduct(admin, {
      name: "买订阅",
      price: 10,
      delivery: "subscription",
      deliveryParams: { planId: 2 },
    })
    expect(s.deliveryParams).toEqual({ planId: 2 })

    const q = await addProduct(admin, {
      name: "买额度",
      price: 10,
      delivery: "invite_quota",
      deliveryParams: { count: 3 },
    })
    expect(q.deliveryParams).toEqual({ count: 3 })

    // 人工发放不该带参数
    const m = await addProduct(admin, { name: "人工", price: 10, delivery: "manual" })
    expect(m.deliveryParams).toBeNull()
  })

  it("授予权限：下单后该模块打开，其它模块不受影响", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    // ⚠️ permissions 为 NULL 时 parsePermissions 当「全开」，必须先显式写死
    await setPermissions(
      user.id,
      JSON.stringify({ r2: true, ai: false, frp: false, proxy: false })
    )
    await applyPoints(env, { userId: user.id, delta: 100, reason: "admin" })
    const p = await addProduct(admin, {
      name: "开通 AI 中转站",
      price: 40,
      delivery: "feature",
      deliveryParams: { feature: "ai" },
    })

    const res = await buy(user, p.id)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { order: { status: string; note: string | null } }
    expect(body.order.status).toBe("delivered")
    expect(body.order.note).toContain("AI 中转站")

    const row = await env.DB.prepare("SELECT permissions FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ permissions: string }>()
    const perms = JSON.parse(String(row?.permissions)) as Record<string, boolean>
    expect(perms.ai).toBe(true)
    // 原有权限不能被覆盖掉（grantFeatures 用的是 json_set，不是整列写回）
    expect(perms.r2).toBe(true)
    expect(perms.frp).toBe(false)
    expect(perms.proxy).toBe(false)
    expect(await getPointsBalance(env, user.id)).toBe(60)
  })

  it("授予权限：已经有该权限时拒单，不扣积分", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await setPermissions(
      user.id,
      JSON.stringify({ r2: true, ai: true, frp: false, proxy: false })
    )
    await applyPoints(env, { userId: user.id, delta: 100, reason: "admin" })
    const p = await addProduct(admin, {
      name: "开通 AI 中转站",
      price: 40,
      delivery: "feature",
      deliveryParams: { feature: "ai" },
    })

    const res = await buy(user, p.id)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code?: string }).code).toBe("ALREADY_OWNED")
    expect(await getPointsBalance(env, user.id)).toBe(100)
  })

  it("开通订阅：未绑定中转站时在扣分之前拦住", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await applyPoints(env, { userId: user.id, delta: 100, reason: "admin" })
    const p = await addProduct(admin, {
      name: "月度会员",
      price: 50,
      delivery: "subscription",
      deliveryParams: { planId: 2 },
    })

    const res = await buy(user, p.id)
    expect(res.status).toBe(400)
    expect(await getPointsBalance(env, user.id)).toBe(100)
    expect(subscriptionCalls.length).toBe(0)
  })

  it("开通订阅：下单即调用 NewAPI 开通，订单直接已发放", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await bindNewApi(user.id, 9201)
    await applyPoints(env, { userId: user.id, delta: 100, reason: "admin" })
    const p = await addProduct(admin, {
      name: "月度会员",
      price: 50,
      delivery: "subscription",
      deliveryParams: { planId: 7 },
    })

    const res = await buy(user, p.id)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { order: { status: string; note: string | null } }
    expect(body.order.status).toBe("delivered")
    expect(body.order.note).toContain("#7")
    expect(subscriptionCalls).toEqual([{ userId: 9201, planId: 7 }])
    expect(await getPointsBalance(env, user.id)).toBe(50)
  })

  it("开通订阅失败：积分退回、库存还原、订单置已取消", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await bindNewApi(user.id, 9202)
    await applyPoints(env, { userId: user.id, delta: 100, reason: "admin" })
    const p = await addProduct(admin, {
      name: "会失败的会员",
      price: 50,
      delivery: "subscription",
      deliveryParams: { planId: 2 },
      stock: 2,
    })

    failSubscription = true
    const res = await buy(user, p.id)
    expect(res.status).toBe(502)
    expect(await getPointsBalance(env, user.id)).toBe(100)

    const row = await env.DB.prepare("SELECT stock FROM point_products WHERE id = ?")
      .bind(p.id)
      .first<{ stock: number }>()
    expect(Number(row?.stock)).toBe(2)

    const order = await env.DB.prepare(
      "SELECT status FROM point_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 1"
    )
      .bind(user.id)
      .first<{ status: string }>()
    expect(order?.status).toBe("cancelled")
  })

  it("增加邀请码额度：下单后 invite_quota_bonus 增加", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await applyPoints(env, { userId: user.id, delta: 100, reason: "admin" })
    const p = await addProduct(admin, {
      name: "多建 3 个邀请码",
      price: 20,
      delivery: "invite_quota",
      deliveryParams: { count: 3 },
    })

    const res = await buy(user, p.id)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { order: { status: string; note: string | null } }
    expect(body.order.status).toBe("delivered")
    expect(body.order.note).toContain("3")

    const row = await env.DB.prepare("SELECT invite_quota_bonus FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ invite_quota_bonus: number }>()
    expect(Number(row?.invite_quota_bonus)).toBe(3)
    expect(await getPointsBalance(env, user.id)).toBe(80)
  })
})

// ---- 用户商城（用户上架自己的商品 + 担保交易）----
//
// 这一组盯的是「钱会不会错手」：
//   · 用户商品必须**审核通过**才可买（不能拿 id 直接买待审核的）
//   · 不能买自己的东西（否则可以把积分在自己账号间倒手）
//   · 担保：买家付的钱在买家确认收货前**不能**出现在卖家账上
//   · 取消订单要原路退买家，且不能退两次

/** 用户上架商品，返回商品对象 */
async function uploadProduct(
  user: Awaited<ReturnType<typeof makeUser>>,
  payload: Record<string, unknown>
): Promise<{
  id: string
  delivery: string
  reviewStatus: string
  ownerId: string | null
  ownerName: string | null
  perUserLimit: number | null
  sort: number
}> {
  const res = await fetchSelf(
    authRequest(user, "/api/points/products", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    })
  )
  expect(res.status).toBe(200)
  return ((await res.json()) as { product: never }).product
}

/** 管理员审核 */
function review(
  admin: Awaited<ReturnType<typeof makeUser>>,
  id: string,
  approve: boolean,
  note?: string
): Promise<Response> {
  return fetchSelf(
    authRequest(admin, `/api/admin/points/products/${id}/review`, {
      method: "POST",
      body: JSON.stringify({ approve, note }),
      headers: { "Content-Type": "application/json" },
    })
  )
}

/** 读用户端整页数据（官方商品 / 用户商品 / 我的商品 / 我收到的订单） */
async function overview(user: Awaited<ReturnType<typeof makeUser>>): Promise<{
  products: { id: string }[]
  userProducts: { id: string }[]
  myProducts: { id: string; reviewStatus: string }[]
  orders: { id: string; status: string; sellerId: string | null }[]
  sellerOrders: { id: string; status: string }[]
}> {
  const res = await fetchSelf(authRequest(user, "/api/points"))
  expect(res.status).toBe(200)
  return (await res.json()) as never
}

describe("用户商城：上架与审核", () => {
  it("用户上架 → 待审核、别人看不到；管理员通过后才出现", async () => {
    const admin = await makeUser({ role: "admin" })
    const seller = await makeUser()
    const buyer = await makeUser()

    const p = await uploadProduct(seller, { name: "二手键盘", price: 50 })
    expect(p.reviewStatus).toBe("pending")
    expect(p.ownerId).toBe(seller.id)
    expect(p.ownerName).toBe(seller.username)

    // 卖家自己看得到（要能看到审核进度），别人看不到
    const mine = await overview(seller)
    expect(mine.myProducts.map((x) => x.id)).toContain(p.id)
    const other = await overview(buyer)
    expect(other.userProducts.map((x) => x.id)).not.toContain(p.id)
    // 也不能混进「官方商品」那一栏
    expect(other.products.map((x) => x.id)).not.toContain(p.id)

    expect((await review(admin, p.id, true)).status).toBe(200)
    const after = await overview(buyer)
    expect(after.userProducts.map((x) => x.id)).toContain(p.id)
  })

  it("用户商品强制人工交付：传 delivery=quota 也会被忽略", async () => {
    const seller = await makeUser()
    const p = await uploadProduct(seller, {
      name: "假装能自动充值",
      price: 10,
      delivery: "quota",
      quotaYuan: 100,
      perUserLimit: 3,
      sort: 999,
    })
    expect(p.delivery).toBe("manual")
    expect(p.perUserLimit).toBeNull()
    expect(p.sort).toBe(0)
  })

  it("拒绝后带理由，用户可以改完重新提交（重新回到待审核）", async () => {
    const admin = await makeUser({ role: "admin" })
    const seller = await makeUser()
    const p = await uploadProduct(seller, { name: "违规商品", price: 10 })

    await review(admin, p.id, false, "站内不允许交易这类东西")
    const rejected = await overview(seller)
    expect(rejected.myProducts.find((x) => x.id === p.id)?.reviewStatus).toBe("rejected")

    // 改内容 → 回到待审核
    const upd = await fetchSelf(
      authRequest(seller, `/api/points/products/${p.id}`, {
        method: "PUT",
        body: JSON.stringify({ name: "换个说法", price: 10 }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(upd.status).toBe(200)
    const again = await overview(seller)
    expect(again.myProducts.find((x) => x.id === p.id)?.reviewStatus).toBe("pending")
  })

  it("不能改 / 删别人的商品", async () => {
    const seller = await makeUser()
    const other = await makeUser()
    const p = await uploadProduct(seller, { name: "我的东西", price: 10 })

    const upd = await fetchSelf(
      authRequest(other, `/api/points/products/${p.id}`, {
        method: "PUT",
        body: JSON.stringify({ name: "改成我的", price: 10 }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(upd.status).toBe(403)

    const del = await fetchSelf(
      authRequest(other, `/api/points/products/${p.id}`, { method: "DELETE" })
    )
    expect(del.status).toBe(403)
  })

  it("上架数量有上限（防刷屏）", async () => {
    const seller = await makeUser()
    const now = new Date().toISOString()
    // 直接塞满 20 条，避免用例里发 20 次请求
    for (let i = 0; i < 20; i++) {
      await env.DB.prepare(
        `INSERT INTO point_products
           (id, name, description, price, delivery, enabled, sort,
            owner_id, owner_name, review_status, created_at, updated_at)
         VALUES (?, ?, '', 10, 'manual', 1, 0, ?, ?, 'approved', ?, ?)`
      )
        .bind(`bulk_${i}`, `批量商品 ${i}`, seller.id, seller.username, now, now)
        .run()
    }
    const res = await fetchSelf(
      authRequest(seller, "/api/points/products", {
        method: "POST",
        body: JSON.stringify({ name: "第 21 件", price: 10 }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe("TOO_MANY_PRODUCTS")
  })
})

describe("用户商城：担保交易", () => {
  /** 造一件「卖家已上架、审核已通过」的商品 */
  async function listedProduct(
    admin: Awaited<ReturnType<typeof makeUser>>,
    seller: Awaited<ReturnType<typeof makeUser>>,
    price: number,
    stock?: number
  ): Promise<string> {
    const p = await uploadProduct(seller, { name: "担保商品", price, stock })
    expect((await review(admin, p.id, true)).status).toBe(200)
    return p.id
  }

  it("不能买自己上架的商品（不扣分）", async () => {
    const admin = await makeUser({ role: "admin" })
    const seller = await makeUser()
    await applyPoints(env, { userId: seller.id, delta: 100, reason: "admin" })
    const id = await listedProduct(admin, seller, 30)

    const res = await buy(seller, id)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe("SELF_PURCHASE")
    expect(await getPointsBalance(env, seller.id)).toBe(100)
  })

  it("待审核的商品不能直接买（接口不能信前端）", async () => {
    const seller = await makeUser()
    const buyer = await makeUser()
    await applyPoints(env, { userId: buyer.id, delta: 100, reason: "admin" })
    const p = await uploadProduct(seller, { name: "还没过审", price: 30 })

    const res = await buy(buyer, p.id)
    expect(res.status).toBe(400)
    expect(await getPointsBalance(env, buyer.id)).toBe(100)
  })

  it("担保全流程：买家扣分 → 卖家交付 → 买家确认后才给卖家结算", async () => {
    const admin = await makeUser({ role: "admin" })
    const seller = await makeUser()
    const buyer = await makeUser()
    await applyPoints(env, { userId: buyer.id, delta: 100, reason: "admin" })
    const id = await listedProduct(admin, seller, 30)

    // 1) 买家下单：钱从买家账上扣走，但**不进卖家账**
    const buyRes = await buy(buyer, id)
    expect(buyRes.status).toBe(200)
    const order = ((await buyRes.json()) as { order: { id: string; status: string } }).order
    expect(order.status).toBe("pending")
    expect(await getPointsBalance(env, buyer.id)).toBe(70)
    expect(await getPointsBalance(env, seller.id)).toBe(0)

    // 2) 卖家标记已交付 —— 钱还在托管
    const deliver = await fetchSelf(
      authRequest(seller, `/api/points/orders/${order.id}/deliver`, { method: "POST" })
    )
    expect(deliver.status).toBe(200)
    expect(await getPointsBalance(env, seller.id)).toBe(0)

    // 3) 买家确认收货 —— 这时才结算给卖家
    const confirm = await fetchSelf(
      authRequest(buyer, `/api/points/orders/${order.id}/confirm`, { method: "POST" })
    )
    expect(confirm.status).toBe(200)
    expect(await getPointsBalance(env, seller.id)).toBe(30)

    // 流水记的是 shop_sell（不是平台发放）
    const tx = await env.DB.prepare(
      "SELECT reason FROM point_transactions WHERE user_id = ? ORDER BY created_at DESC"
    )
      .bind(seller.id)
      .first<{ reason: string }>()
    expect(tx?.reason).toBe("shop_sell")

    // 4) 重复确认：幂等，不能给两次钱
    const again = await fetchSelf(
      authRequest(buyer, `/api/points/orders/${order.id}/confirm`, { method: "POST" })
    )
    expect(again.status).toBe(409)
    expect(await getPointsBalance(env, seller.id)).toBe(30)
  })

  /**
   * 读某人收到的站内消息。
   * 按类型取用而不是靠顺序断言 —— 同一毫秒可能写入多条，排序不稳定。
   */
  async function messagesOf(userId: string) {
    const rows = await env.DB.prepare(
      "SELECT category, type, title, body, link, payload, dedup_key FROM notifications WHERE user_id = ?"
    )
      .bind(userId)
      .all<{
        category: string
        type: string
        title: string | null
        body: string | null
        link: string | null
        payload: string | null
        dedup_key: string | null
      }>()
    return rows.results ?? []
  }

  it("担保全流程会给双方写系统消息，并带上「发货 / 确认收货」动作", async () => {
    const admin = await makeUser({ role: "admin" })
    const seller = await makeUser()
    const buyer = await makeUser()
    await applyPoints(env, { userId: buyer.id, delta: 100, reason: "admin" })
    const id = await listedProduct(admin, seller, 30)

    // 1) 买家下单 → 卖家收到「有人买下」，带 deliver 动作
    const buyRes = await buy(buyer, id)
    const order = ((await buyRes.json()) as { order: { id: string } }).order

    const paid = (await messagesOf(seller.id)).find((m) => m.type === "order_paid")
    expect(paid).toBeTruthy()
    expect(paid!.category).toBe("system")
    expect(JSON.parse(paid!.payload ?? "{}")).toMatchObject({
      kind: "order",
      orderId: order.id,
      action: "deliver",
      peer: buyer.username,
    })

    // 买家也有一条「已买下」，但不带动作（他要等卖家先交付），对端是卖家
    const placed = (await messagesOf(buyer.id)).find((m) => m.type === "order_placed")
    expect(placed).toBeTruthy()
    expect(JSON.parse(placed!.payload ?? "{}").action).toBeNull()
    expect(JSON.parse(placed!.payload ?? "{}").peer).toBe(seller.username)

    // 2) 卖家交付 → 买家收到带 confirm 动作的消息
    const deliver = await fetchSelf(
      authRequest(seller, `/api/points/orders/${order.id}/deliver`, { method: "POST" })
    )
    expect(deliver.status).toBe(200)
    const shipped = (await messagesOf(buyer.id)).find((m) => m.type === "order_shipped")
    expect(shipped).toBeTruthy()
    expect(JSON.parse(shipped!.payload ?? "{}").action).toBe("confirm")
    expect(JSON.parse(shipped!.payload ?? "{}").peer).toBe(seller.username)

    // 3) 买家确认收货 → 卖家收到「积分到账」
    const confirm = await fetchSelf(
      authRequest(buyer, `/api/points/orders/${order.id}/confirm`, { method: "POST" })
    )
    expect(confirm.status).toBe(200)
    const settled = (await messagesOf(seller.id)).find((m) => m.type === "order_settled")
    expect(settled).toBeTruthy()
    expect(settled!.title).toContain("到账")
    expect(JSON.parse(settled!.payload ?? "{}").peer).toBe(buyer.username)
  })

  it("商品审核结果会通知卖家（通过 / 驳回各一条）", async () => {
    const admin = await makeUser({ role: "admin" })
    const seller = await makeUser()

    const p1 = await uploadProduct(seller, { name: "会被通过的", price: 10 })
    await review(admin, p1.id, true)
    const approved = (await messagesOf(seller.id)).find((m) => m.type === "product_approved")
    expect(approved).toBeTruthy()

    const p2 = await uploadProduct(seller, { name: "会被驳回的", price: 10 })
    await review(admin, p2.id, false, "图片不合规")
    const rejected = (await messagesOf(seller.id)).find((m) => m.type === "product_rejected")
    expect(rejected).toBeTruthy()
    expect(rejected!.body).toContain("图片不合规")
  })

  it("卖家没交付前不能结算", async () => {
    const admin = await makeUser({ role: "admin" })
    const seller = await makeUser()
    const buyer = await makeUser()
    await applyPoints(env, { userId: buyer.id, delta: 100, reason: "admin" })
    const id = await listedProduct(admin, seller, 30)

    const buyRes = await buy(buyer, id)
    const order = ((await buyRes.json()) as { order: { id: string } }).order

    const confirm = await fetchSelf(
      authRequest(buyer, `/api/points/orders/${order.id}/confirm`, { method: "POST" })
    )
    expect(confirm.status).toBe(409)
    expect(((await confirm.json()) as { code: string }).code).toBe("NOT_DELIVERED")
    expect(await getPointsBalance(env, seller.id)).toBe(0)
  })

  it("卖家只能交付自己的单、买家只能确认自己的单", async () => {
    const admin = await makeUser({ role: "admin" })
    const seller = await makeUser()
    const buyer = await makeUser()
    const stranger = await makeUser()
    await applyPoints(env, { userId: buyer.id, delta: 100, reason: "admin" })
    const id = await listedProduct(admin, seller, 30)

    const buyRes = await buy(buyer, id)
    const order = ((await buyRes.json()) as { order: { id: string } }).order

    const badDeliver = await fetchSelf(
      authRequest(stranger, `/api/points/orders/${order.id}/deliver`, { method: "POST" })
    )
    expect(badDeliver.status).toBe(403)

    const badConfirm = await fetchSelf(
      authRequest(stranger, `/api/points/orders/${order.id}/confirm`, { method: "POST" })
    )
    expect(badConfirm.status).toBe(403)
    expect(await getPointsBalance(env, seller.id)).toBe(0)
  })

  it("管理员取消订单：原路退买家、库存还回去、卖家一分没拿到", async () => {
    const admin = await makeUser({ role: "admin" })
    const seller = await makeUser()
    const buyer = await makeUser()
    await applyPoints(env, { userId: buyer.id, delta: 100, reason: "admin" })
    const id = await listedProduct(admin, seller, 30, 2)

    const buyRes = await buy(buyer, id)
    const order = ((await buyRes.json()) as { order: { id: string } }).order
    expect(await getPointsBalance(env, buyer.id)).toBe(70)

    const cancel = await fetchSelf(
      authRequest(admin, `/api/admin/points/orders/${order.id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason: "卖家一直没发货" }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(cancel.status).toBe(200)
    expect(await getPointsBalance(env, buyer.id)).toBe(100)
    expect(await getPointsBalance(env, seller.id)).toBe(0)

    const stock = await env.DB.prepare("SELECT stock FROM point_products WHERE id = ?")
      .bind(id)
      .first<{ stock: number }>()
    expect(Number(stock?.stock)).toBe(2)

    // 再取消一次：幂等，不能退两次钱
    const again = await fetchSelf(
      authRequest(admin, `/api/admin/points/orders/${order.id}/cancel`, { method: "POST" })
    )
    expect(again.status).toBe(409)
    expect(await getPointsBalance(env, buyer.id)).toBe(100)
  })

  it("已结算的订单要撤销：先从卖家账上收回，卖家不够则拒绝", async () => {
    const admin = await makeUser({ role: "admin" })
    const seller = await makeUser()
    const buyer = await makeUser()
    await applyPoints(env, { userId: buyer.id, delta: 100, reason: "admin" })
    const id = await listedProduct(admin, seller, 30)

    const buyRes = await buy(buyer, id)
    const order = ((await buyRes.json()) as { order: { id: string } }).order
    await fetchSelf(authRequest(seller, `/api/points/orders/${order.id}/deliver`, { method: "POST" }))
    await fetchSelf(authRequest(buyer, `/api/points/orders/${order.id}/confirm`, { method: "POST" }))
    expect(await getPointsBalance(env, seller.id)).toBe(30)

    // 卖家把钱花光了 → 收不回来，拒绝取消
    await applyPoints(env, { userId: seller.id, delta: -30, reason: "redeem" })
    const blocked = await fetchSelf(
      authRequest(admin, `/api/admin/points/orders/${order.id}/cancel`, { method: "POST" })
    )
    expect(blocked.status).toBe(400)
    expect(((await blocked.json()) as { code: string }).code).toBe(
      "INSUFFICIENT_POINTS"
    )
    expect(await getPointsBalance(env, buyer.id)).toBe(70)

    // 卖家把钱补回来 → 取消成功，买家拿回积分
    await applyPoints(env, { userId: seller.id, delta: 30, reason: "admin" })
    const ok = await fetchSelf(
      authRequest(admin, `/api/admin/points/orders/${order.id}/cancel`, { method: "POST" })
    )
    expect(ok.status).toBe(200)
    expect(await getPointsBalance(env, seller.id)).toBe(0)
    expect(await getPointsBalance(env, buyer.id)).toBe(100)
  })

  it("管理员不能用「标记发放」处理用户商品订单", async () => {
    const admin = await makeUser({ role: "admin" })
    const seller = await makeUser()
    const buyer = await makeUser()
    await applyPoints(env, { userId: buyer.id, delta: 100, reason: "admin" })
    const id = await listedProduct(admin, seller, 30)

    const buyRes = await buy(buyer, id)
    const order = ((await buyRes.json()) as { order: { id: string } }).order

    const res = await fetchSelf(
      authRequest(admin, `/api/admin/points/orders/${order.id}/deliver`, { method: "POST" })
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe("NOT_OFFICIAL_ORDER")
  })

  it("管理员不能直接编辑用户商品（要走审核）", async () => {
    const admin = await makeUser({ role: "admin" })
    const seller = await makeUser()
    const p = await uploadProduct(seller, { name: "用户商品", price: 10 })

    const res = await fetchSelf(
      authRequest(admin, `/api/admin/points/products/${p.id}`, {
        method: "PUT",
        body: JSON.stringify({ name: "被管理员改了", price: 1, delivery: "manual" }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe(
      "NOT_OFFICIAL_PRODUCT"
    )
  })

  it("还有没交付完的订单时不能删商品", async () => {
    const admin = await makeUser({ role: "admin" })
    const seller = await makeUser()
    const buyer = await makeUser()
    await applyPoints(env, { userId: buyer.id, delta: 100, reason: "admin" })
    const id = await listedProduct(admin, seller, 30)

    await buy(buyer, id)
    const res = await fetchSelf(
      authRequest(seller, `/api/points/products/${id}`, { method: "DELETE" })
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe(
      "ORDER_IN_PROGRESS"
    )
  })

  it("卖家收益不计进「累计发放」，但计入「用户商城成交额」", async () => {
    const admin = await makeUser({ role: "admin" })
    const seller = await makeUser()
    const buyer = await makeUser()

    // ⚠️ 全站统计是跨用例累加的（同一个文件共享 D1），只能比**增量**
    const readStats = async (): Promise<{ issued: number; traded: number; redeemed: number }> => {
      const res = await fetchSelf(authRequest(admin, "/api/admin/points"))
      return ((await res.json()) as { stats: never }).stats
    }
    const before = await readStats()

    await applyPoints(env, { userId: buyer.id, delta: 100, reason: "admin" })
    const id = await listedProduct(admin, seller, 30)

    const buyRes = await buy(buyer, id)
    const order = ((await buyRes.json()) as { order: { id: string } }).order
    await fetchSelf(authRequest(seller, `/api/points/orders/${order.id}/deliver`, { method: "POST" }))
    await fetchSelf(authRequest(buyer, `/api/points/orders/${order.id}/confirm`, { method: "POST" }))

    const after = await readStats()
    // 平台只多发放了 100（买家那笔）；卖家拿到的 30 是用户间转移，不算增发
    expect(after.issued - before.issued).toBe(100)
    expect(after.traded - before.traded).toBe(30)
    // 买家付的 30 计入消耗
    expect(after.redeemed - before.redeemed).toBe(30)
  })
})

// ---- 积分商城：租用（定期 / 到期收回）----
//
// 租用最容易出错的三件事（错了会真送钱 / 真丢权限）：
//   1. 租期起算点：必须从**交付生效**起算，不是下单 —— 否则卖家拖几天发货白吃买家租期
//   2. 续费顺延：未到期再买要从原到期时间往后加，不能从「现在」重算（白丢剩余天数）
//   3. 到期收回：只收本单给的那个权限，且**用户还有别的未到期租用给同一权限时不能收**
//      （否则「续费单还在、旧单先到期」会把权限收掉 = 白续）；重复跑不能重复收回

/** 读用户的 permissions 原始 JSON */
async function readPerms(userId: string): Promise<Record<string, boolean>> {
  const row = await env.DB.prepare("SELECT permissions FROM users WHERE id = ?")
    .bind(userId)
    .first<{ permissions: string | null }>()
  return JSON.parse(String(row?.permissions ?? "{}")) as Record<string, boolean>
}

/** 天数差的绝对值（断言租期用，容忍几秒的用例执行时间） */
function daysBetween(aIso: string, bIso: string): number {
  return Math.abs(Date.parse(aIso) - Date.parse(bIso)) / 86_400_000
}

/** 读一张订单的原始行 */
async function orderRow(id: string): Promise<Record<string, unknown> | null> {
  return env.DB.prepare("SELECT * FROM point_orders WHERE id = ?").bind(id).first()
}

describe("积分商城：租用", () => {
  it("参数校验：租用必须填天数，且 quota / invite_quota 不能设为租用", async () => {
    const admin = await makeUser({ role: "admin" })
    const bad = [
      // 租用但没填天数 / 天数为 0 / 负数 / 非整数
      { billingMode: "rental", delivery: "manual" },
      { billingMode: "rental", delivery: "manual", rentalDays: 0 },
      { billingMode: "rental", delivery: "manual", rentalDays: -7 },
      { billingMode: "rental", delivery: "manual", rentalDays: 1.5 },
      // 一次性消耗品不能租
      { billingMode: "rental", delivery: "quota", quotaYuan: 10, rentalDays: 30 },
      {
        billingMode: "rental",
        delivery: "invite_quota",
        deliveryParams: { count: 1 },
        rentalDays: 30,
      },
    ]
    for (const p of bad) {
      const res = await fetchSelf(
        authRequest(admin, "/api/admin/points/products", {
          method: "POST",
          body: JSON.stringify({ name: "x", price: 10, ...p }),
          headers: { "Content-Type": "application/json" },
        })
      )
      expect(res.status, JSON.stringify(p)).toBe(400)
    }

    // 合法：租用 + feature
    const ok = await addProduct(admin, {
      name: "租 AI 权限",
      price: 10,
      delivery: "feature",
      deliveryParams: { feature: "ai" },
      billingMode: "rental",
      rentalDays: 30,
    })
    expect(ok).toBeTruthy()
  })

  it("买断商品：订单不写 expires_at，billingMode 记 one_time", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await applyPoints(env, { userId: user.id, delta: 100, reason: "admin" })
    const p = await addProduct(admin, { name: "买断人工", price: 20, delivery: "manual" })

    const res = await buy(user, p.id)
    expect(res.status).toBe(200)
    const order = ((await res.json()) as { order: { id: string } }).order
    const row = await orderRow(order.id)
    expect(row?.billing_mode).toBe("one_time")
    expect(row?.rental_days).toBeNull()
    expect(row?.expires_at).toBeNull()
  })

  it("租用 + feature：下单即交付，租期从交付那一刻起算", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await setPermissions(
      user.id,
      JSON.stringify({ r2: false, ai: false, frp: false, proxy: false })
    )
    await applyPoints(env, { userId: user.id, delta: 100, reason: "admin" })
    const p = await addProduct(admin, {
      name: "租 AI 权限",
      price: 40,
      delivery: "feature",
      deliveryParams: { feature: "ai" },
      billingMode: "rental",
      rentalDays: 30,
    })

    const res = await buy(user, p.id)
    expect(res.status).toBe(200)
    const order = ((await res.json()) as { order: { id: string; status: string } }).order
    expect(order.status).toBe("delivered")

    const row = await orderRow(order.id)
    expect(row?.billing_mode).toBe("rental")
    expect(Number(row?.rental_days)).toBe(30)
    // 到期时间 ≈ 现在 + 30 天（容忍用例执行的几秒）
    expect(daysBetween(String(row?.expires_at), new Date(Date.now() + 30 * 86_400_000).toISOString())).toBeLessThan(0.01)
    // 权限已开通
    expect((await readPerms(user.id)).ai).toBe(true)
    expect(await getPointsBalance(env, user.id)).toBe(60)
  })

  it("续费顺延：未到期再买一次，从原到期时间往后加，不白丢剩余天数", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await setPermissions(
      user.id,
      JSON.stringify({ r2: false, ai: false, frp: false, proxy: false })
    )
    await applyPoints(env, { userId: user.id, delta: 200, reason: "admin" })
    const p = await addProduct(admin, {
      name: "租 AI 权限",
      price: 40,
      delivery: "feature",
      deliveryParams: { feature: "ai" },
      billingMode: "rental",
      rentalDays: 30,
    })

    const first = ((await (await buy(user, p.id)).json()) as { order: { id: string } }).order
    const firstRow = await orderRow(first.id)
    const firstExpiry = String(firstRow?.expires_at)

    // 第二次买：此时用户已经有 ai 权限，但那是**本商品的有效租用**给的 ⇒ 属于续费，不能拦
    const res2 = await buy(user, p.id)
    expect(res2.status).toBe(200)
    const second = ((await res2.json()) as { order: { id: string } }).order
    const secondRow = await orderRow(second.id)
    const secondExpiry = String(secondRow?.expires_at)

    // 第二次到期 = 第一次到期 + 30 天（而不是 now + 30）
    expect(daysBetween(secondExpiry, new Date(Date.parse(firstExpiry) + 30 * 86_400_000).toISOString())).toBeLessThan(0.01)
    // renewed_from 指向第一单
    expect(secondRow?.renewed_from).toBe(first.id)
    // 两次共扣 80
    expect(await getPointsBalance(env, user.id)).toBe(120)
  })

  it("到期收回 feature 权限；重复跑不重复收回（幂等）", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await setPermissions(
      user.id,
      JSON.stringify({ r2: true, ai: false, frp: false, proxy: false })
    )
    await applyPoints(env, { userId: user.id, delta: 100, reason: "admin" })
    const p = await addProduct(admin, {
      name: "租 AI 权限",
      price: 40,
      delivery: "feature",
      deliveryParams: { feature: "ai" },
      billingMode: "rental",
      rentalDays: 30,
    })
    const order = ((await (await buy(user, p.id)).json()) as { order: { id: string } }).order
    expect((await readPerms(user.id)).ai).toBe(true)

    // 把到期时间拨到过去，模拟「已经到期」
    const past = new Date(Date.now() - 3600_000).toISOString()
    await env.DB.prepare("UPDATE point_orders SET expires_at = ? WHERE id = ?")
      .bind(past, order.id)
      .run()

    const r1 = await expireRentalOrders(env)
    expect(r1.checked).toBeGreaterThanOrEqual(1)
    expect(r1.permissionsRevoked).toBeGreaterThanOrEqual(1)
    const perms = await readPerms(user.id)
    expect(perms.ai).toBe(false)
    // 别的权限不能被牵连
    expect(perms.r2).toBe(true)

    // 再跑一次：已处理过，扫不到
    const r2 = await expireRentalOrders(env)
    expect(r2.checked).toBe(0)
    expect(r2.handled).toBe(0)
  })

  it("有别的未到期租用也在给同一权限时，到期单不收回权限", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await setPermissions(
      user.id,
      JSON.stringify({ r2: false, ai: false, frp: false, proxy: false })
    )
    await applyPoints(env, { userId: user.id, delta: 200, reason: "admin" })
    const p = await addProduct(admin, {
      name: "租 AI 权限",
      price: 40,
      delivery: "feature",
      deliveryParams: { feature: "ai" },
      billingMode: "rental",
      rentalDays: 30,
    })

    const first = ((await (await buy(user, p.id)).json()) as { order: { id: string } }).order
    const second = ((await (await buy(user, p.id)).json()) as { order: { id: string } }).order

    // 只把第一单拨到过去，第二单（续费）仍有效
    const past = new Date(Date.now() - 3600_000).toISOString()
    await env.DB.prepare("UPDATE point_orders SET expires_at = ? WHERE id = ?")
      .bind(past, first.id)
      .run()

    const r = await expireRentalOrders(env)
    expect(r.keptWithOtherSource).toBeGreaterThanOrEqual(1)
    // 权限保留（续费单还在）
    expect((await readPerms(user.id)).ai).toBe(true)
    // 但第一单已打上幂等标记
    const firstRow = await orderRow(first.id)
    expect(firstRow?.expire_handled_at).toBeTruthy()
    // 第二单不受影响
    const secondRow = await orderRow(second.id)
    expect(secondRow?.expire_handled_at).toBeNull()
  })

  it("租用到期归还库存（stock 是「同时最多能租出几份」）", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await applyPoints(env, { userId: user.id, delta: 100, reason: "admin" })
    const p = await addProduct(admin, {
      name: "租人工服务",
      price: 20,
      delivery: "manual",
      stock: 1,
      billingMode: "rental",
      rentalDays: 7,
    })

    // 下单占用 1 份 → 库存 0
    const order = ((await (await buy(user, p.id)).json()) as { order: { id: string } }).order
    const afterBuy = await env.DB.prepare("SELECT stock FROM point_products WHERE id = ?")
      .bind(p.id)
      .first<{ stock: number }>()
    expect(Number(afterBuy?.stock)).toBe(0)

    // 人工发放 → 租期起算
    const admin2 = admin
    const dres = await fetchSelf(
      authRequest(admin2, `/api/admin/points/orders/${order.id}/deliver`, {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(dres.status).toBe(200)
    const delivered = await orderRow(order.id)
    expect(delivered?.expires_at).toBeTruthy()
    // 天数对得上（7 天）
    expect(daysBetween(String(delivered?.expires_at), new Date(Date.now() + 7 * 86_400_000).toISOString())).toBeLessThan(0.01)

    // 到期 → 库存还回来
    await env.DB.prepare("UPDATE point_orders SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 3600_000).toISOString(), order.id)
      .run()
    const r = await expireRentalOrders(env)
    expect(r.stockReturned).toBeGreaterThanOrEqual(1)
    const afterExpire = await env.DB.prepare("SELECT stock FROM point_products WHERE id = ?")
      .bind(p.id)
      .first<{ stock: number }>()
    expect(Number(afterExpire?.stock)).toBe(1)
  })

  it("用户商品租用：租期在「买家确认收货」后才起算，不是下单时", async () => {
    const admin = await makeUser({ role: "admin" })
    const seller = await makeUser()
    const buyer = await makeUser()
    await applyPoints(env, { userId: buyer.id, delta: 100, reason: "admin" })

    const p = await uploadProduct(seller, {
      name: "出租我的 vps",
      price: 30,
      billingMode: "rental",
      rentalDays: 30,
    })
    expect((await review(admin, p.id, true)).status).toBe(200)

    const order = ((await (await buy(buyer, p.id)).json()) as { order: { id: string } }).order
    // 还没交付：不该有到期时间（否则卖家拖着不发，买家租期白白流逝）
    expect((await orderRow(order.id))?.expires_at).toBeNull()

    // 卖家交付 → 仍未起算（要等买家确认收货）
    await fetchSelf(authRequest(seller, `/api/points/orders/${order.id}/deliver`, { method: "POST" }))
    expect((await orderRow(order.id))?.expires_at).toBeNull()

    // 买家确认收货 → 结算 + 租期起算
    await fetchSelf(authRequest(buyer, `/api/points/orders/${order.id}/confirm`, { method: "POST" }))
    const settled = await orderRow(order.id)
    expect(settled?.status).toBe("settled")
    expect(settled?.expires_at).toBeTruthy()
    expect(daysBetween(String(settled?.expires_at), new Date(Date.now() + 30 * 86_400_000).toISOString())).toBeLessThan(0.01)
  })

  it("管理员取消租用订单：当场收回已发的权限（不然用户白拿）", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await setPermissions(
      user.id,
      JSON.stringify({ r2: false, ai: false, frp: false, proxy: false })
    )
    await applyPoints(env, { userId: user.id, delta: 100, reason: "admin" })
    const p = await addProduct(admin, {
      name: "租 AI 权限",
      price: 40,
      delivery: "feature",
      deliveryParams: { feature: "ai" },
      billingMode: "rental",
      rentalDays: 30,
    })

    const order = ((await (await buy(user, p.id)).json()) as { order: { id: string } }).order
    expect((await readPerms(user.id)).ai).toBe(true)

    const res = await fetchSelf(
      authRequest(admin, `/api/admin/points/orders/${order.id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason: "测试取消" }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(res.status).toBe(200)
    // 积分退回 + 权限收回
    expect(await getPointsBalance(env, user.id)).toBe(100)
    expect((await readPerms(user.id)).ai).toBe(false)
  })

  it("expireRentalOrders dryRun 只观察不写库", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await setPermissions(
      user.id,
      JSON.stringify({ r2: false, ai: false, frp: false, proxy: false })
    )
    await applyPoints(env, { userId: user.id, delta: 100, reason: "admin" })
    const p = await addProduct(admin, {
      name: "租 AI 权限",
      price: 40,
      delivery: "feature",
      deliveryParams: { feature: "ai" },
      billingMode: "rental",
      rentalDays: 30,
    })
    const order = ((await (await buy(user, p.id)).json()) as { order: { id: string } }).order
    await env.DB.prepare("UPDATE point_orders SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 3600_000).toISOString(), order.id)
      .run()

    const r = await expireRentalOrders(env, { dryRun: true })
    expect(r.checked).toBeGreaterThanOrEqual(1)
    expect(r.handled).toBe(0)
    // 权限没动、幂等标记没写
    expect((await readPerms(user.id)).ai).toBe(true)
    expect((await orderRow(order.id))?.expire_handled_at).toBeNull()
  })
})
