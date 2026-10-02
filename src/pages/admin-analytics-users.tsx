/**
 * 管理面板 → 网站统计 →「用户数据」分页。
 *
 * 独立文件（同 admin-feedback.tsx 的考量）：admin-analytics.tsx 只负责 Tab 与
 * 访问统计，这块内容多（开通率 / 构成 / 趋势 / 资源 / 捐献 / 社区），分开更好维护。
 *
 * 图表全部**不引第三方库**：环形用 SVG stroke-dasharray、饼图用 CSS conic-gradient、
 * 柱状图用 flex 高度。数据量是「几百个用户」级别，引 Chart.js 既不值当也拖慢首屏。
 *
 * 配色遵循站点「黑白灰 + 暖橙」：主色橙，其余用中性灰阶 + 少量琥珀/绿做区分，
 * 不用蓝（用户明确说过蓝色不搭）。
 */
import * as React from "react"
import { toast } from "sonner"
import {
  Activity,
  AlertCircle,
  Database,
  Gift,
  HeartPulse,
  Mail,
  MessageSquare,
  Server,
  ShieldCheck,
  TrendingUp,
  UserPlus,
  Users,
} from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { LoadingBlock } from "@/components/loading-block"
import { analyticsApi, errMsg } from "@/services/api"
import { formatBytes } from "@/lib/format"
import type { UserAnalytics } from "@/types"
import { useT } from "@/i18n"

/** 模块 → 环形图颜色 */
const FEATURE_COLORS: Record<string, string> = {
  ai: "#f97316",
  r2: "#f59e0b",
  frp: "#22c55e",
  proxy: "#64748b",
  profile: "#78716c",
}

/** 角色 / 状态 → 中文标签（系统级固定枚举，前端映射即可） */
const ROLE_LABELS: Record<string, string> = {
  user: "au2.role.user",
  admin: "au.role.admin",
  root: "au.role.root",
}
const STATUS_LABELS: Record<string, string> = {
  active: "au2.status.active",
  banned: "au2.status.banned",
  suspended: "au2.status.suspended",
  pending: "au2.status.pending",
}

/** 饼图配色：主色橙 + 中性灰阶 */
const PIE_COLORS = ["#f97316", "#a1a1aa", "#71717b", "#52525b", "#d4d4d8"]

/** 百分比环形：percent 0-100 */
function Ring({ percent, color }: { percent: number; color: string }) {
  const r = 30
  const c = 2 * Math.PI * r
  const offset = c * (1 - Math.min(Math.max(percent, 0), 100) / 100)
  return (
    <svg viewBox="0 0 80 80" className="h-20 w-20 -rotate-90">
      <circle cx="40" cy="40" r={r} fill="none" strokeWidth="9" className="stroke-muted" />
      <circle
        cx="40"
        cy="40"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="9"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={offset}
      />
    </svg>
  )
}

/** 环形 + 中间百分比 + 下方说明 */
function RingStat({
  percent,
  count,
  label,
  color,
}: {
  percent: number
  count: number
  label: string
  color: string
}) {
  const { t } = useT()
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-lg border p-3">
      <div className="relative">
        <Ring percent={percent} color={color} />
        <span className="absolute inset-0 flex items-center justify-center text-sm font-semibold tabular-nums">
          {percent}%
        </span>
      </div>
      <span className="text-xs font-medium">{label}</span>
      <span className="text-[11px] tabular-nums text-muted-foreground">{t("au2.people", { n: count })}</span>
    </div>
  )
}

/** 饼图（conic-gradient）+ 图例 */
function PieLegend({
  items,
  colors,
  labelOf,
}: {
  items: { key: string; count: number; percent: number }[]
  colors: string[]
  labelOf: (key: string) => string
}) {
  const { t } = useT()
  const total = items.reduce((a, b) => a + b.percent, 0)
  let acc = 0
  const stops = items
    .map((d, i) => {
      const from = acc
      acc += total > 0 ? (d.percent / total) * 100 : 0
      return `${colors[i % colors.length]} ${from}% ${acc}%`
    })
    .join(", ")

  if (items.length === 0) {
    return <p className="py-4 text-center text-sm text-muted-foreground">{t("common.empty")}</p>
  }

  return (
    <div className="flex items-center gap-5">
      <div
        className="h-28 w-28 shrink-0 rounded-full"
        style={{ background: `conic-gradient(${stops})` }}
      />
      <div className="min-w-0 space-y-2 text-xs">
        {items.map((d, i) => (
          <div key={d.key} className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ background: colors[i % colors.length] }}
            />
            <span className="truncate">{labelOf(d.key)}</span>
            <span className="tabular-nums text-muted-foreground">
              {d.count}（{d.percent}%）
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** 横向条形榜 */
function BarList({
  items,
  labelOf,
  color,
}: {
  items: { key: string; label?: string; count: number }[]
  labelOf: (key: string) => string
  color: string
}) {
  const { t } = useT()
  const max = Math.max(1, ...items.map((i) => i.count))
  if (items.length === 0) {
    return <p className="py-4 text-center text-sm text-muted-foreground">{t("common.empty")}</p>
  }
  return (
    <div className="space-y-2">
      {items.map((it) => (
        <div key={it.key} className="flex items-center gap-2 text-xs">
          <span className="w-24 shrink-0 truncate" title={it.label ?? labelOf(it.key)}>
            {it.label ?? labelOf(it.key)}
          </span>
          <div className="h-3.5 flex-1 overflow-hidden rounded bg-muted">
            <div
              className="h-full rounded transition-[width] duration-500"
              style={{ width: `${(it.count / max) * 100}%`, background: color }}
            />
          </div>
          <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">
            {it.count}
          </span>
        </div>
      ))}
    </div>
  )
}

/** 柱状趋势图（新增用户） */
function ColumnChart({ data }: { data: { date: string; count: number }[] }) {
  const { t } = useT()
  if (data.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        {t("au2.noNewUsers")}
      </p>
    )
  }
  const max = Math.max(1, ...data.map((d) => d.count))
  return (
    <div className="flex h-32 items-end gap-1">
      {data.map((d) => (
        <div key={d.date} className="group relative flex-1">
          <div
            className="w-full rounded-t bg-primary/70 transition-[height] duration-500 group-hover:bg-primary"
            style={{ height: `${Math.max((d.count / max) * 100, 3)}%` }}
          />
          <div className="pointer-events-none absolute -top-6 left-1/2 hidden -translate-x-1/2 rounded bg-foreground px-1.5 py-0.5 text-[10px] text-background group-hover:block">
            {d.date.slice(5)} · {d.count}
          </div>
        </div>
      ))}
    </div>
  )
}

/** 一个数字指标 */
function Metric({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: React.ElementType
  label: string
  value: string | number
  hint?: string
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <p className="mt-1.5 text-xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </Card>
  )
}

export function UserAnalyticsPanel({ days }: { days: string }) {
  const { t } = useT()
  const [data, setData] = React.useState<UserAnalytics | null>(null)
  const [loading, setLoading] = React.useState(true)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      setData(await analyticsApi.users(Number(days)))
    } catch (err) {
      toast.error(errMsg(err, t("au2.err.load")))
    } finally {
      setLoading(false)
    }
  }, [days])

  React.useEffect(() => {
    void load()
  }, [load])

  if (loading && !data) return <LoadingBlock />
  if (!data) return null

  const res = data.resources
  const don = data.donations
  const com = data.community
  const rt = data.retention
  const more = data.more ?? []
  const storagePercent =
    res.storageQuotaBytes > 0
      ? Math.round((res.storageUsedBytes / res.storageQuotaBytes) * 1000) / 10
      : 0
  const newTotal = data.newByDay.reduce((a, b) => a + b.count, 0)

  return (
    <div className="space-y-6">
      {/* 概览指标 */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric icon={Users} label={t("au2.metric.total")} value={data.total} hint={t("au2.metric.totalHint", { n: data.byRole.length })} />
        <Metric icon={UserPlus} label={t("au2.metric.new", { n: days })} value={newTotal} />
        <Metric
          icon={ShieldCheck}
          label={t("au2.metric.verified")}
          value={`${data.verifiedPercent}%`}
          hint={t("au2.metric.verifiedHint", { a: data.verified, b: data.total })}
        />
        <Metric
          icon={Gift}
          label={t("au2.metric.donors")}
          value={`${don.donorsPercent}%`}
          hint={t("au2.metric.donorsHint", { n: don.donors, total: don.total })}
        />
      </div>

      {/* 用户存活率（口径：最近一周内登录过 = 存活） */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <HeartPulse className="h-4 w-4 text-muted-foreground" />
            {t("au2.alive.title")}
          </CardTitle>
          <CardDescription>
            {t("au2.alive.desc", { n: data.total })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex flex-wrap items-center justify-around gap-4">
            <RingStat
              percent={rt.alive7dPercent}
              count={rt.alive7d}
              label={t("au2.alive.d7")}
              color="#22c55e"
            />
            <RingStat
              percent={rt.alive1dPercent}
              count={rt.alive1d}
              label={t("au2.alive.d1")}
              color="#f97316"
            />
            <RingStat
              percent={rt.alive30dPercent}
              count={rt.alive30d}
              label={t("au2.alive.d30")}
              color="#78716c"
            />
          </div>

          {/* 最后登录时间分布 */}
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              {t("au2.lastLogin.title")}
            </p>
            <div className="space-y-1.5">
              {rt.buckets.map((b) => (
                <div key={b.label} className="flex items-center gap-2 text-xs">
                  <span className="w-20 shrink-0 text-muted-foreground">{b.label}</span>
                  <div className="h-3.5 flex-1 overflow-hidden rounded bg-muted">
                    <div
                      className="h-full rounded bg-emerald-500/70 transition-[width] duration-500"
                      style={{ width: `${Math.min(b.percent, 100)}%` }}
                    />
                  </div>
                  <span className="w-24 shrink-0 text-right tabular-nums text-muted-foreground">
                    {t("au2.lastLogin.bucket", { n: b.count, pct: b.percent })}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
            <span>
              {t("au2.newUsers.a", { n: rt.newUsers.registered })}
              {t("au2.newUsers.b", { n: rt.newUsers.loggedIn })}
              （{rt.newUsers.percent}%）
            </span>
            <span>
              {t("au2.neverLoggedIn", { n: rt.neverLoggedIn })}
            </span>
          </div>

          <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
            <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
            {rt.caveat}
          </p>
        </CardContent>
      </Card>

      {/* 功能开通率（核心：百分之多少的用户开通了什么） */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4 text-muted-foreground" />
            {t("au2.features.title")}
          </CardTitle>
          <CardDescription>
            {t("au2.features.desc", { n: data.total })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {data.features.map((f) => (
              <RingStat
                key={f.key}
                percent={f.percent}
                count={f.count}
                label={f.label}
                color={FEATURE_COLORS[f.key] ?? "#a1a1aa"}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* 用户构成 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("au2.roles.title")}</CardTitle>
            <CardDescription>{t("au2.roles.desc")}</CardDescription>
          </CardHeader>
          <CardContent>
            <PieLegend
              items={data.byRole}
              colors={PIE_COLORS}
              labelOf={(k) => t(ROLE_LABELS[k] ?? k)}
            />
          </CardContent>
        </Card>

        {/* 账号状态 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("au2.statuses.title")}</CardTitle>
            <CardDescription>{t("au2.statuses.desc")}</CardDescription>
          </CardHeader>
          <CardContent>
            <PieLegend
              items={data.byStatus}
              colors={PIE_COLORS}
              labelOf={(k) => t(STATUS_LABELS[k] ?? k)}
            />
          </CardContent>
        </Card>
      </div>

      {/* 新增用户趋势 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
            {t("au2.trend.title")}
          </CardTitle>
          <CardDescription>{t("au2.trend.desc", { n: days })}</CardDescription>
        </CardHeader>
        <CardContent>
          <ColumnChart data={data.newByDay} />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* 捐献分布 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Gift className="h-4 w-4 text-muted-foreground" />
              {t("au2.donTypes.title")}
            </CardTitle>
            <CardDescription>
              {t("au2.donTypes.desc", { n: don.total, auto: don.autoReviewed })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BarList items={don.byType} labelOf={(k) => k} color="#f97316" />
          </CardContent>
        </Card>

        {/* 捐献状态 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("au2.donStatus.title")}</CardTitle>
            <CardDescription>{t("au2.donStatus.desc")}</CardDescription>
          </CardHeader>
          <CardContent>
            <BarList items={don.byStatus} labelOf={(k) => k} color="#f59e0b" />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* 资源占用 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Database className="h-4 w-4 text-muted-foreground" />
              {t("au2.res.title")}
            </CardTitle>
            <CardDescription>{t("au2.res.desc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              <div className="flex items-center gap-1.5">
                <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                {t("em.title")} <span className="ml-auto tabular-nums">{res.mailboxes}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                {t("em.temp.title")} <span className="ml-auto tabular-nums">{res.tempMailboxes}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Server className="h-3.5 w-3.5 text-muted-foreground" />
                {t("dm.subdomains")} <span className="ml-auto tabular-nums">{res.subdomains}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Server className="h-3.5 w-3.5 text-muted-foreground" />
                {t("dm.recordCount", { n: res.dnsRecords })}
              </div>
              <div className="flex items-center gap-1.5">
                <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                {t("cm.stats.total")} <span className="ml-auto tabular-nums">{res.posts}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                {t("space.stat.comments")} <span className="ml-auto tabular-nums">{res.comments}</span>
              </div>
            </div>
            <div>
              <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                <span>{t("au2.res.storage")}</span>
                <span className="tabular-nums">
                  {formatBytes(res.storageUsedBytes)} / {formatBytes(res.storageQuotaBytes)}（
                  {storagePercent}%）
                </span>
              </div>
              <div className="h-3.5 overflow-hidden rounded bg-muted">
                <div
                  className="h-full rounded bg-primary/70 transition-[width] duration-500"
                  style={{ width: `${Math.min(storagePercent, 100)}%` }}
                />
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                {t("au2.res.avgMailboxes", { n: res.avgMailboxes })}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* 社区活跃度 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
              {t("au2.community.title")}
            </CardTitle>
            <CardDescription>{t("au2.community.desc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-4">
              <RingStat
                percent={com.authorsPercent}
                count={com.authors}
                label={t("au2.community.posted")}
                color="#f97316"
              />
              <RingStat
                percent={com.commentersPercent}
                count={com.commenters}
                label={t("au2.community.commented")}
                color="#64748b"
              />
            </div>
            <div className="grid grid-cols-3 gap-2 text-center text-xs">
              <div className="rounded-md border p-2">
                <p className="text-base font-semibold tabular-nums">{res.posts}</p>
                <p className="text-muted-foreground">{t("space.stat.posts")}</p>
              </div>
              <div className="rounded-md border p-2">
                <p className="text-base font-semibold tabular-nums">{res.comments}</p>
                <p className="text-muted-foreground">{t("space.stat.comments")}</p>
              </div>
              <div className="rounded-md border p-2">
                <p className="text-base font-semibold tabular-nums">{res.likes}</p>
                <p className="text-muted-foreground">{t("space.stat.likes")}</p>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {t("au2.profile.title", { nick: data.nickname, avatar: data.avatar, pct: data.invitedPercent, invited: data.invited })}
            </p>
          </CardContent>
        </Card>

        {/* 更多数据：跨模块补充指标（标签由服务端下发） */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Database className="h-4 w-4 text-muted-foreground" />
              {t("au2.more.title")}
            </CardTitle>
            <CardDescription>{t("au2.more.desc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {more.map((g) => (
              <div key={g.group}>
                <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
                  {g.group}
                </p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                  {g.items.map((it) => (
                    <div key={it.label} className="rounded-md border p-2">
                      <p className="text-base font-semibold tabular-nums">
                        {it.value.toLocaleString()}
                      </p>
                      <p
                        className="truncate text-xs text-muted-foreground"
                        title={it.hint ?? it.label}
                      >
                        {it.label}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
