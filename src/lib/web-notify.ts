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
import {
  bridgeNotifyState,
  bridgeShowNotification,
  bridgeToast,
  getNativeBridge,
  hasNativeBridge,
  openBridgeNotificationSettings,
  requestBridgePermission,
} from "./native-bridge"

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
  path: "bridge" | "service-worker" | "constructor" | "none"
  /** 失败原因（成功时为 null） */
  error: string | null
  /** 页面里存在的 App 壳子桥接对象（如 NativeBridge）；空 = 没有注入 */
  bridges: string[]
  /** 桥接对象上名字带 notif/toast 的方法，便于确认该调哪个 */
  bridgeMethods: string[]
  /** 桥接是否存在（有它才有戏） */
  bridgePresent: boolean
  /** App 自身有没有通知权限（读不到 = null；false = 桥接说没开） */
  bridgeEnabled: boolean | null
  /** `areNotificationsEnabled()` 的原始返回 */
  bridgeRawEnabled: string | null
  /** `getNotificationPermissionState()` 的原始返回（WebView 里常是 denied，别全信） */
  bridgeRawState: string | null
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
  // 用户显式打开「始终提醒」时不受"正在看页面"影响（见设置页那个开关）
  if (notifyAlways()) return false
  if (document.hidden) return false
  try {
    return document.hasFocus()
  } catch {
    return true
  }
}

/** 「即使我正在用也提醒」的开关键（localStorage，纯前端偏好） */
const ALWAYS_KEY = "doulor-notify-always"

export function notifyAlways(): boolean {
  try {
    return localStorage.getItem(ALWAYS_KEY) === "1"
  } catch {
    return false
  }
}

export function setNotifyAlways(on: boolean): void {
  try {
    if (on) localStorage.setItem(ALWAYS_KEY, "1")
    else localStorage.removeItem(ALWAYS_KEY)
  } catch {
    // 隐私模式下 localStorage 可能不可用，忽略
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
  path: "bridge" | "service-worker" | "constructor" | "none"
  error: string | null
}

/**
 * App 壳子（WebToApp 一类）注入的原生桥接对象候选名。
 *
 * 为什么必须探测：Android 的 WebView **不会**把网页通知权限交给页面 ——
 * `Notification.requestPermission()` 既不弹框、`Notification.permission` 永远停在
 * "default"，`showNotification()` 直接 `NotAllowedError`（站长 2026-11-10 的真机诊断）。
 * 这种情况下网页侧无解，只能调壳子自己注入的 JS 接口，由原生侧去发通知。
 */
const BRIDGE_NAMES = [
  "NativeBridge",
  "WebToApp",
  "WebToAppBridge",
  "AndroidBridge",
  "Android",
  "android",
  "AppBridge",
  "JSBridge",
  "App",
  "app",
] as const

interface BridgeReport {
  /** 页面上实际存在的桥接对象名 */
  names: string[]
  /** 每个对象上「名字里带通知」的方法，便于确认到底该调哪个 */
  methods: string[]
}

/** 扫一遍 window，看壳子到底注入了什么（只读，不做任何调用） */
export function detectBridges(): BridgeReport {
  const names: string[] = []
  const methods: string[] = []
  if (typeof window === "undefined") return { names, methods }

  for (const key of BRIDGE_NAMES) {
    const v = (window as unknown as Record<string, unknown>)[key]
    if (!v || (typeof v !== "object" && typeof v !== "function")) continue
    names.push(key)
    try {
      for (const prop of Object.keys(v as object)) {
        if (/notif|toast|alert|message/i.test(prop)) methods.push(`${key}.${prop}`)
      }
    } catch {
      // 某些 bridge 的属性访问会抛，忽略
    }
  }
  return { names, methods }
}

/**
 * 试着走壳子的原生桥接发通知（真正的调用实现在 native-bridge.ts）。
 *
 * 为什么不自己遍历方法名：站长真机的桥接已经暴露出完整 API
 * （`showWebNotification` / `requestNotificationPermission` / `areNotificationsEnabled` …），
 * 把权限与发送分开交给那一个模块管，比在这里瞎试三个方法名可靠得多。
 */
async function tryBridge(title: string, opts: ShowNotifyOptions): Promise<boolean> {
  return bridgeShowNotification(title, opts.body ?? "", opts.url ?? "/dashboard")
}

/* ---- 通知内容消毒（渗透测试 finding #3，2026-11-10）----
 *
 * 这一层是**纵深防御**：服务端 `/api/mailbox/latest-unread` 已经不再把邮件内容拼进
 * 通知标题、并且清洗过正文，但 `showSystemNotification` 是全站唯一的通知出口 ——
 * 站内消息、设置页测试通知、以后新增的调用方都会经过这里。任何人把"外部可控文本"
 * 直接传进来，都不该变成一条可以冒充官方的系统通知（点一下就跳走的钓鱼弹窗）。
 *
 * 规则必须与 `worker/src/notify-text.ts` 里的同名函数**保持一致**：
 *   1. 控制字符（换行/回车/制表）先换成空格再压缩 —— 通知只显示一行，
 *      直接删会粘连成一个词；
 *   2. 删零宽 / 双向控制符（不可见，却能让文本"凭空多字"或反向显示）；
 *   3. 删 `<` `>`（通知里不该出现标记；壳子若按 HTML 解析也不会成标签）；
 *   4. 连续空白压成单空格并 trim；最后才截断。
 */
function sanitizeNotifyText(input: string, max: number): string {
  const cleaned = String(input ?? "")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return cleaned.slice(0, Math.max(0, Math.trunc(max)))
}

/** 通知点击跳转的兜底路径（`safeInternalUrl` 拒绝非法 url 时用） */
const SAFE_FALLBACK_URL = "/dashboard"
/** 标题上限：够放两行；正文上限：够放下发件人 + 主题（且只显示两三行） */
const NOTIFY_TITLE_MAX = 120
const NOTIFY_BODY_MAX = 200
/** 清洗后标题为空时的兜底 —— 宁可有标题，也不要弹一条空白的系统通知 */
const NOTIFY_TITLE_FALLBACK = "Doulor Cloud"

/**
 * 通知点击跳转地址白名单化（finding #3，2026-11-10）。
 *
 * 只接受**站内绝对路径**：以单个 `/` 开头，且不是协议相对地址 `//`、不是 `/\`
 * （浏览器/壳子会把 `//evil.com`、`/\evil.com` 都解析成外站）。其余一律退回
 * `/dashboard` —— 带外域的 url 会把点通知的人送去钓鱼站，而 `javascript:` 之类
 * 在构造器路径上是直接的脚本执行面（`location.assign(url)`）。
 *
 * 额外拒绝控制字符：换行/制表符会让某些 URL 解析器把主机名截断成另一个站。
 */
function safeInternalUrl(url: string | undefined): string {
  const raw = String(url ?? "").trim()
  if (!raw.startsWith("/")) return SAFE_FALLBACK_URL
  if (raw.startsWith("//") || raw.startsWith("/\\")) return SAFE_FALLBACK_URL
  if (/[\u0000-\u001F\u007F]/.test(raw)) return SAFE_FALLBACK_URL
  return raw
}

/**
 * 弹一条系统通知。优先级：壳子原生桥接 → Service Worker → 构造器。
 *
 * 为什么桥接排第一：真机（Android WebView）里前两条都拿不到权限，
 * 只有壳子注入的接口能把通知真正弹出来。桌面浏览器没有桥接，会自然落到 SW。
 * 不抛错 —— 通知失败永远不该影响业务。
 *
 * 🔒 2026-11-10（finding #3）：入口处统一清洗 title/body、白名单化 url，
 *    下游三条路径（桥接 / `showNotification` / 构造器）用的都是清洗后的值。
 */
export async function showSystemNotification(
  title: string,
  opts: ShowNotifyOptions = {}
): Promise<ShowNotifyResult> {
  const icon = opts.icon ?? "/favicon.png?v=2"

  // 清洗后的通知内容：三条发送路径只认这里的值，避免哪条路径漏洗
  const safeTitle = sanitizeNotifyText(title, NOTIFY_TITLE_MAX) || NOTIFY_TITLE_FALLBACK
  const safeOpts: ShowNotifyOptions = {
    body: sanitizeNotifyText(opts.body ?? "", NOTIFY_BODY_MAX),
    url: safeInternalUrl(opts.url),
    tag: opts.tag,
    icon,
  }

  // 0) 壳子原生桥接（Android WebView 唯一可行的一条）
  //
  //    ⚠️ **先发，再问状态**。原因很具体（2026-11-10 真机）：用户系统里明明开着通知，
  //       壳子的 `areNotificationsEnabled()` 却回报 `denied`（它读的可能是 WebView 的
  //       网页权限，而不是 Android 应用级开关）。上一版拿这个值当闸门，结果"系统开着
  //       也说没开、通知永远不发"。现在状态只用于**解释失败原因**，不再拦发送。
  //
  //    这里也**不主动弹权限框** —— 那必须由用户点击触发，交给设置页的按钮做。
  if (hasNativeBridge()) {
    if (await tryBridge(safeTitle, safeOpts)) {
      return { ok: true, path: "bridge", error: null }
    }
    const state = await bridgeNotifyState()
    if (state.enabled === false) {
      return {
        ok: false,
        path: "none",
        error:
          "桥接调用失败，且 App 回报没有通知权限（若系统里其实开着，见设置页诊断里的 App 权限原值）",
      }
    }
  }

  // 1) Service Worker：桌面 / iOS PWA / 少数允许通知的 WebView
  const reg = await swRegistration()
  if (reg && typeof reg.showNotification === "function") {
    try {
      // ⚠️ 刻意**不传 `badge`**（2026-11-10 真机排查）：Firefox for Android 对 badge
      //    （状态栏小图标）很挑剔，传了它整条通知会被静默丢弃 —— `showNotification`
      //    照常 resolve，用户却什么也看不到。同一台机器上不带 badge 的纯净页能正常弹，
      //    带上就消失，这就是当时的唯一差异。
      // ⚠️ `tag` 也不能固定：同一个 tag 复用会把上一条"替换"掉；调试时连续点几次，
      //    看起来就像"从来没弹过"。这里按调用追加时间戳，去重逻辑仍然由调用方的
      //    localStorage（见两个 hook）负责。
      await reg.showNotification(safeTitle, {
        body: safeOpts.body ?? "",
        icon,
        tag: safeOpts.tag ? `${safeOpts.tag}-${Date.now()}` : undefined,
        data: { url: safeOpts.url ?? "/dashboard" },
      })
      return { ok: true, path: "service-worker", error: null }
    } catch (err) {
      // 落到构造器兜底，把原因带回给调用方
      const fallback = tryCtor(safeTitle, safeOpts, icon)
      return fallback.ok
        ? fallback
        : { ok: false, path: "none", error: `${msgOf(err)}；构造器也失败：${fallback.error}` }
    }
  }

  // 2) 构造器兜底（桌面旧浏览器 / 壳子注入的 polyfill）
  return tryCtor(safeTitle, safeOpts, icon)
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

  const bridge = detectBridges()
  const bstate = await bridgeNotifyState()

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
    bridges: bridge.names,
    bridgeMethods: bridge.methods,
    bridgePresent: bstate.present,
    bridgeEnabled: bstate.enabled,
    bridgeRawEnabled: bstate.rawEnabled,
    bridgeRawState: bstate.rawState,
    ua: typeof navigator !== "undefined" ? navigator.userAgent : "",
  }
}

/**
 * 「发送测试通知」前的一步：把 App 侧的通知权限要下来。
 *
 * 只有壳子桥接存在时才做（普通浏览器走标准 `Notification.requestPermission()`）。
 * 返回：`null` = 没有桥接 / 读不到状态；`true` = 已开；`false` = 没开成（要引导去系统设置）。
 */
export async function ensureNotifyPermission(): Promise<boolean | null> {
  if (!hasNativeBridge()) return null
  const before = await bridgeNotifyState()
  if (before.enabled === true) return true
  const after = await requestBridgePermission()
  if (after === false) {
    // 权限被永久拒绝 / 用户没点允许 —— 把系统设置页打开，否则永远收不到
    openBridgeNotificationSettings()
    bridgeToast("请在系统设置里允许本应用发送通知")
  }
  return after
}

/**
 * 只读地取一次「现在到底能不能弹」：有原生桥接看 App 的开关，否则看浏览器权限。
 * 设置页用它显示准确状态（不用点测试也能看出是开是关）。
 */
export async function currentNotifyEnabled(): Promise<boolean> {
  if (hasNativeBridge()) {
    const s = await bridgeNotifyState()
    return s.enabled === true
  }
  return notifyPermission() === "granted"
}

/** 给设置页用的：直接跳到 App 的通知设置 */
export function openNotifySettings(): boolean {
  if (hasNativeBridge()) return openBridgeNotificationSettings()
  return false
}

/** 调试用：当前有没有桥接（设置页显示一行"原生桥接"） */
export function nativeBridgePresent(): boolean {
  return getNativeBridge() !== null
}

function msgOf(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return String(err)
}
