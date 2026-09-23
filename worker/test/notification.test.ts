import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf } from "./helpers"

describe("notifications", () => {
  it("commenting on own post does NOT notify self", async () => {
    const u = await makeUser()
    const created = await fetchSelf(authRequest(u, "/api/community/posts", {
      method: "POST", body: JSON.stringify({ body: "p" }), headers: { "Content-Type": "application/json" },
    }))
    const pid = (await created.json<{ post: { id: string } }>()).post.id
    await fetchSelf(authRequest(u, `/api/community/posts/${pid}/comments`, {
      method: "POST", body: JSON.stringify({ body: "自评" }), headers: { "Content-Type": "application/json" },
    }))
    const row = await env.DB.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=?").bind(u.id).first<{c:number}>()
    expect(row?.c).toBe(0)
  })

  it("replying notifies the replied user", async () => {
    const owner = await makeUser()
    const other = await makeUser()
    const created = await fetchSelf(authRequest(owner, "/api/community/posts", {
      method: "POST", body: JSON.stringify({ body: "p" }), headers: { "Content-Type": "application/json" },
    }))
    const pid = (await created.json<{ post: { id: string } }>()).post.id
    // other 评论根
    const r1 = await fetchSelf(authRequest(other, `/api/community/posts/${pid}/comments`, {
      method: "POST", body: JSON.stringify({ body: "根" }), headers: { "Content-Type": "application/json" },
    }))
    const rootId = (await r1.json<{ comment: { id: string } }>()).comment.id
    // 清掉评论防刷屏时间，让 owner 能马上回复
    await env.DB.prepare("UPDATE post_comments SET created_at=? WHERE id=?").bind(new Date(Date.now()-60000).toISOString(), rootId).run()
    // owner 回复 other → other 应收到 comment_reply
    await fetchSelf(authRequest(owner, `/api/community/posts/${pid}/comments`, {
      method: "POST", body: JSON.stringify({ body: "回", parentId: rootId, replyToUserId: other.id }),
      headers: { "Content-Type": "application/json" },
    }))
    const cnt = (await env.DB.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='comment_reply'").bind(other.id).first<{c:number}>())?.c
    expect(cnt).toBe(1)
  })

  it("GET /api/notifications/unread-count returns count", async () => {
    const u = await makeUser()
    await env.DB.prepare("INSERT INTO notifications (id, user_id, type, post_id, comment_id, read, created_at) VALUES (?, ?, 'post_comment', NULL, NULL, 0, ?)").bind("n1", u.id, new Date().toISOString()).run()
    const res = await fetchSelf(authRequest(u, "/api/notifications/unread-count"))
    expect(res.status).toBe(200)
    expect((await res.json<{ count: number }>()).count).toBe(1)
  })
})
