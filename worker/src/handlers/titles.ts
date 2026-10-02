import { ApiError, json } from "../http"
import { requireAdmin } from "./admin"
import { requireUser } from "../auth"
import { uuid } from "../crypto"
import { audit as recordAudit } from "../settings"
import type { Env } from "../env"

/**
 * 自定义称号（徽章式）—— 样式对标管理员/站长的 RoleBadge，但与 role 解耦：
 * 站长在管理面板创建称号（名称 + 渐变双色），授予指定用户，
 * 在社区帖子/评论、个人空间、头像悬浮卡片三处与 RoleBadge 并排展示。
 *
 * 数据模型见 migrations/0086_custom_titles.sql：
 *   custom_titles = 称号库（多人可共用一个称号）；
 *   user_titles   = 授予关系，user_id 是主键 ⇒ 一人最多一个自定义称号。
 *
 * 颜色约定：#RRGGBB 六位 hex。文字黑/白与描边流光色由前端按亮度自动衍生，
 * 库里只存 color_from / color_to 两个主色。
 */

/** 每用户最多一个自定义称号由表结构（user_id 主键）保证；称号总数防手滑灌库 */
const MAX_TITLES = 200

export interface TitleRow {
  id: string
  name: string
  color_from: string
  color_to: string
  created_at: string
}

/** 校验 #RRGGBB（大小写不敏感，统一回存小写） */
function normalizeColor(raw: unknown, fallback?: string): string {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    if (fallback !== undefined) return fallback
    throw new ApiError(400, "颜色不能为空", "INVALID_INPUT")
  }
  const s = String(raw).trim()
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) {
    throw new ApiError(400, "颜色格式不对（要 #RRGGBB 六位十六进制）", "INVALID_INPUT")
  }
  return s.toLowerCase()
}

function normalizeName(raw: unknown, fallback?: string): string {
  if (raw === undefined || raw === null) {
    if (fallback !== undefined) return fallback
    throw new ApiError(400, "称号名称不能为空", "INVALID_INPUT")
  }
  const s = String(raw).trim()
  if (!s) {
    if (fallback !== undefined) return fallback
    throw new ApiError(400, "称号名称不能为空", "INVALID_INPUT")
  }
  return s.slice(0, 20)
}

/**
 * 查单个用户当前的自定义称号（space / 卡片等单用户场景用）。
 * 没有就回 null。字段名带 title_ 前缀，与批量 JOIN 查询保持一致。
 */
export async function getTitleForUser(env: Env, userId: string) {
  const row = await env.DB.prepare(
    `SELECT ct.name AS title_name, ct.color_from AS title_color_from, ct.color_to AS title_color_to
       FROM user_titles ut JOIN custom_titles ct ON ct.id = ut.title_id
      WHERE ut.user_id = ? AND ut.is_display = 1
      LIMIT 1`
  )
    .bind(userId)
    .first<{ title_name: string; title_color_from: string; title_color_to: string }>()
  return row
    ? { name: row.title_name, colorFrom: row.title_color_from, colorTo: row.title_color_to }
    : null
}

/** 按用户名找用户（授予/收回用）；不存在报 404 */
async function loadTargetUser(env: Env, username: string) {
  const row = await env.DB.prepare(
    "SELECT id, username, nickname FROM users WHERE username = ? COLLATE NOCASE"
  )
    .bind(username)
    .first<{ id: string; username: string; nickname: string | null }>()
  if (!row) throw new ApiError(404, "用户不存在", "NOT_FOUND")
  return row
}

/** GET /api/admin/titles —— 称号列表 + 每个称号的持有者（管理面板用） */
export async function listTitles(env: Env, request: Request): Promise<Response> {
  await requireAdmin(env, request)

  const [titles, grants] = await Promise.all([
    env.DB.prepare(
      "SELECT * FROM custom_titles ORDER BY created_at ASC"
    ).all<TitleRow>(),
    env.DB.prepare(
      `SELECT ut.user_id, ut.title_id, ut.granted_at, u.username, u.nickname, u.role
         FROM user_titles ut JOIN users u ON u.id = ut.user_id
        ORDER BY ut.granted_at ASC`
    ).all<{
      user_id: string
      title_id: string
      granted_at: string
      username: string
      nickname: string | null
      role: string
    }>(),
  ])

  const byTitle = new Map<string, { userId: string; username: string; nickname: string | null; role: string; grantedAt: string }[]>()
  for (const g of grants.results ?? []) {
    const list = byTitle.get(g.title_id) ?? []
    list.push({
      userId: g.user_id,
      username: g.username,
      nickname: g.nickname,
      role: g.role,
      grantedAt: g.granted_at,
    })
    byTitle.set(g.title_id, list)
  }

  return json({
    titles: (titles.results ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      colorFrom: t.color_from,
      colorTo: t.color_to,
      createdAt: t.created_at,
      holders: byTitle.get(t.id) ?? [],
    })),
  })
}

/** POST /api/admin/titles —— 创建称号 */
export async function createTitle(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdmin(env, request)
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

  const count = await env.DB.prepare("SELECT COUNT(*) AS c FROM custom_titles").first<{ c: number }>()
  if ((count?.c ?? 0) >= MAX_TITLES) {
    throw new ApiError(400, `最多只能放 ${MAX_TITLES} 个称号，先删几个再加`, "LIMIT_REACHED")
  }

  const name = normalizeName(body.name)
  const colorFrom = normalizeColor(body.colorFrom)
  const colorTo = normalizeColor(body.colorTo)

  const id = uuid()
  await env.DB.prepare(
    "INSERT INTO custom_titles (id, name, color_from, color_to, created_at) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(id, name, colorFrom, colorTo, new Date().toISOString())
    .run()

  await recordAudit(
    env,
    admin.id,
    "admin.titles.create",
    `创建自定义称号「${name}」`,
    request.headers.get("CF-Connecting-IP")
  )

  return json({ title: { id, name, colorFrom, colorTo, createdAt: new Date().toISOString(), holders: [] } })
}

/** PUT /api/admin/titles/:id —— 修改（没传的字段保留原值） */
export async function updateTitle(env: Env, request: Request, id: string): Promise<Response> {
  const admin = await requireAdmin(env, request)

  const row = await env.DB.prepare("SELECT * FROM custom_titles WHERE id = ?")
    .bind(id)
    .first<TitleRow>()
  if (!row) throw new ApiError(404, "这个称号不存在", "NOT_FOUND")

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const name = normalizeName(body.name, row.name)
  const colorFrom = normalizeColor(body.colorFrom, row.color_from)
  const colorTo = normalizeColor(body.colorTo, row.color_to)

  await env.DB.prepare(
    "UPDATE custom_titles SET name = ?, color_from = ?, color_to = ? WHERE id = ?"
  )
    .bind(name, colorFrom, colorTo, id)
    .run()

  await recordAudit(
    env,
    admin.id,
    "admin.titles.update",
    `修改自定义称号「${name}」`,
    request.headers.get("CF-Connecting-IP")
  )

  return json({ ok: true })
}

/** DELETE /api/admin/titles/:id —— 删除（授予关系一并清掉，不依赖 FK） */
export async function deleteTitle(env: Env, request: Request, id: string): Promise<Response> {
  const admin = await requireAdmin(env, request)

  const row = await env.DB.prepare("SELECT * FROM custom_titles WHERE id = ?")
    .bind(id)
    .first<TitleRow>()
  if (!row) throw new ApiError(404, "这个称号不存在", "NOT_FOUND")

  await env.DB.batch([
    env.DB.prepare("DELETE FROM user_titles WHERE title_id = ?").bind(id),
    env.DB.prepare("DELETE FROM custom_titles WHERE id = ?").bind(id),
  ])

  await recordAudit(
    env,
    admin.id,
    "admin.titles.delete",
    `删除自定义称号「${row.name}」`,
    request.headers.get("CF-Connecting-IP")
  )

  return json({ ok: true })
}

/**
 * POST /api/admin/titles/:id/grant { username } —— 授予。
 * 覆盖式：用户已有其它自定义称号会被顶掉（一人一称号是表结构保证的硬约束）。
 */
/**
 * 若该用户当前没有任何「展示中」的称号，就把最早获得的一个设为展示。
 * 收回称号 / 用户手动取消展示后调用，避免出现「有称号却什么都不显示」的空窗。
 */
async function promoteIfNothingDisplayed(env: Env, userId: string): Promise<void> {
  const shown = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM user_titles WHERE user_id = ? AND is_display = 1"
  )
    .bind(userId)
    .first<{ c: number }>()
  if ((shown?.c ?? 0) > 0) return
  await env.DB.prepare(
    `UPDATE user_titles SET is_display = 1
      WHERE user_id = ?
        AND title_id = (SELECT title_id FROM user_titles WHERE user_id = ?
                         ORDER BY granted_at ASC LIMIT 1)`
  )
    .bind(userId, userId)
    .run()
}

/**
 * GET /api/titles/mine —— 我持有的**全部**称号（2026-10-01 加）。
 *
 * 个人空间里要列出来让用户自己挑「对外展示哪一个」，所以这里必须返回全部，
 * 并标出哪个正在展示。
 */
export async function listMyTitles(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const rows = await env.DB.prepare(
    `SELECT ct.id, ct.name, ct.color_from, ct.color_to, ut.is_display, ut.granted_at
       FROM user_titles ut JOIN custom_titles ct ON ct.id = ut.title_id
      WHERE ut.user_id = ?
      ORDER BY ut.is_display DESC, ut.granted_at ASC`
  )
    .bind(user.id)
    .all<{
      id: string
      name: string
      color_from: string
      color_to: string
      is_display: number
      granted_at: string
    }>()
  return json({
    titles: (rows.results ?? []).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      colorFrom: String(r.color_from),
      colorTo: String(r.color_to),
      isDisplay: Boolean(r.is_display),
      grantedAt: String(r.granted_at),
    })),
  })
}

/**
 * POST /api/titles/display —— 把某个称号设为对外展示；`{ titleId: null }` = 一个都不展示。
 *
 * 只能设置**自己持有**的称号：先清掉自己的 is_display，再把目标标上。
 * 两步都是 `WHERE user_id = 我`，拿别人的 titleId 也只会把自己的清空，不会越权。
 */
export async function setDisplayedTitle(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const titleId = typeof body.titleId === "string" && body.titleId ? body.titleId : null

  if (titleId) {
    const owned = await env.DB.prepare(
      "SELECT 1 AS x FROM user_titles WHERE user_id = ? AND title_id = ?"
    )
      .bind(user.id, titleId)
      .first()
    if (!owned) throw new ApiError(403, "你没有这个称号", "FORBIDDEN")
  }

  // 先全部清掉（保证「展示中」唯一；部分唯一索引也兜底）
  await env.DB.prepare("UPDATE user_titles SET is_display = 0 WHERE user_id = ?")
    .bind(user.id)
    .run()
  if (titleId) {
    await env.DB.prepare(
      "UPDATE user_titles SET is_display = 1 WHERE user_id = ? AND title_id = ?"
    )
      .bind(user.id, titleId)
      .run()
  }
  return json({ ok: true, titleId })
}

export async function grantTitle(env: Env, request: Request, id: string): Promise<Response> {
  const admin = await requireAdmin(env, request)

  const title = await env.DB.prepare("SELECT * FROM custom_titles WHERE id = ?")
    .bind(id)
    .first<TitleRow>()
  if (!title) throw new ApiError(404, "这个称号不存在", "NOT_FOUND")

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const username = String(body.username ?? "").trim()
  if (!username) throw new ApiError(400, "用户名不能为空", "INVALID_INPUT")
  const target = await loadTargetUser(env, username)

  // 一人可持多个称号（2026-10-01 改）。若他当前没有任何「展示中」的称号，
  // 就把新授的这个设为展示 —— 否则用户会「拿到了称号却什么都没显示」，莫名其妙。
  const shown = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM user_titles WHERE user_id = ? AND is_display = 1"
  )
    .bind(target.id)
    .first<{ c: number }>()
  const isDisplay = (shown?.c ?? 0) === 0

  await env.DB.prepare(
    `INSERT INTO user_titles (user_id, title_id, is_display, granted_by, granted_at)
     VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, title_id) DO UPDATE SET
         granted_by = excluded.granted_by, granted_at = excluded.granted_at`
  )
    .bind(target.id, id, isDisplay ? 1 : 0, admin.id, new Date().toISOString())
    .run()

  await recordAudit(
    env,
    admin.id,
    "admin.titles.grant",
    `把自定义称号「${title.name}」授予 ${target.username}`,
    request.headers.get("CF-Connecting-IP")
  )

  return json({ ok: true })
}

/** POST /api/admin/titles/:id/revoke { username } —— 收回 */
export async function revokeTitle(env: Env, request: Request, id: string): Promise<Response> {
  const admin = await requireAdmin(env, request)

  const title = await env.DB.prepare("SELECT * FROM custom_titles WHERE id = ?")
    .bind(id)
    .first<TitleRow>()
  if (!title) throw new ApiError(404, "这个称号不存在", "NOT_FOUND")

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const username = String(body.username ?? "").trim()
  if (!username) throw new ApiError(400, "用户名不能为空", "INVALID_INPUT")
  const target = await loadTargetUser(env, username)

  const res = await env.DB.prepare(
    "DELETE FROM user_titles WHERE user_id = ? AND title_id = ?"
  )
    .bind(target.id, id)
    .run()

  if (!res.meta.changes) {
    throw new ApiError(404, `${target.username} 没有持有这个称号`, "NOT_FOUND")
  }

  // 收回的若是「展示中」的那个，自动把剩下最早获得的一个顶上去
  //（否则用户会变成「有称号但一个都不显示」）
  await promoteIfNothingDisplayed(env, target.id)

  await recordAudit(
    env,
    admin.id,
    "admin.titles.revoke",
    `收回 ${target.username} 的自定义称号「${title.name}」`,
    request.headers.get("CF-Connecting-IP")
  )

  return json({ ok: true })
}
