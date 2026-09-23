import * as React from "react"
import { Link, useParams, useNavigate } from "react-router-dom"
import {
  Heart,
  MessageCircle,
  Share2,
  Send,
  Trash2,
  Loader2,
  ArrowLeft,
  PenSquare,
  Flame,
  TrendingUp,
  Users,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { LoadingBlock } from "@/components/loading-block"
import { UserAvatar } from "@/components/user-avatar"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { useAuth } from "@/hooks/use-auth"
import { communityApi, notificationApi, HttpError } from "@/services/api"
import type { Post, CommentNode, CommunityStats } from "@/types"

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/** 相对时间：3 分钟前 / 2 小时前 / 昨天 / 3 天前，再老回退到日期 */
function relTime(iso: string) {
  const t = new Date(iso).getTime()
  const diff = Date.now() - t
  const m = Math.floor(diff / 60000)
  if (m < 1) return "刚刚"
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d === 1) return "昨天"
  if (d < 7) return `${d} 天前`
  return fmtTime(iso)
}

function AuthorLine({ post, size = "sm" }: { post: Post; size?: "sm" | "md" }) {
  const av = size === "md" ? "h-10 w-10" : "h-9 w-9"
  return (
    <div className="flex items-center gap-2.5">
      <UserAvatar
        username={post.author.username}
        nickname={post.author.nickname}
        hasAvatar={post.author.hasAvatar}
        className={av}
      />
      <div className="leading-tight">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-semibold">{post.author.nickname ?? post.author.username}</span>
          {post.author.isAdmin && (
            <Badge variant="secondary" className="h-5 gap-1 px-1.5 text-[10px]">
              管理员
            </Badge>
          )}
          <span className="text-xs text-muted-foreground">@{post.author.username}</span>
        </div>
      </div>
      <span className="ml-auto text-xs text-muted-foreground" title={fmtTime(post.createdAt)}>
        {relTime(post.createdAt)}
      </span>
    </div>
  )
}

function PostActions({
  post,
  onLike,
  onShare,
  onDelete,
  detail,
}: {
  post: Post
  onLike: () => void
  onShare: () => void
  onDelete?: () => void
  detail?: boolean
}) {
  return (
    <div className={"mt-3 flex items-center gap-1 text-sm text-muted-foreground " + (detail ? "" : "border-t pt-2.5")}>
      <button
        onClick={onLike}
        className={
          "flex items-center gap-1.5 rounded-md px-2.5 py-1 transition-colors hover:bg-accent hover:text-red-500 " +
          (post.liked ? "text-red-500" : "hover:text-red-500")
        }
      >
        <Heart className={"h-4 w-4 " + (post.liked ? "fill-current" : "")} />
        <span className="tabular-nums">{post.likeCount}</span>
      </button>
      {!detail && (
        <Link
          to={`/community/${post.id}`}
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1 transition-colors hover:bg-accent hover:text-foreground"
        >
          <MessageCircle className="h-4 w-4" />
          <span className="tabular-nums">{post.commentCount}</span>
        </Link>
      )}
      <button
        onClick={onShare}
        className="flex items-center gap-1.5 rounded-md px-2.5 py-1 transition-colors hover:bg-accent hover:text-foreground"
      >
        <Share2 className="h-4 w-4" />
        <span className="tabular-nums">{post.shareCount}</span>
      </button>
      {onDelete && (
        <button
          onClick={onDelete}
          className="ml-auto flex items-center gap-1.5 rounded-md px-2.5 py-1 transition-colors hover:bg-accent hover:text-destructive"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}

function PostCard({ post, onChanged }: { post: Post; onChanged?: () => void }) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const requireLogin = () => {
    if (!user) {
      navigate("/login", { state: { from: "/dashboard/community" } })
      return false
    }
    return true
  }

  const handleLike = async () => {
    if (!requireLogin()) return
    try {
      await communityApi.toggleLike(post.id)
      onChanged?.()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "操作失败")
    }
  }
  const handleShare = async () => {
    try {
      await navigator.clipboard.writeText(`https://cloud.doulor.cn/community/${post.id}`)
      await communityApi.share(post.id)
      onChanged?.()
      toast.success("链接已复制到剪贴板")
    } catch {
      toast.error("复制失败")
    }
  }
  const handleDelete = async () => {
    if (!confirm("确定删除这条帖子？")) return
    try {
      await communityApi.deletePost(post.id)
      onChanged?.()
      toast.success("已删除")
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "删除失败")
    }
  }

  return (
    <article className="group relative overflow-hidden rounded-xl border bg-card p-4 transition-all hover:border-border/80 hover:shadow-sm">
      {/* 左侧彩色竖条，论坛风标识 */}
      <span className="absolute inset-y-0 left-0 w-1 rounded-l-xl bg-gradient-to-b from-primary/40 to-primary/10" />
      <div className="pl-2">
        <AuthorLine post={post} />
        <p className="mt-2.5 whitespace-pre-wrap break-words text-sm leading-relaxed">{post.body}</p>
        <PostActions
          post={post}
          onLike={handleLike}
          onShare={handleShare}
          onDelete={post.isMine ? handleDelete : undefined}
        />
      </div>
    </article>
  )
}

function CommentItem({
  node,
  postId,
  onChanged,
}: {
  node: CommentNode
  postId: string
  onChanged: () => void
}) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [replying, setReplying] = React.useState(false)
  const [text, setText] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  const submit = async () => {
    if (!user) {
      navigate("/login", { state: { from: `/community/${postId}` } })
      return
    }
    if (!text.trim()) return
    setBusy(true)
    try {
      await communityApi.comment(postId, text.trim(), node.id)
      setText("")
      setReplying(false)
      onChanged()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "评论失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-center gap-2">
        <UserAvatar
          username={node.author.username}
          nickname={node.author.nickname}
          hasAvatar={node.author.hasAvatar}
          className="h-7 w-7"
        />
        <span className="text-sm font-medium">{node.author.nickname ?? node.author.username}</span>
        <span className="text-xs text-muted-foreground">@{node.author.username}</span>
        <span className="ml-auto text-xs text-muted-foreground" title={fmtTime(node.createdAt)}>
          {relTime(node.createdAt)}
        </span>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed">{node.body}</p>
      {user && (
        <button
          onClick={() => setReplying((v) => !v)}
          className="mt-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          回复
        </button>
      )}
      {replying && (
        <div className="mt-2 flex gap-2">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            placeholder={`回复 @${node.author.nickname ?? node.author.username}…`}
            className="text-sm"
          />
          <Button size="sm" onClick={submit} disabled={busy || !text.trim()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      )}
      {node.replies.length > 0 && (
        <div className="mt-3 space-y-2 border-l-2 border-border pl-3">
          {node.replies.map((r) => (
            <div key={r.id} className="rounded-md bg-muted/40 p-2.5">
              <div className="flex items-center gap-2">
                <UserAvatar
                  username={r.author.username}
                  nickname={r.author.nickname}
                  hasAvatar={r.author.hasAvatar}
                  className="h-6 w-6"
                />
                <span className="text-sm font-medium">{r.author.nickname ?? r.author.username}</span>
                <span className="text-xs text-muted-foreground">@{r.author.username}</span>
                <span className="ml-auto text-xs text-muted-foreground" title={fmtTime(r.createdAt)}>
                  {relTime(r.createdAt)}
                </span>
              </div>
              <p className="mt-1 text-sm leading-relaxed">{r.body}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function CommentTree({
  comments,
  postId,
  onChanged,
}: {
  comments: CommentNode[]
  postId: string
  onChanged: () => void
}) {
  return (
    <div className="space-y-3">
      {comments.map((c) => (
        <CommentItem key={c.id} node={c} postId={postId} onChanged={onChanged} />
      ))}
    </div>
  )
}

function PostDetail({ id, inDashboard }: { id: string; inDashboard: boolean }) {
  const [post, setPost] = React.useState<Post | null>(null)
  const [comments, setComments] = React.useState<CommentNode[]>([])
  const [loading, setLoading] = React.useState(true)
  const { user } = useAuth()
  const navigate = useNavigate()
  const [text, setText] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const [p, c] = await Promise.all([communityApi.getPost(id), communityApi.getComments(id)])
      setPost(p.post)
      setComments(c.comments)
    } catch {
      /* 帖子可能已删 */
    } finally {
      setLoading(false)
    }
  }, [id])

  React.useEffect(() => {
    void load()
  }, [load])

  const submitComment = async () => {
    if (!user) {
      navigate("/login", { state: { from: `/community/${id}` } })
      return
    }
    if (!text.trim()) return
    setBusy(true)
    try {
      await communityApi.comment(id, text.trim())
      setText("")
      await load()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "评论失败")
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <LoadingBlock />
  if (!post) return <EmptyState title="帖子不存在" description="可能已被删除。" />

  return (
    <div className="space-y-4">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => navigate(inDashboard ? "/dashboard/community" : "/community")}
      >
        <ArrowLeft className="h-4 w-4" /> 返回广场
      </Button>

      <article className="overflow-hidden rounded-xl border bg-card">
        <div className="border-b bg-muted/30 px-4 py-3">
          <AuthorLine post={post} size="md" />
        </div>
        <div className="p-4">
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{post.body}</p>
        </div>
        <div className="border-t px-4 py-2">
          <PostActions post={post} onLike={async () => { await communityApi.toggleLike(post.id); void load() }} onShare={async () => { try { await navigator.clipboard.writeText(`https://cloud.doulor.cn/community/${post.id}`); await communityApi.share(post.id); toast.success("链接已复制"); void load() } catch { toast.error("复制失败") } }} onDelete={post.isMine ? async () => { if (!confirm("确定删除？")) return; await communityApi.deletePost(post.id); navigate(inDashboard ? "/dashboard/community" : "/community"); toast.success("已删除") } : undefined} detail />
        </div>
      </article>

      <div>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-medium">
          <MessageCircle className="h-4 w-4" />
          评论
          <Badge variant="secondary" className="h-5">{post.commentCount}</Badge>
        </h3>
        {comments.length === 0 ? (
          <div className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
            还没有评论，来说点什么？
          </div>
        ) : (
          <CommentTree comments={comments} postId={id} onChanged={load} />
        )}
      </div>

      {user ? (
        <div className="flex gap-2 rounded-lg border bg-card p-3">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            placeholder="写下你的评论…"
            className="text-sm"
          />
          <Button size="sm" onClick={submitComment} disabled={busy || !text.trim()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          <Link to="/login" state={{ from: `/community/${id}` }} className="text-primary underline">
            登录
          </Link>{" "}
          后可评论。
        </p>
      )}
    </div>
  )
}

/** 发帖入口：点击占位条展开 */
function PostComposer({ onPosted }: { onPosted: () => void }) {
  const { user } = useAuth()
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  if (!user) {
    return (
      <div className="mb-5 rounded-xl border bg-card p-4 text-sm text-muted-foreground">
        <Link
          to="/login"
          state={{ from: "/dashboard/community" }}
          className="font-medium text-primary underline"
        >
          登录
        </Link>{" "}
        后可发帖、评论、点赞，和朋友们聊聊。
      </div>
    )
  }

  const MAX = 5000
  const submit = async () => {
    if (!draft.trim()) return
    setBusy(true)
    try {
      await communityApi.createPost(draft.trim())
      setDraft("")
      setOpen(false)
      onPosted()
      toast.success("发布成功")
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "发布失败")
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mb-5 flex w-full items-center gap-3 rounded-xl border bg-card p-3.5 text-left transition-colors hover:border-primary/40 hover:bg-accent/40"
      >
        <UserAvatar
          username={user.username}
          nickname={user.nickname}
          hasAvatar={user.hasAvatar}
        />
        <span className="flex-1 text-sm text-muted-foreground">
          {user.nickname ?? user.username}，分享点什么？
        </span>
        <span className="flex items-center gap-1.5 rounded-md bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary">
          <PenSquare className="h-3.5 w-3.5" />
          发帖
        </span>
      </button>
    )
  }

  return (
    <div className="mb-5 rounded-xl border bg-card p-4">
      <div className="mb-2.5 flex items-center gap-2">
        <UserAvatar
          username={user.username}
          nickname={user.nickname}
          hasAvatar={user.hasAvatar}
        />
        <span className="text-sm font-medium">{user.nickname ?? user.username}</span>
        <button
          onClick={() => {
            setOpen(false)
            setDraft("")
          }}
          className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="收起"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <Textarea
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="说点什么吧…（Ctrl+Enter 发布）"
        rows={4}
        className="resize-none border-0 px-0 text-sm focus-visible:ring-0"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault()
            void submit()
          }
        }}
      />
      <div className="mt-2 flex items-center justify-between">
        <span className={"text-xs tabular-nums " + (draft.length > MAX ? "text-destructive" : "text-muted-foreground")}>
          {draft.length} / {MAX}
        </span>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setOpen(false)
              setDraft("")
            }}
          >
            取消
          </Button>
          <Button size="sm" onClick={submit} disabled={busy || !draft.trim() || draft.length > MAX}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            发布
          </Button>
        </div>
      </div>
    </div>
  )
}

/** 右侧动态栏：今日新帖、活跃用户、总数 */
function SidePanel({ stats }: { stats: CommunityStats | null }) {
  return (
    <aside className="hidden w-72 shrink-0 space-y-4 lg:block">
      <div className="rounded-xl border bg-card p-4">
        <h3 className="mb-3 flex items-center gap-1.5 text-sm font-medium">
          <TrendingUp className="h-4 w-4 text-primary" />
          社区动态
        </h3>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg bg-muted/40 p-2.5 text-center">
            <p className="text-xl font-semibold tabular-nums">{stats?.todayCount ?? "—"}</p>
            <p className="text-xs text-muted-foreground">今日新帖</p>
          </div>
          <div className="rounded-lg bg-muted/40 p-2.5 text-center">
            <p className="text-xl font-semibold tabular-nums">{stats?.totalCount ?? "—"}</p>
            <p className="text-xs text-muted-foreground">帖子总数</p>
          </div>
        </div>
      </div>

      <div className="rounded-xl border bg-card p-4">
        <h3 className="mb-3 flex items-center gap-1.5 text-sm font-medium">
          <Flame className="h-4 w-4 text-orange-500" />
          本周活跃
        </h3>
        {stats && stats.activeUsers.length > 0 ? (
          <ul className="space-y-2.5">
            {stats.activeUsers.map((u, i) => (
              <li key={u.username} className="flex items-center gap-2">
                <span
                  className={
                    "flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold " +
                    (i === 0
                      ? "bg-amber-500/20 text-amber-600 dark:text-amber-400"
                      : i === 1
                        ? "bg-slate-400/20 text-slate-600 dark:text-slate-300"
                        : i === 2
                          ? "bg-orange-700/20 text-orange-700 dark:text-orange-400"
                          : "bg-muted text-muted-foreground")
                  }
                >
                  {i + 1}
                </span>
                <UserAvatar
                  username={u.username}
                  nickname={u.nickname}
                  hasAvatar={u.hasAvatar}
                  className="h-6 w-6"
                />
                <span className="flex-1 truncate text-sm">
                  {u.nickname ?? u.username}
                </span>
                <span className="text-xs tabular-nums text-muted-foreground">{u.posts} 帖</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">本周还没有人发帖。</p>
        )}
      </div>

      <div className="rounded-xl border bg-gradient-to-br from-primary/5 to-transparent p-4">
        <h3 className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
          <Users className="h-4 w-4 text-primary" />
          关于社区
        </h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Doulor Cloud 社区广场是邀请制小圈子的交流区。内容公开可浏览，发帖与互动需登录。
          请友好交流，违规内容将被管理员移除。
        </p>
      </div>
    </aside>
  )
}

export default function CommunityPage({ inDashboard = false }: { inDashboard?: boolean }) {
  const { user } = useAuth()
  const { id } = useParams<{ id: string }>()
  const [posts, setPosts] = React.useState<Post[]>([])
  const [cursor, setCursor] = React.useState<string | undefined>(undefined)
  const [loading, setLoading] = React.useState(true)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [stats, setStats] = React.useState<CommunityStats | null>(null)
  const [unread, setUnread] = React.useState(0)

  const load = React.useCallback(async (c?: string) => {
    if (c) setLoadingMore(true)
    else setLoading(true)
    try {
      const res = await communityApi.listPosts(c)
      setPosts((prev) => (c ? [...prev, ...res.posts] : res.posts))
      setCursor(res.nextCursor ?? undefined)
    } catch {
      /* 静默 */
    } finally {
      setLoading(c ? false : false)
      setLoadingMore(false)
    }
  }, [])

  const loadStats = React.useCallback(async () => {
    try {
      setStats(await communityApi.getStats())
    } catch {
      /* 静默 */
    }
  }, [])

  React.useEffect(() => {
    if (!id) void load()
    void loadStats()
  }, [load, loadStats, id])

  React.useEffect(() => {
    if (!user) {
      setUnread(0)
      return
    }
    const tick = () => {
      void notificationApi.unreadCount().then((r) => setUnread(r.count)).catch(() => {})
    }
    tick()
    const t = setInterval(tick, 30000)
    return () => clearInterval(t)
  }, [user])

  if (id) return <PostDetail id={id} inDashboard={inDashboard} />

  return (
    <div>
      {!inDashboard && (
        <PageHeader title="社区广场" description="Doulor Cloud 的交流区 · 邀请制小圈子" />
      )}

      {inDashboard && (
        <div className="mb-5">
          <h1 className="text-xl font-semibold tracking-tight">社区广场</h1>
          <p className="text-sm text-muted-foreground">
            和朋友们聊聊近况，分享你的发现。
            {unread > 0 && (
              <Badge variant="destructive" className="ml-2 h-5">
                {unread} 条新互动
              </Badge>
            )}
          </p>
        </div>
      )}

      <div className="flex gap-6">
        {/* 主信息流 */}
        <div className="min-w-0 flex-1">
          <PostComposer onPosted={() => { void load(); void loadStats() }} />

          {loading ? (
            <LoadingBlock />
          ) : posts.length === 0 ? (
            <EmptyState
              icon={MessageCircle}
              title="广场还很安静"
              description="成为第一个发帖的人，打破沉默吧。"
            />
          ) : (
            <div className="space-y-3">
              {posts.map((p) => (
                <PostCard key={p.id} post={p} onChanged={() => { void load(); void loadStats() }} />
              ))}
              {cursor && (
                <Button
                  variant="ghost"
                  className="w-full"
                  disabled={loadingMore}
                  onClick={() => void load(cursor)}
                >
                  {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  加载更多
                </Button>
              )}
            </div>
          )}
        </div>

        {/* 右侧动态栏 */}
        <SidePanel stats={stats} />
      </div>
    </div>
  )
}
