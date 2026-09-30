// GET /api/notifications/latest 的契约 —— 网页侧「零配置通知」的轮询接口。
//
// 它只回「最新一条未读」，标题/正文的口径必须和消息中心页面一致：
// 站点/系统类用库里存的 title/body；社交类（点赞、回复）库里没有标题，得按 type 拼。
// 两边口径不一致的话，通知里看到的内容会和点进去页面上显示的对不上。
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf } from "./helpers"

interface LatestItem {
  id: string
  title: string
  body: string
  link: string
}

async function seed(opts: {
  userId: string
  category: string
  type: string
  title?: string | null
  body?: string | null
  link?: string | null
  read?: number
  actorId?: string | null
}) {
  await env.DB.prepare(
    `INSERT INTO notifications (id, user_id, category, type, title, body, link, actor_id, read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      opts.userId,
      opts.category,
      opts.type,
      opts.title ?? null,
      opts.body ?? null,
      opts.link ?? null,
      opts.actorId ?? null,
      opts.read ?? 0,
      new Date().toISOString()
    )
    .run()
}

const get = (user: { cookie: string }, lang = "zh") =>
  fetchSelf(authRequest(user, `/api/notifications/latest?lang=${lang}`))

describe("GET /api/notifications/latest", () => {
  it("未登录 → 401", async () => {
    const res = await fetchSelf(new Request("https://cloud.doulor.cn/api/notifications/latest"))
    expect(res.status).toBe(401)
  })

  it("没有未读时返回 null", async () => {
    const user = await makeUser()
    const res = await get(user)
    expect(res.status).toBe(200)
    expect(await res.json()).toBeNull()
  })

  it("站点类：直接用库里的 title / body / link", async () => {
    const user = await makeUser()
    await seed({
      userId: user.id,
      category: "site",
      type: "order_delivered",
      title: "订单已发放",
      body: "你的积分订单已处理完成",
      link: "/dashboard/points",
    })
    const item = await (await get(user)).json<LatestItem>()
    expect(item.title).toBe("订单已发放")
    expect(item.body).toBe("你的积分订单已处理完成")
    expect(item.link).toBe("/dashboard/points")
  })

  it("社交类：库里没有标题，按 type + 互动人拼出来（中英各一套）", async () => {
    const user = await makeUser()
    const actor = await makeUser({ username: "alice" })
    await seed({
      userId: user.id,
      category: "social",
      type: "post_like",
      actorId: actor.id,
    })
    const zh = await (await get(user, "zh")).json<LatestItem>()
    expect(zh.title).toContain("赞了你的帖子")

    const en = await (await get(user, "en-US")).json<LatestItem>()
    expect(en.title).toContain("liked your post")
  })

  it("已读的不算、只取最新一条", async () => {
    const user = await makeUser()
    await seed({ userId: user.id, category: "site", type: "x", title: "旧的", read: 1 })
    await seed({ userId: user.id, category: "site", type: "y", title: "最新的" })
    const item = await (await get(user)).json<LatestItem>()
    expect(item.title).toBe("最新的")
  })

  it("看不到别人的未读", async () => {
    const me = await makeUser()
    const other = await makeUser()
    await seed({ userId: other.id, category: "site", type: "x", title: "别人的" })
    expect(await (await get(me)).json()).toBeNull()
  })
})
