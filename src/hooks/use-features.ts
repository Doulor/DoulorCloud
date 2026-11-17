/**
 * 前端「功能开关」状态（2026-11-16）。
 *
 * 用途：侧边栏/页面入口按它隐藏，轮询 hook 按它停止 —— 前端不做任何额度消耗。
 *
 * 三条约定：
 *   1. **失败放行**：读不到状态时一律当「开启」。宁可让用户点进去看到 403，
 *      也不能因为一次接口抖动把整站导航清空。
 *   2. **模块级缓存**：一次会话只拉一次；管理端改完开关会派发事件刷新。
 *   3. **未登录也拉**：公开页（名片/分享箱）同样要能显示「功能已关闭」。
 */
import * as React from "react"

import { featuresApi } from "@/services/api"

type States = Record<string, boolean>

let cache: States | null = null
let inflight: Promise<States> | null = null
/** 刷新事件名：管理端保存后 dispatch，让所有已挂载的组件重新读状态 */
export const FEATURES_CHANGED_EVENT = "doulor:features-changed"

async function loadStates(force = false): Promise<States> {
  if (!force && cache) return cache
  if (!force && inflight) return inflight
  inflight = featuresApi
    .states()
    .then((r) => {
      cache = r.states ?? {}
      return cache
    })
    .catch(() => {
      // 读不到就当全开（见文件头约定 1）
      cache = cache ?? {}
      return cache
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** 管理端保存后调用：清缓存 + 通知所有挂载点 */
export function refreshFeatureStates(): void {
  cache = null
  void loadStates(true)
  try {
    window.dispatchEvent(new Event(FEATURES_CHANGED_EVENT))
  } catch {
    /* 非浏览器环境忽略 */
  }
}

export interface FeaturesState {
  states: States
  /** 是否开启；未知 id 一律 true（失败放行） */
  isOn: (id: string) => boolean
  reload: () => void
}

export function useFeatures(): FeaturesState {
  const [states, setStates] = React.useState<States>(() => cache ?? {})

  React.useEffect(() => {
    let alive = true
    const sync = () => {
      void loadStates().then((s) => {
        if (alive) setStates({ ...s })
      })
    }
    sync()
    window.addEventListener(FEATURES_CHANGED_EVENT, sync)
    return () => {
      alive = false
      window.removeEventListener(FEATURES_CHANGED_EVENT, sync)
    }
  }, [])

  const isOn = React.useCallback(
    (id: string) => states[id] !== false,
    [states]
  )
  const reload = React.useCallback(() => {
    void loadStates(true).then((s) => setStates({ ...s }))
  }, [])

  return { states, isOn, reload }
}
