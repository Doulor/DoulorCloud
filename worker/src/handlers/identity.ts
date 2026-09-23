import { ApiError, json } from "../http"
import { requireUser } from "../auth"
import {
  validateNicknameFormat,
  isReservedNickname,
  parseReservedNicknames,
  AVATAR_TYPES,
  avatarKey,
} from "../identity"
import { getSetting } from "../settings"
import { isStorageConfigured, putObject, deleteObject, getObject, getPlatformBucketId } from "../r2"
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

  // 格式校验（字符集/长度）
  if (!validateNicknameFormat(nick)) {
    throw new ApiError(400, "昵称为 2-16 位中文/英文/数字/下划线", "INVALID_NICKNAME")
  }

  const isAdmin = user.role === "admin"
  // 保留词：管理员自己设时跳过（防自我限制），但仍禁含 doulor
  const extra = parseReservedNicknames(await getSetting(env, "reserved_nicknames"))
  if (isReservedNickname(nick, extra, isAdmin)) {
    throw new ApiError(400, "该昵称包含保留词，请换一个", "NICKNAME_RESERVED")
  }

  // 禁止与「其他」管理员 username 重名（防冒充管理员）；管理员自己除外
  const adminHit = await env.DB.prepare(
    "SELECT 1 FROM users WHERE role = 'admin' AND id != ? AND username = ? COLLATE NOCASE LIMIT 1"
  ).bind(user.id, nick).first()
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

/** POST /api/settings/avatar —— 原图直传（≤2 MB） */
export async function uploadAvatar(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  if (!(await isStorageConfigured(env))) {
    throw new ApiError(503, "存储未配置，无法上传", "R2_NOT_CONFIGURED")
  }
  const contentType = (request.headers.get("Content-Type") ?? "").split(";")[0].trim()
  const ext = AVATAR_TYPES[contentType]
  if (!ext) {
    throw new ApiError(400, "仅支持 JPG / PNG / WebP / GIF", "INVALID_TYPE")
  }
  const MAX = 2 * 1024 * 1024
  const buf = await request.arrayBuffer()
  if (buf.byteLength === 0) throw new ApiError(400, "文件为空", "INVALID_INPUT")
  if (buf.byteLength > MAX) throw new ApiError(400, "文件过大，上限 2 MB", "TOO_LARGE")

  const bucketId = await getPlatformBucketId(env)
  const key = avatarKey(user.username, ext)
  await putObject(env, key, buf, contentType, bucketId)
  for (const oldExt of Object.values(AVATAR_TYPES)) {
    if (oldExt === ext) continue
    try { await deleteObject(env, avatarKey(user.username, oldExt), bucketId) } catch {}
  }
  await env.DB.prepare("UPDATE users SET avatar_key = ?, updated_at = ? WHERE id = ?")
    .bind(key, new Date().toISOString(), user.id).run()
  return json({ key })
}

/** DELETE /api/settings/avatar */
export async function deleteAvatar(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  if (await isStorageConfigured(env)) {
    const bucketId = await getPlatformBucketId(env)
    for (const ext of Object.values(AVATAR_TYPES)) {
      try { await deleteObject(env, avatarKey(user.username, ext), bucketId) } catch {}
    }
  }
  await env.DB.prepare("UPDATE users SET avatar_key = NULL, updated_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), user.id).run()
  return json({ ok: true })
}

/** GET /u/<username>/avatar —— 公开读取头像字节流（走 Host 分发层，非 /api） */
export async function serveAvatar(env: Env, username: string): Promise<Response> {
  if (!(await isStorageConfigured(env))) return new Response("Not Found", { status: 404 })
  const user = await env.DB.prepare("SELECT avatar_key FROM users WHERE username = ? COLLATE NOCASE")
    .bind(username).first<{ avatar_key: string | null }>()
  if (!user?.avatar_key) return new Response("Not Found", { status: 404 })
  const bucketId = await getPlatformBucketId(env)
  try {
    return await getObject(env, user.avatar_key, undefined, bucketId)
  } catch {
    return new Response("Not Found", { status: 404 })
  }
}
