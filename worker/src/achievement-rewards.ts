/**
 * 成就奖励：用户成就点每满 N 点（默认 10），发放一份 NewAPI「成就奖励」订阅。
 *
 * 与 invite-rewards.ts 的关系：两套**独立**的奖励，各记各的账、各防各的重。
 *   - 邀请奖励：按「被邀请人」去重，一次解锁发一次。
 *   - 成就奖励：按「成就点档位」去重，每满 N 点发一份（10/20/30…各一次）。
 *
 * 防重复：achievement_rewards 表按 user_id 记录已发放到第几档（granted_tiers）。
 * 成就点是实时计算的、不落库，所以必须用这张表挡住「每次看成就页都重发」。
 *
 * 失败不阻断主流程（奖励是附加项），只记日志/审计。
 */
import { audit, getSetting, getSettingNumber } from "./settings"
import { adminGrantSubscription } from "./newapi-client"
import type { Env } from "./env"

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

    // 当前成就点对应的档位（满 1 档 = 满 N 点）
    const tier = Math.floor(points / pointsPerTier)
    if (tier <= 0) return { granted: 0 }

    // 已发放的档位
    const row = await env.DB.prepare(
      "SELECT granted_tiers FROM achievement_rewards WHERE user_id = ?"
    )
      .bind(userId)
      .first<{ granted_tiers: number }>()
    const granted = row?.granted_tiers ?? 0
    if (tier <= granted) return { granted: 0 }

    // 必须已开通中转站（订阅挂在 NewAPI 侧用户 id 上），否则无从发放
    const account = await env.DB.prepare(
      "SELECT newapi_user_id FROM newapi_accounts WHERE user_id = ?"
    )
      .bind(userId)
      .first<{ newapi_user_id: number }>()
    if (!account?.newapi_user_id) return { granted: 0 }

    // 补发差额（第 granted+1 档 … 第 tier 档）
    let okCount = 0
    for (let i = granted + 1; i <= tier; i++) {
      const res = await adminGrantSubscription(env, account.newapi_user_id, planId)
      if (!res.ok) break // 失败即停，避免反复打 NewAPI
      okCount++
    }

    // 记录实际发放到的档位（部分失败也记，下次从断点续）
    if (okCount > 0) {
      const now = new Date().toISOString()
      await env.DB.prepare(
        `INSERT INTO achievement_rewards (user_id, granted_tiers, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET granted_tiers = excluded.granted_tiers, updated_at = excluded.updated_at`
      )
        .bind(userId, granted + okCount, now)
        .run()

      await audit(
        env,
        userId,
        "achievement.reward",
        `成就点达 ${tier * pointsPerTier} 点，发放成就订阅 ${okCount} 份（套餐 ${planId}）`
      )
    }

    return { granted: okCount }
  } catch (err) {
    console.error("成就奖励发放失败:", username, err)
    return { granted: 0 }
  }
}
