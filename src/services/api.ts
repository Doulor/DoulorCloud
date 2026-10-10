import {
  type AdminInvite,
  type AdminInviteTrace,
  type AdminSettings,
  type AdminUser,
  type AdminUserDetail,
  type AdminPermGroup,
  type AdminPermCategory,
  type AdminPermissionGroup,
  type AdminPermissionsState,
  type ApiError,
  type Announcement,
  type AnnouncementStatus,
  type AchievementsResponse,
  type SpaceData,
  type SpaceCardData,
  type MySpaceSettings,
  type RootDomainOption,
  type LeaderboardBoard,
  type LeaderboardResponse,
  type CommunityMetric,
  type LeaderboardRange,
  type DnsRecord,
  type DnsRecordType,
  type Donation,
  type DonationChannel,
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
  type NewApiModels,
  type NewApiStatus,
  type StorageAccount,
  type StorageList,
  type StorageShare,
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
  type CommunityConfig,
  type AdminCommunityPost,
  type AdminNewApiConfig,
  type AdminNewApiCredentialSource,
  type Wb2ApiStatus,
  type Wb2ApiLoginStart,
  type Wb2ApiLoginPoll,
  type AdminWb2ApiBinding,
  type AdminWb2ApiConfig,
  type AdminWb2ApiPool,
  type Qoder2ApiStatus,
  type Qoder2ApiLoginStart,
  type Qoder2ApiLoginPoll,
  type AdminQoder2ApiBinding,
  type AdminQoder2ApiConfig,
  type AdminQoder2ApiPool,
  type FeedbackOverview,
  type AdminFeedbackOverview,
  type AdminFeedbackItem,
  type FeedbackItem,
  type MessageCategory,
  type EventItem,
  type EventClaim,
  type EventPayload,
  type AccountAppeal,
  type ModerationLists,
  type ModerationConditionMetric,
  type ModerationConditionOp,
  type AppealPendingReply,
  type PendingNotice,
  type AdminNotice,
  type RiskAccount,
  type PointsOverview,
  type PointsRedeemResult,
  type PointsConfig,
  type PointTransaction,
  type PointOrder,
  type PointProduct,
  type PointProductPayload,
  type PublicPurchase,
  type UserProductPayload,
  type AdminPointsOverview,
  type AdminShopData,
  type DonationRewardItem,
  type InvitePointsConfig,
  type AttentionCounts,
  type DmRequest,
  type MyTitle,
  type DmPeer,
  type DmMessage,
  type DmConversation,
  type AdminDnsListResponse,
  type AdminDnsRecord,
  type AdminDnsFindingsResponse,
  type AdminDnsAuditSummary,
  type AdminDnsCfDiff,
  type AdminSubdomain,
  type AdminSubdomainListResponse,
  type AdminMailbox,
  type AdminMailboxListResponse,
  type AdminMailboxMessage,
  type AdminMailboxMessageDetail,
  type Sticker,
} from "@/types"
import type { FunLinkCategory } from "@/lib/fun-links"
import { tStatic, translateApiMessage } from "@/i18n"

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

/**
 * 通知全局：当前账号**未验证邮箱**，这次功能请求被服务端拦下了
 * （规则见 `worker/src/auth.ts` 的 EMAIL_VERIFY_REQUIRED_PREFIXES）。
 *
 * 为什么需要：未验证用户在功能页点按钮会收到 403「请先验证邮箱后再使用该功能」，
 * 但零散的 toast 只告诉他"不行"，不告诉他"去哪验证"。dashboard 外壳监听本事件后
 * 会直接把「验证邮箱」对话框弹出来，点一次就能收到验证码。
 */
function notifyEmailUnverified() {
  window.dispatchEvent(new Event("auth:email-unverified"))
}

export class HttpError extends Error {
  status: number
  code?: string
  /**
   * 原始响应体（2026-10-02 加）。
   *
   * 有些错误除了 `error` / `code` 还会**带回用户需要的信息** ——
   * 典型是登录时账号被封禁：响应里带着封禁原因和上次申诉的处理结果，
   * 登录页要把它展示出来（用户此刻拿不到会话，没有别的渠道能看到）。
   */
  detail?: Record<string, unknown>

  constructor(
    status: number,
    message: string,
    code?: string,
    detail?: Record<string, unknown> | null
  ) {
    super(message)
    this.name = "HttpError"
    this.status = status
    this.code = code
    this.detail = detail ?? undefined
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
  if (err instanceof TypeError) return tStatic("api.networkError")
  return fallback
}

/**
 * 把非 2xx 响应按统一规则翻译并抛 HttpError。
 *
 * 抽出来是因为请求分两条路：普通 JSON 请求（request）与流式请求（requestStream）——
 * 错误处理必须共用一份，否则「会话失效登出」「邮箱未验证弹窗」这类副作用
 * 会在某一条路上悄悄漏掉（行为漂移）。
 */
async function throwHttpError(res: Response): Promise<never> {
  const data = await res.json().catch(() => null)
  // 后端 message 一律是中文（worker 侧既是给用户看的、也是运维/日志原文），
  // 所以在这里就地翻一次：翻不到会原样返回，不影响任何错误处理逻辑。
  // 放在**构造 HttpError 的地方**而不是每个调用点 —— 全站 `err.message` 的用法
  // 有一百多处（`err instanceof HttpError ? err.message : t("…")`），逐个改必漏。
  const raw = (data as ApiError | null)?.error
  const message = raw
    ? translateApiMessage(raw)
    : tStatic("api.requestFailed", { status: res.status })
  const code = (data as ApiError | null)?.code

  // 仅在「会话本身失效」时清空用户态。
  // 不能对所有 401 一律登出：登录密码错误、修改密码时当前密码错误
  // 同样是 401（code=INVALID_CREDENTIALS），误判会把正常用户直接踢下线。
  const sessionExpired =
    res.status === 401 && (code === undefined || code === "UNAUTHORIZED")
  if (sessionExpired) {
    notifySessionExpired()
  }

  // 邮箱未验证：功能接口被服务端拦下（见 worker/src/auth.ts 的
  // EMAIL_VERIFY_REQUIRED_PREFIXES），广播一次让外壳弹出验证对话框。
  // 仍然照常抛错，调用方原有的错误处理不受影响。
  if (res.status === 403 && code === "EMAIL_NOT_VERIFIED") {
    notifyEmailUnverified()
  }

  // 完整响应体一并带进异常：有些错误除了文案还要**把用户需要的信息**传出去
  // （如登录时账号被封禁 → 封禁原因与申诉处理结果，见 login.tsx 的展示）
  throw new HttpError(res.status, message, code, data as Record<string, unknown> | null)
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

  if (!res.ok) {
    await throwHttpError(res)
  }

  if (res.status === 204) {
    return undefined as T
  }

  const data = await res.json().catch(() => null)

  // 200 但响应体不是 JSON（例如静态站点把 /api 请求兜底成了 index.html）。
  // 此时 data 是 null，若直接返回会让调用方在 `res.posts` 上抛 TypeError，
  // 用户看到的是白屏而不是可理解的错误。这里统一转成 HttpError。
  if (data === null) {
    throw new HttpError(res.status, tStatic("api.invalidResponse"), "INVALID_RESPONSE")
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
    request<{
      openRegistration: boolean
      until: string | null
      /**
       * 当前「发给用户的根域」（root_domains 的默认行，如 tyu.me）。
       * 注册页要用它显示「你会拿到 username.<域>」—— 那是管理员可改的，
       * 写死 doulor.cn 会在换域后给新用户展示错误地址。
       */
      defaultRootDomain: string
    }>("/register-status"),

  /**
   * 登录第一步（口令）。
   *
   * 返回有两种形态：
   * · 普通结果 —— `{ user, pendingReply, mustSetupTwoFactor }`，登录已完成；
   * · **需要二次验证** —— `{ needTwoFactor: true, challengeId, methods, maskedEmail }`，
   *   此时**还没有登录态**，必须再调 `twoFactorApi.verifyLogin` 才算登录成功。
   *
   * 用 `needTwoFactor` 做判别字段，前端据此切换界面。
   */
  login: (payload: { identifier: string; password: string }) =>
    request<{
      user?: MeResponse["user"]
      pendingReply?: unknown
      /** 该账号被要求开 2FA 但还没配 —— 登录照样成功，前端引导去设置页 */
      mustSetupTwoFactor?: boolean
      /** 需要二次验证；此时 user 为空、也没有 cookie */
      needTwoFactor?: boolean
      challengeId?: string
      methods?: string[]
      maskedEmail?: string
    }>("/login", {
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

/**
 * 排行榜。
 *
 * `metric` 只对 `board=community` 有意义（后端忽略其余榜的该参数）。
 */
export const leaderboardApi = {
  get: (board: LeaderboardBoard, metric?: CommunityMetric, range?: LeaderboardRange) => {
    const qs = new URLSearchParams({ board })
    if (metric) qs.set("metric", metric)
    if (range && range !== "all") qs.set("range", range)
    return request<LeaderboardResponse>(`/leaderboard?${qs.toString()}`)
  },
}

/**
 * 当前「发给用户的根域」（如 tyu.me），带模块级缓存。
 *
 * 为什么单独开一个函数而不是让各页面各自 request：`用户名.<根域>` / `用户名@<根域>`
 * 在注册页、概览、设置里都要显示，挨个 fetch 会白打几次网络；更关键的是
 * **这个域名是管理员可改的** —— 2026-10-02 从 doulor.cn 整体迁到 tyu.me 时，
 * 凡是对它硬编码的地方都开始显示错地址。
 *
 * 失败时抛出，调用方自行回落（通常显示空串，别闪一个错域名）。
 */
let defaultRootDomainCache: string | null = null
let defaultRootDomainInflight: Promise<string> | null = null

export async function getDefaultRootDomain(): Promise<string> {
  if (defaultRootDomainCache) return defaultRootDomainCache
  if (!defaultRootDomainInflight) {
    defaultRootDomainInflight = authApi
      .registerStatus()
      .then((res) => {
        defaultRootDomainCache = res.defaultRootDomain
        return res.defaultRootDomain
      })
      .finally(() => {
        defaultRootDomainInflight = null
      })
  }
  return defaultRootDomainInflight
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
      /** 可选的根域（后端按权限筛过；没权限的不会出现在这里） */
      rootDomains: RootDomainOption[]
    }>("/subdomains"),

  /** parentId 省略 → 建一级子域名；指定 → 在该子域名下建子子域名 */
  create: (payload: { name: string; parentId?: string; rootDomain?: string }) =>
    request<{ subdomain: Subdomain }>("/subdomains", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  remove: (id: string) =>
    request<void>(`/subdomains/${id}`, { method: "DELETE" }),
}

// ---- 管理员 ----

/** 管理端 · AI 实验室的一条免费渠道（密钥永不回明文，只给尾号） */
export interface AdminLabChannel {
  id: string
  name: string
  baseUrl: string
  /** 该渠道固定的模型名；空串表示沿用用户在站内选的模型 */
  model: string
  hasKey: boolean
  keyTail: string
}

/** 管理端 · AI 实验室配置 */
export interface AdminLabConfig {
  /** user = 各用户自己的额度；admin = 全站统一用管理员提供的 Key */
  aiSource: "user" | "admin"
  /** 选了 admin 但没配 Key（后端会自动退回按用户扣费）—— 面板要红字提示 */
  adminUnavailable: boolean
  hasAdminKey: boolean
  adminKeyTail: string
  /** 免费额度次数上限，0 = 不限量 */
  freeQuota: number
  freeQuotaPeriod: "day" | "month" | "total"
  /**
   * 免费模型白名单。**空数组 = 全部模型免费**；
   * 非空时只有名单内的模型走统一 Key 并标「免费试用」，
   * 名单外的仍可选，但改用用户自己的中转站额度。
   */
  freeModels: string[]
  /** 站内模型白名单；**空数组 = 不过滤**（站内返回什么就显示什么） */
  siteModels: string[]
  /** 造物集：作品公开前是否需要管理员审核（默认开启） */
  reviewRequired: boolean
  /** 系统提示词覆盖值；空串 = 用前端内置默认 */
  agentPrompt: string
  channels: AdminLabChannel[]
}

/** 管理端审核队列里的一条作品 */
/** 系统提示词模板（管理端视角：带正文，可编辑） */
export interface AdminLabPromptTemplate {
  id: string
  name: string
  content: string
  enabled: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

/** 系统提示词模板（用户端视角：只需要切换用的 id/名字 + 正文） */
export interface LabPromptTemplate {
  id: string
  name: string
  content: string
}

/**
 * 技能（管理端视角：带正文，可编辑）。
 * `scope` 恒为 `'site'`（管理端只管站点默认技能，用户自己导入的归用户）。
 */
export interface AdminLabSkill {
  id: string
  name: string
  description: string
  content: string
  enabled: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

/**
 * 技能索引（用户端，**不含正文**）。
 * 渐进式披露：这份索引进系统提示当目录，正文等模型点名了再去取。
 */
export interface LabSkillIndexEntry {
  name: string
  description: string
}

/** 用户端能用的技能条目（站点默认 ∪ 自己导入的） */
export interface LabSkillEntry extends LabSkillIndexEntry {
  id: string
  /** 是不是自己导入的 */
  mine: boolean
}

export interface AdminLabReview {
  id: string
  name: string
  description: string
  icon: string
  hasCover: boolean
  visibility: string
  reviewNote: string
  createdAt: string
  updatedAt: string
  publishedAt: string | null
  authorName: string
  authorUsername: string
}

/** 管理端提交的一条渠道（apiKey 留空 = 不修改已存的密钥） */
export interface AdminLabChannelInput {
  id?: string
  name: string
  baseUrl: string
  model: string
  apiKey?: string
}

export const adminApi = {
  /**
   * 用户列表。不传参数 = 旧的全量模式（向后兼容）；
   * 传 limit/offset/q = 服务端分页搜索（响应带 total，数据量从 ~870KB 降到 ~20KB）。
   */
  listUsers: (opts?: { q?: string; limit?: number; offset?: number }) => {
    const p = new URLSearchParams()
    if (opts?.q) p.set("q", opts.q)
    if (opts?.limit != null) p.set("limit", String(opts.limit))
    if (opts?.offset != null) p.set("offset", String(opts.offset))
    const qs = p.toString()
    return request<{
      users: AdminUser[]
      total?: number
      limit?: number
      offset?: number
    }>(`/admin/users${qs ? `?${qs}` : ""}`)
  },

  /**
   * 用户列表批量封禁 / 解封。后端复用单人封禁的完整链路（停用 DNS/子域名、
   * 拉黑注册 IP、同步 NewAPI），单次上限 90 人；封禁必须带原因。
   */
  bulkSetStatus: (payload: {
    userIds: string[]
    action: "suspend" | "unsuspend"
    reason?: string
  }) =>
    request<{
      ok: boolean
      action: string
      updated: number
      skipped: number
      usernames: string[]
    }>("/admin/users/bulk-status", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  /** 管理员权限树（两级）+ 当前用户权限 + 侧边栏过滤开关 */
  getPermissionTree: () =>
    request<{
      groups: AdminPermGroup[]
      categories: AdminPermCategory[]
      myScope: string[]
      sidebarOnlyPermitted: boolean
    }>("/admin/permissions/tree"),

  /** 权限组列表 */
  listPermissionGroups: () =>
    request<{ groups: AdminPermissionGroup[] }>("/admin/permission-groups"),

  createPermissionGroup: (name: string, scope: string[]) =>
    request<{ id: string; name: string; scope: string[] }>("/admin/permission-groups", {
      method: "POST",
      body: JSON.stringify({ name, scope }),
    }),

  updatePermissionGroup: (id: string, payload: { name?: string; scope?: string[] }) =>
    request<{ ok: boolean }>(`/admin/permission-groups/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  deletePermissionGroup: (id: string) =>
    request<{ ok: boolean }>(`/admin/permission-groups/${id}`, { method: "DELETE" }),

  addGroupMembers: (id: string, userIds: string[]) =>
    request<{ added: number }>(`/admin/permission-groups/${id}/members`, {
      method: "POST",
      body: JSON.stringify({ userIds }),
    }),

  getUserAdminPermissions: (username: string) =>
    request<AdminPermissionsState>(
      `/admin/users/${encodeURIComponent(username)}/admin-permissions`
    ),

  setUserAdminPermissions: (
    username: string,
    payload: { role?: string; adminRoleId?: string | null; adminScope?: string[] }
  ) =>
    request<{ ok: boolean }>(`/admin/users/${encodeURIComponent(username)}/admin-permissions`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

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
      /**
       * 封禁原因：status 改成 suspended 时写入，**用户下次登录会在登录页看到**。
       * 解封（status=active）时后端会自动清空，不用传。
       */
      suspendReason?: string | null
    }
  ) =>
    request<AdminUserDetail>(`/admin/users/${encodeURIComponent(username)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  /**
   * 管理员直接为用户设置新密码（rootOnly）。
   * 后端会哈希入库、清空该用户全部会话与 OAuth 令牌。
   */
  setUserPassword: (username: string, password: string) =>
    request<{ ok: boolean }>(`/admin/users/${encodeURIComponent(username)}/password`, {
      method: "POST",
      body: JSON.stringify({ password }),
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

  /**
   * 邀请码列表。不传参数 = 旧的全量模式；
   * 传 limit/offset/status = 服务端分页筛选（响应带 total 与 counts）；
   * countOnly = 只要总数（管理页头部的「邀请码 N 个」用，进页面即可显示）。
   */
  listInvites: (opts?: {
    limit?: number
    offset?: number
    status?: string
    countOnly?: boolean
  }) => {
    const p = new URLSearchParams()
    if (opts?.countOnly) p.set("count_only", "1")
    if (opts?.limit != null) p.set("limit", String(opts.limit))
    if (opts?.offset != null) p.set("offset", String(opts.offset))
    if (opts?.status) p.set("status", opts.status)
    const qs = p.toString()
    return request<{
      invites: AdminInvite[]
      total?: number
      limit?: number
      offset?: number
      /** counts[""] = 全部，其余为 unused/partial/used。分页模式才有。 */
      counts?: Record<string, number>
    }>(`/admin/invites${qs ? `?${qs}` : ""}`)
  },

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

  /** 邀请码溯源：谁建的、什么时候建的、谁用了、什么时候用的（含注册 IP） */
  traceInvite: (id: string) =>
    request<AdminInviteTrace>(`/admin/invites/${encodeURIComponent(id)}/trace`),

  /** 用户「最近活动」分页（查看更多 / 懒加载） */
  getUserActivity: (username: string, offset: number, limit = 20) =>
    request<{
      activity: { id: string; action: string; detail: string; ip: string | null; createdAt: string }[]
      hasMore: boolean
      offset: number
      limit: number
    }>(`/admin/users/${encodeURIComponent(username)}/activity?offset=${offset}&limit=${limit}`),

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

  /** AI 实验室配置：模型来源、统一 Key、免费额度、提示词、免费渠道 */
  getLabConfig: () => request<AdminLabConfig>("/admin/lab/config"),

  /**
   * 字段级更新：**没传的键一律不动**。
   * `adminApiKey` 留空表示不修改统一 Key；要清空请显式传 `clearAdminKey`。
   */
  saveLabConfig: (payload: {
    aiSource?: "user" | "admin"
    adminApiKey?: string
    clearAdminKey?: boolean
    freeQuota?: number
    freeQuotaPeriod?: "day" | "month" | "total"
    /** 免费模型白名单；传空数组 = 全部免费 */
    freeModels?: string[]
    /** 站内模型白名单；传空数组 = 不过滤 */
    siteModels?: string[]
    /** 造物集：作品公开前是否需要审核 */
    reviewRequired?: boolean
    agentPrompt?: string
    channels?: AdminLabChannelInput[]
  }) =>
    request<AdminLabConfig>("/admin/lab/config", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  /** 造物集待审 / 已驳回队列 */
  listLabReviews: (status: "pending" | "rejected" = "pending") =>
    request<{
      status: string
      items: AdminLabReview[]
      pendingCount: number
      rejectedCount: number
    }>(`/admin/lab/reviews?status=${status}`),

  /** 放行 / 驳回一个待审作品 */
  reviewLabProject: (id: string, action: "approve" | "reject", note = "") =>
    request<{ id: string; visibility: string }>(
      `/admin/lab/reviews/${encodeURIComponent(id)}`,
      { method: "POST", body: JSON.stringify({ action, note }) }
    ),

  /** 读一份待审作品的完整文件（审核要看得见内容；走管理端接口，用户端取不到待审作品） */
  previewLabReview: (id: string) =>
    request<{ project: { id: string; name: string; files: Record<string, string> } }>(
      `/admin/lab/reviews/${encodeURIComponent(id)}/preview`
    ),

  // ---- 系统提示词模板 ----

  /** 全部模板（含未启用） */
  listLabPromptTemplates: () =>
    request<{ templates: AdminLabPromptTemplate[] }>("/admin/lab/templates"),

  // ---- 联网搜索：站点 key + 计费 ----
  getLabSearchConfig: () =>
    request<{ keys: string[]; keyCount: number; cost: number; userKeyEnabled: boolean }>(
      "/admin/lab/search"
    ),

  updateLabSearchConfig: (payload: { keys?: string; cost?: number; userKeyEnabled?: boolean }) =>
    request<{ keys: string[]; keyCount: number; cost: number; userKeyEnabled: boolean }>(
      "/admin/lab/search",
      { method: "PUT", body: JSON.stringify(payload) }
    ),

  /** 逐把 key 查 Tavily 官方额度（串行，单把失败不影响其他） */
  checkLabSearchQuota: () =>
    request<{
      keys: { masked: string; ok: boolean; usage?: number; limit?: number; error?: string }[]
    }>("/admin/lab/search/quota", { method: "POST" }),

  // ---- 技能：站点默认（管理端维护，所有人可用）----
  listLabSkills: () => request<{ skills: AdminLabSkill[] }>("/admin/lab/skills"),

  createLabSkill: (payload: {
    name: string
    description: string
    content: string
    enabled?: boolean
  }) =>
    request<{ skill: AdminLabSkill | null }>("/admin/lab/skills", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  updateLabSkill: (
    id: string,
    payload: { name?: string; description?: string; content?: string; enabled?: boolean }
  ) =>
    request<{ skill: AdminLabSkill | null }>(`/admin/lab/skills/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  deleteLabSkill: (id: string) =>
    request<void>(`/admin/lab/skills/${encodeURIComponent(id)}`, { method: "DELETE" }),

  createLabPromptTemplate: (payload: {
    name: string
    content: string
    enabled?: boolean
  }) =>
    request<{ template: AdminLabPromptTemplate | null }>("/admin/lab/templates", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  updateLabPromptTemplate: (
    id: string,
    payload: { name?: string; content?: string; enabled?: boolean }
  ) =>
    request<{ template: AdminLabPromptTemplate | null }>(
      `/admin/lab/templates/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify(payload) }
    ),

  deleteLabPromptTemplate: (id: string) =>
    request<void>(`/admin/lab/templates/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** 公开 API 配置（功能开关 + 层级限额 + 计入成就开关） */
  getApiConfig: () =>
    request<{
      features: { feature: string; enabled: boolean; tierLimits: number[]; ipLimit: number }[]
      countAchievements: boolean
    }>("/admin/api-config"),

  saveApiConfig: (payload: {
    countAchievements: boolean
    features: { feature: string; enabled: boolean; tierLimits: number[]; ipLimit: number }[]
  }) =>
    request<{ ok: boolean }>("/admin/api-config", {
      method: "POST",
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

  /** 编辑一条「待审核」的申请（账号名/密码/端口/通知邮箱/备注） */
  updateFrpApplication: (payload: {
    id: string
    frpUser?: string
    frpPassword?: string
    ports?: number[]
    notifyEmail?: string
    remark?: string
  }) =>
    request<{ ok: boolean; frpUser: string; ports: number[] }>(
      `/admin/frp/applications/${encodeURIComponent(payload.id)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          frpUser: payload.frpUser,
          frpPassword: payload.frpPassword,
          ports: payload.ports,
          notifyEmail: payload.notifyEmail,
          remark: payload.remark,
        }),
      }
    ),

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

  /** 某节点已占用的端口（带来源：manual = 站长手工标记） */
  listFrpPorts: (nodeId: string) =>
    request<{ ports: { port: number; owner: string | null; manual: boolean }[] }>(
      `/admin/frp/ports?nodeId=${encodeURIComponent(nodeId)}`
    ),

  /** 手动把一批端口标记为已占用 */
  occupyFrpPorts: (payload: { nodeId: string; ports: number[] }) =>
    request<{ ok: boolean; count: number }>("/admin/frp/ports/occupy", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  /** 解除一批端口的占用 */
  freeFrpPorts: (payload: { nodeId: string; ports: number[] }) =>
    request<{ ok: boolean; freed: number }>("/admin/frp/ports/free", {
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

  /** 修改真实邮箱：先 request 发送新邮箱验证码，再 confirm 带验证码落库 */
  changeEmail: (payload: {
    email: string
    password: string
    action: "request" | "confirm"
    /** confirm 步骤必填：发往新邮箱的 6 位验证码 */
    code?: string
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

  /** 列出某一层（子目录 + 文件）；不传 path 即根目录 */
  list: (path = "") =>
    request<StorageList>(
      path ? `/storage/objects?path=${encodeURIComponent(path)}` : "/storage/objects"
    ),

  /** 新建目录（path 可含 `/` 建多级） */
  createFolder: (path: string) =>
    request<{ path: string }>("/storage/folder", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  /** 递归删除目录及其下全部文件（不可逆） */
  deleteFolder: (path: string) =>
    request<{ removed: number }>("/storage/folder/delete", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  /** 列出我创建的目录分享 */
  shares: () => request<{ shares: StorageShare[] }>("/storage/shares"),

  /** 为某个目录创建分享（同一目录已有启用中的分享时直接复用） */
  createShare: (path: string, title?: string) =>
    request<{ share: StorageShare; reused: boolean }>("/storage/shares", {
      method: "POST",
      body: JSON.stringify({ path, title }),
    }),

  deleteShare: (id: string) =>
    request<{ ok: boolean }>("/storage/shares/delete", {
      method: "POST",
      body: JSON.stringify({ id }),
    }),

  toggleShare: (id: string, enabled: boolean) =>
    request<{ enabled: boolean }>("/storage/shares/toggle", {
      method: "POST",
      body: JSON.stringify({ id, enabled }),
    }),

  /** 申请预签名上传地址（浏览器直传 R2，可显示真实上传进度） */
  uploadUrl: (payload: {
    filename: string
    size: number
    contentType?: string
    /** 目标目录（相对账号根目录）；不传 = 根目录 */
    folder?: string
  }) =>
    request<{
      uploadUrl: string
      key: string
      filename: string
      path: string
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

  /** 批量删除（一次最多 200 个） */
  removeMany: (keys: string[]) =>
    request<{ deleted: number }>("/storage/objects/delete", {
      method: "POST",
      body: JSON.stringify({ keys }),
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

  /**
   * 「全部可用模型」清单 —— **懒加载**，只在用户展开那张卡片时才调。
   * 拉全量模型很慢（上游无缓存 + 一趟隧道往返），不能放在首屏的 status 里。
   */
  models: () => request<NewApiModels>("/dev/models"),

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
    request<{
      added: number
      /** 上游已经不在、这次被清掉的条数 */
      removed: number
      /** 上游列表可能被截断（≥100 条）⇒ 本次只新增、未移除 */
      truncated: boolean
      keys: NewApiKey[]
    }>("/dev/keys/sync", {
      method: "POST",
    }),

  /** 创建 Key —— 随响应返回完整 key（之后仍可用 revealKey 随时再取） */
  createKey: (name: string, group?: string) =>
    request<{ key: NewApiKey & { fullKey: string } }>("/dev/key", {
      method: "POST",
      body: JSON.stringify({ name, group }),
    }),

  /**
   * 读取某个 Key 的完整内容 —— 供「随时复制」。
   * 每次现取现复制（服务端不缓存明文），失败时按统一错误映射处理。
   */
  revealKey: (id: string) =>
    request<{ key: string }>(`/dev/key/${encodeURIComponent(id)}/reveal`, {
      method: "POST",
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

  /** 删除批次里的单个文件（创建者本人或管理员） */
  removeFile: (code: string, filename: string) =>
    request<{ fileCount: number; totalBytes: number }>(
      `/tempbox/${encodeURIComponent(code)}/${encodeURIComponent(filename)}`,
      { method: "DELETE" }
    ),
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
  overview: (offset = 0, limit = 10) =>
    request<ProxyOverview>(`/proxy?offset=${offset}&limit=${limit}`),

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
      /** 可选的根域（后端按权限筛过） */
      rootDomains: RootDomainOption[]
    }>("/mailbox"),

  create: (payload: { localPart: string; domain?: string }) =>
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

  /** 批量删除邮件（收件箱多选删除） */
  batchDeleteMessages: (mailboxId: string, ids: string[]) =>
    request<{ deleted: number }>(`/mailbox/${mailboxId}/messages/batch-delete`, {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),

  /**
   * 站内互发：以指定邮箱身份发给**本站另一个邮箱**（收件人必须是本站根域邮箱）。
   * 直接落对方收件箱，不需要付费的 Cloudflare Email Sending。
   * 发件地址由服务端从邮箱推导，前端只传收件人/主题/正文。
   */
  sendInternal: (mailboxId: string, payload: { to: string; subject: string; text: string }) =>
    request<{ ok: boolean; to: string }>(`/mailbox/${mailboxId}/send`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
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
    /** 设计系统参数（全量 JSON，服务端 sanitizeDesign 白名单清洗） */
    design: Record<string, unknown>
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
      const raw = (data as ApiError | null)?.error
      throw new HttpError(
        res.status,
        raw ? translateApiMessage(raw) : tStatic("api.uploadFailed", { status: res.status }),
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

  /**
   * 管理端：全部申请（含完整 payload，管理页核验资源用）。
   * 不传参数 = 旧的全量模式；传 limit/offset/type/status = 服务端分页筛选，
   * 响应带 total 与 counts（两层筛选徽标的计数，按 type/status 分组）。
   */
  listAll: (opts?: {
    limit?: number
    offset?: number
    type?: string
    status?: string
  }) => {
    const p = new URLSearchParams()
    if (opts?.limit != null) p.set("limit", String(opts.limit))
    if (opts?.offset != null) p.set("offset", String(opts.offset))
    if (opts?.type) p.set("type", opts.type)
    if (opts?.status) p.set("status", opts.status)
    const qs = p.toString()
    return request<{
      donations: Donation[]
      typeLabels: Record<string, string>
      total?: number
      limit?: number
      offset?: number
      /** counts[type][status]：type/status 为空串表示「合计」。分页模式才有。 */
      counts?: Record<string, Record<string, number>>
    }>(`/admin/donations${qs ? `?${qs}` : ""}`)
  },

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

// ---- Qoder2API 反代账号捐献（第二条，登录即解锁 AI 权限，免审核）----

export const qoder2apiApi = {
  /** 通道状态 + 当前用户的绑定列表 */
  status: () => request<Qoder2ApiStatus>("/qoder2api/status"),

  /** 发起登录（服务端建上游账号 + 落会话，立即返回 sessionId） */
  loginStart: () =>
    request<Qoder2ApiLoginStart>("/qoder2api/login/start", {
      method: "POST",
      body: JSON.stringify({ acknowledged: true }),
    }),

  /** 轮询登录结果（第一次会顺带返回授权链接） */
  loginPoll: (sessionId: string) =>
    request<Qoder2ApiLoginPoll>(
      `/qoder2api/login/poll?session=${encodeURIComponent(sessionId)}`
    ),

  // 管理端
  listBindings: () =>
    request<{ bindings: AdminQoder2ApiBinding[] }>("/admin/qoder2api/bindings"),

  removeBinding: (id: string, revokeAi?: boolean) =>
    request<{ ok: boolean; aiRevoked: boolean; upstreamWarning: string | null }>(
      `/admin/qoder2api/bindings/${encodeURIComponent(id)}/remove`,
      {
        method: "POST",
        body: JSON.stringify(revokeAi === undefined ? {} : { revokeAi }),
      }
    ),

  getConfig: () => request<AdminQoder2ApiConfig>("/admin/qoder2api/config"),

  saveConfig: (panelPassword: string) =>
    request<{ ok: boolean }>("/admin/qoder2api/config", {
      method: "PUT",
      body: JSON.stringify({ panelPassword }),
    }),

  getPool: () => request<AdminQoder2ApiPool>("/admin/qoder2api/pool"),
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

/**
 * 每日签到。
 *
 * `status` 只读（未签到时的当前状态），`do` 执行签到（幂等，重复调用会拿到「已签」错误）。
 */
/**
 * 公开 API：用户用 API Key 调用站点功能。
 *
 * Key 管理走 session（设置页），调用走 Bearer（/v1/*）。
 */
export const publicApi = {
  /** 当前 Key 状态（明文永不回传） */
  getKeyStatus: () =>
    request<{
      hasKey: boolean
      prefix: string | null
      createdAt: string | null
      lastUsedAt: string | null
      /** 当前这把 Key 是否带管理员权限（不受速率/数量限制） */
      isAdmin: boolean
      /** 当前用户能否生成管理员 Key（只有管理员能） */
      canCreateAdminKey: boolean
    }>("/api-key"),

  /**
   * 生成新 Key（已有则覆盖，旧 Key 立即作废）。明文只返回这一次。
   * `admin: true` = 管理员 Key（不受 API 速率、子域名速率、子域名数量、邮箱数量限制），仅管理员可用。
   */
  generateKey: (admin?: boolean) =>
    request<{ apiKey: string; prefix: string; isAdmin: boolean }>("/api-key", {
      method: "POST",
      body: JSON.stringify({ admin: admin === true }),
    }),

  /** 删除 Key（禁用 API 调用） */
  deleteKey: () => request<{ ok: boolean }>("/api-key", { method: "DELETE" }),

  /** 用户视角的 API 文档（自己的层级/额度 + 各功能开放与否） */
  getDoc: () =>
    request<{
      achievementPoints: number
      tier: number
      features: {
        feature: string
        enabled: boolean
        tier: number
        accountLimit: number
        ipLimit: number
      }[]
    }>("/api-doc"),
}

export const checkinApi = {
  status: () =>
    request<{
      enabled: boolean
      /** 站点时区下的今天（YYYY-MM-DD）——自动签到按它判定「今天是否已处理」 */
      today: string
      checkedIn: boolean
      streak: number
      todayPoints: number
      todayBase: number
      todayBonus: number
      milestones: { days: number; points: number }[]
      next: { days: number; points: number; daysLeft: number } | null
      makeupCards: number
      canMakeup: boolean
      autoCheckin: boolean
    }>("/checkin"),

  do: () =>
    request<{
      ok: boolean
      streak: number
      base: number
      bonus: number
      total: number
      milestoneHit: { days: number; points: number } | null
      next: { days: number; points: number; daysLeft: number } | null
    }>("/checkin", { method: "POST" }),

  makeup: (date?: string) =>
    request<{ ok: boolean; makeupDate: string; streak: number; makeupCards: number }>(
      "/checkin/makeup",
      { method: "POST", body: JSON.stringify(date ? { date } : {}) }
    ),

  history: (month: string) =>
    request<{
      month: string
      today: string
      makeupCards: number
      days: { date: string; points: number; isMakeup: boolean }[]
    }>(`/checkin/history?month=${encodeURIComponent(month)}`),

  setAuto: (enabled: boolean) =>
    request<{ ok: boolean; autoCheckin: boolean }>("/checkin/auto", {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),
}

export const pointsApi = {
  /**
   * 上传商品封面图（2026-10-01 加）。
   *
   * 返回的 `url` 是**同源相对路径**（`/shop-img/<userId>/<file>`），
   * 直接填进 imageUrl 字段即可 —— 商城所有人都能看到这张图。
   */
  uploadProductImage: (file: File) => {
    const headers = new Headers()
    headers.set("Content-Type", file.type)
    return request<{ key: string; url: string }>("/points/product/image", {
      method: "POST",
      body: file,
      headers,
    })
  },
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
  /**
   * 商品公示的购买记录（最近 10 条：买家用户名 + 下单时间）。
   *
   * ⚠️ 商品没开「公示购买记录」时后端返回 404 —— 调用方要当成「没有这块内容」，
   * 而不是「加载失败」（详情弹窗里不该为它弹错误提示）。
   */
  productPurchases: (productId: string) =>
    request<{ purchases: PublicPurchase[] }>(
      `/points/products/${encodeURIComponent(productId)}/purchases`
    ),

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
  /** 我的商品（卡密）的卡密池概览 */
  getMyProductCodes: (id: string) =>
    request<{ total: number; used: number; available: number }>(
      `/points/products/${encodeURIComponent(id)}/codes`
    ),
  /** 给我的商品（卡密）追加卡密（自动去重） */
  addMyProductCodes: (id: string, codes: string[]) =>
    request<{ added: number; available: number }>(
      `/points/products/${encodeURIComponent(id)}/codes`,
      { method: "POST", body: JSON.stringify({ codes }) }
    ),
  /** 清空我的商品（卡密）未使用的卡密 */
  clearMyProductCodes: (id: string) =>
    request<{ removed: number }>(`/points/products/${encodeURIComponent(id)}/codes`, {
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

  // ---- 售后（退款）----

  /** 买家：申请退款。`delivered`（还没收到货）随时可申请；`settled` 是确认收货后 7 天内 */
  requestAfterSale: (orderId: string, reason: string) =>
    request<{ order: PointOrder }>(
      `/points/orders/${encodeURIComponent(orderId)}/after-sale`,
      { method: "POST", body: JSON.stringify({ reason }) }
    ),
  /** 买家：撤销自己的退款申请（已申请平台介入后不能撤） */
  cancelAfterSale: (orderId: string) =>
    request<{ order: PointOrder }>(
      `/points/orders/${encodeURIComponent(orderId)}/after-sale`,
      { method: "DELETE" }
    ),
  /** 买家：卖家一直不处理或已拒绝 → 申请平台（管理员）介入 */
  escalateAfterSale: (orderId: string) =>
    request<{ order: PointOrder }>(
      `/points/orders/${encodeURIComponent(orderId)}/after-sale/escalate`,
      { method: "POST" }
    ),
  /** 买家：拒收（卖家点了已交付但没收到货 / 货不对板）→ 直达平台介入，不用先向卖家申请退款 */
  rejectOrder: (orderId: string, reason: string) =>
    request<{ order: PointOrder }>(`/points/orders/${encodeURIComponent(orderId)}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  /** 卖家：处理买家的退款申请（同意即退款；拒绝要写明理由） */
  sellerResolveAfterSale: (orderId: string, approve: boolean, note?: string) =>
    request<{ order: PointOrder }>(
      `/points/orders/${encodeURIComponent(orderId)}/after-sale/decide`,
      { method: "POST", body: JSON.stringify({ approve, note }) }
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

  /** 补填邀请码（注册时忘记填，7 天内可补） */
  claim: (code: string) =>
    request<{ ok: boolean; grantedPoints: number }>("/my-invites/claim", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),
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

/** 自定义称号：查看我持有的全部称号、切换对外展示哪一个（2026-10-01） */
export const titleApi = {
  mine: () => request<{ titles: MyTitle[] }>("/titles/mine"),
  /** titleId = null 表示一个都不展示 */
  setDisplay: (titleId: string | null) =>
    request<{ ok: boolean; titleId: string | null }>("/titles/display", {
      method: "POST",
      body: JSON.stringify({ titleId }),
    }),
}

export const communityApi = {
  /** 管理员 / 站长置顶或取消置顶帖子（2026-10-01） */
  setPinned: (id: string, pinned: boolean) =>
    request<{ ok: boolean; pinned: boolean }>(
      `/community/posts/${encodeURIComponent(id)}/pin`,
      { method: "POST", body: JSON.stringify({ pinned }) }
    ),

  getConfig: () => request<CommunityConfig>("/community/config"),
  /**
   * 帖子列表（两层筛选，2026-10-07）。
   *   · sort="hot"        —— 按热度（点赞+评论）；不传 = 按时间倒序
   *   · category="<key>"  —— 只看某个分类
   *   · excludeWater      —— 看全部但不含水帖（与 category 互斥，由调用方保证）
   */
  listPosts: (opts?: {
    cursor?: string
    sort?: "latest" | "hot"
    category?: string
    excludeWater?: boolean
  }) => {
    const q = new URLSearchParams()
    if (opts?.cursor) q.set("cursor", opts.cursor)
    if (opts?.sort === "hot") q.set("sort", "hot")
    if (opts?.category) q.set("category", opts.category)
    if (opts?.excludeWater) q.set("exclude_water", "1")
    const qs = q.toString()
    return request<{ posts: Post[]; nextCursor: string | null }>(
      `/community/posts${qs ? `?${qs}` : ""}`
    )
  },
  getStats: () => request<CommunityStats>("/community/stats"),
  newPostsCount: () => request<{ count: number }>("/community/new-posts-count"),
  /** 记下「我刚打开过社区」—— 侧边栏新帖角标据此清零 */
  markSeen: () => request<{ ok: boolean }>("/community/seen", { method: "POST" }),
  getPost: (id: string) => request<{ post: Post }>(`/community/posts/${encodeURIComponent(id)}`),
  getComments: (id: string) =>
    request<{ comments: CommentNode[] }>(`/community/posts/${encodeURIComponent(id)}/comments`),
  createPost: (body: string, images: string[] = [], category: string = "chat") =>
    request<{ post: { id: string } }>("/community/posts", {
      method: "POST", body: JSON.stringify({ body, images, category }),
    }),
  uploadImage: (postId: string, file: File) => {
    const headers = new Headers()
    headers.set("Content-Type", file.type)
    return request<{ key: string }>(`/community/posts/${encodeURIComponent(postId)}/images`, {
      method: "POST", body: file, headers,
    })
  },
  /** 编辑帖子时删除一张帖子图片（后端同时删 R2 对象并从 posts.images 移除） */
  deletePostImage: (postId: string, filename: string) =>
    request<{ ok: boolean; remaining: number }>(
      `/community/posts/${encodeURIComponent(postId)}/images/${encodeURIComponent(filename)}`,
      { method: "DELETE" }
    ),
  toggleLike: (id: string) =>
    request<{ liked: boolean; likeCount: number }>(`/community/posts/${encodeURIComponent(id)}/like`, { method: "POST" }),
  toggleCommentLike: (id: string) =>
    request<{ liked: boolean; likeCount: number }>(`/community/comments/${encodeURIComponent(id)}/like`, { method: "POST" }),
  share: (id: string) =>
    request<{ shareCount: number; alreadyShared: boolean }>(`/community/posts/${encodeURIComponent(id)}/share`, { method: "POST" }),
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
  /**
   * 消息列表。
   * · 不传游标：拉最近一批（首屏用）
   * · `after`：增量拉**更新**的（5 秒轮询用）
   * · `before`：往前翻页，拉**更早**的（往上滑看历史，借鉴 Telegram offset_id 翻页）
   * · `sinceEdit`：编辑/回应回传窗口 —— 已越过游标的「编辑过、新被回应过」的
   *   旧消息也一并带回，前端按 id 替换本地已知消息（否则别人看不到你的编辑）。
   * 返回的 `nextCursor` 喂给 after、`prevCursor` 喂给 before；
   * `typing` 是窗口内正在输入的人（搭轮询的车下发，不单开请求）。
   */
  list: (opts?: { after?: string; before?: string; limit?: number; sinceEdit?: string }) => {
    const qs = new URLSearchParams()
    if (opts?.after) qs.set("after", opts.after)
    if (opts?.before) qs.set("before", opts.before)
    if (opts?.limit) qs.set("limit", String(opts.limit))
    if (opts?.sinceEdit) qs.set("sinceEdit", opts.sinceEdit)
    const suffix = qs.toString() ? `?${qs.toString()}` : ""
    return request<{
      messages: ChatMessage[]
      nextCursor: string | null
      prevCursor: string | null
      hasMore: boolean
      typing: ChatPresenceUser[]
    }>(`/chat/messages${suffix}`)
  },
  /**
   * 发消息。`clientId` 是幂等键（借鉴 Telegram random_id）：乐观发送先本地出
   * 气泡，超时重试 / 双击提交时服务端只落一行，重复请求拿回同一条消息。
   * `forwardFrom` = `"<kind>:<id>"`（chat|dm），转发时正文由服务端取来源消息。
   */
  send: (
    body: string,
    opts?: { replyTo?: string | null; clientId?: string; forwardFrom?: string }
  ) =>
    request<{ message: ChatMessage }>("/chat/messages", {
      method: "POST",
      body: JSON.stringify({
        body,
        ...(opts?.replyTo ? { replyTo: opts.replyTo } : {}),
        ...(opts?.clientId ? { clientId: opts.clientId } : {}),
        ...(opts?.forwardFrom ? { forwardFrom: opts.forwardFrom } : {}),
      }),
    }),
  /** 撤回自己的消息（管理员不限） */
  recall: (id: string) =>
    request<{ ok: boolean }>(`/chat/messages/${encodeURIComponent(id)}/recall`, {
      method: "POST",
    }),
  /** 表情回应开关（toggle）：点一下加上、再点取消 */
  react: (id: string, emoji: string) =>
    request<{ emoji: string; active: boolean }>(
      `/chat/messages/${encodeURIComponent(id)}/reactions`,
      { method: "POST", body: JSON.stringify({ emoji }) }
    ),
  /** 编辑自己的消息（10 分钟内），返回补全后的整条消息 */
  edit: (id: string, body: string) =>
    request<{ message: ChatMessage }>(`/chat/messages/${encodeURIComponent(id)}/edit`, {
      method: "POST",
      body: JSON.stringify({ body }),
    }),
  /** 「我正在输入」心跳 —— 前端 5 秒节流一次，由消息轮询顺带带回别人的状态 */
  typing: () => request<{ ok: boolean }>("/chat/typing", { method: "POST" }),
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

/**
 * 一对一私信（2026-10-01）。
 *
 * 轮询与聊天室一个路子：拉取**不会**自动标已读，前端在「用户真的看到」时
 * 单独调 `seen()`（否则轮询一次就把未读清零了）。
 */
export const dmApi = {
  /** 会话列表（每个对端一条，带未读数） */
  conversations: () =>
    request<{ conversations: DmConversation[]; unreadTotal: number }>(
      "/dm/conversations"
    ),

  /** 只取未读总数（做角标用，别为它拉整个列表） */
  unread: () => request<{ unread: number }>("/dm/unread"),

  /** 我收到的待处理聊天申请（陌生人发来的第一条消息 + 同意/拒绝） */
  requests: () => request<{ requests: DmRequest[] }>("/dm/requests"),

  /** 处理聊天申请：同意后双方才能自由发消息 */
  respondRequest: (peer: string, action: "accept" | "decline") =>
    request<{ ok: boolean; status: string }>("/dm/requests", {
      method: "POST",
      body: JSON.stringify({ peer, action }),
    }),

  /**
   * 某个会话的消息。
   * · 不传游标：拉最近一批（进会话时用）
   * · `after`：增量拉**更新**的（轮询用）
   * · `before`：往前翻页，拉**更早**的（往上滑看历史用）
   * · `sinceEdit`：编辑/回应回传窗口 —— 已越过游标的「编辑过、新被回应过」
   *   的旧消息也一并带回，前端按 id 替换本地已知消息。
   * 返回的 `nextCursor` 喂给 `after`，`prevCursor` 喂给 `before`。
   */
  list: (
    peer: string,
    opts?: { after?: string; before?: string; limit?: number; sinceEdit?: string }
  ) => {
    const qs = new URLSearchParams({ peer })
    if (opts?.after) qs.set("after", opts.after)
    if (opts?.before) qs.set("before", opts.before)
    if (opts?.limit) qs.set("limit", String(opts.limit))
    if (opts?.sinceEdit) qs.set("sinceEdit", opts.sinceEdit)
    return request<{
      peer: DmPeer
      messages: DmMessage[]
      nextCursor: string | null
      prevCursor: string | null
      hasMore: boolean
      /** 对端是否正在输入（消息轮询顺带下发） */
      peerTyping: boolean
    }>(`/dm?${qs.toString()}`)
  },

  /**
   * 发私信。`clientId` 幂等键与聊天室同套（超时重发不产生重复消息）；
   * `replyTo` = 被引用消息 id（同会话内有效，对方已撤回则自动降级为普通消息）；
   * `forwardFrom` = `"<kind>:<id>"`（chat|dm），转发正文由服务端取来源消息。
   */
  send: (
    to: string,
    body: string,
    opts?: { replyTo?: string | null; clientId?: string; forwardFrom?: string }
  ) =>
    request<{ message: DmMessage }>("/dm", {
      method: "POST",
      body: JSON.stringify({
        to,
        body,
        ...(opts?.replyTo ? { replyTo: opts.replyTo } : {}),
        ...(opts?.clientId ? { clientId: opts.clientId } : {}),
        ...(opts?.forwardFrom ? { forwardFrom: opts.forwardFrom } : {}),
      }),
    }),

  /** 撤回私信：本人 10 分钟内可撤（管理员不限），正文真的清掉 */
  recall: (id: string) =>
    request<{ ok: boolean }>(`/dm/messages/${encodeURIComponent(id)}/recall`, {
      method: "POST",
    }),

  /** 表情回应开关（toggle）：点一下加上、再点取消 */
  react: (id: string, emoji: string) =>
    request<{ emoji: string; active: boolean }>(
      `/dm/messages/${encodeURIComponent(id)}/reactions`,
      { method: "POST", body: JSON.stringify({ emoji }) }
    ),

  /** 编辑自己的私信（10 分钟内），返回补全后的整条消息 */
  edit: (id: string, body: string) =>
    request<{ message: DmMessage }>(`/dm/messages/${encodeURIComponent(id)}/edit`, {
      method: "POST",
      body: JSON.stringify({ body }),
    }),

  /** 「我正在给对端打字」心跳 —— 5 秒节流，对端靠 list 轮询看到 */
  typing: (peer: string) =>
    request<{ ok: boolean }>("/dm/typing", {
      method: "POST",
      body: JSON.stringify({ peer }),
    }),

  /** 把「与某个对端的会话里我收到的消息」标为已读（幂等） */
  seen: (peer: string) =>
    request<{ ok: boolean; marked: number }>("/dm/seen", {
      method: "POST",
      body: JSON.stringify({ peer }),
    }),
}

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
  /**
   * 历史投票：已结束的投票活动（含最终票数、获奖选项、我投了谁、我的结算结果）。
   *
   * 活动一过截止时间就从 `/events`（活动推广列表）消失，而「截止后开奖」的结果
   * 偏偏是在截止之后才出来的 —— 这条是那些活动的回看入口。
   * 只返回原本就出现在「活动推广」里的（promo_hidden = 0）。
   */
  voteHistory: () => request<{ events: EventItem[]; now: string }>("/events/vote-history"),
  /** 单个活动（公开）：活动分享链接用；draft / scheduled 会 404 */
  get: (id: string) => request<{ event: EventItem }>(`/events/${encodeURIComponent(id)}`),
  /** 认证码活动必须带 code；其余活动 code 可省略 */
  /**
   * 领取活动奖励 / 参与活动。
   *
   * `code` 用于「凭认证码」的活动，`github` 用于「点了 GitHub star」的活动，
   * `optionId` 用于投票活动（投给哪个选项）—— 三者都只是**线索**，
   * 服务端一律重新核验（选项是否存在、名字是否已被占用等），前端传什么都不信。
   */
  claim: (id: string, code?: string, github?: string, optionId?: string) =>
    request<{ status: string; detail: string }>(
      `/events/${encodeURIComponent(id)}/claim`,
      {
        method: "POST",
        body: JSON.stringify({ code: code ?? "", github: github ?? "", optionId: optionId ?? "" }),
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
  /**
   * 开奖：抽奖从报名者里随机抽人；投票按「多数/少数得奖」计票。
   * 已开过奖会返回 409；对「参与即可获奖」/「立刻结算」的投票会返回 400
   * （那两档在投票时就已经结算完了）。
   * `winningOptions` 只有投票开奖才会返回（平票时是多个选项 id）。
   */
  draw: (id: string) =>
    request<{
      ok: boolean
      winners: number
      distributed: number
      participants: number
      failed: number
      winningOptions?: string[]
    }>(`/admin/events/${encodeURIComponent(id)}/draw`, { method: "POST" }),
  /**
   * 上传投票选项配图。返回的 `url` 是**同源相对路径**（`/api/event-img/<userId>/<file>`），
   * 直接填进选项的 image 字段即可 —— 活动是公开分享的，配图必须任何人可读。
   */
  uploadImage: (file: File) => {
    const headers = new Headers()
    headers.set("Content-Type", file.type)
    return request<{ key: string; url: string }>("/admin/events/image", {
      method: "POST",
      body: file,
      headers,
    })
  },
}

/**
 * 封禁申诉（**公开接口**）：被封禁的账号登录会被 403、拿不到会话，
 * 所以提交申诉不依赖登录态 —— 用「用户名 + 说明」提交。
 */
// ---- 用户表情包 ----

export const stickerApi = {
  /**
   * 我的表情包。
   *
   * 缓存：服务端返回 `Cache-Control: private, no-cache` + ETag，**浏览器**会自己
   * 带 If-None-Match 做协商、命中 304 时直接用本地副本 —— 这一层对 fetch 是透明的，
   * 不需要我们写代码。前端另有一层 localStorage（见 sticker-panel.tsx）负责「打开就显示」。
   */
  list: () => request<{ stickers: Sticker[]; version: string; limit: number }>("/stickers"),

  /** 上传：raw body + Content-Type（不套 multipart，少一层解析） */
  upload: (blob: Blob, contentType: string) =>
    request<{ sticker: Sticker }>("/stickers", {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: blob,
    }),

  remove: (id: string) =>
    request<void>(`/stickers/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** 把别人发的表情包存进自己的表情包（幂等：已存过会返回已有的，alreadySaved=true） */
  save: (id: string) =>
    request<{ sticker: Sticker; alreadySaved: boolean }>("/stickers/save", {
      method: "POST",
      body: JSON.stringify({ id }),
    }),
}

export const appealApi = {
  /** identifier：用户名**或**邮箱都行（后端两种都会查） */
  submit: (payload: { identifier: string; contact?: string; content: string }) =>
    request<{ ok: boolean; id: string }>("/appeal", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  /**
   * 取「有管理员回复、但用户还没确认看过」的申诉（需登录）。
   * 返回 null 表示没有待确认的回复 —— 前端据此决定要不要弹强制确认框。
   * 这也是**补发**通道：老用户解封后一直没看到回复，这次打开页面就会命中。
   */
  pendingReply: () =>
    request<{ reply: AppealPendingReply | null }>("/appeal/pending-reply"),
  /**
   * 确认已读管理员回复（需登录）。
   *
   * ⚠️ 只有 `choice: "understood"`（勾了「我已完全明白并承诺不再违规」）才会真正落库；
   *    勾另一项只是留痕、回复仍算未读 —— 站长要求「必须勾第一个才能关掉弹窗」。
   *    返回的 `read` 表示这次调用是否真的标记了已读。
   */
  acknowledge: (payload: { appealId?: string; choice?: string }) =>
    request<{ ok: boolean; nothing?: boolean; read?: boolean }>("/appeal/acknowledge", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
}

/** 用户侧：管理端通知（强制已读弹窗） */
export const noticeApi = {
  pending: () => request<{ notices: PendingNotice[] }>("/notice/pending"),
  /**
   * 确认收到。若该通知要求捐献而用户还没捐，后端返回 `ok:false` +
   * 还缺哪些渠道（**不解锁、也不标记已读**，弹窗继续拦着）；
   * 用户捐完再点同一个接口即通过。
   */
  ack: (id: string) =>
    request<{
      ok: boolean
      unlocked?: boolean
      donationRequired?: { required: DonationChannel[]; missing: DonationChannel[] }
    }>("/notice/ack", {
      method: "POST",
      body: JSON.stringify({ id }),
    }),
}

/** 管理端：通知 */
export const adminNoticeApi = {
  list: () => request<{ notices: AdminNotice[] }>("/admin/notices"),
  send: (payload: {
    usernames: string[]
    title: string
    body: string
    restrictFeatures?: string[]
    /** 要求用户捐献的渠道（任选其一解锁）；非空时后端强制一并禁用 ai */
    requireDonation?: DonationChannel[]
  }) =>
    request<{
      sent: string[]
      missing: string[]
      restricted: number
      /** 命中监管白名单、只发通知不改权限的用户 */
      whitelisted: string[]
      /** 已满足捐献门槛、整条跳过的用户（名单过时） */
      alreadyDonated: string[]
      requireDonation: DonationChannel[]
    }>("/admin/notices", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  revoke: (id: string) =>
    request<{ ok: boolean }>("/admin/notices/revoke", {
      method: "POST",
      body: JSON.stringify({ id }),
    }),
}

/** 管理端「监管」栏目：申诉 + 风险账户 */
export const adminModerationApi = {
  appeals: () => request<{ appeals: AccountAppeal[] }>("/admin/appeals"),
  reviewAppeal: (id: string, action: "accept" | "reject", note?: string) =>
    request<{ ok: boolean; status: string; unblocked: boolean }>(
      `/admin/appeals/${encodeURIComponent(id)}/review`,
      { method: "POST", body: JSON.stringify({ action, note }) }
    ),
  riskAccounts: () => request<{ accounts: RiskAccount[] }>("/admin/risk-accounts"),
  updateRiskStatus: (userId: string, status: RiskAccount["status"]) =>
    request<{ ok: boolean }>(`/admin/risk-accounts/${encodeURIComponent(userId)}/status`, {
      method: "POST",
      body: JSON.stringify({ status }),
    }),

  // ---- 白名单 / 自动条件 / 黑名单（2026-10-03） ----

  /** 一次拿齐白名单（按来源分组）+ 黑名单；GET 时后端会顺带按条件同步一次 */
  lists: () => request<ModerationLists>("/admin/moderation/lists"),
  /** 白名单手动增删 */
  whitelistUpdate: (action: "add" | "remove", username: string) =>
    request<{ ok: boolean }>("/admin/moderation/whitelist", {
      method: "POST",
      body: JSON.stringify({ action, username }),
    }),
  /** 白名单自动条件：新建 / 启停 / 删除 */
  conditionUpdate: (payload: {
    action: "create" | "toggle" | "delete"
    id?: string
    metric?: ModerationConditionMetric
    op?: ModerationConditionOp
    value?: number
    enabled?: boolean
  }) =>
    request<{ ok: boolean }>("/admin/moderation/conditions", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  /** 黑名单增删（IP） */
  blacklistUpdate: (action: "add" | "remove", ip: string, reason?: string) =>
    request<{ ok: boolean }>("/admin/moderation/blacklist", {
      method: "POST",
      body: JSON.stringify({ action, ip, reason }),
    }),
  /** IP 监管：查出被多个不同（未封禁）账号共用的登录 IP */
  ipWatch: () => request<IpWatchResult>("/admin/moderation/ip-watch"),
}

/** 「IP 监管」里共用一个 IP 的某个账号 */
export interface SharedIpUser {
  username: string
  nickname: string | null
  firstSeenAt: string
  lastSeenAt: string
  times: number
}

/** 「IP 监管」里的一个可疑 IP 分组 */
export interface SharedIpGroup {
  ip: string
  userCount: number
  users: SharedIpUser[]
}

export interface IpWatchResult {
  groups: SharedIpGroup[]
  ipCount: number
  userCount: number
}

/** 管理端积分接口 */
export const adminPointsApi = {
  /**
   * 积分总览：用户列表（含 0 分用户）+ 全站汇总；query 可按用户名/昵称搜索。
   * 不传 limit/offset = 旧行为（最新 200 人）；传了 = 服务端分页（响应带 total）。
   */
  list: (opts?: { query?: string; limit?: number; offset?: number }) => {
    const p = new URLSearchParams()
    const q = opts?.query?.trim()
    if (q) p.set("query", q)
    if (opts?.limit != null) p.set("limit", String(opts.limit))
    if (opts?.offset != null) p.set("offset", String(opts.offset))
    const qs = p.toString()
    return request<AdminPointsOverview>(`/admin/points${qs ? `?${qs}` : ""}`)
  },
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
    /** 用户商城：卖家交付后多少天自动确认收货（0 = 关闭） */
    autoConfirmDays?: number
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
  /** 卡密池概览（delivery='code'） */
  getProductCodes: (id: string) =>
    request<{ total: number; used: number; available: number }>(
      `/admin/points/products/${encodeURIComponent(id)}/codes`
    ),
  /** 追加卡密（一行一条，自动去重） */
  addProductCodes: (id: string, codes: string[]) =>
    request<{ added: number; available: number }>(
      `/admin/points/products/${encodeURIComponent(id)}/codes`,
      { method: "POST", body: JSON.stringify({ codes }) }
    ),
  /** 清空未使用的卡密 */
  clearProductCodes: (id: string) =>
    request<{ removed: number }>(
      `/admin/points/products/${encodeURIComponent(id)}/codes`,
      { method: "DELETE" }
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
  /**
   * 售后列表。不传 status = 只看「待平台处理」的；
   * 传 `all` = 看全部有售后记录的订单（含已退款 / 已驳回）。
   */
  afterSales: (status?: string) =>
    request<{ orders: PointOrder[]; status: string }>(
      `/admin/points/after-sales${status ? `?status=${encodeURIComponent(status)}` : ""}`
    ),
  /**
   * 客服判定退款申请。
   * approve=true 同意退款（已结算的会先从卖家收益里收回，收不回会报错并提示先调整卖家积分）；
   * false 驳回，售后终结。
   */
  resolveAfterSale: (id: string, approve: boolean, note?: string) =>
    request<{ order: PointOrder }>(
      `/admin/points/orders/${encodeURIComponent(id)}/after-sale`,
      { method: "POST", body: JSON.stringify({ approve, note }) }
    ),
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
  /** 审核状态：approved（可用）/ pending（待站长审核）/ rejected（已驳回） */
  reviewStatus: string
  /** 审核意见（驳回原因），通过时为 null */
  reviewNote: string | null
  /** 管理端列表才带：创建者用户名 */
  ownerName?: string | null
  createdAt: string
  updatedAt: string
}

/** 同意页展示信息 */
export interface OAuthAuthorizeContext {
  clientName: string
  clientId: string
  scopes: string[]
  /** 回调地址的站点域名（用户据此判断这是哪个网站） */
  redirectHosts: string[]
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

  // ---- 「我创建的应用」（2026-10-06 放开用户自建）----

  /** 我创建的应用列表 + 当前是否免审 + 每人上限 */
  myClients: () =>
    request<{ clients: OAuthClient[]; autoApprove: boolean; maxClients: number }>(
      "/oauth/my-clients"
    ),

  /** 创建应用。clientSecret 明文只此一次，丢了只能删了重建 */
  createMyClient: (payload: {
    name: string
    redirectUris: string[]
    scopes?: string
    allowHttp?: boolean
  }) =>
    request<{ client: OAuthClient; clientSecret: string; pending: boolean }>(
      "/oauth/my-clients",
      { method: "POST", body: JSON.stringify(payload) }
    ),

  /** 改名字 / 回调地址（会重新排队审核）。注意后端没有开放改 client_id */
  updateMyClient: (
    id: string,
    payload: {
      name?: string
      redirectUris?: string[]
      scopes?: string
      allowHttp?: boolean
    }
  ) =>
    request<{ client: OAuthClient | null }>(
      `/oauth/my-clients/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify(payload) }
    ),

  deleteMyClient: (id: string) =>
    request<{ ok: boolean }>(`/oauth/my-clients/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
}

export const oauthAdminApi = {
  list: () =>
    request<{ clients: OAuthClient[]; autoApprove: boolean }>("/admin/oauth/clients"),

  /** 审核用户提交的应用：通过 / 驳回（可带驳回原因） */
  review: (id: string, payload: { approve: boolean; note?: string }) =>
    request<{ client: OAuthClient | null }>(
      `/admin/oauth/clients/${encodeURIComponent(id)}/review`,
      { method: "POST", body: JSON.stringify(payload) }
    ),

  /** 切换「用户自建应用免审」开关（关着 = 需站长审核） */
  setAutoApprove: (autoApprove: boolean) =>
    request<{ autoApprove: boolean }>("/admin/oauth/settings", {
      method: "POST",
      body: JSON.stringify({ autoApprove }),
    }),

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

/**
 * 聊天图片上传 —— 私聊 / 聊天室 / 广场帖子与评论共用。
 *
 * 返回的 `url` 直接塞进 markdown 的 `![]()` 就能显示，
 * 所以拖拽/粘贴进来后只需往输入框里插一段文本，不用改消息结构。
 */
export const chatUploadApi = {
  upload: (file: File) => {
    const headers = new Headers()
    headers.set("Content-Type", file.type)
    return request<{ key: string; url: string }>("/chat/upload-image", {
      method: "POST",
      body: file,
      headers,
    })
  },
}

/**
 * 二次认证（2FA）。
 *
 * 分两组：
 * · `verifyLogin` / `sendLoginEmail` —— 登录第二步，此时**还没有登录态**；
 * · 其余 —— 登录后在设置页自助管理。
 */
/**
 * 改动 2FA 设置时的「二次验证」载荷（2026-10-10 起服务端强制要求）。
 * `challengeId` 只在用**邮箱验证码**时才需要 —— 由 `twoFactorApi.sendStepUpCode()` 换回。
 */
export interface TwoFactorStepUp {
  code?: string
  challengeId?: string
}

export const twoFactorApi = {
  /** 登录第二步：提交验证码，成功后才真正建立登录态 */
  verifyLogin: (payload: { challengeId: string; method: string; code: string }) =>
    request<{ user: MeResponse["user"]; mustSetupTwoFactor?: boolean }>("/login/2fa", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  /** 给当前挑战的账号重发一封邮箱验证码 */
  sendLoginEmail: (challengeId: string) =>
    request<{ ok: boolean }>("/login/2fa/send-email", {
      method: "POST",
      body: JSON.stringify({ challengeId }),
    }),

  /** 我的 2FA 现状（含「是否被强制」与收件地址脱敏） */
  status: () =>
    request<{
      enabled: boolean
      methods: string[]
      totpConfirmed: boolean
      emailEnabled: boolean
      recoveryLeft: number
      enforced: boolean
      maskedEmail: string
    }>("/settings/2fa"),

  /** 开始配置 TOTP：拿到密钥与 otpauth 链接（前端画二维码） */
  /**
   * 改动 2FA 设置时的「二次验证」载荷（2026-10-10 起服务端强制）：
   *   · `code`        —— 当前可用的验证码（认证器动态码 / 恢复码 / 邮箱验证码）
   *   · `challengeId` —— 用**邮箱验证码**时必须带上（由 `sendStepUpCode()` 换回）
   * 账号还没开启任何 2FA 时（首次开启）不需要传。
   */
  startTotp: (stepUp?: TwoFactorStepUp) =>
    request<{ secret: string; otpauthUrl: string }>("/settings/2fa/totp/start", {
      method: "POST",
      body: JSON.stringify(stepUp ?? {}),
    }),

  /** 用认证器上的一次动态码确认，成功则返回恢复码（仅此一次明文） */
  confirmTotp: (code: string) =>
    request<{ ok: boolean; recoveryCodes: string[] }>("/settings/2fa/totp/confirm", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),

  /** 单独关闭 TOTP（需验 TOTP 动态码或恢复码；被强制的角色不允许） */
  disableTotp: (stepUp?: TwoFactorStepUp) =>
    request<{ ok: boolean }>("/settings/2fa/totp/disable", {
      method: "POST",
      body: JSON.stringify(stepUp ?? {}),
    }),

  /** 把二次验证码发到邮箱（仅在已开启邮箱方式时可用），返回本次挑战 id */
  sendStepUpCode: () =>
    request<{ challengeId: string; expiresAt: string }>("/settings/2fa/step-up/send", {
      method: "POST",
    }),

  /** 开关邮箱验证方式 */
  /**
   * 开关邮箱二次验证。
   * ⚠️ 关闭时要验**邮箱验证码**（或恢复码）；开启时账号已有别的 2FA 则验任一已开启方式。
   * ⚠️ 开启时若当前没有可用的恢复码，服务端会发一批新的（明文只出现在这次响应里）。
   */
  setEmail: (enabled: boolean, stepUp?: TwoFactorStepUp) =>
    request<{ ok: boolean; emailEnabled: boolean; recoveryCodes?: string[] }>("/settings/2fa/email", {
      method: "POST",
      body: JSON.stringify({ enabled, ...(stepUp ?? {}) }),
    }),

  /** 重新生成恢复码（旧的全部作废；需先验一个当前可用的码） */
  regenerateRecovery: (stepUp?: TwoFactorStepUp) =>
    request<{ recoveryCodes: string[] }>("/settings/2fa/recovery/regenerate", {
      method: "POST",
      body: JSON.stringify(stepUp ?? {}),
    }),

  /** 关闭全部 2FA（需先验一个当前有效的码；被强制的角色不允许） */
  disable: (code: string, challengeId?: string) =>
    request<{ ok: boolean }>("/settings/2fa/disable", {
      method: "POST",
      body: JSON.stringify(challengeId ? { code, challengeId } : { code }),
    }),

  /** 站长兜底：清掉某人的 2FA（丢了手机时用） */
  adminReset: (userId: string) =>
    request<{ ok: boolean }>("/admin/2fa/reset", {
      method: "POST",
      body: JSON.stringify({ userId }),
    }),
}

export const feedbackApi = {  /** 我提交过的反馈 + 分类/状态标签（标签文案由服务端下发，前端不硬编码） */
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

  /** 编辑还没被处理的反馈（pending 才可改） */
  edit: (id: string, payload: { category: string; title: string; body: string; images?: string[] }) =>
    request<{ feedback: FeedbackItem }>(`/feedback/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),

  /** 撤销（删除）还没被处理的反馈 */
  withdraw: (id: string) =>
    request<{ ok: boolean }>(`/feedback/${encodeURIComponent(id)}`, { method: "DELETE" }),

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
  /** 授予（一人可持多个称号；重复授予同一个是幂等的，不会重复添加） */
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

// ---- 管理面板 · DNS 解析管理（2026-10-01）----
//
// 独立成对象而不是塞进 adminApi：adminApi 已经很长，且这个模块有自己的
// 「列表 / 扫描 / 处置 / 对账」四段语义。

export const adminDnsApi = {
  /**
   * 全站 DNS 记录列表。
   *
   * `severity` 支持 high / medium / low / any（只看有问题的）/ none（只看干净的）。
   * 注意严重度是服务端**算**出来的（规则引擎），不是在 SQL 里筛的，所以要传给它。
   */
  list: (params: {
    q?: string
    type?: string
    severity?: string
    proxied?: string
    status?: string
    username?: string
    includeIgnored?: boolean
    page?: number
    pageSize?: number
  } = {}) => {
    const sp = new URLSearchParams()
    if (params.q) sp.set("q", params.q)
    if (params.type) sp.set("type", params.type)
    if (params.severity) sp.set("severity", params.severity)
    if (params.proxied) sp.set("proxied", params.proxied)
    if (params.status) sp.set("status", params.status)
    if (params.username) sp.set("username", params.username)
    if (params.includeIgnored) sp.set("includeIgnored", "1")
    if (params.page) sp.set("page", String(params.page))
    if (params.pageSize) sp.set("pageSize", String(params.pageSize))
    const qs = sp.toString()
    return request<AdminDnsListResponse>(`/admin/dns${qs ? "?" + qs : ""}`)
  },

  /** 编辑一条记录（站长视角：可改类型、内容、TTL、代理开关） */
  update: (
    id: string,
    payload: {
      name?: string
      type?: string
      content?: string
      ttl?: number
      proxied?: boolean
      priority?: number
    }
  ) =>
    request<{ record: AdminDnsRecord; cfError: string | null }>(
      `/admin/dns/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify(payload) }
    ),

  /** 删除一条记录（Cloudflare 侧一并删） */
  remove: (id: string) =>
    request<{ ok: boolean; cfError: string | null }>(`/admin/dns/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  /** 立刻扫描；deep=true 时额外做真实解析探测（会打 DNS-over-HTTPS） */
  audit: (deep = false) =>
    request<{ summary: AdminDnsAuditSummary }>(`/admin/dns/audit${deep ? "?deep=1" : ""}`, {
      method: "POST",
    }),

  findings: (params: { status?: string; severity?: string; q?: string; page?: number } = {}) => {
    const sp = new URLSearchParams()
    if (params.status) sp.set("status", params.status)
    if (params.severity) sp.set("severity", params.severity)
    if (params.q) sp.set("q", params.q)
    if (params.page) sp.set("page", String(params.page))
    const qs = sp.toString()
    return request<AdminDnsFindingsResponse>(`/admin/dns/findings${qs ? "?" + qs : ""}`)
  },

  /** 处置一条发现项（忽略必须写备注；恢复则清空） */
  reviewFinding: (id: string, status: "ignored" | "open", note?: string) =>
    request<{ ok: boolean }>(`/admin/dns/findings/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ status, note }),
    }),

  /** 本地台账 vs Cloudflare 实际记录对账 */
  cfDiff: () => request<AdminDnsCfDiff>("/admin/dns/cf-diff"),

  /** 删除 Cloudflare 上一条无主记录（该 cfId 不在本地表里） */
  removeOrphan: (cfId: string) =>
    request<{ ok: boolean }>(`/admin/dns/cf-orphan/${encodeURIComponent(cfId)}`, {
      method: "DELETE",
    }),
}

/**
 * 子域名管理（管理面板）。
 *
 * 与用户侧 `domainApi` 的分工：那套只能管自己的域名；这套按 dns 管理权限
 * 鉴权，可代替任意用户增删改（改名会同步 DNS/名片/网盘/Cloudflare）。
 */
export const adminSubdomainsApi = {
  /** 全站列表（可按域名/用户名/邮箱搜索） */
  list: (params: { q?: string; page?: number; pageSize?: number } = {}) => {
    const sp = new URLSearchParams()
    if (params.q) sp.set("q", params.q)
    if (params.page) sp.set("page", String(params.page))
    if (params.pageSize) sp.set("pageSize", String(params.pageSize))
    const qs = sp.toString()
    return request<AdminSubdomainListResponse>(`/admin/subdomains${qs ? "?" + qs : ""}`)
  },

  /** 归属用户联想搜索（按用户名/邮箱，最多 20 条） */
  searchOwners: (q: string) =>
    request<{ owners: { id: string; username: string; email: string; status: string }[] }>(
      `/admin/subdomains/owners?q=${encodeURIComponent(q)}`
    ),

  /**
   * 代替指定用户创建。
   * `parentId` 指定时归属由父级决定（传 owner 会被拒）；
   * 一级必须给 `userId` 或 `username`，`rootDomain` 省略则用默认域。
   */
  create: (payload: {
    userId?: string
    username?: string
    name: string
    parentId?: string
    rootDomain?: string
  }) =>
    request<{ subdomain: AdminSubdomain }>("/admin/subdomains", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  /** 改名 / 转移所有者（可同时传） */
  update: (id: string, payload: { name?: string; userId?: string; username?: string }) =>
    request<{ subdomain: AdminSubdomain }>(`/admin/subdomains/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  /** 删除（含全部下级；主域名不可删） */
  remove: (id: string) =>
    request<void>(`/admin/subdomains/${encodeURIComponent(id)}`, { method: "DELETE" }),
}

/**
 * 管理端 · 邮箱管理（与子域名管理同一形态，按 dns 管理scope鉴权）。
 *
 * 与用户侧 `/mailbox` 的差异：可跨用户增删改（含改地址）、转发目标免验证、
 * 不占用户 3 个名额、可删主邮箱、可查看邮件内容（只读，不改用户已读状态）。
 */
export const adminMailboxesApi = {
  /** 全站列表（可按地址/用户名/邮箱搜索） */
  list: (params: { q?: string; page?: number; pageSize?: number } = {}) => {
    const sp = new URLSearchParams()
    if (params.q) sp.set("q", params.q)
    if (params.page) sp.set("page", String(params.page))
    if (params.pageSize) sp.set("pageSize", String(params.pageSize))
    const qs = sp.toString()
    return request<AdminMailboxListResponse>(`/admin/mailboxes${qs ? "?" + qs : ""}`)
  },

  /** 归属用户联想搜索（按用户名/邮箱，最多 20 条） */
  searchOwners: (q: string) =>
    request<{ owners: { id: string; username: string; email: string; status: string }[] }>(
      `/admin/mailboxes/owners?q=${encodeURIComponent(q)}`
    ),

  /** 代替指定用户创建邮箱（不占用户名额；根域仍须已启用） */
  create: (payload: { userId?: string; username?: string; localPart: string; domain?: string }) =>
    request<{ mailbox: AdminMailbox }>("/admin/mailboxes", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  /** 改名（前缀/域）与转发目标；`forwardingTo` 传 `[]` = 清空转发 */
  update: (
    id: string,
    payload: { localPart?: string; domain?: string; forwardingTo?: string[] | null }
  ) =>
    request<{ mailbox: AdminMailbox }>(`/admin/mailboxes/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  /** 删除（含邮件；与用户侧同一条清理路径。⚠️ 主邮箱也能删） */
  remove: (id: string) =>
    request<{ ok: boolean; address: string }>(`/admin/mailboxes/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  /** 邮件列表（不含正文，游标翻页）。⚠️ 只读，不会把邮件标成已读 */
  messages: (id: string, params: { cursor?: string; limit?: number } = {}) => {
    const sp = new URLSearchParams()
    if (params.cursor) sp.set("cursor", params.cursor)
    if (params.limit) sp.set("limit", String(params.limit))
    const qs = sp.toString()
    return request<{
      mailbox: { id: string; address: string; ownerUsername: string }
      messages: AdminMailboxMessage[]
      nextCursor: string | null
    }>(`/admin/mailboxes/${encodeURIComponent(id)}/messages${qs ? "?" + qs : ""}`)
  },

  /** 单封邮件详情（含正文；同样不会标已读，但会记一条审计） */
  message: (id: string, messageId: string) =>
    request<{
      mailbox: { id: string; address: string; ownerUsername: string }
      message: AdminMailboxMessageDetail
    }>(
      `/admin/mailboxes/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}`
    ),
}

// ---- AI实验室 ----


/** 作品摘要（列表用，不含文件内容） */
export interface LabProjectSummary {
  id: string
  name: string
  slug: string
  icon: string
  description: string
  /** private（默认）/ pending（待审核）/ public（已公开）/ rejected（已驳回） */
  visibility: string
  /** 被驳回时的原因；其余状态为空串 */
  reviewNote?: string
  /** 有没有上传封面图（没有就用 icon 那个 emoji） */
  hasCover?: boolean
  /** 封面版本号（拼进封面 URL，换图后缓存立刻失效） */
  coverV?: string
  views: number
  likes: number
  createdAt: string
  updatedAt: string
  /** 首次公开的时间；从未公开过为 null */
  publishedAt?: string | null
}

/** 作品详情（含文件：路径 → 内容） */
export interface LabProject extends LabProjectSummary {
  files: Record<string, string>
}

/** 造物集里的一个公开作品（列表用，不含文件内容） */
export interface GalleryItem {
  id: string
  name: string
  icon: string
  description: string
  /** 有封面图 ⇒ 用 `/api/gallery/:id/cover` 当封面，否则回退 icon 那个 emoji */
  hasCover?: boolean
  views: number
  likes: number
  /** 当前用户有没有点过赞 */
  liked?: boolean
  updatedAt: string
  publishedAt: string | null
  authorName: string
  /** 真实用户名（头像 URL 要用它，不能拿「昵称优先」的 authorName 去拼） */
  authorUsername: string
  authorAvatar: string | null
  /**
   * 封面的版本号（跟着封面文件走）。
   * ⚠️ 必须拼进封面 URL：封面接口的地址是固定的 `/gallery/:id/cover`，
   *    换图后 URL 不变 ⇒ 浏览器/边缘缓存会一直吐旧图（2026-10-09 站长反馈）。
   */
  coverV?: string
  /** 可见性：只有 public 才有可分享链接 */
  visibility?: string
  /** 是不是自己的作品 */
  isMine: boolean
}

/** 公开作品详情（含文件内容，用于在沙箱 iframe 里渲染） */
export interface GalleryDetail extends GalleryItem {
  files: Record<string, string>
}

/** 发起一次流式聊天（SSE），返回原始 Response 交给页面解析。
 *  非 2xx 已按全站统一规则翻译成 HttpError 抛出。 */
export async function streamLabChat(payload: {
  model: string
  /** 纯文本消息是 string；带图的是 part 数组（见 lab.tsx 的 takeAttachments） */
  messages: { role: string; content: string | unknown[] }[]
  /** 思考强度档位（后端据此决定要不要带 reasoning_effort） */
  effort?: string
  /** 由前端按思考强度算好的温度；后端只做范围收口 */
  temperature?: number
  /** 选用管理员提供的免费渠道时带上它的 id（不传 = 走站内） */
  channelId?: string
  signal?: AbortSignal
}): Promise<Response> {
  const res = await fetch(`${BASE}/lab/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      model: payload.model,
      messages: payload.messages,
      effort: payload.effort,
      temperature: payload.temperature,
      channelId: payload.channelId,
    }),
    signal: payload.signal,
  })
  if (!res.ok) {
    await throwHttpError(res)
  }
  return res
}

export const labApi = {
  /**
   * 站内模型列表。
   * `free: true` = 走的是管理员提供的统一 Key（用户端标「免费试用」）。
   * 未开通/未绑定时抛 NOT_BOUND，据此引导。
   */
  models: () => request<{ models: string[]; free?: boolean; freeModels?: string[] }>("/lab/models"),

  /** 管理员提供的免费渠道 + 免费额度余量（渠道不含地址与密钥，调用走服务端代理） */
  channels: () =>
    request<{
      source: "user" | "admin"
      quotaLimit: number
      quotaPeriod: "day" | "month" | "total"
      quotaUsed: number
      channels: { id: string; name: string; model: string; free: boolean }[]
    }>("/lab/channels"),

  /**
   * 实验室前端配置。
   *
   * 优先级（前端的 `buildSystemPrompt` 按这个顺序取）：
   *   1. 用户当前选中的模板（`templates` 里挑一份）；
   *   2. `agentPrompt`（管理端旧的单份覆盖值，非空才生效）；
   *   3. 内置默认提示词。
   * `templates` 为空 = 管理端没启用任何模板，走 2 / 3。
   */
  settings: () =>
    request<{
      agentPrompt: string
      reviewRequired?: boolean
      templates?: LabPromptTemplate[]
      /**
       * 技能**索引**（只有名字 + 一句话，**没有正文**）。
       * 渐进式披露：这一份进系统提示当目录；模型要用了才去调 `readSkill` 取正文。
       */
      skills?: LabSkillIndexEntry[]
      /**
       * 联网搜索的**用户级开关**（默认关）。
       * 只有 enabled 为 true 时前端才会把 <lab_web_search> 告诉模型 ——
       * 关着时模型压根不知道有这东西，也就不会去搜、不会被扣分。
       */
      webSearch?: { enabled: boolean; siteAvailable: boolean; cost: number }
    }>("/lab/settings"),

  /**
   * 取一个技能的正文。
   * ⚠️ 走的是独立路径 `/lab/skill-content`，不是 `/lab/skills/:id`
   * —— 后者是删除用的 branch，GET 会和它抢匹配（见后端 index.ts 的注释）。
   */
  readSkill: (name: string) =>
    request<{ skill: { name: string; description: string; content: string } }>(
      `/lab/skill-content?name=${encodeURIComponent(name)}`
    ),

  /**
   * 联网搜索（Tavily）。
   * ⚠️ 必须走服务端：key 只在服务端，浏览器拿不到。
   * 服务端已经决定「用你自己的 key 还是站点 key、扣不扣积分」，前端不用管。
   */
  webSearch: (query: string) =>
    request<{ text: string; charged: number; source: "own" | "site" }>("/lab/web-search", {
      method: "POST",
      body: JSON.stringify({ query }),
    }),

  /**
   * 代拉自定义渠道的模型列表。
   * ⚠️ 必须走服务端：浏览器直连第三方地址会被 CORS 拦掉（预检也过不去）。
   * 服务端那边对地址做了内网/回环/云元数据端点的拦截。
   */
  probeModels: (payload: { baseUrl: string; apiKey: string }) =>
    request<{ models: string[] }>("/lab/probe-models", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  /** 我的搜索 key 状态（**只回有没有配，不回内容**） */
  searchKeyInfo: () =>
    request<{
      hasOwn: boolean
      siteAvailable: boolean
      cost: number
      /** 站点允不允许用户自带 key */
      enabled: boolean
      /** **我自己的**联网搜索总开关（默认关） */
      webSearchEnabled: boolean
    }>("/lab/search-key"),

  /**
   * 改我的联网搜索设置。
   * ⚠️ 两个字段可以分开发：只传 `key` 不动开关，只传 `webSearchEnabled` 不动 key。
   * `key: ""` = 清除自己的 key。
   */
  setSearchKey: (payload: { key?: string; webSearchEnabled?: boolean }) =>
    request<{ hasOwn: boolean; webSearchEnabled: boolean }>("/lab/search-key", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  listSkills: () => request<{ skills: LabSkillEntry[] }>("/lab/skills"),

  importSkill: (body: { name: string; description: string; content: string }) =>
    request<{ skill: LabSkillEntry }>("/lab/skills", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  deleteSkill: (id: string) =>
    request<void>(`/lab/skills/${encodeURIComponent(id)}`, { method: "DELETE" }),

  listProjects: () => request<{ projects: LabProjectSummary[] }>("/lab/projects"),

  getProject: (id: string) =>
    request<{ project: LabProject }>(`/lab/projects/${encodeURIComponent(id)}`),

  saveProject: (payload: {
    id?: string
    name: string
    description?: string
    icon?: string
    files: Record<string, string>
  }) =>
    request<{ project: LabProject }>("/lab/projects", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  deleteProject: (id: string) =>
    request<void>(`/lab/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /**
   * 上传作品封面（原图直传，服务端上限 600KB）。
   * 前端负责先把图压到这个尺寸以内，这里只做「把字节扔过去」这一件事。
   */
  uploadCover: (id: string, blob: Blob) =>
    request<{ hasCover: boolean; coverV?: string }>(
      `/lab/projects/${encodeURIComponent(id)}/cover`,
      {
        method: "POST",
        headers: { "Content-Type": blob.type || "image/png" },
        body: blob,
      }
    ),

  /** 移除封面（回退到 emoji 图标） */
  deleteCover: (id: string) =>
    request<{ hasCover: boolean }>(`/lab/projects/${encodeURIComponent(id)}/cover`, {
      method: "DELETE",
    }),

  /**
   * 公开 / 取消公开一个作品，并顺手更新对外信息（名字 / 简介 / 图标）。
   *
   * 刻意和 saveProject 分开：保存是编辑动作（改一行代码就会调一次），
   * 公开是对外承诺。混在一起会出现「改个背景色把简介清空了」。
   */
  publish: (
    id: string,
    payload: {
      /**
       * 目标可见性。
       * **不传 = 不改可见性**，只更新名字 / 简介 / 图标 —— 编辑「待审核」作品的
       * 介绍信息时不会顺手把公开申请撤掉。
       */
      visibility?: "public" | "private"
      name?: string
      description?: string
      icon?: string
    }
  ) =>
    request<{ project: LabProjectSummary }>(
      `/lab/projects/${encodeURIComponent(id)}/publish`,
      { method: "POST", body: JSON.stringify(payload) }
    ),
}

export const galleryApi = {
  /** 展示大厅：全体用户的公开作品（分页 + 关键词） */
  list: (params: { page?: number; q?: string } = {}) => {
    const sp = new URLSearchParams()
    if (params.page) sp.set("page", String(params.page))
    if (params.q) sp.set("q", params.q)
    const qs = sp.toString()
    return request<{
      total: number
      page: number
      pageSize: number
      items: GalleryItem[]
    }>(`/gallery${qs ? `?${qs}` : ""}`)
  },

  /** 公开作品详情（含文件内容）。非本人访问会在后端计一次浏览。 */
  get: (id: string) =>
    request<{ project: GalleryDetail }>(`/gallery/${encodeURIComponent(id)}`),

  /**
   * 点赞 / 取消点赞（同一个接口来回切）。
   * 返回的最新计数与「我现在赞没赞」由服务端算好，前端直接用，别自己 ±1。
   */
  like: (id: string) =>
    request<{ likes: number; liked: boolean }>(
      `/gallery/${encodeURIComponent(id)}/like`,
      { method: "POST" }
    ),
}

/**
 * 作品封面图的 URL。
 *
 * 故意不做成 API 方法：`<img src>` 直接用它就够了，走字符串最省事，
 * 也避免每次渲染都去构造一个 fetch 请求对象。
 */
export function galleryCoverUrl(id: string, v?: string): string {
  const base = `${BASE}/gallery/${encodeURIComponent(id)}/cover`
  return v ? `${base}?v=${encodeURIComponent(v)}` : base
}
