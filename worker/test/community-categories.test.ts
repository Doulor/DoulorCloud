// 帖子分类可配置化（2026-10-07 站长要求：从硬编码改成管理面板可改 + 加「水帖」）。
//
// 重点验证三件「改坏了不会报错、只会静默失效」的事：
//   1. 设置写坏 / 为空时**不能**让社区页没分类可选（必须回落内置默认）；
//   2. 设置里的非法项要被丢弃，而不是把非法 key 放进去污染 posts.category；
//   3. 发帖带不存在的分类要落到默认分类，而不是报错把用户卡住。
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, setSetting } from "./helpers"
import { postCategoryDefs, parsePostCategories } from "../src/handlers/community"

const DEFAULTS = ["chat", "help", "resource", "water"]

async function createPost(user: { cookie: string }, payload: Record<string, unknown>) {
  return fetchSelf(
    authRequest(user, "/api/community/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  )
}

/** 直接读库拿分类（比再走一次列表接口更直接，也避免被分页/筛选影响） */
async function storedCategory(postId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT category FROM posts WHERE id = ?")
    .bind(postId)
    .first<{ category: string | null }>()
  return row?.category ?? null
}

async function configCategories() {
  const res = await fetchSelf(new Request("https://cloud.doulor.cn/api/community/config"))
  expect(res.status).toBe(200)
  const body = await res.json<{ categories: { key: string; zh: string; en: string; water?: boolean }[] }>()
  return body.categories
}

describe("帖子分类：配置解析", () => {
  it("没配 / 配成空串 → 回落内置默认（含「水帖」）", async () => {
    for (const bad of ["", "   "]) {
      await setSetting("post_categories", bad)
      const keys = (await postCategoryDefs(env)).map((d) => d.key)
      expect(keys).toEqual(DEFAULTS)
    }
  })

  it("设置是坏 JSON / 不是数组 → 回落内置默认，而不是空列表", async () => {
    for (const bad of ["{不是数组}", "null", "42", '{"key":"chat"}']) {
      await setSetting("post_categories", bad)
      const defs = await postCategoryDefs(env)
      expect(defs.map((d) => d.key)).toEqual(DEFAULTS)
    }
  })

  it("非法项被丢弃、合法项保留（不会整份作废）", () => {
    const parsed = parsePostCategories(
      JSON.stringify([
        { key: "ok", zh: "好的", en: "OK" },
        { key: "BAD KEY", zh: "非法字符", en: "bad" }, // 空格 → 丢
        { key: "UPPER", zh: "大写", en: "upper" }, // 会被转小写，合法
        { key: "ok", zh: "重复", en: "dup" }, // key 重复 → 丢
        { key: "noname", zh: "", en: "" }, // 两个名字都空 → 丢
        { key: "onlyzh", zh: "只有中文", en: "" }, // 英文回填中文
        "字符串不是对象", // 非对象 → 丢
      ])
    )
    expect(parsed.map((d) => d.key)).toEqual(["ok", "upper", "onlyzh"])
    expect(parsed[2].en).toBe("只有中文")
  })

  it("water 标记只认 true（不会被 \"true\" 之类字符串糊弄）", () => {
    const parsed = parsePostCategories(
      JSON.stringify([
        { key: "a", zh: "甲", en: "A", water: true },
        { key: "b", zh: "乙", en: "B", water: "true" },
        { key: "c", zh: "丙", en: "C" },
      ])
    )
    expect(parsed.find((d) => d.key === "a")?.water).toBe(true)
    expect(parsed.find((d) => d.key === "b")?.water).toBeUndefined()
    expect(parsed.find((d) => d.key === "c")?.water).toBeUndefined()
  })
})

describe("帖子分类：管理端保存", () => {
  /**
   * ⚠️ 这一组盯的是 `updateSettingsHandler` 的**通用兜底会把字符串截断到 100 字符**。
   * 分类 JSON 轻轻就超过 100 字符 —— 不特殊处理的话会截断成坏 JSON，
   * 读取侧只能回落默认，表现成「管理员改了、保存看着也成功，但线上一点没变」。
   */
  const save = (admin: { cookie: string }, value: unknown) =>
    fetchSelf(
      authRequest(admin, "/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ post_categories: value }),
      })
    )

  /**
   * 直接读库里存的值。
   * ⚠️ 不要用 GET /admin/settings 来断言：那个接口会去调 Cloudflare 的邮件路由 API
   * （测试环境里必然失败并挂到超时），而我们要验的只是「存进去的字符串有没有被截断」。
   */
  async function storedSetting(): Promise<string> {
    const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'post_categories'")
      .first<{ value: string }>()
    return row?.value ?? ""
  }

  it("保存 4 个分类（远超 100 字符）→ 存下来完整、water 标记不丢、前端立即生效", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const want = [
      { key: "chat", zh: "闲聊", en: "Chit-chat" },
      { key: "help", zh: "求助", en: "Help" },
      { key: "resource", zh: "资源共享", en: "Resources" },
      { key: "water", zh: "水帖", en: "Off-topic", water: true },
    ]
    const json = JSON.stringify(want)
    expect(json.length).toBeGreaterThan(100) // 前提：确实超过通用兜底的 100 字符上限

    const res = await save(admin, json)
    expect(res.status).toBe(200)

    // 截断的话 JSON.parse 会抛，或内容对不上
    expect(JSON.parse(await storedSetting())).toEqual(want)

    const cats = await configCategories()
    expect(cats.map((c) => c.key)).toEqual(["chat", "help", "resource", "water"])
    expect(cats.find((c) => c.key === "water")?.water).toBe(true)

    await setSetting("post_categories", "")
  })

  it("整份都不合法 → 400 拒绝（不默默存个坏值让读取侧回落默认）", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const res = await save(
      admin,
      JSON.stringify([{ key: "有 空格", zh: "", en: "" }])
    )
    expect(res.status).toBe(400)
  })

  it("服务端会归一化（key 转小写、非法项丢弃），与读取侧同一套规则", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const res = await save(
      admin,
      JSON.stringify([
        { key: "CHAT", zh: "闲聊", en: "Chat" },
        { key: "空格 非法", zh: "丢", en: "drop" },
      ])
    )
    expect(res.status).toBe(200)
    const stored = JSON.parse(await storedSetting()) as { key: string }[]
    expect(stored.map((c) => c.key)).toEqual(["chat"])
    await setSetting("post_categories", "")
  })
})

describe("帖子分类：接口下发与发帖校验", () => {
  it("/community/config 下发分类（含 water 标记），前端据此渲染", async () => {
    await setSetting("post_categories", "")
    const cats = await configCategories()
    expect(cats.map((c) => c.key)).toEqual(DEFAULTS)
    expect(cats.find((c) => c.key === "water")?.water).toBe(true)
    expect(cats.find((c) => c.key === "chat")?.zh).toBe("闲聊")
  })

  it("管理员加了新分类后，前端立刻能拿到（不用发版）", async () => {
    await setSetting(
      "post_categories",
      JSON.stringify([
        { key: "chat", zh: "闲聊", en: "Chit-chat" },
        { key: "meme", zh: "玩梗", en: "Memes" },
      ])
    )
    expect((await configCategories()).map((c) => c.key)).toEqual(["chat", "meme"])
    await setSetting("post_categories", "")
  })

  it("发帖带生效中的分类 → 原样存下", async () => {
    await setSetting("post_categories", "")
    const u = await makeUser()
    const res = await createPost(u, { body: "带分类的帖子", category: "water" })
    expect(res.status).toBe(201)
    const { post } = await res.json<{ post: { id: string } }>()
    expect(await storedCategory(post.id)).toBe("water")
  })

  it("发帖带不存在的分类 → 落到默认分类（不报错，避免动态分类把用户卡死）", async () => {
    await setSetting("post_categories", "")
    const u = await makeUser()
    const res = await createPost(u, { body: "分类不存在", category: "这个分类没有" })
    expect(res.status).toBe(201)
    const { post } = await res.json<{ post: { id: string } }>()
    expect(await storedCategory(post.id)).toBe("chat")
  })

  it("默认分类跟着配置走：第一项换成别的以后，无分类的帖子落到它", async () => {
    await setSetting(
      "post_categories",
      JSON.stringify([
        { key: "meme", zh: "玩梗", en: "Memes" },
        { key: "chat", zh: "闲聊", en: "Chit-chat" },
      ])
    )
    const u = await makeUser()
    const res = await createPost(u, { body: "没带分类" })
    expect(res.status).toBe(201)
    const { post } = await res.json<{ post: { id: string } }>()
    expect(await storedCategory(post.id)).toBe("meme")
    await setSetting("post_categories", "")
  })
})
