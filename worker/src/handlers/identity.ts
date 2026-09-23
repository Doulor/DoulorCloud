import { ApiError, json } from "../http"
import { requireUser } from "../auth"
import { validateNicknameFormat } from "../identity"
import type { Env } from "../env"

/** PUT /api/settings/nickname —— 设置或清空昵称 */
export async function updateNickname(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json().catch(() => ({}))) as { nickname?: string }
  const nick = (body.nickname ?? "").trim()

  // 空串 = 清空
  if (nick === "") {
    await env.DB.prepare("UPDATE users SET nickname = NULL, updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), user.id).run()
    return json({ nickname: null })
  }

  if (!validateNicknameFormat(nick)) {
    throw new ApiError(400, "昵称为 2-16 位中文/英文/数字/下划线，且不能含保留词", "INVALID_NICKNAME")
  }

  // 禁止与管理员 username 重名（防冒充管理员）
  const adminHit = await env.DB.prepare(
    "SELECT 1 FROM users WHERE role = 'admin' AND username = ? COLLATE NOCASE LIMIT 1"
  ).bind(nick).first()
  if (adminHit) {
    throw new ApiError(409, "该昵称与管理员账号冲突，请换一个", "NICKNAME_CONFLICT")
  }

  // 唯一性（部分索引保证 NULL 不冲突）
  try {
    await env.DB.prepare("UPDATE users SET nickname = ?, updated_at = ? WHERE id = ?")
      .bind(nick, new Date().toISOString(), user.id).run()
  } catch {
    throw new ApiError(409, "该昵称已被占用", "NICKNAME_TAKEN")
  }
  return json({ nickname: nick })
}
