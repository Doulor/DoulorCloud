/**
 * 造物集评论区（2026-10-21）。
 *
 * ## 与社区广场「完全一致」
 * 站长要求评论区的外观与能力跟社区广场一模一样，所以这里返回的**数据结构、
 * 权限口径、业务规则**全部对齐 `handlers/community.ts`：
 *   · `author` 是嵌套对象（含角色/称号/头像），不是拍平的三个字段；
 *   · 已删除评论**保留占位**（body 清空）而不是从列表剔除 —— 否则它下面的回复
 *     会被建树逻辑提成根节点，盖楼上下文全乱；
 *   · 点赞复用 `post_likes`（多态表，`target_type='gallery_comment'`）；
 *   · 编辑次数上限复用设置 `community_comment_edit_limit`；
 *   · 高赞阈值复用 `hotCommentThreshold()` —— 站内「评论」这个概念一个口径，
 *     不因为挂在帖子下还是造物集下面就换算法。
 *
 * ## 评论按**单个作品**隔离
 * `gallery_comments.project_id` → `lab_projects(id)`。三条读写接口都先过
 * `loadCommentableProject()`（判据与 `getGalleryItem` 完全相同），
 * 且父评论必须属于同一作品 —— 否则可以把 A 作品的评论串到 B 作品下。
 *
 * ## 与社区唯一的实质差异
 * 不发站内通知：造物集以展示为主，先不引入通知噪音。
 * 其余行为（幂等点赞、软删除清空正文、编辑乐观锁）全部照抄。
 */
import { ApiError, json, assertContentLengthWithin } from "../http"
import { requireUser, isPrivileged } from "../auth"
import {
  groupComments,
  canPostAgain,
  type RawComment,
} from "../community-logic"
// 复用社区的三个口径，避免两份实现漂移
import { titleOf, hotCommentThreshold, commentEditLimit } from "./community"
import { uuid } from "../crypto"
import type { Env } from "../env"

/** 与社区广场同一口径：一条评论最多 1000 字 */
const MAX_BODY_CHARS = 1000
/** 与社区广场同一口径：同一用户两次评论最小间隔（秒） */
const COMMENT_COOLDOWN_SEC = 10
/** JSON 请求体上限 */
const MAX_JSON_BODY_BYTES = 64 * 1024
/** `post_likes.target_type` 里代表「造物集评论」的值 */
const LIKE_TARGET = "gallery_comment"

/**
 * 取「可评论的作品」，判据与 `getGalleryItem` 完全一致：
 *   `(id 或 slug 命中) AND (visibility='public' OR 本人)`
 *
 * 归一化后返回**真正的 id**：前端可能传 slug，评论必须落真 id，
 * 否则作品改 slug 后评论就跟丢了。
 */
async function loadCommentableProject(
  env: Env,
  viewerId: string,
  idOrSlug: string
): Promise<{ id: string; userId: string }> {
  const row = await env.DB.prepare(
    `SELECT id, user_id FROM lab_projects
      WHERE (id = ? OR slug = ?) AND (visibility = 'public' OR user_id = ?)`
  )
    .bind(idOrSlug, idOrSlug, viewerId)
    .first<{ id: string; user_id: string }>()
  if (!row) throw new ApiError(404, "作品不存在或未公开", "NOT_FOUND")
  return { id: row.id, userId: row.user_id }
}

/** 某条评论的最新赞数（点完赞回给前端，避免前端自己 ±1 算错） */
async function commentLikeCount(env: Env, commentId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT like_count FROM gallery_comments WHERE id = ?")
    .bind(commentId)
    .first<{ like_count: number }>()
  return Number(row?.like_count ?? 0)
}

/**
 * GET /api/gallery/:id/comments —— 列出某作品的评论（社区同款结构）。
 *
 * 返回的树已按「高赞优先 → 赞数 → 时间」排好（见 community-logic 的 groupComments）。
 */
export async function listGalleryComments(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const user = await requireUser(env, request)
  const project = await loadCommentableProject(env, user.id, id)

  // 联表口径与社区 listComments 一致：作者 + 称号 + 被回复者用户名
  const rows = await env.DB.prepare(
    `SELECT c.*, u.username, u.nickname, u.avatar_key, u.role AS author_role,
            ct.name AS title_name, ct.color_from AS title_color_from, ct.color_to AS title_color_to,
            ru.username AS reply_to_username
       FROM gallery_comments c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN users ru ON ru.id = c.reply_to_user_id
       LEFT JOIN user_titles ut ON ut.user_id = u.id AND ut.is_display = 1
       LEFT JOIN custom_titles ct ON ct.id = ut.title_id
      WHERE c.project_id = ?
      ORDER BY c.created_at ASC`
  )
    .bind(project.id)
    .all()

  const comments = (rows.results ?? []).map((c: Record<string, unknown>) => ({
    id: c.id as string,
    project_id: c.project_id as string,
    user_id: c.user_id as string,
    parent_id: (c.parent_id as string | null) ?? null,
    /**
     * 已删除的评论保留占位但正文清空（同社区）。
     * 删除时后端也会把 body 置空，这里再兜一层：即使历史数据残留，
     * 也绝不把已删除内容下发。
     */
    body: c.deleted_at ? "" : (c.body as string),
    deleted: c.deleted_at != null,
    editCount: Number(c.edit_count) || 0,
    updatedAt: (c.updated_at as string | null) ?? null,
    createdAt: c.created_at as string,
    author: {
      username: c.username as string,
      nickname: (c.nickname as string | null) ?? null,
      isAdmin: isPrivileged(c.author_role as string | null | undefined),
      isRoot: c.author_role === "root",
      hasAvatar: Boolean(c.avatar_key),
      customTitle: titleOf(c as { title_name?: string | null }),
    },
    replyTo: (c.reply_to_username as string | null) ?? null,
    likeCount: Number(c.like_count) || 0,
  }))

  // 「我点过赞没有」：一次 IN 查询（D1 绑定参数上限 100，留余量取前 90）
  const likedSet = new Set<string>()
  if (comments.length > 0) {
    const ids = comments.slice(0, 90).map((c) => c.id)
    const placeholders = ids.map(() => "?").join(",")
    const res = await env.DB.prepare(
      `SELECT target_id FROM post_likes
        WHERE user_id = ? AND target_type = ? AND target_id IN (${placeholders})`
    )
      .bind(user.id, LIKE_TARGET, ...ids)
      .all<{ target_id: string }>()
    for (const r of res.results ?? []) likedSet.add(r.target_id)
  }

  const hotThreshold = await hotCommentThreshold(env)

  return json({
    comments: groupComments(
      comments.map((c) => ({
        ...c,
        liked: likedSet.has(c.id),
        // 已删除的占位不参与高赞（赞数没意义，也不该被顶上去）
        hot: !c.deleted && c.likeCount > 0 && c.likeCount >= hotThreshold,
      })) as unknown as RawComment[]
    ),
    /** 未删除的评论条数（列表页「评论 N」用） */
    count: comments.filter((c) => !c.deleted).length,
    /** 当前查看者是不是作品作者 */
    isOwner: project.userId === user.id,
    /** 评论可修改次数上限（与社区同一个设置项），前端据此决定显不显示「编辑」 */
    editLimit: await commentEditLimit(env),
  })
}

/**
 * POST /api/gallery/:id/comments —— 发表评论或回复。
 *
 * 防刷与社区同口径（10 秒冷却，**跨所有作品**统一计算 ——
 * 否则在 N 个作品下各发一条就能绕过限流）。
 * 回复目标由服务端从父评论推导，不信任前端传的值。
 */
export async function createGalleryComment(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const user = await requireUser(env, request)
  assertContentLengthWithin(request, MAX_JSON_BODY_BYTES, "请求内容过大")

  const body = (await request.json().catch(() => ({}))) as {
    body?: string
    parentId?: string
  }
  const text = (body.body ?? "").trim()
  if (!text) throw new ApiError(400, "评论不能为空", "INVALID_INPUT")
  if (text.length > MAX_BODY_CHARS) throw new ApiError(400, "评论过长", "TOO_LARGE")

  const project = await loadCommentableProject(env, user.id, id)

  const last = await env.DB.prepare(
    "SELECT created_at FROM gallery_comments WHERE user_id = ? ORDER BY created_at DESC LIMIT 1"
  )
    .bind(user.id)
    .first<{ created_at: string }>()
  if (!canPostAgain(last?.created_at ?? null, COMMENT_COOLDOWN_SEC)) {
    // 文案与社区完全一致，复用 api-messages.ts 里已有的翻译条目
    throw new ApiError(429, "评论太频繁", "RATE_LIMITED")
  }

  let parentId: string | null = null
  let replyToUserId: string | null = null
  if (body.parentId) {
    const parent = await env.DB.prepare(
      `SELECT id, user_id FROM gallery_comments
        WHERE id = ? AND project_id = ? AND deleted_at IS NULL`
    )
      .bind(body.parentId, project.id)
      .first<{ id: string; user_id: string }>()
    if (!parent) throw new ApiError(400, "父评论不存在", "INVALID_PARENT")
    parentId = parent.id
    replyToUserId = parent.user_id === user.id ? null : parent.user_id
  }

  const cid = uuid()
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO gallery_comments
       (id, project_id, user_id, parent_id, reply_to_user_id, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(cid, project.id, user.id, parentId, replyToUserId, text, now)
    .run()

  return json({ comment: { id: cid, createdAt: now } }, 201)
}

/**
 * PUT /api/gallery/:id/comments/:commentId —— 编辑自己的评论。
 *
 * 口径照抄社区 `updateComment`：
 *   · **只有作者本人**能改（管理员处理违规请用删除）；
 *   · 次数上限来自 `community_comment_edit_limit`（默认 2，0 = 禁止）；
 *   · 内容没变直接返回 unchanged，**不消耗次数**；
 *   · 并发用 `WHERE edit_count = 旧值` 乐观锁，只有一次能成功。
 */
export async function updateGalleryComment(
  env: Env,
  request: Request,
  id: string,
  commentId: string
): Promise<Response> {
  const user = await requireUser(env, request)
  const project = await loadCommentableProject(env, user.id, id)

  const row = await env.DB.prepare(
    "SELECT user_id, body, edit_count, deleted_at FROM gallery_comments WHERE id = ? AND project_id = ?"
  )
    .bind(commentId, project.id)
    .first<{ user_id: string; body: string; edit_count: number; deleted_at: string | null }>()
  if (!row || row.deleted_at) throw new ApiError(404, "评论不存在", "NOT_FOUND")
  if (row.user_id !== user.id) throw new ApiError(403, "无权编辑该评论", "FORBIDDEN")

  assertContentLengthWithin(request, MAX_JSON_BODY_BYTES, "请求内容过大")
  const body = (await request.json().catch(() => ({}))) as { body?: string }
  const text = (body.body ?? "").trim()
  if (!text) throw new ApiError(400, "评论不能为空", "INVALID_INPUT")
  if (text.length > MAX_BODY_CHARS) throw new ApiError(400, "评论过长", "TOO_LARGE")

  if (text === row.body) {
    return json({ ok: true, unchanged: true, editCount: row.edit_count })
  }

  const limit = await commentEditLimit(env)
  if (limit <= 0) throw new ApiError(403, "评论编辑已关闭", "EDIT_DISABLED")
  if (row.edit_count >= limit) throw new ApiError(409, "评论修改次数已用完", "EDIT_LIMIT")

  const now = new Date().toISOString()
  const res = await env.DB.prepare(
    `UPDATE gallery_comments
        SET body = ?, edit_count = edit_count + 1, updated_at = ?
      WHERE id = ? AND edit_count = ? AND deleted_at IS NULL`
  )
    .bind(text, now, commentId, row.edit_count)
    .run()

  // 乐观锁没打中 ⇒ 另一个标签页刚改过。让前端刷新，别把上限刷穿。
  if ((res.meta?.changes ?? 0) === 0) {
    throw new ApiError(409, "评论已被修改，请刷新后重试", "CONFLICT")
  }

  return json({ ok: true, unchanged: false, editCount: row.edit_count + 1, updatedAt: now })
}

/**
 * POST /api/gallery/:id/comments/:commentId/like —— 评论点赞（幂等切换）。
 *
 * 照抄社区的幂等写法：先查有没有，有就删（changes>0 才减计数），
 * 没有就 `INSERT OR IGNORE`（changes>0 才加计数）。并发重复请求不会撞主键、
 * 也不会把计数算错。
 */
export async function toggleGalleryCommentLike(
  env: Env,
  request: Request,
  id: string,
  commentId: string
): Promise<Response> {
  const user = await requireUser(env, request)
  const project = await loadCommentableProject(env, user.id, id)

  const comment = await env.DB.prepare(
    "SELECT id FROM gallery_comments WHERE id = ? AND project_id = ? AND deleted_at IS NULL"
  )
    .bind(commentId, project.id)
    .first<{ id: string }>()
  if (!comment) throw new ApiError(404, "评论不存在", "NOT_FOUND")

  const existing = await env.DB.prepare(
    "SELECT 1 FROM post_likes WHERE user_id = ? AND target_type = ? AND target_id = ?"
  )
    .bind(user.id, LIKE_TARGET, commentId)
    .first()

  if (existing) {
    const del = await env.DB.prepare(
      "DELETE FROM post_likes WHERE user_id = ? AND target_type = ? AND target_id = ?"
    )
      .bind(user.id, LIKE_TARGET, commentId)
      .run()
    if ((del.meta?.changes ?? 0) > 0) {
      await env.DB.prepare(
        "UPDATE gallery_comments SET like_count = MAX(0, like_count - 1) WHERE id = ?"
      )
        .bind(commentId)
        .run()
    }
    return json({ liked: false, likeCount: await commentLikeCount(env, commentId) })
  }

  const inserted = await env.DB.prepare(
    "INSERT OR IGNORE INTO post_likes (user_id, target_type, target_id, created_at) VALUES (?, ?, ?, ?)"
  )
    .bind(user.id, LIKE_TARGET, commentId, new Date().toISOString())
    .run()
  if ((inserted.meta?.changes ?? 0) > 0) {
    await env.DB.prepare(
      "UPDATE gallery_comments SET like_count = like_count + 1 WHERE id = ?"
    )
      .bind(commentId)
      .run()
  }

  return json({ liked: true, likeCount: await commentLikeCount(env, commentId) })
}

/**
 * DELETE /api/gallery/:id/comments/:commentId —— 软删除评论。
 *
 * 谁能删：评论作者 / 作品作者 / 管理员。
 * 删除时**把正文置空**（同社区）—— 占位行还在，回复树不断链，
 * 但内容不再下发。
 */
export async function deleteGalleryComment(
  env: Env,
  request: Request,
  id: string,
  commentId: string
): Promise<Response> {
  const user = await requireUser(env, request)
  const project = await loadCommentableProject(env, user.id, id)

  const row = await env.DB.prepare(
    "SELECT user_id, deleted_at FROM gallery_comments WHERE id = ? AND project_id = ?"
  )
    .bind(commentId, project.id)
    .first<{ user_id: string; deleted_at: string | null }>()
  if (!row || row.deleted_at) throw new ApiError(404, "评论不存在", "NOT_FOUND")

  const isCommentAuthor = row.user_id === user.id
  const isProjectAuthor = project.userId === user.id
  const isAdmin = isPrivileged(String(user.role ?? ""))
  if (!isCommentAuthor && !isProjectAuthor && !isAdmin) {
    throw new ApiError(403, "无权删除该评论", "FORBIDDEN")
  }

  await env.DB.prepare(
    "UPDATE gallery_comments SET deleted_at = ?, body = '' WHERE id = ?"
  )
    .bind(new Date().toISOString(), commentId)
    .run()

  return json({ ok: true })
}

/**
 * 作品评论数 —— 供造物集**列表/概览**显示「评论 N」用。
 *
 * 故意做成批量接口（一次查一批作品），避免列表页 N+1：
 * 大厅一页 20 张卡片，逐个 COUNT 就是 20 次 D1 往返。
 */
export async function countCommentsByProjects(
  env: Env,
  projectIds: string[]
): Promise<Record<string, number>> {
  if (projectIds.length === 0) return {}
  const ids = projectIds.slice(0, 90) // D1 绑定参数上限 100
  const placeholders = ids.map(() => "?").join(",")
  const rows = await env.DB.prepare(
    `SELECT project_id, COUNT(*) AS c FROM gallery_comments
      WHERE project_id IN (${placeholders}) AND deleted_at IS NULL
      GROUP BY project_id`
  )
    .bind(...ids)
    .all<{ project_id: string; c: number }>()
  const out: Record<string, number> = {}
  for (const r of rows.results ?? []) out[r.project_id] = Number(r.c) || 0
  return out
}
