import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { login } from "../src/handlers/auth"
import { verifyLoginTwoFactor } from "../src/handlers/login-2fa"
import { hashPassword, uuid, encryptSecret } from "../src/crypto"
import { currentTotp, generateTotpSecret } from "../src/totp"
import { authRequest, fetchSelf, makeUser } from "./helpers"

/**
 * 登录闸门的端到端行为。
 *
 * 这里最该守住的是**两条相反的线**：
 *   · 该拦的必须拦住 —— 配了 2FA 的账号，光有口令**绝不能**拿到 session；
 *   · 不该拦的绝不能拦 —— 没配 2FA 的普通用户行为**必须与改动前完全一致**（无回归），
 *     而且**被强制要求但还没配的管理员也要能登录**（否则上线当天就把站长锁在门外）。
 */

async function seedUser(opts: {
  role?: "user" | "admin" | "root"
  emailVerified?: boolean
} = {}) {
  const username = `u_${Math.random().toString(36).slice(2, 8)}`
  const id = uuid()
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO users (id, username, email, password_hash, namespace, role, status, email_verified, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
  )
    .bind(
      id,
      username,
      `${username}@doulor.cn`,
      await hashPassword("pass1234"),
      username,
      opts.role ?? "user",
      opts.emailVerified === false ? 0 : 1,
      now,
      now
    )
    .run()
  return { id, username }
}

function loginRequest(identifier: string, password = "pass1234"): Request {
  return new Request("https://cloud.doulor.cn/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  })
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

/** 带 JSON body 的请求 init（设置类接口用） */
function jsonInit(body: unknown, method = "POST"): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }
}

/** 给某个用户配好邮箱方式（不真发信，测试里只关心校验） */
async function enableEmail2fa(userId: string) {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO user_2fa (user_id, totp_secret, totp_confirmed, email_enabled, created_at, updated_at)
     VALUES (?, NULL, 0, 1, ?, ?)`
  )
    .bind(userId, now, now)
    .run()
}

/** 给某个用户配好 TOTP，返回明文密钥 */
async function enableTotp2fa(userId: string): Promise<string> {
  const secret = generateTotpSecret()
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO user_2fa (user_id, totp_secret, totp_confirmed, email_enabled, created_at, updated_at)
     VALUES (?, ?, 1, 0, ?, ?)`
  )
    .bind(userId, await encryptSecret(secret, env.SESSION_SECRET!), now, now)
    .run()
  return secret
}

describe("登录闸门", () => {
  it("登录不会把 Cloudflare 账户级 destination 验证冒充成用户本人验证", async () => {
    const u = await seedUser({ emailVerified: false })
    const originalFetch = globalThis.fetch
    const cloudflareCalls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url.includes("api.cloudflare.com")) {
        cloudflareCalls.push(url)
        return new Response(
          JSON.stringify({
            success: true,
            result: [{ id: "legacy-destination", email: `${u.username}@doulor.cn`, verified: "2026-01-01T00:00:00Z" }],
            result_info: { total_pages: 1 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      }
      return originalFetch(input as RequestInfo, init)
    }) as typeof globalThis.fetch

    try {
      const res = await login(env, loginRequest(u.username))
      expect(res.status).toBe(200)
      const body = await readJson(res)
      expect((body.user as { emailVerified: boolean }).emailVerified).toBe(false)
      const stored = await env.DB.prepare("SELECT email_verified FROM users WHERE id = ?")
        .bind(u.id)
        .first<{ email_verified: number }>()
      expect(stored?.email_verified).toBe(0)
      expect(cloudflareCalls).toEqual([])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("没配 2FA 的普通用户：行为与改动前一致，直接拿到 session", async () => {
    const u = await seedUser()
    const res = await login(env, loginRequest(u.username))
    expect(res.status).toBe(200)
    const body = await readJson(res)
    expect(body.user).toBeTruthy()
    expect(body.needTwoFactor).toBeUndefined()
    expect(body.mustSetupTwoFactor).toBe(false)
    // 必须真的下发了 cookie
    expect(res.headers.get("Set-Cookie")).toContain("doulor_session=")
  })

  it("管理员没配 2FA：**仍然放行**，但带 mustSetupTwoFactor 让前端引导去配", async () => {
    const u = await seedUser({ role: "admin" })
    const res = await login(env, loginRequest(u.username))
    expect(res.status).toBe(200)
    const body = await readJson(res)
    // 关键：不能被拦在门外（否则一上线就把管理员锁死）
    expect(res.headers.get("Set-Cookie")).toContain("doulor_session=")
    expect(body.mustSetupTwoFactor).toBe(true)
  })

  it("配了邮箱 2FA：只给 challengeId，**绝不下发 session**", async () => {
    const u = await seedUser()
    await enableEmail2fa(u.id)
    const res = await login(env, loginRequest(u.username))
    expect(res.status).toBe(200)
    const body = await readJson(res)
    expect(body.needTwoFactor).toBe(true)
    expect(body.challengeId).toBeTruthy()
    expect(body.methods).toContain("email")
    // 这条是整件事的底线
    expect(res.headers.get("Set-Cookie")).toBeNull()
  })

  it("口令错了：连 challenge 都不给", async () => {
    const u = await seedUser()
    await enableEmail2fa(u.id)
    await expect(login(env, loginRequest(u.username, "wrong-pass"))).rejects.toThrow()
  })
})

describe("二次验证", () => {
  let userId = ""
  let username = ""
  let secret = ""

  beforeEach(async () => {
    const u = await seedUser({ role: "admin" })
    userId = u.id
    username = u.username
    secret = await enableTotp2fa(userId)
  })

  async function startChallenge(): Promise<string> {
    const res = await login(env, loginRequest(username))
    const body = await readJson(res)
    return String(body.challengeId)
  }

  it("动态码正确 → 建立登录态", async () => {
    const challengeId = await startChallenge()
    const code = await currentTotp(secret)
    const res = await verifyLoginTwoFactor(
      env,
      new Request("https://cloud.doulor.cn/api/login/2fa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, method: "totp", code }),
      })
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("Set-Cookie")).toContain("doulor_session=")
  })

  it("动态码错误 → 拒绝，且不下发 session", async () => {
    const challengeId = await startChallenge()
    await expect(
      verifyLoginTwoFactor(
        env,
        new Request("https://cloud.doulor.cn/api/login/2fa", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ challengeId, method: "totp", code: "000000" }),
        })
      )
    ).rejects.toThrow()
  })

  it("挑战用过即废，不能重放", async () => {
    const challengeId = await startChallenge()
    const code = await currentTotp(secret)
    const make = () =>
      new Request("https://cloud.doulor.cn/api/login/2fa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, method: "totp", code }),
      })
    const first = await verifyLoginTwoFactor(env, make())
    expect(first.status).toBe(200)
    // 同一个 challenge 再用一次必须失败
    await expect(verifyLoginTwoFactor(env, make())).rejects.toThrow()
  })

  it("不能用没启用的方式（该账号只有 totp，却提交 recovery）", async () => {
    const challengeId = await startChallenge()
    await expect(
      verifyLoginTwoFactor(
        env,
        new Request("https://cloud.doulor.cn/api/login/2fa", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ challengeId, method: "recovery", code: "abcdef1234" }),
        })
      )
    ).rejects.toThrow()
  })

  it("连错多次后挑战作废，即使之后给对的码也不行", async () => {
    const challengeId = await startChallenge()
    for (let i = 0; i < 5; i++) {
      await expect(
        verifyLoginTwoFactor(
          env,
          new Request("https://cloud.doulor.cn/api/login/2fa", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ challengeId, method: "totp", code: "000000" }),
          })
        )
      ).rejects.toThrow()
    }
    // 挑战已被删除 → 正确码也救不回来
    await expect(
      verifyLoginTwoFactor(
        env,
        new Request("https://cloud.doulor.cn/api/login/2fa", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ challengeId, method: "totp", code: await currentTotp(secret) }),
        })
      )
    ).rejects.toThrow()
  })

  it("不存在的 challengeId 直接拒绝", async () => {
    await expect(
      verifyLoginTwoFactor(
        env,
        new Request("https://cloud.doulor.cn/api/login/2fa", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ challengeId: uuid(), method: "totp", code: "123456" }),
        })
      )
    ).rejects.toThrow()
  })
})

describe("恢复码", () => {
  it("一次性：用过就作废", async () => {
    const u = await seedUser({ role: "admin" })
    await enableEmail2fa(u.id)
    const now = new Date().toISOString()
    const { hashToken } = await import("../src/crypto")
    const code = "aabbccddee"
    await env.DB.prepare(
      `INSERT INTO user_2fa_recovery (user_id, code_hash, used_at, created_at) VALUES (?, ?, NULL, ?)`
    )
      .bind(u.id, await hashToken(code), now)
      .run()

    const { verifyRecoveryCode } = await import("../src/handlers/two-factor")
    expect(await verifyRecoveryCode(env, u.id, code)).toBe(true)
    // 第二次必须失败
    expect(await verifyRecoveryCode(env, u.id, code)).toBe(false)
  })
})

describe("邮箱脱敏", () => {
  it("不泄露完整地址", async () => {
    const { maskEmail } = await import("../src/handlers/two-factor")
    expect(maskEmail("abcdef@qq.com")).toBe("a****@qq.com")
    expect(maskEmail("a@qq.com")).toBe("a*@qq.com")
    expect(maskEmail("noatsign")).toBe("***")
  })
})

/**
 * 恢复码与开启状态的绑定（2026-10-08 站长定的口径）。
 *
 * 背景：旧版本把「还有恢复码」当成一种独立的验证方式 —— 用户把邮箱 / TOTP
 * 都关掉之后，遗留的 10 张恢复码仍把 2FA 顶成「已开启」，登录被拦在
 * 二次验证页只剩「输恢复码」一条路（设置页还显示剩 10 张）。修复口径：
 * 恢复码只是已开启方式的自救手段，没有任何方式开着 ⇒ 恢复码视为失效；
 * 重新开启任一方式 ⇒ 发一批新码（明文只出现一次）。
 */
describe("恢复码与开启状态", () => {
  /** 造一个「两种方式都关了、但遗留 10 张恢复码」的历史脏状态 */
  async function seedStrandedRecovery(userId: string): Promise<void> {
    const now = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO user_2fa (user_id, totp_secret, totp_confirmed, email_enabled, created_at, updated_at)
       VALUES (?, NULL, 0, 0, ?, ?)`
    )
      .bind(userId, now, now)
      .run()
    const { hashToken } = await import("../src/crypto")
    for (let i = 0; i < 10; i++) {
      await env.DB.prepare(
        `INSERT INTO user_2fa_recovery (user_id, code_hash, used_at, created_at) VALUES (?, ?, NULL, ?)`
      )
        .bind(userId, await hashToken(`legacy-code-${i}`), now)
        .run()
    }
  }

  async function recoveryCount(userId: string): Promise<number> {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM user_2fa_recovery WHERE user_id = ?"
    )
      .bind(userId)
      .first<{ c: number }>()
    return Number(row?.c ?? 0)
  }

  it("遗留恢复码不再把 2FA 顶成已开启：登录直接放行，不再索要恢复码", async () => {
    const u = await seedUser()
    await seedStrandedRecovery(u.id)

    // 状态口径：enabled=false、recoveryLeft=0
    const { loadTwoFactorState, evaluateTwoFactorGate } = await import(
      "../src/handlers/two-factor"
    )
    const state = await loadTwoFactorState(env, u.id)
    expect(state.enabled).toBe(false)
    expect(state.recoveryLeft).toBe(0)
    expect(state.methods).toEqual([])

    const gate = await evaluateTwoFactorGate(env, { id: u.id, role: "user" })
    expect(gate.needChallenge).toBe(false)

    // 端到端：登录**必须**直接拿到 session，而不是被拦在二次验证页
    const res = await login(env, loginRequest(u.username))
    expect(res.status).toBe(200)
    const body = await readJson(res)
    expect(body.user).toBeTruthy()
    expect(body.needTwoFactor).toBeUndefined()
    expect(res.headers.get("Set-Cookie")).toContain("doulor_session=")
  })

  it("开启邮箱方式 → 发一批新恢复码，遗留的失效码被清掉", async () => {
    const u = await makeUser({})
    await seedStrandedRecovery(u.id)

    const res = await fetchSelf(
      authRequest(u, "/api/settings/2fa/email", jsonInit({ enabled: true }))
    )
    expect(res.status).toBe(200)
    const body = await res.json<{ recoveryCodes?: string[] }>()
    expect(body.recoveryCodes).toHaveLength(10)
    // 旧码被全量替换：库里的行是新发的这批（哈希对得上新码、对不上旧码）
    expect(await recoveryCount(u.id)).toBe(10)
    const { verifyRecoveryCode } = await import("../src/handlers/two-factor")
    expect(await verifyRecoveryCode(env, u.id, body.recoveryCodes![0])).toBe(true)
    expect(await verifyRecoveryCode(env, u.id, "legacy-code-0")).toBe(false)
  })

  it("关掉最后一个方式 → 恢复码一并作废", async () => {
    const u = await makeUser({})
    const on = await fetchSelf(
      authRequest(u, "/api/settings/2fa/email", jsonInit({ enabled: true }))
    )
    expect(on.status).toBe(200)
    expect(await recoveryCount(u.id)).toBe(10)

    const off = await fetchSelf(
      authRequest(u, "/api/settings/2fa/email", jsonInit({ enabled: false }))
    )
    expect(off.status).toBe(200)
    expect(await recoveryCount(u.id)).toBe(0)

    const { loadTwoFactorState } = await import("../src/handlers/two-factor")
    const state = await loadTwoFactorState(env, u.id)
    expect(state.enabled).toBe(false)
    expect(state.recoveryLeft).toBe(0)
  })

  it("TOTP 还开着时开关邮箱方式，不动恢复码", async () => {
    const u = await makeUser({})
    // 先把 TOTP 配好（确认动作会发恢复码；测试里直接落库 + 预置 10 张）
    const secret = generateTotpSecret()
    const now = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO user_2fa (user_id, totp_secret, totp_confirmed, email_enabled, created_at, updated_at)
       VALUES (?, ?, 1, 0, ?, ?)`
    )
      .bind(u.id, await encryptSecret(secret, env.SESSION_SECRET!), now, now)
      .run()
    const { hashToken } = await import("../src/crypto")
    for (let i = 0; i < 10; i++) {
      await env.DB.prepare(
        `INSERT INTO user_2fa_recovery (user_id, code_hash, used_at, created_at) VALUES (?, ?, NULL, ?)`
      )
        .bind(u.id, await hashToken(`totp-era-${i}`), now)
        .run()
    }

    // 开邮箱：TOTP 的码还在用，不该被换掉
    const on = await fetchSelf(
      authRequest(u, "/api/settings/2fa/email", jsonInit({ enabled: true }))
    )
    expect(on.status).toBe(200)
    const onBody = await on.json<{ recoveryCodes?: string[] }>()
    expect(onBody.recoveryCodes).toBeUndefined()
    expect(await recoveryCount(u.id)).toBe(10)

    // 关邮箱：TOTP 还开着，码同样保留
    const off = await fetchSelf(
      authRequest(u, "/api/settings/2fa/email", jsonInit({ enabled: false }))
    )
    expect(off.status).toBe(200)
    expect(await recoveryCount(u.id)).toBe(10)
  })

  it("2FA 没开时禁止「重新生成恢复码」", async () => {
    const u = await makeUser({})
    const res = await fetchSelf(
      authRequest(u, "/api/settings/2fa/recovery/regenerate", { method: "POST" })
    )
    expect(res.status).toBe(400)
    expect(await recoveryCount(u.id)).toBe(0)
  })
})
