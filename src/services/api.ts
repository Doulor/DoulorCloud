import {
  type AdminInvite,
  type AdminSettings,
  type AdminUser,
  type AdminUserDetail,
  type ApiError,
  type Announcement,
  type AnnouncementStatus,
  type AchievementsResponse,
  type SpaceData,
  type SpaceCardData,
  type MySpaceSettings,
  type DnsRecord,
  type DnsRecordType,
  type Donation,
  type DonationOverview,
  type DonationProvisionResult,
  type DonationSubmitResult,
  type AiProbeResult,
  type VoucherOverview,
  type RedeemResult,
  type Mailbox,
  type AdminFrpApplication,
  type AdminFrpNode,
  type EmailSettings,
  type FrpOverview,
  type MailMessage,
  type Permissions,
  type MeResponse,
  type NewApiKey,
  type NewApiPreflight,
  type NewApiStatus,
  type StorageAccount,
  type StorageObject,
  type StorageOverview,
  type StoragePrefixCreated,

  type AdminInviteQuotasResponse,
  type AdminUserInviteQuotaResponse,
  type MyInvite,
  type MyInvitesOverview,
  type UserQuota,
  type FeatureCounts,
  type Profile,
  type ProfileContact,
  type ProfileModule,
  type ProfileMusicTrack,
  type ProfileOverview,
  type R2BucketsResponse,
  type R2Operations,
  type ReservedSubdomain,
  type ProxyOverview,
  type ProxyLatencyBatch,
  type CfQuotaOverview,
  type BrevoQuotaOverview,
  type MailSecrets,
  type AdminProxySubscription,
  type TempboxBatch,
  type TempboxConfig,
  type TempboxCreated,
  type Subdomain,
  type User,
  type Post,
  type CommentNode,
  type LinkPreview,
  type AnalyticsOverview,
  type UserAnalytics,
  type AdminAuditData,
  type ChatMessage,
  type ChatPresenceUser,
  type Notification,
  type CommunityStats,
  type AdminCommunityPost,
  type AdminNewApiConfig,
  type AdminNewApiCredentialSource,
  type Wb2ApiStatus,
  type Wb2ApiLoginStart,
  type Wb2ApiLoginPoll,
  type AdminWb2ApiBinding,
  type AdminWb2ApiConfig,
  type AdminWb2ApiPool,
  type Cli2ApiStatus,
  type Cli2ApiLoginStart,
  type Cli2ApiLoginPoll,
  type AdminCli2ApiBinding,
  type AdminCli2ApiConfig,
  type AdminCli2ApiPool,
  type FeedbackOverview,
  type AdminFeedbackOverview,
  type AdminFeedbackItem,
  type FeedbackItem,
  type MessageCategory,
  type EventItem,
  type EventClaim,
  type EventPayload,
  type PointsOverview,
  type PointsRedeemResult,
  type PointsConfig,
  type PointTransaction,
  type PointOrder,
  type PointProduct,
  type PointProductPayload,
  type UserProductPayload,
  type AdminPointsOverview,
  type AdminShopData,
  type DonationRewardItem,
  type InvitePointsConfig,
  type AttentionCounts,
} from "@/types"
import type { FunLinkCategory } from "@/lib/fun-links"

/**
 * 统一 API 请求层。
 *
 * 所有敏感逻辑（session 校验、域名所有权、Cloudflare API 调用）都在 Worker 端完成，
 * 前端只负责发起请求并携带 cookie（默认同源发送）。
 *
 * 本地开发时 Vite 会将 /api 代理到 http://localhost:8787（见 vite.config.ts），
 * 生产环境由 Cloudflare Pages + Workers 同源路由处理，无需额外配置。
 */

const BASE = "/api"

/** 通知全局：会话已失效（use-auth 监听后清空用户态） */
export function notifySessionExpired() {
  window.dispatchEvent(new Event("auth:expired"))
}

export class HttpError extends Error {
  status: number
  code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = "HttpError"
    this.status = status
    this.code = code
  }
}

/**
 * 统一从异常里取用户可读的错误文案。
 * 用法：toast.error(errMsg(err, "发布失败"))
 *
 * 服务端返回的 ApiError 文案是给用户看的，直接用；
 * 其余（网络断开、JSON 解析失败等）用调用方给的兜底文案。
 */
export function errMsg(err: unknown, fallback: string): string {
  if (err instanceof HttpError && err.message) return err.message
  if (err instanceof TypeError) return "网络连接失败，请检查网络后重试"
  return fallback
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json")
  }

  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
    credentials: "include",
  })

  if (res.status === 204) {
    return undefined as T
  }

  const data = await res.json().catch(() => null)

  if (!res.ok) {
    const message =
      (data as ApiError | null)?.error ?? `请求失败 (${res.status})`
    const code = (data as ApiError | null)?.code

    // 仅在「会话本身失效」时清空用户态。
    // 不能对所有 401 一律登出：登录密码错误、修改密码时当前密码错误
    // 同样是 401（code=INVALID_CREDENTIALS），误判会把正常用户直接踢下线。
    const sessionExpired =
      res.status === 401 && (code === undefined || code === "UNAUTHORIZED")

    if (sessionExpired) {
      notifySessionExpired()
    }

    throw new HttpError(res.status, message, code)
  }

  // 200 但响应体不是 JSON（例如静态站点把 /api 请求兜底成了 index.html）。
  // 此时 data 是 null，若直接返回会让调用方在 `res.posts` 上抛 TypeError，
  // 用户看到的是白屏而不是可理解的错误。这里统一转成 HttpError。
  if (data === null) {
    throw new HttpError(res.status, "服务响应异常，请检查网络或稍后重试", "INVALID_RESPONSE")
  }

  return data as T
}

// ---- Auth ----

export const authApi = {
  register: (payload: {
    username: string
    email: string
    password: string
    inviteCode: string
  }) =>
    request<{ user: MeResponse["user"] }>("/register", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  /** 注册页公开信息：当前是否开放注册（无需邀请码）、截止时间。无需登录 */
  registerStatus: () =>
    request<{ openRegistration: boolean; until: string | null }>("/register-status"),

  login: (payload: { identifier: string; password: string }) =>
    request<{ user: MeResponse["user"] }>("/login", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  logout: () => request<void>("/logout", { method: "POST" }),

  me: () => request<MeResponse>("/me"),

  changePassword: (payload: {
    currentPassword: string
    newPassword: string
  }) =>
    request<{ ok: boolean }>("/password", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  forgotPassword: (email: string) =>
    request<{ ok: boolean; message: string }>("/password/forgot", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),

  resetPassword: (token: string, password: string) =>
    request<{ ok: boolean; message: string }>("/password/reset", {
      method: "POST",
      body: JSON.stringify({ token, password }),
    }),
}

// ---- DNS ----

export interface CreateDnsPayload {
  subdomainId?: string
  /**
   * 相对前缀。
   *
   * SRV 记录下这个字段的语义不同：它是「服务标签之后、基准域名之前」的那一段
   * （可空），service / proto 由下面两个字段单独给 —— 记录名由服务端拼装，
   * 免得每个入口都要重复「必须带前导下划线、顺序固定」这套规则。
   */
  name: string
  type: DnsRecordType
  /** 非 SRV 记录的内容；SRV 不用（由 srv* 字段推导） */
  content: string
  ttl?: number
  proxied?: boolean
  /** MX 与 SRV 共用：值小者优先 */
  priority?: number
  /** SRV：服务名（`sip` 或 `_sip` 都行，服务端会补下划线） */
  srvService?: string
  /** SRV：协议（`tcp` / `udp`） */
  srvProto?: string
  /** SRV：同优先级内的权重，0–65535 */
  srvWeight?: number
  /** SRV：端口，1–65535 */
  srvPort?: number
  /** SRV：提供服务的主机名 */
  srvTarget?: string
  /** SRV：优先级，0–65535（缺省 10） */
  srvPriority?: number
}

export const dnsApi = {
  list: (subdomainId?: string) =>
    request<{ records: DnsRecord[] }>(
      subdomainId ? `/dns?subdomainId=${encodeURIComponent(subdomainId)}` : "/dns"
    ),

  create: (payload: CreateDnsPayload) =>
    request<{ record: DnsRecord }>("/dns", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  update: (id: string, payload: Partial<CreateDnsPayload>) =>
    request<{ record: DnsRecord }>(`/dns/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  remove: (id: string) =>
    request<void>(`/dns/${id}`, { method: "DELETE" }),
}

// ---- 子域名 ----

export const domainApi = {
  list: () =>
    request<{
      subdomains: Subdomain[]
      limit: number
      childLimit: number
      minRootNameLength: number
    }>("/subdomains"),

  /** parentId 省略 → 建一级子域名；指定 → 在该子域名下建子子域名 */
  create: (payload: { name: string; parentId?: string }) =>
    request<{ subdomain: Subdomain }>("/subdomains", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  remove: (id: string) =>
    request<void>(`/subdomains/${id}`, { method: "DELETE" }),
}

// ---- 管理员 ----

export const adminApi = {
  listUsers: () => request<{ users: AdminUser[] }>("/admin/users"),

  getUser: (username: string) =>
    request<AdminUserDetail>(`/admin/users/${encodeURIComponent(username)}`),

  updateUser: (
    username: string,
    payload: {
      status?: string
      role?: string
      permissions?: Permissions
      /** null = 恢复全局默认 */
      maxSubdomains?: number | null
      /** 展示昵称；null / 空串 = 清空 */
      nickname?: string | null
      emailVerified?: boolean
      notifyEnabled?: boolean
    }
  ) =>
    request<AdminUserDetail>(`/admin/users/${encodeURIComponent(username)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  deleteUser: (username: string) =>
    request<void>(`/admin/users/${encodeURIComponent(username)}`, {
      method: "DELETE",
    }),

  getUserMessage: (username: string, messageId: string) =>
    request<{ message: MailMessage }>(
      `/admin/users/${encodeURIComponent(username)}/messages/${encodeURIComponent(messageId)}`
    ),

  /**
   * Cloudflare 额度总览。额度数字按 `cf_plan` 设置选免费版/付费版口径
   * （auto 时服务端自动判定，见 handlers/cf-quota.ts 的 detectPlan）。
   * `fresh` 为 true 时绕过服务端 60 秒缓存（点「刷新」用）。
   */
  cloudflareQuota: (fresh = false) =>
    request<CfQuotaOverview>(`/admin/cloudflare/quota${fresh ? "?fresh=1" : ""}`),

  /** 每把 Brevo Key 的当日剩余额度（实时探测，无缓存） */
  brevoQuota: () => request<BrevoQuotaOverview>("/admin/mail/brevo-quota"),

  listInvites: () => request<{ invites: AdminInvite[] }>("/admin/invites"),

  /** 所有用户的邀请码额度概况 */
  listInviteQuotas: () =>
    request<AdminInviteQuotasResponse>("/admin/invite-quotas"),

  /** 单个用户的额度 + 其创建的邀请码 */
  getUserInviteQuota: (username: string) =>
    request<AdminUserInviteQuotaResponse>(
      `/admin/users/${encodeURIComponent(username)}/invite-quota`
    ),

  /** 调整额度（补偿/纠错/手动发放） */
  updateUserInviteQuota: (
    username: string,
    payload: {
      inviteBonus?: number
      inviteUsed?: number
      featureQuota?: Partial<FeatureCounts>
      featureUsed?: Partial<FeatureCounts>
    }
  ) =>
    request<AdminUserInviteQuotaResponse>(
      `/admin/users/${encodeURIComponent(username)}/invite-quota`,
      { method: "PUT", body: JSON.stringify(payload) }
    ),

  createInvite: (payload: {
    code: string
    maxUses?: number
    permissions?: Permissions
  }) =>
    request<{ invite: AdminInvite }>("/admin/invites", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  deleteInvite: (id: string) =>
    request<void>(`/admin/invites/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** 修改邀请码权限 / 可用次数（只影响之后注册的新账号） */
  updateInvite: (
    id: string,
    payload: { permissions?: Partial<Permissions> | null; maxUses?: number }
  ) =>
    request<{ invite: AdminInvite }>(
      `/admin/invites/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify(payload) }
    ),

  listReserved: () =>
    request<{ reserved: ReservedSubdomain[] }>("/admin/reserved-subdomains"),

  addReserved: (payload: { name: string; note?: string }) =>
    request<{ reserved: ReservedSubdomain[] }>("/admin/reserved-subdomains", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  removeReserved: (name: string) =>
    request<{ reserved: ReservedSubdomain[] }>(
      `/admin/reserved-subdomains/${encodeURIComponent(name)}`,
      { method: "DELETE" }
    ),

  getSettings: () => request<AdminSettings>("/admin/settings"),

  updateSettings: (payload: Record<string, string | number | boolean>) =>
    request<{ settings: Record<string, string>; mailSecrets: MailSecrets }>("/admin/settings", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  recalculateStorage: () =>
    request<{ accounts: number; totalBytes: number }>("/admin/storage/recalculate", {
      method: "POST",
    }),

  purgeStorage: (username: string) =>
    request<{ deleted: number }>(
      `/admin/storage/purge/${encodeURIComponent(username)}`,
      { method: "POST" }
    ),

  /**
   * 改单个用户的网盘配额（字节）。
   * `storage_accounts.quota_bytes` 是开通那一刻写死的快照 ⇒ 改桶的「每人配额」只影响之后新开通的人。
   */
  updateStorageQuota: (username: string, quotaBytes: number) =>
    request<{ quotaBytes: number; usedBytes: number; overQuota: boolean }>(
      `/admin/storage/quota/${encodeURIComponent(username)}`,
      { method: "PUT", body: JSON.stringify({ quotaBytes }) }
    ),

  /** 把存量用户的配额刷成「所属桶的每人配额」（没有桶归属则回落全局默认）；admin/root 会被跳过 */
  syncStorageQuota: () =>
    request<{
      updated: number
      skippedAdmins: number
      failed: number
      overQuota: number
      changed: { username: string; from: number; to: number; overQuota: boolean }[]
    }>("/admin/storage/sync-quota", { method: "POST" }),

  // frp 内网穿透
  listFrpApplications: (status = "pending") =>
    request<{ applications: AdminFrpApplication[] }>(
      `/admin/frp/applications?status=${encodeURIComponent(status)}`
    ),

  reviewFrp: (payload: { id: string; action: "approve" | "reject"; note?: string }) =>
    request<{ ok: boolean; status: string }>("/admin/frp/review", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  revokeFrp: (id: string) =>
    request<{ ok: boolean; status: string }>("/admin/frp/review-revoke", {
      method: "POST",
      body: JSON.stringify({ id }),
    }),

  listFrpNodes: () => request<{ nodes: AdminFrpNode[] }>("/admin/frp/nodes"),

  upsertFrpNode: (payload: Record<string, unknown>) =>
    request<{ id: string }>("/admin/frp/nodes", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  deleteFrpNode: (id: string) =>
    request<void>(`/admin/frp/nodes/${encodeURIComponent(id)}`, { method: "DELETE" }),

  releaseFrpPorts: (payload: { username: string; nodeId: string }) =>
    request<{ released: number }>("/admin/frp/ports/release", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  // 代理节点订阅源
  listProxySubscriptions: () =>
    request<{ subscriptions: AdminProxySubscription[] }>("/admin/proxy/subscriptions"),

  upsertProxySubscription: (payload: Record<string, unknown>) =>
    request<{ subscription: AdminProxySubscription }>("/admin/proxy/subscriptions", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  deleteProxySubscription: (id: string) =>
    request<void>(`/admin/proxy/subscriptions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  // 社区管理
  listCommunityPosts: (params?: { user?: string; includeDeleted?: boolean }) => {
    const sp = new URLSearchParams()
    if (params?.user) sp.set("user", params.user)
    if (params?.includeDeleted) sp.set("includeDeleted", "1")
    const qs = sp.toString()
    return request<{ posts: AdminCommunityPost[] }>(`/admin/community/posts${qs ? `?${qs}` : ""}`)
  },
  deleteCommunityPost: (id: string) =>
    request<{ ok: boolean }>(`/admin/community/posts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  restoreCommunityPost: (id: string) =>
    request<{ ok: boolean }>(`/admin/community/posts/${encodeURIComponent(id)}/restore`, { method: "POST" }),

  // 中转站管理员凭据（令牌轮换后可在网页上直接更新）
  getNewApiConfig: () => request<AdminNewApiConfig>("/admin/newapi/config"),

  updateNewApiConfig: (payload: { token: string; adminUserId?: string }) =>
    request<{
      ok: boolean
      source: AdminNewApiCredentialSource
      maskedToken: string | null
      adminUserId: string
      updatedAt: string | null
      /** 顺带修复的本站绑定条数（管理员令牌与 root 用户令牌在 NewAPI 侧是同一份） */
      healedAccounts: number
      message: string
    }>("/admin/newapi/config", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  /** 中转站全部模型名（推荐模型编辑器下拉用；失败返回空数组） */
  listNewApiModels: () => request<{ models: string[] }>("/admin/newapi/models"),

  /**
   * 对齐中转站账号的启用/禁用状态（服务端按「该不该有 ai 权限」自行判断方向）。
   *
   * 传 `username` 就只处理这一个用户 —— 全量会逐个用户调 NewAPI，
   * 线上 170+ 个账号直接撞 subrequest 上限，所以成员详情里一律带用户名调。
   */
  syncNewApiPermissions: (payload: { username: string }) =>
    request<{
      removedOrphans: number
      disabled: number
      enabled: number
      errors: string[]
      username: string | null
    }>("/admin/newapi/sync-permissions", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
}

// ---- 账户设置（真实邮箱验证 / 改名 / 改邮箱 / 通知开关）----

export const settingsApi = {
  getEmail: () => request<EmailSettings>("/settings/email"),

  /** action 省略 = 发起验证（发验证码）；confirm = 回填验证码；status = 查询状态 */
  verifyEmail: (action?: "status" | "confirm", code?: string) =>
    request<{ email: string; verified: boolean; message?: string }>(
      "/settings/email/verify",
      {
        method: "POST",
        body: JSON.stringify(
          action === "confirm" ? { action, code } : action ? { action } : {}
        ),
      }
    ),

  /** 修改真实邮箱：先 request 触发验证邮件，再 confirm 落库 */
  changeEmail: (payload: {
    email: string
    password: string
    action: "request" | "confirm"
  }) =>
    request<{ user: User; email?: string; verified?: boolean; message?: string }>(
      "/settings/email",
      { method: "PUT", body: JSON.stringify(payload) }
    ),

  setNotify: (payload: { enabled?: boolean; announcements?: boolean }) =>
    request<{ notifyEnabled: boolean; notifyAnnouncements: boolean }>(
      "/settings/notify",
      { method: "PUT", body: JSON.stringify(payload) }
    ),

  /** 修改用户名（需密码确认；网盘目录等不会自动迁移） */
  changeUsername: (payload: { username: string; password: string }) =>
    request<{ user: User; warnings: { note: string } }>("/settings/username", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  /** 注销前发送邮箱验证码（与密码一起做双重确认） */
  requestDeleteCode: () =>
    request<{ email: string; message: string }>("/settings/account/delete-code", {
      method: "POST",
    }),

  /** 自助注销账号（需密码 + 邮箱验证码双重确认，会回收外部资源并清除会话） */
  deleteAccount: (password: string, code: string) =>
    request<void>("/settings/account/delete", {
      method: "POST",
      body: JSON.stringify({ password, code }),
    }),
}

// ---- R2 直链网盘 ----

export const storageApi = {
  overview: () => request<StorageOverview>("/storage"),

  /** 开通网盘；必须传协议版本，服务端会校验是否已同意 */
  enable: (consentVersion: number) =>
    request<{ account: StorageAccount }>("/storage/enable", {
      method: "POST",
      body: JSON.stringify({ consent: true, consentVersion }),
    }),

  disable: () => request<{ ok: boolean }>("/storage/disable", { method: "POST" }),

  list: (cursor?: string) =>
    request<{
      objects: StorageObject[]
      cursor: string | null
      truncated: boolean
      usedBytes: number
      quotaBytes: number
    }>(
      cursor
        ? `/storage/objects?cursor=${encodeURIComponent(cursor)}`
        : "/storage/objects"
    ),

  /** 申请预签名上传地址（浏览器直传 R2，可显示真实上传进度） */
  uploadUrl: (payload: {
    filename: string
    size: number
    contentType?: string
  }) =>
    request<{
      uploadUrl: string
      key: string
      filename: string
      directLink: string
    }>("/storage/upload-url", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  /** 上传完成后登记（服务端以 R2 实际大小记账，不信任前端） */
  commit: (payload: { key: string; contentType?: string }) =>
    request<{
      object: { key: string; filename: string; size: number }
      usedBytes: number
      quotaBytes: number
    }>("/storage/commit", { method: "POST", body: JSON.stringify(payload) }),

  remove: (key: string) =>
    request<void>(`/storage/object?key=${encodeURIComponent(key)}`, {
      method: "DELETE",
    }),

  bindDomain: (subdomainId: string) =>
    request<{ prefix: StoragePrefixCreated }>("/storage/domain", {
      method: "POST",
      body: JSON.stringify({ subdomainId, action: "bind" }),
    }),

  unbindDomain: (id: string) =>
    request<{ ok: boolean }>("/storage/domain", {
      method: "POST",
      body: JSON.stringify({ subdomainId: id, action: "unbind" }),
    }),

  /** 设置默认分享前缀；传 null 恢复为 /dl/<用户名>/ */
  setDefaultPrefix: (prefixId: string | null) =>
    request<{ defaultPrefixId: string | null }>("/storage/default-prefix", {
      method: "POST",
      body: JSON.stringify({ prefixId }),
    }),
}

// ---- AI 中转站（NewAPI） ----

export const newapiApi = {
  status: () => request<NewApiStatus>("/dev/status"),

  /** 开通前探测：该用户名在中转站是否已存在 */
  preflight: () => request<NewApiPreflight>("/dev/preflight"),

  bind: (password: string) =>
    request<{ account: Record<string, unknown> }>("/dev/bind", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),

  sync: () =>
    request<{ account: Record<string, unknown> }>("/dev/sync", { method: "POST" }),

  listKeys: () => request<{ keys: NewApiKey[] }>("/dev/keys"),

  syncKeys: () =>
    request<{ added: number; keys: NewApiKey[] }>("/dev/keys/sync", {
      method: "POST",
    }),

  /** 创建 Key —— 完整 key 只在这条响应里返回，之后无法再取回 */
  createKey: (name: string, group?: string) =>
    request<{ key: NewApiKey & { fullKey: string } }>("/dev/key", {
      method: "POST",
      body: JSON.stringify({ name, group }),
    }),

  /** 用兑换码（邀请码）充值额度 */
  redeem: (code: string) =>
    request<{
      added: number
      addedDisplay: number
      currencySymbol: string
      quota: number
      message: string
    }>("/dev/redeem", { method: "POST", body: JSON.stringify({ code }) }),

  /** 领取免费订阅（免费套餐，周期发放额度） */
  subscribe: () =>
    request<{ message: string }>("/dev/subscribe", { method: "POST" }),

  /** 修改中转站密码 */
  changePassword: (payload: { currentPassword: string; newPassword: string }) =>
    request<{ ok: boolean; message: string }>("/dev/password", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  removeKey: (id: string) =>
    request<void>(`/dev/key/${encodeURIComponent(id)}`, { method: "DELETE" }),
}

// ---- 临时分享箱 ----

export const tempboxApi = {
  config: () => request<TempboxConfig>("/tempbox/config"),

  /** 创建批次；传 text 时为纯文本互传（文字存 D1，不走 R2） */
  create: (text?: string) =>
    request<TempboxCreated>("/tempbox/create", {
      method: "POST",
      body: JSON.stringify({ text: text ?? "" }),
    }),

  get: (code: string) =>
    request<TempboxBatch>(`/tempbox/${encodeURIComponent(code)}`),

  /** 申请预签名上传地址（浏览器直传 R2） */
  uploadUrl: (code: string, filename: string, size: number) =>
    request<{ uploadUrl: string; key: string; filename: string; code: string }>(
      `/tempbox/${encodeURIComponent(code)}/upload-url`,
      { method: "POST", body: JSON.stringify({ filename, size }) }
    ),

  commit: (code: string, key: string) =>
    request<{ filename: string; size: number; fileCount: number; totalBytes: number }>(
      `/tempbox/${encodeURIComponent(code)}/commit`,
      { method: "POST", body: JSON.stringify({ key }) }
    ),

  remove: (code: string) =>
    request<void>(`/tempbox/${encodeURIComponent(code)}`, { method: "DELETE" }),
}

// ---- frp 内网穿透 ----

export const frpApi = {
  overview: () => request<FrpOverview>("/frp"),

  enable: () =>
    request<{ activated: boolean }>("/frp/enable", { method: "POST" }),

  disable: () =>
    request<{ activated: boolean }>("/frp/disable", { method: "POST" }),

  apply: (payload: {
    nodeId: string
    frpUser: string
    frpPassword: string
    ports: number[]
    tunnels: { name: string; type: string; localIP: string; localPort: number; remotePort: number }[]
    notifyEmail: string
    remark?: string
  }) =>
    request<{ application: { id: string; status: string; createdAt: string } }>(
      "/frp/apply",
      { method: "POST", body: JSON.stringify(payload) }
    ),

  cancel: (id: string) =>
    request<void>("/frp/cancel", { method: "POST", body: JSON.stringify({ id }) }),
}

// ---- 代理节点 ----

export const proxyApi = {
  overview: () => request<ProxyOverview>("/proxy"),

  /** 启用（须携带同意标记 + 协议版本） */
  enable: (consentVersion: number) =>
    request<{ activated: boolean }>("/proxy/enable", {
      method: "POST",
      body: JSON.stringify({ consent: true, consentVersion }),
    }),

  disable: () =>
    request<{ activated: boolean }>("/proxy/disable", { method: "POST" }),

  /**
   * 获取某个订阅源的**原始链接**（内嵌机场服务商的订阅 token）。
   *
   * ⚠️ 列表接口 `overview()` 不再下发 url，必须显式调这个接口拿，
   * 服务端按用户限流（每天 3 次），返回 `remaining` 供界面提示。
   */
  revealSubscription: (id: string) =>
    request<{ id: string; url: string; remaining: number }>(
      `/proxy/subscriptions/${encodeURIComponent(id)}/reveal`,
      { method: "POST" }
    ),

  /** 对**订阅地址**做探活测延迟（不是节点） */
  check: (id: string) =>
    request<{ latencyMs: number | null; ok: boolean; message?: string }>(
      "/proxy/check",
      { method: "POST", body: JSON.stringify({ id }) }
    ),

  /**
   * 对订阅里的**逐个节点**测延迟（服务端做 TCP 握手）。
   *
   * 一次只能测一批：Cloudflare 限制每次请求最多 6 个并发连接，
   * 所以服务端每次最多测十几个，前端按 `offset` 循环调用。
   */
  latency: (id: string, offset = 0, limit = 16) =>
    request<ProxyLatencyBatch>("/proxy/latency", {
      method: "POST",
      body: JSON.stringify({ id, offset, limit }),
    }),
}

// ---- Email（收件箱） ----

export const emailApi = {
  list: () =>
    request<{
      mailboxes: Mailbox[]
      limit: number
      /** 临时邮箱的独立额度（与 limit 互不占用） */
      tempLimit: number
      tempUsed: number
    }>("/mailbox"),

  create: (payload: { localPart: string }) =>
    request<{ mailbox: Mailbox }>("/mailbox", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  /** 生成一个临时邮箱（随机地址，独立额度，不支持转发） */
  createTemp: () => request<{ mailbox: Mailbox }>("/mailbox/temp", { method: "POST" }),

  /** 换一个临时邮箱地址：旧地址立即作废，其收到的邮件随之清除 */
  refreshTemp: (id: string) =>
    request<{ mailbox: Mailbox }>(`/mailbox/temp/${id}/refresh`, { method: "POST" }),

  updateForwarding: (id: string, forwardingTo: string[]) =>
    request<{
      mailbox: Mailbox
      forwardingStatus: { email: string; verified: boolean }[]
    }>(`/mailbox/${id}`, {
      method: "PUT",
      body: JSON.stringify({ forwardingTo }),
    }),

  /** 发起 / 确认转发目标验证（action 省略=发验证码，confirm=回填） */
  verifyForwardTarget: (email: string, action?: "confirm", code?: string) =>
    request<{ email: string; verified: boolean; message?: string }>(
      "/mailbox/forward-verify",
      {
        method: "POST",
        body: JSON.stringify(
          action === "confirm" ? { email, action, code } : { email }
        ),
      }
    ),

  remove: (id: string) =>
    request<void>(`/mailbox/${id}`, { method: "DELETE" }),

  // M16：邮件列表改为游标分页。不传 cursor 时行为与修复前一致（第一页 100 条），
  // 但会额外返回 nextCursor —— 非 null 表示还有更旧的邮件可以继续取。
  //   limit：收件箱轮询时传个小值（只关心「有没有新邮件」），不传则后端默认 100。
  listMessages: (mailboxId: string, cursor?: string | null, limit?: number) => {
    const qs = new URLSearchParams()
    if (cursor) qs.set("cursor", cursor)
    if (limit) qs.set("limit", String(limit))
    const query = qs.toString()
    return request<{ messages: MailMessage[]; nextCursor: string | null }>(
      `/mailbox/${mailboxId}/messages${query ? `?${query}` : ""}`
    )
  },

  getMessage: (mailboxId: string, messageId: string) =>
    request<{ message: MailMessage }>(`/mailbox/${mailboxId}/messages/${messageId}`),

  markRead: (mailboxId: string, messageId: string, read: boolean) =>
    request<void>(`/mailbox/${mailboxId}/messages/${messageId}/read`, {
      method: "POST",
      body: JSON.stringify({ read }),
    }),

  /** 一键全部已读：把该用户所有 mailbox 的未读标已读 */
  markAllRead: () =>
    request<{ updated: number }>("/mailbox/read-all", { method: "POST" }),

  deleteMessage: (mailboxId: string, messageId: string) =>
    request<void>(`/mailbox/${mailboxId}/messages/${messageId}`, {
      method: "DELETE",
    }),

  /**
   * 以用户自己的域名邮箱身份回信。
   * 收件人与发件人都由服务端从原邮件 / 邮箱归属推导，前端**不传**收件人，
   * 避免这个接口被当成开放中继使用。
   */
  reply: (mailboxId: string, messageId: string, text: string) =>
    request<{ ok: boolean; to: string; subject: string; messageId: string | null }>(
      `/mailbox/${mailboxId}/messages/${messageId}/reply`,
      { method: "POST", body: JSON.stringify({ text }) }
    ),
}

// ---- 个人名片 ----

export const profileApi = {
  get: () => request<ProfileOverview>("/profile"),

  /** 开通名片（与网盘/中转站一致：点击开通才创建记录） */
  enable: () =>
    request<{ enabled: boolean; published?: boolean; slug?: string }>("/profile/enable", {
      method: "POST",
    }),

  update: (payload: Partial<{
    slug: string
    displayName: string
    bio: string
    avatarUrl: string
    backgroundUrl: string
    musicUrl: string
    musicTitle: string
    musicAutoplay: boolean
    theme: string
    accent: string
    effects: string[]
    intro: string
    font: string
    cjkFont: string
    layout: string
    musicCoverUrl: string
    /** 搜索来的音乐来源标记（'netease:<id>'）；传空串表示改回自定义 */
    musicSource: string
    /** 歌词（LRC 文本） */
    musicLyrics: string
    contacts: ProfileContact[]
    modules: ProfileModule[]
  }>) =>
    request<{ profile: Profile }>("/profile", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  /** 实时预览：把未保存的表单渲染成公开页 HTML（不落库、不计访客数） */
  preview: (payload: Record<string, unknown>) =>
    request<{ html: string }>("/profile/preview", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  publish: (published: boolean) =>
    request<{ published: boolean }>("/profile/publish", {
      method: "POST",
      body: JSON.stringify({ published }),
    }),

  /**
   * 按歌名搜索歌曲（需登录 + 服务端限流）。
   *
   * 返回的候选项里**没有播放地址** —— 音频源给的是带时效签名的地址，
   * 只能由服务端在播放时实时解析。这里存下来的只能是 `source`。
   *
   * 搜索服务不可用时服务端返回 502，前端要区别于「没搜到」来提示。
   */
  searchMusic: (q: string) =>
    request<{ tracks: ProfileMusicTrack[] }>(
      `/profile/music/search?q=${encodeURIComponent(q)}`
    ),

  /**
   * 按「歌名 + 歌手」取歌词（LRC 文本）。
   *
   * 歌名和歌手直接来自 `searchMusic` 的结果 —— 歌词库与音频源是两套曲库，
   * 没有共同 id，只能靠这两个字段对上。取不到返回 null。
   */
  fetchLyrics: (title: string, artist: string) =>
    request<{ lyrics: string | null }>(
      `/profile/music/lyrics?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`
    ),

  /** 上传头像 / 背景 / 音乐 / 音乐封面 / 图片墙单张（原始字节直传，Content-Type 决定扩展名） */
  uploadAsset: async (
    kind: "avatar" | "background" | "music" | "music-cover" | "gallery",
    file: File
  ) => {
    const res = await fetch(`/api/profile/asset?kind=${kind}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      throw new HttpError(
        res.status,
        (data as ApiError | null)?.error ?? `上传失败 (${res.status})`,
        (data as ApiError | null)?.code
      )
    }
    // gallery 额外返回 { id, url }，其余只返回 { key, kind }
    return data as { key: string; kind: string; id?: string; url?: string }
  },

  deleteAsset: (kind: "avatar" | "background" | "music" | "music-cover") =>
    request<{ ok: boolean }>(`/profile/asset?kind=${kind}`, { method: "DELETE" }),

  bindDomain: (subdomainId: string) =>
    request<{ fqdn: string; dnsCreated: boolean }>("/profile/domain", {
      method: "POST",
      body: JSON.stringify({ subdomainId, action: "bind" }),
    }),

  unbindDomain: () =>
    request<{ ok: boolean }>("/profile/domain", {
      method: "POST",
      body: JSON.stringify({ action: "unbind" }),
    }),
}

// ---- 捐献 ----

export const donationApi = {
  list: () => request<DonationOverview>("/donations"),

  create: (payload: {
    type: "ai" | "frp" | "proxy" | "sensenova"
    payload: unknown
    remark?: string
  }) =>
    request<DonationSubmitResult>("/donations", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  /**
   * 探测 AI 捐献的上游，取回可选模型列表。
   * 服务端会真的去请求该地址的 `/v1/models`，所以它同时也是「地址与密钥是否可用」的校验。
   * `format` 控制按哪种接口格式探测：auto 两种都试，也可强制只试其中一种
   * （上游可能只实现了 Anthropic 原生接口，OpenAI 格式必然失败）。
   */
  probeAi: (payload: { baseUrl: string; apiKey: string; format?: string }) =>
    request<AiProbeResult>("/donations/ai/probe", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  cancel: (id: string) =>
    request<void>(`/donations/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** 管理端：全部申请（含完整 payload，管理页核验资源用） */
  listAll: () =>
    request<{ donations: Donation[]; typeLabels: Record<string, string> }>(
      "/admin/donations"
    ),

  review: (id: string, action: "approve" | "reject", note?: string) =>
    request<{ ok: boolean; status: string }>("/admin/donations/review", {
      method: "POST",
      body: JSON.stringify({ id, action, note }),
    }),

  revoke: (id: string) =>
    request<{
      ok: boolean
      revokedPermission: boolean
      releasedChannel?: boolean
      /**
       * 商汤通道：说明有没有真的从渠道里摘掉那把 Key。
       * 关键信息 —— 它是共享渠道，摘不掉时要提示管理员手工处理。
       */
      releaseMessage?: string | null
      /** 撤销代理捐献时移出节点池的订阅源数量 */
      releasedSubscriptions?: number
    }>(`/admin/donations/${encodeURIComponent(id)}/revoke`, { method: "POST" }),

  /**
   * 人工复核：用同一份 payload 重试把 AI 捐献的渠道接进中转站。
   * 不改单据状态 —— 放行与否仍由 `review` 决定。
   */
  provision: (id: string) =>
    request<DonationProvisionResult>(
      `/admin/donations/${encodeURIComponent(id)}/provision`,
      { method: "POST" }
    ),

  /**
   * 重试该单里「没通过测试」的模型（限流/超时的可能已恢复）。
   * 与定时任务跑同一逻辑，只是限定在本单且忽略退避时间。
   */
  retryModels: (id: string) =>
    request<{
      ok: boolean
      recovered: string[]
      stillUncertain: number
      exhausted: number
      message: string
      detail: string
    }>(`/admin/donations/${encodeURIComponent(id)}/retry-models`, { method: "POST" }),

  /**
   * 重新拉取上游模型列表，把渠道里缺的模型补上。
   * 用于救「失败模型没落库」的历史单（那时模型名只留在 review_note 文本里）。
   */
  refetchModels: (id: string) =>
    request<{
      ok: boolean
      added: string[]
      stillMissing: { model: string; reason: string }[]
      message: string
    }>(`/admin/donations/${encodeURIComponent(id)}/refetch-models`, { method: "POST" }),
}

// ---- 权限兑换码 ----

export const voucherApi = {
  /** 我持有的未使用券 + 可选模块（含是否已拥有） */
  list: () => request<VoucherOverview>("/vouchers"),

  /**
   * 兑换。`code` 既可以是券码，也可以是别人给的邀请码
   * （服务端先当券查、再当邀请码查）；`feature` 只在「自选券」时需要。
   */
  redeem: (payload: { code: string; feature?: string }) =>
    request<RedeemResult>("/vouchers/redeem", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
}

// ---- WorkBuddy 反代账号捐献（登录即解锁 AI 权限，免审核）----

export const wb2apiApi = {
  /** 通道状态 + 当前用户的绑定列表 */
  status: () => request<Wb2ApiStatus>("/wb2api/status"),

  /**
   * 发起登录，拿到授权链接。
   * 服务端强制要求 acknowledged=true —— 它是「用户已被明确告知账号会进共享池」的证据。
   */
  /**
   * 发起登录。
   * `realm` 是用户自选的上游域：'cn' 国内版 / 'global' 国际版；不传则用管理员设的默认。
   */
  loginStart: (realm?: "cn" | "global") =>
    request<Wb2ApiLoginStart>("/wb2api/login/start", {
      method: "POST",
      body: JSON.stringify(realm ? { acknowledged: true, realm } : { acknowledged: true }),
    }),

  /** 轮询登录结果（前端每 3 秒调一次） */
  loginPoll: (sessionId: string) =>
    request<Wb2ApiLoginPoll>(
      `/wb2api/login/poll?session=${encodeURIComponent(sessionId)}`
    ),

  // 管理端
  listBindings: () =>
    request<{ bindings: AdminWb2ApiBinding[] }>("/admin/wb2api/bindings"),

  /**
   * 摘掉一个绑定。`revokeAi` 省略时由服务端按「有其他依据就保留」自动判定；
   * 显式传布尔值可覆盖（用于处理邀请码那种无法溯源的情况）。
   */
  removeBinding: (id: string, revokeAi?: boolean) =>
    request<{ ok: boolean; aiRevoked: boolean; upstreamWarning: string | null }>(
      `/admin/wb2api/bindings/${encodeURIComponent(id)}/remove`,
      {
        method: "POST",
        body: JSON.stringify(revokeAi === undefined ? {} : { revokeAi }),
      }
    ),

  getConfig: () => request<AdminWb2ApiConfig>("/admin/wb2api/config"),

  saveConfig: (apiKey: string) =>
    request<{ ok: boolean; message: string }>("/admin/wb2api/config", {
      method: "PUT",
      body: JSON.stringify({ apiKey }),
    }),

  getPool: () => request<{ pool: AdminWb2ApiPool }>("/admin/wb2api/pool"),
}

// ---- CLI2API 反代账号捐献（第二条，登录即解锁 AI 权限，免审核）----

export const cli2apiApi = {
  /** 通道状态 + 当前用户的绑定列表 */
  status: () => request<Cli2ApiStatus>("/cli2api/status"),

  /** 发起登录（服务端建上游账号 + 落会话，立即返回 sessionId） */
  loginStart: () =>
    request<Cli2ApiLoginStart>("/cli2api/login/start", {
      method: "POST",
      body: JSON.stringify({ acknowledged: true }),
    }),

  /** 轮询登录结果（第一次会顺带返回授权链接） */
  loginPoll: (sessionId: string) =>
    request<Cli2ApiLoginPoll>(
      `/cli2api/login/poll?session=${encodeURIComponent(sessionId)}`
    ),

  // 管理端
  listBindings: () =>
    request<{ bindings: AdminCli2ApiBinding[] }>("/admin/cli2api/bindings"),

  removeBinding: (id: string, revokeAi?: boolean) =>
    request<{ ok: boolean; aiRevoked: boolean; upstreamWarning: string | null }>(
      `/admin/cli2api/bindings/${encodeURIComponent(id)}/remove`,
      {
        method: "POST",
        body: JSON.stringify(revokeAi === undefined ? {} : { revokeAi }),
      }
    ),

  getConfig: () => request<AdminCli2ApiConfig>("/admin/cli2api/config"),

  saveConfig: (consoleKey: string) =>
    request<{ ok: boolean }>("/admin/cli2api/config", {
      method: "PUT",
      body: JSON.stringify({ consoleKey }),
    }),

  getPool: () => request<AdminCli2ApiPool>("/admin/cli2api/pool"),
}

// ---- 公告 / 网站动态 ----

export const announcementApi = {
  /** 登录用户：最近 5 条公告（pinned 优先） */
  list: () => request<{ announcements: Announcement[] }>("/announcements"),

  // 管理端
  listAll: () =>
    request<{ announcements: Announcement[] }>("/admin/announcements"),

  create: (payload: {
    title: string
    body: string
    category?: string
    pinned?: boolean
    popupMode?: "none" | "once" | "every"
    notifyByEmail?: boolean
    /** draft=草稿；scheduled=定时发布（需 publishAt）；published=立即发布 */
    status?: AnnouncementStatus
    /** ISO 时间串，status=scheduled 时必填 */
    publishAt?: string | null
  }) =>
    // queued = 本次入队的收件人数；实际发送在后台分批进行，
    // 真实进度看 announcement 的 mailStatus / mailSent / mailTotal
    request<{ announcement: Announcement; queued?: number }>(
      "/admin/announcements",
      {
        method: "POST",
        body: JSON.stringify(payload),
      }
    ),

  update: (id: string, payload: Partial<{
    title: string
    body: string
    category: string
    pinned: boolean
    popupMode: "none" | "once" | "every"
    notifyByEmail?: boolean
    status?: AnnouncementStatus
    publishAt?: string | null
  }>) =>
    request<{ announcement: Announcement; queued?: number }>(
      `/admin/announcements/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify(payload) }
    ),

  remove: (id: string) =>
    request<{ ok: boolean }>(`/admin/announcements/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  /**
   * 重发该公告「失败」的邮件：把队列里 failed 的行重置为 pending 再跑一轮。
   * `emails` 可选 —— 传入时强制重发这些地址（哪怕是已标记成功的），
   * 用于「记录成功但实际没送到」的情况。
   */
  resendFailed: (id: string, emails?: string[]) =>
    request<{ requeued: number }>(
      `/admin/announcements/${encodeURIComponent(id)}/resend`,
      {
        method: "POST",
        ...(emails && emails.length > 0
          ? { body: JSON.stringify({ emails }) }
          : {}),
      }
    ),
}

// ---- 成就系统 ----

export const achievementApi = {
  list: () => request<AchievementsResponse>("/achievements"),
}

// ---- 积分（余额 / 流水 / 兑换中转站余额）----

export const pointsApi = {
  /** 余额 + 兑换配置 + 商城商品 + 我的订单 + 最近流水（一次拿齐整页数据） */
  overview: () => request<PointsOverview>("/points"),
  /** 用积分兑换中转站余额（每 1 积分值多少元由后台配置） */
  redeem: (points: number) =>
    request<PointsRedeemResult>("/points/redeem", {
      method: "POST",
      body: JSON.stringify({ points }),
    }),
  /** 用户间转账：只需自己（转出方）确认，凭对方用户名转过去 */
  transfer: (username: string, amount: number) =>
    request<{ ok: boolean; balance: number; to: string }>("/points/transfer", {
      method: "POST",
      body: JSON.stringify({ username, amount }),
    }),
  /** 购买商城里的某件商品（单价固定，积分在下单时立即扣除） */
  buy: (productId: string) =>
    request<{ order: PointOrder; balance: number }>("/points/shop/buy", {
      method: "POST",
      body: JSON.stringify({ productId }),
    }),

  // ---- 用户商城（自己上架 / 交付 / 确认收货）----

  /** 上架自己的商品（提交后进入待审核，通过后才会出现在「用户们的商城」里） */
  uploadProduct: (payload: UserProductPayload) =>
    request<{ product: PointProduct }>("/points/products", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  /** 改自己上架的商品（改完会重新进入待审核） */
  updateMyProduct: (id: string, payload: UserProductPayload) =>
    request<{ product: PointProduct }>(`/points/products/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  /** 删自己上架的商品（还有未交付订单时会被拒绝） */
  deleteMyProduct: (id: string) =>
    request<{ ok: boolean }>(`/points/products/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  /** 卖家：把订单标记为已交付（积分仍在托管，等买家确认收货） */
  sellerDeliver: (orderId: string) =>
    request<{ order: PointOrder }>(
      `/points/orders/${encodeURIComponent(orderId)}/deliver`,
      { method: "POST" }
    ),
  /** 买家：确认收货（把托管的积分结算给卖家） */
  confirmReceipt: (orderId: string) =>
    request<{ order: PointOrder }>(
      `/points/orders/${encodeURIComponent(orderId)}/confirm`,
      { method: "POST" }
    ),
}

// ---- 个人空间（公开主页）----

export const spaceApi = {
  /** 某个用户的空间详情（公开，无需登录） */
  get: (username: string) =>
    request<SpaceData>(`/space/${encodeURIComponent(username)}`),

  /** 头像悬浮卡片用的轻量摘要（每次划过都调，所以单开一个接口） */
  card: (username: string) =>
    request<SpaceCardData>(`/space/${encodeURIComponent(username)}/card`),

  /** 我自己的展示设置 */
  getMine: () => request<{ settings: MySpaceSettings }>("/my-space"),

  saveMine: (settings: MySpaceSettings) =>
    request<{ ok: boolean }>("/my-space", {
      method: "PUT",
      body: JSON.stringify(settings),
    }),
}

// ---- 我的邀请码（用户自助）----

export const myInviteApi = {
  list: () => request<MyInvitesOverview>("/my-invites"),

  /** features 省略 = 只含基础权限（个人名片），不消耗模块额度 */
  create: (payload: { code?: string; features?: string[] }) =>
    request<{ invite: MyInvite; quota: UserQuota }>("/my-invites", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  remove: (id: string) =>
    request<{ quota: UserQuota; refunded: boolean }>(
      `/my-invites/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    ),
}

// ---- 身份资料（昵称 / 头像）----

export const identityApi = {
  updateNickname: (nickname: string) =>
    request<{ nickname: string | null }>("/settings/nickname", {
      method: "PUT",
      body: JSON.stringify({ nickname }),
    }),

  uploadAvatar: (file: File) => {
    const headers = new Headers()
    headers.set("Content-Type", file.type)
    return request<{ key: string }>("/settings/avatar", {
      method: "POST",
      body: file,
      headers,
    })
  },

  deleteAvatar: () =>
    request<{ ok: boolean }>("/settings/avatar", { method: "DELETE" }),
}

// ---- R2 多桶管理（管理员） ----

export const r2AdminApi = {
  /** 桶列表 + 用量概览 + 各桶用户 */
  buckets: () => request<R2BucketsResponse>("/admin/r2/buckets"),

  /** 用全局 token 自动发现所有账户及其桶 */
  discover: () =>
    request<{
      available: boolean
      reason?: string
      accounts: {
        id: string
        name: string
        buckets: { name: string; createdAt: string | null; imported: boolean }[]
      }[]
    }>("/admin/r2/discover"),

  create: (payload: {
    id: string
    name: string
    accountId?: string
    endpoint: string
    bucketName: string
    accessKeyId: string
    secretAccessKey: string
    analyticsToken?: string
    maxUsers?: number
    quotaPerUser?: number
    sortOrder?: number
    /** 'user' = 用户网盘桶；'platform' = 平台数据桶 */
    kind?: string
  }) =>
    request<{ ok: boolean; id: string }>("/admin/r2/buckets", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  update: (id: string, payload: Partial<{
    name: string
    accountId: string
    endpoint: string
    bucketName: string
    accessKeyId: string
    secretAccessKey: string
    analyticsToken: string
    maxUsers: number
    quotaPerUser: number
    sortOrder: number
    enabled: boolean
    kind: string
  }>) =>
    request<{ ok: boolean }>(`/admin/r2/buckets/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  remove: (id: string) =>
    request<{ ok: boolean }>(`/admin/r2/buckets/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  test: (id: string) =>
    request<{ ok: boolean; message?: string; error?: string; objectCount?: number }>(
      `/admin/r2/buckets/${encodeURIComponent(id)}/test`,
      { method: "POST" }
    ),

  writeTest: (id: string) =>
    request<{ ok: boolean; message?: string; error?: string }>(
      `/admin/r2/buckets/${encodeURIComponent(id)}/write-test`,
      { method: "POST" }
    ),

  /** A/B 类操作数（未配置 Analytics 令牌时 configured:false） */
  operations: (id: string) =>
    request<R2Operations>(`/admin/r2/buckets/${encodeURIComponent(id)}/operations`),

  /** 改派用户到指定桶（bucketId 为空 = 回到默认桶） */
  assign: (username: string, bucketId: string) =>
    request<{ ok: boolean }>("/admin/r2/assign", {
      method: "PUT",
      body: JSON.stringify({ username, bucketId }),
    }),

  /** 把所有未分配桶的用户一次性迁入指定桶 */
  assignAll: (bucketId: string, force = false) =>
    request<{ ok: boolean; moved: number }>("/admin/r2/assign-all", {
      method: "PUT",
      body: JSON.stringify({ bucketId, force }),
    }),
}

// ---- 社区广场 ----

export const communityApi = {
  getConfig: () => request<{ guestAccess: boolean; enabled: boolean }>("/community/config"),
  listPosts: (cursor?: string) =>
    request<{ posts: Post[]; nextCursor: string | null }>(
      `/community/posts${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`
    ),
  getStats: () => request<CommunityStats>("/community/stats"),
  newPostsCount: () => request<{ count: number }>("/community/new-posts-count"),
  /** 记下「我刚打开过社区」—— 侧边栏新帖角标据此清零 */
  markSeen: () => request<{ ok: boolean }>("/community/seen", { method: "POST" }),
  getPost: (id: string) => request<{ post: Post }>(`/community/posts/${encodeURIComponent(id)}`),
  getComments: (id: string) =>
    request<{ comments: CommentNode[] }>(`/community/posts/${encodeURIComponent(id)}/comments`),
  createPost: (body: string, images: string[] = []) =>
    request<{ post: { id: string } }>("/community/posts", {
      method: "POST", body: JSON.stringify({ body, images }),
    }),
  uploadImage: (postId: string, file: File) => {
    const headers = new Headers()
    headers.set("Content-Type", file.type)
    return request<{ key: string }>(`/community/posts/${encodeURIComponent(postId)}/images`, {
      method: "POST", body: file, headers,
    })
  },
  toggleLike: (id: string) =>
    request<{ liked: boolean; likeCount: number }>(`/community/posts/${encodeURIComponent(id)}/like`, { method: "POST" }),
  share: (id: string) =>
    request<{ shareCount: number }>(`/community/posts/${encodeURIComponent(id)}/share`, { method: "POST" }),
  comment: (id: string, body: string, parentId?: string, replyToUserId?: string) =>
    request<{ comment: { id: string } }>(`/community/posts/${encodeURIComponent(id)}/comments`, {
      method: "POST", body: JSON.stringify({ body, parentId, replyToUserId }),
    }),
  deletePost: (id: string) => request<{ ok: boolean }>(`/community/posts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  updatePost: (id: string, body: string) =>
    request<{ ok: boolean; unchanged?: boolean; updatedAt?: string }>(`/community/posts/${encodeURIComponent(id)}`, {
      method: "PUT", body: JSON.stringify({ body }),
    }),
  listEdits: (id: string) =>
    request<{ edits: { editedAt: string }[] }>(`/community/posts/${encodeURIComponent(id)}/edits`),
  /** 链接预览：返回目标 URL 的标题/描述/图片（拿不到则 preview=null） */
  linkPreview: (url: string) =>
    request<{ preview: LinkPreview | null }>(`/community/link-preview?url=${encodeURIComponent(url)}`),
  // ⚠️ 2026-09-25：这里原本有一个 deleteComment(id) 调 DELETE /community/comments/:id，
  // 但**后端从来没有这个 handler**（handlers/community.ts 里没有 deleteComment），
  // 且前端没有任何组件引用它 —— 一个纯死方法，还会让 check-api-paths 门禁报警。
  // 已删除（见 worker/scripts/check-api-paths.mjs 的 KNOWN_GAPS）。
  // 将来要做「删除评论」，顺序必须是：先在后端加 handler（需定清权限：评论作者 /
  // 帖子作者 / 管理员分别能删什么）+ 路由 + 回归测试，再在这里加回客户端方法。
}

// ---- 网站统计（管理员）----

export const analyticsApi = {
  overview: (days = 7) =>
    request<AnalyticsOverview>(`/admin/analytics?days=${days}`),
  /** 用户数据分析：模块开通率、资源占用、捐献与社区活跃度 */
  users: (days = 30) =>
    request<UserAnalytics>(`/admin/analytics/users?days=${days}`),
}

// ---- 公共聊天室 ----

export const chatApi = {
  list: (after?: string) =>
    request<{ messages: ChatMessage[] }>(
      `/chat/messages${after ? `?after=${encodeURIComponent(after)}` : ""}`
    ),
  send: (body: string) =>
    request<{ message: ChatMessage }>("/chat/messages", {
      method: "POST",
      body: JSON.stringify({ body }),
    }),
  heartbeat: () => request<{ ok: boolean }>("/chat/heartbeat", { method: "POST" }),
  presence: () => request<{ online: ChatPresenceUser[] }>("/chat/presence"),
  /** 侧边栏「聊天室」角标：我看过之后的新消息数 */
  unreadCount: () => request<{ count: number }>("/chat/unread"),
  /** 记下「我刚打开过聊天室」—— 新消息角标据此清零 */
  markSeen: () => request<{ ok: boolean }>("/chat/seen", { method: "POST" }),
}

// ---- 角标汇总 ----

/**
 * 一次拿齐所有「需要注意」的计数：侧边栏（社区 / 聊天室 / 反馈 / 管理）
 * 与管理面板各栏目共用，避免为角标发一串小请求。
 * `admin` 对普通用户是 null。
 */
export const attentionApi = {
  get: () => request<AttentionCounts>("/attention"),
}

// ---- 通知 / 消息箱 ----

export const notificationApi = {
  /** 消息列表；category 可选（system/site/social/event），不传 = 全部 */
  list: (params?: { category?: MessageCategory; limit?: number }) => {
    const qs = new URLSearchParams()
    if (params?.category) qs.set("category", params.category)
    if (params?.limit) qs.set("limit", String(params.limit))
    const suffix = qs.toString() ? `?${qs.toString()}` : ""
    return request<{ notifications: Notification[] }>(`/notifications${suffix}`)
  },
  unreadCount: () =>
    request<{ count: number; byCategory: Record<MessageCategory, number> }>(
      "/notifications/unread-count"
    ),
  /**
   * 最新一条未读（没有则 null）。给网页侧的「零配置通知」轮询用：
   * 比拉整个列表轻，而且只关心「最新那一条」就够了。
   * lang 决定服务端拼出来的社交类标题是中文还是英文。
   */
  latest: (lang: string) =>
    request<{ id: string; title: string; body: string; link: string } | null>(
      `/notifications/latest?lang=${encodeURIComponent(lang)}`
    ),
  markRead: (ids?: string[], all?: boolean, category?: MessageCategory) =>
    request<{ ok: boolean }>("/notifications/read", {
      method: "POST",
      body: JSON.stringify({ ids, all, category }),
    }),
}

// ---- 活动 ----

export const eventApi = {
  list: () => request<{ events: EventItem[]; now: string }>("/events"),
  /** 单个活动（公开）：活动分享链接用；draft / scheduled 会 404 */
  get: (id: string) => request<{ event: EventItem }>(`/events/${encodeURIComponent(id)}`),
  /** 认证码活动必须带 code；其余活动 code 可省略 */
  /**
   * 领取活动奖励。
   *
   * `code` 用于「凭认证码」的活动，`github` 用于「点了 GitHub star」的活动 ——
   * 两者都只是**线索**，服务端一律重新核验，前端传什么都不信。
   */
  claim: (id: string, code?: string, github?: string) =>
    request<{ status: string; detail: string }>(
      `/events/${encodeURIComponent(id)}/claim`,
      {
        method: "POST",
        body: JSON.stringify({ code: code ?? "", github: github ?? "" }),
      }
    ),
}

export const adminEventApi = {
  list: () => request<{ events: EventItem[] }>("/admin/events"),
  create: (payload: EventPayload) =>
    request<{ event: EventItem; inserted: number }>("/admin/events", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  update: (id: string, payload: Partial<EventPayload>) =>
    request<{ event: EventItem; inserted: number }>(
      `/admin/events/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify(payload) }
    ),
  remove: (id: string) =>
    request<{ ok: boolean }>(`/admin/events/${encodeURIComponent(id)}`, { method: "DELETE" }),
  claims: (id: string) =>
    request<{ claims: EventClaim[] }>(`/admin/events/${encodeURIComponent(id)}/claims`),
  grant: (id: string, claimId: string, detail?: string) =>
    request<{ ok: boolean }>(
      `/admin/events/${encodeURIComponent(id)}/claims/${encodeURIComponent(claimId)}/grant`,
      { method: "POST", body: JSON.stringify({ detail }) }
    ),
  /** 抽奖开奖：从报名者里随机抽人发积分（已开过奖会返回 409） */
  draw: (id: string) =>
    request<{ ok: boolean; winners: number; distributed: number; participants: number; failed: number }>(
      `/admin/events/${encodeURIComponent(id)}/draw`,
      { method: "POST" }
    ),
}

/** 管理端积分接口 */
export const adminPointsApi = {
  /** 积分总览：用户列表（含 0 分用户）+ 全站汇总；query 可按用户名/昵称搜索 */
  list: (query?: string) =>
    request<AdminPointsOverview>(
      `/admin/points${query ? `?query=${encodeURIComponent(query)}` : ""}`
    ),
  /** 发放（delta>0）/ 扣减（delta<0）积分 */
  adjust: (payload: { username: string; delta: number; detail?: string }) =>
    request<{ balance: number }>("/admin/points/adjust", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  /** 某用户的积分流水 */
  history: (username: string) =>
    request<{ username: string; balance: number; transactions: PointTransaction[] }>(
      `/admin/points/${encodeURIComponent(username)}/history`
    ),

  // ---- 商城 ----

  /** 商城标签页一次拿齐：商品 + 订单 + 兑换配置（status 可选过滤订单） */
  shop: (status?: string) =>
    request<AdminShopData>(
      `/admin/points/shop${status ? `?status=${encodeURIComponent(status)}` : ""}`
    ),
  /**
   * 保存兑换开关 / 比例（每 1 积分 = ? 元）/ 每日上限 / 捐献奖励 / 邀请奖励。
   *
   * `donationRewards` 用 `{ 档位: 积分数 }` 提交（只提交要改的档位也行），
   * 返回的却是数组（带中文名与固定顺序）—— 见 DonationRewardItem 的说明。
   * `invitePoints` 同理：只提交要改的字段。
   */
  saveConfig: (payload: {
    enabled?: boolean
    yuanPerPoint?: number
    dailyLimit?: number
    donationRewards?: Record<string, number>
    donationDailyLimit?: number
    invitePoints?: Partial<InvitePointsConfig>
  }) =>
    request<{
      config: PointsConfig
      donationRewards: DonationRewardItem[]
      donationDailyLimit: number
      inviteConfig: InvitePointsConfig
    }>("/admin/points/config", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  /** 新建商品 */
  createProduct: (payload: PointProductPayload) =>
    request<{ product: PointProduct }>("/admin/points/products", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  /** 编辑商品（整条覆盖） */
  updateProduct: (id: string, payload: PointProductPayload) =>
    request<{ product: PointProduct }>(`/admin/points/products/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  /** 删除商品（历史订单保留快照，不受影响） */
  deleteProduct: (id: string) =>
    request<{ ok: boolean }>(`/admin/points/products/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  /** 把待发放的订单标记为已发放（只对官方商品订单有效） */
  deliverOrder: (id: string, note?: string) =>
    request<{ order: PointOrder }>(`/admin/points/orders/${encodeURIComponent(id)}/deliver`, {
      method: "POST",
      body: JSON.stringify({ note }),
    }),
  /** 审核用户上架的商品：approve=true 通过，false 拒绝 */
  reviewProduct: (id: string, approve: boolean, note?: string) =>
    request<{ product: PointProduct }>(
      `/admin/points/products/${encodeURIComponent(id)}/review`,
      { method: "POST", body: JSON.stringify({ approve, note }) }
    ),
  /** 强制结算用户商品订单（卖家已交付但买家一直不确认时用） */
  settleOrder: (id: string) =>
    request<{ order: PointOrder }>(`/admin/points/orders/${encodeURIComponent(id)}/settle`, {
      method: "POST",
    }),
  /** 取消订单并把积分退回买家（已结算的会先从卖家账上收回） */
  cancelOrder: (id: string, reason?: string) =>
    request<{ order: PointOrder }>(`/admin/points/orders/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
}

// ---- OAuth 授权服务器（Doulor Cloud 作为身份提供方）----
//
// 类型定义放在这里而不是 types/index.ts：本组接口自成一体，
// 也避免与同时改 types/index.ts 的另一处改动互相干扰。

/** 接入本站登录的第三方应用（管理端视角，不含任何密钥字段） */
export interface OAuthClient {
  id: string
  clientId: string
  name: string
  redirectUris: string[]
  scopes: string
  disabled: boolean
  ownerUserId: string | null
  createdAt: string
  updatedAt: string
}

/** 同意页展示信息 */
export interface OAuthAuthorizeContext {
  clientName: string
  clientId: string
  scopes: string[]
  alreadyGranted: boolean
}

/** 我授权过的应用 */
export interface OAuthGrant {
  clientId: string
  name: string
  scopes: string[]
  createdAt: string
}

/** 授权请求参数（同意页与 authorize 端点共用同一套参数名） */
export interface OAuthAuthorizeParams {
  client_id: string
  redirect_uri: string
  scope?: string | null
  state?: string | null
  response_type?: string | null
  code_challenge?: string | null
  code_challenge_method?: string | null
}

export const oauthApi = {
  /** 同意页：拉取「谁在申请什么权限」 */
  context: (params: OAuthAuthorizeParams) => {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v) q.set(k, String(v))
    }
    return request<OAuthAuthorizeContext>(`/oauth/authorize/context?${q.toString()}`)
  },

  /** 同意页：允许 / 拒绝。返回要跳去的地址（由前端自己跳，便于先清理临时状态） */
  decide: (params: OAuthAuthorizeParams & { approve: boolean }) =>
    request<{ redirectTo: string }>("/oauth/authorize/decision", {
      method: "POST",
      body: JSON.stringify(params),
    }),

  /** 我授权过的应用 */
  grants: () => request<{ grants: OAuthGrant[] }>("/oauth/grants"),

  /** 撤销对某个应用的授权（同时作废其令牌） */
  revoke: (clientId: string) =>
    request<{ ok: boolean }>(`/oauth/grants/${encodeURIComponent(clientId)}`, {
      method: "DELETE",
    }),
}

export const oauthAdminApi = {
  list: () => request<{ clients: OAuthClient[] }>("/admin/oauth/clients"),

  /**
   * 创建应用。⚠️ 返回的 `clientSecret` 明文**只此一次**，
   * 库里只存哈希，之后无法再取回（丢了只能重置）。
   */
  create: (payload: {
    name: string
    redirectUris: string[]
    scopes?: string
    allowHttp?: boolean
  }) =>
    request<{ client: OAuthClient; clientSecret: string }>("/admin/oauth/clients", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  update: (
    id: string,
    payload: {
      name?: string
      redirectUris?: string[]
      scopes?: string
      disabled?: boolean
      allowHttp?: boolean
    }
  ) =>
    request<{ client: OAuthClient | null }>(
      `/admin/oauth/clients/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify(payload) }
    ),

  /** 重置密钥，返回新的明文（同样只此一次） */
  resetSecret: (id: string) =>
    request<{ clientSecret: string }>(
      `/admin/oauth/clients/${encodeURIComponent(id)}/secret`,
      { method: "POST" }
    ),

  /** 删除应用（连带作废其全部令牌与授权记录） */
  remove: (id: string) =>
    request<{ ok: boolean }>(`/admin/oauth/clients/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
}

// ---- 用户反馈（私有工单）----

// ---- 管理审计时间线 ----

export const auditApi = {
  /** 管理员操作时间线（scope=admins 只看管理员操作，all 看全站审计；mgmt=1 只看管理面板操作） */
  list: (params: {
    scope?: "admins" | "all"
    mgmt?: boolean
    action?: string
    page?: number
  } = {}) => {
    const qs = new URLSearchParams()
    if (params.scope) qs.set("scope", params.scope)
    if (params.mgmt) qs.set("mgmt", "1")
    if (params.action) qs.set("action", params.action)
    qs.set("page", String(params.page ?? 1))
    return request<AdminAuditData>(`/admin/audit?${qs.toString()}`)
  },
}

export const feedbackApi = {
  /** 我提交过的反馈 + 分类/状态标签（标签文案由服务端下发，前端不硬编码） */
  list: () => request<FeedbackOverview>("/feedback"),

  create: (payload: { category: string; title: string; body: string; images?: string[] }) =>
    request<{ feedback: FeedbackOverview["feedback"][number] }>("/feedback", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  /** 上传一张反馈图片，返回 R2 key（提交/回复时把 key 数组一起带上） */
  uploadImage: (file: File) => {
    const headers = new Headers()
    headers.set("Content-Type", file.type)
    return request<{ key: string }>("/feedback/upload-image", {
      method: "POST",
      body: file,
      headers,
    })
  },

  /** 把我的全部未读回复标记为已读（进页面即调） */
  markRead: () => request<{ ok: boolean; updated: number }>("/feedback/read", {
    method: "POST",
  }),

  /** 用户对某条反馈追加回复（对话式） */
  replyMy: (payload: { id: string; reply: string; images?: string[] }) =>
    request<{ feedback: FeedbackItem }>("/feedback/reply", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  // 管理端
  listAll: (status?: string) =>
    request<AdminFeedbackOverview>(
      `/admin/feedback${status ? `?status=${encodeURIComponent(status)}` : ""}`
    ),

  /**
   * 回复一条反馈。
   *
   * `rewardPoints` > 0 时**顺手给作者发一笔积分奖励**（2026-10-01 加）：
   * 同一张反馈只会发一次（服务端按反馈 id 幂等），重复保存不会重复发，
   * 返回体里的 `reward.duplicated` 用于区分这一点。
   */
  reply: (payload: {
    id: string
    reply: string
    status?: string
    images?: string[]
    /** 附带的积分奖励；不填 / 0 = 不发 */
    rewardPoints?: number
  }) =>
    request<{
      feedback: AdminFeedbackItem
      reward: { amount: number; balance: number; duplicated: boolean } | null
    }>("/admin/feedback/reply", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  setStatus: (payload: { id: string; status: string }) =>
    request<{ ok: boolean; status: string }>("/admin/feedback/status", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  /** 删除一条反馈（连带其对话消息与上传图片，不可恢复） */
  remove: (id: string) =>
    request<{ ok: boolean; deletedImages: number }>("/admin/feedback/delete", {
      method: "POST",
      body: JSON.stringify({ id }),
    }),
}

// ---- 有趣的网页分享（工具箱里的精选外链）----
//
// 类型定义放在这里而不是 types/index.ts：与上面 OAuth 那段同样的理由 ——
// 这个模块自成一体，也避免与同时改 types/index.ts 的另一处改动互相干扰。

export interface FunLink {
  id: string
  title: string
  url: string
  description: string
  /** 分类短键，见 `@/lib/fun-links` 的 `FUN_LINK_CATEGORIES` */
  category: FunLinkCategory
  /** 原始图标地址（可能为空）。渲染时请走 `/api/fun-links/icon/:id` 代理，别直接用它 */
  iconUrl: string
  sortOrder: number
  /** false = 已下架（普通用户在工具箱里看不到） */
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface FunLinkInput {
  title: string
  url: string
  description?: string
  category?: FunLinkCategory
  iconUrl?: string
  sortOrder?: number
  enabled?: boolean
}

/** 自动识别网页信息的结果 */
export interface FunLinkProbe {
  title: string
  description: string
  iconUrl: string
  /** 跟随重定向后的最终地址，供前端提示「这个链接跳到了 X」 */
  finalUrl: string
}

/** 工具箱用：只回上架的 */
export const funLinksApi = {
  list: () => request<{ links: FunLink[] }>("/fun-links"),
}

/**
 * 图标的展示地址。
 *
 * 走本站代理而不是直接用条目里的 `iconUrl`：第三方图标可能是 http（会被浏览器
 * 按混合内容拦掉），也可能有防盗链，代理一层两个问题都没了。
 */
export function funLinkIconUrl(id: string): string {
  return `${BASE}/fun-links/icon/${encodeURIComponent(id)}`
}

/** 管理面板用：含已下架 */
export const adminFunLinksApi = {
  list: () => request<{ links: FunLink[] }>("/admin/fun-links"),
  create: (payload: FunLinkInput) =>
    request<{ link: FunLink }>("/admin/fun-links", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  update: (id: string, payload: Partial<FunLinkInput>) =>
    request<{ link: FunLink }>(`/admin/fun-links/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  remove: (id: string) =>
    request<{ ok: boolean }>(`/admin/fun-links/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  /** 自动识别：把链接丢给服务端去抓标题 / 描述 / 图标（可能耗时几秒） */
  probe: (url: string) =>
    request<FunLinkProbe>("/admin/fun-links/probe", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
}

// ---- 自定义称号（徽章式；管理面板创建 + 授予） ----

/** 某个称号的一名持有者 */
export interface AdminTitleHolder {
  userId: string
  username: string
  nickname: string | null
  role: string
  grantedAt: string
}

/** 管理视角的自定义称号（含持有者列表） */
export interface AdminTitle {
  id: string
  name: string
  colorFrom: string
  colorTo: string
  createdAt: string
  holders: AdminTitleHolder[]
}

export interface AdminTitleInput {
  name: string
  colorFrom: string
  colorTo: string
}

export const adminTitlesApi = {
  list: () => request<{ titles: AdminTitle[] }>("/admin/titles"),
  create: (payload: AdminTitleInput) =>
    request<{ title: AdminTitle }>("/admin/titles", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  update: (id: string, payload: Partial<AdminTitleInput>) =>
    request<{ ok: boolean }>(`/admin/titles/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  remove: (id: string) =>
    request<{ ok: boolean }>(`/admin/titles/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  /** 授予（覆盖式：用户已有的其它自定义称号会被顶掉——一人一称号） */
  grant: (id: string, username: string) =>
    request<{ ok: boolean }>(`/admin/titles/${encodeURIComponent(id)}/grant`, {
      method: "POST",
      body: JSON.stringify({ username }),
    }),
  /** 收回 */
  revoke: (id: string, username: string) =>
    request<{ ok: boolean }>(`/admin/titles/${encodeURIComponent(id)}/revoke`, {
      method: "POST",
      body: JSON.stringify({ username }),
    }),
}

/** App 端通知（给 WebToApp 打包的安卓 App 用的轮询令牌） */
export interface AppNotifyToken {
  token: string
  /** App 通知配置里要填的请求地址 */
  url: string
  /** 人类可读形式的请求头，方便直接抄 */
  header: string
  /** 同一份请求头的 JSON 形式（App 的「自定义 Headers」输入框要 JSON） */
  headerJson: string
}

export const appNotifyApi = {
  get: () => request<AppNotifyToken>("/app/notify-token"),
  rotate: () => request<AppNotifyToken>("/app/notify-token/rotate", { method: "POST" }),
}
