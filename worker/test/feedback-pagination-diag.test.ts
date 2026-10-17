/**
 * 反馈列表分页 + 单条详情 + 诊断日志上传 的回归测试（2026-10-10）。
 *
 * 锁死四件事：
 *   A. GET /admin/feedback 改分页后：默认第 1 页 ≤20 条、total 正确、
 *      响应是**摘要**（bodyPreview 截断、没有 messages、没有全文 body 字段）；
 *   B. GET /admin/feedback/detail：返回全文 + 全部对话消息 + diagLog；
 *      不存在的 id 404；无 id 400；
 *   C. POST /diag-logs：登录用户可上传，返回 id；时间窗白名单外 400；
 *      未登录 401；
 *   D. POST /feedback 带 diagLogId：本人日志能挂上（detail 里查得到），
 *      别人的日志 id 被忽略（diagLog 为 null）。
 */
import { describe, expect, it, beforeAll } from "vitest"
import { env } from "cloudflare:workers"
import { fetchSelf, makeUser, authRequest } from "./helpers"
import { uuid } from "../src/crypto"

async function seedFeedback(userId: string, i: number, extra?: { diagLogId?: string }) {
  const id = uuid()
  await env.DB.prepare(
    `INSERT INTO feedback (id, user_id, category, title, body, status, user_read, diag_log_id, created_at, updated_at)
     VALUES (?, ?, 'bug', ?, ?, 'pending', 0, ?, ?, ?)`
  )
    .bind(
      id,
      userId,
      `问题 ${i}`,
      `这是第 ${i} 条反馈的正文，`.repeat(30),
      extra?.diagLogId ?? null,
      new Date(Date.now() - i * 1000).toISOString(),
      new Date(Date.now() - i * 1000).toISOString()
    )
    .run()
  return id
}

let admin: { id: string; username: string; cookie: string }
let user: { id: string; username: string; cookie: string }
let other: { id: string; username: string; cookie: string }

beforeAll(async () => {
  admin = await makeUser({ role: "root" })
  user = await makeUser({})
  other = await makeUser({})
})

describe("admin feedback pagination + detail", () => {
  it("A: 列表分页返回摘要，不带全文与消息", async () => {
    for (let i = 0; i < 23; i++) await seedFeedback(user.id, i)

    const res = await fetchSelf(authRequest(admin, "/api/admin/feedback"))
    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      feedback: Array<Record<string, unknown>>
      total: number
      page: number
      pageSize: number
      counts: Record<string, number>
    }
    expect(data.feedback.length).toBe(20)
    expect(data.page).toBe(1)
    expect(data.pageSize).toBe(20)
    expect(data.total).toBe(23)
    expect(data.counts.pending).toBe(23)
    const first = data.feedback[0]
    expect("bodyPreview" in first).toBe(true)
    expect((first.bodyPreview as string).length).toBeLessThanOrEqual(280)
    expect("body" in first).toBe(false)
    expect("messages" in first).toBe(false)
    expect(first.username).toBe(user.username)

    // 第 2 页拿到剩下的 3 条
    const res2 = await fetchSelf(authRequest(admin, "/api/admin/feedback?page=2"))
    const data2 = (await res2.json()) as { feedback: unknown[] }
    expect(data2.feedback.length).toBe(3)
  })

  it("B: detail 返回全文、消息与 diagLog；缺 id 400、坏 id 404", async () => {
    const id = await seedFeedback(user.id, 99)
    await env.DB.prepare(
      `INSERT INTO feedback_messages (id, feedback_id, sender_id, is_admin, body, images, created_at)
       VALUES (?, ?, ?, 1, '管理员回复', NULL, ?)`
    )
      .bind(uuid(), id, admin.id, new Date().toISOString())
      .run()

    const res = await fetchSelf(
      authRequest(admin, `/api/admin/feedback/detail?id=${id}`)
    )
    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      feedback: { id: string; body: string; messages: unknown[] }
      diagLog: null
    }
    expect(data.feedback.id).toBe(id)
    expect(data.feedback.body.length).toBeGreaterThan(280)
    expect(data.feedback.messages.length).toBe(1)
    expect(data.diagLog).toBeNull()

    const noId = await fetchSelf(authRequest(admin, "/api/admin/feedback/detail"))
    expect(noId.status).toBe(400)
    const missing = await fetchSelf(
      authRequest(admin, `/api/admin/feedback/detail?id=${uuid()}`)
    )
    expect(missing.status).toBe(404)
  })
})

describe("diag logs", () => {
  it("C: 上传校验（白名单时间窗 / 未登录 / 正常路径）", async () => {
    const ok = await fetchSelf(
      authRequest(user, "/api/diag-logs", {
        method: "POST",
        body: JSON.stringify({
          windowMinutes: 5,
          entries: [{ t: Date.now(), k: "route", p: "/dashboard" }],
        }),
      })
    )
    expect(ok.status).toBe(201)
    const { id } = (await ok.json()) as { id: string }
    expect(id).toBeTruthy()

    const badWindow = await fetchSelf(
      authRequest(user, "/api/diag-logs", {
        method: "POST",
        body: JSON.stringify({ windowMinutes: 30, entries: [{ t: 1, k: "x" }] }),
      })
    )
    expect(badWindow.status).toBe(400)

    const anon = await fetchSelf(
      new Request("https://cloud.doulor.cn/api/diag-logs", {
        method: "POST",
        body: JSON.stringify({ windowMinutes: 5, entries: [{ t: 1, k: "x" }] }),
        headers: { "Content-Type": "application/json" },
      })
    )
    expect(anon.status).toBe(401)
  })

  it("D: 反馈带 diagLogId —— 本人日志可挂、他人日志被忽略", async () => {
    const mine = await fetchSelf(
      authRequest(user, "/api/diag-logs", {
        method: "POST",
        body: JSON.stringify({ windowMinutes: 15, entries: [{ t: Date.now(), k: "err" }] }),
      })
    )
    const { id: myLogId } = (await mine.json()) as { id: string }

    const created = await fetchSelf(
      authRequest(user, "/api/feedback", {
        method: "POST",
        body: JSON.stringify({
          category: "bug",
          title: "带日志的反馈",
          body: "正文",
          diagLogId: myLogId,
        }),
      })
    )
    expect(created.status).toBe(201)
    const { feedback } = (await created.json()) as { feedback: { id: string } }

    const detail = await fetchSelf(
      authRequest(admin, `/api/admin/feedback/detail?id=${feedback.id}`)
    )
    const data = (await detail.json()) as {
      diagLog: { id: string; windowMinutes: number; entries: unknown[] } | null
    }
    expect(data.diagLog?.id).toBe(myLogId)
    expect(data.diagLog?.windowMinutes).toBe(15)
    expect(data.diagLog?.entries.length).toBe(1)

    // 他人日志 id：被服务端忽略（不报错，diagLogId 落 NULL）
    const theirs = await fetchSelf(
      authRequest(other, "/api/diag-logs", {
        method: "POST",
        body: JSON.stringify({ windowMinutes: 5, entries: [{ t: Date.now(), k: "x" }] }),
      })
    )
    const { id: theirLogId } = (await theirs.json()) as { id: string }
    const created2 = await fetchSelf(
      authRequest(user, "/api/feedback", {
        method: "POST",
        body: JSON.stringify({
          category: "bug",
          title: "拿别人日志的反馈",
          body: "正文",
          diagLogId: theirLogId,
        }),
      })
    )
    expect(created2.status).toBe(201)
    const { feedback: fb2 } = (await created2.json()) as { feedback: { id: string } }
    const detail2 = await fetchSelf(
      authRequest(admin, `/api/admin/feedback/detail?id=${fb2.id}`)
    )
    const data2 = (await detail2.json()) as { diagLog: unknown | null }
    expect(data2.diagLog).toBeNull()
  })
})
