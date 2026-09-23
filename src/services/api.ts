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
  type Notification,
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
  list: () => request<{ mailboxes: Mailbox[] }>("/mailbox"),

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
    layout: string
    musicCoverUrl: string
    contacts: ProfileContact[]
  }>) =>
    request<{ profile: Profile }>("/profile", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  publish: (published: boolean) =>
    request<{ published: boolean }>("/profile/publish", {
      method: "POST",
      body: JSON.stringify({ published }),
    }),

  /** 上传头像 / 背景 / 音乐 / 音乐封面（原始字节直传，Content-Type 决定扩展名） */
  uploadAsset: async (kind: "avatar" | "background" | "music" | "music-cover", file: File) => {
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
    return data as { key: string; kind: string }
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
    request<{ id: string; status: string }>("/donations", {
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
  listPosts: (cursor?: string) =>
    request<{ posts: Post[]; nextCursor: string | null }>(
      `/community/posts${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`
    ),
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
  deleteComment: (id: string) => request<{ ok: boolean }>(`/community/comments/${encodeURIComponent(id)}`, { method: "DELETE" }),
}

// ---- 通知 ----

export const notificationApi = {
  list: () => request<{ notifications: Notification[] }>("/notifications"),
  unreadCount: () => request<{ count: number }>("/notifications/unread-count"),
  markRead: (ids?: string[], all?: boolean) =>
    request<{ ok: boolean }>("/notifications/read", { method: "POST", body: JSON.stringify({ ids, all }) }),
}
