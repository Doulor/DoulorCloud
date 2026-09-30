/**
 * 管理面板 → Cloudflare 额度。
 *
 * 独立文件（同 admin-analytics.tsx 的考量）：admin.tsx 已 5900+ 行，
 * 且有其他改动可能在动它。UI 本体放这里，admin.tsx 只插 2 行挂载。
 *
 * 图形化做法：**纯 CSS 占用条 + 纯 CSS/SVG 环形图 + 纯 CSS 柱状图**，不引图表库
 * （数据量小，够用且不给打包体积添负担）。
 *
 * ⚠️ 四条展示原则：
 *   a. **读不到的项要显示原因**，不能显示成 0% —— 那会让人误以为「用得很省」。
 *   b. **免费版与付费版的「上限」不是一回事，配色必须分开**：
 *        免费版 = 每日硬上限，撞上直接中断服务 → 危险色（绿/黄/红）；
 *        付费版 = 套餐内含的量，超出只**产生费用**、不会断服 → 费用色（蓝，超 100% 才转琥珀）。
 *      把付费版的月含量画成红色告警，会让站长以为站点要挂了（这是本次改动的起因）。
 *   c. **套餐判定要如实说明依据**，并给出手动纠正入口 —— 自动判定可能只是「无法确认」。
 *   d. 所有额度口径（每天 / 每月 / 不重置）都写在卡片上，避免「这个数字是什么周期」的疑惑。
 */
import * as React from "react"
import { toast } from "sonner"
import { AlertTriangle, Check, CircleDollarSign, RefreshCw, Wand2 } from "lucide-react"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { LoadingBlock } from "@/components/loading-block"
import { adminApi, errMsg } from "@/services/api"
import { fmtDateTime, formatBytes, formatBytesShort } from "@/lib/format"
import type { CfQuotaHighlight, CfQuotaItem, CfQuotaOverview, CfPlanSource } from "@/types"

/** 千分位整数 */
function fmtNum(n: number): string {
  return n.toLocaleString("zh-CN")
}

/** 按单位渲染用量：字节走 formatBytes，其余走千分位 */
function fmtUsed(value: number, unit: CfQuotaItem["unit"]): string {
  return unit === "字节" ? formatBytes(value) : fmtNum(value)
}

/** 美元金额（小额保留 4 位，避免 $0.0004 被显示成 $0.00） */
function fmtUsd(v: number): string {
  if (v === 0) return "$0.00"
  if (Math.abs(v) < 0.01) return `$${v.toFixed(4)}`
  return `$${v.toFixed(2)}`
}

type Urgency = { bar: string; text: string; stroke: string }

/**
 * 占用率 → 配色。
 * `hard`：超 85% 红（就要断了）；`included`：超 100% 才转琥珀（只是在花钱）。
 */
function urgencyOf(percent: number, kind: "hard" | "included" | null): Urgency {
  if (kind === "included") {
    if (percent >= 100) return { bar: "bg-amber-500", text: "text-amber-600", stroke: "stroke-amber-500" }
    if (percent >= 80) return { bar: "bg-sky-500", text: "text-sky-600", stroke: "stroke-sky-500" }
    return { bar: "bg-sky-500", text: "text-sky-600", stroke: "stroke-sky-500" }
  }
  if (percent >= 85) return { bar: "bg-red-500", text: "text-red-600", stroke: "stroke-red-500" }
  if (percent >= 60) return { bar: "bg-amber-500", text: "text-amber-600", stroke: "stroke-amber-500" }
  return { bar: "bg-emerald-500", text: "text-emerald-600", stroke: "stroke-emerald-500" }
}

/** 最近 N 天用量的小柱状图（纯 CSS，按自身最大值归一） */
function MiniBars({ item }: { item: CfQuotaItem }) {
  const history = item.history ?? []
  if (history.length < 2) return null
  const max = Math.max(1, ...history.map((h) => h.value))
  const cls = urgencyOf(
    item.limit ? (Math.max(...history.map((h) => h.value)) / item.limit) * 100 : 0,
    item.limitKind
  )
  return (
    <div className="mt-2">
      <div className="flex h-8 items-end gap-[2px]" title={`最近 ${history.length} 天用量`}>
        {history.map((h) => {
          const pct = (h.value / max) * 100
          return (
            <div
              key={h.date}
              className={`flex-1 rounded-sm ${cls.bar} opacity-60`}
              style={{ height: `${Math.max(4, pct)}%` }}
              title={`${h.date}：${item.unit === "字节" ? formatBytes(h.value) : fmtNum(h.value)}`}
            />
          )
        })}
      </div>
      <div className="mt-0.5 flex justify-between text-[10px] text-muted-foreground">
        <span>{history[0]?.date.slice(5)}</span>
        <span>{history[history.length - 1]?.date.slice(5)}</span>
      </div>
    </div>
  )
}

/**
 * 环形占用图（纯 SVG，无依赖）。
 * 付费版（included）在环心额外显示本项已产生的超额费用 —— 那才是他真正关心的数。
 */
function Ring({ item }: { item: CfQuotaHighlight }) {
  const percent = item.percent
  const shown = Math.min(100, percent)
  const R = 32
  const C = 2 * Math.PI * R
  const cls = urgencyOf(percent, item.limitKind)
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative h-20 w-20">
        <svg viewBox="0 0 80 80" className="h-20 w-20">
          <circle
            cx="40"
            cy="40"
            r={R}
            fill="none"
            strokeWidth="7"
            className="stroke-muted"
          />
          <circle
            cx="40"
            cy="40"
            r={R}
            fill="none"
            strokeWidth="7"
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - shown / 100)}
            className={`${cls.stroke} transition-all`}
            transform="rotate(-90 40 40)"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className={`text-sm font-semibold tabular-nums ${cls.text}`}>
            {percent >= 1000 ? ">999%" : `${percent.toFixed(percent >= 100 ? 0 : 1)}%`}
          </span>
          {(item.costUsd ?? 0) > 0 && (
            <span className="text-[10px] text-amber-600">{fmtUsd(item.costUsd)}</span>
          )}
        </div>
      </div>
      <div className="max-w-[92px] truncate text-center text-[11px] font-medium" title={item.label}>
        {item.label}
      </div>
      <div className="text-center text-[10px] text-muted-foreground">
        {fmtUsed(item.used, item.unit)} / {item.unit === "字节" ? formatBytesShort(item.limit) : fmtNum(item.limit)}
      </div>
    </div>
  )
}

/** 单项额度卡片 */
function QuotaRow({ item, paid }: { item: CfQuotaItem; paid: boolean }) {
  // 读不到：明确写原因，不装成 0
  if (item.used == null) {
    return (
      <div className="rounded-md border border-dashed p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">{item.label}</span>
          <Badge variant="outline" className="text-xs">
            读不到
          </Badge>
        </div>
        {item.error && <p className="mt-1 text-xs text-destructive">{item.error}</p>}
        <p className="mt-1 text-[11px] text-muted-foreground">
          该项读不到不影响其它项。{item.period}
        </p>
      </div>
    )
  }

  const percent = item.limit && item.limit > 0 ? (item.used / item.limit) * 100 : null
  const cls = percent != null ? urgencyOf(percent, item.limitKind) : null
  const usedText = fmtUsed(item.used, item.unit)
  const limitText =
    item.limit == null
      ? null
      : item.unit === "字节"
        ? formatBytesShort(item.limit)
        : fmtNum(item.limit)

  return (
    <div className="rounded-md border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        <span className="text-sm font-medium">{item.label}</span>
        <span className="font-mono text-xs">
          <span className={cls ? cls.text : ""}>{usedText}</span>
          {limitText && <span className="text-muted-foreground"> / {limitText}</span>}
          {item.unit !== "字节" && <span className="text-muted-foreground"> {item.unit}</span>}
          {percent != null && (
            <span className={`ml-2 ${cls?.text ?? ""}`}>
              {percent >= 1000 ? ">999%" : `${percent.toFixed(2)}%`}
            </span>
          )}
        </span>
      </div>

      {percent != null && (
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full transition-all ${cls?.bar ?? "bg-sky-500"}`}
            style={{ width: `${Math.max(percent > 0 ? 1 : 0, Math.min(100, percent))}%` }}
          />
        </div>
      )}

      {item.note && <p className="mt-1 text-[11px] text-muted-foreground">{item.note}</p>}
      <p className="mt-1 text-[11px] text-muted-foreground">{item.period}</p>
      {paid && (item.costUsd ?? 0) > 0 && (
        <p className="mt-1 text-[11px] font-medium text-amber-600">
          本项已超额，估算 {fmtUsd(item.costUsd as number)}
          {item.overageNote ? `（${item.overageNote}）` : ""}
        </p>
      )}
      {!paid && item.paidNote && (
        <p className="mt-1 text-[11px] text-sky-600">💡 {item.paidNote}</p>
      )}
      <MiniBars item={item} />
    </div>
  )
}

const PLAN_SOURCE_TEXT: Record<CfPlanSource, string> = {
  manual: "手动指定",
  subscription: "订阅接口",
  usage: "用量推断",
  default: "未能确认，默认按免费版",
}

/** 套餐选择器 —— 自动判定可能落到「无法确认」，必须给手动纠正的入口 */
function PlanPicker({
  current,
  onSaved,
}: {
  current: string
  onSaved: (fresh: boolean) => void
}) {
  const [saving, setSaving] = React.useState<string | null>(null)
  const options: { value: string; label: string; hint: string }[] = [
    { value: "auto", label: "自动判定", hint: "先读订阅接口，读不到再用用量反证" },
    { value: "free", label: "免费版", hint: "按「每天」的硬上限显示" },
    { value: "paid", label: "付费版", hint: "按「每月」的套餐含量 + 费用显示" },
  ]
  const save = async (value: string) => {
    if (value === current) return
    setSaving(value)
    try {
      await adminApi.updateSettings({ cf_plan: value })
      toast.success("套餐已更新，正在重新读取额度…")
      onSaved(true)
    } catch (err) {
      toast.error(errMsg(err, "保存套餐失败"))
    } finally {
      setSaving(null)
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">额度口径：</span>
      {options.map((o) => {
        const active = o.value === current
        return (
          <Button
            key={o.value}
            variant={active ? "default" : "outline"}
            size="sm"
            className="h-7 px-2.5 text-xs"
            disabled={saving !== null}
            onClick={() => void save(o.value)}
            title={o.hint}
          >
            {saving === o.value ? (
              <RefreshCw className="h-3 w-3 animate-spin" />
            ) : active ? (
              <Check className="h-3 w-3" />
            ) : null}
            {o.label}
          </Button>
        )
      })}
    </div>
  )
}

export function CfQuotaPanel() {
  const [data, setData] = React.useState<CfQuotaOverview | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [refreshing, setRefreshing] = React.useState(false)

  const load = React.useCallback(async (fresh = false) => {
    if (fresh) setRefreshing(true)
    else setLoading(true)
    try {
      setData(await adminApi.cloudflareQuota(fresh))
    } catch (err) {
      toast.error(errMsg(err, "加载 Cloudflare 额度失败"))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  if (loading || !data) return <LoadingBlock />

  const paid = data.plan === "paid"
  const planLabel = paid ? "付费版 Workers Paid" : "免费版 Free"

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={paid ? "default" : "outline"} className="text-xs">
              {planLabel}
            </Badge>
            <span className="text-[11px] text-muted-foreground">
              判定依据：{PLAN_SOURCE_TEXT[data.planSource] ?? data.planSource}
            </span>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">{data.planNote}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            上限对照官方文档（核对于 2026-09-30）；用量数据来自分析接口，可能有几分钟延迟。
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            账号 {data.accountId} · 读取于 {fmtDateTime(data.generatedAt)}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load(true)}
          disabled={refreshing}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          刷新
        </Button>
      </div>

      <div className="rounded-md border p-3">
        <PlanPicker current={data.planSetting} onSaved={(f) => void load(f)} />
        <p className="mt-2 text-[11px] text-muted-foreground">
          免费版是<span className="font-medium text-foreground">每天</span>的硬上限，撞上就直接中断服务（站点会挂）；
          付费版是<span className="font-medium text-foreground">每月</span>的套餐含量，超出只按量计费、不会断服。
          所以两套数字必须选对 —— 选错会误报红色告警，或把真正会中断的上限藏起来。
        </p>
      </div>

      {paid && data.estimatedCostUsd != null && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <CircleDollarSign className="h-4 w-4" />
              本月估算费用
              <span className="font-mono text-lg text-primary">
                {fmtUsd(data.estimatedCostUsd)}
              </span>
            </CardTitle>
            <CardDescription className="text-xs">
              含 $5 月度订阅底价 + 各项超额。这是<span className="font-medium text-foreground">估算</span>：
              Cloudflare 对用量按计费单位向上取整，且 CPU 时间、日志写入等未采集的计量项不在这里，
              真实账单以 Cloudflare 后台为准。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            {data.costBreakdown.map((c) => (
              <div
                key={c.label}
                className="flex items-baseline justify-between gap-3 border-b border-dashed py-1 text-xs last:border-0"
              >
                <span className="min-w-0">
                  <span className="font-medium">{c.label}</span>
                  {c.detail && (
                    <span className="ml-2 text-muted-foreground">{c.detail}</span>
                  )}
                </span>
                <span className="shrink-0 font-mono tabular-nums">{fmtUsd(c.usd)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {data.highlights.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">额度占用总览</CardTitle>
            <CardDescription className="text-xs">
              {paid
                ? "按「本月至今 / 套餐含量」计算，占比越高说明越快进入计费区（付费版超量不会中断服务）。"
                : "按「今天 / 每日上限」计算，占比越高越快撞到硬上限（撞上后服务直接失败）。"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap justify-start gap-x-6 gap-y-4">
              {data.highlights.map((h) => (
                <Ring key={h.key} item={h} />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {data.warnings.length > 0 && (
        <div className="space-y-2">
          {data.warnings.map((w) => (
            <div
              key={w}
              className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}

      {data.groups.map((group) => (
        <Card key={group.key}>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{group.label}</CardTitle>
            <CardDescription className="text-xs">{group.description}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {group.items.map((item) => (
              <QuotaRow key={item.key} item={item} paid={paid} />
            ))}
          </CardContent>
        </Card>
      ))}

      <div className="flex gap-2 rounded-md border border-dashed p-3 text-[11px] text-muted-foreground">
        <Wand2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="space-y-1">
          <p>
            <span className="font-medium text-foreground">降低用量的三处抓手（按本项目的实际影响排序）：</span>
          </p>
          <p>1. 前端轮询频率 —— 聊天室/收件箱的定时刷新是请求数的最大来源，降频比优化接口划算得多。</p>
          <p>2. D1 行读 —— 加索引、避免全表扫描；漏了索引的查询会按**扫描行数**计费，不是返回行数。</p>
          <p>3. R2 Class B —— 图片/附件的读取次数；能走 CDN 缓存就别直连桶。</p>
        </div>
      </div>
    </div>
  )
}
