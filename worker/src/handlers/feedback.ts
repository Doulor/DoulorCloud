/**
 * 用户反馈（私有工单）。
 *
 * 用户在控制台「反馈」页提交一条反馈，管理员在管理面板「反馈」标签查看并回复；
 * 回复写回同一条记录，用户在反馈页看到（同时落一条站内通知）。
 *
 * 为什么是「私有工单」而不是复用社区帖子：见 migrations/0051_feedback.sql 的说明。
 *
 * 三条边界（写在这里免得后来者改坏）：
 *   1. 作者只能看/操作自己的记录 —— 所有查询都带 `user_id = ?`，不做「按 id 取」；
 *   2. 回复与改状态只有管理员能做（requireAdmin）；
 *   3. 提交有频次上限（guardRateLimit），否则就是一条无限灌库的写接口。
 */
import { ApiError, json, readBodyCapped } from "../http"
import { requireUser, isPrivileged } from "../auth"
import { requireAdmin } from "./admin"
import { uuid } from "../crypto"
import { guardRateLimit } from "../ratelimit"
import { getSetting, audit as recordAudit } from "../settings"
import { sendMail, renderMail } from "../mailer"
import { applyPoints } from "../points"
import { isStorageConfigured, putObject, getObject, deleteObject, getPlatformBucketId } from "../r2"
import { hardenUserContentResponse } from "../content-type"
import type { Env } from "../env"

/**
 * 反馈分类。
 *
 * 顺序即前端下拉/标签的展示顺序：从「我出问题了」到「我想要个新东西」再到兜底。
 * 键名用英文短词（存库、做索引都稳），中文标签由 `FEEDBACK_CATEGORY_LABELS`
 * 统一提供 —— 前端不硬编码标签，避免两边文案漂移。
 */
export const FEEDBACK_CATEGORIES = ["bug", "feature", "donation", "other"] as const
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number]

export const FEEDBACK_CATEGORY_LABELS: Record<string, string> = {
  bug: "问题反馈",
  feature: "功能建议",
  donation: "资源捐献",
  other: "其他",
}

/** 工单状态。`processing` 与 `resolved` 的区别是「还在弄」与「弄完了」。 */
export const FEEDBACK_STATUSES = ["pending", "processing", "resolved", "closed"] as const
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number]

export const FEEDBACK_STATUS_LABELS: Record<string, string> = {
  pending: "待处理",
  processing: "处理中",
  resolved: "已处理",
  closed: "已关闭",
}

/** 标题 / 正文长度上限（与前端输入框的 maxLength 保持一致） */
const MAX_TITLE = 80
const MAX_BODY = 2000
/** 管理员回复上限 */
const MAX_REPLY = 2000
/** 单次反馈回复最多附带多少积分奖励（防手滑多打一个 0） */
const MAX_FEEDBACK_REWARD = 10_000
/** 请求体上限：正文 2000 字按 UTF-8 最多 3 字节/字，留一倍余量 */
const MAX_JSON_BODY_BYTES = 32 * 1024
/** 一次最多返回多少条（前端不做分页：单用户反馈量本就很小） */
const LIST_LIMIT = 50

// ---- 反馈图片 ----
/** 单张图片大小上限（5 MB，报错文案用） */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** 一次最多带几张图（提交 + 每条对话消息共用） */
const MAX_FEEDBACK_IMAGES = 9
/** 允许的图片 MIME → 扩展名 */
const IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
}
/** 图片 key 形如 feedback/<userId>/<uuid>.<ext>；匹配后 m[1]=userId m[2]=文件名 */
const FEEDBACK_IMG_KEY_RE =
  /^feedback\/([^/]+)\/([A-Za-z0-9-]+\.(jpg|jpeg|png|webp|gif))$/i

/** 把 R2 key 转成可访问的 URL（/api/feedback/image/<userId>/<filename>） */
function imageKeyToUrl(key: string): string {
  const m = FEEDBACK_IMG_KEY_RE.exec(key)
  return m ? `/api/feedback/image/${m[1]}/${m[2]}` : ""
}

/** 解析 images 列（JSON 数组），脏数据/坏 JSON 一律回空数组，不抛 */
function parseImageKeys(raw: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

/**
 * 校验并规范化前端提交的图片 key 数组。
 * 只接受「feedback/<当前userId>/<uuid>.<ext>」——userId 不是本人的一律丢弃，
 * 杜绝把别人上传的图片塞进自己的工单；并截断到 MAX_FEEDBACK_IMAGES。
 */
function normalizeImageKeys(raw: unknown, userId: string): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const v of raw) {
    if (typeof v !== "string") continue
    const m = FEEDBACK_IMG_KEY_RE.exec(v)
    if (!m || m[1] !== userId) continue
    out.push(v)
    if (out.length >= MAX_FEEDBACK_IMAGES) break
  }
  return out
}

/** key 数组 → url 数组（供 DTO 下发） */
function imageKeysToUrls(keys: string[]): string[] {
  return keys.map(imageKeyToUrl).filter(Boolean)
}

interface FeedbackRow {
  id: string
  user_id: string
  category: string
  title: string
  body: string
  /** 首次提交附带的图片 key（JSON 数组），可能为 NULL */
  images: string | null
  status: string
  admin_reply: string | null
  replied_at: string | null
  user_read: number
  created_at: string
  updated_at: string
  /** 联表取的用户名（管理端列表用） */
  username?: string
  nickname?: string | null
}

/** 用户视角的 DTO：**不含** user_id / replied_by 等内部字段 */
function toMine(r: FeedbackRow) {
  return {
    id: r.id,
    category: r.category,
    title: r.title,
    body: r.body,
    images: imageKeysToUrls(parseImageKeys(r.images)),
    status: r.status,
    adminReply: r.admin_reply,
    repliedAt: r.replied_at,
    // 只有真的回复过才谈「已读」
    replyRead: r.admin_reply ? r.user_read === 1 : false,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** 管理端 DTO：多带作者与「有没有未读回复」之外的管理信息 */
function toAdmin(r: FeedbackRow) {
  return {
    ...toMine(r),
    userId: r.user_id,
    username: r.username ?? "",
    nickname: r.nickname ?? null,
  }
}

/** 对话中的一条消息（用户或管理员的追加回复） */
interface FeedbackMessageDto {
  id: string
  senderId: string
  isAdmin: boolean
  body: string
  images: string[]
  createdAt: string
}

/** 批量加载一批反馈的对话消息（按时间正序，一次查询避免 N+1） */
async function loadMessagesFor(
  env: Env,
  feedbackIds: string[]
): Promise<Map<string, FeedbackMessageDto[]>> {
  const map = new Map<string, FeedbackMessageDto[]>()
  if (feedbackIds.length === 0) return map
  const placeholders = feedbackIds.map(() => "?").join(",")
  const rows = await env.DB.prepare(
    `SELECT id, feedback_id, sender_id, is_admin, body, images, created_at
       FROM feedback_messages WHERE feedback_id IN (${placeholders})
      ORDER BY created_at ASC`
  )
    .bind(...feedbackIds)
    .all<{
      id: string
      feedback_id: string
      sender_id: string
      is_admin: number
      body: string
      images: string | null
      created_at: string
    }>()
  for (const r of rows.results ?? []) {
    if (!map.has(r.feedback_id)) map.set(r.feedback_id, [])
    map.get(r.feedback_id)!.push({
      id: r.id,
      senderId: r.sender_id,
      isAdmin: r.is_admin === 1,
      body: r.body,
      images: imageKeysToUrls(parseImageKeys(r.images)),
      createdAt: r.created_at,
    })
  }
  return map
}

function parseCategory(raw: unknown): FeedbackCategory {
  return typeof raw === "string" && (FEEDBACK_CATEGORIES as readonly string[]).includes(raw)
    ? (raw as FeedbackCategory)
    : "other"
}

/** 读 JSON 体（带体积上限，避免超大正文把 D1 写爆） */
async function readJson(request: Request): Promise<Record<string, unknown>> {
  const buf = await readBodyCapped(
    request,
    MAX_JSON_BODY_BYTES,
    "内容过长，请精简后再提交"
  )
  try {
    const parsed = JSON.parse(new TextDecoder().decode(buf))
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
  } catch {
    throw new ApiError(400, "请求格式不正确", "INVALID_JSON")
  }
}

// ---- 用户端 ----

/**
 * GET /api/feedback —— 我提交过的反馈（按时间倒序）。
 *
 * 不分页：单用户的反馈量天然很小（提交本身有频次限制），
 * 分页只会给前端加一套游标状态却没有任何收益。
 */
export async function listMyFeedback(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const rows = await env.DB.prepare(
    `SELECT * FROM feedback WHERE user_id = ? ORDER BY created_at DESC LIMIT ${LIST_LIMIT}`
  )
    .bind(user.id)
    .all<FeedbackRow>()

  const items = rows.results ?? []
  const msgs = await loadMessagesFor(env, items.map((r) => r.id))
  return json({
    feedback: items.map((r) => ({ ...toMine(r), messages: msgs.get(r.id) ?? [] })),
    categories: FEEDBACK_CATEGORIES.map((k) => ({ key: k, label: FEEDBACK_CATEGORY_LABELS[k] })),
    statusLabels: FEEDBACK_STATUS_LABELS,
    // 侧边栏/页面角标：管理员回复过、但我还没读的条数
    unreadReplies: items.filter((r) => r.admin_reply && r.user_read === 0).length,
  })
}

/** POST /api/feedback —— 提交一条反馈 */
export async function createFeedback(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  // 每小时 10 条：正常用户够用，刷屏/灌库会被挡住
  await guardRateLimit(env, `feedback:user:${user.id}`, 10, 3600, "提交反馈过于频繁")

  const body = await readJson(request)
  const title = String(body.title ?? "").trim().slice(0, MAX_TITLE)
  const text = String(body.body ?? "").trim().slice(0, MAX_BODY)
  if (!title || !text) {
    throw new ApiError(400, "标题和内容不能为空", "INVALID_INPUT")
  }
  // 图片 key 必须属于本人（normalizeImageKeys 已按 userId 过滤），空数组则存 NULL
  const imageKeys = normalizeImageKeys(body.images, user.id)

  const id = uuid()
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO feedback (id, user_id, category, title, body, images, status, user_read, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`
  )
    .bind(id, user.id, parseCategory(body.category), title, text, imageKeys.length ? JSON.stringify(imageKeys) : null, now, now)
    .run()

  const row = await env.DB.prepare("SELECT * FROM feedback WHERE id = ?")
    .bind(id)
    .first<FeedbackRow>()

  // 管理员邮件通知：反馈不像捐献那样「自动通过就不用打扰」，每条都发一封。
  // 发信失败不影响提交本身（反馈已落库），只记日志，避免 D1 抖动让用户以为没提交上。
  // 支持多个邮箱：用逗号/换行/空格分隔，逐个发送。
  try {
    const raw = (await getSetting(env, "feedback_admin_notify_email")).trim()
    if (raw) {
      const recipients = raw
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter(Boolean)
      const lines = [
        `用户：${user.username}`,
        `分类：${FEEDBACK_CATEGORY_LABELS[parseCategory(body.category)] ?? "其他"}`,
        `标题：${title}`,
        `内容：${text}`,
        "请到 Doulor Cloud 管理面板「反馈」处理。",
      ]
      const { text: mailText, html } = renderMail("新的用户反馈", lines)
      for (const to of recipients) {
        try {
          await sendMail(env, {
            to,
            subject: `【Doulor Cloud】新的用户反馈（${user.username}）`,
            text: mailText,
            html,
          })
        } catch (err) {
          console.error("反馈管理员通知失败:", to, err)
        }
      }
    }
  } catch (err) {
    console.error("反馈管理员通知失败:", err)
  }

  return json({ feedback: toMine(row as FeedbackRow) }, 201)
}

/** PATCH /api/feedback/:id —— 编辑自己还没被处理的反馈（只有 pending 可编辑） */
export async function editMyFeedback(env: Env, request: Request, id: string): Promise<Response> {
  const user = await requireUser(env, request)
  const row = await env.DB.prepare("SELECT * FROM feedback WHERE id = ? AND user_id = ?")
    .bind(id, user.id)
    .first<FeedbackRow>()
  if (!row) throw new ApiError(404, "反馈不存在", "NOT_FOUND")
  if (row.status !== "pending") {
    throw new ApiError(400, "该反馈已被处理，无法再编辑", "NOT_EDITABLE")
  }

  const body = await readJson(request)
  const title = String(body.title ?? "").trim().slice(0, MAX_TITLE)
  const text = String(body.body ?? "").trim().slice(0, MAX_BODY)
  if (!title || !text) throw new ApiError(400, "标题和内容不能为空", "INVALID_INPUT")
  // 图片：显式传了 images 数组才替换；不传则保留原图（编辑文字不丢图）
  const imageKeys = Array.isArray(body.images)
    ? normalizeImageKeys(body.images, user.id)
    : parseImageKeys(row.images)

  const now = new Date().toISOString()
  await env.DB.prepare(
    "UPDATE feedback SET category = ?, title = ?, body = ?, images = ?, updated_at = ? " +
      "WHERE id = ? AND user_id = ?"
  )
    .bind(
      parseCategory(body.category),
      title,
      text,
      imageKeys.length ? JSON.stringify(imageKeys) : null,
      now,
      id,
      user.id
    )
    .run()

  const fresh = await env.DB.prepare("SELECT * FROM feedback WHERE id = ?")
    .bind(id)
    .first<FeedbackRow>()
  return json({ feedback: toMine(fresh as FeedbackRow) })
}

/** DELETE /api/feedback/:id —— 撤销（删除）自己还没被处理的反馈 */
export async function withdrawMyFeedback(env: Env, request: Request, id: string): Promise<Response> {
  const user = await requireUser(env, request)
  const existing = await env.DB.prepare(
    "SELECT id, status, images FROM feedback WHERE id = ? AND user_id = ?"
  )
    .bind(id, user.id)
    .first<{ id: string; status: string; images: string | null }>()
  if (!existing) throw new ApiError(404, "反馈不存在", "NOT_FOUND")
  if (existing.status !== "pending") {
    throw new ApiError(400, "该反馈已被处理，无法撤销", "NOT_EDITABLE")
  }

  // 收集首帖 + 各条对话消息引用的图片 key，去重后统一删（与 admin deleteFeedback 一致）
  const keys = new Set<string>(parseImageKeys(existing.images))
  const msgRows = await env.DB.prepare(
    "SELECT images FROM feedback_messages WHERE feedback_id = ?"
  )
    .bind(id)
    .all<{ images: string | null }>()
  for (const r of msgRows.results ?? []) {
    for (const k of parseImageKeys(r.images)) keys.add(k)
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM feedback_messages WHERE feedback_id = ?").bind(id),
    env.DB.prepare("DELETE FROM feedback WHERE id = ? AND user_id = ?").bind(id, user.id),
  ])

  if (keys.size > 0 && (await isStorageConfigured(env))) {
    const bucketId = await getPlatformBucketId(env)
    for (const key of keys) {
      try {
        await deleteObject(env, key, bucketId)
      } catch (err) {
        console.error("删除反馈图片失败:", key, err)
      }
    }
  }

  return json({ ok: true })
}

/**
 * POST /api/feedback/upload-image —— 上传一张反馈图片。
 *
 * 图片在「提交反馈 / 追加回复」之前先上传拿到 key（否则要等建单才有 id，体验割裂）。
 * key = feedback/<userId>/<uuid>.<ext>，userId 编码进 key，读取时据此 O(1) 鉴权。
 * 返回 { key }，前端提交/回复时把 key 数组带上。
 */
export async function uploadFeedbackImage(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  // 每次上传都写 R2，取 40 次/分钟（与社区图片一致）
  await guardRateLimit(env, `feedback-image:${user.id}`, 40, 60, "图片上传过于频繁")
  if (!(await isStorageConfigured(env))) throw new ApiError(503, "存储未配置", "R2_NOT_CONFIGURED")

  const ct = (request.headers.get("Content-Type") ?? "").split(";")[0].trim()
  const ext = IMAGE_TYPES[ct]
  if (!ext) throw new ApiError(400, "仅支持 JPG/PNG/WebP/GIF", "INVALID_TYPE")

  const buf = await readBodyCapped(
    request,
    MAX_IMAGE_BYTES,
    `图片需在 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB 以内`,
    400,
    "TOO_LARGE"
  )
  if (buf.byteLength === 0) {
    throw new ApiError(400, `图片需在 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB 以内`, "TOO_LARGE")
  }

  const bucketId = await getPlatformBucketId(env)
  const filename = `${uuid()}.${ext}`
  const key = `feedback/${user.id}/${filename}`
  await putObject(env, key, buf, ct, bucketId)

  return json({ key }, 201)
}

/**
 * GET /api/feedback/image/<userId>/<filename> —— 读取反馈图片（需登录）。
 *
 * 反馈是私有工单，图片也必须私有：只有上传者本人与管理员能看。
 * userId 在 key 里，鉴权 O(1)，不用查「图片属于哪条反馈」。
 */
export async function serveFeedbackImage(
  env: Env,
  request: Request,
  userId: string,
  filename: string
): Promise<Response> {
  const user = await requireUser(env, request)
  if (user.id !== userId && !isPrivileged(user.role)) {
    throw new ApiError(403, "无权查看该图片", "FORBIDDEN")
  }
  // 文件名只允许 <uuid>.<ext>，防路径穿越
  if (!/^[A-Za-z0-9-]+\.(jpg|jpeg|png|webp|gif)$/i.test(filename)) {
    return new Response("Not Found", { status: 404 })
  }
  if (!(await isStorageConfigured(env))) return new Response("Not Found", { status: 404 })
  const bucketId = await getPlatformBucketId(env)
  const key = `feedback/${userId}/${filename}`
  try {
    const res = await getObject(env, key, undefined, bucketId)
    // 类型收口 + nosniff，与社区图片读取一致（纵深防御）
    return hardenUserContentResponse(res, filename)
  } catch {
    return new Response("Not Found", { status: 404 })
  }
}

/**
 * POST /api/feedback/read —— 把「我的反馈」里所有未读回复标记为已读。
 *
 * 做成「全部已读」而不是按 id：用户点进反馈页的语义就是「我看到了」，
 * 逐条勾选只会多出一堆点击。回复本身不会撤回，全部标记没有副作用。
 */
export async function markFeedbackRead(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const res = await env.DB.prepare(
    "UPDATE feedback SET user_read = 1 WHERE user_id = ? AND user_read = 0 AND admin_reply IS NOT NULL"
  )
    .bind(user.id)
    .run()
  return json({ ok: true, updated: res.meta?.changes ?? 0 })
}

/**
 * POST /api/feedback/reply —— 用户对某条反馈追加回复（对话式）。
 *
 * 只有作者本人能追加。追加后：
 *   · 落一条 feedback_messages（is_admin=0）；
 *   · 若工单已 resolved/closed，重置回 processing（用户在继续沟通 = 还没完）；
 *   · 把 user_read 置 0 让管理员侧知道「作者又说话了」（管理员靠管理面板的列表看到）。
 */
export async function replyMyFeedback(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = await readJson(request)
  const id = String(body.id ?? "").trim()
  const text = String(body.reply ?? "").trim().slice(0, MAX_REPLY)
  const imageKeys = normalizeImageKeys(body.images, user.id)
  if (!id) throw new ApiError(400, "缺少反馈 id", "INVALID_INPUT")
  if (!text && imageKeys.length === 0) throw new ApiError(400, "回复内容不能为空", "INVALID_INPUT")

  const existing = await env.DB.prepare(
    "SELECT * FROM feedback WHERE id = ? AND user_id = ?"
  )
    .bind(id, user.id)
    .first<FeedbackRow>()
  if (!existing) throw new ApiError(404, "反馈不存在", "NOT_FOUND")

  const now = new Date().toISOString()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO feedback_messages (id, feedback_id, sender_id, is_admin, body, images, created_at)
       VALUES (?, ?, ?, 0, ?, ?, ?)`
    ).bind(uuid(), id, user.id, text, imageKeys.length ? JSON.stringify(imageKeys) : null, now),
    // 已处理/已关闭的工单，作者又回复 → 回到处理中（还在沟通）
    env.DB.prepare(
      `UPDATE feedback SET user_read = 0, status = CASE WHEN status IN ('resolved','closed') THEN 'processing' ELSE status END, updated_at = ? WHERE id = ?`
    ).bind(now, id),
  ])

  // 邮件通知管理员（有新回复）—— 走多通道；失败不阻断追加本身
  try {
    const target = (await getSetting(env, "feedback_admin_notify_email")).trim()
    if (target) {
      const recipients = target.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean)
      const { text: mailText, html } = renderMail("反馈有新回复", [
        `用户 ${user.username} 对反馈「${existing.title}」追加了回复：`,
        text,
        "请到管理面板「反馈」查看并继续处理。",
      ])
      for (const to of recipients) {
        try {
          await sendMail(env, {
            to,
            subject: `【Doulor Cloud】反馈「${existing.title}」有新回复`,
            text: mailText,
            html,
          })
        } catch (err) {
          console.error("反馈追加回复通知管理员失败:", to, err)
        }
      }
    }
  } catch (err) {
    console.error("反馈追加回复通知失败:", id, err)
  }

  const row = await env.DB.prepare("SELECT * FROM feedback WHERE id = ?")
    .bind(id)
    .first<FeedbackRow>()
  const msgs = await loadMessagesFor(env, [id])
  return json({ feedback: { ...toMine(row as FeedbackRow), messages: msgs.get(id) ?? [] } })
}

// ---- 管理端 ----

/**
 * GET /api/admin/feedback —— 全部反馈（可按状态过滤）。
 *
 * 联表取作者名：管理端列表要能看出「谁提的」，但只有 username/nickname
 * 两个字段，不带邮箱等更多隐私信息（需要时点进用户详情看）。
 */
export async function listAllFeedback(env: Env, request: Request): Promise<Response> {
  await requireAdmin(env, request)
  const url = new URL(request.url)
  const status = url.searchParams.get("status") ?? ""

  const where = (FEEDBACK_STATUSES as readonly string[]).includes(status)
    ? "WHERE f.status = ?"
    : ""
  const stmt = env.DB.prepare(
    `SELECT f.*, u.username AS username, u.nickname AS nickname
       FROM feedback f
       LEFT JOIN users u ON u.id = f.user_id
       ${where}
      ORDER BY
        -- 未处理的排在最前（待处理 → 处理中 → 已处理/已关闭），同组内按时间倒序
        CASE f.status WHEN 'pending' THEN 0 WHEN 'processing' THEN 1 ELSE 2 END,
        f.created_at DESC
      LIMIT 200`
  )
  const rows = where ? await stmt.bind(status).all<FeedbackRow>() : await stmt.all<FeedbackRow>()

  // 各状态计数（用于管理端的过滤标签上显示数量）
  const counts = await env.DB.prepare(
    "SELECT status, COUNT(*) AS c FROM feedback GROUP BY status"
  ).all<{ status: string; c: number }>()
  const countMap: Record<string, number> = {}
  for (const r of counts.results ?? []) countMap[r.status] = r.c

  const items = rows.results ?? []
  const msgs = await loadMessagesFor(env, items.map((r) => r.id))
  return json({
    feedback: items.map((r) => ({ ...toAdmin(r), messages: msgs.get(r.id) ?? [] })),
    counts: countMap,
    categories: FEEDBACK_CATEGORIES.map((k) => ({ key: k, label: FEEDBACK_CATEGORY_LABELS[k] })),
    statusLabels: FEEDBACK_STATUS_LABELS,
  })
}

/**
 * POST /api/admin/feedback/reply —— 回复一条反馈。
 *
 * 回复会**顺带把状态推到 resolved**（除非显式传 status 覆盖）：
 * 「已回复」在用户眼里就是「处理完了」，还停在 pending 会让用户以为没人管。
 * 管理员若只想留个话、把单子挂起，可以显式传 status=processing。
 */
export async function replyFeedback(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdmin(env, request)
  const body = await readJson(request)
  const id = String(body.id ?? "").trim()
  const reply = String(body.reply ?? "").trim().slice(0, MAX_REPLY)
  const imageKeys = normalizeImageKeys(body.images, admin.id)
  if (!id) throw new ApiError(400, "缺少反馈 id", "INVALID_INPUT")
  if (!reply) throw new ApiError(400, "回复内容不能为空", "INVALID_INPUT")

  const status = (FEEDBACK_STATUSES as readonly string[]).includes(String(body.status))
    ? String(body.status)
    : "resolved"

  const existing = await env.DB.prepare("SELECT * FROM feedback WHERE id = ?")
    .bind(id)
    .first<FeedbackRow>()
  if (!existing) throw new ApiError(404, "反馈不存在", "NOT_FOUND")

  const now = new Date().toISOString()
  // user_read 重置为 0：回复是新内容，作者需要重新「看到」
  await env.DB.prepare(
    `UPDATE feedback
        SET admin_reply = ?, replied_at = ?, replied_by = ?, status = ?, user_read = 0, updated_at = ?
      WHERE id = ?`
  )
    .bind(reply, now, admin.id, status, now, id)
    .run()

  // 落一条对话消息（管理员这条）
  await env.DB.prepare(
    `INSERT INTO feedback_messages (id, feedback_id, sender_id, is_admin, body, images, created_at)
     VALUES (?, ?, ?, 1, ?, ?, ?)`
  )
    .bind(uuid(), id, admin.id, reply, imageKeys.length ? JSON.stringify(imageKeys) : null, now)
    .run()

  // 可选：回复时**顺手给作者发一笔积分奖励**（2026-10-01 站长要求）。
  //
  // 走 `applyPoints()` 这个唯一入口，reason 用 `admin`：
  //   - `admin` **不在** COMMISSIONABLE_REASONS 白名单里 ⇒ 不会触发邀请返佣
  //     （平台白送的积分再往外分钱没有道理）；
  //   - dedupKey 钉在**反馈 id** 上 ⇒ 同一张单子重复回复只会发一次。
  //     这是刻意的：避免手滑发两遍。想追加奖励得走「积分 → 用户」那边手工发。
  const rewardAmount = Math.floor(Number(body.rewardPoints))
  let reward: { amount: number; balance: number; duplicated: boolean } | null = null
  if (Number.isFinite(rewardAmount) && rewardAmount > 0) {
    if (rewardAmount > MAX_FEEDBACK_REWARD) {
      throw new ApiError(
        400,
        `单次反馈奖励最多 ${MAX_FEEDBACK_REWARD} 积分`,
        "INVALID_INPUT"
      )
    }
    const applied = await applyPoints(env, {
      userId: existing.user_id,
      delta: rewardAmount,
      reason: "admin",
      detail: `反馈奖励：${existing.title}`.slice(0, 200),
      dedupKey: `feedback-reward:${id}`,
      createdBy: admin.id,
    })
    reward = {
      amount: rewardAmount,
      balance: applied.balance,
      // 幂等命中 = 之前已经给这张单子发过奖励了（管理员重复点保存）
      duplicated: !applied.applied && applied.reason === "duplicated",
    }
  }

  // 落一条站内通知：作者不一定在反馈页，通知能保证他看到
  try {
    await env.DB.prepare(
      `INSERT INTO notifications (id, user_id, type, actor_id, post_id, comment_id, read, created_at)
       VALUES (?, ?, 'feedback_reply', ?, NULL, NULL, 0, ?)`
    )
      .bind(uuid(), existing.user_id, admin.id, now)
      .run()
  } catch (err) {
    console.error("写入反馈回复通知失败:", err)
  }

  // 邮件通知作者（个人相关通知；尊重 notify_enabled 开关，失败不阻断回复）
  try {
    const author = await env.DB.prepare(
      "SELECT email, notify_enabled FROM users WHERE id = ?"
    )
      .bind(existing.user_id)
      .first<{ email: string; notify_enabled: number }>()
    if (author && author.notify_enabled === 1 && author.email) {
      const { text, html } = renderMail("你的反馈有新回复", [
        `你在 Doulor Cloud 提交的反馈「${existing.title}」收到了管理员的回复：`,
        reply,
        // 只有真的发出去（不是幂等命中）才提奖励，否则会重复告诉用户
        ...(reward && !reward.duplicated
          ? [`另外，感谢你的反馈，已赠送 ${reward.amount} 积分（当前余额 ${reward.balance}）。`]
          : []),
        "可到控制台「反馈」页查看并继续回复。",
      ])
      await sendMail(env, {
        to: author.email,
        subject: `【Doulor Cloud】你的反馈「${existing.title}」有新回复`,
        text,
        html,
      })
    }
  } catch (err) {
    console.error("反馈回复邮件通知失败:", existing.id, err)
  }
  const row = await env.DB.prepare(
    `SELECT f.*, u.username AS username, u.nickname AS nickname
       FROM feedback f LEFT JOIN users u ON u.id = f.user_id WHERE f.id = ?`
  )
    .bind(id)
    .first<FeedbackRow>()
  return json({ feedback: toAdmin(row as FeedbackRow), reward })
}

/**
 * POST /api/admin/feedback/status —— 只改状态（不回复）。
 *
 * 与 reply 分开是因为两者语义不同：这里用于「我看过了，先挂起/关闭」，
 * 不产生给用户看的正文。若同时要回复，走 reply。
 */
export async function setFeedbackStatus(env: Env, request: Request): Promise<Response> {
  await requireAdmin(env, request)
  const body = await readJson(request)
  const id = String(body.id ?? "").trim()
  const status = String(body.status ?? "").trim()
  if (!id) throw new ApiError(400, "缺少反馈 id", "INVALID_INPUT")
  if (!(FEEDBACK_STATUSES as readonly string[]).includes(status)) {
    throw new ApiError(400, "无效的状态", "INVALID_INPUT")
  }

  const existing = await env.DB.prepare("SELECT id FROM feedback WHERE id = ?")
    .bind(id)
    .first<{ id: string }>()
  if (!existing) throw new ApiError(404, "反馈不存在", "NOT_FOUND")

  await env.DB.prepare("UPDATE feedback SET status = ?, updated_at = ? WHERE id = ?")
    .bind(status, new Date().toISOString(), id)
    .run()
  return json({ ok: true, status })
}

/**
 * POST /api/admin/feedback/delete —— 删除一条反馈（连带其对话消息与上传图片）。
 *
 * 删除不可逆，所以级联清理三处，避免留孤儿数据：
 *   1. `feedback_messages` 里该工单的全部对话消息；
 *   2. R2 里该工单引用过的图片（首帖 images + 每条消息 images）；
 *   3. `feedback` 行本身。
 *
 * 顺序：先删库再删图片 —— 用户侧立即看不到工单，图片清理是收尾。
 * 图片删除走 best-effort：单张失败只记日志、不阻断整单删除，
 * 否则「一张图删不掉就永远删不了单」，反而把管理员卡死。
 *
 * 备注：站内通知 `feedback_reply` 没有存 feedback id（只有 post_id/comment_id，
 * 反馈场景下为 NULL），无法精确回删，且它只是指向反馈页的入口，不会因删除而报错，故不处理。
 */
export async function deleteFeedback(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdmin(env, request)
  const body = await readJson(request)
  const id = String(body.id ?? "").trim()
  if (!id) throw new ApiError(400, "缺少反馈 id", "INVALID_INPUT")

  const existing = await env.DB.prepare(
    "SELECT id, title, user_id, images FROM feedback WHERE id = ?"
  )
    .bind(id)
    .first<{ id: string; title: string; user_id: string; images: string | null }>()
  if (!existing) throw new ApiError(404, "反馈不存在", "NOT_FOUND")

  // 收集该工单引用过的全部图片 key（首帖 + 各条对话消息），去重后统一删
  const keys = new Set<string>(parseImageKeys(existing.images))
  const msgRows = await env.DB.prepare(
    "SELECT images FROM feedback_messages WHERE feedback_id = ?"
  )
    .bind(id)
    .all<{ images: string | null }>()
  for (const r of msgRows.results ?? []) {
    for (const k of parseImageKeys(r.images)) keys.add(k)
  }

  // 先删库：消息与工单一起删（batch 保证同一事务语义）
  await env.DB.batch([
    env.DB.prepare("DELETE FROM feedback_messages WHERE feedback_id = ?").bind(id),
    env.DB.prepare("DELETE FROM feedback WHERE id = ?").bind(id),
  ])

  // 再尽力清图片；未配置存储则跳过（无图可删）
  let deletedImages = 0
  if (keys.size > 0 && (await isStorageConfigured(env))) {
    const bucketId = await getPlatformBucketId(env)
    for (const key of keys) {
      try {
        await deleteObject(env, key, bucketId)
        deletedImages++
      } catch (err) {
        console.error("删除反馈图片失败:", key, err)
      }
    }
  }

  await recordAudit(
    env,
    admin.id,
    "admin.feedback.delete",
    `删除反馈「${existing.title}」（作者 ${existing.user_id}）`,
    request.headers.get("CF-Connecting-IP")
  )

  return json({ ok: true, deletedImages })
}
