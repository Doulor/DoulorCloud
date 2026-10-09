/**
 * AI 实验室的「系统提示词模板」。
 *
 * 这里同时管两件事，刻意放在同一个文件里，因为它们共用同一套清洗规则：
 *   · **管理端 CRUD**（`/api/admin/lab/templates*`）—— 存多份、自由启停；
 *   · **用户端读取**（`getLabSettings` 调用 `loadEnabledTemplates`）—— 只拿启用中的。
 *
 * 为什么单独成表而不是塞进 `app_settings`：
 *   模板正文动辄几千字、还要存名字与启用状态，塞进一个 JSON 字符串里
 *   既不好增量改、也没法按启用状态建索引。
 *
 * 与 `app_settings.lab_agent_prompt` 的关系见迁移 `0140` 的注释：
 * 有启用中的模板就用模板，一个都没有才退回那个旧覆盖值（升级不突变）。
 */
import { ApiError, json } from "../http"
import { requireAdminScope } from "./admin"
import { audit as recordAudit } from "../settings"
import { uuid } from "../crypto"
import type { Env } from "../env"

/** 模板名上限（要显示在用户端的切换按钮上，太长会撑坏工具栏） */
export const PROMPT_NAME_MAX = 40
/** 正文上限：与旧的 `AGENT_PROMPT_MAX` 同量级，防误粘超长内容 */
export const PROMPT_CONTENT_MAX = 60_000
/** 最多存几份模板 —— 只是防滥用，正常用不到 */
export const PROMPT_TEMPLATES_MAX = 20
/** 下发给用户端的启用模板数量上限（正文不小，别一次推几十份） */
export const ENABLED_TEMPLATES_MAX = 10

export interface LabPromptTemplateRow {
  id: string
  name: string
  content: string
  enabled: number
  sort_order: number
  created_at: string
  updated_at: string
}

/** 给管理面板看的形状（带正文，管理端本来就要编辑它） */
function toAdminJson(row: LabPromptTemplateRow) {
  return {
    id: row.id,
    name: row.name,
    content: row.content,
    enabled: !!row.enabled,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** 给用户端的形状：只要切换所需的 id/名字 + 正文 */
export interface LabPromptTemplatePublic {
  id: string
  name: string
  content: string
}

/**
 * 读「启用中」的模板，按 sort_order 排。
 * 用户端建系统提示词时用它挑一份；一份都没有时调用方回退到旧逻辑。
 */
export async function loadEnabledTemplates(env: Env): Promise<LabPromptTemplatePublic[]> {
  const rows = await env.DB.prepare(
    `SELECT id, name, content FROM lab_prompt_templates
     WHERE enabled = 1
     ORDER BY sort_order ASC, created_at ASC
     LIMIT ?`
  )
    .bind(ENABLED_TEMPLATES_MAX)
    .all<{ id: string; name: string; content: string }>()
  return (rows.results ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    content: r.content,
  }))
}

/** 清洗名字：去首尾空白、截断；空名直接拒（切换按钮上没法显示空标签） */
function cleanName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim().slice(0, PROMPT_NAME_MAX) : ""
  if (!name) throw new ApiError(400, "给模板起个名字", "INVALID_NAME")
  return name
}

/** 清洗正文：空正文没有意义（等于没有提示词），直接拒 */
function cleanContent(raw: unknown): string {
  const text = typeof raw === "string" ? raw : ""
  if (!text.trim()) throw new ApiError(400, "模板内容不能为空", "INVALID_CONTENT")
  return text.slice(0, PROMPT_CONTENT_MAX)
}

/** GET /api/admin/lab/templates —— 全部模板（含未启用） */
export async function listPromptTemplates(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "lab")
  const rows = await env.DB.prepare(
    `SELECT * FROM lab_prompt_templates ORDER BY sort_order ASC, created_at ASC`
  ).all<LabPromptTemplateRow>()
  return json({ templates: (rows.results ?? []).map(toAdminJson) })
}

/** POST /api/admin/lab/templates —— 新建（默认不启用） */
export async function createPromptTemplate(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "lab")
  const body = (await request.json().catch(() => null)) as
    | { name?: unknown; content?: unknown; enabled?: unknown }
    | null
  if (!body) throw new ApiError(400, "请求体格式错误", "INVALID_BODY")

  const name = cleanName(body.name)
  const content = cleanContent(body.content)

  const count =
    (await env.DB.prepare("SELECT COUNT(*) AS c FROM lab_prompt_templates").first<{ c: number }>())
      ?.c ?? 0
  if (count >= PROMPT_TEMPLATES_MAX) {
    throw new ApiError(400, `最多只能存 ${PROMPT_TEMPLATES_MAX} 份模板`, "TOO_MANY_TEMPLATES")
  }

  const now = new Date().toISOString()
  const id = uuid()
  const nextOrder =
    (await env.DB.prepare(
      "SELECT COALESCE(MAX(sort_order), 0) AS m FROM lab_prompt_templates"
    ).first<{ m: number }>())?.m ?? 0

  await env.DB.prepare(
    `INSERT INTO lab_prompt_templates
       (id, name, content, enabled, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, name, content, body.enabled === true ? 1 : 0, nextOrder + 1, now, now)
    .run()

  await recordAudit(env, admin.id, "admin.lab_template", `新建提示词模板「${name}」`)
  const row = await env.DB.prepare("SELECT * FROM lab_prompt_templates WHERE id = ?")
    .bind(id)
    .first<LabPromptTemplateRow>()
  return json({ template: row ? toAdminJson(row) : null }, 201)
}

/** PUT /api/admin/lab/templates/:id —— 改名字 / 正文 / 启用状态 */
export async function updatePromptTemplate(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireAdminScope(env, request, "lab")
  const body = (await request.json().catch(() => null)) as
    | { name?: unknown; content?: unknown; enabled?: unknown }
    | null
  if (!body) throw new ApiError(400, "请求体格式错误", "INVALID_BODY")

  const existing = await env.DB.prepare("SELECT * FROM lab_prompt_templates WHERE id = ?")
    .bind(id)
    .first<LabPromptTemplateRow>()
  if (!existing) throw new ApiError(404, "模板不存在", "NOT_FOUND")

  const sets: string[] = []
  const binds: unknown[] = []
  const changed: string[] = []

  if ("name" in body) {
    const name = cleanName(body.name)
    sets.push("name = ?")
    binds.push(name)
    changed.push("改名字")
  }
  if ("content" in body) {
    const content = cleanContent(body.content)
    sets.push("content = ?")
    binds.push(content)
    changed.push("改正文")
  }
  if ("enabled" in body) {
    const on = body.enabled === true
    sets.push("enabled = ?")
    binds.push(on ? 1 : 0)
    changed.push(on ? "启用" : "停用")
  }
  if (!sets.length) return json({ template: toAdminJson(existing) })

  sets.push("updated_at = ?")
  binds.push(new Date().toISOString())
  binds.push(id)
  await env.DB.prepare(
    `UPDATE lab_prompt_templates SET ${sets.join(", ")} WHERE id = ?`
  )
    .bind(...binds)
    .run()

  await recordAudit(
    env,
    admin.id,
    "admin.lab_template",
    `提示词模板「${existing.name}」：${changed.join("、")}`
  )
  const row = await env.DB.prepare("SELECT * FROM lab_prompt_templates WHERE id = ?")
    .bind(id)
    .first<LabPromptTemplateRow>()
  return json({ template: row ? toAdminJson(row) : null })
}

/** DELETE /api/admin/lab/templates/:id —— 删掉一份模板 */
export async function deletePromptTemplate(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireAdminScope(env, request, "lab")
  const existing = await env.DB.prepare("SELECT * FROM lab_prompt_templates WHERE id = ?")
    .bind(id)
    .first<LabPromptTemplateRow>()
  if (!existing) throw new ApiError(404, "模板不存在", "NOT_FOUND")

  await env.DB.prepare("DELETE FROM lab_prompt_templates WHERE id = ?").bind(id).run()
  await recordAudit(env, admin.id, "admin.lab_template", `删除提示词模板「${existing.name}」`)
  return new Response(null, { status: 204 })
}
