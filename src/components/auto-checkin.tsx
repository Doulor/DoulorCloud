import * as React from "react"
import { toast } from "sonner"

import { HttpError, checkinApi } from "@/services/api"
import { notifyPointsChanged } from "@/components/points-badge"
import { useAuth } from "@/hooks/use-auth"
import { useT } from "@/i18n"
import { decideAutoCheckin, shouldMarkAfterAttempt } from "@/lib/auto-checkin"

/**
 * 自动签到：进站后如果用户开了「自动签到」且今天还没签，就自动签一次，
 * 右下角弹窗提示获得的积分（含里程碑额外奖励），并刷新顶栏积分徽章。
 *
 * ── 为什么守卫记的是「站点日期」而不是一个布尔量 ──
 * 旧实现用 `sessionStorage["auto-checkin-ran"] = "1"` 表示「这次会话跑过了」。
 * 问题是 sessionStorage 会跟着**标签页 / PWA / App 内 WebView 的存活期**一直留着，
 * 于是有两类必然踩中的失效：
 *   1. 页面（或 App）开着过夜：标记还在，第二天永远不会再自动签；
 *   2. 开关是本次会话中途才打开的：标记早已置上，本次会话不再生效。
 * 现在记为 `auto-checkin-day = <站点时区 YYYY-MM-DD>`，同一天只处理一次，
 * 跨天（或重新进前台）自然会重新判定。
 *
 * ── 为什么还要监听可见性 ──
 * 常驻页面（PWA、App 内 WebView 被切到后台再切回）不会重新挂载组件，
 * 只在挂载时跑一次的实现跨天就再也等不到。回到前台时补跑一次，
 * 只要距上次检查超过 {@link MIN_INTERVAL_MS} 才真正打接口，避免频繁请求。
 *
 * ── 失败为什么不写标记 ──
 * 读状态或签到失败（网络抖动、邮箱未验证被拦…）时不写标记，留待下次触发重试；
 * 只有「已签 / 签到成功 / 别处已签」这类**今天已经尘埃落定**的结果才写。
 * 单次失败不弹窗打扰（手动签到仍可用），但也不会像旧实现那样把这次会话一次性烧掉。
 */
const DAY_KEY = "auto-checkin-day"
/** 回到前台时的最小复查间隔（同一会话内） */
const MIN_INTERVAL_MS = 5 * 60 * 1000

function readDay(): string | null {
  try {
    return sessionStorage.getItem(DAY_KEY)
  } catch {
    return null
  }
}

function writeDay(day: string): void {
  try {
    sessionStorage.setItem(DAY_KEY, day)
  } catch {
    /* 隐私模式下可能抛错：不影响本次签到，只是下次可能重复判定一次 */
  }
}

export function AutoCheckin() {
  const { t } = useT()
  const { user } = useAuth()

  React.useEffect(() => {
    // 未登录不打接口（旧实现会白挨一次 401）
    if (!user) return
    let cancelled = false
    let lastRun = 0

    const run = async (): Promise<void> => {
      lastRun = Date.now()
      let status: Awaited<ReturnType<typeof checkinApi.status>>
      try {
        status = await checkinApi.status()
      } catch {
        return // 读状态失败：静默，下次可见性变化/重挂载再试
      }
      if (cancelled) return

      // 判定内核是纯函数（见 src/lib/auto-checkin.ts），这里只负责执行副作用
      const day = status.today ?? ""
      const decision = decideAutoCheckin(status, readDay())
      if (decision.kind === "skip") return
      if (decision.kind === "done") {
        if (day) writeDay(day)
        return
      }

      let attempt: "success" | "already" | "error" = "error"
      let outcome: Awaited<ReturnType<typeof checkinApi.do>> | null = null
      try {
        outcome = await checkinApi.do()
        attempt = "success"
      } catch (err) {
        // 竞态：别处（另开标签 / 手动）刚好签过了 —— 当成今天已完成，不弹错
        if (err instanceof HttpError && err.code === "ALREADY_CHECKED_IN") attempt = "already"
        /* 其余失败静默：不写标记，留待下次触发重试 */
      }
      if (cancelled) return
      if (shouldMarkAfterAttempt(attempt) && day) writeDay(day)
      if (attempt !== "success" || !outcome) return

      notifyPointsChanged() // 顶栏积分徽章立即反映自动签到的加分
      toast.success(
        outcome.milestoneHit
          ? t("ck.autoDoneBonus", { points: outcome.total, bonus: outcome.milestoneHit.points })
          : t("ck.autoDone", { points: outcome.total })
      )
    }

    void run()

    // 页面/App 常驻跨天时，回到前台补跑（详见文件头说明）
    const onVisible = () => {
      if (document.visibilityState !== "visible") return
      if (Date.now() - lastRun < MIN_INTERVAL_MS) return
      void run()
    }
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("focus", onVisible)
    return () => {
      cancelled = true
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("focus", onVisible)
    }
  }, [t, user])

  return null
}
