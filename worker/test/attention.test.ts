// 角标汇总接口（GET /api/attention）—— 侧边栏与管理面板共用的计数源。
//
// 覆盖三件容易写错的事：
//   1. 用户侧三项（社区新帖 / 聊天室新消息 / 反馈新回复）的口径都是
//      「我看过之后新增的」，进对应页面即清零；没看过则回落最近 24 小时。
//   2. 普通用户的 `admin` 必须是 null —— 不能因为「反正前端不渲染」就把
//      管理端计数漏给普通用户。
//   3. `admin.total` 必须等于各项之和（前端侧边栏「管理」角标直接用 total，
//      加漏一项就会出现「点进去各栏目角标加起来对不上总数」）。
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, setSetting, type TestUser } from "./helpers"
import { uuid } from "../src/crypto"

interface AttentionPayload {
  community: number
  chat: number
  feedback: number
  admin: {
    total: number
    feedback: number
    donations: number
    pointProducts: number
    pointOrders: number
    eventClaims: number
  } | null
}

/**
 * 角标数是**全表计数**，同文件用例之间会互相污染（实测过：期望 1 拿到 4）。
 * 每个用例前清空本文件涉及的表，让断言与执行顺序无关。
 */
beforeEach(async () => {
  for (const t of [
    "posts",
    "chat_messages",
    "feedback",
    "donations",
    "point_products",
    "point_orders",
    "event_claims",
    "events",
  ]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run()
  }
  // ⚠️ 2026-10-01：`chat_enabled` 默认 "0"（09-30 的应急开关），
  // 聊天未读相关用例需要它打开，否则普通用户拿 403 CHAT_DISABLED。
  await setSetting("chat_enabled", "1")
})

async function attention(user: TestUser): Promise<AttentionPayload> {
  const res = await fetchSelf(authRequest(user, "/api/attention"))
  expect(res.status).toBe(200)
  return await res.json<AttentionPayload>()
}

/** 直接塞库：本文件测的是计数口径，不走各业务的写接口（省掉限流/权限噪音） */
async function seedPost(userId: string, minutesAgo = 0) {
  await env.DB.prepare(
    "INSERT INTO posts (id, user_id, channel, body, created_at) VALUES (?, ?, 'general', ?, ?)"
  )
    .bind(uuid(), userId, "hi", new Date(Date.now() - minutesAgo * 60000).toISOString())
    .run()
}

async function seedChat(userId: string, minutesAgo = 0) {
  await env.DB.prepare(
    "INSERT INTO chat_messages (id, user_id, body, created_at) VALUES (?, ?, ?, ?)"
  )
    .bind(uuid(), userId, "hi", new Date(Date.now() - minutesAgo * 60000).toISOString())
    .run()
}

async function seedFeedback(userId: string, opts: { replied?: boolean } = {}) {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO feedback (id, user_id, category, title, body, status, admin_reply, user_read, created_at, updated_at)
     VALUES (?, ?, 'bug', 't', 'b', 'pending', ?, 0, ?, ?)`
  )
    .bind(uuid(), userId, opts.replied ? "已回复" : null, now, now)
    .run()
}

async function seedDonation(userId: string) {
  await env.DB.prepare(
    `INSERT INTO donations (id, user_id, type, payload, notify_email, status, created_at)
     VALUES (?, ?, 'ai', '{}', 'a@b.c', 'pending', ?)`
  )
    .bind(uuid(), userId, new Date().toISOString())
    .run()
}

async function seedProduct(reviewStatus: "pending" | "approved") {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO point_products (id, name, description, price, delivery, enabled, sort, review_status, created_at, updated_at)
     VALUES (?, 'p', '', 10, 'manual', 1, 0, ?, ?, ?)`
  )
    .bind(uuid(), reviewStatus, now, now)
    .run()
}

async function seedOrder(userId: string, status: "pending" | "delivered" = "pending") {
  await env.DB.prepare(
    `INSERT INTO point_orders (id, user_id, username, product_name, price, delivery, status, created_at)
     VALUES (?, ?, 'u', 'p', 10, 'manual', ?, ?)`
  )
    .bind(uuid(), userId, status, new Date().toISOString())
    .run()
}

async function seedManualClaim(userId: string) {
  const now = new Date().toISOString()
  const eventId = uuid()
  await env.DB.prepare(
    `INSERT INTO events (id, title, body, status, reward_type, condition_type, created_at, updated_at)
     VALUES (?, 'e', 'b', 'active', 'points', 'always', ?, ?)`
  )
    .bind(eventId, now, now)
    .run()
  await env.DB.prepare(
    `INSERT INTO event_claims (id, event_id, user_id, reward_type, reward_status, claimed_at)
     VALUES (?, ?, ?, 'points', 'manual', ?)`
  )
    .bind(uuid(), eventId, userId, now)
    .run()
}

describe("角标汇总 /api/attention", () => {
  it("未登录返回 401", async () => {
    const res = await fetchSelf(new Request("https://cloud.doulor.cn/api/attention"))
    expect(res.status).toBe(401)
  })

  it("用户侧三项分别计数，且都不算自己产生的", async () => {
    const me = await makeUser()
    const other = await makeUser()
    await seedPost(other.id)
    await seedChat(other.id)
    await seedFeedback(me.id, { replied: true })

    // 自己发的帖子 / 消息不计入
    await seedPost(me.id)
    await seedChat(me.id)

    const r = await attention(me)
    expect(r.community).toBe(1)
    expect(r.chat).toBe(1)
    expect(r.feedback).toBe(1)
  })

  it("反馈只有「管理员回复过且我没读」才算，回复过且已读则不计", async () => {
    const me = await makeUser()
    await seedFeedback(me.id) // 没回复
    await seedFeedback(me.id, { replied: true })
    expect((await attention(me)).feedback).toBe(1)

    // 进过反馈页 = 已读
    await env.DB.prepare("UPDATE feedback SET user_read = 1 WHERE user_id = ?")
      .bind(me.id)
      .run()
    expect((await attention(me)).feedback).toBe(0)
  })

  it("聊天室：进过聊天室后归零，之后别人再发才重新计数", async () => {
    const me = await makeUser()
    const other = await makeUser()
    await seedChat(other.id, 5)
    expect((await attention(me)).chat).toBe(1)

    const seen = await fetchSelf(
      authRequest(me, "/api/chat/seen", { method: "POST" })
    )
    expect(seen.status).toBe(200)
    expect((await attention(me)).chat).toBe(0)

    await seedChat(other.id, 0)
    expect((await attention(me)).chat).toBe(1)
  })

  it("聊天室：没进过时按最近 24 小时算，两天前的消息不计", async () => {
    const me = await makeUser()
    const other = await makeUser()
    await seedChat(other.id, 5)
    await seedChat(other.id, 60 * 48)
    expect((await attention(me)).chat).toBe(1)
  })

  it("聊天室未读接口与汇总口径一致", async () => {
    const me = await makeUser()
    const other = await makeUser()
    await seedChat(other.id)
    const res = await fetchSelf(authRequest(me, "/api/chat/unread"))
    expect(res.status).toBe(200)
    expect((await res.json<{ count: number }>()).count).toBe(
      (await attention(me)).chat
    )
  })

  it("普通用户的 admin 是 null —— 管理端计数不泄露给普通用户", async () => {
    const me = await makeUser()
    const other = await makeUser()
    await seedFeedback(other.id, { replied: true })
    await seedDonation(other.id)
    await seedProduct("pending")
    await seedOrder(other.id)
    await seedManualClaim(other.id)

    expect((await attention(me)).admin).toBeNull()
  })

  it("管理员拿到各栏目待处理数，且 total 等于各项之和", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()

    // 待处理反馈 2 条（另 1 条已 resolved，不算）
    await seedFeedback(user.id)
    await seedFeedback(user.id)
    await seedFeedback(user.id)
    await env.DB.prepare(
      "UPDATE feedback SET status = 'resolved' WHERE rowid = (SELECT MIN(rowid) FROM feedback)"
    ).run()
    // 待审核捐献 1 条（已通过的不算）
    await seedDonation(user.id)
    await env.DB.prepare("UPDATE donations SET status = 'approved'").run()
    await seedDonation(user.id)
    // 商品：1 待审核 + 1 已通过
    await seedProduct("pending")
    await seedProduct("approved")
    // 订单：1 待处理 + 1 已发放
    await seedOrder(user.id)
    await seedOrder(user.id, "delivered")
    // 活动待人工发放 1 条
    await seedManualClaim(user.id)

    const { admin: a } = await attention(admin)
    expect(a).not.toBeNull()
    expect(a!.feedback).toBe(2)
    expect(a!.donations).toBe(1)
    expect(a!.pointProducts).toBe(1)
    expect(a!.pointOrders).toBe(1)
    expect(a!.eventClaims).toBe(1)
    expect(a!.total).toBe(
      a!.feedback + a!.donations + a!.pointProducts + a!.pointOrders + a!.eventClaims
    )
  })

  it("root 也能拿到管理角标（isPrivileged 覆盖 root）", async () => {
    const root = await makeUser({ role: "root" })
    await seedDonation(root.id)
    const { admin } = await attention(root)
    expect(admin?.donations).toBe(1)
    expect(admin?.total).toBe(1)
  })

  it("管理员自己也有用户侧角标（管理身份不吞掉 community/chat/feedback）", async () => {
    const admin = await makeUser({ role: "admin" })
    const other = await makeUser()
    await seedPost(other.id)
    await seedChat(other.id)
    await seedFeedback(admin.id, { replied: true })

    const r = await attention(admin)
    expect(r.community).toBe(1)
    expect(r.chat).toBe(1)
    expect(r.feedback).toBe(1)
  })
})
