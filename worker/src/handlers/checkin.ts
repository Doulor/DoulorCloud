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
import { achievementPointsOf, loadHistoryLevels, loadUserCounts } from "./achievements"

/**
 * 自动签到的门槛：成就点数达到「名人」档（36 点）才解锁（2026-10-29 站长要求）。
 * 未达标时前端会提示「成就层级不够」，服务端也会拒绝开启。
 */
const AUTO_CHECKIN_MIN_POINTS = 36

async function userAchievementPoints(env: Env, userId: string): Promise<number> {
  const counts = await loadUserCounts(env, userId)
  const history = await loadHistoryLevels(env, userId)
  return achievementPointsOf(counts, history)
}
import {
  parseCheckinMilestones,
  parseCheckinRange,
  milestoneBonusFor,
  nextMilestone,
} from "../checkin-config"
import type { Env } from "../env"

/** 某个日期字符串往前 n 天（n >= 1） */
function dateStringBefore(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

/** 某个日期字符串的前一天 */
function prevDateString(dateStr: string): string {
  return dateStringBefore(dateStr, 1)
}

/**
 * 补签窗口：只能补**最近 7 天**里漏掉的签到（2026-11-04 站长要求）。
 *
 * 为什么必须有下界：补签的本意是「偶尔忘了一天，别让连续天数断掉」。
 * 不设下界的话，断签很久的账号可以攒一堆卡把过去全补上 —— 连续天数与
 * 里程碑奖励就变成**可以补票**的东西（等于用卡买里程碑），
 * 对每天老实签到的人也不公平。
 *
 * 口径：**含第 7 天**。今天是 11-04 时，10-28 ~ 11-03 这 7 天可补；
 * 10-27 及更早一律拒绝（错误码 MAKEUP_OUT_OF_WINDOW）。
 * 前端日历用同一个数字画「可点」的格子（由接口下发，别在两处各写一遍）。
 */
const MAKEUP_WINDOW_DAYS = 7

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
  /** 补签窗口（天）：只有最近这么多天内的漏签可以补（2026-11-04） */
  makeupWindowDays: number
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
  /** 当前成就点数（自动签到的门槛依据） */
  achievementPoints: number
  /** 是否已解锁自动签到（成就点数 ≥ autoCheckinNeeded） */
  autoCheckinUnlocked: boolean
  /** 解锁所需的成就点数（36 = 「名人」档） */
  autoCheckinNeeded: number
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
  const achPoints = await userAchievementPoints(env, user.id)
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
    // 补签窗口（天）：前端据此只点亮「最近 N 天」的漏签格
    makeupWindowDays: MAKEUP_WINDOW_DAYS,
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
    achievementPoints: achPoints,
    autoCheckinUnlocked: achPoints >= AUTO_CHECKIN_MIN_POINTS,
    autoCheckinNeeded: AUTO_CHECKIN_MIN_POINTS,
  } satisfies CheckinStatus)
}

/**
 * POST /api/checkin —— 签到。
 */
export async function doCheckin(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  return checkinForUser(env, user.id)
}

/**
 * 签到核心（2026-10-24 抽出）。
 *
 * 抽出来的原因：QQ 机器人的「按钮签到」也需要同一套逻辑，但那条路径没有站内
 * Request / 会话，只有 `qq_bindings` 换来的 user_id。**逻辑只能有一份** ——
 * 否则积分规则、连续天数、里程碑哪天改了必然漏一处。
 */
export async function checkinForUser(env: Env, userId: string): Promise<Response> {
  const enabled = await getSettingBool(env, "checkin_enabled")
  if (!enabled) throw new ApiError(403, "签到功能已关闭", "CHECKIN_DISABLED")

  const today = siteDayString(new Date(), await siteOffsetHours(env))

  // 防重复：主键兜底，这里先查一次给个友好提示（避免用户看到 500）
  const existing = await env.DB.prepare(
    `SELECT 1 FROM daily_checkins WHERE user_id = ? AND checkin_date = ?`
  )
    .bind(userId, today)
    .first()
  if (existing) throw new ApiError(409, "今天已经签过到了", "ALREADY_CHECKED_IN")

  // 连续天数：昨天签过 +1，否则重置为 1
  const yesterdayRow = await env.DB.prepare(
    `SELECT streak FROM daily_checkins WHERE user_id = ? AND checkin_date = ?`
  )
    .bind(userId, prevDateString(today))
    .first<{ streak: number }>()
  const streak = (yesterdayRow?.streak ?? 0) + 1

  // 奖励：基础区间随机 + 命中里程碑的额外奖励
  const { min, max } = parseCheckinRange(
    await getSettingNumber(env, "checkin_points_min"),
    await getSettingNumber(env, "checkin_points_max")
  )
  // 连续签到超过 30 天 → 当天奖励翻倍（2026-10-29 站长要求）
  const multiplier = streak > 30 ? 2 : 1
  const base = randInt(min, max) * multiplier
  const milestones = parseCheckinMilestones(await getSetting(env, "checkin_milestones"))
  const bonus = milestoneBonusFor(streak, milestones)
  const bonusPoints = (bonus?.points ?? 0) * multiplier
  const total = base + bonusPoints

  // 先加分（幂等），再写记录
  if (total > 0) {
    await applyPoints(env, {
      userId: userId,
      delta: total,
      reason: "checkin",
      detail: bonus
        ? `连续签到第 ${streak} 天：基础 ${base} + 里程碑 ${bonusPoints}`
        : `签到奖励（连续第 ${streak} 天）`,
      dedupKey: `checkin:${userId}:${today}`,
    })
  }
  await env.DB.prepare(
    `INSERT INTO daily_checkins (user_id, checkin_date, points, base_points, bonus_points, streak, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(userId, today, total, base, bonusPoints, streak, new Date().toISOString())
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
 * 补发「连续天数跳变时被跨过」的里程碑奖励（2026-11-03 用户反馈修复）。
 *
 * 事故：补签只改写连续天数、从来不发里程碑奖励 —— 而正常签到只匹配
 * 「**恰好等于**当前连续天数」那一条（设计说明见 checkin-config.ts）。
 * 于是「连续 29 天 → 第 30 天断签 → 补签卡补回 30 天」的人会看到里程碑 chip
 * 变绿（前端按 streak >= days 判定），但 220 积分永远不会到账：补签把天数
 * 直接推过 30，那条里程碑再也不会被「恰好命中」。
 *
 * 判据用「前一行的连续天数 → 这一行的连续天数」这个区间，而不是只看当前值：
 * 补签补的可能是**中间**某天，末尾的重算会把后面整条链一起抬高，跨过的每一个
 * 里程碑都得补（一次补多张卡时尤其明显）。
 *
 * 幂等靠 dedupKey 里的**日期**：`checkin-milestone:<用户>:<日期>:<天数>`。
 * 为什么不是只按「用户+天数」去重：补签反复改写同一条链时，同一行会被再次
 * 判定为「跨过 30 天」，但日期相同 ⇒ dedup 命中，不会重复发；而用户**另一段**
 * 连续签到重新爬到 30 天时日期不同，仍应照常发奖（与正常签到的口径一致）。
 */
async function grantCrossedMilestones(
  env: Env,
  userId: string,
  events: { date: string; prevStreak: number; streak: number }[],
  milestones: { days: number; points: number }[]
): Promise<{ days: number; points: number }[]> {
  const granted: { days: number; points: number }[] = []
  for (const ev of events) {
    const crossed = milestones.filter((m) => m.days > ev.prevStreak && m.days <= ev.streak)
    for (const m of crossed) {
      // 翻倍规则与正常签到一致：只有「这一天正好就是里程碑那天」且该行连续天数
      // 已超过 30 才吃 2 倍；跨过去补发的更早里程碑按原面额发。
      const multiplier = m.days === ev.streak && ev.streak > 30 ? 2 : 1
      const points = m.points * multiplier
      const res = await applyPoints(env, {
        userId,
        delta: points,
        reason: "checkin",
        detail: `补签补发里程碑（连续签到第 ${m.days} 天）`,
        dedupKey: `checkin-milestone:${userId}:${ev.date}:${m.days}`,
      })
      // 幂等命中（这一行这一天已经补发过）⇒ 什么都不做，别把账面再改一遍
      if (!res.applied) continue
      granted.push({ days: m.days, points })
      // 记账到那一天：签到日历里能看到「这天补发了里程碑」，否则用户只看到
      // 连续天数涨了、积分却对不上账。
      await env.DB.prepare(
        `UPDATE daily_checkins SET points = points + ?, bonus_points = bonus_points + ?
          WHERE user_id = ? AND checkin_date = ?`
      )
        .bind(points, points, userId, ev.date)
        .run()
    }
  }
  return granted
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

  // 且必须落在补签窗口内（最近 7 天）—— 允许无限往前补 = 里程牌可以补票
  const windowStart = dateStringBefore(today, MAKEUP_WINDOW_DAYS)
  if (target < windowStart) {
    throw new ApiError(
      400,
      `只能补签最近 ${MAKEUP_WINDOW_DAYS} 天内漏掉的签到（${windowStart} 之后）`,
      "MAKEUP_OUT_OF_WINDOW"
    )
  }

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
  /**
   * 连续天数「跳变」的每一处：补签那天 + 被重算抬高的后续每一天。
   * 补发里程碑就看这些区间（跨过哪几天就补哪天），见 grantCrossedMilestones。
   */
  const chainEvents: { date: string; prevStreak: number; streak: number }[] = [
    { date: target, prevStreak: dayBefore?.streak ?? 0, streak },
  ]
  for (const r of after.results ?? []) {
    const s = prevDateString(r.checkin_date) === prevDate ? prevStreak + 1 : 1
    await env.DB.prepare(
      `UPDATE daily_checkins SET streak = ? WHERE user_id = ? AND checkin_date = ?`
    )
      .bind(s, user.id, r.checkin_date)
      .run()
    chainEvents.push({ date: r.checkin_date, prevStreak, streak: s })
    prevDate = r.checkin_date
    prevStreak = s
  }

  // 补签把连续天数推过了里程碑 → 当天就该发的奖励补上（2026-11-03 用户反馈）
  const milestones = parseCheckinMilestones(await getSetting(env, "checkin_milestones"))
  const milestonesGranted = await grantCrossedMilestones(env, user.id, chainEvents, milestones)

  return json({
    ok: true,
    makeupDate: target,
    streak,
    makeupCards: claimed.checkin_makeup_cards,
    // 这次补签补发了哪些里程碑（前端用来提示「补发 220 积分」）
    milestonesGranted,
    grantedPoints: milestonesGranted.reduce((n, m) => n + m.points, 0),
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
    // 补签窗口（天）：日历据此判断哪些漏签日还能点（与后端校验同一口径）
    makeupWindowDays: MAKEUP_WINDOW_DAYS,
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
  if (enabled) {
    const points = await userAchievementPoints(env, user.id)
    if (points < AUTO_CHECKIN_MIN_POINTS) {
      throw new ApiError(
        403,
        `成就层级不够：自动签到需要达到「名人」（${AUTO_CHECKIN_MIN_POINTS} 成就点），你当前 ${points} 点`,
        "ACHIEVEMENT_TOO_LOW"
      )
    }
  }
  await env.DB.prepare(
    `UPDATE users SET auto_checkin = ?, updated_at = ? WHERE id = ?`
  )
    .bind(enabled ? 1 : 0, new Date().toISOString(), user.id)
    .run()
  return json({ ok: true, autoCheckin: enabled })
}
