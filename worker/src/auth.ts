import { ApiError } from "./http"
import type { Env } from "./env"
import { hashToken, generateToken, uuid } from "./crypto"

export interface UserRow {
  id: string
  username: string
  email: string
  password_hash: string
  namespace: string
  role: string
  status: string
  /** 真实邮箱是否已验证（验证后才能作转发目标/接收通知） */
  email_verified?: number
  /** 是否接收站内通知邮件 */
  notify_enabled?: number
  email_verify_requested_at?: string | null
  created_at: string
  updated_at: string
}

export interface DomainRow {
  id: string
  user_id: string
  name: string
  zone_id: string | null
  status: string
  created_at: string
}

const SESSION_COOKIE = "doulor_session"

export function toPublicUser(row: UserRow) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    namespace: row.namespace,
    role: row.role ?? "user",
    emailVerified: row.email_verified === 1,
    notifyEnabled: row.notify_enabled !== 0,
    createdAt: row.created_at,
  }
}

/**
 * 从请求中解析会话，返回当前用户。
 * 所有需要鉴权的路由必须通过此函数获取用户，绝不信任前端传入的任何身份字段。
 *
 * 浏览器可能同时携带多个同名 `doulor_session`（见 getSessionTokens 注释），
 * 因此这里逐个校验，任一有效即通过——否则一个残留的失效 cookie 就能让用户
 * 在登录成功后仍被判为未登录。
 */
export async function requireUser(
  env: Env,
  request: Request
): Promise<UserRow> {
  const tokens = getSessionTokens(request)
  if (tokens.length === 0) {
    throw new ApiError(401, "未登录", "UNAUTHORIZED")
  }

  const nowIso = new Date().toISOString()
  const nowMs = Date.now()
  const placeholders = tokens.map(() => "?").join(", ")
  const hashes = await Promise.all(tokens.map((t) => hashToken(t)))

  const sessions = await env.DB.prepare(
    `SELECT s.token_hash, s.user_id, s.expires_at
       FROM sessions s
      WHERE s.token_hash IN (${placeholders})`
  )
    .bind(...hashes)
    .all<{ token_hash: string; user_id: string; expires_at: string }>()

  const rows = sessions.results ?? []
  if (rows.length === 0) {
    throw new ApiError(401, "会话已失效", "UNAUTHORIZED")
  }

  // 优先取未过期的
  const valid = rows.find((s) => new Date(s.expires_at).getTime() >= nowMs)
  if (!valid) {
    await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?")
      .bind(nowIso)
      .run()
    throw new ApiError(401, "会话已过期", "UNAUTHORIZED")
  }

  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(valid.user_id)
    .first<UserRow>()

  if (!user || user.status !== "active") {
    throw new ApiError(401, "账户不可用", "UNAUTHORIZED")
  }

  return user
}

export async function createSession(
  env: Env,
  userId: string
): Promise<string> {
  const token = generateToken()
  const tokenHash = await hashToken(token)
  const id = uuid()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000) // 30 天

  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(id, userId, tokenHash, expiresAt.toISOString(), now.toISOString())
    .run()

  return token
}

export async function destroySession(env: Env, request: Request): Promise<void> {
  // 浏览器可能同时持有多个同名 cookie，全部销毁，否则登出后旧 cookie 仍在
  const tokens = getSessionTokens(request)
  if (tokens.length === 0) return
  const hashes = await Promise.all(tokens.map((t) => hashToken(t)))
  const placeholders = hashes.map(() => "?").join(", ")
  await env.DB.prepare(
    `DELETE FROM sessions WHERE token_hash IN (${placeholders})`
  )
    .bind(...hashes)
    .run()
}

export function sessionCookie(value: string, maxAgeSeconds = 30 * 24 * 60 * 60): string {
  // Secure：生产 HTTPS 必须；本地开发用 http://127.0.0.1 时浏览器仍接受 localhost 的 Secure cookie
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}

/**
 * 解析请求中的会话 token。
 *
 * 注意：浏览器可能同时持有**多个同名 cookie**（例如用户先访问过裸域
 * `doulor.cn` 再访问 `mail.doulor.cn`，两者 cookie 相互独立；或历史遗留的
 * 失效 cookie 未被清除）。此时 `Cookie` 头会包含多个 `doulor_session=...`。
 *
 * 旧实现用 `.find()` 只取第一个，一旦那个恰好是失效的，即使用户刚刚登录成功
 * （有效 cookie 排在后面）也会被判为「未登录」，表现为「怎么都登录不进去，
 * 清缓存也没用，换浏览器却正常」。因此这里返回**全部** token，由调用方
 * 逐个校验，任一有效即视为已登录。
 */
export function getSessionTokens(request: Request): string[] {
  const cookie = request.headers.get("Cookie")
  if (!cookie) return []
  const prefix = `${SESSION_COOKIE}=`
  return cookie
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c.startsWith(prefix))
    .map((c) => c.slice(prefix.length))
    .filter((v) => v.length > 0)
}
