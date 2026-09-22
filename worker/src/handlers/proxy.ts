/**
 * 代理节点。
 *
 * 订阅链接模式：管理员在后台维护若干「订阅源」（proxy_subscriptions），
 * 每个源就是一个代理订阅地址（vless/vmess/trojan/ss 等）。Worker 在用户
 * 打开页面时 `fetch` 订阅 URL 并解析，返回给前端。
 *
 * 权限（2026-09-22 按用户要求）：**邀请码只控制「代理节点」功能权限**
 * （users.permissions.proxy）。有 proxy 权限的用户启用本功能后就能看到
 * 全部已启用的订阅源；**不做**按用户单独授权订阅源。
 *
 * 可做到 / 做不到的边界（与既有 frp 节点对比）：
 *   - ✅ 节点列表、协议、地区、当前状态（管理员标记 + 探活）
 *   - ✅ 订阅链接复制、解析出的节点配置详情（地址/端口/UUID/密码/SNI…）
 *   - ⚠️ 剩余流量 / 到期日：**依赖订阅源是否在响应里附带**
 *     （如 v2board 的 info 参数 / INFO= 行 / clash header），
 *     解析不到时该字段为 null，前端显示「未知」。
 *   - ⚠️ 延迟：Worker 侧只能对「订阅 URL 本身」做 HTTP 探活（Cloudflare
 *     出网限制无法对节点的任意 TCP/UDP 端口做真延迟测试），
 *     结果作为该订阅源的近似延迟。
 *
 * 所有接口先过 requireFeatureUser(env, request, "proxy")。
 */
import { ApiError, json } from "../http"
import { uuid } from "../crypto"
import { requireUser, requireFeatureUser, type UserRow } from "../auth"
import { audit, getSettings } from "../settings"
import type { Env } from "../env"

/** 用户「确认启用」时必须同意的协议版本。前端内嵌文本版本须与此一致。 */
export const PROXY_CONSENT_VERSION = 1

/** 抓取订阅源时的最大响应体（字节），防止把超大数据拖进 Worker 内存 */
const MAX_FETCH_BYTES = 5 * 1024 * 1024
/** 探活 / 抓取超时（毫秒） */
const FETCH_TIMEOUT_MS = 8000

interface ProxySubscriptionRow {
  id: string
  name: string
  region: string | null
  url: string
  protocol: string
  status: string
  status_note: string | null
  enabled: number
  sort_order: number
  note: string | null
  last_synced_at: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}

/** 解析后的单个代理节点 */
export interface ProxyNodeInfo {
  name: string
  /** vless / vmess / trojan / ss / unknown */
  protocol: string
  server: string
  port: number | null
  /** 从节点名末尾提取的地区；解析不到为 null */
  region: string | null
  /** 用户可直接复制到客户端的原始节点链接 */
  raw: string
  /** 解析出的配置字段（uuid / password / security / sni / flow / obfs…） */
  details: Record<string, string>
}

function toPublicSubscription(row: ProxySubscriptionRow) {
  return {
    id: row.id,
    name: row.name,
    region: row.region,
    url: row.url,
    protocol: row.protocol,
    status: row.status,
    statusNote: row.status_note,
    note: row.note,
    lastSyncedAt: row.last_synced_at,
  }
}

/** 该用户是否已启用本功能 */
async function isActivated(env: Env, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT enabled FROM proxy_activation WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ enabled: number }>()
  return row?.enabled === 1
}

/** 该用户可见的订阅源：全部已启用的（enabled=1），不做按用户授权 */
async function visibleSubscriptions(env: Env): Promise<ProxySubscriptionRow[]> {
  const rows = await env.DB.prepare(
    "SELECT * FROM proxy_subscriptions WHERE enabled = 1 ORDER BY sort_order ASC, created_at ASC"
  ).all<ProxySubscriptionRow>()
  return rows.results ?? []
}

// ---- 抓取订阅源 ----

/** 抓取订阅 URL 的原始文本（带 Authorization Bearer；超时保护） */
async function fetchSubscriptionText(
  env: Env,
  url: string
): Promise<{ text: string; ok: boolean; status: number }> {
  const headers: Record<string, string> = {
    "User-Agent": "DoulorCloud/1.0",
  }
  if (env.PROXY_API_TOKEN) {
    headers.Authorization = `Bearer ${env.PROXY_API_TOKEN}`
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
      redirect: "follow",
    })
    if (!res.ok) {
      return { text: "", ok: false, status: res.status }
    }
    const buf = await res.arrayBuffer()
    if (buf.byteLength > MAX_FETCH_BYTES) {
      return { text: "", ok: false, status: 413 }
    }
    // 按 UTF-8 解码（节点配置基本是纯 ASCII + base64，用 utf-8 足够）
    const text = new TextDecoder("utf-8").decode(buf)
    return { text, ok: true, status: res.status }
  } finally {
    clearTimeout(timer)
  }
}

/** 对订阅 URL 做探活，返回近似延迟（毫秒），失败返回 null */
async function probeSubscriptionUrl(
  env: Env,
  url: string
): Promise<{ latencyMs: number | null; ok: boolean; message?: string }> {
  const start = Date.now()
  try {
    const { ok, status } = await fetchSubscriptionText(env, url)
    const latencyMs = Date.now() - start
    if (!ok) {
      return {
        latencyMs: null,
        ok: false,
        message: status === 413 ? "响应体过大" : `订阅地址返回 HTTP ${status}`,
      }
    }
    return { latencyMs, ok: true }
  } catch (err) {
    return {
      latencyMs: null,
      ok: false,
      message:
        err instanceof Error && err.name === "AbortError"
          ? "请求超时"
          : err instanceof Error
            ? err.message
            : "请求失败",
    }
  }
}

// ---- 订阅解析 ----

/** 从 node 链接解析 vless/vmess/trojan/ss；解析不到则返回 unknown */
function parseNodeLink(raw: string): {
  protocol: string
  server: string
  port: number | null
  region: string | null
  details: Record<string, string>
} {
  const s = raw.trim()
  const fallback = {
    protocol: "unknown",
    server: "",
    port: null as number | null,
    region: null as string | null,
    details: {} as Record<string, string>,
  }

  // 1) vmess：base64(JSON)
  if (s.startsWith("vmess://")) {
    try {
      const json = atob(s.slice("vmess://".length))
      const obj = JSON.parse(json) as Record<string, string>
      const port = Number(obj.port)
      return {
        protocol: "vmess",
        server: obj.add ?? "",
        port: Number.isFinite(port) && port > 0 ? port : null,
        region: regionFromName(obj.ps ?? ""),
        details: {
          name: obj.ps ?? "",
          uuid: obj.id ?? "",
          alterId: obj.aid ?? "",
          security: obj.scy ?? "",
          network: obj.net ?? "",
          tls: obj.tls ?? "",
        },
      }
    } catch {
      return { ...fallback, protocol: "vmess" }
    }
  }

  // 2) vless / trojan / ss：scheme://uuidOrPassword@host:port#name?params
  const schemeMatch = s.match(/^(vless|trojan|ss):\/\//)
  if (schemeMatch) {
    const scheme = schemeMatch[1]
    const rest = s.slice(schemeMatch[0].length)
    const hashIdx = rest.indexOf("#")
    const namePart = hashIdx >= 0 ? rest.slice(hashIdx + 1) : ""
    const urlPart = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest
    const queryIdx = urlPart.indexOf("?")
    const authority = queryIdx >= 0 ? urlPart.slice(0, queryIdx) : urlPart
    const query = queryIdx >= 0 ? urlPart.slice(queryIdx + 1) : ""

    const atIdx = authority.lastIndexOf("@")
    const hostPort = atIdx >= 0 ? authority.slice(atIdx + 1) : authority
    const cred = atIdx >= 0 ? authority.slice(0, atIdx) : ""

    const host = hostPort.includes(":") ? hostPort.slice(0, hostPort.lastIndexOf(":")) : hostPort
    const portStr = hostPort.includes(":") ? hostPort.slice(hostPort.lastIndexOf(":") + 1) : ""
    const port = Number(portStr)

    const params: Record<string, string> = {}
    for (const kv of query.split("&")) {
      const [k, ...v] = kv.split("=")
      if (k) params[k] = decodeURIComponent(v.join("="))
    }

    return {
      protocol: scheme,
      server: host,
      port: Number.isFinite(port) && port > 0 ? port : null,
      region: regionFromName(decodeURIComponent(namePart)),
      details: {
        name: decodeURIComponent(namePart),
        ...(scheme === "vless" ? { uuid: cred, flow: params.flow ?? "" } : {}),
        ...(scheme === "trojan" ? { password: cred } : {}),
        ...(scheme === "ss" ? { password: cred, method: params.method ?? "" } : {}),
        ...(params.sni ? { sni: params.sni } : {}),
        ...(params.security ? { security: params.security } : {}),
        ...(params.type ? { network: params.type } : {}),
        ...(params.obfs ? { obfs: params.obfs } : {}),
        ...(params.headerType ? { headerType: params.headerType } : {}),
      },
    }
  }

  // 3) 无法识别：整行原样展示
  return fallback
}

/** 从节点名提取地区（优先识别常见 emoji 与两字母地区码/中文地名） */
function regionFromName(name: string): string | null {
  const n = name.trim()
  if (!n) return null

  // emoji 旗帜或常见地区 emoji
  const flagMatch = n.match(/([\u{1F1E6}-\u{1F1FF}]{2}|\u{1F30F}|\u{1F310})/u)
  if (flagMatch) {
    const flag = flagMatch[1]
    if (flag.length === 4) {
      // 两字母地区码（emoji 旗 = 两个区域指示符字母）
      const letters = [...flag].map((c) => c.codePointAt(0)! - 0x1f1e6 + 65)
      const code = String.fromCharCode(...letters)
      return code
    }
    return flag
  }

  // 常见中文/英文地区词
  const match = n.match(
    /(香港|台湾|台湾省|澳门|美国|日本|韩国|新加坡|英国|德国|法国|加拿大|澳大利亚|俄罗斯|中国|Russia|Japan|Singapore|Korea|Taiwan|Hong\s?Kong|US|USA|UK|SG|HK|TW|JP)/i
  )
  if (match) return match[1]
  return null
}

/**
 * 解析订阅文本 → 节点数组。
 * 支持整体 base64（v2board 常见）与逐行 node 链接。
 */
function parseSubscription(text: string): ProxyNodeInfo[] {
  const trimmed = text.trim()
  if (!trimmed) return []

  const nodes: ProxyNodeInfo[] = []

  const tryDecode = (input: string): string | null => {
    const clean = input.replace(/\s/g, "")
    if (!/^[A-Za-z0-9+/=]+$/.test(clean) || clean.length < 8) return null
    try {
      const decoded = atob(clean)
      // 只有解码后看起来像节点列表才接受
      if (/vless|vmess|trojan|ss|ssr/i.test(decoded)) return decoded
      return null
    } catch {
      return null
    }
  }

  const decodedWhole = tryDecode(trimmed)
  const source = decodedWhole ?? trimmed

  for (const line of source.split(/\r?\n/)) {
    const l = line.trim()
    if (!l || l.startsWith("#") || l.startsWith("//")) continue
    for (const chunk of l.split(/\s+/)) {
      const c = chunk.trim()
      if (!c) continue
      const parsed = parseNodeLink(c)
      const name = parsed.details?.name ?? c.slice(0, 40)
      nodes.push({
        name: name || c.slice(0, 40),
        protocol: parsed.protocol,
        server: parsed.server,
        port: parsed.port,
        region: parsed.region,
        raw: c,
        details: parsed.details,
      })
    }
  }
  return nodes
}

/** 从订阅文本里尽量提取「剩余流量 / 到期日」（info 参数 / INFO= 行） */
function extractUsageInfo(text: string): {
  used: string | null
  total: string | null
  expire: string | null
} {
  let info: string | null = null

  const infoParam = text.match(/[?&]info\s*=\s*([^&\s]+)/)
  if (infoParam) {
    try {
      info = atob(infoParam[1].replace(/-/g, "+").replace(/_/g, "/"))
    } catch {
      info = null
    }
  }
  if (!info) {
    const line = text.split(/\r?\n/).find((l) => l.startsWith("INFO=") || l.startsWith("info="))
    if (line) info = line.slice(line.indexOf("=") + 1)
  }

  const result = { used: null as string | null, total: null as string | null, expire: null as string | null }
  if (!info) return result

  const usedMatch = info.match(/已用[:：]\s*([\d.]+)\s*([KMGTP]?B)/i)
  if (usedMatch) result.used = `${usedMatch[1]}${usedMatch[2]}`

  const totalMatch = info.match(/(?:总量|套餐|总流量)[:：]?\s*([\d.]+)\s*([KMGTP]?B)/i)
  if (totalMatch) result.total = `${totalMatch[1]}${totalMatch[2]}`

  const remainMatch = info.match(/(?:剩余|余额)[:：]?\s*([\d.]+)\s*([KMGTP]?B)/i)
  if (remainMatch) result.total = result.total ?? `${remainMatch[1]}${remainMatch[2]}`

  const expireMatch = info.match(/(?:到期|有效期|过期)[:：]?\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2})/)
  if (expireMatch) result.expire = expireMatch[1]

  return result
}

/** 抓取单个订阅源并解析节点 + 用量信息 */
async function syncSubscription(
  env: Env,
  row: ProxySubscriptionRow
): Promise<{ nodes: ProxyNodeInfo[]; usage: { used: string | null; total: string | null; expire: string | null } }> {
  const { text, ok } = await fetchSubscriptionText(env, row.url)
  if (!ok) {
    throw new ApiError(502, "订阅地址无法访问", "PROXY_FETCH_FAILED")
  }
  const nodes = parseSubscription(text)
  const usage = extractUsageInfo(text)
  return { nodes, usage }
}

/**
 * 自动识别订阅源的协议、地区与当前状态（管理员无需手动选择）。
 * 协议：抓取订阅文本解析节点后按出现频次取最常见协议；
 * 地区：优先取订阅 URL 里的地区参数，其次取节点名里最常出现的地区；
 * 状态：订阅地址能抓到内容 → online，否则 → offline。
 * 识别失败（抓不到 / 压不出节点）时协议地区回落到 null，由管理员手填兜底；状态仍给出 online/offline。
 */
export async function detectSubscriptionProfile(
  env: Env,
  row: Pick<ProxySubscriptionRow, "id" | "url">
): Promise<{ protocol: string | null; region: string | null; ok: boolean }> {
  let text = ""
  let ok = false
  try {
    const res = await fetchSubscriptionText(env, row.url)
    if (res.ok) {
      text = res.text
      ok = true
    }
  } catch {
    // 网络错误 → ok=false，协议/地区未知，状态 offline
  }

  const nodes = ok ? parseSubscription(text) : []
  if (nodes.length === 0) {
    return { protocol: null, region: null, ok }
  }

  // 协议：最常见协议
  const counts: Record<string, number> = {}
  for (const n of nodes) counts[n.protocol] = (counts[n.protocol] ?? 0) + 1
  let protocol: string | null = null
  let best = 0
  for (const [p, c] of Object.entries(counts)) {
    if (c > best) {
      best = c
      protocol = p
    }
  }
  if (!protocol || protocol === "unknown") protocol = null

  // 地区：URL 里的地区参数优先（常见订阅系统的 region/loc 参数）
  let region: string | null = null
  try {
    const u = new URL(row.url)
    for (const key of ["region", "loc", "area"]) {
      const v = u.searchParams.get(key)
      if (v && v.trim()) {
        region = decodeURIComponent(v.trim()).slice(0, 40)
        break
      }
    }
  } catch {
    // 忽略 URL 解析失败
  }
  // URL 里没有 → 从节点名里出现的地区做统计：
  //   - 只有一种地区 → 用该地区
  //   - 出现多种地区（含「综合」）→ 显示「综合」
  if (!region) {
    const regionCounts: Record<string, number> = {}
    for (const n of nodes) {
      if (n.region) regionCounts[n.region] = (regionCounts[n.region] ?? 0) + 1
    }
    const distinct = Object.keys(regionCounts)
    if (distinct.length === 1) {
      region = distinct[0]
    } else if (distinct.length > 1) {
      region = "综合"
    }
  }

  return { protocol, region, ok }
}

// ---- 用户侧接口 ----

/** GET /api/proxy —— 总览：启用状态 + 可见订阅源 + 解析后的节点 */
export async function getProxyOverview(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "proxy")
  const settings = await getSettings(env)
  const activated = await isActivated(env, user.id)

  const rows = activated ? await visibleSubscriptions(env) : []

  const subscriptions = await Promise.all(
    rows.map(async (row) => {
      const base = toPublicSubscription(row)
      try {
        const { nodes, usage } = await syncSubscription(env, row)
        return { ...base, nodes, usage, fetchError: null as string | null }
      } catch (err) {
        return {
          ...base,
          nodes: [] as ProxyNodeInfo[],
          usage: { used: null, total: null, expire: null },
          fetchError: err instanceof ApiError ? err.message : "解析失败",
        }
      }
    })
  )

  let consentedVersion = 0
  if (activated) {
    const row = await env.DB.prepare(
      "SELECT consent_version FROM proxy_activation WHERE user_id = ?"
    )
      .bind(user.id)
      .first<{ consent_version: number }>()
    consentedVersion = row?.consent_version ?? 0
  }

  return json({
    featureEnabled: settings.proxy_enabled === "1",
    activated,
    /** 前端内嵌协议文本的版本；不一致时前端应提示用户重新确认 */
    consentVersion: PROXY_CONSENT_VERSION,
    /** 已同意的协议版本（enable 时写入） */
    consentedVersion,
    subscriptions,
  })
}

/**
 * POST /api/proxy/enable —— 启用（须同意使用协议）。
 * body: { consent: true, consentVersion: PROXY_CONSENT_VERSION }
 */
export async function enableProxy(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "proxy")
  const settings = await getSettings(env)
  if (settings.proxy_enabled !== "1") {
    throw new ApiError(403, "代理节点功能已关闭", "FEATURE_DISABLED")
  }

  const body = (await request.json().catch(() => ({}))) as {
    consent?: unknown
    consentVersion?: unknown
  }
  if (body.consent !== true) {
    throw new ApiError(400, "请先阅读并同意使用协议", "CONSENT_REQUIRED")
  }
  const version = Math.trunc(Number(body.consentVersion))
  if (version !== PROXY_CONSENT_VERSION) {
    throw new ApiError(400, "使用协议已更新，请阅读最新版本后重新同意", "CONSENT_VERSION_MISMATCH")
  }

  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO proxy_activation (user_id, enabled, consent_version, consented_at, created_at, updated_at)
     VALUES (?, 1, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       enabled = 1,
       consent_version = excluded.consent_version,
       consented_at = excluded.consented_at,
       updated_at = excluded.updated_at`
  )
    .bind(user.id, version, now, now, now)
    .run()

  await audit(env, user.id, "proxy.enable", `启用代理节点（协议版本 ${version}）`)
  return json({ activated: true })
}

/** POST /api/proxy/disable —— 关闭（保留启用记录，仅置 enabled=0） */
export async function disableProxy(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "proxy")
  await env.DB.prepare(
    "UPDATE proxy_activation SET enabled = 0, updated_at = ? WHERE user_id = ?"
  )
    .bind(new Date().toISOString(), user.id)
    .run()
  await audit(env, user.id, "proxy.disable", "关闭代理节点")
  return json({ activated: false })
}

/**
 * POST /api/proxy/check —— 对订阅源做探活（测延迟）。
 * body: { id }；只允许探活已启用的订阅源。
 */
export async function checkProxySubscription(env: Env, request: Request): Promise<Response> {
  await requireFeatureUser(env, request, "proxy")
  const body = (await request.json().catch(() => ({}))) as { id?: string }
  const id = body.id ?? ""

  const row = await env.DB.prepare(
    "SELECT * FROM proxy_subscriptions WHERE id = ? AND enabled = 1"
  )
    .bind(id)
    .first<ProxySubscriptionRow>()
  if (!row) throw new ApiError(404, "订阅源不存在或已停用", "NOT_FOUND")

  // 该用户是否可见此订阅源
  const visible = await visibleSubscriptions(env)
  if (!visible.some((v) => v.id === id)) {
    throw new ApiError(403, "无权访问该订阅源", "FORBIDDEN")
  }

  const result = await probeSubscriptionUrl(env, row.url)

  if (result.ok) {
    await env.DB.prepare(
      "UPDATE proxy_subscriptions SET last_synced_at = ?, last_error = NULL, updated_at = ? WHERE id = ?"
    )
      .bind(new Date().toISOString(), new Date().toISOString(), row.id)
      .run()
  }

  return json(result)
}

// ---- 管理端 ----

async function requireAdminUser(env: Env, request: Request): Promise<UserRow> {
  const user = await requireUser(env, request)
  if (user.role !== "admin") {
    throw new ApiError(403, "需要管理员权限", "FORBIDDEN")
  }
  return user
}

function toAdminSubscription(row: ProxySubscriptionRow) {
  return {
    ...toPublicSubscription(row),
    enabled: row.enabled === 1,
    lastError: row.last_error,
    lastSyncedAt: row.last_synced_at,
  }
}

/** GET /api/admin/proxy/subscriptions —— 订阅源列表（含停用的，供管理） */
export async function listProxySubscriptions(
  env: Env,
  request: Request
): Promise<Response> {
  await requireAdminUser(env, request)
  const rows = await env.DB.prepare(
    "SELECT * FROM proxy_subscriptions ORDER BY sort_order ASC, created_at ASC"
  ).all<ProxySubscriptionRow>()

  return json({
    subscriptions: (rows.results ?? []).map(toAdminSubscription),
  })
}

/** POST /api/admin/proxy/subscriptions —— 新建/更新订阅源 */
export async function upsertProxySubscription(
  env: Env,
  request: Request
): Promise<Response> {
  await requireAdminUser(env, request)
  const body = (await request.json()) as {
    id?: string
    name?: string
    region?: string
    url?: string
    protocol?: string
    status?: string
    statusNote?: string
    enabled?: boolean
    sortOrder?: number
    note?: string
  }

  const name = (body.name ?? "").trim()
  const url = (body.url ?? "").trim()
  if (!name) throw new ApiError(400, "请填写订阅源名称", "INVALID_INPUT")
  if (!url) throw new ApiError(400, "请填写订阅链接", "INVALID_INPUT")
  if (!/^https?:\/\//i.test(url)) {
    throw new ApiError(400, "订阅链接必须是 http/https 地址", "INVALID_INPUT")
  }

  // 自动识别：协议与地区交给 Worker 抓取订阅后推断。
  // 识别失败时回落到手填值 / 默认值。
  const auto = await detectSubscriptionProfile(env, { id: body.id ?? "", url })
  const now = new Date().toISOString()

  // 未显式传入协议/地区/状态时，用自动识别结果；识别失败回落到默认值
  const protocolInput = (body.protocol ?? "").trim()
  const regionInput = (body.region ?? "").trim()
  const statusInput = (body.status ?? "").trim()
  const values = {
    name,
    region: regionInput || auto.region || null,
    url,
    protocol: protocolInput.slice(0, 20) || auto.protocol || "mixed",
    status: ["online", "offline", "maintenance", "unknown"].includes(statusInput)
      ? statusInput
      : auto.ok
        ? "online"
        : "offline",
    statusNote: (body.statusNote ?? "").trim() || null,
    enabled: body.enabled === false ? 0 : 1,
    sortOrder: Math.trunc(Number(body.sortOrder ?? 0)),
    note: (body.note ?? "").trim().slice(0, 500) || null,
  }

  if (body.id) {
    await env.DB.prepare(
      `UPDATE proxy_subscriptions SET name=?, region=?, url=?, protocol=?, status=?,
              status_note=?, enabled=?, sort_order=?, note=?, updated_at=?
        WHERE id=?`
    )
      .bind(
        values.name, values.region, values.url, values.protocol, values.status,
        values.statusNote, values.enabled, values.sortOrder, values.note, now, body.id
      )
      .run()
    const updated = await env.DB.prepare(
      "SELECT * FROM proxy_subscriptions WHERE id = ?"
    )
      .bind(body.id)
      .first<ProxySubscriptionRow>()
    return json({ subscription: toAdminSubscription(updated!) })
  }

  const id = uuid()
  await env.DB.prepare(
    `INSERT INTO proxy_subscriptions
       (id, name, region, url, protocol, status, status_note,
        enabled, sort_order, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id, values.name, values.region, values.url, values.protocol, values.status,
      values.statusNote, values.enabled, values.sortOrder, values.note, now, now
    )
    .run()

  const updated = await env.DB.prepare(
    "SELECT * FROM proxy_subscriptions WHERE id = ?"
  )
    .bind(id)
    .first<ProxySubscriptionRow>()
  return json({ subscription: toAdminSubscription(updated!) }, 201)
}

/** DELETE /api/admin/proxy/subscriptions/:id */
export async function deleteProxySubscription(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  await requireAdminUser(env, request)
  const existing = await env.DB.prepare(
    "SELECT id FROM proxy_subscriptions WHERE id = ?"
  )
    .bind(id)
    .first()
  if (!existing) throw new ApiError(404, "订阅源不存在", "NOT_FOUND")
  await env.DB.prepare("DELETE FROM proxy_subscriptions WHERE id = ?").bind(id).run()
  return new Response(null, { status: 204 })
}