/**
 * 到点发布：「定时公告 / 定时活动」的发布引擎。
 *
 * 为什么单独一个模块：公告与活动的发布动作各自写在自己的 handler 里
 * （publishAnnouncementNow / activateScheduledEvent），这里只负责**扫表 + 派发**，
 * 两个 cron 入口（每分钟的发布 tick、每小时运维兜底）共用同一份逻辑。
 *
 * 触发方式（见 worker/src/index.ts 的 scheduled / worker/wrangler.toml 的 crons）：
 *   - `* * * * *`  每分钟：只跑本模块，成本 = 两条 SELECT（没任务时几乎为零）
 *   - `17 * * * *` 每小时：跑完整运维，顺带再跑一次本模块兜底
 *
 * 幂等性由被调用的 publish/activate 函数保证（各自用 WHERE 条件 + dedupKey），
 * 所以「每分钟跑一次」和「被重复调用」都是安全的。
 */
import { publishAnnouncementNow } from "./handlers/announcements"
import { activateScheduledEvent, drawDueLotteries, drawDueVotes } from "./handlers/events"
import type { Env } from "./env"

/** 单次最多处理多少条，避免一次 cron 跑太久（剩下的下一次继续） */
const MAX_PER_RUN = 20

export interface ScheduledPublishResult {
  announcements: number
  events: number
  /** 到点自动开奖的抽奖活动数 */
  lotteries: number
  /** 到点自动开奖的投票活动数（仅「多数/少数得奖」那一档需要开奖） */
  votes: number
  errors: number
}

/**
 * 扫描「到点的定时公告 / 定时活动」并发布它们。
 *
 * 时间比较说明：库里统一存 ISO UTC 字符串，`new Date().toISOString()` 也是 ISO UTC，
 * 两边都是同一格式，字符串比较即等价于时间比较 —— 但**必须**用 JS 生成 ISO 再 bind，
 * 不能在 SQL 里用 `datetime('now')`（它产出空格分隔格式，和 ISO 比会全错）。
 */
export async function processScheduledPublishes(
  env: Env,
  ctx?: ExecutionContext
): Promise<ScheduledPublishResult> {
  const nowIso = new Date().toISOString()
  let announcements = 0
  let events = 0
  let errors = 0

  // 1) 定时公告：到点 → 广播消息中心 +（若勾了）群发邮件
  try {
    const rows = await env.DB.prepare(
      `SELECT id FROM announcements
        WHERE status = 'scheduled' AND publish_at IS NOT NULL AND publish_at <= ?
        ORDER BY publish_at LIMIT ?`
    )
      .bind(nowIso, MAX_PER_RUN)
      .all<{ id: string }>()
    for (const r of rows.results ?? []) {
      try {
        await publishAnnouncementNow(env, r.id, ctx)
        announcements++
      } catch (err) {
        errors++
        console.error("定时公告发布失败:", r.id, err)
      }
    }
  } catch (err) {
    // 表未迁移时（线上 d1_migrations 为空、迁移靠手工）只记日志，不影响定时活动那段
    errors++
    console.error("定时公告扫描失败（表可能未迁移）:", err)
  }

  // 2) 定时活动：到点 → 上线（status=active）+ 广播
  try {
    const rows = await env.DB.prepare(
      `SELECT id FROM events
        WHERE status = 'scheduled' AND publish_at IS NOT NULL AND publish_at <= ?
        ORDER BY publish_at LIMIT ?`
    )
      .bind(nowIso, MAX_PER_RUN)
      .all<{ id: string }>()
    for (const r of rows.results ?? []) {
      try {
        await activateScheduledEvent(env, r.id)
        events++
      } catch (err) {
        errors++
        console.error("定时活动上线失败:", r.id, err)
      }
    }
  } catch (err) {
    errors++
    console.error("定时活动扫描失败（表可能未迁移）:", err)
  }

  // 3) 到点自动开奖：抽奖活动过了 ends_at 还没开奖的（没设结束时间的不自动开）。
  // 幂等由 drawEvent 的 drawn_at 锁保证，重复扫到也不会开第二次。
  let lotteries = 0
  try {
    const r = await drawDueLotteries(env)
    lotteries = r.drawn
    errors += r.errors
  } catch (err) {
    errors++
    console.error("到点开奖扫描失败:", err)
  }

  // 4) 到点自动开奖：投票活动（仅「多数/少数得奖」那一档）。
  // 「参与即可获奖」和「投票后立刻结算」在投票时就发完了，drawDueVotes 内部会跳过。
  let votes = 0
  try {
    const r = await drawDueVotes(env)
    votes = r.drawn
    errors += r.errors
  } catch (err) {
    errors++
    console.error("投票到点开奖扫描失败:", err)
  }

  return { announcements, events, lotteries, votes, errors }
}
