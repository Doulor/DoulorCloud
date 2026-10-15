/**
 * 「域名 → DNS 解析」页的访问口径 —— 记一次真实故障的回归（2026-10-16，用户 paji）。
 *
 * 故障现象：paji 打开该选项卡只看到「解析额度价目」卡片和「你的账号已开通 DNS 解析额度
 * （管理员授权或免权限访问）」横幅，**看不到记录列表，也看不到「添加记录」按钮**；
 * 而站长自己（ttest）在同一个页面能看到「批量添加 / 编辑 / 添加记录」。
 *
 * 根因在前端，而且是一个「少写一个枚举值」的经典事故：
 *   · 服务端 `dnsAccessFor` 的档位是**三档 + 过渡档**：`full`（权限位 / 免权限访问 /
 *     管理员）、`rented`、`expired`、`none`（见 worker/src/handlers/dns-rental.ts）；
 *   · 前端却把 `canManageDns` 写成
 *     `hasFreeDns || accessMode === "rented" || accessMode === "expired"` ——
 *     **漏掉 "full"**；同时价目面板的渲染条件是 `!hasFreeDns`（只认前端自己的快照）；
 *   · 于是「服务端说 full、前端的用户快照却是 false」的用户会同时拿到
 *     「价目表 + 已开通额度横幅」和「没有记录区」—— 正是上面那份现象。
 *
 *   快照为 false 而服务端为 full 是合法状态：`open_features` 把 dns 设成
 *   「免权限访问」，或 `/api/me` 还没回来 / 失败（useAuth 失败时把 user 置 null）。
 *
 * 两条判据现在抽成了纯函数 `src/lib/dns-access.ts`，这里逐个档位钉住；
 * 再用真实路由（miniflare SELF.fetch）钉住「服务端到底放不放行」那一半 ——
 * 两边合起来才是「用户真的能看到记录列表并且建得出来」的完整证据。
 *
 * ⚠️ 为什么前端的纯函数放在 worker 测试套件里跑：本仓**没有**前端测试运行器
 * （根 package.json 没有 vitest，src 下也没有 *.test.*）。该模块刻意不依赖
 * React / DOM / `@/` 路径别名，所以塞进这个既有的 miniflare 套件是零成本的，
 * 而且能保证它每次 CI 都被执行 —— 比为了三个纯函数再引一整套前端测试设施划算。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, setPermissions, type TestUser } from "./helpers"
import { uuid } from "../src/crypto"
import { resetRootDomainCache } from "../src/root-domains"
import { dnsAccessView, recordDomainChoices, usableDnsRoots } from "../../src/lib/dns-access"
import type { DnsAccessMode } from "../../src/lib/dns-access"
// 页面源码在**构建期**内联进来（见下面的「页面接线」用例为什么需要它）。
// 用 `?raw` 而不是 node:fs：workerd 的 fs shim 读不了仓库里的 Windows 路径
// （实测 `readFileSync(file:///D:/…)` 会被解析成 `/D:/…` 而报 no such file）。
import domainsSource from "../../src/pages/domains.tsx?raw"

/** 显式有 dns 权限位（管理员手工开通 —— paji 的线上形态） */
const WITH_DNS = JSON.stringify({
  r2: true,
  ai: true,
  proxy: true,
  doulor: false,
  dns: true,
})

/** 显式没有 dns 权限、也没有租约（新注册用户的形态） */
const WITHOUT_DNS = JSON.stringify({
  r2: true,
  ai: true,
  proxy: true,
  doulor: false,
  dns: false,
})

// ---------------------------------------------------------------- 纯函数部分

describe("DNS 解析页的访问口径（纯函数）", () => {
  /**
   * 这条就是 paji 的故障本身：服务端已经判为 full（免权限访问 / 权限位），
   * 而前端自己的快照（hasFreeDns）是 false。
   * 老代码下 canManage 会是 false（记录区整块不渲染）。
   */
  it("服务端 full + 前端快照没有权限位 ⇒ 仍然能看能写，并且不再显示价目表", () => {
    const view = dnsAccessView(false, "full")
    expect(view.mode).toBe("full")
    expect(view.canManage).toBe(true)
    expect(view.canWrite).toBe(true)
    // 有免费额度的人不该看到价目表与「已开通额度」横幅（否则就是他看到的那张卡片）
    expect(view.showRentalPanel).toBe(false)
  })

  it("有权限位（/api/me 快照为 true）⇒ 不等租用状态也是 full", () => {
    const view = dnsAccessView(true, null)
    expect(view.mode).toBe("full")
    expect(view.canManage).toBe(true)
    expect(view.canWrite).toBe(true)
    expect(view.showRentalPanel).toBe(false)
  })

  it("有有效租约 ⇒ 能看能写，但仍要显示价目表（买 200 的域不等于能用 500 的）", () => {
    const view = dnsAccessView(false, "rented")
    expect(view.canManage).toBe(true)
    expect(view.canWrite).toBe(true)
    expect(view.showRentalPanel).toBe(true)
  })

  it("只剩过期租约 ⇒ 只能看不能写（给用户留删除腾配额的出口）", () => {
    const view = dnsAccessView(false, "expired")
    expect(view.canManage).toBe(true)
    expect(view.canWrite).toBe(false)
    expect(view.showRentalPanel).toBe(true)
  })

  it("无权限无租约 ⇒ 全都不放行，且必须显示价目表（新用户得有购买入口）", () => {
    const view = dnsAccessView(false, "none")
    expect(view.mode).toBe("none")
    expect(view.canManage).toBe(false)
    expect(view.canWrite).toBe(false)
    expect(view.showRentalPanel).toBe(true)
  })

  it("租用状态还没拉到 / 请求失败（null / undefined）⇒ 按 none 处理，不乐观放行", () => {
    for (const missing of [null, undefined]) {
      const view = dnsAccessView(false, missing)
      expect(view.mode).toBe("none")
      expect(view.canManage).toBe(false)
      expect(view.canWrite).toBe(false)
    }
  })

  /**
   * 逐档位枚举：这条不是重复上面几个用例，而是**防止将来再加档位时重犯**——
   * paji 那次故障的本质就是「少写了一个档位分支」，而漏分支不会报错。
   */
  it("除 none 外每个档位都能看到记录区（漏一个档位 = 再犯一次 paji 的故障）", () => {
    const modes: DnsAccessMode[] = ["full", "rented", "expired", "none"]
    for (const mode of modes) {
      const view = dnsAccessView(false, mode)
      expect(view.canManage).toBe(mode !== "none")
      expect(view.canWrite).toBe(mode === "full" || mode === "rented")
      expect(view.showRentalPanel).toBe(mode !== "full")
    }
  })
})

describe("recordDomainChoices（新建记录的目标域名推导）", () => {
  const TYU = { name: "tyu.me" }
  const NZ = { name: "7u.nz" }

  /**
   * paji 在线上**真实**的数据形态（2026-10-16 查过 D1）：
   *   subdomains: paji.tyu.me（name='@'）、pji.tyu.me（parent_id=NULL）
   *   可用根域: tyu.me、7u.nz（doulor.cn 需要 doulor 权限，被后端筛掉）
   * 结论：可选目标**不是**空的，两条都落在 tyu.me 下 ——
   * 所以「recordDomainChoices 为空」**不是**他看不到创建入口的原因。
   */
  it("paji 的真实数据形态：@ 主域名与普通子域名都算可选目标", () => {
    const choices = recordDomainChoices(
      [
        { id: "s1", fqdn: "paji.tyu.me" },
        { id: "s2", fqdn: "pji.tyu.me" },
      ],
      [TYU, NZ]
    )
    expect(choices).toEqual([
      { id: "s1", fqdn: "paji.tyu.me", root: "tyu.me" },
      { id: "s2", fqdn: "pji.tyu.me", root: "tyu.me" },
    ])
  })

  /**
   * 这个推导**确实可能是空的**，而且是线上真实存在的形态（ttest 名下就有一个
   * `testttt.7u.nz`，而租用是**按根域**卖的）：只租了 tyu.me 的人，
   * 7u.nz 下的子域名不算可选目标。
   * 后果是「添加记录 / 批量添加」按钮变 disabled（**不是**消失）——
   * 记录区照常渲染，历史记录仍然看得见、删得掉。
   */
  it("名下子域名都不在当前可用根域之下 ⇒ 返回空数组（按钮 disabled，不是藏起来）", () => {
    const choices = recordDomainChoices([{ id: "n1", fqdn: "blog.x.7u.nz" }], [TYU])
    expect(choices).toEqual([])
  })

  it("根域按**标签**后缀匹配：不会把 x.7u.nz 误判成 u.nz", () => {
    const choices = recordDomainChoices(
      [{ id: "n1", fqdn: "blog.x.7u.nz" }],
      [{ name: "u.nz" }, NZ]
    )
    expect(choices).toEqual([{ id: "n1", fqdn: "blog.x.7u.nz", root: "7u.nz" }])
  })

  it("大小写不敏感（fqdn 与根域都可能带大写）", () => {
    const choices = recordDomainChoices([{ id: "a", fqdn: "Blog.Paji.TYU.ME" }], [TYU])
    expect(choices).toEqual([{ id: "a", fqdn: "Blog.Paji.TYU.ME", root: "tyu.me" }])
  })

  it("usableDnsRoots：full ⇒ 后端下发的全部根域；租用 ⇒ 只留 usable 的那些", () => {
    const rentalOptions = [
      { name: "tyu.me", label: "tyu.me", usable: true },
      { name: "7u.nz", label: "7u.nz", usable: false },
    ]
    expect(usableDnsRoots(true, [TYU, NZ], rentalOptions)).toEqual([
      { name: "tyu.me", label: "tyu.me" },
      { name: "7u.nz", label: "7u.nz" },
    ])
    expect(usableDnsRoots(false, [TYU, NZ], rentalOptions)).toEqual([
      { name: "tyu.me", label: "tyu.me" },
    ])
  })
})

// ---------------------------------------------------------------- 路由部分

const CF = "https://api.cloudflare.com"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

let cfCalls: string[] = []
let restores: Array<() => void> = []

/** 打桩 Cloudflare：只接管**写**请求（建记录），读请求不会发生（zone_id 已在库里） */
function stubCloudflare(): void {
  const original = globalThis.fetch
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? "GET").toUpperCase()
    if (url.startsWith(CF) && method !== "GET") {
      cfCalls.push(`${method} ${url}`)
      return jsonResponse({ success: true, result: { id: "cf-rec-1" } })
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

/**
 * 两个根域：tyu.me（有 zone_id，可建记录）与 7u.nz。
 *
 * 与 dns-rental.test.ts 同样的「有则跳过」写法：整个套件共享一个本地 D1，
 * 直接 INSERT 会撞主键。
 */
async function seedRootDomains(): Promise<void> {
  const now = new Date().toISOString()
  for (const [name, zone] of [
    ["tyu.me", "zone-tyu"],
    ["7u.nz", "zone-7u"],
  ] as const) {
    const exists = await env.DB.prepare("SELECT name FROM root_domains WHERE name = ?")
      .bind(name)
      .first()
    if (exists) continue
    await env.DB.prepare(
      `INSERT INTO root_domains
         (name, zone_id, label, requires_feature, dns_price_per_year, is_default, enabled, created_at)
       VALUES (?, ?, NULL, NULL, 200, 0, 1, ?)`
    )
      .bind(name, zone, now)
      .run()
  }
  resetRootDomainCache()
}

interface Fixture {
  user: TestUser
  /** '@' 主域名那一行的 id（记录默认挂它） */
  subId: string
  /** 事先存在的那条记录（用来证明「记录列表看得见」） */
  recordId: string
}

/**
 * 造一个「有域名、有子域名、已有一条解析记录」的用户 —— 即 paji 的线上形态
 * （`<用户名>.tyu.me` 是 '@' 主域名，另有一个普通子域名）。
 */
async function makeDnsUser(permissions: string): Promise<Fixture> {
  const user = await makeUser()
  await setPermissions(user.id, permissions)

  const now = new Date().toISOString()
  const primaryFqdn = `${user.username}.tyu.me`
  const domainId = uuid()
  const subId = uuid()
  const recordId = uuid()

  await env.DB.prepare(
    `INSERT INTO domains (id, user_id, name, zone_id, status, created_at)
     VALUES (?, ?, ?, 'zone-tyu', 'active', ?)`
  )
    .bind(domainId, user.id, primaryFqdn, now)
    .run()

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO subdomains (id, user_id, name, fqdn, status, created_at)
       VALUES (?, ?, '@', ?, 'active', ?)`
    ).bind(subId, user.id, primaryFqdn, now),
    env.DB.prepare(
      `INSERT INTO subdomains (id, user_id, name, fqdn, status, created_at)
       VALUES (?, ?, 'pji', ?, 'active', ?)`
    ).bind(uuid(), user.id, `pji.${primaryFqdn}`, now),
  ])

  await env.DB.prepare(
    `INSERT INTO dns_records
       (id, domain_id, subdomain_id, cf_id, name, fqdn, type, content, ttl, proxied,
        status, created_at, updated_at)
     VALUES (?, ?, ?, 'cf-x', '@', ?, 'A', '192.0.2.1', 1, 0, 'active', ?, ?)`
  )
    .bind(recordId, domainId, subId, primaryFqdn, now, now)
    .run()

  return { user, subId, recordId }
}

function createRecord(user: TestUser, subdomainId: string, extra: Record<string, unknown> = {}) {
  return fetchSelf(
    authRequest(user, "/dns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subdomainId,
        rootDomain: "tyu.me",
        name: "www",
        type: "A",
        content: "192.0.2.10",
        ...extra,
      }),
    })
  )
}

describe("DNS 解析的闸门（真实路由）", () => {
  beforeEach(async () => {
    await seedRootDomains()
  })

  /**
   * paji 的完整链路：有 dns 权限位、**一条租约都没有**。
   * 这条用例同时钉住「/api/me 里的 permissions.dns」—— 前端 hasFreeDns 的唯一来源；
   * 它一旦丢失，前端就会退回「只认租约」的老路（见文件头的故障说明）。
   */
  it("有 dns 权限位但无租约 ⇒ /me 带权限位、记录看得见、也建得出来（面板判为 full）", async () => {
    const fx = await makeDnsUser(WITH_DNS)
    stubCloudflare()

    const me = await fetchSelf(authRequest(fx.user, "/api/me"))
    expect(me.status).toBe(200)
    const meBody = await me.json<{ user: { permissions: { dns: boolean } } }>()
    expect(meBody.user.permissions.dns).toBe(true)

    const list = await fetchSelf(authRequest(fx.user, "/api/dns"))
    expect(list.status).toBe(200)
    const listed = await list.json<{ records: { id: string }[]; dnsUsage: { used: number } }>()
    expect(listed.records.map((r) => r.id)).toContain(fx.recordId)
    expect(listed.dnsUsage.used).toBe(1)

    const created = await createRecord(fx.user, fx.subId)
    expect(created.status).toBe(201)
    expect(cfCalls.length).toBe(1)

    // 前端那一侧：服务端给的是 full ⇒ 记录区必须渲染、价目表必须不渲染
    const rental = await fetchSelf(authRequest(fx.user, "/dns/rental"))
    expect(rental.status).toBe(200)
    const state = await rental.json<{
      accessMode: DnsAccessMode
      freeAccess: boolean
      options: { name: string; usable: boolean }[]
    }>()
    expect(state.accessMode).toBe("full")
    expect(state.freeAccess).toBe(true)
    expect(state.options.find((o) => o.name === "tyu.me")?.usable).toBe(true)

    const view = dnsAccessView(meBody.user.permissions.dns, state.accessMode)
    expect(view.canManage).toBe(true)
    expect(view.canWrite).toBe(true)
    expect(view.showRentalPanel).toBe(false)
  })

  /** 反向：两条路都没有的人仍然被挡在门外（读、写都 403），并且必须能看到价目表 */
  it("无权限也无租约 ⇒ 读/建都 403，前端显示价目表且不渲染记录区", async () => {
    const fx = await makeDnsUser(WITHOUT_DNS)
    stubCloudflare()

    const list = await fetchSelf(authRequest(fx.user, "/api/dns"))
    expect(list.status).toBe(403)
    expect((await list.json<{ code: string }>()).code).toBe("FEATURE_NOT_PERMITTED")

    const created = await createRecord(fx.user, fx.subId)
    expect(created.status).toBe(403)
    expect(cfCalls).toEqual([])

    const rental = await fetchSelf(authRequest(fx.user, "/dns/rental"))
    expect(rental.status).toBe(200)
    const state = await rental.json<{ accessMode: DnsAccessMode; freeAccess: boolean }>()
    expect(state.accessMode).toBe("none")
    expect(state.freeAccess).toBe(false)

    const view = dnsAccessView(false, state.accessMode)
    expect(view.canManage).toBe(false)
    expect(view.showRentalPanel).toBe(true)
  })

  /**
   * 「免权限访问」（app_settings.open_features 含 dns）这条路：用户**没有** dns 权限位，
   * 服务端却判为 full —— 正是前端快照与服务端会分叉的那种状态，
   * 也是老代码把整块记录区藏掉的那一类账号。
   */
  it("免权限访问开着 dns ⇒ 无权限位的人也被服务端判为 full（前端必须照样放行）", async () => {
    const fx = await makeDnsUser(WITHOUT_DNS)
    stubCloudflare()
    await env.DB.prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('open_features', 'dns', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
      .bind(new Date().toISOString())
      .run()

    try {
      const me = await fetchSelf(authRequest(fx.user, "/api/me"))
      const meBody = await me.json<{ user: { permissions: { dns: boolean } } }>()
      // 权限位仍然是 false —— 前端快照与服务端在这一刻必然分叉
      expect(meBody.user.permissions.dns).toBe(false)

      expect((await fetchSelf(authRequest(fx.user, "/api/dns"))).status).toBe(200)
      expect((await createRecord(fx.user, fx.subId)).status).toBe(201)

      const state = (await (await fetchSelf(authRequest(fx.user, "/dns/rental"))).json()) as {
        accessMode: DnsAccessMode
      }
      expect(state.accessMode).toBe("full")

      // 这正是老代码翻车的地方：hasFreeDns=false 而 accessMode=full
      const view = dnsAccessView(meBody.user.permissions.dns, state.accessMode)
      expect(view.canManage).toBe(true)
      expect(view.showRentalPanel).toBe(false)
    } finally {
      // 全局设置是共享的：用完必须清掉，否则同一个 D1 上的其它用例会被放行
      await env.DB.prepare("DELETE FROM app_settings WHERE key = 'open_features'").run()
    }
  })
})

// ---------------------------------------------------------------- 页面接线部分

/** 先删行注释、再删块注释（与 worker/scripts/check-*.mjs 同一套做法），保持行号 */
function stripComments(text: string): string {
  return text
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
}

/**
 * 为什么纯函数 + 路由两组用例还不够，必须再读一次源码：
 * 它们证明的是「判据算得对」与「服务端放不放行」，却**证明不了页面用了这套判据** ——
 * 把 domains.tsx 改回
 *   `canManageDns = hasFreeDns || accessMode === "rented" || accessMode === "expired"`、
 * 价目表判据改回 `!hasFreeDns`，前两组照样全绿，而 paji 的故障会原样复现。
 * 这一页的三处判据（记录区 / 写权限 / 价目表）就是这次故障的现场，钉住接线才算修完。
 */
describe("pages/domains.tsx 的接线（防止判据被写回去）", () => {
  const code = stripComments(domainsSource)

  it("记录区与价目表都由 lib/dns-access 的推导驱动", () => {
    expect(code).toContain('from "@/lib/dns-access"')
    expect(code).toContain("dnsAccessView(hasFreeDns, dnsRental?.accessMode)")
    // 两个能力直接取 view 的结论，不在页面里另写一套枚举判断
    expect(code).toContain("const canManageDns = access.canManage")
    expect(code).toContain("const canWriteDns = access.canWrite")
    // 价目表：档位非 full 才显示（老代码是 `!hasFreeDns` —— 只看前端快照，
    // 于是免权限访问的用户一边看「已开通额度」横幅、一边被藏掉记录区）
    expect(code).toContain("{(access.showRentalPanel || hasRentalsToManage) && (")
    expect(code).not.toContain("{!hasFreeDns && (")
    // 页面里不该再出现手写的档位枚举（"full" 就是当初被漏掉的那一档）
    expect(code).not.toContain("dnsAccessMode")
  })
})
