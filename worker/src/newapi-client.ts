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
import { fetchWithTimeout } from "./async-utils"
import type { Env } from "./env"

/**
 * NewAPI 调用超时（2026-09-25 审计 H15）。
 * 20 秒：比 CF 管理 API 宽松 —— 有些 NewAPI 部署在慢速机器上，
 * 但绝不该无限等待把 Worker 请求挂死。
 */
const NEWAPI_TIMEOUT_MS = 20_000

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

  // 带超时（2026-09-25 审计 H15）：中转站卡住时不能把 Worker 请求一起挂死。
  // 20 秒比 CF 管理 API 宽松 —— 有些 NewAPI 部署在慢速机器上。
  const res = await fetchWithTimeout(`${cfg.baseUrl}${path}`, { ...init, headers }, NEWAPI_TIMEOUT_MS)
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
    // 429：NewAPI 的限流中间件（CriticalRateLimit 等）返回的是**空响应体**
    // （实测 `HTTP/1.1 429` + `Retry-After: 1200` + `Content-Length: 0`）。
    // 空 body 解析不出 message，就会退化成下面那句 `HTTP 429` ——
    // 用户只看到一句 "NewAPI 登录失败: HTTP 429"，既不知道发生了什么、
    // 也不知道该不该重试。这里单独识别，给人话 + 明确的等待时长。
    // ⚠️ 这条分支的存在也说明：**不能用「上游状态码被包成 502」来断定
    //    「429 不可能来自 NewAPI」** —— 文案里的 `HTTP 429` 就是它。
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After") ?? "0")
      const wait =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? `（约 ${Math.ceil(retryAfter / 60)} 分钟后可重试）`
          : ""
      throw new ApiError(
        429,
        `中转站服务端限流：${what}请求过于频繁${wait}。这不是你的账号问题，稍后再试即可`,
        "NEWAPI_RATE_LIMITED"
      )
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
  const match = list.find(
    (u) => u.username?.toLowerCase() === username.toLowerCase()
  )
  if (!match) return null
  // 已注销（软删除）的账号视为「不存在」：继续绑定会因账号被删而报 record not found，
  // 应引导用户去中转站重新用 OIDC 登录建号。
  if (match.DeletedAt) return null
  return match
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
  /** OIDC 绑定标识（= Doulor Cloud 的 users.id，即我方 OAuth 的 sub） */
  oidc_id?: string
  /** 软删除时间（非空 = 已注销）。绑定流程必须排除，否则 adminSetUserPassword 会 record not found */
  DeletedAt?: string | null
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

/**
 * 管理员启用 / 禁用用户（`POST /api/user/manage` 的 enable / disable）。
 *
 * ⚠️ disable 不仅禁止登录，还会**清掉该用户所有 token 的缓存**，使其
 * 已创建的 API Key 立即失效 —— 这正是「cloud 收回权限 → 中转站 key 失效」
 * 所依赖的机制。
 * 根用户（root）不能被禁用，会返回错误；调用者角色需高于目标用户。
 */
export async function adminSetUserStatus(
  env: Env,
  userId: number,
  action: "enable" | "disable"
): Promise<void> {
  const res = await newApiFetch(env, "/api/user/manage", {
    method: "POST",
    body: JSON.stringify({ id: userId, action }),
  })
  await unwrap(res, action === "enable" ? "启用账号" : "禁用账号")
}

/**
 * 管理员给指定用户设置/重置密码（`PUT /api/user`）。
 *
 * ⚠️ 明文密码只在这里短暂出现，用于「OIDC 开通后给账号补一个密码」，
 * 从而让本站能用「用户名 + 密码」登录换取 access token（代用户建 Key 依赖它）。
 * NewAPI 的 UpdateUser 接口只要 `id` + `password`，明文传入、由它自己哈希；
 * 不需要旧密码，也不校验 role 变更（我们这里不碰 role）。
 */
export async function adminSetUserPassword(
  env: Env,
  userId: number,
  username: string,
  password: string
): Promise<void> {
  const res = await newApiFetch(env, "/api/user", {
    method: "PUT",
    body: JSON.stringify({
      id: userId,
      username,
      password,
    }),
  })
  await unwrap(res, "设置账号密码")
}

/**
 * 管理员把用户转到指定分组（`PUT /api/user`）。
 *
 * NewAPI 的 UpdateUser 接口要求 `id` + `username`（用户名非空），
 * 分组字段 `group` 会随 `EditWithTx` 的 map 更新一并落库（实测可用）。
 * 用于「完成 cloud↔NewAPI 绑定后，把用户转进 0 倍率免费组」，
 * 使「绑定」成为通往免费的唯一闸门（未绑定者留在 default 组、按倍率烧额度）。
 */
export async function adminSetUserGroup(
  env: Env,
  userId: number,
  username: string,
  group: string
): Promise<void> {
  const res = await newApiFetch(env, "/api/user", {
    method: "PUT",
    body: JSON.stringify({
      id: userId,
      username,
      group,
    }),
  })
  await unwrap(res, "设置账号分组")
}

// ---- 用户自助注册（公开路由）----

/**
 * 非用户相关的 NewAPI 读取结果缓存（module 级，isolate 内共享）。
 *
 * ⚠️ 2026-10-01 性能：`/api/dev/status`（AI 中转站页首屏）原先每次都串行打
 * 5 次 NewAPI（币种 / 健康 / 定价 / 模型 / 订阅），每次都是「Worker → CF →
 * 隧道 → VPS1」一趟往返，实测一次加载要 3.8 秒。币种、健康、定价这三项
 * **与用户无关**，价格/币种几乎不变、健康徽章也不需要秒级新鲜 ⇒ 加短 TTL。
 * 模型列表与订阅是用户维度的，不在此缓存。
 */
const newapiGlobalCache = new Map<string, { at: number; value: unknown }>()

function cacheTake<T>(key: string, ttlMs: number): T | undefined {
  const hit = newapiGlobalCache.get(key)
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T
  return undefined
}

function cachePut(key: string, value: unknown): void {
  newapiGlobalCache.set(key, { at: Date.now(), value })
}

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
  const cached = cacheTake<{ symbol: string; code: string; perUnit: number }>(
    "currency",
    60_000
  )
  if (cached) return cached
  try {
    const res = await newApiFetch(env, "/api/status", {
      method: "GET",
      auth: "none",
    })
    const data = await unwrap<Record<string, unknown>>(res, "读取站点信息")
    const code = String(data.quota_display_type ?? "USD").toUpperCase()
    const symbol = code === "CNY" ? "¥" : "$"
    const perUnit = Number(data.quota_per_unit) || 500000
    const value = { symbol, code, perUnit }
    cachePut("currency", value)
    return value
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
 *
 * 必须带超时：这个探测是「AI 中转站」页面每次加载都要等的，
 * 而它没有任何兜底——地址被防火墙黑洞（连不上也断不开）时会一直挂着，
 * 页面就一直转圈。5 秒拿不到结果直接当离线，比挂死强。
 */
export async function checkHealth(env: Env): Promise<NewApiHealth> {
  // 成功缓存 30 秒（徽章不需要秒级新鲜）；失败只缓存 10 秒，尽快恢复
  const cached = cacheTake<NewApiHealth>("health", 30_000)
  if (cached) return cached
  if (!(await isNewApiConfigured(env))) {
    return { online: false, latencyMs: -1, version: null }
  }
  const startedAt = Date.now()
  try {
    const res = await newApiFetch(env, "/api/status", {
      method: "GET",
      auth: "none",
      signal: AbortSignal.timeout(5000),
    })
    const data = await unwrap<Record<string, unknown>>(res, "健康检查")
    const value: NewApiHealth = {
      online: true,
      latencyMs: Date.now() - startedAt,
      version: data?.version ? String(data.version) : null,
    }
    cachePut("health", value)
    return value
  } catch {
    // 失败结果只缓存 10 秒（成功 30 秒）：既不连续重试打爆上游，又能较快恢复。
    // 写法：把时间戳往前拨 20 秒 ⇒ 离 30 秒的 TTL 只剩 10 秒。
    newapiGlobalCache.set("health", {
      at: Date.now() - 20_000,
      value: { online: false, latencyMs: -1, version: null },
    })
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
  accessToken: string
  username?: string
}

/**
 * 用户登录，返回 user id 与访问令牌。
 *
 * ⚠️ NewAPI rc.40 起登录响应**直接返回 access_token**（不再需要「session cookie
 * → /api/user/token」两步换令牌），用户信息也从 data 顶层移到了 data.user。
 * 这里兼容新旧两种结构，并直接取登录返回的 access_token。
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
  const data = await unwrap<{
    id?: number
    username?: string
    access_token?: string
    user?: { id: number; username?: string }
  }>(res, "登录")

  // 兼容新旧两种响应结构
  const userId = data.user?.id ?? data.id
  const remoteUsername = data.user?.username ?? data.username
  const accessToken = data.access_token ?? ""

  if (!userId) {
    throw new ApiError(502, "NewAPI 登录未返回用户 ID", "NEWAPI_ERROR")
  }
  if (!accessToken) {
    throw new ApiError(502, "NewAPI 登录未返回访问令牌", "NEWAPI_ERROR")
  }
  return { userId, accessToken, username: remoteUsername }
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
  // 定价（模型→分组）变化很慢，缓存 2 分钟：AI 页首屏每次加载都调它
  const cached = cacheTake<{ model: string; groups: string[] }[]>("pricing", 120_000)
  if (cached) return cached
  try {
    // 用管理员凭据访问（默认 auth=admin）：NewAPI 的「定价页」若被管理员设为
    // requireAuth=true，公开访问会 401，导致 availableGroups 为空、前端下拉看不到模型。
    const res = await newApiFetch(env, "/api/pricing", {
      method: "GET",
    })
    const data = await unwrap<
      { model_name?: string; enable_groups?: string[] }[]
    >(res, "读取模型分组")
    if (!Array.isArray(data)) return []
    const value = data
      .filter((m) => m?.model_name)
      .map((m) => ({
        model: m.model_name as string,
        groups: Array.isArray(m.enable_groups) ? m.enable_groups : [],
      }))
    cachePut("pricing", value)
    return value
  } catch (err) {
    console.error("读取模型分组失败:", err)
    return []
  }
}

// ---- 渠道管理（管理员接口，用于「AI 渠道捐献」自动化）----
//
// 口径已对 NewAPI v1.0.0-rc.40 源码核对（controller/channel.go + router/channel-router.go）：
//   - 新建：`POST /api/channel/`，body `{ mode:"single", channel:{...} }`
//   - 列表：`GET /api/channel/`，返回 `{ items, total, page, page_size, type_counts }`
//   - 测试：`GET /api/channel/test/:id`，**始终 200**，靠 body 的 success 判定
//   - 删除：`DELETE /api/channel/:id`
//   - 新增只需 `key` 非空 + 模型名 ≤255 字符（validateChannel 的 isAdd 分支）
//
// ⚠️ `model_mapping` 的方向（relay/helper/model_mapped.go 实证）：
//     键 = 客户端请求的模型名，值 = 实际发给上游的模型名。
//     所以「给捐献模型加前缀」要写成 `{"donation-x": "x"}`。

/** 渠道状态常量（common/constants.go） */
export const CHANNEL_STATUS_ENABLED = 1
export const CHANNEL_STATUS_MANUALLY_DISABLED = 2

/**
 * 渠道的多密钥元信息（对应 NewAPI 的 `channel_info` JSON 列）。
 *
 * 只有「多密钥渠道」才有意义：`is_multi_key` 为 true 时，`key` 字段里是
 * 换行分隔的多把 Key，NewAPI 按轮询/随机挑一把用，某把坏了会单独跳过。
 */
export interface NewApiChannelInfo {
  is_multi_key?: boolean
  multi_key_size?: number
}

export interface NewApiChannel {
  id: number
  name: string
  type: number
  status: number
  /** 逗号分隔的模型名 */
  models: string
  group: string
  base_url?: string | null
  /** 多密钥信息；普通渠道为 undefined 或 is_multi_key:false */
  channel_info?: NewApiChannelInfo
}

/**
 * NewAPI 渠道列表的单页上限 —— **服务端硬性封顶 100**，请求里写 `page_size=1000`
 * 也只给你 100 条，多的直接丢掉（v1.0.0-rc.40 `common/page_info.go`：
 * `if pageInfo.PageSize > 100 { pageInfo.PageSize = 100 }`）。
 */
const CHANNEL_PAGE_SIZE = 100

/**
 * 翻页兜底上限。正常渠道总量远小于此；存在的意义只是防「上游 total 异常」
 * 把循环变成死循环（每页都是满的 100 条、total 又永远比已读条数大）。
 */
const CHANNEL_MAX_PAGES = 50

/**
 * 读取渠道列表（管理员）。**会翻页取全量。**
 *
 * 只取自动化要用的字段。NewAPI 会 `Omit("key")`，所以这里拿不到密钥，
 * 也不需要 —— 密钥在创建时由我方提供。
 *
 * ⚠️ 页码参数名是 **`p`**，不是 `page`（`common/page_info.go` 读的是 `c.Query("p")`）。
 *    写 `page=2` 会被静默忽略、永远返回第 1 页 —— 排查这种问题别只看「返回里
 *    page 字段是几」，那只是上游把你传的值/默认值回显而已。
 *
 * 2026-09-30 事故：本站渠道数涨到 140+ 之后，这里只发一次
 * `/api/channel/?page_size=1000`，实际只拿到第 1 页的 100 条（id 范围 9~192，
 * 一条不满 100 的页里混着各种区间），而 **#17 这个商汤渠道恰好落在第 2 页**。
 * 于是 `sensenova.ts` 的「渠道不存在」分支被误触发，所有商汤 Key 捐献
 * 全部转人工复核、且状态停在 `pending`（详见 `getChannel` 的注释）。
 */
/**
 * 拉取消费日志（管理端 `/api/log/`），用于风险账户扫描。
 *
 * ⚠️ 分页参数是 **`p`**（不是 `page`），且 `page_size` 服务端硬封顶 100
 * （与渠道列表同一个坑，见 listChannels 的注释）。
 * 时间戳是**秒**，`type=2` = 消费日志。
 *
 * 返回 `{ items, total }`：total 用于判断「还有没有下一页」，
 * 上游只给数组（老版本）时用本页条数兜底。
 */
export interface NewApiLogItem {
  id?: number
  user_id?: number
  created_at?: number
  username?: string
  model_name?: string
  quota?: number
  is_stream?: boolean
}

export async function listLogs(
  env: Env,
  opts: { startTimestamp: number; endTimestamp: number; page: number; pageSize?: number }
): Promise<{ items: NewApiLogItem[]; total: number }> {
  const pageSize = Math.min(opts.pageSize ?? 100, 100)
  const qs =
    `p=${opts.page}&page_size=${pageSize}&type=2` +
    `&start_timestamp=${opts.startTimestamp}&end_timestamp=${opts.endTimestamp}`
  const res = await newApiFetch(env, `/api/log/?${qs}`, { method: "GET" })
  const data = await unwrap<NewApiLogItem[] | { items?: NewApiLogItem[]; total?: number }>(
    res,
    "读取调用日志"
  )
  const items = Array.isArray(data) ? data : (data.items ?? [])
  const total = Array.isArray(data) ? items.length : (data.total ?? items.length)
  return { items, total }
}

export async function listChannels(env: Env): Promise<NewApiChannel[]> {
  const all: NewApiChannel[] = []
  const seen = new Set<number>()

  for (let page = 1; page <= CHANNEL_MAX_PAGES; page++) {
    const res = await newApiFetch(
      env,
      `/api/channel/?p=${page}&page_size=${CHANNEL_PAGE_SIZE}`,
      { method: "GET" }
    )
    const data = await unwrap<
      NewApiChannel[] | { items?: NewApiChannel[]; total?: number }
    >(res, "读取渠道列表")

    // 老版本可能直接给数组（没有分页信封），保守兼容。
    const list = Array.isArray(data) ? data : (data.items ?? [])
    const total = Array.isArray(data) ? undefined : data.total

    let added = 0
    for (const c of list) {
      if (!c || typeof c.id !== "number" || seen.has(c.id)) continue
      seen.add(c.id)
      all.push(c)
      added += 1
    }

    // 本页没带来任何新渠道（空页 / 与前面完全重复）⇒ 后面也不会有新的了。
    // 这条是防死循环的兜底：不依赖 total 是否可信。
    if (list.length === 0 || added === 0) break
    // 已经收齐上游声明的总数
    if (typeof total === "number" && total > 0 && seen.size >= total) break
    // 不满一页 ⇒ 这是最后一页
    if (list.length < CHANNEL_PAGE_SIZE) break
  }

  return all
}

/**
 * 按 id 单查一个渠道；**不存在时返回 `null`**（不抛错）。
 *
 * 凡「已知渠道 ID、只想知道它还在不在 / 它的 channel_info」的地方，都该用这个，
 * 不要再用 `(await listChannels()).find(c => c.id === id)`：
 * 列表接口受分页封顶影响，渠道一多就可能漏掉目标 id，被误读成「渠道不存在」。
 *
 * ⚠️ 渠道不存在时 NewAPI 返回的是 **HTTP 200** + `{"success":false,
 *    "message":"record not found"}`（`controller/channel.go` 走 `common.ApiError`，
 *    而 `ApiError` 用的是 `http.StatusOK`）—— 不是 404。所以这里必须靠信封里的
 *    `success:false` + message 判断，不能只看状态码。
 */
export async function getChannel(
  env: Env,
  id: number
): Promise<NewApiChannel | null> {
  const res = await newApiFetch(env, `/api/channel/${Math.trunc(id)}`, {
    method: "GET",
  })
  const data = await unwrap<NewApiChannel>(
    res,
    `读取渠道 #${id}`,
    // 上游用「记录不存在」表示没这个 id，这是**正常结果**而非故障，
    // 交给调用方按「渠道不存在」处理（商汤那条路要据此拒绝捐献）。
    // ⚠️ 匹配要收紧：宽容的 `not found` 会把上游其它报错也吞成「渠道不存在」。
    (message) => /record ?not ?found|不存在/i.test(message)
  )
  // tolerate 命中时 unwrap 返回 `{}`（body.data 缺失）；也可能上游直接给 data:null。
  // 两种都归成 null。
  if (!data || typeof data.id !== "number") return null
  return data
}

export interface NewApiChannelInput {
  name: string
  type: number
  key: string
  baseUrl: string
  /** 逗号分隔的模型名（对外暴露的名字，已带 donation- 前缀） */
  models: string
  /** JSON 字符串：{"对外模型名": "上游真实模型名"} */
  modelMapping: string
  group: string
  /** 渠道测试默认用的模型名（填上游真实模型名最稳） */
  testModel?: string
  /**
   * 渠道标签。NewAPI 的渠道列表有「标签模式」，同一 tag 的渠道会归成一组 ——
   * 这就是我们用来给捐献渠道做「文件夹」的机制。
   */
  tag?: string
}

/** 新建一个单密钥渠道 */
export async function addChannel(
  env: Env,
  input: NewApiChannelInput
): Promise<void> {
  const res = await newApiFetch(env, "/api/channel/", {
    method: "POST",
    body: JSON.stringify({
      mode: "single",
      channel: {
        name: input.name,
        type: input.type,
        key: input.key,
        base_url: input.baseUrl,
        models: input.models,
        model_mapping: input.modelMapping,
        group: input.group,
        status: CHANNEL_STATUS_ENABLED,
        weight: 0,
        ...(input.testModel ? { test_model: input.testModel } : {}),
        ...(input.tag ? { tag: input.tag } : {}),
      },
    }),
  })
  await unwrap(res, "创建渠道")
}

/**
 * 只改渠道的**所属分组**（`PUT /api/channel/`）。
 *
 * 为什么只需要传 `id + group`：同 `updateChannelModels` —— NewAPI 的
 * `UpdateChannel` 走 GORM `Updates(结构体)`，只会写非零字段，没传的
 * name / key / base_url / models 全部原样保留。这正好绕开「读渠道拿不到明文 key」
 * 的死结（列表接口一律 `Omit("key")`），所以**改分组完全不需要 key**。
 *
 * ⚠️ 绝不能带 `status`（`UpdateChannel` 见到就报参数错误），启停要走
 * `/api/channel/:id/status`。
 *
 * 用途：把 2026-10-01 之前建在 `default` 分组里的捐献渠道，纠正到捐献分组
 * （见 handlers/donations.ts 复用渠道时的自愈）。
 */
export async function updateChannelGroup(
  env: Env,
  channelId: number,
  group: string
): Promise<void> {
  const res = await newApiFetch(env, "/api/channel/", {
    method: "PUT",
    body: JSON.stringify({ id: channelId, group }),
  })
  await unwrap(res, "更新渠道分组")
}

/**
 * 只改渠道的模型列表与重定向表（`PUT /api/channel/`）。
 *
 * ⚠️ 只传这两个字段是**刻意**的：NewAPI 的 `UpdateChannel` 最终走
 * `DB.Model(channel).Updates(channel)`，GORM 对结构体只更新**非零值**，
 * 所以没传的字段（name / key / base_url / group…）原样保留。
 * 反过来，如果为了「保险」把整条渠道都传回去，就要连带传 `status` ——
 * 而 `UpdateChannel` 明确拒绝 body 里出现 `status`（直接报参数错误）。
 *
 * 用途：逐个测完上游模型后，把不可用的从渠道里剔掉。
 */
export async function updateChannelModels(
  env: Env,
  channelId: number,
  models: string,
  modelMapping: string
): Promise<void> {
  const res = await newApiFetch(env, "/api/channel/", {
    method: "PUT",
    body: JSON.stringify({
      id: channelId,
      models,
      model_mapping: modelMapping,
    }),
  })
  await unwrap(res, "更新渠道模型")
}

/**
 * 往「多密钥渠道」里**追加**一把 Key（`PUT /api/channel/` + `key_mode: "append"`）。
 *
 * 为什么必须用 append 而不是自己拼：NewAPI 的 `UpdateChannel` 是「整体覆盖」语义，
 * 直接传 `key` 会**把渠道原有的 Key 全部替换掉**；而正确做法（先读出原 Key 再拼接）
 * 我们做不到 —— 读渠道的接口一律 `Omit("key")`，想看明文 Key 得走
 * `POST /api/channel/:id/key`，那个接口还额外要求「安全验证」，服务端调用过不去。
 * append 模式由 NewAPI 自己读原有 Key、去重、再换行拼接，正是我们要的语义。
 *
 * ⚠️ 三条只对多密钥渠道成立的约束（调用方必须先自查，见 sensenova.ts）：
 *   1. 目标渠道必须 `channel_info.is_multi_key === true`。否则 NewAPI 会**跳过**
 *      append 分支，`key` 直接当覆盖写进去 —— 一整个渠道的 Key 就没了；
 *   2. 只传 `{ id, key, key_mode }`。`ValidateChannel(isAdd=false)` 不要求
 *      models / key 非空，GORM 的 `Updates` 又只写非零字段，所以 name / models /
 *      group / base_url 都会原样保留 —— 多带字段反而有覆盖风险；
 *   3. **绝不能带 `status`**：`UpdateChannel` 见到 body 里有 status 直接报参数错误
 *      （启停要走 `/api/channel/:id/status`）。
 */
export async function appendChannelKey(
  env: Env,
  channelId: number,
  key: string
): Promise<void> {
  const res = await newApiFetch(env, "/api/channel/", {
    method: "PUT",
    body: JSON.stringify({ id: channelId, key, key_mode: "append" }),
  })
  await unwrap(res, "追加渠道密钥")
}

/** 多密钥渠道里单把 Key 的状态（**拿不到完整 Key，只有前 10 位预览**） */
export interface NewApiChannelKeyStatus {
  index: number
  /** 1=启用 2=手动禁用 3=自动禁用 */
  status: number
  /** NewAPI 生成的预览：`前10位 + "..."`（Key 本身不足 10 位则为全量） */
  preview: string
}

/**
 * 读多密钥渠道里每把 Key 的状态（`POST /api/channel/multi_key/manage`）。
 *
 * 这是**唯一**能在服务端侧定位「某把 Key 在渠道里的位置」的手段：它返回的是
 * `key_preview`（前 10 位），不是明文。所以用它做匹配时必须容忍歧义
 * （见 sensenova.ts 的 keyPreview / releaseSenseNovaKey）。
 */
export async function listChannelKeyStatus(
  env: Env,
  channelId: number,
  pageSize = 200
): Promise<NewApiChannelKeyStatus[]> {
  const res = await newApiFetch(env, "/api/channel/multi_key/manage", {
    method: "POST",
    body: JSON.stringify({
      channel_id: channelId,
      action: "get_key_status",
      page: 1,
      page_size: pageSize,
    }),
  })
  const data = await unwrap<{
    keys?: { index?: number; status?: number; key_preview?: string }[]
  }>(res, "读取渠道密钥状态")
  return (data.keys ?? []).map((k) => ({
    index: Number(k.index ?? 0),
    status: Number(k.status ?? 1),
    preview: String(k.key_preview ?? ""),
  }))
}

/**
 * 按索引删掉多密钥渠道里的一把 Key（服务端会重建索引与状态表）。
 *
 * ⚠️ 索引是**位置**，不是身份：中间删掉一把，后面所有 Key 的 index 都会前移。
 * 所以调用方必须在删除前**当场**读一次状态并定位，不能缓存索引。
 * NewAPI 拒绝删除最后一把 Key（返回「不能删除最后一个密钥」）。
 */
export async function deleteChannelKey(
  env: Env,
  channelId: number,
  keyIndex: number
): Promise<void> {
  const res = await newApiFetch(env, "/api/channel/multi_key/manage", {
    method: "POST",
    body: JSON.stringify({
      channel_id: channelId,
      action: "delete_key",
      key_index: keyIndex,
    }),
  })
  await unwrap(res, "删除渠道密钥")
}

/**
 * 把上游/中转站返回的报错压成一行可读文本。
 *
 * 上游的报错经常是**整页 HTML**（最典型：上游挂了 Cloudflare，把中转站服务器的
 * IP 当成攻击拦了，返回 403 + 一大段 `<!DOCTYPE html>`）。原样写进
 * `donations.review_note` 会：① 撑爆字段；② 用户和邮件里看到的全是标签，
 * 完全不知道该干什么。所以识别出 HTML 后只留「站点 + Ray ID」这两个能拿去找上游
 * 运维的信息。
 */
export function summarizeUpstreamError(msg: string, max = 240): string {
  const raw = (msg ?? "").trim()
  if (!raw) return ""
  if (/<!doctype html|<html[\s>]/i.test(raw)) {
    const host = /unable to access<\/span>\s*([^<]+)</i.exec(raw)?.[1]?.trim()
    const ray = /Ray ID:\s*<strong>([^<]+)<\/strong>/i.exec(raw)?.[1]?.trim()
    return [
      "[上游返回 HTML 错误页，通常是被 Cloudflare 拦截]",
      host ? `站点 ${host}` : "",
      ray ? `Ray ID ${ray}` : "",
      "把这两项给上游运维即可定位",
    ]
      .filter(Boolean)
      .join("；")
  }
  const flat = raw.replace(/\s+/g, " ")
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * 测试渠道连通性（可指定模型）。
 *
 * **不抛错**：NewAPI 的这个接口永远返回 HTTP 200，成功与否只看 body 的 success。
 * 失败原因（上游 401 / 模型不存在 / 余额不足）都在 message 里，需要原样带给管理员。
 *
 * ⚠️ 必须自带超时：一次捐献要逐个模型测试，最坏情况下每个都卡住的话，
 * 整个提交会拖到客户端超时。超时按「未通过」算，并给出可读的原因。
 */
export async function testChannel(
  env: Env,
  channelId: number,
  model?: string,
  timeoutMs = 10000
): Promise<{ ok: boolean; message: string; time: number }> {
  const qs = model ? `?model=${encodeURIComponent(model)}` : ""
  let res: Response
  try {
    res = await newApiFetch(env, `/api/channel/test/${channelId}${qs}`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError"
    return {
      ok: false,
      message: timedOut
        ? `测试超时（超过 ${Math.round(timeoutMs / 1000)} 秒无响应）`
        : err instanceof Error
          ? err.message
          : String(err),
      time: timeoutMs / 1000,
    }
  }
  const text = await res.text()
  let body: { success?: boolean; message?: string; time?: number } | null = null
  try {
    body = JSON.parse(text) as { success?: boolean; message?: string; time?: number }
  } catch {
    body = null
  }
  if (!body) {
    return {
      ok: false,
      message: `HTTP ${res.status}：${summarizeUpstreamError(text, 200)}`,
      time: 0,
    }
  }
  return {
    ok: body.success === true,
    message: summarizeUpstreamError(body.message ?? ""),
    time: Number(body.time ?? 0),
  }
}

/** 删除渠道（撤销捐献时收回资源用） */
export async function deleteChannel(env: Env, channelId: number): Promise<void> {
  const res = await newApiFetch(env, `/api/channel/${channelId}`, {
    method: "DELETE",
  })
  await unwrap(res, "删除渠道")
}

/**
 * 切换渠道启停状态（`POST /api/channel/:id/status`）。
 * 状态取值见 `CHANNEL_STATUS_ENABLED`(1) / `CHANNEL_STATUS_MANUALLY_DISABLED`(2)。
 * 用于「失效渠道批量禁用」—— 把测不通的渠道标记为手动禁用，避免它们继续抢占
 * 正常渠道的流量（NewAPI 轮询到坏渠道时会拖慢整体响应）。
 */
export async function setChannelStatus(
  env: Env,
  channelId: number,
  status: number
): Promise<void> {
  const res = await newApiFetch(env, `/api/channel/${Math.trunc(channelId)}/status`, {
    method: "POST",
    body: JSON.stringify({ status }),
  })
  await unwrap(res, `更新渠道 #${channelId} 状态`)
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
 * 用「当前生效的凭据」做一次管理员级连通性探测。
 * 供管理面板显示「令牌是否还有效」——NewAPI 的令牌会被后台轮换，
 * 不主动探测就只能等用户建 Key 时才发现已经 401。
 * 不抛错：未配置或失败都返回 { ok: false, message }。
 */
export async function probeAdminCredential(
  env: Env
): Promise<{ ok: boolean; message: string }> {
  const { token, userId } = await resolveAdminCredentials(env)
  if (!token) return { ok: false, message: "未配置管理员令牌" }
  return verifyAdminCredential(env, token, userId)
}

/**
 * 更新管理员凭据（写 D1，加密存储），并立即使缓存失效。
 * 写入前不校验令牌有效性 —— 由调用方（admin 端点）先做一次真实调用来验证，
 * 此处只负责落库，避免「验证逻辑」与「存储逻辑」纠缠。
 *
 * ⚠️ 顺带自愈 root 自己的账号绑定：
 * NewAPI 里「系统访问令牌」与 root 用户自己的 `users.access_token` 是**同一个字段**
 * （见 rc.15 的 GenerateAccessToken → user.SetAccessToken + Update）。因此在后台
 * 重新生成系统访问令牌，会同时把 root 自己那份用户级令牌顶掉 —— 表现为
 * newapi_accounts 里 root 那一行突然 401，而其他用户不受影响。
 * 既然管理员令牌就是 root 的用户令牌，这里把它同步写回该账号，
 * 让「更新管理员令牌」一步就把 root 的绑定一起修好。
 */
export async function saveAdminCredential(
  env: Env,
  token: string,
  adminUserId: string
): Promise<{ healedAccounts: number }> {
  if (!env.SESSION_SECRET) {
    throw new ApiError(
      503,
      "未配置 SESSION_SECRET，无法安全保存管理员凭据",
      "NOT_CONFIGURED"
    )
  }
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO newapi_admin_credentials (id, enc_token, admin_user_id, updated_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       enc_token = excluded.enc_token,
       admin_user_id = excluded.admin_user_id,
       updated_at = excluded.updated_at`
  )
    .bind(await encryptSecret(token, env.SESSION_SECRET), adminUserId, now)
    .run()
  invalidateAdminCredentialCache()

  // 该管理员令牌所属用户若在本站也绑定过中转站账号，用同一把令牌把它刷新
  // （两者在 NewAPI 侧是同一份凭据，不同步就会留下一个必然失效的旧值）
  const uid = Number(adminUserId)
  if (!Number.isFinite(uid) || uid <= 0) return { healedAccounts: 0 }
  const healed = await env.DB.prepare(
    "UPDATE newapi_accounts SET enc_token = ?, synced_at = ? WHERE newapi_user_id = ?"
  )
    .bind(await encryptSecret(token, env.SESSION_SECRET), now, uid)
    .run()
  return { healedAccounts: healed.meta?.changes ?? 0 }
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

/**
 * 给「还没有 ModelPrice（按次价）」的模型自动补上 1 元/次。
 *
 * 全站改为按次计费（ModelPrice）后，新模型若不设 ModelPrice 会回落 token 计费的
 * 默认倍率 37.5。这个函数在定时任务里调用，扫一遍 pricing，发现没有 model_price
 * 的模型就补标 ModelPrice=1，保证「所有模型统一 1 元/次」。
 *
 * 返回本次补标的模型数量。
 */
export async function autoPriceNewModels(env: Env): Promise<number> {
  // 1. 读原始 pricing（含 model_price）
  const res = await newApiFetch(env, "/api/pricing", { method: "GET" })
  const data = await unwrap<
    { model_name?: string; model_price?: number }[]
  >(res, "读取模型分组")

  if (!Array.isArray(data)) return 0

  // 2. 找出「没有按次价」的模型（model_price 缺失或为 0）
  const unPriced = data.filter((m) => m.model_name && !(m.model_price ?? 0))
  if (unPriced.length === 0) return 0

  // 3. 读当前 ModelPrice option，补上缺失的模型
  const optsRes = await newApiFetch(env, "/api/option/", { method: "GET" })
  const opts = await unwrap<{ key?: string; value?: string }[]>(optsRes, "读取设置")
  const optList = Array.isArray(opts) ? opts : []
  const raw = optList.find((o) => o.key === "ModelPrice")?.value ?? "{}"
  let modelPrice: Record<string, number> = {}
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === "object" && parsed !== null) modelPrice = parsed
  } catch {
    modelPrice = {}
  }

  // 4. 补标 1 元/次
  for (const m of unPriced) {
    modelPrice[m.model_name!] = 1
  }

  // 5. 写回
  const r = await newApiFetch(env, "/api/option/", {
    method: "PUT",
    body: JSON.stringify({ key: "ModelPrice", value: JSON.stringify(modelPrice) }),
  })
  await unwrap(r, "更新 ModelPrice")

  return unPriced.length
}

/**
 * 管理员给用户开通订阅套餐（免支付，立即生效）。
 * 对应 NewAPI `POST /api/subscription/admin/users/:id/subscriptions`，body 只认 plan_id。
 * 返回订阅是否成功，以及可能的提示（如「用户分组将升级到 xxx」）。
 */
export async function adminGrantSubscription(
  env: Env,
  newapiUserId: number,
  planId: number
): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await newApiFetch(
      env,
      `/api/subscription/admin/users/${newapiUserId}/subscriptions`,
      {
        method: "POST",
        body: JSON.stringify({ plan_id: planId }),
      }
    )
    const data = await unwrap<{ message?: string } | null>(res, "开通订阅")
    const msg = (data && data.message) || ""
    return { ok: true, message: msg }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // 「已达到该套餐购买上限」这类错误，说明用户已有订阅，视为已开通
    if (/上限|已订阅|already|limit/i.test(msg)) {
      return { ok: true, message: "你已领取过免费订阅" }
    }
    return { ok: false, message: msg }
  }
}

/** 用户的一条订阅（用于展示实时剩余额度 / 下次重置时间） */
export interface UserSubscriptionInfo {
  planId: number
  amountTotal: number
  amountUsed: number
  startTime: number
  endTime: number
  status: string
  nextResetTime: number
}

/** 拉取某用户的订阅列表（未过滤 status） */
async function fetchUserSubscriptions(
  env: Env,
  newapiUserId: number
): Promise<UserSubscriptionInfo[]> {
  const res = await newApiFetch(
    env,
    `/api/subscription/admin/users/${newapiUserId}/subscriptions`,
    { method: "GET" }
  )
  const data = await unwrap<{ subscription?: Record<string, unknown> }[]>(
    res,
    "查询订阅"
  )
  if (!Array.isArray(data)) return []
  return data
    .map((d) => d.subscription)
    .filter((s): s is Record<string, unknown> => Boolean(s))
    .map((s) => ({
      planId: Number(s.plan_id ?? 0),
      amountTotal: Number(s.amount_total ?? 0),
      amountUsed: Number(s.amount_used ?? 0),
      startTime: Number(s.start_time ?? 0),
      endTime: Number(s.end_time ?? 0),
      status: String(s.status ?? ""),
      nextResetTime: Number(s.next_reset_time ?? 0),
    }))
}

/** 管理员查询某用户的订阅列表（取 active 的一条） */
export async function listUserSubscriptions(
  env: Env,
  newapiUserId: number
): Promise<UserSubscriptionInfo | null> {
  try {
    const all = await fetchUserSubscriptions(env, newapiUserId)
    return all.find((s) => s.status === "active") ?? null
  } catch {
    return null
  }
}

/**
 * 管理员查询某用户的**全部** active 订阅。
 *
 * 一个用户可能同时持有多张订阅（免费套餐 + 各档邀请/奖励套餐），消费时按
 * `end_time asc, id asc` 逐张接力，所以「总额度」= 各张之和。前端要按套餐类型
 * 分段展示这个总额，故这里必须把整份列表交出去，不能只取第一条。
 */
export async function listAllUserSubscriptions(
  env: Env,
  newapiUserId: number
): Promise<UserSubscriptionInfo[]> {
  try {
    const all = await fetchUserSubscriptions(env, newapiUserId)
    return all.filter((s) => s.status === "active")
  } catch (err) {
    console.error("查询用户订阅列表失败:", err)
    return []
  }
}

/** 套餐定义（只取展示需要的字段） */
export interface SubscriptionPlanInfo {
  planId: number
  /** 套餐名，如「wb邀请套餐」 */
  title: string
}

/**
 * 读取全部订阅套餐定义（管理员接口；实测公开访问 401）。
 *
 * 用途：把订阅记录里的 plan_id 翻译成人能看懂的名字。订阅记录只存 plan_id，
 * 名字在套餐表里。**额度不从这里取** —— 订阅创建时把套餐额度快照进了订阅记录，
 * 之后改套餐不影响老订阅，所以展示额度必须用订阅自己的 amount_total。
 *
 * 失败返回空数组（套餐名降级成「套餐 #id」，不影响额度展示）。
 */
export async function listSubscriptionPlans(
  env: Env
): Promise<SubscriptionPlanInfo[]> {
  try {
    const res = await newApiFetch(env, "/api/subscription/plans", {
      method: "GET",
    })
    const data = await unwrap<{ plan?: Record<string, unknown> }[]>(
      res,
      "读取订阅套餐"
    )
    if (!Array.isArray(data)) return []
    return data
      .map((d) => d.plan)
      .filter((p): p is Record<string, unknown> => Boolean(p))
      .map((p) => ({
        planId: Number(p.id ?? 0),
        title: String(p.title ?? ""),
      }))
  } catch (err) {
    console.error("读取订阅套餐失败:", err)
    return []
  }
}