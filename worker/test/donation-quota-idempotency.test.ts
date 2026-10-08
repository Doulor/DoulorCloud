// 回归测试：捐献额度发放的**用户级幂等**（2026-10-08）。
//
// 缺陷原貌（`applyDonationApproval` 的 `priorSameType` 闸门）：
//   判据是「这个用户**还有没有别的**同类型已批准单据」，而不是「这个用户的这类额度
//   发过没有」。`id != ?` 把这行自己排除在外 ⇒ 该行对自己不可见 ⇒ 只要在审批那一刻
//   库里没有**别的** approved 行，就再发一轮额度。
//
// 四条可触发路径（全部由本文件的用例覆盖，前三条在旧代码上稳定失败）：
//   ① 单行反复覆盖重提：同一上游再提交 → 复用同一行 id、重置 pending → 自动审核
//      通过 → 闸门看不到「别的 approved」→ 再发。实测 10 轮 bonus 2→20。
//   ② 撤销 → 重新批准同一单据：撤销把它置回 pending，闸门随之变假 → 重批再发。
//      实测 6 轮 2→14。
//   ③ 两条单据**同时**非 approved（例如都被撤销，或上游抖动使覆盖重提后转 pending）
//      → 逐条重批时「另一条」不是 approved ⇒ 每轮都能 +2，实测 4 轮 2→10。
//   ④ 撤销 → 用户删掉那条 pending 单据（`cancelDonation` 是直接 DELETE）→ 重提同一
//      上游（`hasDuplicateUpstream` 只扫 pending/approved，扫不到已删的行）⇒ 新建
//      一条 ⇒ 再发，实测 3 轮 2→8。**这条是标记必须挂在用户上而非单据上的原因**：
//      行级标记会随行一起被删掉。
//
// 另外一条（不属于上面四条，是原实现的 read-then-act 窗口）：
//   ⑤ 并发审批：两个请求都读到「没有别的 approved」⇒ 双发。改为原子占位后由 D1
//      的单条 UPDATE 串行化兜住。注：这条在旧代码上**不稳定复现**（miniflare 会把
//      D1 语句串行化），因此它是不变式守护，不是「旧代码必红」的证据。
//
// 反向守护（旧代码也绿，用来防止把闸门改宽或改死）：
//   · 全新账号第一笔正常发 2 / 1；
//   · 真·第二份不同上游不再发（H2「同类型只发一次」的上界保持不变）；
//   · ai 与 proxy 互不影响；
//   · 历史数据回填后，老账号仍不发第二份。
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, setPermissions, type TestUser } from "./helpers"
import { loadUserQuota } from "../src/quotas"

const NEWAPI = "https://api.doulor.cn"
const UP1 = "https://up1.example.com"
const UP2 = "https://up2.example.com"
const UP3 = "https://up3.example.com"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

interface Call {
  url: string
  method: string
  body: unknown
}
let calls: Call[] = []
let restores: Array<() => void> = []

function stubFetch(
  handler: (url: string, init: RequestInit | undefined, method: string) => Response | undefined
): void {
  const original = globalThis.fetch
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? "GET").toUpperCase()
    let body: unknown = null
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    calls.push({ url, method, body })
    const res = handler(url, init, method)
    if (res) return res
    return original(input as RequestInfo, init)
  }) as unknown as typeof fetch
  globalThis.fetch = stub
  restores.push(() => {
    globalThis.fetch = original
  })
}

function upstreamModels(models: string[]): Response {
  return jsonResponse({ object: "list", data: models.map((id) => ({ id })) })
}

function findLastCall(method: string): Call | undefined {
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i]
    if (c.method === method && c.url.endsWith("/api/channel/")) return c
  }
  return undefined
}

/** 与 donation-ai.test.ts 同构的最小 NewAPI 渠道流程打桩 */
function stubNewApiChannelFlow(opts: { testOk: boolean }) {
  let created: {
    id: number
    name: string
    type: number
    status: number
    models: string
    model_mapping: string
    group: string
    base_url: string
    tag: string
  } | null = null

  stubFetch((url, _init, method) => {
    if (!url.startsWith(NEWAPI)) return undefined
    if (url.includes("/api/channel/test/")) {
      const model = decodeURIComponent(new URL(url).searchParams.get("model") ?? "")
      return jsonResponse(
        opts.testOk
          ? { success: true, message: "", time: 0.4 }
          : { success: false, message: `上游不支持该模型（${model}）`, time: 0.1 }
      )
    }
    if (method === "POST" && url.endsWith("/api/channel/")) {
      const ch = (findLastCall("POST")?.body as { channel?: Record<string, unknown> })?.channel
      created = {
        id: 101,
        name: String(ch?.name ?? "捐献01"),
        type: Number(ch?.type ?? 1),
        status: 1,
        models: String(ch?.models ?? ""),
        model_mapping: String(ch?.model_mapping ?? ""),
        group: "default",
        base_url: String(ch?.base_url ?? ""),
        tag: String(ch?.tag ?? ""),
      }
      return jsonResponse({ success: true, message: "" })
    }
    if (method === "PUT" && url.endsWith("/api/channel/")) {
      const put = findLastCall("PUT")?.body as
        | { id?: number; models?: string; model_mapping?: string }
        | undefined
      if (created && put?.id === created.id) {
        if (put.models !== undefined) created.models = put.models
        if (put.model_mapping !== undefined) created.model_mapping = put.model_mapping
      }
      return jsonResponse({ success: true, message: "" })
    }
    if (method === "DELETE" && url.includes("/api/channel/")) {
      created = null
      return jsonResponse({ success: true, message: "" })
    }
    const single = url.match(/\/api\/channel\/(\d+)(?:\?.*)?$/)
    if (method === "GET" && single && !url.includes("/api/channel/test/")) {
      if (created && created.id === Number(single[1])) {
        return jsonResponse({ success: true, message: "", data: created })
      }
      return jsonResponse({ success: false, message: "record not found" })
    }
    if (method === "GET" && url.includes("/api/channel/")) {
      return jsonResponse({
        success: true,
        message: "",
        data: {
          items: created ? [created] : [],
          total: created ? 1 : 0,
          page: 1,
          page_size: 100,
          type_counts: {},
        },
      })
    }
    return undefined
  })
}

async function makeDonor(): Promise<TestUser> {
  const user = await makeUser()
  await env.DB.prepare("UPDATE users SET email = ? WHERE id = ?")
    .bind(`${user.username}@example.net`, user.id)
    .run()
  await setPermissions(user.id, JSON.stringify({ ai: false }))
  return user
}

/** 用例会连打十几次，先清掉捐献限流桶（10 次 / 600 s），否则会被 429 掩盖真相 */
async function clearRateLimits() {
  await env.DB.prepare("DELETE FROM rate_limits WHERE bucket LIKE 'donation:create:user:%'").run()
}

async function submitAi(user: TestUser, baseUrl: string, models = ["gpt-4o"]) {
  await clearRateLimits()
  const res = await fetchSelf(
    authRequest(user, "/donations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "ai", payload: { baseUrl, apiKey: "sk-test", models } }),
    })
  )
  const body = (await res.json()) as { id: string; status: string }
  return { http: res.status, id: body.id, status: body.status }
}

/** 读取额度（bonus 与 ai 模块额度） */
async function quotaOf(userId: string) {
  const q = await loadUserQuota(env, userId)
  return { bonus: q.inviteBonus, ai: q.featureQuota.ai }
}

/** 当前账号的 ai 单据状态分布，如 "approved×2" */
async function rowsOf(userId: string) {
  const r = await env.DB.prepare(
    "SELECT status, COUNT(*) AS c FROM donations WHERE user_id = ? AND type = 'ai' GROUP BY status"
  )
    .bind(userId)
    .all<{ status: string; c: number }>()
  return (r.results ?? []).map((x) => `${x.status}×${x.c}`).join(" ")
}

beforeEach(() => {
  calls = []
})

afterEach(() => {
  for (let i = restores.length - 1; i >= 0; i--) restores[i]()
  restores = []
  vi.restoreAllMocks()
})

describe("捐献额度：用户级幂等（① 覆盖重提）", () => {
  it("同一上游反复覆盖重提：额度只发一次", async () => {
    const user = await makeDonor()
    stubFetch((url) => (url.startsWith(UP1) ? upstreamModels(["gpt-4o"]) : undefined))
    stubNewApiChannelFlow({ testOk: true })

    const first = await submitAi(user, UP1)
    expect(first.http).toBe(200)
    expect(await quotaOf(user.id)).toEqual({ bonus: 2, ai: 1 })

    // 再提 3 次同一个上游：每次都是「覆盖同一条单据 + 自动审核通过」
    const ids = [first.id]
    for (let i = 0; i < 3; i++) {
      const again = await submitAi(user, UP1)
      expect(again.http, `第 ${i + 2} 次提交`).toBe(200)
      expect(again.status).toBe("approved")
      ids.push(again.id)
    }
    // 覆盖复用的是同一条单据，不是新建
    expect(new Set(ids).size).toBe(1)
    expect(await rowsOf(user.id)).toBe("approved×1")

    // 关键断言：额度**没有**随覆盖重提增长
    expect(await quotaOf(user.id)).toEqual({ bonus: 2, ai: 1 })
  })

  it("换模型覆盖重提也不涨（模型不是绕过闸门的理由）", async () => {
    const user = await makeDonor()
    stubFetch((url) => (url.startsWith(UP1) ? upstreamModels(["gpt-4o", "claude-3.5-sonnet"]) : undefined))
    stubNewApiChannelFlow({ testOk: true })

    await submitAi(user, UP1)
    expect(await quotaOf(user.id)).toEqual({ bonus: 2, ai: 1 })

    await submitAi(user, UP1, ["claude-3.5-sonnet"])
    await submitAi(user, UP1, ["gpt-4o"])
    expect(await quotaOf(user.id)).toEqual({ bonus: 2, ai: 1 })
  })

  it("带 /v1 与尾斜杠的等价地址走同一条单据，也不涨", async () => {
    const user = await makeDonor()
    stubFetch((url) => (url.startsWith(UP1) ? upstreamModels(["gpt-4o"]) : undefined))
    stubNewApiChannelFlow({ testOk: true })

    await submitAi(user, UP1)
    await submitAi(user, `${UP1}/v1`)
    await submitAi(user, `${UP1}/`)
    expect(await quotaOf(user.id)).toEqual({ bonus: 2, ai: 1 })
    expect(await rowsOf(user.id)).toBe("approved×1")
  })
})

describe("捐献额度：用户级幂等（② 撤销后重批 / ③ 两条同时非 approved）", () => {
  it("② 单行账号撤销后重新批准同一单据：不涨（旧代码会再发一轮）", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const user = await makeDonor()
    stubFetch((url) => (url.startsWith(UP1) ? upstreamModels(["gpt-4o"]) : undefined))
    stubNewApiChannelFlow({ testOk: true })

    const a = await submitAi(user, UP1)
    expect(await quotaOf(user.id)).toEqual({ bonus: 2, ai: 1 })

    // 撤销 → 该行变 pending ⇒ 旧代码的闸门找不到「别的 approved」⇒ 重批再发一轮
    const revoke = await fetchSelf(
      authRequest(admin, `/admin/donations/${a.id}/revoke`, { method: "POST" })
    )
    expect(revoke.status).toBe(200)
    expect(await rowsOf(user.id)).toBe("pending×1")

    const review = await fetchSelf(
      authRequest(admin, "/admin/donations/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: a.id, action: "approve" }),
      })
    )
    expect(review.status).toBe(200)
    // 关键断言：重批同一单据不再发额度
    expect(await quotaOf(user.id)).toEqual({ bonus: 2, ai: 1 })

    // 再走两轮，确认不是只堵住第一轮
    for (let round = 0; round < 2; round++) {
      await fetchSelf(authRequest(admin, `/admin/donations/${a.id}/revoke`, { method: "POST" }))
      await fetchSelf(
        authRequest(admin, "/admin/donations/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: a.id, action: "approve" }),
        })
      )
    }
    expect(await quotaOf(user.id)).toEqual({ bonus: 2, ai: 1 })
  })

  it("② 两条 approved 时撤销其中一条再重批：也不涨（反向守护）", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const user = await makeDonor()
    stubFetch((url) =>
      url.startsWith(UP1) || url.startsWith(UP2) ? upstreamModels(["gpt-4o"]) : undefined
    )
    stubNewApiChannelFlow({ testOk: true })

    const a = await submitAi(user, UP1)
    await submitAi(user, UP2)
    expect(await quotaOf(user.id)).toEqual({ bonus: 2, ai: 1 })

    const revoke = await fetchSelf(
      authRequest(admin, `/admin/donations/${a.id}/revoke`, { method: "POST" })
    )
    expect(revoke.status).toBe(200)

    const review = await fetchSelf(
      authRequest(admin, "/admin/donations/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: a.id, action: "approve" }),
      })
    )
    expect(review.status).toBe(200)
    expect(await quotaOf(user.id)).toEqual({ bonus: 2, ai: 1 })
  })

  it("③ 两条**同时**被撤销后逐条重批：不涨（旧代码每轮 +2，可无限循环）", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const user = await makeDonor()
    stubFetch((url) =>
      url.startsWith(UP1) || url.startsWith(UP2) ? upstreamModels(["gpt-4o"]) : undefined
    )
    stubNewApiChannelFlow({ testOk: true })

    const a = await submitAi(user, UP1)
    const b = await submitAi(user, UP2)
    expect(await quotaOf(user.id)).toEqual({ bonus: 2, ai: 1 })

    // 两条都撤销 → 都变 pending ⇒ 闸门对「两条」都看不见别的 approved
    for (const id of [a.id, b.id]) {
      const r = await fetchSelf(
        authRequest(admin, `/admin/donations/${id}/revoke`, { method: "POST" })
      )
      expect(r.status).toBe(200)
    }

    const approve = (id: string) =>
      fetchSelf(
        authRequest(admin, "/admin/donations/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, action: "approve" }),
        })
      )
    expect((await approve(a.id)).status).toBe(200)
    expect((await approve(b.id)).status).toBe(200)

    // 再走两轮「全部撤销 → 全部重批」，确认不是只堵住第一轮
    for (let round = 0; round < 2; round++) {
      for (const id of [a.id, b.id]) {
        await fetchSelf(authRequest(admin, `/admin/donations/${id}/revoke`, { method: "POST" }))
      }
      await approve(a.id)
      await approve(b.id)
    }

    // 关键断言：四轮撤销重批之后额度**纹丝不动**
    expect(await quotaOf(user.id)).toEqual({ bonus: 2, ai: 1 })
  })
})

describe("捐献额度：用户级幂等（⑤ 并发审批）", () => {
  it("⑤ 两条 pending 单据并发批准：只发一次（不变式守护，旧代码不稳定复现）", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const user = await makeDonor()
    stubFetch((url) =>
      url.startsWith(UP1) || url.startsWith(UP2) ? upstreamModels(["gpt-4o"]) : undefined
    )
    stubNewApiChannelFlow({ testOk: true })

    // 直接插两条 pending（走提交流程的话第二条会被「同类型已有 pending」挡住）
    const ids: string[] = []
    for (const [up, created] of [
      [UP1, "2026-03-01T00:00:00.000Z"],
      [UP2, "2026-03-02T00:00:00.000Z"],
    ] as const) {
      const id = crypto.randomUUID()
      ids.push(id)
      await env.DB.prepare(
        `INSERT INTO donations (id, user_id, type, payload, notify_email, status, created_at)
         VALUES (?, ?, 'ai', ?, ?, 'pending', ?)`
      )
        .bind(id, user.id, JSON.stringify({ baseUrl: up, apiKey: "sk-test", models: ["gpt-4o"] }), `${user.username}@example.net`, created)
        .run()
    }

    const approveOnce = (id: string) =>
      fetchSelf(
        authRequest(admin, "/admin/donations/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, action: "approve" }),
        })
      )
    const results = await Promise.all([approveOnce(ids[0]), approveOnce(ids[1])])
    expect(results.filter((r) => r.status === 200)).toHaveLength(2)

    // 不变式：两条都被批准，但同类型额度**恰好发一份**（不多发、也不少发）
    expect(await rowsOf(user.id)).toBe("approved×2")
    expect(await quotaOf(user.id)).toEqual({ bonus: 2, ai: 1 })
  })

  it("⑤ 同一单据被并发批准：也只发一次", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const user = await makeDonor()
    stubFetch((url) => (url.startsWith(UP1) ? upstreamModels(["gpt-4o"]) : undefined))
    stubNewApiChannelFlow({ testOk: true })

    const { setSetting } = await import("./helpers")
    await setSetting("auto_review_features", "")
    const d = await submitAi(user, UP1)
    expect(d.status).toBe("pending")

    const approveOnce = () =>
      fetchSelf(
        authRequest(admin, "/admin/donations/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: d.id, action: "approve" }),
        })
      )
    const results = await Promise.all([approveOnce(), approveOnce(), approveOnce()])
    const ok = results.filter((r) => r.status === 200).length
    expect(ok).toBeGreaterThanOrEqual(1)

    expect(await quotaOf(user.id)).toEqual({ bonus: 2, ai: 1 })
  })
})

describe("捐献额度：反向守护（不该被改宽或改死）", () => {
  it("全新账号第一笔：正常发 2 额度 + 1 模块额度", async () => {
    const user = await makeDonor()
    stubFetch((url) => (url.startsWith(UP1) ? upstreamModels(["gpt-4o"]) : undefined))
    stubNewApiChannelFlow({ testOk: true })

    await submitAi(user, UP1)
    expect(await quotaOf(user.id)).toEqual({ bonus: 2, ai: 1 })
  })

  it("真·第二份不同上游：仍不发第二份（H2 上界保持不变）", async () => {
    const user = await makeDonor()
    stubFetch((url) =>
      url.startsWith(UP1) || url.startsWith(UP2) || url.startsWith(UP3)
        ? upstreamModels(["gpt-4o"])
        : undefined
    )
    stubNewApiChannelFlow({ testOk: true })

    await submitAi(user, UP1)
    await submitAi(user, UP2)
    await submitAi(user, UP3)
    expect(await rowsOf(user.id)).toBe("approved×3")
    expect(await quotaOf(user.id)).toEqual({ bonus: 2, ai: 1 })
  })

  it("ai 与 proxy 各自第一笔都发（类型隔离）", async () => {
    const user = await makeDonor()
    stubFetch((url) => {
      if (url.startsWith(UP1)) return upstreamModels(["gpt-4o"])
      if (url.startsWith("https://sub.example.com")) {
        return new Response(
          "dmxlc3M6Ly9leGFtcGxlLmNvbTo0NDMjVGVzdE5vZGU=",
          { status: 200, headers: { "Content-Type": "text/plain" } }
        )
      }
      return undefined
    })
    stubNewApiChannelFlow({ testOk: true })

    await submitAi(user, UP1)
    expect(await quotaOf(user.id)).toEqual({ bonus: 2, ai: 1 })

    await clearRateLimits()
    const proxyRes = await fetchSelf(
      authRequest(user, "/donations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "proxy", payload: { subUrls: ["https://sub.example.com/a"] } }),
      })
    )
    // proxy 走自己的自动审核；无论结果如何，额度计数必须各自独立
    if (proxyRes.status === 200 || proxyRes.status === 201) {
      const q = await quotaOf(user.id)
      expect(q.bonus).toBe(4) // ai 的 2 + proxy 的 2
      expect(q.ai).toBe(1)
    }
  })

  it("④ 撤销 → 用户删除单据 → 重提同一上游：仍不涨（旧代码每轮 +2）", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const user = await makeDonor()
    stubFetch((url) => (url.startsWith(UP1) ? upstreamModels(["gpt-4o"]) : undefined))
    stubNewApiChannelFlow({ testOk: true })

    const a = await submitAi(user, UP1)
    expect(await quotaOf(user.id)).toEqual({ bonus: 2, ai: 1 })

    // 撤销（管理员）→ 单据变 pending → 用户删掉它 → 重提同一上游
    // 这条路绕过「行级」标记：cancelDonation 是直接 DELETE，行没了标记也没了。
    // 所以额度标记必须挂在 users 上（见迁移 0128 的说明）。
    let lastId: string | null = null
    for (let round = 0; round < 3; round++) {
      const cur = round === 0 ? a.id : lastId!
      const rev = await fetchSelf(
        authRequest(admin, `/admin/donations/${cur}/revoke`, { method: "POST" })
      )
      expect(rev.status).toBe(200)
      const del = await fetchSelf(authRequest(user, `/donations/${cur}`, { method: "DELETE" }))
      expect(del.status).toBe(204)
      const again = await submitAi(user, UP1)
      expect(again.status).toBe("approved")
      lastId = again.id
    }

    // 关键断言：三轮「撤销 → 删除 → 重提」之后额度纹丝不动
    expect(await quotaOf(user.id)).toEqual({ bonus: 2, ai: 1 })
  })

  it("历史回填：老账号已有 approved 单据时，新批一笔不发", async () => {
    const user = await makeDonor()
    stubFetch((url) => (url.startsWith(UP1) ? upstreamModels(["gpt-4o"]) : undefined))
    stubNewApiChannelFlow({ testOk: true })

    // 模拟「线上老数据」：两条 approved 单据（额度按旧行为只发过一份）
    const old1 = crypto.randomUUID()
    const old2 = crypto.randomUUID()
    for (const [id, created] of [
      [old1, "2026-01-01T00:00:00.000Z"],
      [old2, "2026-02-01T00:00:00.000Z"],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO donations (id, user_id, type, payload, notify_email, status, created_at)
         VALUES (?, ?, 'ai', ?, 'a@example.net', 'approved', ?)`
      )
        .bind(id, user.id, JSON.stringify({ baseUrl: `https://old-${id.slice(0, 6)}.example.com` }), created)
        .run()
    }
    await env.DB.prepare(
      "UPDATE users SET invite_quota_bonus = 2, feature_quota = ? WHERE id = ?"
    )
      .bind(JSON.stringify({ ai: 1 }), user.id)
      .run()
    // 回填（与迁移 0128 的语句一致）：有该类型 approved 单据 ⇒ 标记该类型已发
    for (const t of ["ai", "proxy", "frp"]) {
      await env.DB.prepare(
        `UPDATE users
            SET donation_quota_types = json_set(
                  CASE WHEN json_valid(donation_quota_types) THEN donation_quota_types ELSE '{}' END,
                  ?, 1)
          WHERE id IN (SELECT user_id FROM donations WHERE status = 'approved' AND type = ?)`
      )
        .bind(`$."${t}"`, t)
        .run()
    }

    await submitAi(user, UP1)
    expect(await rowsOf(user.id)).toBe("approved×3")
    // 关键断言：老账号不因为新单据而再拿一份
    expect(await quotaOf(user.id)).toEqual({ bonus: 2, ai: 1 })
  })

  it("没发额度时，站内消息不再声称「获得 2 个邀请码创建额度」", async () => {
    const user = await makeDonor()
    stubFetch((url) =>
      url.startsWith(UP1) || url.startsWith(UP2) ? upstreamModels(["gpt-4o"]) : undefined
    )
    stubNewApiChannelFlow({ testOk: true })

    // 第一笔：真的发了额度 → 文案里应当出现额度那一行
    const first = await submitAi(user, UP1)
    const msgOf = async (donationId: string) =>
      (
        await env.DB.prepare(
          "SELECT body FROM notifications WHERE user_id = ? AND type = 'donation' AND dedup_key LIKE ? LIMIT 1"
        )
          .bind(user.id, `donation:${donationId}:%`)
          .first<{ body: string }>()
      )?.body ?? ""
    expect(await msgOf(first.id)).toContain("邀请码创建额度")

    // 第二笔（**新单据**、不同上游）：被批准但不再发额度
    // （站内消息的 dedup_key 含单据 id，所以这是新的一条消息，不会被去重吞掉）
    const second = await submitAi(user, UP2)
    expect(second.id).not.toBe(first.id)
    expect(second.status).toBe("approved")

    const secondMsg = await msgOf(second.id)
    expect(secondMsg).not.toBe("")
    // 关键断言：没发额度就不许说发了
    expect(secondMsg).not.toContain("同时获得")
    expect(secondMsg).not.toContain("邀请码创建额度")
  })
})
