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
  ChevronDown,
} from "lucide-react"
import { toast } from "sonner"
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
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
import { InstallAppButton } from "@/components/install-app-button"
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
import {
  authApi,
  newapiApi,
  profileApi,
  announcementApi,
  getDefaultRootDomain,
  errMsg,
  HttpError,
} from "@/services/api"
import { useAuth } from "@/hooks/use-auth"
import { useT, tStatic } from "@/i18n"
import { UserAvatar } from "@/components/user-avatar"
import { CountUp } from "@/components/motion/count-up"
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

/**
 * AI 中转站详情卡：额度 + Base URL + Key 列表。
 *
 * 数据由页面级 useDashboardCards 统一拉取（受控组件）——卡片编辑的拖拽跨列、
 * DragOverlay 浮层都会让卡片反复 unmount/mount，自带请求会重复发（实测拖一次
 * AI 卡至少多发 2 次 /api/dev/status 并闪一次骨架屏）。
 */
const AiCard = React.memo(function AiCard({
  status,
  loading,
}: {
  status: NewApiStatus | null
  loading: boolean
}) {
  const { t } = useT()
  const { copied, copy } = useCopy()

  const acc = status?.account
  const symbol = status?.currencySymbol ?? "¥"
  const perUnit = status?.quotaPerUnit ?? 500_000
  // 剩余额度按**订阅**口径算，两个坑都在这里：
  //   1. 账户级的 `account.quota` **不含订阅额度** —— 免费订阅和邀请/成就奖励订阅
  //      都在 `status.subscriptions` 里，只看 account 会漏掉一大截（用户会以为额度不对）。
  //   2. 而且 `account.quota` **本身就是剩余值**（消费时直接扣减，用超了还会变负），
  //      原来又减了一次累计消耗 `usedQuota` ⇒ 用超的用户直接显示成负数。
  // 没有订阅数据时才回落到账户剩余（同样**不再减** used）。
  const subs = status?.subscriptions ?? []
  const remaining = subs.length
    ? subs.reduce((sum, g) => sum + Math.max(0, g.amountTotal - g.amountUsed), 0) / perUnit
    : Math.max(0, acc?.quotaUsd ?? 0)

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
            {/* ⚠️ 2026-10-08：这里原先还有一个「{n} 模型」徽标，数据取自
                status.models。模型清单已改为**懒加载**（GET /api/dev/models），
                status 里不再带它 —— 概览页不该为了一个装饰性数字去让上游拉一次
                全量模型（既慢又白耗中转站速率）。想在概览页看数量，去
                「AI 中转站」页展开「全部可用模型」卡片即可。 */}
            <div className="flex flex-wrap items-center gap-1.5">
              {status?.accountGroup && (
                <Badge variant="outline">{status.accountGroup}</Badge>
              )}
            </div>
          </>
        )}</DataFade>
      </CardContent>
    </Card>
  )
})

/** 名片预览卡：头像 + 昵称 + 签名 + 查看按钮（数据由页面级统一拉取） */
const ProfileCard = React.memo(function ProfileCard({
  data,
  loading,
  compact = false,
}: {
  data: ProfileOverview | null
  loading: boolean
  compact?: boolean
}) {
  const { t } = useT()
  const { user } = useAuth()

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
            {p.avatarKey || p.avatarUrl ? (
              <img
                src={p.avatarKey ? `/api/profile/asset?kind=avatar` : p.avatarUrl ?? ""}
                alt={p.displayName ?? ""}
                className="h-12 w-12 shrink-0 rounded-full border object-cover"
              />
            ) : (
              // 名片头像没传时回退账号头像（概览卡语境是「我的账号」不是「公开名片页」），
              // 否则会渲染出 src="" 的破图（2026-10-02 issue #3）
              <UserAvatar
                username={user?.username ?? ""}
                nickname={user?.nickname}
                hasAvatar={user?.hasAvatar}
                className="h-12 w-12 shrink-0"
              />
            )}
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
})

/** 最近邮件卡：标题点击跳转正文 + 右侧未读数 */
const RecentMailCard = React.memo(function RecentMailCard({
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
})

/** 网盘用量卡：进度条 + 最近文件 */
const StorageCard = React.memo(function StorageCard({
  data,
  loading,
}: {
  data: MeResponse | null
  loading: boolean
}) {
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
})

/**
 * 公告弹窗：根据公告的 popup_mode 决定是否弹、怎么弹。
 *
 * 记忆策略（存 localStorage，不落库）：
 *   - once 模式：关闭后记录「已看过」，不再弹
 *   - every 模式：每次进入都弹，但用户可点「不再显示」永久屏蔽
 * localStorage 键：doulor:ann-seen:<id>（已看/已屏蔽）
 *
 * 公告数据由页面级统一拉取（与「网站动态」卡共享一次请求，原来各发一次）。
 */
const AnnouncementPopup = React.memo(function AnnouncementPopup({
  announcements,
}: {
  announcements: Announcement[]
}) {
  const { t } = useT()
  const [popup, setPopup] = React.useState<Announcement | null>(null)
  /** 只决定一次弹窗；公告列表后续再变（本页只拉一次）也不重复弹 */
  const decidedRef = React.useRef(false)

  React.useEffect(() => {
    if (decidedRef.current || announcements.length === 0) return
    decidedRef.current = true
    // 找第一个需要弹的公告
    const target = announcements.find((a) => {
      if (a.popupMode === "none") return false
      const seen = localStorage.getItem(`doulor:ann-seen:${a.id}`)
      return !seen
    })
    if (target) setPopup(target)
  }, [announcements])

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
})

/** 网站动态卡：公告列表（数据由页面级统一拉取，与弹窗共享一次请求） */
const AnnouncementsCard = React.memo(function AnnouncementsCard({
  items,
  loading,
}: {
  items: Announcement[]
  loading: boolean
}) {
  const { t } = useT()
  /**
   * 展开中的公告 id。
   *
   * 公告正文原来固定 `line-clamp-2` 截断、整条又没有任何点击行为 —— 长公告
   * 只能看到前两行，用户反馈「点了没反应、看不到完整公告」（2026-10-02）。
   * 现在点整条即可展开/收起（键盘 Enter/Space 同样可用）。
   */
  const [expandedId, setExpandedId] = React.useState<string | null>(null)

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
            {items.map((a) => {
              const expanded = expandedId === a.id
              const toggle = () => setExpandedId(expanded ? null : a.id)
              return (
                <div
                  key={a.id}
                  role="button"
                  tabIndex={0}
                  aria-expanded={expanded}
                  onClick={toggle}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      toggle()
                    }
                  }}
                  className="-m-2 cursor-pointer space-y-1 rounded-md p-2 transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex items-center gap-2">
                    {a.pinned && <Badge variant="success">{t("dash.news.pinned")}</Badge>}
                    <Badge variant="secondary">{categoryLabel[a.category] ?? a.category}</Badge>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {new Date(a.createdAt).toLocaleDateString("zh-CN")}
                    </span>
                  </div>
                  <p className="text-sm font-medium">{a.title}</p>
                  <p
                    className={cn(
                      "whitespace-pre-wrap text-xs text-muted-foreground",
                      !expanded && "line-clamp-2"
                    )}
                  >
                    {a.body}
                  </p>
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <ChevronDown
                      className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")}
                    />
                    {expanded ? t("dash.news.collapse") : t("dash.news.expand")}
                  </span>
                </div>
              )
            })}
          </div>
        )}</DataFade>
      </CardContent>
    </Card>
  )
})

/** 资源快览徽章行：紧凑横排几个核心数字，点击跳转，既是概览也是导航 */
const ResourceBadges = React.memo(function ResourceBadges({
  data,
  loading,
}: {
  data: MeResponse | null
  loading: boolean
}) {
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
                {/* 动效层：数字滚动（关=现状：直接显示终值） */}
                <CountUp value={it.value} />
              </p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">{it.label}</p>
          </div>
        </Link>
      ))}
    </div>
  )
})

/** 快捷操作入口：常用动作直达 */
const QuickActions = React.memo(function QuickActions() {
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
})

/**
 * 审计动作 → 文案 key（2026-10-04 ventus 反馈：概览「最近活动」直接显示
 * achievement.reward / email.receive 这类原始英文标识）。
 *
 * 后端写进 audit_logs 的 action 是点分标识，前端此前从不翻译。这里把
 * **用户自己账号下会出现**的动作全部映射成中文；没映射到的（多为管理员
 * 操作、以后新增的动作）回退显示原始标识，不会崩。
 *
 * ⚠️ 键刻意用**单引号**：check-i18n 会把「词典里出现过的前缀.名字」当成
 * 漏翻译的文案 key 报警（dns.create / frp.enable 这类审计动作名恰好长这样），
 * 而它的启发式只匹配双引号字符串 —— 这里是后端动作名，不是文案，别改回去。
 */
const ACTION_LABEL_KEYS: Record<string, string> = {
  register: "dash.act.register",
  'login.2fa': "dash.act.login2fa",
  'password.change': "dash.act.passwordChange",
  'password.reset': "dash.act.passwordReset",
  'email.verify.request': "dash.act.emailVerifyRequest",
  'email.verify.confirm': "dash.act.emailVerifyConfirm",
  'email.receive': "dash.act.emailReceive",
  'email.destination.remove': "dash.act.emailDestinationRemove",
  'subdomain.create': "dash.act.subdomainCreate",
  'subdomain.delete': "dash.act.subdomainDelete",
  'dns.create': "dash.act.dnsCreate",
  'mailbox.forward.verify': "dash.act.mailboxForwardVerify",
  'storage.enable': "dash.act.storageEnable",
  'storage.disable': "dash.act.storageDisable",
  'storage.domain.bind': "dash.act.storageDomainBind",
  'storage.domain.unbind': "dash.act.storageDomainUnbind",
  'storage.default_prefix': "dash.act.storageDefaultPrefix",
  'newapi.bind': "dash.act.newapiBind",
  'newapi.bind_existing': "dash.act.newapiBindExisting",
  'newapi.subscribe': "dash.act.newapiSubscribe",
  'newapi.key.create': "dash.act.newapiKeyCreate",
  'newapi.key.delete': "dash.act.newapiKeyDelete",
  'newapi.password.change': "dash.act.newapiPasswordChange",
  'newapi.auto_claim': "dash.act.newapiAutoClaim",
  'newapi.group_sync_failed': "dash.act.newapiGroupSyncFailed",
  'frp.enable': "dash.act.frpEnable",
  'frp.disable': "dash.act.frpDisable",
  'frp.apply': "dash.act.frpApply",
  'frp.approve': "dash.act.frpApprove",
  'frp.reject': "dash.act.frpReject",
  'frp.cancel': "dash.act.frpCancel",
  'frp.revoke': "dash.act.frpRevoke",
  'frp.edit': "dash.act.frpEdit",
  'frp.ports.occupy': "dash.act.frpPortsOccupy",
  'frp.ports.free': "dash.act.frpPortsFree",
  'proxy.enable': "dash.act.proxyEnable",
  'proxy.disable': "dash.act.proxyDisable",
  'donation.review': "dash.act.donationReview",
  'donation.provision': "dash.act.donationProvision",
  'donation.revoke': "dash.act.donationRevoke",
  'donation.sensenova_audit': "dash.act.donationSensenovaAudit",
  'invite.create': "dash.act.inviteCreate",
  'invite.reward': "dash.act.inviteReward",
  'voucher.redeem': "dash.act.voucherRedeem",
  'points.redeem': "dash.act.pointsRedeem",
  'points.transfer': "dash.act.pointsTransfer",
  'points.adjust': "dash.act.pointsAdjust",
  'points.shop.buy': "dash.act.pointsShopBuy",
  'points.shop.review': "dash.act.pointsShopReview",
  'points.shop.settle': "dash.act.pointsShopSettle",
  'points.shop.seller_deliver': "dash.act.pointsShopSellerDeliver",
  'points.shop.deliver': "dash.act.pointsShopDeliver",
  'points.shop.after_sale.request': "dash.act.pointsShopAfterSale",
  'achievement.reward': "dash.act.achievementReward",
  'notice.ack': "dash.act.noticeAck",
  'notice.ack_blocked': "dash.act.noticeAckBlocked",
  'appeal.submit': "dash.act.appealSubmit",
  'appeal.review': "dash.act.appealReview",
  'appeal.ack': "dash.act.appealAck",
  'user.rename': "dash.act.userRename",
  'user.email.change': "dash.act.userEmailChange",
  'user.account.delete': "dash.act.userAccountDelete",
  'user.account.delete.request': "dash.act.userAccountDeleteRequest",
  'oauth.tokens.revoke': "dash.act.oauthTokensRevoke",
  '2fa.totp.enable': "dash.act.totpEnable",
  '2fa.email.enable': "dash.act.email2faEnable",
  '2fa.email.disable': "dash.act.email2faDisable",
  '2fa.disable': "dash.act.disable2fa",
  '2fa.recovery.regenerate': "dash.act.recoveryRegenerate",
  'wb2api.login.start': "dash.act.wb2apiLoginStart",
  'wb2api.login.done': "dash.act.wb2apiLoginDone",
  'wb2api.binding.remove': "dash.act.wb2apiBindingRemove",
  'cli2api.login.start': "dash.act.cli2apiLoginStart",
  'cli2api.login.done': "dash.act.cli2apiLoginDone",
  'community.pin': "dash.act.communityPin",
  'community.unpin': "dash.act.communityUnpin",
  'admin.community.post.delete': "dash.act.postDelete",
  'admin.community.post.restore': "dash.act.postRestore",
}

/** 最近活动：audit_logs 的最近操作记录 */
const RecentActivityCard = React.memo(function RecentActivityCard({
  data,
  loading,
}: {
  data: MeResponse | null
  loading: boolean
}) {
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
                  <span className="text-muted-foreground">
                    {ACTION_LABEL_KEYS[a.action] ? t(ACTION_LABEL_KEYS[a.action]) : a.action}
                  </span>
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
})

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

// （原 withoutCard 已删除：拖拽预览不再摘除被拖卡片 —— 摘卡会让 dnd-kit 的
//   active 节点卸载，排序与浮层全部失效，正是「拖拽不跟手」的根源之一。）

/** 带排序能力的卡片包装：dnd-kit 的 useSortable 负责让位动画与拖拽状态 */
const SortableCard = React.memo(function SortableCard({
  id,
  editing,
  render,
}: {
  id: CardId
  editing: boolean
  render: (id: CardId) => React.ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useSortable({ id, disabled: !editing })

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        /**
         * 让位动画用「回弹」弹簧曲线（overshoot 后收敛），替代 dnd-kit 默认的
         * 平缓 ease —— 卡片被挤开时先冲过头一点再弹回，接近 iOS 的物理手感。
         * 时长 260ms：短了看不出弹性，长了拖拽会感觉迟滞。
         */
        transition: "transform 260ms cubic-bezier(0.34, 1.56, 0.64, 1)",
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
        // Jiggle 抖动挂在**内层**：外层 transform 归 dnd-kit 排序管，
        // 动画属性撞车会把拖拽位移盖掉（详见 index.css 的 card-jiggle 注释）
        className={cn(
          editing && !isDragging && "cursor-grab active:cursor-grabbing",
          editing && !isDragging && "card-jiggle"
        )}
      >
        {render(id)}
      </div>
    </div>
  )
})

/** 可放置列：每列是一个 droppable，处理跨列拖拽 */
const SortableColumn = React.memo(function SortableColumn({
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
})

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

/**
 * 概览页卡片数据统一拉取。
 *
 * AiCard / ProfileCard / AnnouncementsCard（及公告弹窗）原来各自在挂载时发请求，
 * 而卡片编辑（拖拽跨列、DragOverlay 浮层）会让组件反复 unmount/mount —— 每跨
 * 一次列就多发一次请求、骨架屏闪一下（实测拖一次 AI 卡至少多发 2 次
 * /api/dev/status）。提升到页面级后卡片是纯受控组件：拖拽重排只比对 props，
 * 不再触发任何网络请求，「网站动态」卡与公告弹窗也共享同一次请求。
 */
function useDashboardCards() {
  const { t } = useT()
  /** 请求只发一次，但错误提示要跟当前语言 → 用 ref 兜住 t 的引用变化 */
  const tRef = React.useRef(t)
  React.useEffect(() => {
    tRef.current = t
  }, [t])

  const [aiStatus, setAiStatus] = React.useState<NewApiStatus | null>(null)
  const [aiLoading, setAiLoading] = React.useState(true)
  const [profile, setProfile] = React.useState<ProfileOverview | null>(null)
  const [profileLoading, setProfileLoading] = React.useState(true)
  const [announcements, setAnnouncements] = React.useState<Announcement[]>([])
  const [announcementsLoading, setAnnouncementsLoading] = React.useState(true)

  React.useEffect(() => {
    let cancelled = false
    newapiApi
      .status()
      .then((res: NewApiStatus) => !cancelled && setAiStatus(res))
      .catch((err) => {
        if (cancelled) return
        // 无权限（未解锁 AI 中转站）是新用户的正常状态，静默显示「未绑定」，不弹错误
        if (err instanceof HttpError && err.code === "FEATURE_NOT_PERMITTED") {
          return
        }
        toast.error(errMsg(err, tRef.current("dash.err.aiStatus")))
      })
      .finally(() => !cancelled && setAiLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  React.useEffect(() => {
    let cancelled = false
    profileApi
      .get()
      .then((res) => !cancelled && setProfile(res))
      .catch((err) => {
        if (!cancelled) toast.error(errMsg(err, tRef.current("dash.err.profile")))
      })
      .finally(() => !cancelled && setProfileLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  React.useEffect(() => {
    let cancelled = false
    announcementApi
      .list()
      .then((res) => !cancelled && setAnnouncements(res.announcements))
      .catch((err) => {
        if (!cancelled)
          toast.error(errMsg(err, tRef.current("dash.err.announcements")))
      })
      .finally(() => !cancelled && setAnnouncementsLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  return {
    aiStatus,
    aiLoading,
    profile,
    profileLoading,
    announcements,
    announcementsLoading,
  }
}

export default function DashboardPage() {
  const { t } = useT()
  const { user } = useAuth()

  /**
   * 「发给用户的根域」（如 tyu.me）。由后端下发，**不写死** ——
   * 它是管理员可改的（root_domains 的默认行），换域后写死的地方会显示错地址
   * （2026-10-02 从 doulor.cn 整体迁到 tyu.me 时就踩到了）。拉不到就留空。
   */
  const [rootDomain, setRootDomain] = React.useState("")
  React.useEffect(() => {
    let alive = true
    getDefaultRootDomain()
      .then((d) => {
        if (alive) setRootDomain(d)
      })
      .catch(() => {
        /* 拉不到就不显示域名，别闪一个错的 */
      })
    return () => {
      alive = false
    }
  }, [])
  const [data, setData] = React.useState<MeResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  /** AI / 名片 / 公告（含弹窗）的共享数据，见 useDashboardCards */
  const {
    aiStatus,
    aiLoading,
    profile,
    profileLoading,
    announcements,
    announcementsLoading,
  } = useDashboardCards()

  const [layout, setLayout] = React.useState<CardLayout>(() => loadLayout())
  const [editing, setEditing] = React.useState(false)
  /** 正在拖拽的卡片 id（用于 DragOverlay 浮层） */
  const [dragging, setDragging] = React.useState<CardId | null>(null)
  /** layout 的同步镜像：拖拽结束的持久化回调里读到的必须是最新已提交布局 */
  const layoutRef = React.useRef(layout)

  /**
   * 拖拽传感器：
   * - 鼠标：移动 6px 即激活（原有行为不变）。
   * - 触屏：按住 250ms（容差 10px）才激活 —— 否则手指按住拖 6px 就开始拖卡，
   *   与页面滚动手势直接冲突（dnd-kit pointer-sensor 文档建议按 pointerType 分支）。
   */
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 10 },
    })
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

  // 布局持久化：刻意**不**挂保存 effect —— 拖拽中 onDragOver 每次实时重排都会
  // 改 layout，挂 effect 等于每个拖拽事件都 JSON.stringify + localStorage.setItem
  // （同步 IO，主线程），正是拖拽发卡的来源之一。改为在「落位 / 取消 / 重置」
  // 这些真正需要落盘的时刻显式写一次。
  // layoutRef 用 useLayoutEffect 同步：dragend 回调读它时必须是最新已提交布局
  // （useEffect 异步 flush，快速连拖时可能读到上一轮的旧值）。
  React.useLayoutEffect(() => {
    layoutRef.current = layout
  }, [layout])

  /** 卡片 id → 渲染内容；useCallback 固定引用，配合 React.memo 挡住拖拽中的高频重渲染 */
  const renderCard = React.useCallback(
    (id: CardId) => {
      switch (id) {
        case "mail":
          return <RecentMailCard data={data} loading={loading} />
        case "storage":
          return <StorageCard data={data} loading={loading} />
        case "activity":
          return <RecentActivityCard data={data} loading={loading} />
        case "ai":
          return <AiCard status={aiStatus} loading={aiLoading} />
        case "profile":
          return <ProfileCard data={profile} loading={profileLoading} />
        case "announcements":
          return <AnnouncementsCard items={announcements} loading={announcementsLoading} />
        case "quick":
          return <QuickActions />
      }
    },
    [
      data,
      loading,
      aiStatus,
      aiLoading,
      profile,
      profileLoading,
      announcements,
      announcementsLoading,
    ]
  )

  /**
   * 预览布局：**不能**把被拖的卡从渲染里摘出去（历史 bug：withoutCard 摘卡
   * 导致 active 节点卸载，dnd-kit 的排序状态直接失效 —— 拖到哪儿别的卡都
   * 不让位、浮层位置计算也失去宿主，就是「拖拽不跟手」的一半根源）。
   * 正确姿势是 dnd-kit 官方模式：卡留在列表里，拖起时 isDragging → 透明占位
   * 保持空间，视觉本体交给 DragOverlay；跨列顺序由 onDragOver 实时重排。
   */
  const preview = React.useMemo<CardLayout>(() => layout, [layout, dragging])

  /** 提交：把拖拽结果写入布局并落盘（松手时最终落位） */
  const commitDrop = React.useCallback(
    (overId: string) => {
      const current = layoutRef.current
      const next = dragging
        ? reorderLayout(current, dragging, overId)
        : current
      const result = sameLayout(current, next) ? current : next
      if (result !== current) setLayout(result)
      saveLayout(result)
      setDragging(null)
    },
    [dragging]
  )

  /** 拖拽中实时重排：边拖边让位挤压，不等松手。仅在 over 真正变化时计算 */
  const lastOverRef = React.useRef<string | null>(null)
  const handleDragOver = React.useCallback(
    (e: DragOverEvent) => {
      if (!dragging || !e.over?.id) return
      const overId = String(e.over.id)
      if (overId === lastOverRef.current) return
      lastOverRef.current = overId
      setLayout((prev) => {
        const next = reorderLayout(prev, dragging, overId)
        return sameLayout(prev, next) ? prev : next
      })
    },
    [dragging]
  )

  /** 拖拽取消：实时重排可能已改过布局，同样落盘保持所见即所得 */
  const handleDragCancel = React.useCallback(() => {
    saveLayout(layoutRef.current)
    setDragging(null)
  }, [])

  return (
    <div className={cn("space-y-6", editing && "dash-editing")}>
      <AnnouncementPopup announcements={announcements} />
      <PageHeader
        title={t("dash.welcome", { name: user?.username ?? "" })}
        // 根域由后端下发（不写死 doulor.cn）：换域后这里要跟着变
        description={rootDomain ? `${user?.namespace}.${rootDomain}` : undefined}
        actions={
          <div className="flex items-center gap-2">
            <InstallAppButton />
            {editing && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setLayout(DEFAULT_LAYOUT)
                  saveLayout(DEFAULT_LAYOUT)
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
        onDragStart={(e: DragStartEvent) => {
          lastOverRef.current = null
          setDragging(e.active.id as CardId)
        }}
        onDragOver={handleDragOver}
        onDragEnd={(e: DragOverEvent) => commitDrop(String(e.over?.id ?? ""))}
        onDragCancel={handleDragCancel}
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <SortableColumn col="left" ids={preview.left} editing={editing} render={renderCard} />
          <SortableColumn col="right" ids={preview.right} editing={editing} render={renderCard} />
        </div>
        <DragOverlay
          /**
           * ⚠️ 这个 class 不能删：浮层的包裹层由 dnd-kit 渲染在 DndContext 内部，
           * 正好命中 `.page-enter > * > *` 的入场动画选择器。CSS 动画的值优先级
           * 高于内联 style，会把浮层靠 translate3d 的定位整段盖掉（拖拽不跟手）。
           * index.css 用 `:not(.dnd-drag-overlay)` 把它排除在入场动画之外。
           */
          className="dnd-drag-overlay"
          // 松手落位：短促带回弹的收束（常规 dropAnimation 是纯淡出，很"纸片"）
          dropAnimation={{
            duration: 260,
            easing: "cubic-bezier(0.18, 1.35, 0.4, 1)",
          }}
        >
          {dragging ? (
            // 拖起中：比原卡片略大 + 轻微倾斜 + 大阴影 —— 「拿在手里」的实感
            <div className="scale-[1.03] rotate-[1.2deg] cursor-grabbing rounded-xl shadow-2xl ring-2 ring-primary/50 transition-transform">
              {renderCard(dragging)}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  )
}
