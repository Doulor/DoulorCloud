// 域名列表里的「N 条解析」计数。
//
// 为什么单独测：这个数字看着简单，但有两个容易做错的地方 ——
//   ① 只统计**直接挂的**记录，不含子子域名的（否则父子行数字会重复计算，
//      用户以为父行下面有 8 条，点进去只看到 5 条）；
//   ② 必须**只统计当前用户**的记录（dns_records 是全表，不加 JOIN 会串号）。
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, type TestUser } from "./helpers"
import { uuid } from "../src/crypto"

async function makeUserWithDomains(): Promise<{
  user: TestUser
  rootSubId: string
  childSubId: string
  rootFqdn: string
  childFqdn: string
  domainId: string
}> {
  const user = await makeUser()
  const domainId = uuid()
  const rootSubId = uuid()
  const childSubId = uuid()
  const now = new Date().toISOString()
  const rootFqdn = `${user.username}.doulor.cn`
  const childFqdn = `blog.${rootFqdn}`

  await env.DB.prepare(
    `INSERT INTO domains (id, user_id, name, zone_id, status, created_at)
     VALUES (?, ?, ?, 'test-zone', 'active', ?)`
  )
    .bind(domainId, user.id, rootFqdn, now)
    .run()

  await env.DB.prepare(
    `INSERT INTO subdomains (id, user_id, name, fqdn, status, created_at)
     VALUES (?, ?, '@', ?, 'active', ?)`
  )
    .bind(rootSubId, user.id, rootFqdn, now)
    .run()

  await env.DB.prepare(
    `INSERT INTO subdomains (id, user_id, name, fqdn, parent_id, status, created_at)
     VALUES (?, ?, 'blog', ?, ?, 'active', ?)`
  )
    .bind(childSubId, user.id, childFqdn, rootSubId, now)
    .run()

  return { user, rootSubId, childSubId, rootFqdn, childFqdn, domainId }
}

async function seedRecord(opts: {
  domainId: string
  subdomainId: string | null
  fqdn: string
  userId: string
}) {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO dns_records
       (id, domain_id, subdomain_id, cf_id, name, fqdn, type, content, ttl, proxied,
        priority, status, created_at, updated_at)
     VALUES (?, ?, ?, 'cf-x', '@', ?, 'A', '192.0.2.1', 1, 0, NULL, 'active', ?, ?)`
  )
    .bind(uuid(), opts.domainId, opts.subdomainId, opts.fqdn, now, now)
    .run()
}

async function listSubdomains(user: TestUser) {
  const res = await fetchSelf(authRequest(user, "/subdomains"))
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    subdomains: { id: string; fqdn: string; recordCount?: number }[]
  }
  return body.subdomains
}

describe("GET /subdomains —— 每个域名的解析条数", () => {
  it("各算各的：父行不含子子域名的记录", async () => {
    const { user, rootSubId, childSubId, rootFqdn, childFqdn, domainId } =
      await makeUserWithDomains()

    // 根域下 2 条，子子域名下 1 条
    await seedRecord({ domainId, subdomainId: rootSubId, fqdn: rootFqdn, userId: user.id })
    await seedRecord({ domainId, subdomainId: rootSubId, fqdn: rootFqdn, userId: user.id })
    await seedRecord({ domainId, subdomainId: childSubId, fqdn: childFqdn, userId: user.id })

    const subs = await listSubdomains(user)
    const root = subs.find((s) => s.id === rootSubId)
    const child = subs.find((s) => s.id === childSubId)

    // 关键：根域是 2 而不是 3 —— 子子域名的记录不算进父行
    expect(root?.recordCount).toBe(2)
    expect(child?.recordCount).toBe(1)
  })

  it("没有记录时是 0（不是 undefined）", async () => {
    const { user, rootSubId } = await makeUserWithDomains()
    const subs = await listSubdomains(user)
    expect(subs.find((s) => s.id === rootSubId)?.recordCount).toBe(0)
  })

  it("只统计自己的记录（别人的不串进来）", async () => {
    const mine = await makeUserWithDomains()
    const other = await makeUserWithDomains()

    await seedRecord({
      domainId: mine.domainId,
      subdomainId: mine.rootSubId,
      fqdn: mine.rootFqdn,
      userId: mine.user.id,
    })
    // 另一个用户的记录
    await seedRecord({
      domainId: other.domainId,
      subdomainId: other.rootSubId,
      fqdn: other.rootFqdn,
      userId: other.user.id,
    })

    const mineSubs = await listSubdomains(mine.user)
    expect(mineSubs.find((s) => s.id === mine.rootSubId)?.recordCount).toBe(1)

    const otherSubs = await listSubdomains(other.user)
    expect(otherSubs.find((s) => s.id === other.rootSubId)?.recordCount).toBe(1)
    // 另一个用户的子域名不出现在我的列表里
    expect(mineSubs.some((s) => s.id === other.rootSubId)).toBe(false)
  })

  it("subdomain_id 为 NULL 的历史记录不计入任何域名", async () => {
    const { user, rootSubId, domainId, rootFqdn } = await makeUserWithDomains()
    // 老数据可能没有 subdomain_id（0003 迁移前的记录）
    await seedRecord({ domainId, subdomainId: null, fqdn: rootFqdn, userId: user.id })
    await seedRecord({
      domainId,
      subdomainId: rootSubId,
      fqdn: rootFqdn,
      userId: user.id,
    })

    const subs = await listSubdomains(user)
    expect(subs.find((s) => s.id === rootSubId)?.recordCount).toBe(1)
  })
})
