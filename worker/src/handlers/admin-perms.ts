/**
 * 管理员权限系统：权限树下发 + 权限组 CRUD + 成员管理权限读写。
 *
 * 守卫口径（2026-10-04 站长定）：
 *   - 看权限树：root / superadmin / admin 都能看（管理面板要用）。
 *   - 管权限组（建/改/删/套成员）：root 恒可；superadmin 需开关
 *     `superadmin_manage_permission_groups` 打开；admin 不可。
 *   - 成员管理权限（设角色/组/覆盖）：同上。
 */
import { ApiError, json } from "../http"
import { uuid } from "../crypto"
import { requireAdmin, resolveAdminScope } from "./admin"
import { isPrivileged } from "../auth"
import { getSettingBool, audit } from "../settings"
import {
  ADMIN_GROUPS,
  ADMIN_PERMISSIONS,
  parseAdminScope,
  isKnownPermissionKey,
} from "../admin-permissions"
import type { Env } from "../env"

/** 把字符串转成 SQL 单引号字面量（转义内部单引号）。不要用 JSON.stringify（双引号在 SQL 里语义不同） */
function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/** 规范化 scope：只保留合法 key、去重。白名单语义，过滤脏数据只会收紧不会放开。 */
function normalizeScope(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of input) {
    if (typeof item === "string" && isKnownPermissionKey(item) && !seen.has(item)) {
      seen.add(item)
      out.push(item)
    }
  }
  return out
}

/** 守卫：root 恒可；superadmin 需开关；admin 不可 */
async function requireGroupManager(env: Env, request: Request) {
  const admin = await requireAdmin(env, request)
  if (isPrivileged(admin.role) && admin.role !== "superadmin") return admin // root
  if (admin.role === "superadmin") {
    if (await getSettingBool(env, "superadmin_manage_permission_groups")) return admin
    throw new ApiError(403, "超级管理员管理权限组的功能未开启", "FORBIDDEN")
  }
  throw new ApiError(403, "只有站长或超级管理员可以管理权限组", "FORBIDDEN")
}

/** GET /api/admin/permissions/tree —— 权限树 + 当前用户权限（供前端渲染勾选界面 + 侧边栏过滤） */
export async function getPermissionTree(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdmin(env, request)
  let myScope: string[]
  if (isPrivileged(admin.role)) {
    // root / superadmin 全权：返回全部叶子 key
    myScope = []
    for (const cat of ADMIN_PERMISSIONS) {
      if (cat.children && cat.children.length > 0) myScope.push(...cat.children.map((l) => l.key))
      else myScope.push(cat.key)
    }
  } else {
    myScope = Array.from(await resolveAdminScope(env, admin))
  }
  const sidebarOnly = await getSettingBool(env, "admin_sidebar_only_permitted")
  return json({
    groups: ADMIN_GROUPS,
    categories: ADMIN_PERMISSIONS,
    myScope,
    sidebarOnlyPermitted: sidebarOnly,
  })
}

/** GET /api/admin/permission-groups —— 列出权限组（含成员数） */
export async function listPermissionGroups(env: Env, request: Request): Promise<Response> {
  await requireGroupManager(env, request)
  const rows = await env.DB.prepare(
    `SELECT g.id, g.name, g.scope, g.created_at,
            (SELECT COUNT(*) FROM users u WHERE u.admin_role_id = g.id) AS member_count
       FROM admin_roles g ORDER BY g.created_at ASC`
  ).all<{ id: string; name: string; scope: string; created_at: string; member_count: number }>()

  // 一次性取所有组的所有成员（用户名 + 是否自定义覆盖），前端图形化展示
  const members = await env.DB.prepare(
    `SELECT admin_role_id, username, nickname, admin_scope FROM users
      WHERE admin_role_id IS NOT NULL AND role IN ('user','admin')`
  ).all<{ admin_role_id: string; username: string; nickname: string | null; admin_scope: string | null }>()
  const memberMap = new Map<string, { username: string; custom: boolean }[]>()
  for (const m of members.results ?? []) {
    const custom = Boolean(m.admin_scope && m.admin_scope.trim() !== "" && m.admin_scope.trim() !== "[]")
    const list = memberMap.get(m.admin_role_id) ?? []
    list.push({ username: m.username, custom })
    memberMap.set(m.admin_role_id, list)
  }

  const groups = (rows.results ?? []).map((g) => ({
    id: g.id,
    name: g.name,
    scope: parseAdminScope(g.scope) ? Array.from(parseAdminScope(g.scope)) : [],
    memberCount: g.member_count ?? 0,
    members: memberMap.get(g.id) ?? [],
    createdAt: g.created_at,
  }))
  return json({ groups })
}

/** POST /api/admin/permission-groups —— 创建权限组 */
export async function createPermissionGroup(env: Env, request: Request): Promise<Response> {
  const admin = await requireGroupManager(env, request)
  const body = (await request.json().catch(() => ({}))) as { name?: unknown; scope?: unknown }
  const name = String(body.name ?? "").trim()
  if (!name) throw new ApiError(400, "请填写权限组名称", "INVALID_INPUT")
  if (name.length > 40) throw new ApiError(400, "权限组名称过长", "INVALID_INPUT")
  const scope = normalizeScope(body.scope)
  const now = new Date().toISOString()
  const id = uuid()
  await env.DB.prepare(
    "INSERT INTO admin_roles (id, name, scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(id, name, JSON.stringify(scope), now, now)
    .run()
  await audit(env, admin.id, "admin.perm_group.create", `创建权限组「${name}」`)
  return json({ id, name, scope }, 201)
}

/** PUT /api/admin/permission-groups/:id —— 更新权限组 */
export async function updatePermissionGroup(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireGroupManager(env, request)
  const body = (await request.json().catch(() => ({}))) as { name?: unknown; scope?: unknown }
  const existing = await env.DB.prepare("SELECT id FROM admin_roles WHERE id = ?").bind(id).first()
  if (!existing) throw new ApiError(404, "权限组不存在", "NOT_FOUND")
  const name = body.name === undefined ? undefined : String(body.name).trim()
  if (name !== undefined && (!name || name.length > 40)) {
    throw new ApiError(400, "权限组名称无效", "INVALID_INPUT")
  }
  const scope = body.scope === undefined ? undefined : normalizeScope(body.scope)
  if (name !== undefined && scope !== undefined) {
    await env.DB.prepare("UPDATE admin_roles SET name = ?, scope = ?, updated_at = ? WHERE id = ?")
      .bind(name, JSON.stringify(scope), new Date().toISOString(), id).run()
  } else if (name !== undefined) {
    await env.DB.prepare("UPDATE admin_roles SET name = ?, updated_at = ? WHERE id = ?")
      .bind(name, new Date().toISOString(), id).run()
  } else if (scope !== undefined) {
    await env.DB.prepare("UPDATE admin_roles SET scope = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(scope), new Date().toISOString(), id).run()
  }
  await audit(env, admin.id, "admin.perm_group.update", `更新权限组 ${id}`)
  return json({ ok: true })
}

/** DELETE /api/admin/permission-groups/:id —— 删除权限组（成员自动脱离） */
export async function deletePermissionGroup(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireGroupManager(env, request)
  const existing = await env.DB.prepare("SELECT name FROM admin_roles WHERE id = ?").bind(id).first<{ name: string }>()
  if (!existing) throw new ApiError(404, "权限组不存在", "NOT_FOUND")
  await env.DB.batch([
    env.DB.prepare("DELETE FROM admin_roles WHERE id = ?").bind(id),
    env.DB.prepare("UPDATE users SET admin_role_id = NULL WHERE admin_role_id = ?").bind(id),
  ])
  await audit(env, admin.id, "admin.perm_group.delete", `删除权限组「${existing.name}」`)
  return json({ ok: true })
}

/** POST /api/admin/permission-groups/:id/members —— 批量把成员挂到该组 */
export async function addGroupMembers(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireGroupManager(env, request)
  const existing = await env.DB.prepare("SELECT id FROM admin_roles WHERE id = ?").bind(id).first()
  if (!existing) throw new ApiError(404, "权限组不存在", "NOT_FOUND")
  const body = (await request.json().catch(() => ({}))) as { userIds?: unknown }
  const ids = Array.isArray(body.userIds)
    ? body.userIds.filter((x): x is string => typeof x === "string").slice(0, 200)
    : []
  if (ids.length === 0) throw new ApiError(400, "未选择成员", "INVALID_INPUT")
  const ph = ids.map(() => "?").join(",")
  // 只把普通用户（role IN user/admin）挂到组，且不覆盖他们已有的自定义 admin_scope
  const result = await env.DB.prepare(
    `UPDATE users SET admin_role_id = ? WHERE id IN (${ph}) AND role IN ('user', 'admin')`
  )
    .bind(id, ...ids)
    .run()
  await audit(env, admin.id, "admin.perm_group.members", `给权限组 ${id} 添加 ${result.meta?.changes ?? 0} 名成员`)
  return json({ added: result.meta?.changes ?? 0 })
}

/** GET /api/admin/users/:username/admin-permissions —— 查成员的当前管理权限 */
export async function getUserAdminPermissions(
  env: Env,
  request: Request,
  username: string
): Promise<Response> {
  await requireGroupManager(env, request)
  const row = await env.DB.prepare(
    "SELECT id, username, role, admin_role_id, admin_scope FROM users WHERE username = ? COLLATE NOCASE"
  )
    .bind(username)
    .first<{ id: string; username: string; role: string; admin_role_id: string | null; admin_scope: string | null }>()
  if (!row) throw new ApiError(404, "用户不存在", "NOT_FOUND")
  const roleName = row.admin_role_id
    ? (await env.DB.prepare("SELECT name FROM admin_roles WHERE id = ?").bind(row.admin_role_id).first<{ name: string }>())?.name ?? null
    : null
  return json({
    userId: row.id,
    username: row.username,
    role: row.role ?? "user",
    adminRoleId: row.admin_role_id,
    adminRoleName: roleName,
    adminScope: parseAdminScope(row.admin_scope) ? Array.from(parseAdminScope(row.admin_scope)) : [],
    // 自定义标记：admin_scope 非空 = 覆盖了权限组
    custom: Boolean(row.admin_scope && row.admin_scope.trim() !== "" && row.admin_scope.trim() !== "[]"),
  })
}

/** PUT /api/admin/users/:username/admin-permissions —— 设置成员的管理权限 */
export async function setUserAdminPermissions(
  env: Env,
  request: Request,
  username: string
): Promise<Response> {
  const operator = await requireGroupManager(env, request)
  const body = (await request.json().catch(() => ({}))) as {
    role?: unknown
    adminRoleId?: unknown
    adminScope?: unknown
  }

  const target = await env.DB.prepare(
    "SELECT id, username, role FROM users WHERE username = ? COLLATE NOCASE"
  )
    .bind(username)
    .first<{ id: string; username: string; role: string }>()
  if (!target) throw new ApiError(404, "用户不存在", "NOT_FOUND")

  // root 账户的管理权限不可被 superadmin 改
  if (target.role === "root" && operator.role !== "root") {
    throw new ApiError(403, "站长账户不可被修改", "FORBIDDEN")
  }

  let role: string | null = null
  if (body.role !== undefined) {
    role = String(body.role)
    if (!["user", "admin", "superadmin", "root"].includes(role)) {
      throw new ApiError(400, "无效的角色", "INVALID_INPUT")
    }
    if (role === "superadmin" && operator.role !== "root") {
      throw new ApiError(403, "只有站长可以授予超级管理员", "FORBIDDEN")
    }
    if (role === "root" && operator.role !== "root") {
      throw new ApiError(403, "只有站长可以授予站长角色", "FORBIDDEN")
    }
  }

  let adminRoleId: string | null | undefined
  if (body.adminRoleId !== undefined) {
    adminRoleId = body.adminRoleId === null || body.adminRoleId === "" ? null : String(body.adminRoleId)
    if (adminRoleId) {
      const grp = await env.DB.prepare("SELECT id FROM admin_roles WHERE id = ?").bind(adminRoleId).first()
      if (!grp) throw new ApiError(400, "权限组不存在", "INVALID_INPUT")
    }
  }

  let adminScope: string | null | undefined
  if (body.adminScope !== undefined) {
    const scope = normalizeScope(body.adminScope)
    // 空数组 → 存 NULL（= 纯引用组，不算自定义）
    adminScope = scope.length > 0 ? JSON.stringify(scope) : null
  }

  // 降级为 user 时，清空组与覆盖
  if (role === "user") {
    adminRoleId = null
    adminScope = null
  }

  const now = new Date().toISOString()
  const setRole = role ? `role = ${sqlStr(role)}` : ""
  const setRoleId = adminRoleId !== undefined ? `admin_role_id = ${adminRoleId === null ? "NULL" : sqlStr(adminRoleId)}` : ""
  const setScope = adminScope !== undefined ? `admin_scope = ${adminScope === null ? "NULL" : sqlStr(adminScope)}` : ""
  const sets = [setRole, setRoleId, setScope].filter(Boolean)
  if (sets.length > 0) {
    await env.DB.prepare(`UPDATE users SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`)
      .bind(now, target.id)
      .run()
  }
  await audit(env, operator.id, "admin.perm.set", `设置 ${target.username} 的管理权限（role=${role ?? "不变"}）`)
  return json({ ok: true })
}
