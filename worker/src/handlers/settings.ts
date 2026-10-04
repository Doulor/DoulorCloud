/**
 * 账户设置：真实邮箱验证、通知开关、修改用户名 / 真实邮箱。
 *
 * 邮箱所有权验证必须绑定到当前用户提交的目标地址：Cloudflare Email Routing 的
 * destination.verified 是账户级状态，不能证明某个用户能收取该地址的邮件。
 * 账号邮箱验证与更换真实邮箱都使用发往目标地址的用户专属验证码。
 */
import { ApiError, json } from "../http"
import { requireUser, toPublicUser, clearedSessionCookie, type UserRow } from "../auth"
import { uuid, hashToken } from "../crypto"
import { cfDeleteDestination } from "../cloudflare"
import { purgeUserExternalResources } from "../user-cleanup"
import { sendMail, renderMail } from "../mailer"
import { isReservedName } from "../reserved-names"
import { audit, getSetting } from "../settings"
import { guardRateLimit } from "../ratelimit"
import { userRootDomainName, isOwnDomain } from "../root-domains"
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
  // 3-32 位（2026-10-02 站长定，与注册同口径）：见 handlers/auth.ts 的说明
  return /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(username)
}

/** 改邮箱验证码：10 分钟有效、最多 5 次尝试、60 秒内最多重发 3 次（与邮箱验证同款规则） */
const EMAIL_CHANGE_CODE_TTL_MS = 10 * 60_000
const EMAIL_CHANGE_CODE_ATTEMPTS = 5
const EMAIL_CHANGE_RESEND_WAIT_MS = 60_000

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
    throw new ApiError(
      400,
      "用户名需要 3-32 位，只能包含小写字母、数字和连字符",
      "INVALID_USERNAME"
    )
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

  // 目标名字必须未被任何命名空间占用（与注册同口径）。
  // ⚠️ 判的是**用户自己所在的根域**，不是 env.ROOT_DOMAIN：新用户在 tyu.me 上，
  //    拿主域去判重会判错对象（漏真冲突、拦无关名字）。
  const myRoot = await userRootDomainName(env, user.id, user.username)
  const requestedFqdn = `${next}.${myRoot}`
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
    ).bind(`${next}@${myRoot}`),
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

// ---- PUT /api/settings/email —— 修改真实邮箱（需新邮箱完成用户专属验证码验证） ----

export async function changeRealEmail(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json()) as {
    email?: string
    password?: string
    action?: "request" | "confirm"
    code?: string
  }
  const next = (body.email ?? "").trim().toLowerCase()

  if (!isValidEmail(next)) {
    throw new ApiError(400, "邮箱格式不正确", "INVALID_EMAIL")
  }
  // 覆盖全部已登记根域（tyu.me + doulor.cn），只判主域会漏掉新域
  if (await isOwnDomain(env, next)) {
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

  // 第一步：把 6 位验证码发到**新邮箱**。
  //
  // ⚠️ 2026-10-04 审计修复：这里原先调用 cfEnsureDestination + destinationStatus，
  // 采信 Cloudflare Email Routing 的 `verified`。那是**账户级**状态，只能说明
  // 「本账户里这个地址验证过」，不能证明「当前这个用户在收这封邮件」——账户里
  // 历史遗留（或别人验证过）的已验证地址会被当成「已验证」，把 email_verified
  // 置 1，而该用户从未能读取那个邮箱。现在改成发往目标地址的用户专属验证码：
  // 只有真正能读这个邮箱的人才能把码回填回来，验证归属到 user_id。
  if (body.action !== "confirm") {
    // 每人 60 秒内最多 3 次：避免拿改邮箱接口当「向任意地址发信」的跳板
    await guardRateLimit(
      env,
      `email-change-code:user:${user.id}`,
      3,
      EMAIL_CHANGE_RESEND_WAIT_MS / 1000,
      "验证码发送过于频繁，请稍后再试"
    )

    const code = generateVerifyCode()
    const now = new Date().toISOString()
    const expiresAt = new Date(Date.now() + EMAIL_CHANGE_CODE_TTL_MS).toISOString()

    await env.DB.prepare(
      `INSERT INTO email_change_codes (user_id, email, code_hash, expires_at, attempts, created_at)
       VALUES (?, ?, ?, ?, 0, ?)
       ON CONFLICT(user_id) DO UPDATE SET email = excluded.email,
         code_hash = excluded.code_hash, expires_at = excluded.expires_at,
         attempts = 0, created_at = excluded.created_at`
    )
      .bind(user.id, next, await hashToken(code), expiresAt, now)
      .run()

    const { text, html } = renderMail("确认新的账号邮箱", [
      `你的验证码是：${code}`,
      `提交后，你的账号邮箱将改为 ${next}。`,
      "验证码 10 分钟内有效，请勿泄露给他人。",
      "如果这不是你本人的操作，请忽略本邮件。",
    ])
    try {
      await sendMail(env, {
        to: next,
        subject: "【Doulor Cloud】修改邮箱验证码",
        text,
        html,
      })
    } catch (err) {
      console.error("发送改邮箱验证码失败:", next, err)
      throw new ApiError(502, "发送验证码失败，请稍后重试", "MAIL_SEND_FAILED")
    }

    await audit(env, user.id, "user.email.change.request", `请求改邮箱为 ${next}`)

    return json({
      email: next,
      verified: false,
      message: "验证码已发送到新邮箱，请查收后在 10 分钟内提交",
    })
  }

  // 第二步：校验发往新邮箱的验证码，通过后落库。
  const code = String(body.code ?? "").trim()
  if (!/^\d{6}$/.test(code)) {
    throw new ApiError(400, "请输入 6 位数字验证码", "INVALID_CODE")
  }

  const row = await env.DB.prepare(
    "SELECT email, code_hash, expires_at, attempts FROM email_change_codes WHERE user_id = ?"
  )
    .bind(user.id)
    .first<{ email: string; code_hash: string; expires_at: string; attempts: number }>()

  // 码必须是发给「这次要改成的那个地址」的：否则可以对 A 邮箱取码、拿 B 邮箱来换，
  // 从而把一个自己无法收信的地址标成已验证。
  if (!row || row.email.toLowerCase() !== next) {
    throw new ApiError(400, "请先向该邮箱发送验证码", "CODE_NOT_REQUESTED")
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new ApiError(400, "验证码已过期，请重新发送", "CODE_EXPIRED")
  }
  if (row.attempts >= EMAIL_CHANGE_CODE_ATTEMPTS) {
    throw new ApiError(400, "尝试次数过多，请重新发送", "TOO_MANY_ATTEMPTS")
  }
  if ((await hashToken(code)) !== row.code_hash) {
    await env.DB.prepare(
      "UPDATE email_change_codes SET attempts = attempts + 1 WHERE user_id = ?"
    )
      .bind(user.id)
      .run()
    throw new ApiError(400, "验证码错误", "INVALID_CODE")
  }

  const now = new Date().toISOString()
  const previousEmail = user.email
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE users SET email = ?, email_verified = 1, updated_at = ? WHERE id = ?"
    ).bind(next, now, user.id),
    env.DB.prepare("DELETE FROM email_change_codes WHERE user_id = ?").bind(user.id),
  ])

  // 旧地址仍要从 Cloudflare 账户里删掉（2026-09-25 审计 M10，2026-10-04 复核）。
  //
  // 历史背景：本站曾用 destination 的**账户级** `verified` 判定用户邮箱验证状态，
  // 于是「弃用但仍 verified」的旧地址留在账户里，会被下一次拿它注册/换绑的人
  // 白捡一个 `email_verified = 1`。这条判定路径现已全部改为用户专属验证码
  // （见本文件 verifyRealEmail 与上面的第一步），不再读 CF 状态；
  // 这里继续删除旧 destination，是为了：① 释放「每账户 200 条」的硬配额；
  // ② 不留账户级残留，避免以后再有代码误用它。
  //
  // 删除失败**不阻断**改邮箱（最多是一份残留），但必须留下日志以便排查。
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
/**
 * GET /api/downloads —— 落地页「下载」区的渠道链接（公开，无需登录）。
 *
 * 网页端 PWA 走 beforeinstallprompt 安装、不走链接，所以这里只下发安卓/Windows 两个
 * 可配链接；留空（未配置）则该渠道为 null，前端不显示对应按钮。
 */
export async function publicDownloads(env: Env, _request: Request): Promise<Response> {
  const [android, windows] = await Promise.all([
    getSetting(env, "download_android_url"),
    getSetting(env, "download_windows_url"),
  ])
  return json({
    android: android.trim() || null,
    windows: windows.trim() || null,
  })
}
