// 管理员手动发放订阅（2026-10-10 站长要求）：按用户名批量给用户开 NewAPI 订阅。
//
// 站长要的是「填一串用户名 + 订阅 ID + 份数 → 直接发」。这里钉两件事：
//   ① **先校验、再动手** —— 用户名不存在 / 用户没开通中转站时，一个订阅都不许发
//      （批量操作的「部分成功」最难收尾，管理员没法一眼看出谁成了谁没成）；
//   ② 发放口径 —— 每人 `count` 份、逐份真调上游、失败如实回报（不吞）。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, type TestUser } from "./helpers"
import { resetAdminCredentialCache } from "../src/newapi-client"

const BASE = "https://api.doulor.cn"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

interface SubCall {
  newapiUserId: number
  planId: number
}

let subCalls: SubCall[] = []
/** 让上游对指定 newapi 用户报错（模拟套餐不存在 / 撞限购） */
let failForUser: number | null = null
let restore: (() => void) | null = null

/** 打桩出站 fetch：只接管发往 NewAPI 的订阅发放，其余透传 */
function stubNewApi(): void {
  const original = globalThis.fetch
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(BASE)) return original(input as RequestInfo, init)

    const m = url.match(/\/api\/subscription\/admin\/users\/(\d+)\/subscriptions/)
    if (m) {
      const newapiUserId = Number(m[1])
      if (failForUser === newapiUserId) {
        return jsonResponse({ success: false, message: "该套餐已达购买上限" }, 400)
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { plan_id: number }
      subCalls.push({ newapiUserId, planId: body.plan_id })
      return jsonResponse({ success: true, data: { message: "" } })
    }
    // 其余（/api/status 之类）给空成功体，够链路跑完
    return jsonResponse({ success: true, message: "", data: null })
  }) as unknown as typeof fetch
  globalThis.fetch = stub
  restore = () => {
    globalThis.fetch = original
  }
}

/** 逐用例递增绑号：newapi_user_id 有 UNIQUE 约束，而 D1 实例在用例间共享 */
let newapiSeq = 100
async function makeBoundUser(): Promise<{ user: TestUser; newapiUserId: number }> {
  const user = await makeUser()
  const newapiUserId = ++newapiSeq
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO newapi_accounts
       (user_id, newapi_user_id, username, email, enc_token, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(user.id, newapiUserId, `na_${newapiUserId}`, `na_${newapiUserId}@doulor.cn`, "enc", now)
    .run()
  return { user, newapiUserId }
}

/** superadmin 走 isPrivileged 直通，不必再配权限组 */
async function makeAdmin(): Promise<TestUser> {
  return makeUser({ role: "superadmin" })
}

async function grant(admin: TestUser, payload: unknown) {
  const res = await fetchSelf(
    authRequest(admin, "/admin/newapi/grant-subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

interface ResultRow {
  username: string
  ok: boolean
  granted: number
  message: string
}

beforeEach(() => {
  subCalls = []
  failForUser = null
  resetAdminCredentialCache()
})

afterEach(() => {
  restore?.()
  restore = null
})

describe("POST /admin/newapi/grant-subscriptions", () => {
  it("正常发放：多人 × 多份，逐份真调上游，指定 newapi 用户与套餐", async () => {
    stubNewApi()
    const admin = await makeAdmin()
    const a = await makeBoundUser()
    const b = await makeBoundUser()

    const { status, body } = await grant(admin, {
      usernames: `${a.user.username}\n${b.user.username}`,
      planId: 4,
      count: 2,
    })

    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.granted).toBe(4)
    expect(body.users).toBe(2)
    // 每人 2 份 ⇒ 共 4 次上游调用，且打到正确的 newapi 用户、正确的套餐
    expect(subCalls).toHaveLength(4)
    expect(subCalls.filter((c) => c.newapiUserId === a.newapiUserId)).toHaveLength(2)
    expect(subCalls.filter((c) => c.newapiUserId === b.newapiUserId)).toHaveLength(2)
    expect(subCalls.every((c) => c.planId === 4)).toBe(true)

    const results = body.results as ResultRow[]
    expect(results.map((r) => [r.username, r.granted, r.ok])).toEqual([
      [a.user.username, 2, true],
      [b.user.username, 2, true],
    ])
  })

  it("用户名支持换行 / 逗号 / 空格混合，且忽略大小写去重", async () => {
    stubNewApi()
    const admin = await makeAdmin()
    const a = await makeBoundUser()

    const { body } = await grant(admin, {
      usernames: `${a.user.username}, ${a.user.username.toUpperCase()}\n  ${a.user.username}  `,
      planId: 1,
      count: 1,
    })

    expect(body.users).toBe(1)
    expect(body.granted).toBe(1)
    expect(subCalls).toHaveLength(1)
  })

  it("有用户名不存在 → 404，且**一个订阅都不发**（零副作用）", async () => {
    stubNewApi()
    const admin = await makeAdmin()
    const a = await makeBoundUser()

    const { status, body } = await grant(admin, {
      usernames: `${a.user.username}\nno-such-user-xyz`,
      planId: 4,
      count: 1,
    })

    expect(status).toBe(404)
    expect(String(body.error)).toContain("no-such-user-xyz")
    expect(subCalls).toHaveLength(0)
  })

  it("用户存在但没开通中转站 → 409，同样零副作用", async () => {
    stubNewApi()
    const admin = await makeAdmin()
    const bound = await makeBoundUser()
    const unbound = await makeUser()

    const { status, body } = await grant(admin, {
      usernames: `${bound.user.username}\n${unbound.username}`,
      planId: 4,
      count: 1,
    })

    expect(status).toBe(409)
    expect(String(body.error)).toContain(unbound.username)
    expect(subCalls).toHaveLength(0)
  })

  it("上游失败如实回报：那人 0 份 + 原因，其他人照常发满", async () => {
    stubNewApi()
    const admin = await makeAdmin()
    const okUser = await makeBoundUser()
    const badUser = await makeBoundUser()
    failForUser = badUser.newapiUserId

    const { body } = await grant(admin, {
      usernames: `${okUser.user.username}\n${badUser.user.username}`,
      planId: 4,
      count: 1,
    })

    expect(body.ok).toBe(false)
    const results = body.results as ResultRow[]
    const okRow = results.find((r) => r.username === okUser.user.username)!
    const badRow = results.find((r) => r.username === badUser.user.username)!
    expect([okRow.ok, okRow.granted]).toEqual([true, 1])
    expect([badRow.ok, badRow.granted]).toEqual([false, 0])
    expect(badRow.message).toContain("购买上限")
    // 失败的没重复试：只调了成功那一人一次
    expect(subCalls).toHaveLength(1)
  })

  it("参数校验：空用户名 / 非法 ID / 越界份数 / 超人数都 400，且一次上游都不调", async () => {
    stubNewApi()
    const admin = await makeAdmin()
    const a = await makeBoundUser()
    const cases: { payload: unknown; hint: string }[] = [
      { payload: { usernames: "  \n  ", planId: 4, count: 1 }, hint: "空用户名" },
      { payload: { usernames: a.user.username, planId: 0, count: 1 }, hint: "ID = 0" },
      { payload: { usernames: a.user.username, planId: "x", count: 1 }, hint: "ID 非数字" },
      { payload: { usernames: a.user.username, planId: 4, count: 0 }, hint: "份数 0" },
      { payload: { usernames: a.user.username, planId: 4, count: 11 }, hint: "份数超上限" },
      {
        payload: {
          usernames: Array.from({ length: 51 }, (_, i) => `u${i}`).join("\n"),
          planId: 4,
          count: 1,
        },
        hint: "人数超上限",
      },
    ]
    for (const c of cases) {
      const { status } = await grant(admin, c.payload)
      expect(status, `${c.hint} 应为 400`).toBe(400)
    }
    expect(subCalls).toHaveLength(0)
  })

  it("人数 × 份数 超总量上限 → 400（防止一次把上游调用预算打满）", async () => {
    stubNewApi()
    const admin = await makeAdmin()
    // 50 人 × 10 份 = 500 > 100（MAX_GRANT_TOTAL）
    const many = Array.from({ length: 50 }, (_, i) => `fake_user_${i}`)
    const { status, body } = await grant(admin, { usernames: many.join("\n"), planId: 4, count: 10 })
    expect(status).toBe(400)
    expect(String(body.error)).toContain("上限")
    expect(subCalls).toHaveLength(0)
  })

  it("非管理员 403，且不发", async () => {
    stubNewApi()
    const plain = await makeUser()
    const { status } = await grant(plain, { usernames: "whoever", planId: 4, count: 1 })
    expect(status).toBe(403)
    expect(subCalls).toHaveLength(0)
  })

  it("发放成功会写审计，且记在**目标用户**名下（detail 写明是谁发的）", async () => {
    stubNewApi()
    const admin = await makeAdmin()
    const a = await makeBoundUser()

    await grant(admin, { usernames: a.user.username, planId: 4, count: 2 })

    const row = await env.DB.prepare(
      `SELECT detail FROM audit_logs
        WHERE user_id = ? AND action = 'newapi.subscription.grant'
        ORDER BY created_at DESC LIMIT 1`
    )
      .bind(a.user.id)
      .first<{ detail: string }>()
    expect(row).not.toBeNull()
    expect(row!.detail).toContain(admin.username)
    expect(row!.detail).toContain("2/2")
  })
})
