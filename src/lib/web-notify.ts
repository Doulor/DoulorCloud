/**
 * 网页原生通知的统一入口（2026-11-10）。
 *
 * 为什么需要这一层：此前两处通知代码都直接 `new Notification(...)`，
 * 而 **Android 的 Chrome / WebView 不支持 `new Notification()` 构造器** ——
 * 调它只会抛 `TypeError: Illegal constructor`，页面里被 try/catch 吞掉，表现就是
 * "明明开了通知，却从来不弹"。桌面 Chrome / iOS PWA 反而支持构造器，所以这类问题
 * 只在手机上暴露。
 *
 * 正确姿势是走 **Service Worker 的 `registration.showNotification()`**：
 *   · Android Chrome / WebView：唯一可用的路径；
 *   · 桌面 Chrome / Firefox：可用；
 *   · iOS 16.4+ PWA（添加到主屏）：可用。
 * 构造器只在「SW 不可用」时作为兜底（老桌面浏览器、部分内嵌 WebView 的 polyfill）。
 *
 * 本模块同时提供 `probeNotification()`：把当前环境的实际能力探出来，给设置页的
 * 「发送测试通知」用 —— 用户点一下就知道到底是没权限、还是壳子不支持。
 */

export interface NotifyProbe {
  /** 有没有 Notification 这个 API（WebView 里可能完全没有） */
  hasNotificationApi: boolean
  /** 权限状态；没有该 API 时是 "unsupported" */
  permission: NotificationPermission | "unsupported"
  /** 有没有 Service Worker 能力 */
  hasServiceWorker: boolean
  /** SW 是否已注册成功（注册不上就拿不到 showNotification） */
  swReady: boolean
  /** SW 注册对象上有没有 showNotification */
  swShowNotification: boolean
  /** `new Notification()` 能不能用（Android 上通常是 false） */
  ctorWorks: boolean
  /** 构造器抛出的错误信息（便于排查） */
  ctorError: string | null
  /** 实际弹出的那条走的是哪条路 */
  path: "service-worker" | "constructor" | "none"
  /** 失败原因（成功时为 null） */
  error: string | null
  /** 浏览器标识，便于判断是哪个壳子 */
  ua: string
}

/** 读权限；环境不支持时返回 "unsupported" */
export function notifyPermission(): NotificationPermission | "unsupported" {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported"
  return Notification.permission
}

/**
 * 用户是否正看着本站 —— 反过来说，`false` 就意味着"可以弹通知了"。
 *
 * 为什么不只看 `document.hidden`：WebView（尤其 Android 壳子）在 App 切到后台时
 * 经常**不更新** page visibility，`hidden` 一直是 false，于是通知永远弹不出来。
 * 再叠一个 `document.hasFocus()`：App 到后台时焦点一定是丢的。
 * 代价是某些壳子里 `hasFocus()` 恒为 false —— 那也只是"多弹"，而重复由 tag 去重。
 */
export function isUserWatching(): boolean {
  if (typeof document === "undefined") return false
  if (document.hidden) return false
  try {
    return document.hasFocus()
  } catch {
    return true
  }
}

/** 申请权限（必须由用户点击触发） */
export async function requestNotifyPermission(): Promise<
  NotificationPermission | "unsupported"
> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported"
  try {
    // 老 Safari 只支持回调式，这里兼容一下
    const maybe = Notification.requestPermission()
    if (maybe && typeof (maybe as Promise<NotificationPermission>).then === "function") {
      return await (maybe as Promise<NotificationPermission>)
    }
    return await new Promise<NotificationPermission>((resolve) => {
      Notification.requestPermission((p) => resolve(p))
    })
  } catch {
    return notifyPermission()
  }
}

/** 拿一个「已激活的」SW 注册；`clients.claim` 之后 ready 会很快 resolve */
async function swRegistration(timeoutMs = 4000): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null
  try {
    const ready = navigator.serviceWorker.ready
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))
    return await Promise.race([ready, timeout])
  } catch {
    return null
  }
}

export interface ShowNotifyOptions {
  body?: string
  /** 点通知要跳去的站内路径 */
  url?: string
  tag?: string
  icon?: string
}

export interface ShowNotifyResult {
  ok: boolean
  path: "service-worker" | "constructor" | "none"
  error: string | null
}

/**
 * 弹一条系统通知。优先 Service Worker（Android 唯一可行），失败再退回构造器。
 * 不抛错 —— 通知失败永远不该影响业务。
 */
export async function showSystemNotification(
  title: string,
  opts: ShowNotifyOptions = {}
): Promise<ShowNotifyResult> {
  const icon = opts.icon ?? "/favicon.png?v=2"

  // 1) Service Worker：Android / 桌面 / iOS PWA 都支持
  const reg = await swRegistration()
  if (reg && typeof reg.showNotification === "function") {
    try {
      await reg.showNotification(title, {
        body: opts.body ?? "",
        icon,
        badge: icon,
        tag: opts.tag,
        data: { url: opts.url ?? "/dashboard" },
      })
      return { ok: true, path: "service-worker", error: null }
    } catch (err) {
      // 落到构造器兜底，把原因带回给调用方
      const fallback = tryCtor(title, opts, icon)
      return fallback.ok
        ? fallback
        : { ok: false, path: "none", error: `${msgOf(err)}；构造器也失败：${fallback.error}` }
    }
  }

  // 2) 构造器兜底（桌面旧浏览器 / 壳子注入的 polyfill）
  return tryCtor(title, opts, icon)
}

function tryCtor(
  title: string,
  opts: ShowNotifyOptions,
  icon: string
): ShowNotifyResult {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return { ok: false, path: "none", error: "当前环境没有 Notification API" }
  }
  try {
    const n = new Notification(title, {
      body: opts.body ?? "",
      icon,
      tag: opts.tag,
    })
    const url = opts.url ?? "/dashboard"
    n.onclick = () => {
      window.focus()
      window.location.assign(url)
      n.close()
    }
    return { ok: true, path: "constructor", error: null }
  } catch (err) {
    return { ok: false, path: "none", error: msgOf(err) }
  }
}

/**
 * 探测当前环境：跑一条**真实**的测试通知，并把每条路径的成功/失败都记下来。
 * 结果给设置页显示，用户据此就能知道"为什么收不到"。
 */
export async function probeNotification(): Promise<NotifyProbe> {
  const hasNotificationApi =
    typeof window !== "undefined" && "Notification" in window
  const permission = notifyPermission()
  const hasServiceWorker =
    typeof navigator !== "undefined" && "serviceWorker" in navigator

  const reg = await swRegistration()
  const swShowNotification = Boolean(reg && typeof reg.showNotification === "function")

  // 单独试一下构造器，把错误留下来（Android 上这里会抛 Illegal constructor）
  let ctorWorks = false
  let ctorError: string | null = null
  if (hasNotificationApi) {
    try {
      const n = new Notification("Doulor Cloud 测试", { body: "构造器可用" })
      ctorWorks = true
      n.close()
    } catch (err) {
      ctorError = msgOf(err)
    }
  }

  const shown = await showSystemNotification("Doulor Cloud 测试通知", {
    body: "看到这条说明通知已经通了 🎉",
    url: "/dashboard/email",
    tag: "doulor-probe",
  })

  return {
    hasNotificationApi,
    permission,
    hasServiceWorker,
    swReady: Boolean(reg),
    swShowNotification,
    ctorWorks,
    ctorError,
    path: shown.path,
    error: shown.error,
    ua: typeof navigator !== "undefined" ? navigator.userAgent : "",
  }
}

function msgOf(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return String(err)
}
