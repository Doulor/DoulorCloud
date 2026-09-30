import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * 数据就绪时的「骨架 → 内容」交叉淡化。
 *
 * 直接写 `{loading ? <Skeleton/> : <内容/>}` 的话，数据回来那一帧骨架被卸载、
 * 内容整块出现 —— 视觉上是「啪」地跳一下。这里让两者短暂重叠：
 * 骨架淡出的同时内容淡入，交接处是连续的。
 *
 * 叠放靠 CSS grid（`.data-fade > * { grid-area: 1/1 }`），
 * 于是容器高度自动取「骨架与内容中较高的那个」，
 * 不需要写死高度、也不需要用 absolute 定位 —— 避免布局跳动。
 *
 * ⚠️ 只适合包「成块的内容」；卡片里那种一行高的小骨架（如徽章数字）直接给它加
 *    `page-enter` 之类的淡入即可，套这层反而会让行内元素变块级。
 */
export function DataFade({
  loading,
  skeleton,
  children,
  className,
}: {
  loading: boolean
  skeleton: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  const [showSkeleton, setShowSkeleton] = React.useState(loading)
  const [leaving, setLeaving] = React.useState(false)
  const [showContent, setShowContent] = React.useState(!loading)

  React.useEffect(() => {
    if (loading) {
      setShowSkeleton(true)
      setLeaving(false)
      setShowContent(false)
      return
    }
    // 数据到了：内容立刻开始淡入，骨架同时开始淡出
    setShowContent(true)
    setLeaving(true)
    // 淡出动画（约 0.34s）跑完后再把骨架从 DOM 摘掉，摘早了就没有淡出可看
    const timer = window.setTimeout(() => {
      setShowSkeleton(false)
      setLeaving(false)
    }, 380)
    return () => window.clearTimeout(timer)
  }, [loading])

  return (
    <div className={cn("data-fade", className)}>
      {showSkeleton && (
        <div className={cn("data-fade-item", leaving && "data-fade-out")}>{skeleton}</div>
      )}
      {showContent && <div className="data-fade-item data-fade-in">{children}</div>}
    </div>
  )
}
