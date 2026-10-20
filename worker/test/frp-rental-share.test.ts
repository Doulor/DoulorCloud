// 内网穿透「租用分成」（2026-10-14）。
//
// 这是**又一条动钱的路径**，而且比扣款更容易出错 —— 因为它是「一笔钱分给两个人」：
//   · 分少了：捐献者吃亏，这个功能就失去意义
//   · 分多了：平台倒贴，且积分总量对不上（分成是**转移**，不是增发）
//   · 分错了人：把钱给了不该给的人
//   · 重复分：重放请求导致同一笔租金分两次
//
// 所以这里的断言全部是**余额精确值**，而不是「大于 0」这种模糊判断。
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { uuid } from "../src/crypto"
import { applyPoints } from "../src/points"
import { updateSettings } from "../src/settings"
import { authRequest, fetchSelf, makeUser, type TestUser } from "./helpers"

const NODE_ADDR = "frp-share.test"
const NODE_AUTH = "share-secret"

/** 建节点，可指定归属用户（捐献者） */
async function seedNode(ownerUserId: string | null): Promise<string> {
  const id = `n_${uuid().slice(0, 8)}`
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO frp_nodes
       (id, name, server_addr, server_port, auth_token, token_prefix,
        port_min, port_max, max_ports, enabled, sort_order, auth_mode,
        owner_user_id, created_at, updated_at)
     VALUES (?, '分成测试节点', ?, 7000, ?, '', 41000, 41999, 3, 1, 0, 'token_user', ?, ?, ?)`
  )
    .bind(id, NODE_ADDR, NODE_AUTH, ownerUserId, now, now)
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

async function seedPlan(nodeId: string, pricePoints: number): Promise<string> {
  const id = `plan_${uuid().slice(0, 8)}`
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO frp_plans
       (id, node_id, name, days, price_points, max_ports, allow_ranges, sort_order, enabled, note, created_at, updated_at)
     VALUES (?, ?, '分成测试套餐', 30, ?, 1, ?, 0, 1, NULL, ?, ?)`
  )
    .bind(id, nodeId, pricePoints, JSON.stringify([[41000, 41999]]), now, now)
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

async function rent(user: TestUser, planId: string, requestId?: string) {
  const res = await fetchSelf(
    authRequest(user, "/api/frp/rental/purchase", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId, ...(requestId ? { requestId } : {}) }),
    })
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

/** 把分成比例改掉（模拟管理员在面板里改） */
async function setSharePercent(adminId: string, pct: string): Promise<void> {
  await updateSettings(env, { frp_rental_owner_share_percent: pct }, adminId)
}

describe("内网穿透 · 租用分成", () => {
  it("捐献者拿到 10%：租 100 分 → 租用者 -100，捐献者 +10", async () => {
    const owner = await makeUser()
    const renter = await makeUser()
    const nodeId = await seedNode(owner.id)
    const planId = await seedPlan(nodeId, 100)
    await grant(renter.id, 250)

    const res = await rent(renter, planId, `req_${uuid()}`)
    expect(res.status).toBe(200)

    // 钱的两个方向都必须精确
    expect(await balanceOf(renter.id)).toBe(150) // 250 - 100
    expect(await balanceOf(owner.id)).toBe(10) // 10%
  })

  it("比例改成 30% 后按新比例分（后台可改）", async () => {
    const admin = await makeUser()
    const owner = await makeUser()
    const renter = await makeUser()
    await setSharePercent(admin.id, "30")

    const nodeId = await seedNode(owner.id)
    const planId = await seedPlan(nodeId, 200)
    await grant(renter.id, 500)

    const res = await rent(renter, planId, `req_${uuid()}`)
    expect(res.status).toBe(200)
    expect(await balanceOf(renter.id)).toBe(300) // 500 - 200
    expect(await balanceOf(owner.id)).toBe(60) // 30% of 200
  })

  it("比例设为 0 → 全额销毁，捐献者一分不得", async () => {
    const admin = await makeUser()
    const owner = await makeUser()
    const renter = await makeUser()
    await setSharePercent(admin.id, "0")

    const nodeId = await seedNode(owner.id)
    const planId = await seedPlan(nodeId, 100)
    await grant(renter.id, 200)

    const res = await rent(renter, planId, `req_${uuid()}`)
    expect(res.status).toBe(200)
    expect(await balanceOf(renter.id)).toBe(100)
    expect(await balanceOf(owner.id)).toBe(0)
  })

  it("自营节点（无归属用户）不分成", async () => {
    const renter = await makeUser()
    const nodeId = await seedNode(null) // 平台自己的机器
    const planId = await seedPlan(nodeId, 100)
    await grant(renter.id, 200)

    const res = await rent(renter, planId, `req_${uuid()}`)
    expect(res.status).toBe(200)
    // 租用者照常扣分，但没有别人收到钱
    expect(await balanceOf(renter.id)).toBe(100)
  })

  it("自己租自己捐的节点：只扣不返，避免无意义往返", async () => {
    const owner = await makeUser()
    const nodeId = await seedNode(owner.id)
    const planId = await seedPlan(nodeId, 100)
    await grant(owner.id, 200)

    const res = await rent(owner, planId, `req_${uuid()}`)
    expect(res.status).toBe(200)
    // 如果错误地"分给自己"，余额会变成 110 —— 这里必须正好是 100
    expect(await balanceOf(owner.id)).toBe(100)
  })

  it("分成向下取整：租 95 分 × 10% = 9（不是 9.5 或 10）", async () => {
    const owner = await makeUser()
    const renter = await makeUser()
    const nodeId = await seedNode(owner.id)
    const planId = await seedPlan(nodeId, 95)
    await grant(renter.id, 200)

    const res = await rent(renter, planId, `req_${uuid()}`)
    expect(res.status).toBe(200)
    expect(await balanceOf(renter.id)).toBe(105) // 200 - 95
    expect(await balanceOf(owner.id)).toBe(9) // floor(95 * 0.1)
  })

  it("分成不足 1 分（租 5 分 × 10% = 0）→ 不写流水、余额不变", async () => {
    const owner = await makeUser()
    const renter = await makeUser()
    const nodeId = await seedNode(owner.id)
    const planId = await seedPlan(nodeId, 5)
    await grant(renter.id, 100)

    const res = await rent(renter, planId, `req_${uuid()}`)
    expect(res.status).toBe(200)
    expect(await balanceOf(renter.id)).toBe(95)
    expect(await balanceOf(owner.id)).toBe(0)
  })

  it("同一 requestId 重复提交：只扣一次、也只分一次", async () => {
    const owner = await makeUser()
    const renter = await makeUser()
    const nodeId = await seedNode(owner.id)
    const planId = await seedPlan(nodeId, 100)
    await grant(renter.id, 300)

    const reqId = `req_${uuid()}`
    const first = await rent(renter, planId, reqId)
    expect(first.status).toBe(200)

    const second = await rent(renter, planId, reqId)
    // 第二次要么被判重复、要么因为"已在该节点有租约"被拒 —— 哪种都不该再动钱
    expect(second.status).toBeGreaterThanOrEqual(400)

    expect(await balanceOf(renter.id)).toBe(200) // 只扣了一次
    expect(await balanceOf(owner.id)).toBe(10) // 只分了一次
  })

  it("分成是**转移**不是增发：租用者与捐献者余额之和守恒", async () => {
    const owner = await makeUser()
    const renter = await makeUser()
    const nodeId = await seedNode(owner.id)
    const planId = await seedPlan(nodeId, 77)
    await grant(renter.id, 100)

    const before = (await balanceOf(renter.id)) + (await balanceOf(owner.id))
    const res = await rent(renter, planId, `req_${uuid()}`)
    expect(res.status).toBe(200)
    const after = (await balanceOf(renter.id)) + (await balanceOf(owner.id))

    // 只扣不增：总额必须减少恰好等于销毁的那部分（77 - floor(77*0.1) = 77 - 7 = 70）
    expect(before - after).toBe(70)
  })
})
