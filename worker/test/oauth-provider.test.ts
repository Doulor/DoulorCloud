/**
 * OAuth 2.0 授权服务器测试（Doulor Cloud 作为身份提供方）。
 *
 * 覆盖两条线：
 *   1. 正常流程：建应用 → 授权 → 换 token → 取用户信息（NewAPI 走的就是这条）
 *   2. 安全边界：回调地址校验、授权码重放、密钥错误、跨 client 兑换、
 *      未登录、被停用、撤销授权 —— 这些是 OAuth 最容易出事的地方
 */
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, type TestUser } from "./helpers"

const BASE = "https://cloud.doulor.cn"

/** 以管理员身份建一个 OAuth 应用，返回凭证 */
async function makeClient(
  admin: TestUser,
  overrides: { name?: string; redirectUris?: string[]; scopes?: string } = {}
): Promise<{ id: string; clientId: string; clientSecret: string }> {
  const res = await fetchSelf(
    authRequest(admin, "/api/admin/oauth/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: overrides.name ?? "测试应用",
        redirectUris: overrides.redirectUris ?? ["https://client.example.com/oauth/callback"],
        scopes: overrides.scopes ?? "openid profile email",
      }),
    })
  )
  expect(res.status).toBe(201)
  const body = await res.json<{
    client: { id: string; clientId: string }
    clientSecret: string
  }>()
  return { id: body.client.id, clientId: body.client.clientId, clientSecret: body.clientSecret }
}

/** 走完一次授权，返回同意页给出的一次性 code */
async function obtainCode(
  user: TestUser,
  clientId: string,
  redirectUri: string,
  scope = "openid profile email"
): Promise<string> {
  const url = `/api/oauth/authorize/decision`
  const res = await fetchSelf(
    authRequest(user, url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        approve: true,
        client_id: clientId,
        redirect_uri: redirectUri,
        scope,
        state: "test-state",
        response_type: "code",
      }),
    })
  )
  expect(res.status).toBe(200)
  const { redirectTo } = await res.json<{ redirectTo: string }>()
  const code = new URL(redirectTo).searchParams.get("code")
  expect(code).toBeTruthy()
  return code as string
}

/** 用 code 换 access_token（模拟对方服务器，不带 cookie） */
async function exchangeToken(params: Record<string, string>): Promise<Response> {
  return fetchSelf(
    new Request(`${BASE}/api/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    })
  )
}

describe("OIDC 发现文档", () => {
  it("返回合法的 JSON，且端点都在 /api 下", async () => {
    const res = await fetchSelf(new Request(`${BASE}/api/.well-known/openid-configuration`))
    expect(res.status).toBe(200)
    const doc = await res.json<Record<string, unknown>>()

    // issuer 必须带 /api —— 根级 /oauth/* 会落到静态 Worker 被 SPA 兜底
    expect(doc.issuer).toBe(`${BASE}/api`)
    expect(doc.authorization_endpoint).toBe(`${BASE}/api/oauth/authorize`)
    expect(doc.token_endpoint).toBe(`${BASE}/api/oauth/token`)
    expect(doc.userinfo_endpoint).toBe(`${BASE}/api/oauth/userinfo`)
    expect(doc.response_types_supported).toEqual(["code"])
    expect(doc.scopes_supported).toContain("openid")
  })

  it("不需要登录即可访问（对方在接入前就要能拉到）", async () => {
    const res = await fetchSelf(new Request(`${BASE}/api/.well-known/openid-configuration`))
    expect(res.status).toBe(200)
  })

  it("不提供 jwks_uri（一期没有签名密钥，如实不填，避免对方拉到一个 404）", async () => {
    const res = await fetchSelf(new Request(`${BASE}/api/.well-known/openid-configuration`))
    const doc = await res.json<Record<string, unknown>>()
    expect(doc.jwks_uri).toBeUndefined()
  })

  /**
   * ⚠️ 回归测试：必须带 CORS 头。
   *
   * NewAPI 的「自动发现」是**浏览器**发起 fetch 的。少了这个头，浏览器会拦掉响应，
   * 界面报「获取 OIDC 配置失败。请检查 URL 和网络状态」，
   * 而服务端/curl 请求完全正常 —— 排查成本很高，所以用测试钉住。
   */
  it("带 CORS 响应头（否则 NewAPI 的浏览器端自动发现会失败）", async () => {
    const res = await fetchSelf(
      new Request(`${BASE}/api/.well-known/openid-configuration`, {
        headers: { Origin: "https://api.doulor.cn" },
      })
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*")
    // 顺便确认加了这个头之后内容没坏
    const doc = await res.json<Record<string, unknown>>()
    expect(doc.issuer).toBe(`${BASE}/api`)
  })
})

describe("管理端：应用管理", () => {
  it("管理员可以创建应用，明文密钥只在创建时返回一次", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await fetchSelf(
      authRequest(admin, "/api/admin/oauth/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "NewAPI",
          redirectUris: ["https://api.example.com/oauth/oidc"],
        }),
      })
    )
    expect(res.status).toBe(201)
    const body = await res.json<{ client: Record<string, unknown>; clientSecret: string }>()
    expect(body.clientSecret).toMatch(/^dcs_/)
    expect(body.client.clientId).toMatch(/^dc_/)
    // 列表接口绝不能带出密钥相关字段
    expect(body.client).not.toHaveProperty("clientSecretHash")
    expect(body.client).not.toHaveProperty("client_secret_hash")
    expect(JSON.stringify(body.client)).not.toContain(body.clientSecret)
  })

  it("普通用户不能创建应用（403）", async () => {
    const user = await makeUser()
    const res = await fetchSelf(
      authRequest(user, "/api/admin/oauth/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x", redirectUris: ["https://a.com/cb"] }),
      })
    )
    expect(res.status).toBe(403)
  })

  it("拒绝非 https 的回调地址（防明文泄露授权码）", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await fetchSelf(
      authRequest(admin, "/api/admin/oauth/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x", redirectUris: ["http://evil.example.com/cb"] }),
      })
    )
    expect(res.status).toBe(400)
  })

  it("未登录不能访问管理接口", async () => {
    const res = await fetchSelf(
      new Request(`${BASE}/api/admin/oauth/clients`, { method: "GET" })
    )
    expect(res.status).toBe(401)
  })
})

describe("完整授权码流程（NewAPI 走的就是这条）", () => {
  it("授权 → 换 token → 取用户信息", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    const redirectUri = "https://client.example.com/oauth/callback"
    const client = await makeClient(admin, { redirectUris: [redirectUri] })

    const code = await obtainCode(user, client.clientId, redirectUri)

    const tokenRes = await exchangeToken({
      grant_type: "authorization_code",
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      redirect_uri: redirectUri,
    })
    expect(tokenRes.status).toBe(200)
    const tokenBody = await tokenRes.json<{
      access_token: string
      token_type: string
      expires_in: number
      scope: string
    }>()
    expect(tokenBody.access_token).toBeTruthy()
    expect(tokenBody.token_type).toBe("Bearer")
    expect(tokenBody.expires_in).toBe(3600)

    const infoRes = await fetchSelf(
      new Request(`${BASE}/api/oauth/userinfo`, {
        headers: { Authorization: `Bearer ${tokenBody.access_token}` },
      })
    )
    expect(infoRes.status).toBe(200)
    const info = await infoRes.json<Record<string, unknown>>()

    // sub 必须是稳定且不泄露用户名的标识（对方会当主键存下来）
    expect(info.sub).toBe(user.id)
    expect(info.preferred_username).toBe(user.username)
    expect(info.name).toBe(user.username)
    expect(info.email).toBe(`${user.username}@doulor.cn`)
    expect(info.email_verified).toBe(false)
  })

  it("scope 只有 openid 时不返回邮箱与昵称", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    const redirectUri = "https://client.example.com/cb"
    const client = await makeClient(admin, { redirectUris: [redirectUri] })

    const code = await obtainCode(user, client.clientId, redirectUri, "openid")
    const tokenRes = await exchangeToken({
      grant_type: "authorization_code",
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      redirect_uri: redirectUri,
    })
    const { access_token } = await tokenRes.json<{ access_token: string }>()

    const info = await (
      await fetchSelf(
        new Request(`${BASE}/api/oauth/userinfo`, {
          headers: { Authorization: `Bearer ${access_token}` },
        })
      )
    ).json<Record<string, unknown>>()

    expect(info.sub).toBe(user.id)
    expect(info.email).toBeUndefined()
    expect(info.preferred_username).toBeUndefined()
  })
})

describe("安全边界", () => {
  it("未注册的回调地址被拒，且**不往回跳**（否则等于开放重定向）", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    const client = await makeClient(admin)

    const res = await fetchSelf(
      authRequest(
        user,
        `/api/oauth/authorize?client_id=${client.clientId}` +
          `&redirect_uri=${encodeURIComponent("https://attacker.example.com/steal")}` +
          `&response_type=code&scope=openid&state=s`
      )
    )
    // 关键：必须是 400 错误页，绝不能是 302 跳到攻击者地址
    expect(res.status).toBe(400)
    expect(res.headers.get("Location")).toBeNull()
  })

  it("授权码只能用一次（重放必须失败）", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    const redirectUri = "https://client.example.com/cb"
    const client = await makeClient(admin, { redirectUris: [redirectUri] })
    const code = await obtainCode(user, client.clientId, redirectUri)

    const first = await exchangeToken({
      grant_type: "authorization_code",
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      redirect_uri: redirectUri,
    })
    expect(first.status).toBe(200)

    const second = await exchangeToken({
      grant_type: "authorization_code",
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      redirect_uri: redirectUri,
    })
    expect(second.status).toBe(400)
    expect((await second.json<{ error: string }>()).error).toBe("invalid_grant")
  })

  it("换 token 时 redirect_uri 与签发时不一致 → 拒绝", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    const good = "https://client.example.com/cb"
    const alsoRegistered = "https://client.example.com/other"
    const client = await makeClient(admin, { redirectUris: [good, alsoRegistered] })
    const code = await obtainCode(user, client.clientId, good)

    const res = await exchangeToken({
      grant_type: "authorization_code",
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      // 两个地址都已注册，但必须与签发时那个一致
      redirect_uri: alsoRegistered,
    })
    expect(res.status).toBe(400)
    expect((await res.json<{ error: string }>()).error).toBe("invalid_grant")
  })

  it("client_secret 错误 → invalid_client（401）", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    const redirectUri = "https://client.example.com/cb"
    const client = await makeClient(admin, { redirectUris: [redirectUri] })
    const code = await obtainCode(user, client.clientId, redirectUri)

    const res = await exchangeToken({
      grant_type: "authorization_code",
      client_id: client.clientId,
      client_secret: "dcs_wrong_secret",
      code,
      redirect_uri: redirectUri,
    })
    expect(res.status).toBe(401)
    expect((await res.json<{ error: string }>()).error).toBe("invalid_client")
  })

  it("别人的 code 不能拿自己的密钥兑换（跨 client）", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    const redirectUri = "https://client.example.com/cb"
    const clientA = await makeClient(admin, { name: "A", redirectUris: [redirectUri] })
    const clientB = await makeClient(admin, { name: "B", redirectUris: [redirectUri] })
    const code = await obtainCode(user, clientA.clientId, redirectUri)

    const res = await exchangeToken({
      grant_type: "authorization_code",
      client_id: clientB.clientId,
      client_secret: clientB.clientSecret,
      code,
      redirect_uri: redirectUri,
    })
    expect(res.status).toBe(400)
    expect((await res.json<{ error: string }>()).error).toBe("invalid_grant")
  })

  it("未登录访问 authorize → 302 到登录页并带回跳地址", async () => {
    const admin = await makeUser({ role: "admin" })
    const client = await makeClient(admin)
    const authorizeUrl =
      `/api/oauth/authorize?client_id=${client.clientId}` +
      `&redirect_uri=${encodeURIComponent("https://client.example.com/oauth/callback")}` +
      `&response_type=code&scope=openid&state=s`

    const res = await fetchSelf(new Request(`${BASE}${authorizeUrl}`, { redirect: "manual" }))
    expect(res.status).toBe(302)
    const loc = res.headers.get("Location") ?? ""
    expect(loc).toContain("/login?next=")
    // 回跳地址必须编码后带上完整原始请求，登录后才能接着授权
    expect(decodeURIComponent(loc)).toContain("/api/oauth/authorize")
  })

  it("拒绝授权 → 带 error=access_denied 回跳，且不签发任何令牌", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    const redirectUri = "https://client.example.com/cb"
    const client = await makeClient(admin, { redirectUris: [redirectUri] })

    const res = await fetchSelf(
      authRequest(user, "/api/oauth/authorize/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approve: false,
          client_id: client.clientId,
          redirect_uri: redirectUri,
          scope: "openid profile email",
          state: "s1",
        }),
      })
    )
    const { redirectTo } = await res.json<{ redirectTo: string }>()
    const u = new URL(redirectTo)
    expect(u.searchParams.get("error")).toBe("access_denied")
    expect(u.searchParams.get("code")).toBeNull()
    expect(u.searchParams.get("state")).toBe("s1")
  })

  it("不存在的 access_token 被拒（401）", async () => {
    const res = await fetchSelf(
      new Request(`${BASE}/api/oauth/userinfo`, {
        headers: { Authorization: "Bearer not-a-real-token" },
      })
    )
    expect(res.status).toBe(401)
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer")
  })

  it("没有 Authorization 头被拒（401）", async () => {
    const res = await fetchSelf(new Request(`${BASE}/api/oauth/userinfo`))
    expect(res.status).toBe(401)
  })

  it("用户被停用后，已签发的 token 不再可用", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    const redirectUri = "https://client.example.com/cb"
    const client = await makeClient(admin, { redirectUris: [redirectUri] })
    const code = await obtainCode(user, client.clientId, redirectUri)
    const token = await (
      await exchangeToken({
        grant_type: "authorization_code",
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code,
        redirect_uri: redirectUri,
      })
    ).json<{ access_token: string }>()

    // 停用用户
    await env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ?")
      .bind(user.id)
      .run()

    const res = await fetchSelf(
      new Request(`${BASE}/api/oauth/userinfo`, {
        headers: { Authorization: `Bearer ${token.access_token}` },
      })
    )
    expect(res.status).toBe(401)
  })

  it("删除应用后，它的令牌立即失效", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    const redirectUri = "https://client.example.com/cb"
    const client = await makeClient(admin, { redirectUris: [redirectUri] })
    const code = await obtainCode(user, client.clientId, redirectUri)
    const token = await (
      await exchangeToken({
        grant_type: "authorization_code",
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code,
        redirect_uri: redirectUri,
      })
    ).json<{ access_token: string }>()

    const del = await fetchSelf(
      authRequest(admin, `/api/admin/oauth/clients/${client.id}`, { method: "DELETE" })
    )
    expect(del.status).toBe(200)

    const after = await fetchSelf(
      new Request(`${BASE}/api/oauth/userinfo`, {
        headers: { Authorization: `Bearer ${token.access_token}` },
      })
    )
    expect(after.status).toBe(401)
  })

  it("不支持的 scope 被拒（不做静默降级）", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    const redirectUri = "https://client.example.com/cb"
    const client = await makeClient(admin, { redirectUris: [redirectUri] })

    const res = await fetchSelf(
      authRequest(
        user,
        `/api/oauth/authorize?client_id=${client.clientId}` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}` +
          `&response_type=code&scope=openid+admin&state=s`,
        { redirect: "manual" }
      )
    )
    expect(res.status).toBe(302)
    const loc = res.headers.get("Location") ?? ""
    expect(loc).toContain("error=invalid_scope")
  })

  it("code_challenge_method 只支持 S256（拒绝 plain）", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    const redirectUri = "https://client.example.com/cb"
    const client = await makeClient(admin, { redirectUris: [redirectUri] })

    const res = await fetchSelf(
      authRequest(
        user,
        `/api/oauth/authorize?client_id=${client.clientId}` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}` +
          `&response_type=code&scope=openid&state=s` +
          `&code_challenge=abc&code_challenge_method=plain`,
        { redirect: "manual" }
      )
    )
    expect(res.status).toBe(302)
    expect(res.headers.get("Location") ?? "").toContain("error=invalid_request")
  })

  it("scope 扩大时必须重新征求同意（不能沿用旧授权）", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    const redirectUri = "https://client.example.com/cb"
    const client = await makeClient(admin, { redirectUris: [redirectUri] })

    // 先只授权 openid
    await obtainCode(user, client.clientId, redirectUri, "openid")

    // 再请求 openid profile email：已授权的 scope 不覆盖，必须重新确认
    const ctx = await fetchSelf(
      authRequest(
        user,
        `/api/oauth/authorize/context?client_id=${client.clientId}` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}` +
          `&scope=${encodeURIComponent("openid profile email")}`
      )
    )
    const body = await ctx.json<{ alreadyGranted: boolean }>()
    expect(body.alreadyGranted).toBe(false)
  })

  it("同 scope 重复授权时不再打扰用户（alreadyGranted=true）", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    const redirectUri = "https://client.example.com/cb"
    const client = await makeClient(admin, { redirectUris: [redirectUri] })

    await obtainCode(user, client.clientId, redirectUri, "openid profile email")

    const ctx = await fetchSelf(
      authRequest(
        user,
        `/api/oauth/authorize/context?client_id=${client.clientId}` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}` +
          `&scope=${encodeURIComponent("openid profile email")}`
      )
    )
    expect((await ctx.json<{ alreadyGranted: boolean }>()).alreadyGranted).toBe(true)
  })
})

describe("用户自助撤销授权", () => {
  it("撤销后令牌失效，且需要重新同意", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    const redirectUri = "https://client.example.com/cb"
    const client = await makeClient(admin, { redirectUris: [redirectUri] })
    const code = await obtainCode(user, client.clientId, redirectUri)
    const token = await (
      await exchangeToken({
        grant_type: "authorization_code",
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code,
        redirect_uri: redirectUri,
      })
    ).json<{ access_token: string }>()

    // 列表里能看到
    const list = await fetchSelf(authRequest(user, "/api/oauth/grants"))
    const grants = (await list.json<{ grants: { clientId: string }[] }>()).grants
    expect(grants.map((g) => g.clientId)).toContain(client.clientId)

    // 撤销
    const rev = await fetchSelf(
      authRequest(user, `/api/oauth/grants/${encodeURIComponent(client.clientId)}`, {
        method: "DELETE",
      })
    )
    expect(rev.status).toBe(200)

    // 令牌失效
    const after = await fetchSelf(
      new Request(`${BASE}/api/oauth/userinfo`, {
        headers: { Authorization: `Bearer ${token.access_token}` },
      })
    )
    expect(after.status).toBe(401)

    // 再授权需要重新同意
    const ctx = await fetchSelf(
      authRequest(
        user,
        `/api/oauth/authorize/context?client_id=${client.clientId}` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}` +
          `&scope=${encodeURIComponent("openid profile email")}`
      )
    )
    expect((await ctx.json<{ alreadyGranted: boolean }>()).alreadyGranted).toBe(false)
  })
})
