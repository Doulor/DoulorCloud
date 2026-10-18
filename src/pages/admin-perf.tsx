/**
 * 管理面板 → 性能监控（2026-10-10 新工具）。
 *
 * 目的：站点功能越来越多，「哪个页面卡」以前只能靠用户反馈猜。这里聚合
 * 真实用户性能样本（RUM，perf_samples 表）：登录用户浏览各页面时的
 * 加载耗时（TTFB/LCP）、路由切换耗时、长任务与 JS 报错计数。
 * 用它定位「哪个功能导致的卡顿」，再配合反馈附带的诊断日志看现场。
 *
 * 采集侧由 src/lib/perf-collect.ts 完成（sendBeacon、站点开关 perf_collect_enabled
 * 控制，默认关）；这里只读聚合结果。
 *
 * 图表不引入重库（同 admin-analytics：纯 CSS 条形图）。
 * 隐私口径与 analytics 一致：不展示用户名 / IP / UA。
 */
import * as React from "react"
import { toast } from "sonner"
import { Activity, AlertTriangle, Gauge, Loader2, MousePointerClick, Timer, Zap } from "lucide-react"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { LoadingBlock } from "@/components/loading-block"
import { EmptyState } from "@/components/empty-state"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { adminApi, errMsg, perfApi } from "@/services/api"
import type { PerfOverview, PerfPageSamples } from "@/types"
import { useT } from "@/i18n"

export function PerfPanel() {
  const { t } = useT()
  const [days, setDays] = React.useState("7")
  const [data, setData] = React.useState<PerfOverview | null>(null)
  const [loading, setLoading] = React.useState(true)
  // 采集开关（站点设置 perf_collect_enabled）：管理页里直接启停
  const [collectOn, setCollectOn] = React.useState<boolean | null>(null)
  const [toggling, setToggling] = React.useState(false)
  /**
   * 诊断日志开关（站点设置 diag_log_enabled）。
   *
   * 2026-10-18 补：PR #67 带了这个设置项、`/api/me` 也会下发，但**只有 perf 的
   * 开关有界面**，诊断日志一直只能在库里手改 —— 等于「反馈附诊断日志」这个
   * 功能站长根本打不开。这里补回 UI，和性能采集放在一起（同属前端可观测性）。
   */
  const [diagOn, setDiagOn] = React.useState<boolean | null>(null)
  const [togglingDiag, setTogglingDiag] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      setData(await perfApi.overview(Number(days)))
    } catch (err) {
      toast.error(errMsg(err, t("perf.err.load")))
    } finally {
      setLoading(false)
    }
  }, [days, t])

  React.useEffect(() => {
    void load()
  }, [load])

  // 进面板时读一次当前开关状态（loadSettings 返回全部设置，取我们关心的键）
  React.useEffect(() => {
    void adminApi
      .getSettings()
      .then((s) => {
        const raw = s as unknown as Record<string, unknown>
        setCollectOn(raw.perf_collect_enabled === "1")
        setDiagOn(raw.diag_log_enabled === "1")
      })
      .catch(() => {
        setCollectOn(null)
        setDiagOn(null)
      })
  }, [])

  const toggleCollect = async (on: boolean) => {
    setToggling(true)
    try {
      await adminApi.updateSettings({ perf_collect_enabled: on })
      setCollectOn(on)
      toast.success(on ? t("perf.collect.on") : t("perf.collect.off"))
    } catch (err) {
      toast.error(errMsg(err, t("perf.collect.err")))
    } finally {
      setToggling(false)
    }
  }

  const toggleDiag = async (on: boolean) => {
    setTogglingDiag(true)
    try {
      await adminApi.updateSettings({ diag_log_enabled: on })
      setDiagOn(on)
      toast.success(on ? t("perf.diag.on") : t("perf.diag.off"))
    } catch (err) {
      toast.error(errMsg(err, t("perf.diag.err")))
    } finally {
      setTogglingDiag(false)
    }
  }

  if (loading || !data) return <LoadingBlock variant="cards" />

  const maxDay = Math.max(1, ...data.byDay.map((d) => d.samples))
  const sortedByLoad = [...data.byPage].sort(
    (a, b) => b.avgTtfb + b.avgNav - (a.avgTtfb + a.avgNav)
  )
  const maxLoad = Math.max(1, ...sortedByLoad.map((p) => p.avgTtfb + p.avgNav))

  const summaryCards = [
    { icon: Activity, label: t("perf.samples"), full: "", value: data.summary.samples },
    {
      icon: Timer,
      label: t("perf.avgTtfb"),
      full: t("perf.avgTtfbFull"),
      value: `${data.summary.avgTtfb}ms`,
    },
    { icon: Gauge, label: t("perf.avgLcp"), full: t("perf.avgLcpFull"), value: `${data.summary.avgLcp}ms` },
    {
      icon: MousePointerClick,
      label: t("perf.avgNav"),
      full: t("perf.avgNavFull"),
      value: `${data.summary.avgNav}ms`,
    },
    { icon: Zap, label: t("perf.longTasks"), full: t("perf.longTasksFull"), value: data.summary.longTasks },
    { icon: AlertTriangle, label: t("perf.errors"), full: t("perf.errorsFull"), value: data.summary.errors },
  ]

  return (
    <div className="space-y-6">
      {/* 头部：天数选择 + 采集开关 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">{t("perf.days1")}</SelectItem>
              <SelectItem value="7">{t("perf.days7")}</SelectItem>
              <SelectItem value="14">{t("perf.days14")}</SelectItem>
              <SelectItem value="30">{t("perf.days30")}</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {t("common.refresh")}
          </Button>
        </div>
        <div className="flex items-center gap-2.5">
          <Label htmlFor="perfCollect" className="text-sm text-muted-foreground">
            {t("perf.collect.label")}
          </Label>
          {collectOn === null ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <Switch
              id="perfCollect"
              checked={collectOn}
              disabled={toggling}
              onCheckedChange={(v) => void toggleCollect(v)}
            />
          )}
        </div>
        <div className="flex items-center gap-2.5">
          <Label htmlFor="diagLog" className="text-sm text-muted-foreground">
            {t("perf.diag.label")}
          </Label>
          {diagOn === null ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <Switch
              id="diagLog"
              checked={diagOn}
              disabled={togglingDiag}
              onCheckedChange={(v) => void toggleDiag(v)}
            />
          )}
        </div>
      </div>

      {collectOn === false && (
        <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {t("perf.collect.hintOff")}
        </p>
      )}
      {diagOn === false && (
        <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {t("perf.diag.hintOff")}
        </p>
      )}

      {/* 总览卡 */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {summaryCards.map((card) => (
          <Card key={card.label} className="px-5 py-4">
            <div className="flex items-center gap-3">
              <card.icon className="h-5 w-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground" title={card.full || card.label}>
                  {card.label}
                </p>
                <p className="text-2xl font-semibold tabular-nums">{card.value}</p>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {data.summary.samples === 0 ? (
        <EmptyState
          icon={Activity}
          title={t("perf.empty.title")}
          description={t("perf.empty.desc")}
        />
      ) : (
        <>
          {/* 趋势 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Activity className="h-4 w-4 text-muted-foreground" />
                {t("perf.trend")}
              </CardTitle>
              <CardDescription>{t("perf.trendDesc")}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-1.5">
                {data.byDay.map((d) => (
                  <div key={d.day} className="flex items-center gap-2 text-xs">
                    <span className="w-14 shrink-0 text-muted-foreground">{d.day.slice(5)}</span>
                    <div className="h-4 flex-1 overflow-hidden rounded bg-muted">
                      <div
                        className="h-full rounded bg-primary/70"
                        style={{ width: `${(d.samples / maxDay) * 100}%` }}
                      />
                    </div>
                    <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">
                      {d.samples}
                    </span>
                    <span className="w-24 shrink-0 text-right tabular-nums text-muted-foreground/60">
                      LCP {d.avgLcp}ms
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* 页面榜：按平均加载（TTFB+切换）排序 */}
          <PageList
            pages={sortedByLoad}
            maxLoad={maxLoad}
            title={t("perf.byPage")}
            desc={t("perf.byPageDesc")}
          />

          {/* 设备分布 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("perf.byDevice")}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-4 text-sm">
                {data.byDevice.map((d) => (
                  <span key={d.device} className="flex items-center gap-1.5">
                    <span
                      className={
                        "inline-block h-2.5 w-2.5 rounded-full " +
                        (d.device === "mobile" ? "bg-amber-500/80" : "bg-sky-500/80")
                      }
                    />
                    {d.device === "mobile" ? t("perf.mobile") : t("perf.desktop")}
                    <span className="tabular-nums text-muted-foreground">{d.samples}</span>
                  </span>
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

/** 页面性能榜（含明细展开：点开看这个页面每次加载的原始样本） */
function PageList({
  pages,
  maxLoad,
  title,
  desc,
}: {
  pages: PerfOverview["byPage"]
  maxLoad: number
  title: string
  desc: string
}) {
  const { t } = useT()
  const [openPage, setOpenPage] = React.useState<string | null>(null)
  const [samples, setSamples] = React.useState<PerfPageSamples | null>(null)
  const [samplesLoading, setSamplesLoading] = React.useState(false)

  const openDetail = async (page: string) => {
    if (openPage === page) {
      setOpenPage(null)
      return
    }
    setOpenPage(page)
    setSamplesLoading(true)
    try {
      setSamples(await perfApi.pageSamples(page, 7))
    } catch (err) {
      toast.error(errMsg(err, t("perf.err.load")))
      setOpenPage(null)
    } finally {
      setSamplesLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{desc}</CardDescription>
      </CardHeader>
      <CardContent>
        {pages.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t("common.empty")}</p>
        ) : (
          <div className="space-y-1">
            {pages.map((p) => {
              const loadMs = p.avgTtfb + p.avgNav
              const slow = loadMs > 1500 || p.avgLcp > 2500
              return (
                <div key={p.page}>
                  <button
                    type="button"
                    onClick={() => void openDetail(p.page)}
                    className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-xs hover:bg-accent/50"
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      title={slow ? t("perf.slowFlag") : undefined}
                      style={{ background: slow ? "#f59e0b" : "#10b981" }}
                    />
                    <span className="w-56 shrink-0 truncate font-mono" title={p.page}>
                      {p.page}
                    </span>
                    <div className="h-3.5 flex-1 overflow-hidden rounded bg-muted">
                      <div
                        className={slow ? "h-full rounded bg-amber-500/70" : "h-full rounded bg-primary/60"}
                        style={{ width: `${(loadMs / maxLoad) * 100}%` }}
                      />
                    </div>
                    <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
                      {loadMs}ms
                    </span>
                    <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground/60">
                      LCP {p.avgLcp}
                    </span>
                    <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground/60">
                      ×{p.samples}
                    </span>
                    {p.longTasks > 0 && (
                      <span
                        className="w-14 shrink-0 text-right tabular-nums text-amber-600 dark:text-amber-400"
                        title={t("perf.longTasks")}
                      >
                        ⚡{p.longTasks}
                      </span>
                    )}
                    {p.errors > 0 && (
                      <span
                        className="w-14 shrink-0 text-right tabular-nums text-red-600 dark:text-red-400"
                        title={t("perf.errors")}
                      >
                        ✕{p.errors}
                      </span>
                    )}
                  </button>
                  {openPage === p.page && (
                    <div className="my-2 rounded-md border bg-muted/20 p-3">
                      {samplesLoading ? (
                        <LoadingBlock variant="list" />
                      ) : (
                        <div className="max-h-64 space-y-0.5 overflow-y-auto font-mono text-[11px]">
                          {samples?.samples.map(
                            (s, i) => (
                              <div key={i} className="flex gap-3 text-muted-foreground">
                                <span className="w-32 shrink-0">{s.createdAt.slice(5, 16).replace("T", " ")}</span>
                                <span className="w-20 shrink-0 tabular-nums">
                                  {s.ttfbMs != null ? `TTFB ${s.ttfbMs}ms` : "—"}
                                </span>
                                <span className="w-20 shrink-0 tabular-nums">
                                  {s.lcpMs != null ? `LCP ${s.lcpMs}ms` : "—"}
                                </span>
                                <span className="w-20 shrink-0 tabular-nums">
                                  {s.navMs != null ? `${t("perf.navLabel")} ${s.navMs}ms` : ""}
                                </span>
                                <span className="w-16 shrink-0 tabular-nums">
                                  {t("perf.longLabel", { n: s.longTasks })}
                                </span>
                                <span className="w-14 shrink-0 tabular-nums">
                                  {t("perf.errLabel", { n: s.errors })}
                                </span>
                                <span className="w-14 shrink-0">
                                  {s.device === "mobile" ? t("perf.mobile") : t("perf.desktop")}
                                </span>
                              </div>
                            )
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

