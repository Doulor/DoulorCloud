import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf } from "./helpers"

describe("PUT /api/settings/nickname", () => {
  it("sets nickname and returns it", async () => {
    const u = await makeUser()
    const res = await fetchSelf(authRequest(u, "/api/settings/nickname", {
      method: "PUT", body: JSON.stringify({ nickname: "阿豆" }),
      headers: { "Content-Type": "application/json" },
    }))
    expect(res.status).toBe(200)
    const data = await res.json<{ nickname: string }>()
    expect(data.nickname).toBe("阿豆")
  })

  it("rejects reserved word", async () => {
    const u = await makeUser()
    const res = await fetchSelf(authRequest(u, "/api/settings/nickname", {
      method: "PUT", body: JSON.stringify({ nickname: "管理员" }),
      headers: { "Content-Type": "application/json" },
    }))
    expect(res.status).toBe(400)
  })

  it("rejects collision with admin username", async () => {
    await makeUser({ username: "bigboss", role: "admin" })
    const u = await makeUser()
    const res = await fetchSelf(authRequest(u, "/api/settings/nickname", {
      method: "PUT", body: JSON.stringify({ nickname: "bigboss" }),
      headers: { "Content-Type": "application/json" },
    }))
    expect(res.status).toBe(409)
  })

  it("allows clearing nickname (empty)", async () => {
    const u = await makeUser()
    await env.DB.prepare("UPDATE users SET nickname='清空者' WHERE id=?").bind(u.id).run()
    const res = await fetchSelf(authRequest(u, "/api/settings/nickname", {
      method: "PUT", body: JSON.stringify({ nickname: "" }),
      headers: { "Content-Type": "application/json" },
    }))
    expect(res.status).toBe(200)
    const row = await env.DB.prepare("SELECT nickname FROM users WHERE id=?").bind(u.id).first<{nickname: string|null}>()
    expect(row?.nickname).toBeNull()
  })
})
