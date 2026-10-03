// 逐节点测速：协议可测性判定、下标映射、握手成功/超时/失败三条分支。
//
// 用**注入的假连接器**测 —— 真连网络会让用例变慢且不稳定，
// 而这里真正要锁住的是「哪些协议能测」「结果怎么对回列表」「失败文案不能下结论」
// 这些逻辑，跟真实网络无关。
//
// ⚠️ 平台事实（查官方 Limits 文档确认，2026-09-25）：
//   - `connect()` Free / Paid 都可用；
//   - **每次请求最多 6 个并发连接**（与 fetch 共用），超出会排队甚至被取消；
//   - `connect()` **没有内置超时**，必须自己 Promise.race；
//   - Cloudflare 自身 IP（如 1.1.1.1）、localhost 被禁止连接。
import { describe, it, expect, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, type TestUser } from "./helpers"
import { uuid } from "../src/crypto"
import {
  LATENCY_CONCURRENCY,
  isLatencyTestable,
  latencyTargets,
  measureNodes,
  measureTcpHandshake,
  normalizeHost,
  type SocketLike,
  type TcpConnector,
} from "../src/proxy-latency"
import { assertPublicTcpHost } from "../src/url-guard"

/** 造一个可控的假 socket：opened 按需成功/失败/永久挂起，并记录 close 是否被调用 */
function fakeSocket(opts: {
  outcome?: "ok" | "fail" | "hang"
  delayMs?: number
  closeThrows?: boolean
}): { socket: SocketLike; closed: () => boolean } {
  let closed = false
  const socket: SocketLike = {
    opened:
      opts.outcome === "fail"
        ? Promise.reject(new Error("proxy request failed, cannot connect to the specified address"))
        : opts.outcome === "hang"
          ? new Promise(() => {}) // 永不 settle，用来测超时
          : new Promise((resolve) => setTimeout(resolve, opts.delayMs ?? 0)),
    close: async () => {
      closed = true
      if (opts.closeThrows) throw new Error("socket is not open")
    },
  }
  return { socket, closed: () => closed }
}

function connectorOf(make: () => ReturnType<typeof fakeSocket>): TcpConnector {
  return () => make().socket
}

describe("isLatencyTestable —— 哪些协议能测", () => {
  it("TCP 承载的协议可测", () => {
    for (const p of ["vless", "vmess", "trojan", "ss", "ssr", "anytls", "VLESS", " Trojan "]) {
      expect(isLatencyTestable(p), p).toBe(true)
    }
  })

  it("QUIC/UDP 的协议测不了（Worker 建不了 UDP 连接）", () => {
    // 关键：这些必须走「不支持测速」这条分支，而不是报「不可用」
    for (const p of ["hysteria", "hysteria2", "hy2", "tuic", "unknown", ""]) {
      expect(isLatencyTestable(p), p).toBe(false)
    }
  })
})

describe("normalizeHost", () => {
  it("IPv6 字面量要剥掉方括号（parseAuthorityLink 会保留它们）", () => {
    expect(normalizeHost("[2001:db8::1]")).toBe("2001:db8::1")
    expect(normalizeHost("1.2.3.4")).toBe("1.2.3.4")
    expect(normalizeHost("  a.example.com ")).toBe("a.example.com")
  })
})

describe("latencyTargets —— 下标必须对回原列表", () => {
  const nodes = [
    { protocol: "hysteria2", server: "hy.example.com", port: 443 }, // 不可测
    { protocol: "vless", server: "a.example.com", port: 443 },
    { protocol: "unknown", server: "", port: null }, // 不可测
    { protocol: "tuic", server: "t.example.com", port: 443 }, // 不可测
    { protocol: "trojan", server: "b.example.com", port: 8443 },
    { protocol: "ss", server: "c.example.com", port: null }, // 缺端口 → 跳过
  ]

  it("只收可测的，且 index 是**原列表下标**（前端据此回填）", () => {
    expect(latencyTargets(nodes)).toEqual([
      { index: 1, host: "a.example.com", port: 443 },
      { index: 4, host: "b.example.com", port: 8443 },
    ])
  })

  it("IPv6 地址在目标里已去掉方括号", () => {
    expect(latencyTargets([{ protocol: "vless", server: "[2001:db8::1]", port: 443 }])).toEqual([
      { index: 0, host: "2001:db8::1", port: 443 },
    ])
  })
})

describe("measureTcpHandshake", () => {
  it("握手成功 → 给出耗时，并且 socket 被关闭", async () => {
    const made = fakeSocket({ delayMs: 5 })
    const r = await measureTcpHandshake("a.example.com", 443, {
      connector: () => made.socket,
    })
    expect(r.ok).toBe(true)
    expect(r.latencyMs).toBeGreaterThanOrEqual(0)
    expect(r.reason).toBe("")
    // 不关会累积到第 7 个并发连接，直接撞平台硬限制
    expect(made.closed()).toBe(true)
  })

  it("连不上 → 中性文案，不写「不可用」", async () => {
    const made = fakeSocket({ outcome: "fail" })
    const r = await measureTcpHandshake("a.example.com", 443, { connector: () => made.socket })
    expect(r.ok).toBe(false)
    expect(r.latencyMs).toBeNull()
    expect(r.reason).toBe("本站未能连上该地址")
    expect(r.reason).not.toContain("不可用")
    expect(made.closed()).toBe(true)
  })

  it("挂起不返回 → 自己 race 出超时（connect 没有内置超时）", async () => {
    const made = fakeSocket({ outcome: "hang" })
    const r = await measureTcpHandshake("a.example.com", 443, {
      connector: () => made.socket,
      timeoutMs: 30,
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("超时")
    // 即使超时也必须把 socket 关掉
    expect(made.closed()).toBe(true)
  })

  it("close() 抛错不影响结果（请求结束平台也会回收）", async () => {
    const made = fakeSocket({ delayMs: 1, closeThrows: true })
    const r = await measureTcpHandshake("a.example.com", 443, { connector: () => made.socket })
    expect(r.ok).toBe(true)
  })

  it("地址或端口不合法 → 直接判定，不建连接", async () => {
    let connected = 0
    const connector: TcpConnector = () => {
      connected += 1
      return fakeSocket({}).socket
    }
    for (const [h, p] of [
      ["", 443],
      ["a.example.com", 0],
    ] as const) {
      const r = await measureTcpHandshake(h, p, { connector })
      expect(r.ok).toBe(false)
      expect(r.reason).toContain("缺少地址或端口")
    }
    expect(connected).toBe(0)
  })
})

describe("measureNodes", () => {
  it("空输入直接返回空数组（不发任何连接）", async () => {
    expect(await measureNodes([])).toEqual([])
  })

  it("结果带原下标，且失败与成功混在一起也各自正确", async () => {
    let n = 0
    const connector: TcpConnector = () => {
      n += 1
      return n === 1 ? fakeSocket({ delayMs: 1 }).socket : fakeSocket({ outcome: "fail" }).socket
    }
    const results = await measureNodes(
      [
        { index: 3, host: "a.example.com", port: 443 },
        { index: 7, host: "b.example.com", port: 443 },
      ],
      { connector }
    )
    expect(results.map((r) => r.index).sort((a, b) => a - b)).toEqual([3, 7])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.find((r) => r.index === 3)?.latencyMs).toBeGreaterThanOrEqual(0)
    expect(results.find((r) => r.index === 7)?.latencyMs).toBeNull()
  })

  it("并发度不超过平台硬限制 6", () => {
    expect(LATENCY_CONCURRENCY).toBeLessThanOrEqual(6)
  })
})

// ---- HTTP 层：路由 / 鉴权 / 返回结构 ----
//
// 这一层必须有：路由路径写错、忘记鉴权这类问题**纯函数测试覆盖不到**，
// 只会在线上暴露。
describe("POST /proxy/latency", () => {
  const SUB_HOST = "https://sub.example.com"
  // 节点名里刻意混入一个不可测的 hysteria2，验证「测不了 ≠ 不可用」这条边界
  const NODES = [
    "vless://aaaaaaaa-0000-0000-0000-000000000001@nope.invalid:443?security=tls#节点一",
    "hysteria2://pass@hy.example.com:443?sni=x.com#节点二",
    "trojan://pass@nope2.invalid:8443?sni=y.com#节点三",
  ].join("\n")

  let restores: Array<() => void> = []

  function stubSub(handler: (url: string) => Response | undefined): void {
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      // 只接管订阅地址；`connect()` 不走 fetch，所以不会被这里拦
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

  async function call(
    user: TestUser,
    body: Record<string, unknown>
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetchSelf(
      authRequest(user, "/proxy/latency", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    )
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  it("返回逐节点结果，下标对回原列表；不可测的协议被排除而不是判失败", async () => {
    const user = await makeUser()
    await activate(user.id)
    const subId = await seedSub(`${SUB_HOST}/sub`)
    stubSub((url) => (url.startsWith(SUB_HOST) ? new Response(NODES) : undefined))

    const { status, body } = await call(user, { id: subId })
    expect(status).toBe(200)
    expect(body.total).toBe(3)
    // hysteria2 不在可测集合里 ⇒ 只剩两个
    expect(body.testable).toBe(2)

    const results = body.results as Array<{ index: number; ok: boolean; reason: string }>
    expect(results.map((r) => r.index)).toEqual([0, 2])

    // `.invalid` 是保留域名，永远解析不了 ⇒ 必然失败；
    // 但文案必须是中性的「测不到」，不能写「不可用」
    for (const r of results) {
      expect(r.ok).toBe(false)
      expect(r.reason).not.toContain("不可用")
    }
  })

  it("未被授权的调用者拿不到结果（需要登录 + 已启用）", async () => {
    const user = await makeUser()
    const subId = await seedSub(`${SUB_HOST}/sub`)
    const { status } = await call(user, { id: subId })
    expect(status).toBe(403) // 未启用代理功能
  })

  it("缺少 id → 400；订阅不存在 → 404", async () => {
    const user = await makeUser()
    await activate(user.id)
    expect((await call(user, {})).status).toBe(400)
    expect((await call(user, { id: "not-exist" })).status).toBe(404)
  })

  it("订阅抓不到 → 502，且不返回任何节点结果", async () => {
    const user = await makeUser()
    await activate(user.id)
    const subId = await seedSub(`${SUB_HOST}/dead`)
    stubSub((url) => (url.startsWith(SUB_HOST) ? new Response("boom", { status: 500 }) : undefined))

    const { status } = await call(user, { id: subId })
    expect(status).toBe(502)
  })
})

describe("TCP 地址守卫", () => {
  it("拒绝本机或内网目标，且不调用 connector", async () => {
    let connected = 0
    const result = await measureTcpHandshake("127.0.0.1", 443, {
      connector: () => {
        connected++
        return fakeSocket({}).socket
      },
    })
    expect(result).toEqual({ ok: false, latencyMs: null, reason: "节点地址为本机或内网地址" })
    expect(connected).toBe(0)
  })

  it("TCP 地址守卫规范化公网主机并拒绝混入端口", () => {
    expect(assertPublicTcpHost("example.com")).toBe("example.com")
    expect(() => assertPublicTcpHost("10.0.0.1")).toThrow(/本机或内网/)
    expect(() => assertPublicTcpHost("example.com:443")).toThrow(/无效/)
  })
})
