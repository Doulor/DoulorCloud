/**
 * 「聊天室我看过之后的新消息数」—— 两个端点共用同一份实现：
 *   · `GET /api/chat/unread`（侧边栏角标，chat.ts）
 *   · `GET /api/attention`（一次拿全部角标，attention.ts）
 *
 * 口径（改之前先看 chat.ts 的 unreadCount 注释）：
 *   - 看过：count(chat_messages where created_at > users.chat_seen_at)
 *   - 没看过（chat_seen_at 为 NULL，含上线前的老用户）：回落最近 24 小时
 *   - 不算自己发的消息
 *
 * ⚠️ 2026-10-28：加了进程内缓存，但**不会让角标变慢或变陈旧**。
 *    这条 COUNT 要扫「我看过之后」的全部消息（实测单次 5 千行、每天合计
 *    约 4.9 千次 ≈ 2.4 千万行，占全库行读 8%），而它的答案只在三件事发生时改变：
 *      ① 我标记已读（chat_seen_at 变）② 有人发了新消息（MAX(created_at) 变）
 *      ③ 有人撤回（不影响计数）。
 *    所以把 ①② 直接编进缓存 key —— 任一变化就是新 key、必然重新算，
 *    命中缓存时返回的结果与原查询**逐位相同**。①② 本身只各自读 1 行
 *    （users 主键 / created_at 索引的 MAX() 优化），比扫几千行便宜三个数量级。
 */
import type { Env } from "./env"
import { cached } from "./short-cache"

/** 缓存时长：key 已经带版本，TTL 只用来回收内存，取大一点也无妨 */
const TTL_MS = 60_000

/** 从没打开过聊天室时的回落窗口（与 chat.ts / attention.ts 既有一致） */
const FALLBACK_WINDOW_MS = 24 * 60 * 60 * 1000

export async function chatUnreadCount(env: Env, userId: string): Promise<number> {
  const seen = await env.DB.prepare("SELECT chat_seen_at FROM users WHERE id = ?")
    .bind(userId)
    .first<{ chat_seen_at: string | null }>()

  // 回落窗口按 10 秒对齐：否则 since 每毫秒都在变，缓存永远命中不了
  // （而且本身只是「最近 24 小时」的近似口径，对齐 10 秒没有任何语义影响）。
  const since =
    seen?.chat_seen_at ??
    new Date(Math.floor(Date.now() / 10_000) * 10_000 - FALLBACK_WINDOW_MS).toISOString()

  // 最新一条消息的时间 = 计数版本号。走 idx_chat_messages_created 的 MAX() 优化，
  // 只读一条索引项 —— 有新消息时它必然变化，缓存随之失效。
  const head = await env.DB.prepare("SELECT MAX(created_at) AS m FROM chat_messages").first<{
    m: string | null
  }>()

  const key = `chat-unread:${userId}:${since}:${head?.m ?? ""}`

  return cached(key, TTL_MS, async () => {
    const r = await env.DB.prepare(
      "SELECT COUNT(*) c FROM chat_messages WHERE created_at > ? AND user_id <> ?"
    )
      .bind(since, userId)
      .first<{ c: number }>()
    return Number(r?.c ?? 0)
  })
}
