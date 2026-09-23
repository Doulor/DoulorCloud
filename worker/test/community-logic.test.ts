import { describe, it, expect } from "vitest"
import { encodeCursor, decodeCursor, groupComments, canPostAgain } from "../src/community-logic"

describe("cursor", () => {
  it("encode/decode round-trips (createdAt, id)", () => {
    const c = encodeCursor("2026-09-23T10:00:00Z", "abc123")
    const back = decodeCursor(c)
    expect(back).toEqual({ createdAt: "2026-09-23T10:00:00Z", id: "abc123" })
  })
  it("decode invalid returns null", () => {
    expect(decodeCursor("not-base64-json")).toBeNull()
  })
})

describe("groupComments", () => {
  const comments = [
    { id: "c1", post_id: "p1", user_id: "u1", parent_id: null, body: "根1", created_at: "t1" },
    { id: "c2", post_id: "p1", user_id: "u2", parent_id: "c1", body: "回1", created_at: "t2" },
    { id: "c3", post_id: "p1", user_id: "u3", parent_id: "c1", body: "回2", created_at: "t3" },
    { id: "c4", post_id: "p1", user_id: "u1", parent_id: null, body: "根2", created_at: "t4" },
  ]
  it("groups roots with their replies (depth 2)", () => {
    const tree = groupComments(comments as any)
    expect(tree).toHaveLength(2)
    expect(tree[0].id).toBe("c1")
    expect(tree[0].replies).toHaveLength(2)
    expect(tree[1].id).toBe("c4")
    expect(tree[1].replies).toHaveLength(0)
  })
})

describe("canPostAgain", () => {
  it("allows when no previous", () => {
    expect(canPostAgain(null, 60)).toBe(true)
  })
  it("blocks within window, allows after", () => {
    const just = new Date(Date.now() - 10_000).toISOString() // 10s 前
    expect(canPostAgain(just, 60)).toBe(false)
    const old = new Date(Date.now() - 61_000).toISOString() // 61s 前
    expect(canPostAgain(old, 60)).toBe(true)
  })
})
