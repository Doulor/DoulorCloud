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

/**
 * 解析 invite_basic_features（逗号分隔模块名）为布尔集合。
 *
 * ⚠️ 这里必须区分「设置项没配」和「显式配成空」：
 *   - `null` / `undefined`（设置项真的缺失）→ 回落到默认的 `r2`
 *   - **空串（管理员把开关全关掉后保存）→ 空集合**，即全部按受限模式
 *
 * 曾经的写法是 `String(raw ?? "r2")` 再在末尾 `if (out.size === 0) out.add("r2")`，
 * 于是空串和缺失走了同一条路 —— **空串被强行塞回 r2**。
 * 表现为：管理面板里「直链网盘」的开关无论怎么关，创建邀请码时它都显示
 * 「基础权限 · 不消耗额度」。存库其实是正确的（值就是 ""），错在读取这一步。
 *
 * 除 null/undefined 外一律**按字面解析**：库里存什么就是什么，
 * 认不出的名字直接丢掉（写入口 admin.updateSettingsHandler 已校验过名字）。
 * 不再对「非空但认不出」做特殊兜底 —— 那种「猜用户意图」的兜底正是上面这个
 * bug 的来源：任何兜底都会让某个开关变得关不掉。
 */
export function parseBasicFeatures(raw: string | undefined | null): Set<QuotaFeature> {
  if (raw === null || raw === undefined) return new Set<QuotaFeature>(["r2"])

  const out = new Set<QuotaFeature>()
  for (const seg of raw.split(",")) {
    const f = seg.trim() as QuotaFeature
    if ((QUOTA_FEATURES as readonly string[]).includes(f)) out.add(f)
  }
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
 * `feature_quota_used` / `feature_quota` 的「安全 JSON 读写」SQL 表达式。
 *
 * 为什么不能直接写 `json_set(feature_quota_used, …)`：
 *   1. 这两列**可空**（`0021_invite_quotas.sql:21,23` 都没有 NOT NULL），
 *      而 `json_set(NULL, …)` 的结果是 **NULL** —— 等于把整个计数抹掉；
 *   2. 历史数据里可能存在 `parseCounts()` 特意容错的那种损坏 JSON，
 *      而 `json_extract` 遇到它**直接抛错**，会把请求打成 500。
 *
 * 所以统一先过 `json_valid` 兜底成 `{}`，与 `parseCounts()` 的「宁可少算」口径一致。
 */
const FEATURE_USED_JSON =
  "CASE WHEN json_valid(feature_quota_used) THEN feature_quota_used ELSE '{}' END"
const FEATURE_QUOTA_JSON =
  "CASE WHEN json_valid(feature_quota) THEN feature_quota ELSE '{}' END"

/**
 * 校验并消耗额度以创建邀请码。
 *
 * ⚠️ 2026-09-25 审计（M1，旧 P2-5）：原实现是典型的**读-改-写**——
 * `loadUserQuota()` 读出 `invite_quota_used`，在 JS 里 `+1`，再写回**绝对值**。
 * 并发两次建码时两个请求都读到 0、都判定「还有额度」、都写回 1：
 * 结果**建出 2 个码却只扣了 1 个额度**，模块额度同理。
 * （邀请码的**消费**侧早就用条件 UPDATE 做对了，额度记账一直没对齐。）
 *
 * 修法与 P0-5 同一套路：把「校验 + 扣减」压进**一条** UPDATE。
 * 单条 SQL 在 SQLite 里是原子的，守卫条件（`used < total`）在 WHERE 里求值，
 * 所以并发时只有一个请求能改到行，另一个拿到 `changes === 0`。
 *
 * 为什么把邀请码额度与全部模块额度放进**同一条**语句：
 * 分多条就会有「邀请码额度扣了、模块额度不够」的半成品状态，
 * 而回滚已经改掉的计数很容易写错。一条语句要么全成、要么全不动。
 *
 * @param needs 本次创建需要的模块权限集合（来自 QUOTA_FEATURES）
 */
export async function consumeQuotaForInvite(
  env: Env,
  userId: string,
  needs: QuotaFeature[]
): Promise<void> {
  const quota = await loadUserQuota(env, userId)

  // 同一模块在同一码里只算一次（去重）
  const unique = [...new Set(needs)]
  // 只对「受限模式」的模块校验并扣减模块额度
  const restricted: QuotaFeature[] = []
  for (const f of unique) {
    if (await isBasicFeature(env, f)) continue
    restricted.push(f)
  }

  // 先做无副作用的预检，好让正常路径（非并发）给出精确的错误信息。
  // 真正的把关在下面的原子 UPDATE —— 预检只是为了消息好看。
  if (quota.inviteRemaining < 1) throw inviteQuotaError(quota)
  for (const f of restricted) {
    if (quota.featureRemaining[f] < 1) throw featureQuotaError(f)
  }

  let jsonExpr = FEATURE_USED_JSON
  const guards = ["COALESCE(invite_quota_used, 0) < ?"]
  const guardBinds: unknown[] = [quota.inviteTotal]
  for (const f of restricted) {
    jsonExpr = `json_set(${jsonExpr}, '$.${f}', COALESCE(json_extract(${jsonExpr}, '$.${f}'), 0) + 1)`
    // 守卫一律读**原始列**（SQLite 的 WHERE 在 SET 之前求值），保证是「扣减前」的值
    guards.push(`COALESCE(json_extract(${FEATURE_USED_JSON}, '$.${f}'), 0) < ?`)
    guardBinds.push(quota.featureQuota[f])
  }

  const res = await env.DB.prepare(
    `UPDATE users
        SET invite_quota_used = COALESCE(invite_quota_used, 0) + 1,
            feature_quota_used = ${jsonExpr},
            updated_at = ?
      WHERE id = ? AND ${guards.join(" AND ")}`
  )
    .bind(new Date().toISOString(), userId, ...guardBinds)
    .run()

  if ((res.meta?.changes ?? 0) === 0) {
    // 守卫没过。可能是并发时别人先扣掉了，也可能是用户行不存在。
    // 重新读一次，给出准确原因（错误路径不追求性能）。
    const fresh = await loadUserQuota(env, userId)
    if (fresh.inviteRemaining < 1) throw inviteQuotaError(fresh)
    for (const f of restricted) {
      if (fresh.featureRemaining[f] < 1) throw featureQuotaError(f)
    }
    throw new ApiError(404, "用户不存在", "NOT_FOUND")
  }
}

function inviteQuotaError(quota: UserQuota): ApiError {
  return new ApiError(
    400,
    `邀请码额度已用完（共 ${quota.inviteTotal} 个，已用 ${quota.inviteUsed} 个）。捐献资源可获得更多额度`,
    "INVITE_QUOTA_EXCEEDED"
  )
}

function featureQuotaError(f: QuotaFeature): ApiError {
  return new ApiError(
    400,
    `「${QUOTA_FEATURE_LABELS[f]}」权限额度不足。捐献该模块资源可获得额度`,
    "FEATURE_QUOTA_EXCEEDED"
  )
}

/**
 * 退还额度（删除未使用的邀请码时调用）。
 * 只退还尚未被使用过的码，避免「建码 → 让人用掉 → 删码 → 再建」的循环刷额度。
 *
 * 基础权限模块创建时不消耗模块额度（feature_used 保持 0），这里一律退回——
 * 对基础模块最多减到 0，无害；但对「创建时受限、删除时已被改为基础」的码，
 * 依然能把当时消耗的额度退回来，不会让用户白掉额度。
 *
 * ⚠️ 同样按 M1 改为**相对扣减**（`MAX(0, used - 1)`）：原实现写绝对值，
 * 会把并发发生的扣减/发放整个覆盖掉。
 */
export async function refundQuotaForInvite(
  env: Env,
  userId: string,
  gaveFeatures: QuotaFeature[]
): Promise<void> {
  let jsonExpr = FEATURE_USED_JSON
  for (const f of [...new Set(gaveFeatures)]) {
    jsonExpr = `json_set(${jsonExpr}, '$.${f}', MAX(0, COALESCE(json_extract(${jsonExpr}, '$.${f}'), 0) - 1))`
  }

  await env.DB.prepare(
    `UPDATE users
        SET invite_quota_used = MAX(0, COALESCE(invite_quota_used, 0) - 1),
            feature_quota_used = ${jsonExpr},
            updated_at = ?
      WHERE id = ?`
  )
    .bind(new Date().toISOString(), userId)
    .run()
}

/**
 * 解析 `donation_transfer_features`（逗号分隔模块名）为集合。
 *
 * 语义与 `parseBasicFeatures` / `first_donation_voucher_features` 同一套，
 * 三条都不许搞混（这是本文件反复出现的坑）：
 *   · 缺省（键不存在 / null）→ **四个模块全可发**（维持原行为）；
 *   · **空串（四个开关全关后保存）→ 空集合**，即一个都不发；
 *   · 认不出的名字直接丢掉。
 */
export function parseDonationQuotaFeatures(
  raw: string | null | undefined
): Set<QuotaFeature> {
  if (raw === null || raw === undefined) return new Set<QuotaFeature>(QUOTA_FEATURES)
  const out = new Set<QuotaFeature>()
  for (const seg of raw.split(",")) {
    const f = seg.trim() as QuotaFeature
    if ((QUOTA_FEATURES as readonly string[]).includes(f)) out.add(f)
  }
  return out
}

/**
 * 捐献获批时发放额度：+2 邀请码额度。
 * 仅「受限模式」的模块再 +1 对应模块额度；基础权限模块本就人人都能授，无需转授额度。
 *
 * ⚠️ 2026-10-08 新增设置项 `donation_transfer_features`（默认四个模块全发）：
 * 站长要能**逐模块**停掉「捐献换出可转授额度」这条路 —— 否则用户捐一个 AI 渠道
 * 就拿到 +1 的 ai 额度，再把它做成邀请码直接给别人开通中转站。
 * 关掉某模块后：该模块不再 +1；其余模块照发。
 *
 * 刻意**只停模块额度**、不停 +2 邀请码额度：后者是通用的「能建几个码」，
 * 与「转授某个模块」是两件事（且模块额度一停，就算有码也勾不上那些模块）。
 * 已经在手上的额度不回收，只影响之后新批的捐献。
 *
 * ⚠️ 同样按 M1 改为**相对累加**，不再先读后写：
 * 原实现下「发放」与「消费」并发时，谁后写谁的结果生效，
 * 会静默丢掉另一次计数（管理员批了一笔捐献，用户却看不到额度增加）。
 */
export async function grantQuotaForDonation(
  env: Env,
  userId: string,
  feature: string
): Promise<void> {
  const isQuotaFeature = (QUOTA_FEATURES as readonly string[]).includes(feature)
  // 该模块是否允许发放「可转授额度」（管理员可逐模块关闭）
  const allowed = parseDonationQuotaFeatures(
    await getSetting(env, "donation_transfer_features")
  )

  let quotaExpr = FEATURE_QUOTA_JSON
  if (
    isQuotaFeature &&
    allowed.has(feature as QuotaFeature) &&
    !(await isBasicFeature(env, feature as QuotaFeature))
  ) {
    const f = feature as QuotaFeature
    quotaExpr = `json_set(${quotaExpr}, '$.${f}', COALESCE(json_extract(${quotaExpr}, '$.${f}'), 0) + 1)`
  }

  await env.DB.prepare(
    `UPDATE users
        SET invite_quota_bonus = COALESCE(invite_quota_bonus, 0) + ?,
            feature_quota = ${quotaExpr},
            updated_at = ?
      WHERE id = ?`
  )
    .bind(INVITE_BONUS_PER_DONATION, new Date().toISOString(), userId)
    .run()
}

/**
 * ⚠️ 2026-09-25 审计（L25）：这里原先有一个
 *   `quotaFeaturesOf(permissions: { [k: string]: boolean }): QuotaFeature[]`
 * 已**删除**。它是 L25 那个 bug 的直接入口：签名要求调用方先拿到一个
 * 「权限对象」，而唯一的拿法就是 `parsePermissions(row.permissions)` ——
 * 偏偏 `parsePermissions(null)` 的语义是「**全开**」（为兼容老用户，
 * 见 permissions.ts:10），于是删掉一个 `permissions` 为 NULL 的历史邀请码
 * 会一次退还全部 4 个模块额度，「建码 → 删码」循环即可凭空刷额度。
 *
 * 两个调用点（my-invites.ts、handlers/admin.ts）都已改用下面这个
 * 直接吃**库里原始文本**的版本。把它删掉而不是留着，是为了让
 * 「先 parsePermissions 再取特征」这条错路在类型层面就走不通 ——
 * 留着它，下一个人还会照着旧代码写回去。
 */

/**
 * 从**库里存的原始 JSON 文本**解析出该邀请码实际消耗过额度的模块。
 *
 * ⚠️ 2026-09-25 审计（L25）：退还额度的调用点原先写的是
 * `quotaFeaturesOf(parsePermissions(row.permissions))`，而
 * `parsePermissions(null)` 的语义是「**全开**」（为了兼容老用户，见 permissions.ts:10）。
 * 于是删掉一个 `permissions` 为 NULL 的历史邀请码会**一次退还全部 4 个模块额度** ——
 * 「建码 → 删码」循环就能凭空刷出模块额度。
 *
 * 退还方向必须**保守**：只有明确写着 `true` 的才算消耗过。
 * NULL / 空串 / 损坏 JSON 一律按「没消耗过任何模块额度」处理（只退 1 个邀请码额度）。
 */
export function quotaFeaturesFromStored(
  raw: string | null | undefined
): QuotaFeature[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed !== "object" || parsed === null) return []
    return QUOTA_FEATURES.filter((f) => parsed[f] === true)
  } catch {
    return []
  }
}
