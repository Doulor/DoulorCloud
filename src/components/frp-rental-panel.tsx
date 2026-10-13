import * as React from "react"
import { toast } from "sonner"
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Copy,
  Download,
  FileCode2,
  Loader2,
  Network,
  ShoppingCart,
  Timer,
  XCircle,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { confirmDialog } from "@/components/confirm-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { EmptyState } from "@/components/empty-state"
import { useT } from "@/i18n"
import { frpApi } from "@/services/api"
import type { UserFrpPlan, UserFrpRental } from "@/types"

/**
 * 内网穿透「租用」用户端（2026-10-13）。
 *
 * 用户在这里用积分买使用时长，到期由服务器上的 agent 自动停用 —— 没有人工审核，
 * 也不需要管理员去 frps-panel 建号（那个面板网页现在其实是坏的）。
 *
 * 金额相关的一切都在服务端：这里只发起请求、展示结果。
 * 每次购买/续期都会带一个 `requestId`，服务端拿它做幂等 ——
 * 双击或网络重试不会重复扣分。
 */
export function FrpRentalPanel() {
  const { t } = useT()

  const [balance, setBalance] = React.useState(0)
  const [plans, setPlans] = React.useState<UserFrpPlan[]>([])
  const [subs, setSubs] = React.useState<UserFrpRental[]>([])
  /** frpc 客户端下载地址（站长在设置里配）；租用用户同样需要它 */
  const [coreUrl, setCoreUrl] = React.useState<string | null>(null)
  /** 站长把「内网穿透」总开关关了 → 暂停销售（已购租约不受影响） */
  const [suspended, setSuspended] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  /** 正在处理的动作标识，避免同一按钮被连点 */
  const [busy, setBusy] = React.useState("")
  const [configOf, setConfigOf] = React.useState<UserFrpRental | null>(null)

  const load = React.useCallback(async () => {
    try {
      const [planRes, mineRes] = await Promise.all([
        frpApi.listRentalPlans(),
        frpApi.listMyRentals(),
      ])
      setPlans(planRes.plans)
      setBalance(planRes.balance)
      setSuspended(Boolean(planRes.suspended))
      setCoreUrl(planRes.coreUrl ?? null)
      setSubs(mineRes.subscriptions)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("frpu.loadFailed"))
    } finally {
      setLoading(false)
    }
  }, [t])

  React.useEffect(() => {
    void load()
  }, [load])

  const buy = async (plan: UserFrpPlan) => {
    const ok = await confirmDialog({
      title: t("frpu.buy"),
      desc: t("frpu.buyConfirm", {
        v0: plan.name,
        v1: plan.pricePoints,
        v2: plan.days,
        v3: plan.maxPorts,
      }),
      okText: t("frpu.buy"),
    })
    if (!ok) return
    setBusy(`buy:${plan.id}`)
    try {
      const res = await frpApi.purchaseRental({
        planId: plan.id,
        requestId: crypto.randomUUID(),
      })
      toast.success(t("frpu.bought", { v0: res.frpUser, v1: res.ports.join(", ") }))
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("frpu.buyFailed"))
    } finally {
      setBusy("")
    }
  }

  const renew = async (sub: UserFrpRental, plan: UserFrpPlan | undefined) => {
    const price = plan?.pricePoints ?? sub.pricePoints
    const days = plan?.days ?? 0
    const ok = await confirmDialog({
      title: t("frpu.renew"),
      desc: t("frpu.renewConfirm", { v0: sub.frpUser, v1: price, v2: days }),
      okText: t("frpu.renew"),
    })
    if (!ok) return
    setBusy(`renew:${sub.id}`)
    try {
      const res = await frpApi.renewRental({ id: sub.id, requestId: crypto.randomUUID() })
      toast.success(t("frpu.renewed", { v0: new Date(res.expiresAt).toLocaleDateString() }))
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("frpu.renewFailed"))
    } finally {
      setBusy("")
    }
  }

  const copyConfig = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(t("frpu.copied"))
    } catch {
      toast.error(t("frpu.copyFailed"))
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("frpu.loading")}
        </CardContent>
      </Card>
    )
  }

  const statusBadge = (status: string) => {
    if (status === "active") return <Badge>{t("frpu.status.active")}</Badge>
    if (status === "expired") return <Badge variant="secondary">{t("frpu.status.expired")}</Badge>
    return <Badge variant="outline">{t("frpu.status.cancelled")}</Badge>
  }

  const syncText = (s: UserFrpRental) => {
    if (s.syncState === "synced") {
      return (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <CheckCircle2 className="h-3.5 w-3.5" />
          {t("frpu.sync.synced")}
        </span>
      )
    }
    if (s.syncState === "error") {
      return (
        <span className="inline-flex items-center gap-1 text-xs text-destructive" title={s.lastError ?? ""}>
          <XCircle className="h-3.5 w-3.5" />
          {t("frpu.sync.error")}
        </span>
      )
    }
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("frpu.sync.pending")}
      </span>
    )
  }

  return (
    <div className="space-y-6">
      {/* ---- 套餐 ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Network className="h-4 w-4 text-muted-foreground" />
            {t("frpu.plans.title")}
          </CardTitle>
          <CardDescription>
            {t("frpu.plans.desc", { v0: balance })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* frpc 客户端下载：人工申请流程退役后，这个入口必须由租用面板承接 ——
              否则用户拿到了配置却没有客户端可用。地址来自设置项 frp_core_url。 */}
          {coreUrl ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-3 text-sm">
              <Download className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="text-muted-foreground">{t("frpu.downloadHint")}</span>
              <a
                href={coreUrl}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-primary underline underline-offset-4"
              >
                {t("frpu.download")}
              </a>
            </div>
          ) : null}

          {suspended ? (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              <span>{t("frpu.suspended")}</span>
            </div>
          ) : plans.length === 0 ? (
            <EmptyState title={t("frpu.plans.empty")} description={t("frpu.plans.emptyHint")} />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {plans.map((p) => {
                const mine = p.existing
                const renewing = busy === `renew:${mine?.id ?? ""}` && !!mine
                return (
                  <div
                    key={p.id}
                    className="flex flex-col gap-2 rounded-lg border bg-card p-4"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="space-y-0.5">
                        <p className="text-sm font-medium">{p.name}</p>
                        <p className="text-xs text-muted-foreground">{p.nodeName}</p>
                      </div>
                      {mine ? <Badge variant="secondary">{t("frpu.plans.owned")}</Badge> : null}
                    </div>
                    <div className="space-y-1 text-sm">
                      <p className="flex items-center gap-1.5">
                        <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />
                        {t("frpu.unitDays", { v0: p.days })}
                      </p>
                      <p className="flex items-center gap-1.5">
                        <Network className="h-3.5 w-3.5 text-muted-foreground" />
                        {t("frpu.unitPorts", { v0: p.maxPorts })}
                      </p>
                      <p className="text-base font-semibold">
                        {t("frpu.unitPoints", { v0: p.pricePoints })}
                      </p>
                    </div>
                    {mine ? (
                      <Button
                        size="sm"
                        className="mt-auto"
                        disabled={!!busy}
                        onClick={() => void renew(subs.find((s) => s.id === mine.id) ?? {
                          // 理论上不会走到这里：有 existing 就一定有对应订阅
                          id: mine.id,
                          frpUser: mine.frpUser,
                          pricePoints: p.pricePoints,
                        } as UserFrpRental, p)}
                      >
                        {renewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Timer className="h-4 w-4" />}
                        {t("frpu.renew")}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        className="mt-auto"
                        disabled={!!busy || !p.affordable}
                        onClick={() => void buy(p)}
                      >
                        {busy === `buy:${p.id}` ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <ShoppingCart className="h-4 w-4" />
                        )}
                        {p.affordable ? t("frpu.buy") : t("frpu.insufficient")}
                      </Button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---- 我的租约 ---- */}
      {subs.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("frpu.mine.title")}</CardTitle>
            <CardDescription>{t("frpu.mine.desc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {subs.map((s) => {
              const expired = s.status !== "active" || s.daysLeft <= 0
              return (
                <div key={s.id} className="rounded-lg border bg-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-medium">{s.frpUser}</span>
                        {statusBadge(s.status)}
                        {syncText(s)}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {s.nodeName} · {s.serverAddr}:{s.serverPort}
                      </p>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span>
                          {t("frpu.mine.ports")}:{" "}
                          <span className="font-mono">{s.ports.join(", ") || "-"}</span>
                        </span>
                        <span>
                          {t("frpu.mine.expires")}:{" "}
                          {new Date(s.expiresAt).toLocaleString()}
                        </span>
                        <span className={expired ? "text-destructive" : ""}>
                          {s.daysLeft >= 0
                            ? t("frpu.daysLeft", { v0: s.daysLeft })
                            : t("frpu.expiredAgo", { v0: Math.abs(s.daysLeft) })}
                        </span>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!s.configToml}
                        onClick={() => setConfigOf(s)}
                      >
                        <FileCode2 className="h-3.5 w-3.5" />
                        {t("frpu.config")}
                      </Button>
                      <Button
                        size="sm"
                        disabled={!!busy || s.status === "cancelled"}
                        onClick={() => void renew(s, plans.find((p) => p.nodeId === s.nodeId))}
                      >
                        {busy === `renew:${s.id}` ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Timer className="h-4 w-4" />
                        )}
                        {t("frpu.renew")}
                      </Button>
                    </div>
                  </div>
                  {s.daysLeft <= 3 && s.status === "active" && s.daysLeft >= 0 ? (
                    <p className="mt-2 text-xs text-amber-600 dark:text-amber-500">
                      {t("frpu.expiringSoon", { v0: s.daysLeft })}
                    </p>
                  ) : null}
                </div>
              )
            })}
          </CardContent>
        </Card>
      ) : null}

      {/* ---- 配置弹窗 ---- */}
      <Dialog open={configOf !== null} onOpenChange={(v) => !v && setConfigOf(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("frpu.configTitle")}</DialogTitle>
            <DialogDescription>{t("frpu.configDesc", { v0: configOf?.frpUser ?? "" })}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <pre className="max-h-80 overflow-auto rounded-lg border bg-muted/40 p-3 text-xs">
              {configOf?.configToml}
            </pre>
            <p className="text-xs text-muted-foreground">{t("frpu.configHint")}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfigOf(null)}>
              {t("frpu.close")}
            </Button>
            <Button
              onClick={() => void copyConfig(configOf?.configToml ?? "")}
            >
              <Copy className="h-4 w-4" />
              {t("frpu.copy")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
