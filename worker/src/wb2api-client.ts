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
export const POLL_TIMEOUT_MS = 30_000
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
const DEFAULT_BASE_URL = "https://agent2api.doulor.cn"

/**
 * 入池网关（2026-10-27 迁移）。
 *
 * 老的 workbuddy2api 服务（wb2api.doulor.cn → 127.0.0.1:7863）已退役，
 * 所有反代账号现在统一进 Agent2API。站点不再直连面板，而是走 hk2 上那个
 * 只暴露 /register /import /remove /status 的网关（X-Donate-Key 鉴权）——
 * 好处是面板密码只存在网关那一侧，Worker 里只有一把捐献密钥。
 */
const DONATE_GATEWAY = "https://agent2api.doulor.cn/_donate"

async function donateFetch<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const key = env.RACCOON_DONATE_KEY
  if (!key) throw new Error("入池网关密钥未配置（RACCOON_DONATE_KEY）")
  const res = await fetch(`${DONATE_GATEWAY}${path}`, {
    ...init,
    headers: {
      "X-Donate-Key": key,
      "content-type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  })
  const text = await res.text()
  if (!res.ok) {
    if (res.status === 401) throw new Wb2UnauthorizedError("入池网关密钥不正确")
    throw new Error(`入池网关 ${res.status}: ${text.slice(0, 200)}`)
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`入池网关返回非 JSON: ${text.slice(0, 200)}`)
  }
}

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

/**
 * 上游返回「state 未知或已过期」（网关 poll 成功一次后 state 即被删除）。
 *
 * ⚠️ 继承 `ApiError` 的理由见下面 `Wb2UnauthorizedError` 的注释 —— 这两个类
 * 原先都是裸 `Error`，冒泡到 `index.ts` 的兜底就会被统一回成
 * **500「服务器内部错误」**，把真实原因彻底藏住。
 */
export class Wb2StateGoneError extends ApiError {
  /**
   * 网关的原始响应体（截断到 200 字）。
   *
   * **只允许写日志，绝不下发前端** —— 与 `wb2Fetch` 的口径一致：上游 body 可能
   * 带请求细节。所以它单独放一个字段，**不能**塞进 `message`，
   * 因为 `message` 会被 `index.ts` 原样回给用户。
   */
  readonly upstreamDetail: string

  constructor(upstreamDetail = "") {
    super(410, "授权会话已在网关侧失效，请重新发起授权", "WB2API_STATE_GONE")
    this.name = "Wb2StateGoneError"
    this.upstreamDetail = upstreamDetail.slice(0, 200)
  }
}

/**
 * 上游返回 401/403：本站配置的 api_key 错误，或已被轮换。
 *
 * ⚠️ **必须继承 `ApiError`，不能再退回裸 `Error`**（2026-10-01 站长反馈
 * 「捐献 workbuddy 反代节点显示内部错误」的成因）：
 * 那次网关侧 `config.json` 的 api_key 是 `hu182241764`，而本站库里存的是
 * `Hu182241764.`（首字母大小写 + 句尾多一点），网关回 401。
 * 但 `loginStart` 里**没有**捕获这个类，裸 Error 冒泡到 `index.ts` 的兜底，
 * 被回成 500「服务器内部错误」⇒ 一个「改密钥就能解决」的问题，
 * 被呈现成「代码坏了」，排查绕了一大圈。
 *
 * 现在它自带 502 + 可操作文案，前端直接原样显示。
 */
export class Wb2UnauthorizedError extends ApiError {
  constructor(
    message = "反代网关拒绝了本站的访问密钥，请联系管理员检查「捐献通道」里配置的网关密钥"
  ) {
    super(502, message, "WB2API_UNAUTHORIZED")
    this.name = "Wb2UnauthorizedError"
  }
}

/**
 * 发一次网关请求并解析信封。
 *
 * 错误信息一律不原样回显上游 body（网关的 401 文案里可能带请求细节），
 * 只按状态码给本站自己的文案，避免 api_key 相关线索泄露到前端。
 */
export async function wb2Fetch<T>(
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
    // 不传参 ⇒ 用类里的默认文案（带「去哪儿检查」的可操作提示）
    throw new Wb2UnauthorizedError()
  }
  if (res.status === 404) {
    // 网关对未知 state 回 404「unknown or expired state」；
    // 对不存在的账号路径也回 404 —— 两者由调用方按上下文区分。
    // 原始 body 进 upstreamDetail（只写日志），不下发前端。
    throw new Wb2StateGoneError(text)
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
export async function resolveRealm(env: Env): Promise<string> {
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
  /**
   * 2026-10-27：改走纯 Agent2API 的设备授权（面板 /api/session/login/start）。
   * WorkBuddy 这条**没有验证码**；拿到 authUrl 后用户去授权，站点轮询 wb2Poll。
   */
  const r = await donateFetch<{
    ok?: boolean
    authUrl?: string
    state?: string
    provider?: string
    edition?: string
  }>(env, "/login/start", {
    method: "POST",
    body: JSON.stringify({ provider: "workbuddy", realm: realm ?? undefined }),
  })
  if (!r.authUrl || !r.state) {
    throw new ApiError(502, "授权链接获取失败（上游没有返回 authUrl）", "WB2API_BAD_RESPONSE")
  }
  const ed = String(r.edition ?? realm ?? "cn").toLowerCase()
  return {
    url: r.authUrl,
    state: r.state,
    realm: ed === "global" || ed === "intl" ? "global" : "cn",
  } as Wb2StartResult
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
  const r = await donateFetch<{
    ok?: boolean
    status?: string
    message?: string
    account?: Record<string, unknown> | null
  }>(env, "/login/wait", { method: "POST", body: JSON.stringify({ state }) })

  if (r.status === "failed") {
    return { status: "failed", message: r.message ?? "授权失败或已过期" } as unknown as Wb2PollResult
  }
  if (r.status !== "done" || !r.account) {
    return { status: "pending", message: "" } as unknown as Wb2PollResult
  }
  const a = r.account as Record<string, unknown>
  const rawId = String(a.id ?? "")
  const uid = String(a.userId ?? "").trim() || rawId.replace(/^user-/, "")
  const ed = String(a.edition ?? a.editionLabel ?? "cn").toLowerCase()
  return {
    status: "done",
    message: "",
    account: {
      uid,
      nickname: String(a.displayName ?? a.name ?? uid).slice(0, 60),
      realm: ed.includes("global") || ed.includes("intl") ? "global" : "cn",
    },
  } as unknown as Wb2PollResult
}

// ---------------------------------------------------------------------------
// 账号运维（管理端）
// ---------------------------------------------------------------------------

/** 从网关共享池移除一个账号（摘掉捐献）。404（账号已不在池里）视为成功。 */
export async function wb2RemoveAccount(env: Env, uid: string): Promise<void> {
  // 面板 id = user-<uid>；账号已不在池里（not_found）也算成功
  await donateFetch(env, "/remove", {
    method: "POST",
    body: JSON.stringify({ id: `user-${uid}` }),
  })
}

export interface Wb2ImportResult {
  total?: number
  imported?: number
  skipped?: number
  errors?: string[]
}

/**
 * 上传一份 cockpit tools 导出的 JSON，批量导入账号到 Agent2API 池（2026-10-27 迁移）。
 *
 * 入参是由调用方筛过的候选项数组（`[{account:{uid,nickname},auth:{accessToken,refreshToken,realm}}]`）。
 * 按 `auth.realm` 分两组投递：`cn` → provider=workbuddy，`global` → provider=workbuddy-intl。
 * `uid` 走网关的 extra 透传，面板建号时是必填。
 */
export async function wb2ImportCockpit(
  env: Env,
  jsonText: string
): Promise<Wb2ImportResult> {
  let rows: unknown
  try {
    rows = JSON.parse(jsonText)
  } catch {
    throw new Error("账号 JSON 解析失败")
  }
  const list = (Array.isArray(rows) ? rows : [rows]) as Record<string, unknown>[]

  type Entry = { name: string; accessToken: string; refreshToken?: string; uid: string }
  const byProvider = new Map<string, Entry[]>()
  let total = 0

  for (const row of list) {
    const acc = (row.account ?? row) as Record<string, unknown>
    const auth = (row.auth ?? {}) as Record<string, unknown>
    const uid = String(acc.uid ?? row.uid ?? "").trim()
    const accessToken = String(auth.accessToken ?? row.accessToken ?? "").trim()
    const refreshToken = String(auth.refreshToken ?? row.refreshToken ?? "").trim()
    if (!uid || !accessToken) continue
    total++
    const realm = String(auth.realm ?? row.realm ?? "cn").toLowerCase()
    const provider = realm === "global" || realm === "intl" ? "workbuddy-intl" : "workbuddy"
    const name = String(acc.nickname ?? row.nickname ?? uid).slice(0, 60)
    const bucket = byProvider.get(provider) ?? []
    bucket.push({ name, accessToken, refreshToken: refreshToken || undefined, uid })
    byProvider.set(provider, bucket)
  }

  let imported = 0
  let skipped = 0
  const errors: string[] = []
  for (const [provider, accounts] of byProvider) {
    const r = await donateFetch<{
      ok?: boolean
      added?: number
      duplicate?: number
      failed?: number
      errors?: { name?: string; detail?: string }[]
    }>(env, "/import", { method: "POST", body: JSON.stringify({ provider, accounts }) })
    imported += Number(r.added ?? 0)
    skipped += Number(r.duplicate ?? 0)
    for (const e of r.errors ?? []) errors.push(`${e.name ?? "账号"}：${e.detail ?? "导入失败"}`)
    if (Number(r.failed ?? 0) > 0 && (r.errors?.length ?? 0) === 0) {
      errors.push(`${provider} 有 ${r.failed} 个账号导入失败`)
    }
  }

  return { total, imported, skipped, errors }
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
    /**
     * 2026-10-10：网关把「上游判定需要重新登录」的账号标为 disabled
     *（例如 `11140 request illegal` → "account banned by upstream …, re-login required"）。
     * 这类账号要通知捐献者重新登录，否则他一直以为自己贡献有效。
     */
    disabled?: boolean
    /** 仅 disabled 的账号有：禁用原因（运维可见，含原始错误码） */
    disabled_reason?: string
    /** 运维临时让位（与 disabled 正交，不影响账号健康） */
    paused?: boolean
  }[]
}

/**
 * 读取号池概览（2026-10-27 迁移：改用入池网关的 /status，它直连 Agent2API 面板）。
 *
 * 只统计 workbuddy / workbuddy-intl 两个 provider —— qoder / 小浣熊各有自己的入口。
 * `uid` 由面板 id（`user-<uuid>`）反推，和站点绑定表里的 uid 对齐。
 */
export async function wb2Overview(env: Env): Promise<Wb2PoolOverview> {
  const r = await donateFetch<{
    ok?: boolean
    accounts?: { id?: string; name?: string; provider?: string; available?: boolean; enabled?: boolean }[]
  }>(env, "/status", { method: "GET" })

  const accounts: Wb2PoolOverview["accounts"] = []
  for (const a of r.accounts ?? []) {
    const provider = String(a.provider ?? "")
    if (provider !== "workbuddy" && provider !== "workbuddy-intl") continue
    const uid = String(a.id ?? "").replace(/^user-/, "")
    if (!uid) continue
    const disabled = a.enabled === false
    accounts.push({
      uid,
      nickname: a.name,
      realm: provider === "workbuddy-intl" ? "global" : "cn",
      disabled,
      disabled_reason: disabled ? "账号在号池中不可用（可能被封禁或登录态失效）" : undefined,
    })
  }

  return {
    total: accounts.length,
    healthy: accounts.filter((a) => !a.disabled).length,
    cooling: 0,
    disabled: accounts.filter((a) => a.disabled).length,
    accounts,
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
 * 探测一次「反代账号池」是否正常（2026-10-27 迁移）。
 *
 * 老的 api_key 概念随 workbuddy2api 一起退役了 —— 现在只用站点自己的捐献网关密钥
 * 去问 /status，能拿到账号就说明链路通，顺带把池子规模回报给管理面板。
 * 入参 `apiKey` 保留只为不改调用方签名。
 */
export async function verifyWb2ApiKey(
  env: Env,
  _apiKey: string
): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await donateFetch<{
      ok?: boolean
      accounts?: { provider?: string; enabled?: boolean }[]
    }>(env, "/status", { method: "GET" })
    const all = r.accounts ?? []
    const wb = all.filter(
      (a) => a.provider === "workbuddy" || a.provider === "workbuddy-intl"
    )
    const live = wb.filter((a) => a.enabled !== false).length
    return {
      ok: wb.length > 0,
      message:
        wb.length === 0
          ? "入池网关已连通，但号池里没有 WorkBuddy 账号"
          : `入池网关连通：号池 ${wb.length} 个 WorkBuddy 账号，其中可用 ${live} 个`,
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "入池网关探测失败" }
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
