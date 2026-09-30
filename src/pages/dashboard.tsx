import * as React from "react"
import { Link } from "react-router-dom"
import {
  Mail,
  ArrowRight,
  HardDrive,
  Sparkles,
  Contact,
  Megaphone,
  Copy,
  Check,
  ExternalLink,
  Inbox,
  Network,
  Globe,
  Plus,
  Upload,
  Zap,
  History,
  GripVertical,
  Pencil,
  RotateCcw,
} from "lucide-react"
import { toast } from "sonner"
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import type { DragOverEvent, DragStartEvent } from "@dnd-kit/core"
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"

import { PageHeader } from "@/components/page-header"
import { DataFade } from "@/components/data-fade"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Markdown } from "@/components/markdown"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { formatBytesShort } from "@/lib/format"
import { authApi, newapiApi, profileApi, announcementApi, errMsg, HttpError } from "@/services/api"
import { useAuth } from "@/hooks/use-auth"
import { useT, tStatic } from "@/i18n"
import type {
  Announcement,
  MeResponse,
  NewApiStatus,
  ProfileOverview,
} from "@/types"

const NEWAPI_BASE_URL = "https://api.doulor.cn/v1"

function useCopy() {
  const { t } = useT()
  const [copied, setCopied] = React.useState<string | null>(null)
  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(label)
      toast.success(t("dash.copy.copied", { label }))
      setTimeout(() => setCopied(null), 1500)
    } catch {
      toast.error(t("dash.copy.failed"))
    }
  }
  return { copied, copy }
}

/** AI 中转站详情卡：额度 + Base URL + Key 列表 */
function AiCard() {
  const { t } = useT()
  const [status, setStatus] = React.useState<NewApiStatus | null>(null)
  const [loading, setLoading] = React.useState(true)
  const { copied, copy } = useCopy()

  React.useEffect(() => {
    let cancelled = false
    newapiApi
      .status()
      .then((res: NewApiStatus) => !cancelled && setStatus(res))
      .catch((err) => {
        if (cancelled) return
        // 无权限（未解锁 AI 中转站）是新用户的正常状态，静默显示「未绑定」，不弹错误
        if (err instanceof HttpError && err.code === "FEATURE_NOT_PERMITTED") {
          return
        }
        toast.error(errMsg(err, t("dash.err.aiStatus")))
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  const acc = status?.account
  const symbol = status?.currencySymbol ?? "¥"
  const remaining = acc ? (acc.quotaUsd ?? 0) - (acc.usedUsd ?? 0) : 0

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            {t("dash.ai.card")}
          </CardTitle>
          <CardDescription>
            {loading ? t("common.loading") : acc ? t("dash.ai.bound") : t("dash.ai.unbound")}
          </CardDescription>
        </div>
        <Button variant="ghost" size="sm" asChild>
          <Link to="/dashboard/ai">
            {t("dash.manage")}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <DataFade loading={loading} skeleton={<Skeleton className="h-20 w-full" />}>
        {!acc ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            {t("dash.ai.notBound")}
          </p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2 rounded-md border p-3 text-center">
              <div>
                <p className="text-xs text-muted-foreground">{t("dash.remaining")}</p>
                <p className="text-sm font-semibold">
                  {symbol}
                  {remaining.toFixed(4)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t("dash.used")}</p>
                <p className="text-sm font-semibold">
                  {symbol}
                  {(acc.usedUsd ?? 0).toFixed(4)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t("dash.requests")}</p>
                <p className="text-sm font-semibold">{acc.requestCount ?? 0}</p>
              </div>
            </div>
            {status?.subscription ? (
              <div className="rounded-md border p-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{t("dash.sub.freeToday")}</span>
                  <span className="font-medium">
                    {symbol}
                    {(
                      (status.subscription.amountTotal -
                        status.subscription.amountUsed) /
                      500000
                    ).toFixed(2)}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{
                      width: `${Math.min(
                        100,
                        Math.max(
                          0,
                          ((status.subscription.amountTotal -
                            status.subscription.amountUsed) /
                            status.subscription.amountTotal) *
                            100
                        )
                      )}%`,
                    }}
                  />
                </div>
              </div>
            ) : (
              <div className="rounded-md border p-3 text-xs text-muted-foreground">
                {t("dash.sub.notClaimed")}
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0"
                  asChild
                >
                  <Link to="/dashboard/ai">{t("dash.sub.claim")}</Link>
                </Button>
              </div>
            )}
            <div className="flex items-center gap-2 rounded-md border px-3 py-2">
              <span className="text-xs text-muted-foreground">Base URL</span>
              <code className="flex-1 truncate font-mono text-xs">{NEWAPI_BASE_URL}</code>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => void copy(NEWAPI_BASE_URL, "Base URL")}
                aria-label={t("dash.ai.copyBaseUrl")}
              >
                {copied === "Base URL" ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary">{t("dash.ai.models", { n: status?.models.length ?? 0 })}</Badge>
              {status?.accountGroup && (
                <Badge variant="outline">{status.accountGroup}</Badge>
              )}
            </div>
          </>
        )}</DataFade>
      </CardContent>
    </Card>
  )
}

/** 名片预览卡：头像 + 昵称 + 签名 + 查看按钮 */
function ProfileCard({ compact = false }: { compact?: boolean }) {
  const { t } = useT()
  const [data, setData] = React.useState<ProfileOverview | null>(null)
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    let cancelled = false
    profileApi
      .get()
      .then((res) => !cancelled && setData(res))
      .catch((err) => {
        if (!cancelled) toast.error(errMsg(err, t("dash.err.profile")))
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  const p = data?.profile
  const publicUrl = p?.fqdn ? `https://${p.fqdn}` : `${window.location.origin}${p?.profilePath ?? ""}`

  return (
    <Card className={compact ? "flex flex-1 flex-col overflow-hidden" : ""}>
      <CardHeader className={`flex flex-row items-center justify-between ${compact ? "py-3" : ""}`}>
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Contact className="h-4 w-4 text-muted-foreground" />
            {t("dash.profile.card")}
          </CardTitle>
          <CardDescription>
            {loading ? t("common.loading") : p ? t("dash.profile.subtitle") : t("dash.notOpened")}
          </CardDescription>
        </div>
        {p && (
          <Button variant="ghost" size="sm" asChild>
            <a href={publicUrl} target="_blank" rel="noopener noreferrer">
              {t("dash.view")}
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </Button>
        )}
      </CardHeader>
      <CardContent className={compact ? "min-h-0 flex-1 flex flex-col justify-center" : ""}>
        <DataFade loading={loading} skeleton={<Skeleton className="h-20 w-full" />}>
        {!p ? (
          <div className="space-y-3">
            <p className="py-2 text-center text-sm text-muted-foreground">
              {t("dash.profile.empty")}
            </p>
            <Button asChild size="sm" variant="outline" className="w-full">
              <Link to="/dashboard/profile">{t("dash.profile.open")}</Link>
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <img
              src={p.avatarKey ? `/api/profile/asset?kind=avatar` : p.avatarUrl ?? ""}
              alt={p.displayName ?? ""}
              className="h-12 w-12 rounded-full border object-cover"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {p.displayName ?? t("dash.profile.noNickname")}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {p.bio || t("dash.profile.noBio")}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => void navigator.clipboard.writeText(publicUrl).then(() => toast.success(t("dash.profile.linkCopied")))}
              aria-label={t("dash.profile.copyLink")}
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}</DataFade>
      </CardContent>
    </Card>
  )
}

/** 最近邮件卡：标题点击跳转正文 + 右侧未读数 */
function RecentMailCard({
  data,
  loading,
  compact = false,
}: {
  data: MeResponse | null
  loading: boolean
  compact?: boolean
}) {
  const { t } = useT()
  const unread = data?.stats?.unread ?? 0
  const messages = data?.recentMessages ?? []
  const shown = compact ? messages.slice(0, 3) : messages
  return (
    <Card className={`flex flex-col overflow-hidden ${compact ? "flex-1" : ""}`}>
      <CardHeader className={`flex flex-row items-center justify-between ${compact ? "py-3" : ""}`}>
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Mail className="h-4 w-4 text-muted-foreground" />
            {t("dash.mail.card")}
          </CardTitle>
          <CardDescription>{t("dash.mail.desc")}</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {unread > 0 && (
            <Badge variant="success" className="gap-1">
              <Inbox className="h-3 w-3" />
              {t("dash.mail.unread", { n: unread })}
            </Badge>
          )}
          <Button variant="ghost" size="sm" asChild>
            <Link to="/dashboard/email">
              {t("dash.mail.viewAll")}
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className={compact ? "min-h-0 flex-1 overflow-y-auto" : ""}>
        <DataFade loading={loading} skeleton={<div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>}>
        {shown.length ? (
          <div className="space-y-1">
            {shown.map((m) => (
              <Link
                key={m.id}
                to={`/dashboard/email?mailbox=${encodeURIComponent(m.mailboxId)}&message=${encodeURIComponent(m.id)}`}
                className="flex items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-accent/40"
              >
                <div className="flex min-w-0 items-center gap-2">
                  {!m.read && (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-foreground" />
                  )}
                  <span className="truncate">{m.subject || t("dash.mail.noSubject")}</span>
                </div>
                <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                  {new Date(m.receivedAt).toLocaleString("zh-CN", {
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </Link>
            ))}
          </div>
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t("dash.mail.empty")}
          </p>
        )}</DataFade>
      </CardContent>
    </Card>
  )
}

/** 网盘用量卡：进度条 + 最近文件 */
function StorageCard({ data, loading }: { data: MeResponse | null; loading: boolean }) {
  const { t } = useT()
  const { copied, copy } = useCopy()
  const used = data?.stats?.storageUsedBytes ?? 0
  const quota = data?.stats?.storageQuotaBytes ?? 0
  // 管理员配额为哨兵值（1 PiB）→ 显示「不限」且不画进度条
  const unlimited = quota >= 1024 ** 5
  const enabled = quota > 0
  const pct = quota > 0 ? Math.min((used / quota) * 100, 100) : 0
  const files = data?.recentStorageFiles ?? []

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <HardDrive className="h-4 w-4 text-muted-foreground" />
            {t("dash.storage.card")}
          </CardTitle>
          <CardDescription>
            {loading ? t("common.loading") : enabled ? t("dash.storage.subtitle") : t("dash.notOpened")}
          </CardDescription>
        </div>
        <Button variant="ghost" size="sm" asChild>
          <Link to="/dashboard/storage">
            {t("dash.manage")}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <DataFade loading={loading} skeleton={<Skeleton className="h-20 w-full" />}>
        {!enabled ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            {t("dash.storage.notOpened")}
          </p>
        ) : (
          <>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">{formatBytesShort(used)}</span>
                <span className="text-muted-foreground">
                  / {unlimited ? t("dash.storage.unlimited") : formatBytesShort(quota)}
                </span>
              </div>
              {!unlimited && (
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              )}
            </div>
            {files.length > 0 && (
              <div className="divide-y rounded-md border">
                {files.map((f) => {
                  const dlUrl = `${window.location.origin}/dl/${encodeURIComponent(f.r2Key.split("/")[0] || "")}/${encodeURIComponent(f.filename)}`
                  return (
                    <div
                      key={f.id}
                      className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
                    >
                      <span className="truncate font-mono text-xs">{f.filename}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          {formatBytesShort(f.size)}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => void copy(dlUrl, t("dash.copy.label.direct"))}
                          aria-label={t("dash.storage.copyLink")}
                        >
                          {copied === t("dash.copy.label.direct") ? (
                            <Check className="h-3 w-3" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}</DataFade>
      </CardContent>
    </Card>
  )
}

/**
 * 公告弹窗：根据公告的 popup_mode 决定是否弹、怎么弹。
 *
 * 记忆策略（存 localStorage，不落库）：
 *   - once 模式：关闭后记录「已看过」，不再弹
 *   - every 模式：每次进入都弹，但用户可点「不再显示」永久屏蔽
 * localStorage 键：doulor:ann-seen:<id>（已看/已屏蔽）
 */
function AnnouncementPopup() {
  const { t } = useT()
  const [popup, setPopup] = React.useState<Announcement | null>(null)

  React.useEffect(() => {
    let cancelled = false
    announcementApi
      .list()
      .then((res) => {
        if (cancelled) return
        // 找第一个需要弹的公告
        const target = res.announcements.find((a) => {
          if (a.popupMode === "none") return false
          const seen = localStorage.getItem(`doulor:ann-seen:${a.id}`)
          return !seen
        })
        if (target) setPopup(target)
      })
      .catch(() => {
        /* 弹窗加载失败静默，不影响概览 */
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!popup) return null

  const close = (permanent = false) => {
    if (permanent || popup.popupMode === "once") {
      // 「不再显示」或 once 关闭 → 记录已看，永不再弹
      localStorage.setItem(`doulor:ann-seen:${popup.id}`, "1")
    }
    // every 模式的普通关闭：不记录，下次进入还会弹
    setPopup(null)
  }

  return (
    <Dialog open={true} onOpenChange={(o) => !o && close(false)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{popup.title}</DialogTitle>
        </DialogHeader>
        <div className="announcement-scroll max-h-[60vh] overflow-y-auto pr-3">
          <Markdown>{popup.body}</Markdown>
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          {popup.popupMode === "every" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => close(true)}
              className="text-muted-foreground"
            >
              {t("dash.dialog.hideForever")}
            </Button>
          )}
          <Button onClick={() => close(false)}>{t("dash.dialog.gotIt")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 网站动态卡：公告列表 */
function AnnouncementsCard() {
  const { t } = useT()
  const [items, setItems] = React.useState<Announcement[]>([])
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    let cancelled = false
    announcementApi
      .list()
      .then((res) => !cancelled && setItems(res.announcements))
      .catch((err) => {
        if (!cancelled) toast.error(errMsg(err, t("dash.err.announcements")))
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  const categoryLabel: Record<string, string> = {
    general: t("dash.cat.general"),
    frp: t("dash.cat.frp"),
    ai: t("dash.cat.ai"),
    proxy: t("dash.cat.proxy"),
    storage: t("dash.cat.storage"),
    profile: t("dash.cat.profile"),
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Megaphone className="h-4 w-4 text-muted-foreground" />
            {t("dash.news.card")}
          </CardTitle>
          <CardDescription>{t("dash.news.desc")}</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <DataFade loading={loading} skeleton={<div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>}>
        {items.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t("dash.news.empty")}
          </p>
        ) : (
          <div className="space-y-3">
            {items.map((a) => (
              <div key={a.id} className="space-y-1">
                <div className="flex items-center gap-2">
                  {a.pinned && <Badge variant="success">{t("dash.news.pinned")}</Badge>}
                  <Badge variant="secondary">{categoryLabel[a.category] ?? a.category}</Badge>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {new Date(a.createdAt).toLocaleDateString("zh-CN")}
                  </span>
                </div>
                <p className="text-sm font-medium">{a.title}</p>
                <p className="whitespace-pre-wrap text-xs text-muted-foreground line-clamp-2">
                  {a.body}
                </p>
              </div>
            ))}
          </div>
        )}</DataFade>
      </CardContent>
    </Card>
  )
}

/** 资源快览徽章行：紧凑横排几个核心数字，点击跳转，既是概览也是导航 */
function ResourceBadges({ data, loading }: { data: MeResponse | null; loading: boolean }) {
  const { t } = useT()
  const stats = data?.stats
  const items = [
    { label: t("dash.stat.subdomains"), value: stats?.subdomains ?? 0, icon: Globe, to: "/dashboard/domains" },
    { label: t("dash.stat.unread"), value: stats?.unread ?? 0, icon: Mail, to: "/dashboard/email" },
    { label: "DNS", value: stats?.dnsRecords ?? 0, icon: Network, to: "/dashboard/domains" },
    { label: t("dash.stat.mailboxes"), value: stats?.mailboxes ?? 0, icon: Inbox, to: "/dashboard/email" },
  ]
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map((it) => (
        <Link
          key={it.label}
          to={it.to}
          className="group flex items-center gap-3 rounded-lg border bg-card px-4 py-3 transition-colors hover:bg-accent/40"
        >
          <div className="rounded-md border bg-background p-1.5">
            <it.icon className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            {/* 这里刻意不用 DataFade：它是块级容器，会给这一行平添 2px 高度、顶动下方的标签。
                徽章数字只需一个淡入，直接用动画类。 */}
            {loading ? (
              <Skeleton className="h-5 w-8" />
            ) : (
              <p className="animate-in fade-in duration-300 text-lg font-semibold leading-none tracking-tight">
                {it.value}
              </p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">{it.label}</p>
          </div>
        </Link>
      ))}
    </div>
  )
}

/** 快捷操作入口：常用动作直达 */
function QuickActions() {
  const { t } = useT()
  const actions = [
    { label: t("dash.quick.mail"), icon: Mail, to: "/dashboard/email" },
    { label: t("dash.quick.upload"), icon: Upload, to: "/dashboard/storage" },
    { label: t("dash.quick.domain"), icon: Plus, to: "/dashboard/domains" },
    { label: t("dash.quick.topup"), icon: Zap, to: "/dashboard/ai" },
  ]
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("dash.quick.title")}</CardTitle>
        <CardDescription>{t("dash.quick.desc")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-2">
          {actions.map((a) => (
            <Button key={a.label} asChild variant="outline" size="sm" className="justify-start">
              <Link to={a.to}>
                <a.icon className="h-4 w-4" />
                {a.label}
              </Link>
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

/** 最近活动：audit_logs 的最近操作记录 */
function RecentActivityCard({ data, loading }: { data: MeResponse | null; loading: boolean }) {
  const { t } = useT()
  const items = data?.recentActivity ?? []
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4 text-muted-foreground" />
            {t("dash.activity.card")}
          </CardTitle>
          <CardDescription>{t("dash.activity.desc")}</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <DataFade loading={loading} skeleton={<div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>}>
        {items.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t("dash.activity.empty")}</p>
        ) : (
          <div className="space-y-1">
            {items.map((a) => (
              <div
                key={a.id}
                className="flex items-center justify-between gap-3 rounded-md px-3 py-2 text-sm hover:bg-accent/40"
              >
                <div className="min-w-0 flex-1">
                  <span className="text-muted-foreground">{a.action}</span>
                  {a.detail && (
                    <span className="ml-2 block truncate text-xs text-muted-foreground/70">
                      {a.detail}
                    </span>
                  )}
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {new Date(a.createdAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}
                </span>
              </div>
            ))}
          </div>
        )}</DataFade>
      </CardContent>
    </Card>
  )
}

// ---- 卡片布局（可拖拽自定义）----

/** 可摆放的卡片 id（顺序即默认布局） */
const CARD_IDS = [
  "mail",
  "storage",
  "activity",
  "ai",
  "profile",
  "announcements",
  "quick",
] as const
type CardId = (typeof CARD_IDS)[number]

/**
 * 卡片名。必须是**函数**而不是常量映射：tStatic 在「调用时」读当前语言，
 * 写成模块级常量会在模块加载时被冻结成初始语言，切语言后不跟着变。
 */
function cardLabel(id: CardId): string {
  switch (id) {
    case "mail":
      return tStatic("dash.mail.card")
    case "storage":
      return tStatic("dash.storage.card")
    case "activity":
      return tStatic("dash.activity.card")
    case "ai":
      return tStatic("dash.ai.card")
    case "profile":
      return tStatic("dash.profile.card")
    case "announcements":
      return tStatic("dash.news.card")
    case "quick":
      return tStatic("dash.quick.title")
  }
}

/** 布局：两列各自的卡片顺序 */
interface CardLayout {
  left: CardId[]
  right: CardId[]
}

const DEFAULT_LAYOUT: CardLayout = {
  left: ["mail", "storage", "activity"],
  right: ["ai", "profile", "announcements", "quick"],
}

const LAYOUT_STORAGE_KEY = "doulor-dashboard-layout-v1"

/** 读取本地布局，非法/过期则回退默认（缺卡自动补齐、多卡自动剔除） */
function loadLayout(): CardLayout {
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY)
    if (!raw) return DEFAULT_LAYOUT
    const parsed = JSON.parse(raw) as Partial<CardLayout>
    const valid = (v: unknown): v is CardId[] =>
      Array.isArray(v) && v.every((x) => (CARD_IDS as readonly string[]).includes(String(x)))
    if (!valid(parsed.left) || !valid(parsed.right)) return DEFAULT_LAYOUT

    // 校验：不重复、不遗漏（新版本新增卡片时自动补进右列）
    const seen = new Set([...parsed.left, ...parsed.right])
    const missing = CARD_IDS.filter((c) => !seen.has(c))
    return {
      left: [...new Set(parsed.left)],
      right: [...new Set(parsed.right), ...missing],
    }
  } catch {
    return DEFAULT_LAYOUT
  }
}

function saveLayout(layout: CardLayout): void {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout))
  } catch {
    // 隐私模式下 localStorage 可能不可用，忽略
  }
}

/** 从布局中移除某卡片（用于拖拽时先摘出） */
function withoutCard(layout: CardLayout, id: CardId): CardLayout {
  return {
    left: layout.left.filter((c) => c !== id),
    right: layout.right.filter((c) => c !== id),
  }
}

/** 带排序能力的卡片包装：dnd-kit 的 useSortable 负责让位动画与拖拽状态 */
function SortableCard({
  id,
  editing,
  render,
}: {
  id: CardId
  editing: boolean
  render: (id: CardId) => React.ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id, disabled: !editing })

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        // 被拖的卡片本身让 DragOverlay 接管，原位保留占位（透明）保持空间
        opacity: isDragging ? 0 : 1,
        zIndex: isDragging ? 0 : undefined,
      }}
      className="relative"
    >
      {editing && !isDragging && (
        <div className="absolute -top-2 left-3 z-10 flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-xs shadow-sm">
          <GripVertical className="h-3 w-3 text-muted-foreground" />
          {cardLabel(id)}
        </div>
      )}
      <div
        {...attributes}
        {...listeners}
        className={cn(
          editing && !isDragging && "cursor-grab active:cursor-grabbing"
        )}
      >
        {render(id)}
      </div>
    </div>
  )
}

/** 可放置列：每列是一个 droppable，处理跨列拖拽 */
function SortableColumn({
  col,
  ids,
  editing,
  render,
}: {
  col: "left" | "right"
  ids: CardId[]
  editing: boolean
  render: (id: CardId) => React.ReactNode
}) {
  const { t } = useT()
  const { setNodeRef, isOver } = useDroppable({
    id: `column:${col}`,
    disabled: !editing,
  })

  return (
    <div
      ref={setNodeRef}
      // ⚠️ min-w-0 不能删（2026-09-29 修）：这一列是 grid 的子项，而 grid/flex 子项默认
      // min-width:auto —— 意思是「最小宽度 = 内容的最小内容宽度」，**不允许收缩**。
      // 卡片里的 truncate 元素（white-space:nowrap）在没有确定宽度可依时，其最小内容宽度
      // 等于「整段文本不换行时的宽度」，这个宽度会一路上传，把整个列（乃至页面）撑爆。
      // 表现就是站长看到的那样：卡片加载前是骨架屏（宽度小）版式正常，**一加载完就变宽**，
      // 并把顶栏顶出去。min-w-0 把「最小宽度」改回 0，列宽就严格等于容器宽，
      // 里面的 truncate 也才有确定宽度可用、才会正常出省略号。
      className={cn(
        "min-w-0 space-y-6 rounded-xl p-1 transition-colors",
        editing && isOver && "bg-primary/5"
      )}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {ids.map((id) => (
          <SortableCard key={id} id={id} editing={editing} render={render} />
        ))}
      </SortableContext>
      {editing && (
        <div
          className={cn(
            "rounded-md border-2 border-dashed transition-all",
            ids.length === 0 ? "flex h-24 items-center justify-center" : "h-10",
            isOver && ids.length === 0 && "border-primary/60 bg-primary/5"
          )}
        >
          {ids.length === 0 && (
            <span className="mx-auto text-xs text-muted-foreground">{t("dash.layout.emptyCol")}</span>
          )}
        </div>
      )}
    </div>
  )
}

/** 由列的 droppable id 还原列名 */
function colOf(id: string): "left" | "right" {
  return id === "column:right" ? "right" : "left"
}

function arraysEqual(a: CardId[], b: CardId[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

function sameLayout(a: CardLayout, b: CardLayout): boolean {
  return arraysEqual(a.left, b.left) && arraysEqual(a.right, b.right)
}

/**
 * 实时重排：把 dragCard 移动到 overId 对应的位置。
 * 同列/跨列统一处理：取出 dragCard → 插到目标（列末尾 / over 卡之前）。
 * 返回与当前相同引用时表示无需变化。
 */
function reorderLayout(
  layout: CardLayout,
  dragCard: CardId,
  overId: string
): CardLayout {
  if (overId === dragCard) return layout

  const left = layout.left.filter((c) => c !== dragCard)
  const right = layout.right.filter((c) => c !== dragCard)

  let targetCol: "left" | "right"
  let insertIdx: number
  if (overId.startsWith("column:")) {
    targetCol = colOf(overId)
    insertIdx = (targetCol === "left" ? left : right).length
  } else {
    const overCard = overId as CardId
    targetCol = left.includes(overCard) ? "left" : "right"
    const arr = targetCol === "left" ? left : right
    const overIdx = arr.indexOf(overCard)
    insertIdx = overIdx < 0 ? arr.length : overIdx
  }

  const targetArr = targetCol === "left" ? left : right
  targetArr.splice(insertIdx, 0, dragCard)
  return targetCol === "left" ? { left: targetArr, right } : { left, right: targetArr }
}

export default function DashboardPage() {
  const { t } = useT()
  const { user } = useAuth()
  const [data, setData] = React.useState<MeResponse | null>(null)
  const [loading, setLoading] = React.useState(true)

  const [layout, setLayout] = React.useState<CardLayout>(() => loadLayout())
  const [editing, setEditing] = React.useState(false)
  /** 正在拖拽的卡片 id（用于 DragOverlay 浮层） */
  const [dragging, setDragging] = React.useState<CardId | null>(null)

  /** 只启用指针传感器，且编辑模式下才允许拖拽 */
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  )

  React.useEffect(() => {
    let cancelled = false
    authApi
      .me()
      .then((res) => !cancelled && setData(res))
      .catch((err) => {
        if (!cancelled) toast.error(errMsg(err, t("dash.err.me")))
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  // 布局变化即持久化
  React.useEffect(() => {
    saveLayout(layout)
  }, [layout])

  /** 卡片 id → 渲染内容 */
  const renderCard = (id: CardId) => {
    switch (id) {
      case "mail":
        return <RecentMailCard data={data} loading={loading} />
      case "storage":
        return <StorageCard data={data} loading={loading} />
      case "activity":
        return <RecentActivityCard data={data} loading={loading} />
      case "ai":
        return <AiCard />
      case "profile":
        return <ProfileCard />
      case "announcements":
        return <AnnouncementsCard />
      case "quick":
        return <QuickActions />
    }
  }

  /**
   * 预览布局：拖拽中的卡片从原位摘出，其它卡按 layout 渲染。
   * 注意：拖拽中的卡片位置随 onDragOver 在 layout 里实时更新，
   * 这里只保证被拖卡不重复渲染在原有位置。
   */
  const preview = React.useMemo<CardLayout>(() => {
    if (!dragging) return layout
    return withoutCard(layout, dragging)
  }, [layout, dragging])

  /** 提交：把拖拽结果写入布局（松手时最终落位） */
  const commitDrop = (overId: string) => {
    if (dragging) {
      setLayout((prev) => {
        const next = reorderLayout(prev, dragging, overId)
        return sameLayout(prev, next) ? prev : next
      })
    }
    setDragging(null)
  }

  /** 拖拽中实时重排：边拖边让位挤压，不等松手 */
  const handleDragOver = (e: DragOverEvent) => {
    if (!dragging || !e.over?.id) return
    const overId = String(e.over.id)
    setLayout((prev) => {
      const next = reorderLayout(prev, dragging, overId)
      return sameLayout(prev, next) ? prev : next
    })
  }

  return (
    <div className="space-y-6">
      <AnnouncementPopup />
      <PageHeader
        title={t("dash.welcome", { name: user?.username ?? "" })}
        description={`${user?.namespace}.doulor.cn`}
        actions={
          <div className="flex items-center gap-2">
            {editing && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setLayout(DEFAULT_LAYOUT)
                  toast.success(t("dash.layout.reset"))
                }}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t("dash.layout.resetBtn")}
              </Button>
            )}
            <Button
              variant={editing ? "default" : "outline"}
              size="sm"
              onClick={() => setEditing((v) => !v)}
            >
              <Pencil className="h-3.5 w-3.5" />
              {editing ? t("dash.layout.done") : t("dash.layout.edit")}
            </Button>
          </div>
        }
      />

      {/* 顶部：资源快览徽章行（概览 + 导航） */}
      <ResourceBadges data={data} loading={loading} />

      {editing && (
        <p className="rounded-md border border-dashed bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
          {t("dash.layout.hint")}
        </p>
      )}

      {/* 主体：双列，dnd-kit 负责拖拽与让位动画。拖拽过程中实时重排（onDragOver），
          其他卡片边拖边让位挤压，而非等松手才落位。 */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={(e: DragStartEvent) => setDragging(e.active.id as CardId)}
        onDragOver={handleDragOver}
        onDragEnd={(e: DragOverEvent) => commitDrop(String(e.over?.id ?? ""))}
        onDragCancel={() => setDragging(null)}
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <SortableColumn col="left" ids={preview.left} editing={editing} render={renderCard} />
          <SortableColumn col="right" ids={preview.right} editing={editing} render={renderCard} />
        </div>
        <DragOverlay>
          {dragging ? (
            <div className="cursor-grabbing rounded-xl shadow-xl ring-2 ring-primary/40">
              {renderCard(dragging)}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  )
}
