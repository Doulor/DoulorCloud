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
    { id: "c1", post_id: "p1", user_id: "u1", parent_id: null, body: "根1", createdAt: "t1" },
    { id: "c2", post_id: "p1", user_id: "u2", parent_id: "c1", body: "回1", createdAt: "t2" },
    { id: "c3", post_id: "p1", user_id: "u3", parent_id: "c1", body: "回2", createdAt: "t3" },
    { id: "c4", post_id: "p1", user_id: "u1", parent_id: null, body: "根2", createdAt: "t4" },
    { id: "c5", post_id: "p1", user_id: "u2", parent_id: "c2", body: "回1的子回复", createdAt: "t5" },
    { id: "c6", post_id: "p1", user_id: "u3", parent_id: "c5", body: "回1的孙回复", createdAt: "t6" },
  ]
  it("groups roots with their replies (depth 2)", () => {
    const tree = groupComments(comments as any)
    expect(tree).toHaveLength(2)
    expect(tree[0].id).toBe("c1")
    expect(tree[0].replies).toHaveLength(2)
    expect(tree[1].id).toBe("c4")
    expect(tree[1].replies).toHaveLength(0)
  })
  it("builds arbitrarily deep nesting", () => {
    const tree = groupComments(comments as any)
    const c1 = tree.find((n) => n.id === "c1")!
    const c2 = c1.replies.find((n) => n.id === "c2")!
    const c5 = c2.replies[0]
    expect(c5.id).toBe("c5")
    expect(c5.replies[0].id).toBe("c6")
  })
  it("treats orphan reply as root", () => {
    const tree = groupComments([
      { id: "orphan", post_id: "p1", user_id: "u1", parent_id: "missing", body: "x", createdAt: "t1" },
    ] as any)
    expect(tree).toHaveLength(1)
    expect(tree[0].id).toBe("orphan")
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
