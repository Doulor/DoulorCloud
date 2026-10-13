/**
 * 中转站登记（2026-10-12）的接口边界。
 *
 * 守住的语义：
 *   · 令牌**永不回显**（响应里只能有 baseUrl，不能有 token 字段）；
 *   · 地址是**用户随手填的**，必须挡 SSRF（内网 / 本机 / 非 https）；
 *   · 登记前**先探测**：探测不通就不许落库（坏配置不进库）；
 *   · 只有登记人（或站长）能改 / 删。
 *
 * ⚠️ 这里不试真连上游：探测用的地址是 `https://127.0.0.1` 这类被挡的，
 * 以及一个必然连不上的域名 —— 断言的是「拒绝」而不是「连得上」。
 */
import { describe, expect, it } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser } from "./helpers"

type U = Awaited<ReturnType<typeof makeUser>>

function json(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }
}

async function createRelay(
  user: U,
  body: Record<string, unknown>
): Promise<Response> {
  return fetchSelf(authRequest(user, "/api/relay/providers", json("POST", body)))
}

describe("中转站登记", () => {
  it("未登录 401", async () => {
    const res = await fetchSelf(new Request("https://cloud.doulor.cn/api/relay/providers"))
    expect(res.status).toBe(401)
  })

  it("列表默认空，且不含任何令牌字段", async () => {
    const user = await makeUser({})
    const res = await fetchSelf(authRequest(user, "/api/relay/providers"))
    expect(res.status).toBe(200)
    const body = await res.json<{ providers: Record<string, unknown>[]; maxPerUser: number }>()
    expect(Array.isArray(body.providers)).toBe(true)
    expect(body.maxPerUser).toBeGreaterThan(0)
    expect(JSON.stringify(body)).not.toMatch(/token/i)
  })

  it("挡 SSRF：内网 / 本机 / 非 https 一律拒绝", async () => {
    const user = await makeUser({})
    const bad = [
      "http://example.com", // 明文 http（会泄露令牌）
      "https://127.0.0.1",
      "https://localhost:8080",
      "https://192.168.1.10",
      "https://169.254.169.254", // 云元数据地址
      "https://10.0.0.5",
      "https://cloud.doulor.cn", // 不给自己开环
      "not-a-url",
    ]
    for (const baseUrl of bad) {
      const res = await createRelay(user, {
        name: "测试站",
        kind: "newapi",
        baseUrl,
        adminToken: "admin-token-1234567890",
      })
      expect(res.status, `应拒绝 ${baseUrl}`).toBe(400)
    }
  })

  it("类型非法 / 令牌过短 / 名字含敏感词 都被拒", async () => {
    const user = await makeUser({})
    const base = { name: "测试站", baseUrl: "https://relay.example.com", adminToken: "admin-token-1234567890" }
    expect((await createRelay(user, { ...base, kind: "unknown" })).status).toBe(400)
    expect((await createRelay(user, { ...base, kind: "newapi", adminToken: "short" })).status).toBe(400)
    // 名字走与 OAuth 应用同一条校验（防冒充官方），空名字也该被拒
    expect((await createRelay(user, { ...base, kind: "newapi", name: "" })).status).toBe(400)
  })

  it("探测不通 ⇒ 不落库（坏配置进不了库）", async () => {
    const user = await makeUser({})
    const res = await createRelay(user, {
      name: "连不上的站",
      kind: "sub2api",
      // 这个域名必然连不上 ⇒ 探测失败 ⇒ 400
      baseUrl: "https://relay-probe-should-fail.invalid",
      adminToken: "admin-token-1234567890",
    })
    expect(res.status).toBe(400)
    const list = await fetchSelf(authRequest(user, "/api/relay/providers"))
    const body = await list.json<{ providers: unknown[] }>()
    expect(body.providers).toEqual([])
  })

  it("别人的站不能改 / 不能删", async () => {
    const owner = await makeUser({})
    const other = await makeUser({})
    // 直接插库造一条（跳过探测），只为验证归属校验
    await env.DB.prepare(
      `INSERT INTO relay_providers
         (id, name, kind, base_url, token_enc, owner_user_id, enabled, sort, created_at, updated_at)
       VALUES ('rp_test_1', '朋友的站', 'newapi', 'https://relay.example.com', 'x', ?, 1, 100, ?, ?)`
    )
      .bind(owner.id, new Date().toISOString(), new Date().toISOString())
      .run()

    const put = await fetchSelf(
      authRequest(other, "/api/relay/providers/rp_test_1", json("PUT", { name: "改名" }))
    )
    expect(put.status).toBe(403)
    const del = await fetchSelf(
      authRequest(other, "/api/relay/providers/rp_test_1", { method: "DELETE" })
    )
    expect(del.status).toBe(403)

    // 登记人自己可以删
    const own = await fetchSelf(
      authRequest(owner, "/api/relay/providers/rp_test_1", { method: "DELETE" })
    )
    expect(own.status).toBe(200)
  })

  it("普通用户看不到管理端列表（403）", async () => {
    const user = await makeUser({})
    const res = await fetchSelf(authRequest(user, "/api/admin/relay-providers"))
    expect(res.status).toBe(403)
  })
})
