/**
 * 邀请码额度体系。
 *
 * 两套额度互相独立：
 *   * 邀请码额度 —— 能创建多少个邀请码（基础 3 个 + 每笔获批捐献 +2）
 *   * 模块额度   —— 能为邀请码授予多少个「受限模块」权限
 *                  （每笔获批捐献，对应模块 +1）
 *
 * 模块可被管理员设为「基础权限」或「受限模式」（app_settings.invite_basic_features）：
 *   * 基础权限：创建邀请码时可直接勾选，**不消耗模块额度**。
 *   * 受限模式：需消耗对应模块额度（由捐献获批或管理员发放获得）。
 *
 * 额度只影响「能给邀请码授什么」，与 users.permissions（自己能用什么）无关。
 * 捐献获批时两者同时增加：自己解锁 + 获得可转授的额度。
 */
import { ApiError } from "./http"
import { getSetting, getSettingNumber } from "./settings"
import type { Env } from "./env"

/** 可被授予的模块（profile 恒为基础权限，不在此列；域名/邮箱无需授权） */
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

/** 解析 invite_basic_features（逗号分隔模块名）为布尔集合；非法值按默认「r2」处理 */
export function parseBasicFeatures(raw: string | undefined | null): Set<QuotaFeature> {
  const out = new Set<QuotaFeature>()
  for (const seg of String(raw ?? "r2").split(",")) {
    const f = seg.trim() as QuotaFeature
    if ((QUOTA_FEATURES as readonly string[]).includes(f)) out.add(f)
  }
  if (out.size === 0) out.add("r2")
  return out
}

/** 读取当前被设为「基础权限」的模块集合（每次调用读库，管理员改设置即时生效） */
export async function getBasicFeatures(env: Env): Promise<Set<QuotaFeature>> {
  const raw = await getSetting(env, "invite_basic_features")
  return parseBasicFeatures(raw)
}

/** 某模块当前是否为基础权限 */
export async function isBasicFeature(
  env: Env,
  feature: QuotaFeature
): Promise<boolean> {
  const basic = await getBasicFeatures(env)
  return basic.has(feature)
}

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
 * 基础权限模块**不消耗模块额度**（只消耗 1 个邀请码额度）。
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
  // 只对「受限模式」的模块校验并扣减模块额度
  const restricted: QuotaFeature[] = []
  for (const f of unique) {
    if (await isBasicFeature(env, f)) continue
    restricted.push(f)
    if (quota.featureRemaining[f] < 1) {
      throw new ApiError(
        400,
        `「${QUOTA_FEATURE_LABELS[f]}」权限额度不足。捐献该模块资源可获得额度`,
        "FEATURE_QUOTA_EXCEEDED"
      )
    }
  }

  const nextFeatureUsed = { ...quota.featureUsed }
  for (const f of restricted) nextFeatureUsed[f] += 1

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
 *
 * 基础权限模块创建时不消耗模块额度（feature_used 保持 0），这里一律退回——
 * 对基础模块最多减到 0，无害；但对「创建时受限、删除时已被改为基础」的码，
 * 依然能把当时消耗的额度退回来，不会让用户白掉额度。
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

/**
 * 捐献获批时发放额度：+2 邀请码额度。
 * 仅「受限模式」的模块再 +1 对应模块额度；基础权限模块本就人人都能授，无需转授额度。
 */
export async function grantQuotaForDonation(
  env: Env,
  userId: string,
  feature: string
): Promise<void> {
  const quota = await loadUserQuota(env, userId)

  const nextQuota = { ...quota.featureQuota }
  if (
    (QUOTA_FEATURES as readonly string[]).includes(feature) &&
    !(await isBasicFeature(env, feature as QuotaFeature))
  ) {
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

/**
 * 从邀请码的权限对象里取出涉及模块额度的部分（权限为 true 的 QUOTA_FEATURES）。
 * 注意：这里不过滤基础权限模块——是否该退还由调用方配合当前设置判断
 * （见 refundQuotaForInvite 内的 getBasicFeatures 过滤）。
 */
export function quotaFeaturesOf(permissions: {
  [k: string]: boolean
}): QuotaFeature[] {
  return QUOTA_FEATURES.filter((f) => permissions[f] === true)
}
