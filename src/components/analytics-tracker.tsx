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
