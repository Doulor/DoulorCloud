import { ApiError, json, SAFE_JSON_HEADERS, readBodyCapped, assertContentLengthWithin } from "../http"
import { requireUser, type UserRow } from "../auth"
import { decodeCursor, encodeCursor, groupComments, canPostAgain, type RawComment } from "../community-logic"
import { uuid } from "../crypto"
import { getSettingNumber, getSettingBool } from "../settings"
import { sendMail, renderMail } from "../mailer"
import { isStorageConfigured, putObject, deleteObject, getObject, getPlatformBucketId } from "../r2"
import { hardenUserContentResponse } from "../content-type"
import { guardRateLimit } from "../ratelimit"
import { getLinkPreview } from "../link-preview"
import { pushMessage, isMessageCategory } from "../user-messages"
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
  updated_at: string | null
  edit_count: number
  username: string
  nickname: string | null
  avatar_key: string | null
  author_role: string
  /** 作者的自定义称号（LEFT JOIN user_titles/custom_titles，没授予为 null） */
  title_name?: string | null
  title_color_from?: string | null
  title_color_to?: string | null
}

/** 从查询行的 title_* 列拼出前端要的称号对象（未授予回 null） */
function titleOf(r: { title_name?: string | null; title_color_from?: string | null; title_color_to?: string | null }) {
  return r.title_name
    ? { name: r.title_name, colorFrom: r.title_color_from ?? "#64748b", colorTo: r.title_color_to ?? "#64748b" }
    : null
}

function toPostDto(r: PostRow, viewerLiked: boolean, isMine: boolean) {
  // images 存的是 R2 key（community/<postId>/<filename>），转成可访问 URL
  let images: string[] = []
  if (r.images) {
    try {
      images = (JSON.parse(r.images) as string[]).map((key) => {
        const filename = key.split("/").pop() ?? key
        return `/c/${r.id}/${filename}`
      })
    } catch {
      images = []
    }
  }
  return {
    id: r.id,
    author: {
      username: r.username,
      nickname: r.nickname ?? null,
      isAdmin: r.author_role === "admin" || r.author_role === "root",
      isRoot: r.author_role === "root",
      hasAvatar: Boolean(r.avatar_key),
      customTitle: titleOf(r),
    },
    body: r.body,
    images,
    likeCount: r.like_count,
    commentCount: r.comment_count,
    shareCount: r.share_count,
    liked: viewerLiked,
    isMine,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    editCount: r.edit_count ?? 0,
  }
}

/** 匿名可读：requireUser 抛 401 时 try/catch 吞掉 */
async function optionalViewer(env: Env, request: Request): Promise<UserRow | null> {
  try { return await requireUser(env, request) } catch { return null }
}

/**
 * 社区广场总开关（2026-09-25 审计 L7 / F2 修复）。
 *
 * 原状况：`community_enabled` 这个设置项**服务端没有任何地方读它** ——
 * 全仓只有两处引用：settings.ts 的声明、以及下面 communityConfig 回给前端。
 * 也就是说管理员在后台关掉「社区广场」后，所有读接口照常返回帖子与评论，
 * 这个开关实际上只是「前端把入口隐藏起来」，任何人直接调 API 照样能读写。
 *
 * 现在把它做成真正的门禁：关闭时非管理员一律 403。
 * 管理员放行（与 requireFeatureUser 的口径一致），否则管理员自己没法验证功能。
 */
async function assertCommunityEnabled(
  env: Env,
  viewer: { role?: string } | null
): Promise<void> {
  if (viewer?.role === "admin" || viewer?.role === "root") return
  if (!(await getSettingBool(env, "community_enabled"))) {
    throw new ApiError(403, "社区广场已关闭", "FEATURE_DISABLED")
  }
}

/**
 * 社区读取访问控制：返回 viewer（未登录则为 null）。
 * 管理员在后台关闭「允许访客访问」后，匿名请求一律拒绝（401）。
 */
async function readViewer(env: Env, request: Request): Promise<UserRow | null> {
  const viewer = await optionalViewer(env, request)
  await assertCommunityEnabled(env, viewer)
  if (!viewer && !(await getSettingBool(env, "community_guest_access"))) {
    throw new ApiError(401, "请登录后访问社区广场", "LOGIN_REQUIRED")
  }
  return viewer
}

/** 社区写入访问控制：必须登录 + 广场未关闭（管理员放行） */
async function requireCommunityUser(env: Env, request: Request): Promise<UserRow> {
  const user = await requireUser(env, request)
  await assertCommunityEnabled(env, user)
  return user
}

/** GET /api/community/config —— 公开配置（访客访问开关、广场开关） */
export async function communityConfig(env: Env, _request: Request): Promise<Response> {
  return json({
    guestAccess: await getSettingBool(env, "community_guest_access"),
    enabled: await getSettingBool(env, "community_enabled"),
  })
}

/** GET /api/community/posts?cursor=&limit= */
export async function listPosts(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), 50)
  const cursor = url.searchParams.get("cursor")
  const viewer = await readViewer(env, request)

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
    `SELECT p.*, u.username, u.nickname, u.avatar_key, u.role AS author_role,
            ct.name AS title_name, ct.color_from AS title_color_from, ct.color_to AS title_color_to,
            (SELECT COUNT(*) FROM post_edits e WHERE e.post_id = p.id) AS edit_count
       FROM posts p JOIN users u ON u.id = p.user_id
       LEFT JOIN user_titles ut ON ut.user_id = u.id
       LEFT JOIN custom_titles ct ON ct.id = ut.title_id
      WHERE ${where}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ?`
  ).bind(...binds, limit).all<PostRow>()

  const posts = rows.results ?? []
  // ⚠️ 2026-09-25 审计（M17）：原实现是
  //   SELECT target_id FROM post_likes WHERE user_id = ? AND target_type = 'post'
  // —— 不带任何 LIMIT/IN，把该用户**历史上点过的所有帖子**都读出来再取交集。
  // 一页只显示 ≤50 条，却要拉全部历史点赞（老用户轻松上千行），
  // 每次翻页都重复付一遍行读成本。改成只查本页这几十个 id。
  const ids = posts.map((p) => p.id)
  const likedSet = viewer && ids.length > 0
    ? new Set((await env.DB.prepare(
        `SELECT target_id FROM post_likes
          WHERE user_id = ? AND target_type = 'post'
            AND target_id IN (${ids.map(() => "?").join(", ")})`
      ).bind(viewer.id, ...ids).all<{ target_id: string }>()).results?.map((x) => x.target_id) ?? [])
    : new Set<string>()

  const out = posts.map((r) => toPostDto(r, likedSet.has(r.id), viewer?.id === r.user_id))
  const last = posts[posts.length - 1]
  const nextCursor = posts.length === limit && last ? encodeCursor(last.created_at, last.id) : null
  return json({ posts: out, nextCursor })
}

/** GET /api/community/posts/:id */
export async function getPost(env: Env, request: Request, id: string): Promise<Response> {
  const viewer = await readViewer(env, request)
  const r = await env.DB.prepare(
    `SELECT p.*, u.username, u.nickname, u.avatar_key, u.role AS author_role,
            ct.name AS title_name, ct.color_from AS title_color_from, ct.color_to AS title_color_to,
            (SELECT COUNT(*) FROM post_edits e WHERE e.post_id = p.id) AS edit_count
       FROM posts p JOIN users u ON u.id = p.user_id
       LEFT JOIN user_titles ut ON ut.user_id = u.id
       LEFT JOIN custom_titles ct ON ct.id = ut.title_id
      WHERE p.id = ?`
  ).bind(id).first<PostRow>()
  if (!r || r.deleted_at) throw new ApiError(404, "帖子不存在", "NOT_FOUND")
  const liked = viewer
    ? Boolean((await env.DB.prepare(
        "SELECT 1 FROM post_likes WHERE user_id=? AND target_type='post' AND target_id=?"
      ).bind(viewer.id, id).first()))
    : false
  return json({ post: toPostDto(r, liked, viewer?.id === r.user_id) })
}

/**
 * GET /api/community/link-preview?url=... —— 链接预览。
 *
 * 社区 markdown 里的链接要渲染成「富卡片」，需要拿到目标 URL 的
 * 标题/描述/图片。两类：
 *   - 本站帖子链接（cloud.doulor.cn/community/:id 等）→ 直接查 D1，快且稳
 *   - 外站链接 → 抓取 OG 标签（带缓存，见 link-preview.ts）
 *
 * 返回 { preview } 或 { preview: null }（拿不到就回退普通链接）。
 * 需登录（社区本身是登录可见，预览接口也收在鉴权内）。
 */
export async function linkPreview(env: Env, request: Request): Promise<Response> {
  const user = await requireCommunityUser(env, request)

  // ⚠️ 2026-09-25 审计（M9）：这个接口会代表服务端去抓用户给的任意外站 URL，
  // 并把结果写进 D1 缓存 7 天，但原先**完全没有限流** —— 一个登录账号即可
  // 把它当免费抓取代理（刷出站流量、撑 D1 写入），且缓存键含 URL，
  // 不断变换 URL 就能绕过缓存反复抓取。
  await guardRateLimit(
    env,
    `link-preview:user:${user.id}`,
    LINK_PREVIEW_LIMIT,
    LINK_PREVIEW_WINDOW_SECONDS,
    "链接预览请求过于频繁"
  )

  const url = new URL(request.url)
  const raw = url.searchParams.get("url") ?? ""
  if (!raw) {
    throw new ApiError(400, "缺少 url 参数", "INVALID_PARAMS")
  }

  // 本站帖子链接：直接查库
  const internal = await previewInternalPost(env, raw)
  if (internal) {
    return json({ preview: internal })
  }

  // 外站链接：抓取 OG
  const preview = await getLinkPreview(env, raw)
  return json({ preview })
}

/**
 * 识别并预览本站帖子链接。
 * 形如 https://cloud.doulor.cn/community/<id>、/dashboard/community/<id> 等，
 * 提取帖子 id 后查库返回标题/作者/摘要。
 */
async function previewInternalPost(
  env: Env,
  rawUrl: string
): Promise<{
  title: string
  description: string | null
  image: string | null
  /** 站内帖子没有站点图标，恒为 null（保持与 `LinkPreview` 结构一致） */
  icon: string | null
  siteName: string
  internal: true
  postId: string
} | null> {
  const match = /\/community\/([A-Za-z0-9_-]+)/.exec(rawUrl)
  if (!match) return null

  const postId = match[1]
  const r = await env.DB.prepare(
    `SELECT p.body, p.images, u.username, u.nickname
       FROM posts p JOIN users u ON u.id = p.user_id
      WHERE p.id = ? AND p.deleted_at IS NULL`
  )
    .bind(postId)
    .first<{ body: string; images: string | null; username: string; nickname: string | null }>()

  if (!r) return null

  // 摘要：正文前 80 字，去掉换行
  const summary = r.body.replace(/\s+/g, " ").trim().slice(0, 80)
  const author = r.nickname ?? r.username
  let image: string | null = null
  if (r.images) {
    try {
      const keys = JSON.parse(r.images) as string[]
      if (keys.length > 0) {
        const filename = keys[0].split("/").pop() ?? keys[0]
        image = `/c/${postId}/${filename}`
      }
    } catch {
      /* ignore */
    }
  }

  return {
    title: `@${author} 的帖子`,
    description: summary || "（无正文）",
    image,
    icon: null,
    siteName: "Doulor Cloud 社区",
    internal: true,
    postId,
  }
}

/** GET /api/community/posts/:id/comments */
export async function listComments(env: Env, request: Request, id: string): Promise<Response> {
  await readViewer(env, request)
  const rows = await env.DB.prepare(
    `SELECT c.*, u.username, u.nickname, u.avatar_key, u.role AS author_role,
            ct.name AS title_name, ct.color_from AS title_color_from, ct.color_to AS title_color_to,
            ru.username AS reply_to_username
       FROM post_comments c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN users ru ON ru.id = c.reply_to_user_id
       LEFT JOIN user_titles ut ON ut.user_id = u.id
       LEFT JOIN custom_titles ct ON ct.id = ut.title_id
      WHERE c.post_id = ? AND c.deleted_at IS NULL
      ORDER BY c.created_at ASC`
  ).bind(id).all()
  const comments = (rows.results ?? []).map((c: Record<string, unknown>) => ({
    id: c.id as string,
    post_id: c.post_id as string,
    user_id: c.user_id as string,
    parent_id: (c.parent_id as string | null) ?? null,
    body: c.body as string,
    createdAt: c.created_at as string,
    author: {
      username: c.username as string,
      nickname: (c.nickname as string | null) ?? null,
      isAdmin: c.author_role === "admin" || c.author_role === "root",
      isRoot: c.author_role === "root",
      hasAvatar: Boolean(c.avatar_key),
      customTitle: titleOf(c as { title_name?: string | null }),
    },
    replyTo: (c.reply_to_username as string | null) ?? null,
    likeCount: c.like_count as number,
  }))
  return json({ comments: groupComments(comments as unknown as RawComment[]) })
}

const POST_COOLDOWN_SEC = 60
const COMMENT_COOLDOWN_SEC = 10

/**
 * 单次「标记已读」最多接受的 id 数（2026-09-25 审计 M31）。
 * D1 单语句绑定参数上限 100，这里留出 user_id 与安全余量。
 */
const MAX_MARK_READ_IDS = 90

/** 转发计数的限流（2026-09-25 审计 P2-7）：每次调用都是一次 D1 写 + 一次读 */
const SHARE_LIMIT = 60
const SHARE_WINDOW_SECONDS = 10 * 60

/**
 * 链接预览的限流（2026-09-25 审计 M9）。
 *
 * 为什么必须有：这个接口会**代表服务端去抓用户给的任意外站 URL**，
 * 并把结果写进 D1 缓存 7 天。没有任何限流时，一个登录账号就能把它当免费
 * 抓取代理用（刷出站流量、撑 D1 写入），并且因为 `link-preview.ts` 的缓存键
 * 含 URL，攻击者只要不断变换 URL 就能绕过缓存反复抓取。
 *
 * 上限取 120 次 / 10 分钟：社区帖子里外链多时前端会连续请求，
 * 正常的浏览远达不到这个量；而滥用会被挡住。
 */
const LINK_PREVIEW_LIMIT = 120
const LINK_PREVIEW_WINDOW_SECONDS = 10 * 60

/**
 * 社区 JSON 请求体上限（2026-09-25 审计 L30）。
 *
 * 原先所有 `request.json()` 都**没有任何体积上限** —— 正文最长 5000 字、
 * 评论 1000 字、`markRead` 最多 90 个 id，正常请求远小于 64KB，
 * 但没人拦着一个客户端发 100MB 的 JSON 让 Worker 先解析再判长度。
 * 这里只在读之前看一眼 `Content-Length`，不解析、不改语义。
 */
const MAX_JSON_BODY_BYTES = 64 * 1024

/** POST /api/community/posts */
export async function createPost(env: Env, request: Request): Promise<Response> {
  const user = await requireCommunityUser(env, request)
  assertContentLengthWithin(request, MAX_JSON_BODY_BYTES, "请求内容过大")
  const body = (await request.json().catch(() => ({}))) as { body?: string; images?: string[] }
  const text = (body.body ?? "").trim()
  if (!text) throw new ApiError(400, "内容不能为空", "INVALID_INPUT")
  if (text.length > 5000) throw new ApiError(400, "内容过长（上限 5000 字）", "TOO_LARGE")

  const last = await env.DB.prepare("SELECT created_at FROM posts WHERE user_id=? ORDER BY created_at DESC LIMIT 1")
    .bind(user.id).first<{ created_at: string }>()
  if (!canPostAgain(last?.created_at ?? null, POST_COOLDOWN_SEC)) {
    throw new ApiError(429, "发帖太频繁，请稍后再试", "RATE_LIMITED")
  }

  // ⚠️ 2026-09-25 审计（P2-7）：原实现把 `body.images` 原样 `JSON.stringify` 入库，
  // 元素**完全不校验**。而 `posts.images` 存的是 **R2 key**
  // （`community/<postId>/<filename>`，见 toPostDto 与 uploadPostImage），
  // 于是任意字符串都会被 toPostDto 取 basename 拼成 `/c/<本贴 id>/<basename>`。
  //
  // 更要紧的是：**这个字段在语义上永远不可能对**。图片 key 里含 postId，
  // 而 postId 要等这次 INSERT 之后才有；上传接口 uploadPostImage 也是
  // 「先建帖、后逐张传图、再把 key 追加进 posts.images」。
  // 所以创建时能提供的 key 只可能属于**别的帖子**，拼出来的 URL 必然 404。
  // 也就是说它除了被塞垃圾（撑 D1、给别人帖子挂图）之外没有任何正当用途。
  //
  // 真实前端调用的是 `createPost(body)`（api.ts:1196 的 images 默认 `[]`），
  // 因此这里对**非空**数组显式报 400 给出正确做法，而不是静默丢弃数据。
  if (Array.isArray(body.images) && body.images.length > 0) {
    throw new ApiError(
      400,
      "发帖时不能直接附带图片，请先创建帖子再调用图片上传接口",
      "IMAGES_NOT_ALLOWED_ON_CREATE"
    )
  }

  const id = uuid()
  const now = new Date().toISOString()
  await env.DB.prepare(
    "INSERT INTO posts (id, user_id, channel, body, images, created_at) VALUES (?, ?, 'general', ?, NULL, ?)"
  ).bind(id, user.id, text, now).run()
  return json({ post: { id } }, 201)
}

/**
 * PUT /api/community/posts/:id —— 编辑自己的帖子。
 * 仅作者本人（或管理员）可编辑；每次编辑存一条历史（body_before 快照 + 时间）。
 */
export async function updatePost(env: Env, request: Request, id: string): Promise<Response> {
  const user = await requireCommunityUser(env, request)
  const row = await env.DB.prepare(
    "SELECT user_id, body FROM posts WHERE id=? AND deleted_at IS NULL"
  ).bind(id).first<{ user_id: string; body: string }>()
  if (!row) throw new ApiError(404, "帖子不存在", "NOT_FOUND")
  if (row.user_id !== user.id && user.role !== "admin" && user.role !== "root") {
    throw new ApiError(403, "无权编辑该帖子", "FORBIDDEN")
  }

  assertContentLengthWithin(request, MAX_JSON_BODY_BYTES, "请求内容过大")
  const body = (await request.json().catch(() => ({}))) as { body?: string }
  const text = (body.body ?? "").trim()
  if (!text) throw new ApiError(400, "内容不能为空", "INVALID_INPUT")
  if (text.length > 5000) throw new ApiError(400, "内容过长（上限 5000 字）", "TOO_LARGE")
  if (text === row.body) {
    // 内容没变，不产生一次无意义的历史
    return json({ ok: true, unchanged: true })
  }

  const now = new Date().toISOString()
  await env.DB.batch([
    // 存编辑前快照
    env.DB.prepare(
      "INSERT INTO post_edits (id, post_id, editor_id, body_before, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(uuid(), id, user.id, row.body, now),
    // 更新正文 + 编辑时间
    env.DB.prepare("UPDATE posts SET body = ?, updated_at = ? WHERE id = ?")
      .bind(text, now, id),
  ])

  return json({ ok: true, updatedAt: now })
}

/**
 * GET /api/community/posts/:id/edits —— 编辑历史（时间列表）。
 * 仅作者本人/管理员可见（编辑历史属于作者隐私，但管理员为溯源可看）。
 */
export async function listPostEdits(env: Env, request: Request, id: string): Promise<Response> {
  const user = await requireCommunityUser(env, request)
  const row = await env.DB.prepare("SELECT user_id FROM posts WHERE id=?").bind(id)
    .first<{ user_id: string }>()
  if (!row) throw new ApiError(404, "帖子不存在", "NOT_FOUND")
  if (row.user_id !== user.id && user.role !== "admin" && user.role !== "root") {
    throw new ApiError(403, "无权查看编辑历史", "FORBIDDEN")
  }
  const edits = await env.DB.prepare(
    "SELECT created_at FROM post_edits WHERE post_id = ? ORDER BY created_at DESC"
  ).bind(id).all<{ created_at: string }>()

  return json({ edits: (edits.results ?? []).map((e) => ({ editedAt: e.created_at })) })
}

/** POST /api/community/posts/:id/like —— 幂等切换 */
export async function toggleLike(env: Env, request: Request, id: string): Promise<Response> {
  const user = await requireCommunityUser(env, request)

  // ⚠️ 2026-09-25 审计（P2-7）：原实现**不校验帖子是否存在**就直接写点赞。
  // `UPDATE posts … WHERE id=?` 对不存在的 id 是 0 行（静默成功），
  // 但 `INSERT INTO post_likes` 照样落库 —— 于是每个不同的假 id 都能留下
  // 一行悬空点赞，单个账号即可无限往 post_likes 写数据（D1 存储与行读额度），
  // 而已删除的帖子也仍能被继续点赞。
  const post = await env.DB.prepare(
    "SELECT user_id FROM posts WHERE id=? AND deleted_at IS NULL"
  )
    .bind(id)
    .first<{ user_id: string }>()
  if (!post) throw new ApiError(404, "帖子不存在", "NOT_FOUND")

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

  // 社交消息：被赞时通知帖子作者。
  // dedup_key 用 `like:<postId>:<点赞者id>` —— 取消赞后再赞不会产生第二条，
  // 同一个人反复点赞也不会刷屏（部分唯一索引 idx_notifications_dedup 兜底）。
  if (post.user_id !== user.id) {
    await pushMessage(env, post.user_id, {
      category: "social",
      type: "post_like",
      actorId: user.id,
      postId: id,
      dedupKey: `like:${id}:${user.id}`,
    })
  }

  return json({ liked: true, likeCount: await likeCount(env, id) })
}

async function likeCount(env: Env, id: string): Promise<number> {
  const r = await env.DB.prepare("SELECT like_count FROM posts WHERE id=?").bind(id).first<{ like_count: number }>()
  return r?.like_count ?? 0
}

/**
 * POST /api/community/posts/:id/share —— 转发计数 +1，不写新帖
 *
 * ⚠️ 2026-09-25 审计（P2-7）：原实现**没有任何限流**，每次调用都是一次
 * D1 写 + 一次读，一个脚本就能把转发数刷到任意大（运营数据失真），
 * 并白耗行读额度。这里补用户级限流，顺带把「帖子不存在」从静默 0 改成 404。
 */
export async function sharePost(env: Env, request: Request, id: string): Promise<Response> {
  const user = await requireCommunityUser(env, request)
  await guardRateLimit(
    env,
    `share:user:${user.id}`,
    SHARE_LIMIT,
    SHARE_WINDOW_SECONDS,
    "操作过于频繁"
  )

  await env.DB.prepare("UPDATE posts SET share_count = share_count + 1 WHERE id=? AND deleted_at IS NULL").bind(id).run()
  const r = await env.DB.prepare("SELECT share_count FROM posts WHERE id=? AND deleted_at IS NULL").bind(id).first<{share_count:number}>()
  if (!r) throw new ApiError(404, "帖子不存在", "NOT_FOUND")
  return json({ shareCount: r.share_count ?? 0 })
}

/** POST /api/community/posts/:id/comments */
export async function createComment(env: Env, request: Request, id: string): Promise<Response> {
  const user = await requireCommunityUser(env, request)
  assertContentLengthWithin(request, MAX_JSON_BODY_BYTES, "请求内容过大")
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
  // 回复目标**由服务端从父评论推导**，不信任前端传的 replyToUserId。
  //
  // ⚠️ 2026-09-25 审计（M8）：原实现直接把 `body.replyToUserId` 入库并据此
  // 写通知 + 发邮件。于是任意登录用户可以：
  //   1. 指定任意 users.id，给对方制造「有人回复你」的假通知（伪造）；
  //   2. 在对方 email_verified=1 时**向其真实邮箱发信**，可批量轰炸；
  //   3. 传一个不存在的 id，让外键约束把整个 batch 打成 500。
  // 现在只认「父评论的作者」，且回复自己的评论时不产生通知。
  //
  // 不再限制嵌套层数：parent 可以是任意深度的评论，前端递归渲染。
  let replyToUserId: string | null = null
  if (body.parentId) {
    const parent = await env.DB.prepare("SELECT id, parent_id, user_id FROM post_comments WHERE id=? AND post_id=? AND deleted_at IS NULL").bind(body.parentId, id).first<{ id: string; parent_id: string | null; user_id: string }>()
    if (!parent) throw new ApiError(400, "父评论不存在", "INVALID_PARENT")
    parentId = parent.id
    replyToUserId = parent.user_id === user.id ? null : parent.user_id
  }
  const cid = uuid()
  const now = new Date().toISOString()
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO post_comments (id, post_id, user_id, parent_id, reply_to_user_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(cid, id, user.id, parentId, replyToUserId, text, now),
    env.DB.prepare("UPDATE posts SET comment_count = comment_count + 1 WHERE id=?").bind(id),
  ])

  await maybeNotify(env, {
    type: "post_comment", postId: id, commentId: cid, actorId: user.id,
    recipientId: post.user_id, replyToUserId: replyToUserId ?? undefined,
  })
  return json({ comment: { id: cid } }, 201)
}

/** DELETE /api/community/posts/:id —— 作者或管理员软删 */
export async function deletePost(env: Env, request: Request, id: string): Promise<Response> {
  const user = await requireCommunityUser(env, request)
  const row = await env.DB.prepare("SELECT user_id FROM posts WHERE id=?").bind(id).first<{ user_id: string }>()
  if (!row) throw new ApiError(404, "帖子不存在", "NOT_FOUND")
  if (row.user_id !== user.id && user.role !== "admin" && user.role !== "root") throw new ApiError(403, "无权删除", "FORBIDDEN")
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
        "INSERT INTO notifications (id, user_id, category, type, actor_id, post_id, comment_id, read, created_at) VALUES (?, ?, 'social', ?, ?, ?, ?, 0, ?)"
      ).bind(uuid(), args.recipientId, args.type, args.actorId, args.postId, args.commentId, new Date().toISOString()).run()
    } catch {}
    await maybeSendMail(env, args.recipientId, args.postId)
  }

  // 若是回复某人，且那人不是帖子作者、不是自己 → 给那人也发 comment_reply
  if (args.replyToUserId && args.replyToUserId !== args.actorId && args.replyToUserId !== args.recipientId) {
    try {
      await env.DB.prepare(
        "INSERT INTO notifications (id, user_id, category, type, actor_id, post_id, comment_id, read, created_at) VALUES (?, ?, 'social', 'comment_reply', ?, ?, ?, 0, ?)"
      ).bind(uuid(), args.replyToUserId, args.actorId, args.postId, args.commentId, new Date().toISOString()).run()
    } catch {}
    await maybeSendMail(env, args.replyToUserId, args.postId)
  }
}

async function maybeSendMail(env: Env, recipientId: string, postId: string): Promise<void> {
  const u = await env.DB.prepare("SELECT email, notify_enabled FROM users WHERE id=?").bind(recipientId).first<{ email: string; notify_enabled: number }>()
  if (!u || !u.notify_enabled) return
  const link = `https://cloud.doulor.cn/community/${postId}`
  const { text, html } = renderMail("你在 Doulor Cloud 社区有新互动", [
    "有人回复了你的帖子或评论。",
    `查看：${link}`,
  ])
  try { await sendMail(env, { to: u.email, subject: "【Doulor Cloud】社区新互动", text, html }) } catch {}
}

/**
 * GET /api/notifications —— 消息箱列表。
 *
 * 可选 `category` 过滤（system / site / social / event）；不传或非法值 = 全部。
 * 社区页的「N 条新互动」弹窗传 category=social，只拿互动消息。
 *
 * 「邮箱未验证」是**状态**不是事件：它由本接口按 users.email_verified 虚拟合成，
 * 不落库。这样用户验证后提示自动消失，也不会留下删不掉的常驻红点
 * （合成消息 read:true，不计入未读数）。
 */
export async function listNotifications(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const url = new URL(request.url)
  const rawCategory = url.searchParams.get("category") ?? ""
  const category = isMessageCategory(rawCategory) ? rawCategory : null

  const where = category ? "WHERE n.user_id = ? AND n.category = ?" : "WHERE n.user_id = ?"
  const binds: unknown[] = category ? [user.id, category] : [user.id]

  const rows = await env.DB.prepare(
    `SELECT n.id, n.category, n.type, n.title, n.body, n.link, n.payload,
            n.actor_id, n.post_id, n.comment_id, n.read, n.created_at,
            a.username AS actor_username, a.nickname AS actor_nickname,
            p.body AS post_body, p.deleted_at AS post_deleted,
            c.body AS comment_body
       FROM notifications n
       LEFT JOIN users a ON a.id = n.actor_id
       LEFT JOIN posts p ON p.id = n.post_id
       LEFT JOIN post_comments c ON c.id = n.comment_id
      ${where}
      ORDER BY n.created_at DESC LIMIT 50`
  ).bind(...binds).all()

  const notifications = (rows.results ?? []).map((r: Record<string, unknown>) => ({
    id: r.id,
    category: r.category ?? "social",
    type: r.type,
    title: (r.title as string | null) ?? null,
    body: (r.body as string | null) ?? null,
    link: (r.link as string | null) ?? null,
    payload: parsePayload(r.payload),
    actorUsername: r.actor_username ?? null,
    actorNickname: r.actor_nickname ?? null,
    postId: r.post_id,
    commentId: r.comment_id,
    read: r.read === 1,
    createdAt: r.created_at,
    // 帖子摘要（帖子被删则置 null，前端据此显示「帖子已删除」）
    postPreview: r.post_deleted ? null : ((r.post_body as string) ?? "").replace(/\s+/g, " ").slice(0, 60),
    postDeleted: r.post_deleted != null,
    // 触发这次互动的评论/回复正文（feedback_reply 无评论则为 null）
    commentPreview: ((r.comment_body as string | null) ?? null),
  }))

  // 邮箱未验证提示：仅在不带分类、或正是查系统消息时注入
  if (!category || category === "system") {
    if (user.email_verified !== 1) {
      notifications.unshift({
        id: "sys:email_unverified",
        category: "system",
        type: "email_unverified",
        title: "邮箱尚未验证",
        body: `你的邮箱 ${user.email} 还没有验证。验证后才能正常接收本站通知、使用邮件转发等功能。`,
        link: "/dashboard/settings",
        payload: null,
        actorUsername: null,
        actorNickname: null,
        postId: null,
        commentId: null,
        // read:true —— 这是「待办提示」而非新消息，不应让铃铛常驻红点
        read: true,
        createdAt: new Date().toISOString(),
        postPreview: null,
        postDeleted: false,
        commentPreview: null,
      })
    }
  }

  return json({ notifications })
}

/** payload 列是 JSON 文本；解析失败一律当 null，不让脏数据把整个列表打挂 */
function parsePayload(raw: unknown): unknown {
  if (typeof raw !== "string" || !raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** GET /api/notifications/unread-count —— 总数（铃铛）+ 各分类计数（分类小标） */
export async function unreadCount(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const rows = await env.DB.prepare(
    "SELECT category, COUNT(*) AS c FROM notifications WHERE user_id=? AND read=0 GROUP BY category"
  ).bind(user.id).all<{ category: string; c: number }>()

  const byCategory = { system: 0, site: 0, social: 0, event: 0 }
  let total = 0
  for (const r of rows.results ?? []) {
    total += r.c
    if (isMessageCategory(r.category)) byCategory[r.category] += r.c
  }
  return json({ count: total, byCategory })
}

/**
 * GET /api/notifications/latest?lang=zh|en
 *
 * 只回「最新一条未读」—— 给网页侧的「零配置通知」用（比拉整个列表轻得多）。
 * 没有未读就返回 null。
 *
 * ⚠️ 标题/正文的口径必须与消息中心页面保持一致：
 *   category 为 site / system 的用库里存的 title / body；
 *   社交类（点赞、回复）库里没有标题，得按 type + 互动人拼出来。
 *   两边口径不一致的话，通知里看到的内容会和点进去页面上显示的对不上。
 */
export async function latestNotification(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const lang = (new URL(request.url).searchParams.get("lang") ?? "zh").toLowerCase()
  const en = lang.startsWith("en")

  const row = await env.DB.prepare(
    `SELECT n.id, n.category, n.type, n.title, n.body, n.link,
            a.username AS actor_username, a.nickname AS actor_nickname,
            p.body AS post_body, p.deleted_at AS post_deleted
       FROM notifications n
       LEFT JOIN users a ON a.id = n.actor_id
       LEFT JOIN posts p ON p.id = n.post_id
      WHERE n.user_id = ? AND n.read = 0
      ORDER BY n.created_at DESC LIMIT 1`
  )
    .bind(user.id)
    .first<Record<string, unknown>>()

  if (!row) return json(null)

  const actor = (
    (row.actor_nickname as string | null) ||
    (row.actor_username as string | null) ||
    ""
  ).trim()
  const preview = row.post_deleted
    ? ""
    : String(row.post_body ?? "").replace(/\s+/g, " ").slice(0, 60)

  let title = String(row.title ?? "").trim()
  let body = String(row.body ?? "").trim()

  if (!title) {
    const who = actor || (en ? "Someone" : "有人")
    if (row.type === "post_like") title = en ? `${who} liked your post` : `${who} 赞了你的帖子`
    else if (row.type === "post_comment" || row.type === "comment_reply")
      title = en ? `${who} replied to your post` : `${who} 回复了你的帖子`
    else title = en ? "New message" : "新消息"
  }
  if (!body) body = preview

  return json({
    id: row.id,
    title,
    body,
    link: (row.link as string | null) || "/dashboard/messages",
  })
}

/** POST /api/notifications/read */
export async function markRead(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  assertContentLengthWithin(request, MAX_JSON_BODY_BYTES, "请求内容过大")
  const body = (await request.json().catch(() => ({}))) as {
    ids?: unknown
    all?: boolean
    category?: unknown
  }
  if (body.all) {
    await env.DB.prepare("UPDATE notifications SET read=1 WHERE user_id=?").bind(user.id).run()
    return json({ ok: true })
  }

  // 按分类整批已读：消息中心的活动 tab 展示的是活动卡片（/events），
  // 对应的通知行不会逐条点开，需要按分类一次性清掉，否则铃铛红点永远不消。
  if (typeof body.category === "string" && isMessageCategory(body.category)) {
    await env.DB.prepare("UPDATE notifications SET read=1 WHERE user_id=? AND category=?")
      .bind(user.id, body.category)
      .run()
    return json({ ok: true })
  }

  // ⚠️ 2026-09-25 审计（M31）：原实现把 body.ids 直接展开进 IN (?,?,…)，
  // 没有任何数量与类型校验。D1 单语句的绑定参数上限是 100，
  // 所以只要传 100 个以上的 id（或混入对象/数组），这条 UPDATE 就必然抛错，
  // 接口稳定返回 500；同时未过滤的数组元素也可能被当作绑定值塞进 SQL。
  // 现在：只接受字符串、去重、截断到 90 个（留出 user_id 与余量）。
  const raw = Array.isArray(body.ids) ? body.ids : []
  const ids = Array.from(
    new Set(raw.filter((v): v is string => typeof v === "string" && v.length > 0))
  ).slice(0, MAX_MARK_READ_IDS)

  if (ids.length > 0) {
    const ph = ids.map(() => "?").join(",")
    await env.DB.prepare(`UPDATE notifications SET read=1 WHERE user_id=? AND id IN (${ph})`).bind(user.id, ...ids).run()
  }
  return json({ ok: true })
}

const IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
}

/**
 * POST /api/community/posts/:id/images —— 上传单张压缩后图片。
 * 返回 key（入库用）与 url（可直接访问，形如 /c/<postId>/<filename>）。
 */
export async function uploadPostImage(env: Env, request: Request, id: string): Promise<Response> {
  const user = await requireCommunityUser(env, request)
  // 每次上传都写入 R2（计费操作）。社区单帖最多 9 图，取 40 次/分钟：
  // 一张一张传够用，又拦得住脚本化的密集调用。
  await guardRateLimit(env, `post-image:${user.id}`, 40, 60, "图片上传过于频繁")
  if (!(await isStorageConfigured(env))) throw new ApiError(503, "存储未配置", "R2_NOT_CONFIGURED")
  const post = await env.DB.prepare("SELECT user_id FROM posts WHERE id=?").bind(id).first<{ user_id: string }>()
  if (!post) throw new ApiError(404, "帖子不存在", "NOT_FOUND")
  if (post.user_id !== user.id) throw new ApiError(403, "无权", "FORBIDDEN")

  const ct = (request.headers.get("Content-Type") ?? "").split(";")[0].trim()
  const ext = IMAGE_TYPES[ct]
  if (!ext) throw new ApiError(400, "仅支持 JPG/PNG/WebP/GIF", "INVALID_TYPE")
  const maxBytes = await getSettingNumber(env, "community_image_max_bytes")
  // ⚠️ 2026-09-25 审计（L29）：先看 Content-Length 再读，别把超大请求体读进内存后才判
  const buf = await readBodyCapped(
    request,
    maxBytes,
    `图片需在 ${Math.round(maxBytes / 1024)} KB 以内`,
    400,
    "TOO_LARGE"
  )
  if (buf.byteLength === 0) {
    throw new ApiError(400, `图片需在 ${Math.round(maxBytes / 1024)} KB 以内`, "TOO_LARGE")
  }
  if (!hasValidImageSignature(buf, ct)) {
    throw new ApiError(400, "图片内容与声明的类型不匹配", "INVALID_IMAGE")
  }
  const bucketId = await getPlatformBucketId(env)
  const filename = `${uuid()}.${ext}`
  const key = `community/${id}/${filename}`
  await putObject(env, key, buf, ct, bucketId)

  // 上传成功后把 key 追加进 posts.images（发帖流程是「先建帖、后逐张传图」）
  const postRow = await env.DB.prepare("SELECT images FROM posts WHERE id=?").bind(id).first<{ images: string | null }>()
  let images: string[] = []
  if (postRow?.images) {
    try { images = JSON.parse(postRow.images) as string[] } catch { images = [] }
  }
  const maxImages = await getSettingNumber(env, "community_post_max_images")
  if (images.length >= maxImages) {
    // 超限：删掉刚传的对象并报错
    try { await deleteObject(env, key, bucketId) } catch {}
    throw new ApiError(400, `每帖最多 ${maxImages} 张图片`, "TOO_MANY_IMAGES")
  }
  images.push(key)
  await env.DB.prepare("UPDATE posts SET images = ? WHERE id = ?").bind(JSON.stringify(images), id).run()

  return json({ key, url: `/c/${id}/${filename}` })
}

/**
 * GET /api/community/stats —— 社区动态概览（匿名可读）。
 * 右侧动态栏用：今日新帖数、本周活跃用户（发帖最多 top 5）、帖子总数。
 *
 * 缓存策略：统计结果对所有访客完全相同，且不是实时性要求高的数据，
 * 因此放进 Cache API 缓存 60 秒。这是匿名可读接口（最容易被刷），
 * 缓存后重复请求不再落到 D1。
 *
 * 注意两点：
 *   1. 权限校验（readViewer）必须在缓存之前执行，否则访客开关一改，
 *      缓存里的旧结果会让本该 401 的请求继续返回数据；
 *   2. 缓存 key 用固定的内部 URL，不能直接用 request.url ——
 *      否则不同 query 串会各占一份缓存。
 */
const STATS_CACHE_TTL_SECONDS = 60

/**
 * GET /api/community/new-posts-count —— 「我看过之后新增」的帖子数。
 * 侧边栏「社区广场」入口的灰色角标用。需登录（社区本身登录可见）。
 *
 * 口径（改过一次，见迁移 0043）：
 *   - 看过：count(posts where created_at > users.community_seen_at)
 *   - 没看过：回落「最近 24 小时」，避免老用户一上线就看到一个积累很久的大数字
 *   - 不算自己发的帖子 —— 自己发的不需要「去读」
 *   - 进社区页面时前端调 POST /community/seen 刷新 community_seen_at，角标随之为 0
 *
 * 旧口径是「全站最近 24 小时新帖数」，跟「读没读过」无关，
 * 表现为：点进去读完，角标还在（用户反馈过这个问题）。
 */
export async function newPostsCount(env: Env, request: Request): Promise<Response> {
  const me = await requireUser(env, request)

  const row = await env.DB.prepare(
    "SELECT community_seen_at FROM users WHERE id = ?"
  )
    .bind(me.id)
    .first<{ community_seen_at: string | null }>()

  const since =
    row?.community_seen_at ??
    new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const r = await env.DB.prepare(
    `SELECT COUNT(*) c FROM posts
      WHERE created_at > ? AND deleted_at IS NULL AND user_id <> ?`
  )
    .bind(since, me.id)
    .first<{ c: number }>()

  return json({ count: r?.c ?? 0 })
}

/**
 * POST /api/community/seen —— 记下「我刚打开过社区」。
 *
 * 单独一个端点而不是塞进列表接口的副作用：列表接口会被
 * 「加载更多 / 切换标签」反复调用，把它变成写操作会让缓存与语义都变脏。
 * 由社区页面挂载时调用一次，同时前端立即把角标清零（不等下一次轮询）。
 */
export async function markCommunitySeen(env: Env, request: Request): Promise<Response> {
  const me = await requireUser(env, request)
  await env.DB.prepare("UPDATE users SET community_seen_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), me.id)
    .run()
  return json({ ok: true })
}

export async function communityStats(
  env: Env,
  request: Request,
  ctx?: ExecutionContext
): Promise<Response> {
  await readViewer(env, request)
  // caches.default 只在自定义域名/生产环境下可用；本地或单测环境可能没有，
  // 取不到就退化为不缓存，不影响功能。
  const cacheKey = new Request("https://cache.internal/community/stats", { method: "GET" })
  const cache = typeof caches !== "undefined" ? caches.default : undefined

  if (cache) {
    const hit = await cache.match(cacheKey)
    if (hit) return hit
  }

  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()

  // 三条统计互不依赖，放进一个 batch 省掉串行往返
  const [todayRes, totalRes, activeRes] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) c FROM posts WHERE created_at >= ? AND deleted_at IS NULL").bind(
      todayStart
    ),
    env.DB.prepare("SELECT COUNT(*) c FROM posts WHERE deleted_at IS NULL"),
    env.DB.prepare(
      `SELECT u.username, u.nickname, u.avatar_key, COUNT(p.id) AS posts
         FROM posts p JOIN users u ON u.id = p.user_id
        WHERE p.created_at >= ? AND p.deleted_at IS NULL
        GROUP BY u.id ORDER BY posts DESC LIMIT 5`
    ).bind(weekAgo),
  ])

  const todayCount =
    (todayRes as { results?: { c: number }[] }).results?.[0]?.c ?? 0
  const totalCount =
    (totalRes as { results?: { c: number }[] }).results?.[0]?.c ?? 0
  const activeUsers = (
    (activeRes as {
      results?: { username: string; nickname: string | null; avatar_key: string | null; posts: number }[]
    }).results ?? []
  ).map((r) => ({
    username: r.username,
    nickname: r.nickname ?? null,
    hasAvatar: Boolean(r.avatar_key),
    posts: r.posts,
  }))

  const body = JSON.stringify({ todayCount, totalCount, activeUsers })
  const res = new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${STATS_CACHE_TTL_SECONDS}`,
      ...SAFE_JSON_HEADERS,
    },
  })

  // 写缓存用 waitUntil：不阻塞响应；clone 是因为响应体只能被读一次
  if (cache) {
    const write = cache.put(cacheKey, res.clone())
    if (ctx) ctx.waitUntil(write)
    else await write
  }

  return res
}

/**
 * GET /c/<postId>/<filename> —— 帖子图片公开读取（走 Host 分发层，非 /api）。
 * 图片存平台桶 `community/<postId>/<filename>`，任何人可读（与帖子正文同可见性）。
 */
export async function serveCommunityImage(
  env: Env,
  postId: string,
  filename: string
): Promise<Response> {
  // filename 限制：只允许 <uuid>.<ext>，防路径穿越
  if (!/^[a-zA-Z0-9-]+\.(jpg|jpeg|png|webp|gif)$/i.test(filename)) {
    return new Response("Not Found", { status: 404 })
  }
  if (!(await isStorageConfigured(env))) return new Response("Not Found", { status: 404 })
  const bucketId = await getPlatformBucketId(env)
  const post = await env.DB.prepare("SELECT deleted_at FROM posts WHERE id=?").bind(postId).first<{ deleted_at: string | null }>()
  if (!post || post.deleted_at) return new Response("Not Found", { status: 404 })
  const key = `community/${postId}/${filename}`
  try {
    const res = await getObject(env, key, undefined, bucketId)
    // 类型收口 + nosniff：公开读取接口不依赖写入侧校验（纵深防御）
    return hardenUserContentResponse(res, filename)
  } catch {
    return new Response("Not Found", { status: 404 })
  }
}

/** Check the binary signature instead of trusting a client-controlled Content-Type. */
export function hasValidImageSignature(buf: ArrayBuffer, contentType: string): boolean {
  const bytes = new Uint8Array(buf)
  const startsWith = (signature: number[]) => signature.every((value, index) => bytes[index] === value)
  switch (contentType.toLowerCase()) {
    case "image/jpeg":
      return startsWith([0xff, 0xd8, 0xff])
    case "image/png":
      return startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case "image/gif":
      return startsWith([0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
    case "image/webp":
      return startsWith([0x52, 0x49, 0x46, 0x46]) && bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    default:
      return false
  }
}
