import { ApiError } from "./http"
import type { Env } from "./env"
import { hashToken, generateToken, uuid } from "./crypto"
import { parsePermissions, requireFeature, hasFeature, isFeatureOpen, type Feature } from "./permissions"

export interface UserRow {
  id: string
  username: string
  email: string
  password_hash: string
  namespace: string
  role: string
  status: string
  /** 真实邮箱是否已验证（验证后才能作转发目标） */
  email_verified?: number
  /** 是否接收「个人相关」通知邮件（捐献/反馈/社区回复等） */
  notify_enabled?: number
  /** 是否接收「站点统一公告」的邮件推送 */
  notify_announcements?: number
  email_verify_requested_at?: string | null
  /** 功能权限 JSON（NULL=全开，见 permissions.ts） */
  permissions?: string | null
  /** 中文昵称（可空，未设置时回退显示 username） */
  nickname?: string | null
  /** 头像在 R2 的对象键（可空） */
  avatar_key?: string | null
  /** 用户 UID（按注册顺序从 1 开始；迁移 0070，老数据可能为 NULL） */
  uid?: number | null
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

/**
 * 是否有管理员及以上的权限（root 或 admin）。
 *
 * 2026-09-25 引入 root 角色（站长，唯一，凌驾于 admin）：root 拥有 admin 的全部
 * 权限，且不能被 admin 修改/删除。因此「放行管理员」的判定统一从
 * `role === "admin"` 改成 `isPrivileged(role)` —— 否则 root 会被意外挡在
 * 各种 admin 专属接口之外。
 */
export function isPrivileged(role: string | null | undefined): boolean {
  return role === "admin" || role === "root"
}

export function toPublicUser(row: UserRow) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    namespace: row.namespace,
    role: row.role ?? "user",
    emailVerified: row.email_verified === 1,
    notifyEnabled: row.notify_enabled !== 0,
    notifyAnnouncements: row.notify_announcements !== 0,
    permissions: parsePermissions(row.permissions),
    nickname: row.nickname ?? null,
    hasAvatar: Boolean(row.avatar_key),
    /** 用户 UID（按注册顺序，001 起）；展示层补零 */
    uid: row.uid ?? null,
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

  // ⚠️ 2026-10-01 性能：原来分两步（先查 sessions，再按 user_id 查 users）——
  // 每个需登录的请求都要付两次 D1 往返。香港等跨境用户单次往返 ~120ms，
  // 一次合并直接省掉一次。这里用 JOIN 一次取回，会话过期判定逻辑不变。
  const sessions = await env.DB.prepare(
    `SELECT u.*, s.expires_at AS _session_expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash IN (${placeholders})`
  )
    .bind(...hashes)
    .all<UserRow & { _session_expires_at: string | null }>()

  const rows = sessions.results ?? []
  if (rows.length === 0) {
    throw new ApiError(401, "会话已失效", "UNAUTHORIZED")
  }

  // 优先取未过期的
  const valid = rows.find(
    (s) => new Date(s._session_expires_at ?? 0).getTime() >= nowMs
  )
  if (!valid) {
    // ⚠️ 2026-09-25 审计（M22）：原实现是全局 `DELETE FROM sessions WHERE expires_at < ?`，
    // 与 maintenance.ts 的 SESSION_RETENTION_DAYS = 7 直接冲突 —— 那个保留窗口
    // 是**刻意**留出来排查「我刚掉线了」这类投诉的，而任意一次带过期 token 的
    // 请求都会把全站过期会话立刻删光，顺便把定时任务的职责搬到了请求路径上。
    // 改成只清理「本次请求带过来的」那几个过期 token：既清掉了用户浏览器里的
    // 残留 cookie 记录，又不越界动别人的数据。
    await env.DB.prepare(
      `DELETE FROM sessions WHERE token_hash IN (${placeholders}) AND expires_at < ?`
    )
      .bind(...hashes, nowIso)
      .run()
    throw new ApiError(401, "会话已过期", "UNAUTHORIZED")
  }

  if (valid.status !== "active") {
    throw new ApiError(401, "账户不可用", "UNAUTHORIZED")
  }

  // 把仅用于判定过期的辅助列摘掉，保持返回形状与原来一致
  const { _session_expires_at: _expires, ...user } = valid
  return user as UserRow
}

/**
 * 每个用户最多保留的活跃会话数（2026-09-25 审计 L16）。
 *
 * 原状况：登录只 INSERT、从不清理，会话有效期 30 天。
 * 账号被他人登录过一次就留下一个 30 天有效的会话，而用户**既看不到也无法吊销**
 * （管理员能看到会话列表，但没有任何删除路由）。反复登录还会无限累积。
 *
 * 取 10：正常用户「手机 + 电脑 + 平板 + 几个浏览器」远用不到 10 个；
 * 超过就淘汰最旧的，等于给会话集合加了个上界 —— 被盗会话最多存活到
 * 第 10 次登录为止，而不是永远。
 *
 * 与 `MAX_SESSION_TOKENS`（cookie 条数上限，L31）配合：
 * 那里防的是「同名 cookie 堆积把 SQL 绑定参数撑爆」，
 * 这里防的是「服务端会话行无界增长」，两者管的是不同的资源。
 */
const MAX_SESSIONS_PER_USER = 10

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

  // 淘汰最旧的会话。`id != ?` 保证刚签发的这一个绝不可能被自己删掉
  // （同一毫秒内多次登录时 `created_at` 会打平，只靠排序不足以保证）。
  // 失败不阻断登录：会话已经建好了，清理是维护性动作。
  try {
    await env.DB.prepare(
      `DELETE FROM sessions
        WHERE user_id = ? AND id != ?
          AND id NOT IN (
            SELECT id FROM sessions WHERE user_id = ?
             ORDER BY created_at DESC, id DESC LIMIT ?
          )`
    )
      .bind(userId, id, userId, MAX_SESSIONS_PER_USER)
      .run()
  } catch (err) {
    console.error("清理旧会话失败（不影响登录）:", userId, err)
  }

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
 * `doulor.cn` 再访问 `cloud.doulor.cn`，两者 cookie 相互独立；或历史遗留的
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
  return (
    cookie
      .split(";")
      .map((c) => c.trim())
      .filter((c) => c.startsWith(prefix))
      .map((c) => c.slice(prefix.length))
      .filter((v) => v.length > 0)
      // ⚠️ 2026-09-25 审计（L31）：必须限制数量。调用方会把这些 token 全部
      // 拼进 `WHERE token_hash IN (?,?,…)`，而 D1 单语句的绑定参数上限是 100。
      // 攻击者（或某个坏掉的客户端）只要带上 100+ 个同名 cookie，就能让
      // **所有**鉴权接口、登出、改密码统一 500。16 远超真实场景需要
      // （正常最多 2–3 个：裸域残留 + 当前域名），且留足参数余量。
      .slice(0, MAX_SESSION_TOKENS)
  )
}

/** 单次请求最多参与校验的同名 cookie 数（见 getSessionTokens 注释） */
const MAX_SESSION_TOKENS = 16

/**
 * 要求登录 + 具备指定功能权限。
 * 所有与某个受限功能相关的接口都应走这里，
 * 而不是只调 requireUser —— 权限必须由服务端强制，绝不信任前端。
 *
 * 管理员可把模块设为「免权限访问」（管理面板，存 app_settings.open_features），
 * 此时该模块不再检查用户权限。注意这与管理员角色放行是两件事：前者对所有人放行，
 * 后者只放行管理员自己。
 */
export async function requireFeatureUser(
  env: Env,
  request: Request,
  feature: Feature
): Promise<UserRow> {
  const user = await requireUser(env, request)
  // 管理员/站长始终放行，便于排查问题
  if (isPrivileged(user.role)) return user
  const perms = parsePermissions(user.permissions)
  if (!hasFeature(perms, feature)) {
    // 只在「被卡住」时才读免权限总开关：有权限的用户（绝大多数）走不到这里，
    // 因此这条查询不构成热点路径的额外开销，也就不需要缓存。
    if (await isFeatureOpen(env, feature)) return user
    requireFeature(perms, feature)
  }
  return user
}
