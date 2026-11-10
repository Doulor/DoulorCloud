import * as React from "react"

import { emailApi } from "@/services/api"
import { isUserWatching, notifyPermission, showSystemNotification } from "@/lib/web-notify"
import { useT } from "@/i18n"

/** 轮询间隔：与站内消息通知一致（1 分钟）。 */
const POLL_MS = 60_000

/** 记住「已经弹过哪一封」，避免刷新页面后同一封未读重复弹。 */
const SEEN_KEY = "doulor-notified-mail"

/**
 * 新邮件的**网页原生通知**（零配置）。
 *
 * 走的是和站内消息完全相同的那条路：页面在 WebView / 浏览器里本来就有登录态，
 * 直接调标准 `Notification` API 即可 —— WebToApp 会把它桥接成系统通知
 * （`NativeBridge.showWebNotification`）。不需要令牌、不需要每人在 App 里配置。
 *
 * 三条刻意保持的约束（与 `use-message-notify` 同口径，别改成"随时弹"）：
 *   1. **只在页面不可见时弹**：用户正盯着本站时，邮箱角标已经够了，再弹是打扰；
 *   2. **弹过的同一封不重复弹**：localStorage 记住上一条 id（服务端返回的是"最新一封未读"，
 *      用户没点开之前它会一直是同一封）；
 *   3. 失败静默：权限被系统撤销、App 侧能力没开，都不能影响页面本身。
 *
 * ⚠️ 已知边界：页面/App 被**完全关掉**（进程结束）时收不到 —— WebView 里的 JS 被冻结，
 *    浏览器端没有 Service Worker 推送就没有后台通道。要"关着也能收"只能做真正的
 *    Web Push（VAPID + Service Worker），那是另一件事。
 */
export function useMailNotify() {
  const { lang } = useT()
  const [permission, setPermission] = React.useState<NotificationPermission | "unsupported">(
    () => readPermission()
  )

  // 页面回到前台时重新读一次权限（用户可能在系统设置里改过）
  React.useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) setPermission(readPermission())
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [])

  React.useEffect(() => {
    if (permission !== "granted") return
    let stopped = false

    const tick = async () => {
      if (isUserWatching()) return
      try {
        const item = await emailApi.latestUnread(lang)
        if (stopped || !item) return
        if (localStorage.getItem(SEEN_KEY) === item.id) return
        localStorage.setItem(SEEN_KEY, item.id)

        await showSystemNotification(item.title, {
          body: item.body,
          tag: item.id,
          url: item.link || "/dashboard/email",
        })
      } catch {
        // 通知失败不该打扰用户
      }
    }

    void tick()
    const timer = window.setInterval(tick, POLL_MS)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [permission, lang])

  return { permission }
}

function readPermission(): NotificationPermission | "unsupported" {
  return notifyPermission()
}

/**
 * 挂在 DashboardLayout 上的"常驻哨兵"：不渲染任何东西，只负责让**任何页面**都能弹新邮件通知。
 *
 * 为什么必须常驻：权限是用户级的，播报不该只在"邮箱页打开着"时才工作 ——
 * 之前的站内消息通知就只在那一张设置卡挂着时才生效，等于形同虚设。
 */
export function MailNotifyWatcher(): null {
  useMailNotify()
  return null
}
