import * as React from "react"
import {
  AlertCircle,
  ArrowLeft,
  Bug,
  CheckCircle2,
  ChevronDown,
  Heart,
  Lightbulb,
  Loader2,
  MessageSquare,
  Send,
  Sparkles,
} from "lucide-react"
import { Link } from "react-router-dom"
import { toast } from "sonner"

import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { LoadingBlock } from "@/components/loading-block"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { feedbackApi, HttpError, errMsg } from "@/services/api"
import { fmtTime } from "@/lib/format"
import {
  usePickedImages,
  ImagePickerField,
  ImageGallery,
} from "@/components/feedback-image"
import type { FeedbackItem, FeedbackOverview } from "@/types"

/**
 * 反馈页。
 *
 * 表单在左（一次只提一条，提交后清空），我提过的反馈在右（带状态与管理员回复）。
 * 不做「提交后跳走」：用户常常想紧接着看自己刚提的那条，留在原页更顺手。
 *
 * 分类与状态的中文文案**由服务端下发**（`categories` / `statusLabels`），
 * 前端只负责给分类配图标与配色 —— 否则改文案要同时改前后端两处，必漂移。
 */

/** 分类 → 图标。服务端只给 key，具体图标是纯前端表现层的事。 */
const CATEGORY_ICONS: Record<string, React.ElementType> = {
  bug: Bug,
  feature: Lightbulb,
  donation: Heart,
  other: MessageSquare,
}

/** 分类 → 卡片选中时的强调色（不用主色统一涂，方便一眼分辨） */
const CATEGORY_TONE: Record<string, string> = {
  bug: "text-rose-600 dark:text-rose-400",
  feature: "text-amber-600 dark:text-amber-400",
  donation: "text-emerald-600 dark:text-emerald-400",
  other: "text-muted-foreground",
}

/** 状态 → 徽章样式。未知状态按「待处理」显示，不至于整页崩掉。 */
function statusVariant(status: string): "success" | "secondary" | "destructive" | "outline" {
  if (status === "resolved") return "success"
  if (status === "closed") return "outline"
  if (status === "processing") return "secondary"
  return "destructive"
}

const MAX_TITLE = 80
const MAX_BODY = 2000

export default function FeedbackPage() {
  const [data, setData] = React.useState<FeedbackOverview | null>(null)
  const [loading, setLoading] = React.useState(true)

  // 表单状态
  const [category, setCategory] = React.useState("bug")
  const [title, setTitle] = React.useState("")
  const [body, setBody] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  /** 展开查看回复的那条 id */
  const [expanded, setExpanded] = React.useState<string | null>(null)
  /** 提交表单的待上传图片 */
  const formImages = usePickedImages()

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await feedbackApi.list()
      // 进页面即把「已回复未读」标记为已读 —— 用户点进来就是为了看回复。
      // 本地也同步把 replyRead 置真，否则「新回复」徽章要等下次刷新才消失。
      if (res.unreadReplies > 0) {
        void feedbackApi.markRead().catch(() => {})
        res.feedback = res.feedback.map((f) => ({ ...f, replyRead: true }))
      }
      setData(res)
      // 自动展开最新一条（列表按时间倒序，第一条即最新）
      setExpanded(res.feedback[0]?.id ?? null)
    } catch (err) {
      toast.error(errMsg(err, "加载反馈失败"))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const categories = data?.categories ?? []
  const statusLabels = data?.statusLabels ?? {}

  const submit = async () => {
    const t = title.trim()
    const b = body.trim()
    if (!t) {
      toast.error("请填写标题")
      return
    }
    if (!b) {
      toast.error("请填写详细内容")
      return
    }
    setBusy(true)
    try {
      // 先逐张上传图片拿 key（单张失败不阻断提交，最后统一提示）
      let failed = 0
      const keys: string[] = []
      for (const img of formImages.images) {
        try {
          const { key } = await feedbackApi.uploadImage(img.file)
          keys.push(key)
        } catch {
          failed++
        }
      }
      await feedbackApi.create({ category, title: t, body: b, images: keys })
      if (failed > 0) {
        toast.warning(`反馈已提交，但有 ${failed} 张图片上传失败`)
      } else {
        toast.success("反馈已提交", {
          description: "管理员回复后，会在这里显示，同时收到站内通知。",
        })
      }
      setTitle("")
      setBody("")
      formImages.reset()
      await load()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "提交失败")
    } finally {
      setBusy(false)
    }
  }

  const items = data?.feedback ?? []

  /** 用户对某条反馈追加回复，成功后刷新列表 */
  const handleReply = async (id: string, text: string, images: string[]) => {
    try {
      await feedbackApi.replyMy({ id, reply: text, images })
      toast.success("回复已发送")
      await load()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "回复失败")
    }
  }

  return (
    <div>
      <PageHeader
        title="反馈"
        description="提交问题、建议或捐献相关咨询，管理员会在这里回复你"
      />

      <Link
        to="/dashboard"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        返回控制台
      </Link>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ---- 左：提交表单 ---- */}
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-muted-foreground" />
              提交反馈
            </CardTitle>
            <CardDescription>
              请尽量把「你做了什么、期望什么、实际发生了什么」写清楚，
              这样管理员才能定位问题，也能更快给你回复。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>分类</Label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {categories.map((c) => {
                  const Icon = CATEGORY_ICONS[c.key] ?? MessageSquare
                  const active = category === c.key
                  return (
                    <button
                      key={c.key}
                      type="button"
                      onClick={() => setCategory(c.key)}
                      className={
                        "flex flex-col items-center gap-1.5 rounded-md border px-2 py-3 text-xs transition-colors " +
                        (active
                          ? "border-primary bg-accent font-medium text-foreground"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground")
                      }
                    >
                      <Icon
                        className={
                          "h-4 w-4 " + (active ? CATEGORY_TONE[c.key] ?? "" : "")
                        }
                      />
                      {c.label}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="fbTitle">标题</Label>
              <Input
                id="fbTitle"
                maxLength={MAX_TITLE}
                placeholder="一句话概括"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="fbBody">详细内容</Label>
              <Textarea
                id="fbBody"
                rows={8}
                maxLength={MAX_BODY}
                placeholder={"复现步骤 / 期望结果 / 实际情况，越具体越好"}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
              <p className="text-right text-xs text-muted-foreground">
                {body.length} / {MAX_BODY}
              </p>
            </div>

            <ImagePickerField
              images={formImages.images}
              compressing={formImages.compressing}
              onPick={formImages.pick}
              onRemove={formImages.remove}
              fileRef={formImages.fileRef}
            />

            <div className="flex justify-end">
              <Button onClick={() => void submit()} disabled={busy}>
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                提交
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* ---- 右：我的反馈 ---- */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">我提交的反馈</h2>
            {items.length > 0 && (
              <span className="text-xs text-muted-foreground">共 {items.length} 条</span>
            )}
          </div>

          {loading ? (
            <LoadingBlock />
          ) : items.length === 0 ? (
            <EmptyState
              icon={MessageSquare}
              title="还没有提交过反馈"
              description="左边填好标题和内容，点「提交」即可。"
            />
          ) : (
            items.map((f) => (
              <FeedbackCard
                key={f.id}
                item={f}
                statusLabel={statusLabels[f.status] ?? f.status}
                categoryLabel={
                  categories.find((c) => c.key === f.category)?.label ?? f.category
                }
                expanded={expanded === f.id}
                onToggle={() => setExpanded((prev) => (prev === f.id ? null : f.id))}
                onReply={handleReply}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}

/** 单条反馈卡：默认收起，点开看完整正文与管理员回复 */
function FeedbackCard({
  item,
  statusLabel,
  categoryLabel,
  expanded,
  onToggle,
  onReply,
}: {
  item: FeedbackItem
  statusLabel: string
  categoryLabel: string
  expanded: boolean
  onToggle: () => void
  onReply: (id: string, text: string, images: string[]) => Promise<void>
}) {
  const Icon = CATEGORY_ICONS[item.category] ?? MessageSquare
  const hasReply = Boolean(item.adminReply)
  // 未读回复：用一条左侧色条 + 徽章提示，不做整卡高亮（列表里会太吵）
  const unread = hasReply && !item.replyRead
  // 追加回复输入框
  const [replyText, setReplyText] = React.useState("")
  const [replying, setReplying] = React.useState(false)
  const replyImages = usePickedImages()

  const submitReply = async () => {
    const t = replyText.trim()
    if (!t && replyImages.images.length === 0) {
      toast.error("请输入回复内容")
      return
    }
    setReplying(true)
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
      await onReply(item.id, t, keys)
      if (failed > 0) toast.warning(`已发送，但有 ${failed} 张图片上传失败`)
      setReplyText("")
      replyImages.reset()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "回复失败")
    } finally {
      setReplying(false)
    }
  }

  return (
    <Card className={unread ? "border-primary/50" : undefined}>
      <CardContent className="p-4">
        <button
          type="button"
          onClick={onToggle}
          className="flex w-full items-start gap-3 text-left"
        >
          <Icon
            className={
              "mt-0.5 h-4 w-4 shrink-0 " + (CATEGORY_TONE[item.category] ?? "")
            }
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{item.title}</span>
              <Badge variant={statusVariant(item.status)}>{statusLabel}</Badge>
              {unread && <Badge variant="default">新回复</Badge>}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {categoryLabel} · {fmtTime(item.createdAt)}
              {item.repliedAt && ` · 回复于 ${fmtTime(item.repliedAt)}`}
            </p>
            {!expanded && (
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground/80">
                {item.body}
              </p>
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
            {/* 我的原始反馈 */}
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">我</p>
              <p className="whitespace-pre-wrap text-sm">{item.body}</p>
              <ImageGallery images={item.images} />
            </div>

            {/* 对话消息（用户追加 + 管理员回复） */}
            {item.messages.map((m) => (
              <div
                key={m.id}
                className={
                  m.isAdmin
                    ? "rounded-md border border-primary/30 bg-accent/40 p-3"
                    : ""
                }
              >
                <p
                  className={
                    "mb-1 flex items-center gap-1.5 text-xs font-medium " +
                    (m.isAdmin ? "text-foreground" : "text-muted-foreground")
                  }
                >
                  {m.isAdmin ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                  ) : null}
                  {m.isAdmin ? "管理员" : "我"}
                </p>
                <p className="whitespace-pre-wrap text-sm">{m.body}</p>
                <ImageGallery images={m.images} />
              </div>
            ))}

            {/* 兼容：老数据没有 messages，只有 adminReply 字段 */}
            {item.messages.length === 0 && hasReply && (
              <div className="rounded-md border border-primary/30 bg-accent/40 p-3">
                <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                  管理员回复
                </p>
                <p className="whitespace-pre-wrap text-sm">{item.adminReply}</p>
              </div>
            )}
            {item.messages.length === 0 && !hasReply && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <AlertCircle className="h-3.5 w-3.5" />
                还没有回复，管理员看到后会尽快处理。
              </p>
            )}

            {/* 追加回复 */}
            <div className="space-y-2">
              <Textarea
                rows={2}
                placeholder="继续补充说明…"
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
              <div className="flex justify-end">
                <Button
                  size="sm"
                  onClick={() => void submitReply()}
                  disabled={replying || (!replyText.trim() && replyImages.images.length === 0)}
                >
                  {replying && <Loader2 className="h-4 w-4 animate-spin" />}
                  <Send className="h-3.5 w-3.5" />
                  发送
                </Button>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
