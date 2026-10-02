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
import { DataFade } from "@/components/data-fade"
import { EmptyState } from "@/components/empty-state"
import { LoadingBlock } from "@/components/loading-block"
import { UserAvatar } from "@/components/user-avatar"
import { UserCardPopover } from "@/components/user-card"
import { RoleBadge } from "@/components/role-badge"
import { CustomTitleBadge } from "@/components/custom-title-badge"
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
import { useT } from "@/i18n"

/** 表情选择面板：点击把 emoji 插到光标处 */
function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const { t } = useT()
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
        title={t("cm.emoji")}
        aria-label={t("cm.emojiInsert")}
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
                {t(g.name)}
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
  const { t } = useT()
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
          <span className="text-xs">{t("cm.imgFailed")}</span>
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
  const { t } = useT()
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
            aria-label={t("cm.viewImageOf", { n: i + 1, total: images.length })}
            className={
              "group overflow-hidden rounded-lg border " +
              (images.length === 1 ? "" : "aspect-square")
            }
          >
            <LazyImage
              src={src}
              alt={t("cm.postImageAlt", { n: i + 1 })}
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
          aria-label={t("feedback.preview")}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setPreview(null)}
        >
          <img
            src={current}
            alt={t("cm.postImageNth", { n: (preview ?? 0) + 1 })}
            className="max-h-full max-w-full rounded-lg object-contain"
          />
          <button
            ref={closeRef}
            type="button"
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
            onClick={() => setPreview(null)}
            aria-label={t("feedback.closePreview")}
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
      {/* 点头像/名字弹出小卡片，可跳转到对方的个人空间 */}
      <UserCardPopover
        username={post.author.username}
        nickname={post.author.nickname}
        hasAvatar={post.author.hasAvatar}
        className="flex min-w-0 items-center gap-2.5 text-left"
      >
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
              <RoleBadge role={post.author.isRoot ? "root" : "admin"} />
            )}
            {post.author.customTitle && (
              <CustomTitleBadge title={post.author.customTitle} />
            )}
            <span className="truncate text-xs text-muted-foreground">@{post.author.username}</span>
          </div>
        </div>
      </UserCardPopover>
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
  const { t } = useT()
  return (
    <div
      className={
        "mt-3 flex items-center gap-1 text-sm text-muted-foreground " +
        (detail ? "" : "border-t pt-2.5")
      }
    >
      <button
        onClick={(e) => {
          e.stopPropagation()
          onLike()
        }}
        className={
          "flex items-center gap-1.5 rounded-md px-2.5 py-1 transition-colors hover:bg-accent " +
          (post.liked ? "text-red-500" : "hover:text-red-500")
        }
        aria-label={post.liked ? t("cm.unlike") : t("cm.like")}
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
          onClick={(e) => e.stopPropagation()}
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1 transition-colors hover:bg-accent hover:text-foreground"
          aria-label={t("cm.viewComments")}
        >
          <MessageCircle className="h-4 w-4" aria-hidden="true" />
          <span className="tabular-nums">{post.commentCount}</span>
        </Link>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation()
          onShare()
        }}
        className="flex items-center gap-1.5 rounded-md px-2.5 py-1 transition-colors hover:bg-accent hover:text-foreground"
        aria-label={t("cm.shareLink")}
      >
        <Share2 className="h-4 w-4" aria-hidden="true" />
        <span className="tabular-nums">{post.shareCount}</span>
      </button>
      {onDelete && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          className="ml-auto flex items-center gap-1.5 rounded-md px-2.5 py-1 transition-colors hover:bg-accent hover:text-destructive"
          aria-label={t("cm.deletePost")}
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
  const navigate = useNavigate()
  return (
    <article
      onClick={() => navigate(`${basePath}/${post.id}`)}
      className="group relative cursor-pointer overflow-hidden rounded-xl border bg-card p-4 transition-all hover:border-border/80 hover:shadow-sm"
    >
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
  depth = 0,
}: {
  node: CommentNode
  postId: string
  basePath: string
  onReplied: () => void
  depth?: number
}) {
  const { t } = useT()
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
      toast.error(errMsg(err, t("cm.err.comment")))
    } finally {
      setBusy(false)
    }
  }

  const insertEmoji = useEmojiInsert(taRef, text, setText)

  // 深层嵌套时停止左侧缩进，避免在手机上越缩越窄成一条缝
  const indent = depth < 6

  return (
    <div className="overflow-hidden rounded-lg border bg-card p-3">
      <div className="flex min-w-0 items-center gap-2">
        <UserCardPopover
          username={node.author.username}
          nickname={node.author.nickname}
          hasAvatar={node.author.hasAvatar}
          className="flex min-w-0 items-center gap-2 text-left"
        >
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
        </UserCardPopover>
        {node.author.isAdmin && <RoleBadge role={node.author.isRoot ? "root" : "admin"} />}
        {node.author.customTitle && <CustomTitleBadge title={node.author.customTitle} />}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground" title={fmtTime(node.createdAt)}>
          {relTime(node.createdAt)}
        </span>
      </div>
      <div className="mt-1.5">
        {node.replyTo && (
          <span className="mb-0.5 block text-xs text-muted-foreground">
            {t("cm.replyTo")} <span className="text-primary">@{node.replyTo}</span>
          </span>
        )}
        <Markdown>{node.body}</Markdown>
      </div>
      {user && (
        <button
          onClick={() => setReplying((v) => !v)}
          className="mt-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {replying ? t("cm.cancelReply") : t("cm.reply")}
        </button>
      )}
      {replying && (
        <div className="mt-2">
          <Textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            placeholder={t("cm.replyPh", { name: node.author.nickname ?? node.author.username })}
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
              {t("cm.reply")}
            </Button>
          </div>
        </div>
      )}
      {node.replies.length > 0 && (
        <div className={"mt-3 space-y-2 " + (indent ? "border-l-2 border-border pl-3" : "")}>
          {node.replies.map((r) => (
            <CommentItem
              key={r.id}
              node={r}
              postId={postId}
              basePath={basePath}
              onReplied={onReplied}
              depth={depth + 1}
            />
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

/** 帖子详情加载骨架：与最终布局一致，避免跳转时整屏空白 + 转圈 */
function PostDetailSkeleton() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <div className="h-8 w-24 animate-pulse rounded-md bg-muted/60" />
      <article className="overflow-hidden rounded-xl border bg-card">
        <div className="border-b bg-muted/30 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <div className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-muted" />
            <div className="space-y-1.5">
              <div className="h-3.5 w-28 animate-pulse rounded bg-muted" />
              <div className="h-3 w-16 animate-pulse rounded bg-muted/70" />
            </div>
          </div>
        </div>
        <div className="min-w-0 space-y-2.5 p-4">
          <div className="h-3.5 w-full animate-pulse rounded bg-muted" />
          <div className="h-3.5 w-5/6 animate-pulse rounded bg-muted" />
          <div className="h-3.5 w-2/3 animate-pulse rounded bg-muted/70" />
        </div>
        <div className="border-t px-4 py-2">
          <div className="h-6 w-40 animate-pulse rounded bg-muted/60" />
        </div>
      </article>
      <div>
        <div className="mb-3 h-4 w-16 animate-pulse rounded bg-muted" />
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <div key={i} className="rounded-lg border bg-card p-3">
              <div className="flex items-center gap-2">
                <div className="h-7 w-7 shrink-0 animate-pulse rounded-full bg-muted" />
                <div className="h-3 w-24 animate-pulse rounded bg-muted" />
              </div>
              <div className="mt-2.5 space-y-1.5">
                <div className="h-3 w-full animate-pulse rounded bg-muted/70" />
                <div className="h-3 w-1/2 animate-pulse rounded bg-muted/50" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function PostDetail({ id, inDashboard }: { id: string; inDashboard: boolean }) {
  const { t } = useT()
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
      toast.error(errMsg(err, t("cm.err.loadComments")))
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
      toast.error(errMsg(err, t("em.err.op")))
    }
  }

  /** 转发：乐观 +1，复制链接 */
  const handleShare = async () => {
    if (!post) return
    setPost((p) => (p ? { ...p, shareCount: p.shareCount + 1 } : p))
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/community/${post.id}`)
      await communityApi.share(post.id)
      toast.success(t("cm.ok.linkCopied"))
    } catch {
      toast.error(t("cm.err.copy"))
    }
  }

  const handleDelete = async () => {
    if (!confirm(t("cm.confirmDelete"))) return
    try {
      await communityApi.deletePost(id)
      toast.success(t("at.ok.deleted"))
      navigate(basePath)
    } catch (err) {
      toast.error(errMsg(err, t("em.err.delete")))
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
      toast.error(t("cm.err.empty"))
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
      toast.success(t("cm.ok.updated"))
    } catch (err) {
      toast.error(errMsg(err, t("cm.err.edit")))
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
      toast.error(errMsg(err, t("cm.err.loadEdits")))
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
      toast.error(errMsg(err, t("cm.err.comment")))
    } finally {
      setBusy(false)
    }
  }

  const insertEmoji = useEmojiInsert(taRef, text, setText)

  if (loading) return <PostDetailSkeleton />

  if (failed && !post) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <EmptyState
          icon={WifiOff}
          title={t("cm.postFailed")}
          description={t("cm.loadFailedDesc")}
          action={
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RotateCw className="h-4 w-4" /> {t("common.retry")}
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
          title={notFound ? t("cm.notFound") : t("cm.cannotShow")}
          description={notFound ? t("cm.notFoundDesc") : t("cm.cannotShowDesc")}
          action={
            <Button variant="outline" size="sm" onClick={() => navigate(basePath)}>
              <ArrowLeft className="h-4 w-4" /> {t("cm.backToSquare")}
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 animate-in fade-in-0 duration-300">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => navigate(basePath)}
      >
        <ArrowLeft className="h-4 w-4" /> {t("cm.backToSquare")}
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
                placeholder={t("cm.editPh")}
              />
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => void submitEdit()} disabled={editBusy}>
                  {editBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  {t("common.save")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setEditing(false)} disabled={editBusy}>
                  {t("common.cancel")}
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
            {post.updatedAt ? t("cm.editedAt", { time: fmtTime(post.updatedAt) }) : t("cm.postedAt", { time: fmtTime(post.createdAt) })}
          </span>
          {post.editCount > 0 && (
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => void openEdits()}
            >
              {t("cm.viewEdits", { n: post.editCount })}
            </button>
          )}
          {post.isMine && !editing && (
            <button
              type="button"
              className="ml-auto text-primary hover:underline"
              onClick={startEdit}
            >
              {t("common.edit")}
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
          {t("cm.comment")}
          <Badge variant="secondary" className="h-5 tabular-nums">
            {post.commentCount}
          </Badge>
        </h3>
        {comments.length === 0 ? (
          <div className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
            {t("cm.noComments")}
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
            placeholder={t("cm.commentPh")}
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
              {t("cm.comments")}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          <Link to="/login" state={{ from: `${basePath}/${id}` }} className="text-primary underline">
            {t("nav.login")}
          </Link>{" "}
          {t("cm.afterLoginComment")}
        </p>
      )}

      {/* 编辑历史弹窗 */}
      <Dialog open={editsOpen} onOpenChange={setEditsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("cm.editHistory")}</DialogTitle>
            <DialogDescription>
              {t("cm.editHistoryDesc", { n: post.editCount })}
            </DialogDescription>
          </DialogHeader>
          {edits.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">{t("cm.noEdits")}</p>
          ) : (
            <div className="max-h-72 space-y-2 overflow-y-auto">
              {edits.map((e, i) => (
                <div key={i} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                  <span className="text-muted-foreground">{t("cm.editNth", { n: edits.length - i })}</span>
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
  const { t } = useT()
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
          {t("nav.login")}
        </Link>{" "}
        {t("cm.afterLoginPost")}
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
      toast.error(t("feedback.maxImages", { n: MAX_IMAGES }))
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
      toast.error(t("feedback.processFailed"))
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
        toast.warning(t("cm.postedWithFailures", { n: failed }))
      } else {
        toast.success(t("cm.posted"))
      }
      reset()
      onPosted()
    } catch (err) {
      toast.error(errMsg(err, t("cm.err.post")))
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
          {t("cm.sharePrompt", { name: user.nickname ?? user.username })}
        </span>
        <span className="flex items-center gap-1.5 rounded-md bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary">
          <PenSquare className="h-3.5 w-3.5" />
          {t("cm.post")}
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
          aria-label={t("lg.collapse")}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <Textarea
        ref={taRef}
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={t("cm.postPh")}
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
                aria-label={t("common.delete")}
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
          title={t("feedback.addImageTitle", { n: MAX_IMAGES })}
        >
          <ImagePlus className="h-4 w-4" />
          {t("cm.images")}
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
          {t("common.cancel")}
        </Button>
        <Button
          size="sm"
          onClick={submit}
          disabled={busy || compressing || (!draft.trim() && images.length === 0) || draft.length > MAX}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {t("cm.publish")}
        </Button>
      </div>
    </div>
  )
}

/** 右侧动态栏：今日新帖、活跃用户、总数 */
function SidePanel({ stats }: { stats: CommunityStats | null }) {
  const { t } = useT()
  return (
    <aside className="hidden w-72 shrink-0 space-y-4 lg:block">
      {/* 聊天室入口 */}
      <Link
        to="/dashboard/chat"
        className="flex items-center gap-3 rounded-xl border bg-gradient-to-br from-primary/10 to-primary/5 p-4 transition-colors hover:bg-primary/10"
      >
        <MessagesSquare className="h-5 w-5 text-primary" />
        <div>
          <p className="text-sm font-medium">{t("cm.chatEntry")}</p>
          <p className="text-xs text-muted-foreground">{t("cm.chatEntryDesc")}</p>
        </div>
      </Link>

      <div className="rounded-xl border bg-card p-4">
        <h3 className="mb-3 flex items-center gap-1.5 text-sm font-medium">
          <TrendingUp className="h-4 w-4 text-primary" />
          {t("cm.stats.title")}
        </h3>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg bg-muted/40 p-2.5 text-center">
            <p className="text-xl font-semibold tabular-nums">{stats?.todayCount ?? "—"}</p>
            <p className="text-xs text-muted-foreground">{t("cm.stats.today")}</p>
          </div>
          <div className="rounded-lg bg-muted/40 p-2.5 text-center">
            <p className="text-xl font-semibold tabular-nums">{stats?.totalCount ?? "—"}</p>
            <p className="text-xs text-muted-foreground">{t("cm.stats.total")}</p>
          </div>
        </div>
      </div>

      <div className="rounded-xl border bg-card p-4">
        <h3 className="mb-3 flex items-center gap-1.5 text-sm font-medium">
          <Flame className="h-4 w-4 text-orange-500" />
          {t("cm.active.title")}
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
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{t("cm.active.posts", { n: u.posts })}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">{t("cm.active.empty")}</p>
        )}
      </div>

      <div className="rounded-xl border bg-gradient-to-br from-primary/5 to-transparent p-4">
        <h3 className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
          <Users className="h-4 w-4 text-primary" />
          {t("cm.about.title")}
        </h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("cm.about.desc")}
        </p>
      </div>
    </aside>
  )
}

export default function CommunityPage({ inDashboard = false }: { inDashboard?: boolean }) {
  const { t } = useT()
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
        toast.error(errMsg(err, t("cm.err.loadMore")))
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
      // 只取社交分类的未读数：消息箱上线后 notifications 里还有系统/公告/活动消息，
      // 直接用总数会让社区角标虚高
      void notificationApi
        .unreadCount()
        .then((r) => setUnread(r.byCategory.social))
        .catch(() => {})
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
      // 只拉社交分类：社区页的通知弹窗不该混入系统/公告/活动消息
      const res = await notificationApi.list({ category: "social" })
      setNotifs(res.notifications)
    } catch (err) {
      toast.error(errMsg(err, t("cm.err.loadNotifs")))
    } finally {
      setNotifLoading(false)
    }
  }

  /** 点击某条通知：跳转到对应帖子详情，并标记已读 */
  const openNotification = async (n: Notification) => {
    // 反馈回复通知没有 postId（关联的是反馈单，不是帖子），单独跳反馈页。
    // 放在最前面判断：否则会被下面「没有 postId 就 return」直接吞掉，
    // 表现为「有通知、点了没反应」。
    if (n.type === "feedback_reply") {
      setNotifOpen(false)
      await notificationApi.markRead([n.id])
      setUnread((u) => Math.max(0, u - 1))
      navigate("/dashboard/feedback")
      return
    }
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
      toast.error(errMsg(err, t("em.err.op")))
    }
  }

  /** 转发：乐观 +1 + 复制链接（不重拉列表） */
  const handleShare = async (p: Post) => {
    if (!requireLogin()) return
    setPosts((prev) => prev.map((x) => (x.id === p.id ? { ...x, shareCount: x.shareCount + 1 } : x)))
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/community/${p.id}`)
      await communityApi.share(p.id)
      toast.success(t("cm.ok.linkCopied"))
    } catch {
      setPosts((prev) => prev.map((x) => (x.id === p.id ? p : x)))
      toast.error(t("cm.err.copy"))
    }
  }

  const handleDelete = async (p: Post) => {
    if (!confirm(t("cm.confirmDelete"))) return
    const before = posts
    setPosts((prev) => prev.filter((x) => x.id !== p.id))
    try {
      await communityApi.deletePost(p.id)
      toast.success(t("at.ok.deleted"))
      void loadStats()
    } catch (err) {
      setPosts(before)
      toast.error(errMsg(err, t("em.err.delete")))
    }
  }

  if (id) return <PostDetail id={id} inDashboard={inDashboard} />

  return (
    <div>
      {!inDashboard && (
        <PageHeader title={t("cm.title")} description={t("cm.subtitle")} />
      )}

      {inDashboard && (
        <div className="mb-5">
          <h1 className="text-xl font-semibold tracking-tight">{t("cm.title")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("cm.tagline")}
            {unread > 0 && (
              <button
                type="button"
                onClick={() => void openNotifications()}
                className="ml-2 inline-flex items-center"
                title={t("cm.notif.title")}
              >
                <Badge variant="destructive" className="h-5 cursor-pointer tabular-nums hover:opacity-90">
                  {t("cm.notif.unread", { n: unread })}
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

          <DataFade loading={loading} skeleton={<LoadingBlock />}>
          {failed ? (
            <EmptyState
              icon={WifiOff}
              title={t("cm.postFailed")}
              description={t("cm.loadFailedDesc")}
              action={
                <Button variant="outline" size="sm" onClick={() => void load()}>
                  <RotateCw className="h-4 w-4" /> {t("common.retry")}
                </Button>
              }
            />
          ) : posts.length === 0 ? (
            <EmptyState
              icon={MessageCircle}
              title={t("cm.empty")}
              description={t("cm.emptyDesc")}
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
                  {t("em.loadOlder")}
                </Button>
              )}
            </div>
          )}</DataFade>
        </div>

        <SidePanel stats={stats} />
      </div>

      {/* 互动通知列表 */}
      <Dialog open={notifOpen} onOpenChange={setNotifOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("cm.notif.title")}</DialogTitle>
            <DialogDescription>
              {t("cm.notif.desc")}
            </DialogDescription>
          </DialogHeader>
          <div className="mb-2 flex justify-end">
            <Button variant="ghost" size="sm" onClick={() => void markAllRead()}>
              {t("em.markAllRead")}
            </Button>
          </div>
          {notifLoading ? (
            <LoadingBlock />
          ) : notifs.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t("cm.notif.empty")}</p>
          ) : (
            <div className="max-h-80 space-y-2 overflow-y-auto">
              {notifs.map((n) => {
                const name = n.actorNickname || n.actorUsername || t("msg.someone")
                // feedback_reply 是「管理员回复了我的反馈」——没有帖子可跳，
                // 点击直接进反馈页（见 openNotification 的首个分支）
                const verb =
                  n.type === "feedback_reply"
                    ? t("cm.notif.feedbackReply")
                    : n.type === "comment_reply"
                      ? t("cm.notif.commentReply")
                      : t("cm.notif.postComment")
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
                    {n.commentPreview ? (
                      <p className="mt-1.5 line-clamp-3 rounded-md bg-muted/50 px-2.5 py-1.5 text-sm text-foreground/90">
                        {n.commentPreview}
                      </p>
                    ) : n.postPreview ? (
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {n.postPreview}
                      </p>
                    ) : null}
                    {n.postDeleted && (
                      <p className="mt-1 text-xs text-muted-foreground">{t("msg.postDeletedShort")}</p>
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
