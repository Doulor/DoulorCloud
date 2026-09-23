import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf } from "./helpers"

describe("头像接口", () => {
  it("returns 503 when R2 not configured", async () => {
    const u = await makeUser()
    const res = await fetchSelf(authRequest(u, "/api/settings/avatar", {
      method: "POST",
      body: new Uint8Array([0xff, 0xd8, 0xff]).buffer,
      headers: { "Content-Type": "image/jpeg" },
    }))
    expect(res.status).toBe(503)
  })

  it("DELETE clears avatar_key", async () => {
    const u = await makeUser()
    await env.DB.prepare("UPDATE users SET avatar_key=? WHERE id=?")
      .bind(`avatars/${u.username}.jpg`, u.id).run()
    const res = await fetchSelf(authRequest(u, "/api/settings/avatar", { method: "DELETE" }))
    expect(res.status).toBe(200)
    const row = await env.DB.prepare("SELECT avatar_key FROM users WHERE id=?").bind(u.id).first<{avatar_key: string|null}>()
    expect(row?.avatar_key).toBeNull()
  })
})
