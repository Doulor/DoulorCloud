import { env } from "cloudflare:workers"
import { createSession, sessionCookie } from "../src/auth"
import { hashPassword, uuid } from "../src/crypto"

export interface TestUser {
  id: string
  username: string
  cookie: string  // 形如 "doulor_session=xxx"
}

/** 注册一个用户并返回带 session cookie 的请求头 */
export async function makeUser(opts: {
  username?: string
  role?: "user" | "admin"
} = {}): Promise<TestUser> {
  const username = opts.username ?? `u_${Math.random().toString(36).slice(2, 8)}`
  const id = uuid()
  const now = new Date().toISOString()
  await env.DB.prepare(
    "INSERT INTO users (id, username, email, password_hash, namespace, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)"
  ).bind(
    id, username, `${username}@doulor.cn`,
    await hashPassword("pass1234"), username,
    opts.role ?? "user", now, now
  ).run()
  const token = await createSession(env, id)
  return { id, username, cookie: sessionCookie(token) }
}

/** 构造带鉴权的 Request */
export function authRequest(
  user: TestUser,
  path: string,
  init: RequestInit = {}
): Request {
  const headers = new Headers(init.headers)
  headers.set("Cookie", user.cookie)
  return new Request(`https://cloud.doulor.cn${path}`, { ...init, headers })
}

/** 直接调本 Worker（SELF） */
export async function fetchSelf(req: Request): Promise<Response> {
  const SELF = (await import("cloudflare:test")).SELF
  return SELF.fetch(req)
}
