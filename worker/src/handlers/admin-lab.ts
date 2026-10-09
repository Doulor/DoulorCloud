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
import { readFiles, type LabProjectRow } from "./lab"
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
