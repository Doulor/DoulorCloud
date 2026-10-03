// DNS 列表：把「平台自动创建的解析」派生出来展示。
//
// 背景（2026-10-01 反馈：「个人名片界面绑定域名不会在前面的 dns 记录那里显现」）：
//   个人名片 / 网盘直链绑定自定义域名时，后端会在 Cloudflare 建一条 AAAA 100:: 占位，
//   但**不落 dns_records**。于是用户在 DNS 页里看不到自己名片的域名，
//   也看不懂那个域名为什么解析得通。
//
// 这里锁住两件事：
//   1. 绑定关系能被派生进列表，且带 managed 标记（前端据此隐藏删除按钮）
//   2. 用户自己已经有同 fqdn 的真实记录时，以他自己那条为准，不重复展示
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, type TestUser } from "./helpers"

const listDns = (u: TestUser) => authRequest(u, "/api/dns")

interface Seed {
  domainId: string
  subId: string
  fqdn: string
}

/** 建一个根域名 + 一个子域名（DNS 页要 domains 行才认这个用户有域名） */
async function seedDomain(u: TestUser, root: string, sub: string, domainId?: string): Promise<Seed> {
  // domains.name 是 UNIQUE，同一个用户下要建第二个子域名时必须复用同一个域名行
  const dId = domainId ?? crypto.randomUUID()
  const subId = crypto.randomUUID()
  const now = new Date().toISOString()
  const fqdn = `${sub}.${root}`
  if (!domainId) {
    await env.DB.prepare(
      "INSERT INTO domains (id, user_id, name, zone_id, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)"
    ).bind(dId, u.id, root, "test-zone", now).run()
  }
  await env.DB.prepare(
    "INSERT INTO subdomains (id, user_id, name, fqdn, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)"
  ).bind(subId, u.id, sub, fqdn, now).run()
  return { domainId: dId, subId, fqdn }
}

/** 模拟「网盘直链绑定域名」留下的那条记录 */
async function bindStorage(u: TestUser, s: Seed) {
  await env.DB.prepare(
    `INSERT INTO storage_prefixes (id, user_id, subdomain_id, fqdn, r2_prefix, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(crypto.randomUUID(), u.id, s.subId, s.fqdn, `dl/${u.username}/`, new Date().toISOString()).run()
}

/** 模拟用户自己建的一条 DNS 记录 */
async function createOwnRecord(u: TestUser, s: Seed, type: string, content: string) {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO dns_records
       (id, domain_id, subdomain_id, cf_id, name, fqdn, type, content, ttl, proxied, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'active', ?, ?)`
  )
    .bind(crypto.randomUUID(), s.domainId, s.subId, null, "sub", s.fqdn, type, content, now, now)
    .run()
}

interface DnsItem {
  id: string
  name: string
  fqdn: string
  type: string
  content: string
  managed?: boolean
  managedBy?: string | null
}

async function recordsOf(u: TestUser): Promise<DnsItem[]> {
  const res = await fetchSelf(listDns(u))
  expect(res.status).toBe(200)
  return ((await res.json()) as { records: DnsItem[] }).records
}

describe("DNS 列表 —— 平台托管的解析", () => {
  it("绑定自定义域名后，解析会出现在列表里并带 managed 标记", async () => {
    const u = await makeUser()
    const s = await seedDomain(u, `root-${u.username}.doulor.cn`, "pan")
    await bindStorage(u, s)

    const records = await recordsOf(u)
    const item = records.find((r) => r.fqdn === s.fqdn)
    expect(item).toBeTruthy()
    expect(item!.managed).toBe(true)
    expect(item!.managedBy).toBe("storage")
    expect(item!.type).toBe("AAAA")
    expect(item!.content).toBe("100::")
    // name 是相对根域名的前缀，列表里才不会显示成完整域名
    expect(item!.name).toBe("pan")
  })

  it("用户自己已有同 fqdn 的真实记录时，以他自己的那条为准，不重复", async () => {
    const u = await makeUser()
    const s = await seedDomain(u, `root-${u.username}.doulor.cn`, "blog")
    await bindStorage(u, s)
    await createOwnRecord(u, s, "TXT", "hello")

    const records = await recordsOf(u)
    const same = records.filter((r) => r.fqdn === s.fqdn)
    expect(same).toHaveLength(1)
    expect(same[0].managed).toBeFalsy()
    expect(same[0].content).toBe("hello")
  })

  it("没有绑定关系时不凭空造记录", async () => {
    const u = await makeUser()
    await seedDomain(u, `root-${u.username}.doulor.cn`, "plain")
    expect(await recordsOf(u)).toHaveLength(0)
  })

  it("按子域名筛选时，派生项只在它自己的子域名下出现", async () => {
    const u = await makeUser()
    const root = `root-${u.username}.doulor.cn`
    const bound = await seedDomain(u, root, "pan")
    const other = await seedDomain(u, root, "other", bound.domainId)
    await bindStorage(u, bound)

    const res = await fetchSelf(authRequest(u, `/api/dns?subdomainId=${other.subId}`))
    const body = (await res.json()) as { records: DnsItem[] }
    expect(body.records.some((r) => r.fqdn === bound.fqdn)).toBe(false)
  })
})
