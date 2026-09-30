// DNS SRV 记录。
//
// 为什么单独测：SRV 与其它类型的**数据形态不同** —— 它不是「一行 content」，
// 而是 priority/weight/port/target 四个字段，且 Cloudflare 只接受 `data` 对象
// （不接受 content）。这里覆盖三件容易出错的事：
//   ① 记录名拼装（`_service._proto[.prefix].base`，前导下划线由服务端补）
//   ② CF 收到的是 data 对象而不是 content
//   ③ 校验边界（端口 0 非法、优先级 0 合法、65536 越界）
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, type TestUser } from "./helpers"
import { uuid } from "../src/crypto"

const CF = "https://api.cloudflare.com"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

interface Call {
  url: string
  method: string
  body: unknown
}

let calls: Call[] = []
let restores: Array<() => void> = []

function stubFetch(
  handler: (url: string, init: RequestInit | undefined, method: string) => Response | undefined
): void {
  const original = globalThis.fetch
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? "GET").toUpperCase()
    let body: unknown = null
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    calls.push({ url, method, body })
    const res = handler(url, init, method)
    if (res) return res
    return original(input as RequestInfo, init)
  }) as unknown as typeof fetch
  globalThis.fetch = stub
  restores.push(() => {
    globalThis.fetch = original
  })
}

/** 让 Cloudflare 的 DNS 接口全部成功 */
function stubCloudflare() {
  stubFetch((url, _init, method) => {
    if (!url.startsWith(CF)) return undefined
    if (method === "POST" && url.includes("/dns_records")) {
      return jsonResponse({ success: true, result: { id: "cf-rec-1" } })
    }
    if (method === "PUT" && url.includes("/dns_records/")) {
      return jsonResponse({ success: true, result: { id: "cf-rec-1" } })
    }
    if (method === "DELETE") {
      return jsonResponse({ success: true, result: { id: "cf-rec-1" } })
    }
    return undefined
  })
}

beforeEach(() => {
  calls = []
})

afterEach(() => {
  for (let i = restores.length - 1; i >= 0; i--) restores[i]()
  restores = []
  vi.restoreAllMocks()
})

/**
 * 造一个「有域名 + 有子域名」的用户。
 *
 * `createDns` 要求 users → domains → subdomains 三层都存在，缺任一层都会
 * 提前返回 NO_DOMAIN，测不到 SRV 逻辑。
 */
async function makeUserWithDomain(suffix = "sub"): Promise<{
  user: TestUser
  domainId: string
  subdomainId: string
  base: string
}> {
  const user = await makeUser()
  const domainId = uuid()
  const subdomainId = uuid()
  const now = new Date().toISOString()
  // 域名名用 username 保证唯一（domains.name 无唯一约束，但 fqdn 校验按它比对）
  const rootName = `${user.username}.doulor.cn`
  const subFqdn = `${suffix}.${rootName}`

  await env.DB.prepare(
    `INSERT INTO domains (id, user_id, name, zone_id, status, created_at)
     VALUES (?, ?, ?, ?, 'active', ?)`
  )
    .bind(domainId, user.id, rootName, "test-zone", now)
    .run()

  await env.DB.prepare(
    `INSERT INTO subdomains (id, user_id, name, fqdn, status, created_at)
     VALUES (?, ?, ?, ?, 'active', ?)`
  )
    .bind(subdomainId, user.id, suffix, subFqdn, now)
    .run()

  return { user, domainId, subdomainId, base: subFqdn }
}

function createRecord(
  user: TestUser,
  body: Record<string, unknown>
): Promise<Response> {
  return fetchSelf(
    authRequest(user, "/dns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  )
}

function lastCfPost(): Record<string, unknown> | undefined {
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i]
    if (c.method === "POST" && c.url.includes("/dns_records")) {
      return c.body as Record<string, unknown>
    }
  }
  return undefined
}

describe("POST /dns —— SRV 记录", () => {
  it("拼出 `_service._proto.base` 形式的记录名，并向 CF 传 data 对象", async () => {
    const { user, subdomainId, base } = await makeUserWithDomain()
    stubCloudflare()

    const res = await createRecord(user, {
      subdomainId,
      name: "@",
      type: "SRV",
      srvService: "sip",
      srvProto: "tcp",
      srvWeight: 5,
      srvPort: 5060,
      srvTarget: "sip.example.com",
    })
    expect(res.status).toBe(201)
    const out = (await res.json()) as {
      record: {
        type: string
        name: string
        fqdn: string
        content: string
        priority?: number
        srv?: { weight: number; port: number; target: string }
      }
    }
    // service / proto 由服务端补前导下划线
    expect(out.record.name).toBe("_sip._tcp")
    expect(out.record.fqdn).toBe(`_sip._tcp.${base}`)
    expect(out.record.srv).toEqual({ weight: 5, port: 5060, target: "sip.example.com" })
    // 缺省优先级 10
    expect(out.record.priority).toBe(10)
    // content 是给人看的渲染串，顺序为 优先级 权重 端口 目标
    expect(out.record.content).toBe("10 5 5060 sip.example.com")

    // 关键：CF 收到的是 data 对象，且**没有** content 字段
    const sent = lastCfPost()
    expect(sent?.type).toBe("SRV")
    expect(sent?.name).toBe(`_sip._tcp.${base}`)
    expect(sent?.data).toEqual({
      priority: 10,
      weight: 5,
      port: 5060,
      target: "sip.example.com",
    })
    expect(sent?.content).toBeUndefined()
  })

  it("用户填 `_sip`（已带下划线）也不会拼成双下划线", async () => {
    const { user, subdomainId } = await makeUserWithDomain()
    stubCloudflare()
    const res = await createRecord(user, {
      subdomainId,
      name: "@",
      type: "SRV",
      srvService: "_sip",
      srvProto: "_tcp",
      srvPort: 5060,
      srvTarget: "a.example.com",
    })
    const out = (await res.json()) as { record: { name: string } }
    expect(out.record.name).toBe("_sip._tcp")
  })

  it("name 非空时作为「服务标签之后」的前缀", async () => {
    const { user, subdomainId, base } = await makeUserWithDomain()
    stubCloudflare()
    const res = await createRecord(user, {
      subdomainId,
      name: "chat",
      type: "SRV",
      srvService: "xmpp",
      srvProto: "tcp",
      srvPort: 5223,
      srvTarget: "server.example.com",
    })
    const out = (await res.json()) as { record: { name: string; fqdn: string } }
    expect(out.record.name).toBe("_xmpp._tcp.chat")
    expect(out.record.fqdn).toBe(`_xmpp._tcp.chat.${base}`)
  })

  it("优先级 0 是合法值（RFC 2782 里 0 表示最高优先）", async () => {
    const { user, subdomainId } = await makeUserWithDomain()
    stubCloudflare()
    const res = await createRecord(user, {
      subdomainId,
      name: "@",
      type: "SRV",
      srvService: "sip",
      srvProto: "udp",
      srvPriority: 0,
      srvWeight: 0,
      srvPort: 5060,
      srvTarget: "a.example.com",
    })
    expect(res.status).toBe(201)
    const out = (await res.json()) as { record: { priority?: number; content: string } }
    expect(out.record.priority).toBe(0)
    expect(out.record.content).toBe("0 0 5060 a.example.com")
  })

  it("缺端口 / 缺目标主机 → 400", async () => {
    const { user, subdomainId } = await makeUserWithDomain()
    stubCloudflare()

    const noPort = await createRecord(user, {
      subdomainId,
      name: "@",
      type: "SRV",
      srvService: "sip",
      srvProto: "tcp",
      srvTarget: "a.example.com",
    })
    expect(noPort.status).toBe(400)

    const noTarget = await createRecord(user, {
      subdomainId,
      name: "@",
      type: "SRV",
      srvService: "sip",
      srvProto: "tcp",
      srvPort: 5060,
    })
    expect(noTarget.status).toBe(400)

    // 一次 CF 调用都不该发生
    expect(calls.some((c) => c.url.includes("/dns_records"))).toBe(false)
  })

  it("端口 0 / 65536 越界 → 400（端口必须是 1–65535）", async () => {
    const { user, subdomainId } = await makeUserWithDomain()
    stubCloudflare()
    for (const port of [0, 65536, -1, 1.5]) {
      const res = await createRecord(user, {
        subdomainId,
        name: "@",
        type: "SRV",
        srvService: "sip",
        srvProto: "tcp",
        srvPort: port,
        srvTarget: "a.example.com",
      })
      expect(res.status, `port=${port}`).toBe(400)
    }
  })

  it("service 含点号 → 400（会破坏记录名分段）", async () => {
    const { user, subdomainId } = await makeUserWithDomain()
    stubCloudflare()
    const res = await createRecord(user, {
      subdomainId,
      name: "@",
      type: "SRV",
      srvService: "si.p",
      srvProto: "tcp",
      srvPort: 5060,
      srvTarget: "a.example.com",
    })
    expect(res.status).toBe(400)
  })

  it("SRV 不能被代理（proxied 恒为 false）", async () => {
    const { user, subdomainId } = await makeUserWithDomain()
    stubCloudflare()
    await createRecord(user, {
      subdomainId,
      name: "@",
      type: "SRV",
      srvService: "sip",
      srvProto: "tcp",
      srvPort: 5060,
      srvTarget: "a.example.com",
      proxied: true,
    })
    expect(lastCfPost()?.proxied).toBe(false)
  })
})

describe("非 SRV 记录不受影响（回归）", () => {
  it("A 记录仍走 content，且不会带上 data", async () => {
    const { user, subdomainId } = await makeUserWithDomain()
    stubCloudflare()
    const res = await createRecord(user, {
      subdomainId,
      name: "www",
      type: "A",
      content: "192.0.2.10",
    })
    expect(res.status).toBe(201)
    const sent = lastCfPost()
    expect(sent?.content).toBe("192.0.2.10")
    expect(sent?.data).toBeUndefined()
  })

  it("MX 记录的 priority 仍从 body.priority 取", async () => {
    const { user, subdomainId } = await makeUserWithDomain()
    stubCloudflare()
    await createRecord(user, {
      subdomainId,
      name: "@",
      type: "MX",
      content: "mail.example.com",
      priority: 5,
    })
    const sent = lastCfPost()
    expect(sent?.priority).toBe(5)
    expect(sent?.content).toBe("mail.example.com")
    expect(sent?.data).toBeUndefined()
  })
})
