/**
 * 根域「从 Cloudflare 导入 + 自动初始化」与「删除根域」（2026-10-15 站长要求）。
 *
 * 这两件事跟「改一个设置项」不是一个量级：它们会**写生产资源**（CF 上的泛解析记录、
 * `dns_wildcard_roots` 设置项、`root_domains` 表），而且多步骤、跨系统。
 * 所以这里锁的不是「happy path 能跑通」，而是出事时才看得见的那几条线：
 *
 *   1. **幂等**：第二次导入不能再建一条 `*.域` 泛解析，也不能把设置项写成两份 ——
 *      这条不成立的话「失败重试」就会变成「多建一堆记录 + 把配额吃光」。
 *   2. **不留半成品**：任何一步失败，都不能出现「设置里说某域有泛解析、CF 上其实没有」
 *      这种用户子域静默解析不了的状态（详见 importAdminRootDomain 的顺序注释）。
 *   3. **删根域默认不碰 CF**：默认保留记录，只有显式勾选才删，且只删平台自己的占位记录，
 *      MX / TXT / 指向真实源站的记录一律不动。
 *   4. 默认域 / 站点主域 / confirm 不匹配一律拒绝（后端独立校验，不信任前端弹窗）。
 *
 * ⚠️ CF 侧**全部打桩**（`vi.stubGlobal("fetch")`）：真账号上的记录是站长的生产基础设施，
 * 测试里一条都不能碰，也不该依赖网络。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { env } from "cloudflare:workers"
import { ApiError } from "../src/http"
import { getSetting } from "../src/settings"
import { resetRootDomainCache } from "../src/root-domains"
import {
  importAdminRootDomain,
  listAdminRootDomains,
  listImportableCfZones,
  rootDomainAction,
} from "../src/handlers/admin-root-domains"
import { makeUser, authRequest, fetchSelf, setSetting, type TestUser } from "./helpers"

// ---------------------------------------------------------------------------
// Cloudflare API 打桩
// ---------------------------------------------------------------------------

interface FakeRec {
  id: string
  name: string
  type: string
  content: string
  proxied: boolean
}

interface FakeZone {
  id: string
  name: string
  status: string
  records: FakeRec[]
}

let cfZones: Map<string, FakeZone>
let cfCalls: { method: string; path: string; body: Record<string, unknown> | null; query: URLSearchParams }[]
let cfFailCreate = false
let cfFailDelete: Set<string>

function cfJson(
  result: unknown,
  init: { status?: number; resultInfo?: Record<string, unknown> } = {}
): Response {
  const status = init.status ?? 200
  return new Response(
    JSON.stringify({
      success: status < 400,
      result,
      ...(init.resultInfo ? { result_info: init.resultInfo } : {}),
    }),
    { status, headers: { "Content-Type": "application/json" } }
  )
}

function zoneById(id: string): FakeZone | undefined {
  return [...cfZones.values()].find((z) => z.id === id)
}

/** 造一个 zone；records 是「已经躺在 CF 上」的记录 */
function seedZone(name: string, records: { name: string; type: string; content: string; proxied?: boolean }[] = []): string {
  const id = `zone-${name}`
  cfZones.set(name, {
    id,
    name,
    status: "active",
    records: records.map((r, i) => ({
      // 稳定 id：测试要按 id 制造「删除失败」
      id: `rec-${name}-${i + 1}`,
      name: r.name,
      type: r.type,
      content: r.content,
      proxied: r.proxied ?? true,
    })),
  })
  return id
}

function installCf() {
  cfZones = new Map()
  cfCalls = []
  cfFailCreate = false
  cfFailDelete = new Set()

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url
    const url = new URL(raw)
    if (url.hostname !== "api.cloudflare.com") {
      // 打桩期间任何别的出站请求都是测试写错了（或代码里新加了网络调用）
      throw new Error(`测试中出现预期外的出站请求：${raw}`)
    }

    const method = (init?.method ?? "GET").toUpperCase()
    const path = url.pathname.replace(/^\/client\/v4/, "")
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null
    cfCalls.push({ method, path, body, query: url.searchParams })

    // 列 zone（分页参数被忽略：测试里只有一页）
    if (method === "GET" && path === "/zones") {
      return cfJson(
        [...cfZones.values()].map((z) => ({
          id: z.id,
          name: z.name,
          status: z.status,
          paused: false,
          plan: { name: "Free Website" },
        })),
        { resultInfo: { total_pages: 1 } }
      )
    }

    const listPath = path.match(/^\/zones\/([^/]+)\/dns_records$/)
    if (listPath) {
      const zone = zoneById(listPath[1])
      if (!zone) return cfJson(null, { status: 404 })
      if (method === "GET") {
        const name = url.searchParams.get("name")
        const perPage = Number(url.searchParams.get("per_page") ?? "100")
        const rows = name ? zone.records.filter((r) => r.name === name) : zone.records
        // total_count 是**全 zone** 的记录数（配额用量的口径），与 name 过滤无关
        return cfJson(rows.slice(0, perPage), {
          resultInfo: { total_count: zone.records.length, total_pages: 1 },
        })
      }
      if (method === "POST") {
        if (cfFailCreate) return cfJson(null, { status: 500 })
        const rec: FakeRec = {
          id: `rec-new-${zone.records.length + 1}`,
          name: String(body?.name ?? ""),
          type: String(body?.type ?? ""),
          content: String(body?.content ?? ""),
          proxied: Boolean(body?.proxied),
        }
        zone.records.push(rec)
        return cfJson(rec)
      }
    }

    const delPath = path.match(/^\/zones\/([^/]+)\/dns_records\/([^/]+)$/)
    if (delPath && method === "DELETE") {
      const zone = zoneById(delPath[1])
      if (!zone) return cfJson(null, { status: 404 })
      if (cfFailDelete.has(delPath[2])) return cfJson(null, { status: 500 })
      const idx = zone.records.findIndex((r) => r.id === delPath[2])
      if (idx < 0) return cfJson(null, { status: 404 })
      zone.records.splice(idx, 1)
      return cfJson({ id: delPath[2] })
    }

    return cfJson(null, { status: 404 })
  })
}

// ---------------------------------------------------------------------------
// 数据库种子与请求
// ---------------------------------------------------------------------------

let admin: TestUser

async function seedRoot(
  name: string,
  opts: { zoneId?: string; price?: number; isDefault?: boolean; feature?: string | null } = {}
) {
  await env.DB.prepare(
    `INSERT INTO root_domains
       (name, zone_id, label, requires_feature, dns_price_per_year, is_default, enabled, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, 1, ?)`
  )
    .bind(
      name,
      opts.zoneId ?? null,
      opts.feature ?? null,
      opts.price ?? 0,
      opts.isDefault ? 1 : 0,
      new Date().toISOString()
    )
    .run()
  resetRootDomainCache()
}

async function rootRow(name: string) {
  return env.DB.prepare("SELECT name, zone_id, dns_price_per_year FROM root_domains WHERE name = ?")
    .bind(name)
    .first<{ name: string; zone_id: string | null; dns_price_per_year: number }>()
}

function importReq(user: TestUser, payload: Record<string, unknown>): Request {
  return authRequest(user, "/api/admin/root-domains/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
}

function actionReq(user: TestUser, payload: Record<string, unknown>): Request {
  return authRequest(user, "/api/admin/root-domains/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
}

/** 断言一定抛 ApiError，并把错误本体交回给用例（看 status / code / message） */
async function catchApiError(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run()
  } catch (err) {
    expect(err, `期望抛 ApiError，实际抛了：${String(err)}`).toBeInstanceOf(ApiError)
    return err as ApiError
  }
  throw new Error("期望抛 ApiError，但请求成功了")
}

/** 所有打到 DNS 记录接口的写操作（POST/DELETE），用来断言「有没有真的动 CF」 */
function cfWrites() {
  return cfCalls.filter(
    (c) => c.method !== "GET" && c.path.includes("/dns_records")
  )
}

beforeEach(async () => {
  installCf()
  await env.DB.prepare("DELETE FROM root_domains").run()
  await env.DB.prepare("DELETE FROM dns_rentals").run()
  // 固定一个已知的 dns_wildcard_roots，方便断言「追加」与「摘除」的**顺序**
  await setSetting("dns_wildcard_roots", "tyu.me,doulor.cn")
  resetRootDomainCache()
  admin = await makeUser({ role: "admin" })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// 1. 候选列表
// ---------------------------------------------------------------------------

describe("从 Cloudflare 导入 —— 候选 zone 列表", () => {
  it("排除已登记的根域，并带上用量与泛解析现状", async () => {
    seedZone("alpha.test", [{ name: "*.alpha.test", type: "AAAA", content: "100::" }])
    seedZone("beta.test", [
      { name: "beta.test", type: "MX", content: "10 mail.beta.test" },
      { name: "beta.test", type: "TXT", content: "v=spf1 -all" },
    ])
    seedZone("taken.test")
    await seedRoot("taken.test", { zoneId: "zone-taken.test" })

    const res = await listImportableCfZones(
      env,
      authRequest(admin, "/api/admin/root-domains/cf-zones")
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      zones: { name: string; zoneId: string; recordsUsed: number; wildcard: string }[]
      registered: string[]
      hasCfToken: boolean
    }

    expect(body.zones.map((z) => z.name).sort()).toEqual(["alpha.test", "beta.test"])
    expect(body.registered).toContain("taken.test")
    expect(body.hasCfToken).toBe(true)

    const alpha = body.zones.find((z) => z.name === "alpha.test")!
    expect(alpha.zoneId).toBe("zone-alpha.test")
    expect(alpha.recordsUsed).toBe(1)
    expect(alpha.wildcard).toBe("ok")

    const beta = body.zones.find((z) => z.name === "beta.test")!
    expect(beta.recordsUsed).toBe(2)
    expect(beta.wildcard).toBe("missing")
  })

  it("灰云的泛解析标成 no-proxy（看着配好了、其实接不住 Worker 路由）", async () => {
    seedZone("gray.test", [
      { name: "*.gray.test", type: "AAAA", content: "100::", proxied: false },
    ])

    const res = await listImportableCfZones(
      env,
      authRequest(admin, "/api/admin/root-domains/cf-zones")
    )
    const body = (await res.json()) as { zones: { name: string; wildcard: string }[] }
    expect(body.zones[0].wildcard).toBe("no-proxy")
  })

  it("同名记录不是本站占位时标成 conflict", async () => {
    seedZone("wild.test", [
      { name: "*.wild.test", type: "A", content: "203.0.113.10" },
    ])

    const res = await listImportableCfZones(
      env,
      authRequest(admin, "/api/admin/root-domains/cf-zones")
    )
    const body = (await res.json()) as {
      zones: { wildcard: string; wildcardDetail: string | null }[]
    }
    expect(body.zones[0].wildcard).toBe("conflict")
    expect(body.zones[0].wildcardDetail).toBe("A 203.0.113.10")
  })
})

// ---------------------------------------------------------------------------
// 2. 导入 + 自动初始化
// ---------------------------------------------------------------------------

describe("导入根域 —— 自动初始化的幂等性", () => {
  it("成功导入：建泛解析（AAAA 100:: + 代理）、追加设置项、立刻生效", async () => {
    seedZone("gamma.test")
    const res = await importAdminRootDomain(
      env,
      importReq(admin, {
        name: "gamma.test",
        zoneId: "zone-gamma.test",
        dnsPricePerYear: 200,
      })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      wildcard: { state: string }
      steps: { step: string; state: string }[]
      wildcardRoots: string
    }
    expect(body.ok).toBe(true)
    expect(body.wildcard.state).toBe("created")
    expect(body.steps).toContainEqual({ step: "register", state: "created" })
    expect(body.steps).toContainEqual({ step: "wildcardRoots", state: "ok" })

    // 泛解析的载荷必须与站点其它占位记录一致（AAAA 100:: + 橙云）
    const creates = cfCalls.filter((c) => c.method === "POST")
    expect(creates).toHaveLength(1)
    expect(creates[0].path).toBe("/zones/zone-gamma.test/dns_records")
    expect(creates[0].body).toMatchObject({
      type: "AAAA",
      name: "*.gamma.test",
      content: "100::",
      proxied: true,
    })

    // 表行 + 价格
    expect(await rootRow("gamma.test")).toMatchObject({
      name: "gamma.test",
      zone_id: "zone-gamma.test",
      dns_price_per_year: 200,
    })

    // 设置项：追加在末尾（既有顺序不动），不是插到前面
    expect(await getSetting(env, "dns_wildcard_roots")).toBe("tyu.me,doulor.cn,gamma.test")
    expect(body.wildcardRoots).toBe("tyu.me,doulor.cn,gamma.test")
  })

  it("第二次导入同一个域：跳过已存在的泛解析，设置项不重复（幂等）", async () => {
    seedZone("gamma.test")
    await importAdminRootDomain(
      env,
      importReq(admin, { name: "gamma.test", zoneId: "zone-gamma.test" })
    )
    const second = await importAdminRootDomain(
      env,
      importReq(admin, { name: "gamma.test", zoneId: "zone-gamma.test" })
    )
    const body = (await second.json()) as {
      wildcard: { state: string }
      steps: { step: string; state: string }[]
      wasExisting: boolean
    }

    expect(body.wildcard.state).toBe("existed")
    expect(body.wasExisting).toBe(true)
    expect(body.steps).toContainEqual({ step: "register", state: "existed" })
    // 只有第一次那次 POST
    expect(cfCalls.filter((c) => c.method === "POST")).toHaveLength(1)
    expect(await getSetting(env, "dns_wildcard_roots")).toBe("tyu.me,doulor.cn,gamma.test")
    // 表里也只有一行
    const cnt = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM root_domains WHERE name = 'gamma.test'"
    ).first<{ c: number }>()
    expect(cnt?.c).toBe(1)
  })

  it("设置项里已手写过的域（大小写/前导点不同）也能去重", async () => {
    // 站长手写过的形态：带前导点、大小写混用
    await setSetting("dns_wildcard_roots", "tyu.me, .Gamma.TEST ")
    seedZone("gamma.test")
    await importAdminRootDomain(
      env,
      importReq(admin, { name: "gamma.test", zoneId: "zone-gamma.test" })
    )
    expect(await getSetting(env, "dns_wildcard_roots")).toBe("tyu.me,gamma.test")
  })

  it("建泛解析失败（CF 500）：回滚表行，不留半成品", async () => {
    seedZone("delta.test")
    cfFailCreate = true

    const err = await catchApiError(() =>
      importAdminRootDomain(
        env,
        importReq(admin, { name: "delta.test", zoneId: "zone-delta.test" })
      )
    )
    expect(err.status).toBe(502)
    expect(err.message).toContain("已回滚")

    expect(await rootRow("delta.test")).toBeNull()
    expect(await getSetting(env, "dns_wildcard_roots")).toBe("tyu.me,doulor.cn")
  })

  it("同名非占位记录：拒绝导入且不留残留（不覆盖站长自己的通配解析）", async () => {
    seedZone("wild.test", [{ name: "*.wild.test", type: "A", content: "203.0.113.10" }])

    const err = await catchApiError(() =>
      importAdminRootDomain(
        env,
        importReq(admin, { name: "wild.test", zoneId: "zone-wild.test" })
      )
    )
    expect(err.status).toBe(409)
    expect(err.code).toBe("CF_WILDCARD_CONFLICT")
    expect(await rootRow("wild.test")).toBeNull()
    expect(await getSetting(env, "dns_wildcard_roots")).toBe("tyu.me,doulor.cn")
  })

  it("灰云泛解析：拒绝导入（静默放行等于把「用户子域解析不了」埋起来）", async () => {
    seedZone("gray.test", [
      { name: "*.gray.test", type: "AAAA", content: "100::", proxied: false },
    ])

    const err = await catchApiError(() =>
      importAdminRootDomain(
        env,
        importReq(admin, { name: "gray.test", zoneId: "zone-gray.test" })
      )
    )
    expect(err.status).toBe(409)
    expect(err.code).toBe("CF_WILDCARD_NO_PROXY")
    expect(await rootRow("gray.test")).toBeNull()
  })

  it("传入的 zoneId 与该域实际的 zone 不一致：拒绝（不把泛解析建到别人的 zone 里）", async () => {
    seedZone("mismatch.test")
    const err = await catchApiError(() =>
      importAdminRootDomain(
        env,
        importReq(admin, { name: "mismatch.test", zoneId: "zone-of-someone-else" })
      )
    )
    expect(err.status).toBe(409)
    expect(err.code).toBe("CF_ZONE_MISMATCH")
    expect(await rootRow("mismatch.test")).toBeNull()
    // 一个字节都没写：连泛解析都没建
    expect(cfWrites()).toHaveLength(0)
  })

  it("表里本来就有这一行时失败：**保留**既有行（那是站长的配置，不是本次的残留）", async () => {
    await seedRoot("kept.test", { zoneId: "zone-kept.test", price: 500 })
    seedZone("kept.test")
    cfFailCreate = true

    await catchApiError(() =>
      importAdminRootDomain(
        env,
        importReq(admin, { name: "kept.test", zoneId: "zone-kept.test", dnsPricePerYear: 999 })
      )
    )
    const row = await rootRow("kept.test")
    expect(row?.name).toBe("kept.test")
    // 既有价格不被覆盖（这个接口只补 zone_id，不顺手改配置）
    expect(row?.dns_price_per_year).toBe(500)
    // 关键：没有泛解析就绝不写 dns_wildcard_roots
    expect(await getSetting(env, "dns_wildcard_roots")).toBe("tyu.me,doulor.cn")
  })

  it("重试能收敛：先失败、后成功，最终状态与一次成功完全一致", async () => {
    seedZone("retry.test")
    cfFailCreate = true
    await catchApiError(() =>
      importAdminRootDomain(
        env,
        importReq(admin, { name: "retry.test", zoneId: "zone-retry.test", dnsPricePerYear: 100 })
      )
    )
    expect(await rootRow("retry.test")).toBeNull()

    cfFailCreate = false
    await importAdminRootDomain(
      env,
      importReq(admin, { name: "retry.test", zoneId: "zone-retry.test", dnsPricePerYear: 100 })
    )
    expect(await rootRow("retry.test")).toMatchObject({ zone_id: "zone-retry.test" })
    expect(await getSetting(env, "dns_wildcard_roots")).toBe("tyu.me,doulor.cn,retry.test")
    expect(cfZones.get("retry.test")!.records.map((r) => r.name)).toEqual(["*.retry.test"])
  })

  it("设为默认域时，全局唯一（旧的默认被清掉）", async () => {
    await seedRoot("old.test", { isDefault: true })
    seedZone("new.test")
    await importAdminRootDomain(
      env,
      importReq(admin, { name: "new.test", zoneId: "zone-new.test", isDefault: true })
    )
    const defaults = await env.DB.prepare(
      "SELECT name FROM root_domains WHERE is_default = 1"
    ).all<{ name: string }>()
    expect((defaults.results ?? []).map((r) => r.name)).toEqual(["new.test"])
  })
})

// ---------------------------------------------------------------------------
// 2.5 根域**顶点**（「泛解析不覆盖顶点」这条 DNS 规则的回归线）
// ---------------------------------------------------------------------------

/**
 * 背景（2026-10-16 站长报障）：造物集里某个作品设了自定义链接 `flybird`，
 * 界面显示「别人的访问地址：tyu.me/flybird」，但那个地址**打不开**。
 *
 * 排查结论：既不是显示错，也不是 Worker 路由缺失 —— `tyu.me/*` 的路由与承载它的
 * `doulor-tyu-site` 都好好地在线上。缺的是 **tyu.me 顶点的一条代理记录**：
 * 通配符 `*.tyu.me` **不覆盖顶点**（DNS 规范如此），而顶点上只有 MX/TXT（邮件），
 * 于是 `tyu.me/*` 整条链路从 DNS 这一步就断了。
 *
 * 这一组用例锁的就是「**顶点与泛解析必须分开判定**」：只要有人把 apex 的判定
 * 退化成「看看泛解析」，线上这种「子域全通、顶点全断」的状态就会再次隐身 ——
 * 而用户看到的是一个能点、能复制、却打不开的链接。
 */
describe("根域顶点现状（泛解析不覆盖顶点）", () => {
  async function listRoots() {
    const res = await listAdminRootDomains(
      env,
      authRequest(admin, "/api/admin/root-domains")
    )
    expect(res.status).toBe(200)
    return (await res.json()) as {
      rootDomains: { name: string; apex: string; apexDetail: string | null }[]
    }
  }

  it("顶点只有 MX/TXT（邮件记录）⇒ missing：这就是 tyu.me 的形态", async () => {
    // 泛解析好得很（子域全通），顶点只有邮件记录 —— 两者合起来正是线上那个 bug
    seedZone("tyu.test", [
      { name: "*.tyu.test", type: "AAAA", content: "100::" },
      { name: "tyu.test", type: "MX", content: "10 route1.mx.cloudflare.net" },
      { name: "tyu.test", type: "TXT", content: "v=spf1 -all" },
    ])
    await seedRoot("tyu.test", { zoneId: "zone-tyu.test" })

    const row = (await listRoots()).rootDomains.find((d) => d.name === "tyu.test")!
    // 🔴 关键：MX/TXT **不算**顶点已接入 —— 它们承载邮件，不代表顶点能打开
    expect(row.apex).toBe("missing")
    expect(row.apexDetail).toBeNull()
  })

  it("顶点是走代理的占位记录 ⇒ ok（已接入）", async () => {
    seedZone("ok.test", [{ name: "ok.test", type: "AAAA", content: "100::" }])
    await seedRoot("ok.test", { zoneId: "zone-ok.test" })

    const row = (await listRoots()).rootDomains.find((d) => d.name === "ok.test")!
    expect(row.apex).toBe("ok")
    expect(row.apexDetail).toContain("100::")
    expect(row.apexDetail).toContain("已开代理")
  })

  it("顶点是灰云源站（doulor.cn 那种形态）⇒ no-proxy，且**不是**故障", async () => {
    // 站长自己的站点直出（实测线上 doulor.cn 顶点就是 A → 真实源站）。
    // 这一态必须与 missing 分开：它是正常形态，而给这种顶点塞一条代理占位记录，
    // 等于把站长的源站换成 Cloudflare 回源 —— 那才是真的会打坏东西。
    seedZone("origin.test", [
      { name: "origin.test", type: "A", content: "39.97.183.32", proxied: false },
    ])
    await seedRoot("origin.test", { zoneId: "zone-origin.test" })

    const row = (await listRoots()).rootDomains.find((d) => d.name === "origin.test")!
    expect(row.apex).toBe("no-proxy")
    expect(row.apexDetail).toContain("39.97.183.32")
  })

  it("顶点有走代理的记录（站点自己也上了 CF）⇒ ok", async () => {
    seedZone("cf.test", [{ name: "cf.test", type: "A", content: "203.0.113.9" }])
    await seedRoot("cf.test", { zoneId: "zone-cf.test" })

    const row = (await listRoots()).rootDomains.find((d) => d.name === "cf.test")!
    expect(row.apex).toBe("ok")
  })

  it("zone 解析不出来 ⇒ unknown，不瞎猜成 ok/missing", async () => {
    // 一个 zone 都不种 ⇒ resolveZoneId 拿不到 id ⇒ 探测不了，只能标 unknown
    await seedRoot("nozone.test")

    const row = (await listRoots()).rootDomains.find((d) => d.name === "nozone.test")!
    expect(row.apex).toBe("unknown")
  })

  it("导入**不会**顺手建顶点记录，但会把顶点现状回报出来", async () => {
    // 顶点指向哪里是「谁给这个域提供服务」的决定，属于 Worker 路由层，
    // 不是 DNS 批量导入能替站长决定的（详见 ensureWildcardRecord 的注释）。
    seedZone("apexless.test", [
      { name: "apexless.test", type: "MX", content: "10 route1.mx.cloudflare.net" },
    ])
    const res = await importAdminRootDomain(
      env,
      importReq(admin, { name: "apexless.test", zoneId: "zone-apexless.test" })
    )
    const body = (await res.json()) as {
      apex: { status: string; detail: string | null }
      steps: { step: string; state: string }[]
    }

    expect(body.apex.status).toBe("missing")
    expect(body.steps).toContainEqual({ step: "apex", state: "missing" })

    // 🔴 唯一的一条写操作必须是泛解析，**不能**多出一条顶点记录
    const creates = cfCalls.filter((c) => c.method === "POST")
    expect(creates.map((c) => (c.body as { name?: string }).name)).toEqual(["*.apexless.test"])
    expect(cfZones.get("apexless.test")!.records.map((r) => r.name)).toEqual([
      "apexless.test",
      "*.apexless.test",
    ])
  })
})

// ---------------------------------------------------------------------------
// 3. 路由层证据
// ---------------------------------------------------------------------------

/**
 * 上面所有用例都是**直接调 handler**，所以它们证明不了「这条路真的挂在 Worker 上」——
 * 而「handler 写得挺完整、index.ts 里没有路由」正是这个仓库踩过的坑
 * （见 test/deadcode-route-wiring.test.ts 的背景）。
 *
 * ⚠️ `check-api-paths.mjs` 只比**路径**、不比方法，所以下面这几条用真路由表再走一遍：
 *    方法写错、路径写成单数，都会在这里红。
 */
describe("新增路由真的接在 Worker 上（走 SELF.fetch，不直接调 handler）", () => {
  it("GET /api/admin/root-domains/cf-zones：200 + JSON，且候选来自 CF", async () => {
    seedZone("route1.test")
    const res = await fetchSelf(authRequest(admin, "/api/admin/root-domains/cf-zones"))
    expect(res.status).toBe(200)
    // 路由没接上时这里会是 text/html（静态站 SPA 兜底）—— 正是当初的故障形态
    expect(res.headers.get("content-type") ?? "").toContain("application/json")
    const body = await res.json<{ zones: { name: string }[] }>()
    expect(body.zones.map((z) => z.name)).toEqual(["route1.test"])
  })

  it("POST /api/admin/root-domains/import：登记 + 建泛解析一次到位（含年价）", async () => {
    seedZone("route2.test")
    const res = await fetchSelf(
      importReq(admin, { name: "route2.test", zoneId: "zone-route2.test", dnsPricePerYear: 7 })
    )
    expect(res.status).toBe(200)
    expect(await rootRow("route2.test")).toMatchObject({
      zone_id: "zone-route2.test",
      dns_price_per_year: 7,
    })
    expect(cfZones.get("route2.test")!.records.map((r) => r.name)).toEqual(["*.route2.test"])
  })

  it("POST /api/admin/root-domains/action（delete）：确认串不对回 400", async () => {
    await seedRoot("route3.test", { zoneId: "zone-route3.test" })
    const res = await fetchSelf(
      actionReq(admin, { action: "delete", name: "route3.test", confirm: "nope.test" })
    )
    expect(res.status).toBe(400)
    const body = await res.json<{ code: string }>()
    expect(body.code).toBe("CONFIRM_REQUIRED")
    expect(await rootRow("route3.test")).not.toBeNull()
  })

  it("普通用户打这些接口一律 403（不是 500、也不是 HTML 兜底）", async () => {
    const user = await makeUser()
    const res = await fetchSelf(authRequest(user, "/api/admin/root-domains/cf-zones"))
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// 4. 删除根域
// ---------------------------------------------------------------------------

describe("删除根域 —— 二次确认与「默认不动 CF」", () => {
  it("confirm 不匹配：拒绝（后端独立校验，不信任前端弹窗）", async () => {
    await seedRoot("gone.test", { zoneId: "zone-gone.test" })
    const err = await catchApiError(() =>
      rootDomainAction(
        env,
        actionReq(admin, { action: "delete", name: "gone.test", confirm: "wrong.test" })
      )
    )
    expect(err.status).toBe(400)
    expect(err.code).toBe("CONFIRM_REQUIRED")
    expect(await rootRow("gone.test")).not.toBeNull()
  })

  it("默认域不可删", async () => {
    await seedRoot("default.test", { isDefault: true })
    const err = await catchApiError(() =>
      rootDomainAction(
        env,
        actionReq(admin, { action: "delete", name: "default.test", confirm: "default.test" })
      )
    )
    expect(err.status).toBe(400)
    expect(err.code).toBe("IS_DEFAULT")
    expect(await rootRow("default.test")).not.toBeNull()
  })

  it("站点主域（env.ROOT_DOMAIN）不可删", async () => {
    await seedRoot("doulor.cn", { zoneId: "zone-doulor.cn" })
    const err = await catchApiError(() =>
      rootDomainAction(
        env,
        actionReq(admin, { action: "delete", name: "doulor.cn", confirm: "doulor.cn" })
      )
    )
    expect(err.status).toBe(400)
    expect(err.code).toBe("SITE_ROOT")
    expect(await rootRow("doulor.cn")).not.toBeNull()
  })

  it("正常删除：摘掉 dns_wildcard_roots、删表行，Cloudflare 记录**默认保留**", async () => {
    await seedRoot("gone.test", { zoneId: "zone-gone.test" })
    await setSetting("dns_wildcard_roots", "tyu.me,gone.test,doulor.cn")
    seedZone("gone.test", [
      { name: "*.gone.test", type: "AAAA", content: "100::" },
      { name: "gone.test", type: "MX", content: "10 mail.gone.test" },
    ])

    const res = await rootDomainAction(
      env,
      actionReq(admin, { action: "delete", name: "gone.test", confirm: "gone.test" })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { cf: unknown; usage: { records: number } }
    expect(body.cf).toBeNull()
    expect(body.usage.records).toBe(0)

    expect(await rootRow("gone.test")).toBeNull()
    // 摘除只影响它自己，其余顺序不变
    expect(await getSetting(env, "dns_wildcard_roots")).toBe("tyu.me,doulor.cn")
    // 一条都没动 CF
    expect(cfWrites()).toHaveLength(0)
  })

  it("显式 deleteCfRecords：删泛解析与 AAAA 占位，保留 MX / TXT", async () => {
    await seedRoot("big.test", { zoneId: "zone-big.test" })
    await setSetting("dns_wildcard_roots", "big.test")
    seedZone("big.test", [
      { name: "*.big.test", type: "AAAA", content: "100::" },
      { name: "sub.big.test", type: "AAAA", content: "100::" },
      { name: "big.test", type: "MX", content: "10 mail.big.test" },
      { name: "_dmarc.big.test", type: "TXT", content: "v=DMARC1; p=none" },
      // 站点范围之外的记录（同 zone 里站长自己的东西）绝不能碰
      { name: "other.example", type: "A", content: "203.0.113.99" },
    ])

    const res = await rootDomainAction(
      env,
      actionReq(admin, {
        action: "delete",
        name: "big.test",
        confirm: "big.test",
        deleteCfRecords: true,
      })
    )
    const body = (await res.json()) as {
      cf: { deleted: string[]; failed: string[]; kept: string[]; keptTotal: number }
    }

    expect(body.cf.deleted.sort()).toEqual(["AAAA *.big.test", "AAAA sub.big.test"])
    expect(body.cf.failed).toHaveLength(0)
    expect(body.cf.keptTotal).toBe(2)
    expect(body.cf.kept.join(" ")).toContain("MX big.test")
    expect(body.cf.kept.join(" ")).toContain("TXT _dmarc.big.test")

    // CF 侧真的只剩那三条非平台记录
    expect(cfZones.get("big.test")!.records.map((r) => `${r.type} ${r.name}`).sort()).toEqual([
      "A other.example",
      "MX big.test",
      "TXT _dmarc.big.test",
    ].sort())
    expect(await rootRow("big.test")).toBeNull()
  })

  it("CF 记录删不掉：中止删除，根域仍在（可重试），且报错说清「已删的不回滚」", async () => {
    await seedRoot("half.test", { zoneId: "zone-half.test" })
    await setSetting("dns_wildcard_roots", "half.test")
    seedZone("half.test", [
      { name: "*.half.test", type: "AAAA", content: "100::" },
      { name: "sub.half.test", type: "AAAA", content: "100::" },
    ])
    // 让第二条删除失败（第一条成功）——这正是「部分成功」这种最难解释的状态
    cfFailDelete = new Set(["rec-half.test-2"])

    const err = await catchApiError(() =>
      rootDomainAction(
        env,
        actionReq(admin, {
          action: "delete",
          name: "half.test",
          confirm: "half.test",
          deleteCfRecords: true,
        })
      )
    )
    expect(err.status).toBe(502)
    expect(err.code).toBe("CF_DELETE_FAILED")
    expect(err.message).toContain("不会回滚")

    // 数据库**没有**被改：根域还在、设置项还在 —— 站长修好后重试即可
    expect(await rootRow("half.test")).not.toBeNull()
    expect(await getSetting(env, "dns_wildcard_roots")).toBe("half.test")
  })
})
