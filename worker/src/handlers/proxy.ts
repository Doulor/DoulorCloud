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
import { mapLimit } from "../async-utils"
import { assertPublicHttpUrl } from "../url-guard"
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

/**
 * 支持的节点协议 scheme（含别名）→ 归一化协议名。
 *
 * 别名必须归一：`hy2` 与 `hysteria2` 是同一种协议，若各记各的，同一份订阅里
 * 两种写法会被算成两个协议，`profileFromNodes` 取众数时票数被摊薄而选错。
 */
const NODE_SCHEMES: Record<string, string> = {
  vmess: "vmess",
  vless: "vless",
  trojan: "trojan",
  ss: "ss",
  ssr: "ssr",
  anytls: "anytls",
  hysteria: "hysteria",
  hysteria2: "hysteria2",
  hy2: "hysteria2",
  tuic: "tuic",
}

/** 全部 scheme 拼成的正则片段（长名在前，避免 `ss` 抢在 `ssr` 前面匹配） */
const SCHEME_ALT =
  "vmess|vless|trojan|ssr|ss|anytls|hysteria2|hysteria|hy2|tuic"

/**
 * 文本里是否出现节点链接 —— base64 解码闸门的判据。
 *
 * ⚠️ 必须按 `scheme://` 判定，**不能用裸子串**：原先的
 * `/vless|vmess|trojan|ss|ssr/i` 会被 `obfs-password` 里的 `ss` 命中，
 * 于是任意含该字段的 base64 都被当成节点列表放行（实测踩到：一份 anytls
 * 订阅的 `&obfs-password=` 让闸门误判通过）。
 */
export function looksLikeNodeList(text: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9])(?:${SCHEME_ALT}):\\/\\/`, "i").test(text)
}

/**
 * 宽松 base64 解码：失败返回 null，不抛。
 *
 * 三处容错，都是订阅站实际会出现的形态：
 *   - 自动补 padding（很多站省掉末尾的 `=`）；
 *   - 兼容 URL-safe 字母表（`-`/`_`）；
 *   - **按 UTF-8 解出字符串**：`atob` 返回的是「每字符一个字节」的 Latin1 串，
 *     直接当文本用会把中文节点名变成乱码（进而地区识别失效）。
 *     先把字节装进 Uint8Array 再交给 TextDecoder。
 */
function tryBase64(input: string): string | null {
  const clean = (input ?? "").replace(/\s/g, "")
  if (!clean || !/^[A-Za-z0-9+/=_-]+$/.test(clean)) return null
  try {
    const normalized = clean.replace(/-/g, "+").replace(/_/g, "/")
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4)
    const bin = atob(padded)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder("utf-8").decode(bytes)
  } catch {
    return null
  }
}

/**
 * 安全的 percent-decode：畸形转义（裸 `%`、截断的 `%E5`）原样返回，不抛。
 * 节点名来自订阅方，不能假设它一定规范 —— `decodeURIComponent` 遇到
 * `%` 后面不是合法十六进制时会直接抛 URIError，一路冒泡会把整次审核打成 500。
 */
function safeDecode(s: string): string {
  if (!s) return ""
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** parseNodeLink 的返回结构 */
export interface ParsedNode {
  protocol: string
  server: string
  port: number | null
  region: string | null
  details: Record<string, string>
}

/**
 * 解析 `scheme://[userinfo@]host:port[?query][#name]` 形态的节点链接。
 *
 * 覆盖 vless / trojan / ss / anytls / hysteria(2) / tuic —— 它们共用同一套
 * 地址骨架，差异只在「userinfo 里放什么」与「query 里认哪些字段」。
 * hysteria v1 没有 userinfo（auth 在 query 里），走同一函数也不受影响：
 * 没有 `@` 时 cred 为空串，host:port 就是整个 authority。
 */
function parseAuthorityLink(s: string, scheme: string, protocol: string): ParsedNode {
  const rest = s.slice(scheme.length + 3)
  const hashIdx = rest.indexOf("#")
  const namePart = hashIdx >= 0 ? rest.slice(hashIdx + 1) : ""
  const urlPart = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest
  const queryIdx = urlPart.indexOf("?")
  const authority = queryIdx >= 0 ? urlPart.slice(0, queryIdx) : urlPart
  const query = queryIdx >= 0 ? urlPart.slice(queryIdx + 1) : ""

  const atIdx = authority.lastIndexOf("@")
  const hostPort = atIdx >= 0 ? authority.slice(atIdx + 1) : authority
  const cred = atIdx >= 0 ? authority.slice(0, atIdx) : ""

  // 拆 host / port。IPv6 字面量写成 [::1]:443，冒号不能直接 lastIndexOf。
  let host = hostPort
  let portStr = ""
  if (hostPort.startsWith("[")) {
    const close = hostPort.indexOf("]")
    if (close >= 0) {
      host = hostPort.slice(0, close + 1)
      const after = hostPort.slice(close + 1)
      if (after.startsWith(":")) portStr = after.slice(1)
    }
  } else if (hostPort.includes(":")) {
    const i = hostPort.lastIndexOf(":")
    host = hostPort.slice(0, i)
    portStr = hostPort.slice(i + 1)
  }
  const port = Number(portStr)

  const params: Record<string, string> = {}
  for (const kv of query.split("&")) {
    if (!kv) continue
    const eq = kv.indexOf("=")
    const k = eq >= 0 ? kv.slice(0, eq) : kv
    const v = eq >= 0 ? kv.slice(eq + 1) : ""
    if (k) params[k] = safeDecode(v)
  }

  const name = safeDecode(namePart)
  const details: Record<string, string> = { name }

  // ---- 各协议的 userinfo 归属 ----
  if (protocol === "vless") {
    details.uuid = cred
    if (params.flow) details.flow = params.flow
  } else if (protocol === "trojan") {
    details.password = cred
  } else if (protocol === "ss") {
    // 两种形态：
    //   ss://base64(method:password)@host:port   （legacy，主流）
    //   ss://method:password@host:port           （2022 明文写法）
    let method = params.method ?? ""
    let password = cred
    const decoded = tryBase64(cred)
    const plain = decoded && decoded.includes(":") ? decoded : cred
    const ci = plain.indexOf(":")
    if (ci > 0) {
      method = method || plain.slice(0, ci)
      password = plain.slice(ci + 1)
    }
    details.password = password
    if (method) details.method = method
  } else if (protocol === "anytls") {
    details.password = cred
  } else if (protocol === "hysteria2") {
    // userinfo 是 auth（单口令，或 user:pass 形态）
    details.password = cred
    if (params.obfs) details.obfs = params.obfs
    if (params["obfs-password"]) details.obfsPassword = params["obfs-password"]
  } else if (protocol === "hysteria") {
    // v1 没有 userinfo：认证信息在 query
    if (params.auth) details.password = params.auth
    if (params.protocol) details.network = params.protocol
    if (params.peer) details.sni = params.peer
    if (params.obfs) details.obfs = params.obfs
  } else if (protocol === "tuic") {
    // userinfo 是 uuid:password
    const ci = cred.indexOf(":")
    if (ci > 0) {
      details.uuid = cred.slice(0, ci)
      details.password = cred.slice(ci + 1)
    } else if (cred) {
      details.uuid = cred
    }
    if (params.congestion_control) details.congestion = params.congestion_control
  }

  // ---- 通用可选字段（各家命名不完全一致，能收就收）----
  if (params.sni) details.sni = params.sni
  else if (params.peer && !details.sni) details.sni = params.peer
  if (params.security) details.security = params.security
  if (params.type && !details.network) details.network = params.type
  if (params.alpn) details.alpn = params.alpn
  if (params.obfs && !details.obfs) details.obfs = params.obfs
  if (params.headerType) details.headerType = params.headerType
  if (params.insecure) details.insecure = params.insecure
  if (params.pinSHA256) details.pinSHA256 = params.pinSHA256
  if (params.fp) details.fp = params.fp

  return {
    protocol,
    server: host,
    port: Number.isFinite(port) && port > 0 ? port : null,
    region: regionFromName(name),
    details,
  }
}

/**
 * 解析 ssr:// 链接。
 *
 * 形态：`ssr://base64(host:port:protocol:method:obfs:base64(password)/?params)`
 * —— 整体一层 base64，密码再嵌一层；params 里的 obfsparam / protoparam /
 * remarks 同样各自是 base64。字段用 `:` 分隔，所以密码段要按「剩余全部」取，
 * 不能简单 split 后取第 6 项。
 */
function parseSsrLink(s: string): ParsedNode | null {
  const payload = tryBase64(s.slice("ssr://".length))
  if (!payload) return null
  const slash = payload.indexOf("/?")
  const head = slash >= 0 ? payload.slice(0, slash) : payload
  const query = slash >= 0 ? payload.slice(slash + 2) : ""

  const parts = head.split(":")
  if (parts.length < 6) return null
  const host = parts[0]
  const port = Number(parts[1])
  const proto = parts[2]
  const method = parts[3]
  const obfs = parts[4]
  const passB64 = parts.slice(5).join(":")

  const params: Record<string, string> = {}
  for (const kv of query.split("&")) {
    if (!kv) continue
    const eq = kv.indexOf("=")
    const k = eq >= 0 ? kv.slice(0, eq) : kv
    const v = eq >= 0 ? kv.slice(eq + 1) : ""
    if (k) params[k] = v
  }

  const name = tryBase64(params.remarks ?? "") ?? ""
  const details: Record<string, string> = {
    name,
    password: tryBase64(passB64) ?? "",
    method,
    ssrProtocol: proto,
    obfs,
  }
  const obfsParam = tryBase64(params.obfsparam ?? "")
  if (obfsParam) details.obfsParam = obfsParam
  const protoParam = tryBase64(params.protoparam ?? "")
  if (protoParam) details.protoParam = protoParam

  return {
    protocol: "ssr",
    server: host,
    port: Number.isFinite(port) && port > 0 ? port : null,
    region: regionFromName(name),
    details,
  }
}

/** 从 node 链接解析节点；解析不到则返回 unknown */
export function parseNodeLink(raw: string): ParsedNode {
  const s = raw.trim()
  const fallback: ParsedNode = {
    protocol: "unknown",
    server: "",
    port: null,
    region: null,
    details: {},
  }

  // 1) vmess：base64(JSON)
  if (/^vmess:\/\//i.test(s)) {
    // 用 tryBase64 而不是裸 atob：vmess 配置里的节点名常含中文，而 v2board
    // 是按 UTF-8 字节做 base64 的 —— 裸 atob 只按 Latin1 还原，中文会变乱码，
    // 进而导致地区识别失效。
    const json = tryBase64(s.slice("vmess://".length))
    if (!json) return { ...fallback, protocol: "vmess" }
    try {
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

  // 2) ssr：嵌套 base64，骨架与其余协议不同，单独处理
  if (/^ssr:\/\//i.test(s)) {
    return parseSsrLink(s) ?? { ...fallback, protocol: "ssr" }
  }

  // 3) 其余 scheme://[userinfo@]host:port 形态
  const m = s.match(/^([a-z][a-z0-9+.-]*):\/\//i)
  if (m) {
    const scheme = m[1].toLowerCase()
    const protocol = NODE_SCHEMES[scheme]
    if (protocol && protocol !== "vmess" && protocol !== "ssr") {
      return parseAuthorityLink(s, scheme, protocol)
    }
  }

  // 4) 无法识别：整行原样展示
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
export function parseSubscription(text: string): ProxyNodeInfo[] {
  const trimmed = text.trim()
  if (!trimmed) return []

  const nodes: ProxyNodeInfo[] = []

  const tryDecode = (input: string): string | null => {
    const clean = input.replace(/\s/g, "")
    if (!/^[A-Za-z0-9+/=_-]+$/.test(clean) || clean.length < 8) return null
    const decoded = tryBase64(clean)
    // 只有解码后确实出现 `scheme://` 才接受（见 looksLikeNodeList 的说明）
    if (decoded && looksLikeNodeList(decoded)) return decoded
    return null
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
/**
 * 只保留「协议已识别 + 有服务器地址」的条目。
 *
 * ⚠️ 必须过这一层：`parseSubscription` 对**任何**文本都会产出条目 ——
 * 认不出的行也会被 push，只是记成 `protocol: "unknown"`、`server: ""`。
 * 所以「解析结果数组非空」证明不了这是一份订阅，**一份随便的网页也能过**。
 * （写这个校验时就被这个坑到过：拿 HTML 当订阅也判成了通过。）
 */
export function usableNodes(nodes: ProxyNodeInfo[]): ProxyNodeInfo[] {
  return nodes.filter((n) => n.protocol && n.protocol !== "unknown" && n.server)
}

/**
 * 从解析出的节点推断协议与地区 —— 纯计算，不联网。
 * 协议：按出现频次取最常见的；地区：订阅 URL 里的地区参数优先，
 * 其次看节点名里出现的地区（只有一种 → 用它；多种 → 「综合」）。
 */
export function profileFromNodes(
  nodes: ProxyNodeInfo[],
  url: string
): { protocol: string | null; region: string | null } {
  const usable = usableNodes(nodes)
  if (usable.length === 0) return { protocol: null, region: null }

  const counts: Record<string, number> = {}
  for (const n of usable) counts[n.protocol] = (counts[n.protocol] ?? 0) + 1
  let protocol: string | null = null
  let best = 0
  for (const [p, c] of Object.entries(counts)) {
    if (c > best) {
      best = c
      protocol = p
    }
  }

  let region: string | null = null
  try {
    const u = new URL(url)
    for (const key of ["region", "loc", "area"]) {
      const v = u.searchParams.get(key)
      if (v && v.trim()) {
        // searchParams.get 已经解过一次 percent 编码，这里不再二次解码
        region = v.trim().slice(0, 40)
        break
      }
    }
  } catch {
    // 忽略 URL 解析失败
  }
  if (!region) {
    const regionCounts: Record<string, number> = {}
    for (const n of usable) {
      if (n.region) regionCounts[n.region] = (regionCounts[n.region] ?? 0) + 1
    }
    const distinct = Object.keys(regionCounts)
    if (distinct.length === 1) region = distinct[0]
    else if (distinct.length > 1) region = "综合"
  }
  return { protocol, region }
}

/**
 * 自动识别订阅源的协议、地区与当前状态（管理员无需手动选择）。
 * 识别失败（抓不到 / 压不出节点）时协议地区回落到 null，由管理员手填兜底；
 * 状态仍给出 online/offline。
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
  const { protocol, region } = profileFromNodes(nodes, row.url)
  return { protocol, region, ok }
}

// ---- 代理节点捐献的自动审核 ----

/** 单次捐献最多校验多少个订阅链接（每个都要真拉一次，太多会把提交拖到超时） */
export const MAX_DONATION_SUB_URLS = 8
/** 校验并发度：太高会被订阅站当成扫描 */
const SUB_CHECK_CONCURRENCY = 4

export interface SubscriptionCheck {
  url: string
  ok: boolean
  /** 解析出的节点数；ok=true 时必定 ≥ 1 */
  nodeCount: number
  protocol: string | null
  region: string | null
  /** ok=false 时的原因（面向用户，要写得能指导他改） */
  error: string
}

/**
 * 逐个校验用户提交的订阅链接 —— 「代理节点捐献」自动审核的核心。
 *
 * 判据：**能抓到内容 + 能解析出至少一个节点**才算通过。
 *
 * 为什么只做到这一步：Cloudflare 出网拿不到节点的真实连通性
 * （无法对任意 TCP/UDP 端口做探测，见本文件顶部说明），所以「节点能不能连上」
 * 只能由用户在自己设备上判断。但「订阅链接是不是有效、拿到的是不是节点列表」
 * 完全可以自动判定 —— 这已经能挡掉绝大多数无效/过期的捐献。
 *
 * ⚠️ 地址来自用户 ⇒ 必须过 `assertPublicHttpUrl`（SSRF 面）。
 */
export async function verifySubscriptionUrls(
  env: Env,
  urls: string[]
): Promise<SubscriptionCheck[]> {
  return mapLimit(urls, SUB_CHECK_CONCURRENCY, async (raw) => {
    const url = (raw ?? "").trim()
    const bad = (error: string): SubscriptionCheck => ({
      url,
      ok: false,
      nodeCount: 0,
      protocol: null,
      region: null,
      error,
    })

    try {
      assertPublicHttpUrl(url, "订阅链接")
    } catch (err) {
      return bad(err instanceof Error ? err.message : String(err))
    }

    let res: { text: string; ok: boolean; status: number }
    try {
      res = await fetchSubscriptionText(env, url)
    } catch (err) {
      return bad(
        `拉取失败：${err instanceof Error ? err.message : String(err)}`
      )
    }
    if (!res.ok) {
      return bad(
        res.status === 413
          ? "订阅内容超过 5 MB，暂不支持"
          : `订阅地址无法访问（HTTP ${res.status}）`
      )
    }

    const nodes = usableNodes(parseSubscription(res.text))
    if (nodes.length === 0) {
      return bad(
        "订阅内容里没有解析出任何节点（链接可能已失效，或该订阅用了暂不支持的协议。" +
          "已支持：vless / vmess / trojan / ss / ssr / anytls / hysteria2 / tuic）"
      )
    }

    const { protocol, region } = profileFromNodes(nodes, url)
    return { url, ok: true, nodeCount: nodes.length, protocol, region, error: "" }
  })
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