/**
 * 修改真实邮箱：验证必须归属到「用户能收这封邮件」。
 *
 * 背景（2026-10-04 审计）：
 *   `changeRealEmail` 原先调用 `cfEnsureDestination` + `destinationStatus`，
 *   采信 Cloudflare Email Routing 的 `verified`。那是**账户级**状态 ——
 *   账户里历史遗留（或别人验证过）的已验证地址会被当成「已验证」，
 *   把用户的 `email_verified` 置 1，而该用户从未能读取那个邮箱。
 *   现在改为「把 6 位验证码发到新邮箱、用户回填」的用户专属流程。
 *
 * 本文件守住三条线：
 *   1. 不再读 Cloudflare 的账户级 destination 状态；
 *   2. 码必须绑定到「这次要改成的那个地址」；
 *   3. 只有回填正确验证码才真正落库（错误码拒绝并计次）。
 */
import { describe, expect, it } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser } from "./helpers"
import { hashToken } from "../src/crypto"

function put(body: unknown): RequestInit {
  return {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }
}

async function seedChangeCode(userId: string, email: string, code: string, opts?: { expiresInMs?: number; attempts?: number }) {
  const now = new Date().toISOString()
  const expiresAt = new Date(Date.now() + (opts?.expiresInMs ?? 10 * 60_000)).toISOString()
  await env.DB.prepare(
    `INSERT INTO email_change_codes (user_id, email, code_hash, expires_at, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, code_hash = excluded.code_hash,
       expires_at = excluded.expires_at, attempts = excluded.attempts, created_at = excluded.created_at`
  )
    .bind(userId, email.toLowerCase(), await hashToken(code), expiresAt, opts?.attempts ?? 0, now)
    .run()
}

async function userRow(id: string) {
  return env.DB.prepare("SELECT email, email_verified FROM users WHERE id = ?")
    .bind(id)
    .first<{ email: string; email_verified: number }>()
}

/** 让 Cloudflare 侧「看起来」存在一个已验证的同名 destination —— 旧实现会据此放行 */
function mockCloudflareVerifiedDestination(email: string, calls: string[]) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.includes("api.cloudflare.com")) {
      calls.push(url)
      return new Response(
        JSON.stringify({
          success: true,
          result: [{ id: "legacy-dest", email, verified: "2026-01-01T00:00:00Z" }],
          result_info: { total_pages: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    }
    return originalFetch(input as RequestInfo, init)
  }) as typeof globalThis.fetch
  return () => {
    globalThis.fetch = originalFetch
  }
}

describe("修改真实邮箱：不再采信 Cloudflare 账户级验证", () => {
  it("即便账户里存在已验证的同名 destination，没走过验证码也拒绝，且不调 Cloudflare", async () => {
    const u = await makeUser({ emailVerified: false })
    const target = `new_${u.username}@example.com`
    const calls: string[] = []
    const restore = mockCloudflareVerifiedDestination(target, calls)
    try {
      const res = await fetchSelf(
        authRequest(
          u,
          "/api/settings/email",
          put({ email: target, password: "pass1234", action: "confirm", code: "123456" })
        )
      )
      expect(res.status).toBe(400)
      expect((await res.json<{ code?: string }>()).code).toBe("CODE_NOT_REQUESTED")

      // 邮箱与验证状态都不该变
      const row = await userRow(u.id)
      expect(row?.email).not.toBe(target)
      expect(row?.email_verified).toBe(0)
      // 关键：整条路径没有再咨询 Cloudflare 的账户级状态
      expect(calls).toEqual([])
    } finally {
      restore()
    }
  })

  it("验证码必须绑定到这次要改成的地址：对 A 取码、拿 B 来换会被拒", async () => {
    const u = await makeUser({ emailVerified: false })
    await seedChangeCode(u.id, `a_${u.username}@example.com`, "654321")

    const res = await fetchSelf(
      authRequest(
        u,
        "/api/settings/email",
        put({ email: `b_${u.username}@example.com`, password: "pass1234", action: "confirm", code: "654321" })
      )
    )
    expect(res.status).toBe(400)
    expect((await res.json<{ code?: string }>()).code).toBe("CODE_NOT_REQUESTED")
    expect((await userRow(u.id))?.email_verified).toBe(0)
  })

  it("验证码正确 → 落库并置 email_verified=1，且消费掉验证码", async () => {
    const u = await makeUser({ emailVerified: false })
    const target = `ok_${u.username}@example.com`
    await seedChangeCode(u.id, target, "111222")

    const res = await fetchSelf(
      authRequest(
        u,
        "/api/settings/email",
        put({ email: target, password: "pass1234", action: "confirm", code: "111222" })
      )
    )
    expect(res.status).toBe(200)

    const row = await userRow(u.id)
    expect(row?.email).toBe(target)
    expect(row?.email_verified).toBe(1)

    const left = await env.DB.prepare("SELECT COUNT(*) AS c FROM email_change_codes WHERE user_id = ?")
      .bind(u.id)
      .first<{ c: number }>()
    expect(left?.c).toBe(0)
  })

  it("验证码错误 → 拒绝并累加尝试次数，邮箱不变", async () => {
    const u = await makeUser({ emailVerified: false })
    const target = `bad_${u.username}@example.com`
    await seedChangeCode(u.id, target, "999888")

    const res = await fetchSelf(
      authRequest(
        u,
        "/api/settings/email",
        put({ email: target, password: "pass1234", action: "confirm", code: "000000" })
      )
    )
    expect(res.status).toBe(400)
    expect((await res.json<{ code?: string }>()).code).toBe("INVALID_CODE")

    const row = await env.DB.prepare(
      "SELECT attempts FROM email_change_codes WHERE user_id = ?"
    )
      .bind(u.id)
      .first<{ attempts: number }>()
    expect(row?.attempts).toBe(1)
    expect((await userRow(u.id))?.email).not.toBe(target)
  })

  it("过期的验证码 → 拒绝", async () => {
    const u = await makeUser({ emailVerified: false })
    const target = `exp_${u.username}@example.com`
    await seedChangeCode(u.id, target, "333444", { expiresInMs: -1000 })

    const res = await fetchSelf(
      authRequest(
        u,
        "/api/settings/email",
        put({ email: target, password: "pass1234", action: "confirm", code: "333444" })
      )
    )
    expect(res.status).toBe(400)
    expect((await res.json<{ code?: string }>()).code).toBe("CODE_EXPIRED")
  })
})
