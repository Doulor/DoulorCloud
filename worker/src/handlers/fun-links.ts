import { ApiError, json } from "../http"
import { requireUser } from "../auth"
import { requireAdmin } from "./admin"
import { uuid } from "../crypto"
import { audit as recordAudit } from "../settings"
import type { Env } from "../env"

/**
 * 「有趣的网页分享」——工具箱里的一个精选外链列表。
 *
 * 与工具箱里其它工具不同，这个**不是纯前端**的：内容由站长在管理面板维护，
 * 所以要读库。列表很小（几十条），一次全量返回，不做分页。
 *
 * 安全：
 *   · 只接受 http / https（挡掉 `javascript:` / `data:` 这类被当成链接的注入）；
 *   · 普通用户只看得到 `enabled = 1` 的，下架的只有管理员看得到。
 */

/** 硬上限，防手滑灌进几千条把工具箱页拖慢 */
const MAX_LINKS = 500

/**
 * 分类白名单。**加分类要同步改前端的 `src/lib/fun-links.ts`**（两边的 label 映射）。
 * 库里存短键，中文只在界面上出现。
 */
const CATEGORIES = ["aesthetic", "tool", "ent"] as const
const DEFAULT_CATEGORY = "tool"

interface FunLinkRow {
  id: string
  title: string
  url: string
  description: string
  category: string
  icon_url: string
  sort_order: number
  enabled: number
  created_at: string
  updated_at: string
}

function toPublic(r: FunLinkRow) {
  return {
    id: r.id,
    title: r.title,
    url: r.url,
    description: r.description,
    // 库里如果有历史脏值（不属于白名单），一律按默认分类回给前端，避免界面出现空分类
    category: (CATEGORIES as readonly string[]).includes(r.category) ? r.category : DEFAULT_CATEGORY,
    /** 原始图标地址（可能为空）。前端不直接用它渲染，而是走 `/api/fun-links/icon/:id` 代理 */
    iconUrl: r.icon_url ?? "",
    sortOrder: r.sort_order,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** 只允许 http / https，且必须是合法 URL */
function normalizeUrl(raw: unknown): string {
  const s = String(raw ?? "").trim()
  if (!s) throw new ApiError(400, "链接不能为空", "INVALID_INPUT")
  let parsed: URL
  try {
    parsed = new URL(s)
  } catch {
    throw new ApiError(400, "链接格式不对（要带 http:// 或 https://）", "INVALID_INPUT")
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ApiError(400, "只支持 http / https 链接", "INVALID_INPUT")
  }
  return parsed.toString()
}

function normalizeTitle(raw: unknown): string {
  const s = String(raw ?? "").trim()
  if (!s) throw new ApiError(400, "名称不能为空", "INVALID_INPUT")
  return s.slice(0, 60)
}

function normalizeDescription(raw: unknown): string {
  return String(raw ?? "").trim().slice(0, 200)
}

function normalizeSort(raw: unknown, fallback: number): number {
  if (raw === undefined) return fallback
  const n = Math.trunc(Number(raw))
  return Number.isFinite(n) ? n : fallback
}

function normalizeEnabled(raw: unknown, fallback: number): number {
  if (raw === undefined) return fallback
  return raw ? 1 : 0
}

/** 分类只认白名单；没传就沿用原值（新增时落默认）。fallback 也一并清洗，防历史脏值卡住更新。 */
function normalizeCategory(raw: unknown, fallback: string): string {
  const allowed = CATEGORIES as readonly string[]
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return allowed.includes(fallback) ? fallback : DEFAULT_CATEGORY
  }
  const s = String(raw).trim()
  if (!allowed.includes(s)) {
    throw new ApiError(400, `分类只能是 ${CATEGORIES.join(" / ")}`, "INVALID_INPUT")
  }
  return s
}

/** 图标地址：允许留空（空 = 用首字母头像）；有值必须是 http / https */
function normalizeIconUrl(raw: unknown, fallback: string): string {
  if (raw === undefined) return fallback
  const s = String(raw).trim()
  if (!s) return ""
  let parsed: URL
  try {
    parsed = new URL(s)
  } catch {
    throw new ApiError(400, "图标地址格式不对（要带 http:// 或 https://）", "INVALID_INPUT")
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ApiError(400, "图标地址只支持 http / https", "INVALID_INPUT")
  }
  return parsed.toString().slice(0, 500)
}

/** GET /api/fun-links —— 登录用户可见，只回上架的 */
export async function listFunLinks(env: Env, request: Request): Promise<Response> {
  await requireUser(env, request)
  const rows = await env.DB.prepare(
    "SELECT * FROM fun_links WHERE enabled = 1 ORDER BY sort_order ASC, created_at ASC"
  ).all<FunLinkRow>()
  return json({ links: (rows.results ?? []).map(toPublic) })
}

/** GET /api/admin/fun-links —— 管理员看全部（含已下架） */
export async function adminListFunLinks(env: Env, request: Request): Promise<Response> {
  await requireAdmin(env, request)
  const rows = await env.DB.prepare(
    "SELECT * FROM fun_links ORDER BY sort_order ASC, created_at ASC"
  ).all<FunLinkRow>()
  return json({ links: (rows.results ?? []).map(toPublic) })
}

/** POST /api/admin/fun-links —— 新增一条 */
export async function createFunLink(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdmin(env, request)
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

  const count = await env.DB.prepare("SELECT COUNT(*) AS c FROM fun_links").first<{ c: number }>()
  if ((count?.c ?? 0) >= MAX_LINKS) {
    throw new ApiError(400, `最多只能放 ${MAX_LINKS} 条，先删几条再加`, "LIMIT_REACHED")
  }

  const id = uuid()
  const now = new Date().toISOString()
  const title = normalizeTitle(body.title)
  const url = normalizeUrl(body.url)
  const description = normalizeDescription(body.description)
  const category = normalizeCategory(body.category, DEFAULT_CATEGORY)
  const iconUrl = normalizeIconUrl(body.iconUrl, "")
  const sortOrder = normalizeSort(body.sortOrder, 0)
  const enabled = normalizeEnabled(body.enabled, 1)

  await env.DB.prepare(
    `INSERT INTO fun_links (id, title, url, description, category, icon_url, sort_order, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, title, url, description, category, iconUrl, sortOrder, enabled, now, now)
    .run()

  await recordAudit(
    env,
    admin.id,
    "admin.fun_links.create",
    `新增网页分享「${title}」`,
    request.headers.get("CF-Connecting-IP")
  )

  const row = await env.DB.prepare("SELECT * FROM fun_links WHERE id = ?")
    .bind(id)
    .first<FunLinkRow>()
  return json({ link: toPublic(row!) })
}

/** PUT /api/admin/fun-links/:id —— 修改（没传的字段保留原值） */
export async function updateFunLink(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireAdmin(env, request)

  const row = await env.DB.prepare("SELECT * FROM fun_links WHERE id = ?")
    .bind(id)
    .first<FunLinkRow>()
  if (!row) throw new ApiError(404, "这条分享不存在", "NOT_FOUND")

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

  const title = body.title === undefined ? row.title : normalizeTitle(body.title)
  const url = body.url === undefined ? row.url : normalizeUrl(body.url)
  const description =
    body.description === undefined ? row.description : normalizeDescription(body.description)
  const category = normalizeCategory(body.category, row.category)
  const iconUrl = normalizeIconUrl(body.iconUrl, row.icon_url ?? "")
  const sortOrder = normalizeSort(body.sortOrder, row.sort_order)
  const enabled = normalizeEnabled(body.enabled, row.enabled)

  await env.DB.prepare(
    `UPDATE fun_links SET title = ?, url = ?, description = ?, category = ?, icon_url = ?, sort_order = ?, enabled = ?, updated_at = ?
      WHERE id = ?`
  )
    .bind(title, url, description, category, iconUrl, sortOrder, enabled, new Date().toISOString(), id)
    .run()

  await recordAudit(
    env,
    admin.id,
    "admin.fun_links.update",
    `修改网页分享「${title}」`,
    request.headers.get("CF-Connecting-IP")
  )

  const updated = await env.DB.prepare("SELECT * FROM fun_links WHERE id = ?")
    .bind(id)
    .first<FunLinkRow>()
  return json({ link: toPublic(updated!) })
}

/** DELETE /api/admin/fun_links/:id —— 删除 */
export async function deleteFunLink(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireAdmin(env, request)

  const row = await env.DB.prepare("SELECT * FROM fun_links WHERE id = ?")
    .bind(id)
    .first<FunLinkRow>()
  if (!row) throw new ApiError(404, "这条分享不存在", "NOT_FOUND")

  await env.DB.prepare("DELETE FROM fun_links WHERE id = ?").bind(id).run()

  await recordAudit(
    env,
    admin.id,
    "admin.fun_links.delete",
    `删除网页分享「${row.title}」`,
    request.headers.get("CF-Connecting-IP")
  )

  return json({ ok: true })
}
