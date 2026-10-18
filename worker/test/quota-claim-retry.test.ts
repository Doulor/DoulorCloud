// 自动补发「因未开通中转站而挂起」的额度奖励（2026-10-17，用户 hsyy 反馈触发）
//
// 场景：答完问卷时还没开中转站 ⇒ newapi_quota 发不出去，领奖记录落成 manual，
// 文案是「你还未开通 AI 中转站，无法自动发放 500 钱包余额」。
// 用户往往几分钟后就开通了，但原先没有任何机制回头补发。
//
// 修复后：每小时扫一遍「文案标明因未开通挂起 + 现在已有中转站账号」的记录，
// 金额从我们自己写的文案里解析后补发。本文件钉住：
//   1. 已开通 + 文案带金额 → 补发成功、claim 变 granted
//   2. 已开通 + 文案解析不出金额 → 跳过、保持 manual（不乱发钱）
//   3. 还没开通 → 完全不碰
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser } from "./helpers"
import { retryPendingQuotaClaims } from "../src/event-rewards"

const BASE = "https://api.doulor.cn"
const NEWAPI_USER_ID = 641
const UNVERIFIED_DETAIL =
  "你还未开通 AI 中转站，无法自动发放 500 钱包余额，请联系管理员。"

let restore: (() => void) | null = null
let manageCalls = 0

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function stubNewApi(): void {
  const original = globalThis.fetch
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(BASE)) return original(input as RequestInfo, init)
    const path = url.slice(BASE.length)

    if (path.startsWith("/api/user/search")) {
      const kw = new URL(url).searchParams.get("keyword") ?? ""
      return jsonResponse({ success: true, data: [{ id: NEWAPI_USER_ID, username: kw, quota: 1000 }] })
    }
    if (path === "/api/user/manage") {
      manageCalls++
      return jsonResponse({ success: true, data: null })
    }
    if (path === "/api/status") {
      return jsonResponse({
        success: true,
        data: { quota_display_type: "CNY", quota_per_unit: 500000 },
      })
    }
    return original(input as RequestInfo, init)
  }) as typeof fetch
  globalThis.fetch = stub
  restore = () => {
    globalThis.fetch = original
  }
}

async function seedUserWithRelay(bind: boolean) {
  const u = await makeUser()
  if (bind) {
    await env.DB.prepare(
      `INSERT INTO newapi_accounts (user_id, newapi_user_id, username, email, enc_token, created_at)
       VALUES (?, ?, ?, ?, 'stub', ?)`
    )
      .bind(u.id, NEWAPI_USER_ID, u.username, `${u.username}@doulor.cn`, new Date().toISOString())
      .run()
  }
  return u
}

async function seedManualClaim(userId: string, detail: string): Promise<string> {
  const now = new Date().toISOString()
  const eventId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO events (id, title, body, status, reward_type, condition_type, created_at, updated_at)
     VALUES (?, 'e', 'b', 'active', 'newapi_quota', 'always', ?, ?)`
  )
    .bind(eventId, now, now)
    .run()
  const claimId = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO event_claims (id, event_id, user_id, reward_type, reward_status, reward_detail, claimed_at)
     VALUES (?, ?, ?, 'newapi_quota', 'manual', ?, ?)`
  )
    .bind(claimId, eventId, userId, detail, now)
    .run()
  return claimId
}

async function claimStatus(id: string): Promise<string> {
  const row = await env.DB.prepare("SELECT reward_status FROM event_claims WHERE id = ?")
    .bind(id)
    .first<{ reward_status: string }>()
  return String(row?.reward_status)
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM event_claims").run()
  await env.DB.prepare("DELETE FROM newapi_accounts").run()
  manageCalls = 0
  stubNewApi()
})

afterEach(() => {
  restore?.()
  restore = null
})

describe("补发挂起的额度奖励", () => {
  it("已开通中转站 + 文案带金额 → 补发并置为 granted", async () => {
    const u = await seedUserWithRelay(true)
    const claimId = await seedManualClaim(u.id, UNVERIFIED_DETAIL)

    const r = await retryPendingQuotaClaims(env)

    expect(r.granted).toBe(1)
    expect(manageCalls).toBe(1)
    expect(await claimStatus(claimId)).toBe("granted")
  })

  it("文案里解析不出金额 → 跳过，保持 manual（不能乱发钱）", async () => {
    const u = await seedUserWithRelay(true)
    const claimId = await seedManualClaim(u.id, "你还未开通 AI 中转站，请联系管理员。")

    const r = await retryPendingQuotaClaims(env)

    expect(r.granted).toBe(0)
    expect(manageCalls).toBe(0)
    expect(await claimStatus(claimId)).toBe("manual")
  })

  it("还没开通中转站的用户 → 完全不碰", async () => {
    const u = await seedUserWithRelay(false)
    const claimId = await seedManualClaim(u.id, UNVERIFIED_DETAIL)

    const r = await retryPendingQuotaClaims(env)

    expect(r.granted).toBe(0)
    expect(manageCalls).toBe(0)
    expect(await claimStatus(claimId)).toBe("manual")
  })
})
