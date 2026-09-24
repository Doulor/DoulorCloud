// 免权限访问（open_features）+ 个人名片去权限。
//
// 测的是真实 Worker 路由（miniflare SELF.fetch），因此是端到端证据：
// 权限校验发生在 requireFeatureUser，走完整路由 → handler → 鉴权链路。
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, setSetting, setPermissions } from "./helpers"

/** 显式卡掉 r2 与 ai（其余保持允许），模拟「没有权限的用户」 */
const NO_R2_AI = JSON.stringify({ r2: false, ai: false })

beforeEach(async () => {
  // app_settings 在用例间是共享的（同一个 D1），逐条清掉本文件涉及的开关，
  // 避免用例互相污染
  await env.DB.prepare("DELETE FROM app_settings WHERE key IN ('open_features')").run()
})

describe("免权限访问开关", () => {
  it("无权限用户默认被卡（403 FEATURE_NOT_PERMITTED）", async () => {
    const u = await makeUser()
    await setPermissions(u.id, NO_R2_AI)
    const res = await fetchSelf(authRequest(u, "/api/storage"))
    expect(res.status).toBe(403)
    const body = await res.json<{ code: string }>()
    expect(body.code).toBe("FEATURE_NOT_PERMITTED")
  })

  it("打开该模块后，同一用户可直接访问（200）", async () => {
    const u = await makeUser()
    await setPermissions(u.id, NO_R2_AI)

    await setSetting("open_features", "r2")
    const res = await fetchSelf(authRequest(u, "/api/storage"))
    expect(res.status).toBe(200)
    const body = await res.json<{ configured: boolean }>()
    // featureEnabled 是模块自己的全局总开关，与本次权限旁路无关
    expect(body).toHaveProperty("configured")
  })

  it("只放行被打开的模块：开了 r2，ai 仍然 403", async () => {
    const u = await makeUser()
    await setPermissions(u.id, NO_R2_AI)

    await setSetting("open_features", "r2")
    const ok = await fetchSelf(authRequest(u, "/api/storage"))
    expect(ok.status).toBe(200)

    const blocked = await fetchSelf(authRequest(u, "/api/dev/status"))
    expect(blocked.status).toBe(403)
    const body = await blocked.json<{ code: string }>()
    expect(body.code).toBe("FEATURE_NOT_PERMITTED")
  })

  it("关掉开关后立刻恢复按权限卡", async () => {
    const u = await makeUser()
    await setPermissions(u.id, NO_R2_AI)

    await setSetting("open_features", "r2")
    expect((await fetchSelf(authRequest(u, "/api/storage"))).status).toBe(200)

    await setSetting("open_features", "")
    expect((await fetchSelf(authRequest(u, "/api/storage"))).status).toBe(403)
  })

  it("管理员不受影响（原本就放行）", async () => {
    const admin = await makeUser({ role: "admin" })
    await setPermissions(admin.id, NO_R2_AI)
    const res = await fetchSelf(authRequest(admin, "/api/storage"))
    expect(res.status).toBe(200)
  })

  it("开关不会改动用户的 permissions 数据", async () => {
    const u = await makeUser()
    await setPermissions(u.id, NO_R2_AI)
    await setSetting("open_features", "ai")
    await fetchSelf(authRequest(u, "/api/dev/status"))

    const row = await env.DB.prepare("SELECT permissions FROM users WHERE id = ?")
      .bind(u.id)
      .first<{ permissions: string }>()
    expect(row?.permissions).toBe(NO_R2_AI)
  })
})

describe("个人名片已去权限", () => {
  it("permissions 里显式 profile:false 的用户也能读写名片", async () => {
    const u = await makeUser()
    // 历史数据里可能残留 profile:false —— 该键已不在 FEATURES 中，应被忽略
    await setPermissions(u.id, JSON.stringify({ r2: true, ai: true, profile: false }))

    const res = await fetchSelf(authRequest(u, "/api/profile"))
    expect(res.status).toBe(200)

    const enable = await fetchSelf(
      authRequest(u, "/api/profile/enable", { method: "POST" })
    )
    // 201 = 本次开通成功（此前未开通）；关键是**不是** 403
    expect(enable.status).toBe(201)
  })

  it("permissions 损坏（非法 JSON）也不影响名片", async () => {
    const u = await makeUser()
    await setPermissions(u.id, "{not json")
    const res = await fetchSelf(authRequest(u, "/api/profile"))
    expect(res.status).toBe(200)
  })
})

describe("PUT /api/admin/settings —— open_features 校验", () => {
  const put = (admin: { cookie: string }, open_features: unknown) =>
    fetchSelf(
      authRequest(admin, "/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ open_features }),
      })
    )

  it("非法模块名被拒（400）", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await put(admin, "bogus")
    expect(res.status).toBe(400)
  })

  it("空串合法（= 全部按权限卡，可清空）", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await put(admin, "")
    expect(res.status).toBe(200)

    const row = await env.DB.prepare(
      "SELECT value FROM app_settings WHERE key = 'open_features'"
    ).first<{ value: string }>()
    expect(row?.value).toBe("")
  })

  it("多个模块逗号分隔并写库", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await put(admin, "r2,proxy")
    expect(res.status).toBe(200)

    const row = await env.DB.prepare(
      "SELECT value FROM app_settings WHERE key = 'open_features'"
    ).first<{ value: string }>()
    expect(row?.value).toBe("r2,proxy")
  })

  it("invite_basic_features 也能用空串清空（顺带修复）", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await fetchSelf(
      authRequest(admin, "/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invite_basic_features: "" }),
      })
    )
    expect(res.status).toBe(200)

    const row = await env.DB.prepare(
      "SELECT value FROM app_settings WHERE key = 'invite_basic_features'"
    ).first<{ value: string }>()
    expect(row?.value).toBe("")
  })
})
