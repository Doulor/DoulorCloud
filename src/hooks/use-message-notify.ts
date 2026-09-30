import * as React from "react"

import { notificationApi } from "@/services/api"
import { useT } from "@/i18n"

/** 轮询间隔。与侧边栏消息铃铛一致（都是 1 分钟）。 */
const POLL_MS = 60_000

/** 记住「已经弹过哪一条」，避免刷新页面后同一条未读重复弹。 */
const SEEN_KEY = "doulor-notified-id"

export type NotifyPermission = "unsupported" | "default" | "granted" | "denied"

function readPermission(): NotifyPermission {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported"
  return Notification.permission as NotifyPermission
}

/**
 * 网页侧的系统通知（零配置）。
 *
 * 为什么不需要任何配置：网页在 App 的 WebView 里本来就是登录态，自己知道「我是谁」，
 * 所以只要调用标准的 `Notification` API 即可 —— WebToApp 会把它桥接成系统通知
 * （`NativeBridge.showWebNotification`）。这与「App 自带的轮询服务」不同，
 * 后者是原生服务、拿不到网页的登录态，才必须靠每人一个令牌。
 *
 * 两条刻意的约束：
 *   1. **只在页面不可见时才弹**。用户正看着本站时，侧边栏的角标已经能说明问题，
 *      再弹一个系统通知是打扰。
 *   2. **弹过的不重复弹**：用 localStorage 记住上一条的 id。
 *      因为服务端返回的是「最新一条未读」，用户没读之前它会一直是同一条。
 *
 * ⚠️ 页面被关掉/被系统冻结时收不到 —— 浏览器端没有 Service Worker 就没有后台推送，
 *    App 端退到后台时 WebView 的 JS 同样会被冻结。要「关着也能收」只能走原生推送。
 */
export function useMessageNotify() {
  const { lang } = useT()
  const [permission, setPermission] = React.useState<NotifyPermission>(() => readPermission())

  React.useEffect(() => {
    if (permission !== "granted") return
    let stopped = false

    const tick = async () => {
      // 用户正看着页面就不打扰
      if (!document.hidden) return
      try {
        const item = await notificationApi.latest(lang)
        if (stopped || !item) return
        if (localStorage.getItem(SEEN_KEY) === item.id) return
        localStorage.setItem(SEEN_KEY, item.id)

        const n = new Notification(item.title, {
          body: item.body,
          icon: "/favicon.png?v=2",
          tag: item.id,
        })
        n.onclick = () => {
          window.focus()
          window.location.assign(item.link || "/dashboard/messages")
          n.close()
        }
      } catch {
        // 通知失败不该打扰用户（权限被系统撤销、App 侧能力未开启等）
      }
    }

    void tick()
    const timer = window.setInterval(tick, POLL_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [permission, lang])

  /** 申请权限。必须由用户点击触发，否则浏览器会直接拒绝。 */
  const request = React.useCallback(async () => {
    if (!("Notification" in window)) {
      setPermission("unsupported")
      return "unsupported" as NotifyPermission
    }
    try {
      const res = await Notification.requestPermission()
      setPermission(res as NotifyPermission)
      return res as NotifyPermission
    } catch {
      return readPermission()
    }
  }, [])

  return { permission, request }
}
