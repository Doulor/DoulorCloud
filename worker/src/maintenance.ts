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
import { deletePrefix, getPlatformBucketId } from "./r2"
import { uuid } from "./crypto"
import { purgeExpiredOAuth } from "./oauth-provider"
import { retryDonationModels } from "./donation-provision"
import { promoteRecoveredDonations, auditSenseNovaKeys } from "./handlers/donations"
import { resumeAnnouncementMails } from "./handlers/announcements"
import { processScheduledPublishes } from "./scheduled-publish"
import { purgeExpiredAnalytics } from "./handlers/analytics"
import { purgeExpiredPreviews } from "./link-preview"
import { autoPriceNewModels } from "./newapi-client"
import { expireRentalOrders } from "./points-shop"
import { scanDns } from "./dns-audit"
import { sweepSuspendedDns, retrySuspendedDnsRestore, ownerStatusSql } from "./user-suspension"
import { syncProxySubscriptionStatuses, probeProxyNodeHealth } from "./handlers/proxy"

/** 过期会话保留期（天）：留一点用于排查"刚掉线"的投诉 */
const SESSION_RETENTION_DAYS = 7
/** 审计日志保留期（天） */
const AUDIT_RETENTION_DAYS = 90
/** 限流窗口记录保留期（天）：窗口早于此时刻的行不会再被命中 */
const RATE_LIMIT_RETENTION_DAYS = 1
/**
 * 匿名统计事件保留期（天）。
 * ⚠️ 必须与 `handlers/analytics.ts` 的 `purgeExpiredAnalytics` 内部值**保持一致** ——
 * dry-run 分支在这里独立算截止时间，两处不一致会让「预演说清 3 行、真跑清 300 行」。
 */
const ANALYTICS_RETENTION_DAYS = 90
/**
 * 链接预览缓存保留期（天）。同样必须与 `link-preview.ts` 的 `PREVIEW_TTL_DAYS` 一致。
 */
const PREVIEW_RETENTION_DAYS = 7
/** 单次清理的分享箱上限，避免一次跑太久撞 CPU/子请求限额 */
const TEMPBOX_PURGE_BATCH = 200
/** 保留最近多少次运行记录（供对比增长速度与排查 cron 是否还在跑） */
const MAINTAIN_RUN_KEEP = 100

/** 单个表的告警阈值（行数）。D1 免费额度按**行读**计费，大表是最贵的地方。 */
const TABLE_WARN_ROWS: Record<string, number> = {
  messages: 100_000,
  audit_logs: 100_000,
  // 0068 起 notifications 承担全站消息（含公告/活动的广播，一次发布 = 活跃用户数行），
  // 增长比以前快得多，阈值从 20 万下调到 10 万。
  notifications: 100_000,
  events: 5_000,
  event_claims: 200_000,
  // 0071：公告邮件队列。每发一条公告 = 活跃用户数行，且完成后仍保留（供排查
  // 「谁没收到」），所以是「有界但不小」的表。阈值给到 50 万，到量说明该清理了。
  announcement_mail_queue: 500_000,
  posts: 50_000,
  post_likes: 200_000,
  storage_objects: 100_000,
  sessions: 50_000,
  rate_limits: 50_000,
  oauth_codes: 50_000,
  oauth_tokens: 50_000,
  // ⚠️ 2026-09-25 审计（H13）：下面四张表原先既没有清理、也没有告警。
  //   analytics_events —— 匿名每浏览写 1 行；link_previews —— 每条外链 1 行；
  //   chat_messages / post_comments —— 纯增长。
  //   在 D1「按行读计费」的模型下，无人看管且无告警的表就是账单黑洞。
  analytics_events: 500_000,
  link_previews: 100_000,
  chat_messages: 200_000,
  post_comments: 200_000,
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
  /** 已清理的 OAuth 过期授权码 / 令牌数 */
  oauthPurged: { codes: number; tokens: number }
  /** 已清理的过期匿名统计事件 / 链接预览缓存数（H13：这两个函数原先从未被调用） */
  expiredPurged: { analyticsEvents: number; linkPreviews: number }
  /** NewAPI 权限同步结果（孤儿清理 / 禁用 / 启用） */
  newapiSync: { removedOrphans: number; disabled: number; enabled: number; errors: string[] }
  /** 已清理的过期反代登录会话数（state 15 分钟即失效，不清会持续堆积） */
  wb2apiSessionsDeleted: number
  /** 已清理的过期 Qoder2API 登录会话数（顺带删掉上游僵尸账号） */
  qoder2apiSessionsDeleted: number
  /** AI 捐献失败模型的重试结果（限流/超时的模型可能已恢复） */
  donationRetries: {
    recovered: number
    /** 因模型恢复而自动从「转人工」推进到已通过的捐献笔数 */
    promoted: number
    stillUncertain: number
    exhausted: number
    errors: string[]
  }
  /** 公告邮件续跑结果（0071：ctx.waitUntil 被中断时的兜底） */
  announcementMails: { announcements: number; processed: number }
  /**
   * 商汤 Key 巡检结果（2026-09-28）。
   *
   * 封堵「捐了 Key 拿到权限后把 Key 删掉」的白嫖路径：只有上游明确拒绝
   * （401/403）才动手，且仅当该捐献是用户 ai 权限的唯一来源才收回，
   * 收回时连带封禁其 NewAPI 中转站账号。
   */
  sensenovaAudit: {
    checked: number
    invalid: number
    uncertain: number
    keysRemoved: number
    permissionsRevoked: number
    newapiDisabled: number
    keptWithOtherSource: number
    keptNotGranted: number
    errors: string[]
  }
  /**
   * 积分商城「租用」到期处理结果（2026-09-28）。
   *
   * 收回 feature 类租用到期的模块权限（仅当没有别的有效租用在给同一权限）、
   * 归还租用商品占用的库存（租用的 stock = 同时可租份数），并打幂等标记。
   * 用户商品（manual）无法强制回收，只记 note。
   */
  rentalExpiry: {
    checked: number
    handled: number
    permissionsRevoked: number
    keptWithOtherSource: number
    stockReturned: number
    notes: string[]
    errors: string[]
  }
  /** 网盘记账与实际记录数不一致的用户（只报告，不自动修） */
  storageMismatches: { prefix: string; fileCount: number; actual: number; usedBytes: number }[]
  /**
   * DNS 解析合规扫描结果（2026-10-01）。
   * 只做静态规则（私网地址、第三方托管、域名转发、无效内容…）；
   * 「真实解析探测」是站长在面板上手动触发的，不进 cron（避免外部依赖）。
   */
  dnsAudit: { scanned: number; found: number; high: number; medium: number; low: number } | null
  tableRows: Record<string, number>
  proxySync: { checked: number; offline: number; unknown: number; recovered: number } | null
  /** 封禁用户遗留/待恢复的 CF DNS 记录兜底（removed = 删掉、restored = 重建） */
  suspendedDns: { removed: number; restored: number; errors: string[] }
  /**
   * 代理节点逐节点探活结果（2026-10-08）。
   * 轮转增量：每轮只探「最久没探过」的几个订阅源，见 handlers/proxy.ts 的
   * PROBE_MAX_SUBSCRIPTIONS_PER_RUN。`nodes` 是本轮写入/更新的健康行数。
   */
  proxyProbe: { subscriptions: number; nodes: number; up: number; down: number; unknown: number } | null
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
 *
 * ⚠️ 2026-09-25 审计（H4）：这里原本有两个叠加的 bug，合起来会造成
 * **R2 对象永久泄漏且不可清**：
 *
 *   1. `deletePrefix(env, prefix)` 只传了 3 个参数 → 缺省走 `envConfig` 的
 *      env 默认桶。多桶部署下正确的桶是 `getPlatformBucketId(env)`
 *      （本仓其它 5 处 tempbox 的 deletePrefix 调用**都**传了它，只有这里漏了）；
 *   2. 更严重的是：R2 删除抛错后异常被 catch，**紧接着仍然执行
 *      `DELETE FROM tempbox_batches`** —— D1 行没了，R2 对象却还在桶里。
 *      于是它们既不会被惰性清理（没有接收码可触发），也不会被定时清理
 *      （D1 里已经没有那一行了），变成永远不可读、不可清的死数据。
 *      上面那句「R2 删除失败不阻断（下次继续）」本来就是这个意思 ——
 *      但「下次」根本不会来，因为触发条件（D1 行）已经被自己删掉了。
 *
 * 现在：删 R2 失败就**保留 D1 行**，下一轮 cron 会重新捞起它重试，
 * 并把错误计入 warnings 通知管理员。宁可重试到修好，也不能静默丢对象。
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

  // 桶 ID 只查一次（getPlatformBucketId 自带 60 秒缓存，这里显式复用更清楚）
  const bucketId = await getPlatformBucketId(env)

  let objects = 0
  let purged = 0
  for (const code of codes) {
    try {
      objects += await deletePrefix(env, `temporary/${code}/`, 50, bucketId)
    } catch (err) {
      // 关键：**不删 D1 行**，留给下一轮重试
      errors.push(
        `分享箱 ${code} 的对象清理失败（已保留记录待下轮重试）: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      continue
    }
    await env.DB.prepare("DELETE FROM tempbox_batches WHERE code = ? COLLATE NOCASE")
      .bind(code)
      .run()
    purged++
  }
  // 只把「R2 与 D1 都清干净了」的批次计入，避免报告虚高
  return { batches: purged, objects }
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
          analyticsEvents: report.expiredPurged.analyticsEvents,
          linkPreviews: report.expiredPurged.linkPreviews,
          storageMismatches: report.storageMismatches.length,
          sensenovaAuditRevoked: report.sensenovaAudit.permissionsRevoked,
          rentalExpired: report.rentalExpiry.handled,
          rentalPermissionsRevoked: report.rentalExpiry.permissionsRevoked,
          proxyProbeNodes: report.proxyProbe?.nodes ?? 0,
          proxyProbeUp: report.proxyProbe?.up ?? 0,
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

  // 4) OAuth 过期数据（授权码 60 秒、令牌 1 小时，都很短命但会持续堆积）
  //
  // 为什么必须在这里清：oauth_codes 每次授权都会插一行，oauth_tokens 每次登录
  // 换码都会插一行。不清的话，即使它们早已失效也永远留在表里，
  // 最终拖高 D1 的行读计费（见步骤 6 的大表预警）。
  let oauthPurged = { codes: 0, tokens: 0 }
  try {
    if (dryRun) {
      const now = new Date().toISOString()
      const c = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM oauth_codes WHERE expires_at < ? OR used = 1"
      )
        .bind(now)
        .first<{ n: number }>()
      const t = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM oauth_tokens WHERE expires_at < ?"
      )
        .bind(now)
        .first<{ n: number }>()
      oauthPurged = { codes: c?.n ?? 0, tokens: t?.n ?? 0 }
    } else {
      oauthPurged = await purgeExpiredOAuth(env)
    }
  } catch (err) {
    // 表未迁移：只记日志。OAuth 清理失败不该让整个运维任务报错
    console.error("OAuth 过期数据清理失败（表可能未迁移）:", err)
  }

  // 4b) 过期的反代登录会话
  //
  // 与 OAuth 同理：每次「发起登录」都插一行，而网关的 state 15 分钟就失效，
  // 不清的话（尤其是用户点了就走、没回来轮询的那些）会一直堆着。
  let wb2apiSessionsDeleted = 0
  try {
    const cutoff = daysAgoIso(1)
    if (dryRun) {
      const r = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM wb2api_login_sessions WHERE expires_at < ?"
      )
        .bind(cutoff)
        .first<{ c: number }>()
      wb2apiSessionsDeleted = r?.c ?? 0
    } else {
      const r = await env.DB.prepare(
        "DELETE FROM wb2api_login_sessions WHERE expires_at < ?"
      )
        .bind(cutoff)
        .run()
      wb2apiSessionsDeleted = r.meta?.changes ?? 0
    }
  } catch (err) {
    // 表未迁移：只记日志
    console.error("反代登录会话清理失败（表可能未迁移）:", err)
  }

  // 4b2) 过期的 Qoder2API 登录会话（第二条通道）
  //
  // 与 wb2api / 原 cli2api 都不同：qoder2api 的账号由**上游在设备授权成功那一刻**才创建，
  // 用户「发起登录」却没回来（或中途放弃）时，上游**不会**留下任何账号 ——
  // 所以这里只要清掉本地会话行即可，没有「上游僵尸账号」要删。
  let qoder2apiSessionsDeleted = 0
  try {
    const cutoff = daysAgoIso(1)
    if (dryRun) {
      const r = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM qoder2api_login_sessions WHERE expires_at < ?"
      )
        .bind(cutoff)
        .first<{ c: number }>()
      qoder2apiSessionsDeleted = r?.c ?? 0
    } else {
      const r = await env.DB.prepare(
        "DELETE FROM qoder2api_login_sessions WHERE expires_at < ?"
      )
        .bind(cutoff)
        .run()
      qoder2apiSessionsDeleted = r.meta?.changes ?? 0
    }
  } catch (err) {
    console.error("Qoder2API 登录会话清理失败（表可能未迁移）:", err)
  }

  // 4c) 过期匿名统计事件 / 链接预览缓存（2026-09-25 审计 H13）
  //
  // ⚠️ 这两个清理函数（handlers/analytics.ts 的 purgeExpiredAnalytics 90 天、
  // link-preview.ts 的 purgeExpiredPreviews 7 天）**早就写好了，但从来没有
  // 任何地方调用过** —— 全仓 grep 只命中定义处。而文档（docs/新功能-定时运维与
  // 邮件回信.md、HANDOFF.md）还宣称这两件事已经做了。
  //
  // 后果：analytics_events 是**匿名接口每浏览写一行**，link_previews 是每条
  // 外链一行，两张表无界增长且不在 TABLE_WARN_ROWS 里 —— 连告警都没有。
  // 在 D1 按行读计费下，这是全库最贵的两张表。
  let expiredPurged = { analyticsEvents: 0, linkPreviews: 0 }
  try {
    if (dryRun) {
      const analyticsCutoff = daysAgoIso(ANALYTICS_RETENTION_DAYS)
      const previewCutoff = daysAgoIso(PREVIEW_RETENTION_DAYS)
      const a = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM analytics_events WHERE created_at < ?"
      )
        .bind(analyticsCutoff)
        .first<{ c: number }>()
      const p = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM link_previews WHERE fetched_at < ?"
      )
        .bind(previewCutoff)
        .first<{ c: number }>()
      expiredPurged = { analyticsEvents: a?.c ?? 0, linkPreviews: p?.c ?? 0 }
    } else {
      expiredPurged = {
        analyticsEvents: await purgeExpiredAnalytics(env),
        linkPreviews: await purgeExpiredPreviews(env),
      }
    }
  } catch (err) {
    // 表未迁移：只记日志。这两张表清不掉不该让整个运维任务报错
    console.error("过期统计/预览缓存清理失败（表可能未迁移）:", err)
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

  // 6) NewAPI 权限同步 —— 2026-09-27 已停用。
  //
  // 原先每小时全量遍历所有开通中转站的用户、逐个调 NewAPI 核对，用户一多就撞
  // Cloudflare Worker 的 subrequest 上限（报「Too many subrequests」），每小时发一封
  // 告警邮件。封禁/解封的同步是**实时的**（handlers/admin.ts 的 updateUser 里直接调
  // adminSetUserStatus），这个定时兜底只补「孤儿清理」和「非封禁的权限变化」两个边角，
  // 对站长自用的体量价值很低。需要时仍可走管理面板的手动触发
  // `POST /api/admin/newapi/sync-permissions`。
  const newapiSync = { removedOrphans: 0, disabled: 0, enabled: 0, errors: [] as string[] }

  // 7) AI 捐献「没通过测试」的模型重试（限流/超时的那些可能已经恢复了）
  let donationRetries = {
    recovered: 0,
    promoted: 0,
    stillUncertain: 0,
    exhausted: 0,
    errors: [] as string[],
  }
  try {
    const r = await retryDonationModels(env, { dryRun })
    // 有模型恢复 → 把「全模型不确定、转人工」的单据自动放行
    // （dryRun 只观察不写库，更不能真的改单据状态）
    const promoted = dryRun ? [] : await promoteRecoveredDonations(env, r.recoveredDonations)
    donationRetries = {
      recovered: r.recovered.length,
      promoted: promoted.length,
      stillUncertain: r.stillUncertain,
      exhausted: r.exhausted,
      errors: r.errors,
    }
    for (const e of r.errors) errors.push(`模型重试：${e}`)
    if (r.recovered.length > 0) {
      warnings.push(
        `本次重试恢复了 ${r.recovered.length} 个此前未通过测试的模型：${r.recovered.slice(0, 5).join("、")}`
      )
    }
    if (promoted.length > 0) {
      warnings.push(`有 ${promoted.length} 笔「转人工」的捐献因模型恢复而自动通过审核。`)
    }
  } catch (err) {
    errors.push(`模型重试失败: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 7b) 新模型自动补按次价（没有 ModelPrice 的模型会回落 token 倍率 37.5）
  let modelsPriced = 0
  if (!dryRun) {
    try {
      modelsPriced = await autoPriceNewModels(env)
      if (modelsPriced > 0) {
        warnings.push(`已为 ${modelsPriced} 个新模型自动补上 1 元/次的按次价。`)
      }
    } catch (err) {
      console.error("新模型补价失败:", err)
    }
  }

  // 7c) 商汤 Key 定期巡检（封堵「捐 Key 拿权限后删 Key」的白嫖路径）
  //
  // 为什么挂在每小时这条而不是每分钟那条：巡检要对每把 Key 真调一次上游
  // （outbound subrequest），属于「贵且不急」的事 —— 每小时一轮足够
  // 让白嫖窗口短到没有套利价值，又不会把每分钟那条 cron 的成本 ×60。
  //
  // 判据与动作的完整说明见 handlers/donations.ts 的 auditSenseNovaKeys。
  // 一句话：只有上游**明确拒绝**（401/403）才算失效，网络抖动一律放过；
  // 失效后摘 Key，且仅当该捐献是用户 ai 权限的唯一来源时才收回权限，
  // 收回时连带封禁其 NewAPI 中转站账号。
  const sensenovaAudit: MaintenanceReport["sensenovaAudit"] = {
    checked: 0,
    invalid: 0,
    uncertain: 0,
    keysRemoved: 0,
    permissionsRevoked: 0,
    newapiDisabled: 0,
    keptWithOtherSource: 0,
    keptNotGranted: 0,
    errors: [],
  }
  try {
    const r = await auditSenseNovaKeys(env, { dryRun })
    Object.assign(sensenovaAudit, r)
    for (const e of r.errors) errors.push(`商汤巡检：${e}`)
    for (const n of r.notes) warnings.push(n)
    if (r.permissionsRevoked > 0) {
      warnings.push(
        `商汤 Key 巡检收回了 ${r.permissionsRevoked} 个用户的 AI 权限` +
          `（其中 ${r.newapiDisabled} 个已连带封禁中转站账号）。`
      )
    }
  } catch (err) {
    // 巡检失败不该让整个运维任务报错（其它清理项还要跑）
    errors.push(`商汤 Key 巡检失败: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 7d) 积分商城「租用」到期处理（2026-09-28）
  //
  // 为什么挂在每小时这条：到期是「分钟级不敏感、但漏了会持续白送」的事 ——
  // 收回动作要写库 + 可能调 NewAPI，属于「贵且不急」。
  // 判据与动作的完整说明见 points-shop.ts 的 expireRentalOrders。
  const rentalExpiry: MaintenanceReport["rentalExpiry"] = {
    checked: 0,
    handled: 0,
    permissionsRevoked: 0,
    keptWithOtherSource: 0,
    stockReturned: 0,
    notes: [],
    errors: [],
  }
  try {
    const r = await expireRentalOrders(env, { dryRun })
    Object.assign(rentalExpiry, r)
    for (const e of r.errors) errors.push(`租用到期：${e}`)
    for (const n of r.notes) warnings.push(n)
    if (r.permissionsRevoked > 0) {
      warnings.push(`积分商城有 ${r.permissionsRevoked} 笔租用到期，已收回对应模块权限。`)
    }
  } catch (err) {
    // 表未迁移 / 上游异常都不该让整个运维任务报错（其它清理项还要跑）
    console.error("租用到期处理失败（表可能未迁移）:", err)
  }

  // 8) 大表行数预警（D1 按行读计费，大表是最贵的地方）
  // ⚠️ 2026-09-25 审计（M15）：本模块的自述目标是「降低 D1 行读成本」，
  // 但它自己**每小时**对 10+ 张大表各做一次 `COUNT(*)` —— 这是全表扫描，
  // 与目标正好相反（messages 到 10 万行时，单次 cron 就可能消耗数十万行读）。
  //
  // SQLite/D1 没有 O(1) 的行数查询，所以没法既准确又便宜。取舍：
  // 把行数统计收敛到**每日一次的深度模式**（cron 在 UTC 03:xx 那次带 deep），
  // 成本直接降到 1/24。行数预警本来就是「看增长趋势」用的，每天一次足够；
  // 真正需要分钟级关注的指标不该靠 COUNT(*) 拿。
  const tableRows = deep ? await collectTableRows(env) : {}
  for (const [table, rows] of Object.entries(tableRows)) {
    const limit = TABLE_WARN_ROWS[table]
    if (limit && rows >= limit) {
      warnings.push(`表 ${table} 已有 ${rows} 行（阈值 ${limit}），建议评估清理策略以免拖高 D1 行读计费。`)
    }
  }

  // 9) 公告邮件续跑（0071）
  //
  // ctx.waitUntil 的后台任务不保证跑完（部署、超时、实例回收都可能中断），
  // 队列里会留下 status='pending' 的行。这里每小时兜底捞一次，
  // 保证「管理员点了发布，邮件最终一定会发出去」。
  let announcementMails = { announcements: 0, processed: 0 }
  if (!dryRun) {
    try {
      announcementMails = await resumeAnnouncementMails(env)
      if (announcementMails.announcements > 0) {
        warnings.push(
          `续跑了 ${announcementMails.announcements} 条公告的邮件群发（本次发出 ${announcementMails.processed} 封）。`
        )
      }
    } catch (err) {
      // 表未迁移：只记日志，不影响其它运维项
      console.error("公告邮件续跑失败（表可能未迁移）:", err)
    }
  }

  // 9b) 到点发布兜底
  //
  // 主路径是每分钟那条 cron（index.ts 里 SCHEDULED_PUBLISH_CRON → processScheduledPublishes）。
  // 这里每小时再跑一次，是为了防止那条 cron 没配上 / 被误删 —— 那样定时公告与
  // 定时活动会**永远不发**，而且不会有任何报错（最隐蔽的失败）。
  if (!dryRun) {
    try {
      const published = await processScheduledPublishes(env)
      if (published.announcements > 0 || published.events > 0) {
        warnings.push(
          `到点发布了 ${published.announcements} 条公告、${published.events} 个活动。`
        )
      }
    } catch (err) {
      console.error("到点发布兜底失败（表可能未迁移）:", err)
    }
  }

  // 9c) DNS 解析合规扫描（2026-10-01）
  //
  // 站内 DNS 解析功能此前没有任何审核（见 dns-audit.ts 的模块注释）。
  // 这里每小时跑一次**静态规则**扫描：只读 dns_records 一行 SELECT + 内存规则，
  // 不产生外部请求，成本可忽略（这也是不在 cron 里做真实解析探测的原因）。
  // 结果落 dns_audit_findings，站长在「管理 → DNS」里处置。
  let dnsAudit: { scanned: number; found: number; high: number; medium: number; low: number } | null = null
  if (!dryRun) {
    try {
      const summary = await scanDns(env, { mode: "hourly" })
      dnsAudit = {
        scanned: summary.scanned,
        found: summary.found,
        high: summary.high,
        medium: summary.medium,
        low: summary.low,
      }
      if (summary.high > 0) {
        warnings.push(`DNS 合规扫描发现 ${summary.high} 项高风险解析记录，请到「管理 → DNS」处理。`)
      }
    } catch (err) {
      // 表未迁移 / D1 抖动：只记日志，不影响其它运维项
      console.error("DNS 合规扫描失败（表可能未迁移）:", err)
    }
  }

  // 9d) 订阅源过时检测（2026-10-03 站长要求）
  //
  // 逐个抓取订阅源：自动审核的失效 → 自动标 offline（列表自动排到最后）；人工审核的
  // 失效 → 只标 unknown 等管理员确认。抓取是外部请求（贵），挂每小时这条。
  let proxySync: { checked: number; offline: number; unknown: number; recovered: number } | null = null
  if (!dryRun) {
    try {
      proxySync = await syncProxySubscriptionStatuses(env)
      if (proxySync.offline > 0) {
        warnings.push(`订阅源过时检测：${proxySync.offline} 个自动审核的订阅源已自动标记不可用。`)
      }
      if (proxySync.unknown > 0) {
        warnings.push(`订阅源过时检测：${proxySync.unknown} 个人工审核的订阅源检测不可用，已标为未知待人工确认。`)
      }
    } catch (err) {
      console.error("订阅源过时检测失败（表可能未迁移）:", err)
    }
  }

  // 9e) 代理节点逐节点探活（2026-10-08）
  //
  // 与 9d 的分工：9d 只回答「订阅地址还打得开吗」，这里回答「节点本身还连得上吗」——
  // 前者对了后者未必：订阅地址能拉，里面一半节点可能早就死了。
  //
  // 为什么是**轮转增量**而不是每轮全探：探活对每个节点都要真建 TCP 连接，
  // 而 Cloudflare 把 connect() 计入子请求额度；本站订阅源是三位数级别、
  // 每源又有几十个节点，全量一轮是上万次连接，必然撞限额。
  // 所以每轮只挑「最久没探过」的几个源（判定与上限见 handlers/proxy.ts）。
  //
  // 说明：这里会**再抓一次**订阅（9d 刚抓过）。看似浪费，但刻意不复用 ——
  // 9d 的口径是「过时检测」、只关心能否解析出节点，与探活的轮转集合并不一致，
  // 把两者耦合起来会让「过时检测」被迫承担探活预算，改一处动全身。
  // 多出的请求是每轮个位数，相对于 9d 的全量抓取可以忽略。
  let proxyProbe: MaintenanceReport["proxyProbe"] = null
  if (!dryRun) {
    try {
      const r = await probeProxyNodeHealth(env)
      proxyProbe = {
        subscriptions: r.subscriptions,
        nodes: r.nodes,
        up: r.up,
        down: r.down,
        unknown: r.unknown,
      }
      for (const e of r.errors) errors.push(`节点探活：${e}`)
    } catch (err) {
      // 表未迁移 / D1 抖动：只记日志，不影响其它运维项
      console.error("代理节点探活失败（表可能未迁移）:", err)
    }
  }
  // 4d) 封禁用户遗留的 Cloudflare DNS 记录（2026-10-08）
  //
  // 两个方向都要兜底，否则「封禁/解封」各有一半不闭环：
  //   · sweepSuspendedDns —— **停用方向**：封禁那一跳受单请求子请求上限约束
  //     （见 user-suspension.ts 的 SUSPEND_BATCH），记录多的用户一次删不完；
  //     CF 瞬时故障也会留下一批。只处理「已标记停用、但 cf_id 还在」的行。
  //   · retrySuspendedDnsRestore —— **恢复方向**：解封时 CF 重建失败的记录会
  //     保留 banned_at，而用户端列表会过滤掉它 ⇒ 人解封了、解析少一条、自己还
  //     看不见，只能等管理员发现。这里按「归属用户已 active」重试。
  let suspendedDns = { removed: 0, restored: 0, errors: [] as string[] }
  try {
    if (dryRun) {
      // 口径必须与 sweepSuspendedDns 一致（含归属判据）：写成
      // `banned_at IS NOT NULL AND cf_id IS NOT NULL` 会恒报 0（见该函数注释）。
      const stuck = await env.DB.prepare(
        `SELECT COUNT(*) AS c FROM dns_records r
          WHERE r.cf_id IS NOT NULL AND r.cf_id != ''
            AND ${ownerStatusSql("suspended")}`
      ).first<{ c: number }>()
      const pending = await env.DB.prepare(
        `SELECT COUNT(*) AS c FROM dns_records r
          WHERE r.banned_at IS NOT NULL
            AND ${ownerStatusSql("active")}`
      ).first<{ c: number }>()
      warnings.push(
        `有 ${stuck?.c ?? 0} 条已停用记录仍挂在 Cloudflare、${pending?.c ?? 0} 条待恢复重建（dryRun 不处理）`
      )
    } else {
      // 批量刻意小于 SUSPEND_BATCH(40)：那个 40 是给「封禁请求」留的余量
      // （见 user-suspension.ts 的常量注释），而维护请求的预算口径不同 ——
      // 每条记录 = 1 次 CF DELETE + 1 次 D1 UPDATE，且 runMaintenance 自己
      // 已有约 15 个子请求。取 10 留足余量；处理不完的下一小时继续（自愈）。
      const swept = await sweepSuspendedDns(env, 10)
      const retried = await retrySuspendedDnsRestore(env, 10)
      suspendedDns = {
        removed: swept.removed,
        restored: retried.restored,
        errors: [...swept.errors, ...retried.errors],
      }
      for (const e of suspendedDns.errors) errors.push(`封禁记录兜底失败: ${e}`)
    }
  } catch (err) {
    // 表未迁移（0130 未应用）不该让整个运维任务失败
    console.error("停用记录兜底失败（表可能未迁移）:", err)
  }

  // 10) 清理失败也算告警（否则"静默失败"永远没人知道）
  //
  // ⚠️ 必须排在 4d 之后：sweep 修好后是真在干活，它的 CF 失败（429/403/子请求超限）
  // 会 push 进 errors —— 放在 4d 之前的话这些失败既不进 warnings 也不落库
  // （maintenance_runs 只有 stats/warnings 两列），线上永远看不见。
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
    oauthPurged,
    expiredPurged,
    newapiSync,
    wb2apiSessionsDeleted,
    qoder2apiSessionsDeleted,
    donationRetries,
    sensenovaAudit,
    rentalExpiry,
    announcementMails,
    storageMismatches,
    dnsAudit,
    tableRows,
    proxySync,
    suspendedDns,
    proxyProbe,
    warnings,
    errors,
  }

  await recordRun(env, report)
  // ⚠️ 2026-09-27：不再发运维告警邮件。站长明确不要这份每小时邮件 ——
  // 有告警直接看 D1 的 maintenance_runs 表或 console.warn 即可。
  // （原先 notifyAdmins 在 warnings 非空时给所有已验证管理员发邮件。）

  return report
}
