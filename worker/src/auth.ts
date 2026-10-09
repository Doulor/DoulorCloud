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
  /** 封禁原因（仅 status='suspended' 时有值）；用户下次登录时会在登录页看到 */
  suspend_reason?: string | null
  /** 封禁时间（同上，仅封禁期间有值；解封时清空） */
  suspend_at?: string | null
  /** 真实邮箱是否已验证（验证后才能作转发目标） */
  email_verified?: number
  /** 是否接收「个人相关」通知邮件（捐献/反馈/社区回复等） */
  notify_enabled?: number
  /** 是否接收「站点统一公告」的邮件推送 */
  notify_announcements?: number
  email_verify_requested_at?: string | null
  /** 功能权限 JSON（NULL=全开，见 permissions.ts） */
  permissions?: string | null
  /** 引用的管理员权限组 id（可空 = 未加入任何组） */
  admin_role_id?: string | null
  /** 自定义管理员白名单（JSON 数组；非空 = 覆盖权限组） */
  admin_scope?: string | null
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
 * 角色分级（2026-10-04 权限系统重构）：
 *   root        站长，唯一，凌驾一切，不可被改/删。
 *   superadmin  超级管理员，拥有全部管理权限 + 资源特权（= 旧「admin」）。
 *   admin       自定义管理员，能进管理面板，但**只能做白名单里允许的事**。
 *   user        普通用户。
 *
 * 命名约定：
 *   isPrivileged  → root / superadmin（全权；资源特权 + 管理接口直接放行）
 *   isAnyAdmin    → root / superadmin / admin（能进管理面板；admin 还要过白名单）
 */
export function isRoot(role: string | null | undefined): boolean {
  return role === "root"
}

export function isPrivileged(role: string | null | undefined): boolean {
  return role === "superadmin" || role === "root"
}

/** 任何「管理员」角色（含自定义白名单的 admin） */
export function isAnyAdmin(role: string | null | undefined): boolean {
  return role === "superadmin" || role === "root" || role === "admin"
}

/* --------------------------------------------------------------------------
 * 「未验证邮箱」功能门槛（2026-10-02 站长要求）
 *
 * 站长口径：「没验证虽然可以进页面，但类似于开通中转站之类的都干不了；
 *          最多可以搞一下注销账户、更改密码、用户名之类的个人信息。」
 *
 * 因此这里的语义是 **只拦写操作**：
 *   · GET / HEAD / OPTIONS 一律放行 —— 未验证用户照样能进所有页面、看自己的数据，
 *     不会出现「一片 403、页面空转」的观感；
 *   · 只有要开通 / 创建 / 提交 / 删除时才要求先验证邮箱。
 *
 * ⚠️ 这里**只列业务功能模块**。账户与状态类接口（/settings、/me、/password、
 * /logout、/attention、/notifications、/app、/feedback、/community/seen…）刻意
 * **不列** —— 未验证用户仍能改密码、改用户名、改昵称头像、看消息、提反馈、
 * 以及注销账号（站长明确要求保留这些出口）。
 *
 * ⚠️ 判定方向必须保守：**宁可漏锁（某个功能还能用），也绝不误锁**。
 * 漏锁只是少拦一个入口，事后加一行即可；误锁会把用户关进「什么都改不了」的
 * 死角，只能靠发版救回来。
 *
 * ⚠️ 前缀匹配用的是「去掉 /api 前缀」的路径（与 index.ts 的 routePath 同一口径），
 * 且要求 `=== prefix` 或 `startsWith(prefix + "/")` —— 否则 `/dev` 会误伤 `/device`。
 * ----------------------------------------------------------------------- */
const EMAIL_VERIFY_REQUIRED_PREFIXES: readonly string[] = [
  "/dev", //             AI 中转站：开通 / 建 Key / 兑换 / 订阅
  "/wb2api", //          WorkBuddy 号池通道
  "/qoder2api", //         Qoder2API 通道
  "/storage", //         直链网盘
  "/subdomains", //      子域名
  "/dns", //             DNS 记录
  "/mailbox", //         邮箱与转发
  "/frp", //             内网穿透
  "/proxy", //           代理节点
  "/donations", //       资源捐献
  "/points", //          积分与商城
  "/checkin", //         每日签到（发积分，属于写操作，同样过门槛）
  "/vouchers", //        兑换券
  "/my-invites", //      我的邀请码
  "/chat", //            聊天室
  "/dm", //              一对一私信
  "/events", //          活动参与
  "/fun-links", //       工具箱外链
  "/tempbox", //         临时分享箱（创建）
  "/community/posts", // 社区发帖 / 评论 / 点赞（只读 GET 不受影响）
  "/profile/domain", //  名片绑定的自定义域名
  "/profile/asset", //   名片资源上传（占 R2）
]

/** 只读方法一律放行 —— 「可以进页面」就是靠这条兜住的 */
const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

/**
 * 从请求里取「去掉 /api 前缀」的接口路径，口径与 index.ts::route 的 routePath 一致。
 * 解析失败时返回空串（不命中任何前缀 ⇒ 放行，仍然走保守方向）。
 */
function apiRoutePath(request: Request): string {
  let path: string
  try {
    path = new URL(request.url).pathname
  } catch {
    return ""
  }
  path = path.replace(/\/+$/, "") || "/"
  return path.startsWith("/api") ? path.slice(4) : path
}

/** 该请求是否命中「未验证邮箱」门槛（非只读 + 前缀命中功能模块） */
function needsVerifiedEmail(request: Request): boolean {
  if (READ_ONLY_METHODS.has(request.method.toUpperCase())) return false
  const routePath = apiRoutePath(request)
  return EMAIL_VERIFY_REQUIRED_PREFIXES.some(
    (p) => routePath === p || routePath.startsWith(`${p}/`)
  )
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

  // 「未验证邮箱」功能门槛（规则见上方 EMAIL_VERIFY_REQUIRED_PREFIXES 注释）。
  //
  // 放在**这里**而不是 dispatch 层，有两个理由：
  //   1. 零成本 —— 用户行本来就已经查出来了，不额外多一次 D1 往返；
  //   2. 一处覆盖 —— requireFeatureUser 也走本函数，因此 122 个调用点全部自动生效。
  // 管理员/站长必须豁免：否则站长只要没验证邮箱，连管理后台都进不去。
  if (user.email_verified !== 1 && !isPrivileged(user.role)) {
    if (needsVerifiedEmail(request)) {
      throw new ApiError(
        403,
        "请先验证邮箱后再使用该功能（设置 → 真实邮箱验证）",
        "EMAIL_NOT_VERIFIED"
      )
    }
  }

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

/** 管理员对申诉的回复，以及用户是否已确认看过（供强制弹窗使用） */
export interface PendingAppealReply {
  id: string
  status: string
  reviewNote: string
  createdAt: string
  reviewedAt: string | null
}

/**
 * 读「最近一条有管理员回复、但用户还没确认看过」的申诉（2026-10-02 补发机制）。
 *
 * 场景：管理员处理完申诉（accept 解封 / reject 驳回）并写了回复后，
 * 用户下一次登录（或打开页面）就应该被**强制弹窗**看到这段回复；
 * 直到他勾选确认（`/api/appeal/acknowledge`）把 `note_read_at` 写上，这里才不再返回。
 *
 * 这也是**补发**通道：老用户早就解封、当时没看到回复，只要 `note_read_at` 仍为空，
 * 下次登录/开页面就会命中。
 *
 * ⚠️ `note_read_at` 是迁移 0101 才加的列：线上万一漏执行迁移，这里必须吞异常返回 null，
 *   绝不能把登录本身打成 500（登录一挂，全站都进不去）。
 */
export async function loadPendingReply(
  env: Env,
  userId: string
): Promise<PendingAppealReply | null> {
  try {
    const row = await env.DB.prepare(
      "SELECT id, status, review_note, created_at, reviewed_at FROM account_appeals " +
        "WHERE user_id = ? AND review_note IS NOT NULL AND review_note != '' " +
        "AND note_read_at IS NULL " +
        "ORDER BY COALESCE(reviewed_at, created_at) DESC LIMIT 1"
    )
      .bind(userId)
      .first<{
        id: string
        status: string
        review_note: string
        created_at: string
        reviewed_at: string | null
      }>()
    if (!row) return null
    return {
      id: row.id,
      status: row.status,
      reviewNote: row.review_note,
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at,
    }
  } catch {
    return null
  }
}
