import { ApiError, json } from "../http"
import { uuid, hashPassword } from "../crypto"
import { requireUser, isPrivileged, isAnyAdmin, isRoot } from "../auth"
import {
  parseAdminScope,
  isKnownPermissionKey,
  isRootOnlyPermission,
  permissionLabel,
} from "../admin-permissions"
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
import { likeContains } from "../sql-like"
import { normalizePermissions, parsePermissions, FEATURES, type Permissions } from "../permissions"
import { normalizeEmailDomains } from "../email-domains"
import { normalizeCheckinMilestones } from "../checkin-config"
import {
  validateNicknameFormat,
  isReservedNickname,
  parseReservedNicknames,
} from "../identity"
import { listReservedSubdomains } from "../reserved-names"
import { getSettingNumber } from "../settings"
import { revokeAllUserTokens } from "../oauth-provider"
// 帖子分类的归一化：与读取侧（community.ts 的 postCategoryDefs）用同一份实现，
// 避免「存进去的规则」和「读出来的规则」分家 —— 那种不一致极难排查。
import { parsePostCategories } from "./community"
import {
  QUOTA_FEATURES,
  QUOTA_FEATURE_LABELS,
  parseBasicFeatures,
  parseCounts,
  refundQuotaForInvite,
  quotaFeaturesFromStored,
} from "../quotas"
import { purgeUserStorage, recalculateUsage } from "./storage"
import { suspendUserResources, restoreUserResources } from "../user-suspension"
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
  /** 引用的权限组 id（可空 = 未加入任何组） */
  admin_role_id?: string | null
  /** 自定义管理白名单（JSON 数组；非空 = 覆盖权限组，前端标记「自定义」） */
  admin_scope?: string | null
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
  // root（站长）与 superadmin（超级管理员）都放行；admin（自定义白名单）也放行，
  // 但能否做具体某件事由 requireAdminScope 按白名单逐项判断
  if (!isAnyAdmin(admin.role)) {
    throw new ApiError(403, "需要管理员权限", "FORBIDDEN")
  }
  return admin
}

/**
 * 白名单解析所需的最小字段（UserRow / AdminUserRow 都满足）。
 * 让 assertAdminScope / resolveAdminScope 能被各 handler 复用，
 * 而不必处处持有完整的 AdminUserRow。
 */
export type AdminScopeSource = {
  role: string
  admin_role_id?: string | null
  admin_scope?: string | null
}

/**
 * 读取管理员的**最终白名单**（admin_scope 优先，否则回落到引用的权限组 scope）。
 * root / superadmin 不走到这里（调用方先短路）。
 */
export async function resolveAdminScope(env: Env, admin: AdminScopeSource): Promise<Set<string>> {
  const own = parseAdminScope(admin.admin_scope)
  if (own.size > 0) return own // 单人自定义覆盖（即便仍挂在组里，也以覆盖为准）
  if (admin.admin_role_id) {
    const row = await env.DB.prepare("SELECT scope FROM admin_roles WHERE id = ?")
      .bind(admin.admin_role_id)
      .first<{ scope: string }>()
    if (row) return parseAdminScope(row.scope)
  }
  return new Set()
}

/**
 * 已拿到 admin 对象时，检查其白名单是否含 permKey（不再重复 requireUser）。
 * 用于「一个接口里做多件危险事」的场景（如 updateUser 里封禁/改权限/切角色）。
 */
export async function assertAdminScope(
  env: Env,
  admin: AdminScopeSource,
  permKey: string
): Promise<void> {
  if (!isKnownPermissionKey(permKey)) {
    throw new ApiError(500, `未登记的权限节点 ${permKey}`, "BAD_PERMISSION")
  }
  // rootOnly 节点先于 superadmin 放行判断：这类节点只有 root 能过（superadmin 也不行）
  if (isRootOnlyPermission(permKey)) {
    if (!isRoot(admin.role)) {
      throw new ApiError(403, `「${permissionLabel(permKey)}」仅站长可用`, "FORBIDDEN")
    }
    return
  }
  if (isPrivileged(admin.role)) return
  const scope = await resolveAdminScope(env, admin)
  if (!scope.has(permKey)) {
    throw new ApiError(403, `你没有「${permissionLabel(permKey)}」权限`, "ADMIN_SCOPE_DENIED")
  }
}

/**
 * requireAdmin + 白名单权限节点检查。
 *
 * - root / superadmin：直接放行（全权）。
 * - admin：查最终白名单，含 permKey 才放行，否则 403。
 * - rootOnly 节点：只有 root 能过（superadmin 也不行）。
 */
export async function requireAdminScope(
  env: Env,
  request: Request,
  permKey: string
): Promise<AdminUserRow> {
  const admin = await requireAdmin(env, request)

  if (!isKnownPermissionKey(permKey)) {
    throw new ApiError(500, `未登记的权限节点 ${permKey}`, "BAD_PERMISSION")
  }
  // rootOnly 节点先于 superadmin 放行判断：这类节点只有 root 能过（superadmin 也不行）
  if (isRootOnlyPermission(permKey)) {
    if (!isRoot(admin.role)) {
      throw new ApiError(403, `「${permissionLabel(permKey)}」仅站长可用`, "FORBIDDEN")
    }
    return admin
  }
  if (isPrivileged(admin.role)) return admin
  const scope = await resolveAdminScope(env, admin)
  if (!scope.has(permKey)) {
    throw new ApiError(403, `你没有「${permissionLabel(permKey)}」权限`, "ADMIN_SCOPE_DENIED")
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
// 2026-10-08 性能：实测（1399 用户）该接口 ~1.7s 才回首字节，大头是**串行 D1 往返**
// （权限 1 次 + 主查询 1 次 + 注销留痕 1 次）。两处改法：
//   1. 主查询 / 注销留痕 / 分页计数改 `batch()` —— 3 次往返合成 1 次（省 ~400ms）；
//   2. 支持 ?limit=&offset=&q= 服务端分页搜索（**不传 = 维持旧行为返回全量**，
//      管理页旧前端不受影响；传了则只回该页数据 + total，供新前端做真分页）。
//      搜索按用户名/邮箱/命名空间/**注册 IP** 过滤；用户输入进 LIKE 一律走
//      likeContains（D1 模式超 50 字符直接 500，见 sql-like.ts）。
//      注册 IP 走 audit_logs 的 register 记录 —— 与列表「注册 IP」列同源，
//      搜出来的就是列上看到的那个 IP（站长用它查同 IP 多号）。
export async function listUsers(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "users.view")
  const url = new URL(request.url)
  const rawQ = (url.searchParams.get("q") ?? "").trim()
  const like = likeContains(rawQ)
  const hasPage = url.searchParams.has("limit") || url.searchParams.has("offset")
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200)
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0)

  // 搜索条件（有 q 时启用）：用户名 / 邮箱 / 命名空间任一命中即可。
  // IP 走 EXISTS 子查询而非 LIKE 列 —— 注册 IP 不在 users 表上，而在
  // audit_logs 的 register 记录里（与列表带出的 registerIp 同一口径）。
  const regIpExists =
    "(EXISTS(SELECT 1 FROM audit_logs a WHERE a.user_id = u.id AND a.action = 'register' AND a.ip LIKE ?))"
  const qWhere = rawQ
    ? ` WHERE (u.username LIKE ? OR u.email LIKE ? OR u.namespace LIKE ? OR ${regIpExists})`
    : ""
  const qBinds: unknown[] = rawQ ? [like, like, like, like] : []
  const pageSuffix = hasPage ? " LIMIT ? OFFSET ?" : ""
  const pageBinds: unknown[] = hasPage ? [limit, offset] : []

  const [mainRes, tombRes, countRes] = await env.DB.batch([
    env.DB.prepare(
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
         LEFT JOIN profiles p ON p.user_id = u.id${qWhere}
        ORDER BY u.created_at DESC${pageSuffix}`
    ).bind(...qBinds, ...pageBinds),
    // 已注销/被删的用户：留痕行只读地附在后面（见下方 deletedUsers 的映射）。
    // 带 q 搜索时留痕行也按同条件过滤 —— 否则搜索结果后面会跟一串无关的注销用户。
    // ⚠️ 分页模式（hasPage）下留痕**只在第一页附**：它不参与 total、也不参与
    // LIMIT/OFFSET 切页，若每页都带会在翻页中反复出现（2026-10-08 修）。
    // 留痕量很小（目前 20 行）且封顶 50，全附在第一页即可。
    hasPage && offset > 0
      ? env.DB.prepare(
          `SELECT NULL AS id, NULL AS uid, NULL AS username, NULL AS email, NULL AS namespace,
              NULL AS role, NULL AS reason, NULL AS created_at, NULL AS deleted_at WHERE 0`
        )
      : rawQ
        ? env.DB.prepare(
            `SELECT id, uid, username, email, namespace, role, reason, created_at, deleted_at
               FROM deleted_users
              WHERE (username LIKE ? OR email LIKE ? OR (namespace IS NOT NULL AND namespace LIKE ?))
              ORDER BY deleted_at DESC LIMIT 50`
          ).bind(like, like, like)
        : env.DB.prepare(
            `SELECT id, uid, username, email, namespace, role, reason, created_at, deleted_at
               FROM deleted_users
              ORDER BY deleted_at DESC LIMIT 50`
          ),
    // 分页版才需要 total（给前端算总页数）；全量版这条就是个占位（不取值）
    hasPage
      ? env.DB.prepare(`SELECT COUNT(*) AS c FROM users u${qWhere}`).bind(...qBinds)
      : env.DB.prepare("SELECT 1 AS x"),
  ])
  const rows = mainRes
  const activeUsers = (((rows.results ?? []) as unknown as Record<string, unknown>[]).map((r) => ({
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
  })))

  // 已注销/被删的用户：从 deleted_users 取留痕，作为只读行附在列表末尾。
  // 这样管理员能查到「某人注销过」，但用户名/邮箱已释放、可被重新注册。
  // （2026-10-08：已并入上面的 batch，结果在 tombRes 里）
  const tombstones = tombRes as unknown as {
    results?: {
      id: string
      uid: number | null
      username: string
      email: string
      namespace: string | null
      role: string | null
      reason: string
      created_at: string | null
      deleted_at: string
    }[]
  }

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

  return json({
    users: [...activeUsers, ...deletedUsers],
    // 分页信息：只有显式带 limit/offset 的请求才有意义（旧调用方忽略即可）
    ...(hasPage
      ? {
          total: Number(
            ((countRes as unknown as { results?: { c: number }[] }).results?.[0] as
              | { c: number }
              | undefined)?.c ?? activeUsers.length
          ),
          limit,
          offset,
        }
      : {}),
  })
}

// GET /api/admin/users/:username —— 用户详情（子域名/DNS/邮箱/邮件/会话）
export async function getUser(env: Env, request: Request, username: string): Promise<Response> {
  await requireAdminScope(env, request, "users.view")
  const user = await targetUser(env, username)
  return json(await userDetail(env, user))
}

/**
 * GET /api/admin/users/:username/activity?offset=0&limit=20
 * 用户详情的「最近活动」分页（2026-10-07 站长要求：支持查看更多 + 懒加载）。
 * 默认 20 条、最多 100 条；返回 hasMore 让前端决定还要不要给「加载更多」。
 * 顺带把审计日志的 IP 带出来 —— 排查滥用时 IP 是关键线索。
 */
export async function getUserActivity(
  env: Env,
  request: Request,
  username: string
): Promise<Response> {
  await requireAdminScope(env, request, "users.view")
  const user = await targetUser(env, username)

  const url = new URL(request.url)
  const offset = Math.max(0, Math.trunc(Number(url.searchParams.get("offset")) || 0))
  const limitRaw = Math.trunc(Number(url.searchParams.get("limit")) || 20)
  const limit = Math.min(Math.max(1, limitRaw), 100)

  // 多取一条用于判断「还有没有下一页」，省一次 count 查询
  const rows = await env.DB.prepare(
    `SELECT id, action, detail, ip, created_at
       FROM audit_logs WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?`
  )
    .bind(user.id, limit + 1, offset)
    .all<{ id: string; action: string; detail: string | null; ip: string | null; created_at: string }>()

  const all = rows.results ?? []
  const hasMore = all.length > limit
  const activity = all.slice(0, limit).map((a) => ({
    id: a.id,
    action: a.action,
    detail: a.detail ?? "",
    ip: a.ip ?? null,
    createdAt: a.created_at,
  }))

  return json({ activity, hasMore, offset, limit })
}

/**
 * 应用一次「封禁 / 解封」的**全部**副作用。
 *
 * 单人编辑（updateUser）与用户列表的批量封禁（admin-users-status.ts）共用这一份。
 * 为什么必须共用：封禁的联动项很多（原因落库、DNS/子域名停用、注册 IP 拉黑、
 * NewAPI 账户同步、每一步审计），任何一处另写一份都会漂移 —— 表现成
 * 「单人封禁全联动、批量封禁只改了个 status」，而这种漂移在测试里看不出来。
 *
 * 权限校验由调用方负责（`users.suspend`）；白名单拦截仍放在本函数里
 * （与 updateUser 同口径，迁移 0114 的数据库触发器是最后兜底）。
 *
 * 返回 false = 状态本来就是目标值，什么都没做（调用方据此统计「跳过」）。
 */
export async function applyUserStatusChange(
  env: Env,
  operator: { id: string; username: string },
  user: { id: string; username: string; status: string },
  next: "active" | "suspended",
  reason: string | null,
  request: Request
): Promise<boolean> {
  if (user.status === next) return false
  const now = new Date().toISOString()

  // 白名单用户不会被封禁（与 updateUser 同一条错误口径，别改成静默跳过 ——
  // 批量场景里「悄悄跳过白名单用户」比「明确报错」危险得多）
  if (next === "suspended") {
    const white = await isUsernameWhitelisted(env, user.username)
    if (white) {
      throw new ApiError(
        400,
        `「${user.username}」在白名单里，不会被封禁。如需封禁请先从白名单移除。`,
        "USER_WHITELISTED"
      )
    }
  }

  await env.DB.prepare("UPDATE users SET status = ?, updated_at = ? WHERE id = ?")
    .bind(next, now, user.id)
    .run()

  if (next === "suspended") {
    // 封禁原因 + 时间（解封时由下面的分支清空）
    await env.DB.prepare("UPDATE users SET suspend_reason = ?, suspend_at = ? WHERE id = ?")
      .bind(reason, now, user.id)
      .run()

    /**
     * 停用**对外生效**的资源（2026-10-08 站长要求）。
     *
     * 此前封禁只拦住「本人登录」，但他留下的 DNS 解析、子域名照样对外响应
     * （邮箱与邀请码分别在 email-delivery / 注册流程里就地校验，无需改数据）。
     * 这里把 CF 上的记录删掉并标记，解封时按本地留存字段重建。
     *
     * ⚠️ 失败**不阻断封禁**：cloud 侧 status 已经落库、才是主操作。
     *    删不掉的记录会保留 cf_id 并由维护任务兜底（见 user-suspension.ts）。
     */
    try {
      const res = await suspendUserResources(env, user.id)
      await recordAudit(
        env,
        user.id,
        "admin.user.resources_suspended",
        `封禁联动停用资源：DNS 记录 ${res.dnsSuspended} 条` +
          (res.dnsDeferred > 0 ? `（另有 ${res.dnsDeferred} 条排入维护任务）` : "") +
          `、子域名 ${res.subdomainsSuspended} 个` +
          (res.errors.length > 0 ? `；部分失败：${res.errors.slice(0, 3).join("；")}` : ""),
        request.headers.get("CF-Connecting-IP")
      )
    } catch (err) {
      // 连本地标记都失败（表未迁移等）：只记审计，不让封禁失败
      await recordAudit(
        env,
        user.id,
        "admin.user.resources_suspend_failed",
        `封禁已生效，但停用其 DNS/子域名失败：${err instanceof Error ? err.message : String(err)}`,
        request.headers.get("CF-Connecting-IP")
      )
    }

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
  } else {
    // 解封：清掉原因与时间（否则登录页还挂着上次的封禁理由）
    await env.DB.prepare(
      "UPDATE users SET suspend_reason = NULL, suspend_at = NULL WHERE id = ?"
    )
      .bind(user.id)
      .run()

    /**
     * 恢复被停用的资源（与上面的停用严格对称）：在 Cloudflare 上重建记录。
     * 同样**不阻断解封** —— 重建失败的记录保留 banned_at，下次会再试。
     */
    try {
      const res = await restoreUserResources(env, user.id)
      if (res.dnsRestored > 0 || res.subdomainsRestored > 0 || res.dnsFailed > 0) {
        await recordAudit(
          env,
          user.id,
          "admin.user.resources_restored",
          `解封联动恢复资源：DNS 记录 ${res.dnsRestored} 条、子域名 ${res.subdomainsRestored} 个` +
            (res.dnsFailed > 0 ? `；${res.dnsFailed} 条重建失败待重试` : "")
        )
      }
    } catch (err) {
      await recordAudit(
        env,
        user.id,
        "admin.user.resources_restore_failed",
        `解封已生效，但恢复其 DNS/子域名失败：${err instanceof Error ? err.message : String(err)}`
      )
    }

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
  //   - NewAPI 未配置、或该用户没开通中转站账户时静默跳过（没有可禁的对象）。
  //   - **NewAPI 调用失败不阻断 cloud 侧封禁**：cloud 的 status 是主操作、已经落库；
  //     NewAPI 只是附带同步，失败时记审计日志、不向上抛错 —— 否则管理员会看到
  //     「封禁失败」，但用户其实已经被 cloud 侧停用了，反而误以为没封成。
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
        next === "suspended" ? "disable" : "enable"
      )
      await recordAudit(
        env,
        user.id,
        next === "suspended" ? "admin.newapi.suspend" : "admin.newapi.activate",
        `cloud ${next} → NewAPI 账户 #${account.newapi_user_id} 已同步${
          next === "suspended" ? "禁用" : "启用"
        }`
      )
    } catch (err) {
      // 附带同步失败：只记审计，不回滚、不抛错（cloud 封禁已生效）
      await recordAudit(
        env,
        user.id,
        "admin.newapi.sync_failed",
        `cloud ${next} 已生效，但 NewAPI 账户 #${account.newapi_user_id} 同步失败：${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  // 状态变更本身也要留痕（记在**目标用户**名下：用户详情的「最近活动」按目标查；
  // 操作人写进 detail）。此前只有联动事件有审计，「谁封的」反倒查不到。
  await recordAudit(
    env,
    user.id,
    next === "suspended" ? "admin.user.suspend" : "admin.user.activate",
    `管理员 ${operator.username} ${next === "suspended" ? "封禁" : "解封"} ${user.username}` +
      (next === "suspended" && reason ? `：${reason}` : ""),
    request.headers.get("CF-Connecting-IP")
  )

  return true
}

// PUT /api/admin/users/:username —— 更新用户状态（封禁/解封/设管理员/昵称等）
export async function updateUser(env: Env, request: Request, username: string): Promise<Response> {
  const operator = await requireAdminScope(env, request, "users.view")
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
  if (body.role && !["user", "admin", "superadmin", "root"].includes(body.role)) {
    throw new ApiError(400, "无效的角色", "INVALID_INPUT")
  }

  /**
   * 角色修改的权限边界（2026-10-04 权限系统重构）：
   * 1. root（站长）凌驾一切：非 root 操作者不能改 root 的任何字段、封禁/解封/删 root。
   * 2. 只有 root / superadmin 能变更角色；admin 无权改任何人的 role。
   * 3. superadmin 只能设 user / admin；设 superadmin / root 是 root 专属。
   */
  if (user.role === "root" && operator.role !== "root") {
    throw new ApiError(403, "站长账户不可被修改", "FORBIDDEN")
  }
  const roleChanging = body.role !== undefined && body.role !== user.role
  if (roleChanging) {
    if (!isPrivileged(operator.role)) {
      throw new ApiError(403, "只有站长或超级管理员可以变更角色", "FORBIDDEN")
    }
    if (operator.role !== "root" && (body.role === "superadmin" || body.role === "root")) {
      throw new ApiError(403, "只有站长可以授予超级管理员或站长角色", "FORBIDDEN")
    }
    if (user.role === "root") {
      throw new ApiError(403, "站长账户的角色不可变更", "FORBIDDEN")
    }
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

  // 字段级权限（白名单逐项）：改封禁要 users.suspend、改功能权限要 users.permissions、
  // 改配额要 users.quota。root/superadmin 直接放行。
  if (statusChanged !== null) await assertAdminScope(env, operator, "users.suspend")
  if (perms !== null) await assertAdminScope(env, operator, "users.permissions")
  if (body.maxSubdomains !== undefined) await assertAdminScope(env, operator, "users.quota")

  /**
   * 白名单用户不会被封禁（站长 2026-10-03 要求）；
   * **也不会被收回权限**（2026-10-04 站长要求「白名单本身杜绝以后所有封禁项目」）。
   *
   * 两道防线：
   *   1. 这里——在**真正写库之前**拦住，给出一条人能看懂的错误（否则管理员会
   *      撞上触发器抛出的原始 SQL 报错）；
   *   2. `migrations/0114` 的数据库触发器——**兜底**，任何绕过本函数的代码路径
   *      （以后新写的功能）同样改不动白名单用户。
   * 所以这里的判断不是「唯一的保护」，而是「体验更好的那一层」。
   */
  const white = await isUsernameWhitelisted(env, user.username)
  if (white) {
    if (statusChanged === "suspended") {
      throw new ApiError(
        400,
        `「${user.username}」在白名单里，不会被封禁。如需封禁请先从白名单移除。`,
        "USER_WHITELISTED"
      )
    }
    if (perms !== null) {
      const before = parsePermissions(user.permissions)
      const after = JSON.parse(perms) as Permissions
      const revoked = FEATURES.filter((f) => before[f] && !after[f])
      if (revoked.length > 0) {
        throw new ApiError(
          400,
          `「${user.username}」在监管白名单里，权限不会被收回（本次涉及：${revoked.join(
            "、"
          )}）。如需收回请先把该用户移出白名单。`,
          "USER_WHITELISTED"
        )
      }
    }
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

  // status 由 applyUserStatusChange 单独写（它带着原因/资源/IP/NewAPI 一整套联动），
  // 这里只管角色与权限，避免两条路径都写 status。
  await env.DB.prepare(
    "UPDATE users SET role = COALESCE(?, role), permissions = COALESCE(?, permissions), updated_at = ? WHERE id = ?"
  )
    .bind(
      body.role ?? null,
      perms,
      new Date().toISOString(),
      user.id
    )
    .run()

  /**
   * 权限变更审计（2026-10-04 补）。
   *
   * 背景：这里原先**没有**任何 permissions 的审计 —— 站长在成员详情里手动
   * 勾/取消一个模块，事后完全查不出「是谁、什么时候、把什么改成了什么」。
   * 排查 `mahesh` 时踩到：该账号开放注册、无捐献无券无绑定，却拿到了四项
   * 全开权限，只能靠「建过一条同名邀请码、权限串一模一样」反推，日志里
   * 一个字都没有。权限是这个站最重要的资产之一，必须留痕。
   *
   * 只在**真的有差异**时记录：管理员改个昵称、或前端把同一份权限原样回传，
   * 都不该污染审计流（否则这行日志会被淹没）。对比用归一化后的权限对象，
   * 这样「原先是 NULL=全开、现在显式写成一样的内容」也不会误报为变更。
   */
  if (perms !== null) {
    const before = parsePermissions(user.permissions)
    const after = JSON.parse(perms) as Permissions
    const changed = FEATURES.filter((f) => before[f] !== after[f])
    if (changed.length > 0) {
      const describe = (p: Permissions) =>
        FEATURES.filter((f) => p[f]).join("/") || "（无）"
      const detail = changed
        .map((f) => `${f}:${before[f] ? "开" : "关"}→${after[f] ? "开" : "关"}`)
        .join(", ")
      await recordAudit(
        env,
        // ⚠️ 记在**被改的用户**名下（不是操作人）：用户详情页的「最近活动」
        //    按 `user_id = 目标用户` 查（见本文件 getUser 的 activity 查询）。
        //    排查 `mahesh` 时正是从那里入手的 —— 记在管理员名下就永远查不到
        //    「这个人的权限是谁给的」。操作人写进 detail 里，两边信息都不丢。
        user.id,
        "admin.user.permissions",
        `管理员 ${operator.username} 修改权限：${detail}（操作前 [${describe(before)}]，操作后 [${describe(after)}]）`,
        request.headers.get("CF-Connecting-IP")
      )
    }
  }

  /**
   * 封禁/解封的全部联动（原因落库、资源停用、IP 黑名单、NewAPI 同步、审计）
   * 收敛到 applyUserStatusChange —— 用户列表的批量封禁复用同一个函数，
   * 避免「单人全联动、批量只改 status」这种漂移。
   */
  if (statusChanged !== null) {
    await applyUserStatusChange(
      env,
      operator,
      user,
      statusChanged,
      statusChanged === "suspended"
        ? String(body.suspendReason ?? "").trim().slice(0, 300) || null
        : null,
      request
    )
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
      if (isReservedNickname(nick, extra, isPrivileged(user.role))) {
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

/**
 * POST /api/admin/users/:username/password —— 管理员直接为用户设置一个新密码。
 *
 * 用途：用户忘记密码又收不到找回邮件（邮箱填错 / 邮箱不可用）时，由站长代为重置，
 * 用户拿新密码登录后自行修改。
 *
 * 收口（都是刻意的，别松）：
 *   1. 只有 root 能做（权限节点 `users.password` 标了 rootOnly）—— 改密码等于接管账号，
 *      和「重置二次认证」同级，不能开放给普通管理员；
 *   2. 密码走同一套 `hashPassword`（pbkdf2），**绝不明文入库**；
 *   3. 重置后**清空该用户全部会话 + 撤销全部 OAuth 令牌** —— 否则旧会话（可能是
 *      攻击者的）还能继续用，等于没改；
 *   4. 记审计日志（谁在什么时候给谁重置了密码）。
 *
 * ⚠️ 不校验旧密码：管理员场景本来就不该知道用户的旧密码。
 */
export async function setUserPassword(
  env: Env,
  request: Request,
  username: string
): Promise<Response> {
  const operator = await requireAdminScope(env, request, "users.password")

  const body = (await request.json().catch(() => ({}))) as { password?: unknown }
  const password = typeof body.password === "string" ? body.password : ""
  if (password.length < 8) {
    throw new ApiError(400, "新密码至少需要 8 位", "WEAK_PASSWORD")
  }
  if (password.length > 200) {
    throw new ApiError(400, "密码过长", "INVALID_INPUT")
  }

  const user = await targetUser(env, username)
  // root 账户即便对站长自己也不允许在这里改（避免误操作把自己锁出去）；
  // 站长改自己的密码走「设置」页的正常改密流程。
  if (user.role === "root") {
    throw new ApiError(403, "站长账户的密码请在本人的设置页修改", "FORBIDDEN")
  }

  const now = new Date().toISOString()
  await env.DB.prepare(
    "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?"
  )
    .bind(await hashPassword(password), now, user.id)
    .run()

  // 旧会话与令牌全部作废：改密码的意义就在于把别人踢下线
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id).run()
  await revokeAllUserTokens(env, user.id)

  await recordAudit(
    env,
    operator.id,
    "user.password.admin_set",
    `为 ${user.username} 重置了密码`,
    request.headers.get("CF-Connecting-IP")
  )

  return json({ ok: true })
}

// DELETE /api/admin/users/:username —— 删除用户（级联 + 回收外部资源）
export async function deleteUser(env: Env, request: Request, username: string): Promise<Response> {
  const admin = await requireAdminScope(env, request, "users.delete")
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
      `Qoder2API 账号 ${cleanup.qoder2Removed}` +
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
  await requireAdminScope(env, request, "users.view")
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

function toPublicInvite(row: InviteRow & { created_by_name?: string | null }) {
  return {
    id: row.id,
    code: row.code,
    maxUses: row.max_uses,
    usedCount: row.used_count,
    expiresAt: row.expires_at,
    permissions: parsePermissions(row.permissions),
    createdAt: row.created_at,
    createdBy: row.created_by ?? null,
    /** 创建者用户名（LEFT JOIN 带出；老数据 created_by 为空时为 null） */
    createdByName: row.created_by_name ?? null,
  }
}

// GET /api/admin/invites —— 邀请码列表（带创建者用户名，便于直接在列表里溯源）
// GET /api/admin/invites —— 邀请码列表（带创建者用户名，便于直接在列表里溯源）
// 2026-10-08 性能：与用户/捐献列表同批改造。原先无分页、一次全量返回
// （201 个码，且随使用量增长），管理页切到该 tab 要等明显的一下。
//   ?limit=&offset= 服务端分页；?status= 按「未使用/部分使用/已使用」筛选
//   （判定口径与前端 inviteBucket 完全一致：used_count 与 max_uses 比较）；
//   ?count_only=1 只要总数（管理页头部那行「邀请码 N 个」用，进页面就要显示，
//   不能等用户切到 invite tab —— 那正是它以前一直显示 0 的原因）。
// 不传任何参数 = 旧的全量行为，兼容旧调用方。
export async function listInvites(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "invites")
  const url = new URL(request.url)
  const countOnly = url.searchParams.get("count_only") === "1"
  const hasPage = url.searchParams.has("limit") || url.searchParams.has("offset")
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200)
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0)
  const status = url.searchParams.get("status") ?? ""

  // 分类条件：与前端 inviteBucket() 同口径（unused: <=0；used: >=max；其余 partial）
  const statusWhere =
    status === "unused"
      ? " WHERE c.used_count <= 0"
      : status === "used"
        ? " WHERE c.used_count >= c.max_uses"
        : status === "partial"
          ? " WHERE c.used_count > 0 AND c.used_count < c.max_uses"
          : ""

  /** 只要总数：一次 COUNT 就够，别把列表也查出来 */
  if (countOnly) {
    const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM invite_codes").first<{ c: number }>()
    return json({ total: Number(row?.c ?? 0) })
  }

  const pageSuffix = hasPage ? " LIMIT ? OFFSET ?" : ""
  const pageBinds: unknown[] = hasPage ? [limit, offset] : []

  const [rows, countRes, groupRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT c.*, u.username AS created_by_name
         FROM invite_codes c
         LEFT JOIN users u ON u.id = c.created_by${statusWhere}
        ORDER BY c.created_at DESC${pageSuffix}`
    ).bind(...pageBinds),
    hasPage
      ? env.DB.prepare(`SELECT COUNT(*) AS c FROM invite_codes c${statusWhere}`)
      : env.DB.prepare(`SELECT 1 AS x`),
    hasPage
      ? env.DB.prepare(
          `SELECT CASE
                    WHEN used_count <= 0 THEN 'unused'
                    WHEN used_count >= max_uses THEN 'used'
                    ELSE 'partial'
                  END AS bucket,
                  COUNT(*) AS c
             FROM invite_codes GROUP BY bucket`
        )
      : env.DB.prepare(`SELECT NULL AS bucket, NULL AS c WHERE 0`),
  ])

  // counts：分类筛选按钮上的数字。"" = 全部，其余为各 bucket。
  const counts: Record<string, number> = {}
  for (const r of (groupRes.results ?? []) as unknown as { bucket: string | null; c: number | null }[]) {
    if (!r.bucket) continue
    counts[r.bucket] = Number(r.c) || 0
    counts[""] = (counts[""] ?? 0) + (Number(r.c) || 0)
  }

  return json({
    invites: ((rows.results ?? []) as unknown as (InviteRow & { created_by_name: string | null })[]).map(
      toPublicInvite
    ),
    ...(hasPage
      ? {
          total: Number(
            ((countRes as unknown as { results?: { c: number }[] }).results?.[0] as
              | { c: number }
              | undefined)?.c ?? 0
          ),
          limit,
          offset,
          counts,
        }
      : {}),
  })
}

/**
 * GET /api/admin/invites/:id/trace —— 邀请码溯源（2026-10-07 站长要求）。
 *
 * 回答四个问题：**谁建的、什么时候建的、谁用了、什么时候用的**，
 * 并顺带把每个使用者的**注册 IP** 与创建者的注册 IP 一起给出 ——
 * 同 IP 就是「一人多号」的硬证据（站长反馈：滥用者会刻意换 IP 规避，
 * 所以一旦出现同 IP，基本可以确定）。
 *
 * `id` 参数同时接受**邀请码 id** 和**邀请码字符串**（DC-XXXX 形式）：
 * 用户列表里只存了码字符串，点码即查，不必先换成 id。
 */
export async function traceInvite(
  env: Env,
  request: Request,
  idOrCode: string
): Promise<Response> {
  await requireAdminScope(env, request, "invites")

  const code = await env.DB.prepare(
    "SELECT * FROM invite_codes WHERE id = ? OR code = ? COLLATE NOCASE LIMIT 1"
  )
    .bind(idOrCode, idOrCode)
    .first<InviteRow>()
  if (!code) throw new ApiError(404, "邀请码不存在", "NOT_FOUND")

  /** 取某个用户的注册 IP（audit_logs 里最早那条 register） */
  const regIpSql =
    "(SELECT a.ip FROM audit_logs a WHERE a.user_id = u.id AND a.action = 'register' ORDER BY a.created_at ASC LIMIT 1)"

  const creator = code.created_by
    ? await env.DB.prepare(
        `SELECT u.id, u.username, u.email, u.uid, u.status, u.role, u.created_at,
                ${regIpSql} AS register_ip
           FROM users u WHERE u.id = ?`
      )
        .bind(code.created_by)
        .first<{
          id: string
          username: string
          email: string
          uid: number | null
          status: string
          role: string
          created_at: string
          register_ip: string | null
        }>()
    : null

  const usedRows = await env.DB.prepare(
    `SELECT u.id, u.username, u.email, u.uid, u.status, u.role, u.created_at,
            ${regIpSql} AS register_ip
       FROM users u
      WHERE u.invite_code_id = ?
      ORDER BY u.created_at ASC`
  )
    .bind(code.id)
    .all<{
      id: string
      username: string
      email: string
      uid: number | null
      status: string
      role: string
      created_at: string
      register_ip: string | null
    }>()

  const users = (usedRows.results ?? []).map((u) => ({
    id: u.id,
    username: u.username,
    email: u.email,
    uid: u.uid ?? null,
    status: u.status,
    role: u.role,
    usedAt: u.created_at,
    registerIp: u.register_ip ?? null,
  }))

  // 同 IP 分组：创建者与使用者之间、以及使用者互相之间
  const ipGroups: Record<string, string[]> = {}
  const push = (ip: string | null, name: string) => {
    if (!ip) return
    ;(ipGroups[ip] = ipGroups[ip] || []).push(name)
  }
  if (creator) push(creator.register_ip, creator.username)
  for (const u of users) push(u.registerIp, u.username)
  const sharedIps = Object.entries(ipGroups)
    .filter(([, names]) => names.length >= 2)
    .map(([ip, names]) => ({ ip, names }))

  return json({
    invite: {
      id: code.id,
      code: code.code,
      maxUses: code.max_uses,
      usedCount: code.used_count,
      expiresAt: code.expires_at,
      permissions: parsePermissions(code.permissions),
      createdAt: code.created_at,
    },
    creator: creator
      ? {
          id: creator.id,
          username: creator.username,
          email: creator.email,
          uid: creator.uid ?? null,
          status: creator.status,
          role: creator.role,
          createdAt: creator.created_at,
          registerIp: creator.register_ip ?? null,
        }
      : null,
    users,
    /** 至少 2 个账号共用的注册 IP（一人多号信号） */
    sharedIps,
  })
}

// POST /api/admin/invites —— 创建邀请码
export async function createInvite(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "invites")
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
  await requireAdminScope(env, request, "invites")
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
  await requireAdminScope(env, request, "mail")
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
  await requireAdminScope(env, request, "newapi.channels")
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
  await requireAdminScope(env, request, "newapi.channels")
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
  await requireAdminScope(env, request, "newapi.channels")
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
  const admin = await requireAdminScope(env, request, "newapi.channels")
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
  await requireAdminScope(env, request, "mail")

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
/**
 * 回包/审计时打空的设置键。
 *
 * ⚠️ 这里只影响 `/admin/settings` 的**回显与审计文本**。
 * AI 实验室那两个键（统一 Key、免费渠道）本来就是密文，但密文也没必要
 * 满世界传 —— 它们归 `handlers/admin-lab.ts` 管，那边的接口只回尾号。
 */
const SECRET_SETTING_KEYS = new Set<string>([
  "posta_key",
  "brevo_api_key",
  "lab_admin_api_key",
  "lab_admin_channels",
])

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
  await requireAdminScope(env, request, "settings")
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
  const admin = await requireAdminScope(env, request, "settings")
  const body = (await request.json()) as Record<string, unknown>

  const values: Record<string, string> = {}
  for (const [key, raw] of Object.entries(body)) {
    if (!(key in SETTING_DEFAULTS)) continue
    if (raw === null || raw === undefined) continue

    // 🔴 AI 实验室的两个密钥键**不许**从这个通用入口写。
    // 它们必须存 AES-GCM 密文，而下面这个通用分支是「原样落库 + 截断到 100 字符」——
    // 真让它落进去，结果是「库里躺着一份明文、读取侧又解不开」两头不讨好。
    // 统一走 PUT /api/admin/lab/config（那边的 buildConfig 只回尾号）。
    // 这条只是堵「手工构造请求」的口子：前端本来就没有这两个键的输入框。
    if (key === "lab_admin_api_key" || key === "lab_admin_channels") {
      throw new ApiError(
        400,
        "AI 实验室的密钥请到管理面板「AI 实验室」栏目里配置",
        "INVALID_INPUT"
      )
    }

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

    // first_donation_voucher_features：首捐奖励券可兑换的模块，空串 = 一个都不给。
    // 必须和上面两项一样排在 `str === "" continue` 之前，否则「全关掉」永远清不掉。
    // 取值范围是 FEATURES（含 doulor），与 vouchers.ts 的 redeemVoucher 校验一致。
    if (key === "first_donation_voucher_features") {
      const parts = String(raw).split(",").map((s) => s.trim()).filter(Boolean)
      for (const p of parts) {
        if (!(FEATURES as readonly string[]).includes(p)) {
          throw new ApiError(
            400,
            `首捐奖励券可兑换模块只支持：${FEATURES.join("、")}`,
            "INVALID_INPUT"
          )
        }
      }
      values[key] = parts.join(",")
      continue
    }

    // donation_transfer_features：捐献可发放「可转授额度」的模块，空串 = 一个都不发。
    // 必须和上面几项一样排在 `str === "" continue` 之前，否则「四个开关全关掉」
    // 永远清不掉（表现为：全关 → 保存 → 刷新后开关又自己弹回来了）。
    // 取值范围是 QUOTA_FEATURES（r2/ai/frp/proxy），与 quotas.ts 的
    // parseDonationQuotaFeatures 校验口径一致。
    if (key === "donation_transfer_features") {
      const parts = String(raw).split(",").map((s) => s.trim()).filter(Boolean)
      for (const p of parts) {
        if (!(QUOTA_FEATURES as readonly string[]).includes(p)) {
          throw new ApiError(
            400,
            `可转授额度的模块只支持：${QUOTA_FEATURES.join("、")}`,
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

    // temp_mailbox_refresh_daily_limit：临时邮箱每天最多刷新次数，非负整数（0 = 不限）。
    if (key === "temp_mailbox_refresh_daily_limit") {
      const n = Number(str)
      if (!Number.isFinite(n) || n < 0) {
        throw new ApiError(400, "临时邮箱每天刷新上限需要非负整数", "INVALID_INPUT")
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

    // post_categories：帖子分类（JSON 数组，管理面板可配，2026-10-07）。
    //
    // ⚠️ 必须单独处理：通用兜底会把它**截断到 100 字符**，而 4 个分类的 JSON 就有 ~250 字符
    //    —— 截断后 JSON 直接损坏，读取侧只能回落默认，表现成
    //    「管理员改了、点了保存、看着也成功了，但线上一点没变」。
    // 归一化用 community.ts 的 parsePostCategories（**与读取侧同一份实现**）：
    // 非法项当场丢弃；整份都不合法则**拒绝保存**（而不是默默存个坏值让读取侧回落）。
    if (key === "post_categories") {
      const parsed = parsePostCategories(String(raw))
      if (parsed.length === 0) {
        throw new ApiError(
          400,
          "帖子分类至少要有 1 个合法分类（标识只用小写字母/数字/下划线/连字符，不能重复，且至少填一个名字）",
          "INVALID_INPUT"
        )
      }
      values[key] = JSON.stringify(parsed)
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
  const admin = await requireAdminScope(env, request, "r2.quota")
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
  const admin = await requireAdminScope(env, request, "r2.quota")
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
  const admin = await requireAdminScope(env, request, "r2.quota")
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
  const admin = await requireAdminScope(env, request, "r2.quota")

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
    if (isPrivileged(r.role)) {
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
  const admin = await requireAdminScope(env, request, "invites")
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
  await requireAdminScope(env, request, "reserved")
  return json({ reserved: await listReservedSubdomains(env.DB) })
}

// POST /api/admin/reserved-subdomains —— { name, note? }
export async function addReserved(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "reserved")
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
  const admin = await requireAdminScope(env, request, "reserved")
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
  await requireAdminScope(env, request, "inviteQuotas")

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
  await requireAdminScope(env, request, "inviteQuotas")
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
  const admin = await requireAdminScope(env, request, "inviteQuotas")
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
  const admin = await requireAdminScope(env, request, "invites")

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
  await requireAdminScope(env, request, "community.posts")
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
  const admin = await requireAdminScope(env, request, "community.posts")
  await env.DB.prepare("UPDATE posts SET deleted_at=? WHERE id=?").bind(new Date().toISOString(), id).run()
  await recordAudit(env, admin.id, "admin.community.post.delete", `删帖 ${id}`, request.headers.get("CF-Connecting-IP"))
  return json({ ok: true })
}

/** POST /api/admin/community/posts/:id/restore */
export async function adminRestorePost(env: Env, request: Request, id: string): Promise<Response> {
  const admin = await requireAdminScope(env, request, "community.posts")
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
  await requireAdminScope(env, request, "mail")
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
