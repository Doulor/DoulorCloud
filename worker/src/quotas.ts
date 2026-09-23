/**
 * 邀请码额度体系。
 *
 * 两套额度互相独立：
 *   * 邀请码额度 —— 能创建多少个邀请码（基础 3 个 + 每笔获批捐献 +2）
 *   * 模块额度   —— 能为邀请码授予多少个「进阶模块」权限
 *                  （每笔获批捐献，对应模块 +1）
 *
 * 基础权限（个人名片）不消耗模块额度；域名与邮箱本就不受限，无需授权。
 *
 * 额度只影响「能给邀请码授什么」，与 users.permissions（自己能用什么）无关。
 * 捐献获批时两者同时增加：自己解锁 + 获得可转授的额度。
 */
import { ApiError } from "./http"
import { getSettingNumber } from "./settings"
import type { Env } from "./env"

/** 需要消耗模块额度的功能（profile 是基础权限，不消耗） */
export const QUOTA_FEATURES = ["r2", "ai", "frp", "proxy"] as const
export type QuotaFeature = (typeof QUOTA_FEATURES)[number]

export const QUOTA_FEATURE_LABELS: Record<QuotaFeature, string> = {
  r2: "直链网盘",
  ai: "AI 中转站",
  frp: "内网穿透",
  proxy: "代理节点",
}

/** 每笔获批捐献赠送的邀请码额度 */
export const INVITE_BONUS_PER_DONATION = 2

export type FeatureCounts = Record<QuotaFeature, number>

function emptyCounts(): FeatureCounts {
  return { r2: 0, ai: 0, frp: 0, proxy: 0 }
}

/** 解析 JSON 计数；非法值按 0 处理（不信任历史数据） */
export function parseCounts(raw: string | null | undefined): FeatureCounts {
  const out = emptyCounts()
  if (!raw) return out
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed !== "object" || parsed === null) return out
    for (const f of QUOTA_FEATURES) {
      const v = Math.trunc(Number(parsed[f]))
      if (Number.isFinite(v) && v > 0) out[f] = v
    }
  } catch {
    // 损坏数据按 0 处理，宁可少算也不放行
  }
  return out
}

export interface UserQuota {
  /** 基础额度（来自全局设置） */
  inviteBase: number
  /** 捐献累计获得 */
  inviteBonus: number
  /** 合计可创建数 */
  inviteTotal: number
  /** 已用 */
  inviteUsed: number
  /** 剩余可创建数 */
  inviteRemaining: number
  /** 各模块累计获得 */
  featureQuota: FeatureCounts
  /** 各模块已消耗 */
  featureUsed: FeatureCounts
  /** 各模块剩余 */
  featureRemaining: FeatureCounts
}

interface QuotaRow {
  invite_quota_bonus: number | null
  invite_quota_used: number | null
  feature_quota: string | null
  feature_quota_used: string | null
}

export async function loadUserQuota(env: Env, userId: string): Promise<UserQuota> {
  const row = await env.DB.prepare(
    "SELECT invite_quota_bonus, invite_quota_used, feature_quota, feature_quota_used FROM users WHERE id = ?"
  )
    .bind(userId)
    .first<QuotaRow>()

  const inviteBase = await getSettingNumber(env, "invite_quota_base")
  const inviteBonus = Math.max(0, row?.invite_quota_bonus ?? 0)
  const inviteUsed = Math.max(0, row?.invite_quota_used ?? 0)
  const inviteTotal = inviteBase + inviteBonus

  const featureQuota = parseCounts(row?.feature_quota)
  const featureUsed = parseCounts(row?.feature_quota_used)
  const featureRemaining = emptyCounts()
  for (const f of QUOTA_FEATURES) {
    featureRemaining[f] = Math.max(0, featureQuota[f] - featureUsed[f])
  }

  return {
    inviteBase,
    inviteBonus,
    inviteTotal,
    inviteUsed,
    inviteRemaining: Math.max(0, inviteTotal - inviteUsed),
    featureQuota,
    featureUsed,
    featureRemaining,
  }
}

/**
 * 校验并消耗额度以创建邀请码。
 * 抽取成独立函数是为了让「校验 → 扣减」在一次调用里完成，
 * 避免调用方漏检或重复扣减。
 *
 * @param needs 本次创建需要的模块权限集合（来自 QUOTA_FEATURES）
 */
export async function consumeQuotaForInvite(
  env: Env,
  userId: string,
  needs: QuotaFeature[]
): Promise<void> {
  const quota = await loadUserQuota(env, userId)

  if (quota.inviteRemaining < 1) {
    throw new ApiError(
      400,
      `邀请码额度已用完（共 ${quota.inviteTotal} 个，已用 ${quota.inviteUsed} 个）。捐献资源可获得更多额度`,
      "INVITE_QUOTA_EXCEEDED"
    )
  }

  // 同一模块在同一码里只算一次（去重）
  const unique = [...new Set(needs)]
  for (const f of unique) {
    if (quota.featureRemaining[f] < 1) {
      throw new ApiError(
        400,
        `「${QUOTA_FEATURE_LABELS[f]}」权限额度不足。捐献该模块资源可获得额度`,
        "FEATURE_QUOTA_EXCEEDED"
      )
    }
  }

  const nextFeatureUsed = { ...quota.featureUsed }
  for (const f of unique) nextFeatureUsed[f] += 1

  await env.DB.prepare(
    "UPDATE users SET invite_quota_used = ?, feature_quota_used = ?, updated_at = ? WHERE id = ?"
  )
    .bind(
      quota.inviteUsed + 1,
      JSON.stringify(nextFeatureUsed),
      new Date().toISOString(),
      userId
    )
    .run()
}

/**
 * 退还额度（删除未使用的邀请码时调用）。
 * 只退还尚未被使用过的码，避免「建码 → 让人用掉 → 删码 → 再建」的循环刷额度。
 */
export async function refundQuotaForInvite(
  env: Env,
  userId: string,
  gaveFeatures: QuotaFeature[]
): Promise<void> {
  const quota = await loadUserQuota(env, userId)

  const nextFeatureUsed = { ...quota.featureUsed }
  for (const f of [...new Set(gaveFeatures)]) {
    nextFeatureUsed[f] = Math.max(0, nextFeatureUsed[f] - 1)
  }

  await env.DB.prepare(
    "UPDATE users SET invite_quota_used = ?, feature_quota_used = ?, updated_at = ? WHERE id = ?"
  )
    .bind(
      Math.max(0, quota.inviteUsed - 1),
      JSON.stringify(nextFeatureUsed),
      new Date().toISOString(),
      userId
    )
    .run()
}

/** 捐献获批时发放额度：+2 邀请码额度，+1 对应模块额度 */
export async function grantQuotaForDonation(
  env: Env,
  userId: string,
  feature: string
): Promise<void> {
  const quota = await loadUserQuota(env, userId)

  const nextQuota = { ...quota.featureQuota }
  if ((QUOTA_FEATURES as readonly string[]).includes(feature)) {
    nextQuota[feature as QuotaFeature] += 1
  }

  await env.DB.prepare(
    "UPDATE users SET invite_quota_bonus = ?, feature_quota = ?, updated_at = ? WHERE id = ?"
  )
    .bind(
      quota.inviteBonus + INVITE_BONUS_PER_DONATION,
      JSON.stringify(nextQuota),
      new Date().toISOString(),
      userId
    )
    .run()
}

/** 从邀请码的权限对象里取出消耗了模块额度的部分 */
export function quotaFeaturesOf(permissions: {
  [k: string]: boolean
}): QuotaFeature[] {
  return QUOTA_FEATURES.filter((f) => permissions[f] === true)
}

/**
 * 解析「基础权限」（app_settings.invite_basic_features，逗号分隔的模块名）。
 *
 * 语义（见 settings.ts 的 invite_basic_features 注释）：
 *   基础权限：创建邀请码时可直接勾选，**不消耗模块额度**；
 *   受限模式：需消耗对应模块额度（由捐献获批或管理员发放获得）。
 *   默认值 `"r2"` —— R2 由站长自持、无人能捐献，若纳入额度体系该额度永远为 0。
 *
 * ⚠️ 本函数是**补上的缺失实现**（2026-09-23 审计）：
 *   `handlers/admin.ts` 自提交 d524961 起就 `import { parseBasicFeatures } from "../quotas"`
 *   并把结果放进 `/admin/invite-quotas` 的响应里，但 quotas.ts 从未提供该函数 ——
 *   这导致 worker 端从那时起就无法通过类型检查。
 *   这里按调用点的契约实现（返回可迭代、可 `[...]` 展开的集合）。
 *   若「邀请码额度」方向的作者另有既定实现，请以其版本为准并替换本段。
 *
 * 容错：空值 / 非法值一律按「无基础权限」处理（宁严不宽 —— 不会白送额度）。
 */
export function parseBasicFeatures(
  raw: string | null | undefined
): Set<QuotaFeature> {
  const out = new Set<QuotaFeature>()
  if (!raw) return out
  for (const piece of String(raw).split(",")) {
    const name = piece.trim().toLowerCase()
    if ((QUOTA_FEATURES as readonly string[]).includes(name)) {
      out.add(name as QuotaFeature)
    }
  }
  return out
}
