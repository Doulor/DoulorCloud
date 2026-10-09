/**
 * 公开 API：用户用 API Key 调用站点功能。
 *
 * ── 认证 ──
 * `Authorization: Bearer <api_key>`（也认 `X-API-Key`）。每用户一把 Key，
 * 明文只在生成/重置时返回一次，库里只存 sha256（与 session 同款 hash）。
 *
 * ── 复用现有 handler 的手法 ──
 * DNS / 邮箱这些功能的核心逻辑已经写在各自的 handler 里（校验、CF 调用、审计、
 * 发通知……），**绝不复制一份** —— 复制会分家，改一边漏一边。这里用
 * `runAs`：给「已通过 API Key 认证的用户」造一个**短命临时 session**，
 * 塞进请求里交给原 handler，原 handler 的 `requireUser` 照常工作，
 * 拿到的是同一个 user。用毕即删临时 session，不留痕。
 *
 * ── 限额 ──
 * 在进原 handler **之前**先过 `enforceApiLimit`（账号按成就点分层 + IP 固定值），
 * 超限直接 429，根本走不到业务逻辑。原 handler 自带的 per-user 限流（如
 * DNS 30 次/分钟）继续生效，与 API 限额是**两层**，互不干扰。
 */
import { ApiError, json } from "../http"
import { sessionCookie, requireUser, isPrivileged } from "../auth"
import { hashToken, generateToken, uuid } from "../crypto"
import { clientIp } from "../ratelimit"
import { API_SOURCE_HEADER, API_ADMIN_HEADER } from "../api-source"
import { getApiFeatureConfig, enforceApiLimit, getUserAchievementPoints, tierFor, accountLimitFor, listApiFeatures } from "../api-engine"
import * as dnsHandlers from "./dns"
import * as emailHandlers from "./email"
import * as subdomainHandlers from "./subdomains"
import type { Env } from "../env"

const API_KEY_PREFIX = "doulor_"

/**
 * 会改数据的 HTTP 方法 —— 公开 API 里这些一律要过「邮箱已验证」门槛。
 * 只读方法放行，口径与站内的 `READ_ONLY_METHODS` 一致（能进页面、能读）。
 */
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])

/** 从请求头提取 API Key（Bearer 优先，其次 X-API-Key） */
function extractApiKey(request: Request): string {
  const auth = request.headers.get("Authorization") ?? ""
  const bearer = auth.match(/^Bearer\s+(.+)$/i)
  if (bearer) return bearer[1].trim()
  return (request.headers.get("X-API-Key") ?? "").trim()
}

/**
 * 用 API Key 认证，返回对应用户。
 * 顺带更新 last_used_at（Key 管理页能显示「这把 key 最近用过」）。
 */
async function requireApiKeyUser(
  env: Env,
  request: Request
): Promise<{ id: string; role: string; status: string; emailVerified: boolean; isAdmin: boolean }> {
  const key = extractApiKey(request)
  if (!key) throw new ApiError(401, "缺少 API Key（用 Authorization: Bearer 携带）", "UNAUTHORIZED")
  const hash = await hashToken(key)
  const row = await env.DB.prepare(
    `SELECT u.id, u.role, u.status, u.email_verified, k.is_admin
       FROM user_api_keys k
       JOIN users u ON u.id = k.user_id
      WHERE k.key_hash = ?`
  )
    .bind(hash)
    .first<{
      id: string
      role: string
      status: string
      email_verified: number | null
      is_admin: number | null
    }>()
  if (!row) throw new ApiError(401, "API Key 无效", "UNAUTHORIZED")
  if (row.status !== "active") throw new ApiError(403, "账号已被停用", "ACCOUNT_SUSPENDED")

  await env.DB.prepare(`UPDATE user_api_keys SET last_used_at = ? WHERE user_id = ?`)
    .bind(new Date().toISOString(), row.id)
    .run()
  // 双重保险：标记为管理员 Key，但该用户**现在**已经不是「超级管理员 / root」了
  // （被降权、或降成普通 admin）⇒ 不认管理员身份。
  // 否则降权后那把 Key 还能免限额，等于权限下不来。
  const isAdmin = row.is_admin === 1 && isPrivileged(row.role)
  return {
    id: row.id,
    role: row.role,
    status: row.status,
    emailVerified: row.email_verified === 1,
    isAdmin,
  }
}

/**
 * 造一个短命临时 session，把请求交给原 handler 执行，用毕删除。
 *
 * 不直接用 `createSession`：那会触发「淘汰最旧会话」的维护逻辑，可能误伤
 * 用户的真实会话。这里单独插一条 5 分钟过期的，用完精准删除。
 */
async function runAs(
  env: Env,
  request: Request,
  user: { id: string; isAdmin?: boolean },
  fn: (env: Env, request: Request) => Promise<Response>
): Promise<Response> {
  const token = generateToken()
  const tokenHash = await hashToken(token)
  const id = uuid()
  const now = new Date()
  const exp = new Date(now.getTime() + 5 * 60 * 1000)
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`
  )
    .bind(id, user.id, tokenHash, exp.toISOString(), now.toISOString())
    .run()

  const headers = new Headers(request.headers)
  headers.set("Cookie", sessionCookie(token, 300))
  // 标记这是 API 调用，让被复用的 handler 给记录打 source='api'
  headers.set(API_SOURCE_HEADER, "api")
  // 管理员 Key：额外打一个标记，各处的限额检查据此放行。
  // 两个头都由 index.ts 的入口剥掉客户端版本，客户端伪造不了。
  if (user.isAdmin) headers.set(API_ADMIN_HEADER, "1")
  const clone = new Request(request, { headers })
  try {
    return await fn(env, clone)
  } finally {
    await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(id).run()
  }
}

/**
 * 统一的「认证 + 限额」前置，返回 user 与 config；通过后才进业务。
 *
 * ⚠️ 管理员 Key（`is_admin`）**不消耗也不受 API 速率限制** —— 直接跳过
 * `enforceApiLimit`（按成就点分层 + IP 上限这两层都跳过）。
 * 它豁免的只是「公开 API 这一层的限流」；被复用 handler 内部的业务上限
 * 由各 handler 自己按 `isAdminApiRequest()` 放行（见 subdomains.ts / email.ts）。
 */
async function apiGate(env: Env, request: Request, feature: string) {
  const user = await requireApiKeyUser(env, request)

  /**
   * 🔴 未验证邮箱的账号**不得经公开 API 写数据**（2026-10-09 渗透测试 finding#2/#6）。
   *
   * 站内那道门槛（`auth.ts::needsVerifiedEmail`）是按「去掉 /api 前缀的路径」做前缀匹配的，
   * 而本文件的路径是 `/api/v1/xxx` ⇒ 归一化后成了 `/v1/xxx`，**不命中任何前缀**，
   * 于是 `runAs` 造的临时会话把门槛一路绕过去了：
   * 同一个账号走 `POST /api/mailbox` 被 403 EMAIL_NOT_VERIFIED，
   * 走 `POST /api/v1/mailbox`（Bearer API Key）却 201 建成功。
   *
   * 在**这一层**统一补上，而不是去改前缀匹配 —— 后者要么给每个功能各加一条 `/v1/xxx` 前缀
   * （新增功能必然漏），要么改成解析路由表（脆弱）。这里按「写操作 + 未验证 + 非特权」
   * 一刀切，与站内口径一致，新加的功能自动受保护。
   */
  if (
    WRITE_METHODS.has(request.method.toUpperCase()) &&
    !user.emailVerified &&
    !isPrivileged(user.role)
  ) {
    throw new ApiError(
      403,
      "请先验证邮箱后再使用该功能（设置 → 真实邮箱验证）",
      "EMAIL_NOT_VERIFIED"
    )
  }

  const config = await getApiFeatureConfig(env, feature)
  if (!config) throw new ApiError(404, "未知的 API 功能", "NOT_FOUND")
  if (!config.enabled) throw new ApiError(403, "该功能的 API 尚未开放", "API_DISABLED")
  if (user.isAdmin) return { user, limit: { tier: 0, accountLimit: 0, ipLimit: 0 } }
  const limit = await enforceApiLimit(env, {
    userId: user.id,
    ip: clientIp(request),
    feature,
    config,
  })
  return { user, limit }
}

// ────────────────────────── /v1 路由 ──────────────────────────
//
// 每个公开接口 = apiGate（认证 + 限额）→ runAs（临时 session 复用原 handler）。
// 带 id 的用闭包把 id 传给原 handler，业务逻辑零复制。

// ---- DNS（feature: dns）----

/** GET /v1/dns —— 列 DNS 记录 */
export async function apiListDns(env: Env, request: Request): Promise<Response> {
  const { user } = await apiGate(env, request, "dns")
  return runAs(env, request, user, dnsHandlers.listDns)
}

/** POST /v1/dns —— 创建 DNS 记录 */
export async function apiCreateDns(env: Env, request: Request): Promise<Response> {
  const { user } = await apiGate(env, request, "dns")
  return runAs(env, request, user, dnsHandlers.createDns)
}

/** PUT /v1/dns/:id —— 编辑 DNS 记录 */
export async function apiUpdateDns(env: Env, request: Request, id: string): Promise<Response> {
  const { user } = await apiGate(env, request, "dns")
  return runAs(env, request, user, (e, r) => dnsHandlers.updateDns(e, r, id))
}

/** DELETE /v1/dns/:id —— 删除 DNS 记录 */
export async function apiDeleteDns(env: Env, request: Request, id: string): Promise<Response> {
  const { user } = await apiGate(env, request, "dns")
  return runAs(env, request, user, (e, r) => dnsHandlers.deleteDns(e, r, id))
}

// ---- 子域名（feature: subdomain）----
//
// 注意与 DNS 的区别：DNS 管的是「用户自己域名的解析记录」；
// 子域名管的是「在站点根域名下开一个 xxx.doulor.cn」。两者是独立资源。

/** GET /v1/subdomain —— 列自己的子域名 */
export async function apiListSubdomain(env: Env, request: Request): Promise<Response> {
  const { user } = await apiGate(env, request, "subdomain")
  return runAs(env, request, user, subdomainHandlers.listSubdomains)
}

/** POST /v1/subdomain —— 创建子域名 */
export async function apiCreateSubdomain(env: Env, request: Request): Promise<Response> {
  const { user } = await apiGate(env, request, "subdomain")
  return runAs(env, request, user, subdomainHandlers.createSubdomain)
}

/** DELETE /v1/subdomain/:id —— 删除子域名 */
export async function apiDeleteSubdomain(env: Env, request: Request, id: string): Promise<Response> {
  const { user } = await apiGate(env, request, "subdomain")
  return runAs(env, request, user, (e, r) => subdomainHandlers.deleteSubdomain(e, r, id))
}

// ---- 邮箱（feature: mailbox）----

/** GET /v1/mailbox —— 列收件箱 */
export async function apiListMailbox(env: Env, request: Request): Promise<Response> {
  const { user } = await apiGate(env, request, "mailbox")
  return runAs(env, request, user, emailHandlers.listMailboxes)
}

/** POST /v1/mailbox —— 创建邮箱 */
export async function apiCreateMailbox(env: Env, request: Request): Promise<Response> {
  const { user } = await apiGate(env, request, "mailbox")
  return runAs(env, request, user, emailHandlers.createMailbox)
}

/** DELETE /v1/mailbox/:id —— 删除邮箱（连带它的邮件） */
export async function apiDeleteMailbox(env: Env, request: Request, id: string): Promise<Response> {
  const { user } = await apiGate(env, request, "mailbox")
  return runAs(env, request, user, (e, r) => emailHandlers.deleteMailbox(e, r, id))
}

/** GET /v1/mailbox/:id/messages —— 邮件列表 */
export async function apiListMessages(env: Env, request: Request, mailboxId: string): Promise<Response> {
  const { user } = await apiGate(env, request, "mailbox")
  return runAs(env, request, user, (e, r) => emailHandlers.listMessages(e, r, mailboxId))
}

/** GET /v1/mailbox/:id/messages/:mid —— 邮件内容 */
export async function apiGetMessage(
  env: Env,
  request: Request,
  mailboxId: string,
  messageId: string
): Promise<Response> {
  const { user } = await apiGate(env, request, "mailbox")
  return runAs(env, request, user, (e, r) => emailHandlers.getMessage(e, r, mailboxId, messageId))
}

// ---- 临时邮箱（feature: temp_mailbox）----

/** POST /v1/temp-mailbox —— 创建临时邮箱（随机邮箱） */
export async function apiCreateTempMailbox(env: Env, request: Request): Promise<Response> {
  const { user } = await apiGate(env, request, "temp_mailbox")
  return runAs(env, request, user, emailHandlers.createTempMailbox)
}

/** POST /v1/temp-mailbox/:id/refresh —— 刷新（换一个地址，旧地址作废） */
export async function apiRefreshTempMailbox(env: Env, request: Request, id: string): Promise<Response> {
  const { user } = await apiGate(env, request, "temp_mailbox")
  return runAs(env, request, user, (e, r) => emailHandlers.refreshTempMailbox(e, r, id))
}

/** GET /v1/temp-mailbox/:id/messages —— 读取收件内容（列表） */
export async function apiListTempMessages(env: Env, request: Request, mailboxId: string): Promise<Response> {
  const { user } = await apiGate(env, request, "temp_mailbox")
  return runAs(env, request, user, (e, r) => emailHandlers.listMessages(e, r, mailboxId))
}

/** GET /v1/temp-mailbox/:id/messages/:mid —— 读取单封邮件 */
export async function apiGetTempMessage(
  env: Env,
  request: Request,
  mailboxId: string,
  messageId: string
): Promise<Response> {
  const { user } = await apiGate(env, request, "temp_mailbox")
  return runAs(env, request, user, (e, r) => emailHandlers.getMessage(e, r, mailboxId, messageId))
}

// ────────────────────────── Key 管理（设置页，走 session） ──────────────────────────

/** GET /api/api-key —— 当前 Key 状态（明文永不回传） */
export async function getApiKeyStatus(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const row = await env.DB.prepare(
    `SELECT key_prefix, created_at, last_used_at, is_admin FROM user_api_keys WHERE user_id = ?`
  )
    .bind(user.id)
    .first<{
      key_prefix: string
      created_at: string
      last_used_at: string | null
      is_admin: number | null
    }>()

  return json({
    hasKey: Boolean(row),
    prefix: row?.key_prefix ?? null,
    createdAt: row?.created_at ?? null,
    lastUsedAt: row?.last_used_at ?? null,
    // 与 requireApiKeyUser 同口径：降权后旧的管理员 Key 不再算管理员
    isAdmin: row?.is_admin === 1 && isPrivileged(user.role),
    // 前端据此决定要不要显示「管理员 Key」开关（只给超级管理员 / root）
    canCreateAdminKey: isPrivileged(user.role),
  })
}

/**
 * POST /api/api-key —— 生成新 Key（已有则覆盖，旧 Key 立即作废）。明文只返回这一次
 *
 * 可选 `{ "admin": true }` 生成**管理员 Key**：不受 API 速率、子域名速率、
 * 子域名数量、邮箱数量限制。
 *
 * ⚠️ **只给「超级管理员 / root」（`isPrivileged`），普通 `admin` 不行** ——
 * 普通 admin 是「自定义管理员，只能做白名单里允许的事」，给他免限额的 Key
 * 等于绕过白名单。实测：role=admin 请求会拿到 403，
 * `/api/api-key` 的 `canCreateAdminKey` 也是 false（前端据此不显示开关）。
 */
export async function generateApiKey(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json().catch(() => ({}))) as { admin?: boolean }
  const wantAdmin = body?.admin === true
  if (wantAdmin && !isPrivileged(user.role)) {
    throw new ApiError(403, "只有超级管理员或 root 可以生成管理员 Key", "FORBIDDEN")
  }

  const key = API_KEY_PREFIX + generateToken()
  const hash = await hashToken(key)
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO user_api_keys (user_id, key_hash, key_prefix, created_at, last_used_at, is_admin)
     VALUES (?, ?, ?, ?, NULL, ?)
     ON CONFLICT(user_id) DO UPDATE SET key_hash = excluded.key_hash,
       key_prefix = excluded.key_prefix, created_at = excluded.created_at,
       last_used_at = NULL, is_admin = excluded.is_admin`
  )
    .bind(user.id, hash, key.slice(0, 8), now, wantAdmin ? 1 : 0)
    .run()
  return json({ apiKey: key, prefix: key.slice(0, 8), isAdmin: wantAdmin }, 201)
}

/** DELETE /api/api-key —— 删除 Key（禁用 API 调用） */
export async function deleteApiKey(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  await env.DB.prepare(`DELETE FROM user_api_keys WHERE user_id = ?`).bind(user.id).run()
  return json({ ok: true })
}

/** GET /api/api-doc —— 用户视角的 API 文档（自己的层级/额度 + 各功能开放与否） */
export async function getApiDoc(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const points = await getUserAchievementPoints(env, user.id)
  const tier = tierFor(points)
  const features = await listApiFeatures(env)
  const items = features.map((f) => ({
    feature: f.feature,
    enabled: f.enabled,
    tier,
    accountLimit: accountLimitFor(tier, f.tierLimits),
    ipLimit: f.ipLimit,
  }))
  return json({
    achievementPoints: points,
    tier,
    features: items,
  })
}
