// 2FA 设置的「二次认证」（step-up）回归测试。
//
// 背景（2026-10-10 渗透测试 finding#8/#9）：逐方法的 2FA 开关原先**只凭会话 cookie**
// 就能调用 —— 偷到 cookie 的人可以静默把受害者的第二因子拆掉、或者换成自己的认证器。
// 站长定的规则：改动 2FA 设置时必须验证**已开启的方式** ——
//   关 TOTP → 认 TOTP 动态码或恢复码；关邮箱 → 认邮箱验证码；两者都开 → 关哪个验哪个。
//
// 2026-11-10 渗透测试 finding#1/#5 又补了一条：**新增因子**（开启邮箱验证 / 绑定认证器）
// 还需要账户密码 —— 账号本来没有 2FA 时，「已开启的方式」一个都不存在，只靠会话
// 等于没有门槛，攻击者可以无码开启并领走恢复码，再拿恢复码当 step-up 码绑自己的认证器。
//
// ⚠️ 这里用**恢复码**来验证「可以关」的路径：它不需要在测试里实现 TOTP 算法。
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, type TestUser } from "./helpers"
import { encryptSecret, hashToken } from "../src/crypto"

const JSON_HEADERS = { "Content-Type": "application/json" }

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

/** 造一个「TOTP 已确认 + 持有一枚恢复码」的账号 */
async function seedTotpWithRecovery(userId: string, recoveryCode: string): Promise<void> {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO user_2fa (user_id, totp_secret, totp_confirmed, email_enabled, created_at, updated_at)
     VALUES (?, ?, 1, 0, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET totp_confirmed = 1, updated_at = excluded.updated_at`
  )
    .bind(userId, await encryptSecret("seed-secret", env.SESSION_SECRET!), now, now)
    .run()
  await env.DB.prepare(
    `INSERT INTO user_2fa_recovery (user_id, code_hash, used_at, created_at) VALUES (?, ?, NULL, ?)`
  )
    // ⚠️ 校验侧是 `hashToken(code.trim().toLowerCase())`（见 verifyRecoveryCode），
    // 所以这里也必须按小写存 hash，否则永远对不上。
    .bind(userId, await hashToken(recoveryCode.trim().toLowerCase()), now)
    .run()
}

describe("2FA 改动需要二次验证（finding#8/#9）", () => {
  it("已开 TOTP：不带验证码关不掉，带恢复码可以关", async () => {
    const u = await makeUser()
    await seedTotpWithRecovery(u.id, "RECOVERY-ONE")

    // 只凭会话 cookie（旧行为）⇒ 现在必须被拦
    const denied = await post(u, "/api/settings/2fa/totp/disable", {})
    expect(denied.status).toBe(400)
    expect(await codeOf(denied)).toBe("INVALID_INPUT")

    // 错码同样不行
    const wrong = await post(u, "/api/settings/2fa/totp/disable", { code: "00000000" })
    expect(wrong.status).toBe(400)
    expect(await codeOf(wrong)).toBe("INVALID_CODE")

    // 恢复码是「所有方式的最后退路」⇒ 放行
    const ok = await post(u, "/api/settings/2fa/totp/disable", { code: "RECOVERY-ONE" })
    expect(ok.status).toBe(200)

    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM user_2fa_recovery WHERE user_id = ? AND used_at IS NULL"
    )
      .bind(u.id)
      .first<{ c: number }>()
    expect(left?.c ?? 0).toBe(0) // 恢复码一次性，用过即废
  })

  it("重生成恢复码也必须先验码", async () => {
    const u = await makeUser()
    await seedTotpWithRecovery(u.id, "RECOVERY-TWO")

    const denied = await post(u, "/api/settings/2fa/recovery/regenerate", {})
    expect(denied.status).toBe(400)

    const ok = await post(u, "/api/settings/2fa/recovery/regenerate", { code: "RECOVERY-TWO" })
    expect(ok.status).toBe(200)
  })

  it("只开邮箱验证：不带码关不掉", async () => {
    const u = await makeUser()
    // 首次开启（账号还没有任何 2FA）⇒ 走「账户密码」这一层重新认证
    // （2026-11-10 渗透 finding#1/#5：原来只凭会话 cookie 就能无码开启）。
    const on = await post(u, "/api/settings/2fa/email", {
      enabled: true,
      password: "pass1234",
    })
    expect(on.status).toBe(200)

    // 关闭时必须验邮箱验证码（测试里拿不到邮箱码 ⇒ 必然是「请输入验证码」）
    const off = await post(u, "/api/settings/2fa/email", { enabled: false })
    expect(off.status).toBe(400)
    expect(await codeOf(off)).toBe("INVALID_INPUT")
  })

  it("首次开启 TOTP 也要账户密码，且 start / confirm 之间靠票据串起来", async () => {
    const u = await makeUser()

    // 只凭会话（旧行为）⇒ 现在必须被拦
    const denied = await post(u, "/api/settings/2fa/totp/start", {})
    expect(denied.status).toBe(400)
    expect(await codeOf(denied)).toBe("NEED_PASSWORD")

    // 带上账户密码 ⇒ 200 + 密钥 + 绑定票据（finding#1：confirm 必须带这张票据）
    const res = await post(u, "/api/settings/2fa/totp/start", { password: "pass1234" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { secret?: string; setupToken?: string }
    expect(body.secret).toEqual(expect.any(String))
    expect(body.setupToken).toEqual(expect.any(String))
  })

  it("邮箱码必须带 challengeId 才算数（不能凭空传个数字过关）", async () => {
    const u = await makeUser()
    await seedTotpWithRecovery(u.id, "RECOVERY-THREE")

    const res = await post(u, "/api/settings/2fa/totp/disable", {
      code: "123456",
      challengeId: "not-a-real-challenge",
    })
    expect(res.status).toBe(400)
    expect(await codeOf(res)).toBe("INVALID_CODE")
  })
})
