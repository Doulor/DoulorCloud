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
import { BarChart3, CalendarDays, Clock, Eye, Repeat, Users } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { LoadingBlock } from "@/components/loading-block"
import { analyticsApi, errMsg } from "@/services/api"
import { UserAnalyticsPanel } from "./admin-analytics-users"
import type { AnalyticsOverview } from "@/types"
import { useT, tStatic } from "@/i18n"

/** 相对时间（今天/昨天/N 天前） */
function dayLabel(date: string): string {
  const d = new Date(date + "T00:00:00")
  const today = new Date()
  const diff = Math.round((today.getTime() - d.getTime()) / 86400000)
  if (diff === 0) return tStatic("an.today")
  if (diff === 1) return tStatic("an.yesterday")
  return `${date.slice(5)}`
}

/** 访问统计（访客侧） */
function TrafficPanel({ days }: { days: string }) {
  const { t } = useT()
  const [data, setData] = React.useState<AnalyticsOverview | null>(null)
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      setData(await analyticsApi.overview(Number(days)))
    } catch (err) {
      toast.error(errMsg(err, t("an.err.load")))
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
  const maxDevicePv = Math.max(1, ...(data.byDevice ?? []).map((d) => d.pv))
  const maxHourPv = Math.max(1, ...(data.byHour ?? []).map((h) => h.pv))

  const summaryCards = [
    { icon: Eye, label: t("an.pv"), value: data.summary.pv },
    { icon: Users, label: t("an.uv"), value: data.summary.uv },
    { icon: CalendarDays, label: t("an.activeDays"), value: data.summary.activeDays ?? 0 },
    { icon: BarChart3, label: t("an.avgPages"), value: data.summary.avgPagesPerVisitor ?? 0 },
    { icon: Eye, label: t("an.singlePage"), value: data.summary.singlePageVisitors ?? 0 },
    { icon: Repeat, label: t("an.returning"), value: data.summary.returningVisitors ?? 0 },
  ]

  return (
    <div className="space-y-6">
      {/* 总览 */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {summaryCards.map((card) => (
          <Card key={card.label} className="px-5 py-4">
            <div className="flex items-center gap-3">
              <card.icon className="h-5 w-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="truncate text-xs text-muted-foreground" title={card.label}>
                  {card.label}
                </p>
                <p className="text-2xl font-semibold tabular-nums">{card.value}</p>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* 趋势图（纯 CSS 条形图） */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
            {t("an.trend")}
          </CardTitle>
          <CardDescription>{t("an.trendDesc")}</CardDescription>
        </CardHeader>
        <CardContent>
          {data.byDay.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t("common.empty")}</p>
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

      {/* 访问时段（按小时） */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="h-4 w-4 text-muted-foreground" />
            {t("an.hour")}
          </CardTitle>
          <CardDescription>{t("an.hourDesc")}</CardDescription>
        </CardHeader>
        <CardContent>
          {(data.byHour ?? []).length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t("common.empty")}</p>
          ) : (
            <div className="flex h-32 items-end gap-0.5">
              {Array.from({ length: 24 }, (_, h) => {
                const row = (data.byHour ?? []).find((x) => x.hour === h)
                const pv = row?.pv ?? 0
                return (
                  <div key={h} className="group relative flex flex-1 flex-col items-center">
                    <div
                      className="w-full rounded-t bg-primary/70 transition-[height] duration-500 group-hover:bg-primary"
                      style={{ height: `${Math.max((pv / maxHourPv) * 100, pv > 0 ? 4 : 1)}%` }}
                    />
                    <div className="pointer-events-none absolute -top-6 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-foreground px-1.5 py-0.5 text-[10px] text-background group-hover:block">
                      {t("an.hourLabel", { n: h })} · {pv} PV
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          {(data.byHour ?? []).length > 0 && (
            <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
              <span>0:00</span>
              <span>6:00</span>
              <span>12:00</span>
              <span>18:00</span>
              <span>23:00</span>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* 页面热度 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("an.pages")}</CardTitle>
            <CardDescription>{t("an.pagesDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.byPath.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">{t("common.empty")}</p>
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
            <CardTitle className="text-base">{t("an.referrers")}</CardTitle>
            <CardDescription>{t("an.referrersDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.byReferrer.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">{t("common.empty")}</p>
            ) : (
              data.byReferrer.map((r) => (
                <div key={r.referrer} className="flex items-center gap-2 text-xs">
                  <span className="w-40 shrink-0 truncate" title={r.referrer}>
                    {r.referrer === "direct" ? t("an.direct") : r.referrer}
                  </span>
                  <div className="h-3 flex-1 overflow-hidden rounded bg-muted">
                    <div
                      className="h-full rounded bg-primary/60"
                      style={{ width: `${(r.pv / maxRefPv) * 100}%` }}
                    />
                  </div>
                  <span className="w-20 shrink-0 text-right tabular-nums text-muted-foreground">
                    {r.pv} PV · {r.uv ?? 0} UV
                  </span>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {/* 设备分布 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("an.device")}</CardTitle>
            <CardDescription>{t("an.deviceDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {(data.byDevice ?? []).length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">{t("common.empty")}</p>
            ) : (
              data.byDevice.map((d) => (
                <div key={d.ua} className="flex items-center gap-2 text-xs">
                  <span className="w-24 shrink-0">{t(`an.dev.${d.ua}`)}</span>
                  <div className="h-3 flex-1 overflow-hidden rounded bg-muted">
                    <div
                      className="h-full rounded bg-primary/60"
                      style={{ width: `${(d.pv / maxDevicePv) * 100}%` }}
                    />
                  </div>
                  <span className="w-24 shrink-0 text-right tabular-nums text-muted-foreground">
                    {d.pv} PV · {d.uv} UV
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
  const { t } = useT()
  const [tab, setTab] = React.useState<"traffic" | "users">("traffic")
  const [days, setDays] = React.useState("7")

  const tabs: { key: "traffic" | "users"; label: string }[] = [
    { key: "traffic", label: t("an.tab.traffic") },
    { key: "users", label: t("an.tab.users") },
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
            <SelectItem value="7">{t("an.days7")}</SelectItem>
            <SelectItem value="30">{t("an.days30")}</SelectItem>
            <SelectItem value="90">{t("an.days90")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {tab === "traffic" ? <TrafficPanel days={days} /> : <UserAnalyticsPanel days={days} />}
    </div>
  )
}
