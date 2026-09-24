import * as React from "react"
import { useSearchParams } from "react-router-dom"
import { AlertTriangle, CheckCheck, Inbox, Loader2, Mail, Plus, Reply, RotateCcw, Send, Settings, Trash2 } from "lucide-react"
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
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { fmtMailTime } from "@/lib/format"
import { emailApi, HttpError } from "@/services/api"
import type { Mailbox, MailMessage } from "@/types"

/** 邮箱数量上限的兜底值（真实值由后端 GET /api/mailbox 的 limit 返回，
 *  管理员为 999999 哨兵值 → 界面显示「不限」） */
const FALLBACK_MAILBOX_LIMIT = 3
/** 后端表示「不限」的哨兵值 */
const UNLIMITED_LIMIT = 999999

type View = "list" | "message"

export default function EmailPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const pendingMailbox = searchParams.get("mailbox")
  const pendingMessage = searchParams.get("message")

  const [mailboxes, setMailboxes] = React.useState<Mailbox[]>([])
  const [mailboxLimit, setMailboxLimit] = React.useState(FALLBACK_MAILBOX_LIMIT)
  const [selected, setSelected] = React.useState<Mailbox | null>(null)
  const [messages, setMessages] = React.useState<MailMessage[]>([])
  const [opened, setOpened] = React.useState<MailMessage | null>(null)
  const [view, setView] = React.useState<View>("list")
  const [loadingMailboxes, setLoadingMailboxes] = React.useState(true)
  const [loadingMessages, setLoadingMessages] = React.useState(false)
  const [loadingBody, setLoadingBody] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [deletingId, setDeletingId] = React.useState<string | null>(null)

  // 添加邮箱
  const [addOpen, setAddOpen] = React.useState(false)
  const [localPart, setLocalPart] = React.useState("")

  // 转发配置（按邮箱独立弹窗）
  const [forwardBox, setForwardBox] = React.useState<Mailbox | null>(null)
  const [forwardInput, setForwardInput] = React.useState("")
  const [savingForward, setSavingForward] = React.useState(false)

  const loadMailboxes = React.useCallback(async (selectId?: string) => {
    setLoadingMailboxes(true)
    try {
      const res = await emailApi.list()
      setMailboxes(res.mailboxes)
      if (typeof res.limit === "number") setMailboxLimit(res.limit)
      // 优先级：显式指定 > query 参数 ?mailbox= > 主邮箱 > 第一个
      const target =
        res.mailboxes.find((m) => m.id === selectId) ??
        (pendingMailbox ? res.mailboxes.find((m) => m.id === pendingMailbox) : null) ??
        res.mailboxes.find((m) => m.primary) ??
        res.mailboxes[0] ??
        null
      setSelected(target)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "加载邮箱失败")
    } finally {
      setLoadingMailboxes(false)
    }
  }, [pendingMailbox])

  const loadMessages = React.useCallback(async (mailboxId: string) => {
    setLoadingMessages(true)
    setView("list")
    setOpened(null)
    try {
      const res = await emailApi.listMessages(mailboxId)
      setMessages(res.messages)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "加载邮件失败")
      setMessages([])
    } finally {
      setLoadingMessages(false)
    }
  }, [])

  React.useEffect(() => {
    void loadMailboxes()
  }, [loadMailboxes])

  React.useEffect(() => {
    if (selected) void loadMessages(selected.id)
  }, [selected?.id, loadMessages])

  // 带 ?message= 跳转过来：messages 加载后自动打开该邮件，然后清掉 query
  React.useEffect(() => {
    if (!pendingMessage || !selected || loadingMessages) return
    const target = messages.find((m) => m.id === pendingMessage)
    if (target) {
      void handleOpenMessage(target)
      // 清除 query 参数，避免刷新又触发
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.delete("mailbox")
        next.delete("message")
        return next
      })
    }
  }, [pendingMessage, messages, selected, loadingMessages])

  // 更新本地未读数（邮件已读时）
  /**
   * 按增量调整未读数。
   * 必须在函数式更新里计算：直接读 selected.unread 会拿到渲染时的旧值，
   * 连续快速操作两封邮件时两次都基于同一个旧值，未读数会被算错。
   */
  const bumpUnread = React.useCallback(
    (mailboxId: string, delta: number) => {
      setMailboxes((prev) =>
        prev.map((mb) =>
          mb.id === mailboxId
            ? { ...mb, unread: Math.max(0, mb.unread + delta) }
            : mb
        )
      )
    },
    []
  )

  const handleOpenMessage = async (message: MailMessage) => {
    if (!selected) return
    const mailboxId = selected.id

    // 列表接口不返回正文，先展示占位再拉取单封详情（含正文）
    setOpened(message)
    setView("message")
    setLoadingBody(true)
    try {
      const res = await emailApi.getMessage(mailboxId, message.id)
      setOpened(res.message)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "加载邮件正文失败")
    } finally {
      setLoadingBody(false)
    }

    if (!message.read) {
      setMessages((prev) =>
        prev.map((m) => (m.id === message.id ? { ...m, read: true } : m))
      )
      bumpUnread(mailboxId, -1)
      try {
        await emailApi.markRead(mailboxId, message.id, true)
      } catch {
        // 静默：界面已更新
      }
    }
  }

  const totalUnread = mailboxes.reduce((sum, m) => sum + (m.unread ?? 0), 0)

  const handleMarkUnread = async () => {
    if (!opened || !selected) return
    setMessages((prev) => prev.map((m) => (m.id === opened.id ? { ...m, read: false } : m)))
    bumpUnread(selected.id, 1)
    setOpened({ ...opened, read: false })
    setView("list")
    try {
      await emailApi.markRead(selected.id, opened.id, false)
      toast.success("已标记为未读")
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "操作失败")
    }
  }

  // 一键全部已读：把所有 mailbox 的未读标已读
  const handleMarkAllRead = async () => {
    if (busy) return
    setBusy(true)
    try {
      const res = await emailApi.markAllRead()
      // 本地：所有邮箱未读清零、当前列表全标已读
      setMailboxes((prev) => prev.map((m) => ({ ...m, unread: 0 })))
      setMessages((prev) => prev.map((m) => ({ ...m, read: true })))
      toast.success(`已标记 ${res.updated} 封邮件为已读`)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "操作失败")
    } finally {
      setBusy(false)
    }
  }

  /**
   * 回信：以当前邮箱地址发出。
   * 收件人由服务端从原邮件推导（前端不传，避免这个接口被当成开放中继），
   * 这里只提交正文。失败时**抛出**给调用方做行内提示 —— 后端会把 Cloudflare
   * 的失败原因翻成人话（如"请先完成 Email Sending Onboard"），吞掉就会误导用户。
   */
  const handleReply = async (text: string) => {
    if (!selected || !opened) throw new Error("邮件未打开，请重新进入该邮件")
    const res = await emailApi.reply(selected.id, opened.id, text)
    toast.success(`已发送给 ${res.to}`)
  }

  const handleDeleteMessage = async (messageId: string) => {
    if (!selected) return
    setDeletingId(messageId)
    try {
      await emailApi.deleteMessage(selected.id, messageId)
      setMessages((prev) => prev.filter((m) => m.id !== messageId))
      if (opened?.id === messageId) {
        setOpened(null)
        setView("list")
      }
      void loadMailboxes()
      toast.success("邮件已删除")
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "删除失败")
    } finally {
      setDeletingId(null)
    }
  }

  const handleAddMailbox = async () => {
    setBusy(true)
    try {
      await emailApi.create({ localPart })
      toast.success("邮箱已添加")
      setLocalPart("")
      setAddOpen(false)
      await loadMailboxes()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "创建失败")
    } finally {
      setBusy(false)
    }
  }

  const handleDeleteMailbox = async (mailbox: Mailbox) => {
    if (mailbox.primary) return
    setBusy(true)
    try {
      await emailApi.remove(mailbox.id)
      toast.success("邮箱已删除")
      await loadMailboxes()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "删除失败")
    } finally {
      setBusy(false)
    }
  }

  const openForwardDialog = (mailbox: Mailbox) => {
    setForwardBox(mailbox)
    setForwardInput(mailbox.forwardingTo.join(", "))
  }

  const handleSaveForwarding = async () => {
    if (!forwardBox) return
    setSavingForward(true)
    try {
      const targets = forwardInput
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
      const res = await emailApi.updateForwarding(forwardBox.id, targets)
      // 只更新这个邮箱的配置，不影响其他邮箱
      setMailboxes((prev) =>
        prev.map((mb) => (mb.id === res.mailbox.id ? res.mailbox : mb))
      )
      setForwardBox(null)

      const unverified = (res.forwardingStatus ?? []).filter((s) => !s.verified)
      if (unverified.length > 0) {
        toast.warning(
          `已保存。请到 ${unverified.map((u) => u.email).join("、")} 查收验证邮件并点击确认，验证后才会开始转发。`
        )
      } else {
        toast.success(`已保存 ${forwardBox.address} 的转发设置`)
      }
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "保存失败")
    } finally {
      setSavingForward(false)
    }
  }

  const unlimited = mailboxLimit >= UNLIMITED_LIMIT
  const canAdd = unlimited || mailboxes.length < mailboxLimit

  return (
    <div>
      <PageHeader
        title="邮箱"
        description={
          unlimited
            ? `${mailboxes.length} 个地址（管理员不限）`
            : `${mailboxes.length} / ${mailboxLimit} 个地址`
        }
        actions={
          <div className="flex items-center gap-2">
            {totalUnread > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleMarkAllRead()}
                disabled={busy}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCheck className="h-4 w-4" />}
                全部已读
                <Badge variant="secondary" className="ml-1">{totalUnread}</Badge>
              </Button>
            )}
            <Button onClick={() => setAddOpen(true)} disabled={!canAdd}>
              <Plus className="h-4 w-4" />
              添加邮箱
            </Button>
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[300px,1fr]">
        {/* 邮箱侧栏 */}
        <div className="flex flex-col gap-3">
          {loadingMailboxes ? (
            <LoadingBlock />
          ) : mailboxes.length === 0 ? (
            <EmptyState
              icon={Mail}
              title="还没有邮箱"
              description="添加地址后即可收信。"
            />
          ) : (
            mailboxes.map((mb) => (
              <div
                key={mb.id}
                className={cn(
                  "group flex items-center gap-2 rounded-md border px-3 py-2.5 transition-colors",
                  selected?.id === mb.id ? "border-foreground/20 bg-accent" : "hover:bg-accent/50"
                )}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => setSelected(mb)}
                  title={
                    mb.forwardingTo.length > 0
                      ? `转发至 ${mb.forwardingTo.join(", ")}`
                      : undefined
                  }
                >
                  <div className="truncate">
                    <p className="truncate font-mono text-sm">{mb.address}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {mb.unread > 0 ? `${mb.unread} 封未读` : `${mb.total} 封邮件`}
                      {mb.forwardingTo.length > 0 && (
                        <>
                          {" · "}
                          {mb.lastForwardError
                            ? "转发失败"
                            : mb.forwardingVerified?.every((v) => v === true)
                              ? "已转发"
                              : "转发待验证"}
                          {" → "}
                          <span className="font-mono">{mb.forwardingTo.join(", ")}</span>
                        </>
                      )}
                    </p>
                  </div>
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  {!mb.primary && (
                    <button
                      type="button"
                      className="hidden rounded p-1 text-muted-foreground hover:text-destructive group-hover:block"
                      onClick={() => void handleDeleteMailbox(mb)}
                      aria-label={`删除 ${mb.address}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    className="rounded p-1 text-muted-foreground hover:text-foreground"
                    onClick={() => openForwardDialog(mb)}
                    aria-label={`设置 ${mb.address}`}
                  >
                    <Settings className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* 主区域：列表 / 阅读 */}
        <div className="min-w-0">
          {!selected ? (
            <EmptyState
              icon={Inbox}
              title="选择一个邮箱"
              description="在左侧选择邮箱查看邮件。"
            />
          ) : view === "message" && opened ? (
            <MailMessageView
              mailbox={selected}
              message={opened}
              loadingBody={loadingBody}
              deleting={deletingId === opened.id}
              onBack={() => {
                setView("list")
                void loadMessages(selected.id)
              }}
              onMarkUnread={() => void handleMarkUnread()}
              onDelete={() => void handleDeleteMessage(opened.id)}
              onReply={handleReply}
            />
          ) : (
            <div className="overflow-hidden rounded-lg border bg-card">
              <div className="flex items-center justify-between border-b px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <Inbox className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">{selected.address}</span>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => void loadMessages(selected.id)}
                  aria-label="刷新"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="max-h-[560px] overflow-y-auto">
                {loadingMessages ? (
                  <LoadingBlock />
                ) : messages.length === 0 ? (
                  <EmptyState
                    icon={Inbox}
                    title="收件箱是空的"
                    description={`发往 ${selected.address} 的邮件会出现在这里。`}
                  />
                ) : (
                  messages.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => void handleOpenMessage(m)}
                      className={cn(
                        "flex w-full items-center gap-3 border-b px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-accent/50",
                        opened?.id === m.id && "bg-accent/60"
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              "truncate text-sm",
                              !m.read ? "font-semibold" : "text-muted-foreground"
                            )}
                          >
                            {m.from || "未知发件人"}
                          </span>
                          {!m.read && (
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-foreground" />
                          )}
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {m.subject}
                        </p>
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {fmtMailTime(m.receivedAt)}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 添加邮箱 */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加邮箱</DialogTitle>
            <DialogDescription>
              例如 hello、contact，用于接收站内邮件。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="localPart">邮箱前缀</Label>
            <div className="flex items-center gap-1">
              <Input
                id="localPart"
                placeholder="hello"
                value={localPart}
                onChange={(e) => setLocalPart(e.target.value)}
                className="flex-1"
              />
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                @doulor.cn
              </span>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void handleAddMailbox()} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              添加
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 转发设置（每个邮箱独立） */}
      <Dialog
        open={forwardBox !== null}
        onOpenChange={(open) => {
          if (!open) setForwardBox(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>转发设置</DialogTitle>
            <DialogDescription>
              {forwardBox?.address} 收到的邮件会转发到以下地址，留空则不转发。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="forwardInput">转发目标</Label>
            <Input
              id="forwardInput"
              placeholder="you@example.com"
              value={forwardInput}
              onChange={(e) => setForwardInput(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              多个地址用逗号分隔，最多 3 个
            </p>
            {forwardBox && forwardBox.forwardingTo.length > 0 && (
              <div className="space-y-1 rounded-md border px-3 py-2">
                {forwardBox.forwardingTo.map((email, i) => {
                  const state = forwardBox.forwardingVerified?.[i]
                  return (
                    <div
                      key={email}
                      className="flex items-center justify-between text-xs"
                    >
                      <span className="truncate font-mono">{email}</span>
                      {state === true ? (
                        <span className="shrink-0 text-emerald-600 dark:text-emerald-400">
                          已验证
                        </span>
                      ) : state === false ? (
                        <span className="shrink-0 text-amber-600 dark:text-amber-400">
                          待验证
                        </span>
                      ) : (
                        <span className="shrink-0 text-muted-foreground">
                          状态未知
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
            {forwardBox?.lastForwardError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2">
                <p className="text-xs font-medium text-destructive">
                  最近一次转发失败
                </p>
                <p className="mt-0.5 break-words text-xs text-muted-foreground">
                  {forwardBox.lastForwardError}
                </p>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              转发目标需要先验证：保存后请到该邮箱点击 Cloudflare
              发来的确认链接，验证通过后才会开始转发。
            </p>

            {/* 转发进垃圾箱的说明：这是用户最常反馈的问题 */}
            <div className="flex gap-2 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="space-y-1">
                <p className="font-medium text-foreground">
                  收不到转发邮件？请先检查垃圾邮件文件夹
                </p>
                <p>
                  转发属于「二次投递」，对方邮箱（尤其 QQ / 163 / Gmail）
                  容易判为垃圾邮件。请到垃圾箱找一下，并把发件人标记为
                  「非垃圾邮件」或加入白名单，之后就会正常进入收件箱。
                </p>
                <p>
                  若长期收不到，建议改用支持自动转发的邮箱（如 Gmail），
                  或在此处改填其他邮箱。
                </p>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setForwardBox(null)}>
              取消
            </Button>
            <Button onClick={() => void handleSaveForwarding()} disabled={savingForward}>
              {savingForward && <Loader2 className="h-4 w-4 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function MailMessageView({
  mailbox,
  message,
  loadingBody,
  deleting,
  onBack,
  onMarkUnread,
  onDelete,
  onReply,
}: {
  mailbox: Mailbox
  message: MailMessage
  loadingBody: boolean
  deleting: boolean
  onBack: () => void
  onMarkUnread: () => void
  onDelete: () => void
  onReply: (text: string) => Promise<void>
}) {
  const [replyOpen, setReplyOpen] = React.useState(false)
  const [replyText, setReplyText] = React.useState("")
  const [sending, setSending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  /**
   * 免付费的「回信」替代路径：用本机邮件客户端回复（mailto）。
   *
   * 为什么需要：网页直接发信必须先完成 Cloudflare Email Sending 域名 Onboard，
   * 而那是**付费**功能。没 Onboard 时，直接发送只能发到账户内"已验证的收件地址"，
   * 给任意外部来信人回信必然失败 —— 与其让用户每次都撞一次错误，
   * 不如给一个立刻能用的出口：点一下就把收件人/主题/原文引用填进本机邮箱，
   * 在那边点发送（发件人是用户自己的真实邮箱）。
   *
   * 原文引用截断到 ~1200 字：mailto 的 URL 长度在部分客户端有限制。
   */
  const replyToAddress = React.useMemo(() => {
    const angled = /<([^>]+)>/.exec(message.from ?? "")
    const candidate = (angled ? angled[1] : (message.from ?? "")).trim()
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : ""
  }, [message.from])

  const mailtoHref = React.useMemo(() => {
    if (!replyToAddress) return ""
    const subject = /^re\s*:/i.test(message.subject ?? "")
      ? message.subject
      : `Re: ${message.subject || "(无主题)"}`
    const quoted = (message.body ?? "").slice(0, 1200)
    const body = quoted
      ? `\n\n---------- 原邮件 ----------\n来自：${message.from}\n\n${quoted}`
      : ""
    return `mailto:${replyToAddress}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  }, [replyToAddress, message.subject, message.body, message.from])

  const handleSend = async () => {
    const text = replyText.trim()
    if (!text || sending) return
    setSending(true)
    setError(null)
    try {
      await onReply(text)
      // 成功后收起并清空：邮件已经发出，留着草稿会让人以为还没发
      setReplyText("")
      setReplyOpen(false)
    } catch (err) {
      // 保留正文，让用户可以改完重试（例如先去 Onboard 再回来点一次）
      setError(err instanceof HttpError ? err.message : "发送失败，请稍后重试")
    } finally {
      setSending(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <CardTitle className="text-base leading-snug">
              {message.subject || "无主题"}
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              来自 {message.from || "未知发件人"} · 发往 {mailbox.address} ·{" "}
              {new Date(message.receivedAt).toLocaleString("zh-CN")}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onBack}>
            返回列表
          </Button>
        </div>
      </CardHeader>
      <div className="flex items-center gap-2 px-6 pb-4">
        <Button
          variant={replyOpen ? "secondary" : "outline"}
          size="sm"
          onClick={() => setReplyOpen((v) => !v)}
        >
          <Reply className="h-3.5 w-3.5" />
          回信
        </Button>
        <Button variant="outline" size="sm" onClick={onMarkUnread}>
          <Mail className="h-3.5 w-3.5" />
          标为未读
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="text-muted-foreground hover:text-destructive"
          onClick={onDelete}
          disabled={deleting}
        >
          {deleting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
          删除
        </Button>
      </div>
      <CardContent className="space-y-4">
        {loadingBody ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在加载正文…
          </div>
        ) : (
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
            {message.body || "（无正文内容）"}
          </pre>
        )}

        {replyOpen && (
          <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <div className="flex items-center gap-2">
                <Reply className="h-3.5 w-3.5" />
                以 <span className="font-medium text-foreground">{mailbox.address}</span> 发送
                {message.from ? <> 给 <span className="font-medium text-foreground">{message.from}</span></> : null}
              </div>
              {mailtoHref && (
                <Button asChild variant="outline" size="sm">
                  <a href={mailtoHref}>改用我的邮箱回复</a>
                </Button>
              )}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              下面的「发送」需要 Cloudflare 完成 Email Sending 域名 Onboard（付费功能）才能发给任意外部邮箱；
              未开通时只能发往账户内已验证的收件地址。发不出去就点上面的
              <span className="font-medium text-foreground">「改用我的邮箱回复」</span>
              —— 免费、立刻可用（会在你本机邮箱里打开，收件人与原文已填好）。
            </p>
            <Textarea
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder="输入回信内容（纯文本）…"
              rows={6}
              maxLength={20000}
              disabled={sending}
              className="resize-y bg-background"
            />
            {error && (
              <p className="flex items-start gap-2 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{error}</span>
              </p>
            )}
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground tabular-nums">
                {replyText.length} / 20000
              </span>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setReplyOpen(false)
                    setError(null)
                  }}
                  disabled={sending}
                >
                  收起
                </Button>
                <Button size="sm" onClick={() => void handleSend()} disabled={sending || !replyText.trim()}>
                  {sending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="h-3.5 w-3.5" />
                  )}
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