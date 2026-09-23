// 管理面板「中转站」标签：管理员凭据（系统访问令牌）在网页上更新。
//
// 背景：NewAPI 后台每次生成系统访问令牌都会覆盖旧值，旧令牌立即失效，
// 本站所有管理员级调用随之 401。此前只能重跑 wrangler secret put；
// 现在允许在管理面板粘贴新令牌，先真实验证再加密落库（覆盖 env）。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf } from "./helpers"
import { resetAdminCredentialCache } from "../src/newapi-client"

const BASE = "https://api.doulor.cn"

/**
 * 打桩 Worker 的出站 fetch：只有发往 NewAPI 的请求被接管，
 * 其余（含 SELF.fetch 内部的同源调用）原样透传。
 */
function stubNewApi(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>
): () => void {
  const original = globalThis.fetch
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    if (url.startsWith(BASE)) return handler(url, init)
    return original(input as RequestInfo, init)
  }) as unknown as typeof fetch
  globalThis.fetch = stub
  return () => {
    globalThis.fetch = original
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

let restore: (() => void) | null = null

beforeEach(() => {
  // 凭据走 5 秒内存缓存，且测试共用同一 isolate —— 每个用例都从干净状态开始
  resetAdminCredentialCache()
})

afterEach(() => {
  restore?.()
  restore = null
  resetAdminCredentialCache()
  vi.restoreAllMocks()
})

describe("GET /api/admin/newapi/config", () => {
  it("普通用户被拒（403）", async () => {
    const u = await makeUser()
    const res = await fetchSelf(authRequest(u, "/api/admin/newapi/config"))
    expect(res.status).toBe(403)
  })

  it("返回当前来源与掩码，不下发明文", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await fetchSelf(authRequest(admin, "/api/admin/newapi/config"))
    expect(res.status).toBe(200)
    const data = await res.json<{
      maskedToken: string | null
      source: string
      configured: boolean
      adminUserId: string
      baseUrl: string | null
    }>()
    expect(data.source).toBe("env")
    expect(data.configured).toBe(true)
    expect(data.baseUrl).toBe(BASE)
    // 掩码形如 abcd********wxyz，且不含完整令牌
    expect(data.maskedToken).toMatch(/^\S{4}\*{8}\S{4}$/)
    expect(JSON.stringify(data)).not.toContain(env.NEWAPI_ADMIN_TOKEN!)
  })
})

describe("PUT /api/admin/newapi/config", () => {
  it("令牌验证失败时不落库、不改来源（400）", async () => {
    const admin = await makeUser({ role: "admin" })
    restore = stubNewApi(() =>
      jsonResponse({ success: false, message: "Unauthorized, invalid access token" })
    )

    const res = await fetchSelf(
      authRequest(admin, "/api/admin/newapi/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "bad-token-12345678", adminUserId: "1" }),
      })
    )
    expect(res.status).toBe(400)
    const body = await res.json<{ ok: boolean; error: string }>()
    expect(body.ok).toBe(false)
    expect(body.error).toContain("invalid access token")

    // 库里不应有任何行；来源仍为 env
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM newapi_admin_credentials"
    ).first<{ c: number }>()
    expect(row?.c).toBe(0)
  })

  it("验证通过后加密落库并立即生效（来源转为 db）", async () => {
    const admin = await makeUser({ role: "admin" })
    let seenAuth: string | null = null
    let seenUser: string | null = null
    restore = stubNewApi((_url, init) => {
      const h = new Headers(init?.headers)
      seenAuth = h.get("Authorization")
      seenUser = h.get("New-Api-User")
      return jsonResponse({ success: true, message: "", data: [] })
    })

    const token = "new-admin-token-abcdefgh"
    const res = await fetchSelf(
      authRequest(admin, "/api/admin/newapi/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, adminUserId: "7" }),
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json<{ ok: boolean; source: string; maskedToken: string }>()
    expect(body.ok).toBe(true)
    expect(body.source).toBe("db")

    // 验证请求确实带上了待验证的令牌与用户 id
    expect(seenAuth).toBe(`Bearer ${token}`)
    expect(seenUser).toBe("7")

    // 明文不落库（存的是 v1:iv:ct 密文）
    const row = await env.DB.prepare(
      "SELECT enc_token, admin_user_id FROM newapi_admin_credentials WHERE id = 1"
    ).first<{ enc_token: string; admin_user_id: string }>()
    expect(row?.enc_token.startsWith("v1:")).toBe(true)
    expect(row?.enc_token).not.toContain(token)
    expect(row?.admin_user_id).toBe("7")

    // 后续调用改用库内凭据（缓存已失效）
    const after = await fetchSelf(authRequest(admin, "/api/admin/newapi/config"))
    const info = await after.json<{ source: string; adminUserId: string; maskedToken: string }>()
    expect(info.source).toBe("db")
    expect(info.adminUserId).toBe("7")
    expect(info.maskedToken).toBe(`new-${"*".repeat(8)}efgh`)
  })

  it("空令牌被拒（400）", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await fetchSelf(
      authRequest(admin, "/api/admin/newapi/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "   " }),
      })
    )
    expect(res.status).toBe(400)
  })

  it("非数字用户 id 被拒（400，且不发起出站请求）", async () => {
    const admin = await makeUser({ role: "admin" })
    const spy = vi.fn(() => jsonResponse({ success: true }))
    restore = stubNewApi(spy)

    const res = await fetchSelf(
      authRequest(admin, "/api/admin/newapi/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "some-token-12345678", adminUserId: "abc" }),
      })
    )
    expect(res.status).toBe(400)
    expect(spy).not.toHaveBeenCalled()
  })
})
