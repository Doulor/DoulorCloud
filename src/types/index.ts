export type DnsRecordType = "A" | "AAAA" | "CNAME" | "TXT" | "MX"

export interface User {
  id: string
  username: string
  email: string
  namespace: string
  role: "user" | "admin"
  /** 真实邮箱是否已验证（验证后才能作转发目标、接收通知） */
  emailVerified: boolean
  /** 是否接收站内通知邮件 */
  notifyEnabled: boolean
  createdAt: string
}

export interface Domain {
  id: string
  name: string
  status: "active" | "pending" | "suspended"
  createdAt: string
}

export interface Subdomain {
  id: string
  name: string
  fqdn: string
  status: "active" | "pending" | "error"
  createdAt: string
}

export interface DnsRecord {
  id: string
  subdomainId: string | null
  name: string
  fqdn: string
  type: DnsRecordType
  content: string
  ttl: number
  proxied: boolean
  priority?: number
  status: "active" | "pending" | "error"
  createdAt: string
  updatedAt: string
}

export interface Mailbox {
  id: string
  address: string
  primary: boolean
  forwardingTo: string[]
  /** true=已验证 false=待验证 null=状态未知 */
  forwardingVerified: (boolean | null)[]
  lastForwardedAt: string | null
  lastForwardError: string | null
  unread: number
  total: number
  createdAt: string
}

export interface MailMessage {
  id: string
  from: string
  subject: string
  body: string
  read: boolean
  receivedAt: string
}

export interface AuditLog {
  id: string
  action: string
  detail: string
  createdAt: string
}

export interface DashboardStats {
  domains: number
  subdomains: number
  emails: number
  unread: number
  dnsRecords: number
  mailboxes: number
  emailForwards: number
}

export interface RecentMessage {
  id: string
  from: string
  subject: string
  read: boolean
  receivedAt: string
}

export interface MeResponse {
  user: User
  domain: Domain
  stats: DashboardStats
  subdomainLimit?: number
  mailboxLimit?: number
  recentActivity: AuditLog[]
  recentMessages?: RecentMessage[]
}

export interface AdminUser {
  id: string
  username: string
  email: string
  namespace: string
  role: string
  status: string
  createdAt: string
  subdomainCount: number
  dnsCount: number
  mailboxCount: number
  mailCount: number
}

export interface AdminInvite {
  id: string
  code: string
  maxUses: number
  usedCount: number
  expiresAt: string | null
  createdAt: string
  createdBy: string | null
}

export interface AdminUserDetail {
  user: {
    id: string
    username: string
    email: string
    namespace: string
    role: string
    status: string
    createdAt: string
    updatedAt: string
  }
  subdomains: Subdomain[]
  dns: DnsRecord[]
  mailboxes: Mailbox[]
  messages: MailMessage[]
  sessions: { id: string; expires_at: string; created_at: string }[]
}

export interface ApiError {
  error: string
  code?: string
}

export const isApiError = (value: unknown): value is ApiError =>
  typeof value === "object" &&
  value !== null &&
  "error" in value &&
  typeof (value as ApiError).error === "string"

// ---- 账户设置 ----

export interface EmailSettings {
  email: string
  verified: boolean
  notifyEnabled: boolean
  canForwardToRealEmail: boolean
}

// ---- R2 直链网盘 ----

export interface StorageAccount {
  prefix: string
  quotaBytes: number
  usedBytes: number
  fileCount: number
  enabled: boolean
  defaultPrefixId: string | null
  createdAt: string
  directLinkBase: string
}

export interface StoragePrefix {
  id: string
  fqdn: string
  r2Prefix: string
  createdAt: string
}

export interface StoragePrefixCreated {
  fqdn: string
  r2Prefix: string
  /** 本次是否新建了解析记录（新建则需等待 DNS/证书生效） */
  dnsCreated?: boolean
}

export interface StorageObject {
  key: string
  filename: string
  size: number
  lastModified: string | null
  etag: string | null
}

export interface StorageOverview {
  configured: boolean
  featureEnabled: boolean
  customDomainSupported: boolean
  account: StorageAccount | null
  defaultQuotaBytes: number
  maxFileBytes: number
  prefixes: StoragePrefix[]
  /** 默认分享前缀；null 表示用 /dl/<用户名>/ */
  defaultPrefix: StoragePrefix | null
  /** 可直接复制的分享基址（由服务端按默认前缀算好） */
  shareBase: string | null
  availableSubdomains: { id: string; name: string; fqdn: string }[]
}

// ---- AI 中转站（NewAPI）----

export interface NewApiAccount {
  newapiUserId: number
  username: string
  email: string
  quota: number
  usedQuota: number
  requestCount: number
  quotaUsd: number
  usedUsd: number
  group: string | null
  syncedAt: string | null
}

export interface NewApiStatus {
  configured: boolean
  featureEnabled: boolean
  eligibleEmail: string
  /** 展示币种（跟随 NewAPI 站点设置，本实例为 ¥） */
  currencySymbol: string
  currencyCode: string
  trialQuotaUsd: number
  group: string
  account: NewApiAccount | null
  models: string[]
}

export interface NewApiKey {
  id: string
  tokenId: number
  name: string
  maskedKey: string
  createdAt: string
}

// ---- 管理员全局设置 ----

export interface AdminSettings {
  settings: Record<string, string>
  currency: { symbol: string; code: string }
  stats: {
    storageAccounts: number
    storageUsedBytes: number
    storageQuotaBytes: number
    storageObjects: number
    newapiAccounts: number
    newapiKeys: number
  }
}