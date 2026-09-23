import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf } from "./helpers"

describe("POST /api/community/posts/:id/images", () => {
  it("returns 503 when R2 not configured", async () => {
    const u = await makeUser()
    const created = await fetchSelf(authRequest(u, "/api/community/posts", {
      method: "POST", body: JSON.stringify({ body: "p" }), headers: { "Content-Type": "application/json" },
    }))
    const pid = (await created.json<{ post: { id: string } }>()).post.id
    const res = await fetchSelf(authRequest(u, `/api/community/posts/${pid}/images`, {
      method: "POST", body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
      headers: { "Content-Type": "image/png" },
    }))
    expect(res.status).toBe(503)
  })
})
