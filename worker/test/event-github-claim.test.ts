/**
 * GitHub star 活动：一个 GitHub 用户名**全站只能提交一次**（2026-10-04 站长要求）。
 *
 * 背景：star 名单是公开的，谁都能抄别人的名字。原先只按 (event_id, github_username)
 * 占用 —— 同一个名字可在**不同活动**里各冒领一次。现改为全局唯一
 * （migrations/0117 的 idx_event_github_username_global）。
 *
 * 本文件守住三条线：
 *   1. 同一名字被 B 用了之后，A 再用直接 403 GITHUB_ALREADY_CLAIMED；
 *   2. 同一个名字**换活动**也不能再领（全局唯一的核心）；
 *   3. 重复领取返回统一错误体（HTTP 409 + code），而不是自相矛盾的 {status:"granted"}。
 */
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { uuid } from "../src/crypto"
import { authRequest, fetchSelf, makeUser } from "./helpers"

/** 让 GitHub stargazers 接口“看起来”有这些用户名（替换全局 fetch） */
function mockGithub(logins: string[]) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.includes("api.github.com") && url.includes("/stargazers")) {
      return new Response(
        JSON.stringify(logins.map((login) => ({ login }))),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    }
    return originalFetch(input as RequestInfo, init)
  }) as typeof globalThis.fetch
  return () => {
    globalThis.fetch = originalFetch
  }
}

async function makeGithubEvent(repo: string): Promise<string> {
  const id = uuid()
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO events
       (id, title, body, status, reward_label, reward_type, reward_params,
        condition_type, condition_params, created_at, updated_at)
     VALUES (?, '点 star 领积分', '给仓库点 star', 'active', '积分',
             'points', '{"amount":50}', 'github_star', ?, ?, ?)`
  )
    .bind(id, JSON.stringify({ repo }), now, now)
    .run()
  return id
}

function claimReq(user: Awaited<ReturnType<typeof makeUser>>, eventId: string, github: string) {
  return authRequest(user, `/api/events/${eventId}/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ github }),
  })
}

describe("GitHub star：用户名全局一次性", () => {
  let restore: (() => void) | null = null
  beforeEach(() => {
    restore?.()
    restore = null
  })

  it("同一名字：B 用过后 A 再用 → 403 GITHUB_ALREADY_CLAIMED", async () => {
    const repo = `Doulor/repo-${uuid().slice(0, 6)}`
    const eventId = await makeGithubEvent(repo)
    const a = await makeUser()
    const b = await makeUser()

    restore = mockGithub(["sharedname"])
    const first = await fetchSelf(claimReq(b, eventId, "sharedname"))
    expect(first.status).toBe(200)

    const second = await fetchSelf(claimReq(a, eventId, "sharedname"))
    expect(second.status).toBe(403)
    expect((await second.json<{ code: string }>()).code).toBe("GITHUB_ALREADY_CLAIMED")
  })

  it("同一名字**跨活动**也不能再领（全局唯一）", async () => {
    const repo1 = `Doulor/r1-${uuid().slice(0, 6)}`
    const repo2 = `Doulor/r2-${uuid().slice(0, 6)}`
    const ev1 = await makeGithubEvent(repo1)
    const ev2 = await makeGithubEvent(repo2)
    const a = await makeUser()
    const b = await makeUser()

    restore = mockGithub(["crossname"])
    // B 在活动 1 用掉这个名字
    expect((await fetchSelf(claimReq(b, ev1, "crossname"))).status).toBe(200)
    // A 想在活动 2 用同一个名字 → 被全局唯一拦下
    const res = await fetchSelf(claimReq(a, ev2, "crossname"))
    expect(res.status).toBe(403)
    expect((await res.json<{ code: string }>()).code).toBe("GITHUB_ALREADY_CLAIMED")
  })

  it("重复领取返回统一错误体（409 + code），不再自相矛盾", async () => {
    const repo = `Doulor/dup-${uuid().slice(0, 6)}`
    const eventId = await makeGithubEvent(repo)
    const a = await makeUser()

    restore = mockGithub(["myname"])
    expect((await fetchSelf(claimReq(a, eventId, "myname"))).status).toBe(200)

    const again = await fetchSelf(claimReq(a, eventId, "myname"))
    expect(again.status).toBe(409)
    const body = await again.json<{ code?: string; error?: string; status?: string }>()
    expect(body.code).toBe("ALREADY_CLAIMED")
    // 关键：body 里不能再出现 status:"granted" 这种与 409 矛盾的东西
    expect(body.status).toBeUndefined()
  })
})
