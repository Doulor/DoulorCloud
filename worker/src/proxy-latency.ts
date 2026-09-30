/**
 * 代理节点的**逐节点**延迟测试（TCP 握手）。
 *
 * 为什么是 TCP 握手，而不是 Clash 那种「经节点转发一次 HTTP 请求」：
 *   Clash 本地有代理内核，能真的把请求从节点送出去；而 Cloudflare Worker 只有
 *   出站 HTTP 与出站 TCP（`cloudflare:sockets`），**没有代理内核**，也建不了
 *   UDP 连接。所以在 Worker 里做不到「完整代理延迟」。
 *   但「节点的 server:port 能不能连上、握手要几毫秒」是纯 TCP 就能测的 —— 这已经
 *   能把死节点和慢节点分出来，也就是用户实际要的那个能力（原来的实现只探活
 *   **订阅地址**本身，测不到任何一个具体节点）。
 *
 * ⚠️ 三条必须守住的边界（否则会造出比没有更糟的误导）：
 *   1. **UDP/QUIC 类协议测不了**（hysteria / hysteria2 / tuic）—— Worker 建不了
 *      UDP 连接。这类节点标「不支持测速」，**绝不能报成不可用**。
 *   2. **握手失败 ≠ 节点不可用**。可能是本站 Worker 出网到该节点不通
 *      （Cloudflare 自己封了部分目标 IP，见下），或节点只允许特定来源。
 *      所以失败一律用中性文案（「测不到」），不写「不可用」。
 *   3. 平台硬限制：**每次请求最多 6 个并发连接**（与 fetch 共用同一个池，
 *      Free/Paid 都一样），`connect()` 也**没有内置超时**，必须自己 race。
 *      ⇒ 并发取 4（给订阅抓取那次 fetch 留位），并逐批关闭 socket。
 */
import { connect } from "cloudflare:sockets"
import { mapLimit } from "./async-utils"

/**
 * 能通过 TCP 握手测速的协议。
 * 这些都是「TCP 承载」的：vless / vmess / trojan / ss / ssr / anytls。
 * 不在表里的（hysteria / hysteria2 / tuic）走 QUIC/UDP，Worker 建不了连接。
 */
const TCP_PROTOCOLS = new Set(["vless", "vmess", "trojan", "ss", "ssr", "anytls"])

/** 该协议的节点能不能用 TCP 握手测延迟；不能测的必须标「不支持」，而不是「不可用」 */
export function isLatencyTestable(protocol: string): boolean {
  return TCP_PROTOCOLS.has((protocol ?? "").trim().toLowerCase())
}

/** 单节点握手超时（毫秒）。`connect()` 没有内置超时，全靠这个 race */
export const LATENCY_TIMEOUT_MS = 3000

/**
 * 并发度。平台每次请求最多 6 个并发连接（fetch 与 connect 共用），
 * 而本接口在测速前还要 fetch 一次订阅 —— 取 4 留出余量。
 */
export const LATENCY_CONCURRENCY = 4

/** 一次请求最多测多少个节点（每个都要真建连接；前端按批循环调用） */
export const MAX_LATENCY_BATCH = 16

/** 一个待测目标 */
export interface LatencyTarget {
  /** 该节点在**订阅原始节点列表**里的下标 —— 前端据此把结果填回那一行 */
  index: number
  host: string
  port: number
}

export interface LatencyResult {
  index: number
  host: string
  port: number
  ok: boolean
  /** ok=true 时的 TCP 握手耗时（毫秒） */
  latencyMs: number | null
  /** ok=false 时面向用户的原因（中性措辞，不下「不可用」的结论） */
  reason: string
}

/** socket 的最小形状（抽出来是为了让测试能注入假实现） */
export interface SocketLike {
  opened: Promise<unknown>
  close: () => Promise<void>
}

/** 可注入的连接器；默认用运行时的 `cloudflare:sockets` */
export type TcpConnector = (address: { hostname: string; port: number }) => SocketLike

const defaultConnector: TcpConnector = (address) => connect(address)

/**
 * IPv6 字面量在节点链接里写作 `[::1]`（见 parseAuthorityLink），
 * 但 `connect()` 要的是不带方括号的地址。
 */
export function normalizeHost(host: string): string {
  return (host ?? "").trim().replace(/^\[/, "").replace(/\]$/, "")
}

/**
 * 测一次 TCP 握手。**不抛错** —— 失败一律归成可读原因。
 * 超时用 `Promise.race` 自己兜（平台无内置超时），socket 在 finally 里关掉
 * （不关会累积到第 7 个并发连接而触发平台限制）。
 */
export async function measureTcpHandshake(
  host: string,
  port: number,
  opts: { timeoutMs?: number; connector?: TcpConnector } = {}
): Promise<{ ok: boolean; latencyMs: number | null; reason: string }> {
  const timeoutMs = opts.timeoutMs ?? LATENCY_TIMEOUT_MS
  const connector = opts.connector ?? defaultConnector
  const hostname = normalizeHost(host)
  if (!hostname || !Number.isFinite(port) || port <= 0) {
    return { ok: false, latencyMs: null, reason: "节点缺少地址或端口" }
  }

  const started = Date.now()
  let socket: SocketLike | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    socket = connector({ hostname, port })
    await Promise.race([
      socket.opened,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("__latency_timeout__")), timeoutMs)
      }),
    ])
    return { ok: true, latencyMs: Date.now() - started, reason: "" }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      latencyMs: null,
      reason:
        msg === "__latency_timeout__"
          ? `超时（${Math.round(timeoutMs / 1000)} 秒内没连上）`
          : "本站未能连上该地址",
    }
  } finally {
    if (timer) clearTimeout(timer)
    try {
      await socket?.close()
    } catch {
      /* 关闭失败无所谓，请求结束平台也会回收 */
    }
  }
}

/**
 * 从解析出的节点里挑出**可测速**的，并保留它们在原列表里的下标。
 * 前端拿到的结果按下标回填，所以这里必须用原下标 —— 不能是筛完之后的顺序。
 */
export function latencyTargets(
  nodes: readonly { protocol: string; server: string; port: number | null }[]
): LatencyTarget[] {
  const out: LatencyTarget[] = []
  nodes.forEach((n, index) => {
    if (!isLatencyTestable(n.protocol)) return
    if (!n.server || !n.port) return
    out.push({ index, host: normalizeHost(n.server), port: n.port })
  })
  return out
}

/**
 * 批量测速。
 * ⚠️ `connect()` 必须在**请求处理过程中**创建（平台要求），本函数只在 handler 里被调用。
 */
export async function measureNodes(
  targets: LatencyTarget[],
  opts: { timeoutMs?: number; concurrency?: number; connector?: TcpConnector } = {}
): Promise<LatencyResult[]> {
  if (targets.length === 0) return []
  const timeoutMs = opts.timeoutMs ?? LATENCY_TIMEOUT_MS
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? LATENCY_CONCURRENCY, 6))
  const connector = opts.connector ?? defaultConnector

  return mapLimit(targets, concurrency, async (t) => {
    const r = await measureTcpHandshake(t.host, t.port, { timeoutMs, connector })
    return { index: t.index, host: t.host, port: t.port, ...r }
  })
}
