/**
 * 网页实验室（Web Lab）。
 *
 * 用户在站内通过聊天让 AI 生成小网页（单文件 HTML），保存为「作品」。
 *
 * 额度来源（一期）：
 *   · 站内额度：后端用一个「自动创建的专用 Key」调 NewAPI 的
 *     /v1/chat/completions，扣用户自己的中转站账户额度。
 *     Key 每次现找现取（listTokens + readApiKey），本地不缓存明文；
 *     用户在 NewAPI 侧删了它会自动重建，不需要手动维护。
 *   · 自定义渠道：前端直连（baseUrl + key 只存浏览器本地），不经过本模块。
 *
 * 鉴权用 requireUser 而非 requireFeatureUser("ai")：
 *   未开通中转站的用户也能进实验室用「自定义渠道」，只在真正要走
 *   站内额度时（resolveLabKey）才要求已开通并给出明确指引。
 */
import { ApiError, json } from "../http"
import { requireUser } from "../auth"
import { uuid } from "../crypto"
import {
  createApiKey,
  deleteApiKey,
  listTokens,
  newApiBaseUrl,
  readApiKey,
} from "../newapi-client"
import { getSettings } from "../settings"
import { fetchWithTimeout } from "../async-utils"
import {
  deleteObject,
  deletePrefix,
  getObject,
  getPlatformBucketId,
  isStorageConfigured,
  putObject,
} from "../r2"
import {
  loadAccount,
  mapUserTokenError,
  runWithUserToken,
  userSelectableGroups,
} from "./newapi"
import type { Env } from "../env"

/** 实验室自动创建的 Key 名（在「AI 中转站」页的 Key 列表里可见、可管理） */
const LAB_KEY_NAME = "网页实验室"

/** 拿（或自动创建）用户的实验室专用 Key 的完整值。 */
async function resolveLabKey(env: Env, userId: string): Promise<string> {
  const account = await loadAccount(env, userId)
  if (!account) {
    throw new ApiError(
      404,
      "尚未开通 AI 中转站：去「AI 中转站」页开通后即可用站内额度，或在左下角切到自定义渠道",
      "NOT_BOUND"
    )
  }
  try {
    return await runWithUserToken(env, account, async (token, uid) => {
      // ⚠️ 这个 Key 必须落在「用户可用的分组」里：NewAPI 是按 token 的分组
      //    决定它能用哪些渠道的。分组留空的 Key，上游 /v1/models 直接返回空、
      //    chat 报 `No available channel for model ... under group ...`
      //    —— 表现为实验室「站内额度」下「没有可用模型」，功能整条不可用。
      const group = userSelectableGroups(await getSettings(env))[0]

      // 1) 上游找同名 Key —— 现找现取，本地不缓存明文；被删掉会自动重建
      const tokens = await listTokens(env, token, uid)
      const existing = tokens
        .filter((t) => t.name === LAB_KEY_NAME)
        .sort((a, b) => b.id - a.id)[0]
      // 分组正常 → 直接复用
      if (existing && existing.group.trim()) {
        return readApiKey(env, token, uid, existing.id)
      }
      // 分组为空 = 早期版本建出来的坏 Key：先删掉再按正确分组重建，
      // 否则用户会一直卡在「没有可用模型」；删干净也免得上游留两个同名 Key
      if (existing) {
        await deleteApiKey(env, token, uid, existing.id).catch((err) => {
          console.error("实验室：清理无分组的旧 Key 失败:", err)
        })
      }

      // 2) 没有就建一个，并同步进本地 Key 列表（用户在 AI 页能看到它）
      const created = await createApiKey(env, token, uid, LAB_KEY_NAME, group)
      const now = new Date().toISOString()
      await env.DB.batch([
        env.DB.prepare(
          "DELETE FROM newapi_keys WHERE user_id = ? AND name = ?"
        ).bind(userId, LAB_KEY_NAME),
        env.DB.prepare(
          `INSERT INTO newapi_keys (id, user_id, token_id, name, key_prefix, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(uuid(), userId, created.tokenId, LAB_KEY_NAME, created.maskedKey, now),
      ])
      return created.fullKey
    })
  } catch (err) {
    throw mapUserTokenError(err)
  }
}

// ---------------------------------------------------------------------------
// 聊天（流式转发到上游 /v1/chat/completions）
// ---------------------------------------------------------------------------

const MAX_MESSAGES = 60
/**
 * ⚠️ 单条消息上限要放得比「一个源文件」大。
 * agent 模式下模型的回复里直接带着 <lab_write> 的**完整文件正文**，
 * 40k 字符会把一个正常大小的 HTML 从中间截断 —— 用户看到的是「AI 写了个残缺文件」，
 * 而没有任何报错。这里按「单文件 800KB 上限」留足余量。
 */
const MAX_CONTENT_CHARS = 160_000
const MAX_TOTAL_CHARS = 400_000

interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

/** 校验并收敛消息数组：跳非法项、限单条/总量、system 只留最后一条。 */
function sanitizeMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) {
    throw new ApiError(400, "对话内容格式不对", "INVALID_MESSAGES")
  }
  const all: ChatMessage[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const role = (item as { role?: unknown }).role
    const content = (item as { content?: unknown }).content
    if (role !== "system" && role !== "user" && role !== "assistant") continue
    if (typeof content !== "string" || !content.trim()) continue
    const text =
      content.length > MAX_CONTENT_CHARS
        ? content.slice(0, MAX_CONTENT_CHARS)
        : content
    all.push({ role, content: text })
  }

  const system = [...all].reverse().find((m) => m.role === "system")
  let talk = all.filter((m) => m.role !== "system").slice(-MAX_MESSAGES)

  // 总量超限时从最老的对话开始丢（system 与最近的内容优先保留）
  let total =
    talk.reduce((sum, m) => sum + m.content.length, 0) +
    (system?.content.length ?? 0)
  while (total > MAX_TOTAL_CHARS && talk.length > 1) {
    total -= talk[0].content.length
    talk = talk.slice(1)
  }

  if (!talk.some((m) => m.role === "user")) {
    throw new ApiError(400, "至少需要一条用户消息", "INVALID_MESSAGES")
  }
  return system ? [system, ...talk] : talk
}

/** POST /api/lab/chat —— 以用户额度流式调用 AI（SSE 透传）。 */
export async function chat(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)

  const body = (await request
    .json()
    .catch(() => null)) as { model?: unknown; messages?: unknown } | null
  if (!body) throw new ApiError(400, "请求体不是合法 JSON", "INVALID_BODY")

  const model =
    typeof body.model === "string" ? body.model.trim().slice(0, 120) : ""
  if (!model) throw new ApiError(400, "请选择模型", "INVALID_MODEL")

  const messages = sanitizeMessages(body.messages)
  const sk = await resolveLabKey(env, user.id)
  const base = newApiBaseUrl(env)

  let upstream: Response
  try {
    // ⚠️ 流式请求不能用 fetchWithTimeout 包：到点会把正在输出的流掐断。
    //    连不上/挂死由平台的连接超时与客户端断开兜底。
    upstream = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sk}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ model, messages, stream: true, temperature: 0.6 }),
    })
  } catch (err) {
    console.error("实验室直连上游失败:", err)
    throw new ApiError(
      502,
      "无法连接 AI 上游（网络超时），请重试",
      "UPSTREAM_UNREACHABLE"
    )
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "")
    let message = `AI 调用失败（HTTP ${upstream.status}）`
    try {
      const parsed = JSON.parse(text) as {
        error?: { message?: string }
        message?: string
      }
      const m = parsed?.error?.message ?? parsed?.message
      if (m) message = m
    } catch {
      /* 非 JSON 就保留兜底文案 */
    }
    throw new ApiError(502, message.slice(0, 300), "UPSTREAM_ERROR")
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      // 给可能存在的中间层一个「别缓冲」的提示
      "X-Accel-Buffering": "no",
    },
  })
}

/** GET /api/lab/models —— 该用户在站内额度下可用的模型列表。 */
export async function listModels(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const sk = await resolveLabKey(env, user.id)
  const base = newApiBaseUrl(env)

  const res = await fetchWithTimeout(
    `${base}/v1/models`,
    { headers: { Authorization: `Bearer ${sk}` } },
    20_000
  )
  if (!res.ok) {
    throw new ApiError(502, "拉取模型列表失败，请稍后重试", "UPSTREAM_ERROR")
  }
  const data = (await res.json().catch(() => null)) as {
    data?: { id?: unknown }[]
  } | null
  const models = (data?.data ?? [])
    .map((m) => m?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
  models.sort((a, b) => a.localeCompare(b))
  return json({ models })
}

// ---------------------------------------------------------------------------
// 作品 CRUD
// ---------------------------------------------------------------------------

interface LabProjectRow {
  id: string
  user_id: string
  name: string
  slug: string
  description: string
  icon: string
  files: string
  visibility: string
  review_note: string | null
  views: number
  likes: number
  created_at: string
  updated_at: string
  published_at: string | null
  storage: string
  bucket_id: string | null
}

// ---------------------------------------------------------------------------
// 文件存储（R2 优先，未配置时回退 D1）
//
// 为什么不全塞 D1：D1 免费版**单个库**上限 500MB，作品文件（HTML/CSS/JS）
// 直接写在 lab_projects.files 里会很快吃掉它，而且行越大整表扫描越慢。
// 现在文件正文放 R2（平台桶），D1 只留「路径 → 大小」的清单。
//
//   storage = 'd1' → files 是 {"path": "<正文>"}      （历史行，读取时兼容）
//   storage = 'r2' → files 是 {"path": {"size": N}}   （正文在 lab/<uid>/<pid>/<path>）
// ---------------------------------------------------------------------------

/** 每个用户最多保存多少个作品（文件进了 R2 后没有天然上限，靠这条兜住） */
const MAX_PROJECTS_PER_USER = 50

/** 作品规模上限：文件数 / 单文件 / 合计 */
const MAX_FILES = 60
const MAX_FILE_BYTES = 800_000
const MAX_TOTAL_BYTES = 3_000_000

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
}

function contentTypeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  return CONTENT_TYPES[ext] ?? "application/octet-stream"
}

/** 收敛相对路径：去掉 ./ 与开头的 /，拒绝 .. 与奇怪字符。非法返回 null。 */
function normalizePath(raw: string): string | null {
  const p = raw.trim().replace(/^\.\//, "").replace(/^\/+/, "")
  if (!p || p.length > 120 || p.endsWith("/") || p.includes("//")) return null
  if (p.includes("..")) return null
  if (!/^[a-zA-Z0-9._\-/]+$/.test(p)) return null
  return p
}

/** 校验 files（路径 → 正文）。 */
function normalizeFiles(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError(400, "files 必须是「路径 → 内容」的对象", "INVALID_FILES")
  }
  const out: Record<string, string> = {}
  let total = 0
  for (const [path, content] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof content !== "string") continue
    const clean = normalizePath(path)
    if (!clean) continue
    if (content.length > MAX_FILE_BYTES) {
      throw new ApiError(
        413,
        `文件 ${clean} 太大（超过 800KB），精简后再保存`,
        "TOO_LARGE"
      )
    }
    out[clean] = content
    total += content.length
  }
  if (!Object.keys(out).length) {
    throw new ApiError(400, "至少需要一个文件", "INVALID_FILES")
  }
  if (Object.keys(out).length > MAX_FILES) {
    throw new ApiError(413, `文件数超过 ${MAX_FILES} 个，精简后再保存`, "TOO_LARGE")
  }
  if (total > MAX_TOTAL_BYTES) {
    throw new ApiError(413, "作品太大（合计超过 3MB），精简后再保存", "TOO_LARGE")
  }
  if (!out["index.html"]) {
    throw new ApiError(400, "缺少入口文件 index.html", "INVALID_FILES")
  }
  return out
}

type Manifest = Record<string, { size: number }>

function parseManifest(json: string): Manifest {
  try {
    const obj = JSON.parse(json || "{}") as Record<string, unknown>
    const out: Manifest = {}
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        out[k] = { size: Number((v as { size?: unknown }).size ?? 0) }
      }
    }
    return out
  } catch {
    return {}
  }
}

/**
 * 作品文件在桶里的路径：`_lab/<用户id>/<作品id>/<文件名>`。
 *
 * ⚠️ 前缀必须是**不可能被当作用户名**的名字（前导下划线）。
 * 网盘文件存在 `<用户名>/…` 下，如果这里用 `lab/`，那么一个叫「lab」的
 * 用户，他的网盘根目录会和实验室的作品目录撞在一起（互相看得见、甚至同名覆盖）。
 * `_lab/` 与用户目录彻底分开，且两边的目录结构独立，不会串。
 */
function projectPrefix(userId: string, projectId: string): string {
  return `_lab/${userId}/${projectId}/`
}

/**
 * 作品文件该放哪个桶。
 *
 * 优先放**用户自己的网盘桶**（storage_accounts.bucket_id）—— 他自己的存储，
 * 用超了也是他自己担着；没开通网盘的用户才回退到平台桶。
 * key 前缀两者一致（lab/<uid>/<pid>/），只是桶不同，所以桶 id 必须存进
 * lab_projects.bucket_id（见 0133 迁移），否则用户换桶后老作品会「消失」。
 */
async function resolveLabStorage(
  env: Env,
  userId: string
): Promise<{ bucketId: string | null; shared: boolean }> {
  const acct = await env.DB.prepare(
    "SELECT bucket_id FROM storage_accounts WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ bucket_id: string | null }>()
  if (acct?.bucket_id) return { bucketId: acct.bucket_id, shared: false }
  return { bucketId: await getPlatformBucketId(env), shared: true }
}

/**
 * 把文件写进 R2，返回清单 JSON。
 * R2 没配好时返回 null，调用方回退 D1（本地开发 / 未配置桶的环境仍可用）。
 */
async function writeFilesToR2(
  env: Env,
  userId: string,
  projectId: string,
  files: Record<string, string>,
  previousPaths: string[],
  bucketId: string | null
): Promise<string | null> {
  if (!(await isStorageConfigured(env))) return null
  const prefix = projectPrefix(userId, projectId)
  const manifest: Manifest = {}
  const tasks: Promise<unknown>[] = []
  for (const [path, content] of Object.entries(files)) {
    tasks.push(putObject(env, prefix + path, content, contentTypeFor(path), bucketId))
    manifest[path] = { size: content.length }
  }
  // 本轮删掉的文件，R2 上也要删（否则改个文件名就永久留垃圾）
  for (const path of previousPaths) {
    if (!(path in files)) tasks.push(deleteObject(env, prefix + path, bucketId))
  }
  await Promise.all(tasks)
  return JSON.stringify(manifest)
}

/** 读出作品的完整文件内容（兼容历史的 D1 存储行）。 */
async function readFiles(
  env: Env,
  row: LabProjectRow
): Promise<Record<string, string>> {
  if (row.storage !== "r2") {
    try {
      return JSON.parse(row.files || "{}") as Record<string, string>
    } catch {
      return {}
    }
  }
  const manifest = parseManifest(row.files)
  // 认作品自己记下的桶，不去猜「当前该用户的桶」
  const bucketId = row.bucket_id
  const prefix = projectPrefix(row.user_id, row.id)
  const pairs = await Promise.all(
    Object.keys(manifest).map(async (p) => {
      try {
        const res = await getObject(env, prefix + p, undefined, bucketId)
        return [p, await res.text()] as const
      } catch {
        // 单个文件丢失不该让整个作品打不开
        return [p, ""] as const
      }
    })
  )
  return Object.fromEntries(pairs)
}

/** 上一次保存过的文件路径（用于算出「这次删了哪些」）。 */
function previousPaths(row: LabProjectRow): string[] {
  if (row.storage === "r2") return Object.keys(parseManifest(row.files))
  try {
    return Object.keys(JSON.parse(row.files || "{}"))
  } catch {
    return []
  }
}

/** 删作品时清空它在 R2 上的整个前缀（尽力而为，失败只记日志）。 */
async function purgeProjectFiles(env: Env, row: LabProjectRow): Promise<void> {
  if (row.storage !== "r2") return
  try {
    await deletePrefix(env, projectPrefix(row.user_id, row.id), 5, row.bucket_id)
  } catch (err) {
    console.error("清理作品 R2 文件失败:", err)
  }
}

/** 由作品名生成 URL 友好 slug；中文名等会得到空串，用 id 前缀兜底。 */
function slugify(name: string, fallback: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return base || `p-${fallback.replace(/[^a-z0-9]/gi, "").slice(0, 8)}`
}

async function uniqueSlug(
  env: Env,
  userId: string,
  name: string,
  fallback: string,
  excludeId?: string
): Promise<string> {
  const base = slugify(name, fallback)
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`
    const row = await env.DB.prepare(
      "SELECT id FROM lab_projects WHERE user_id = ? AND slug = ? AND id != ?"
    )
      .bind(userId, candidate, excludeId ?? "")
      .first()
    if (!row) return candidate
  }
  return `${base}-${Date.now().toString(36)}`
}

function toClientJson(row: LabProjectRow, files?: Record<string, string>) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    icon: row.icon,
    description: row.description,
    visibility: row.visibility,
    views: row.views,
    likes: row.likes,
    storage: row.storage,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(files ? { files } : {}),
  }
}

async function loadProject(
  env: Env,
  id: string,
  userId: string
): Promise<LabProjectRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM lab_projects WHERE id = ? AND user_id = ?"
  )
    .bind(id, userId)
    .first<LabProjectRow>()
  if (!row) throw new ApiError(404, "作品不存在", "NOT_FOUND")
  return row
}

/** GET /api/lab/projects —— 我的作品列表（不含文件内容）。 */
export async function listProjects(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const rows = await env.DB.prepare(
    `SELECT id, user_id, name, slug, icon, description, visibility, review_note,
            views, likes, created_at, updated_at, published_at, '' AS files
     FROM lab_projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200`
  )
    .bind(user.id)
    .all<LabProjectRow>()
  return json({ projects: (rows.results ?? []).map((r) => toClientJson(r)) })
}

/** GET /api/lab/projects/:id —— 单个作品（含文件内容，编辑器用）。 */
export async function getProject(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const user = await requireUser(env, request)
  const row = await loadProject(env, id, user.id)
  return json({ project: toClientJson(row, await readFiles(env, row)) })
}

/** POST /api/lab/projects —— 新建（无 id）或更新（带 id）作品。 */
export async function saveProject(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)

  const body = (await request.json().catch(() => null)) as {
    id?: unknown
    name?: unknown
    description?: unknown
    icon?: unknown
    files?: unknown
  } | null
  if (!body) throw new ApiError(400, "请求体不是合法 JSON", "INVALID_BODY")

  const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : ""
  if (!name) throw new ApiError(400, "给作品起个名字", "INVALID_NAME")
  const description =
    typeof body.description === "string"
      ? body.description.trim().slice(0, 200)
      : ""
  const icon =
    typeof body.icon === "string" && body.icon.trim()
      ? body.icon.trim().slice(0, 8)
      : "🌐"
  const files = normalizeFiles(body.files)
  const now = new Date().toISOString()
  const { bucketId } = await resolveLabStorage(env, user.id)

  const id = typeof body.id === "string" && body.id ? body.id : null
  if (id) {
    const existing = await loadProject(env, id, user.id)
    const slug = await uniqueSlug(env, user.id, name, existing.slug, id)
    // 先写文件再改行：宁可留几个 R2 孤儿对象，也不要「行在、文件没了」
    const manifest = await writeFilesToR2(
      env,
      user.id,
      id,
      files,
      previousPaths(existing),
      bucketId
    )
    await env.DB.prepare(
      `UPDATE lab_projects
       SET name = ?, slug = ?, description = ?, icon = ?, files = ?, storage = ?,
           bucket_id = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`
    )
      .bind(
        name,
        slug,
        description,
        icon,
        manifest ?? JSON.stringify(files),
        manifest ? "r2" : "d1",
        manifest ? bucketId : null,
        now,
        id,
        user.id
      )
      .run()
    const fresh = await loadProject(env, id, user.id)
    return json({ project: toClientJson(fresh, await readFiles(env, fresh)) })
  }

  // 数量上限：文件在 R2 里没有 D1 那样的天然约束，靠这条拦住无节制占用
  const countRow = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM lab_projects WHERE user_id = ?"
  )
    .bind(user.id)
    .first<{ c: number }>()
  if ((countRow?.c ?? 0) >= MAX_PROJECTS_PER_USER) {
    throw new ApiError(
      413,
      `最多保存 ${MAX_PROJECTS_PER_USER} 个作品，先删掉一些再存`,
      "TOO_MANY_PROJECTS"
    )
  }

  const newId = uuid()
  const slug = await uniqueSlug(env, user.id, name, newId)
  const manifest = await writeFilesToR2(env, user.id, newId, files, [], bucketId)
  await env.DB.prepare(
    `INSERT INTO lab_projects
       (id, user_id, name, slug, description, icon, files, storage, bucket_id,
        visibility, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'private', ?, ?)`
  )
    .bind(
      newId,
      user.id,
      name,
      slug,
      description,
      icon,
      manifest ?? JSON.stringify(files),
      manifest ? "r2" : "d1",
      manifest ? bucketId : null,
      now,
      now
    )
    .run()
  const created = await loadProject(env, newId, user.id)
  return json({ project: toClientJson(created, files) }, 201)
}

/** DELETE /api/lab/projects/:id */
export async function deleteProject(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const user = await requireUser(env, request)
  const existing = await loadProject(env, id, user.id)
  // 先删行再清 R2：万一清理失败只会留孤儿对象，不会留下「行在、文件没了」的坏作品
  await env.DB.prepare("DELETE FROM lab_projects WHERE id = ?").bind(id).run()
  await purgeProjectFiles(env, existing)
  return new Response(null, { status: 204 })
}
