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
import { makeUser, authRequest, fetchSelf } from "./helpers"

const restores: Array<() => void> = []

/** 打桩 CF：可控「删除成功 / 删除失败」，并记录删除调用次数 */
let cfDeleteCalls = 0
let cfDeleteShouldFail = false

function stubCloudflare(): void {
  const original = globalThis.fetch
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.includes("api.cloudflare.com")) {
      const method = (init?.method ?? "GET").toUpperCase()
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
  cfDeleteShouldFail = false
})

beforeEach(async () => {
  cfDeleteCalls = 0
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
  return { user, domainId }
}

/** 该用户所有记录的封禁/残留统计 */
async function snapshot(userId: string) {
  const rows = await env.DB.prepare(
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
})
