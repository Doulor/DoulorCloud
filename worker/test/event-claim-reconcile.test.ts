// 活动领奖「发放中」兜底收敛（2026-10-17）
//
// 背景（线上真实案例）：领奖是「先写 pending 占位 → 发放 → 回写状态」。
// 发放失败会删掉占位让用户重试，但 Worker 中途被掐断（超时/崩溃/部署滚动）时
// 占位会永久卡在 pending —— 用户以为"发放中"，其实什么都没发。
// 线上曾出现同一人 3 条、最长卡 7 天（kaizerfx）。
//
// 兜底策略：超过 30 分钟仍是 pending 的，标成 failed + 写清原因，
// 让它出现在管理端「领取名单」里由人核对后走「人工发放」。
// ⚠️ 刻意**不自动补发**：原发放可能已经成功，自动重试会重复发。
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser } from "./helpers"
import { reconcileStaleClaims } from "../src/handlers/events"

/** 造一条指定状态、指定「多少分钟前领取」的领奖记录 */
async function seedClaim(userId: string, status: string, minutesAgo: number): Promise<string> {
  const now = new Date().toISOString()
  const eventId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO events (id, title, body, status, reward_type, condition_type, created_at, updated_at)
     VALUES (?, 'e', 'b', 'active', 'points', 'always', ?, ?)`
  )
    .bind(eventId, now, now)
    .run()
  const claimId = crypto.randomUUID()
  const claimedAt = new Date(Date.now() - minutesAgo * 60_000).toISOString()
  await env.DB.prepare(
    `INSERT INTO event_claims (id, event_id, user_id, reward_type, reward_status, reward_detail, claimed_at)
     VALUES (?, ?, ?, 'points', ?, '', ?)`
  )
    .bind(claimId, eventId, userId, status, claimedAt)
    .run()
  return claimId
}

async function readClaim(id: string) {
  const row = await env.DB.prepare(
    "SELECT reward_status, reward_detail FROM event_claims WHERE id = ?"
  )
    .bind(id)
    .first<{ reward_status: string; reward_detail: string | null }>()
  expect(row).not.toBeNull()
  return row!
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM event_claims").run()
})

describe("活动领奖：卡住的「发放中」兜底收敛", () => {
  it("超过 30 分钟仍 pending → 标成 failed 并写清原因", async () => {
    const u = await makeUser()
    const id = await seedClaim(u.id, "pending", 40)

    const r = await reconcileStaleClaims(env)

    expect(r.swept).toBe(1)
    const claim = await readClaim(id)
    expect(claim.reward_status).toBe("failed")
    expect(String(claim.reward_detail)).toContain("中断")
  })

  it("刚发放（5 分钟）的不动 —— 不误伤正在进行的发放", async () => {
    const u = await makeUser()
    const id = await seedClaim(u.id, "pending", 5)

    const r = await reconcileStaleClaims(env)

    expect(r.swept).toBe(0)
    expect((await readClaim(id)).reward_status).toBe("pending")
  })

  it("已发放 / 人工发放的记录完全不动", async () => {
    const u = await makeUser()
    const granted = await seedClaim(u.id, "granted", 40)
    const manual = await seedClaim(u.id, "manual", 40)

    const r = await reconcileStaleClaims(env)

    expect(r.swept).toBe(0)
    expect((await readClaim(granted)).reward_status).toBe("granted")
    expect((await readClaim(manual)).reward_status).toBe("manual")
  })
})
