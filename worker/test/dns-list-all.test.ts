// GET /api/dns 的「全部记录」语义（2026-10-16 站长要求）。
//
// 背景：站长名下有 3 个子域名（ttest.tyu.me / xxxxx.tyu.me / testttt.7u.nz），
// 记录全建在 xxxxx.tyu.me 下，而界面一直只看「当前选中的域名」（ttest.tyu.me），
// 于是显示「当前域名 0 条解析 / 还没有 DNS 记录」—— 让他以为记录丢了。
// 列表接口因此改成：**不传 subdomainId ⇒ 返回该用户名下全部子域名的记录**，
// 并且每条记录都带 `subdomainFqdn`（前端据此显示「这条属于哪个域名」）。
//
// 这里钉住三件事（都是这次改动最容易悄悄回归的地方）：
//   1. 不传参数 ⇒ 跨域名全都在，且每条 `subdomainFqdn` 指向它真正的归属域名
//      （不逐域名发查询、也不张冠李戴）；
//   2. 传 `subdomainId` ⇒ 过滤仍然生效（老调用方与既有测试不能被打断）；
//   3. 编辑 / 删除只认**记录自己的** id 与域名 —— 跨域名列表下「当前在看哪个域名」
//      根本不是请求的一部分，绝不能让另一个域名下的记录被改到或删掉。
//
// ⚠️ 第 3 条是后端能给出的最强证据：前端 `dnsApi.update(id, …)` / `dnsApi.remove(id)`
//    只传记录自己的 id（payload 里没有 subdomainId / rootDomain），而服务端是按
//    `existing.domain_id` / `existing.subdomain_id` 现算域的 —— 两边都对，
//    才有下面这些断言。前端没有组件级测试环境（仓库只有 worker 侧的 vitest），
//    所以「用记录自己的域名」这件事在前端由类型 + 构建 + 这里的契约一起守住。
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, setPermissions, type TestUser } from "./helpers"

const CF = "https://api.cloudflare.com"

let restores: Array<() => void> = []

/**
 * 打桩 Cloudflare API：只接管 DNS 记录的写入，其余请求回落真实 fetch。
 *
 * 为什么必须打桩：编辑 / 删除一条**有 cf_id 的记录**时，服务端会真去调
 * Cloudflare（updateDns / deleteDns 里那两处）。测试不该依赖外网，也不该
 * 因为网络抖动变红 —— 与 dns-permission.test.ts / dns-srv.test.ts 同一套写法。
 */
function stubCloudflare(): void {
  const original = globalThis.fetch
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? "GET").toUpperCase()
    if (url.startsWith(CF) && method !== "GET") {
      if (url.includes("/dns_records")) {
        return new Response(JSON.stringify({ success: true, result: { id: "cf-rec-1" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
    }
    return original(input as RequestInfo, init)
  }) as unknown as typeof fetch
  globalThis.fetch = stub
  restores.push(() => {
    globalThis.fetch = original
  })
}

afterEach(() => {
  for (let i = restores.length - 1; i >= 0; i--) restores[i]()
  restores = []
  vi.restoreAllMocks()
})

/**
 * 有 `dns` 权限的用户。
 *
 * ⚠️ 必须显式给：`dns` 不在 permissions.ts 的 `DEFAULT_ALLOWED` 里（它是 CF zone
 * 配额闸，默认关闭），`makeUser()` 出来的账号默认没有它，`GET /api/dns` 会直接 403。
 * 有权限位 = 后端 `dnsAccessFor` 判成 `full` 档，因此本文件不需要租约与根域配置，
 * 测的就是列表 / 单条的归属逻辑本身。
 */
async function makeDnsUser(): Promise<TestUser> {
  const u = await makeUser()
  await setPermissions(
    u.id,
    JSON.stringify({ r2: true, ai: false, proxy: true, doulor: false, dns: true })
  )
  return u
}

interface SubSeed {
  id: string
  fqdn: string
}

interface Fixture {
  domainId: string
  /** '@' 主域名（整账号的 domains 行） */
  primary: SubSeed
  /** 一个没放任何记录的子域名 —— 对应站长那个「默认选中的域名」 */
  tttest: SubSeed
  /** 记录真正所在的那个子域名 */
  xxxxx: SubSeed
}

/**
 * 造「一个用户 + 三个子域名」。
 *
 * 三个而不是两个：站长的故障是「界面停在 A、记录在 B」，要能区分
 * 「返回了 B」与「返回了全部（A+B+C）」两种实现，必须有一个 A 之外的空域名。
 */
async function seedThreeSubdomains(u: TestUser): Promise<Fixture> {
  const domainId = crypto.randomUUID()
  const root = `root-${u.username}.tyu.me`
  const now = new Date().toISOString()
  await env.DB.prepare(
    "INSERT INTO domains (id, user_id, name, zone_id, status, created_at) VALUES (?, ?, ?, 'test-zone', 'active', ?)"
  )
    .bind(domainId, u.id, root, now)
    .run()

  const mk = async (name: string): Promise<SubSeed> => {
    const id = crypto.randomUUID()
    const fqdn = name === "@" ? root : `${name}.${root}`
    await env.DB.prepare(
      "INSERT INTO subdomains (id, user_id, name, fqdn, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)"
    )
      .bind(id, u.id, name, fqdn, now)
      .run()
    return { id, fqdn }
  }

  return {
    domainId,
    primary: await mk("@"),
    tttest: await mk("tttest"),
    xxxxx: await mk("xxxxx"),
  }
}

/** 直接塞一条解析（比走接口快，也不受限流影响） */
async function seedRecord(
  domainId: string,
  sub: SubSeed,
  name: string,
  content: string,
  opts: { banned?: boolean } = {}
): Promise<{ id: string; fqdn: string }> {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const fqdn = name === "@" ? sub.fqdn : `${name}.${sub.fqdn}`
  await env.DB.prepare(
    `INSERT INTO dns_records
       (id, domain_id, subdomain_id, cf_id, name, fqdn, type, content, ttl, proxied,
        status, banned_at, created_at, updated_at)
     VALUES (?, ?, ?, 'cf-x', ?, ?, 'A', ?, 1, 0, 'active', ?, ?, ?)`
  )
    .bind(id, domainId, sub.id, name, fqdn, content, opts.banned ? now : null, now, now)
    .run()
  return { id, fqdn }
}

interface Item {
  id: string
  subdomainId: string | null
  subdomainFqdn?: string | null
  name: string
  fqdn: string
  type: string
  content: string
}

interface ListBody {
  records: Item[]
  dnsUsage: { used: number; limit: number | null }
}

function listDns(u: TestUser, query = ""): Promise<Response> {
  return fetchSelf(authRequest(u, `/api/dns${query}`))
}

function putRecord(
  u: TestUser,
  id: string,
  body: Record<string, unknown>
): Promise<Response> {
  return fetchSelf(
    authRequest(u, `/dns/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  )
}

describe("GET /api/dns：不传 subdomainId 就是该用户全部域名的记录", () => {
  it("跨子域名的记录一次全给，且每条都带自己的 subdomainFqdn", async () => {
    const u = await makeDnsUser()
    const fx = await seedThreeSubdomains(u)
    // 站长的情形：记录只在 xxxxx 下；tttest 下 0 条
    const inXxxxx = await seedRecord(fx.domainId, fx.xxxxx, "blog", "192.0.2.1")
    const apex = await seedRecord(fx.domainId, fx.primary, "@", "192.0.2.2")

    const res = await listDns(u)
    expect(res.status).toBe(200)
    const body = await res.json<ListBody>()

    // 全部都在：既有 xxxxx 下的，也有 '@' 主域名下的
    expect(body.records.map((r) => r.id).sort()).toEqual([inXxxxx.id, apex.id].sort())
    // 归属逐条正确（不是都写主域名、也不是空）
    const byId = new Map(body.records.map((r) => [r.id, r]))
    expect(byId.get(inXxxxx.id)!.subdomainFqdn).toBe(fx.xxxxx.fqdn)
    expect(byId.get(inXxxxx.id)!.subdomainId).toBe(fx.xxxxx.id)
    expect(byId.get(apex.id)!.subdomainFqdn).toBe(fx.primary.fqdn)
    // 用量仍是**跨全部域名**的真实条数（与列表同一口径）
    expect(body.dnsUsage.used).toBe(2)
  })

  it("被处置（banned_at 非空）的记录不出现 —— 全量视图同样要过滤掉幽灵记录", async () => {
    const u = await makeDnsUser()
    const fx = await seedThreeSubdomains(u)
    const live = await seedRecord(fx.domainId, fx.xxxxx, "blog", "192.0.2.1")
    await seedRecord(fx.domainId, fx.tttest, "gone", "192.0.2.9", { banned: true })

    const body = await (await listDns(u)).json<ListBody>()
    expect(body.records.map((r) => r.id)).toEqual([live.id])
    expect(body.dnsUsage.used).toBe(1)
  })

  it("别人的记录一条都不会跟着出来（过滤条件在服务端，不看前端传了什么）", async () => {
    const mine = await makeDnsUser()
    const fx = await seedThreeSubdomains(mine)
    await seedRecord(fx.domainId, fx.xxxxx, "blog", "192.0.2.1")

    const other = await makeDnsUser()
    const ofx = await seedThreeSubdomains(other)
    const theirs = await seedRecord(ofx.domainId, ofx.xxxxx, "blog", "198.51.100.1")

    const body = await (await listDns(mine)).json<ListBody>()
    expect(body.records.some((r) => r.id === theirs.id)).toBe(false)
    expect(body.records).toHaveLength(1)
    expect(body.dnsUsage.used).toBe(1)
  })
})

describe("GET /api/dns?subdomainId=xxx：原有过滤能力不变", () => {
  it("只返回该子域名的记录（别的子域名下的看不到）", async () => {
    const u = await makeDnsUser()
    const fx = await seedThreeSubdomains(u)
    const inXxxxx = await seedRecord(fx.domainId, fx.xxxxx, "blog", "192.0.2.1")
    await seedRecord(fx.domainId, fx.primary, "@", "192.0.2.2")

    const res = await listDns(u, `?subdomainId=${fx.xxxxx.id}`)
    expect(res.status).toBe(200)
    const body = await res.json<ListBody>()
    expect(body.records.map((r) => r.id)).toEqual([inXxxxx.id])
    // 过滤视图里归属列同样要准（前端每一行都显示它）
    expect(body.records[0].subdomainFqdn).toBe(fx.xxxxx.fqdn)
    // ⚠️ 用量**不随筛选变化**：上限是全账号的，跟着筛选变会让「已用」忽大忽小
    expect(body.dnsUsage.used).toBe(2)
  })

  it("没有记录的域名 ⇒ 空列表（前端据此显示「其它域名下还有 N 条」）", async () => {
    const u = await makeDnsUser()
    const fx = await seedThreeSubdomains(u)
    await seedRecord(fx.domainId, fx.xxxxx, "blog", "192.0.2.1")

    const body = await (await listDns(u, `?subdomainId=${fx.tttest.id}`)).json<ListBody>()
    expect(body.records).toEqual([])
    // 这一句是前端空状态文案的依据：自己是空的，但账号里还有 1 条
    expect(body.dnsUsage.used).toBe(1)
  })

  it("拿别人的 subdomainId 查 ⇒ 403（不能靠 id 探测别人的域名）", async () => {
    const mine = await makeDnsUser()
    await seedThreeSubdomains(mine)
    const other = await makeDnsUser()
    const ofx = await seedThreeSubdomains(other)

    const res = await listDns(mine, `?subdomainId=${ofx.xxxxx.id}`)
    expect(res.status).toBe(403)
    expect((await res.json<{ code: string }>()).code).toBe("FORBIDDEN")
  })
})

describe("跨域名列表下的编辑 / 删除：一律用记录自己的 id 与域名", () => {
  // 这一段会真的走 updateDns / deleteDns 里那两处 Cloudflare 调用（记录带 cf_id）
  beforeEach(() => stubCloudflare())

  it("编辑一条记录：留在它自己的域名下，另一个域名下的记录纹丝不动", async () => {
    const u = await makeDnsUser()
    const fx = await seedThreeSubdomains(u)
    // a 在 xxxxx 下、b 在 tttest 下（两者同名 `@`，正是「靠当前选中域名去改」会改错的那种）
    const a = await seedRecord(fx.domainId, fx.xxxxx, "@", "192.0.2.1")
    const b = await seedRecord(fx.domainId, fx.tttest, "@", "192.0.2.2")

    // 前端此刻「正在看」xxxxx（甚至筛选在别处都行）—— 请求里只有 b 自己的 id
    const res = await putRecord(u, b.id, { content: "203.0.113.9" })
    expect(res.status).toBe(200)
    const out = (await res.json<{ record: Item }>()).record
    expect(out.content).toBe("203.0.113.9")
    // fqdn 与归属都还是 tttest 的：fqdn 的基准由服务端按记录自己的 subdomain_id 重算
    expect(out.fqdn).toBe(b.fqdn)
    expect(out.subdomainId).toBe(fx.tttest.id)
    expect(out.subdomainFqdn).toBe(fx.tttest.fqdn)

    // 另一个域名下的同名记录（a）内容一个字都没变
    const rowA = await env.DB.prepare(
      "SELECT content, subdomain_id FROM dns_records WHERE id = ?"
    )
      .bind(a.id)
      .first<{ content: string; subdomain_id: string }>()
    expect(rowA!.content).toBe("192.0.2.1")
    expect(rowA!.subdomain_id).toBe(fx.xxxxx.id)
  })

  it("请求体里塞 subdomainId / rootDomain 也搬不动记录（改记录不看前端声明的域名）", async () => {
    const u = await makeDnsUser()
    const fx = await seedThreeSubdomains(u)
    const b = await seedRecord(fx.domainId, fx.tttest, "blog", "192.0.2.2")

    // 恶意/过期的前端可能把「我选的域名」一起发上来；updateDns 根本不读这两个字段，
    // 记录必须留在原地，不能因为 body 里多了一句声明就跑到别的域名下
    const res = await putRecord(u, b.id, {
      content: "203.0.113.10",
      subdomainId: fx.xxxxx.id,
      rootDomain: "tyu.me",
    })
    expect(res.status).toBe(200)
    const out = (await res.json<{ record: Item }>()).record
    expect(out.fqdn).toBe(b.fqdn)
    expect(out.subdomainId).toBe(fx.tttest.id)

    const row = await env.DB.prepare("SELECT subdomain_id, fqdn FROM dns_records WHERE id = ?")
      .bind(b.id)
      .first<{ subdomain_id: string; fqdn: string }>()
    expect(row!.subdomain_id).toBe(fx.tttest.id)
    expect(row!.fqdn).toBe(b.fqdn)
  })

  it("删除一条记录：只删它自己，另一个域名下的记录仍在列表里", async () => {
    const u = await makeDnsUser()
    const fx = await seedThreeSubdomains(u)
    const a = await seedRecord(fx.domainId, fx.xxxxx, "blog", "192.0.2.1")
    const b = await seedRecord(fx.domainId, fx.tttest, "blog", "192.0.2.2")

    const del = await fetchSelf(authRequest(u, `/dns/${b.id}`, { method: "DELETE" }))
    expect(del.status).toBe(204)

    const body = await (await listDns(u)).json<ListBody>()
    expect(body.records.map((r) => r.id)).toEqual([a.id])
    expect(body.dnsUsage.used).toBe(1)
  })

  it("改 / 删别人的记录 ⇒ 403（归属由记录的 domain_id 判，不由前端传的域名判）", async () => {
    const mine = await makeDnsUser()
    await seedThreeSubdomains(mine)
    const other = await makeDnsUser()
    const ofx = await seedThreeSubdomains(other)
    const theirs = await seedRecord(ofx.domainId, ofx.xxxxx, "blog", "198.51.100.1")

    const put = await putRecord(mine, theirs.id, { content: "203.0.113.11" })
    expect(put.status).toBe(403)
    expect((await put.json<{ code: string }>()).code).toBe("FORBIDDEN")

    const del = await fetchSelf(authRequest(mine, `/dns/${theirs.id}`, { method: "DELETE" }))
    expect(del.status).toBe(403)

    // 别人的记录内容没被改、也还在
    const row = await env.DB.prepare("SELECT content FROM dns_records WHERE id = ?")
      .bind(theirs.id)
      .first<{ content: string }>()
    expect(row!.content).toBe("198.51.100.1")
  })
})
