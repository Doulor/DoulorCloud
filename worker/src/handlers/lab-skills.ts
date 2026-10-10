/**
 * AI 实验室的「技能（skills）」。
 *
 * 触发方式是**渐进式披露**（站长 2026-10-10 确认，同主流 agent）：
 *   1. 系统提示里只放 `name + description`（一句话），用来让模型判断「这活该不该用某个技能」；
 *   2. 模型判断相关时输出 `<lab_skill name="…"/>`；
 *   3. 循环把该技能的**正文**作为工具结果回喂（见 handlers/lab.ts 与 pages/lab.tsx）。
 *
 * 为什么不把正文直接塞进系统提示：技能一多，提示词会被几十份说明书撑爆，
 * 模型在无关任务上还会被干扰；而且每轮都要为这些不用的正文付 token。
 *
 * 归属（`lab_skills.owner_user_id`）：
 *   · NULL   = **站点默认技能**：管理面板维护（`/api/admin/lab/skills*`），所有人可用；
 *   · 非 NULL = 用户自己导入（`/api/lab/skills*`），只有他自己看得见。
 * 两张来源在查询上永远合成「站点默认 ∪ 我的」，所以共用一张表（见迁移 0141）。
 */
import { ApiError, json } from "../http"
import { requireUser } from "../auth"
import { requireAdminScope } from "./admin"
import { audit as recordAudit } from "../settings"
import { uuid } from "../crypto"
import type { Env } from "../env"

/** 技能标识符上限：模型要反复引用它，越短越好 */
export const SKILL_NAME_MAX = 64
/** 一句话说明上限：**这段会进系统提示**，太长就失去「省 token」的意义了 */
export const SKILL_DESC_MAX = 200
/**
 * 正文上限。
 * ⚠️ 比提示词模板的 60KB 更宽：技能正文**只在模型主动读时才进上下文**（渐进式披露），
 *    所以「长」本身不是问题；而网上现成的技能（比如 taste-skill）单份就有 80KB+，
 *    卡在 60KB 会让管理员复制进去之后**存不上**，且报错很难懂。
 */
export const SKILL_CONTENT_MAX = 200_000
/** 单个归属下最多存几个技能 */
export const SKILLS_MAX = 30
/** 下发给用户端的技能索引条数上限（每条只占一行，可以比模板多一些） */
export const SKILL_INDEX_MAX = 60

export interface LabSkillRow {
  id: string
  scope: string
  name: string
  description: string
  content: string
  enabled: number
  owner_user_id: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

/**
 * 标识符清洗：只允许小写字母/数字/短横线，且以字母或数字开头。
 * 理由：它会出现在系统提示与 <lab_skill name="…"/> 里，
 * 一旦允许空格/引号/中文，模型抄写时很容易抄变形、匹配不上。
 */
function cleanSkillName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim().toLowerCase() : ""
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new ApiError(
      400,
      "技能名只能用小写字母、数字和短横线，且以字母或数字开头（例如 pdf-forms）",
      "INVALID_SKILL_NAME"
    )
  }
  if (name.length > SKILL_NAME_MAX) {
    throw new ApiError(400, `技能名最多 ${SKILL_NAME_MAX} 个字符`, "INVALID_SKILL_NAME")
  }
  return name
}

/** 说明清洗：不能为空 —— 空说明模型就无从判断该不该用这个技能 */
function cleanSkillDesc(raw: unknown): string {
  const desc = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : ""
  if (!desc) throw new ApiError(400, "请写一句这个技能是干什么的（模型靠它判断何时使用）", "INVALID_DESC")
  return desc.slice(0, SKILL_DESC_MAX)
}

/** 正文清洗 */
function cleanSkillContent(raw: unknown): string {
  const text = typeof raw === "string" ? raw : ""
  if (!text.trim()) throw new ApiError(400, "技能内容不能为空", "INVALID_CONTENT")
  return text.slice(0, SKILL_CONTENT_MAX)
}

/** 管理端形状（带正文，管理端本来就要编辑） */
function toAdminJson(row: LabSkillRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    content: row.content,
    enabled: !!row.enabled,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** 用户端形状：**不带正文**（正文要等模型主动读，见文件头注释） */
export interface LabSkillPublic {
  id: string
  name: string
  description: string
  /** 是不是自己导入的（用户端好区分「站点给的」和「我自己加的」） */
  mine: boolean
}

/** 造一条「我的 + 站点默认」的过滤条件，避免三处各写一遍写歪 */
function visibleFilter(): string {
  return `((scope = 'site' AND enabled = 1) OR owner_user_id = ?)`
}

/**
 * 读「当前用户可见」的技能索引（只有 name + description）。
 * 用户端建系统提示词时用它拼技能清单。**不返回正文**。
 */
export async function loadSkillIndex(
  env: Env,
  userId: string
): Promise<{ name: string; description: string }[]> {
  const rows = await env.DB.prepare(
    `SELECT name, description FROM lab_skills
     WHERE ${visibleFilter()}
     ORDER BY sort_order ASC, created_at ASC
     LIMIT ?`
  )
    .bind(userId, SKILL_INDEX_MAX)
    .all<{ name: string; description: string }>()
  return rows.results ?? []
}

/**
 * 读某个技能的正文 —— 模型输出 `<lab_skill name="…"/>` 时由循环调用。
 * 返回 null 表示「没有这个技能」或「这个用户看不到它」（两种情况对模型是同一件事）。
 */
export async function loadSkillContent(
  env: Env,
  userId: string,
  name: string
): Promise<{ name: string; description: string; content: string } | null> {
  const row = await env.DB.prepare(
    `SELECT name, description, content FROM lab_skills
     WHERE name = ? AND ${visibleFilter()}
     ORDER BY (owner_user_id IS NOT NULL) DESC
     LIMIT 1`
  )
    .bind(name, userId)
    .first<{ name: string; description: string; content: string }>()
  return row ?? null
}

/** 用户端：列出我能用的技能（站点默认 + 我导入的），不带正文 */
export async function listSkills(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const rows = await env.DB.prepare(
    `SELECT id, name, description, owner_user_id FROM lab_skills
     WHERE ${visibleFilter()}
     ORDER BY sort_order ASC, created_at ASC`
  )
    .bind(user.id)
    .all<Pick<LabSkillRow, "id" | "name" | "description" | "owner_user_id">>()
  return json({
    skills: (rows.results ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      mine: r.owner_user_id != null,
    })),
  })
}

/** 用户端：导入一个自己的技能 */
export async function importSkill(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json().catch(() => null)) as
    | { name?: unknown; description?: unknown; content?: unknown }
    | null
  if (!body) throw new ApiError(400, "请求体格式错误", "INVALID_BODY")

  const name = cleanSkillName(body.name)
  const description = cleanSkillDesc(body.description)
  const content = cleanSkillContent(body.content)

  const mine =
    (await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM lab_skills WHERE owner_user_id = ?"
    ).bind(user.id).first<{ c: number }>())?.c ?? 0
  if (mine >= SKILLS_MAX) {
    throw new ApiError(400, `最多只能导入 ${SKILLS_MAX} 个技能`, "TOO_MANY_SKILLS")
  }

  // 同归属下重名会直接踩唯一索引（500），这里先查一次给出人话提示
  const dup =
    (await env.DB.prepare(
      "SELECT id FROM lab_skills WHERE name = ? AND owner_user_id = ?"
    ).bind(name, user.id).first<{ id: string }>()) ?? null
  if (dup) throw new ApiError(400, `你已经有一个叫「${name}」的技能了`, "DUPLICATE_SKILL_NAME")

  const now = new Date().toISOString()
  const id = uuid()
  const nextOrder =
    (await env.DB.prepare(
      "SELECT COALESCE(MAX(sort_order), 0) AS m FROM lab_skills WHERE owner_user_id = ?"
    ).bind(user.id).first<{ m: number }>())?.m ?? 0

  await env.DB.prepare(
    `INSERT INTO lab_skills
       (id, scope, name, description, content, enabled, owner_user_id, sort_order, created_at, updated_at)
     VALUES (?, 'user', ?, ?, ?, 1, ?, ?, ?, ?)`
  )
    .bind(id, name, description, content, user.id, nextOrder + 1, now, now)
    .run()

  return json({ skill: { id, name, description, mine: true } }, 201)
}

/** 用户端：删掉自己的技能（站点默认技能删不了） */
export async function deleteSkill(env: Env, request: Request, id: string): Promise<Response> {
  const user = await requireUser(env, request)
  const row = await env.DB.prepare(
    "SELECT id, name, owner_user_id FROM lab_skills WHERE id = ?"
  )
    .bind(id)
    .first<Pick<LabSkillRow, "id" | "name" | "owner_user_id">>()
  if (!row) throw new ApiError(404, "技能不存在", "NOT_FOUND")
  // 归属校验：别人的技能一律当作不存在（不泄露「有这么个 id」）
  if (row.owner_user_id !== user.id) {
    throw new ApiError(404, "技能不存在", "NOT_FOUND")
  }
  await env.DB.prepare("DELETE FROM lab_skills WHERE id = ?").bind(id).run()
  return new Response(null, { status: 204 })
}

/* ------------------------------------------------------------------ */
/* 管理端：站点默认技能                                                */
/* ------------------------------------------------------------------ */

/** GET /api/admin/lab/skills —— 全部站点默认技能（含未启用） */
export async function listAdminSkills(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "lab")
  const rows = await env.DB.prepare(
    `SELECT * FROM lab_skills WHERE scope = 'site'
     ORDER BY sort_order ASC, created_at ASC`
  ).all<LabSkillRow>()
  return json({ skills: (rows.results ?? []).map(toAdminJson) })
}

/** POST /api/admin/lab/skills —— 新建站点默认技能（默认启用） */
export async function createAdminSkill(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "lab")
  const body = (await request.json().catch(() => null)) as
    | { name?: unknown; description?: unknown; content?: unknown; enabled?: unknown }
    | null
  if (!body) throw new ApiError(400, "请求体格式错误", "INVALID_BODY")

  const name = cleanSkillName(body.name)
  const description = cleanSkillDesc(body.description)
  const content = cleanSkillContent(body.content)

  const count =
    (await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM lab_skills WHERE scope = 'site'"
    ).first<{ c: number }>())?.c ?? 0
  if (count >= SKILLS_MAX) {
    throw new ApiError(400, `站点默认技能最多 ${SKILLS_MAX} 个`, "TOO_MANY_SKILLS")
  }

  const dup =
    (await env.DB.prepare(
      "SELECT id FROM lab_skills WHERE name = ? AND scope = 'site'"
    ).bind(name).first<{ id: string }>()) ?? null
  if (dup) throw new ApiError(400, `已经有一个叫「${name}」的技能了`, "DUPLICATE_SKILL_NAME")

  const now = new Date().toISOString()
  const id = uuid()
  const nextOrder =
    (await env.DB.prepare(
      "SELECT COALESCE(MAX(sort_order), 0) AS m FROM lab_skills WHERE scope = 'site'"
    ).first<{ m: number }>())?.m ?? 0

  await env.DB.prepare(
    `INSERT INTO lab_skills
       (id, scope, name, description, content, enabled, owner_user_id, sort_order, created_at, updated_at)
     VALUES (?, 'site', ?, ?, ?, ?, NULL, ?, ?, ?)`
  )
    .bind(id, name, description, content, body.enabled === false ? 0 : 1, nextOrder + 1, now, now)
    .run()

  await recordAudit(env, admin.id, "admin.lab_skill", `新建默认技能「${name}」`)
  const row = await env.DB.prepare("SELECT * FROM lab_skills WHERE id = ?")
    .bind(id)
    .first<LabSkillRow>()
  return json({ skill: row ? toAdminJson(row) : null }, 201)
}

/** PUT /api/admin/lab/skills/:id —— 改站点默认技能 */
export async function updateAdminSkill(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireAdminScope(env, request, "lab")
  const body = (await request.json().catch(() => null)) as
    | { name?: unknown; description?: unknown; content?: unknown; enabled?: unknown }
    | null
  if (!body) throw new ApiError(400, "请求体格式错误", "INVALID_BODY")

  const existing = await env.DB.prepare(
    "SELECT * FROM lab_skills WHERE id = ? AND scope = 'site'"
  )
    .bind(id)
    .first<LabSkillRow>()
  if (!existing) throw new ApiError(404, "技能不存在", "NOT_FOUND")

  const sets: string[] = []
  const binds: unknown[] = []
  const changed: string[] = []

  if ("name" in body) {
    const name = cleanSkillName(body.name)
    // 改名也要查重：唯一索引会直接抛 500，这里先给人话
    const dup =
      (await env.DB.prepare(
        "SELECT id FROM lab_skills WHERE name = ? AND scope = 'site' AND id != ?"
      ).bind(name, id).first<{ id: string }>()) ?? null
    if (dup) throw new ApiError(400, `已经有一个叫「${name}」的技能了`, "DUPLICATE_SKILL_NAME")
    sets.push("name = ?")
    binds.push(name)
    changed.push("改名字")
  }
  if ("description" in body) {
    sets.push("description = ?")
    binds.push(cleanSkillDesc(body.description))
    changed.push("改说明")
  }
  if ("content" in body) {
    sets.push("content = ?")
    binds.push(cleanSkillContent(body.content))
    changed.push("改内容")
  }
  if ("enabled" in body) {
    const on = body.enabled === true
    sets.push("enabled = ?")
    binds.push(on ? 1 : 0)
    changed.push(on ? "启用" : "停用")
  }
  if (!sets.length) return json({ skill: toAdminJson(existing) })

  sets.push("updated_at = ?")
  binds.push(new Date().toISOString())
  binds.push(id)
  await env.DB.prepare(`UPDATE lab_skills SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run()

  await recordAudit(
    env,
    admin.id,
    "admin.lab_skill",
    `默认技能「${existing.name}」：${changed.join("、")}`
  )
  const row = await env.DB.prepare("SELECT * FROM lab_skills WHERE id = ?")
    .bind(id)
    .first<LabSkillRow>()
  return json({ skill: row ? toAdminJson(row) : null })
}

/** DELETE /api/admin/lab/skills/:id —— 删站点默认技能 */
export async function deleteAdminSkill(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireAdminScope(env, request, "lab")
  const existing = await env.DB.prepare(
    "SELECT * FROM lab_skills WHERE id = ? AND scope = 'site'"
  )
    .bind(id)
    .first<LabSkillRow>()
  if (!existing) throw new ApiError(404, "技能不存在", "NOT_FOUND")

  await env.DB.prepare("DELETE FROM lab_skills WHERE id = ?").bind(id).run()
  await recordAudit(env, admin.id, "admin.lab_skill", `删除默认技能「${existing.name}」`)
  return new Response(null, { status: 204 })
}

/**
 * GET /api/lab/skill-content?name=xxx —— 取某个技能的正文。
 *
 * 这是渐进式披露的第二步：agent 跑在浏览器里，正文在服务端，
 * 所以模型输出 `<lab_skill name="xxx"/>` 之后要由前端来这里取一次。
 *
 * ⚠️ 只认「当前用户可见」的技能（站点默认 ∪ 自己的）；
 *    看不到的一律当作不存在，不区分「不存在」和「没权限」——不泄露别人的技能名。
 */
export async function getSkillContent(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const name = (new URL(request.url).searchParams.get("name") ?? "").trim().toLowerCase()
  if (!name) throw new ApiError(400, "缺少技能名", "INVALID_SKILL_NAME")
  const found = await loadSkillContent(env, user.id, name)
  if (!found) {
    throw new ApiError(404, `没有找到名为「${name}」的技能`, "SKILL_NOT_FOUND")
  }
  return json({ skill: found })
}
