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
  Smile,
  ImagePlus,
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
import { compressImage } from "@/lib/image-compress"
import { EMOJI_GROUPS } from "@/lib/emojis"
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

/** 表情选择面板：点击把 emoji 插到光标处 */
function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [open, setOpen] = React.useState(false)
  const [group, setGroup] = React.useState(0)
  const ref = React.useRef<HTMLDivElement>(null)

  // 点外部关闭
  React.useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={
          "rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground " +
          (open ? "bg-accent text-foreground" : "")
        }
        title="表情"
      >
        <Smile className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-2 w-72 rounded-xl border bg-popover p-2 shadow-lg">
          <div className="mb-1.5 flex flex-wrap gap-0.5 border-b pb-1.5">
            {EMOJI_GROUPS.map((g, i) => (
              <button
                key={g.name}
                type="button"
                onClick={() => setGroup(i)}
                className={
                  "rounded-md px-2 py-1 text-xs transition-colors " +
                  (i === group
                    ? "bg-primary/10 font-medium text-primary"
                    : "text-muted-foreground hover:bg-accent")
                }
              >
                {g.name}
              </button>
            ))}
          </div>
          <div className="grid max-h-44 grid-cols-8 gap-0.5 overflow-y-auto">
            {EMOJI_GROUPS[group].emojis.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => onPick(e)}
                className="rounded-md p-1 text-lg leading-none transition-colors hover:bg-accent"
              >
                {e}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** 帖子图片九宫格：1 张大图，2-4 张两列，5+ 张三列 */
function PostImages({ images }: { images: string[] }) {
  const [preview, setPreview] = React.useState<string | null>(null)
  if (images.length === 0) return null

  const cols =
    images.length === 1 ? "grid-cols-1" : images.length <= 4 ? "grid-cols-2" : "grid-cols-3"

  return (
    <>
      <div className={"mt-3 grid gap-1.5 " + cols}>
        {images.map((src) => (
          <button
            key={src}
            type="button"
            onClick={() => setPreview(src)}
            className={
              "overflow-hidden rounded-lg border bg-muted/30 " +
              (images.length === 1 ? "" : "aspect-square")
            }
          >
            <img
              src={src}
              alt=""
              loading="lazy"
              className={
                "w-full object-cover transition-transform hover:scale-[1.02] " +
                (images.length === 1 ? "max-h-96 object-contain" : "h-full")
              }
            />
          </button>
        ))}
      </div>
      {preview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setPreview(null)}
        >
          <img src={preview} alt="" className="max-h-full max-w-full rounded-lg object-contain" />
          <button
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
            onClick={() => setPreview(null)}
            aria-label="关闭"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      )}
    </>
  )
}

function AuthorLine({ post, size = "sm" }: { post: Post; size?: "sm" | "md" }) {
  const av = size === "md" ? "h-10 w-10" : "h-9 w-9"
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <UserAvatar
        username={post.author.username}
        nickname={post.author.nickname}
        hasAvatar={post.author.hasAvatar}
        className={av}
      />
      <div className="min-w-0 leading-tight">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-semibold">
            {post.author.nickname ?? post.author.username}
          </span>
          {post.author.isAdmin && (
            <Badge variant="secondary" className="h-5 shrink-0 px-1.5 text-[10px]">
              管理员
            </Badge>
          )}
          <span className="truncate text-xs text-muted-foreground">@{post.author.username}</span>
        </div>
      </div>
      <span className="ml-auto shrink-0 text-xs text-muted-foreground" title={fmtTime(post.createdAt)}>
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
  basePath,
}: {
  post: Post
  onLike: () => void
  onShare: () => void
  onDelete?: () => void
  detail?: boolean
  basePath: string
}) {
  return (
    <div
      className={
        "mt-3 flex items-center gap-1 text-sm text-muted-foreground " +
        (detail ? "" : "border-t pt-2.5")
      }
    >
      <button
        onClick={onLike}
        className={
          "flex items-center gap-1.5 rounded-md px-2.5 py-1 transition-colors hover:bg-accent " +
          (post.liked ? "text-red-500" : "hover:text-red-500")
        }
      >
        <Heart className={"h-4 w-4 transition-transform " + (post.liked ? "scale-110 fill-current" : "")} />
        <span className="tabular-nums">{post.likeCount}</span>
      </button>
      {!detail && (
        <Link
          to={`${basePath}/${post.id}`}
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

/** 帖子卡片。点赞/转发由父组件乐观更新，本组件只管触发与渲染。 */
function PostCard({
  post,
  onLike,
  onShare,
  onDelete,
  basePath,
}: {
  post: Post
  onLike: (p: Post) => void
  onShare: (p: Post) => void
  onDelete: (p: Post) => void
  basePath: string
}) {
  return (
    <article className="group relative overflow-hidden rounded-xl border bg-card p-4 transition-all hover:border-border/80 hover:shadow-sm">
      <span className="absolute inset-y-0 left-0 w-1 rounded-l-xl bg-gradient-to-b from-primary/40 to-primary/10" />
      <div className="min-w-0 pl-2">
        <AuthorLine post={post} />
        {post.body && (
          <p className="mt-2.5 whitespace-pre-wrap break-words text-sm leading-relaxed">
            {post.body}
          </p>
        )}
        <PostImages images={post.images} />
        <PostActions
          post={post}
          onLike={() => onLike(post)}
          onShare={() => onShare(post)}
          onDelete={post.isMine ? () => onDelete(post) : undefined}
          basePath={basePath}
        />
      </div>
    </article>
  )
}

function CommentItem({
  node,
  postId,
  basePath,
  onReplied,
}: {
  node: CommentNode
  postId: string
  basePath: string
  onReplied: () => void
}) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [replying, setReplying] = React.useState(false)
  const [text, setText] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const taRef = React.useRef<HTMLTextAreaElement>(null)

  const submit = async () => {
    if (!user) {
      navigate("/login", { state: { from: `${basePath}/${postId}` } })
      return
    }
    if (!text.trim()) return
    setBusy(true)
    try {
      await communityApi.comment(postId, text.trim(), node.id)
      setText("")
      setReplying(false)
      onReplied()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "评论失败")
    } finally {
      setBusy(false)
    }
  }

  const insertEmoji = (e: string) => {
    const ta = taRef.current
    if (!ta) {
      setText((t) => t + e)
      return
    }
    const start = ta.selectionStart ?? text.length
    const end = ta.selectionEnd ?? text.length
    const next = text.slice(0, start) + e + text.slice(end)
    setText(next)
    requestAnimationFrame(() => {
      ta.focus()
      const pos = start + e.length
      ta.setSelectionRange(pos, pos)
    })
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-card p-3">
      <div className="flex min-w-0 items-center gap-2">
        <UserAvatar
          username={node.author.username}
          nickname={node.author.nickname}
          hasAvatar={node.author.hasAvatar}
          className="h-7 w-7"
        />
        <span className="truncate text-sm font-medium">
          {node.author.nickname ?? node.author.username}
        </span>
        <span className="truncate text-xs text-muted-foreground">@{node.author.username}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground" title={fmtTime(node.createdAt)}>
          {relTime(node.createdAt)}
        </span>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed">{node.body}</p>
      {user && (
        <button
          onClick={() => setReplying((v) => !v)}
          className="mt-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {replying ? "取消回复" : "回复"}
        </button>
      )}
      {replying && (
        <div className="mt-2">
          <Textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            placeholder={`回复 @${node.author.nickname ?? node.author.username}…`}
            className="text-sm"
          />
          <div className="mt-1.5 flex items-center gap-1">
            <EmojiPicker onPick={insertEmoji} />
            <Button
              size="sm"
              className="ml-auto"
              onClick={submit}
              disabled={busy || !text.trim()}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              回复
            </Button>
          </div>
        </div>
      )}
      {node.replies.length > 0 && (
        <div className="mt-3 space-y-2 border-l-2 border-border pl-3">
          {node.replies.map((r) => (
            <div key={r.id} className="overflow-hidden rounded-md bg-muted/40 p-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <UserAvatar
                  username={r.author.username}
                  nickname={r.author.nickname}
                  hasAvatar={r.author.hasAvatar}
                  className="h-6 w-6"
                />
                <span className="truncate text-sm font-medium">
                  {r.author.nickname ?? r.author.username}
                </span>
                {r.replyTo && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    回复 <span className="text-primary">@{r.replyTo}</span>
                  </span>
                )}
                <span className="ml-auto shrink-0 text-xs text-muted-foreground" title={fmtTime(r.createdAt)}>
                  {relTime(r.createdAt)}
                </span>
              </div>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed">{r.body}</p>
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
  basePath,
  onReplied,
}: {
  comments: CommentNode[]
  postId: string
  basePath: string
  onReplied: () => void
}) {
  return (
    <div className="space-y-3">
      {comments.map((c) => (
        <CommentItem key={c.id} node={c} postId={postId} basePath={basePath} onReplied={onReplied} />
      ))}
    </div>
  )
}

function PostDetail({ id, inDashboard }: { id: string; inDashboard: boolean }) {
  const [post, setPost] = React.useState<Post | null>(null)
  const [comments, setComments] = React.useState<CommentNode[]>([])
  const [loading, setLoading] = React.useState(true)
  const { user } = useAuth()
  const basePath = inDashboard ? "/dashboard/community" : "/community"
  const navigate = useNavigate()
  const [text, setText] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const taRef = React.useRef<HTMLTextAreaElement>(null)

  /** 初次加载：拉帖子 + 评论（带 loading） */
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

  /** 静默刷新评论（不触发 loading，不闪烁） */
  const reloadComments = React.useCallback(async () => {
    try {
      const c = await communityApi.getComments(id)
      setComments(c.comments)
      setPost((p) => (p ? { ...p, commentCount: c.comments.reduce((n, r) => n + 1 + r.replies.length, 0) } : p))
    } catch {
      /* 静默 */
    }
  }, [id])

  React.useEffect(() => {
    void load()
  }, [load])

  /** 点赞：乐观更新，失败回滚 */
  const handleLike = async () => {
    if (!user) {
      navigate("/login", { state: { from: `${basePath}/${id}` } })
      return
    }
    if (!post) return
    const before = post
    const optimistic = {
      ...post,
      liked: !post.liked,
      likeCount: post.likeCount + (post.liked ? -1 : 1),
    }
    setPost(optimistic)
    try {
      const r = await communityApi.toggleLike(post.id)
      setPost((p) => (p ? { ...p, liked: r.liked, likeCount: r.likeCount } : p))
    } catch (err) {
      setPost(before)
      toast.error(err instanceof HttpError ? err.message : "操作失败")
    }
  }

  /** 转发：乐观 +1，复制链接 */
  const handleShare = async () => {
    if (!post) return
    setPost((p) => (p ? { ...p, shareCount: p.shareCount + 1 } : p))
    try {
      await navigator.clipboard.writeText(`https://cloud.doulor.cn/community/${post.id}`)
      await communityApi.share(post.id)
      toast.success("链接已复制到剪贴板")
    } catch {
      toast.error("复制失败")
    }
  }

  const handleDelete = async () => {
    if (!confirm("确定删除这条帖子？")) return
    try {
      await communityApi.deletePost(id)
      toast.success("已删除")
      navigate(basePath)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "删除失败")
    }
  }

  const submitComment = async () => {
    if (!user) {
      navigate("/login", { state: { from: `${basePath}/${id}` } })
      return
    }
    if (!text.trim()) return
    setBusy(true)
    try {
      await communityApi.comment(id, text.trim())
      setText("")
      await reloadComments()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "评论失败")
    } finally {
      setBusy(false)
    }
  }

  const insertEmoji = (e: string) => {
    const ta = taRef.current
    if (!ta) {
      setText((t) => t + e)
      return
    }
    const start = ta.selectionStart ?? text.length
    const end = ta.selectionEnd ?? text.length
    setText(text.slice(0, start) + e + text.slice(end))
    requestAnimationFrame(() => {
      ta.focus()
      const pos = start + e.length
      ta.setSelectionRange(pos, pos)
    })
  }

  if (loading) return <LoadingBlock />
  if (!post) return <EmptyState title="帖子不存在" description="可能已被删除。" />

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => navigate(basePath)}
      >
        <ArrowLeft className="h-4 w-4" /> 返回广场
      </Button>

      <article className="overflow-hidden rounded-xl border bg-card">
        <div className="border-b bg-muted/30 px-4 py-3">
          <AuthorLine post={post} size="md" />
        </div>
        <div className="min-w-0 p-4">
          {post.body && (
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{post.body}</p>
          )}
          <PostImages images={post.images} />
        </div>
        <div className="border-t px-4 py-2">
          <PostActions
            post={post}
            onLike={handleLike}
            onShare={handleShare}
            onDelete={post.isMine ? handleDelete : undefined}
            detail
            basePath={basePath}
          />
        </div>
      </article>

      <div>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-medium">
          <MessageCircle className="h-4 w-4" />
          评论
          <Badge variant="secondary" className="h-5 tabular-nums">
            {post.commentCount}
          </Badge>
        </h3>
        {comments.length === 0 ? (
          <div className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
            还没有评论，来说点什么？
          </div>
        ) : (
          <CommentTree comments={comments} postId={id} basePath={basePath} onReplied={reloadComments} />
        )}
      </div>

      {user ? (
        <div className="rounded-lg border bg-card p-3">
          <Textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            placeholder="写下你的评论…"
            className="text-sm"
          />
          <div className="mt-2 flex items-center gap-1">
            <EmojiPicker onPick={insertEmoji} />
            <Button
              size="sm"
              className="ml-auto"
              onClick={submitComment}
              disabled={busy || !text.trim()}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              评论
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          <Link to="/login" state={{ from: `${basePath}/${id}` }} className="text-primary underline">
            登录
          </Link>{" "}
          后可评论。
        </p>
      )}
    </div>
  )
}

/** 发帖入口：点击占位条展开，支持图片与表情 */
function PostComposer({ onPosted, basePath }: { onPosted: () => void; basePath: string }) {
  const { user } = useAuth()
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  /** 待上传图片：{ file, preview } */
  const [images, setImages] = React.useState<{ file: File; preview: string }[]>([])
  const [compressing, setCompressing] = React.useState(false)
  const fileRef = React.useRef<HTMLInputElement>(null)
  const taRef = React.useRef<HTMLTextAreaElement>(null)

  const MAX = 5000
  const MAX_IMAGES = 9

  // 卸载时释放预览 URL，避免内存泄漏
  React.useEffect(() => {
    return () => {
      for (const img of images) URL.revokeObjectURL(img.preview)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!user) {
    return (
      <div className="mb-5 rounded-xl border bg-card p-4 text-sm text-muted-foreground">
        <Link
          to="/login"
          state={{ from: basePath }}
          className="font-medium text-primary underline"
        >
          登录
        </Link>{" "}
        后可发帖、评论、点赞，和朋友们聊聊。
      </div>
    )
  }

  const reset = () => {
    for (const img of images) URL.revokeObjectURL(img.preview)
    setImages([])
    setDraft("")
    setOpen(false)
  }

  const pickFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    const room = MAX_IMAGES - images.length
    if (room <= 0) {
      toast.error(`最多 ${MAX_IMAGES} 张图片`)
      return
    }
    const list = Array.from(files).slice(0, room)
    setCompressing(true)
    try {
      const added: { file: File; preview: string }[] = []
      for (const f of list) {
        if (!f.type.startsWith("image/")) continue
        const compressed = await compressImage(f)
        added.push({ file: compressed, preview: URL.createObjectURL(compressed) })
      }
      setImages((prev) => [...prev, ...added])
    } catch {
      toast.error("图片处理失败，请换一张试试")
    } finally {
      setCompressing(false)
      if (fileRef.current) fileRef.current.value = ""
    }
  }

  const removeImage = (idx: number) => {
    setImages((prev) => {
      const target = prev[idx]
      if (target) URL.revokeObjectURL(target.preview)
      return prev.filter((_, i) => i !== idx)
    })
  }

  const insertEmoji = (e: string) => {
    const ta = taRef.current
    if (!ta) {
      setDraft((t) => t + e)
      return
    }
    const start = ta.selectionStart ?? draft.length
    const end = ta.selectionEnd ?? draft.length
    setDraft(draft.slice(0, start) + e + draft.slice(end))
    requestAnimationFrame(() => {
      ta.focus()
      const pos = start + e.length
      ta.setSelectionRange(pos, pos)
    })
  }

  const submit = async () => {
    if (!draft.trim() && images.length === 0) return
    setBusy(true)
    try {
      // 1) 先建帖拿到 id（图片 key 需要 postId）
      const { post } = await communityApi.createPost(draft.trim())
      // 2) 逐张上传；单张失败不阻塞其余，最后统一提示
      let failed = 0
      for (const img of images) {
        try {
          await communityApi.uploadImage(post.id, img.file)
        } catch {
          failed++
        }
      }
      if (failed > 0) {
        toast.warning(`已发布，但有 ${failed} 张图片上传失败`)
      } else {
        toast.success("发布成功")
      }
      reset()
      onPosted()
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
        <UserAvatar username={user.username} nickname={user.nickname} hasAvatar={user.hasAvatar} />
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
        <UserAvatar username={user.username} nickname={user.nickname} hasAvatar={user.hasAvatar} />
        <span className="text-sm font-medium">{user.nickname ?? user.username}</span>
        <button
          onClick={reset}
          className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="收起"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <Textarea
        ref={taRef}
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

      {/* 图片预览 */}
      {images.length > 0 && (
        <div className="mt-2 grid grid-cols-3 gap-1.5 sm:grid-cols-4">
          {images.map((img, i) => (
            <div key={img.preview} className="group relative aspect-square overflow-hidden rounded-lg border">
              <img src={img.preview} alt="" className="h-full w-full object-cover" />
              <button
                type="button"
                onClick={() => removeImage(i)}
                className="absolute right-1 top-1 rounded-full bg-black/60 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100"
                aria-label="移除"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          {compressing && (
            <div className="flex aspect-square items-center justify-center rounded-lg border border-dashed">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        multiple
        className="hidden"
        onChange={(e) => void pickFiles(e.target.files)}
      />

      <div className="mt-2 flex items-center gap-1 border-t pt-2.5">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={compressing || images.length >= MAX_IMAGES}
          className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          title={`添加图片（最多 ${MAX_IMAGES} 张）`}
        >
          <ImagePlus className="h-4 w-4" />
          图片
          {images.length > 0 && <span className="tabular-nums">{images.length}/{MAX_IMAGES}</span>}
        </button>
        <EmojiPicker onPick={insertEmoji} />
        <span
          className={
            "ml-auto text-xs tabular-nums " +
            (draft.length > MAX ? "text-destructive" : "text-muted-foreground")
          }
        >
          {draft.length} / {MAX}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-1"
          onClick={reset}
        >
          取消
        </Button>
        <Button
          size="sm"
          onClick={submit}
          disabled={busy || compressing || (!draft.trim() && images.length === 0) || draft.length > MAX}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          发布
        </Button>
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
              <li key={u.username} className="flex min-w-0 items-center gap-2">
                <span
                  className={
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold " +
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
                <span className="flex-1 truncate text-sm">{u.nickname ?? u.username}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{u.posts} 帖</span>
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
          Doulor Cloud 社区广场是邀请制的交流区。内容公开可浏览，发帖与互动需登录。
          请友好交流，违规内容将被管理员移除。
        </p>
      </div>
    </aside>
  )
}

export default function CommunityPage({ inDashboard = false }: { inDashboard?: boolean }) {
  const { user } = useAuth()
  const basePath = inDashboard ? "/dashboard/community" : "/community"
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
      setLoading(false)
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

  const navigate = useNavigate()
  const requireLogin = () => {
    if (!user) {
      navigate("/login", { state: { from: basePath } })
      return false
    }
    return true
  }

  /** 点赞：乐观更新，失败回滚（不重拉列表） */
  const handleLike = async (p: Post) => {
    if (!requireLogin()) return
    const optimistic = {
      ...p,
      liked: !p.liked,
      likeCount: p.likeCount + (p.liked ? -1 : 1),
    }
    setPosts((prev) => prev.map((x) => (x.id === p.id ? optimistic : x)))
    try {
      const r = await communityApi.toggleLike(p.id)
      setPosts((prev) =>
        prev.map((x) => (x.id === p.id ? { ...x, liked: r.liked, likeCount: r.likeCount } : x))
      )
    } catch (err) {
      setPosts((prev) => prev.map((x) => (x.id === p.id ? p : x)))
      toast.error(err instanceof HttpError ? err.message : "操作失败")
    }
  }

  /** 转发：乐观 +1 + 复制链接（不重拉列表） */
  const handleShare = async (p: Post) => {
    if (!requireLogin()) return
    setPosts((prev) => prev.map((x) => (x.id === p.id ? { ...x, shareCount: x.shareCount + 1 } : x)))
    try {
      await navigator.clipboard.writeText(`https://cloud.doulor.cn/community/${p.id}`)
      await communityApi.share(p.id)
      toast.success("链接已复制到剪贴板")
    } catch {
      setPosts((prev) => prev.map((x) => (x.id === p.id ? p : x)))
      toast.error("复制失败")
    }
  }

  const handleDelete = async (p: Post) => {
    if (!confirm("确定删除这条帖子？")) return
    const before = posts
    setPosts((prev) => prev.filter((x) => x.id !== p.id))
    try {
      await communityApi.deletePost(p.id)
      toast.success("已删除")
      void loadStats()
    } catch (err) {
      setPosts(before)
      toast.error(err instanceof HttpError ? err.message : "删除失败")
    }
  }

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
              <Badge variant="destructive" className="ml-2 h-5 tabular-nums">
                {unread} 条新互动
              </Badge>
            )}
          </p>
        </div>
      )}

      <div className="flex gap-6">
        <div className="min-w-0 flex-1">
          <PostComposer
            basePath={basePath}
            onPosted={() => {
              void load()
              void loadStats()
            }}
          />

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
                <PostCard
                  key={p.id}
                  post={p}
                  onLike={handleLike}
                  onShare={handleShare}
                  onDelete={handleDelete}
                  basePath={basePath}
                />
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

        <SidePanel stats={stats} />
      </div>
    </div>
  )
}
