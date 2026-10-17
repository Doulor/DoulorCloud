/**
 * 造物集管理台（`/api/admin/lab/gallery/*`）与「置顶优先」的回归测试（2026-10-17）。
 *
 * 站长要的是「管理员能像作者一样管任何作品」，而这正好是最容易开出越权洞的地方：
 * 同一组动作如果挂在用户侧 `/lab/projects/*` 上（那组按 `user_id` 校验归属），
 * 只要管理员旁路写错一次，任何登录用户就能改别人的作品、替别人绑域名、删别人的作品。
 *
 * 本文件钉住四条线：
 *   1. **普通用户调用这组接口一律 403**，且什么都不会被改（一个 CF 写请求都不发）；
 *      连「有 role=admin 但没有 lab 权限」的自定义管理员也要被挡（403 ADMIN_SCOPE_DENIED）。
 *   2. 管理员能改别人作品的名字 / 简介 / 图标 / 页面名 / 状态 / 域名 / 封面，
 *      且**改介绍信息不会顺手改可见性**（这条是审核流程的命门）。
 *   3. 管理员能删别人作品，且域名绑定行、Cloudflare Route、AAAA 记录、点赞明细
 *      全部清干净（少清域名那条会永久占 zone 的记录配额，就是 81045 事故的同款）。
 *   4. 置顶永远排在大厅最前，且 `?sort=views / likes / 各种脏值` 都改不了这件事。
 *
 * ⚠️ 出站全部打桩：非 api.cloudflare.com 的请求直接抛错 —— 打桩期间出现别的
 *    网络调用说明测试或代码写错了（与 lab-domain-binding.test.ts 同一套约定）。
 * ⚠️ 封面：测试环境没有 R2 绑定，`isStorageConfigured()` 恒为 false。所以「上传」
 *    这条只能钉到「鉴权通过、卡在存储配置（503 R2_NOT_CONFIGURED）」，
 *    「移除」则能完整验证（不依赖 R2 对象）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { env } from "cloudflare:workers"
import { resetRootDomainCache } from "../src/root-domains"
import { makeUser, authRequest, fetchSelf, type TestUser } from "./helpers"

const ROOT = "galadm.test"
const ZONE = "zone-galadm"

// ---------------------------------------------------------------------------
// Cloudflare API 打桩（只实现本接口会走到的 6 个端点）
// ---------------------------------------------------------------------------

interface DnsRec {
  id: string
  zone: string
  name: string
  type: string
  content: string
  proxied: boolean
}
interface RouteRec {
  id: string
  zone: string
  pattern: string
  script: string
}

let dns: DnsRec[]
let routes: RouteRec[]
/** 所有非 GET 的 CF 调用（用来断言「到底写了什么 / 有没有写」） */
let cfWrites: { method: string; path: string }[]
let seq: number

function cfJson(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: status < 400, result }), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function installCf() {
  dns = []
  routes = []
  cfWrites = []
  seq = 0

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url
    const url = new URL(raw)
    if (url.hostname !== "api.cloudflare.com") {
      throw new Error(`测试中出现预期外的出站请求：${raw}`)
    }
    const method = (init?.method ?? "GET").toUpperCase()
    const path = url.pathname.replace(/^\/client\/v4/, "")
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null
    if (method !== "GET") cfWrites.push({ method, path })

    const listDns = path.match(/^\/zones\/([^/]+)\/dns_records$/)
    if (listDns) {
      const zone = listDns[1]
      if (method === "GET") {
        const name = url.searchParams.get("name")
        return cfJson(dns.filter((r) => r.zone === zone && (!name || r.name === name)))
      }
      if (method === "POST") {
        const rec: DnsRec = {
          id: `dns-${++seq}`,
          zone,
          name: body.name,
          type: body.type,
          content: body.content,
          proxied: Boolean(body.proxied),
        }
        dns.push(rec)
        return cfJson({ id: rec.id })
      }
    }
    const oneDns = path.match(/^\/zones\/([^/]+)\/dns_records\/([^/]+)$/)
    if (oneDns && method === "DELETE") {
      dns = dns.filter((r) => !(r.zone === oneDns[1] && r.id === oneDns[2]))
      return cfJson({ id: oneDns[2] })
    }

    const listRoutes = path.match(/^\/zones\/([^/]+)\/workers\/routes$/)
    if (listRoutes) {
      const zone = listRoutes[1]
      if (method === "GET") {
        return cfJson(
          routes
            .filter((r) => r.zone === zone)
            .map(({ id, pattern, script }) => ({ id, pattern, script }))
        )
      }
      if (method === "POST") {
        const rec: RouteRec = {
          id: `route-${++seq}`,
          zone,
          pattern: body.pattern,
          script: body.script,
        }
        routes.push(rec)
        return cfJson({ id: rec.id })
      }
    }
    const oneRoute = path.match(/^\/zones\/([^/]+)\/workers\/routes\/([^/]+)$/)
    if (oneRoute && method === "DELETE") {
      routes = routes.filter((r) => !(r.zone === oneRoute[1] && r.id === oneRoute[2]))
      return cfJson({ id: oneRoute[2] })
    }

    return cfJson(null, 404)
  })
}

// ---------------------------------------------------------------------------
// 种子数据与请求助手
// ---------------------------------------------------------------------------

let nameSeq = 0

async function seedRoot() {
  await env.DB.prepare(
    `INSERT INTO root_domains
       (name, zone_id, label, requires_feature, dns_price_per_year, is_default, enabled, created_at)
     VALUES (?, ?, NULL, NULL, 0, 0, 1, ?)`
  )
    .bind(ROOT, ZONE, new Date().toISOString())
    .run()
  resetRootDomainCache()
}

/** 给用户登记一个子域名（`name='@'` 表示它是这个人的主域名） */
async function seedSubdomain(user: TestUser, fqdn: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO subdomains (id, user_id, name, fqdn, parent_id, status, created_at) VALUES (?, ?, '@', ?, NULL, 'active', ?)"
  )
    .bind(crypto.randomUUID(), user.id, fqdn, new Date().toISOString())
    .run()
}

/** 造一件作品（默认私有；带 index.html，公开时不会被 NO_HTML_ENTRY 拦） */
async function makeProject(
  user: TestUser,
  opts: {
    visibility?: string
    name?: string
    views?: number
    likes?: number
    pinnedAt?: string | null
    coverKey?: string | null
    reviewNote?: string | null
  } = {}
): Promise<string> {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const name = opts.name ?? `作品-${++nameSeq}-${id.slice(0, 6)}`
  await env.DB.prepare(
    `INSERT INTO lab_projects
       (id, user_id, name, slug, description, icon, files, storage, bucket_id,
        visibility, review_note, views, likes, pinned_at, cover_key,
        created_at, updated_at, published_at)
     VALUES (?, ?, ?, ?, '', '🌐', ?, 'd1', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      user.id,
      name,
      `p-${id.slice(0, 8)}`,
      JSON.stringify({ "index.html": "<h1>hi</h1>" }),
      opts.visibility ?? "private",
      opts.reviewNote ?? null,
      opts.views ?? 0,
      opts.likes ?? 0,
      opts.pinnedAt ?? null,
      opts.coverKey ?? null,
      now,
      now,
      (opts.visibility ?? "private") === "public" ? now : null
    )
    .run()
  return id
}

/** 作品行（直接读库，断言用） */
async function projectRow(id: string) {
  return env.DB.prepare(
    `SELECT id, user_id, name, description, icon, slug, slug_locked, visibility,
            review_note, published_at, cover_key, pinned_at
     FROM lab_projects WHERE id = ?`
  )
    .bind(id)
    .first<{
      id: string
      user_id: string
      name: string
      description: string
      icon: string
      slug: string
      slug_locked: number | null
      visibility: string
      review_note: string | null
      published_at: string | null
      cover_key: string | null
      pinned_at: string | null
    }>()
}

/** 管理端接口请求（`path` 是 `/admin/lab/gallery` 之后的部分） */
function adminReq(user: TestUser, path: string, init: RequestInit = {}): Request {
  return authRequest(user, `/api/admin/lab/gallery${path}`, init)
}

function jsonReq(user: TestUser, path: string, method: string, body?: unknown): Request {
  return adminReq(user, path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function countRows(sql: string, ...args: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql)
    .bind(...args)
    .first<{ c: number }>()
  return row?.c ?? 0
}

beforeEach(async () => {
  installCf()
  await env.DB.prepare("DELETE FROM root_domains").run()
  await seedRoot()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// 1. 权限边界（最重要）
// ---------------------------------------------------------------------------

describe("权限边界：普通用户不能借管理端接口动别人的作品", () => {
  it("八个动作全部 403，且作品一个字都没变、一个 CF 写请求都没发", async () => {
    const victim = await makeUser()
    const attacker = await makeUser()
    await seedSubdomain(victim, `victim.${ROOT}`)
    // 受害者：公开作品 + 已绑域名 + 有封面
    const project = await makeProject(victim, {
      visibility: "public",
      coverKey: `lab-cover/${victim.id}/${crypto.randomUUID()}.png`,
    })

    const before = await projectRow(project)
    const attempts: Request[] = [
      jsonReq(attacker, `/${project}/meta`, "POST", { name: "被改了" }),
      jsonReq(attacker, `/${project}/slug`, "POST", { slug: "stolen" }),
      jsonReq(attacker, `/${project}/visibility`, "POST", { visibility: "private" }),
      jsonReq(attacker, `/${project}/domain`, "PUT", { fqdn: `victim.${ROOT}` }),
      adminReq(attacker, `/${project}/domain`, { method: "DELETE" }),
      adminReq(attacker, `/${project}/cover`, { method: "POST" }),
      adminReq(attacker, `/${project}/cover`, { method: "DELETE" }),
      adminReq(attacker, `/${project}`, { method: "DELETE" }),
    ]

    for (const req of attempts) {
      const res = await fetchSelf(req)
      expect(res.status, `${req.method} ${new URL(req.url).pathname} 应当 403`).toBe(403)
      expect((await res.json<{ code: string }>()).code).toBe("FORBIDDEN")
    }

    // 库里的作品原样（名字 / slug / 可见性 / 封面 / 域名绑定都没被动）
    expect(await projectRow(project)).toEqual(before)
    expect(
      await countRows("SELECT COUNT(*) AS c FROM lab_project_domains WHERE project_id = ?", project)
    ).toBe(0)
    // 越权请求一个 CF 写操作都不该发出
    expect(cfWrites).toEqual([])
  })

  it("列表接口也是 403（否则能摸到别人的私有作品清单）", async () => {
    const attacker = await makeUser()
    const res = await fetchSelf(authRequest(attacker, "/api/admin/lab/gallery"))
    expect(res.status).toBe(403)
  })

  it("role=admin 但没有 lab 权限 → 403 ADMIN_SCOPE_DENIED", async () => {
    const owner = await makeUser()
    const project = await makeProject(owner)
    // 只给 users 权限的自定义管理员
    const limited = await makeUser({ role: "admin", adminScope: ["users"] })

    const res = await fetchSelf(
      jsonReq(limited, `/${project}/meta`, "POST", { name: "越权改名" })
    )
    expect(res.status).toBe(403)
    expect((await res.json<{ code: string }>()).code).toBe("ADMIN_SCOPE_DENIED")
    expect((await projectRow(project))?.name).not.toBe("越权改名")
  })

  it("用户侧接口仍然只认作者本人：改别人的作品 404（不泄露存在性）", async () => {
    const owner = await makeUser()
    const other = await makeUser()
    const project = await makeProject(owner)

    const res = await fetchSelf(
      authRequest(other, `/api/lab/projects/${project}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "抢改" }),
      })
    )
    expect(res.status).toBe(404)
    expect((await projectRow(project))?.name).not.toBe("抢改")
  })
})

// ---------------------------------------------------------------------------
// 2. 管理员改别人作品
// ---------------------------------------------------------------------------

describe("管理员能改别人的作品", () => {
  it("改名字 / 简介 / 图标：落库，且**可见性一点没动**（仍 pending）", async () => {
    const owner = await makeUser()
    const admin = await makeUser({ role: "admin" })
    const project = await makeProject(owner, { visibility: "pending" })

    const res = await fetchSelf(
      jsonReq(admin, `/${project}/meta`, "POST", {
        name: "站长改的名字",
        description: "站长补的简介",
        icon: "🚀",
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json<{ project: { name: string; visibility: string } }>()
    expect(body.project.name).toBe("站长改的名字")
    // 只改介绍信息 ⇒ 待审状态必须原样保留（改名顺手放行是事故）
    expect(body.project.visibility).toBe("pending")

    const row = await projectRow(project)
    expect(row?.description).toBe("站长补的简介")
    expect(row?.icon).toBe("🚀")
    expect(row?.visibility).toBe("pending")
  })

  it("改页面名：写入并锁定；撞上别人的公开作品 → 409", async () => {
    const owner = await makeUser()
    const admin = await makeUser({ role: "admin" })
    const project = await makeProject(owner, { visibility: "public" })

    const ok = await fetchSelf(jsonReq(admin, `/${project}/slug`, "POST", { slug: "new-name" }))
    expect(ok.status).toBe(200)
    expect((await ok.json<{ slug: string }>()).slug).toBe("new-name")
    const row = await projectRow(project)
    expect(row?.slug).toBe("new-name")
    expect(row?.slug_locked).toBe(1)

    // 另一个作者的公开作品占住了 "taken-name"
    const otherOwner = await makeUser()
    await makeProject(otherOwner, { visibility: "public", name: "占位" })
    await env.DB.prepare(
      "UPDATE lab_projects SET slug = 'taken-name', visibility = 'public' WHERE id = ?"
    )
      .bind(await makeProject(otherOwner, { visibility: "public" }))
      .run()

    const dup = await fetchSelf(jsonReq(admin, `/${project}/slug`, "POST", { slug: "taken-name" }))
    expect(dup.status).toBe(409)
    expect((await dup.json<{ code: string }>()).code).toBe("SLUG_TAKEN")
    // 撞名不该把原来的名字改坏
    expect((await projectRow(project))?.slug).toBe("new-name")
  })

  it("直接设状态：私有 → 公开（补 published_at）→ 驳回（写理由）→ 取消公开（理由清干净）", async () => {
    const owner = await makeUser()
    const admin = await makeUser({ role: "admin" })
    const project = await makeProject(owner, { visibility: "private" })

    const pub = await fetchSelf(
      jsonReq(admin, `/${project}/visibility`, "POST", { visibility: "public" })
    )
    expect(pub.status).toBe(200)
    let row = await projectRow(project)
    expect(row?.visibility).toBe("public")
    expect(row?.published_at).toBeTruthy()

    const rej = await fetchSelf(
      jsonReq(admin, `/${project}/visibility`, "POST", { visibility: "rejected", note: "页面里有外部跳转" })
    )
    expect(rej.status).toBe(200)
    row = await projectRow(project)
    expect(row?.visibility).toBe("rejected")
    expect(row?.review_note).toBe("页面里有外部跳转")

    // 取消公开 = 设成 private；驳回理由必须清掉，否则下次送审会先看到旧理由
    const back = await fetchSelf(
      jsonReq(admin, `/${project}/visibility`, "POST", { visibility: "private" })
    )
    expect(back.status).toBe(200)
    row = await projectRow(project)
    expect(row?.visibility).toBe("private")
    expect(row?.review_note).toBeNull()
  })

  it("没有 HTML 入口的作品不许被直接公开（与用户侧同一把尺子）", async () => {
    const owner = await makeUser()
    const admin = await makeUser({ role: "admin" })
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO lab_projects (id, user_id, name, slug, description, icon, files, storage,
        visibility, views, likes, created_at, updated_at)
       VALUES (?, ?, '无入口', ?, '', '🌐', ?, 'd1', 'private', 0, 0, ?, ?)`
    )
      .bind(id, owner.id, `p-${id.slice(0, 8)}`, JSON.stringify({ "a.txt": "x" }), now, now)
      .run()

    const res = await fetchSelf(
      jsonReq(admin, `/${id}/visibility`, "POST", { visibility: "public" })
    )
    expect(res.status).toBe(400)
    expect((await res.json<{ code: string }>()).code).toBe("NO_HTML_ENTRY")
    expect((await projectRow(id))?.visibility).toBe("private")
  })

  it("非法状态值 → 400 INVALID_STATUS", async () => {
    const owner = await makeUser()
    const admin = await makeUser({ role: "admin" })
    const project = await makeProject(owner)
    const res = await fetchSelf(
      jsonReq(admin, `/${project}/visibility`, "POST", { visibility: "deleted" })
    )
    expect(res.status).toBe(400)
    expect((await res.json<{ code: string }>()).code).toBe("INVALID_STATUS")
  })

  it("绑域名：按**作者**名下的子域放行，CF 侧建 AAAA + Route，绑定行记在作者名下", async () => {
    const owner = await makeUser()
    const admin = await makeUser({ role: "admin" })
    await seedSubdomain(owner, `mine.${ROOT}`)
    const project = await makeProject(owner, { visibility: "public" })

    const res = await fetchSelf(
      jsonReq(admin, `/${project}/domain`, "PUT", { fqdn: `blog.mine.${ROOT}` })
    )
    expect(res.status).toBe(200)
    expect((await res.json<{ fqdn: string }>()).fqdn).toBe(`blog.mine.${ROOT}`)

    // 绑定行记的是**作者**的 id（配额与归属都算在作者头上）
    const bound = await env.DB.prepare(
      "SELECT user_id, fqdn FROM lab_project_domains WHERE project_id = ?"
    )
      .bind(project)
      .first<{ user_id: string; fqdn: string }>()
    expect(bound).toEqual({ user_id: owner.id, fqdn: `blog.mine.${ROOT}` })

    // 真的落地了：AAAA 100:: + <fqdn>/* 路由
    expect(dns.filter((r) => r.name === `blog.mine.${ROOT}`)).toEqual([
      expect.objectContaining({ type: "AAAA", content: "100::" }),
    ])
    expect(routes.map((r) => r.pattern)).toContain(`blog.mine.${ROOT}/*`)
  })

  it("绑域名：管理员**不能**把作品挪到别人名下的子域（归属仍按作者判）", async () => {
    const owner = await makeUser()
    const victim = await makeUser()
    const admin = await makeUser({ role: "admin" })
    await seedSubdomain(owner, `mine2.${ROOT}`)
    await seedSubdomain(victim, `victim2.${ROOT}`)
    const project = await makeProject(owner, { visibility: "public" })

    const res = await fetchSelf(
      jsonReq(admin, `/${project}/domain`, "PUT", { fqdn: `blog.victim2.${ROOT}` })
    )
    expect(res.status).toBe(403)
    expect((await res.json<{ code: string }>()).code).toBe("FORBIDDEN")
    expect(cfWrites).toEqual([])
  })

  it("封面：管理员上传能过鉴权（卡在测试环境没有 R2 → 503），移除则真的清掉 cover_key", async () => {
    const owner = await makeUser()
    const admin = await makeUser({ role: "admin" })
    const project = await makeProject(owner, {
      visibility: "public",
      coverKey: `lab-cover/${owner.id}/${crypto.randomUUID()}.png`,
    })

    const up = await fetchSelf(
      adminReq(admin, `/${project}/cover`, {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: new Uint8Array([1, 2, 3]),
      })
    )
    // 鉴权已过 ⇒ 不是 403/404，而是「存储未配置」这条业务错误
    expect(up.status).toBe(503)
    expect((await up.json<{ code: string }>()).code).toBe("R2_NOT_CONFIGURED")

    const del = await fetchSelf(adminReq(admin, `/${project}/cover`, { method: "DELETE" }))
    expect(del.status).toBe(200)
    expect((await del.json<{ hasCover: boolean }>()).hasCover).toBe(false)
    expect((await projectRow(project))?.cover_key).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 3. 删除：清理要干净
// ---------------------------------------------------------------------------

describe("管理员删别人的作品：连域名资源与点赞明细一起清", () => {
  it("删除后：作品行、域名绑定行、CF Route、AAAA 记录、点赞明细全没了", async () => {
    const owner = await makeUser()
    const liker = await makeUser()
    const admin = await makeUser({ role: "admin" })
    await seedSubdomain(owner, `del.${ROOT}`)
    const project = await makeProject(owner, { visibility: "public" })

    // 先由作者自己绑上一个域名（走真实接口，确保 CF 侧真有 Route/AAAA）
    const bind = await fetchSelf(
      authRequest(owner, `/api/lab/projects/${project}/domain`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fqdn: `del.${ROOT}` }),
      })
    )
    expect(bind.status).toBe(200)
    expect(routes.map((r) => r.pattern)).toContain(`del.${ROOT}/*`)
    expect(dns.filter((r) => r.name === `del.${ROOT}`)).toHaveLength(1)

    // 一条点赞明细（删作品时要一起清，否则永远留在库里）
    await env.DB.prepare(
      "INSERT INTO lab_project_likes (project_id, user_id, created_at) VALUES (?, ?, ?)"
    )
      .bind(project, liker.id, new Date().toISOString())
      .run()

    const res = await fetchSelf(adminReq(admin, `/${project}`, { method: "DELETE" }))
    expect(res.status).toBe(204)

    expect(await projectRow(project)).toBeNull()
    expect(
      await countRows("SELECT COUNT(*) AS c FROM lab_project_domains WHERE project_id = ?", project)
    ).toBe(0)
    expect(await countRows("SELECT COUNT(*) AS c FROM lab_project_likes WHERE project_id = ?", project)).toBe(0)
    // CF 侧：Route 与 AAAA 都要释放（否则永久占 zone 配额）
    expect(routes.map((r) => r.pattern)).not.toContain(`del.${ROOT}/*`)
    expect(dns.filter((r) => r.name === `del.${ROOT}`)).toHaveLength(0)
  })

  it("删掉之后大厅列表里不再出现（按名字精确搜也搜不到）", async () => {
    const owner = await makeUser()
    const viewer = await makeUser()
    const admin = await makeUser({ role: "admin" })
    const name = `待删作品-${crypto.randomUUID().slice(0, 8)}`
    const project = await makeProject(owner, { visibility: "public", name })

    const before = await fetchSelf(
      authRequest(viewer, `/api/gallery?q=${encodeURIComponent(name)}`)
    )
    const beforeBody = await before.json<{ items: { id: string }[] }>()
    expect(beforeBody.items.map((i) => i.id)).toContain(project)

    expect((await fetchSelf(adminReq(admin, `/${project}`, { method: "DELETE" }))).status).toBe(204)

    const after = await fetchSelf(
      authRequest(viewer, `/api/gallery?q=${encodeURIComponent(name)}`)
    )
    const afterBody = await after.json<{ items: { id: string }[]; total: number }>()
    expect(afterBody.items.map((i) => i.id)).not.toContain(project)
    expect(afterBody.total).toBe(0)
  })

  it("作者自己删作品时也会清掉域名绑定（这是本次补上的旧缺口）", async () => {
    const owner = await makeUser()
    await seedSubdomain(owner, `own.${ROOT}`)
    const project = await makeProject(owner, { visibility: "public" })
    expect(
      (
        await fetchSelf(
          authRequest(owner, `/api/lab/projects/${project}/domain`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fqdn: `own.${ROOT}` }),
          })
        )
      ).status
    ).toBe(200)

    const res = await fetchSelf(
      authRequest(owner, `/api/lab/projects/${project}`, { method: "DELETE" })
    )
    expect(res.status).toBe(204)
    expect(
      await countRows("SELECT COUNT(*) AS c FROM lab_project_domains WHERE project_id = ?", project)
    ).toBe(0)
    expect(routes.map((r) => r.pattern)).not.toContain(`own.${ROOT}/*`)
    expect(dns.filter((r) => r.name === `own.${ROOT}`)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 4. 置顶：大厅里永远排最前，且不受 sort 影响
// ---------------------------------------------------------------------------

describe("置顶在大厅列表里永远排最前", () => {
  it("置顶作品排第一，?sort=latest / views / likes / 脏值 都改不掉", async () => {
    const viewer = await makeUser()
    const a = await makeUser()
    const b = await makeUser()
    const c = await makeUser()

    const pinned = await makeProject(a, {
      visibility: "public",
      name: "被置顶的",
      views: 1,
      likes: 1,
    })
    // 另外三件浏览/点赞都远高于它 —— 若排序没把置顶提上去，它们会占第一
    await makeProject(b, { visibility: "public", name: "很多人看", views: 9999, likes: 5000 })
    await makeProject(b, { visibility: "public", name: "很多人赞", views: 8888, likes: 9000 })
    await makeProject(c, { visibility: "public", name: "最新发布", views: 7777, likes: 7000 })

    // 管理员置顶（走真实接口）
    const admin = await makeUser({ role: "admin" })
    const pin = await fetchSelf(
      jsonReq(admin, "/pin", "POST", { projectId: pinned, pinned: true })
    )
    expect(pin.status).toBe(200)
    expect((await projectRow(pinned))?.pinned_at).toBeTruthy()

    for (const sort of ["latest", "views", "likes", "", "bogus"]) {
      const qs = sort ? `?sort=${sort}` : ""
      const res = await fetchSelf(authRequest(viewer, `/api/gallery${qs}`))
      expect(res.status).toBe(200)
      const body = await res.json<{ items: { id: string }[] }>()
      expect(body.items[0]?.id, `sort=${sort || "(默认)"} 时置顶作品仍该排第一`).toBe(pinned)
    }
  })

  it("多件置顶时按「后置顶的在前」；取消置顶后立刻回到普通排序", async () => {
    const viewer = await makeUser()
    const owner = await makeUser()
    const admin = await makeUser({ role: "admin" })
    // 用独立的名字前缀把查询范围收窄到这两件：同文件里别的用例也会置顶，
    // 不带 q 的话列表里还有它们（测试之间共享一个 D1，数据是累积的）。
    const marker = `多置-${crypto.randomUUID().slice(0, 8)}`
    const first = await makeProject(owner, { visibility: "public", name: `${marker}-先置顶` })
    const second = await makeProject(owner, { visibility: "public", name: `${marker}-后置顶` })

    // 直接写 pinned_at，避免依赖两次调用的时间先后（同一毫秒内会分不出先后）
    await env.DB.prepare("UPDATE lab_projects SET pinned_at = ? WHERE id = ?")
      .bind("2026-10-01T00:00:00.000Z", first)
      .run()
    await env.DB.prepare("UPDATE lab_projects SET pinned_at = ? WHERE id = ?")
      .bind("2026-10-02T00:00:00.000Z", second)
      .run()

    const query = `/api/gallery?sort=views&q=${encodeURIComponent(marker)}`
    let body = await (await fetchSelf(authRequest(viewer, query))).json<{
      items: { id: string }[]
    }>()
    expect(body.items.map((i) => i.id)).toEqual([second, first])

    // 取消其中一件的置顶 → 只剩另一件顶在最前面
    const unpin = await fetchSelf(
      jsonReq(admin, "/pin", "POST", { projectId: second, pinned: false })
    )
    expect(unpin.status).toBe(200)
    body = await (await fetchSelf(authRequest(viewer, query))).json<{
      items: { id: string }[]
    }>()
    expect(body.items[0].id).toBe(first)
    expect(body.items.map((i) => i.id)).toContain(second)
    expect((await projectRow(second))?.pinned_at).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 5. 列表接口：全部作品 + 搜索 + 筛选 + 分页
// ---------------------------------------------------------------------------

describe("GET /admin/lab/gallery", () => {
  it("能列出未公开的作品（大厅看不到的那些），并带回作者与置顶状态", async () => {
    const owner = await makeUser()
    const admin = await makeUser({ role: "admin" })
    const marker = `列表标记-${crypto.randomUUID().slice(0, 8)}`
    const priv = await makeProject(owner, { visibility: "private", name: `${marker}-私有` })
    const pend = await makeProject(owner, { visibility: "pending", name: `${marker}-待审` })

    const res = await fetchSelf(
      adminReq(admin, `?q=${encodeURIComponent(marker)}`)
    )
    expect(res.status).toBe(200)
    const body = await res.json<{
      total: number
      items: { id: string; visibility: string; authorUsername: string; pinnedAt: string | null }[]
      counts: { all: number; private: number; pending: number }
    }>()
    expect(body.total).toBe(2)
    const ids = body.items.map((i) => i.id)
    expect(ids).toContain(priv)
    expect(ids).toContain(pend)
    // 作者信息（管理台要显示「这是谁的作品」）
    expect(body.items[0].authorUsername).toBe(owner.username)
    expect(body.items.every((i) => i.pinnedAt === null)).toBe(true)
    // 计数是全局的（不受筛选影响），至少覆盖到刚造的两件
    expect(body.counts.all).toBeGreaterThanOrEqual(2)
    expect(body.counts.private).toBeGreaterThanOrEqual(1)
  })

  it("状态筛选与搜索都生效", async () => {
    const owner = await makeUser()
    const admin = await makeUser({ role: "admin" })
    const marker = `筛标-${crypto.randomUUID().slice(0, 8)}`
    await makeProject(owner, { visibility: "public", name: `${marker}-pub` })
    await makeProject(owner, { visibility: "private", name: `${marker}-priv` })

    const onlyPrivate = await (
      await fetchSelf(adminReq(admin, `?q=${encodeURIComponent(marker)}&status=private`))
    ).json<{ items: { name: string }[]; total: number }>()
    expect(onlyPrivate.total).toBe(1)
    expect(onlyPrivate.items[0].name).toBe(`${marker}-priv`)

    // 作者名也能搜到
    const byAuthor = await (
      await fetchSelf(adminReq(admin, `?q=${encodeURIComponent(owner.username)}`))
    ).json<{ total: number }>()
    expect(byAuthor.total).toBeGreaterThanOrEqual(2)
  })

  it("服务端分页：一页 30 条（不一次性拉全量）", async () => {
    const owner = await makeUser()
    const admin = await makeUser({ role: "admin" })
    const marker = `分页-${crypto.randomUUID().slice(0, 8)}`
    for (let i = 0; i < 31; i++) {
      await makeProject(owner, { visibility: "private", name: `${marker}-${i}` })
    }

    const page1 = await (
      await fetchSelf(adminReq(admin, `?q=${encodeURIComponent(marker)}&page=1`))
    ).json<{ total: number; pageSize: number; items: unknown[] }>()
    expect(page1.total).toBe(31)
    expect(page1.pageSize).toBe(30)
    expect(page1.items).toHaveLength(30)

    const page2 = await (
      await fetchSelf(adminReq(admin, `?q=${encodeURIComponent(marker)}&page=2`))
    ).json<{ items: unknown[] }>()
    expect(page2.items).toHaveLength(1)
  })

  it("`?pinned=1` 只回置顶的作品（置顶卡片用）", async () => {
    const owner = await makeUser()
    const admin = await makeUser({ role: "admin" })
    const marker = `置标-${crypto.randomUUID().slice(0, 8)}`
    const pinned = await makeProject(owner, {
      visibility: "public",
      name: `${marker}-已置顶`,
      pinnedAt: new Date().toISOString(),
    })
    await makeProject(owner, { visibility: "public", name: `${marker}-未置顶` })

    const body = await (
      await fetchSelf(adminReq(admin, `?pinned=1&q=${encodeURIComponent(marker)}`))
    ).json<{ items: { id: string }[]; total: number }>()
    expect(body.total).toBe(1)
    expect(body.items[0].id).toBe(pinned)
  })
})
