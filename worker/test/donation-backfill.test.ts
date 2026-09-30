// 历史捐献积分补发（一次性工具，POST /admin/points/backfill-donations）。
//
// 锁的口径：
//   1. 默认 dryRun：只统计不写库，余额一分不动；
//   2. dryRun=false：按当前档位值逐笔发放，reason=donation；
//   3. **可重复运行**：第二次跑全部被幂等键挡下（applied=0），余额不翻倍；
//   4. 计入范围严格对齐正常发放：只认 approved 单据 / active 绑定，
//      rejected 单据、removed 绑定、认不出的 provider 一律不计；
//   5. 档位设 0 → 该笔不落账（计入 skipped）。
//
// 直接往表里插数据（不走捐献/绑定接口）：补发本就是给「接口上线前」的历史数据
// 兜底，从表结构造数据才最贴近它真实面对的输入。
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, setSetting, type TestUser } from "./helpers"
import { getPointsBalance, applyPoints } from "../src/points"
import { uuid } from "../src/crypto"

interface Report {
  dryRun: boolean
  byKind: { kind: string; label: string; count: number; points: number; total: number }[]
  totalGrants: number
  totalPoints: number
  distinctUsers: number
  applied: number
  skipped: number
}

beforeEach(async () => {
  // 补发会全表扫描这三张表；清干净，免得跨用例互相污染
  await env.DB.prepare("DELETE FROM donations").run()
  await env.DB.prepare("DELETE FROM cli2api_bindings").run()
  await env.DB.prepare("DELETE FROM wb2api_bindings").run()
  await env.DB.prepare("DELETE FROM point_transactions").run()
  await env.DB.prepare("DELETE FROM user_points").run()
})

async function insertDonation(userId: string, type: string, status = "approved"): Promise<string> {
  const id = uuid()
  await env.DB.prepare(
    `INSERT INTO donations (id, user_id, type, payload, notify_email, status, created_at)
     VALUES (?, ?, ?, '{}', 'donor@example.net', ?, ?)`
  )
    .bind(id, userId, type, status, new Date().toISOString())
    .run()
  return id
}

async function insertCli(userId: string, provider: string, status = "active"): Promise<string> {
  const id = uuid()
  await env.DB.prepare(
    `INSERT INTO cli2api_bindings
       (id, user_id, account_id, provider, region, status, created_at)
     VALUES (?, ?, ?, ?, 'global', ?, ?)`
  )
    .bind(id, userId, `acc_${id}`, provider, status, new Date().toISOString())
    .run()
  return id
}

async function insertWb(userId: string, status = "active"): Promise<string> {
  const id = uuid()
  await env.DB.prepare(
    `INSERT INTO wb2api_bindings (id, user_id, uid, status, created_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(id, userId, uuid(), status, new Date().toISOString())
    .run()
  return id
}

function backfill(admin: TestUser, body?: Record<string, unknown>): Promise<Response> {
  return fetchSelf(
    authRequest(admin, "/admin/points/backfill-donations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    })
  )
}

interface TopUpReport {
  dryRun: boolean
  multiplier: number
  entries: number
  distinctUsers: number
  totalPoints: number
  applied: number
  skipped: number
}

function topup(admin: TestUser, body?: Record<string, unknown>): Promise<Response> {
  return fetchSelf(
    authRequest(admin, "/admin/points/backfill-donations/topup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    })
  )
}

/** 造一份覆盖各种计入 / 不计入情况的样本；返回两个捐献人 */
async function seed(): Promise<{ u1: TestUser; u2: TestUser }> {
  const u1 = await makeUser()
  const u2 = await makeUser()
  // u1：proxy 单据（计 3）+ ai 单据（计 3）+ 一条 rejected（不计）+ removed 绑定（不计）
  await insertDonation(u1.id, "proxy", "approved")
  await insertDonation(u1.id, "ai", "approved")
  await insertDonation(u1.id, "proxy", "rejected")
  await insertCli(u1.id, "qoder", "removed")
  // u2：cli2api qoder 绑定（计 10）+ wb2api 绑定（计 10）+ 认不出的 provider（不计）
  await insertCli(u2.id, "qoder", "active")
  await insertWb(u2.id, "active")
  await insertCli(u2.id, "unknown_provider", "active")
  return { u1, u2 }
}

describe("历史捐献积分补发", () => {
  it("默认 dryRun：只统计不写库", async () => {
    const admin = await makeUser({ role: "admin" })
    const { u1, u2 } = await seed()

    const res = await backfill(admin) // 不传 body ⇒ 默认 dryRun
    expect(res.status).toBe(200)
    const report = (await res.json()) as Report

    expect(report.dryRun).toBe(true)
    // 4 笔计入：u1 的 proxy / ai，u2 的 qoder / workbuddy
    expect(report.totalGrants).toBe(4)
    expect(report.applied).toBe(0)
    expect(report.distinctUsers).toBe(2)
    // 默认档位：proxy 3 + ai 3 + qoder 10 + workbuddy 10 = 26
    expect(report.totalPoints).toBe(26)

    const kinds = report.byKind.map((k) => k.kind).sort()
    expect(kinds).toEqual(["ai", "proxy", "qoder", "workbuddy"].sort())

    // 预演绝不能动余额
    expect(await getPointsBalance(env, u1.id)).toBe(0)
    expect(await getPointsBalance(env, u2.id)).toBe(0)
  })

  it("dryRun=false：逐笔落账，可重复运行不翻倍", async () => {
    const admin = await makeUser({ role: "admin" })
    const { u1, u2 } = await seed()

    const first = (await (await backfill(admin, { dryRun: false })).json()) as Report
    expect(first.dryRun).toBe(false)
    expect(first.applied).toBe(4)
    expect(first.skipped).toBe(0)

    expect(await getPointsBalance(env, u1.id)).toBe(6) // proxy 3 + ai 3
    expect(await getPointsBalance(env, u2.id)).toBe(20) // qoder 10 + workbuddy 10

    const txCount = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM point_transactions WHERE reason = 'donation'"
    ).first<{ c: number }>()
    expect(txCount?.c).toBe(4)

    // 再跑一次：全部撞幂等键 ⇒ 一笔都不再发
    const second = (await (await backfill(admin, { dryRun: false })).json()) as Report
    expect(second.applied).toBe(0)
    expect(second.skipped).toBe(4)
    expect(await getPointsBalance(env, u1.id)).toBe(6)
    expect(await getPointsBalance(env, u2.id)).toBe(20)
  })

  it("档位设 0 → 该笔不落账（计入 skipped）", async () => {
    await setSetting("donation_points_ai", "0")
    const admin = await makeUser({ role: "admin" })
    const { u1 } = await seed()

    const report = (await (await backfill(admin, { dryRun: false })).json()) as Report
    // ai 那笔被跳过，其余 3 笔照发
    expect(report.applied).toBe(3)
    expect(report.skipped).toBe(1)
    // u1 只剩 proxy 的 3 分（ai 那笔没发）
    expect(await getPointsBalance(env, u1.id)).toBe(3)
  })

  it("没有历史数据 → 空报告，不报错", async () => {
    const admin = await makeUser({ role: "admin" })
    const report = (await (await backfill(admin, { dryRun: false })).json()) as Report
    expect(report.totalGrants).toBe(0)
    expect(report.totalPoints).toBe(0)
    expect(report.applied).toBe(0)
  })

  it("普通用户无权调用（403）", async () => {
    const user = await makeUser()
    const res = await backfill(user)
    expect(res.status).toBe(403)
  })
})

describe("捐献积分翻倍补差", () => {
  /** 走真实入口造一条流水（reason=donation） */
  function grant(userId: string, delta: number, detail: string, dedupKey: string) {
    return applyPoints(env, { userId, delta, reason: "donation", detail, dedupKey })
  }

  it("只补「历史补发」那批：dryRun 不写库、实跑补等额、重跑幂等", async () => {
    const admin = await makeUser({ role: "admin" })
    const u1 = await makeUser()
    const u2 = await makeUser()

    // 按**旧档位值**发出去的历史补发（带固定标记）
    await grant(u1.id, 3, "代理节点捐献奖励（历史补发）", "donation:d1")
    await grant(u1.id, 5, "AI 渠道捐献奖励（历史补发）", "donation:d2")
    await grant(u2.id, 20, "WorkBuddy 反代账号捐献奖励（历史补发）", "wb2api:b1")
    // 一条**正常发放**（不带标记）—— 绝不能被动到
    await grant(u2.id, 10, "Qoder 反代账号捐献奖励", "cli2api:c1")

    expect(await getPointsBalance(env, u1.id)).toBe(8)
    expect(await getPointsBalance(env, u2.id)).toBe(30)

    // dryRun（默认）：只统计
    const dry = (await (await topup(admin)).json()) as TopUpReport
    expect(dry.dryRun).toBe(true)
    expect(dry.multiplier).toBe(2)
    expect(dry.entries).toBe(3) // 不含那条正常发放
    expect(dry.totalPoints).toBe(28) // 3 + 5 + 20
    expect(dry.distinctUsers).toBe(2)
    expect(dry.applied).toBe(0)
    expect(await getPointsBalance(env, u1.id)).toBe(8) // 预演不动余额

    // 实跑：每笔补等额
    const real = (await (await topup(admin, { dryRun: false })).json()) as TopUpReport
    expect(real.applied).toBe(3)
    expect(await getPointsBalance(env, u1.id)).toBe(16) // 8 + 8
    expect(await getPointsBalance(env, u2.id)).toBe(50) // 30 + 20（只补 wb 那条）

    // 重跑：全部撞 `:x2` 幂等键
    const again = (await (await topup(admin, { dryRun: false })).json()) as TopUpReport
    expect(again.applied).toBe(0)
    expect(again.skipped).toBe(3)
    expect(await getPointsBalance(env, u1.id)).toBe(16)
    expect(await getPointsBalance(env, u2.id)).toBe(50)

    // 补差流水的文案要与原始补发区分开（否则下次扫描会套娃）
    const topUpTx = await env.DB.prepare(
      "SELECT detail FROM point_transactions WHERE dedup_key = 'donation:d1:x2'"
    ).first<{ detail: string }>()
    expect(topUpTx?.detail).toContain("翻倍补差")
    expect(topUpTx?.detail).not.toContain("历史补发")
  })

  it("倍数非法被拒（< 2 或 > 100）", async () => {
    const admin = await makeUser({ role: "admin" })
    for (const bad of [1, 101]) {
      const res = await topup(admin, { multiplier: bad })
      expect(res.status).toBe(400)
    }
  })

  it("普通用户无权调用（403）", async () => {
    const user = await makeUser()
    const res = await topup(user)
    expect(res.status).toBe(403)
  })
})
