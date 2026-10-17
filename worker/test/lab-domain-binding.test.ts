/**
 * lab 作品绑定域名：**归属校验** + **数量上限原子化**（2026-10-16 渗透测试 finding#9 / #29）
 *
 * 这两个洞在同一个函数里（`handlers/lab-domains.ts` 的 `setProjectDomain`），
 * 一起修、一起钉：
 *
 *   #9 跨用户子域劫持 / Content Spoofing：
 *      原先只校验「根域已登记 + 不是保留名 + 有根域权益 + 表内唯一 +
 *      目标主机名没有现成解析」，**从没问过这个 fqdn 是不是你的**。
 *      线上真实数据已证实被利用过：`teest` 把作品绑到了 `idortest01.tyu.me`
 *      （该 host 的 subdomains 行属于 `idortest01`）。
 *      现在补上 `assertFqdnOwned`（与 dns.ts 写记录**同一把尺子**）。
 *
 *   #29 `MAX_DOMAINS_PER_USER=5` 并发击穿：
 *      原先 `SELECT COUNT(*)` → 判 `>= 5` → 打两次 CF API → `DELETE`+`INSERT`，
 *      判定与写入之间隔着远程调用，无事务无守卫。线上现场：账号 `idortest01`
 *      名下 8 条 `race-N-probe.tyu.me`（上限 5）。
 *      现在把守卫塞进单条 INSERT 的 WHERE，并与「删旧行」放进同一个 `DB.batch`
 *      事务，`meta.changes === 0` ⇒ 400 TOO_MANY_DOMAINS（不是 500）。
 *
 * 本文件钉的几条线（都是"出事时才看得见"的）：
 *   1. 别人的一级子域 → 403 FORBIDDEN，且**一个 CF 写请求都不发**；
 *   2. 自己的一级子域 / 自己的二级子域 → 200；
 *   3. 归属校验排在 FQDN_TAKEN 之前 —— 否则 409/403 的差别就是个「这个域名有没有被绑过」的探针；
 *   4. 第 6 个 → 400 TOO_MANY_DOMAINS，且**不碰 Cloudflare**（预占先于远程调用）；
 *   5. 换绑正常：不占新名额、旧域名的解析记录被释放；
 *   6. CF 失败要回滚预占：旧绑定必须还在，本次新建的解析记录必须清掉（否则就是 81045 那种配额泄漏）；
 *   7. 幂等重存同一个 fqdn 仍然放行（存量行里有绑在自己没登记过的 host 上的，
 *      见下面「存量形态」那条用例的注释）。
 *
 * ⚠️ 出站全部打桩（`vi.stubGlobal("fetch")`）：写操作一次都不许打到真 Cloudflare。
 *    非 api.cloudflare.com 的出站请求一律直接抛错 —— 打桩期间出现别的网络调用，
 *    说明测试或代码写错了。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { env } from "cloudflare:workers"
import { resetRootDomainCache } from "../src/root-domains"
import { makeUser, authRequest, fetchSelf, type TestUser } from "./helpers"

const ROOT = "labdom.test"
const ZONE = "zone-labdom"

/** 与 `handlers/lab-domains.ts` 的 MAX_DOMAINS_PER_USER 一致（那边没导出，这里显式钉住） */
const LIMIT = 5

// ---------------------------------------------------------------------------
// Cloudflare API 打桩：只实现本接口会走到的 6 个端点
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
/** 所有**非 GET** 的 CF 调用（按顺序），用来断言「到底写了什么 / 有没有写」 */
let cfWrites: { method: string; path: string }[]
/** 让 Worker Route 的 POST 失败（测回滚）*/
let routePostFails: boolean
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
  routePostFails = false
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

    // ---- DNS 记录 ----
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

    // ---- Worker Route ----
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
        if (routePostFails) return cfJson(null, 500)
        const rec: RouteRec = { id: `route-${++seq}`, zone, pattern: body.pattern, script: body.script }
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

/** 某主机名在 CF 侧现有的记录 */
function dnsFor(name: string): DnsRec[] {
  return dns.filter((r) => r.name === name)
}

// ---------------------------------------------------------------------------
// 数据库种子与请求
// ---------------------------------------------------------------------------

async function seedRoot(name: string, zoneId: string | null) {
  await env.DB.prepare(
    `INSERT INTO root_domains
       (name, zone_id, label, requires_feature, dns_price_per_year, is_default, enabled, created_at)
     VALUES (?, ?, NULL, NULL, 0, 0, 1, ?)`
  )
    .bind(name, zoneId, new Date().toISOString())
    .run()
  resetRootDomainCache()
}

/** 给用户登记一个子域名（一级：parent_id = NULL；`name='@'` 表示它是这个人的主域名） */
async function seedSubdomain(
  user: TestUser,
  fqdn: string,
  name = "@",
  parentId: string | null = null
): Promise<string> {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    "INSERT INTO subdomains (id, user_id, name, fqdn, parent_id, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)"
  )
    .bind(id, user.id, name, fqdn, parentId, new Date().toISOString())
    .run()
  return id
}

async function makeProject(user: TestUser, visibility = "public"): Promise<string> {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO lab_projects
       (id, user_id, name, slug, description, icon, files, visibility, views, likes, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', '🌐', '{}', ?, 0, 0, ?, ?)`
  )
    .bind(id, user.id, `作品-${seq++}`, `p-${id.slice(0, 8)}`, visibility, now, now)
    .run()
  return id
}

function bindReq(user: TestUser, projectId: string, fqdn: string): Request {
  return authRequest(user, `/api/lab/projects/${projectId}/domain`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fqdn }),
  })
}

async function bind(user: TestUser, projectId: string, fqdn: string): Promise<Response> {
  return fetchSelf(bindReq(user, projectId, fqdn))
}

/** 某作品当前绑的 fqdn（应为 0 或 1 行） */
async function boundFqdn(projectId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT fqdn FROM lab_project_domains WHERE project_id = ?"
  )
    .bind(projectId)
    .first<{ fqdn: string }>()
  return row?.fqdn ?? null
}

async function rowCount(where: string, ...args: unknown[]): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM lab_project_domains ${where}`)
    .bind(...args)
    .first<{ c: number }>()
  return row?.c ?? 0
}

beforeEach(async () => {
  installCf()
  await env.DB.prepare("DELETE FROM root_domains").run()
  await seedRoot(ROOT, ZONE)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// 1. #9 归属校验
// ---------------------------------------------------------------------------

describe("#9 归属校验：只能绑自己名下的子域", () => {
  it("绑**别人**的一级子域 → 403 FORBIDDEN，且不碰 Cloudflare、不落库", async () => {
    const victim = await makeUser()
    const attacker = await makeUser()
    // 受害者拥有 victim.labdom.test（一级子域），攻击者拥有 attacker.labdom.test
    await seedSubdomain(victim, `victim.${ROOT}`, "@")
    await seedSubdomain(attacker, `attacker.${ROOT}`, "@")
    const project = await makeProject(attacker)

    // 受害者还没给这个 host 建解析（`/api/subdomains` 本来就不建）
    // ⇒ 修复前 `existing.length === 0` 会一路放行，整站被顶掉。
    const res = await bind(attacker, project, `blog.victim.${ROOT}`)

    expect(res.status).toBe(403)
    const body = await res.json<{ code: string; error: string }>()
    expect(body.code).toBe("FORBIDDEN")
    expect(body.error).toContain("不在你的名下")

    // 关键：越权请求一个 CF 写操作都不该发出（否则已经给别人的域名建了记录/路由）
    expect(cfWrites).toEqual([])
    expect(dns).toHaveLength(0)
    expect(routes).toHaveLength(0)
    // 库里也不能留下绑定行
    expect(await rowCount("WHERE project_id = ?", project)).toBe(0)
  })

  it("绑别人**已被人绑过**的域名 → 403 而不是 409（不泄露「这个域名有没有被绑过」）", async () => {
    const victim = await makeUser()
    const attacker = await makeUser()
    await seedSubdomain(victim, `victim2.${ROOT}`, "@")
    await seedSubdomain(attacker, `attacker2.${ROOT}`, "@")

    // 受害者先把自己的子域绑到一个作品上
    const victimProject = await makeProject(victim)
    expect(
      (await bind(victim, victimProject, `victim2.${ROOT}`)).status,
      "受害者绑自己的域名应当成功"
    ).toBe(200)

    // 攻击者再绑同一个域名：归属校验在前 ⇒ 403（若判重在前会变成 409）
    const attackerProject = await makeProject(attacker)
    const res = await bind(attacker, attackerProject, `victim2.${ROOT}`)
    expect(res.status).toBe(403)
    expect((await res.json<{ code: string }>()).code).toBe("FORBIDDEN")

    // 受害者的绑定没有被抢走
    expect(await boundFqdn(victimProject)).toBe(`victim2.${ROOT}`)
  })

  it("绑**自己的**一级子域 → 200（fqdn 恰好等于自己登记的那一条）", async () => {
    const user = await makeUser()
    await seedSubdomain(user, `mine.${ROOT}`, "@")
    const project = await makeProject(user)

    const res = await bind(user, project, `mine.${ROOT}`)
    expect(res.status).toBe(200)
    expect((await res.json<{ fqdn: string }>()).fqdn).toBe(`mine.${ROOT}`)
    expect(await boundFqdn(project)).toBe(`mine.${ROOT}`)
    // 真正的落地动作都做了：AAAA 100:: + 路由
    expect(dnsFor(`mine.${ROOT}`)).toEqual([
      expect.objectContaining({ type: "AAAA", content: "100::", proxied: true }),
    ])
    expect(routes.map((r) => r.pattern)).toContain(`mine.${ROOT}/*`)
  })

  it("绑自己的**二级**子域 → 200（落在自己的 base 之下即可，无需逐条登记）", async () => {
    const user = await makeUser()
    await seedSubdomain(user, `base.${ROOT}`, "@")
    const project = await makeProject(user)

    const res = await bind(user, project, `deep.blog.base.${ROOT}`)
    expect(res.status).toBe(200)
    expect(await boundFqdn(project)).toBe(`deep.blog.base.${ROOT}`)
    expect(dnsFor(`deep.blog.base.${ROOT}`)).toHaveLength(1)
  })

  it("归属校验不越过「保留名」与「根域权益」两道闸（顺序上先报更明确的那个）", async () => {
    const user = await makeUser()
    await seedSubdomain(user, `ok.${ROOT}`, "@")
    const project = await makeProject(user)

    // 保留名：即使这个人有 base，cloud.* 也不能绑
    const res = await bind(user, project, `cloud.${ROOT}`)
    expect(res.status).toBe(403)
    expect((await res.json<{ code: string }>()).code).toBe("RESERVED_HOSTNAME")
  })
})

// ---------------------------------------------------------------------------
// 2. #29 数量上限：原子守卫
// ---------------------------------------------------------------------------

describe("#29 数量上限：守卫写进单条 SQL", () => {
  it(`连续绑 ${LIMIT} 个成功，第 ${LIMIT + 1} 个 → 400 TOO_MANY_DOMAINS（业务错误，不是 500）`, async () => {
    const user = await makeUser()
    await seedSubdomain(user, `quota.${ROOT}`, "@")

    for (let i = 0; i < LIMIT; i++) {
      const project = await makeProject(user)
      const res = await bind(user, project, `q${i}.quota.${ROOT}`)
      expect(res.status, `第 ${i + 1} 个应当成功`).toBe(200)
    }
    expect(await rowCount("WHERE user_id = ?", user.id)).toBe(LIMIT)

    // 第 6 个：名额已满
    const extra = await makeProject(user)
    const writesBefore = cfWrites.length
    const res = await bind(user, extra, `q${LIMIT}.quota.${ROOT}`)

    expect(res.status).toBe(400)
    const body = await res.json<{ code: string; error: string }>()
    expect(body.code).toBe("TOO_MANY_DOMAINS")
    expect(body.error).toContain(String(LIMIT))

    // 预占先于远程调用 ⇒ 被拒的这次一条 DNS/Route 都不该建（否则白烧 zone 的记录配额）
    expect(cfWrites.length, "超限请求不该碰 Cloudflare").toBe(writesBefore)
    expect(dnsFor(`q${LIMIT}.quota.${ROOT}`)).toHaveLength(0)
    expect(await rowCount("WHERE user_id = ?", user.id)).toBe(LIMIT)
  })

  it("真并发：同一账号 8 个请求同时绑 → 恰好成功 5 个，另外 3 个是 TOO_MANY_DOMAINS", async () => {
    const user = await makeUser()
    await seedSubdomain(user, `race.${ROOT}`, "@")

    const projects = await Promise.all(Array.from({ length: 8 }, () => makeProject(user)))
    const responses = await Promise.all(
      projects.map((project, i) => bind(user, project, `r${i}.race.${ROOT}`))
    )

    const ok = responses.filter((r) => r.status === 200)
    const rejected = responses.filter((r) => r.status === 400)
    expect(ok).toHaveLength(LIMIT)
    expect(rejected).toHaveLength(8 - LIMIT)
    for (const res of rejected) {
      expect((await res.json<{ code: string }>()).code).toBe("TOO_MANY_DOMAINS")
    }
    // 上限是硬不变量：无论并发顺序如何，库里只能有 LIMIT 行
    expect(await rowCount("WHERE user_id = ?", user.id)).toBe(LIMIT)
  })

  it("上限按用户隔离：别人绑满了不影响我", async () => {
    const heavy = await makeUser()
    const other = await makeUser()
    await seedSubdomain(heavy, `h.${ROOT}`, "@")
    await seedSubdomain(other, `o.${ROOT}`, "@")

    for (let i = 0; i < LIMIT; i++) {
      const p = await makeProject(heavy)
      expect((await bind(heavy, p, `h${i}.h.${ROOT}`)).status).toBe(200)
    }
    const mine = await makeProject(other)
    expect((await bind(other, mine, `o1.o.${ROOT}`)).status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// 3. 换绑语义（"先插后删"的地基）
// ---------------------------------------------------------------------------

describe("换绑：不占新名额、旧解析记录被释放", () => {
  it("满额时换绑仍然成功（换绑不占新名额），且旧域名的 AAAA 记录被释放", async () => {
    const user = await makeUser()
    await seedSubdomain(user, `swap.${ROOT}`, "@")

    const projects: string[] = []
    for (let i = 0; i < LIMIT; i++) {
      const p = await makeProject(user)
      projects.push(p)
      expect((await bind(user, p, `s${i}.swap.${ROOT}`)).status).toBe(200)
    }
    expect(await rowCount("WHERE user_id = ?", user.id)).toBe(LIMIT)

    // 满额状态下把第 0 个换到另一个自己的子域
    const target = projects[0]
    const res = await bind(user, target, `moved.swap.${ROOT}`)
    expect(res.status, "换绑不该被数量上限挡（它把原来的名额带过来）").toBe(200)

    expect(await boundFqdn(target)).toBe(`moved.swap.${ROOT}`)
    // 仍然只有 LIMIT 行（旧行被同一条事务删掉，不是多出一行）
    expect(await rowCount("WHERE user_id = ?", user.id)).toBe(LIMIT)
    // 旧域名的解析记录被释放，新域名的存在 —— 否则记录只增不减，迟早 81045
    expect(dnsFor(`s0.swap.${ROOT}`)).toHaveLength(0)
    expect(dnsFor(`moved.swap.${ROOT}`)).toHaveLength(1)
  })

  it("同一 fqdn 幂等重存 → 200，不新增行、不重复建解析记录", async () => {
    const user = await makeUser()
    await seedSubdomain(user, `idem.${ROOT}`, "@")
    const project = await makeProject(user)

    expect((await bind(user, project, `idem.${ROOT}`)).status).toBe(200)
    const dnsCount = dnsFor(`idem.${ROOT}`).length
    expect(dnsCount).toBe(1)

    expect((await bind(user, project, `idem.${ROOT}`)).status).toBe(200)
    expect(await rowCount("WHERE project_id = ?", project)).toBe(1)
    expect(dnsFor(`idem.${ROOT}`)).toHaveLength(dnsCount)
  })

  it("存量形态：行已存在但 host 从未登记在 subdomains 里 ⇒ 重存同一个 fqdn 放行，换到别的未登记 host 仍然 403", async () => {
    // 线上实测形态（2026-10-16 只读核对）：账号 Doulor 的作品「星碎」绑在
    // `starfall.tyu.me`，而该账号的 subdomains 里从来没有这一行 ——
    // 严格按 assertFqdnOwned 一定会 403。存量行本身仍在正常出内容，
    // 这里只保证「它还能被重新保存」（同 fqdn 不产生任何新权力）。
    const user = await makeUser()
    await seedSubdomain(user, `legacy.${ROOT}`, "@")
    const project = await makeProject(user)

    const legacyFqdn = `notregistered.${ROOT}`
    await env.DB.prepare(
      "INSERT INTO lab_project_domains (id, project_id, user_id, fqdn, created_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(crypto.randomUUID(), project, user.id, legacyFqdn, new Date().toISOString())
      .run()

    // 同 fqdn 重存：放行（幂等分支跳过归属校验）
    const same = await bind(user, project, legacyFqdn)
    expect(same.status).toBe(200)
    expect(await rowCount("WHERE project_id = ?", project)).toBe(1)

    // 换到另一个同样"没登记过"的 host：仍然必须 403
    const other = await bind(user, project, `other-not-mine.${ROOT}`)
    expect(other.status).toBe(403)
    expect((await other.json<{ code: string }>()).code).toBe("FORBIDDEN")
    // 原有绑定没有被这次失败改掉
    expect(await boundFqdn(project)).toBe(legacyFqdn)
  })
})

// ---------------------------------------------------------------------------
// 4. 失败回滚（先预占再动 CF 的配套）
// ---------------------------------------------------------------------------

describe("Cloudflare 失败时的回滚", () => {
  it("换绑时 Route 创建失败 ⇒ 502，旧绑定还在、新域名的解析记录已清掉", async () => {
    const user = await makeUser()
    await seedSubdomain(user, `rb.${ROOT}`, "@")
    const project = await makeProject(user)
    expect((await bind(user, project, `keep.rb.${ROOT}`)).status).toBe(200)

    routePostFails = true
    const res = await bind(user, project, `next.rb.${ROOT}`)
    expect(res.status).toBe(502)

    // 回滚到位：仍然只绑着原来那个
    expect(await boundFqdn(project)).toBe(`keep.rb.${ROOT}`)
    expect(await rowCount("WHERE project_id = ?", project)).toBe(1)
    // 本次新建的解析记录被释放（不然就是 81045 那种配额泄漏），旧域名的记录没被动
    expect(dnsFor(`next.rb.${ROOT}`)).toHaveLength(0)
    expect(dnsFor(`keep.rb.${ROOT}`)).toHaveLength(1)
  })

  it("首次绑定就失败 ⇒ 502，库里不留任何行（预占为 0 时的回滚）", async () => {
    const user = await makeUser()
    await seedSubdomain(user, `first.${ROOT}`, "@")
    const project = await makeProject(user)

    routePostFails = true
    const res = await bind(user, project, `n1.first.${ROOT}`)
    expect(res.status).toBe(502)

    expect(await rowCount("WHERE project_id = ?", project)).toBe(0)
    expect(dns).toHaveLength(0)
  })

  it("被占用（HOSTNAME_IN_USE）时同样回滚，不留下半成品绑定", async () => {
    const user = await makeUser()
    await seedSubdomain(user, `busy.${ROOT}`, "@")
    const project = await makeProject(user)
    expect((await bind(user, project, `keep2.busy.${ROOT}`)).status).toBe(200)

    // 用户自己的 host 上已经有一条**不是我们建的**记录（例如他自己的网关服务）
    // ⚠️ 标签不能用 gw / app / api 这类保留名 —— 那会先被 RESERVED_HOSTNAME 挡在前面，
    //    这条用例要测的是 HOSTNAME_IN_USE，所以用一个不保留的业务名。
    dns.push({
      id: "dns-user",
      zone: ZONE,
      name: `mysvc.busy.${ROOT}`,
      type: "A",
      content: "203.0.113.9",
      proxied: true,
    })

    const res = await bind(user, project, `mysvc.busy.${ROOT}`)
    expect(res.status).toBe(409)
    expect((await res.json<{ code: string }>()).code).toBe("HOSTNAME_IN_USE")

    // 旧绑定原封不动（预占已回滚），用户自己的记录也没被删
    expect(await boundFqdn(project)).toBe(`keep2.busy.${ROOT}`)
    expect(await rowCount("WHERE project_id = ?", project)).toBe(1)
    expect(dnsFor(`mysvc.busy.${ROOT}`)).toEqual([expect.objectContaining({ id: "dns-user" })])
  })
})
