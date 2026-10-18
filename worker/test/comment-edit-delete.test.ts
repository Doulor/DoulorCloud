/**
 * 社区评论「编辑 / 删除留痕」（2026-10-17 站长要求）回归。
 *
 * 覆盖的行为契约：
 *   · 只有作者能改自己的评论；管理员也不能替别人改（要处理违规请删除）
 *   · 默认最多改 2 次，第 3 次 403 EDIT_LIMIT_REACHED；内容没变不消耗次数
 *   · 上限由设置 community_comment_edit_limit 控制：0 = 禁止修改，改大 = 放宽
 *   · 删除 = 软删 + 清空正文，列表仍返回该行（deleted=true / body=""），
 *     回复树不断链；已删除的评论不能再编辑 / 点赞 / 回复
 *   · 删除权限：作者本人或管理员；重复删除幂等
 */
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, setSetting, type TestUser } from "./helpers"

async function createPost(u: TestUser): Promise<string> {
  const res = await fetchSelf(
    authRequest(u, "/api/community/posts", {
      method: "POST",
      body: JSON.stringify({ body: "评论测试帖" }),
      headers: { "Content-Type": "application/json" },
    })
  )
  expect(res.status).toBe(201)
  return (await res.json<{ post: { id: string } }>()).post.id
}

/** 发一条评论；可选 parentId。顺手把 created_at 拨回 1 分钟前，绕过 10 秒防刷屏。 */
async function createComment(
  u: TestUser,
  postId: string,
  body: string,
  parentId?: string
): Promise<string> {
  const res = await fetchSelf(
    authRequest(u, `/api/community/posts/${postId}/comments`, {
      method: "POST",
      body: JSON.stringify({ body, ...(parentId ? { parentId } : {}) }),
      headers: { "Content-Type": "application/json" },
    })
  )
  expect(res.status).toBe(201)
  const id = (await res.json<{ comment: { id: string } }>()).comment.id
  await env.DB.prepare("UPDATE post_comments SET created_at = ? WHERE id = ?")
    .bind(new Date(Date.now() - 60_000).toISOString(), id)
    .run()
  return id
}

function editComment(u: TestUser, id: string, body: string): Promise<Response> {
  return fetchSelf(
    authRequest(u, `/api/community/comments/${id}`, {
      method: "PUT",
      body: JSON.stringify({ body }),
      headers: { "Content-Type": "application/json" },
    })
  )
}

function deleteComment(u: TestUser, id: string): Promise<Response> {
  return fetchSelf(authRequest(u, `/api/community/comments/${id}`, { method: "DELETE" }))
}

async function listComments(u: TestUser | null, postId: string) {
  const path = `/api/community/posts/${postId}/comments`
  const req = u ? authRequest(u, path) : new Request(`https://cloud.doulor.cn${path}`)
  const res = await fetchSelf(req)
  expect(res.status).toBe(200)
  return res.json<{
    comments: {
      id: string
      body: string
      deleted?: boolean
      editCount?: number
      updatedAt?: string | null
      replies: { id: string; body: string; deleted?: boolean }[]
    }[]
  }>()
}

describe("PUT /api/community/comments/:id", () => {
  it("作者可以编辑自己的评论，列表下发修改次数与时间", async () => {
    const u = await makeUser()
    const pid = await createPost(u)
    const cid = await createComment(u, pid, "原始内容")

    const res = await editComment(u, cid, "改过的内容")
    expect(res.status).toBe(200)
    const data = await res.json<{ ok: boolean; editCount: number; updatedAt?: string }>()
    expect(data).toMatchObject({ ok: true, editCount: 1 })
    expect(data.updatedAt).toBeTruthy()

    const db = await env.DB.prepare(
      "SELECT body, edit_count, updated_at FROM post_comments WHERE id = ?"
    )
      .bind(cid)
      .first<{ body: string; edit_count: number; updated_at: string | null }>()
    expect(db?.body).toBe("改过的内容")
    expect(db?.edit_count).toBe(1)
    expect(db?.updated_at).toBeTruthy()

    const listed = (await listComments(u, pid)).comments.find((c) => c.id === cid)
    expect(listed?.body).toBe("改过的内容")
    expect(listed?.editCount).toBe(1)
    expect(listed?.updatedAt).toBeTruthy()
  })

  it("默认最多改 2 次，第 3 次 403 EDIT_LIMIT_REACHED", async () => {
    const u = await makeUser()
    const pid = await createPost(u)
    const cid = await createComment(u, pid, "v0")

    expect((await editComment(u, cid, "v1")).status).toBe(200)
    expect((await editComment(u, cid, "v2")).status).toBe(200)
    const third = await editComment(u, cid, "v3")
    expect(third.status).toBe(403)
    expect(await third.json()).toMatchObject({ code: "EDIT_LIMIT_REACHED" })

    const db = await env.DB.prepare("SELECT body, edit_count FROM post_comments WHERE id = ?")
      .bind(cid)
      .first<{ body: string; edit_count: number }>()
    expect(db?.body).toBe("v2")
    expect(db?.edit_count).toBe(2)
  })

  it("内容没变直接返回 unchanged，不消耗次数", async () => {
    const u = await makeUser()
    const pid = await createPost(u)
    const cid = await createComment(u, pid, "一样的内容")

    const res = await editComment(u, cid, "  一样的内容  ")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, unchanged: true, editCount: 0 })

    const db = await env.DB.prepare("SELECT edit_count FROM post_comments WHERE id = ?")
      .bind(cid)
      .first<{ edit_count: number }>()
    expect(db?.edit_count).toBe(0)
  })

  it("不能编辑别人的评论（管理员也不行）", async () => {
    const author = await makeUser()
    const other = await makeUser()
    const admin = await makeUser({ role: "admin" })
    const pid = await createPost(author)
    const cid = await createComment(author, pid, "我的评论")

    expect((await editComment(other, cid, "篡改")).status).toBe(403)
    expect((await editComment(admin, cid, "管理员篡改")).status).toBe(403)
    const db = await env.DB.prepare("SELECT body FROM post_comments WHERE id = ?")
      .bind(cid)
      .first<{ body: string }>()
    expect(db?.body).toBe("我的评论")
  })

  it("管理员可控制次数：0 = 禁止修改，改大后按新上限放行", async () => {
    const u = await makeUser()
    const pid = await createPost(u)
    const cid = await createComment(u, pid, "v0")

    await setSetting("community_comment_edit_limit", "0")
    const disabled = await editComment(u, cid, "v1")
    expect(disabled.status).toBe(403)
    expect(await disabled.json()).toMatchObject({ code: "EDIT_DISABLED" })

    await setSetting("community_comment_edit_limit", "5")
    for (let i = 1; i <= 5; i++) {
      expect((await editComment(u, cid, `v${i}`)).status).toBe(200)
    }
    expect((await editComment(u, cid, "v6")).status).toBe(403)
  })

  it("评论被删除后不能再编辑", async () => {
    const u = await makeUser()
    const pid = await createPost(u)
    const cid = await createComment(u, pid, "会被删")
    expect((await deleteComment(u, cid)).status).toBe(200)

    const res = await editComment(u, cid, "改已删除的")
    expect(res.status).toBe(404)
  })
})

describe("DELETE /api/community/comments/:id", () => {
  it("删除后正文清空，列表保留占位，回复仍挂在下面", async () => {
    const author = await makeUser()
    const replier = await makeUser()
    const pid = await createPost(author)
    const root = await createComment(author, pid, "根评论内容")
    const reply = await createComment(replier, pid, "回复内容", root)

    const del = await deleteComment(author, root)
    expect(del.status).toBe(200)

    // 正文必须真的从库里消失（不是只在前端隐藏）
    const db = await env.DB.prepare(
      "SELECT body, deleted_at FROM post_comments WHERE id = ?"
    )
      .bind(root)
      .first<{ body: string; deleted_at: string | null }>()
    expect(db?.body).toBe("")
    expect(db?.deleted_at).toBeTruthy()

    const listed = await listComments(author, pid)
    const node = listed.comments.find((c) => c.id === root)
    expect(node?.deleted).toBe(true)
    expect(node?.body).toBe("")
    // 回复没有被提成根节点（树没断）
    expect(node?.replies.map((r) => r.id)).toEqual([reply])
    expect(listed.comments.some((c) => c.id === reply)).toBe(false)
  })

  it("普通用户不能删别人的评论；管理员可以；重复删除幂等", async () => {
    const author = await makeUser()
    const other = await makeUser()
    const admin = await makeUser({ role: "admin" })
    const pid = await createPost(author)
    const cid = await createComment(author, pid, "别删我")

    expect((await deleteComment(other, cid)).status).toBe(403)

    const del = await deleteComment(admin, cid)
    expect(del.status).toBe(200)
    expect(await del.json()).toMatchObject({ ok: true })

    const again = await deleteComment(admin, cid)
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ ok: true, alreadyDeleted: true })
  })

  it("已删除的评论不能再点赞、不能再被回复", async () => {
    const author = await makeUser()
    const other = await makeUser()
    const pid = await createPost(author)
    const cid = await createComment(author, pid, "要删的评论")

    expect((await deleteComment(author, cid)).status).toBe(200)

    const like = await fetchSelf(
      authRequest(other, `/api/community/comments/${cid}/like`, { method: "POST" })
    )
    expect(like.status).toBe(404)

    const reply = await fetchSelf(
      authRequest(other, `/api/community/posts/${pid}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: "回复已删除评论", parentId: cid }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(reply.status).toBe(400)
    expect(await reply.json()).toMatchObject({ code: "INVALID_PARENT" })
  })

  it("删除不存在的评论返回 404", async () => {
    const u = await makeUser()
    expect((await deleteComment(u, "no-such-comment")).status).toBe(404)
  })
})

describe("管理端保存评论修改次数上限", () => {
  const save = (admin: TestUser, value: unknown) =>
    fetchSelf(
      authRequest(admin, "/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ community_comment_edit_limit: value }),
      })
    )

  it("0 ~ 10 的整数可以保存，并立即影响编辑接口", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const u = await makeUser()
    const pid = await createPost(u)
    const cid = await createComment(u, pid, "v0")

    expect((await save(admin, 5)).status).toBe(200)
    const row = await env.DB.prepare(
      "SELECT value FROM app_settings WHERE key = 'community_comment_edit_limit'"
    ).first<{ value: string }>()
    expect(row?.value).toBe("5")

    for (let i = 1; i <= 5; i++) {
      expect((await editComment(u, cid, `v${i}`)).status).toBe(200)
    }
    expect((await editComment(u, cid, "v6")).status).toBe(403)
  })

  it("越界 / 非整数直接 400，不入库", async () => {
    const admin = await makeUser({ role: "superadmin" })
    for (const bad of [-1, 11, 2.5, "abc"]) {
      const res = await save(admin, bad)
      expect(res.status).toBe(400)
    }
    const row = await env.DB.prepare(
      "SELECT value FROM app_settings WHERE key = 'community_comment_edit_limit'"
    ).first<{ value: string }>()
    expect(row).toBeNull()
  })
})
