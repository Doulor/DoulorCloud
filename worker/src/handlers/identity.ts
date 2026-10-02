import { ApiError, json, readBodyCapped } from "../http"
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
import { hardenUserContentResponse } from "../content-type"
import { guardRateLimit } from "../ratelimit"
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

  const isAdmin = user.role === "admin" || user.role === "root"
  // 保留词：管理员/站长自己设时跳过（防自我限制），但仍禁含 doulor
  const extra = parseReservedNicknames(await getSetting(env, "reserved_nicknames"))
  if (isReservedNickname(nick, extra, isAdmin)) {
    throw new ApiError(400, "该昵称包含保留词，请换一个", "NICKNAME_RESERVED")
  }

  // 禁止与「其他」管理员/站长 username 重名（防冒充）；管理员自己除外
  const adminHit = await env.DB.prepare(
    "SELECT 1 FROM users WHERE role IN ('admin', 'root') AND id != ? AND username = ? COLLATE NOCASE LIMIT 1"
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
  // 每次上传会写 1 个对象并尝试删除 4 个旧扩展名对象，都是 R2 计费操作；
  // 加限流避免被反复调用刷操作数。头像不会频繁更换，20 次/分钟足够。
  await guardRateLimit(env, `avatar:${user.id}`, 20, 60, "头像上传过于频繁")
  if (!(await isStorageConfigured(env))) {
    throw new ApiError(503, "存储未配置，无法上传", "R2_NOT_CONFIGURED")
  }
  const contentType = (request.headers.get("Content-Type") ?? "").split(";")[0].trim()
  const ext = AVATAR_TYPES[contentType]
  if (!ext) {
    throw new ApiError(400, "仅支持 JPG / PNG / WebP / GIF", "INVALID_TYPE")
  }
  const MAX = 2 * 1024 * 1024
  // ⚠️ 2026-09-26 审计：原先 `await request.arrayBuffer()` 是「先整体读进内存再判大小」，
  // 任意登录用户发一个接近 100MB 的 body 就能打满 Worker 的 128MB 内存。
  // `readBodyCapped` 先看 Content-Length 快速拒绝，读完再复核真实长度（http.ts）。
  const buf = await readBodyCapped(request, MAX, "文件过大，上限 2 MB", 400, "TOO_LARGE")
  if (buf.byteLength === 0) throw new ApiError(400, "文件为空", "INVALID_INPUT")

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
    const res = await getObject(env, user.avatar_key, undefined, bucketId)
    // ⚠️ 2026-09-25 审计（低）：这里原先把 R2 响应**原样透传**，
    // Content-Type 完全来自对象的存储元数据。头像是公开接口，
    // 一旦有对象以 text/html 或 image/svg+xml 落进 avatar_key，
    // 就会在应用主源上被当文档渲染。上传侧虽有扩展名白名单，
    // 但公开读取接口不应该依赖写入侧的校验（纵深防御）。
    // 2026-10-02（issue #3）：头像是公开只读端点、按 username 寻址的同一份字节流，
    // 却吃 hardenUserContentResponse 的 no-store 兜底 —— 侧边栏每次重挂载都回源重拉
    // 546 KB。这里显式给个短缓存（60s），harden 只在缺失时才补 no-store，不会被覆盖。
    const headers = new Headers(res.headers)
    headers.set("Cache-Control", "public, max-age=60")
    return hardenUserContentResponse(
      new Response(res.body, { status: res.status, headers }),
      user.avatar_key.split("/").pop() || "avatar"
    )
  } catch {
    return new Response("Not Found", { status: 404 })
  }
}
