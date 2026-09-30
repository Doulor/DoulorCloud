// 捐献奖励积分：发放口径、防重放、以及管理端可配置。
//
// 语义（2026-09-29 站长明确）：捐献是用户**可重复赚积分**的通道 ——
// 每通过一笔新捐献就发一次。所以这里的用例锁的是：
//   1. 通过审核真的发分（reason=donation，文案带档位名）；
//   2. **每笔新捐献都发** —— 换个地址再捐一份（新单据）会再发一次；
//   3. **同一笔单据只发一次** —— 重复审核（撤销后重新批准）不翻倍；
//   4. 档位设 0 就不发；
//   5. 管理端改完立即生效，越界值被拒。
//
// 用「代理节点」这条线做集成测试：它的自动审核只依赖一个被打桩的订阅请求，
// 不需要 NewAPI / 上游模型测试这些重家伙。
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, setPermissions, setSetting, type TestUser } from "./helpers"
import { getPointsBalance } from "../src/points"

const SUB_A = "https://sub-a.example.com"
const SUB_B = "https://sub-b.example.com"
const SUB_C = "https://sub-c.example.com"

/** 一段能被 parseSubscription 解析的订阅内容（明文行式） */
const VALID_SUB = [
  "vless://11111111-2222-3333-4444-555555555555@1.2.3.4:443?type=ws&security=tls#香港节点",
  "ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ=@9.9.9.9:8388#美国节点",
].join("\n")

let restores: Array<() => void> = []

function stubFetch(handler: (url: string) => Response | undefined): void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    return handler(url) ?? original(input as RequestInfo, init)
  }) as unknown as typeof fetch
  restores.push(() => {
    globalThis.fetch = original
  })
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } })
}

/** 只放行 SUB_A / SUB_B / SUB_C 的订阅请求，其余原样透传 */
function stubSubs(): void {
  stubFetch((url) =>
    url.startsWith(SUB_A) || url.startsWith(SUB_B) || url.startsWith(SUB_C)
      ? textResponse(VALID_SUB)
      : undefined
  )
}

beforeEach(() => {
  // proxy_subscriptions 是跨用例可查的表，清掉避免互相干扰
  return env.DB.prepare("DELETE FROM proxy_subscriptions").run()
})

afterEach(() => {
  for (let i = restores.length - 1; i >= 0; i--) restores[i]()
  restores = []
  vi.restoreAllMocks()
})

/** 造一个可捐献的用户：显式关掉 proxy 权限，才能看出「捐献解锁」 */
async function makeDonor(): Promise<TestUser> {
  const user = await makeUser()
  await env.DB.prepare("UPDATE users SET email = ? WHERE id = ?")
    .bind(`${user.username}@example.net`, user.id)
    .run()
  await setPermissions(user.id, JSON.stringify({ r2: true, ai: true, frp: true, proxy: false }))
  return user
}

async function submitProxy(user: TestUser, url: string) {
  const res = await fetchSelf(
    authRequest(user, "/donations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "proxy", payload: { subUrls: [url] } }),
    })
  )
  return { res, body: (await res.json()) as Record<string, unknown> }
}

async function lastTx(userId: string) {
  return env.DB.prepare(
    "SELECT reason, detail, delta FROM point_transactions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1"
  )
    .bind(userId)
    .first<{ reason: string; detail: string; delta: number }>()
}

describe("捐献奖励积分", () => {
  it("代理捐献自动通过 → 按默认值发 3 分，流水 reason=donation", async () => {
    const user = await makeDonor()
    stubSubs()

    const { res } = await submitProxy(user, `${SUB_A}/sub/abc`)
    expect(res.status).toBe(200)
    expect(await getPointsBalance(env, user.id)).toBe(3)

    const tx = await lastTx(user.id)
    expect(tx?.reason).toBe("donation")
    expect(tx?.delta).toBe(3)
    // 流水文案要能看出「捐了什么」，否则用户对不上账
    expect(tx?.detail).toContain("代理节点")
  })

  it("每笔新捐献都发一次：换个地址再捐一份，会再发一次（可重复赚积分）", async () => {
    const user = await makeDonor()
    stubSubs()

    await submitProxy(user, `${SUB_A}/sub/a`)
    expect(await getPointsBalance(env, user.id)).toBe(3)

    // 第二次用不同订阅地址 —— 这是一笔**新单据**，按可重复赚积分的口径应再发一次。
    const second = await submitProxy(user, `${SUB_B}/sub/b`)
    expect(second.res.status).toBe(200)
    expect(await getPointsBalance(env, user.id)).toBe(6)

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM point_transactions WHERE user_id = ? AND reason = 'donation'"
    )
      .bind(user.id)
      .first<{ c: number }>()
    expect(count?.c).toBe(2)
  })

  it("同一笔单据只发一次：撤销后重新批准，不翻倍", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeDonor()
    stubSubs()

    const { body } = await submitProxy(user, `${SUB_A}/sub/abc`)
    expect(body.status).toBe("approved")
    expect(await getPointsBalance(env, user.id)).toBe(3)

    const id = body.id as string

    // 撤销 → 回到 pending（管理员撤销已通过的捐献）
    const revoke = await fetchSelf(
      authRequest(admin, `/admin/donations/${id}/revoke`, { method: "POST" })
    )
    expect(revoke.status).toBe(200)

    // 重新批准同一笔单据 —— 幂等键是单据 id，不应再发一次
    const review = await fetchSelf(
      authRequest(admin, "/admin/donations/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "approve" }),
      })
    )
    expect(review.status).toBe(200)
    expect(await getPointsBalance(env, user.id)).toBe(3)

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM point_transactions WHERE user_id = ? AND reason = 'donation'"
    )
      .bind(user.id)
      .first<{ c: number }>()
    expect(count?.c).toBe(1)
  })

  it("每日发放上限：领满后不再发分，设 0 恢复不限", async () => {
    await setSetting("donation_points_daily_limit", "1")
    const user = await makeDonor()
    stubSubs()

    // 第一笔：额度内，正常发 3 分
    await submitProxy(user, `${SUB_A}/sub/a`)
    expect(await getPointsBalance(env, user.id)).toBe(3)

    // 第二笔：今天已领满 1 次 ⇒ 捐献照样通过，但**不发分**（硬顶）
    const second = await submitProxy(user, `${SUB_B}/sub/b`)
    expect(second.res.status).toBe(200)
    expect(second.body.status).toBe("approved")
    expect(await getPointsBalance(env, user.id)).toBe(3)

    // 改成 0（不限）后，再捐就恢复发放
    await setSetting("donation_points_daily_limit", "0")
    await submitProxy(user, `${SUB_C}/sub/c`)
    expect(await getPointsBalance(env, user.id)).toBe(6)

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM point_transactions WHERE user_id = ? AND reason = 'donation'"
    )
      .bind(user.id)
      .first<{ c: number }>()
    expect(count?.c).toBe(2)
  })

  it("档位设成 0 → 不发分（审核仍通过）", async () => {
    await setSetting("donation_points_proxy", "0")
    const user = await makeDonor()
    stubSubs()

    const { res } = await submitProxy(user, `${SUB_A}/sub/abc`)
    expect(res.status).toBe(200)
    expect(await getPointsBalance(env, user.id)).toBe(0)
    expect(await lastTx(user.id)).toBeNull()
  })

  it("管理端改完立即生效：PUT /admin/points/config", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await fetchSelf(
      authRequest(admin, "/admin/points/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ donationRewards: { proxy: 7 } }),
      })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      donationRewards: { key: string; label: string; points: number }[]
    }
    // 下发的是数组（带中文名与固定顺序），前端照着渲染
    const proxy = body.donationRewards.find((d) => d.key === "proxy")
    expect(proxy?.points).toBe(7)
    expect(proxy?.label).toBeTruthy()

    const user = await makeDonor()
    stubSubs()
    await submitProxy(user, `${SUB_A}/sub/abc`)
    expect(await getPointsBalance(env, user.id)).toBe(7)
  })

  it("越界值被拒（负数 / 超过 100000）", async () => {
    const admin = await makeUser({ role: "admin" })
    for (const bad of [-1, 100_001]) {
      const res = await fetchSelf(
        authRequest(admin, "/admin/points/config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ donationRewards: { proxy: bad } }),
        })
      )
      expect(res.status).toBe(400)
    }
  })

  it("管理端可改每日发放上限，越界被拒", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await fetchSelf(
      authRequest(admin, "/admin/points/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ donationDailyLimit: 3 }),
      })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { donationDailyLimit: number }
    expect(body.donationDailyLimit).toBe(3)

    for (const bad of [-1, 1001]) {
      const r = await fetchSelf(
        authRequest(admin, "/admin/points/config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ donationDailyLimit: bad }),
        })
      )
      expect(r.status).toBe(400)
    }
  })

  it("未知档位被忽略，不会写成没人读的死设置项", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await fetchSelf(
      authRequest(admin, "/admin/points/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ donationRewards: { proxy: 3, not_a_kind: 999 } }),
      })
    )
    expect(res.status).toBe(200)
    const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?")
      .bind("donation_points_not_a_kind")
      .first<{ value: string }>()
    expect(row).toBeNull()
  })

  it("关掉积分兑换开关也不影响发分（积分仍是资产）", async () => {
    await setSetting("points_enabled", "0")
    const user = await makeDonor()
    stubSubs()

    await submitProxy(user, `${SUB_A}/sub/abc`)
    expect(await getPointsBalance(env, user.id)).toBe(3)
  })
})
