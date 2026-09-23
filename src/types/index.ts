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
  /** 功能权限 */
  permissions: Permissions
  /** 中文昵称（未设置时为 null） */
  nickname: string | null
  /** 是否设置了头像 */
  hasAvatar: boolean
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
  /** null = 一级子域名；否则为父级 id（构成子子域名层级） */
  parentId?: string | null
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
  // 网盘（概览用量卡用；未开通时 usedBytes=0、quotaBytes=0）
  storageUsedBytes: number
  storageQuotaBytes: number
}

export interface RecentStorageFile {
  id: string
  filename: string
  r2Key: string
  size: number
  createdAt: string
}

export interface Announcement {
  id: string
  title: string
  body: string
  category: string
  pinned: boolean
  createdAt: string
}

export interface RecentMessage {
  id: string
  from: string
  subject: string
  read: boolean
  receivedAt: string
  mailboxId: string
}

export interface MeResponse {
  user: User
  domain: Domain
  stats: DashboardStats
  subdomainLimit?: number
  mailboxLimit?: number
  recentActivity: AuditLog[]
  recentMessages?: RecentMessage[]
  recentStorageFiles?: RecentStorageFile[]
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
  permissions: Permissions
}

export interface AdminInvite {
  id: string
  code: string
  maxUses: number
  usedCount: number
  expiresAt: string | null
  permissions: Permissions
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
    permissions: Permissions
    /** 用户级子域名配额覆盖；null = 用全局默认 */
    maxSubdomains: number | null
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
  /** 前端内嵌协议文本的版本 */
  consentVersion: number
  /** 已同意的协议版本；0 = 从未同意（或老账号） */
  consentedVersion: number
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

export interface NewApiHealth {
  online: boolean
  /** 探测耗时（毫秒）；离线时为 -1 */
  latencyMs: number
  version: string | null
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
  /** 可用分组（默认分组在前） */
  availableGroups: string[]
  /** 分组 → 该分组可用模型 */
  groupModels: Record<string, string[]>
  /** 账号当前所属分组 */
  accountGroup: string | null
  /** 中转站健康状态（在线/离线 + 延迟 + 版本） */
  health: NewApiHealth
}

export interface NewApiKey {
  id: string
  tokenId: number
  name: string
  maskedKey: string
  createdAt: string
  group?: string
}

/** 开通前探测：决定展示「绑定已有账号」还是「创建新账号」 */
export interface NewApiPreflight {
  featureEnabled: boolean
  username: string
  eligibleEmail: string
  /** 中转站是否已存在同名账号 */
  exists: boolean
  /** 主邮箱是否存在（新账号注册需收验证码） */
  hasMailbox: boolean
}

// ---- frp 内网穿透 ----

export type FrpNodeStatus = "online" | "offline" | "maintenance" | "unknown"

export interface FrpNode {
  id: string
  name: string
  region: string | null
  serverAddr: string
  serverPort: number
  portMin: number
  portMax: number
  maxPorts: number
  enabled: boolean
  note: string | null
  /** 节点状态（管理员手动维护；见 HANDOFF 中「为什么不做自动探测」） */
  status: FrpNodeStatus
  statusNote: string | null
  statusUpdatedAt: string | null
}

export interface FrpTunnel {
  name: string
  type: "tcp" | "udp"
  localIP: string
  localPort: number
  remotePort: number
}

export interface FrpApplication {
  id: string
  nodeId: string
  frpUser: string
  /** 申请时填写的密码；即 config.toml 里的 metadatas.token */
  frpPassword: string
  ports: number[]
  tunnels: FrpTunnel[]
  notifyEmail: string
  remark: string | null
  status: "pending" | "approved" | "rejected"
  reviewNote: string | null
  reviewedAt: string | null
  createdAt: string
  /**
   * 节点的 frps 共享密钥（config 里的 auth.token）；
   * 仅本人的「已通过」申请会下发。
   * 注意：config 里的 metadatas.token 就是申请时填的密码（frpPassword），无需另存。
   */
  configAuthToken: string | null
}

export interface FrpOverview {
  featureEnabled: boolean
  /** 用户是否已手动启用（启用后才显示节点与申请入口） */
  activated: boolean
  coreUrl: string
  nodes: FrpNode[]
  applications: FrpApplication[]
  myPorts: Record<string, number[]>
  takenPorts: Record<string, number[]>
  notifyOptions: { email: string; kind: "site" | "real" }[]
}

/** 管理端申请（含密码） */
export interface AdminFrpApplication extends FrpApplication {
  siteUsername: string
  nodeName: string
  frpPassword: string
}

export interface AdminFrpNode extends FrpNode {
  authToken: string
  usedPorts: number
}

// ---- 功能权限 ----

export type FeatureKey = "r2" | "ai" | "frp" | "profile" | "proxy"

export interface Permissions {
  r2: boolean
  ai: boolean
  frp: boolean
  profile: boolean
  proxy: boolean
}

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  r2: "直链网盘",
  ai: "AI 中转站",
  frp: "内网穿透",
  profile: "个人名片",
  proxy: "代理节点",
}

// ---- 管理员全局设置 ----

export interface AdminSettings {
  settings: Record<string, string>
  currency: { symbol: string; code: string }
  /** 可作为「管理员通知邮箱」的候选项 */
  notifyEmailOptions: string[]
  stats: {
    storageAccounts: number
    storageUsedBytes: number
    storageQuotaBytes: number
    storageObjects: number
    newapiAccounts: number
    newapiKeys: number
  }
}
// ---- 个人名片 ----

export type ContactType =
  | "email"
  | "qq"
  | "wechat"
  | "bilibili"
  | "discord"
  | "telegram"
  | "youtube"
  | "github"
  | "x"
  | "custom"

export interface ProfileContact {
  type: ContactType
  value: string
  label?: string
  visible?: boolean
}

export interface Profile {
  slug: string
  published: boolean
  displayName: string | null
  bio: string | null
  avatarKey: string | null
  avatarUrl: string | null
  backgroundKey: string | null
  backgroundUrl: string | null
  musicKey: string | null
  musicUrl: string | null
  musicTitle: string | null
  musicAutoplay: boolean
  musicCoverKey: string | null
  musicCoverUrl: string | null
  theme: string
  accent: string | null
  effects: string[]
  intro: string
  font: string
  layout: string
  contacts: ProfileContact[]
  subdomainId: string | null
  fqdn: string | null
  profilePath: string
  updatedAt: string
}

export interface ProfileOption {
  id: string
  label: string
  desc: string
}

export interface ProfileOverview {
  /** 是否已开通名片（未开通时 profile 为 null，前端显示开通引导页） */
  enabled: boolean
  profile: Profile | null
  availableSubdomains: { id: string; name: string; fqdn: string }[]
  themes: string[]
  effects: string[]
  intros: string[]
  fonts: string[]
  layouts: string[]
  themeOptions: ProfileOption[]
  effectOptions: ProfileOption[]
  introOptions: ProfileOption[]
  fontOptions: ProfileOption[]
  layoutOptions: ProfileOption[]
  contactTypes: ContactType[]
  r2Configured: boolean
  limits: { avatar: number; background: number; music: number }
}

// ---- 成就系统 ----

export interface AchievementProgress {
  id: string
  name: string
  desc: string
  /** 图标标识，前端映射成 lucide 图标 */
  icon: string
  /** 获取途径 */
  how: string
  /** 是否单级成就 */
  single: boolean
  /** 分级成就的阈值与等级名 */
  tiers?: number[]
  tierNames?: string[]
  tierReqs?: string[]
  /** 当前进度值 */
  value: number
  /** 已达成的等级数（0 = 未解锁） */
  level: number
  /** 是否完全达成（最高级） */
  maxed: boolean
  /** 下一等级阈值（无则 null） */
  nextTier: number | null
  /** 首次解锁时间（未解锁为 null） */
  unlockedAt: string | null
  /** 各等级的解锁时间（索引 = 等级-1，未解锁为 null） */
  unlockedLevels: (string | null)[]
}

export interface AchievementsResponse {
  achievements: AchievementProgress[]
  summary: { unlocked: number; total: number }
  registeredAt: string | null
}

// ---- 代理节点 ----

export type ProxyNodeStatus = "online" | "offline" | "maintenance" | "unknown"

/** 解析后的单个代理节点 */
export interface ProxyNode {
  name: string
  /** vless / vmess / trojan / ss / unknown */
  protocol: string
  server: string
  port: number | null
  region: string | null
  /** 用户可直接复制到客户端的原始节点链接 */
  raw: string
  /** 解析出的配置字段（uuid / password / security / sni / flow…） */
  details: Record<string, string>
}

export interface ProxySubscription {
  id: string
  name: string
  region: string | null
  url: string
  protocol: string
  status: ProxyNodeStatus
  statusNote: string | null
  note: string | null
  lastSyncedAt: string | null
  /** 抓取/解析失败的提示（成功则为 null） */
  fetchError?: string | null
  /** 节点列表（订阅源解析结果） */
  nodes: ProxyNode[]
  /** 订阅源附带的流量/到期信息；解析不到则为 null */
  usage: { used: string | null; total: string | null; expire: string | null }
}

export interface ProxyOverview {
  featureEnabled: boolean
  /** 用户是否已手动启用（启用时才显示节点列表） */
  activated: boolean
  /** 前端内嵌「使用协议」的版本 */
  consentVersion: number
  /** 用户已同意的协议版本（enable 时写入） */
  consentedVersion: number
  subscriptions: ProxySubscription[]
}

/** 管理端订阅源（含停用开关与最近错误） */
export interface AdminProxySubscription extends Omit<ProxySubscription, "nodes" | "usage"> {
  enabled: boolean
  sortOrder: number
  lastError: string | null
}

// ---- 临时分享箱 ----

export interface TempboxConfig {
  enabled: boolean
  defaultMinutes: number
  maxFileBytes: number
  maxFiles: number
  uploadRequiresLogin: boolean
}

export interface TempboxFile {
  name: string
  size: number
  lastModified: string | null
}

export interface TempboxBatch {
  code: string
  expireAt: string
  remainingMinutes: number
  fileCount: number
  totalBytes: number
  files: TempboxFile[]
  /** 是否纯文本批次（文字存 D1，不走 R2） */
  isText?: boolean
  /** 纯文本内容（isText=true 时返回） */
  textContent?: string | null
}

export interface TempboxCreated {
  code: string
  expireAt: string
  minutes: number
  isText?: boolean
}


// ---- 保留子域名（管理员维护） ----

export interface ReservedSubdomain {
  name: string
  note: string | null
  createdAt: string
}

// ---- 捐献 ----

export interface Donation {
  id: string
  type: "ai" | "frp" | "proxy"
  username: string
  payload: unknown
  notifyEmail: string
  remark: string | null
  status: "pending" | "approved" | "rejected"
  reviewNote: string | null
  createdAt: string
  reviewedAt: string | null
}

export interface DonationOverview {
  donations: Donation[]
  types: string[]
  typeLabels: Record<string, string>
  permissions: Permissions
}

// ---- 邀请码额度 ----

/** 需要消耗转授额度的模块 */
export interface FeatureCounts {
  r2: number
  ai: number
  frp: number
  proxy: number
}

export interface UserQuota {
  /** 基础额度（全局设置） */
  inviteBase: number
  /** 捐献累计获得 */
  inviteBonus: number
  /** 合计可创建数 */
  inviteTotal: number
  inviteUsed: number
  inviteRemaining: number
  featureQuota: FeatureCounts
  featureUsed: FeatureCounts
  featureRemaining: FeatureCounts
}

export interface MyInvite {
  id: string
  code: string
  maxUses: number
  usedCount: number
  expiresAt: string | null
  permissions: Permissions
  createdAt: string
}

export interface MyInvitesOverview {
  quota: UserQuota
  invites: MyInvite[]
  featureLabels: Record<string, string>
  quotaFeatures: string[]
  /** 当前被设为「基础权限」的模块（不消耗模块额度） */
  basicFeatures: string[]
}

/** 管理端：某用户的额度概况（含邀请码数量） */
export interface AdminInviteQuota {
  id: string
  username: string
  inviteBase: number
  inviteBonus: number
  inviteTotal: number
  inviteUsed: number
  inviteRemaining: number
  featureQuota: FeatureCounts
  featureUsed: FeatureCounts
  featureRemaining: FeatureCounts
  inviteCount: number
}

export interface AdminInviteQuotasResponse {
  users: AdminInviteQuota[]
  featureLabels: Record<string, string>
  quotaFeatures: string[]
  /** 当前被设为「基础权限」的模块（不消耗模块额度） */
  basicFeatures: string[]
  baseQuota: number
}

export interface AdminUserInviteQuotaResponse {
  username: string
  quota: UserQuota
  invites: MyInvite[]
  featureLabels: Record<string, string>
  quotaFeatures: string[]
  /** 当前被设为「基础权限」的模块（不消耗模块额度） */
  basicFeatures: string[]
}

// ---- R2 多桶管理（管理员） ----

export interface R2BucketUser {
  userId: string
  username: string
  prefix: string
  usedBytes: number
  quotaBytes: number
  fileCount: number
  enabled: boolean
}

export interface R2BucketStats {
  users: number
  usedBytes: number
  /** 容量上限 = 人数上限 × 每人配额 */
  capacityBytes: number
  fileCount: number
  /** 该桶占免费额度（10 GB）的百分比 */
  storagePercent: number
}

export interface R2Bucket {
  id: string
  name: string
  accountId: string | null
  endpoint: string
  bucketName: string
  maxUsers: number
  quotaPerUser: number
  enabled: boolean
  sortOrder: number
  /** 'user' = 用户网盘桶；'platform' = 平台数据桶（名片/分享箱） */
  kind: string
  hasAnalyticsToken: boolean
  createdAt: string
  stats: R2BucketStats
  users: R2BucketUser[]
}

export interface R2FreeTier {
  storageBytes: number
  classAOps: number
  classBOps: number
}

export interface R2BucketsResponse {
  buckets: R2Bucket[]
  /** 未纳入多桶管理的老用户（走 env 默认桶），未配置时为 null */
  legacyBucket: R2Bucket | null
  freeTier: R2FreeTier
  assignableBuckets: { id: string; name: string }[]
  /** 平台数据桶 id（名片/分享箱存这里），未配置为 null */
  platformBucketId: string | null
}

export interface R2Operations {
  configured: boolean
  reason?: string
  error?: string
  since?: string
  classA?: number
  classB?: number
  classAPercent?: number
  classBPercent?: number
  freeTier: { classAOps: number; classBOps: number }
}

// ---- 社区广场 & 通知 ----

export interface CommunityAuthor {
  username: string
  nickname: string | null
  isAdmin: boolean
  hasAvatar: boolean
}

export interface Post {
  id: string
  author: CommunityAuthor
  body: string
  images: string[]
  likeCount: number
  commentCount: number
  shareCount: number
  liked: boolean
  isMine: boolean
  createdAt: string
}

export interface CommentNode {
  id: string
  body: string
  createdAt: string
  author: CommunityAuthor
  replyTo: string | null
  likeCount: number
  replies: CommentNode[]
}

export interface Notification {
  id: string
  type: string
  actor_id: string | null
  post_id: string | null
  comment_id: string | null
  read: boolean
  created_at: string
}

export interface CommunityActiveUser {
  username: string
  nickname: string | null
  hasAvatar: boolean
  posts: number
}

export interface CommunityStats {
  todayCount: number
  totalCount: number
  activeUsers: CommunityActiveUser[]
}

export interface AdminCommunityPost {
  id: string
  body: string
  created_at: string
  deleted_at: string | null
  like_count: number
  comment_count: number
  share_count: number
  username: string
  nickname: string | null
}
