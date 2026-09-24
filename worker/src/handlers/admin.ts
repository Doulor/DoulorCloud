import { ApiError, json } from "../http"
import { uuid } from "../crypto"
import { requireUser } from "../auth"
import type { Env } from "../env"
import {
  SETTING_DEFAULTS,
  getSettings,
  getSetting,
  updateSettings,
  sanitizeRecommendedModels,
  audit as recordAudit,
} from "../settings"
import { isStorageConfigured } from "../r2"
import {
  isNewApiConfigured,
  getCurrencyInfo,
  findUserByUsername,
  getAdminCredentialInfo,
  saveAdminCredential,
  verifyAdminCredential,
  probeAdminCredential,
  listPricing,
  maskToken,
} from "../newapi-client"
import { sendMail, renderMail } from "../mailer"
import { cfListDestinations } from "../cloudflare"
import { normalizePermissions, parsePermissions, FEATURES } from "../permissions"
import {
  validateNicknameFormat,
  isReservedNickname,
  parseReservedNicknames,
} from "../identity"
import { listReservedSubdomains } from "../reserved-names"
import { getSettingNumber } from "../settings"
import {
  QUOTA_FEATURES,
  QUOTA_FEATURE_LABELS,
  parseBasicFeatures,
  parseCounts,
  refundQuotaForInvite,
  quotaFeaturesOf,
} from "../quotas"
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
  permissions: string | null
  /** 用户级子域名配额覆盖；NULL = 用全局默认 */
  max_subdomains?: number | null
  /** 展示用昵称（社区/名片），NULL = 未设置 */
  nickname?: string | null
  /** 邮箱是否已验证（验证后才能在设置里改真实收件地址等） */
  email_verified?: number | null
  /** 是否接收平台通知邮件 */
  notify_enabled?: number | null
  /** 头像 R2 key（NULL = 未上传，前端回落到 /u/<username>/avatar） */
  avatar_key?: string | null
  /** 邀请码额度（捐献累计获得 / 已消耗） */
  invite_quota_bonus?: number | null
  invite_quota_used?: number | null
  /** 模块转授额度与消耗（JSON） */
  feature_quota?: string | null
  feature_quota_used?: string | null
  created_at: string
  updated_at: string
}

export async function requireAdmin(env: Env, request: Request): Promise<AdminUserRow> {
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

/**
 * 用户详情。
 *
 * 列表页只看「各模块是否开通」，明细全部收敛到这里：
 *   * 账号：昵称/邮箱验证/通知开关/头像，以及角色与状态
 *   * 模块：网盘（用量配额桶）、AI 中转站（额度与请求数）、
 *           内网穿透（启用状态 + 申请/端口）、代理节点（启用与协议同意）
 *   * 名片：published / slug / 自定义域名 / 访问次数
 *   * 额度：邀请码额度 + 各模块转授额度
 *   * 活动：最近 20 条审计日志
 *
 * 注意：AI 中转站的 quota / used_quota 取 D1 里的同步快照（由 maintenance 定期
 * 拉取），不在这里实时打 NewAPI 接口 —— 管理面板打开详情不应产生外部请求。
 */
async function userDetail(env: Env, user: AdminUserRow) {
  const subdomains = await env.DB.prepare(
    "SELECT id, name, fqdn, status, created_at FROM subdomains WHERE user_id = ? ORDER BY created_at ASC"
  )
    .bind(user.id)
    .all()

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

  // ---- 各模块明细 ----
  const storage = await env.DB.prepare(
    `SELECT sa.prefix, sa.quota_bytes, sa.used_bytes, sa.file_count, sa.enabled,
            sa.bucket_id, sa.created_at, b.name AS bucket_name
       FROM storage_accounts sa
       LEFT JOIN r2_buckets b ON b.id = sa.bucket_id
      WHERE sa.user_id = ?`
  )
    .bind(user.id)
    .first<{
      prefix: string
      quota_bytes: number
      used_bytes: number
      file_count: number
      enabled: number
      bucket_id: string | null
      bucket_name: string | null
      created_at: string
    }>()

  const newapi = await env.DB.prepare(
    `SELECT newapi_user_id, username, email, group_name, quota, used_quota,
            request_count, synced_at, created_at
       FROM newapi_accounts WHERE user_id = ?`
  )
    .bind(user.id)
    .first<{
      newapi_user_id: number
      username: string
      email: string
      group_name: string | null
      quota: number
      used_quota: number
      request_count: number
      synced_at: string | null
      created_at: string
    }>()

  const frp = await env.DB.prepare(
    "SELECT enabled, created_at, updated_at FROM frp_accounts WHERE user_id = ?"
  )
    .bind(user.id)
    .first<{ enabled: number; created_at: string; updated_at: string }>()

  const frpApplications = await env.DB.prepare(
    `SELECT id, status, frp_user, ports, notify_email, remark, review_note,
            reviewed_at, created_at
       FROM frp_applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`
  )
    .bind(user.id)
    .all<{
      id: string
      status: string
      frp_user: string
      ports: string
      notify_email: string
      remark: string | null
      review_note: string | null
      reviewed_at: string | null
      created_at: string
    }>()

  const frpPorts = await env.DB.prepare(
    `SELECT p.remote_port, p.created_at, n.name AS node_name
       FROM frp_ports p
       LEFT JOIN frp_nodes n ON n.id = p.node_id
      WHERE p.user_id = ? ORDER BY p.remote_port ASC`
  )
    .bind(user.id)
    .all<{ remote_port: number; created_at: string; node_name: string | null }>()

  const proxy = await env.DB.prepare(
    "SELECT enabled, consent_version, consented_at, created_at, updated_at FROM proxy_activation WHERE user_id = ?"
  )
    .bind(user.id)
    .first<{
      enabled: number
      consent_version: number
      consented_at: string | null
      created_at: string
      updated_at: string
    }>()

  const profile = await env.DB.prepare(
    `SELECT slug, published, fqdn, view_count, display_name, created_at, updated_at
       FROM profiles WHERE user_id = ?`
  )
    .bind(user.id)
    .first<{
      slug: string
      published: number
      fqdn: string | null
      view_count: number
      display_name: string | null
      created_at: string
      updated_at: string
    }>()

  // ---- 额度 ----
  const inviteBase = await getSettingNumber(env, "invite_quota_base")
  const inviteBonus = Math.max(0, user.invite_quota_bonus ?? 0)
  const inviteUsed = Math.max(0, user.invite_quota_used ?? 0)
  const featureQuota = parseCounts(user.feature_quota)
  const featureUsed = parseCounts(user.feature_quota_used)
  const featureRemaining: Record<string, number> = {}
  for (const f of QUOTA_FEATURES) {
    featureRemaining[f] = Math.max(0, featureQuota[f] - featureUsed[f])
  }

  // ---- 最近活动 ----
  const activity = await env.DB.prepare(
    "SELECT id, action, detail, created_at FROM audit_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 20"
  )
    .bind(user.id)
    .all<{ id: string; action: string; detail: string | null; created_at: string }>()

  return {
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      namespace: user.namespace,
      nickname: user.nickname ?? null,
      role: user.role,
      status: user.status,
      emailVerified: (user.email_verified ?? 0) === 1,
      notifyEnabled: (user.notify_enabled ?? 1) === 1,
      hasAvatar: Boolean(user.avatar_key),
      permissions: parsePermissions(user.permissions),
      maxSubdomains: user.max_subdomains ?? null,
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
    storage: storage
      ? {
          prefix: storage.prefix,
          quotaBytes: storage.quota_bytes,
          usedBytes: storage.used_bytes,
          fileCount: storage.file_count,
          enabled: storage.enabled === 1,
          bucketId: storage.bucket_id,
          bucketName: storage.bucket_name,
          createdAt: storage.created_at,
        }
      : null,
    newapi: newapi
      ? {
          newapiUserId: newapi.newapi_user_id,
          username: newapi.username,
          email: newapi.email,
          group: newapi.group_name,
          quota: newapi.quota,
          usedQuota: newapi.used_quota,
          requestCount: newapi.request_count,
          syncedAt: newapi.synced_at,
          createdAt: newapi.created_at,
        }
      : null,
    frp: frp
      ? {
          enabled: frp.enabled === 1,
          createdAt: frp.created_at,
          updatedAt: frp.updated_at,
        }
      : null,
    frpApplications: (frpApplications.results ?? []).map((a) => ({
      id: a.id,
      status: a.status,
      frpUser: a.frp_user,
      ports: parseJsonArray(a.ports),
      notifyEmail: a.notify_email,
      remark: a.remark,
      reviewNote: a.review_note,
      reviewedAt: a.reviewed_at,
      createdAt: a.created_at,
    })),
    frpPorts: (frpPorts.results ?? []).map((p) => ({
      remotePort: p.remote_port,
      nodeName: p.node_name,
      createdAt: p.created_at,
    })),
    proxy: proxy
      ? {
          enabled: proxy.enabled === 1,
          consentVersion: proxy.consent_version,
          consentedAt: proxy.consented_at,
          createdAt: proxy.created_at,
          updatedAt: proxy.updated_at,
        }
      : null,
    profile: profile
      ? {
          slug: profile.slug,
          published: profile.published === 1,
          fqdn: profile.fqdn,
          viewCount: profile.view_count,
          displayName: profile.display_name,
          createdAt: profile.created_at,
          updatedAt: profile.updated_at,
        }
      : null,
    quota: {
      inviteBase,
      inviteBonus,
      inviteTotal: inviteBase + inviteBonus,
      inviteUsed,
      inviteRemaining: Math.max(0, inviteBase + inviteBonus - inviteUsed),
      featureQuota,
      featureUsed,
      featureRemaining,
      featureLabels: QUOTA_FEATURE_LABELS,
    },
    activity: (activity.results ?? []).map((a) => ({
      id: a.id,
      action: a.action,
      detail: a.detail ?? "",
      createdAt: a.created_at,
    })),
  }
}

/** 解析 JSON 数组字段（如 frp_applications.ports）；损坏数据回退为空数组 */
function parseJsonArray(raw: string | null): number[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "number") : []
  } catch {
    return []
  }
}

// GET /api/admin/users —— 用户列表
export async function listUsers(env: Env, request: Request): Promise<Response> {
  await requireAdmin(env, request)
  const rows = await env.DB.prepare(
    // 列表只展示「各模块是否已开通」与「名片是否已启用」，不再回传子域名/DNS/
    // 邮箱/邮件的计数 —— 那些明细在用户详情里看。四个模块的判定与各 handler
    // 里的 isActivated / loadAccount 完全一致（有记录 **且** enabled=1）。
    `SELECT u.id, u.username, u.email, u.namespace, u.role, u.status, u.permissions, u.max_subdomains, u.created_at,
            u.invite_code_id,
            ic.code AS invite_code,
            ic.created_at AS invite_created_at,
            creator.username AS invite_created_by,
            EXISTS(SELECT 1 FROM storage_accounts sa WHERE sa.user_id = u.id AND sa.enabled = 1) AS storage_on,
            EXISTS(SELECT 1 FROM newapi_accounts na WHERE na.user_id = u.id) AS ai_on,
            EXISTS(SELECT 1 FROM frp_accounts fa WHERE fa.user_id = u.id AND fa.enabled = 1) AS frp_on,
            EXISTS(SELECT 1 FROM proxy_activation pa WHERE pa.user_id = u.id AND pa.enabled = 1) AS proxy_on,
            p.published AS profile_published,
            p.slug AS profile_slug,
            p.fqdn AS profile_fqdn
       FROM users u
       LEFT JOIN invite_codes ic ON ic.id = u.invite_code_id
       LEFT JOIN users creator ON creator.id = ic.created_by
       LEFT JOIN profiles p ON p.user_id = u.id
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
      permissions: parsePermissions(r.permissions as string | null),
      maxSubdomains: (r.max_subdomains as number | null) ?? null,
      createdAt: r.created_at,
      // 邀请码溯源：老用户没有 invite_code_id（或码已删除），回退为 null
      inviteCode: (r.invite_code as string | null) ?? null,
      inviteCreatedBy: (r.invite_created_by as string | null) ?? null,
      inviteCreatedAt: (r.invite_created_at as string | null) ?? null,
      // 各模块的实际开通状态（有记录且 enabled=1）
      storageEnabled: Number(r.storage_on) === 1,
      aiEnabled: Number(r.ai_on) === 1,
      frpEnabled: Number(r.frp_on) === 1,
      proxyEnabled: Number(r.proxy_on) === 1,
      // 个人名片：未建记录时 published 为 NULL → 视为未启用
      profileEnabled: Number(r.profile_published) === 1,
      profileSlug: (r.profile_slug as string | null) ?? null,
      profileFqdn: (r.profile_fqdn as string | null) ?? null,
    })),
  })
}

// GET /api/admin/users/:username —— 用户详情（子域名/DNS/邮箱/邮件/会话）
export async function getUser(env: Env, request: Request, username: string): Promise<Response> {
  await requireAdmin(env, request)
  const user = await targetUser(env, username)
  return json(await userDetail(env, user))
}

// PUT /api/admin/users/:username —— 更新用户状态（封禁/解封/设管理员/昵称等）
export async function updateUser(env: Env, request: Request, username: string): Promise<Response> {
  await requireAdmin(env, request)
  const body = (await request.json()) as {
    status?: string
    role?: string
    permissions?: unknown
    /** 该用户可创建的一级子域名数量；null 表示恢复为全局默认 */
    maxSubdomains?: number | null
    /** 展示昵称；null 或空串表示清空 */
    nickname?: string | null
    /** 邮箱是否已验证 */
    emailVerified?: boolean
    /** 是否接收平台通知邮件 */
    notifyEnabled?: boolean
  }

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

  // 权限：只有显式传入时才更新（null 保持原值）
  const perms =
    body.permissions === undefined || body.permissions === null
      ? null
      : JSON.stringify(normalizePermissions(body.permissions))

  // 子域名配额：undefined 保持原值；null 清除覆盖（回落到全局默认）
  let quotaUpdate = false
  let quotaValue: number | null = null
  if (body.maxSubdomains !== undefined) {
    quotaUpdate = true
    if (body.maxSubdomains === null) {
      quotaValue = null
    } else {
      const n = Math.trunc(Number(body.maxSubdomains))
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        throw new ApiError(400, "子域名配额需为 0-100 的整数", "INVALID_INPUT")
      }
      quotaValue = n
    }
  }

  await env.DB.prepare(
    "UPDATE users SET status = COALESCE(?, status), role = COALESCE(?, role), permissions = COALESCE(?, permissions), updated_at = ? WHERE id = ?"
  )
    .bind(
      body.status ?? null,
      body.role ?? null,
      perms,
      new Date().toISOString(),
      user.id
    )
    .run()

  if (quotaUpdate) {
    await env.DB.prepare("UPDATE users SET max_subdomains = ? WHERE id = ?")
      .bind(quotaValue, user.id)
      .run()
  }

  // 昵称：null/空串清空；非空则校验格式与占用（复用身份模块的规则，
  // 与用户自助改名保持一致 —— 管理员也不能绕过「doulor」这类平台保留词）
  if (body.nickname !== undefined) {
    const nick = (body.nickname ?? "").trim()
    if (nick === "") {
      await env.DB.prepare("UPDATE users SET nickname = NULL, updated_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), user.id)
        .run()
    } else {
      if (!validateNicknameFormat(nick)) {
        throw new ApiError(400, "昵称为 2-16 位中文/英文/数字/下划线", "INVALID_NICKNAME")
      }
      const extra = parseReservedNicknames(await getSetting(env, "reserved_nicknames"))
      if (isReservedNickname(nick, extra, user.role === "admin")) {
        throw new ApiError(400, "该昵称包含保留词，请换一个", "NICKNAME_RESERVED")
      }
      try {
        await env.DB.prepare("UPDATE users SET nickname = ?, updated_at = ? WHERE id = ?")
          .bind(nick, new Date().toISOString(), user.id)
          .run()
      } catch {
        throw new ApiError(409, "该昵称已被占用", "NICKNAME_TAKEN")
      }
    }
  }

  // 邮箱验证 / 通知开关：布尔字段，显式传入才改
  const flagSets: string[] = []
  const flagBinds: unknown[] = []
  if (body.emailVerified !== undefined) {
    flagSets.push("email_verified = ?")
    flagBinds.push(body.emailVerified ? 1 : 0)
  }
  if (body.notifyEnabled !== undefined) {
    flagSets.push("notify_enabled = ?")
    flagBinds.push(body.notifyEnabled ? 1 : 0)
  }
  if (flagSets.length > 0) {
    flagSets.push("updated_at = ?")
    flagBinds.push(new Date().toISOString(), user.id)
    await env.DB.prepare(`UPDATE users SET ${flagSets.join(", ")} WHERE id = ?`)
      .bind(...flagBinds)
      .run()
  }

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
  permissions: string | null
  created_at: string
}

function toPublicInvite(row: InviteRow) {
  return {
    id: row.id,
    code: row.code,
    maxUses: row.max_uses,
    usedCount: row.used_count,
    expiresAt: row.expires_at,
    permissions: parsePermissions(row.permissions),
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
  const body = (await request.json()) as {
    code?: string
    maxUses?: number
    permissions?: unknown
  }

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

  // 该码注册出的账号默认拥有哪些功能权限（未指定 = 全部允许）
  const permissions = normalizePermissions(body.permissions)

  const id = uuid()
  await env.DB.prepare(
    "INSERT INTO invite_codes (id, code, created_by, max_uses, used_count, permissions, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)"
  )
    .bind(
      id,
      code,
      admin.id,
      maxUses,
      JSON.stringify(permissions),
      new Date().toISOString()
    )
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

/**
 * POST /api/admin/mail-test —— 出站邮件自检。
 *
 * 区分两种发送能力（成本与前提不同）：
 *   - 「验证码 / 账号找回」：发给**已验证的目标地址**，Cloudflare **免费**且无需 Onboard
 *   - 「公告群发」：需要先 Onboard 发送域名（付费），否则只能发已验证地址
 */
export async function testMail(env: Env, request: Request): Promise<Response> {
  await requireAdmin(env, request)
  const body = (await request.json().catch(() => ({}))) as { to?: string }
  const to = (body.to ?? "").trim()
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    throw new ApiError(400, "请提供有效的收件邮箱", "INVALID_EMAIL")
  }

  const { text, html } = renderMail("Doulor Cloud 邮件自检", [
    "如果你收到这封邮件，说明 Worker 的出站邮件已配置成功。",
    "此功能用于：真实邮箱验证、账号找回、以及站内通知。",
  ])

  try {
    await sendMail(env, { to, subject: "Doulor Cloud 邮件自检", text, html })
  } catch (err) {
    if (err instanceof ApiError) {
      return json({ ok: false, code: err.code, error: err.message }, err.status)
    }
    throw err
  }

  return json({ ok: true, message: `已发送至 ${to}` })
}

/**
 * GET /api/admin/newapi-test —— 诊断 NewAPI 管理员令牌是否有效。
 * 调 /api/user/search（需 admin 权限），返回连通状态与具体错误，便于排查。
 */
export async function testNewApi(env: Env, request: Request): Promise<Response> {
  await requireAdmin(env, request)
  if (!(await isNewApiConfigured(env))) {
    return json({ ok: false, configured: false, error: "NewAPI 未配置（缺少 BASE_URL 或管理员令牌）" })
  }
  try {
    // 用 admin token 调一个最轻量的管理接口
    const user = await findUserByUsername(env, "doulor")
    return json({
      ok: true,
      configured: true,
      message: user ? `令牌有效，查询到账号 #${user.id}` : "令牌有效，查询接口正常（无匹配账号）",
    })
  } catch (err) {
    if (err instanceof ApiError) {
      return json({ ok: false, configured: true, code: err.code, error: err.message })
    }
    return json({ ok: false, configured: true, error: String(err) })
  }
}

/**
 * GET /api/admin/newapi/config —— 中转站管理员凭据现状。
 *
 * NewAPI 的「系统访问令牌」可在其后台被随时重新生成（每生成一次就覆盖旧值），
 * 旧令牌立即失效，本站所有管理员级调用随之 401。因此这里把「当前用的是哪份凭据、
 * 掩码、何时更新、是否还有效」一次性告诉管理面板，并允许在网页上直接换新。
 *
 * 只回掩码，明文绝不下发。
 */
export async function getNewApiAdminConfig(env: Env, request: Request): Promise<Response> {
  await requireAdmin(env, request)
  const info = await getAdminCredentialInfo(env)

  // 顺带做一次真实的连通性探测（管理面板打开即知令牌是否还有效，
  // 不必等用户去建 Key 才发现失效）。失败不影响本响应。
  const health = await probeAdminCredential(env)

  return json({
    baseUrl: env.NEWAPI_BASE_URL ?? null,
    source: info.source,
    maskedToken: info.maskedToken,
    adminUserId: info.adminUserId,
    updatedAt: info.updatedAt,
    configured: await isNewApiConfigured(env),
    health,
  })
}

/**
 * GET /api/admin/newapi/models —— 中转站当前的全部模型名（供推荐模型编辑器下拉选择）。
 *
 * 走公开的 /api/pricing，不需要管理员令牌；失败返回空数组而非报错 ——
 * 下拉是辅助功能，拿不到时管理员仍可手动输入模型名。
 */
export async function listNewApiModels(env: Env, request: Request): Promise<Response> {
  await requireAdmin(env, request)
  const pricing = await listPricing(env)
  const models = [...new Set(pricing.map((p) => p.model))].sort((a, b) =>
    a.localeCompare(b)
  )
  return json({ models })
}

/**
 * PUT /api/admin/newapi/config —— 更新中转站管理员凭据。
 *
 * body: { token?: string; adminUserId?: string }
 *
 * 先做一次真实的 ADMIN 级调用验证令牌，通过后才加密落库（避免把错令牌写进去，
 * 那样会把原本可用的环境变量凭据也一起顶掉）。验证失败直接 400 且不落库。
 */
export async function updateNewApiAdminConfig(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdmin(env, request)
  const body = (await request.json().catch(() => ({}))) as {
    token?: string
    adminUserId?: string
  }

  const token = (body.token ?? "").trim()
  if (!token) throw new ApiError(400, "请填写新的访问令牌", "INVALID_INPUT")
  if (token.length > 256) throw new ApiError(400, "令牌长度异常", "INVALID_INPUT")

  const adminUserId = (body.adminUserId ?? "").trim() || "1"
  if (!/^\d{1,10}$/.test(adminUserId)) {
    throw new ApiError(400, "用户 id 需为数字", "INVALID_INPUT")
  }

  // 先验证：用这份令牌真的调一次管理员接口
  const check = await verifyAdminCredential(env, token, adminUserId)
  if (!check.ok) {
    return json(
      {
        ok: false,
        code: "NEWAPI_TOKEN_INVALID",
        error: `令牌验证失败：${check.message}`,
      },
      400
    )
  }

  const { healedAccounts } = await saveAdminCredential(env, token, adminUserId)
  await recordAudit(
    env,
    admin.id,
    "admin.newapi.credential.update",
    `更新中转站管理员凭据（user id ${adminUserId}，令牌 ${maskToken(token)}，同步修复绑定 ${healedAccounts} 条）`,
    request.headers.get("CF-Connecting-IP")
  )

  const info = await getAdminCredentialInfo(env)
  return json({
    ok: true,
    source: info.source,
    maskedToken: info.maskedToken,
    adminUserId: info.adminUserId,
    updatedAt: info.updatedAt,
    healedAccounts,
    message:
      healedAccounts > 0
        ? "令牌已验证并保存；同时修复了该账号在本站的绑定（NewAPI 里管理员令牌与 root 用户的令牌是同一份）"
        : "令牌已验证并保存，立即生效",
  })
}

/**
 * GET /api/admin/mail-status —— 邮件发送能力现状。
 * 供管理面板与前端判断「哪些邮件功能当前可用」。
 */
export async function mailStatus(env: Env, request: Request): Promise<Response> {
  await requireAdmin(env, request)

  let verified: { email: string; verifiedAt: string | null }[] = []
  let listError: string | null = null
  try {
    const list = await cfListDestinations(env)
    verified = list
      .filter((d) => d.verified !== null)
      .map((d) => ({ email: d.email, verifiedAt: d.verified }))
  } catch (err) {
    listError = err instanceof Error ? err.message : String(err)
  }

  const counts = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM users) AS users,
       (SELECT COUNT(*) FROM users WHERE email_verified = 1) AS verified_users,
       (SELECT COUNT(*) FROM users WHERE notify_enabled = 1) AS notify_on`
  ).first<{ users: number; verified_users: number; notify_on: number }>()

  return json({
    bindingConfigured: Boolean(env.EMAIL),
    // 已验证目标地址数量决定「验证码/找回」能发给多少人
    verifiedDestinations: verified,
    listError,
    users: counts?.users ?? 0,
    verifiedUsers: counts?.verified_users ?? 0,
    notifySubscribers: counts?.notify_on ?? 0,
    // 群发公告需要 Onboard 发送域名（付费）；未 Onboard 时只能发已验证地址
    canBroadcast: false,
    note:
      "未 Onboard 发送域名时，只能发往「已验证目标地址」（免费）；" +
      "群发公告需在 Cloudflare 面板 Onboard Email Sending（付费）。",
  })
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
  const currency = (await isNewApiConfigured(env))
    ? await getCurrencyInfo(env)
    : { symbol: "$", code: "USD", perUnit: Number(settings.newapi_quota_per_unit) }

  // 可选的通知邮箱（下拉选择用）：
  //   - 平台已验证的转发目标地址（Cloudflare 免费额度内可直接发信）
  //   - 所有管理员的真实邮箱
  let verifiedDestinations: string[] = []
  try {
    const dests = await cfListDestinations(env)
    verifiedDestinations = dests
      .filter((d) => d.verified !== null)
      .map((d) => d.email)
  } catch (err) {
    console.error("读取已验证目标地址失败:", err)
  }

  const adminEmails = await env.DB.prepare(
    "SELECT email FROM users WHERE role = 'admin' AND email != '' ORDER BY username"
  ).all<{ email: string }>()

  const options = new Set<string>(verifiedDestinations)
  for (const r of adminEmails.results ?? []) options.add(r.email)
  // 站点域名邮箱也列出（本域内自有邮箱，可作为通知接收方）
  for (const d of verifiedDestinations) options.add(d)

  return json({
    settings,
    currency: { symbol: currency.symbol, code: currency.code },
    /** 可作为「管理员通知邮箱」的候选项 */
    notifyEmailOptions: [...options],
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

    // newapi_recommended_models：推荐模型分档。允许传数组（前端直接传对象）
    // 或 JSON 字符串；统一走 sanitizeRecommendedModels 清洗后序列化。
    // 必须排在下面的 `str === ""` 与通用 `str.slice(0,100)` 之前：
    //  - 传空数组 [] 时 String([]) === ""，会被当成「空值跳过」，导致清空不掉；
    //  - 传 JSON 字符串会被截断成无效串。
    if (key === "newapi_recommended_models") {
      let parsed: unknown = raw
      if (typeof raw === "string") {
        try {
          parsed = JSON.parse(raw)
        } catch {
          throw new ApiError(400, "推荐模型格式不是合法 JSON", "INVALID_INPUT")
        }
      }
      values[key] = JSON.stringify(sanitizeRecommendedModels(parsed))
      continue
    }

    // 以下两个「逗号分隔模块名」的设置必须排在 `str === "" continue` 之前：
    // 前端在「全部关掉」时正好发送空串，若被当成空值跳过，就永远清不掉
    // （表现为：把开关全关掉、点保存，刷新后开关又自己弹回来了）。

    // open_features：免权限访问的模块，空串 = 全部按权限卡
    if (key === "open_features") {
      const parts = String(raw).split(",").map((s) => s.trim()).filter(Boolean)
      for (const p of parts) {
        if (!(FEATURES as readonly string[]).includes(p)) {
          throw new ApiError(
            400,
            `免权限模块只支持：${FEATURES.join("、")}`,
            "INVALID_INPUT"
          )
        }
      }
      values[key] = parts.join(",")
      continue
    }

    // invite_basic_features：建码时人人可勾（不消耗额度）的模块，空串 = 全部受限
    if (key === "invite_basic_features") {
      const parts = String(raw).split(",").map((s) => s.trim()).filter(Boolean)
      for (const p of parts) {
        if (!(QUOTA_FEATURES as readonly string[]).includes(p)) {
          throw new ApiError(
            400,
            `基础权限模块只支持：${QUOTA_FEATURES.join("、")}`,
            "INVALID_INPUT"
          )
        }
      }
      values[key] = parts.join(",")
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

    // wb2api_max_bindings：每人可绑定的反代账号数，必须 ≥ 1
    // （不能走上面的通用数值分支：0 会让通道彻底不可用，且通用分支允许 0）
    if (key === "wb2api_max_bindings") {
      const n = Number(str)
      if (!Number.isFinite(n) || n < 1) {
        throw new ApiError(400, "每人可绑定上限至少为 1", "INVALID_INPUT")
      }
      values[key] = String(Math.trunc(n))
      continue
    }

    // wb2api_base_url：网关地址。必须是 http(s) 绝对地址。
    // 留空 = 用内置默认值 —— 空串已在上面 `str === "" continue` 处跳过，
    // 即「提交空串」等价于不修改本项（前端也提示了「留空则用内置默认值」）。
    if (key === "wb2api_base_url") {
      if (!/^https?:\/\//i.test(str)) {
        throw new ApiError(400, "网关地址需以 http(s):// 开头", "INVALID_INPUT")
      }
      values[key] = str.replace(/\/+$/, "").slice(0, 200)
      continue
    }

    // wb2api_realm：反代网关对接的域，只允许 cn（国内版）或 global（国际版）。
    if (key === "wb2api_realm") {
      const v = str.toLowerCase()
      if (v !== "cn" && v !== "global") {
        throw new ApiError(400, "反代域只支持 cn 或 global", "INVALID_INPUT")
      }
      values[key] = v
      continue
    }

    // reserved_nicknames：逗号分隔的昵称保留词，允许清空（空串写入）
    if (key === "reserved_nicknames") {
      const parts = String(raw)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.slice(0, 16))
      values[key] = parts.join(",").slice(0, 500)
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
  if (!(await isStorageConfigured(env))) {
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
      bucket_id?: string | null
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
// ---- 邀请码权限编辑 ----

/**
 * PUT /api/admin/invites/:id —— 修改邀请码（权限 / 可用次数）
 *
 * 语义说明：权限只影响**之后**用该码注册的新账号；
 * 已注册用户的权限存在 users.permissions，需在成员详情里单独改。
 */
export async function updateInvite(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireAdmin(env, request)
  const body = (await request.json()) as {
    permissions?: unknown
    maxUses?: number
  }

  const existing = await env.DB.prepare("SELECT * FROM invite_codes WHERE id = ?")
    .bind(id)
    .first<InviteRow>()
  if (!existing) {
    throw new ApiError(404, "邀请码不存在", "NOT_FOUND")
  }

  const maxUses =
    body.maxUses === undefined
      ? existing.max_uses
      : Math.min(Math.max(Math.trunc(Number(body.maxUses) || 1), 1), 1000)

  // permissions 传 null 表示恢复「全部允许」
  const perms =
    body.permissions === undefined
      ? existing.permissions
      : body.permissions === null
        ? null
        : JSON.stringify(normalizePermissions(body.permissions))

  await env.DB.prepare(
    "UPDATE invite_codes SET max_uses = ?, permissions = ? WHERE id = ?"
  )
    .bind(maxUses, perms, id)
    .run()

  await recordAudit(
    env,
    admin.id,
    "admin.invite.update",
    `邀请码 ${existing.code}: maxUses=${maxUses}, permissions=${perms ?? "全部允许"}`,
    request.headers.get("CF-Connecting-IP")
  )

  const updated = await env.DB.prepare("SELECT * FROM invite_codes WHERE id = ?")
    .bind(id)
    .first<InviteRow>()
  return json({ invite: toPublicInvite(updated!) })
}

// ---- 保留子域名（管理员可增删） ----

// GET /api/admin/reserved-subdomains
export async function listReserved(
  env: Env,
  request: Request
): Promise<Response> {
  await requireAdmin(env, request)
  return json({ reserved: await listReservedSubdomains(env.DB) })
}

// POST /api/admin/reserved-subdomains —— { name, note? }
export async function addReserved(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdmin(env, request)
  const body = (await request.json()) as { name?: string; note?: string }

  const name = (body.name ?? "").trim().toLowerCase().replace(/\.doulor\.cn$/i, "")
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
    throw new ApiError(400, "名称只能包含小写字母、数字和连字符", "INVALID_NAME")
  }

  const exists = await env.DB.prepare(
    "SELECT name FROM reserved_subdomains WHERE name = ? COLLATE NOCASE LIMIT 1"
  )
    .bind(name)
    .first()
  if (exists) {
    throw new ApiError(409, "该名称已在保留列表中", "CONFLICT")
  }

  await env.DB.prepare(
    "INSERT INTO reserved_subdomains (name, note, created_at) VALUES (?, ?, ?)"
  )
    .bind(name, body.note?.trim().slice(0, 100) ?? null, new Date().toISOString())
    .run()

  await recordAudit(
    env,
    admin.id,
    "admin.reserved.add",
    `保留子域名 ${name}`,
    request.headers.get("CF-Connecting-IP")
  )

  return json({ reserved: await listReservedSubdomains(env.DB) }, 201)
}

// DELETE /api/admin/reserved-subdomains/:name
export async function removeReserved(
  env: Env,
  request: Request,
  name: string
): Promise<Response> {
  const admin = await requireAdmin(env, request)
  const target = decodeURIComponent(name).trim().toLowerCase()

  const exists = await env.DB.prepare(
    "SELECT name FROM reserved_subdomains WHERE name = ? COLLATE NOCASE LIMIT 1"
  )
    .bind(target)
    .first()
  if (!exists) {
    throw new ApiError(404, "该名称不在保留列表中", "NOT_FOUND")
  }

  await env.DB.prepare("DELETE FROM reserved_subdomains WHERE name = ? COLLATE NOCASE")
    .bind(target)
    .run()

  await recordAudit(
    env,
    admin.id,
    "admin.reserved.remove",
    `取消保留 ${target}`,
    request.headers.get("CF-Connecting-IP")
  )

  return json({ reserved: await listReservedSubdomains(env.DB) })
}

// ---- 用户邀请码额度 ----

interface InviteQuotaRow {
  id: string
  code: string
  created_by: string | null
  max_uses: number
  used_count: number
  expires_at: string | null
  permissions: string | null
  created_at: string
}

function toAdminInvite(row: InviteQuotaRow) {
  return {
    id: row.id,
    code: row.code,
    maxUses: row.max_uses,
    usedCount: row.used_count,
    expiresAt: row.expires_at,
    permissions: parsePermissions(row.permissions),
    createdAt: row.created_at,
  }
}

/**
 * GET /api/admin/invite-quotas —— 所有用户的额度概况
 * 列表页只需额度与码数量，不含码内容（点进详情才拉）。
 */
export async function listInviteQuotas(
  env: Env,
  request: Request
): Promise<Response> {
  await requireAdmin(env, request)

  const rows = await env.DB.prepare(
    `SELECT u.id, u.username, u.invite_quota_bonus, u.invite_quota_used,
            u.feature_quota, u.feature_quota_used,
            (SELECT COUNT(*) FROM invite_codes ic WHERE ic.created_by = u.id) AS invite_count
       FROM users u
      ORDER BY u.created_at DESC`
  ).all<{
    id: string
    username: string
    invite_quota_bonus: number | null
    invite_quota_used: number | null
    feature_quota: string | null
    feature_quota_used: string | null
    invite_count: number
  }>()

  const base = await getSettingNumber(env, "invite_quota_base")

  const users = []
  for (const r of rows.results ?? []) {
    const bonus = Math.max(0, r.invite_quota_bonus ?? 0)
    const used = Math.max(0, r.invite_quota_used ?? 0)
    const total = base + bonus
    const fq = parseCounts(r.feature_quota)
    const fu = parseCounts(r.feature_quota_used)
    const remaining: Record<string, number> = {}
    for (const f of QUOTA_FEATURES) remaining[f] = Math.max(0, fq[f] - fu[f])

    users.push({
      id: r.id,
      username: r.username,
      inviteBase: base,
      inviteBonus: bonus,
      inviteTotal: total,
      inviteUsed: used,
      inviteRemaining: Math.max(0, total - used),
      featureQuota: fq,
      featureUsed: fu,
      featureRemaining: remaining,
      inviteCount: r.invite_count,
    })
  }

  return json({
    users,
    featureLabels: QUOTA_FEATURE_LABELS,
    quotaFeatures: QUOTA_FEATURES,
    basicFeatures: [...parseBasicFeatures(await getSetting(env, "invite_basic_features"))],
    baseQuota: base,
  })
}

/**
 * GET /api/admin/users/:username/invite-quota —— 单个用户的额度 + 其创建的邀请码
 */
export async function getUserInviteQuota(
  env: Env,
  request: Request,
  username: string
): Promise<Response> {
  await requireAdmin(env, request)
  const user = await targetUser(env, username)

  const rows = await env.DB.prepare(
    "SELECT * FROM invite_codes WHERE created_by = ? ORDER BY created_at DESC"
  )
    .bind(user.id)
    .all<InviteQuotaRow>()

  const bonus = Math.max(0, user.invite_quota_bonus ?? 0)
  const used = Math.max(0, user.invite_quota_used ?? 0)
  const base = await getSettingNumber(env, "invite_quota_base")
  const total = base + bonus
  const fq = parseCounts(user.feature_quota)
  const fu = parseCounts(user.feature_quota_used)
  const remaining: Record<string, number> = {}
  for (const f of QUOTA_FEATURES) remaining[f] = Math.max(0, fq[f] - fu[f])

  return json({
    username: user.username,
    quota: {
      inviteBase: base,
      inviteBonus: bonus,
      inviteTotal: total,
      inviteUsed: used,
      inviteRemaining: Math.max(0, total - used),
      featureQuota: fq,
      featureUsed: fu,
      featureRemaining: remaining,
    },
    invites: (rows.results ?? []).map(toAdminInvite),
    featureLabels: QUOTA_FEATURE_LABELS,
    quotaFeatures: QUOTA_FEATURES,
    basicFeatures: [...parseBasicFeatures(await getSetting(env, "invite_basic_features"))],
  })
}

/**
 * PUT /api/admin/users/:username/invite-quota —— 调整额度
 * body: { inviteBonus?, inviteUsed?, featureQuota?, featureUsed? }
 * 传整数即设为该值（用于补偿、纠错、手动发放）。省略则不改。
 */
export async function updateUserInviteQuota(
  env: Env,
  request: Request,
  username: string
): Promise<Response> {
  const admin = await requireAdmin(env, request)
  const body = (await request.json().catch(() => ({}))) as {
    inviteBonus?: unknown
    inviteUsed?: unknown
    featureQuota?: unknown
    featureUsed?: unknown
  }

  const user = await targetUser(env, username)
  const sets: string[] = []
  const binds: unknown[] = []

  const asCount = (v: unknown, label: string): number => {
    const n = Math.trunc(Number(v))
    if (!Number.isFinite(n) || n < 0 || n > 10000) {
      throw new ApiError(400, `${label}需为 0-10000 的整数`, "INVALID_INPUT")
    }
    return n
  }

  if (body.inviteBonus !== undefined) {
    sets.push("invite_quota_bonus = ?")
    binds.push(asCount(body.inviteBonus, "邀请码额度"))
  }
  if (body.inviteUsed !== undefined) {
    sets.push("invite_quota_used = ?")
    binds.push(asCount(body.inviteUsed, "已用邀请码额度"))
  }
  // 模块额度：只覆盖传入的键，其余保留原值
  if (body.featureQuota !== undefined) {
    const cur = parseCounts(user.feature_quota)
    for (const f of QUOTA_FEATURES) {
      const raw = (body.featureQuota as Record<string, unknown>)[f]
      if (raw !== undefined) cur[f] = asCount(raw, `${QUOTA_FEATURE_LABELS[f]}额度`)
    }
    sets.push("feature_quota = ?")
    binds.push(JSON.stringify(cur))
  }
  if (body.featureUsed !== undefined) {
    const cur = parseCounts(user.feature_quota_used)
    for (const f of QUOTA_FEATURES) {
      const raw = (body.featureUsed as Record<string, unknown>)[f]
      if (raw !== undefined) cur[f] = asCount(raw, `已用${QUOTA_FEATURE_LABELS[f]}额度`)
    }
    sets.push("feature_quota_used = ?")
    binds.push(JSON.stringify(cur))
  }

  if (sets.length === 0) {
    throw new ApiError(400, "没有需要修改的字段", "INVALID_INPUT")
  }

  sets.push("updated_at = ?")
  binds.push(new Date().toISOString())
  binds.push(user.id)

  await env.DB.prepare(
    `UPDATE users SET ${sets.join(", ")} WHERE id = ?`
  )
    .bind(...binds)
    .run()

  await recordAudit(
    env,
    admin.id,
    "admin.invite_quota.update",
    `调整 ${username} 的邀请码额度`,
    request.headers.get("CF-Connecting-IP")
  )

  return getUserInviteQuota(env, request, username)
}

/**
 * DELETE /api/admin/invites/:id 已存在（管理员可删任意邀请码）。
 * 这里额外提供「带额度退还」的删除：管理员删除用户创建的码时，
 * 若该码未被使用过，把额度退还给创建者，避免用户白掉额度。
 */
export async function adminDeleteInviteWithRefund(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireAdmin(env, request)

  const row = await env.DB.prepare("SELECT * FROM invite_codes WHERE id = ?")
    .bind(id)
    .first<InviteQuotaRow | null>()
  if (!row) {
    throw new ApiError(404, "邀请码不存在", "NOT_FOUND")
  }

  // 只有「用户自助创建且未使用」的码才退还额度（管理员自建的不涉及额度）
  if (row.created_by && row.used_count === 0) {
    await refundQuotaForInvite(
      env,
      row.created_by,
      quotaFeaturesOf(parsePermissions(row.permissions))
    )
  }

  await env.DB.prepare("DELETE FROM invite_codes WHERE id = ?").bind(id).run()

  await recordAudit(
    env,
    admin.id,
    "admin.invite.delete",
    `删除邀请码 ${row.code}`,
    request.headers.get("CF-Connecting-IP")
  )

  return new Response(null, { status: 204 })
}

// ---- 社区管理 ----

/** GET /api/admin/community/posts?user=&includeDeleted= */
export async function adminListPosts(env: Env, request: Request): Promise<Response> {
  await requireAdmin(env, request)
  const url = new URL(request.url)
  const includeDeleted = url.searchParams.get("includeDeleted") === "1"
  const user = url.searchParams.get("user")
  let q = `SELECT p.id, p.body, p.created_at, p.deleted_at, p.like_count, p.comment_count, p.share_count, u.username, u.nickname FROM posts p JOIN users u ON u.id = p.user_id`
  const binds: unknown[] = []
  const where: string[] = []
  if (!includeDeleted) where.push("p.deleted_at IS NULL")
  if (user) { where.push("u.username = ? COLLATE NOCASE"); binds.push(user) }
  if (where.length) q += " WHERE " + where.join(" AND ")
  q += " ORDER BY p.created_at DESC LIMIT 100"
  const rows = await env.DB.prepare(q).bind(...binds).all()
  return json({ posts: rows.results ?? [] })
}

/** DELETE /api/admin/community/posts/:id —— 管理员软删 */
export async function adminDeletePost(env: Env, request: Request, id: string): Promise<Response> {
  const admin = await requireAdmin(env, request)
  await env.DB.prepare("UPDATE posts SET deleted_at=? WHERE id=?").bind(new Date().toISOString(), id).run()
  await recordAudit(env, admin.id, "admin.community.post.delete", `删帖 ${id}`, request.headers.get("CF-Connecting-IP"))
  return json({ ok: true })
}

/** POST /api/admin/community/posts/:id/restore */
export async function adminRestorePost(env: Env, request: Request, id: string): Promise<Response> {
  const admin = await requireAdmin(env, request)
  await env.DB.prepare("UPDATE posts SET deleted_at=NULL WHERE id=?").bind(id).run()
  await recordAudit(env, admin.id, "admin.community.post.restore", `恢复帖 ${id}`, request.headers.get("CF-Connecting-IP"))
  return json({ ok: true })
}
