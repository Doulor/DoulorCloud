// 定时发布（公告 + 活动）与活动限量总份数（迁移 0072）。
//
// 覆盖：
//   1. 到点的定时公告 → 自动转 published + 广播；未到点 / 草稿不动
//   2. 到点的定时活动 → 自动转 active + 广播
//   3. 幂等：引擎重复跑不会重复广播（publishAnnouncementNow / activateScheduledEvent
//      各自用 published_at + dedupKey 双重拦）
//   4. 管理接口接受 status / publishAt，用户端看不到草稿与未到点的定时内容
//   5. 限量：领满后第 N+1 人拿到 409 CLAIM_LIMIT_REACHED
//
// 为什么要直接调 processScheduledPublishes：它是 cron 的入口函数，
// 拿真实 D1 + 真实迁移跑一遍，等价于线上每分钟那条 cron 干的事。
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf } from "./helpers"
import { processScheduledPublishes } from "../src/scheduled-publish"

/** 相对现在偏移若干毫秒的 ISO 串（库里统一 ISO UTC，字符串比较即时间比较） */
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()

async function seedAnnouncement(opts: {
  status: string
  publishAt?: string | null
  publishedAt?: string | null
  notifyEmail?: number
}): Promise<string> {
  const id = `ann_${Math.random().toString(36).slice(2, 10)}`
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO announcements
       (id, title, body, category, pinned, popup_mode, status, publish_at, published_at, notify_email, created_at)
     VALUES (?, '测试公告', '正文', 'general', 0, 'none', ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      opts.status,
      opts.publishAt ?? null,
      opts.publishedAt ?? null,
      opts.notifyEmail ?? 0,
      now
    )
    .run()
  return id
}

async function seedEvent(opts: {
  status?: string
  publishAt?: string | null
  publishedAt?: string | null
  maxClaims?: number | null
}): Promise<string> {
  const id = `ev_${Math.random().toString(36).slice(2, 10)}`
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO events
       (id, title, body, status, starts_at, ends_at, publish_at, published_at, max_claims,
        reward_label, reward_type, reward_params, condition_type, condition_params,
        created_by, created_at, updated_at)
     VALUES (?, '测试活动', '正文', ?, NULL, NULL, ?, ?, ?, '奖励', 'none', NULL, 'always', NULL, NULL, ?, ?)`
  )
    .bind(
      id,
      opts.status ?? "active",
      opts.publishAt ?? null,
      opts.publishedAt ?? null,
      opts.maxClaims ?? null,
      now,
      now
    )
    .run()
  return id
}

async function annRow(id: string) {
  return env.DB.prepare("SELECT status, publish_at, published_at FROM announcements WHERE id = ?")
    .bind(id)
    .first<{ status: string; publish_at: string | null; published_at: string | null }>()
}

async function evtRow(id: string) {
  return env.DB.prepare("SELECT status, publish_at, published_at FROM events WHERE id = ?")
    .bind(id)
    .first<{ status: string; publish_at: string | null; published_at: string | null }>()
}

async function notifCount(dedupKey: string): Promise<number> {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM notifications WHERE dedup_key = ?"
  )
    .bind(dedupKey)
    .first<{ c: number }>()
  return r?.c ?? 0
}

describe("定时发布：公告", () => {
  it("到点的定时公告 → 自动发布 + 广播，用户之前看不到", async () => {
    const u = await makeUser()
    const id = await seedAnnouncement({ status: "scheduled", publishAt: iso(-60_000) })

    // 到点前（此刻还没跑引擎）用户端看不到
    const before = await fetchSelf(authRequest(u, "/api/announcements"))
    expect(before.status).toBe(200)
    const beforeList = (await before.json<{ announcements: { id: string }[] }>()).announcements
    expect(beforeList.some((a) => a.id === id)).toBe(false)

    const res = await processScheduledPublishes(env)
    expect(res.announcements).toBe(1)
    expect(res.errors).toBe(0)

    const row = await annRow(id)
    expect(row?.status).toBe("published")
    expect(row?.published_at).not.toBeNull()

    // 广播落到消息中心（dedupKey ann:<id>）
    expect(await notifCount(`ann:${id}`)).toBeGreaterThan(0)

    // 用户端现在可见
    const after = await fetchSelf(authRequest(u, "/api/announcements"))
    const afterList = (await after.json<{ announcements: { id: string }[] }>()).announcements
    expect(afterList.some((a) => a.id === id)).toBe(true)
  })

  it("未到点的定时公告不动", async () => {
    const id = await seedAnnouncement({ status: "scheduled", publishAt: iso(3600_000) })
    const res = await processScheduledPublishes(env)
    expect(res.announcements).toBe(0)
    const row = await annRow(id)
    expect(row?.status).toBe("scheduled")
    expect(row?.published_at).toBeNull()
    expect(await notifCount(`ann:${id}`)).toBe(0)
  })

  it("草稿永不发布", async () => {
    const id = await seedAnnouncement({ status: "draft" })
    await processScheduledPublishes(env)
    const row = await annRow(id)
    expect(row?.status).toBe("draft")
    expect(await notifCount(`ann:${id}`)).toBe(0)
  })

  it("幂等：引擎跑两次不会重复广播", async () => {
    const id = await seedAnnouncement({ status: "scheduled", publishAt: iso(-60_000) })
    await processScheduledPublishes(env)
    const first = await notifCount(`ann:${id}`)
    await processScheduledPublishes(env)
    const second = await notifCount(`ann:${id}`)
    expect(first).toBeGreaterThan(0)
    expect(second).toBe(first)
  })
})

describe("定时发布：活动", () => {
  it("到点的定时活动 → 自动上线 + 广播", async () => {
    const u = await makeUser()
    const id = await seedEvent({ status: "scheduled", publishAt: iso(-60_000) })

    const res = await processScheduledPublishes(env)
    expect(res.events).toBe(1)
    expect(res.errors).toBe(0)

    const row = await evtRow(id)
    expect(row?.status).toBe("active")
    expect(row?.published_at).not.toBeNull()
    expect(await notifCount(`evt:${id}`)).toBeGreaterThan(0)

    // 用户端活动列表可见（active 才返回）
    const list = await fetchSelf(authRequest(u, "/api/events"))
    expect(list.status).toBe(200)
    const events = (await list.json<{ events: { id: string }[] }>()).events
    expect(events.some((e) => e.id === id)).toBe(true)
  })

  it("未到点的定时活动不动", async () => {
    const id = await seedEvent({ status: "scheduled", publishAt: iso(3600_000) })
    const res = await processScheduledPublishes(env)
    expect(res.events).toBe(0)
    expect((await evtRow(id))?.status).toBe("scheduled")
    expect(await notifCount(`evt:${id}`)).toBe(0)
  })
})

describe("管理接口：状态与发布时间入库", () => {
  it("创建草稿公告 → 用户端不可见，管理端可见", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()

    const create = await fetchSelf(
      authRequest(admin, "/api/admin/announcements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "草稿标题", body: "草稿正文", status: "draft" }),
      })
    )
    expect(create.status).toBe(201)
    const created = (await create.json<{ announcement: { id: string; status: string } }>())
      .announcement
    expect(created.status).toBe("draft")

    const mine = await fetchSelf(authRequest(u, "/api/announcements"))
    const mineList = (await mine.json<{ announcements: { id: string }[] }>()).announcements
    expect(mineList.some((a) => a.id === created.id)).toBe(false)

    const all = await fetchSelf(authRequest(admin, "/api/admin/announcements"))
    const allList = (await all.json<{ announcements: { id: string }[] }>()).announcements
    expect(allList.some((a) => a.id === created.id)).toBe(true)
  })

  it("创建定时活动 → publishAt 入库且状态为 scheduled", async () => {
    const admin = await makeUser({ role: "admin" })
    const when = iso(3600_000)
    const create = await fetchSelf(
      authRequest(admin, "/api/admin/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "定时活动",
          body: "正文",
          status: "scheduled",
          publishAt: when,
          maxClaims: 5,
        }),
      })
    )
    expect(create.status).toBe(201)
    const ev = (
      await create.json<{ event: { id: string; status: string; publishAt: string; maxClaims: number } }>()
    ).event
    expect(ev.status).toBe("scheduled")
    expect(ev.maxClaims).toBe(5)
    // 入库的时间与提交的一致（ISO 字符串往返）
    const row = await env.DB.prepare("SELECT publish_at FROM events WHERE id = ?")
      .bind(ev.id)
      .first<{ publish_at: string }>()
    expect(row?.publish_at).toBe(when)
  })
})

describe("活动限量总份数（先到先得）", () => {
  it("领满 max_claims 后，下一个人拿到 CLAIM_LIMIT_REACHED", async () => {
    const id = await seedEvent({ status: "active", maxClaims: 2 })
    const a = await makeUser()
    const b = await makeUser()
    const c = await makeUser()

    const claim = (u: typeof a) =>
      fetchSelf(authRequest(u, `/api/events/${id}/claim`, { method: "POST" }))

    expect((await claim(a)).status).toBe(200)
    expect((await claim(b)).status).toBe(200)

    const third = await claim(c)
    expect(third.status).toBe(409)
    const body = await third.json<{ code?: string; error?: string }>()
    expect(body.code).toBe("CLAIM_LIMIT_REACHED")

    // 库里恰好两份
    const cnt = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM event_claims WHERE event_id = ?"
    )
      .bind(id)
      .first<{ c: number }>()
    expect(cnt?.c).toBe(2)
  })

  it("不限量（max_claims = NULL）时所有人可领", async () => {
    const id = await seedEvent({ status: "active", maxClaims: null })
    const users = await Promise.all([makeUser(), makeUser(), makeUser()])
    for (const u of users) {
      const res = await fetchSelf(authRequest(u, `/api/events/${id}/claim`, { method: "POST" }))
      expect(res.status).toBe(200)
    }
  })

  it("用户端 /events 下发 claimCount，前端据此算「剩余份数」", async () => {
    const id = await seedEvent({ status: "active", maxClaims: 3 })
    const a = await makeUser()
    const b = await makeUser()
    const viewer = await makeUser()

    await fetchSelf(authRequest(a, `/api/events/${id}/claim`, { method: "POST" }))
    await fetchSelf(authRequest(b, `/api/events/${id}/claim`, { method: "POST" }))

    const res = await fetchSelf(authRequest(viewer, "/api/events"))
    expect(res.status).toBe(200)
    const ev = (
      await res.json<{ events: { id: string; maxClaims: number; claimCount: number }[] }>()
    ).events.find((e) => e.id === id)
    expect(ev).toBeTruthy()
    expect(ev?.maxClaims).toBe(3)
    expect(ev?.claimCount).toBe(2) // 剩余 = 3 - 2 = 1
  })
})

describe("管理端用户列表：UID 列", () => {
  it("返回按注册顺序的 uid（新注册用户必有值）", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()

    // makeUser 直接 INSERT，不会走 migration 0070 的回填逻辑 —— 这里手动补一个，
    // 模拟线上「uid 已回填」的常态，避免用例依赖建表顺序。
    await env.DB.prepare("UPDATE users SET uid = 9001 WHERE id = ?").bind(u.id).run()

    const res = await fetchSelf(authRequest(admin, "/api/admin/users"))
    expect(res.status).toBe(200)
    const list = (await res.json<{ users: { id: string; uid: number | null }[] }>()).users
    const row = list.find((x) => x.id === u.id)
    expect(row?.uid).toBe(9001)
  })
})
