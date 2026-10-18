import * as React from "react"
import {
  Bug,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Heart,
  Lightbulb,
  Loader2,
  MessageSquare,
  RefreshCw,
  Send,
  Stethoscope,
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
import { fmtDateTime, relTime } from "@/lib/format"
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
import { StickerPanel } from "@/components/sticker-panel"
import { Markdown } from "@/components/markdown"
import { useEmojiInsert } from "@/hooks/use-emoji-insert"
import { DraftImagePreview } from "@/components/draft-image-preview"
import { useImageDrop } from "@/hooks/use-image-drop"
import type {
  AdminFeedbackItem,
  AdminFeedbackList,
  AdminFeedbackSummary,
  FeedbackDetail,
  DiagLogView,
} from "@/types"
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
 *
 * 2026-10-10 性能改造（治「打开反馈标签卡几秒」）：
 *   - 列表改**服务端分页**（每页 20 条摘要：正文截断、无消息、无图片 URL）；
 *   - 卡片默认**收起**，点开才调 detail 接口拿全文 + 对话消息 + 诊断日志；
 *     Markdown / ImageGallery 这些重组件只渲染展开的那一条；
 *   - 详情展开状态缓存到内存 Map：翻页回来不用重新拉。
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

/** 已展开详情的内存缓存（id → detail），翻页回来不重拉 */
const detailCache = new Map<string, FeedbackDetail>()

export function FeedbackPanel() {
  const { t } = useT()
  const [data, setData] = React.useState<AdminFeedbackList | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [filter, setFilter] = React.useState<string>("")
  const [page, setPage] = React.useState(1)

  /** 当前展开的反馈 id（null = 全部收起） */
  const [expandedId, setExpandedId] = React.useState<string | null>(null)
  /** 展开中的详情加载态 */
  const [detailLoading, setDetailLoading] = React.useState(false)

  // 回复弹窗：目标既可能是列表摘要（未展开过）也可能是详情全文（展开过），
  // 统一存成「摘要 + 可选全文」的视图
  const [replyTarget, setReplyTarget] = React.useState<{
    summary: AdminFeedbackSummary
    full: AdminFeedbackItem | null
  } | null>(null)
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
  const [deleteTarget, setDeleteTarget] = React.useState<AdminFeedbackSummary | null>(null)
  const [deleteBusy, setDeleteBusy] = React.useState(false)

  const load = React.useCallback(
    async (status = "", p = 1) => {
      setLoading(true)
      try {
        setData(await feedbackApi.listAll(status || undefined, p))
      } catch (err) {
        toast.error(err instanceof HttpError ? err.message : t("fb.err.load"))
      } finally {
        setLoading(false)
      }
    },
    []
  )

  // 首次挂载拉一次（不带筛选，拿到全量与各状态计数）
  React.useEffect(() => {
    void load("", 1)
  }, [load])

  const changeFilter = (status: string) => {
    setFilter(status)
    setPage(1)
    setExpandedId(null)
    void load(status, 1)
  }

  const changePage = (p: number) => {
    setPage(p)
    setExpandedId(null)
    void load(filter, p)
  }

  /** 展开/收起一条：展开时拉详情（缓存命中直接用） */
  const toggle = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null)
      return
    }
    setExpandedId(id)
    if (detailCache.has(id)) return
    setDetailLoading(true)
    try {
      const detail = await feedbackApi.detail(id)
      detailCache.set(id, detail)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("fb.err.load"))
      setExpandedId(null)
    } finally {
      setDetailLoading(false)
    }
  }

  /** 操作成功后：失效该条缓存并重拉当前页（保持展开态的上下文新鲜） */
  const invalidate = (id: string) => {
    detailCache.delete(id)
    void load(filter, page)
  }

  const openReply = (f: AdminFeedbackSummary) => {
    // 详情缓存里有全文时用全文（含消息上下文），没有就带摘要（回复弹窗里够看标题正文了）
    const full = detailCache.get(f.id)?.feedback ?? null
    setReplyTarget({ summary: f, full })
    // 回填已有回复，方便在原文上追加/修改，而不是从零重写
    // （摘要有 hasReply 标志没有全文；详情里有 adminReply 全文）
    setReplyText(full?.adminReply ?? "")
    setReplyStatus(full?.adminReply || f.hasReply ? f.status : "resolved")
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
    // 后端对回复是 `slice(0, 2000)` **静默截断**；输入框的 maxLength 只拦用户手打，
    // 拦不住「程序化插入表情包」把长度顶上去。所以在这里明确拦一次，
    // 免得站长以为文字丢了（2026-10-08）。
    if (text.length > 2000) {
      toast.error(t("af.err.replyTooLong"))
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
        id: replyTarget.summary.id,
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
      invalidate(replyTarget.summary.id)
      notifyAttentionChanged() // 待处理反馈角标当场更新，不用等 60 秒轮询
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("fb.err.reply"))
    } finally {
      setReplyBusy(false)
    }
  }

  /** 只改状态（不回复）：用于「先挂起」这类场景 */
  const changeStatus = async (f: AdminFeedbackSummary, status: string) => {
    try {
      await feedbackApi.setStatus({ id: f.id, status })
      toast.success(t("af.ok.statusUpdated"))
      invalidate(f.id)
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
      detailCache.delete(deleteTarget.id)
      await load(filter, page)
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
  const total = data?.total ?? Object.values(counts).reduce((a, b) => a + b, 0)
  const pageSize = data?.pageSize ?? 20
  const pageCount = Math.max(1, Math.ceil(total / pageSize))

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
          onClick={() => void load(filter, page)}
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
        <LoadingBlock variant="list" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title={filter ? t("af.emptyFiltered", { label: labelOf(filter) }) : t("af.empty")}
          description={t("af.emptyDesc")}
        />
      ) : (
        <div className="space-y-3">
          {items.map((f) => (
            <FeedbackRow
              key={f.id}
              item={f}
              statusLabel={translateApiMessage(statusLabels[f.status] ?? f.status)}
              statusLabels={statusLabels}
              categoryLabel={translateApiMessage(
                categories.find((c) => c.key === f.category)?.label ?? f.category
              )}
              expanded={expandedId === f.id}
              detailLoading={detailLoading}
              detail={detailCache.get(f.id)}
              onToggle={() => void toggle(f.id)}
              onReply={() => openReply(f)}
              onStatus={(s) => void changeStatus(f, s)}
              onDelete={() => setDeleteTarget(f)}
            />
          ))}
        </div>
      )}

      {/* 分页（多于一页才出现） */}
      {pageCount > 1 && (
        <div className="mt-4 flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1 || loading}
            onClick={() => changePage(page - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
            {t("common.prev")}
          </Button>
          <span className="text-sm text-muted-foreground tabular-nums">
            {t("af.pageInfo", { page, total: pageCount })}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= pageCount || loading}
            onClick={() => changePage(page + 1)}
          >
            {t("common.next")}
            <ChevronRight className="h-4 w-4" />
          </Button>
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
                ? `${replyTarget.summary.nickname || replyTarget.summary.username} · ${replyTarget.summary.title}`
                : ""}
            </DialogDescription>
          </DialogHeader>

          {replyTarget && (
            <div className="space-y-4">
              {/* 原正文放出来，回复时不用来回切页面看上下文（同样走 Markdown）。
                  未展开过的条目只有摘要（bodyPreview），也够回复时参考。 */}
              <div className="max-h-40 overflow-y-auto rounded-md border bg-muted/30 p-3">
                <Markdown>{replyTarget.full?.body ?? replyTarget.summary.bodyPreview ?? ""}</Markdown>
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
                  {/* 表情包：与用户端提交反馈、社区、私信保持一致的入口
                      （2026-10-06 站长反馈「反馈里只有 emoji、没有表情包」） */}
                  <StickerPanel onPick={insertReplyEmoji} />
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

/** 单条反馈行（摘要 + 可展开详情）。收起时只渲染标题行，展开才渲染 Markdown。 */
function FeedbackRow({
  item,
  statusLabel,
  statusLabels,
  categoryLabel,
  expanded,
  detailLoading,
  detail,
  onToggle,
  onReply,
  onStatus,
  onDelete,
}: {
  item: AdminFeedbackSummary
  statusLabel: string
  statusLabels: Record<string, string>
  categoryLabel: string
  expanded: boolean
  detailLoading: boolean
  detail?: FeedbackDetail
  onToggle: () => void
  onReply: () => void
  onStatus: (status: string) => void
  onDelete: () => void
}) {
  const { t } = useT()
  const Icon = CATEGORY_ICONS[item.category] ?? MessageSquare
  const full = detail?.feedback
  // 展开时的全文：详情还没到就用摘要顶着（正文预览），到了换全文
  const bodyText = full?.body ?? item.bodyPreview ?? ""

  return (
    <Card>
      <CardContent className="p-4">
        <button type="button" onClick={onToggle} className="flex w-full items-start gap-3 text-left">
          <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{item.title}</span>
              <Badge variant={statusVariant(item.status)}>{statusLabel}</Badge>
              <Badge variant="outline">{categoryLabel}</Badge>
              {item.hasDiagLog && (
                <Badge variant="secondary" className="gap-1">
                  <Stethoscope className="h-3 w-3" />
                  {t("af.hasDiag")}
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">
                {item.nickname || item.username} · {fmtDateTime(item.createdAt)}
              </span>
            </div>
            {!expanded && (
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground/80">{item.bodyPreview}</p>
            )}
          </div>
          <ChevronDown
            className={
              "mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform " +
              (expanded ? "rotate-180" : "")
            }
          />
        </button>

        {expanded && (
          <div className="mt-3 space-y-3 border-t pt-3">
            {detailLoading && !full ? (
              <LoadingBlock variant="list" />
            ) : (
              <>
                <Markdown>{bodyText}</Markdown>
                <ImageGallery images={full?.images ?? []} />

                {/* 对话消息（用户追加 + 管理员回复） */}
                {(full?.messages ?? []).map((m) => {
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
                        {s.isAdmin && <RoleBadge role={s.isRoot ? "root" : "admin"} />}
                        {s.customTitle && <CustomTitleBadge title={s.customTitle} />}
                        {!gone && (
                          <span className="truncate text-muted-foreground">@{s.username}</span>
                        )}
                        <span className="ml-auto shrink-0 font-normal text-muted-foreground">
                          · {fmtDateTime(m.createdAt)}
                        </span>
                      </div>
                      <Markdown>{m.body}</Markdown>
                      <ImageGallery images={m.images} />
                    </div>
                  )
                })}

                {full && full.messages.length === 0 && full.adminReply && (
                  <>
                    <Separator />
                    <div className="rounded-md border border-primary/30 bg-accent/40 p-3">
                      <p className="mb-1 flex items-center gap-1.5 text-xs font-medium">
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                        {t("af.replied")}
                        {full.repliedAt && (
                          <span className="font-normal text-muted-foreground">
                            · {fmtDateTime(full.repliedAt)}
                          </span>
                        )}
                        {!full.replyRead && (
                          <Badge variant="outline" className="ml-1">
                            {t("af.userUnread")}
                          </Badge>
                        )}
                      </p>
                      <Markdown>{full.adminReply}</Markdown>
                    </div>
                  </>
                )}

                {/* 诊断日志 */}
                {detail?.diagLog && <DiagLogBlock log={detail.diagLog} />}
              </>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button size="sm" onClick={onReply}>
                <Send className="h-3.5 w-3.5" />
                {item.hasReply ? t("af.editReply") : t("af.reply")}
              </Button>
              {/* 状态快捷切换：与回复分开，用于「先挂起」/「关闭」这类不产生正文的动作 */}
              <Select value={item.status} onValueChange={onStatus}>
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
                onClick={onDelete}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t("common.delete")}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** 诊断日志展示块：折叠面板 + 时间/类别渲染 */
function DiagLogBlock({ log }: { log: DiagLogView }) {
  const { t } = useT()
  const [open, setOpen] = React.useState(false)
  const [showAll, setShowAll] = React.useState(false)
  const visible = showAll ? log.entries : log.entries.slice(-80)

  const kindLabel = (k: string) => {
    const map: Record<string, string> = {
      route: t("diag.k.route"),
      err: t("diag.k.err"),
      api: t("diag.k.api"),
      longtask: t("diag.k.longtask"),
      perf: t("diag.k.perf"),
      mark: t("diag.k.mark"),
    }
    return map[k] ?? k
  }

  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left text-xs font-medium"
      >
        <Stethoscope className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
        {t("af.diag.title", { n: log.entryCount })}
        <span className="font-normal text-muted-foreground">
          · {t("af.diag.windowLabel", { n: log.windowMinutes })}
          {log.truncated ? ` · ${t("af.diag.truncated")}` : ""}
        </span>
        <ChevronDown
          className={
            "ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform " +
            (open ? "rotate-180" : "")
          }
        />
      </button>
      {open && (
        <div className="mt-2 space-y-1">
          <div className="max-h-80 space-y-0.5 overflow-y-auto rounded bg-background/60 p-2 font-mono text-[11px] leading-relaxed">
            {visible.map((e, i) => (
              <div key={i} className="flex gap-2">
                <span className="shrink-0 text-muted-foreground/70">
                  {relTime(new Date(e.t).toISOString())}
                </span>
                <span
                  className={
                    "shrink-0 " +
                    (e.k === "err"
                      ? "text-red-600 dark:text-red-400"
                      : e.k === "longtask" || e.k === "perf"
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-sky-600 dark:text-sky-400")
                  }
                >
                  [{kindLabel(e.k)}]
                </span>
                <span className="min-w-0 break-all text-foreground/90">
                  {e.p}
                  {e.d !== undefined ? ` (${e.d})` : ""}
                  {e.s ? ` — ${e.s}` : ""}
                </span>
              </div>
            ))}
          </div>
          {log.entries.length > 80 && (
            <button
              type="button"
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll ? t("af.diag.showLess") : t("af.diag.showAll", { n: log.entries.length })}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
