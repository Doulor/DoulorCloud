// 代理节点捐献的自动审核：逐个真实拉取订阅 → 只导入能解析出节点的 → 全不行则拒绝。
//
// 判据是「订阅链接有效 + 能解析出节点列表」。节点的真实连通性在 Cloudflare
// 出网侧测不了（无法对任意 TCP/UDP 端口探测），所以这里不假装能测。
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, setPermissions, type TestUser } from "./helpers"
import { parsePermissions } from "../src/permissions"

const SUB_HOST = "https://sub.example.com"
const GOOD_HOST = "https://good-sub.example.com"

/** 一段真实能被 parseSubscription 解析的订阅内容（明文行式） */
const VALID_SUB = [
  "vless://11111111-2222-3333-4444-555555555555@1.2.3.4:443?type=ws&security=tls#香港节点",
  "vless://11111111-2222-3333-4444-555555555555@5.6.7.8:443?type=ws&security=tls#香港节点2",
  "ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ=@9.9.9.9:8388#美国节点",
].join("\n")

interface Call {
  url: string
  method: string
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
    calls.push({ url, method })
    const res = handler(url, init, method)
    if (res) return res
    return original(input as RequestInfo, init)
  }) as unknown as typeof fetch
  globalThis.fetch = stub
  restores.push(() => {
    globalThis.fetch = original
  })
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } })
}

beforeEach(() => {
  calls = []
  // proxy_subscriptions 是跨用例可查的表，清掉避免互相干扰
  return env.DB.prepare("DELETE FROM proxy_subscriptions").run()
})

afterEach(() => {
  for (let i = restores.length - 1; i >= 0; i--) restores[i]()
  restores = []
  vi.restoreAllMocks()
})

/** 造一个可捐献的用户：显式关掉 proxy 权限，才能看出「捐献解锁」 */
async function makeDonor(): Promise<TestUser> {
  const user = await makeUser()
  await env.DB.prepare("UPDATE users SET email = ? WHERE id = ?")
    .bind(`${user.username}@example.net`, user.id)
    .run()
  await setPermissions(user.id, JSON.stringify({ r2: true, ai: true, frp: true, proxy: false }))
  return user
}

async function submit(user: TestUser, urls: string[]) {
  const res = await fetchSelf(
    authRequest(user, "/donations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "proxy", payload: { subUrls: urls } }),
    })
  )
  return { res, body: (await res.json()) as Record<string, unknown> }
}

async function permsOf(userId: string) {
  const row = await env.DB.prepare("SELECT permissions FROM users WHERE id = ?")
    .bind(userId)
    .first<{ permissions: string | null }>()
  return parsePermissions(row?.permissions)
}

async function subs() {
  const r = await env.DB.prepare(
    "SELECT name, region, url, protocol, status, source_donation_id FROM proxy_subscriptions ORDER BY url"
  ).all<{
    name: string
    region: string | null
    url: string
    protocol: string
    status: string
    source_donation_id: string | null
  }>()
  return r.results ?? []
}

describe("代理捐献自动审核", () => {
  it("订阅有效 → 自动通过、导入节点池（带识别出的协议/地区）、解锁 proxy 权限", async () => {
    const user = await makeDonor()
    stubFetch((url) => (url.startsWith(SUB_HOST) ? textResponse(VALID_SUB) : undefined))

    const { res, body } = await submit(user, [`${SUB_HOST}/sub/abc`])
    expect(res.status).toBe(200)
    expect(body.status).toBe("approved")
    expect(body.autoReviewed).toBe(true)
    expect(String(body.reviewNote)).toContain("1/1 个订阅可用")
    expect(String(body.reviewNote)).toContain("3 个节点")

    const rows = await subs()
    expect(rows).toHaveLength(1)
    expect(rows[0].url).toBe(`${SUB_HOST}/sub/abc`)
    expect(rows[0].name).toBe("sub.example.com")
    expect(rows[0].protocol).toBe("vless") // 出现 2 次，是最常见协议
    expect(rows[0].region).toBe("综合") // 节点名里有香港也有美国 → 取不到唯一地区
    expect(rows[0].status).toBe("online")
    // 记下来源，撤销时据此精确收回
    expect(rows[0].source_donation_id).toBe(body.id)

    expect((await permsOf(user.id)).proxy).toBe(true)
  })

  it("订阅拉不到内容 → 自动拒绝，且不导入任何订阅", async () => {
    const user = await makeDonor()
    stubFetch((url) => (url.startsWith(SUB_HOST) ? textResponse("not found", 404) : undefined))

    const { body } = await submit(user, [`${SUB_HOST}/dead`])
    expect(body.status).toBe("rejected")
    expect(String(body.reviewNote)).toContain("没有解析出节点")
    expect(String(body.reviewNote)).toContain("HTTP 404")
    expect(await subs()).toHaveLength(0)
    expect((await permsOf(user.id)).proxy).toBe(false)
  })

  it("内容能抓到但不是节点列表（比如给了个网页）→ 拒绝", async () => {
    const user = await makeDonor()
    stubFetch((url) =>
      url.startsWith(SUB_HOST)
        ? textResponse("<!DOCTYPE html><html><body>hello</body></html>")
        : undefined
    )
    const { body } = await submit(user, [`${SUB_HOST}/page`])
    expect(body.status).toBe("rejected")
    expect(await subs()).toHaveLength(0)
  })

  it("部分有效 → 只导入有效的那个，并在结论里说明被剔掉的原因", async () => {
    const user = await makeDonor()
    stubFetch((url) => {
      if (url.startsWith(GOOD_HOST)) return textResponse(VALID_SUB)
      if (url.startsWith(SUB_HOST)) return textResponse("", 500)
      return undefined
    })

    const { body } = await submit(user, [`${GOOD_HOST}/ok`, `${SUB_HOST}/bad`])
    expect(body.status).toBe("approved")
    expect(String(body.reviewNote)).toContain("1/2 个订阅可用")
    expect(String(body.reviewNote)).toContain("未通过")

    const rows = await subs()
    expect(rows).toHaveLength(1)
    expect(rows[0].url).toBe(`${GOOD_HOST}/ok`)
  })

  it("内网/本机地址被逐个判失败（SSRF 守卫）", async () => {
    const user = await makeDonor()
    stubFetch((url) =>
      url.startsWith(GOOD_HOST) ? textResponse(VALID_SUB) : undefined
    )
    // 三个内网地址 + 一个有效：只有有效的被导入
    const { body } = await submit(user, [
      "http://127.0.0.1/sub",
      "http://10.0.0.5/sub",
      "http://169.254.169.254/latest/meta-data",
      `${GOOD_HOST}/ok`,
    ])
    expect(body.status).toBe("approved")
    expect(String(body.reviewNote)).toContain("不能是本机或内网地址")
    const rows = await subs()
    expect(rows).toHaveLength(1)
    expect(rows[0].url).toBe(`${GOOD_HOST}/ok`)
    // 内网地址根本没被请求出去
    expect(calls.some((c) => c.url.includes("169.254.169.254"))).toBe(false)
  })

  it("同一个链接已在节点池里 → 不重复导入", async () => {
    const user = await makeDonor()
    stubFetch((url) => (url.startsWith(SUB_HOST) ? textResponse(VALID_SUB) : undefined))
    await env.DB.prepare(
      `INSERT INTO proxy_subscriptions
         (id, name, region, url, protocol, status, enabled, sort_order, created_at, updated_at)
       VALUES ('manual-1', '手工加的', NULL, ?, 'mixed', 'unknown', 1, 0, ?, ?)`
    )
      .bind(`${SUB_HOST}/sub/abc`, new Date().toISOString(), new Date().toISOString())
      .run()

    const { body } = await submit(user, [`${SUB_HOST}/sub/abc`])
    expect(body.status).toBe("approved")
    const rows = await subs()
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe("手工加的") // 保留管理员原来那条
    expect(rows[0].source_donation_id).toBeNull()
  })

  it("超过数量上限 → 400，不建任何记录", async () => {
    const user = await makeDonor()
    const urls = Array.from({ length: 9 }, (_, i) => `${SUB_HOST}/sub/${i}`)
    const { res, body } = await submit(user, urls)
    expect(res.status).toBe(400)
    expect(body.code).toBe("TOO_MANY_SUB_URLS")
    expect(calls.some((c) => c.url.startsWith(SUB_HOST))).toBe(false)
  })

  it("非 http(s) 的链接 → 400", async () => {
    const user = await makeDonor()
    const { res, body } = await submit(user, ["ftp://example.com/sub"])
    expect(res.status).toBe(400)
    expect(body.code).toBe("INVALID_SUB_URL")
  })

  it("没填链接 → 400", async () => {
    const user = await makeDonor()
    const { res, body } = await submit(user, [])
    expect(res.status).toBe(400)
    expect(body.code).toBe("NO_SUB_URLS")
  })
})

describe("撤销代理捐献时收回订阅", () => {
  it("只删本单导入的，不碰管理员手工添加的", async () => {
    const admin = await makeUser({ role: "admin" })
    const donor = await makeDonor()
    // 管理员手工加的一条
    await env.DB.prepare(
      `INSERT INTO proxy_subscriptions
         (id, name, region, url, protocol, status, enabled, sort_order, created_at, updated_at)
       VALUES ('manual-2', '手工加的', NULL, 'https://manual.example.com/sub', 'mixed', 'unknown', 1, 0, ?, ?)`
    )
      .bind(new Date().toISOString(), new Date().toISOString())
      .run()

    stubFetch((url) =>
      url.startsWith(SUB_HOST) || url.startsWith(GOOD_HOST)
        ? textResponse(VALID_SUB)
        : undefined
    )
    const { body } = await submit(donor, [`${SUB_HOST}/a`, `${GOOD_HOST}/b`])
    expect(body.status).toBe("approved")
    expect(await subs()).toHaveLength(3) // 2 条捐献 + 1 条手工

    const res = await fetchSelf(
      authRequest(admin, `/admin/donations/${body.id}/revoke`, { method: "POST" })
    )
    expect(res.status).toBe(200)
    const out = (await res.json()) as {
      releasedSubscriptions: number
      revokedPermission: boolean
    }
    expect(out.releasedSubscriptions).toBe(2)
    expect(out.revokedPermission).toBe(true)

    const left = await subs()
    expect(left).toHaveLength(1)
    expect(left[0].name).toBe("手工加的")
    expect((await permsOf(donor.id)).proxy).toBe(false)
  })
})
