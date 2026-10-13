/**
 * 自动签到的**判定内核**（纯函数）。
 *
 * 抽出来是为了能被断言脚本直接覆盖 —— 这里承载的正是「自动签到为什么不生效」
 * 的修复要点：**按站点日期判定，而不是按会话**。
 *
 * 历史（修复前）：守卫是 `sessionStorage["auto-checkin-ran"] = "1"`，
 * 一个不含日期的布尔标记。sessionStorage 会随标签页 / PWA / App 内 WebView
 * 的存活期一直留着，于是页面开着过夜、或开关是本次会话中途才打开时，
 * 自动签到永远不会触发。改成记「站点时区的今天」后，跨天自然重新判定。
 */

/** 判定所需的签到状态（对应 GET /api/checkin 的返回子集） */
export interface AutoCheckinStatus {
  enabled: boolean
  /** 站点时区下的今天（YYYY-MM-DD）；老版本服务端可能缺省 */
  today: string
  checkedIn: boolean
  autoCheckin: boolean
}

export type AutoCheckinDecision =
  /** 无事可做，且**不写**「今天已处理」标记（功能关闭 / 未开自动签到） */
  | { kind: "skip" }
  /** 今天已经尘埃落定（已签 / 今天已处理过），记下标记即可，不再发签到请求 */
  | { kind: "done" }
  /** 今天还没签，需要发一次签到请求 */
  | { kind: "checkin" }

/**
 * 决定这次自动检查该做什么。
 *
 * @param status    GET /api/checkin 的结果
 * @param storedDay 本地记录的「已处理过的站点日期」（无则 null）
 */
export function decideAutoCheckin(
  status: AutoCheckinStatus,
  storedDay: string | null
): AutoCheckinDecision {
  // 功能开关没开 / 用户没开自动签到：不写标记 —— 用户当天中途开启后，下一次触发即可生效
  if (!status.enabled || !status.autoCheckin) return { kind: "skip" }
  // 今天已经处理过（这次会话里跑过，或跨会话仍是同一天）：不再重复打接口
  if (status.today && storedDay === status.today) return { kind: "done" }
  // 今天已经签过（手动或更早的自动）
  if (status.checkedIn) return { kind: "done" }
  return { kind: "checkin" }
}

/** 一次签到尝试的结果 */
export type CheckinAttempt = "success" | "already" | "error"

/**
 * 签到尝试之后，**该不该**把「今天已处理」标记写下去。
 *
 * 只有「今天已经尘埃落定」才写：成功、或别处已签（并发竞态）。
 * 失败（网络抖动、邮箱未验证被拦…）不写 —— 留待下次触发重试，
 * 而不是像修复前那样把整段会话一次性烧掉。
 */
export function shouldMarkAfterAttempt(attempt: CheckinAttempt): boolean {
  return attempt !== "error"
}

/**
 * 用户刚**打开**自动签到开关时，要不要立刻补签今天？
 *
 * 要（且今天还没签）：否则用户看不到任何即时反馈，会以为「开了没反应」，
 * 得等到下一次触发（跨天 / 回到前台）才生效。
 */
export function shouldSignInOnEnable(
  enabled: boolean,
  status: { checkedIn: boolean } | null
): boolean {
  return enabled && status !== null && !status.checkedIn
}
