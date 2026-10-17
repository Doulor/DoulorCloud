// 推送到捐献节点面板（2026-10-14）。
//
// 这个文件存在的唯一理由：**跨端签名的口径必须是逐字节一致的**。
// DoulorCloud 用 TS 签，面板用 Python 验。任何一处对不上，表现都是
// 「推送返回 401，账号永远进不去面板」，而且两边的日志都只会说"签名不对"，
// 不会告诉你差在哪一个字节。
//
// 所以这里的做法是：起一个 **stub**，它按面板 `verify_agent_request()` 的口径
// 逐字复刻校验（canonical 用 \n 连接 ts / METHOD / path含query / sha256hex(原始body)），
// 然后断言推送真的能通过。签名算法错、头名写错、body 被重新序列化 —— 都会当场红。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { env } from "cloudflare:workers"
import { uuid } from "../src/crypto"
import { pushNodeState, reconcileAllNodes } from "../src/handlers/frp-node-push"
import { makeUser } from "./helpers"

const SECRET = "panel-secret-for-test-0123456789"
/** 面板那边的容差是 300 秒；这里也照着来，顺带验证时间戳单位是「秒」不是「毫秒」 */
const TS_TOLERANCE_SEC = 300

interface Captured {
  method: string
  path: string
  ts: string
  sig: string
  body: string
  signatureValid: boolean
  rejectReason?: string
}

let captured: Captured[] = []
/**
 * **按主机分开**的面板账号表。
 *
 * ⚠️ 必须按 host 分开：如果所有节点共用一份账号表，那节点 B 推送时会把节点 A
 *    的账号当成"多余的"删掉 —— 测试里会出现「A 刚推上去就被 B 删了」的假象，
 *    让人误以为推送逻辑错了。真实世界里每台机器是**不同的面板**，测试也得这么模拟。
 */
let panels: Record<string, string[]> = []

/** 取某个面板当前的账号（按 host:port 区分） */
function panelOf(host: string): string[] {
  if (!panels[host]) panels[host] = []
  return panels[host]
}
/** 兼容旧断言：所有面板的账号合起来 */
function allPanelAccounts(): string[] {
  return Object.values(panels).flat()
}

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("")
}

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  )
  const s = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg))
  return Array.from(new Uint8Array(s)).map((b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * 按面板的口径校验一次请求。
 * 复刻自 frp-panel/panel.py 的 verify_agent_request()。
 */
async function verifyLikePanel(
  method: string,
  pathWithQuery: string,
  headers: Record<string, string>,
  rawBody: string
): Promise<{ ok: boolean; reason?: string }> {
  const ts = headers["X-Frp-Agent-Ts"] || ""
  const sig = (headers["X-Frp-Agent-Signature"] || "").toLowerCase()
  if (!ts || !sig) return { ok: false, reason: "missing" }
  const tsInt = Number.parseInt(ts, 10)
  if (!Number.isFinite(tsInt)) return { ok: false, reason: "bad_ts" }
  // 单位必须是「秒」。用毫秒的话这里会算出几万天的偏差，直接判 stale。
  if (Math.abs(Date.now() / 1000 - tsInt) > TS_TOLERANCE_SEC) return { ok: false, reason: "stale_ts" }
  const canonical = [ts, method.toUpperCase(), pathWithQuery, await sha256Hex(rawBody)].join("\n")
  const want = await hmacHex(SECRET, canonical)
  return want === sig ? { ok: true } : { ok: false, reason: "bad_signature" }
}

function installStub() {
  captured = []
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const u = new URL(url)
    const method = (init?.method || "GET").toUpperCase()
    const headers: Record<string, string> = {}
    const raw = init?.headers as Record<string, string> | undefined
    if (raw) for (const [k, v] of Object.entries(raw)) headers[k] = String(v)

    // 取原始 body 字节 —— 必须是面板收到的那份，不能重新序列化
    let body = ""
    if (init?.body) {
      if (typeof init.body === "string") body = init.body
      else if (init.body instanceof Uint8Array) body = new TextDecoder().decode(init.body)
      else body = JSON.stringify(init.body)
    }

    const verdict = await verifyLikePanel(method, u.pathname + u.search, headers, body)
    captured.push({
      method, path: u.pathname, ts: headers["X-Frp-Agent-Ts"] || "",
      sig: headers["X-Frp-Agent-Signature"] || "", body,
      signatureValid: verdict.ok, rejectReason: verdict.reason,
    })

    if (!verdict.ok) return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), { status: 401 })

    // 按 hostname（纯 IP）分面板，不带端口 —— 一台机器只有一个面板，面板端口属于节点配置。
    const accounts = panelOf(u.hostname)
    if (method === "GET" && u.pathname === "/api/admin/accounts") {
      return new Response(
        JSON.stringify({ accounts: accounts.map((user) => ({ user })) }),
        { status: 200 }
      )
    }
    if (method === "PUT" && u.pathname.startsWith("/api/admin/accounts/")) {
      const user = decodeURIComponent(u.pathname.split("/").pop() || "")
      if (!accounts.includes(user)) accounts.push(user)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    if (method === "DELETE" && u.pathname.startsWith("/api/admin/accounts/")) {
      const user = decodeURIComponent(u.pathname.split("/").pop() || "")
      const idx = accounts.indexOf(user)
      if (idx >= 0) accounts.splice(idx, 1)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  })
}

/** 造一个带面板接入信息的节点。每台机器一个独立 IP —— 同一个 IP 只能有一个节点 */
let nodeSeq = 0
async function seedNode(over: Partial<{ panelPort: number | null; panelSecret: string | null; enabled: number; ip: string }> = {}) {
  const id = uuid()
  const now = new Date().toISOString()
  nodeSeq++
  const ip = over.ip ?? `198.51.100.${nodeSeq}`
  lastNodeIp = ip
  await env.DB.prepare(
    `INSERT INTO frp_nodes
       (id, name, region, server_addr, server_port, auth_token, token_prefix,
        port_min, port_max, max_ports, enabled, sort_order, note,
        status, status_note, status_updated_at, auth_mode, config_template,
        source_donation_id, panel_port, panel_secret, created_at, updated_at)
     VALUES (?, '测试捐献节点', NULL, ?, 7000, 'frsptoken1234567890', 'DC_',
             10000, 10010, 11, ?, 0, NULL, 'ok', NULL, NULL, 'token_user', NULL, NULL, ?, ?, ?, ?)`
  )
    .bind(id, ip, over.enabled ?? 1, over.panelPort === undefined ? 7200 : over.panelPort,
          over.panelSecret === undefined ? SECRET : over.panelSecret, now, now)
    .run()
  return id
}

/** 造一条订阅 */
async function seedSub(nodeId: string, user: string, token: string, ports: number[],
                       over: Partial<{ status: string; expiresAt: string; userId: string }> = {}) {
  const id = uuid()
  const now = new Date().toISOString()
  const expires = over.expiresAt ?? new Date(Date.now() + 7 * 86400_000).toISOString()
  // 默认自己造一个 active 的用户；要测「被禁用的用户」就传 userId 进来
  const ownerId = over.userId ?? (await makeUser()).id
  await env.DB.prepare(
    `INSERT INTO frp_subscriptions
       (id, user_id, node_id, plan_id, frp_user, frp_token, ports, status,
        started_at, expires_at, auto_renew, price_points, sync_state, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 0, 0, 'pending', ?, ?)`
  )
    .bind(id, ownerId, nodeId, user, token, JSON.stringify(ports), over.status ?? "active",
          now, expires, now, now)
    .run()
  return id
}

/**
 * 直接改 `users.status`（不走管理端接口）。
 *
 * 这条路径要证明的是「推送侧算期望状态时会看用户状态」，与「谁改的状态」无关 ——
 * 用 SQL 改正好模拟管理员改状态、申诉自动解封、或别的代码路径改状态。
 */
async function setUserStatus(userId: string, status: string): Promise<void> {
  await env.DB.prepare(`UPDATE users SET status = ?, updated_at = ? WHERE id = ?`)
    .bind(status, new Date().toISOString(), userId)
    .run()
}

beforeEach(() => {
  panels = {}
  installStub()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

/** 最近一次 seedNode 造出来的机器 IP，方便测试直接操作"那台面板" */
let lastNodeIp = ""

describe("推送到捐献节点面板", () => {
  it("签名能被面板口径校验通过，且每个账号都推过去", async () => {
    const nodeId = await seedNode()
    await seedSub(nodeId, "DC_aaaa1111", "tokenaaaaaaaaaaaa", [10001, 10002])
    await seedSub(nodeId, "DC_bbbb2222", "tokenbbbbbbbbbbbb", [10003])

    const r = await pushNodeState(env as never, nodeId)
    expect(r.ok).toBe(true)
    expect(r.pushed).toBe(2)

    // 🔴 这是本文件的核心断言：**每一个**请求的签名都通过了按面板口径的校验
    const bad = captured.filter((c) => !c.signatureValid)
    expect(bad, `有 ${bad.length} 个请求签名校验失败：${JSON.stringify(bad.map((b) => b.rejectReason))}`).toHaveLength(0)

    const puts = captured.filter((c) => c.method === "PUT")
    expect(puts.map((p) => p.path).sort()).toEqual([
      "/api/admin/accounts/DC_aaaa1111",
      "/api/admin/accounts/DC_bbbb2222",
    ])
    expect(allPanelAccounts().sort()).toEqual(["DC_aaaa1111", "DC_bbbb2222"])
  })

  it("时间戳用「秒」而不是「毫秒」", async () => {
    const nodeId = await seedNode()
    await seedSub(nodeId, "DC_time0001", "tokentime0000000", [10001])
    await pushNodeState(env as never, nodeId)

    const ts = Number.parseInt(captured[0].ts, 10)
    const nowSec = Math.floor(Date.now() / 1000)
    expect(Math.abs(nowSec - ts)).toBeLessThan(30)
  })

  it("请求体里的账号字段正确（令牌/端口/启用态）", async () => {
    const nodeId = await seedNode()
    await seedSub(nodeId, "DC_body0001", "tokenbody0000000", [10005, 10006])
    await pushNodeState(env as never, nodeId)

    const put = captured.find((c) => c.method === "PUT")!
    const body = JSON.parse(put.body)
    expect(body.user).toBe("DC_body0001")
    expect(body.token).toBe("tokenbody0000000")
    expect(body.ports).toEqual([10005, 10006])
    expect(body.enable).toBe(true)
  })

  it("🔴 面板上多出来的 DC_ 账号会被删掉（D1 是唯一真值）", async () => {
    const nodeId = await seedNode()
    await seedSub(nodeId, "DC_want0001", "tokenwant0000000", [10001])
    panelOf(lastNodeIp).push("DC_want0001", "DC_stale001")

    const r = await pushNodeState(env as never, nodeId)
    expect(r.ok).toBe(true)
    expect(r.removed).toBe(1)

    const del = captured.find((c) => c.method === "DELETE")!
    expect(del.path).toBe("/api/admin/accounts/DC_stale001")
    expect(panelOf(lastNodeIp)).toEqual(["DC_want0001"])
  })

  it("🔴 绝不动捐献者自己建的账号（非 DC_ 前缀）", async () => {
    const nodeId = await seedNode()
    await seedSub(nodeId, "DC_want0002", "tokenwant0000001", [10001])
    panelOf(lastNodeIp).push("DC_want0002", "donor-own-box", "legacy_account", "test")

    const r = await pushNodeState(env as never, nodeId)
    expect(r.ok).toBe(true)
    expect(r.removed).toBe(0)
    // 那三个非托管账号必须原样还在
    expect(panelOf(lastNodeIp)).toContain("donor-own-box")
    expect(panelOf(lastNodeIp)).toContain("legacy_account")
    expect(panelOf(lastNodeIp)).toContain("test")
    expect(captured.filter((c) => c.method === "DELETE")).toHaveLength(0)
  })

  it("已到期/已停用的订阅推过去时是 enable=false（而不是不推）", async () => {
    const nodeId = await seedNode()
    await seedSub(nodeId, "DC_dead0001", "tokendead0000000", [10001], {
      expiresAt: new Date(Date.now() - 86400_000).toISOString(),
    })
    await seedSub(nodeId, "DC_cancel01", "tokencancel000000", [10002], { status: "cancelled" })

    await pushNodeState(env as never, nodeId)
    const puts = captured.filter((c) => c.method === "PUT")
    expect(puts).toHaveLength(2)
    for (const p of puts) {
      expect(JSON.parse(p.body).enable).toBe(false)
    }
  })

  it("没有面板接入信息的节点直接跳过（不是一键捐献来的）", async () => {
    const nodeId = await seedNode({ panelPort: null, panelSecret: null })
    const r = await pushNodeState(env as never, nodeId)
    expect(r.ok).toBe(false)
    expect(r.skipped).toContain("面板接入信息")
    expect(captured).toHaveLength(0)
  })

  it("节点已停用则一次请求都不发", async () => {
    const nodeId = await seedNode({ enabled: 0 })
    const r = await pushNodeState(env as never, nodeId)
    expect(r.ok).toBe(false)
    expect(captured).toHaveLength(0)
  })

  it("面板不可达时返回失败，并把原因记到 last_push_error", async () => {
    const nodeId = await seedNode()
    vi.stubGlobal("fetch", async () => {
      throw new Error("connect timeout")
    })
    const r = await pushNodeState(env as never, nodeId)
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()

    const row = await env.DB.prepare(`SELECT last_push_error FROM frp_nodes WHERE id = ?`)
      .bind(nodeId)
      .first<{ last_push_error: string | null }>()
    expect(row!.last_push_error).toBeTruthy()
  })

  it("端口快照坏掉时按空授权，不是全放行", async () => {
    const nodeId = await seedNode()
    const id = await seedSub(nodeId, "DC_badport1", "tokenbadport00000", [10001])
    await env.DB.prepare(`UPDATE frp_subscriptions SET ports = ? WHERE id = ?`)
      .bind("{ this is not json", id)
      .run()

    await pushNodeState(env as never, nodeId)
    const put = captured.find((c) => c.method === "PUT")!
    expect(JSON.parse(put.body).ports).toEqual([])
  })

  it("定期收敛会遍历所有带面板信息的节点", async () => {
    const a = await seedNode()
    const b = await seedNode()
    await seedNode({ panelPort: null, panelSecret: null }) // 应被跳过
    await seedSub(a, "DC_reco0001", "tokenreco0000000", [10001])
    await seedSub(b, "DC_reco0002", "tokenreco0000001", [10002])

    const r = await reconcileAllNodes(env as never)

    // ⚠️ 这里**不能**断言 r.nodes === 2：同一个测试文件里前面的用例也建了节点，
    //    它们同样带面板接入信息，所以收敛器会把它们一起推到。断言全局计数
    //    就成了「测试隔离」问题 —— 而且这种失败只在整文件一起跑时才出现，
    //    单跑一条用例永远是绿的，非常误导。
    //    正确做法是只断言「我这两个节点被推到了」。
    expect(r.nodes).toBeGreaterThanOrEqual(2)
    expect(r.failed).toBe(0)
    expect(allPanelAccounts()).toContain("DC_reco0001")
    expect(allPanelAccounts()).toContain("DC_reco0002")

    // 没有面板接入信息的那个节点不该产生任何请求
    const badNode = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM frp_nodes WHERE panel_port IS NULL`
    ).first<{ n: number }>()
    expect(badNode!.n).toBeGreaterThanOrEqual(1)
  })

  // ------------------------------------------- 被禁用用户必须同步停用（2026-10-15）
  //
  // 与 agent 拉取那条路径是**同一个 bug 的两个入口**：这里以前也只看
  // frp_subscriptions.status + expires_at。捐献节点没有 agent，全靠这一次推送，
  // 所以这里漏了就等于「在自己那台机器上修好、在捐献节点上照旧能连」。
  // 判定口径见 frp-agent.ts 的 isActiveUser（users.status 只有 active/suspended）。

  it("🔴 用户 suspended（订阅 active 未到期）→ 推给面板的是 enable=false", async () => {
    const nodeId = await seedNode()
    const owner = await makeUser()
    await seedSub(nodeId, "DC_banned01", "tokenbanned00000", [10011], { userId: owner.id })
    await setUserStatus(owner.id, "suspended")

    const r = await pushNodeState(env as never, nodeId)
    expect(r.ok).toBe(true)

    const put = captured.find((c) => c.method === "PUT")!
    const body = JSON.parse(put.body)
    expect(body.enable).toBe(false)
    // 面板 comment 要能看出被停用的原因（不是过期）
    expect(String(body.comment)).toContain("已停用")
  })

  it("回归：用户 active 时推送仍是 enable=true", async () => {
    const nodeId = await seedNode()
    const owner = await makeUser()
    await seedSub(nodeId, "DC_normal01", "tokennormal00000", [10012], { userId: owner.id })
    await setUserStatus(owner.id, "active")

    await pushNodeState(env as never, nodeId)
    const put = captured.find((c) => c.method === "PUT")!
    expect(JSON.parse(put.body).enable).toBe(true)
  })

  it("用户恢复 active 后重新推送即变回 enable=true（自愈，不靠人工）", async () => {
    const nodeId = await seedNode()
    const owner = await makeUser()
    await seedSub(nodeId, "DC_heal0001", "tokenheal0000000", [10013], { userId: owner.id })

    await setUserStatus(owner.id, "suspended")
    await pushNodeState(env as never, nodeId)
    expect(JSON.parse(captured.filter((c) => c.method === "PUT").pop()!.body).enable).toBe(false)

    await setUserStatus(owner.id, "active")
    await pushNodeState(env as never, nodeId)
    expect(JSON.parse(captured.filter((c) => c.method === "PUT").pop()!.body).enable).toBe(true)
  })
})
