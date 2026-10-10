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
  /**
   * 站点时区下的「今天」（YYYY-MM-DD）。
   *
   * 前端自动签到靠它判断「今天这一次是否已经处理过」—— 客户端算不出站点时区，
   * 所以必须由服务端给出权威值（见 src/components/auto-checkin.tsx）。
   */
  today: string
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
  /** 补签卡余额（0 = 没有） */
  makeupCards: number
  /** 现在能否补签（昨天漏签 + 有卡） */
  canMakeup: boolean
  /** 是否开了自动签到 */
  autoCheckin: boolean
}

/**
 * GET /api/checkin —— 我的签到状态。
 *
 * 只读，未登录也能看到「功能是否开启」但拿不到个人状态；
 * 个人状态一律要求登录（这是私人数据）。
 */
export async function getCheckinStatus(env: Env, request: Request): Promise<Response> {
  const enabled = await getSettingBool(env, "checkin_enabled")
  const today = siteDayString(new Date(), await siteOffsetHours(env))
  if (!enabled) return json({ enabled: false, today, checkedIn: false, streak: 0, milestones: [], makeupCards: 0, canMakeup: false, autoCheckin: false })

  const user = await requireUser(env, request)
  const yesterday = prevDateString(today)

  const todayRow = await env.DB.prepare(
    `SELECT points, base_points, bonus_points, streak FROM daily_checkins
     WHERE user_id = ? AND checkin_date = ?`
  )
    .bind(user.id, today)
    .first<{ points: number; base_points: number; bonus_points: number; streak: number }>()

  // 补签卡余额 + 自动签到开关 + 昨天是否已签
  const balance = await env.DB.prepare(
    `SELECT checkin_makeup_cards AS c, auto_checkin AS a FROM users WHERE id = ?`
  )
    .bind(user.id)
    .first<{ c: number; a: number }>()
  const makeupCards = Number(balance?.c ?? 0)
  const autoCheckin = Number(balance?.a ?? 0) === 1
  const yesterdayRow = await env.DB.prepare(
    `SELECT 1 FROM daily_checkins WHERE user_id = ? AND checkin_date = ?`
  )
    .bind(user.id, yesterday)
    .first()
  const canMakeup = !yesterdayRow && makeupCards > 0

  // 当前连续天数：今天签了用今天的 streak；没签则看昨天
  let streak = 0
  if (todayRow) {
    streak = todayRow.streak
  } else {
    const yesterdayStreak = await env.DB.prepare(
      `SELECT streak FROM daily_checkins WHERE user_id = ? AND checkin_date = ?`
    )
      .bind(user.id, yesterday)
      .first<{ streak: number }>()
    streak = yesterdayStreak?.streak ?? 0
  }

  const milestones = parseCheckinMilestones(await getSetting(env, "checkin_milestones"))
  const nxt = nextMilestone(streak, milestones)

  return json({
    enabled: true,
    today,
    checkedIn: Boolean(todayRow),
    streak,
    todayPoints: todayRow?.points ?? 0,
    todayBase: todayRow?.base_points ?? 0,
    todayBonus: todayRow?.bonus_points ?? 0,
    milestones,
    next: nxt ? { days: nxt.days, points: nxt.points, daysLeft: nxt.days - streak } : null,
    makeupCards,
    canMakeup,
    autoCheckin,
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

/**
 * POST /api/checkin/makeup —— 补签（消耗一张补签卡，补指定日期的漏签）。
 *
 * body：`{ date?: "YYYY-MM-DD" }`，缺省补「昨天」（向后兼容）。
 * 补的是**连续天数**，不发放当天积分奖励（积分只属于当天正常签到）。
 * 一次补一天、消耗一张卡；断签多天需要多张卡逐天补回。
 */
export async function makeupCheckin(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const enabled = await getSettingBool(env, "checkin_enabled")
  if (!enabled) throw new ApiError(403, "签到功能已关闭", "CHECKIN_DISABLED")

  const today = siteDayString(new Date(), await siteOffsetHours(env))
  const body = (await request.json().catch(() => ({}))) as { date?: string }
  const target =
    body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : prevDateString(today)

  // 只能补「过去」的日期，今天与未来走正常签到
  if (target >= today) throw new ApiError(400, "只能补签过去的日期", "INVALID_MAKEUP_DATE")

  // 该日已签 → 无需补
  const already = await env.DB.prepare(
    `SELECT 1 FROM daily_checkins WHERE user_id = ? AND checkin_date = ?`
  )
    .bind(user.id, target)
    .first()
  if (already) throw new ApiError(409, "该日期已经签过到了，无需补签", "ALREADY_CHECKED_IN")

  // 补签后该日的连续天数 = 前一天连续 + 1（前一天没有则从 1 重新算）
  const dayBefore = await env.DB.prepare(
    `SELECT streak FROM daily_checkins WHERE user_id = ? AND checkin_date = ?`
  )
    .bind(user.id, prevDateString(target))
    .first<{ streak: number }>()
  const streak = (dayBefore?.streak ?? 0) + 1

  // 原子扣卡：`>= 1` 条件 + RETURNING 让「判余额」与「扣卡」合成一次 D1 往返，
  // 且以**扣减结果**为真相源（扣不到就是没卡）。
  //
  // ⚠️ 不能先 SELECT 再在 JS 里判 `cards < 1`：那是「先读后判」，
  // 两个并发请求补**不同**日期时都会读到同一份余额、都判定「还有卡」、
  // 各扣一次 —— 余额被扣成负数，等于一张卡补了两天。
  // （`daily_checkins` 的主键是 (user_id, checkin_date)，只能拦住**同一日期**的重复补签，
  // 拦不住不同日期。这里刻意不与 PK 兜底混为一谈。）
  const claimed = await env.DB.prepare(
    `UPDATE users
        SET checkin_makeup_cards = checkin_makeup_cards - 1
      WHERE id = ? AND checkin_makeup_cards >= 1
    RETURNING checkin_makeup_cards`
  )
    .bind(user.id)
    .first<{ checkin_makeup_cards: number }>()
  if (!claimed) throw new ApiError(409, "没有可用的补签卡", "NO_MAKEUP_CARDS")

  try {
    await env.DB.prepare(
      `INSERT INTO daily_checkins (user_id, checkin_date, points, base_points, bonus_points, streak, is_makeup, created_at)
       VALUES (?, ?, 0, 0, 0, ?, 1, ?)`
    )
      .bind(user.id, target, streak, new Date().toISOString())
      .run()
  } catch (err) {
    // 记录没写成功（同一日期的并发补签撞 PK、D1 抖动…）：把刚扣的卡退回去，
    // 否则就是「扣了卡但没补上签」。退回失败也不影响原始报错。
    await env.DB.prepare(
      `UPDATE users SET checkin_makeup_cards = checkin_makeup_cards + 1 WHERE id = ?`
    )
      .bind(user.id)
      .run()
      .catch(() => {})
    const message = err instanceof Error ? err.message : String(err)
    if (/unique constraint|sqlite_constraint_unique/i.test(message)) {
      throw new ApiError(409, "该日期已经签过到了，无需补签", "ALREADY_CHECKED_IN")
    }
    throw err
  }

  // 重算 target 之后所有已签到行的连续天数：补的是中间某天，后面的链要接上，
  // 否则「补了 3 天前、2 天前却还是旧的断链值」会让后续签到算错。
  const after = await env.DB.prepare(
    `SELECT checkin_date FROM daily_checkins
      WHERE user_id = ? AND checkin_date > ? ORDER BY checkin_date ASC`
  )
    .bind(user.id, target)
    .all<{ checkin_date: string }>()
  let prevDate = target
  let prevStreak = streak
  for (const r of after.results ?? []) {
    const s = prevDateString(r.checkin_date) === prevDate ? prevStreak + 1 : 1
    await env.DB.prepare(
      `UPDATE daily_checkins SET streak = ? WHERE user_id = ? AND checkin_date = ?`
    )
      .bind(s, user.id, r.checkin_date)
      .run()
    prevDate = r.checkin_date
    prevStreak = s
  }

  return json({
    ok: true,
    makeupDate: target,
    streak,
    makeupCards: claimed.checkin_makeup_cards,
  })
}

/**
 * GET /api/checkin/history?month=YYYY-MM —— 某个月的签到日历数据。
 * 返回该月每天的签到情况（含补签标记），供前端日历展示与「点击补签」判断用。
 */
export async function getCheckinHistory(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const url = new URL(request.url)
  const defaultMonth = siteDayString(new Date(), await siteOffsetHours(env)).slice(0, 7)
  const month = url.searchParams.get("month") ?? defaultMonth
  if (!/^\d{4}-\d{2}$/.test(month)) throw new ApiError(400, "无效的月份", "INVALID_INPUT")

  const start = `${month}-01`
  const [y, m] = month.split("-").map(Number)
  const end = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`

  const rows = await env.DB.prepare(
    `SELECT checkin_date, points, is_makeup FROM daily_checkins
      WHERE user_id = ? AND checkin_date >= ? AND checkin_date < ?
      ORDER BY checkin_date ASC`
  )
    .bind(user.id, start, end)
    .all<{ checkin_date: string; points: number; is_makeup: number }>()

  const bal = await env.DB.prepare(
    `SELECT checkin_makeup_cards AS c FROM users WHERE id = ?`
  )
    .bind(user.id)
    .first<{ c: number }>()

  return json({
    month,
    today: siteDayString(new Date(), await siteOffsetHours(env)),
    makeupCards: Number(bal?.c ?? 0),
    days: (rows.results ?? []).map((r) => ({
      date: r.checkin_date,
      points: Number(r.points ?? 0),
      isMakeup: Number(r.is_makeup) === 1,
    })),
  })
}

/**
 * POST /api/checkin/auto —— 开关自动签到（开了之后进站会自动签一次）。
 */
export async function setAutoCheckin(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json().catch(() => ({}))) as { enabled?: unknown }
  const enabled = body.enabled === true || body.enabled === "1"
  await env.DB.prepare(
    `UPDATE users SET auto_checkin = ?, updated_at = ? WHERE id = ?`
  )
    .bind(enabled ? 1 : 0, new Date().toISOString(), user.id)
    .run()
  return json({ ok: true, autoCheckin: enabled })
}
