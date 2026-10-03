// CLI2API 反代账号捐献通道（第二条，与 wb2api 并列）。
//
// 这里用打桩出站 fetch 断言「发了什么请求、返回什么」，不依赖真实 cli2api 实例。
// 关键要钉住的行为：
//   1. 未配置 console key → status 报 configured=false、start 报 CLI2API_NOT_CONFIGURED；
//   2. start 会建上游账号（POST /api/accounts，enabled:true）并落一个 pending 会话；
//   3. poll 第一次向上游取授权链接（login/device），返回 authUrl；
//   4. poll 在 login/status 返回**上游真实状态 `ok`** 时落绑定、授予 ai 权限；
//   5. 上游返回 `error` 时即时判失败，且当场删掉本站建的空账号；
//   6. 会话失败/过期会删掉上游僵尸账号（避免池子堆空账号）。
//
// ⚠️ 桩里的状态一律用上游**真实词表 `ok` / `error`**（2026-09-28 对线上实例核实），
// 不要写 `done` / `failed` —— 早期桩写的就是 `done`，掩盖了「上游只会返回 ok/error」这个事实，
// 于是登录成功被误判成 pending，连续多天没绑定成功却测试全绿。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, setSetting } from "./helpers"
import { getPointsBalance } from "../src/points"

const CLI2_BASE = "https://cli2api.doulor.cn"
let upstreamCalls: string[] = []
let restore: (() => void) | null = null
/** 桩用的上游 login 状态（上游真实词表：ok / error），各用例可覆盖 */
let loginStatus = "ok"
let loginMessage = "login completed"
/**
 * 桩建出来的上游账号 id。
 *
 * ⚠️ 必须**每个用例换一个**：`cli2api_bindings.account_id` 上有唯一索引，
 * 而本文件各用例共用同一个库（没有逐用例隔离），固定 id 会让后跑的用例
 * 撞上前面用例留下的绑定，被 completeBinding 判成「该账号已被其他用户绑定」。
 * 同一个用例内多次绑定仍用同一个 id —— 「重复登录同一账号」正是要测这个。
 */
let accountId = "acc_stub_123"

/** 打桩：只接管发往 cli2api 的请求，其余透传 */
function stubCli2Api() {
  const original = globalThis.fetch
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith(CLI2_BASE)) {
      const method = init?.method ?? "GET"
      upstreamCalls.push(`${method} ${url.replace(CLI2_BASE, "")}`)
      // 按路径返回不同的假数据
      if (url.includes("/login/device")) {
        return jsonResponse({
          ok: true,
          status: "pending",
          authUrl: "https://qoder.cn/device/selectAccounts?challenge=stub",
          message: "open it",
        })
      }
      if (url.includes("/login/status")) {
        return jsonResponse({
          ok: true,
          hot: true,
          hasAuthManager: true,
          login: {
            status: loginStatus,
            message: loginMessage,
            authUrl: "https://qoder.cn/device/selectAccounts?challenge=stub",
          },
        })
      }
      if (method === "POST" && url.endsWith("/api/accounts")) {
        return jsonResponse(
          { id: accountId, name: "x", provider: "qoder", region: "cn", enabled: true },
          201
        )
      }
      if (method === "DELETE") {
        // ⚠️ 204 不能带 body（带 body 的 204 构造会直接抛错，表现为「无法连接网关」的假失败）
        return new Response(null, { status: 204 })
      }
      if (url.includes("/api/overview")) {
        return jsonResponse({ access: {}, accounts: [], models: [] })
      }
      return jsonResponse({})
    }
    return original(input as RequestInfo, init)
  }) as unknown as typeof fetch
  globalThis.fetch = stub
  restore = () => {
    globalThis.fetch = original
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

async function seedConsoleKey(): Promise<void> {
  // 直接写 D1 加密行太绕（需要 SESSION_SECRET 派生密钥），这里用 env 回落更简单：
  // 但 env 在测试里是绑定的，改不了。改为走 cli2api_credentials 表 —— 需要真加密。
  // 退而求其次：本测试用 settings 开关 + 直接调 handler 前先写 credentials 行。
  // 由于 decryptSecret 需要 SESSION_SECRET，测试环境有 .dev.vars，这里直接存加密值。
  const { encryptSecret } = await import("../src/crypto")
  const secret = env.SESSION_SECRET
  if (!secret) throw new Error("测试环境缺 SESSION_SECRET")
  const enc = await encryptSecret("stub-console-key", secret)
  await env.DB.prepare(
    `INSERT INTO cli2api_credentials (id, enc_console_key, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET enc_console_key = excluded.enc_console_key, updated_at = excluded.updated_at`
  )
    .bind(enc, new Date().toISOString())
    .run()
  // 清缓存，让下一个请求读到新 key
  const { resetCli2ApiCache } = await import("../src/cli2api-client")
  resetCli2ApiCache()
}

describe("CLI2API 反代账号捐献通道", () => {
  beforeEach(() => {
    upstreamCalls = []
    loginStatus = "ok"
    loginMessage = "login completed"
    accountId = `acc_${Math.random().toString(36).slice(2, 10)}`
    stubCli2Api()
  })

  afterEach(() => {
    restore?.()
    restore = null
  })

  it("未配置 console key → status 报 configured=false", async () => {
    const u = await makeUser()
    const res = await fetchSelf(authRequest(u, "/api/cli2api/status"))
    expect(res.status).toBe(200)
    const body = await res.json<{ configured: boolean; enabled: boolean }>()
    expect(body.configured).toBe(false)
    expect(body.enabled).toBe(true)
  })

  it("未配置 console key → start 报 CLI2API_NOT_CONFIGURED", async () => {
    const u = await makeUser()
    const res = await fetchSelf(
      authRequest(u, "/api/cli2api/login/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acknowledged: true }),
      })
    )
    expect(res.status).toBe(503)
    const body = await res.json<{ code: string }>()
    expect(body.code).toBe("CLI2API_NOT_CONFIGURED")
  })

  it("start 会建上游账号并落会话；poll 取到授权链接", async () => {
    await seedConsoleKey()
    const u = await makeUser()

    const start = await fetchSelf(
      authRequest(u, "/api/cli2api/login/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acknowledged: true }),
      })
    )
    expect(start.status).toBe(200)
    const { sessionId } = await start.json<{ sessionId: string }>()
    expect(sessionId).toBeTruthy()
    // 建账号的请求确实发出去了，且 enabled
    expect(upstreamCalls.some((c) => c.startsWith("POST /api/accounts"))).toBe(true)

    // 第一次 poll 应返回 authUrl
    const poll = await fetchSelf(authRequest(u, `/api/cli2api/login/poll?session=${sessionId}`))
    expect(poll.status).toBe(200)
    const body = await poll.json<{ status: string; authUrl?: string }>()
    expect(body.authUrl).toContain("qoder.cn/device/selectAccounts")
  })

  it("登录完成 → 落绑定并解锁 ai 权限", async () => {
    await seedConsoleKey()
    const u = await makeUser()
    await env.DB.prepare(
      "UPDATE users SET permissions = ? WHERE id = ?"
    ).bind(JSON.stringify({ r2: true, ai: false, frp: true, proxy: true }), u.id).run()

    const start = await fetchSelf(
      authRequest(u, "/api/cli2api/login/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acknowledged: true }),
      })
    )
    const { sessionId } = await start.json<{ sessionId: string }>()

    // 第一次 poll 拿链接（authUrl 已缓存进会话），第二次 poll 读到上游 ok → done
    await fetchSelf(authRequest(u, `/api/cli2api/login/poll?session=${sessionId}`))
    const poll2 = await fetchSelf(authRequest(u, `/api/cli2api/login/poll?session=${sessionId}`))
    const body = await poll2.json<{ status: string; result?: { aiGranted: boolean } }>()
    expect(body.status).toBe("done")
    expect(body.result?.aiGranted).toBe(true)

    // 绑定已落库
    const b = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM cli2api_bindings WHERE user_id = ? AND status = 'active'"
    ).bind(u.id).first<{ c: number }>()
    expect(b?.c).toBe(1)

    // ai 权限已授予
    const perms = await env.DB.prepare("SELECT permissions FROM users WHERE id = ?")
      .bind(u.id).first<{ permissions: string }>()
    expect(JSON.parse(perms!.permissions).ai).toBe(true)
  })

  /** 跑完一次「start → poll 取链接 → poll 读到 ok」的完整绑定 */
  async function bindOnce(u: { cookie: string }) {
    const start = await fetchSelf(
      authRequest(u as never, "/api/cli2api/login/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acknowledged: true }),
      })
    )
    const { sessionId } = await start.json<{ sessionId: string }>()
    await fetchSelf(authRequest(u as never, `/api/cli2api/login/poll?session=${sessionId}`))
    const poll2 = await fetchSelf(
      authRequest(u as never, `/api/cli2api/login/poll?session=${sessionId}`)
    )
    return poll2.json<{ status: string; result?: Record<string, unknown> }>()
  }

  it("绑定成功 → 按 provider 发捐献奖励积分（qoder 默认 10 分）", async () => {
    await seedConsoleKey()
    const u = await makeUser()
    await env.DB.prepare("UPDATE users SET permissions = ? WHERE id = ?")
      .bind(JSON.stringify({ r2: true, ai: false, frp: true, proxy: true }), u.id)
      .run()

    expect((await bindOnce(u)).status).toBe("done")
    expect(await getPointsBalance(env, u.id)).toBe(10)

    const tx = await env.DB.prepare(
      "SELECT reason, detail, delta FROM point_transactions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1"
    )
      .bind(u.id)
      .first<{ reason: string; detail: string; delta: number }>()
    expect(tx?.reason).toBe("donation")
    expect(tx?.delta).toBe(10)
    // 档位取的是上游 provider（不是通道名）
    expect(tx?.detail).toContain("Qoder")
  })

  it("重复登录同一个上游账号 → 不重复发分", async () => {
    await seedConsoleKey()
    const u = await makeUser()

    expect((await bindOnce(u)).status).toBe("done")
    expect(await getPointsBalance(env, u.id)).toBe(10)

    // 同一个用例内桩始终返回同一个 accountId ⇒ 第二次走的是「复活墓碑」分支
    expect((await bindOnce(u)).status).toBe("done")
    expect(await getPointsBalance(env, u.id)).toBe(10)

    const c = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM point_transactions WHERE user_id = ? AND reason = 'donation'"
    )
      .bind(u.id)
      .first<{ c: number }>()
    expect(c?.c).toBe(1)
  })

  it("上游状态 error → 即时判失败（含中文提示），并删掉空账号", async () => {
    await seedConsoleKey()
    loginStatus = "error"
    loginMessage = "Device flow timed out after 5 minutes. Please try again."
    const u = await makeUser()

    const start = await fetchSelf(
      authRequest(u, "/api/cli2api/login/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acknowledged: true }),
      })
    )
    const { sessionId } = await start.json<{ sessionId: string }>()

    await fetchSelf(authRequest(u, `/api/cli2api/login/poll?session=${sessionId}`))
    upstreamCalls = []
    const poll = await fetchSelf(authRequest(u, `/api/cli2api/login/poll?session=${sessionId}`))
    const body = await poll.json<{ status: string; message: string }>()
    // 关键：error 必须即时判失败，而不是一直 pending 到会话过期
    expect(body.status).toBe("failed")
    expect(body.message).toContain("设备授权超时")
    // 失败的空账号要当场删掉
    expect(upstreamCalls.some((c) => c.startsWith("DELETE /api/accounts/"))).toBe(true)
    // 不应产生绑定
    const b = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM cli2api_bindings WHERE user_id = ?"
    ).bind(u.id).first<{ c: number }>()
    expect(b?.c).toBe(0)
  })

  it("上游未完成（status=pending）→ 一直 pending，不误判失败", async () => {
    await seedConsoleKey()
    loginStatus = "pending"
    loginMessage = ""
    const u = await makeUser()

    const start = await fetchSelf(
      authRequest(u, "/api/cli2api/login/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acknowledged: true }),
      })
    )
    const { sessionId } = await start.json<{ sessionId: string }>()

    await fetchSelf(authRequest(u, `/api/cli2api/login/poll?session=${sessionId}`))
    const poll = await fetchSelf(authRequest(u, `/api/cli2api/login/poll?session=${sessionId}`))
    const body = await poll.json<{ status: string }>()
    expect(body.status).toBe("pending")
  })

  it("会话过期时删掉上游僵尸账号", async () => {
    await seedConsoleKey()
    const u = await makeUser()

    const start = await fetchSelf(
      authRequest(u, "/api/cli2api/login/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acknowledged: true }),
      })
    )
    const { sessionId } = await start.json<{ sessionId: string }>()

    // 手工把会话改成已过期
    await env.DB.prepare(
      "UPDATE cli2api_login_sessions SET expires_at = ? WHERE user_id = ?"
    ).bind("2000-01-01T00:00:00.000Z", u.id).run()

    upstreamCalls = []
    const poll = await fetchSelf(authRequest(u, `/api/cli2api/login/poll?session=${sessionId}`))
    const body = await poll.json<{ status: string }>()
    expect(body.status).toBe("failed")
    // 删账号的请求确实发出去了
    expect(upstreamCalls.some((c) => c.startsWith("DELETE /api/accounts/"))).toBe(true)
  })
})
