import * as React from "react"
import { ArrowUp } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * 回到顶部按钮：固定右下角。
 * - 滚动高度超过阈值（300px）时淡入显示，否则隐藏
 * - 按钮上用 SVG 圆环显示已浏览高度进度（0% → 100%）
 * - 点击平滑滚动回顶部
 *
 * 监听 window scroll，用 requestAnimationFrame 节流避免卡顿。
 * 阈值用「已滚动距离 / (文档高度 - 视口高度)」算进度。
 */
export function ScrollToTop() {
  const [progress, setProgress] = React.useState(0)
  const [visible, setVisible] = React.useState(false)

  React.useEffect(() => {
    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const scrollTop = window.scrollY
        const max = document.documentElement.scrollHeight - window.innerHeight
        // max 可能为 0（页面短于视口），此时进度 0、不显示
        const p = max > 0 ? Math.min(scrollTop / max, 1) : 0
        setProgress(p)
        setVisible(scrollTop > 300)
      })
    }
    window.addEventListener("scroll", onScroll, { passive: true })
    window.addEventListener("resize", onScroll)
    onScroll()
    return () => {
      window.removeEventListener("scroll", onScroll)
      window.removeEventListener("resize", onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  // 圆环参数：半径 18，周长 = 2πr ≈ 113
  const R = 18
  const C = 2 * Math.PI * R
  const offset = C * (1 - progress)

  return (
    <button
      type="button"
      aria-label="回到顶部"
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      className={cn(
        "fixed bottom-6 right-6 z-40 flex h-11 w-11 items-center justify-center rounded-full border border-border bg-card/80 shadow-lg backdrop-blur transition-all hover:bg-accent",
        visible ? "opacity-100 scale-100" : "pointer-events-none opacity-0 scale-90"
      )}
    >
      {/* 进度圆环：SVG 旋转 -90deg 使起点在顶部 */}
      <svg className="absolute inset-0 h-full w-full -rotate-90" viewBox="0 0 44 44">
        <circle
          cx="22"
          cy="22"
          r={R}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-muted-foreground/25"
        />
        <circle
          cx="22"
          cy="22"
          r={R}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={offset}
          className="text-primary transition-[stroke-dashoffset] duration-150 ease-out"
        />
      </svg>
      <ArrowUp className="h-4 w-4 text-foreground" />
    </button>
  )
}
