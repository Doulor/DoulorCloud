import * as React from "react"
import { Link } from "react-router-dom"
import {
  Mail,
  Network,
  ArrowRight,
  Inbox,
  Layers,
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
      </div>
    </div>
  )
}
