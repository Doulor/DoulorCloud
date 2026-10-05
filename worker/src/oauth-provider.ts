/**
 * OAuth 2.0 授权服务器核心逻辑（Doulor Cloud 作为身份提供方 / IdP）。
 *
 * ⚠️ 方向：本模块让**别的站点**用 Doulor Cloud 账号登录我们，
 * 不是让我们去登录别人。首个消费者是 NewAPI。
 *
 * 为什么是「OIDC 兼容」而不是完整 OIDC：
 *   已核对 new-api 源码（oauth/oidc.go），它拿到 access_token 后**只检查非空**，
 *   完全不验证 id_token 的签名，随后直接拿 token 调 /userinfo 取这 5 个字段：
 *     sub / email / name / preferred_username / picture
 *   因此一期不需要 RSA 密钥对、JWKS、JWT 签名这一整块（最容易写错的部分）。
 *   access_token 用不透明随机串即可。
 *   ⚠️ 二期若接别的站点需要真 id_token 时，**不要推翻这里的接口形状**，
 *      只需在 token 响应里多返回一个 id_token 字段 + 加 /jwks.json。
 *
 * 字段来源约定：
 *   sub                → users.id（UUID，稳定；**绝不能用邮箱或用户名**，它们会变）
 *   preferred_username → users.username
 *   name               → users.nickname ?? users.username
 *   email              → users.email（scope 含 email 时才返回）
 *   picture            → 本站头像地址（scope 含 profile 且用户有头像时）
 */
import { ApiError } from "./http"
import { generateToken, hashToken, uuid, timingSafeEqual } from "./crypto"
import type { Env } from "./env"

// ---- 常量 ----

/** 授权码有效期：60 秒。够对方立即兑换，短到即使泄露也基本没用 */
export const CODE_TTL_SECONDS = 60

/** access_token 有效期：1 小时。对方只在登录那一刻用它换一次用户信息 */
export const ACCESS_TOKEN_TTL_SECONDS = 3600

/** 我们支持的 scope。第三方请求了别的会被拒绝（不做静默降级，避免暗中缩小权限） */
export const SUPPORTED_SCOPES = ["openid", "profile", "email"] as const
export type Scope = (typeof SUPPORTED_SCOPES)[number]

/** 未指定 scope 时的默认值 */
export const DEFAULT_SCOPES = "openid profile email"

// ---- 审核状态（2026-10-06，迁移 0123）----

export const REVIEW_APPROVED = "approved"
export const REVIEW_PENDING = "pending"
export const REVIEW_REJECTED = "rejected"

/** 只有 approved 的应用才能进入授权流程 */
export function isClientUsable(client: { review_status?: string | null; disabled?: number }): boolean {
  if (client.disabled === 1) return false
  const status = client.review_status ?? REVIEW_APPROVED
  return status === REVIEW_APPROVED
}

/**
 * 应用名里禁止出现的词（防钓鱼仿冒）。
 *
 * 为什么必须有：同意页展示给用户的就是「应用名 + 权限」，用户判断「这是不是官方的」
 * 基本只看名字。放任用户起名「Doulor Cloud 官方验证」「账号申诉客服」，等于把
 * 钓鱼工具直接发到他手上。
 *
 * 匹配是**大小写不敏感的子串**匹配（中文没有大小写，英文一并规范化），
 * 有意做得宽一点：宁可让用户换个名字，也不要漏掉明显仿冒的。
 */
const FORBIDDEN_NAME_PARTS = [
  "doulor",
  "官方",
  "客服",
  "管理",
  "验证",
  "申诉",
  "解封",
  "安全中心",
  "系统",
  "admin",
  "official",
  "support",
  "verify",
  "verification",
  "security",
  "service",
  "helpdesk",
]

/** 应用名合法性：非空、长度合适、不含敏感词。不合法时抛 400 */
export function assertClientNameAllowed(rawName: string): string {
  const name = rawName.trim()
  if (!name) throw new ApiError(400, "应用名不能为空", "INVALID_NAME")
  if (name.length > 40) throw new ApiError(400, "应用名最长 40 个字", "INVALID_NAME")
  const lower = name.toLowerCase()
  for (const part of FORBIDDEN_NAME_PARTS) {
    if (lower.includes(part.toLowerCase())) {
      throw new ApiError(
        400,
        `应用名不能包含「${part}」——避免与官方/客服混淆。请换一个能体现你站点自身的名字`,
        "NAME_NOT_ALLOWED"
      )
    }
  }
  return name
}

/**
 * 取一组回调地址的**站点域名**（去重、保序），用于同意页与后台展示。
 *
 * 同意页要显示「哪个网站想访问你的账号」——域名是用户唯一能自己核对的东西
 * （应用名是对方随便填的）。这里只取 host，不带路径，免得一串 query 挤爆界面。
 */
export function redirectHosts(redirectUris: string[]): string[] {
  const out: string[] = []
  for (const uri of redirectUris) {
    try {
      const host = new URL(uri).host
      if (host && !out.includes(host)) out.push(host)
    } catch {
      // 坏 URL 已在录入时拦掉；这里静默跳过，别让展示层崩
    }
  }
  return out
}

// ---- 行类型 ----

export interface OAuthClientRow {
  id: string
  client_id: string
  client_secret_hash: string
  name: string
  redirect_uris: string
  scopes: string
  owner_user_id: string | null
  disabled: number
  /**
   * 审核状态（2026-10-06 迁移 0123）：
   *   'approved' —— 可正常授权（管理员建的客户端与既有客户端恒为此值）；
   *   'pending'  —— 用户提交待站长审核，**授权页直接拒绝**；
   *   'rejected' —— 已驳回，同样拒绝（用户可改内容后重新提交）。
   */
  review_status: string
  review_note: string | null
  reviewed_at: string | null
  reviewed_by: string | null
  created_at: string
  updated_at: string
}

export interface OAuthCodeRow {
  id: string
  code_hash: string
  client_id: string
  user_id: string
  redirect_uri: string
  scopes: string
  code_challenge: string | null
  code_challenge_method: string | null
  expires_at: string
  used: number
  created_at: string
}

/** 对外暴露的 client 形态（不含任何密钥字段） */
export interface PublicClient {
  id: string
  clientId: string
  name: string
  redirectUris: string[]
  scopes: string
  disabled: boolean
  ownerUserId: string | null
  /** 审核状态：approved | pending | rejected */
  reviewStatus: string
  /** 审核意见（驳回原因等），无则不返回 */
  reviewNote: string | null
  createdAt: string
  updatedAt: string
}

export function toPublicClient(row: OAuthClientRow): PublicClient {
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    redirectUris: parseRedirectUris(row.redirect_uris),
    scopes: row.scopes,
    disabled: row.disabled === 1,
    ownerUserId: row.owner_user_id,
    // 老数据 / 未迁移时兜底为 approved，避免把既有客户端判成待审核
    reviewStatus: row.review_status ?? REVIEW_APPROVED,
    reviewNote: row.review_note ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ---- 小工具 ----

function parseRedirectUris(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === "string")
  } catch {
    // 库里存了坏 JSON 时不能让整个列表页崩掉，当作没有回调地址处理
    return []
  }
}

export function normalizeScopes(raw: string | null | undefined): string {
  const parts = (raw ?? "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
  // 去重并保持稳定顺序
  const uniq = Array.from(new Set(parts))
  return uniq.join(" ") || DEFAULT_SCOPES
}

/** 请求的 scope 必须是我们支持的子集；否则报错而不是悄悄砍掉 */
export function assertScopesAllowed(scopes: string): void {
  const allowed = new Set<string>(SUPPORTED_SCOPES)
  for (const s of scopes.split(/\s+/).filter(Boolean)) {
    if (!allowed.has(s)) {
      throw new ApiError(400, `不支持的 scope：${s}`, "INVALID_SCOPE")
    }
  }
}

/**
 * 校验回调地址。
 *
 * ⚠️ 必须**精确字符串匹配**，绝不做前缀 / 通配 / 大小写宽松匹配。
 * 这是 OAuth 最经典的漏洞面：只要允许前缀匹配，
 * 攻击者注册 `https://good.com.evil.com` 或 `https://good.com/../../x`
 * 就能把授权码骗到自己服务器上，进而拿到用户的 access_token。
 */
export function isRedirectUriAllowed(client: OAuthClientRow, uri: string): boolean {
  return parseRedirectUris(client.redirect_uris).includes(uri)
}

/** 回调地址的合法性检查（管理端录入时用） */
export function validateRedirectUri(uri: string, allowHttp: boolean): void {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    throw new ApiError(400, `回调地址不是合法 URL：${uri}`, "INVALID_REDIRECT_URI")
  }
  if (url.protocol === "https:") return
  // 允许 http 仅用于本机调试（127.0.0.1 / localhost），且必须显式开启
  if (allowHttp && url.protocol === "http:" && isLoopback(url.hostname)) return
  if (url.protocol === "http:") {
    throw new ApiError(
      400,
      `回调地址必须用 https（本机 127.0.0.1/localhost 可例外）：${uri}`,
      "INVALID_REDIRECT_URI"
    )
  }
  throw new ApiError(400, `回调地址协议不支持：${uri}`, "INVALID_REDIRECT_URI")
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]"
}

// ---- 客户端（第三方应用）管理 ----

function newClientId(): string {
  // 可读前缀，方便用户在对方站点配置时辨认
  return `dc_${generateToken().slice(0, 24)}`
}

function newClientSecret(): string {
  return `dcs_${generateToken()}`
}

export async function createClient(
  env: Env,
  input: {
    name: string
    redirectUris: string[]
    scopes?: string
    ownerUserId?: string | null
    allowHttp?: boolean
    /**
     * 审核状态。管理员在后台直接建 = approved（默认，与既有行为一致）；
     * 用户自助创建时由调用方按设置项决定 approved / pending。
     */
    reviewStatus?: string
  }
): Promise<{ client: PublicClient; clientSecret: string }> {
  const name = assertClientNameAllowed(input.name)
  if (input.redirectUris.length === 0) {
    throw new ApiError(400, "至少需要一个回调地址", "INVALID_REDIRECT_URI")
  }
  for (const uri of input.redirectUris) {
    validateRedirectUri(uri, input.allowHttp ?? false)
  }

  const scopes = normalizeScopes(input.scopes)
  assertScopesAllowed(scopes)

  const reviewStatus = input.reviewStatus ?? REVIEW_APPROVED
  const clientId = newClientId()
  const clientSecret = newClientSecret()
  const id = uuid()
  const now = new Date().toISOString()

  await env.DB.prepare(
    `INSERT INTO oauth_clients
       (id, client_id, client_secret_hash, name, redirect_uris, scopes, owner_user_id, disabled,
        review_status, reviewed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
  )
    .bind(
      id,
      clientId,
      await hashToken(clientSecret),
      name,
      JSON.stringify(input.redirectUris),
      scopes,
      input.ownerUserId ?? null,
      reviewStatus,
      // 免审直接建出来的相当于「已审核」，否则留空等站长处理
      reviewStatus === REVIEW_APPROVED ? now : null,
      now,
      now
    )
    .run()

  return {
    client: {
      id,
      clientId,
      name,
      redirectUris: input.redirectUris,
      scopes,
      disabled: false,
      ownerUserId: input.ownerUserId ?? null,
      reviewStatus,
      reviewNote: null,
      createdAt: now,
      updatedAt: now,
    },
    // ⚠️ 明文只在此刻返回一次，之后库中只有哈希，无法再取回
    clientSecret,
  }
}

/**
 * 某个用户自己创建的应用（「我的应用」列表用）。
 *
 * 注意：管理端列表**不走这里** —— 它要带创建者用户名，直接在 handler 里
 * 用一条 JOIN 查询（`handlers/oauth.ts` 的 adminListClients），少一次往返。
 */
export async function listClientsByOwner(
  env: Env,
  ownerUserId: string
): Promise<PublicClient[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM oauth_clients WHERE owner_user_id = ? ORDER BY created_at DESC"
  )
    .bind(ownerUserId)
    .all<OAuthClientRow>()
  return (res.results ?? []).map(toPublicClient)
}

/** 某个用户已创建的应用数量（创建时的配额检查用） */
export async function countClientsByOwner(env: Env, ownerUserId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM oauth_clients WHERE owner_user_id = ?"
  )
    .bind(ownerUserId)
    .first<{ n: number }>()
  return Number(row?.n ?? 0)
}

/** 按内部 id 取，且必须是**该用户自己的**应用（越权访问返回 null） */
export async function getOwnedClient(
  env: Env,
  id: string,
  ownerUserId: string
): Promise<OAuthClientRow | null> {
  return env.DB.prepare("SELECT * FROM oauth_clients WHERE id = ? AND owner_user_id = ? LIMIT 1")
    .bind(id, ownerUserId)
    .first<OAuthClientRow>()
}

export async function getClientByInternalId(
  env: Env,
  id: string
): Promise<OAuthClientRow | null> {
  return env.DB.prepare("SELECT * FROM oauth_clients WHERE id = ? LIMIT 1")
    .bind(id)
    .first<OAuthClientRow>()
}

export async function loadClientByClientId(
  env: Env,
  clientId: string
): Promise<OAuthClientRow | null> {
  return env.DB.prepare("SELECT * FROM oauth_clients WHERE client_id = ? LIMIT 1")
    .bind(clientId)
    .first<OAuthClientRow>()
}

export async function updateClient(
  env: Env,
  id: string,
  patch: {
    name?: string
    redirectUris?: string[]
    scopes?: string
    disabled?: boolean
    allowHttp?: boolean
    /** 审核结果（管理端审核 / 用户改动后重置为 pending） */
    reviewStatus?: string
    /** 审核意见（驳回原因），传 null 清空 */
    reviewNote?: string | null
    /** 审核人（用户名或 id，仅记录用） */
    reviewedBy?: string | null
  }
): Promise<void> {
  const row = await getClientByInternalId(env, id)
  if (!row) throw new ApiError(404, "应用不存在", "NOT_FOUND")

  const sets: string[] = []
  const binds: unknown[] = []

  if (patch.name !== undefined) {
    sets.push("name = ?")
    binds.push(assertClientNameAllowed(patch.name))
  }
  if (patch.redirectUris !== undefined) {
    if (patch.redirectUris.length === 0) {
      throw new ApiError(400, "至少需要一个回调地址", "INVALID_REDIRECT_URI")
    }
    for (const uri of patch.redirectUris) {
      validateRedirectUri(uri, patch.allowHttp ?? false)
    }
    sets.push("redirect_uris = ?")
    binds.push(JSON.stringify(patch.redirectUris))
  }
  if (patch.scopes !== undefined) {
    const scopes = normalizeScopes(patch.scopes)
    assertScopesAllowed(scopes)
    sets.push("scopes = ?")
    binds.push(scopes)
  }
  if (patch.disabled !== undefined) {
    sets.push("disabled = ?")
    binds.push(patch.disabled ? 1 : 0)
  }
  if (patch.reviewStatus !== undefined) {
    if (![REVIEW_APPROVED, REVIEW_PENDING, REVIEW_REJECTED].includes(patch.reviewStatus)) {
      throw new ApiError(400, `未知的审核状态：${patch.reviewStatus}`, "INVALID_INPUT")
    }
    sets.push("review_status = ?")
    binds.push(patch.reviewStatus)
    // 通过时记审核时间；回到 pending 则清掉（表示又被重新排队）
    sets.push("reviewed_at = ?")
    binds.push(patch.reviewStatus === REVIEW_APPROVED ? new Date().toISOString() : null)
    sets.push("reviewed_by = ?")
    binds.push(patch.reviewStatus === REVIEW_APPROVED ? (patch.reviewedBy ?? null) : null)
  }
  if (patch.reviewNote !== undefined) {
    sets.push("review_note = ?")
    binds.push(patch.reviewNote)
  }

  if (sets.length === 0) return

  sets.push("updated_at = ?")
  binds.push(new Date().toISOString(), id)

  await env.DB.prepare(`UPDATE oauth_clients SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run()

  // ⚠️ 2026-09-25 审计（L14）：停用应用必须**同时作废它已签发的令牌**。
  // 原先只把 `oauth_clients.disabled` 置 1，而 `verifyAccessToken` 根本不看这个标志 ——
  // 于是「管理员停用了一个应用」之后，它手上的 access_token 仍能继续调
  // `/userinfo` 直到自然过期（最长 1 小时）。停用应当是立即生效的。
  //
  // 2026-10-06 扩展：**审核状态不再是 approved 时同样作废**。尤其「用户改了回调地址
  // → 重新排队待审」这条路径：不切断旧令牌的话，改地址前骗到的授权会继续有效，
  // 把地址改回去就白改了。
  const notApproved = patch.reviewStatus !== undefined && patch.reviewStatus !== REVIEW_APPROVED
  if (patch.disabled === true || notApproved) {
    await env.DB.prepare(
      "UPDATE oauth_tokens SET revoked = 1 WHERE client_id = ? AND revoked = 0"
    )
      .bind(row.client_id)
      .run()
  }
}

/** 重置密钥：返回新的明文，旧的立即失效 */
export async function resetClientSecret(env: Env, id: string): Promise<string> {
  const row = await getClientByInternalId(env, id)
  if (!row) throw new ApiError(404, "应用不存在", "NOT_FOUND")

  const clientSecret = newClientSecret()
  await env.DB.prepare(
    "UPDATE oauth_clients SET client_secret_hash = ?, updated_at = ? WHERE id = ?"
  )
    .bind(await hashToken(clientSecret), new Date().toISOString(), id)
    .run()
  return clientSecret
}

/**
 * 删除应用：连带清掉它的授权码、令牌与授权记忆。
 * 不清的话，被删应用的 token 仍然能通过校验（因为校验只看 oauth_tokens 表）。
 */
export async function deleteClient(env: Env, id: string): Promise<void> {
  const row = await getClientByInternalId(env, id)
  if (!row) throw new ApiError(404, "应用不存在", "NOT_FOUND")

  await env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_tokens WHERE client_id = ?").bind(row.client_id),
    env.DB.prepare("DELETE FROM oauth_codes WHERE client_id = ?").bind(row.client_id),
    env.DB.prepare("DELETE FROM oauth_grants WHERE client_id = ?").bind(row.client_id),
    env.DB.prepare("DELETE FROM oauth_clients WHERE id = ?").bind(id),
  ])
}

/**
 * 校验 client_secret（token 端点用）。
 *
 * ⚠️ 2026-09-25 审计（L18）：原先用 `===` 比较两个 SHA-256 十六进制摘要，
 * 注释还写着「时间安全比较由哈希后比对天然满足」—— 这个说法是错的：
 * `===` 在第一个不同字符处短路，仍然泄露前缀匹配长度。
 * 摘要不可逆让它实际不可利用，但仓库里本来就有 `timingSafeEqual`，没有理由不复用。
 */
export async function verifyClientSecret(
  client: OAuthClientRow,
  secret: string
): Promise<boolean> {
  if (!secret) return false
  const actual = await hashToken(secret)
  return timingSafeEqual(actual, client.client_secret_hash)
}

// ---- 授权码 ----

export async function issueCode(
  env: Env,
  input: {
    clientId: string
    userId: string
    redirectUri: string
    scopes: string
    codeChallenge?: string | null
    codeChallengeMethod?: string | null
  }
): Promise<string> {
  const code = generateToken()
  const now = new Date()
  await env.DB.prepare(
    `INSERT INTO oauth_codes
       (id, code_hash, client_id, user_id, redirect_uri, scopes, code_challenge, code_challenge_method, expires_at, used, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  )
    .bind(
      uuid(),
      await hashToken(code),
      input.clientId,
      input.userId,
      input.redirectUri,
      input.scopes,
      input.codeChallenge ?? null,
      input.codeChallengeMethod ?? null,
      new Date(now.getTime() + CODE_TTL_SECONDS * 1000).toISOString(),
      now.toISOString()
    )
    .run()
  return code
}

/** PKCE S256 校验：base64url(sha256(verifier)) === challenge */
async function verifyPkce(
  verifier: string,
  challenge: string,
  method: string
): Promise<boolean> {
  if (method !== "S256") {
    // 不支持 plain —— 它不提供任何保护，反而给人「用了 PKCE」的错觉
    return false
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
  return b64 === challenge
}

/**
 * 兑换授权码。任何一种不匹配都抛错。
 *
 * 顺序很重要：先校验全部条件，再用**条件 UPDATE** 原子地把 used 置 1
 * （`WHERE used = 0`）。若 changes === 0 说明码已被并发兑换过，
 * 走「一次性」语义 —— 这也是 OAuth 规范要求的行为（重放必须失败）。
 */
export async function redeemCode(
  env: Env,
  input: {
    code: string
    client: OAuthClientRow
    redirectUri: string
    codeVerifier?: string | null
  }
): Promise<{ userId: string; scopes: string }> {
  const codeHash = await hashToken(input.code)
  const row = await env.DB.prepare("SELECT * FROM oauth_codes WHERE code_hash = ? LIMIT 1")
    .bind(codeHash)
    .first<OAuthCodeRow>()

  const invalid = new ApiError(400, "授权码无效或已过期", "INVALID_GRANT")
  if (!row) throw invalid

  if (row.used === 1) throw invalid
  if (new Date(row.expires_at).getTime() < Date.now()) throw invalid
  if (row.client_id !== input.client.client_id) throw invalid
  // 兑换时的 redirect_uri 必须与签发时完全一致
  if (row.redirect_uri !== input.redirectUri) throw invalid

  // PKCE：签发时带了 challenge 就必须校验（NewAPI 不带，所以这段对它是跳过的）
  if (row.code_challenge) {
    if (!input.codeVerifier) throw invalid
    const ok = await verifyPkce(
      input.codeVerifier,
      row.code_challenge,
      row.code_challenge_method ?? ""
    )
    if (!ok) throw invalid
  }

  // 原子消费：并发下只有一个请求能把 used 从 0 改成 1
  const consumed = await env.DB.prepare(
    "UPDATE oauth_codes SET used = 1 WHERE code_hash = ? AND used = 0"
  )
    .bind(codeHash)
    .run()
  if ((consumed.meta?.changes ?? 0) === 0) throw invalid

  return { userId: row.user_id, scopes: row.scopes }
}

// ---- 访问令牌 ----

export async function issueAccessToken(
  env: Env,
  input: { clientId: string; userId: string; scopes: string }
): Promise<{ accessToken: string; expiresIn: number }> {
  const accessToken = generateToken()
  const now = new Date()
  await env.DB.prepare(
    `INSERT INTO oauth_tokens
       (id, token_hash, client_id, user_id, scopes, expires_at, created_at, revoked)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
  )
    .bind(
      uuid(),
      await hashToken(accessToken),
      input.clientId,
      input.userId,
      input.scopes,
      new Date(now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
      now.toISOString()
    )
    .run()
  return { accessToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS }
}

export async function verifyAccessToken(
  env: Env,
  token: string
): Promise<{ userId: string; clientId: string; scopes: string } | null> {
  if (!token) return null
  // ⚠️ 2026-09-25 审计（L14）：连表看应用的停用状态。
  // `updateClient` 现在会在停用时顺手作废令牌，但那只覆盖「本次之后」；
  // 历史上已经签发、且当时没被作废的令牌仍要在校验时兜住。
  // 停用一个应用应该是立即生效的，不能依赖签发时刻的状态。
  const row = await env.DB.prepare(
    `SELECT t.client_id, t.user_id, t.scopes, t.expires_at, t.revoked,
            COALESCE(c.disabled, 0) AS client_disabled
       FROM oauth_tokens t
       LEFT JOIN oauth_clients c ON c.client_id = t.client_id
      WHERE t.token_hash = ? LIMIT 1`
  )
    .bind(await hashToken(token))
    .first<{
      client_id: string
      user_id: string
      scopes: string
      expires_at: string
      revoked: number
      client_disabled: number
    }>()
  if (!row) return null
  if (row.revoked === 1) return null
  if (row.client_disabled === 1) return null
  if (new Date(row.expires_at).getTime() < Date.now()) return null
  return { userId: row.user_id, clientId: row.client_id, scopes: row.scopes }
}

/**
 * 作废某用户的**全部** OAuth 令牌（2026-09-25 审计 L14）。
 *
 * 用在「改密码」这类「假定账号已泄露、需要切断一切既有授权」的动作上。
 * 原先改密码只删 `sessions`，OAuth 令牌不受影响 —— 攻击者拿到的 access_token
 * 在改密码之后仍能继续调 `/userinfo`（最长 1 小时）。
 *
 * 注意**没有**接到「登出」上：登出是日常操作，把用户所有已授权的
 * 第三方集成一起打断是明显的功能回归，不是修复。
 * 用户主动「吊销全部授权」需要一个新路由（`index.ts` 目前由另一个 AI 占用），
 * 已记为待办。
 */
export async function revokeAllUserTokens(
  env: Env,
  userId: string
): Promise<number> {
  const res = await env.DB.prepare(
    "UPDATE oauth_tokens SET revoked = 1 WHERE user_id = ? AND revoked = 0"
  )
    .bind(userId)
    .run()
  return res.meta?.changes ?? 0
}

// ---- 授权记忆 ----

export async function hasGrant(
  env: Env,
  userId: string,
  clientId: string,
  scopes: string
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT scopes FROM oauth_grants WHERE user_id = ? AND client_id = ? LIMIT 1"
  )
    .bind(userId, clientId)
    .first<{ scopes: string }>()
  if (!row) return false
  // 只有「之前同意过的 scope 覆盖了这次请求的」才算已授权。
  // 应用新申请了更高权限时必须重新征求同意，绝不能沿用旧同意。
  const granted = new Set(row.scopes.split(/\s+/).filter(Boolean))
  return scopes.split(/\s+/).filter(Boolean).every((s) => granted.has(s))
}

export async function rememberGrant(
  env: Env,
  userId: string,
  clientId: string,
  scopes: string
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO oauth_grants (id, user_id, client_id, scopes, created_at)
          VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, client_id) DO UPDATE SET
          scopes = excluded.scopes,
          created_at = excluded.created_at`
  )
    .bind(uuid(), userId, clientId, scopes, new Date().toISOString())
    .run()
}

/** 撤销某用户对某应用的授权：清掉记忆并作废其令牌 */
export async function revokeGrant(
  env: Env,
  userId: string,
  clientId: string
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_grants WHERE user_id = ? AND client_id = ?").bind(
      userId,
      clientId
    ),
    env.DB.prepare(
      "UPDATE oauth_tokens SET revoked = 1 WHERE user_id = ? AND client_id = ?"
    ).bind(userId, clientId),
  ])
}

// ---- 用户信息 ----

export interface OidcUserInfo {
  sub: string
  email?: string
  name?: string
  preferred_username?: string
  picture?: string
  email_verified?: boolean
}

/**
 * 按 scope 组装 userinfo。
 *
 * ⚠️ `sub` 用 users.id，不用 username/email —— 对方会把它当永久标识存下来
 * （NewAPI 存成 oidc_id），一旦用户改名或换邮箱就会对不上。
 *
 * ⚠️ 这里**同时校验账号状态**：令牌本身在有效期内是「合法」的，
 * 但用户被停用后必须立刻失去访问权。放在这里而不是 verifyAccessToken，
 * 是因为本函数本来就要查一次 users 表，顺手判断不额外增加查询。
 * （若只在签发时校验，停用用户仍能拿旧令牌访问至多 1 小时。）
 */
export async function buildUserInfo(
  env: Env,
  userId: string,
  scopes: string,
  origin: string
): Promise<OidcUserInfo | null> {
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ? LIMIT 1")
    .bind(userId)
    .first<{
      id: string
      username: string
      email: string
      nickname: string | null
      avatar_key: string | null
      email_verified: number | null
      status: string
    }>()
  if (!user) return null
  if (user.status !== "active") return null

  const info: OidcUserInfo = { sub: user.id }
  const has = (s: string) => scopes.split(/\s+/).includes(s)

  if (has("email")) {
    info.email = user.email
    info.email_verified = user.email_verified === 1
  }
  if (has("profile")) {
    info.preferred_username = user.username
    info.name = user.nickname ?? user.username
    if (user.avatar_key) {
      info.picture = `${origin}/u/${encodeURIComponent(user.username)}/avatar`
    }
  }
  return info
}

// ---- OIDC 发现文档 ----

/**
 * `/.well-known/openid-configuration`。
 *
 * ⚠️ 这三个 endpoint 路径**不要改**：NewAPI 的「自动发现」功能有已知 bug，
 * 社区实践表明经常需要用户手动填这三个地址。路径一变，别人照教程填的就连不上。
 */
export function discoveryDocument(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    userinfo_endpoint: `${origin}/oauth/userinfo`,
    // 一期没有签名密钥，这里如实不提供 jwks_uri；
    // 二期上 RS256 后再补，别现在填一个会 404 的地址误导对方。
    scopes_supported: [...SUPPORTED_SCOPES],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: [],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    claims_supported: ["sub", "email", "email_verified", "name", "preferred_username", "picture"],
  }
}

// ---- 清理（供定时运维调用）----

/** 删除过期/已用的授权码与过期令牌，返回删除条数 */
export async function purgeExpiredOAuth(
  env: Env
): Promise<{ codes: number; tokens: number }> {
  const now = new Date().toISOString()
  const codes = await env.DB.prepare(
    "DELETE FROM oauth_codes WHERE expires_at < ? OR used = 1"
  )
    .bind(now)
    .run()
  const tokens = await env.DB.prepare("DELETE FROM oauth_tokens WHERE expires_at < ?")
    .bind(now)
    .run()
  return {
    codes: codes.meta?.changes ?? 0,
    tokens: tokens.meta?.changes ?? 0,
  }
}
