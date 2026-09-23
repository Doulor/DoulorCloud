/**
 * 定时运维任务（Cloudflare Cron Triggers 调用，见 wrangler.toml 的 [triggers]）。
 *
 * 为什么需要（2026-09-23 审计）：
 *   平台有一批"只增不减"的数据和一批"到期但没人访问就不清理"的资源，
 *   此前全靠站长手工介入。典型三个：
 *     1. 临时分享箱采用**惰性清理** —— 只有人再次访问那个接收码时才删 R2 对象，
 *        没人访问就永远躺在桶里占空间；
 *     2. `sessions` / `audit_logs` / `rate_limits` 只写不删；
 *     3. 网盘记账（`storage_accounts` 的 used_bytes / file_count）与实际
 *        记录数会因上传中断、预签名直传不 commit 等原因漂移，而且**没人会发现**。
 *
 * 设计原则：**能自动做的只做无争议的删除；有争议的一律只报告**。
 *   - 过期分享箱：语义就是"到期即失效"，删除是预期行为 → 直接删；
 *   - 过期会话 / 老审计日志 / 过期限流窗口：纯垃圾 → 直接删；
 *   - 网盘记账漂移 / 孤儿对象：**只报告不删**（删用户文件必须人工确认，
 *     且有专门的 /api/admin/storage/recalculate 可修）。
 *
 * ⚠️ 关于 R2：本模块**刻意不调用 listObjects 做全桶枚举**。
 *   R2 正在从"单桶 S3 + env 凭证"重构为"多桶 + D1 桶表"（见 HANDOFF §21），
 *   此刻按旧签名枚举会扫到错误的桶，产生假的"孤儿"结论。
 *   真正的 R2 孤儿对账需要按桶枚举，属 R2 方向的待办（见
 *   docs/待办-交给R2方向的安全补丁.md）。这里只做 D1 侧的记账自检。
 */
import type { Env } from "./env"
import { deletePrefix } from "./r2"
import { sendMail, renderMail, isMailerConfigured } from "./mailer"
import { uuid } from "./crypto"

/** 过期会话保留期（天）：留一点用于排查"刚掉线"的投诉 */
const SESSION_RETENTION_DAYS = 7
/** 审计日志保留期（天） */
const AUDIT_RETENTION_DAYS = 90
/** 限流窗口记录保留期（天）：窗口早于此时刻的行不会再被命中 */
const RATE_LIMIT_RETENTION_DAYS = 1
/** 单次清理的分享箱上限，避免一次跑太久撞 CPU/子请求限额 */
const TEMPBOX_PURGE_BATCH = 200
/** 保留最近多少次运行记录（供对比增长速度与排查 cron 是否还在跑） */
const MAINTAIN_RUN_KEEP = 100

/** 单个表的告警阈值（行数）。D1 免费额度按**行读**计费，大表是最贵的地方。 */
const TABLE_WARN_ROWS: Record<string, number> = {
  messages: 100_000,
  audit_logs: 100_000,
  notifications: 200_000,
  posts: 50_000,
  post_likes: 200_000,
  storage_objects: 100_000,
  sessions: 50_000,
  rate_limits: 50_000,
}

export interface MaintenanceReport {
  ranAt: string
  dryRun: boolean
  deep: boolean
  /** 已过期分享箱：清理的批次数 / 连带删除的 R2 对象数 */
  tempbox: { batches: number; objects: number; errors: string[] }
  sessionsDeleted: number
  auditLogsDeleted: number
  rateLimitsDeleted: number
  /** 网盘记账与实际记录数不一致的用户（只报告，不自动修） */
  storageMismatches: { prefix: string; fileCount: number; actual: number; usedBytes: number }[]
  tableRows: Record<string, number>
  warnings: string[]
  errors: string[]
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

/** 统计若干大表的行数（用于成本预警；只做头部表的 COUNT，不扫全库） */
async function collectTableRows(env: Env): Promise<Record<string, number>> {
  const tables = Object.keys(TABLE_WARN_ROWS)
  const out: Record<string, number> = {}
  for (const table of tables) {
    try {
      // 表名来自本文件内的常量白名单，不含用户输入，不存在注入面
      const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first<{ c: number }>()
      out[table] = row?.c ?? 0
    } catch (err) {
      // 表可能尚未迁移（例如新装的实例），跳过而不是整体失败
      console.error(`统计 ${table} 行数失败:`, err)
    }
  }
  return out
}

/**
 * 清理已过期的临时分享箱（D1 记录 + R2 对象）。
 * 到期即失效是产品语义，因此这里直接删除；R2 删除失败不阻断（下次继续）。
 */
async function purgeExpiredTempbox(
  env: Env,
  dryRun: boolean,
  errors: string[]
): Promise<{ batches: number; objects: number }> {
  const rows = await env.DB.prepare(
    "SELECT code FROM tempbox_batches WHERE expire_at < ? ORDER BY expire_at ASC LIMIT ?"
  )
    .bind(new Date().toISOString(), TEMPBOX_PURGE_BATCH)
    .all<{ code: string }>()

  const codes = (rows.results ?? []).map((r) => r.code)
  if (codes.length === 0) return { batches: 0, objects: 0 }
  if (dryRun) return { batches: codes.length, objects: 0 }

  let objects = 0
  for (const code of codes) {
    try {
      objects += await deletePrefix(env, `temporary/${code}/`)
    } catch (err) {
      errors.push(`分享箱 ${code} 的对象清理失败: ${err instanceof Error ? err.message : String(err)}`)
    }
    await env.DB.prepare("DELETE FROM tempbox_batches WHERE code = ? COLLATE NOCASE")
      .bind(code)
      .run()
  }
  return { batches: codes.length, objects }
}

/** 网盘记账自检：file_count / used_bytes 是否与 D1 明细对得上（只报告） */
async function findStorageMismatches(env: Env) {
  try {
    const rows = await env.DB.prepare(
      `SELECT a.prefix, a.file_count, a.used_bytes,
              (SELECT COUNT(*) FROM storage_objects o WHERE o.user_id = a.user_id) AS actual,
              (SELECT COALESCE(SUM(o.size), 0) FROM storage_objects o WHERE o.user_id = a.user_id) AS actual_bytes
         FROM storage_accounts a`
    ).all<{
      prefix: string
      file_count: number
      used_bytes: number
      actual: number
      actual_bytes: number
    }>()

    return (rows.results ?? [])
      .filter((r) => r.file_count !== r.actual || r.used_bytes !== r.actual_bytes)
      .map((r) => ({
        prefix: r.prefix,
        fileCount: r.file_count,
        actual: r.actual,
        usedBytes: r.used_bytes,
      }))
  } catch (err) {
    console.error("网盘记账自检失败:", err)
    return []
  }
}

/** 把本次运行写入 maintenance_runs（供对比增长、确认 cron 还活着） */
async function recordRun(
  env: Env,
  report: MaintenanceReport
): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO maintenance_runs (id, ran_at, deep, stats, warnings) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(
        uuid(),
        report.ranAt,
        report.deep ? 1 : 0,
        JSON.stringify({
          tempbox: report.tempbox.batches,
          sessions: report.sessionsDeleted,
          audit: report.auditLogsDeleted,
          rateLimits: report.rateLimitsDeleted,
          storageMismatches: report.storageMismatches.length,
          tableRows: report.tableRows,
        }),
        report.warnings.length > 0 ? JSON.stringify(report.warnings) : null
      )
      .run()

    // 只保留最近 N 条，避免这张表自己变成"只增不减"的数据
    await env.DB.prepare(
      `DELETE FROM maintenance_runs WHERE id NOT IN (
         SELECT id FROM maintenance_runs ORDER BY ran_at DESC LIMIT ?
       )`
    )
      .bind(MAINTAIN_RUN_KEEP)
      .run()
  } catch (err) {
    // 表未迁移时不阻断主流程（与 settings.audit 的容错风格一致）
    console.error("写入运维运行记录失败:", err)
  }
}

/** 有告警时通知管理员（发给所有已验证邮箱的管理员；失败静默） */
async function notifyAdmins(env: Env, report: MaintenanceReport): Promise<void> {
  if (report.warnings.length === 0) return
  if (!isMailerConfigured(env)) return

  try {
    const admins = await env.DB.prepare(
      "SELECT email FROM users WHERE role = 'admin' AND email_verified = 1"
    ).all<{ email: string }>()

    const { text, html } = renderMail("【Doulor Cloud】运维自检告警", [
      `运行时间：${report.ranAt}`,
      "",
      ...report.warnings.map((w) => `· ${w}`),
      "",
      "以上为定时运维自检结果，详情见 D1 的 maintenance_runs 表。",
    ])

    for (const admin of admins.results ?? []) {
      try {
        await sendMail(env, {
          to: admin.email,
          subject: "【Doulor Cloud】运维自检告警",
          text,
          html,
        })
      } catch (err) {
        // Onboard 之前只能发给已验证的 destination；失败不影响任务本身
        console.error("运维告警邮件发送失败:", admin.email, err)
      }
    }
  } catch (err) {
    console.error("运维告警通知失败:", err)
  }
}

/**
 * 执行一次运维。
 * @param opts.deep 深度模式（每日一次）：额外清理老审计日志
 */
export async function runMaintenance(
  env: Env,
  opts: { dryRun?: boolean; deep?: boolean } = {}
): Promise<MaintenanceReport> {
  const dryRun = opts.dryRun === true
  const deep = opts.deep === true
  const errors: string[] = []
  const warnings: string[] = []

  // 1) 过期分享箱（D1 + R2）
  let tempbox = { batches: 0, objects: 0, errors: [] as string[] }
  try {
    const purged = await purgeExpiredTempbox(env, dryRun, errors)
    tempbox = { ...purged, errors }
  } catch (err) {
    errors.push(`分享箱清理失败: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 2) 过期会话（保留最近几天，便于排查"刚掉线"）
  let sessionsDeleted = 0
  try {
    if (dryRun) {
      const r = await env.DB.prepare("SELECT COUNT(*) AS c FROM sessions WHERE expires_at < ?")
        .bind(daysAgoIso(SESSION_RETENTION_DAYS))
        .first<{ c: number }>()
      sessionsDeleted = r?.c ?? 0
    } else {
      const r = await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?")
        .bind(daysAgoIso(SESSION_RETENTION_DAYS))
        .run()
      sessionsDeleted = r.meta?.changes ?? 0
    }
  } catch (err) {
    errors.push(`会话清理失败: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 3) 过期限流窗口（窗口已翻篇的行不会再被命中）
  let rateLimitsDeleted = 0
  try {
    if (dryRun) {
      const r = await env.DB.prepare("SELECT COUNT(*) AS c FROM rate_limits WHERE window_start < ?")
        .bind(daysAgoIso(RATE_LIMIT_RETENTION_DAYS))
        .first<{ c: number }>()
      rateLimitsDeleted = r?.c ?? 0
    } else {
      const r = await env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?")
        .bind(daysAgoIso(RATE_LIMIT_RETENTION_DAYS))
        .run()
      rateLimitsDeleted = r.meta?.changes ?? 0
    }
  } catch (err) {
    // 表未迁移：只记日志，不当成错误（限流本身是 fail-open 的）
    console.error("限流记录清理失败（表可能未迁移）:", err)
  }

  // 4) 老审计日志（仅深度模式，避免每小时都跑一遍大 DELETE）
  let auditLogsDeleted = 0
  if (deep) {
    try {
      if (dryRun) {
        const r = await env.DB.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE created_at < ?")
          .bind(daysAgoIso(AUDIT_RETENTION_DAYS))
          .first<{ c: number }>()
        auditLogsDeleted = r?.c ?? 0
      } else {
        const r = await env.DB.prepare("DELETE FROM audit_logs WHERE created_at < ?")
          .bind(daysAgoIso(AUDIT_RETENTION_DAYS))
          .run()
        auditLogsDeleted = r.meta?.changes ?? 0
      }
    } catch (err) {
      errors.push(`审计日志清理失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 5) 网盘记账自检（只报告）
  const storageMismatches = await findStorageMismatches(env)
  if (storageMismatches.length > 0) {
    warnings.push(
      `${storageMismatches.length} 个用户的网盘记账与明细不一致（可能是上传中断/预签名直传未 commit）：` +
        storageMismatches
          .slice(0, 5)
          .map((m) => `${m.prefix}(记 ${m.fileCount} 实 ${m.actual})`)
          .join("、") +
        (storageMismatches.length > 5 ? " …" : "") +
        "。可用管理端「重算用量」修正。"
    )
  }

  // 6) 大表行数预警（D1 按行读计费，大表是最贵的地方）
  const tableRows = await collectTableRows(env)
  for (const [table, rows] of Object.entries(tableRows)) {
    const limit = TABLE_WARN_ROWS[table]
    if (limit && rows >= limit) {
      warnings.push(`表 ${table} 已有 ${rows} 行（阈值 ${limit}），建议评估清理策略以免拖高 D1 行读计费。`)
    }
  }

  // 7) 清理失败也算告警（否则"静默失败"永远没人知道）
  if (errors.length > 0) {
    warnings.push(`本次运维有 ${errors.length} 项失败：${errors.slice(0, 3).join("；")}`)
  }

  const report: MaintenanceReport = {
    ranAt: new Date().toISOString(),
    dryRun,
    deep,
    tempbox,
    sessionsDeleted,
    auditLogsDeleted,
    rateLimitsDeleted,
    storageMismatches,
    tableRows,
    warnings,
    errors,
  }

  await recordRun(env, report)
  if (!dryRun) await notifyAdmins(env, report)

  return report
}
