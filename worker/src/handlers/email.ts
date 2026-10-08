import { ApiError, json } from "../http"
import { uuid, hashToken } from "../crypto"
import { isReservedName } from "../reserved-names"
import { requireUser, type UserRow, isPrivileged } from "../auth"
import { isApiRequest } from "../api-source"
import { cfDeleteEmailRule } from "../cloudflare"
import { sendMail, renderMail } from "../mailer"
import { guardRateLimit } from "../ratelimit"
import { isAdminApiRequest } from "../api-source"
import { audit, getSettingNumber, siteOffsetHours, siteDayString } from "../settings"
import {
  pickRootDomain,
  isOwnDomain,
  listEnabledRootDomains,
  canUseRootDomain,
  getDefaultRootDomain,
  primaryAddressFor,
} from "../root-domains"
import { userPermissions } from "../permissions"
import { encodeCursor, decodeCursor } from "../community-logic"
import type { Env } from "../env"

const MAX_MAILBOXES_PER_USER = 3
/** 管理员「不限」哨兵值（前端见到显示「不限」） */
const ADMIN_UNLIMITED_MAILBOXES = 999999

/**
 * 临时邮箱：额度**独立**，不占用 MAX_MAILBOXES_PER_USER 的 3 个名额。
 * 限制的是「同时存在几个」，而不是一生存量 —— 因为它的语义是用完就换。
 * 站点主定成 1：临时邮箱一次一个，用完换新即可。
 */
const MAX_TEMP_MAILBOXES_PER_USER = 1
/** 临时邮箱前缀长度：32^8 ≈ 1.1e12 种组合，够随机又便于复制粘贴 */
const TEMP_LOCAL_PART_LENGTH = 8
/**
 * 临时邮箱前缀字符集：**刻意去掉 l / o / 0 / 1**。
 * 这种地址最常见的用法是被念给别人、或在另一台设备上手工输入，
 * 而这四个字符（小写 L、数字 1、字母 o、数字 0）在多数等宽字体里无法区分。
 * 恰好 32 个字符 = 2^5，所以 `字节 % 32` 不会产生取模偏置。
 */
const TEMP_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"
/**
 * 临时邮箱「新建 + 刷新」共用一个限流桶（每人每小时 60 次）。
 * 每次操作都会写 D1 并调用一次 Cloudflare API，不限流就等于把控制面配额
 * 交给一个登录账号随便刷。
 */
const TEMP_WRITE_LIMIT_PER_HOUR = 60

interface MailboxRow {
  id: string
  user_id: string
  address: string
  forwarding_to: string | null
  last_forwarded_at: string | null
  rule_id: string | null
  last_forward_error: string | null
  created_at: string
  /** 1 = 临时邮箱（迁移 0051 新增）。未迁移的旧库读出来是 undefined，按 0 处理 */
  is_temp?: number
}

interface MessageRow {
  id: string
  mailbox_id: string
  from_address: string
  subject: string
  text_body: string
  read: number
  received_at: string
  /** 原邮件的 RFC Message-ID（0029 迁移新增），用于同一封邮件去重落库 */
  rfc_message_id?: string | null
}

/**
 * 生成一个临时邮箱前缀（密码学随机）。
 *
 * ⚠️ 不要换成 Math.random()：这个地址是「收信入口」，可预测的话
 * 别人就能猜出下一个人会拿到什么地址，从而提前把垃圾邮件投进去。
 */
function randomTempLocalPart(): string {
  const bytes = new Uint8Array(TEMP_LOCAL_PART_LENGTH)
  crypto.getRandomValues(bytes)
  let out = ""
  for (const b of bytes) out += TEMP_ALPHABET[b % TEMP_ALPHABET.length]
  return out
}

function parseForwarding(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === "string")
    }
  } catch {
    // fallthrough
  }
  return []
}

async function mailboxStats(env: Env, mailboxId: string) {
  const s = await env.DB.prepare(
    "SELECT COUNT(*) AS total, COALESCE(SUM(read = 0), 0) AS unread FROM messages WHERE mailbox_id = ?"
  )
    .bind(mailboxId)
    .first<{ total: number; unread: number }>()
  return { total: s?.total ?? 0, unread: s?.unread ?? 0 }
}

/**
 * 一次查出该用户所有邮箱的统计，避免在列表里逐个邮箱查一遍（N+1）。
 * 返回 mailboxId -> stats 的映射；没有邮件的邮箱不会出现在结果里，调用方需兜底 0。
 */
async function mailboxStatsBatch(
  env: Env,
  userId: string
): Promise<Map<string, { total: number; unread: number }>> {
  const rows = await env.DB.prepare(
    `SELECT m.mailbox_id AS mailbox_id,
            COUNT(*) AS total,
            COALESCE(SUM(m.read = 0), 0) AS unread
       FROM messages m
       JOIN mailboxes mb ON mb.id = m.mailbox_id
      WHERE mb.user_id = ?
      GROUP BY m.mailbox_id`
  )
    .bind(userId)
    .all<{ mailbox_id: string; total: number; unread: number }>()

  const map = new Map<string, { total: number; unread: number }>()
  for (const r of rows.results ?? []) {
    map.set(r.mailbox_id, { total: r.total, unread: r.unread })
  }
  return map
}

/**
 * 该用户的「主邮箱」地址。
 *
 * 实现搬到 root-domains.ts 的 `primaryAddressFor`（newapi 也要用同一口径，
 * 放两处必然漂移）。写死 `env.ROOT_DOMAIN` 会让「主邮箱不可删」的保护
 * 永远判 false —— 主邮箱就能被用户删掉，而它是转发目标与重要来信的落点。
 */
async function primaryMailboxAddress(env: Env, user: UserRow): Promise<string> {
  return primaryAddressFor(env, user.id, user.username)
}

async function toPublicMailbox(
  env: Env,
  user: UserRow,
  row: MailboxRow,
  verifiedSet?: Set<string>,
  precomputedStats?: { total: number; unread: number },
  /** 主邮箱地址（调用方算一次传进来，避免每个邮箱一次额外查询） */
  primaryAddress?: string
) {
  // 列表场景传入批量算好的统计，避免每个邮箱一次查询；单条场景仍按需查询
  const stats = precomputedStats ?? (await mailboxStats(env, row.id))
  const forwardingTo = parseForwarding(row.forwarding_to)
  return {
    id: row.id,
    address: row.address,
    primary: row.address === (primaryAddress ?? `${user.username}@${env.ROOT_DOMAIN}`).toLowerCase(),
    /** true = 临时邮箱：前端据此分组展示，并隐藏「转发设置」入口 */
    isTemp: row.is_temp === 1,
    forwardingTo,
    // null = 未知（拉取失败），前端应提示「状态未知」而非谎报已验证
    forwardingVerified: forwardingTo.map((t) =>
      verifiedSet ? verifiedSet.has(t.toLowerCase()) : null
    ),
    lastForwardedAt: row.last_forwarded_at,
    lastForwardError: row.last_forward_error ?? null,
    unread: stats.unread,
    total: stats.total,
    createdAt: row.created_at,
  }
}

/**
 * 拉取「当前用户已验证的转发目标」集合。
 *
 * 来源有两类：
 *   1. 用户通过「转发目标验证」（发验证码到目标邮箱、回填）验证过的邮箱
 *      —— 存 forwarding_verifications 表，支持任意邮箱（朋友的邮箱也能绑）。
 *   2. 用户自己的账号邮箱若已 email_verified=1，也算已验证（老用户兼容，
 *      他们当年验证过账号邮箱，且转发到自己账号邮箱本来就是最常见的用法）。
 */
async function loadVerifiedTargets(env: Env, userId: string): Promise<Set<string>> {
  const [rows, userRow] = await Promise.all([
    env.DB.prepare(
      "SELECT target_email FROM forwarding_verifications WHERE user_id = ?"
    )
      .bind(userId)
      .all<{ target_email: string }>(),
    env.DB.prepare("SELECT email, email_verified FROM users WHERE id = ?")
      .bind(userId)
      .first<{ email: string; email_verified: number }>(),
  ])
  const set = new Set(
    (rows.results ?? []).map((r) => r.target_email.toLowerCase())
  )
  if (userRow && userRow.email_verified === 1 && userRow.email) {
    set.add(userRow.email.toLowerCase())
  }
  return set
}

function toPublicMessage(row: MessageRow) {
  return {
    id: row.id,
    from: row.from_address,
    subject: row.subject,
    body: row.text_body,
    read: row.read === 1,
    receivedAt: row.received_at,
  }
}

/** 获取属于当前用户的收件箱；不属于本人或不存在一律 403/404，绝不泄露他人邮箱。 */
async function requireMailbox(
  env: Env,
  user: UserRow,
  mailboxId: string
): Promise<MailboxRow> {
  const mailbox = await env.DB.prepare("SELECT * FROM mailboxes WHERE id = ?")
    .bind(mailboxId)
    .first<MailboxRow>()

  if (!mailbox || mailbox.user_id !== user.id) {
    throw new ApiError(404, "邮箱不存在", "NOT_FOUND")
  }
  return mailbox
}

/**
 * 校验转发目标。
 *
 * ⚠️ 禁止转发到**本站任一域名**（不只 env.ROOT_DOMAIN）：`xxx@tyu.me` 与
 * `xxx@doulor.cn` 都会回到本 Worker，转发到它们就是自己给自己转发 —— 成环。
 */
async function validateForwarding(env: Env, forwardingTo: string[]): Promise<string[]> {
  // 去重必须在 slice(0, 3) 之前：重复目标不该白白占掉 3 个名额。
  // 大小写不敏感 —— 与 verifiedSet / forwarding_verifications 的比对口径一致
  // （那些地方统一 toLowerCase），a@x.com 与 A@x.com 实为同一信箱，不 Dedupe
  // 会把同一封邮件转发多遍。
  const seen = new Set<string>()
  const targets = forwardingTo
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => {
      const key = s.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 3)

  if (
    targets.some(
      (f) => f.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f)
    )
  ) {
    throw new ApiError(400, "转发邮箱格式无效", "INVALID_FORWARD")
  }
  for (const f of targets) {
    if (await isOwnDomain(env, f)) {
      throw new ApiError(400, "不能转发到本站域名邮箱", "INVALID_FORWARD")
    }
  }
  return targets
}

// GET /api/mailbox —— 当前用户的所有邮箱
export async function listMailboxes(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const rows = await env.DB.prepare(
    "SELECT * FROM mailboxes WHERE user_id = ? ORDER BY created_at ASC"
  )
    .bind(user.id)
    .all<MailboxRow>()

  // 统计与验证状态各自只需一次查询，并行发出
  const [verifiedSet, statsMap, primaryAddress] = await Promise.all([
    loadVerifiedTargets(env, user.id),
    mailboxStatsBatch(env, user.id),
    primaryMailboxAddress(env, user),
  ])
  const mailboxes = []
  for (const row of rows.results ?? []) {
    mailboxes.push(
      await toPublicMailbox(
        env,
        user,
        row,
        verifiedSet,
        statsMap.get(row.id) ?? { total: 0, unread: 0 },
        primaryAddress
      )
    )
  }
  // 邮箱数量上限（管理员/站长不限，999999 作为哨兵值，前端显示「不限」）
  const limit = isPrivileged(user.role) ? ADMIN_UNLIMITED_MAILBOXES : MAX_MAILBOXES_PER_USER
  // 临时邮箱额度独立计算。直接数上面已查出的行，不再多打一次 D1 查询。
  const tempUsed = (rows.results ?? []).filter((r) => r.is_temp === 1).length
  const tempLimit =
    isPrivileged(user.role) ? ADMIN_UNLIMITED_MAILBOXES : MAX_TEMP_MAILBOXES_PER_USER

  // 可选根域：只下发**当前用户有权限用的**，前端据此渲染域名选择器。
  // 没权限的域不下发 —— 先显示再拒绝只会让人以为坏了。
  const perms = userPermissions(user)
  const rootDomains = (await listEnabledRootDomains(env))
    .filter((r) => canUseRootDomain(perms, r))
    .map((r) => ({ name: r.name, label: r.label ?? r.name, isDefault: r.is_default === 1 }))

  return json({ mailboxes, limit, tempLimit, tempUsed, rootDomains })
}

// POST /api/mailbox —— 添加邮箱地址（{ localPart, domain? }），最多 3 个
export async function createMailbox(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json()) as { localPart?: string; domain?: string }

  const localPart = (body.localPart ?? "").trim().toLowerCase()
  if (!/^[a-z0-9._-]{1,40}$/.test(localPart)) {
    throw new ApiError(400, "邮箱前缀只能包含小写字母、数字和 . _ -", "INVALID_ALIAS")
  }
  // 防止冒充平台（如 admin@ / postmaster@ / noreply@），也避免占走他人用户名
  if (isReservedName(localPart)) {
    throw new ApiError(400, "该邮箱前缀为系统保留名称", "RESERVED_NAME")
  }

  // 建在哪个根域：省略 = 默认域（tyu.me）；显式指定要过权限闸
  // （doulor.cn 挂 `doulor` 权限）。pickRootDomain 会校验「域名已登记 + 已启用 + 有权限」。
  const root = await pickRootDomain(env, body.domain, userPermissions(user))

  // ⚠️ 必须带 is_temp = 0：临时邮箱有自己的额度，不能挤占这 3 个名额
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM mailboxes WHERE user_id = ? AND is_temp = 0"
  )
    .bind(user.id)
    .first<{ c: number }>()

  // 管理员 Key 的公开 API 调用不受邮箱数量限制（2026-10-07）
  if (!isAdminApiRequest(request) && !isPrivileged(user.role) && (count?.c ?? 0) >= MAX_MAILBOXES_PER_USER) {
    throw new ApiError(400, `每个用户最多 ${MAX_MAILBOXES_PER_USER} 个邮箱`, "LIMIT_REACHED")
  }

  const address = `${localPart}@${root.name}`
  const exists = await env.DB.prepare(
    "SELECT id FROM mailboxes WHERE address = ? COLLATE NOCASE LIMIT 1"
  )
    .bind(address)
    .first()

  if (exists) {
    throw new ApiError(409, "该邮箱已被使用", "CONFLICT")
  }

  // 默认不自动设置转发：只有「在设置里验证过的真实邮箱」才能作转发目标。
  // 注册时的邮箱尚未验证，因此这里不再自动填入（用户验证后可在邮箱页选择）。
  const defaultForwarding = null

  const id = uuid()
  const now = new Date().toISOString()

  // ⚠️ 2026-09-26：**不再逐条创建 Cloudflare Email Routing 规则**。
  // 线上 catch-all 已改为「Send to a Worker」，所有 *@doulor.cn 的信都会进本 Worker，
  // 由代码查 mailboxes 表决定去处 —— 逐地址建规则是历史包袱，还占「每域 200 条」硬配额。
  // 所以新邮箱的 rule_id 一律为 NULL；删除路径仍会摘掉历史遗留的规则（见 purgeMailbox）。
  await env.DB.prepare(
    "INSERT INTO mailboxes (id, user_id, address, forwarding_to, source, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(id, user.id, address, defaultForwarding, isApiRequest(request) ? "api" : "web", now)
    .run()

  const row = await env.DB.prepare("SELECT * FROM mailboxes WHERE id = ?")
    .bind(id)
    .first<MailboxRow>()

  return json(
    { mailbox: await toPublicMailbox(env, user, row!, undefined, undefined, await primaryMailboxAddress(env, user)) },
    201
  )
}

// PUT /api/mailbox/:id —— 更新转发目标（空 = 不转发）
export async function updateMailbox(env: Env, request: Request, id: string): Promise<Response> {
  const user = await requireUser(env, request)
  const mailbox = await requireMailbox(env, user, id)
  const body = (await request.json()) as { forwardingTo?: string[] | null }

  const targets = await validateForwarding(env, body.forwardingTo ?? [])

  // 只有「已验证的转发目标」才能绑定（发验证码到目标邮箱、回填验证）。
  if (targets.length > 0) {
    const verifiedSet = await loadVerifiedTargets(env, user.id)
    const unverified = targets.filter((t) => !verifiedSet.has(t.toLowerCase()))
    if (unverified.length > 0) {
      throw new ApiError(
        400,
        `以下邮箱尚未验证，请先发验证码完成验证：${unverified.join("、")}`,
        "FORWARD_TARGET_NOT_VERIFIED"
      )
    }
  }

  await env.DB.prepare("UPDATE mailboxes SET forwarding_to = ? WHERE id = ?")
    .bind(targets.length > 0 ? JSON.stringify(targets) : null, mailbox.id)
    .run()

  const updated = await requireMailbox(env, user, id)
  const afterSet = await loadVerifiedTargets(env, user.id)
  // ⚠️ 必须把 afterSet 传进去：漏传的话 forwardingVerified 会全为 null，
  // 前端用本响应覆盖列表后，刚验证好的「已转发」会被打回「转发待验证」
  // （转发实际正常，纯属状态显示回退 —— 2026-10-02 用户实测复现）。
  return json({
    mailbox: await toPublicMailbox(
      env, user, updated, afterSet, undefined, await primaryMailboxAddress(env, user)
    ),
    forwardingStatus: targets.map((t) => ({
      email: t,
      verified: afterSet.has(t.toLowerCase()),
    })),
  })
}

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

// POST /api/mailbox/forward-verify —— 发起 / 确认转发目标验证
export async function verifyForwardTarget(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json().catch(() => ({}))) as {
    email?: string
    action?: string
    code?: string
  }
  const email = (body.email ?? "").trim().toLowerCase()

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, "邮箱格式不正确", "INVALID_EMAIL")
  }
  if (await isOwnDomain(env, email)) {
    throw new ApiError(400, "不能转发到本站域名邮箱", "INVALID_EMAIL")
  }

  // 确认验证：回填验证码
  if (body.action === "confirm") {
    const code = String(body.code ?? "").trim()
    if (!/^\d{6}$/.test(code)) {
      throw new ApiError(400, "请输入 6 位数字验证码", "INVALID_CODE")
    }
    const row = await env.DB.prepare(
      "SELECT code_hash, expires_at, attempts FROM forward_verify_codes WHERE user_id = ? AND target_email = ?"
    )
      .bind(user.id, email)
      .first<{ code_hash: string; expires_at: string; attempts: number }>()
    if (!row || new Date(row.expires_at).getTime() < Date.now()) {
      throw new ApiError(400, "验证码已过期，请重新发送", "CODE_EXPIRED")
    }
    if (row.attempts >= 5) {
      throw new ApiError(400, "尝试次数过多，请重新发送", "TOO_MANY_ATTEMPTS")
    }
    if ((await hashToken(code)) !== row.code_hash) {
      await env.DB.prepare(
        "UPDATE forward_verify_codes SET attempts = attempts + 1 WHERE user_id = ? AND target_email = ?"
      )
        .bind(user.id, email)
        .run()
      throw new ApiError(400, "验证码错误", "INVALID_CODE")
    }
    const now = new Date().toISOString()
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO forwarding_verifications (user_id, target_email, verified_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id, target_email) DO UPDATE SET verified_at = excluded.verified_at`
      ).bind(user.id, email, now),
      env.DB.prepare(
        "DELETE FROM forward_verify_codes WHERE user_id = ? AND target_email = ?"
      ).bind(user.id, email),
    ])
    await audit(env, user.id, "mailbox.forward.verify", `验证转发目标 ${email}`)
    return json({ email, verified: true })
  }

  // 发起验证：生成验证码发到目标邮箱。限流防轰炸。
  if (!isAdminApiRequest(request)) {
    await guardRateLimit(
      env,
      `forward-verify:user:${user.id}`,
      10,
      3600,
      "转发验证请求过于频繁，请稍后再试"
    )
  }

  const code = generateVerifyCode()
  const now = new Date().toISOString()
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString()
  await env.DB.prepare(
    `INSERT INTO forward_verify_codes (user_id, target_email, code_hash, expires_at, attempts, created_at)
     VALUES (?, ?, ?, ?, 0, ?)
     ON CONFLICT(user_id, target_email) DO UPDATE SET code_hash = excluded.code_hash,
       expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at`
  )
    .bind(user.id, email, await hashToken(code), expiresAt, now)
    .run()

  const { text, html } = renderMail("验证转发目标邮箱", [
    `用户 ${user.username} 想把 doulor.cn 邮箱的邮件转发到 ${email}。`,
    `验证码是：${code}`,
    "验证码 10 分钟内有效。如果不是你本人操作，请忽略本邮件。",
  ])
  try {
    await sendMail(env, {
      to: email,
      subject: "【Doulor Cloud】转发目标验证码",
      text,
      html,
    })
  } catch (err) {
    console.error("发送转发验证码失败:", email, err)
    throw new ApiError(502, "发送验证码失败，请稍后重试", "MAIL_SEND_FAILED")
  }

  return json({ email, verified: false, message: "验证码已发送到该邮箱，请查收" })
}

// DELETE /api/mailbox/:id —— 删除邮箱（主邮箱不可删）
export async function deleteMailbox(env: Env, request: Request, id: string): Promise<Response> {
  const user = await requireUser(env, request)
  const mailbox = await requireMailbox(env, user, id)

  // 主邮箱不可删：判据是「注册时分配的那个域」，不是写死的 env.ROOT_DOMAIN
  const primary = await primaryMailboxAddress(env, user)
  if (mailbox.address.toLowerCase() === primary) {
    throw new ApiError(400, "主邮箱不可删除", "PRIMARY_MAILBOX")
  }

  await purgeMailbox(env, mailbox)
  return new Response(null, { status: 204 })
}

/**
 * 删除一个邮箱：先摘掉 Cloudflare 路由规则，再删表行。
 *
 * ⚠️ 2026-09-26：现在**不再逐条建 Cloudflare 路由规则**（catch-all 已由本 Worker 接管），
 * 但历史邮箱名下的规则还挂在 Cloudflare 上（线上尚存数十条），所以仍然要摘掉 ——
 * 否则它们会一直占着「每个域 200 条路由规则」的硬配额，而用户以为早就失效了。
 * 悬空的 rule_id 会返回 `ID not found`，属正常情况，忽略即可。
 *
 * 抽成函数是因为「删除邮箱」与「刷新临时邮箱」的清理部分必须完全一致。
 *
 * messages 行靠 ON DELETE CASCADE 一并清除（schema 已声明），
 * 所以刷新临时邮箱会顺带清掉旧地址收到的邮件，不会在 D1 里堆垃圾。
 */
async function purgeMailbox(env: Env, mailbox: MailboxRow): Promise<void> {
  // 规则删除失败不阻断：表行必须删掉，否则用户界面上会出现「删不掉的邮箱」。
  // 残留规则只会让旧地址继续把信投进 Worker，而 Worker 查不到 mailboxes 行时会直接拒收。
  if (mailbox.rule_id) {
    try {
      await cfDeleteEmailRule(env, env.ZONE_ID, mailbox.rule_id)
    } catch (err) {
      console.error("Email Routing 规则删除失败:", mailbox.address, err)
    }
  }

  await env.DB.prepare("DELETE FROM mailboxes WHERE id = ?").bind(mailbox.id).run()
}

// POST /api/mailbox/temp —— 生成一个临时邮箱（额度与普通邮箱独立）
export async function createTempMailbox(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)

  if (!isAdminApiRequest(request)) {
    await guardRateLimit(
      env,
      `mailbox:temp:write:${user.id}`,
      TEMP_WRITE_LIMIT_PER_HOUR,
      3600,
      "临时邮箱操作过于频繁"
    )
  }

  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM mailboxes WHERE user_id = ? AND is_temp = 1"
  )
    .bind(user.id)
    .first<{ c: number }>()

  if (!isAdminApiRequest(request) && !isPrivileged(user.role) && (count?.c ?? 0) >= MAX_TEMP_MAILBOXES_PER_USER) {
    throw new ApiError(
      400,
      `临时邮箱最多同时存在 ${MAX_TEMP_MAILBOXES_PER_USER} 个，请先删除或刷新已有的`,
      "LIMIT_REACHED"
    )
  }

  const created = await insertTempMailbox(env, user.id, isApiRequest(request) ? "api" : "web")
  return json(
    { mailbox: await toPublicMailbox(env, user, created, undefined, undefined, await primaryMailboxAddress(env, user)) },
    201
  )
}

/**
 * 临时邮箱「每天最多刷新次数」闸门（后台可配，默认 20；0 = 不限）。
 *
 * 用 `INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count`
 * 原子累加（与 api-engine 的限额、ratelimit 同思路），拿到的是「本次计入之后的
 * 计数」—— 超限的那次被拒，之后每次也都超，不会漏拦。
 * 管理员 / 站长不限（与其它配额口径一致）。
 */
async function enforceTempMailboxRefreshLimit(env: Env, user: UserRow): Promise<void> {
  if (isPrivileged(user.role)) return
  const limit = await getSettingNumber(env, "temp_mailbox_refresh_daily_limit")
  if (limit <= 0) return

  const row = await env.DB.prepare(
    `INSERT INTO temp_mailbox_refresh_daily (user_id, date, count)
     VALUES (?, ?, 1)
     ON CONFLICT(user_id, date) DO UPDATE SET count = count + 1
     RETURNING count`
  )
    .bind(user.id, siteDayString(new Date(), await siteOffsetHours(env)))
    .first<{ count: number }>()

  if ((row?.count ?? 1) > limit) {
    throw new ApiError(
      429,
      `临时邮箱每天最多刷新 ${limit} 次，请明天再试`,
      "TEMP_MAILBOX_DAILY_LIMIT"
    )
  }
}

/**
 * POST /api/mailbox/temp/:id/refresh —— 换一个地址（旧地址立即作废）
 *
 * 语义上「刷新」是**删除旧邮箱并新建一个**，而不是在原行上改地址：
 *   1. 旧地址收到的邮件属于上一个身份，留着会让收件箱混进「上个马甲」的信；
 *      删行后 messages 随级联一起清掉，也让 D1 不积累垃圾邮件。
 *   2. 旧的 Cloudflare 路由规则必须摘掉，否则旧地址依然收信。
 */
export async function refreshTempMailbox(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const user = await requireUser(env, request)
  const mailbox = await requireMailbox(env, user, id)

  if (mailbox.is_temp !== 1) {
    // 普通邮箱不能刷新地址：它的地址是用户自己取的，改掉等于静默删除
    throw new ApiError(400, "只有临时邮箱可以刷新地址", "NOT_TEMP_MAILBOX")
  }

  if (!isAdminApiRequest(request)) {
    await guardRateLimit(
      env,
      `mailbox:temp:write:${user.id}`,
      TEMP_WRITE_LIMIT_PER_HOUR,
      3600,
      "临时邮箱操作过于频繁"
    )
  }

  // 每日刷新次数上限（后台可配，默认 20；0 = 不限）。放在 purge 之前：
  // 超限那次绝不能动旧邮箱，否则用户「今天的刷新额度」被浪费掉、还得再点一次生成。
  await enforceTempMailboxRefreshLimit(env, user)

  // 先删后建：若中间失败，用户只是少了一个临时邮箱（可再点一次生成），
  // 不会出现「两个邮箱抢同一个地址」或额度被凭空占掉的情况。
  await purgeMailbox(env, mailbox)

  const created = await insertTempMailbox(env, user.id, isApiRequest(request) ? "api" : "web")
  return json(
    { mailbox: await toPublicMailbox(env, user, created, undefined, undefined, await primaryMailboxAddress(env, user)) },
    201
  )
}

/**
 * 生成并落库一个临时邮箱（含 Cloudflare 路由规则）。
 *
 * 抽出来给「新建」与「刷新」共用：两者的创建部分必须逐字一致，
 * 否则刷新出来的邮箱可能出现「少了某个字段」这类只在刷新路径上复现的问题
 * （例如没建 CF 规则，表现为收不到信）。
 */
async function insertTempMailbox(
  env: Env,
  userId: string,
  source: "web" | "api" = "web"
): Promise<MailboxRow> {
  // 临时邮箱也建在**默认根域**（与注册分配一致），不写死 env.ROOT_DOMAIN
  const root = (await getDefaultRootDomain(env)).name

  // 随机前缀可能撞上：① 系统保留名（admin / postmaster 之类）
  // ② 已存在的地址（含其他用户的主邮箱和临时邮箱）。
  // 概率极低，但不检查就会直接命中 UNIQUE 约束抛 500，所以重试几次。
  let address: string | null = null
  for (let attempt = 0; attempt < 5; attempt++) {
    const localPart = randomTempLocalPart()
    if (isReservedName(localPart)) continue
    const candidate = `${localPart}@${root}`
    const exists = await env.DB.prepare(
      "SELECT id FROM mailboxes WHERE address = ? COLLATE NOCASE LIMIT 1"
    )
      .bind(candidate)
      .first()
    if (!exists) {
      address = candidate
      break
    }
  }
  if (!address) {
    // 5 次都撞上，几乎只可能是 D1 出了问题，如实报错让用户重试
    throw new ApiError(500, "生成临时邮箱失败，请重试", "INTERNAL")
  }

  const id = uuid()
  const now = new Date().toISOString()
  // 与普通邮箱一致：不再逐条建 Cloudflare 规则（catch-all 已由本 Worker 接管）。
  // forwarding_to 恒为 NULL：临时邮箱不提供转发配置，避免被当成转发跳板。
  await env.DB.prepare(
    "INSERT INTO mailboxes (id, user_id, address, forwarding_to, source, created_at, is_temp) VALUES (?, ?, ?, NULL, ?, ?, 1)"
  )
    .bind(id, userId, address, source, now)
    .run()

  const row = await env.DB.prepare("SELECT * FROM mailboxes WHERE id = ?")
    .bind(id)
    .first<MailboxRow>()
  return row!
}

/**
 * 消息列表每页条数。
 *
 * ⚠️ 2026-09-25 审计（M16）：这个接口原先写死 `LIMIT 100` 且**没有游标**，
 * 于是收件箱超过 100 封之后，旧邮件在界面上**永久不可达**，而且接口也不告知
 * 自己截断了 —— 用户只会觉得「邮件丢了」。这里保持默认 100 不变
 * （第一页行为与修复前完全一致，不制造回归），只是把「下一页」暴露出来。
 */
const MESSAGES_DEFAULT_LIMIT = 100
const MESSAGES_MAX_LIMIT = 100

// GET /api/mailbox/:id/messages?cursor=&limit= —— 消息列表（不含正文）
export async function listMessages(
  env: Env,
  request: Request,
  mailboxId: string
): Promise<Response> {
  const user = await requireUser(env, request)
  const mailbox = await requireMailbox(env, user, mailboxId)

  const url = new URL(request.url)
  const rawLimit = Number(url.searchParams.get("limit") ?? MESSAGES_DEFAULT_LIMIT)
  const limit = Math.min(
    Math.max(Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : MESSAGES_DEFAULT_LIMIT, 1),
    MESSAGES_MAX_LIMIT
  )
  const cursor = url.searchParams.get("cursor")

  let where = "mailbox_id = ?"
  const binds: unknown[] = [mailbox.id]
  if (cursor) {
    const c = decodeCursor(cursor)
    if (c) {
      // 复合游标 (received_at, id) 双键降序 —— 与 community.ts 的列表同一套做法。
      // 只按 received_at 翻页是错的：同一时间戳上的多封邮件会被整批跳过，
      // 而邮件是**批量到达**的（同一次投递/导入时间戳完全相同），这个场景很常见。
      where += " AND (received_at < ? OR (received_at = ? AND id < ?))"
      binds.push(c.createdAt, c.createdAt, c.id)
    }
  }

  const rows = await env.DB.prepare(
    `SELECT id, mailbox_id, from_address, subject, '' AS text_body, read, received_at
       FROM messages WHERE ${where}
      ORDER BY received_at DESC, id DESC
      LIMIT ?`
  )
    .bind(...binds, limit)
    .all<MessageRow>()

  const messages = rows.results ?? []
  const last = messages[messages.length - 1]
  // 只有「恰好取满一页」才可能还有下一页（与 community.ts 的判定一致）
  const nextCursor =
    messages.length === limit && last ? encodeCursor(last.received_at, last.id) : null

  return json({ messages: messages.map(toPublicMessage), nextCursor })
}

// GET /api/mailbox/:id/messages/:messageId —— 单条消息（含正文，自动标已读）
export async function getMessage(
  env: Env,
  request: Request,
  mailboxId: string,
  messageId: string
): Promise<Response> {
  const user = await requireUser(env, request)
  const mailbox = await requireMailbox(env, user, mailboxId)

  const row = await env.DB.prepare(
    "SELECT * FROM messages WHERE id = ? AND mailbox_id = ?"
  )
    .bind(messageId, mailbox.id)
    .first<MessageRow>()

  if (!row) {
    throw new ApiError(404, "邮件不存在", "NOT_FOUND")
  }

  if (row.read === 0) {
    // 未读 → 已读：除更新行状态外，累加「累计已读封数」成就计数（删邮件不清减）
    await env.DB.batch([
      env.DB.prepare("UPDATE messages SET read = 1 WHERE id = ?").bind(messageId),
      env.DB.prepare(
        "UPDATE user_stats SET mail_read_count = mail_read_count + 1 WHERE user_id = ?"
      ).bind(user.id),
    ])
    row.read = 1
  }

  return json({ message: toPublicMessage(row) })
}

// POST /api/mailbox/:id/messages/:messageId/read —— 标记已读/未读
export async function markMessage(
  env: Env,
  request: Request,
  mailboxId: string,
  messageId: string
): Promise<Response> {
  const user = await requireUser(env, request)
  const mailbox = await requireMailbox(env, user, mailboxId)
  const body = (await request.json()) as { read?: boolean }

  const row = await env.DB.prepare(
    "SELECT read FROM messages WHERE id = ? AND mailbox_id = ?"
  )
    .bind(messageId, mailbox.id)
    .first<{ read: number }>()

  if (!row) {
    throw new ApiError(404, "邮件不存在", "NOT_FOUND")
  }

  const target = body.read === false ? 0 : 1
  await env.DB.prepare("UPDATE messages SET read = ? WHERE id = ?")
    .bind(target, messageId)
    .run()

  // 未读 → 已读 才算一次「累计已读」（成就计数），反复标记 / 标回未读不重复累加
  if (row.read === 0 && target === 1) {
    await env.DB.prepare(
      "UPDATE user_stats SET mail_read_count = mail_read_count + 1 WHERE user_id = ?"
    )
      .bind(user.id)
      .run()
  }

  return new Response(null, { status: 204 })
}

/**
 * POST /api/mailbox/read-all —— 把当前用户所有未读邮件标为已读。
 * 不限某个 mailbox，覆盖该用户名下全部收件箱。
 */
export async function markAllRead(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  // messages 通过 mailbox_id 关联到 mailboxes.user_id，一次 UPDATE 覆盖
  const result = await env.DB.prepare(
    `UPDATE messages SET read = 1
     WHERE read = 0 AND mailbox_id IN (SELECT id FROM mailboxes WHERE user_id = ?)`
  )
    .bind(user.id)
    .run()
  const changed = result.meta?.changes ?? 0
  // 本次实际从未读变已读的封数，一并累加进「累计已读」
  if (changed > 0) {
    await env.DB.prepare(
      "UPDATE user_stats SET mail_read_count = mail_read_count + ? WHERE user_id = ?"
    )
      .bind(changed, user.id)
      .run()
  }
  return json({ updated: changed })
}

// DELETE /api/mailbox/:id/messages/:messageId —— 删除消息
export async function deleteMessage(
  env: Env,
  request: Request,
  mailboxId: string,
  messageId: string
): Promise<Response> {
  const user = await requireUser(env, request)
  const mailbox = await requireMailbox(env, user, mailboxId)

  const row = await env.DB.prepare(
    "SELECT id FROM messages WHERE id = ? AND mailbox_id = ?"
  )
    .bind(messageId, mailbox.id)
    .first()

  if (!row) {
    throw new ApiError(404, "邮件不存在", "NOT_FOUND")
  }

  await env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(messageId).run()
  return new Response(null, { status: 204 })
}

// POST /mailbox/:id/messages/batch-delete —— 批量删除消息（2026-10-04 用户建议收件箱批量删除）
export async function batchDeleteMessages(
  env: Env,
  request: Request,
  mailboxId: string
): Promise<Response> {
  const user = await requireUser(env, request)
  const mailbox = await requireMailbox(env, user, mailboxId)

  const body = (await request.json().catch(() => ({}))) as { ids?: unknown }
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((x): x is string => typeof x === "string").slice(0, 1000)
    : []
  if (ids.length === 0) {
    throw new ApiError(400, "没有要删除的邮件", "INVALID_INPUT")
  }

  // 只删属于当前 mailbox 的邮件（带 mailbox_id 守卫，防止越权删到别的邮箱）。
  //
  // ⚠️ 必须**分批**：D1 单条语句最多 100 个绑定参数，而这里每个 id 占 1 个、
  //    再加 mailbox_id 本身，所以一次最多放 99 个 id。2026-10-05 用户反馈
  //    「批量删除 ≥100 条报内部错误」就是这个坑：原实现一次 IN (?,?,…) 塞进
  //    最多 100 个 id ⇒ 101 个参数 ⇒ 直接 500。按 99 一批切，累加删除数。
  const CHUNK = 99
  let deleted = 0
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK)
    const placeholders = slice.map(() => "?").join(",")
    const result = await env.DB.prepare(
      `DELETE FROM messages WHERE mailbox_id = ? AND id IN (${placeholders})`
    )
      .bind(mailbox.id, ...slice)
      .run()
    deleted += result.meta?.changes ?? 0
  }

  return json({ deleted })
}

// ---- 站内互发（不出门，直接落对方收件箱）----

/** 站内互发正文上限（字符）：够写长信，又不至于把 D1 单值撑爆 */
const MAX_COMPOSE_CHARS = 20_000
/** 站内互发限流：每人每小时 30 封（防止被当站内垃圾信群发器） */
const SEND_LIMIT_PER_HOUR = 30

/**
 * POST /api/mailbox/:id/send —— 站内互发（只发给本站根域邮箱）。
 *
 * 与已移除的「对外发信」的最大区别：这条**不出门**。信不需要经过 SMTP 投递，
 * 直接把一行存进收件人的收件箱（复用入站 `email-delivery.ts` 的同一条落库口径），
 * 所以**不需要任何付费的 Cloudflare Email Sending**，立刻可用。
 *
 * 收口设计（务必保持）：
 *   1. 发件邮箱必须是用户自己的（requireMailbox）；
 *   2. 收件地址必须是本站已登记的根域（isOwnDomain）—— 只允许站内互发，
 *      外部地址一律拒绝（否则就成了开放中继）；
 *   3. 收件邮箱必须**已存在** —— 不存在就报错，与入站同口径（不静默吞信）；
 *   4. 发件地址由服务端从邮箱推导，**绝不接受前端传入**（否则可伪造发件人）；
 *   5. 每人每小时 30 封（fail-open 限流）。
 *
 * ⚠️ 不会成环：这是**直接落库**，不走 SMTP 转发，A→B 就是往 B 的收件箱插一行，
 *   不存在「回信又触发发送」的链路。（旧 reply 功能禁回本站域名是为了防 SMTP 转发成环，
 *   与本路径无关。）
 */
export async function sendInternalMessage(
  env: Env,
  request: Request,
  mailboxId: string
): Promise<Response> {
  const user = await requireUser(env, request)
  const mailbox = await requireMailbox(env, user, mailboxId)

  const body = (await request.json().catch(() => ({}))) as {
    to?: unknown
    subject?: unknown
    text?: unknown
  }
  const to = typeof body.to === "string" ? body.to.trim().toLowerCase() : ""
  const text = typeof body.text === "string" ? body.text.trim() : ""
  const subject =
    typeof body.subject === "string" ? body.subject.trim().slice(0, 300) : ""

  if (!text) {
    throw new ApiError(400, "正文不能为空", "INVALID_INPUT")
  }
  if (text.length > MAX_COMPOSE_CHARS) {
    throw new ApiError(400, `正文过长（上限 ${MAX_COMPOSE_CHARS} 字）`, "TOO_LARGE")
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    throw new ApiError(400, "收件地址格式不正确", "INVALID_INPUT")
  }
  if (!(await isOwnDomain(env, to))) {
    throw new ApiError(400, "只能发送给本站邮箱", "NOT_INTERNAL")
  }

  const target = await env.DB.prepare(
    "SELECT id FROM mailboxes WHERE address = ? COLLATE NOCASE"
  )
    .bind(to)
    .first<{ id: string }>()
  if (!target) {
    throw new ApiError(404, "收件人的邮箱不存在", "NOT_FOUND")
  }

  if (!isAdminApiRequest(request)) {
    await guardRateLimit(
      env,
      `email:send:user:${user.id}`,
      SEND_LIMIT_PER_HOUR,
      3600,
      "发信过于频繁"
    )
  }

  // 发件地址固定取发件邮箱本身（服务端推导，前端无从伪造）
  await env.DB.prepare(
    `INSERT INTO messages (id, mailbox_id, from_address, subject, text_body, read, received_at, rfc_message_id)
     VALUES (?, ?, ?, ?, ?, 0, ?, NULL)`
  )
    .bind(uuid(), target.id, mailbox.address.slice(0, 320), subject, text, new Date().toISOString())
    .run()

  await audit(
    env,
    user.id,
    "email.send_internal",
    `${mailbox.address} → ${to}`,
    request.headers.get("CF-Connecting-IP")
  )

  return json({ ok: true, to })
}
