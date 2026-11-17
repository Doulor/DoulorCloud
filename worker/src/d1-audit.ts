/**
 * D1 行读审计（2026-11-17，临时诊断工具）。
 *
 * 背景：线上日均 D1 行读 1.57 亿（免费额度 500 万/天），但**不知道是哪些查询吃的** ——
 * Cloudflare 的 GraphQL 只给到「按库/按天」的行读总量，没有 query 级维度。
 * 本模块在 Worker 内部按请求采样，把「路由 + 查询数 + 行读/行写 + 最贵那条 SQL」
 * 落一张小表（`d1_audit_samples`），用于定位额度消耗的大头。
 *
 * 三条硬约束（这是诊断工具，绝不能影响线上）：
 *   1. **默认关闭**：功能开关 `d1_audit_enabled` = 0（见 features.ts 的 d1Audit），
 *      开启前这段代码只是两个判断，不做任何包装、不写任何数据。
 *   2. **采样**：`d1_audit_sample_percent` 默认 1（1%）。按请求采样，不是按查询 ——
 *      每条样本聚合该请求内所有 D1 调用的行读写，写入量 ≈ 请求数 × 1%。
 *   3. **失败静默**：任何测量/写入异常都吞掉（只 console.warn），
 *      不能因为诊断工具把业务请求带崩。
 *
 * ⚠️ 已知盲区（别把它当成完整账本）：
 *   · `.first()` 拿不到 `meta`（D1 的 first 只返回行数据），所以这类查询**只计条数、不计行读**；
 *     用 `.all()` / `.run()` / `.batch()` 的查询才有行读数据。
 *   · cron（scheduled）里的查询**不在采样范围**（它不走 fetch 的 flush 生命周期）。
 *   · 1% 采样是统计意义，单日样本量约 1,400 条，足够看「谁是大头」，不足以做精确账单。
 */
import { uuid } from "./crypto"
import { cached, invalidateCache } from "./short-cache"
import { getSettingNumber } from "./settings"
import { isFeatureEnabled } from "./features"
import type { Env } from "./env"

/** 一次请求内的 D1 调用聚合 */
export interface AuditCollector {
  route: string
  method: string
  /** D1 调用次数（含 .first()） */
  queries: number
  rowsRead: number
  rowsWritten: number
  /** 该请求里行读最多的那条 SQL（已规范化、截断） */
  slowSql: string
  slowRows: number
}

export function createCollector(route: string, method: string): AuditCollector {
  return { route: route.slice(0, 200), method: method.slice(0, 12), queries: 0, rowsRead: 0, rowsWritten: 0, slowSql: "", slowRows: 0 }
}

/** SQL 规范化：压空白、去首尾、截断（只用于展示与分组，不参与执行） */
export function normalizeSqlForAudit(sql: string): string {
  const s = String(sql ?? "").replace(/\s+/g, " ").trim()
  return s.length > 300 ? s.slice(0, 300) : s
}

/**
 * SQL 指纹（FNV-1a 32bit，十六进制）。
 *
 * 为什么不用 SHA：这是热路径上的诊断代码，FNV 足够区分「同一类 SQL」，
 * 且同步、无 WebCrypto 开销。字面量差异（参数在 SQL 里内联的场景）会让指纹不同 ——
 * 站点绝大多数查询都用 `?` 占位符，影响可忽略。
 */
export function sqlTagOf(sql: string): string {
  const s = normalizeSqlForAudit(sql)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

function recordMeta(c: AuditCollector, meta: unknown, sql: string): void {
  const m = (meta ?? {}) as { rows_read?: number; rows_written?: number }
  const r = Number(m.rows_read ?? 0) || 0
  const w = Number(m.rows_written ?? 0) || 0
  c.queries += 1
  c.rowsRead += r
  c.rowsWritten += w
  if (r > c.slowRows) {
    c.slowRows = r
    c.slowSql = normalizeSqlForAudit(sql)
  }
}

/**
 * 给 D1 绑定套一层测量代理。
 *
 * 只测 `.all()` / `.run()` / `.raw()` / `.batch()`（它们返回带 meta 的结果）；
 * `.first()` 没有 meta，只计一次调用（见文件头的盲区说明）。
 */
export function wrapD1(db: D1Database, c: AuditCollector | null): D1Database {
  if (!c) return db

  const wrapStmt = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(stmt, {
      get(target, prop, receiver) {
        if (prop === "bind") {
          return (...args: unknown[]) =>
            wrapStmt((target.bind as (...a: unknown[]) => D1PreparedStatement)(...args), sql)
        }
        if (prop === "first") {
          return async (...args: unknown[]) => {
            c.queries += 1
            return (target.first as (...a: unknown[]) => Promise<unknown>)(...args)
          }
        }
        if (prop === "all" || prop === "run" || prop === "raw") {
          return async (...args: unknown[]) => {
            const res = await (target[prop] as (...a: unknown[]) => Promise<unknown>)(...args)
            if (prop !== "raw") recordMeta(c, (res as { meta?: unknown })?.meta, sql)
            else c.queries += 1
            return res
          }
        }
        const v = Reflect.get(target, prop, receiver)
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v
      },
    })

  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (sql: string) => wrapStmt(target.prepare(sql), String(sql))
      }
      if (prop === "batch") {
        return async (stmts: D1PreparedStatement[]) => {
          const res = await target.batch(stmts)
          for (const r of (res ?? []) as { meta?: unknown }[]) recordMeta(c, r?.meta, "batch")
          return res
        }
      }
      if (prop === "exec") {
        return async (sql: string) => {
          const res = await target.exec(sql)
          recordMeta(c, (res as { meta?: unknown })?.meta, String(sql))
          return res
        }
      }
      const v = Reflect.get(target, prop, receiver)
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v
    },
  }) as D1Database
}

/** 给 env 换成「带测量的 DB」，其它字段原样透传（与 withD1ReadReplication 同一写法） */
export function withAuditDb(env: Env, collector: AuditCollector | null): Env {
  if (!collector) return env
  return new Proxy(env, {
    get: (target, prop) =>
      prop === "DB" ? wrapD1((target as Env).DB, collector) : (target as unknown as Record<string | symbol, unknown>)[prop],
  }) as Env
}

const RATE_CACHE_KEY = "d1-audit-rate"
const RATE_CACHE_MS = 10_000

/** 测试/管理端改完采样率后清缓存（与功能开关同一套理由：别让人等 10 秒） */
export function invalidateD1AuditCache(): void {
  invalidateCache(RATE_CACHE_KEY)
}

/**
 * 是否处于采样状态，以及本次请求是否命中采样。
 *
 * 关闭时（默认）：一次缓存命中 + 一个布尔判断，不查库、不包装、不写数据。
 */
export async function d1AuditActive(env: Env): Promise<{ on: boolean; sample: boolean }> {
  let on = false
  try {
    on = await isFeatureEnabled(env, "d1Audit")
  } catch {
    on = false
  }
  if (!on) return { on: false, sample: false }
  try {
    const pct = await cached<number>(RATE_CACHE_KEY, RATE_CACHE_MS, () =>
      getSettingNumber(env, "d1_audit_sample_percent")
    )
    const rate = Math.min(100, Math.max(0, Number(pct) || 0))
    if (rate <= 0) return { on: true, sample: false }
    return { on: true, sample: Math.random() * 100 < rate }
  } catch {
    return { on: true, sample: false }
  }
}

/** 落一条样本；任何失败都静默（诊断工具不能影响业务） */
export async function recordD1AuditSample(db: D1Database, c: AuditCollector): Promise<void> {
  if (c.queries === 0 && c.rowsRead === 0 && c.rowsWritten === 0) return
  try {
    await db
      .prepare(
        `INSERT INTO d1_audit_samples
           (id, route, method, queries, rows_read, rows_written, slow_sql, slow_rows, sql_tag, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        uuid(),
        c.route,
        c.method,
        c.queries,
        c.rowsRead,
        c.rowsWritten,
        c.slowSql || null,
        c.slowRows,
        c.slowSql ? sqlTagOf(c.slowSql) : null,
        new Date().toISOString()
      )
      .run()
  } catch (err) {
    console.warn("D1 审计样本写入失败（已忽略）:", err instanceof Error ? err.message : err)
  }
}
