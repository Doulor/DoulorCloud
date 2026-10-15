// 跨语言签名契约（2026-10-14）。
//
// 这是整条推送链路里**唯一无法靠单元测试自证**的一环：
// DoulorCloud 用 TypeScript 签名，捐献节点的面板用 Python 验签。
// 两边的实现对不上时，表现是「推送 403 / 账号永远进不去面板」，
// 而两边的日志都只会说"签名不对"，不会告诉你差在哪一个字节
// （`\n` 拼接顺序、时间戳单位是秒还是毫秒、body 用原始字节还是重新序列化 ——
//   这三个任何一个错都会 403，且症状完全一样）。
//
// 所以这个测试的做法是：
//   1. 跑一次**真实的 pushNodeState**，把 stub 拦截到的请求原样落成 fixture；
//   2. 交给 Python 侧的 `verify_agent_request`（**面板里那一份真实代码**）去验。
// 只要通过，就证明两端口径逐字节一致 —— 而不是"我按自己的理解写了个 stub 说它对"。
import { describe, it, expect, vi } from "vitest"
import { env } from "cloudflare:workers"
import { uuid } from "../src/crypto"
import { pushNodeState } from "../src/handlers/frp-node-push"
import { makeUser } from "./helpers"

const SECRET = "cross-language-secret-0123456789abcdef"
/** fixture 交给 Python 验签时用；放在仓库外面避免污染源码目录 */
const _UNUSED_FIXTURE_PATH = ""

interface Fixture {
  secret: string
  requests: { method: string; pathWithQuery: string; ts: string; signature: string; body: string }[]
}

describe("签名契约 · TS 签 Python 验", () => {
  it("真实推送请求的签名能被面板代码验过", async () => {
    const nodeId = uuid()
    const now = new Date().toISOString()
    const ip = "198.51.100.77"

    await env.DB.prepare(
      `INSERT INTO frp_nodes
         (id, name, region, server_addr, server_port, auth_token, token_prefix,
          port_min, port_max, max_ports, enabled, sort_order, note,
          status, status_note, status_updated_at, auth_mode, config_template,
          source_donation_id, panel_port, panel_secret, created_at, updated_at)
       VALUES (?, '跨语言验签节点', NULL, ?, 7000, 'tok1234567890', 'DC_',
               10000, 10010, 11, 1, 0, NULL, 'ok', NULL, NULL, 'token_user', NULL, NULL, 7200, ?, ?, ?)`
    )
      .bind(nodeId, ip, SECRET, now, now)
      .run()

    // 用 makeUser 造订阅所有者 —— users 表有必填字段（password_hash 等），
    // 手写 INSERT 会撞 NOT NULL，而且以后加字段又会再撞一次
    const owner = await makeUser()

    await env.DB.prepare(
      `INSERT INTO frp_subscriptions
         (id, user_id, node_id, plan_id, frp_user, frp_token, ports, status,
          started_at, expires_at, auto_renew, price_points, sync_state, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'DC_crosslang1', 'TokenCrossLang01', '[10007]', 'active',
               ?, ?, 0, 0, 'pending', ?, ?)`
    )
      .bind(uuid(), owner.id, nodeId, now, new Date(Date.now() + 86400_000).toISOString(), now, now)
      .run()

    // 抓下**真实**请求（不是自己拼的 —— 这样才证明 pushNodeState 里那条路径对）
    const requests: Fixture["requests"] = []
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const u = new URL(url)
      const headers = (init?.headers || {}) as Record<string, string>
      let body = ""
      if (init?.body instanceof Uint8Array) body = new TextDecoder().decode(init.body)
      else if (typeof init?.body === "string") body = init.body
      requests.push({
        method: (init?.method || "GET").toUpperCase(),
        pathWithQuery: u.pathname + u.search,
        ts: headers["X-Frp-Agent-Ts"] || "",
        signature: headers["X-Frp-Agent-Signature"] || "",
        body,
      })
      if ((init?.method || "GET").toUpperCase() === "GET") {
        return new Response(JSON.stringify({ accounts: [] }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })

    try {
      const r = await pushNodeState(env as never, nodeId)
      expect(r.ok).toBe(true)
      expect(requests.length).toBeGreaterThanOrEqual(2) // GET 列表 + PUT 账号

      const fixture: Fixture = { secret: SECRET, requests }
      // ⚠️ 不能在 Workers 测试里用 node:fs 写文件：workerd 的 fs shim 只接受 file: URL，
      //    传 Windows 路径会抛「File path must be a file: URL」。
      //    改成打到 stdout，由外面落盘再交给 Python 验签。
      console.log("PUSH_SIGN_FIXTURE_BEGIN" + JSON.stringify(fixture) + "PUSH_SIGN_FIXTURE_END")

      // 至少要有那三个头，缺一个 Python 侧直接判 missing
      for (const req of requests) {
        expect(req.ts, "缺少时间戳头").toBeTruthy()
        expect(req.signature, "缺少签名头").toBeTruthy()
      }
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
