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
 * ⚠️ 去重必须是**原子占位**（`INSERT OR IGNORE` + `changes`），不能「先查、再发、
 *    最后记录」（2026-10-09 修，issue #38）。旧实现是 read-then-act：三条调用点
 *    （wb2api / cli2api / donations）都作用在同一个被邀请人上，而 `aiGranted` 取的是
 *    调用方读的**用户快照**（`wb2api.ts:536`），窗口 = 读快照到写权限之间的整段
 *    （含一次网关 poll 往返）⇒ 两条路径并发时都会读到「没有记录」，各开一张订阅。
 *    唯一主键只拦住了**记录行**、没拦住**订阅**：后到的 INSERT 撞主键抛错，被最外层
 *    catch 静默吞掉 —— 实测订阅开 2 张、账只记 1 笔。
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

    // 3. 邀请人自己还没开通中转站，无从发订阅 —— 放在占位**之前**：
    //    这种情况压根不该占位（占位等于「已发放」，而这里什么都没发）。
    const inviterAccount = await env.DB.prepare(
      "SELECT newapi_user_id FROM newapi_accounts WHERE user_id = ?"
    )
      .bind(inviterId)
      .first<{ newapi_user_id: number }>()
    if (!inviterAccount?.newapi_user_id) return

    // 4. 原子占位：`INSERT OR IGNORE` 撞主键时 `changes` 为 0 ⇒ 这次不是我抢到的。
    //
    //    判据与写入合成**一次 D1 往返**（而不是先 SELECT 再 INSERT）：并发下只有一个
    //    请求能拿到 `changes > 0`，其余全部在此返回，副作用（开订阅）因此只发生一次。
    //
    //    必须放在调 NewAPI **之前**：先去开订阅再补记录的话，重复的那次副作用已经
    //    发生，记录层再怎么唯一都拦不住它（这正是旧实现的问题）。
    //
    //    语义：这一行在「占位成功」到「发放结束」之间是**发放中**（最多
    //    `NEWAPI_TIMEOUT_MS` = 20s），之后要么成为「已发放」、要么被撤回。
    //    两个读这张表的地方都不受影响：`my-invites.ts` 只是把它当奖励列表展示
    //    （期间多显示一行、撤回后消失），`user-cleanup.ts` 只是刻意保留它作去重凭据。
    const claimed = await env.DB.prepare(
      `INSERT OR IGNORE INTO invite_rewards (invitee_user_id, inviter_user_id, granted_at, plan_id)
       VALUES (?, ?, ?, ?)`
    )
      .bind(invitee.id, inviterId, new Date().toISOString(), planId)
      .run()
    if ((claimed.meta?.changes ?? 0) === 0) return

    /** 撤回占位：让「占位 == 已发放」的不变式成立，保留下次重试机会 */
    const releaseClaim = async () => {
      try {
        await env.DB.prepare("DELETE FROM invite_rewards WHERE invitee_user_id = ?")
          .bind(invitee.id)
          .run()
      } catch (err) {
        // 撤不回 = 该被邀请人被永久判为「已发过」而邀请人实际一分没拿到。
        // 不能静默（这正是本函数要消灭的那类问题），单独打一条便于排查。
        console.error("邀请奖励占位撤回失败（该被邀请人可能被永久判为已发放）:", invitee.id, err)
      }
    }

    // 占位之后、确认发出之前的任何退出（含意外抛错）都必须撤回占位；只有
    // 「订阅真的开出去了」才保留它 —— 那种情况下撤回等于给同一份奖励留第二次机会。
    let granted = false
    try {
      //    ⚠️ strictLimit：邀请套餐若被设了限购（max_purchase_per_user），NewAPI 的拒绝是
      //    **真实失败**——不能像免费订阅重复领取那样当成功（那会让邀请人静默丢奖励，
      //    同 2026-10-08 成就奖励事故的教训）。
      const res = await adminGrantSubscription(env, inviterAccount.newapi_user_id, planId, {
        strictLimit: true,
      })
      granted = res.ok

      if (!res.ok) {
        // 失败**不记去重**：留出「被邀请人下次解锁/捐献时重试」的机会；
        // 同时写审计让管理员可见（记了去重就等于永久丢失，且没有任何痕迹）。
        //
        // 取舍（如实记录）：`res.ok === false` 包含**语义模糊**的失败 —— 例如 NewAPI
        // 已经建好订阅、但响应超时（`NEWAPI_TIMEOUT_MS` = 20s）。那种情况下撤回占位，
        // 下次触发会再开一张（`strictLimit` 只在套餐设了 `max_purchase_per_user` 时挡住）。
        // 仍选这一侧：另一侧（失败也留占位）是**静默永久丢奖励**，正是 2026-10-08
        // 成就奖励事故的形状；而多开一张订阅会留下痕迹，管理员可查可删。
        await audit(
          env,
          inviterId,
          "invite.reward_failed",
          `邀请奖励发放失败：被邀请人 ${invitee.username}，套餐 ${planId}，原因：${res.message}`
        )
        console.error("邀请奖励发放失败(NewAPI):", invitee.username, res.message)
        return
      }

      // 5. 发放成功 —— 占位已在第 4 步落库，这里只需记审计（邀请页展示的那行也已就位）
      await audit(
        env,
        inviterId,
        "invite.reward",
        `被邀请人 ${invitee.username} 解锁 AI 权限，奖励邀请订阅（套餐 ${planId}）`
      )
    } finally {
      if (!granted) await releaseClaim()
    }
  } catch (err) {
    console.error("邀请奖励发放失败:", invitee.username, err)
  }
}
