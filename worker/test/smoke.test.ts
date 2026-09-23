import { env } from "cloudflare:workers"
import { describe, it, expect } from "vitest"

describe("smoke", () => {
  it("migrations applied", async () => {
    const r = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{ name: string }>()
    const names = (r.results ?? []).map((x) => x.name)
    expect(names).toContain("users")
  })
})
