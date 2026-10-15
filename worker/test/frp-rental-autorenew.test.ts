// 内网穿透「自动续费」（2026-10-14）。
//
// 这个功能的风险点是**在用户不在场的时候动他的钱**。所以测试重点是：
//   · 不该续的绝不能续（没到期、开关关着、没有套餐）
//   · 该续的要续对（扣款金额、到期时间从**原到期日**顺延，不是从现在）
//   · 积分不够要**关掉开关并留下原因**，而不是反复重试刷日志
//   · cron 可以重复触发，同一期只续一次（靠幂等键）
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { uuid } from "../src/crypto"
import { applyPoints } from "../src/points"
import { autoRenewDueRentals, setMyRentalAutoRenew } from "../src/handlers/frp-rental"
import { authRequest, fetchSelf, makeUser, type TestUser } from "./helpers"

const NODE_ADDR = "frp-autorenew.test"
const NODE_AUTH = "autorenew-secret"
const DAY = 86_400_000

async function seedNode(): Promise<string> {
  const id = `n_${uuid().slice(0, 8)}`
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO frp_nodes
       (id, name, server_addr, server_port, auth_token, token_prefix,
        port_min, port_max, max_ports, enabled, sort_order, auth_mode, created_at, updated_at)
     VALUES (?, '自动续费测试节点', ?, 7000, ?, '', 51000, 51999, 2, 1, 0, 'token_user', ?, ?)`
  )
    .bind(id, NODE_ADDR, NODE_AUTH, now, now)
    .run()
  return id
}

async function seedPlan(nodeId: string, pricePoints: number, days: number): Promise<string> {
  const id = `plan_${uuid().slice(0, 8)}`
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO frp_plans
       (id, node_id, name, days, price_points, max_ports, allow_ranges, sort_order, enabled, note, created_at, updated_at)
     VALUES (?, ?, '自动续费套餐', ?, ?, 1, ?, 0, 1, NULL, ?, ?)`
  )
    .bind(id, nodeId, days, pricePoints, JSON.stringify([[51000, 51999]]), now, now)
    .run()
  return id
}

/** 直接插一条租约，指定到期时间与自动续费开关（跳过下单流程，聚焦续费逻辑） */
async function seedSubscription(opts: {
  userId: string
  nodeId: string
  planId: string | null
  expiresInMs: number
  autoRenew: boolean
  pricePoints: number
}): Promise<string> {
  const id = `sub_${uuid().slice(0, 8)}`
  const now = new Date()
  await env.DB.prepare(
    `INSERT INTO frp_subscriptions
       (id, user_id, node_id, plan_id, frp_user, frp_token, ports, status,
        started_at, expires_at, auto_renew, price_points, sync_state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '[51001]', 'active', ?, ?, ?, ?, 'synced', ?, ?)`
  )
    .bind(
      id,
      opts.userId,
      opts.nodeId,
      opts.planId,
      `DC_${uuid().slice(0, 8)}`,
      `Token${uuid().slice(0, 12)}`,
      now.toISOString(),
      new Date(now.getTime() + opts.expiresInMs).toISOString(),
      opts.autoRenew ? 1 : 0,
      opts.pricePoints,
      now.toISOString(),
      now.toISOString()
    )
    .run()
  return id
}

async function sub(id: string) {
  return env.DB.prepare(
    `SELECT auto_renew, expires_at, last_error FROM frp_subscriptions WHERE id = ?`
  )
    .bind(id)
    .first<{ auto_renew: number; expires_at: string; last_error: string | null }>()
}

async function balanceOf(userId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT balance FROM user_points WHERE user_id = ?`)
    .bind(userId)
    .first<{ balance: number }>()
  return row?.balance ?? 0
}

async function grant(userId: string, amount: number): Promise<void> {
  const res = await applyPoints(env, { userId, delta: amount, reason: "admin", detail: "测试发放" })
  expect(res.applied).toBe(true)
}

describe("内网穿透 · 自动续费", () => {
  it("到期前 24 小时内 + 开着开关 + 分数够 → 扣款并顺延一期", async () => {
    const user = await makeUser()
    const nodeId = await seedNode()
    const planId = await seedPlan(nodeId, 100, 30)
    // 还有 2 小时到期
    const subId = await seedSubscription({
      userId: user.id,
      nodeId,
      planId,
      expiresInMs: 2 * 3600_000,
      autoRenew: true,
      pricePoints: 100,
    })
    await grant(user.id, 500)
    const before = await sub(subId)

    const r = await autoRenewDueRentals(env)
    expect(r.renewed).toBe(1)
    expect(await balanceOf(user.id)).toBe(400) // 扣了 100

    const after = await sub(subId)
    // 从**原到期时间**顺延 30 天，而不是从现在
    const expectNext = Date.parse(before!.expires_at) + 30 * DAY
    expect(Math.abs(Date.parse(after!.expires_at) - expectNext)).toBeLessThan(2000)
    expect(after!.auto_renew).toBe(1) // 开关保持开着
  })

  it("还没进入 24 小时窗口 → 一动不动", async () => {
    const user = await makeUser()
    const nodeId = await seedNode()
    const planId = await seedPlan(nodeId, 100, 30)
    // 还有 10 天才到期
    const subId = await seedSubscription({
      userId: user.id,
      nodeId,
      planId,
      expiresInMs: 10 * DAY,
      autoRenew: true,
      pricePoints: 100,
    })
    await grant(user.id, 500)
    const before = await sub(subId)

    const r = await autoRenewDueRentals(env)
    expect(r.renewed).toBe(0)
    expect(await balanceOf(user.id)).toBe(500) // 一分没动
    expect((await sub(subId))!.expires_at).toBe(before!.expires_at)
  })

  it("开关关着 → 即使马上到期也不续", async () => {
    const user = await makeUser()
    const nodeId = await seedNode()
    const planId = await seedPlan(nodeId, 100, 30)
    const subId = await seedSubscription({
      userId: user.id,
      nodeId,
      planId,
      expiresInMs: 3600_000,
      autoRenew: false,
      pricePoints: 100,
    })
    await grant(user.id, 500)

    const r = await autoRenewDueRentals(env)
    expect(r.renewed).toBe(0)
    expect(await balanceOf(user.id)).toBe(500)
    expect((await sub(subId))!.auto_renew).toBe(0)
  })

  it("积分不够 → 关掉开关并写下原因，不是静默失败", async () => {
    const user = await makeUser()
    const nodeId = await seedNode()
    const planId = await seedPlan(nodeId, 100, 30)
    const subId = await seedSubscription({
      userId: user.id,
      nodeId,
      planId,
      expiresInMs: 3600_000,
      autoRenew: true,
      pricePoints: 100,
    })
    await grant(user.id, 30) // 不够

    const r = await autoRenewDueRentals(env)
    expect(r.insufficient).toBe(1)
    expect(await balanceOf(user.id)).toBe(30) // 没扣成

    const s = await sub(subId)
    expect(s!.auto_renew).toBe(0) // 开关被关掉
    expect(s!.last_error || "").toContain("积分不足") // 原因留下了
  })

  it("cron 重复触发：同一期只续一次（幂等键）", async () => {
    const user = await makeUser()
    const nodeId = await seedNode()
    const planId = await seedPlan(nodeId, 100, 30)
    const subId = await seedSubscription({
      userId: user.id,
      nodeId,
      planId,
      expiresInMs: 3600_000,
      autoRenew: true,
      pricePoints: 100,
    })
    await grant(user.id, 500)

    await autoRenewDueRentals(env)
    const afterFirst = (await sub(subId))!.expires_at
    // 立刻再来一轮（模拟 cron 重入）
    await autoRenewDueRentals(env)

    expect(await balanceOf(user.id)).toBe(400) // 只扣了一次
    expect((await sub(subId))!.expires_at).toBe(afterFirst) // 时间只顺延了一次
  })

  it("没有套餐的租约 → 跳过，且不关开关（是数据不全，不是用户的错）", async () => {
    const user = await makeUser()
    const nodeId = await seedNode()
    const subId = await seedSubscription({
      userId: user.id,
      nodeId,
      planId: null,
      expiresInMs: 3600_000,
      autoRenew: true,
      pricePoints: 0,
    })
    await grant(user.id, 500)

    const r = await autoRenewDueRentals(env)
    expect(r.renewed).toBe(0)
    expect(await balanceOf(user.id)).toBe(500)
    expect((await sub(subId))!.auto_renew).toBe(1) // 开关保留
  })

  it("开关接口：只能改自己的租约；别人的 id 返回 404 而不是 403", async () => {
    const owner = await makeUser()
    const other = await makeUser()
    const nodeId = await seedNode()
    const planId = await seedPlan(nodeId, 100, 30)
    const subId = await seedSubscription({
      userId: owner.id,
      nodeId,
      planId,
      expiresInMs: 5 * DAY,
      autoRenew: false,
      pricePoints: 100,
    })

    // 别人来改 → 404（不能让他区分出"存在但不是你的"）
    const denied = await fetchSelf(
      authRequest(other, "/api/frp/rental/auto-renew", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: subId, autoRenew: true }),
      })
    )
    expect(denied.status).toBe(404)
    expect((await sub(subId))!.auto_renew).toBe(0) // 没被改动

    // 本人来改 → 成功
    const okRes = await setMyRentalAutoRenew(
      env,
      authRequest(owner, "/api/frp/rental/auto-renew", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: subId, autoRenew: true }),
      })
    )
    expect(okRes.status).toBe(200)
    expect((await sub(subId))!.auto_renew).toBe(1)
  })
})
