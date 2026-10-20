/**
 * 造物集评论区（2026-10-21）。
 *
 * ## 定位
 * 挂在作品详情页右侧的窄栏里（约 320–380px），所以它是社区的**紧凑版**：
 *   · 保留：头像、昵称、时间、正文、回复（任意层级）、删除
 *   · 砍掉：表情面板、图片拖拽、评论点赞、编辑 ——
 *     这些在窄栏里既挤不开，造物集也不是长对话场景（说错了删掉重发即可）
 *
 * ## 为什么自己写而不是复用 community.tsx 的 CommentTree
 * 那个组件的每次提交都直接调 `communityApi.comment(postId, ...)`，
 * 和帖子强绑定；要复用得先把它的提交抽成回调，等于重构 90KB 的社区页 ——
 * 风险远大于收益。真正共享的是后端 `groupComments()`（建树规则），那才是
 * 容易写错的部分，已经复用了。
 *
 * ## 评论按作品隔离
 * 所有请求都带 `projectId`，后端每个接口都会重新校验「这个作品你能看吗」，
 * 且父评论必须属于同一作品 —— 换个作品就是换一套评论，互不相通。
 */
import * as React from "react"
import { Loader2, MessageSquare, Reply, Trash2, Send } from "lucide-react"
import { toast } from "sonner"

import { galleryApi, HttpError, type GalleryCommentNode } from "@/services/api"
import { useAuth } from "@/hooks/use-auth"
import { useT } from "@/i18n"
import { UserAvatar } from "@/components/user-avatar"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

/** 单条评论 + 它的回复（递归） */
function CommentRow({
  node,
  projectId,
  depth,
  onChanged,
}: {
  node: GalleryCommentNode
  projectId: string
  depth: number
  onChanged: () => void
}) {
  const { t } = useT()
  const { user } = useAuth()
  const [replying, setReplying] = React.useState(false)
  const [text, setText] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  const submitReply = async () => {
    const body = text.trim()
    if (!body) return
    setBusy(true)
    try {
      await galleryApi.addComment(projectId, body, node.id)
      setText("")
      setReplying(false)
      onChanged()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("gal.cmt.errPost"))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!window.confirm(t("gal.cmt.confirmDelete"))) return
    setBusy(true)
    try {
      await galleryApi.deleteComment(projectId, node.id)
      onChanged()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("gal.cmt.errDelete"))
    } finally {
      setBusy(false)
    }
  }

  // 缩进上限：到第 3 层就不再往里缩，否则窄栏里正文只剩几个字宽
  const indent = Math.min(depth, 3) * 12

  return (
    <div style={{ marginLeft: indent }} className={cn(depth > 0 && "mt-2")}>
      <div className="flex gap-2">
        <UserAvatar
          username={node.authorUsername || node.authorName}
          hasAvatar={node.authorAvatar}
          className="mt-0.5 h-7 w-7 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-1.5">
            <span className="truncate text-xs font-medium">{node.authorName}</span>
            <span className="text-[10px] text-muted-foreground">
              {new Date(node.createdAt).toLocaleString("zh-CN", {
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>

          {/* whitespace-pre-wrap：保留用户敲的换行；break-words 防长串撑破窄栏 */}
          <p className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-relaxed">
            {node.body}
          </p>

          <div className="mt-1 flex items-center gap-3">
            {user && (
              <button
                type="button"
                onClick={() => setReplying((v) => !v)}
                className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
              >
                <Reply className="h-3 w-3" />
                {t("gal.cmt.reply")}
              </button>
            )}
            {node.isMine && (
              <button
                type="button"
                onClick={() => void remove()}
                disabled={busy}
                className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-destructive disabled:opacity-50"
              >
                <Trash2 className="h-3 w-3" />
                {t("gal.cmt.delete")}
              </button>
            )}
          </div>

          {replying && (
            <div className="mt-1.5 space-y-1.5">
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={t("gal.cmt.replyPlaceholder", { name: node.authorName })}
                rows={2}
                maxLength={1000}
                className="min-h-0 resize-none text-xs"
                onKeyDown={(e) => {
                  // Ctrl/Cmd + Enter 直接发（窄栏里回车换行更常用）
                  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                    e.preventDefault()
                    void submitReply()
                  }
                }}
              />
              <div className="flex justify-end gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => setReplying(false)}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  disabled={busy || !text.trim()}
                  onClick={() => void submitReply()}
                >
                  {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                  {t("gal.cmt.send")}
                </Button>
              </div>
            </div>
          )}

          {node.replies.length > 0 && (
            <div className="mt-1 border-l pl-2">
              {node.replies.map((r) => (
                <CommentRow
                  key={r.id}
                  node={r}
                  projectId={projectId}
                  depth={depth + 1}
                  onChanged={onChanged}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function GalleryComments({ projectId }: { projectId: string }) {
  const { t } = useT()
  const { user } = useAuth()
  const [list, setList] = React.useState<GalleryCommentNode[]>([])
  const [count, setCount] = React.useState(0)
  const [loading, setLoading] = React.useState(true)
  const [text, setText] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    try {
      const res = await galleryApi.listComments(projectId)
      setList(res.comments)
      setCount(res.count)
    } catch (err) {
      // 未登录 / 作品已转私有都会走到这里 —— 静默即可，别在侧栏弹红
      if (!(err instanceof HttpError && (err.status === 401 || err.status === 404))) {
        toast.error(err instanceof HttpError ? err.message : t("gal.cmt.errLoad"))
      }
    } finally {
      setLoading(false)
    }
  }, [projectId, t])

  React.useEffect(() => {
    void load()
  }, [load])

  const submit = async () => {
    const body = text.trim()
    if (!body) return
    setBusy(true)
    try {
      await galleryApi.addComment(projectId, body)
      setText("")
      await load()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("gal.cmt.errPost"))
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

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {loading ? (
          <div className="flex items-center justify-center gap-1.5 py-8 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span className="text-xs">{t("gal.loading")}</span>
          </div>
        ) : list.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">
            {t("gal.cmt.empty")}
          </p>
        ) : (
          <div className="space-y-3">
            {list.map((n) => (
              <CommentRow
                key={n.id}
                node={n}
                projectId={projectId}
                depth={0}
                onChanged={() => void load()}
              />
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t p-2.5">
        {user ? (
          <div className="space-y-1.5">
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("gal.cmt.placeholder")}
              rows={2}
              maxLength={1000}
              className="min-h-0 resize-none text-xs"
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                  e.preventDefault()
                  void submit()
                }
              }}
            />
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">
                {text.length}/1000
              </span>
              <Button
                size="sm"
                className="h-7 px-2.5 text-xs"
                disabled={busy || !text.trim()}
                onClick={() => void submit()}
              >
                {busy ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="mr-1 h-3.5 w-3.5" />
                )}
                {t("gal.cmt.send")}
              </Button>
            </div>
          </div>
        ) : (
          <p className="py-2 text-center text-xs text-muted-foreground">
            {t("gal.cmt.loginRequired")}
          </p>
        )}
      </div>
    </div>
  )
}

