// 失败模型的重试与补全。
//
// 为什么单独一个文件：这条链路的真实风险是**会不会误删模型**和**会不会重复建渠道**。
// 前者是「当时抖了一下就被永久剔除」（本功能的起因），后者是「重试把管理员的
// 手工调整覆盖掉」。两者都只测纯函数覆盖不到。
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, setPermissions, type TestUser } from "./helpers"
import { classifyTestFailure } from "../src/donation-provision"
import { parsePermissions } from "../src/permissions"

const NEWAPI = "https://api.doulor.cn"
const UPSTREAM = "https://up.example.com"

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
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
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

beforeEach(() => {
  calls = []
})

afterEach(() => {
  for (let i = restores.length - 1; i >= 0; i--) restores[i]()
  restores = []
  vi.restoreAllMocks()
})

async function makeDonor(): Promise<TestUser> {
  const user = await makeUser()
  await env.DB.prepare("UPDATE users SET email = ? WHERE id = ?")
    .bind(`${user.username}@example.net`, user.id)
    .run()
  await setPermissions(user.id, JSON.stringify({ ai: false }))
  return user
}

async function readPerms(userId: string) {
  const row = await env.DB.prepare("SELECT permissions FROM users WHERE id = ?")
    .bind(userId)
    .first<{ permissions: string | null }>()
  return parsePermissions(row?.permissions)
}

/** 超时类失败消息（应归类为 uncertain） */
function timeoutMsg(model: string) {
  return `测试超时（超过 10 秒无响应）`
}

/**
 * 渠道接口打桩，失败消息可自定义（这是本文件与 donation-ai 那份的关键差别：
 * 那边只需要「成功/失败」，这边必须能造出**不同类别**的失败）。
 *
 * 返回一个控制器：`setTestOk` 可以在测试中途改测试结果，而**不重建打桩**
 * —— 重建会清掉渠道状态（created），而重试/补全的用例需要「渠道已存在」
 * 这个前提。这正是本文件最容易写错的地方。
 */
function stubChannelFlow(
  initialTestOk: boolean | ((model: string) => boolean),
  initialFailMessage?: (model: string) => string
) {
  let testOk = initialTestOk
  let failMessage = initialFailMessage
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
      const ok = typeof testOk === "function" ? testOk(model) : testOk
      return jsonResponse(
        ok
          ? { success: true, message: "", time: 0.4 }
          : {
              success: false,
              message: failMessage ? failMessage(model) : `上游不支持该模型（${model}）`,
              time: 0.1,
            }
      )
    }

    if (method === "POST" && url.endsWith("/api/channel/")) {
      const posted = findLastCall("POST")
      const ch = (posted?.body as { channel?: Record<string, unknown> })?.channel
      created = {
        id: 101,
        name: String(ch?.name ?? "捐献01"),
        type: Number(ch?.type ?? 1),
        status: 1,
        models: String(ch?.models ?? ""),
        model_mapping: String(ch?.model_mapping ?? ""),
        group: String(ch?.group ?? "default"),
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

    // ⚠️ 单查优先于列表：`GET /api/channel/:id` 的 data 是**单个渠道对象**，
    //    不是列表信封。列表那条用 includes 匹配，会连单查一起吞掉
    //    （2026-09-30：`getChannel()` 改成单查后必须先拦这一条）。
    const single = url.match(/\/api\/channel\/(\d+)(?:\?.*)?$/)
    if (method === "GET" && single && !url.includes("/api/channel/test/")) {
      const id = Number(single[1])
      if (created && created.id === id) {
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

  return {
    /** 改测试结果（不重建打桩，渠道状态保留） */
    setTestOk: (v: boolean | ((model: string) => boolean), msg?: (model: string) => string) => {
      testOk = v
      failMessage = msg
    },
    /** 预置一个已存在的渠道（模拟「捐献已通过、渠道已在」） */
    seedChannel: (models: string) => {
      created = {
        id: 101,
        name: "捐献01",
        type: 1,
        status: 1,
        models,
        model_mapping: "{}",
        group: "default",
        base_url: UPSTREAM,
        tag: "捐献",
      }
    },
  }
}

function findLastCall(method: string): Call | undefined {
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i]
    if (c.method === method && c.url.endsWith("/api/channel/")) return c
  }
  return undefined
}

function upstreamModels(models: string[]): Response {
  return jsonResponse({ object: "list", data: models.map((id) => ({ id })) })
}

async function submitAiDonation(user: TestUser, models: string[]) {
  const res = await fetchSelf(
    authRequest(user, "/donations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "ai", payload: { baseUrl: UPSTREAM, apiKey: "sk-test", models } }),
    })
  )
  return {
    res,
    body: (await res.json()) as {
      id: string
      status: string
      channelId: number | null
      reviewNote: string | null
    },
  }
}

/** 读某笔捐献的重试记录（按 donation_id 精确查，不依赖全表） */
async function readRetries(donationId: string) {
  const r = await env.DB.prepare(
    "SELECT model, status, attempts, next_retry_at FROM donation_model_retries WHERE donation_id = ? ORDER BY model"
  )
    .bind(donationId)
    .all<{ model: string; status: string; attempts: number; next_retry_at: string }>()
  return r.results ?? []
}

// ---- 分类：整个功能的立足点 ----

describe("classifyTestFailure", () => {
  it("限流 / 超时 / 网络 → uncertain（不能证明模型不可用）", () => {
    for (const m of [
      "HTTP 429",
      "rate limit exceeded",
      "请求过频，请稍后再试",
      "测试超时（超过 10 秒无响应）",
      "fetch failed",
      "ECONNRESET",
      "socket hang up",
    ]) {
      expect(classifyTestFailure(m), m).toBe("uncertain")
    }
  })

  it("鉴权 / 模型不存在 → failed（重试也不会好）", () => {
    for (const m of [
      "HTTP 401",
      "HTTP 403",
      "invalid api key",
      "无可用渠道",
      "上游不支持该模型（gpt-4o）",
      "model not found",
      "模型不存在",
    ]) {
      expect(classifyTestFailure(m), m).toBe("failed")
    }
  })

  it("认不出来的一律按 uncertain —— 宁留不删", () => {
    // 误删一个本来可用的模型（要人工重新拉取才能补回）比留一个暂时不可用的
    // 模型（重试任务会兜底）代价大得多
    expect(classifyTestFailure("未知错误 xyz")).toBe("uncertain")
    expect(classifyTestFailure("")).toBe("uncertain")
  })
})

// ---- 收尾规则：三种情形 ----

describe("收尾规则", () => {
  it("部分通过 + 部分不确定 → 渠道保留 passed+uncertain，失败模型落库", async () => {
    const user = await makeDonor()
    stubFetch((url) => (url.startsWith(UPSTREAM) ? upstreamModels(["good", "slow", "slow2"]) : undefined))
    const flow = stubChannelFlow((m) => m === "good", timeoutMsg)

    const { body } = await submitAiDonation(user, ["good", "slow", "slow2"])
    expect(body.status).toBe("approved")
    expect(body.channelId).toBe(101)

    // 渠道里保留了「通过 + 不确定」的全部 3 个模型
    const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/api/channel/"))
    const sent = put?.body as { models: string } | undefined
    expect(sent).toBeUndefined() // 没剔除任何模型 → 根本不需要 PUT

    const createCall = calls.find((c) => c.method === "POST" && c.url.includes("/api/channel/"))
    const channel = (createCall?.body as { channel: Record<string, unknown> }).channel
    expect(String(channel.models).split(",").sort()).toEqual([
      "donation-good",
      "donation-slow",
      "donation-slow2",
    ])

    // 两个不确定的模型落库待重试
    const retries = await readRetries(body.id)
    expect(retries.map((r) => r.model).sort()).toEqual(["slow", "slow2"])
    expect(retries.every((r) => r.status === "uncertain")).toBe(true)
    expect(retries.every((r) => r.attempts === 0)).toBe(true)
    // 首次重试排在 1 小时后（不是立刻，避免刚失败就重试）
    expect(new Date(retries[0].next_retry_at).getTime()).toBeGreaterThan(Date.now())
  })

  it("确定失败的模型被剔除，但仍落库（一次调用不足以定论）", async () => {
    const user = await makeDonor()
    stubFetch((url) => (url.startsWith(UPSTREAM) ? upstreamModels(["good", "bad"]) : undefined))
    // 默认失败消息是「上游不支持该模型（x）」→ failed
    stubChannelFlow((m) => m === "good")

    const { body } = await submitAiDonation(user, ["good", "bad"])
    expect(body.status).toBe("approved")

    // 渠道里被剔除
    const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/api/channel/"))
    const sent = put?.body as { models: string } | undefined
    expect(sent?.models).toBe("donation-good")

    // 但仍落库、状态是 failed —— 「这一次调用报 401/模型不存在」不足以证明
    // 永久不可用（上游可能只是当时配错了），重试一次代价很小，比人工重新拉取便宜
    const retries = await readRetries(body.id)
    expect(retries.map((r) => r.model)).toEqual(["bad"])
    expect(retries[0].status).toBe("failed")
  })

  it("**全部不确定** → 渠道刻意保留、转人工 pending、channelId 落库", async () => {
    const user = await makeDonor()
    stubFetch((url) => (url.startsWith(UPSTREAM) ? upstreamModels(["slow", "slow2"]) : undefined))
    stubChannelFlow(false, timeoutMsg)

    const { body } = await submitAiDonation(user, ["slow", "slow2"])
    // 既不是通过也不是拒绝 —— 待人工
    expect(body.status).toBe("pending")
    // 关键：渠道被保留，id 落进单据（管理员复核通过时直接复用，不会重复建）
    expect(body.channelId).toBe(101)

    const row = await env.DB.prepare(
      "SELECT status, newapi_channel_id FROM donations WHERE id = ?"
    )
      .bind(body.id)
      .first<{ status: string; newapi_channel_id: number | null }>()
    expect(row?.status).toBe("pending")
    expect(row?.newapi_channel_id).toBe(101)

    // 渠道没被删（这正是「保留」的含义）
    expect(calls.some((c) => c.method === "DELETE")).toBe(false)
    // 权限没解锁（未验证的渠道不能自动放行）
    expect((await readPerms(user.id)).ai).toBe(false)

    const retries = await readRetries(body.id)
    expect(retries).toHaveLength(2)
  })

  it("全部确定失败 → 删渠道但**转人工**（不自动拒绝，由人工定案）", async () => {
    const user = await makeDonor()
    stubFetch((url) => (url.startsWith(UPSTREAM) ? upstreamModels(["bad1", "bad2"]) : undefined))
    stubChannelFlow(false)

    const { body } = await submitAiDonation(user, ["bad1", "bad2"])
    // 2026-09-25 起：自动判断失败不再直接算失败（用户明确要求人工确认）
    expect(body.status).toBe("pending")
    expect(body.channelId).toBeNull()
    expect(calls.some((c) => c.method === "DELETE")).toBe(true)
    expect(await readRetries(body.id)).toEqual([])
  })
})

// ---- 重试 ----

/** 直接插一条重试记录（免去走一遍完整捐献流程） */
async function seedRetry(opts: {
  donationId: string
  model: string
  channelId: number
  status?: string
  attempts?: number
  nextRetryAt?: string
}) {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO donation_model_retries
       (donation_id, model, channel_id, status, reason, attempts, last_tried_at, next_retry_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      opts.donationId,
      opts.model,
      opts.channelId,
      opts.status ?? "uncertain",
      "测试超时",
      opts.attempts ?? 0,
      now,
      opts.nextRetryAt ?? now,
      now
    )
    .run()
}

/** 造一笔捐献（只为给它挂重试记录） */
async function seedDonation(
  user: TestUser,
  channelId: number,
  status = "approved"
): Promise<string> {
  const id = `d_${Math.random().toString(36).slice(2, 10)}`
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO donations (id, user_id, type, payload, notify_email, status, newapi_channel_id, created_at)
     VALUES (?, ?, 'ai', ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      user.id,
      JSON.stringify({ baseUrl: UPSTREAM, apiKey: "sk-test", models: ["slow"] }),
      `${user.username}@example.net`,
      status,
      channelId,
      now
    )
    .run()
  return id
}

describe("POST /admin/donations/:id/retry-models", () => {
  it("模型恢复 → 并回渠道且标 recovered", async () => {
    const admin = await makeUser({ role: "admin" })
    const donor = await makeDonor()
    // 先建好渠道状态（seedChannel 不重建打桩，改 testOk 不会丢渠道）
    const flow = stubChannelFlow(true)
    flow.seedChannel("donation-good")
    const id = await seedDonation(donor, 101)
    await seedRetry({ donationId: id, model: "slow", channelId: 101 })

    const res = await fetchSelf(
      authRequest(admin, `/admin/donations/${id}/retry-models`, { method: "POST" })
    )
    expect(res.status).toBe(200)
    const out = (await res.json()) as { ok: boolean; recovered: string[]; message: string }
    expect(out.recovered).toEqual(["slow"])

    const retries = await readRetries(id)
    expect(retries[0].status).toBe("recovered")

    // 模型被 PUT 并回渠道（只加不删：原有的 donation-good 还在）
    const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/api/channel/"))
    const sent = put?.body as { models: string } | undefined
    expect(sent?.models?.split(",").sort()).toEqual(["donation-good", "slow"])
  })

  it("模型恢复 → 「全不确定转人工」的单据被自动放行", async () => {
    const admin = await makeUser({ role: "admin" })
    const donor = await makeDonor()
    const flow = stubChannelFlow(true)
    flow.seedChannel("donation-good")
    // 「转人工」单据的特征：status=pending + channel_id 有值
    const id = await seedDonation(donor, 101, "pending")
    await seedRetry({ donationId: id, model: "slow", channelId: 101 })

    const res = await fetchSelf(
      authRequest(admin, `/admin/donations/${id}/retry-models`, { method: "POST" })
    )
    const out = (await res.json()) as { recovered: string[]; promoted: boolean }
    expect(out.recovered).toEqual(["slow"])
    expect(out.promoted).toBe(true)

    // 单据被推进到 approved，权限也解锁了
    const row = await env.DB.prepare("SELECT status, review_note FROM donations WHERE id = ?")
      .bind(id)
      .first<{ status: string; review_note: string | null }>()
    expect(row?.status).toBe("approved")
    expect(row?.review_note).toContain("自动通过")
    expect((await readPerms(donor.id)).ai).toBe(true)
  })

  it("模型恢复但单据已是 approved → 不重复推进（幂等）", async () => {
    const admin = await makeUser({ role: "admin" })
    const donor = await makeDonor()
    const flow = stubChannelFlow(true)
    flow.seedChannel("donation-good")
    const id = await seedDonation(donor, 101, "approved")
    await seedRetry({ donationId: id, model: "slow", channelId: 101 })

    const res = await fetchSelf(
      authRequest(admin, `/admin/donations/${id}/retry-models`, { method: "POST" })
    )
    const out = (await res.json()) as { recovered: string[]; promoted: boolean }
    expect(out.recovered).toEqual(["slow"])
    expect(out.promoted).toBe(false)
  })

  it("仍失败 → attempts+1 且下次重试时间往后推", async () => {
    const admin = await makeUser({ role: "admin" })
    const donor = await makeDonor()
    const flow = stubChannelFlow(false, timeoutMsg)
    flow.seedChannel("donation-good")
    const id = await seedDonation(donor, 101)
    await seedRetry({ donationId: id, model: "slow", channelId: 101 })

    const res = await fetchSelf(
      authRequest(admin, `/admin/donations/${id}/retry-models`, { method: "POST" })
    )
    const out = (await res.json()) as { stillUncertain: number }
    expect(out.stillUncertain).toBe(1)

    const retries = await readRetries(id)
    expect(retries[0].status).toBe("uncertain")
    expect(retries[0].attempts).toBe(1)
    expect(new Date(retries[0].next_retry_at).getTime()).toBeGreaterThan(Date.now())
  })

  it("渠道已不存在（捐献被撤销）→ 直接放弃，不反复试", async () => {
    const admin = await makeUser({ role: "admin" })
    const donor = await makeDonor()
    // 打桩但不 seed 渠道 → listChannels 返回空 → 渠道不存在
    stubChannelFlow(true)
    const id = await seedDonation(donor, 999) // 指向一个不存在的渠道
    await seedRetry({ donationId: id, model: "slow", channelId: 999 })

    const res = await fetchSelf(
      authRequest(admin, `/admin/donations/${id}/retry-models`, { method: "POST" })
    )
    const out = (await res.json()) as { exhausted: number }
    expect(out.exhausted).toBe(1)

    const retries = await readRetries(id)
    expect(retries[0].status).toBe("exhausted")
    // 没发任何 test 请求
    expect(calls.some((c) => c.url.includes("/api/channel/test/"))).toBe(false)
  })

  it("重试次数用尽 → exhausted，不再入选", async () => {
    const admin = await makeUser({ role: "admin" })
    const donor = await makeDonor()
    const flow = stubChannelFlow(false, timeoutMsg)
    flow.seedChannel("donation-good")
    const id = await seedDonation(donor, 101)
    // attempts 已经是 4（下一次就是第 5 次，退避表长度 5 → 用尽）
    await seedRetry({ donationId: id, model: "slow", channelId: 101, attempts: 4 })

    const res = await fetchSelf(
      authRequest(admin, `/admin/donations/${id}/retry-models`, { method: "POST" })
    )
    const out = (await res.json()) as { exhausted: number }
    expect(out.exhausted).toBe(1)

    const retries = await readRetries(id)
    expect(retries[0].status).toBe("exhausted")
  })

  it("没有待重试的模型 → 明确告知，不报错", async () => {
    const admin = await makeUser({ role: "admin" })
    const donor = await makeDonor()
    const id = await seedDonation(donor, 101)

    const res = await fetchSelf(
      authRequest(admin, `/admin/donations/${id}/retry-models`, { method: "POST" })
    )
    expect(res.status).toBe(200)
    const out = (await res.json()) as { message: string }
    expect(out.message).toContain("没有待重试")
  })
})

// ---- 补全（救历史单）----

describe("POST /admin/donations/:id/refetch-models", () => {
  it("上游有、渠道没有的模型被验证并补进渠道", async () => {
    const admin = await makeUser({ role: "admin" })
    const donor = await makeDonor()
    // 渠道里只有 good，上游还有 recovered（历史单当时被剔除的）
    const flow = stubChannelFlow((m) => m === "recovered" || m === "donation-good")
    flow.seedChannel("donation-good")
    const id = await seedDonation(donor, 101)

    stubFetch((url) =>
      url.startsWith(UPSTREAM) ? upstreamModels(["good", "recovered"]) : undefined
    )

    const res = await fetchSelf(
      authRequest(admin, `/admin/donations/${id}/refetch-models`, { method: "POST" })
    )
    expect(res.status).toBe(200)
    const out = (await res.json()) as { ok: boolean; added: string[]; message: string }
    expect(out.ok, JSON.stringify(out)).toBe(true)
    expect(out.added).toEqual(["recovered"])

    // 并回渠道（原有模型保留）
    const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/api/channel/"))
    const sent = put?.body as { models: string } | undefined
    expect(sent?.models?.split(",").sort()).toEqual(["donation-good", "recovered"])
  })

  it("补不回来的模型落库，交给定时重试", async () => {
    const admin = await makeUser({ role: "admin" })
    const donor = await makeDonor()
    const flow = stubChannelFlow((m) => m !== "still-broken", timeoutMsg)
    flow.seedChannel("donation-good")
    const id = await seedDonation(donor, 101)

    stubFetch((url) =>
      url.startsWith(UPSTREAM) ? upstreamModels(["good", "still-broken"]) : undefined
    )

    const res = await fetchSelf(
      authRequest(admin, `/admin/donations/${id}/refetch-models`, { method: "POST" })
    )
    const out = (await res.json()) as {
      added: string[]
      stillMissing: { model: string }[]
    }
    expect(out.added).toEqual([])
    expect(out.stillMissing.map((m) => m.model)).toEqual(["still-broken"])

    // 落库了 → 下次不用管理员再点
    const retries = await readRetries(id)
    expect(retries.map((r) => r.model)).toEqual(["still-broken"])
  })

  it("渠道已含上游全部模型 → 明确说「无需补全」，不发测试请求", async () => {
    const admin = await makeUser({ role: "admin" })
    const donor = await makeDonor()
    const flow = stubChannelFlow(true)
    flow.seedChannel("donation-good")
    const id = await seedDonation(donor, 101)

    stubFetch((url) => (url.startsWith(UPSTREAM) ? upstreamModels(["good"]) : undefined))

    const res = await fetchSelf(
      authRequest(admin, `/admin/donations/${id}/refetch-models`, { method: "POST" })
    )
    const out = (await res.json()) as { ok: boolean; message: string }
    expect(out.ok).toBe(true)
    expect(out.message).toContain("无需补全")
    expect(calls.some((c) => c.url.includes("/api/channel/test/"))).toBe(false)
  })

  it("普通用户不能调用（403）", async () => {
    const user = await makeDonor()
    const id = await seedDonation(user, 101)
    const res = await fetchSelf(
      authRequest(user, `/admin/donations/${id}/refetch-models`, { method: "POST" })
    )
    expect(res.status).toBe(403)
  })
})
