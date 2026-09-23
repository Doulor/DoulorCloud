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
} from "lucide-react"
import { toast } from "sonner"

import { PageHeader } from "@/components/page-header"
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
import { authApi, newapiApi, profileApi, announcementApi } from "@/services/api"
import { useAuth } from "@/hooks/use-auth"
import type {
  Announcement,
  MeResponse,
  NewApiStatus,
  ProfileOverview,
} from "@/types"

const NEWAPI_BASE_URL = "https://api.doulor.cn/v1"

function formatBytes(n: number) {
  if (!n) return "0 B"
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (n >= 1024 * 1024) return `${Math.round(n / 1024 / 1024)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

function useCopy() {
  const [copied, setCopied] = React.useState<string | null>(null)
  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(label)
      toast.success(`${label} 已复制`)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      toast.error("复制失败，请手动复制")
    }
  }
  return { copied, copy }
}

/** AI 中转站详情卡：额度 + Base URL + Key 列表 */
function AiCard() {
  const [status, setStatus] = React.useState<NewApiStatus | null>(null)
  const [loading, setLoading] = React.useState(true)
  const { copied, copy } = useCopy()

  React.useEffect(() => {
    let cancelled = false
    newapiApi
      .status()
      .then((res: NewApiStatus) => !cancelled && setStatus(res))
      .catch(() => {})
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
            AI 中转站
          </CardTitle>
          <CardDescription>
            {loading ? "加载中…" : acc ? "额度与用量" : "未绑定"}
          </CardDescription>
        </div>
        <Button variant="ghost" size="sm" asChild>
          <Link to="/dashboard/ai">
            管理
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <Skeleton className="h-20 w-full" />
        ) : !acc ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            尚未绑定 AI 中转站，前往开通
          </p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2 rounded-md border p-3 text-center">
              <div>
                <p className="text-xs text-muted-foreground">剩余</p>
                <p className="text-sm font-semibold">
                  {symbol}
                  {remaining.toFixed(4)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">已用</p>
                <p className="text-sm font-semibold">
                  {symbol}
                  {(acc.usedUsd ?? 0).toFixed(4)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">请求</p>
                <p className="text-sm font-semibold">{acc.requestCount ?? 0}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-md border px-3 py-2">
              <span className="text-xs text-muted-foreground">Base URL</span>
              <code className="flex-1 truncate font-mono text-xs">{NEWAPI_BASE_URL}</code>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => void copy(NEWAPI_BASE_URL, "Base URL")}
                aria-label="复制 Base URL"
              >
                {copied === "Base URL" ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary">{status?.models.length ?? 0} 模型</Badge>
              {status?.accountGroup && (
                <Badge variant="outline">{status.accountGroup}</Badge>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

/** 名片预览卡：头像 + 昵称 + 签名 + 查看按钮 */
function ProfileCard({ compact = false }: { compact?: boolean }) {
  const [data, setData] = React.useState<ProfileOverview | null>(null)
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    let cancelled = false
    profileApi
      .get()
      .then((res) => !cancelled && setData(res))
      .catch(() => {})
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
            个人名片
          </CardTitle>
          <CardDescription>
            {loading ? "加载中…" : p ? "你的对外主页" : "未开通"}
          </CardDescription>
        </div>
        {p && (
          <Button variant="ghost" size="sm" asChild>
            <a href={publicUrl} target="_blank" rel="noopener noreferrer">
              查看
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </Button>
        )}
      </CardHeader>
      <CardContent className={compact ? "min-h-0 flex-1 flex flex-col justify-center" : ""}>
        {loading ? (
          <Skeleton className="h-20 w-full" />
        ) : !p ? (
          <div className="space-y-3">
            <p className="py-2 text-center text-sm text-muted-foreground">
              还没开通个人名片
            </p>
            <Button asChild size="sm" variant="outline" className="w-full">
              <Link to="/dashboard/profile">前往开通</Link>
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
                {p.displayName ?? "未设置昵称"}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {p.bio || "未设置签名"}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => void navigator.clipboard.writeText(publicUrl).then(() => toast.success("名片链接已复制"))}
              aria-label="复制名片链接"
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
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
  const unread = data?.stats?.unread ?? 0
  const messages = data?.recentMessages ?? []
  const shown = compact ? messages.slice(0, 3) : messages
  return (
    <Card className={`flex flex-col overflow-hidden ${compact ? "flex-1" : ""}`}>
      <CardHeader className={`flex flex-row items-center justify-between ${compact ? "py-3" : ""}`}>
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Mail className="h-4 w-4 text-muted-foreground" />
            最近邮件
          </CardTitle>
          <CardDescription>收件箱动态</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {unread > 0 && (
            <Badge variant="success" className="gap-1">
              <Inbox className="h-3 w-3" />
              {unread} 未读
            </Badge>
          )}
          <Button variant="ghost" size="sm" asChild>
            <Link to="/dashboard/email">
              查看全部
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className={compact ? "min-h-0 flex-1 overflow-y-auto" : ""}>
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : shown.length ? (
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
                  <span className="truncate">{m.subject || "无主题"}</span>
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
            还没有收到邮件
          </p>
        )}
      </CardContent>
    </Card>
  )
}

/** 网盘用量卡：进度条 + 最近文件 */
function StorageCard({ data, loading }: { data: MeResponse | null; loading: boolean }) {
  const { copied, copy } = useCopy()
  const used = data?.stats?.storageUsedBytes ?? 0
  const quota = data?.stats?.storageQuotaBytes ?? 0
  const enabled = quota > 0
  const pct = quota > 0 ? Math.min((used / quota) * 100, 100) : 0
  const files = data?.recentStorageFiles ?? []

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <HardDrive className="h-4 w-4 text-muted-foreground" />
            网盘
          </CardTitle>
          <CardDescription>
            {loading ? "加载中…" : enabled ? "用量与最近文件" : "未开通"}
          </CardDescription>
        </div>
        <Button variant="ghost" size="sm" asChild>
          <Link to="/dashboard/storage">
            管理
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <Skeleton className="h-20 w-full" />
        ) : !enabled ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            网盘未开通，前往管理页开通
          </p>
        ) : (
          <>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">{formatBytes(used)}</span>
                <span className="text-muted-foreground">/ {formatBytes(quota)}</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
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
                          {formatBytes(f.size)}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => void copy(dlUrl, "直链")}
                          aria-label="复制直链"
                        >
                          {copied === "直链" ? (
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
        )}
      </CardContent>
    </Card>
  )
}

/** 网站动态卡：公告列表 */
function AnnouncementsCard() {
  const [items, setItems] = React.useState<Announcement[]>([])
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    let cancelled = false
    announcementApi
      .list()
      .then((res) => !cancelled && setItems(res.announcements))
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  const categoryLabel: Record<string, string> = {
    general: "公告",
    frp: "内网穿透",
    ai: "AI 中转站",
    proxy: "代理节点",
    storage: "网盘",
    profile: "名片",
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Megaphone className="h-4 w-4 text-muted-foreground" />
            网站动态
          </CardTitle>
          <CardDescription>最近更新与公告</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            暂无动态
          </p>
        ) : (
          <div className="space-y-3">
            {items.map((a) => (
              <div key={a.id} className="space-y-1">
                <div className="flex items-center gap-2">
                  {a.pinned && <Badge variant="success">置顶</Badge>}
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
        )}
      </CardContent>
    </Card>
  )
}

/** 资源快览徽章行：紧凑横排几个核心数字，点击跳转，既是概览也是导航 */
function ResourceBadges({ data, loading }: { data: MeResponse | null; loading: boolean }) {
  const stats = data?.stats
  const items = [
    { label: "子域名", value: stats?.subdomains ?? 0, icon: Globe, to: "/dashboard/domains" },
    { label: "未读", value: stats?.unread ?? 0, icon: Mail, to: "/dashboard/email" },
    { label: "DNS", value: stats?.dnsRecords ?? 0, icon: Network, to: "/dashboard/domains" },
    { label: "邮箱", value: stats?.mailboxes ?? 0, icon: Inbox, to: "/dashboard/email" },
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
            {loading ? (
              <Skeleton className="h-5 w-8" />
            ) : (
              <p className="text-lg font-semibold leading-none tracking-tight">{it.value}</p>
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
  const actions = [
    { label: "发邮件", icon: Mail, to: "/dashboard/email" },
    { label: "传文件", icon: Upload, to: "/dashboard/storage" },
    { label: "建子域名", icon: Plus, to: "/dashboard/domains" },
    { label: "充额度", icon: Zap, to: "/dashboard/ai" },
  ]
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">快捷操作</CardTitle>
        <CardDescription>常用动作直达</CardDescription>
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
  const items = data?.recentActivity ?? []
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4 text-muted-foreground" />
            最近活动
          </CardTitle>
          <CardDescription>你的操作记录</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">暂无活动记录</p>
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
                    <span className="ml-2 truncate text-xs text-muted-foreground/70">
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
        )}
      </CardContent>
    </Card>
  )
}

export default function DashboardPage() {
  const { user } = useAuth()
  const [data, setData] = React.useState<MeResponse | null>(null)
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    let cancelled = false
    authApi
      .me()
      .then((res) => !cancelled && setData(res))
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="space-y-6">
      <PageHeader
        title={`欢迎回来，${user?.username ?? ""}`}
        description={`${user?.namespace}.doulor.cn`}
      />

      {/* 顶部：资源快览徽章行（概览 + 导航） */}
      <ResourceBadges data={data} loading={loading} />

      {/* 主体：双列流式，自然高度 */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* 左列 */}
        <div className="space-y-6">
          <RecentMailCard data={data} loading={loading} />
          <StorageCard data={data} loading={loading} />
          <RecentActivityCard data={data} loading={loading} />
        </div>
        {/* 右列 */}
        <div className="space-y-6">
          <AiCard />
          <ProfileCard />
          <AnnouncementsCard />
          <QuickActions />
        </div>
      </div>
    </div>
  )
}
