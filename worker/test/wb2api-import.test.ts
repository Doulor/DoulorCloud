// WorkBuddy 反代网关「JSON 文件导入」的上游核验（安全审计 #13 / #53 / #11）。
//
// 被修的洞：老实现从上传 JSON 里自己解析 uid，随后**直接**
// `createWb2Binding(..., { isNewToPool: true })` —— 网关导入接口只回计数、不回 uid
// 列表，"是否真的进了网关池"从未被核实过一次。于是 `[{"uid":"随便编一个"}]`
// 就能换到 `ai` 权限 + 一次捐献积分（kind=workbuddy）+ 一个绑定位（外加邀请奖励），
// 再顺着 /api/dev/bind → /api/dev/subscription → /api/dev/key 白嫖真实计费模型。
//
// 这里锁住的语义（与 qoder2api-import.test.ts 一一对应）：
//   1. 伪造 uid（池里没有）→ **不建绑定、不给 ai、不发积分**；
//   2. 真实 uid（池里有且未 disabled）→ 正常导入 + 解锁 ai + 发积分；
//   3. 池里 disabled:true → 拒收（账号坏了，进池也没用）；
//   4. 池概览拉不到 / 导入接口失败 → **fail-closed**：503，什么都不发；
//   5. 部分成功 → 通过的发，失败的逐条列在 `rejected` 里；
//   6. 重复导入 → 幂等，不重复发积分；
//   7. 超硬上限 → 400 且完全不碰上游。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, setSetting, setPermissions, type TestUser } from "./helpers"
import { resetWb2ApiCache } from "../src/wb2api-client"
import { getPointsBalance } from "../src/points"
import { uuid } from "../src/crypto"

/**
 * 测试专用网关地址。
 *
 * 不用默认的 https://wb2api.doulor.cn：另一个用例文件（wb2api.test.ts）按那个前缀
 * 打桩登录接口，同址会让两套桩互相干扰、也很难看出某次出站到底属于哪个用例。
 */
const BASE = "https://wb2-import.test"

interface StubCall {
  url: string
  method: string
  /** 只有 JSON 请求体才有内容；multipart（导入）这里是空串 */
  body: string
}

let calls: StubCall[] = []
let restore: (() => void) | null = null

/** 网关账号池内容（`GET /panel/api/overview` 的 `accounts`） */
let pool: { uid: string; nickname?: string; realm?: string; disabled?: boolean }[] = []
/** 让 `POST /panel/api/import/cockpit` 直接 500（模拟网关导入不可用） */
let importBroken = false
/** 让池概览直接 500（模拟「核验不了」） */
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

    // 导入走 multipart：真正的「发给网关的文件内容」在 FormData 的 file 字段里，
    // 这里解出来记进 body，用例才能断言"只送了候选行"
    let body = ""
    if (typeof init?.body === "string") {
      body = init.body
    } else if (init?.body instanceof FormData) {
      const f = init.body.get("file")
      if (f && typeof (f as File).text === "function") body = await (f as File).text()
    }
    calls.push({ url, method: init?.method ?? "GET", body })

    if (url.includes("/panel/api/overview")) {
      if (poolBroken) return jsonResponse({ ok: false, error: "pool unavailable" }, 500)
      return jsonResponse({
        ok: true,
        total: pool.length,
        healthy: pool.filter((a) => !a.disabled).length,
        cooling: 0,
        disabled: pool.filter((a) => a.disabled).length,
        accounts: pool.map((a) => ({ realm: "cn", ...a })),
      })
    }

    if (url.includes("/panel/api/import/cockpit")) {
      if (importBroken) return jsonResponse({ ok: false, error: "gateway is down" }, 500)
      return jsonResponse({ ok: true, total: pool.length, imported: 1, skipped: 0, errors: [] })
    }

    return jsonResponse({ ok: false, error: "not stubbed" }, 400)
  }) as unknown as typeof fetch
  globalThis.fetch = stub
  restore = () => {
    globalThis.fetch = original
  }
}

/** 发一次真实的 multipart 导入请求 */
async function importJson(
  user: TestUser,
  rows: unknown[]
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fd = new FormData()
  fd.append("file", new File([JSON.stringify(rows)], "accounts.json", { type: "application/json" }))
  const res = await fetchSelf(
    authRequest(user, "/api/wb2api/import", { method: "POST", body: fd })
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

/** 直接读库确认权限位（NULL = 全开） */
async function aiPermission(userId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT permissions FROM users WHERE id = ?")
    .bind(userId)
    .first<{ permissions: string | null }>()
  if (!row?.permissions) return true
  return JSON.parse(row.permissions).ai === true
}

async function bindingRows(userId: string): Promise<
  { uid: string; status: string; granted_ai_permission: number }[]
> {
  const res = await env.DB.prepare(
    "SELECT uid, status, granted_ai_permission FROM wb2api_bindings WHERE user_id = ?"
  )
    .bind(userId)
    .all<{ uid: string; status: string; granted_ai_permission: number }>()
  return res.results ?? []
}

/** 上游收到的导入调用次数（用来断言「超上限时完全不碰上游」） */
function importCalls(): StubCall[] {
  return calls.filter((c) => c.url.includes("/panel/api/import/cockpit"))
}

function poolCalls(): StubCall[] {
  return calls.filter((c) => c.url.includes("/panel/api/overview"))
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM wb2api_bindings").run()
  await env.DB.prepare("DELETE FROM wb2api_login_sessions").run()
  await env.DB.prepare("DELETE FROM wb2api_credentials").run()
  await env.DB.prepare("DELETE FROM rate_limits").run()
  await env.DB.prepare("DELETE FROM point_transactions").run()
  await env.DB.prepare("DELETE FROM user_points").run()
  await env.DB.prepare("DELETE FROM invite_rewards").run()
  await env.DB.prepare(
    "DELETE FROM app_settings WHERE key LIKE 'wb2api%' OR key = 'donation_grant_wb2api'"
  ).run()

  await setSetting("wb2api_base_url", BASE)
  await setSetting("wb2api_enabled", "1")
  await setSetting("wb2api_max_bindings", "10")
  await setSetting("donation_grant_wb2api", "1")
  // 捐献积分档位固定成 10，断言才可读（默认也是 10，这里显式钉住防其他用例改动）
  await setSetting("donation_points_workbuddy", "10")

  calls = []
  pool = []
  importBroken = false
  poolBroken = false
  resetWb2ApiCache()
  stubUpstream()
})

afterEach(() => {
  restore?.()
  restore = null
  resetWb2ApiCache()
})

describe("上游核验（#13 / #53 的核心修复）", () => {
  it("伪造 uid：池里没有 → 不建绑定、不给 ai、不发积分", async () => {
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

  it("真实 uid（池里存在且未 disabled）→ 建 active 绑定、解锁 ai、发积分", async () => {
    const u = await makeUser()
    await setPermissions(u.id, JSON.stringify({ ai: false }))

    pool = [{ uid: "acc_real_1", nickname: "池里的号", realm: "cn" }]
    const res = await importJson(u, [{ uid: "acc_real_1", nickname: "我的 WorkBuddy" }])

    expect(res.status).toBe(200)
    expect(res.body.bound).toBe(1)
    expect(res.body.newlyBound).toBe(1)
    expect(res.body.revived).toBe(0)
    expect(res.body.rejected).toEqual([])

    const rows = await bindingRows(u.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].uid).toBe("acc_real_1")
    expect(rows[0].status).toBe("active")
    expect(rows[0].granted_ai_permission).toBe(1)

    expect(await aiPermission(u.id)).toBe(true)
    expect(await getPointsBalance(env, u.id)).toBe(10)

    // 只打两次上游：一次导入、一次池概览（与 uid 数量无关）
    expect(importCalls()).toHaveLength(1)
    expect(poolCalls()).toHaveLength(1)
  })

  it("池里 disabled:true → 拒收，不发权益", async () => {
    const u = await makeUser()
    await setPermissions(u.id, JSON.stringify({ ai: false }))

    pool = [{ uid: "acc_disabled", disabled: true }]
    const res = await importJson(u, [{ uid: "acc_disabled" }])

    expect(res.body.bound).toBe(0)
    expect((res.body.rejected as { reason: string }[])[0].reason).toContain("禁用")
    expect(await bindingRows(u.id)).toHaveLength(0)
    expect(await aiPermission(u.id)).toBe(false)
    expect(await getPointsBalance(env, u.id)).toBe(0)
  })
})

describe("fail-closed（上游不可用时不放行）", () => {
  it("核验用的池概览拉不到 → 503，整批拒绝且什么都没发", async () => {
    const u = await makeUser()
    await setPermissions(u.id, JSON.stringify({ ai: false }))

    pool = [{ uid: "acc_real_1" }]
    poolBroken = true

    const res = await importJson(u, [{ uid: "acc_real_1" }])
    expect(res.status).toBe(503)
    expect(String(res.body.error)).toContain("已取消")

    expect(await bindingRows(u.id)).toHaveLength(0)
    expect(await aiPermission(u.id)).toBe(false)
    expect(await getPointsBalance(env, u.id)).toBe(0)
  })

  it("网关导入接口失败 → 503，整批拒绝（即使池里能看到该账号）", async () => {
    const u = await makeUser()
    await setPermissions(u.id, JSON.stringify({ ai: false }))

    pool = [{ uid: "acc_real_1" }]
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
  it("3 个里 2 真 1 假：只绑 2 个、ai 只解锁一次、积分只发一次、rejected 精确", async () => {
    const u = await makeUser()
    await setPermissions(u.id, JSON.stringify({ ai: false }))

    pool = [
      { uid: "acc_ok_1", realm: "cn" },
      { uid: "acc_ok_2", realm: "cn" },
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
    expect(rows.map((r) => r.uid).sort()).toEqual(["acc_ok_1", "acc_ok_2"])
    // 「ai 只解锁一次」= 只有一条绑定记 granted（移除时据此判断该不该收权限）
    expect(rows.filter((r) => r.granted_ai_permission === 1)).toHaveLength(1)

    expect(await aiPermission(u.id)).toBe(true)
    // 一次导入只发一份（与 qoder2api 同口径，不是每个账号各发一次）
    expect(await getPointsBalance(env, u.id)).toBe(10)
  })
})

describe("幂等与归属", () => {
  it("重复导入同一账号：第二次不新建、不重复发积分", async () => {
    const u = await makeUser()
    await setPermissions(u.id, JSON.stringify({ ai: false }))

    pool = [{ uid: "acc_dup" }]

    const first = await importJson(u, [{ uid: "acc_dup" }])
    expect(first.body.bound).toBe(1)
    expect(await getPointsBalance(env, u.id)).toBe(10)

    const second = await importJson(u, [{ uid: "acc_dup" }])
    expect(second.status).toBe(200)
    expect(second.body.bound).toBe(0)
    expect(second.body.alreadyBound).toEqual(["acc_dup"])
    // 第二次全是「已是本人」，连上游都不必打
    expect(importCalls()).toHaveLength(1)
    expect(poolCalls()).toHaveLength(1)

    expect(await bindingRows(u.id)).toHaveLength(1)
    expect(await getPointsBalance(env, u.id)).toBe(10)
  })

  it("账号已被别的用户绑过 → 拒绝（即使池里确实有这个号）", async () => {
    const owner = await makeUser()
    const thief = await makeUser()
    await setPermissions(thief.id, JSON.stringify({ ai: false }))

    pool = [{ uid: "acc_taken" }]
    await env.DB.prepare(
      `INSERT INTO wb2api_bindings
         (id, user_id, uid, nickname, realm, status, granted_ai_permission, created_at)
       VALUES (?, ?, ?, '别人捐的', 'cn', 'active', 1, ?)`
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

  it("自己的墓碑：核验通过则复活（uid 唯一索引不会被撞），且不算新贡献、不发积分", async () => {
    const u = await makeUser()
    await setPermissions(u.id, JSON.stringify({ ai: false }))
    const bindingId = uuid()
    await env.DB.prepare(
      `INSERT INTO wb2api_bindings
         (id, user_id, uid, nickname, realm, status, granted_ai_permission,
          removed_at, removed_by, created_at)
       VALUES (?, ?, 'acc_revive', '旧昵称', 'cn', 'removed', 0, ?, ?, ?)`
    )
      .bind(bindingId, u.id, new Date().toISOString(), u.id, new Date().toISOString())
      .run()

    pool = [{ uid: "acc_revive" }]
    const res = await importJson(u, [{ uid: "acc_revive", nickname: "新昵称" }])

    expect(res.status).toBe(200)
    expect(res.body.newlyBound).toBe(0)
    expect(res.body.revived).toBe(1)
    expect(res.body.bound).toBe(1)

    const rows = await bindingRows(u.id)
    expect(rows).toHaveLength(1) // 复活的是原来那一行，不是新插一行
    expect(rows[0].uid).toBe("acc_revive")
    expect(rows[0].status).toBe("active")
    // 复活不算「带来新资源」，不发捐献积分
    expect(await getPointsBalance(env, u.id)).toBe(0)
  })
})

describe("批量与硬上限", () => {
  it("只把候选行送去上游导入（超名额的不进共享池）", async () => {
    await setSetting("wb2api_max_bindings", "1")
    const u = await makeUser()
    await setPermissions(u.id, JSON.stringify({ ai: false }))

    pool = [{ uid: "acc_a" }, { uid: "acc_b" }]
    const res = await importJson(u, [{ uid: "acc_a" }, { uid: "acc_b" }])

    expect(res.body.bound).toBe(1)
    expect(res.body.skippedByLimit).toEqual(["acc_b"])

    // 上游只收到 1 行（acc_a），acc_b 根本没被塞进池子
    const call = importCalls()[0]
    expect(call).toBeTruthy()
    const sent = JSON.parse(call.body) as unknown[]
    expect(sent).toHaveLength(1)
    expect(JSON.stringify(sent)).toContain("acc_a")
    expect(JSON.stringify(sent)).not.toContain("acc_b")
  })

  it("超过单次导入上限 → 400 且完全不碰上游", async () => {
    const u = await makeUser()
    const many = Array.from({ length: 201 }, (_, i) => ({ uid: `acc_${i}` }))

    const res = await importJson(u, many)
    expect(res.status).toBe(400)
    expect(importCalls()).toHaveLength(0)
    expect(poolCalls()).toHaveLength(0)
    expect(await bindingRows(u.id)).toHaveLength(0)
  })
})
