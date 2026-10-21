/**
 * 记录名填 `@` = 直接挂在域名本身（2026-10-21）。
 *
 * ## 用户的诉求
 * 「用户不是有 xxx.tyu.me 的子域名吗？现在能加带前缀的解析，比如 blog → blog.xxx.tyu.me。
 *   我希望用户可以填 @ 来拥有 xxx.tyu.me 这样的解析。」
 *
 * ## 原来哪里不对
 * 服务端其实已经算了 `@`（`fqdn = name === "@" ? base : ...`），但：
 *   ① 两个入口自相矛盾 —— 前面 `if (!rawName) 400`，后面又留了 `name === ""` 的分支，
 *      等于「支持留空」这句话只写在没人走到的代码里；
 *   ② 前端预览死写 `(name || "@") + "." + base`，用户填 `@` 看到的是 `@.xxx.tyu.me`，
 *      看起来像要建一条坏记录 —— 没人敢这么用；
 *   ③ `@` 混在中间（`a@b`）没有任何拦截，会真建出一条永久解析不出来的记录。
 *
 * 现在统一到 `normalizeRecordName`：`@` / 全角 `＠` / 留空 / 末尾带点 全部等价于
 * 「挂在基准域名上」；`a@b` 明确 400。
 *
 * ⚠️ 最重要的一条是「别拼出 `@.base`」：CF 收到什么名字是唯一的事实依据，
 *    所以这里不只断言 fqdn，还断言**实际发给 Cloudflare 的 name**。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, setPermissions } from "./helpers"
import { uuid } from "../src/crypto"
import { resetRootDomainCache } from "../src/root-domains"

const CF = "https://api.cloudflare.com"

/** 每次写请求时 CF 收到的 name（唯一事实依据） */
let cfNames: string[] = []
let restores: Array<() => void> = []

function stubCloudflare(): void {
  const original = globalThis.fetch
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? "GET").toUpperCase()
    if (url.startsWith(CF) && method !== "GET") {
      try {
        const body = JSON.parse(String(init?.body ?? "{}")) as { name?: string }
        cfNames.push(String(body.name ?? ""))
      } catch {
        cfNames.push("(unparsed)")
      }
      return new Response(JSON.stringify({ success: true, result: { id: "cf-rec-1" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    return original(input as RequestInfo, init)
  }) as unknown as typeof fetch
  globalThis.fetch = stub
  restores.push(() => {
    globalThis.fetch = original
  })
}

async function seedRootDomains(): Promise<void> {
  const now = new Date().toISOString()
  const rows: [string, string][] = [
    ["tyu.me", "zone-tyu"],
    ["7u.nz", "zone-7u"],
  ]
  for (const [name, zone] of rows) {
    const exists = await env.DB.prepare("SELECT name FROM root_domains WHERE name = ?")
      .bind(name)
      .first()
    if (exists) continue
    await env.DB.prepare(
      `INSERT INTO root_domains
         (name, zone_id, label, requires_feature, dns_price_per_year, is_default, enabled, created_at)
       VALUES (?, ?, NULL, NULL, 0, 0, 1, ?)`
    )
      .bind(name, zone, now)
      .run()
  }
  resetRootDomainCache()
}

interface Fx {
  user: Parameters<typeof authRequest>[0]
  /** '@' 主域名，fqdn = <username>.tyu.me */
  apexSubId: string
  apexFqdn: string
  /** 普通子域名，fqdn = blog.<username>.7u.nz */
  blogSubId: string
  blogFqdn: string
}

async function fixture(): Promise<Fx> {
  const user = await makeUser()
  await setPermissions(
    user.id,
    JSON.stringify({ r2: false, ai: false, proxy: false, doulor: false, dns: true })
  )
  const now = new Date().toISOString()
  const apexFqdn = `${user.username}.tyu.me`
  const blogFqdn = `blog.${user.username}.7u.nz`
  const domainId = uuid()
  const apexSubId = uuid()
  const blogSubId = uuid()

  await env.DB.prepare(
    `INSERT INTO domains (id, user_id, name, zone_id, status, created_at)
     VALUES (?, ?, ?, 'zone-tyu', 'active', ?)`
  )
    .bind(domainId, user.id, apexFqdn, now)
    .run()

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO subdomains (id, user_id, name, fqdn, status, created_at)
       VALUES (?, ?, '@', ?, 'active', ?)`
    ).bind(apexSubId, user.id, apexFqdn, now),
    env.DB.prepare(
      `INSERT INTO subdomains (id, user_id, name, fqdn, status, created_at)
       VALUES (?, ?, 'blog', ?, 'active', ?)`
    ).bind(blogSubId, user.id, blogFqdn, now),
  ])

  return { user, apexSubId, apexFqdn, blogSubId, blogFqdn }
}

function create(
  fx: Fx,
  payload: Record<string, unknown>
): Promise<Response> {
  return fetchSelf(
    authRequest(fx.user, "/api/dns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "A", content: "192.0.2.1", ...payload }),
    })
  )
}

beforeEach(async () => {
  cfNames = []
  stubCloudflare()
  await seedRootDomains()
})

afterEach(() => {
  for (let i = restores.length - 1; i >= 0; i--) restores[i]()
  restores = []
  vi.restoreAllMocks()
})

describe("记录名填 @：落在域名本身", () => {
  it("填 @ → fqdn 就是 xxx.tyu.me，且发给 CF 的也是它（绝不出现 @. 前缀）", async () => {
    const fx = await fixture()
    const res = await create(fx, { name: "@", subdomainId: fx.apexSubId })
    expect(res.status).toBe(201)
    const { record } = await res.json<{ record: { name: string; fqdn: string } }>()
    expect(record.fqdn).toBe(fx.apexFqdn)
    expect(cfNames).toEqual([fx.apexFqdn])
  })

  it("全角 ＠ 等价于 @（中文输入法下很容易打出来）", async () => {
    const fx = await fixture()
    const res = await create(fx, { name: "＠", subdomainId: fx.apexSubId })
    expect(res.status).toBe(201)
    expect(cfNames).toEqual([fx.apexFqdn])
  })

  it("留空 等价于 @（原有 name==='' 分支现在真的走得到）", async () => {
    const fx = await fixture()
    const res = await create(fx, { name: "", subdomainId: fx.apexSubId })
    expect(res.status).toBe(201)
    expect(cfNames).toEqual([fx.apexFqdn])
  })

  it("末尾带点的 @. 也当 @（有些用户习惯写全限定名）", async () => {
    const fx = await fixture()
    const res = await create(fx, { name: "@.", subdomainId: fx.apexSubId })
    expect(res.status).toBe(201)
    expect(cfNames).toEqual([fx.apexFqdn])
  })

  it("不带 subdomainId 时同样落到主域名（默认目标就是 '@'）", async () => {
    const fx = await fixture()
    const res = await create(fx, { name: "@" })
    expect(res.status).toBe(201)
    expect(cfNames).toEqual([fx.apexFqdn])
  })
})

describe("记录名填 @：回归与新校验", () => {
  it("普通前缀仍然照旧：blog → blog.xxx.tyu.me", async () => {
    const fx = await fixture()
    const res = await create(fx, { name: "blog", subdomainId: fx.apexSubId })
    expect(res.status).toBe(201)
    expect(cfNames).toEqual([`blog.${fx.apexFqdn}`])
  })

  it("在二级子域名下填 @ → 落在该子域名本身（blog.xxx.7u.nz）", async () => {
    const fx = await fixture()
    const res = await create(fx, { name: "@", subdomainId: fx.blogSubId })
    expect(res.status).toBe(201)
    expect(cfNames).toEqual([fx.blogFqdn])
  })

  it("🔴 @ 混在中间（a@b）→ 400，绝不放行到 CF", async () => {
    const fx = await fixture()
    const res = await create(fx, { name: "a@b", subdomainId: fx.apexSubId })
    expect(res.status).toBe(400)
    const body = await res.json<{ code?: string }>()
    expect(body.code).toBe("INVALID_NAME")
    // 关键：一条 CF 记录都没建
    expect(cfNames).toEqual([])
  })

  it("改名：blog → @ 会把记录从 blog.xxx 挪到 xxx 本身", async () => {
    const fx = await fixture()
    const created = await create(fx, { name: "blog", subdomainId: fx.apexSubId })
    const { record } = await created.json<{ record: { id: string; fqdn: string } }>()
    expect(record.fqdn).toBe(`blog.${fx.apexFqdn}`)

    const res = await fetchSelf(
      authRequest(fx.user, `/api/dns/${record.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "@" }),
      })
    )
    expect(res.status).toBe(200)
    expect(cfNames).toEqual([`blog.${fx.apexFqdn}`, fx.apexFqdn])
  })
})
