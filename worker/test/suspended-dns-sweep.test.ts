/**
 * 封禁用户的 DNS 停用必须闭环（issue #50）。
 *
 * 缺陷：`suspendUserResources` 标记记录时**同一条 UPDATE 里把 `cf_id` 清 NULL**，
 * 而兜底任务 `sweepSuspendedDns` 的筛选条件是 `banned_at IS NOT NULL AND cf_id IS NOT NULL`
 * ⇒ 恒为空集，兜底从来没删过任何一条。真正残留的两批都停在 `banned_at IS NULL`：
 *   · 延迟批：记录数超过 SUSPEND_BATCH(40)，slice 之外的那批从未被标记；
 *   · 失败批：CF 删除报错时按「先删 CF 再标记」的顺序直接 return，从未标记。
 *
 * 这里全部走**真实 HTTP 路由**（PUT /api/admin/users/:username）而不是直接调函数，
 * 以证明「管理员在界面上点封禁」这条路径真实可达。
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, type TestUser } from "./helpers"

const restores: Array<() => void> = []

/** 打桩 CF：可控「删除成功 / 删除失败」，并记录删除 / 创建调用次数 */
let cfDeleteCalls = 0
/** 重建（POST）次数 —— 解封方向的反向守护要用 */
let cfCreateCalls = 0
let cfDeleteShouldFail = false

function stubCloudflare(): void {
  const original = globalThis.fetch
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.includes("api.cloudflare.com")) {
      const method = (init?.method ?? "GET").toUpperCase()
      if (method === "POST") cfCreateCalls += 1
      if (method === "DELETE") {
        cfDeleteCalls += 1
        if (cfDeleteShouldFail) {
          return new Response(
            JSON.stringify({ success: false, errors: [{ code: 1000, message: "probe forced failure" }] }),
            { status: 500, headers: { "Content-Type": "application/json" } }
          )
        }
      }
      return new Response(
        JSON.stringify({ success: true, result: { id: `cf-${Math.random().toString(36).slice(2, 8)}` } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    }
    return original(input as RequestInfo, init)
  }) as unknown as typeof fetch
  globalThis.fetch = stub
  restores.push(() => {
    globalThis.fetch = original
  })
}

afterEach(() => {
  while (restores.length) restores.pop()?.()
  cfDeleteCalls = 0
  cfCreateCalls = 0
  cfDeleteShouldFail = false
})

beforeEach(async () => {
  cfDeleteCalls = 0
  cfCreateCalls = 0
  cfDeleteShouldFail = false
})

/** 造一个用户 + n 条挂在同一 zone 下的 DNS 记录 */
async function seedUserWithRecords(n: number) {
  const user = await makeUser({})
  const now = new Date().toISOString()
  const domainId = crypto.randomUUID()
  const subId = crypto.randomUUID()
  const root = `probe-${crypto.randomUUID().slice(0, 8)}.test`
  await env.DB.prepare(
    "INSERT INTO domains (id, user_id, name, zone_id, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)"
  )
    .bind(domainId, user.id, root, "probe-zone", now)
    .run()
  await env.DB.prepare(
    "INSERT INTO subdomains (id, user_id, name, fqdn, status, created_at) VALUES (?, ?, '@', ?, 'active', ?)"
  )
    .bind(subId, user.id, root, now)
    .run()
  const stmts = []
  for (let i = 0; i < n; i++) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO dns_records
           (id, domain_id, subdomain_id, cf_id, name, fqdn, type, content, ttl, proxied, status, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'A', ?, 1, 0, 'active', 'web', ?, ?)`
      ).bind(
        crypto.randomUUID(),
        domainId,
        subId,
        `cf-orig-${i}`,
        `h${i}`,
        `h${i}.${root}`,
        `10.0.0.${i % 255}`,
        now,
        now
      )
    )
  }
  await env.DB.batch(stmts)
  return { user, domainId, subId, root }
}

/** 该用户所有记录的封禁/残留统计 */
async function snapshot(userId: string) {  const rows = await env.DB.prepare(
    "SELECT cf_id, banned_at FROM dns_records WHERE domain_id IN (SELECT id FROM domains WHERE user_id = ?)"
  )
    .bind(userId)
    .all<{ cf_id: string | null; banned_at: string | null }>()
  const all = rows.results ?? []
  return {
    total: all.length,
    banned: all.filter((r) => r.banned_at !== null).length,
    /** CF 上可能还在的（没标记 + cf_id 还在）—— 正是封禁要拦的那批 */
    stillOnCf: all.filter((r) => r.banned_at === null && r.cf_id !== null).length,
  }
}

/**
 * 全库「仍挂在 CF 上」的条数 —— 与 sweep / dry-run 的筛选口径逐字一致。
 *
 * ⚠️ sweep 的候选集是**全站**的（筛选里没有 user 维度），所以断言 dry-run 报告值
 * 时只能用这个全库口径，不能拿单个用户的 snapshot 去比：测试文件共享同一个 D1，
 * 前序用例留下的残留会被一起计入（`-t` 过滤掉「擦地」用例时就会暴露）。
 */
async function stillOnCfGlobal() {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM dns_records r
      WHERE r.cf_id IS NOT NULL
        AND (r.subdomain_id IN (SELECT id FROM subdomains
                                 WHERE user_id IN (SELECT id FROM users WHERE status = 'suspended'))
             OR r.domain_id IN (SELECT id FROM domains
                                 WHERE user_id IN (SELECT id FROM users WHERE status = 'suspended')))`
  ).first<{ c: number }>()
  return Number(row?.c ?? 0)
}

/** 把该用户的记录收干净（解封 + 跑兜底），避免污染后续用例的全库计数 */
async function cleanupUser(admin: { username: string }, username: string) {
  await fetchSelf(
    authRequest(admin as never, `/api/admin/users/${encodeURIComponent(username)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    })
  )
  await sweepRounds(3)
}

async function suspendViaRoute(admin: { username: string }, username: string) {
  return fetchSelf(
    authRequest(admin as never, `/api/admin/users/${encodeURIComponent(username)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "suspended", suspendReason: "测试封禁" }),
    })
  )
}

async function sweepRounds(rounds: number, limit = 40) {
  const { sweepSuspendedDns } = await import("../src/user-suspension")
  let removed = 0
  const errors: string[] = []
  for (let i = 0; i < rounds; i++) {
    const r = await sweepSuspendedDns(env, limit)
    removed += r.removed
    errors.push(...r.errors)
  }
  return { removed, errors }
}

/**
 * 造「用户 + '@' 主域 + 二级子域名 blog」三件套，记录挂在 blog 下。
 *
 * 为什么必须用二级子域名：转移场景只在**二级**子域名上真实发生 ——
 * '@' 主域被 `admin-subdomains.ts` 明确保护（主域名不可删除 / 转移语义不同）。
 */
async function seedWithBlog(n: number) {
  const user = await makeUser({})
  const now = new Date().toISOString()
  const domainId = crypto.randomUUID()
  const rootSubId = crypto.randomUUID()
  const blogId = crypto.randomUUID()
  const root = `probe-${crypto.randomUUID().slice(0, 8)}.test`
  await env.DB.prepare(
    "INSERT INTO domains (id, user_id, name, zone_id, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)"
  )
    .bind(domainId, user.id, root, "probe-zone", now)
    .run()
  await env.DB.prepare(
    "INSERT INTO subdomains (id, user_id, name, fqdn, status, created_at) VALUES (?, ?, '@', ?, 'active', ?)"
  )
    .bind(rootSubId, user.id, root, now)
    .run()
  await env.DB.prepare(
    "INSERT INTO subdomains (id, user_id, name, fqdn, status, created_at) VALUES (?, ?, 'blog', ?, 'active', ?)"
  )
    .bind(blogId, user.id, `blog.${root}`, now)
    .run()
  const stmts = []
  for (let i = 0; i < n; i++) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO dns_records
           (id, domain_id, subdomain_id, cf_id, name, fqdn, type, content, ttl, proxied, status, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'A', ?, 1, 0, 'active', 'web', ?, ?)`
      ).bind(
        crypto.randomUUID(),
        domainId,
        blogId,
        `cf-blog-${i}`,
        `h${i}`,
        `h${i}.blog.${root}`,
        `10.0.0.${i}`,
        now,
        now
      )
    )
  }
  await env.DB.batch(stmts)
  return { user, domainId, rootSubId, blogId, root }
}

/** 把 blog 子域名转给另一个用户（走真实管理路由；只改 subdomains.user_id） */
async function transferSubdomain(admin: TestUser, subId: string, toUserId: string) {
  return fetchSelf(
    authRequest(admin, `/api/admin/subdomains/${subId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: toUserId }),
    })
  )
}

/** blog 下记录的封禁/在 CF 统计 */
async function blogSnapshot(blogId: string) {
  const rows = await env.DB.prepare("SELECT cf_id, banned_at FROM dns_records WHERE subdomain_id = ?")
    .bind(blogId)
    .all<{ cf_id: string | null; banned_at: string | null }>()
  const all = rows.results ?? []
  return {
    total: all.length,
    banned: all.filter((r) => r.banned_at !== null).length,
    withCf: all.filter((r) => r.cf_id !== null).length,
  }
}

describe("封禁 DNS 停用闭环（issue #50）", () => {
  it("记录数超过单批上限：延迟批必须被维护任务接住（封禁后不能有记录留在 CF 上）", async () => {
    stubCloudflare()
    const admin = await makeUser({ role: "superadmin" })
    const { user } = await seedUserWithRecords(45)

    const res = await suspendViaRoute(admin, user.username)
    expect(res.status).toBe(200)

    // 单批 40 条 ⇒ 首跳只处理 40 条，另 5 条是延迟批
    const afterSuspend = await snapshot(user.id)
    expect(afterSuspend.total).toBe(45)
    expect(afterSuspend.banned).toBe(40)
    expect(afterSuspend.stillOnCf).toBe(5)

    // 兜底任务必须把这 5 条收干净
    const { removed } = await sweepRounds(3)
    const afterSweep = await snapshot(user.id)

    expect(removed).toBeGreaterThan(0)
    expect(afterSweep.stillOnCf).toBe(0)
    expect(afterSweep.banned).toBe(45)
  })

  it("CF 删除失败那批：恢复后必须被维护任务捞回", async () => {
    stubCloudflare()
    const admin = await makeUser({ role: "superadmin" })
    const { user } = await seedUserWithRecords(5)

    // 第一次封禁时 CF 全挂 ⇒ 5 条一条都没标记（走的是「先删 CF 再标记」的 return 分支）
    cfDeleteShouldFail = true
    const res = await suspendViaRoute(admin, user.username)
    expect(res.status).toBe(200)
    const afterFail = await snapshot(user.id)
    expect(afterFail.banned).toBe(0)
    expect(afterFail.stillOnCf).toBe(5)

    // CF 恢复后，维护任务必须把这批补删
    cfDeleteShouldFail = false
    const { removed } = await sweepRounds(3)
    const afterSweep = await snapshot(user.id)

    expect(removed).toBeGreaterThan(0)
    expect(afterSweep.stillOnCf).toBe(0)
  })

  it("残留被清理后必须补上 banned_at（否则解封时不会重建 = 幽灵行）", async () => {
    stubCloudflare()
    const admin = await makeUser({ role: "superadmin" })
    const { user } = await seedUserWithRecords(45)

    await suspendViaRoute(admin, user.username)
    await sweepRounds(3)

    const after = await snapshot(user.id)
    // 兜底删掉的那 5 条也要有 banned_at：用户端列表按 banned_at IS NULL 过滤，
    // 解封时按 banned_at IS NOT NULL 重建 —— 缺标记会造出「本地正常、CF 上没有」
    expect(after.banned).toBe(45)
    expect(after.stillOnCf).toBe(0)

    // 解封后必须全部重建回 CF（cf_id 重新有值、banned_at 清空）
    const back = await fetchSelf(
      authRequest(admin as never, `/api/admin/users/${encodeURIComponent(user.username)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      })
    )
    expect(back.status).toBe(200)
    const restored = await snapshot(user.id)
    expect(restored.banned).toBe(0)
    expect(restored.stillOnCf).toBe(45)
  })

  it("反向守护：未封禁用户的记录绝不能被兜底删掉", async () => {
    stubCloudflare()
    await makeUser({ role: "superadmin" })
    const { user } = await seedUserWithRecords(5)

    // 不封禁，直接跑兜底
    const before = cfDeleteCalls
    const { removed } = await sweepRounds(3)

    expect(removed).toBe(0)
    expect(cfDeleteCalls).toBe(before)
    const after = await snapshot(user.id)
    expect(after.stillOnCf).toBe(5)
    expect(after.banned).toBe(0)
  })

  it("反向守护：已解封用户的记录不能被兜底误删", async () => {
    stubCloudflare()
    const admin = await makeUser({ role: "superadmin" })
    const { user } = await seedUserWithRecords(5)

    // 封禁 → 立刻解封（记录已重建回 CF）
    await suspendViaRoute(admin, user.username)
    await fetchSelf(
      authRequest(admin as never, `/api/admin/users/${encodeURIComponent(user.username)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      })
    )
    const mid = await snapshot(user.id)
    expect(mid.stillOnCf).toBe(5)

    const { removed } = await sweepRounds(3)
    expect(removed).toBe(0)
    const after = await snapshot(user.id)
    expect(after.stillOnCf).toBe(5)
    expect(after.banned).toBe(0)
  })

  it("兜底删除时 CF 报错：必须记进 errors，且不误清 cf_id", async () => {
    stubCloudflare()
    const admin = await makeUser({ role: "superadmin" })
    const { user } = await seedUserWithRecords(45)

    await suspendViaRoute(admin, user.username)

    cfDeleteShouldFail = true
    const { errors } = await sweepRounds(1)
    expect(errors.length).toBeGreaterThan(0)

    // 删失败的行必须保留 cf_id，否则下次再也捞不回来
    const after = await snapshot(user.id)
    expect(after.stillOnCf).toBe(5)
  })

  it("「记录本来就不在」类报错按幂等成功处理（不能卡住整批）", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const { user } = await seedUserWithRecords(45)

    // 删除一律返回 404 + Record does not exist（CF 侧已不存在）
    const original = globalThis.fetch
    const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url.includes("api.cloudflare.com") && (init?.method ?? "GET").toUpperCase() === "DELETE") {
        return new Response(
          JSON.stringify({ success: false, errors: [{ code: 81044, message: "Record does not exist" }] }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        )
      }
      if (url.includes("api.cloudflare.com")) {
        return new Response(
          JSON.stringify({ success: true, result: { id: `cf-${Math.random().toString(36).slice(2, 8)}` } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      }
      return original(input as RequestInfo, init)
    }) as unknown as typeof fetch
    globalThis.fetch = stub
    restores.push(() => {
      globalThis.fetch = original
    })

    await suspendViaRoute(admin, user.username)
    const { removed, errors } = await sweepRounds(3)

    expect(errors).toEqual([])
    expect(removed).toBeGreaterThan(0)
    const after = await snapshot(user.id)
    expect(after.stillOnCf).toBe(0)
  })

  it("管理端 dry-run 报告的残留数必须与真实待清理数一致（不能恒报 0）", async () => {
    stubCloudflare()
    const admin = await makeUser({ role: "superadmin" })
    const { user } = await seedUserWithRecords(45)

    await suspendViaRoute(admin, user.username)

    // dry-run 的候选集是全库的（与 sweep 同口径）⇒ 断言必须用全库计数。
    // 不依赖前序用例是否留下了残留，这样单跑 / -t 过滤都成立。
    const globalStillOnCf = await stillOnCfGlobal()
    expect(globalStillOnCf).toBeGreaterThan(0)

    const { runMaintenance } = await import("../src/maintenance")
    const report = await runMaintenance(env, { dryRun: true })
    const line = report.warnings.find((w) => w.includes("已停用记录仍挂在 Cloudflare"))
    expect(line).toBeTruthy()
    expect(line).toContain(`${globalStillOnCf} 条`)
  })

  it("sweep 的失败必须能上报到维护任务的告警里（不能静默）", async () => {
    stubCloudflare()
    const admin = await makeUser({ role: "superadmin" })
    const { user } = await seedUserWithRecords(45)

    await suspendViaRoute(admin, user.username)
    cfDeleteShouldFail = true

    const { runMaintenance } = await import("../src/maintenance")
    const report = await runMaintenance(env, { dryRun: false })

    // 兜底失败必须出现在 warnings 里 —— 否则线上永远不会有人发现
    const hit = report.warnings.find((w) => w.includes("封禁记录兜底失败"))
    expect(hit).toBeTruthy()
  })

  it("子域名转给他人后，兜底不能每小时把新主的记录删一次又建一次", async () => {
    stubCloudflare()
    const admin = await makeUser({ role: "superadmin" })
    const a = await seedUserWithRecords(3)
    const b = await makeUser({})

    // A 封禁：他的记录被删并标记
    expect((await suspendViaRoute(admin, a.user.username)).status).toBe(200)

    // 管理员把 A 的子域名转给 B（走真实路由；转移只改 subdomains.user_id，
    // 不动 dns_records.domain_id —— 归属歧义就出在这里）
    const transfer = await fetchSelf(
      authRequest(admin as never, `/api/admin/subdomains/${a.subId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: b.id }),
      })
    )
    expect(transfer.status).toBe(200)

    // 模拟 3 小时 cron：第 1 轮 retry 会把记录重建给 B（B 是 active，正确），
    // 之后 sweep 不该再删它们 —— 否则 B 的解析每小时断一次。
    const { sweepSuspendedDns, retrySuspendedDnsRestore } = await import("../src/user-suspension")
    const removedPerRound: number[] = []
    for (let i = 0; i < 3; i++) {
      const swept = await sweepSuspendedDns(env, 40)
      await retrySuspendedDnsRestore(env, 40)
      removedPerRound.push(swept.removed)
    }
    console.log("[转移用例] 各轮 sweep 删除数 =", JSON.stringify(removedPerRound))

    // 第 1 轮删 0（记录已被首跳删过、尚未重建）；第 2、3 轮必须也是 0。
    expect(removedPerRound[1]).toBe(0)
    expect(removedPerRound[2]).toBe(0)
  })

  it("归属判据：无子域名的历史记录仍按域名归属兜底（不能漏）", async () => {    stubCloudflare()
    const admin = await makeUser({ role: "superadmin" })
    const { user, domainId } = await seedUserWithRecords(2)

    // 先封禁（首跳会处理掉带子域名的那 2 条），**之后**再造 subdomain_id 为 NULL 的
    // 历史行 —— 这样它们只可能被兜底收走，才测得到域名归属那条分支。
    // （0003 回填之前的存量数据就是这个形态）
    expect((await suspendViaRoute(admin, user.username)).status).toBe(200)

    const now = new Date().toISOString()
    for (let i = 0; i < 2; i++) {
      await env.DB.prepare(
        `INSERT INTO dns_records
           (id, domain_id, subdomain_id, cf_id, name, fqdn, type, content, ttl, proxied, status, source, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?, 'A', ?, 1, 0, 'active', 'web', ?, ?)`
      )
        .bind(
          crypto.randomUUID(),
          domainId,
          `cf-legacy-${i}`,
          `legacy${i}`,
          `legacy${i}.probe.test`,
          `10.0.0.${i}`,
          now,
          now
        )
        .run()
    }

    const { removed } = await sweepRounds(3)

    // 这 2 条无子域名的行必须被「域名归属」那条分支收掉，否则永远留在 CF 上
    expect(removed).toBeGreaterThanOrEqual(2)
    const legacy = await env.DB.prepare(
      "SELECT cf_id, banned_at FROM dns_records WHERE domain_id = ? AND subdomain_id IS NULL"
    )
      .bind(domainId)
      .all<{ cf_id: string | null; banned_at: string | null }>()
    const rows = legacy.results ?? []
    expect(rows.length).toBe(2)
    expect(rows.every((r) => r.cf_id === null && r.banned_at !== null)).toBe(true)
  })

  /**
   * 直接入口（suspendUserResources / restoreUserResources）的归属判据。
   *
   * 这两处此前用的是裸 `subdomain_id IN (…) OR domain_id IN (…)`：子域名被管理员
   * 转给他人后（`admin-subdomains.ts:368` 只改 `subdomains.user_id`，**不动**
   * `dns_records.domain_id`），同一行会同时命中「原主的域名」与「新主的子域名」
   * 两侧 ⇒ 封禁 A 会删掉 B 的解析、解封 A 会重建仍处于封禁中的 B 的解析。
   *
   * 与 `ownerStatusSql`（兜底任务用的那份）必须同口径：**归属认子域名，
   * 没有子域名（0003 回填前的历史行）才回退到域名**，两个分支互斥。
   */
  it("封禁 A 不得动到已转给 B 的解析（直接入口的归属判据）", async () => {
    stubCloudflare()
    const admin = await makeUser({ role: "superadmin" })
    const a = await seedWithBlog(3)
    const b = await makeUser({})

    // A 的 blog 转给 B —— 从此这 3 条记录归 B，A 的封禁不该碰它们
    expect((await transferSubdomain(admin, a.blogId, b.id)).status).toBe(200)

    const before = await blogSnapshot(a.blogId)
    expect(before.total).toBe(3)

    cfDeleteCalls = 0
    expect((await suspendViaRoute(admin, a.user.username)).status).toBe(200)

    const after = await blogSnapshot(a.blogId)
    console.log(
      `[直接入口·封禁] CF DELETE=${cfDeleteCalls}，blog 封禁数 ${before.banned}→${after.banned}`
    )
    // B 是活跃用户，他的记录必须原样留在 CF 上
    expect(cfDeleteCalls).toBe(0)
    expect(after.banned).toBe(0)
    expect(after.withCf).toBe(3)
  })

  it("解封 A 不得重建仍处于封禁中的 B 的解析（直接入口的归属判据）", async () => {
    stubCloudflare()
    const admin = await makeUser({ role: "superadmin" })
    const a = await seedWithBlog(3)
    const b = await makeUser({})

    // 转给 B → B 封禁（这 3 条被正确停用）→ A 封禁
    expect((await transferSubdomain(admin, a.blogId, b.id)).status).toBe(200)
    expect((await suspendViaRoute(admin, b.username)).status).toBe(200)
    expect((await suspendViaRoute(admin, a.user.username)).status).toBe(200)

    const mid = await blogSnapshot(a.blogId)
    expect(mid.banned).toBe(3)

    // 解封 A：B 仍是 suspended，他的解析绝不能因为 A 的解封而复活
    cfCreateCalls = 0
    expect(
      (
        await fetchSelf(
          authRequest(admin, `/api/admin/users/${encodeURIComponent(a.user.username)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "active" }),
          })
        )
      ).status
    ).toBe(200)

    const after = await blogSnapshot(a.blogId)
    console.log(
      `[直接入口·解封] CF POST=${cfCreateCalls}，blog 在 CF 上 ${mid.withCf}→${after.withCf}，封禁数 ${mid.banned}→${after.banned}`
    )
    expect(cfCreateCalls).toBe(0)
    expect(after.withCf).toBe(0)
    expect(after.banned).toBe(3)

    // B 自己仍然是封禁状态 —— 上面那些断言不能是靠「B 其实已解封」蒙对的
    const bRow = await env.DB.prepare("SELECT status FROM users WHERE id = ?")
      .bind(b.id)
      .first<{ status: string }>()
    expect(bRow?.status).toBe("suspended")
  })

  it("正向守护：子域名仍归自己时，封禁/解封照常生效（互斥限定不能把正常路径挡住）", async () => {
    stubCloudflare()
    const admin = await makeUser({ role: "superadmin" })
    const a = await seedWithBlog(3)

    // 不转移：A 封禁必须删掉自己 blog 下的 3 条
    cfDeleteCalls = 0
    expect((await suspendViaRoute(admin, a.user.username)).status).toBe(200)
    const suspended = await blogSnapshot(a.blogId)
    expect(cfDeleteCalls).toBe(3)
    expect(suspended.banned).toBe(3)
    expect(suspended.withCf).toBe(0)

    // 解封必须把它们重建回来
    cfCreateCalls = 0
    expect(
      (
        await fetchSelf(
          authRequest(admin, `/api/admin/users/${encodeURIComponent(a.user.username)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "active" }),
          })
        )
      ).status
    ).toBe(200)
    const restored = await blogSnapshot(a.blogId)
    expect(cfCreateCalls).toBe(3)
    expect(restored.banned).toBe(0)
    expect(restored.withCf).toBe(3)
  })

  it("反向守护：子域名转走后，原主解封不得把新主的记录一并重建（自己的记录照常恢复）", async () => {
    stubCloudflare()
    const admin = await makeUser({ role: "superadmin" })
    const a = await seedWithBlog(3)
    const b = await makeUser({})

    // A 的 '@' 主域下再放一条**属于他自己**的记录：证明「A 的解封确实在重建
    // 他自己的东西」，而不是靠整段没跑而空过。必须在封禁**之前**插入，
    // 否则它不会被停用、也就没有「恢复」可言。
    const now = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO dns_records
         (id, domain_id, subdomain_id, cf_id, name, fqdn, type, content, ttl, proxied, status, source, created_at, updated_at)
       VALUES (?, ?, ?, 'cf-root-0', 'root', ?, 'A', '10.9.9.9', 1, 0, 'active', 'web', ?, ?)`
    )
      .bind(crypto.randomUUID(), a.domainId, a.rootSubId, `root.${a.root}`, now, now)
      .run()

    // 封禁 A（blog 3 条 + 主域 1 条一起被停用），再把 blog 转给 B
    expect((await suspendViaRoute(admin, a.user.username)).status).toBe(200)
    const afterSuspend = await blogSnapshot(a.blogId)
    expect(afterSuspend.banned).toBe(3)
    expect((await transferSubdomain(admin, a.blogId, b.id)).status).toBe(200)

    cfCreateCalls = 0
    expect(
      (
        await fetchSelf(
          authRequest(admin, `/api/admin/users/${encodeURIComponent(a.user.username)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "active" }),
          })
        )
      ).status
    ).toBe(200)

    const blog = await blogSnapshot(a.blogId)
    const ownRoot = await env.DB.prepare(
      "SELECT cf_id, banned_at FROM dns_records WHERE subdomain_id = ?"
    )
      .bind(a.rootSubId)
      .all<{ cf_id: string | null; banned_at: string | null }>()
    const ownRows = ownRoot.results ?? []

    console.log(
      `[直接入口·混合] CF POST=${cfCreateCalls}，已转走的 blog 在 CF 上=${blog.withCf}，自己主域 1 条中带 cf_id 的=${ownRows.filter((r) => r.cf_id !== null).length}`
    )
    // 已转走的那 3 条不得被重建（它们的归属是 B，A 的解封与它们无关）
    expect(blog.withCf).toBe(0)
    expect(blog.banned).toBe(3)
    // 而 A 自己的那条必须恢复，且 CF POST 只发了这一次
    expect(cfCreateCalls).toBe(1)
    expect(ownRows.length).toBe(1)
    expect(ownRows[0].cf_id).not.toBeNull()
    expect(ownRows[0].banned_at).toBeNull()
  })
})
