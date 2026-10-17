// Qoder2API「JSON 文件导入」的上游核验（安全审计 #13 / #53 / #11）。
//
// 被修的洞：老实现把上传 JSON 里的 `uid` 直接 INSERT 成 active 绑定，
// 完全不核实这个 uid 在上游是否真的存在 ⇒ `[{"uid":"随便编一个"}]` 就能换到
// `ai` 权限 + 捐献积分 + 邀请奖励，再顺着 /api/dev/bind → /api/dev/key 白嫖计费模型。
//
// 这里锁住的语义：
//   1. 伪造 uid（上游池里没有）→ **不建绑定、不给 ai、不发积分**；
//   2. 真实 uid（上游池里有且 enabled）→ 正常导入 + 解锁 ai + 发积分；
//   3. 上游不可用（导入接口或池列表挂掉）→ **fail-closed**：整批拒绝，什么都不发；
//   4. 部分成功 → 通过的发，失败的逐条列在 `rejected` 里，不整批回滚；
//   5. 重复导入 → 幂等，不重复发积分；
//   6. 已被他人绑定的账号 → 拒绝（归属冲突）。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, setSetting, setPermissions, type TestUser } from "./helpers"
import { resetQoder2ApiCache, saveQoder2ApiPassword } from "../src/qoder2api-client"
import { getPointsBalance } from "../src/points"
import { uuid } from "../src/crypto"

const BASE = "https://q2.test"

interface StubCall {
  url: string
  method: string
  body: string
}

let calls: StubCall[] = []
let restore: (() => void) | null = null

/** 上游账号池内容（`/accounts?realm=` 的应答数据源） */
let pool: { uid: string; enabled?: boolean; realm?: string }[] = []
/** 让 `/accounts/import` 直接 500（模拟网关不可用） */
let importBroken = false
/** 让池列表直接 500（模拟「核验不了」） */
let poolBroken = false

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/** 打桩出站 fetch：只接管发往测试网关 BASE 的请求，其余透传 */
function stubUpstream(): void {
  const original = globalThis.fetch
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(BASE)) return original(input as RequestInfo, init)

    const body = typeof init?.body === "string" ? init.body : ""
    calls.push({ url, method: init?.method ?? "GET", body })

    if (url.includes("/panel/login")) return jsonResponse({ token: `tk-${uuid()}` })

    if (url.includes("/accounts/import")) {
      if (importBroken) return jsonResponse({ error: { message: "gateway is down" } }, 500)
      return jsonResponse({ imported: 1, skipped: 0, errors: [] })
    }

    if (url.includes("/accounts?realm=")) {
      if (poolBroken) return jsonResponse({ error: { message: "pool unavailable" } }, 500)
      const realm = new URL(url).searchParams.get("realm") ?? "cn"
      return jsonResponse({
        accounts: pool
          .filter((a) => (a.realm ?? "cn") === realm)
          .map((a) => ({ ...a, nickname: a.uid, realm: a.realm ?? "cn" })),
      })
    }

    return jsonResponse({})
  }) as unknown as typeof fetch
  globalThis.fetch = stub
  restore = () => {
    globalThis.fetch = original
  }
}

/** 走真实管理端路径配置一个可用面板密码（会探测一次上游） */
async function configure(): Promise<void> {
  await saveQoder2ApiPassword(env, "panel-pw")
}

/** 发一次真实的 multipart 导入请求 */
async function importJson(
  user: TestUser,
  rows: unknown[],
  realm?: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fd = new FormData()
  fd.append("file", new File([JSON.stringify(rows)], "accounts.json", { type: "application/json" }))
  if (realm) fd.append("realm", realm)
  const res = await fetchSelf(authRequest(user, "/api/qoder2api/import", { method: "POST", body: fd }))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

/** 直接读库确认权限位 */
async function aiPermission(userId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT permissions FROM users WHERE id = ?")
    .bind(userId)
    .first<{ permissions: string | null }>()
  if (!row?.permissions) return true // NULL = 全开
  return JSON.parse(row.permissions).ai === true
}

async function bindingRows(userId: string): Promise<
  { account_id: string; status: string; granted_ai_permission: number }[]
> {
  const res = await env.DB.prepare(
    "SELECT account_id, status, granted_ai_permission FROM qoder2api_bindings WHERE user_id = ?"
  )
    .bind(userId)
    .all<{ account_id: string; status: string; granted_ai_permission: number }>()
  return res.results ?? []
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM qoder2api_bindings").run()
  await env.DB.prepare("DELETE FROM qoder2api_login_sessions").run()
  await env.DB.prepare("DELETE FROM qoder2api_credentials").run()
  await env.DB.prepare("DELETE FROM rate_limits").run()
  await env.DB.prepare("DELETE FROM point_transactions").run()
  await env.DB.prepare("DELETE FROM user_points").run()
  await env.DB.prepare(
    "DELETE FROM app_settings WHERE key LIKE 'qoder2api%' OR key = 'donation_grant_qoder2api'"
  ).run()

  await setSetting("qoder2api_base_url", BASE)
  await setSetting("qoder2api_enabled", "1")
  await setSetting("donation_grant_qoder2api", "1")
  calls = []
  pool = []
  importBroken = false
  poolBroken = false
  resetQoder2ApiCache()
  stubUpstream()
})

afterEach(() => {
  restore?.()
  restore = null
})

describe("上游核验（#13 / #53 的核心修复）", () => {
  it("伪造 uid：上游池里没有 → 不建绑定、不给 ai、不发积分", async () => {
    await configure()
    const u = await makeUser()
    // 显式「还没有 ai」：否则 NULL permissions 视为全开
    await setPermissions(u.id, JSON.stringify({ ai: false }))

    // 网关没接受这条伪造账号 ⇒ 池里查无此号
    pool = []
    const res = await importJson(u, [{ uid: "totally-made-up", nickname: "假号" }])

    expect(res.status).toBe(200)
    expect(res.body.bound).toBe(0)
    expect(res.body.newlyBound).toBe(0)
    const rejected = res.body.rejected as { uid: string; reason: string }[]
    expect(rejected).toHaveLength(1)
    expect(rejected[0].uid).toBe("totally-made-up")
    expect(rejected[0].reason).toContain("查无此账号")

    // 三件事都必须没发生
    expect(await bindingRows(u.id)).toHaveLength(0)
    expect(await aiPermission(u.id)).toBe(false)
    expect(await getPointsBalance(env, u.id)).toBe(0)
  })

  it("真实 uid（上游池里存在且 enabled）→ 正常导入、解锁 ai、发积分", async () => {
    await configure()
    const u = await makeUser()
    await setPermissions(u.id, JSON.stringify({ ai: false }))

    pool = [{ uid: "acc_real_1", enabled: true, realm: "cn" }]
    const res = await importJson(u, [{ uid: "acc_real_1", nickname: "我的 Qoder" }])

    expect(res.status).toBe(200)
    expect(res.body.bound).toBe(1)
    expect(res.body.newlyBound).toBe(1)
    expect(res.body.rejected).toEqual([])

    const rows = await bindingRows(u.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].account_id).toBe("acc_real_1")
    expect(rows[0].status).toBe("active")
    expect(rows[0].granted_ai_permission).toBe(1)

    expect(await aiPermission(u.id)).toBe(true)
    expect(await getPointsBalance(env, u.id)).toBe(10)
  })

  it("上游把账号标成 enabled=false → 拒绝，不发权益", async () => {
    await configure()
    const u = await makeUser()
    await setPermissions(u.id, JSON.stringify({ ai: false }))

    pool = [{ uid: "acc_disabled", enabled: false, realm: "cn" }]
    const res = await importJson(u, [{ uid: "acc_disabled" }])

    expect(res.body.bound).toBe(0)
    expect((res.body.rejected as { reason: string }[])[0].reason).toContain("禁用")
    expect(await bindingRows(u.id)).toHaveLength(0)
    expect(await aiPermission(u.id)).toBe(false)
    expect(await getPointsBalance(env, u.id)).toBe(0)
  })
})

describe("fail-closed（上游不可用时不放行）", () => {
  it("核验用的池列表拉不到 → 503，整批拒绝且什么都发", async () => {
    await configure()
    const u = await makeUser()
    await setPermissions(u.id, JSON.stringify({ ai: false }))

    pool = [{ uid: "acc_real_1", enabled: true, realm: "cn" }]
    poolBroken = true

    const res = await importJson(u, [{ uid: "acc_real_1" }])
    expect(res.status).toBe(503)
    expect(String(res.body.error)).toContain("已取消")

    expect(await bindingRows(u.id)).toHaveLength(0)
    expect(await aiPermission(u.id)).toBe(false)
    expect(await getPointsBalance(env, u.id)).toBe(0)
  })

  it("网关导入接口失败 → 503，整批拒绝（即使池里能看到该账号）", async () => {
    await configure()
    const u = await makeUser()
    await setPermissions(u.id, JSON.stringify({ ai: false }))

    pool = [{ uid: "acc_real_1", enabled: true, realm: "cn" }]
    importBroken = true

    const res = await importJson(u, [{ uid: "acc_real_1" }])
    expect(res.status).toBe(503)
    expect(String(res.body.error)).toContain("已取消")
    expect(await bindingRows(u.id)).toHaveLength(0)
    expect(await aiPermission(u.id)).toBe(false)
    expect(await getPointsBalance(env, u.id)).toBe(0)
  })
})

describe("部分成功（通过的发，失败的逐条列出）", () => {
  it("3 个里 2 真 1 假：只绑 2 个、ai 只解锁一次、积分只发一次", async () => {
    await configure()
    const u = await makeUser()
    await setPermissions(u.id, JSON.stringify({ ai: false }))

    pool = [
      { uid: "acc_ok_1", enabled: true, realm: "cn" },
      { uid: "acc_ok_2", enabled: true, realm: "cn" },
    ]
    const res = await importJson(u, [
      { uid: "acc_ok_1", nickname: "一号" },
      { uid: "acc_fake", nickname: "假号" },
      { uid: "acc_ok_2", nickname: "二号" },
    ])

    expect(res.status).toBe(200)
    expect(res.body.total).toBe(3)
    expect(res.body.bound).toBe(2)
    expect(res.body.newlyBound).toBe(2)
    const rejected = res.body.rejected as { uid: string; reason: string }[]
    expect(rejected.map((r) => r.uid)).toEqual(["acc_fake"])

    const rows = await bindingRows(u.id)
    expect(rows.map((r) => r.account_id).sort()).toEqual(["acc_ok_1", "acc_ok_2"])

    expect(await aiPermission(u.id)).toBe(true)
    // 一次导入只发一次（口径与原实现一致，不是每个账号各发一次）
    expect(await getPointsBalance(env, u.id)).toBe(10)
  })
})

describe("幂等与归属", () => {
  it("重复导入同一账号：第二次不新建、不重复发积分", async () => {
    await configure()
    const u = await makeUser()
    await setPermissions(u.id, JSON.stringify({ ai: false }))

    pool = [{ uid: "acc_dup", enabled: true, realm: "cn" }]

    const first = await importJson(u, [{ uid: "acc_dup" }])
    expect(first.body.bound).toBe(1)
    expect(await getPointsBalance(env, u.id)).toBe(10)

    const second = await importJson(u, [{ uid: "acc_dup" }])
    expect(second.status).toBe(200)
    expect(second.body.bound).toBe(0)
    expect(second.body.alreadyBound).toEqual(["acc_dup"])

    expect(await bindingRows(u.id)).toHaveLength(1)
    expect(await getPointsBalance(env, u.id)).toBe(10)
  })

  it("账号已被别的用户绑过 → 拒绝（即使上游池里确实有这个号）", async () => {
    await configure()
    const owner = await makeUser()
    const thief = await makeUser()
    await setPermissions(thief.id, JSON.stringify({ ai: false }))

    // 上游池里真有其号（owner 捐的）
    pool = [{ uid: "acc_taken", enabled: true, realm: "cn" }]
    await env.DB.prepare(
      `INSERT INTO qoder2api_bindings
         (id, user_id, account_id, realm, nickname, status, granted_ai_permission, created_at)
       VALUES (?, ?, ?, 'cn', '别人捐的', 'active', 1, ?)`
    )
      .bind(uuid(), owner.id, "acc_taken", new Date().toISOString())
      .run()

    const res = await importJson(thief, [{ uid: "acc_taken" }])
    expect(res.body.bound).toBe(0)
    expect((res.body.rejected as { reason: string }[])[0].reason).toContain("其他用户")

    expect(await bindingRows(thief.id)).toHaveLength(0)
    expect(await aiPermission(thief.id)).toBe(false)
    expect(await getPointsBalance(env, thief.id)).toBe(0)
  })
})

describe("批量与配额", () => {
  it("只把候选行送去上游导入（超名额的不进共享池）", async () => {
    await configure()
    await setSetting("qoder2api_max_bindings", "1")
    const u = await makeUser()
    await setPermissions(u.id, JSON.stringify({ ai: false }))

    pool = [
      { uid: "acc_a", enabled: true, realm: "cn" },
      { uid: "acc_b", enabled: true, realm: "cn" },
    ]
    const res = await importJson(u, [{ uid: "acc_a" }, { uid: "acc_b" }])

    expect(res.body.bound).toBe(1)
    expect(res.body.skippedByLimit).toEqual(["acc_b"])

    // 上游只收到 1 行（acc_a），acc_b 根本没被塞进池子
    const importCall = calls.find((c) => c.url.includes("/accounts/import"))
    expect(importCall).toBeTruthy()
    const payload = JSON.parse(importCall!.body) as { data: unknown[] }
    expect(payload.data).toHaveLength(1)
    expect(JSON.stringify(payload.data)).toContain("acc_a")
  })

  it("超过单次导入上限 → 400 且不碰上游", async () => {
    await configure()
    const u = await makeUser()
    const many = Array.from({ length: 201 }, (_, i) => ({ uid: `acc_${i}` }))

    const res = await importJson(u, many)
    expect(res.status).toBe(400)
    expect(calls.filter((c) => c.url.includes("/accounts/import"))).toHaveLength(0)
    expect(await bindingRows(u.id)).toHaveLength(0)
  })
})
