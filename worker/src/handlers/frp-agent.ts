/**
 * frp-agent 通道：服务器侧的 agent 从这里拉「期望状态」，再把「实际状态」回报上来。
 *
 * 为什么需要这个反向通道（2026-10-13 实测确认，别再想着直连面板）：
 *   Cloudflare Worker **到不了** frps 服务器上的 frps-panel —— 裸 IP
 *   （`http://1.2.3.4:7200`）被 Cloudflare 出网策略拦截（1ms 返回 403，请求根本没有
 *   离开边缘）；改走域名时北京节点返回「Non-compliance ICP Filing」未备案拦截，
 *   香港节点 520。所以方向必须反过来：**服务器主动出网来拉**。
 *
 * 分工：
 *   · D1 是唯一真值 —— 谁可以用、用到什么时候、占哪些端口都在这边决定
 *   · agent 只负责把期望状态投影到面板，并把实际结果回报
 *   · 面板（frps-panel）退化成纯鉴权插件，不再需要人工登网页操作
 *
 * ⚠️ 安全边界：这两个端点**不使用会话鉴权**（调用方是服务器上的守护进程，没有 cookie），
 * 改用共享密钥 + HMAC-SHA256 签名 + 时间戳窗口。签名覆盖「时间戳 / 方法 / 路径+查询串 /
 * 请求体摘要」，因此：
 *   · 重放被时间戳窗口挡住
 *   · 路径与查询串不可替换（不能把 /desired 的签名挪到别的路径）
 *   · 请求体不可篡改
 * 未配置 `FRP_AGENT_SECRET` 时整个通道 503 关闭，不会退化成公开接口。
 */
import { ApiError, json } from "../http"
import { timingSafeEqual } from "../crypto"
import type { Env } from "../env"

/**
 * 本站创建的账号统一前缀。
 *
 * 🔴 **这个常量必须与服务器上 agent 的 `USER_PREFIX` 完全一致。**
 * 面板里存在 46 个管理员人工建的历史账号，agent 靠这个前缀区分
 * 「本站创建的账号」与「别人的账号」，从而保证 prune 时**绝不会误删他人账号**。
 * 实测这 46 个账号里没有任何一个以 `dcfrp_` 开头。
 */
const FRP_USER_PREFIX = "dcfrp_"

/** 允许的签名时间偏差（秒）。服务器时间与 Cloudflare 通常只差毫秒级，300s 已经很宽松。 */
const AGENT_TS_TOLERANCE_SEC = 300

interface NodeRow {
  id: string
  name: string
  server_addr: string
  server_port: number
  auth_mode: string | null
  enabled: number
}

interface SubscriptionRow {
  id: string
  user_id: string
  node_id: string
  frp_user: string
  frp_token: string
  ports: string
  status: string
  expires_at: string
}

export interface DesiredUser {
  user: string
  token: string
  comment: string
  enable: boolean
  ports: number[]
}

const encoder = new TextEncoder()

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input))
  return toHex(new Uint8Array(digest))
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message))
  return toHex(new Uint8Array(sig))
}

/**
 * 校验 agent 签名。
 *
 * @param rawBody 请求体原文（GET 传空串）。**调用方必须先把它读出来**——
 *   读流是一次性的，这里再读就永远为空，签名会永远对不上。
 */
async function requireAgent(env: Env, request: Request, rawBody: string): Promise<void> {
  const secret = env.FRP_AGENT_SECRET
  if (!secret) {
    throw new ApiError(
      503,
      "frp agent 通道未启用（未配置 FRP_AGENT_SECRET）",
      "FRP_AGENT_DISABLED"
    )
  }

  const ts = request.headers.get("X-Frp-Agent-Ts") ?? ""
  const sig = (request.headers.get("X-Frp-Agent-Signature") ?? "").toLowerCase()
  if (!ts || !sig) {
    throw new ApiError(401, "缺少 agent 签名头", "FRP_AGENT_UNAUTHORIZED")
  }

  const tsNum = Number(ts)
  if (!Number.isFinite(tsNum)) {
    throw new ApiError(401, "agent 时间戳格式不正确", "FRP_AGENT_UNAUTHORIZED")
  }
  const nowSec = Math.floor(Date.now() / 1000)
  if (Math.abs(nowSec - tsNum) > AGENT_TS_TOLERANCE_SEC) {
    throw new ApiError(
      401,
      `agent 时间戳超出 ±${AGENT_TS_TOLERANCE_SEC}s 容忍范围（差 ${
        nowSec - tsNum
      }s），请检查服务器时间`,
      "FRP_AGENT_CLOCK_SKEW"
    )
  }

  const url = new URL(request.url)
  // 查询串也要签：否则拿到 /desired?node=A 的签名后可以把 node 换成 B
  const canonical = [
    ts,
    request.method.toUpperCase(),
    `${url.pathname}${url.search}`,
    await sha256Hex(rawBody),
  ].join("\n")

  const expected = await hmacSha256Hex(secret, canonical)
  if (!timingSafeEqual(expected, sig)) {
    throw new ApiError(401, "agent 签名不匹配", "FRP_AGENT_UNAUTHORIZED")
  }
}

function parsePorts(raw: string): number[] {
  try {
    const v = JSON.parse(raw) as unknown
    if (!Array.isArray(v)) return []
    return v.filter((n): n is number => Number.isInteger(n))
  } catch {
    return []
  }
}

/**
 * 解析 agent 请求的节点。
 *
 * 显式传 `?node=<id>` 时用它；否则回落到「第一个启用了的、且需要每用户账号的节点」——
 * 这样单节点部署的 agent 不必带参数。
 */
async function resolveNode(env: Env, requested: string): Promise<NodeRow> {
  if (requested) {
    const row = await env.DB.prepare(
      `SELECT id, name, server_addr, server_port, auth_mode, enabled
         FROM frp_nodes WHERE id = ? LIMIT 1`
    )
      .bind(requested)
      .first<NodeRow>()
    if (!row) {
      throw new ApiError(404, `节点不存在：${requested}`, "FRP_NODE_NOT_FOUND")
    }
    return row
  }

  const row = await env.DB.prepare(
    `SELECT id, name, server_addr, server_port, auth_mode, enabled
       FROM frp_nodes
      WHERE enabled = 1 AND auth_mode IN ('token_user','custom')
      ORDER BY sort_order ASC LIMIT 1`
  ).first<NodeRow>()
  if (!row) {
    throw new ApiError(
      404,
      "没有可用于租用的节点（需要一个启用的、带每用户账号鉴权的节点）",
      "FRP_NODE_NOT_FOUND"
    )
  }
  return row
}

/**
 * `GET /frp/agent/desired` —— 拉期望状态。
 *
 * 返回**全部**本站管理的账号（包含已过期/已取消的，`enable=false`），而不是只返回有效的。
 * 原因：agent 需要知道「哪些账号是自己的」，才能在不误伤历史账号的前提下把它们停用。
 * 真正要删除一个账号时，是管理员在管理端删掉 `frp_subscriptions` 行，
 * agent 下一次收到 `prune=true` 且列表里没有它，才会从面板移除。
 */
export async function getFrpAgentDesired(env: Env, request: Request): Promise<Response> {
  await requireAgent(env, request, "")

  const url = new URL(request.url)
  const node = await resolveNode(env, url.searchParams.get("node") ?? "")

  const { results } = await env.DB.prepare(
    `SELECT id, user_id, node_id, frp_user, frp_token, ports, status, expires_at
       FROM frp_subscriptions
      WHERE node_id = ?
      ORDER BY frp_user ASC`
  )
    .bind(node.id)
    .all<SubscriptionRow>()

  const rows = results ?? []
  const now = Date.now()

  const users: DesiredUser[] = rows.map((row) => {
    const expiresAt = Date.parse(row.expires_at)
    // 只有 active 且未到期才允许连接。pending（刚下单、等待首次同步）先放行，
    // 否则用户付款后要等两轮同步才能连上；真正的拦截在过期判断上。
    const live =
      (row.status === "active" || row.status === "pending") &&
      Number.isFinite(expiresAt) &&
      expiresAt > now

    const expDate = Number.isFinite(expiresAt)
      ? new Date(expiresAt).toISOString().slice(0, 10)
      : "unknown"

    return {
      user: row.frp_user,
      token: row.frp_token,
      // 面板的 comment 是给人看的（管理员过去就是在这里手写到期日），
      // 所以这里也写成可读文本，便于以后直接看面板时一眼认出来。
      comment: `DoulorCloud | ${row.status} | 到期 ${expDate}`,
      enable: live,
      ports: parsePorts(row.ports),
    }
  })

  // 给 agent 一个内容指纹，让它能跳过没有变化的轮次（少打日志、少调面板接口）。
  const revision = (await sha256Hex(JSON.stringify(users))).slice(0, 16)

  return json({
    ok: true,
    revision,
    serverTime: new Date().toISOString(),
    /** agent 用这个前缀识别「本站创建的账号」，必须与代码里的常量一致 */
    userPrefix: FRP_USER_PREFIX,
    /** 是否清理「面板里有、但这张列表里没有」的本站账号 */
    prune: true,
    node: {
      id: node.id,
      name: node.name,
      serverAddr: node.server_addr,
      serverPort: node.server_port,
      authMode: node.auth_mode ?? "token",
    },
    users,
  })
}

interface AgentReportUser {
  user?: unknown
  enable?: unknown
  present?: unknown
  ports?: unknown
  error?: unknown
}

/**
 * `POST /frp/agent/report` —— 回报实际落地结果。
 *
 * 每行更新 `sync_state` / `synced_at` / `last_error`，管理端据此显示
 * 「D1 期望」vs「面板实际」是否一致 —— 这是替代「人工去面板肉眼比对」的关键观测点。
 */
export async function reportFrpAgentState(env: Env, request: Request): Promise<Response> {
  const raw = await request.text()
  await requireAgent(env, request, raw)

  let body: {
    node?: string
    revision?: string
    users?: AgentReportUser[]
    serverInfo?: Record<string, unknown>
    error?: string
  }
  try {
    body = JSON.parse(raw || "{}") as typeof body
  } catch {
    throw new ApiError(400, "报告体不是合法 JSON", "FRP_AGENT_BAD_REPORT")
  }

  const node = await resolveNode(env, typeof body.node === "string" ? body.node : "")

  const reported = Array.isArray(body.users) ? body.users : []
  const now = new Date().toISOString()

  const statements = reported
    .filter(
      (u): u is AgentReportUser & { user: string } =>
        typeof u.user === "string" && u.user.startsWith(FRP_USER_PREFIX)
    )
    .map((u) => {
      const present = u.present !== false
      const error = typeof u.error === "string" && u.error ? u.error : null
      const state = error ? "error" : present ? "synced" : "error"
      return env.DB.prepare(
        `UPDATE frp_subscriptions
            SET sync_state = ?, synced_at = ?, last_error = ?, updated_at = ?
          WHERE node_id = ? AND frp_user = ?`
      ).bind(
        state,
        now,
        error ?? (present ? null : "agent 报告该账号在面板中不存在"),
        now,
        node.id,
        u.user
      )
    })

  if (statements.length > 0) {
    await env.DB.batch(statements)
  }

  // 记录 agent 最近一次心跳与它看到的 frps 实况（管理端「在线实况」用）
  await env.DB.prepare(
    `INSERT INTO frp_agent_state (node_id, last_seen_at, revision, server_info, last_error, report_count)
     VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(node_id) DO UPDATE SET
       last_seen_at = excluded.last_seen_at,
       revision     = excluded.revision,
       server_info  = excluded.server_info,
       last_error   = excluded.last_error,
       report_count = frp_agent_state.report_count + 1`
  )
    .bind(
      node.id,
      now,
      typeof body.revision === "string" ? body.revision : null,
      body.serverInfo ? JSON.stringify(body.serverInfo) : null,
      typeof body.error === "string" ? body.error : null
    )
    .run()

  return json({ ok: true, applied: statements.length, serverTime: now })
}
