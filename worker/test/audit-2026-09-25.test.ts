/**
 * 回归测试：2026-09-25 审计中「行为类」修复的守卫。
 *
 * 覆盖（每条都对应一个真实缺陷，注释里写明原貌与危害）：
 *   · L7/F2  community_enabled 服务端是否真的生效（原先只是个假开关）
 *   · M8     评论的 replyToUserId 是否由服务端推导（原先前端可伪造通知/邮件）
 *   · M31    markRead 的 ids 数量是否受限（原先 >100 个 id 必然 500）
 *   · H12    聊天游标是否按时间序（原先拿随机 UUID 当游标，消息随机丢失）
 */
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { uuid } from "../src/crypto"
import { makeUser, authRequest, fetchSelf, setSetting } from "./helpers"

/**
 * ⚠️ 本文件里的 `setSetting` 写的是 app_settings，**不会**在用例之间自动回滚
 * （本项目的 vitest 配置对 D1 的隔离只覆盖表数据写入，实测同一文件内的
 * 全局设置会串场）。所以每个用例开头必须显式把开关复位，否则
 * 「关闭社区」的那个用例会把后面的发帖用例一起打成 403。
 */
beforeEach(async () => {
  await setSetting("community_enabled", "1")
  // ⚠️ 2026-10-01：`chat_enabled` 是 09-30 加的应急开关，默认 "0"（关闭）。
  // 本文件要测聊天游标，必须显式打开，否则普通用户一律 403 CHAT_DISABLED。
  await setSetting("chat_enabled", "1")
})

async function createPost(user: Awaited<ReturnType<typeof makeUser>>, body: string) {
  const res = await fetchSelf(
    authRequest(user, "/api/community/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    })
  )
  expect(res.status).toBe(201)
  return (await res.json<{ post: { id: string } }>()).post.id
}

describe("community_enabled 是真正的服务端开关（L7 / F2）", () => {
  it("关闭后普通用户读帖子被 403 拒绝", async () => {
    const u = await makeUser()
    await createPost(u, "开关测试帖")

    // 关闭前可以读
    const before = await fetchSelf(authRequest(u, "/api/community/posts"))
    expect(before.status).toBe(200)

    await setSetting("community_enabled", "0")

    // 关闭后必须被拒 —— 原先这里仍然 200，开关只是前端隐藏入口
    const after = await fetchSelf(authRequest(u, "/api/community/posts"))
    expect(after.status).toBe(403)
    const body = (await after.json()) as { code?: string }
    expect(body.code).toBe("FEATURE_DISABLED")
  })

  it("关闭后普通用户也不能发帖", async () => {
    const u = await makeUser()
    await setSetting("community_enabled", "0")
    const res = await fetchSelf(
      authRequest(u, "/api/community/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "应该被拒绝" }),
      })
    )
    expect(res.status).toBe(403)
  })

  it("管理员不受开关影响（否则自己没法验证功能）", async () => {
    const admin = await makeUser({ role: "admin" })
    await setSetting("community_enabled", "0")
    const res = await fetchSelf(authRequest(admin, "/api/community/posts"))
    expect(res.status).toBe(200)
  })
})

describe("评论回复目标由服务端推导（M8）", () => {
  it("前端传入的 replyToUserId 被忽略，不能给任意用户造通知", async () => {
    const author = await makeUser()
    const commenter = await makeUser()
    const victim = await makeUser()

    const postId = await createPost(author, "来评论吧")

    // 攻击者声称「我回复了 victim」——受害者的 id 是真实存在的
    const res = await fetchSelf(
      authRequest(commenter, `/api/community/posts/${postId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "伪造回复", replyToUserId: victim.id }),
      })
    )
    expect(res.status).toBe(201)

    // 不能给 victim 写任何通知（原实现会照写，并在其邮箱已验证时发信）
    const forVictim = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM notifications WHERE user_id = ?"
    )
      .bind(victim.id)
      .first<{ c: number }>()
    expect(forVictim?.c ?? 0).toBe(0)

    // 入库的 reply_to_user_id 也必须是 null（顶层评论没有回复目标）
    const row = await env.DB.prepare(
      "SELECT reply_to_user_id FROM post_comments WHERE post_id = ? ORDER BY created_at DESC LIMIT 1"
    )
      .bind(postId)
      .first<{ reply_to_user_id: string | null }>()
    expect(row?.reply_to_user_id ?? null).toBe(null)
  })

  it("回复父评论时，目标取父评论作者（服务端推导）", async () => {
    const author = await makeUser()
    const alice = await makeUser()
    const bob = await makeUser()
    const postId = await createPost(author, "帖子")

    // alice 发一条顶层评论
    const first = await fetchSelf(
      authRequest(alice, `/api/community/posts/${postId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "alice 的评论" }),
      })
    )
    const parentId = (await first.json<{ comment: { id: string } }>()).comment.id

    // bob 回复它，但**谎称**目标是 author
    const res = await fetchSelf(
      authRequest(bob, `/api/community/posts/${postId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: "回复 alice",
          parentId,
          replyToUserId: author.id,
        }),
      })
    )
    expect(res.status).toBe(201)

    const row = await env.DB.prepare(
      "SELECT reply_to_user_id FROM post_comments WHERE parent_id = ?"
    )
      .bind(parentId)
      .first<{ reply_to_user_id: string | null }>()
    // 必须记成 alice，而不是前端说的 author
    expect(row?.reply_to_user_id).toBe(alice.id)
  })
})

describe("markRead 的 ids 数量受限（M31）", () => {
  it("传 200 个 id 不会 500（原先超过 D1 的 100 参数上限必然报错）", async () => {
    const u = await makeUser()
    const ids = Array.from({ length: 200 }, () => uuid())
    const res = await fetchSelf(
      authRequest(u, "/api/notifications/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      })
    )
    expect(res.status).toBe(200)
  })

  it("ids 里混入非字符串也不会 500", async () => {
    const u = await makeUser()
    const res = await fetchSelf(
      authRequest(u, "/api/notifications/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [1, null, { a: 1 }, "ok", ["x"]] }),
      })
    )
    expect(res.status).toBe(200)
  })

  it("标记已读只影响自己的通知", async () => {
    const u = await makeUser()
    const other = await makeUser()
    const now = new Date().toISOString()
    const mineId = uuid()
    const otherId = uuid()
    await env.DB.prepare(
      "INSERT INTO notifications (id, user_id, type, read, created_at) VALUES (?, ?, 'post_comment', 0, ?)"
    )
      .bind(mineId, u.id, now)
      .run()
    await env.DB.prepare(
      "INSERT INTO notifications (id, user_id, type, read, created_at) VALUES (?, ?, 'post_comment', 0, ?)"
    )
      .bind(otherId, other.id, now)
      .run()

    const res = await fetchSelf(
      authRequest(u, "/api/notifications/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [mineId, otherId] }),
      })
    )
    expect(res.status).toBe(200)

    const mine = await env.DB.prepare("SELECT read FROM notifications WHERE id = ?")
      .bind(mineId)
      .first<{ read: number }>()
    const theirs = await env.DB.prepare("SELECT read FROM notifications WHERE id = ?")
      .bind(otherId)
      .first<{ read: number }>()
    expect(mine?.read).toBe(1)
    expect(theirs?.read).toBe(0)
  })
})

describe("社区写入面的校验与限流（P2-7 剩余子项）", () => {
  it("给不存在的帖子点赞返回 404，且不留悬空点赞行", async () => {
    const u = await makeUser()
    const before = await env.DB.prepare("SELECT COUNT(*) AS c FROM post_likes").first<{
      c: number
    }>()

    const res = await fetchSelf(
      authRequest(u, `/api/community/posts/${uuid()}/like`, { method: "POST" })
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as { code?: string }
    expect(body.code).toBe("NOT_FOUND")

    // 原实现会对不存在的 id 静默 INSERT 一行 post_likes（D1 无限写入面）
    const after = await env.DB.prepare("SELECT COUNT(*) AS c FROM post_likes").first<{
      c: number
    }>()
    expect(after?.c ?? 0).toBe(before?.c ?? 0)
  })

  it("已软删除的帖子不能再被点赞", async () => {
    const u = await makeUser()
    const postId = await createPost(u, "待删除")
    await env.DB.prepare("UPDATE posts SET deleted_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), postId)
      .run()

    const res = await fetchSelf(
      authRequest(u, `/api/community/posts/${postId}/like`, { method: "POST" })
    )
    expect(res.status).toBe(404)
  })

  it("正常点赞仍然可用，且计数自洽", async () => {
    const u = await makeUser()
    const postId = await createPost(u, "可以点赞")

    const first = await fetchSelf(
      authRequest(u, `/api/community/posts/${postId}/like`, { method: "POST" })
    )
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ liked: true, likeCount: 1 })

    // 幂等切换：再点一次取消
    const second = await fetchSelf(
      authRequest(u, `/api/community/posts/${postId}/like`, { method: "POST" })
    )
    expect(await second.json()).toMatchObject({ liked: false, likeCount: 0 })
  })

  it("给不存在的帖子转发返回 404", async () => {
    const u = await makeUser()
    const res = await fetchSelf(
      authRequest(u, `/api/community/posts/${uuid()}/share`, { method: "POST" })
    )
    expect(res.status).toBe(404)
  })

  it("转发接口有限流（原先可无限刷转发数）", async () => {
    const u = await makeUser()
    const postId = await createPost(u, "转发限流")

    // 一次并发打 70 次（限流上限 60）
    const results = await Promise.all(
      Array.from({ length: 70 }, () =>
        fetchSelf(authRequest(u, `/api/community/posts/${postId}/share`, { method: "POST" }))
      )
    )
    const limited = results.filter((r) => r.status === 429)
    expect(limited.length).toBeGreaterThan(0)

    // 计数不能超过限流上限
    const row = await env.DB.prepare("SELECT share_count FROM posts WHERE id = ?")
      .bind(postId)
      .first<{ share_count: number }>()
    expect(row?.share_count ?? 0).toBeLessThanOrEqual(60)
  })

  it("发帖时不能直接附带 images（key 语义上只能属于别的帖子，必然 404）", async () => {
    const u = await makeUser()
    const res = await fetchSelf(
      authRequest(u, "/api/community/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: "带图的帖子",
          images: ["community/whatever/x.svg", "../../evil.svg"],
        }),
      })
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code?: string }
    expect(body.code).toBe("IMAGES_NOT_ALLOWED_ON_CREATE")
  })

  it("前端真实的调用形状（images: []）仍然可以发帖", async () => {
    const u = await makeUser()
    const res = await fetchSelf(
      authRequest(u, "/api/community/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // api.ts:1196 的 createPost(body, images = []) 就是这个形状
        body: JSON.stringify({ body: "没有图片的帖子", images: [] }),
      })
    )
    expect(res.status).toBe(201)
    const { post } = await res.json<{ post: { id: string } }>()
    const row = await env.DB.prepare("SELECT images FROM posts WHERE id = ?")
      .bind(post.id)
      .first<{ images: string | null }>()
    expect(row?.images ?? null).toBe(null)
  })
})

describe("聊天游标按时间序（H12）", () => {
  it("「拉最新 N 条」返回的是真正最新的，而不是随机 N 条", async () => {
    const u = await makeUser()
    for (let i = 0; i < 5; i++) {
      const res = await fetchSelf(
        authRequest(u, "/api/chat/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: `消息-${i}` }),
        })
      )
      expect(res.status).toBe(201)
      // created_at 精度是毫秒，保证顺序确定
      await new Promise((r) => setTimeout(r, 2))
    }

    // 先取全量（升序），再验证 limit=3 就是全量的**最后 3 条**。
    // 这样写是为了不受同一文件里其它用例留下的历史消息影响。
    const all = await fetchSelf(authRequest(u, "/api/chat/messages?limit=100"))
    const allBodies = (await all.json<{ messages: { body: string }[] }>()).messages.map(
      (m) => m.body
    )

    const res = await fetchSelf(authRequest(u, "/api/chat/messages?limit=3"))
    expect(res.status).toBe(200)
    const { messages } = await res.json<{ messages: { body: string }[] }>()
    expect(messages).toHaveLength(3)
    expect(messages.map((m) => m.body)).toEqual(allBodies.slice(-3))
    // 且必须是升序（原实现按随机 UUID 排序，顺序无意义）
    expect(allBodies.slice(-3)).toEqual(["消息-2", "消息-3", "消息-4"])
  })

  it("用「最后一条消息 id」做增量拉取只返回更新的消息", async () => {
    const u = await makeUser()
    const tag = `inc${uuid().slice(0, 6)}`
    const ids: string[] = []
    for (let i = 0; i < 4; i++) {
      const res = await fetchSelf(
        authRequest(u, "/api/chat/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: `${tag}-${i}` }),
        })
      )
      ids.push((await res.json<{ message: { id: string } }>()).message.id)
      await new Promise((r) => setTimeout(r, 2))
    }

    // 以第 2 条为游标（旧前端就是传消息 id）
    const res = await fetchSelf(
      authRequest(u, `/api/chat/messages?after=${encodeURIComponent(ids[1])}`)
    )
    expect(res.status).toBe(200)
    const { messages } = await res.json<{ messages: { body: string }[] }>()
    const mine = messages.map((m) => m.body).filter((b) => b.startsWith(`${tag}-`))
    // 原实现拿 UUID 比大小，返回的是「id 字典序大于游标」的随机子集
    expect(mine).toEqual([`${tag}-2`, `${tag}-3`])
  })

  it("返回的 nextCursor 可直接当 after 用（新格式游标）", async () => {
    const u = await makeUser()
    const tag = `cur${uuid().slice(0, 6)}`
    for (let i = 0; i < 3; i++) {
      await fetchSelf(
        authRequest(u, "/api/chat/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: `${tag}-${i}` }),
        })
      )
      await new Promise((r) => setTimeout(r, 2))
    }

    // 以「游标前后各截一段」的方式验证：先用游标之前的最后一条定位
    const all = await fetchSelf(authRequest(u, "/api/chat/messages?limit=100"))
    const allMsgs = (await all.json<{ messages: { id: string; body: string }[] }>()).messages
    const myMsgs = allMsgs.filter((m) => m.body.startsWith(`${tag}-`))
    expect(myMsgs.map((m) => m.body)).toEqual([`${tag}-0`, `${tag}-1`, `${tag}-2`])

    // 用 myMsgs[1] 的 created_at|id 组成新格式游标
    const cursorRow = await env.DB.prepare(
      "SELECT created_at FROM chat_messages WHERE id = ?"
    )
      .bind(myMsgs[1].id)
      .first<{ created_at: string }>()
    const cursor = `${cursorRow!.created_at}|${myMsgs[1].id}`

    const next = await fetchSelf(
      authRequest(u, `/api/chat/messages?after=${encodeURIComponent(cursor)}`)
    )
    const page2 = await next.json<{ messages: { body: string }[] }>()
    expect(page2.messages.map((m) => m.body).filter((b) => b.startsWith(`${tag}-`))).toEqual([
      `${tag}-2`,
    ])
  })
})
