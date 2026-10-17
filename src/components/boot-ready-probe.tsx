import * as React from "react"

import { useAuth } from "@/hooks/use-auth"
import { signalBootReady } from "@/lib/boot-signal"

/**
 * 开屏动画的「就绪探针」—— 决定什么时候让开屏收尾。
 *
 * 判据不是「认证请求回来了」这么简单：`useAuth().loading` 变 false 只说明
 * 用户态确定了，**当前路由的代码块可能还在路上**（全站页面都是 `React.lazy`）。
 * 这时候揭开开屏，用户看到的就是一个转圈的骨架 —— 正是站长不要的
 * 「已进入界面就要是完全加载好的状态」。
 *
 * 所以这里盯两件事：
 *
 * ① **有没有 Suspense 兜底在场**（`[data-boot-pending]`）。
 *    这条是必须的：兜底本身是**静态 DOM**（转圈只是 CSS 动画，不产生 DOM 变化），
 *    光看「DOM 静下来了」会把转圈误判成「渲染完了」——
 *    线上就出现过「云画完进去了、却是一个空白页 + 转圈」（2026-10-17 反馈）。
 *    只要这个标记还在，就绝不报就绪，并且给更长的耐心（`PENDING_MAX_WAIT_MS`）：
 *    这时候是**确知**还在加载，等着才是对的。
 *
 * ② **DOM 静下来了没有**。
 *    没有兜底标记时，用「#root 连续若干帧没有变化」作为「首屏渲染完」的近似 ——
 *    它同时覆盖了懒加载块渲染、首屏接口数据回来、骨架换成真内容这些情况。
 *    用上限 `MAX_WAIT_MS` 兜底：宁可按时收尾，也不能因为某页一直有动态内容
 *    （定时器 / 动画）把开屏卡死在屏幕上。
 *
 * 判定通过后再等一帧，让刚算出来的这一帧**真正画到屏幕上**，才通知开屏。
 */
const PENDING_SELECTOR = '[data-boot-pending="1"]'
const QUIET_MS = 60 // DOM 连续静止这么久才算渲染完
const QUIET_FRAMES = 2 // 连续几帧达到上面的静止时间
const MAX_WAIT_MS = 3000 // 认证就绪后最多再等这么久（常态）
const PENDING_MAX_WAIT_MS = 8000 // 还在等懒加载代码块时给更多耐心

export function BootReadyProbe() {
  const { loading } = useAuth()

  React.useEffect(() => {
    if (loading) return

    const root = document.getElementById("root")
    if (!root) {
      // 正常不会发生（root 一定在）；真发生了也别把开屏永远留在屏幕上
      signalBootReady()
      return
    }

    let cancelled = false
    let raf = 0
    let quietFrames = 0
    let lastChangeAt = performance.now()
    const startedAt = performance.now()

    const observer = new MutationObserver(() => {
      lastChangeAt = performance.now()
      quietFrames = 0
    })
    observer.observe(root, { childList: true, subtree: true, characterData: true })

    const step = () => {
      if (cancelled) return
      const now = performance.now()
      const pending = root.querySelector(PENDING_SELECTOR)
      const hasContent = root.childElementCount > 0

      if (pending) {
        // 确知还在加载：绝不判就绪，顺便把静止基准一直往后推，
        // 免得兜底一消失就立刻用房「刚才是静止的」这个过期判断。
        quietFrames = 0
        lastChangeAt = now
      } else if (hasContent && now - lastChangeAt >= QUIET_MS) {
        quietFrames++
      } else {
        quietFrames = 0
      }

      const deadline = pending ? PENDING_MAX_WAIT_MS : MAX_WAIT_MS
      if (quietFrames >= QUIET_FRAMES || now - startedAt >= deadline) {
        observer.disconnect()
        // 再等一帧：确保刚刚算出来的这一帧已经**画到屏幕上**。
        // 不这么做的话，开屏会在内容真正上屏之前就开始淡出，露出一瞬间的空白。
        raf = requestAnimationFrame(() => {
          if (!cancelled) signalBootReady()
        })
        return
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)

    return () => {
      cancelled = true
      if (raf) cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [loading])

  return null
}
