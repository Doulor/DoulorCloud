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
import { fmtTime, relTime } from "@/lib/format"
import { EmojiPicker } from "@/components/emoji-picker"
import { StickerPanel } from "@/components/sticker-panel"
import { Markdown } from "@/components/markdown"
import { UserAvatar } from "@/components/user-avatar"
import { RoleBadge } from "@/components/role-badge"
import { CustomTitleBadge } from "@/components/custom-title-badge"
import { useEmojiInsert } from "@/hooks/use-emoji-insert"
import { useAuth } from "@/hooks/use-auth"
import { DraftImagePreview } from "@/components/draft-image-preview"
import { useImageDrop } from "@/hooks/use-image-drop"
import { cn } from "@/lib/utils"
import {
  usePickedImages,
  ImagePickerField,
  ImageGallery,
} from "@/components/feedback-image"
import type { FeedbackItem, FeedbackOverview } from "@/types"
import { useT, translateApiMessage } from "@/i18n"

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
  const { t } = useT()
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

  /**
   * 拖入图片 → 交给 `formImages`（它自带压缩与上传）。
   * `noPaste`：这个 Textarea 自己已经处理粘贴了，两边都接会重复上传。
   */
  const { dragging, dropProps } = useImageDrop({
    onFiles: (files) => void formImages.pick(files),
    noPaste: true,
  })
  /** 正文输入框：表情要插到光标处 */
  const bodyRef = React.useRef<HTMLTextAreaElement | null>(null)
  const insertEmoji = useEmojiInsert(bodyRef, body, setBody)

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
      toast.error(errMsg(err, t("fb.err.load")))
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
    const ttl = title.trim()
    const b = body.trim()
    if (!ttl) {
      toast.error(t("fb.err.titleRequired"))
      return
    }
    if (!b) {
      toast.error(t("fb.err.bodyRequired"))
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
      await feedbackApi.create({ category, title: ttl, body: b, images: keys })
      if (failed > 0) {
        toast.warning(t("fb.ok.submittedWithImages", { n: failed }))
      } else {
        toast.success(t("fb.ok.submitted"), {
          description: t("fb.ok.submittedDesc"),
        })
      }
      setTitle("")
      setBody("")
      formImages.reset()
      await load()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("fb.err.submit"))
    } finally {
      setBusy(false)
    }
  }

  const items = data?.feedback ?? []

  /** 用户对某条反馈追加回复，成功后刷新列表 */
  const handleReply = async (id: string, text: string, images: string[]) => {
    try {
      await feedbackApi.replyMy({ id, reply: text, images })
      toast.success(t("fb.ok.replied"))
      await load()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("fb.err.reply"))
    }
  }

  /** 编辑还没被处理的反馈 */
  const handleEdit = async (id: string, payload: { category: string; title: string; body: string }) => {
    try {
      await feedbackApi.edit(id, payload)
      toast.success(t("fb.ok.edited"))
      await load()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("fb.err.edit"))
    }
  }

  /** 撤销（删除）还没被处理的反馈 */
  const handleWithdraw = async (id: string) => {
    try {
      await feedbackApi.withdraw(id)
      toast.success(t("fb.ok.withdrawn"))
      await load()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("fb.err.withdraw"))
    }
  }

  return (
    <div>
      <PageHeader
        title={t("fb.title")}
        description={t("fb.desc")}
      />

      <Link
        to="/dashboard"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {t("space.backToConsole")}
      </Link>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ---- 左：提交表单 ---- */}
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-muted-foreground" />
              {t("fb.submitTitle")}
            </CardTitle>
            <CardDescription>{t("fb.submitDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>{t("fb.category")}</Label>
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
                      {translateApiMessage(c.label)}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="fbTitle">{t("fb.field.title")}</Label>
              <Input
                id="fbTitle"
                maxLength={MAX_TITLE}
                placeholder={t("fb.titlePlaceholder")}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            <div
              {...dropProps}
              className={cn("relative space-y-2", dragging && "rounded-md ring-2 ring-primary")}
            >
              <Label htmlFor="fbBody">{t("fb.field.body")}</Label>
              <Textarea
                id="fbBody"
                ref={bodyRef}
                rows={8}
                maxLength={MAX_BODY}
                placeholder={t("fb.bodyPlaceholder")}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                onPaste={(e) => {
                  // 直接粘贴截图/图片：有图就把图收进待上传列表，不往正文塞字节
                  const files = e.clipboardData?.files
                  if (files && files.length > 0) {
                    e.preventDefault()
                    void formImages.pick(files)
                  }
                }}
              />
              <DraftImagePreview text={body} className="mt-2" setText={setBody} />
              <div className="flex items-center gap-1">
                <EmojiPicker onPick={insertEmoji} />
                <StickerPanel onPick={insertEmoji} />
                <span className="ml-auto text-xs text-muted-foreground">
                  {body.length} / {MAX_BODY}
                </span>
              </div>
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
                {t("common.submit")}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* ---- 右：我的反馈 ---- */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">{t("fb.mine")}</h2>
            {items.length > 0 && (
              <span className="text-xs text-muted-foreground">{t("fb.count", { n: items.length })}</span>
            )}
          </div>

          {loading ? (
            <LoadingBlock />
          ) : items.length === 0 ? (
            <EmptyState
              icon={MessageSquare}
              title={t("fb.empty")}
              description={t("fb.emptyDesc")}
            />
          ) : (
            items.map((f) => (
              <FeedbackCard
                key={f.id}
                item={f}
                statusLabel={translateApiMessage(statusLabels[f.status] ?? f.status)}
                categoryLabel={
                  translateApiMessage(categories.find((c) => c.key === f.category)?.label ?? f.category)
                }
                categories={categories}
                expanded={expanded === f.id}
                onToggle={() => setExpanded((prev) => (prev === f.id ? null : f.id))}
                onReply={handleReply}
                onEdit={handleEdit}
                onWithdraw={handleWithdraw}
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
  categories,
  expanded,
  onToggle,
  onReply,
  onEdit,
  onWithdraw,
}: {
  item: FeedbackItem
  statusLabel: string
  categoryLabel: string
  categories: { key: string; label: string }[]
  expanded: boolean
  onToggle: () => void
  onReply: (id: string, text: string, images: string[]) => Promise<void>
  onEdit: (id: string, payload: { category: string; title: string; body: string }) => Promise<void>
  onWithdraw: (id: string) => Promise<void>
}) {
  const { t } = useT()
  const { user: me } = useAuth()
  const Icon = CATEGORY_ICONS[item.category] ?? MessageSquare
  const hasReply = Boolean(item.adminReply)
  // 未读回复：用一条左侧色条 + 徽章提示，不做整卡高亮（列表里会太吵）
  const unread = hasReply && !item.replyRead
  // 追加回复输入框
  const [replyText, setReplyText] = React.useState("")
  const [replying, setReplying] = React.useState(false)
  const replyImages = usePickedImages()

  /** 拖入图片 → 交给回复的图片列表（noPaste：下面那个 Textarea 自己处理粘贴） */
  const { dragging: replyDragging, dropProps: replyDropProps } = useImageDrop({
    onFiles: (files) => void replyImages.pick(files),
    noPaste: true,
  })

  // 编辑（仅 pending 可编辑）
  const editable = item.status === "pending"
  const [editing, setEditing] = React.useState(false)
  const [editTitle, setEditTitle] = React.useState("")
  const [editBody, setEditBody] = React.useState("")
  const [editCategory, setEditCategory] = React.useState("")
  const [savingEdit, setSavingEdit] = React.useState(false)
  const [withdrawing, setWithdrawing] = React.useState(false)

  const startEdit = () => {
    setEditTitle(item.title)
    setEditBody(item.body)
    setEditCategory(item.category)
    setEditing(true)
  }
  const saveEdit = async () => {
    const ttl = editTitle.trim()
    const b = editBody.trim()
    if (!ttl || !b) {
      toast.error(t("fb.err.titleRequired"))
      return
    }
    setSavingEdit(true)
    try {
      await onEdit(item.id, { category: editCategory, title: ttl, body: b })
      setEditing(false)
    } finally {
      setSavingEdit(false)
    }
  }
  const doWithdraw = async () => {
    if (!window.confirm(t("fb.withdrawConfirm"))) return
    setWithdrawing(true)
    try {
      await onWithdraw(item.id)
    } finally {
      setWithdrawing(false)
    }
  }

  const submitReply = async () => {
    const text = replyText.trim()
    if (!text && replyImages.images.length === 0) {
      toast.error(t("fb.err.replyRequired"))
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
      await onReply(item.id, text, keys)
      if (failed > 0) toast.warning(t("fb.ok.repliedWithImages", { n: failed }))
      setReplyText("")
      replyImages.reset()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("fb.err.reply"))
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
              {unread && <Badge variant="default">{t("fb.newReply")}</Badge>}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {categoryLabel} · {fmtTime(item.createdAt)}
              {item.repliedAt && t("fb.repliedAt", { time: fmtTime(item.repliedAt) })}
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
              <div className="mb-1 flex items-center justify-between gap-2">
                <p className="text-xs font-medium text-muted-foreground">{t("fb.me")}</p>
                {editable && !editing && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                      onClick={startEdit}
                    >
                      {t("fb.edit")}
                    </button>
                    <button
                      type="button"
                      className="text-xs text-muted-foreground transition-colors hover:text-destructive disabled:opacity-60"
                      onClick={() => void doWithdraw()}
                      disabled={withdrawing}
                    >
                      {t("fb.withdraw")}
                    </button>
                  </div>
                )}
              </div>

              {editing ? (
                <div className="space-y-2">
                  <select
                    value={editCategory}
                    onChange={(e) => setEditCategory(e.target.value)}
                    className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                  >
                    {categories.map((c) => (
                      <option key={c.key} value={c.key}>
                        {translateApiMessage(c.label)}
                      </option>
                    ))}
                  </select>
                  <Input
                    value={editTitle}
                    maxLength={MAX_TITLE}
                    onChange={(e) => setEditTitle(e.target.value)}
                  />
                  <Textarea
                    rows={5}
                    maxLength={MAX_BODY}
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                  />
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditing(false)}
                      disabled={savingEdit}
                    >
                      {t("common.cancel")}
                    </Button>
                    <Button size="sm" onClick={() => void saveEdit()} disabled={savingEdit}>
                      {savingEdit && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                      {t("common.save")}
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <Markdown>{item.body}</Markdown>
                  <ImageGallery images={item.images} />
                </>
              )}
            </div>

            {/* 对话消息（用户追加 + 管理员回复） */}
            {item.messages.map((m) => {
              const s = m.sender
              // 发送者已被删除：username 为空（后端 UNKNOWN_SENDER 兜底）
              const gone = !s.username
              const mine = Boolean(me) && s.username === me!.username
              const name = gone
                ? t("fb.deletedUser")
                : mine
                  ? t("fb.me")
                  : s.nickname ?? s.username
              return (
                <div
                  key={m.id}
                  className={
                    m.isAdmin
                      ? "rounded-md border border-primary/30 bg-accent/40 p-3"
                      : ""
                  }
                >
                  <div
                    className={
                      "mb-1.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs " +
                      (m.isAdmin ? "text-foreground" : "text-muted-foreground")
                    }
                  >
                    {gone ? (
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                        <AlertCircle className="h-3.5 w-3.5" />
                      </span>
                    ) : (
                      <UserAvatar
                        username={s.username}
                        nickname={s.nickname}
                        hasAvatar={s.hasAvatar}
                        className="h-6 w-6"
                      />
                    )}
                    <span className="truncate font-medium">{name}</span>
                    {m.isAdmin && (
                      <RoleBadge role={s.isRoot ? "root" : "admin"} />
                    )}
                    {s.customTitle && <CustomTitleBadge title={s.customTitle} />}
                    {!gone && !mine && (
                      <span className="truncate text-muted-foreground">@{s.username}</span>
                    )}
                    <span className="ml-auto shrink-0 text-[11px] text-muted-foreground" title={fmtTime(m.createdAt)}>
                      {relTime(m.createdAt)}
                    </span>
                  </div>
                  <Markdown>{m.body}</Markdown>
                  <ImageGallery images={m.images} />
                </div>
              )
            })}

            {/* 兼容：老数据没有 messages，只有 adminReply 字段 */}
            {item.messages.length === 0 && hasReply && (
              <div className="rounded-md border border-primary/30 bg-accent/40 p-3">
                <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                  {t("fb.adminReply")}
                </p>
                <Markdown>{item.adminReply ?? ""}</Markdown>
              </div>
            )}
            {item.messages.length === 0 && !hasReply && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <AlertCircle className="h-3.5 w-3.5" />
                {t("fb.noReplyYet")}
              </p>
            )}

            {/* 追加回复 */}
            <div
              {...replyDropProps}
              className={cn(
                "relative space-y-2",
                replyDragging && "rounded-md ring-2 ring-primary"
              )}
            >
              <Textarea
                rows={2}
                placeholder={t("fb.replyPlaceholder")}
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
                  {t("fb.send")}
                </Button>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
