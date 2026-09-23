import * as React from "react"
import { Link, useParams, useNavigate } from "react-router-dom"
import { Heart, MessageCircle, Share2, Send, Trash2, Loader2, ArrowLeft } from "lucide-react"
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
import type { Post, CommentNode } from "@/types"

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

function AuthorLine({ post }: { post: Post }) {
  return (
    <div className="flex items-center gap-2">
      <UserAvatar username={post.author.username} nickname={post.author.nickname} hasAvatar={post.author.hasAvatar} />
      <div className="leading-tight">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium">{post.author.nickname ?? post.author.username}</span>
          {post.author.isAdmin && <Badge variant="secondary" className="h-5">管理员</Badge>}
          <span className="text-xs text-muted-foreground">@{post.author.username}</span>
        </div>
      </div>
      <span className="ml-auto text-xs text-muted-foreground">{fmtTime(post.createdAt)}</span>
    </div>
  )
}

function PostActions({ post, onLike, onShare, onDelete }: {
  post: Post
  onLike: () => void
  onShare: () => void
  onDelete?: () => void
}) {
  return (
    <div className="mt-3 flex items-center gap-5 text-sm text-muted-foreground">
      <button onClick={onLike} className={"flex items-center gap-1 hover:text-foreground " + (post.liked ? "text-red-500" : "")}>
        <Heart className="h-4 w-4" /> {post.likeCount}
      </button>
      <Link to={`/community/${post.id}`} className="flex items-center gap-1 hover:text-foreground">
        <MessageCircle className="h-4 w-4" /> {post.commentCount}
      </Link>
      <button onClick={onShare} className="flex items-center gap-1 hover:text-foreground">
        <Share2 className="h-4 w-4" /> {post.shareCount}
      </button>
      {onDelete && (
        <button onClick={onDelete} className="ml-auto hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
      )}
    </div>
  )
}

function PostCard({ post, onChanged }: { post: Post; onChanged?: () => void }) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const requireLogin = () => { if (!user) { navigate("/login", { state: { from: "/dashboard/community" } }); return false } return true }

  const handleLike = async () => {
    if (!requireLogin()) return
    try {
      await communityApi.toggleLike(post.id)
      onChanged?.()
    } catch (err) { toast.error(err instanceof HttpError ? err.message : "操作失败") }
  }
  const handleShare = async () => {
    try {
      await navigator.clipboard.writeText(`https://cloud.doulor.cn/community/${post.id}`)
      await communityApi.share(post.id)
      onChanged?.()
      toast.success("链接已复制")
    } catch { toast.error("复制失败") }
  }
  const handleDelete = async () => {
    if (!confirm("确定删除这条帖子？")) return
    try {
      await communityApi.deletePost(post.id)
      onChanged?.()
      toast.success("已删除")
    } catch (err) { toast.error(err instanceof HttpError ? err.message : "删除失败") }
  }

  return (
    <div className="rounded-lg border p-4">
      <AuthorLine post={post} />
      <p className="mt-3 whitespace-pre-wrap text-sm">{post.body}</p>
      <PostActions post={post} onLike={handleLike} onShare={handleShare} onDelete={post.isMine ? handleDelete : undefined} />
    </div>
  )
}

function CommentItem({ node, postId, onChanged }: { node: CommentNode; postId: string; onChanged: () => void }) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [replying, setReplying] = React.useState(false)
  const [text, setText] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  const submit = async () => {
    if (!user) { navigate("/login", { state: { from: `/community/${postId}` } }); return }
    if (!text.trim()) return
    setBusy(true)
    try {
      // 回复根评论：只传 parentId，不传 replyToUserId（CommentNode 无 user_id 字段）
      await communityApi.comment(postId, text.trim(), node.id)
      setText(""); setReplying(false); onChanged()
    } catch (err) { toast.error(err instanceof HttpError ? err.message : "评论失败") }
    finally { setBusy(false) }
  }

  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center gap-2">
        <UserAvatar username={node.author.username} nickname={node.author.nickname} hasAvatar={node.author.hasAvatar} className="h-7 w-7" />
        <span className="text-sm font-medium">{node.author.nickname ?? node.author.username}</span>
        <span className="text-xs text-muted-foreground">@{node.author.username}</span>
        <span className="ml-auto text-xs text-muted-foreground">{fmtTime(node.createdAt)}</span>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap text-sm">{node.body}</p>
      {user && (
        <button onClick={() => setReplying((v) => !v)} className="mt-1 text-xs text-muted-foreground hover:text-foreground">回复</button>
      )}
      {replying && (
        <div className="mt-2 flex gap-2">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} className="text-sm" />
          <Button size="sm" onClick={submit} disabled={busy || !text.trim()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</Button>
        </div>
      )}
      {node.replies.length > 0 && (
        <div className="mt-3 space-y-2 border-l-2 pl-3">
          {node.replies.map((r) => (
            <div key={r.id} className="rounded-md bg-muted/40 p-2">
              <div className="flex items-center gap-2">
                <UserAvatar username={r.author.username} nickname={r.author.nickname} hasAvatar={r.author.hasAvatar} className="h-6 w-6" />
                <span className="text-sm font-medium">{r.author.nickname ?? r.author.username}</span>
                <span className="text-xs text-muted-foreground">@{r.author.username}</span>
                <span className="ml-auto text-xs text-muted-foreground">{fmtTime(r.createdAt)}</span>
              </div>
              <p className="mt-1 text-sm">{r.body}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function CommentTree({ comments, postId, onChanged }: { comments: CommentNode[]; postId: string; onChanged: () => void }) {
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
      setPost(p.post); setComments(c.comments)
    } catch { /* 帖子可能已删 */ } finally { setLoading(false) }
  }, [id])

  React.useEffect(() => { void load() }, [load])

  const submitComment = async () => {
    if (!user) { navigate("/login", { state: { from: `/community/${id}` } }); return }
    if (!text.trim()) return
    setBusy(true)
    try {
      await communityApi.comment(id, text.trim())
      setText(""); await load()
    } catch (err) { toast.error(err instanceof HttpError ? err.message : "评论失败") }
    finally { setBusy(false) }
  }

  if (loading) return <LoadingBlock />
  if (!post) return <EmptyState title="帖子不存在" description="可能已被删除。" />

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={() => navigate(inDashboard ? "/dashboard/community" : "/community")}>
        <ArrowLeft className="h-4 w-4" /> 返回
      </Button>
      <PostCard post={post} onChanged={load} />
      <div>
        <h3 className="mb-3 text-sm font-medium">评论（{post.commentCount}）</h3>
        {comments.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有评论，来说点什么？</p>
        ) : <CommentTree comments={comments} postId={id} onChanged={load} />}
      </div>
      {user ? (
        <div className="flex gap-2 rounded-lg border p-3">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="评论…" className="text-sm" />
          <Button size="sm" onClick={submitComment} disabled={busy || !text.trim()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground"><Link to="/login" state={{ from: `/community/${id}` }} className="text-primary underline">登录</Link> 后可评论。</p>
      )}
    </div>
  )
}

export default function CommunityPage({ inDashboard = false }: { inDashboard?: boolean }) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const [posts, setPosts] = React.useState<Post[]>([])
  const [cursor, setCursor] = React.useState<string | undefined>(undefined)
  const [loading, setLoading] = React.useState(true)
  const [draft, setDraft] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [unread, setUnread] = React.useState(0)

  const load = React.useCallback(async (c?: string) => {
    setLoading(true)
    try {
      const res = await communityApi.listPosts(c)
      setPosts((prev) => (c ? [...prev, ...res.posts] : res.posts))
      setCursor(res.nextCursor ?? undefined)
    } catch { /* 静默 */ } finally { setLoading(false) }
  }, [])

  React.useEffect(() => { if (!id) void load() }, [load, id])

  React.useEffect(() => {
    if (!user) { setUnread(0); return }
    const tick = () => { void notificationApi.unreadCount().then((r) => setUnread(r.count)).catch(() => {}) }
    tick()
    const t = setInterval(tick, 30000)
    return () => clearInterval(t)
  }, [user])

  const requireLogin = () => { if (!user) { navigate("/login", { state: { from: "/dashboard/community" } }); return false } return true }

  const handlePost = async () => {
    if (!requireLogin() || !draft.trim()) return
    setBusy(true)
    try {
      await communityApi.createPost(draft.trim())
      setDraft("")
      await load()
      toast.success("已发布")
    } catch (err) { toast.error(err instanceof HttpError ? err.message : "发布失败") }
    finally { setBusy(false) }
  }

  if (id) return <PostDetail id={id} inDashboard={inDashboard} />

  return (
    <div>
      {!inDashboard && <PageHeader title="社区广场" description="Doulor Cloud 的交流区" />}
      {user ? (
        <div className="mb-6 rounded-lg border p-4">
          <div className="mb-2 flex items-center gap-2">
            <UserAvatar username={user.username} nickname={user.nickname} hasAvatar={user.hasAvatar} className="h-8 w-8" />
            <span className="text-sm font-medium">{user.nickname ?? user.username}</span>
            {unread > 0 && <Badge variant="destructive" className="h-5">{unread}</Badge>}
          </div>
          <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="发点什么…" rows={3} />
          <div className="mt-2 flex justify-end">
            <Button onClick={handlePost} disabled={busy || !draft.trim()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}发布</Button>
          </div>
        </div>
      ) : (
        <div className="mb-6 rounded-lg border p-4 text-sm text-muted-foreground">
          <Link to="/login" state={{ from: "/dashboard/community" }} className="text-primary underline">登录</Link> 后可发帖、评论、点赞。
        </div>
      )}

      {loading ? <LoadingBlock /> : posts.length === 0 ? (
        <EmptyState icon={MessageCircle} title="还没有帖子" description="成为第一个发帖的人。" />
      ) : (
        <div className="space-y-4">
          {posts.map((p) => <PostCard key={p.id} post={p} onChanged={() => load()} />)}
          {cursor && <Button variant="ghost" className="w-full" onClick={() => load(cursor)}>加载更多</Button>}
        </div>
      )}
    </div>
  )
}
