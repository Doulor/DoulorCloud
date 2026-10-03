/**
 * 签到配置的解析与归一化。
 *
 * ⚠️ **写入侧（管理端保存）与读取侧（签到接口）必须共用这一份。**
 * 两边各写一份 `split(",")` 的后果是「后台明明配了、签到就是不按那个发」，
 * 而且两处单看都「没错」—— 这类分家最难查（先例：`email-domains.ts`）。
 *
 * ── 为什么分隔符要收宽 ──
 * 里程碑在后台是个**多行输入框**，「一行一个」是站长最自然的写法。
 * 只按逗号切的话，整段会被当成**一个**条目（还可能解析失败被静默丢掉），
 * 表现为「配置看着填了，实际一个里程碑都不生效」。
 */

export interface CheckinMilestone {
  /** 连续签到的第几天（>= 1） */
  days: number
  /** 到这天时额外发放的积分（>= 1） */
  points: number
}

/** 一行里可能出现 `7:50`、`7=50`、`7 50`、`7：50`（全角冒号） */
const MILESTONE_RE = /^\s*(\d{1,5})\s*[:：=,，\s]\s*(\d{1,7})\s*$/

/**
 * 解析里程碑配置。
 *
 * 容错策略：**能认出来的条目尽量认，认不出的整条丢掉**，
 * 而不是「有一条不合法就整体失败」—— 站长在后台打字打到一半也会触发保存，
 * 那时候把已经填好的几条一起判死，体验很糟。
 */
export function parseCheckinMilestones(
  raw: string | null | undefined
): CheckinMilestone[] {
  if (!raw) return []
  const out: CheckinMilestone[] = []
  const seen = new Set<number>()
  // 换行 / 逗号 / 分号 / 顿号 / 全角标点都当分隔符
  for (const piece of String(raw).split(/[\n\r,;，；、]+/)) {
    const line = piece.trim()
    if (!line) continue
    const m = MILESTONE_RE.exec(line)
    if (!m) continue
    const days = Number(m[1])
    const points = Number(m[2])
    if (!Number.isFinite(days) || !Number.isFinite(points)) continue
    if (days < 1 || points < 1) continue
    // 同一天只保留第一次出现的，避免重复配置导致重复发分
    if (seen.has(days)) continue
    seen.add(days)
    out.push({ days, points })
  }
  // 按天数升序 —— 判断「命中哪个里程碑」依赖顺序
  return out.sort((a, b) => a.days - b.days)
}

/**
 * 归一化后写回（保存时用）：按天数升序、去重、统一成「一行一个」。
 * 存回规范形式，站长下次打开看到的就是整齐的列表。
 */
export function normalizeCheckinMilestones(raw: string | null | undefined): string {
  return parseCheckinMilestones(raw)
    .map((m) => `${m.days}:${m.points}`)
    .join("\n")
}

export interface CheckinRange {
  /** 基础奖励下限（含） */
  min: number
  /** 基础奖励上限（含）。等于 min 即固定奖励 */
  max: number
}

/**
 * 解析基础奖励区间。
 *
 * 两处兜底：非数字/负数一律按 0 处理；min > max 时**交换**而不是报错 ——
 * 站长手滑填反了，按「区间」的本意把它扶正比让他重填更合理。
 */
export function parseCheckinRange(
  minRaw: string | number | null | undefined,
  maxRaw: string | number | null | undefined
): CheckinRange {
  const toNum = (v: string | number | null | undefined): number => {
    const n = Math.floor(Number(v))
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  let min = toNum(minRaw)
  let max = toNum(maxRaw)
  if (min > max) [min, max] = [max, min]
  return { min, max }
}

/**
 * 找出连续签到天数命中的里程碑奖励。
 *
 * 规则：**只发「恰好等于当前连续天数」那一条**。
 *
 * 为什么不做成「所有 <= streak 的都补发」：那样漏签一天重来后，
 * 用户会在第 7 天一次性领到 7/30/100 三个里程碑（如果他之前连续够久），
 * 奖励总额变得不可预期，也不符合「连续达标才给」的直觉。
 */
export function milestoneBonusFor(
  streak: number,
  milestones: CheckinMilestone[]
): { days: number; points: number } | null {
  const hit = milestones.find((m) => m.days === streak)
  return hit ? { days: hit.days, points: hit.points } : null
}

/**
 * 距离下一个里程碑还差几天；没有下一个了返回 null。
 * 前端用它显示「再签 3 天可得 50 积分」。
 */
export function nextMilestone(
  streak: number,
  milestones: CheckinMilestone[]
): CheckinMilestone | null {
  return milestones.find((m) => m.days > streak) ?? null
}
