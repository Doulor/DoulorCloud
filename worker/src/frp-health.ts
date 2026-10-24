/**
 * frp 节点健康探测（2026-10-24）。
 *
 * 背景：北京节点停机那阵子，后台一直显示 `online` —— 因为 `frp_nodes.status`
 * 是 2026-09-22 手工写死之后再没人更新过，管理端等于在显示一个假状态。
 *
 * 这里每 5 分钟做两件事（由 cron 触发，见 index.ts 的 scheduled）：
 *   1. TCP 连一下节点的 `server_addr:server_port`（frps 的控制端口，默认 7000）
 *   2. 看 `frp_agent_state.last_seen_at`（服务端 agent 的心跳）
 * 两边都正常才算 online；端口通但心跳过期算 degraded（多半是 agent 挂了，
 * 但隧道可能还活着）；端口不通就是 offline。
 *
 * 注意：Worker 里没有 net 模块，TCP 用 `cloudflare:sockets` 的 connect()。
 */
import { connect } from "cloudflare:sockets"
import type { Env } from "./env"

/** 心跳多久没上报就算过期（分钟）。agent 大约每 1–2 分钟报一次。 */
export const HEARTBEAT_STALE_MINUTES = 10
/** TCP 探测超时（毫秒）。跨机房 5 秒足够，太长会拖慢 cron。 */
const TCP_TIMEOUT_MS = 5000

export type NodeStatus = "online" | "degraded" | "offline"

/**
 * 纯函数：决定节点状态。抽出来是为了能单测（socket 没法在单测里连真实主机）。
 *
 * @param tcpOk      控制端口是否连得通
 * @param lastSeenAt agent 心跳（ISO 字符串，可为空）
 * @param now        当前时间（毫秒）
 */
export function decideNodeStatus(
  tcpOk: boolean,
  lastSeenAt: string | null | undefined,
  now: number,
  staleMinutes: number = HEARTBEAT_STALE_MINUTES
): { status: NodeStatus; note: string } {
  if (!tcpOk) {
    return { status: "offline", note: "控制端口不可连（frps 未运行或网络不通）" }
  }
  if (!lastSeenAt) {
    return { status: "degraded", note: "控制端口正常，但 agent 从未上报过心跳" }
  }
  const seen = Date.parse(lastSeenAt)
  if (!Number.isFinite(seen)) {
    return { status: "degraded", note: "控制端口正常，但心跳时间无法解析" }
  }
  const mins = Math.floor((now - seen) / 60000)
  if (mins > staleMinutes) {
    return { status: "degraded", note: `控制端口正常，但 agent 已 ${mins} 分钟没有心跳` }
  }
  return { status: "online", note: "" }
}

/** 尝试 TCP 连接控制端口 */
async function probeTcp(host: string, port: number): Promise<boolean> {
  let socket: ReturnType<typeof connect> | null = null
  try {
    socket = connect({ hostname: host, port })
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), TCP_TIMEOUT_MS)
    )
    await Promise.race([socket.opened, timeout])
    return true
  } catch {
    return false
  } finally {
    try {
      socket?.close()
    } catch {
      /* 关不掉也无所谓，Worker 会回收 */
    }
  }
}

export interface ProbeResult {
  checked: number
  online: number
  degraded: number
  offline: number
  changes: number
}

/**
 * 探测所有**启用中**的节点并写回状态。
 * 未启用（enabled=0）的节点跳过 —— 那是管理员主动下线的，不该被探测覆盖。
 */
export async function probeFrpNodes(env: Env): Promise<ProbeResult> {
  const result: ProbeResult = { checked: 0, online: 0, degraded: 0, offline: 0, changes: 0 }
  let rows: { id: string; server_addr: string; server_port: number; status: string }[] = []
  try {
    const q = await env.DB.prepare(
      "SELECT id, server_addr, server_port, status FROM frp_nodes WHERE enabled = 1"
    ).all<{ id: string; server_addr: string; server_port: number; status: string }>()
    rows = q.results ?? []
  } catch {
    return result
  }

  const now = Date.now()
  for (const node of rows) {
    result.checked++
    let lastSeen: string | null = null
    try {
      const hb = await env.DB.prepare(
        "SELECT last_seen_at FROM frp_agent_state WHERE node_id = ?"
      )
        .bind(node.id)
        .first<{ last_seen_at: string | null }>()
      lastSeen = hb?.last_seen_at ?? null
    } catch {
      lastSeen = null
    }

    const tcpOk = await probeTcp(node.server_addr, Number(node.server_port) || 7000)
    const { status, note } = decideNodeStatus(tcpOk, lastSeen, now)
    result[status === "online" ? "online" : status === "degraded" ? "degraded" : "offline"]++

    /**
     * 每次都写回 —— 即使状态没变也要刷新 `status_updated_at`。
     *
     * 第一版只在「状态变了」时才写，结果 node-bj 一直挂着 9-22 的旧时间戳，
     * 管理端看不出到底有没有在探测（等于白做了这件事）。
     */
    try {
      const iso = new Date(now).toISOString()
      await env.DB.prepare(
        "UPDATE frp_nodes SET status = ?, status_note = ?, status_updated_at = ?, updated_at = ? WHERE id = ?"
      )
        .bind(status, note || null, iso, iso, node.id)
        .run()
      if (status !== node.status) result.changes++
    } catch {
      /* 写失败不影响其它节点 */
    }
  }
  return result
}
