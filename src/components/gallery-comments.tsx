/**
 * 造物集评论区（2026-10-21）。
 *
 * ## 与社区广场**完全一致**
 * 渲染与交互直接用 `components/comment-tree.tsx`（从社区抽出来的同一份代码），
 * 这里只负责：拉数据、把四个动作接到造物集的后端、以及发表框。
 *
 * ## 评论按**单个作品**隔离
 * 所有请求都带 `projectId`；后端每个接口重新校验「这个作品你能看吗」，
 * 且父评论必须属于同一作品。换作品 = 换一整套评论。
 */
import * as React from "react"
import { Loader2, MessageSquare, Send } from "lucide-react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { CommentTree, type CommentActions } from "@/components/comment-tree"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { DraftImagePreview } from "@/components/draft-image-preview"
import { EmojiPicker } from "@/components/emoji-picker"
import { StickerPanel } from "@/components/sticker-panel"
import { useEmojiInsert } from "@/hooks/use-emoji-insert"
import { useImageDrop } from "@/hooks/use-image-drop"
import { useAuth } from "@/hooks/use-auth"
import { useT } from "@/i18n"
import { galleryApi, HttpError, errMsg } from "@/services/api"
import type { CommentNode } from "@/types"
import { cn } from "@/lib/utils"

export function GalleryComments({ projectId }: { projectId: string }) {
  const { t } = useT()
  const { user } = useAuth()
  const navigate = useNavigate()

  const [comments, setComments] = React.useState<CommentNode[]>([])
  const [count, setCount] = React.useState(0)
  const [editLimit, setEditLimit] = React.useState(2)
  const [loading, setLoading] = React.useState(true)
  const [text, setText] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const taRef = React.useRef<HTMLTextAreaElement>(null)

  const load = React.useCallback(async () => {
    try {
      const res = await galleryApi.listComments(projectId)
      // 后端返回的结构刻意与社区 CommentNode 对齐，直接喂给 CommentTree
      setComments(res.comments as unknown as CommentNode[])
      setCount(res.count)
      setEditLimit(res.editLimit ?? 2)
    } catch (err) {
      // 未登录 / 作品转私有都会走到这里 —— 侧栏静默即可，别弹红
      if (!(err instanceof HttpError && (err.status === 401 || err.status === 404))) {
        toast.error(errMsg(err, t("gal.cmt.errLoad")))
      }
    } finally {
      setLoading(false)
    }
  }, [projectId, t])

  React.useEffect(() => {
    void load()
  }, [load])

  /** 未登录时点任意操作 → 去登录，登录后回到当前页 */
  const onNeedLogin = React.useCallback(() => {
    navigate("/login", { state: { from: window.location.pathname + window.location.search } })
  }, [navigate])

  const actions = React.useMemo<CommentActions>(
    () => ({
      submit: (body: string, parentId?: string) => galleryApi.addComment(projectId, body, parentId),
      update: (commentId: string, body: string) =>
        galleryApi.updateComment(projectId, commentId, body),
      remove: (commentId: string) => galleryApi.deleteComment(projectId, commentId),
      toggleLike: (commentId: string) => galleryApi.toggleCommentLike(projectId, commentId),
    }),
    [projectId]
  )

  const insertEmoji = useEmojiInsert(taRef, text, setText)
  const { dragging, dropProps } = useImageDrop({ onImage: insertEmoji })

  const submit = async () => {
    if (!user) {
      onNeedLogin()
      return
    }
    const body = text.trim()
    if (!body) return
    setBusy(true)
    try {
      await galleryApi.addComment(projectId, body)
      setText("")
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("gal.cmt.errPost")))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b px-3 py-2.5">
        <MessageSquare className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">{t("gal.cmt.title")}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {loading ? (
          <div className="flex items-center justify-center gap-1.5 py-8 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span className="text-xs">{t("common.loading")}</span>
          </div>
        ) : comments.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">{t("gal.cmt.empty")}</p>
        ) : (
          <CommentTree
            comments={comments}
            actions={actions}
            editLimit={editLimit}
            onNeedLogin={onNeedLogin}
            onChanged={() => void load()}
          />
        )}
      </div>

      <div className="shrink-0 border-t p-2.5">
        {user ? (
          <div
            {...dropProps}
            className={cn("relative space-y-1.5", dragging && "rounded-md ring-2 ring-primary")}
          >
            <Textarea
              ref={taRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("cm.commentPh")}
              rows={2}
              className="min-h-0 resize-none text-sm"
            />
            <DraftImagePreview text={text} className="mt-1" setText={setText} />
            <div className="flex items-center gap-1">
              <EmojiPicker onPick={insertEmoji} />
              <StickerPanel onPick={insertEmoji} />
              <Button
                size="sm"
                className="ml-auto"
                disabled={busy || !text.trim()}
                onClick={() => void submit()}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {t("cm.send")}
              </Button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={onNeedLogin}
            className="w-full rounded-md border py-2 text-xs text-muted-foreground hover:bg-muted/50"
          >
            {t("cm.loginToComment")}
          </button>
        )}
      </div>
    </div>
  )
}
