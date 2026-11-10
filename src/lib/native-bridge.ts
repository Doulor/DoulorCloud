/**
 * WebToApp 一类壳子注入的**原生通知桥接**（`window.NativeBridge`）。
 *
 * 为什么必须有这一层：Android 的 WebView 不会把网页通知权限交给页面 ——
 * `Notification.requestPermission()` 不弹框、权限永远是 `default`/`denied`，
 * 调发送接口直接 `NotAllowedError`（站长 2026-11-10 真机诊断）。
 * 壳子自己实现了 Android 通知（POST_NOTIFICATIONS），能力通过下面这些方法暴露：
 *
 *   NativeBridge.areNotificationsEnabled()
 *   NativeBridge.getNotificationPermissionState()
 *   NativeBridge.requestNotificationPermission()   ← 会弹系统授权框
 *   NativeBridge.openNotificationSettings()        ← 跳到 App 的通知设置页
 *   NativeBridge.showWebNotification(...)          ← 真正发通知
 *   NativeBridge.showToast(...)                    ← 兜底：App 内的 toast
 *
 * ⚠️ 这些方法的**返回形态各家不同**（bool / 字符串 / Promise / 无返回），
 *    所以这里全部按"尽力而为"处理：能解析就解析，解析不了就当未知，绝不抛错。
 */

type AnyBridge = Record<string, unknown> & {
  areNotificationsEnabled?: () => unknown
  getNotificationPermissionState?: () => unknown
  requestNotificationPermission?: () => unknown
  openNotificationSettings?: () => void
  showWebNotification?: (...args: unknown[]) => unknown
  showToast?: (...args: unknown[]) => void
}

/** 拿到壳子桥接对象；没有就返回 null（普通浏览器里就是 null） */
export function getNativeBridge(): AnyBridge | null {
  if (typeof window === "undefined") return null
  const b = (window as unknown as Record<string, unknown>).NativeBridge
  if (!b || (typeof b !== "object" && typeof b !== "function")) return null
  return b as AnyBridge
}

/** 有没有原生桥接 */
export function hasNativeBridge(): boolean {
  return getNativeBridge() !== null
}

/** 把各种奇怪返回统一成布尔；判断不了返回 null */
function asBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v
  if (typeof v === "number") return v !== 0
  if (typeof v === "string") {
    const s = v.trim().toLowerCase()
    if (["1", "true", "granted", "enabled", "yes", "on"].includes(s)) return true
    if (["0", "false", "denied", "disabled", "no", "off"].includes(s)) return false
  }
  return null
}

export interface BridgeNotifyState {
  /** 桥接是否存在 */
  present: boolean
  /**
   * App 有没有开通知权限。
   *
   * ⚠️ `null` = **读不到**（不是"没开"）。真机上这两种情况都出现过：
   *   · 桥子把 `areNotificationsEnabled()` 做成回调式，直接调只拿到 undefined；
   *   · `getNotificationPermissionState()` 回报的是 **WebView 的网页权限**（永远是
   *     denied），而不是 Android 的应用级开关（站长 2026-11-10 就撞上这条：
   *     系统里明明开着，桥却报 denied）。
   * 所以这个值只用来**提示**，绝不能拿它当作"不许发"的依据 —— 见 showSystemNotification。
   */
  enabled: boolean | null
  /** `areNotificationsEnabled()` 的原始返回 */
  rawEnabled: string | null
  /** `getNotificationPermissionState()` 的原始返回 */
  rawState: string | null
}

/**
 * 调一个可能"同步返回 / 返回 Promise / 回调式"的桥接方法，统一拿一个值。
 *
 * 为什么要这么麻烦：Android 的 JS 接口注入方式很多，同一个方法在不同壳子里可能是
 * `boolean areNotificationsEnabled()`、`Promise<boolean>`、甚至 `void f(cb)`。
 * 先按正常参数调一次；拿不到值再按回调式试一次（带 700ms 超时，绝不卡住页面）。
 */
async function callFlexible(
  fn: (...args: unknown[]) => unknown,
  thisArg: unknown,
  args: unknown[] = []
): Promise<unknown> {
  try {
    const r = fn.call(thisArg, ...args)
    if (r && typeof (r as Promise<unknown>).then === "function") {
      try {
        return await (r as Promise<unknown>)
      } catch {
        return null
      }
    }
    if (r !== undefined && r !== null) return r
  } catch {
    // 无参调用被拒（可能要求回调）→ 走下面
  }

  return await new Promise<unknown>((resolve) => {
    let done = false
    const finish = (v: unknown) => {
      if (done) return
      done = true
      resolve(v)
    }
    try {
      fn.call(thisArg, ...args, finish)
    } catch {
      finish(null)
      return
    }
    setTimeout(() => finish(null), 700)
  })
}

/** 读 App 侧的通知开关状态（只读，不会弹任何框） */
export async function bridgeNotifyState(): Promise<BridgeNotifyState> {
  const b = getNativeBridge()
  if (!b) return { present: false, enabled: null, rawEnabled: null, rawState: null }

  let rawState: string | null = null
  if (typeof b.getNotificationPermissionState === "function") {
    const v = await callFlexible(b.getNotificationPermissionState as never, b)
    if (v != null) rawState = typeof v === "string" ? v : String(v)
  }

  let rawEnabled: string | null = null
  let enabled: boolean | null = null
  if (typeof b.areNotificationsEnabled === "function") {
    const v = await callFlexible(b.areNotificationsEnabled as never, b)
    if (v != null) rawEnabled = typeof v === "string" ? v : String(v)
    enabled = asBool(v)
  }

  // 只有 areNotificationsEnabled 读不到时才拿 permissionState 兜底
  if (enabled === null) enabled = asBool(rawState)
  return { present: true, enabled, rawEnabled, rawState }
}

/**
 * 请求 App 的通知权限（会弹 Android 系统授权框）。
 * **必须由用户点击触发**；返回请求后的实际状态（读不到就返回 null）。
 */
export async function requestBridgePermission(): Promise<boolean | null> {
  const b = getNativeBridge()
  if (!b || typeof b.requestNotificationPermission !== "function") return null
  // 会弹 Android 系统授权框；同步/异步/回调式都可能，等它把结果给出来（最多 700ms）
  await callFlexible(b.requestNotificationPermission as never, b)
  const state = await bridgeNotifyState()
  return state.enabled
}

/** 跳到 App 的通知设置页（权限被永久拒绝时唯一的路） */
export function openBridgeNotificationSettings(): boolean {
  const b = getNativeBridge()
  if (!b || typeof b.openNotificationSettings !== "function") return false
  try {
    b.openNotificationSettings()
    return true
  } catch {
    return false
  }
}

/**
 * 通过桥接发一条通知。
 *
 * 参数形态未知，按常见两种依次试：
 *   `showWebNotification(title, body, url)`  和  `showWebNotification({title, body, url})`
 * 返回值若明确是 false 才视为失败；`undefined` / true 都当成"已交给原生"。
 *
 * ⚠️ 这里的"成功"只代表**调用没被拒**，不代表系统真的弹了 —— 所以调用方
 *    （设置页的测试按钮）必须让用户自己确认有没有看到。
 */
export async function bridgeShowNotification(
  title: string,
  body: string,
  url: string
): Promise<boolean> {
  const b = getNativeBridge()
  if (!b || typeof b.showWebNotification !== "function") return false

  const payload = JSON.stringify({ title, body, url, icon: "/favicon.png?v=2" })
  const variants: unknown[][] = [
    [title, body, url], // 三参（最常见）
    [title, body], // 两参
    [payload], // 单个 JSON 串
  ]
  for (const args of variants) {
    try {
      const r = await callFlexible(
        (...a: unknown[]) => (b.showWebNotification as (...a: unknown[]) => unknown).apply(b, a),
        null,
        args
      )
      if (asBool(r) !== false) return true
    } catch {
      // 换下一种形态
    }
  }
  return false
}

/** 兜底：App 内的 toast（通知发不出来时至少让用户看见） */
export function bridgeToast(message: string): boolean {
  const b = getNativeBridge()
  if (!b || typeof b.showToast !== "function") return false
  try {
    b.showToast(message)
    return true
  } catch {
    return false
  }
}
