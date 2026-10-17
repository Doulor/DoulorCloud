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
import { adminSetQuota, getCurrencyInfo, findUserByUsername } from "./newapi-client"
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

/**
 * 给中转站钱包**加**额度，并对上游抖动做「带校验的」重试（2026-10-18）。
 *
 * 为什么需要：线上反复出现发奖失败，全是上游抖动 ——
 *   · `NewAPI 设置额度失败: HTTP 502`
 *   · `The operation was aborted`（客户端超时）
 * 这 4 条失败记录最后都变成了人工补发。但 `adminSetQuota(..., "add")` 是
 * **非幂等**的（加钱），盲目重试会**重复发钱**，那比人工补发更糟。
 *
 * 所以每次失败后**先读一次真实余额**再决定：
 *   · 余额确实涨了 → 说明请求其实已经落地（丢的只是响应），直接当成功，不再重试
 *   · 余额没变     → 说明请求没落地，可以安全重试
 *   · 读不到基准值 → **一律不重试**（宁可真失败让人工兜，也不冒重复发钱的风险）
 *
 * 最多 3 次尝试，退避 300ms / 800ms。最终仍失败则抛出，由调用方记 failed +
 * 管理端「领取名单」人工补发。
 */
async function addQuotaWithVerify(
  env: Env,
  newapiUserId: number,
  username: string,
  rawQuota: number
): Promise<void> {
  /** 读当前余额；读不到返回 null（**读不到就不重试**，见上） */
  const quotaOf = async (): Promise<number | null> => {
    try {
      const u = await findUserByUsername(env, username)
      return typeof u?.quota === "number" ? u.quota : null
    } catch {
      return null
    }
  }

  const before = await quotaOf()
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await adminSetQuota(env, newapiUserId, rawQuota, "add")
      if (attempt > 0) console.warn("发额度：第", attempt + 1, "次尝试成功", username)
      return
    } catch (err) {
      lastErr = err
      if (before === null) break // 没有基准值，不能安全重试
      const after = await quotaOf()
      if (after !== null && after !== before) {
        // 请求报错了，但余额已经变了 —— 说明其实发成功了，别再发一次
        console.warn(
          "发额度：请求报错但余额已变化，按成功处理", username,
          `${before} → ${after}`
        )
        return
      }
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, attempt === 0 ? 300 : 800))
      }
    }
  }
  throw lastErr ?? new Error("发中转站额度失败")
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
  newapi_quota: async ({ env, userId, username, params }) => {
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

    // 非幂等操作 + 上游抖动 ⇒ 走「带校验的重试」，避免偶发 502/aborted 变成人工补发
    await addQuotaWithVerify(env, account.newapi_user_id, username, rawQuota)
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
  /** 问卷（集合投票）：多题、按答对率发奖 —— 与 vote 平级，见 validateQuizCondition */
  "quiz",
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
  quiz: "问卷",
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
   * 问卷：**不通过 claim 参与**（交卷走 POST /events/:id/quiz）。
   * 这里恒返回 true，是为了让 claimEvent 万一被调到也不会报"条件配置异常"。
   */
  quiz: async () => true,

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
  if (!isVoteRewardRule(rule)) return null
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
/**
 * 问卷配置的写入时校验（文案面向管理员）。返回 null = 合法。
 *
 * 与 validateVoteCondition 分开：问卷的形状完全不同（questions 而不是 options），
 * 合成一个函数只会让两边的错误文案互相串味（之前"投票活动需要配置选项"就是这么来的）。
 */
export function validateQuizCondition(params: unknown): string | null {
  const p = (params ?? {}) as Record<string, unknown>
  if (p.mode !== "quiz") {
    return "问卷配置缺少 mode=\"quiz\"（如果这是普通投票，请把参与类型改成「投票」）"
  }
  if (!parseQuizConfig(p)) {
    return "问卷配置不合法：至少 1 道题、每题至少 2 个选项、正确答案必须是该题的选项之一、发奖口径（scoring）必须有效（积分要写 amount / min-max）"
  }
  return null
}

export function validateVoteCondition(params: unknown): string | null {
  const p = (params ?? {}) as Record<string, unknown>
  /**
   * 🔴 **问卷（集合投票）的形状完全不同**（questions 而不是 options）。
   * 不先分流的话，管理端保存问卷会被下面那句「投票活动需要配置选项」挡下来 ——
   * 实测：POST /admin/events 带问卷配置直接 400，站长根本存不进去。
   * 合法就放行；不合法要给出**面向问卷**的原因，而不是"需要配置选项"这种误导文案。
   */
  if (p.mode === "quiz" || Array.isArray(p.questions)) {
    if (!parseQuizConfig(p)) {
      return "问卷配置不合法：至少 1 道题、每题至少 2 个选项、正确答案必须是该题的选项之一、发奖口径（scoring）必须有效"
    }
    return null
  }
  if (!Array.isArray(p.options)) return "投票活动需要配置选项"
  if (p.options.length < 2) return "投票至少要配置 2 个选项"
  if (p.options.length > MAX_VOTE_OPTIONS) return `投票选项最多 ${MAX_VOTE_OPTIONS} 个`
  const rule = String(p.rewardRule ?? "")
  if (!isVoteRewardRule(rule)) {
    return "获奖规则不合法（参与即可获奖 / 固定选项 / 多数 / 少数，各分立刻结算或截止后开奖）"
  }
  if (isFixedVoteRule(rule)) {
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

/* --------------------------------------------------------------------------
   集合投票（问卷）：一种「一个活动里含多道题」的投票形态。
   --------------------------------------------------------------------------
   与普通投票的关系：**复用整套 events / event_claims / REWARD_HANDLERS**，
   只是把 condition_params 里的投票配置换成下面这个形状（mode: "quiz"）。
   四项策略全部可配置（站长 2026-10-14 明确要求）：
     retake  —— 能否重答：once（一次）/ best（可重考，取最高分）/ unlimited
     scoring —— 发奖口径：tiers（按答对率分档）或 linear（按答对率线性折算积分）
     reveal  —— 对错可见性：immediate（交卷即显）/ afterDeadline（截止后）/ never
     timeLimit —— 限时：整卷秒数 / 每题秒数，或 null（不限时）
   -------------------------------------------------------------------------- */

/** 能否重答 */
export const QUIZ_RETAKE_MODES = ["once", "best", "unlimited"] as const
export type QuizRetakeMode = (typeof QUIZ_RETAKE_MODES)[number]

/** 对错何时可见 */
export const QUIZ_REVEAL_MODES = ["immediate", "afterDeadline", "never"] as const
export type QuizRevealMode = (typeof QUIZ_REVEAL_MODES)[number]

/**
 * 题目数上限。
 * ⚠️ 原来写的是 20 —— 结果是**超出部分被静默截断**：站长粘 25 题的问卷，
 * 存进去只剩 20 题，判分也按 20 题算，界面上完全看不出少了几题（实测踩到）。
 * 提到 50：足够做"站内知识问卷"这类长问卷，同时仍然防住"塞一千题"的滥用。
 */
export const MAX_QUIZ_QUESTIONS = 50
export const MAX_QUIZ_OPTIONS = 8
/** 重考次数上限（unlimited 也封顶，免得被刷） */
export const MAX_QUIZ_ATTEMPTS = 10

export interface QuizQuestion {
  id: string
  /** 题干 */
  title: string
  options: VoteOption[]
  /**
   * 正确答案的选项 id。
   * 🔴 **绝不下发给前端**（与 fixedOptionId 同一原则）—— 下发了就等于送答案。
   * 只有后台编辑与结算侧读它。
   */
  correctOptionId: string
}

/** 分档发奖的一档：答对率 ≥ minPercent 就给这个奖励 */
export interface QuizTier {
  minPercent: number
  rewardType: RewardType
  params?: Record<string, unknown>
}

export type QuizScoring =
  | { kind: "tiers"; tiers: QuizTier[] }
  /** 按答对率线性折算积分：答对 100% = maxPoints，0% = 0（四舍五入） */
  | { kind: "linear"; maxPoints: number; rewardType: RewardType; params?: Record<string, unknown> }

export interface QuizConfig {
  mode: "quiz"
  questions: QuizQuestion[]
  retake: QuizRetakeMode
  scoring: QuizScoring
  reveal: QuizRevealMode
  timeLimit: { totalSec?: number; perQuestionSec?: number } | null
}

/** 归一化题干/选项（与投票的 normalizeVoteOption 同一套风格） */
function normalizeQuizQuestion(raw: unknown, index: number): QuizQuestion | null {
  if (!raw || typeof raw !== "object") return null
  const q = raw as Record<string, unknown>
  const title = typeof q.title === "string" ? q.title.trim().slice(0, 200) : ""
  if (!title) return null
  const id = typeof q.id === "string" && q.id.trim() ? q.id.trim() : `q${index + 1}`
  const rawOptions = Array.isArray(q.options) ? q.options : []
  const options: VoteOption[] = []
  rawOptions.slice(0, MAX_QUIZ_OPTIONS).forEach((o, i) => {
    const n = normalizeVoteOption(o, i)
    if (n && !options.some((x) => x.id === n.id)) options.push(n)
  })
  if (options.length < 2) return null
  const correctOptionId =
    typeof q.correctOptionId === "string" ? q.correctOptionId.trim() : ""
  // 🔴 正确答案必须真的在选项里 —— 否则这道题**永远答不对**（静默错判最难查）
  if (!correctOptionId || !options.some((o) => o.id === correctOptionId)) return null
  return { id, title, options, correctOptionId }
}

/**
 * 解析 + 校验问卷配置。**非法一律返回 null**（与 parseVoteConfig 一致：
 * 不做静默回落，宁可拒绝写入，也不要出现「答对了却判错」这种查不出来的问题）。
 */
export function parseQuizConfig(raw: unknown): QuizConfig | null {
  if (!raw || typeof raw !== "object") return null
  const c = raw as Record<string, unknown>
  const rawQuestions = Array.isArray(c.questions) ? c.questions : []
  const questions: QuizQuestion[] = []
  rawQuestions.slice(0, MAX_QUIZ_QUESTIONS).forEach((q, i) => {
    const n = normalizeQuizQuestion(q, i)
    // 题目 id 去重（重复 id 会让答案互相覆盖）
    if (n && !questions.some((x) => x.id === n.id)) questions.push(n)
  })
  if (!questions.length) return null

  const retake: QuizRetakeMode = (QUIZ_RETAKE_MODES as readonly string[]).includes(
    String(c.retake)
  )
    ? (c.retake as QuizRetakeMode)
    : "once"

  const reveal: QuizRevealMode = (QUIZ_REVEAL_MODES as readonly string[]).includes(
    String(c.reveal)
  )
    ? (c.reveal as QuizRevealMode)
    : "afterDeadline"

  // ---- 发奖口径 ----
  let scoring: QuizScoring
  const rawScoring = (c.scoring ?? {}) as Record<string, unknown>
  if (rawScoring.kind === "linear") {
    const maxPoints = Math.floor(Number(rawScoring.maxPoints) || 0)
    if (maxPoints <= 0 || maxPoints > MAX_ABS_POINTS) return null
    scoring = {
      kind: "linear",
      maxPoints,
      rewardType: "points",
      // ⚠️ points handler 读的是 **amount**（不是 points）—— 写错会在发奖那一刻才失败
      params: { amount: maxPoints },
    }
  } else {
    const rawTiers = Array.isArray(rawScoring.tiers) ? rawScoring.tiers : []
    const tiers: QuizTier[] = []
    for (const rt of rawTiers) {
      const t = (rt ?? {}) as Record<string, unknown>
      const minPercent = Math.floor(Number(t.minPercent))
      /**
       * 🔴 门槛必须在 0–100，且**同一门槛只能有一档**（2026-10-15 实测补的）。
       *
       * 原来非法档位是 `continue`（静默跳过）：站长配了 ≥120% 那一档，保存成功、
       * 界面也不报错，但**答对率上限就是 100%** ⇒ 那一档永远不可能命中，
       * 站长会一直以为"配了两档、高分拿大额"。同一门槛配两档同理（第二档永远轮不到）。
       * 所以这里改成**拒绝整份配置**，与其它字段"非法一律拒绝"的口径一致。
       */
      if (!Number.isFinite(minPercent) || minPercent < 0 || minPercent > 100) return null
      // ⚠️ **同一门槛允许配多档**（2026-10-15 站长要求）：≥100% 同时给"额度 3000"和"积分 500"，
      //    满分时两份一起发。所以这里**不做去重** —— 之前加过一条"重复门槛就拒绝"，已撤掉。
      const rewardType = String(t.rewardType ?? "")
      if (!isRewardType(rewardType)) continue
      const tierParams = (t.params ?? undefined) as Record<string, unknown> | undefined
      /**
       * 🔴 **档位参数在写入时就校验**（2026-10-15 实测教训）：
       * 原来档位参数原样存下，配错了要到**发奖那一刻**才失败，用户看到的是
       * 「奖励发放失败」，站长完全不知道是自己参数名写错了（points vs amount）。
       * 这里按奖励类型跑一遍现成的校验器，配错直接拒绝保存。
       */
      if (rewardType === "points") {
        /**
         * ⚠️ **必须写明发多少积分**（amount 或 min/max）。
         * 只靠 validatePointsReward 不够 —— 它对「没配 amount」是宽容的（那个校验器
         * 还要服务其它允许不配积分的场景），所以 {points:2} 这种**字段名写错**的配置
         * 会被当成"没配"而放过，直到发奖那一刻才失败（实测踩过）。
         */
        const hasAmount = tierParams?.amount !== undefined
        const hasRange = tierParams?.min !== undefined || tierParams?.max !== undefined
        if (!hasAmount && !hasRange) return null
        const err = validatePointsReward(tierParams ?? {})
        if (err) return null
      }
      tiers.push({
        minPercent,
        rewardType,
        params: tierParams,
      })
    }
    if (!tiers.length) return null
    // 从高到低排 —— 结算时取「第一个满足」的档，顺序错了会发少
    tiers.sort((a, b) => b.minPercent - a.minPercent)
    scoring = { kind: "tiers", tiers }
  }

  // ---- 限时 ----
  let timeLimit: QuizConfig["timeLimit"] = null
  if (c.timeLimit && typeof c.timeLimit === "object") {
    const t = c.timeLimit as Record<string, unknown>
    const totalSec = Math.floor(Number(t.totalSec) || 0)
    const perQuestionSec = Math.floor(Number(t.perQuestionSec) || 0)
    const total = totalSec > 0 ? Math.min(totalSec, 7200) : undefined
    const per = perQuestionSec > 0 ? Math.min(perQuestionSec, 1800) : undefined
    if (total || per) timeLimit = { totalSec: total, perQuestionSec: per }
  }

  return { mode: "quiz", questions, retake, scoring, reveal, timeLimit }
}

/**
 * 答对率（0..100，四舍五入）。
 * ⚠️ 分母是**题目总数**（不是已答题数）：没答的题按错算 —— 否则只答对一题交卷就是 100%。
 */
export function quizScorePercent(
  questions: Pick<QuizQuestion, "id" | "correctOptionId">[],
  answers: Record<string, string>
): number {
  if (!questions.length) return 0
  let right = 0
  for (const q of questions) {
    if (answers[q.id] && answers[q.id] === q.correctOptionId) right += 1
  }
  return Math.round((right / questions.length) * 100)
}

/** 按答对率挑档：tiers 必须已从高到低排好；都不满足返回 null */
export function pickQuizTier(tiers: QuizTier[], percent: number): QuizTier | null {
  for (const t of tiers) {
    if (percent >= t.minPercent) return t
  }
  return null
}

/**
 * 取**所有**满足的档里门槛最高的那一档（可能多档 —— 同门槛可以配多个奖励）。
 *
 * 站长 2026-10-15 的需求：≥100% 同时给"额度 3000"和"积分 500"，满分时两份一起发。
 * 所以结算不再只取一档，而是"取最高门槛上的全部档"。
 * ⚠️ 不会跨门槛累加：≥80% 的人只拿 80% 那一档，不会把 ≥50% 的也加上。
 */
export function pickQuizTiers(tiers: QuizTier[], percent: number): QuizTier[] {
  let best = -1
  for (const t of tiers) {
    if (percent >= t.minPercent && t.minPercent > best) best = t.minPercent
  }
  if (best < 0) return []
  return tiers.filter((t) => t.minPercent === best)
}

/** 线性折算积分：100% → maxPoints，0% → 0（四舍五入） */
export function quizLinearPoints(maxPoints: number, percent: number): number {
  const p = Math.max(0, Math.min(100, percent))
  return Math.round((maxPoints * p) / 100)
}

/**
 * 自动补发「因未开通中转站而挂起」的额度奖励（2026-10-17，用户 hsyy 反馈触发）。
 *
 * 真实场景：答完问卷时用户还没开中转站 ⇒ newapi_quota 发不出去，
 * 领奖记录落成 `manual`，文案是「你还未开通 AI 中转站，无法自动发放 500 钱包余额」。
 * 用户往往**几分钟后就开通了**，但没有任何机制回头补发 —— 只能等管理员人工处理，
 * 而人工处理往往就是忘了（队列里躺着好几条这种）。
 *
 * 这里每小时扫一遍：只挑「文案标明是因未开通挂起的」且「现在已经有中转站账号」的记录，
 * 金额从**我们自己写的**那句文案里解析（格式由本文件的 newapi_quota handler 生成，
 * 稳定可控；解析不到就跳过，保持 manual 不动）。
 *
 * ⚠️ 幂等：更新时带 `AND reward_status='manual'` 条件，并发下只有一个能改成功；
 *    已 granted 的不会被重复发。
 */
export async function retryPendingQuotaClaims(
  env: Env
): Promise<{ granted: number; skipped: number }> {
  const rows = await env.DB.prepare(
    `SELECT c.id, c.user_id, c.event_id, c.reward_detail, u.username
       FROM event_claims c
       JOIN users u ON u.id = c.user_id
       JOIN newapi_accounts a ON a.user_id = c.user_id
      WHERE c.reward_status = 'manual'
        AND c.reward_type = 'newapi_quota'
        AND c.reward_detail LIKE '%未开通 AI 中转站%'
      LIMIT 50`
  ).all<{
    id: string
    user_id: string
    event_id: string
    reward_detail: string
    username: string
  }>()

  let granted = 0
  let skipped = 0
  for (const row of rows.results ?? []) {
    const m = /无法自动发放\s*(\d+(?:\.\d+)?)\s*钱包余额/.exec(row.reward_detail ?? "")
    const amount = m ? Number(m[1]) : NaN
    if (!Number.isFinite(amount) || amount <= 0) {
      skipped++
      continue
    }
    try {
      const res = await REWARD_HANDLERS.newapi_quota({
        env,
        userId: row.user_id,
        username: row.username,
        params: { amount },
        eventId: row.event_id,
      })
      if (res.status === "granted") {
        // 带上状态条件，避免和别的路径（人工发放）重复发
        const upd = await env.DB.prepare(
          `UPDATE event_claims SET reward_status = 'granted', reward_detail = ?
            WHERE id = ? AND reward_status = 'manual'`
        )
          .bind(res.detail, row.id)
          .run()
        if ((upd.meta?.changes ?? 0) > 0) granted++
        else skipped++
      } else {
        skipped++
        await env.DB.prepare(
          "UPDATE event_claims SET reward_detail = ? WHERE id = ? AND reward_status = 'manual'"
        )
          .bind(res.detail, row.id)
          .run()
      }
    } catch (err) {
      skipped++
      console.error("自动补发额度奖励失败:", row.id, err)
    }
  }
  return { granted, skipped }
}
