/**
 * 管理面板 → 子域名管理（2026-10-07 新增，与 DNS 解析合并为「子域名」板块）。
 *
 * 验证几件事：
 *   1. 列表接口能跨用户看到全部域名，带归属用户名
 *   2. 代建：给指定用户建一级子域名（绕过配额），保留名被拒、重名被拒
 *   3. 建子子域名时归属跟随父级（显式传别的 owner 会被拒）
 *   4. 改名：fqdn 连同子树一起换；转移：整棵子树换 owner
 *   5. 删除：级联删掉下级；主域名（'@'）不可删
 *   6. 归属用户联想搜索按用户名命中
 */
import { describe, expect, it, afterEach, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser } from "./helpers"

type U = Awaited<ReturnType<typeof makeUser>>

const CF = "https://api.cloudflare.com"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

let restoreFetch: (() => void) | null = null

/**
 * 打桩 Cloudflare API：DNS 查询一律返回空（无冲突），写操作一律成功。
 *
 * 为什么必须：创建接口会调 `cfListDnsRecords` 做「平台外冲突」检测，
 * 测试环境里那把 CF token 是假的，不拦就会拿到 502。
 */
beforeEach(() => {
  const original = globalThis.fetch
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? "GET").toUpperCase()
    if (!url.startsWith(CF)) return original(input as RequestInfo, init)
    if (method === "GET" && url.includes("/dns_records")) {
      return jsonResponse({ success: true, result: [] })
    }
    return jsonResponse({ success: true, result: { id: "cf-test-1" } })
  }) as unknown as typeof fetch
  globalThis.fetch = stub
  restoreFetch = () => {
    globalThis.fetch = original
  }
})

afterEach(() => {
  restoreFetch?.()
  restoreFetch = null
})

function jsonInit(body: unknown, method = "POST"): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }
}

/**
 * 给某个 fqdn 登记一条 domains 行（zone_id 写死测试值）。
 *
 * 为什么必须：创建接口会调 `zoneIdForFqdn` 做「平台外冲突」检测，
 * 测试环境里根域没有真实 CF zone，只有 domains 表里有行时才解析得出 zone。
 */
async function ensureDomainRow(fqdn: string, userId: string): Promise<void> {
  const exists = await env.DB.prepare("SELECT id FROM domains WHERE name = ?")
    .bind(fqdn)
    .first()
  if (!exists) {
    await env.DB.prepare(
      "INSERT INTO domains (id, user_id, name, zone_id, status, created_at) VALUES (?, ?, ?, 'test-zone', 'active', ?)"
    )
      .bind(crypto.randomUUID(), userId, fqdn, new Date().toISOString())
      .run()
  }
}

/** 直接用 SQL 建一个一级子域名（测试专用；parentId 非空时建子子域名） */
async function seedSubdomain(user: U, name: string, parentId: string | null = null): Promise<string> {
  const id = crypto.randomUUID()
  let fqdn = `${name}.tyu.me`
  if (parentId) {
    const parent = await env.DB.prepare("SELECT fqdn FROM subdomains WHERE id = ?")
      .bind(parentId)
      .first<{ fqdn: string }>()
    fqdn = `${name}.${parent!.fqdn}`
  }
  await env.DB.prepare(
    "INSERT INTO subdomains (id, user_id, name, fqdn, parent_id, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)"
  )
    .bind(id, user.id, name, fqdn, parentId, new Date().toISOString())
    .run()
  return id
}

describe("管理面板：子域名管理", () => {
  it("列表跨用户可见，且带归属用户名", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const user = await makeUser({})
    await seedSubdomain(user, "listdemo")

    const res = await fetchSelf(authRequest(admin, "/api/admin/subdomains?q=listdemo"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      subdomains: { fqdn: string; owner: { username: string } }[]
      total: number
    }
    expect(body.total).toBeGreaterThanOrEqual(1)
    const hit = body.subdomains.find((s) => s.fqdn === "listdemo.tyu.me")
    expect(hit).toBeTruthy()
    expect(hit!.owner.username).toBe(user.username)
  })

  it("代建一级子域名：绕过配额；保留名与重名被拒", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const user = await makeUser({})
    // 目标 fqdn 先登记 domains 行，zone 才能解析出来（否则 502）。
    // 测试环境的默认根域是 doulor.cn（wrangler.toml 的 ROOT_DOMAIN）。
    await ensureDomainRow("admindemo.doulor.cn", user.id)

    const ok = await fetchSelf(
      authRequest(admin, "/api/admin/subdomains", jsonInit({ userId: user.id, name: "admindemo" }))
    )
    expect(ok.status).toBe(201)
    const created = (await ok.json()) as { subdomain: { fqdn: string; owner: { id: string } } }
    expect(created.subdomain.fqdn).toBe("admindemo.doulor.cn")
    expect(created.subdomain.owner.id).toBe(user.id)

    // 重名
    const dup = await fetchSelf(
      authRequest(admin, "/api/admin/subdomains", jsonInit({ userId: user.id, name: "admindemo" }))
    )
    expect(dup.status).toBe(409)

    // 系统保留名（mail/api/www…）
    const reserved = await fetchSelf(
      authRequest(admin, "/api/admin/subdomains", jsonInit({ userId: user.id, name: "mail" }))
    )
    expect(reserved.status).toBe(400)
  })

  it("建子子域名：归属跟随父级，显式传别的 owner 被拒", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const owner = await makeUser({})
    const stranger = await makeUser({})
    const parentId = await seedSubdomain(owner, "parentdemo")
    await ensureDomainRow("childy.parentdemo.tyu.me", owner.id)

    // 传 stranger 的 id 应该被拒（父级属于 owner）
    const mismatch = await fetchSelf(
      authRequest(
        admin,
        "/api/admin/subdomains",
        jsonInit({ userId: stranger.id, name: "childx", parentId })
      )
    )
    expect(mismatch.status).toBe(400)

    // 不传 owner：跟随父级
    const ok = await fetchSelf(
      authRequest(admin, "/api/admin/subdomains", jsonInit({ name: "childy", parentId }))
    )
    expect(ok.status).toBe(201)
    const body = (await ok.json()) as { subdomain: { fqdn: string; owner: { id: string } } }
    expect(body.subdomain.fqdn).toBe("childy.parentdemo.tyu.me")
    expect(body.subdomain.owner.id).toBe(owner.id)
  })

  it("改名：fqdn 连同子树一起换", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const user = await makeUser({})
    const id = await seedSubdomain(user, "oldname")
    const childId = await seedSubdomain(user, "kid", id)

    const res = await fetchSelf(
      authRequest(admin, `/api/admin/subdomains/${id}`, jsonInit({ name: "newname" }, "PUT"))
    )
    expect(res.status).toBe(200)

    const self = await env.DB.prepare("SELECT name, fqdn FROM subdomains WHERE id = ?")
      .bind(id)
      .first<{ name: string; fqdn: string }>()
    expect(self).toMatchObject({ name: "newname", fqdn: "newname.tyu.me" })
    const child = await env.DB.prepare("SELECT fqdn FROM subdomains WHERE id = ?")
      .bind(childId)
      .first<{ fqdn: string }>()
    expect(child!.fqdn).toBe("kid.newname.tyu.me")

    // 同名应被拒
    const same = await fetchSelf(
      authRequest(admin, `/api/admin/subdomains/${id}`, jsonInit({ name: "newname" }, "PUT"))
    )
    expect(same.status).toBe(400)
  })

  it("转移：整棵子树换 owner", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const from = await makeUser({})
    const to = await makeUser({})
    const id = await seedSubdomain(from, "transferdemo")
    const childId = await seedSubdomain(from, "tkid", id)

    const res = await fetchSelf(
      authRequest(admin, `/api/admin/subdomains/${id}`, jsonInit({ userId: to.id }, "PUT"))
    )
    expect(res.status).toBe(200)
    // 响应用新归属（前端 update() 的返回类型就要求带 owner）
    const body = (await res.json()) as { subdomain: { owner: { id: string } } }
    expect(body.subdomain.owner.id).toBe(to.id)

    const self = await env.DB.prepare("SELECT user_id FROM subdomains WHERE id = ?")
      .bind(id)
      .first<{ user_id: string }>()
    const child = await env.DB.prepare("SELECT user_id FROM subdomains WHERE id = ?")
      .bind(childId)
      .first<{ user_id: string }>()
    expect(self!.user_id).toBe(to.id)
    expect(child!.user_id).toBe(to.id)
  })

  it("删除：级联删下级；主域名不可删", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const user = await makeUser({})
    const id = await seedSubdomain(user, "deldemo")
    await seedSubdomain(user, "delkid", id)

    const res = await fetchSelf(
      authRequest(admin, `/api/admin/subdomains/${id}`, { method: "DELETE" })
    )
    expect(res.status).toBe(204)

    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM subdomains WHERE user_id = ? AND fqdn LIKE 'del%'"
    )
      .bind(user.id)
      .first<{ c: number }>()
    expect(left!.c).toBe(0)

    // 主域名（注册分配的 'xxx.tyu.me'，name='@'）不可删
    const primaryId = await seedSubdomain(user, "@")
    const primary = await fetchSelf(
      authRequest(admin, `/api/admin/subdomains/${primaryId}`, { method: "DELETE" })
    )
    expect(primary.status).toBe(400)
  })

  it("归属用户联想搜索：按用户名命中", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const user = await makeUser({})

    const res = await fetchSelf(
      authRequest(admin, `/api/admin/subdomains/owners?q=${encodeURIComponent(user.username)}`)
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { owners: { id: string }[] }
    expect(body.owners.some((o) => o.id === user.id)).toBe(true)
  })
})
