// 消息箱 + 活动系统（0068）。
//
// 覆盖：
//   1. 消息分类过滤、未读数按分类拆分、按分类整批已读
//   2. 邮箱未验证提示是「虚拟合成」——出现、且不计入未读数
//   3. 点赞通知：从无到有发一条，取消再赞不重复
//   4. 活动领取：条件不满足 403 / 未开始 400 / 已结束 400 / 幂等 409
//   5. 自动发放：has_profile + invite_quota 走通，奖励真的落库
//   6. newapi_quota：未绑定中转站时落到「待人工发放」，管理员可手动标记
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, type TestUser } from "./helpers"

const BASE = "https://api.doulor.cn"
let restoreFetch: (() => void) | null = null

/** 打桩出站 fetch：接管 NewAPI 的加额度请求，记录调用 */
let quotaCalls: { userId: number; value: number; mode: string }[] = []
function stubNewApi() {
  const original = globalThis.fetch
  quotaCalls = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(BASE)) return original(input as RequestInfo, init)
    if (url.includes("/api/user/manage")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        id: number
        value: number
        mode: string
      }
      quotaCalls.push({ userId: body.id, value: body.value, mode: body.mode })
      return new Response(JSON.stringify({ success: true, message: "", data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    return new Response(JSON.stringify({ success: true, message: "", data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as unknown as typeof fetch
  restoreFetch = () => {
    globalThis.fetch = original
  }
}

beforeEach(() => stubNewApi())
afterEach(() => {
  restoreFetch?.()
  restoreFetch = null
})

async function makeAdmin(): Promise<TestUser> {
  return makeUser({ role: "admin" })
}

/** 直接建一条活动（绕过管理接口，聚焦领取逻辑） */
async function seedEvent(opts: {
  rewardType?: string
  rewardParams?: Record<string, unknown>
  conditionType?: string
  conditionParams?: Record<string, unknown>
  status?: string
  startsAt?: string | null
  endsAt?: string | null
}): Promise<string> {
  const id = `ev_${Math.random().toString(36).slice(2, 10)}`
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO events
       (id, title, body, status, starts_at, ends_at, reward_label, reward_type, reward_params,
        condition_type, condition_params, created_by, created_at, updated_at)
     VALUES (?, '测试活动', '正文', ?, ?, ?, '奖励', ?, ?, ?, ?, NULL, ?, ?)`
  )
    .bind(
      id,
      opts.status ?? "active",
      opts.startsAt ?? null,
      opts.endsAt ?? null,
      opts.rewardType ?? "none",
      opts.rewardParams ? JSON.stringify(opts.rewardParams) : null,
      opts.conditionType ?? "always",
      opts.conditionParams ? JSON.stringify(opts.conditionParams) : null,
      now,
      now
    )
    .run()
  return id
}

/** 建一条通知（直接落库，用于验证分类过滤/未读数） */
async function seedNotification(
  userId: string,
  opts: { category: string; type?: string; read?: number; title?: string } = { category: "social" }
): Promise<string> {
  const id = `n_${Math.random().toString(36).slice(2, 10)}`
  await env.DB.prepare(
    `INSERT INTO notifications (id, user_id, category, type, title, read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      userId,
      opts.category,
      opts.type ?? "post_comment",
      opts.title ?? null,
      opts.read ?? 0,
      new Date().toISOString()
    )
    .run()
  return id
}

describe("消息箱：分类与未读数", () => {
  it("按分类过滤只返回该类消息", async () => {
    const u = await makeUser()
    await seedNotification(u.id, { category: "social" })
    await seedNotification(u.id, { category: "site", type: "announcement", title: "公告一" })
    await seedNotification(u.id, { category: "system", type: "donation", title: "捐献通过" })

    const res = await fetchSelf(authRequest(u, "/api/notifications?category=site"))
    expect(res.status).toBe(200)
    const list = (await res.json<{ notifications: { category: string; title: string }[] }>())
      .notifications
    expect(list).toHaveLength(1)
    expect(list[0].category).toBe("site")
    expect(list[0].title).toBe("公告一")
  })

  it("非法 category 当作「不过滤」，不报错", async () => {
    // 显式造未验证账号 —— makeUser 现在默认已验证（2026-10-02）
    const u = await makeUser({ emailVerified: false })
    await seedNotification(u.id, { category: "social" })
    await seedNotification(u.id, { category: "site", type: "announcement" })
    const res = await fetchSelf(authRequest(u, "/api/notifications?category=bogus"))
    expect(res.status).toBe(200)
    // 不过滤 = 两条种子消息 + 一条「邮箱未验证」合成消息
    expect((await res.json<{ notifications: unknown[] }>()).notifications.length).toBe(3)
  })

  it("未读数按分类拆分，count 是总数", async () => {
    const u = await makeUser()
    await seedNotification(u.id, { category: "social" })
    await seedNotification(u.id, { category: "social" })
    await seedNotification(u.id, { category: "site", type: "announcement" })
    await seedNotification(u.id, { category: "social", read: 1 })

    const res = await fetchSelf(authRequest(u, "/api/notifications/unread-count"))
    const body = await res.json<{
      count: number
      byCategory: Record<string, number>
    }>()
    expect(body.count).toBe(3)
    expect(body.byCategory.social).toBe(2)
    expect(body.byCategory.site).toBe(1)
    expect(body.byCategory.event).toBe(0)
  })

  it("按分类整批已读（活动 tab 用）", async () => {
    const u = await makeUser()
    await seedNotification(u.id, { category: "event", type: "event" })
    await seedNotification(u.id, { category: "event", type: "event" })
    await seedNotification(u.id, { category: "social" })

    const res = await fetchSelf(
      authRequest(u, "/api/notifications/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: "event" }),
      })
    )
    expect(res.status).toBe(200)

    const after = await fetchSelf(authRequest(u, "/api/notifications/unread-count"))
    const body = await after.json<{ count: number; byCategory: Record<string, number> }>()
    expect(body.byCategory.event).toBe(0)
    expect(body.byCategory.social).toBe(1)
    expect(body.count).toBe(1)
  })

  it("邮箱未验证：合成一条系统消息，且不计入未读数", async () => {
    const u = await makeUser({ emailVerified: false })
    const res = await fetchSelf(authRequest(u, "/api/notifications?category=system"))
    const list = (await res.json<{ notifications: { id: string; type: string }[] }>())
      .notifications
    const synth = list.find((n) => n.id === "sys:email_unverified")
    expect(synth).toBeDefined()
    expect(synth?.type).toBe("email_unverified")

    const cnt = await fetchSelf(authRequest(u, "/api/notifications/unread-count"))
    expect((await cnt.json<{ count: number }>()).count).toBe(0)
  })

  it("邮箱已验证后，合成消息消失", async () => {
    const u = await makeUser({ emailVerified: false })
    await env.DB.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").bind(u.id).run()
    const res = await fetchSelf(authRequest(u, "/api/notifications?category=system"))
    const list = (await res.json<{ notifications: { id: string }[] }>()).notifications
    expect(list.find((n) => n.id === "sys:email_unverified")).toBeUndefined()
  })
})

describe("点赞通知", () => {
  async function makePost(user: TestUser): Promise<string> {
    const res = await fetchSelf(
      authRequest(user, "/api/community/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "帖子内容" }),
      })
    )
    return (await res.json<{ post: { id: string } }>()).post.id
  }

  it("点赞别人的帖子 → 作者收到一条社交消息", async () => {
    const owner = await makeUser()
    const liker = await makeUser()
    const pid = await makePost(owner)

    const res = await fetchSelf(
      authRequest(liker, `/api/community/posts/${pid}/like`, { method: "POST" })
    )
    expect(res.status).toBe(200)

    const row = await env.DB.prepare(
      "SELECT category, type, actor_id FROM notifications WHERE user_id = ?"
    )
      .bind(owner.id)
      .first<{ category: string; type: string; actor_id: string }>()
    expect(row?.category).toBe("social")
    expect(row?.type).toBe("post_like")
    expect(row?.actor_id).toBe(liker.id)
  })

  it("取消赞再重新赞 → 不产生第二条（幂等去重）", async () => {
    const owner = await makeUser()
    const liker = await makeUser()
    const pid = await makePost(owner)

    // 赞 → 取消 → 再赞
    await fetchSelf(authRequest(liker, `/api/community/posts/${pid}/like`, { method: "POST" }))
    await fetchSelf(authRequest(liker, `/api/community/posts/${pid}/like`, { method: "POST" }))
    await fetchSelf(authRequest(liker, `/api/community/posts/${pid}/like`, { method: "POST" }))

    const cnt = await env.DB.prepare(
      "SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND type = 'post_like'"
    )
      .bind(owner.id)
      .first<{ c: number }>()
    expect(cnt?.c).toBe(1)
  })

  it("给自己的帖子点赞不发通知", async () => {
    const owner = await makeUser()
    const pid = await makePost(owner)
    await fetchSelf(authRequest(owner, `/api/community/posts/${pid}/like`, { method: "POST" }))
    const cnt = await env.DB.prepare(
      "SELECT COUNT(*) c FROM notifications WHERE user_id = ?"
    )
      .bind(owner.id)
      .first<{ c: number }>()
    expect(cnt?.c).toBe(0)
  })
})

describe("活动：领取与自动发放", () => {
  it("无门槛 + 邀请码额度：领取后额度真的增加", async () => {
    const u = await makeUser()
    const before =
      (await env.DB.prepare("SELECT COALESCE(invite_quota_bonus,0) AS q FROM users WHERE id=?")
        .bind(u.id)
        .first<{ q: number }>())?.q ?? 0

    const id = await seedEvent({
      rewardType: "invite_quota",
      rewardParams: { count: 3 },
      conditionType: "always",
    })

    const res = await fetchSelf(authRequest(u, `/api/events/${id}/claim`, { method: "POST" }))
    expect(res.status).toBe(200)
    const body = await res.json<{ status: string }>()
    expect(body.status).toBe("granted")

    const after =
      (await env.DB.prepare("SELECT COALESCE(invite_quota_bonus,0) AS q FROM users WHERE id=?")
        .bind(u.id)
        .first<{ q: number }>())?.q ?? 0
    expect(after).toBe(before + 3)
  })

  it("重复领取 → 409，且奖励不重复发放", async () => {
    const u = await makeUser()
    const id = await seedEvent({
      rewardType: "invite_quota",
      rewardParams: { count: 5 },
    })

    const first = await fetchSelf(authRequest(u, `/api/events/${id}/claim`, { method: "POST" }))
    expect(first.status).toBe(200)

    const second = await fetchSelf(authRequest(u, `/api/events/${id}/claim`, { method: "POST" }))
    expect(second.status).toBe(409)

    const q =
      (await env.DB.prepare("SELECT COALESCE(invite_quota_bonus,0) AS q FROM users WHERE id=?")
        .bind(u.id)
        .first<{ q: number }>())?.q ?? 0
    expect(q).toBe(5)
  })

  it("条件不满足（has_profile）→ 403", async () => {
    const u = await makeUser()
    const id = await seedEvent({
      conditionType: "has_profile",
      rewardType: "invite_quota",
      rewardParams: { count: 1 },
    })
    const res = await fetchSelf(authRequest(u, `/api/events/${id}/claim`, { method: "POST" }))
    expect(res.status).toBe(403)
    expect((await res.json<{ code: string }>()).code).toBe("CONDITION_FAILED")
  })

  it("已开通名片（已发布 + 填了昵称）后 has_profile 通过", async () => {
    const u = await makeUser()
    const now = new Date().toISOString()
    await env.DB.prepare(
      "INSERT INTO profiles (user_id, slug, published, display_name, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)"
    )
      .bind(u.id, u.username, "测试名片", now, now)
      .run()

    const id = await seedEvent({
      conditionType: "has_profile",
      rewardType: "invite_quota",
      rewardParams: { count: 1 },
    })
    const res = await fetchSelf(authRequest(u, `/api/events/${id}/claim`, { method: "POST" }))
    expect(res.status).toBe(200)
  })

  // 2026-09-28：gaozx1 就是靠一条空名片行领走了 500 元余额。
  // 同日起「开通名片」默认就是 published=1（用户不用再手动点「启用」），
  // 所以判据从「已发布」升级为「已发布 **且** 填了昵称」—— 空骨架行依然过不去。
  it("只点「开通名片」但没填昵称 → has_profile 不通过（403）", async () => {
    const u = await makeUser()
    const enabled = await fetchSelf(
      authRequest(u, "/api/profile/enable", { method: "POST" })
    )
    expect(enabled.status).toBe(201)

    // 先确认「开通即已发布」这个前提成立，否则这条测试测的不是它想测的东西
    const got = (await (await fetchSelf(authRequest(u, "/api/profile"))).json()) as {
      profile: { published: boolean }
    }
    expect(got.profile.published).toBe(true)

    const id = await seedEvent({
      conditionType: "has_profile",
      rewardType: "invite_quota",
      rewardParams: { count: 1 },
    })
    const res = await fetchSelf(authRequest(u, `/api/events/${id}/claim`, { method: "POST" }))
    expect(res.status).toBe(403)
    expect((await res.json<{ code: string }>()).code).toBe("CONDITION_FAILED")
  })

  it("填了昵称后 → has_profile 通过", async () => {
    const u = await makeUser()
    await fetchSelf(authRequest(u, "/api/profile/enable", { method: "POST" }))
    await fetchSelf(
      authRequest(u, "/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "有名字了" }),
      })
    )

    const id = await seedEvent({
      conditionType: "has_profile",
      rewardType: "invite_quota",
      rewardParams: { count: 1 },
    })
    const res = await fetchSelf(authRequest(u, `/api/events/${id}/claim`, { method: "POST" }))
    expect(res.status).toBe(200)
  })

  it("未开始 / 已结束 / 已下线 → 400", async () => {
    const u = await makeUser()
    const future = new Date(Date.now() + 86_400_000).toISOString()
    const past = new Date(Date.now() - 86_400_000).toISOString()

    const notStarted = await seedEvent({ startsAt: future })
    const ended = await seedEvent({ endsAt: past })
    const offline = await seedEvent({ status: "draft" })

    for (const [id, code] of [
      [notStarted, "NOT_STARTED"],
      [ended, "ENDED"],
      [offline, "EVENT_OFFLINE"],
    ] as const) {
      const res = await fetchSelf(authRequest(u, `/api/events/${id}/claim`, { method: "POST" }))
      expect(res.status).toBe(400)
      expect((await res.json<{ code: string }>()).code).toBe(code)
    }
  })

  // 2026-09-28 变更：未开通中转站不再「领了落到 manual」，而是**直接拒绝领取**。
  // 原因：一次性领取机会会被白白消耗，管理员一疏忽就等于白领（用户来找、还得人工核）。
  // 改成「没开通就不让领」后，用户开通中转站再回来领即可，不浪费机会。
  it("newapi_quota：未开通中转站 → 403 拒绝领取，且不占领取名额", async () => {
    const u = await makeUser()
    const id = await seedEvent({
      rewardType: "newapi_quota",
      rewardParams: { amount: 100 },
    })
    const res = await fetchSelf(authRequest(u, `/api/events/${id}/claim`, { method: "POST" }))
    expect(res.status).toBe(403)
    expect((await res.json<{ code: string }>()).code).toBe("REWARD_PRECONDITION_FAILED")
    expect(quotaCalls).toHaveLength(0)

    // 关键：被拒绝的领取**不留** event_claims 记录 —— 用户开通中转站后还能再领
    const claims = await env.DB.prepare(
      "SELECT COUNT(*) c FROM event_claims WHERE event_id = ? AND user_id = ?"
    )
      .bind(id, u.id)
      .first<{ c: number }>()
    expect(claims?.c).toBe(0)

    // 活动列表应带出「为什么不能领」，供前端把按钮置灰
    const list = (
      await (
        await fetchSelf(authRequest(u, "/api/events"))
      ).json<{ events: { id: string; claimBlockedReason: string | null }[] }>()
    ).events
    const mine = list.find((e) => e.id === id)
    expect(mine?.claimBlockedReason).toBeTruthy()
  })

  it("newapi_quota：已绑定中转站 → 调 NewAPI 加额度（金额按元换算成原始额度）", async () => {
    const u = await makeUser()
    await env.DB.prepare(
      `INSERT INTO newapi_accounts (user_id, newapi_user_id, username, email, enc_token, created_at)
       VALUES (?, 4242, ?, ?, 'NO_TOKEN', ?)`
    )
      .bind(u.id, u.username, `${u.username}@doulor.cn`, new Date().toISOString())
      .run()

    const id = await seedEvent({
      rewardType: "newapi_quota",
      rewardParams: { amount: 50 },
    })
    const res = await fetchSelf(authRequest(u, `/api/events/${id}/claim`, { method: "POST" }))
    expect(res.status).toBe(200)
    expect((await res.json<{ status: string }>()).status).toBe("granted")
    // 50「元」必须换算成 50 × newapi_quota_per_unit(500000) 的原始额度，
    // 否则只加 50 额度 ≈ ¥0.0001，用户端看不出来（2026-09-28 tianya 踩的坑）
    expect(quotaCalls).toEqual([{ userId: 4242, value: 50 * 500_000, mode: "add" }])
  })

  it("用户端活动列表附 myClaim", async () => {
    const u = await makeUser()
    const id = await seedEvent({ rewardType: "invite_quota", rewardParams: { count: 1 } })
    await fetchSelf(authRequest(u, `/api/events/${id}/claim`, { method: "POST" }))

    const res = await fetchSelf(authRequest(u, "/api/events"))
    const list = (
      await res.json<{ events: { id: string; myClaim: { rewardStatus: string } | null }[] }>()
    ).events
    const mine = list.find((e) => e.id === id)
    expect(mine?.myClaim?.rewardStatus).toBe("granted")
  })
})

describe("活动：管理端", () => {
  it("创建为 active 会广播到所有活跃用户，且重复保存不翻倍", async () => {
    const admin = await makeAdmin()
    const target = await makeUser()

    const create = await fetchSelf(
      authRequest(admin, "/api/admin/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "限时活动",
          body: "正文",
          status: "active",
          rewardType: "invite_quota",
          rewardParams: { count: 2 },
          conditionType: "always",
        }),
      })
    )
    expect(create.status).toBe(201)
    const evId = (await create.json<{ event: { id: string } }>()).event.id

    const cnt = await env.DB.prepare(
      "SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND category = 'event'"
    )
      .bind(target.id)
      .first<{ c: number }>()
    expect(cnt?.c).toBe(1)

    // 再保存一次（active → active）不应重复广播
    await fetchSelf(
      authRequest(admin, `/api/admin/events/${evId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "限时活动（改名）" }),
      })
    )
    const cnt2 = await env.DB.prepare(
      "SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND category = 'event'"
    )
      .bind(target.id)
      .first<{ c: number }>()
    expect(cnt2?.c).toBe(1)
  })

  it("草稿不广播；改为 active 时才广播一次", async () => {
    const admin = await makeAdmin()
    const target = await makeUser()

    const create = await fetchSelf(
      authRequest(admin, "/api/admin/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "草稿活动", body: "正文", status: "draft" }),
      })
    )
    const evId = (await create.json<{ event: { id: string } }>()).event.id

    const zero = await env.DB.prepare(
      "SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND category = 'event'"
    )
      .bind(target.id)
      .first<{ c: number }>()
    expect(zero?.c).toBe(0)

    await fetchSelf(
      authRequest(admin, `/api/admin/events/${evId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      })
    )
    const one = await env.DB.prepare(
      "SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND category = 'event'"
    )
      .bind(target.id)
      .first<{ c: number }>()
    expect(one?.c).toBe(1)
  })

  it("结束时间早于开始时间 → 400", async () => {
    const admin = await makeAdmin()
    const res = await fetchSelf(
      authRequest(admin, "/api/admin/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "时间错乱",
          body: "正文",
          startsAt: new Date(Date.now() + 86_400_000).toISOString(),
          endsAt: new Date(Date.now() - 86_400_000).toISOString(),
        }),
      })
    )
    expect(res.status).toBe(400)
  })

  it("领取名单 + 手动标记已发放", async () => {
    const admin = await makeAdmin()
    const u = await makeUser()
    const id = await seedEvent({ rewardType: "none" })

    await fetchSelf(authRequest(u, `/api/events/${id}/claim`, { method: "POST" }))

    const listRes = await fetchSelf(authRequest(admin, `/api/admin/events/${id}/claims`))
    const claims = (await listRes.json<{ claims: { id: string; rewardStatus: string }[] }>()).claims
    expect(claims).toHaveLength(1)
    expect(claims[0].rewardStatus).toBe("manual")

    const grantRes = await fetchSelf(
      authRequest(admin, `/api/admin/events/${id}/claims/${claims[0].id}/grant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ detail: "已手动发放" }),
      })
    )
    expect(grantRes.status).toBe(200)

    const after = await fetchSelf(authRequest(admin, `/api/admin/events/${id}/claims`))
    const updated = (await after.json<{ claims: { rewardStatus: string }[] }>()).claims
    expect(updated[0].rewardStatus).toBe("granted")
  })

  it("非管理员不能管理活动", async () => {
    const u = await makeUser()
    const res = await fetchSelf(
      authRequest(u, "/api/admin/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "越权", body: "正文" }),
      })
    )
    expect(res.status).toBe(403)
  })
})

describe("公告广播到消息中心", () => {
  it("发布公告 → 活跃用户收到 site 分类消息", async () => {
    const admin = await makeAdmin()
    const target = await makeUser()

    const res = await fetchSelf(
      authRequest(admin, "/api/admin/announcements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "新公告", body: "公告正文" }),
      })
    )
    expect(res.status).toBe(201)

    const row = await env.DB.prepare(
      "SELECT category, type, title, body FROM notifications WHERE user_id = ? AND category = 'site'"
    )
      .bind(target.id)
      .first<{ category: string; type: string; title: string; body: string }>()
    expect(row?.type).toBe("announcement")
    expect(row?.title).toBe("新公告")
    expect(row?.body).toBe("公告正文")
  })
})
