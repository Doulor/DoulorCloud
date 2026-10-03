import { ApiError, json } from "../http"
import { uuid } from "../crypto"
import { requireUser } from "../auth"
import { isUsernameWhitelisted, addIpToBlacklist } from "./moderation-lists"
import type { Env } from "../env"
import {
  SETTING_DEFAULTS,
  getSettings,
  getSetting,
  updateSettings,
  sanitizeRecommendedModels,
  audit as recordAudit,
  type SettingKey,
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
  adminSetUserStatus,
} from "../newapi-client"
import { sendMail, renderMail, parseBrevoKeys } from "../mailer"
import { fetchWithTimeout } from "../async-utils"
import { cfListDestinations } from "../cloudflare"
import { normalizePermissions, parsePermissions, FEATURES } from "../permissions"
import { normalizeEmailDomains } from "../email-domains"
import { normalizeCheckinMilestones } from "../checkin-config"
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
  quotaFeaturesFromStored,
} from "../quotas"
import { purgeUserStorage, recalculateUsage } from "./storage"
import { normalizeBaseUrl } from "../donation-provision"
import { purgeUserExternalResources } from "../user-cleanup"

/**
 * 管理员接口。
 * 所有端点先检查 role 是 admin 或 root（root = 站长，拥有 admin 全部权限），
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
  /** 展示用编号（按注册顺序，迁移 0070；老数据可能为 NULL） */
  uid?: number | null
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
  // root（站长）与 admin 都放行；root 拥有 admin 的全部权限
  if (admin.role !== "admin" && admin.role !== "root") {
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
  // 一次性**并行**拉取各模块明细（2026-10-03 反馈「打开用户详情卡顿」）。
  //
  // 之前这里是 13 个串行 await，每个 D1 往返 ~150ms，串起来 2 秒+；
  // 并行后总耗时 ≈ 最慢那一个查询。D1 支持同请求内并发读，这里没有写后读依赖。
  const [
    subdomains,
    dns,
    mailboxes,
    mails,
    sessions,
    storage,
    newapi,
    frp,
    frpApplications,
    frpPorts,
    proxy,
    profile,
    activity,
    inviteBase,
  ] = await Promise.all([
    env.DB.prepare(
      "SELECT id, name, fqdn, status, created_at FROM subdomains WHERE user_id = ? ORDER BY created_at ASC"
    )
      .bind(user.id)
      .all(),
    env.DB.prepare(
      "SELECT id, subdomain_id, name, fqdn, type, content, ttl, proxied, status, created_at FROM dns_records WHERE domain_id IN (SELECT id FROM domains WHERE user_id = ?) ORDER BY created_at ASC LIMIT 200"
    )
      .bind(user.id)
      .all(),
    env.DB.prepare(
      "SELECT id, address, forwarding_to, created_at FROM mailboxes WHERE user_id = ? ORDER BY created_at ASC"
    )
      .bind(user.id)
      .all(),
    env.DB.prepare(
      "SELECT m.id, m.mailbox_id, m.from_address, m.subject, m.read, m.received_at FROM messages m JOIN mailboxes mb ON m.mailbox_id = mb.id WHERE mb.user_id = ? ORDER BY m.received_at DESC LIMIT 200"
    )
      .bind(user.id)
      .all(),
    env.DB.prepare(
      "SELECT id, expires_at, created_at FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20"
    )
      .bind(user.id)
      .all(),
    env.DB.prepare(
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
      }>(),
    env.DB.prepare(
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
      }>(),
    env.DB.prepare(
      "SELECT enabled, created_at, updated_at FROM frp_accounts WHERE user_id = ?"
    )
      .bind(user.id)
      .first<{ enabled: number; created_at: string; updated_at: string }>(),
    env.DB.prepare(
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
      }>(),
    env.DB.prepare(
      `SELECT p.remote_port, p.created_at, n.name AS node_name
         FROM frp_ports p
         LEFT JOIN frp_nodes n ON n.id = p.node_id
        WHERE p.user_id = ? ORDER BY p.remote_port ASC`
    )
      .bind(user.id)
      .all<{ remote_port: number; created_at: string; node_name: string | null }>(),
    env.DB.prepare(
      "SELECT enabled, consent_version, consented_at, created_at, updated_at FROM proxy_activation WHERE user_id = ?"
    )
      .bind(user.id)
      .first<{
        enabled: number
        consent_version: number
        consented_at: string | null
        created_at: string
        updated_at: string
      }>(),
    env.DB.prepare(
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
      }>(),
    env.DB.prepare(
      "SELECT id, action, detail, created_at FROM audit_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 20"
    )
      .bind(user.id)
      .all<{ id: string; action: string; detail: string | null; created_at: string }>(),
    getSettingNumber(env, "invite_quota_base"),
  ])

  // ---- 额度 ----
  const inviteBonus = Math.max(0, user.invite_quota_bonus ?? 0)
  const inviteUsed = Math.max(0, user.invite_quota_used ?? 0)
  const featureQuota = parseCounts(user.feature_quota)
  const featureUsed = parseCounts(user.feature_quota_used)
  const featureRemaining: Record<string, number> = {}
  for (const f of QUOTA_FEATURES) {
    featureRemaining[f] = Math.max(0, featureQuota[f] - featureUsed[f])
  }

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
    `SELECT u.id, u.uid, u.username, u.email, u.namespace, u.role, u.status, u.permissions, u.max_subdomains, u.created_at,
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
            p.fqdn AS profile_fqdn,
            -- 注册时用的 IP：没存在 users 表上，只在 audit_logs 的 register 记录里（取最早一条）
            (SELECT a.ip FROM audit_logs a
              WHERE a.user_id = u.id AND a.action = 'register'
              ORDER BY a.created_at ASC LIMIT 1) AS register_ip
       FROM users u
       LEFT JOIN invite_codes ic ON ic.id = u.invite_code_id
       LEFT JOIN users creator ON creator.id = ic.created_by
       LEFT JOIN profiles p ON p.user_id = u.id
      ORDER BY u.created_at DESC`
  ).all()

  const activeUsers = (rows.results ?? []).map((r: Record<string, unknown>) => ({
    id: r.id,
    // 按注册顺序的展示用编号（migration 0070 加的 users.uid）；老数据可能为 null
    uid: (r.uid as number | null) ?? null,
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
    /** 注册时使用的 IP（来自 audit_logs 的 register 记录；查不到为 null） */
    registerIp: (r.register_ip as string | null) ?? null,
    deleted: false,
    deletedAt: null as string | null,
    deletedReason: null as string | null,
  }))

  // 已注销/被删的用户：从 deleted_users 取留痕，作为只读行附在列表末尾。
  // 这样管理员能查到「某人注销过」，但用户名/邮箱已释放、可被重新注册。
  const tombstones = await env.DB.prepare(
    `SELECT id, uid, username, email, namespace, role, reason, created_at, deleted_at
       FROM deleted_users
      ORDER BY deleted_at DESC`
  ).all<{
    id: string
    uid: number | null
    username: string
    email: string
    namespace: string | null
    role: string | null
    reason: string
    created_at: string | null
    deleted_at: string
  }>()

  const deletedUsers = (tombstones.results ?? []).map((t) => ({
    id: t.id,
    uid: t.uid ?? null,
    username: t.username,
    email: t.email,
    namespace: t.namespace ?? "",
    role: t.role ?? "user",
    status: "deleted",
    // 留痕行不参与鉴权，权限一律视为无（避免误导）
    permissions: { r2: false, ai: false, frp: false, proxy: false },
    maxSubdomains: null as number | null,
    createdAt: t.created_at ?? t.deleted_at,
    inviteCode: null as string | null,
    inviteCreatedBy: null as string | null,
    inviteCreatedAt: null as string | null,
    storageEnabled: false,
    aiEnabled: false,
    frpEnabled: false,
    proxyEnabled: false,
    profileEnabled: false,
    profileSlug: null as string | null,
    profileFqdn: null as string | null,
    registerIp: null as string | null,
    deleted: true,
    deletedAt: t.deleted_at,
    deletedReason: t.reason,
  }))

  return json({ users: [...activeUsers, ...deletedUsers] })
}

// GET /api/admin/users/:username —— 用户详情（子域名/DNS/邮箱/邮件/会话）
export async function getUser(env: Env, request: Request, username: string): Promise<Response> {
  await requireAdmin(env, request)
  const user = await targetUser(env, username)
  return json(await userDetail(env, user))
}

// PUT /api/admin/users/:username —— 更新用户状态（封禁/解封/设管理员/昵称等）
export async function updateUser(env: Env, request: Request, username: string): Promise<Response> {
  const operator = await requireAdmin(env, request)
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
    /**
     * 封禁原因（2026-10-02 加）。
     *
     * 只在 status 变成 `suspended` 时有意义：会写进 `users.suspend_reason`，
     * **用户下次登录时会看到**。所以请写「为什么」而不是「违规」这种等于没说的词 ——
     * 用户看不懂原因就会反复来申诉，反而增加你的工作量。
     */
    suspendReason?: string | null
  }

  const user = await targetUser(env, username)
  if (body.status && !["active", "suspended"].includes(body.status)) {
    throw new ApiError(400, "无效的状态", "INVALID_INPUT")
  }
  if (body.role && !["user", "admin", "root"].includes(body.role)) {
    throw new ApiError(400, "无效的角色", "INVALID_INPUT")
  }

  /**
   * 角色/状态修改的权限边界（2026-09-25 引入 root 角色后收紧）：
   *
   * 1. **root（站长）凌驾于一切**：任何非 root 操作者（包括 admin）都不能修改
   *    root 的任何字段、封禁/解封 root、也不能删 root。用「目标角色是 root」判断，
   *    不再依赖硬编码用户名 doulor。
   * 2. **只有 root 能改角色**：把别人设成 admin / 撤销 admin / 设成 root，
   *    都是 root 的专属动作。普通 admin 无权变更任何人的 role（否则 admin
   *    可以互提、甚至把自己提成 root）。
   *
   * 判断顺序很重要：先看「目标是 root 且操作者不是 root」直接拒绝（最强保护），
   * 再看「body.role 变化且操作者不是 root」拒绝。
   */
  if (user.role === "root" && operator.role !== "root") {
    throw new ApiError(403, "站长账户不可被修改", "FORBIDDEN")
  }
  const roleChanging = body.role !== undefined && body.role !== user.role
  if (roleChanging && operator.role !== "root") {
    throw new ApiError(403, "只有站长可以变更角色", "FORBIDDEN")
  }
  // root 不能把另一个 root 降级（理论上只有一个 root，双保险）
  if (roleChanging && user.role === "root") {
    throw new ApiError(403, "站长账户的角色不可变更", "FORBIDDEN")
  }

  // 权限：只有显式传入时才更新（null 保持原值）
  const perms =
    body.permissions === undefined || body.permissions === null
      ? null
      : JSON.stringify(normalizePermissions(body.permissions))

  // 记录「本次是否真的改了 status、改成什么」—— 用于封禁/解封时连带处理 NewAPI 账户。
  // 注意：body.status 通过校验后只可能是 "active" 或 "suspended"。
  const statusChanged =
    body.status !== undefined && body.status !== user.status
      ? (body.status as "active" | "suspended")
      : null

  /**
   * 白名单用户不会被封禁（站长 2026-10-03 要求）。
   * 在**真正写库之前**拦住，否则会先封再回滚，NewAPI 那边也会被连带 disable。
   */
  if (statusChanged === "suspended" && (await isUsernameWhitelisted(env, user.username))) {
    throw new ApiError(
      400,
      `「${user.username}」在白名单里，不会被封禁。如需封禁请先从白名单移除。`,
      "USER_WHITELISTED"
    )
  }

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

  /**
   * 封禁原因 / 封禁时间（2026-10-02）。
   *
   * · 封禁 → 记下原因（用户在登录页会看到，所以宁可写清楚）；
   * · 解封 → **清空**，否则会出现「已解封但登录页还挂着上次封禁理由」的怪状态。
   *
   * ⚠️ 只在本次**确实改了 status** 时才动这两列 —— 否则管理员改个昵称
   *    就会把封禁原因默默冲掉（或把解封后的残留又写回去）。
   */
  if (statusChanged === "suspended") {
    const reason = String(body.suspendReason ?? "").trim().slice(0, 300)
    const now = new Date().toISOString()
    await env.DB.prepare("UPDATE users SET suspend_reason = ?, suspend_at = ? WHERE id = ?")
      .bind(reason || null, now, user.id)
      .run()

    /**
     * 封禁联动黑名单（站长 2026-10-03）：
     * 把这个账号的**注册 IP** 自动加进黑名单 —— 同一 IP 批量注册的小号被封后，新注册直接挡。
     * 取的是「注册时的 IP」（audit_logs 的 register 行），不是最后一次登录 IP。
     */
    const reg = await env.DB.prepare(
      "SELECT ip FROM audit_logs WHERE user_id = ? AND action = 'register' ORDER BY created_at ASC LIMIT 1"
    )
      .bind(user.id)
      .first<{ ip: string | null }>()
    if (reg?.ip) {
      await addIpToBlacklist(env, reg.ip, `账号 ${user.username} 被封禁`, "auto")
    }
  } else if (statusChanged === "active") {
    await env.DB.prepare(
      "UPDATE users SET suspend_reason = NULL, suspend_at = NULL WHERE id = ?"
    )
      .bind(user.id)
      .run()

    /**
     * 解封时**对称地**把「封禁联动」加进来的 IP 撤掉 —— 否则误封一次，
     * 那个 IP 就永久被拉黑、连新账号都注册不了，且没人会想到去黑名单里清。
     * 但若该 IP 上还有**别的仍被封禁**的账号，则保留（那个号的封禁理由还在）。
     */
    const regIp = await env.DB.prepare(
      "SELECT ip FROM audit_logs WHERE user_id = ? AND action = 'register' ORDER BY created_at ASC LIMIT 1"
    )
      .bind(user.id)
      .first<{ ip: string | null }>()
    if (regIp?.ip) {
      const stillBanned = await env.DB.prepare(
        `SELECT 1 AS x FROM users u
           JOIN audit_logs a ON a.user_id = u.id AND a.action = 'register'
          WHERE a.ip = ? AND u.status = 'suspended' AND u.id <> ?
          LIMIT 1`
      )
        .bind(regIp.ip, user.id)
        .first<{ x: number }>()
      if (!stillBanned) {
        await env.DB.prepare(
          "DELETE FROM moderation_blacklist WHERE ip = ? AND source = 'auto'"
        )
          .bind(regIp.ip)
          .run()
      }
    }
  }

  // 封禁/解封联动 NewAPI 账户（2026-09-25 新增）。
  //
  // 需求：技术封禁 cloud 账户时，连带封禁他在中转站（NewAPI）里对应的账户，
  //      使其 API Key 立即失效（NewAPI 的 disable 会清 token 缓存）。
  // 解封时对称地 enable 回来。
  //
  // 设计取舍：
  //   - 只在「本次确实改了 status」时触发，避免每次编辑昵称/权限都白调一次 NewAPI。
  //   - NewAPI 未配置、或该用户没开通中转站账户时静默跳过（没有可禁的对象）。
  //   - **NewAPI 调用失败不阻断 cloud 侧封禁**：cloud 的 status 是主操作、已经落库；
  //     NewAPI 只是附带同步，失败时记审计日志、不向上抛错 —— 否则管理员会看到
  //     「封禁失败」，但用户其实已经被 cloud 侧停用了，反而误以为没封成。
  if (statusChanged) {
    const account = await env.DB.prepare(
      "SELECT newapi_user_id FROM newapi_accounts WHERE user_id = ?"
    )
      .bind(user.id)
      .first<{ newapi_user_id: number }>()

    if (account && (await isNewApiConfigured(env))) {
      try {
        await adminSetUserStatus(
          env,
          account.newapi_user_id,
          statusChanged === "suspended" ? "disable" : "enable"
        )
        await recordAudit(
          env,
          user.id,
          statusChanged === "suspended" ? "admin.newapi.suspend" : "admin.newapi.activate",
          `cloud ${statusChanged} → NewAPI 账户 #${account.newapi_user_id} 已同步${
            statusChanged === "suspended" ? "禁用" : "启用"
          }`
        )
      } catch (err) {
        // 附带同步失败：只记审计，不回滚、不抛错（cloud 封禁已生效）
        await recordAudit(
          env,
          user.id,
          "admin.newapi.sync_failed",
          `cloud ${statusChanged} 已生效，但 NewAPI 账户 #${account.newapi_user_id} 同步失败：${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    }
  }

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
      if (isReservedNickname(nick, extra, user.role === "admin" || user.role === "root")) {
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

// DELETE /api/admin/users/:username —— 删除用户（级联 + 回收外部资源）
export async function deleteUser(env: Env, request: Request, username: string): Promise<Response> {
  const admin = await requireAdmin(env, request)
  const user = await targetUser(env, username)
  // root（站长）不可被删除（原来靠硬编码 doulor，现改成按 root 角色判断）
  if (user.role === "root") {
    throw new ApiError(403, "站长账户不可被删除", "FORBIDDEN")
  }

  // ⚠️ 2026-09-26 审计：原实现只执行一句 `DELETE FROM users` —— CF Email Routing 规则、
  // DNS / Worker Route、R2 对象、NewAPI 渠道与 Key、WorkBuddy 网关账号全部变成
  // 收不回的孤儿（线上邮箱路由规则已用到 189/200）。
  // 清理必须在删 users 行**之前**完成，否则 mailboxes / dns_records / subdomains
  // 里的句柄会随 CASCADE 一起消失，之后就再也取不到了。
  const cleanup = await purgeUserExternalResources(env, user.id, user.username)

  // 留痕：管理员删号同样先写墓碑再删行（管理端列表以「已注销用户」展示）。
  // 与自助注销共用 deleted_users 表，reason 区分来源。
  await env.DB.prepare(
    `INSERT OR REPLACE INTO deleted_users
       (id, uid, username, email, namespace, role, reason, deleted_by, created_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, 'admin', ?, ?, ?)`
  )
    .bind(
      user.id,
      user.uid ?? null,
      user.username,
      user.email,
      user.namespace ?? null,
      user.role,
      admin.id,
      user.created_at ?? null,
      new Date().toISOString()
    )
    .run()

  await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id).run()

  await recordAudit(
    env,
    admin.id,
    "admin.user.delete",
    `删除用户 ${user.username}。清理：邮箱规则 ${cleanup.emailRules}、DNS 记录 ${cleanup.dnsRecords}、` +
      `自定义域 ${cleanup.customDomains}、R2 对象 ${cleanup.storageObjects}、` +
      `捐献渠道 ${cleanup.releasedChannels}、订阅源 ${cleanup.releasedSubscriptions}、` +
      `frp 节点 ${cleanup.releasedFrpNodes}、反代账号 ${cleanup.wb2Removed}、` +
      `CLI2API 账号 ${cleanup.cli2Removed}` +
      `${cleanup.newapiDisabled ? "、已禁用 NewAPI 账号" : ""}` +
      `${cleanup.errors.length > 0 ? `。⚠️ ${cleanup.errors.length} 项未清理成功：${cleanup.errors.join("；")}` : ""}`
  )

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

  const { text, html } = renderMail("【Doulor Cloud】邮件自检", [
    "如果你收到这封邮件，说明 Worker 的出站邮件已配置成功。",
    "此功能用于：真实邮箱验证、账号找回、以及站内通知。",
  ])

  try {
    await sendMail(env, { to, subject: "【Doulor Cloud】邮件自检", text, html })
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

/**
 * 「只写不读」的密钥类设置项。
 *
 * 这些值绝不能出现在任何回包里，也不能进审计日志 —— 管理面板会展示审计日志，
 * 落明文等于把密钥摊开给所有管理员看。
 */
const SECRET_SETTING_KEYS = new Set<string>(["posta_key", "brevo_api_key"])

/** 把密钥类设置项清空后再回显（GET 与 PUT 共用同一套规则，避免只修一处） */
function maskSecrets(
  settings: Record<SettingKey, string>
): Record<SettingKey, string> {
  const out = { ...settings }
  for (const k of SECRET_SETTING_KEYS) out[k as SettingKey] = ""
  return out
}

/**
 * 把一把 Key 中间打码后给管理面板「列表」用（明文永不回包）。
 * 留头留尾是为了让管理员能分辨「列表里哪把是哪把」——
 * Brevo Key 全都是 `xkeysib-` 开头，只留开头几位的区分度为零。
 */
function maskKeyForDisplay(key: string): string {
  const k = key.trim()
  if (k.length <= 12) return `${k.slice(0, 3)}****`
  return `${k.slice(0, 12)}****${k.slice(-6)}`
}

/** 邮件通道密钥的展示信息（明文不返回；GET 与 PUT 共用） */
function mailSecretsOf(settings: Record<SettingKey, string>): {
  postaConfigured: boolean
  brevoConfigured: boolean
  brevoKeyCount: number
  /** 已配置的 Brevo Key 列表（中间打码，顺序 = 轮询顺序） */
  brevoKeys: string[]
} {
  const brevoKeys = parseBrevoKeys(settings.brevo_api_key)
  return {
    postaConfigured: Boolean(settings.posta_key),
    brevoConfigured: brevoKeys.length > 0,
    brevoKeyCount: brevoKeys.length,
    brevoKeys: brevoKeys.map(maskKeyForDisplay),
  }
}

// GET /api/admin/settings —— 读取全部可配置项
export async function getSettingsHandler(env: Env, request: Request): Promise<Response> {
  await requireAdmin(env, request)
  const settings = await getSettings(env)

  // 邮件通道的密钥「只写不读」：GET 不返回明文，前端用是否已配置来判断。
  // 明文只在前端 PUT 时写入（留空则保持原值，见 updateSettingsHandler 的空串跳过逻辑）。
  const safeSettings = maskSecrets(settings)

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
    "SELECT email FROM users WHERE role IN ('admin', 'root') AND email != '' ORDER BY username"
  ).all<{ email: string }>()

  const options = new Set<string>(verifiedDestinations)
  for (const r of adminEmails.results ?? []) options.add(r.email)
  // 站点域名邮箱也列出（本域内自有邮箱，可作为通知接收方）
  for (const d of verifiedDestinations) options.add(d)

  return json({
    settings: safeSettings,
    currency: { symbol: currency.symbol, code: currency.code },
    /** 可作为「管理员通知邮箱」的候选项 */
    notifyEmailOptions: [...options],
    /** 邮件通道密钥是否已配置（明文不返回）；Brevo 额外给出 Key 把数与打码列表 */
    mailSecrets: mailSecretsOf(settings),
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

    // open_registration_until：限时开放注册的截止时间（ISO）。
    // **空串是合法值**（= 不限时，只要总开关开着就一直开放），必须排在
    // `str === "" continue` 之前，否则管理员清空截止时间后永远清不掉。
    // 统一规范化成 toISOString() 形态，前端提交的本地时间也在这里落成 UTC。
    if (key === "open_registration_until") {
      const v = String(raw).trim()
      if (v === "") {
        values[key] = ""
        continue
      }
      const t = Date.parse(v)
      if (!Number.isFinite(t)) {
        throw new ApiError(400, "开放注册截止时间格式不正确", "INVALID_INPUT")
      }
      values[key] = new Date(t).toISOString()
      continue
    }

    // sensenova_channel_id：商汤 Key 要并入的渠道 ID，必须是正整数。
    // 必须排在 `str === "" continue` 之前：**空串是合法值**（= 通道未配置，
    // 捐献转人工），若被当成空值跳过，管理员就永远清不掉这个配置。
    if (key === "sensenova_channel_id") {
      const v = String(raw).trim()
      if (v === "") {
        values[key] = ""
        continue
      }
      const n = Number(v)
      if (!Number.isInteger(n) || n <= 0) {
        throw new ApiError(
          400,
          "商汤接入渠道 ID 必须是正整数（在中转站渠道列表里能看到）",
          "INVALID_INPUT"
        )
      }
      values[key] = String(n)
      continue
    }

    // register_email_domains：注册邮箱白名单；空串 = 不限制（合法值）。
    // ⚠️ 必须单独处理：通用兜底会把字符串截断到 100 字符，而默认列表有 ~250 字符，
    // 会被砍掉后半段（gmail / outlook / hotmail 等），导致「注册不让用 gmail」。
    // 归一化（分隔符收宽 / 去空白 / 小写 / 去重 / 不截断）统一放在 email-domains.ts，
    // 与注册侧读取用的是**同一份实现** —— 两边分家就会出现「存进去的一个都匹配不上」。
    if (key === "register_email_domains") {
      values[key] = normalizeEmailDomains(String(raw))
      continue
    }

    // checkin_milestones：连续签到里程碑。归一化（分隔符收宽/去重/按天数升序/不截断）
    // 统一放在 checkin-config.ts，与签到读取侧用**同一份实现**。
    if (key === "checkin_milestones") {
      values[key] = normalizeCheckinMilestones(String(raw))
      continue
    }

    // brevo_api_key：支持多把 Key（多账号额度叠加）。前端**从不拿到明文**
    //（GET 只回打码串），所以提交的是「保留 + 新增」协议：
    //   keep:<n>  → 保留当前第 n 把（1 起，顺序同 GET 返回的列表）
    //   其它片段   → 新 Key 原文
    //   整串为空   → 清空全部（管理员把 Key 全删了）
    // ⚠️ 必须排在下面 `str === "" continue` 之前：空串在这里是「清空」而不是「不改」。
    // 必须单独处理：通用兜底会把它截断到 100 字符，而单把 Brevo Key 就有 89 字符。
    if (key === "brevo_api_key") {
      const current = parseBrevoKeys(await getSetting(env, "brevo_api_key"))
      const out: string[] = []
      for (const part of String(raw)
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter(Boolean)) {
        const m = /^keep:(\d+)$/.exec(part)
        if (m) {
          const idx = Number(m[1]) - 1
          if (idx >= 0 && idx < current.length) out.push(current[idx])
          continue
        }
        out.push(part)
      }
      // 去重：同一把粘两遍没有意义，还会在轮询里浪费一次尝试
      const joined = [...new Set(out)].join(",")
      if (joined.length > 2000) {
        throw new ApiError(400, "Brevo Key 过多或过长", "INVALID_INPUT")
      }
      values[key] = joined
      continue
    }

    const str = String(raw).trim()
    if (str === "") continue

    // cf_plan：Cloudflare 账号套餐（额度面板口径）。只认三个固定值 ——
    // 走通用分支会变成「任意字符串都能存」，面板拿到认不出的值只能回落免费版，
    // 管理员会以为「我明明选过付费版」。
    if (key === "cf_plan") {
      const v = str.toLowerCase()
      if (v !== "auto" && v !== "free" && v !== "paid") {
        throw new ApiError(400, "套餐只支持 auto / free / paid", "INVALID_INPUT")
      }
      values[key] = v
      continue
    }

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

    // sensenova_base_url：商汤上游地址。必须是 http(s) 绝对地址。
    // 复用 normalizeBaseUrl 的规则（去尾斜杠 + 剥一层 /v1）—— 管理员很可能
    // 把 `https://token.sensenova.cn/v1` 整段粘进来，不退掉就会拼成 `.../v1/v1/models`。
    if (key === "sensenova_base_url") {
      if (!/^https?:\/\//i.test(str)) {
        throw new ApiError(400, "商汤地址需以 http(s):// 开头", "INVALID_INPUT")
      }
      values[key] = normalizeBaseUrl(str).slice(0, 200)
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
    // 审计日志里**不能落密钥明文**（审计日志是持久的、还会展示给管理员看）。
    // 记「改动了哪一项」即可，值本身不记。
    Object.entries(values)
      .map(([k, v]) => `${k}=${SECRET_SETTING_KEYS.has(k) ? "***" : v}`)
      .join(", "),
    request.headers.get("CF-Connecting-IP")
  )

  // 回显时同样抹掉密钥明文：GET 已经脱敏，PUT 不能成为另一个泄漏口
  // （前端只用这个响应判断成功与否，不读内容）。
  // 一并回 mailSecrets：Brevo Key 列表是「改完立刻生效」的，前端拿到新的打码列表
  // 就能就地更新，不必整页重载设置（重载会把其它未保存的编辑冲掉）。
  const fresh = await getSettings(env)
  return json({ settings: maskSecrets(fresh), mailSecrets: mailSecretsOf(fresh) })
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

// ---- 网盘配额（存量用户）----
//
// `storage_accounts.quota_bytes` 是**开通那一刻写死的快照**：改桶的「每人配额」只影响
// 之后新开通的人，存量用户不会跟着变。所以存量必须靠下面两个入口改：
//   · 单个用户 —— 成员详情里直接改；
//   · 批量 —— 把所有存量用户的配额刷成「所属桶的每人配额」（没桶归属则回落全局默认）。

/** PUT /api/admin/storage/quota/:username —— 改单个用户的网盘配额（字节） */
export async function updateStorageQuota(
  env: Env,
  request: Request,
  username: string
): Promise<Response> {
  const admin = await requireAdmin(env, request)
  const user = await targetUser(env, username)

  const body = (await request.json().catch(() => ({}))) as { quotaBytes?: unknown }
  const quotaBytes = Math.trunc(Number(body.quotaBytes))
  if (!Number.isFinite(quotaBytes) || quotaBytes < 0) {
    throw new ApiError(400, "配额必须是不小于 0 的整数（字节）", "INVALID_INPUT")
  }

  const account = await env.DB.prepare(
    "SELECT quota_bytes, used_bytes FROM storage_accounts WHERE user_id = ?"
  )
    .bind(user.id)
    .first<{ quota_bytes: number; used_bytes: number }>()
  if (!account) throw new ApiError(404, "该用户还没开通网盘", "NOT_FOUND")

  await env.DB.prepare(
    "UPDATE storage_accounts SET quota_bytes = ?, updated_at = ? WHERE user_id = ?"
  )
    .bind(quotaBytes, new Date().toISOString(), user.id)
    .run()

  await recordAudit(
    env,
    admin.id,
    "admin.storage.quota",
    `把 ${username} 的网盘配额从 ${account.quota_bytes} 改为 ${quotaBytes} 字节`,
    request.headers.get("CF-Connecting-IP")
  )

  // 配额低于已用量不阻止操作（不删文件），但要让前端能提示「该用户已超额、传不了新东西」
  return json({
    quotaBytes,
    usedBytes: account.used_bytes,
    overQuota: account.used_bytes > quotaBytes,
  })
}

/**
 * POST /api/admin/storage/sync-quota —— 把存量用户的配额刷成「所属桶的每人配额」。
 *
 * 只动普通用户：admin/root 开通时写的是「不限量」哨兵值，不该被刷成 512 MB。
 * 桶被删/停用或用户没有桶归属时，回落全局 `storage_quota_bytes`。
 */
export async function syncStorageQuotas(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdmin(env, request)

  const bucketRows = await env.DB.prepare(
    "SELECT id, quota_per_user FROM r2_buckets WHERE kind = 'user' AND enabled = 1"
  ).all<{ id: string; quota_per_user: number }>()
  const byBucket = new Map((bucketRows.results ?? []).map((b) => [b.id, b.quota_per_user]))
  const fallback = await getSettingNumber(env, "storage_quota_bytes")

  const rows = await env.DB.prepare(
    `SELECT sa.user_id, sa.quota_bytes, sa.used_bytes, sa.bucket_id, u.username, u.role
       FROM storage_accounts sa JOIN users u ON u.id = sa.user_id`
  ).all<{
    user_id: string
    quota_bytes: number
    used_bytes: number
    bucket_id: string | null
    username: string
    role: string
  }>()

  const now = new Date().toISOString()
  const changed: { username: string; from: number; to: number; overQuota: boolean }[] = []
  let skippedAdmins = 0
  let failed = 0

  for (const r of rows.results ?? []) {
    if (r.role === "admin" || r.role === "root") {
      skippedAdmins++
      continue
    }
    const target = (r.bucket_id ? byBucket.get(r.bucket_id) : undefined) ?? fallback
    if (!target || target === r.quota_bytes) continue
    try {
      await env.DB.prepare(
        "UPDATE storage_accounts SET quota_bytes = ?, updated_at = ? WHERE user_id = ?"
      )
        .bind(target, now, r.user_id)
        .run()
      changed.push({
        username: r.username,
        from: r.quota_bytes,
        to: target,
        overQuota: r.used_bytes > target,
      })
    } catch {
      failed++
    }
  }

  await recordAudit(
    env,
    admin.id,
    "admin.storage.sync_quota",
    `同步存量网盘配额：更新 ${changed.length} 个（跳过管理员 ${skippedAdmins}、失败 ${failed}）`,
    request.headers.get("CF-Connecting-IP")
  )

  return json({
    updated: changed.length,
    skippedAdmins,
    failed,
    overQuota: changed.filter((c) => c.overQuota).length,
    // 回执只带前 200 条，避免极端情况下响应过大
    changed: changed.slice(0, 200),
  })
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
    `SELECT u.id, u.uid, u.username, u.email, u.namespace,
            u.invite_quota_bonus, u.invite_quota_used,
            u.feature_quota, u.feature_quota_used,
            (SELECT COUNT(*) FROM invite_codes ic WHERE ic.created_by = u.id) AS invite_count
       FROM users u
      ORDER BY u.created_at DESC`
  ).all<{
    id: string
    uid: number | null
    username: string
    email: string
    namespace: string
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
      // 与用户列表同口径：展示编号 + 用户名 + 邮箱 + 命名空间，供顶部搜索用
      uid: r.uid ?? null,
      username: r.username,
      email: r.email,
      namespace: r.namespace,
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
    // ⚠️ 2026-09-25 审计（L25）：这里原本是
    //   quotaFeaturesOf(parsePermissions(row.permissions))
    // 而 `parsePermissions(null)` 返回的是 **allPermissions()（全开）** ——
    // 于是一个 `permissions = NULL` 的邀请码被删除时，退还的模块集合会变成
    // 全部四个模块，等于凭空给用户加额度（越删越多）。
    //
    // `quotaFeaturesFromStored` 对 null/坏 JSON 返回 **空数组**：
    // 「不知道当初发了什么」时退还 0 个，方向上是安全的（少退不越权）。
    // 用户自助创建的码在 my-invites.ts 里始终写入 JSON，不会走到 null 分支；
    // 这条兜底针对的是历史遗留行与手工插库。
    await refundQuotaForInvite(
      env,
      row.created_by,
      quotaFeaturesFromStored(row.permissions)
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

/* ------------------------------------------------------------------ *
 * Brevo 剩余额度（邮件通道）
 *
 * 为什么要有：Brevo 免费版按**账号**限 300 封/天，用完后发信接口返回
 * `max_emails_per_day_exceeded`。管理员需要提前知道「今天还剩多少」，
 * 而不是等群发失败才发现。配了多把 Key（多账号）时按把分别展示 ——
 * 一眼看出哪把已见底、哪把还能用，这正是「额度叠加」的实际状态。
 *
 * 数据来源：`GET https://api.brevo.com/v3/account` 的 `plan[].credits`
 * （免费版 creditsType=sendLimit，credits 即**当日剩余**封数）。
 *
 * ⚠️ 该接口受 Brevo 的「IP 白名单」限制：某个子账号若开了 IP 校验，
 *    我们（以及 Cloudflare）的出口 IP 不在名单里，就会返回
 *    `unrecognised IP address`。这种情况**必须如实展示错误原因**，
 *    绝不能显示成 0 —— 否则会被误读成「额度用完了」。子账号需要在
 *    Brevo 后台关掉 IP 校验，或把出口 IP 加进白名单。
 * ------------------------------------------------------------------ */

/** Brevo `/v3/account` 响应的相关字段 */
interface BrevoAccountBody {
  email?: string
  message?: string
  code?: string
  plan?: { type?: string; credits?: number; creditsType?: string }[]
}

/** 单个 Brevo Key 的额度 */
export interface BrevoKeyQuota {
  /** 第几把（从 1 起，按配置里的顺序） */
  index: number
  ok: boolean
  /** 账号邮箱（用于区分是哪个小号）；读不到时为 null */
  email: string | null
  /** 套餐类型，如 free */
  plan: string | null
  /** 当日剩余封数 */
  credits: number | null
  /** credits 的含义，如 sendLimit */
  creditsType: string | null
  /** 读不到时的原因（会直接显示给管理员） */
  error: string | null
}

export interface BrevoQuotaOverview {
  /** 免费版单账号每日额度，用于画进度条 */
  freeDailyLimit: number
  keys: BrevoKeyQuota[]
  /** 所有能读到的 Key 的剩余之和 */
  totalRemaining: number
  /** 能读到的 Key 数 / 总数 */
  okCount: number
  totalCount: number
  generatedAt: string
}

/** 免费版单账号每日上限（Brevo 免费档 300 封/天） */
const BREVO_FREE_DAILY = 300

/** 查一把 Key 的剩余额度（只读；失败不抛错，把原因塞进 error） */
async function probeBrevoKey(key: string, index: number): Promise<BrevoKeyQuota> {
  const base: BrevoKeyQuota = {
    index,
    ok: false,
    email: null,
    plan: null,
    credits: null,
    creditsType: null,
    error: null,
  }
  try {
    const res = await fetchWithTimeout(
      "https://api.brevo.com/v3/account",
      { headers: { "api-key": key, accept: "application/json" } },
      10_000
    )
    const text = await res.text()
    let body: BrevoAccountBody | null = null
    try {
      body = JSON.parse(text) as BrevoAccountBody
    } catch {
      body = null
    }

    if (!res.ok) {
      // Brevo 的不合法 IP 会返回 401 + 一段英文说明，翻译成人话给管理员看
      const raw = body?.message ?? text.slice(0, 160)
      base.error = /unrecognised IP/i.test(raw)
        ? "该子账号开启了 IP 校验，我们的出口 IP 不在白名单里 —— 需在 Brevo 后台关闭 IP 校验（否则这把 Key 发不出信）"
        : `Brevo 返回 ${res.status}：${raw}`
      return base
    }

    const plan = body?.plan?.[0]
    base.ok = true
    base.email = body?.email ?? null
    base.plan = plan?.type ?? null
    base.credits = typeof plan?.credits === "number" ? plan.credits : null
    base.creditsType = plan?.creditsType ?? null
    return base
  } catch (err) {
    base.error = `请求 Brevo 失败：${err instanceof Error ? err.message : String(err)}`
    return base
  }
}

/** GET /api/admin/mail/brevo-quota —— 每把 Brevo Key 的当日剩余额度 */
export async function getBrevoQuota(env: Env, request: Request): Promise<Response> {
  await requireAdmin(env, request)
  const keys = parseBrevoKeys(await getSetting(env, "brevo_api_key"))

  const quota = await Promise.all(keys.map((k, i) => probeBrevoKey(k, i + 1)))
  const okOnes = quota.filter((q) => q.ok && typeof q.credits === "number")

  const out: BrevoQuotaOverview = {
    freeDailyLimit: BREVO_FREE_DAILY,
    keys: quota,
    totalRemaining: okOnes.reduce((sum, q) => sum + (q.credits ?? 0), 0),
    okCount: okOnes.length,
    totalCount: quota.length,
    generatedAt: new Date().toISOString(),
  }
  return json(out)
}
