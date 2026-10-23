/**
 * 公共聊天室的「免打扰」偏好（2026-10-24）。
 *
 * 站长要求：聊天页右上角在线人数旁边加一个免打扰按钮，开启后**不产生角标**。
 *
 * 为什么存 localStorage 而不是数据库：
 *   · 这是纯客户端的展示偏好（"我不想看到红点"），不影响任何业务数据；
 *   · 存本地可以立即生效、不需要迁移和接口，也不占 D1 的行。
 * 换设备/清缓存会丢 —— 对这个量级的偏好可以接受。
 */
import * as React from "react"
import { chatDndApi } from "@/services/api"

const KEY = "chat_dnd"
const EVENT = "chat-dnd-change"

/** 只写本地缓存、不广播事件（用于服务端校准后的回填） */
function setChatDndSilently(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, "1")
    else localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}

export function isChatDnd(): boolean {
  try {
    return localStorage.getItem(KEY) === "1"
  } catch {
    return false
  }
}

export function setChatDnd(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, "1")
    else localStorage.removeItem(KEY)
  } catch {
    /* 隐私模式下 localStorage 可能不可用，忽略即可 */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: on }))
}

/** 订阅免打扰状态（同一页面内即时同步，跨标签页靠 storage 事件） */
export function useChatDnd(): [boolean, (on: boolean) => void] {
  const [dnd, setDnd] = React.useState<boolean>(() => isChatDnd())

  React.useEffect(() => {
    // 先按本地缓存渲染（避免闪烁），再向服务端校准一次
    void chatDndApi
      .get()
      .then((r) => {
        setDnd(r.dnd)
        setChatDndSilently(r.dnd)
      })
      .catch(() => {})

    const sync = () => setDnd(isChatDnd())
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) sync()
    }
    window.addEventListener(EVENT, sync)
    window.addEventListener("storage", onStorage)
    return () => {
      window.removeEventListener(EVENT, sync)
      window.removeEventListener("storage", onStorage)
    }
  }, [])

  const toggle = React.useCallback((on: boolean) => {
    setChatDnd(on)
    setDnd(on)
    // 落库：跨设备生效（失败就只保留本地偏好，不影响当前会话）
    void chatDndApi.set(on).catch(() => {})
  }, [])

  return [dnd, toggle]
}
