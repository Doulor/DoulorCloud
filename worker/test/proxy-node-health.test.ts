// 节点探活与健康度重排序（迁移 0128）。
//
// 分两层测，因为两层会坏的方式完全不同：
//
//   1. **纯函数层**（判定与排序）：这块一旦写错，表现是「所有节点都排到后面」
//      这类**静默**错误 —— 界面上看不出异常，只是好节点被埋了。必须由用例把规则锁死。
//   2. **HTTP 层**：路由写错、忘了落库、排序忘了接进返回体 —— 纯函数测试完全覆盖不到，
//      只会在线上暴露。
//
// ⚠️ 贯穿全部用例的一条原则：**「测不到」不是「不可用」**。
//    握手失败可能是本站 Worker 出网到该节点不通（Cloudflare 封了部分目标 IP），
//    所以失败要用中性文案，且要连续多轮才降级。
import { describe, it, expect, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, type TestUser } from "./helpers"
import { uuid } from "../src/crypto"
import {
  HANDSHAKE_FAIL_STREAK_TO_DOWN,
  emptyHealthRecord,
  nextHealthRecord,
  nodeHealthRank,
  orderNodesByHealth,
  summarizeNodeHealth,
  type NodeHealthRecord,
} from "../src/proxy-node-health"

const NOW = "2026-10-08T00:00:00.000Z"
const LATER = "2026-10-08T01:00:00.000Z"

const ok = (latencyMs: number | null) => ({ ok: true, latencyMs, reason: "" })
const fail = (reason = "本站未能连上该地址") => ({ ok: false, latencyMs: null, reason })

/** 快速造一条健康记录（排序用例只关心 status/latencyMs） */
function rec(
  status: NodeHealthRecord["status"],
  latencyMs: number | null = null,
  checkedAt = NOW
): NodeHealthRecord {
  return { status, latencyMs, okStreak: 0, failStreak: 0, checkedAt, lastError: null }
}

describe("nextHealthRecord —— 迟滞判定（恢复快、降级慢）", () => {
  it("一次握手成功即判可用（成功是硬证据：真的连上了）", () => {
    const r = nextHealthRecord(emptyHealthRecord(), ok(120), NOW)
    expect(r.status).toBe("up")
    expect(r.latencyMs).toBe(120)
    expect(r.okStreak).toBe(1)
    expect(r.failStreak).toBe(0)
    expect(r.lastError).toBeNull()
    expect(r.checkedAt).toBe(NOW)
  })

  it("单次失败**不**降级：可用继续保持可用（订阅站/节点偶发抖动很正常）", () => {
    const up = nextHealthRecord(emptyHealthRecord(), ok(120), NOW)
    const r = nextHealthRecord(up, fail(), LATER)
    expect(r.status).toBe("up")
    // 耗时必须保留 —— 否则一个刚抖了一下的节点会突然没有数据可展示
    expect(r.latencyMs).toBe(120)
    expect(r.okStreak).toBe(0)
    expect(r.failStreak).toBe(1)
    expect(r.lastError).toBe("本站未能连上该地址")
  })

  it("连续失败达到阈值才降级（失败是弱证据，要攒够）", () => {
    let r = nextHealthRecord(emptyHealthRecord(), ok(80), NOW)
    for (let i = 0; i < HANDSHAKE_FAIL_STREAK_TO_DOWN; i++) {
      r = nextHealthRecord(r, fail(), LATER)
    }
    expect(r.status).toBe("down")
    expect(r.failStreak).toBe(HANDSHAKE_FAIL_STREAK_TO_DOWN)
  })

  it("降级后再次成功 → 立刻恢复可用，计数清零", () => {
    let r = nextHealthRecord(emptyHealthRecord(), ok(80), NOW)
    r = nextHealthRecord(r, fail(), LATER)
    r = nextHealthRecord(r, fail(), LATER)
    expect(r.status).toBe("down")

    r = nextHealthRecord(r, ok(95), LATER)
    expect(r.status).toBe("up")
    expect(r.latencyMs).toBe(95)
    expect(r.failStreak).toBe(0)
    expect(r.lastError).toBeNull()
  })

  it("从未探过的节点失败一轮仍是未知 —— 不因为一次失败就给人盖棺", () => {
    expect(nextHealthRecord(emptyHealthRecord(), fail(), NOW).status).toBe("unknown")
  })

  it("失败原因里不能出现「不可用」这种断言（没能验证 ≠ 不可用）", () => {
    const r = nextHealthRecord(emptyHealthRecord(), fail("超时（3 秒内没连上）"), NOW)
    expect(r.lastError).not.toContain("不可用")
  })

  it("不改入参（调用方可能还要拿旧记录做别的判断）", () => {
    const prev = emptyHealthRecord()
    nextHealthRecord(prev, ok(50), NOW)
    expect(prev).toEqual(emptyHealthRecord())
  })
})

describe("orderNodesByHealth —— 可用 → 未知 → 测不到", () => {
  const nodes = [
    { name: "a", fp: "vless:a:443" },
    { name: "b", fp: "vless:b:443" },
    { name: "c", fp: "vless:c:443" },
    { name: "d", fp: "vless:d:443" },
    { name: "e", fp: "hysteria2:e:443" }, // 探不了 → 不会有健康行 → 未知
  ]
  const keyOf = (n: { fp: string }) => n.fp

  it("不可用排最后、未知居中、可用在前；同档内保持传入顺序", () => {
    const health = new Map<string, NodeHealthRecord>([
      ["vless:a:443", rec("down")],
      ["vless:b:443", rec("up", 90)],
      ["vless:c:443", rec("up", 200)],
      ["vless:d:443", rec("unknown")],
    ])
    // b(90ms) 快于 c(200ms) ⇒ 排最前；d 未知、e 无记录（同为未知，按原顺序）；a 不可用
    expect(orderNodesByHealth(nodes, keyOf, health).map((n) => n.name)).toEqual([
      "b",
      "c",
      "d",
      "e",
      "a",
    ])
  })

  it("一个节点都没探过时顺序与传入**完全一致**（列表不会平白无故地跳动）", () => {
    expect(orderNodesByHealth(nodes, keyOf, new Map()).map((n) => n.name)).toEqual(
      nodes.map((n) => n.name)
    )
  })

  it("返回新数组，不改入参", () => {
    const input = [...nodes]
    const ordered = orderNodesByHealth(input, keyOf, new Map())
    expect(ordered).not.toBe(input)
    expect(input.map((n) => n.name)).toEqual(["a", "b", "c", "d", "e"])
  })

  it("权重：无记录等同未知（QUIC 节点不会被冤枉成不可用）", () => {
    expect(nodeHealthRank(undefined)).toBe(nodeHealthRank("unknown"))
    expect(nodeHealthRank("up")).toBeLessThan(nodeHealthRank("unknown"))
    expect(nodeHealthRank("unknown")).toBeLessThan(nodeHealthRank("down"))
  })
})

describe("summarizeNodeHealth", () => {
  it("统计三态数量与最新一次探活时间", () => {
    const nodes = [{ fp: "x" }, { fp: "y" }, { fp: "z" }]
    const health = new Map<string, NodeHealthRecord>([
      ["x", rec("up", 10, NOW)],
      ["z", rec("down", null, LATER)],
    ])
    expect(summarizeNodeHealth(nodes, (n) => n.fp, health)).toEqual({
      up: 1,
      unknown: 1,
      down: 1,
      total: 3,
      checkedAt: LATER,
    })
  })

  it("一个都没探过 → checkedAt 为 null、全部计入未知", () => {
    const s = summarizeNodeHealth([{ fp: "x" }], (n) => n.fp, new Map())
    expect(s).toEqual({ up: 0, unknown: 1, down: 0, total: 1, checkedAt: null })
  })
})

// ---- HTTP 层 ----
describe("HTTP 层：探活结论落库 + 总览按健康度排序", () => {
  const SUB_HOST = "https://sub.example.com"
  // 三个都用可测速的 TCP 协议 —— 只有可测的才可能拿到 up/down，排序才看得出来
  const NODES = [
    "vless://aaaaaaaa-0000-0000-0000-00000000000a@a.example.com:443?security=tls#A",
    "vless://bbbbbbbb-0000-0000-0000-00000000000b@b.example.com:443?security=tls#B",
    "vless://cccccccc-0000-0000-0000-00000000000c@c.example.com:443?security=tls#C",
  ].join("\n")

  let restores: Array<() => void> = []

  /** 只接管订阅地址的出站请求；`connect()` 不走 fetch，不会被拦 */
  function stubSub(handler: (url: string) => Response | undefined): void {
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      return handler(url) ?? original(input as RequestInfo, init)
    }) as unknown as typeof fetch
    restores.push(() => {
      globalThis.fetch = original
    })
  }

  afterEach(() => {
    for (let i = restores.length - 1; i >= 0; i--) restores[i]()
    restores = []
  })

  async function seedSub(url: string): Promise<string> {
    const id = uuid()
    const now = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO proxy_subscriptions
         (id, name, region, url, protocol, status, enabled, sort_order, note,
          source_donation_id, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'vless', 'online', 1, 0, NULL, NULL, ?, ?)`
    )
      .bind(id, "测试订阅", url, now, now)
      .run()
    return id
  }

  async function activate(userId: string): Promise<void> {
    const now = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO proxy_activation (user_id, enabled, consent_version, created_at, updated_at)
       VALUES (?, 1, 1, ?, ?)`
    )
      .bind(userId, now, now)
      .run()
  }

  /**
   * 直插一行健康记录（模拟「上一轮定时探活留下的结论」）。
   *
   * 顺带把订阅源的 `health_checked_at` 也写上 —— 真实流程里它由
   * persistNodeHealth / probeSubscriptionNodeHealth 一起回写，
   * 是定时探活轮转「谁最久没探过」的依据，也是界面上的「最近探活」时间。
   */
  async function putHealth(
    subscriptionId: string,
    fingerprint: string,
    status: string,
    latencyMs: number | null,
    failStreak: number
  ): Promise<void> {
    const now = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO proxy_node_health
         (fingerprint, subscription_id, status, latency_ms, ok_streak, fail_streak,
          checked_at, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, NULL, ?, ?)`
    )
      .bind(fingerprint, subscriptionId, status, latencyMs, failStreak, now, now, now)
      .run()
    await env.DB.prepare("UPDATE proxy_subscriptions SET health_checked_at = ? WHERE id = ?")
      .bind(now, subscriptionId)
      .run()
  }

  async function loadHealth(
    subscriptionId: string
  ): Promise<Array<{ fingerprint: string; status: string; fail_streak: number }>> {
    const rows = await env.DB.prepare(
      "SELECT fingerprint, status, fail_streak FROM proxy_node_health WHERE subscription_id = ? ORDER BY fingerprint"
    )
      .bind(subscriptionId)
      .all<{ fingerprint: string; status: string; fail_streak: number }>()
    return rows.results ?? []
  }

  async function overview(user: TestUser, subId: string) {
    const res = await fetchSelf(authRequest(user, "/proxy"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      subscriptions: Array<{
        id: string
        nodes: Array<{ server: string; health?: { status: string; latencyMs: number | null } }>
        health?: { up: number; unknown: number; down: number; total: number }
        healthCheckedAt?: string | null
      }>
    }
    const sub = body.subscriptions.find((s) => s.id === subId)
    expect(sub, "订阅源应出现在总览里").toBeTruthy()
    return sub!
  }

  it("GET /proxy 把节点排成「可用 → 未知 → 不可用」，并带上健康快照与分布", async () => {
    const user = await makeUser()
    await activate(user.id)
    const id = await seedSub(`${SUB_HOST}/sub`)
    stubSub((url) => (url.startsWith(SUB_HOST) ? new Response(NODES) : undefined))

    // A 连续两轮失败 → 不可用；B 可用（90ms）；C 没有记录 → 未知
    await putHealth(id, "vless:a.example.com:443", "down", null, HANDSHAKE_FAIL_STREAK_TO_DOWN)
    await putHealth(id, "vless:b.example.com:443", "up", 90, 0)

    const sub = await overview(user, id)

    // B(可用) → C(未知) → A(不可用)
    expect(sub.nodes.map((n) => n.server)).toEqual([
      "b.example.com",
      "c.example.com",
      "a.example.com",
    ])
    expect(sub.nodes[0].health).toMatchObject({ status: "up", latencyMs: 90 })
    expect(sub.nodes[1].health).toMatchObject({ status: "unknown" })
    expect(sub.nodes[2].health).toMatchObject({ status: "down" })

    expect(sub.health).toMatchObject({ up: 1, unknown: 1, down: 1, total: 3 })
    expect(sub.healthCheckedAt).toBeTruthy()
  })

  it("重排序不会丢节点（数量、指纹一个都不能少）", async () => {
    const user = await makeUser()
    await activate(user.id)
    const id = await seedSub(`${SUB_HOST}/sub2`)
    stubSub((url) => (url.startsWith(SUB_HOST) ? new Response(NODES) : undefined))
    await putHealth(id, "vless:a.example.com:443", "down", null, 5)

    const sub = await overview(user, id)
    expect(sub.nodes).toHaveLength(3)
    expect([...sub.nodes.map((n) => n.server)].sort()).toEqual([
      "a.example.com",
      "b.example.com",
      "c.example.com",
    ])
  })

  it("POST /proxy/latency 把本批结论落库（下一轮排序就能用上）", async () => {
    const user = await makeUser()
    await activate(user.id)
    const id = await seedSub(`${SUB_HOST}/sub3`)
    // 三个都指向 `.invalid`（保留域名，永远解析不了）⇒ 握手必然失败。
    // 但那是**弱证据**，第一轮不该被降级成 down。
    // ⚠️ 三台主机必须各不相同：指纹是「协议:服务器:端口」，同名会被去重成一行。
    const dead = NODES.replace(/a\.example\.com/g, "nope-a.invalid")
      .replace(/b\.example\.com/g, "nope-b.invalid")
      .replace(/c\.example\.com/g, "nope-c.invalid")
    stubSub((url) => (url.startsWith(SUB_HOST) ? new Response(dead) : undefined))

    expect(await loadHealth(id)).toHaveLength(0)

    const res = await fetchSelf(
      authRequest(user, "/proxy/latency", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      results: Array<{ ok: boolean; status: string; reason: string }>
    }
    for (const r of body.results) {
      expect(r.ok).toBe(false)
      // 返回体里要带上合并历史后的状态，前端才能就地更新徽标
      expect(r.status).toBe("unknown")
      expect(r.reason).not.toContain("不可用")
    }

    const rows = await loadHealth(id)
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(row.status).toBe("unknown") // 第一轮失败还不降级
      expect(row.fail_streak).toBe(1)
      expect(row.fingerprint).toContain(".invalid")
    }

    // 订阅源上要记下「什么时候探过」（定时探活的轮转依据）
    const sub = await env.DB.prepare("SELECT health_checked_at FROM proxy_subscriptions WHERE id = ?")
      .bind(id)
      .first<{ health_checked_at: string | null }>()
    expect(sub?.health_checked_at).toBeTruthy()
  })

  it("抓不到订阅时不写任何健康行（不能凭一次抓取失败就给人降级）", async () => {
    const user = await makeUser()
    await activate(user.id)
    const id = await seedSub(`${SUB_HOST}/dead`)
    await putHealth(id, "vless:a.example.com:443", "up", 42, 0)
    stubSub((url) => (url.startsWith(SUB_HOST) ? new Response("boom", { status: 500 }) : undefined))

    const res = await fetchSelf(
      authRequest(user, "/proxy/latency", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      })
    )
    expect(res.status).toBe(502)

    // 原结论原封不动
    const rows = await loadHealth(id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: "up" })
  })
})
