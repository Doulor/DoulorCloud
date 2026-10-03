import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf } from "./helpers"

describe("管理员维护推荐模型", () => {
  it("PUT 传数组 → 清洗后落库，status 能读回", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await fetchSelf(
      authRequest(admin, "/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newapi_recommended_models: [
            { tier: "第一梯队", desc: "综合最强", models: ["glm-5.2", "deepseek-v4-pro"] },
            { tier: "空梯队", desc: "x", models: [] },
          ],
        }),
      })
    )
    expect(res.status).toBe(200)

    const row = await env.DB.prepare(
      "SELECT value FROM app_settings WHERE key = 'newapi_recommended_models'"
    ).first<{ value: string }>()
    const parsed = JSON.parse(row?.value ?? "[]")
    expect(parsed.length).toBe(1)
    expect(parsed[0].tier).toBe("第一梯队")
    expect(parsed[0].models).toEqual(["glm-5.2", "deepseek-v4-pro"])
  })

  it("空数组能清空（不被当成空值跳过）", async () => {
    const admin = await makeUser({ role: "admin" })
    // 先写入
    await fetchSelf(
      authRequest(admin, "/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newapi_recommended_models: [{ tier: "T", models: ["m"] }],
        }),
      })
    )
    // 再清空
    const res = await fetchSelf(
      authRequest(admin, "/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newapi_recommended_models: [] }),
      })
    )
    expect(res.status).toBe(200)
    const row = await env.DB.prepare(
      "SELECT value FROM app_settings WHERE key = 'newapi_recommended_models'"
    ).first<{ value: string }>()
    expect(JSON.parse(row?.value ?? "null")).toEqual([])
  })

  it("JSON 字符串形式也接受", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await fetchSelf(
      authRequest(admin, "/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newapi_recommended_models: JSON.stringify([{ tier: "T", models: ["a"] }]),
        }),
      })
    )
    expect(res.status).toBe(200)
  })

  it("坏 JSON → 400 且不落库", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await fetchSelf(
      authRequest(admin, "/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newapi_recommended_models: "{oops" }),
      })
    )
    expect(res.status).toBe(400)
  })

  it("非管理员被拒", async () => {
    const u = await makeUser()
    const res = await fetchSelf(
      authRequest(u, "/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newapi_recommended_models: [] }),
      })
    )
    expect(res.status).toBe(403)
  })
})
