/**
 * 入驻前置检测：OIDC 必须已配好且指向本站（2026-10-12 站长要求）。
 *
 * 这里用**桩 fetch** 模拟对方站的回答（不连真站），锁住三件容易写错的事：
 *   · OIDC 指向别人的 IdP 时**不能**放行（否则用户在他那台站根本没有账号）；
 *   · 开关没开 / 缺 Client ID / 缺端点，都要给出**指明缺什么**的提示；
 *   · Sub2API 走的是「打它的 OIDC 登录入口看往哪跳」，不能照抄 NewAPI 的读法。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { env } from "cloudflare:workers"
import { checkRelayOidc } from "../src/relay-adapters"

const BASE = "https://relay.example.com"

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

/** NewAPI 的 `/api/option/` 响应：给一组 oidc.* 选项 */
function newApiOptions(oidc: Record<string, string>): Response {
  const data = Object.entries(oidc).map(([k, v]) => ({ key: k, value: v }))
  return jsonResponse({ success: true, message: "", data })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("入驻前置 · OIDC 自动检测", () => {
  it("NewAPI：OIDC 已开且指向本站 ⇒ 通过", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        newApiOptions({
          "oidc.enabled": "true",
          "oidc.client_id": "abc123",
          "oidc.authorization_endpoint": "https://cloud.doulor.cn/api/oauth/authorize",
          "oidc.token_endpoint": "https://cloud.doulor.cn/api/oauth/token",
        })
      )
    )
    const res = await checkRelayOidc(env, "newapi", BASE, "admin-token-123456")
    expect(res.ok).toBe(true)
    expect(res.idpHost).toContain("cloud.doulor.cn")
  })

  it("NewAPI：OIDC 指向别人的 IdP ⇒ 拒绝且说清指向了谁", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        newApiOptions({
          "oidc.enabled": "true",
          "oidc.client_id": "abc123",
          "oidc.authorization_endpoint": "https://connect.linux.do/oauth2/authorize",
          "oidc.token_endpoint": "https://connect.linux.do/oauth2/token",
        })
      )
    )
    const res = await checkRelayOidc(env, "newapi", BASE, "admin-token-123456")
    expect(res.ok).toBe(false)
    expect(res.detail).toContain("connect.linux.do")
  })

  it("NewAPI：开关没开 / 缺 Client ID，提示各自不同", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => newApiOptions({ "oidc.enabled": "false" })))
    const off = await checkRelayOidc(env, "newapi", BASE, "admin-token-123456")
    expect(off.ok).toBe(false)
    expect(off.detail).toContain("还没开启")

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        newApiOptions({
          "oidc.enabled": "true",
          "oidc.authorization_endpoint": "https://cloud.doulor.cn/api/oauth/authorize",
        })
      )
    )
    const noId = await checkRelayOidc(env, "newapi", BASE, "admin-token-123456")
    expect(noId.ok).toBe(false)
    expect(noId.detail).toContain("Client ID")
  })

  it("Sub2API：登录入口把我们当 IdP（302 指向本站）⇒ 通过", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://cloud.doulor.cn/api/oauth/authorize?client_id=x" },
          })
      )
    )
    const res = await checkRelayOidc(env, "sub2api", BASE, "admin-token-123456")
    expect(res.ok).toBe(true)
  })

  it("Sub2API：POST 回 JSON 的 authorize_url（真实形态）⇒ 通过", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        // 它的 start 接口：POST 回 JSON、GET 才 302
        if (init?.method === "POST") {
          return jsonResponse({
            code: 0,
            message: "success",
            data: { authorize_url: "https://cloud.doulor.cn/api/oauth/authorize?client_id=abc" },
          })
        }
        return new Response(null, { status: 302, headers: { location: "https://elsewhere.tld/x" } })
      })
    )
    const res = await checkRelayOidc(env, "sub2api", BASE, "admin-token-123456")
    expect(res.ok).toBe(true)
    expect(res.verified).toBe(true)
  })

  it("Sub2API：对方开了登录验证码 ⇒ 放行但标记「未验证」（linhuai 那次误判就是这里）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ code: 400, message: "captcha verification is required" }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
      )
    )
    const res = await checkRelayOidc(env, "sub2api", BASE, "admin-token-123456")
    // 🔴 关键：不能因为「我们读不到」就判定对方没配 OIDC
    expect(res.ok).toBe(true)
    expect(res.verified).toBe(false)
    expect(res.detail).toContain("验证码")
  })

  it("NewAPI：选项接口读不到 ⇒ 也是「未验证」放行，而不是拒绝", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })))
    const res = await checkRelayOidc(env, "newapi", BASE, "admin-token-123456")
    expect(res.ok).toBe(true)
    expect(res.verified).toBe(false)
  })

  it("Sub2API：跳去别的 IdP ⇒ 拒绝；老版本没有该入口（404）⇒ 提示升级", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://github.com/login/oauth/authorize" },
          })
      )
    )
    const other = await checkRelayOidc(env, "sub2api", BASE, "admin-token-123456")
    expect(other.ok).toBe(false)
    expect(other.detail).toContain("github.com")

    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })))
    const old = await checkRelayOidc(env, "sub2api", BASE, "admin-token-123456")
    expect(old.ok).toBe(false)
    expect(old.detail).toContain("不支持")
  })
})
