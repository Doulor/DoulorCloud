/**
 * 管理端 → D1 行读审计（2026-11-17）。
 *
 * 诊断接口：把 d1_audit_samples 里的样本按「路由」和「SQL 指纹」聚合，回答
 * 「日均 1.57 亿 D1 行读到底是谁吃的」。默认 24 小时窗口，最多 7 天（样本保留期）。
 *
 * 权限复用 `cfQuota`（读用量/额度的人本来就能看这个）。
 */
import { json } from "../http"
import { requireAdminScope } from "./admin"
import type { Env } from "../env"

interface RouteRow {
  route: string
  method: string
  samples: number
  queries: number
  rows_read: number
  rows_written: number
}
interface SqlRow {
  sql_tag: string
  sql: string
  samples: number
  slow_rows: number
}
interface TotalRow {
  samples: number
  queries: number
  rows_read: number
  rows_written: number
}

export async function getD1Audit(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "cfQuota")

  const url = new URL(request.url)
  const rawHours = Number(url.searchParams.get("hours") ?? "24")
  const hours = Number.isFinite(rawHours) ? Math.min(168, Math.max(1, Math.floor(rawHours))) : 24
  const since = new Date(Date.now() - hours * 3600_000).toISOString()

  const [totals, byRoute, bySql] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS samples, COALESCE(SUM(queries),0) AS queries,
              COALESCE(SUM(rows_read),0) AS rows_read,
              COALESCE(SUM(rows_written),0) AS rows_written
         FROM d1_audit_samples WHERE created_at >= ?`
    )
      .bind(since)
      .first<TotalRow>(),
    env.DB.prepare(
      `SELECT route, method, COUNT(*) AS samples,
              COALESCE(SUM(queries),0) AS queries,
              COALESCE(SUM(rows_read),0) AS rows_read,
              COALESCE(SUM(rows_written),0) AS rows_written
         FROM d1_audit_samples WHERE created_at >= ?
        GROUP BY route, method
        ORDER BY rows_read DESC
        LIMIT 30`
    )
      .bind(since)
      .all<RouteRow>(),
    env.DB.prepare(
      `SELECT sql_tag, MIN(slow_sql) AS sql, COUNT(*) AS samples,
              COALESCE(SUM(slow_rows),0) AS slow_rows
         FROM d1_audit_samples
        WHERE created_at >= ? AND sql_tag IS NOT NULL
        GROUP BY sql_tag
        ORDER BY slow_rows DESC
        LIMIT 30`
    )
      .bind(since)
      .all<SqlRow>(),
  ])

  return json({
    hours,
    since,
    totals: {
      samples: Number(totals?.samples ?? 0),
      queries: Number(totals?.queries ?? 0),
      rowsRead: Number(totals?.rows_read ?? 0),
      rowsWritten: Number(totals?.rows_written ?? 0),
    },
    byRoute: (byRoute.results ?? []).map((r) => ({
      route: String(r.route ?? ""),
      method: String(r.method ?? ""),
      samples: Number(r.samples ?? 0),
      queries: Number(r.queries ?? 0),
      rowsRead: Number(r.rows_read ?? 0),
      rowsWritten: Number(r.rows_written ?? 0),
    })),
    bySql: (bySql.results ?? []).map((r) => ({
      tag: String(r.sql_tag ?? ""),
      sql: String(r.sql ?? ""),
      samples: Number(r.samples ?? 0),
      slowRows: Number(r.slow_rows ?? 0),
    })),
  })
}
