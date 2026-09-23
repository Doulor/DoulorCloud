import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf } from "./helpers"
import { uuid } from "../src/crypto"

async function seedPost(user: { id: string }, body = "hello", minutesAgo = 0) {
  const id = uuid()
  const at = new Date(Date.now() - minutesAgo * 60000).toISOString()
  await env.DB.prepare(
    "INSERT INTO posts (id, user_id, channel, body, created_at) VALUES (?, ?, 'general', ?, ?)"
  ).bind(id, user.id, body, at).run()
  return id
}

describe("GET /api/community/posts", () => {
  it("returns posts newest-first with author info, anonymous allowed", async () => {
    const u = await makeUser({ username: "alice" })
    await env.DB.prepare("UPDATE users SET nickname=? WHERE id=?").bind("爱丽丝", u.id).run()
    await seedPost(u, "旧帖", 2)
    await seedPost(u, "新帖", 0)
    const res = await fetchSelf(new Request("https://cloud.doulor.cn/api/community/posts?limit=10"))
    expect(res.status).toBe(200)
    const data = await res.json<{ posts: { body: string; author: { nickname: string } }[]; nextCursor: string | null }>()
    expect(data.posts).toHaveLength(2)
    expect(data.posts[0].body).toBe("新帖")
    expect(data.posts[0].author.nickname).toBe("爱丽丝")
    expect(data.nextCursor).toBeNull()
  })

  it("excludes soft-deleted posts from list", async () => {
    const u = await makeUser()
    const id = await seedPost(u, "将被删")
    await env.DB.prepare("UPDATE posts SET deleted_at=? WHERE id=?").bind(new Date().toISOString(), id).run()
    const res = await fetchSelf(new Request("https://cloud.doulor.cn/api/community/posts"))
    const data = await res.json<{ posts: { body: string }[] }>()
    expect(data.posts.find((p) => p.body === "将被删")).toBeUndefined()
  })
})

describe("GET /api/community/posts/:id/comments", () => {
  it("returns two-level tree", async () => {
    const u = await makeUser()
    const pid = await seedPost(u)
    await env.DB.prepare("INSERT INTO post_comments (id, post_id, user_id, parent_id, body, created_at) VALUES (?, ?, ?, NULL, '根', ?)")
      .bind(uuid(), pid, u.id, new Date().toISOString()).run()
    const rootRow = await env.DB.prepare("SELECT id FROM post_comments WHERE post_id=?").bind(pid).first<{id:string}>()
    const rootId = rootRow!.id
    await env.DB.prepare("INSERT INTO post_comments (id, post_id, user_id, parent_id, body, created_at) VALUES (?, ?, ?, ?, '回', ?)")
      .bind(uuid(), pid, u.id, rootId, new Date().toISOString()).run()
    const res = await fetchSelf(new Request(`https://cloud.doulor.cn/api/community/posts/${pid}/comments`))
    const data = await res.json<{ comments: { id: string; replies: { body: string }[] }[] }>()
    expect(data.comments).toHaveLength(1)
    expect(data.comments[0].replies).toHaveLength(1)
    expect(data.comments[0].replies[0].body).toBe("回")
  })
})
