/**
 * 管理面板 → 邮箱管理（2026-10-08 新增；形态与「子域名管理」一致，挂在 DNS 管理页的 tab 下）。
 *
 * 为什么需要：
 *   用户侧 `/api/mailbox` 只能管自己的邮箱，且有几条硬规则 —— 每用户最多 3 个、
 *   地址建好不能改（只能改转发目标）、转发目标必须先收验证码验证、主邮箱不可删。
 *   站长要做的是**代替平台处置**：给用户补一个邮箱、把用户填错的地址改掉、
 *   在用户原来的目标邮箱已失效时帮他把转发设上、删掉滥用/废弃的邮箱，
 *   以及**看看里面到底有什么**（排查滥用最关键的一步）。这些动作的共同点是
 *   「目标用户不是当前登录人」，所以整套接口按 `dns` 管理 scope 鉴权
 *   （与子域名管理同一把钥匙：都归「用户的域名资源」），每次写都记审计。
 *
 * 与用户侧的四条刻意差异（每条都写清理由，改之前先读）：
 *   1. **地址可改**（改名 / 换域）—— 用户侧没有这个能力。改名要查唯一性、
 *      保留名、并把历史遗留的 Cloudflare 路由规则摘掉（见下）。
 *   2. **转发目标免验证** —— 用户侧必须验证目标邮箱；站长代设时允许直接写。
 *      这只应用于「用户原来的目标邮箱已经收不到信」的补救场景，所以每次都记审计。
 *   3. **不占用户的 3 个名额** —— 与子域名代建一致：管理员代建绕配额，但仍查冲突/保留名。
 *   4. **可以删主邮箱** —— 用户侧禁止（怕自己把自己弄瞎）；站长可能需要重建
 *      （比如注册地址当年建错了）。前端会在确认框里标出「这是主邮箱」。
 *
 * ⚠️ 但有一条不能破：**删除必须走用户侧同一个 purgeMailbox 流程**
 *   （先摘历史 Cloudflare Email Routing 规则再删行）—— 否则那些规则会永久占着
 *   「每域 200 条」的硬配额，而用户以为邮箱早没了。
 *
 * ⚠️ 管理端**查看邮件不会把它标记为已读**：用户侧 getMessage 会自动标已读并累加
 *   成就计数，站长翻一遍收件箱就等于替用户清了未读、还刷了人家的成就。
 *   只读不写是有意为之（读取本身会记一条审计）。
 */
import { ApiError, json } from "../http"
import { uuid } from "../crypto"
import { requireAdminScope } from "./admin"
import { isReservedName } from "../reserved-names"
import { guardRateLimit } from "../ratelimit"
import { cfDeleteEmailRule } from "../cloudflare"
import {
  isOwnDomain,
  pickRootDomain,
  listEnabledRootDomains,
  primaryAddressFor,
} from "../root-domains"
import { allPermissions } from "../permissions"
import { audit as recordAudit } from "../settings"
import { likeContains } from "../sql-like"
import { encodeCursor, decodeCursor } from "../community-logic"
// 删除复用用户侧的同一条清理路径（摘 CF 规则 + 删行），不要在这里另写一份
import { purgeMailbox } from "./email"
import type { Env } from "../env"

/** 与用户侧一致：转发目标最多 3 个 */
const MAX_FORWARD_TARGETS = 3
/** 与用户侧 createMailbox 一致的前缀规则 */
const LOCAL_PART_RE = /^[a-z0-9._-]{1,40}$/
/** 一页最多 100 条（列表与邮件列表同口径） */
const MAX_PAGE_SIZE = 100

interface MailboxRow {
  id: string
  user_id: string
  address: string
  forwarding_to: string | null
  last_forwarded_at: string | null
  rule_id: string | null
  /** 最近一次转发失败原因（迁移 0006）；管理端不展示，但 purgeMailbox 的行类型要求它 */
  last_forward_error: string | null
  created_at: string
  /** 1 = 临时邮箱（迁移 0051） */
  is_temp?: number
  /** 'web' | 'api' | 'admin'（迁移 0106 新增，用于成就计数排除 API 产生的数据） */
  source?: string | null
}

interface OwnerRow {
  id: string
  username: string
  email: string
  status: string
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

/** 列表单行（含归属用户） */
interface AdminMailboxView {
  id: string
  address: string
  /** 主邮箱（注册时分配的那个地址）：删它前要在确认框里点名提醒 */
  primary: boolean
  /** true = 临时邮箱（用完就换的那类，通常不用管） */
  isTemp: boolean
  forwardingTo: { email: string; verified: boolean }[]
  messageCount: number
  unreadCount: number
  createdAt: string
  /** 建这个邮箱时从哪来的：web（用户自己）/ api（公开 API）/ admin（这里代建） */
  source: string
  owner: { id: string; username: string; email: string; status: string }
}

function parseForwarding(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string")
  } catch {
    // 脏数据按「没有转发」处理：不阻断管理端的列表
  }
  return []
}

/** 按 userId 或 username 找归属用户（与子域名管理的同名助手同一口径） */
async function resolveOwner(
  env: Env,
  userId: string | undefined,
  username: string | undefined
): Promise<OwnerRow> {
  if (userId) {
    const row = await env.DB.prepare(
      "SELECT id, username, email, status FROM users WHERE id = ?"
    )
      .bind(userId)
      .first<OwnerRow>()
    if (!row) throw new ApiError(404, "目标用户不存在", "USER_NOT_FOUND")
    return row
  }
  if (username) {
    const row = await env.DB.prepare(
      "SELECT id, username, email, status FROM users WHERE username = ? COLLATE NOCASE"
    )
      .bind(username)
      .first<OwnerRow>()
    if (!row) throw new ApiError(404, "目标用户不存在", "USER_NOT_FOUND")
    return row
  }
  throw new ApiError(400, "请指定归属用户（userId 或 username）", "OWNER_REQUIRED")
}

/** 校验转发目标（管理端口径：免「目标已验证」检查，其余与用户侧一致） */
async function validateAdminForwarding(env: Env, input: string[]): Promise<string[]> {
  const seen = new Set<string>()
  const targets = input
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => {
      const key = s.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, MAX_FORWARD_TARGETS)

  if (targets.some((f) => f.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f))) {
    throw new ApiError(400, "转发邮箱格式无效", "INVALID_FORWARD")
  }
  for (const f of targets) {
    // 转发到本站任一域名 = 自己给自己转发（成环），用户侧与管理端都不允许
    if (await isOwnDomain(env, f)) {
      throw new ApiError(400, "不能转发到本站域名邮箱", "INVALID_FORWARD")
    }
  }
  return targets
}

/** 该用户已验证过的转发目标（小写集合） */
async function loadVerifiedTargets(env: Env, userId: string): Promise<Set<string>> {
  const rows = await env.DB.prepare(
    "SELECT target_email FROM forwarding_verifications WHERE user_id = ?"
  )
    .bind(userId)
    .all<{ target_email: string }>()
  return new Set((rows.results ?? []).map((r) => r.target_email.toLowerCase()))
}

/** 单行 → 视图（统计与已验证集合由调用方批量算好传进来） */
function toView(
  row: MailboxRow,
  owner: OwnerRow,
  stats: { total: number; unread: number },
  verified: Set<string>,
  primaryAddress: string
): AdminMailboxView {
  return {
    id: row.id,
    address: row.address,
    primary: row.address.toLowerCase() === primaryAddress,
    isTemp: row.is_temp === 1,
    forwardingTo: parseForwarding(row.forwarding_to).map((email) => ({
      email,
      verified: verified.has(email.toLowerCase()),
    })),
    messageCount: stats.total,
    unreadCount: stats.unread,
    createdAt: row.created_at,
    source: row.source ?? "web",
    owner: { id: owner.id, username: owner.username, email: owner.email, status: owner.status },
  }
}

/** GET /api/admin/mailboxes —— 全站邮箱列表（跨用户、可搜索） */
export async function listAdminMailboxes(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "dns")
  const url = new URL(request.url)
  const q = (url.searchParams.get("q") ?? "").trim()
  const page = Math.max(1, Math.trunc(Number(url.searchParams.get("page")) || 1))
  const pageSize = Math.min(
    Math.max(1, Math.trunc(Number(url.searchParams.get("pageSize")) || 20)),
    MAX_PAGE_SIZE
  )

  const where: string[] = []
  const binds: unknown[] = []
  if (q) {
    // 地址 / 用户名 / 邮箱都能搜 —— 站长手里通常只有其中一条线索
    where.push("(m.address LIKE ? OR u.username LIKE ? OR u.email LIKE ?)")
    const like = likeContains(q)
    binds.push(like, like, like)
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""

  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM mailboxes m JOIN users u ON u.id = m.user_id ${whereSql}`
  )
    .bind(...binds)
    .first<{ c: number }>()

  const rows = await env.DB.prepare(
    `SELECT m.*, u.username, u.email, u.status AS user_status
       FROM mailboxes m
       JOIN users u ON u.id = m.user_id
       ${whereSql}
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?`
  )
    .bind(...binds, pageSize, (page - 1) * pageSize)
    .all<MailboxRow & { username: string; email: string; user_status: string }>()

  const list = rows.results ?? []
  const ids = list.map((r) => r.id)
  const userIds = [...new Set(list.map((r) => r.user_id))]

  // 邮件统计：一次 GROUP BY 拿全本页（避免 N+1）
  const statsMap = new Map<string, { total: number; unread: number }>()
  const verifiedMap = new Map<string, Set<string>>()
  const primaryMap = new Map<string, string>()
  if (ids.length > 0) {
    const ph = ids.map(() => "?").join(",")
    const stats = await env.DB.prepare(
      `SELECT mailbox_id, COUNT(*) AS total, COALESCE(SUM(read = 0), 0) AS unread
         FROM messages WHERE mailbox_id IN (${ph}) GROUP BY mailbox_id`
    )
      .bind(...ids)
      .all<{ mailbox_id: string; total: number; unread: number }>()
    for (const r of stats.results ?? []) {
      statsMap.set(r.mailbox_id, { total: Number(r.total ?? 0), unread: Number(r.unread ?? 0) })
    }
  }
  if (userIds.length > 0) {
    const ph = userIds.map(() => "?").join(",")
    // 已验证的转发目标（用于在列表里标出「转发待验证」）
    const verified = await env.DB.prepare(
      `SELECT user_id, target_email FROM forwarding_verifications WHERE user_id IN (${ph})`
    )
      .bind(...userIds)
      .all<{ user_id: string; target_email: string }>()
    for (const r of verified.results ?? []) {
      let set = verifiedMap.get(r.user_id)
      if (!set) {
        set = new Set<string>()
        verifiedMap.set(r.user_id, set)
      }
      set.add(r.target_email.toLowerCase())
    }
    // 主邮箱地址：每个用户算一次（内部要查注册域），本页最多 20 个用户
    await Promise.all(
      list.map(async (r) => {
        if (primaryMap.has(r.user_id)) return
        primaryMap.set(r.user_id, await primaryAddressFor(env, r.user_id, r.username))
      })
    )
  }

  const mailboxes: AdminMailboxView[] = list.map((r) =>
    toView(
      r,
      { id: r.user_id, username: r.username, email: r.email, status: r.user_status },
      statsMap.get(r.id) ?? { total: 0, unread: 0 },
      verifiedMap.get(r.user_id) ?? new Set<string>(),
      primaryMap.get(r.user_id) ?? ""
    )
  )

  return json({
    mailboxes,
    total: Number(totalRow?.c ?? 0),
    page,
    pageSize,
    // 代建时可选的根域（只给已启用的；管理员代建不按目标用户的权限域过滤）
    rootDomains: (await listEnabledRootDomains(env)).map((r) => ({
      name: r.name,
      label: r.label ?? r.name,
    })),
  })
}

/** GET /api/admin/mailboxes/owners?q= —— 归属用户联想搜索（用户名/邮箱，最多 20 条） */
export async function searchMailboxOwners(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "dns")
  const url = new URL(request.url)
  const q = (url.searchParams.get("q") ?? "").trim()
  const like = likeContains(q)
  const rows = await env.DB.prepare(
    `SELECT id, username, email, status FROM users
      WHERE username LIKE ? OR email LIKE ?
      ORDER BY created_at DESC
      LIMIT 20`
  )
    .bind(like, like)
    .all<OwnerRow>()
  return json({ owners: rows.results ?? [] })
}

/** 写操作的统一限流（代建/改名/删除共用一个桶） */
async function guardWrite(env: Env, adminId: string): Promise<void> {
  await guardRateLimit(env, `mailbox:admin:write:${adminId}`, 60, 60, "操作过于频繁，请稍后再试")
}

/** 查一个邮箱（含归属用户），不存在则 404 */
async function loadMailbox(
  env: Env,
  id: string
): Promise<{ row: MailboxRow; owner: OwnerRow }> {
  const row = await env.DB.prepare("SELECT * FROM mailboxes WHERE id = ?")
    .bind(id)
    .first<MailboxRow>()
  if (!row) throw new ApiError(404, "邮箱不存在", "NOT_FOUND")
  const owner = await env.DB.prepare("SELECT id, username, email, status FROM users WHERE id = ?")
    .bind(row.user_id)
    .first<OwnerRow>()
  if (!owner) throw new ApiError(404, "邮箱归属用户不存在", "USER_NOT_FOUND")
  return { row, owner }
}

/** 单条视图（统计/已验证集合单独查） */
async function viewOne(env: Env, row: MailboxRow, owner: OwnerRow): Promise<AdminMailboxView> {
  const stats = await env.DB.prepare(
    "SELECT COUNT(*) AS total, COALESCE(SUM(read = 0), 0) AS unread FROM messages WHERE mailbox_id = ?"
  )
    .bind(row.id)
    .first<{ total: number; unread: number }>()
  const [verified, primary] = await Promise.all([
    loadVerifiedTargets(env, owner.id),
    primaryAddressFor(env, owner.id, owner.username),
  ])
  return toView(
    row,
    owner,
    { total: Number(stats?.total ?? 0), unread: Number(stats?.unread ?? 0) },
    verified,
    primary
  )
}

// POST /api/admin/mailboxes —— 代替指定用户创建邮箱
// body: { userId?|username?, localPart, domain? }
export async function createAdminMailbox(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "dns")
  await guardWrite(env, admin.id)

  const body = (await request.json()) as {
    userId?: string
    username?: string
    localPart?: string
    domain?: string
  }
  const owner = await resolveOwner(env, body.userId, body.username)

  const localPart = (body.localPart ?? "").trim().toLowerCase()
  if (!LOCAL_PART_RE.test(localPart)) {
    throw new ApiError(400, "邮箱前缀只能包含小写字母、数字和 . _ -", "INVALID_ALIAS")
  }
  // 防止冒充平台（admin@ / postmaster@ / noreply@）：代建也一样不能碰
  if (isReservedName(localPart)) {
    throw new ApiError(400, "该邮箱前缀为系统保留名称", "RESERVED_NAME")
  }

  // 代建不按**目标用户**的权限域过滤（他可能没解锁 doulor 权限，但站长要给他建），
  // 所以传 allPermissions()；根域仍必须已登记且已启用。与子域名代建同一取舍。
  const root = await pickRootDomain(env, body.domain, allPermissions())
  const address = `${localPart}@${root.name}`

  const exists = await env.DB.prepare(
    "SELECT id FROM mailboxes WHERE address = ? COLLATE NOCASE LIMIT 1"
  )
    .bind(address)
    .first()
  if (exists) throw new ApiError(409, "该邮箱已被使用", "CONFLICT")

  // ⚠️ 刻意**不**校验用户的 3 个名额：这是站长的补救工具（用户名额满了也要能建）。
  // 与子域名代建一致 —— 配额是给用户自助行为设的闸，不是给站长设的。
  const id = uuid()
  const now = new Date().toISOString()
  await env.DB.prepare(
    "INSERT INTO mailboxes (id, user_id, address, forwarding_to, source, created_at) VALUES (?, ?, ?, NULL, 'admin', ?)"
  )
    .bind(id, owner.id, address, now)
    .run()

  await recordAudit(
    env,
    owner.id,
    "mailbox.admin.create",
    `管理员 ${admin.username} 给 ${owner.username} 创建邮箱 ${address}`,
    request.headers.get("CF-Connecting-IP")
  )

  const row = await env.DB.prepare("SELECT * FROM mailboxes WHERE id = ?").bind(id).first<MailboxRow>()
  return json({ mailbox: await viewOne(env, row!, owner) }, 201)
}

// PUT /api/admin/mailboxes/:id —— 改名（localPart / 域）与转发目标
// body: { localPart?, domain?, forwardingTo? }
export async function updateAdminMailbox(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireAdminScope(env, request, "dns")
  await guardWrite(env, admin.id)

  const { row } = await loadMailbox(env, id)
  const body = (await request.json()) as {
    localPart?: string
    domain?: string
    forwardingTo?: string[] | null
  }

  let nextAddress = row.address
  // ---- 改名 / 换域 ----
  if (body.localPart !== undefined || body.domain !== undefined) {
    const currentLocal = row.address.slice(0, row.address.lastIndexOf("@"))
    const currentDomain = row.address.slice(row.address.lastIndexOf("@") + 1)
    const localPart = (body.localPart ?? currentLocal).trim().toLowerCase()
    if (!LOCAL_PART_RE.test(localPart)) {
      throw new ApiError(400, "邮箱前缀只能包含小写字母、数字和 . _ -", "INVALID_ALIAS")
    }
    if (isReservedName(localPart)) {
      throw new ApiError(400, "该邮箱前缀为系统保留名称", "RESERVED_NAME")
    }
    const root = await pickRootDomain(env, body.domain ?? currentDomain, allPermissions())
    nextAddress = `${localPart}@${root.name}`

    if (nextAddress.toLowerCase() !== row.address.toLowerCase()) {
      const clash = await env.DB.prepare(
        "SELECT id FROM mailboxes WHERE address = ? COLLATE NOCASE AND id != ? LIMIT 1"
      )
        .bind(nextAddress, row.id)
        .first()
      if (clash) throw new ApiError(409, "该邮箱已被使用", "CONFLICT")

      // 历史遗留的 Cloudflare 路由规则是按**旧地址**建的：改名后旧地址已不存在，
      // 规则留着只会白占「每域 200 条」的硬配额，顺手摘掉（失败不阻断改名本身）。
      if (row.rule_id) {
        try {
          await cfDeleteEmailRule(env, env.ZONE_ID, row.rule_id)
        } catch (err) {
          console.error("改名时清理 Email Routing 规则失败:", row.address, err)
        }
      }
      await env.DB.prepare("UPDATE mailboxes SET address = ?, rule_id = NULL WHERE id = ?")
        .bind(nextAddress, row.id)
        .run()
    }
  }

  // ---- 转发目标（管理端免「已验证」检查，见文件头第 2 条）----
  if (body.forwardingTo !== undefined) {
    const targets = await validateAdminForwarding(env, body.forwardingTo ?? [])
    await env.DB.prepare("UPDATE mailboxes SET forwarding_to = ? WHERE id = ?")
      .bind(targets.length > 0 ? JSON.stringify(targets) : null, row.id)
      .run()
  }

  const next = await loadMailbox(env, id)

  const actions: string[] = []
  if (nextAddress.toLowerCase() !== row.address.toLowerCase()) {
    actions.push(`地址 ${row.address} → ${nextAddress}`)
  }
  if (body.forwardingTo !== undefined) {
    const targets = parseForwarding(next.row.forwarding_to)
    actions.push(targets.length > 0 ? `转发目标设为 ${targets.join("、")}（免验证）` : "清空转发目标")
  }
  if (actions.length > 0) {
    await recordAudit(
      env,
      next.row.user_id,
      "mailbox.admin.update",
      `管理员 ${admin.username} 修改邮箱 ${row.address}：${actions.join("；")}`,
      request.headers.get("CF-Connecting-IP")
    )
  }

  return json({ mailbox: await viewOne(env, next.row, next.owner) })
}

// DELETE /api/admin/mailboxes/:id —— 删除邮箱（含主邮箱；清理走与用户侧同一条路径）
export async function deleteAdminMailbox(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireAdminScope(env, request, "dns")
  await guardWrite(env, admin.id)

  const { row, owner } = await loadMailbox(env, id)

  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM messages WHERE mailbox_id = ?"
  )
    .bind(row.id)
    .first<{ c: number }>()

  // 与用户侧完全相同的清理：先摘 CF 规则再删行（messages 靠 ON DELETE CASCADE 清）
  await purgeMailbox(env, row)

  await recordAudit(
    env,
    owner.id,
    "mailbox.admin.delete",
    `管理员 ${admin.username} 删除 ${owner.username} 的邮箱 ${row.address}` +
      `（含 ${Number(count?.c ?? 0)} 封邮件${row.is_temp === 1 ? "，临时邮箱" : ""}）`,
    request.headers.get("CF-Connecting-IP")
  )

  return json({ ok: true, address: row.address })
}

/**
 * GET /api/admin/mailboxes/:id/messages?cursor=&limit= —— 邮件列表（不含正文）。
 *
 * ⚠️ 只读，不标已读（见文件头）。翻页用与用户侧同一套 (received_at, id) 复合游标 ——
 * 邮件常常同一次投递批量到达，时间戳完全相同，只按时间翻页会整批跳过。
 */
export async function listAdminMailboxMessages(
  env: Env,
  request: Request,
  mailboxId: string
): Promise<Response> {
  await requireAdminScope(env, request, "dns")
  const { row, owner } = await loadMailbox(env, mailboxId)

  const url = new URL(request.url)
  const rawLimit = Number(url.searchParams.get("limit") ?? 100)
  const limit = Math.min(
    Math.max(Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 100, 1),
    MAX_PAGE_SIZE
  )
  const cursor = url.searchParams.get("cursor")

  let where = "mailbox_id = ?"
  const binds: unknown[] = [row.id]
  if (cursor) {
    const c = decodeCursor(cursor)
    if (c) {
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
  const nextCursor =
    messages.length === limit && last ? encodeCursor(last.received_at, last.id) : null

  return json({
    mailbox: { id: row.id, address: row.address, ownerUsername: owner.username },
    messages: messages.map((m) => ({
      id: m.id,
      fromAddress: m.from_address,
      subject: m.subject,
      read: m.read === 1,
      receivedAt: m.received_at,
    })),
    nextCursor,
  })
}

/**
 * GET /api/admin/mailboxes/:id/messages/:messageId —— 单封邮件（含正文）。
 *
 * ⚠️ 管理端读信**不改用户的已读状态**（用户侧这条会自动标已读并累加成就计数）。
 * 读正文属于触碰用户隐私，记一条审计。
 */
export async function getAdminMailboxMessage(
  env: Env,
  request: Request,
  mailboxId: string,
  messageId: string
): Promise<Response> {
  const admin = await requireAdminScope(env, request, "dns")
  const { row, owner } = await loadMailbox(env, mailboxId)

  const message = await env.DB.prepare("SELECT * FROM messages WHERE id = ? AND mailbox_id = ?")
    .bind(messageId, row.id)
    .first<MessageRow>()
  if (!message) throw new ApiError(404, "邮件不存在", "NOT_FOUND")

  await recordAudit(
    env,
    owner.id,
    "mailbox.admin.read",
    `管理员 ${admin.username} 查看 ${row.address} 的邮件「${message.subject.slice(0, 60)}」`,
    request.headers.get("CF-Connecting-IP")
  )

  return json({
    mailbox: { id: row.id, address: row.address, ownerUsername: owner.username },
    message: {
      id: message.id,
      fromAddress: message.from_address,
      subject: message.subject,
      textBody: message.text_body,
      read: message.read === 1,
      receivedAt: message.received_at,
    },
  })
}
