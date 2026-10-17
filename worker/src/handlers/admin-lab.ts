/**
 * 管理端「AI 实验室」配置。
 *
 * 面板上要管四件事（原来散在设置页与代码里的）：
 *   1. **模型来源** —— 各用户自己的中转站额度，还是全站统一用管理员的 Key；
 *   2. **统一 Key** —— 写入即加密，读出来只给尾号（明文永不回包）；
 *   3. **自定义渠道** —— 管理员挂几条 OpenAI 兼容渠道给用户白用；
 *   4. **系统提示词** —— 从「全局设置」页搬过来的 `lab_agent_prompt`。
 *
 * ⚠️ 单独成一个 handler 而不是塞进 `handlers/admin.ts`：
 * 那边已经是 8000+ 行的巨石，而这几件事有自己的密钥处理规则
 * （`lab-config.ts`），混进去只会让两边都更难改。
 */
import { ApiError, json } from "../http"
import { requireAdminScope } from "./admin"
import { audit as recordAudit, getSettings, updateSettings } from "../settings"
import {
  decryptLabSecret,
  encryptLabSecret,
  mergeChannels,
  parseFreeModels,
  parseStoredChannels,
  sanitizeChannelInputs,
  type LabAiSource,
  type LabQuotaPeriod,
} from "../lab-config"
/**
 * 作品相关的核心函数从 `./lab` 复用，不在本文件重写一遍 ——
 * 管理端与作者侧必须落出**同一个结果**（同一套字段口径、同一套清理范围）。
 * 权限不在这里判断：`./lab` 里这些函数都是「已经授权之后」才该被调用的薄核心。
 */
import {
  applyProjectSlug,
  coverVersionOf,
  deleteProjectCascade,
  loadProjectById,
  readFiles,
  removeProjectCover,
  saveCoverFromRequest,
  setProjectVisibility,
  toClientJson,
  updateProjectMeta,
  type LabProjectRow,
} from "./lab"
import { bindProjectDomain, getBoundDomain, releaseProjectDomain } from "./lab-domains"
import { likeContains } from "../sql-like"
import type { Env } from "../env"

/** Key 尾号：只留最后 4 位，供管理员辨认「配的是哪一把」 */
function keyTail(plain: string): string {
  if (!plain) return ""
  return plain.length <= 4 ? plain : plain.slice(-4)
}

function normalizeSource(raw: unknown): LabAiSource {
  return raw === "admin" ? "admin" : "user"
}

function normalizePeriod(raw: unknown): LabQuotaPeriod {
  return raw === "month" || raw === "total" ? raw : "day"
}

/** 提示词上限：与前端 Textarea 的体量匹配，防误粘超长内容撑爆 app_settings */
const AGENT_PROMPT_MAX = 60_000

/**
 * 组装给管理面板看的配置。
 *
 * 三处**不回明文**：统一 Key、每条渠道的 apiKey。都只给尾号 + 有无标记。
 * 管理面板想换密钥就重新粘一把，不需要（也不允许）看到旧的。
 */
async function buildConfig(env: Env) {
  const s = await getSettings(env)
  const adminKey = await decryptLabSecret(env, s.lab_admin_api_key)
  const stored = parseStoredChannels(s.lab_admin_channels)

  const channels = []
  for (const ch of stored) {
    const plain = await decryptLabSecret(env, ch.apiKeyEnc)
    channels.push({
      id: ch.id,
      name: ch.name,
      baseUrl: ch.baseUrl,
      model: ch.model,
      hasKey: plain.length > 0,
      keyTail: keyTail(plain),
    })
  }

  const quotaRaw = Number(s.lab_free_quota)
  const configuredSource = normalizeSource(s.lab_ai_source)

  return {
    aiSource: configuredSource,
    /** 配了「统一 Key」模式却没有可用 Key —— 此时后端会自动退回按用户扣费 */
    adminUnavailable: configuredSource === "admin" && !adminKey,
    hasAdminKey: adminKey.length > 0,
    adminKeyTail: keyTail(adminKey),
    freeQuota: Number.isFinite(quotaRaw) && quotaRaw > 0 ? Math.trunc(quotaRaw) : 0,
    freeQuotaPeriod: normalizePeriod(s.lab_free_quota_period),
    /** 免费模型白名单；**空数组 = 全部免费**（面板据此提示管理员） */
    freeModels: parseFreeModels(s.lab_free_models),
    /** 站内模型白名单；**空数组 = 不过滤**（下拉里显示站内返回的全部模型） */
    siteModels: parseFreeModels(s.lab_site_models),
    /** 造物集：作品公开前是否需要管理员审核（默认开启） */
    reviewRequired: s.lab_review_required === "1",
    /**
     * 原生工具调用（function calling）开关。
     * 关 = 走原有的「文本标签协议」；开 = 给上游带 tools、按结构化 tool_calls 解析。
     */
    nativeTools: s.lab_native_tools === "1",
    agentPrompt: s.lab_agent_prompt,
    channels,
  }
}

/** GET /api/admin/lab/config */
export async function getLabConfig(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "lab")
  return json(await buildConfig(env))
}

/**
 * PUT /api/admin/lab/config
 *
 * 字段级更新：**body 里没出现的键一律不动**。这样面板可以分块保存，
 * 也可以只点一个开关而不用担心把提示词清空。
 *
 * 统一 Key 的两种写法：
 *   · `adminApiKey` 非空 ⇒ 换成这把新的；
 *   · `clearAdminKey: true` ⇒ 清掉；
 *   · 都不给 ⇒ 保持原样（面板回显的是尾号，留空提交就是"不改"）。
 */
export async function updateLabConfig(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "lab")
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) throw new ApiError(400, "请求体格式错误", "INVALID_BODY")

  const current = await getSettings(env)
  const values: Record<string, string> = {}
  const changed: string[] = []

  if ("aiSource" in body) {
    const src = normalizeSource(body.aiSource)
    values.lab_ai_source = src
    changed.push(`来源=${src}`)
  }

  if (body.clearAdminKey === true) {
    values.lab_admin_api_key = ""
    changed.push("清空统一Key")
  } else if (typeof body.adminApiKey === "string" && body.adminApiKey.trim()) {
    try {
      values.lab_admin_api_key = await encryptLabSecret(env, body.adminApiKey.trim())
    } catch {
      throw new ApiError(503, "未配置 SESSION_SECRET，无法安全保存密钥", "NOT_CONFIGURED")
    }
    changed.push("更新统一Key")
  }

  if ("freeQuota" in body) {
    const n = Number(body.freeQuota)
    const clamped = Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 1_000_000) : 0
    values.lab_free_quota = String(clamped)
    changed.push(`免费额度=${clamped}`)
  }

  if ("freeQuotaPeriod" in body) {
    const p = normalizePeriod(body.freeQuotaPeriod)
    values.lab_free_quota_period = p
    changed.push(`额度周期=${p}`)
  }

  if ("freeModels" in body) {
    // 面板多选直接传数组；也接受字符串（手敲或旧调用）。
    // 清洗统一走 parseFreeModels —— 与读取侧同一份实现，避免两边口径分家。
    const raw = Array.isArray(body.freeModels)
      ? body.freeModels.filter((x): x is string => typeof x === "string").join(",")
      : typeof body.freeModels === "string"
        ? body.freeModels
        : ""
    const list = parseFreeModels(raw)
    values.lab_free_models = list.join(",")
    changed.push(list.length > 0 ? `免费模型=${list.length}个` : "免费模型=全部")
  }

  if ("siteModels" in body) {
    // 与免费白名单同一套清洗与存储格式（读侧也是同一个解析器）
    const raw = Array.isArray(body.siteModels)
      ? body.siteModels.filter((x): x is string => typeof x === "string").join(",")
      : typeof body.siteModels === "string"
        ? body.siteModels
        : ""
    const list = parseFreeModels(raw)
    values.lab_site_models = list.join(",")
    changed.push(list.length > 0 ? `站内模型=${list.length}个` : "站内模型=不过滤")
  }

  if ("agentPrompt" in body) {
    const text = typeof body.agentPrompt === "string" ? body.agentPrompt : ""
    values.lab_agent_prompt = text.slice(0, AGENT_PROMPT_MAX)
    changed.push(text.trim() ? "更新提示词" : "恢复默认提示词")
  }

  if ("reviewRequired" in body) {
    const on = body.reviewRequired === true || body.reviewRequired === "1"
    values.lab_review_required = on ? "1" : "0"
    changed.push(on ? "作品公开需审核=开" : "作品公开需审核=关")
  }

  if ("nativeTools" in body) {
    const on = body.nativeTools === true || body.nativeTools === "1"
    values.lab_native_tools = on ? "1" : "0"
    changed.push(on ? "原生工具调用=开" : "原生工具调用=关")
  }

  if ("channels" in body) {
    const inputs = sanitizeChannelInputs(body.channels)
    const previous = new Map(parseStoredChannels(current.lab_admin_channels).map((c) => [c.id, c.apiKeyEnc]))
    let merged
    try {
      merged = await mergeChannels(env, inputs, previous)
    } catch {
      throw new ApiError(503, "未配置 SESSION_SECRET，无法安全保存渠道密钥", "NOT_CONFIGURED")
    }
    values.lab_admin_channels = JSON.stringify(merged)
    changed.push(`渠道=${merged.length}条`)
  }

  if (Object.keys(values).length === 0) {
    throw new ApiError(400, "没有要更新的内容", "NOTHING_TO_UPDATE")
  }

  await updateSettings(env, values)
  await recordAudit(env, admin.id, "admin.lab_config", changed.join("，"))

  return json(await buildConfig(env))
}

// ---------------------------------------------------------------------------
// 造物集作品审核
//
// 用户把作品设为「公开」时，若 `lab_review_required` 打开，作品会落到
// `pending` 队列里等管理员放行 —— 这里就是那个队列的查询与放行/驳回。
//
// 可见性取值：private（默认）/ pending（待审）/ public（已公开）/ rejected（已驳回）
// ---------------------------------------------------------------------------

/** lab_projects 行 + 作者信息（管理端审核列表用） */
interface ReviewRow {
  id: string
  name: string
  description: string
  icon: string
  cover_key: string | null
  visibility: string
  review_note: string | null
  created_at: string
  updated_at: string
  published_at: string | null
  author_name: string
  author_username: string
}

function toReviewJson(row: ReviewRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    hasCover: !!row.cover_key,
    visibility: row.visibility,
    reviewNote: row.review_note ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    authorName: row.author_name,
    authorUsername: row.author_username,
  }
}

/**
 * GET /api/admin/lab/reviews?status=pending —— 待审 / 已驳回的作品列表。
 *
 * 只回展示信息（名字 / 简介 / 图标 / 封面有无 / 作者），
 * **不回作品文件内容** —— 审核台不需要跑代码，要看效果点「预览」走用户端详情接口。
 */
export async function listLabReviews(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "lab")
  const url = new URL(request.url)
  const status = url.searchParams.get("status") === "rejected" ? "rejected" : "pending"

  const rows = await env.DB.prepare(
    `SELECT p.id, p.name, p.description, p.icon, p.cover_key, p.visibility, p.review_note,
            p.created_at, p.updated_at, p.published_at,
            COALESCE(NULLIF(u.nickname, ''), u.username) AS author_name,
            u.username AS author_username
     FROM lab_projects p JOIN users u ON u.id = p.user_id
     WHERE p.visibility = ?
     ORDER BY p.updated_at DESC
     LIMIT 200`
  )
    .bind(status)
    .all<ReviewRow>()

  const counts = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN visibility = 'pending'  THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN visibility = 'rejected' THEN 1 ELSE 0 END) AS rejected
     FROM lab_projects`
  ).first<{ pending: number | null; rejected: number | null }>()

  return json({
    status,
    items: (rows.results ?? []).map(toReviewJson),
    pendingCount: counts?.pending ?? 0,
    rejectedCount: counts?.rejected ?? 0,
  })
}

/**
 * GET /api/admin/lab/reviews/:id/preview —— 读一份待审作品的完整文件。
 *
 * 审核必须看得见作品，否则就是盲审。用户的 `/api/gallery/:id` 只放行
 * 「已公开」或「本人」，待审作品管理员按那条路取不到，所以单独开这一条。
 *
 * ⚠️ 持有 `lab` 权限的管理员才可读；返回的仍是**原始文件内容**，
 *    前端必须照旧塞进 `sandbox`（不带 `allow-same-origin`）的 iframe 里渲染。
 */
export async function previewLabReview(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  await requireAdminScope(env, request, "lab")

  const row = await env.DB.prepare(
    `SELECT id, user_id, name, slug, icon, description, files, storage, bucket_id,
            visibility, review_note, views, likes, created_at, updated_at, published_at,
            cover_key
     FROM lab_projects WHERE id = ?`
  )
    .bind(id)
    .first<LabProjectRow>()

  const files = row ? await readFiles(env, row) : {}
  return json({ project: { id: row?.id ?? id, name: row?.name ?? "", files } })
}

/**
 * POST /api/admin/lab/reviews/:id —— 放行 / 驳回一个作品。
 *
 *   · action="approve" ⇒ visibility='public'，补 `published_at`（只补第一次），清掉驳回理由；
 *   · action="reject"  ⇒ visibility='rejected'，把 `note` 写进 `review_note`，
 *                        用户在自己的「我的造物集」里能看到被驳回的原因。
 *
 * 只处理 `pending` 的作品：已经在公开大厅里的作品不该被这条接口二次改判。
 */
export async function reviewLabProject(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireAdminScope(env, request, "lab")
  const body = (await request.json().catch(() => null)) as {
    action?: unknown
    note?: unknown
  } | null
  if (!body) throw new ApiError(400, "请求体不是合法 JSON", "INVALID_BODY")

  const approve = body.action === "approve"
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 200) : ""

  const row = await env.DB.prepare(
    "SELECT id, name, visibility FROM lab_projects WHERE id = ?"
  )
    .bind(id)
    .first<{ id: string; name: string; visibility: string }>()
  if (!row) throw new ApiError(404, "作品不存在", "NOT_FOUND")
  if (row.visibility !== "pending") {
    throw new ApiError(409, "这个作品不在待审核状态", "NOT_PENDING")
  }

  const now = new Date().toISOString()
  if (approve) {
    await env.DB.prepare(
      `UPDATE lab_projects
       SET visibility = 'public', review_note = NULL,
           published_at = COALESCE(published_at, ?), updated_at = ?
       WHERE id = ?`
    )
      .bind(now, now, id)
      .run()
  } else {
    await env.DB.prepare(
      `UPDATE lab_projects SET visibility = 'rejected', review_note = ?, updated_at = ?
       WHERE id = ?`
    )
      .bind(note || "未通过审核", now, id)
      .run()
  }

  await recordAudit(
    env,
    admin.id,
    "admin.lab_review",
    `${approve ? "通过" : "驳回"}作品「${row.name}」${approve ? "" : `：${note || "未通过审核"}`}`
  )

  return json({ id, visibility: approve ? "public" : "rejected" })
}

/**
 * POST /api/admin/lab/gallery/pin —— body: { projectId, pinned }
 * 造物集置顶 / 取消置顶（2026-10-10 站长要求）。
 *
 * ⚠️ 只改 `lab_projects.pinned_at`：写入「当前时间」= 置顶，写 NULL = 取消。
 *    排序侧只看这一个字段（见 listGallery 的 ORDER BY），所以这里改完立刻生效。
 * ⚠️ 不校验作品是否公开：管理员可能想「先置顶、等它审核通过自然就上去了」。
 *    但**必须校验作品存在**，免得写进一个不存在的 id（静默无效果）。
 */
export async function setGalleryPinned(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "lab")
  const body = (await request.json().catch(() => null)) as {
    projectId?: unknown
    pinned?: unknown
  } | null
  if (!body) throw new ApiError(400, "请求体格式错误", "INVALID_BODY")

  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : ""
  if (!projectId) throw new ApiError(400, "缺少 projectId", "INVALID_ID")
  const pinned = body.pinned === true || body.pinned === "1"

  const row = await env.DB.prepare("SELECT id FROM lab_projects WHERE id = ?")
    .bind(projectId)
    .first<{ id: string }>()
  if (!row) throw new ApiError(404, "作品不存在", "NOT_FOUND")

  await env.DB.prepare("UPDATE lab_projects SET pinned_at = ? WHERE id = ?")
    .bind(pinned ? new Date().toISOString() : null, projectId)
    .run()

  return json({ projectId, pinned })
}

// ---------------------------------------------------------------------------
// 造物集管理台（2026-10-17 站长要求）
//
// 要的是「管理端能像作者一样管任何作品」：列表（含未公开的）、编辑对外信息、
// 封面、页面名、子域名、直接改状态、删除、置顶。
//
// 🔴 为什么**不**在 `/lab/projects/*` 里给管理员开旁路，而是单开一组接口：
//    那些接口是「按作者身份」写的 —— `loadProject(id, user_id)` 自带归属条件，
//    `saveProject` 还会把文件写进**该作者**的网盘桶、按该作者算配额
//    （`resolveLabStorage`），实验室里跑模型的那条链更是按用户计费/计额度。
//    在同一个入口上加「是管理员就放行」，等于让二十多个用户侧接口共用一处
//    角色判断：判错一次，任何登录用户都能改别人的作品/替别人烧额度；
//    而且这个判断要额外查一次库，等于给**所有**用户的每次保存加成本。
//
//    单开一组的代价是多几个薄 wrapper，换来的是：
//      · 权限边界**结构性**成立 —— 用户侧接口压根没有管理员分支，
//        「普通用户改别人作品」在 SQL 层就查不到行（不依赖任何 if 写对）；
//      · 每条管理动作都能单独记审计（用户侧没有这个概念）；
//      · 实验室里真正按用户计费/计额度的路径**完全没被碰过**。
//
// 鉴权一律 `requireAdminScope(env, request, "lab")` —— 与 `setGalleryPinned`
// 同一把闸、同一个权限节点（造物集本来就是实验室的一部分，不另立权限域）。
// 所有具体动作都复用 `handlers/lab.ts` / `lab-domains.ts` 里抽出来的核心函数，
// 所以「管理员改」和「作者改」落库的效果完全一致，不会出现两套规则。
// ---------------------------------------------------------------------------

/** 管理端作品列表：一页 30 条（够看、又不至于把 50 行按钮一次渲染出来） */
const GALLERY_PAGE_SIZE = 30

/** 管理端列表的行：作品行 + 作者信息 + 置顶时间 */
interface AdminGalleryRow {
  id: string
  user_id: string
  name: string
  slug: string
  description: string
  icon: string
  cover_key: string | null
  visibility: string
  review_note: string | null
  views: number
  likes: number
  pinned_at: string | null
  created_at: string
  updated_at: string
  published_at: string | null
  author_name: string
  author_username: string
  author_avatar: string | null
}

/** 合法的可见性取值（与 `lab_projects.visibility` 的四种状态一一对应） */
const GALLERY_STATUSES = ["public", "private", "pending", "rejected"] as const
type GalleryStatus = (typeof GALLERY_STATUSES)[number]

function parseStatus(raw: string | null): GalleryStatus | "" {
  return raw && (GALLERY_STATUSES as readonly string[]).includes(raw)
    ? (raw as GalleryStatus)
    : ""
}

function toAdminGalleryJson(row: AdminGalleryRow) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    icon: row.icon,
    hasCover: !!row.cover_key,
    coverV: coverVersionOf(row.cover_key),
    visibility: row.visibility,
    reviewNote: row.review_note ?? "",
    views: row.views,
    likes: row.likes,
    /** 置顶时间；null = 未置顶（列表按它排最前，管理台据此回显按钮） */
    pinnedAt: row.pinned_at,
    authorName: row.author_name,
    authorUsername: row.author_username,
    authorAvatar: row.author_avatar,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  }
}

/**
 * GET /api/admin/lab/gallery?q=&status=&page=
 *
 * 全部作品（不只是公开的）：管理台要能处理私有 / 待审 / 已驳回。
 *
 * 分页放在服务端：作品总量会一直长，一次性拉全量既慢又没法用
 * （站长明确要求「别一次性拉全量」）。`?sort=` 之类的大厅排序参数在这里没有意义 ——
 * 管理台固定「置顶优先 + 最近更新优先」，找东西靠搜索与状态筛选。
 */
export async function listGalleryProjects(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "lab")
  const url = new URL(request.url)
  const rawPage = Number(url.searchParams.get("page") ?? "1")
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.min(1000, Math.trunc(rawPage))) : 1
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 40)
  const status = parseStatus(url.searchParams.get("status"))
  /** 只看置顶（置顶卡片用；列表筛选不用它） */
  const pinnedOnly = url.searchParams.get("pinned") === "1"

  const where: string[] = []
  const binds: unknown[] = []
  if (status) {
    where.push("p.visibility = ?")
    binds.push(status)
  }
  if (pinnedOnly) where.push("p.pinned_at IS NOT NULL")
  if (q) {
    // 名字 / 简介 / 页面名 / 作者名都能搜 —— 站长手上只有「那个叫什么的作品」
    where.push(
      "(p.name LIKE ? OR p.description LIKE ? OR p.slug LIKE ? OR u.username LIKE ? OR u.nickname LIKE ?)"
    )
    for (let i = 0; i < 5; i++) binds.push(likeContains(q))
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""

  const [totalRow, rows, counts] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS c FROM lab_projects p JOIN users u ON u.id = p.user_id ${whereSql}`
    )
      .bind(...binds)
      .first<{ c: number }>(),
    env.DB.prepare(
      `SELECT p.id, p.user_id, p.name, p.slug, p.description, p.icon, p.cover_key,
              p.visibility, p.review_note, p.views, p.likes, p.pinned_at,
              p.created_at, p.updated_at, p.published_at,
              COALESCE(NULLIF(u.nickname, ''), u.username) AS author_name,
              u.username AS author_username,
              u.avatar_key AS author_avatar
       FROM lab_projects p JOIN users u ON u.id = p.user_id
       ${whereSql}
       ORDER BY CASE WHEN p.pinned_at IS NULL THEN 1 ELSE 0 END ASC,
                p.pinned_at DESC, p.updated_at DESC
       LIMIT ? OFFSET ?`
    )
      .bind(...binds, GALLERY_PAGE_SIZE, (page - 1) * GALLERY_PAGE_SIZE)
      .all<AdminGalleryRow>(),
    // 状态筛选按钮上的数字：**不受当前筛选影响**，否则点了「公开」之后
    // 「私有 12」就变成 0，看上去像数据被删了
    env.DB.prepare("SELECT visibility, COUNT(*) AS c FROM lab_projects GROUP BY visibility")
      .all<{ visibility: string; c: number }>(),
  ])

  const byStatus: Record<string, number> = {}
  let all = 0
  for (const r of counts.results ?? []) {
    byStatus[r.visibility] = r.c
    all += r.c
  }

  return json({
    total: totalRow?.c ?? 0,
    page,
    pageSize: GALLERY_PAGE_SIZE,
    status,
    counts: {
      all,
      public: byStatus.public ?? 0,
      private: byStatus.private ?? 0,
      pending: byStatus.pending ?? 0,
      rejected: byStatus.rejected ?? 0,
    },
    items: (rows.results ?? []).map(toAdminGalleryJson),
  })
}

/**
 * 取授权后的作品行（管理端所有单件操作的**唯一**入口）。
 *
 * 顺序不能反：先过 `requireAdminScope`，再按 id 取行 ——
 * 反过来的话，一个普通用户请求任何 id 都会先看到「作品不存在」，
 * 而管理员才拿到权限错误，等于把「id 是否存在」变成一个可探测的信号。
 */
async function loadProjectForAdmin(
  env: Env,
  request: Request,
  projectId: string
): Promise<LabProjectRow> {
  await requireAdminScope(env, request, "lab")
  return loadProjectById(env, projectId)
}

/** GET /api/admin/lab/gallery/:id/domain —— 当前绑定的域名（编辑弹窗打开时拉） */
export async function getGalleryProjectDomain(
  env: Env,
  request: Request,
  projectId: string
): Promise<Response> {
  await loadProjectForAdmin(env, request, projectId)
  return json({ fqdn: await getBoundDomain(env, projectId) })
}

/**
 * PUT /api/admin/lab/gallery/:id/domain —— 绑定 / 改绑。
 *
 * 归属与权益仍按**作者**算（`bindProjectDomain` 内部就是这样）：
 * 管理员能替作者操作，但不会因此把作品绑到别人名下的子域上。
 */
export async function setGalleryProjectDomain(
  env: Env,
  request: Request,
  projectId: string
): Promise<Response> {
  const admin = await requireAdminScope(env, request, "lab")
  const project = await loadProjectById(env, projectId)
  const body = (await request.json().catch(() => null)) as { fqdn?: unknown } | null
  // 作者行要拿 permissions：根域权益门禁按作者的权益判定，不按管理员的
  const owner = await env.DB.prepare("SELECT id, permissions FROM users WHERE id = ?")
    .bind(project.user_id)
    .first<{ id: string; permissions: string | null }>()
  if (!owner) throw new ApiError(404, "作品作者不存在", "NOT_FOUND")

  const fqdn = await bindProjectDomain(env, project, body?.fqdn, owner)
  await recordAudit(env, admin.id, "admin.lab_gallery", `绑定作品域名「${project.name}」→ ${fqdn}`)
  return json({ fqdn })
}

/** DELETE /api/admin/lab/gallery/:id/domain —— 解绑（Route 与 DNS 一并释放） */
export async function clearGalleryProjectDomain(
  env: Env,
  request: Request,
  projectId: string
): Promise<Response> {
  const admin = await requireAdminScope(env, request, "lab")
  const project = await loadProjectById(env, projectId)
  const released = await releaseProjectDomain(env, projectId)
  if (released) {
    await recordAudit(env, admin.id, "admin.lab_gallery", `解绑作品域名「${project.name}」← ${released}`)
  }
  return json({ fqdn: null })
}

/** POST /api/admin/lab/gallery/:id/cover —— 上传封面（与原图直传同一套闸） */
export async function uploadGalleryProjectCover(
  env: Env,
  request: Request,
  projectId: string
): Promise<Response> {
  const admin = await requireAdminScope(env, request, "lab")
  const project = await loadProjectById(env, projectId)
  const res = await saveCoverFromRequest(env, request, project)
  await recordAudit(env, admin.id, "admin.lab_gallery", `更换作品封面「${project.name}」`)
  return json(res)
}

/** DELETE /api/admin/lab/gallery/:id/cover —— 移除封面（回退 emoji） */
export async function deleteGalleryProjectCover(
  env: Env,
  request: Request,
  projectId: string
): Promise<Response> {
  const admin = await requireAdminScope(env, request, "lab")
  const project = await loadProjectById(env, projectId)
  await removeProjectCover(env, project)
  await recordAudit(env, admin.id, "admin.lab_gallery", `移除作品封面「${project.name}」`)
  return json({ hasCover: false })
}

/**
 * POST /api/admin/lab/gallery/:id/meta —— body: { name?, description?, icon? }
 *
 * 只改对外展示字段，**可见性一概不动**（改名顺手放行/撤下作品是事故，不是功能）。
 */
export async function updateGalleryProjectMeta(
  env: Env,
  request: Request,
  projectId: string
): Promise<Response> {
  const admin = await requireAdminScope(env, request, "lab")
  const project = await loadProjectById(env, projectId)
  const body = (await request.json().catch(() => null)) as {
    name?: unknown
    description?: unknown
    icon?: unknown
  } | null
  if (!body) throw new ApiError(400, "请求体不是合法 JSON", "INVALID_BODY")

  const updated = await updateProjectMeta(env, project, body)
  await recordAudit(env, admin.id, "admin.lab_gallery", `编辑作品信息「${updated.name}」`)
  return json({ project: toClientJson(updated) })
}

/** POST /api/admin/lab/gallery/:id/slug —— body: { slug }（撞名 409，消息原样给前端） */
export async function setGalleryProjectSlug(
  env: Env,
  request: Request,
  projectId: string
): Promise<Response> {
  const admin = await requireAdminScope(env, request, "lab")
  const project = await loadProjectById(env, projectId)
  const body = (await request.json().catch(() => null)) as { slug?: unknown } | null
  const slug = await applyProjectSlug(env, projectId, body?.slug)
  await recordAudit(env, admin.id, "admin.lab_gallery", `作品页面名「${project.name}」→ ${slug}`)
  return json({ ok: true, slug })
}

/**
 * POST /api/admin/lab/gallery/:id/visibility —— body: { visibility, note? }
 *
 * 直接设成四种状态之一（含绕过审核放行、或打回待审）。
 * 这是站长要的「能直接设置作品状态」—— 用户侧没有等价入口，
 * 那边只能「公开/取消公开」，落到 pending 还是 public 由站点设置决定。
 */
export async function setGalleryProjectVisibility(
  env: Env,
  request: Request,
  projectId: string
): Promise<Response> {
  const admin = await requireAdminScope(env, request, "lab")
  const project = await loadProjectById(env, projectId)
  const body = (await request.json().catch(() => null)) as {
    visibility?: unknown
    note?: unknown
  } | null
  if (!body) throw new ApiError(400, "请求体不是合法 JSON", "INVALID_BODY")
  const visibility = typeof body.visibility === "string" ? body.visibility : ""
  if (!(GALLERY_STATUSES as readonly string[]).includes(visibility)) {
    throw new ApiError(400, "状态只能是 public / private / pending / rejected", "INVALID_STATUS")
  }

  const updated = await setProjectVisibility(
    env,
    project,
    visibility as GalleryStatus,
    body.note
  )
  await recordAudit(
    env,
    admin.id,
    "admin.lab_gallery",
    `作品状态「${project.name}」：${project.visibility} → ${updated.visibility}`
  )
  return json({ project: toClientJson(updated) })
}

/**
 * DELETE /api/admin/lab/gallery/:id —— 删掉别人的作品。
 *
 * 清理范围与作者自己删时**完全一致**（同一个 `deleteProjectCascade`）：
 * 作品行、点赞明细、绑定域名（DB 行 + Worker Route + AAAA 记录）、R2 文件、封面对象。
 * 少清一样就会留下永久垃圾：域名那条尤其是事故级（占满 zone 的记录配额）。
 */
export async function deleteGalleryProject(
  env: Env,
  request: Request,
  projectId: string
): Promise<Response> {
  const admin = await requireAdminScope(env, request, "lab")
  const project = await loadProjectById(env, projectId)
  await deleteProjectCascade(env, project)
  await recordAudit(
    env,
    admin.id,
    "admin.lab_gallery",
    `删除作品「${project.name}」（作者 ${project.user_id}）`
  )
  return new Response(null, { status: 204 })
}

