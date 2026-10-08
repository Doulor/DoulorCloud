import * as React from "react"
import { cn } from "@/lib/utils"

/**
 * 滑动指示器 —— 选项卡切换的主打动效（2026-10-08 站长点名最想要的效果）。
 *
 * 用法：把它放进**容器**（TabsList / 侧边栏 <nav>）里当第一个子元素，传一个
 * 「当前选中项」的选择器。它会量出选中项的位置和大小，把一块背景滑过去 ——
 * 点别的选项时背景**滑**到新位置，而不是原地变色。
 *
 * 为什么不写在 CSS 里：滑块要跨元素移动（从 A 项滑到 B 项），必须量两个元素的
 * 几何位置，纯 CSS 做不到；React 里做受控 state 又要求所有调用方配合传值，
 * 这里选择「自观测」：MutationObserver 盯容器的属性/子树变化，谁 active 了
 * 就自己滑过去 —— 调用方零改造，挂上就生效。
 *
 * 「关 = 现状」的保证：
 *   · .motion-pill 的 display:none，**只在 html.motion-on 下 display:block**
 *     （index.css）—— 开关关掉时滑块根本不渲染出来；
 *   · 同时 CSS 会在 motion-on 下摘掉选项自己原本的 active 背景
 *     （`[role="tab"][data-state="active"]` 与 `[data-nav-active="1"]` 两条规则），
 *     滑块是唯一高亮；开关一关、这些规则全部失配，选项自己原来的高亮顶回来。
 *
 * 细节：
 *   · useLayoutEffect 里第一次摆放，赶在绘制前，避免滑块从 (0,0) 闪一下再滑到位；
 *   · 盯两类变化：容器内（data-state / data-nav-active / 子树增删）和
 *     <html> 的类（动效开关刚打开时也要重摆一次）；
 *   · 窗口缩放与字体加载完成后重摆（选项宽度会变）；
 *   · 父容器若不是 relative 会顺手补上（指示器 absolute 以它为基准）。
 */
export function SlidingPill({
  activeSelector,
  className,
}: {
  /** 容器内「当前选中项」的选择器，如 '[role="tab"][data-state="active"]' */
  activeSelector: string
  /** 滑块自己的外观（颜色 / 圆角 / 阴影），随使用场景配 */
  className?: string
}) {
  const ref = React.useRef<HTMLSpanElement>(null)

  React.useLayoutEffect(() => {
    const el = ref.current
    const parent = el?.parentElement
    if (!el || !parent) return
    const parentStyle = getComputedStyle(parent)
    if (parentStyle.position === "static") {
      parent.style.position = "relative"
    }
    /*
     * ⚠️ 必须让容器自成层叠上下文（isolation: isolate），滑块才敢用 z-index: -1。
     *
     * 为什么：绝对定位元素默认画在**静态文字之上**——不加处理时这块背景会把
     * 选项卡的字盖住（2026-10-08 站长反馈「切换会把选项卡上面的文字挡住」）。
     * 而负 z-index 的绘制次序是「容器背景 → **它** → 所有流内内容（含文字）」，
     * 正好是我们要的：盖住容器底色、又压在文字下面。
     * 但负 z-index 只有在**同一个层叠上下文**里才排在这个位置；容器不隔离时，
     * 它会跑到更外层去、被容器自己的背景盖掉（滑块直接看不见）。
     */
    if (parentStyle.isolation !== "isolate") {
      parent.style.isolation = "isolate"
    }

    const place = () => {
      const active = parent.querySelector(activeSelector) as HTMLElement | null
      if (!active) {
        el.style.opacity = "0"
        return
      }
      el.style.opacity = "1"
      el.style.width = `${active.offsetWidth}px`
      el.style.height = `${active.offsetHeight}px`
      // 用 transform 滑（left/top 不参与过渡），量出来的是布局位置 ——
      // 容器自身滚动（管理后台侧边栏 overflow-y-auto）不影响布局位置
      el.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`
    }

    place()
    const mo = new MutationObserver(place)
    mo.observe(parent, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-state", "data-nav-active"],
    })
    const rootMo = new MutationObserver(place)
    rootMo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    })
    const onResize = () => place()
    window.addEventListener("resize", onResize)
    // 字体加载完宽度会变（尤其自托管字体），摆一次
    if (typeof document.fonts?.ready?.then === "function") {
      document.fonts.ready.then(place).catch(() => {})
    }
    return () => {
      mo.disconnect()
      rootMo.disconnect()
      window.removeEventListener("resize", onResize)
    }
  }, [activeSelector])

  return <span ref={ref} aria-hidden="true" className={cn("motion-pill", className)} />
}
