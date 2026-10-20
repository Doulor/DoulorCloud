/**
 * 通用评论树（2026-10-21）。
 *
 * ## 为什么抽出来
 * 站长要求造物集评论区「和社区广场完全一致」。社区那套 `CommentItem`/`CommentTree`
 * 已经打磨了很多细节（盖楼竖线、回复折叠、高赞优先、编辑次数、已删除占位、
 * 表情/图片、右键存表情包），重写一份必然会漂移。
 *
 * 所以把渲染与交互**原样抽出来**，唯一变化是：**不再直接调 `communityApi`**，
 * 而是通过 `actions` 注入。这样社区和造物集各自接自己的后端，
 * 而视觉与交互是同一份代码 —— 永远一致。
 *
 * ## 数据契约
 * 依赖 `CommentNode`（`src/types`）。造物集的接口刻意返回同款结构
 * （`author` 嵌套对象 / `hot` / `liked` / `editCount` / `deleted` / `replyTo`），
 * 就是为了能直接喂给这里。
 *
 * ## i18n
 * 沿用社区的词条命名空间 `cm.*` —— 既然要求"完全一致"，
 * 文案也应该是同一批键，而不是复制一份 `gal.cmt.*` 出来各自演化。
 */
import * as React from "react"
import { Flame, Heart, Loader2, PenSquare, Send, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { UserAvatar } from "@/components/user-avatar"
import { UserCardPopover } from "@/components/user-card"
import { RoleBadge } from "@/components/role-badge"
import { CustomTitleBadge } from "@/components/custom-title-badge"
import { Markdown } from "@/components/markdown"
import { useStickerSaveMenu } from "@/components/sticker-save-menu"
import { DraftImagePreview } from "@/components/draft-image-preview"
import { EmojiPicker } from "@/components/emoji-picker"
import { StickerPanel } from "@/components/sticker-panel"
import { useEmojiInsert } from "@/hooks/use-emoji-insert"
import { useImageDrop } from "@/hooks/use-image-drop"
import { useAuth } from "@/hooks/use-auth"
import { useT } from "@/i18n"
import { errMsg } from "@/services/api"
import type { CommentNode } from "@/types"
import { fmtTime, relTime } from "@/lib/format"
import { cn } from "@/lib/utils"

/**
 * 各场景注入的后端动作。
 *
 * 之所以不像社区原版那样直接 import `communityApi`：造物集评论是另一套后端
 * （`gallery_comments` 表 + 按作品隔离的路径），但渲染逻辑要一模一样。
 */
export interface CommentActions {
  submit: (body: string, parentId?: string) => Promise<unknown>
  update: (commentId: string, body: string) => Promise<unknown>
  remove: (commentId: string) => Promise<unknown>
  toggleLike: (commentId: string) => Promise<{ liked: boolean; likeCount: number }>
}

/** 平铺后的一行：要么是一条评论，要么是「展开 N 条回复」的入口 */
type FlatRow =
  | { kind: "comment"; node: CommentNode; parentAuthor: string | null; lineUp: boolean; lineDown: boolean }
  | { kind: "more"; node: CommentNode; hidden: number }

/** 折叠阈值：同级回复超过这个数就先收起 */
const REPLY_COLLAPSE_AT = 3

function CommentItem({
  node,
  actions,
  onNeedLogin,
  onChanged,
  editLimit,
  lineUp = false,
  lineDown = false,
  parentAuthor = null,
  topBorder = true,
}: {
  node: CommentNode
  actions: CommentActions
  onNeedLogin?: () => void
  onChanged: () => void
  editLimit: number
  lineUp?: boolean
  lineDown?: boolean
  parentAuthor?: string | null
  topBorder?: boolean
}) {
  const { t } = useT()
  const { user } = useAuth()
  const [replying, setReplying] = React.useState(false)
  const [text, setText] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const taRef = React.useRef<HTMLTextAreaElement>(null)
  const { onContextMenu: onStickerContextMenu, renderMenu: renderStickerMenu } =
    useStickerSaveMenu()

  const submit = async () => {
    if (!user) {
      onNeedLogin?.()
      return
    }
    if (!text.trim()) return
    setBusy(true)
    try {
      await actions.submit(text.trim(), node.id)
      setText("")
      setReplying(false)
      onChanged()
    } catch (err) {
      toast.error(errMsg(err, t("cm.err.comment")))
    } finally {
      setBusy(false)
    }
  }

  const insertEmoji = useEmojiInsert(taRef, text, setText)
  const { dragging, dropProps } = useImageDrop({ onImage: insertEmoji })

  const [liked, setLiked] = React.useState(Boolean(node.liked))
  const [likeCount, setLikeCount] = React.useState(node.likeCount)
  const [liking, setLiking] = React.useState(false)

  const toggleLike = async () => {
    if (!user) {
      onNeedLogin?.()
      return
    }
    if (liking) return
    setLiking(true)
    const prev = { liked, likeCount }
    setLiked(!liked)
    setLikeCount((c) => Math.max(0, c + (liked ? -1 : 1)))
    try {
      const res = await actions.toggleLike(node.id)
      setLiked(res.liked)
      setLikeCount(res.likeCount)
    } catch (err) {
      setLiked(prev.liked)
      setLikeCount(prev.likeCount)
      toast.error(errMsg(err, t("cm.err.like")))
    } finally {
      setLiking(false)
    }
  }

  const editCount = Number(node.editCount) || 0
  const isMine = Boolean(user && user.id === node.user_id)
  const canEdit = isMine && !node.deleted && editLimit > 0 && editCount < editLimit
  const canDelete = !node.deleted && (isMine || Boolean(user && user.role !== "user"))

  const [editing, setEditing] = React.useState(false)
  const [editText, setEditText] = React.useState("")
  const [editBusy, setEditBusy] = React.useState(false)
  const editTaRef = React.useRef<HTMLTextAreaElement>(null)
  const insertEditEmoji = useEmojiInsert(editTaRef, editText, setEditText)
  const { dragging: editDragging, dropProps: editDropProps } = useImageDrop({
    onImage: insertEditEmoji,
  })

  const startEdit = () => {
    setEditText(node.body)
    setEditing(true)
    setReplying(false)
    setTimeout(() => editTaRef.current?.focus(), 0)
  }

  const submitEdit = async () => {
    if (!editText.trim() || editBusy) return
    if (editText.trim() === node.body) {
      setEditing(false)
      return
    }
    setEditBusy(true)
    try {
      await actions.update(node.id, editText.trim())
      setEditing(false)
      toast.success(t("cm.ok.commentUpdated"))
      onChanged()
    } catch (err) {
      toast.error(errMsg(err, t("cm.err.editComment")))
      onChanged()
    } finally {
      setEditBusy(false)
    }
  }

  const removeComment = async () => {
    if (!confirm(t("cm.confirmDeleteComment"))) return
    try {
      await actions.remove(node.id)
      toast.success(t("cm.ok.commentDeleted"))
      onChanged()
    } catch (err) {
      toast.error(errMsg(err, t("cm.err.deleteComment")))
    }
  }

  return (
    <div
      className={cn("relative flex gap-3 px-3 py-3", topBorder && "border-t")}
      data-comment-id={node.id}
      data-comment-deleted={node.deleted ? "1" : undefined}
    >
      {/* 盖楼竖线：与上下相邻行接续，构成推特那种连续连线 */}
      {lineUp && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-8 top-0 h-3 w-0.5 -translate-x-1/2 bg-border"
        />
      )}
      {lineDown && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 left-8 top-[3.25rem] w-0.5 -translate-x-1/2 bg-border"
        />
      )}

      <div className="shrink-0">
        <UserCardPopover
          username={node.author.username}
          nickname={node.author.nickname}
          hasAvatar={node.author.hasAvatar}
          className="block text-left"
        >
          <UserAvatar
            username={node.author.username}
            nickname={node.author.nickname}
            hasAvatar={node.author.hasAvatar}
            className="h-10 w-10"
          />
        </UserCardPopover>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span className="min-w-0 truncate text-sm font-semibold">
            {node.author.nickname ?? node.author.username}
          </span>
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            @{node.author.username}
          </span>
          {node.author.isAdmin && <RoleBadge role={node.author.isRoot ? "root" : "admin"} />}
          {node.author.customTitle && <CustomTitleBadge title={node.author.customTitle} />}
          {node.hot && (
            <Badge variant="secondary" className="shrink-0 text-[10px]">
              <Flame className="mr-0.5 h-3 w-3 text-orange-500" />
              {t("cm.hot")}
            </Badge>
          )}
          <span className="shrink-0 text-xs text-muted-foreground" title={fmtTime(node.createdAt)}>
            · {relTime(node.createdAt)}
          </span>
          {!node.deleted && editCount > 0 && (
            <span
              className="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
              title={node.updatedAt ? t("cm.editedAt", { time: fmtTime(node.updatedAt) }) : undefined}
            >
              {t("cm.editCount", { n: editCount })}
            </span>
          )}
        </div>

        {(parentAuthor || node.replyTo) && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("cm.replyTo")}{" "}
            <span className="text-primary">@{parentAuthor ?? node.replyTo}</span>
          </p>
        )}

        {node.deleted ? (
          <p className="mt-1 text-sm italic text-muted-foreground line-through decoration-muted-foreground/40">
            {t("cm.commentDeleted")}
          </p>
        ) : editing ? (
          <div
            {...editDropProps}
            className={cn("relative mt-2", editDragging && "rounded-md ring-2 ring-primary")}
          >
            <Textarea
              ref={editTaRef}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              rows={3}
              placeholder={t("cm.editCommentPh")}
              className="text-sm"
            />
            <DraftImagePreview text={editText} className="mt-1.5" setText={setEditText} />
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <EmojiPicker onPick={insertEditEmoji} />
              <StickerPanel onPick={insertEditEmoji} />
              <span className="ml-auto text-[11px] text-muted-foreground">
                {t("cm.editRemaining", { n: Math.max(0, editLimit - editCount) })}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setEditing(false)}
                disabled={editBusy}
              >
                {t("common.cancel")}
              </Button>
              <Button size="sm" onClick={() => void submitEdit()} disabled={editBusy || !editText.trim()}>
                {editBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {t("common.save")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-1" onContextMenu={onStickerContextMenu}>
            <Markdown stickerSaveButton={false}>{node.body}</Markdown>
          </div>
        )}

        {!node.deleted && (
          <div className="mt-1.5 flex flex-wrap items-center gap-3">
            <button
              onClick={() => void toggleLike()}
              className={cn(
                "flex items-center gap-1 text-xs transition-colors",
                liked ? "text-primary" : "text-muted-foreground hover:text-foreground"
              )}
              title={t("cm.like")}
            >
              <Heart className={cn("h-3.5 w-3.5", liked && "fill-current")} />
              {likeCount > 0 && <span className="tabular-nums">{likeCount}</span>}
              <span>{t("cm.like")}</span>
            </button>
            {user && (
              <button
                onClick={() => {
                  setReplying((v) => !v)
                  setEditing(false)
                }}
                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                {replying ? t("cm.cancelReply") : t("cm.reply")}
              </button>
            )}
            {canEdit && !editing && (
              <button
                onClick={startEdit}
                className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <PenSquare className="h-3.5 w-3.5" />
                {t("common.edit")}
              </button>
            )}
            {canDelete && (
              <button
                onClick={() => void removeComment()}
                className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t("common.delete")}
              </button>
            )}
          </div>
        )}

        {!node.deleted && isMine && !canEdit && editLimit > 0 && editCount >= editLimit && (
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            {t("cm.editLimitReached", { n: editLimit })}
          </p>
        )}

        {!node.deleted && replying && (
          <div
            {...dropProps}
            className={cn("relative mt-2", dragging && "rounded-md ring-2 ring-primary")}
          >
            <Textarea
              ref={taRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={2}
              placeholder={t("cm.replyPh", { name: node.author.nickname ?? node.author.username })}
              className="text-sm"
            />
            <DraftImagePreview text={text} className="mt-1.5" setText={setText} />
            <div className="mt-1.5 flex items-center gap-1">
              <EmojiPicker onPick={insertEmoji} />
              <StickerPanel onPick={insertEmoji} />
              <Button size="sm" className="ml-auto" onClick={submit} disabled={busy || !text.trim()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {t("cm.reply")}
              </Button>
            </div>
          </div>
        )}
      </div>
      {renderStickerMenu()}
    </div>
  )
}

function flattenComments(
  nodes: CommentNode[],
  expanded: Set<string>,
  out: FlatRow[],
  parent: CommentNode | null
): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    const hasNextSibling = i < nodes.length - 1
    const collapsed = !expanded.has(node.id) && node.replies.length > REPLY_COLLAPSE_AT
    const shown = collapsed ? node.replies.slice(0, REPLY_COLLAPSE_AT) : node.replies
    out.push({
      kind: "comment",
      node,
      parentAuthor: parent?.author.username ?? null,
      lineUp: parent !== null,
      // 头像下方画线，仅当：有可见的下级回复，或自己是回复且后面还有兄弟。
      // ⚠️ 根评论之间互不相连 —— 否则没人回复的根评论会误连到下一个帖子。
      lineDown: shown.length > 0 || (parent !== null && hasNextSibling),
    })
    flattenComments(shown, expanded, out, node)
    if (collapsed && node.replies.length > shown.length) {
      out.push({ kind: "more", node, hidden: node.replies.length - shown.length })
    }
  }
}

export function CommentTree({
  comments,
  actions,
  editLimit,
  onNeedLogin,
  onChanged,
}: {
  comments: CommentNode[]
  actions: CommentActions
  editLimit: number
  onNeedLogin?: () => void
  onChanged: () => void
}) {
  const { t } = useT()
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set())
  const rows = React.useMemo(() => {
    const out: FlatRow[] = []
    flattenComments(comments, expanded, out, null)
    return out
  }, [comments, expanded])

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      {rows.map((row, i) =>
        row.kind === "comment" ? (
          <CommentItem
            key={row.node.id}
            node={row.node}
            actions={actions}
            onNeedLogin={onNeedLogin}
            onChanged={onChanged}
            editLimit={editLimit}
            parentAuthor={row.parentAuthor}
            lineUp={row.lineUp}
            lineDown={row.lineDown}
            topBorder={i > 0 && !row.lineUp}
          />
        ) : (
          <div key={`more-${row.node.id}`} className="flex gap-3 px-3 py-2">
            {/* 空头像列占位，让「展开」链接与正文左对齐 */}
            <div className="w-10 shrink-0" />
            <button
              type="button"
              onClick={() =>
                setExpanded((prev) => {
                  const next = new Set(prev)
                  next.add(row.node.id)
                  return next
                })
              }
              className="text-xs font-medium text-primary hover:underline"
            >
              {t("cm.expandReplies", { n: row.hidden })}
            </button>
          </div>
        )
      )}
    </div>
  )
}
