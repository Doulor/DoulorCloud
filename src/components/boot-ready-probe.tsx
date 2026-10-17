import * as React from "react"

import { useAuth } from "@/hooks/use-auth"
import { signalBootReady } from "@/lib/boot-signal"

/**
 * 开屏动画的「就绪探针」—— 决定什么时候让开屏收尾。
 *
 * 判据不是「认证请求回来了」这么简单：`useAuth().loading` 变 false 只说明
 * 用户态确定了，**当前路由的代码块可能还在路上**（全站页面都是 `React.lazy`），
 * 这时候揭开开屏，用户看到的就是半成品或者一个转圈的骨架 —— 正是站长明确不要的
 * 「已进入界面就要是完全加载好的状态」。
 *
 * 所以这里盯的是 **DOM 有没有静下来**：
 *   · 认证就绪后开始观察 #root；
 *   · 只要还有变化（懒加载块渲染、首屏数据回来、骨架换成真内容…）就一直接着等；
 *   · 连续若干帧没有变化 ⇒ 首屏已经渲染完 ⇒ 再等一帧让它真正画到屏幕上，然后报就绪。
 *
 * 为什么用「静下来」而不是「找出当前路由的 chunk 什么时候 resolve」：
 *   路由是 React.lazy + Suspense 驱动的，chunk 解析那一刻并没有全局事件可听；
 *   而且首屏往往还要再等一次接口数据。盯 DOM 是把这两件事一起覆盖掉，
 *   成本又只有几个 MutationObserver 回调。
 *
 * 兜底：最多等 `MAX_WAIT_MS` 就先放行 —— 宁可让开屏按时收尾，
 * 也不能因为某个页面一直有动态内容（定时器 / 动画）把开屏卡死在屏幕上。
 */
const QUIET_MS = 60 // DOM 连续静止这么久才算渲染完
const QUIET_FRAMES = 2 // 连续几帧达到上面的静止时间
const MAX_WAIT_MS = 3000 // 认证就绪后最多再等这么久

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
      const hasContent = root.childElementCount > 0
      if (hasContent && now - lastChangeAt >= QUIET_MS) quietFrames++
      else quietFrames = 0

      if (quietFrames >= QUIET_FRAMES || now - startedAt >= MAX_WAIT_MS) {
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
