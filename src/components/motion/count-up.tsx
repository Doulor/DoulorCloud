import * as React from "react"
import { MOTION_CLASS } from "@/hooks/use-motion-pref"
import { cn } from "@/lib/utils"

/**
 * 数字滚动（动效层，2026-10-08）：数值变化时从旧值滚到新值。
 *
 * 「关 = 现状」：motion-on 不在就直接显示终值（数字必须随时可读，这是数据，
 * 不能为了动画牺牲可读性）。首次挂载从 0 滚到目标值；之后数据刷新从旧值滚过去。
 *
 * tabular-nums 让数字等宽 —— 滚动过程中宽度不抖。
 * 时长随差值自适应：差 3 没必要滚 900ms。
 */
export function CountUp({
  value,
  className,
}: {
  value: number
  className?: string
}) {
  const ref = React.useRef<HTMLSpanElement>(null)
  const prev = React.useRef(0)

  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const from = prev.current
    const to = Number.isFinite(value) ? value : 0
    prev.current = to

    if (
      from === to ||
      !document.documentElement.classList.contains(MOTION_CLASS)
    ) {
      el.textContent = String(to)
      return
    }

    const start = performance.now()
    const dur = Math.min(900, 300 + Math.abs(to - from) * 40)
    let raf = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur)
      const eased = 1 - Math.pow(1 - t, 3)
      el.textContent = String(Math.round(from + (to - from) * eased))
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value])

  return (
    <span ref={ref} className={cn("tabular-nums", className)}>
      {value}
    </span>
  )
}
