/**
 * DNS 解析「积分租用」的两条主线（2026-10-14 改造）。
 *
 * 为什么单独钉这一套：
 *   ① 闸门从「权限位」变成了三档（权限位 / 免权限访问 / **有效租约**）。
 *      权限写反不会报错，只会静静地多放人或把付过钱的用户关在门外 ——
 *      而「我明明买了为什么不能用」是站长最常收到、也最难自证的一类投诉。
 *   ② 租约是**花钱**的东西：多扣、少扣、重复扣、到期没收回，
 *      四种错法都不会抛异常。扣分只走 applyPoints（原子 + dedup_key），
 *      这里用真实路由（miniflare SELF.fetch）端到端钉住它。
 *
 * 覆盖：
 *   · 无租约 ⇒ 403；买了 ⇒ 能建自己根域下的记录、不能建别家根域的
 *   · rootDomain 声明与子域名不一致 ⇒ 400（前端选择器与实际子域对不上时不许静默建）
 *   · doulor.cn（requires_feature）不能买、也不出现在可选项里
 *   · 权限位持有者不受租期影响
 *   · 到期：不能建、能删自己的、cron 能把状态翻正
 *   · 自动续费：够分就续、不够就关开关并写明原因
 *   · users.max_dns_records 的用户级覆盖
 *   · 管理端汇总与处置动作
 */
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
import { resetRootDomainCache } from "../src/root-domains"
import { expireAndAutoRenewDnsRentals } from "../src/handlers/dns-rental"

const CF = "https://api.cloudflare.com"

/** 显式没有 dns 权限 —— 与线上存量用户（迁移 0159 之后）同形 */
const WITHOUT_DNS = JSON.stringify({
  r2: true,
  ai: false,
  proxy: true,
  doulor: false,
  dns: false,
})

/** 显式有 dns 权限（管理员手工开通 / paji 那种） */
const WITH_DNS = JSON.stringify({
  r2: true,
  ai: false,
  proxy: true,
  doulor: false,
  dns: true,
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
 * 打桩 Cloudflare：只接管**写**请求（DNS 记录的增删改），其余回落真实 fetch。
 * 读请求（GET）在这里不会发生 —— 三个根域都带了 zone_id，不需要走 /zones 解析。
 */
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

interface Fixture {
  user: TestUser
  /** 主域名行（dns_records.domain_id 一律指它，见 handlers/dns.ts 的注释） */
  domainId: string
  /** '@' 主域名（fqdn = <username>.tyu.me） */
  primarySubId: string
  /** 7u.nz 下的一个普通子域名（name != '@'，根域由它自己决定） */
  nzSubId: string
  nzFqdn: string
}

/** 三个根域：tyu.me 200 / 7u.nz 500 / doulor.cn 0（要 doulor 权限，不售卖） */
async function seedRootDomains(): Promise<void> {
  const now = new Date().toISOString()
  const rows: [string, string, string | null, number][] = [
    // name, zone_id, requires_feature, yearPrice
    ["tyu.me", "zone-tyu", null, 200],
    ["7u.nz", "zone-7u", null, 500],
    ["doulor.cn", "zone-doulor", "doulor", 0],
  ]
  for (const [name, zone, feature, price] of rows) {
    const exists = await env.DB.prepare("SELECT name FROM root_domains WHERE name = ?")
      .bind(name)
      .first()
    if (exists) continue
    await env.DB.prepare(
      `INSERT INTO root_domains
         (name, zone_id, label, requires_feature, dns_price_per_year, is_default, enabled, created_at)
       VALUES (?, ?, NULL, ?, ?, 0, 1, ?)`
    )
      .bind(name, zone, feature, price, now)
      .run()
  }
  resetRootDomainCache()
}

/** 直接落库给余额（够买 500 的那档） */
async function givePoints(userId: string, balance: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO user_points (user_id, balance, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET balance = excluded.balance`
  )
    .bind(userId, balance, new Date().toISOString())
    .run()
}

/**
 * 造一个「无 dns 权限但有域名」的用户：主域名在 tyu.me，另有 7u.nz 下的子域名。
 *
 * 7u.nz 那个刻意用**非 '@'** 的名字：'@' 的 base 取的是 `domains.name`（用户主域名），
 * 只有普通子域名的 base 才是自己的 fqdn，这样才能测出「跨根域」被拦。
 */
async function makeUserWithDomains(perm = WITHOUT_DNS): Promise<Fixture> {
  const user = await makeUser()
  await setPermissions(user.id, perm)

  const now = new Date().toISOString()
  const primaryFqdn = `${user.username}.tyu.me`
  const nzFqdn = `blog.${user.username}.7u.nz`
  const domainId = uuid()
  const primarySubId = uuid()
  const nzSubId = uuid()

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
    ).bind(primarySubId, user.id, primaryFqdn, now),
    env.DB.prepare(
      `INSERT INTO subdomains (id, user_id, name, fqdn, status, created_at)
       VALUES (?, ?, 'blog', ?, 'active', ?)`
    ).bind(nzSubId, user.id, nzFqdn, now),
  ])

  return { user, domainId, primarySubId, nzSubId, nzFqdn }
}

/** 直接塞一条记录（比走接口快，也不受限流影响） */
async function seedRecord(fx: Fixture, subdomainId: string, fqdn: string): Promise<string> {
  const id = uuid()
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO dns_records
       (id, domain_id, subdomain_id, cf_id, name, fqdn, type, content, ttl, proxied,
        status, created_at, updated_at)
     VALUES (?, ?, ?, 'cf-x', '@', ?, 'A', '192.0.2.1', 1, 0, 'active', ?, ?)`
  )
    .bind(id, fx.domainId, subdomainId, fqdn, now, now)
    .run()
  return id
}

function buyRental(user: TestUser, rootDomain: string, requestId = crypto.randomUUID()) {
  return fetchSelf(
    authRequest(user, "/dns/rental/purchase", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rootDomain, requestId }),
    })
  )
}

function createRecord(
  user: TestUser,
  subdomainId: string,
  extra: Record<string, unknown> = {}
): Promise<Response> {
  return fetchSelf(
    authRequest(user, "/dns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subdomainId,
        name: "@",
        type: "A",
        content: "192.0.2.10",
        ...extra,
      }),
    })
  )
}

interface ErrorBody {
  code: string
  error?: string
}

async function balanceOf(userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT balance FROM user_points WHERE user_id = ?")
    .bind(userId)
    .first<{ balance: number }>()
  return Number(row?.balance ?? 0)
}

describe("DNS 租用：闸门与购买", () => {
  beforeEach(async () => {
    await seedRootDomains()
    // 租期固定 365 天 ⇒ 实收 = 年价（200 / 500），断言才不依赖默认值的变化
    await setSetting("dns_rental_days", "365")
  })

  it("没有权限、也没有租约 ⇒ 403 FEATURE_NOT_PERMITTED（读接口同样是闸）", async () => {
    const fx = await makeUserWithDomains()
    stubCloudflare()

    const list = await fetchSelf(authRequest(fx.user, "/api/dns"))
    expect(list.status).toBe(403)
    expect((await list.json<ErrorBody>()).code).toBe("FEATURE_NOT_PERMITTED")

    const created = await createRecord(fx.user, fx.primarySubId)
    expect(created.status).toBe(403)
    expect(cfCalls).toEqual([])

    // 租用面板本身必须能看（否则新用户无处可买）—— 且要如实说「你还没有额度」
    const panel = await fetchSelf(authRequest(fx.user, "/dns/rental"))
    expect(panel.status).toBe(200)
    const state = (await panel.json()) as {
      accessMode: string
      freeAccess: boolean
      rentalDays: number
      options: { name: string; usable: boolean; termPrice: number }[]
    }
    expect(state.accessMode).toBe("none")
    expect(state.freeAccess).toBe(false)
    expect(state.rentalDays).toBe(365)
    expect(state.options.find((o) => o.name === "tyu.me")?.usable).toBe(false)
    expect(state.options.find((o) => o.name === "tyu.me")?.termPrice).toBe(200)
  })

  it("买下 tyu.me ⇒ 扣 200 分、能建该根域下的记录，别家根域仍然不行", async () => {
    const fx = await makeUserWithDomains()
    await givePoints(fx.user.id, 1000)
    stubCloudflare()

    const bought = await buyRental(fx.user, "tyu.me")
    expect(bought.status).toBe(200)
    const receipt = (await bought.json()) as {
      pricePoints: number
      balance: number
      expiresAt: string
      rentalDays: number
    }
    expect(receipt.pricePoints).toBe(200)
    expect(receipt.balance).toBe(800)
    expect(receipt.rentalDays).toBe(365)

    // 自己租的根域：放行
    expect((await createRecord(fx.user, fx.primarySubId)).status).toBe(201)

    // 没租的根域：403（按**记录的根域**判，而不是「有没有买过」）
    const other = await createRecord(fx.user, fx.nzSubId)
    expect(other.status).toBe(403)
    expect((await other.json<ErrorBody>()).code).toBe("DNS_RENTAL_REQUIRED")

    const panel = await fetchSelf(authRequest(fx.user, "/dns/rental"))
    const state = (await panel.json()) as { accessMode: string }
    expect(state.accessMode).toBe("rented")
  })

  it("幂等：同一 requestId 只扣一次；已有有效租约时不能重复购买", async () => {
    const fx = await makeUserWithDomains()
    await givePoints(fx.user.id, 1000)

    const bought = await buyRental(fx.user, "tyu.me")
    expect(bought.status).toBe(200)

    // 已有有效租约 ⇒ 再买直接引导去续期（不是静默开第二份）
    const again = await buyRental(fx.user, "tyu.me")
    expect(again.status).toBe(409)
    expect((await again.json<ErrorBody>()).code).toBe("ALREADY_RENTED")

    const state = (await (await fetchSelf(authRequest(fx.user, "/dns/rental"))).json()) as {
      rentals: { id: string }[]
    }
    const id = state.rentals[0].id
    const rid = "req-renew-dup"
    const renew = (requestId: string) =>
      fetchSelf(
        authRequest(fx.user, "/dns/rental/renew", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, requestId }),
        })
      )

    // 1000 - 200(买) - 200(续) = 600
    expect((await renew(rid)).status).toBe(200)
    expect(await balanceOf(fx.user.id)).toBe(600)

    // 同一个 requestId 再来一次：dedup 命中 ⇒ 409，且分不再动
    const dup = await renew(rid)
    expect(dup.status).toBe(409)
    expect((await dup.json<ErrorBody>()).code).toBe("DUPLICATE_REQUEST")
    expect(await balanceOf(fx.user.id)).toBe(600)
  })

  it("积分不够 ⇒ 402，且不落租约", async () => {
    const fx = await makeUserWithDomains()
    await givePoints(fx.user.id, 10)

    const res = await buyRental(fx.user, "tyu.me")
    expect(res.status).toBe(402)
    expect((await res.json<ErrorBody>()).code).toBe("INSUFFICIENT_POINTS")

    const rows = await env.DB.prepare("SELECT COUNT(*) AS c FROM dns_rentals WHERE user_id = ?")
      .bind(fx.user.id)
      .first<{ c: number }>()
    expect(Number(rows?.c ?? 0)).toBe(0)
    expect(await balanceOf(fx.user.id)).toBe(10)
  })

  it("doulor.cn：不售卖、且没解锁 doulor 权限时不可选（后端也拒）", async () => {
    const fx = await makeUserWithDomains()
    await givePoints(fx.user.id, 1000)

    const panel = await fetchSelf(authRequest(fx.user, "/dns/rental"))
    const state = (await panel.json()) as {
      options: { name: string; permitted: boolean; forSale: boolean }[]
    }
    const doulor = state.options.find((o) => o.name === "doulor.cn")
    expect(doulor).toBeDefined()
    expect(doulor?.permitted).toBe(false)
    expect(doulor?.forSale).toBe(false)

    // 前端隐藏不算数：直接打接口也必须被权限闸挡住
    const res = await buyRental(fx.user, "doulor.cn")
    expect(res.status).toBe(403)
    expect((await res.json<ErrorBody>()).code).toBe("ROOT_DOMAIN_NOT_PERMITTED")
  })

  it("rootDomain 与子域名实际所属根域不一致 ⇒ 400（不许静默按子域名建）", async () => {
    const fx = await makeUserWithDomains()
    await givePoints(fx.user.id, 1000)
    stubCloudflare()
    await buyRental(fx.user, "tyu.me")

    // 子域名在 7u.nz 下，却声明 tyu.me
    const res = await createRecord(fx.user, fx.nzSubId, { rootDomain: "tyu.me" })
    expect(res.status).toBe(400)
    expect((await res.json<ErrorBody>()).code).toBe("ROOT_DOMAIN_MISMATCH")
    expect(cfCalls).toEqual([])
  })

  it("有 dns 权限位的用户不受租期影响（没有租约也能建任意根域）", async () => {
    const fx = await makeUserWithDomains(WITH_DNS)
    stubCloudflare()

    expect((await createRecord(fx.user, fx.nzSubId)).status).toBe(201)

    const panel = await fetchSelf(authRequest(fx.user, "/dns/rental"))
    const state = (await panel.json()) as { freeAccess: boolean; accessMode: string }
    expect(state.freeAccess).toBe(true)
    expect(state.accessMode).toBe("full")

    // 连价目表里的「可用」也要如实反映（前端据此不显示购买按钮）
    const options = (await (
      await fetchSelf(authRequest(fx.user, "/dns/rental"))
    ).json()) as { options: { name: string; usable: boolean }[] }
    expect(options.options.find((o) => o.name === "7u.nz")?.usable).toBe(true)
  })

  /**
   * 租期是设置项 `dns_rental_days`（2026-10-15 从硬编码常量改成可配）。
   *
   * 为什么必须钉「非法值时回落 365」：这个键走管理设置的**通用字符串分支**，
   * 没有数值校验，库里出现 ""/0/负数/非数字都是可能的。而空串是最容易踩的 ——
   * `Number("") === 0`，如果按「夹到下限 1 天」处理，用户付完积分拿到的就是
   * **隔天就到期**的租约（等于收钱不办事）。所以这里逐值钉住 365 天 + 实收仍等于年价。
   */
  it("租期非法值（空 / 0 / 负数 / 非数字）一律回落 365 天，不是「1 天当场到期」", async () => {
    const fx = await makeUserWithDomains()
    await givePoints(fx.user.id, 1000)
    stubCloudflare()

    for (const bad of ["", "0", "-7", "abc"]) {
      await setSetting("dns_rental_days", bad)

      const state = (await (await fetchSelf(authRequest(fx.user, "/dns/rental"))).json()) as {
        rentalDays: number
        options: { name: string; yearPrice: number; termPrice: number }[]
      }
      expect(state.rentalDays).toBe(365)
      // 实收也必须还是年价：不能因为设置项坏了就按「1 天」折算成 1 分
      const tyu = state.options.find((o) => o.name === "tyu.me")
      expect(tyu?.termPrice).toBe(tyu?.yearPrice)
    }

    // 只有上限是夹取：> 3650 天（≈10 年）按 3650 算，防「把 365 手滑打成 365000」
    await setSetting("dns_rental_days", "365000")
    const capped = (await (await fetchSelf(authRequest(fx.user, "/dns/rental"))).json()) as {
      rentalDays: number
    }
    expect(capped.rentalDays).toBe(3650)
  })

  /**
   * 租期改成**非 365 天**时，价格必须按天折算（2026-10-15 站长口径）：
   *   实收 = ceil(年价 × 天数 ÷ 365)，最小 1 分；到期日同样只推 N 天。
   *
   * 为什么专门钉「tyu.me 年价 200 + 30 天 ⇒ **17**」这一个数：
   *   · 直接拿年价扣 ⇒ 200（租 30 天收一年的钱，站长改租期的意义全没了）；
   *   · floor / round ⇒ 16（零头白送；年价再便宜一点就会算出 0 分白送一期）。
   *   17 恰好是 ceil 的答案，也是「向上取整」这条口径唯一的机器可验证据。
   */
  it("租期 30 天 ⇒ 按天折算收费（年价 200 ⇒ 17 分），到期日也只推 30 天", async () => {
    const fx = await makeUserWithDomains()
    await givePoints(fx.user.id, 1000)
    stubCloudflare()
    await setSetting("dns_rental_days", "30")

    const panel = (await (await fetchSelf(authRequest(fx.user, "/dns/rental"))).json()) as {
      rentalDays: number
      options: { name: string; yearPrice: number; termPrice: number }[]
    }
    // 面板要显示的两个数：当前租期 30 天、该根域本期实收 17 分（年价仍是 200）
    expect(panel.rentalDays).toBe(30)
    const tyu = panel.options.find((o) => o.name === "tyu.me")
    expect(tyu?.yearPrice).toBe(200)
    expect(tyu?.termPrice).toBe(17)

    const receipt = (await (await buyRental(fx.user, "tyu.me")).json()) as {
      pricePoints: number
      balance: number
      expiresAt: string
      rentalDays: number
    }
    expect(receipt.rentalDays).toBe(30)
    expect(receipt.pricePoints).toBe(17)
    expect(receipt.balance).toBe(983)
    // 到期时间只能是 30 天后（容 1 天误差：断言跨越了毫秒级的时间点）
    const days = (Date.parse(receipt.expiresAt) - Date.now()) / 86_400_000
    expect(Math.round(days)).toBe(30)
  })
})

describe("DNS 租用：到期与自动续费", () => {
  beforeEach(async () => {
    await seedRootDomains()
    await setSetting("dns_rental_days", "365")
  })

  it("到期后：不能再建、但仍然能删自己的记录（腾配额）", async () => {
    const fx = await makeUserWithDomains()
    await givePoints(fx.user.id, 1000)
    stubCloudflare()
    await buyRental(fx.user, "tyu.me")

    const recordId = await seedRecord(fx, fx.primarySubId, `${fx.user.username}.tyu.me`)
    // 手工把到期时间拨到过去
    await env.DB.prepare(
      "UPDATE dns_rentals SET expires_at = ? WHERE user_id = ?"
    )
      .bind(new Date(Date.now() - 86_400_000).toISOString(), fx.user.id)
      .run()

    const created = await createRecord(fx.user, fx.primarySubId)
    expect(created.status).toBe(403)
    expect((await created.json<ErrorBody>()).code).toBe("DNS_RENTAL_REQUIRED")

    // 列表仍然能看（否则用户根本看不到自己有哪些记录可以清理）
    expect((await fetchSelf(authRequest(fx.user, "/api/dns"))).status).toBe(200)

    const del = await fetchSelf(
      authRequest(fx.user, `/dns/${recordId}`, { method: "DELETE" })
    )
    expect(del.status).toBe(204)
  })

  it("cron 把已到期的 active 翻成 expired（状态要能被观测到）", async () => {
    const fx = await makeUserWithDomains()
    await givePoints(fx.user.id, 1000)
    await buyRental(fx.user, "tyu.me")
    await env.DB.prepare("UPDATE dns_rentals SET expires_at = ? WHERE user_id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), fx.user.id)
      .run()

    const out = await expireAndAutoRenewDnsRentals(env)
    expect(out.expired).toBeGreaterThanOrEqual(1)

    const row = await env.DB.prepare("SELECT status FROM dns_rentals WHERE user_id = ?")
      .bind(fx.user.id)
      .first<{ status: string }>()
    expect(row?.status).toBe("expired")
  })

  it("自动续费：到期前 24 小时内、积分够 ⇒ 自动续一期并扣费", async () => {
    const fx = await makeUserWithDomains()
    await givePoints(fx.user.id, 1000)
    await buyRental(fx.user, "tyu.me")
    // 开着自动续费 + 把到期时间推到窗口内
    const soon = new Date(Date.now() + 3600_000).toISOString()
    await env.DB.prepare(
      "UPDATE dns_rentals SET auto_renew = 1, expires_at = ? WHERE user_id = ?"
    )
      .bind(soon, fx.user.id)
      .run()

    const before = await balanceOf(fx.user.id)
    const out = await expireAndAutoRenewDnsRentals(env)
    expect(out.renewed).toBe(1)
    expect(await balanceOf(fx.user.id)).toBe(before - 200)

    const row = await env.DB.prepare(
      "SELECT expires_at, status, auto_renew FROM dns_rentals WHERE user_id = ?"
    )
      .bind(fx.user.id)
      .first<{ expires_at: string; status: string; auto_renew: number }>()
    expect(row?.status).toBe("active")
    expect(row?.auto_renew).toBe(1)
    // 从**原到期时间**顺延，而不是从现在 —— 否则 cron 延迟会把用户的时间吃掉
    expect(Date.parse(row!.expires_at)).toBeGreaterThan(Date.parse(soon))
  })

  it("自动续费：积分不够 ⇒ 关掉开关并把原因写进 last_error", async () => {
    const fx = await makeUserWithDomains()
    await givePoints(fx.user.id, 1000)
    await buyRental(fx.user, "tyu.me")
    const soon = new Date(Date.now() + 3600_000).toISOString()
    await env.DB.prepare(
      "UPDATE dns_rentals SET auto_renew = 1, expires_at = ? WHERE user_id = ?"
    )
      .bind(soon, fx.user.id)
      .run()
    // 把余额清空
    await env.DB.prepare("UPDATE user_points SET balance = 0 WHERE user_id = ?")
      .bind(fx.user.id)
      .run()

    const out = await expireAndAutoRenewDnsRentals(env)
    expect(out.insufficient).toBe(1)

    const row = await env.DB.prepare(
      "SELECT auto_renew, last_error FROM dns_rentals WHERE user_id = ?"
    )
      .bind(fx.user.id)
      .first<{ auto_renew: number; last_error: string | null }>()
    expect(row?.auto_renew).toBe(0)
    expect(row?.last_error ?? "").toContain("积分不足")
  })
})

describe("DNS 每用户上限：用户级覆盖", () => {
  beforeEach(async () => {
    await seedRootDomains()
    await setSetting("dns_rental_days", "365")
  })

  it("max_dns_records 覆盖全局设置（放宽与收紧都立刻生效）", async () => {
    const fx = await makeUserWithDomains(WITH_DNS)
    await setSetting("dns_records_per_user", "10")
    await seedRecord(fx, fx.primarySubId, `${fx.user.username}.tyu.me`)
    stubCloudflare()

    // 收紧到 1：已有 1 条 ⇒ 到顶
    await env.DB.prepare("UPDATE users SET max_dns_records = 1 WHERE id = ?")
      .bind(fx.user.id)
      .run()
    const blocked = await createRecord(fx.user, fx.primarySubId)
    expect(blocked.status).toBe(400)
    expect((await blocked.json<ErrorBody>()).code).toBe("DNS_RECORD_LIMIT")

    // 放宽到 3：同一个用户、同样 1 条 ⇒ 放行（证明确实读的是这一列）
    await env.DB.prepare("UPDATE users SET max_dns_records = 3 WHERE id = ?")
      .bind(fx.user.id)
      .run()
    expect((await createRecord(fx.user, fx.primarySubId)).status).toBe(201)
  })

  it("覆盖为空 ⇒ 回落全局设置（NULL 不是 0）", async () => {
    // 🔴 2026-10-17：持有 dns 权限位的用户**不再受每用户记录数上限约束**
    // （权限位 = 站长手动授权 = 信任）。所以要验「NULL 走全局设置」这条路，
    // 必须换成「靠有效租约放行」的用户，否则上限根本不会被走到。
    const fx = await makeUserWithDomains(WITHOUT_DNS)
    const nowIso = new Date().toISOString()
    const laterIso = new Date(Date.now() + 30 * 24 * 3600_000).toISOString()
    await env.DB.prepare(
      `INSERT INTO dns_rentals (id, user_id, root_domain, price_points, status, started_at, expires_at, created_at, updated_at)
       VALUES (?, ?, 'tyu.me', 0, 'active', ?, ?, ?, ?)`
    )
      .bind(uuid(), fx.user.id, nowIso, laterIso, nowIso, nowIso)
      .run()
    await setSetting("dns_records_per_user", "1")
    await seedRecord(fx, fx.primarySubId, `${fx.user.username}.tyu.me`)
    await env.DB.prepare("UPDATE users SET max_dns_records = NULL WHERE id = ?")
      .bind(fx.user.id)
      .run()
    stubCloudflare()

    const res = await createRecord(fx.user, fx.primarySubId)
    expect(res.status).toBe(400)
    expect((await createRecord(fx.user, fx.primarySubId)).status).toBe(400)

    // 反过来把全局放大，同一用户立刻放行 —— 说明 NULL 走的是全局那条路
    await setSetting("dns_records_per_user", "5")
    expect((await createRecord(fx.user, fx.primarySubId)).status).toBe(201)
  })
})

describe("管理端：根域与租用", () => {
  beforeEach(async () => {
    await seedRootDomains()
    await setSetting("dns_rental_days", "365")
  })

  it("列表给出根域定价/容量 + 用户维度 + 全局汇总", async () => {
    const admin = await makeUser({ role: "root" })
    const fx = await makeUserWithDomains()
    await givePoints(fx.user.id, 1000)
    await buyRental(fx.user, "tyu.me")

    const res = await fetchSelf(authRequest(admin, "/admin/dns/rentals"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      roots: { name: string; yearPrice: number; recordsLimit: number }[]
      users: { username: string; source: string; expiresAt: string | null }[]
      summary: { rentalsActive: number; cfZoneRecordLimit: number; byRoot: Record<string, number> }
    }

    const tyu = body.roots.find((r) => r.name === "tyu.me")
    expect(tyu?.yearPrice).toBe(200)
    // CF 每 zone 上限是常量（来源见 admin-dns.ts 的 CF_ZONE_RECORD_LIMIT 注释）
    expect(tyu?.recordsLimit).toBe(200)

    const row = body.users.find((u) => u.username === fx.user.username)
    expect(row?.source).toBe("rental")
    expect(row?.expiresAt).toBeTruthy()

    expect(body.summary.rentalsActive).toBeGreaterThanOrEqual(1)
    expect(body.summary.cfZoneRecordLimit).toBe(200)
    // 同一文件里的用例共享一个 D1，前面几个用例也建过 tyu.me 下的记录 ⇒ 只断言下界
    expect(body.summary.byRoot["tyu.me"]).toBeGreaterThanOrEqual(1)
  })

  it("管理面板的权限开关真的生效（PUT /admin/users/:username 的 permissions.dns）", async () => {
    // 这条钉的是「后台那个 dns 开关不是摆设」：admin.tsx 的 FEATURES 里
    // 勾选 dns ⇒ 走这个接口把 permissions.dns 写成 true ⇒ 用户立刻能用，
    // 而且**不需要任何租约**（权限位那条路不受租期影响）。
    const admin = await makeUser({ role: "root" })
    const target = await makeUser()
    await setPermissions(target.id, WITHOUT_DNS)

    const put = (permissions: Record<string, boolean>) =>
      fetchSelf(
        authRequest(admin, `/admin/users/${encodeURIComponent(target.username)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ permissions }),
        })
      )

    // 关着 ⇒ 403
    expect((await fetchSelf(authRequest(target, "/api/dns"))).status).toBe(403)

    expect(
      (
        await put({ r2: true, ai: false, proxy: true, doulor: false, dns: true })
      ).status
    ).toBe(200)

    const row = await env.DB.prepare("SELECT permissions FROM users WHERE id = ?")
      .bind(target.id)
      .first<{ permissions: string }>()
    expect(JSON.parse(row!.permissions).dns).toBe(true)

    // 同一个用户、没有任何 dns_rentals 行，却能读记录 —— 权限位这条路是通的
    const list = await fetchSelf(authRequest(target, "/api/dns"))
    expect(list.status).toBe(200)

    // 再关掉 ⇒ 立刻失效（开关是双向的）
    expect(
      (
        await put({ r2: true, ai: false, proxy: true, doulor: false, dns: false })
      ).status
    ).toBe(200)
    expect((await fetchSelf(authRequest(target, "/api/dns"))).status).toBe(403)
  })

  it("set-price / set-enabled / grant-permission / set-limit 都生效", async () => {
    const admin = await makeUser({ role: "root" })
    const target = await makeUser()

    const action = (payload: Record<string, unknown>) =>
      fetchSelf(
        authRequest(admin, "/admin/dns/rental-action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
      )

    expect((await action({ action: "set-price", name: "7u.nz", dnsPricePerYear: 600 })).status).toBe(200)
    const price = await env.DB.prepare(
      "SELECT dns_price_per_year FROM root_domains WHERE name = ?"
    )
      .bind("7u.nz")
      .first<{ dns_price_per_year: number }>()
    expect(price?.dns_price_per_year).toBe(600)

    expect((await action({ action: "set-enabled", name: "7u.nz", enabled: false })).status).toBe(200)
    const enabled = await env.DB.prepare("SELECT enabled FROM root_domains WHERE name = ?")
      .bind("7u.nz")
      .first<{ enabled: number }>()
    expect(enabled?.enabled).toBe(0)

    expect((await action({ action: "grant-permission", username: target.username })).status).toBe(200)
    const perms = await env.DB.prepare("SELECT permissions FROM users WHERE id = ?")
      .bind(target.id)
      .first<{ permissions: string }>()
    expect(JSON.parse(perms!.permissions).dns).toBe(true)

    expect((await action({ action: "set-limit", username: target.username, limit: 7 })).status).toBe(200)
    const limit = await env.DB.prepare("SELECT max_dns_records FROM users WHERE id = ?")
      .bind(target.id)
      .first<{ max_dns_records: number | null }>()
    expect(limit?.max_dns_records).toBe(7)

    // 传 null = 取消覆盖（而不是「上限 0」）
    expect((await action({ action: "set-limit", username: target.username, limit: null })).status).toBe(200)
    const cleared = await env.DB.prepare("SELECT max_dns_records FROM users WHERE id = ?")
      .bind(target.id)
      .first<{ max_dns_records: number | null }>()
    expect(cleared?.max_dns_records).toBeNull()

    expect((await action({ action: "revoke-permission", username: target.username })).status).toBe(200)
    const after = await env.DB.prepare("SELECT permissions FROM users WHERE id = ?")
      .bind(target.id)
      .first<{ permissions: string }>()
    expect(JSON.parse(after!.permissions).dns).toBe(false)
  })
})
