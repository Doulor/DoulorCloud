import { ApiError, json } from "../http"
import { uuid } from "../crypto"
import { requireUser } from "../auth"
import type { Env } from "../env"
import {
  SETTING_DEFAULTS,
  getSettings,
  updateSettings,
  audit as recordAudit,
} from "../settings"
import { isR2Configured } from "../r2"
import { isNewApiConfigured, getCurrencyInfo } from "../newapi-client"
import { purgeUserStorage, recalculateUsage } from "./storage"

/**
 * 管理员接口。
 * 所有端点先检查 role === 'admin'（成员），
 * 操作用户对象时以 username 定位（绝不接受被操作用户的 session）。
 */

interface AdminUserRow {
  id: string
  username: string
  email: string
  password_hash: string
  namespace: string
  role: string
  status: string
  created_at: string
  updated_at: string
}

async function requireAdmin(env: Env, request: Request): Promise<AdminUserRow> {
  const admin = (await requireUser(env, request)) as AdminUserRow
  if (admin.role !== "admin") {
    throw new ApiError(403, "需要管理员权限", "FORBIDDEN")
  }
  return admin
}

async function targetUser(env: Env, username: string): Promise<AdminUserRow> {
  const user = await env.DB.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE")
    .bind(username)
    .first<AdminUserRow>()
  if (!user) {
    throw new ApiError(404, "用户不存在", "NOT_FOUND")
  }
  return user
}

async function userDetail(env: Env, user: AdminUserRow) {
  const subdomains = await env.DB.prepare(
    "SELECT id, name, fqdn, status, created_at FROM subdomains WHERE user_id = ? ORDER BY created_at ASC"
  )
    .bind(user.id)
    .all()

  const dnsIds = new Set<string>()
  const domainRows = await env.DB.prepare("SELECT id FROM domains WHERE user_id = ?")
    .bind(user.id)
    .all<{ id: string }>()
  for (const d of domainRows.results ?? []) dnsIds.add(d.id)

  const dns = await env.DB.prepare(
    "SELECT id, subdomain_id, name, fqdn, type, content, ttl, proxied, status, created_at FROM dns_records WHERE domain_id IN (SELECT id FROM domains WHERE user_id = ?) ORDER BY created_at ASC LIMIT 200"
  )
    .bind(user.id)
    .all()

  const mailboxes = await env.DB.prepare(
    "SELECT id, address, forwarding_to, created_at FROM mailboxes WHERE user_id = ? ORDER BY created_at ASC"
  )
    .bind(user.id)
    .all()

  const mails = await env.DB.prepare(
    "SELECT m.id, m.mailbox_id, m.from_address, m.subject, m.read, m.received_at FROM messages m JOIN mailboxes mb ON m.mailbox_id = mb.id WHERE mb.user_id = ? ORDER BY m.received_at DESC LIMIT 200"
  )
    .bind(user.id)
    .all()

  const sessions = await env.DB.prepare(
    "SELECT id, expires_at, created_at FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20"
  )
    .bind(user.id)
    .all()

  return {
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      namespace: user.namespace,
      role: user.role,
      status: user.status,
      createdAt: user.created_at,
      updatedAt: user.updated_at,
    },
    subdomains: subdomains.results ?? [],
    dns: dns.results ?? [],
    mailboxes: (mailboxes.results ?? []).map((m: Record<string, unknown>) => ({
      ...m,
      forwarding_to: m.forwarding_to ?? null,
    })),
    messages: mails.results ?? [],
    sessions: sessions.results ?? [],
  }
}

// GET /api/admin/users —— 用户列表
export async function listUsers(env: Env, request: Request): Promise<Response> {
  await requireAdmin(env, request)
  const rows = await env.DB.prepare(
    `SELECT u.id, u.username, u.email, u.namespace, u.role, u.status, u.created_at,
            (SELECT COUNT(*) FROM subdomains s WHERE s.user_id = u.id) AS subdomain_count,
            (SELECT COUNT(*) FROM dns_records d JOIN domains dm ON d.domain_id = dm.id WHERE dm.user_id = u.id) AS dns_count,
            (SELECT COUNT(*) FROM mailboxes mb WHERE mb.user_id = u.id) AS mailbox_count,
            (SELECT COUNT(*) FROM messages m JOIN mailboxes mb2 ON m.mailbox_id = mb2.id WHERE mb2.user_id = u.id) AS mail_count
       FROM users u
      ORDER BY u.created_at DESC`
  ).all()

  return json({
    users: (rows.results ?? []).map((r: Record<string, unknown>) => ({
      id: r.id,
      username: r.username,
      email: r.email,
      namespace: r.namespace,
      role: r.role,
      status: r.status,
      createdAt: r.created_at,
      subdomainCount: r.subdomain_count,
      dnsCount: r.dns_count,
      mailboxCount: r.mailbox_count,
      mailCount: r.mail_count,
    })),
  })
}

// GET /api/admin/users/:username —— 用户详情（子域名/DNS/邮箱/邮件/会话）
export async function getUser(env: Env, request: Request, username: string): Promise<Response> {
  await requireAdmin(env, request)
  const user = await targetUser(env, username)
  return json(await userDetail(env, user))
}

// PUT /api/admin/users/:username —— 更新用户状态（封禁/解封/设管理员）
export async function updateUser(env: Env, request: Request, username: string): Promise<Response> {
  await requireAdmin(env, request)
  const body = (await request.json()) as { status?: string; role?: string }

  const user = await targetUser(env, username)
  if (body.status && !["active", "suspended"].includes(body.status)) {
    throw new ApiError(400, "无效的状态", "INVALID_INPUT")
  }
  if (body.role && !["user", "admin"].includes(body.role)) {
    throw new ApiError(400, "无效的角色", "INVALID_INPUT")
  }
  if (user.username.toLowerCase() === "doulor") {
    throw new ApiError(400, "不可修改主管理员", "FORBIDDEN")
  }

  await env.DB.prepare(
    "UPDATE users SET status = COALESCE(?, status), role = COALESCE(?, role), updated_at = ? WHERE id = ?"
  )
    .bind(body.status ?? null, body.role ?? null, new Date().toISOString(), user.id)
    .run()

  const updated = await targetUser(env, username)
  return json(await userDetail(env, updated))
}

// DELETE /api/admin/users/:username —— 删除用户（级联）
export async function deleteUser(env: Env, request: Request, username: string): Promise<Response> {
  await requireAdmin(env, request)
  const user = await targetUser(env, username)
  if (user.username.toLowerCase() === "doulor") {
    throw new ApiError(400, "不可删除主管理员", "FORBIDDEN")
  }

  await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id).run()
  return new Response(null, { status: 204 })
}

// GET /api/admin/users/:username/messages/:messageId —— 查看用户某封邮件全文
export async function getUserMessage(
  env: Env,
  request: Request,
  username: string,
  messageId: string
): Promise<Response> {
  await requireAdmin(env, request)
  const user = await targetUser(env, username)

  const row = await env.DB.prepare(
    `SELECT m.* FROM messages m
       JOIN mailboxes mb ON m.mailbox_id = mb.id
      WHERE mb.user_id = ? AND m.id = ?`
  )
    .bind(user.id, messageId)
    .first<{
      id: string
      from_address: string
      subject: string
      text_body: string
      read: number
      received_at: string
    }>()

  if (!row) {
    throw new ApiError(404, "邮件不存在", "NOT_FOUND")
  }

  return json({
    message: {
      id: row.id,
      from: row.from_address,
      subject: row.subject,
      body: row.text_body,
      read: row.read === 1,
      receivedAt: row.received_at,
    },
  })
}

// ---- 邀请码管理 ----

interface InviteRow {
  id: string
  code: string
  created_by: string | null
  max_uses: number
  used_count: number
  expires_at: string | null
  created_at: string
}

function toPublicInvite(row: InviteRow) {
  return {
    id: row.id,
    code: row.code,
    maxUses: row.max_uses,
    usedCount: row.used_count,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    createdBy: row.created_by ?? null,
  }
}

// GET /api/admin/invites —— 邀请码列表
export async function listInvites(env: Env, request: Request): Promise<Response> {
  await requireAdmin(env, request)
  const rows = await env.DB.prepare(
    "SELECT * FROM invite_codes ORDER BY created_at DESC"
  ).all<InviteRow>()

  return json({ invites: (rows.results ?? []).map(toPublicInvite) })
}

// POST /api/admin/invites —— 创建邀请码
export async function createInvite(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdmin(env, request)
  const body = (await request.json()) as { code?: string; maxUses?: number }

  const code = (body.code ?? "").trim().toUpperCase()
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) {
    throw new ApiError(400, "邀请码只能包含大写字母、数字、- 和 _（3-32 位）", "INVALID_CODE")
  }
  const maxUses = Math.min(Math.max(Math.trunc(body.maxUses ?? 1), 1), 1000)

  const exists = await env.DB.prepare(
    "SELECT id FROM invite_codes WHERE code = ? COLLATE NOCASE LIMIT 1"
  )
    .bind(code)
    .first()
  if (exists) {
    throw new ApiError(409, "该邀请码已存在", "CONFLICT")
  }

  const id = uuid()
  await env.DB.prepare(
    "INSERT INTO invite_codes (id, code, created_by, max_uses, used_count, created_at) VALUES (?, ?, ?, ?, 0, ?)"
  )
    .bind(id, code, admin.id, maxUses, new Date().toISOString())
    .run()

  const row = await env.DB.prepare("SELECT * FROM invite_codes WHERE id = ?")
    .bind(id)
    .first<InviteRow>()

  return json({ invite: toPublicInvite(row!) }, 201)
}

// DELETE /api/admin/invites/:id —— 删除邀请码
export async function deleteInvite(env: Env, request: Request, id: string): Promise<Response> {
  await requireAdmin(env, request)
  const existing = await env.DB.prepare("SELECT id FROM invite_codes WHERE id = ?")
    .bind(id)
    .first()
  if (!existing) {
    throw new ApiError(404, "邀请码不存在", "NOT_FOUND")
  }

  await env.DB.prepare("DELETE FROM invite_codes WHERE id = ?").bind(id).run()
  return new Response(null, { status: 204 })
}

// ---- 全局设置（网盘配额 / AI 试用额度等）----

// GET /api/admin/settings —— 读取全部可配置项
export async function getSettingsHandler(env: Env, request: Request): Promise<Response> {
  await requireAdmin(env, request)
  const settings = await getSettings(env)

  const infos = await Promise.all([
    env.DB.prepare(
      "SELECT COUNT(*) AS c, COALESCE(SUM(used_bytes),0) AS used, COALESCE(SUM(quota_bytes),0) AS quota FROM storage_accounts"
    ).first<{ c: number; used: number; quota: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS c FROM storage_objects").first<{ c: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS c FROM newapi_accounts").first<{ c: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS c FROM newapi_keys").first<{ c: number }>(),
  ])

  // 试用额度的币种跟随 NewAPI 站点设置，管理面板标签需与之一致
  const currency = isNewApiConfigured(env)
    ? await getCurrencyInfo(env)
    : { symbol: "$", code: "USD", perUnit: Number(settings.newapi_quota_per_unit) }

  return json({
    settings,
    currency: { symbol: currency.symbol, code: currency.code },
    stats: {
      storageAccounts: infos[0]?.c ?? 0,
      storageUsedBytes: infos[0]?.used ?? 0,
      storageQuotaBytes: infos[0]?.quota ?? 0,
      storageObjects: infos[1]?.c ?? 0,
      newapiAccounts: infos[2]?.c ?? 0,
      newapiKeys: infos[3]?.c ?? 0,
    },
  })
}

// PUT /api/admin/settings —— 更新设置（仅接受白名单内的 key）
export async function updateSettingsHandler(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdmin(env, request)
  const body = (await request.json()) as Record<string, unknown>

  const values: Record<string, string> = {}
  for (const [key, raw] of Object.entries(body)) {
    if (!(key in SETTING_DEFAULTS)) continue
    if (raw === null || raw === undefined) continue

    if (typeof raw === "boolean") {
      values[key] = raw ? "1" : "0"
      continue
    }

    const str = String(raw).trim()
    if (str === "") continue

    // 数值型设置必须是非负整数，避免写入脏数据
    if (/bytes|quota|count/i.test(key)) {
      const n = Number(str)
      if (!Number.isFinite(n) || n < 0) {
        throw new ApiError(400, `设置项 ${key} 需要非负数值`, "INVALID_INPUT")
      }
      values[key] = String(Math.trunc(n))
      continue
    }

    values[key] = str.slice(0, 100)
  }

  if (Object.keys(values).length === 0) {
    throw new ApiError(400, "没有可更新的设置项", "INVALID_INPUT")
  }

  await updateSettings(env, values)
  await recordAudit(
    env,
    admin.id,
    "admin.settings.update",
    Object.entries(values)
      .map(([k, v]) => `${k}=${v}`)
      .join(", "),
    request.headers.get("CF-Connecting-IP")
  )

  return json({ settings: await getSettings(env) })
}

// POST /api/admin/storage/recalculate —— 以 R2 实际内容重算所有用户用量
export async function recalculateStorage(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdmin(env, request)
  if (!isR2Configured(env)) {
    throw new ApiError(503, "网盘存储未配置", "R2_NOT_CONFIGURED")
  }

  const rows = await env.DB.prepare("SELECT * FROM storage_accounts")
    .bind()
    .all<{
      user_id: string
      prefix: string
      quota_bytes: number
      used_bytes: number
      file_count: number
      enabled: number
      created_at: string
      updated_at: string
    }>()

  let total = 0
  for (const account of rows.results ?? []) {
    const result = await recalculateUsage(env, account)
    total += result.usedBytes
  }

  await recordAudit(
    env,
    admin.id,
    "admin.storage.recalculate",
    `重算 ${rows.results?.length ?? 0} 个网盘账户，合计 ${total} 字节`,
    request.headers.get("CF-Connecting-IP")
  )

  return json({ accounts: rows.results?.length ?? 0, totalBytes: total })
}

// POST /api/admin/storage/purge/:username —— 清空某用户网盘文件
export async function purgeStorage(env: Env, request: Request, username: string): Promise<Response> {
  const admin = await requireAdmin(env, request)
  const user = await targetUser(env, username)

  const deleted = await purgeUserStorage(env, user.id)
  await recordAudit(
    env,
    admin.id,
    "admin.storage.purge",
    `清空 ${username} 的网盘（删除 ${deleted} 个对象）`,
    request.headers.get("CF-Connecting-IP")
  )

  return json({ deleted })
}