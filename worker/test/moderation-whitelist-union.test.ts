/**
 * 白名单自动条件：**并集语义**（2026-10-08 站长明确）。
 *
 * 需求原话：「那几个条件是并集不是交集，满足任意一个就行」。
 *
 * 踩过的坑（本测试就是钉住它）：
 *   界面上「成就点 > 50」这条只显示了 3 个人，而实际有 13 人 > 50 分。
 *   原因是当时展示口径用了 `moderation_whitelist.condition_id` ——
 *   那是**存储上的单一归属**（一个人只存一个条件，为了让「关掉 A 条件时他落到 B」
 *   这个行为成立），不是「他满足哪些条件」。展示必须用完整的命中名单。
 *
 * 所以这里断言两件事：
 *   1. 同时满足两个条件的人，要**出现在两个分组里**（并集，不是先到先得）；
 *   2. 只满足一个条件的人，不出现在另一个分组里。
 */
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, type TestUser } from "./helpers"
import { uuid } from "../src/crypto"

/** 管理端接口用 superadmin：admin 角色要求配权限组，测试里没配会一律 403（既有基线） */
async function makeAdmin(): Promise<TestUser> {
  return makeUser({ role: "superadmin" })
}

/** 调管理端接口 */
async function adminFetch(admin: TestUser, path: string, init?: RequestInit): Promise<Response> {
  return fetchSelf(authRequest(admin, path, init))
}

/**
 * 创建条件并返回它的 id。
 * 创建接口只回 `{ ok: true }`（不返回 id），所以建完直接查库拿最大 createdAt 那条。
 */
async function createCondition(
  admin: TestUser,
  metric: string,
  op: string,
  value: number
): Promise<string> {
  const res = await adminFetch(admin, "/api/admin/moderation/conditions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "create", metric, op, value }),
  })
  expect(res.status).toBe(200)
  const row = await env.DB.prepare(
    "SELECT id FROM moderation_conditions ORDER BY created_at DESC, rowid DESC LIMIT 1"
  ).first<{ id: string }>()
  expect(row?.id).toBeTruthy()
  return row!.id
}

async function deleteCondition(admin: TestUser, id: string): Promise<void> {
  await adminFetch(admin, "/api/admin/moderation/conditions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "delete", id }),
  })
}

/** 给用户挂一个自定义称号（列表页的「有自定义称号」条件靠 user_titles 有行来判定） */
async function grantTitle(user: TestUser): Promise<void> {
  const titleId = uuid()
  const now = new Date().toISOString()
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO custom_titles (id, name, color_from, color_to, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(titleId, "并集测试称号", "#111111", "#222222", now),
    env.DB.prepare(
      "INSERT INTO user_titles (user_id, title_id, is_display, granted_at) VALUES (?, ?, 1, ?)"
    ).bind(user.id, titleId, now),
  ])
}

interface GroupShape {
  id: string
  metric: string
  enabled: boolean
  users: { username: string }[]
}

async function listGroups(admin: TestUser): Promise<GroupShape[]> {
  const res = await adminFetch(admin, "/api/admin/moderation/lists")
  expect(res.status).toBe(200)
  const body = (await res.json()) as { whitelist: { groups: GroupShape[] } }
  return body.whitelist.groups
}

describe("白名单自动条件是并集", () => {
  it("同时满足两个条件的人，出现在两个分组里", async () => {
    const admin = await makeAdmin()
    const titled = await makeUser()
    const plain = await makeUser()
    await grantTitle(titled)

    // 条件 A：成就点 >= 0（人人满足）。
    // 条件 B：有自定义称号（只有 titled 满足）。
    const aId = await createCondition(admin, "achievement_points", "gte", 0)
    const bId = await createCondition(admin, "custom_title", "gte", 0)

    try {
      const groups = await listGroups(admin)
      const a = groups.find((g) => g.id === aId)
      const b = groups.find((g) => g.id === bId)
      expect(a).toBeDefined()
      expect(b).toBeDefined()

      const inA = a!.users.map((u) => u.username)
      const inB = b!.users.map((u) => u.username)

      // ① 并集：有称号的人同时满足 A、B ⇒ 两个分组里都要有他
      expect(inA).toContain(titled.username)
      expect(inB).toContain(titled.username)

      // ② 没称号的人只在 A 里
      expect(inA).toContain(plain.username)
      expect(inB).not.toContain(plain.username)

      // ③ 名次不该被「先命中的条件」吃掉：B 里也不该只有零头
      expect(inB.length).toBeGreaterThan(0)
    } finally {
      await deleteCondition(admin, aId)
      await deleteCondition(admin, bId)
    }
  })

  it("两个条件都满足同一个人时，两边都列出（不会只算第一个）", async () => {
    const admin = await makeAdmin()
    const u = await makeUser()
    await grantTitle(u)

    // 两条阈值相同的成就点条件 —— 都该命中同一个人
    const c1 = await createCondition(admin, "achievement_points", "gte", 0)
    const c2 = await createCondition(admin, "achievement_points", "gte", 0)
    try {
      const groups = await listGroups(admin)
      const g1 = groups.find((g) => g.id === c1)!
      const g2 = groups.find((g) => g.id === c2)!
      expect(g1.users.map((x) => x.username)).toContain(u.username)
      expect(g2.users.map((x) => x.username)).toContain(u.username)
    } finally {
      await deleteCondition(admin, c1)
      await deleteCondition(admin, c2)
    }
  })

  it("条件关掉后：用户退出该分组；仍满足别的条件时仍留在白名单里", async () => {
    const admin = await makeAdmin()
    const u = await makeUser()
    await grantTitle(u)

    const aId = await createCondition(admin, "achievement_points", "gte", 0)
    const bId = await createCondition(admin, "custom_title", "gte", 0)
    try {
      // 关掉「成就点 >= 0」，只剩「有称号」
      await adminFetch(admin, "/api/admin/moderation/conditions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "toggle", id: aId, enabled: false }),
      })
      const groups = await listGroups(admin)
      const a = groups.find((g) => g.id === aId)!
      const b = groups.find((g) => g.id === bId)!
      expect(a.users.map((x) => x.username)).not.toContain(u.username)
      // 但仍满足 B ⇒ 还在白名单里（这是「单一归属」要保的行为）
      expect(b.users.map((x) => x.username)).toContain(u.username)
    } finally {
      await deleteCondition(admin, aId)
      await deleteCondition(admin, bId)
    }
  })
})
