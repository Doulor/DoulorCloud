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
    createdAt: row.created_at,
  }
}

/**
 * 从请求中解析会话，返回当前用户。
 * 所有需要鉴权的路由必须通过此函数获取用户，绝不信任前端传入的任何身份字段。
 */
export async function requireUser(
  env: Env,
  request: Request
): Promise<UserRow> {
  const token = getSessionToken(request)
  if (!token) {
    throw new ApiError(401, "未登录", "UNAUTHORIZED")
  }

  const tokenHash = await hashToken(token)
  const session = await env.DB.prepare(
    `SELECT s.user_id, s.expires_at
       FROM sessions s
      WHERE s.token_hash = ?
      LIMIT 1`
  )
    .bind(tokenHash)
    .first<{ user_id: string; expires_at: string }>()

  if (!session) {
    throw new ApiError(401, "会话已失效", "UNAUTHORIZED")
  }

  if (new Date(session.expires_at).getTime() < Date.now()) {
    await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at < ?")
      .bind(session.user_id, new Date().toISOString())
      .run()
    throw new ApiError(401, "会话已过期", "UNAUTHORIZED")
  }

  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(session.user_id)
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
  const token = getSessionToken(request)
  if (!token) return
  const tokenHash = await hashToken(token)
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?")
    .bind(tokenHash)
    .run()
}

export function sessionCookie(value: string, maxAgeSeconds = 30 * 24 * 60 * 60): string {
  // Secure：生产 HTTPS 必须；本地开发用 http://127.0.0.1 时浏览器仍接受 localhost 的 Secure cookie
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}

export function getSessionToken(request: Request): string | null {
  const cookie = request.headers.get("Cookie")
  if (!cookie) return null
  const match = cookie
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
  if (!match) return null
  return match.slice(`${SESSION_COOKIE}=`.length)
}
