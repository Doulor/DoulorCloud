// 商汤 Key 捐献通道：验证 Key → **追加进已有的多密钥渠道** → 只解锁权限。
//
// 与 donation-ai.test.ts 同一套打桩风格：这条链路的真实风险不在某个函数算错，
// 而在**语义**：
//   · 401 和 404 是不是被区分开了；
//   · 有没有**新建渠道**（应该是「把 Key 追加进 #17」而不是建「商汤NN」）；
//   · 追加时有没有用 `key_mode: "append"`（不带它会把渠道原有 Key 覆盖掉！）；
//   · 目标渠道不是多密钥渠道时，是不是**什么都没做**（转人工而不是覆盖）；
//   · 撤销时是不是只摘掉那一把 Key，而**没有把共享渠道删掉**；
//   · 有没有误发额度/券。
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, setPermissions, setSetting, type TestUser } from "./helpers"
import { parsePermissions } from "../src/permissions"
import { keyPreview, probeSenseNova } from "../src/sensenova"
import { auditSenseNovaKeys } from "../src/handlers/donations"

const NEWAPI = "https://api.doulor.cn"
const SENSE = "https://token.sensenova.cn"
/** 管理员自建的商汤多密钥渠道（对应线上 #17「日日新」） */
const TARGET_ID = 17
const TARGET_NAME = "日日新"

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

beforeEach(async () => {
  calls = []
  // 默认打开商汤通道，并指定目标渠道（测试里改写这两个设置的那个用例自己覆盖）
  await setSetting("sensenova_enabled", "1")
  await setSetting("sensenova_base_url", SENSE)
  await setSetting("sensenova_channel_id", String(TARGET_ID))
})

afterEach(() => {
  for (let i = restores.length - 1; i >= 0; i--) restores[i]()
  restores = []
  vi.restoreAllMocks()
})

/** 造一个可捐献的用户（显式把 ai 关着，才测得出「捐献解锁」） */
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
    }>()
}

/**
 * NewAPI 渠道接口打桩 —— 模拟一个**多密钥**渠道（管理员自建的那种）。
 *
 * 存在的意义：把渠道的 Key 列表放进内存，测试就能断言「追加之后渠道里到底
 * 有几把 Key」。这正好能区分两种写法：
 *   · 带 `key_mode:"append"` → 原有 Key 保留，追加一把；
 *   · 不带它（覆盖语义）→ 原有 Key 全没了，只剩一把。
 * 后者在生产上等于把管理员的商汤渠道打残，必须能被测出来。
 *
 * ⚠️ 「列表」和「单查」是两个不同的接口，必须分开应答（2026-09-30）：
 *   · `GET /api/channel/?p=1&page_size=100` → 分页信封 `{items,total,page,page_size}`
 *   · `GET /api/channel/17`                → `data` 直接是**单个渠道对象**
 *   以前这里用 `url.includes("/api/channel/")` 一把抓，单查也会拿到列表信封，
 *   于是 `getChannel()` 读不到 `data.id`、误判成「渠道不存在」。
 *
 * `opts.listTotal` / `opts.targetOnPage` 用来复刻线上那个事故：
 * 渠道总数超过一页（100 条）、目标渠道落在第 2 页 —— 这种桩下只要代码还在
 * 「拉一页再 find」，商汤捐献就会全部转人工。
 */
function stubNewApiChannelFlow(
  opts: {
    isMultiKey?: boolean
    keys?: string[]
    channelMissing?: boolean
    /** 上游声明的渠道总数（>100 就会有多页） */
    listTotal?: number
    /** 目标渠道出现在第几页（默认 1） */
    targetOnPage?: number
    /** 除目标渠道外额外填充的假渠道数（用来把目标挤出第 1 页） */
    fillerChannels?: number
  } = {}
): { keys: string[] } {
  const isMultiKey = opts.isMultiKey !== false
  const keys = [...(opts.keys ?? ["sn-upstream-key-aaaa1", "sn-upstream-key-bbbb2"])]

  const channelJson = () => ({
    id: TARGET_ID,
    name: TARGET_NAME,
    type: 1,
    status: 1,
    models: "nova-a,nova-b",
    group: "default",
    base_url: SENSE,
    channel_info: { is_multi_key: isMultiKey, multi_key_size: keys.length },
  })

  /** 造第 `page` 页的 items（每页 100 条，与 NewAPI 的服务端封顶一致） */
  const pageItems = (page: number): Array<Record<string, unknown>> => {
    const fillerCount = opts.fillerChannels ?? 0
    const targetPage = opts.targetOnPage ?? 1
    const items: Array<Record<string, unknown>> = []
    const start = (page - 1) * 100
    for (let i = 0; i < 100; i++) {
      const idx = start + i
      if (idx >= fillerCount) break
      // 填充渠道的 id 从 1000 起，避开目标 id
      items.push({ id: 1000 + idx, name: `填充${idx}`, type: 1, status: 1, models: "x", group: "default" })
    }
    if (!opts.channelMissing && page === targetPage) items.push(channelJson())
    return items
  }

  stubFetch((url, init, method) => {
    if (!url.startsWith(NEWAPI)) return undefined

    // 多密钥管理：查状态 / 删某一把
    if (method === "POST" && url.includes("/api/channel/multi_key/manage")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        action?: string
        key_index?: number
      }
      if (!isMultiKey) {
        // 与 NewAPI 的真实应答一致：普通渠道会明确拒绝
        return jsonResponse({ success: false, message: "该渠道不是多密钥模式" })
      }
      if (body.action === "get_key_status") {
        return jsonResponse({
          success: true,
          message: "",
          data: {
            keys: keys.map((k, i) => ({ index: i, status: 1, key_preview: keyPreview(k) })),
            total: keys.length,
          },
        })
      }
      if (body.action === "delete_key") {
        keys.splice(Number(body.key_index), 1)
        return jsonResponse({ success: true, message: "" })
      }
      return jsonResponse({ success: false, message: "未知操作" })
    }

    // ---- 单查渠道：GET /api/channel/:id ----
    // 必须放在「列表」分支前面（列表那条是 includes 匹配，会把单查也吞掉）
    const single = url.match(/\/api\/channel\/(\d+)(?:\?.*)?$/)
    if (method === "GET" && single && !url.includes("/api/channel/test/")) {
      const id = Number(single[1])
      // NewAPI 对不存在的 id 是 **HTTP 200 + success:false**，不是 404
      if (opts.channelMissing || id !== TARGET_ID) {
        return jsonResponse({ success: false, message: "record not found" })
      }
      return jsonResponse({ success: true, message: "", data: channelJson() })
    }

    // 追加 / 覆盖 Key 都走 PUT /api/channel/
    if (method === "PUT" && url.endsWith("/api/channel/")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        key?: string
        key_mode?: string
      }
      const incoming = String(body.key ?? "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
      if (body.key_mode === "append") {
        for (const k of incoming) if (!keys.includes(k)) keys.push(k)
      } else {
        keys.length = 0
        keys.push(...incoming)
      }
      return jsonResponse({ success: true, message: "" })
    }

    // 管理员启用/禁用用户（巡检收回权限后会连带封禁中转站账号）
    if (method === "POST" && url.endsWith("/api/user/manage")) {
      return jsonResponse({ success: true, message: "" })
    }

    // 新建渠道 —— 本流程**不该**出现，但仍然应答成功，
    // 好让「有没有建新渠道」变成调用记录上的断言而不是异常
    if (method === "POST" && url.endsWith("/api/channel/")) {
      return jsonResponse({ success: true, message: "" })
    }
    if (method === "DELETE" && url.includes("/api/channel/")) {
      return jsonResponse({ success: true, message: "" })
    }
    if (method === "GET" && url.includes("/api/channel/test/")) {
      return jsonResponse({ success: true, message: "", time: 0.42 })
    }

    // ---- 列表：GET /api/channel/?p=N&page_size=100 ----
    if (method === "GET" && url.includes("/api/channel/")) {
      const q = new URL(url).searchParams
      const page = Math.max(1, Number(q.get("p") ?? "1") || 1)
      // 复刻 NewAPI 的服务端封顶：请求写 page_size=1000 也只给 100
      const pageSize = Math.min(100, Number(q.get("page_size") ?? "100") || 100)
      const items = pageItems(page).slice(0, pageSize)
      const total =
        opts.listTotal ??
        (opts.channelMissing ? 0 : (opts.fillerChannels ?? 0) + 1)
      return jsonResponse({
        success: true,
        message: "",
        data: { items, total, page, page_size: pageSize, type_counts: {} },
      })
    }
    return undefined
  })

  return { keys }
}

function senseModels(models: string[]): Response {
  return jsonResponse({ object: "list", data: models.map((id) => ({ id })) })
}

function submitSensenova(user: TestUser, apiKey = "sn-test-key-0001") {
  return fetchSelf(
    authRequest(user, "/donations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "sensenova", payload: { apiKey } }),
    })
  )
}

/** 所有打到 /api/channel/ 的**写**操作（用来证明「没建渠道 / 没删渠道」） */
function channelWrites(): Call[] {
  return calls.filter(
    (c) =>
      c.url.includes("/api/channel/") &&
      (c.method === "POST" || c.method === "PUT" || c.method === "DELETE") &&
      !c.url.includes("/multi_key/manage")
  )
}

// ---- 纯函数 ----

describe("keyPreview", () => {
  it("复刻 NewAPI 的规则：超过 10 位截断加省略号", () => {
    expect(keyPreview("sn-test-key-0001")).toBe("sn-test-ke...")
    expect(keyPreview("shortkey")).toBe("shortkey")
    expect(keyPreview("1234567890")).toBe("1234567890")
  })
})

describe("probeSenseNova", () => {
  it("200 且有模型 → 有效", async () => {
    stubFetch((url) => (url.startsWith(SENSE) ? senseModels(["nova-a", "nova-b"]) : undefined))
    const r = await probeSenseNova(SENSE, "k")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.models).toEqual(["nova-a", "nova-b"])
  })

  it("401 → invalid_key（Key 无效，不是地址问题）", async () => {
    stubFetch((url) => (url.startsWith(SENSE) ? jsonResponse({}, 401) : undefined))
    const r = await probeSenseNova(SENSE, "bad")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe("invalid_key")
  })

  it("403 也归 invalid_key（Key 无权限）", async () => {
    stubFetch((url) => (url.startsWith(SENSE) ? jsonResponse({}, 403) : undefined))
    const r = await probeSenseNova(SENSE, "bad")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe("invalid_key")
  })

  it("404 → bad_url（地址配错，与 Key 无效必须区分开）", async () => {
    stubFetch((url) => (url.startsWith(SENSE) ? jsonResponse({}, 404) : undefined))
    const r = await probeSenseNova(SENSE, "k")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe("bad_url")
  })

  it("500 → network（不怪用户，可重试）", async () => {
    stubFetch((url) => (url.startsWith(SENSE) ? jsonResponse({}, 500) : undefined))
    const r = await probeSenseNova(SENSE, "k")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe("network")
  })

  it("空 Key 不发请求", async () => {
    stubFetch(() => undefined)
    const r = await probeSenseNova(SENSE, "  ")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe("invalid_key")
    expect(calls).toHaveLength(0)
  })

  it("拒绝本机地址（服务端会向该地址发请求，是个 SSRF 面）", async () => {
    const r = await probeSenseNova("http://127.0.0.1:8080", "k")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe("bad_url")
  })
})

// ---- HTTP 流程 ----

describe("POST /donations —— 商汤 Key 自动接入", () => {
  it("Key 有效 → 追加进目标渠道（不新建渠道、不动模型）、自动批准、解锁 ai", async () => {
    const user = await makeDonor()
    stubFetch((url) => (url.startsWith(SENSE) ? senseModels(["nova-a", "nova-b"]) : undefined))
    const stub = stubNewApiChannelFlow()

    const res = await submitSensenova(user)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; channelId: number | null }
    expect(body.status).toBe("approved")
    expect(body.channelId).toBe(TARGET_ID)

    expect((await readPerms(user.id)).ai).toBe(true)

    // **绝不新建渠道**：整个流程没有任何 POST /api/channel/（建渠道走的是它）
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/api/channel/"))).toBe(false)

    // 追加只传 { id, key, key_mode }，一个多余字段都不能带
    const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/api/channel/"))
    const putBody = put?.body as Record<string, unknown>
    expect(putBody.id).toBe(TARGET_ID)
    expect(putBody.key_mode).toBe("append")
    expect(putBody.key).toBe("sn-test-key-0001")
    expect("models" in putBody).toBe(false)
    expect("status" in putBody).toBe(false)

    // 原有 Key 必须还在（覆盖语义会只剩新的一把）
    expect(stub.keys).toEqual([
      "sn-upstream-key-aaaa1",
      "sn-upstream-key-bbbb2",
      "sn-test-key-0001",
    ])

    // **不逐个测模型**：整条链路一次 /api/channel/test/ 都不该出现
    expect(calls.some((c) => c.url.includes("/api/channel/test/"))).toBe(false)

    const d = await readDonation(body.id ?? "")
    expect(d?.newapi_channel_id).toBe(TARGET_ID)
  })

  it("同一把 Key 已在渠道里 → 幂等，不算失败（密钥数不变）", async () => {
    const user = await makeDonor()
    stubFetch((url) => (url.startsWith(SENSE) ? senseModels(["nova-a"]) : undefined))
    const stub = stubNewApiChannelFlow({ keys: ["sn-test-key-0001"] })

    const res = await submitSensenova(user)
    const body = (await res.json()) as { status: string; reviewNote: string | null }
    expect(body.status).toBe("approved")
    expect(stub.keys).toEqual(["sn-test-key-0001"])
    expect(body.reviewNote).toContain("已在渠道")
  })

  it("目标渠道不是多密钥渠道 → 转人工，且**一个写操作都没有**（绝不能覆盖原有 Key）", async () => {
    const user = await makeDonor()
    stubFetch((url) => (url.startsWith(SENSE) ? senseModels(["nova-a"]) : undefined))
    const stub = stubNewApiChannelFlow({ isMultiKey: false, keys: ["sn-only-key"] })

    const res = await submitSensenova(user)
    const body = (await res.json()) as { status: string; reviewNote: string | null }
    // 这是**管理员**把目标渠道配错了，不是用户的 Key 有问题 ⇒ 转人工，不判用户失败
    expect(res.status).toBe(201)
    expect(body.status).toBe("pending")
    expect(body.reviewNote).toContain("不是多密钥渠道")
    // 关键：没有 PUT，原有 Key 安好
    expect(channelWrites()).toHaveLength(0)
    expect(stub.keys).toEqual(["sn-only-key"])
    expect((await readPerms(user.id)).ai).toBe(false)
  })

  it("目标渠道不存在 → 转人工，且不发任何渠道写操作", async () => {
    const user = await makeDonor()
    stubFetch((url) => (url.startsWith(SENSE) ? senseModels(["nova-a"]) : undefined))
    stubNewApiChannelFlow({ channelMissing: true })

    const res = await submitSensenova(user)
    const body = (await res.json()) as { status: string; reviewNote: string | null }
    // 同上：平台侧配置问题 ⇒ 转人工
    expect(res.status).toBe(201)
    expect(body.status).toBe("pending")
    expect(body.reviewNote).toContain(`没有 #${TARGET_ID}`)
    expect(channelWrites()).toHaveLength(0)
  })

  it("**渠道总数超过一页、目标渠道落在第 2 页** → 照样自动通过（2026-09-30 事故回归）", async () => {
    const user = await makeDonor()
    stubFetch((url) => (url.startsWith(SENSE) ? senseModels(["nova-a"]) : undefined))
    // 线上实况：141 个渠道，接口每页最多 100 条，#17 在第 2 页。
    // 旧代码只拉一页再 `.find()`，于是把「列表里没有」误读成「渠道不存在」，
    // 所有商汤捐献全部转人工并停在 pending。
    const stub = stubNewApiChannelFlow({ fillerChannels: 100, targetOnPage: 2, listTotal: 101 })

    const res = await submitSensenova(user)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      status: string
      channelId: number | null
      reviewNote: string | null
    }
    expect(body.status).toBe("approved")
    expect(body.channelId).toBe(TARGET_ID)
    expect(body.reviewNote ?? "").not.toContain("没有")
    expect(stub.keys).toContain("sn-test-key-0001")
    expect((await readPerms(user.id)).ai).toBe(true)
  })

  it("**没配目标渠道** → 转人工 pending，不拒绝（平台侧没配好，不怪用户）", async () => {
    await setSetting("sensenova_channel_id", "")
    const user = await makeDonor()
    stubFetch((url) => (url.startsWith(SENSE) ? senseModels(["nova-a"]) : undefined))
    stubNewApiChannelFlow()

    const res = await submitSensenova(user)
    expect(res.status).toBe(201)
    const body = (await res.json()) as { status: string; reviewNote: string | null }
    expect(body.status).toBe("pending")
    expect(body.reviewNote).toContain("商汤接入渠道 ID")
    // 连上游校验都不该发（这一步在探测之前就短路了）
    expect(calls.some((c) => c.url.startsWith(SENSE))).toBe(false)
    expect(channelWrites()).toHaveLength(0)
  })

  it("**不发邀请码额度、不发首捐券**，但照发 2 捐献积分（两套奖励互不牵连）", async () => {
    const user = await makeDonor()
    stubFetch((url) => (url.startsWith(SENSE) ? senseModels(["nova-a"]) : undefined))
    stubNewApiChannelFlow()

    const res = await submitSensenova(user)
    const body = (await res.json()) as { status: string; voucherCode?: string | null }
    expect(body.status).toBe("approved")
    expect(body.voucherCode ?? null).toBeNull()

    // 券表里不该有任何一行
    const vouchers = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM vouchers WHERE owner_user_id = ?"
    )
      .bind(user.id)
      .first<{ n: number }>()
    expect(Number(vouchers?.n ?? 0)).toBe(0)

    // 邀请码额度不该变（基础额度就是 3，+2 会变成 5）
    const invite = await env.DB.prepare(
      "SELECT invite_quota_bonus FROM users WHERE id = ?"
    )
      .bind(user.id)
      .first<{ invite_quota_bonus: number | null }>()
    expect(Number(invite?.invite_quota_bonus ?? 0)).toBe(0)

    // 但**积分照发**（站长要求：商汤 2 分）。
    // 积分走的是独立的 grantDonationReward，不受 grantRewards:false 影响 ——
    // 这条断言就是防止将来有人把两者重新绑在一起。
    const pts = await env.DB.prepare("SELECT balance FROM user_points WHERE user_id = ?")
      .bind(user.id)
      .first<{ balance: number }>()
    expect(Number(pts?.balance ?? 0)).toBe(2)
    const tx = await env.DB.prepare(
      "SELECT reason, detail FROM point_transactions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1"
    )
      .bind(user.id)
      .first<{ reason: string; detail: string }>()
    expect(tx?.reason).toBe("donation")
    expect(tx?.detail).toContain("商汤")
  })

  it("Key 无效（401）→ 自动拒绝、不解锁、不碰渠道", async () => {
    const user = await makeDonor()
    stubFetch((url) => (url.startsWith(SENSE) ? jsonResponse({}, 401) : undefined))
    stubNewApiChannelFlow()

    const res = await submitSensenova(user, "bad-key")
    const body = (await res.json()) as { status: string; reviewNote: string | null }
    expect(body.status).toBe("rejected")
    expect(body.reviewNote).toContain("拒绝")
    expect((await readPerms(user.id)).ai).toBe(false)
    expect(channelWrites()).toHaveLength(0)
  })

  it("上游 500（网络问题）→ 转人工 pending，**不是拒绝**（不怪用户）", async () => {
    const user = await makeDonor()
    stubFetch((url) => (url.startsWith(SENSE) ? jsonResponse({}, 500) : undefined))
    stubNewApiChannelFlow()

    const res = await submitSensenova(user)
    expect(res.status).toBe(201)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe("pending")
    expect((await readPerms(user.id)).ai).toBe(false)
  })

  it("通道开关关闭 → 拒绝，不碰渠道", async () => {
    await setSetting("sensenova_enabled", "0")
    const user = await makeDonor()
    stubFetch((url) => (url.startsWith(SENSE) ? senseModels(["nova-a"]) : undefined))
    stubNewApiChannelFlow()

    const res = await submitSensenova(user)
    const body = (await res.json()) as { status: string; reviewNote: string | null }
    expect(body.status).toBe("rejected")
    expect(body.reviewNote).toContain("未开启")
    expect(channelWrites()).toHaveLength(0)
  })

  it("同一 Key 重复提交被拒（409）", async () => {
    const user = await makeDonor()
    stubFetch((url) => (url.startsWith(SENSE) ? senseModels(["nova-a"]) : undefined))
    stubNewApiChannelFlow()

    const first = await submitSensenova(user, "same-key")
    expect(first.status).toBe(200)
    const second = await submitSensenova(user, "same-key")
    expect(second.status).toBe(409)
  })

  it("缺 Key → 400，不发任何请求", async () => {
    const user = await makeDonor()
    stubFetch(() => undefined)
    const res = await submitSensenova(user, "   ")
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})

describe("POST /admin/donations/:id/revoke —— 商汤只摘 Key，不删渠道", () => {
  it("撤销时从共享渠道里移除那一把 Key，**渠道本身保留**，并收回权限", async () => {
    const admin = await makeUser({ role: "admin" })
    const donor = await makeDonor()
    stubFetch((url) => (url.startsWith(SENSE) ? senseModels(["nova-a"]) : undefined))
    const stub = stubNewApiChannelFlow()

    const res = await submitSensenova(donor)
    const body = (await res.json()) as { id: string; channelId: number | null }
    expect(body.channelId).toBe(TARGET_ID)
    expect(stub.keys).toContain("sn-test-key-0001")

    const revoke = await fetchSelf(
      authRequest(admin, `/admin/donations/${body.id}/revoke`, { method: "POST" })
    )
    expect(revoke.status).toBe(200)
    const out = (await revoke.json()) as {
      releasedChannel: boolean
      revokedPermission: boolean
      releaseMessage: string | null
    }
    expect(out.releasedChannel).toBe(true)
    expect(out.revokedPermission).toBe(true)
    expect(out.releaseMessage).toContain(`#${TARGET_ID}`)

    // 关键：**没有 DELETE**（删渠道等于把整个商汤上游下架）
    expect(calls.some((c) => c.method === "DELETE")).toBe(false)
    // 那把 Key 被摘掉了，原有的两把还在
    expect(stub.keys).toEqual(["sn-upstream-key-aaaa1", "sn-upstream-key-bbbb2"])
    expect((await readPerms(donor.id)).ai).toBe(false)
  })

  it("渠道里找不到那把 Key → 如实告知（released=false），不乱删也不删渠道", async () => {
    const admin = await makeUser({ role: "admin" })
    const donor = await makeDonor()
    stubFetch((url) => (url.startsWith(SENSE) ? senseModels(["nova-a"]) : undefined))
    // 渠道里放两把**前缀不同**的旁 Key：模拟「捐献的那把已被手工移除」
    const stub = stubNewApiChannelFlow({ keys: ["sn-upstream-key-aaaa1", "sn-upstream-key-bbbb2"] })

    const res = await submitSensenova(donor, "sn-gone-key-9999")
    const body = (await res.json()) as { id: string; channelId: number | null }
    // 先手工把捐献进来的那把摘掉，再撤销
    stub.keys.splice(stub.keys.indexOf("sn-gone-key-9999"), 1)

    const revoke = await fetchSelf(
      authRequest(admin, `/admin/donations/${body.id}/revoke`, { method: "POST" })
    )
    const out = (await revoke.json()) as {
      releasedChannel: boolean
      releaseMessage: string | null
    }
    expect(out.releasedChannel).toBe(false)
    expect(out.releaseMessage).toContain("没找到这把 Key")
    expect(stub.keys).toEqual(["sn-upstream-key-aaaa1", "sn-upstream-key-bbbb2"])
    expect(calls.some((c) => c.method === "DELETE")).toBe(false)
  })
})

describe("捐献页的通道概况", () => {
  it("GET /donations 带上 sensenova 块（含控制台地址）", async () => {
    const user = await makeDonor()
    const res = await fetchSelf(authRequest(user, "/donations"))
    const body = (await res.json()) as {
      sensenova: { enabled: boolean; consoleUrl: string }
    }
    expect(body.sensenova.enabled).toBe(true)
    expect(body.sensenova.consoleUrl).toContain("sensenova")
    // 上游地址与目标渠道都是服务端配置，不该下发给用户
    expect(JSON.stringify(body.sensenova)).not.toContain(SENSE)
    expect(JSON.stringify(body.sensenova)).not.toContain(String(TARGET_ID))
  })

  it("通道关闭时 enabled=false", async () => {
    await setSetting("sensenova_enabled", "0")
    const user = await makeDonor()
    const res = await fetchSelf(authRequest(user, "/donations"))
    const body = (await res.json()) as { sensenova: { enabled: boolean } }
    expect(body.sensenova.enabled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 定期巡检：封堵「捐了 Key 拿到权限后把 Key 删掉」
//
// 这条链路的真实风险不在算错，而在**判据的宽严**：
//   · 把「超时 / 限流 / 5xx」也当成 Key 失效 ⇒ 会误伤正常用户的权限（最严重）；
//   · 把「用户还有别的 ai 依据」漏掉 ⇒ 会把只贡献了一份的用户连坐（用户明确禁止）；
//   · 收回云端权限却不封中转站账号 ⇒ 等于没收回（对方照样能调）。
// 下面逐个钉死。
// ---------------------------------------------------------------------------

/** 邮件出站统一应答成功（否则会真的去连邮件服务商，慢且不确定） */
function stubMailer(): void {
  stubFetch((url) => {
    if (url.startsWith(SENSE) || url.startsWith(NEWAPI)) return undefined
    return jsonResponse({ success: true, message: "" })
  })
}

/**
 * 装配一次「上游可控」的桩：邮件 → 中转站 → 商汤（后注册的先命中）。
 * `sense` 决定商汤此刻返回什么（用它可以模拟「用户把 Key 删了」）。
 */
function setupUpstreams(
  sense: () => Response,
  opts: Parameters<typeof stubNewApiChannelFlow>[0] = {}
): { keys: string[] } {
  stubMailer()
  const channel = stubNewApiChannelFlow(opts)
  stubFetch((url) => (url.startsWith(SENSE) ? sense() : undefined))
  return channel
}

/** 给用户挂一个中转站账号（用于观察「收回权限 ⇒ 连带封禁」） */
async function bindNewApiAccount(userId: string, newapiUserId = 9001): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO newapi_accounts
       (user_id, newapi_user_id, username, email, enc_token, quota, used_quota, request_count, created_at)
     VALUES (?, ?, ?, ?, 'enc', 0, 0, 0, ?)`
  )
    .bind(userId, newapiUserId, `napi_${newapiUserId}`, `napi_${newapiUserId}@doulor.cn`, new Date().toISOString())
    .run()
}

/** 提交一笔商汤捐献并返回单据 id（前提：桩已装好且 Key 有效） */
async function donateAndApprove(user: TestUser, apiKey = "sn-test-key-0001"): Promise<string> {
  const res = await submitSensenova(user, apiKey)
  const body = (await res.json()) as { id?: string; status: string; channelId: number | null }
  expect(body.status).toBe("approved")
  expect(body.channelId).toBe(TARGET_ID)
  return body.id ?? ""
}

const KEY_ALIVE = () => senseModels(["nova-a", "nova-b"])
const KEY_DEAD = () => jsonResponse({}, 401)

describe("auditSenseNovaKeys —— 商汤 Key 定期巡检", () => {
  // ⚠️ 本文件的测试库在 test 之间**不隔离**（同文件共享同一个 D1），而前面的用例
  // 也造了「已通过」的商汤单据 —— 不清理的话巡检会把它们一起扫进去，
  // `checked / invalid` 这类计数断言就永远对不上。所以这里显式清空商汤单据。
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM donations WHERE type = 'sensenova'").run()
  })

  it("Key 仍然有效 → 什么都不做", async () => {
    const donor = await makeDonor()
    const stub = setupUpstreams(KEY_ALIVE)
    const id = await donateAndApprove(donor)
    expect((await readPerms(donor.id)).ai).toBe(true)

    const r = await auditSenseNovaKeys(env)
    expect(r.checked).toBe(1)
    expect(r.invalid).toBe(0)
    expect(r.uncertain).toBe(0)
    expect(r.keysRemoved).toBe(0)
    expect(r.permissionsRevoked).toBe(0)

    expect(stub.keys).toContain("sn-test-key-0001")
    expect((await readPerms(donor.id)).ai).toBe(true)
    expect((await readDonation(id))?.status).toBe("approved")
  })

  it("Key 被上游明确拒绝（401）→ 摘 Key + 收回 ai + 封禁中转站账号 + 单据转 revoked", async () => {
    const donor = await makeDonor()
    await bindNewApiAccount(donor.id, 9001)
    const stub = setupUpstreams(KEY_ALIVE)
    const id = await donateAndApprove(donor)
    expect((await readPerms(donor.id)).ai).toBe(true)

    // 用户去商汤控制台把 Key 删了 → 上游开始 401
    stubFetch((url) => (url.startsWith(SENSE) ? KEY_DEAD() : undefined))

    const r = await auditSenseNovaKeys(env)
    expect(r.checked).toBe(1)
    expect(r.invalid).toBe(1)
    expect(r.uncertain).toBe(0)
    expect(r.keysRemoved).toBe(1)
    expect(r.permissionsRevoked).toBe(1)
    expect(r.newapiDisabled).toBe(1)

    // 那把 Key 被摘掉，管理员原有的两把 Key 分毫未动
    expect(stub.keys).toEqual(["sn-upstream-key-aaaa1", "sn-upstream-key-bbbb2"])
    expect((await readPerms(donor.id)).ai).toBe(false)

    const d = await readDonation(id)
    expect(d?.status).toBe("revoked")
    expect(d?.review_note).toContain("已被上游拒绝")
    expect(d?.review_note).toContain("已收回")

    // 连带封禁中转站账号（不封的话「云端没权限、中转站照用」）
    // ⚠️ 2026-09-30 起授权 ai 时也会调一次 enable（修「巡检禁用后重新捐献却没人解禁」），
    //    所以这里不能再 `find` 第一条，要看**最后一条**是不是 disable。
    const manageCalls = calls.filter((c) => c.url.endsWith("/api/user/manage"))
    expect(manageCalls.length).toBeGreaterThanOrEqual(2)
    expect(manageCalls[0]?.body).toMatchObject({ id: 9001, action: "enable" })
    expect(manageCalls.at(-1)?.body).toMatchObject({ id: 9001, action: "disable" })

    // 幂等：处理过的单据不再被扫（不会每轮重复发通知 / 重复禁用）
    const again = await auditSenseNovaKeys(env)
    expect(again.checked).toBe(0)
  })

  it("巡检禁用中转站后重新捐献通过 ⇒ 账号被重新启用（2026-09-30 修 pillbox 案例）", async () => {
    const donor = await makeDonor()
    await bindNewApiAccount(donor.id, 9002)
    const stub = setupUpstreams(KEY_ALIVE)
    await donateAndApprove(donor, "sn-test-key-0001")
    expect((await readPerms(donor.id)).ai).toBe(true)

    // 第一把 Key 被上游拒绝 → 巡检收回权限，并连带禁用中转站账号
    stubFetch((url) => (url.startsWith(SENSE) ? KEY_DEAD() : undefined))
    const revoked = await auditSenseNovaKeys(env)
    expect(revoked.newapiDisabled).toBe(1)
    expect((await readPerms(donor.id)).ai).toBe(false)

    // 用户重新捐了一把**有效**的 Key → 自动审核通过、ai 权限恢复
    setupUpstreams(KEY_ALIVE)
    await donateAndApprove(donor, "sn-test-key-0002")
    expect((await readPerms(donor.id)).ai).toBe(true)

    // ⚠️ 关键断言：最后一条 manage 调用必须是 enable ——
    //    否则就是 pillbox 那个 bug：权限回来了，中转站账号还躺在禁用状态，
    //    用户「明明有 ai 权限，怎么调都失败」。
    const manageCalls = calls.filter((c) => c.url.endsWith("/api/user/manage"))
    expect(manageCalls.length).toBeGreaterThanOrEqual(3)
    expect(manageCalls.at(-1)?.body).toMatchObject({ id: 9002, action: "enable" })
  })

  it("上游 500（网络问题）→ **放过**，不摘 Key、不收回、单据不动", async () => {
    const donor = await makeDonor()
    const stub = setupUpstreams(KEY_ALIVE)
    const id = await donateAndApprove(donor)

    stubFetch((url) => (url.startsWith(SENSE) ? jsonResponse({}, 500) : undefined))

    const r = await auditSenseNovaKeys(env)
    expect(r.invalid).toBe(0)
    expect(r.uncertain).toBe(1)
    expect(r.keysRemoved).toBe(0)
    expect(r.permissionsRevoked).toBe(0)

    expect(stub.keys).toContain("sn-test-key-0001")
    expect((await readPerms(donor.id)).ai).toBe(true)
    expect((await readDonation(id))?.status).toBe("approved")
  })

  it("上游 429（限流）→ 同样放过（这正是用户点名要排除的情形）", async () => {
    const donor = await makeDonor()
    const stub = setupUpstreams(KEY_ALIVE)
    const id = await donateAndApprove(donor)

    stubFetch((url) => (url.startsWith(SENSE) ? jsonResponse({}, 429) : undefined))

    const r = await auditSenseNovaKeys(env)
    expect(r.uncertain).toBe(1)
    expect(r.keysRemoved).toBe(0)
    expect(r.permissionsRevoked).toBe(0)
    expect(stub.keys).toContain("sn-test-key-0001")
    expect((await readPerms(donor.id)).ai).toBe(true)
    expect((await readDonation(id))?.status).toBe("approved")
  })

  it("地址配错（404）→ 也放过（那是我们配置的问题，不怪用户）", async () => {
    const donor = await makeDonor()
    const stub = setupUpstreams(KEY_ALIVE)
    const id = await donateAndApprove(donor)

    stubFetch((url) => (url.startsWith(SENSE) ? jsonResponse({}, 404) : undefined))

    const r = await auditSenseNovaKeys(env)
    expect(r.uncertain).toBe(1)
    expect(r.permissionsRevoked).toBe(0)
    expect((await readPerms(donor.id)).ai).toBe(true)
    expect((await readDonation(id))?.status).toBe("approved")
  })

  it("用户还有另一笔已通过的 AI 捐献 → 只摘 Key，**保留**权限（不连坐）", async () => {
    const donor = await makeDonor()
    const stub = setupUpstreams(KEY_ALIVE)
    const id = await donateAndApprove(donor)

    // 该用户另外捐过一个 AI 渠道（已通过）——这就是「提交了好几个 ai 渠道」
    await env.DB.prepare(
      `INSERT INTO donations (id, user_id, type, payload, notify_email, status, granted_feature, created_at)
       VALUES (?, ?, 'ai', '{}', ?, 'approved', 0, ?)`
    )
      .bind(`other-${id}`, donor.id, "a@example.net", new Date().toISOString())
      .run()

    stubFetch((url) => (url.startsWith(SENSE) ? KEY_DEAD() : undefined))

    const r = await auditSenseNovaKeys(env)
    expect(r.invalid).toBe(1)
    expect(r.keysRemoved).toBe(1)
    expect(r.permissionsRevoked).toBe(0)
    expect(r.keptWithOtherSource).toBe(1)

    // Key 照样摘掉（死 Key 留着只会拖慢上游轮询），但权限保留
    expect(stub.keys).not.toContain("sn-test-key-0001")
    expect((await readPerms(donor.id)).ai).toBe(true)
  })

  it("用户还有在用中的反代绑定（wb2api）→ 保留权限", async () => {
    const donor = await makeDonor()
    const stub = setupUpstreams(KEY_ALIVE)
    await donateAndApprove(donor)

    await env.DB.prepare(
      `INSERT INTO wb2api_bindings (id, user_id, uid, status, granted_ai_permission, created_at)
       VALUES (?, ?, ?, 'active', 0, ?)`
    )
      .bind(`wb-${donor.id}`, donor.id, `uid-${donor.id}`, new Date().toISOString())
      .run()

    stubFetch((url) => (url.startsWith(SENSE) ? KEY_DEAD() : undefined))

    const r = await auditSenseNovaKeys(env)
    expect(r.keptWithOtherSource).toBe(1)
    expect(r.permissionsRevoked).toBe(0)
    expect(stub.keys).not.toContain("sn-test-key-0001")
    expect((await readPerms(donor.id)).ai).toBe(true)
  })

  it("权限本来就有（granted_feature=0）→ 摘 Key 但不收回权限", async () => {
    const user = await makeDonor()
    await setPermissions(user.id, JSON.stringify({ ai: true }))
    const stub = setupUpstreams(KEY_ALIVE)
    const id = await donateAndApprove(user)
    expect((await readDonation(id))?.status).toBe("approved")

    stubFetch((url) => (url.startsWith(SENSE) ? KEY_DEAD() : undefined))

    const r = await auditSenseNovaKeys(env)
    expect(r.invalid).toBe(1)
    expect(r.keptNotGranted).toBe(1)
    expect(r.permissionsRevoked).toBe(0)
    expect(stub.keys).not.toContain("sn-test-key-0001")
    expect((await readPerms(user.id)).ai).toBe(true)
  })

  it("dryRun → 只观察：不摘 Key、不收回、不改单据", async () => {
    const donor = await makeDonor()
    const stub = setupUpstreams(KEY_ALIVE)
    const id = await donateAndApprove(donor)

    stubFetch((url) => (url.startsWith(SENSE) ? KEY_DEAD() : undefined))

    const r = await auditSenseNovaKeys(env, { dryRun: true })
    expect(r.checked).toBe(1)
    expect(r.invalid).toBe(1)
    expect(r.keysRemoved).toBe(0)
    // 预演也要算出「将会收回」的预测值 —— 否则站长看不到影响面，预演就白做了
    expect(r.permissionsRevoked).toBe(1)
    expect(r.newapiDisabled).toBe(0)
    expect(r.notes.join("")).toContain("预演")
    expect(r.notes.join("")).toContain("将摘除")

    // 但库里一个字段都不能动
    expect(stub.keys).toContain("sn-test-key-0001")
    expect((await readPerms(donor.id)).ai).toBe(true)
    expect((await readDonation(id))?.status).toBe("approved")
  })

  it("手动全量（all）→ 一次查完，不受轮转批次限制", async () => {
    // ⚠️ 捐献提交按用户限流 10 笔/10 分钟，超过会 429 —— 第 11 笔换个用户提交
    const donorA = await makeDonor()
    const donorB = await makeDonor()
    setupUpstreams(KEY_ALIVE)
    // 造 11 笔（超过 SENSENOVA_AUDIT_BATCH=10），才看得出「轮转」与「全量」的区别
    for (let i = 1; i <= 10; i++) {
      await donateAndApprove(donorA, `sn-test-key-${String(i).padStart(4, "0")}`)
    }
    await donateAndApprove(donorB, "sn-test-key-0011")

    // 定时任务：一轮只扫一批（≤ 上限）。
    // 不写死等于 10 —— 轮转窗口随「小时数 % 2」在两批之间切换，写死就会隔小时翻车。
    const rotated = await auditSenseNovaKeys(env)
    expect(rotated.checked).toBeLessThanOrEqual(10)
    expect(rotated.invalid).toBe(0)

    // 手动全量：11 笔一次扫完
    const full = await auditSenseNovaKeys(env, { all: true })
    expect(full.checked).toBe(11)
    expect(full.invalid).toBe(0)
  })

  it("上游地址未配置 → 整轮跳过（不发任何请求）", async () => {
    const donor = await makeDonor()
    setupUpstreams(KEY_ALIVE)
    await donateAndApprove(donor)

    // 捐献成功后再把地址清掉（模拟「管理员把商汤配置撤了」）
    await setSetting("sensenova_base_url", "")
    calls = []

    const r = await auditSenseNovaKeys(env)
    expect(r.checked).toBe(0)
    expect(r.invalid).toBe(0)
    expect(calls).toHaveLength(0)
  })
})
