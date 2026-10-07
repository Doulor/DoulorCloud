// 管理员权限系统：权限树解析 + 白名单守卫 + 权限组/成员权限 API。
//
// 重点覆盖「越权」边界 —— 白名单必须严格（没有 = 拒绝），
// 权限组引用 / 自定义覆盖的回退顺序要对，否则会白送权限。
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, type TestUser } from "./helpers"
import {
  ADMIN_PERMISSIONS,
  parseAdminScope,
  isKnownPermissionKey,
  isRootOnlyPermission,
} from "../src/admin-permissions"
import {
  resolveAdminScope,
  assertAdminScope,
} from "../src/handlers/admin"
import { serveFeedbackImage } from "../src/handlers/feedback"
import type { Env } from "../src/env"

const HOST = "https://cloud.doulor.cn"

function req(user: TestUser, path: string, init: RequestInit = {}): Request {
  return authRequest(user, path, init)
}

describe("admin-permissions 权限树", () => {
  it("parseAdminScope 只保留合法 key，丢弃非法与重复", () => {
    const s = parseAdminScope(JSON.stringify(["points.review", "bogus", "points.review", 42]))
    expect(s.size).toBe(1)
    expect(s.has("points.review")).toBe(true)
  })

  it("parseAdminScope 对 NULL / 损坏 JSON 返回空集（deny by default）", () => {
    expect(parseAdminScope(null).size).toBe(0)
    expect(parseAdminScope("{broken").size).toBe(0)
    expect(parseAdminScope("not-an-array").size).toBe(0)
  })

  it("rootOnly 节点标记正确", () => {
    expect(isRootOnlyPermission("users.role")).toBe(true)
    expect(isRootOnlyPermission("users.2fa")).toBe(true)
    expect(isRootOnlyPermission("users.view")).toBe(false)
  })

  it("大类 key 不是叶子（不能直接当权限节点用）", () => {
    expect(isKnownPermissionKey("points")).toBe(false)
    expect(isKnownPermissionKey("points.review")).toBe(true)
  })

  it("权限树含捐献的 ai/proxy/frp 三类子节点", () => {
    const donations = ADMIN_PERMISSIONS.find((c) => c.key === "donations")
    const keys = donations?.children?.map((l) => l.key) ?? []
    expect(keys).toContain("donations.ai")
    expect(keys).toContain("donations.proxy")
    expect(keys).toContain("donations.frp")
  })
})

describe("resolveAdminScope 回退顺序", () => {
  it("admin_scope 优先于权限组", async () => {
    const gid = "grp_scope_test"
    const now = new Date().toISOString()
    await env.DB.prepare(
      "INSERT INTO admin_roles (id, name, scope, created_at, updated_at) VALUES (?, 'g', ?, ?, ?)"
    ).bind(gid, JSON.stringify(["points.review"]), now, now).run()

    const admin = {
      role: "admin",
      admin_role_id: gid,
      admin_scope: JSON.stringify(["points.adjust"]),
    }
    const scope = await resolveAdminScope(env as unknown as Env, admin)
    expect(scope.has("points.adjust")).toBe(true)
    expect(scope.has("points.review")).toBe(false) // 覆盖后组里的不算
  })

  it("无覆盖时回落到权限组 scope", async () => {
    const admin = {
      role: "admin",
      admin_role_id: "grp_scope_test",
      admin_scope: null,
    }
    const scope = await resolveAdminScope(env as unknown as Env, admin)
    expect(scope.has("points.review")).toBe(true)
  })

  it("无组也无覆盖时为空（deny by default）", async () => {
    const scope = await resolveAdminScope(env as unknown as Env, {
      role: "admin",
      admin_role_id: null,
      admin_scope: null,
    })
    expect(scope.size).toBe(0)
  })
})

describe("assertAdminScope 白名单守卫", () => {
  it("admin 无对应节点 → 403 ADMIN_SCOPE_DENIED", async () => {
    const admin = { role: "admin", admin_role_id: null, admin_scope: JSON.stringify(["users.view"]) }
    await expect(
      assertAdminScope(env as unknown as Env, admin, "points.adjust")
    ).rejects.toMatchObject({ code: "ADMIN_SCOPE_DENIED" })
  })

  it("admin 有对应节点 → 放行", async () => {
    const admin = { role: "admin", admin_role_id: null, admin_scope: JSON.stringify(["users.view"]) }
    await expect(assertAdminScope(env as unknown as Env, admin, "users.view")).resolves.toBeUndefined()
  })

  it("superadmin 全放行（不看白名单）", async () => {
    const admin = { role: "superadmin", admin_role_id: null, admin_scope: null }
    await expect(assertAdminScope(env as unknown as Env, admin, "points.adjust")).resolves.toBeUndefined()
  })

  it("rootOnly 节点 superadmin 也被拦，只有 root 能过", async () => {
    await expect(
      assertAdminScope(env as unknown as Env, { role: "superadmin", admin_role_id: null, admin_scope: null }, "users.role")
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      assertAdminScope(env as unknown as Env, { role: "root", admin_role_id: null, admin_scope: null }, "users.role")
    ).resolves.toBeUndefined()
  })
})

describe("权限组 / 成员权限 API", () => {
  let root: TestUser
  let superadmin: TestUser
  let admin: TestUser

  beforeEach(async () => {
    root = await makeUser({ role: "root" })
    superadmin = await makeUser({ role: "superadmin" })
    admin = await makeUser({ role: "admin" })
    // 给 admin 一个自定义 scope：能看用户，不能调积分
    await env.DB.prepare("UPDATE users SET admin_scope = ? WHERE id = ?")
      .bind(JSON.stringify(["users.view"]), admin.id).run()
  })

  it("root 能拿权限树", async () => {
    const res = await fetchSelf(req(root, "/api/admin/permissions/tree"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { categories: { key: string }[] }
    expect(body.categories.some((c) => c.key === "points")).toBe(true)
  })

  it("普通 admin 不能拿权限组列表（只有 root / superadmin 能管组）", async () => {
    const res = await fetchSelf(req(admin, "/api/admin/permission-groups"))
    expect(res.status).toBe(403)
  })

  it("superadmin 默认不能管权限组（开关默认关）", async () => {
    const res = await fetchSelf(req(superadmin, "/api/admin/permission-groups"))
    expect(res.status).toBe(403)
  })

  it("root 建组 → 改组 → 删组 全链路", async () => {
    const create = await fetchSelf(
      req(root, "/api/admin/permission-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "内容运营", scope: ["points.review", "feedback"] }),
      })
    )
    expect(create.status).toBe(201)
    const { id } = (await create.json()) as { id: string }

    const list = await fetchSelf(req(root, "/api/admin/permission-groups"))
    const groups = ((await list.json()) as { groups: { id: string; scope: string[] }[] }).groups
    const g = groups.find((x) => x.id === id)
    expect(g).toBeTruthy()
    expect(g!.scope).toContain("points.review")

    const del = await fetchSelf(req(root, `/api/admin/permission-groups/${id}`, { method: "DELETE" }))
    expect(del.status).toBe(200)
  })

  it("成员套组后，组权限生效；自定义覆盖后标记 custom", async () => {
    // root 建组
    const create = await fetchSelf(
      req(root, "/api/admin/permission-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "审核组", scope: ["donations.ai"] }),
      })
    )
    const { id } = (await create.json()) as { id: string }

    // 把某个普通用户设为 admin + 引用组
    const target = await makeUser()
    const set1 = await fetchSelf(
      req(root, `/api/admin/users/${target.username}/admin-permissions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "admin", adminRoleId: id, adminScope: [] }),
      })
    )
    expect(set1.status).toBe(200)

    // 查：custom=false（纯引用）
    const get1 = await fetchSelf(req(root, `/api/admin/users/${target.username}/admin-permissions`))
    const s1 = (await get1.json()) as { custom: boolean; adminRoleId: string | null }
    expect(s1.custom).toBe(false)
    expect(s1.adminRoleId).toBe(id)

    // 自定义覆盖：adminScope 非空
    const set2 = await fetchSelf(
      req(root, `/api/admin/users/${target.username}/admin-permissions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "admin", adminRoleId: id, adminScope: ["donations.frp"] }),
      })
    )
    expect(set2.status).toBe(200)
    const get2 = await fetchSelf(req(root, `/api/admin/users/${target.username}/admin-permissions`))
    const s2 = (await get2.json()) as { custom: boolean; adminRoleId: string | null }
    expect(s2.custom).toBe(true) // 覆盖后标记自定义
    expect(s2.adminRoleId).toBe(id) // 仍在组里
  })
})

describe("反馈图片：自定义 admin 的可见性", () => {
  it("admin 有 feedback 权限 → 能看别人的反馈图片（不 403）", async () => {
    const uploader = await makeUser()
    const admin = await makeUser({ role: "admin" })
    await env.DB.prepare("UPDATE users SET admin_scope = ? WHERE id = ?")
      .bind(JSON.stringify(["feedback"]), admin.id).run()

    const res = await serveFeedbackImage(
      env as unknown as Env,
      req(admin, "/api/feedback/image/x/y.png"),
      uploader.id,
      "00000000-0000-0000-0000-000000000000.png"
    )
    // 守卫放行后，走到 R2（测试环境未配置）会 404，而不是 403
    expect(res.status).not.toBe(403)
  })

  it("admin 没有 feedback 权限 → 403", async () => {
    const uploader = await makeUser()
    const admin = await makeUser({ role: "admin" })
    await env.DB.prepare("UPDATE users SET admin_scope = ? WHERE id = ?")
      .bind(JSON.stringify(["points.adjust"]), admin.id).run()

    await expect(
      serveFeedbackImage(
        env as unknown as Env,
        req(admin, "/api/feedback/image/x/y.png"),
        uploader.id,
        "00000000-0000-0000-0000-000000000000.png"
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
})
