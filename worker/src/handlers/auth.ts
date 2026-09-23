import { ApiError, json } from "../http"
import { hashPassword, verifyPassword, needsPasswordRehash, uuid, hashToken } from "../crypto"
import { clientIp, normalizeKeyPart, guardRateLimit } from "../ratelimit"
import { isReservedName } from "../reserved-names"
import { cfCreateEmailRule, cfEnsureDestination } from "../cloudflare"
import {
  createSession,
  destroySession,
  requireUser,
  sessionCookie,
  clearedSessionCookie,
  getSessionTokens,
  toPublicUser,
  type UserRow,
} from "../auth"
import type { Env } from "../env"

/**
 * 累计登录/访问控制台的次数（用于「常客」成就）。
 * 节流：同一用户 1 小时内只计一次。失败静默，不影响主流程。
 */
async function bumpVisit(env: Env, userId: string): Promise<void> {
  try {
    const now = Date.now()
    const row = await env.DB.prepare(
      "SELECT visit_count, last_visit_at FROM user_stats WHERE user_id = ?"
    )
      .bind(userId)
      .first<{ visit_count: number; last_visit_at: string | null }>()

    const last = row?.last_visit_at ? new Date(row.last_visit_at).getTime() : 0
    if (now - last < 3600_000) return

    const iso = new Date(now).toISOString()
    if (row) {
      await env.DB.prepare(
        "UPDATE user_stats SET visit_count = visit_count + 1, last_visit_at = ? WHERE user_id = ?"
      )
        .bind(iso, userId)
        .run()
    } else {
      await env.DB.prepare(
        "INSERT INTO user_stats (user_id, visit_count, last_visit_at) VALUES (?, 1, ?)"
      )
        .bind(userId, iso)
        .run()
    }
  } catch {
    // 计数失败不影响登录态返回
  }
}

function isValidUsername(username: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(username)
}

/**
 * 限流护栏已抽到 ratelimit.ts 的 guardRateLimit()（email handler 也要用，
 * 避免两处各写一份 try/catch 导致 fail-open 行为漂移）。这里只保留策略常量。
 */

/** 登录：同一 IP 15 分钟 30 次（防广撒网）、同一账号 15 分钟 10 次（防定向爆破） */
const LOGIN_IP_LIMIT = 30
const LOGIN_IDENTIFIER_LIMIT = 10
const LOGIN_WINDOW_SECONDS = 15 * 60
/** 注册：同一 IP 1 小时 10 次（邀请码猜测 + 批量注册） */
const REGISTER_IP_LIMIT = 10
const REGISTER_WINDOW_SECONDS = 60 * 60
/** 改密码：同一账号 15 分钟 20 次（「当前密码」校验同样是爆破面） */
const PASSWORD_ATTEMPT_LIMIT = 20
const PASSWORD_WINDOW_SECONDS = 15 * 60

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

export async function register(env: Env, request: Request): Promise<Response> {
  const body = (await request.json()) as {
    username?: string
    email?: string
    password?: string
    inviteCode?: string
  }

  const username = body.username?.trim().toLowerCase() ?? ""
  const email = body.email?.trim().toLowerCase() ?? ""
  const password = body.password ?? ""
  const inviteCode = body.inviteCode?.trim() ?? ""

  // 限流：注册是「邀请码 + 用户名」的猜测面，且会写入 D1 与 Cloudflare 侧资源
  await guardRateLimit(
    env,
    `register:ip:${clientIp(request)}`,
    REGISTER_IP_LIMIT,
    REGISTER_WINDOW_SECONDS,
    "注册过于频繁"
  )

  if (!isValidUsername(username)) {
    throw new ApiError(400, "用户名只能包含小写字母、数字和连字符", "INVALID_USERNAME")
  }
  if (isReservedName(username)) {
    throw new ApiError(400, "该用户名为系统保留名称", "RESERVED_NAME")
  }
  if (!isValidEmail(email)) {
    throw new ApiError(400, "邮箱格式不正确", "INVALID_EMAIL")
  }
  if (password.length < 8) {
    throw new ApiError(400, "密码至少需要 8 位", "WEAK_PASSWORD")
  }
  if (!inviteCode) {
    throw new ApiError(400, "需要邀请码", "INVITE_REQUIRED")
  }

  // 校验邀请码
  const invite = await env.DB.prepare(
    `SELECT * FROM invite_codes
      WHERE code = ? COLLATE NOCASE
        AND used_count < max_uses
        AND (expires_at IS NULL OR expires_at > ?)
      LIMIT 1`
  )
    .bind(inviteCode, new Date().toISOString())
    .first<{ id: string; permissions: string | null }>()

  if (!invite) {
    throw new ApiError(400, "邀请码无效或已用完", "INVALID_INVITE")
  }

  // 先查占用，避免因用户名/邮箱冲突而白烧邀请码。
  //
  // 用户名会同时占用 domains.name / subdomains.fqdn / mailboxes.address 的
  // UNIQUE 约束，而其它用户可以通过「创建子域名」「添加邮箱别名」抢先占用
  // 这些名字。必须把这三种情况一并查出，否则：
  //   - 名字被抢先后本人注册会在 batch 阶段失败，而邀请码已被消费（白烧一个码）；
  //   - subdomains.fqdn 被占用时该名字将永久无法注册。
  const requestedFqdn = `${username}.${env.ROOT_DOMAIN.toLowerCase()}`
  const mailboxAddress = `${username}@${env.ROOT_DOMAIN.toLowerCase()}`

  const conflicts = await env.DB.batch([
    env.DB.prepare(
      "SELECT id FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE LIMIT 1"
    ).bind(username, email),
    env.DB.prepare(
      "SELECT id FROM subdomains WHERE fqdn = ? COLLATE NOCASE LIMIT 1"
    ).bind(requestedFqdn),
    env.DB.prepare(
      "SELECT id FROM domains WHERE name = ? COLLATE NOCASE LIMIT 1"
    ).bind(requestedFqdn),
    env.DB.prepare(
      "SELECT id FROM mailboxes WHERE address = ? COLLATE NOCASE LIMIT 1"
    ).bind(mailboxAddress),
  ])

  if (conflicts.some((r) => (r.results ?? []).length > 0)) {
    throw new ApiError(409, "用户名或邮箱已被占用", "CONFLICT")
  }

  // 注册邮箱不得是本站域名，防止转发成环
  if (email.endsWith(`@${env.ROOT_DOMAIN.toLowerCase()}`)) {
    throw new ApiError(400, "真实邮箱不能是 doulor.cn 邮箱", "INVALID_EMAIL")
  }

  const passwordHash = await hashPassword(password)
  const id = uuid()
  const now = new Date().toISOString()

  // 主邮箱的入站邮件规则（地址 → Email Worker）；失败不阻断注册
  let ruleId: string | null = null
  try {
    ruleId = await cfCreateEmailRule(
      env,
      env.ZONE_ID,
      mailboxAddress,
      env.EMAIL_WORKER_NAME ?? "doulor-mail-api"
    )
  } catch (err) {
    console.error("Email Routing 规则创建失败（注册仍继续）:", mailboxAddress, err)
  }

  // 注册真实邮箱为转发 destination（Cloudflare 会向其发送验证邮件，验证后才真正转发）
  try {
    await cfEnsureDestination(env, email)
  } catch (err) {
    console.error("转发地址注册失败（注册仍继续）:", email, err)
  }

  // 邀请码消费与全部插入放在同一个 batch（D1 batch 是事务性的）：
  // 任一条 UNIQUE 冲突都会整体回滚，邀请码不会被白白烧掉。
  // 邀请码用带条件的 UPDATE，保证并发下也不会超额使用。
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE invite_codes
          SET used_count = used_count + 1
        WHERE id = ? AND used_count < max_uses`
    ).bind(invite.id),
    env.DB.prepare(
      "INSERT INTO users (id, username, email, password_hash, namespace, status, permissions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)"
    ).bind(id, username, email, passwordHash, username, invite.permissions ?? null, now, now),
    env.DB.prepare(
      "INSERT INTO domains (id, user_id, name, zone_id, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)"
    ).bind(uuid(), id, requestedFqdn, env.ZONE_ID, now),
    env.DB.prepare(
      "INSERT INTO subdomains (id, user_id, name, fqdn, status, created_at) VALUES (?, ?, '@', ?, 'active', ?)"
    ).bind(uuid(), id, requestedFqdn, now),
    env.DB.prepare(
      "INSERT INTO mailboxes (id, user_id, address, forwarding_to, rule_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(uuid(), id, mailboxAddress, JSON.stringify([email]), ruleId, now),
    env.DB.prepare(
      "INSERT INTO audit_logs (id, user_id, action, detail, ip, created_at) VALUES (?, ?, 'register', ?, ?, ?)"
    ).bind(uuid(), id, `用户 ${username} 注册`, request.headers.get("CF-Connecting-IP"), now),
  ])

  // 邀请码在并发下被他人先用完（条件 UPDATE 未命中，整个 batch 已回滚）
  if (results[0]?.meta.changes === 0) {
    throw new ApiError(400, "邀请码无效或已用完", "INVALID_INVITE")
  }

  const token = await createSession(env, id)
  const user: UserRow = {
    id,
    username,
    email,
    password_hash: passwordHash,
    namespace: username,
    role: "user",
    status: "active",
    // 必须带上邀请码推导出的权限：漏掉会让 toPublicUser 回退到「全开」，
    // 导致新注册用户界面显示权限全开（与库中实际权限不符），
    // 直到刷新页面重新 /me 才恢复正确。
    permissions: invite.permissions ?? null,
    created_at: now,
    updated_at: now,
  }

  const res = new Response(JSON.stringify({ user: toPublicUser(user) }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  })
  res.headers.set("Set-Cookie", sessionCookie(token))
  return res
}

export async function login(env: Env, request: Request): Promise<Response> {
  const body = (await request.json()) as {
    identifier?: string
    password?: string
  }
  const identifier = body.identifier?.trim().toLowerCase() ?? ""
  const password = body.password ?? ""

  if (!identifier || !password) {
    throw new ApiError(400, "请输入用户名和密码", "INVALID_CREDENTIALS")
  }

  // 限流：登录是本站最大的爆破面（口令此前无失败锁定）。
  // 两个维度各记一次 —— IP 维度挡「一个 IP 打很多账号」，账号维度挡「很多 IP 打一个账号」。
  await guardRateLimit(
    env,
    `login:ip:${clientIp(request)}`,
    LOGIN_IP_LIMIT,
    LOGIN_WINDOW_SECONDS,
    "登录尝试过于频繁"
  )
  await guardRateLimit(
    env,
    `login:id:${normalizeKeyPart(identifier)}`,
    LOGIN_IDENTIFIER_LIMIT,
    LOGIN_WINDOW_SECONDS,
    "该账号登录尝试过于频繁"
  )

  const user = await env.DB.prepare(
    "SELECT * FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE LIMIT 1"
  )
    .bind(identifier, identifier)
    .first<UserRow>()

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    throw new ApiError(401, "用户名或密码错误", "INVALID_CREDENTIALS")
  }
  if (user.status !== "active") {
    throw new ApiError(403, "账户已被停用", "SUSPENDED")
  }

  // 口令哈希透明升级：旧格式（单次 SHA-256）或迭代次数偏低的哈希，
  // 在本次登录成功（已证明知道明文口令）时用当前算法重写一次。
  // 包 try/catch：升级失败绝不能让已经验证通过的登录失败。
  if (needsPasswordRehash(user.password_hash)) {
    try {
      const upgraded = await hashPassword(password)
      await env.DB.prepare(
        "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?"
      )
        .bind(upgraded, new Date().toISOString(), user.id)
        .run()
    } catch (err) {
      console.error("口令哈希升级失败（登录不受影响）:", user.username, err)
    }
  }

  const token = await createSession(env, user.id)
  const res = new Response(JSON.stringify({ user: toPublicUser(user) }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
  res.headers.set("Set-Cookie", sessionCookie(token))
  return res
}

export async function logout(env: Env, request: Request): Promise<Response> {
  const tokens = getSessionTokens(request)
  await destroySession(env, request)
  const res = new Response(null, { status: 204 })
  // 逐个清除同名 cookie，避免残留导致下次登录被判为未登录
  const count = Math.max(tokens.length, 1)
  for (let i = 0; i < count; i++) {
    res.headers.append("Set-Cookie", clearedSessionCookie())
  }
  return res
}

export async function me(
  env: Env,
  request: Request,
  ctx?: ExecutionContext
): Promise<Response> {
  const user = await requireUser(env, request)

  // 访问计数：同一用户 1 小时内只计一次（节流），用于「常客」成就。
  //
  // ⚠️ 必须走 ctx.waitUntil：Workers 在 fetch() 返回 Response 之后会取消所有
  // 游离的 Promise，`void fn()` 永远不会执行（这正是「常客」计数长期为 0 的原因，
  // HANDOFF §10 已记录过同类坑）。index.ts 本来就传了第三个参数 ctx，
  // 此处只是把它接住 —— 不需要改 index.ts。
  const visit = bumpVisit(env, user.id).catch(() => {})
  if (ctx) ctx.waitUntil(visit)
  else await visit // 未传 ctx 时（如单测直接调用）退化为同步等待

  const domain = await env.DB.prepare(
    "SELECT * FROM domains WHERE user_id = ? LIMIT 1"
  )
    .bind(user.id)
    .first<{ id: string; name: string; status: string; created_at: string }>()

  const dnsCount = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM dns_records WHERE domain_id = ?"
  )
    .bind(domain?.id ?? "")
    .first<{ c: number }>()

  const mailCount = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM messages m JOIN mailboxes mb ON m.mailbox_id = mb.id WHERE mb.user_id = ?"
  )
    .bind(user.id)
    .first<{ c: number }>()

  const unreadCount = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM messages m JOIN mailboxes mb ON m.mailbox_id = mb.id WHERE mb.user_id = ? AND m.read = 0"
  )
    .bind(user.id)
    .first<{ c: number }>()

  const subdomainCount = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM subdomains WHERE user_id = ? AND name != '@'"
  )
    .bind(user.id)
    .first<{ c: number }>()

  const mailboxCount = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM mailboxes WHERE user_id = ?"
  )
    .bind(user.id)
    .first<{ c: number }>()

  // 网盘：已用字节、配额（概览网盘用量卡用；文件数/最近文件见下方 recentStorageFiles）
  const storageUsed = await env.DB.prepare(
    "SELECT COALESCE(SUM(size), 0) AS c FROM storage_objects WHERE user_id = ?"
  )
    .bind(user.id)
    .first<{ c: number }>()
  const storageAccount = await env.DB.prepare(
    "SELECT quota_bytes FROM storage_accounts WHERE user_id = ?"
  )
    .bind(user.id)
    .first<{ quota_bytes: number | null }>()

  // 网盘最近 3 个文件（概览卡展示文件名 + 直链）
  const recentStorageFiles = await env.DB.prepare(
    "SELECT id, filename, r2_key, size, created_at FROM storage_objects WHERE user_id = ? ORDER BY created_at DESC LIMIT 3"
  )
    .bind(user.id)
    .all<{ id: string; filename: string; r2_key: string; size: number; created_at: string }>()

  const recentMessages = await env.DB.prepare(
    `SELECT m.id, m.from_address, m.subject, m.read, m.received_at, m.mailbox_id
       FROM messages m JOIN mailboxes mb ON m.mailbox_id = mb.id
      WHERE mb.user_id = ?
      ORDER BY m.received_at DESC LIMIT 5`
  )
    .bind(user.id)
    .all<{ id: string; from_address: string; subject: string; read: number; received_at: string; mailbox_id: string }>()

  const recent = await env.DB.prepare(
    "SELECT id, action, detail, created_at FROM audit_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 5"
  )
    .bind(user.id)
    .all<{ id: string; action: string; detail: string; created_at: string }>()

  return json({
    user: toPublicUser(user),
    domain: domain
      ? {
          id: domain.id,
          name: domain.name,
          status: domain.status,
          createdAt: domain.created_at,
        }
      : null,
    stats: {
      domains: domain ? 1 : 0,
      subdomains: subdomainCount?.c ?? 0,
      emails: mailCount?.c ?? 0,
      unread: unreadCount?.c ?? 0,
      dnsRecords: dnsCount?.c ?? 0,
      mailboxes: mailboxCount?.c ?? 0,
      emailForwards: 0,
      // 网盘（未开通：usedBytes 0、quotaBytes 0）
      storageUsedBytes: storageUsed?.c ?? 0,
      storageQuotaBytes: storageAccount?.quota_bytes ?? 0,
    },
    // 网盘最近 3 个文件（概览卡展示文件名 + 直链复制）
    recentStorageFiles: (recentStorageFiles.results ?? []).map((f) => ({
      id: f.id,
      filename: f.filename,
      r2Key: f.r2_key,
      size: f.size,
      createdAt: f.created_at,
    })),
    subdomainLimit: 5,
    mailboxLimit: 3,
    recentMessages: (recentMessages.results ?? []).map((m) => ({
      id: m.id,
      from: m.from_address,
      subject: m.subject,
      read: m.read === 1,
      receivedAt: m.received_at,
      mailboxId: m.mailbox_id,
    })),
    recentActivity: (recent.results ?? []).map((r) => ({
      id: r.id,
      action: r.action,
      detail: r.detail,
      createdAt: r.created_at,
    })),
  })
}

/**
 * PUT /api/password —— 修改密码。
 * 必须验证当前密码；修改成功后销毁其他会话（保留当前会话），
 * 避免密码泄露后旧会话仍可用。
 */
export async function changePassword(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json()) as {
    currentPassword?: string
    newPassword?: string
  }

  const currentPassword = body.currentPassword ?? ""
  const newPassword = body.newPassword ?? ""

  if (!currentPassword) {
    throw new ApiError(400, "请输入当前密码", "INVALID_INPUT")
  }

  // 限流：「当前密码」校验在会话被盗后是最后一层保护，必须防爆破
  await guardRateLimit(
    env,
    `password:user:${user.id}`,
    PASSWORD_ATTEMPT_LIMIT,
    PASSWORD_WINDOW_SECONDS,
    "尝试过于频繁"
  )
  if (newPassword.length < 8) {
    throw new ApiError(400, "新密码至少需要 8 位", "WEAK_PASSWORD")
  }
  if (newPassword === currentPassword) {
    throw new ApiError(400, "新密码不能与当前密码相同", "INVALID_INPUT")
  }

  if (!(await verifyPassword(currentPassword, user.password_hash))) {
    throw new ApiError(401, "当前密码不正确", "INVALID_CREDENTIALS")
  }

  const passwordHash = await hashPassword(newPassword)
  const now = new Date().toISOString()

  // 使除当前会话外的所有会话失效。
  // 必须保留**全部**当前 cookie 对应的会话：浏览器可能同时持有多个同名
  // doulor_session，只保留第一个会把用户真正在用的那个删掉，表现为
  // 「改完密码立刻被登出」。
  const currentTokens = getSessionTokens(request)
  const currentHashes = await Promise.all(currentTokens.map((t) => hashToken(t)))
  const keepPlaceholders = currentHashes.map(() => "?").join(", ")

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?"
    ).bind(passwordHash, now, user.id),
    currentHashes.length > 0
      ? env.DB.prepare(
          `DELETE FROM sessions WHERE user_id = ? AND token_hash NOT IN (${keepPlaceholders})`
        ).bind(user.id, ...currentHashes)
      : env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
    env.DB.prepare(
      "INSERT INTO audit_logs (id, user_id, action, detail, ip, created_at) VALUES (?, ?, 'password.change', ?, ?, ?)"
    ).bind(
      uuid(),
      user.id,
      "修改密码",
      request.headers.get("CF-Connecting-IP"),
      now
    ),
  ])

  return json({ ok: true })
}
