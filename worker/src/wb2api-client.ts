/**
 * WorkBuddy 反代网关（workbuddy2api-panel）客户端。
 *
 * 本站用它做「捐献即解锁 AI 权限」：捐献者在浏览器登录自己的 WorkBuddy
 * 国际版账号，网关收到授权后自动完成凭证落盘 + 热加载进共享池 + 注册激活 +
 * 领 trial —— 本站只需要发起授权、轮询结果，拿到 uid 即完成绑定。
 *
 * 关键约束（已对该网关源码与线上实例核实）：
 *   1. 所有 `/panel/api/*` 都需要 `Authorization: Bearer <api_key>`。
 *   2. `login/start` 返回 `{url, state}`；**state 就是换取 token 的凭据**，
 *      绝不能下发给前端（否则他人可抢先 poll 把账号据为己有）。本站自行生成
 *      session_id 下发前端，state 存服务端（见 handlers/wb2api.ts）。
 *   3. `login/poll` 成功后网关**立即从内存删除 state**，重复 poll 只会拿到
 *      404「unknown or expired state」。调用方必须缓存终态。
 *   4. state 有效期 15 分钟（网关 loginTTL）。
 *
 * 凭据来源与 newapi-client 同构：D1 加密单行表优先、env 回落，带 5 秒内存缓存
 * （一次捐献页加载会连调 status/start/poll，不缓存会白读几次 D1）。
 */
import { ApiError } from "./http"
import { decryptSecret, encryptSecret } from "./crypto"
import { getSetting } from "./settings"
import type { Env } from "./env"

/** 出站超时：网关短 RPC 都是毫秒级，8 秒足够；避免上游挂死拖垮请求 */
const FETCH_TIMEOUT_MS = 8000
/**
 * `login/poll` 专用超时，远长于上面的通用值。
 *
 * 原因：网关的 poll 在「登录刚完成」那一次**不是**短 RPC —— 它同步跑完整套收尾才返回
 * （取 token → 取账号 → 凭证落盘 → 热加载进池 → 签到 → 余额刷新，见网关
 * `internal/panel/login.go` 的 loginPoll）。后两步要真打腾讯上游，实测该网关连纯内存的
 * `/healthz` 都要 1.6s，poll 串行打 4 次上游很容易突破 8s。
 *
 * 用通用 8s 会 abort，而网关的 handler 不受客户端断开影响、照样把账号 `Pool.Add` 进池
 * ⇒ 现象是「账号已进共享池，但本站没拿到 uid、没授 ai 权限，重试又被池去重拦下」。
 */
const POLL_TIMEOUT_MS = 30_000
/** 响应体上限：网关返回的都是小 JSON（账号列表可能稍大），1 MiB 足够 */
const MAX_FETCH_BYTES = 1024 * 1024
const CREDENTIAL_CACHE_MS = 5000

/**
 * 凭据来源：
 *   - `db`：管理面板写入的（优先）—— 网关的 api_key 在面板里可随时改，
 *     改一次就得重跑 wrangler secret 太别扭，故允许网页端直接更新
 *   - `env`：Worker Secret（WB2API_API_KEY）
 *   - `none`：都没有
 */
export type Wb2ApiCredentialSource = "db" | "env" | "none"

let credentialCache: {
  at: number
  baseUrl: string
  apiKey: string | null
  source: Wb2ApiCredentialSource
} | null = null

/** 默认站点地址（设置项 wb2api_base_url 未配置时用） */
const DEFAULT_BASE_URL = "https://wb2api.doulor.cn"

/**
 * 解析网关地址与 api_key。
 *
 * baseUrl 优先取设置项（管理员可改），回落 env，最后用内置默认值；
 * apiKey 优先取 D1 加密行，回落 env.WB2API_API_KEY。
 */
export async function resolveWb2ApiConfig(env: Env): Promise<{
  baseUrl: string
  apiKey: string | null
  source: Wb2ApiCredentialSource
}> {
  const now = Date.now()
  if (credentialCache && now - credentialCache.at < CREDENTIAL_CACHE_MS) {
    return credentialCache
  }

  let baseUrl = DEFAULT_BASE_URL
  try {
    const fromSetting = (await getSetting(env, "wb2api_base_url")).trim()
    if (fromSetting) baseUrl = fromSetting
  } catch (err) {
    console.error("读取 wb2api_base_url 失败，用默认值:", err)
  }
  if (!baseUrl) baseUrl = env.WB2API_BASE_URL?.trim() || DEFAULT_BASE_URL
  baseUrl = baseUrl.replace(/\/+$/, "")

  let apiKey: string | null = env.WB2API_API_KEY?.trim() || null
  let source: Wb2ApiCredentialSource = apiKey ? "env" : "none"

  // 库里的凭据用 SESSION_SECRET 派生的密钥加密；缺密钥则只能用 env
  if (env.SESSION_SECRET) {
    try {
      const row = await env.DB.prepare(
        "SELECT enc_api_key FROM wb2api_credentials WHERE id = 1"
      ).first<{ enc_api_key: string }>()
      if (row) {
        apiKey = await decryptSecret(row.enc_api_key, env.SESSION_SECRET)
        source = "db"
      }
    } catch (err) {
      // 解密失败（如 SESSION_SECRET 换过）不应让捐献页整体挂掉，回落到 env
      console.error("读取反代网关 api_key 失败，回落到环境变量:", err)
    }
  }

  credentialCache = { at: now, baseUrl, apiKey, source }
  return credentialCache
}

/** 是否已配置（地址恒有默认值，故只看 api_key） */
export async function isWb2ApiConfigured(env: Env): Promise<boolean> {
  return Boolean((await resolveWb2ApiConfig(env)).apiKey)
}

function invalidateWb2ApiCache(): void {
  credentialCache = null
}

/**
 * 强制下次重新解析凭据。写入路径已自动调用；导出仅供测试在直接改库后
 * 让本进程立即感知（其他 isolate 最多等 CREDENTIAL_CACHE_MS）。
 */
export function resetWb2ApiCache(): void {
  invalidateWb2ApiCache()
}

/** 掩码展示：<前4>****<后4>，不足以掩码时全星号（与 newapi maskToken 同口径） */
export function maskApiKey(key: string): string {
  if (key.length <= 8) return "*".repeat(Math.max(key.length, 4))
  return `${key.slice(0, 4)}${"*".repeat(8)}${key.slice(-4)}`
}

/** 网关返回的信封：{ok, error}；业务失败时 ok=false + error 文案 */
interface Wb2Envelope {
  ok?: boolean
  error?: string
}

/** 上游返回「state 未知或已过期」（网关 poll 成功一次后 state 即被删除） */
export class Wb2StateGoneError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "Wb2StateGoneError"
  }
}

/** 上游返回 401：api_key 错误或已被轮换 */
export class Wb2UnauthorizedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "Wb2UnauthorizedError"
  }
}

/**
 * 发一次网关请求并解析信封。
 *
 * 错误信息一律不原样回显上游 body（网关的 401 文案里可能带请求细节），
 * 只按状态码给本站自己的文案，避免 api_key 相关线索泄露到前端。
 */
async function wb2Fetch<T>(
  env: Env,
  path: string,
  init: RequestInit = {},
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<T> {
  const cfg = await resolveWb2ApiConfig(env)
  if (!cfg.apiKey) {
    throw new ApiError(
      503,
      "反代网关未配置访问密钥，请联系管理员",
      "WB2API_NOT_CONFIGURED"
    )
  }

  const headers = new Headers(init.headers)
  headers.set("Authorization", `Bearer ${cfg.apiKey}`)
  headers.set("Accept", "application/json")
  if (init.body) headers.set("Content-Type", "application/json")

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(`${cfg.baseUrl}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
      redirect: "follow",
    })
  } catch (err) {
    // abort 是本站自己的超时（上游没回），不是网络错误；文案要能区分，
    // 否则前端只能看到 Node/undici 的「The operation was aborted」。
    if (controller.signal.aborted) {
      throw new ApiError(
        504,
        `反代网关响应超时（${Math.round(timeoutMs / 1000)} 秒）`,
        "WB2API_TIMEOUT"
      )
    }
    const msg = err instanceof Error ? err.message : String(err)
    throw new ApiError(
      502,
      `无法连接反代网关（${msg}）`,
      "WB2API_UNREACHABLE"
    )
  } finally {
    clearTimeout(timer)
  }

  const buf = await res.arrayBuffer()
  if (buf.byteLength > MAX_FETCH_BYTES) {
    throw new ApiError(502, "反代网关响应过大", "WB2API_BAD_RESPONSE")
  }
  const text = new TextDecoder("utf-8").decode(buf)

  if (res.status === 401 || res.status === 403) {
    throw new Wb2UnauthorizedError("反代网关拒绝了本站的访问密钥")
  }
  if (res.status === 404) {
    // 网关对未知 state 回 404「unknown or expired state」；
    // 对不存在的账号路径也回 404 —— 两者由调用方按上下文区分。
    throw new Wb2StateGoneError(text.slice(0, 200) || "not found")
  }
  if (!res.ok) {
    throw new ApiError(
      502,
      `反代网关返回 ${res.status}`,
      "WB2API_UPSTREAM_ERROR"
    )
  }

  let parsed: Wb2Envelope & Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Wb2Envelope & Record<string, unknown>
  } catch {
    throw new ApiError(502, "反代网关返回了非 JSON 响应", "WB2API_BAD_RESPONSE")
  }
  if (parsed.ok === false) {
    throw new ApiError(
      502,
      parsed.error || "反代网关返回业务错误",
      "WB2API_UPSTREAM_ERROR"
    )
  }
  return parsed as unknown as T
}

// ---------------------------------------------------------------------------
// 登录（设备授权）
// ---------------------------------------------------------------------------

export interface Wb2StartResult {
  url: string
  state: string
  realm: string
}

/**
 * 读取反代网关对接的 WorkBuddy 域：'cn'（国内版）或 'global'（国际版）。
 * 默认 'cn'，管理员可在设置项 wb2api_realm 里切换。
 */
async function resolveRealm(env: Env): Promise<string> {
  try {
    const v = (await getSetting(env, "wb2api_realm")).trim().toLowerCase()
    if (v === "global" || v === "cn") return v
  } catch {
    /* 读设置失败回退默认 */
  }
  return "cn"
}

/**
 * 发起设备授权，返回授权链接与 state（state 只留在服务端）。
 * realm 取自设置项 wb2api_realm（默认国内版 'cn'）。
 */
export async function wb2Start(env: Env, realm?: string): Promise<Wb2StartResult> {
  const effectiveRealm = realm ?? (await resolveRealm(env))
  const data = await wb2Fetch<{ url: string; state: string; realm?: string }>(
    env,
    "/panel/api/login/start",
    { method: "POST", body: JSON.stringify({ realm: effectiveRealm }) }
  )
  if (!data.url || !data.state) {
    throw new ApiError(502, "反代网关未返回授权链接", "WB2API_BAD_RESPONSE")
  }
  return { url: data.url, state: data.state, realm: data.realm ?? effectiveRealm }
}

export interface Wb2PollResult {
  done: boolean
  uid?: string
  nickname?: string
  realm?: string
  credits?: number
  creditsTotal?: number
  /** 未完成时网关给的原因（"login ing" 之类） */
  pendingMessage?: string
}

/**
 * 轮询登录结果。
 *
 * 网关未完成时回 HTTP 200 + `{done:false, message}`；完成时回 `{done:true, uid,...}`。
 * 注意：**成功一次后 state 即失效**，重复调用会抛 Wb2StateGoneError —— 调用方
 * 必须先把终态落库（见 handlers/wb2api.ts 的会话表）。
 */
export async function wb2Poll(env: Env, state: string): Promise<Wb2PollResult> {
  const data = await wb2Fetch<{
    done?: boolean
    message?: string
    uid?: string
    nickname?: string
    realm?: string
    credits?: number
    credits_total?: number
  }>(
    env,
    `/panel/api/login/poll?state=${encodeURIComponent(state)}`,
    { method: "GET" },
    // 登录成功那一次 poll 会同步跑完「落盘 + 热加载 + 签到 + 余额刷新」，
    // 远慢于其它短 RPC —— 必须给足超时，否则 abort 后网关照样把账号加进池、
    // 本站却拿不到 uid（见 POLL_TIMEOUT_MS 注释）。
    POLL_TIMEOUT_MS
  )

  if (!data.done) {
    return { done: false, pendingMessage: data.message ?? "waiting for login" }
  }
  if (!data.uid) {
    throw new ApiError(
      502,
      "反代网关登录成功但未返回账号 uid",
      "WB2API_BAD_RESPONSE"
    )
  }
  return {
    done: true,
    uid: data.uid,
    nickname: data.nickname,
    realm: data.realm ?? "global",
    credits: typeof data.credits === "number" ? data.credits : undefined,
    creditsTotal:
      typeof data.credits_total === "number" ? data.credits_total : undefined,
  }
}

// ---------------------------------------------------------------------------
// 账号运维（管理端）
// ---------------------------------------------------------------------------

/** 从网关共享池移除一个账号（摘掉捐献）。404（账号已不在池里）视为成功。 */
export async function wb2RemoveAccount(env: Env, uid: string): Promise<void> {
  try {
    await wb2Fetch(env, `/panel/api/accounts/${encodeURIComponent(uid)}/remove`, {
      method: "POST",
    })
  } catch (err) {
    // 账号已不在池里 = 目标状态已达成，不算失败
    if (err instanceof Wb2StateGoneError) return
    throw err
  }
}

export interface Wb2PoolOverview {
  total: number
  healthy: number
  cooling: number
  disabled: number
  accounts: {
    uid: string
    nickname?: string
    realm?: string
    credits?: number
  }[]
}

/** 读取网关账号池概览（管理端展示健康度用；字段按网关 /panel/api/overview 契约） */
export async function wb2Overview(env: Env): Promise<Wb2PoolOverview> {
  const data = await wb2Fetch<{
    total?: number
    healthy?: number
    cooling?: number
    disabled?: number
    accounts?: {
      uid: string
      nickname?: string
      realm?: string
      credits?: number
    }[]
  }>(env, "/panel/api/overview", { method: "GET" })

  return {
    total: data.total ?? 0,
    healthy: data.healthy ?? 0,
    cooling: data.cooling ?? 0,
    disabled: data.disabled ?? 0,
    accounts: data.accounts ?? [],
  }
}

// ---------------------------------------------------------------------------
// 凭据管理（管理端）
// ---------------------------------------------------------------------------

export interface Wb2ApiCredentialInfo {
  baseUrl: string
  source: Wb2ApiCredentialSource
  /** 掩码后的 api_key；未配置时为 null。明文绝不下发 */
  maskedApiKey: string | null
  updatedAt: string | null
}

export async function getWb2ApiCredentialInfo(
  env: Env
): Promise<Wb2ApiCredentialInfo> {
  const cfg = await resolveWb2ApiConfig(env)
  let updatedAt: string | null = null
  if (cfg.source === "db") {
    const row = await env.DB.prepare(
      "SELECT updated_at FROM wb2api_credentials WHERE id = 1"
    ).first<{ updated_at: string }>()
    updatedAt = row?.updated_at ?? null
  }
  return {
    baseUrl: cfg.baseUrl,
    source: cfg.source,
    maskedApiKey: cfg.apiKey ? maskApiKey(cfg.apiKey) : null,
    updatedAt,
  }
}

/**
 * 保存 api_key：先用给定密钥做一次真实调用验证，通过后才加密落库。
 * 验证失败不写库 —— 否则会把原本可用的 env 凭据一起顶掉。
 */
export async function saveWb2ApiKey(
  env: Env,
  apiKey: string
): Promise<{ ok: boolean; message: string }> {
  if (!env.SESSION_SECRET) {
    throw new ApiError(
      503,
      "未配置 SESSION_SECRET，无法安全保存访问密钥",
      "NOT_CONFIGURED"
    )
  }

  const health = await verifyWb2ApiKey(env, apiKey)
  if (!health.ok) return health

  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO wb2api_credentials (id, enc_api_key, updated_at)
     VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       enc_api_key = excluded.enc_api_key,
       updated_at = excluded.updated_at`
  )
    .bind(await encryptSecret(apiKey, env.SESSION_SECRET), now)
    .run()
  invalidateWb2ApiCache()
  return { ok: true, message: "密钥有效，已保存" }
}

/**
 * 用指定 api_key 真实探测一次网关（不读缓存、不落库）。
 * 走 `/panel/api/overview`：需要鉴权，且能顺带反映账号池是否正常。
 */
export async function verifyWb2ApiKey(
  env: Env,
  apiKey: string
): Promise<{ ok: boolean; message: string }> {
  const cfg = await resolveWb2ApiConfig(env)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(`${cfg.baseUrl}/panel/api/overview`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    })
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: "访问密钥无效（网关拒绝）" }
    }
    if (!res.ok) {
      return { ok: false, message: `网关返回 ${res.status}` }
    }
    const body = (await res.json().catch(() => null)) as {
      total?: number
      healthy?: number
    } | null
    if (!body) return { ok: false, message: "网关返回了非 JSON 响应" }
    return {
      ok: true,
      message: `密钥有效（账号池 ${body.healthy ?? 0}/${body.total ?? 0} 可用）`,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `无法连接网关：${msg}` }
  } finally {
    clearTimeout(timer)
  }
}

/** 用当前生效的凭据探测一次（管理面板打开即知密钥是否还有效） */
export async function probeWb2ApiCredential(
  env: Env
): Promise<{ ok: boolean; message: string }> {
  const cfg = await resolveWb2ApiConfig(env)
  if (!cfg.apiKey) return { ok: false, message: "未配置访问密钥" }
  return verifyWb2ApiKey(env, cfg.apiKey)
}
