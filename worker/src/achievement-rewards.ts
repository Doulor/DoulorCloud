/**
 * 成就奖励：用户成就点每满 N 点（默认 10），发放一份 NewAPI「成就奖励」订阅。
 *
 * 与 invite-rewards.ts 的关系：两套**独立**的奖励，各记各的账、各防各的重。
 *   - 邀请奖励：按「被邀请人」去重，一次解锁发一次。
 *   - 成就奖励：按「成就点档位」对齐，应发份数 = floor(成就点 / N)。
 *
 * ★ 2026-10-08 起改为「两端对齐」（真相源 = NewAPI）：
 *   账本 `granted_tiers` 只记「上次核对结果」，**不再作为发放依据**。
 *   每次检查（用户打开成就页）时：
 *     - 读 NewAPI 实际活跃份数 actual；**读取失败即中止**（不确定真实状态时，
 *       「不动作」永远安全，「按旧账本补发」可能造成多发）
 *     - actual < 应发 → 补差额（严格模式：NewAPI 限购拒绝视为真实失败，不再吞掉）
 *     - actual > 应发 → 撤回多余的：只删「完全未使用」且最新创建的份，
 *       已消费的份一律不动（抹掉它 = 篡改用户已发生的消费账）
 *     - actual == 应发 → 只纠正账本漂移，不发不撤
 *
 * 为什么不再信任「发放调用没抛错」：NewAPI 套餐可设 `max_purchase_per_user`，
 * 达上限后调用返回「已达到该套餐购买上限」——旧实现把它当成功（那个宽容分支
 * 是为「免费订阅重复领取」设计的），于是账本一路推进而订阅没落地
 * （2026-10-08 线上：限购 5 份的套餐，用户第 6 份起的奖励被静默吞掉）。
 * 对齐以「实际持有」为准后，这类漂移无论怎么产生都会在下次检查时被发现；
 * 管理员在 NewAPI 调好套餐限购后，系统会在用户下次打开成就页时**自动补齐**，
 * 不需要人工补数据。
 *
 * 失败不阻断主流程（奖励是附加项），只记日志/审计。
 */
import { audit, getSetting, getSettingNumber } from "./settings"
import {
  adminDeleteUserSubscription,
  adminGrantSubscription,
  fetchUserSubscriptions,
  listSubscriptionPlans,
} from "./newapi-client"
import type { Env } from "./env"

/** 写账本：记录「上次核对时用户实际持有的份数」（成就点实时计算、不落库，这张表防重复用） */
async function writeLedger(env: Env, userId: string, tiers: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO achievement_rewards (user_id, granted_tiers, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET granted_tiers = excluded.granted_tiers, updated_at = excluded.updated_at`
  )
    .bind(userId, tiers, new Date().toISOString())
    .run()
}

/** 读账本（上次核对结果）；无行返回 null */
async function readLedger(env: Env, userId: string): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT granted_tiers FROM achievement_rewards WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ granted_tiers: number }>()
  return row?.granted_tiers ?? null
}

/**
 * 应发份数超过套餐限购时的提示语（给审计用），无需提示返回 null。
 * 预警是锦上添花：读不到套餐（未配置 / NewAPI 抖动）就安静放弃，不能阻断发放。
 */
async function planLimitHint(env: Env, planId: number, tier: number): Promise<string | null> {
  const plans = await listSubscriptionPlans(env)
  const plan = plans.find((p) => p.planId === planId)
  if (!plan || plan.maxPurchasePerUser <= 0 || tier <= plan.maxPurchasePerUser) return null
  return (
    `该套餐在 NewAPI 限制每人最多 ${plan.maxPurchasePerUser} 份，而成就要发到第 ${tier} 份 —— ` +
    `请在 NewAPI 调整套餐限购（max_purchase_per_user），否则后续档位无法发放`
  )
}

export async function grantAchievementRewards(
  env: Env,
  userId: string,
  username: string,
  points: number
): Promise<{ granted: number }> {
  try {
    const enabled = (await getSetting(env, "achievement_reward_enabled")) === "1"
    if (!enabled) return { granted: 0 }

    const planId = await getSettingNumber(env, "achievement_reward_plan_id")
    if (!planId || planId <= 0) return { granted: 0 }

    const pointsPerTier = await getSettingNumber(env, "achievement_reward_points")
    if (!pointsPerTier || pointsPerTier <= 0) return { granted: 0 }

    // 应发份数（满 1 档 = 满 N 点）
    const tier = Math.floor(points / pointsPerTier)
    if (tier <= 0) return { granted: 0 }

    // 必须已开通中转站（订阅挂在 NewAPI 侧用户 id 上），否则无从发放
    const account = await env.DB.prepare(
      "SELECT newapi_user_id FROM newapi_accounts WHERE user_id = ?"
    )
      .bind(userId)
      .first<{ newapi_user_id: number }>()
    if (!account?.newapi_user_id) return { granted: 0 }

    // ---- ① 读 NewAPI 实际持有（真相源；读失败即中止，不推进任何账） ----
    let active: { id: number; amountUsed: number; endTime: number }[]
    try {
      const all = await fetchUserSubscriptions(env, account.newapi_user_id)
      active = all.filter((s) => s.planId === planId && s.status === "active")
    } catch (err) {
      console.error("成就奖励：读取订阅列表失败，本次不对齐:", username, err)
      return { granted: 0 }
    }

    // ---- ② 少发：补差额 ----
    if (active.length < tier) {
      const need = tier - active.length

      // 预检：套餐限购已知会挡住补发（应发份数 > max_purchase_per_user）时，
      // 不空跑创建调用，直接记一次失败审计（去重：仅状态变化时写，别每次刷屏）。
      const blockHint = await planLimitHint(env, planId, tier)
      if (blockHint) {
        const before = await readLedger(env, userId)
        await writeLedger(env, userId, active.length)
        if (before !== active.length) {
          await audit(
            env,
            userId,
            "achievement.reward_failed",
            `成就奖励补发未完成：应发 ${tier} 份、持有 ${active.length} 份。${blockHint}`
          )
        }
        return { granted: 0 }
      }

      let okCount = 0
      let lastErr = ""
      for (let i = 0; i < need; i++) {
        // strictLimit：限购拒绝是真实失败，绝不能当成功（那正是 2026-10-08 事故根因）
        const res = await adminGrantSubscription(env, account.newapi_user_id, planId, {
          strictLimit: true,
        })
        if (!res.ok) {
          lastErr = res.message
          break
        }
        okCount++
      }

      const before = await readLedger(env, userId)
      await writeLedger(env, userId, active.length + okCount)

      if (okCount > 0) {
        await audit(
          env,
          userId,
          "achievement.reward",
          `成就点达 ${tier * pointsPerTier} 点，对齐补发成就订阅 ${okCount} 份（套餐 ${planId}，持有 ${active.length + okCount}/${tier}）`
        )
      }
      if (okCount < need && before !== active.length + okCount) {
        // 去重：上次核对结果与本次相同就不重复写（避免每次打开成就页都刷一条审计）
        const limitish = /上限|limit/i.test(lastErr)
        await audit(
          env,
          userId,
          "achievement.reward_failed",
          `成就奖励补发未完成：应发 ${tier} 份、持有 ${active.length} 份，本次补 ${okCount} 份后停止` +
            (lastErr ? `（原因：${lastErr}）` : "") +
            (limitish
              ? "。该套餐可能在 NewAPI 设了每人限购（max_purchase_per_user），请检查/调整"
              : "")
        )
      }
      return { granted: okCount }
    }

    // ---- ③ 多发：撤回多余的（只动未使用的最新份） ----
    if (active.length > tier) {
      const extra = active.length - tier
      const removable = active
        .filter((s) => s.amountUsed === 0 && s.id > 0)
        .sort((a, b) => b.endTime - a.endTime || b.id - a.id)
      let removed = 0
      for (const s of removable) {
        if (removed >= extra) break
        const res = await adminDeleteUserSubscription(env, s.id)
        if (!res.ok) break
        removed++
      }

      const before = await readLedger(env, userId)
      await writeLedger(env, userId, active.length - removed)

      if (removed > 0) {
        await audit(
          env,
          userId,
          "achievement.reward_revoke",
          `成就奖励对齐撤回：应发 ${tier} 份、持有 ${active.length} 份，撤回未使用 ${removed} 份（套餐 ${planId}）`
        )
      }
      if (removed < extra && before !== active.length - removed) {
        // 同上：状态没变就不重复写（撤回受阻是持续性状态，不代表每次都要提醒）
        await audit(
          env,
          userId,
          "achievement.reward_revoke_blocked",
          `成就奖励对齐：应发 ${tier} 份但持有 ${active.length} 份，其中 ${extra - removed} 份已被使用，未撤回（套餐 ${planId}）`
        )
      }
      return { granted: 0 }
    }

    // ---- ④ 已对齐：只在账本漂移时纠正 ----
    if ((await readLedger(env, userId)) !== tier) {
      await writeLedger(env, userId, tier)
    }
    return { granted: 0 }
  } catch (err) {
    console.error("成就奖励发放失败:", username, err)
    return { granted: 0 }
  }
}
