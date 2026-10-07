import { Heart, MessageCircle, MessageSquare, type LucideIcon } from "lucide-react"
import type { Notification } from "@/types"

/**
 * 社交消息的「类型图标」与「动词文案」——社区广场通知弹窗与消息中心共用一份，
 * 避免「点赞 vs 评论」的文案/图标在两处漂移（站长 2026-10-05 反馈：社区里
 * 点赞评论被显示成「评论了评论」）。
 *
 * 口径必须与后端 latestNotification 一致（浏览器通知拿的是那一份）：
 *   · post_like      → 赞了帖子     → Heart
 *   · comment_like   → 赞了评论     → Heart
 *   · comment_reply  → 回复了评论   → MessageCircle
 *   · feedback_reply → 回复了反馈   → MessageSquare
 *   · 其它           → 回复了你     → MessageCircle
 */

/** 取词函数的最小签名（useT 的 t 与 tStatic 都兼容） */
type TFunc = (key: string, vars?: Record<string, string | number>) => string

/** 社交消息的类型图标 */
export function socialNotifIcon(n: Notification): LucideIcon {
  if (n.type === "post_like" || n.type === "comment_like") return Heart
  if (n.type === "feedback_reply") return MessageSquare
  return MessageCircle
}

/**
 * 社交消息的整句文案（含行为者名字）。
 *
 * @param actor 行为者昵称/用户名，可能为空（空则由调用方兜底为「有人」）
 */
export function socialNotifText(n: Notification, actor: string, t: TFunc): string {
  if (n.type === "post_like") return t("msg.liked", { actor })
  if (n.type === "comment_like") return t("msg.likedComment", { actor })
  if (n.type === "comment_reply") return t("msg.repliedComment", { actor })
  if (n.type === "feedback_reply") return `${actor} ${t("cm.notif.feedbackReply")}`
  return t("msg.replied", { actor })
}
