// 成就奖励「两端对齐」回归测试（2026-10-08 线上事故）
//
// 事故背景：NewAPI 套餐可设 max_purchase_per_user（限购）。达上限后创建订阅返回
// 「已达到该套餐购买上限」，而旧版 adminGrantSubscription 把这类错误当成成功
// （那个宽容分支本是为「免费订阅重复领取」设计的），于是站点账本一路推进、
// 订阅从未创建 —— 用户静默少发（线上案例：70 成就点只拿到 5 份）。
//
// 修复后发放改为「以 NewAPI 实际持有为真相源」的两端对齐，本文件覆盖：
//   1. 少发 → 补差额，成功后账本跟随实际
//   2. 限购拒绝必须是**真实失败**：不推进账本、不记成功审计、写失败审计（核心回归）
//   3. 多发 → 撤回未使用的最新份；已使用的份不撤
//   4. 读取失败 → 不补不撤、账本不动（不确定时不动作）
//   5. 已对齐 → 幂等（无创建/删除调用）；账本漂移会被纠正
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, setSetting } from "./helpers"
import { grantAchievementRewards } from "../src/achievement-rewards"
import { resetAdminCredentialCache } from "../src/newapi-client"

const BASE = "https://api.doulor.cn"
const PLAN = 4

interface FakeSub {
  id: number
  plan_id: number
  amount_total: number
  amount_used: number
  start_time: number
  end_time: number
  status: string
  next_reset_time: number
}

let subs: FakeSub[] = []
let nextSubId = 100
let calls: { method: string; path: string }[] = []
let failList = false
let failDelete = false
/** >0 时模拟 NewAPI 的限购：该套餐行数达到该值后拒绝创建 */
let planLimit = 0
/** 套餐定义里的 max_purchase_per_user（用于发放前的预警，不参与 stub 拒绝逻辑） */
let planMaxPurchase = 0
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
    const method = (init?.method ?? "GET").toUpperCase()
    const path = url.slice(BASE.length)

    if (path === "/api/status") {
      return jsonResponse({
        success: true,
        data: { quota_display_type: "CNY", quota_per_unit: 500000 },
      })
    }
    if (path === "/api/subscription/plans") {
      return jsonResponse({
        success: true,
        data: [{ plan: { id: PLAN, title: "成就奖励", max_purchase_per_user: planMaxPurchase } }],
      })
    }

    const listMatch = path.match(/^\/api\/subscription\/admin\/users\/(\d+)\/subscriptions$/)
    if (listMatch && method === "GET") {
      calls.push({ method, path })
      if (failList) return jsonResponse({ success: false, message: "上游炸了" }, 500)
      return jsonResponse({ success: true, data: subs.map((s) => ({ subscription: s })) })
    }
    if (listMatch && method === "POST") {
      calls.push({ method, path })
      const mine = subs.filter((s) => s.plan_id === PLAN)
      if (planLimit > 0 && mine.length >= planLimit) {
        // NewAPI model.CreateUserSubscriptionFromPlanTx 的原话
        return jsonResponse({ success: false, message: "已达到该套餐购买上限" }, 400)
      }
      const now = Math.floor(Date.now() / 1000)
      subs.push({
        id: nextSubId++,
        plan_id: PLAN,
        amount_total: 250_000_000,
        amount_used: 0,
        start_time: now,
        end_time: now + 315_360_000,
        status: "active",
        next_reset_time: now + 86_400,
      })
      return jsonResponse({ success: true, data: null })
    }

    const delMatch = path.match(/^\/api\/subscription\/admin\/user_subscriptions\/(\d+)$/)
    if (delMatch && method === "DELETE") {
      calls.push({ method, path })
      if (failDelete) return jsonResponse({ success: false, message: "删除失败" }, 500)
      subs = subs.filter((s) => s.id !== Number(delMatch[1]))
      return jsonResponse({ success: true, data: null })
    }
    return original(input as RequestInfo, init)
  }) as typeof fetch
  globalThis.fetch = stub
  restore = () => {
    globalThis.fetch = original
  }
}

/** 给用户绑一个中转站账号（发放的前置条件） */
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

let newapiSeq = 0
/**
 * 逐用例绑号：`newapi_accounts.newapi_user_id` 有 UNIQUE 约束，而 D1 实例在
 * 用例之间共享 —— 固定用同一个号会在第二个用例起撞约束。
 */
async function bindFresh(userId: string): Promise<void> {
  await bindNewApi(userId, 9000 + ++newapiSeq)
}

/** 造 count 份假订阅；下标越大 = 创建越晚（end_time 递增） */
function seedSubs(count: number, amountUsed = 0): void {
  const now = Math.floor(Date.now() / 1000)
  for (let i = 0; i < count; i++) {
    subs.push({
      id: nextSubId++,
      plan_id: PLAN,
      amount_total: 250_000_000,
      amount_used: amountUsed,
      start_time: now + i,
      end_time: now + 1000 + i * 1000,
      status: "active",
      next_reset_time: now + 86_400,
    })
  }
}

async function ledger(userId: string): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT granted_tiers FROM achievement_rewards WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ granted_tiers: number }>()
  return row?.granted_tiers ?? null
}

async function audits(userId: string, action: string): Promise<string[]> {
  const res = await env.DB.prepare(
    "SELECT detail FROM audit_logs WHERE user_id = ? AND action = ? ORDER BY created_at"
  )
    .bind(userId, action)
    .all<{ detail: string }>()
  return (res.results ?? []).map((r) => r.detail)
}

const countCalls = (method: string) => calls.filter((c) => c.method === method).length

beforeEach(async () => {
  subs = []
  nextSubId = 100
  calls = []
  failList = false
  failDelete = false
  planLimit = 0
  planMaxPurchase = 0
  stubNewApi()
  resetAdminCredentialCache()
  await setSetting("achievement_reward_enabled", "1")
  await setSetting("achievement_reward_plan_id", String(PLAN))
  await setSetting("achievement_reward_points", "10")
})

afterEach(() => {
  restore?.()
  restore = null
})

describe("成就奖励两端对齐", () => {
  it("少发补齐：70 点应 7 份、实际 5 份 → 补 2 份并更新账本", async () => {
    const u = await makeUser()
    await bindFresh(u.id)
    seedSubs(5)

    const r = await grantAchievementRewards(env, u.id, u.username, 70)
    expect(r.granted).toBe(2)
    expect(subs.length).toBe(7)
    expect(await ledger(u.id)).toBe(7)
    expect(countCalls("POST")).toBe(2)

    const ok = await audits(u.id, "achievement.reward")
    expect(ok.length).toBe(1)
    expect(ok[0]).toContain("补发成就订阅 2 份")
  })

  it("限购拒绝是真实失败：不推进账本、不记成功、写失败审计（核心回归）", async () => {
    const u = await makeUser()
    await bindFresh(u.id)
    seedSubs(5)
    planLimit = 5 // NewAPI 侧：该套餐每人最多 5 份
    planMaxPurchase = 5 // 套餐定义同值（用于预警文案）

    const r = await grantAchievementRewards(env, u.id, u.username, 70)
    expect(r.granted).toBe(0)
    expect(subs.length).toBe(5) // 没有新增订阅
    expect(await ledger(u.id)).toBe(5) // 账本跟随实际（旧实现会错误推进到 7）
    expect(countCalls("POST")).toBe(0) // 预检到限购挡住，不空跑 POST
    expect((await audits(u.id, "achievement.reward")).length).toBe(0)

    const failed = await audits(u.id, "achievement.reward_failed")
    expect(failed.length).toBe(1)
    expect(failed[0]).toContain("最多 5 份")
  })

  it("限购拒绝（套餐未暴露限购值时）：仍不推进账本，失败审计带原始错误", async () => {
    const u = await makeUser()
    await bindFresh(u.id)
    seedSubs(5)
    planLimit = 5 // stub 会拒绝，但 planMaxPurchase = 0（套餐定义读不到限购）
    const r = await grantAchievementRewards(env, u.id, u.username, 70)
    expect(r.granted).toBe(0)
    expect(await ledger(u.id)).toBe(5)
    const failed = await audits(u.id, "achievement.reward_failed")
    expect(failed.length).toBe(1)
    expect(failed[0]).toContain("已达到该套餐购买上限")
  })

  it("多发撤回：应发 4 份、实际 6 份 → 删未使用的最新 2 份，已使用的不动", async () => {
    const u = await makeUser()
    await bindFresh(u.id)
    seedSubs(6)
    // 最老的两张已产生消费（撤回必须避开）
    subs[0].amount_used = 1000
    subs[1].amount_used = 2000
    const usedIds = [subs[0].id, subs[1].id]

    const r = await grantAchievementRewards(env, u.id, u.username, 40)
    expect(r.granted).toBe(0)
    expect(subs.length).toBe(4)
    expect(countCalls("DELETE")).toBe(2)
    // 已使用的两张必须还在
    for (const id of usedIds) expect(subs.some((s) => s.id === id)).toBe(true)
    expect(await ledger(u.id)).toBe(4)
    expect((await audits(u.id, "achievement.reward_revoke")).length).toBe(1)
  })

  it("多发但全部已使用：不删，账本跟随实际，记一次 revoke_blocked", async () => {
    const u = await makeUser()
    await bindFresh(u.id)
    seedSubs(6, 500)

    const r = await grantAchievementRewards(env, u.id, u.username, 40)
    expect(r.granted).toBe(0)
    expect(subs.length).toBe(6)
    expect(countCalls("DELETE")).toBe(0)
    expect(await ledger(u.id)).toBe(6)
    expect((await audits(u.id, "achievement.reward_revoke_blocked")).length).toBe(1)
  })

  it("读取订阅列表失败：不补不撤、账本不动（不确定时不动作）", async () => {
    const u = await makeUser()
    await bindFresh(u.id)
    seedSubs(5)
    failList = true

    const r = await grantAchievementRewards(env, u.id, u.username, 70)
    expect(r.granted).toBe(0)
    expect(subs.length).toBe(5)
    expect(countCalls("POST")).toBe(0)
    expect(countCalls("DELETE")).toBe(0)
    expect(await ledger(u.id)).toBeNull()
  })

  it("已对齐时幂等：不发不撤，无创建/删除调用", async () => {
    const u = await makeUser()
    await bindFresh(u.id)
    seedSubs(5)

    const r = await grantAchievementRewards(env, u.id, u.username, 50)
    expect(r.granted).toBe(0)
    expect(countCalls("POST")).toBe(0)
    expect(countCalls("DELETE")).toBe(0)
    expect(await ledger(u.id)).toBe(5)
  })

  it("账本漂移纠正：账本虚高（7）时对齐回实际（5），不发不撤", async () => {
    const u = await makeUser()
    await bindFresh(u.id)
    seedSubs(5)
    await env.DB.prepare(
      "INSERT INTO achievement_rewards (user_id, granted_tiers, updated_at) VALUES (?, ?, ?)"
    )
      .bind(u.id, 7, new Date().toISOString())
      .run()

    const r = await grantAchievementRewards(env, u.id, u.username, 50)
    expect(r.granted).toBe(0)
    expect(await ledger(u.id)).toBe(5)
    expect(countCalls("POST")).toBe(0)
  })

  it("未开通中转站：不发生任何 NewAPI 调用", async () => {
    const u = await makeUser()
    const r = await grantAchievementRewards(env, u.id, u.username, 70)
    expect(r.granted).toBe(0)
    expect(calls.length).toBe(0)
  })

  it("成就点不足一档：不动作", async () => {
    const u = await makeUser()
    await bindFresh(u.id)
    const r = await grantAchievementRewards(env, u.id, u.username, 9)
    expect(r.granted).toBe(0)
    expect(calls.length).toBe(0)
  })
})
