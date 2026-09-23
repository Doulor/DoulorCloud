/**
 * NewAPI（自建 AI 中转站）客户端。
 *
 * 所有凭据只存在于 Worker 端：管理员 Root token 与用户 access token
 * 都不下发到前端。用户明文密码只在开通流程中短暂使用，绝不落库。
 *
 * 关键约束（均已对 https://api.doulor.cn 实测确认）：
 *   1. `POST /api/token/` 不返回 key（连掩码都不返回），完整 key 只能通过
 *      `POST /api/token/:id/key` 取得 —— 建 Key 必须两步。
 *   2. email 只有 `POST /api/user/register` 能写入（管理员建号接口、
 *      /api/user/manage、PUT /api/user/self 都会丢弃 email）。因此开通流程是
 *      「管理员建号 → 自助注册补 email → 管理员叠加额度」。
 *   3. 所有 UserAuth 调用都必须带 `New-Api-User` 头，只有 session cookie 不够。
 *   4. 额度用 `POST /api/user/manage` 的 add_quota（mode: override = 绝对赋值）。
 */
import { ApiError } from "./http"
import { decryptSecret, encryptSecret } from "./crypto"
import type { Env } from "./env"

interface NewApiConfig {
  baseUrl: string
  /** 可能为 null（公开接口不需要它；需要鉴权的调用由 newApiFetch 拦截） */
  adminToken: string | null
  adminUserId: string
}

/**
 * 管理员凭据的来源：
 *   - `db`：管理面板写入的（优先）—— NewAPI 的「系统访问令牌」随时可能被后台
 *     轮换，改一次就得重跑 wrangler secret 太别扭，因此允许网页端直接更新
 *   - `env`：Worker Secret（NEWAPI_ADMIN_TOKEN / NEWAPI_ADMIN_USER_ID）
 *   - `none`：都没有
 */
export type AdminCredentialSource = "db" | "env" | "none"

const CREDENTIAL_CACHE_MS = 5000
let credentialCache: {
  at: number
  token: string | null
  userId: string
  source: AdminCredentialSource
} | null = null

/**
 * 解析管理员凭据：D1 单据优先，无则回落 env。
 *
 * 加一层 5 秒内存缓存：中转站一次页面加载会连调 getCurrencyInfo / checkHealth /
 * listPricing 等多个接口，每个都要凭据，不缓存会白白多读几次 D1 单行。
 * 更新凭据时主动失效本进程缓存；其他 isolate 最多晚 5 秒感知。
 */
async function resolveAdminCredentials(
  env: Env
): Promise<{ token: string | null; userId: string; source: AdminCredentialSource }> {
  const now = Date.now()
  if (credentialCache && now - credentialCache.at < CREDENTIAL_CACHE_MS) {
    return credentialCache
  }

  let token: string | null = env.NEWAPI_ADMIN_TOKEN ?? null
  let userId = env.NEWAPI_ADMIN_USER_ID ?? "1"
  let source: AdminCredentialSource = token ? "env" : "none"

  // 库里的凭据用 SESSION_SECRET 派生的密钥加密；缺密钥则只能用 env
  if (env.SESSION_SECRET) {
    try {
      const row = await env.DB.prepare(
        "SELECT enc_token, admin_user_id FROM newapi_admin_credentials WHERE id = 1"
      ).first<{ enc_token: string; admin_user_id: string }>()
      if (row) {
        token = await decryptSecret(row.enc_token, env.SESSION_SECRET)
        userId = row.admin_user_id || "1"
        source = "db"
      }
    } catch (err) {
      // 解密失败（如 SESSION_SECRET 换过）不应让全站 AI 功能挂掉，回落到 env
      console.error("读取中转站管理员凭据失败，回落到环境变量:", err)
    }
  }

  credentialCache = { at: now, token, userId, source }
  return credentialCache
}

async function config(env: Env): Promise<NewApiConfig> {
  const baseUrl = env.NEWAPI_BASE_URL
  if (!baseUrl) {
    throw new ApiError(
      503,
      "AI 中转站未配置（缺少 NEWAPI_BASE_URL）",
      "NEWAPI_NOT_CONFIGURED"
    )
  }
  const { token, userId } = await resolveAdminCredentials(env)
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    adminToken: token,
    adminUserId: userId,
  }
}

/** 站点地址与管理员令牌是否都已具备（决定 AI 功能可用性） */
export async function isNewApiConfigured(env: Env): Promise<boolean> {
  if (!env.NEWAPI_BASE_URL) return false
  return Boolean((await resolveAdminCredentials(env)).token)
}


/** NewAPI 的响应信封：{ success, message, data } */
interface Envelope<T> {
  success?: boolean
  message?: string
  data?: T
}

async function newApiFetch(
  env: Env,
  path: string,
  init: RequestInit & { auth?: "admin" | "none" } = {}
): Promise<Response> {
  const cfg = await config(env)
  const headers = new Headers(init.headers)
  headers.set("Content-Type", "application/json")

  if (init.auth !== "none") {
    if (!cfg.adminToken) {
      throw new ApiError(
        503,
        "AI 中转站未配置管理员令牌",
        "NEWAPI_NOT_CONFIGURED"
      )
    }
    headers.set("Authorization", `Bearer ${cfg.adminToken}`)
    headers.set("New-Api-User", cfg.adminUserId)
  }

  const res = await fetch(`${cfg.baseUrl}${path}`, { ...init, headers })
  return res
}

/** 解析信封，失败时抛出带 NewAPI 原始 message 的错误 */
async function unwrap<T>(
  res: Response,
  what: string,
  tolerate?: (message: string) => boolean
): Promise<T> {
  const text = await res.text()
  let body: Envelope<T> | null = null
  try {
    body = JSON.parse(text) as Envelope<T>
  } catch {
    body = null
  }

  const message = body?.message ?? ""
  if (!res.ok || !body || body.success === false) {
    if (tolerate && tolerate(message)) {
      return (body?.data ?? ({} as T)) as T
    }
    // 401 / 令牌无效：给专属 code，便于前端与管理员定位是令牌问题
    // （可能是管理员令牌 NEWAPI_ADMIN_TOKEN 失效，或用户 access token 失效，
    //   由调用方的 what 上下文区分）
    if (
      res.status === 401 ||
      /invalid access token|unauthorized/i.test(message)
    ) {
      throw new ApiError(
        502,
        `NewAPI ${what}失败：令牌无效或已过期（${message || "Unauthorized"}）。若是管理员操作，请在管理面板「中转站」标签用 root 账户的新访问令牌更新（NewAPI 后台「个人设置 → 安全设置 → 系统访问令牌」可生成/重置）`,
        "NEWAPI_TOKEN_INVALID"
      )
    }
    throw new ApiError(
      502,
      `NewAPI ${what}失败: ${message || `HTTP ${res.status}`}`,
      "NEWAPI_ERROR"
    )
  }
  return (body.data ?? ({} as T)) as T
}

// ---- 管理员操作（使用 Root token）----

/** 按用户名查找 NewAPI 用户（管理员接口） */
export async function findUserByUsername(
  env: Env,
  username: string
): Promise<NewApiUser | null> {
  const res = await newApiFetch(
    env,
    "/api/user/search?keyword=" + encodeURIComponent(username),
    { method: "GET" }
  )
  const data = await unwrap<NewApiUser[] | { items?: NewApiUser[] }>(
    res,
    "查询账号"
  )
  const list = Array.isArray(data) ? data : (data.items ?? [])
  return (
    list.find((u) => u.username?.toLowerCase() === username.toLowerCase()) ??
    null
  )
}

export interface NewApiUser {
  id: number
  username: string
  display_name?: string
  email?: string
  quota?: number
  used_quota?: number
  request_count?: number
  group?: string
  role?: number
  status?: number
}

/** 调整额度：mode=override 为绝对赋值，add / subtract 为增减 */
export async function adminSetQuota(
  env: Env,
  userId: number,
  value: number,
  mode: "override" | "add" | "subtract" = "override"
): Promise<void> {
  const res = await newApiFetch(env, "/api/user/manage", {
    method: "POST",
    body: JSON.stringify({
      id: userId,
      action: "add_quota",
      value,
      mode,
    }),
  })
  await unwrap(res, "设置额度")
}

// ---- 用户自助注册（公开路由）----

/**
 * 读取 NewAPI 的展示币种（无需鉴权）。
 *
 * NewAPI 控制台按 quota_display_type 决定显示 ¥ 还是 $，本站必须跟随，
 * 否则同一个额度在两边显示成不同货币（本实例为 CNY，即 500000 quota = ¥1）。
 * 读取失败时回退为 USD，不影响主流程。
 */
export async function getCurrencyInfo(
  env: Env
): Promise<{ symbol: string; code: string; perUnit: number }> {
  try {
    const res = await newApiFetch(env, "/api/status", {
      method: "GET",
      auth: "none",
    })
    const data = await unwrap<Record<string, unknown>>(res, "读取站点信息")
    const code = String(data.quota_display_type ?? "USD").toUpperCase()
    const symbol = code === "CNY" ? "¥" : "$"
    const perUnit = Number(data.quota_per_unit) || 500000
    return { symbol, code, perUnit }
  } catch (err) {
    console.error("读取 NewAPI 币种失败，回退 USD:", err)
    return { symbol: "$", code: "USD", perUnit: 500000 }
  }
}

export interface NewApiHealth {
  online: boolean
  /** 探测耗时（毫秒）；离线时为 -1 */
  latencyMs: number
  /** 站点版本号（在线时从 /api/status 读取） */
  version: string | null
}

/**
 * 中转站健康检查：调公开的 /api/status 测连通性与延迟。
 * 不抛错——离线也返回 { online:false }，供前端显示「在线/离线」徽章。
 */
export async function checkHealth(env: Env): Promise<NewApiHealth> {
  if (!(await isNewApiConfigured(env))) {
    return { online: false, latencyMs: -1, version: null }
  }
  const startedAt = Date.now()
  try {
    const res = await newApiFetch(env, "/api/status", {
      method: "GET",
      auth: "none",
    })
    const data = await unwrap<Record<string, unknown>>(res, "健康检查")
    return {
      online: true,
      latencyMs: Date.now() - startedAt,
      version: data?.version ? String(data.version) : null,
    }
  } catch {
    return { online: false, latencyMs: -1, version: null }
  }
}

/**
 * 请求发送邮箱验证码（无需鉴权）。
 * 验证码由 NewAPI 服务端生成并邮件发送到本站域名邮箱，本站随后从收件箱读取。
 */
export async function requestEmailCode(env: Env, email: string): Promise<void> {
  const res = await newApiFetch(
    env,
    `/api/verification?email=${encodeURIComponent(email)}`,
    { method: "GET", auth: "none" }
  )
  await unwrap(res, "发送验证码")
}

/**
 * 自助注册：**这是唯一能把 email 写入 NewAPI 的途径**
 * （管理员建号接口、/api/user/manage、PUT /api/user/self 都会丢弃 email）。
 *
 * 两个关键行为（均实测确认）：
 *   - 用户名已存在时返回「Username already exists or has been deleted」，
 *     也就是说**不能**先建号再补邮箱，必须在账号不存在时直接注册。
 *   - 该接口需要邮箱验证码（本站邮箱的收件箱能收到）。
 */
export async function registerUser(
  env: Env,
  username: string,
  password: string,
  email: string,
  verificationCode: string
): Promise<void> {
  const res = await newApiFetch(env, "/api/user/register", {
    method: "POST",
    body: JSON.stringify({
      username,
      password,
      email,
      verification_code: verificationCode,
    }),
    auth: "none",
  })
  await unwrap(res, "注册账号")
}

// ---- 用户级操作 ----

export interface LoginResult {
  userId: number
  session: string | null
  username?: string
}

/**
 * 用户登录，返回 user id 与会话 cookie。
 * 会话 cookie 用于随后调用 /api/user/token 换取长期 access token
 * （该接口需要 UserAuth + session，Bearer 无法替代）。
 */
export async function login(
  env: Env,
  username: string,
  password: string
): Promise<LoginResult> {
  const res = await newApiFetch(env, "/api/user/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
    auth: "none",
  })
  const data = await unwrap<{ id: number; username?: string }>(res, "登录")

  // 从 Set-Cookie 中取出 session（Worker 环境无自动 cookie jar）
  const setCookie = res.headers.get("Set-Cookie") ?? ""
  const match = /(?:^|,\s*)session=([^;]+)/.exec(setCookie)
  const session = match ? `session=${match[1]}` : null

  if (!data?.id) {
    throw new ApiError(502, "NewAPI 登录未返回用户 ID", "NEWAPI_ERROR")
  }
  return { userId: data.id, session, username: data.username }
}

/** 生成/获取用户的长期 access token */
export async function generateAccessToken(
  env: Env,
  session: string,
  userId: number
): Promise<string> {
  const res = await newApiFetch(env, "/api/user/token", {
    method: "GET",
    headers: { Cookie: session, "New-Api-User": String(userId) },
    auth: "none",
  })
  const data = await unwrap<string | { token?: string }>(res, "生成访问令牌")
  const token = typeof data === "string" ? data : data?.token
  if (!token) {
    throw new ApiError(502, "NewAPI 未返回访问令牌", "NEWAPI_ERROR")
  }
  return token
}

/** 以用户身份调用（使用解密后的 access token） */
async function asUser(
  env: Env,
  accessToken: string,
  userId: number,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const cfg = await config(env)
  const headers = new Headers(init.headers)
  headers.set("Content-Type", "application/json")
  headers.set("Authorization", `Bearer ${accessToken}`)
  headers.set("New-Api-User", String(userId))
  return fetch(`${cfg.baseUrl}${path}`, { ...init, headers })
}

/** 读取用户自身信息（额度 / 用量） */
export async function getUserSelf(
  env: Env,
  accessToken: string,
  userId: number
): Promise<NewApiUser> {
  const res = await asUser(env, accessToken, userId, "/api/user/self", {
    method: "GET",
  })
  return unwrap<NewApiUser>(res, "读取账号信息")
}

/** 可用模型列表（用户视角，返回字符串数组） */
export async function listModels(
  env: Env,
  accessToken: string,
  userId: number
): Promise<string[]> {
  const res = await asUser(env, accessToken, userId, "/api/user/models", {
    method: "GET",
  })
  const data = await unwrap<string[]>(res, "获取模型列表")
  return Array.isArray(data) ? data : []
}

export interface UserToken {
  id: number
  name: string
  key: string
  created_time: number
  accessed_time: number
  expired_time: number
  remain_quota: number
  unlimited_quota: boolean
  model_limits: string
  model_limits_enabled: boolean
  group: string
  used_quota: number
}

/** 用户已有 API Key 列表（key 为掩码形式） */
export async function listTokens(
  env: Env,
  accessToken: string,
  userId: number
): Promise<UserToken[]> {
  const res = await asUser(
    env,
    accessToken,
    userId,
    "/api/token/?p=1&page_size=100",
    { method: "GET" }
  )
  const data = await unwrap<{ items?: UserToken[] }>(res, "获取 Key 列表")
  return data.items ?? []
}

/**
 * 新建 API Key 并返回完整 key。
 *
 * 两步走是必须的：AddToken 只返回 {"success":true}，完整 key 只能通过
 * `/api/token/:id/key` 取得。新建的 token id 取列表中最大的 id
 * （列表按 id 倒序，用 created_time 兜底）。
 */
export async function createApiKey(
  env: Env,
  accessToken: string,
  userId: number,
  name: string,
  group = ""
): Promise<{ tokenId: number; fullKey: string; maskedKey: string }> {
  const before = await listTokens(env, accessToken, userId)
  const existingIds = new Set(before.map((t) => t.id))

  const createRes = await asUser(env, accessToken, userId, "/api/token/", {
    method: "POST",
    body: JSON.stringify({
      name: name.slice(0, 50),
      remain_quota: 0,
      unlimited_quota: true, // 额度由账户级 quota 控制
      expired_time: -1, // 永不过期
      model_limits_enabled: false,
      model_limits: "",
      allow_ips: "",
      // 分组决定该 Key 能用哪些渠道（可用分组来自 /api/pricing 的 enable_groups）
      group: group || "",
      cross_group_retry: false,
    }),
  })
  await unwrap(createRes, "创建 Key")

  // 找出新建的 token（新出现的 id）
  const after = await listTokens(env, accessToken, userId)
  const created =
    after.find((t) => !existingIds.has(t.id)) ??
    after.sort((a, b) => b.id - a.id)[0]

  if (!created) {
    throw new ApiError(502, "创建 Key 后未能定位到该 Key", "NEWAPI_ERROR")
  }

  const keyRes = await asUser(
    env,
    accessToken,
    userId,
    `/api/token/${created.id}/key`,
    { method: "POST" }
  )
  const keyData = await unwrap<{ key?: string }>(keyRes, "读取完整 Key")
  if (!keyData?.key) {
    throw new ApiError(502, "NewAPI 未返回完整 Key", "NEWAPI_ERROR")
  }

  return {
    tokenId: created.id,
    fullKey: keyData.key,
    maskedKey: created.key,
  }
}

/** 删除某个 API Key */
export async function deleteApiKey(
  env: Env,
  accessToken: string,
  userId: number,
  tokenId: number
): Promise<void> {
  const res = await asUser(
    env,
    accessToken,
    userId,
    `/api/token/${tokenId}`,
    { method: "DELETE" }
  )
  await unwrap(res, "删除 Key")
}

/**
 * 从 NewAPI 验证码邮件正文中提取验证码。
 * 实际邮件形如：「您的验证码为: 56608a」，10 分钟内有效。
 */
export function extractVerificationCode(text: string): string | null {
  const patterns = [
    /验证码为[:：]\s*([A-Za-z0-9]{4,12})/,
    /verification code is[:\s]+([A-Za-z0-9]{4,12})/i,
    /(?:code|验证码)[^\w]{0,10}([A-Za-z0-9]{6})/i,
  ]
  for (const re of patterns) {
    const m = re.exec(text)
    if (m) return m[1]
  }
  return null
}

/**
 * 修改 NewAPI 密码（用户自助）。
 *
 * 源码（rc.15 UpdateSelf）要点：
 *   - 需同时传 `password`（新）与 `original_password`（旧，用于校验）
 *   - `currentUser.Password != ""` 时才校验原密码；且 cleanUser 只落
 *     Id/Username/Password/DisplayName，其它字段不会被动到
 */
export async function changePassword(
  env: Env,
  accessToken: string,
  userId: number,
  username: string,
  originalPassword: string,
  newPassword: string
): Promise<void> {
  const res = await asUser(env, accessToken, userId, "/api/user/self", {
    method: "PUT",
    body: JSON.stringify({
      username,
      password: newPassword,
      original_password: originalPassword,
    }),
  })
  await unwrap(res, "修改密码", (msg) => /原密码错误/.test(msg))
}

/**
 * 用兑换码（邀请码）充值额度。
 * 源码（rc.15 TopUp）：请求体字段名为 `key`，成功时 `data` 为增加的额度数值。
 */
export async function redeemCode(
  env: Env,
  accessToken: string,
  userId: number,
  code: string
): Promise<{ added: number; message: string }> {
  const res = await asUser(env, accessToken, userId, "/api/user/topup", {
    method: "POST",
    body: JSON.stringify({ key: code.trim() }),
  })
  interface RedeemEnvelope {
    success?: boolean
    message?: string
    data?: number
  }
  const text = await res.text()
  let body: RedeemEnvelope | null = null
  try {
    body = JSON.parse(text) as RedeemEnvelope
  } catch {
    body = null
  }
  if (!body || body.success === false) {
    // 兑换码无效/已用过等属于用户输入问题，直接回传 NewAPI 的说明
    throw new ApiError(
      400,
      body?.message || `兑换失败（HTTP ${res.status}）`,
      "REDEEM_FAILED"
    )
  }
  return { added: Number(body.data ?? 0), message: body.message ?? "" }
}

/**
 * 读取模型 → 可用分组映射（公开接口，无需鉴权）。
 *
 * `/api/pricing` 返回每个模型的 `enable_groups`，据此可以把「默认分组」与
 * 「付费分组」的可用模型分开列出。失败时返回空数组，不影响主流程。
 */
export async function listPricing(
  env: Env
): Promise<{ model: string; groups: string[] }[]> {
  try {
    const res = await newApiFetch(env, "/api/pricing", {
      method: "GET",
      auth: "none",
    })
    const data = await unwrap<
      { model_name?: string; enable_groups?: string[] }[]
    >(res, "读取模型分组")
    if (!Array.isArray(data)) return []
    return data
      .filter((m) => m?.model_name)
      .map((m) => ({
        model: m.model_name as string,
        groups: Array.isArray(m.enable_groups) ? m.enable_groups : [],
      }))
  } catch (err) {
    console.error("读取模型分组失败:", err)
    return []
  }
}

// ---- 管理员凭据（管理面板可在线更新）----

/** 清除进程内凭据缓存；写入新凭据后必须调用，否则后续调用仍用旧值 */
function invalidateAdminCredentialCache(): void {
  credentialCache = null
}

/**
 * 强制下次重新解析凭据。写入路径已自动调用；导出仅供测试与运维脚本
 * 在直接改库后让本进程立即感知（其他 isolate 最多等 CREDENTIAL_CACHE_MS）。
 */
export function resetAdminCredentialCache(): void {
  invalidateAdminCredentialCache()
}

/** 掩码展示：<前4>****<后4>，不足以掩码时全星号 */
export function maskToken(token: string): string {
  if (token.length <= 8) return "*".repeat(Math.max(token.length, 4))
  return `${token.slice(0, 4)}${"*".repeat(8)}${token.slice(-4)}`
}

export interface AdminCredentialInfo {
  source: AdminCredentialSource
  /** 掩码后的令牌；未配置时为 null。明文绝不下发 */
  maskedToken: string | null
  adminUserId: string
  /** 库内凭据的更新时间（source=db 时才有） */
  updatedAt: string | null
}

/** 读取当前生效的管理员凭据信息（不含明文） */
export async function getAdminCredentialInfo(
  env: Env
): Promise<AdminCredentialInfo> {
  const { token, userId, source } = await resolveAdminCredentials(env)
  let updatedAt: string | null = null
  if (source === "db") {
    try {
      const row = await env.DB.prepare(
        "SELECT updated_at FROM newapi_admin_credentials WHERE id = 1"
      ).first<{ updated_at: string }>()
      updatedAt = row?.updated_at ?? null
    } catch {
      updatedAt = null
    }
  }
  return {
    source,
    maskedToken: token ? maskToken(token) : null,
    adminUserId: userId,
    updatedAt,
  }
}

/**
 * 更新管理员凭据（写 D1，加密存储），并立即使缓存失效。
 * 写入前不校验令牌有效性 —— 由调用方（admin 端点）先做一次真实调用来验证，
 * 此处只负责落库，避免「验证逻辑」与「存储逻辑」纠缠。
 */
export async function saveAdminCredential(
  env: Env,
  token: string,
  adminUserId: string
): Promise<void> {
  if (!env.SESSION_SECRET) {
    throw new ApiError(
      503,
      "未配置 SESSION_SECRET，无法安全保存管理员凭据",
      "NOT_CONFIGURED"
    )
  }
  await env.DB.prepare(
    `INSERT INTO newapi_admin_credentials (id, enc_token, admin_user_id, updated_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       enc_token = excluded.enc_token,
       admin_user_id = excluded.admin_user_id,
       updated_at = excluded.updated_at`
  )
    .bind(
      await encryptSecret(token, env.SESSION_SECRET),
      adminUserId,
      new Date().toISOString()
    )
    .run()
  invalidateAdminCredentialCache()
}

/**
 * 用给定的令牌做一次管理员级调用，验证其有效性（不落库）。
 * 调 `/api/user/search`（ADMIN 权限）+ `New-Api-User` 头，与真实业务同一鉴权路径。
 */
export async function verifyAdminCredential(
  env: Env,
  token: string,
  adminUserId: string
): Promise<{ ok: boolean; message: string }> {
  const baseUrl = env.NEWAPI_BASE_URL
  if (!baseUrl) {
    return { ok: false, message: "未配置 NEWAPI_BASE_URL" }
  }
  try {
    const res = await fetch(
      `${baseUrl.replace(/\/+$/, "")}/api/user/search?keyword=${encodeURIComponent("doulor")}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "New-Api-User": adminUserId,
        },
      }
    )
    const text = await res.text()
    let body: { success?: boolean; message?: string } | null = null
    try {
      body = JSON.parse(text) as { success?: boolean; message?: string }
    } catch {
      body = null
    }
    if (body?.success) return { ok: true, message: "令牌有效" }
    return {
      ok: false,
      message: body?.message || `HTTP ${res.status}：${text.slice(0, 200)}`,
    }
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    }
  }
}