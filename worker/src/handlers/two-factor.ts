/**
 * 二次认证（2FA）：状态、校验、以及用户自己管理它的接口。
 *
 * ── 为什么要做 ──
 * 管理员 / 站长的账号一旦口令泄露，等于整个后台易主（能改配置、看所有人数据、
 * 甚至清掉别人的账号）。所以对他们**强制**要求登录时再过一道验证；
 * 普通用户则在设置里自选。策略只差一个开关，代码路径是同一条。
 *
 * ── 三种验证方式 ──
 * · `email`    —— 邮箱收 6 位码。零硬件依赖，是管理员「总能进得去」的保底方式；
 * · `totp`     —— 认证器 App 的 30 秒动态码。体验最好，离线可用；
 * · `recovery` —— 一次性恢复码。**手机丢了/认证器删了的唯一自救手段**，必须发。
 *
 * ── 安全上必须守住的几条 ──
 * 1. 口令校验通过但 2FA 未过时，**绝不能下发 session**（见 auth.ts 的闸门）；
 * 2. TOTP 密钥**加密存储**（`encryptSecret`，密钥取 `SESSION_SECRET`）——
 *    明文落库等于拿到库就拿到所有人的动态口令；
 * 3. 恢复码只存 sha256、用过即废；
 * 4. 动态码 / 验证码的尝试次数有上限，防在线爆破；
 * 5. **任何方式都不能把管理员彻底锁死** —— 见 `evaluateTwoFactorGate` 的宽限逻辑。
 */
import { ApiError, json } from "../http"
import { requireUser, isPrivileged } from "../auth"
import { hashToken, uuid, timingSafeEqual, encryptSecret, decryptSecret } from "../crypto"
import { guardRateLimit } from "../ratelimit"
import { sendMail, renderMail } from "../mailer"
import { audit as recordAudit } from "../settings"
import {
  generateRecoveryCode,
  generateTotpSecret,
  totpAuthUrl,
  verifyTotp,
} from "../totp"
import type { Env } from "../env"

/** 邮箱码 / 动态码的有效期 */
const CODE_TTL_MS = 5 * 60 * 1000
/** 单个挑战允许的验证尝试次数（超过即作废，防在线爆破） */
export const MAX_CHALLENGE_ATTEMPTS = 5
/** 挑战本身的有效期（口令已验证通过后的挂起时间） */
export const CHALLENGE_TTL_MS = 10 * 60 * 1000
/** 恢复码张数 */
const RECOVERY_CODE_COUNT = 10

/** 强制要求 2FA 的角色。管理员与站长都在内。 */
const ENFORCED_ROLES = ["admin", "root"] as const

/**
 * 取加密密钥。
 *
 * `SESSION_SECRET` 在类型上是可选的（本地开发可能没配），但 TOTP 密钥的加密
 * 强依赖它 —— 缺了必须**明确报错**，而不是把 `undefined` 当密钥传下去
 * （那样会派生出一个「能用但等于没加密」的密钥，比直接报错危险得多）。
 */
function requireSecret(env: Env): string {
  if (!env.SESSION_SECRET) {
    throw new ApiError(500, "服务端未配置加密密钥，无法启用二次认证", "CONFIG_ERROR")
  }
  return env.SESSION_SECRET
}

export interface TwoFactorState {
  /** 是否配了至少一种可用方式 */
  enabled: boolean
  /** 启用的方式（用于前端展示与登录时选择） */
  methods: string[]
  /** 是否已配置 TOTP（区分「配了但没确认」） */
  totpConfirmed: boolean
  emailEnabled: boolean
  /** 尚未用掉的恢复码张数 */
  recoveryLeft: number
}

/** 读某个用户的 2FA 状态 */
export async function loadTwoFactorState(
  env: Env,
  userId: string
): Promise<TwoFactorState> {
  const row = await env.DB.prepare(
    `SELECT totp_secret, totp_confirmed, email_enabled FROM user_2fa WHERE user_id = ?`
  )
    .bind(userId)
    .first<{ totp_secret: string | null; totp_confirmed: number; email_enabled: number }>()

  const rec = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM user_2fa_recovery WHERE user_id = ? AND used_at IS NULL`
  )
    .bind(userId)
    .first<{ n: number }>()

  const totpConfirmed = Boolean(row?.totp_confirmed && row.totp_secret)
  const emailEnabled = Boolean(row?.email_enabled)
  const methods: string[] = []
  if (emailEnabled) methods.push("email")
  if (totpConfirmed) methods.push("totp")
  if ((rec?.n ?? 0) > 0) methods.push("recovery")

  return {
    enabled: methods.length > 0,
    methods,
    totpConfirmed,
    emailEnabled,
    recoveryLeft: rec?.n ?? 0,
  }
}

/** 该角色是否被强制要求 2FA */
export function isTwoFactorEnforced(role: string): boolean {
  return (ENFORCED_ROLES as readonly string[]).includes(role)
}

export interface TwoFactorGate {
  /** 是否要拦住这次登录、走二次验证 */
  needChallenge: boolean
  /** 可用方式（needChallenge 为 true 时有意义） */
  methods: string[]
}

/**
 * 登录闸门：判断这次登录要不要再验一道。
 *
 * ── 最关键的一条：不能把管理员锁死 ──
 * 强制 ≠ 一上线就拦。如果管理员**还没配任何方式**就直接拦，
 * 他会当场进不去后台 —— 而这恰恰是我们最想避免的事。
 * 所以：**已配置 ⇒ 拦；未配置 ⇒ 放行，但前端据 `mustSetup` 强制他跳去设置页**。
 * 换句话说，「强制」体现在「不配就一直被提示、功能受限」，而不是「一次都别想进」。
 */
export async function evaluateTwoFactorGate(
  env: Env,
  user: { id: string; role: string }
): Promise<TwoFactorGate & { mustSetup: boolean }> {
  const enforced = isTwoFactorEnforced(user.role)
  const state = await loadTwoFactorState(env, user.id)

  if (state.enabled) {
    // 配了就一定验 —— 无论角色。普通用户自愿开启后同样受保护。
    return { needChallenge: true, methods: state.methods, mustSetup: false }
  }

  // 没配任何方式：管理员需要去配，但不拦这一次登录（见上面的说明）
  return { needChallenge: false, methods: [], mustSetup: enforced }
}

/** 邮箱脱敏：只留首字符与域名，用于「码发到哪了」的提示 */
export function maskEmail(email: string): string {
  const at = email.indexOf("@")
  if (at <= 0) return "***"
  const name = email.slice(0, at)
  const domain = email.slice(at)
  const head = name.slice(0, 1)
  return `${head}${"*".repeat(Math.max(1, Math.min(name.length - 1, 4)))}${domain}`
}

// ────────────────────────── 登录挑战 ──────────────────────────

/**
 * 口令已通过、但二次验证还没过时，建一条挂起的挑战。
 *
 * ⚠️ 挑战是「半张门票」：它**不代表已登录**，只代表「口令这一关过了」。
 * 所以它单独一张表、独立过期，绝不能被当成 session 用。
 */
export async function createLoginChallenge(
  env: Env,
  user: { id: string },
  methods: string[],
  request: Request
): Promise<{ id: string; expiresAt: string }> {
  const id = uuid()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString()
  // 顺手清掉这个用户已过期的旧挑战，避免表里越积越多
  await env.DB.prepare(
    `DELETE FROM login_challenges WHERE user_id = ? AND expires_at < ?`
  )
    .bind(user.id, now.toISOString())
    .run()
  await env.DB.prepare(
    `INSERT INTO login_challenges (id, user_id, methods, attempts, expires_at, created_at, ip)
     VALUES (?, ?, ?, 0, ?, ?, ?)`
  )
    .bind(
      id,
      user.id,
      JSON.stringify(methods),
      expiresAt,
      now.toISOString(),
      request.headers.get("CF-Connecting-IP") ?? ""
    )
    .run()
  return { id, expiresAt }
}

/** 读一条挑战并校验它还有效；无效返回 null */
export async function loadLiveChallenge(
  env: Env,
  challengeId: string
): Promise<{ id: string; user_id: string; methods: string[]; attempts: number } | null> {
  const row = await env.DB.prepare(
    `SELECT id, user_id, methods, attempts, expires_at FROM login_challenges WHERE id = ?`
  )
    .bind(challengeId)
    .first<{
      id: string
      user_id: string
      methods: string
      attempts: number
      expires_at: string
    }>()
  if (!row) return null
  if (Date.parse(row.expires_at) < Date.now()) return null
  if (row.attempts >= MAX_CHALLENGE_ATTEMPTS) return null
  let methods: string[] = []
  try {
    const parsed = JSON.parse(row.methods)
    if (Array.isArray(parsed)) methods = parsed.filter((m) => typeof m === "string")
  } catch {
    methods = []
  }
  return { id: row.id, user_id: row.user_id, methods, attempts: row.attempts }
}

/** 记一次失败的验证尝试；达到上限就把挑战作废 */
export async function bumpChallengeAttempts(env: Env, challengeId: string): Promise<void> {
  const row = await env.DB.prepare(
    `UPDATE login_challenges SET attempts = attempts + 1 WHERE id = ? RETURNING attempts`
  )
    .bind(challengeId)
    .first<{ attempts: number }>()
  if (row && row.attempts >= MAX_CHALLENGE_ATTEMPTS) {
    // 连错太多次 → 直接作废，逼对方重新走一遍口令
    await env.DB.prepare(`DELETE FROM login_challenges WHERE id = ?`).bind(challengeId).run()
  }
}

/** 挑战用完后删掉（成功登录时） */
export async function consumeChallenge(env: Env, challengeId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM login_challenges WHERE id = ?`).bind(challengeId),
    env.DB.prepare(`DELETE FROM login_email_codes WHERE challenge_id = ?`).bind(challengeId),
  ])
}

/**
 * 为某个挑战生成并发送邮箱验证码。
 *
 * ⚠️ 这里**必须重新校验挑战归属**：否则知道别人 challengeId 的人
 * 就能往受害者邮箱里刷验证码（骚扰 + 消耗发信额度）。
 */
export async function issueEmailCode(
  env: Env,
  challengeId: string,
  userId: string
): Promise<void> {
  await guardRateLimit(env, `2fa-mail:${userId}`, 5, 300, "验证码发送过于频繁，请稍后再试")

  const user = await env.DB.prepare(`SELECT email, email_verified FROM users WHERE id = ?`)
    .bind(userId)
    .first<{ email: string; email_verified: number }>()
  if (!user) throw new ApiError(404, "找不到这个用户", "NOT_FOUND")
  if (user.email_verified !== 1) {
    throw new ApiError(400, "这个账号的邮箱还没验证，无法用邮箱验证", "EMAIL_NOT_VERIFIED")
  }

  // 6 位数字，用 crypto 取随机（Math.random 可预测，不能用于验证码）
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  const code = String(buf[0] % 1_000_000).padStart(6, "0")
  const now = new Date()
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS).toISOString()

  await env.DB.prepare(
    `INSERT INTO login_email_codes (challenge_id, code_hash, expires_at, attempts, created_at)
     VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(challenge_id) DO UPDATE SET code_hash = excluded.code_hash,
       expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at`
  )
    .bind(challengeId, await hashToken(code), expiresAt, now.toISOString())
    .run()

  await sendLoginCodeMail(env, user.email, code)
}

// ────────────────────────── 校验 ──────────────────────────

/** 校验邮箱验证码（挂在挑战上，用完即删） */
export async function verifyEmailCode(
  env: Env,
  challengeId: string,
  code: string
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT code_hash, expires_at, attempts FROM login_email_codes WHERE challenge_id = ?`
  )
    .bind(challengeId)
    .first<{ code_hash: string; expires_at: string; attempts: number }>()
  if (!row) return false
  if (Date.parse(row.expires_at) < Date.now()) return false
  if (row.attempts >= MAX_CHALLENGE_ATTEMPTS) return false

  const ok = timingSafeEqual(row.code_hash, await hashToken(code.trim()))
  if (!ok) {
    await env.DB.prepare(
      `UPDATE login_email_codes SET attempts = attempts + 1 WHERE challenge_id = ?`
    )
      .bind(challengeId)
      .run()
    return false
  }
  // 用过即删：同一串码不能再用第二次
  await env.DB.prepare(`DELETE FROM login_email_codes WHERE challenge_id = ?`)
    .bind(challengeId)
    .run()
  return true
}

/** 校验 TOTP 动态码 */
export async function verifyUserTotp(
  env: Env,
  userId: string,
  code: string
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT totp_secret, totp_confirmed FROM user_2fa WHERE user_id = ?`
  )
    .bind(userId)
    .first<{ totp_secret: string | null; totp_confirmed: number }>()
  if (!row?.totp_secret || !row.totp_confirmed) return false
  try {
    const secret = await decryptSecret(row.totp_secret, requireSecret(env))
    return await verifyTotp(secret, code)
  } catch (err) {
    // 解密失败（比如 SESSION_SECRET 换过）不能让请求 500，按校验不通过处理
    console.error("解密 TOTP 密钥失败:", userId, err)
    return false
  }
}

/** 校验恢复码（一次性，用过即废） */
export async function verifyRecoveryCode(
  env: Env,
  userId: string,
  code: string
): Promise<boolean> {
  const hash = await hashToken(code.trim().toLowerCase())
  const row = await env.DB.prepare(
    `SELECT code_hash FROM user_2fa_recovery WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`
  )
    .bind(userId, hash)
    .first<{ code_hash: string }>()
  if (!row) return false
  await env.DB.prepare(
    `UPDATE user_2fa_recovery SET used_at = ? WHERE user_id = ? AND code_hash = ?`
  )
    .bind(new Date().toISOString(), userId, hash)
    .run()
  return true
}

// ────────────────────────── 设置接口 ──────────────────────────

/** GET /api/settings/2fa —— 我的 2FA 现状（含「是否被强制」） */
export async function getTwoFactorSettings(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const state = await loadTwoFactorState(env, user.id)
  return json({
    ...state,
    /** 被强制要求（管理员/站长）—— 前端据此显示「必须开启」而不是「可选」 */
    enforced: isTwoFactorEnforced(user.role),
    maskedEmail: maskEmail(user.email),
  })
}

/**
 * POST /api/settings/2fa/totp/start —— 生成密钥并返回二维码链接。
 *
 * ⚠️ 此时**不落库**：用户还没证明自己扫成功了。密钥先放在响应里，
 * 等 `/totp/confirm` 带着正确的动态码回来才写库 ——
 * 否则「扫了但没配对」也会把账号标成已开启，下次登录直接进不去。
 */
export async function startTotpSetup(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  await guardRateLimit(env, `2fa-setup:${user.id}`, 10, 60, "操作过于频繁")

  const secret = generateTotpSecret()
  const enc = await encryptSecret(secret, requireSecret(env))
  const now = new Date().toISOString()
  // 先以「未确认」状态写入（totp_confirmed = 0），confirm 时再置 1
  await env.DB.prepare(
    `INSERT INTO user_2fa (user_id, totp_secret, totp_confirmed, email_enabled, created_at, updated_at)
     VALUES (?, ?, 0, 0, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET totp_secret = excluded.totp_secret,
       totp_confirmed = 0, updated_at = excluded.updated_at`
  )
    .bind(user.id, enc, now, now)
    .run()

  return json({
    secret,
    // 前端用 qrcode 库把这个链接画成二维码
    otpauthUrl: totpAuthUrl({
      secret,
      account: user.username,
      issuer: "Doulor Cloud",
    }),
  })
}

/** POST /api/settings/2fa/totp/confirm {code} —— 验证动态码并正式启用，同时发放恢复码 */
export async function confirmTotpSetup(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json().catch(() => ({}))) as { code?: string }
  const code = String(body.code ?? "").trim()
  if (!code) throw new ApiError(400, "请输入认证器上的 6 位数字", "INVALID_INPUT")

  const row = await env.DB.prepare(
    `SELECT totp_secret FROM user_2fa WHERE user_id = ?`
  )
    .bind(user.id)
    .first<{ totp_secret: string | null }>()
  if (!row?.totp_secret) throw new ApiError(400, "请先开始设置", "INVALID_INPUT")

  let ok = false
  try {
    const secret = await decryptSecret(row.totp_secret, requireSecret(env))
    ok = await verifyTotp(secret, code)
  } catch {
    ok = false
  }
  if (!ok) throw new ApiError(400, "验证码不正确，请确认手机时间是否准确", "INVALID_CODE")

  const now = new Date().toISOString()
  await env.DB.prepare(
    `UPDATE user_2fa SET totp_confirmed = 1, updated_at = ? WHERE user_id = ?`
  )
    .bind(now, user.id)
    .run()

  // 开启成功时发一批恢复码（只在这一次明文返回，之后库里只有哈希）
  const codes = await regenerateRecoveryCodesFor(env, user.id)
  await recordAudit(env, user.id, "2fa.totp.enable", "开启 TOTP 二次认证")
  return json({ ok: true, recoveryCodes: codes })
}

/** 生成一批新恢复码，旧的作废。返回明文（仅此一次） */
async function regenerateRecoveryCodesFor(env: Env, userId: string): Promise<string[]> {
  const codes: string[] = []
  const stmts = [env.DB.prepare(`DELETE FROM user_2fa_recovery WHERE user_id = ?`).bind(userId)]
  const now = new Date().toISOString()
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const code = generateRecoveryCode()
    codes.push(code)
    stmts.push(
      env.DB.prepare(
        `INSERT INTO user_2fa_recovery (user_id, code_hash, used_at, created_at) VALUES (?, ?, NULL, ?)`
      ).bind(userId, await hashToken(code), now)
    )
  }
  await env.DB.batch(stmts)
  return codes
}

/** POST /api/settings/2fa/recovery/regenerate —— 重新生成恢复码（旧的全部作废） */
export async function regenerateRecoveryCodes(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  await guardRateLimit(env, `2fa-rec:${user.id}`, 5, 60, "操作过于频繁")
  const codes = await regenerateRecoveryCodesFor(env, user.id)
  await recordAudit(env, user.id, "2fa.recovery.regenerate", "重新生成恢复码")
  return json({ recoveryCodes: codes })
}

/** POST /api/settings/2fa/email {enabled} —— 开关邮箱验证方式 */
export async function setEmailTwoFactor(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json().catch(() => ({}))) as { enabled?: boolean }
  const enabled = Boolean(body.enabled)

  // 开启前必须邮箱已验证 —— 否则码会发到一个不属于他的地址，等于没验
  if (enabled && user.email_verified !== 1) {
    throw new ApiError(400, "请先验证邮箱后再开启这种方式", "EMAIL_NOT_VERIFIED")
  }

  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO user_2fa (user_id, totp_secret, totp_confirmed, email_enabled, created_at, updated_at)
     VALUES (?, NULL, 0, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET email_enabled = excluded.email_enabled,
       updated_at = excluded.updated_at`
  )
    .bind(user.id, enabled ? 1 : 0, now, now)
    .run()

  await recordAudit(
    env,
    user.id,
    enabled ? "2fa.email.enable" : "2fa.email.disable",
    enabled ? "开启邮箱二次认证" : "关闭邮箱二次认证"
  )
  return json({ ok: true, emailEnabled: enabled })
}

/**
 * POST /api/settings/2fa/disable {code} —— 关掉全部 2FA。
 *
 * ⚠️ 必须**先验一个当前有效的码**才能关：否则谁拿到一个没锁屏的浏览器，
 * 就能直接把受害者的二次认证卸掉，等于这道锁形同虚设。
 * 被强制的角色（管理员/站长）**不允许自行关闭** —— 只能由 root 重置。
 */
export async function disableTwoFactor(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  if (isTwoFactorEnforced(user.role)) {
    throw new ApiError(
      403,
      "管理员账号必须开启二次认证，无法自行关闭；如需重置请联系站长",
      "FORBIDDEN"
    )
  }
  const body = (await request.json().catch(() => ({}))) as { code?: string }
  const code = String(body.code ?? "").trim()
  if (!code) throw new ApiError(400, "请输入当前的验证码", "INVALID_INPUT")

  // 任意一种当前有效的方式都算证明
  const ok =
    (await verifyUserTotp(env, user.id, code)) ||
    (await verifyRecoveryCode(env, user.id, code))
  if (!ok) throw new ApiError(400, "验证码不正确", "INVALID_CODE")

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM user_2fa WHERE user_id = ?`).bind(user.id),
    env.DB.prepare(`DELETE FROM user_2fa_recovery WHERE user_id = ?`).bind(user.id),
  ])
  await recordAudit(env, user.id, "2fa.disable", "关闭二次认证")
  return json({ ok: true })
}

/**
 * POST /api/admin/users/:id/2fa/reset —— 清掉某人的 2FA。
 *
 * 这是**最后一道保险**：管理员手机丢了、认证器删了、密码还记得但进不去时，
 * 由站长（root）把这道锁拆掉让他重新登录。
 * 只有 root 能做 —— admin 之间互相拆锁等于这道锁可以被内部人绕过。
 */
export async function adminResetTwoFactor(env: Env, request: Request): Promise<Response> {
  const admin = await requireUser(env, request)
  if (!isPrivileged(admin.role) || admin.role !== "root") {
    throw new ApiError(403, "只有站长可以重置他人的二次认证", "FORBIDDEN")
  }
  const body = (await request.json().catch(() => ({}))) as { userId?: string }
  const userId = String(body.userId ?? "").trim()
  if (!userId) throw new ApiError(400, "缺少用户", "INVALID_INPUT")

  const target = await env.DB.prepare(`SELECT username FROM users WHERE id = ?`)
    .bind(userId)
    .first<{ username: string }>()
  if (!target) throw new ApiError(404, "找不到这个用户", "NOT_FOUND")

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM user_2fa WHERE user_id = ?`).bind(userId),
    env.DB.prepare(`DELETE FROM user_2fa_recovery WHERE user_id = ?`).bind(userId),
    // 未完成的登录挑战一并清掉，避免残留
    env.DB.prepare(`DELETE FROM login_challenges WHERE user_id = ?`).bind(userId),
  ])
  await recordAudit(
    env,
    admin.id,
    "2fa.admin.reset",
    `重置 ${target.username} 的二次认证`
  )
  return json({ ok: true })
}

/** 发登录验证码邮件（供 auth.ts 的登录流程调用） */
export async function sendLoginCodeMail(
  env: Env,
  to: string,
  code: string
): Promise<void> {
  const rendered = renderMail(
    "登录验证码",
    [
      `你正在登录 Doulor Cloud，验证码是：${code}`,
      `验证码 ${CODE_TTL_MS / 60000} 分钟内有效。如果这不是你本人的操作，说明有人已经知道了你的密码，请立刻修改密码。`,
    ],
    code
  )
  await sendMail(env, {
    to,
    subject: "Doulor Cloud 登录验证码",
    text: rendered.text,
    html: rendered.html,
  })
}
