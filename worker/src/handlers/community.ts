import { ApiError, json } from "../http"
import { requireUser } from "../auth"
import { decodeCursor, encodeCursor, groupComments, type RawComment } from "../community-logic"
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
