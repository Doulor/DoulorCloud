/**
 * 访问统计埋点：监听路由变化，用 sendBeacon 上报一次页面浏览。
 *
 * 设计：
 *   - 放在 App 顶层，路由每切换一次就上报一次（SPA 的「页面浏览」= 路由变化）
 *   - 用 navigator.sendBeacon 上报，页面关闭/跳转时也不丢，且不阻塞渲染
 *   - visitor_id 存 localStorage（随机 UUID），用于后端算 UV
 *   - 上报失败静默，绝不影响页面
 */
import * as React from "react"
import { useLocation } from "react-router-dom"
import { perfRouteChange } from "@/lib/perf-collect"
import { diagRoute } from "@/lib/diag-log"

const VISITOR_KEY = "doulor:visitor"

function getVisitorId(): string {
  try {
    let id = localStorage.getItem(VISITOR_KEY)
    if (!id) {
      id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`
      localStorage.setItem(VISITOR_KEY, id)
    }
    return id
  } catch {
    return ""
  }
}

export function AnalyticsTracker() {
  const location = useLocation()

  React.useEffect(() => {
    const visitorId = getVisitorId()
    if (!visitorId) return

    const payload = JSON.stringify({
      visitorId,
      path: location.pathname,
      referrer: document.referrer || "",
    })

    try {
      // sendBeacon 保证页面关闭/跳转时也送达；不支持则回退 fetch
      if (navigator.sendBeacon) {
        navigator.sendBeacon("/api/analytics/track", new Blob([payload], { type: "application/json" }))
      } else {
        void fetch("/api/analytics/track", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          keepalive: true,
        })
      }
    } catch {
      /* 埋点失败静默 */
    }
  }, [location.pathname])

  return null
}

/**
 * 性能采集 + 诊断日志的路由钩子（2026-10-10）。
 *
 * 与 AnalyticsTracker 同一模式：路由变化时做两件事（都内部判开关，未启用时零开销）：
 *   · perfRouteChange：上报「切换耗时」样本（从上一次路由解析到现在 = 新页面可交互）；
 *   · diagRoute：诊断日志记一条路由切换（用户反馈附日志时还原操作路径全靠它）。
 */
export function PerfTracker() {
  const location = useLocation()
  const lastRouteAt = React.useRef(Date.now())

  React.useEffect(() => {
    const now = Date.now()
    const navMs = now - lastRouteAt.current
    lastRouteAt.current = now
    // 挂载后的第一次解析是「首屏」（perfRouteChange 内部识别，不发切换样本）
    perfRouteChange(location.pathname, navMs)
    diagRoute(location.pathname)
  }, [location.pathname])

  return null
}
