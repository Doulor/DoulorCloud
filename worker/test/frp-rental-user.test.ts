// 内网穿透「租用化」用户端（2026-10-13）。
//
// 这一层直接动用户的积分，所以测试的重点全是**钱不能出错**：
//   · 积分不足必须整笔拒绝 —— 不能扣一半、更不能扣成负数
//   · 落库失败要退分 —— 用户付了分却没有租约是不可接受的
//   · 重复提交（同 requestId）只能扣一次
//   · 只能续自己的租约 —— 拿着别人的 id 既不能续、也不能花掉自己的分
//   · 生成的 frpc 配置必须与「人工申请」那条路径同形，否则用户照旧教程改会踩坑
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { uuid } from "../src/crypto"
import { applyPoints } from "../src/points"
import { authRequest, fetchSelf, makeUser, type TestUser } from "./helpers"

const DAY_MS = 86_400_000
const NODE_ADDR = "frp.test"
const NODE_AUTH = "shared-secret"

async function seedNode(): Promise<string> {
  const id = `n_${uuid().slice(0, 8)}`
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO frp_nodes
       (id, name, server_addr, server_port, auth_token, token_prefix,
        port_min, port_max, max_ports, enabled, sort_order, auth_mode, created_at, updated_at)
     VALUES (?, '租用测试节点', ?, 7000, ?, '', 31000, 31999, 5, 1, 0, 'token_user', ?, ?)`
  )
    .bind(id, NODE_ADDR, NODE_AUTH, now, now)
    .run()

  // agent 心跳（2026-10-21）：购买/续期按 `last_seen_at` 判活 ——
  // 失联节点一律不卖、不续期、不自动扣费（hk159 事故后加的护栏）。
  // 真节点每 20 秒上报一次，测试里也必须造出这条，否则节点会被判成死的。
  await env.DB.prepare(
    `INSERT INTO frp_agent_state (node_id, last_seen_at, revision, report_count)
     VALUES (?, ?, 'test', 1)
     ON CONFLICT(node_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`
  )
    .bind(id, new Date().toISOString())
    .run()
  return id
}

async function seedPlan(
  nodeId: string,
  over: Partial<{ name: string; days: number; pricePoints: number; maxPorts: number; enabled: number }> = {}
): Promise<string> {
  const id = `plan_${uuid().slice(0, 8)}`
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO frp_plans
       (id, node_id, name, days, price_points, max_ports, allow_ranges, sort_order, enabled, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?)`
  )
    .bind(
      id,
      nodeId,
      over.name ?? "30 天标准",
      over.days ?? 30,
      over.pricePoints ?? 100,
      over.maxPorts ?? 1,
      JSON.stringify([[31000, 31999]]),
      over.enabled ?? 1,
      now,
      now
    )
    .run()
  return id
}

async function grant(userId: string, amount: number): Promise<void> {
  const res = await applyPoints(env, {
    userId,
    delta: amount,
    reason: "admin",
    detail: "测试发放",
  })
  expect(res.applied).toBe(true)
}

async function balanceOf(userId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT balance FROM user_points WHERE user_id = ?`)
    .bind(userId)
    .first<{ balance: number }>()
  return row?.balance ?? 0
}

async function call<T>(
  user: TestUser,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: T }> {
  const res = await fetchSelf(authRequest(user, `/api${path}`, init))
  let body: T
  try {
    body = (await res.json()) as T
  } catch {
    body = {} as T
  }
  return { status: res.status, body }
}

function post<T>(user: TestUser, path: string, payload: Record<string, unknown>) {
  return call<T>(user, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
}

describe("内网穿透租用化 · 用户端", () => {
  it("买套餐：扣掉积分、建出租约、端口落在套餐区间", async () => {
    const nodeId = await seedNode()
    const planId = await seedPlan(nodeId, { pricePoints: 100, days: 30 })
    const user = await makeUser()
    await grant(user.id, 250)

    const res = await post<{
      ok: boolean
      id: string
      frpUser: string
      ports: number[]
      expiresAt: string
      balance: number
    }>(user, "/frp/rental/purchase", { planId })

    expect(res.status).toBe(200)
    expect(res.body.frpUser).toMatch(/^DC_[0-9a-f]{8}$/)
    expect(res.body.ports).toHaveLength(1)
    expect(res.body.ports[0]).toBeGreaterThanOrEqual(31000)
    expect(res.body.ports[0]).toBeLessThanOrEqual(31999)
    expect(await balanceOf(user.id)).toBe(150)

    const days = (Date.parse(res.body.expiresAt) - Date.now()) / DAY_MS
    expect(days).toBeGreaterThan(29.5)
    expect(days).toBeLessThan(30.5)

    // 端口租约也要登记，否则端口会被重复分配给别人
    const lease = await env.DB.prepare(
      `SELECT port FROM frp_port_leases WHERE sub_id = ?`
    )
      .bind(res.body.id)
      .first<{ port: number }>()
    expect(lease?.port).toBe(res.body.ports[0])
  })

  it("积分不足：整笔拒绝，既不扣分也不建租约", async () => {
    const nodeId = await seedNode()
    const planId = await seedPlan(nodeId, { pricePoints: 100 })
    const user = await makeUser()
    await grant(user.id, 99)

    const res = await post<{ code?: string }>(user, "/frp/rental/purchase", { planId })
    expect(res.status).toBe(402)
    expect(res.body.code).toBe("INSUFFICIENT_POINTS")

    // 关键：余额没动、没有租约、端口也没被占
    expect(await balanceOf(user.id)).toBe(99)
    const subs = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM frp_subscriptions WHERE user_id = ?`
    )
      .bind(user.id)
      .first<{ n: number }>()
    expect(subs?.n).toBe(0)
    const leases = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM frp_port_leases WHERE node_id = ?`
    )
      .bind(nodeId)
      .first<{ n: number }>()
    expect(leases?.n).toBe(0)
  })

  it("同一个节点上已有一份租约时不能再买一份", async () => {
    const nodeId = await seedNode()
    const planId = await seedPlan(nodeId, { pricePoints: 100 })
    const user = await makeUser()
    await grant(user.id, 500)

    const first = await post<{ ok: boolean }>(user, "/frp/rental/purchase", { planId })
    expect(first.status).toBe(200)

    const second = await post<{ code?: string }>(user, "/frp/rental/purchase", { planId })
    expect(second.status).toBe(409)
    expect(second.body.code).toBe("ALREADY_SUBSCRIBED")
    // 第二次不能再扣分
    expect(await balanceOf(user.id)).toBe(400)
  })

  it("重复提交（同 requestId）只扣一次分", async () => {
    const nodeId = await seedNode()
    const planId = await seedPlan(nodeId, { pricePoints: 100 })
    const user = await makeUser()
    await grant(user.id, 500)
    const requestId = uuid()

    const first = await post<{ id: string }>(user, "/frp/rental/purchase", { planId, requestId })
    expect(first.status).toBe(200)
    expect(await balanceOf(user.id)).toBe(400)

    // 管理员回收掉租约后，用同一个 requestId 再提交一次：
    // 「已有租约」这道闸没了，于是会走到积分这一层 —— 必须被 dedup 挡住
    await env.DB.prepare(`DELETE FROM frp_subscriptions WHERE id = ?`).bind(first.body.id).run()
    await env.DB.prepare(`DELETE FROM frp_port_leases WHERE sub_id = ?`).bind(first.body.id).run()

    const again = await post<{ code?: string }>(user, "/frp/rental/purchase", { planId, requestId })
    expect(again.status).toBe(409)
    expect(again.body.code).toBe("DUPLICATE_REQUEST")
    expect(await balanceOf(user.id)).toBe(400)

    const subs = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM frp_subscriptions WHERE user_id = ?`
    )
      .bind(user.id)
      .first<{ n: number }>()
    expect(subs?.n).toBe(0)
  })

  it("续期：扣分并从原到期日顺延（不吞掉剩余天数）", async () => {
    const nodeId = await seedNode()
    const planId = await seedPlan(nodeId, { pricePoints: 100, days: 30 })
    const user = await makeUser()
    await grant(user.id, 500)

    const bought = await post<{ id: string; expiresAt: string }>(user, "/frp/rental/purchase", { planId })
    const before = Date.parse(bought.body.expiresAt)

    const renewed = await post<{ expiresAt: string; balance: number }>(user, "/frp/rental/renew", {
      id: bought.body.id,
    })
    expect(renewed.status).toBe(200)
    expect(await balanceOf(user.id)).toBe(300)

    const added = (Date.parse(renewed.body.expiresAt) - before) / DAY_MS
    expect(added).toBeGreaterThan(29.5)
    expect(added).toBeLessThan(30.5)
  })

  it("不能续别人的租约（否则就是花自己的分改别人的到期日）", async () => {
    const nodeId = await seedNode()
    const planId = await seedPlan(nodeId, { pricePoints: 100 })
    const owner = await makeUser()
    const other = await makeUser()
    await grant(owner.id, 500)
    await grant(other.id, 500)

    const bought = await post<{ id: string }>(owner, "/frp/rental/purchase", { planId })
    expect(bought.status).toBe(200)

    const stolen = await post<{ code?: string }>(other, "/frp/rental/renew", { id: bought.body.id })
    expect(stolen.status).toBe(404)
    expect(await balanceOf(other.id)).toBe(500)
  })

  it("生成的 frpc 配置与人工申请那条路径同形，并且带上了端口", async () => {
    const nodeId = await seedNode()
    const planId = await seedPlan(nodeId, { pricePoints: 100, maxPorts: 2 })
    const user = await makeUser()
    await grant(user.id, 500)

    const bought = await post<{ id: string; frpUser: string; ports: number[] }>(
      user,
      "/frp/rental/purchase",
      { planId }
    )

    const mine = await call<{
      subscriptions: { id: string; configToml: string | null; ports: number[] }[]
    }>(user, "/frp/rental/mine")
    const sub = mine.body.subscriptions.find((s) => s.id === bought.body.id)
    expect(sub?.configToml).toBeTruthy()

    const cfg = sub!.configToml!
    expect(cfg).toContain(`serverAddr = "${NODE_ADDR}"`)
    expect(cfg).toContain("serverPort = 7000")
    expect(cfg).toContain(`auth.token = "${NODE_AUTH}"`)
    expect(cfg).toContain(`user = "${bought.body.frpUser}"`)
    // metadatas.token 就是面板里那个账号的口令 —— 缺了它 frpc 过不了鉴权插件
    expect(cfg).toMatch(/metadatas\.token = "[A-Za-z0-9]+"/)
    for (const p of bought.body.ports) {
      expect(cfg).toContain(`remotePort = ${p}`)
      expect(cfg).toContain(`localPort = ${p}`)
    }
  })

  it("到期后不再下发配置，且状态显示为已过期", async () => {
    const nodeId = await seedNode()
    const planId = await seedPlan(nodeId, { pricePoints: 100 })
    const user = await makeUser()
    await grant(user.id, 500)

    const bought = await post<{ id: string }>(user, "/frp/rental/purchase", { planId })
    const past = new Date(Date.now() - DAY_MS).toISOString()
    await env.DB.prepare(`UPDATE frp_subscriptions SET expires_at = ? WHERE id = ?`)
      .bind(past, bought.body.id)
      .run()

    const mine = await call<{
      subscriptions: { id: string; status: string; configToml: string | null; daysLeft: number }[]
    }>(user, "/frp/rental/mine")
    const sub = mine.body.subscriptions.find((s) => s.id === bought.body.id)
    expect(sub?.configToml).toBeNull()
    expect(sub?.status).toBe("expired")
    expect(sub?.daysLeft).toBeLessThanOrEqual(0)
  })

  it("已下架的套餐买不了；列表里也不会出现", async () => {
    const nodeId = await seedNode()
    const offPlan = await seedPlan(nodeId, { enabled: 0, name: "已下架" })
    const user = await makeUser()
    await grant(user.id, 500)

    const res = await post<{ code?: string }>(user, "/frp/rental/purchase", { planId: offPlan })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe("PLAN_DISABLED")

    const plans = await call<{ plans: { id: string }[] }>(user, "/frp/rental/plans")
    expect(plans.body.plans.find((p) => p.id === offPlan)).toBeUndefined()
  })

  it("买得起 / 买不起会用 affordable 标出来，并带上我的余额", async () => {
    const nodeId = await seedNode()
    const cheap = await seedPlan(nodeId, { pricePoints: 50, name: "便宜的" })
    await seedPlan(nodeId, { pricePoints: 9999, name: "贵的" })
    const user = await makeUser()
    await grant(user.id, 100)

    const res = await call<{
      balance: number
      plans: { id: string; affordable: boolean; existing: unknown }[]
    }>(user, "/frp/rental/plans")
    expect(res.status).toBe(200)
    expect(res.body.balance).toBe(100)
    expect(res.body.plans.find((p) => p.id === cheap)?.affordable).toBe(true)
    expect(res.body.plans.find((p) => p.name === "贵的")?.affordable).toBe(false)
  })

  it("未登录不能碰这些接口", async () => {
    for (const [path, method] of [
      ["/frp/rental/plans", "GET"],
      ["/frp/rental/mine", "GET"],
    ] as const) {
      const res = await fetchSelf(new Request(`https://cloud.doulor.cn/api${path}`, { method }))
      expect(res.status).toBe(401)
    }
    const res = await fetchSelf(
      new Request(`https://cloud.doulor.cn/api/frp/rental/purchase`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: "x" }),
      })
    )
    expect(res.status).toBe(401)
  })
})
