import {
  type AdminInvite,
  type AdminSettings,
  type AdminUser,
  type AdminUserDetail,
  type ApiError,
  type DnsRecord,
  type DnsRecordType,
  type Mailbox,
  type EmailSettings,
  type MailMessage,
  type MeResponse,
  type NewApiKey,
  type NewApiPreflight,
  type NewApiStatus,
  type StorageAccount,
  type StorageObject,
  type StorageOverview,
  type StoragePrefixCreated,
  type Subdomain,
  type User,
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
  list: () => request<{ subdomains: Subdomain[]; limit: number }>("/subdomains"),

  create: (payload: { name: string }) =>
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

  updateUser: (username: string, payload: { status?: string; role?: string }) =>
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

  createInvite: (payload: { code: string; maxUses?: number }) =>
    request<{ invite: AdminInvite }>("/admin/invites", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  deleteInvite: (id: string) =>
    request<void>(`/admin/invites/${encodeURIComponent(id)}`, { method: "DELETE" }),

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

  enable: () =>
    request<{ account: StorageAccount }>("/storage/enable", { method: "POST" }),

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

  deleteMessage: (mailboxId: string, messageId: string) =>
    request<void>(`/mailbox/${mailboxId}/messages/${messageId}`, {
      method: "DELETE",
    }),
}
