/**
 * 活动奖励 / 参与条件的注册表。
 *
 * 为什么要注册表而不是「配置器」：奖励发放必然要碰具体业务（中转站额度、
 * 邀请码额度、将来的货币系统），纯配置表达不了。做成
 * `REWARD_HANDLERS[type]` 之后，加一种新活动奖励 = 在下面加一项 handler，
 * 管理面板的选项和校验会自动跟上（选项列表由 REWARD_TYPES 派生）。
 *
 * 幂等由调用方（handlers/events.ts）保证：event_claims 的 (event_id, user_id)
 * 唯一索引 + INSERT OR IGNORE 就是并发锁，handler 本身不需要再判重。
 */
import { parsePermissions, hasFeature, FEATURES, type Feature } from "./permissions"
import { adminSetQuota, getCurrencyInfo } from "./newapi-client"
import { getSetting } from "./settings"
import { applyPoints } from "./points"
import type { Env } from "./env"

// ---- 奖励 ----

export const REWARD_TYPES = ["none", "newapi_quota", "invite_quota", "points"] as const
export type RewardType = (typeof REWARD_TYPES)[number]

export interface RewardResult {
  /** granted = 已自动发放；manual = 需管理员手动发；failed = 发放失败 */
  status: "granted" | "manual" | "failed"
  detail: string
}

export interface RewardContext {
  env: Env
  userId: string
  username: string
  /** reward_params 解析出的对象 */
  params: Record<string, unknown>
  eventId: string
}

export type RewardHandler = (ctx: RewardContext) => Promise<RewardResult>

function readAmount(params: Record<string, unknown>, key: string, fallback: number): number {
  const n = Number(params[key])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

export const REWARD_HANDLERS: Record<RewardType, RewardHandler> = {
  none: async () => ({
    status: "manual",
    detail: "该活动不自动发放奖励，请联系管理员领取。",
  }),

  /**
   * 给用户的中转站账号发放钱包余额（活动奖励）。
   * 用户没绑定中转站账号时无法自动发放 —— 返回 manual，让管理员在
   * 领取名单里看到并人工处理（而不是静默失败）。
   *
   * ⚠️ **单位换算（2026-09-28 修复）**：活动表单里填的 `amount` 是「元」
   * （站长看中转站后台，余额显示的就是元），而 NewAPI 的 `add_quota` 吃的是
   * **原始额度单位**（`newapi_quota_per_unit`，线上为 500000 ⇒ 1 元 = 500000）。
   * 少了这一步换算，「+500」实际只加了 500 原始额度 = ¥0.001，用户端余额
   * 从 ¥100,000,000.000 变 ¥100,000,000.001，界面上完全看不出来 ——
   * tianya 报「领的 500 余额没到账」就是这个原因。
   */
  newapi_quota: async ({ env, userId, params }) => {
    const amount = readAmount(params, "amount", 0)
    if (amount <= 0) return { status: "failed", detail: "活动配置的金额无效。" }

    const account = await env.DB.prepare(
      "SELECT newapi_user_id FROM newapi_accounts WHERE user_id = ?"
    )
      .bind(userId)
      .first<{ newapi_user_id: number }>()
    if (!account?.newapi_user_id) {
      return {
        status: "manual",
        detail: `你还未开通 AI 中转站，无法自动发放 ${amount} 钱包余额，请联系管理员。`,
      }
    }

    // 元 → NewAPI 原始额度。perUnit 读不到时回落 500000（与 SETTING_DEFAULTS 一致）。
    const perUnit = Number(await getSetting(env, "newapi_quota_per_unit")) || 500_000
    const rawQuota = Math.round(amount * perUnit)

    await adminSetQuota(env, account.newapi_user_id, rawQuota, "add")
    // 币种符号跟随中转站设置（本实例为 ¥），避免只写「500」让用户分不清是多少钱
    const { symbol } = await getCurrencyInfo(env)
    return {
      status: "granted",
      detail: `已为你的中转站账号增加 ${symbol}${amount} 余额。`,
    }
  },

  /**
   * 加「邀请码创建额度」。
   * 只动 invite_quota_bonus，不碰 feature_quota —— 后者是「某模块的转授额度」，
   * 与捐献语义绑定，活动奖励不该悄悄改变它。
   */
  invite_quota: async ({ env, userId, params }) => {
    const count = readAmount(params, "count", 2)
    await env.DB.prepare(
      `UPDATE users
          SET invite_quota_bonus = COALESCE(invite_quota_bonus, 0) + ?,
              updated_at = ?
        WHERE id = ?`
    )
      .bind(count, new Date().toISOString(), userId)
      .run()
    return { status: "granted", detail: `已获得 ${count} 个邀请码创建额度。` }
  },

  /**
   * 发积分（`amount` = 积分数，非金额）。
   *
   * 与 newapi_quota 的区别：那个直接给中转站钱包加钱、必须先绑定中转站账号；
   * 这个只是记账，**任何用户都能拿到**（没绑中转站的也能先攒着，等开通后再兑换）。
   *
   * 幂等：dedup_key 用 `event:<eventId>`。这是**双保险** —— event_claims 的
   * (event_id, user_id) 唯一索引已经拦住了重复领取；这里再挡一层，是为了
   * 「活动奖励类型被改成积分、旧 claim 触发重试」这类边界情况不会重复发放。
   */
  points: async ({ env, userId, params, eventId }) => {
    const amount = readAmount(params, "amount", 0)
    if (amount <= 0) return { status: "failed", detail: "活动配置的积分数无效。" }
    const res = await applyPoints(env, {
      userId,
      delta: amount,
      reason: "event",
      detail: `活动奖励：${amount} 积分`,
      dedupKey: `event:${eventId}`,
    })
    if (!res.applied) {
      // 幂等命中：说明这一份之前已经发过了，对用户而言仍是「已获得」
      return { status: "granted", detail: `你已获得过本活动的 ${amount} 积分。` }
    }
    return { status: "granted", detail: `已获得 ${amount} 积分，当前余额 ${res.balance}。` }
  },
}

// ---- 领取前置条件 ----

/**
 * 领取前的硬前置条件：不满足则**直接拒绝领取**（而不是领了却发不出）。
 *
 * 为什么要有这层：`newapi_quota` 奖励在用户未开通中转站时无法自动到账，
 * 原先是落一条 `manual` 记录让管理员手动补 —— 但用户的「一次性领取机会」
 * 已经用掉了，管理员一疏忽就等于白领（用户来找、还得人工核）。
 * 改成「没开通就不让领」后，用户开通中转站再回来领即可，不浪费机会，
 * 也免掉管理员的手工补发。
 *
 * 返回 `null` = 可领取；返回字符串 = 拒绝原因（原样回给用户）。
 */
export type RewardPrecondition = (env: Env, userId: string) => Promise<string | null>

export const REWARD_PRECONDITIONS: Record<RewardType, RewardPrecondition> = {
  none: async () => null,

  /**
   * 中转站额度：必须先开通中转站（存在 newapi_accounts.newapi_user_id）。
   * 判据与上面 newapi_quota handler 完全一致 —— 两处不一致会出现
   * 「准入放行但发放又判未开通」的自相矛盾。
   */
  newapi_quota: async (env, userId) => {
    const account = await env.DB.prepare(
      "SELECT newapi_user_id FROM newapi_accounts WHERE user_id = ?"
    )
      .bind(userId)
      .first<{ newapi_user_id: number | null }>()
    if (!account?.newapi_user_id) {
      return "你还未开通 AI 中转站，请先在「AI 中转站」页开通后再来领取该奖励。"
    }
    return null
  },

  invite_quota: async () => null,

  /**
   * 积分：无前置条件 —— 与上面的 `points` handler 语义一致（只是记账，
   * 任何用户都能拿到，没绑中转站的也能先攒着，等开通后再兑换）。
   * 注意别在这里加「需先开通中转站」：那会与 handler 的注释自相矛盾。
   */
  points: async () => null,
}

// ---- 参与条件 ----

export const CONDITION_TYPES = [
  "always",
  "has_profile",
  "has_feature",
  "code",
  "lottery",
] as const
export type ConditionType = (typeof CONDITION_TYPES)[number]

export type ConditionHandler = (
  env: Env,
  userId: string,
  params: Record<string, unknown>
) => Promise<boolean>

export const CONDITION_HANDLERS: Record<ConditionType, ConditionHandler> = {
  always: async () => true,

  /**
   * 「是否已开通个人名片」。
   *
   * ⚠️ 判据是 **`published = 1` 且 `display_name` 非空**，两个条件都要。
   *
   * 为什么不是「profiles 里有没有行」：点一下「开通名片」就会插一条空白骨架行
   * （没名字没内容），公开地址 `/profile/<slug>` 在旧逻辑下返回 404「名片不存在」。
   *
   * 为什么还要卡昵称：**2026-09-28 起开通名片就默认 published=1**（用户不用再手动
   * 点「启用」），所以光看 published 的话，点一下开通就能过这个条件 ——
   * 那正是 gaozx1 空手领走 500 元余额的漏洞形态，会被重新打开。
   * 现在要求「至少填了个昵称」，空骨架行过不去；而正常做了名片的用户本来就会填昵称。
   *
   * 注意这里**故意**比管理面板的「个人名片」列严一格：admin 的 `profileEnabled`
   * 只看 published（它表达的是「对外可见」），而本条件是**发钱门槛**（表达的是
   * 「真的做了名片」）。两者不一致是对的，别为了「对齐」把昵称那道去掉。
   *
   * ⚠️ 改这里之前先想清楚：这条是**发钱**的门槛，放宽等于送钱。
   */
  has_profile: async (env, userId) => {
    const row = await env.DB.prepare(
      "SELECT 1 AS x FROM profiles WHERE user_id = ? AND published = 1 " +
        "AND display_name IS NOT NULL AND TRIM(display_name) <> ''"
    )
      .bind(userId)
      .first()
    return !!row
  },

  /**
   * 已开通指定模块（r2 / ai / frp / proxy）。
   * 用 parsePermissions + hasFeature：NULL 权限视为「全开」，与全站一致。
   */
  has_feature: async (env, userId, params) => {
    const feature = String(params.feature ?? "")
    if (!(FEATURES as readonly string[]).includes(feature)) return false
    const row = await env.DB.prepare("SELECT permissions FROM users WHERE id = ?")
      .bind(userId)
      .first<{ permissions: string | null }>()
    if (!row) return false
    return hasFeature(parsePermissions(row.permissions), feature as Feature)
  },

  /**
   * 认证码（如 QQ 群口令）：用于验证「站外行为」（进群、看视频、加频道等）——
   * 这类行为没有任何公开 API 能自动核实，只能靠管理员在站外公布口令、
   * 用户凭口令领取。真正的码比对在 claimEvent 里做（handler 拿不到用户输入），
   * 走到这里说明码已验对，恒通过。
   */
  code: async () => true,

  /**
   * 抽奖：参与时**只报名、不发奖**（真正的判定在开奖时做，见 events.ts 的 drawEvent）。
   * 所以这里恒通过 —— 是否还能报名由 claimState（未结束）与 max_claims（参与上限）管，
   * 与「条件」无关。配置见 parseLotteryConfig。
   */
  lottery: async () => true,
}

// ---- 抽奖 ----

/**
 * 抽奖配置（存在 events.condition_params 里）。
 *
 *   winners 中奖人数（从报名者里随机抽几个）
 *   pool    奖池总积分（中奖者共享）
 *   mode    分配方式：even 平均分 / random 随机分
 *
 * 参与人数上限复用 events.max_claims（留空 = 不限），不在这里重复配置。
 */
export const LOTTERY_MODES = ["even", "random"] as const
export type LotteryMode = (typeof LOTTERY_MODES)[number]

/**
 * 中奖人数上限。开奖时每人一次 `applyPoints`（内部要读余额 + 写流水 + 可能返佣），
 * 是逐个串行写 D1 的 —— 放开到几千会让开奖请求撞上子请求上限、跑到一半断掉。
 */
export const MAX_LOTTERY_WINNERS = 200

export interface LotteryConfig {
  winners: number
  pool: number
  mode: LotteryMode
}

/**
 * 解析 + 校验抽奖配置。**非法一律返回 null**（由调用方决定是拒绝写入还是标记异常），
 * 不做静默回落 —— 发的是积分（真钱），配置错了不能靠猜。
 *
 * 硬约束：pool >= winners —— 每人至少要分到 1 积分，否则这个配置根本分不下去。
 */
export function parseLotteryConfig(params: Record<string, unknown> | null): LotteryConfig | null {
  if (!params) return null
  const winners = Math.floor(Number(params.winners))
  const pool = Math.floor(Number(params.pool))
  const mode = String(params.mode ?? "")
  if (!Number.isFinite(winners) || winners < 1 || winners > MAX_LOTTERY_WINNERS) return null
  if (!Number.isFinite(pool) || pool < 1) return null
  if (!(LOTTERY_MODES as readonly string[]).includes(mode)) return null
  if (pool < winners) return null
  return { winners, pool, mode: mode as LotteryMode }
}

/**
 * 把奖池切成 n 份（**总和精确等于 pool、每份至少 1**）。
 *
 * - even：每人 `floor(pool/n)`，余数分给前几位（每份差最多 1）。
 * - random：每人一个 [0.5, 1.5] 的随机权重，按权重比例切分；因为取整与「至少 1」
 *   的兜底会让总和偏离 pool，最后按差额逐个补偿（差额最多 n 量级，循环很小）。
 *
 * rng 可注入（测试用固定序列，线上用 Math.random）。
 */
export function splitPool(
  pool: number,
  n: number,
  mode: LotteryMode,
  rng: () => number = Math.random
): number[] {
  if (n <= 0) return []
  if (n === 1) return [pool]

  if (mode === "even") {
    const base = Math.floor(pool / n)
    const rest = pool - base * n
    return Array.from({ length: n }, (_, i) => base + (i < rest ? 1 : 0))
  }

  const weights = Array.from({ length: n }, () => 0.5 + rng())
  const totalWeight = weights.reduce((a, b) => a + b, 0)
  const shares = weights.map((w) => Math.max(1, Math.floor((pool * w) / totalWeight)))

  // 补偿：先补差额，再从最大的往下削（削到 1 就停，保证每份 ≥ 1）
  let diff = pool - shares.reduce((a, b) => a + b, 0)
  while (diff > 0) {
    shares[diff % n] += 1
    diff -= 1
  }
  while (diff < 0) {
    const idx = shares.indexOf(Math.max(...shares))
    if (shares[idx] <= 1) break
    shares[idx] -= 1
    diff += 1
  }
  return shares
}

// ---- 校验（管理端写入前用，非法值一律拒绝而不是静默回落） ----

export function isRewardType(v: string): v is RewardType {
  return (REWARD_TYPES as readonly string[]).includes(v)
}

export function isConditionType(v: string): v is ConditionType {
  return (CONDITION_TYPES as readonly string[]).includes(v)
}
