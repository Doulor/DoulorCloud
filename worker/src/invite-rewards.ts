/**
 * 邀请奖励：被邀请人解锁 AI 权限时，给其邀请人开一张「邀请套餐」订阅。
 *
 * 两种来源、不同奖励（套餐 id 由调用方传入）：
 *   - workbuddy 反代账号绑定（wb2api）→ 套餐 A（默认 ¥500/天）
 *   - 其他 AI 渠道捐献审核通过（donations: ai / sensenova）→ 套餐 B（默认 ¥200/天）
 *
 * 防重复：invite_rewards 表按「被邀请人」去重 —— 同一被邀请人只发一次，
 * 不管他绑定几个账号、走几次解锁、捐几份资源。
 *
 * 失败不阻断主流程（奖励是附加项），只记审计。
 */
import { audit, getSetting } from "./settings"
import { adminGrantSubscription } from "./newapi-client"
import type { Env } from "./env"

export async function grantInviteReward(
  env: Env,
  invitee: { id: string; username: string },
  planId: number
): Promise<void> {
  try {
    const enabled = (await getSetting(env, "invite_reward_enabled")) === "1"
    if (!enabled) return
    if (!planId || planId <= 0) return

    // 1. 被邀请人必须是用邀请码注册的，才能溯源到邀请人
    const inviteeRow = await env.DB.prepare(
      "SELECT invite_code_id FROM users WHERE id = ?"
    )
      .bind(invitee.id)
      .first<{ invite_code_id: string | null }>()
    if (!inviteeRow?.invite_code_id) return

    // 2. 邀请人 = 邀请码的创建者
    const inviter = await env.DB.prepare(
      "SELECT created_by FROM invite_codes WHERE id = ?"
    )
      .bind(inviteeRow.invite_code_id)
      .first<{ created_by: string | null }>()
    const inviterId = inviter?.created_by
    if (!inviterId || inviterId === invitee.id) return

    // 3. 防重复：同一被邀请人只发一次
    const already = await env.DB.prepare(
      "SELECT 1 AS x FROM invite_rewards WHERE invitee_user_id = ? LIMIT 1"
    )
      .bind(invitee.id)
      .first()
    if (already) return

    // 4. 给邀请人开订阅（NewAPI 侧按 user id 定位）
    const inviterAccount = await env.DB.prepare(
      "SELECT newapi_user_id FROM newapi_accounts WHERE user_id = ?"
    )
      .bind(inviterId)
      .first<{ newapi_user_id: number }>()
    if (!inviterAccount?.newapi_user_id) return // 邀请人自己还没开通中转站，无从发订阅

    //    ⚠️ strictLimit：邀请套餐若被设了限购（max_purchase_per_user），NewAPI 的拒绝是
    //    **真实失败**——不能像免费订阅重复领取那样当成功（那会让邀请人静默丢奖励，
    //    同 2026-10-08 成就奖励事故的教训）。
    const granted = await adminGrantSubscription(env, inviterAccount.newapi_user_id, planId, {
      strictLimit: true,
    })

    if (!granted.ok) {
      // 失败**不记去重**：留出「被邀请人下次解锁/捐献时重试」的机会；
      // 同时写审计让管理员可见（记了去重就等于永久丢失，且没有任何痕迹）。
      await audit(
        env,
        inviterId,
        "invite.reward_failed",
        `邀请奖励发放失败：被邀请人 ${invitee.username}，套餐 ${planId}，原因：${granted.message}`
      )
      console.error("邀请奖励发放失败(NewAPI):", invitee.username, granted.message)
      return
    }

    // 5. 记录发放（防重复 + 供邀请页展示）
    await env.DB.prepare(
      `INSERT INTO invite_rewards (invitee_user_id, inviter_user_id, granted_at, plan_id)
       VALUES (?, ?, ?, ?)`
    )
      .bind(invitee.id, inviterId, new Date().toISOString(), planId)
      .run()

    await audit(
      env,
      inviterId,
      "invite.reward",
      `被邀请人 ${invitee.username} 解锁 AI 权限，奖励邀请订阅（套餐 ${planId}）`
    )
  } catch (err) {
    console.error("邀请奖励发放失败:", invitee.username, err)
  }
}
