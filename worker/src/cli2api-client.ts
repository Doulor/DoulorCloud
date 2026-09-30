/**
 * CLI2API 网关（https://github.com/caigee-cmd/cli2api）客户端。
 *
 * 与 wb2api-client.ts 是**并行的第二条同类通道**：同样做「捐献即解锁 AI 权限」，
 * 但接口形态完全不同，故独立实现（硬抽象成一套反而两边都难改）。
 *
 * 实测定下来的事实（2026-09-26 对着线上实例逐条验证）：
 *   1. **所有 `/api/*` 都需要 `Authorization: Bearer <console key>`**。
 *      注意 console key 是该实例的**管理员密钥**（不是给客户端用的 API key），
 *      泄露 = 整个账号池被拿走。本站加密落库、绝不下发前端。
 *   2. 响应没有统一信封：成功时直接是数据对象；失败时是
 *      `{"error":{"code","message","type"}}`，HTTP 状态码即语义。
 *   3. 登录是**三步**，不像 wb2api 一步 start：
 *        a) `POST /api/accounts` 建一个 `enabled: true` 的账号 → `acc_xxx`
 *        b) `POST /api/accounts/{id}/login/device` → `{authUrl, status, message}`
 *        c) `GET  /api/accounts/{id}/login/status` → `{login:{status,message,authUrl}}`
 *      ⚠️ 必须 (a) 里就 enabled，且等 worker 进程起来，(b) 才有响应；
 *      否则返回 `account_not_running`（实测）。
 *      ⚠️ **上游 status 词表是 `ok` / `error`，不是 `done` / `failed`**（2026-09-28 对线上实例核实；
 *      上游源码 `qoder.LoginCompleteAuthType` 判的也是 `Login.Status != "ok"`）。
 *      成功时 message 为英文 `"login completed"`，失败时如
 *      `"Device flow timed out after 5 minutes. Please try again."`。
 *      ⇒ 本客户端统一归一化成 `pending|done|failed` 再交给上层（见 `normalizeLoginStatus`）。
 *   4. `authUrl` 指向上游自己的登录页（如 `qoder.cn/device/selectAccounts`），
 *      其 `oauth_callback` 也指回上游自己的 device 页，授权结果按 `machine_id`
 *      关联回 cli2api 的 worker —— **不需要回调本站，也不需要用户粘贴回调 URL**。
 *      因此这条通道对远程用户天然可用（上游的 `login/callback` 兜底用不上）。
 *   5. 解绑 = `DELETE /api/accounts/{id}`（真删，不是标记）。
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
/** 响应体上限：返回的都是小 JSON（账号列表稍大），1 MiB 足够 */
const MAX_FETCH_BYTES = 1024 * 1024
const CREDENTIAL_CACHE_MS = 5000

/** 默认站点地址（设置项 cli2api_base_url 未配置时用） */
const DEFAULT_BASE_URL = "https://cli2api.doulor.cn"

export type Cli2ApiCredentialSource = "db" | "env" | "none"

let credentialCache: {
  at: number
  baseUrl: string
  consoleKey: string | null
  source: Cli2ApiCredentialSource
} | null = null

/** 解析网关地址与 console key（baseUrl 优先设置项，consoleKey 优先 D1 加密行） */
export async function resolveCli2ApiConfig(env: Env): Promise<{
  baseUrl: string
  consoleKey: string | null
  source: Cli2ApiCredentialSource
}> {
  const now = Date.now()
  if (credentialCache && now - credentialCache.at < CREDENTIAL_CACHE_MS) {
    return credentialCache
  }

  let baseUrl = DEFAULT_BASE_URL
  try {
    const fromSetting = (await getSetting(env, "cli2api_base_url")).trim()
    if (fromSetting) baseUrl = fromSetting
  } catch (err) {
    console.error("读取 cli2api_base_url 失败，用默认值:", err)
  }
  if (!baseUrl) baseUrl = env.CLI2API_BASE_URL?.trim() || DEFAULT_BASE_URL
  baseUrl = baseUrl.replace(/\/+$/, "")

  let consoleKey: string | null = env.CLI2API_CONSOLE_KEY?.trim() || null
  let source: Cli2ApiCredentialSource = consoleKey ? "env" : "none"

  // 库里的凭据用 SESSION_SECRET 派生的密钥加密；缺密钥则只能用 env
  if (env.SESSION_SECRET) {
    try {
      const row = await env.DB.prepare(
        "SELECT enc_console_key FROM cli2api_credentials WHERE id = 1"
      ).first<{ enc_console_key: string }>()
      if (row) {
        consoleKey = await decryptSecret(row.enc_console_key, env.SESSION_SECRET)
        source = "db"
      }
    } catch (err) {
      // 解密失败（如 SESSION_SECRET 换过）不应让捐献页整体挂掉，回落到 env
      console.error("读取 cli2api console key 失败，回落到环境变量:", err)
    }
  }

  credentialCache = { at: now, baseUrl, consoleKey, source }
  return credentialCache
}

/** 是否已配置（地址恒有默认值，故只看 console key） */
export async function isCli2ApiConfigured(env: Env): Promise<boolean> {
  return Boolean((await resolveCli2ApiConfig(env)).consoleKey)
}

function invalidateCli2ApiCache(): void {
  credentialCache = null
}

/** 强制下次重新解析凭据（写入路径已自动调用；导出供测试直接改库后立即感知） */
export function resetCli2ApiCache(): void {
  invalidateCli2ApiCache()
}

/** 掩码展示：<前4>****<后4> */
export function maskConsoleKey(key: string): string {
  if (key.length <= 8) return "*".repeat(Math.max(key.length, 4))
  return `${key.slice(0, 4)}${"*".repeat(8)}${key.slice(-4)}`
}

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

/** console key 无效（401/403） */
export class Cli2UnauthorizedError extends Error {}
/** 账号不存在（404），多数场景等于「目标状态已达成」 */
export class Cli2NotFoundError extends Error {}
/**
 * 上游的结构化业务错误（保留 `code` 供调用方判断）。
 * 典型：`account_not_running`（账号未启用或 worker 还没起来）。
 */
export class Cli2UpstreamError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number
  ) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

interface Cli2ErrorBody {
  error?: { code?: string; message?: string; type?: string }
}

/**
 * 统一出站封装：拼 URL、注入鉴权、限时、限体积、错误映射。
 * 成功返回解析后的 JSON（cli2api 没有统一信封，成功时直接是数据本体）。
 */
async function cli2Fetch<T>(
  env: Env,
  path: string,
  init: RequestInit = {},
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<T> {
  const cfg = await resolveCli2ApiConfig(env)
  if (!cfg.consoleKey) {
    throw new ApiError(503, "CLI2API 通道未配置", "CLI2API_NOT_CONFIGURED")
  }

  const headers = new Headers(init.headers)
  headers.set("Authorization", `Bearer ${cfg.consoleKey}`)
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
    if (err instanceof Error && err.name === "AbortError") {
      throw new ApiError(504, "CLI2API 响应超时，请稍后重试", "CLI2API_TIMEOUT")
    }
    throw new ApiError(502, "无法连接 CLI2API 网关", "CLI2API_UNREACHABLE")
  } finally {
    clearTimeout(timer)
  }

  const text = await res.text()
  if (text.length > MAX_FETCH_BYTES) {
    throw new ApiError(502, "CLI2API 返回内容过大", "CLI2API_UPSTREAM_ERROR")
  }

  if (!res.ok) {
    let code = ""
    let message = ""
    try {
      const body = JSON.parse(text) as Cli2ErrorBody
      code = body?.error?.code ?? ""
      message = body?.error?.message ?? ""
    } catch {
      // 非 JSON 错误体：保留状态码信息即可
    }
    if (res.status === 401 || res.status === 403) {
      throw new Cli2UnauthorizedError(message || "CLI2API console key 无效")
    }
    if (res.status === 404) {
      throw new Cli2NotFoundError(message || "CLI2API 账号不存在")
    }
    throw new Cli2UpstreamError(
      code,
      message || `CLI2API 返回 ${res.status}`,
      res.status
    )
  }

  if (!text) return {} as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ApiError(502, "CLI2API 返回了非 JSON 内容", "CLI2API_UPSTREAM_ERROR")
  }
}

// ---------------------------------------------------------------------------
// 业务接口（路径与字段都已对线上实例核实）
// ---------------------------------------------------------------------------

export interface Cli2Account {
  id: string
  name: string
  provider: string
  region: string
  enabled: boolean
  status?: string
  ready?: boolean
  nickname?: string
  auth_type?: string
}

/**
 * 创建账号。⚠️ 必须 `enabled: true` —— cli2api 为账号起独立 worker 进程，
 * 登录动作（login/device）由那个进程处理；账号未启用会直接返回
 * `account_not_running`（实测）。
 */
export async function cli2CreateAccount(
  env: Env,
  input: { name: string; provider: string; region: string; enabled?: boolean }
): Promise<Cli2Account> {
  return cli2Fetch<Cli2Account>(env, "/api/accounts", {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      provider: input.provider,
      region: input.region,
      enabled: input.enabled ?? true,
    }),
  })
}

/** 触发登录，返回授权链接。账号 worker 没起来时抛 Cli2UpstreamError(code=account_not_running)。 */
export async function cli2StartLogin(
  env: Env,
  accountId: string
): Promise<{ authUrl: string; status: string; message: string }> {
  const data = await cli2Fetch<{ authUrl?: string; status?: string; message?: string }>(
    env,
    `/api/accounts/${encodeURIComponent(accountId)}/login/device`,
    { method: "POST", body: JSON.stringify({}) }
  )
  return {
    authUrl: data.authUrl ?? "",
    status: data.status ?? "pending",
    message: data.message ?? "",
  }
}

/**
 * 上游登录状态 → 本站统一状态（`pending|done|failed`）。
 *
 * ⚠️ 上游用的是 `ok` / `error`（2026-09-28 对线上实例核实）。早先按 `done` / `failed` 实现，
 * 结果**登录成功被判成 pending**：界面永远停在「login completed」转圈，15 分钟后会话过期，
 * 而上游账号其实已经建好并登录成功（池子里多了号、本站却没有绑定）。
 * 这里归一化，并顺带容忍上游换成其它同义词；**认不出的一律当 pending**（继续轮询，最坏退化到会话过期）。
 */
const LOGIN_DONE_STATUSES = new Set(["ok", "done", "success", "succeeded", "complete", "completed"])
const LOGIN_FAILED_STATUSES = new Set(["error", "failed", "failure", "expired", "timeout", "timed_out"])

export function normalizeLoginStatus(raw: string | null | undefined): "pending" | "done" | "failed" {
  const s = (raw ?? "").trim().toLowerCase()
  if (LOGIN_DONE_STATUSES.has(s)) return "done"
  if (LOGIN_FAILED_STATUSES.has(s)) return "failed"
  return "pending"
}

/** 上游 message 多为英文，翻成能直接给用户看的中文（认不出的原样返回） */
function humanizeLoginMessage(raw: string | null | undefined): string {
  const m = (raw ?? "").trim()
  if (!m) return ""
  if (/device flow timed out/i.test(m)) return "设备授权超时（未在 5 分钟内完成），请重新发起"
  if (/^login completed\.?$/i.test(m)) return "登录已完成"
  if (/account is disabled or not running/i.test(m)) return "上游账号未运行，请重新发起"
  return m
}

/** 轮询登录状态。返回值 status ∈ pending | done | failed（已归一化） */
export async function cli2PollLogin(
  env: Env,
  accountId: string
): Promise<{ status: "pending" | "done" | "failed"; message: string; authUrl: string }> {
  const data = await cli2Fetch<{
    login?: { status?: string; message?: string; authUrl?: string }
  }>(env, `/api/accounts/${encodeURIComponent(accountId)}/login/status`, { method: "GET" })
  return {
    status: normalizeLoginStatus(data.login?.status),
    message: humanizeLoginMessage(data.login?.message),
    authUrl: data.login?.authUrl ?? "",
  }
}

/** 解绑：真删上游账号。404 视为「已经是目标状态」。 */
export async function cli2DeleteAccount(env: Env, accountId: string): Promise<void> {
  try {
    await cli2Fetch<unknown>(env, `/api/accounts/${encodeURIComponent(accountId)}`, {
      method: "DELETE",
    })
  } catch (err) {
    if (err instanceof Cli2NotFoundError) return
    throw err
  }
}

/** 列出全部账号（管理端展示池子形态用） */
export async function cli2ListAccounts(env: Env): Promise<Cli2Account[]> {
  const data = await cli2Fetch<{ data?: Cli2Account[] }>(env, "/api/accounts", {
    method: "GET",
  })
  return data.data ?? []
}

// ---------------------------------------------------------------------------
// 凭据校验 / 保存（管理端）
// ---------------------------------------------------------------------------

/** 用给定 key 探测 `/api/overview`：能通即视为有效 */
export async function verifyCli2ApiConsoleKey(
  env: Env,
  key: string
): Promise<{ ok: boolean; message: string }> {
  const cfg = await resolveCli2ApiConfig(env)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(`${cfg.baseUrl}/api/overview`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key.trim()}`, Accept: "application/json" },
      signal: controller.signal,
      redirect: "follow",
    })
    if (res.ok) return { ok: true, message: "" }
    let message = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as Cli2ErrorBody
      message = body?.error?.message ?? message
    } catch {
      // 忽略解析失败
    }
    return { ok: false, message }
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error && err.name === "AbortError" ? "探测超时" : "无法连接网关",
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 校验通过后加密落库，并让本进程立即用新 key */
export async function saveCli2ApiConsoleKey(env: Env, key: string): Promise<void> {
  const trimmed = key.trim()
  if (!trimmed) throw new ApiError(400, "console key 不能为空", "INVALID_INPUT")
  if (!env.SESSION_SECRET) {
    throw new ApiError(500, "缺少 SESSION_SECRET，无法加密保存凭据", "NOT_CONFIGURED")
  }
  const probe = await verifyCli2ApiConsoleKey(env, trimmed)
  if (!probe.ok) {
    throw new ApiError(400, `console key 校验失败：${probe.message}`, "INVALID_CREDENTIAL")
  }
  const enc = await encryptSecret(trimmed, env.SESSION_SECRET)
  await env.DB.prepare(
    `INSERT INTO cli2api_credentials (id, enc_console_key, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET enc_console_key = excluded.enc_console_key, updated_at = excluded.updated_at`
  )
    .bind(enc, new Date().toISOString())
    .run()
  invalidateCli2ApiCache()
}

/** 当前凭据来源与掩码（供管理端显示） */
export async function getCli2ApiCredentialInfo(env: Env): Promise<{
  source: Cli2ApiCredentialSource
  masked: string | null
  updatedAt: string | null
}> {
  const cfg = await resolveCli2ApiConfig(env)
  if (cfg.source !== "db" || !cfg.consoleKey) {
    return { source: cfg.source, masked: cfg.consoleKey ? maskConsoleKey(cfg.consoleKey) : null, updatedAt: null }
  }
  const row = await env.DB.prepare("SELECT updated_at FROM cli2api_credentials WHERE id = 1")
    .first<{ updated_at: string }>()
  return {
    source: "db",
    masked: maskConsoleKey(cfg.consoleKey),
    updatedAt: row?.updated_at ?? null,
  }
}
