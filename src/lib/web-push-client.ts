/**
 * Web Push 订阅（浏览器侧）。
 *
 * 轮询的两个死穴：后台被节流到 ~1 次/分钟、WebView 进后台直接冻结。
 * Web Push 由服务端主动推，Service Worker 被唤醒就能弹 —— 关着页面也能收。
 *
 * 这里只做三件事：拿 VAPID 公钥 → `pushManager.subscribe()` → 把订阅上报给后端。
 * 前提（缺一不可，缺了就返回 unsupported，让调用方安静地退回轮询）：
 *   1. 浏览器支持 Service Worker + PushManager；
 *   2. 已注册并激活的 SW（本站 index.html 一进页面就注册 /sw.js）；
 *   3. 通知权限已授予（没有权限的订阅在多数浏览器上会直接抛）。
 */
import { pushApi } from "@/services/api"

export type PushState = "on" | "off" | "unsupported" | "denied"

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4)
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"))
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null
  if (!("PushManager" in window)) return null
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((r) => setTimeout(() => r(null), 4000)),
    ])
  } catch {
    return null
  }
}

/** 当前是否已经订阅（用来显示状态，不发请求） */
export async function pushState(): Promise<PushState> {
  const reg = await registration()
  if (!reg) return "unsupported"
  if (!("Notification" in window)) return "unsupported"
  if (Notification.permission !== "granted") return "denied"
  try {
    const sub = await reg.pushManager.getSubscription()
    return sub ? "on" : "off"
  } catch {
    return "unsupported"
  }
}

/**
 * 订阅并上报。幂等：已订阅就直接上报一次（顺便把 userId 归属刷新成当前账号）。
 * 失败一律返回 "unsupported"/"denied"，不抛错 —— 推送失败不能影响业务。
 */
export async function ensurePushSubscription(): Promise<PushState> {
  const reg = await registration()
  if (!reg) return "unsupported"
  if (!("Notification" in window) || Notification.permission !== "granted") return "denied"

  try {
    let sub = await reg.pushManager.getSubscription()
    if (!sub) {
      const { key } = await pushApi.publicKey()
      sub = await reg.pushManager.subscribe({
        // 规范要求浏览器必须提示用户；必须有
        userVisibleOnly: true,
        // TS 的 BufferSource 与 Uint8Array<ArrayBufferLike> 对不上，这里按规范转一次
        applicationServerKey: urlBase64ToUint8Array(key) as unknown as BufferSource,
      })
    }
    const json = sub.toJSON() as {
      endpoint?: string
      keys?: { p256dh?: string; auth?: string }
    }
    if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return "unsupported"
    await pushApi.subscribe({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      ua: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 200) : "",
    })
    return "on"
  } catch (err) {
    console.error("Web Push 订阅失败:", err)
    return "unsupported"
  }
}

/** 退订（用户关闭通知时调用）；失败静默 */
export async function dropPushSubscription(): Promise<void> {
  const reg = await registration()
  if (!reg) return
  try {
    const sub = await reg.pushManager.getSubscription()
    if (!sub) return
    const endpoint = sub.endpoint
    await sub.unsubscribe().catch(() => {})
    await pushApi.unsubscribe(endpoint).catch(() => {})
  } catch {
    // 忽略
  }
}
