// AI 中转站「订阅汇总」：把用户的多张活跃订阅按**套餐类型**合并后下发。
//
// 背景：NewAPI 里一个用户可以同时持有多张订阅（免费套餐 + 各档邀请 / 奖励套餐），
// 消费时按 `end_time asc, id asc` 逐张接力 ⇒ 总额度 = 各条之和。前端要画一条
// 「一个颜色 = 一个套餐」的分段进度条，所以服务端必须交出**合并后**的列表，
// 而不是只给第一条（旧实现 `listUserSubscriptions` 就是只取第一条，
// 结果邀请额度在界面上完全看不见）。
//
// 这里重点验证合并口径：同类相加、张数累加、有效期取最晚、重置取最早、
// 只算 active、以及「免费套餐」要能按设置项被单独识别出来。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, setSetting } from "./helpers"
import { resetAdminCredentialCache } from "../src/newapi-client"

const BASE = "https://api.doulor.cn"

/** 一条订阅记录（NewAPI 原始字段名，snake_case） */
interface SubSeed {
  id: number
  planId: number
  amountTotal: number
  amountUsed: number
  endTime: number
  nextResetTime: number
  status?: string
}

let restore: (() => void) | null = null
let subs: SubSeed[] = []
let plans: { id: number; title: string }[] = []

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/** 打桩 Worker 的出站 fetch：只接管发往 NewAPI 的请求，其余原样透传 */
function stubNewApi(): void {
  const original = globalThis.fetch
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    if (!url.startsWith(BASE)) return original(input as RequestInfo, init)

    if (url.includes("/api/status")) {
      return jsonResponse({
        success: true,
        message: "",
        data: { quota_display_type: "CNY", quota_per_unit: 500000 },
      })
    }
    if (url.includes("/api/subscription/admin/users/")) {
      return jsonResponse({
        success: true,
        message: "",
        data: subs.map((s) => ({
          subscription: {
            id: s.id,
            plan_id: s.planId,
            amount_total: s.amountTotal,
            amount_used: s.amountUsed,
            start_time: 1_790_000_000,
            end_time: s.endTime,
            status: s.status ?? "active",
            next_reset_time: s.nextResetTime,
          },
        })),
      })
    }
    if (url.includes("/api/subscription/plans")) {
      return jsonResponse({
        success: true,
        message: "",
        data: plans.map((p) => ({ plan: { id: p.id, title: p.title } })),
      })
    }
    // 其余（pricing / models 等）给空成功响应，够 status 跑完
    return jsonResponse({ success: true, message: "", data: [] })
  }) as unknown as typeof fetch
  globalThis.fetch = stub
  restore = () => {
    globalThis.fetch = original
  }
}

/** 塞一条 newapi_accounts 记录；enc_token 用哨兵值 ⇒ 不需要打桩用户登录 */
async function seedAccount(userId: string, newapiUserId: number, username: string) {
  await env.DB.prepare(
    `INSERT INTO newapi_accounts
       (user_id, newapi_user_id, username, email, enc_token, group_name, quota, used_quota, request_count, synced_at, created_at)
     VALUES (?, ?, ?, ?, 'NO_TOKEN', 'default', 0, 0, 0, NULL, ?)`
  )
    .bind(userId, newapiUserId, username, `${username}@doulor.cn`, new Date().toISOString())
    .run()
}

/** 走一遍 GET /api/dev/status，返回订阅相关字段 */
async function fetchSubscriptions(user: { cookie: string }) {
  const res = await fetchSelf(authRequest(user, "/api/dev/status"))
  expect(res.status).toBe(200)
  return res.json<{
    subscription: { planId: number; amountTotal: number; endTime: number } | null
    freePlanId: number
    subscriptions: {
      planId: number
      title: string
      amountTotal: number
      amountUsed: number
      endTime: number
      nextResetTime: number
      count: number
    }[]
    quotaPerUnit: number
  }>()
}

beforeEach(async () => {
  subs = []
  plans = [
    { id: 1, title: "免费套餐" },
    { id: 2, title: "wb邀请套餐" },
    { id: 3, title: "邀请套餐" },
  ]
  resetAdminCredentialCache()
  await setSetting("newapi_free_plan_id", "1")
  await setSetting("newapi_enabled", "1")
  stubNewApi()
})

afterEach(() => {
  restore?.()
  restore = null
  resetAdminCredentialCache()
})

describe("GET /api/dev/status 的订阅汇总", () => {
  it("未开通账号 → 订阅字段给全（null / 空数组），不出现 undefined", async () => {
    const u = await makeUser()
    const data = await fetchSubscriptions(u)
    expect(data.subscription).toBeNull()
    expect(data.subscriptions).toEqual([])
    expect(data.freePlanId).toBe(1)
  })

  it("只有免费套餐 → subscription 命中，subscriptions 只有它一条", async () => {
    const u = await makeUser()
    await seedAccount(u.id, 101, u.username)
    subs = [
      { id: 1, planId: 1, amountTotal: 500_000_000, amountUsed: 0, endTime: 2_106_035_570, nextResetTime: 1_790_438_400 },
    ]

    const data = await fetchSubscriptions(u)
    expect(data.subscription?.planId).toBe(1)
    expect(data.subscriptions).toHaveLength(1)
    expect(data.subscriptions[0].title).toBe("免费套餐")
    expect(data.quotaPerUnit).toBe(500000)
  })

  it("同套餐多张订阅 → 合并成一条，额度相加、张数累加", async () => {
    const u = await makeUser()
    await seedAccount(u.id, 102, u.username)
    // 免费 1 张 + 邀请套餐 3 张（每邀请一个人就多开一张）
    subs = [
      { id: 1, planId: 1, amountTotal: 500_000_000, amountUsed: 0, endTime: 2_106_035_570, nextResetTime: 1_790_438_400 },
      { id: 2, planId: 3, amountTotal: 100_000_000, amountUsed: 0, endTime: 1_793_018_823, nextResetTime: 1_790_438_400 },
      { id: 3, planId: 3, amountTotal: 100_000_000, amountUsed: 13_500_000, endTime: 1_793_018_823, nextResetTime: 1_790_438_400 },
      { id: 4, planId: 3, amountTotal: 100_000_000, amountUsed: 0, endTime: 1_793_018_823, nextResetTime: 1_790_438_400 },
    ]

    const data = await fetchSubscriptions(u)
    expect(data.subscriptions).toHaveLength(2)

    const inv = data.subscriptions.find((s) => s.planId === 3)!
    expect(inv.title).toBe("邀请套餐")
    expect(inv.amountTotal).toBe(300_000_000)
    expect(inv.amountUsed).toBe(13_500_000)
    expect(inv.count).toBe(3)
  })

  it("多档邀请套餐 → 顺序按 plan_id 升序（颜色与套餐的对应关系不漂移）", async () => {
    const u = await makeUser()
    await seedAccount(u.id, 103, u.username)
    // 故意把 wb 套餐（id 2）放在后面：输出必须仍按 plan_id 升序
    subs = [
      { id: 1, planId: 3, amountTotal: 100_000_000, amountUsed: 0, endTime: 1_793_018_823, nextResetTime: 1_790_438_400 },
      { id: 2, planId: 2, amountTotal: 250_000_000, amountUsed: 0, endTime: 1_793_018_823, nextResetTime: 1_790_438_400 },
    ]

    const data = await fetchSubscriptions(u)
    expect(data.subscriptions.map((s) => s.planId)).toEqual([2, 3])
    expect(data.subscriptions.map((s) => s.title)).toEqual(["wb邀请套餐", "邀请套餐"])
  })

  it("有效期取最晚一张、重置时刻取最早一张", async () => {
    const u = await makeUser()
    await seedAccount(u.id, 104, u.username)
    subs = [
      { id: 1, planId: 2, amountTotal: 250_000_000, amountUsed: 0, endTime: 1_790_000_000, nextResetTime: 1_790_500_000 },
      { id: 2, planId: 2, amountTotal: 250_000_000, amountUsed: 0, endTime: 1_795_000_000, nextResetTime: 1_790_438_400 },
    ]

    const data = await fetchSubscriptions(u)
    const wb = data.subscriptions.find((s) => s.planId === 2)!
    // 「有效期至」表示这份额度最后什么时候失效 ⇒ 取最晚
    expect(wb.endTime).toBe(1_795_000_000)
    // 「下次重置」取最早的一个更保守
    expect(wb.nextResetTime).toBe(1_790_438_400)
  })

  it("非 active 的订阅不参与汇总", async () => {
    const u = await makeUser()
    await seedAccount(u.id, 105, u.username)
    subs = [
      { id: 1, planId: 1, amountTotal: 500_000_000, amountUsed: 0, endTime: 2_106_035_570, nextResetTime: 1_790_438_400 },
      { id: 2, planId: 3, amountTotal: 100_000_000, amountUsed: 0, endTime: 1_793_018_823, nextResetTime: 1_790_438_400, status: "expired" },
    ]

    const data = await fetchSubscriptions(u)
    expect(data.subscriptions.map((s) => s.planId)).toEqual([1])
    expect(data.subscription?.planId).toBe(1)
  })

  it("freePlanId 跟随设置项：改掉后原免费套餐就不再算作「免费」", async () => {
    const u = await makeUser()
    await seedAccount(u.id, 106, u.username)
    await setSetting("newapi_free_plan_id", "2")
    subs = [
      { id: 1, planId: 1, amountTotal: 500_000_000, amountUsed: 0, endTime: 2_106_035_570, nextResetTime: 1_790_438_400 },
      { id: 2, planId: 2, amountTotal: 250_000_000, amountUsed: 0, endTime: 1_793_018_823, nextResetTime: 1_790_438_400 },
    ]

    const data = await fetchSubscriptions(u)
    expect(data.freePlanId).toBe(2)
    // subscription 指向设置项指定的那一档，前端据此把「免费」与「邀请」分开展示
    expect(data.subscription?.planId).toBe(2)
  })

  it("套餐表读不到名字 → 降级成「套餐 #id」，额度照常展示", async () => {
    const u = await makeUser()
    await seedAccount(u.id, 107, u.username)
    plans = [] // 套餐接口返回空
    subs = [
      { id: 1, planId: 3, amountTotal: 100_000_000, amountUsed: 0, endTime: 1_793_018_823, nextResetTime: 1_790_438_400 },
    ]

    const data = await fetchSubscriptions(u)
    expect(data.subscriptions[0].title).toBe("套餐 #3")
    expect(data.subscriptions[0].amountTotal).toBe(100_000_000)
  })

  it("没有订阅 → subscription 为 null、subscriptions 为空", async () => {
    const u = await makeUser()
    await seedAccount(u.id, 108, u.username)
    subs = []

    const data = await fetchSubscriptions(u)
    expect(data.subscription).toBeNull()
    expect(data.subscriptions).toEqual([])
  })
})
