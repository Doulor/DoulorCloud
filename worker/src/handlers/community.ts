import { ApiError, json } from "../http"
import { requireUser } from "../auth"
import { decodeCursor, encodeCursor, groupComments, canPostAgain, type RawComment } from "../community-logic"
import { uuid } from "../crypto"
import { getSettingNumber } from "../settings"
import { sendMail, renderMail, isMailerConfigured } from "../mailer"
import type { Env } from "../env"

const DEFAULT_LIMIT = 20

interface PostRow {
  id: string
  user_id: string
  body: string
  images: string | null
  like_count: number
  comment_count: number
  share_count: number
  deleted_at: string | null
  created_at: string
  username: string
  nickname: string | null
  avatar_key: string | null
  author_role: string
}

function toPostDto(r: PostRow, viewerLiked: boolean, isMine: boolean) {
  return {
    id: r.id,
    author: {
      username: r.username,
      nickname: r.nickname ?? null,
      isAdmin: r.author_role === "admin",
      hasAvatar: Boolean(r.avatar_key),
    },
    body: r.body,
    images: r.images ? (JSON.parse(r.images) as string[]) : [],
    likeCount: r.like_count,
    commentCount: r.comment_count,
    shareCount: r.share_count,
    liked: viewerLiked,
    isMine,
    createdAt: r.created_at,
  }
}

/** 匿名可读：requireUser 抛 401 时 try/catch 吞掉 */
async function optionalViewer(env: Env, request: Request): Promise<{ id: string } | null> {
  try { return await requireUser(env, request) } catch { return null }
}

/** GET /api/community/posts?cursor=&limit= */
export async function listPosts(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), 50)
  const cursor = url.searchParams.get("cursor")
  const viewer = await optionalViewer(env, request)

  let where = "p.deleted_at IS NULL"
  const binds: unknown[] = []
  if (cursor) {
    const c = decodeCursor(cursor)
    if (c) {
      where += " AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?))"
      binds.push(c.createdAt, c.createdAt, c.id)
    }
  }

  const rows = await env.DB.prepare(
    `SELECT p.*, u.username, u.nickname, u.avatar_key, u.role AS author_role
       FROM posts p JOIN users u ON u.id = p.user_id
      WHERE ${where}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ?`
  ).bind(...binds, limit).all<PostRow>()

  const posts = rows.results ?? []
  const likedSet = viewer
    ? new Set((await env.DB.prepare(
        "SELECT target_id FROM post_likes WHERE user_id = ? AND target_type = 'post'"
      ).bind(viewer.id).all<{ target_id: string }>()).results?.map((x) => x.target_id) ?? [])
    : new Set<string>()

  const out = posts.map((r) => toPostDto(r, likedSet.has(r.id), viewer?.id === r.user_id))
  const last = posts[posts.length - 1]
  const nextCursor = posts.length === limit && last ? encodeCursor(last.created_at, last.id) : null
  return json({ posts: out, nextCursor })
}

/** GET /api/community/posts/:id */
export async function getPost(env: Env, request: Request, id: string): Promise<Response> {
  const viewer = await optionalViewer(env, request)
  const r = await env.DB.prepare(
    `SELECT p.*, u.username, u.nickname, u.avatar_key, u.role AS author_role
       FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?`
  ).bind(id).first<PostRow>()
  if (!r || r.deleted_at) throw new ApiError(404, "帖子不存在", "NOT_FOUND")
  const liked = viewer
    ? Boolean((await env.DB.prepare(
        "SELECT 1 FROM post_likes WHERE user_id=? AND target_type='post' AND target_id=?"
      ).bind(viewer.id, id).first()))
    : false
  return json({ post: toPostDto(r, liked, viewer?.id === r.user_id) })
}

/** GET /api/community/posts/:id/comments */
export async function listComments(env: Env, _request: Request, id: string): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT c.*, u.username, u.nickname, u.avatar_key, u.role AS author_role,
            ru.username AS reply_to_username
       FROM post_comments c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN users ru ON ru.id = c.reply_to_user_id
      WHERE c.post_id = ? AND c.deleted_at IS NULL
      ORDER BY c.created_at ASC`
  ).bind(id).all()
  const comments = (rows.results ?? []).map((c: Record<string, unknown>) => ({
    id: c.id as string,
    post_id: c.post_id as string,
    user_id: c.user_id as string,
    parent_id: (c.parent_id as string | null) ?? null,
    body: c.body as string,
    created_at: c.created_at as string,
    author: {
      username: c.username as string,
      nickname: (c.nickname as string | null) ?? null,
      isAdmin: c.author_role === "admin",
      hasAvatar: Boolean(c.avatar_key),
    },
    replyTo: (c.reply_to_username as string | null) ?? null,
    likeCount: c.like_count as number,
  }))
  return json({ comments: groupComments(comments as unknown as RawComment[]) })
}

const POST_COOLDOWN_SEC = 60
const COMMENT_COOLDOWN_SEC = 10

/** POST /api/community/posts */
export async function createPost(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json().catch(() => ({}))) as { body?: string; images?: string[] }
  const text = (body.body ?? "").trim()
  if (!text) throw new ApiError(400, "内容不能为空", "INVALID_INPUT")
  if (text.length > 5000) throw new ApiError(400, "内容过长（上限 5000 字）", "TOO_LARGE")

  const last = await env.DB.prepare("SELECT created_at FROM posts WHERE user_id=? ORDER BY created_at DESC LIMIT 1")
    .bind(user.id).first<{ created_at: string }>()
  if (!canPostAgain(last?.created_at ?? null, POST_COOLDOWN_SEC)) {
    throw new ApiError(429, "发帖太频繁，请稍后再试", "RATE_LIMITED")
  }

  const maxImages = await getSettingNumber(env, "community_post_max_images")
  const images = Array.isArray(body.images) ? body.images.slice(0, maxImages) : []
  const id = uuid()
  const now = new Date().toISOString()
  await env.DB.prepare(
    "INSERT INTO posts (id, user_id, channel, body, images, created_at) VALUES (?, ?, 'general', ?, ?, ?)"
  ).bind(id, user.id, text, images.length ? JSON.stringify(images) : null, now).run()
  return json({ post: { id } }, 201)
}

/** POST /api/community/posts/:id/like —— 幂等切换 */
export async function toggleLike(env: Env, request: Request, id: string): Promise<Response> {
  const user = await requireUser(env, request)
  const existing = await env.DB.prepare(
    "SELECT 1 FROM post_likes WHERE user_id=? AND target_type='post' AND target_id=?"
  ).bind(user.id, id).first()
  if (existing) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM post_likes WHERE user_id=? AND target_type='post' AND target_id=?").bind(user.id, id),
      env.DB.prepare("UPDATE posts SET like_count = MAX(0, like_count - 1) WHERE id=?").bind(id),
    ])
    return json({ liked: false, likeCount: await likeCount(env, id) })
  }
  await env.DB.batch([
    env.DB.prepare("INSERT INTO post_likes (user_id, target_type, target_id, created_at) VALUES (?, 'post', ?, ?)").bind(user.id, id, new Date().toISOString()),
    env.DB.prepare("UPDATE posts SET like_count = like_count + 1 WHERE id=?").bind(id),
  ])
  return json({ liked: true, likeCount: await likeCount(env, id) })
}

async function likeCount(env: Env, id: string): Promise<number> {
  const r = await env.DB.prepare("SELECT like_count FROM posts WHERE id=?").bind(id).first<{ like_count: number }>()
  return r?.like_count ?? 0
}

/** POST /api/community/posts/:id/share —— 转发计数 +1，不写新帖 */
export async function sharePost(env: Env, request: Request, id: string): Promise<Response> {
  await requireUser(env, request)
  await env.DB.prepare("UPDATE posts SET share_count = share_count + 1 WHERE id=? AND deleted_at IS NULL").bind(id).run()
  const r = await env.DB.prepare("SELECT share_count FROM posts WHERE id=?").bind(id).first<{share_count:number}>()
  return json({ shareCount: r?.share_count ?? 0 })
}

/** POST /api/community/posts/:id/comments */
export async function createComment(env: Env, request: Request, id: string): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json().catch(() => ({}))) as { body?: string; parentId?: string; replyToUserId?: string }
  const text = (body.body ?? "").trim()
  if (!text) throw new ApiError(400, "评论不能为空", "INVALID_INPUT")
  if (text.length > 1000) throw new ApiError(400, "评论过长", "TOO_LARGE")

  const post = await env.DB.prepare("SELECT user_id FROM posts WHERE id=? AND deleted_at IS NULL").bind(id).first<{ user_id: string }>()
  if (!post) throw new ApiError(404, "帖子不存在", "NOT_FOUND")

  const last = await env.DB.prepare("SELECT created_at FROM post_comments WHERE user_id=? ORDER BY created_at DESC LIMIT 1").bind(user.id).first<{created_at:string}>()
  if (!canPostAgain(last?.created_at ?? null, COMMENT_COOLDOWN_SEC)) {
    throw new ApiError(429, "评论太频繁", "RATE_LIMITED")
  }

  let parentId: string | null = null
  if (body.parentId) {
    const parent = await env.DB.prepare("SELECT id, parent_id FROM post_comments WHERE id=? AND post_id=? AND deleted_at IS NULL").bind(body.parentId, id).first<{ id: string; parent_id: string | null }>()
    if (!parent) throw new ApiError(400, "父评论不存在", "INVALID_PARENT")
    if (parent.parent_id !== null) throw new ApiError(400, "最多两层嵌套", "NEST_TOO_DEEP")
    parentId = parent.id
  }
  const cid = uuid()
  const now = new Date().toISOString()
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO post_comments (id, post_id, user_id, parent_id, reply_to_user_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(cid, id, user.id, parentId, body.replyToUserId ?? null, text, now),
    env.DB.prepare("UPDATE posts SET comment_count = comment_count + 1 WHERE id=?").bind(id),
  ])

  await maybeNotify(env, {
    type: "post_comment", postId: id, commentId: cid, actorId: user.id,
    recipientId: post.user_id, replyToUserId: body.replyToUserId,
  })
  return json({ comment: { id: cid } }, 201)
}

/** DELETE /api/community/posts/:id —— 作者或管理员软删 */
export async function deletePost(env: Env, request: Request, id: string): Promise<Response> {
  const user = await requireUser(env, request)
  const row = await env.DB.prepare("SELECT user_id FROM posts WHERE id=?").bind(id).first<{ user_id: string }>()
  if (!row) throw new ApiError(404, "帖子不存在", "NOT_FOUND")
  if (row.user_id !== user.id && user.role !== "admin") throw new ApiError(403, "无权删除", "FORBIDDEN")
  await env.DB.prepare("UPDATE posts SET deleted_at=? WHERE id=?").bind(new Date().toISOString(), id).run()
  return json({ ok: true })
}

/** 写一条通知；不给自己发；写库/邮件失败静默 */
async function maybeNotify(env: Env, args: {
  type: "post_comment" | "comment_reply"
  postId: string
  commentId: string
  actorId: string
  recipientId: string
  replyToUserId?: string
}): Promise<void> {
  // 给帖子作者发 post_comment（评论自己的帖子 → 不通知）
  if (args.recipientId !== args.actorId) {
    try {
      await env.DB.prepare(
        "INSERT INTO notifications (id, user_id, type, actor_id, post_id, comment_id, read, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)"
      ).bind(uuid(), args.recipientId, args.type, args.actorId, args.postId, args.commentId, new Date().toISOString()).run()
    } catch {}
    await maybeSendMail(env, args.recipientId, args.postId)
  }

  // 若是回复某人，且那人不是帖子作者、不是自己 → 给那人也发 comment_reply
  if (args.replyToUserId && args.replyToUserId !== args.actorId && args.replyToUserId !== args.recipientId) {
    try {
      await env.DB.prepare(
        "INSERT INTO notifications (id, user_id, type, actor_id, post_id, comment_id, read, created_at) VALUES (?, ?, 'comment_reply', ?, ?, ?, 0, ?)"
      ).bind(uuid(), args.replyToUserId, args.actorId, args.postId, args.commentId, new Date().toISOString()).run()
    } catch {}
    await maybeSendMail(env, args.replyToUserId, args.postId)
  }
}

async function maybeSendMail(env: Env, recipientId: string, postId: string): Promise<void> {
  if (!isMailerConfigured(env)) return
  const u = await env.DB.prepare("SELECT email, email_verified, notify_enabled FROM users WHERE id=?").bind(recipientId).first<{ email: string; email_verified: number; notify_enabled: number }>()
  if (!u || !u.email_verified || !u.notify_enabled) return
  const link = `https://cloud.doulor.cn/community/${postId}`
  const { text, html } = renderMail("你在 Doulor Cloud 社区有新互动", [
    "有人回复了你的帖子或评论。",
    `查看：${link}`,
  ])
  try { await sendMail(env, { to: u.email, subject: "【Doulor Cloud】社区新互动", text, html }) } catch {}
}

/** GET /api/notifications */
export async function listNotifications(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const rows = await env.DB.prepare(
    "SELECT id, type, actor_id, post_id, comment_id, read, created_at FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50"
  ).bind(user.id).all()
  return json({ notifications: rows.results ?? [] })
}

/** GET /api/notifications/unread-count */
export async function unreadCount(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const r = await env.DB.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read=0").bind(user.id).first<{ c: number }>()
  return json({ count: r?.c ?? 0 })
}

/** POST /api/notifications/read */
export async function markRead(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json().catch(() => ({}))) as { ids?: string[]; all?: boolean }
  if (body.all) {
    await env.DB.prepare("UPDATE notifications SET read=1 WHERE user_id=?").bind(user.id).run()
  } else if (Array.isArray(body.ids) && body.ids.length > 0) {
    const ph = body.ids.map(() => "?").join(",")
    await env.DB.prepare(`UPDATE notifications SET read=1 WHERE user_id=? AND id IN (${ph})`).bind(user.id, ...body.ids).run()
  }
  return json({ ok: true })
}
