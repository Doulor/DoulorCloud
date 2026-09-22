import { ApiError, json } from "../http"
import { requireUser } from "../auth"
import { requireAdmin } from "./admin"
import { uuid } from "../crypto"
import type { Env } from "../env"

/**
 * 网站公告 / 动态。
 *
 * 用于概览页「网站动态」卡片：管理员发布（新增渠道、新模型、新节点、维护通知等），
 * 登录用户在概览页看到最近几条，pinned 优先。
 *
 * 不预建记录；管理员通过 POST /api/admin/announcements 创建。
 */

export const ANNOUNCEMENT_CATEGORIES = [
  "general",
  "frp",
  "ai",
  "proxy",
  "storage",
  "profile",
] as const

interface AnnouncementRow {
  id: string
  title: string
  body: string
  category: string
  pinned: number
  created_at: string
}

function toAnnouncement(r: AnnouncementRow) {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    category: r.category,
    pinned: r.pinned === 1,
    createdAt: r.created_at,
  }
}

/** GET /api/announcements —— 登录用户拉取最近公告（pinned 优先，按时间倒序） */
export async function listAnnouncements(
  env: Env,
  request: Request
): Promise<Response> {
  await requireUser(env, request)
  const rows = await env.DB.prepare(
    `SELECT * FROM announcements
     ORDER BY pinned DESC, created_at DESC
     LIMIT 5`
  ).all<AnnouncementRow>()
  return json({ announcements: (rows.results ?? []).map(toAnnouncement) })
}

// ---- 管理端（需 admin） ----

async function loadOne(env: Env, id: string): Promise<AnnouncementRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM announcements WHERE id = ?"
  )
    .bind(id)
    .first<AnnouncementRow>()
  if (!row) throw new ApiError(404, "公告不存在", "NOT_FOUND")
  return row
}

/** POST /api/admin/announcements —— 新建 */
export async function createAnnouncement(
  env: Env,
  request: Request
): Promise<Response> {
  await requireAdmin(env, request)
  const body = (await request.json()) as {
    title?: string
    body?: string
    category?: string
    pinned?: boolean
  }
  const title = (body.title ?? "").trim().slice(0, 100)
  const text = (body.body ?? "").trim().slice(0, 1000)
  if (!title || !text) {
    throw new ApiError(400, "标题和正文不能为空", "INVALID_INPUT")
  }
  const category =
    typeof body.category === "string" &&
    (ANNOUNCEMENT_CATEGORIES as readonly string[]).includes(body.category)
      ? body.category
      : "general"
  const id = uuid()
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO announcements (id, title, body, category, pinned, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, title, text, category, body.pinned ? 1 : 0, now)
    .run()
  return json({ announcement: toAnnouncement(await loadOne(env, id)) }, 201)
}

/** PUT /api/admin/announcements/:id —— 更新 */
export async function updateAnnouncement(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  await requireAdmin(env, request)
  const existing = await loadOne(env, id)
  const body = (await request.json()) as {
    title?: string
    body?: string
    category?: string
    pinned?: boolean
  }
  const title =
    body.title !== undefined ? (body.title as string).trim().slice(0, 100) : existing.title
  const text =
    body.body !== undefined ? (body.body as string).trim().slice(0, 1000) : existing.body
  const category =
    typeof body.category === "string" &&
    (ANNOUNCEMENT_CATEGORIES as readonly string[]).includes(body.category)
      ? body.category
      : existing.category
  const pinned = body.pinned !== undefined ? (body.pinned ? 1 : 0) : existing.pinned
  await env.DB.prepare(
    `UPDATE announcements SET title = ?, body = ?, category = ?, pinned = ? WHERE id = ?`
  )
    .bind(title, text, category, pinned, id)
    .run()
  return json({ announcement: toAnnouncement(await loadOne(env, id)) })
}

/** DELETE /api/admin/announcements/:id —— 删除 */
export async function deleteAnnouncement(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  await requireAdmin(env, request)
  await loadOne(env, id)
  await env.DB.prepare("DELETE FROM announcements WHERE id = ?").bind(id).run()
  return json({ ok: true })
}

/** GET /api/admin/announcements —— 管理端列表（全部，不限于 5 条） */
export async function listAllAnnouncements(
  env: Env,
  request: Request
): Promise<Response> {
  await requireAdmin(env, request)
  const rows = await env.DB.prepare(
    `SELECT * FROM announcements ORDER BY pinned DESC, created_at DESC LIMIT 100`
  ).all<AnnouncementRow>()
  return json({ announcements: (rows.results ?? []).map(toAnnouncement) })
}
