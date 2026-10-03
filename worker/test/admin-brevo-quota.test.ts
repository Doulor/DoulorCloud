// Brevo 额度面板接口的回归测试。
//
// 该面板要如实告诉管理员「每把 Key 今天还剩多少封」。
// 关键点：某把 Key 读不到（最常见是子账号开了 IP 校验 → 401）时，
// **必须把原因如实带出来**，绝不能显示成 0 —— 那会被误读成「额度用完了」。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { makeUser, authRequest, fetchSelf, setSetting } from "./helpers"

let restoreFetch: (() => void) | null = null
/** api-key → 响应 */
let responder: (key: string) => Response = () => accountBody("a@x.com", 139)

function accountBody(email: string, credits: number) {
  return new Response(
    JSON.stringify({ email, plan: [{ type: "free", credits, creditsType: "sendLimit" }] }),
    { status: 200 }
  )
}
function ipBlocked() {
  return new Response(
    JSON.stringify({ code: "unauthorized", message: "unrecognised IP address" }),
    { status: 401 }
  )
}

beforeEach(() => {
  responder = () => accountBody("a@x.com", 139)
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.includes("api.brevo.com")) {
      const key = String((init?.headers as Record<string, string> | undefined)?.["api-key"] ?? "")
      return responder(key)
    }
    return original(input as RequestInfo, init)
  }) as unknown as typeof fetch
  restoreFetch = () => {
    globalThis.fetch = original
  }
})

afterEach(() => {
  restoreFetch?.()
  restoreFetch = null
})

async function callQuota() {
  const admin = await makeUser({ role: "admin" })
  const res = await fetchSelf(authRequest(admin, "/api/admin/mail/brevo-quota"))
  return { res, body: (await res.json()) as Record<string, unknown> }
}

describe("GET /api/admin/mail/brevo-quota", () => {
  it("多把 Key 各自报剩余，合计为剩余之和", async () => {
    await setSetting("brevo_api_key", "k1,k2")
    responder = (key) => (key === "k1" ? accountBody("a@x.com", 139) : accountBody("b@x.com", 300))

    const { res, body } = await callQuota()
    expect(res.status).toBe(200)
    expect(body.totalCount).toBe(2)
    expect(body.okCount).toBe(2)
    expect(body.totalRemaining).toBe(439)
    expect(body.freeDailyLimit).toBe(300)

    const keys = body.keys as { index: number; email: string; credits: number }[]
    expect(keys[0]).toMatchObject({ index: 1, email: "a@x.com", credits: 139 })
    expect(keys[1]).toMatchObject({ index: 2, email: "b@x.com", credits: 300 })
  })

  it("某把 Key 读不到（IP 校验 401）→ 如实报原因，且不影响另一把", async () => {
    await setSetting("brevo_api_key", "blocked,ok")
    responder = (key) => (key === "blocked" ? ipBlocked() : accountBody("ok@x.com", 300))

    const { body } = await callQuota()
    expect(body.totalCount).toBe(2)
    expect(body.okCount).toBe(1)
    expect(body.totalRemaining).toBe(300)

    const keys = body.keys as { ok: boolean; credits: number | null; error: string | null }[]
    // 读不到的那把：ok=false、credits=null、error 有原因（绝不为 0）
    expect(keys[0].ok).toBe(false)
    expect(keys[0].credits).toBeNull()
    expect(keys[0].error).toContain("IP 校验")
    // 正常的那把不受影响
    expect(keys[1].ok).toBe(true)
    expect(keys[1].credits).toBe(300)
  })

  it("未配置 Key → 空列表，不报错", async () => {
    await setSetting("brevo_api_key", "")
    const { res, body } = await callQuota()
    expect(res.status).toBe(200)
    expect(body.totalCount).toBe(0)
    expect(body.keys).toEqual([])
  })

  it("非管理员 → 403", async () => {
    await setSetting("brevo_api_key", "k1")
    const user = await makeUser({ role: "user" })
    const res = await fetchSelf(authRequest(user, "/api/admin/mail/brevo-quota"))
    expect(res.status).toBe(403)
  })
})
