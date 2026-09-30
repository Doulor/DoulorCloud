// 用户反馈（私有工单）端到端测试。
//
// 走真实 Worker 路由（SELF.fetch），因此覆盖 路由 → handler → 鉴权 → D1 全链路。
// 重点验证三件「改坏了不会报错、只会静默越权/失效」的事：
//   1. 别人看不到我的反馈（私有性）；
//   2. 非管理员不能回复 / 改状态；
//   3. 回复后 user_read 归零、标记已读只影响自己的记录。
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf } from "./helpers"

/** 提交一条反馈，返回 id */
async function submit(
  user: { cookie: string },
  body: Record<string, unknown>
): Promise<string> {
  const res = await fetchSelf(
    authRequest(user, "/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  )
  expect(res.status).toBe(201)
  const data = await res.json<{ feedback: { id: string } }>()
  return data.feedback.id
}

describe("用户反馈", () => {
  it("提交后能在自己的列表里看到，且带上分类/状态标签", async () => {
    const u = await makeUser()
    const id = await submit(u, {
      category: "bug",
      title: "域名解析不生效",
      body: "昨天加的 A 记录，到现在还没生效。",
    })

    const res = await fetchSelf(authRequest(u, "/api/feedback"))
    expect(res.status).toBe(200)
    const data = await res.json<{
      feedback: { id: string; status: string; title: string }[]
      categories: { key: string; label: string }[]
      statusLabels: Record<string, string>
      unreadReplies: number
    }>()
    const mine = data.feedback.find((f) => f.id === id)
    expect(mine).toBeTruthy()
    expect(mine?.status).toBe("pending")
    expect(mine?.title).toBe("域名解析不生效")
    // 标签由服务端下发（前端不硬编码），四个分类都要在
    expect(data.categories.map((c) => c.key).sort()).toEqual([
      "bug",
      "donation",
      "feature",
      "other",
    ])
    expect(data.statusLabels.pending).toBe("待处理")
    expect(data.unreadReplies).toBe(0)
  })

  it("别人的反馈不出现在我的列表里（私有性）", async () => {
    const a = await makeUser()
    const b = await makeUser()
    await submit(a, { category: "other", title: "A 的反馈", body: "只有 A 能看" })

    const res = await fetchSelf(authRequest(b, "/api/feedback"))
    const data = await res.json<{ feedback: unknown[] }>()
    expect(data.feedback).toHaveLength(0)
  })

  it("标题或正文为空 → 400", async () => {
    const u = await makeUser()
    const res = await fetchSelf(
      authRequest(u, "/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: "bug", title: "  ", body: "有内容" }),
      })
    )
    expect(res.status).toBe(400)
  })

  it("未知分类回落为 other（不报错、不写脏值）", async () => {
    const u = await makeUser()
    const id = await submit(u, {
      category: "不存在的分类",
      title: "t",
      body: "b",
    })
    const row = await env.DB.prepare("SELECT category FROM feedback WHERE id = ?")
      .bind(id)
      .first<{ category: string }>()
    expect(row?.category).toBe("other")
  })

  it("提交带图片：本人 key 入库并转 url，别人/非法 key 被丢弃", async () => {
    const u = await makeUser()
    const other = await makeUser()
    const mineKey = `feedback/${u.id}/abc123.webp`
    const otherKey = `feedback/${other.id}/def456.png`
    const badKey = "not-a-valid-key"

    const id = await submit(u, {
      category: "bug",
      title: "带图反馈",
      body: "正文",
      images: [mineKey, otherKey, badKey],
    })

    // 只有属于本人的 key 被存，且读回时转成访问 URL
    const row = await env.DB.prepare("SELECT images FROM feedback WHERE id = ?")
      .bind(id)
      .first<{ images: string | null }>()
    expect(JSON.parse(row?.images ?? "[]")).toEqual([mineKey])

    const res = await fetchSelf(authRequest(u, "/api/feedback"))
    const data = await res.json<{ feedback: { id: string; images: string[] }[] }>()
    const item = data.feedback.find((f) => f.id === id)
    expect(item?.images).toEqual([`/api/feedback/image/${u.id}/abc123.webp`])
  })

  it("图片读取：非本人且非管理员 → 403", async () => {
    const a = await makeUser()
    const b = await makeUser()
    const res = await fetchSelf(authRequest(b, `/api/feedback/image/${a.id}/abc123.webp`))
    expect(res.status).toBe(403)
  })

  it("未登录不能提交，也不能读列表", async () => {
    const post = await fetchSelf(
      new Request("https://cloud.doulor.cn/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: "bug", title: "t", body: "b" }),
      })
    )
    expect(post.status).toBe(401)

    const get = await fetchSelf(new Request("https://cloud.doulor.cn/api/feedback"))
    expect(get.status).toBe(401)
  })

  it("非管理员看不到管理端列表", async () => {
    const u = await makeUser()
    await submit(u, { category: "bug", title: "t", body: "b" })
    const res = await fetchSelf(authRequest(u, "/api/admin/feedback"))
    expect(res.status).toBe(403)
  })

  it("管理员回复后：状态变已处理、用户侧出现未读回复与站内通知", async () => {
    const u = await makeUser()
    const admin = await makeUser({ role: "admin" })
    const id = await submit(u, { category: "feature", title: "想要深色日历", body: "……" })

    const reply = await fetchSelf(
      authRequest(admin, "/api/admin/feedback/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, reply: "已排期，下个版本加上。" }),
      })
    )
    expect(reply.status).toBe(200)
    const replied = await reply.json<{ feedback: { status: string; adminReply: string } }>()
    // 没显式传 status → 默认推到 resolved（「有回复」≈「处理完了」）
    expect(replied.feedback.status).toBe("resolved")
    expect(replied.feedback.adminReply).toBe("已排期，下个版本加上。")

    // 用户侧：能看到回复、且被标为未读
    const mine = await fetchSelf(authRequest(u, "/api/feedback"))
    const data = await mine.json<{
      feedback: { id: string; adminReply: string | null; replyRead: boolean }[]
      unreadReplies: number
    }>()
    const item = data.feedback.find((f) => f.id === id)
    expect(item?.adminReply).toBe("已排期，下个版本加上。")
    expect(item?.replyRead).toBe(false)
    expect(data.unreadReplies).toBe(1)

    // 站内通知也落了（作者不在反馈页时也能看到）
    const notif = await env.DB.prepare(
      "SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND type = 'feedback_reply'"
    )
      .bind(u.id)
      .first<{ c: number }>()
    expect(notif?.c).toBe(1)
  })

  it("标记已读只清自己的未读，且不动别人的", async () => {
    const a = await makeUser()
    const b = await makeUser()
    const admin = await makeUser({ role: "admin" })
    const idA = await submit(a, { category: "bug", title: "A", body: "a" })
    const idB = await submit(b, { category: "bug", title: "B", body: "b" })

    for (const id of [idA, idB]) {
      await fetchSelf(
        authRequest(admin, "/api/admin/feedback/reply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, reply: "收到" }),
        })
      )
    }

    const read = await fetchSelf(authRequest(a, "/api/feedback/read", { method: "POST" }))
    expect(read.status).toBe(200)
    expect((await read.json<{ updated: number }>()).updated).toBe(1)

    // A 的已读、B 的仍未被读（user_read 是按行的，不是全局标记）
    const rows = await env.DB.prepare(
      "SELECT user_id, user_read FROM feedback WHERE id IN (?, ?)"
    )
      .bind(idA, idB)
      .all<{ user_id: string; user_read: number }>()
    for (const r of rows.results ?? []) {
      expect(r.user_read).toBe(r.user_id === a.id ? 1 : 0)
    }
  })

  it("管理员只改状态（不回复）时，不产生回复正文", async () => {
    const u = await makeUser()
    const admin = await makeUser({ role: "admin" })
    const id = await submit(u, { category: "other", title: "t", body: "b" })

    const res = await fetchSelf(
      authRequest(admin, "/api/admin/feedback/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status: "processing" }),
      })
    )
    expect(res.status).toBe(200)

    const row = await env.DB.prepare(
      "SELECT status, admin_reply FROM feedback WHERE id = ?"
    )
      .bind(id)
      .first<{ status: string; admin_reply: string | null }>()
    expect(row?.status).toBe("processing")
    expect(row?.admin_reply).toBeNull()
  })

  it("非法状态被拒（400），不存在的反馈返回 404", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    const id = await submit(u, { category: "other", title: "t", body: "b" })

    const bad = await fetchSelf(
      authRequest(admin, "/api/admin/feedback/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status: "随便写的" }),
      })
    )
    expect(bad.status).toBe(400)

    const missing = await fetchSelf(
      authRequest(admin, "/api/admin/feedback/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "no-such-id", reply: "hi" }),
      })
    )
    expect(missing.status).toBe(404)
  })

  it("管理端列表按状态过滤，并给出各状态计数", async () => {
    const u = await makeUser()
    const admin = await makeUser({ role: "admin" })
    const id = await submit(u, { category: "bug", title: "待处理", body: "b" })
    await submit(u, { category: "bug", title: "另一条", body: "b" })

    const all = await fetchSelf(authRequest(admin, "/api/admin/feedback"))
    const allData = await all.json<{
      feedback: { id: string; username: string }[]
      counts: Record<string, number>
    }>()
    expect(allData.feedback.length).toBeGreaterThanOrEqual(2)
    expect(allData.counts.pending).toBeGreaterThanOrEqual(2)
    // 管理端要能看到是谁提的
    expect(allData.feedback.find((f) => f.id === id)?.username).toBe(u.username)

    // 改成 processing 后，按 pending 过滤不应再包含它
    await fetchSelf(
      authRequest(admin, "/api/admin/feedback/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status: "processing" }),
      })
    )
    const pending = await fetchSelf(authRequest(admin, "/api/admin/feedback?status=pending"))
    const pendingData = await pending.json<{ feedback: { id: string }[] }>()
    expect(pendingData.feedback.some((f) => f.id === id)).toBe(false)
  })
})

describe("管理端删除反馈", () => {
  it("非管理员不能删除 → 403", async () => {
    const u = await makeUser()
    const id = await submit(u, { category: "bug", title: "t", body: "b" })
    const res = await fetchSelf(
      authRequest(u, "/api/admin/feedback/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      })
    )
    expect(res.status).toBe(403)
    // 被拒后记录仍在
    const row = await env.DB.prepare("SELECT id FROM feedback WHERE id = ?")
      .bind(id)
      .first<{ id: string }>()
    expect(row?.id).toBe(id)
  })

  it("管理员删除后：工单行与其全部对话消息一并清除（级联）", async () => {
    const u = await makeUser()
    const admin = await makeUser({ role: "admin" })
    const id = await submit(u, { category: "bug", title: "待删反馈", body: "b" })

    // 造一条对话消息（管理员回复 → 落 feedback_messages）
    await fetchSelf(
      authRequest(admin, "/api/admin/feedback/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, reply: "收到" }),
      })
    )
    const before = await env.DB.prepare(
      "SELECT COUNT(*) c FROM feedback_messages WHERE feedback_id = ?"
    )
      .bind(id)
      .first<{ c: number }>()
    expect(before?.c).toBe(1)

    const res = await fetchSelf(
      authRequest(admin, "/api/admin/feedback/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      })
    )
    expect(res.status).toBe(200)
    const data = await res.json<{ ok: boolean; deletedImages: number }>()
    expect(data.ok).toBe(true)

    // 工单行与对话消息都不应再存在（避免孤儿数据）
    const fb = await env.DB.prepare("SELECT COUNT(*) c FROM feedback WHERE id = ?")
      .bind(id)
      .first<{ c: number }>()
    expect(fb?.c).toBe(0)
    const msgs = await env.DB.prepare(
      "SELECT COUNT(*) c FROM feedback_messages WHERE feedback_id = ?"
    )
      .bind(id)
      .first<{ c: number }>()
    expect(msgs?.c).toBe(0)
  })

  it("删除不存在的反馈 → 404；缺 id → 400", async () => {
    const admin = await makeUser({ role: "admin" })
    const missing = await fetchSelf(
      authRequest(admin, "/api/admin/feedback/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "no-such-id" }),
      })
    )
    expect(missing.status).toBe(404)

    const noId = await fetchSelf(
      authRequest(admin, "/api/admin/feedback/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    )
    expect(noId.status).toBe(400)
  })

  it("删除只影响目标工单，别的反馈不受牵连", async () => {
    const u = await makeUser()
    const admin = await makeUser({ role: "admin" })
    const keep = await submit(u, { category: "bug", title: "保留", body: "b" })
    const drop = await submit(u, { category: "bug", title: "删除", body: "b" })

    await fetchSelf(
      authRequest(admin, "/api/admin/feedback/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: drop }),
      })
    )

    const kept = await env.DB.prepare("SELECT id FROM feedback WHERE id = ?")
      .bind(keep)
      .first<{ id: string }>()
    expect(kept?.id).toBe(keep)
  })
})
