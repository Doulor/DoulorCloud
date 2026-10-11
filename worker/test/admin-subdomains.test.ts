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

/**
 * 转移后的绑定清理。
 *
 * 缺陷：删除分支会清掉子域名上的「名片 / 网盘直链」绑定（并拆掉 CF 的 Route 与
 * 占位解析），**转移分支却没有** —— 只改 `subdomains.user_id`。后果（2026-10-11
 * 探针全部实测复现）：
 *   · 新主的域名被动替原主服务：Host 分发按 `profiles.fqdn` / `storage_prefixes.fqdn`
 *     查内容，旧主的行还挂着 ⇒ B 的域名渲染 A 的名片、分发 A 的文件；
 *   · 原主随时可「解绑」拆掉新主的 CF 资源（Route + 占位解析）；
 *   · 新主想绑自己的名片 ⇒ 409（互斥检查命中旧主的遗留行），且无从解绑。
 *
 * 与删除分支的语义差异（PR 里请维护者确认口径）：转移按「解绑」处理 —— 绑定属于
 * 旧主，不跟着域名走到新主名下；`dns_records` 不动（记录属于子域名，随转移走）。
 */
describe("转移后的绑定清理（名片 / 网盘直链）", () => {
  // 覆盖文件级 stub：`detachCustomDomain` 只有在「Route pattern 精确等于 `${fqdn}/*`」
  // 时才会真删。文件级 stub 的 /workers/routes 返回对象形态，`find()` 抛错被吞，
  // **删除路径根本不会执行** —— 探针阶段踩过这个假绿（CF DELETE = 0 像是没缺陷）。
  let cfDeletes: string[] = []
  let cfRouteCreates = 0
  let routeFqdn: string | null = null
  let placeholderFqdn: string | null = null

  beforeEach(() => {
    cfDeletes = []
    cfRouteCreates = 0
    routeFqdn = null
    placeholderFqdn = null
    const outer = globalThis.fetch
    const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const method = (init?.method ?? "GET").toUpperCase()
      if (!url.startsWith(CF)) return outer!(input as RequestInfo, init)
      if (method === "DELETE") cfDeletes.push(url)
      if (method === "POST" && url.includes("/workers/routes")) cfRouteCreates += 1
      if (method === "GET" && url.includes("/workers/routes")) {
        const result = routeFqdn ? [{ id: "route-1", pattern: `${routeFqdn}/*` }] : []
        return jsonResponse({ success: true, result, result_info: {} })
      }
      if (method === "GET" && url.includes("/dns_records")) {
        const result = placeholderFqdn
          ? [{ id: "dns-ph-1", type: "AAAA", name: placeholderFqdn, content: "100::" }]
          : []
        return jsonResponse({ success: true, result, result_info: {} })
      }
      return jsonResponse({ success: true, result: { id: "cf-test-1" }, result_info: {} })
    }) as unknown as typeof fetch
    globalThis.fetch = stub
  })

  /** 名片行（slug 用用户名保证唯一）；binding 非空 = 已绑定到该子域名 */
  async function seedProfileRow(
    user: U,
    binding: { subId: string; fqdn: string } | null,
    bio?: string
  ): Promise<void> {
    const now = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO profiles (user_id, slug, published, display_name, bio, subdomain_id, fqdn, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`
    ).bind(
      user.id,
      user.username,
      `名片-${user.username}`,
      bio ?? null,
      binding?.subId ?? null,
      binding?.fqdn ?? null,
      now,
      now
    ).run()
  }

  async function seedStorageBinding(user: U, subId: string, fqdn: string): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO storage_prefixes (id, user_id, subdomain_id, fqdn, r2_prefix, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), user.id, subId, fqdn, "blog", new Date().toISOString()).run()
  }

  function transfer(admin: U, id: string, to: U) {
    return fetchSelf(
      authRequest(admin, `/api/admin/subdomains/${id}`, jsonInit({ userId: to.id }, "PUT"))
    )
  }

  it("转移后，新主的域名不再对外渲染原主的名片 / 分发原主的直链", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const from = await makeUser({})
    const to = await makeUser({})
    const blogId = await seedSubdomain(from, "tblog1")
    await ensureDomainRow("tblog1.tyu.me", from.id)
    const marker = `原主签名-${crypto.randomUUID().slice(0, 8)}`
    await seedProfileRow(from, { subId: blogId, fqdn: "tblog1.tyu.me" }, marker)
    await seedStorageBinding(from, blogId, "tblog1.tyu.me")

    expect((await transfer(admin, blogId, to)).status).toBe(200)

    // 绑定行被清：名片行保留（fqdn/subdomain_id 置空，旧主可绑到别的子域名）；直链行删除
    const p = await env.DB.prepare(
      "SELECT fqdn, subdomain_id, published FROM profiles WHERE user_id = ?"
    )
      .bind(from.id)
      .first<{ fqdn: string | null; subdomain_id: string | null; published: number }>()
    expect(p!.fqdn).toBeNull()
    expect(p!.subdomain_id).toBeNull()
    expect(p!.published).toBe(1)
    const sp = await env.DB.prepare("SELECT COUNT(*) AS c FROM storage_prefixes WHERE fqdn = ?")
      .bind("tblog1.tyu.me")
      .first<{ c: number }>()
    expect(sp!.c).toBe(0)

    // 用户可见后果：以「已归新主」的域名为 Host 请求，不再渲染原主的名片
    const host = await fetchSelf(new Request("https://tblog1.tyu.me/"))
    const html = await host.text()
    expect(html.includes(marker)).toBe(false)
  })

  it("转移后，原主解绑名片不再拆新主的 CF 资源（清理在转移时已完成）", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const from = await makeUser({})
    const to = await makeUser({})
    const blogId = await seedSubdomain(from, "tblog2")
    await ensureDomainRow("tblog2.tyu.me", from.id)
    await seedProfileRow(from, { subId: blogId, fqdn: "tblog2.tyu.me" })

    // CF 上「存在」该 fqdn 的 Route 与占位解析（否则 detach 找不到目标，路径不会执行）
    routeFqdn = "tblog2.tyu.me"
    placeholderFqdn = "tblog2.tyu.me"

    await transfer(admin, blogId, to)
    const afterTransfer = cfDeletes.length
    // 清理应该在转移时就拆掉 Route + 占位（这就是本修复的行为）
    expect(afterTransfer).toBe(2)

    // 原主解绑自己的名片 —— 此时他的 profiles.fqdn 已空，不应再碰 CF
    const unbind = await fetchSelf(
      authRequest(from, "/api/profile/domain", jsonInit({ action: "unbind" }, "POST"))
    )
    expect(unbind.status).toBe(200)
    expect(cfDeletes.length).toBe(afterTransfer)
  })

  it("转移后，新主可以把自己的名片绑上来（不再被旧主的遗留行挡住）", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const from = await makeUser({})
    const to = await makeUser({})
    const blogId = await seedSubdomain(from, "tblog3")
    await ensureDomainRow("tblog3.tyu.me", from.id)
    await seedProfileRow(from, { subId: blogId, fqdn: "tblog3.tyu.me" })
    await seedProfileRow(to, null)

    await transfer(admin, blogId, to)

    const bind = await fetchSelf(
      authRequest(to, "/api/profile/domain", jsonInit({ subdomainId: blogId }, "POST"))
    )
    expect(bind.status).toBe(201)
    const p = await env.DB.prepare("SELECT fqdn, subdomain_id FROM profiles WHERE user_id = ?")
      .bind(to.id)
      .first<{ fqdn: string | null; subdomain_id: string | null }>()
    expect(p!.fqdn).toBe("tblog3.tyu.me")
    expect(p!.subdomain_id).toBe(blogId)
    // CF 侧 Route 真的重建了（新主的绑定是完整生效的，不只是 DB 改行）
    expect(cfRouteCreates).toBeGreaterThan(0)
  })

  it("正向守护：转移只清被转移子树的绑定，原主其他子域名的绑定不受影响", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const from = await makeUser({})
    const to = await makeUser({})
    const blogId = await seedSubdomain(from, "tblog4")
    const keepId = await seedSubdomain(from, "tkeep4")
    await ensureDomainRow("tblog4.tyu.me", from.id)
    await ensureDomainRow("tkeep4.tyu.me", from.id)
    // 名片绑在 keepme（不转移）；网盘直链绑在 blog（转移）
    await seedProfileRow(from, { subId: keepId, fqdn: "keepme.tyu.me" })
    await seedStorageBinding(from, blogId, "tblog4.tyu.me")

    expect((await transfer(admin, blogId, to)).status).toBe(200)

    // 名片绑定原样保留（只清被转移子树的绑定，不能一把梭清空旧主全部绑定）
    const p = await env.DB.prepare("SELECT fqdn, subdomain_id FROM profiles WHERE user_id = ?")
      .bind(from.id)
      .first<{ fqdn: string | null; subdomain_id: string | null }>()
    expect(p!.fqdn).toBe("keepme.tyu.me")
    expect(p!.subdomain_id).toBe(keepId)
    // 被转移子域名的直链行仍应被清
    const sp = await env.DB.prepare("SELECT COUNT(*) AS c FROM storage_prefixes WHERE fqdn = ?")
      .bind("tblog4.tyu.me")
      .first<{ c: number }>()
    expect(sp!.c).toBe(0)
  })

  it("转移 + 改名同请求：清掉的绑定不会被改名的 fqdn 重写捡回来", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const from = await makeUser({})
    const to = await makeUser({})
    const blogId = await seedSubdomain(from, "tblog5")
    await ensureDomainRow("tblog5.tyu.me", from.id)
    await seedProfileRow(from, { subId: blogId, fqdn: "tblog5.tyu.me" })

    const res = await fetchSelf(
      authRequest(admin, `/api/admin/subdomains/${blogId}`, jsonInit({ name: "blog2", userId: to.id }, "PUT"))
    )
    expect(res.status).toBe(200)

    // 改名分支会按 subdomain_id 重写绑定行的 fqdn —— 但行已在转移时清掉，
    // 不能被「捡回来」挂到新名字上
    const p = await env.DB.prepare("SELECT fqdn, subdomain_id FROM profiles WHERE user_id = ?")
      .bind(from.id)
      .first<{ fqdn: string | null; subdomain_id: string | null }>()
    expect(p!.fqdn).toBeNull()
    expect(p!.subdomain_id).toBeNull()
  })
})
