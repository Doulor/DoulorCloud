import {
  type AdminInvite,
  type AdminSettings,
  type AdminUser,
  type AdminUserDetail,
  type ApiError,
  type Announcement,
  type AchievementsResponse,
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
  type ProfileOverview,
  type R2BucketsResponse,
  type R2Operations,
  type ReservedSubdomain,
  type ProxyOverview,
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
} from "@/types"

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
}

// ---- DNS ----

export interface CreateDnsPayload {
  subdomainId?: string
  name: string
  type: DnsRecordType
  content: string
  ttl?: number
  proxied?: boolean
  priority?: number
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
    request<{ settings: Record<string, string> }>("/admin/settings", {
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
}

// ---- 账户设置（真实邮箱验证 / 改名 / 改邮箱 / 通知开关）----

export const settingsApi = {
  getEmail: () => request<EmailSettings>("/settings/email"),

  /** action 省略 = 发起验证；status = 查询状态（前端轮询） */
  verifyEmail: (action?: "status") =>
    request<{ email: string; verified: boolean; message?: string }>(
      "/settings/email/verify",
      { method: "POST", body: JSON.stringify(action ? { action } : {}) }
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

  setNotify: (enabled: boolean) =>
    request<{ notifyEnabled: boolean }>("/settings/notify", {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    }),

  /** 修改用户名（需密码确认；网盘目录等不会自动迁移） */
  changeUsername: (payload: { username: string; password: string }) =>
    request<{ user: User; warnings: { note: string } }>("/settings/username", {
      method: "PUT",
      body: JSON.stringify(payload),
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

  /** 对订阅源做探活测延迟 */
  check: (id: string) =>
    request<{ latencyMs: number | null; ok: boolean; message?: string }>(
      "/proxy/check",
      { method: "POST", body: JSON.stringify({ id }) }
    ),
}

// ---- Email（收件箱） ----

export const emailApi = {
  list: () => request<{ mailboxes: Mailbox[]; limit: number }>("/mailbox"),

  create: (payload: { localPart: string }) =>
    request<{ mailbox: Mailbox }>("/mailbox", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  updateForwarding: (id: string, forwardingTo: string[]) =>
    request<{
      mailbox: Mailbox
      forwardingStatus: { email: string; verified: boolean }[]
    }>(`/mailbox/${id}`, {
      method: "PUT",
      body: JSON.stringify({ forwardingTo }),
    }),

  remove: (id: string) =>
    request<void>(`/mailbox/${id}`, { method: "DELETE" }),

  listMessages: (mailboxId: string) =>
    request<{ messages: MailMessage[] }>(`/mailbox/${mailboxId}/messages`),

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
    request<{ enabled: boolean; slug?: string }>("/profile/enable", { method: "POST" }),

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
    type: "ai" | "frp" | "proxy"
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
  loginStart: () =>
    request<Wb2ApiLoginStart>("/wb2api/login/start", {
      method: "POST",
      body: JSON.stringify({ acknowledged: true }),
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
  }) =>
    request<{ announcement: Announcement }>("/admin/announcements", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  update: (id: string, payload: Partial<{
    title: string
    body: string
    category: string
    pinned: boolean
    popupMode: "none" | "once" | "every"
  }>) =>
    request<{ announcement: Announcement }>(
      `/admin/announcements/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify(payload) }
    ),

  remove: (id: string) =>
    request<{ ok: boolean }>(`/admin/announcements/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
}

// ---- 成就系统 ----

export const achievementApi = {
  list: () => request<AchievementsResponse>("/achievements"),
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
  deleteComment: (id: string) => request<{ ok: boolean }>(`/community/comments/${encodeURIComponent(id)}`, { method: "DELETE" }),
}

// ---- 网站统计（管理员）----

export const analyticsApi = {
  overview: (days = 7) =>
    request<AnalyticsOverview>(`/admin/analytics?days=${days}`),
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
}

// ---- 通知 ----

export const notificationApi = {
  list: () => request<{ notifications: Notification[] }>("/notifications"),
  unreadCount: () => request<{ count: number }>("/notifications/unread-count"),
  markRead: (ids?: string[], all?: boolean) =>
    request<{ ok: boolean }>("/notifications/read", { method: "POST", body: JSON.stringify({ ids, all }) }),
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
