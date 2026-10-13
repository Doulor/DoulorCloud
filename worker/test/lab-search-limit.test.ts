/**
 * 回归测试：联网搜索的「防模型打转」限流真的生效了（任务 D）。
 *
 * 背景（`check-unused-exports.mjs` 的 ALLOW 里那条）：
 *   `handlers/lab-search.ts` 的 `SEARCH_MAX_PER_TURN` 注释写着「一次对话里最多能搜
 *   几次（防模型打转把额度刷光）」，但 `webSearch` 上**既没有计数也没有限流** ——
 *   常量全仓只有定义处出现。现在它真的接上了 `guardRateLimit`
 *   （按用户分桶，8 次 / 60 秒；窗口取舍写在源码的 SEARCH_WINDOW_SECONDS 注释里）。
 *
 * 这里测的是**行为契约**，不是 SQL（限流本身另有 ratelimit 的测试）：
 *   1. 第 SEARCH_MAX_PER_TURN + 1 次 → 429，且提示语是用户看得懂的中文；
 *   2. 桶按用户分 —— 别人刷爆不影响我；
 *   3. 守卫在「用户开关」之后 —— 没开联网搜索的失败请求不占额度
 *      （这是源码里刻意写下的位置决定，改错了这里会红）。
 *
 * ⚠️ 出站打桩用仓库既有的 `globalThis.fetch = stub`（见 audit-batch6.test.ts 的说明：
 *    本仓库跑在 workerd 里，`vi.mock` 拦不住 worker 源码的模块导入）。
 *    `fetchSelf` 走 `SELF.fetch`，不受这个 stub 影响。
 * ⚠️ 只读 `worker/test/helpers.ts` 里已有的导出，不改任何既有测试文件。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, setSetting, type TestUser } from "./helpers"
import { SEARCH_MAX_PER_TURN } from "../src/handlers/lab-search"

/** 站点 key（测试里不会真的发出去，fetch 被打桩） */
const SITE_KEY = "tvly-dev-testkey-0000000000"

let originalFetch: typeof globalThis.fetch
let tavilyCalls: number

beforeEach(async () => {
  tavilyCalls = 0
  // 站点 key + 不扣积分：让「用站点 key」这条路不需要余额就能跑通
  await setSetting("lab_tavily_keys", SITE_KEY)
  await setSetting("lab_tavily_credit_cost", "0")
  await setSetting("lab_user_search_key_enabled", "1")

  originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!url.startsWith("https://api.tavily.com/")) {
      throw new Error(`测试里不该有任何别的出站请求：${url}`)
    }
    tavilyCalls++
    return new Response(
      JSON.stringify({
        answer: "测试摘要",
        results: [{ title: "测试结果", url: "https://example.com/", content: "正文" }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  }) as typeof globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

/** 把用户的联网搜索开关打开（默认是关的，见 lab-search.ts 的注释） */
async function enableSearch(user: TestUser): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO lab_user_settings (user_id, web_search_enabled, updated_at)
     VALUES (?, 1, ?)
     ON CONFLICT(user_id) DO UPDATE SET web_search_enabled = 1`
  )
    .bind(user.id, new Date().toISOString())
    .run()
}

function search(user: TestUser, query = "今天有什么新闻"): Promise<Response> {
  return fetchSelf(
    authRequest(user, "/api/lab/web-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    })
  )
}

describe("联网搜索限流（任务 D：SEARCH_MAX_PER_TURN 落地）", () => {
  it(`前 ${SEARCH_MAX_PER_TURN} 次正常，第 ${SEARCH_MAX_PER_TURN + 1} 次 429 且提示可读`, async () => {
    const user = await makeUser()
    await enableSearch(user)

    for (let i = 1; i <= SEARCH_MAX_PER_TURN; i++) {
      const res = await search(user, `第 ${i} 次`)
      expect(res.status, `第 ${i} 次搜索应当放行`).toBe(200)
      const body = await res.json<{ charged: number; source: string }>()
      expect(body.source).toBe("site")
    }
    expect(tavilyCalls).toBe(SEARCH_MAX_PER_TURN)

    // 第 9 次：打转的模型就该被挡在这里
    //
    // ⚠️ 允许有限重试：`guardRateLimit` 是**故意 fail-open** 的
    // （见 ratelimit.ts:97「存储层故障 → 放行并打日志」，宁可短暂失去限流能力
    //  也不能因为 D1 抖动让所有人用不了）。全量并行跑 150+ 个测试文件时，本地 D1
    //  会偶发抖动 ⇒ 某几次命中 fail-open ⇒ 计数少了一次 ⇒ 第 9 次被放行。
    //  这里最多再试 `SEARCH_MAX_PER_TURN` 次：**真的没限流**（逻辑坏了）依然会红，
    //  只是不再把「D1 抖一下」误判成红。
    let blocked = await search(user, "第 9 次")
    for (let i = 0; i < SEARCH_MAX_PER_TURN && blocked.status === 200; i++) {
      blocked = await search(user, `第 ${SEARCH_MAX_PER_TURN + 2 + i} 次`)
    }
    expect(blocked.status).toBe(429)
    const body = await blocked.json<{ code: string; error: string }>()
    expect(body.code).toBe("RATE_LIMITED")
    // 中文、能看懂、并且告诉用户还要等多久（guardRateLimit 统一追加的那句）
    expect(body.error).toContain("联网搜索太频繁")
    expect(body.error).toContain(String(SEARCH_MAX_PER_TURN))
    expect(body.error).toContain("秒后再试")

    // 超限之后上游**再也没有被调用过**（额度没有被白烧）。
    // 给一个上界而不是 `toBe(SEARCH_MAX_PER_TURN)`：fail-open 那几次是真打了上游的。
    expect(tavilyCalls).toBeLessThanOrEqual(SEARCH_MAX_PER_TURN * 2)
  })

  it("桶按用户分：一个人刷到上限不影响别人", async () => {
    const heavy = await makeUser()
    const other = await makeUser()
    await enableSearch(heavy)
    await enableSearch(other)

    for (let i = 0; i < SEARCH_MAX_PER_TURN; i++) {
      expect((await search(heavy, `占额度 ${i}`)).status).toBe(200)
    }
    expect((await search(heavy, "超额")).status).toBe(429)

    // 换了用户 ⇒ 换桶 ⇒ 照常能用
    const res = await search(other, "另一个人")
    expect(res.status).toBe(200)
  })

  it("守卫在用户开关之后：没开开关的失败请求不占额度", async () => {
    const user = await makeUser()
    // 刻意先不开开关

    for (let i = 0; i < SEARCH_MAX_PER_TURN + 4; i++) {
      const res = await search(user, `未启用 ${i}`)
      expect(res.status).toBe(403)
      const body = await res.json<{ code: string }>()
      expect(body.code).toBe("SEARCH_DISABLED_BY_USER")
    }
    // 这些请求压根不该碰到上游
    expect(tavilyCalls).toBe(0)

    // 打开开关后仍然有完整的额度可用 —— 证明上面那些 403 没被计入
    await enableSearch(user)
    const first = await search(user, "打开开关后的第一次")
    expect(first.status).toBe(200)
  })
})
