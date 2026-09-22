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
import type { Env } from "./env"

interface NewApiConfig {
  baseUrl: string
  adminToken: string
  adminUserId: string
}

function config(env: Env): NewApiConfig {
  const baseUrl = env.NEWAPI_BASE_URL
  const adminToken = env.NEWAPI_ADMIN_TOKEN
  if (!baseUrl || !adminToken) {
    throw new ApiError(
      503,
      "AI 中转站未配置（缺少 NewAPI 凭据）",
      "NEWAPI_NOT_CONFIGURED"
    )
  }
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    adminToken,
    adminUserId: env.NEWAPI_ADMIN_USER_ID ?? "1",
  }
}

export function isNewApiConfigured(env: Env): boolean {
  return Boolean(env.NEWAPI_BASE_URL && env.NEWAPI_ADMIN_TOKEN)
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
  const cfg = config(env)
  const headers = new Headers(init.headers)
  headers.set("Content-Type", "application/json")

  if (init.auth !== "none") {
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
  const cfg = config(env)
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