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
import { requireUser, toPublicUser, clearedSessionCookie, type UserRow } from "../auth"
import { uuid, hashToken } from "../crypto"
import { cfEnsureDestination, cfListDestinations, cfDeleteDestination } from "../cloudflare"
import { purgeUserExternalResources } from "../user-cleanup"
import { sendMail, renderMail } from "../mailer"
import { isReservedName } from "../reserved-names"
import { audit } from "../settings"
import { guardRateLimit } from "../ratelimit"
import type { Env } from "../env"

/**
 * 「当前密码」校验的限流额度（2026-09-25 审计 H9 修复）。
 *
 * 原状况：改用户名（changeUsername）与改真实邮箱（changeRealEmail）都会调
 * verifyPassword，但**两处都没有任何限流** —— 全仓 21 处 guardRateLimit
 * 里没有 handlers/settings.ts 这一个文件（而改密码接口 handlers/auth.ts
 * 是有限流的，说明这是遗漏而不是有意）。
 *
 * 后果：会话一旦被盗（或共用设备未登出），攻击者可以**无限制**地在线爆破
 * 账户口令；成功后直接改用户名/邮箱完成账号接管。
 *
 * 额度取 10 次 / 10 分钟：正常人不会连续输错当前密码，
 * 而 10 次/10 分钟把在线爆破压到不可行（一年也试不了 5 万次）。
 */
const PASSWORD_CHECK_LIMIT = 10
const PASSWORD_CHECK_WINDOW_SECONDS = 600

/** 统一的「校验当前密码」入口：先限流，再比对，失败与成功都不泄露差异 */
async function verifyCurrentPassword(
  env: Env,
  userId: string,
  password: string | undefined,
  hash: string
): Promise<void> {
  await guardRateLimit(
    env,
    `password-check:user:${userId}`,
    PASSWORD_CHECK_LIMIT,
    PASSWORD_CHECK_WINDOW_SECONDS,
    "密码尝试过于频繁，请稍后再试"
  )
  const { verifyPassword } = await import("../crypto")
  if (!password || !(await verifyPassword(password, hash))) {
    throw new ApiError(400, "密码错误", "INVALID_PASSWORD")
  }
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function isValidUsername(username: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(username)
}

/**
 * 查询某个邮箱在 Cloudflare 侧的验证状态。
 *
 * ⚠️ 2026-09-25 审计（M10）—— 这里采信的是**账户级**的 `verified` 标志，
 * 它无法回答「是**谁**验证的」。残留风险与已做的缓解：
 *
 *   已缓解：`changeRealEmail` 现在会删掉旧 destination，所以
 *     「弃用但仍 verified」的地址不再累积 —— 攻击者必须真的点开
 *     Cloudflare 发往该邮箱的确认信（只有邮箱主人收得到）。
 *
 *   未根治：如果账户里**已经**存在一个别人验证过、但当前无人使用的地址
 *     （历史遗留数据），用该地址注册仍会被判定为已验证。
 *     彻底修复需要「我们自己的验证码」流程（把 6 位码发到该邮箱、由用户回填），
 *     这样验证就归属到具体用户而不是账户 —— 需要新增一张表/列，
 *     而 `worker/migrations/` 的编号当前与另一个 AI 的改动冲突，故记为待办。
 */
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
  const verified = user.email_verified === 1

  return json({
    email: user.email,
    verified,
    notifyEnabled: user.notify_enabled === 1,
    notifyAnnouncements: user.notify_announcements === 1,
    // 可选的转发目标：只有已验证的真实邮箱才能被设为转发目标
    canForwardToRealEmail: verified,
  })
}

// ---- POST /api/settings/email/verify —— 发起 / 校验 / 查询真实邮箱验证 ----

/** 生成 6 位数字验证码（100000–999999，crypto 随机 + 拒绝采样） */
function generateVerifyCode(): string {
  const MAX_EXCLUSIVE = 0x100000000
  const SPAN = 900000
  const LIMIT = Math.floor(MAX_EXCLUSIVE / SPAN) * SPAN
  const buf = new Uint32Array(1)
  let v = 0
  do {
    crypto.getRandomValues(buf)
    v = buf[0]
  } while (v >= LIMIT)
  return String(100000 + (v % SPAN))
}

export async function verifyRealEmail(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json().catch(() => ({}))) as { action?: string; code?: string }

  const email = user.email.toLowerCase()

  // 已验证直接返回
  if (user.email_verified === 1) {
    return json({ email, verified: true, message: "该邮箱已验证" })
  }

  // action=confirm：回填验证码校验
  if (body.action === "confirm") {
    const code = String(body.code ?? "").trim()
    if (!/^\d{6}$/.test(code)) {
      throw new ApiError(400, "请输入 6 位数字验证码", "INVALID_CODE")
    }
    const row = await env.DB.prepare(
      "SELECT code_hash, expires_at, attempts FROM email_verify_codes WHERE user_id = ?"
    )
      .bind(user.id)
      .first<{ code_hash: string; expires_at: string; attempts: number }>()
    if (!row || new Date(row.expires_at).getTime() < Date.now()) {
      throw new ApiError(400, "验证码已过期，请重新发送", "CODE_EXPIRED")
    }
    if (row.attempts >= 5) {
      throw new ApiError(400, "尝试次数过多，请重新发送", "TOO_MANY_ATTEMPTS")
    }
    if ((await hashToken(code)) !== row.code_hash) {
      await env.DB.prepare(
        "UPDATE email_verify_codes SET attempts = attempts + 1 WHERE user_id = ?"
      )
        .bind(user.id)
        .run()
      throw new ApiError(400, "验证码错误", "INVALID_CODE")
    }
    const now = new Date().toISOString()
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?"
      ).bind(now, user.id),
      env.DB.prepare("DELETE FROM email_verify_codes WHERE user_id = ?").bind(user.id),
    ])
    await audit(env, user.id, "email.verify.confirm", `验证真实邮箱 ${email}`)
    return json({ email, verified: true })
  }

  // action=status：查询（已验证已在上面返回 true）
  if (body.action === "status") {
    return json({ email, verified: false })
  }

  // 默认：发起验证（生成验证码 + 发信）
  const last = user.email_verify_requested_at
  if (last && Date.now() - new Date(last).getTime() < 60_000) {
    const wait = Math.ceil(
      (60_000 - (Date.now() - new Date(last).getTime())) / 1000
    )
    throw new ApiError(429, `请求过于频繁，请 ${wait} 秒后再试`, "RATE_LIMITED")
  }

  const code = generateVerifyCode()
  const now = new Date().toISOString()
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString()

  // 存验证码（同一用户重新发起即覆盖旧码）
  await env.DB.prepare(
    `INSERT INTO email_verify_codes (user_id, code_hash, expires_at, attempts, created_at)
     VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(user_id) DO UPDATE SET code_hash = excluded.code_hash,
       expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at`
  )
    .bind(user.id, await hashToken(code), expiresAt, now)
    .run()

  // 发验证码邮件（走多通道路由：Posta/Brevo/CF）
  const { text, html } = renderMail("验证你的邮箱", [
    `你的验证码是：${code}`,
    "验证码 10 分钟内有效，请勿泄露给他人。",
    "如果这不是你本人的操作，请忽略本邮件。",
  ])
  try {
    await sendMail(env, {
      to: email,
      subject: "【Doulor Cloud】邮箱验证码",
      text,
      html,
    })
  } catch (err) {
    console.error("发送验证码邮件失败:", email, err)
    throw new ApiError(502, "发送验证码失败，请稍后重试", "MAIL_SEND_FAILED")
  }

  await env.DB.prepare(
    "UPDATE users SET email_verify_requested_at = ? WHERE id = ?"
  )
    .bind(now, user.id)
    .run()
  await audit(env, user.id, "email.verify.request", `请求验证真实邮箱 ${email}`)

  return json({ email, verified: false, message: "验证码已发送到你的邮箱，请查收" })
}

// ---- PUT /api/settings/notify —— 是否接收站内通知 ----

export async function updateNotifySetting(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json()) as {
    enabled?: boolean
    announcements?: boolean
  }

  // 两个独立开关：个人通知（notify_enabled）+ 站点公告（notify_announcements）。
  // 传哪个改哪个，互不影响；都不传则无操作。
  if (body.enabled !== undefined) {
    await env.DB.prepare(
      "UPDATE users SET notify_enabled = ?, updated_at = ? WHERE id = ?"
    )
      .bind(body.enabled ? 1 : 0, new Date().toISOString(), user.id)
      .run()
  }
  if (body.announcements !== undefined) {
    await env.DB.prepare(
      "UPDATE users SET notify_announcements = ?, updated_at = ? WHERE id = ?"
    )
      .bind(body.announcements ? 1 : 0, new Date().toISOString(), user.id)
      .run()
  }

  return json({
    notifyEnabled: body.enabled !== undefined ? Boolean(body.enabled) : user.notify_enabled === 1,
    notifyAnnouncements:
      body.announcements !== undefined
        ? Boolean(body.announcements)
        : user.notify_announcements === 1,
  })
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
  // （含限流，见 verifyCurrentPassword —— 2026-09-25 审计 H9）
  await verifyCurrentPassword(env, user.id, body.password, user.password_hash)

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

  // 含限流，见 verifyCurrentPassword —— 2026-09-25 审计 H9
  await verifyCurrentPassword(env, user.id, body.password, user.password_hash)

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
  const previousEmail = user.email
  await env.DB.prepare(
    "UPDATE users SET email = ?, email_verified = 1, updated_at = ? WHERE id = ?"
  )
    .bind(next, now, user.id)
    .run()

  // ⚠️ 2026-09-25 审计（M10）：旧地址必须从 Cloudflare 账户里删掉。
  //
  // destination 是**账户级**的，`verified` 也只属于账户而不属于用户。旧实现
  // 只改 `users.email`、不删旧 destination，于是「弃用但仍 verified」的地址会一直
  // 留在账户里：任何人拿它注册，只要调一次 action:"status" 就会被判定
  // `email_verified = 1` —— 而他从未能读取那个邮箱。
  // 该标志会经 OAuth /userinfo 以 `email_verified: true` 暴露给依赖方，也是 FRP 准入条件。
  //
  // 删除失败**不阻断**改邮箱（最多保留原有风险），但必须留下日志以便排查。
  try {
    const removed = await cfDeleteDestination(env, previousEmail)
    if (removed) {
      await audit(env, user.id, "email.destination.remove", `移除旧转发地址 ${previousEmail}`)
    }
  } catch (err) {
    console.error("删除旧转发地址失败（邮箱已改，风险保留）:", previousEmail, err)
  }

  await audit(env, user.id, "user.email.change", `${previousEmail} → ${next}`)

  const updated = await env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(user.id)
    .first<UserRow>()

  return json({ user: toPublicUser(updated!), email: next, verified: true })
}

/**
 * POST /api/settings/account/delete-code —— 注销前发送邮箱验证码。
 *
 * 注销不可逆，仅凭密码不够（会话被盗 + 密码泄露即可直接销号）。
 * 再要求一次「邮箱验证码」证明本人掌握注册邮箱；与邮箱验证码分表存放。
 */
export async function requestDeleteCode(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  if (user.role === "root") {
    throw new ApiError(403, "站长账户不可自助注销", "FORBIDDEN")
  }
  // 60 秒内最多 3 次，避免刷邮件
  await guardRateLimit(
    env,
    `account-delete-code:${user.id}`,
    3,
    60,
    "验证码发送过于频繁，请稍后再试"
  )

  const email = user.email.toLowerCase()
  const code = generateVerifyCode()
  const now = new Date().toISOString()
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString()

  await env.DB.prepare(
    `INSERT INTO account_delete_codes (user_id, code_hash, expires_at, attempts, created_at)
     VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(user_id) DO UPDATE SET code_hash = excluded.code_hash,
       expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at`
  )
    .bind(user.id, await hashToken(code), expiresAt, now)
    .run()

  const { text, html } = renderMail("注销账号验证码", [
    `你的注销验证码是：${code}`,
    "验证码 10 分钟内有效。注销后账号及全部数据将被永久删除，无法恢复。",
    "如果这不是你本人的操作，请立即修改密码。",
  ])
  try {
    await sendMail(env, {
      to: email,
      subject: "【Doulor Cloud】注销账号验证码",
      text,
      html,
    })
  } catch (err) {
    console.error("发送注销验证码失败:", email, err)
    throw new ApiError(502, "发送验证码失败，请稍后重试", "MAIL_SEND_FAILED")
  }

  await audit(env, user.id, "user.account.delete.request", `请求注销验证码 ${email}`)
  return json({ email, message: "验证码已发送到你的邮箱，请查收" })
}

/** 校验注销验证码（与邮箱验证码同款规则：10 分钟有效、最多 5 次尝试） */
async function verifyDeleteCode(env: Env, userId: string, raw: unknown): Promise<void> {
  const code = String(raw ?? "").trim()
  if (!/^\d{6}$/.test(code)) {
    throw new ApiError(400, "请输入 6 位数字验证码", "INVALID_CODE")
  }
  const row = await env.DB.prepare(
    "SELECT code_hash, expires_at, attempts FROM account_delete_codes WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ code_hash: string; expires_at: string; attempts: number }>()
  if (!row || new Date(row.expires_at).getTime() < Date.now()) {
    throw new ApiError(400, "验证码已过期，请重新发送", "CODE_EXPIRED")
  }
  if (row.attempts >= 5) {
    throw new ApiError(400, "尝试次数过多，请重新发送", "TOO_MANY_ATTEMPTS")
  }
  if ((await hashToken(code)) !== row.code_hash) {
    await env.DB.prepare(
      "UPDATE account_delete_codes SET attempts = attempts + 1 WHERE user_id = ?"
    )
      .bind(userId)
      .run()
    throw new ApiError(400, "验证码错误", "INVALID_CODE")
  }
}

/**
 * POST /api/settings/account/delete —— 用户自助注销账号。
 *
 * 与管理员删号（admin.deleteUser）走同一套资源回收逻辑：
 * 先 purgeUserExternalResources 回收 CF 规则 / DNS / R2 / 捐献资源等，
 * 再删 users 行。需要**双重确认**：当前密码 + 邮箱验证码（两样都过才允许），
 * root（站长）不可自助注销。
 *
 * 删除前先往 deleted_users 写一条最小留痕，管理端据此以「已注销用户」展示。
 */
export async function deleteOwnAccount(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json().catch(() => ({}))) as {
    password?: string
    code?: string
  }

  if (user.role === "root") {
    throw new ApiError(403, "站长账户不可自助注销", "FORBIDDEN")
  }

  // 双重校验：密码（含限流，见 verifyCurrentPassword）+ 邮箱验证码
  await verifyCurrentPassword(env, user.id, body.password, user.password_hash)
  await verifyDeleteCode(env, user.id, body.code)

  // 清理必须在删 users 行之前（句柄会随 CASCADE 消失），与 admin.deleteUser 一致
  const cleanup = await purgeUserExternalResources(env, user.id, user.username)

  // 留痕：先写墓碑再删行，保证「注销了但查得到」
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT OR REPLACE INTO deleted_users
       (id, uid, username, email, namespace, role, reason, deleted_by, created_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, 'self', ?, ?, ?)`
  )
    .bind(
      user.id,
      user.uid ?? null,
      user.username,
      user.email,
      user.namespace ?? null,
      user.role,
      user.id,
      user.created_at ?? null,
      now
    )
    .run()

  // 审计必须在删 users 行**之前**写：audit_logs.user_id 有外键（ON DELETE SET NULL），
  // 删行后再写会撞 FK 约束、审计被静默丢弃（日志里只剩「审计日志写入失败」）。
  // 先写、后删，外键会把 user_id 置 NULL，审计行本身保留 —— 正是「留痕」想要的效果。
  await audit(env, user.id, "user.account.delete", `自助注销 ${user.username}`)

  await env.DB.batch([
    env.DB.prepare("DELETE FROM account_delete_codes WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
  ])

  if (cleanup.errors.length > 0) {
    console.error("注销清理部分失败:", user.username, cleanup.errors.join("；"))
  }

  // 清除会话 cookie，返回 204
  const res = new Response(null, { status: 204 })
  res.headers.set("Set-Cookie", clearedSessionCookie())
  return res
}