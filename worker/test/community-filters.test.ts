// 帖子广场两层筛选（2026-10-07 站长要求）。
//
//   第一层 sort：latest（按发布时间）/ hot（按热度 = 点赞 + 评论）
//   第二层范围：category=<key>（只看某分类）/ exclude_water=1（看全部但不含水帖）
//
// 重点验证「改坏了不会报错、只会静默出错」的两件事：
//   1. 筛选条件必须和游标条件同构 —— 否则翻页会漏帖 / 重复（最隐蔽的一类 bug）；
//   2. 置顶只该出现在第一页 —— 让它参与游标分页会让第二页从它的排序键续，跳过一大批帖子。
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, setSetting } from "./helpers"

interface ListedPost {
  id: string
  category: string
  likeCount: number
  commentCount: number
  pinned: boolean
}

/**
 * 建一篇帖子并直接设定互动数与分类。
 *
 * 走接口建帖（保证必填字段都对），再 UPDATE 计数器/分类 —— 比手写 INSERT 更抗 schema 变化。
 * ⚠️ 发帖有「每人 60 秒 2 次」的限流，所以每篇都用一个新用户，别复用同一个人。
 */
async function seedPost(opts: {
  body: string
  category?: string
  likes?: number
  comments?: number
  pinned?: boolean
}): Promise<string> {
  const u = await makeUser()
  const res = await fetchSelf(
    authRequest(u, "/api/community/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: opts.body, ...(opts.category ? { category: opts.category } : {}) }),
    })
  )
  expect(res.status).toBe(201)
  const { post } = await res.json<{ post: { id: string } }>()
  await env.DB.prepare(
    "UPDATE posts SET like_count = ?, comment_count = ?, pinned = ?, category = ? WHERE id = ?"
  )
    .bind(opts.likes ?? 0, opts.comments ?? 0, opts.pinned ? 1 : 0, opts.category ?? "chat", post.id)
    .run()
  return post.id
}

async function list(query: string): Promise<{ posts: ListedPost[]; nextCursor: string | null }> {
  const u = await makeUser()
  const res = await fetchSelf(authRequest(u, `/api/community/posts${query}`))
  expect(res.status).toBe(200)
  return res.json<{ posts: ListedPost[]; nextCursor: string | null }>()
}

/** 清掉库里已有帖子对本组断言的干扰（测试库是共享的，前面用例会留下数据） */
async function onlyThese(ids: string[]): Promise<void> {
  await env.DB.prepare(
    `UPDATE posts SET deleted_at = ? WHERE id NOT IN (${ids.map(() => "?").join(", ")})`
  )
    .bind(new Date().toISOString(), ...ids)
    .run()
}

describe("帖子列表：两层筛选", () => {
  it("sort=hot 按「点赞 + 评论」降序；latest 按时间降序", async () => {
    const a = await seedPost({ body: "热度低", likes: 1, comments: 0 })
    const b = await seedPost({ body: "热度中", likes: 3, comments: 2 })
    const c = await seedPost({ body: "热度高", likes: 10, comments: 5 })
    await onlyThese([a, b, c])

    const hot = await list("?sort=hot")
    expect(hot.posts.map((p) => p.id)).toEqual([c, b, a])

    // latest：时间倒序 ⇒ 最后建的排最前
    const latest = await list("?sort=latest")
    expect(latest.posts.map((p) => p.id)).toEqual([c, b, a])
  })

  it("category=<key> 只返回该分类", async () => {
    const chat1 = await seedPost({ body: "闲聊一", category: "chat" })
    const water1 = await seedPost({ body: "水帖一", category: "water" })
    const help1 = await seedPost({ body: "求助一", category: "help" })
    await onlyThese([chat1, water1, help1])

    const water = await list("?category=water")
    expect(water.posts.map((p) => p.id)).toEqual([water1])

    const help = await list("?category=help")
    expect(help.posts.map((p) => p.id)).toEqual([help1])
  })

  it("exclude_water=1 返回全部但不含水帖分类", async () => {
    const chat1 = await seedPost({ body: "闲聊二", category: "chat" })
    const water1 = await seedPost({ body: "水帖二", category: "water" })
    const help1 = await seedPost({ body: "求助二", category: "help" })
    await onlyThese([chat1, water1, help1])

    const ids = (await list("?exclude_water=1")).posts.map((p) => p.id)
    expect(ids).toContain(chat1)
    expect(ids).toContain(help1)
    expect(ids).not.toContain(water1)
  })

  it("不传筛选参数 = 全部（含置顶最前）", async () => {
    const a = await seedPost({ body: "普通帖", category: "chat" })
    const pin = await seedPost({ body: "置顶帖", category: "water", pinned: true })
    await onlyThese([a, pin])

    const all = await list("")
    expect(all.posts[0].id).toBe(pin) // 置顶排最前
    expect(all.posts.map((p) => p.id)).toContain(a)
  })

  it("传了不存在的分类 → 当作全部，不报错也不空白", async () => {
    const a = await seedPost({ body: "还在的帖子", category: "chat" })
    await onlyThese([a])

    const res = await list("?category=这个分类早就被删了")
    expect(res.posts.map((p) => p.id)).toEqual([a])
  })

  it("⚠️ sort=hot 翻页不漏不重（游标必须与排序同构）", async () => {
    // 热度刻意造出**大量同分**：同分时的退让排序最容易写错
    const ids: string[] = []
    for (let i = 0; i < 7; i++) {
      ids.push(await seedPost({ body: `同分帖${i}`, likes: 2, comments: 2 }))
    }
    await onlyThese(ids)

    const collected: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 10; page++) {
      const q: string = `?sort=hot&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
      const res = await list(q)
      collected.push(...res.posts.map((p) => p.id))
      cursor = res.nextCursor
      if (!cursor) break
    }
    // 7 条全拿到，且没有重复
    expect(collected.length).toBe(7)
    expect(new Set(collected).size).toBe(7)
    expect([...collected].sort()).toEqual([...ids].sort())
  })

  it("⚠️ sort=latest 翻页同样不漏不重，且置顶不会在第二页重复出现", async () => {
    const pin = await seedPost({ body: "置顶", pinned: true })
    const rest: string[] = []
    for (let i = 0; i < 6; i++) rest.push(await seedPost({ body: `普通${i}` }))
    await onlyThese([pin, ...rest])

    const collected: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 10; page++) {
      const q: string = `?limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
      const res = await list(q)
      collected.push(...res.posts.map((p) => p.id))
      cursor = res.nextCursor
      if (!cursor) break
    }
    expect(collected.length).toBe(7)
    expect(new Set(collected).size).toBe(7)
    // 置顶只在第一页出现一次
    expect(collected.filter((x) => x === pin).length).toBe(1)
    expect(collected[0]).toBe(pin)
  })

  it("筛选与分页组合：只看水帖时也能翻页", async () => {
    const water: string[] = []
    for (let i = 0; i < 4; i++) water.push(await seedPost({ body: `水${i}`, category: "water" }))
    const chat = await seedPost({ body: "闲聊", category: "chat" })
    await onlyThese([...water, chat])

    const collected: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 10; page++) {
      const q: string = `?category=water&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
      const res = await list(q)
      collected.push(...res.posts.map((p) => p.id))
      cursor = res.nextCursor
      if (!cursor) break
    }
    expect(new Set(collected).size).toBe(4)
    expect(collected).not.toContain(chat)
  })

  it("管理员改了「水帖」标记后，exclude_water 立刻跟着变（不是写死 key=water）", async () => {
    const a = await seedPost({ body: "甲分类帖", category: "alpha" })
    const b = await seedPost({ body: "乙分类帖", category: "beta" })
    await onlyThese([a, b])

    // 把 alpha 标成水帖 ⇒ 被排除
    await setSetting(
      "post_categories",
      JSON.stringify([
        { key: "alpha", zh: "甲", en: "Alpha", water: true },
        { key: "beta", zh: "乙", en: "Beta" },
      ])
    )
    const ids = (await list("?exclude_water=1")).posts.map((p) => p.id)
    expect(ids).not.toContain(a)
    expect(ids).toContain(b)

    await setSetting("post_categories", "")
  })
})
