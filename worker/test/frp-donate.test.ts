// 代理节点「一键捐献」端到端（2026-10-14）。
//
// 这条链路横跨三处，任何一处断了用户都捐不成：
//   捐献页领令牌 → 脚本在服务器上跑 → 脚本回报 /api/frp/donate/register
//   → 登记节点 → 自动上架默认套餐
//
// 为什么要写成可重复的集成测试，而不是"我手工点一遍看着没问题"：
//   这条链路里有**并发重试**（脚本会因为网络抖动重试）、有**跨表写入**
//   （frp_donate_used_tokens / frp_nodes / frp_plans），手工点根本覆盖不到。
//   而且站长要求「多跑几遍」，那就必须是一跑就能全自动复现的东西。
//
// 钉的几件事：
//   · 令牌只能换出一个节点，重放拿不到第二个（脚本重试是真实场景）
//   · 默认套餐的值来自设置项，不是写死的常量 —— 站长改设置要立刻生效
//   · 同一台机器重复捐献复用已有节点，不在节点列表里堆同一个 IP 的死节点
//   · 令牌过期/伪造一律拒绝
//   · 🔴 复用分支只认自己的节点（报告 #8）：别人的 IP 提交上来 → 409 且**不回显任何
//     密钥**；本人复用同样不回显；首次创建才返回密钥
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { uuid } from "../src/crypto"
import { authRequest, fetchSelf, makeUser, type TestUser } from "./helpers"

interface NodeRow {
  id: string
  name: string
  server_addr: string
  server_port: number
  port_min: number
  port_max: number
  max_ports: number
  enabled: number
}
interface PlanRow {
  id: string
  node_id: string
  name: string
  days: number
  price_points: number
  max_ports: number
}

/** 领一枚捐献令牌（走真实接口，带登录态） */
async function mintToken(user: TestUser): Promise<string> {
  const res = await fetchSelf(authRequest(user, "/api/frp/donate/token", { method: "POST" }))
  expect(res.status).toBe(200)
  const body = (await res.json()) as { token: string }
  expect(body.token).toBeTruthy()
  return body.token
}

/**
 * 每个用例一个**专属**的 server_addr。
 *
 * 原来这里是 `203.0.113.<Math.random()*200>`。报告 #8 的修复让「同一 IP 被别人登记过」
 * 直接 409，随机 IP 一旦撞上别的用例（同一个文件里也要跑七八次登记）就会偶发变红 ——
 * 那不是代码坏了，是测试自己在掷骰子。改成自增序号 + 专用网段，唯一性由序号保证。
 */
let ipSeq = 0
function uniqueIp(): string {
  ipSeq += 1
  return `198.18.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`
}

/** 断言响应体里没有任何「密钥/凭据」字段，也没有给定的密钥明文 */
function expectNoSecrets(body: Record<string, unknown>, leaked?: string) {
  const raw = JSON.stringify(body)
  for (const field of [
    "agentKey",
    "agent_key",
    "panelSecret",
    "panel_secret",
    "authToken",
    "auth_token",
    "frpsToken",
    "agentSecret",
  ]) {
    expect(raw, `${field} 不该出现在响应里`).not.toContain(field)
  }
  if (leaked) expect(raw).not.toContain(leaked)
}

/** 模拟脚本回报（**不带登录态** —— 脚本在别人的服务器上跑，没有浏览器会话） */
async function register(payload: Record<string, unknown>) {
  const res = await fetchSelf(
    new Request("https://test.local/api/frp/donate/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  )
  let body: Record<string, unknown> = {}
  try {
    body = (await res.json()) as Record<string, unknown>
  } catch {
    /* 空响应 */
  }
  return { status: res.status, body }
}

function goodPayload(token: string, over: Record<string, unknown> = {}) {
  return {
    ip: uniqueIp(),
    frpsPort: 7000,
    panelPort: 7200,
    frpsToken: "abcdefghijklmnop1234567890",
    agentSecret: "agent-secret-abcdefghijklmnop",
    token,
    ...over,
  }
}

describe("代理节点一键捐献 · 端到端", () => {
  it("领令牌 → 回报 → 节点登记 + 默认套餐自动上架", async () => {
    const user = await makeUser()
    const token = await mintToken(user)

    const res = await register(goodPayload(token))
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.created).toBe(true)

    const nodeId = String(res.body.nodeId)
    const node = await env.DB.prepare(`SELECT * FROM frp_nodes WHERE id = ?`)
      .bind(nodeId)
      .first<NodeRow>()
    expect(node).toBeTruthy()
    // 节点名带捐献者，方便管理员一眼看出来源
    expect(node!.name).toContain(user.username)
    expect(node!.enabled).toBe(1)

    const plan = await env.DB.prepare(`SELECT * FROM frp_plans WHERE node_id = ?`)
      .bind(nodeId)
      .first<PlanRow>()
    expect(plan).toBeTruthy()
    // 站长指定的默认值：30 天 / 100 积分
    expect(plan!.days).toBe(30)
    expect(plan!.price_points).toBe(100)
    // 端口区间 10000-10010
    expect(node!.port_min).toBe(10000)
    expect(node!.port_max).toBe(10010)
  })

  it("🔴 同一枚令牌重放拿不到第二个节点（脚本重试是真实场景）", async () => {
    const user = await makeUser()
    const token = await mintToken(user)
    const payload = goodPayload(token)

    const first = await register(payload)
    expect(first.status).toBe(200)

    const second = await register(payload)
    expect(second.status).toBe(409)

    // 数据库里只有一条登记记录
    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM frp_donate_used_tokens WHERE user_id = ?`
    )
      .bind(user.id)
      .first<{ n: number }>()
    expect(rows!.n).toBe(1)
  })

  it("🔴 并发重试也只成功一次（先查再插会在并发下双穿，所以唯一性交给了数据库）", async () => {
    const user = await makeUser()
    const token = await mintToken(user)
    const payload = goodPayload(token)

    const results = await Promise.all([
      register(payload),
      register(payload),
      register(payload),
      register(payload),
      register(payload),
    ])
    const okCount = results.filter((r) => r.status === 200).length
    const conflictCount = results.filter((r) => r.status === 409).length

    // 恰好一次成功，其余全部 409 —— 不允许出现两个 200
    expect(okCount).toBe(1)
    expect(conflictCount).toBe(4)

    const used = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM frp_donate_used_tokens WHERE user_id = ?`
    )
      .bind(user.id)
      .first<{ n: number }>()
    expect(used!.n).toBe(1)

    const nodes = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM frp_nodes WHERE server_addr = ?`
    )
      .bind(payload.ip)
      .first<{ n: number }>()
    expect(nodes!.n).toBe(1)
  })

  it("同一台机器用新令牌再捐一次 → 复用已有节点，不堆死节点", async () => {
    const user = await makeUser()
    const ip = uniqueIp()

    const first = await register(goodPayload(await mintToken(user), { ip }))
    expect(first.status).toBe(200)
    expect(first.body.created).toBe(true)

    const second = await register(goodPayload(await mintToken(user), { ip }))
    expect(second.status).toBe(200)
    expect(second.body.created).toBe(false)
    expect(String(second.body.nodeId)).toBe(String(first.body.nodeId))

    const nodes = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM frp_nodes WHERE server_addr = ?`
    )
      .bind(ip)
      .first<{ n: number }>()
    expect(nodes!.n).toBe(1)
  })

  it("🔴 伪造令牌 / 过期令牌 / 缺令牌 一律拒绝", async () => {
    const user = await makeUser()
    const real = await mintToken(user)
    const parts = real.split(".")

    const cases: [string, string][] = [
      ["完全瞎编", "totally-made-up"],
      ["签名被改", `${parts[0]}.${parts[1]}.${"0".repeat(parts[2].length)}`],
      ["换个人用别人的 id", `${uuid()}.${parts[1]}.${parts[2]}`],
      ["过期", `${parts[0]}.${Date.now() - 1000}.${parts[2]}`],
      ["空", ""],
    ]
    for (const [label, bad] of cases) {
      const res = await register(goodPayload(bad))
      expect(res.status, label).toBe(401)
    }
  })

  it("🔴 自报的 ip / 端口形状不合法一律拒绝", async () => {
    const user = await makeUser()

    const bads: [string, Record<string, unknown>][] = [
      ["ip 不是四段", { ip: "1.2.3" }],
      ["ip 段超范围", { ip: "1.2.3.999" }],
      ["ip 不是数字", { ip: "a.b.c.d" }],
      ["端口为 0", { frpsPort: 0 }],
      ["端口超范围", { panelPort: 70000 }],
      ["两个端口相同", { panelPort: 7000 }],
      ["frps token 太短", { frpsToken: "abc" }],
    ]
    for (const [label, over] of bads) {
      const res = await register(goodPayload(await mintToken(user), over))
      expect(res.status, label).toBe(400)
    }
  })

  it("默认套餐的值来自设置项，改了立刻生效（站长要求可改）", async () => {
    const user = await makeUser()
    const ip = uniqueIp()

    // 管理员把默认值改成 7 天 / 250 积分 / 端口 20000-20005
    for (const [k, v] of [
      ["frp_donate_default_days", "7"],
      ["frp_donate_default_points", "250"],
      ["frp_donate_default_port_min", "20000"],
      ["frp_donate_default_port_max", "20005"],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
        .bind(k, v, new Date().toISOString())
        .run()
    }

    try {
      const res = await register(goodPayload(await mintToken(user), { ip }))
      expect(res.status).toBe(200)
      const nodeId = String(res.body.nodeId)

      const node = await env.DB.prepare(`SELECT * FROM frp_nodes WHERE id = ?`)
        .bind(nodeId)
        .first<NodeRow>()
      const plan = await env.DB.prepare(`SELECT * FROM frp_plans WHERE node_id = ?`)
        .bind(nodeId)
        .first<PlanRow>()

      expect(node!.port_min).toBe(20000)
      expect(node!.port_max).toBe(20005)
      expect(plan!.days).toBe(7)
      expect(plan!.price_points).toBe(250)
    } finally {
      // 把设置改回去，别污染其它用例
      for (const k of [
        "frp_donate_default_days",
        "frp_donate_default_points",
        "frp_donate_default_port_min",
        "frp_donate_default_port_max",
      ]) {
        await env.DB.prepare(`DELETE FROM app_settings WHERE key = ?`).bind(k).run()
      }
    }
  })

  // ------------------------------------------------------------------ 报告 #8（HIGH）
  //
  // 漏洞形状：查重键只有 server_addr，而「已存在」分支会把库里的 agent_key 原样回显。
  // 于是**只要知道别人的节点 IP** 就能拿到它的 HMAC 密钥（= 可冒充该节点拉期望状态，
  // 那里有该节点全部用户的 frp 令牌）。下面三条把修复钉死：
  //   · 不是本人 → 409，且响应里连一个凭据字段都没有
  //   · 是本人复用 → 200，但同样不回显密钥（D1 里那把也不许动，否则已部署 agent 全挂）
  //   · 归属为 NULL 的老节点不因为「没主人」就变成谁都能复用

  it("🔴 别人已登记的 server_addr 再提交 → 409，且响应里没有任何密钥", async () => {
    const owner = await makeUser()
    const intruder = await makeUser()
    const ip = uniqueIp()

    const first = await register(goodPayload(await mintToken(owner), { ip }))
    expect(first.status).toBe(200)
    expect(first.body.created).toBe(true)
    // 首次创建 → 密钥必须给（脚本要靠它装 agent）
    const ownerKey = String(first.body.agentKey)
    expect(ownerKey).toMatch(/^[A-Za-z0-9]{48}$/)

    const attacked = await register(goodPayload(await mintToken(intruder), { ip }))
    expect(attacked.status).toBe(409)
    // 错误体只有统一的 error/code 两个字段 —— 连 nodeId 都不给，
    // 不帮攻击者把「IP → nodeId」映射摸出来
    expect(Object.keys(attacked.body).sort()).toEqual(["code", "error"])
    expect(attacked.body.code).toBe("FRP_NODE_ADDR_TAKEN")
    expectNoSecrets(attacked.body, ownerKey)

    // 归属与密钥都没被这次请求动过，也没有冒出第二个节点
    const node = await env.DB.prepare(
      `SELECT owner_user_id, agent_key FROM frp_nodes WHERE server_addr = ?`
    )
      .bind(ip)
      .first<{ owner_user_id: string; agent_key: string }>()
    expect(node!.owner_user_id).toBe(owner.id)
    expect(node!.agent_key).toBe(ownerKey)
  })

  it("🔴 本人复用节点时也不再回显密钥，但库里那把不许动（已部署 agent 靠它活着）", async () => {
    const user = await makeUser()
    const ip = uniqueIp()

    const first = await register(goodPayload(await mintToken(user), { ip }))
    expect(first.status).toBe(200)
    const agentKey = String(first.body.agentKey)
    expect(agentKey).toBeTruthy()

    const again = await register(goodPayload(await mintToken(user), { ip }))
    expect(again.status).toBe(200)
    expect(again.body.created).toBe(false)
    expect(String(again.body.nodeIdForAgent)).toBe(String(first.body.nodeId))
    // 字段本身就不存在（不是 null）—— 免得调用方把「拿到但为空」当成有效值
    expect("agentKey" in again.body).toBe(false)
    expectNoSecrets(again.body, agentKey)

    // 🔴 兼容性红线：复用分支只是「不再外发」，**不能**顺手轮换/补写密钥。
    //    已经装在用户机器上的 agent 用着第一次那把，轮换就等于把它们全部踢下线。
    const node = await env.DB.prepare(`SELECT agent_key FROM frp_nodes WHERE id = ?`)
      .bind(String(first.body.nodeId))
      .first<{ agent_key: string }>()
    expect(node!.agent_key).toBe(agentKey)
  })

  it("🔴 归属为 NULL 的老节点（配置式捐献时代）也不允许被别人复用", async () => {
    const user = await makeUser()
    const ip = uniqueIp()
    const now = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO frp_nodes
         (id, name, server_addr, server_port, auth_token, token_prefix,
          port_min, port_max, max_ports, enabled, sort_order, auth_mode, created_at, updated_at)
       VALUES (?, '老节点', ?, 7000, 'tok-legacy-1234', 'DC_', 10000, 10010, 11, 1, 0, 'token_user', ?, ?)`
    )
      .bind(`n_${uuid().slice(0, 8)}`, ip, now, now)
      .run()

    const res = await register(goodPayload(await mintToken(user), { ip }))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe("FRP_NODE_ADDR_TAKEN")
    expectNoSecrets(res.body)
  })
})
