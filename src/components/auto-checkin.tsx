import * as React from "react"
import { toast } from "sonner"

import { checkinApi } from "@/services/api"
import { useT } from "@/i18n"

/**
 * 自动签到：进站后如果用户开了「自动签到」且今天还没签，就自动签一次，
 * 右下角弹窗提示获得的积分（含里程碑额外奖励）。
 *
 * 每会话只触发一次（sessionStorage 防重复导航反复签）；失败静默（不打扰用户，
 * 手动签到仍可用）。
 */
export function AutoCheckin() {
  const { t } = useT()

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        if (sessionStorage.getItem("auto-checkin-ran")) return
        const status = await checkinApi.status()
        if (cancelled) return
        sessionStorage.setItem("auto-checkin-ran", "1")
        if (!status.enabled || !status.autoCheckin || status.checkedIn) return

        const res = await checkinApi.do()
        if (cancelled) return
        toast.success(
          res.milestoneHit
            ? t("ck.autoDoneBonus", { points: res.total, bonus: res.milestoneHit.points })
            : t("ck.autoDone", { points: res.total })
        )
      } catch {
        /* 静默：自动签到失败不打扰用户 */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [t])

  return null
}
