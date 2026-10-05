export type DnsRecordType = "A" | "AAAA" | "CNAME" | "TXT" | "MX" | "SRV"

export interface User {
  id: string
  username: string
  email: string
  namespace: string
  /** root = 站长（唯一）；superadmin = 超级管理员（全权）；admin = 自定义白名单管理员；user = 普通用户 */
  role: "user" | "admin" | "superadmin" | "root"
  /** 真实邮箱是否已验证（验证后才能作转发目标） */
  emailVerified: boolean
  /** 是否接收「个人相关」通知邮件（捐献/反馈/社区回复等） */
  notifyEnabled: boolean
  /** 是否接收「站点统一公告」的邮件推送 */
  notifyAnnouncements: boolean
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
  /** 该域名下直接挂的 DNS 记录数（不含子子域名的） */
  recordCount?: number
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
  /** MX 与 SRV 共用：值小者优先 */
  priority?: number
  /** SRV 专有字段（非 SRV 记录为 undefined） */
  srv?: {
    weight: number
    port: number
    target: string
  }
  status: "active" | "pending" | "error"
  createdAt: string
  updatedAt: string
  /**
   * 平台自动创建的解析（个人名片 / 网盘直链绑定的域名）。
   * 这类记录是后端派生出来的只读项：它并不存在于 dns_records 表里，
   * 删掉它只会让域名解析不到本站、而绑定关系还在，所以这里不给编辑/删除。
   */
  managed?: boolean
  managedBy?: "profile" | "storage" | null
}

export interface Mailbox {
  id: string
  address: string
  primary: boolean
  /** true = 临时邮箱：额度与普通邮箱独立，且不支持转发配置 */
  isTemp: boolean
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
  /** 弹窗模式：none（不弹）/ once（仅一次）/ every（每次都弹） */
  popupMode: "none" | "once" | "every"
  /** 发布状态：draft 草稿（用户不可见）/ scheduled 定时 / published 已发布 */
  status: AnnouncementStatus
  /** 定时发布时间（ISO）；scheduled 时有值 */
  publishAt: string | null
  /** 实际发布时间（ISO）；从未发布过为 null */
  publishedAt: string | null
  /** 是否群发邮件（持久化字段：定时发布时到点由服务端据此决定发不发） */
  notifyEmail: boolean
  createdAt: string
  /** 邮件群发状态：none（未推送）/ sending（推送中）/ done（已完成） */
  mailStatus: "none" | "sending" | "done"
  /** 本次群发的收件人总数（入队时快照，不随用户改偏好而变） */
  mailTotal: number
  mailSent: number
  mailFailed: number
  mailFinishedAt: string | null
}

/** 公告状态：草稿 / 定时 / 已发布 */
export type AnnouncementStatus = "draft" | "scheduled" | "published"

/** 链接预览元数据（markdown 里的链接渲染成卡片用） */
export interface LinkPreview {
  title: string
  description: string | null
  /** og:image —— 大图，铺满卡片左侧 */
  image: string | null
  /** 站点 favicon —— 没有大图时用它顶上（很多页面没有 og:image） */
  icon: string | null
  siteName: string | null
}

/** 网站统计概览（管理面板） */
export interface AnalyticsOverview {
  summary: {
    pv: number
    uv: number
    /** 统计窗口内有访问的自然日数量 */
    activeDays: number
    /** 平均每个匿名访客浏览的页面数 */
    avgPagesPerVisitor: number
    /** 只浏览过一次页面的访客数 */
    singlePageVisitors: number
    /** 浏览过两次及以上页面的访客数 */
    returningVisitors: number
  }
  byDay: { date: string; pv: number; uv: number }[]
  /** 按中国标准时间小时聚合（0-23） */
  byHour: { hour: number; pv: number; uv: number }[]
  byPath: { path: string; pv: number; uv: number }[]
  byReferrer: { referrer: string; pv: number; uv: number }[]
  byDevice: { ua: string; pv: number; uv: number }[]
}

/**
 * 用户数据分析（GET /api/admin/analytics/users）。
 *
 * 与 `AnalyticsOverview`（访问统计）互补：那边是「访客看了什么」，这边是
 * 「注册的用户在用什么」。所有百分比的分母都是**总用户数**（含没开通的），
 * 所以「33% 开通了中转站」就是运营上要的那个数。
 */
export interface UserAnalytics {
  total: number
  /** 角色分布（user/admin/root） */
  byRole: { key: string; count: number; percent: number }[]
  /** 账号状态分布（active / banned …） */
  byStatus: { key: string; count: number; percent: number }[]
  /** 新增用户趋势 */
  newByDay: { date: string; count: number }[]
  /** 邮箱已验证数 / 占比 */
  verified: number
  verifiedPercent: number
  /** 设置了昵称 / 头像的人数 */
  nickname: number
  avatar: number
  /** 由邀请码注册的人数 / 占比 */
  invited: number
  invitedPercent: number
  /** 各模块实际开通数与占比（按开通数从高到低，标签由服务端下发） */
  features: { key: string; label: string; count: number; percent: number }[]
  resources: {
    mailboxes: number
    tempMailboxes: number
    subdomains: number
    dnsRecords: number
    posts: number
    comments: number
    likes: number
    storageUsedBytes: number
    storageQuotaBytes: number
    /** 人均普通邮箱数 */
    avgMailboxes: number
  }
  donations: {
    total: number
    /** 捐过的人数（去重）与占比 */
    donors: number
    donorsPercent: number
    /** 系统自动审核的条数 */
    autoReviewed: number
    byType: { key: string; label: string; count: number }[]
    byStatus: { key: string; label: string; count: number }[]
  }
  community: {
    /** 发过帖 / 评论过的人数（去重）与占比 */
    authors: number
    authorsPercent: number
    commenters: number
    commentersPercent: number
  }
  /** 用户存活率（口径：最近一周内登录过 = 存活） */
  retention: {
    alive1d: number
    alive1dPercent: number
    /** 主指标：7 天内登录过的人数与占比 */
    alive7d: number
    alive7dPercent: number
    alive30d: number
    alive30dPercent: number
    /** 注册后从未登录过的人数 */
    neverLoggedIn: number
    /** 最后登录时间的分布（分桶，percent 以总用户为分母） */
    buckets: { label: string; count: number; percent: number }[]
    /** 近 30 天注册的新用户里有多少真的登录过 */
    newUsers: { registered: number; loggedIn: number; percent: number }
    /** 数据可信度说明（后端下发，前端原样展示） */
    caveat: string
  }
  /** 「更多数据」：跨模块补充指标，按分组展示（标签由服务端下发） */
  more: { group: string; items: { label: string; value: number; hint?: string }[] }[]
}

/** 聊天室消息 */
export interface ChatQuoteRef {
  id: string
  username: string
  nickname: string | null
  recalled: boolean
  body: string
}

/**
 * 乐观发送状态（借鉴 Telegram 的 send_state：SENDING / SEND_ERROR）。
 * 服务端下发的消息**没有**这个字段 —— 只有本地先插的「发送中 / 失败」气泡才带，
 * 确认后被服务端的真消息原位替换（状态机见 chat.tsx 的 send()）。
 */
export type PendingSendStatus = "sending" | "failed"

export interface ChatMessage {
  id: string
  userId: string
  username: string
  nickname: string | null
  hasAvatar: boolean
  body: string
  /** 是否已撤回（撤回后 body 为空） */
  recalled?: boolean
  /** 引用的消息 id（null = 非引用） */
  replyTo?: string | null
  /** 被引用消息的摘要（列表接口会补全） */
  quote?: ChatQuoteRef | null
  createdAt: string
  /** 乐观字段：仅本地待发消息携带（undefined = 服务端已确认） */
  status?: PendingSendStatus
  /** 乐观字段：本地生成的幂等键，用于把服务端确认回填到这条气泡 */
  clientId?: string
}

/** 聊天室在线用户 */
export interface ChatPresenceUser {
  userId: string
  username: string
  nickname: string | null
  hasAvatar: boolean
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
  /** 按注册顺序的展示用编号（001 起）；老数据可能为 null */
  uid: number | null
  username: string
  email: string
  namespace: string
  role: string
  status: string
  createdAt: string
  /** 直链网盘：已开通且启用 */
  storageEnabled: boolean
  /** AI 中转站：已开通 */
  aiEnabled: boolean
  /** 内网穿透：已启用 */
  frpEnabled: boolean
  /** 代理节点：已启用 */
  proxyEnabled: boolean
  /** 个人名片：已启用对外展示 */
  profileEnabled: boolean
  /** 名片 slug（用于拼 /profile/<slug> 公开地址） */
  profileSlug: string | null
  /** 名片绑定的自定义域名（优先于 slug 地址） */
  profileFqdn: string | null
  /** 注册时使用的 IP（来自 audit_logs 的 register 记录；查不到时为 null） */
  registerIp: string | null
  permissions: Permissions
  /** 注册时使用的邀请码（老用户或码已删除时为 null） */
  inviteCode: string | null
  /** 邀请码创建者用户名 */
  inviteCreatedBy: string | null
  /** 邀请码创建时间 */
  inviteCreatedAt: string | null
  /** 是否为已注销/被删用户（来自 deleted_users 留痕，只读展示） */
  deleted?: boolean
  /** 注销时间（deleted=true 时有值） */
  deletedAt?: string | null
  /** 注销来源：'self' 自助注销 | 'admin' 管理员删除 */
  deletedReason?: string | null
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
    /** 展示昵称；null = 未设置 */
    nickname: string | null
    role: string
    status: string
    /** 邮箱是否已验证 */
    emailVerified: boolean
    /** 是否接收平台通知邮件 */
    notifyEnabled: boolean
    /** 是否已上传自定义头像 */
    hasAvatar: boolean
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
  /** 网盘（未开通为 null） */
  storage: AdminUserStorage | null
  /** AI 中转站（未开通为 null；额度为 D1 同步快照） */
  newapi: AdminUserNewApi | null
  /** 内网穿透启用状态（未启用过为 null） */
  frp: { enabled: boolean; createdAt: string; updatedAt: string } | null
  frpApplications: AdminUserFrpApplication[]
  frpPorts: { remotePort: number; nodeName: string | null; createdAt: string }[]
  /** 代理节点启用状态（未启用过为 null） */
  proxy: {
    enabled: boolean
    consentVersion: number
    consentedAt: string | null
    createdAt: string
    updatedAt: string
  } | null
  /** 个人名片（未开通为 null） */
  profile: {
    slug: string
    published: boolean
    fqdn: string | null
    viewCount: number
    displayName: string | null
    createdAt: string
    updatedAt: string
  } | null
  /** 邀请码额度 + 模块转授额度 */
  quota: AdminUserQuota
  /** 最近 20 条审计日志 */
  activity: AuditLog[]
}

export interface AdminUserStorage {
  prefix: string
  quotaBytes: number
  usedBytes: number
  fileCount: number
  enabled: boolean
  bucketId: string | null
  bucketName: string | null
  createdAt: string
}

export interface AdminUserNewApi {
  newapiUserId: number
  username: string
  email: string
  group: string | null
  /** NewAPI 的 quota 单位（500000 = $1），前端按 quotaPerUnit 换算 */
  quota: number
  usedQuota: number
  requestCount: number
  syncedAt: string | null
  createdAt: string
}

export interface AdminUserFrpApplication {
  id: string
  status: string
  frpUser: string
  ports: number[]
  notifyEmail: string
  remark: string | null
  reviewNote: string | null
  reviewedAt: string | null
  createdAt: string
}

export interface AdminUserQuota {
  inviteBase: number
  inviteBonus: number
  inviteTotal: number
  inviteUsed: number
  inviteRemaining: number
  featureQuota: Record<string, number>
  featureUsed: Record<string, number>
  featureRemaining: Record<string, number>
  featureLabels: Record<string, string>
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
  notifyAnnouncements: boolean
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
  /** 是否已完成密码绑定（有真实 access token）。false = 自动认领、需补密码绑定 */
  bound: boolean
}

export interface NewApiHealth {
  online: boolean
  /** 探测耗时（毫秒）；离线时为 -1 */
  latencyMs: number
  version: string | null
}

/** 推荐模型的一个梯队（由管理员在管理面板维护） */
export interface RecommendedTier {
  /** 梯队名，如「第一梯队」 */
  tier: string
  /** 一句话说明，可空 */
  desc: string
  models: string[]
}

export interface NewApiStatus {
  configured: boolean
  featureEnabled: boolean
  eligibleEmail: string
  /** 展示币种（跟随 NewAPI 站点设置，本实例为 ¥） */
  currencySymbol: string
  currencyCode: string
  /** quota ↔ 金额的换算率（NewAPI 的 quota_per_unit，本实例 500000 = ¥1） */
  quotaPerUnit: number
  trialQuotaUsd: number
  group: string
  account: NewApiAccount | null
  models: string[]
  /** 可用分组（默认分组在前） */
  availableGroups: string[]
  /** 分组 → 该分组可用模型 */
  groupModels: Record<string, string[]>
  /**
   * 捐献渠道所在的分组名（默认 donation）。
   * 捐献模型只能被「选了这个分组」的 Key 调用，前端据此提示用户。
   */
  donationGroup: string
  /** 建 Key 时可自选的分组（顺序：站点分组在前，即默认值） */
  keyGroups: string[]
  /** 账号当前所属分组 */
  accountGroup: string | null
  /** 中转站健康状态（在线/离线 + 延迟 + 版本） */
  health: NewApiHealth
  /** 管理员维护的推荐模型分档（数组顺序即梯队顺序） */
  recommended: RecommendedTier[]
  /** 免费套餐订阅，未领取为 null */
  subscription: NewApiSubscription | null
  /** 免费套餐的 plan_id：前端据此把「免费」与「邀请 / 奖励」订阅分开展示 */
  freePlanId: number
  /**
   * 全部活跃订阅，已按**套餐类型**合并（同类多张额度相加）。
   *
   * 用户可能同时持有多张订阅（免费套餐 + 各档邀请 / 奖励套餐），消费时按
   * `end_time asc, id asc` 逐张接力 ⇒ 总额度 = 各条之和。前端据此画分段进度条：
   * 一个颜色 = 一个套餐。将来新增奖励套餐（任务奖励等）会自动出现在这里。
   */
  subscriptions: NewApiSubscriptionGroup[]
}

/** 按套餐类型合并后的一条订阅（同套餐的多张已相加） */
export interface NewApiSubscriptionGroup {
  planId: number
  /** 套餐名（如「wb邀请套餐」）；套餐表读不到时降级成「套餐 #id」 */
  title: string
  /** 该套餐名下所有订阅的额度之和 */
  amountTotal: number
  /** 已用额度之和 */
  amountUsed: number
  /** 有效期至（unix 秒），同套餐多张时取最晚一张 */
  endTime: number
  /** 下次额度重置时间（unix 秒） */
  nextResetTime: number
  /** 该套餐名下有几张订阅 */
  count: number
}

/** 用户的活跃订阅（免费套餐） */
export interface NewApiSubscription {
  planId: number
  /** 套餐总配额（quota 单位） */
  amountTotal: number
  /** 已用配额 */
  amountUsed: number
  /** 订阅到期时间（unix 秒） */
  endTime: number
  /** 下次额度重置时间（unix 秒） */
  nextResetTime: number
}

export interface NewApiKey {
  id: string
  tokenId: number
  name: string
  maskedKey: string
  createdAt: string
  /** 该 Key 所属分组；读不到时为 null（前端只显示「未知」） */
  group?: string | null
}

/** 开通前探测：决定展示「绑定已有账号」还是「创建新账号」 */
export interface NewApiPreflight {
  featureEnabled: boolean
  username: string
  /** 中转站是否已存在同名账号 */
  exists: boolean
  /** 该账号是否已用 Doulor Cloud 登录（OIDC）绑定（oidc_id === 本站用户 id） */
  oidcBound: boolean
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
  /** 鉴权方式（迁移 0054）：none | token | token_user | custom */
  authMode: FrpAuthMode
}

export type FrpAuthMode = "none" | "token" | "token_user" | "custom"

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
  /**
   * 已参数化的配置模板（剥掉捐献者个人凭据）；空则前端用内置生成器。
   * 仅本人的「已通过」申请会下发。
   */
  configTemplate: string | null
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
  /**
   * 该节点的鉴权方式是否需要「每用户账号 + 密码」。
   * false（全局 auth.token / 无鉴权）时 `frpPassword` 恒为空，管理端不该展示它、
   * 也不该提示「去 frps-panel 建号」—— 那种节点根本没有按用户区分的账号。
   */
  needAccount: boolean
}

export interface AdminFrpNode extends FrpNode {
  authToken: string
  usedPorts: number
  configTemplate: string | null
  sourceDonationId: string | null
}

// ---- 功能权限 ----

/**
 * 受权限控制的模块（与后端 permissions.ts 的 FEATURES 一致）。
 * ⚠️ 不含「个人名片」：名片不消耗资源，已从权限体系移出、全量开放。
 */
export type FeatureKey = "r2" | "ai" | "frp" | "proxy" | "doulor"

export interface Permissions {
  r2: boolean
  ai: boolean
  frp: boolean
  proxy: boolean
  /**
   * doulor.cn 专属域（子域名 + 邮箱）。
   *
   * ⚠️ 与其它四项**不同**：默认值是 false（`permissions.ts` 的 DEFAULT_ALLOWED
   * 不含它）。doulor.cn 是站点主域，用户邮箱/解析挂上去会把滥用风险记到主域声誉上，
   * 而主域还要负责给全站发验证码与找回密码。所以只由管理员显式授予。
   */
  doulor: boolean
}

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  r2: "feat.r2",
  ai: "feat.ai",
  frp: "feat.frp",
  proxy: "feat.proxy",
  doulor: "feat.doulor",
}

/**
 * 可选的「根域」——用户建子域名/邮箱时能选哪个域名。
 *
 * 后端按当前用户的权限**筛过一遍**才下发：没权限的域根本不会出现在这里，
 * 前端不必自己判断权限（否则两边口径迟早漂移）。
 */
export interface RootDomainOption {
  name: string
  label: string
  isDefault: boolean
}

// ---- 排行榜 ----

/** 四个榜 */
export type LeaderboardBoard =
  | "newapi"
  | "community"
  | "feedback"
  | "achievement"
  /** 当前积分余额（只有「全部」口径） */
  | "points_balance"
  /** 累计获得的积分（可按今日/本周/本月/全部切） */
  | "points_earned"

/** 社区榜的三个子项（只有 board=community 时有意义） */
export type CommunityMetric = "posts" | "likes" | "comments"

/** 榜上一行 */
export interface LeaderboardEntry {
  /** 名次（同分并列，下一名跳号：1,2,2,4） */
  rank: number
  username: string
  nickname: string | null
  hasAvatar: boolean
  score: number
  /** 是不是当前登录用户（前端高亮那一行） */
  isMe: boolean
}

/** 时间范围：历史累计 / 今日 / 本周 / 本月 */
export type LeaderboardRange = "all" | "today" | "week" | "month"

export interface LeaderboardResponse {
  board: LeaderboardBoard
  metric: CommunityMetric | null
  /** 实际生效的时间范围（请求了不支持的会回落到 all） */
  range: LeaderboardRange
  /** 这个榜支持哪些范围（newapi/成就点只有累计），前端据此禁用不支持的按钮 */
  ranges: LeaderboardRange[]
  items: LeaderboardEntry[]
  /** 我的成绩与名次；0 分时为 null（前端显示「暂未上榜」） */
  me: { score: number; rank: number } | null
  topN: number
}

// ---- 管理员全局设置 ----

/**
 * 邮件通道密钥的展示信息（明文永不返回）。
 * `brevoKeys` 是**中间打码**的 Key 列表，顺序 = 发送时的轮询顺序。
 */
export interface MailSecrets {
  postaConfigured: boolean
  brevoConfigured: boolean
  brevoKeyCount: number
  brevoKeys: string[]
}

export interface AdminSettings {
  settings: Record<string, string>
  currency: { symbol: string; code: string }
  /** 可作为「管理员通知邮箱」的候选项 */
  notifyEmailOptions: string[]
  /** 邮件通道密钥是否已配置（明文不返回）；Brevo 额外给出 Key 把数与打码列表 */
  mailSecrets: MailSecrets
  stats: {
    storageAccounts: number
    storageUsedBytes: number
    storageQuotaBytes: number
    storageObjects: number
    newapiAccounts: number
    newapiKeys: number
  }
}

// ---- 中转站管理员凭据（令牌可在管理面板在线更新）----

/**
 * 凭据来源：
 *   - `db`：管理面板写入的（优先，可在网页更新）
 *   - `env`：Worker Secret（NEWAPI_ADMIN_TOKEN）
 *   - `none`：都未配置
 */
export type AdminNewApiCredentialSource = "db" | "env" | "none"

export interface AdminNewApiConfig {
  baseUrl: string | null
  source: AdminNewApiCredentialSource
  /** 掩码后的令牌（如 abcd********wxyz）；未配置为 null。明文不下发 */
  maskedToken: string | null
  adminUserId: string
  /** 库内凭据更新时间（source=db 时才有） */
  updatedAt: string | null
  configured: boolean
  /** 用当前凭据真实探测一次管理接口的结果（判断令牌是否已被轮换失效） */
  health: { ok: boolean; message: string }
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

/** 名片模块 id（与后端 MODULE_TYPES 同源） */
export type ProfileModuleId =
  | "identity"
  | "status"
  | "tags"
  | "quote"
  | "links"
  | "timeline"
  | "gallery"
  | "music"
  | "stats"

/** 大事记条目 */
export interface ProfileTimelineItem {
  date: string
  title: string
  desc: string
}

/** 图片墙条目 */
export interface ProfileGalleryItem {
  url: string
  caption: string
}

/**
 * 名片模块配置（开关 + 顺序 + 各自数据）。
 * items 的形态由 id 决定：tags=string[]、timeline=ProfileTimelineItem[]、
 * gallery=ProfileGalleryItem[]；quote 用 text/author；status 用 emoji/text。
 */
export interface ProfileModule {
  id: ProfileModuleId
  enabled: boolean
  items?: (string | ProfileTimelineItem | ProfileGalleryItem)[]
  text?: string
  author?: string
  emoji?: string
  /**
   * 桌面端宽度。缺省 = 跟随骨架默认（网格拼贴里标签/名言默认半宽，其余骨架默认整宽）。
   * 只在桌面端 ≥641px 生效，移动端一律单列。
   */
  size?: "half" | "full"
}

/**
 * 一条音乐搜索结果。
 *
 * 刻意**不含播放地址**：音频源返回的是带时效签名的地址（约 20 分钟失效），
 * 一旦被前端拿住并顺手存进表单，就会变成「保存时能播、过一会儿就哑」。
 * 页面只记 `source`，播放地址交给服务端每次实时解析。
 */
export interface ProfileMusicTrack {
  /** 稳定来源标记，形如 `netease:1330348068` */
  source: string
  title: string
  artist: string
  album: string
  /** https 封面；服务端已放大到 500x500，取不到时为 null */
  cover: string | null
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
  /**
   * 搜索来的音乐来源标记，形如 `netease:1330348068`；用户自定义时为 null。
   * 播放地址由服务端在 `/p/<用户名>/music` 实时解析得到，不入库（地址有时效签名）。
   */
  musicSource: string | null
  /** 歌词（LRC 文本，含时间轴）；可空 */
  musicLyrics: string | null
  theme: string
  accent: string | null
  effects: string[]
  intro: string
  font: string
  cjkFont: string
  layout: string
  /** 缩放模式：'auto' 内容超出屏幕时自动缩小，'off' 固定用 scaleManual */
  scaleMode: string
  /** 自动缩放下限（百分比） */
  scaleMin: number
  /** 基准缩放比例（百分比） */
  scaleManual: number
  contacts: ProfileContact[]
  modules: ProfileModule[]
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
  cjkFonts: string[]
  themeOptions: ProfileOption[]
  effectOptions: ProfileOption[]
  introOptions: ProfileOption[]
  fontOptions: ProfileOption[]
  layoutOptions: ProfileOption[]
  cjkFontOptions: ProfileOption[]
  moduleOptions: ProfileOption[]
  /** 模块宽度选项（自动/半宽/整宽），与服务端同源 */
  moduleSizeOptions: ProfileOption[]
  contactTypes: ContactType[]
  /** 缩放模式白名单与选项（与服务端同源） */
  scaleModes: string[]
  scaleModeOptions: ProfileOption[]
  scaleMinRange: { min: number; max: number }
  scaleManualRange: { min: number; max: number }
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
  /** 所属分组 id（对应 groups[].id），前端按组展示 */
  group: string
  /** 获取途径 */
  how: string
  /** 是否单级成就 */
  single: boolean
  /** 分级成就的阈值与等级名 */
  tiers?: number[]
  tierNames?: string[]
  tierReqs?: string[]
  /** 进度值的展示格式（bytes = 按 KB/MB/GB 展示，否则是纯数字） */
  valueFormat?: "bytes"
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

/** 成就分组（顺序即展示顺序，由后端下发，避免前后端各维护一份） */
export interface AchievementGroup {
  id: string
  label: string
  desc: string
}

/** 称号：按成就点分档 */
export interface AchievementTitle {
  /** 当前称号名 */
  name: string
  /** 当前称号所需点数（抵达点） */
  min: number
  /** 下一档所需点数；已是最高档为 null */
  next: number | null
  nextName: string | null
  /** 完整称号阶梯（所有档位，供前端做「VIP 等级」式线性展示） */
  ladder: { name: string; min: number; current: boolean }[]
}

export interface AchievementsResponse {
  achievements: AchievementProgress[]
  groups: AchievementGroup[]
  summary: {
    unlocked: number
    total: number
    /** 成就点 = 每个已解锁等级记 1 点（分级成就练到 Lv.3 就是 3 点） */
    points: number
    /** 全部练满能拿到的点数 */
    maxPoints: number
  }
  title: AchievementTitle
  registeredAt: string | null
}

// ---- 个人空间（公开主页）----

/** 空间里的一个徽章（只用于展示：名字 + 图标 + 已达等级） */
export interface SpaceBadge {
  id: string
  name: string
  icon: string
  group: string
  level: number
  maxLevel: number
}

export interface SpacePostItem {
  id: string
  excerpt: string
  createdAt: string
  likeCount: number
  commentCount: number
}

/**
 * 一条「历史贡献」。
 *
 * ⚠️ `masked: true` 时服务端**没有下发内容**（`summary` 为 null）——
 * 查看者缺少对应模块的权限。前端只负责把它渲染成高斯模糊的占位块，
 * 不要以为「内容藏在客户端、糊住就行」。
 */
export interface SpaceContributionItem {
  id: string
  type: string
  label: string
  at: string
  summary: string | null
  masked: boolean
  /** 被打码时缺的是哪个模块的权限（如「代理节点」）；未打码为 null */
  needLabel: string | null
}

export interface SpaceData {
  user: {
    username: string
    nickname: string | null
    hasAvatar: boolean
    isAdmin: boolean
    /** 站长（root，唯一）；isAdmin 为 true 时，站长单独标识以区分徽章 */
    isRoot: boolean
    /** 自定义称号（徽章式）；未授予为 null */
    customTitle: CustomTitle | null
    /** 用户 UID（按注册顺序从 1 开始，展示层补零成 001） */
    uid: number | null
    joinedAt: string
    days: number
  }
  space: {
    isOwner: boolean
    motto: string | null
    showAchievements: boolean
    showStats: boolean
    showPosts: boolean
    showContributions: boolean
    showProfileLink: boolean
  }
  /** 名片链接（跳转按钮）；null = 未发布名片 */
  profileUrl: string | null
  /** 打码时的提示文案（由后端给，避免两端各写一套） */
  maskHint: string
  /** 主人关掉该分区时为 null */
  achievements: {
    unlocked: number
    total: number
    points: number
    maxPoints: number
    title: AchievementTitle
    badges: SpaceBadge[]
    groups: AchievementGroup[]
  } | null
  stats: {
    days: number
    subdomains: number
    mailboxes: number
    posts: number
    comments: number
    likesReceived: number
    invited: number
    donations: number
  } | null
  posts: { items: SpacePostItem[]; hiddenReason: string | null } | null
  contributions: {
    items: SpaceContributionItem[]
    hiddenReason: string | null
  } | null
}

/** 头像悬浮卡片的轻量数据 */
export interface SpaceCardData {
  username: string
  nickname: string | null
  hasAvatar: boolean
  isAdmin: boolean
  /** 站长（root，唯一）；isAdmin 为 true 时，站长单独标识以区分徽章 */
  isRoot: boolean
  /** 自定义称号（徽章式）；未授予为 null。注意与下面的成就等级 title 不是一回事 */
  customTitle: CustomTitle | null
  /** 用户 UID（按注册顺序从 1 开始，展示层补零成 001） */
  uid: number | null
  isMe: boolean
  joinedAt: string
  days: number
  motto: string | null
  title: string
  unlocked: number
  total: number
  points: number
  posts: number
}

/** 我自己的空间展示设置 */
export interface MySpaceSettings {
  showAchievements: boolean
  showStats: boolean
  showPosts: boolean
  showContributions: boolean
  showProfileLink: boolean
  motto: string
}

// ---- 代理节点 ----

export type ProxyNodeStatus = "online" | "offline" | "maintenance" | "unknown"

/** 解析后的单个代理节点 */
export interface ProxyNode {
  name: string
  /** vless / vmess / trojan / ss / ssr / anytls / hysteria2 / tuic / unknown */
  protocol: string
  server: string
  port: number | null
  region: string | null
  /** 用户可直接复制到客户端的原始节点链接 */
  raw: string
  /** 解析出的配置字段（uuid / password / security / sni / flow…） */
  details: Record<string, string>
  /** 相同节点检测：本节点在另一个订阅源里也出现了（值是那个订阅源的名称） */
  duplicateOf?: string
}

export interface ProxySubscription {
  id: string
  name: string
  region: string | null
  /**
   * 订阅源原始地址（内嵌机场服务商的订阅 token）。
   *
   * ⚠️ **用户侧列表接口不下发这个字段**（见后端 proxy.ts 的 toPublicSubscription），
   * 只能通过 `proxyApi.revealSubscription(id)` 按需获取（每天限 3 次）。
   * 管理端接口仍会返回它，用于编辑订阅源。
   */
  url?: string
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

/**
 * 逐节点测速的单个结果。
 *
 * ⚠️ 这是**服务端发起的 TCP 握手**耗时，不是 Clash 那种「经节点转发一次请求」的
 * 完整延迟 —— Worker 里没有代理内核。它的用途是快速分辨「死节点 / 慢节点」。
 * `ok: false` 只代表**本站没连上**（可能是我们的出网被该节点挡了），
 * 不代表节点不可用，所以前端不要显示成红色「不可用」。
 */
export interface ProxyNodeLatency {
  /** 该节点在 `ProxySubscription.nodes` 里的下标 */
  index: number
  ok: boolean
  /** ok=true 时的 TCP 握手耗时（毫秒） */
  latencyMs: number | null
  /** ok=false 时面向用户的原因（中性措辞） */
  reason: string
}

/** POST /proxy/latency 的返回（一次一批，前端按 offset 循环） */
export interface ProxyLatencyBatch {
  /** 该订阅一共解析出多少节点 */
  total: number
  /** 其中能用 TCP 握手测的（其余是 QUIC/UDP，测不了） */
  testable: number
  offset: number
  limit: number
  tested: number
  results: ProxyNodeLatency[]
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
  /** 是否还有更多订阅源（懒加载分页，前端点「查看更多」接着拉） */
  hasMore: boolean
}

/** 管理端订阅源（含停用开关与最近错误） */
export interface AdminProxySubscription extends Omit<ProxySubscription, "nodes" | "usage"> {
  enabled: boolean
  sortOrder: number
  lastError: string | null
}

// ---- Cloudflare 额度（管理端）----

/** 账号套餐：免费版 / 付费版（Workers Paid，$5/月起） */
export type CfPlan = "free" | "paid"

/** 套餐是怎么判出来的 —— 面板要如实告诉管理员，并允许他手动改 */
export type CfPlanSource = "manual" | "subscription" | "usage" | "default"

/**
 * 单项额度。
 * `used`/`limit` 为 null 表示读不到 —— 此时 `error` 一定有值。
 */
export type CfQuotaUnit = "times" | "rows" | "items" | "bytes"

export interface CfQuotaItem {
  key: string
  label: string
  used: number | null
  /** 免费版=每日硬上限；付费版=套餐内含的量 */
  limit: number | null
  /**
   * 展示单位（**i18n key**）。`quota.unit.bytes` 由前端用 formatBytes 渲染，
   * 其余用 `t(unit)` 取词。
   */
  unit: CfQuotaUnit
  /** 重置周期说明（每天 00:00 UTC / 每月 / 不重置） */
  period: string
  /** used/limit 是哪个周期的量 */
  scope: "day" | "month" | "none"
  /**
   * 上限的性质，决定 UI 用「危险色」还是「费用色」：
   * `hard` = 撞上就拒绝服务；`included` = 套餐内含，超出只计费。
   */
  limitKind: "hard" | "included" | null
  /** 最近若干天的用量，用于画小柱状图 */
  history?: { date: string; value: number }[]
  note?: string
  /** 读不到时的原因（面向管理员，会提示该补什么权限） */
  error?: string
  /** 付费版：本项本月已产生的超额估算费用（美元） */
  costUsd?: number
  /** 付费版：超额单价说明，如「月含 1000 万次，超出后 $0.30 / 百万次」 */
  overageNote?: string
  /** 免费版：升级到付费版后这一项会变成什么 */
  paidNote?: string
}

export interface CfQuotaGroup {
  key: string
  label: string
  description: string
  items: CfQuotaItem[]
}

/** 顶部图形化概览用的一项（占用率最高的几项） */
export interface CfQuotaHighlight {
  key: string
  label: string
  used: number
  limit: number
  percent: number
  unit: CfQuotaItem["unit"]
  limitKind: "hard" | "included"
  costUsd: number
}

export interface CfQuotaOverview {
  generatedAt: string
  accountId: string
  /** 判定出的套餐（额度数字按它选口径） */
  plan: CfPlan
  /** 判定依据 */
  planSource: CfPlanSource
  /** 设置里存的值：auto / free / paid */
  planSetting: string
  /** 判定过程的一句人话解释 */
  planNote: string
  /** 付费版：本月估算总费用（含 $5 订阅底价）；免费版为 null */
  estimatedCostUsd: number | null
  /** 付费版：费用拆解 */
  costBreakdown: { label: string; detail: string; usd: number }[]
  /** 图形化概览（占用率最高的几项） */
  highlights: CfQuotaHighlight[]
  groups: CfQuotaGroup[]
  /** 整体性提醒（如分析数据整体缺权限） */
  warnings: string[]
}

/**
 * Brevo 单把 Key 的当日额度。
 * `credits` 为 null 表示读不到 —— 此时 `error` 一定有值（如实显示原因，不显示成 0）。
 */
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
  /** 读不到时的原因 */
  error: string | null
}

export interface BrevoQuotaOverview {
  /** 免费版单账号每日额度（用于画进度条） */
  freeDailyLimit: number
  keys: BrevoKeyQuota[]
  /** 所有能读到的 Key 的剩余之和 */
  totalRemaining: number
  okCount: number
  totalCount: number
  generatedAt: string
}

// ---- 临时分享箱 ----

export interface TempboxConfig {
  enabled: boolean
  defaultMinutes: number
  maxFileBytes: number
  maxFiles: number
  /** 同时存活的分享箱数量上限（后端常量，非每箱文件数） */
  maxLiveBatches: number
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
  type: "ai" | "frp" | "proxy" | "sensenova"
  username: string
  payload: unknown
  notifyEmail: string
  remark: string | null
  /**
   * `revoked` = 已通过后又被系统巡检撤销（资源失效，如商汤 Key 被上游拒绝）。
   * 与 `rejected` 区分开：那不是用户填错，是资源后来失效了，文案不能混。
   */
  status: "pending" | "approved" | "rejected" | "revoked"
  reviewNote: string | null
  /** 系统自动接入的 NewAPI 渠道 id；null = 尚未接入中转站 */
  channelId?: number | null
  /** 这次审核是否为系统自动完成（AI 类型捐献走自动化） */
  autoReviewed?: boolean
  createdAt: string
  reviewedAt: string | null
}

/** AI 捐献的上游探测结果（自动获取模型列表） */
export interface AiProbeResult {
  ok: boolean
  /** 规范化后的上游地址（已去掉尾部 /v1） */
  baseUrl: string
  channelType: number | null
  channelTypeName: string
  models: string[]
  message: string
  /** 依次尝试过的接口格式及结果（失败时用来判断该换哪种格式） */
  attempts?: { type: number; name: string; ok: boolean; error: string }[]
}

/** 提交捐献后的返回（AI 类型可能当场就自动通过/拒绝） */
export interface DonationSubmitResult {
  id: string
  status: "pending" | "approved" | "rejected"
  autoReviewed: boolean
  reviewNote: string | null
  channelId: number | null
  /** 首次捐献成功时附带的「自选权限」券码 */
  voucherCode?: string | null
}

// ---- 权限兑换码 ----

/**
 * 我持有的一个「码」。
 *
 * 产品语义上**邀请码和兑换券是同一种东西**：都能发给别人
 * （新用户注册 / 让对方补权限），也都能自己用。所以后端把两者合成一个列表返回。
 */
export interface MyCode {
  id: string
  code: string
  /** invite = 邀请码；voucher = 券（首捐奖励等） */
  kind: "invite" | "voucher"
  /** 自带哪些模块；自选券为空数组 */
  features: string[]
  /** true = 自选，使用时挑一个模块 */
  selfSelect: boolean
  /** 能否发给别人用 */
  transferable: boolean
  note: string | null
  createdAt: string
}

export interface VoucherOverview {
  codes: MyCode[]
  /**
   * 全部可兑模块 + 当前是否已拥有 + 当前是否允许用首捐券兑换。
   * ⚠️ 是**全部**，不是「只列还没开的」—— 自选券的下拉要把已开通的也列出来
   * （标「已开通」并置灰），否则四模块全开的账号看到的是一个空下拉，
   * 观感上像「这张券没有选权限的地方」（2026-09-30 站长反馈）。
   *
   * `allowed` 来自管理面板设置「首捐奖励券可兑换的模块」（默认全部）。
   * ⚠️ 只约束**首捐券**；别人给的邀请码带什么权限由码自己决定，别用它过滤。
   */
  features: { key: string; label: string; owned: boolean; allowed: boolean }[]
}

export interface RedeemResult {
  ok: boolean
  /** 码的来源：兑换券 / 邀请码 */
  kind: "voucher" | "invite"
  /** 实际开通的模块 key */
  granted: string[]
  permissions: Permissions
  code: string
}

/** 人工复核接入渠道的结果 */
export interface DonationProvisionResult {
  ok: boolean
  channelId: number | null
  message: string
  detail?: string
}

export interface DonationOverview {
  donations: Donation[]
  types: string[]
  typeLabels: Record<string, string>
  permissions: Permissions
  /** AI 捐献一次最多可选多少个模型（每个都要真调一次验证可用性） */
  maxAiModels?: number
  /** 代理捐献一次最多可提交多少个订阅链接（每个都要真拉一次） */
  maxSubUrls?: number
  /** WorkBuddy 反代账号捐献通道（免审核，登录成功即解锁 ai） */
  wb2api: Wb2ApiDonationBlock
  /** CLI2API 反代账号捐献通道（第二条，免审核） */
  cli2api: Cli2ApiDonationBlock
  /** 商汤 Key 捐献通道（免审核，Key 校验通过即解锁 ai） */
  sensenova: SenseNovaDonationBlock
  /**
   * 各捐献/绑定通道是否「授予权限」（对应 donation_grant_* 开关）。
   * false = 该通道仅收录资源、不再授予权限，前端据此改文案。
   */
  grantPermissions?: Record<string, boolean>
}

// ---- 商汤 Key 捐献 ----

/** 捐献页用的商汤通道概况（随 GET /api/donations 一起返回） */
export interface SenseNovaDonationBlock {
  /** 管理员是否开启该通道 */
  enabled: boolean
  /**
   * 管理员是否允许在捐献页显示该入口（纯展示开关）。
   * 关掉后整卡隐藏，但提交接口照常可用（已有 Key 继续留在中转站渠道里）。
   */
  visible: boolean
  /**
   * 商汤控制台地址。
   *
   * 商汤**没有**程序化获取 Key 的接口，Key 只能在控制台手动创建、
   * 且只在创建时完整显示一次 —— 所以只能给用户一个跳转链接。
   */
  consoleUrl: string
}

// ---- WorkBuddy 反代账号捐献 ----

/** 一条绑定：用户捐献（登录）的一个 WorkBuddy 账号 */
export interface Wb2ApiBinding {
  id: string
  /** 网关侧 WorkBuddy 账号 uid */
  uid: string
  nickname: string | null
  realm: string
  status: "active" | "removed"
  createdAt: string
  removedAt: string | null
}

/** 捐献页用的通道概况（随 GET /api/donations 一起返回） */
export interface Wb2ApiDonationBlock {
  /** 管理员是否开启该通道 */
  enabled: boolean
  /**
   * 管理员是否允许在捐献页显示该入口（纯展示开关）。
   * 关掉且本人没有任何绑定时整卡隐藏；已绑定的用户仍能看到（便于撤销绑定）。
   */
  visible: boolean
  /** 网关访问密钥是否已配置 */
  configured: boolean
  /** 每人可绑定上限 */
  limit: number
  used: number
  remaining: number
  /**
   * 反代账号捐献的**默认**对接域：'cn' 国内版 / 'global' 国际版。
   * 只是初始选中项 —— 捐献者可以在捐献页自己改选（2026-09-30 起）。
   */
  realm: string
  /** 当前允许用户自选的版本（国内版/国际版开关决定）；前端据此隐藏被关的版本 */
  availableRealms: string[]
  bindings: Wb2ApiBinding[]
  /** 该通道解锁的功能模块 */
  feature: string
}

/** GET /api/wb2api/status */
export interface Wb2ApiStatus {
  enabled: boolean
  configured: boolean
  limit: number
  used: number
  remaining: number
  bindings: Wb2ApiBinding[]
}

/** POST /api/wb2api/login/start */
export interface Wb2ApiLoginStart {
  sessionId: string
  url: string
  realm: string
}

/** GET /api/wb2api/login/poll 的结果快照 */
export interface Wb2ApiLoginResult {
  uid: string
  nickname: string | null
  credits: number | null
  creditsTotal: number | null
  /** 该账号此前已绑定过（幂等返回，未重复授权） */
  alreadyBound: boolean
  /** 本次是否新授予了 ai 权限 */
  aiGranted: boolean
}

export interface Wb2ApiLoginPoll {
  status: "pending" | "done" | "failed"
  message?: string
  result?: Wb2ApiLoginResult
}

/** 管理端：绑定列表（含用户名） */
export interface AdminWb2ApiBinding extends Wb2ApiBinding {
  username: string
  /** 该绑定当时是否新授予了 ai 权限 */
  grantedAi: boolean
}

/** 管理端：网关凭据与连通性 */
export interface AdminWb2ApiConfig {
  baseUrl: string
  source: "db" | "env" | "none"
  /** 掩码后的密钥；未配置为 null。明文不下发 */
  maskedApiKey: string | null
  updatedAt: string | null
  configured: boolean
  enabled: boolean
  limit: number
  health: { ok: boolean; message: string }
}

/** 管理端：网关账号池概览 */
export interface AdminWb2ApiPool {
  total: number
  healthy: number
  cooling: number
  disabled: number
  accounts: {
    uid: string
    nickname?: string
    realm?: string
    credits?: number
  }[]
}

// ---- CLI2API 反代账号捐献（第二条通道）----

/** 一条绑定：用户捐献（登录）的一个 CLI2API 账号 */
export interface Cli2ApiBinding {
  id: string
  /** 上游账号 id（acc_xxxxxxxxxxxx） */
  accountId: string
  provider: string
  region: string
  nickname: string | null
  status: "active" | "removed"
  createdAt: string
  removedAt: string | null
}

/** GET /api/cli2api/status */
export interface Cli2ApiStatus {
  enabled: boolean
  configured: boolean
  limit: number
  used: number
  remaining: number
  /** 当前配置要绑的上游与区域 */
  provider: string
  region: string
  bindings: Cli2ApiBinding[]
}

/** 捐献页用的 CLI2API 通道概况（随 GET /api/donations 一起返回） */
export interface Cli2ApiDonationBlock {
  enabled: boolean
  /**
   * 管理员是否允许在捐献页显示该入口（纯展示开关）。
   * 关掉且本人没有任何绑定时整卡隐藏；已绑定的用户仍能看到（便于撤销绑定）。
   */
  visible: boolean
  configured: boolean
  limit: number
  used: number
  remaining: number
  provider: string
  region: string
  bindings: Cli2ApiBinding[]
  /** 该通道解锁的功能模块 */
  feature: string
}

/** POST /api/cli2api/login/start */
export interface Cli2ApiLoginStart {
  sessionId: string
  provider: string
  region: string
}

/** GET /api/cli2api/login/poll */
export interface Cli2ApiLoginPoll {
  status: "pending" | "done" | "failed"
  message?: string
  /** pending 时返回的授权链接（首次取到后缓存，之后原样带回） */
  authUrl?: string
  result?: Cli2ApiLoginResult
}

export interface Cli2ApiLoginResult {
  id: string
  accountId: string
  provider: string
  region: string
  /** 本次是否新授予了 ai 权限 */
  aiGranted: boolean
  /** 该账号此前已绑定过（幂等返回，未重复授权） */
  alreadyBound: boolean
}

/** 管理端：绑定列表（含用户名） */
export interface AdminCli2ApiBinding extends Cli2ApiBinding {
  username: string
}

/** 管理端：通道配置与凭据信息 */
export interface AdminCli2ApiConfig {
  baseUrl: string
  source: "db" | "env" | "none"
  /** 掩码后的 console key；未配置为 null。明文不下发 */
  maskedKey: string | null
  updatedAt: string | null
  enabled: boolean
  limit: number
  provider: string
  region: string
}

/** 管理端：上游池子概览 */
export interface AdminCli2ApiPool {
  available: boolean
  reason: string
  accounts: {
    id: string
    name: string
    provider: string
    region: string
    enabled: boolean
    status?: string
    ready?: boolean
  }[]
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
  /** 邀请奖励记录：被邀请人解锁 AI 权限时给本用户发的邀请订阅 */
  rewards: {
    invitee: string
    planId: number
    grantedAt: string
  }[]
}

/** 管理端：某用户的额度概况（含邀请码数量） */
export interface AdminInviteQuota {
  id: string
  /** 展示用编号（同用户列表的 UID） */
  uid: number | null
  username: string
  email: string
  namespace: string
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
  /** user / admin / root —— 「同步存量配额」会跳过 admin 与 root */
  role: string
}

export interface R2BucketStats {
  users: number
  usedBytes: number
  /** 容量上限 = 桶的真实容量（共享池） */
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
  /** 每人最大上传限额（软上限，字节） */
  quotaPerUser: number
  /** 桶的真实容量（共享池，字节） */
  capacityBytes: number
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

/** 自定义称号（徽章式，管理面板创建并授予；与 role 角色徽章并排展示） */
export interface CustomTitle {
  name: string
  /** 渐变起点 #RRGGBB；与 colorTo 相同即纯色 */
  colorFrom: string
  /** 渐变终点 #RRGGBB */
  colorTo: string
}

export interface CommunityAuthor {
  username: string
  nickname: string | null
  isAdmin: boolean
  /** 站长（root，唯一）；isAdmin 为 true 时，站长单独标识以区分徽章 */
  isRoot: boolean
  hasAvatar: boolean
  /** 自定义称号；未授予为 null */
  customTitle: CustomTitle | null
}

/** 帖子分类（2026-10-03）：闲聊 / 求助 / 资源共享 */
export type PostCategory = "chat" | "help" | "resource"

/** 广场列表里展示的高赞评论预览 */
export interface PostTopComment {
  id: string
  body: string
  likeCount: number
  username: string
  nickname: string | null
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
  /** 管理员置顶（2026-10-01）；置顶的排在广场最前 */
  pinned: boolean
  /** 帖子分类：chat（闲聊）/ help（求助）/ resource（资源共享） */
  category?: PostCategory
  /** 广场列表里展示的高赞评论预览（最多 2 条，全社区前 20%） */
  topComments?: PostTopComment[]
  createdAt: string
  /** 最近编辑时间（未编辑过为 null） */
  updatedAt: string | null
  /** 编辑次数 */
  editCount: number
}

export interface CommentNode {
  id: string
  body: string
  createdAt: string
  author: CommunityAuthor
  replyTo: string | null
  likeCount: number
  /** 是否为「全社区前 20%」的高赞评论（用户反馈 2026-10-03） */
  hot?: boolean
  /** 当前登录用户是否点过赞（未登录恒 false） */
  liked?: boolean
  replies: CommentNode[]
}

export interface Notification {
  id: string
  /** 消息分类：system（系统）/ site（网站动态）/ social（社交）/ event（活动） */
  category: MessageCategory
  type: string
  /** 网站动态 / 系统消息的标题与正文（社交消息为空，改用下方 preview 字段） */
  title: string | null
  body: string | null
  /** 点击跳转的站内路径 */
  link: string | null
  /** 活动卡片等附加数据 */
  payload: Record<string, unknown> | null
  actorUsername: string | null
  actorNickname: string | null
  postId: string | null
  commentId: string | null
  read: boolean
  createdAt: string
  /** 帖子摘要（帖子被删则为 null） */
  postPreview: string | null
  postDeleted: boolean
  /** 触发这次互动的评论/回复正文（feedback_reply 无评论则为 null） */
  commentPreview: string | null
}

export type MessageCategory = "system" | "site" | "social" | "event"

/** 活动（管理端可见全部状态；用户端只拿到 active） */
export interface EventItem {
  id: string
  title: string
  body: string
  status: EventStatus
  startsAt: string | null
  endsAt: string | null
  /** 定时发布时间（ISO）；status = scheduled 时有值 */
  publishAt: string | null
  /** 实际上线时间（ISO）；从未上线为 null */
  publishedAt: string | null
  /** 限量总份数；null = 不限量（先到先得）。抽奖活动下它是「参与人数上限」 */
  maxClaims: number | null
  rewardLabel: string | null
  rewardType: EventRewardType
  rewardParams: Record<string, unknown> | null
  conditionType: EventConditionType
  conditionParams: Record<string, unknown> | null
  /**
   * 参与条件的规则说明（如「需要先把个人名片做完：填好昵称并保存」）。
   * 与 claimBlockedReason 不同：那个是「你现在还差什么」，这个是「这类活动要什么」。
   */
  conditionHint?: string | null
  /** 抽奖：开奖时间（ISO）；null = 尚未开奖 */
  drawnAt: string | null
  /**
   * 抽奖活动的展示信息；非抽奖（或配置异常）为 null。
   * 与 conditionParams 分开下发，因为后者对普通用户是置 null 的（保护认证码）。
   */
  lottery: {
    /** 中奖人数 */
    winners: number
    /** 奖池总积分 */
    pool: number
    /** 分配方式：even 平均分 / random 随机分 */
    mode: "even" | "random"
    /** 是否已开奖 */
    drawn: boolean
  } | null
  createdAt: string
  updatedAt: string
  /** 服务端算出的可参与状态：open / not_started / ended / offline */
  claimState: "open" | "not_started" | "ended" | "offline"
  /** 管理端列表才有：领取人数 */
  claimCount?: number
  /** 用户端列表才有：我自己的领取记录 */
  myClaim?: { rewardStatus: string; rewardDetail: string | null } | null
  /**
   * 用户端列表才有：不满足奖励前置条件时的原因（如未开通中转站）；
   * null = 可正常领取。用于把「立即参与」置灰并说明原因。
   */
  claimBlockedReason?: string | null
}

export type EventStatus = "draft" | "scheduled" | "active" | "ended" | "archived"
export type EventRewardType = "none" | "newapi_quota" | "invite_quota" | "points"
export type EventConditionType =
  | "always"
  | "has_profile"
  | "has_feature"
  | "code"
  | "lottery"
  /** 点 GitHub star：用户填自己的 GitHub 用户名，服务端去仓库的 stargazers 名单里核验 */
  | "github_star"

// ---- 账号监管（封禁申诉 + 风险账户）----

/** 封禁申诉（管理端列表用） */
export interface AccountAppeal {
  id: string
  userId: string | null
  username: string
  contact: string | null
  content: string
  status: "pending" | "accepted" | "rejected"
  reviewNote: string | null
  reviewedBy: string | null
  ip: string | null
  createdAt: string
  reviewedAt: string | null
  /** 该账号当前在 cloud 侧的状态（suspended = 仍在封禁中） */
  userStatus: string | null
}

/** 管理员对申诉的回复（**用户端**用：登录后强制弹窗展示，直到用户确认已读） */
export interface AppealPendingReply {
  id: string
  status: "pending" | "accepted" | "rejected"
  reviewNote: string
  createdAt: string
  reviewedAt: string | null
}

/** 可要求的捐献渠道（通知门槛）。语义是「任选其一」 */
export type DonationChannel = "wb" | "frp" | "proxy"

/** 管理端通知：用户侧待确认的一条 */
export interface PendingNotice {
  id: string
  title: string
  body: string
  createdAt: string
  /** 发布时勾选的要求渠道；空数组 = 无门槛 */
  donationRequired: DonationChannel[]
  /** 其中还没满足的渠道；非空 = 权限仍锁着，捐完才能解锁 */
  donationMissing: DonationChannel[]
}

/** 管理端通知（列表条目） */
export interface AdminNotice {
  id: string
  username: string
  title: string
  body: string
  restrictFeatures: string[]
  /** 要求捐献的渠道（任选其一即可解锁） */
  requireDonation: DonationChannel[]
  newapiDisabled: boolean
  creator: string | null
  createdAt: string
  readAt: string | null
  revokedAt: string | null
}

/** 风险账户（定时扫描中转站日志写入） */
export interface RiskAccount {
  userId: string
  username: string
  riskLevel: "low" | "medium" | "high"
  score: number
  /** JSON 字符串（字符串数组），前端解析后逐条展示 */
  reasons: string | null
  peakPerMin: number
  requests7d: number
  firstSeenAt: string
  lastSeenAt: string
  status: "open" | "watching" | "banned" | "cleared"
  userStatus: string | null
}

// ---- 监管：白名单 / 自动条件 / 黑名单（2026-10-03） ----

export type ModerationConditionOp = "gt" | "gte" | "lt" | "lte"
export type ModerationConditionMetric = "achievement_points" | "custom_title"

/** 白名单里的用户（展示成「昵称 @用户名」，与「自定义称号」面板一致） */
export interface ModerationWhitelistUser {
  username: string
  nickname: string | null
}

/** 白名单自动条件（如「成就点 > 20」）及其命中的用户 */
export interface ModerationWhitelistCondition {
  id: string
  metric: ModerationConditionMetric
  op: ModerationConditionOp
  value: number
  enabled: boolean
  users: ModerationWhitelistUser[]
}

export interface ModerationLists {
  whitelist: {
    /** 手动添加的用户 */
    manual: ModerationWhitelistUser[]
    /** 自动条件分组（含已停用的，停用时 users 为空） */
    groups: ModerationWhitelistCondition[]
  }
  blacklist: {
    manual: ModerationBlacklistEntry[]
    /** 封禁联动自动加入的 IP */
    auto: ModerationBlacklistEntry[]
  }
}

export interface ModerationBlacklistEntry {
  ip: string
  reason: string | null
  createdAt: string
}

/** 活动发布/更新请求体 */
export interface EventPayload {
  title: string
  body: string
  status: EventStatus
  startsAt: string | null
  endsAt: string | null
  /** 定时发布时间（ISO）；status = scheduled 时必填 */
  publishAt: string | null
  /** 限量总份数；null = 不限量 */
  maxClaims: number | null
  rewardLabel: string | null
  rewardType: EventRewardType
  rewardParams: Record<string, unknown> | null
  conditionType: EventConditionType
  conditionParams: Record<string, unknown> | null
}

export interface EventClaim {
  id: string
  userId: string
  username: string | null
  nickname: string | null
  rewardType: string
  rewardStatus: string
  rewardDetail: string | null
  claimedAt: string
  grantedAt: string | null
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

// ---- 用户反馈（私有工单）----

/** 反馈分类 / 状态选项（键与中文标签都由服务端下发，前端不硬编码文案） */
export interface FeedbackOption {
  key: string
  label: string
}

/** 反馈对话中的一条消息 */
export interface FeedbackMessage {
  id: string
  senderId: string
  isAdmin: boolean
  body: string
  /** 附带的图片（访问 URL 数组） */
  images: string[]
  createdAt: string
  /**
   * 发送者资料（头像 / 昵称 / 用户名 / 角色徽章 / 自定义称号），
   * 形状与社区广场的 CommunityAuthor 一致（2026-10-05：反馈要能看出是谁回复的）。
   * username 为空串表示发送者已被删除（前端按「已注销用户」展示）。
   */
  sender: CommunityAuthor
}

/** 用户视角的一条反馈（不含作者 id 等内部字段） */
export interface FeedbackItem {
  id: string
  category: string
  title: string
  body: string
  /** 首次提交附带的图片（访问 URL 数组） */
  images: string[]
  status: string
  /** 管理员回复；null = 还没回复 */
  adminReply: string | null
  repliedAt: string | null
  /** 回复是否已被我读过（无回复时恒为 false） */
  replyRead: boolean
  createdAt: string
  updatedAt: string
  /** 对话消息（用户与管理员的追加回复，按时间正序） */
  messages: FeedbackMessage[]
}

/** 管理端视角：多带作者信息 */
export interface AdminFeedbackItem extends FeedbackItem {
  userId: string
  username: string
  nickname: string | null
}

export interface FeedbackOverview {
  feedback: FeedbackItem[]
  categories: FeedbackOption[]
  statusLabels: Record<string, string>
  /** 管理员回复过、但我还没读的条数（页面角标用） */
  unreadReplies: number
}

/** 管理审计时间线的一条记录（GET /api/admin/audit） */
export interface AdminAuditItem {
  id: string
  action: string
  detail: string
  ip: string | null
  createdAt: string
  /** 操作者（JOIN users 得到） */
  username: string
  nickname: string | null
  role: string
}

/** 管理审计时间线响应 */
export interface AdminAuditData {
  items: AdminAuditItem[]
  total: number
  page: number
  pageSize: number
  /** 当前筛选范围下的操作类型分布（筛选下拉用） */
  actions: { action: string; c: number }[]
}

export interface AdminFeedbackOverview {
  feedback: AdminFeedbackItem[]
  /** 各状态的条数，如 { pending: 2, resolved: 5 } */
  counts: Record<string, number>
  categories: FeedbackOption[]
  statusLabels: Record<string, string>
}

// ---- 积分系统 ----
//
// 积分是**落库的余额**（每 1 积分值多少元由后台配置，支持小数），与「成就点」无关：
// 成就点是实时算出的荣誉值、不能花；积分能在积分商城里兑换中转站余额或换商品。

/** 一条积分流水 */
export interface PointTransaction {
  id: string
  /** 正数=增加，负数=减少 */
  delta: number
  /** 变动后的余额快照 */
  balance: number
  /** 来源/去向：event=活动 / admin=管理员 / redeem=兑换 / shop=商城购买 */
  reason: string
  detail: string | null
  createdAt: string
}

/** 兑换参数（管理端「商城」标签与用户端都用它展示比例） */
export interface PointsConfig {
  /** 兑换总开关（关闭后仍可看余额与流水，只是不能兑换） */
  enabled: boolean
  /** **每 1 积分值多少元**（默认 1，支持小数） */
  yuanPerPoint: number
  /** 每日兑换次数上限（0 = 不限） */
  dailyLimit: number
}

/**
 * 交付方式：
 *   · manual       —— 人工发放（下单后等管理员处理）
 *   · quota        —— 自动充入 AI 中转站余额（金额取 quotaYuan）
 *   · feature      —— 自动授予一个模块权限（deliveryParams.feature）
 *   · subscription —— 自动开通一个 NewAPI 订阅套餐（deliveryParams.planId）
 *   · invite_quota —— 自动增加邀请码创建额度（deliveryParams.count）
 *   · code         —— 卡密/Key：从卡密池取一条**各不相同**的发给买家（一人一条）
 *   · content      —— 统一内容：发一段**人人相同**的固定内容（deliveryParams.content）
 */
export type PointDelivery =
  | "manual"
  | "quota"
  | "feature"
  | "subscription"
  | "invite_quota"
  | "code"
  | "content"

/** 交付参数：每种方式只用到其中一个字段（quota 走 quotaYuan，不用这里） */
export interface PointDeliveryParams {
  /** delivery='feature'：要授予的模块 */
  feature?: FeatureKey
  /** delivery='subscription'：NewAPI 套餐 id（管理员自己填） */
  planId?: number
  /** delivery='invite_quota'：增加的邀请码创建额度 */
  count?: number
  /** delivery='content'：人人相同的固定交付内容（网盘链接 / 说明 / 通用兑换码） */
  content?: string
}

/** 用户商品的审核状态；官方商品恒为 'approved' */
export type PointReviewStatus = "pending" | "approved" | "rejected"

/**
 * 计费方式：
 *   · one_time —— 买断（一次性付清，永久拥有）
 *   · rental   —— 租用（付一次租金用 N 天，到期自动收回权益）
 *
 * 租用只对「可收回」的交付方式开放（manual / feature / subscription）；
 * `quota`（充余额）与 `invite_quota`（邀请码额度）是一次性发出去的，收不回来，
 * 服务端会拒绝把它们设为租用（错误码 RENTAL_NOT_SUPPORTED）。
 */
export type PointBillingMode = "one_time" | "rental"

/** 商城里的一个商品（官方 / 用户上架共用同一个结构） */
/** 用户商品分类（2026-10-01：先分 IT / 其他） */
export type ProductCategory = "it" | "other"

/** 分类的展示名（i18n key）；新增分类时只改这里 + 两份词典 */
export const PRODUCT_CATEGORY_LABELS: Record<ProductCategory, string> = {
  it: "pt.cat.it",
  other: "pt.cat.other",
}

export interface PointProduct {
  id: string
  name: string
  description: string
  imageUrl: string | null
  /** 分类：it / other（2026-10-01 加，暂只有这两类） */
  category: ProductCategory
  /**
   * 内置图标名（lucide slug，如 'gift'）。与 imageUrl 互补：**imageUrl 优先**，
   * 没填图片才用图标；两个都没有时卡片上回退成默认图标。
   */
  icon: string | null
  /** 售价（积分） */
  price: number
  /** 剩余库存；null = 不限量 */
  stock: number | null
  /** 每日限量（自然日）；null = 不限 */
  dailyLimit: number | null
  /** 今日已售数（与后端每日限量计数同口径 UTC 日）；无每日限时恒 0 */
  dailySold: number
  /** 每人限购件数；null = 不限 */
  perUserLimit: number | null
  delivery: PointDelivery
  /** delivery=quota 时每件充入多少元 */
  quotaYuan: number | null
  /** 其余自动交付方式各自的参数；quota / manual 时为 null */
  deliveryParams: PointDeliveryParams | null
  enabled: boolean
  sort: number
  /** 上架者 id；**null = 官方商品**（站长上架） */
  ownerId: string | null
  /** 上架时的用户名快照（用户商品才有） */
  ownerName: string | null
  reviewStatus: PointReviewStatus
  /** 审核意见（拒绝时写给用户看） */
  reviewNote: string | null
  reviewedAt: string | null
  /** 计费方式：买断 / 租用（老数据一律 'one_time'） */
  billingMode: PointBillingMode
  /** 租期天数；`billingMode='one_time'` 时为 null */
  rentalDays: number | null
  createdAt: string
  updatedAt: string
}

/**
 * 订单状态：
 *   · pending   —— 待发放（官方）／待卖家交付（用户商品，积分托管中）
 *   · delivered —— 已发放（官方，终态）／卖家已交付、等买家确认（用户商品）
 *   · settled   —— 仅用户商品：买家已确认收货，积分已结算给卖家（终态）
 *   · cancelled —— 已取消，积分已退回买家（终态）
 */
export type PointOrderStatus = "pending" | "delivered" | "settled" | "cancelled"

/**
 * 售后（退款）状态 —— 与订单状态**正交**。
 *
 * 订单状态说「交易走到哪」，售后状态说「退款诉求走到哪」。
 * 退款成立时订单同时变成 `cancelled`（积分原路退回）。
 */
export type AfterSaleStatus = "requested" | "rejected" | "platform" | "closed" | "refunded"

/** 一笔商城订单 */
export interface PointOrder {
  id: string
  userId: string
  username: string
  productId: string | null
  /** 下单时的商品名快照 */
  productName: string
  price: number
  delivery: string
  quotaYuan: number | null
  status: PointOrderStatus
  note: string | null
  /**
   * 交付内容快照（仅 delivery='content' / 'code' 的订单非 null）。
   *
   * 与 `note` 分开：note 是列表里一行摘要（多处截断到 300 字），
   * 而这是买家**买到的东西**本身（最长 2000 字、可能多行），要能反复查看。
   */
  deliveryContent: string | null
  /** 卖家 id（下单时快照）；**null = 官方商品订单** */
  sellerId: string | null
  sellerName: string | null
  createdAt: string
  deliveredAt: string | null
  /** 积分结算给卖家的时间（仅用户商品订单） */
  settledAt: string | null
  /** 自动充值 / 用户商品订单为 null；人工发放的记录管理员 id */
  deliveredBy: string | null
  /** 下单时的计费方式快照（买断 / 租用） */
  billingMode: PointBillingMode
  /** 下单时的租期天数快照；买断订单为 null */
  rentalDays: number | null
  /**
   * 租用订单的到期时间；**买断订单恒为 null**。
   *
   * 到期**不会**把 status 改成别的（delivered / settled 是历史事实），
   * 「是否已到期」由 `expiresAt < now` 派生判断。
   */
  expiresAt: string | null
  /** 续费时指向被顺延的原订单 id（追溯用） */
  renewedFrom: string | null
  /** 到期处理（收回权益）的时间；null = 还没处理过 */
  expireHandledAt: string | null
  /** 本单实际授予的模块权限名（仅 delivery='feature' 时非空） */
  grantedFeature: string | null
  /** 售后状态；null = 没有进行中的售后 */
  afterSaleStatus: AfterSaleStatus | null
  /** 买家申请退款时填写的理由 */
  afterSaleReason: string | null
  /** 售后处理意见：卖家的拒绝理由 / 平台的判定说明 */
  afterSaleNote: string | null
  /** 买家申请退款（最近一次）的时间 */
  afterSaleRequestedAt: string | null
  /** 售后终结（退款 / 驳回）的时间 */
  afterSaleResolvedAt: string | null
}

/** GET /api/points 响应 */
export interface PointsOverview {
  balance: number
  config: PointsConfig
  transactions: PointTransaction[]
  /** 官方商品（已上架） */
  products: PointProduct[]
  /** 别人上架的商品（已上架 + 审核通过） */
  userProducts: PointProduct[]
  /** 我上架的商品（含待审核 / 被拒 / 已下架） */
  myProducts: PointProduct[]
  /** 我的订单（最近 50 笔） */
  orders: PointOrder[]
  /** 我收到的订单（我是卖家） */
  sellerOrders: PointOrder[]
  /** 是否已绑定中转站账号（未绑定不能兑换 / 不能买自动充值商品） */
  bound: boolean
}

/** POST /api/points/redeem 响应 */
export interface PointsRedeemResult {
  ok: true
  balance: number
  /** 本次兑换到账的金额（元） */
  amount: number
  /** 币种符号 */
  symbol: string
  detail: string
}

/** 管理端积分总览里的一个用户 */
export interface AdminPointsUser {
  id: string
  /** 按注册顺序的展示用编号（老数据可能为 null） */
  uid: number | null
  username: string
  email: string
  nickname: string | null
  role: string
  status: string
  createdAt: string | null
  balance: number
  updatedAt: string | null
}

/** GET /api/admin/points 响应 */
export interface AdminPointsOverview {
  users: AdminPointsUser[]
  stats: {
    /** 累计发放（**不含**用户商城的卖家收益 —— 那是用户间的转移，不是平台增发） */
    issued: number
    /** 累计消耗（兑换 + 商城购买） */
    redeemed: number
    /** 用户商城的累计成交额（买家付出的积分总和） */
    traded: number
    /** 列表内用户手上的积分总量 */
    holding: number
    /** 持有积分（>0）的人数 */
    holders: number
  }
}

/** GET /api/admin/points/shop 响应（商城标签页一次拿齐） */
/**
 * 一档捐献奖励（服务端下发，带中文名与固定顺序）。
 *
 * 刻意下发数组而不是 `{ key: 分数 }`：档位清单与名字只在服务端维护一份，
 * 前端照着渲染，不会出现两边各写一份而漂移。
 */
export interface DonationRewardItem {
  /** 档位键：ai / sensenova / frp / proxy / workbuddy / qoder / trae */
  key: string
  /** 中文名，如「Qoder 反代账号」 */
  label: string
  /** 该档位发放的积分数（0 = 不发） */
  points: number
}

export interface AdminShopData {
  /** 官方商品（可编辑 / 上下架） */
  products: PointProduct[]
  /** 用户上架的商品（走审核流程，不能直接编辑） */
  userProducts: PointProduct[]
  orders: PointOrder[]
  config: PointsConfig
  /** 各档位的捐献奖励积分数 */
  donationRewards: DonationRewardItem[]
  /** 捐献奖励的每人每日发放次数上限（0 = 不限） */
  donationDailyLimit: number
  /** 邀请奖励 / 返佣的旋钮（编辑入口：商城 → 「邀请奖励」） */
  inviteConfig: InvitePointsConfig
}

/**
 * 邀请奖励 / 返佣配置。
 *
 * 两笔账都发给**邀请人**：
 *   · `perFriend` —— 每成功邀请 1 个好友注册得多少分（一次性）
 *   · `commissionPercent` —— 被邀请人之后赚到分时，邀请人抽成百分之几（**一级**）
 *
 * ⚠️ 与 `PointsConfig.yuanPerPoint` 联动：「1 积分 = 10 元」时，20 分 = 200 元。
 */
export interface InvitePointsConfig {
  /** 总开关 */
  enabled: boolean
  /** 每邀请 1 人得的积分（0 = 不发） */
  perFriend: number
  /** 返佣比例（%），0 = 关闭 */
  commissionPercent: number
  /** 每人每日通过邀请（奖励 + 返佣）最多拿多少分，0 = 不限 */
  dailyLimit: number
  /** 是否只把「真正消耗了次数」的邀请算作有效邀请 */
  requireConsumed: boolean
}

/** 新建 / 编辑官方商品时提交的字段 */
export interface PointProductPayload {
  name: string
  description: string
  imageUrl: string | null
  icon: string | null
  category: ProductCategory
  price: number
  stock: number | null
  /** 每日限量（自然日）；null = 不限 */
  dailyLimit: number | null
  perUserLimit: number | null
  delivery: PointDelivery
  quotaYuan: number | null
  deliveryParams: PointDeliveryParams | null
  /** 计费方式：买断 / 租用 */
  billingMode: PointBillingMode
  /** 租期天数；`billingMode='rental'` 时必填（1 ~ 3650），买断传 null */
  rentalDays: number | null
  enabled: boolean
  sort: number
}

/**
 * 用户上架 / 编辑自己的商品时提交的字段。
 *
 * 比官方商品少很多：交付方式固定人工、没有限购 / 排序，归属与审核状态由服务端决定
 * （用户传了也会被忽略）。
 */
export interface UserProductPayload {
  name: string
  description: string
  imageUrl: string | null
  icon: string | null
  category: ProductCategory
  price: number
  stock: number | null
  /**
   * 交付方式（2026-10-04 放开自动发货）：用户商品允许 manual / code / content。
   * 其余自动方式（权限 / 订阅 / 额度）是平台能力，后端会直接拒绝。
   */
  delivery: PointDelivery
  /** delivery='content' 时人人相同的固定内容 */
  deliveryParams: PointDeliveryParams | null
  /** 计费方式：买断 / 租用（用户商品也能租 —— 但只有人工交付可租） */
  billingMode: PointBillingMode
  /** 租期天数；`billingMode='rental'` 时必填（1 ~ 3650），买断传 null */
  rentalDays: number | null
  enabled: boolean
}

// ---- 角标汇总 ----

/**
 * 当前用户「需要注意」的计数汇总（`GET /api/attention`）。
 *
 * 一次请求同时喂两处 UI：
 *   · 侧边栏 —— 社区广场 / 聊天室 / 反馈 各自角标，以及「管理」入口的总角标
 *   · 管理面板 —— 各栏目自己的角标（反馈、捐献、积分）
 *
 * 三个用户侧字段的口径都是「我看过之后新增的」，进对应页面即清零：
 *   · community —— 我看过之后别人发的新帖
 *   · chat      —— 我看过之后别人发的新消息（含 QQ 群同步进来的）
 *   · feedback  —— 管理员回复过、但我还没读的反馈
 */
export interface AttentionCounts {
  community: number
  chat: number
  feedback: number
  /** 仅管理员（admin/root）有；普通用户为 null，前端据此决定是否渲染管理角标 */
  admin: {
    /** 下列各项之和，用于侧边栏「管理」入口的总角标 */
    total: number
    /** 待处理反馈 */
    feedback: number
    /** 待审核捐献 */
    donations: number
    /** 用户上传的商品待审核（官方商品建时即 approved，不计入） */
    pointProducts: number
    /** 活动奖励里「自动发放失败、要人工发」的条数 */
    eventClaims: number
    /** 内网穿透申请待审核（用户提交后等管理员批） */
    frpApplications: number
    /** 待处理的封禁申诉（2026-10-02） */
    appeals: number
  } | null
}

// ---- 一对一私信（2026-10-01）----

/** 私信里的对端（另一个用户） */
export interface DmPeer {
  id: string
  username: string
  nickname: string | null
  hasAvatar: boolean
}

export interface DmMessage {
  id: string
  fromUserId: string
  toUserId: string
  body: string
  createdAt: string
  /** 收件人读这条的时间；null = 未读 */
  readAt: string | null
  /** 引用的消息 id（null = 非引用）；撤回的消息服务端会置空 */
  replyTo?: string | null
  /** 被引用消息的摘要（list 接口批量补全） */
  quote?: ChatQuoteRef | null
  /** 是否已撤回（撤回后 body 为空） */
  recalled?: boolean
  /** 乐观字段：仅本地待发消息携带（undefined = 服务端已确认） */
  status?: PendingSendStatus
  /** 乐观字段：本地幂等键，服务端确认后据此原位替换 */
  clientId?: string
}

/** 我收到的一条待处理「聊天申请」（2026-10-01） */
/** 我持有的一个称号（个人空间里可切换对外展示哪一个；2026-10-01） */
export interface MyTitle {
  id: string
  name: string
  colorFrom: string
  colorTo: string
  isDisplay: boolean
  grantedAt: string
}

export interface DmRequest {
  peer: DmPeer
  /** 对方发来的申请消息（陌生人的第一条，也是同意前唯一能发的一条） */
  body: string
  createdAt: string
}

export interface DmConversation {
  peer: DmPeer
  /** 最近一条消息（列表预览用） */
  last: { body: string; createdAt: string; /** 是不是我发的 */ mine: boolean }
  /** 我在这条会话里还没读的数量 */
  unread: number
}

// ---- 管理面板 · DNS 解析管理（2026-10-01）----
//
// 为什么单独一套类型，而不复用 Domains 页的 DnsRecord：
// 用户侧看到的是「我自己的记录」，管理侧还要带**归属用户**与**风险判断**，
// 后者是服务端按规则引擎算出来的（assessRecord），不属于用户侧的语义。

/** 风险等级：high = 明确滥用形态，medium = 可疑，low = 信息性提示 */
export type DnsSeverity = "high" | "medium" | "low"

/** 命中的一条规则 */
export interface AdminDnsFinding {
  /** 规则 id（private-ip / forward-domain / third-party-hosting…） */
  rule: string
  severity: DnsSeverity
  /** 为什么这条有问题（中文说明） */
  detail: string
  /** 站长已将其标记为忽略 */
  ignored: boolean
}

export interface AdminDnsRecord {
  id: string
  fqdn: string
  name: string
  type: string
  content: string
  ttl: number
  proxied: boolean
  priority: number | null
  srv: { weight: number; port: number; target: string } | null
  status: string
  /** 本地是否关联了 Cloudflare 记录（false = 实际不生效） */
  hasCf: boolean
  subdomainId: string | null
  createdAt: string
  updatedAt: string
  /** 归属用户（LEFT JOIN users） */
  username: string | null
  uid: number | null
  /** 归属用户账号状态：banned = 已封禁但解析记录还在 */
  userStatus: string | null
  /** 归属域名（xxx.doulor.cn） */
  domain: string | null
  risks: AdminDnsFinding[]
  /** 未忽略风险里的最高等级；null = 干净 */
  topSeverity: DnsSeverity | null
}

/** 上一次合规扫描的快照 */
export interface AdminDnsAuditRun {
  ranAt: string
  mode: string
  scanned: number
  found: number
  high: number
  medium: number
  low: number
  note: string | null
}

export interface AdminDnsListResponse {
  records: AdminDnsRecord[]
  total: number
  page: number
  pageSize: number
  /** 记录数超过服务端单次评估上限，统计与筛选只覆盖已评估的部分 */
  truncated: boolean
  stats: {
    high: number
    medium: number
    low: number
    clean: number
    scanned: number
    openFindings: number
  }
  lastRun: AdminDnsAuditRun | null
}

/** 落库的扫描发现项（可处置：忽略 / 恢复） */
export interface AdminDnsFindingRow {
  id: string
  recordId: string | null
  fqdn: string
  type: string
  content: string
  username: string | null
  rule: string
  severity: DnsSeverity
  detail: string
  status: "open" | "ignored" | "resolved"
  firstSeenAt: string
  lastSeenAt: string
  reviewedBy: string | null
  reviewedAt: string | null
  note: string | null
}

export interface AdminDnsFindingsResponse {
  findings: AdminDnsFindingRow[]
  total: number
  page: number
  pageSize: number
  /** 审计表是否已建（false = 迁移 0092 还没执行） */
  tableReady: boolean
  counts?: { open: number; ignored: number; resolved: number }
  lastRun: AdminDnsAuditRun | null
  message?: string
}

export interface AdminDnsAuditSummary {
  ranAt: string
  mode: string
  scanned: number
  found: number
  high: number
  medium: number
  low: number
  /** 本次新出现的问题数 */
  fresh: number
  note?: string
}

/** 本地台账 vs Cloudflare 实际记录的对账结果 */
export interface AdminDnsCfDiff {
  cfTotal: number
  dbTotal: number
  /** 被识别为平台自建（Worker 路由 / 邮件鉴权 / 根域）并排除的条数 */
  platformManaged: number
  checkedAt: string
  note: string
  onlyInCf: {
    id: string
    name: string
    type: string
    content: string
    proxied: boolean
    hint: string | null
  }[]
  onlyInDb: {
    id: string
    fqdn: string
    type: string
    content: string
    status: string
    username: string | null
    cfId: string | null
    reason: string
  }[]
}

/**
 * 用户自定义表情包（社区 / 私信编辑器里快捷发送）。
 *
 * `url` 形如 `/s/<id>`：id 是 uuid ⇒ 内容与 URL 一一对应、永不变，
 * 所以取图那边可以放心用一年 immutable 缓存。
 */
export interface Sticker {
  id: string
  url: string
  contentType: string
  bytes: number
  createdAt: string
}

/** 管理员权限树：分组 → 大类 → 子项（后端权威下发，前端不硬编码） */
export interface AdminPermGroup {
  key: string
  label: string
}

export interface AdminPermLeaf {
  key: string
  label: string
  rootOnly?: boolean
}

export interface AdminPermCategory {
  key: string
  label: string
  group: string
  children?: AdminPermLeaf[]
}

/** 权限组（一套权限 + 成员数） */
export interface AdminPermissionGroup {
  id: string
  name: string
  scope: string[]
  memberCount: number
  createdAt: string
}

/** 某成员的管理权限现状 */
export interface AdminPermissionsState {
  userId: string
  username: string
  role: string
  adminRoleId: string | null
  adminRoleName: string | null
  adminScope: string[]
  /** true = admin_scope 覆盖了权限组（前端标记「自定义」） */
  custom: boolean
}
