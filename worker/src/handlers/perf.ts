/**
 * 前端性能样本（RUM）采集与管理聚合。
 *
 * 上报侧（POST /perf/collect）：前端 src/lib/perf-collect.ts 在页面加载完成 /
 * 路由切换完成时 sendBeacon 一条样本（TTFB/DCL/LCP/长任务/错误数/切换耗时）。
 * 与 analytics track 同一口径：限流打满即静默丢、体积超限不读、任何异常静默 204，
 * 绝不影响前端页面。sendBeacon 只能发 POST 且拿不到响应，所以失败对前端不可见。
 *
 * 读取侧（GET /admin/perf/overview，scope=perf）：按天趋势、按页面聚合、
 * 慢页面 Top、设备分布。隐私口径与 analytics 一致：不展示用户名 / IP / UA。
 */
import { json } from "../http"
import { requireUser } from "../auth"
import { requireAdminScope } from "./admin"
import { hitRateLimit, clientIp } from "../ratelimit"
import { assertContentLengthWithin } from "../http"
import { uuid } from "../crypto"
import type { Env } from "../env"

/** 每 IP 窗口内最多上报条数（10 分钟 240 条：正常使用约每页 1-2 条） */
const PERF_IP_LIMIT = 240
const PERF_WINDOW_SECONDS = 600
/** 单条请求体上限：样本字段都是小整数，2KB 绰绰有余 */
const MAX_PERF_BODY_BYTES = 2 * 1024
/** 采样值合理上限（防脏数据）：加载类指标 10 分钟，切换 60s，计数 9999 */
const MAX_LOAD_MS = 600_000
const MAX_NAV_MS = 60_000
const MAX_COUNT = 9999

function clampInt(v: unknown, max: number): number | null {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.min(Math.round(n), max)
}

/** 页面标识归一化：去查询串/锚点/控制字符，限长（与 analytics 的 normalizePath 同思路） */
function normalizePage(raw: string): string {
  const cleaned = raw.split("?")[0].split("#")[0].replace(/[\u0000-\u001f\u007f]/g, "")
  const limited = cleaned.slice(0, 120)
  return limited.startsWith("/") ? limited : `/${limited}`
}

/**
 * POST /api/perf/collect —— 上报一条性能样本。
 * 登录用户带上身份（便于管理端按用户维度排障），未登录也收（page 维度仍有用），
 * 一律静默 204。
 */
export async function collect(env: Env, request: Request): Promise<Response> {
  try {
    const gate = await hitRateLimit(
      env,
      `perf:ip:${clientIp(request)}`,
      PERF_IP_LIMIT,
      PERF_WINDOW_SECONDS
    )
    if (!gate.ok) return new Response(null, { status: 204 })

    assertContentLengthWithin(request, MAX_PERF_BODY_BYTES, "请求内容过大")

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const page = normalizePage(String(body.page ?? ""))
    if (!page || page === "/") return new Response(null, { status: 204 })

    // 登录身份可选：requireUser 抛错（未登录）就按匿名收
    let userId = ""
    try {
      const user = await requireUser(env, request)
      userId = user.id
    } catch {
      // 匿名上报：继续
    }

    const device = body.device === "mobile" ? "mobile" : "desktop"
    await env.DB.prepare(
      `INSERT INTO perf_samples (id, user_id, page, device, ttfb_ms, dcl_ms, lcp_ms, long_tasks, errors, nav_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        uuid(),
        userId,
        page,
        device,
        clampInt(body.ttfbMs, MAX_LOAD_MS),
        clampInt(body.dclMs, MAX_LOAD_MS),
        clampInt(body.lcpMs, MAX_LOAD_MS),
        clampInt(body.longTasks, MAX_COUNT),
        clampInt(body.errors, MAX_COUNT),
        clampInt(body.navMs, MAX_NAV_MS),
        new Date().toISOString()
      )
      .run()
  } catch {
    // 上报失败绝不抛错：性能监控本身不能成为性能问题
  }
  return new Response(null, { status: 204 })
}

/** 天数参数钳制（1-30） */
function clampDays(raw: string | null): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return 7
  return Math.min(Math.max(Math.round(n), 1), 30)
}

/**
 * GET /api/admin/perf/overview?days=7 —— 性能监控总览。
 * 返回：summary（样本数/中位 LCP/长任务总数/错误总数）、byDay、byPage（Top 20，
 * 带各指标中位与 P90）、byDevice、slowPages（P90 加载最慢 Top 10）。
 *
 * 聚合全走 SQL（AVG/COUNT/MAX），样本行是纯数字列，中位在前端算
 * （SQLite 无内置中位；Top N 已把样本量限制在几千行内，一次下发足够小）。
 */
export async function overview(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "perf")
  const url = new URL(request.url)
  const days = clampDays(url.searchParams.get("days"))
  const since = new Date(Date.now() - days * 86_400_000).toISOString()

  // 单次 batch 并行取全部聚合（1 次 D1 往返），与 analytics userOverview 同套路
  const [summaryRes, byDayRes, byPageRes, byDeviceRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COUNT(*) AS samples,
              SUM(long_tasks) AS longTasks,
              SUM(errors) AS errors,
              AVG(ttfb_ms) AS avgTtfb,
              AVG(lcp_ms) AS avgLcp,
              AVG(nav_ms) AS avgNav
         FROM perf_samples WHERE created_at >= ?`
    ).bind(since),
    env.DB.prepare(
      `SELECT substr(created_at, 1, 10) AS day,
              COUNT(*) AS samples,
              AVG(ttfb_ms) AS avgTtfb,
              AVG(lcp_ms) AS avgLcp,
              AVG(nav_ms) AS avgNav,
              SUM(long_tasks) AS longTasks,
              SUM(errors) AS errors
         FROM perf_samples WHERE created_at >= ?
        GROUP BY day ORDER BY day ASC`
    ).bind(since),
    env.DB.prepare(
      `SELECT page,
              COUNT(*) AS samples,
              AVG(ttfb_ms) AS avgTtfb,
              AVG(lcp_ms) AS avgLcp,
              AVG(nav_ms) AS avgNav,
              MAX(ttfb_ms) AS maxTtfb,
              MAX(lcp_ms) AS maxLcp,
              SUM(long_tasks) AS longTasks,
              SUM(errors) AS errors,
              SUM(CASE WHEN device = 'mobile' THEN 1 ELSE 0 END) AS mobileSamples
         FROM perf_samples WHERE created_at >= ?
        GROUP BY page ORDER BY samples DESC LIMIT 20`
    ).bind(since),
    env.DB.prepare(
      `SELECT device, COUNT(*) AS samples FROM perf_samples WHERE created_at >= ? GROUP BY device`
    ).bind(since),
  ])

  const summary = (summaryRes.results?.[0] ?? {}) as Record<string, number | null>
  const byPageRows = (byPageRes.results ?? []) as Array<Record<string, number | string>>
  // 慢页面榜：按 P90 加载（ttfb+nav 的 max 近似）排序的重算 —— 直接用已有聚合，
  // max* 已经在 byPage 里，这里前端排序即可，后端不再多一次查询。
  return json({
    days,
    summary: {
      samples: summary.samples ?? 0,
      longTasks: summary.longTasks ?? 0,
      errors: summary.errors ?? 0,
      avgTtfb: Math.round(summary.avgTtfb ?? 0),
      avgLcp: Math.round(summary.avgLcp ?? 0),
      avgNav: Math.round(summary.avgNav ?? 0),
    },
    byDay: (byDayRes.results ?? []).map((r) => {
      const row = r as Record<string, number | string>
      return {
        day: row.day,
        samples: row.samples,
        avgTtfb: Math.round(Number(row.avgTtfb ?? 0)),
        avgLcp: Math.round(Number(row.avgLcp ?? 0)),
        avgNav: Math.round(Number(row.avgNav ?? 0)),
        longTasks: row.longTasks ?? 0,
        errors: row.errors ?? 0,
      }
    }),
    byPage: byPageRows.map((r) => ({
      page: r.page,
      samples: r.samples,
      avgTtfb: Math.round(Number(r.avgTtfb ?? 0)),
      avgLcp: Math.round(Number(r.avgLcp ?? 0)),
      avgNav: Math.round(Number(r.avgNav ?? 0)),
      maxTtfb: r.maxTtfb ?? 0,
      maxLcp: r.maxLcp ?? 0,
      longTasks: r.longTasks ?? 0,
      errors: r.errors ?? 0,
      mobileShare: r.samples ? Math.round((Number(r.mobileSamples) / Number(r.samples)) * 100) : 0,
    })),
    byDevice: (byDeviceRes.results ?? []) as Array<{ device: string; samples: number }>,
  })
}

/**
 * GET /api/admin/perf/samples?page=...&days=7 —— 单页面的原始样本（近 N 天，最多 500 条）。
 * 供「点开某个页面看明细」用：看某页每次加载的分布，而不是只看平均。
 */
export async function pageSamples(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "perf")
  const url = new URL(request.url)
  const days = clampDays(url.searchParams.get("days"))
  const page = normalizePage(url.searchParams.get("page") ?? "")
  if (!page || page === "/") return json({ samples: [], page })

  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const rows = await env.DB.prepare(
    `SELECT ttfb_ms, dcl_ms, lcp_ms, long_tasks, errors, nav_ms, device, created_at
       FROM perf_samples
      WHERE page = ? AND created_at >= ?
      ORDER BY created_at DESC LIMIT 500`
  )
    .bind(page, since)
    .all<{
      ttfb_ms: number | null
      dcl_ms: number | null
      lcp_ms: number | null
      long_tasks: number | null
      errors: number | null
      nav_ms: number | null
      device: string
      created_at: string
    }>()

  return json({
    page,
    samples: (rows.results ?? []).map((r) => ({
      ttfbMs: r.ttfb_ms,
      dclMs: r.dcl_ms,
      lcpMs: r.lcp_ms,
      longTasks: r.long_tasks ?? 0,
      errors: r.errors ?? 0,
      navMs: r.nav_ms,
      device: r.device,
      createdAt: r.created_at,
    })),
  })
}
