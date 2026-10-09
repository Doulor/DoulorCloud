/**
 * 「agent 正在跑」的跨挂载状态（2026-10-09 站长反馈）。
 *
 * 背景：切到别的侧边栏板块时，实验室页面会**卸载**，但那一轮循环并不会停
 * （循环靠 refs 活着，见 lab.tsx 里 send() 的注释）。问题在于
 * `streaming` / `live` / 思考中的文案**都是组件 state** —— 卸载即丢失，
 * 回来重新挂载时 `streaming` 是 false，于是：
 *   · 思考动画（ThoughtLine / 「思考中…」）整个消失；
 *   · 界面上看不出还在干活，用户自然以为「中断了」。
 *
 * 所以把三样东西放到 React 之外的模块单例里：
 *   · `running` —— 还在跑吗（决定思考动画显不显示）；
 *   · `label` / `steps` —— 跑到哪一步了（循环里的回调会持续更新，**卸载后照样更新**）；
 *   · `abort` —— 中断手柄，回到实验室后「停止」按钮还能按得动。
 *
 * ⚠️ 这是「同一个标签页内的临时运行态」，不是持久化数据：
 *    刷新页面会重新加载模块，单例归零 —— 这是对的，刷新本来就等于放弃这一轮。
 */
import * as React from "react"

export interface LabRunState {
  /** 有循环正在跑 */
  running: boolean
  /** 主文案（目前恒定是「思考中…」） */
  label: string
  /** 正在做的事，一条一条往下走 —— 思考动画里显示的那部分 */
  steps: string[]
  /** 中断这一轮用的手柄；回到页面后「停止」按钮靠它 */
  abort: AbortController | null
  /** 这一轮**真正开始**的时刻（epoch 毫秒）。切走再回来时计时接着走，不归零 */
  startedAt: number
}

const EMPTY: LabRunState = { running: false, label: "", steps: [], abort: null, startedAt: 0 }

let state: LabRunState = EMPTY
const listeners = new Set<() => void>()

export function getLabRun(): LabRunState {
  return state
}

/** 打补丁式更新（只传要改的字段），并通知订阅者 */
export function setLabRun(patch: Partial<LabRunState>): void {
  const next = { ...state, ...patch }
  // 完全没变就别通知，免得每来一个 delta 都触发一轮重渲染
  if (
    next.running === state.running &&
    next.label === state.label &&
    next.abort === state.abort &&
    next.startedAt === state.startedAt &&
    next.steps.length === state.steps.length &&
    next.steps.every((s, i) => s === state.steps[i])
  ) {
    return
  }
  state = next
  listeners.forEach((fn) => fn())
}

/** 一轮彻底结束（正常收尾 / 出错 / 被停）时清干净 */
export function clearLabRun(): void {
  setLabRun({ running: false, label: "", steps: [], abort: null, startedAt: 0 })
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** React 侧订阅。用 useSyncExternalStore：卸载后回来能立刻拿到最新值 */
export function useLabRun(): LabRunState {
  return React.useSyncExternalStore(subscribe, getLabRun, () => EMPTY)
}
