/**
 * 锚定浮层：贴着触发按钮弹出，但**渲染到 document.body**（Portal）。
 *
 * ── 为什么必须用 Portal ──
 * 社区/私信的输入框都嵌在卡片里，而那些卡片带 `overflow-hidden`（圆角裁切需要）。
 * 普通的 `absolute top-full` 面板会被卡片裁掉下半截，表现就是
 * 「表情面板一打开就被截断，下面的内容看不到」（2026-10-02 站长反馈）。
 * 渲染到 body 就彻底绕开裁剪，无论嵌在多深的容器里都能完整显示。
 *
 * ── 定位规则 ──
 * · 优先**向下**弹：避开用户正在编辑的输入区；
 * · 下方空间不够（或比上方还小）就**向上**弹；
 * · 右侧越界时往左推，保证整块都在视口内。
 *
 * ⚠️ 面板是 `fixed` 定位、不跟随锚点，所以**滚动或缩放时直接关闭** ——
 * 比跟着锚点跑更省事，也不会出现「面板飘在原地、按钮已经滚走了」的错位。
 */
import * as React from "react"
import { createPortal } from "react-dom"

interface AnchoredPanelProps {
  anchorRef: React.RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
  /** 面板尺寸（用于判断向下还是向上弹，也是实际渲染尺寸） */
  width?: number
  height?: number
  children: React.ReactNode
}

export function AnchoredPanel({
  anchorRef,
  open,
  onClose,
  width = 288,
  height = 256,
  children,
}: AnchoredPanelProps) {
  const [pos, setPos] = React.useState<{ top: number; left: number } | null>(null)

  React.useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const el = anchorRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const gap = 8
    const below = window.innerHeight - r.bottom - gap
    const above = r.top - gap

    let top: number
    if (below >= height) {
      // 下方放得下 → 向下弹（避开用户正在编辑的输入区）
      top = r.bottom + gap
    } else if (above >= height) {
      // 下方放不下、上方放得下 → 向上弹
      top = r.top - height - gap
    } else {
      /**
       * 两边都放不下（小视口、或输入框贴着屏幕底部）。
       *
       * ⚠️ 这里是原来的 bug：老逻辑写成「下方空间比上方大就往下弹」，
       * 于是「下方放不下但比上方宽裕」时会向下弹，面板底部直接跑出视口 ——
       * 表现就是「表情面板打开了却看不见，得手动往下滚一下」
       * （2026-10-02 站长反馈）。
       * 现在改成：选空间更大的一侧，并且**强制把面板顶回视口内**。
       */
      top = below >= above ? window.innerHeight - gap - height : gap
    }

    // 兜底夹逼：无论走哪个分支，面板都必须完整落在视口里。
    // 宁可盖住触发按钮，也不能跑到屏幕外让用户看不见。
    const maxTop = Math.max(gap, window.innerHeight - gap - height)
    top = Math.max(gap, Math.min(top, maxTop))

    const left = Math.min(r.left, window.innerWidth - width - gap)
    setPos({ top, left: Math.max(gap, left) })
  }, [open, anchorRef, width, height])

  React.useEffect(() => {
    if (!open) return
    const close = (e: Event) => {
      // 面板内部自己的滚动**不**关闭 —— 否则表情/表情包列表根本滚不动。
      //
      // scroll 事件不冒泡，但这里用 capture 监听 window 能抓到；
      // 抓到时的 `e.target` 就是**实际滚动的那个元素**。只要它在面板里，
      // 就是列表在滚，不该当成「页面滚走了」而收面板。
      const t = e.target
      if (t instanceof Element && t.closest("[data-anchored-panel]")) return
      onClose()
    }
    // capture 阶段监听：卡片内部的滚动容器也能捕获到
    window.addEventListener("scroll", close, true)
    window.addEventListener("resize", close)
    return () => {
      window.removeEventListener("scroll", close, true)
      window.removeEventListener("resize", close)
    }
  }, [open, onClose])

  if (!open || !pos) return null

  return createPortal(
    <div
      // 供「点击外部关闭」判断：面板在 body 里，不在锚点的 ref 容器内，
      // 没有这个标记的话点面板自身会被当成「点了外部」而立刻关掉
      data-anchored-panel=""
      style={{ position: "fixed", top: pos.top, left: pos.left, width, height }}
      className="z-50 flex flex-col rounded-xl border bg-popover p-2 shadow-lg"
    >
      {children}
    </div>,
    document.body
  )
}

/** 判断点击是否落在浮层内（配合「点击外部关闭」用） */
export function isInsideAnchoredPanel(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest("[data-anchored-panel]")
}
