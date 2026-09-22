import * as React from "react"
import { Link } from "react-router-dom"
import {
  Mail,
  Network,
  ArrowRight,
  Inbox,
  Layers,
  HardDrive,
  Sparkles,
  Contact,
  Package,
  Zap,
} from "lucide-react"

import { PageHeader } from "@/components/page-header"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { authApi } from "@/services/api"
import { useAuth } from "@/hooks/use-auth"
import type { MeResponse } from "@/types"

function formatBytes(n: number) {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (n >= 1024 * 1024) return `${Math.round(n / 1024 / 1024)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

function StatCard({
  label,
  value,
  icon: Icon,
  to,
  loading,
}: {
  label: string
  value: number
  icon: React.ElementType
  to: string
  loading: boolean
}) {
  return (
    <Link to={to} className="group">
      <Card className="transition-colors group-hover:bg-accent/40">
        <CardContent className="flex items-center justify-between p-6">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">{label}</p>
            {loading ? (
              <Skeleton className="h-7 w-10" />
            ) : (
              <p className="text-2xl font-semibold tracking-tight">{value}</p>
            )}
          </div>
          <div className="rounded-md border bg-background p-2">
            <Icon className="h-4 w-4 text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    </Link>
  )
}

/** 状态卡：显示「已开通/未开通」之类的二元状态，点击跳转管理。 */
function StatusCard({
  label,
  icon: Icon,
  to,
  loading,
  active,
  activeText = "已开通",
  inactiveText = "未开通",
}: {
  label: string
  icon: React.ElementType
  to: string
  loading: boolean
  active: boolean
  activeText?: string
  inactiveText?: string
}) {
  return (
    <Link to={to} className="group">
      <Card className="transition-colors group-hover:bg-accent/40">
        <CardContent className="flex items-center justify-between p-6">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">{label}</p>
            {loading ? (
              <Skeleton className="h-7 w-16" />
            ) : (
              <Badge variant={active ? "success" : "secondary"}>
                {active ? activeText : inactiveText}
              </Badge>
            )}
          </div>
          <div className="rounded-md border bg-background p-2">
            <Icon className="h-4 w-4 text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    </Link>
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
      .then((res) => {
        if (!cancelled) setData(res)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const stats = data?.stats

  return (
    <div>
      <PageHeader
        title={`欢迎回来，${user?.username ?? ""}`}
        description={`${user?.namespace}.doulor.cn`}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="子域名"
          value={stats?.subdomains ?? 0}
          icon={Layers}
          to="/dashboard/domains"
          loading={loading}
        />
        <StatCard
          label="未读邮件"
          value={stats?.unread ?? 0}
          icon={Mail}
          to="/dashboard/email"
          loading={loading}
        />
        <StatCard
          label="DNS 记录"
          value={stats?.dnsRecords ?? 0}
          icon={Network}
          to="/dashboard/domains"
          loading={loading}
        />
        <StatCard
          label="邮箱地址"
          value={stats?.mailboxes ?? 0}
          icon={Inbox}
          to="/dashboard/email"
          loading={loading}
        />
      </div>

      {/* 第二行：网盘 / AI / 名片 / 分享箱 */}
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="网盘文件"
          value={stats?.storageFiles ?? 0}
          icon={HardDrive}
          to="/dashboard/storage"
          loading={loading}
        />
        <StatCard
          label="AI Key"
          value={stats?.newapiKeys ?? 0}
          icon={Sparkles}
          to="/dashboard/ai"
          loading={loading}
        />
        <StatusCard
          label="个人名片"
          icon={Contact}
          to="/dashboard/profile"
          loading={loading}
          active={stats?.profileEnabled ?? false}
          activeText={stats?.profilePublished ? "已发布" : "已开通"}
          inactiveText="未开通"
        />
        <StatCard
          label="分享箱（有效）"
          value={stats?.tempboxBatches ?? 0}
          icon={Package}
          to="/dashboard/tempbox"
          loading={loading}
        />
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">你的资源</CardTitle>
            <CardDescription>配额与使用情况</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {loading ? (
              <>
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
              </>
            ) : (
              <>
                <div className="flex items-center justify-between rounded-md border px-4 py-3">
                  <span className="font-mono text-sm">
                    {user?.namespace}.doulor.cn
                  </span>
                  <Badge variant="success">active</Badge>
                </div>
                <div className="flex items-center justify-between rounded-md border px-4 py-3 text-sm">
                  <span className="text-muted-foreground">子域名</span>
                  <span className="font-medium">
                    {stats?.subdomains ?? 0} / {data?.subdomainLimit ?? 5}
                  </span>
                </div>
                <div className="flex items-center justify-between rounded-md border px-4 py-3 text-sm">
                  <span className="text-muted-foreground">邮箱地址</span>
                  <span className="font-medium">
                    {stats?.mailboxes ?? 0} / {data?.mailboxLimit ?? 3}
                  </span>
                </div>
                <Button asChild variant="ghost" size="sm" className="w-full">
                  <Link to="/dashboard/domains">
                    管理域名
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div className="space-y-1">
              <CardTitle className="text-base">最近邮件</CardTitle>
              <CardDescription>收件箱动态</CardDescription>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/dashboard/email">
                查看全部
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : data?.recentMessages?.length ? (
              <div className="space-y-1">
                {data.recentMessages.map((m) => (
                  <div
                    key={m.id}
                    className="flex items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-accent/40"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      {!m.read && (
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-foreground" />
                      )}
                      <span className="truncate">
                        {m.subject || "无主题"}
                      </span>
                    </div>
                    <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                      {new Date(m.receivedAt).toLocaleString("zh-CN", {
                        month: "numeric",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">
                还没有收到邮件
              </p>
            )}
          </CardContent>
        </Card>

        {/* 网盘用量 + 代理节点入口 */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div className="space-y-1">
              <CardTitle className="text-base">网盘用量</CardTitle>
              <CardDescription>
                {stats?.storageEnabled ? "已用 / 配额" : "未开通网盘"}
              </CardDescription>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/dashboard/storage">
                管理
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-9 w-full" />
            ) : stats?.storageEnabled ? (
              (() => {
                const used = stats.storageUsedBytes ?? 0
                const quota = stats.storageQuotaBytes ?? 0
                const pct = quota > 0 ? Math.min((used / quota) * 100, 100) : 0
                return (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium">{formatBytes(used)}</span>
                      <span className="text-muted-foreground">
                        / {formatBytes(quota)}
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {stats.storageFiles ?? 0} 个文件
                    </p>
                  </div>
                )
              })()
            ) : (
              <p className="py-4 text-center text-sm text-muted-foreground">
                网盘未开通，前往管理页开通
              </p>
            )}
          </CardContent>
        </Card>

        {/* 代理节点入口 */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div className="space-y-1">
              <CardTitle className="text-base">代理节点</CardTitle>
              <CardDescription>全局订阅源，按需启用</CardDescription>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/dashboard/proxy">
                管理
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 rounded-md border px-4 py-3">
              <Zap className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                代理节点为全局共享订阅，前往管理页查看可用节点并启用。
              </span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
