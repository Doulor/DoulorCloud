import * as React from "react"
import { AlertTriangle, Inbox, Loader2, Mail, Plus, RotateCcw, Settings, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { LoadingBlock } from "@/components/loading-block"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
import { emailApi, HttpError } from "@/services/api"
import type { Mailbox, MailMessage } from "@/types"

const MAX_MAILBOXES = 3

function fmtTime(iso: string) {
  const d = new Date(iso)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  if (sameDay) {
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
  }
  return d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })
}

type View = "list" | "message"

export default function EmailPage() {
  const [mailboxes, setMailboxes] = React.useState<Mailbox[]>([])
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
      const target =
        res.mailboxes.find((m) => m.id === selectId) ??
        res.mailboxes.find((m) => m.primary) ??
        res.mailboxes[0] ??
        null
      setSelected(target)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "加载邮箱失败")
    } finally {
      setLoadingMailboxes(false)
    }
  }, [])

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

  const canAdd = mailboxes.length < MAX_MAILBOXES

  return (
    <div>
      <PageHeader
        title="邮箱"
        description={`${mailboxes.length} / ${MAX_MAILBOXES} 个地址`}
        actions={
          <Button onClick={() => setAddOpen(true)} disabled={!canAdd}>
            <Plus className="h-4 w-4" />
            添加邮箱
          </Button>
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
                        {fmtTime(m.receivedAt)}
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
}: {
  mailbox: Mailbox
  message: MailMessage
  loadingBody: boolean
  deleting: boolean
  onBack: () => void
  onMarkUnread: () => void
  onDelete: () => void
}) {
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
      <CardContent>
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
      </CardContent>
    </Card>
  )
}