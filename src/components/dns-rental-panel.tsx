import * as React from "react"
import { toast } from "sonner"
import { CalendarClock, Globe, Loader2, ShoppingCart, Timer, TriangleAlert } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { confirmDialog } from "@/components/confirm-dialog"
import { EmptyState } from "@/components/empty-state"
import { useT } from "@/i18n"
import { dnsApi } from "@/services/api"
import type { DnsRental, DnsRentalRootOption, DnsRentalState } from "@/types"

/**
 * DNS 解析「积分租用」用户端（2026-10-14）。
 *
 * 与内网穿透的租用面板（components/frp-rental-panel.tsx）是同一套形态：
 * 用户用积分买使用时长，到期自动回收，没有人工审核。
 *
 * 与 frp 的**关键差别**：DNS 是按**根域**卖的（tyu.me 200/年、7u.nz 500/年，
 * 见迁移 0160），所以这里是一张「一个根域一张卡」的价目表，而不是套餐列表；
 * 买了一年的 tyu.me 不等于能用 7u.nz —— 定价本来就不同。
 *
 * 金额相关的一切都在服务端：这里只发起请求、展示结果。每次购买/续期都带
 * `requestId`，服务端拿它做幂等 —— 双击或网络重试不会重复扣分。
 */
export function DnsRentalPanel({
  state,
  loading,
  onChanged,
}: {
  /** 服务端下发的价目 + 我的租约；null = 还没拉到 */
  state: DnsRentalState | null
  loading: boolean
  /** 购买 / 续期 / 改开关之后刷新（父组件同时据此决定要不要放开建记录） */
  onChanged: () => void | Promise<void>
}) {
  const { t } = useT()
  /** 正在处理的动作标识（`buy:<root>` / `renew:<id>` / `auto:<id>`），避免连点 */
  const [busy, setBusy] = React.useState("")

  const buy = async (opt: DnsRentalRootOption) => {
    // ⚠️ 确认弹窗里的价格用 `termPrice`（按当前租期折算的实收），不是 `yearPrice`：
    // 站长把租期改成 30 天后两者能差好几倍，用年价确认会让人以为被多扣了。
    const ok = await confirmDialog({
      title: t("dnsr.buy"),
      desc: t("dnsr.buyConfirm", {
        v0: opt.name,
        v1: String(opt.termPrice),
      }),
      okText: t("dnsr.buy"),
    })
    if (!ok) return
    setBusy(`buy:${opt.name}`)
    try {
      const res = await dnsApi.purchaseRental({
        rootDomain: opt.name,
        requestId: crypto.randomUUID(),
      })
      toast.success(
        t("dnsr.bought", {
          v0: res.rootDomain,
          v1: new Date(res.expiresAt).toLocaleDateString(),
        })
      )
      await onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("dnsr.buyFailed"))
    } finally {
      setBusy("")
    }
  }

  const renew = async (rental: DnsRental) => {
    const price = rental.pricePoints
    const ok = await confirmDialog({
      title: t("dnsr.renew"),
      desc: t("dnsr.renewConfirm", { v0: rental.rootDomain, v1: String(price) }),
      okText: t("dnsr.renew"),
    })
    if (!ok) return
    setBusy(`renew:${rental.id}`)
    try {
      const res = await dnsApi.renewRental({ id: rental.id, requestId: crypto.randomUUID() })
      toast.success(
        t("dnsr.renewed", { v0: new Date(res.expiresAt).toLocaleDateString() })
      )
      await onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("dnsr.renewFailed"))
    } finally {
      setBusy("")
    }
  }

  /**
   * 开关自动续费。
   *
   * 与 frp 一致：成功只本地更新这一条，不整页重拉（重拉会让列表闪一下）。
   * 服务端在积分不够时会主动关掉这个开关并把原因写进 lastError ——
   * 用户在卡片上直接就能看到「为什么没续上」。
   */
  const toggleAutoRenew = async (rental: DnsRental, on: boolean) => {
    setBusy(`auto:${rental.id}`)
    try {
      await dnsApi.setRentalAutoRenew({ id: rental.id, autoRenew: on })
      toast.success(on ? t("dnsr.autoRenew.on") : t("dnsr.autoRenew.off"))
      await onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("dnsr.autoRenew.err"))
    } finally {
      setBusy("")
    }
  }

  const statusBadge = (status: string) => {
    if (status === "active") return <Badge>{t("dnsr.status.active")}</Badge>
    if (status === "expired") return <Badge variant="secondary">{t("dnsr.status.expired")}</Badge>
    return <Badge variant="outline">{t("dnsr.status.cancelled")}</Badge>
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("dnsr.loading")}
        </CardContent>
      </Card>
    )
  }

  if (!state) {
    return (
      <EmptyState title={t("dnsr.loadFailed")} description={t("dnsr.loadFailedHint")} />
    )
  }

  // 有权限位 / 管理员的用户不需要买东西 —— 面板退化成一句说明 + 根域清单，
  // 免得他们看到一堆「购买」按钮以为自己也要付钱。
  const saleable = state.options.filter((o) => o.forSale && o.permitted)

  return (
    <div className="space-y-6">
      {state.freeAccess ? (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm">
          <Globe className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
          <span>{t("dnsr.freeBanner")}</span>
        </div>
      ) : state.accessMode === "none" ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <span>{t("dnsr.needRental")}</span>
        </div>
      ) : state.accessMode === "expired" ? (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <span>{t("dnsr.expiredBanner")}</span>
        </div>
      ) : null}

      {/* ---- 价目表：一个根域一张卡 ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Globe className="h-4 w-4 text-muted-foreground" />
            {t("dnsr.plans.title")}
          </CardTitle>
          <CardDescription>{t("dnsr.plans.desc", { v0: String(state.balance) })}</CardDescription>
          {/* 租期是站长可配的（设置项 dns_rental_days），这里必须把**当前值**显示出来：
              用户看到「200 分」时得知道这买的是多少天，否则扣了 17 分（30 天档）
              会以为系统算错了。 */}
          <CardDescription>{t("dnsr.plans.term", { v0: String(state.rentalDays) })}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {state.options.length === 0 ? (
            <EmptyState title={t("dnsr.plans.empty")} description={t("dnsr.plans.emptyHint")} />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {state.options.map((o) => {
                // 权限闸没放行的域（如未解锁 doulor 时的 doulor.cn）：显示成
                // 「需要 X 权限」而不是干脆不显示 —— 站长要的是「明码标价、
                // 让人看见入口」，藏起来只会引出「为什么我没有这个域」的追问。
                const blocked = !o.permitted
                const notForSale = o.permitted && !o.forSale
                const rental = o.rental
                const expired = !!rental && rental.status !== "active"
                const affordable = state.balance >= o.termPrice
                return (
                  <div key={o.name} className="flex flex-col gap-2 rounded-lg border bg-card p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="space-y-0.5">
                        <p className="font-mono text-sm font-medium">{o.name}</p>
                        {o.label !== o.name ? (
                          <p className="text-xs text-muted-foreground">{o.label}</p>
                        ) : null}
                      </div>
                      {o.freeAccess || o.usable ? (
                        <Badge variant="secondary">{t("dnsr.plans.usable")}</Badge>
                      ) : rental ? (
                        statusBadge(rental.status)
                      ) : null}
                    </div>

                    <div className="space-y-1 text-sm">
                      <p className="text-base font-semibold">
                        {/* 先写「这个账号能建几条」（站长 2026-10-15 要求），再写价：
                            条数与根域无关（是账号维度的口径），买的额度都落在这条线以内。
                            recordLimit 为 null = 管理员不限，此时写「不限」而不是条数 ——
                            绝不能当 0 渲染成「0 条」。 */}
                        {state.recordLimit === null
                          ? t("dnsr.plans.recordsUnlimited")
                          : t("dnsr.plans.records", { v0: String(state.recordLimit) })}
                        {" · "}
                        {o.yearPrice > 0
                          ? t("dnsr.unitPoints", { v0: String(o.yearPrice) })
                          : t("dnsr.notForSale")}
                      </p>
                      {/* 年价 + 当前租期 ⇒ 实际要付多少。只在真的在卖的时候显示；
                          租期恰好 365 天时两个数相同，就不重复写一遍了。 */}
                      {o.forSale && o.termPrice !== o.yearPrice ? (
                        <p className="text-xs text-muted-foreground">
                          {t("dnsr.termPrice", {
                            v0: String(state.rentalDays),
                            v1: String(o.termPrice),
                          })}
                        </p>
                      ) : null}
                      {rental ? (
                        <>
                          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <CalendarClock className="h-3.5 w-3.5" />
                            {t("dnsr.mine.expires", {
                              v0: new Date(rental.expiresAt).toLocaleDateString(),
                            })}
                          </p>
                          <p
                            className={`text-xs ${expired ? "text-destructive" : "text-muted-foreground"}`}
                          >
                            {rental.daysLeft >= 0
                              ? t("dnsr.daysLeft", { v0: String(rental.daysLeft) })
                              : t("dnsr.expiredAgo", { v0: String(Math.abs(rental.daysLeft)) })}
                          </p>
                        </>
                      ) : null}
                      {blocked ? (
                        <p className="text-xs text-amber-600 dark:text-amber-500">
                          {t("dnsr.permissionRequired", { v0: o.requiresFeature ?? "" })}
                        </p>
                      ) : null}
                    </div>

                    {/* 按钮区：管理员/有权限的人不显示购买（他们本来就不用买） */}
                    {o.freeAccess || blocked || notForSale ? (
                      <div className="mt-auto" />
                    ) : rental ? (
                      <Button
                        size="sm"
                        className="mt-auto"
                        disabled={!!busy}
                        onClick={() => void renew(rental)}
                      >
                        {busy === `renew:${rental.id}` ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Timer className="h-4 w-4" />
                        )}
                        {t("dnsr.renew")}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        className="mt-auto"
                        disabled={!!busy || !affordable}
                        onClick={() => void buy(o)}
                      >
                        {busy === `buy:${o.name}` ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <ShoppingCart className="h-4 w-4" />
                        )}
                        {affordable ? t("dnsr.buy") : t("dnsr.insufficient")}
                      </Button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          {saleable.length === 0 && !state.freeAccess ? (
            <p className="text-xs text-muted-foreground">{t("dnsr.plans.noneForSale")}</p>
          ) : null}
        </CardContent>
      </Card>

      {/* ---- 我的租约：自动续费与到期提醒都在这里 ---- */}
      {state.rentals.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("dnsr.mine.title")}</CardTitle>
            <CardDescription>{t("dnsr.mine.desc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {state.rentals.map((r) => {
              const expired = r.status !== "active" || r.daysLeft <= 0
              return (
                <div key={r.id} className="rounded-lg border bg-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-medium">{r.rootDomain}</span>
                        {statusBadge(r.status)}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span>
                          {t("dnsr.mine.expires", {
                            v0: new Date(r.expiresAt).toLocaleString(),
                          })}
                        </span>
                        <span className={expired ? "text-destructive" : ""}>
                          {r.daysLeft >= 0
                            ? t("dnsr.daysLeft", { v0: String(r.daysLeft) })
                            : t("dnsr.expiredAgo", { v0: String(Math.abs(r.daysLeft)) })}
                        </span>
                        <span>{t("dnsr.mine.price", { v0: String(r.pricePoints) })}</span>
                      </div>

                      <div className="mt-2 rounded-md border p-2">
                        <div className="flex items-center justify-between gap-3">
                          <div className="space-y-0.5">
                            <p className="text-xs font-medium">{t("dnsr.autoRenew.title")}</p>
                            <p className="text-[11px] text-muted-foreground">
                              {t("dnsr.autoRenew.hint")}
                            </p>
                          </div>
                          <Switch
                            checked={!!r.autoRenew}
                            disabled={expired || busy === `auto:${r.id}`}
                            onCheckedChange={(v) => void toggleAutoRenew(r, v)}
                          />
                        </div>
                        {r.lastError ? (
                          <p className="mt-1.5 text-[11px] text-destructive">
                            {t("dnsr.autoRenew.failed")}
                            {r.lastError}
                          </p>
                        ) : null}
                        {!r.autoRenew && !r.lastError && r.daysLeft <= 7 && !expired ? (
                          <p className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-500">
                            {t("dnsr.autoRenew.soon")}
                          </p>
                        ) : null}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      disabled={!!busy || r.status === "cancelled"}
                      onClick={() => void renew(r)}
                    >
                      {busy === `renew:${r.id}` ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Timer className="h-4 w-4" />
                      )}
                      {t("dnsr.renew")}
                    </Button>
                  </div>
                  {r.daysLeft <= 7 && r.status === "active" && r.daysLeft >= 0 ? (
                    <p className="mt-2 text-xs text-amber-600 dark:text-amber-500">
                      {t("dnsr.expiringSoon", { v0: String(r.daysLeft) })}
                    </p>
                  ) : null}
                </div>
              )
            })}
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
