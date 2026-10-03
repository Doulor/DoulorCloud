// 个人空间 + 成就扩展。
//
// 这里测的重点不是「字段有没有返回」，而是三条**容易悄悄坏掉**的规则：
//   1. 成就那 28 个子查询的合并 SQL 能跑通（写错一个表名/列名就整页 500，
//      而单测不覆盖时只有用户打开成就页才会发现）；
//   2. **捐献 payload 里的凭据永不出现在公开响应里**（含被打码的条目）；
//   3. 打码是**服务端**做的 —— 缺权限时内容根本没下发，而不是「返回了让前端糊住」。
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, setPermissions, setSetting, type TestUser } from "./helpers"
import {
  computeAchievements,
  loadUserCounts,
  titleFor,
} from "../src/handlers/achievements"

const HOST = "https://cloud.doulor.cn"

/** 不带任何凭据的请求（模拟访客） */
function publicGet(path: string): Promise<Response> {
  return fetchSelf(new Request(`${HOST}${path}`))
}

/** 造一个「有捐献、有帖子」的用户 */
async function makeRichUser(opts: { username?: string } = {}): Promise<TestUser> {
  const user = await makeUser(opts)
  const now = new Date().toISOString()
  // 一条 AI 渠道捐献（payload 里有 Key —— 绝不能出现在对外响应里）
  await env.DB.prepare(
    `INSERT INTO donations (id, user_id, type, payload, notify_email, status, created_at, reviewed_at)
     VALUES (?, ?, 'ai', ?, ?, 'approved', ?, ?)`
  )
    .bind(
      `d_${user.id}`,
      user.id,
      JSON.stringify({ baseUrl: "https://upstream.example.com", apiKey: "SECRET-KEY-abcdef", models: ["m1", "m2"] }),
      `${user.username}@example.net`,
      now,
      now
    )
    .run()
  // 一条帖子（用于「历史帖子」分区）
  await env.DB.prepare(
    `INSERT INTO posts (id, user_id, channel, body, created_at)
     VALUES (?, ?, 'general', ?, ?)`
  )
    .bind(`p_${user.id}`, user.id, "我的第一条帖子内容", now)
    .run()
  return user
}

beforeEach(async () => {
  await setSetting("community_enabled", "1")
  await setSetting("community_guest_access", "1")
})

// ---- 纯函数：称号 ----

describe("titleFor", () => {
  it("按成就点分档，边界含下界", () => {
    expect(titleFor(0).name).toBe("初来乍到")
    expect(titleFor(2).name).toBe("初来乍到")
    expect(titleFor(3).name).toBe("新星")
    expect(titleFor(7).name).toBe("新星")
    expect(titleFor(8).name).toBe("常客")
    expect(titleFor(36).name).toBe("传奇")
    expect(titleFor(999).name).toBe("传奇")
  })

  it("给出下一档目标（最高档为 null）", () => {
    expect(titleFor(0).next).toBe(3)
    expect(titleFor(0).nextName).toBe("新星")
    expect(titleFor(36).next).toBeNull()
    expect(titleFor(36).nextName).toBeNull()
  })
})

// ---- 纯函数：成就计算 ----

describe("computeAchievements", () => {
  it("全零计数 → 基本都没解锁，称号是入门档", async () => {
    const u = await makeUser()
    const counts = await loadUserCounts(env, u.id)
    const snap = computeAchievements(counts)
    const byId = new Map(snap.achievements.map((a) => [a.id, a]))
    // 测试库里用户总数远小于 20，所以「元老」对谁都是解锁的（生产不会）——
    // 这里把它排除掉，只断言其余成就都是 0
    expect(byId.get("subdomain")?.level).toBe(0)
    expect(byId.get("posts")?.level).toBe(0)
    expect(byId.get("donor")?.level).toBe(0)
    expect(byId.get("visit")?.level).toBe(0)
    expect(snap.summary.points).toBeLessThanOrEqual(1)
    // 点数不到 3 → 还是入门称号
    expect(snap.title.name).toBe("初来乍到")
    expect(snap.achievements.every((a) => typeof a.group === "string" && a.group.length > 0)).toBe(true)
  })

  it("有数据后对应成就升级，点数=各成就等级之和", async () => {
    const u = await makeRichUser()
    const counts = await loadUserCounts(env, u.id)
    const snap = computeAchievements(counts)

    const byId = new Map(snap.achievements.map((a) => [a.id, a]))
    expect(byId.get("posts")?.level).toBe(1) // 1 条帖子
    expect(byId.get("donor")?.level).toBe(1) // 1 次通过审核的捐献
    expect(byId.get("donor_all")?.level).toBe(0) // 只捐了一种类型 → 还没到三种
    expect(snap.summary.points).toBe(
      snap.achievements.reduce((s, a) => s + a.level, 0)
    )
    expect(snap.summary.points).toBeGreaterThan(0)
    expect(snap.summary.maxPoints).toBeGreaterThan(snap.summary.unlocked)
  })

  it("分级成就按阈值算等级，不越界", async () => {
    const u = await makeUser()
    const now = new Date().toISOString()
    // 3 条子域名 → 「开疆拓土」Lv.2（阈值 1/3/5）
    for (let i = 0; i < 3; i++) {
      await env.DB.prepare(
        `INSERT INTO subdomains (id, user_id, name, fqdn, status, created_at)
         VALUES (?, ?, ?, ?, 'active', ?)`
      )
        .bind(`s_${i}_${u.id}`, u.id, `sub${i}`, `sub${i}.u${u.id.slice(0, 4)}.doulor.cn`, now)
        .run()
    }
    const snap = computeAchievements(await loadUserCounts(env, u.id))
    const a = snap.achievements.find((x) => x.id === "subdomain")!
    expect(a.level).toBe(2)
    expect(a.nextTier).toBe(5)
    expect(a.maxed).toBe(false)
  })
})

// ---- 接口：GET /api/achievements ----

describe("GET /api/achievements", () => {
  it("返回分组、点数与称号（合并 SQL 跑得通）", async () => {
    const u = await makeRichUser()
    const res = await fetchSelf(authRequest(u, "/api/achievements"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      achievements: { id: string; group: string }[]
      groups: { id: string }[]
      summary: { unlocked: number; total: number; points: number; maxPoints: number }
      title: { name: string }
    }
    expect(body.groups.length).toBeGreaterThan(1)
    expect(body.summary.total).toBe(body.achievements.length)
    expect(body.summary.maxPoints).toBeGreaterThan(body.summary.total)
    expect(body.title.name).toBeTruthy()
    // 每个成就的 group 都必须能在 groups 里找到（否则前端会掉进「其他」分组）
    const ids = new Set(body.groups.map((g) => g.id))
    expect(body.achievements.every((a) => ids.has(a.group))).toBe(true)
  })
})

// ---- 接口：个人空间 ----

describe("GET /api/space/:username", () => {
  it("本人看自己的贡献：不打码，能看到计数摘要", async () => {
    const me = await makeRichUser()
    const res = await fetchSelf(authRequest(me, `/api/space/${me.username}`))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      space: { isOwner: boolean }
      contributions: { items: { masked: boolean; summary: string | null }[] } | null
      achievements: { badges: unknown[] } | null
    }
    expect(body.space.isOwner).toBe(true)
    expect(body.contributions?.items.length).toBe(1)
    expect(body.contributions?.items[0].masked).toBe(false)
    expect(body.contributions?.items[0].summary).toContain("2 个模型")
  })

  it("**缺权限的访客只拿到打码条目，且响应里没有任何凭据**", async () => {
    const target = await makeRichUser()
    const viewer = await makeUser()
    // 查看者没有 ai 权限（商汤/AI 渠道都归 ai 模块）
    await setPermissions(viewer.id, JSON.stringify({ ai: false, proxy: false, frp: false }))

    const res = await fetchSelf(authRequest(viewer, `/api/space/${target.username}`))
    const text = await res.text()
    // 最关键的一条：API Key / 上游地址绝不能出现在响应里
    expect(text).not.toContain("SECRET-KEY-abcdef")
    expect(text).not.toContain("upstream.example.com")

    const body = JSON.parse(text) as {
      contributions: { items: { masked: boolean; summary: string | null }[] }
      space: { isOwner: boolean }
    }
    expect(body.space.isOwner).toBe(false)
    expect(body.contributions.items[0].masked).toBe(true)
    expect(body.contributions.items[0].summary).toBeNull()
  })

  it("有对应权限的访客能看到摘要（权限是查看者的，不是主人的）", async () => {
    const target = await makeRichUser()
    const viewer = await makeUser() // 默认 permissions = NULL → 全开
    const res = await fetchSelf(authRequest(viewer, `/api/space/${target.username}`))
    const body = (await res.json()) as {
      contributions: { items: { masked: boolean; summary: string | null }[] }
    }
    expect(body.contributions.items[0].masked).toBe(false)
    expect(body.contributions.items[0].summary).toContain("2 个模型")
  })

  it("未登录访客：贡献一律打码，帖子按「允许访客访问社区」开关", async () => {
    const target = await makeRichUser()
    const res = await publicGet(`/api/space/${target.username}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      contributions: { items: { masked: boolean }[] }
      posts: { items: unknown[]; hiddenReason: string | null }
    }
    expect(body.contributions.items.every((c) => c.masked)).toBe(true)
    expect(body.posts.items.length).toBe(1) // 默认允许访客
    expect(body.posts.hiddenReason).toBeNull()

    // 关掉访客访问 → 帖子区只留一句原因，不发内容
    await setSetting("community_guest_access", "0")
    const res2 = await publicGet(`/api/space/${target.username}`)
    const body2 = (await res2.json()) as {
      posts: { items: unknown[]; hiddenReason: string | null }
    }
    expect(body2.posts.items.length).toBe(0)
    expect(body2.posts.hiddenReason).toContain("登录")
  })

  it("不存在的用户 → 404", async () => {
    const res = await publicGet("/api/space/no_such_user_xyz")
    expect(res.status).toBe(404)
  })
})

// ---- 接口：展示设置 ----

describe("展示设置", () => {
  it("PUT /api/my-space 关掉分区后，空间里对应分区为 null", async () => {
    const me = await makeRichUser()
    const save = await fetchSelf(
      authRequest(me, "/api/my-space", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          showAchievements: false,
          showStats: false,
          showPosts: true,
          showContributions: true,
          motto: "折腾不停的人",
        }),
      })
    )
    expect(save.status).toBe(200)

    const res = await fetchSelf(authRequest(me, `/api/space/${me.username}`))
    const body = (await res.json()) as {
      space: { motto: string | null; showAchievements: boolean; showStats: boolean }
      achievements: unknown
      stats: unknown
      posts: unknown
    }
    expect(body.space.motto).toBe("折腾不停的人")
    expect(body.space.showAchievements).toBe(false)
    expect(body.achievements).toBeNull()
    expect(body.stats).toBeNull()
    expect(body.posts).not.toBeNull()

    // 再读回设置（弹窗要有原值）
    const mine = await fetchSelf(authRequest(me, "/api/my-space"))
    const set = (await mine.json()) as {
      settings: { showAchievements: boolean; showPosts: boolean; motto: string }
    }
    expect(set.settings.showAchievements).toBe(false)
    expect(set.settings.showPosts).toBe(true)
    expect(set.settings.motto).toBe("折腾不停的人")
  })

  it("签名超长会被截断到 40 字", async () => {
    const me = await makeUser()
    const long = "字".repeat(80)
    await fetchSelf(
      authRequest(me, "/api/my-space", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motto: long }),
      })
    )
    const mine = await fetchSelf(authRequest(me, "/api/my-space"))
    const set = (await mine.json()) as { settings: { motto: string } }
    expect(set.settings.motto.length).toBe(40)
  })
})

// ---- 接口：悬浮卡片 ----

describe("GET /api/space/:username/card", () => {
  it("返回称号、成就数与帖子数（公开）", async () => {
    const target = await makeRichUser()
    const res = await publicGet(`/api/space/${target.username}/card`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      username: string
      title: string
      unlocked: number
      total: number
      posts: number
      isMe: boolean
      motto: string | null
    }
    expect(body.username).toBe(target.username)
    expect(body.title).toBeTruthy()
    expect(body.total).toBeGreaterThan(0)
    expect(body.posts).toBe(1)
    expect(body.isMe).toBe(false)
  })

  it("`card` 不会被当成用户名（路由顺序）", async () => {
    const target = await makeRichUser()
    const res = await publicGet(`/api/space/${target.username}/card`)
    const body = (await res.json()) as { username: string }
    expect(body.username).toBe(target.username) // 而不是 "card"
  })
})
