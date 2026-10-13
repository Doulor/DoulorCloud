/**
 * 「中转站」只读适配器（2026-10-12）。
 *
 * 两种站点（NewAPI / Sub2API）用**同一套视图**回答同一个问题：
 * 「这个人在这台站的余额和订阅是什么？」——**只读**，不改任何上游数据。
 *
 * 接口来源（2026-10-12 读源码核实的，不是猜的）：
 *   · NewAPI：`GET /api/user/search?keyword=<邮箱>`（Bearer 管理员令牌）
 *             `GET /api/subscription/admin/users/:id/subscriptions`（订阅，私有接口）
 *             `GET /api/status`（公开，`quota_per_unit` 把 quota 换算成站点展示金额）
 *   · Sub2API（github.com/Wei-Shaw/sub2api，Go+Gin）：`x-api-key: admin-xxx` 鉴权，
 *             `GET /api/v1/admin/users?search=<邮箱>&include_subscriptions=true`
 *             用户对象自带 `balance`（美元）与 `subscriptions[]`，一次就够。
 *             ⚠️ 它的分页响应是 `{code,message,data:{items,total,page,page_size,pages}}`。
 *
 * 🔴 两条铁律（2026-10-12 那次「页面很卡」事故后定的）：
 *   1. **每次上游调用都必须带超时** —— 这些站会慢到几十秒（实测我们的 NewAPI
 *      单程 1.4~27.8s），不能让页面挂住；超时就当作「暂时读不到」。
 *   2. 结果按 (站点, 邮箱) 加 TTL 缓存 —— 卡片是「看一眼」的信息，不必秒级新鲜。
 */
import type { Env } from "./env"

export type RelayKind = "newapi" | "sub2api"

export const RELAY_KINDS: readonly RelayKind[] = ["newapi", "sub2api"]

/** 上游调用超时（毫秒）。朋友站可能比我们还慢，给到 6 秒已经很宽容。 */
const UPSTREAM_TIMEOUT_MS = 6000

/** 视图缓存 TTL：同一张卡片反复刷新/多标签页不该反复打上游 */
const VIEW_TTL_MS = 60_000

export interface RelaySubView {
  /** 展示名（套餐名；取不到时降级成「套餐 #id」） */
  title: string
  /** 已用量（站点展示货币单位）；读不到给 null */
  used: number | null
  /** 总额度（同上）；Sub2API 的订阅不含总额度，给 null */
  total: number | null
  /** 到期时间（unix 秒）；null = 未知或不过期 */
  expiresAt: number | null
}

export interface RelayUserView {
  /** 上游有没有这个邮箱对应的账号 */
  found: boolean
  /** 上游侧展示名（用户名或邮箱） */
  displayName: string | null
  /** 钱包余额（站点展示货币；Sub2API 本身就是美元） */
  balance: number | null
  /** 货币符号（¥ / $） */
  currencySymbol: string
  /** 余额换算率（NewAPI 的 quota_per_unit；Sub2API 恒 1） */
  perUnit: number
  subscriptions: RelaySubView[]
  /** 站点是否读得到（false = 网络/鉴权失败 ⇒ 卡片要显示「暂时读不到」，不能说「没有账号」） */
  reachable: boolean
  /** reachable=false 时给用户看的简短原因 */
  error?: string
}

/** 上游读不到时的统一形状（**不能**把失败当成「没有账号」） */
function unreachable(error: string, currencySymbol = "$"): RelayUserView {
  return {
    found: false,
    displayName: null,
    balance: null,
    currencySymbol,
    perUnit: 1,
    subscriptions: [],
    reachable: false,
    error,
  }
}

/** 带超时的 JSON 请求；非 2xx 直接抛（外层统一转成「读不到」） */
async function fetchJson(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<Record<string, unknown>> {
  const { timeoutMs = UPSTREAM_TIMEOUT_MS, ...rest } = init
  const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) })
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`上游返回的不是 JSON（HTTP ${res.status}）`)
  }
  if (!res.ok) {
    const msg =
      (body as { message?: string } | null)?.message || `HTTP ${res.status}`
    throw new Error(String(msg).slice(0, 120))
  }
  return (body ?? {}) as Record<string, unknown>
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "")
}

// ---------------------------------------------------------------- NewAPI

interface NewApiUserRow {
  id?: number
  username?: string
  email?: string
  quota?: number
  used_quota?: number
  DeletedAt?: string | null
}

async function fetchNewApiView(
  baseUrl: string,
  token: string,
  email: string
): Promise<RelayUserView> {
  const base = trimBase(baseUrl)
  const auth = { Authorization: `Bearer ${token}` }

  // 1) 找账号：按邮箱搜（NewAPI 的 search 同时匹配用户名/邮箱）
  const found = await fetchJson(
    `${base}/api/user/search?keyword=${encodeURIComponent(email)}`,
    { headers: auth }
  )
  const data = found.data as NewApiUserRow[] | { items?: NewApiUserRow[] } | undefined
  const list: NewApiUserRow[] = Array.isArray(data)
    ? data
    : Array.isArray(data?.items)
      ? data.items
      : []
  const user =
    list.find((u) => String(u.email ?? "").toLowerCase() === email.toLowerCase()) ??
    (list.length === 1 ? list[0] : null)

  if (!user || user.DeletedAt) {
    return {
      found: false,
      displayName: null,
      balance: null,
      currencySymbol: "¥",
      perUnit: 1,
      subscriptions: [],
      reachable: true,
    }
  }

  // 2) 站点币种与换算率（公开接口，无鉴权）
  let symbol = "¥"
  let perUnit = 500000
  try {
    const status = await fetchJson(`${base}/api/status`, { timeoutMs: 3000 })
    const s = (status.data ?? status) as Record<string, unknown>
    const code = String(s.quota_display_type ?? "USD").toUpperCase()
    symbol = code === "CNY" ? "¥" : "$"
    perUnit = Number(s.quota_per_unit) || 500000
  } catch {
    // 读不到就按 500000/¥ 兜底：金额可能不准，但卡片仍能显示订阅
  }

  // 3) 订阅（私有接口）+ 套餐名（取不到就降级成「套餐 #id」）
  const subs: RelaySubView[] = []
  try {
    const [subRes, planRes] = await Promise.all([
      fetchJson(`${base}/api/subscription/admin/users/${user.id}/subscriptions`, {
        headers: auth,
      }),
      fetchJson(`${base}/api/subscription/plans`, { headers: auth }).catch(() => null),
    ])
    const titles = new Map<number, string>()
    const planData = planRes?.data as { plan?: Record<string, unknown> }[] | undefined
    for (const p of Array.isArray(planData) ? planData : []) {
      const plan = p.plan
      if (plan) titles.set(Number(plan.id ?? 0), String(plan.title ?? ""))
    }
    const subData = subRes.data as { subscription?: Record<string, unknown> }[] | undefined
    for (const item of Array.isArray(subData) ? subData : []) {
      const s = item.subscription
      if (!s) continue
      if (String(s.status ?? "") !== "active") continue
      const planId = Number(s.plan_id ?? 0)
      subs.push({
        title: titles.get(planId) || `套餐 #${planId}`,
        used: Number(s.amount_used ?? 0),
        total: Number(s.amount_total ?? 0),
        expiresAt: Number(s.end_time ?? 0) || null,
      })
    }
  } catch {
    // 订阅读不到不算失败：余额还能显示，卡片上订阅区留空即可
  }

  return {
    found: true,
    displayName: String(user.username ?? "") || null,
    balance: Number(user.quota ?? 0) / perUnit,
    currencySymbol: symbol,
    perUnit,
    subscriptions: subs,
    reachable: true,
  }
}

// ---------------------------------------------------------------- Sub2API

interface Sub2ApiUserRow {
  id?: number
  email?: string
  username?: string
  balance?: number
  status?: string
  deleted_at?: string | null
  subscriptions?: {
    id?: number
    status?: string
    expires_at?: string | number | null
    daily_usage_usd?: number
    monthly_usage_usd?: number
    group?: { name?: string } | null
  }[]
}

async function fetchSub2ApiView(
  baseUrl: string,
  token: string,
  email: string
): Promise<RelayUserView> {
  const base = trimBase(baseUrl)
  const qs = new URLSearchParams({
    page: "1",
    page_size: "20",
    search: email,
    include_subscriptions: "true",
  })
  const res = await fetchJson(`${base}/api/v1/admin/users?${qs.toString()}`, {
    headers: { "x-api-key": token },
  })
  // 分页外壳：{code, message, data:{items, total, page, page_size, pages}}
  const payload = res.data as { items?: Sub2ApiUserRow[] } | undefined
  const items = Array.isArray(payload?.items) ? payload.items : []
  const user =
    items.find((u) => String(u.email ?? "").toLowerCase() === email.toLowerCase()) ?? null

  if (!user || user.deleted_at) {
    return {
      found: false,
      displayName: null,
      balance: null,
      currencySymbol: "$",
      perUnit: 1,
      subscriptions: [],
      reachable: true,
    }
  }

  const subs: RelaySubView[] = []
  for (const s of user.subscriptions ?? []) {
    if (String(s.status ?? "") !== "active") continue
    subs.push({
      title: s.group?.name || "订阅",
      used: typeof s.monthly_usage_usd === "number" ? s.monthly_usage_usd : null,
      // Sub2API 的订阅额度由分组限制决定，用户对象里不带总额度
      total: null,
      expiresAt: toUnixSeconds(s.expires_at),
    })
  }

  return {
    found: true,
    displayName: String(user.username ?? user.email ?? "") || null,
    // Sub2API 的 balance 本身就是美元，不需要换算
    balance: typeof user.balance === "number" ? user.balance : null,
    currencySymbol: "$",
    perUnit: 1,
    subscriptions: subs,
    reachable: true,
  }
}

/** Sub2API 的时间字段可能是 RFC3339 字符串，也可能是 unix 秒；统一成秒 */
function toUnixSeconds(v: string | number | null | undefined): number | null {
  if (v == null) return null
  if (typeof v === "number") return v > 1e12 ? Math.floor(v / 1000) : v
  const t = Date.parse(v)
  return Number.isFinite(t) ? Math.floor(t / 1000) : null
}

// ---------------------------------------------------------------- Key 列表 / 可用模型

export interface RelayKeyRow {
  name: string
  /** 打码后的 Key（上游给的就是打码值；拿不到明文） */
  keyMasked: string
  group: string | null
  createdAt: string | null
}

export interface RelayKeysResult {
  /** 这台站能不能用我们的管理员令牌列出**该用户**的 Key */
  supported: boolean
  keys: RelayKeyRow[]
  /** supported=false 时给用户看的原因 */
  detail?: string
}

/**
 * 读某人在某台站的 Key 列表。
 *
 * ⚠️ 支持度不一样（2026-10-12 读源码核实）：
 *   · **Sub2API**：管理员接口 `GET /api/v1/admin/users/:id/api-keys` ⇒ 能读 ✓
 *   · **NewAPI**：Key 管理接口是**用户维度**的（要本人令牌），管理员令牌读不到别人的 token
 *     ⇒ 明确返回 supported:false，界面照实说明「要去对方站自己看」，
 *     而不是给个空列表让人以为「没有 Key」。
 */
export async function fetchRelayKeys(
  kind: RelayKind,
  baseUrl: string,
  adminToken: string,
  email: string
): Promise<RelayKeysResult> {
  const base = trimBase(baseUrl)
  if (kind !== "sub2api") {
    return {
      supported: false,
      keys: [],
      detail: "NewAPI 的 Key 属于用户维度，管理员令牌读不到别人的 Key（请到对方站查看）",
    }
  }
  try {
    // 先按邮箱定位用户（复用同一个列表接口）
    const qs = new URLSearchParams({ page: "1", page_size: "20", search: email })
    const found = await fetchJson(`${base}/api/v1/admin/users?${qs.toString()}`, {
      headers: { "x-api-key": adminToken },
    })
    const items = ((found.data as { items?: { id?: number; email?: string }[] } | undefined)?.items ??
      []) as { id?: number; email?: string }[]
    const user = items.find((u) => String(u.email ?? "").toLowerCase() === email.toLowerCase())
    if (!user?.id) return { supported: true, keys: [] }

    const res = await fetchJson(`${base}/api/v1/admin/users/${user.id}/api-keys`, {
      headers: { "x-api-key": adminToken },
    })
    // 可能是 {data:[...]} 或 {data:{items:[...]}}
    const d = res.data as unknown
    const list: Record<string, unknown>[] = Array.isArray(d)
      ? (d as Record<string, unknown>[])
      : Array.isArray((d as { items?: unknown[] })?.items)
        ? ((d as { items: Record<string, unknown>[] }).items)
        : []
    return {
      supported: true,
      keys: list.map((k) => ({
        name: String(k.name ?? "—"),
        keyMasked: String(k.key ?? k.key_masked ?? "—"),
        group: (k.group as { name?: string } | undefined)?.name ?? null,
        createdAt: k.created_at ? String(k.created_at) : null,
      })),
    }
  } catch (err) {
    return {
      supported: false,
      keys: [],
      detail: `读不到该站的 Key 列表：${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * 读某台站的可用模型清单。
 *
 * · NewAPI：`GET /api/models`（公开接口）✓
 * · Sub2API：模型广场（公开接口，路径在不同版本间有差异）—— 读不到就返回空并说明，
 *   不让界面看起来像「这台站没有模型」。
 */
export async function fetchRelayModels(
  kind: RelayKind,
  baseUrl: string
): Promise<{ models: string[]; detail?: string }> {
  const base = trimBase(baseUrl)
  try {
    if (kind === "sub2api") {
      // 它的公开模型接口随版本变化：两种常见路径都试一下
      for (const path of ["/api/v1/model-plaza/models", "/api/v1/models"]) {
        try {
          const res = await fetchJson(`${base}${path}`, { timeoutMs: 4000 })
          const d = res.data as unknown
          const arr = Array.isArray(d) ? d : ((d as { items?: unknown[] })?.items ?? [])
          if (Array.isArray(arr) && arr.length > 0) {
            return {
              models: arr
                .map((m) =>
                  typeof m === "string"
                    ? m
                    : String((m as { name?: string; model?: string })?.name ??
                        (m as { model?: string })?.model ??
                        "")
                )
                .filter(Boolean),
            }
          }
        } catch {
          // 换下一个路径
        }
      }
      return { models: [], detail: "该站的模型清单接口读不到（不同版本路径不同）" }
    }
    const res = await fetchJson(`${base}/api/models`, { timeoutMs: 4000 })
    const d = res.data as unknown
    const arr = Array.isArray(d) ? d : ((d as { items?: unknown[] })?.items ?? [])
    return { models: Array.isArray(arr) ? arr.map((m) => String(m)) : [] }
  } catch (err) {
    return { models: [], detail: `读不到模型清单：${err instanceof Error ? err.message : String(err)}` }
  }
}

// ---------------------------------------------------------------- OIDC 前置检测

/**
 * 入驻的**前提**：对方站必须已经配好「用 Doulor Cloud 登录」的 OIDC
 * （2026-10-12 站长要求 + 自动检测）。
 *
 * 为什么必须卡这条：入驻的价值就是「用户用本站身份在他那台站里登录、有账号」。
 * 没配 OIDC 的话，用户在那边根本没有账号，卡片永远显示「查无此人」，
 * 排障成本全落在站长身上 —— 不如在登记那一刻就告诉朋友「去把 OIDC 配好」。
 *
 * 检测方式是**读对方站自己声明的配置**，不是问用户：
 *   · NewAPI：`GET /api/option/`（管理员令牌）里的 `oidc.*` 选项组；
 *   · Sub2API：直接打它的 OIDC 登录入口 `/api/v1/auth/oauth/oidc/start`，
 *     看它把用户往哪跳 —— 跳向我们就是配好了。
 * 两者都要求**指向本站**（不能是 LinuxDo / GitHub 之类别的 IdP）。
 */
export interface RelayOidcCheck {
  /** 是否允许入驻 */
  ok: boolean
  /**
   * 是否**真的**自动确认了（读到对方站的配置并判断出指向本站）。
   *
   * false = 检测不到（对方开了登录验证码 / 接口报错 / 版本差异）——
   * 这种情况**放行但带警告**：宁可让朋友入驻、事后在卡片上提示，
   * 也不能因为「我们读不到」就把他挡在门外（2026-10-12 站长朋友 linhuai
   * 就是这么被误判的）。
   */
  verified: boolean
  /** 给登记人看的人话（ok=false 说缺什么；ok && !verified 说为什么没验成） */
  detail: string
  /** 检测到的 IdP 主机（用于展示） */
  idpHost?: string
}

/** 本站作为身份提供方的规范 origin（与 worker/src/handlers/oauth.ts 的 oauthBase 对齐） */
function ourIssuerOrigins(env: Env): string[] {
  const out = new Set<string>()
  const configured = env.OAUTH_ISSUER_ORIGIN?.trim()
  if (configured) out.add(configured.replace(/\/+$/, "").toLowerCase())
  const root = (env.ROOT_DOMAIN ?? "doulor.cn").toLowerCase().replace(/\.+$/, "")
  out.add(`https://cloud.${root}`)
  out.add(`https://${root}`)
  return [...out]
}

/** 这个地址是不是指向本站（用于判断对方 OIDC 配的是不是我们） */
function pointsAtUs(raw: string, origins: string[]): string | null {
  const v = String(raw ?? "").trim().toLowerCase()
  if (!v) return null
  for (const origin of origins) {
    const host = origin.replace(/^https?:\/\//, "")
    if (v.startsWith(origin) || v.includes(host)) return host
  }
  return null
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).host
  } catch {
    return String(raw || "").slice(0, 60)
  }
}

/** NewAPI：读 `/api/option/` 的 `oidc.*` 选项组 */
async function checkNewApiOidc(
  env: Env,
  baseUrl: string,
  adminToken: string
): Promise<RelayOidcCheck> {
  const base = trimBase(baseUrl)
  const origins = ourIssuerOrigins(env)
  const res = await fetchJson(`${base}/api/option/`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })
  const list = (Array.isArray(res.data) ? res.data : []) as { key?: string; value?: unknown }[]
  const opt = new Map<string, string>()
  for (const it of list) if (it?.key) opt.set(String(it.key), String(it.value ?? ""))

  const enabled = ["true", "1", "yes"].includes((opt.get("oidc.enabled") ?? "").toLowerCase())
  if (!enabled) {
    return {
      ok: false,
      verified: true,
      detail:
        "对方站的 NewAPI 还没开启 OIDC 登录（系统设置 → OIDC 登录：打开开关并填好 Client ID 与端点）",
    }
  }
  const endpoints = [
    opt.get("oidc.authorization_endpoint") ?? "",
    opt.get("oidc.token_endpoint") ?? "",
    opt.get("oidc.user_info_endpoint") ?? "",
    opt.get("oidc.well_known") ?? "",
  ].filter(Boolean)
  if (endpoints.length === 0) {
    return {
      ok: false,
      verified: true,
      detail: "NewAPI 开了 OIDC 开关，但端点（Authorization / Token）还没填",
    }
  }
  if (!(opt.get("oidc.client_id") ?? "").trim()) {
    return { ok: false, verified: true, detail: "NewAPI 的 OIDC 还缺 Client ID" }
  }
  for (const ep of endpoints) {
    const host = pointsAtUs(ep, origins)
    if (host) return { ok: true, verified: true, detail: "OIDC 已指向本站", idpHost: host }
  }
  return {
    ok: false,
    verified: true,
    detail: `对方的 OIDC 指向的是 ${hostOf(endpoints[0])}，不是本站（要配成 Doulor Cloud 作为身份提供方）`,
  }
}

/**
 * Sub2API 的 OIDC 检测。
 *
 * ⚠️ 2026-10-12 踩过的两个坑（站长朋友 linhuai 因此被误判成「没配 OIDC」）：
 *   1. 它的 start 接口**先过验证码闸门**（`requireActionCaptchaForOAuthLoginStart`）——
 *      站里开了登录验证码时，无头的 GET/POST 会被拦下，返回一句 captcha 错误。
 *      这**不代表没配 OIDC**，只是我们读不到 ⇒ 必须当成「未验证」而不是「没配」。
 *   2. **GET 才 302、POST 返回 JSON**（`respondOAuthStart`：POST → `{data:{authorize_url}}`，
 *      GET → 302 Location）。只用一种方法探测会漏。
 *
 * 判定顺序：POST(JSON) → GET(302) → 兜底看错误文本。
 * 只有三种情况算「真的没配」：拿到了指向**别人**的授权地址 / 明说 OAUTH_DISABLED / 404 无此路由。
 */
async function checkSub2ApiOidc(env: Env, baseUrl: string): Promise<RelayOidcCheck> {
  const base = trimBase(baseUrl)
  const origins = ourIssuerOrigins(env)
  const startUrl = `${base}/api/v1/auth/oauth/oidc/start`

  /** 授权地址里若出现本站 ⇒ 配的就是我们 */
  const usIn = (text: string) => pointsAtUs(text.replace(/\\\//g, "/"), origins)
  /** 取文本里第一个看起来像 URL 的地址（用来告诉用户「你配的是谁」） */
  const firstUrl = (text: string) => {
    const m = text.replace(/\\\//g, "/").match(/https?:\/\/[^\s"'<>]+/)
    return m ? m[0] : ""
  }
  const inconclusive = (why: string): RelayOidcCheck => ({
    ok: true,
    verified: false,
    detail: `没能自动检测 OIDC（${why}）。请自行确认已把本站配成身份提供方。`,
  })

  // ---- ① POST：成功时返回 JSON `{data:{authorize_url}}` ----
  try {
    const res = await fetch(startUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    // 有的实现连 POST 也直接 302（Location 里就是授权地址）
    const postLocation = res.headers.get("location") ?? ""
    if (res.status >= 300 && res.status < 400 && postLocation) {
      const host = usIn(postLocation)
      if (host) return { ok: true, verified: true, detail: "OIDC 已指向本站", idpHost: host }
      return {
        ok: false,
        verified: true,
        detail: `对方的 OIDC 指向的是 ${hostOf(postLocation)}，不是本站（要配成 Doulor Cloud 作为身份提供方）`,
      }
    }
    const text = (await res.text().catch(() => "")).slice(0, 2000)
    type StartPayload = { data?: { authorize_url?: string }; authorize_url?: string }
    let payload: StartPayload | null = null
    try {
      payload = JSON.parse(text) as StartPayload
    } catch {
      payload = null
    }
    const authUrl = String(payload?.data?.authorize_url ?? payload?.authorize_url ?? "")
    if (authUrl) {
      const host = usIn(authUrl)
      if (host) return { ok: true, verified: true, detail: "OIDC 已指向本站", idpHost: host }
      return {
        ok: false,
        verified: true,
        detail: `对方的 OIDC 指向的是 ${hostOf(authUrl)}，不是本站（要配成 Doulor Cloud 作为身份提供方）`,
      }
    }
    // 验证码拦截：读不到结论，但不等于没配
    if (/captcha|turnstile|verify|人机|验证码|ticket/i.test(text)) {
      return inconclusive("对方站开了登录验证码，探测被拦下")
    }
    if (res.status === 404 || res.status === 405) {
      // ④ 这条路由不存在 / 不接受 POST ⇒ 试 GET（老版本只有 GET）
      const viaGet = await askSub2ApiViaGet(startUrl, origins)
      if (viaGet) return viaGet
    }
    if (/OAUTH_DISABLED|oauth login is disabled|not enabled|未启用|已关闭/i.test(text)) {
      return {
        ok: false,
        verified: true,
        detail: "对方的 Sub2API 还没启用 OIDC 登录（后台 → 登录方式：启用 OIDC）",
      }
    }
    const host = usIn(text)
    if (host) return { ok: true, verified: true, detail: "OIDC 已指向本站", idpHost: host }
    const other = firstUrl(text)
    if (other) {
      return {
        ok: false,
        verified: true,
        detail: `对方的 OIDC 指向的是 ${hostOf(other)}，不是本站（要配成 Doulor Cloud 作为身份提供方）`,
      }
    }
    return inconclusive(res.status >= 500 ? `对方站报错 HTTP ${res.status}` : `对方返回 HTTP ${res.status}`)
  } catch (err) {
    return inconclusive(err instanceof Error ? err.message : String(err))
  }
}

/** GET 版探测：成功时是 302，授权地址在 Location 里；返回 null = 拿不到结论 */
async function askSub2ApiViaGet(
  startUrl: string,
  origins: string[]
): Promise<RelayOidcCheck | null> {
  try {
    const res = await fetch(startUrl, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    const location = res.headers.get("location") ?? ""
    if (res.status >= 300 && res.status < 400 && location) {
      const host = pointsAtUs(location, origins)
      if (host) return { ok: true, verified: true, detail: "OIDC 已指向本站", idpHost: host }
      return {
        ok: false,
        verified: true,
        detail: `对方的 OIDC 指向的是 ${hostOf(location)}，不是本站（要配成 Doulor Cloud 作为身份提供方）`,
      }
    }
    if (res.status === 404) {
      return { ok: false, verified: true, detail: "该站的 Sub2API 版本还不支持 OIDC 登录（请先升级）" }
    }
    return null
  } catch {
    return null
  }
}

/** 入驻前的 OIDC 检测（永不抛错：读不到就给出「读不到」的理由） */
export async function checkRelayOidc(
  env: Env,
  kind: RelayKind,
  baseUrl: string,
  adminToken: string
): Promise<RelayOidcCheck> {
  try {
    return kind === "sub2api"
      ? await checkSub2ApiOidc(env, baseUrl)
      : await checkNewApiOidc(env, baseUrl, adminToken)
  } catch (err) {
    // NewAPI 读 `/api/option/` 失败（网络/权限/版本差异）：同样按「未验证」放行带警告
    return {
      ok: true,
      verified: false,
      detail: `没能自动检测 OIDC（读不到对方站的选项接口：${
        err instanceof Error ? err.message : String(err)
      }）。请自行确认已把本站配成身份提供方。`,
    }
  }
}

// ---------------------------------------------------------------- 对外入口

const viewCache = new Map<string, { at: number; value: RelayUserView }>()

/**
 * 令牌指纹（进缓存键用，不落日志）。
 * 目的只是「换令牌后旧缓存失效」，不需要密码学强度 —— 取长度 + 头尾各 4 字符即可。
 */
function fp(token: string): string {
  if (token.length < 12) return `n${token.length}`
  return `${token.length}:${token.slice(0, 4)}${token.slice(-4)}`
}

/**
 * 读「某人在某台中转站」的只读视图。**永不抛错** —— 读不到就返回 `reachable:false`
 * 加一句原因，让卡片如实显示「暂时读不到」，而不是把它伪装成「没有账号」。
 */
export async function fetchRelayUserView(
  kind: RelayKind,
  baseUrl: string,
  adminToken: string,
  email: string
): Promise<RelayUserView> {
  // ⚠️ 缓存键必须带**令牌指纹**：否则「换错令牌」会被上一次成功的结果掩盖
  // （探测通过、实际调用全 401），排查时极难看出。
  const key = `${kind}|${trimBase(baseUrl)}|${email.toLowerCase()}|${fp(adminToken)}`
  const hit = viewCache.get(key)
  if (hit && Date.now() - hit.at < VIEW_TTL_MS) return hit.value

  let value: RelayUserView
  try {
    value =
      kind === "sub2api"
        ? await fetchSub2ApiView(baseUrl, adminToken, email)
        : await fetchNewApiView(baseUrl, adminToken, email)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // 令牌被拒（401 / INVALID_ADMIN_KEY / Invalid token）时给出**可执行的**指引：
    // 光说「令牌无效」，用户不知道是自己填错了还是对方改了，也不知道该找谁。
    value = unreachable(
      /401|403|未授权|INVALID_ADMIN_KEY|Invalid admin API key|Invalid token|invalid/i.test(msg)
        ? `对方站拒绝了我们保存的管理员令牌（${msg}）。` +
            "通常是对面重新生成过令牌或站点重启换了密钥 —— 需要**登记人**在「邀请与捐献 → 中转站入驻」里" +
            "编辑这台站、重新粘贴当前令牌。"
        : `上游读不到：${msg}`,
      kind === "sub2api" ? "$" : "¥"
    )
  }
  viewCache.set(key, { at: Date.now(), value })
  return value
}

/** 管理端改配置后清缓存（否则最多 1 分钟里还显示旧站的结果） */
export function invalidateRelayViewCache(): void {
  viewCache.clear()
}

/** 兼容签名占位：适配器不读本地环境，保留参数是为了以后加「本站专属兜底」 */
export type RelayAdapterEnv = Env
