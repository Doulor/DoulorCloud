// 把 D1 的期望状态**主动推**到捐献节点的面板（2026-10-14）。
//
// 为什么需要这个模块：
//   我们自己的那台服务器上有 agent，它定时**拉** D1 的期望状态再写面板。
//   但捐献来的服务器上**没有 agent**（不该要求捐献者装一个常驻进程），
//   所以方向反过来：由 DoulorCloud 主动推。
//
// 🔴 必须同时有「推送」和「定期收敛」两件事，只做推送是不够的：
//   推送是**事件流**，丢一次就永久不一致（网络抖动、面板重启、Worker 冷启动
//   都可能丢）。所以每次写订阅后推一次是「尽快生效」，而定时收敛是「最终一致」。
//   只推不收敛，用户会遇到「我付了钱，但偶尔就是没开」—— 这种偶发最难查。
//
// 面板侧的接口是已知的（面板自研，我们两边都掌握）：
//   GET    /api/admin/accounts          列出全部
//   PUT    /api/admin/accounts/<user>   新增或覆盖
//   DELETE /api/admin/accounts/<user>   删除
//   鉴权：HMAC-SHA256，头 X-Frp-Agent-Ts / X-Frp-Agent-Signature
//   canonical = "\n".join([ts, METHOD, pathname+search, sha256hex(原始请求体)])
//
// ⚠️ 用**原始请求体的字节**算签名。先 JSON.parse 再 JSON.stringify 会改变键顺序，
//    签名就永远对不上 —— 这个坑在对接 agent 时已经踩过一次。
import type { Env } from "../env"

/** 单次推送的超时。捐献节点的网络质量不可控，不能把整个 Worker 拖死。 */
const PUSH_TIMEOUT_MS = 8000

interface NodeAccessRow {
  id: string
  server_addr: string
  panel_port: number | null
  panel_secret: string | null
  enabled: number
}

interface SubscriptionRow {
  frp_user: string
  frp_token: string
  ports: string
  status: string
  expires_at: string
}

export interface PushResult {
  ok: boolean
  nodeId: string
  pushed: number
  removed: number
  error?: string
  skipped?: string
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/** 发一个带 HMAC 签名的请求到捐献节点的面板 */
async function signedRequest(
  baseUrl: string,
  secret: string,
  method: string,
  path: string,
  bodyObj?: unknown
): Promise<{ status: number; text: string }> {
  const body = bodyObj === undefined ? new Uint8Array(0) : new TextEncoder().encode(JSON.stringify(bodyObj))
  const ts = String(Math.floor(Date.now() / 1000))
  const canonical = [ts, method.toUpperCase(), path, await sha256Hex(body)].join("\n")
  const sig = await hmacSha256Hex(secret, canonical)

  const init: RequestInit = {
    method,
    headers: {
      "X-Frp-Agent-Ts": ts,
      "X-Frp-Agent-Signature": sig,
    },
  }
  if (bodyObj !== undefined) {
    ;(init.headers as Record<string, string>)["Content-Type"] = "application/json"
    init.body = body
  }

  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), PUSH_TIMEOUT_MS)
  try {
    const res = await fetch(baseUrl + path, { ...init, signal: ctl.signal })
    const text = await res.text()
    return { status: res.status, text: text.slice(0, 500) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把某个节点的期望状态推过去。
 *
 * 幂等：只写「应该存在」的账号，再删掉「面板上有但不该有」的托管账号。
 * 不托管账号（非 DC_ 前缀）一律不碰 —— 捐献者可能自己在那台面板上建了别的账号，
 * 我们没有权力删。
 */
export async function pushNodeState(env: Env, nodeId: string): Promise<PushResult> {
  const node = await env.DB.prepare(
    `SELECT id, server_addr, panel_port, panel_secret, enabled FROM frp_nodes WHERE id = ? LIMIT 1`
  )
    .bind(nodeId)
    .first<NodeAccessRow>()

  if (!node) return { ok: false, nodeId, pushed: 0, removed: 0, error: "节点不存在" }
  if (!node.panel_port || !node.panel_secret) {
    return { ok: false, nodeId, pushed: 0, removed: 0, skipped: "该节点没有面板接入信息（非一键捐献而来）" }
  }
  if (!node.enabled) {
    return { ok: false, nodeId, pushed: 0, removed: 0, skipped: "节点已停用" }
  }

  const baseUrl = `http://${node.server_addr}:${node.panel_port}`
  const secret = node.panel_secret
  const now = Date.now()

  const rows = await env.DB.prepare(
    `SELECT frp_user, frp_token, ports, status, expires_at
       FROM frp_subscriptions WHERE node_id = ?`
  )
    .bind(nodeId)
    .all<SubscriptionRow>()

  const subs = rows.results ?? []
  const desired: Record<string, { token: string; ports: number[]; enable: boolean }> = {}
  for (const s of subs) {
    const expires = Date.parse(s.expires_at)
    const live = (s.status === "active" || s.status === "pending") &&
      Number.isFinite(expires) && expires > now
    let ports: number[] = []
    try {
      const parsed = JSON.parse(s.ports)
      if (Array.isArray(parsed)) ports = parsed.filter((n) => Number.isInteger(n))
    } catch {
      /* 端口快照坏掉时按空处理，宁可少授权也不多授权 */
    }
    desired[s.frp_user] = { token: s.frp_token, ports, enable: live }
  }

  let pushed = 0
  let removed = 0
  const errors: string[] = []

  // 先读面板现状，才能算出要删哪些
  let existing: string[] = []
  try {
    const listed = await signedRequest(baseUrl, secret, "GET", "/api/admin/accounts")
    if (listed.status !== 200) {
      errors.push(`读取面板账号失败 HTTP ${listed.status}`)
    } else {
      const parsed = JSON.parse(listed.text) as { accounts?: { user?: string }[] }
      existing = (parsed.accounts ?? [])
        .map((a) => String(a.user ?? ""))
        .filter((u) => u.startsWith("DC_"))
    }
  } catch (err) {
    errors.push(`读取面板账号异常：${err instanceof Error ? err.message : String(err)}`)
  }

  // 写「应该存在的」
  for (const [user, want] of Object.entries(desired)) {
    try {
      const res = await signedRequest(baseUrl, secret, "PUT", `/api/admin/accounts/${encodeURIComponent(user)}`, {
        user,
        token: want.token,
        ports: want.ports,
        enable: want.enable,
        comment: "DoulorCloud",
      })
      if (res.status === 200) pushed++
      else errors.push(`${user} HTTP ${res.status} ${res.text.slice(0, 120)}`)
    } catch (err) {
      errors.push(`${user} 异常：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 删「面板上有但 D1 里没有的」托管账号（只删 DC_ 前缀，别碰捐献者自己的账号）
  for (const user of existing) {
    if (user in desired) continue
    try {
      const res = await signedRequest(baseUrl, secret, "DELETE", `/api/admin/accounts/${encodeURIComponent(user)}`)
      if (res.status === 200) removed++
      else errors.push(`删除 ${user} HTTP ${res.status}`)
    } catch (err) {
      errors.push(`删除 ${user} 异常：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const error = errors.length ? errors.slice(0, 5).join("；") : null
  await env.DB.prepare(
    `UPDATE frp_nodes SET last_push_at = ?, last_push_error = ?, updated_at = ? WHERE id = ?`
  )
    .bind(new Date().toISOString(), error, new Date().toISOString(), nodeId)
    .run()

  return { ok: !error, nodeId, pushed, removed, error: error ?? undefined }
}

/**
 * 定期收敛：把所有「有一键捐献面板信息」的节点都推一遍。
 *
 * 这是最终一致性的保证 —— 单次推送丢了，最多一个收敛周期后自动补上。
 */
export async function reconcileAllNodes(env: Env): Promise<{ nodes: number; pushed: number; failed: number }> {
  const rows = await env.DB.prepare(
    `SELECT id FROM frp_nodes
      WHERE enabled = 1 AND panel_port IS NOT NULL AND panel_secret IS NOT NULL`
  ).all<{ id: string }>()

  let pushed = 0
  let failed = 0
  for (const row of rows.results ?? []) {
    const r = await pushNodeState(env, row.id)
    if (r.ok) pushed++
    else failed++
  }
  return { nodes: (rows.results ?? []).length, pushed, failed }
}
