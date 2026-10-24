/**
 * frp 内网穿透 —— **管理端的节点 / 端口管理**（2026-10-13 起只剩这些）。
 *
 * ⚠️ 用户端的「提交申请 → 人工审核 → 管理员去 frps-panel 手工建号」那一整套
 * 已经**整体退役**。它被「积分租用」取代：
 *   · 用户端下单/续期 → handlers/frp-rental.ts
 *   · 管理端套餐与订阅 → handlers/frp-rental.ts
 *   · 真正落到面板上 → 服务器上的 frp-agent 轮询（handlers/frp-agent.ts）
 *   · 设计与取舍 → docs/内网穿透租用化改造方案.md
 *
 * 之所以要退役，两个硬理由：
 *   1. 这套流程要求管理员手工登 frps-panel 建号 —— 而那个面板的网页**本身已经是坏的**
 *      （gin-contrib/i18n 对空切片取 [0] 导致所有 HTML 路由 panic），根本打不开。
 *   2. 「人工审核 + 手工建号」不可能规模化，而租用是自助的。
 *
 * 保留在本文件里的东西仍然有用：
 *   · 节点管理（租用套餐要绑节点，管理端还要看节点列表）
 *   · 端口占用表的读写（frp-rental.ts 分配端口前会查 frp_ports，避免与存量占用撞号）
 *
 * 另注：Cloudflare Worker **无法访问** frps-panel ——
 *   裸 IP（http://1.2.3.4:7200）被出网策略拦截（1ms 返回 403 1003，请求根本没离开边缘）；
 *   走域名时北京节点返回 "Non-compliance ICP Filing" 未备案拦截，香港节点返回 520。
 *   这也是为什么整条链路必须由服务器侧主动来拉（见 frp-agent.ts）。
 */
import { ApiError, json } from "../http"
import { requireAdminScope } from "./admin"
import { uuid } from "../crypto"
import { type UserRow } from "../auth"
import { audit } from "../settings"
import { isFrpAuthMode } from "../frp-config"
import type { Env } from "../env"
interface FrpNodeRow {
  id: string
  name: string
  region: string | null
  server_addr: string
  server_port: number
  auth_token: string
  port_min: number
  port_max: number
  max_ports: number
  enabled: number
  sort_order: number
  note: string | null
  /** 节点状态：online | offline | maintenance | unknown（管理员手动维护） */
  status: string
  status_note: string | null
  status_updated_at: string | null
  /** 鉴权方式：none | token | token_user | custom（迁移 0054） */
  auth_mode: string | null
  /** 参数化后的配置模板（迁移 0054；空则用内置生成器） */
  config_template: string | null
  /** 来源捐献（迁移 0054；手工建节点为 NULL） */
  source_donation_id: string | null
}
/** 对外暴露的节点信息：**不含** auth.token（那是 frps 服务端密钥） */
function toPublicNode(row: FrpNodeRow) {
  return {
    id: row.id,
    name: row.name,
    region: row.region,
    serverAddr: row.server_addr,
    serverPort: row.server_port,
    portMin: row.port_min,
    portMax: row.port_max,
    maxPorts: row.max_ports,
    enabled: row.enabled === 1,
    note: row.note,
    status: row.status || "unknown",
    statusNote: row.status_note,
    statusUpdatedAt: row.status_updated_at,
    authMode: row.auth_mode || "token",
  }
}
// ---- 节点 ----
// ---- 申请 ----
// ---- 管理端：审核 ----
/** 管理员校验（与 handlers/admin.ts 同口径，root 也放行） */
async function requireAdminUser(env: Env, request: Request, permKey: string): Promise<UserRow> {
  const admin = await requireAdminScope(env, request, permKey)
  return admin as unknown as UserRow
}

// ---- 节点管理（管理端） ----

/** POST /api/admin/frp/nodes —— 新建/更新节点 */
export async function upsertFrpNode(env: Env, request: Request): Promise<Response> {
  await requireAdminUser(env, request, "frp.nodes")
  const body = (await request.json()) as {
    id?: string
    name?: string
    region?: string
    serverAddr?: string
    serverPort?: number
    authToken?: string
    portMin?: number
    portMax?: number
    maxPorts?: number
    enabled?: boolean
    sortOrder?: number
    note?: string
    status?: string
    statusNote?: string
    authMode?: string
  }

  const name = (body.name ?? "").trim()
  const serverAddr = (body.serverAddr ?? "").trim()
  if (!name) throw new ApiError(400, "请填写节点名称", "INVALID_INPUT")
  if (!serverAddr) throw new ApiError(400, "请填写 serverAddr", "INVALID_INPUT")

  const portMin = Math.trunc(Number(body.portMin ?? 20000))
  const portMax = Math.trunc(Number(body.portMax ?? 50000))
  if (portMin < 1 || portMax > 65535 || portMin >= portMax) {
    throw new ApiError(400, "端口范围无效", "INVALID_INPUT")
  }
  const maxPorts = Math.min(Math.max(Math.trunc(Number(body.maxPorts ?? 5)), 1), 50)
  const serverPort = Math.trunc(Number(body.serverPort ?? 7000))
  const authMode = isFrpAuthMode(body.authMode) ? body.authMode : "token"
  const now = new Date().toISOString()

  const values = {
    name,
    region: (body.region ?? "").trim() || null,
    serverAddr,
    serverPort,
    authToken: (body.authToken ?? "").trim(),
    portMin,
    portMax,
    maxPorts,
    enabled: body.enabled === false ? 0 : 1,
    sortOrder: Math.trunc(Number(body.sortOrder ?? 0)),
    note: (body.note ?? "").trim() || null,
    status: ["online", "degraded", "offline", "maintenance", "unknown"].includes(body.status ?? "")
      ? (body.status as string)
      : "unknown",
    statusNote: (body.statusNote ?? "").trim() || null,
    authMode,
  }

  if (body.id) {
    await env.DB.prepare(
      `UPDATE frp_nodes SET name=?, region=?, server_addr=?, server_port=?,
              auth_token=?, port_min=?, port_max=?, max_ports=?,
              enabled=?, sort_order=?, note=?, status=?, status_note=?,
              status_updated_at=?, auth_mode=?, updated_at=?
        WHERE id=?`
    )
      .bind(
        values.name, values.region, values.serverAddr, values.serverPort,
        values.authToken, values.portMin, values.portMax,
        values.maxPorts, values.enabled, values.sortOrder, values.note,
        values.status, values.statusNote, now, values.authMode, now,
        body.id
      )
      .run()
    return json({ id: body.id })
  }

  const id = uuid()
  await env.DB.prepare(
    `INSERT INTO frp_nodes
       (id, name, region, server_addr, server_port, auth_token,
        port_min, port_max, max_ports, enabled, sort_order, note,
        status, status_note, status_updated_at, auth_mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id, values.name, values.region, values.serverAddr, values.serverPort,
      values.authToken, values.portMin, values.portMax,
      values.maxPorts, values.enabled, values.sortOrder, values.note,
      values.status, values.statusNote, now, values.authMode, now, now
    )
    .run()

  return json({ id }, 201)
}

/** GET /api/admin/frp/nodes —— 节点列表（含 auth.token，仅管理员可见） */
export async function listFrpNodes(env: Env, request: Request): Promise<Response> {
  await requireAdminUser(env, request, "frp.nodes")
  const rows = await env.DB.prepare(
    "SELECT * FROM frp_nodes ORDER BY sort_order ASC, created_at ASC"
  ).all<FrpNodeRow>()
  const counts = await env.DB.prepare(
    "SELECT node_id, COUNT(*) AS c FROM frp_ports GROUP BY node_id"
  ).all<{ node_id: string; c: number }>()
  const usedMap: Record<string, number> = {}
  for (const r of counts.results ?? []) usedMap[r.node_id] = r.c

  return json({
    nodes: (rows.results ?? []).map((n) => ({
      ...toPublicNode(n),
      authToken: n.auth_token,
      configTemplate: n.config_template,
      sourceDonationId: n.source_donation_id,
      usedPorts: usedMap[n.id] ?? 0,
      statusNote: n.status_note,
    })),
  })
}

/** DELETE /api/admin/frp/nodes/:id */
export async function deleteFrpNode(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  await requireAdminUser(env, request, "frp.nodes")
  const existing = await env.DB.prepare("SELECT id FROM frp_nodes WHERE id = ?")
    .bind(id)
    .first()
  if (!existing) throw new ApiError(404, "节点不存在", "NOT_FOUND")
  await env.DB.prepare("DELETE FROM frp_nodes WHERE id = ?").bind(id).run()
  return new Response(null, { status: 204 })
}

/** POST /api/admin/frp/ports/release —— 释放某用户在某节点的端口 */
export async function releaseFrpPorts(
  env: Env,
  request: Request
): Promise<Response> {
  await requireAdminUser(env, request, "frp.ports")
  const body = (await request.json()) as { username?: string; nodeId?: string }
  const target = await env.DB.prepare(
    "SELECT id FROM users WHERE username = ? COLLATE NOCASE"
  )
    .bind(body.username ?? "")
    .first<{ id: string }>()
  if (!target) throw new ApiError(404, "用户不存在", "NOT_FOUND")

  const res = await env.DB.prepare(
    "DELETE FROM frp_ports WHERE user_id = ? AND node_id = ?"
  )
    .bind(target.id, body.nodeId ?? "")
    .run()

  return json({ released: res.meta.changes ?? 0 })
}

/**
 * 手动标记的占用端口，用这个哨兵当 `application_id`（区分于真实申请单）。
 * 来源是「站点上线前就存在、由站长在 frps-panel 里手工建的账号」——
 * 它们在站里没有申请单，但端口必须算已占用，否则新用户会选到同一个端口。
 */
const MANUAL_PORT_MARK = "manual"

/** GET /api/admin/frp/ports?nodeId=xxx —— 某节点已占用的端口（带来源，供管理面板展示） */
export async function listFrpPorts(env: Env, request: Request): Promise<Response> {
  await requireAdminUser(env, request, "frp.ports")
  const nodeId = new URL(request.url).searchParams.get("nodeId") ?? ""
  if (!nodeId) throw new ApiError(400, "缺少 nodeId", "INVALID_INPUT")

  const rows = await env.DB.prepare(
    `SELECT p.remote_port, p.application_id, u.username AS owner
       FROM frp_ports p
       LEFT JOIN users u ON u.id = p.user_id
      WHERE p.node_id = ?
      ORDER BY p.remote_port`
  )
    .bind(nodeId)
    .all<{ remote_port: number; application_id: string | null; owner: string | null }>()

  return json({
    ports: (rows.results ?? []).map((r) => ({
      port: r.remote_port,
      owner: r.owner,
      /** true = 站长手工标记的（无申请单）；false = 来自站内申请/用户 */
      manual: r.application_id === MANUAL_PORT_MARK,
    })),
  })
}

/** POST /api/admin/frp/ports/occupy —— 手动把一批端口标记为已占用（幂等） */
export async function occupyFrpPorts(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminUser(env, request, "frp.ports")
  const body = (await request.json()) as { nodeId?: string; ports?: unknown }
  const nodeId = body.nodeId ?? ""
  if (!nodeId) throw new ApiError(400, "缺少 nodeId", "INVALID_INPUT")

  const node = await env.DB.prepare("SELECT id FROM frp_nodes WHERE id = ?")
    .bind(nodeId)
    .first()
  if (!node) throw new ApiError(404, "节点不存在", "NOT_FOUND")

  const ports = [
    ...new Set(
      (Array.isArray(body.ports) ? body.ports : [])
        .map((p) => Math.trunc(Number(p)))
        .filter((p) => Number.isFinite(p) && p >= 1 && p <= 65535)
    ),
  ].sort((a, b) => a - b)
  if (ports.length === 0) throw new ApiError(400, "请至少填一个端口", "INVALID_PORTS")
  if (ports.length > 2000) {
    throw new ApiError(400, "一次最多标记 2000 个端口", "TOO_MANY_PORTS")
  }

  const now = new Date().toISOString()
  // INSERT OR IGNORE + 确定的 id：重复标记同一端口是幂等的（UNIQUE(node_id, remote_port) 兜底）
  await env.DB.batch(
    ports.map((p) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO frp_ports
           (id, node_id, user_id, application_id, remote_port, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(`manual-${nodeId}-${p}`, nodeId, admin.id, MANUAL_PORT_MARK, p, now)
    )
  )

  await audit(
    env,
    admin.id,
    "frp.ports.occupy",
    `节点 ${nodeId} 手动标记占用端口：${ports.join(",")}`
  )
  return json({ ok: true, count: ports.length })
}

/** POST /api/admin/frp/ports/free —— 解除一批端口的占用（含用户申请的端口，慎用） */
export async function freeFrpPorts(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminUser(env, request, "frp.ports")
  const body = (await request.json()) as { nodeId?: string; ports?: unknown }
  const nodeId = body.nodeId ?? ""
  const ports = [
    ...new Set(
      (Array.isArray(body.ports) ? body.ports : [])
        .map((p) => Math.trunc(Number(p)))
        .filter((p) => Number.isFinite(p) && p >= 1 && p <= 65535)
    ),
  ]
  if (!nodeId || ports.length === 0) {
    throw new ApiError(400, "缺少参数", "INVALID_INPUT")
  }

  const placeholders = ports.map(() => "?").join(",")
  const res = await env.DB.prepare(
    `DELETE FROM frp_ports WHERE node_id = ? AND remote_port IN (${placeholders})`
  )
    .bind(nodeId, ...ports)
    .run()

  await audit(
    env,
    admin.id,
    "frp.ports.free",
    `节点 ${nodeId} 解除端口占用：${ports.join(",")}`
  )
  return json({ ok: true, freed: res.meta.changes ?? 0 })
}