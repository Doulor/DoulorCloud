/**
 * 造物集评论区（2026-10-21）。
 *
 * ## 为什么单独一个 handler，不塞进 community.ts
 * 造物集和社区广场是**两个独立功能**：前者是「可运行的网页作品」，后者是长文帖子。
 * 它们的可见性规则、权限口径、UI 语境都不同，混在一个文件里只会越来越难改。
 * 真正共享的是**纯逻辑**（建树、防刷屏、游标），那些都在 `community-logic.ts`，
 * 这里直接 import 复用，一行都没有重写。
 *
 * ## 权限口径（与造物集详情接口**严格一致**）
 * `GET /api/gallery/:id` 的条件是 `(id 或 slug 命中) AND (public OR 本人)`。
 * 评论区必须用同一套判据，否则会出现「详情打不开、评论却能读」的越权。
 * 所以三条接口都先过一次同样的 `loadCommentableProject()`。
 *
 * ## 与社区评论的三处刻意差异
 *   1. **不维护 comment_count 冗余列** —— 列表接口顺手 COUNT 就够；
 *   2. **不发站内通知** —— 造物集以展示为主，先不引入通知噪音；
 *   3. **不提供编辑** —— 社区那套「编辑次数上限」是为长对话设计的，
 *      造物集评论更像留言板，说错了删掉重发即可（删除接口有）。
 */
import { ApiError, json, assertContentLengthWithin } from "../http"
import { requireUser } from "../auth"
import { groupComments, canPostAgain, type RawComment } from "../community-logic"
import { uuid } from "../crypto"
import type { Env } from "../env"

/** 与社区广场同一口径：一条评论最多 1000 字 */
const MAX_BODY_CHARS = 1000
/** 与社区广场同一口径：同一用户两次评论最小间隔（秒） */
const COMMENT_COOLDOWN_SEC = 10
/** JSON 请求体上限，防止超大 body 打爆内存 */
const MAX_JSON_BODY_BYTES = 64 * 1024

/**
 * 取「可评论的作品」，判据与 `getGalleryItem` 完全一致：
 *   `(id 或 slug 命中) AND (visibility='public' OR 本人)`
 *
 * 返回 `{ id, userId }`（归一化后的**真正的 id**）—— 前端可能传的是 slug，
 * 存评论必须落真 id，否则作品改 slug 后评论就跟丢了。
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

/**
 * GET /api/gallery/:id/comments —— 列出某作品的评论（按时间正序建树）。
 *
 * 只返回**未删除**的评论。已删除的不返回但保留行（软删除），
 * 这样「回复过一条后来被删的评论」的子回复不会连带消失 —— 它们在
 * groupComments 里会因为找不到父节点而退化成根节点，上下文还在。
 */
export async function listGalleryComments(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const user = await requireUser(env, request)
  const project = await loadCommentableProject(env, user.id, id)

  // 一次性取全（造物集评论量远小于社区，不分页；真要长了再加游标）
  const rows = await env.DB.prepare(
    `SELECT c.id, c.project_id, c.user_id, c.parent_id, c.reply_to_user_id,
            c.body, c.like_count, c.created_at,
            COALESCE(NULLIF(u.nickname, ''), u.username) AS author_name,
            u.username AS author_username,
            u.avatar_key AS author_avatar
       FROM gallery_comments c
       JOIN users u ON u.id = c.user_id
      WHERE c.project_id = ? AND c.deleted_at IS NULL
      ORDER BY c.created_at ASC`
  )
    .bind(project.id)
    .all<Record<string, unknown>>()

  const flat = (rows.results ?? []).map((c) => ({
    id: c.id as string,
    project_id: c.project_id as string,
    user_id: c.user_id as string,
    parent_id: (c.parent_id as string | null) ?? null,
    reply_to_user_id: (c.reply_to_user_id as string | null) ?? null,
    body: c.body as string,
    likeCount: Number(c.like_count ?? 0),
    createdAt: c.created_at as string,
    authorName: c.author_name as string,
    authorUsername: c.author_username as string,
    authorAvatar: Boolean(c.author_avatar),
    isMine: (c.user_id as string) === user.id,
  }))

  return json({
    comments: groupComments(flat as unknown as RawComment[]),
    count: flat.length,
    /** 当前查看者是不是作品作者（前端据此决定要不要显示「作者」徽标） */
    isOwner: project.userId === user.id,
  })
}

/**
 * POST /api/gallery/:id/comments —— 发表评论或回复。
 *
 * 防刷与社区同口径（10 秒冷却，跨**所有作品**统一计算 —— 不然在 N 个作品下
 * 各发一条就能绕过限流）。
 * 回复目标**由服务端从父评论推导**，不信任前端传的 replyToUserId
 * （同社区那边 2026-09-25 修的越权/伪造通知问题）。
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

  // 防刷：同一用户在造物集的最后一条评论
  const last = await env.DB.prepare(
    "SELECT created_at FROM gallery_comments WHERE user_id = ? ORDER BY created_at DESC LIMIT 1"
  )
    .bind(user.id)
    .first<{ created_at: string }>()
  if (!canPostAgain(last?.created_at ?? null, COMMENT_COOLDOWN_SEC)) {
    // 文案刻意与社区广场**完全一致**，这样能复用 api-messages.ts 里已有的
    // 翻译条目（"评论太频繁"）。加个后缀就匹配不到了，英文用户会看到中文。
    throw new ApiError(429, "评论太频繁", "RATE_LIMITED")
  }

  let parentId: string | null = null
  let replyToUserId: string | null = null
  if (body.parentId) {
    // ⚠️ 父评论必须属于**同一个作品**，否则可以把 A 作品的评论串到 B 作品下
    const parent = await env.DB.prepare(
      `SELECT id, user_id FROM gallery_comments
        WHERE id = ? AND project_id = ? AND deleted_at IS NULL`
    )
      .bind(body.parentId, project.id)
      .first<{ id: string; user_id: string }>()
    if (!parent) throw new ApiError(400, "父评论不存在", "INVALID_PARENT")
    parentId = parent.id
    // 回复自己的评论不产生「回复 @某人」标记
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
 * DELETE /api/gallery/:id/comments/:commentId —— 删除评论（软删除）。
 *
 * 谁能删：
 *   · 评论作者本人；
 *   · **作品作者**（自己作品下的垃圾评论要能清理）；
 *   · 管理员。
 * 这三类之外一律 403 —— 不能让人互相删评论。
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
    "SELECT id, user_id, deleted_at FROM gallery_comments WHERE id = ? AND project_id = ?"
  )
    .bind(commentId, project.id)
    .first<{ id: string; user_id: string; deleted_at: string | null }>()
  if (!row || row.deleted_at) throw new ApiError(404, "评论不存在", "NOT_FOUND")

  const isCommentAuthor = row.user_id === user.id
  const isProjectAuthor = project.userId === user.id
  // 管理员口径与全站一致：role 里有 admin 即可
  const isAdmin = String(user.role ?? "").includes("admin")
  if (!isCommentAuthor && !isProjectAuthor && !isAdmin) {
    throw new ApiError(403, "无权删除该评论", "FORBIDDEN")
  }

  await env.DB.prepare("UPDATE gallery_comments SET deleted_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), commentId)
    .run()

  return json({ ok: true })
}
