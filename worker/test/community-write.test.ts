import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf } from "./helpers"

describe("POST /api/community/posts", () => {
  it("creates a post", async () => {
    const u = await makeUser()
    const res = await fetchSelf(authRequest(u, "/api/community/posts", {
      method: "POST", body: JSON.stringify({ body: "第一条" }),
      headers: { "Content-Type": "application/json" },
    }))
    expect(res.status).toBe(201)
    const data = await res.json<{ post: { id: string } }>()
    expect(data.post.id).toBeTruthy()
  })

  it("rate-limits: 2 posts within 60s fails", async () => {
    const u = await makeUser()
    await fetchSelf(authRequest(u, "/api/community/posts", {
      method: "POST", body: JSON.stringify({ body: "1" }), headers: { "Content-Type": "application/json" },
    }))
    const res2 = await fetchSelf(authRequest(u, "/api/community/posts", {
      method: "POST", body: JSON.stringify({ body: "2" }), headers: { "Content-Type": "application/json" },
    }))
    expect(res2.status).toBe(429)
  })
})

describe("POST /api/community/posts/:id/like", () => {
  it("toggles like idempotently and updates count", async () => {
    const owner = await makeUser()
    const liker = await makeUser()
    const created = await fetchSelf(authRequest(owner, "/api/community/posts", {
      method: "POST", body: JSON.stringify({ body: "x" }), headers: { "Content-Type": "application/json" },
    }))
    const { post } = await created.json<{ post: { id: string } }>()
    const r1 = await fetchSelf(authRequest(liker, `/api/community/posts/${post.id}/like`, { method: "POST" }))
    expect(r1.status).toBe(200)
    const d1 = await r1.json<{ liked: boolean; likeCount: number }>()
    expect(d1.liked).toBe(true)
    expect(d1.likeCount).toBe(1)
    const r2 = await fetchSelf(authRequest(liker, `/api/community/posts/${post.id}/like`, { method: "POST" }))
    const d2 = await r2.json<{ liked: boolean; likeCount: number }>()
    expect(d2.liked).toBe(false)
    expect(d2.likeCount).toBe(0)
  })
})

describe("POST /api/community/posts/:id/share", () => {
  it("同一个人反复转发只计一次，换个人才 +1", async () => {
    const owner = await makeUser()
    const a = await makeUser()
    const b = await makeUser()
    const created = await fetchSelf(authRequest(owner, "/api/community/posts", {
      method: "POST", body: JSON.stringify({ body: "转发去重" }),
      headers: { "Content-Type": "application/json" },
    }))
    const { post } = await created.json<{ post: { id: string } }>()

    const r1 = await fetchSelf(authRequest(a, `/api/community/posts/${post.id}/share`, { method: "POST" }))
    expect(await r1.json()).toMatchObject({ shareCount: 1, alreadyShared: false })

    // 同一个人再点 3 次：数字不动，并且明确告诉前端「已经转过」
    for (let i = 0; i < 3; i++) {
      const r = await fetchSelf(authRequest(a, `/api/community/posts/${post.id}/share`, { method: "POST" }))
      expect(await r.json()).toMatchObject({ shareCount: 1, alreadyShared: true })
    }

    // 换一个人：+1
    const r2 = await fetchSelf(authRequest(b, `/api/community/posts/${post.id}/share`, { method: "POST" }))
    expect(await r2.json()).toMatchObject({ shareCount: 2, alreadyShared: false })

    const row = await env.DB.prepare("SELECT share_count FROM posts WHERE id = ?")
      .bind(post.id)
      .first<{ share_count: number }>()
    expect(row?.share_count).toBe(2)
  })
})

describe("POST /api/community/posts/:id/comments", () => {
  it("creates root and reply, increments comment_count", async () => {
    const u = await makeUser()
    const created = await fetchSelf(authRequest(u, "/api/community/posts", {
      method: "POST", body: JSON.stringify({ body: "p" }), headers: { "Content-Type": "application/json" },
    }))
    const pid = (await created.json<{ post: { id: string } }>()).post.id
    // 防刷屏：评论间隔 10s，用 DB 直接清掉最近评论时间让第二条能发
    const r1 = await fetchSelf(authRequest(u, `/api/community/posts/${pid}/comments`, {
      method: "POST", body: JSON.stringify({ body: "根" }), headers: { "Content-Type": "application/json" },
    }))
    expect(r1.status).toBe(201)
    const rootId = (await r1.json<{ comment: { id: string } }>()).comment.id
    // 清掉最近评论时间，绕过 10s 限制（测试用）
    await env.DB.prepare("UPDATE post_comments SET created_at=? WHERE id=?").bind(new Date(Date.now() - 60000).toISOString(), rootId).run()
    const r2 = await fetchSelf(authRequest(u, `/api/community/posts/${pid}/comments`, {
      method: "POST", body: JSON.stringify({ body: "回", parentId: rootId, replyToUserId: u.id }),
      headers: { "Content-Type": "application/json" },
    }))
    expect(r2.status).toBe(201)
    const post = await env.DB.prepare("SELECT comment_count FROM posts WHERE id=?").bind(pid).first<{comment_count:number}>()
    expect(post?.comment_count).toBe(2)
  })
})

describe("DELETE /api/community/posts/:id", () => {
  it("owner soft-deletes", async () => {
    const u = await makeUser()
    const created = await fetchSelf(authRequest(u, "/api/community/posts", {
      method: "POST", body: JSON.stringify({ body: "删我" }), headers: { "Content-Type": "application/json" },
    }))
    const pid = (await created.json<{ post: { id: string } }>()).post.id
    const del = await fetchSelf(authRequest(u, `/api/community/posts/${pid}`, { method: "DELETE" }))
    expect(del.status).toBe(200)
    const row = await env.DB.prepare("SELECT deleted_at FROM posts WHERE id=?").bind(pid).first<{deleted_at: string|null}>()
    expect(row?.deleted_at).not.toBeNull()
  })
})
