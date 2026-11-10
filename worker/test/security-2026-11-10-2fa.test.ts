// 2026-11-10 渗透测试 finding#1 / finding#5 回归测试。
//
// ── 报告里的利用链（当时全部成立）──
//   1. 只拿到会话 cookie（2FA 关着的账号）⇒ `POST /api/settings/2fa/email {enabled:true}`
//      无任何验证码就 200，响应里直接下发 10 个**恢复码**；
//   2. 恢复码被 `assertTwoFactorStepUp` 当作合法 step-up 码（target=any）⇒
//      `POST /api/settings/2fa/totp/start {code:恢复码}` 拿到 TOTP 密钥；
//   3. `POST /api/settings/2fa/totp/confirm {code:自算动态码}` 原来**不需要任何授权**，
//      于是攻击者把自己的认证器绑上去 ⇒ 之后凭「口令 + 自己算的 TOTP」长期登录。
//
// ── 根因与修法 ──
//   · 根因 A：`assertTwoFactorStepUp` 在账号没有任何 2FA 时直接放行（「首次加固」），
//     而「新增因子」这件事本身需要一个**独立于会话**的凭据 ⇒ 现在走
//     `assertReauthForNewFactor`：必须验账户密码（已有 2FA 时再加一个当前验证码）。
//   · 根因 B：`confirm` 信任库里那份「未确认的密钥」，而密钥是 start 时无校验写进去的 ⇒
//     现在密钥不落库，由 start 下发 AES-GCM 加密票据 `setupToken`（带 userId + 15 分钟
//     过期），confirm 校验票据 + 动态码后才写入。
//   · 顺带修掉一个静默降级：原来 start 就把 `totp_confirmed` 置 0，用户点了「重新配置」
//     又放弃时，已确认的 TOTP 会变回未确认 —— 对只开 TOTP 的账号等于关掉了 2FA。
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, type TestUser } from "./helpers"
import { encryptSecret } from "../src/crypto"
import { currentTotp, generateTotpSecret } from "../src/totp"

const JSON_HEADERS = { "Content-Type": "application/json" }
/** `makeUser()` 造出来的账号口令（见 test/helpers.ts） */
const PASSWORD = "pass1234"

async function post(user: TestUser, path: string, body?: unknown): Promise<Response> {
  return fetchSelf(
    authRequest(user, path, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body ?? {}),
    })
  )
}

async function codeOf(res: Response): Promise<string | undefined> {
  return ((await res.json().catch(() => ({}))) as { code?: string }).code
}

interface TwoFactorStatus {
  enabled: boolean
  methods: string[]
  totpConfirmed: boolean
  emailEnabled: boolean
  recoveryLeft: number
}

async function statusOf(user: TestUser): Promise<TwoFactorStatus> {
  const res = await fetchSelf(authRequest(user, "/api/settings/2fa"))
  expect(res.status).toBe(200)
  return (await res.json()) as TwoFactorStatus
}

async function recoveryRows(userId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM user_2fa_recovery WHERE user_id = ? AND used_at IS NULL"
  )
    .bind(userId)
    .first<{ c: number }>()
  return Number(row?.c ?? 0)
}

async function twoFactorRows(userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM user_2fa WHERE user_id = ?")
    .bind(userId)
    .first<{ c: number }>()
  return Number(row?.c ?? 0)
}

/** 落一个「已确认 TOTP」的存量账号，返回它的密钥（测试里用它算动态码） */
async function seedConfirmedTotp(userId: string): Promise<string> {
  const secret = generateTotpSecret()
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO user_2fa (user_id, totp_secret, totp_confirmed, email_enabled, created_at, updated_at)
     VALUES (?, ?, 1, 0, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET totp_confirmed = 1, updated_at = excluded.updated_at`
  )
    .bind(userId, await encryptSecret(secret, env.SESSION_SECRET!), now, now)
    .run()
  return secret
}

describe("新增第二因子必须重新认证（finding#1/#5）", () => {
  it("只凭会话开启邮箱验证 ⇒ 400 NEED_PASSWORD，不改状态、不发恢复码", async () => {
    const u = await makeUser()

    const denied = await post(u, "/api/settings/2fa/email", { enabled: true })
    expect(denied.status).toBe(400)
    expect(await codeOf(denied)).toBe("NEED_PASSWORD")

    const st = await statusOf(u)
    expect(st.enabled).toBe(false)
    expect(st.emailEnabled).toBe(false)
    expect(st.recoveryLeft).toBe(0)
    // 关键：没有「无码开启顺带领走 10 个恢复码」这回事
    expect(await recoveryRows(u.id)).toBe(0)
  })

  it("密码错误 ⇒ 400 INVALID_PASSWORD，状态不变", async () => {
    const u = await makeUser()
    const res = await post(u, "/api/settings/2fa/email", {
      enabled: true,
      password: "not-my-password",
    })
    expect(res.status).toBe(400)
    expect(await codeOf(res)).toBe("INVALID_PASSWORD")
    expect((await statusOf(u)).emailEnabled).toBe(false)
    expect(await recoveryRows(u.id)).toBe(0)
  })

  it("本人（带正确密码）开启邮箱验证 ⇒ 200 且真的拿到 10 个恢复码", async () => {
    const u = await makeUser()
    const res = await post(u, "/api/settings/2fa/email", {
      enabled: true,
      password: PASSWORD,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok?: boolean; recoveryCodes?: string[] }
    expect(body.ok).toBe(true)
    expect(body.recoveryCodes).toHaveLength(10)

    const st = await statusOf(u)
    expect(st.enabled).toBe(true)
    expect(st.emailEnabled).toBe(true)
    expect(st.recoveryLeft).toBe(10)
  })

  it("只凭会话开启 TOTP ⇒ 400 NEED_PASSWORD，且库里不落任何未确认密钥", async () => {
    const u = await makeUser()

    const denied = await post(u, "/api/settings/2fa/totp/start", {})
    expect(denied.status).toBe(400)
    expect(await codeOf(denied)).toBe("NEED_PASSWORD")
    // 旧实现会在这里写一行 totp_confirmed=0 的密钥（confirm 的信任来源）；
    // 现在 start 不再落库，密钥只放在加密票据里。
    expect(await twoFactorRows(u.id)).toBe(0)
  })

  it("TOTP 绑定全链路：confirm 必须带 start 下发的票据，伪造/缺失都绑不上", async () => {
    const u = await makeUser()

    const start = await post(u, "/api/settings/2fa/totp/start", { password: PASSWORD })
    expect(start.status).toBe(200)
    const started = (await start.json()) as { secret?: string; setupToken?: string }
    const secret = String(started.secret ?? "")
    const setupToken = String(started.setupToken ?? "")
    expect(secret.length).toBeGreaterThan(0)
    expect(setupToken.length).toBeGreaterThan(0)
    // confirm 之前不落库
    expect(await twoFactorRows(u.id)).toBe(0)

    const code = await currentTotp(secret)

    // ① 不带票据：即使动态码算对了也不能绑（旧实现这里就能成功）
    const noTicket = await post(u, "/api/settings/2fa/totp/confirm", { code })
    expect(noTicket.status).toBe(400)
    expect(await codeOf(noTicket)).toBe("INVALID_INPUT")

    // ② 伪造票据：解密失败，按「配置已失效」处理
    const forged = await post(u, "/api/settings/2fa/totp/confirm", {
      code,
      setupToken: "v1:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBB",
    })
    expect(forged.status).toBe(400)
    expect(await codeOf(forged)).toBe("SETUP_EXPIRED")

    // ③ 正确票据 + 正确动态码 ⇒ 绑定成功并发 10 个恢复码
    const ok = await post(u, "/api/settings/2fa/totp/confirm", { code, setupToken })
    expect(ok.status).toBe(200)
    const okBody = (await ok.json()) as { recoveryCodes?: string[] }
    expect(okBody.recoveryCodes).toHaveLength(10)

    const st = await statusOf(u)
    expect(st.enabled).toBe(true)
    expect(st.totpConfirmed).toBe(true)
    expect(await twoFactorRows(u.id)).toBe(1)
  })

  it("别人的 setupToken 不能用在自己账号上", async () => {
    const a = await makeUser()
    const b = await makeUser()
    const start = await post(a, "/api/settings/2fa/totp/start", { password: PASSWORD })
    const started = (await start.json()) as { secret?: string; setupToken?: string }

    const res = await post(b, "/api/settings/2fa/totp/confirm", {
      code: await currentTotp(String(started.secret ?? "")),
      setupToken: String(started.setupToken ?? ""),
    })
    expect(res.status).toBe(400)
    expect(await codeOf(res)).toBe("SETUP_EXPIRED")
    expect(await twoFactorRows(b.id)).toBe(0)
  })

  it("已开 TOTP 的账号：新增因子只给密码不够，还要当前验证码", async () => {
    const u = await makeUser()
    await seedConfirmedTotp(u.id)

    // 只有密码 ⇒ 停在「请输入当前可用的验证码」
    const onlyPassword = await post(u, "/api/settings/2fa/totp/start", { password: PASSWORD })
    expect(onlyPassword.status).toBe(400)
    expect(await codeOf(onlyPassword)).toBe("INVALID_INPUT")
  })

  it("「重新配置」不会把已确认的 TOTP 打回未确认（放弃/中断也不降级）", async () => {
    const u = await makeUser()
    const secret = await seedConfirmedTotp(u.id)

    const res = await post(u, "/api/settings/2fa/totp/start", {
      password: PASSWORD,
      code: await currentTotp(secret),
    })
    expect(res.status).toBe(200)

    // 旧实现：start 就把 totp_confirmed 置 0 → 只开 TOTP 的账号等于被关掉 2FA。
    const st = await statusOf(u)
    expect(st.enabled).toBe(true)
    expect(st.totpConfirmed).toBe(true)
  })
})
