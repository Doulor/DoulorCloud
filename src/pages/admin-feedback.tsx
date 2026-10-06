import * as React from "react"
import {
  Bug,
  CheckCircle2,
  Heart,
  Lightbulb,
  Loader2,
  MessageSquare,
  RefreshCw,
  Send,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import { EmptyState } from "@/components/empty-state"
import { LoadingBlock } from "@/components/loading-block"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { Card, CardContent } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { feedbackApi, HttpError } from "@/services/api"
import { fmtDateTime } from "@/lib/format"
import { UserAvatar } from "@/components/user-avatar"
import { RoleBadge } from "@/components/role-badge"
import { CustomTitleBadge } from "@/components/custom-title-badge"
import { notifyAttentionChanged } from "@/lib/attention-events"
import {
  usePickedImages,
  ImagePickerField,
  ImageGallery,
} from "@/components/feedback-image"
import { EmojiPicker } from "@/components/emoji-picker"
import { useEmojiInsert } from "@/hooks/use-emoji-insert"
import { DraftImagePreview } from "@/components/draft-image-preview"
import { useImageDrop } from "@/hooks/use-image-drop"
import type { AdminFeedbackItem, AdminFeedbackOverview } from "@/types"
import { useT, tStatic, translateApiMessage } from "@/i18n"

/**
 * 管理面板「反馈」标签。
 *
 * 单独放一个文件而不是塞进 admin.tsx：那个文件已经 4000+ 行，且常有别的改动
 * 同时动它（同 admin-oauth.tsx / admin-analytics.tsx 的处理）。
 *
 * 交互取舍：
 *   - 列表默认按「待处理 → 处理中 → 已处理/已关闭」排序（服务端排的），
 *     管理员一进来看到的就是待办，不用自己先筛；
 *   - 顶部状态筛选按钮带数量角标，一眼知道积压多少；
 *   - 回复用弹窗（正文可能很长，就地展开会把列表撑散），
 *     回复时可选「同时把状态改成什么」——默认「已处理」，
 *     因为对用户来说「有回复」基本等于「处理完了」。
 */

const CATEGORY_ICONS: Record<string, React.ElementType> = {
  bug: Bug,
  feature: Lightbulb,
  donation: Heart,
  other: MessageSquare,
}

/** 状态 → 徽章样式（与用户端反馈页保持同一套观感） */
function statusVariant(status: string): "success" | "secondary" | "destructive" | "outline" {
  if (status === "resolved") return "success"
  if (status === "closed") return "outline"
  if (status === "processing") return "secondary"
  return "destructive"
}

/** 筛选按钮用的状态顺序（含「全部」） */
const FILTERS = ["", "pending", "processing", "resolved", "closed"] as const

export function FeedbackPanel() {
  const { t } = useT()
  const [data, setData] = React.useState<AdminFeedbackOverview | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [filter, setFilter] = React.useState<string>("")

  // 回复弹窗
  const [replyTarget, setReplyTarget] = React.useState<AdminFeedbackItem | null>(null)
  const [replyText, setReplyText] = React.useState("")
  const [replyStatus, setReplyStatus] = React.useState("resolved")
  /**
   * 顺带发给作者的积分奖励（空串 = 不发）。
   * 同一张反馈只会发一次（服务端按反馈 id 幂等），重复保存不会重复发。
   */
  const [replyPoints, setReplyPoints] = React.useState("")
  const [replyBusy, setReplyBusy] = React.useState(false)
  const replyImages = usePickedImages()
  // 回复框：表情插到光标处；拖入/粘贴图片交给 replyImages（自带压缩+上传，用 onFiles + noPaste）
  const replyTaRef = React.useRef<HTMLTextAreaElement>(null)
  const insertReplyEmoji = useEmojiInsert(replyTaRef, replyText, setReplyText)
  const { dragging: replyDragging, dropProps: replyDropProps } = useImageDrop({
    onFiles: (files) => void replyImages.pick(files),
    noPaste: true,
  })

  // 删除确认弹窗
  const [deleteTarget, setDeleteTarget] = React.useState<AdminFeedbackItem | null>(null)
  const [deleteBusy, setDeleteBusy] = React.useState(false)

  const load = React.useCallback(async (status = "") => {
    setLoading(true)
    try {
      setData(await feedbackApi.listAll(status || undefined))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("fb.err.load"))
    } finally {
      setLoading(false)
    }
  }, [])

  // 首次挂载拉一次（不带筛选，拿到全量与各状态计数）
  React.useEffect(() => {
    void load("")
  }, [load])

  const changeFilter = (status: string) => {
    setFilter(status)
    void load(status)
  }

  const openReply = (f: AdminFeedbackItem) => {
    setReplyTarget(f)
    // 回填已有回复，方便在原文上追加/修改，而不是从零重写
    setReplyText(f.adminReply ?? "")
    setReplyStatus(f.adminReply ? f.status : "resolved")
    setReplyPoints("")
    replyImages.reset()
  }

  const submitReply = async () => {
    if (!replyTarget) return
    const text = replyText.trim()
    if (!text) {
      toast.error(t("af.err.replyEmpty"))
      return
    }
    setReplyBusy(true)
    try {
      let failed = 0
      const keys: string[] = []
      for (const img of replyImages.images) {
        try {
          const { key } = await feedbackApi.uploadImage(img.file)
          keys.push(key)
        } catch {
          failed++
        }
      }
      const points = Math.floor(Number(replyPoints))
      const res = await feedbackApi.reply({
        id: replyTarget.id,
        reply: text,
        status: replyStatus,
        images: keys,
        rewardPoints: Number.isFinite(points) && points > 0 ? points : undefined,
      })
      const reward = res.reward
      const rewardNote = reward
        ? reward.duplicated
          ? t("af.reward.already", { n: reward.amount })
          : t("af.reward.granted", { n: reward.amount, balance: reward.balance })
        : ""
      if (failed > 0) {
        toast.warning(t("af.ok.repliedWithImages", { n: failed }), {
          description: rewardNote || undefined,
        })
      } else if (reward?.duplicated) {
        toast.warning(t("af.ok.replied"), { description: rewardNote })
      } else {
        toast.success(t("af.ok.replied"), {
          description: rewardNote || t("af.ok.repliedDesc"),
        })
      }
      setReplyTarget(null)
      setReplyText("")
      setReplyPoints("")
      replyImages.reset()
      await load(filter)
      notifyAttentionChanged() // 待处理反馈角标当场更新，不用等 60 秒轮询
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("fb.err.reply"))
    } finally {
      setReplyBusy(false)
    }
  }

  /** 只改状态（不回复）：用于「先挂起」这类场景 */
  const changeStatus = async (f: AdminFeedbackItem, status: string) => {
    try {
      await feedbackApi.setStatus({ id: f.id, status })
      toast.success(t("af.ok.statusUpdated"))
      await load(filter)
      notifyAttentionChanged()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("af.err.update"))
    }
  }

  /** 删除反馈（连带对话消息与图片）；成功后刷新列表与计数 */
  const submitDelete = async () => {
    if (!deleteTarget) return
    setDeleteBusy(true)
    try {
      const { deletedImages } = await feedbackApi.remove(deleteTarget.id)
      toast.success(t("at.ok.deleted"), {
        description:
          deletedImages > 0 ? t("af.deletedImages", { n: deletedImages }) : undefined,
      })
      setDeleteTarget(null)
      await load(filter)
      notifyAttentionChanged()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("em.err.delete"))
    } finally {
      setDeleteBusy(false)
    }
  }

  const items = data?.feedback ?? []
  const counts = data?.counts ?? {}
  const statusLabels = data?.statusLabels ?? {}
  const categories = data?.categories ?? []
  const total = Object.values(counts).reduce((a, b) => a + b, 0)

  const labelOf = (key: string) => {
    if (!key) return tStatic("common.all")
    return translateApiMessage(statusLabels[key] ?? key)
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {t("af.desc")}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load(filter)}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {t("common.refresh")}
        </Button>
      </div>

      {/* 状态筛选：数字是各状态的条数（全部 = 总和） */}
      <div className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((s) => {
          const n = s === "" ? total : counts[s] ?? 0
          const active = filter === s
          return (
            <Button
              key={s || "all"}
              size="sm"
              variant={active ? "default" : "outline"}
              onClick={() => changeFilter(s)}
            >
              {labelOf(s)}
              <span className="ml-1.5 tabular-nums opacity-70">{n}</span>
            </Button>
          )
        })}
      </div>

      {loading && !data ? (
        <LoadingBlock />
      ) : items.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title={filter ? t("af.emptyFiltered", { label: labelOf(filter) }) : t("af.empty")}
          description={t("af.emptyDesc")}
        />
      ) : (
        <div className="space-y-3">
          {items.map((f) => {
            const Icon = CATEGORY_ICONS[f.category] ?? MessageSquare
            const categoryLabel =
              translateApiMessage(categories.find((c) => c.key === f.category)?.label ?? f.category)
            return (
              <Card key={f.id}>
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{f.title}</span>
                        <Badge variant={statusVariant(f.status)}>
                          {translateApiMessage(statusLabels[f.status] ?? f.status)}
                        </Badge>
                        <Badge variant="outline">{categoryLabel}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {f.nickname || f.username} · {fmtDateTime(f.createdAt)}
                        </span>
                      </div>

                      <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                        {f.body}
                      </p>
                      <ImageGallery images={f.images} />

                      {/* 对话消息（用户追加 + 管理员回复） */}
                      {f.messages.map((m) => {
                        const s = m.sender
                        const gone = !s.username
                        return (
                          <div
                            key={m.id}
                            className={
                              m.isAdmin
                                ? "rounded-md border border-primary/30 bg-accent/40 p-3"
                                : "rounded-md border bg-muted/30 p-3"
                            }
                          >
                            <div className="mb-1.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
                              {gone ? (
                                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                                  <MessageSquare className="h-3.5 w-3.5" />
                                </span>
                              ) : (
                                <UserAvatar
                                  username={s.username}
                                  nickname={s.nickname}
                                  hasAvatar={s.hasAvatar}
                                  className="h-6 w-6"
                                />
                              )}
                              <span className="truncate font-medium">
                                {gone ? t("fb.deletedUser") : s.nickname ?? s.username}
                              </span>
                              {s.isAdmin && (
                                <RoleBadge role={s.isRoot ? "root" : "admin"} />
                              )}
                              {s.customTitle && <CustomTitleBadge title={s.customTitle} />}
                              {!gone && (
                                <span className="truncate text-muted-foreground">
                                  @{s.username}
                                </span>
                              )}
                              <span className="ml-auto shrink-0 font-normal text-muted-foreground">
                                · {fmtDateTime(m.createdAt)}
                              </span>
                            </div>
                            <p className="whitespace-pre-wrap break-words text-sm">{m.body}</p>
                            <ImageGallery images={m.images} />
                          </div>
                        )
                      })}

                      {f.adminReply && f.messages.length === 0 && (
                        <>
                          <Separator />
                          <div className="rounded-md border border-primary/30 bg-accent/40 p-3">
                            <p className="mb-1 flex items-center gap-1.5 text-xs font-medium">
                              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                              {t("af.replied")}
                              {f.repliedAt && (
                                <span className="font-normal text-muted-foreground">
                                  · {fmtDateTime(f.repliedAt)}
                                </span>
                              )}
                              {!f.replyRead && (
                                <Badge variant="outline" className="ml-1">
                                  {t("af.userUnread")}
                                </Badge>
                              )}
                            </p>
                            <p className="whitespace-pre-wrap break-words text-sm">{f.adminReply}</p>
                          </div>
                        </>
                      )}

                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <Button size="sm" onClick={() => openReply(f)}>
                          <Send className="h-3.5 w-3.5" />
                          {f.adminReply ? t("af.editReply") : t("af.reply")}
                        </Button>
                        {/* 状态快捷切换：与回复分开，用于「先挂起」/「关闭」这类不产生正文的动作 */}
                        <Select
                          value={f.status}
                          onValueChange={(v) => void changeStatus(f, v)}
                        >
                          <SelectTrigger className="h-8 w-32">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {FILTERS.filter(Boolean).map((s) => (
                              <SelectItem key={s} value={s}>
                                {translateApiMessage(statusLabels[s] ?? s)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {/* 删除：不可逆，走二次确认弹窗 */}
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setDeleteTarget(f)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          {t("common.delete")}
                        </Button>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* 回复弹窗 */}
      <Dialog
        open={replyTarget !== null}
        onOpenChange={(o) => {
          if (!o) setReplyTarget(null)
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("af.dlg.title")}</DialogTitle>
            <DialogDescription>
              {replyTarget
                ? `${replyTarget.nickname || replyTarget.username} · ${replyTarget.title}`
                : ""}
            </DialogDescription>
          </DialogHeader>

          {replyTarget && (
            <div className="space-y-4">
              {/* 原正文放出来，回复时不用来回切页面看上下文 */}
              <div className="max-h-40 overflow-y-auto rounded-md border bg-muted/30 p-3">
                <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                  {replyTarget.body}
                </p>
              </div>

              <div
                {...replyDropProps}
                className={`space-y-2${replyDragging ? " rounded-md ring-2 ring-primary" : ""}`}
              >
                <Label htmlFor="fbReply">{t("af.dlg.reply")}</Label>
                <Textarea
                  id="fbReply"
                  ref={replyTaRef}
                  rows={6}
                  maxLength={2000}
                  placeholder={t("af.dlg.replyPh")}
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  onPaste={(e) => {
                    // 直接粘贴截图/图片：把图收进待上传列表，不往正文塞字节
                    const files = e.clipboardData?.files
                    if (files && files.length > 0) {
                      e.preventDefault()
                      void replyImages.pick(files)
                    }
                  }}
                />
                <DraftImagePreview text={replyText} className="mt-2" setText={setReplyText} />
                <div className="flex items-center gap-1">
                  <EmojiPicker onPick={insertReplyEmoji} />
                </div>
                <ImagePickerField
                  images={replyImages.images}
                  compressing={replyImages.compressing}
                  onPick={replyImages.pick}
                  onRemove={replyImages.remove}
                  fileRef={replyImages.fileRef}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="fbReplyStatus">{t("af.dlg.status")}</Label>
                <Select value={replyStatus} onValueChange={setReplyStatus}>
                  <SelectTrigger id="fbReplyStatus" className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FILTERS.filter(Boolean).map((s) => (
                      <SelectItem key={s} value={s}>
                        {translateApiMessage(statusLabels[s] ?? s)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t("af.dlg.statusHint")}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="fbReplyPoints">{t("af.dlg.points")}</Label>
                <Input
                  id="fbReplyPoints"
                  type="number"
                  min={1}
                  max={10000}
                  placeholder={t("af.dlg.pointsPh")}
                  value={replyPoints}
                  onChange={(e) => setReplyPoints(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t("af.dlg.pointsHint1")}
                  {t("af.dlg.pointsHint2")}
                  <span className="font-medium">
                    {t("af.dlg.pointsOnce")}
                  </span>
                  {t("af.dlg.pointsOnceDesc")}
                </p>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setReplyTarget(null)} disabled={replyBusy}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void submitReply()} disabled={replyBusy}>
              {replyBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              {t("af.dlg.send")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认弹窗 */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null)
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("af.del.title")}</DialogTitle>
            <DialogDescription>
              {deleteTarget
                ? `${deleteTarget.nickname || deleteTarget.username} · ${deleteTarget.title}`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t("af.del.desc")}
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleteBusy}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void submitDelete()}
              disabled={deleteBusy}
            >
              {deleteBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
