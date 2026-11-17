/**
 * 全站「功能总开关」注册表 —— 一处定义，三处消费。
 *
 * 背景（2026-11-16 站长要求）：
 *   站点功能已经多到「想省额度时不知道该关哪个」，而历史上各模块的开关是**各写各的**
 *   （`storage_enabled` / `chat_enabled` / `newapi_enabled` …），有的只在某个 handler
 *   里读一次、有的前端藏了入口后端却照样放行。于是出现「关了入口，额度照烧」。
 *
 * 本文件的目标是把「关掉一个功能」变成一件确定的事：
 *   · 一个功能 = 一个 id + 一个设置键 + 一组接口前缀 + 一组后台任务；
 *   · 关掉后：① 所有 HTTP 入口在 `index.ts` 的 route() 里被统一拦成 403
 *     `FEATURE_DISABLED`（不依赖每个 handler 自己记得判断）；
 *     ② 该功能的后台定时任务跳过（见 index.ts 的 scheduled）；
 *     ③ 公开资源路径（/dl /s /p /u /c、名片页、宿主直链）同样被拦；
 *     ④ 前端据 `GET /api/features` 隐藏入口并停止对应轮询。
 *
 * ⚠️ 三条硬约束（改之前先读）：
 *   1. **`/admin/*` 永不拦** —— 管理面板是「把功能重新打开」的唯一入口，
 *      拦了就等于自锁。同理 `/me`、`/settings`、`/login`、`/logout`、`/password`、
 *      `/register`、`/appeal`、`/attention`、`/notifications`、`/notice` 是账户底座，
 *      不挂任何功能开关。
 *   2. **前缀匹配取最长** —— `/mail/img` 与 `/mail` 都会命中 mail，取最长者；
 *      新增功能时不要把更宽的公共前缀（如 `/me`）写进来。
 *   3. **新增设置键必须同时进 `settings.ts` 的 `SETTING_DEFAULTS`**，
 *      否则 `updateSettings` 会把它过滤掉（写不进去，表现为「点了没反应」）。
 *
 * 额度与功能的关系（2026-11-16 审计结论）见 docs/worker额度消耗排序-2026-11-16.md：
 * 关掉「第三方邮箱同步」「每小时运维」「全局轮询」能省最多额度，
 * 而关掉用户操作类功能（发帖/商城/签到）几乎不省额度 —— 本表的 `costHint`
 * 就是给管理员看这个的。
 */
import { ApiError } from "./http"
import { SETTING_DEFAULTS, type SettingKey } from "./settings"
import { cached, invalidateCache } from "./short-cache"
import type { Env } from "./env"

/** 功能分组（与前端「功能开关」页的分栏一致） */
export const FEATURE_GROUPS = [
  { key: "mail", label: "邮箱与域名" },
  { key: "ai", label: "AI 与中转站" },
  { key: "net", label: "网络与代理" },
  { key: "social", label: "社区与沟通" },
  { key: "create", label: "创作与娱乐" },
  { key: "ops", label: "积分与运营" },
  { key: "system", label: "系统与对外接口" },
] as const

export type FeatureGroupKey = (typeof FEATURE_GROUPS)[number]["key"]

/** 后台定时任务键 —— 与 `index.ts` scheduled 里的分支一一对应 */
export type FeatureJobKey =
  | "mailSync"
  | "trashPurge"
  | "gameTick"
  | "frpProbe"
  | "frpReconcile"
  | "frpAutoRenew"
  | "dnsAutoRenew"
  | "pointsAutoConfirm"
  | "eventClaims"
  | "eventQuotaRetry"
  | "eventTgRevoke"
  | "donationHealth"
  | "newapiSync"
  | "wb2Resume"
  | "qoderResume"
  | "tgDigest"

/** 公开资源入口键 —— `index.ts` 的 fetch() 在 route() 之前处理的那些 */
export type PublicPathKey =
  | "directLink" // /dl/<user>/<file>
  | "storageShare" // /s/<token>
  | "avatar" // /u/<user>/avatar
  | "communityImage" // /c/<post>/<file>
  | "profileAsset" // /p/<user>/<asset> 与 /p/<user>/gallery/<id>
  | "profilePage" // /profile/<slug>（HTML）与自定义名片域
  | "hostedLink" // 用户绑定的直链域（宿主反代 R2）
  | "hostedLab" // 用户绑定的作品域
  | "tgWebhook" // /tg/webhook 与 /api/tg/webhook
  | "mailImage" // /mail/img（邮件图片代理）

export interface FeatureDef {
  id: string
  /** 设置键（`app_settings`）。多数是历史上已有的 `*_enabled` */
  settingKey: SettingKey
  /** 展示名（中文；英文名走前端 i18n） */
  label: string
  group: FeatureGroupKey
  /** 关掉之后**会发生什么**（给管理员看的后果说明，别写成营销文案） */
  impact: string
  /** 额度提示：这个开关大概能省哪一块（见额度排序报告） */
  costHint: string
  /** API 路径前缀（相对 `/api`）；最长前缀优先 */
  routes: string[]
  /** 后台任务键：index.ts 的 scheduled 里按这些键跳过 */
  jobs?: FeatureJobKey[]
  /** 公开资源入口（`index.ts` 里 **不经过 route()** 的那些） */
  publicPaths?: PublicPathKey[]
  /**
   * 「功能关了也要能读」的状态类接口（精确路径 + 方法）。
   *
   * 为什么需要：有些 GET 接口存在的意义就是**告诉前端「这个功能关了」** ——
   * 比如 `GET /checkin` 要回 `{ enabled:false, today }`（前端不必等开关打开才知道今天几号），
   * `GET /storage` 要回 `{ featureEnabled:false }` 让页面渲染「已关闭」而不是报错。
   * 把这些一并 403 掉，用户看到的是「服务器错误」而不是「功能已关闭」。
   *
   * ⚠️ 只允许列**只读、无副作用**的接口；写接口一律不给豁免。
   */
  exempt?: { path: string; methods: string[] }[]
}

/**
 * 注册表本体。
 *
 * ⚠️ 顺序不影响匹配（匹配时按前缀长度排序），但**建议按分组排**，便于人工核对。
 */
export const FEATURE_DEFS: FeatureDef[] = [
  // ===================== 邮箱与域名 =====================
  {
    id: "mail",
    settingKey: "mail_enabled",
    label: "邮箱中心",
    group: "mail",
    impact: "收件箱/读信/标记已读全部关闭；入站邮件不再落库（直接丢弃并记日志）；邮件图片代理一并关闭。",
    costHint: "省：入站邮件解析（CPU）、收件箱 15s 轮询、邮件图片代理（每图 1 请求 + 1 行写）",
    routes: ["/mailbox", "/mail"],
    publicPaths: ["mailImage"],
    jobs: ["trashPurge"],
  },
  {
    id: "externalMailSync",
    settingKey: "external_mail_sync_enabled",
    label: "第三方邮箱同步",
    group: "mail",
    impact: "不再定时连 IMAP / Outlook 拉信；已拉取的邮件仍在库里可读。",
    costHint: "省：CPU 第一大户（每分钟 2 个账号 × TLS + MIME 解析）+ 行写",
    routes: ["/mail/accounts", "/mail/oauth"],
    jobs: ["mailSync"],
  },
  {
    id: "tempbox",
    settingKey: "tempbox_enabled",
    label: "临时分享箱",
    group: "mail",
    impact: "不能创建新的临时分享箱；已创建的到期对象仍由每小时运维清理。",
    costHint: "省：少量（创建时几次查询 + R2 写入）",
    routes: ["/tempbox"],
    exempt: [{ path: "/tempbox/config", methods: ["GET"] }],
  },
  {
    id: "domains",
    settingKey: "domains_enabled",
    label: "子域名",
    group: "mail",
    impact: "不能新建/删除子域名；已存在的解析与邮箱不受影响。",
    costHint: "省：少量（写操作会打 Cloudflare API）",
    routes: ["/subdomains"],
  },
  {
    id: "dns",
    settingKey: "dns_enabled",
    label: "DNS 解析",
    group: "mail",
    impact: "不能建/改/删解析记录，DNS 租用不可购买与续费；已有记录不再同步。",
    costHint: "省：每小时 DNS 租约巡检 + 每次写操作的 2 次 CF API 子请求",
    routes: ["/dns"],
    jobs: ["dnsAutoRenew"],
  },
  {
    id: "storage",
    settingKey: "storage_enabled",
    label: "网盘与直链",
    group: "mail",
    impact: "不能上传/下载/分享；已发出的直链（/dl、/s、自定义域）一并失效。",
    costHint: "省：R2 Class A/B 操作 + 每个文件一次 Worker 请求（R2 操作第一大户）",
    routes: ["/storage"],
    exempt: [{ path: "/storage", methods: ["GET"] }],
    publicPaths: ["directLink", "storageShare", "hostedLink"],
  },

  // ===================== AI 与中转站 =====================
  {
    id: "ai",
    settingKey: "newapi_enabled",
    label: "AI 中转站",
    group: "ai",
    impact: "不能开通/查用量/建 Key/兑换；中转站入驻登记关闭；每小时账号同步停止。",
    costHint: "省：每小时全量账号同步（每账号 1 次子请求）+ 页面查询",
    routes: ["/dev", "/ai", "/relay"],
    exempt: [{ path: "/dev/status", methods: ["GET"] }],
    jobs: ["newapiSync"],
  },
  {
    id: "wb2api",
    settingKey: "wb2api_enabled",
    label: "WorkBuddy 通道",
    group: "ai",
    impact: "不能发起绑定/登录；每分钟的号池登录恢复停止。",
    costHint: "省：每分钟 1 次恢复任务（含 D1 查询）",
    routes: ["/wb2api"],
    exempt: [{ path: "/wb2api/status", methods: ["GET"] }],
    jobs: ["wb2Resume"],
  },
  {
    id: "qoder2api",
    settingKey: "qoder2api_enabled",
    label: "Qoder 通道",
    group: "ai",
    impact: "不能发起绑定/登录；每分钟的号池登录恢复停止。",
    costHint: "省：每分钟 1 次恢复任务（含 D1 查询）",
    routes: ["/qoder2api"],
    exempt: [{ path: "/qoder2api/status", methods: ["GET"] }],
    jobs: ["qoderResume"],
  },
  {
    id: "lab",
    settingKey: "lab_enabled",
    label: "AI 实验室",
    group: "ai",
    impact: "作品编辑/预览/AI 对话/联网搜索/截图自检全部关闭；作品域名不再对外服务。",
    costHint: "省：AI 流式转发（CPU）+ 20s 自动保存（R2）+ 截图（Browser Rendering 额度）",
    routes: ["/lab"],
    publicPaths: ["hostedLab"],
  },

  // ===================== 网络与代理 =====================
  {
    id: "proxy",
    settingKey: "proxy_enabled",
    label: "代理节点",
    group: "net",
    impact: "不能拉订阅、测速、开关代理；站点探针不受影响（那是健康检查，与代理无关）。",
    costHint: "省：订阅拉取（每次 ~200 行读）+ 节点测速的 TCP 连接",
    routes: ["/proxy"],
    exempt: [{ path: "/proxy", methods: ["GET"] }],
  },
  {
    id: "frp",
    settingKey: "frp_enabled",
    label: "内网穿透",
    group: "net",
    impact: "不能购买/续费/查看租约；agent 上报与节点探活、5 分钟收敛一并停止。",
    costHint: "省：每 5 分钟全节点 TCP 探活 + 收敛推送 + 每小时自动续费",
    routes: ["/frp"],
    jobs: ["frpProbe", "frpReconcile", "frpAutoRenew"],
  },

  // ===================== 社区与沟通 =====================
  {
    id: "community",
    settingKey: "community_enabled",
    label: "社区广场",
    group: "social",
    impact: "不能发帖/评论/点赞；帖子图片（/c/...）不再对外；未登录访客入口一并关闭。",
    costHint: "省：帖子列表 JOIN（行读）+ 30s 轮询 + 图片 R2",
    routes: ["/community"],
    exempt: [{ path: "/community/config", methods: ["GET"] }],
    publicPaths: ["communityImage"],
  },
  {
    id: "chat",
    settingKey: "chat_enabled",
    label: "聊天室",
    group: "social",
    impact: "不能发消息/在线状态/表情回应；前端聊天页停止 5s 轮询（这是历史上行写打满的元凶）。",
    costHint: "省：行读/行写大户（840 请求/小时/人，历史上占全库行读 63%）",
    routes: ["/chat"],
  },
  {
    id: "dm",
    settingKey: "dm_enabled",
    label: "私信",
    group: "social",
    impact: "不能收发私信；私信页停止 5s 轮询。",
    costHint: "省：私信 5s 轮询（720 请求/小时/人）+ 会话列表查询",
    routes: ["/dm"],
  },
  {
    id: "profile",
    settingKey: "profile_enabled",
    label: "个人名片",
    group: "social",
    impact: "名片编辑/发布/自定义域名关闭；已发布的名片页（/profile/... 与 /p/... 资源）不再对外。",
    costHint: "省：名片 HTML 渲染（CPU）+ 头像/背景 R2 读取",
    routes: ["/profile"],
    publicPaths: ["profilePage", "profileAsset", "avatar"],
  },
  {
    id: "space",
    settingKey: "space_enabled",
    label: "个人空间",
    group: "social",
    impact: "个人空间页与公开空间数据关闭。",
    costHint: "省：少量（低频查询）",
    routes: ["/my-space"],
  },
  {
    id: "stickers",
    settingKey: "stickers_enabled",
    label: "表情包",
    group: "social",
    impact: "不能保存/使用自定义表情包（已保存的仍留在库里）。",
    costHint: "省：少量（R2 写入）",
    routes: ["/stickers"],
  },
  {
    id: "feedback",
    settingKey: "feedback_enabled",
    label: "反馈",
    group: "social",
    impact: "用户不能提交反馈/回复/上传截图；管理端历史反馈仍可查看。",
    costHint: "省：少量（提交时几次查询 + 图片 R2）",
    routes: ["/feedback"],
  },

  // ===================== 创作与娱乐 =====================
  {
    id: "gallery",
    settingKey: "gallery_enabled",
    label: "造物集（图片墙）",
    group: "create",
    impact: "图片墙浏览与上传关闭；已上传作品仍由管理端可管。",
    costHint: "省：图片列表查询 + R2 读取",
    routes: ["/gallery"],
  },
  {
    id: "game",
    settingKey: "game_enabled",
    label: "在线投资（造物典藏）",
    group: "create",
    impact: "行情页关闭；每分钟的行情推进与强平停止；已有仓位只能等重新开启后处理。",
    costHint: "省：3s 轮询（1,200 请求/小时/人）+ 每次轮询的写库 + 每分钟 cron",
    routes: ["/collection"],
    jobs: ["gameTick"],
  },
  {
    id: "funLinks",
    settingKey: "fun_links_enabled",
    label: "趣站链接",
    group: "create",
    impact: "工具箱里的外链清单关闭。",
    costHint: "省：可忽略（一次列表查询）",
    routes: ["/fun-links"],
  },

  // ===================== 积分与运营 =====================
  {
    id: "points",
    settingKey: "points_enabled",
    label: "积分与商城",
    group: "ops",
    impact: "积分页/商城/兑换券/转账关闭；每小时「自动确认收货」停止（已成交订单仍可人工处理）。",
    costHint: "省：少量（每次操作 3~8 行写）",
    routes: ["/points", "/vouchers"],
    jobs: ["pointsAutoConfirm"],
  },
  {
    id: "checkin",
    settingKey: "checkin_enabled",
    label: "每日签到",
    group: "ops",
    impact: "签到、补签、自动签到关闭。",
    costHint: "省：可忽略（每人每天一次）",
    routes: ["/checkin"],
    exempt: [{ path: "/checkin", methods: ["GET"] }],
  },
  {
    id: "achievements",
    settingKey: "achievements_enabled",
    label: "成就",
    group: "ops",
    impact: "成就页与成就奖励关闭。",
    costHint: "省：可忽略（低频聚合查询，单次几万行读）",
    routes: ["/achievements"],
  },
  {
    id: "leaderboard",
    settingKey: "leaderboard_enabled",
    label: "排行榜",
    group: "ops",
    impact: "排行榜页面关闭。",
    costHint: "省：可忽略（低频聚合查询）",
    routes: ["/leaderboard"],
  },
  {
    id: "titles",
    settingKey: "titles_enabled",
    label: "称号",
    group: "ops",
    impact: "用户不能佩戴/查看称号；已佩戴的展示仍保留在名片上。",
    costHint: "省：可忽略",
    routes: ["/titles"],
  },
  {
    id: "events",
    settingKey: "events_enabled",
    label: "活动与问卷",
    group: "ops",
    impact: "不能参与活动/答题/抽奖；领奖兜底与 TG 退订复查停止。",
    costHint: "省：少量（开奖时串行写 D1）",
    routes: ["/events"],
    jobs: ["eventClaims", "eventQuotaRetry", "eventTgRevoke"],
  },
  {
    id: "donations",
    settingKey: "donations_enabled",
    label: "资源捐献",
    group: "ops",
    impact: "不能提交/领取捐献；每 15 分钟的账号健康巡检停止。",
    costHint: "省：每 15 分钟巡检（上游探测）+ 少量查询",
    routes: ["/donations", "/tip-qr"],
    jobs: ["donationHealth"],
  },

  // ===================== 系统与对外接口 =====================
  {
    id: "announcements",
    settingKey: "announcements_enabled",
    label: "公告",
    group: "system",
    impact: "公告列表与到点发布关闭（定时发布队列仍会跑，但没有公告可发）。",
    costHint: "省：可忽略",
    routes: ["/announcements"],
  },
  {
    id: "oauthProvider",
    settingKey: "oauth_provider_enabled",
    label: "OAuth 身份提供方",
    group: "system",
    impact: "本站不再作为 OAuth 提供方向第三方（如中转站）签发令牌与用户信息。",
    costHint: "省：少量（每次换令牌一次查询 + 写入）",
    routes: ["/oauth"],
  },
  {
    id: "publicApi",
    settingKey: "public_api_enabled",
    label: "公开 API（/v1）",
    group: "system",
    impact: "外部程序不能再通过 API Key 调用邮箱/域名/DNS 接口；已发 Key 一并失效（接口层拒绝）。",
    costHint: "省：外部调用不可控，被刷时是请求数大头",
    routes: ["/v1", "/api-key"],
  },
  {
    id: "push",
    settingKey: "push_enabled",
    label: "推送通知",
    group: "system",
    impact: "Web Push / FCM 推送停止（不弹系统通知，站内消息仍在）。",
    costHint: "省：每条通知 1~2 次出站子请求",
    routes: ["/push"],
  },
  {
    id: "telegram",
    settingKey: "telegram_enabled",
    label: "Telegram 机器人",
    group: "system",
    impact: "TG webhook 停止处理；每小时的管理提醒/日报停止。",
    costHint: "省：每条群消息 1 请求 + 上游 API；每小时 3 条推送",
    routes: [],
    publicPaths: ["tgWebhook"],
    jobs: ["tgDigest"],
  },
  {
    id: "qq",
    settingKey: "qq_enabled",
    label: "QQ 机器人",
    group: "system",
    impact: "QQ webhook 停止处理。",
    costHint: "省：每条群消息 1 请求 + 上游 API",
    routes: ["/qq"],
  },
  {
    id: "analytics",
    settingKey: "analytics_enabled",
    label: "访问统计",
    group: "system",
    impact: "前端不再上报页面浏览；管理端统计页只剩历史数据。",
    costHint: "省：每次页面切换 1 行写（全站 PV 全量入库）",
    routes: ["/analytics"],
  },
  {
    id: "perf",
    settingKey: "perf_collect_enabled",
    label: "性能采集（RUM）",
    group: "system",
    impact: "前端不再上报性能样本；「性能监控」页只剩历史数据。",
    costHint: "省：页面加载时 1 行写（限流 120 条/10 分钟/人）",
    routes: ["/perf"],
  },
  {
    id: "diagLog",
    settingKey: "diag_log_enabled",
    label: "诊断日志",
    group: "system",
    impact: "用户提交反馈时不能再附诊断日志。",
    costHint: "省：可忽略（单条最大 64KB，写一次）",
    routes: ["/diag-logs"],
  },
]

/** id → 定义（构建一次） */
const BY_ID = new Map(FEATURE_DEFS.map((f) => [f.id, f]))

/** 路由前缀表：按长度倒序，保证「最长前缀优先」 */
const ROUTE_TABLE: { prefix: string; feature: FeatureDef }[] = FEATURE_DEFS.flatMap((f) =>
  f.routes.map((r) => ({ prefix: r.toLowerCase(), feature: f }))
).sort((a, b) => b.prefix.length - a.prefix.length)

/** 按 API 路径找所属功能（`routePath` 已去掉 `/api` 前缀） */
export function featureForRoute(routePath: string): FeatureDef | null {
  const p = routePath.toLowerCase()
  for (const row of ROUTE_TABLE) {
    if (p === row.prefix || p.startsWith(row.prefix + "/")) return row.feature
  }
  return null
}

/** 按公开资源键找所属功能 */
export function featureForPublicPath(key: PublicPathKey): FeatureDef | null {
  return FEATURE_DEFS.find((f) => f.publicPaths?.includes(key)) ?? null
}

/** 按后台任务键找所属功能 */
export function featureForJob(key: FeatureJobKey): FeatureDef | null {
  return FEATURE_DEFS.find((f) => f.jobs?.includes(key)) ?? null
}

export function featureById(id: string): FeatureDef | null {
  return BY_ID.get(id) ?? null
}

/** 功能状态表（全部 id → 是否开启） */
export type FeatureStates = Record<string, boolean>

const CACHE_KEY = "feature-states"
/**
 * 进程内缓存时长。
 *
 * 为什么不每次读库：`route()` 对**每个请求**都要判断一次，直接查 D1 等于给全站
 * 每请求加一次往返。10 秒足够短 —— 管理员在面板里点关闭，最迟 10 秒生效，
 * 而面板本身会主动失效缓存（`invalidateFeatureStates`），所以实际操作是立刻生效。
 */
const CACHE_MS = 10_000

/** 与 `getSettingBool` 同口径：只有 "1"/"true" 算开 */
function isOn(raw: string): boolean {
  return raw === "1" || raw.toLowerCase() === "true"
}

/**
 * 这个开关在**改造前**的默认状态（读 SETTING_DEFAULTS，不看库）。
 *
 * 用途：管理面板要能标出「改造前本来就是关的」那三个（聊天室 / 性能采集 / 诊断日志）——
 * 否则管理员点「全部打开」会以为「什么都没变」，实际上是把这三项重新打开了。
 */
export function defaultEnabledOf(f: FeatureDef): boolean {
  return isOn(SETTING_DEFAULTS[f.settingKey])
}

/** 读全部功能状态（一次查询 + 10 秒进程内缓存） */
export async function getFeatureStates(env: Env): Promise<FeatureStates> {
  return cached<FeatureStates>(CACHE_KEY, CACHE_MS, async () => {
    try {
      const rows = await env.DB.prepare("SELECT key, value FROM app_settings").all<{
        key: string
        value: string
      }>()
      const map = new Map((rows.results ?? []).map((r) => [r.key, r.value]))
      const out: FeatureStates = {}
      for (const f of FEATURE_DEFS) {
        const raw = map.get(f.settingKey)
        // 缺键直接取 SETTING_DEFAULTS（与 getSettingBool 的回落值逐字一致）。
        // ⚠️ 不要在这里调 getSettingBool：那是**再查一次库**，而全表已在本函数开头读过了 ——
        //    新装实例（app_settings 空表）下会变成 36 次多余往返。
        out[f.id] = isOn(raw === undefined ? SETTING_DEFAULTS[f.settingKey] : raw)
      }
      return out
    } catch (err) {
      /**
       * 🔴 失败必须**放行**（2026-11-17 中立性要求）。
       *
       * 这条守卫跑在**每个请求**上。如果 D1 抖一下就让 getFeatureStates 抛出，
       * 结果不是「某个功能关了」，而是**全站 500** —— 等于给站点加了一个新的
       * 单点故障，而「全部开关打开时行为必须与改造前完全一致」正是本次的硬要求。
       * 与限流（ratelimit.ts）同一取舍：读不到配置时宁可放行。
       *
       * 缓存 10 秒：故障恢复后最多 10 秒即回到真实状态（管理员保存也会主动失效）。
       */
      console.error("读取功能开关失败（本次按全开处理）:", err)
      const all: FeatureStates = {}
      for (const f of FEATURE_DEFS) all[f.id] = true
      return all
    }
  })
}

/** 单个功能是否开启 */
export async function isFeatureEnabled(env: Env, id: string): Promise<boolean> {
  const states = await getFeatureStates(env)
  return states[id] !== false
}

/** 统一的 403：前端据此显示「功能已关闭」而不是「网络错误」 */
function disabledError(f: FeatureDef): ApiError {
  return new ApiError(403, "「" + f.label + "」当前已关闭", "FEATURE_DISABLED", {
    feature: f.id,
    featureLabel: f.label,
  })
}

/** 公开资源是否允许访问 */
export async function assertPublicPathEnabled(env: Env, key: PublicPathKey): Promise<void> {
  const f = featureForPublicPath(key)
  if (!f) return
  let on = true
  try {
    on = await isFeatureEnabled(env, f.id)
  } catch {
    // 读状态失败 → 放行（与 getFeatureStates 的 fail-open 同口径，双保险）
    on = true
  }
  if (!on) throw disabledError(f)
}

/**
 * 路由守卫：功能关了就抛 403（`index.ts` 的 route() 调用）。
 *
 * `method` 参与判断是为了放过「状态类只读接口」（见 FeatureDef.exempt）：
 * 前端要靠它们渲染「功能已关闭」，而不是只拿到一个 403。
 */
export async function assertRouteEnabled(
  env: Env,
  routePath: string,
  method: string
): Promise<void> {
  const f = featureForRoute(routePath)
  if (!f) return
  const m = method.toUpperCase()
  if (f.exempt?.some((e) => e.path === routePath && e.methods.includes(m))) return
  let on = true
  try {
    on = await isFeatureEnabled(env, f.id)
  } catch {
    // 读状态失败 → 放行（fail-open，见 getFeatureStates 的说明）
    on = true
  }
  if (!on) throw disabledError(f)
}

/** 管理端改完开关后清缓存，让同一 isolate 立刻生效 */
export function invalidateFeatureStates(): void {
  invalidateCache(CACHE_KEY)
}
