/**
 * Qoder2API-Hub 网关客户端（https://github.com/shuishuipingan/qoder2api-hub）。
 *
 * 本文件**取代**原来的 cli2api-client.ts（那个上游是 github.com/caigee-cmd/cli2api）。
 * 同样做「捐献即解锁 AI 权限」：捐献者在浏览器登录自己的 Qoder 账号，网关收到授权后
 * 把账号放进共享池，本站只负责发起授权、轮询结果、拿到 uid 落绑定。
 *
 * 实测定下来的事实（2026-10-09 对着线上实例逐条验证，v1.3.4）：
 *   1. 🔴 **`/accounts/*` 是「面板路由」，必须带 `X-Panel-Token`** ——
 *      由 `POST /panel/login {password}` 换来的内存会话。**API Key 打不通这些接口**
 *      （它只管 `/v1/*` 数据面）。所以我们存的是**面板密码**，不是 API Key。
 *   2. 面板会话**存在内存里**（重启容器即失效），TTL 7 天；本站缓存 10 分钟，
 *      遇到 401 自动重新登录一次再重试。
 *   3. 登录是**两步**（不像 cli2api 的三步）：
 *        a) `POST /accounts/login/start {platform, realm}` → `{state, authUrl, realm, platform}`
 *        b) `GET  /accounts/login/poll?state=` → `{status, message?, account?}`
 *      status ∈ `pending | ok | expired | unknown | error`（本客户端归一化成 `pending|done|failed`）。
 *   4. 🔴 **账号不是本站预建的** —— 上游在设备授权成功那一刻才 `POOL.add(account)`。
 *      所以没有「没登录成功的空账号」要清理（原 cli2api 的 discardSessionAccount 不需要了）。
 *   5. 登录窗口 **10 分钟**（`LOGIN_TTL_SECONDS=600`）；拿到结果后上游即删 state，
 *      重复 poll 只会得到 `unknown` ⇒ 调用方必须缓存终态（见 handlers/qoder2api.ts）。
 *   6. 解绑 = `POST /accounts/delete {uid}`。
 *
 * 响应没有统一信封：成功时直接是数据对象；失败时是
 * `{"error":{"message","type","code"}}`，HTTP 状态码即语义。
 *
 * 凭据来源与 newapi/wb2api 同构：D1 加密单行表优先、env 回落，带 5 秒内存缓存
 * （一次捐献页加载会连调 status/start/poll，不缓存会白读几次 D1）。
 */
import { ApiError } from "./http"
import { decryptSecret, encryptSecret } from "./crypto"
import { getSetting } from "./settings"
import type { Env } from "./env"

/** 通用出站超时：面板 RPC 都是毫秒级，10 秒足够 */
const FETCH_TIMEOUT_MS = 10_000
/**
 * `login/poll` 专用超时。
 * 上游 poll 成功那一次要顺带 `http_json(userinfo)` 补昵称，比其它短 RPC 慢一些；
 * 给足 30 秒，避免本站 abort 了但上游其实已经把账号入池（就会「账号在池里、本站没绑定」）。
 */
const POLL_TIMEOUT_MS = 30_000
/** 响应体上限：返回的都是小 JSON（账号列表稍大），1 MiB 足够 */
const MAX_FETCH_BYTES = 1024 * 1024
const CONFIG_CACHE_MS = 5000
/**
 * 面板会话本地缓存时长。
 * 上游会话本身 TTL 7 天，但「重新登录一次」成本很低（一次 POST），
 * 缓存 10 分钟可以避免每次请求都登录、又不会因为上游重启而长时间拿着死 token。
 */
const SESSION_CACHE_MS = 10 * 60 * 1000

/** 默认站点地址（设置项 qoder2api_base_url 未配置时用） */
const DEFAULT_BASE_URL = "https://qoder2api.doulor.cn"

/** 支持的区域：cn = 国内版（qoder.com.cn），intl = 国际版（qoder.com） */
export const QODER2API_REALMS = ["cn", "intl"] as const
export type Qoder2ApiRealm = (typeof QODER2API_REALMS)[number]
export const DEFAULT_REALM: Qoder2ApiRealm = "cn"

/** 把任意输入收敛成合法 realm（认不出一律回 cn） */
export function normalizeRealm(raw: unknown): Qoder2ApiRealm {
  const v = String(raw ?? "").trim().toLowerCase()
  return (QODER2API_REALMS as readonly string[]).includes(v) ? (v as Qoder2ApiRealm) : DEFAULT_REALM
}

export type Qoder2ApiCredentialSource = "db" | "env" | "none"

export interface Qoder2ApiConfig {
  baseUrl: string
  panelPassword: string | null
  source: Qoder2ApiCredentialSource
}

let configCache: { at: number; cfg: Qoder2ApiConfig } | null = null
/** 面板会话缓存（与 baseUrl 绑定：管理员换了地址就作废重登） */
let sessionCache: { at: number; baseUrl: string; token: string } | null = null

/** 解析网关地址与面板密码（baseUrl 优先设置项，密码优先 D1 加密行） */
export async function resolveQoder2ApiConfig(env: Env): Promise<Qoder2ApiConfig> {
  const now = Date.now()
  if (configCache && now - configCache.at < CONFIG_CACHE_MS) {
    return configCache.cfg
  }

  let baseUrl = DEFAULT_BASE_URL
  try {
    const fromSetting = (await getSetting(env, "qoder2api_base_url")).trim()
    if (fromSetting) baseUrl = fromSetting
  } catch (err) {
    console.error("读取 qoder2api_base_url 失败，用默认值:", err)
  }
  if (!baseUrl) baseUrl = env.QODER2API_BASE_URL?.trim() || DEFAULT_BASE_URL
  baseUrl = baseUrl.replace(/\/+$/, "")

  let panelPassword: string | null = env.QODER2API_PANEL_PASSWORD?.trim() || null
  let source: Qoder2ApiCredentialSource = panelPassword ? "env" : "none"

  // 库里的凭据用 SESSION_SECRET 派生的密钥加密；缺密钥则只能用 env
  if (env.SESSION_SECRET) {
    try {
      const row = await env.DB.prepare(
        "SELECT enc_panel_password FROM qoder2api_credentials WHERE id = 1"
      ).first<{ enc_panel_password: string }>()
      if (row) {
        panelPassword = await decryptSecret(row.enc_panel_password, env.SESSION_SECRET)
        source = "db"
      }
    } catch (err) {
      // 解密失败（如 SESSION_SECRET 换过）不应让捐献页整体挂掉，回落到 env
      console.error("读取 qoder2api 面板密码失败，回落到环境变量:", err)
    }
  }

  const cfg: Qoder2ApiConfig = { baseUrl, panelPassword, source }
  configCache = { at: now, cfg }
  return cfg
}

/** 是否已配置（地址恒有默认值，故只看面板密码） */
export async function isQoder2ApiConfigured(env: Env): Promise<boolean> {
  return Boolean((await resolveQoder2ApiConfig(env)).panelPassword)
}

function invalidateConfig(): void {
  configCache = null
}

function invalidateSession(): void {
  sessionCache = null
}

/** 强制下次重新解析凭据（写入路径已自动调用；导出供测试直接改库后立即感知） */
export function resetQoder2ApiCache(): void {
  invalidateConfig()
  invalidateSession()
}

/** 掩码展示：<前4>****<后4> */
export function maskPanelPassword(pw: string): string {
  if (pw.length <= 8) return "*".repeat(Math.max(pw.length, 4))
  return `${pw.slice(0, 4)}${"*".repeat(8)}${pw.slice(-4)}`
}

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

/**
 * 面板密码无效（上游 401/403）。
 *
 * ⚠️ 与 wb2api-client 的 `Wb2UnauthorizedError` 同理，**必须继承 `ApiError`**：
 * 裸 Error 冒泡到 index.ts 兜底会被统一回成 500「服务器内部错误」，
 * 把一个「改密码就能解决」的问题呈现成「代码坏了」。
 */
export class Q2UnauthorizedError extends ApiError {
  constructor(message = "Qoder2API 网关拒绝了本站的面板密码，请联系管理员检查「捐献通道」里的配置") {
    super(502, message, "QODER2API_UNAUTHORIZED")
    this.name = "Q2UnauthorizedError"
  }
}

/** 上游的结构化业务错误（保留原始 message 供调用方判断） */
export class Q2UpstreamError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message)
    this.name = "Q2UpstreamError"
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

interface Q2ErrorBody {
  error?: { message?: string; type?: string; code?: number }
}

/** 解析上游错误体里的 message（拿不到就给空串） */
function upstreamMessage(text: string): string {
  try {
    const body = JSON.parse(text) as Q2ErrorBody
    return body?.error?.message ?? ""
  } catch {
    return ""
  }
}

/** 探测一个地址的面板密码是否可用（不读缓存、不落库） */
async function probePanelLogin(
  baseUrl: string,
  password: string
): Promise<{ ok: boolean; token: string; message: string; status: number }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(`${baseUrl}/panel/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ password }),
      signal: controller.signal,
      redirect: "follow",
    })
    const text = await res.text()
    if (res.ok) {
      let token = ""
      try {
        token = (JSON.parse(text) as { token?: string }).token ?? ""
      } catch {
        /* 解析失败按无效处理 */
      }
      if (!token) return { ok: false, token: "", message: "网关未返回会话令牌", status: res.status }
      return { ok: true, token, message: "", status: res.status }
    }
    return {
      ok: false,
      token: "",
      message: upstreamMessage(text) || `HTTP ${res.status}`,
      status: res.status,
    }
  } catch (err) {
    return {
      ok: false,
      token: "",
      message: err instanceof Error && err.name === "AbortError" ? "探测超时" : "无法连接网关",
      status: 0,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 拿到（并缓存）面板会话 token。`force` 时忽略缓存强制重登一次。 */
async function getPanelToken(cfg: Qoder2ApiConfig, force = false): Promise<string> {
  const now = Date.now()
  if (
    !force &&
    sessionCache &&
    sessionCache.baseUrl === cfg.baseUrl &&
    now - sessionCache.at < SESSION_CACHE_MS
  ) {
    return sessionCache.token
  }
  if (!cfg.panelPassword) {
    throw new ApiError(503, "Qoder2API 通道未配置面板密码", "QODER2API_NOT_CONFIGURED")
  }
  const res = await probePanelLogin(cfg.baseUrl, cfg.panelPassword)
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Q2UnauthorizedError(
        `Qoder2API 面板密码无效（${res.message}），请到「捐献通道」重新填写`
      )
    }
    if (res.status === 429) {
      throw new ApiError(429, "Qoder2API 登录尝试过于频繁，请稍后重试", "QODER2API_RATE_LIMITED")
    }
    throw new ApiError(502, `无法登录 Qoder2API 面板：${res.message}`, "QODER2API_UNREACHABLE")
  }
  sessionCache = { at: now, baseUrl: cfg.baseUrl, token: res.token }
  return res.token
}

/**
 * 统一出站封装：拼 URL、注入面板会话、限时、限体积、错误映射。
 * 成功返回解析后的 JSON（上游没有统一信封，成功时直接是数据本体）。
 *
 * 401/403 会**自动重登一次**再重试（会话是内存态的，上游重启后就失效了）；
 * 已经重试过还是 401 才抛 `Q2UnauthorizedError`（那说明密码本身不对）。
 */
async function q2Fetch<T>(
  env: Env,
  path: string,
  init: RequestInit = {},
  timeoutMs: number = FETCH_TIMEOUT_MS,
  retried = false
): Promise<T> {
  const cfg = await resolveQoder2ApiConfig(env)
  const token = await getPanelToken(cfg)

  const headers = new Headers(init.headers)
  headers.set("X-Panel-Token", token)
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
    if (controller.signal.aborted) {
      throw new ApiError(
        504,
        `Qoder2API 响应超时（${Math.round(timeoutMs / 1000)} 秒）`,
        "QODER2API_TIMEOUT"
      )
    }
    const msg = err instanceof Error ? err.message : String(err)
    throw new ApiError(502, `无法连接 Qoder2API 网关（${msg}）`, "QODER2API_UNREACHABLE")
  } finally {
    clearTimeout(timer)
  }

  const buf = await res.arrayBuffer()
  if (buf.byteLength > MAX_FETCH_BYTES) {
    throw new ApiError(502, "Qoder2API 返回内容过大", "QODER2API_UPSTREAM_ERROR")
  }
  const text = new TextDecoder("utf-8").decode(buf)

  if (res.status === 401 || res.status === 403) {
    if (!retried) {
      // 面板会话是内存态的：上游重启后本地缓存即失效。丢掉重登一次再说。
      invalidateSession()
      return q2Fetch<T>(env, path, init, timeoutMs, true)
    }
    throw new Q2UnauthorizedError()
  }
  if (res.status === 404) {
    // 上游对「未知 state / 不存在的路径」都回 404；由调用方按上下文区分
    throw new Q2UpstreamError(upstreamMessage(text) || "上游返回 404", 404)
  }
  if (!res.ok) {
    throw new ApiError(
      502,
      `Qoder2API 返回 ${res.status}`,
      "QODER2API_UPSTREAM_ERROR"
    )
  }

  if (!text) return {} as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ApiError(502, "Qoder2API 返回了非 JSON 内容", "QODER2API_UPSTREAM_ERROR")
  }
}

// ---------------------------------------------------------------------------
// 业务接口（路径与字段都已对线上实例核实）
// ---------------------------------------------------------------------------

export interface Q2Account {
  uid: string
  nickname: string
  realm: string
  enabled: boolean
  source?: string
  credits?: number | null
  plan?: string | null
  expiresAt?: number | null
}

/** 账号列表里我们只关心这几项，其余字段原样丢弃（别把上游全量结构泄到前端） */
function toPublicAccount(raw: unknown): Q2Account | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const uid = String(r.uid ?? "").trim()
  if (!uid) return null
  return {
    uid,
    nickname: String(r.nickname ?? "").trim() || uid.slice(0, 8),
    realm: normalizeRealm(r.realm),
    enabled: r.enabled !== false,
    source: typeof r.source === "string" ? r.source : undefined,
    credits: typeof r.credits === "number" ? r.credits : null,
    plan: typeof r.plan === "string" ? r.plan : null,
    expiresAt: typeof r.expiresAt === "number" ? r.expiresAt : null,
  }
}

/**
 * 发起设备授权登录。⚠️ 返回的 `state` 是**换绑凭据**，
 * 绝不能下发给前端（否则他人可抢先 poll 把账号据为己有）；只留在本站会话表里。
 */
export async function q2StartLogin(
  env: Env,
  realm: Qoder2ApiRealm
): Promise<{ state: string; authUrl: string; realm: Qoder2ApiRealm }> {
  const data = await q2Fetch<{ state?: string; authUrl?: string; realm?: string }>(
    env,
    "/accounts/login/start",
    { method: "POST", body: JSON.stringify({ platform: "CLI", realm }) }
  )
  const state = (data.state ?? "").trim()
  const authUrl = (data.authUrl ?? "").trim()
  if (!state || !authUrl) {
    throw new ApiError(502, "Qoder2API 未返回授权链接", "QODER2API_BAD_RESPONSE")
  }
  return { state, authUrl, realm: normalizeRealm(data.realm ?? realm) }
}

export interface Q2PollResult {
  status: "pending" | "done" | "failed"
  message: string
  account?: Q2Account
}

/**
 * 轮询登录结果（已归一化）。
 *
 * 上游 status ∈ `pending | ok | expired | unknown | error`：
 *   - `ok`      ⇒ done（带 account）
 *   - `pending` ⇒ pending（继续轮）
 *   - 其余      ⇒ failed（会话没了/上游报错），文案区分「过期」与「失效」
 */
export async function q2PollLogin(env: Env, state: string): Promise<Q2PollResult> {
  const data = await q2Fetch<{ status?: string; message?: string; account?: unknown }>(
    env,
    `/accounts/login/poll?state=${encodeURIComponent(state)}`,
    { method: "GET" },
    POLL_TIMEOUT_MS
  )
  const raw = (data.status ?? "").trim().toLowerCase()
  if (raw === "ok") {
    const account = toPublicAccount(data.account)
    if (!account) {
      throw new ApiError(502, "Qoder2API 登录成功但未返回账号信息", "QODER2API_BAD_RESPONSE")
    }
    return { status: "done", message: "", account }
  }
  if (raw === "pending") {
    return { status: "pending", message: data.message || "等待浏览器完成 Qoder 设备授权" }
  }
  if (raw === "expired") {
    return { status: "failed", message: "授权窗口已过期（10 分钟），请重新发起" }
  }
  if (raw === "unknown") {
    return { status: "failed", message: "授权会话已失效，请重新发起" }
  }
  return { status: "failed", message: data.message || "上游登录失败，请重新发起" }
}

/** 取消一次未完成的登录（拿不到授权链接、用户中途放弃时收尾） */
export async function q2CancelLogin(env: Env, state: string): Promise<void> {
  await q2Fetch<unknown>(env, "/accounts/login/cancel", {
    method: "POST",
    body: JSON.stringify({ state }),
  })
}

/**
 * 列出上游账号池。
 * ⚠️ 上游 `GET /accounts` 默认只列**当前面板区域**的账号，所以要分区各拉一次再合并，
 * 否则管理端会「看不到另一个区捐的号」。
 */
export async function q2ListAccounts(env: Env): Promise<Q2Account[]> {
  const out: Q2Account[] = []
  for (const realm of QODER2API_REALMS) {
    try {
      const data = await q2Fetch<{ accounts?: unknown[] }>(
        env,
        `/accounts?realm=${realm}`,
        { method: "GET" }
      )
      for (const raw of data.accounts ?? []) {
        const acc = toPublicAccount(raw)
        if (acc) out.push(acc)
      }
    } catch (err) {
      // 单个区域失败不影响另一个（比如某区面板配置缺失）
      if (realm === QODER2API_REALMS[0]) throw err
      console.error(`列出 Qoder2API ${realm} 区账号失败:`, err)
    }
  }
  return out
}

/** 解绑：从上游池子删掉账号。账号已不在池里视为成功（幂等）。 */
export async function q2DeleteAccount(env: Env, uid: string): Promise<void> {
  try {
    await q2Fetch<{ deleted?: boolean }>(env, "/accounts/delete", {
      method: "POST",
      body: JSON.stringify({ uid }),
    })
  } catch (err) {
    if (err instanceof Q2UpstreamError && err.status === 404) return
    throw err
  }
}

// ---------------------------------------------------------------------------
// 凭据校验 / 保存（管理端）
// ---------------------------------------------------------------------------

/** 用给定密码真探测一次面板登录：能换到 token 即视为有效 */
export async function verifyQoder2ApiPassword(
  env: Env,
  password: string
): Promise<{ ok: boolean; message: string }> {
  const cfg = await resolveQoder2ApiConfig(env)
  const res = await probePanelLogin(cfg.baseUrl, password.trim())
  if (res.ok) return { ok: true, message: "" }
  return { ok: false, message: res.message }
}

/** 校验通过后加密落库，并让本进程立即用新密码 */
export async function saveQoder2ApiPassword(env: Env, password: string): Promise<void> {
  const trimmed = password.trim()
  if (!trimmed) throw new ApiError(400, "面板密码不能为空", "INVALID_INPUT")
  if (!env.SESSION_SECRET) {
    throw new ApiError(500, "缺少 SESSION_SECRET，无法加密保存凭据", "NOT_CONFIGURED")
  }
  const probe = await verifyQoder2ApiPassword(env, trimmed)
  if (!probe.ok) {
    throw new ApiError(400, `面板密码校验失败：${probe.message}`, "INVALID_CREDENTIAL")
  }
  const enc = await encryptSecret(trimmed, env.SESSION_SECRET)
  await env.DB.prepare(
    `INSERT INTO qoder2api_credentials (id, enc_panel_password, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET enc_panel_password = excluded.enc_panel_password, updated_at = excluded.updated_at`
  )
    .bind(enc, new Date().toISOString())
    .run()
  resetQoder2ApiCache()
}

/** 当前凭据来源与掩码（供管理端显示） */
export async function getQoder2ApiCredentialInfo(env: Env): Promise<{
  source: Qoder2ApiCredentialSource
  masked: string | null
  updatedAt: string | null
}> {
  const cfg = await resolveQoder2ApiConfig(env)
  if (cfg.source !== "db" || !cfg.panelPassword) {
    return {
      source: cfg.source,
      masked: cfg.panelPassword ? maskPanelPassword(cfg.panelPassword) : null,
      updatedAt: null,
    }
  }
  const row = await env.DB.prepare("SELECT updated_at FROM qoder2api_credentials WHERE id = 1")
    .first<{ updated_at: string }>()
  return {
    source: "db",
    masked: maskPanelPassword(cfg.panelPassword),
    updatedAt: row?.updated_at ?? null,
  }
}
