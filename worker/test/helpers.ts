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
  role?: "user" | "admin" | "superadmin" | "root"
  /**
   * 邮箱是否已验证，默认 **true**。
   *
   * 为什么默认已验证（2026-10-02 改）：从这天起，未验证邮箱的账号在**写操作**上会被
   * `requireUser` 拦成 403 EMAIL_NOT_VERIFIED（门槛清单见 `worker/src/auth.ts` 的
   * `EMAIL_VERIFY_REQUIRED_PREFIXES`）。绝大多数测试关心的是业务逻辑本身，而不是
   * 这个门槛，所以默认给一个「已验证」的账号，避免几十个用例集体变红。
   *
   * 要测「未验证」的行为（例如邮箱门槛本身、未验证提示），显式传 `emailVerified: false`。
   */
  emailVerified?: boolean
} = {}): Promise<TestUser> {
  const username = opts.username ?? `u_${Math.random().toString(36).slice(2, 8)}`
  const id = uuid()
  const now = new Date().toISOString()
  await env.DB.prepare(
    "INSERT INTO users (id, username, email, password_hash, namespace, role, status, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)"
  ).bind(
    id, username, `${username}@doulor.cn`,
    await hashPassword("pass1234"), username,
    opts.role ?? "user", opts.emailVerified === false ? 0 : 1, now, now
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

/**
 * 直接写 app_settings（绕过管理接口）。
 * 用于测试那些「读库即时生效」的全局开关（如 open_features）。
 */
export async function setSetting(key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(key, value, new Date().toISOString())
    .run()
}

/** 直接覆写某用户的 permissions JSON（显式卡权限用） */
export async function setPermissions(userId: string, json: string): Promise<void> {
  await env.DB.prepare("UPDATE users SET permissions = ? WHERE id = ?")
    .bind(json, userId)
    .run()
}

/** 直接调本 Worker（SELF） */
export async function fetchSelf(req: Request): Promise<Response> {
  const SELF = (await import("cloudflare:test")).SELF
  return SELF.fetch(req)
}
