import * as React from "react"

/**
 * 页面级滚动位置记忆（返回列表页时回到原来的位置）。
 *
 * 为什么需要：SPA 路由切换时 React 卸载旧页面、渲染新页面，浏览器会把
 * window 滚动按新文档高度重新钳制（目标页更矮就直接归 0）。等用户切回来，
 * 位置已经丢了 —— 商城这种长列表「翻到第 3 屏 → 去看别的 → 回来又回到顶部」，
 * 只能重新滚。
 *
 * 用法：在页面组件里 `useScrollRestore("points")`。key 要稳定且互不冲突。
 *
 * 行为约定：
 *   · 首次进入（本会话没有记录）→ 不干涉，停在顶部；
 *   · 再次进入 → 恢复上次位置；内容还没撑开时按帧重试（最多 ~1s），
 *     避免「数据到了但文档还不够高」导致恢复被钳成 0；
 *   · 只记 window 滚动（本站布局是整页滚动，不是内部容器滚动）；
 *   · 记录存 sessionStorage：跨标签页不串，关掉标签页就清。
 *
 * 与「回到顶部」按钮不冲突：用户手动点了回到顶部，位置就会被记成 0。
 */
export function useScrollRestore(key: string): void {
  const storageKey = `doulor:scroll:${key}`
  // 用 ref 记住最后一次有效的滚动位置：切走时浏览器可能先把 scrollY 钳成 0，
  // 若直接读 window.scrollY 会存下 0，所以只在「页面还活着」时持续更新。
  const lastY = React.useRef(0)

  React.useEffect(() => {
    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const y = window.scrollY
        // 记录所有位置（包括 0）：用户主动滚回顶部也要被记住
        lastY.current = y
        try {
          sessionStorage.setItem(storageKey, String(y))
        } catch {
          // 隐私模式：忽略，退化成不记忆
        }
      })
    }
    window.addEventListener("scroll", onScroll, { passive: true })

    return () => {
      window.removeEventListener("scroll", onScroll)
      if (raf) cancelAnimationFrame(raf)
      try {
        sessionStorage.setItem(storageKey, String(lastY.current))
      } catch {
        // 忽略
      }
    }
  }, [storageKey])

  // 恢复：挂载后按帧重试，直到文档足够高或超时。
  // 依赖为空（只在首次挂载恢复）：页面内筛选/翻页不该把用户拽回刷新前的位置。
  React.useEffect(() => {
    let saved = 0
    try {
      saved = Number(sessionStorage.getItem(storageKey) ?? 0) || 0
    } catch {
      saved = 0
    }
    if (saved <= 0) return

    let frames = 0
    let raf = 0
    const tryRestore = () => {
      const maxY = document.documentElement.scrollHeight - window.innerHeight
      if (maxY >= saved) {
        window.scrollTo(0, saved)
        // 恢复一次即可；内容随后可能再变化（图片/数据到位），但位置已确定
        return
      }
      // 文档还不够高（数据/图片还没撑开）：下一帧再试；最多 60 帧（约 1s）
      if (++frames < 60) raf = requestAnimationFrame(tryRestore)
    }
    raf = requestAnimationFrame(tryRestore)
    return () => {
      if (raf) cancelAnimationFrame(raf)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
