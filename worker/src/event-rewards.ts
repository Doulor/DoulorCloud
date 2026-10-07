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
import { checkStarred, checkContributedPr, isRepoSlug } from "./github"
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

/**
 * FNV-1a 32 位哈希。
 *
 * 用途只有一个：把「活动 id + 用户 id」摊到积分区间上（见 pickPointsAmount）。
 * 挑 FNV-1a 是因为它几行就能写完、无依赖、同样的输入永远同样的输出。
 */
function hash32(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** 积分变动的绝对值上限（正负都算）——防止把 JSON 当成"给天文数字积分"的口子 */
export const MAX_ABS_POINTS = 1_000_000

/**
 * 校验「积分奖励」配置（创建 / 更新活动时调用）。返回 null = 合法，否则是拒绝原因。
 *
 * 为什么要在**写入时**拦：发放端（下面的 points handler）遇到非法配置只会把
 * 那一条领取记成 `failed`，用户看到「领取失败」却完全不知道为什么 ——
 * 配置错误属于管理员笔误，应该在他点保存的那一刻就报出来。
 *
 * 兼容旧配置：只有出现 `min`/`max` 才按区间校验；抽奖用的 `null`（params 为空、
 * 走奖池分配）直接放行。
 *
 * ⚠️ 2026-10-07 起**允许负数**（站长要求：下限可以设成负数 = 扣积分）：
 *   - `{min: -50, max: -10}` 随机扣 10~50 积分
 *   - `{amount: -100}` 固定扣 100 积分
 * 区间**跨越 0**（如 -10~10）也允许，但抽到 0 时按「本次不增不减」处理
 * （见 pickPointsAmount 与 points handler 的 amount === 0 分支）。
 */
export function validatePointsReward(params: unknown): string | null {
  const p = (params ?? {}) as Record<string, unknown>
  if (p.min === undefined && p.max === undefined) {
    // 固定值：amount = 0 没意义（积分不变），显式拒掉而不是静默当成"没配"
    if (p.amount !== undefined) {
      const fixed = Number(p.amount)
      if (!Number.isFinite(fixed)) return "积分数要填数字"
      if (Math.trunc(fixed) === 0) return "积分变动不能为 0"
      if (Math.abs(Math.trunc(fixed)) > MAX_ABS_POINTS) {
        return `积分绝对值最多 ${MAX_ABS_POINTS}`
      }
    }
    return null
  }
  const min = Number(p.min)
  const max = Number(p.max)
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return "随机区间的上下限都要填数字"
  }
  if (Math.trunc(min) < -MAX_ABS_POINTS) return `随机区间下限不能小于 -${MAX_ABS_POINTS}`
  if (Math.trunc(max) > MAX_ABS_POINTS) return `随机区间上限不能大于 ${MAX_ABS_POINTS}`
  if (Math.trunc(max) < Math.trunc(min)) return "随机区间上限不能小于下限"
  return null
}

/**
 * 校验 `github_star` / `github_pr` 条件的配置（两者都只需要一个 `owner/repo`）。
 * 返回 null = 合法，否则是拒绝原因。
 *
 * ⚠️ 一定要求 `owner/repo` 形态：只填个仓库名（或在面板里粘了完整 URL）
 * 会让核验请求打到不存在的地址，表现成「所有人都核验失败」。
 */
export function validateGithubRepoCondition(params: unknown): string | null {
  const p = (params ?? {}) as Record<string, unknown>
  const repo = typeof p.repo === "string" ? p.repo.trim() : ""
  if (!repo) return "请填写要核验的 GitHub 仓库（形如 owner/repo）"
  if (!isRepoSlug(repo)) {
    return `GitHub 仓库不合法：${repo}（要形如 owner/repo，不要整段 URL）`
  }
  return null
}

/**
 * 校验 `github_pr` 条件的配置。规则与 `github_star` 完全一致（都只要一个
 * `owner/repo`），复用同一个校验函数即可。
 */
export const validateGithubPrCondition = validateGithubRepoCondition

/** 解析后的积分奖励数额 */
export interface PickedPointsAmount {
  /** 本次实际变动的积分数（负数 = 扣减，0 = 不增不减） */
  amount: number
  /** 配置的区间（固定值时 min === max） */
  min: number
  max: number
  /** 是否为区间随机 */
  random: boolean
}

/**
 * 解析「积分奖励数额」——支持**固定值**与**区间随机**两种写法。
 *
 * `reward_params`：
 *   { "amount": 10 }          → 固定 10 积分
 *   { "amount": -100 }        → 固定扣 100 积分
 *   { "min": 5,  "max": 20 }  → 5~20 之间取一个整数（闭区间）
 *   { "min": -50, "max": -10 }→ 随机扣 10~50 积分
 *   { "min": -10, "max": 10 } → 可能加、可能扣，**也可能抽到 0**
 *
 * ⚠️ **随机是确定性的**（用 seed 做哈希取模），不是每次调用现抽。理由：
 * `claimEvent` 在发放失败时会复用旧 claim 重试（见 handlers/events.ts），
 * 如果金额在发放那一刻才现抽，同一次领取重试后金额可能变 —— 用户视角就是
 * 「刚才显示 7 积分，刷一下变 12 了」。确定性抽取让重试拿到同一个数，
 * 并且不需要额外落库保存抽到的值（实际数额会写进 event_claims.reward_detail）。
 * seed 用 `eventId:userId`：同一活动里每个人不同、同一个人在不同活动里也不同。
 *
 * 返回 null = 配置无法解析出整数（调用方按「发放失败」处理，让管理员看到）。
 * **返回 amount = 0 是可能的**（区间跨越 0 时）——调用方要单独处理，不能直接
 * 丢给 applyPoints（它要求 delta ≠ 0，会抛错）。
 */
export function pickPointsAmount(
  params: Record<string, unknown>,
  seed: string
): PickedPointsAmount | null {
  const rawMin = Number(params.min)
  const rawMax = Number(params.max)
  if (Number.isFinite(rawMin) && Number.isFinite(rawMax)) {
    // 允许负数（扣积分）与跨越 0 的区间
    const lo = Math.trunc(rawMin)
    const hi = Math.max(lo, Math.trunc(rawMax))
    if (hi === lo) return { amount: lo, min: lo, max: hi, random: false }
    return { amount: lo + (hash32(seed) % (hi - lo + 1)), min: lo, max: hi, random: true }
  }
  // 固定值：⚠️ 不能用 readAmount —— 它把 <= 0 当成「没配」回落成 fallback，
  // 而这里**负数（扣积分）是合法配置**，会被它悄悄改成 fallback。
  const raw = Number(params.amount)
  if (!Number.isFinite(raw)) return null
  const fixed = Math.trunc(raw)
  if (fixed === 0) return null
  return { amount: fixed, min: fixed, max: fixed, random: false }
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
   * 发积分（`amount` = 积分数，非金额）。**允许负数 = 扣积分**（2026-10-07 站长要求）。
   *
   * 与 newapi_quota 的区别：那个直接给中转站钱包加钱、必须先绑定中转站账号；
   * 这个只是记账，**任何用户都能拿到**（没绑中转站的也能先攒着，等开通后再兑换）。
   *
   * 幂等：dedup_key 用 `event:<eventId>`。这是**双保险** —— event_claims 的
   * (event_id, user_id) 唯一索引已经拦住了重复领取；这里再挡一层，是为了
   * 「活动奖励类型被改成积分、旧 claim 触发重试」这类边界情况不会重复发放。
   */
  points: async ({ env, userId, params, eventId }) => {
    // 支持固定值 / 区间随机（见 pickPointsAmount）。区间时按 `eventId:userId`
    // 确定性抽取 ⇒ 发放失败重试也是同一个数，不会「金额变来变去」。
    const picked = pickPointsAmount(params, `${eventId}:${userId}`)
    if (!picked) return { status: "failed", detail: "活动配置的积分数无效。" }
    const { amount, min, max, random } = picked

    // 区间跨越 0 时可能抽到 0。这不是「发放失败」，也不该丢给 applyPoints
    // （它要求 delta ≠ 0，会直接抛 INVALID_INPUT），按「本次不增不减」处理。
    if (amount === 0) {
      return { status: "granted", detail: "本次活动随机到 0 积分（不增不减）。" }
    }

    const isDeduct = amount < 0
    const res = await applyPoints(env, {
      userId,
      delta: amount,
      reason: "event",
      detail: random
        ? `活动奖励：${amount} 积分（区间 ${min}~${max} 随机）`
        : isDeduct
          ? `活动扣减：${-amount} 积分`
          : `活动奖励：${amount} 积分`,
      dedupKey: `event:${eventId}`,
    })
    if (!res.applied) {
      // ⚠️ 不能一律当成「已领过」：扣积分时**余额不足**也会落到这里，
      // 把它说成「你已获得过本活动的 -50 积分」是明显自相矛盾的提示。
      if (res.reason === "insufficient") {
        return {
          status: "failed",
          detail: `你的积分余额不足，无法扣除 ${-amount} 积分（当前余额 ${res.balance}），请联系管理员。`,
        }
      }
      // 幂等命中：说明这一份之前已经发过了，对用户而言仍是「已获得」
      return {
        status: "granted",
        detail: isDeduct
          ? `本活动的 ${-amount} 积分此前已扣除过。`
          : `你已获得过本活动的 ${amount} 积分。`,
      }
    }
    return {
      status: "granted",
      detail: isDeduct
        ? `已扣除 ${-amount} 积分，当前余额 ${res.balance}。`
        : `已获得 ${amount} 积分，当前余额 ${res.balance}。`,
    }
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
  "vote",
  "github_star",
  "github_pr",
] as const
export type ConditionType = (typeof CONDITION_TYPES)[number]

/**
 * 条件不满足时告诉用户**具体差什么**（前端直接展示这段文案）。
 *
 * 为什么需要它：原来一律报「你还不满足参与条件」，用户完全不知道缺哪一步 ——
 * 最典型的就是「开通了名片却领不了」（其实还要求发布 + 填昵称），
 * 只能跑来提反馈问（2026-10-02 用户 baijiu 就是这么卡住的）。
 *
 * ⚠️ 改这里的文案时**别把门槛说松**：这几句是给用户看的「怎么才算达标」，
 * 与上面的判据必须一致，否则又变成「照着提示做还是过不了」。
 */
export const CONDITION_HINTS: Record<ConditionType, string> = {
  always: "",
  has_profile: "需要先把个人名片做完：打开名片页填好昵称并保存（只点「开通名片」不算）",
  has_feature: "需要先开通对应的功能模块",
  code: "需要填写正确的活动口令",
  lottery: "",
  vote: "从下面的选项里选一个投出去即可参与（一人一票，投完不能改）",
  github_star: "需要给仓库点 Star（刚点完最多 5 分钟后才会识别到）",
  github_pr: "需要给仓库提交过 PR（刚提交最多 5 分钟后才会识别到）",
}

/**
 * 领取时前端带过来的输入（服务端一律**不信**这些值，只当线索去核验）。
 * 目前只有认证码与 GitHub 用户名两种活动用得到。
 */
export interface ClaimInput {
  /** condition_type = code 时的认证码 */
  code?: string
  /** condition_type = github_star 时的 GitHub 用户名 */
  github?: string
}

export type ConditionHandler = (
  env: Env,
  userId: string,
  params: Record<string, unknown>,
  /** 领取请求里带的输入；老条件用不到，忽略即可 */
  input: ClaimInput
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
  /**
   * 抽奖：报名阶段的「条件」是恒真 —— 能不能中奖由开奖时按奖池分配决定，
   * 报名本身不该有门槛（见 handlers/events.ts 的 drawEvent）。
   */
  lottery: async () => true,

  /**
   * 投票：这里恒通过 —— 真正的校验在 `claimEvent` 里做（要带过来的是 `optionId`，
   * 这个 handler 的入参只有 code / github）。能投几次由 `event_votes` 的唯一索引
   * `(event_id, user_id)` 管，与「条件」无关。
   *
   * ⚠️ 别在这里加门槛：投票的「门槛」是选项合法 + 没投过，放在 claimEvent 里
   * 才能给出具体错误码（VOTE_OPTION_REQUIRED / ALREADY_VOTED）。
   */
  vote: async () => true,

  /**
   * 「有没有给我的 GitHub 仓库点过 star」。
   *
   * `condition_params`：`{ repo: "owner/name" }`
   * 领取时 `input.github` 是用户自己填的 GitHub 用户名。
   *
   * ⚠️ 核验不了（仓库私有 / 限额打光 / 网络异常）时**返回 false**，
   * 但真正的用户提示由 `handlers/events.ts` 在调本函数**之前**的预检给出 ——
   * 那边能拿到 `error` 文案，能告诉用户「稍后再试」而不是「你没点 star」。
   */
  github_star: async (env, _userId, params, input) => {
    const repo = String(params.repo ?? "").trim()
    const who = String(input.github ?? "").trim()
    if (!repo || !who) return false
    const res = await checkStarred(env, repo, who)
    return res.ok
  },

  /**
   * 「有没有给我的 GitHub 仓库提交过 PR」（2026-10-05 站长要求，借鉴 github_star）。
   *
   * `condition_params`：`{ repo: "owner/name" }`（可选 `mergedOnly: true` 只认被合并的 PR）
   * 领取时 `input.github` 是用户自己填的 GitHub 用户名。
   *
   * ⚠️ 与 github_star 同样：核验不了时返回 false，真正的用户提示由
   * `handlers/events.ts` 在调本函数之前的预检给出。
   */
  github_pr: async (env, _userId, params, input) => {
    const repo = String(params.repo ?? "").trim()
    const who = String(input.github ?? "").trim()
    if (!repo || !who) return false
    const res = await checkContributedPr(env, repo, who, params.mergedOnly === true)
    return res.ok
  },
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

// ---- 投票 ----

/**
 * 投票的获奖规则（存在 events.condition_params.rewardRule 里）。
 *
 *   all               参与即可获奖 —— 投完票当场按奖励类型发放（与其他活动一致）
 *   instant_fixed     投票那一刻判定：投中**指定选项** ⇒ 立刻发奖
 *   instant_majority  投票那一刻判定：投的选项现在是多数 ⇒ 立刻发奖
 *   instant_minority  同上，少数 ⇒ 立刻发奖
 *   fixed             活动截止后开奖：**指定选项**获奖
 *   majority          活动截止后开奖：得票最多的选项获奖
 *   minority          活动截止后开奖：得票最少（≥1 票）的选项获奖
 *
 * ⚠️ 两档「固定选项」都要配 `condition_params.fixedOptionId`（站长在后台选的那个）。
 *
 * ⚠️ 「立刻结算」这三档的语义（站长 2026-10-06 / 07 追加要求）：
 *   不做开奖，每个人在自己的投票请求里当场结算 —— 中的当场拿到，没中的当场标 lost。
 *   副作用要提前知道：**越早投越容易赢**（多数/少数那两档）；而「固定选项」更好猜 ——
 *   多开一个小号投一次，看有没有中奖就能反推出是哪个选项（中奖会显示「已获得」）。
 *   要防这种探查，用 `fixed`（截止后开奖）那一档。
 */
export const VOTE_REWARD_RULES = [
  "all",
  "instant_fixed",
  "instant_majority",
  "instant_minority",
  "fixed",
  "majority",
  "minority",
] as const
export type VoteRewardRule = (typeof VOTE_REWARD_RULES)[number]

/**
 * 获奖口径：
 *   fixed    指定选项（不看得票）
 *   majority 票数最多
 *   minority 票数最少（≥1 票）
 *
 * 「立刻结算」与「截止后开奖」共用同一套判定，只是调用时机不同。
 */
export type VoteScope = "fixed" | "majority" | "minority"

/** 是不是「投票后立刻按当前票数结算」那一档（不需要开奖） */
export function isInstantVoteRule(r: VoteRewardRule): boolean {
  return r === "instant_fixed" || r === "instant_majority" || r === "instant_minority"
}

/** 是不是「指定选项获奖」那一档（需要配 fixedOptionId） */
export function isFixedVoteRule(r: VoteRewardRule): boolean {
  return r === "fixed" || r === "instant_fixed"
}

/**
 * 把规则映射成获奖口径。`all`（参与即可获奖）没有口径 ⇒ 返回 null，
 * 调用方据此判断「这条规则不需要判定」。
 */
export function voteScopeOf(r: VoteRewardRule): VoteScope | null {
  if (isFixedVoteRule(r)) return "fixed"
  if (r === "majority" || r === "instant_majority") return "majority"
  if (r === "minority" || r === "instant_minority") return "minority"
  return null
}

/** 是不是「等截止后由管理员/定时开奖」那一档 */
export function isDrawVoteRule(r: VoteRewardRule): boolean {
  return r === "fixed" || r === "majority" || r === "minority"
}

/**
 * 选项数量上限。
 *
 * 为什么卡 20：选项存在 condition_params（单行 JSON），活动请求体上限 64 KB，
 * 每项还带说明与图片 URL；20 项已远超正常投票活动（典型 2~5 项），
 * 再放开只是给「把 JSON 撑大」开口子。
 */
export const MAX_VOTE_OPTIONS = 20

/** 单个投票选项 */
export interface VoteOption {
  /** 稳定 id（选项改标题不影响已经投出去的票） */
  id: string
  /** 选项标题，1~60 字 */
  label: string
  /** 一句话说明，可空，最多 200 字 */
  desc?: string
  /** 配图 URL（同源相对路径），可空 */
  image?: string
}

export interface VoteConfig {
  options: VoteOption[]
  rewardRule: VoteRewardRule
  /**
   * 「指定选项获奖」时站长选中的那个选项 id（`fixed` / `instant_fixed` 必填，
   * 且必须是 options 里真实存在的一项）。其它规则下为 undefined。
   */
  fixedOptionId?: string
}

function normalizeVoteOption(raw: unknown, index: number): VoteOption | null {
  if (!raw || typeof raw !== "object") return null
  const o = raw as Record<string, unknown>
  const label = typeof o.label === "string" ? o.label.trim().slice(0, 60) : ""
  if (!label) return null
  // id 缺省时按位置生成 —— 手写 JSON 不带 id 也能跑起来
  const id = (typeof o.id === "string" && o.id.trim() ? o.id.trim() : `opt${index + 1}`).slice(0, 40)
  const desc =
    typeof o.desc === "string" && o.desc.trim() ? o.desc.trim().slice(0, 200) : undefined
  const image =
    typeof o.image === "string" && o.image.trim() ? o.image.trim().slice(0, 500) : undefined
  return { id, label, desc, image }
}

/**
 * 解析 + 校验投票配置。**非法一律返回 null**（由调用方决定是拒绝写入还是标记异常），
 * 不做静默回落 —— 选项少一个会让「投出去的那一票对不上选项」，计数直接错。
 *
 * 返回的 options 已按 id 去重（重复 id 会让计票把两个选项算成同一堆）。
 */
export function parseVoteConfig(params: Record<string, unknown> | null): VoteConfig | null {
  if (!params) return null
  const rawOptions = params.options
  if (!Array.isArray(rawOptions)) return null
  const options: VoteOption[] = []
  const seen = new Set<string>()
  for (let i = 0; i < rawOptions.length && i < MAX_VOTE_OPTIONS; i++) {
    const o = normalizeVoteOption(rawOptions[i], i)
    if (!o || seen.has(o.id)) continue
    seen.add(o.id)
    options.push(o)
  }
  if (options.length < 2) return null
  const rule = String(params.rewardRule ?? "")
  if (!(VOTE_REWARD_RULES as readonly string[]).includes(rule)) return null
  const applied = rule as VoteRewardRule
  // 「指定选项获奖」必须配一个**真实存在**的选项 id。
  // ⚠️ 不能只存下来不校验：配错（或选项后来被删了）时，判奖会算出「一个不存在的选项获奖」，
  // 结果是所有投票的人都拿不到奖，而管理员完全看不出哪里错了。
  let fixedOptionId: string | undefined
  if (isFixedVoteRule(applied)) {
    const raw =
      typeof params.fixedOptionId === "string" ? params.fixedOptionId.trim().slice(0, 40) : ""
    if (!raw) return null
    if (!options.some((o) => o.id === raw)) return null
    fixedOptionId = raw
  }
  return { options, rewardRule: applied, ...(fixedOptionId ? { fixedOptionId } : {}) }
}

/** 投票配置的写入时校验（文案面向管理员），返回 null = 合法 */
export function validateVoteCondition(params: unknown): string | null {
  const p = (params ?? {}) as Record<string, unknown>
  if (!Array.isArray(p.options)) return "投票活动需要配置选项"
  if (p.options.length < 2) return "投票至少要配置 2 个选项"
  if (p.options.length > MAX_VOTE_OPTIONS) return `投票选项最多 ${MAX_VOTE_OPTIONS} 个`
  const rule = String(p.rewardRule ?? "")
  if (!(VOTE_REWARD_RULES as readonly string[]).includes(rule)) {
    return "获奖规则不合法（参与即可获奖 / 固定选项 / 多数 / 少数，各分立刻结算或截止后开奖）"
  }
  if (isFixedVoteRule(rule as VoteRewardRule)) {
    const fixed = typeof p.fixedOptionId === "string" ? p.fixedOptionId.trim() : ""
    if (!fixed) return "「固定选项获奖」需要指定获奖的那个选项"
  }
  if (!parseVoteConfig(p)) {
    return "投票配置不合法：每个选项都要填标题、选项不能重复、指定的获奖选项必须真实存在"
  }
  return null
}

export function isVoteRewardRule(v: string): v is VoteRewardRule {
  return (VOTE_REWARD_RULES as readonly string[]).includes(v)
}

/**
 * 从计票结果里挑出「中奖选项」（可以多个 —— 平票时并列全算）。
 *
 * 平票口径（站长 2026-10-06 拍板：并列的全部算中奖）：
 *   - majority：取票数**最高**的所有选项。两个选项都是 10 票 ⇒ 投这两边的人都中奖。
 *   - minority：只在**有票**的选项里取票数**最低**的所有选项。
 *     ⚠️ 为什么排除 0 票的选项：0 票的选项背后没有投票人，把它算成「少数」等于
 *     这一轮谁都中不了奖（还得再定义「0 票并列怎么算」）。只比有票的选项，
 *     语义就是「得票最少的那一拨人」。
 *   - 由此得到的天然结果：若只有一个选项有票，它既是最高也是最低 ⇒ 投它的人全中奖。
 *     这是刻意的（少数派投票本来就可能一边倒），不做特判。
 *
 * `fixed`（指定选项获奖）**完全不看得票** ⇒ 直接返回配置里那个选项。
 * 注意它 0 票也算「获奖选项」，只是没人投它时没人拿奖 —— 这是对的行为，
 * 不该因为「没人投」就改判别的选项获奖。
 *
 * 入参是**获奖口径**而不是整条规则 —— 因为「截止后开奖」与「立刻结算」用的是
 * 同一套判定，只是调用时机不同（`all` 没有口径，调用方用 voteScopeOf 判后不该走到这里）。
 *
 * `counts` 里若含已从配置删掉的孤儿选项，由调用方先按 parseVoteConfig 过滤。
 */
export function pickWinningOptions(
  counts: Map<string, number>,
  scope: VoteScope,
  fixedOptionId?: string
): string[] {
  if (scope === "fixed") return fixedOptionId ? [fixedOptionId] : []
  const entries = [...counts.entries()].filter(([, c]) => c > 0)
  if (entries.length === 0) return []
  const target =
    scope === "majority"
      ? Math.max(...entries.map(([, c]) => c))
      : Math.min(...entries.map(([, c]) => c))
  return entries.filter(([, c]) => c === target).map(([id]) => id)
}

// ---- 校验（管理端写入前用，非法值一律拒绝而不是静默回落） ----

export function isRewardType(v: string): v is RewardType {
  return (REWARD_TYPES as readonly string[]).includes(v)
}

export function isConditionType(v: string): v is ConditionType {
  return (CONDITION_TYPES as readonly string[]).includes(v)
}
