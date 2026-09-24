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
  Image as ImageIcon,
  ImageOff,
  WifiOff,
  RotateCw,
  AlertCircle,
  FileQuestion,
  MessagesSquare,
} from "lucide-react"
import { toast } from "sonner"

import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { LoadingBlock } from "@/components/loading-block"
import { UserAvatar } from "@/components/user-avatar"
import { Markdown } from "@/components/markdown"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { useAuth } from "@/hooks/use-auth"
import { useEmojiInsert } from "@/hooks/use-emoji-insert"
import { communityApi, notificationApi, HttpError, errMsg } from "@/services/api"
import { compressImage } from "@/lib/image-compress"
import { fmtTime, relTime } from "@/lib/format"
import { EMOJI_GROUPS } from "@/lib/emojis"
import type { Post, CommentNode, CommunityStats, Notification } from "@/types"

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
        aria-label="插入表情"
        aria-expanded={open}
      >
        <Smile className="h-4 w-4" aria-hidden="true" />
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

/** 单张图片：加载前显示占位骨架（扫光），加载完成后淡入，失败显示提示 */
function LazyImage({
  src,
  alt = "",
  className,
  imgClassName,
}: {
  src: string
  alt?: string
  className?: string
  imgClassName?: string
}) {
  const [state, setState] = React.useState<"loading" | "loaded" | "error">("loading")
  const imgRef = React.useRef<HTMLImageElement>(null)

  // 命中浏览器缓存时 onLoad 可能在 React 挂载前就触发，这里补一次检查
  React.useEffect(() => {
    const img = imgRef.current
    if (!img) return
    if (img.complete) setState(img.naturalWidth > 0 ? "loaded" : "error")
  }, [])

  return (
    <div className={"relative overflow-hidden bg-muted/40 " + (className ?? "")}>
      {state === "loading" && (
        <div className="shimmer absolute inset-0" aria-hidden="true">
          <ImageIcon className="absolute left-1/2 top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 text-muted-foreground/40" />
        </div>
      )}
      {state === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-muted-foreground/70">
          <ImageOff className="h-6 w-6" aria-hidden="true" />
          <span className="text-xs">图片加载失败</span>
        </div>
      )}
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={() => setState("loaded")}
        onError={() => setState("error")}
        className={
          "transition-opacity duration-300 " +
          (state === "loaded" ? "opacity-100" : "opacity-0") +
          (imgClassName ? " " + imgClassName : "")
        }
      />
    </div>
  )
}

/** 帖子图片九宫格：1 张大图，2-4 张两列，5+ 张三列 */
function PostImages({ images }: { images: string[] }) {
  const [preview, setPreview] = React.useState<number | null>(null)
  const closeRef = React.useRef<HTMLButtonElement>(null)

  // ESC 关闭预览
  React.useEffect(() => {
    if (preview === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPreview(null)
    }
    document.addEventListener("keydown", onKey)
    closeRef.current?.focus()
    return () => document.removeEventListener("keydown", onKey)
  }, [preview])

  if (images.length === 0) return null

  const cols =
    images.length === 1 ? "grid-cols-1" : images.length <= 4 ? "grid-cols-2" : "grid-cols-3"

  const current = preview === null ? null : images[preview]

  return (
    <>
      <div className={"mt-3 grid gap-1.5 " + cols}>
        {images.map((src, i) => (
          <button
            key={src}
            type="button"
            onClick={() => setPreview(i)}
            aria-label={`查看第 ${i + 1} 张图片（共 ${images.length} 张）`}
            className={
              "group overflow-hidden rounded-lg border " +
              (images.length === 1 ? "" : "aspect-square")
            }
          >
            <LazyImage
              src={src}
              alt={`帖子图片 ${i + 1}`}
              className={images.length === 1 ? "max-h-96 min-h-[120px]" : "h-full w-full"}
              imgClassName={
                "h-full w-full object-cover transition-transform group-hover:scale-[1.02] " +
                (images.length === 1 ? "max-h-96 object-contain" : "")
              }
            />
          </button>
        ))}
      </div>
      {current && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="图片预览"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setPreview(null)}
        >
          <img
            src={current}
            alt={`帖子的第 ${(preview ?? 0) + 1} 张图片`}
            className="max-h-full max-w-full rounded-lg object-contain"
          />
          <button
            ref={closeRef}
            type="button"
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
            onClick={() => setPreview(null)}
            aria-label="关闭图片预览"
          >
            <X className="h-5 w-5" aria-hidden="true" />
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
        aria-label={post.liked ? "取消点赞" : "点赞"}
        aria-pressed={post.liked}
      >
        <Heart
          className={"h-4 w-4 transition-transform " + (post.liked ? "scale-110 fill-current" : "")}
          aria-hidden="true"
        />
        <span className="tabular-nums">{post.likeCount}</span>
      </button>
      {!detail && (
        <Link
          to={`${basePath}/${post.id}`}
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1 transition-colors hover:bg-accent hover:text-foreground"
          aria-label="查看评论"
        >
          <MessageCircle className="h-4 w-4" aria-hidden="true" />
          <span className="tabular-nums">{post.commentCount}</span>
        </Link>
      )}
      <button
        onClick={onShare}
        className="flex items-center gap-1.5 rounded-md px-2.5 py-1 transition-colors hover:bg-accent hover:text-foreground"
        aria-label="分享并复制链接"
      >
        <Share2 className="h-4 w-4" aria-hidden="true" />
        <span className="tabular-nums">{post.shareCount}</span>
      </button>
      {onDelete && (
        <button
          onClick={onDelete}
          className="ml-auto flex items-center gap-1.5 rounded-md px-2.5 py-1 transition-colors hover:bg-accent hover:text-destructive"
          aria-label="删除帖子"
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
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
          <div className="mt-2.5">
            <Markdown>{post.body}</Markdown>
          </div>
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
      toast.error(errMsg(err, "评论失败"))
    } finally {
      setBusy(false)
    }
  }

  const insertEmoji = useEmojiInsert(taRef, text, setText)

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
      <div className="mt-1.5">
        <Markdown>{node.body}</Markdown>
      </div>
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
              <div className="mt-1 text-sm">
                <Markdown>{r.body}</Markdown>
              </div>
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
  const [failed, setFailed] = React.useState(false)
  const [notFound, setNotFound] = React.useState(false)
  const { user } = useAuth()
  const basePath = inDashboard ? "/dashboard/community" : "/community"
  const navigate = useNavigate()
  const [text, setText] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const taRef = React.useRef<HTMLTextAreaElement>(null)

  // 编辑
  const [editing, setEditing] = React.useState(false)
  const [editText, setEditText] = React.useState("")
  const [editBusy, setEditBusy] = React.useState(false)
  // 编辑历史（时间列表）
  const [edits, setEdits] = React.useState<{ editedAt: string }[]>([])
  const [editsOpen, setEditsOpen] = React.useState(false)

  /** 初次加载：拉帖子 + 评论（带 loading） */
  const load = React.useCallback(async () => {
    setLoading(true)
    setFailed(false)
    try {
      const [p, c] = await Promise.all([communityApi.getPost(id), communityApi.getComments(id)])
      setPost(p.post)
      setComments(c.comments)
    } catch (err) {
      // 404 说明帖子确实被删了；其它错误是网络/服务问题，需要让用户重试
      if (err instanceof HttpError && err.status === 404) setNotFound(true)
      else setFailed(true)
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
    } catch (err) {
      // 评论刷新失败要提示：用户刚发的评论可能没显示出来
      toast.error(errMsg(err, "评论加载失败，请刷新重试"))
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
      toast.error(errMsg(err, "操作失败"))
    }
  }

  /** 转发：乐观 +1，复制链接 */
  const handleShare = async () => {
    if (!post) return
    setPost((p) => (p ? { ...p, shareCount: p.shareCount + 1 } : p))
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/community/${post.id}`)
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
      toast.error(errMsg(err, "删除失败"))
    }
  }

  /** 进入编辑态 */
  const startEdit = () => {
    if (!post) return
    setEditText(post.body)
    setEditing(true)
  }

  /** 提交编辑 */
  const submitEdit = async () => {
    if (!post) return
    if (!editText.trim()) {
      toast.error("内容不能为空")
      return
    }
    if (editText.trim() === post.body) {
      setEditing(false)
      return
    }
    setEditBusy(true)
    try {
      await communityApi.updatePost(post.id, editText.trim())
      // 更新本地 post
      setPost((p) =>
        p
          ? { ...p, body: editText.trim(), updatedAt: new Date().toISOString(), editCount: p.editCount + 1 }
          : p
      )
      setEditing(false)
      toast.success("已更新")
    } catch (err) {
      toast.error(errMsg(err, "编辑失败"))
    } finally {
      setEditBusy(false)
    }
  }

  /** 打开编辑历史 */
  const openEdits = async () => {
    if (!post) return
    setEditsOpen(true)
    try {
      const r = await communityApi.listEdits(post.id)
      setEdits(r.edits)
    } catch (err) {
      setEdits([])
      toast.error(errMsg(err, "加载编辑历史失败"))
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
      toast.error(errMsg(err, "评论失败"))
    } finally {
      setBusy(false)
    }
  }

  const insertEmoji = useEmojiInsert(taRef, text, setText)

  if (loading) return <LoadingBlock />

  if (failed && !post) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <EmptyState
          icon={WifiOff}
          title="帖子加载失败"
          description="网络或服务异常，请稍后重试。"
          action={
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RotateCw className="h-4 w-4" /> 重试
            </Button>
          }
        />
      </div>
    )
  }

  if (!post) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <EmptyState
          icon={notFound ? FileQuestion : AlertCircle}
          title={notFound ? "帖子不存在" : "无法显示这篇帖子"}
          description={notFound ? "可能已被作者删除。" : "请返回广场重新打开。"}
          action={
            <Button variant="outline" size="sm" onClick={() => navigate(basePath)}>
              <ArrowLeft className="h-4 w-4" /> 返回广场
            </Button>
          }
        />
      </div>
    )
  }

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
          {editing ? (
            <div className="space-y-2">
              <Textarea
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                rows={5}
                className="text-sm"
                placeholder="编辑帖子内容（支持 Markdown）…"
              />
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => void submitEdit()} disabled={editBusy}>
                  {editBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  保存
                </Button>
                <Button size="sm" variant="outline" onClick={() => setEditing(false)} disabled={editBusy}>
                  取消
                </Button>
              </div>
            </div>
          ) : (
            <>
              {post.body && (
                <div className="text-sm">
                  <Markdown>{post.body}</Markdown>
                </div>
              )}
              <PostImages images={post.images} />
            </>
          )}
        </div>
        <div className="flex items-center gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
          <span>
            {post.updatedAt ? `编辑于 ${fmtTime(post.updatedAt)}` : `发布于 ${fmtTime(post.createdAt)}`}
          </span>
          {post.editCount > 0 && (
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => void openEdits()}
            >
              查看编辑历史（{post.editCount}）
            </button>
          )}
          {post.isMine && !editing && (
            <button
              type="button"
              className="ml-auto text-primary hover:underline"
              onClick={startEdit}
            >
              编辑
            </button>
          )}
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

      {/* 编辑历史弹窗 */}
      <Dialog open={editsOpen} onOpenChange={setEditsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑历史</DialogTitle>
            <DialogDescription>
              共编辑 {post.editCount} 次，按时间倒序。
            </DialogDescription>
          </DialogHeader>
          {edits.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">暂无编辑记录。</p>
          ) : (
            <div className="max-h-72 space-y-2 overflow-y-auto">
              {edits.map((e, i) => (
                <div key={i} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                  <span className="text-muted-foreground">第 {edits.length - i} 次编辑</span>
                  <span className="font-mono text-xs">{fmtTime(e.editedAt)}</span>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
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

  const insertEmoji = useEmojiInsert(taRef, draft, setDraft)

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
      toast.error(errMsg(err, "发布失败"))
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
      {/* 聊天室入口 */}
      <Link
        to="/dashboard/chat"
        className="flex items-center gap-3 rounded-xl border bg-gradient-to-br from-primary/10 to-primary/5 p-4 transition-colors hover:bg-primary/10"
      >
        <MessagesSquare className="h-5 w-5 text-primary" />
        <div>
          <p className="text-sm font-medium">进入公共聊天室</p>
          <p className="text-xs text-muted-foreground">像群聊一样实时交流</p>
        </div>
      </Link>

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
  const [failed, setFailed] = React.useState(false)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [stats, setStats] = React.useState<CommunityStats | null>(null)
  const [unread, setUnread] = React.useState(0)
  // 通知列表（点击「N 条新互动」打开）
  const [notifOpen, setNotifOpen] = React.useState(false)
  const [notifs, setNotifs] = React.useState<Notification[]>([])
  const [notifLoading, setNotifLoading] = React.useState(false)

  /** 帖子列表加载：区分「加载失败」与「确实是空的」，避免把错误伪装成"没人发帖" */
  const load = React.useCallback(async (c?: string) => {
    if (c) setLoadingMore(true)
    else {
      setLoading(true)
      setFailed(false)
    }
    try {
      const res = await communityApi.listPosts(c)
      setPosts((prev) => (c ? [...prev, ...res.posts] : res.posts))
      setCursor(res.nextCursor ?? undefined)
    } catch (err) {
      if (c) {
        // 加载下一页失败：保留已有列表，只提示
        toast.error(errMsg(err, "加载更多失败，请稍后重试"))
      } else {
        setFailed(true)
      }
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [])

  /** 侧栏统计：失败不影响主流程，静默即可 */
  const loadStats = React.useCallback(async () => {
    try {
      setStats(await communityApi.getStats())
    } catch {
      /* 静默：统计失败不影响帖子浏览 */
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

  /** 打开通知列表：拉取并展示互动记录 */
  const openNotifications = async () => {
    if (!user) {
      navigate("/login", { state: { from: basePath } })
      return
    }
    setNotifOpen(true)
    setNotifLoading(true)
    try {
      const res = await notificationApi.list()
      setNotifs(res.notifications)
    } catch (err) {
      toast.error(errMsg(err, "加载通知失败"))
    } finally {
      setNotifLoading(false)
    }
  }

  /** 点击某条通知：跳转到对应帖子详情，并标记已读 */
  const openNotification = async (n: Notification) => {
    if (!n.postId || n.postDeleted) return
    setNotifOpen(false)
    await notificationApi.markRead([n.id])
    setUnread((u) => Math.max(0, u - 1))
    navigate(`${basePath}/${n.postId}`)
  }

  /** 全部标记已读 */
  const markAllRead = async () => {
    await notificationApi.markRead(undefined, true)
    setUnread(0)
    setNotifs((prev) => prev.map((n) => ({ ...n, read: true })))
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
      toast.error(errMsg(err, "操作失败"))
    }
  }

  /** 转发：乐观 +1 + 复制链接（不重拉列表） */
  const handleShare = async (p: Post) => {
    if (!requireLogin()) return
    setPosts((prev) => prev.map((x) => (x.id === p.id ? { ...x, shareCount: x.shareCount + 1 } : x)))
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/community/${p.id}`)
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
      toast.error(errMsg(err, "删除失败"))
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
              <button
                type="button"
                onClick={() => void openNotifications()}
                className="ml-2 inline-flex items-center"
                title="查看互动通知"
              >
                <Badge variant="destructive" className="h-5 cursor-pointer tabular-nums hover:opacity-90">
                  {unread} 条新互动
                </Badge>
              </button>
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
          ) : failed ? (
            <EmptyState
              icon={WifiOff}
              title="帖子加载失败"
              description="网络或服务异常，请稍后重试。"
              action={
                <Button variant="outline" size="sm" onClick={() => void load()}>
                  <RotateCw className="h-4 w-4" /> 重试
                </Button>
              }
            />
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

      {/* 互动通知列表 */}
      <Dialog open={notifOpen} onOpenChange={setNotifOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>互动通知</DialogTitle>
            <DialogDescription>
              别人对你的帖子/评论的回应。
            </DialogDescription>
          </DialogHeader>
          <div className="mb-2 flex justify-end">
            <Button variant="ghost" size="sm" onClick={() => void markAllRead()}>
              全部标记已读
            </Button>
          </div>
          {notifLoading ? (
            <LoadingBlock />
          ) : notifs.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">还没有互动。</p>
          ) : (
            <div className="max-h-80 space-y-2 overflow-y-auto">
              {notifs.map((n) => {
                const name = n.actorNickname || n.actorUsername || "有人"
                const verb = n.type === "comment_reply" ? "回复了你的评论" : "评论了你的帖子"
                return (
                  <button
                    key={n.id}
                    type="button"
                    disabled={n.postDeleted}
                    onClick={() => void openNotification(n)}
                    className={
                      "w-full rounded-md border p-3 text-left transition-colors " +
                      (n.postDeleted
                        ? "cursor-not-allowed opacity-50"
                        : "hover:bg-accent/50")
                    }
                  >
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium">{name}</span>
                      <span className="text-muted-foreground">{verb}</span>
                      {!n.read && (
                        <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-primary" />
                      )}
                    </div>
                    {n.postPreview && (
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {n.postPreview}
                      </p>
                    )}
                    {n.postDeleted && (
                      <p className="mt-1 text-xs text-muted-foreground">原帖已删除</p>
                    )}
                    <p className="mt-1 text-[11px] text-muted-foreground/70">
                      {relTime(n.createdAt)}
                    </p>
                  </button>
                )
              })}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
