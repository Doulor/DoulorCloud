import { ApiError, json } from "../http"
import { uuid } from "../crypto"
import { isReservedName } from "../reserved-names"
import { requireUser, type UserRow } from "../auth"
import {
  cfCreateEmailRule,
  cfDeleteEmailRule,
  cfListDestinations,
} from "../cloudflare"
import type { Env } from "../env"

const MAX_MAILBOXES_PER_USER = 3
/** 管理员「不限」哨兵值（前端见到显示「不限」） */
const ADMIN_UNLIMITED_MAILBOXES = 999999

interface MailboxRow {
  id: string
  user_id: string
  address: string
  forwarding_to: string | null
  last_forwarded_at: string | null
  rule_id: string | null
  last_forward_error: string | null
  created_at: string
}

interface MessageRow {
  id: string
  mailbox_id: string
  from_address: string
  subject: string
  text_body: string
  read: number
  received_at: string
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

async function toPublicMailbox(
  env: Env,
  user: UserRow,
  row: MailboxRow,
  verifiedSet?: Set<string>
) {
  const stats = await mailboxStats(env, row.id)
  const forwardingTo = parseForwarding(row.forwarding_to)
  return {
    id: row.id,
    address: row.address,
    primary: row.address === `${user.username}@${env.ROOT_DOMAIN}`.toLowerCase(),
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

/** 拉取账户级已验证 destination 集合；失败时返回 undefined 表示「未知」 */
async function loadVerifiedSet(env: Env): Promise<Set<string> | undefined> {
  try {
    const dests = await cfListDestinations(env)
    return new Set(
      dests.filter((d) => d.verified !== null).map((d) => d.email.toLowerCase())
    )
  } catch (err) {
    console.error("获取转发地址验证状态失败:", err)
    return undefined
  }
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

function validateForwarding(forwardingTo: string[], rootDomain: string): string[] {
  const targets = forwardingTo
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3)

  if (
    targets.some(
      (f) =>
        f.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f) ||
        f.toLowerCase().endsWith(`@${rootDomain.toLowerCase()}`)
    )
  ) {
    throw new ApiError(400, "转发邮箱格式无效", "INVALID_FORWARD")
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

  const verifiedSet = await loadVerifiedSet(env)
  const mailboxes = []
  for (const row of rows.results ?? []) {
    mailboxes.push(await toPublicMailbox(env, user, row, verifiedSet))
  }
  // 邮箱数量上限（管理员不限，999999 作为哨兵值，前端显示「不限」）
  const limit = user.role === "admin" ? ADMIN_UNLIMITED_MAILBOXES : MAX_MAILBOXES_PER_USER
  return json({ mailboxes, limit })
}

// POST /api/mailbox —— 添加邮箱地址（{ localPart }），最多 3 个
export async function createMailbox(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json()) as { localPart?: string }

  const localPart = (body.localPart ?? "").trim().toLowerCase()
  if (!/^[a-z0-9._-]{1,40}$/.test(localPart)) {
    throw new ApiError(400, "邮箱前缀只能包含小写字母、数字和 . _ -", "INVALID_ALIAS")
  }
  // 防止冒充平台（如 admin@ / postmaster@ / noreply@），也避免占走他人用户名
  if (isReservedName(localPart)) {
    throw new ApiError(400, "该邮箱前缀为系统保留名称", "RESERVED_NAME")
  }

  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM mailboxes WHERE user_id = ?"
  )
    .bind(user.id)
    .first<{ c: number }>()

  if (user.role !== "admin" && (count?.c ?? 0) >= MAX_MAILBOXES_PER_USER) {
    throw new ApiError(400, `每个用户最多 ${MAX_MAILBOXES_PER_USER} 个邮箱`, "LIMIT_REACHED")
  }

  const address = `${localPart}@${env.ROOT_DOMAIN}`
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

  // 为入站邮件创建 Email Routing 规则（地址 → 本 Worker）；失败不阻断邮箱创建，稍后可回填
  let ruleId: string | null = null
  try {
    ruleId = await cfCreateEmailRule(
      env,
      env.ZONE_ID,
      address,
      env.EMAIL_WORKER_NAME ?? "doulor-mail-api"
    )
  } catch (err) {
    console.error("Email Routing 规则创建失败（邮箱仍已创建）:", address, err)
  }

  await env.DB.prepare(
    "INSERT INTO mailboxes (id, user_id, address, forwarding_to, rule_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(id, user.id, address, defaultForwarding, ruleId, now)
    .run()

  const row = await env.DB.prepare("SELECT * FROM mailboxes WHERE id = ?")
    .bind(id)
    .first<MailboxRow>()

  return json({ mailbox: await toPublicMailbox(env, user, row!) }, 201)
}

// PUT /api/mailbox/:id —— 更新转发目标（空 = 不转发）
export async function updateMailbox(env: Env, request: Request, id: string): Promise<Response> {
  const user = await requireUser(env, request)
  const mailbox = await requireMailbox(env, user, id)
  const body = (await request.json()) as { forwardingTo?: string[] | null }

  const targets = validateForwarding(body.forwardingTo ?? [], env.ROOT_DOMAIN)

  // 只有「在设置里验证过的真实邮箱」才能作为转发目标。
  // 未验证的地址不仅 Cloudflare 会拒绝转发，还会让用户误以为配置成功。
  if (targets.length > 0) {
    const verified = await loadVerifiedSet(env)
    // 查询失败时按「全部未验证」处理 —— 宁可拒绝，也不要写入一个转发不了的配置
    const verifiedSet = verified ?? new Set<string>()
    const unverified = targets.filter((t) => !verifiedSet.has(t.toLowerCase()))
    if (unverified.length > 0) {
      throw new ApiError(
        400,
        verified === undefined
          ? "暂时无法确认邮箱验证状态，请稍后重试"
          : `以下邮箱尚未验证，请先到「设置」完成真实邮箱验证：${unverified.join("、")}`,
        "FORWARD_TARGET_NOT_VERIFIED"
      )
    }
  }

  await env.DB.prepare("UPDATE mailboxes SET forwarding_to = ? WHERE id = ?")
    .bind(targets.length > 0 ? JSON.stringify(targets) : null, mailbox.id)
    .run()

  const updated = await requireMailbox(env, user, id)
  const afterSet = (await loadVerifiedSet(env)) ?? new Set<string>()
  return json({
    mailbox: await toPublicMailbox(env, user, updated),
    forwardingStatus: targets.map((t) => ({
      email: t,
      verified: afterSet.has(t.toLowerCase()),
    })),
  })
}

// DELETE /api/mailbox/:id —— 删除邮箱（主邮箱不可删）
export async function deleteMailbox(env: Env, request: Request, id: string): Promise<Response> {
  const user = await requireUser(env, request)
  const mailbox = await requireMailbox(env, user, id)

  const primary = `${user.username}@${env.ROOT_DOMAIN}`.toLowerCase()
  if (mailbox.address === primary) {
    throw new ApiError(400, "主邮箱不可删除", "PRIMARY_MAILBOX")
  }

  if (mailbox.rule_id) {
    try {
      await cfDeleteEmailRule(env, env.ZONE_ID, mailbox.rule_id)
    } catch (err) {
      console.error("Email Routing 规则删除失败:", mailbox.address, err)
    }
  }

  await env.DB.prepare("DELETE FROM mailboxes WHERE id = ?").bind(id).run()
  return new Response(null, { status: 204 })
}

// GET /api/mailbox/:id/messages —— 消息列表（不含正文）
export async function listMessages(
  env: Env,
  request: Request,
  mailboxId: string
): Promise<Response> {
  const user = await requireUser(env, request)
  const mailbox = await requireMailbox(env, user, mailboxId)

  const rows = await env.DB.prepare(
    `SELECT id, mailbox_id, from_address, subject, '' AS text_body, read, received_at
       FROM messages WHERE mailbox_id = ? ORDER BY received_at DESC LIMIT 100`
  )
    .bind(mailbox.id)
    .all<MessageRow>()

  return json({ messages: (rows.results ?? []).map(toPublicMessage) })
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
    await env.DB.prepare("UPDATE messages SET read = 1 WHERE id = ?").bind(messageId).run()
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
    "SELECT id FROM messages WHERE id = ? AND mailbox_id = ?"
  )
    .bind(messageId, mailbox.id)
    .first()

  if (!row) {
    throw new ApiError(404, "邮件不存在", "NOT_FOUND")
  }

  await env.DB.prepare("UPDATE messages SET read = ? WHERE id = ?")
    .bind(body.read === false ? 0 : 1, messageId)
    .run()

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
  return json({ updated: result.meta?.changes ?? 0 })
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