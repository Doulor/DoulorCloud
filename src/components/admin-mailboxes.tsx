/**
 * 邮箱管理（管理面板 → DNS 管理页的「邮箱管理」tab）。
 *
 * 形态与「子域名管理」一致：搜索 + 分页表格 + 代建 / 改名 / 删除弹窗；
 * 额外提供**查看内容**（邮件列表 + 正文）—— 排查滥用时最关键的一步。
 *
 * 与用户侧邮箱页的差异（都是有意为之，后端同名注释有完整理由）：
 *   · 跨用户、可改地址（前缀 / 域）、转发目标免验证、不占用户 3 个名额、可删主邮箱；
 *   · 看邮件**不会**把邮件标成已读（不篡改用户的未读状态）。
 */
import * as React from "react"
import { toast } from "sonner"
import {
  CheckCircle2,
  ChevronLeft,
  Loader2,
  Mail,
  MailOpen,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { EmptyState } from "@/components/empty-state"
import { LoadingBlock } from "@/components/loading-block"
import { adminMailboxesApi, errMsg } from "@/services/api"
import { fmtDateTime } from "@/lib/format"
import type {
  AdminMailbox,
  AdminMailboxListResponse,
  AdminMailboxMessage,
  AdminMailboxMessageDetail,
} from "@/types"
import { useT } from "@/i18n"

interface OwnerOption {
  id: string
  username: string
  email: string
  status: string
}

export function AdminMailboxes() {
  const { t } = useT()
  const [q, setQ] = React.useState("")
  const [page, setPage] = React.useState(1)
  const [data, setData] = React.useState<AdminMailboxListResponse | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  const [createOpen, setCreateOpen] = React.useState(false)
  const [editTarget, setEditTarget] = React.useState<AdminMailbox | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<AdminMailbox | null>(null)
  const [viewTarget, setViewTarget] = React.useState<AdminMailbox | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      setData(await adminMailboxesApi.list({ q: q.trim() || undefined, page }))
    } catch (err) {
      toast.error(errMsg(err, t("dns.mb.loadFailed")))
    } finally {
      setLoading(false)
    }
  }, [q, page, t])

  React.useEffect(() => {
    void load()
  }, [load])

  const pageCount = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1

  const submitDelete = async () => {
    if (!deleteTarget) return
    setBusy(true)
    try {
      await adminMailboxesApi.remove(deleteTarget.id)
      toast.success(t("dns.mb.delete.done", { address: deleteTarget.address }))
      setDeleteTarget(null)
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("dns.mb.delete.failed")))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setPage(1)
          }}
          placeholder={t("dns.mb.search")}
          className="h-8 w-64"
        />
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1.5 h-4 w-4" />
          {t("dns.mb.new")}
        </Button>
        <Button size="sm" variant="ghost" disabled={loading} onClick={() => void load()}>
          <RefreshCw className={`mr-1.5 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          {t("common.refresh")}
        </Button>
        {data && (
          <span className="text-xs text-muted-foreground">
            {t("dns.mb.total", { n: String(data.total) })}
          </span>
        )}
      </div>

      {loading && !data ? (
        <LoadingBlock variant="table" />
      ) : !data || data.mailboxes.length === 0 ? (
        <EmptyState title={t("dns.mb.empty.title")} description={t("dns.mb.empty.desc")} />
      ) : (
        <div className="rounded-lg border bg-card">
          <Table wrapperClassName="overflow-x-auto">
            <TableHeader>
              <TableRow>
                <TableHead>{t("dns.mb.col.address")}</TableHead>
                <TableHead>{t("dns.mb.col.owner")}</TableHead>
                <TableHead className="w-40">{t("dns.mb.col.forward")}</TableHead>
                <TableHead className="w-24 text-right">{t("dns.mb.col.messages")}</TableHead>
                <TableHead className="w-36">{t("dns.mb.col.created")}</TableHead>
                <TableHead className="w-52 text-right">{t("dns.col.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.mailboxes.map((mb) => (
                <TableRow key={mb.id}>
                  <TableCell className="align-top">
                    <div className="font-mono text-xs break-all">{mb.address}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {mb.primary && (
                        <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                          {t("dns.mb.primary")}
                        </Badge>
                      )}
                      {mb.isTemp && (
                        <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                          {t("dns.mb.temp")}
                        </Badge>
                      )}
                      {mb.source !== "web" && (
                        <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                          {mb.source === "admin" ? t("dns.mb.srcAdmin") : t("dns.mb.srcApi")}
                        </Badge>
                      )}
                      {mb.owner.status !== "active" && (
                        <Badge
                          variant="outline"
                          className="h-5 border-destructive/40 px-1.5 text-[10px] text-destructive"
                        >
                          {mb.owner.status}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="align-top text-xs">
                    <div className="font-medium">{mb.owner.username}</div>
                    <div className="text-muted-foreground">{mb.owner.email}</div>
                  </TableCell>
                  <TableCell className="align-top text-xs">
                    {mb.forwardingTo.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <div className="space-y-0.5">
                        {mb.forwardingTo.map((f) => (
                          <div key={f.email} className="flex flex-wrap items-center gap-1">
                            <span className="font-mono break-all">{f.email}</span>
                            {f.verified ? (
                              <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" />
                            ) : (
                              <span className="shrink-0 text-amber-600 dark:text-amber-400">
                                {t("dns.mb.forwardUnverified")}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="align-top text-right text-xs tabular-nums">
                    {mb.messageCount}
                    {mb.unreadCount > 0 && (
                      <span className="ml-1 text-amber-600 dark:text-amber-400">
                        ({t("dns.mb.unread", { n: String(mb.unreadCount) })})
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="align-top text-xs text-muted-foreground">
                    {fmtDateTime(mb.createdAt)}
                  </TableCell>
                  <TableCell className="align-top">
                    <div className="flex flex-wrap items-center justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={() => setViewTarget(mb)}
                      >
                        <MailOpen className="mr-1 h-3.5 w-3.5" />
                        {t("dns.mb.viewBtn")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={() => setEditTarget(mb)}
                      >
                        <Pencil className="mr-1 h-3.5 w-3.5" />
                        {t("dns.mb.editBtn")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs text-destructive"
                        onClick={() => setDeleteTarget(mb)}
                      >
                        <Trash2 className="mr-1 h-3.5 w-3.5" />
                        {t("common.delete")}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {data && data.total > data.pageSize && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {t("dns.pageInfo", {
              total: String(data.total),
              page: String(data.page),
              pages: String(pageCount),
            })}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              {t("common.back")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= pageCount}
              onClick={() => setPage((p) => p + 1)}
            >
              {t("common.next")}
            </Button>
          </div>
        </div>
      )}

      {/* ---- 代建邮箱 ---- */}
      <MailboxCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        rootDomains={data?.rootDomains ?? []}
        onDone={() => void load()}
      />

      {/* ---- 改名 / 转发 ---- */}
      <MailboxEditDialog
        target={editTarget}
        onClose={() => setEditTarget(null)}
        rootDomains={data?.rootDomains ?? []}
        onDone={() => void load()}
      />

      {/* ---- 删除确认 ---- */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null)
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("dns.mb.delete.title")}</DialogTitle>
            <DialogDescription>{t("dns.mb.delete.desc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p className="font-mono break-all">{deleteTarget?.address}</p>
            <p className="text-xs text-muted-foreground">
              {t("dns.mb.delete.owner", { username: deleteTarget?.owner.username ?? "" })} ·{" "}
              {t("dns.mb.delete.count", { n: String(deleteTarget?.messageCount ?? 0) })}
            </p>
            {deleteTarget?.primary && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                {t("dns.mb.delete.primaryWarn")}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void submitDelete()}>
              {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- 查看内容 ---- */}
      <MailboxMessagesDialog target={viewTarget} onClose={() => setViewTarget(null)} />
    </div>
  )
}

/** 归属用户选择器（与子域名管理的同一套交互：输入即搜、点选） */
function OwnerPicker({
  selected,
  onSelect,
}: {
  selected: OwnerOption | null
  onSelect: (o: OwnerOption | null) => void
}) {
  const { t } = useT()
  const [query, setQuery] = React.useState("")
  const [options, setOptions] = React.useState<OwnerOption[]>([])
  const [searching, setSearching] = React.useState(false)

  React.useEffect(() => {
    const term = query.trim()
    if (!term) {
      setOptions([])
      return
    }
    let cancelled = false
    setSearching(true)
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await adminMailboxesApi.searchOwners(term)
          if (!cancelled) setOptions(res.owners)
        } catch {
          if (!cancelled) setOptions([])
        } finally {
          if (!cancelled) setSearching(false)
        }
      })()
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
      setSearching(false)
    }
  }, [query])

  return (
    <div className="space-y-1.5">
      <Label htmlFor="mb-owner">{t("dns.mb.owner")}</Label>
      <Input
        id="mb-owner"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("dns.sub.ownerSearch")}
      />
      {selected && (
        <p className="flex flex-wrap items-center gap-1.5 text-xs">
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
          <span className="font-medium">{selected.username}</span>
          <span className="text-muted-foreground">{selected.email}</span>
          <button
            type="button"
            className="text-muted-foreground underline"
            onClick={() => onSelect(null)}
          >
            {t("dns.sub.ownerClear")}
          </button>
        </p>
      )}
      <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-1">
        {searching ? (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">
            <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
            {t("dns.sub.ownerSearching")}
          </p>
        ) : options.length === 0 ? (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">
            {query.trim() ? t("dns.sub.ownerNoResult") : t("dns.sub.ownerHint")}
          </p>
        ) : (
          options.map((o) => (
            <button
              key={o.id}
              type="button"
              className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs hover:bg-muted ${
                o.id === selected?.id ? "bg-muted" : ""
              }`}
              onClick={() => onSelect(o)}
            >
              <span className="font-medium">{o.username}</span>
              <span className="text-muted-foreground">{o.email}</span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}

/** 代建邮箱：选归属用户 + 前缀 + 根域 */
function MailboxCreateDialog({
  open,
  onOpenChange,
  rootDomains,
  onDone,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  rootDomains: { name: string; label: string }[]
  onDone: () => void
}) {
  const { t } = useT()
  const [owner, setOwner] = React.useState<OwnerOption | null>(null)
  const [localPart, setLocalPart] = React.useState("")
  const [domain, setDomain] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (open) {
      setOwner(null)
      setLocalPart("")
      setDomain(rootDomains[0]?.name ?? "")
    }
  }, [open, rootDomains])

  const submit = async () => {
    if (!owner || !localPart.trim() || !domain) return
    setBusy(true)
    try {
      const res = await adminMailboxesApi.create({
        userId: owner.id,
        localPart: localPart.trim().toLowerCase(),
        domain,
      })
      toast.success(t("dns.mb.create.done", { address: res.mailbox.address }))
      onOpenChange(false)
      onDone()
    } catch (err) {
      toast.error(errMsg(err, t("dns.mb.create.failed")))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("dns.mb.create.title")}</DialogTitle>
          <DialogDescription>{t("dns.mb.create.desc")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <OwnerPicker selected={owner} onSelect={setOwner} />
          <div className="space-y-1.5">
            <Label htmlFor="mb-local">{t("dns.mb.create.local")}</Label>
            <Input
              id="mb-local"
              value={localPart}
              onChange={(e) => setLocalPart(e.target.value)}
              className="font-mono text-xs"
              placeholder="hello"
            />
            <p className="text-[11px] text-muted-foreground">{t("dns.mb.create.localHint")}</p>
          </div>
          {rootDomains.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="mb-domain">{t("dns.mb.create.root")}</Label>
              <Select value={domain} onValueChange={setDomain}>
                <SelectTrigger id="mb-domain">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {rootDomains.map((r) => (
                    <SelectItem key={r.name} value={r.name}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {owner && localPart.trim() && domain && (
            <p className="font-mono text-xs">
              {t("dns.sub.create.preview")}：
              <span className="font-medium">
                {localPart.trim().toLowerCase()}@{domain}
              </span>
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={busy || !owner || !localPart.trim() || !domain}
            onClick={() => void submit()}
          >
            {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {t("common.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 改名（前缀 / 域）与转发目标 */
function MailboxEditDialog({
  target,
  onClose,
  rootDomains,
  onDone,
}: {
  target: AdminMailbox | null
  onClose: () => void
  rootDomains: { name: string; label: string }[]
  onDone: () => void
}) {
  const { t } = useT()
  const [localPart, setLocalPart] = React.useState("")
  const [domain, setDomain] = React.useState("")
  const [forward, setForward] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (target) {
      const at = target.address.lastIndexOf("@")
      setLocalPart(target.address.slice(0, at))
      setDomain(target.address.slice(at + 1))
      setForward(target.forwardingTo.map((f) => f.email).join("\n"))
    }
  }, [target])

  if (!target) return null

  const submit = async () => {
    setBusy(true)
    try {
      // 每行一个目标；空 = 清空转发（与用户侧「空数组 = 不转发」一致）
      const targets = forward
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean)
      const res = await adminMailboxesApi.update(target.id, {
        localPart: localPart.trim().toLowerCase(),
        domain,
        forwardingTo: targets,
      })
      toast.success(t("dns.mb.edit.done", { address: res.mailbox.address }))
      onClose()
      onDone()
    } catch (err) {
      toast.error(errMsg(err, t("dns.mb.edit.failed")))
    } finally {
      setBusy(false)
    }
  }

  const nextAddress = `${localPart.trim().toLowerCase()}@${domain}`

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("dns.mb.edit.title")}</DialogTitle>
          <DialogDescription className="font-mono text-xs">{target.address}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="mb-edit-local">{t("dns.mb.create.local")}</Label>
            <Input
              id="mb-edit-local"
              value={localPart}
              onChange={(e) => setLocalPart(e.target.value)}
              className="font-mono text-xs"
            />
          </div>
          {rootDomains.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="mb-edit-domain">{t("dns.mb.create.root")}</Label>
              <Select value={domain} onValueChange={setDomain}>
                <SelectTrigger id="mb-edit-domain">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {rootDomains.map((r) => (
                    <SelectItem key={r.name} value={r.name}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {nextAddress.toLowerCase() !== target.address.toLowerCase() && (
            <>
              <p className="font-mono text-xs">
                {t("dns.sub.create.preview")}：<span className="font-medium">{nextAddress}</span>
              </p>
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-600">
                {t("dns.mb.edit.renameWarn")}
              </p>
            </>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="mb-edit-forward">{t("dns.mb.edit.forward")}</Label>
            <textarea
              id="mb-edit-forward"
              value={forward}
              onChange={(e) => setForward(e.target.value)}
              rows={3}
              className="w-full rounded-md border bg-transparent px-3 py-2 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder={t("dns.mb.edit.forwardPlaceholder")}
            />
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-600">
              {t("dns.mb.edit.forwardWarn")}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={busy || !localPart.trim()} onClick={() => void submit()}>
            {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 查看邮箱内容：邮件列表（游标翻页）+ 单封正文。
 *
 * ⚠️ 后端只读不写 —— 这里看到的是「用户视角的原文」，不会因为站长点开而变成已读。
 */
function MailboxMessagesDialog({
  target,
  onClose,
}: {
  target: AdminMailbox | null
  onClose: () => void
}) {
  const { t } = useT()
  const [messages, setMessages] = React.useState<AdminMailboxMessage[]>([])
  const [cursor, setCursor] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [detail, setDetail] = React.useState<AdminMailboxMessageDetail | null>(null)
  const [detailLoading, setDetailLoading] = React.useState(false)

  const load = React.useCallback(
    async (nextCursor?: string) => {
      if (!target) return
      setLoading(true)
      try {
        const res = await adminMailboxesApi.messages(target.id, { cursor: nextCursor })
        setMessages((prev) => (nextCursor ? [...prev, ...res.messages] : res.messages))
        setCursor(res.nextCursor)
      } catch (err) {
        toast.error(errMsg(err, t("dns.mb.msg.loadFailed")))
      } finally {
        setLoading(false)
      }
    },
    [target, t]
  )

  React.useEffect(() => {
    if (target) {
      setMessages([])
      setCursor(null)
      setDetail(null)
      void load()
    }
  }, [target, load])

  const openMessage = async (m: AdminMailboxMessage) => {
    if (!target) return
    setDetailLoading(true)
    try {
      const res = await adminMailboxesApi.message(target.id, m.id)
      setDetail(res.message)
    } catch (err) {
      toast.error(errMsg(err, t("dns.mb.msg.detailFailed")))
    } finally {
      setDetailLoading(false)
    }
  }

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-4 w-4" />
            {t("dns.mb.msg.title")}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs break-all">
            {target?.address}
            {target ? ` · ${target.owner.username}` : ""}
          </DialogDescription>
        </DialogHeader>

        {detail ? (
          <div className="space-y-3">
            <Button size="sm" variant="ghost" onClick={() => setDetail(null)}>
              <ChevronLeft className="mr-1 h-3.5 w-3.5" />
              {t("dns.mb.msg.back")}
            </Button>
            <div className="space-y-1">
              <p className="text-sm font-medium break-all">{detail.subject || t("dns.mb.msg.noSubject")}</p>
              <p className="text-xs text-muted-foreground">
                {detail.fromAddress} · {fmtDateTime(detail.receivedAt)}
                {!detail.read && (
                  <span className="ml-2 text-amber-600 dark:text-amber-400">
                    {t("dns.mb.msg.unreadTag")}
                  </span>
                )}
              </p>
            </div>
            <pre className="max-h-[50vh] overflow-auto rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap">
              {detail.textBody || t("dns.mb.msg.emptyBody")}
            </pre>
            <p className="text-[11px] text-muted-foreground">{t("dns.mb.msg.readNote")}</p>
          </div>
        ) : loading && messages.length === 0 ? (
          <LoadingBlock />
        ) : messages.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t("dns.mb.msg.empty")}</p>
        ) : (
          <div className="space-y-1">
            {messages.map((m) => (
              <button
                key={m.id}
                type="button"
                className="flex w-full items-start gap-2 rounded-md border p-2 text-left transition-colors hover:bg-accent/40"
                onClick={() => void openMessage(m)}
              >
                {m.read ? (
                  <MailOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="truncate text-xs font-medium">
                      {m.subject || t("dns.mb.msg.noSubject")}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {fmtDateTime(m.receivedAt)}
                    </span>
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {m.fromAddress}
                  </span>
                </span>
              </button>
            ))}
            {cursor && (
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                disabled={loading}
                onClick={() => void load(cursor)}
              >
                {loading && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                {t("dns.mb.msg.more")}
              </Button>
            )}
          </div>
        )}

        {detailLoading && (
          <p className="text-center text-xs text-muted-foreground">
            <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
            {t("common.loading")}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
