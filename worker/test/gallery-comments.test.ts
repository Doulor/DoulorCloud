/**
 * 造物集评论区（`/api/gallery/:id/comments`）的回归测试（2026-10-21）。
 *
 * 这组接口最危险的地方不是"能不能评论"，而是**越权和串场**：
 *   · 别人把私有作品的评论读出来；
 *   · A 作品的评论被挂到 B 作品下（parentId 不校验作品）；
 *   · 任何人删任何人的评论。
 * 每一条都钉死，因为这些洞一旦开了，靠看代码是发现不了的。
 *
 * 另外钉住两条业务口径：
 *   · 评论**按作品隔离** —— 两个作品的评论区互不相通；
 *   · 防刷是**跨作品统一计算**的 —— 否则在 N 个作品下各发一条就能绕过限流。
 */
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, type TestUser } from "./helpers"

/** 直接建一个作品行（跳过 /lab/projects 的发布流程，测试只需要数据） */
async function makeProject(
  owner: TestUser,
  opts: { visibility?: "public" | "private"; name?: string } = {}
): Promise<string> {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO lab_projects (id, user_id, name, slug, description, icon, files, visibility, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', '🌐', ?, ?, ?, ?)`
  )
    .bind(
      id,
      owner.id,
      opts.name ?? "测试作品",
      `p-${id.slice(0, 8)}`,
      JSON.stringify({ "index.html": "<h1>hi</h1>" }),
      opts.visibility ?? "public",
      now,
      now
    )
    .run()
  return id
}

const jsonHeaders = { "Content-Type": "application/json" }

describe("造物集评论：可见性与鉴权", () => {
  it("未登录读评论 → 401", async () => {
    const owner = await makeUser()
    const pid = await makeProject(owner)
    const res = await fetchSelf(
      new Request(`http://local/api/gallery/${pid}/comments`, { method: "GET" })
    )
    expect(res.status).toBe(401)
  })

  it("公开作品：别人能读", async () => {
    const owner = await makeUser()
    const other = await makeUser()
    const pid = await makeProject(owner)
    const res = await fetchSelf(authRequest(other, `/api/gallery/${pid}/comments`))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ count: 0, comments: [] })
  })

  it("私有作品：别人看不见 → 404（不是 403，不能泄露存在性）", async () => {
    const owner = await makeUser()
    const other = await makeUser()
    const pid = await makeProject(owner, { visibility: "private" })
    const res = await fetchSelf(authRequest(other, `/api/gallery/${pid}/comments`))
    expect(res.status).toBe(404)
  })

  it("私有作品：作者本人能读", async () => {
    const owner = await makeUser()
    const pid = await makeProject(owner, { visibility: "private" })
    const res = await fetchSelf(authRequest(owner, `/api/gallery/${pid}/comments`))
    expect(res.status).toBe(200)
  })
})

describe("造物集评论：发表与回复", () => {
  it("发根评论 + 回复，建树正确", async () => {
    const owner = await makeUser()
    const other = await makeUser()
    const pid = await makeProject(owner)

    const r1 = await fetchSelf(
      authRequest(other, `/api/gallery/${pid}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: "第一条评论" }),
        headers: jsonHeaders,
      })
    )
    expect(r1.status).toBe(201)
    const rootId = (await r1.json<{ comment: { id: string } }>()).comment.id

    // 绕过 10 秒冷却（把上一条的时间往前推）
    await env.DB.prepare("UPDATE gallery_comments SET created_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 60_000).toISOString(), rootId)
      .run()

    const r2 = await fetchSelf(
      authRequest(owner, `/api/gallery/${pid}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: "回复一下", parentId: rootId }),
        headers: jsonHeaders,
      })
    )
    expect(r2.status).toBe(201)

    const list = await fetchSelf(authRequest(owner, `/api/gallery/${pid}/comments`))
    const data = await list.json<{
      count: number
      comments: { id: string; replies: { body: string }[] }[]
    }>()
    expect(data.count).toBe(2)
    expect(data.comments).toHaveLength(1) // 只有一个根
    expect(data.comments[0].replies[0].body).toBe("回复一下")
  })

  it("空评论 → 400；超 1000 字 → 400", async () => {
    const owner = await makeUser()
    const pid = await makeProject(owner)

    const empty = await fetchSelf(
      authRequest(owner, `/api/gallery/${pid}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: "   " }),
        headers: jsonHeaders,
      })
    )
    expect(empty.status).toBe(400)

    const tooLong = await fetchSelf(
      authRequest(owner, `/api/gallery/${pid}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: "x".repeat(1001) }),
        headers: jsonHeaders,
      })
    )
    expect(tooLong.status).toBe(400)
  })

  it("10 秒内连发两条 → 429", async () => {
    const owner = await makeUser()
    const pid = await makeProject(owner)
    const first = await fetchSelf(
      authRequest(owner, `/api/gallery/${pid}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: "1" }),
        headers: jsonHeaders,
      })
    )
    expect(first.status).toBe(201)
    const second = await fetchSelf(
      authRequest(owner, `/api/gallery/${pid}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: "2" }),
        headers: jsonHeaders,
      })
    )
    expect(second.status).toBe(429)
  })

  it("防刷跨作品统一计算（在另一个作品下也发不出去）", async () => {
    const owner = await makeUser()
    const a = await makeProject(owner, { name: "作品A" })
    const b = await makeProject(owner, { name: "作品B" })

    const r1 = await fetchSelf(
      authRequest(owner, `/api/gallery/${a}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: "在 A 发" }),
        headers: jsonHeaders,
      })
    )
    expect(r1.status).toBe(201)

    const r2 = await fetchSelf(
      authRequest(owner, `/api/gallery/${b}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: "马上去 B 发" }),
        headers: jsonHeaders,
      })
    )
    expect(r2.status).toBe(429)
  })
})

describe("造物集评论：按作品隔离（不能串场）", () => {
  it("A 作品的评论不出现在 B 作品里", async () => {
    const owner = await makeUser()
    const a = await makeProject(owner, { name: "隔离A" })
    const b = await makeProject(owner, { name: "隔离B" })

    const r = await fetchSelf(
      authRequest(owner, `/api/gallery/${a}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: "只属于 A" }),
        headers: jsonHeaders,
      })
    )
    expect(r.status).toBe(201)

    const listB = await fetchSelf(authRequest(owner, `/api/gallery/${b}/comments`))
    expect((await listB.json<{ count: number }>()).count).toBe(0)

    const listA = await fetchSelf(authRequest(owner, `/api/gallery/${a}/comments`))
    expect((await listA.json<{ count: number }>()).count).toBe(1)
  })

  it("拿 A 作品的评论当 B 作品的 parentId → 400（不能把回复挂到别的作品下）", async () => {
    const owner = await makeUser()
    const a = await makeProject(owner, { name: "父A" })
    const b = await makeProject(owner, { name: "父B" })

    const root = await fetchSelf(
      authRequest(owner, `/api/gallery/${a}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: "A 的根评论" }),
        headers: jsonHeaders,
      })
    )
    const rootId = (await root.json<{ comment: { id: string } }>()).comment.id

    // 清冷却，确保这次失败的原因是"父评论不属于本作品"而不是限流
    await env.DB.prepare("UPDATE gallery_comments SET created_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 60_000).toISOString(), rootId)
      .run()

    const cross = await fetchSelf(
      authRequest(owner, `/api/gallery/${b}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: "试图跨作品回复", parentId: rootId }),
        headers: jsonHeaders,
      })
    )
    expect(cross.status).toBe(400)
    expect(await cross.json()).toMatchObject({ code: "INVALID_PARENT" })
  })
})

describe("造物集评论：删除权限", () => {
  it("评论作者能删自己的", async () => {
    const owner = await makeUser()
    const commenter = await makeUser()
    const pid = await makeProject(owner)
    const r = await fetchSelf(
      authRequest(commenter, `/api/gallery/${pid}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: "我发的" }),
        headers: jsonHeaders,
      })
    )
    const cid = (await r.json<{ comment: { id: string } }>()).comment.id
    const del = await fetchSelf(
      authRequest(commenter, `/api/gallery/${pid}/comments/${cid}`, { method: "DELETE" })
    )
    expect(del.status).toBe(200)
    const row = await env.DB.prepare("SELECT deleted_at FROM gallery_comments WHERE id = ?")
      .bind(cid)
      .first<{ deleted_at: string | null }>()
    expect(row?.deleted_at).not.toBeNull()
  })

  it("作品作者能删别人在自己作品下的评论", async () => {
    const owner = await makeUser()
    const commenter = await makeUser()
    const pid = await makeProject(owner)
    const r = await fetchSelf(
      authRequest(commenter, `/api/gallery/${pid}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: "垃圾评论" }),
        headers: jsonHeaders,
      })
    )
    const cid = (await r.json<{ comment: { id: string } }>()).comment.id
    const del = await fetchSelf(
      authRequest(owner, `/api/gallery/${pid}/comments/${cid}`, { method: "DELETE" })
    )
    expect(del.status).toBe(200)
  })

  it("无关第三人删不了 → 403", async () => {
    const owner = await makeUser()
    const commenter = await makeUser()
    const stranger = await makeUser()
    const pid = await makeProject(owner)
    const r = await fetchSelf(
      authRequest(commenter, `/api/gallery/${pid}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: "别人删不了" }),
        headers: jsonHeaders,
      })
    )
    const cid = (await r.json<{ comment: { id: string } }>()).comment.id
    const del = await fetchSelf(
      authRequest(stranger, `/api/gallery/${pid}/comments/${cid}`, { method: "DELETE" })
    )
    expect(del.status).toBe(403)
    // 而且真的没被改
    const row = await env.DB.prepare("SELECT deleted_at FROM gallery_comments WHERE id = ?")
      .bind(cid)
      .first<{ deleted_at: string | null }>()
    expect(row?.deleted_at).toBeNull()
  })
})
