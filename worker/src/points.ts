/**
 * 积分系统核心：余额、流水、加减、兑换中转站余额。
 *
 * 设计要点：
 *   1. **所有积分变动都必须走 applyPoints()**。它是唯一写 user_points 的地方，
 *      保证「余额变了」与「流水有记录」永远同时发生，不会出现对不上账的余额。
 *   2. 余额是 INTEGER。1 积分值多少元由 `points_yuan_per_point` 决定（默认 1，
 *      支持小数），但**积分本身不做小数** —— 小数余额会让「花光了没有」变得难以判断。
 *   3. 扣积分用**条件 UPDATE**（`AND balance >= ?`）做原子性检查，
 *      不读后写：并发下两个人同时兑换也不会把余额扣成负数。
 *   4. 幂等靠 point_transactions 的 (user_id, dedup_key) 唯一索引 + INSERT OR IGNORE，
 *      与活动领取（event_claims）同一套路，调用方不需要自己判重。
 *
 * ⚠️ 与「成就点」的关系：**两者完全独立**。成就点（handlers/achievements.ts）
 * 是实时算出来的荣誉值、不落库、不能花；积分是落库资产。不要在这里引入
 * 任何对成就点的读取 —— 那是另一套体系。
 */
import { ApiError } from "./http"
import { uuid } from "./crypto"
import { adminSetQuota, getCurrencyInfo } from "./newapi-client"
import { audit, getSetting, getSettingBool, getSettingNumber, siteOffsetHours, siteDayStartUtc } from "./settings"
import type { SettingKey } from "./settings"
import type { Env } from "./env"

/**
 * 流水的来源/去向（写入 reason 列）。
 * 中文标签由前端各自映射（见 points.tsx / admin-points.tsx）—— 后端不需要
 * 展示文案，放在这里只会成为「导出但没人用」的死代码。
 *
 * ⚠️ `shop_sell` 是**用户商城的卖家收益**，性质与其他几个不同：
 *    它不是平台发放的积分，而是买家那笔 `shop` 支出转过来的（零和）。
 *    所以管理端的「累计发放」统计必须把它排除，否则会把用户间转账算成平台增发。
 */
export type PointReason =
  | "event"
  | "admin"
  | "redeem"
  | "shop"
  | "shop_sell"
  /**
   * 捐献奖励：用户捐了资源（AI 渠道 / 商汤 Key / frp / 代理 / 反代账号）后平台发的分。
   * 属于**平台增发**，与 `shop_sell`（用户间转移）不同，统计「累计发放」时**不能**排除。
   */
  | "donation"
  /**
   * 邀请奖励：每成功邀请 1 个好友注册，平台发给**邀请人**的分（一次性）。
   * 平台增发 —— 与捐献奖励同性质，统计「累计发放」时不能排除。
   */
  | "invite"
  /**
   * 邀请返佣：被邀请人赚到分（捐献 / 活动）时，平台按比例发给**邀请人**的分。
   * 同样是平台增发。⚠️ 它本身**不参与返佣**（见 COMMISSIONABLE_REASONS），
   * 否则 A→B→C 会层层抽成，积分总量指数膨胀。
   */
  | "invite_commission"
  /**
   * 用户间转账（转出 / 转入）。
   *
   * ⚠️ **零和转移**，不是平台增发 —— 两边一减一加、总量不变。所以：
   *   · 统计「累计发放」时必须排除（同 `shop_sell` 的口径）；
   *   · **绝不能**放进 COMMISSIONABLE_REASONS —— 给它返佣等于凭空造分
   *     （A 转给 B，B 的邀请人白抽 10%）。
   */
  | "transfer_out"
  | "transfer_in"
  /**
   * 每日签到奖励（基础 + 连续里程碑）。
   *
   * **平台增发** —— 与 `donation` / `invite` 同性质，统计「累计发放」时不能排除。
   * ⚠️ 同样**绝不能**进 `COMMISSIONABLE_REASONS`：签到是人人每天都能拿的，
   * 给它返佣等于让邀请人躺着抽成，积分会随活跃度指数膨胀。
   */
  | "checkin"

/** 单笔流水（下发给前端） */
export interface PointTransaction {
  id: string
  delta: number
  balance: number
  reason: string
  detail: string | null
  createdAt: string
}

export interface ApplyPointsOptions {
  userId: string
  /** 正数=增加，负数=减少 */
  delta: number
  reason: PointReason
  /** 展示文案（用户在流水里看到的这一行） */
  detail?: string | null
  /** 幂等键；同一用户同一键只会记一次。活动发放用 `event:<eventId>` */
  dedupKey?: string | null
  /** 操作人（管理员发放/扣减时填） */
  createdBy?: string | null
}

export interface ApplyPointsResult {
  /** 是否真的落账（幂等命中 / 余额不足时为 false） */
  applied: boolean
  /** 落账后的余额 */
  balance: number
  /** applied=false 的原因：duplicated=幂等命中；insufficient=余额不足 */
  reason?: "duplicated" | "insufficient"
}

/** 读余额；没有记录的用户视为 0（不建行，避免无意义写入） */
export async function getPointsBalance(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT balance FROM user_points WHERE user_id = ?")
    .bind(userId)
    .first<{ balance: number }>()
  return Number(row?.balance ?? 0)
}

/**
 * 变更积分并记流水 —— **唯一**的积分写入口。
 *
 * 顺序（每一步都在注释里说明为什么）：
 *   1. 确保余额行存在（新用户首次得积分时建行，UPSERT DO NOTHING 不覆盖已有余额）
 *   2. 在同一个 D1 batch 中先按余额条件插入流水，再条件更新余额
 *      流水受 dedup_key 唯一索引保护；重复请求不会先改余额再补偿
 *   3. 读回余额快照；余额不足时流水不会插入，避免扣成负数
 */
export async function applyPoints(
  env: Env,
  opts: ApplyPointsOptions
): Promise<ApplyPointsResult> {
  const { userId, delta, reason, detail, dedupKey, createdBy } = opts
  if (!Number.isFinite(delta) || delta === 0) {
    throw new ApiError(400, "积分变动值无效", "INVALID_INPUT")
  }
  const now = new Date().toISOString()

  await env.DB.prepare(
    "INSERT INTO user_points (user_id, balance, updated_at) VALUES (?, 0, ?) " +
      "ON CONFLICT(user_id) DO NOTHING"
  )
    .bind(userId, now)
    .run()

  const txId = uuid()
  const [ins, upd] = await env.DB.batch([
    // 只有余额足够时才插入负数流水；重复 dedup_key 的新 txId 不会出现。
    env.DB.prepare(
      `INSERT OR IGNORE INTO point_transactions
         (id, user_id, delta, balance, reason, detail, dedup_key, created_by, created_at)
       SELECT ?, ?, ?, (SELECT balance + ? FROM user_points WHERE user_id = ?), ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM user_points
           WHERE user_id = ? AND (? >= 0 OR balance >= ?)
        )`
    ).bind(
      txId, userId, delta, delta, userId, reason, detail ? detail.slice(0, 300) : null,
      dedupKey ?? null, createdBy ?? null, now, userId, delta, -delta
    ),
    env.DB.prepare(
      `UPDATE user_points
          SET balance = balance + ?, updated_at = ?
        WHERE user_id = ?
          AND (? >= 0 OR balance >= ?)
          AND EXISTS (
            SELECT 1 FROM point_transactions
             WHERE id = ? AND user_id = ?
          )`
    ).bind(delta, now, userId, delta, -delta, txId, userId),
  ])

  const inserted = ins.meta?.changes ?? 0
  const updated = upd.meta?.changes ?? 0
  const balance = await getPointsBalance(env, userId)
  if (inserted === 0) {
    const existing = dedupKey
      ? await env.DB.prepare(
          "SELECT 1 FROM point_transactions WHERE user_id = ? AND dedup_key = ? LIMIT 1"
        ).bind(userId, dedupKey).first()
      : null
    return { applied: false, balance, reason: existing ? "duplicated" : "insufficient" }
  }
  if (updated === 0) {
    await env.DB.prepare("DELETE FROM point_transactions WHERE id = ? AND user_id = ?")
      .bind(txId, userId).run()
    return { applied: false, balance, reason: "insufficient" }
  }
  const appliedBalance = await getPointsBalance(env, userId)

  if (delta > 0 && COMMISSIONABLE_REASONS.has(reason)) {
    await grantInviteCommission(env, {
      sourceUserId: userId,
      baseDelta: delta,
      sourceTxId: txId,
    })
  }

  return { applied: true, balance: appliedBalance }
}

/** 读某个用户的流水（倒序） */
export async function listPointTransactions(
  env: Env,
  userId: string,
  limit = 50
): Promise<PointTransaction[]> {
  const rows = await env.DB.prepare(
    `SELECT id, delta, balance, reason, detail, created_at
       FROM point_transactions
      WHERE user_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?`
  )
    .bind(userId, Math.min(Math.max(1, limit), 200))
    .all<{
      id: string
      delta: number
      balance: number
      reason: string
      detail: string | null
      created_at: string
    }>()
  return (rows.results ?? []).map((r) => ({
    id: r.id,
    delta: Number(r.delta),
    balance: Number(r.balance),
    reason: r.reason,
    detail: r.detail,
    createdAt: r.created_at,
  }))
}

/** 兑换参数（比例与开关），供前端展示「1 积分 = ? 元」 */
export async function getRedeemConfig(env: Env): Promise<{
  enabled: boolean
  /** **每 1 积分值多少元**（默认 1，支持小数） */
  yuanPerPoint: number
  /** 每日兑换次数上限（0 = 不限） */
  dailyLimit: number
  /** 用户商城：卖家交付后多少天自动确认收货（0 = 关闭） */
  autoConfirmDays: number
}> {
  // ⚠️ 用 getSettingBool 而不是 `=== "1"`：管理员保存过一次之后库里可能是 "true"
  //   （见 updateSettingsHandler 的布尔归一化 / admin.tsx 的 isSettingOn 注释）。
  const enabled = await getSettingBool(env, "points_enabled")
  // 比例允许小数（0.5 = 1 积分换 5 毛），但不允许负数；上限 100000 元/积分只是防手滑
  const raw = await getSettingNumber(env, "points_yuan_per_point")
  const yuanPerPoint = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 100_000) : 1
  const dailyLimit = Math.max(0, Math.round(await getSettingNumber(env, "points_redeem_daily_limit")))
  const autoConfirmDays = Math.max(
    0,
    Math.round(await getSettingNumber(env, "shop_auto_confirm_days"))
  )
  return { enabled, yuanPerPoint, dailyLimit, autoConfirmDays }
}

// ---------------------------------------------------------------------------
// 捐献奖励积分
// ---------------------------------------------------------------------------

/**
 * 捐献奖励的档位 —— 描述「**用户捐了什么**」，不是「解锁了什么权限」。
 *
 * `ai` 与 `sensenova` 的权限都是 ai，但一份自定义渠道和一把商汤 Key 价值不同，
 * 合成一个档位就没法分开定价。三个反代账号档位按**上游 provider** 分：
 * wb2api 通道的 provider 由管理员配置（workbuddy / trae / …），
 * qoder2api 通道固定是 qoder —— 一律按 provider 定价，而不是按「走哪条通道」，
 * 否则换个 provider 奖励就变了。
 *
 * 定义放这里而不是 donations.ts：读设置只有这一处，发放点却有三处
 * （donations.ts / qoder2api.ts / wb2api.ts），分散定义必然漂移。
 */
export const DONATION_REWARD_KINDS = [
  { key: "ai", label: "AI 渠道" },
  { key: "sensenova", label: "商汤 Key" },
  { key: "frp", label: "内网穿透" },
  { key: "proxy", label: "代理节点" },
  { key: "workbuddy", label: "WorkBuddy 反代账号" },
  { key: "qoder", label: "Qoder 反代账号" },
  { key: "trae", label: "Trae 反代账号" },
] as const

export type DonationRewardKind = (typeof DONATION_REWARD_KINDS)[number]["key"]

/**
 * 档位 → 设置项键。写成显式映射而不是拼字符串：设置项改名时编译期就会报错，
 * 也顺带让 `check-settings.mjs`（要求每个键在非 settings.ts 处被读到）能识别。
 */
export const DONATION_REWARD_SETTING_KEYS: Record<DonationRewardKind, SettingKey> = {
  ai: "donation_points_ai",
  sensenova: "donation_points_sensenova",
  frp: "donation_points_frp",
  proxy: "donation_points_proxy",
  workbuddy: "donation_points_workbuddy",
  qoder: "donation_points_qoder",
  trae: "donation_points_trae",
}

/**
 * 上游 provider 是**外部输入**（qoder2api 会话里带回来的），不能直接当键用 ——
 * 管理员配了个没见过的 provider 时，落到这里应当是「不发奖励」，而不是崩。
 */
export function isDonationRewardKind(v: string): v is DonationRewardKind {
  return Object.prototype.hasOwnProperty.call(DONATION_REWARD_SETTING_KEYS, v)
}

/** 档位 → 展示名（流水文案、管理端表单共用一处，避免三处各写一份） */
export function donationRewardLabel(kind: DonationRewardKind): string {
  return DONATION_REWARD_KINDS.find((k) => k.key === kind)?.label ?? kind
}

/** 各档位的积分数（管理端展示与发放共用同一套清洗规则） */
export async function getDonationRewardPoints(
  env: Env
): Promise<Record<DonationRewardKind, number>> {
  const out = {} as Record<DonationRewardKind, number>
  await Promise.all(
    DONATION_REWARD_KINDS.map(async ({ key }) => {
      const n = await getSettingNumber(env, DONATION_REWARD_SETTING_KEYS[key])
      // 0 或负数 = 该档位不发；上限 100000 只是防手滑多打几个 0（与兑换比例同一量级）
      out[key] = Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 100_000) : 0
    })
  )
  return out
}

/**
 * 每人每日「捐献奖励」发放次数上限（0 = 不限）。
 *
 * 读设置 + 清洗放在这里（而不是让三个发放点各读一次）：档位与上限是同一类旋钮，
 * 分散定义必然漂移。上限 1000 只是防手滑多打几个 0，与兑换上限同一量级。
 */
export async function getDonationDailyLimit(env: Env): Promise<number> {
  const n = await getSettingNumber(env, "donation_points_daily_limit")
  return Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 1000) : 0
}

/**
 * 今天（站点时区日界，与 countTodayRedeems 同口径）该用户已发的捐献奖励笔数。
 *
 * ⚠️ 口径是「**已发出的流水条数**」，所以历史补发的流水也会占当天额度 ——
 * 这是刻意的保守口径（宁可少发不可多发），且补发是一次性的、次日即无影响。
 */
async function countTodayDonationGrants(env: Env, userId: string): Promise<number> {
  const dayStart = siteDayStartUtc(new Date(), await siteOffsetHours(env))
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM point_transactions
      WHERE user_id = ? AND reason = 'donation' AND delta > 0 AND created_at >= ?`
  )
    .bind(userId, dayStart.toISOString())
    .first<{ c: number }>()
  return Number(row?.c ?? 0)
}

/**
 * 发放一笔捐献奖励积分。
 *
 * **刻意不抛错**：积分是附加收益，不能因为它失败就把「捐献审核通过」或
 * 「反代账号绑定成功」本身回滚 —— 那两件事已经做完了，回滚反而更糟。失败只记日志。
 *
 * 返回实际落账的积分数（0 = 该档位关闭，或幂等命中已发过）。
 * 幂等由调用方给的 `dedupKey` 保证（同一笔捐献重复审核只发一次）。
 */
export async function grantDonationReward(
  env: Env,
  opts: {
    userId: string
    kind: DonationRewardKind
    /** 幂等键，如 `donation:<单据id>` / `qoder2api:<绑定id>` */
    dedupKey: string
    /** 流水里给用户看的那一行 */
    detail: string
  }
): Promise<number> {
  try {
    const points = (await getDonationRewardPoints(env))[opts.kind]
    if (points <= 0) return 0

    // 每人每日次数闸：捐献分是「可重复赚」的通道，给刷分加一个硬顶。
    // 超限就**不发** —— 捐献本身早已通过审核 / 绑定成功、权限也给了，这里只管分。
    // （并发下可能略微超出上限几笔：两个请求同时读到 used=limit-1。属可接受的宽松，
    //   要更严得做成条件更新，代价不值。）
    const dailyLimit = await getDonationDailyLimit(env)
    if (dailyLimit > 0) {
      const used = await countTodayDonationGrants(env, opts.userId)
      if (used >= dailyLimit) {
        console.warn(
          `捐献奖励已达每日上限（${used}/${dailyLimit}），本次不发：` +
            `${opts.userId} ${opts.kind} ${opts.dedupKey}`
        )
        return 0
      }
    }

    const res = await applyPoints(env, {
      userId: opts.userId,
      delta: points,
      reason: "donation",
      detail: opts.detail,
      dedupKey: opts.dedupKey,
    })
    return res.applied ? points : 0
  } catch (err) {
    console.error("发放捐献奖励积分失败:", opts.userId, opts.kind, err)
    return 0
  }
}

// ---------------------------------------------------------------------------
// 邀请奖励 / 邀请返佣（2026-09-30）
// ---------------------------------------------------------------------------

/**
 * 哪些积分来源参与「邀请返佣」。
 *
 * 只认**平台主动增发**、且**由被邀请人的真实贡献换来**的两类：
 *   · `donation` —— 捐献资源审核通过
 *   · `event`    —— 活动奖励
 *
 * 刻意**不含**（每一条都有具体理由，别顺手加回来）：
 *   · `admin`             管理员手动发放 —— 对它返佣等于「管理员发 1000 分，邀请者白得 100」，
 *                         而且是人工操作，不该有连带效应；
 *   · `shop_sell`         用户商城的卖家收益 —— 那是买家 `shop` 支出的转移（零和），
 *                         再抽一份给邀请人 = 平台凭空增发；
 *   · `invite`            邀请奖励**本身** —— 返佣它就成了 A→B→C 层层抽成（多级传销式增发）；
 *   · `invite_commission` 返佣本身 —— 递归；
 *   · `redeem` / `shop`   用户消费，本来就是负数（上面又要求 delta > 0，双重排除）。
 */
const COMMISSIONABLE_REASONS: ReadonlySet<string> = new Set(["donation", "event"])

export interface InvitePointsConfig {
  /** 总开关 */
  enabled: boolean
  /** 每邀请 1 个好友得的积分（0 = 不发） */
  perFriend: number
  /** 返佣比例（%），0 = 关闭 */
  commissionPercent: number
  /** 每人每日通过邀请（奖励 + 返佣）最多拿多少分，0 = 不限 */
  dailyLimit: number
  /** 是否只把「真正消耗了次数」的邀请算作有效邀请 */
  requireConsumed: boolean
}

/**
 * 读邀请奖励配置。清洗规则与捐献档位同一套口径（负数→0，上限防手滑多打 0）。
 * 四个数值键与两个开关键都在这里被读到 —— `check-settings.mjs` 要求设置项
 * 必须在**非 settings.ts** 的文件里被真正消费，否则判为「假开关」。
 */
export async function getInvitePointsConfig(env: Env): Promise<InvitePointsConfig> {
  const [
    enabled,
    requireConsumed,
    rawPer,
    rawPct,
    rawDaily,
  ] = await Promise.all([
    getSettingBool(env, "invite_points_enabled"),
    getSettingBool(env, "invite_points_require_consumed"),
    getSettingNumber(env, "invite_points_per_friend"),
    getSettingNumber(env, "invite_points_commission_percent"),
    getSettingNumber(env, "invite_points_daily_limit"),
  ])

  const positiveInt = (n: number, max: number): number =>
    Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), max) : 0

  return {
    enabled,
    perFriend: positiveInt(rawPer, 100_000),
    // 比例允许小数（2.5%），上限 100%（超过 100% 是负数发放，没有意义）
    commissionPercent:
      Number.isFinite(rawPct) && rawPct > 0 ? Math.min(rawPct, 100) : 0,
    dailyLimit: positiveInt(rawDaily, 1_000_000),
    requireConsumed,
  }
}

/**
 * 溯源「这个用户是谁邀请来的」。
 *
 * 链路与 `invite-rewards.ts` 完全一致：`users.invite_code_id` → `invite_codes.created_by`。
 * 返回 null 表示：不是邀请注册的 / 邀请码已被删 / **自己邀请自己**
 * （后者必须挡掉 —— 否则「建码 → 自己用 → 奖励回自己口袋」就是明摆着的刷分）。
 */
async function findInviter(env: Env, inviteeId: string): Promise<string | null> {
  const invitee = await env.DB.prepare("SELECT invite_code_id FROM users WHERE id = ?")
    .bind(inviteeId)
    .first<{ invite_code_id: string | null }>()
  if (!invitee?.invite_code_id) return null

  const row = await env.DB.prepare("SELECT created_by FROM invite_codes WHERE id = ?")
    .bind(invitee.invite_code_id)
    .first<{ created_by: string | null }>()
  const inviterId = row?.created_by ?? null
  if (!inviterId || inviterId === inviteeId) return null
  return inviterId
}

/**
 * 今天（站点时区日界，与 countTodayDonationGrants / countTodayRedeems 同口径）
 * 该用户通过邀请拿到的积分合计。
 *
 * 口径 = `reason IN ('invite','invite_commission')` 且 `delta > 0` 的流水合计 ——
 * **奖励与返佣共用同一个额度**，所以两条发放路径都要先过 `inviteDailyAllowance()`。
 */
async function countTodayInvitePoints(env: Env, userId: string): Promise<number> {
  const dayStart = siteDayStartUtc(new Date(), await siteOffsetHours(env))
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(delta), 0) AS s FROM point_transactions
      WHERE user_id = ? AND reason IN ('invite','invite_commission')
        AND delta > 0 AND created_at >= ?`
  )
    .bind(userId, dayStart.toISOString())
    .first<{ s: number }>()
  return Number(row?.s ?? 0)
}

/**
 * 今天还剩多少「邀请积分额度」。
 *
 * 返回 `Infinity` 表示不限（dailyLimit = 0）—— 直接用 `Math.min(想发的数, 额度)`
 * 就能统一处理「不限」与「只剩一点」两种情况，不必在调用点写分支。
 */
async function inviteDailyAllowance(
  env: Env,
  userId: string,
  cfg: InvitePointsConfig
): Promise<number> {
  if (cfg.dailyLimit <= 0) return Number.POSITIVE_INFINITY
  const used = await countTodayInvitePoints(env, userId)
  return Math.max(0, cfg.dailyLimit - used)
}

/**
 * 邀请奖励：带邀请码注册成功后，给邀请人发一笔固定积分。
 *
 * 返回实际落账的积分数（0 = 没发）。**永不抛错** —— 调用点在注册主流程里，
 * 那时用户行 / 域名 / 邮箱都已经建好，不能因为一笔附加奖励失败把新用户挡在门外。
 *
 * 幂等键 `invite:<被邀请人id>`：同一个被邀请人一辈子只发一次。
 */
export async function grantInvitePoints(
  env: Env,
  opts: { inviteeId: string; inviteeUsername: string; codeConsumed: boolean }
): Promise<number> {
  try {
    const cfg = await getInvitePointsConfig(env)
    if (!cfg.enabled || cfg.perFriend <= 0) return 0

    // 「有效邀请」的门槛：默认要求邀请码**真的被消费了一次**。
    // 限时开放注册期间，不含权限的码不消耗次数（见 HANDOFF 20.2），
    // 那种「邀请」等于任何人都能做到的事，不该给钱 —— 也是防小号刷分的关键闸门。
    if (cfg.requireConsumed && !opts.codeConsumed) return 0

    const inviterId = await findInviter(env, opts.inviteeId)
    if (!inviterId) return 0

    const allowed = await inviteDailyAllowance(env, inviterId, cfg)
    if (allowed <= 0) return 0
    const amount = Math.min(cfg.perFriend, allowed)

    const res = await applyPoints(env, {
      userId: inviterId,
      delta: amount,
      reason: "invite",
      detail: `邀请好友 ${opts.inviteeUsername} 注册成功`,
      dedupKey: `invite:${opts.inviteeId}`,
    })
    return res.applied ? amount : 0
  } catch (err) {
    console.error("发放邀请奖励积分失败:", opts.inviteeId, err)
    return 0
  }
}

/**
 * 邀请返佣：被邀请人赚到分时，给其邀请人按比例抽成。
 *
 * **永不抛错** —— 它是在*别人的*积分发放里顺带做的附加动作（由 applyPoints 调用），
 * 失败绝不能影响那一笔主流水（用户捐了资源却因为返佣出错而拿不到捐献分，荒唐）。
 */
async function grantInviteCommission(
  env: Env,
  opts: { sourceUserId: string; baseDelta: number; sourceTxId: string }
): Promise<void> {
  try {
    // ⚠️ 先只读**总开关**（1 次查询）：这个函数挂在 applyPoints 里，
    //    每一笔捐献 / 活动发放都会走到这儿 —— 默认关闭时这是唯一开销。
    //    不能一上来就读 getInvitePointsConfig（那是 5 个设置项的并行查询）。
    if (!(await getSettingBool(env, "invite_points_enabled"))) return

    const cfg = await getInvitePointsConfig(env)
    if (cfg.commissionPercent <= 0) return

    // 积分是整数：不足 1 分的零头直接**不发**（如 3 分 × 10% = 0.3 分）。
    // 向下取整而不是四舍五入 —— 宁可少发，也不给「刷一堆小额流水凑返佣」留空间。
    const amount = Math.floor((opts.baseDelta * cfg.commissionPercent) / 100)
    if (amount < 1) return

    const inviterId = await findInviter(env, opts.sourceUserId)
    if (!inviterId) return

    const allowed = await inviteDailyAllowance(env, inviterId, cfg)
    if (allowed <= 0) return
    const grant = Math.min(amount, allowed)

    const who = await env.DB.prepare("SELECT username FROM users WHERE id = ?")
      .bind(opts.sourceUserId)
      .first<{ username: string }>()

    await applyPoints(env, {
      userId: inviterId,
      delta: grant,
      reason: "invite_commission",
      detail:
        `好友 ${who?.username ?? "被邀请人"} 获得 ${opts.baseDelta} 积分的 ` +
        `${cfg.commissionPercent}% 返佣`,
      // 幂等键挂在**源流水**上：同一笔源流水只会返一次（重放 / 重试都安全）
      dedupKey: `invite-commission:${opts.sourceTxId}`,
    })
  } catch (err) {
    console.error("发放邀请返佣失败:", opts.sourceUserId, err)
  }
}

// ---- 用户间转账 ----

/**
 * 用户间转账：**只需要转出方确认**（不需要收款方同意），凭用户名转给对方。
 *
 * 零和转移：转出方 -amount、收款方 +amount，平台积分总量不变。
 * ⚠️ 两个 reason 都**不在** COMMISSIONABLE_REASONS 里 —— 转账不是平台增发，
 *    给它返佣等于凭空造分（A 转给 B，B 的邀请人白抽 10%）。
 *
 * 一致性：**先扣后加**。扣款是原子的（`balance >= ?` 写进 WHERE，不足直接失败，
 * 不会出现负余额）；加款失败时把扣款**连流水一起回滚**（用原始 SQL，不留补偿流水）。
 */
export async function transferPoints(
  env: Env,
  opts: {
    fromUserId: string
    fromUsername: string
    toUserId: string
    toUsername: string
    amount: number
  }
): Promise<{ ok: true; balance: number } | { ok: false; error: string }> {
  const amount = Math.floor(opts.amount)
  if (!Number.isFinite(amount) || amount < 1) {
    return { ok: false, error: "转账数量必须是不小于 1 的整数" }
  }
  if (opts.fromUserId === opts.toUserId) {
    return { ok: false, error: "不能转给自己" }
  }

  // 一次转账的两条流水用同一个 txId 关联，便于日后对账
  const txId = uuid()
  const outKey = `transfer_out:${txId}`

  const out = await applyPoints(env, {
    userId: opts.fromUserId,
    delta: -amount,
    reason: "transfer_out",
    detail: `转给 @${opts.toUsername} ${amount} 积分`,
    dedupKey: outKey,
  })
  if (!out.applied) return { ok: false, error: "积分不足" }

  try {
    const inn = await applyPoints(env, {
      userId: opts.toUserId,
      delta: amount,
      reason: "transfer_in",
      detail: `收到 @${opts.fromUsername} 转入的 ${amount} 积分`,
      dedupKey: `transfer_in:${txId}`,
    })
    if (!inn.applied) throw new Error("入账未生效")
  } catch (err) {
    // 回滚转出：余额加回去 + 删掉那条流水（原始 SQL，避免再留一条补偿流水）
    const now = new Date().toISOString()
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE user_points SET balance = balance + ?, updated_at = ? WHERE user_id = ?"
      ).bind(amount, now, opts.fromUserId),
      env.DB.prepare("DELETE FROM point_transactions WHERE user_id = ? AND dedup_key = ?").bind(
        opts.fromUserId,
        outKey
      ),
    ])
    console.error("转账入账失败，已回滚转出:", opts.fromUserId, "->", opts.toUserId, err)
    return { ok: false, error: "转账失败，请稍后重试（积分未变动）" }
  }

  return { ok: true, balance: out.balance }
}

/** 今日（站点时区日界）该用户已兑换次数 */
async function countTodayRedeems(env: Env, userId: string): Promise<number> {
  const dayStart = siteDayStartUtc(new Date(), await siteOffsetHours(env))
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM point_transactions
      WHERE user_id = ? AND reason = 'redeem' AND delta < 0 AND created_at >= ?`
  )
    .bind(userId, dayStart.toISOString())
    .first<{ c: number }>()
  return Number(row?.c ?? 0)
}

/**
 * 用积分兑换中转站余额。
 *
 * ⚠️ 顺序是**先扣积分、再调 NewAPI 加余额，失败则把积分退回**。
 * 反过来（先加余额再扣）会在扣减失败时白送钱；而「先扣后退」最坏情况
 * 只是用户积分短暂被占用几秒，不会丢。
 *
 * 未绑定中转站账号时直接拒绝（不像活动奖励那样转人工）—— 兑换是用户主动发起、
 * 有明确预期的操作，「扣了积分却说发放失败要等人工」体验更差，不如在扣分前拦住。
 */
export async function redeemPoints(
  env: Env,
  userId: string,
  username: string,
  points: number
): Promise<{ ok: true; balance: number; amount: number; symbol: string; detail: string }> {
  const cfg = await getRedeemConfig(env)
  if (!cfg.enabled) throw new ApiError(400, "积分兑换暂未开放", "POINTS_DISABLED")

  const amountPoints = Math.floor(points)
  if (!Number.isFinite(amountPoints) || amountPoints < 1) {
    throw new ApiError(400, "兑换积分必须是正整数", "INVALID_INPUT")
  }

  // 绑定检查放在扣分之前（见函数注释）
  const account = await env.DB.prepare(
    "SELECT newapi_user_id FROM newapi_accounts WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ newapi_user_id: number }>()
  if (!account?.newapi_user_id) {
    throw new ApiError(
      400,
      "你还未开通 AI 中转站，无法兑换余额。请先在「AI 中转站」页面开通账号。",
      "NOT_BOUND"
    )
  }

  if (cfg.dailyLimit > 0) {
    const used = await countTodayRedeems(env, userId)
    if (used >= cfg.dailyLimit) {
      throw new ApiError(
        429,
        `今日兑换次数已达上限（${cfg.dailyLimit} 次），请明天再来。`,
        "REDEEM_LIMIT"
      )
    }
  }

  // 比例是「每 1 积分值多少元」，所以是乘法；保留两位小数，免得流水文案与
  // 实际入账额度（按四舍五入后的金额换算）对不上。
  const amount = Math.round(amountPoints * cfg.yuanPerPoint * 100) / 100
  // 比例很小时（如 0.001 元/积分）兑 1 积分会被四舍五入成 0 元 —— 别白扣积分
  if (amount <= 0) {
    throw new ApiError(
      400,
      "当前兑换比例下这些积分换不到钱，请多攒一些再兑换。",
      "AMOUNT_TOO_SMALL"
    )
  }
  const perUnit = Number(await getSetting(env, "newapi_quota_per_unit")) || 500_000
  const rawQuota = Math.round(amount * perUnit)
  const { symbol } = await getCurrencyInfo(env)

  // 1. 扣积分（余额不足会在 applyPoints 里被条件 UPDATE 拦下）
  const deducted = await applyPoints(env, {
    userId,
    delta: -amountPoints,
    reason: "redeem",
    detail: `兑换中转站余额 ${symbol}${formatAmount(amount)}`,
  })
  if (!deducted.applied) {
    throw new ApiError(400, "积分不足，无法兑换", "INSUFFICIENT_POINTS")
  }

  // 2. 加余额；失败则退回积分（用户不会因为一次网络抖动丢积分）
  try {
    await adminSetQuota(env, account.newapi_user_id, rawQuota, "add")
  } catch (err) {
    await applyPoints(env, {
      userId,
      delta: amountPoints,
      reason: "redeem",
      detail: `兑换失败退回（${symbol}${formatAmount(amount)}）`,
    })
    const msg = err instanceof Error ? err.message.slice(0, 120) : ""
    throw new ApiError(
      502,
      `兑换失败，积分已退回：${msg || "中转站暂时不可用，请稍后重试"}`,
      "REDEEM_FAILED"
    )
  }

  await audit(
    env,
    userId,
    "points.redeem",
    `${username} 用 ${amountPoints} 积分兑换 ${symbol}${formatAmount(amount)} 中转站余额`
  )

  return {
    ok: true,
    balance: deducted.balance,
    amount,
    symbol,
    detail: `已兑换 ${symbol}${formatAmount(amount)} 到你的中转站余额。`,
  }
}

/** 金额展示：整数不带小数，非整数保留两位（避免 1.5 显示成 1.50 / 2 显示成 2.00） */
function formatAmount(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

/**
 * 管理端：发放 / 扣减积分。
 * 扣减时余额不足直接报错（不静默扣成负数）。
 */
export async function adminAdjustPoints(
  env: Env,
  adminId: string,
  userId: string,
  delta: number,
  detail: string
): Promise<{ balance: number }> {
  const value = Math.trunc(delta)
  if (!Number.isFinite(value) || value === 0) {
    throw new ApiError(400, "积分变动值必须是非零整数", "INVALID_INPUT")
  }
  const res = await applyPoints(env, {
    userId,
    delta: value,
    reason: "admin",
    detail: detail || (value > 0 ? "管理员发放积分" : "管理员扣减积分"),
    createdBy: adminId,
  })
  if (!res.applied) {
    if (res.reason === "insufficient") {
      throw new ApiError(400, "该用户积分不足，无法扣减", "INSUFFICIENT_POINTS")
    }
    throw new ApiError(409, "重复操作", "DUPLICATED")
  }
  return { balance: res.balance }
}
