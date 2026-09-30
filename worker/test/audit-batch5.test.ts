/**
 * 回归测试：第五批修复（2026-09-25 审计 L11 / L15 / L16 / L29 / L30）。
 *
 * 这一批的共同主题是「**先检查再花资源**」和「**校验只能有一处**」：
 *   - L29/L30：原先都是先把请求体读进内存，再判断大小；
 *   - L15：PKCE 校验只写在 GET 授权入口，同意页那条路完全没校验；
 *   - L16：登录只 INSERT 会话、从不清理，无上界；
 *   - L11：同一个函数里一条 bookkeeping 写有 try/catch、三条没有。
 */
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { createSession, sessionCookie } from "../src/auth"
import { makeUser, authRequest, fetchSelf, type TestUser } from "./helpers"
import { incomingEmail } from "../src/email-delivery"

const BASE = "https://cloud.doulor.cn"

/** 以管理员身份建一个 OAuth 应用 */
async function makeClient(
  admin: TestUser,
  redirectUri = "https://client.example.com/oauth/callback"
): Promise<string> {
  const res = await fetchSelf(
    authRequest(admin, "/api/admin/oauth/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "L15 测试应用",
        redirectUris: [redirectUri],
        scopes: "openid profile email",
      }),
    })
  )
  expect(res.status).toBe(201)
  const body = (await res.json()) as { client: { clientId: string } }
  return body.client.clientId
}

describe("PKCE 参数校验（L15）", () => {
  it("GET 授权入口：method=S256 但缺 code_challenge → 按规范带 error 回跳", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    const clientId = await makeClient(admin)
    const redirectUri = "https://client.example.com/oauth/callback"

    const res = await fetchSelf(
      // ⚠️ 必须 `redirect: "manual"`：默认的 `follow` 会去真的请求
      // `https://client.example.com/...` 这个外部回调地址，测试里拿到的
      // 就不是这次 authorize 的 302，而是一个跟本次断言无关的响应。
      // 既有测试（oauth-provider.test.ts:365）也是这么写的。
      new Request(
        `${BASE}/api/oauth/authorize?client_id=${encodeURIComponent(clientId)}` +
          `&redirect_uri=${encodeURIComponent(redirectUri)}` +
          `&response_type=code&scope=openid&state=st` +
          `&code_challenge_method=S256`,
        { redirect: "manual", headers: { Cookie: user.cookie } }
      )
    )
    expect(res.status).toBe(302)
    const loc = res.headers.get("Location") ?? ""
    expect(loc).toContain("error=invalid_request")
    expect(loc).toContain("state=st")
  })

  it("同意页入口：method=plain 必须被拒（原先会照单全收，code 永远兑换不了）", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    const clientId = await makeClient(admin)

    const res = await fetchSelf(
      authRequest(user, "/api/oauth/authorize/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approve: true,
          client_id: clientId,
          redirect_uri: "https://client.example.com/oauth/callback",
          scope: "openid profile email",
          state: "st",
          response_type: "code",
          code_challenge: "abc123",
          code_challenge_method: "plain",
        }),
      })
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toContain("S256")

    // 关键：不能留下任何授权码
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) c FROM oauth_codes WHERE client_id = ?"
    )
      .bind(clientId)
      .first<{ c: number }>()
    expect(rows?.c).toBe(0)
  })

  it("同意页入口：method=S256 但缺 code_challenge 必须被拒（否则 PKCE 被静默降级）", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    const clientId = await makeClient(admin)

    const res = await fetchSelf(
      authRequest(user, "/api/oauth/authorize/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approve: true,
          client_id: clientId,
          redirect_uri: "https://client.example.com/oauth/callback",
          scope: "openid profile email",
          state: "st",
          response_type: "code",
          code_challenge_method: "S256",
        }),
      })
    )
    expect(res.status).toBe(400)
  })

  it("合法的 S256 组合仍然能拿到 code（没有把正常流程一起挡掉）", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    const clientId = await makeClient(admin)

    const res = await fetchSelf(
      authRequest(user, "/api/oauth/authorize/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approve: true,
          client_id: clientId,
          redirect_uri: "https://client.example.com/oauth/callback",
          scope: "openid profile email",
          state: "st",
          response_type: "code",
          // 43 字符的合法 S256 challenge 形态
          code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
          code_challenge_method: "S256",
        }),
      })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { redirectTo: string }
    expect(body.redirectTo).toContain("code=")
  })
})

describe("会话数量上界（L16）", () => {
  it("连续登录不会无界累积，且最新会话仍然可用、最旧的被淘汰", async () => {
    const u = await makeUser() // makeUser 内部已经建了 1 个会话
    const firstCookie = u.cookie

    let lastToken = ""
    // 再建 11 个 → 一共 12 个，上界是 10
    for (let i = 0; i < 11; i++) {
      lastToken = await createSession(env, u.id)
    }

    const row = await env.DB.prepare(
      "SELECT COUNT(*) c FROM sessions WHERE user_id = ?"
    )
      .bind(u.id)
      .first<{ c: number }>()
    expect(row?.c).toBe(10)

    // 最新那个仍然能通过鉴权
    const okRes = await fetchSelf(
      new Request(`${BASE}/api/me`, { headers: { Cookie: sessionCookie(lastToken) } })
    )
    expect(okRes.status).toBe(200)

    // 最旧那个（makeUser 建的）已被淘汰
    const staleRes = await fetchSelf(
      new Request(`${BASE}/api/me`, { headers: { Cookie: firstCookie } })
    )
    expect(staleRes.status).toBe(401)
  })
})

describe("请求体体积上限（L29 / L30）", () => {
  it("社区发帖：超过 64KB 的请求体被拒（不再先读进内存再判）", async () => {
    const u = await makeUser()
    // 正常上限是正文 5000 字；这里用远超 JSON 上限的体积触发体积检查
    const huge = "a".repeat(70 * 1024)
    const res = await fetchSelf(
      authRequest(u, "/api/community/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: huge }),
      })
    )
    expect(res.status).toBe(413)
    const body = (await res.json()) as { code?: string }
    expect(body.code).toBe("PAYLOAD_TOO_LARGE")
  })

  it("社区发帖：正常的短正文不受影响", async () => {
    const u = await makeUser()
    const res = await fetchSelf(
      authRequest(u, "/api/community/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "正常的一条帖子" }),
      })
    )
    expect(res.status).toBe(201)
  })

  it("匿名 analytics：超大请求体被静默丢弃（仍 204），且不写库", async () => {
    const huge = JSON.stringify({
      visitorId: "v1",
      path: "/x",
      referrer: "",
      pad: "b".repeat(8 * 1024),
    })
    const before = await env.DB.prepare(
      "SELECT COUNT(*) c FROM analytics_events WHERE visitor_id = 'v1'"
    ).first<{ c: number }>()

    const res = await fetchSelf(
      new Request(`${BASE}/api/analytics/track`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.77.1.1" },
        body: huge,
      })
    )
    expect(res.status).toBe(204)

    const after = await env.DB.prepare(
      "SELECT COUNT(*) c FROM analytics_events WHERE visitor_id = 'v1'"
    ).first<{ c: number }>()
    expect(after?.c).toBe(before?.c ?? 0)
  })

  it("声明了超大 Content-Length 时在读之前就拒绝", async () => {
    const u = await makeUser()
    // 只发一个很小的 body，但把 Content-Length 声明成 100MB：
    // 走的是「先看 Content-Length」这条快速路径
    const req = authRequest(u, "/api/community/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "104857600" },
      body: "{}",
    })
    const res = await fetchSelf(req)
    expect(res.status).toBe(413)
  })
})

describe("停用应用 / 改密码后 OAuth 令牌立即失效（L14）", () => {
  /** 走完一次授权 + 兑换，拿到 access_token */
  async function obtainAccessToken(user: TestUser, clientId: string): Promise<string> {
    const redirectUri = "https://client.example.com/oauth/callback"
    const dec = await fetchSelf(
      authRequest(user, "/api/oauth/authorize/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approve: true,
          client_id: clientId,
          redirect_uri: redirectUri,
          scope: "openid profile email",
          state: "st",
          response_type: "code",
        }),
      })
    )
    expect(dec.status).toBe(200)
    const { redirectTo } = (await dec.json()) as { redirectTo: string }
    const code = new URL(redirectTo).searchParams.get("code") as string

    const tok = await fetchSelf(
      new Request(`${BASE}/api/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        }).toString(),
      })
    )
    expect(tok.status).toBe(200)
    const body = (await tok.json()) as { access_token: string }
    return body.access_token
  }

  let clientSecret = ""

  async function makeClientWithSecret(admin: TestUser): Promise<string> {
    const res = await fetchSelf(
      authRequest(admin, "/api/admin/oauth/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "L14 测试应用",
          redirectUris: ["https://client.example.com/oauth/callback"],
          scopes: "openid profile email",
        }),
      })
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      client: { clientId: string }
      clientSecret: string
    }
    clientSecret = body.clientSecret
    return body.client.clientId
  }

  function userinfo(token: string): Promise<Response> {
    return fetchSelf(
      new Request(`${BASE}/api/oauth/userinfo`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    )
  }

  it("停用应用后，它已签发的令牌立刻不可用（原先还能再用最多 1 小时）", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    const clientId = await makeClientWithSecret(admin)
    const token = await obtainAccessToken(user, clientId)

    // 先确认令牌本身是好的
    expect((await userinfo(token)).status).toBe(200)

    // 停用应用
    const rows = await env.DB.prepare(
      "SELECT id FROM oauth_clients WHERE client_id = ?"
    )
      .bind(clientId)
      .first<{ id: string }>()
    const off = await fetchSelf(
      authRequest(admin, `/api/admin/oauth/clients/${rows!.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disabled: true }),
      })
    )
    expect(off.status).toBe(200)

    expect((await userinfo(token)).status).toBe(401)
  })

  it("兜底：即使令牌没被标记作废，停用状态也会在校验时被拦下", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    const clientId = await makeClientWithSecret(admin)
    const token = await obtainAccessToken(user, clientId)

    // 绕过 updateClient，直接改 disabled —— 模拟「历史遗留、当时没被作废」的令牌
    await env.DB.prepare("UPDATE oauth_clients SET disabled = 1 WHERE client_id = ?")
      .bind(clientId)
      .run()

    expect((await userinfo(token)).status).toBe(401)
  })

  it("改密码会作废该用户的 OAuth 令牌（原先只删 sessions）", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    const clientId = await makeClientWithSecret(admin)
    const token = await obtainAccessToken(user, clientId)
    expect((await userinfo(token)).status).toBe(200)

    // makeUser 的口令是 pass1234
    const res = await fetchSelf(
      authRequest(user, "/api/password", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: "pass1234", newPassword: "newpass4567" }),
      })
    )
    expect(res.status).toBe(200)

    expect((await userinfo(token)).status).toBe(401)
  })
})

describe("恒定时间比较（L18）", () => {
  it("timingSafeEqual 语义正确", async () => {
    const { timingSafeEqual } = await import("../src/crypto")
    expect(timingSafeEqual("abc", "abc")).toBe(true)
    expect(timingSafeEqual("abc", "abd")).toBe(false)
    expect(timingSafeEqual("abc", "ab")).toBe(false)
    expect(timingSafeEqual("", "")).toBe(true)
    expect(timingSafeEqual("", "a")).toBe(false)
  })
})

describe("入站邮件重复投递去重（L11）", () => {
  /** 构造一封最小可解析的 RFC822 邮件 */
  function makeMessage(to: string, messageId: string | null) {
    const lines = [
      "From: Sender <sender@example.com>",
      `To: ${to}`,
      "Subject: hello",
      ...(messageId ? [`Message-ID: <${messageId}>`] : []),
      "Content-Type: text/plain; charset=utf-8",
      "",
      "body text",
    ]
    const raw = lines.join("\r\n")
    const bytes = new TextEncoder().encode(raw)
    const forwarded: string[] = []
    return {
      forwarded,
      msg: {
        from: "sender@example.com",
        to,
        headers: new Headers({ subject: "hello" }),
        raw: new ReadableStream({
          start(c) {
            c.enqueue(bytes)
            c.close()
          },
        }),
        rawSize: bytes.byteLength,
        setReject() {},
        async forward(target: string) {
          forwarded.push(target)
        },
        async reply() {
          return new Response(null)
        },
      },
    }
  }

  async function makeMailbox(): Promise<{ userId: string; address: string }> {
    const u = await makeUser()
    const address = `${u.username}@${env.ROOT_DOMAIN.toLowerCase()}`
    await env.DB.prepare(
      "INSERT INTO mailboxes (id, user_id, address, created_at) VALUES (?, ?, ?, ?)"
    )
      .bind(crypto.randomUUID(), u.id, address, new Date().toISOString())
      .run()
    return { userId: u.id, address }
  }

  async function countMessages(address: string): Promise<number> {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) c FROM messages m
         JOIN mailboxes b ON b.id = m.mailbox_id
        WHERE b.address = ?`
    )
      .bind(address)
      .first<{ c: number }>()
    return row?.c ?? 0
  }

  it("同一个 Message-ID 重投两次只入库一行", async () => {
    const { address } = await makeMailbox()
    const mid = `dup-${crypto.randomUUID()}@example.com`

    const a = makeMessage(address, mid)
    await incomingEmail(a.msg as never, env)
    const b = makeMessage(address, mid)
    await incomingEmail(b.msg as never, env)

    expect(await countMessages(address)).toBe(1)
    // 重复投递也不应再触发一次转发
    expect(a.forwarded.length + b.forwarded.length).toBe(0)
  })

  it("不同 Message-ID 仍然各自入库（没有过度去重）", async () => {
    const { address } = await makeMailbox()
    const a = makeMessage(address, `x1-${crypto.randomUUID()}@example.com`)
    await incomingEmail(a.msg as never, env)
    const b = makeMessage(address, `x2-${crypto.randomUUID()}@example.com`)
    await incomingEmail(b.msg as never, env)

    expect(await countMessages(address)).toBe(2)
  })

  it("没有 Message-ID 时不判重（宁可偶尔重复，也不能误吞真实邮件）", async () => {
    const { address } = await makeMailbox()
    const a = makeMessage(address, null)
    await incomingEmail(a.msg as never, env)
    const b = makeMessage(address, null)
    await incomingEmail(b.msg as never, env)

    expect(await countMessages(address)).toBe(2)
  })
})
