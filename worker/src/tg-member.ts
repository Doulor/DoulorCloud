/**
 * 「订阅 TG 频道」这类活动的服务端核验（2026-10-24）。
 *
 * 为什么不用「频道里发验证码」：公共频道任何人都能通过 `t.me/<频道>` 网页预览
 * （`t.me/s/<频道>`）或 TG 搜索读到历史消息 —— 没订阅也看得见，码等于公开，
 * 还能被搬运给别人。
 *
 * 唯一可靠的判据是 Telegram 官方接口 `getChatMember`：机器人只要是频道管理员，
 * 就能查任意用户是否在频道里。前提是这个用户与我们「有过来往」——
 * 也就是站内 `tg_bindings` 里存着他绑定过的 telegram_id（一次绑定即可）。
 */
import { botToken, loadConfig } from "./handlers/telegram"
import type { Env } from "./env"

/** 成员状态里，哪些算「已订阅」 */
const MEMBER_STATUSES = new Set(["creator", "administrator", "member"])

export type MembershipResult =
  /** 确认在频道里 */
  | "member"
  /** 确认不在（left / kicked / 查无此人） */
  | "not_member"
  /** 该用户还没绑定 TG，无法核验 */
  | "no_binding"
  /** 查不了（bot 没权限 / 接口异常）—— 与「没订阅」必须分开，否则会冤枉用户 */
  | "unknown"

/** 直接按 telegram_id 查会员状态 */
export async function checkByTelegramId(
  env: Env,
  chatId: string,
  telegramId: string
): Promise<"member" | "not_member" | "unknown"> {
  try {
    const cfg = await loadConfig(env)
    const token = await botToken(env, cfg)
    if (!token) return "unknown"
    const res = await fetch(`https://api.telegram.org/bot${token}/getChatMember`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, user_id: Number(telegramId) }),
    })
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; result?: { status?: string }; description?: string }
      | null
    if (!data?.ok) {
      // 常见原因：机器人不是频道管理员、chat_id 不对。要让它在日志里显形，
      // 而不是静默当成「没订阅」——否则用户会以为自己白订阅了。
      console.warn("getChatMember 失败:", chatId, telegramId, data?.description ?? "unknown")
      return "unknown"
    }
    const status = data.result?.status ?? ""
    return MEMBER_STATUSES.has(status) ? "member" : "not_member"
  } catch (err) {
    console.warn("getChatMember 异常:", err instanceof Error ? err.message : err)
    return "unknown"
  }
}

/** 按站内用户查（先找到他绑定的 telegram_id） */
export async function checkChannelMembership(
  env: Env,
  chatId: string,
  userId: string
): Promise<MembershipResult> {
  let telegramId = ""
  try {
    const row = await env.DB.prepare("SELECT telegram_id FROM tg_bindings WHERE user_id = ?")
      .bind(userId)
      .first<{ telegram_id: string }>()
    telegramId = row?.telegram_id ?? ""
  } catch {
    telegramId = ""
  }
  if (!telegramId) return "no_binding"
  return checkByTelegramId(env, chatId, telegramId)
}
