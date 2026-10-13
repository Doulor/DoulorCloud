import * as React from "react"
import { Link } from "react-router-dom"
import { AlertTriangle, Loader2, ShieldAlert } from "lucide-react"
import { toast } from "sonner"

import { CollectionAside } from "@/components/collection-nav"
import { PageHeader } from "@/components/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useT } from "@/i18n"
import {
  adminCollectionApi,
  errMsg,
  HttpError,
  type GameAdminData,
  type PoolLedgerEntry,
} from "@/services/api"

/**
 * 造物典藏 —— **典藏设置**（管理端，按典藏项目分类）。
 *
 * 布局刻意是「一节一个典藏项目」的骨架：v1 只有「在线投资」一节，
 * 将来别的游戏各加一节即可，不用重排页面。每个项目内部又是同构的几块：
 * 玩法参数 / 资金池 / 全服统计 / 危险操作。
 *
 * 两件事刻意分开：
 *   · **玩法参数**走 `app_settings`（受 `check-settings.mjs` 守护「每个键都真的被读到」）；
 *   · **上架状态**走 `collection_plugins`（那是运营状态，与玩法无关）。
 * 混在一起的话，「把游戏下架」会顺手把参数也改了。
 *
 * 保存时**只提交改动过的字段**：服务端把 patch 合到当前值上再清洗，
 * 全量提交会把没动过的输入重置成默认（改个手续费把杠杆上限改回 20，很难发现）。
 */

/** 玩法参数字段表（键名与 settings.ts 的 game_* 一一对应） */
const FIELDS: { key: string; labelKey: string; hintKey: string }[] = [
  { key: "game_tick_seconds", labelKey: "cs.param.tickSeconds", hintKey: "cs.hint.tickSeconds" },
  { key: "game_candle_seconds", labelKey: "cs.param.candleSeconds", hintKey: "cs.hint.candleSeconds" },
  { key: "game_max_leverage", labelKey: "cs.param.maxLeverage", hintKey: "cs.hint.maxLeverage" },
  { key: "game_min_margin", labelKey: "cs.param.minMargin", hintKey: "cs.hint.minMargin" },
  { key: "game_fee_open_bps", labelKey: "cs.param.feeOpenBps", hintKey: "cs.hint.feeOpenBps" },
  { key: "game_fee_close_bps", labelKey: "cs.param.feeCloseBps", hintKey: "cs.hint.feeCloseBps" },
  {
    key: "game_maintenance_bps",
    labelKey: "cs.param.maintenanceBps",
    hintKey: "cs.hint.maintenanceBps",
  },
  { key: "game_noise_bps", labelKey: "cs.param.noiseBps", hintKey: "cs.hint.noiseBps" },
  { key: "game_impact_bps", labelKey: "cs.param.impactBps", hintKey: "cs.hint.impactBps" },
  {
    key: "game_mean_reversion_bps",
    labelKey: "cs.param.meanReversionBps",
    hintKey: "cs.hint.meanReversionBps",
  },
  {
    key: "game_reversion_deadband_bps",
    labelKey: "cs.param.reversionDeadbandBps",
    hintKey: "cs.hint.reversionDeadbandBps",
  },
  {
    key: "game_anchor_follow_bps",
    labelKey: "cs.param.anchorFollowBps",
    hintKey: "cs.hint.anchorFollowBps",
  },
  { key: "game_max_impact_bps", labelKey: "cs.param.maxImpactBps", hintKey: "cs.hint.maxImpactBps" },
  { key: "game_base_price", labelKey: "cs.param.basePrice", hintKey: "cs.hint.basePrice" },
]

/** 统计项的展示顺序与标签 */
const STAT_KEYS = [
  "openPositions",
  "openMargin",
  "openSize",
  "longSize",
  "shortSize",
  "totalPositions",
  "closed",
  "liquidated",
  "totalTrades",
  "candleCount",
] as const

export default function CollectionSettingsPage() {
  const { t } = useT()
  const [data, setData] = React.useState<GameAdminData | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [denied, setDenied] = React.useState(false)
  const [failed, setFailed] = React.useState(false)

  const [form, setForm] = React.useState<Record<string, string>>({})
  const [saving, setSaving] = React.useState(false)
  const [ledger, setLedger] = React.useState<PoolLedgerEntry[]>([])
  const [amount, setAmount] = React.useState("1000")
  const [poolBusy, setPoolBusy] = React.useState(false)
  const [resetOpen, setResetOpen] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    setFailed(false)
    try {
      const res = await adminCollectionApi.getInvest()
      setData(res)
      setForm(res.raw ?? {})
      setDenied(false)
      try {
        const l = await adminCollectionApi.ledger(30)
        setLedger(l.entries ?? [])
      } catch {
        /* 流水拉不到不影响配置 */
      }
    } catch (err) {
      if (err instanceof HttpError && (err.status === 403 || err.code === "ADMIN_SCOPE_DENIED")) {
        setDenied(true)
      } else {
        setFailed(true)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  // ---- 保存：只提交改动过的字段 ----
  const save = async () => {
    if (!data) return
    const params: Record<string, string> = {}
    for (const f of FIELDS) {
      if (form[f.key] !== undefined && form[f.key] !== data.raw[f.key]) {
        params[f.key] = form[f.key]
      }
    }
    const enabled = (form.game_enabled ?? "1") === "1"
    if (enabled !== data.effective.enabled) params.game_enabled = enabled ? "1" : "0"

    if (Object.keys(params).length === 0) {
      toast.info(t("cs.saved"))
      return
    }
    setSaving(true)
    try {
      const res = await adminCollectionApi.updateInvest({ params })
      setData(res)
      setForm(res.raw ?? {})
      toast.success(t("cs.saved"))
    } catch (err) {
      toast.error(errMsg(err, t("cs.saveFailed")))
    } finally {
      setSaving(false)
    }
  }

  const setStatus = async (status: string) => {
    try {
      const res = await adminCollectionApi.updateInvest({ plugin: { status } })
      setData(res)
      toast.success(t("cs.saved"))
    } catch (err) {
      toast.error(errMsg(err, t("cs.saveFailed")))
    }
  }

  /**
   * 切换结算货币（积分 ⇄ 测试币）。
   *
   * 立即生效、不需要点「保存参数」—— 这是一个运营开关，站长点下去就该看到结果。
   * 服务端在货币真的变化时会记下 `currency_since`，排行榜随之只统计切换之后的成交
   * （两种货币的 1 分不是一回事，混着比没有意义）。
   */
  const switchCurrency = async (cur: "points" | "test") => {
    if (saving || data?.effective.currency === cur) return
    setSaving(true)
    try {
      const res = await adminCollectionApi.updateInvest({ params: { game_currency: cur } })
      setData(res)
      setForm(res.raw ?? {})
      toast.success(t("cs.currencySwitched"))
    } catch (err) {
      toast.error(errMsg(err, t("cs.saveFailed")))
    } finally {
      setSaving(false)
    }
  }

  const doPool = async (action: "deposit" | "withdraw") => {
    const value = Math.floor(Number(amount))
    if (!Number.isFinite(value) || value < 1) {
      toast.error(t("cs.poolFailed"))
      return
    }
    setPoolBusy(true)
    try {
      const res = await adminCollectionApi.pool(action, value)
      toast.success(
        (action === "deposit" ? t("cs.deposited") : t("cs.withdrawn")).replace(
          "{n}",
          value.toLocaleString()
        )
      )
      setData((prev) => (prev ? { ...prev, pool: { ...prev.pool, balance: res.pool } } : prev))
      setAmount("1000")
      const l = await adminCollectionApi.ledger(30)
      setLedger(l.entries ?? [])
    } catch (err) {
      toast.error(errMsg(err, t("cs.poolFailed")))
    } finally {
      setPoolBusy(false)
    }
  }

  const doReset = async () => {
    setResetOpen(false)
    try {
      await adminCollectionApi.reset()
      toast.success(t("cs.resetDone"))
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("cs.resetFailed")))
    }
  }

  if (loading && !data && !denied) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (denied) {
    return (
      <div>
        <PageHeader title={t("cs.title")} description={t("cs.desc")} />
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <ShieldAlert className="h-6 w-6 text-muted-foreground" />
            <p className="text-sm font-medium">{t("cs.denied")}</p>
            <p className="max-w-sm text-xs text-muted-foreground">{t("cs.deniedDesc")}</p>
            <Button asChild variant="secondary" size="sm">
              <Link to="/dashboard/gallery/collection">{t("cs.back")}</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!data) {
    return (
      <div>
        <PageHeader title={t("cs.title")} description={t("cs.desc")} />
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
            <p className="text-sm font-medium">{t("col.loadFailed")}</p>
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              {t("col.retry")}
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const enabled = (form.game_enabled ?? "1") === "1"
  const status = data.plugin?.status ?? "published"
  const stats = data.stats ?? {}
  const longSize = Number(stats.longSize ?? 0)
  const shortSize = Number(stats.shortSize ?? 0)

  return (
    <div>
      <PageHeader title={t("cs.title")} description={t("cs.desc")} />

      <div className="flex flex-col gap-6 lg:flex-row">
        <CollectionAside />

        <div className="min-w-0 flex-1 space-y-4">
          {failed && (
            <p className="text-xs text-amber-600 dark:text-amber-400">{t("col.loadFailedDesc")}</p>
          )}

          {/* ================= 典藏项目：在线投资 ================= */}
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="text-2xl leading-none">{data.plugin?.icon || "📈"}</span>
                <div>
                  <p className="text-sm font-medium">{data.plugin?.name || t("inv.title")}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {t("cs.marketNow").replace("{p}", data.market.price.toFixed(4))}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={status === "published" ? "default" : "outline"}>
                  {t(`cs.status.${status}`)}
                </Badge>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void setStatus(status === "published" ? "disabled" : "published")}
                >
                  {t(`cs.status.${status === "published" ? "disabled" : "published"}`)}
                </Button>
              </div>
            </div>

            <CardContent className="space-y-5 p-4">
              {/* ---- 总开关 ---- */}
              <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{t("cs.enabled")}</p>
                  <p className="text-[11px] text-muted-foreground">{t("cs.enabledHint")}</p>
                </div>
                <Switch
                  checked={enabled}
                  onCheckedChange={(v) =>
                    setForm((prev) => ({ ...prev, game_enabled: v ? "1" : "0" }))
                  }
                />
              </div>

              {/* ---- 结算货币 ---- */}
              <div className="rounded-lg border p-3">
                <div className="mb-2">
                  <p className="text-sm font-medium">{t("cs.currency")}</p>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    {t("cs.currencyHint")}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {(["points", "test"] as const).map((cur) => (
                    <Button
                      key={cur}
                      size="sm"
                      variant={data.effective.currency === cur ? "default" : "outline"}
                      disabled={saving}
                      onClick={() => void switchCurrency(cur)}
                    >
                      {t(`cs.currency.${cur}`)}
                    </Button>
                  ))}
                  <span className="text-[11px] text-muted-foreground">
                    {t("cs.testPool")}：{data.pool.testBalance.toLocaleString()}
                  </span>
                </div>
              </div>

              {/* ---- 玩法参数 ---- */}
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
                  {t("cs.group.play")}
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {FIELDS.map((f) => (
                    <div key={f.key} className="space-y-1">
                      <Label htmlFor={f.key} className="text-xs">
                        {t(f.labelKey)}
                      </Label>
                      <Input
                        id={f.key}
                        inputMode="decimal"
                        className="tabular-nums"
                        value={form[f.key] ?? ""}
                        onChange={(e) =>
                          setForm((prev) => ({ ...prev, [f.key]: e.target.value }))
                        }
                      />
                      <p className="text-[11px] leading-snug text-muted-foreground/70">
                        {t(f.hintKey)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              {/* ---- 资金池 ---- */}
              <div className="rounded-lg border p-3">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
                  {t("cs.group.pool")}
                </p>
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <p className="text-[11px] text-muted-foreground">{t("cs.poolBalance")}</p>
                    <p className="text-2xl font-semibold tabular-nums">
                      {data.pool.balance.toLocaleString()}
                <span className="ml-2 text-muted-foreground">
                  {t("cs.testPool")}：{data.pool.testBalance.toLocaleString()}
                </span>
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {t("cs.myBalance").replace("{n}", data.pool.myBalance.toLocaleString())}
                    </p>
                  </div>
                  <div className="flex items-end gap-2">
                    <div className="space-y-1">
                      <Label htmlFor="pool-amount" className="text-xs">
                        {t("cs.amount")}
                      </Label>
                      <Input
                        id="pool-amount"
                        inputMode="numeric"
                        className="w-32 tabular-nums"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))}
                      />
                    </div>
                    <Button disabled={poolBusy} onClick={() => void doPool("deposit")}>
                      {poolBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                      {t("cs.deposit")}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={poolBusy}
                      onClick={() => void doPool("withdraw")}
                    >
                      {t("cs.withdraw")}
                    </Button>
                  </div>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/70">
                  {t("cs.poolHint")}
                  <br />
                  {t("cs.depositHint")}
                  <br />
                  {t("cs.withdrawHint")}
                </p>
              </div>

              <div className="flex justify-end">
                <Button onClick={() => void save()} disabled={saving}>
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t("cs.save")}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* ---- 全服统计 ---- */}
          <Card>
            <CardContent className="p-4">
              <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
                {t("cs.group.stats")}
              </p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {STAT_KEYS.map((k) => (
                  <div key={k} className="rounded-lg bg-muted/40 p-2.5">
                    <p className="text-[11px] text-muted-foreground">{t(`cs.stat.${k}`)}</p>
                    <p className="text-lg font-medium tabular-nums">
                      {Number(stats[k] ?? 0).toLocaleString()}
                    </p>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[11px] text-muted-foreground">
                {t("cs.longShort")
                  .replace("{a}", longSize.toLocaleString())
                  .replace("{b}", shortSize.toLocaleString())}
              </p>
            </CardContent>
          </Card>

          {/* ---- 池子流水 ---- */}
          <Card className="overflow-hidden">
            <div className="border-b px-4 py-2.5">
              <p className="text-sm font-medium">{t("cs.ledger")}</p>
            </div>
            {ledger.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                {t("cs.ledgerEmpty")}
              </p>
            ) : (
              <div className="divide-y">
                {ledger.map((e) => (
                  <div
                    key={e.id}
                    className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2 text-xs"
                  >
                    <span className="flex items-center gap-2">
                      <Badge variant="outline" className="font-normal">
                        {t(`cs.ledger.${e.kind}`)}
                      </Badge>
                      {e.username && <span className="text-muted-foreground">{e.username}</span>}
                      {e.note && (
                        <span className="truncate text-muted-foreground/70">{e.note}</span>
                      )}
                    </span>
                    <span className="flex items-center gap-4 tabular-nums">
                      <span className={e.delta >= 0 ? "text-emerald-500" : "text-rose-500"}>
                        {e.delta > 0 ? "+" : ""}
                        {e.delta.toLocaleString()}
                      </span>
                      <span className="text-muted-foreground/70">
                        → {e.balanceAfter.toLocaleString()}
                      </span>
                      <span className="text-muted-foreground/60">
                        {new Date(e.createdAt).toLocaleString()}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* ---- 危险操作 ---- */}
          <Card>
            <CardContent className="space-y-3 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
                {t("cs.group.danger")}
              </p>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-sm font-medium">
                    <AlertTriangle className="h-4 w-4 text-amber-500" />
                    {t("cs.reset")}
                  </p>
                  <p className="text-[11px] text-muted-foreground">{t("cs.resetHint")}</p>
                </div>
                <Button variant="outline" onClick={() => setResetOpen(true)}>
                  {t("cs.reset")}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* 重置确认（危险操作要二次确认，且要求手打确认按钮而不是 window.confirm） */}
      {resetOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm"
          onClick={() => setResetOpen(false)}
        >
          <Card className="w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <CardContent className="space-y-3 p-5">
              <p className="font-medium">{t("cs.resetConfirmTitle")}</p>
              <p className="text-xs text-muted-foreground">{t("cs.resetConfirmBody")}</p>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setResetOpen(false)}>
                  {t("cs.cancel")}
                </Button>
                <Button variant="destructive" onClick={() => void doReset()}>
                  {t("cs.confirm")}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
