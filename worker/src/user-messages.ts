/**
 * 站内消息写入工具。
 *
 * 全站统一消息表是 notifications（0024 建表 + 0068 升级为四分类）。
 * 所有「写消息」的地方都走这里，避免 SQL 散落各处、幂等键写法不一致。
 *
 * 四个分类（category）：
 *   system —— 系统消息：捐献结果、邮箱未验证（后者由 listNotifications 虚拟合成）
 *   site   —— 网站动态：管理员发布的公告
 *   social —— 社交消息：社区回复、点赞、反馈回复
 *   event  —— 活动推广：管理员发布的活动
 *
 * 幂等：dedup_key 非空时走 INSERT OR IGNORE，配合 0068 的部分唯一索引
 * idx_notifications_dedup(user_id, dedup_key) 去重。这让「点赞从无到有只留一条」
 * 「公告/活动重复广播不翻倍」「捐献结果重试不重复」都无需先查后写。
 */
import { uuid } from "./crypto"
import type { Env } from "./env"

export const MESSAGE_CATEGORIES = ["system", "site", "social", "event"] as const
export type MessageCategory = (typeof MESSAGE_CATEGORIES)[number]

export function isMessageCategory(v: string): v is MessageCategory {
  return (MESSAGE_CATEGORIES as readonly string[]).includes(v)
}

export interface PushMessageInput {
  category: MessageCategory
  /** 子类型：donation | announcement | event | post_like | post_comment | comment_reply | ... */
  type: string
  title?: string | null
  body?: string | null
  /** 点击跳转的站内路径，如 /dashboard/donations */
  link?: string | null
  /** 附加数据（活动卡片、捐献结果等），序列化成 JSON 存 payload 列 */
  payload?: unknown
  actorId?: string | null
  postId?: string | null
  commentId?: string | null
  /** 非空时走 INSERT OR IGNORE 幂等去重 */
  dedupKey?: string | null
}

function serializePayload(payload: unknown): string | null {
  if (payload === undefined || payload === null) return null
  try {
    return JSON.stringify(payload)
  } catch {
    return null
  }
}

/**
 * 给单个用户写一条消息。
 *
 * 失败静默：消息是附加项，不该因为写消息失败而让捐献审批、点赞这类主流程报错。
 * 调用方若需要感知失败（如活动领取），应自行 try/catch 并处理。
 */
export async function pushMessage(
  env: Env,
  userId: string,
  msg: PushMessageInput
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO notifications
         (id, user_id, category, type, title, body, link, payload, actor_id, post_id, comment_id, dedup_key, read, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    )
      .bind(
        uuid(),
        userId,
        msg.category,
        msg.type,
        msg.title ?? null,
        msg.body ?? null,
        msg.link ?? null,
        serializePayload(msg.payload),
        msg.actorId ?? null,
        msg.postId ?? null,
        msg.commentId ?? null,
        msg.dedupKey ?? null,
        new Date().toISOString()
      )
      .run()
  } catch (err) {
    console.error("站内消息写入失败:", userId, msg.type, err)
  }
}

/**
 * 广播给所有 active 用户（公告 / 活动上线）。
 *
 * 用单条 INSERT ... SELECT 完成，避免「N 个用户 = N 个绑定参数」撞上 D1 的
 * 语句参数上限；dedupKey 由调用方传入（形如 `ann:<id>` / `evt:<id>`），
 * 配合部分唯一索引保证重复广播不翻倍。
 *
 * 返回实际写入行数（审计用）。注意：D1 的 INSERT ... SELECT 没有绑定参数上限
 * 问题，但语句时长有限制；站是邀请制、用户量小，一次执行即可。
 * 若活跃用户增长到 2000 以上，应改为按 id 分段循环（每批 500）。
 */
export async function broadcastMessage(
  env: Env,
  msg: PushMessageInput,
  opts: { dedupKey: string }
): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO notifications
       (id, user_id, category, type, title, body, link, payload, dedup_key, read, created_at)
     SELECT lower(hex(randomblob(16))), u.id, ?, ?, ?, ?, ?, ?, ?, 0, ?
       FROM users u
      WHERE u.status = 'active'`
  )
    .bind(
      msg.category,
      msg.type,
      msg.title ?? null,
      msg.body ?? null,
      msg.link ?? null,
      serializePayload(msg.payload),
      opts.dedupKey,
      new Date().toISOString()
    )
    .run()

  return res.meta?.changes ?? 0
}
