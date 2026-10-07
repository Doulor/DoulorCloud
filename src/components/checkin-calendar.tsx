import * as React from "react"
import { toast } from "sonner"
import { ChevronLeft, ChevronRight, Check, Ticket, Loader2 } from "lucide-react"

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

type HistoryDay = { date: string; points: number; isMakeup: boolean }

const WEEKDAYS = ["ck.wd.mon", "ck.wd.tue", "ck.wd.wed", "ck.wd.thu", "ck.wd.fri", "ck.wd.sat", "ck.wd.sun"]

/**
 * 签到日历：按月查看每天的签到情况。
 * · 正常签到 = 绿色实心；补签 = 琥珀色高亮（带「补」标记）；漏签（过去且没签）= 可点选补签。
 * · 点漏签日 → 底部弹确认 → 消耗一张补签卡。
 */
export function CheckinCalendar({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** 补签成功后回调（父级刷新签到状态/积分） */
  onDone?: () => void
}) {
  const { t } = useT()
  const [cursor, setCursor] = React.useState(() => {
    const n = new Date()
    return new Date(n.getFullYear(), n.getMonth(), 1)
  })
  const [data, setData] = React.useState<{ days: HistoryDay[]; today: string; makeupCards: number } | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [pending, setPending] = React.useState<string | null>(null)

  const month = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`

  const load = React.useCallback(async () => {
    try {
      setData(await checkinApi.history(month))
    } catch (err) {
      toast.error(errMsg(err, t("ck.loadFailed")))
    }
  }, [month, t])

  React.useEffect(() => {
    if (open) {
      setPending(null)
      void load()
    }
  }, [open, load])

  const moveMonth = (delta: number) => {
    setCursor((c) => new Date(c.getFullYear(), c.getMonth() + delta, 1))
  }

  const doMakeup = async () => {
    if (!pending) return
    setBusy(true)
    try {
      const res = await checkinApi.makeup(pending)
      toast.success(t("ck.makeupDone", { streak: res.streak }))
      setPending(null)
      await load()
      onDone?.()
    } catch (err) {
      toast.error(errMsg(err, t("ck.makeupFailed")))
    } finally {
      setBusy(false)
    }
  }

  // 构建格子：周一为一周之始
  const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate()
  const firstWeekday = (new Date(cursor.getFullYear(), cursor.getMonth(), 1).getDay() + 6) % 7
  const cells: (string | null)[] = []
  for (let i = 0; i < firstWeekday; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(`${month}-${String(d).padStart(2, "0")}`)

  const dayMap = new Map((data?.days ?? []).map((d) => [d.date, d]))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Ticket className="h-4 w-4" />
            {t("ck.calTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("ck.calDesc", { n: data?.makeupCards ?? 0 })}
          </DialogDescription>
        </DialogHeader>

        {/* 月份切换 */}
        <div className="flex items-center justify-between">
          <Button variant="ghost" size="icon" onClick={() => moveMonth(-1)} aria-label={t("ck.prevMonth")}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="text-sm font-medium">{month}</div>
          <Button variant="ghost" size="icon" onClick={() => moveMonth(1)} aria-label={t("ck.nextMonth")}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        {/* 星期表头 */}
        <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground">
          {WEEKDAYS.map((w) => (
            <div key={w} className="py-1">{t(w)}</div>
          ))}
        </div>

        {/* 日期格子 */}
        <div className="grid grid-cols-7 gap-1">
          {cells.map((date, i) => {
            if (!date) return <div key={`e${i}`} />
            const day = dayMap.get(date)
            const isToday = data?.today === date
            const isPast = data ? date < data.today : false
            const isFuture = data ? date > data.today : false
            const isMakeup = day?.isMakeup
            const canMakeup = isPast && !day && (data?.makeupCards ?? 0) > 0
            const selected = pending === date

            return (
              <button
                key={date}
                type="button"
                disabled={!canMakeup}
                onClick={() => setPending(date)}
                title={day ? `${date}${isMakeup ? ` · ${t("ck.makeupMark")}` : ""}` : date}
                className={cn(
                  "relative flex h-9 flex-col items-center justify-center rounded-md text-xs transition-colors",
                  day && !isMakeup && "bg-emerald-500 text-white dark:bg-emerald-600",
                  isMakeup && "bg-amber-500 text-white dark:bg-amber-600",
                  !day && isPast && "text-muted-foreground",
                  canMakeup && "cursor-pointer border border-dashed border-muted-foreground/40 hover:bg-accent hover:text-foreground",
                  selected && "ring-2 ring-primary",
                  isFuture && "opacity-30",
                  isToday && !day && "font-semibold text-foreground",
                )}
              >
                <span>{Number(date.slice(8))}</span>
                {isMakeup && <span className="text-[9px] leading-none">{t("ck.makeupMark")}</span>}
                {day && !isMakeup && <Check className="h-3 w-3" />}
              </button>
            )
          })}
        </div>

        {/* 图例 */}
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-emerald-500" /> {t("ck.legendNormal")}
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-amber-500" /> {t("ck.legendMakeup")}
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-sm border border-dashed border-muted-foreground/50" /> {t("ck.legendMissed")}
          </span>
        </div>

        <DialogFooter className="flex-col items-stretch gap-2 sm:flex-col">
          {pending ? (
            <>
              <p className="text-sm">{t("ck.makeupConfirm", { date: pending })}</p>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setPending(null)} disabled={busy}>
                  {t("common.cancel")}
                </Button>
                <Button size="sm" onClick={() => void doMakeup()} disabled={busy}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {t("ck.makeup")}
                </Button>
              </div>
            </>
          ) : (
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.close")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
