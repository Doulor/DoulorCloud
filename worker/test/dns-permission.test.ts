// DNS 记录的两个闸：模块权限（dns）+ 每用户记录数上限。
//
// 为什么单独钉这两条：
//   ① DNS 记录吃的是**全站共用**的 Cloudflare zone 配额（Free 套餐每 zone 200 条）。
//      闸门失效时不会有人报错，而是所有用户一起建不了新记录（CF 报 81045），
//      排查成本极高 —— 所以「上限算多了 / 算漏了」必须由测试挡住；
//   ② 权限闸与数量闸写反（比如数量检查排在权限之前、或管理员被一起卡住）
//      只会静静地放行或静静地多拦，同样没有任何报错。
//
// 这里测的是真实路由（miniflare SELF.fetch），走完整
// 入口 → 路由 → requireFeatureUser → handler 链路，是端到端证据。
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { env } from "cloudflare:workers"
import {
  authRequest,
  fetchSelf,
  makeUser,
  setPermissions,
  setSetting,
  type TestUser,
} from "./helpers"
import { uuid } from "../src/crypto"

const CF = "https://api.cloudflare.com"

/** 有 dns 权限的显式权限 JSON（其余模块取值不影响本文件） */
const WITH_DNS = JSON.stringify({
  r2: true,
  ai: false,
  proxy: true,
  doulor: false,
  dns: true,
})

/** 显式没有 dns 权限 —— 与线上存量用户（迁移后）同形 */
const WITHOUT_DNS = JSON.stringify({
  r2: true,
  ai: false,
  proxy: true,
  doulor: false,
  dns: false,
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

let cfCalls: string[] = []
let restores: Array<() => void> = []

/**
 * 打桩 Cloudflare API：只接管 DNS 记录写入，其余请求回落真实 fetch
 * （与 dns-srv.test.ts 同一套写法，避免这里因为网络慢而偶发红）。
 */
function stubCloudflare(): void {
  const original = globalThis.fetch
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? "GET").toUpperCase()
    if (url.startsWith(CF) && method !== "GET") {
      cfCalls.push(`${method} ${url}`)
      if (url.includes("/dns_records")) {
        return jsonResponse({ success: true, result: { id: "cf-rec-1" } })
      }
    }
    return original(input as RequestInfo, init)
  }) as unknown as typeof fetch
  globalThis.fetch = stub
  restores.push(() => {
    globalThis.fetch = original
  })
}

beforeEach(() => {
  cfCalls = []
})

afterEach(() => {
  for (let i = restores.length - 1; i >= 0; i--) restores[i]()
  restores = []
  vi.restoreAllMocks()
})

interface Fixture {
  user: TestUser
  domainId: string
  /** '@' 子域名（记录默认挂它下面） */
  subdomainId: string
  fqdn: string
}

/**
 * 造一个「有域名 + 有 '@' 子域名」的用户。
 *
 * `createDns` 要求 users → domains → subdomains 三层都在，缺任一层会先返回
 * NO_DOMAIN，测不到权限/数量闸。`dnsAllowed=false` 时**显式**写 dns:false
 * （而不是留 NULL）—— 与迁移后的存量用户同形，也让「缺键即允许」的兜底
 * 不会意外把权限送给测试用户。
 */
async function makeUserWithDomain(dnsAllowed: boolean): Promise<Fixture> {
  const user = await makeUser()
  await setPermissions(user.id, dnsAllowed ? WITH_DNS : WITHOUT_DNS)

  const domainId = uuid()
  const subdomainId = uuid()
  const now = new Date().toISOString()
  const fqdn = `${user.username}.doulor.cn`

  await env.DB.prepare(
    `INSERT INTO domains (id, user_id, name, zone_id, status, created_at)
     VALUES (?, ?, ?, 'test-zone', 'active', ?)`
  )
    .bind(domainId, user.id, fqdn, now)
    .run()

  await env.DB.prepare(
    `INSERT INTO subdomains (id, user_id, name, fqdn, status, created_at)
     VALUES (?, ?, '@', ?, 'active', ?)`
  )
    .bind(subdomainId, user.id, fqdn, now)
    .run()

  return { user, domainId, subdomainId, fqdn }
}

/** 再加一个子子域名（用来验证「上限跨子域名合计」） */
async function addChildSubdomain(fx: Fixture, name: string): Promise<string> {
  const id = uuid()
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO subdomains (id, user_id, name, fqdn, parent_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?)`
  )
    .bind(id, fx.user.id, name, `${name}.${fx.fqdn}`, fx.subdomainId, now)
    .run()
  return id
}

/** 直接往库里塞一条记录（比走接口快，且不受限流影响） */
async function seedRecord(
  fx: Fixture,
  opts: { subdomainId?: string | null; fqdn?: string; banned?: boolean } = {}
): Promise<void> {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO dns_records
       (id, domain_id, subdomain_id, cf_id, name, fqdn, type, content, ttl, proxied,
        status, banned_at, created_at, updated_at)
     VALUES (?, ?, ?, 'cf-x', '@', ?, 'A', '192.0.2.1', 1, 0, 'active', ?, ?, ?)`
  )
    .bind(
      uuid(),
      fx.domainId,
      opts.subdomainId === undefined ? fx.subdomainId : opts.subdomainId,
      opts.fqdn ?? fx.fqdn,
      opts.banned ? now : null,
      now,
      now
    )
    .run()
}

function createRecord(user: TestUser, subdomainId: string, name = "@"): Promise<Response> {
  return fetchSelf(
    authRequest(user, "/dns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subdomainId,
        name,
        type: "A",
        content: "192.0.2.10",
      }),
    })
  )
}

function listRecords(user: TestUser): Promise<Response> {
  return fetchSelf(authRequest(user, "/api/dns"))
}

interface ErrorBody {
  code: string
  /** 错误文案字段名是 `error`（见 index.ts 的统一错误处理），不是 message */
  error?: string
}

describe("DNS 权限闸", () => {
  it("没有 dns 权限 → 403 FEATURE_NOT_PERMITTED，且连 CF 都不去调", async () => {
    const fx = await makeUserWithDomain(false)
    stubCloudflare()

    const res = await createRecord(fx.user, fx.subdomainId)
    expect(res.status).toBe(403)
    const body = await res.json<ErrorBody>()
    expect(body.code).toBe("FEATURE_NOT_PERMITTED")
    // 权限排在业务之前：被挡住就不该产生任何外部副作用
    expect(cfCalls).toEqual([])
  })

  it("列表 / 修改 / 删除也一律过权限（读接口同样不能是后门）", async () => {
    const fx = await makeUserWithDomain(false)

    const list = await listRecords(fx.user)
    expect(list.status).toBe(403)
    expect((await list.json<ErrorBody>()).code).toBe("FEATURE_NOT_PERMITTED")

    // 故意用一个**不存在**的 id：403 必须出现在 404 之前，
    // 否则无权用户能靠错误码差异探测「某条记录存不存在」
    const put = await fetchSelf(
      authRequest(fx.user, "/dns/not-a-real-id", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "192.0.2.11" }),
      })
    )
    expect(put.status).toBe(403)
    expect((await put.json<ErrorBody>()).code).toBe("FEATURE_NOT_PERMITTED")

    const del = await fetchSelf(
      authRequest(fx.user, "/dns/not-a-real-id", { method: "DELETE" })
    )
    expect(del.status).toBe(403)
    expect((await del.json<ErrorBody>()).code).toBe("FEATURE_NOT_PERMITTED")
  })

  it("有 dns 权限 → 正常建记录（201）", async () => {
    const fx = await makeUserWithDomain(true)
    stubCloudflare()

    const res = await createRecord(fx.user, fx.subdomainId)
    expect(res.status).toBe(201)
    const out = (await res.json()) as { record: { fqdn: string; type: string } }
    expect(out.record.fqdn).toBe(fx.fqdn)
    expect(out.record.type).toBe("A")
  })

  it("管理员放行不依赖权限位：superadmin 的 dns=false 也照常建", async () => {
    // 钉的是「管理员放行发生在权限位之前」—— 线上权限 JSON 里管理员的 dns
    // 大概率就是 false（迁移不给他们写），若没这条豁免，站长自己反而用不了。
    const fx = await makeUserWithDomain(false)
    await env.DB.prepare("UPDATE users SET role = 'superadmin' WHERE id = ?")
      .bind(fx.user.id)
      .run()
    stubCloudflare()

    const res = await createRecord(fx.user, fx.subdomainId)
    expect(res.status).toBe(201)
  })
})

/**
 * 「租用用户」：**没有** dns 权限位，但有一份有效的根域租约。
 *
 * 🔴 2026-10-17 起持有 `dns` 权限位的用户**不再受每用户记录数上限约束**
 * （权限位 = 站长手动授权 = 信任，见 dns.ts 的 dnsRecordLimit）。因此要验「配额本身」，
 * 必须用「靠租约放行」的用户 —— 否则上限根本走不到，用例会变成空转。
 */
async function grantDnsRental(user: TestUser, root = "doulor.cn"): Promise<void> {
  const now = new Date().toISOString()
  const expires = new Date(Date.now() + 30 * 24 * 3600_000).toISOString()
  await env.DB.prepare(
    `INSERT INTO dns_rentals (id, user_id, root_domain, price_points, status, started_at, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 0, 'active', ?, ?, ?, ?)`
  )
    .bind(uuid(), user.id, root, now, expires, now, now)
    .run()
}

/** 没有权限位、靠有效租约放行的用户（每用户记录数上限对这类用户生效） */
async function makeRentedUserWithDomain(): Promise<Fixture> {
  const fx = await makeUserWithDomain(false)
  await grantDnsRental(fx.user)
  return fx
}

describe("每用户 DNS 记录数上限", () => {
  it("达到上限 → 400 DNS_RECORD_LIMIT，报错里带上限数字", async () => {
    const fx = await makeRentedUserWithDomain()
    await setSetting("dns_records_per_user", "2")
    await seedRecord(fx)
    await seedRecord(fx)
    stubCloudflare()

    const res = await createRecord(fx.user, fx.subdomainId)
    expect(res.status).toBe(400)
    const body = await res.json<ErrorBody>()
    expect(body.code).toBe("DNS_RECORD_LIMIT")
    // 文案要说清「上限是多少」，否则用户只知道失败、不知道找谁/怎么办
    expect(body.error).toContain("2")
    expect(body.error).toContain("上限")
    // 到顶就该在本地拒绝，不该去撞 CF 的 zone 级配额（那边报 81045，更难懂）
    expect(cfCalls).toEqual([])
  })

  it("未达上限 → 正常建（201）", async () => {
    const fx = await makeRentedUserWithDomain()
    await setSetting("dns_records_per_user", "2")
    await seedRecord(fx)
    stubCloudflare()

    expect((await createRecord(fx.user, fx.subdomainId)).status).toBe(201)
  })

  it("上限读的是设置项：改小立刻拦住、改大立刻放行", async () => {
    const fx = await makeRentedUserWithDomain()
    await seedRecord(fx)
    stubCloudflare()

    // 上限 1 + 已有 1 条 ⇒ 到顶
    await setSetting("dns_records_per_user", "1")
    const blocked = await createRecord(fx.user, fx.subdomainId)
    expect(blocked.status).toBe(400)
    expect((await blocked.json<ErrorBody>()).code).toBe("DNS_RECORD_LIMIT")

    // 同一个用户、同样 1 条记录，只把设置改成 3 ⇒ 应当放行。
    // 这条专门挡住「写死上限 / 只在启动时读一次设置」的实现。
    await setSetting("dns_records_per_user", "3")
    expect((await createRecord(fx.user, fx.subdomainId)).status).toBe(201)
  })

  it("上限跨子域名合计（另一个子域名下的记录也占额度）", async () => {
    const fx = await makeRentedUserWithDomain()
    const childId = await addChildSubdomain(fx, "blog")
    await setSetting("dns_records_per_user", "2")
    // 两条都挂在 '@' 下
    await seedRecord(fx)
    await seedRecord(fx)
    stubCloudflare()

    // 换到 blog.xxx 下建 —— 若计数只看当前子域名就会漏算，这里会错误地 201
    const res = await createRecord(fx.user, childId)
    expect(res.status).toBe(400)
    expect((await res.json<ErrorBody>()).code).toBe("DNS_RECORD_LIMIT")
  })

  it("别人的记录不算进我的额度（统计必须带用户条件）", async () => {
    const mine = await makeRentedUserWithDomain()
    const other = await makeRentedUserWithDomain()
    await setSetting("dns_records_per_user", "2")
    await seedRecord(other)
    await seedRecord(other)
    stubCloudflare()

    expect((await createRecord(mine.user, mine.subdomainId)).status).toBe(201)
  })

  it("被处置（banned_at 非空）的记录不占额度 —— 它们在 CF 上已经不存在了", async () => {
    const fx = await makeRentedUserWithDomain()
    await setSetting("dns_records_per_user", "2")
    await seedRecord(fx, { banned: true })
    await seedRecord(fx, { banned: true })
    stubCloudflare()

    // 若把封禁台账也算进来，被处置过的用户会凭空少掉额度、还找不到东西可删
    expect((await createRecord(fx.user, fx.subdomainId)).status).toBe(201)
  })

  it("管理员不受上限限制（上限设成 1、库里已有 3 条也照建）", async () => {
    const fx = await makeRentedUserWithDomain()
    await env.DB.prepare("UPDATE users SET role = 'root' WHERE id = ?")
      .bind(fx.user.id)
      .run()
    await setSetting("dns_records_per_user", "1")
    await seedRecord(fx)
    await seedRecord(fx)
    await seedRecord(fx)
    stubCloudflare()

    expect((await createRecord(fx.user, fx.subdomainId)).status).toBe(201)
  })
})

describe("GET /dns 下发的用量", () => {
  it("dnsUsage 给出跨域名的真实条数 + 设置项里的上限（租用用户；权限位持有者拿到的是 null）", async () => {
    const fx = await makeRentedUserWithDomain()
    const childId = await addChildSubdomain(fx, "blog")
    await setSetting("dns_records_per_user", "7")
    await seedRecord(fx)
    // 挂到另一个子域名下：用量必须是两条（前端按当前子域名的 records.length 数会数成 1）
    await seedRecord(fx, { subdomainId: childId, fqdn: `blog.${fx.fqdn}` })

    const res = await listRecords(fx.user)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      records: unknown[]
      dnsUsage: { used: number; limit: number | null }
    }
    expect(body.dnsUsage).toEqual({ used: 2, limit: 7 })
  })

  it("持有 dns 权限位 → limit=null（权限位 = 站长手动授权，不再叠记录数上限）", async () => {
    // 2026-10-17 站长明确要求：`dns` 权限位是他一个个手动点开的，那一下就等于信任，
    // 再叠一个「3 条上限」等于授权没生效。所以权限位持有者一律不限。
    const fx = await makeUserWithDomain(true)
    await setSetting("dns_records_per_user", "1")
    await seedRecord(fx)
    await seedRecord(fx)

    const listed = await listRecords(fx.user)
    const body = (await listed.json()) as { dnsUsage: { used: number; limit: number | null } }
    expect(body.dnsUsage.limit).toBeNull()
    expect(body.dnsUsage.used).toBe(2)

    // 真正的证据：上限设成 1、已有 2 条，仍然能建
    stubCloudflare()
    expect((await createRecord(fx.user, fx.subdomainId)).status).toBe(201)
  })

  it("显式 users.max_dns_records 覆盖优先于权限位豁免（收紧手段仍然有效）", async () => {
    // 权限位给的是「默认不限」，但管理员对某个具体账号显式设的数字优先级更高 ——
    // 否则「他在刷」时就没有任何收紧手段了。
    const fx = await makeUserWithDomain(true)
    await setSetting("dns_records_per_user", "99")
    await env.DB.prepare("UPDATE users SET max_dns_records = 2 WHERE id = ?").bind(fx.user.id).run()
    await seedRecord(fx)
    await seedRecord(fx)
    stubCloudflare()

    const res = await createRecord(fx.user, fx.subdomainId)
    expect(res.status).toBe(400)
    expect((await res.json<ErrorBody>()).code).toBe("DNS_RECORD_LIMIT")
  })

  it("管理员拿到 limit=null（表示不限，而不是一个假的上限数字）", async () => {
    const fx = await makeUserWithDomain(true)
    await env.DB.prepare("UPDATE users SET role = 'superadmin' WHERE id = ?")
      .bind(fx.user.id)
      .run()
    await setSetting("dns_records_per_user", "1")
    await seedRecord(fx)

    const res = await listRecords(fx.user)
    const body = (await res.json()) as { dnsUsage: { used: number; limit: number | null } }
    expect(body.dnsUsage.limit).toBeNull()
    expect(body.dnsUsage.used).toBe(1)
  })
})
