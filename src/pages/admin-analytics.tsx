/**
 * 管理面板 → 网站统计。
 *
 * 独立文件（同 admin-oauth.tsx 的考量）：admin.tsx 已 4500+ 行，
 * 且有其他改动可能在动它。UI 本体放这里，admin.tsx 只插 3 行挂载。
 *
 * 两个分页：
 *   1. 访问统计（TrafficPanel）—— 访客侧：PV/UV、趋势、页面热度、来源；
 *   2. 用户数据（UserAnalyticsPanel，独立文件）—— 用户侧：功能开通率、构成、
 *      新增趋势、资源占用、捐献与社区活跃度。
 *
 * 图表不引入重库，用纯 CSS 条形图 / SVG 环形 / conic-gradient 饼图（数据量小，够用且轻）。
 */
import * as React from "react"
import { toast } from "sonner"
import { BarChart3, Eye, Users } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { LoadingBlock } from "@/components/loading-block"
import { analyticsApi, errMsg } from "@/services/api"
import { UserAnalyticsPanel } from "./admin-analytics-users"
import type { AnalyticsOverview } from "@/types"

/** 相对时间（今天/昨天/N 天前） */
function dayLabel(date: string): string {
  const d = new Date(date + "T00:00:00")
  const today = new Date()
  const diff = Math.round((today.getTime() - d.getTime()) / 86400000)
  if (diff === 0) return "今天"
  if (diff === 1) return "昨天"
  return `${date.slice(5)}`
}

/** 访问统计（访客侧） */
function TrafficPanel({ days }: { days: string }) {
  const [data, setData] = React.useState<AnalyticsOverview | null>(null)
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      setData(await analyticsApi.overview(Number(days)))
    } catch (err) {
      toast.error(errMsg(err, "加载统计失败"))
    } finally {
      setLoading(false)
    }
  }, [days])

  React.useEffect(() => {
    void load()
  }, [load])

  if (loading || !data) return <LoadingBlock />

  const maxPathPv = Math.max(1, ...data.byPath.map((p) => p.pv))
  const maxDayPv = Math.max(1, ...data.byDay.map((d) => d.pv))
  const maxRefPv = Math.max(1, ...data.byReferrer.map((r) => r.pv))

  return (
    <div className="space-y-6">
      {/* 总览 */}
      <div className="flex flex-wrap items-center gap-4">
        <Card className="px-5 py-4">
          <div className="flex items-center gap-3">
            <Eye className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">浏览量（PV）</p>
              <p className="text-2xl font-semibold tabular-nums">{data.summary.pv}</p>
            </div>
          </div>
        </Card>
        <Card className="px-5 py-4">
          <div className="flex items-center gap-3">
            <Users className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">独立访客（UV）</p>
              <p className="text-2xl font-semibold tabular-nums">{data.summary.uv}</p>
            </div>
          </div>
        </Card>
      </div>

      {/* 趋势图（纯 CSS 条形图） */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
            访问趋势
          </CardTitle>
          <CardDescription>按天的 PV（柱）/ UV（线不画，看数值）</CardDescription>
        </CardHeader>
        <CardContent>
          {data.byDay.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">暂无数据</p>
          ) : (
            <div className="space-y-1.5">
              {data.byDay.map((d) => (
                <div key={d.date} className="flex items-center gap-2 text-xs">
                  <span className="w-14 shrink-0 text-muted-foreground">{dayLabel(d.date)}</span>
                  <div className="h-4 flex-1 overflow-hidden rounded bg-muted">
                    <div
                      className="h-full rounded bg-primary/70"
                      style={{ width: `${(d.pv / maxDayPv) * 100}%` }}
                    />
                  </div>
                  <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">
                    {d.pv}
                  </span>
                  <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground/60">
                    {d.uv} uv
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* 页面热度 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">页面热度</CardTitle>
            <CardDescription>访问最多的路径</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.byPath.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">暂无数据</p>
            ) : (
              data.byPath.map((p) => (
                <div key={p.path} className="flex items-center gap-2 text-xs">
                  <span className="w-40 shrink-0 truncate font-mono" title={p.path}>
                    {p.path}
                  </span>
                  <div className="h-3 flex-1 overflow-hidden rounded bg-muted">
                    <div
                      className="h-full rounded bg-primary/60"
                      style={{ width: `${(p.pv / maxPathPv) * 100}%` }}
                    />
                  </div>
                  <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">
                    {p.pv}
                  </span>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {/* 来源分析 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">来源分析</CardTitle>
            <CardDescription>访客从哪来</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.byReferrer.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">暂无数据</p>
            ) : (
              data.byReferrer.map((r) => (
                <div key={r.referrer} className="flex items-center gap-2 text-xs">
                  <span className="w-40 shrink-0 truncate" title={r.referrer}>
                    {r.referrer === "direct" ? "直接访问" : r.referrer}
                  </span>
                  <div className="h-3 flex-1 overflow-hidden rounded bg-muted">
                    <div
                      className="h-full rounded bg-primary/60"
                      style={{ width: `${(r.pv / maxRefPv) * 100}%` }}
                    />
                  </div>
                  <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">
                    {r.pv}
                  </span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

export function AnalyticsPanel() {
  const [tab, setTab] = React.useState<"traffic" | "users">("traffic")
  const [days, setDays] = React.useState("7")

  const tabs: { key: "traffic" | "users"; label: string }[] = [
    { key: "traffic", label: "访问统计" },
    { key: "users", label: "用户数据" },
  ]

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* 分页切换 */}
        <div className="flex gap-1 rounded-lg border p-1">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={
                "rounded-md px-3 py-1.5 text-sm transition-colors " +
                (tab === t.key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground")
              }
            >
              {t.label}
            </button>
          ))}
        </div>
        <Select value={days} onValueChange={setDays}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">近 7 天</SelectItem>
            <SelectItem value="30">近 30 天</SelectItem>
            <SelectItem value="90">近 90 天</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {tab === "traffic" ? <TrafficPanel days={days} /> : <UserAnalyticsPanel days={days} />}
    </div>
  )
}
