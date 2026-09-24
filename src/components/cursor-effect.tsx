import * as React from "react"

/**
 * 鼠标跟随光标高亮（**仅暗色主题生效**）。
 *
 * 设计取向：**不改变页面整体亮度**。整屏铺一层跟随光标的径向渐变，只在光标
 * 周围叠加一层极淡的 `--foreground`——暗色主题下 foreground 近白，光标处被
 * 微微提亮，像一盏跟手的台灯。页面其余部分的明暗完全不动。
 *
 * 浅色模式不挂载（用户明确要求）：亮色下这层是"暗晕"，作用与"提亮"相反，且
 * 浅色页面本身亮度高，叠加只会显得脏。CSS 侧另有一道兜底（见 index.css），
 * 这里不挂载是为了连 rAF 循环一起省掉。
 *
 * 实现要点：
 *   - 不用 mix-blend-mode：直接叠加主题感知的半透明渐变，视觉等价但少一层合成开销，
 *     也不会被祖先的 isolation / transform 破坏；
 *   - pointermove 只记录目标坐标，位移在 rAF 里做阻尼插值，避免每个事件都写样式；
 *   - 位移不足 0.5px 跳过写 DOM，鼠标静止时零渲染开销；
 *   - 指针移出窗口时淡出，避免光晕滞留在边缘；
 *   - 触屏设备（无 hover 能力）不渲染；
 *   - 尊重 prefers-reduced-motion：静态跟随，不做插值动画。
 *
 * 半径与浓度是 CSS 变量（见 index.css 的 .cursor-glow），调样式不必改本文件。
 */

/** 阻尼系数：越小越"重"、跟随越滞后。 */
const DAMPING = 0.16

/** 只在具备精确指针（鼠标）的设备上启用。 */
function useHasFinePointer(): boolean {
  const [fine, setFine] = React.useState(false)
  React.useEffect(() => {
    const mq = window.matchMedia("(hover: hover) and (pointer: fine)")
    setFine(mq.matches)
    const onChange = () => setFine(mq.matches)
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [])
  return fine
}

/**
 * 当前是否处于暗色主题。
 *
 * 直接观测 `<html>` 上的 `dark` 类，而不是读 useTheme 的状态或 localStorage：
 *   - `dark` 类才是真正生效的主题（use-theme.ts 的 applyTheme 负责切换，
 *     且 "system" 模式下会跟随系统变化重新求值）；
 *   - 组件挂在 App 根部，useTheme 是各页面自己调用的 hook，这里拿不到同一个实例。
 * MutationObserver 能同时覆盖「用户点切换按钮」和「系统主题变化」两条路径。
 */
function useIsDark(): boolean {
  const [dark, setDark] = React.useState(false)
  React.useEffect(() => {
    const root = document.documentElement
    const sync = () => setDark(root.classList.contains("dark"))
    sync()
    const mo = new MutationObserver(sync)
    mo.observe(root, { attributes: true, attributeFilter: ["class"] })
    return () => mo.disconnect()
  }, [])
  return dark
}

/** 系统是否要求减少动效。 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false)
  React.useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)")
    setReduced(mq.matches)
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [])
  return reduced
}

export function CursorGlow() {
  const fine = useHasFinePointer()
  const dark = useIsDark()
  const reduced = usePrefersReducedMotion()
  const layerRef = React.useRef<HTMLDivElement>(null)

  const active = fine && dark

  React.useEffect(() => {
    if (!active) return

    // target：指针真实位置；pos：当前渲染位置（逐帧插值逼近 target）
    const target = { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    const pos = { ...target }
    // 上一次真正写进 DOM 的坐标。初值必须用 ±Infinity 而不是 NaN：
    // Math.abs(x - NaN) 得到 NaN，而 NaN > 0.5 恒为 false，会导致第一帧就被判定
    // "没移动过"、CSS 变量永远写不进去（光晕卡在屏幕中央）。
    const written = { x: Infinity, y: Infinity }
    let visible = false
    let seeded = false
    let raf = 0

    const onMove = (e: PointerEvent) => {
      target.x = e.clientX
      target.y = e.clientY
      // 首次移动直接吸附，避免从屏幕中央"飞"过来
      if (!seeded) {
        pos.x = target.x
        pos.y = target.y
        seeded = true
      }
      visible = true
    }
    const onLeave = () => {
      visible = false
    }

    const render = () => {
      if (reduced) {
        pos.x = target.x
        pos.y = target.y
      } else {
        pos.x += (target.x - pos.x) * DAMPING
        pos.y += (target.y - pos.y) * DAMPING
      }

      const layer = layerRef.current
      if (layer) {
        // 只在位移足够明显时写坐标
        if (
          Math.abs(pos.x - written.x) > 0.5 ||
          Math.abs(pos.y - written.y) > 0.5
        ) {
          written.x = pos.x
          written.y = pos.y
          layer.style.setProperty("--cursor-x", `${pos.x}px`)
          layer.style.setProperty("--cursor-y", `${pos.y}px`)
        }
        // 指针离开窗口时淡出，回来后重新淡入
        // （走 data-visible 而不是内联 opacity：内联会覆盖 CSS 里的 --glow-alpha）
        const want = visible ? "1" : "0"
        if (layer.dataset.visible !== want) layer.dataset.visible = want
      }

      raf = requestAnimationFrame(render)
    }

    window.addEventListener("pointermove", onMove, { passive: true })
    document.addEventListener("pointerleave", onLeave)
    document.addEventListener("pointerenter", onMove)
    raf = requestAnimationFrame(render)
    return () => {
      window.removeEventListener("pointermove", onMove)
      document.removeEventListener("pointerleave", onLeave)
      document.removeEventListener("pointerenter", onMove)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [active, reduced])

  if (!active) return null

  return (
    <div
      ref={layerRef}
      aria-hidden="true"
      className="cursor-glow z-[45]"
    />
  )
}
