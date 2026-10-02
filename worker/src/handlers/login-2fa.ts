/**
 * 登录第二步：二次验证（2FA）。
 *
 * 与 `handlers/auth.ts::login` 的分工：
 *   · `login` 负责第一关（口令）—— 通过后若该用户要求 2FA，**不建 session**，
 *     而是返回一个 challengeId；
 *   · 本文件负责第二关 —— 校验邮箱码 / 动态码 / 恢复码，**通过才建 session**。
 *
 * ⚠️ 这个文件是整个 2FA 的成败所在，两条纪律：
 *   1. **验证通过前绝不下发 session**（`completeLogin` 只在成功分支调用）；
 *   2. 每一步都要重新核对「挑战还活着 + 它确实属于这个人」，
 *      不能因为请求里带了 challengeId 就信。
 */
import { ApiError, json } from "../http"
import { clientIp, guardRateLimit } from "../ratelimit"
import { audit as recordAudit } from "../settings"
import type { UserRow } from "../auth"
import type { Env } from "../env"
import { completeLogin } from "./auth"
import {
  bumpChallengeAttempts,
  consumeChallenge,
  issueEmailCode,
  loadLiveChallenge,
  verifyEmailCode,
  verifyRecoveryCode,
  verifyUserTotp,
} from "./two-factor"

/** 挑战相关接口的限流：按 IP 记一次，挡住脚本爆破 */
const CHALLENGE_IP_LIMIT = 30

/**
 * POST /api/login/2fa —— 提交二次验证。
 * body: `{ challengeId, method: "email" | "totp" | "recovery", code }`
 */
export async function verifyLoginTwoFactor(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    challengeId?: string
    method?: string
    code?: string
  }
  const challengeId = String(body.challengeId ?? "").trim()
  const method = String(body.method ?? "").trim()
  const code = String(body.code ?? "").trim()
  if (!challengeId || !method || !code) {
    throw new ApiError(400, "参数不完整", "INVALID_INPUT")
  }

  // 按 IP 限流：挑战本身也有次数上限，但那个是「同一个挑战」的维度，
  // 脚本可以不断新建挑战来绕开，所以这里再按 IP 兜一层
  await guardRateLimit(
    env,
    `2fa-verify:ip:${clientIp(request)}`,
    CHALLENGE_IP_LIMIT,
    300,
    "验证尝试过于频繁，请稍后再试"
  )

  const challenge = await loadLiveChallenge(env, challengeId)
  if (!challenge) {
    throw new ApiError(400, "验证已超时，请重新登录", "CHALLENGE_EXPIRED")
  }
  // 这个挑战是否允许该方式（防止用没启用的方式绕过）
  if (!challenge.methods.includes(method)) {
    throw new ApiError(400, "该验证方式不可用", "INVALID_METHOD")
  }

  let ok = false
  if (method === "email") {
    ok = await verifyEmailCode(env, challenge.id, code)
  } else if (method === "totp") {
    ok = await verifyUserTotp(env, challenge.user_id, code)
  } else if (method === "recovery") {
    ok = await verifyRecoveryCode(env, challenge.user_id, code)
  } else {
    throw new ApiError(400, "不支持的验证方式", "INVALID_METHOD")
  }

  if (!ok) {
    await bumpChallengeAttempts(env, challenge.id)
    // 文案不区分「码错了」和「方式不对」，避免给爆破者反馈
    throw new ApiError(400, "验证码不正确", "INVALID_CODE")
  }

  // 验证通过 —— 这时才允许把用户捞出来建登录态
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(challenge.user_id)
    .first<UserRow>()
  if (!user) {
    await consumeChallenge(env, challenge.id)
    throw new ApiError(401, "账号不存在", "INVALID_CREDENTIALS")
  }
  // ⚠️ 挑战有效期内账号可能被封禁 —— 这里必须再查一次状态，
  // 否则「先发起登录、后被封」的人能借着挂起的挑战钻进来
  if (user.status !== "active") {
    await consumeChallenge(env, challenge.id)
    throw new ApiError(403, "账号已被停用", "ACCOUNT_SUSPENDED")
  }

  await consumeChallenge(env, challenge.id)
  await recordAudit(
    env,
    user.id,
    "login.2fa",
    `二次验证通过（${method}）`,
    clientIp(request)
  )
  return completeLogin(env, user)
}

/**
 * POST /api/login/2fa/send-email —— 给当前挑战的账号发一封验证码邮件。
 * body: `{ challengeId }`
 */
export async function sendLoginTwoFactorEmail(
  env: Env,
  request: Request
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { challengeId?: string }
  const challengeId = String(body.challengeId ?? "").trim()
  if (!challengeId) throw new ApiError(400, "参数不完整", "INVALID_INPUT")

  const challenge = await loadLiveChallenge(env, challengeId)
  if (!challenge) {
    throw new ApiError(400, "验证已超时，请重新登录", "CHALLENGE_EXPIRED")
  }
  if (!challenge.methods.includes("email")) {
    throw new ApiError(400, "该账号未启用邮箱验证", "INVALID_METHOD")
  }

  // ⚠️ 收件地址取自**挑战绑定的 userId**，不是请求里的任何字段 ——
  // 否则别人拿一个 challengeId 就能往任意邮箱刷验证码
  await issueEmailCode(env, challenge.id, challenge.user_id)
  return json({ ok: true })
}
