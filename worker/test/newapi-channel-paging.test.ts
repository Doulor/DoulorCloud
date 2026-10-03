// 渠道列表接口的分页契约（2026-09-30 商汤捐献全线转人工的根因）。
//
// 事故经过：本站渠道数涨到 140+ 之后，`listChannels()` 只发一次
// `/api/channel/?page_size=1000`。NewAPI 服务端把这个值**硬性封顶到 100**
// （v1.0.0-rc.40 `common/page_info.go`：`if pageInfo.PageSize > 100`），
// 而且**页码参数名是 `p`、不是 `page`** —— 写 `page=2` 会被静默忽略。
// 结果永远只拿到第 1 页的 100 条，`sensenova_channel_id=17` 那个渠道
// （在多密钥渠道「日日新」上，63 把 Key）恰好落在第 2 页 ⇒ 被误判成
// 「中转站里没有 #17 这个渠道」⇒ 所有商汤 Key 捐献转人工且停在 pending。
//
// 所以这里钉死三件事，任何一条被改回去都会让上面的事故复发：
//   ① `listChannels()` 必须翻页取全量；
//   ② 页码参数必须是 `p`；
//   ③ 「按 id 单查」必须走 `GET /api/channel/:id`，且**不存在时返回 null**
//      而不是抛错（NewAPI 对不存在的 id 返回的是 HTTP 200 + success:false，
//      不是 404 —— 只看状态码会误判成上游故障）。
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { env } from "cloudflare:workers"
import { getChannel, listChannels } from "../src/newapi-client"

const NEWAPI = "https://api.doulor.cn"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

interface Call {
  url: string
  method: string
}

let calls: Call[] = []
let restores: Array<() => void> = []

function stubFetch(handler: (url: string, method: string) => Response | undefined): void {
  const original = globalThis.fetch
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? "GET").toUpperCase()
    calls.push({ url, method })
    const res = handler(url, method)
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

const TARGET_ID = 17

/** 造一个渠道对象（只要 id 能识别、channel_info 能读就够） */
function channel(id: number, multiKeySize = 1) {
  return {
    id,
    name: `渠道${id}`,
    type: 1,
    status: 1,
    models: "nova-a",
    group: "default",
    channel_info: { is_multi_key: true, multi_key_size: multiKeySize },
  }
}

/**
 * 打桩 `/api/channel/?p=N&page_size=M`，**严格复刻 NewAPI 的服务端行为**：
 *   · page_size 上限 100（请求写 1000 也只给 100）；
 *   · 页码参数是 `p`（写 `page=` 一律当第 1 页）。
 *
 * `filler` = 除目标渠道外的渠道数，用来把目标顶到后面的页。
 */
function stubPagedChannels(opts: {
  filler: number
  targetId?: number
  /** 目标渠道在第几页；不传则按 filler 自然排布 */
  targetPosition?: number
  /** 上游 total 字段（不传则按实际条数） */
  reportedTotal?: number | null
}): void {
  const targetId = opts.targetId ?? TARGET_ID
  const targetPos = opts.targetPosition ?? opts.filler
  const ids: number[] = []
  for (let i = 0; i < opts.filler + 1; i++) {
    if (i === targetPos) ids.push(targetId)
    else ids.push(1000 + i) // 填充渠道 id 从 1000 起，避开 targetId
  }

  stubFetch((url) => {
    if (!url.startsWith(NEWAPI)) return undefined
    const u = new URL(url)
    // 只认 `p`；写 `page` 时 NewAPI 会当第 1 页 —— 这里如实复刻
    const rawP = u.searchParams.get("p")
    const page = rawP ? Math.max(1, Number(rawP) || 1) : 1
    const rawSize = Number(u.searchParams.get("page_size") ?? "0") || 20
    const pageSize = Math.min(100, rawSize)

    const start = (page - 1) * pageSize
    const items = ids.slice(start, start + pageSize).map((id) =>
      id === targetId ? channel(id, 63) : channel(id)
    )
    const total = opts.reportedTotal === null ? undefined : (opts.reportedTotal ?? ids.length)
    return jsonResponse({
      success: true,
      message: "",
      data: { items, total, page, page_size: pageSize, type_counts: {} },
    })
  })
}

describe("listChannels —— 必须翻页取全量", () => {
  it("渠道总数超过一页、目标在第 2 页时，目标必须出现在结果里（事故回归）", async () => {
    // 线上实况：total≈141，第 1 页 100 条，目标 #17 在第 2 页
    stubPagedChannels({ filler: 140 })
    const list = await listChannels(env)
    expect(list).toHaveLength(141)
    expect(list.some((c) => c.id === TARGET_ID)).toBe(true)
  })

  it("页码参数必须是 `p`（写 `page=` 上游会当第 1 页，永远拿不到第 2 页）", async () => {
    stubPagedChannels({ filler: 140 })
    await listChannels(env)
    const listCalls = calls.filter((c) => c.url.includes("/api/channel/?"))
    expect(listCalls.length).toBeGreaterThanOrEqual(2)
    for (const c of listCalls) {
      const u = new URL(c.url)
      expect(u.searchParams.get("p")).toBeTruthy()
      expect(u.searchParams.has("page")).toBe(false)
    }
    // 确实翻到了第 2 页
    expect(listCalls.some((c) => new URL(c.url).searchParams.get("p") === "2")).toBe(true)
  })

  it("requested page_size 不会超过服务端封顶的 100", async () => {
    stubPagedChannels({ filler: 140 })
    await listChannels(env)
    for (const c of calls.filter((x) => x.url.includes("/api/channel/?"))) {
      expect(Number(new URL(c.url).searchParams.get("page_size"))).toBeLessThanOrEqual(100)
    }
  })

  it("只有一页时不多发请求（不能无脑翻 50 页）", async () => {
    stubPagedChannels({ filler: 3 })
    const list = await listChannels(env)
    expect(list).toHaveLength(4)
    expect(calls.filter((c) => c.url.includes("/api/channel/?")).length).toBe(1)
  })

  it("上游不给 total 时，靠「不满一页」收尾（不会死循环）", async () => {
    stubPagedChannels({ filler: 140, reportedTotal: null })
    const list = await listChannels(env)
    expect(list).toHaveLength(141)
    // 141 条 = 两页（100 + 41），不必再翻第三页
    expect(calls.filter((c) => c.url.includes("/api/channel/?")).length).toBe(2)
  })

  it("上游 total 撒谎（说 999 但只有 5 条）→ 靠空页收尾", async () => {
    stubPagedChannels({ filler: 4, reportedTotal: 999 })
    const list = await listChannels(env)
    expect(list).toHaveLength(5)
  })

  it("重复 id 只保留一份（上游若把同一渠道返回两遍也不重复计入）", async () => {
    stubFetch((url) => {
      if (!url.startsWith(NEWAPI)) return undefined
      const u = new URL(url)
      const page = Number(u.searchParams.get("p") ?? "1") || 1
      // 两页内容完全一样 —— 且都是满页，逼迫实现靠「本页没有新渠道」收尾
      const items = Array.from({ length: 100 }, (_, i) => channel(2000 + i))
      return jsonResponse({
        success: true,
        message: "",
        data: { items, total: 999, page, page_size: 100, type_counts: {} },
      })
    })
    const list = await listChannels(env)
    expect(list).toHaveLength(100)
    // 第 2 页全是重复 ⇒ 立刻停，不再往后翻
    expect(calls.filter((c) => c.url.includes("/api/channel/?")).length).toBe(2)
  })
})

describe("getChannel —— 按 id 单查", () => {
  it("存在 → 返回渠道对象（含多密钥信息）", async () => {
    stubFetch((url) => {
      if (!url.startsWith(NEWAPI)) return undefined
      if (/\/api\/channel\/17(\?.*)?$/.test(url)) {
        return jsonResponse({ success: true, message: "", data: channel(17, 63) })
      }
      return undefined
    })
    const ch = await getChannel(env, 17)
    expect(ch?.id).toBe(17)
    expect(ch?.name).toBe("渠道17")
    expect(ch?.channel_info?.is_multi_key).toBe(true)
    expect(ch?.channel_info?.multi_key_size).toBe(63)
    // 走的是单查端点，不是列表
    expect(calls[0]?.url).toMatch(/\/api\/channel\/17(\?.*)?$/)
  })

  it("不存在（HTTP 200 + success:false record not found）→ 返回 null，而不是抛错", async () => {
    stubFetch((url) => {
      if (!url.startsWith(NEWAPI)) return undefined
      // 这就是 NewAPI 的真实应答：状态码 200，不是 404
      return jsonResponse({ success: false, message: "record not found" }, 200)
    })
    await expect(getChannel(env, 99999)).resolves.toBeNull()
  })

  it("不存在（data 为 null 的另一种形态）→ 也返回 null", async () => {
    stubFetch((url) => {
      if (!url.startsWith(NEWAPI)) return undefined
      return jsonResponse({ success: true, message: "", data: null })
    })
    await expect(getChannel(env, 99999)).resolves.toBeNull()
  })

  it("上游 500 → 抛错（真故障不能被当成「渠道不存在」而静默转人工）", async () => {
    stubFetch((url) => {
      if (!url.startsWith(NEWAPI)) return undefined
      return jsonResponse({ success: false, message: "database is locked" }, 500)
    })
    await expect(getChannel(env, 17)).rejects.toThrow(/database is locked/)
  })
})
