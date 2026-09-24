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
import { json } from "../http"
import { requireAdmin } from "./admin"
import { uuid } from "../crypto"
import type { Env } from "../env"

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

/**
 * POST /api/analytics/track —— 上报一次页面浏览。
 * 匿名、幂等、静默：失败也返回 204，绝不影响前端页面。
 */
export async function track(env: Env, request: Request): Promise<Response> {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      visitorId?: string
      path?: string
      referrer?: string
    }
    const visitorId = (body.visitorId ?? "").slice(0, 64)
    // path 必须合法且不能太长；非法则丢弃
    let path = (body.path ?? "").slice(0, 200)
    if (!path.startsWith("/")) path = "/" + path

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
 * 清理过期统计（供定时运维调用）。
 * 默认保留 90 天，更早的直接删掉，避免表无限增长。
 */
export async function purgeExpiredAnalytics(env: Env): Promise<number> {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
  const r = await env.DB.prepare("DELETE FROM analytics_events WHERE created_at < ?")
    .bind(cutoff)
    .run()
  return r.meta?.changes ?? 0
}
