/**
 * 网站访问统计：PV / UV / 页面路径 / 来源 / 时间趋势。
 *
 * 上报接口（匿名，无鉴权）：前端 sendBeacon 在路由切换时上报。
 * 查询接口（管理员）：按天聚合，返回给管理面板画图。
 *
 * 隐私考量：只记录「路径 + 来源 + 设备类别」，不存完整 User-Agent、
 * 不存 IP、不存具体身份。visitor_id 是前端随机生成的 UUID，仅用于
 * 区分「是否同一访客」，无法反查具体是谁。
 */
import { json, assertContentLengthWithin } from "../http"
import { requireAdmin } from "./admin"
import { uuid } from "../crypto"
import { hitRateLimit, clientIp } from "../ratelimit"
import type { Env } from "../env"

/**
 * 上报接口的 IP 级限流（2026-09-25 审计 H6 修复）。
 *
 * 原状况：`POST /api/analytics/track` 是**匿名、无限流、无去重**的裸写接口。
 * 一个脚本就能每秒写入任意多条（visitorId / path / referrer 全部自填），
 * 后果有两层：
 *   1. 撑爆 D1 存储与行读额度（analytics_events 无界增长，且它的
 *      purgeExpiredAnalytics 从未被调用）；
 *   2. 让管理员看到的 PV/UV/来源/路径排行全部失真 —— 运营数据不可信。
 *
 * 额度取 120 次 / 10 分钟：正常用户每次路由切换上报一次，10 分钟看 120 个
 * 页面已远超实际。同一个出口 IP 下的多个用户共用这个桶，所以不能压得更低。
 *
 * 为什么不在这里做「同访客同路径去重」：那需要为每个
 * (visitorId, path) 组合建一行 rate_limits 记录，键数量随访客数 × 路径数增长，
 * 等于把一个写入放大问题换成另一个。UV 本来就用 COUNT(DISTINCT visitor_id)
 * 统计，重复 PV 不会污染 UV。
 */
const ANALYTICS_IP_LIMIT = 120
const ANALYTICS_WINDOW_SECONDS = 600

/**
 * 上报请求体上限（2026-09-25 审计 L30）。
 *
 * 这是**匿名**接口，原先对 `request.json()` 完全没有体积限制 ——
 * 任何人都能发一个巨大的 JSON 让 Worker 先解析。正常上报只有
 * visitorId / path / referrer 三个短字段，4KB 已经绰绰有余。
 *
 * 放在 `try` 里：本接口的契约是「失败也静默返回 204」，
 * 所以超限时直接不读、被下面的 catch 吞掉即可，不改对外的可观测行为。
 */
const MAX_ANALYTICS_BODY_BYTES = 4 * 1024

/** 简化 UA：只提取浏览器/设备大类，不存完整 UA */
function classifyUa(ua: string): string {
  const u = ua.toLowerCase()
  if (u.includes("bot") || u.includes("spider") || u.includes("crawler")) return "bot"
  if (u.includes("mobile") || u.includes("android") || u.includes("iphone")) return "mobile"
  if (u.includes("tablet") || u.includes("ipad")) return "tablet"
  return "desktop"
}

/** 来源归一化：只存域名，或 direct */
function normalizeReferrer(ref: string): string {
  if (!ref) return "direct"
  try {
    const u = new URL(ref)
    return u.hostname
  } catch {
    return "direct"
  }
}

/** 归一化上报路径：只保留 pathname，去掉查询串/锚点与控制字符，限长 */
function normalizePath(raw: string): string {
  const withoutQuery = raw.split("?")[0].split("#")[0]
  // 去掉控制字符（含换行/制表），避免污染统计与导出
  const cleaned = withoutQuery.replace(/[\u0000-\u001f\u007f]/g, "")
  const limited = cleaned.slice(0, 200)
  return limited.startsWith("/") ? limited : `/${limited}`
}

/**
 * POST /api/analytics/track —— 上报一次页面浏览。
 * 匿名、静默：失败也返回 204，绝不影响前端页面。
 */
export async function track(env: Env, request: Request): Promise<Response> {
  try {
    // 先过限流：超限直接静默丢弃（仍返回 204，前端不需要知道）
    const gate = await hitRateLimit(
      env,
      `analytics:ip:${clientIp(request)}`,
      ANALYTICS_IP_LIMIT,
      ANALYTICS_WINDOW_SECONDS
    )
    if (!gate.ok) return new Response(null, { status: 204 })

    // 超大请求体直接不读（L30）；抛出的 ApiError 由下面的 catch 静默吞掉
    assertContentLengthWithin(request, MAX_ANALYTICS_BODY_BYTES, "请求内容过大")

    const body = (await request.json().catch(() => ({}))) as {
      visitorId?: string
      path?: string
      referrer?: string
    }
    const visitorId = (body.visitorId ?? "").slice(0, 64)
    const path = normalizePath(body.path ?? "")

    const referrer = normalizeReferrer(body.referrer ?? "")
    const ua = classifyUa(request.headers.get("User-Agent") ?? "")

    // 忽略明显的爬虫（搜索引擎 bot 等），否则会污染数据
    if (ua === "bot") return new Response(null, { status: 204 })
    if (!visitorId) return new Response(null, { status: 204 })

    await env.DB.prepare(
      "INSERT INTO analytics_events (id, visitor_id, path, referrer, ua, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(uuid(), visitorId, path, referrer, ua, new Date().toISOString())
      .run()
  } catch {
    // 上报失败绝不抛错，静默吞掉
  }
  return new Response(null, { status: 204 })
}

/**
 * GET /api/admin/analytics?days=7 —— 管理员查询统计。
 * 返回：
 *   - summary：总 PV、总 UV
 *   - byDay：按天的 [{date, pv, uv}]（趋势图）
 *   - byPath：按路径 [{path, pv, uv}]（页面热度，Top N）
 *   - byReferrer：按来源 [{referrer, pv}]（来源分析）
 */
export async function overview(env: Env, request: Request): Promise<Response> {
  await requireAdmin(env, request)
  const url = new URL(request.url)
  const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 7) || 7, 1), 90)
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  // 总 PV / UV
  const summary = await env.DB.prepare(
    "SELECT COUNT(*) AS pv, COUNT(DISTINCT visitor_id) AS uv FROM analytics_events WHERE created_at >= ?"
  )
    .bind(since)
    .first<{ pv: number; uv: number }>()

  // 按天（SQLite 的 date 函数按 UTC，这里用本地日期字符串前 10 位）
  const byDay = await env.DB.prepare(
    `SELECT substr(created_at, 1, 10) AS date, COUNT(*) AS pv, COUNT(DISTINCT visitor_id) AS uv
       FROM analytics_events WHERE created_at >= ?
      GROUP BY date ORDER BY date ASC`
  )
    .bind(since)
    .all<{ date: string; pv: number; uv: number }>()

  // 按路径 Top 20
  const byPath = await env.DB.prepare(
    `SELECT path, COUNT(*) AS pv, COUNT(DISTINCT visitor_id) AS uv
       FROM analytics_events WHERE created_at >= ?
      GROUP BY path ORDER BY pv DESC LIMIT 20`
  )
    .bind(since)
    .all<{ path: string; pv: number; uv: number }>()

  // 按来源 Top 10
  const byReferrer = await env.DB.prepare(
    `SELECT referrer, COUNT(*) AS pv
       FROM analytics_events WHERE created_at >= ?
      GROUP BY referrer ORDER BY pv DESC LIMIT 10`
  )
    .bind(since)
    .all<{ referrer: string; pv: number }>()

  return json({
    summary: { pv: summary?.pv ?? 0, uv: summary?.uv ?? 0 },
    byDay: byDay.results ?? [],
    byPath: byPath.results ?? [],
    byReferrer: byReferrer.results ?? [],
  })
}

/**
 * 模块中文标签（下发给前端，**不硬编码在前端**——与项目「标签由服务端下发」的约定一致）。
 * key 与前端 `types` 的 FeatureKey 同源，另加一个不消耗资源的 `profile`（个人名片）。
 */
const FEATURE_LABELS: Record<string, string> = {
  ai: "AI 中转站",
  r2: "直链网盘",
  frp: "内网穿透",
  proxy: "代理节点",
  profile: "个人名片",
}

/** 捐献类型标签 */
const DONATION_TYPE_LABELS: Record<string, string> = {
  ai: "AI 渠道",
  frp: "frp 服务端",
  proxy: "代理订阅",
  sensenova: "商汤 Key",
}

/** 捐献/工单状态标签 */
const DONATION_STATUS_LABELS: Record<string, string> = {
  pending: "待审核",
  approved: "已通过",
  rejected: "已拒绝",
}

/**
 * GET /api/admin/analytics/users?days=30 —— 用户数据分析（管理员）。
 *
 * 与上面的 `overview`（访问统计）互补：那边是「多少人看了什么页面」，
 * 这边是「注册的人都在用什么」—— 各功能模块的开通率、资料完整度、
 * 资源占用、捐献与社区活跃度。前端据此画图形化面板。
 *
 * 口径说明（改动前请读，改错会让管理员误判）：
 *   - **开通 = 真有开通记录**，不是「有权限」。权限（`users.permissions`）可能
 *     被管理员预授，但用户没实际开通；这里统计的是实际落库的那一侧：
 *     AI 看 `newapi_accounts` 有没有该用户、网盘看 `storage_accounts.enabled`、
 *     frp/proxy 看各自 activation 表的 `enabled`、名片看 `profiles.published`
 *     （2026-09-28 起开通即 published=1，所以这一项等于「开通名片的人数」）。
 *   - 百分比一律以**总用户数**为分母（含未开通的），这样「33% 开通了中转站」
 *     才是运营上关心的那个数。
 *   - 邮箱临时箱单列（`mailboxes.is_temp`），不混进「人均邮箱数」。
 */
export async function userOverview(env: Env, request: Request): Promise<Response> {
  await requireAdmin(env, request)
  const url = new URL(request.url)
  const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 30) || 30, 1), 90)
  const now = Date.now()
  /** 生成「N 天前」的 ISO 字符串，用于和 last_login_at 做字符串比较 */
  const isoAgo = (d: number) => new Date(now - d * 24 * 60 * 60 * 1000).toISOString()
  const since = isoAgo(days)
  const since1d = isoAgo(1)
  const since3d = isoAgo(3)
  const since7d = isoAgo(7)
  const since30d = isoAgo(30)

  // 十条查询互不依赖，一次 batch 省掉串行往返（远低于单请求 50 子请求上限）
  const [
    totalRes,
    roleRes,
    statusRes,
    profileRes,
    featureRes,
    resourceRes,
    donationRes,
    donationTypeRes,
    donationStatusRes,
    communityRes,
    newByDayRes,
    retentionRes,
    newUserRes,
  ] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS c FROM users"),
    env.DB.prepare("SELECT role, COUNT(*) AS c FROM users GROUP BY role"),
    env.DB.prepare("SELECT status, COUNT(*) AS c FROM users GROUP BY status"),
    // 资料完整度 / 邀请来源
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN email_verified = 1 THEN 1 ELSE 0 END) AS verified,
         SUM(CASE WHEN nickname IS NOT NULL AND nickname <> '' THEN 1 ELSE 0 END) AS nickname,
         SUM(CASE WHEN avatar_key IS NOT NULL THEN 1 ELSE 0 END) AS avatar,
         SUM(CASE WHEN invite_code_id IS NOT NULL THEN 1 ELSE 0 END) AS invited
       FROM users`
    ),
    // 各模块实际开通数
    env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM newapi_accounts) AS ai,
         (SELECT COUNT(*) FROM storage_accounts WHERE enabled = 1) AS r2,
         (SELECT COUNT(*) FROM frp_accounts WHERE enabled = 1) AS frp,
         (SELECT COUNT(*) FROM proxy_activation WHERE enabled = 1) AS proxy,
         (SELECT COUNT(*) FROM profiles WHERE published = 1) AS profile`
    ),
    // 资源占用
    env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM mailboxes WHERE is_temp = 0) AS mailboxes,
         (SELECT COUNT(*) FROM mailboxes WHERE is_temp = 1) AS tempMailboxes,
         (SELECT COUNT(*) FROM subdomains) AS subdomains,
         (SELECT COUNT(*) FROM dns_records) AS dnsRecords,
         (SELECT COUNT(*) FROM posts WHERE deleted_at IS NULL) AS posts,
         (SELECT COUNT(*) FROM post_comments WHERE deleted_at IS NULL) AS comments,
         (SELECT COUNT(*) FROM post_likes) AS likes,
         (SELECT COALESCE(SUM(used_bytes), 0) FROM storage_accounts) AS storageUsed,
         (SELECT COALESCE(SUM(quota_bytes), 0) FROM storage_accounts) AS storageQuota`
    ),
    // 捐献总览
    env.DB.prepare(
      `SELECT COUNT(*) AS total,
              COUNT(DISTINCT user_id) AS donors,
              SUM(CASE WHEN auto_reviewed = 1 THEN 1 ELSE 0 END) AS autoReviewed
       FROM donations`
    ),
    env.DB.prepare("SELECT type, COUNT(*) AS c FROM donations GROUP BY type"),
    env.DB.prepare("SELECT status, COUNT(*) AS c FROM donations GROUP BY status"),
    // 社区活跃度（去重到「人」，不是条目数）
    env.DB.prepare(
      `SELECT
         (SELECT COUNT(DISTINCT user_id) FROM posts WHERE deleted_at IS NULL) AS authors,
         (SELECT COUNT(DISTINCT user_id) FROM post_comments WHERE deleted_at IS NULL) AS commenters`
    ),
    // 新增用户趋势
    env.DB.prepare(
      `SELECT substr(created_at, 1, 10) AS date, COUNT(*) AS c
         FROM users WHERE created_at >= ?
        GROUP BY date ORDER BY date ASC`
    ).bind(since),
    // 存活率（按最后登录时间分桶 + 各窗口计数）
    //
    // ⚠️ 时间比较**必须用 JS 生成的 ISO 字符串**做参数绑定，不要写 SQLite 的
    // datetime('now','-7 days') —— 后者产出 "YYYY-MM-DD HH:MM:SS"（空格分隔），
    // 而 last_login_at 存的是 ISO（带 T 和 Z），两种格式做字符串比较会全错。
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN last_login_at IS NULL THEN 1 ELSE 0 END) AS neverLoggedIn,
         SUM(CASE WHEN last_login_at >= ? THEN 1 ELSE 0 END) AS alive1d,
         SUM(CASE WHEN last_login_at >= ? THEN 1 ELSE 0 END) AS alive7d,
         SUM(CASE WHEN last_login_at >= ? THEN 1 ELSE 0 END) AS alive30d,
         SUM(CASE WHEN last_login_at >= ? THEN 1 ELSE 0 END) AS bucket24h,
         SUM(CASE WHEN last_login_at < ? AND last_login_at >= ? THEN 1 ELSE 0 END) AS bucket3d,
         SUM(CASE WHEN last_login_at < ? AND last_login_at >= ? THEN 1 ELSE 0 END) AS bucket7d,
         SUM(CASE WHEN last_login_at < ? AND last_login_at >= ? THEN 1 ELSE 0 END) AS bucket30d,
         SUM(CASE WHEN last_login_at < ? THEN 1 ELSE 0 END) AS older
       FROM users`
    ).bind(
      since1d,
      since7d,
      since30d,
      since1d,
      since1d,
      since3d,
      since3d,
      since7d,
      since7d,
      since30d,
      since30d
    ),
    // 近期新用户里有多少真的登录过
    env.DB.prepare(
      `SELECT COUNT(*) AS registered,
              SUM(CASE WHEN last_login_at IS NOT NULL THEN 1 ELSE 0 END) AS loggedIn
         FROM users WHERE created_at >= ?`
    ).bind(since30d),
  ])

  const total = (totalRes as { results?: { c: number }[] }).results?.[0]?.c ?? 0
  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0)

  const byRole = ((roleRes as { results?: { role: string; c: number }[] }).results ?? []).map((r) => ({
    key: r.role,
    count: r.c,
    percent: pct(r.c),
  }))
  const byStatus = ((statusRes as { results?: { status: string; c: number }[] }).results ?? []).map((r) => ({
    key: r.status,
    count: r.c,
    percent: pct(r.c),
  }))

  const p = (profileRes as {
    results?: { verified: number; nickname: number; avatar: number; invited: number }[]
  }).results?.[0]
  const f = (featureRes as {
    results?: { ai: number; r2: number; frp: number; proxy: number; profile: number }[]
  }).results?.[0]
  const r = (resourceRes as {
    results?: {
      mailboxes: number
      tempMailboxes: number
      subdomains: number
      dnsRecords: number
      posts: number
      comments: number
      likes: number
      storageUsed: number
      storageQuota: number
    }[]
  }).results?.[0]
  const d = (
    donationRes as { results?: { total: number; donors: number; autoReviewed: number }[] }
  ).results?.[0]
  const c = (communityRes as { results?: { authors: number; commenters: number }[] }).results?.[0]
  const rt = (retentionRes as {
    results?: {
      neverLoggedIn: number
      alive1d: number
      alive7d: number
      alive30d: number
      bucket24h: number
      bucket3d: number
      bucket7d: number
      bucket30d: number
      older: number
    }[]
  }).results?.[0]
  const nu = (newUserRes as { results?: { registered: number; loggedIn: number }[] })
    .results?.[0]

  // 模块开通率：顺序固定（按开通数从高到低更好读），标签服务端下发
  const featureRows = [
    { key: "ai", count: f?.ai ?? 0 },
    { key: "r2", count: f?.r2 ?? 0 },
    { key: "frp", count: f?.frp ?? 0 },
    { key: "proxy", count: f?.proxy ?? 0 },
    { key: "profile", count: f?.profile ?? 0 },
  ]
    .sort((a, b) => b.count - a.count)
    .map((x) => ({
      key: x.key,
      label: FEATURE_LABELS[x.key] ?? x.key,
      count: x.count,
      percent: pct(x.count),
    }))

  return json({
    total,
    byRole,
    byStatus,
    newByDay: (newByDayRes as { results?: { date: string; c: number }[] }).results ?? [],
    verified: p?.verified ?? 0,
    verifiedPercent: pct(p?.verified ?? 0),
    nickname: p?.nickname ?? 0,
    avatar: p?.avatar ?? 0,
    invited: p?.invited ?? 0,
    invitedPercent: pct(p?.invited ?? 0),
    features: featureRows,
    resources: {
      mailboxes: r?.mailboxes ?? 0,
      tempMailboxes: r?.tempMailboxes ?? 0,
      subdomains: r?.subdomains ?? 0,
      dnsRecords: r?.dnsRecords ?? 0,
      posts: r?.posts ?? 0,
      comments: r?.comments ?? 0,
      likes: r?.likes ?? 0,
      storageUsedBytes: Number(r?.storageUsed ?? 0),
      storageQuotaBytes: Number(r?.storageQuota ?? 0),
      avgMailboxes: total > 0 ? Math.round(((r?.mailboxes ?? 0) / total) * 100) / 100 : 0,
    },
    donations: {
      total: d?.total ?? 0,
      donors: d?.donors ?? 0,
      donorsPercent: pct(d?.donors ?? 0),
      autoReviewed: d?.autoReviewed ?? 0,
      byType: (
        (donationTypeRes as { results?: { type: string; c: number }[] }).results ?? []
      ).map((x) => ({
        key: x.type,
        label: DONATION_TYPE_LABELS[x.type] ?? x.type,
        count: x.c,
      })),
      byStatus: (
        (donationStatusRes as { results?: { status: string; c: number }[] }).results ?? []
      ).map((x) => ({
        key: x.status,
        label: DONATION_STATUS_LABELS[x.status] ?? x.status,
        count: x.c,
      })),
    },
    community: {
      authors: c?.authors ?? 0,
      authorsPercent: pct(c?.authors ?? 0),
      commenters: c?.commenters ?? 0,
      commentersPercent: pct(c?.commenters ?? 0),
    },
    retention: {
      /** 「最近一周内登录过」= 存活，这是用户定义的口径 */
      alive7d: rt?.alive7d ?? 0,
      alive7dPercent: pct(rt?.alive7d ?? 0),
      alive1d: rt?.alive1d ?? 0,
      alive1dPercent: pct(rt?.alive1d ?? 0),
      alive30d: rt?.alive30d ?? 0,
      alive30dPercent: pct(rt?.alive30d ?? 0),
      neverLoggedIn: rt?.neverLoggedIn ?? 0,
      /** 最后登录时间的分布（分桶，percent 以总用户为分母） */
      buckets: [
        { label: "24 小时内", count: rt?.bucket24h ?? 0, percent: pct(rt?.bucket24h ?? 0) },
        { label: "1-3 天", count: rt?.bucket3d ?? 0, percent: pct(rt?.bucket3d ?? 0) },
        { label: "4-7 天", count: rt?.bucket7d ?? 0, percent: pct(rt?.bucket7d ?? 0) },
        { label: "7-30 天", count: rt?.bucket30d ?? 0, percent: pct(rt?.bucket30d ?? 0) },
        { label: "30 天以上", count: rt?.older ?? 0, percent: pct(rt?.older ?? 0) },
        { label: "从未登录", count: rt?.neverLoggedIn ?? 0, percent: pct(rt?.neverLoggedIn ?? 0) },
      ],
      /** 近 30 天注册的新用户里，有多少真的登录过 */
      newUsers: {
        registered: nu?.registered ?? 0,
        loggedIn: nu?.loggedIn ?? 0,
        percent:
          nu?.registered && nu.registered > 0
            ? Math.round(((nu.loggedIn ?? 0) / nu.registered) * 1000) / 10
            : 0,
      },
      /**
       * 数据可信度说明（前端原样展示）。
       * 迁移 0069 之前没有 last_login_at，历史值是用 sessions 回填的，
       * 而 sessions 会被定时运维清理（只留最近约一周）⇒ 更早的登录时间已无从追溯。
       * 表现为：现在 30 天存活数 ≈ 7 天存活数。随时间推移会自然变准。
       */
      caveat: "7 天内的数据准确；30 天档目前受历史数据限制（早期会话已被清理），会随时间累积变准。",
    },
  })
}

/**
 * 清理过期统计（供定时运维调用）。
 * 默认保留 90 天，更早的直接删掉，避免表无限增长。
 *
 * ⚠️ 2026-09-25 审计（H13）：这个函数**目前从未被调用** —— 全仓只有这一处
 * 定义，maintenance.ts 既没有 import 它，TABLE_WARN_ROWS 里也没有
 * analytics_events。也就是说这张「匿名每浏览写 1 行」的表实际上无界增长。
 * 补上调用点需要改 worker/src/maintenance.ts（当前被另一个 AI 占用中），
 * 见修复清单里的待办项。
 */
export async function purgeExpiredAnalytics(env: Env): Promise<number> {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
  const r = await env.DB.prepare("DELETE FROM analytics_events WHERE created_at < ?")
    .bind(cutoff)
    .run()
  return r.meta?.changes ?? 0
}
