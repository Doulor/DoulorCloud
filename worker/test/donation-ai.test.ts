// AI 渠道捐献自动化：探测上游 → 建渠道 → 逐个模型测试 → 自动通过 / 转人工。
//
// ⚠️ 2026-09-25 起**不再自动拒绝**：用户明确要求「自动判断错了的不能直接算失败，
// 应该由人工手动审核确定失败才算失败」。只有 definitive 的失败（失败原因只关乎
// 我们自己的输入规则，如模型名全部非法）才自动拒绝，其余一律 pending 转人工。
// 因此本文件里「失败」场景断言的都是 `pending` 而不是 `rejected`。
//
// 这些用例用打桩的 fetch 跑完整 HTTP 流程，因为这条链路的真实风险不在于
// 某个函数算错，而在于**状态机**：谁解锁了权限、失败时有没有留下半坏的渠道、
// 撤销时资源有没有真的收回。只测纯函数覆盖不到这些。
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, setPermissions, setSetting, type TestUser } from "./helpers"
import { normalizeBaseUrl, probeUpstream, validateUpstreamUrl } from "../src/donation-provision"
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
/** 每个 stub 的还原函数；按**后进先出**还原，避免链式打桩互相覆盖 */
let restores: Array<() => void> = []

/** 打桩：上游 + NewAPI 一起接管；未被接管的请求回落真实 fetch */
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

function upstreamModels(models: string[]): Response {
  return jsonResponse({ object: "list", data: models.map((id) => ({ id })) })
}

beforeEach(() => {
  calls = []
})

afterEach(() => {
  // 后进先出还原，否则会残留上一层 stub 影响下一个用例
  for (let i = restores.length - 1; i >= 0; i--) restores[i]()
  restores = []
  vi.restoreAllMocks()
})

/**
 * 造一个可捐献的用户。
 * 显式把 permissions 设成「只有 ai 关着」——真实注册路径会按邀请码写入显式权限，
 * 而 permissions 为 NULL 时 `parsePermissions` 视作**全开**，那样就测不出「捐献解锁」。
 */
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

async function readDonation(id: string) {
  return env.DB.prepare("SELECT * FROM donations WHERE id = ?")
    .bind(id)
    .first<{
      status: string
      review_note: string | null
      newapi_channel_id: number | null
      auto_reviewed: number
      granted_feature: number | null
    }>()
}

// ---- 纯函数 ----

describe("normalizeBaseUrl / validateUpstreamUrl", () => {
  it("去掉尾部斜杠与多余的 /v1，避免出现 /v1/v1", () => {
    expect(normalizeBaseUrl("https://api.x.com/")).toBe("https://api.x.com")
    expect(normalizeBaseUrl("https://api.x.com/v1")).toBe("https://api.x.com")
    expect(normalizeBaseUrl("https://api.x.com/v1/")).toBe("https://api.x.com")
    expect(normalizeBaseUrl("https://api.x.com/openai")).toBe("https://api.x.com/openai")
  })

  it("拒绝本机与内网地址（这是个 SSRF 面）", () => {
    for (const bad of [
      "http://localhost:11434",
      "http://127.0.0.1:8080",
      "http://10.0.0.5",
      "http://192.168.1.1",
      "http://172.16.3.4",
      "http://169.254.169.254",
    ]) {
      expect(() => validateUpstreamUrl(bad), bad).toThrow()
    }
    expect(validateUpstreamUrl("https://api.x.com").host).toBe("api.x.com")
  })

  it("拒绝非 http(s) 协议", () => {
    expect(() => validateUpstreamUrl("file:///etc/passwd")).toThrow()
    expect(() => validateUpstreamUrl("ftp://a.com")).toThrow()
  })
})

describe("probeUpstream", () => {
  it("成功时返回模型列表并识别为 OpenAI 兼容", async () => {
    stubFetch((url) =>
      url.startsWith(`${UPSTREAM}/v1/models`) ? upstreamModels(["b-model", "a-model"]) : undefined
    )
    const res = await probeUpstream("https://up.example.com/v1", "sk-test")
    expect(res.ok).toBe(true)
    expect(res.baseUrl).toBe(UPSTREAM)
    expect(res.channelType).toBe(1)
    expect(res.models).toEqual(["a-model", "b-model"])
  })

  it("接口不可达时不算成功", async () => {
    stubFetch((url) => (url.startsWith(UPSTREAM) ? jsonResponse({}, 404) : undefined))
    const res = await probeUpstream(UPSTREAM, "sk-test")
    expect(res.ok).toBe(false)
    expect(res.models).toEqual([])
    // 要把两种格式各自的报错都说清楚，用户才知道该换哪个
    expect(res.message).toContain("无法从该地址读到模型列表")
    expect(res.message).toContain("OpenAI 兼容")
    expect(res.message).toContain("Anthropic")
  })
})

// ---- HTTP 流程 ----

describe("POST /donations/ai/probe", () => {
  it("未登录返回 401", async () => {
    const res = await fetchSelf(
      new Request("https://cloud.doulor.cn/donations/ai/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: UPSTREAM, apiKey: "sk" }),
      })
    )
    expect(res.status).toBe(401)
  })

  it("登录后返回模型列表", async () => {
    const user = await makeDonor()
    stubFetch((url) =>
      url.startsWith(`${UPSTREAM}/v1/models`) ? upstreamModels(["gpt-4o", "gpt-4o-mini"]) : undefined
    )
    const res = await fetchSelf(
      authRequest(user, "/donations/ai/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: UPSTREAM, apiKey: "sk-test" }),
      })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; models: string[] }
    expect(body.ok).toBe(true)
    expect(body.models).toContain("gpt-4o")
  })
})

/**
 * 让 NewAPI 的渠道接口全部工作，测试结果可控。
 *
 * ⚠️ 列表接口必须**回显真正建出来的那个渠道**（名字从 POST body 里取）：
 * 渠道序号是按本库「曾接入过的捐献笔数」推进的，跨用例会变（捐献01 → 捐献02），
 * 写死名字会让「建完再按名字定位」这一步找不到，测试就会假失败。
 */
function stubNewApiChannelFlow(opts: {
  /** true/false 对全部模型一致；传函数则按模型名逐个决定（用于「部分可用」场景） */
  testOk: boolean | ((model: string) => boolean)
  /** 模拟「中转站建渠道接口报错」——平台侧故障，用于验证不得据此拒绝用户 */
  failCreate?: boolean
}) {
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
      const ok =
        typeof opts.testOk === "function" ? opts.testOk(model) : opts.testOk
      return jsonResponse(
        ok
          ? { success: true, message: "", time: 0.4 }
          : { success: false, message: `上游不支持该模型（${model}）`, time: 0.1 }
      )
    }

    if (method === "POST" && url.endsWith("/api/channel/")) {
      if (opts.failCreate) {
        return jsonResponse({ success: false, message: "database is locked" }, 500)
      }
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

    // 剔除不可用模型走的是 PUT（只传 id/models/model_mapping）
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
}

/** 取最后一次指定方法的 /api/channel/ 调用（stub 需要在 handler 内读它） */
function findLastCall(method: string): Call | undefined {
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i]
    if (c.method === method && c.url.endsWith("/api/channel/")) return c
  }
  return undefined
}

async function submitAiDonation(user: TestUser, baseUrl = UPSTREAM, models = ["gpt-4o"]) {
  const res = await fetchSelf(
    authRequest(user, "/donations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "ai", payload: { baseUrl, apiKey: "sk-test", models } }),
    })
  )
  return { res, body: (await res.json()) as {
    id: string
    status: string
    channelId: number | null
    autoReviewed: boolean
    reviewNote: string | null
    voucherCode?: string | null
  } }
}

describe("POST /donations —— AI 自动接入", () => {
  it("测试通过 → 自动批准、解锁 ai 权限、记录渠道 id", async () => {
    const user = await makeDonor()
    stubFetch((url) => (url.startsWith(UPSTREAM) ? upstreamModels(["gpt-4o"]) : undefined))
    stubNewApiChannelFlow({ testOk: true })

    const { res, body } = await submitAiDonation(user, `${UPSTREAM}/v1`)
    expect(res.status).toBe(200)
    expect(body.status).toBe("approved")
    expect(body.autoReviewed).toBe(true)
    expect(body.channelId).toBe(101)

    const perms = await readPerms(user.id)
    expect(perms.ai).toBe(true)

    const row = await readDonation(body.id)
    expect(row?.status).toBe("approved")
    expect(row?.auto_reviewed).toBe(1)
    expect(row?.newapi_channel_id).toBe(101)

    // 建渠道时模型名带 donation- 前缀，映射方向是「别名 → 上游真实名」，
    // 而且 baseUrl 已被归一化（没有 /v1）
    const createCall = calls.find((c) => c.method === "POST" && c.url.includes("/api/channel/"))
    const channel = (createCall?.body as { channel: Record<string, unknown> }).channel
    expect(channel.models).toBe("donation-gpt-4o")
    expect(channel.base_url).toBe(UPSTREAM)
    expect(JSON.parse(channel.model_mapping as string)).toEqual({ "donation-gpt-4o": "gpt-4o" })
    // 统一打上标签，NewAPI 的「标签模式」下就是一个自成一组的「文件夹」
    expect(channel.tag).toBe("捐献")
  })

  it("关闭 donation_grant_ai 后，捐献照常通过、但不再解锁 ai 权限", async () => {
    await setSetting("donation_grant_ai", "0")
    try {
      const user = await makeDonor()
      stubFetch((url) => (url.startsWith(UPSTREAM) ? upstreamModels(["gpt-4o"]) : undefined))
      stubNewApiChannelFlow({ testOk: true })

      const { res, body } = await submitAiDonation(user, `${UPSTREAM}/v1`)
      expect(res.status).toBe(200)
      // 捐献本身仍然通过（资源照收、渠道照建），只是权限不再授予
      expect(body.status).toBe("approved")

      const perms = await readPerms(user.id)
      expect(perms.ai).toBe(false)

      const row = await readDonation(body.id)
      expect(row?.status).toBe("approved")
      // granted_feature 记 0：没授予，撤销时也不会去收回
      expect(row?.granted_feature).toBe(0)
    } finally {
      await setSetting("donation_grant_ai", "1")
    }
  })

  it("全部模型都测不过 → **不自动拒绝**，转人工复核；半坏的渠道仍要删掉", async () => {
    const user = await makeDonor()
    stubFetch((url) => (url.startsWith(UPSTREAM) ? upstreamModels(["gpt-4o", "gpt-4o-mini"]) : undefined))
    stubNewApiChannelFlow({ testOk: false })

    const { body } = await submitAiDonation(user, UPSTREAM, ["gpt-4o", "gpt-4o-mini"])
    // 用户的明确要求（2026-09-25）：「自动判断错了的不能直接算失败，
    // 应该由人工手动审核确定失败才算失败」。上游的报错文案可能只是这次不巧
    // （实测过：同一上游 OpenAI 路径被 403、Anthropic 路径正常）。
    expect(body.status).toBe("pending")
    expect(body.channelId).toBeNull()
    expect(body.reviewNote).toContain("全部未通过可用性测试")
    expect(body.reviewNote).toContain("转人工复核")
    // 每个模型各自的失败原因都要带给管理员，否则没法判断是 key 错还是个别模型不可用
    expect(body.reviewNote).toContain("gpt-4o")
    expect(body.reviewNote).toContain("gpt-4o-mini")

    const perms = await readPerms(user.id)
    expect(perms.ai).toBe(false)

    const row = await readDonation(body.id)
    expect(row?.status).toBe("pending")
    expect(row?.auto_reviewed).toBe(1)
    expect(row?.newapi_channel_id).toBeNull()

    // 但渠道不能留在 NewAPI 里：它全是坏模型，会让模型列表出现
    // 「看着能用、一调就报错」的条目。删掉后管理员复核通过时会重建。
    expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/api/channel/"))).toBe(true)
  })

  it("中转站建渠道失败（平台侧故障）→ 转人工，绝不判用户失败", async () => {
    const user = await makeDonor()
    stubFetch((url) => (url.startsWith(UPSTREAM) ? upstreamModels(["gpt-4o"]) : undefined))
    stubNewApiChannelFlow({ testOk: true, failCreate: true })

    const { body } = await submitAiDonation(user)
    expect(body.status).toBe("pending")
    expect(String(body.reviewNote)).toContain("创建渠道失败")
    expect(String(body.reviewNote)).toContain("转人工复核")
    expect((await readPerms(user.id)).ai).toBe(false)
    const row = await readDonation(body.id)
    expect(row?.status).toBe("pending")
    expect(row?.newapi_channel_id).toBeNull()
  })

  it("只有部分模型可用 → 只把可用的留在渠道里（PUT 剔除坏的）", async () => {
    const user = await makeDonor()
    stubFetch((url) =>
      url.startsWith(UPSTREAM) ? upstreamModels(["good-a", "bad-b", "good-c"]) : undefined
    )
    // 只有 good-* 能过
    stubNewApiChannelFlow({ testOk: (m) => m.startsWith("good-") })

    const { body } = await submitAiDonation(user, UPSTREAM, ["good-a", "bad-b", "good-c"])
    expect(body.status).toBe("approved")
    expect(body.channelId).toBe(101)
    // 结论里要说明剔掉了什么
    expect(body.reviewNote).toContain("2/3")
    expect(body.reviewNote).toContain("bad-b")

    // 渠道最终只含可用的两个模型
    const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/api/channel/"))
    expect(put).toBeTruthy()
    const sent = put?.body as { models: string; model_mapping: string; id: number }
    expect(sent.id).toBe(101)
    expect(sent.models.split(",").sort()).toEqual(["donation-good-a", "donation-good-c"])
    expect(JSON.parse(sent.model_mapping)).toEqual({
      "donation-good-a": "good-a",
      "donation-good-c": "good-c",
    })
    // 刻意只传这三个字段：NewAPI 的 UpdateChannel 会拒绝 body 里带 status
    expect(Object.keys(sent).sort()).toEqual(["id", "model_mapping", "models"])

    // 通过了就该解锁
    expect((await readPerms(user.id)).ai).toBe(true)
  })

  it("模型数超过上限 → 400，且不建任何渠道", async () => {
    const user = await makeDonor()
    stubNewApiChannelFlow({ testOk: true })
    const many = Array.from({ length: 31 }, (_, i) => `m${i}`)
    const { res, body } = await submitAiDonation(user, UPSTREAM, many)
    expect(res.status).toBe(400)
    expect(body).toMatchObject({ code: "TOO_MANY_MODELS" })
    expect(calls.some((c) => c.url.includes("/api/channel/"))).toBe(false)
  })

  it("内网地址在提交阶段就被拒（400，且不建任何渠道）", async () => {
    const user = await makeDonor()
    stubNewApiChannelFlow({ testOk: true })
    const { res } = await submitAiDonation(user, "http://127.0.0.1:11434")
    expect(res.status).toBe(400)
    expect(calls.some((c) => c.url.includes("/api/channel/"))).toBe(false)
  })

  it("同一上游重复提交 → 覆盖（不再 409）", async () => {
    const user = await makeDonor()
    stubFetch((url) => (url.startsWith(UPSTREAM) ? upstreamModels(["gpt-4o"]) : undefined))
    stubNewApiChannelFlow({ testOk: true })

    const first = await submitAiDonation(user)
    expect(first.res.status).toBe(200)
    // 第二次提交同一上游：不再被「已提交过」挡住，而是**覆盖**同一条单据
    // （2026-10-05 站长要求：同一用户同一上游地址让它覆盖）
    const second = await submitAiDonation(user)
    expect(second.res.status).toBe(200)
    expect(second.body.id).toBe(first.body.id) // 同一条（覆盖），不是新建
    const cnt = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM donations WHERE user_id = ? AND type = 'ai'"
    )
      .bind(user.id)
      .first<{ c: number }>()
    expect(cnt?.c).toBe(1)
  })

  // ---- 防重复校验的实现方式（2026-09-30 线上事故）----
  //
  // 这两条锁的不是「重复被拒」本身，而是**判定方式**：
  //   旧写法 `payload LIKE '%"baseUrl":"<地址>"%'` 有两个致命问题 ——
  //   ① D1 的 LIKE 模式上限只有 50 字符，固定前缀 `%"baseUrl":"` + `"%` 占 15 个，
  //      **地址一过 35 字符就报 `LIKE or GLOB pattern too complex` ⇒ 500**，
  //      且校验在 INSERT 之前，单子根本进不了库（管理端查不到任何痕迹）。
  //      线上被 `https://opc.fiime.cn/api/model-service`（38 字符）触发。
  //   ② `_` / `%` 是 LIKE 通配符，地址里带它们会误判。
  // ⚠️ ①在本地 miniflare 复现不了（本地 SQLite 上限是 50000），只有线上才会炸；
  //    所以这里能真正守住的是 ②，①靠 sql-like.test.ts 的护栏 + 线上回顾。

  it("长上游地址（>35 字符）能正常提交，不再 500", async () => {
    const user = await makeDonor()
    // 与线上那次事故完全一致的地址（38 字符）
    const longUrl = "https://opc.fiime.cn/api/model-service"
    stubFetch((url) => (url.startsWith(longUrl) ? upstreamModels(["gpt-4o"]) : undefined))
    stubNewApiChannelFlow({ testOk: true })

    const { res } = await submitAiDonation(user, longUrl)
    expect(res.status).toBeLessThan(400)

    // 同一个长地址再提一次：仍能走到比对逻辑（覆盖，不再 500 —— 也不再有 409）
    const second = await submitAiDonation(user, longUrl)
    expect(second.res.status).toBeLessThan(400)
  })

  it("上游地址里的 `_` 不再被当成 LIKE 通配符（旧写法会误判成重复）", async () => {
    const user = await makeDonor()
    stubFetch((url) =>
      url.startsWith("https://abc.") || url.startsWith("https://a_c.")
        ? upstreamModels(["gpt-4o"])
        : undefined
    )
    stubNewApiChannelFlow({ testOk: true })

    const first = await submitAiDonation(user, "https://abc.example.com")
    expect(first.res.status).toBeLessThan(400)

    // `a_c` 与已存的 `abc` 只差一个字符，而 LIKE 里 `_` 匹配任意单字符 ⇒
    // 旧写法会把这条判成「已经提交过」，用户明明填的是另一个上游却被拒。
    const second = await submitAiDonation(user, "https://a_c.example.com")
    expect(second.res.status).not.toBe(409)
  })
})

describe("POST /admin/donations/:id/revoke —— 收回资源", () => {
  it("撤销 AI 捐献时同时删除中转站渠道并收回权限", async () => {
    const admin = await makeUser({ role: "admin" })
    const donor = await makeDonor()
    stubFetch((url) => (url.startsWith(UPSTREAM) ? upstreamModels(["gpt-4o"]) : undefined))
    stubNewApiChannelFlow({ testOk: true })

    const { body } = await submitAiDonation(donor)
    expect(body.channelId).toBe(101)

    const deletesBefore = calls.filter((c) => c.method === "DELETE").length
    const res = await fetchSelf(
      authRequest(admin, `/admin/donations/${body.id}/revoke`, { method: "POST" })
    )
    expect(res.status).toBe(200)
    const out = (await res.json()) as { releasedChannel: boolean; revokedPermission: boolean }
    expect(out.releasedChannel).toBe(true)
    expect(out.revokedPermission).toBe(true)
    expect(calls.filter((c) => c.method === "DELETE").length).toBeGreaterThan(deletesBefore)

    const perms = await readPerms(donor.id)
    expect(perms.ai).toBe(false)
  })
})

describe("POST /admin/donations/:id/provision —— 人工复核", () => {
  it("先失败后复核成功：重试能建出渠道并记录 id，但不改单据状态", async () => {
    const admin = await makeUser({ role: "admin" })
    const donor = await makeDonor()
    stubFetch((url) => (url.startsWith(UPSTREAM) ? upstreamModels(["gpt-4o"]) : undefined))
    stubNewApiChannelFlow({ testOk: false })

    const { body } = await submitAiDonation(donor)
    // 自动校验失败 → 转人工（不再自动拒绝），管理员据此复核
    expect(body.status).toBe("pending")

    // 上游恢复（清掉打桩，换成测试通过）
    stubNewApiChannelFlow({ testOk: true })

    const res = await fetchSelf(
      authRequest(admin, `/admin/donations/${body.id}/provision`, { method: "POST" })
    )
    expect(res.status).toBe(200)
    const out = (await res.json()) as {
      ok: boolean
      channelId: number | null
      detail?: string
      message: string
    }
    expect(out.ok, JSON.stringify(out)).toBe(true)
    expect(out.channelId).toBe(101)

    // 复核只接渠道，不改状态（放行仍要点「复核通过」）
    const row = await readDonation(body.id)
    expect(row?.status).toBe("pending")
    expect(row?.newapi_channel_id).toBe(101)
    const perms = await readPerms(donor.id)
    expect(perms.ai).toBe(false)
  })

  it("复核放行：批准自动校验未通过的单据时复用已接入的渠道，不重复创建", async () => {
    const admin = await makeUser({ role: "admin" })
    const donor = await makeDonor()
    stubFetch((url) => (url.startsWith(UPSTREAM) ? upstreamModels(["gpt-4o"]) : undefined))
    stubNewApiChannelFlow({ testOk: false })

    const { body } = await submitAiDonation(donor)
    expect(body.status).toBe("pending")

    stubNewApiChannelFlow({ testOk: true })
    await fetchSelf(
      authRequest(admin, `/admin/donations/${body.id}/provision`, { method: "POST" })
    )

    const postsBefore = calls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/api/channel/")
    ).length
    const res = await fetchSelf(
      authRequest(admin, "/admin/donations/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: body.id, action: "approve" }),
      })
    )
    expect(res.status).toBe(200)
    expect((await res.json()) as { status: string }).toMatchObject({ status: "approved" })

    // 复用已有渠道 → 不再新建
    const postsAfter = calls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/api/channel/")
    ).length
    expect(postsAfter).toBe(postsBefore)

    const perms = await readPerms(donor.id)
    expect(perms.ai).toBe(true)
  })
})

// ---- 接口格式（OpenAI 兼容 / Anthropic 原生）----
//
// 背景：用户实测遇到过一个上游「Anthropic 格式能用、OpenAI 格式失败」。
// 上游可能只实现了 `/v1/messages`（`x-api-key` + `anthropic-version`），
// 拿 OpenAI 的 `/v1/chat/completions`（`Authorization: Bearer`）去调必然被拒。

/** 只在请求带 `x-api-key` 时才回模型列表（模拟「只支持 Anthropic 原生」的上游） */
function stubAnthropicOnlyUpstream() {
  stubFetch((url, init) => {
    if (!url.startsWith(UPSTREAM)) return undefined
    const headers = new Headers(init?.headers)
    if (!headers.get("x-api-key")) {
      return jsonResponse({ error: { message: "unauthorized client detected" } }, 401)
    }
    return upstreamModels(["claude-opus-4-8"])
  })
}

async function probeWith(user: TestUser, format?: string) {
  const res = await fetchSelf(
    authRequest(user, "/donations/ai/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: UPSTREAM, apiKey: "sk-x", ...(format ? { format } : {}) }),
    })
  )
  return (await res.json()) as {
    ok: boolean
    channelType: number | null
    channelTypeName: string
    attempts: { name: string; ok: boolean; error: string }[]
  }
}

describe("接口格式识别", () => {
  it("自动识别：OpenAI 失败后自动改用 Anthropic 并成功", async () => {
    const user = await makeDonor()
    stubAnthropicOnlyUpstream()

    const body = await probeWith(user, "auto")
    expect(body.ok).toBe(true)
    expect(body.channelType).toBe(14)
    expect(body.channelTypeName).toContain("Anthropic")
    // 两种格式都留了痕迹，用户能看出第一次为什么失败
    expect(body.attempts.map((a) => a.ok)).toEqual([false, true])
  })

  it("指定 openai 时不再尝试 Anthropic（这正是用户遇到的失败场景）", async () => {
    const user = await makeDonor()
    stubAnthropicOnlyUpstream()

    const body = await probeWith(user, "openai")
    expect(body.ok).toBe(false)
    expect(body.channelType).toBeNull()
    expect(body.attempts).toHaveLength(1)
    // 提示用户还可以换格式
    expect(JSON.stringify(body)).toContain("换另一种")
  })

  it("指定 anthropic 时只试 Anthropic", async () => {
    const user = await makeDonor()
    stubAnthropicOnlyUpstream()
    const body = await probeWith(user, "anthropic")
    expect(body.ok).toBe(true)
    expect(body.attempts).toHaveLength(1)
  })
})

describe("按选定格式建渠道", () => {
  it("channelType=14 时用 Anthropic 类型建渠道", async () => {
    const user = await makeDonor()
    stubNewApiChannelFlow({ testOk: true })
    const res = await fetchSelf(
      authRequest(user, "/donations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "ai",
          payload: {
            baseUrl: UPSTREAM,
            apiKey: "sk-x",
            models: ["claude-opus-4-8"],
            channelType: 14,
          },
        }),
      })
    )
    const body = (await res.json()) as { status: string; reviewNote: string }
    expect(body.status).toBe("approved")

    const createCall = calls.find((c) => c.method === "POST" && c.url.includes("/api/channel/"))
    const channel = (createCall?.body as { channel: Record<string, unknown> }).channel
    expect(channel.type).toBe(14)
    // 结论里要写明用的是哪种格式，否则用户没法复现/排查
    expect(body.reviewNote).toContain("Anthropic")
  })

  it("channelType 不在白名单 → 400，不建渠道", async () => {
    const user = await makeDonor()
    stubNewApiChannelFlow({ testOk: true })
    const res = await fetchSelf(
      authRequest(user, "/donations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "ai",
          payload: { baseUrl: UPSTREAM, apiKey: "sk-x", models: ["m"], channelType: 99 },
        }),
      })
    )
    expect(res.status).toBe(400)
    expect((await res.json()) as { code: string }).toMatchObject({
      code: "INVALID_CHANNEL_TYPE",
    })
    expect(calls.some((c) => c.url.includes("/api/channel/"))).toBe(false)
  })

  it("不传 channelType 时按 OpenAI 兼容（向后兼容旧 payload）", async () => {
    const user = await makeDonor()
    stubNewApiChannelFlow({ testOk: true })
    await submitAiDonation(user)
    const createCall = calls.find((c) => c.method === "POST" && c.url.includes("/api/channel/"))
    const channel = (createCall?.body as { channel: Record<string, unknown> }).channel
    expect(channel.type).toBe(1)
  })
})

describe("首捐奖励券", () => {
  it("首次捐献成功会附带一张自选权限券，第二次不再发", async () => {
    const user = await makeDonor()
    stubNewApiChannelFlow({ testOk: true })

    const first = await submitAiDonation(user)
    expect(first.body.status).toBe("approved")
    expect(first.body.voucherCode).toMatch(/^VX-/)
    // 券确实落库了，并且是「自选」的
    const row = await env.DB.prepare(
      "SELECT feature, source, status FROM vouchers WHERE code = ?"
    )
      .bind(first.body.voucherCode)
      .first<{ feature: string | null; source: string; status: string }>()
    expect(row?.feature).toBeNull()
    expect(row?.source).toBe("first_donation")
    expect(row?.status).toBe("unused")

    // 换个上游地址（同一地址会被防重复挡下）再捐一次 → 不该再发券
    const second = await submitAiDonation(user, "https://up2.example.com")
    expect(second.body.status).toBe("approved")
    expect(second.body.voucherCode).toBeNull()
  })
})

describe("上游探测重定向", () => {
  it("手动跟随重定向，并在跨主机时不转发 API key", async () => {
    const redirectUrl = "https://redirect.example.com"
    stubFetch((url, init) => {
      if (url.startsWith(`${UPSTREAM}/v1/models`)) {
        return new Response(null, { status: 302, headers: { Location: `${redirectUrl}/v1/models` } })
      }
      if (url.startsWith(redirectUrl)) {
        const headers = new Headers(init?.headers)
        expect(headers.has("authorization")).toBe(false)
        expect(headers.has("x-api-key")).toBe(false)
        return upstreamModels(["redirected-model"])
      }
      return undefined
    })
    const res = await probeUpstream(UPSTREAM, "sk-test", "openai")
    expect(res.ok).toBe(true)
    expect(res.models).toEqual(["redirected-model"])
  })

  it("重定向到内网地址时拒绝请求", async () => {
    stubFetch((url) =>
      url.startsWith(`${UPSTREAM}/v1/models`)
        ? new Response(null, { status: 302, headers: { Location: "http://127.0.0.1:8080/models" } })
        : undefined
    )
    const res = await probeUpstream(UPSTREAM, "sk-test", "openai")
    expect(res.ok).toBe(false)
    expect(calls.some((call) => call.url.includes("127.0.0.1"))).toBe(false)
  })
})
