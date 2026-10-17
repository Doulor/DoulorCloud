// 活动发「中转站钱包额度」：带校验的重试（2026-10-18）
//
// 背景：线上反复出现发奖失败，全是上游抖动 ——
//   · `NewAPI 设置额度失败: HTTP 502`
//   · `The operation was aborted`（客户端超时）
// 这些最终都变成了人工补发。而 `adminSetQuota(..., "add")` 是**非幂等**的（加钱），
// 盲目重试会重复发钱 —— 那比人工补发更糟。
//
// 所以策略是「失败后先读一次真实余额再决定」：
//   余额变了 → 其实已成功，不重试；余额没变 → 没落地，可安全重试；
//   读不到基准 → 一律不重试（宁可人工兜）。
// 本文件钉住这三条分支。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, setSetting } from "./helpers"
import { REWARD_HANDLERS } from "../src/event-rewards"

const BASE = "https://api.doulor.cn"
const NEWAPI_USER_ID = 582

/** manage（加额度）被调用了几次 */
let manageCalls = 0
/** 前 N 次 manage 返回 502（模拟上游抖动） */
let manageFailTimes = 0
/** 每次 manage 成功后余额是否自增（模拟真的落地） */
let quotaAfterSuccess = 500_000
/** 让 search 返回的余额随 manage 调用变化（模拟「报错但已落地」） */
let quotaOnError: number | null = null
/** search 是否失败（读不到基准值） */
let searchFails = false
let restore: (() => void) | null = null

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function stubNewApi(): void {
  const original = globalThis.fetch
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(BASE)) return original(input as RequestInfo, init)
    const method = (init?.method ?? "GET").toUpperCase()
    const path = url.slice(BASE.length)

    if (path.startsWith("/api/user/search")) {
      if (searchFails) return jsonResponse({ success: false, message: "search down" }, 500)
      // 回显请求里的 keyword：findUserByUsername 是**按用户名精确匹配**的，
      // 返回假用户名会让它返回 null，从而走不到重试分支
      const kw = new URL(url).searchParams.get("keyword") ?? ""
      // 报错分支里模拟"其实已经落地"：余额比基准值大
      const quota =
        quotaOnError !== null && manageCalls > 0 ? quotaOnError : 1_000_000
      return jsonResponse({
        success: true,
        data: [{ id: NEWAPI_USER_ID, username: kw, quota }],
      })
    }

    if (path === "/api/user/manage" && method === "POST") {
      manageCalls++
      if (manageCalls <= manageFailTimes) {
        return jsonResponse({ success: false, message: "bad gateway" }, 502)
      }
      quotaAfterSuccess += 500_000
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


/** 绑一个中转站账号（发额度的前置条件） */
async function bindRelay(userId: string, username: string): Promise<void> {
  // 必填列：newapi_user_id / username / email / enc_token / created_at
  await env.DB.prepare(
    `INSERT INTO newapi_accounts (user_id, newapi_user_id, username, email, enc_token, created_at)
     VALUES (?, ?, ?, ?, 'stub-token', ?)`
  )
    .bind(userId, NEWAPI_USER_ID, username, `${username}@doulor.cn`, new Date().toISOString())
    .run()
}

/** 发一份 ¥1 的活动奖励（= 500000 原始额度） */
async function grant(username: string, userId: string) {
  return REWARD_HANDLERS.newapi_quota({
    env,
    userId,
    username,
    params: { amount: 1 },
    eventId: "evt-test",
  })
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM newapi_accounts").run()
  await setSetting("newapi_quota_per_unit", "500000")
  manageCalls = 0
  manageFailTimes = 0
  quotaAfterSuccess = 500_000
  quotaOnError = null
  searchFails = false
  stubNewApi()
})

afterEach(() => {
  restore?.()
  restore = null
})

describe("活动发额度：带校验的重试", () => {
  it("偶发 502 → 复核余额未变 → 安全重试一次即成功", async () => {
    const u = await makeUser()
    // 绑中转站账号（发额度的前置条件）
    await bindRelay(u.id, u.username)
    manageFailTimes = 1

    const r = await grant(u.username, u.id)

    expect(manageCalls).toBe(2) // 第一次 502、第二次成功
    expect(r.status).toBe("granted")
  })

  it("报错但余额已变化（其实是响应丢了）→ 不重试，按成功处理", async () => {
    const u = await makeUser()
    await bindRelay(u.id, u.username)
    manageFailTimes = 99 // 一直报错
    quotaOnError = 1_500_000 // 但余额已经比基准的 1_000_000 多了

    const r = await grant(u.username, u.id)

    expect(manageCalls).toBe(1) // 关键：没有发第二次钱
    expect(r.status).toBe("granted")
  })

  it("读不到基准余额 → 一律不重试，直接记失败交人工", async () => {
    const u = await makeUser()
    await bindRelay(u.id, u.username)
    searchFails = true
    manageFailTimes = 99

    await expect(grant(u.username, u.id)).rejects.toBeTruthy()
    expect(manageCalls).toBe(1) // 没有冒重复发钱的风险
  })
})
