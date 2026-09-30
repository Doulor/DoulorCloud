// Cloudflare 额度面板：纯函数 + 接口层（含完整装配）。
//
// 这一层必须有：额度面板最容易错的地方不是算法，而是
//   ① R2 的 Class A / B 分类（写错就把免费操作也算进额度，占用率虚高）；
//   ② 「没记录 = 0」还是「读不到」的区分（混了会把读不到显示成 0%，看着很省）；
//   ③ 日期口径（CF 日额度按 00:00 UTC 重置）。
//
// 数据层用**打桩的 fetch** 覆盖：真实 CF API 的字段名是对着线上实测过的
// （见 cf-quota.ts 顶部注释），测试只需要锁住「拿到那种形状的数据后怎么算」。
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { authRequest, fetchSelf, makeUser, setSetting } from "./helpers"
import {
  FREE_LIMITS,
  PAID_LIMITS,
  classifyR2Op,
  maxValue,
  overCost,
  sumByAction,
  sumSeriesSince,
  tailDays,
  toDailySeries,
  utcDay,
  utcMonthStart,
  valueOnDate,
} from "../src/handlers/cf-quota"

describe("R2 操作分类（对着 R2 Pricing 页的 Class A / B 列表）", () => {
  it("Class A：写与列举", () => {
    for (const op of ["PutObject", "ListObjects", "ListBuckets", "CopyObject", "CreateMultipartUpload", "UploadPart", "ListMultipartUploads"]) {
      expect(classifyR2Op(op), op).toBe("A")
    }
  })

  it("Class B：读", () => {
    for (const op of ["GetObject", "HeadObject", "HeadBucket", "UsageSummary"]) {
      expect(classifyR2Op(op), op).toBe("B")
    }
  })

  it("免费操作不计入任何一类（删对象不算额度）", () => {
    for (const op of ["DeleteObject", "DeleteBucket", "AbortMultipartUpload"]) {
      expect(classifyR2Op(op), op).toBeNull()
    }
  })
})

describe("日期口径", () => {
  it("UTC 当天 / 本月第一天（CF 日额度就是按 00:00 UTC 重置）", () => {
    // 北京时间 2026-09-25T20:00 = UTC 2026-09-25T12:00 → 同一天
    expect(utcDay(new Date("2026-09-25T12:00:00Z"))).toBe("2026-09-25")
    // 北京时间 2026-09-26T02:00 = UTC 2026-09-25T18:00 → 仍是 UTC 的 25 日
    expect(utcDay(new Date("2026-09-25T18:00:00Z"))).toBe("2026-09-25")
    expect(utcMonthStart(new Date("2026-09-25T12:00:00Z"))).toBe("2026-09-01")
  })
})

describe("序列与聚合", () => {
  const rows = [
    { dimensions: { date: "2026-09-24" }, sum: { requests: 100 } },
    { dimensions: { date: "2026-09-22" }, sum: { requests: 30 } },
    { dimensions: { date: "2026-09-25" }, sum: { requests: 50 } },
  ]

  it("摊平成按天序列并升序（图表要按时间排）", () => {
    expect(toDailySeries(rows, "requests").map((r) => r.date)).toEqual([
      "2026-09-22",
      "2026-09-24",
      "2026-09-25",
    ])
  })

  it("取某天用量：没有该天记录 = 0（CF 没流量就不返回行）", () => {
    expect(valueOnDate(rows, "requests", "2026-09-24")).toBe(100)
    // 关键：09-23 没数据是「当天 0 次」，不是「读不到」
    expect(valueOnDate(rows, "requests", "2026-09-23")).toBe(0)
  })

  it("按 actionType 汇总，可按天过滤", () => {
    const kv = [
      { dimensions: { actionType: "read", date: "2026-09-25" }, sum: { requests: 7 } },
      { dimensions: { actionType: "write", date: "2026-09-25" }, sum: { requests: 2 } },
      { dimensions: { actionType: "read", date: "2026-09-24" }, sum: { requests: 5 } },
    ]
    expect(sumByAction(kv, { date: "2026-09-25", actions: ["read"] })).toBe(7)
    expect(sumByAction(kv, { date: "2026-09-25", actions: ["read", "write"] })).toBe(9)
    expect(sumByAction(kv, { actions: ["read"] })).toBe(12)
    // 没出现的类型算 0
    expect(sumByAction(kv, { date: "2026-09-25", actions: ["delete"] })).toBe(0)
  })
})

// ---- 接口层：完整装配（打桩 CF API）----

const CF_API = "https://api.cloudflare.com"

/**
 * 造一份 GraphQL 返回：按查询里出现的字段名给数据。
 * ⚠️ 所有「当天」的日期都用 `utcDay()` 现算 —— 写死日期会让用例第二天就挂。
 */
function gqlResponse(query: string): Response {
  const today = utcDay()
  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10)
  const acct: Record<string, unknown> = {}
  if (query.includes("workersInvocationsAdaptive")) {
    acct.workersInvocationsAdaptive = [
      { dimensions: { date: yesterday }, sum: { requests: 1000, errors: 1 } },
      { dimensions: { date: today }, sum: { requests: 4000, errors: 2 } },
    ]
  }
  if (query.includes("d1AnalyticsAdaptiveGroups")) {
    acct.d1AnalyticsAdaptiveGroups = [
      { dimensions: { date: today }, sum: { rowsRead: 250_000, rowsWritten: 5_000 } },
    ]
  }
  if (query.includes("kvOperationsAdaptiveGroups")) {
    acct.kvOperationsAdaptiveGroups = [
      { dimensions: { actionType: "read", date: today }, sum: { requests: 300 } },
      { dimensions: { actionType: "write", date: today }, sum: { requests: 40 } },
      { dimensions: { actionType: "delete", date: today }, sum: { requests: 3 } },
    ]
  }
  if (query.includes("kvStorageAdaptiveGroups")) {
    acct.kvStorageAdaptiveGroups = [
      { dimensions: { date: today }, max: { byteCount: 1024 * 1024, keyCount: 4 } },
    ]
  }
  if (query.includes("r2StorageAdaptiveGroups")) {
    acct.r2StorageAdaptiveGroups = [
      { dimensions: { date: today }, max: { payloadSize: 2 * 1024 ** 3, metadataSize: 1024 } },
    ]
  }
  if (query.includes("r2OperationsAdaptiveGroups")) {
    acct.r2OperationsAdaptiveGroups = [
      { dimensions: { actionType: "GetObject" }, sum: { requests: 20_000 } }, // Class B
      { dimensions: { actionType: "HeadObject" }, sum: { requests: 100 } }, // Class B
      { dimensions: { actionType: "PutObject" }, sum: { requests: 150 } }, // Class A
      { dimensions: { actionType: "ListObjects" }, sum: { requests: 50 } }, // Class A
      { dimensions: { actionType: "DeleteObject" }, sum: { requests: 999 } }, // 免费，不计
    ]
  }
  if (query.includes("aiInferenceAdaptiveGroups")) {
    acct.aiInferenceAdaptiveGroups = [{ dimensions: { date: today }, sum: { totalNeurons: 1234 } }]
  }
  return jsonRes({ data: { viewer: { accounts: [acct] } } })
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

let restores: Array<() => void> = []
/** 记录打桩到的 CF 请求 URL，用来断言「请求参数是合法的」 */
let cfUrls: string[] = []

function stubCf(): void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(CF_API)) return original(input as RequestInfo, init)
    cfUrls.push(url)

    if (url.endsWith("/graphql")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string }
      return gqlResponse(body.query ?? "")
    }
    if (url.includes("/workers/scripts")) {
      return jsonRes({ result: [{ id: "a" }, { id: "b" }] })
    }
    if (url.includes("/d1/database")) {
      return jsonRes({ result: [{ file_size: 2 * 1024 ** 2 }] })
    }
    if (url.includes("/email/routing/rules")) {
      return jsonRes({ result: [], result_info: { total_count: 150 } })
    }
    if (url.includes("/pages/projects") && url.includes("/deployments")) {
      return jsonRes({
        result: [
          { created_on: `${utcMonthStart()}T10:00:00Z` },
          { created_on: "2020-01-01T00:00:00Z" }, // 上个月，不该计入
        ],
      })
    }
    if (url.includes("/pages/projects")) {
      return jsonRes({
        result: [
          { name: "home", latest_deployment: { created_on: `${utcMonthStart()}T10:00:00Z` } },
          { name: "old", latest_deployment: { created_on: "2020-01-01T00:00:00Z" } },
        ],
      })
    }
    return jsonRes({ success: true, result: [] })
  }) as unknown as typeof fetch
  restores.push(() => {
    globalThis.fetch = original
  })
}

beforeEach(() => {
  restores = []
  cfUrls = []
})

afterEach(() => {
  for (let i = restores.length - 1; i >= 0; i--) restores[i]()
  restores = []
  vi.restoreAllMocks()
})

interface FoundItem {
  key: string
  used: number | null
  limit: number | null
  scope: "day" | "month" | "none"
  limitKind: "hard" | "included" | null
  costUsd?: number
  error?: string
  paidNote?: string
}

function findItem(data: Record<string, unknown>, key: string) {
  const groups = data.groups as { items: FoundItem[] }[]
  for (const g of groups) {
    const hit = g.items.find((i) => i.key === key)
    if (hit) return hit
  }
  throw new Error(`没找到额度项 ${key}`)
}

describe("GET /admin/cloudflare/quota", () => {
  it("非管理员拿不到（403），未登录 401", async () => {
    const user = await makeUser()
    const res = await fetchSelf(authRequest(user, "/admin/cloudflare/quota"))
    expect(res.status).toBe(403)

    const anon = await fetchSelf(new Request("https://cloud.doulor.cn/admin/cloudflare/quota"))
    expect(anon.status).toBe(401)
  })

  it("装配出各组额度，R2 按 Class A/B 正确分类且跳过免费操作", async () => {
    stubCf()
    const admin = await makeUser({ role: "admin" })
    const res = await fetchSelf(authRequest(admin, "/admin/cloudflare/quota?fresh=1"))
    expect(res.status).toBe(200)
    const data = (await res.json()) as Record<string, unknown>

    // Workers 当天：取 UTC 当天那条（= 4000），不是昨天那条 1000
    const workers = findItem(data, "workers.requests")
    expect(workers.used).toBe(4000)
    expect(workers.limit).toBe(FREE_LIMITS.workersRequestsPerDay)

    // D1
    expect(findItem(data, "d1.rowsRead").used).toBe(250_000)
    expect(findItem(data, "d1.rowsWritten").used).toBe(5_000)
    expect(findItem(data, "d1.storage").used).toBe(2 * 1024 ** 2)

    // KV：读/写/删各自汇总
    expect(findItem(data, "kv.reads").used).toBe(300)
    expect(findItem(data, "kv.writes").used).toBe(40)
    expect(findItem(data, "kv.deletes").used).toBe(3)
    expect(findItem(data, "kv.storage").used).toBe(1024 * 1024)

    // R2：Class B = GetObject 20000 + HeadObject 100；Class A = PutObject 150 + ListObjects 50
    // DeleteObject 999 是免费操作，绝不能算进去
    expect(findItem(data, "r2.classB").used).toBe(20_100)
    expect(findItem(data, "r2.classA").used).toBe(200)
    expect(findItem(data, "r2.storage").used).toBe(2 * 1024 ** 3 + 1024)

    // Pages：本月构建只算当月那条（老项目被跳过）
    expect(findItem(data, "pages.builds").used).toBe(1)
    expect(findItem(data, "pages.projects").used).toBe(2)

    // 资源计数
    expect(findItem(data, "workers.scripts").used).toBe(2)

    // AI
    expect(findItem(data, "ai.neurons").used).toBe(1234)

    // Pages 部署接口的 per_page **上限是 25**：传 50/100 会被 CF 拒（8000024），
    // 表现是构建数恒为 0。线上实测踩过，这里锁住别再传大值。
    const depUrls = cfUrls.filter((u) => u.includes("/deployments"))
    expect(depUrls.length).toBeGreaterThan(0)
    for (const u of depUrls) {
      const perPage = Number(new URL(u).searchParams.get("per_page"))
      expect(perPage, u).toBeLessThanOrEqual(25)
    }
    // 只对「最近有部署」的项目去数，老项目不该被请求
    expect(depUrls.some((u) => u.includes("/projects/old/"))).toBe(false)
  })

  it("某块读不到时只让那一组带 error，不影响其它组（不能显示成 0）", async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (!url.startsWith(CF_API)) return original(input as RequestInfo, init)
      if (url.endsWith("/graphql")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string }
        // AI 那条查询失败，其余正常
        if ((body.query ?? "").includes("aiInferenceAdaptiveGroups")) {
          return jsonRes({ data: null, errors: [{ message: "not authorized" }] })
        }
        return gqlResponse(body.query ?? "")
      }
      if (url.includes("/email/routing/rules")) {
        return jsonRes({ success: false, errors: [{ message: "no permission" }] }, 403)
      }
      if (url.includes("/pages/projects")) return jsonRes({ result: [] })
      if (url.includes("/workers/scripts")) return jsonRes({ result: [] })
      if (url.includes("/d1/database")) return jsonRes({ result: [] })
      return jsonRes({ result: [] })
    }) as unknown as typeof fetch
    restores.push(() => {
      globalThis.fetch = original
    })

    const admin = await makeUser({ role: "admin" })
    const res = await fetchSelf(authRequest(admin, "/admin/cloudflare/quota?fresh=1"))
    expect(res.status).toBe(200)
    const data = (await res.json()) as Record<string, unknown>

    // AI 读不到 → used 为 null + 有 error，绝不显示成 0
    const ai = findItem(data, "ai.neurons")
    expect(ai.used).toBeNull()
    expect(ai.error).toBeTruthy()

    // 但 Workers / D1 这些正常的组照旧有值
    expect(findItem(data, "workers.requests").used).toBe(4000)
    expect(findItem(data, "d1.rowsRead").used).toBe(250_000)
  })
})

// ---- 套餐判定与「免费/付费」两套口径 ----
//
// 起因：站长已升级到 Workers Paid，但面板仍按**免费版**的「每日 10 万次」画进度条，
// 于是当天 103,409 次请求被显示成 103% 的红色告警 —— 实际付费版根本没有每日上限。
// 这一组测试锁住「两套口径必须分开」这件事。

describe("套餐判定与口径", () => {
  afterEach(async () => {
    // 设置项写在共享的 app_settings 里，跑完必须还原，否则污染同文件后面的用例
    await setSetting("cf_plan", "auto")
  })

  it("手动指定付费版：换成「本月至今 / 月含量」口径，且带 $5 订阅底价", async () => {
    await setSetting("cf_plan", "paid")
    stubCf()
    const admin = await makeUser({ role: "admin" })
    const res = await fetchSelf(authRequest(admin, "/admin/cloudflare/quota?fresh=1"))
    expect(res.status).toBe(200)
    const data = (await res.json()) as Record<string, unknown>

    expect(data.plan).toBe("paid")
    expect(data.planSource).toBe("manual")

    const w = findItem(data, "workers.requests")
    expect(w.scope).toBe("month")
    expect(w.limitKind).toBe("included")
    expect(w.limit).toBe(PAID_LIMITS.workersRequestsPerMonth)
    // 本月至今 = 昨天 1000 + 今天 4000（打桩数据）
    expect(w.used).toBe(5000)

    // 免费版的日上限在付费版下**不该**再出现
    expect(w.limit).not.toBe(FREE_LIMITS.workersRequestsPerDay)

    // 估费至少包含 $5 订阅底价
    expect(data.estimatedCostUsd as number).toBeGreaterThanOrEqual(5)
    const breakdown = data.costBreakdown as { label: string; usd: number }[]
    expect(breakdown[0]?.label).toContain("订阅")
  })

  it("免费版：保持「当天 / 每日硬上限」口径，并提示升级后的额度", async () => {
    await setSetting("cf_plan", "free")
    stubCf()
    const admin = await makeUser({ role: "admin" })
    const res = await fetchSelf(authRequest(admin, "/admin/cloudflare/quota?fresh=1"))
    const data = (await res.json()) as Record<string, unknown>

    expect(data.plan).toBe("free")
    // 免费版没有费用概念
    expect(data.estimatedCostUsd).toBeNull()

    const w = findItem(data, "workers.requests")
    expect(w.scope).toBe("day")
    expect(w.limitKind).toBe("hard")
    expect(w.limit).toBe(FREE_LIMITS.workersRequestsPerDay)
    expect(w.paidNote).toBeTruthy()
  })

  /** 打一份「今天已超 10 万次请求」的 GraphQL 数据（免费日上限 = 100,000） */
  function gqlOverFreeLimit(query: string): Response {
    if (query.includes("workersInvocationsAdaptive")) {
      return jsonRes({
        data: {
          viewer: {
            accounts: [
              {
                workersInvocationsAdaptive: [
                  { dimensions: { date: utcDay() }, sum: { requests: 150_000, errors: 0 } },
                ],
              },
            ],
          },
        },
      })
    }
    return gqlResponse(query)
  }

  it("用量反证：单日请求超过免费日上限 ⇒ 必定已是付费版（订阅接口读不到时）", async () => {
    await setSetting("cf_plan", "auto")
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (!url.startsWith(CF_API)) return original(input as RequestInfo, init)
      if (url.endsWith("/graphql")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string }
        return gqlOverFreeLimit(body.query ?? "")
      }
      // 订阅接口读不到（令牌没有账单读取权限）—— 这正是线上最常见的情况
      if (url.includes("/subscriptions")) {
        return jsonRes({ success: false, errors: [{ message: "not authorized" }] }, 403)
      }
      return jsonRes({ success: true, result: [] })
    }) as unknown as typeof fetch
    restores.push(() => {
      globalThis.fetch = original
    })

    const admin = await makeUser({ role: "admin" })
    const res = await fetchSelf(authRequest(admin, "/admin/cloudflare/quota?fresh=1"))
    expect(res.status).toBe(200)
    const data = (await res.json()) as Record<string, unknown>

    expect(data.plan).toBe("paid")
    expect(data.planSource).toBe("usage")
    // 反证成立后，口径也要跟着切到月
    expect(findItem(data, "workers.requests").scope).toBe("month")
    expect(findItem(data, "workers.requests").used).toBe(150_000)
  })

  it("订阅接口读不到且用量也未超限时，不会瞎猜 —— 如实标成「未能确认」并提示手动选", async () => {
    await setSetting("cf_plan", "auto")
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (!url.startsWith(CF_API)) return original(input as RequestInfo, init)
      if (url.endsWith("/graphql")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string }
        return gqlResponse(body.query ?? "")
      }
      if (url.includes("/subscriptions")) {
        return jsonRes({ success: false, errors: [{ message: "not authorized" }] }, 403)
      }
      return jsonRes({ success: true, result: [] })
    }) as unknown as typeof fetch
    restores.push(() => {
      globalThis.fetch = original
    })

    const admin = await makeUser({ role: "admin" })
    const res = await fetchSelf(authRequest(admin, "/admin/cloudflare/quota?fresh=1"))
    const data = (await res.json()) as Record<string, unknown>

    expect(data.plan).toBe("free")
    expect(data.planSource).toBe("default")
    // 关键：要把「确认不了」这件事说出来，而不是默默按免费版显示
    expect(String(data.planNote)).toContain("无法自动确认")
    expect((data.warnings as string[]).some((w) => w.includes("无法自动确认"))).toBe(true)
  })

  it("订阅接口能读到 WORKERS_PAID 时直接采信（权威依据）", async () => {
    await setSetting("cf_plan", "auto")
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (!url.startsWith(CF_API)) return original(input as RequestInfo, init)
      if (url.endsWith("/graphql")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string }
        return gqlResponse(body.query ?? "")
      }
      if (url.includes("/subscriptions")) {
        return jsonRes({
          success: true,
          result: [{ rate_plan: { id: "WORKERS_PAID", name: "Workers Paid" } }],
        })
      }
      return jsonRes({ success: true, result: [] })
    }) as unknown as typeof fetch
    restores.push(() => {
      globalThis.fetch = original
    })

    const admin = await makeUser({ role: "admin" })
    const res = await fetchSelf(authRequest(admin, "/admin/cloudflare/quota?fresh=1"))
    const data = (await res.json()) as Record<string, unknown>

    expect(data.plan).toBe("paid")
    expect(data.planSource).toBe("subscription")
    // 付费版按「月」口径
    expect(findItem(data, "kv.reads").scope).toBe("month")
  })
})

describe("计费辅助函数", () => {
  it("overCost：只对超出的部分计费，未超出返回 0", () => {
    // 1000 万含 + 200 万超额 → 2 × $0.30
    expect(overCost(12_000_000, 10_000_000, 1_000_000, 0.3)).toBeCloseTo(0.6, 6)
    expect(overCost(9_000_000, 10_000_000, 1_000_000, 0.3)).toBe(0)
    expect(overCost(10_000_000, 10_000_000, 1_000_000, 0.3)).toBe(0)
    // 存储按 GB-月：5 GB 含、用了 6.5 GB → 1.5 × $0.75
    const gib = 1024 ** 3
    expect(overCost(6.5 * gib, 5 * gib, gib, 0.75)).toBeCloseTo(1.125, 6)
  })

  it("sumSeriesSince / tailDays / maxValue：月口径与展示窗口", () => {
    const series = [
      { date: "2026-08-31", value: 999 },
      { date: "2026-09-01", value: 10 },
      { date: "2026-09-02", value: 20 },
    ]
    // 「本月至今」必须排除上个月那条
    expect(sumSeriesSince(series, "2026-09-01")).toBe(30)
    expect(tailDays(series, 2).map((p) => p.date)).toEqual(["2026-09-01", "2026-09-02"])
    // 窗口比 n 短时原样返回
    expect(tailDays(series, 10).length).toBe(3)
    expect(maxValue(series)).toBe(999)
    expect(maxValue([])).toBe(0)
  })
})
