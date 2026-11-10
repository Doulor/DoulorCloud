import * as React from "react"

import { notificationApi } from "@/services/api"
import {
  currentNotifyEnabled,
  isUserWatching,
  notifyPermission,
  requestNotifyPermission,
  showSystemNotification,
} from "@/lib/web-notify"
import { useT } from "@/i18n"

/** 轮询间隔。与侧边栏消息铃铛一致（都是 1 分钟）。 */
const POLL_MS = 60_000

/** 记住「已经弹过哪一条」，避免刷新页面后同一条未读重复弹。 */
const SEEN_KEY = "doulor-notified-id"

export type NotifyPermission = "unsupported" | "default" | "granted" | "denied"

function readPermission(): NotifyPermission {
  return notifyPermission() as NotifyPermission
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

/**
 * 只管**权限**（申请 / 读状态），不做任何轮询。
 *
 * 为什么要把权限和播报拆开：设置页那张卡只需要权限与测试按钮，不该顺带起一个轮询；
 * 播报交给挂在全局布局上的 `MessageNotifyWatcher`。两处都轮询的话，同一时刻会并发
 * 拉两次接口、还可能各弹一条。
 */
export function useNotifyPermission() {
  const [permission, setPermission] = React.useState<NotifyPermission>(() => readPermission())

  // 切回前台时重读一次（用户可能在系统设置里改过）
  React.useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) setPermission(readPermission())
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [])

  const request = React.useCallback(async () => {
    const res = (await requestNotifyPermission()) as NotifyPermission
    setPermission(res)
    return res
  }, [])

  return { permission, request }
}

/**
 * 挂着就轮询"最新一条未读通知"，用户不在看页面时弹系统通知。
 * 只在 `MessageNotifyWatcher`（全局布局）里用一次。
 */
export function useMessageNotify() {
  const { lang } = useT()

  /**
   * 真实可用性（桥接优先）。
   *
   * 🔴 2026-11-10 修：以前判 `permission === "granted"`，而 App 的 WebView 里网页权限
   *    恒为 `denied`，于是这段轮询从没启动过 —— 站内消息永远不弹。与邮件那条同一个坑。
   */
  const [ready, setReady] = React.useState(false)
  React.useEffect(() => {
    let alive = true
    const check = () => {
      void currentNotifyEnabled().then((v) => {
        if (alive) setReady(v)
      })
    }
    check()
    document.addEventListener("visibilitychange", check)
    return () => {
      alive = false
      document.removeEventListener("visibilitychange", check)
    }
  }, [])

  React.useEffect(() => {
    if (!ready) return
    let stopped = false

    const tick = async () => {
      // 用户正看着页面就不打扰（WebView 里 page visibility 有时不更新，
      // 再叠一个 hasFocus 判断：App 切后台时 focus 一定是丢的）
      if (isUserWatching()) return
      try {
        const item = await notificationApi.latest(lang)
        if (stopped || !item) return
        if (localStorage.getItem(SEEN_KEY) === item.id) return

        // 先发、成功了才记「已弹过」（失败时别把这封/这条永久吞掉）
        const res = await showSystemNotification(item.title, {
          body: item.body,
          tag: item.id,
          url: item.link || "/dashboard/messages",
        })
        if (res.ok) localStorage.setItem(SEEN_KEY, item.id)
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
  }, [ready, lang])
}

/**
 * 挂在 DashboardLayout 上的常驻哨兵：让**任何页面**都能收到站内消息/通知的系统通知。
 *
 * 为什么必须常驻：之前这套轮询只写在设置页那张卡片里 —— 也就是说只有"人在设置页"
 * 的时候才会播报，站内消息几乎永远弹不出来。站长 2026-11-10 追问"消息中心能不能也收到"
 * 才发现这个空档。
 */
export function MessageNotifyWatcher(): null {
  useMessageNotify()
  return null
}
