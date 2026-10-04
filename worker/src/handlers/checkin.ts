/**
 * 每日签到。
 *
 * 三件事必须做对：
 * 1. **「今天」按站点时区（UTC+8）算**，不是 UTC —— 否则中国用户晚上 8 点之后
 *    签到会被算成「第二天」，跨零点就乱了；
 * 2. **连续天数**：昨天签过才 +1，否则从 1 重新开始（中间断了就是断了）；
 * 3. **一人一天只能签一次**：靠主键 (user_id, checkin_date) 兜底，并发双击也只成功一条。
 *
 * ── 发放顺序与幂等 ──
 * 先 `applyPoints`（带 `dedupKey`）再写签到记录。这样即使「加分成功、写记录失败」，
 * 用户重试时加分会被 dedup 挡住（不重复发），而记录最终补上 —— 两边都不会出错。
 */
import { ApiError, json } from "../http"
import { requireUser } from "../auth"
import { getSetting, getSettingBool, getSettingNumber, siteOffsetHours, siteDayString } from "../settings"
import { applyPoints } from "../points"
import {
  parseCheckinMilestones,
  parseCheckinRange,
  milestoneBonusFor,
  nextMilestone,
} from "../checkin-config"
import type { Env } from "../env"

/** 某个日期字符串的前一天 */
function prevDateString(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/** 闭区间随机整数。用 crypto 而不是 Math.random —— 奖励发放不该可预测 */
function randInt(min: number, max: number): number {
  if (max <= min) return min
  const range = max - min + 1
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  // 用取模会引入轻微偏斜，但区间很小（几十到几百），可忽略
  return min + (buf[0] % range)
}

export interface CheckinStatus {
  enabled: boolean
  /** 今天是否已签到 */
  checkedIn: boolean
  /** 当前连续天数（今天已签则含今天，未签则指「已连续签到的天数」） */
  streak: number
  /** 今天签到时实际拿到的分（未签为 0） */
  todayPoints: number
  /** 今天的基础奖励与里程碑奖励（仅 checkedIn 时有意义） */
  todayBase: number
  todayBonus: number
  /** 里程碑列表（供前端画进度） */
  milestones: { days: number; points: number }[]
  /** 下一个里程碑（未签时用于提示「再签 N 天」） */
  next: { days: number; points: number; daysLeft: number } | null
}

/**
 * GET /api/checkin —— 我的签到状态。
 *
 * 只读，未登录也能看到「功能是否开启」但拿不到个人状态；
 * 个人状态一律要求登录（这是私人数据）。
 */
export async function getCheckinStatus(env: Env, request: Request): Promise<Response> {
  const enabled = await getSettingBool(env, "checkin_enabled")
  if (!enabled) return json({ enabled: false, checkedIn: false, streak: 0, milestones: [] })

  const user = await requireUser(env, request)
  const today = siteDayString(new Date(), await siteOffsetHours(env))

  const todayRow = await env.DB.prepare(
    `SELECT points, base_points, bonus_points, streak FROM daily_checkins
     WHERE user_id = ? AND checkin_date = ?`
  )
    .bind(user.id, today)
    .first<{ points: number; base_points: number; bonus_points: number; streak: number }>()

  // 当前连续天数：今天签了用今天的 streak；没签则看昨天
  let streak = 0
  if (todayRow) {
    streak = todayRow.streak
  } else {
    const yesterday = await env.DB.prepare(
      `SELECT streak FROM daily_checkins WHERE user_id = ? AND checkin_date = ?`
    )
      .bind(user.id, prevDateString(today))
      .first<{ streak: number }>()
    streak = yesterday?.streak ?? 0
  }

  const milestones = parseCheckinMilestones(await getSetting(env, "checkin_milestones"))
  const nxt = nextMilestone(streak, milestones)

  return json({
    enabled: true,
    checkedIn: Boolean(todayRow),
    streak,
    todayPoints: todayRow?.points ?? 0,
    todayBase: todayRow?.base_points ?? 0,
    todayBonus: todayRow?.bonus_points ?? 0,
    milestones,
    next: nxt ? { days: nxt.days, points: nxt.points, daysLeft: nxt.days - streak } : null,
  } satisfies CheckinStatus)
}

/**
 * POST /api/checkin —— 签到。
 */
export async function doCheckin(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const enabled = await getSettingBool(env, "checkin_enabled")
  if (!enabled) throw new ApiError(403, "签到功能已关闭", "CHECKIN_DISABLED")

  const today = siteDayString(new Date(), await siteOffsetHours(env))

  // 防重复：主键兜底，这里先查一次给个友好提示（避免用户看到 500）
  const existing = await env.DB.prepare(
    `SELECT 1 FROM daily_checkins WHERE user_id = ? AND checkin_date = ?`
  )
    .bind(user.id, today)
    .first()
  if (existing) throw new ApiError(409, "今天已经签过到了", "ALREADY_CHECKED_IN")

  // 连续天数：昨天签过 +1，否则重置为 1
  const yesterdayRow = await env.DB.prepare(
    `SELECT streak FROM daily_checkins WHERE user_id = ? AND checkin_date = ?`
  )
    .bind(user.id, prevDateString(today))
    .first<{ streak: number }>()
  const streak = (yesterdayRow?.streak ?? 0) + 1

  // 奖励：基础区间随机 + 命中里程碑的额外奖励
  const { min, max } = parseCheckinRange(
    await getSettingNumber(env, "checkin_points_min"),
    await getSettingNumber(env, "checkin_points_max")
  )
  const base = randInt(min, max)
  const milestones = parseCheckinMilestones(await getSetting(env, "checkin_milestones"))
  const bonus = milestoneBonusFor(streak, milestones)
  const bonusPoints = bonus?.points ?? 0
  const total = base + bonusPoints

  // 先加分（幂等），再写记录
  if (total > 0) {
    await applyPoints(env, {
      userId: user.id,
      delta: total,
      reason: "checkin",
      detail: bonus
        ? `连续签到第 ${streak} 天：基础 ${base} + 里程碑 ${bonusPoints}`
        : `签到奖励（连续第 ${streak} 天）`,
      dedupKey: `checkin:${user.id}:${today}`,
    })
  }
  await env.DB.prepare(
    `INSERT INTO daily_checkins (user_id, checkin_date, points, base_points, bonus_points, streak, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(user.id, today, total, base, bonusPoints, streak, new Date().toISOString())
    .run()

  const nxt = nextMilestone(streak, milestones)
  return json({
    ok: true,
    streak,
    base,
    bonus: bonusPoints,
    total,
    milestoneHit: bonus ? { days: bonus.days, points: bonus.points } : null,
    next: nxt ? { days: nxt.days, points: nxt.points, daysLeft: nxt.days - streak } : null,
  })
}
