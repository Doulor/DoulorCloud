// 内网穿透 agent 通道（2026-10-13）。
//
// 背景：Cloudflare Worker **到不了** frps 服务器上的 frps-panel（实测裸 IP 被出网策略
// 403、走域名撞未备案拦截），所以改成「服务器上的守护进程主动出网来拉」。
// 这条通道的调用方没有 cookie、也不该有用户身份，**它的安全边界完全落在 HMAC 签名上**。
//
// 因此这里把每一条拒绝路径都钉住 —— 少一条，整条通道就等于对公网敞开：
//   · 没有签名头 / 没有时间戳        → 401
//   · 签名不对                       → 401
//   · 时间戳超出窗口（重放）         → 401
//   · 把 ?node=A 的签名挪去请求 ?node=B → 401（证明查询串确实在签名覆盖范围内）
//
// 另外钉两条业务语义：
//   · 过期订阅必须以 enable=false 下发 —— agent 据此**停用**而不是删号，
//     这样历史账号与端口信息不会丢
//   · report 必须把同步状态回写到 frp_subscriptions 与 frp_agent_state
//     （管理端的「期望 vs 实际」观测点全靠它）
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { uuid } from "../src/crypto"
import { fetchSelf, makeUser } from "./helpers"

const SECRET = "test-frp-agent-secret-1234"
const enc = new TextEncoder()

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("")

async function sha256Hex(input: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(input))))
}

/** 与 handlers/frp-agent.ts 的 requireAgent() 逐字对应 */
async function sign(
  ts: string,
  method: string,
  pathWithQuery: string,
  body: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const canonical = [ts, method.toUpperCase(), pathWithQuery, await sha256Hex(body)].join("\n")
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(canonical))))
}

async function agentCall(opts: {
  method: "GET" | "POST"
  path: string
  body?: string
  ts?: string
  /** 直接指定签名（测拒绝路径用）；不给则按 canonical 现算 */
  signature?: string
  omitSignature?: boolean
  omitTimestamp?: boolean
}): Promise<Response> {
  const body = opts.body ?? ""
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000))
  const headers = new Headers()
  if (!opts.omitTimestamp) headers.set("X-Frp-Agent-Ts", ts)
  if (!opts.omitSignature) {
    headers.set(
      "X-Frp-Agent-Signature",
      opts.signature ?? (await sign(ts, opts.method, opts.path, body))
    )
  }
  if (body) headers.set("Content-Type", "application/json")
  return fetchSelf(
    new Request(`https://cloud.doulor.cn${opts.path}`, {
      method: opts.method,
      headers,
      body: body || undefined,
    })
  )
}

interface DesiredUser {
  user: string
  token: string
  enable: boolean
  ports: number[]
  comment: string
}
interface DesiredBody {
  ok: boolean
  revision: string
  userPrefix: string
  node: { id: string }
  users: DesiredUser[]
}

/** 每个用例独立节点，避免 D1 在用例间共享造成串扰 */
async function seedNode(authMode = "token_user"): Promise<string> {
  const id = `n_${uuid().slice(0, 8)}`
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO frp_nodes
       (id, name, server_addr, server_port, auth_token, token_prefix,
        port_min, port_max, max_ports, enabled, sort_order, auth_mode, created_at, updated_at)
     VALUES (?, '测试节点', 'frp.test', 7000, 'shared-secret', '', 30000, 31000, 5, 1, 0, ?, ?, ?)`
  )
    .bind(id, authMode, now, now)
    .run()
  return id
}

async function seedSubscription(opts: {
  nodeId: string
  userId: string
  frpUser: string
  ports: number[]
  status?: string
  /** 相对现在的到期偏移（毫秒）；负数表示已过期 */
  expiresInMs?: number
}): Promise<string> {
  const id = uuid()
  const now = Date.now()
  const stamp = new Date(now - 86_400_000).toISOString()
  const expiresAt = new Date(now + (opts.expiresInMs ?? 30 * 86_400_000)).toISOString()
  await env.DB.prepare(
    `INSERT INTO frp_subscriptions
       (id, user_id, node_id, plan_id, frp_user, frp_token, ports, status,
        started_at, expires_at, auto_renew, price_points, sync_state, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 0, 100, 'pending', ?, ?)`
  )
    .bind(
      id,
      opts.userId,
      opts.nodeId,
      opts.frpUser,
      `tok${Math.random().toString(36).slice(2, 10)}`,
      JSON.stringify(opts.ports),
      opts.status ?? "active",
      stamp,
      expiresAt,
      stamp,
      stamp
    )
    .run()
  return id
}

describe("frp-agent 通道", () => {
  it("签名正确时下发期望状态，并声明本站账号前缀", async () => {
    const nodeId = await seedNode()
    const user = await makeUser()
    const frpUser = `DC_${uuid().slice(0, 8)}`
    await seedSubscription({ nodeId, userId: user.id, frpUser, ports: [30001, 30002] })

    const res = await agentCall({ method: "GET", path: `/frp/agent/desired?node=${nodeId}` })
    expect(res.status).toBe(200)

    const body = (await res.json()) as DesiredBody
    expect(body.ok).toBe(true)
    expect(body.node.id).toBe(nodeId)
    // agent 靠这个前缀区分「本站创建的账号」与面板里 46 个历史账号
    expect(body.userPrefix).toBe("DC_")
    expect(body.revision).toMatch(/^[0-9a-f]{16}$/)

    const mine = body.users.find((u) => u.user === frpUser)
    expect(mine).toBeDefined()
    expect(mine!.enable).toBe(true)
    expect(mine!.ports).toEqual([30001, 30002])
    // 面板 comment 是给人看的（管理员过去就在这里手写到期日）
    expect(mine!.comment).toContain("DoulorCloud")
  })

  it("已过期的订阅以 enable=false 下发（停用而非删号）", async () => {
    const nodeId = await seedNode()
    const user = await makeUser()
    const frpUser = `DC_${uuid().slice(0, 8)}`
    await seedSubscription({
      nodeId,
      userId: user.id,
      frpUser,
      ports: [30003],
      expiresInMs: -3_600_000,
    })

    const res = await agentCall({ method: "GET", path: `/frp/agent/desired?node=${nodeId}` })
    expect(res.status).toBe(200)
    const body = (await res.json()) as DesiredBody
    const mine = body.users.find((u) => u.user === frpUser)
    expect(mine).toBeDefined()
    expect(mine!.enable).toBe(false)
  })

  it("没有签名头 → 401", async () => {
    const nodeId = await seedNode()
    const res = await agentCall({
      method: "GET",
      path: `/frp/agent/desired?node=${nodeId}`,
      omitSignature: true,
    })
    expect(res.status).toBe(401)
  })

  it("签名不对 → 401", async () => {
    const nodeId = await seedNode()
    const res = await agentCall({
      method: "GET",
      path: `/frp/agent/desired?node=${nodeId}`,
      signature: "0".repeat(64),
    })
    expect(res.status).toBe(401)
  })

  it("时间戳超出窗口 → 401 并提示时钟（挡住重放）", async () => {
    const nodeId = await seedNode()
    const stale = String(Math.floor(Date.now() / 1000) - 3600)
    const res = await agentCall({
      method: "GET",
      path: `/frp/agent/desired?node=${nodeId}`,
      ts: stale,
    })
    expect(res.status).toBe(401)
    const text = await res.text()
    expect(text).toContain("时间戳")
  })

  it("查询串在签名覆盖范围内：?node=A 的签名不能用来请求 ?node=B", async () => {
    const nodeA = await seedNode()
    const nodeB = await seedNode()
    const ts = String(Math.floor(Date.now() / 1000))
    const sigForA = await sign(ts, "GET", `/frp/agent/desired?node=${nodeA}`, "")

    const res = await agentCall({
      method: "GET",
      path: `/frp/agent/desired?node=${nodeB}`,
      ts,
      signature: sigForA,
    })
    expect(res.status).toBe(401)
  })

  it("report 回写同步状态与心跳（管理端「期望 vs 实际」观测点）", async () => {
    const nodeId = await seedNode()
    const user = await makeUser()
    const frpUser = `DC_${uuid().slice(0, 8)}`
    await seedSubscription({ nodeId, userId: user.id, frpUser, ports: [30004] })

    const payload = JSON.stringify({
      node: nodeId,
      revision: "deadbeefdeadbeef",
      users: [{ user: frpUser, present: true, enable: true, ports: [30004] }],
      serverInfo: { clientCounts: 11, proxyTypeCount: { tcp: 42, udp: 4 } },
    })

    const res = await agentCall({ method: "POST", path: "/frp/agent/report", body: payload })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; applied: number }
    expect(body.ok).toBe(true)
    expect(body.applied).toBe(1)

    const sub = await env.DB.prepare(
      `SELECT sync_state, synced_at, last_error FROM frp_subscriptions WHERE frp_user = ?`
    )
      .bind(frpUser)
      .first<{ sync_state: string; synced_at: string | null; last_error: string | null }>()
    expect(sub?.sync_state).toBe("synced")
    expect(sub?.synced_at).toBeTruthy()
    expect(sub?.last_error).toBeNull()

    const hb = await env.DB.prepare(
      `SELECT last_seen_at, revision, report_count FROM frp_agent_state WHERE node_id = ?`
    )
      .bind(nodeId)
      .first<{ last_seen_at: string; revision: string; report_count: number }>()
    expect(hb?.revision).toBe("deadbeefdeadbeef")
    expect(hb?.report_count).toBe(1)
  })

  it("report 里 agent 报错的账号被记为 error 并保留原因", async () => {
    const nodeId = await seedNode()
    const user = await makeUser()
    const frpUser = `DC_${uuid().slice(0, 8)}`
    await seedSubscription({ nodeId, userId: user.id, frpUser, ports: [30005] })

    const payload = JSON.stringify({
      node: nodeId,
      users: [{ user: frpUser, present: false, error: "panel 返回 token format error" }],
    })
    const res = await agentCall({ method: "POST", path: "/frp/agent/report", body: payload })
    expect(res.status).toBe(200)

    const sub = await env.DB.prepare(
      `SELECT sync_state, last_error FROM frp_subscriptions WHERE frp_user = ?`
    )
      .bind(frpUser)
      .first<{ sync_state: string; last_error: string | null }>()
    expect(sub?.sync_state).toBe("error")
    expect(sub?.last_error).toContain("token format error")
  })

  it("report 里非本站前缀的账号一律忽略（绝不碰别人的账号）", async () => {
    const nodeId = await seedNode()
    const user = await makeUser()
    const frpUser = `DC_${uuid().slice(0, 8)}`
    await seedSubscription({ nodeId, userId: user.id, frpUser, ports: [30006] })

    const payload = JSON.stringify({
      node: nodeId,
      users: [
        { user: "Doulor", present: false, error: "不该被处理" },
        { user: "someone_else", present: false },
      ],
    })
    const res = await agentCall({ method: "POST", path: "/frp/agent/report", body: payload })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { applied: number }
    expect(body.applied).toBe(0)

    // 本站账号的状态不受影响（仍是最初的 pending）
    const sub = await env.DB.prepare(
      `SELECT sync_state FROM frp_subscriptions WHERE frp_user = ?`
    )
      .bind(frpUser)
      .first<{ sync_state: string }>()
    expect(sub?.sync_state).toBe("pending")
  })
})
