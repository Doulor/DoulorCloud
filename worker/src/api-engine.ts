/**
 * 公开 API 的核心引擎：成就点 → 层级 → 限额。
 *
 * ── 限额模型（站长确认过口径）──
 * · **账号维度**：每日限额按**成就点层级**分，每 10 点一层（0-9 = 层级 0，10-19 = 层级 1…），
 *   每层一个值，管理面板可配（存 `api_config.tier_limits` JSON 数组）。
 * · **IP 维度**：每日一个**固定值**（IP 没有成就点，所以不分层），存 `api_config.ip_limit`。
 * · 一次调用**同时**扣两个池子，**任一耗尽即拒绝**（双重防滥用）。
 *
 * ── 层级封顶 ──
 * 层级 = min(floor(成就点 / 10), tier_limits 长度 - 1)。超过数组长度的都按最后一层算，
 * 所以「封顶」不是硬编码的，配几层就是几层。
 */
import { ApiError } from "./http"
import { loadUserCounts, achievementPointsOf } from "./handlers/achievements"
import type { Env } from "./env"

/** 成就点每多少点升一层 */
export const POINTS_PER_TIER = 10
/** 全局层级封顶：成就点 >= 100（10 层）都按第 10 层算 */
export const MAX_TIER = 10

export interface ApiFeatureConfig {
  feature: string
  enabled: boolean
  /** 账号维度各层级每日限额，索引 = 层级 */
  tierLimits: number[]
  /** IP 维度每日限额（0 = 不限） */
  ipLimit: number
}

/** 读某个功能的 API 配置 */
export async function getApiFeatureConfig(
  env: Env,
  feature: string
): Promise<ApiFeatureConfig | null> {
  const row = await env.DB.prepare(
    `SELECT enabled, tier_limits, ip_limit FROM api_config WHERE feature = ?`
  )
    .bind(feature)
    .first<{ enabled: number; tier_limits: string; ip_limit: number }>()
  if (!row) return null

  let tierLimits: number[] = []
  try {
    const parsed = JSON.parse(row.tier_limits)
    if (Array.isArray(parsed)) {
      tierLimits = parsed
        .map((v) => Math.max(0, Math.floor(Number(v)) || 0))
        .slice(0, 32) // 兜底：层级数不可能超过 32，防脏数据撑爆
    }
  } catch {
    tierLimits = []
  }
  return {
    feature,
    enabled: row.enabled === 1,
    tierLimits,
    ipLimit: Math.max(0, Math.floor(row.ip_limit) || 0),
  }
}

/** 读全部功能配置（管理面板 / 设置页文档用） */
export async function listApiFeatures(env: Env): Promise<ApiFeatureConfig[]> {
  const rows = await env.DB.prepare(
    `SELECT feature, enabled, tier_limits, ip_limit FROM api_config ORDER BY feature`
  ).all<{ feature: string; enabled: number; tier_limits: string; ip_limit: number }>()
  const out: ApiFeatureConfig[] = []
  for (const r of rows.results ?? []) {
    let tierLimits: number[] = []
    try {
      const parsed = JSON.parse(r.tier_limits)
      if (Array.isArray(parsed)) tierLimits = parsed.map((v) => Math.max(0, Math.floor(Number(v)) || 0))
    } catch {
      tierLimits = []
    }
    out.push({
      feature: r.feature,
      enabled: r.enabled === 1,
      tierLimits,
      ipLimit: Math.max(0, Math.floor(r.ip_limit) || 0),
    })
  }
  return out
}

/**
 * 查某用户的成就点数（含历史等级合并）。
 *
 * 成就是**实时计算、不落库**的，所以这里每次调用都现查：
 * `loadUserCounts`（26 个计数）+ `user_achievements` 表的历史最高等级，
 * 再交给 `achievementPointsOf` 合成。与成就页/排行榜共用同一套，保证口径一致。
 */
export async function getUserAchievementPoints(env: Env, userId: string): Promise<number> {
  const counts = await loadUserCounts(env, userId)
  const rows = await env.DB.prepare(
    `SELECT achievement_id, level FROM user_achievements WHERE user_id = ?`
  )
    .bind(userId)
    .all<{ achievement_id: string; level: number }>()
  const history = new Map<string, number>()
  for (const r of rows.results ?? []) {
    history.set(r.achievement_id, Math.max(history.get(r.achievement_id) ?? 0, r.level))
  }
  return achievementPointsOf(counts, history)
}

/** 成就点 → 全局层级（0 起，每 10 点一层，封顶 MAX_TIER） */
export function tierFor(points: number): number {
  return Math.min(Math.floor(points / POINTS_PER_TIER), MAX_TIER)
}

/** 账号维度：某层级对应的每日限额（超数组长度按最后一层） */
export function accountLimitFor(tier: number, tierLimits: number[]): number {
  if (tierLimits.length === 0) return 0
  return tierLimits[Math.min(tier, tierLimits.length - 1)] ?? 0
}

/** 站点时区的「今天」（YYYY-MM-DD），与签到同口径 */
export function apiDateString(d: Date = new Date()): string {
  const shifted = new Date(d.getTime() + 8 * 60 * 60 * 1000)
  return shifted.toISOString().slice(0, 10)
}

export interface LimitCheck {
  tier: number
  accountLimit: number
  ipLimit: number
}

/**
 * 限额闸门：**先原子累加、再判断是否超限**。
 *
 * 顺序不能反过来（先查后加）：并发下两个请求会同时看到「还没超」，
 * 然后一起放行。用 `INSERT ... ON CONFLICT DO UPDATE SET count = count + 1
 * RETURNING count` 原子累加，拿到的是「本次请求计入之后的计数」，
 * 超限的那次被拒，之后的每次也都超 —— 不会漏拦。
 *
 * 超限抛 429，带 code=QUOTA_EXCEEDED，前端/调用方能据此区分。
 */
export async function enforceApiLimit(
  env: Env,
  opts: {
    userId: string
    ip: string
    feature: string
    config: ApiFeatureConfig
  }
): Promise<LimitCheck> {
  const { userId, ip, feature, config } = opts
  const date = apiDateString()
  const points = await getUserAchievementPoints(env, userId)
  const tier = tierFor(points)
  const accountLimit = accountLimitFor(tier, config.tierLimits)

  // 账号维度：原子累加
  const acc = await env.DB.prepare(
    `INSERT INTO api_usage_account (user_id, feature, date, count)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(user_id, feature, date) DO UPDATE SET count = count + 1
     RETURNING count`
  )
    .bind(userId, feature, date)
    .first<{ count: number }>()
  if ((acc?.count ?? 1) > accountLimit) {
    throw new ApiError(429, "API 额度已用尽，请明天再试", "QUOTA_EXCEEDED")
  }

  // IP 维度：原子累加（ip_limit = 0 表示不限）
  if (config.ipLimit > 0) {
    const ipRow = await env.DB.prepare(
      `INSERT INTO api_usage_ip (ip, feature, date, count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(ip, feature, date) DO UPDATE SET count = count + 1
       RETURNING count`
    )
      .bind(ip, feature, date)
      .first<{ count: number }>()
    if ((ipRow?.count ?? 1) > config.ipLimit) {
      throw new ApiError(429, "当前网络 API 额度已用尽，请稍后再试", "IP_QUOTA_EXCEEDED")
    }
  }

  return { tier, accountLimit, ipLimit: config.ipLimit }
}
