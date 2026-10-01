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
import { notifyAttentionChanged } from "@/lib/attention-events"
import {
  usePickedImages,
  ImagePickerField,
  ImageGallery,
} from "@/components/feedback-image"
import type { AdminFeedbackItem, AdminFeedbackOverview } from "@/types"

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

  // 删除确认弹窗
  const [deleteTarget, setDeleteTarget] = React.useState<AdminFeedbackItem | null>(null)
  const [deleteBusy, setDeleteBusy] = React.useState(false)

  const load = React.useCallback(async (status = "") => {
    setLoading(true)
    try {
      setData(await feedbackApi.listAll(status || undefined))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "加载反馈失败")
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
      toast.error("回复内容不能为空")
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
          ? `这张反馈之前已发过 ${reward.amount} 积分奖励，未重复发放。`
          : `已同时赠送 ${reward.amount} 积分（作者余额 ${reward.balance}）。`
        : ""
      if (failed > 0) {
        toast.warning(`回复已发送，但有 ${failed} 张图片上传失败`, {
          description: rewardNote || undefined,
        })
      } else if (reward?.duplicated) {
        toast.warning("回复已发送", { description: rewardNote })
      } else {
        toast.success("回复已发送", {
          description: rewardNote || "用户会收到站内通知和邮件提醒。",
        })
      }
      setReplyTarget(null)
      setReplyText("")
      setReplyPoints("")
      replyImages.reset()
      await load(filter)
      notifyAttentionChanged() // 待处理反馈角标当场更新，不用等 60 秒轮询
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "回复失败")
    } finally {
      setReplyBusy(false)
    }
  }

  /** 只改状态（不回复）：用于「先挂起」这类场景 */
  const changeStatus = async (f: AdminFeedbackItem, status: string) => {
    try {
      await feedbackApi.setStatus({ id: f.id, status })
      toast.success("状态已更新")
      await load(filter)
      notifyAttentionChanged()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "更新失败")
    }
  }

  /** 删除反馈（连带对话消息与图片）；成功后刷新列表与计数 */
  const submitDelete = async () => {
    if (!deleteTarget) return
    setDeleteBusy(true)
    try {
      const { deletedImages } = await feedbackApi.remove(deleteTarget.id)
      toast.success("已删除", {
        description:
          deletedImages > 0 ? `同时清理了 ${deletedImages} 张图片。` : undefined,
      })
      setDeleteTarget(null)
      await load(filter)
      notifyAttentionChanged()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "删除失败")
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
    if (!key) return "全部"
    return statusLabels[key] ?? key
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          用户在「反馈」页提交的工单，回复后会收到站内通知和邮件。
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
          刷新
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
          title={filter ? `没有${labelOf(filter)}的反馈` : "还没有反馈"}
          description="用户提交反馈后会显示在这里。"
        />
      ) : (
        <div className="space-y-3">
          {items.map((f) => {
            const Icon = CATEGORY_ICONS[f.category] ?? MessageSquare
            const categoryLabel =
              categories.find((c) => c.key === f.category)?.label ?? f.category
            return (
              <Card key={f.id}>
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{f.title}</span>
                        <Badge variant={statusVariant(f.status)}>
                          {statusLabels[f.status] ?? f.status}
                        </Badge>
                        <Badge variant="outline">{categoryLabel}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {f.nickname || f.username} · {fmtDateTime(f.createdAt)}
                        </span>
                      </div>

                      <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                        {f.body}
                      </p>
                      <ImageGallery images={f.images} />

                      {/* 对话消息（用户追加 + 管理员回复） */}
                      {f.messages.map((m) => (
                        <div
                          key={m.id}
                          className={
                            m.isAdmin
                              ? "rounded-md border border-primary/30 bg-accent/40 p-3"
                              : "rounded-md border bg-muted/30 p-3"
                          }
                        >
                          <p className="mb-1 flex items-center gap-1.5 text-xs font-medium">
                            {m.isAdmin ? (
                              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                            ) : (
                              <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                            )}
                            {m.isAdmin ? "管理员" : f.nickname || f.username}
                            <span className="font-normal text-muted-foreground">
                              · {fmtDateTime(m.createdAt)}
                            </span>
                          </p>
                          <p className="whitespace-pre-wrap text-sm">{m.body}</p>
                          <ImageGallery images={m.images} />
                        </div>
                      ))}

                      {f.adminReply && f.messages.length === 0 && (
                        <>
                          <Separator />
                          <div className="rounded-md border border-primary/30 bg-accent/40 p-3">
                            <p className="mb-1 flex items-center gap-1.5 text-xs font-medium">
                              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                              已回复
                              {f.repliedAt && (
                                <span className="font-normal text-muted-foreground">
                                  · {fmtDateTime(f.repliedAt)}
                                </span>
                              )}
                              {!f.replyRead && (
                                <Badge variant="outline" className="ml-1">
                                  用户未读
                                </Badge>
                              )}
                            </p>
                            <p className="whitespace-pre-wrap text-sm">{f.adminReply}</p>
                          </div>
                        </>
                      )}

                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <Button size="sm" onClick={() => openReply(f)}>
                          <Send className="h-3.5 w-3.5" />
                          {f.adminReply ? "修改回复" : "回复"}
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
                                {statusLabels[s] ?? s}
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
                          删除
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
            <DialogTitle>回复反馈</DialogTitle>
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
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                  {replyTarget.body}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="fbReply">回复内容</Label>
                <Textarea
                  id="fbReply"
                  rows={6}
                  maxLength={2000}
                  placeholder="说明处理结果，或需要用户补充的信息…"
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                />
                <ImagePickerField
                  images={replyImages.images}
                  compressing={replyImages.compressing}
                  onPick={replyImages.pick}
                  onRemove={replyImages.remove}
                  fileRef={replyImages.fileRef}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="fbReplyStatus">回复后状态</Label>
                <Select value={replyStatus} onValueChange={setReplyStatus}>
                  <SelectTrigger id="fbReplyStatus" className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FILTERS.filter(Boolean).map((s) => (
                      <SelectItem key={s} value={s}>
                        {statusLabels[s] ?? s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  默认「已处理」。如果只是追问细节、还需要用户回复，选「处理中」。
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="fbReplyPoints">赠送积分（可选）</Label>
                <Input
                  id="fbReplyPoints"
                  type="number"
                  min={1}
                  max={10000}
                  placeholder="留空 = 不赠送"
                  value={replyPoints}
                  onChange={(e) => setReplyPoints(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  随手答谢愿意提反馈的用户（比如报了个真 bug）。
                  这是平台白送的积分，<span className="font-medium">不会</span>触发邀请返佣。
                  <span className="font-medium">
                    同一张反馈只会发一次
                  </span>
                  —— 之后再回复这张单子不会重复赠送（想追加请到「积分 → 用户」里手工发）。
                </p>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setReplyTarget(null)} disabled={replyBusy}>
              取消
            </Button>
            <Button onClick={() => void submitReply()} disabled={replyBusy}>
              {replyBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              发送回复
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
            <DialogTitle>删除这条反馈？</DialogTitle>
            <DialogDescription>
              {deleteTarget
                ? `${deleteTarget.nickname || deleteTarget.username} · ${deleteTarget.title}`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            删除后该反馈及其全部对话记录、上传的图片都会被永久移除，无法恢复；用户侧也会立即看不到。
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleteBusy}
            >
              取消
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
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
