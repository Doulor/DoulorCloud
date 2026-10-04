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
import { requireAdminScope } from "./admin"
import { uuid } from "../crypto"
import { mapLimit } from "../async-utils"
import { assertPublicHttpUrl } from "../url-guard"
import { requireFeatureUser, type UserRow } from "../auth"
import { audit, getSettings } from "../settings"
import { guardRateLimit, hitRateLimit } from "../ratelimit"
import {
  MAX_LATENCY_BATCH,
  latencyTargets,
  measureNodes,
} from "../proxy-latency"
import type { Env } from "../env"

/**
 * 出站抓取限流（2026-09-25 审计 H8）。
 *
 * `getProxyOverview` 每次请求都会对**全部可见订阅源各发一次外网 fetch**，
 * `checkProxySubscription` 也会探测一次外网；两者原先都没有任何限流。
 * 于是任意有 proxy 权限的用户循环调用就能：
 *   - 把订阅服务商当放大/骚扰目标；
 *   - 烧掉自己的 Worker 子请求额度（免费计划 50 子请求/请求）。
 *
 * 额度按「请求次数」而不是「fetch 次数」计：一次页面加载不管有几个订阅源
 * 都只算一次，所以 30 次/分钟对正常使用非常宽松。
 */
const PROXY_FETCH_LIMIT = 30
const PROXY_FETCH_WINDOW_SECONDS = 60

async function guardProxyFetch(env: Env, userId: string): Promise<void> {
  await guardRateLimit(
    env,
    `proxy:fetch:user:${userId}`,
    PROXY_FETCH_LIMIT,
    PROXY_FETCH_WINDOW_SECONDS,
    "操作过于频繁，请稍后再试"
  )
}

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
  /** 审核来源：auto=自动审核导入 / manual=人工放行或手工添加（决定过时能否自动标记不可用） */
  review_source: string
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
  /** 相同节点检测：本节点在**另一个**订阅源里也出现了（值是那个订阅源的名称） */
  duplicateOf?: string
}

function toPublicSubscription(row: ProxySubscriptionRow) {
  return {
    id: row.id,
    name: row.name,
    region: row.region,
    // ⚠️ 2026-09-26 审计（承接 09-25 的 H7，本次做了决策）：这里**刻意不返回 `url`**。
    // 订阅源 URL 内嵌机场服务商的订阅 token；一旦随列表一次性下发到前端，
    // 任何有 proxy 权限的用户都能从响应里（根本不用点按钮、不必开界面）
    // 直接读到并转发给站外，耗尽管理员的机场套餐。
    // 需要原始链接时走 `POST /api/proxy/subscriptions/:id/reveal`（按用户按天限流）。
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

/** 该用户可见的订阅源：全部已启用的（enabled=1），不做按用户授权。支持分页（懒加载）。 */
async function visibleSubscriptions(
  env: Env,
  opts?: { limit?: number; offset?: number }
): Promise<ProxySubscriptionRow[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 200, 1), 200)
  const offset = Math.max(opts?.offset ?? 0, 0)
  const rows = await env.DB.prepare(
    // offline（过时）的订阅源排最后，其余按 sort_order + 创建时间（2026-10-03 站长要求）
    "SELECT * FROM proxy_subscriptions WHERE enabled = 1 ORDER BY (status = 'offline') ASC, sort_order ASC, created_at ASC LIMIT ? OFFSET ?"
  ).bind(limit, offset).all<ProxySubscriptionRow>()
  return rows.results ?? []
}

// ---- 抓取订阅源 ----

/**
 * 流式读取响应体，超过 `max` 字节立即中止并返回 null。
 *
 * ⚠️ 2026-09-25 审计（H8）：原实现是 `await res.arrayBuffer()` **之后**才比对
 * MAX_FETCH_BYTES —— 恶意订阅源可以用一个超大响应把 Worker 内存打满，
 * 大小检查形同虚设（它只在事后判定，不能阻止缓冲）。
 */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const body = res.body
  if (!body) return new Uint8Array(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > max) {
      // 超限立刻断开，不再继续下载
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
/** 手动跟随的最大跳数（超过即判失败，避免重定向环） */
const MAX_REDIRECT_HOPS = 4

/**
 * 抓取订阅 URL 的原始文本。
 *
 * ⚠️ 2026-09-25 审计（P0-3 / H5）—— 这个方法同时服务两类调用方，
 * 而原实现把它们当成了同一类：
 *
 *   1. **管理员配置的**订阅源（proxy_subscriptions.url）：该带凭据；
 *   2. **用户提交的** URL（捐献审核走 verifySubscriptionUrls）：**绝不能**带凭据。
 *
 *   原实现无条件注入 `Authorization: Bearer ${env.PROXY_API_TOKEN}`，
 *   而用户 URL 那条路径只过了 assertPublicHttpUrl 就直接发出去 ——
 *   任何登录用户提交一笔 type=proxy 的捐献、把 subUrls 指向自己的服务器，
 *   就能一次请求取走平台第三方订阅系统的长期凭据。
 *   现在由调用方通过 `withCredentials` 明确声明，用户 URL 一律 false。
 *
 *   同时把 `redirect: "follow"` 改成**手动逐跳跟随**：
 *   原先只有首跳过了 assertPublicHttpUrl，一个 302 就能把请求引到
 *   169.254.169.254 / 127.0.0.1 / 内网地址，首跳校验形同虚设。
 *   现在每一跳都重新校验，且**凭据只在第一跳发送**（跨主机重定向不携带 token）。
 */
async function fetchSubscriptionText(
  env: Env,
  url: string,
  withCredentials: boolean
): Promise<{ text: string; ok: boolean; status: number }> {
  let current = url

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    // 每一跳都校验：首跳由调用方或这里校验，重定向目标同样必须过闸
    try {
      assertPublicHttpUrl(current, "订阅链接")
    } catch {
      return { text: "", ok: false, status: 403 }
    }

    const headers: Record<string, string> = {
      "User-Agent": "DoulorCloud/1.0",
    }
    // 凭据只发给「第一跳 + 管理员配置的地址」，绝不跟着重定向走
    if (withCredentials && hop === 0 && env.PROXY_API_TOKEN) {
      headers.Authorization = `Bearer ${env.PROXY_API_TOKEN}`
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(current, {
        method: "GET",
        headers,
        signal: controller.signal,
        redirect: "manual",
      })
    } finally {
      clearTimeout(timer)
    }

    if (REDIRECT_STATUSES.has(res.status)) {
      const location = res.headers.get("Location")
      if (!location) return { text: "", ok: false, status: res.status }
      let next: string
      try {
        next = new URL(location, current).toString()
      } catch {
        return { text: "", ok: false, status: res.status }
      }
      current = next
      continue
    }

    if (!res.ok) {
      return { text: "", ok: false, status: res.status }
    }

    const buf = await readCapped(res, MAX_FETCH_BYTES)
    if (!buf) {
      return { text: "", ok: false, status: 413 }
    }
    // 按 UTF-8 解码（节点配置基本是纯 ASCII + base64，用 utf-8 足够）
    return { text: new TextDecoder("utf-8").decode(buf), ok: true, status: res.status }
  }

  // 跳数用尽
  return { text: "", ok: false, status: 310 }
}

/** 对订阅 URL 做探活，返回近似延迟（毫秒），失败返回 null */
async function probeSubscriptionUrl(
  env: Env,
  url: string,
  withCredentials: boolean
): Promise<{ latencyMs: number | null; ok: boolean; message?: string }> {
  const start = Date.now()
  try {
    const { ok, status } = await fetchSubscriptionText(env, url, withCredentials)
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

// ---- 结构化订阅：Clash YAML / sing-box JSON / sspanel JSON ----
//
// 为什么必须支持：自动审核的判据是「能解析出至少一个节点」。而机场给的
// 「Clash 订阅」是 YAML、「sing-box 订阅」是 JSON，**都不是 URI 列表** ——
// 走逐行解析只会得到一堆 `protocol:"unknown"` 的条目，一过 `usableNodes()`
// 就是 0 个节点，于是**一份在 Clash 里用得好好的订阅会被判「没有解析出任何节点」
// 并自动拒绝**。
//
// 实测（本文件改动前）：Clash YAML 里 3 个真实节点 → 可用 0；
// sing-box JSON 同理。这与当初「只认 4 种协议导致 anytls/hysteria2 订阅被误拒」
// 是同一类 bug。
//
// 做法：先把结构化格式**还原成等价的节点链接**（vless:// / vmess:// / …），
// 再交给现成的 `parseNodeLink` 统一解析。好处是只维护一套节点语义，
// 而且 `ProxyNodeInfo.raw`（给用户复制进客户端的原始链接）依旧是真实可用的链接。

/** Clash / sing-box 的 `type` → 本项目协议名（两家命名不同，都归一到这里） */
const CLASH_TYPE_TO_PROTOCOL: Record<string, string> = {
  vmess: "vmess",
  vless: "vless",
  trojan: "trojan",
  ss: "ss",
  shadowsocks: "ss",
  ssr: "ssr",
  anytls: "anytls",
  hysteria: "hysteria",
  hysteria2: "hysteria2",
  hy2: "hysteria2",
  tuic: "tuic",
}

/** base64（UTF-8 语义）—— vmess / ss / ssr 链接要内嵌 base64 */
function toBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** URL-safe base64（ssr 的查询参数用它，避免 `=`/`+` 被二次编码破坏） */
function toBase64UrlUtf8(text: string): string {
  return toBase64Utf8(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** 去掉包裹的引号与方括号（Clash 的 `"香港"`、`[h3]`） */
function unquote(v: string): string {
  let s = (v ?? "").trim()
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1).trim()
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    s = s.slice(1, -1)
  }
  return s.trim()
}

/**
 * 解析 `{a: 1, b: {c: 2}}` 形态的 inline map → 扁平 map。
 * 嵌套一律用 `.` 连接（`b.c`）—— Clash 用嵌套表达 ws-opts / reality-opts。
 * 拆分时要跳过引号内与括号内的逗号，否则 `{name: "a,b"}` 会被撕开。
 */
function parseFlowMap(src: string): Record<string, string> {
  const out: Record<string, string> = {}
  const inner = src.trim().replace(/^\{/, "").replace(/\}$/, "")
  const parts: string[] = []
  let depth = 0
  let quote = ""
  let cur = ""
  for (const ch of inner) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = ""
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === "{" || ch === "[") depth += 1
    if (ch === "}" || ch === "]") depth -= 1
    if (ch === "," && depth === 0) {
      parts.push(cur)
      cur = ""
      continue
    }
    cur += ch
  }
  if (cur.trim()) parts.push(cur)

  for (const part of parts) {
    const i = part.indexOf(":")
    if (i <= 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (!k) continue
    if (v.startsWith("{")) {
      for (const [sk, sv] of Object.entries(parseFlowMap(v))) out[`${k}.${sk}`] = sv
    } else {
      out[k] = unquote(v)
    }
  }
  return out
}

/**
 * 抽出 Clash 配置 `proxies:` 段里的每个节点 → 扁平 map。
 * 两种写法都支持（机场导出的两种都常见）：
 *   - flow：  `- {name: 香港, type: vless, server: a.com, port: 443}`
 *   - block：`- name: 香港` / `  type: vless` / `  server: a.com`
 * 只读 `proxies:` 段，遇到下一个顶层键（`proxy-groups:` / `rules:`）就停。
 */
function parseClashProxies(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^proxies\s*:\s*$/.test(lines[i] ?? "")) {
      start = i
      break
    }
  }
  if (start < 0) return []

  const entries: Record<string, string>[] = []
  let cur: Record<string, string> | null = null
  // 缩进前缀栈：Clash 用嵌套写 ws-opts / reality-opts，扁平化时拼成 `父.子`
  let prefix = ""
  let prefixIndent = -1

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? ""
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const indent = line.length - line.trimStart().length
    if (indent === 0) break // 回到顶层 → proxies 段结束

    if (trimmed.startsWith("- ")) {
      if (cur) entries.push(cur)
      cur = {}
      prefix = ""
      prefixIndent = -1
      const rest = trimmed.slice(2).trim()
      if (rest.startsWith("{")) {
        Object.assign(cur, parseFlowMap(rest))
      } else {
        const i2 = rest.indexOf(":")
        if (i2 > 0) {
          const k = rest.slice(0, i2).trim()
          const v = rest.slice(i2 + 1).trim()
          if (!v) {
            prefix = k
            prefixIndent = indent
          } else if (k) {
            cur[k] = unquote(v)
          }
        }
      }
      continue
    }

    if (!cur) continue
    if (indent <= prefixIndent) {
      prefix = ""
      prefixIndent = -1
    }
    const i2 = trimmed.indexOf(":")
    if (i2 <= 0) continue
    const k = trimmed.slice(0, i2).trim()
    if (!k) continue
    const v = trimmed.slice(i2 + 1).trim()
    const key = prefix ? `${prefix}.${k}` : k
    if (!v) {
      prefix = key
      prefixIndent = indent
      continue
    }
    cur[key] = unquote(v)
  }
  if (cur) entries.push(cur)
  return entries
}

/**
 * 把「归一化后的节点字段」拼回一条节点链接。
 *
 * 输入统一用 Clash 的字段名（sing-box 的适配器负责翻译过来），
 * 这样两个来源共用一套拼接逻辑，不会出现「Clash 支持、sing-box 漏字段」的漂移。
 * 认不出协议、或缺 server/port 时返回 null（调用方会跳过它）。
 */
function buildNodeLink(p: Record<string, string>): string | null {
  const protocol = CLASH_TYPE_TO_PROTOCOL[(p.type ?? "").toLowerCase()]
  if (!protocol) return null
  const server = p.server ?? ""
  const port = p.port ?? ""
  if (!server || !port) return null
  const name = p.name ?? ""
  const tls = /^(true|1|yes)$/i.test(p.tls ?? "")

  const q = new URLSearchParams()
  if (tls) q.set("security", "tls")
  const sni = p.servername || p.sni || ""
  if (sni) q.set("sni", sni)
  const network = p.network ?? ""
  if (network && network !== "tcp") q.set("type", network)
  const path = p["ws-opts.path"] || p["grpc-opts.grpc-service-name"] || ""
  if (network === "ws" && path) q.set("path", path)
  const host = p["ws-opts.headers.Host"] || p["ws-opts.headers.host"] || ""
  if (host) q.set("host", host)
  if (p.flow) q.set("flow", p.flow)
  if (p["client-fingerprint"]) q.set("fp", p["client-fingerprint"])
  if (p.alpn) q.set("alpn", p.alpn)
  if (/^(true|1)$/i.test(p["skip-cert-verify"] ?? "")) q.set("allowInsecure", "1")
  if (p.obfs) q.set("obfs", p.obfs)
  if (p["obfs-password"]) q.set("obfs-password", p["obfs-password"])
  if (p["reality-opts.public-key"]) {
    q.set("security", "reality")
    q.set("pbk", p["reality-opts.public-key"])
    if (p["reality-opts.short-id"]) q.set("sid", p["reality-opts.short-id"])
  }
  const query = q.toString()
  const suffix = `${query ? `?${query}` : ""}${name ? `#${encodeURIComponent(name)}` : ""}`

  switch (protocol) {
    case "vless":
      if (!p.uuid) return null
      return `vless://${p.uuid}@${server}:${port}${suffix}`
    case "trojan":
      if (!p.password) return null
      return `trojan://${encodeURIComponent(p.password)}@${server}:${port}${suffix}`
    case "anytls":
      if (!p.password) return null
      return `anytls://${encodeURIComponent(p.password)}@${server}:${port}${suffix}`
    case "hysteria2":
      return `hysteria2://${encodeURIComponent(p.password ?? "")}@${server}:${port}${suffix}`
    case "hysteria": {
      // v1 的认证在 query（auth），没有 userinfo —— 与 parseAuthorityLink 的读法对齐
      const h = new URLSearchParams()
      if (p.password) h.set("auth", p.password)
      if (p.sni) h.set("peer", p.sni)
      if (p.obfs) h.set("obfs", p.obfs)
      return `hysteria://${server}:${port}?${h.toString()}${
        name ? `#${encodeURIComponent(name)}` : ""
      }`
    }
    case "tuic": {
      const cred = p.uuid ? `${p.uuid}:${p.password ?? ""}` : (p.password ?? "")
      return `tuic://${cred}@${server}:${port}${suffix}`
    }
    case "ss": {
      const method = p.cipher || p.method || ""
      if (!method) return null
      return `ss://${toBase64Utf8(`${method}:${p.password ?? ""}`)}@${server}:${port}${
        name ? `#${encodeURIComponent(name)}` : ""
      }`
    }
    case "ssr": {
      const method = p.cipher || p.method || ""
      if (!method) return null
      const payload = [
        server,
        port,
        p.protocol || "origin",
        method,
        p.obfs || "plain",
        toBase64UrlUtf8(p.password ?? ""),
      ].join(":")
      const ssrQ: string[] = []
      if (name) ssrQ.push(`remarks=${toBase64UrlUtf8(name)}`)
      if (p["obfs-param"]) ssrQ.push(`obfsparam=${toBase64UrlUtf8(p["obfs-param"])}`)
      if (p["protocol-param"]) ssrQ.push(`protoparam=${toBase64UrlUtf8(p["protocol-param"])}`)
      return `ssr://${toBase64UrlUtf8(`${payload}/?${ssrQ.join("&")}`)}`
    }
    case "vmess": {
      if (!p.uuid) return null
      const obj: Record<string, string> = {
        v: "2",
        ps: name,
        add: server,
        port,
        id: p.uuid,
        aid: p.alterId || "0",
        scy: p.scy || p.cipher || "auto",
        net: network || "tcp",
        type: "none",
        tls: tls ? "tls" : "",
      }
      if (network === "ws" && path) obj.path = path
      if (host) obj.host = host
      if (sni) obj.sni = sni
      return `vmess://${toBase64Utf8(JSON.stringify(obj))}`
    }
    default:
      return null
  }
}

/**
 * sing-box outbound / sspanel server → Clash 字段名，交给 buildNodeLink 统一拼接。
 * 只翻译我们真正会用到的字段，认不出的一律丢弃（宁可少一个节点，也不要造错链接）。
 */
function structuredObjectToClashKeys(o: Record<string, unknown>): Record<string, string> {
  const p: Record<string, string> = {}
  const set = (k: string, v: unknown): void => {
    if (typeof v === "string" && v.trim()) p[k] = v.trim()
    else if (typeof v === "number") p[k] = String(v)
  }

  set("type", o.type)
  set("name", o.tag ?? o.remarks ?? o.name ?? o.ps)
  set("server", o.server)
  set("port", o.server_port ?? o.port)
  if (!p.port && typeof o.server_ports === "string") {
    // hysteria2 的端口跳跃（"20000:30000"）：取起始端口，够识别与展示
    const first = o.server_ports.split(/[-,:]/)[0]
    if (first) p.port = first
  }
  set("uuid", o.uuid ?? o.id)
  set("password", o.password)
  set("cipher", o.method ?? o.cipher)
  set("alterId", o.alter_id ?? o.aid)
  set("scy", o.security ?? o.scy)
  set("flow", o.flow)
  set("sni", o.sni)

  // sspanel 的 servers[] 只有 method/password，没有 type —— 按 ss 处理
  if (!p.type && (p.cipher || p.method)) p.type = "ss"

  const tls = (o.tls ?? {}) as Record<string, unknown>
  if (tls.enabled === true) p.tls = "true"
  else if (o.tls === true) p.tls = "true"
  set("servername", tls.server_name)
  if (tls.insecure === true) p["skip-cert-verify"] = "true"
  if (Array.isArray(tls.alpn)) {
    p.alpn = tls.alpn.filter((x): x is string => typeof x === "string").join(",")
  }

  const tr = (o.transport ?? {}) as Record<string, unknown>
  set("network", tr.type)
  set("ws-opts.path", tr.path)
  const headers = (tr.headers ?? {}) as Record<string, unknown>
  set("ws-opts.headers.Host", headers.Host ?? headers.host)

  const obfs = (o.obfs ?? {}) as Record<string, unknown>
  if (typeof obfs === "object" && obfs !== null) {
    set("obfs", obfs.type)
    set("obfs-password", obfs.password)
  } else {
    set("obfs", o.obfs)
  }
  // Clash 的 ssr / hysteria v1 用连字符键名
  set("obfs-param", o["obfs-param"])
  set("protocol-param", o["protocol-param"])
  set("auth-str", o["auth-str"])
  if (!p.password && typeof o["auth-str"] === "string") p.password = o["auth-str"]

  return p
}

/** 宽容 JSON 解析：不是对象/数组、或解析失败都返回 null */
function tryParseJson(text: string): unknown {
  const s = text.trim()
  if (!s.startsWith("{") && !s.startsWith("[")) return null
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

/** 从各种「订阅根对象」里找出节点数组（sing-box outbounds / Clash proxies / sspanel servers） */
function collectNodeObjects(obj: unknown): Record<string, unknown>[] {
  const isObj = (x: unknown): x is Record<string, unknown> =>
    !!x && typeof x === "object" && !Array.isArray(x)
  if (Array.isArray(obj)) return obj.filter(isObj)
  if (!isObj(obj)) return []
  for (const key of ["outbounds", "proxies", "servers", "nodes"]) {
    const v = obj[key]
    if (Array.isArray(v)) return v.filter(isObj)
  }
  return []
}

/** 整体 base64 包裹的结构化配置（少数站会这么干） */
function tryDecodeStructuredBase64(text: string): string | null {
  const clean = text.replace(/\s/g, "")
  if (clean.length < 16 || clean.length > 4_000_000) return null
  if (!/^[A-Za-z0-9+/=_-]+$/.test(clean)) return null
  const decoded = tryBase64(clean)
  if (!decoded) return null
  // 只有「解码出来确实是一份配置」才接受 —— 否则任意 base64 都会被当订阅
  if (/^\s*proxies\s*:/m.test(decoded)) return decoded
  const t = decoded.trim()
  if (t.startsWith("{") || t.startsWith("[")) return decoded
  return null
}

/**
 * 把结构化订阅解析成节点链接数组；认不出则返回空数组（调用方回落逐行解析）。
 *
 * ⚠️ 闸门必须严：返回非空就代表「这确实是一份订阅」。所以要么命中
 * `proxies:` 段，要么解析出的对象里真的有带 server 的节点 —— 一份 HTML
 * 页面、一个 API 错误 JSON 都过不了这里（`buildNodeLink` 会全部返回 null）。
 */
function structuredLinkList(text: string): string[] {
  const candidates = [text.trim()]
  const decoded = tryDecodeStructuredBase64(text)
  if (decoded) candidates.push(decoded)

  for (const cand of candidates) {
    if (/^\s*proxies\s*:/m.test(cand)) {
      const links = parseClashProxies(cand)
        .map(buildNodeLink)
        .filter((l): l is string => !!l)
      if (links.length > 0) return links
    }
    const obj = tryParseJson(cand)
    if (obj) {
      const links = collectNodeObjects(obj)
        .map((o) => buildNodeLink(structuredObjectToClashKeys(o)))
        .filter((l): l is string => !!l)
      if (links.length > 0) return links
    }
  }
  return []
}

/**
 * 解析订阅文本 → 节点数组。
 *
 * 支持：整体 base64 的 URI 列表（v2board 常见）、逐行 node 链接、
 * 以及**结构化订阅**（Clash YAML / sing-box JSON / sspanel JSON）。
 * 结构化在前 —— 它们不是 URI 列表，逐行解析只会得到一堆 unknown。
 */
export function parseSubscription(text: string): ProxyNodeInfo[] {
  const trimmed = text.trim()
  if (!trimmed) return []

  const tryDecodeUriList = (input: string): string | null => {
    const clean = input.replace(/\s/g, "")
    if (!/^[A-Za-z0-9+/=_-]+$/.test(clean) || clean.length < 8) return null
    const decoded = tryBase64(clean)
    // 只有解码后确实出现 `scheme://` 才接受（见 looksLikeNodeList 的说明）
    if (decoded && looksLikeNodeList(decoded)) return decoded
    return null
  }

  const structured = structuredLinkList(trimmed)
  const source = structured.length > 0 ? structured.join("\n") : (tryDecodeUriList(trimmed) ?? trimmed)

  const nodes: ProxyNodeInfo[] = []
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
  const { text, ok } = await fetchSubscriptionText(env, row.url, true)
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

/** 节点指纹：`协议:服务器:端口` —— 跨订阅源识别「同一个节点」的唯一键（导入查重 + 相同节点检测都用它） */
export function nodeFingerprint(n: { protocol: string; server: string; port: number | null }): string {
  return `${n.protocol}:${n.server}:${n.port ?? 0}`
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
    const res = await fetchSubscriptionText(env, row.url, true)
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

/**
 * 订阅源「过时 / 失效」检测（2026-10-03 站长要求，由每小时运维任务调用）。
 *
 * 逐个抓取订阅源（并发 + 抖动重试）：
 *   · 连续抓取失败（过时 / 失效）：
 *     - 自动审核（review_source='auto'）→ 自动标记 offline（列表自动排到最后）；
 *     - 人工审核（review_source='manual'）→ 标记 unknown，**不自动判死**（管理员亲手放过，
 *       可能只是临时故障，等人工确认）。
 *   · 抓取成功：
 *     - 自动审核且之前是「自动标记的 offline」→ 恢复 online（自动恢复）。
 *
 * 抖动重试：一次抓取失败就判死太狠（订阅站偶发 5xx/超时很常见），连续两次都失败才算过时。
 */
export async function syncProxySubscriptionStatuses(
  env: Env,
  dryRun = false
): Promise<{ checked: number; offline: number; unknown: number; recovered: number }> {
  const rows = await env.DB.prepare(
    "SELECT id, url, status, review_source FROM proxy_subscriptions WHERE enabled = 1"
  ).all<{ id: string; url: string; status: string; review_source: string }>()

  let checked = 0
  let offline = 0
  let unknown = 0
  let recovered = 0

  await mapLimit(rows.results ?? [], 8, async (row) => {
    checked++
    let ok = false
    let fingerprints: string[] = []
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try {
        const { text } = await fetchSubscriptionText(env, row.url, true)
        const nodes = usableNodes(parseSubscription(text))
        if (nodes.length > 0) {
          ok = true
          fingerprints = nodes.map(nodeFingerprint)
        }
      } catch {
        ok = false
      }
    }
    const now = new Date().toISOString()

    if (!ok) {
      if (row.review_source === "auto") {
        // 自动审核：自动标记不可用，列表自动排到最后
        if (row.status !== "offline") offline++
        if (!dryRun && row.status !== "offline") {
          await env.DB.prepare(
            "UPDATE proxy_subscriptions SET status = 'offline', status_note = '自动检测：订阅源不可用', updated_at = ? WHERE id = ?"
          )
            .bind(now, row.id)
            .run()
        }
      } else {
        // 人工审核：只标「未知」，等管理员确认，不自动判死
        if (row.status !== "unknown") unknown++
        if (!dryRun && row.status !== "unknown") {
          await env.DB.prepare(
            "UPDATE proxy_subscriptions SET status = 'unknown', status_note = '检测不可用（人工审核，需人工确认）', updated_at = ? WHERE id = ?"
          )
            .bind(now, row.id)
            .run()
        }
      }
    } else {
      // 回填节点指纹（供「导入时拒绝相同节点」查重；节点可能变化，先清旧再写新）
      if (!dryRun && fingerprints.length > 0) {
        await env.DB.prepare(
          "DELETE FROM proxy_node_fingerprints WHERE subscription_id = ?"
        )
          .bind(row.id)
          .run()
        const stmt = env.DB.prepare(
          "INSERT OR IGNORE INTO proxy_node_fingerprints (fingerprint, subscription_id, created_at) VALUES (?, ?, ?)"
        )
        await env.DB.batch(fingerprints.map((fp) => stmt.bind(fp, row.id, now)))
      }
      // 自动审核的订阅源恢复了 → 自动恢复 online
      if (row.status === "offline" && row.review_source === "auto") {
        recovered++
        if (!dryRun) {
          await env.DB.prepare(
            "UPDATE proxy_subscriptions SET status = 'online', status_note = NULL, updated_at = ? WHERE id = ?"
          )
            .bind(now, row.id)
            .run()
        }
      }
    }
  })

  return { checked, offline, unknown, recovered }
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
  /**
   * 这次失败是不是「**没能验证**」而不是「确定不可用」。
   *
   * 超时 / 网络错误 / 5xx / 429 / 响应体超本站上限 —— 这些只能说明
   * 「这次没能拿到内容」，**证明不了链接不可用**。调用方（自动审核）
   * 必须据此转人工，绝不能自动拒绝：误拒一份好订阅，用户只会觉得站点坏了。
   */
  uncertain: boolean
  /** ok=true 时，解析出的有效节点指纹（protocol:server:port），供「导入时拒绝相同节点」查重 */
  nodeFingerprints: string[]
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
    const bad = (error: string, uncertain = false): SubscriptionCheck => ({
      url,
      ok: false,
      nodeCount: 0,
      protocol: null,
      region: null,
      error,
      uncertain,
      nodeFingerprints: [],
    })

    try {
      assertPublicHttpUrl(url, "订阅链接")
    } catch (err) {
      // 链接本身不合法（非 http/https、指向内网）→ 确定性失败，重试也没用
      return bad(err instanceof Error ? err.message : String(err))
    }

    // 抖动重试一次：订阅站偶发 5xx / 连接被重置很常见，一次失败就判死太狠
    const isTransientStatus = (s: number): boolean => s >= 500 || s === 429 || s === 408
    let res: { text: string; ok: boolean; status: number } | null = null
    let lastError = ""
    for (let attempt = 0; attempt < 2 && !res; attempt++) {
      try {
        // ⚠️ withCredentials: false —— 这是**用户提交**的地址（捐献审核路径）。
        // 绝不能把平台的 PROXY_API_TOKEN 发给它（2026-09-25 审计 P0-3）。
        const got = await fetchSubscriptionText(env, url, false)
        if (got.ok || !isTransientStatus(got.status)) res = got
        else lastError = `HTTP ${got.status}`
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
      }
    }
    if (!res) {
      return bad(`拉取失败：${lastError || "请求失败"}`, true)
    }

    if (!res.ok) {
      // 404/410 = 链接确实没了（确定性）；其余一律按「没能验证」处理 ——
      // 403/401 很可能是订阅站在拦我们的 User-Agent 或风控，
      // 413 是**我们自己**的 5 MB 上限，都不能算用户的链接不可用。
      if (res.status === 404 || res.status === 410) {
        return bad(`订阅地址不存在（HTTP ${res.status}），链接可能已被删除或过期`)
      }
      if (res.status === 413) {
        return bad("订阅内容超过本站 5 MB 的校验上限，无法自动验证", true)
      }
      return bad(`订阅地址返回 HTTP ${res.status}，可能被订阅站拒绝或临时故障`, true)
    }

    const nodes = usableNodes(parseSubscription(res.text))
    if (nodes.length === 0) {
      const looksHtml = /<html[\s>]|<!doctype html/i.test(res.text)
      return bad(
        looksHtml
          ? "订阅地址返回的是网页而不是节点列表（订阅站可能要求带客户端标识访问，或该链接是落地页）"
          : "订阅内容里没有解析出任何节点（链接可能已失效，或该订阅用了暂不支持的协议。" +
              "已支持：vless / vmess / trojan / ss / ssr / anytls / hysteria2 / tuic）")
    }

    const { protocol, region } = profileFromNodes(nodes, url)
    return {
      url,
      ok: true,
      nodeCount: nodes.length,
      protocol,
      region,
      error: "",
      uncertain: false,
      nodeFingerprints: nodes.map(nodeFingerprint),
    }
  })
}

// ---- 用户侧接口 ----

/** GET /api/proxy —— 总览：启用状态 + 可见订阅源 + 解析后的节点 */
export async function getProxyOverview(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "proxy")
  await guardProxyFetch(env, user.id)
  const settings = await getSettings(env)
  const activated = await isActivated(env, user.id)

  // 懒加载分页（2026-10-03 站长：一次抓取+解析 180 个订阅链接要近 10 秒，
  // 全量返回会让用户进页面干等）。默认 10 条一页，前端「查看更多」传 offset 接着拉。
  const q = new URL(request.url).searchParams
  const limit = Math.min(Math.max(Number(q.get("limit") ?? 10) || 10, 1), 50)
  const offset = Math.max(Number(q.get("offset") ?? 0) || 0, 0)

  // 多取一条判断还有没有下一页
  const rows = activated ? await visibleSubscriptions(env, { limit: limit + 1, offset }) : []
  const hasMore = rows.length > limit
  const page = rows.slice(0, limit)

  const subscriptions = await Promise.all(
    page.map(async (row) => {
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

  // 相同节点检测（2026-10-03 站长要求）：跨订阅源按「协议+服务器+端口」指纹找重复节点。
  // 重复的节点标 duplicateOf = 首次出现的订阅源名，前端可提示「与 xxx 重复」。
  // ⚠️ 只对「有效节点」做（有协议 + 有服务器地址）—— parseSubscription 对 HTML 也会产出
  // 一堆 protocol=unknown、server="" 的假条目，把它们算进去会把 HTML 误判成重复节点。
  {
    const seen = new Map<string, string>()
    for (const sub of subscriptions) {
      for (const node of sub.nodes) {
        if (!node.protocol || node.protocol === "unknown" || !node.server) continue
        const fp = `${node.protocol}:${node.server}:${node.port ?? 0}`
        const first = seen.get(fp)
        if (first && first !== sub.name) {
          node.duplicateOf = first
        } else if (!first) {
          seen.set(fp, sub.name)
        }
      }
    }
  }

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
    /** 是否还有更多订阅源（懒加载分页） */
    hasMore,
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
  const user = await requireFeatureUser(env, request, "proxy")
  // ⚠️ 2026-09-25 审计（H8）：补上 isActivated 校验。
  // 其他用户侧接口（getProxyOverview）都先看 isActivated，这里原先没有 ——
  // 没启用功能的用户也能借这个接口触发对管理员订阅源的外网探测。
  if (!(await isActivated(env, user.id))) {
    throw new ApiError(403, "请先启用代理节点功能", "NOT_ACTIVATED")
  }
  await guardProxyFetch(env, user.id)
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

  const result = await probeSubscriptionUrl(env, row.url, true)

  if (result.ok) {
    await env.DB.prepare(
      "UPDATE proxy_subscriptions SET last_synced_at = ?, last_error = NULL, updated_at = ? WHERE id = ?"
    )
      .bind(new Date().toISOString(), new Date().toISOString(), row.id)
      .run()
  }

  return json(result)
}

/**
 * POST /api/proxy/latency —— **逐节点**测延迟（TCP 握手）。
 *
 * body: `{ id, offset?, limit? }`
 *   - `id`：订阅源 id。**地址不从客户端拿** —— 服务端自己重新抓该订阅再解析，
 *     这样入参里就没有任意 host:port，天然没有 SSRF 面。
 *   - `offset` / `limit`：在「可测速节点」列表里取哪一段。前端按批循环调用
 *     （平台每次请求最多 6 个并发连接，一次全测完会超限）。
 *
 * 返回里每个结果都带**原始节点下标**，前端据此把延迟填回对应那一行。
 *
 * ⚠️ 为什么不下「不可用」的结论：握手失败可能是本站 Worker 出网到该节点不通
 * （Cloudflare 封了部分目标 IP），也可能该节点只放行特定来源。所以失败一律是
 * 中性的「测不到」。这与捐献审核是同一条原则：**没能验证 ≠ 不可用**。
 */
export async function testProxyNodeLatency(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "proxy")
  if (!(await isActivated(env, user.id))) {
    throw new ApiError(403, "请先启用代理节点功能", "NOT_ACTIVATED")
  }
  // 单独计数：一次「全部测速」会打十几次请求，用 fetch 那个桶（30/分钟）会误伤
  await guardRateLimit(
    env,
    `proxy:latency:user:${user.id}`,
    60,
    60,
    "测速过于频繁，请稍等片刻再试"
  )

  const body = (await request.json().catch(() => ({}))) as {
    id?: string
    offset?: number
    limit?: number
  }
  const id = (body.id ?? "").trim()
  if (!id) throw new ApiError(400, "缺少订阅源 id", "INVALID_ID")

  const row = await visibleSubscriptions(env).then((list) => list.find((r) => r.id === id))
  if (!row) throw new ApiError(404, "订阅源不存在或已停用", "NOT_FOUND")

  let text = ""
  try {
    // 与订阅同步路径一致：这是**管理员配置**的地址 ⇒ 带凭据
    const res = await fetchSubscriptionText(env, row.url, true)
    if (!res.ok) {
      throw new ApiError(502, `订阅地址无法访问（HTTP ${res.status}）`, "PROXY_FETCH_FAILED")
    }
    text = res.text
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw new ApiError(
      502,
      `订阅地址抓取失败：${err instanceof Error ? err.message : String(err)}`,
      "PROXY_FETCH_FAILED"
    )
  }

  const nodes = usableNodes(parseSubscription(text))
  const allTargets = latencyTargets(nodes)
  const offset = Math.max(0, Math.trunc(Number(body.offset ?? 0)) || 0)
  const limit = Math.min(
    MAX_LATENCY_BATCH,
    Math.max(1, Math.trunc(Number(body.limit ?? MAX_LATENCY_BATCH)) || MAX_LATENCY_BATCH)
  )
  const slice = allTargets.slice(offset, offset + limit)

  let results: Awaited<ReturnType<typeof measureNodes>> = []
  try {
    results = await measureNodes(slice)
  } catch (err) {
    // 平台不支持 connect()（或其它运行时异常）→ 如实说，别让前端以为节点全挂了
    console.error("节点测速失败:", err)
    throw new ApiError(503, "服务端暂时无法做节点测速，请稍后再试", "LATENCY_UNAVAILABLE")
  }

  return json({
    /** 这个订阅里一共有多少节点 */
    total: nodes.length,
    /** 其中有多少个是「能用 TCP 握手测」的（其余是 QUIC/UDP，测不了） */
    testable: allTargets.length,
    offset,
    limit,
    tested: results.length,
    results: results.map((r) => ({
      index: r.index,
      ok: r.ok,
      latencyMs: r.latencyMs,
      reason: r.reason,
    })),
  })
}

/** 每个用户每天最多可以「获取原始订阅链接」的次数 */
const REVEAL_LIMIT_PER_DAY = 3
/** 与 rate_limits 的固定窗口语义一致：窗口按 UTC 零点对齐 */
const REVEAL_WINDOW_SECONDS = 86400

/**
 * POST /api/proxy/subscriptions/:id/reveal —— 按需下发订阅源原始 URL。
 *
 * ⚠️ 2026-09-26 审计（承接 09-25 的 H7）：原先 `GET /api/proxy` 会把每个订阅源的
 * 原始 URL（内嵌机场服务商的订阅 token）一次性下发给**所有**有 proxy 权限的用户。
 * 光在前端限制「复制」按钮是没用的 —— 用户开 DevTools 就能从响应里读到全部 URL。
 * 所以改成：列表接口不再返回 `url`，只在显式获取时下发，并按用户按天限流。
 */
export async function revealProxySubscriptionUrl(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const user = await requireFeatureUser(env, request, "proxy")

  const rl = await hitRateLimit(
    env,
    `proxy:reveal:user:${user.id}`,
    REVEAL_LIMIT_PER_DAY,
    REVEAL_WINDOW_SECONDS
  )
  if (!rl.ok) {
    throw new ApiError(
      429,
      `今天获取订阅链接的次数已用完（每天 ${rl.limit} 次），请明天再试`,
      "RATE_LIMITED"
    )
  }

  // 只允许拿到「启用中」的订阅源，避免用 id 探到已停用 / 已删除的
  const row = await env.DB.prepare(
    "SELECT * FROM proxy_subscriptions WHERE id = ? AND enabled = 1"
  )
    .bind(id)
    .first<ProxySubscriptionRow>()
  if (!row) throw new ApiError(404, "订阅源不存在", "NOT_FOUND")

  return json({
    id: row.id,
    url: row.url,
    /** 今日还可获取的次数（已扣掉本次） */
    remaining: Math.max(0, rl.limit - rl.count),
  })
}

// ---- 管理端 ----

async function requireAdminUser(env: Env, request: Request, permKey: string): Promise<UserRow> {
  const admin = await requireAdminScope(env, request, permKey)
  return admin as unknown as UserRow
}

function toAdminSubscription(row: ProxySubscriptionRow) {
  return {
    ...toPublicSubscription(row),
    // 管理端要能编辑订阅源，所以必须带上原始 URL（仅管理员接口可见）
    url: row.url,
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
  await requireAdminUser(env, request, "proxy.subscriptions")
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
  await requireAdminUser(env, request, "proxy.subscriptions")
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
  // ⚠️ 2026-09-25 审计（H8）：管理端地址原先只做了 scheme 检查，
  // 而 detectSubscriptionProfile 会立刻带 Bearer 去 fetch 它 ——
  // 内网地址（169.254.169.254 / 127.0.0.1 / 10.x）会被直接请求。
  // 只有管理员能写这条数据、且写操作有审计，所以这是纵深防御而非越权，
  // 但既然是「服务端请求用户提供的地址」，就该和其他出站路径同一口径。
  try {
    assertPublicHttpUrl(url, "订阅链接")
  } catch (err) {
    throw new ApiError(
      400,
      err instanceof Error ? err.message : "订阅链接不合法",
      "INVALID_INPUT"
    )
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
        enabled, sort_order, note, review_source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)`
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
  await requireAdminUser(env, request, "proxy.subscriptions")
  const existing = await env.DB.prepare(
    "SELECT id FROM proxy_subscriptions WHERE id = ?"
  )
    .bind(id)
    .first()
  if (!existing) throw new ApiError(404, "订阅源不存在", "NOT_FOUND")
  await env.DB.prepare("DELETE FROM proxy_subscriptions WHERE id = ?").bind(id).run()
  // 对称清理节点指纹，避免「已删订阅源」的指纹仍挡着后续导入
  await env.DB.prepare("DELETE FROM proxy_node_fingerprints WHERE subscription_id = ?").bind(id).run()
  return new Response(null, { status: 204 })
}