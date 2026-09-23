import { ApiError, json } from "../http"
import { hashPassword, verifyPassword, uuid, hashToken } from "../crypto"
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
 * 节流：同一用户 10 分钟内只计一次。失败静默，不影响主流程。
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
    if (now - last < 600_000) return

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

  // 访问计数：同一用户 10 分钟内只计一次（节流），用于「常客」成就。
  // 必须走 ctx.waitUntil —— 直接 void 的话，Worker 返回响应后会取消该 Promise，
  // 计数永远不会落库（这正是「常客一直不涨」的原因）。
  const visit = bumpVisit(env, user.id)
  if (ctx) ctx.waitUntil(visit)
  else void visit

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
    // 管理员不受配额限制（999999 作为「不限」哨兵值，前端据此显示）
    subdomainLimit: user.role === "admin" ? 999999 : 5,
    mailboxLimit: user.role === "admin" ? 999999 : 3,
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
