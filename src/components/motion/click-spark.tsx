import * as React from "react"
import { MOTION_CLASS, SPARK_CLASS } from "@/hooks/use-motion-pref"

/**
 * 全站点击粒子 —— 动效层里**唯一默认关闭**的效果（2026-10-08 站长要求：
 * 其他动效默认开、点击动效默认关，喜欢的人在个人设置里自己打开）。
 *
 * 灵感来自 React Bits 的 ClickSpark（reactbits.dev）。那里是一个**包装组件**
 * （谁要粒子谁包一层），这里改成**全局版**：挂在 App 根部一次，
 * 任何位置的按下都会在指针处炸开几粒灰阶短线。
 *
 * 启停要**两个类同时在 <html> 上**才工作（都用 MutationObserver 观察，
 * 与 cursor-effect.tsx 侦测暗色主题是同一手法）：
 *   · motion-on   —— 动效总闸（个人设置「界面动效」）
 *   · motion-spark —— 点击粒子自己的偏好（默认关）
 * 关掉任何一个，监听摘掉、一粒不出。
 *
 * 实现取向（性能与观感）：
 *   · 粒子是临时 <span>（pointer-events:none），用 Web Animations API 播，
 *     播完自删 + 兜底 setTimeout 双保险，不常驻 DOM、不起 rAF 循环；
 *     鼠标不动、不点击时零开销。
 *   · 颜色用 var(--foreground)，明暗主题自动适配；纯灰阶，不带彩色
 *     —— 与站点黑白灰极简的既定视觉一致。
 *   · 只认主键（左键 / 触摸），右键与中键不炸。
 *   · 缓动用动效层统一缓动 cubic-bezier(.22,1,.36,1)。
 */

/** 动效层统一缓动（与 index.css 动效层一节的约定同款，改要两边一起改） */
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)"

/** 当前点击粒子是否工作：总闸 + 粒子偏好，两个类同时在才算开 */
function useSparkEnabled(): boolean {
  const both = () =>
    typeof document !== "undefined" &&
    document.documentElement.classList.contains(MOTION_CLASS) &&
    document.documentElement.classList.contains(SPARK_CLASS)
  const [on, setOn] = React.useState(both)
  React.useEffect(() => {
    const root = document.documentElement
    const sync = () => setOn(both())
    sync()
    const mo = new MutationObserver(sync)
    mo.observe(root, { attributes: true, attributeFilter: ["class"] })
    return () => mo.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return on
}

/** 在 (x, y) 处炸开一圈短线粒子（clientX / clientY 坐标系，粒子 fixed 定位） */
function spawnSparks(x: number, y: number) {
  const COUNT = 7
  for (let i = 0; i < COUNT; i++) {
    const s = document.createElement("span")
    s.setAttribute("aria-hidden", "true")
    const angle = Math.random() * Math.PI * 2
    const dist = 10 + Math.random() * 22
    const deg = (angle * 180) / Math.PI
    const dx = Math.cos(angle) * dist
    const dy = Math.sin(angle) * dist
    s.style.cssText =
      `position:fixed;left:0;top:0;width:9px;height:1.5px;border-radius:1px;` +
      `background:var(--foreground);opacity:0.65;pointer-events:none;` +
      `z-index:2147483000;transform:translate(${x - 4.5}px,${y - 0.75}px) rotate(${deg}deg)`
    document.body.appendChild(s)
    const anim = s.animate(
      [
        { transform: `translate(${x - 4.5}px,${y - 0.75}px) rotate(${deg}deg)`, opacity: 0.65 },
        { transform: `translate(${x - 4.5 + dx}px,${y - 0.75 + dy}px) rotate(${deg}deg)`, opacity: 0 },
      ],
      { duration: 380 + Math.random() * 220, easing: EASE }
    )
    anim.onfinish = () => s.remove()
    anim.oncancel = () => s.remove()
    // 兜底：标签页切到后台时 WAAPI 会暂停，onfinish 可能迟迟不来
    setTimeout(() => s.remove(), 1400)
  }
}

/** 挂 App 根部一次即可；不渲染任何东西，只负责在开启时接管全局按下事件 */
export function ClickSpark() {
  const on = useSparkEnabled()
  React.useEffect(() => {
    if (!on) return
    const handler = (e: PointerEvent) => {
      if (e.button !== 0) return
      spawnSparks(e.clientX, e.clientY)
    }
    document.addEventListener("pointerdown", handler)
    return () => document.removeEventListener("pointerdown", handler)
  }, [on])
  return null
}
