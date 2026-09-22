/**
 * 账户设置：真实邮箱验证、通知开关、修改用户名 / 真实邮箱。
 *
 * 关于「真实邮箱验证」为什么这样做：
 *   Cloudflare Email Service 规定，在把发送域名 Onboard（付费/需面板操作）之前，
 *   Worker 只能发往账户内**已验证的 destination address**。
 *   而「注册为 destination address」正是 Cloudflare 免费提供的验证流程：
 *   `POST /accounts/<id>/email/routing/addresses` 会让 Cloudflare 给该邮箱
 *   发一封验证邮件，用户点链接后 `verified` 才有值。
 *
 *   于是「验证真实邮箱」= 调用 cfEnsureDestination + 轮询其 verified 状态。
 *   验证通过后该地址即成为已验证目标地址，我们就能免费给它发通知/验证码。
 *   不需要 SMTP，也不需要为 Email Sending 付费。
 */
import { ApiError, json } from "../http"
import { requireUser, toPublicUser, type UserRow } from "../auth"
import { uuid } from "../crypto"
import { cfEnsureDestination, cfListDestinations } from "../cloudflare"
import { isReservedName } from "../reserved-names"
import { audit } from "../settings"
import type { Env } from "../env"

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function isValidUsername(username: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(username)
}

/** 查询某个邮箱在 Cloudflare 侧的验证状态 */
async function destinationStatus(
  env: Env,
  email: string
): Promise<{ exists: boolean; verified: boolean }> {
  try {
    const list = await cfListDestinations(env)
    const found = list.find((d) => d.email.toLowerCase() === email.toLowerCase())
    if (!found) return { exists: false, verified: false }
    return { exists: true, verified: found.verified !== null }
  } catch (err) {
    console.error("查询转发地址状态失败:", err)
    return { exists: false, verified: false }
  }
}

// ---- GET /api/settings/email —— 当前真实邮箱与验证状态 ----

export async function getEmailSettings(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const status = await destinationStatus(env, user.email)
  const verified = status.verified || user.email_verified === 1

  return json({
    email: user.email,
    verified,
    notifyEnabled: user.notify_enabled === 1,
    // 可选的转发目标：只有已验证的真实邮箱才能被设为转发目标
    canForwardToRealEmail: verified,
  })
}

// ---- POST /api/settings/email/verify —— 发起 / 查询真实邮箱验证 ----

export async function verifyRealEmail(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json().catch(() => ({}))) as { action?: string }

  const email = user.email.toLowerCase()

  // action=status：只查询当前状态（前端轮询用）
  if (body.action === "status") {
    const status = await destinationStatus(env, email)
    if (status.verified && user.email_verified !== 1) {
      await env.DB.prepare(
        "UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?"
      )
        .bind(new Date().toISOString(), user.id)
        .run()
    }
    return json({ email, verified: status.verified || user.email_verified === 1 })
  }

  // 默认：发起验证（Cloudflare 会向该邮箱发送验证邮件）
  if (user.email_verified === 1) {
    return json({ email, verified: true, message: "该邮箱已验证" })
  }

  // 节流：避免反复触发 Cloudflare 验证邮件
  const last = user.email_verify_requested_at
  if (last && Date.now() - new Date(last).getTime() < 60_000) {
    const wait = Math.ceil(
      (60_000 - (Date.now() - new Date(last).getTime())) / 1000
    )
    throw new ApiError(
      429,
      `请求过于频繁，请 ${wait} 秒后再试`,
      "RATE_LIMITED"
    )
  }

  try {
    const dest = await cfEnsureDestination(env, email)
    await env.DB.prepare(
      "UPDATE users SET email_verify_requested_at = ? WHERE id = ?"
    )
      .bind(new Date().toISOString(), user.id)
      .run()
    await audit(env, user.id, "email.verify.request", `请求验证真实邮箱 ${email}`)

    const verified = dest.verified !== null
    if (verified) {
      await env.DB.prepare(
        "UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?"
      )
        .bind(new Date().toISOString(), user.id)
        .run()
    }

    return json({
      email,
      verified,
      message: verified
        ? "该邮箱此前已验证通过"
        : "验证邮件已发送，请在邮箱中点击确认链接后回到本页",
    })
  } catch (err) {
    console.error("注册验证邮箱失败:", email, err)
    throw new ApiError(
      502,
      "无法发送验证邮件，请稍后重试（若持续失败请检查 CF Token 是否有 Email Routing Addresses 权限）",
      "CF_ERROR"
    )
  }
}

// ---- PUT /api/settings/notify —— 是否接收站内通知 ----

export async function updateNotifySetting(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json()) as { enabled?: boolean }

  await env.DB.prepare(
    "UPDATE users SET notify_enabled = ?, updated_at = ? WHERE id = ?"
  )
    .bind(body.enabled ? 1 : 0, new Date().toISOString(), user.id)
    .run()

  return json({ notifyEnabled: Boolean(body.enabled) })
}

// ---- PUT /api/settings/username —— 修改用户名 ----

/**
 * 修改用户名的连带影响（必须让用户知情，见前端确认弹窗）：
 *   - R2 网盘目录固定为 `<原用户名>/`，改名后**不会自动迁移**，
 *     旧目录里的文件将无法通过新名字的直链访问（文件仍在 R2 中，需管理员协助迁移）
 *   - 主域名 `<原用户名>.doulor.cn` 与已分配的子域名不会改名
 *   - 主邮箱 `<原用户名>@doulor.cn` 不会改名
 *   - NewAPI 中转站账号名不变（NewAPI 侧不允许改用户名）
 */
export async function changeUsername(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json()) as { username?: string; password?: string }
  const next = (body.username ?? "").trim().toLowerCase()

  if (!isValidUsername(next)) {
    throw new ApiError(400, "用户名只能包含小写字母、数字和连字符", "INVALID_USERNAME")
  }
  if (isReservedName(next)) {
    throw new ApiError(400, "该用户名为系统保留名称", "RESERVED_NAME")
  }
  if (next === user.username.toLowerCase()) {
    throw new ApiError(400, "新用户名与当前相同", "INVALID_USERNAME")
  }

  // 二次确认：要求输入当前密码，避免会话被盗后直接改名
  const { verifyPassword } = await import("../crypto")
  if (!body.password || !(await verifyPassword(body.password, user.password_hash))) {
    throw new ApiError(400, "密码错误", "INVALID_PASSWORD")
  }

  // 目标名字必须未被任何命名空间占用（与注册同口径）
  const requestedFqdn = `${next}.${env.ROOT_DOMAIN.toLowerCase()}`
  const conflicts = await env.DB.batch([
    env.DB.prepare(
      "SELECT id FROM users WHERE username = ? COLLATE NOCASE LIMIT 1"
    ).bind(next),
    env.DB.prepare(
      "SELECT id FROM subdomains WHERE fqdn = ? COLLATE NOCASE LIMIT 1"
    ).bind(requestedFqdn),
    env.DB.prepare(
      "SELECT id FROM domains WHERE name = ? COLLATE NOCASE LIMIT 1"
    ).bind(requestedFqdn),
    env.DB.prepare(
      "SELECT id FROM mailboxes WHERE address = ? COLLATE NOCASE LIMIT 1"
    ).bind(`${next}@${env.ROOT_DOMAIN.toLowerCase()}`),
  ])
  if (conflicts.some((r) => (r.results ?? []).length > 0)) {
    throw new ApiError(409, "该用户名已被占用", "CONFLICT")
  }

  const now = new Date().toISOString()

  // 名片地址固定跟随用户名：改名时一并更新 slug，避免旧名片链接 404。
  // 若新 slug 已被他人占用（理论上不可能，因为上面已查过同名冲突），
  // 则保留原 slug，由用户自行处理。
  const slugTaken = await env.DB.prepare(
    "SELECT user_id FROM profiles WHERE slug = ? COLLATE NOCASE AND user_id != ? LIMIT 1"
  )
    .bind(next, user.id)
    .first()
  const slugUpdate = slugTaken
    ? env.DB.prepare("UPDATE profiles SET updated_at = ? WHERE user_id = ?").bind(now, user.id)
    : env.DB.prepare(
        "UPDATE profiles SET slug = ?, updated_at = ? WHERE user_id = ?"
      ).bind(next, now, user.id)

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE users SET username = ?, updated_at = ? WHERE id = ?"
    ).bind(next, now, user.id),
    env.DB.prepare(
      "INSERT INTO username_changes (id, user_id, old_username, new_username, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(uuid(), user.id, user.username, next, now),
    slugUpdate,
  ])

  await audit(env, user.id, "user.rename", `${user.username} → ${next}`)

  const updated = await env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(user.id)
    .first<UserRow>()

  return json({
    user: toPublicUser(updated!),
    warnings: {
      storagePrefixUnchanged: true,
      note: "网盘目录、子域名、主邮箱均仍使用原用户名，未自动迁移",
    },
  })
}

// ---- PUT /api/settings/email —— 修改真实邮箱（需新邮箱已验证） ----

export async function changeRealEmail(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json()) as {
    email?: string
    password?: string
    action?: "request" | "confirm"
  }
  const next = (body.email ?? "").trim().toLowerCase()

  if (!isValidEmail(next)) {
    throw new ApiError(400, "邮箱格式不正确", "INVALID_EMAIL")
  }
  if (next.endsWith(`@${env.ROOT_DOMAIN.toLowerCase()}`)) {
    throw new ApiError(400, "不能使用本站域名邮箱", "INVALID_EMAIL")
  }

  const { verifyPassword } = await import("../crypto")
  if (!body.password || !(await verifyPassword(body.password, user.password_hash))) {
    throw new ApiError(400, "密码错误", "INVALID_PASSWORD")
  }

  const taken = await env.DB.prepare(
    "SELECT id FROM users WHERE email = ? COLLATE NOCASE AND id != ? LIMIT 1"
  )
    .bind(next, user.id)
    .first()
  if (taken) throw new ApiError(409, "该邮箱已被其他账户使用", "CONFLICT")

  // 第一步：向新邮箱发起验证（Cloudflare 发验证邮件）
  if (body.action !== "confirm") {
    try {
      await cfEnsureDestination(env, next)
    } catch (err) {
      console.error("注册新邮箱失败:", next, err)
      throw new ApiError(502, "无法发送验证邮件，请稍后重试", "CF_ERROR")
    }
    return json({
      email: next,
      verified: false,
      message: "验证邮件已发送到新邮箱，请点击确认后再提交",
    })
  }

  // 第二步：确认新邮箱已验证，然后落库
  const status = await destinationStatus(env, next)
  if (!status.verified) {
    throw new ApiError(
      400,
      "新邮箱尚未完成验证，请先在邮箱中点击 Cloudflare 的确认链接",
      "NOT_VERIFIED"
    )
  }

  const now = new Date().toISOString()
  await env.DB.prepare(
    "UPDATE users SET email = ?, email_verified = 1, updated_at = ? WHERE id = ?"
  )
    .bind(next, now, user.id)
    .run()

  await audit(env, user.id, "user.email.change", `${user.email} → ${next}`)

  const updated = await env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(user.id)
    .first<UserRow>()

  return json({ user: toPublicUser(updated!), email: next, verified: true })
}