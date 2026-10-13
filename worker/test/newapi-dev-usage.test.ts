/**
 * AI 中转站首屏性能的一次回归（2026-10-12 站长反馈「进入这个页面很卡」）。
 *
 * 背景：`/api/dev/status` 原先要等 4 趟上游 NewAPI 往返（币种 / 健康 / 订阅 / 套餐），
 * 而上游实测单程 1.4~27.8s（`/api/subscription/plans` 一次 27.8s，连 401 都等这么久）
 * ⇒ 页面能卡十几秒甚至几十秒。
 *
 * 现在的契约（改坏了就是性能事故）：
 *   · `GET /api/dev/status` **不读上游**：health 恒为 null、subscriptions 恒为空；
 *   · 实时数据一律走 `GET /api/dev/usage` 懒加载（自带 TTL 缓存与硬超时）。
 *
 * 这里不测「快不快」（毫秒断言在 CI 上必 flaky），只锁**形状**：只要 status 又开始
 * 返回真实 health/订阅，就说明上游调用被塞回首屏了。
 */
import { describe, expect, it } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser } from "./helpers"

describe("AI 中转站 · 首屏与实时数据分离", () => {
  it("/dev/status 只回本地数据：health 为 null、订阅为空（首屏不等上游）", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const res = await fetchSelf(authRequest(admin, "/api/dev/status"))
    expect(res.status).toBe(200)
    const body = await res.json<{
      health: unknown
      subscriptions: unknown[]
      subscription: unknown
      currencySymbol: string
      quotaPerUnit: number
    }>()
    expect(body.health).toBeNull()
    expect(body.subscriptions).toEqual([])
    expect(body.subscription).toBeNull()
    // 本地就有的字段必须照常给出（否则前端渲染不出来）
    expect(typeof body.currencySymbol).toBe("string")
    expect(body.quotaPerUnit).toBeGreaterThan(0)
  })

  it("/dev/usage 返回实时部分（币种 + 健康），上游不可用时给兜底值而不是报错", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const res = await fetchSelf(authRequest(admin, "/api/dev/usage"))
    expect(res.status).toBe(200)
    const body = await res.json<{
      currency: { symbol: string; code: string; perUnit: number }
      health: { online: boolean }
      subscriptions: unknown[]
    }>()
    // ⚠️ 不断言 online 的真假：测试环境可能配了真实上游（.dev.vars），
    //    这里只锁「形状正确、有兜底、不 500」——健康探测本身带 3 秒超时。
    expect(body.currency.perUnit).toBeGreaterThan(0)
    expect(typeof body.currency.symbol).toBe("string")
    expect(typeof body.health.online).toBe("boolean")
    expect(Array.isArray(body.subscriptions)).toBe(true)
  })

  it("没有 ai 功能权限的用户一律 403（与 status 同一道闸）", async () => {
    const user = await makeUser({})
    // ⚠️ permissions 为 NULL 表示「按默认」，而 ai 在默认允许集里 ⇒ 必须显式关掉
    await env.DB.prepare("UPDATE users SET permissions = ? WHERE id = ?")
      .bind(JSON.stringify({ ai: false }), user.id)
      .run()
    const status = await fetchSelf(authRequest(user, "/api/dev/status"))
    const usage = await fetchSelf(authRequest(user, "/api/dev/usage"))
    expect(status.status).toBe(403)
    expect(usage.status).toBe(403)
  })
})
