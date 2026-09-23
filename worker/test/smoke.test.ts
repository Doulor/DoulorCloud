import { env } from "cloudflare:workers"
import { describe, it, expect } from "vitest"

describe("smoke", () => {
  it("migrations applied", async () => {
    const r = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{ name: string }>()
    const names = (r.results ?? []).map((x) => x.name)
    expect(names).toContain("users")
  })

  it("identity migration 0023 applied", async () => {
    const cols = await env.DB.prepare("PRAGMA table_info(users)").all<{ name: string }>()
    const names = (cols.results ?? []).map((c) => c.name)
    expect(names).toContain("nickname")
    expect(names).toContain("avatar_key")
  })
})
