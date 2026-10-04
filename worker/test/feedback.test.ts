// 用户反馈（私有工单）端到端测试。
//
// 走真实 Worker 路由（SELF.fetch），因此覆盖 路由 → handler → 鉴权 → D1 全链路。
// 重点验证三件「改坏了不会报错、只会静默越权/失效」的事：
//   1. 别人看不到我的反馈（私有性）；
//   2. 非管理员不能回复 / 改状态；
//   3. 回复后 user_read 归零、标记已读只影响自己的记录。
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { uuid } from "../src/crypto"
import { getPointsBalance } from "../src/points"
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

// ---- 2026-10-01：回复反馈时可顺带赠送积分 ----
//
// 关键约束：**同一张反馈只发一次**（服务端按反馈 id 做幂等键），
// 否则管理员重复点「发送回复」就会重复发分（积分能换真钱，这是资金问题）。
describe("反馈回复附带积分奖励", () => {
  it("带 rewardPoints 回复 → 作者到账，返回体带上发放结果", async () => {
    const u = await makeUser()
    const admin = await makeUser({ role: "admin" })
    const id = await submit(u, { category: "bug", title: "登录页白屏", body: "……" })

    const res = await fetchSelf(
      authRequest(admin, "/api/admin/feedback/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, reply: "已修复，感谢反馈！", rewardPoints: 30 }),
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json<{
      reward: { amount: number; balance: number; duplicated: boolean } | null
    }>()
    expect(body.reward?.amount).toBe(30)
    expect(body.reward?.duplicated).toBe(false)
    expect(await getPointsBalance(env, u.id)).toBe(30)
  })

  it("不传 rewardPoints → 一分不发（老行为不变）", async () => {
    const u = await makeUser()
    const admin = await makeUser({ role: "admin" })
    const id = await submit(u, { category: "other", title: "随便说说", body: "……" })

    const res = await fetchSelf(
      authRequest(admin, "/api/admin/feedback/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, reply: "收到" }),
      })
    )
    expect(res.status).toBe(200)
    expect((await res.json<{ reward: unknown }>()).reward).toBeNull()
    expect(await getPointsBalance(env, u.id)).toBe(0)
  })

  it("⚠️ 同一张反馈重复回复 → 不重复发分", async () => {
    const u = await makeUser()
    const admin = await makeUser({ role: "admin" })
    const id = await submit(u, { category: "bug", title: "重复发分检查", body: "……" })

    const send = () =>
      fetchSelf(
        authRequest(admin, "/api/admin/feedback/reply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, reply: "已处理", rewardPoints: 50 }),
        })
      )

    const first = await send()
    expect((await first.json<{ reward: { duplicated: boolean } }>()).reward.duplicated).toBe(false)
    expect(await getPointsBalance(env, u.id)).toBe(50)

    // 再回一次同一张单子（甚至改大金额）—— 都不该再发
    const second = await send()
    const secondBody = await second.json<{ reward: { duplicated: boolean } }>()
    expect(secondBody.reward.duplicated).toBe(true)
    expect(await getPointsBalance(env, u.id)).toBe(50)
  })

  it("超过单次上限 → 400，且回复不发出去", async () => {
    const u = await makeUser()
    const admin = await makeUser({ role: "admin" })
    const id = await submit(u, { category: "bug", title: "上限检查", body: "……" })

    const res = await fetchSelf(
      authRequest(admin, "/api/admin/feedback/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, reply: "太多了", rewardPoints: 100000 }),
      })
    )
    expect(res.status).toBe(400)
    expect(await getPointsBalance(env, u.id)).toBe(0)
  })
})

// ---- 2026-10-01：回复反馈时可顺带赠送积分 ----
//
// 关键约束：**同一张反馈只发一次**（服务端按反馈 id 做幂等键），
// 否则管理员重复点「发送回复」就会重复发分（积分能换真钱，这是资金问题）。
describe("反馈回复附带积分奖励", () => {
  it("带 rewardPoints 回复 → 作者到账，返回体带上发放结果", async () => {
    const u = await makeUser()
    const admin = await makeUser({ role: "admin" })
    const id = await submit(u, { category: "bug", title: "登录页白屏", body: "……" })

    const res = await fetchSelf(
      authRequest(admin, "/api/admin/feedback/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, reply: "已修复，感谢反馈！", rewardPoints: 30 }),
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json<{
      reward: { amount: number; balance: number; duplicated: boolean } | null
    }>()
    expect(body.reward?.amount).toBe(30)
    expect(body.reward?.duplicated).toBe(false)
    expect(await getPointsBalance(env, u.id)).toBe(30)
  })

  it("不传 rewardPoints → 一分不发（老行为不变）", async () => {
    const u = await makeUser()
    const admin = await makeUser({ role: "admin" })
    const id = await submit(u, { category: "other", title: "随便说说", body: "……" })

    const res = await fetchSelf(
      authRequest(admin, "/api/admin/feedback/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, reply: "收到" }),
      })
    )
    expect(res.status).toBe(200)
    expect((await res.json<{ reward: unknown }>()).reward).toBeNull()
    expect(await getPointsBalance(env, u.id)).toBe(0)
  })

  it("⚠️ 同一张反馈重复回复 → 不重复发分", async () => {
    const u = await makeUser()
    const admin = await makeUser({ role: "admin" })
    const id = await submit(u, { category: "bug", title: "重复发分检查", body: "……" })

    const send = () =>
      fetchSelf(
        authRequest(admin, "/api/admin/feedback/reply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, reply: "已处理", rewardPoints: 50 }),
        })
      )

    const first = await send()
    expect((await first.json<{ reward: { duplicated: boolean } }>()).reward.duplicated).toBe(false)
    expect(await getPointsBalance(env, u.id)).toBe(50)

    // 再回一次同一张单子（甚至改大金额）—— 都不该再发
    const second = await send()
    const secondBody = await second.json<{ reward: { duplicated: boolean } }>()
    expect(secondBody.reward.duplicated).toBe(true)
    expect(await getPointsBalance(env, u.id)).toBe(50)
  })

  it("超过单次上限 → 400，且回复不发出去", async () => {
    const u = await makeUser()
    const admin = await makeUser({ role: "admin" })
    const id = await submit(u, { category: "bug", title: "上限检查", body: "……" })

    const res = await fetchSelf(
      authRequest(admin, "/api/admin/feedback/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, reply: "太多了", rewardPoints: 100000 }),
      })
    )
    expect(res.status).toBe(400)
    expect(await getPointsBalance(env, u.id)).toBe(0)
  })
})

// ---- 2026-10-05：反馈回复要能看出「是谁回复的」 ----
//
// 站长要求：之后会多管理员，用户得知道具体是哪个管理员回复的反馈。
// 每个对话消息都带 sender（头像 / 昵称 / 用户名 / 角色徽章 / 称号），
// 形状与社区广场的 author 一致，前端可直接复用 UserAvatar / RoleBadge / CustomTitleBadge。
describe("反馈消息带发送者资料", () => {
  /**
   * 造一个「能处理反馈」的管理员。
   *
   * ⚠️ 2026-10-05：管理端权限改成了白名单（并发开发中的「管理员权限组」），
   * `role: "admin"` 不再自动拥有全部权限 —— 必须显式给 `admin_scope` 含 "feedback"
   * 才能过 requireAdminScope。这里照新契约给上，避免测试依赖旧行为。
   */
  async function makeAdmin(nickname?: string) {
    const a = await makeUser({ role: "admin" })
    await env.DB.prepare("UPDATE users SET admin_scope = ?, nickname = ? WHERE id = ?")
      .bind(JSON.stringify(["feedback"]), nickname ?? null, a.id)
      .run()
    return a
  }

  async function grantTitle(userId: string, name: string): Promise<void> {
    const titleId = uuid()
    const now = new Date().toISOString()
    await env.DB.prepare(
      "INSERT INTO custom_titles (id, name, color_from, color_to, created_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(titleId, name, "#10b981", "#059669", now)
      .run()
    await env.DB.prepare(
      "INSERT INTO user_titles (user_id, title_id, is_display, granted_at) VALUES (?, ?, 1, ?)"
    )
      .bind(userId, titleId, now)
      .run()
  }

  it("管理员回复 → 用户侧消息带上该管理员的头像/昵称/用户名/角色/称号", async () => {
    const u = await makeUser()
    const admin = await makeAdmin("客服小助手")
    await grantTitle(admin.id, "金牌客服")

    const id = await submit(u, { category: "bug", title: "有回复人", body: "……" })
    await fetchSelf(
      authRequest(admin, "/api/admin/feedback/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, reply: "我来看看" }),
      })
    )

    const res = await fetchSelf(authRequest(u, "/api/feedback"))
    const data = await res.json<{
      feedback: {
        id: string
        messages: {
          isAdmin: boolean
          body: string
          sender: {
            username: string
            nickname: string | null
            isAdmin: boolean
            isRoot: boolean
            hasAvatar: boolean
            customTitle: { name: string; colorFrom: string; colorTo: string } | null
          }
        }[]
      }[]
    }>()
    const item = data.feedback.find((f) => f.id === id)
    const msg = item?.messages.find((m) => m.body === "我来看看")
    expect(msg).toBeTruthy()
    expect(msg?.isAdmin).toBe(true)
    expect(msg?.sender.username).toBe(admin.username)
    expect(msg?.sender.nickname).toBe("客服小助手")
    expect(msg?.sender.isAdmin).toBe(true)
    expect(msg?.sender.isRoot).toBe(false)
    expect(msg?.sender.customTitle?.name).toBe("金牌客服")
  })

  it("用户自己的追加回复 → sender 是本人，且 isAdmin=false、无称号", async () => {
    const u = await makeUser()
    const id = await submit(u, { category: "bug", title: "我补充", body: "首帖" })
    await fetchSelf(
      authRequest(u, "/api/feedback/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, reply: "再补充一句" }),
      })
    )

    const res = await fetchSelf(authRequest(u, "/api/feedback"))
    const data = await res.json<{
      feedback: {
        id: string
        messages: { body: string; isAdmin: boolean; sender: { username: string; isAdmin: boolean } }[]
      }[]
    }>()
    const msg = data.feedback.find((f) => f.id === id)?.messages.find((m) => m.body === "再补充一句")
    expect(msg?.sender.username).toBe(u.username)
    expect(msg?.sender.isAdmin).toBe(false)
    expect(msg?.isAdmin).toBe(false)
  })

  it("管理员多条回复分别带各自资料（多管理员场景）", async () => {
    const u = await makeUser()
    const a1 = await makeAdmin("甲管理员")
    const a2 = await makeAdmin("乙管理员")

    const id = await submit(u, { category: "bug", title: "多人回复", body: "……" })
    for (const [admin, text] of [
      [a1, "甲：我来处理"],
      [a2, "乙：跟进一下"],
    ] as const) {
      await fetchSelf(
        authRequest(admin, "/api/admin/feedback/reply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, reply: text }),
        })
      )
    }

    const res = await fetchSelf(authRequest(u, "/api/feedback"))
    const data = await res.json<{
      feedback: { id: string; messages: { body: string; sender: { nickname: string | null } }[] }[]
    }>()
    const msgs = data.feedback.find((f) => f.id === id)?.messages ?? []
    expect(msgs.find((m) => m.body === "甲：我来处理")?.sender.nickname).toBe("甲管理员")
    expect(msgs.find((m) => m.body === "乙：跟进一下")?.sender.nickname).toBe("乙管理员")
  })
})
