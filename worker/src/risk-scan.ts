/**
 * 风险账户扫描：从中转站日志里找出「单分钟请求数异常高」的账号，写入 risk_accounts。
 *
 * 为什么是「定时拉日志」而不是「实时拦截」：用户的请求是**直接打到 NewAPI** 的
 * （不是经过本站 Worker 转发），本站根本没有中间点可以插。所以只能事后从
 * NewAPI 的日志里反推并发形态。
 *
 * 判定：把最近 10 分钟的日志按「用户 × 分钟」计数，任一分钟超过阈值
 * （`risk_peak_per_minute_threshold`，默认 20）就记一笔。正常聊天不可能
 * 一分钟发 20 次以上请求，超了基本就是脚本、批量任务，或者把 Key 分给了别人。
 *
 * 幂等：同一账号反复命中只更新峰值与时间（score 取历史最大值），不重复插入。
 * 已处理状态（watching/banned/cleared）**不会被覆盖** —— 管理员标过就不该被扫回 open。
 */
import { listLogs, isNewApiConfigured } from "./newapi-client"
import { getSetting } from "./settings"
import type { Env } from "./env"

/** 单次最多翻多少页（page_size = 100）—— 3000 条，够覆盖 300 请求/分钟 的流量 */
const MAX_PAGES = 30
/** 扫描窗口：最近 10 分钟（cron 每 10 分钟跑一次，正好首尾相接） */
const WINDOW_SECONDS = 600

export interface RiskScanResult {
  /** 本次扫到的日志条数 */
  scanned: number
  /** 命中并写入/更新的账号数 */
  flagged: number
  errors: number
}

export async function scanRiskAccounts(env: Env): Promise<RiskScanResult> {
  const result: RiskScanResult = { scanned: 0, flagged: 0, errors: 0 }
  if (!(await isNewApiConfigured(env))) return result

  const threshold = Number(await getSetting(env, "risk_peak_per_minute_threshold")) || 20
  const nowSec = Math.floor(Date.now() / 1000)
  const startSec = nowSec - WINDOW_SECONDS

  /** newapi user_id → (分钟起点 → 该分钟请求数) */
  const perUser = new Map<number, Map<number, number>>()
  let total = Number.POSITIVE_INFINITY

  for (let page = 0; page < MAX_PAGES; page++) {
    let items
    try {
      const res = await listLogs(env, { startTimestamp: startSec, endTimestamp: nowSec, page })
      items = res.items ?? []
      total = res.total
    } catch (err) {
      console.error("风险扫描：拉取日志失败", err)
      result.errors++
      break
    }
    if (items.length === 0) break

    for (const it of items) {
      if (typeof it.user_id !== "number" || typeof it.created_at !== "number") continue
      const minute = Math.floor(it.created_at / 60) * 60
      let m = perUser.get(it.user_id)
      if (!m) {
        m = new Map()
        perUser.set(it.user_id, m)
      }
      m.set(minute, (m.get(minute) ?? 0) + 1)
    }

    result.scanned += items.length
    if (result.scanned >= total) break
  }

  const nowIso = new Date().toISOString()
  for (const [newapiUserId, minutes] of perUser) {
    let peak = 0
    for (const c of minutes.values()) if (c > peak) peak = c
    if (peak <= threshold) continue

    // 只有「本站开通的」才管得着（也可能是别人直接建在 NewAPI 上的账号）
    const acct = await env.DB.prepare(
      "SELECT user_id, username FROM newapi_accounts WHERE newapi_user_id = ?"
    )
      .bind(newapiUserId)
      .first<{ user_id: string; username: string }>()
    if (!acct) continue

    const level = peak >= threshold * 5 ? "high" : peak >= threshold * 2 ? "medium" : "low"
    const score = Math.min(100, Math.round((peak / threshold) * 20))
    const reasons = JSON.stringify([
      `单分钟最高 ${peak} 次请求（阈值 ${threshold} 次/分钟）`,
      `观测窗口：最近 ${WINDOW_SECONDS / 60} 分钟`,
    ])

    await env.DB.prepare(
      `INSERT INTO risk_accounts
         (user_id, username, risk_level, score, reasons, peak_per_min, requests_7d,
          first_seen_at, last_seen_at, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'open', ?)
       ON CONFLICT(user_id) DO UPDATE SET
         username      = excluded.username,
         risk_level    = excluded.risk_level,
         score         = MAX(risk_accounts.score, excluded.score),
         reasons       = excluded.reasons,
         peak_per_min  = MAX(risk_accounts.peak_per_min, excluded.peak_per_min),
         last_seen_at  = excluded.last_seen_at,
         updated_at    = excluded.updated_at`
    )
      .bind(
        acct.user_id,
        acct.username,
        level,
        score,
        reasons,
        peak,
        nowIso,
        nowIso,
        nowIso
      )
      .run()
    result.flagged++
  }

  return result
}
