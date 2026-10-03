/**
 * 签到弹窗。
 *
 * 打开即拉当前状态；点「签到」发请求，成功后刷新积分（由父级传入 onDone 触发）。
 * 里程碑用 chips 展示：已达成 / 下一个（高亮）/ 未到。
 */
import * as React from "react"
import { toast } from "sonner"
import { Loader2, Gift, CalendarCheck, ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { checkinApi, errMsg } from "@/services/api"
import { cn } from "@/lib/utils"
import { useT } from "@/i18n"

type Status = {
  enabled: boolean
  checkedIn: boolean
  streak: number
  todayPoints: number
  todayBase: number
  todayBonus: number
  milestones: { days: number; points: number }[]
  next: { days: number; points: number; daysLeft: number } | null
}

export function CheckinDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** 签到成功后回调（父级刷新积分余额） */
  onDone?: () => void
}) {
  const { t } = useT()
  const [status, setStatus] = React.useState<Status | null>(null)
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    try {
      setStatus(await checkinApi.status())
    } catch (err) {
      toast.error(errMsg(err, t("ck.loadFailed")))
    }
  }, [t])

  React.useEffect(() => {
    if (open) void load()
  }, [open, load])

  const doCheckin = async () => {
    setBusy(true)
    try {
      const res = await checkinApi.do()
      toast.success(t("ck.done", { points: res.total }))
      await load()
      onDone?.()
    } catch (err) {
      toast.error(errMsg(err, t("ck.failed")))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarCheck className="h-4 w-4" />
            {t("ck.title")}
          </DialogTitle>
          <DialogDescription>
            {t("ck.desc")}
          </DialogDescription>
        </DialogHeader>

        {!status ? (
          <div className="py-10">
            <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !status.enabled ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t("ck.disabled")}</p>
        ) : (
          <div className="space-y-4">
            {/* 连续天数 */}
            <div className="flex items-center justify-between rounded-lg border p-4">
              <div>
                <div className="text-2xl font-medium">{status.streak}</div>
                <div className="text-xs text-muted-foreground">{t("ck.streakDays")}</div>
              </div>
              {status.checkedIn ? (
                <div className="flex items-center gap-2 rounded-full bg-emerald-100 px-3 py-1 text-sm text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                  <CalendarCheck className="h-4 w-4" />
                  {t("ck.checkedIn")}
                  {status.todayPoints > 0 && (
                    <span className="font-medium">+{status.todayPoints}</span>
                  )}
                </div>
              ) : (
                <Button onClick={() => void doCheckin()} disabled={busy}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Gift className="mr-1.5 h-4 w-4" />}
                  {t("ck.checkin")}
                </Button>
              )}
            </div>

            {/* 里程碑 */}
            {status.milestones.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">{t("ck.milestones")}</div>
                <div className="flex flex-wrap gap-2">
                  {status.milestones.map((m) => {
                    const reached = m.days <= status.streak
                    const isNext = status.next?.days === m.days
                    return (
                      <div
                        key={m.days}
                        className={cn(
                          "rounded-full border px-3 py-1 text-xs",
                          reached && !isNext
                            ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                            : isNext
                              ? "border-primary bg-primary/10 text-primary"
                              : "text-muted-foreground"
                        )}
                      >
                        {t("ck.milestoneItem", { days: m.days, points: m.points })}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* 下一步提示 */}
            {!status.checkedIn && status.next && (
              <p className="text-xs text-muted-foreground">
                {t("ck.nextHint", {
                  daysLeft: status.next.daysLeft,
                  points: status.next.points,
                })}
                <ChevronRight className="inline h-3 w-3" />
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
