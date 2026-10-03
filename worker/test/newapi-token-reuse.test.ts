// 「取用户 access token」的重登策略 —— 2026-09-30 线上 429 事故的回归测试。
//
// 事故经过（已对线上实测确认）：
//   1. 只要用户「已开通中转站」，本站每次需要用户 token 的操作
//      （拉模型 / 列 Key / 建 Key / 同步额度 / 兑换 / 改密码）都会先
//      `POST /api/user/login` 重登一次换新 token；
//   2. NewAPI 的 `CriticalRateLimit` 是**按来源 IP** 限流的，而本站所有服务端
//      调用都从同一个 Cloudflare 出口 IP 发出 ⇒ 全体用户共用一个桶；
//   3. 实测 90 分钟 276 次 login、108 次被 429 拒（AI 页面一次加载就贡献 3 次）；
//   4. NewAPI 的限流响应是**空 body**（`Content-Length: 0`），于是前端只能显示
//      一句 `NewAPI 登录失败: HTTP 429`，用户完全看不懂。
//
// 本文件锁死三件事：
//   A. 缓存 token 有效时**一次 login 都不许发**；
//   B. 缓存 token 失效时只重登一次并自动重试（保住自愈能力）；
//   C. NewAPI 回 429 时要给出人话，不能再出现 `HTTP 429`。
import { describe, it, expect, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, setPermissions, setSetting } from "./helpers"
import { decryptSecret, encryptSecret } from "../src/crypto"
import { resetAdminCredentialCache } from "../src/newapi-client"

const BASE = "https://api.doulor.cn"

/** 与 handlers/newapi.ts 的 NO_TOKEN_SENTINEL 同值（哨兵：自动认领账号没真 token） */
const NO_TOKEN_PLACEHOLDER = "NO_TOKEN"

let restore: (() => void) | null = null

afterEach(() => {
  restore?.()
  restore = null
  resetAdminCredentialCache()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/** 打桩所有发往 NewAPI 的出站请求；记录路径与 Authorization 头 */
function stubNewApi(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>
): { calls: string[]; logins: () => string[] } {
  const calls: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(BASE)) return original(input as RequestInfo, init)
    calls.push(url.slice(BASE.length))
    return handler(url, init)
  }) as unknown as typeof fetch
  restore = () => {
    globalThis.fetch = original
  }
  return {
    calls,
    logins: () => calls.filter((c) => c.startsWith("/api/user/login")),
  }
}

function bearer(init?: RequestInit): string {
  const h = new Headers(init?.headers)
  return h.get("Authorization") ?? ""
}

/**
 * 造一条「已开通且已存密码」的 newapi_accounts 记录。
 * `enc_token` 用真实加密写入 —— 必须能被 decryptSecret 解出来，
 * 否则走不到「用缓存 token」这条路径，测试就失去意义了。
 */
// newapi_user_id 上有唯一索引（idx_newapi_accounts_uid），每个用例要给不同的值
let nextNewApiId = 5000

async function seedBoundAccount(opts: {
  userId: string
  username: string
  cachedToken: string
  password?: string | null
  newapiUserId?: number
}): Promise<void> {
  const secret = env.SESSION_SECRET
  if (!secret) throw new Error("测试环境缺 SESSION_SECRET")
  await env.DB.prepare(
    `INSERT INTO newapi_accounts
       (user_id, newapi_user_id, username, email, enc_token, enc_password, group_name,
        quota, used_quota, request_count, synced_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'default', 0, 0, 0, NULL, ?)`
  )
    .bind(
      opts.userId,
      opts.newapiUserId ?? nextNewApiId++,
      opts.username,
      `${opts.username}@doulor.cn`,
      // 哨兵是**明文**存在 enc_token 里的（代码按原值比较），不能加密
      opts.cachedToken === NO_TOKEN_PLACEHOLDER
        ? opts.cachedToken
        : await encryptSecret(opts.cachedToken, secret),
      opts.password === null || opts.password === undefined
        ? null
        : await encryptSecret(opts.password, secret),
      new Date().toISOString()
    )
    .run()
}

/** 造一个带 ai 权限的用户 */
async function makeAiUser() {
  const u = await makeUser()
  await setPermissions(u.id, JSON.stringify({ ai: true }))
  return u
}

const UNAUTHORIZED = () =>
  jsonResponse(
    { code: "AUTH_UNAUTHORIZED", message: "Unauthorized, invalid access token", success: false },
    401
  )

describe("取用户 token 的重登策略（429 事故回归）", () => {
  it("A. 缓存 token 有效 → 一次 NewAPI 登录都不发", async () => {
    const u = await makeAiUser()
    await seedBoundAccount({
      userId: u.id,
      username: u.username,
      cachedToken: "tk-cached",
      password: "cloudpw123456",
    })

    const stub = stubNewApi((url, init) => {
      // 老实现会在这一步之前先 login 一次；新实现直接用缓存 token
      if (url.includes("/api/token/")) {
        expect(bearer(init)).toBe("Bearer tk-cached")
        return jsonResponse({ success: true, data: { items: [] } })
      }
      return jsonResponse({ success: true, data: {} })
    })

    const res = await fetchSelf(
      authRequest(u, "/api/dev/keys/sync", { method: "POST" })
    )
    expect(res.status).toBe(200)
    // 核心断言：整条链路零登录
    expect(stub.logins()).toHaveLength(0)
    expect(stub.calls.some((c) => c.startsWith("/api/token/"))).toBe(true)
  })

  it("B. 缓存 token 失效 → 只重登一次、自动重试成功，并把新 token 写回缓存", async () => {
    const u = await makeAiUser()
    await seedBoundAccount({
      userId: u.id,
      username: u.username,
      cachedToken: "tk-stale",
      password: "cloudpw123456",
    })

    const stub = stubNewApi((url, init) => {
      if (url.includes("/api/user/login")) {
        return jsonResponse({
          success: true,
          data: { id: 4242, access_token: "tk-fresh", user: { id: 4242 } },
        })
      }
      if (url.includes("/api/token/")) {
        // 旧 token 一律按「无效」处理，模拟被 disable/enable 或转组吊销
        if (bearer(init) === "Bearer tk-stale") return UNAUTHORIZED()
        expect(bearer(init)).toBe("Bearer tk-fresh")
        return jsonResponse({ success: true, data: { items: [] } })
      }
      return jsonResponse({ success: true, data: {} })
    })

    const res = await fetchSelf(
      authRequest(u, "/api/dev/keys/sync", { method: "POST" })
    )
    expect(res.status).toBe(200)
    expect(stub.logins()).toHaveLength(1)

    const row = await env.DB.prepare(
      "SELECT enc_token FROM newapi_accounts WHERE user_id = ?"
    )
      .bind(u.id)
      .first<{ enc_token: string }>()
    expect(await decryptSecret(row!.enc_token, env.SESSION_SECRET)).toBe("tk-fresh")
  })

  it("C. NewAPI 限流（空 body 的 429）→ 给出人话，不再出现 `HTTP 429`", async () => {
    const u = await makeAiUser()
    await seedBoundAccount({
      userId: u.id,
      username: u.username,
      cachedToken: "tk-cached",
      password: "cloudpw123456",
    })

    stubNewApi((url) => {
      // 复刻线上实测：NewAPI 限流中间件返回 429 + Retry-After + **空 body**
      if (url.includes("/api/user/self")) {
        return new Response(null, {
          status: 429,
          headers: { "Retry-After": "1200" },
        })
      }
      return jsonResponse({ success: true, data: {} })
    })

    const res = await fetchSelf(authRequest(u, "/api/dev/sync", { method: "POST" }))
    expect(res.status).toBe(429)
    // 错误响应体形如 { error: message, code }
    const body = (await res.json()) as { code: string; error: string }
    expect(body.code).toBe("NEWAPI_RATE_LIMITED")
    expect(body.error).toContain("限流")
    expect(body.error).toContain("20 分钟")
    // 这句「HTTP 429」是当初用户唯一能看到的信息，绝不能回来
    expect(body.error).not.toContain("HTTP 429")
  })

  it("D. 既无缓存 token 也无存密码 → 引导重新绑定（USER_TOKEN_EXPIRED）", async () => {
    const u = await makeAiUser()
    await seedBoundAccount({
      userId: u.id,
      username: u.username,
      cachedToken: NO_TOKEN_PLACEHOLDER,
      password: null,
    })

    const stub = stubNewApi(() => jsonResponse({ success: true, data: {} }))
    const res = await fetchSelf(
      authRequest(u, "/api/dev/keys/sync", { method: "POST" })
    )
    expect(res.status).toBe(401)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe("USER_TOKEN_EXPIRED")
    expect(stub.logins()).toHaveLength(0)
  })
})

describe("/api/dev/bind 的密码校验限流（补上的爆破面）", () => {
  it("连错密码 10 次后第 11 次被限流，而不是无限次试", async () => {
    const u = await makeAiUser()
    await setSetting("newapi_enabled", "1")
    stubNewApi(() => jsonResponse({ success: true, data: {} }))

    const attempt = async () => {
      const res = await fetchSelf(
        authRequest(u, "/api/dev/bind", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: "wrongpassword" }),
        })
      )
      return { status: res.status, body: (await res.json()) as { code: string } }
    }

    for (let i = 1; i <= 10; i++) {
      const r = await attempt()
      expect(r.status, `第 ${i} 次应仍是密码错误`).toBe(401)
      expect(r.body.code).toBe("INVALID_PASSWORD")
    }

    const blocked = await attempt()
    expect(blocked.status).toBe(429)
    expect(blocked.body.code).toBe("RATE_LIMITED")
  })
})
