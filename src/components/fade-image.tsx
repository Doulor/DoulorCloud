import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * 图片的「骨架占位 → onLoad 渐入」。
 *
 * 直接 `<img>` 的问题是：图没到之前就是一块空白（或整页布局跳一下），
 * 图到了又「啪」地整张出现 —— 商城列表这种十几张图一起到的场景尤其突兀。
 * 这里给图片包一层占位底（muted 呼吸动画），`onLoad` 后透明度过渡到 1，
 * 视觉上是「占位 → 渐显」的连续过程。
 *
 * 两个容易踩的坑都处理了：
 *   · **缓存命中时 onLoad 不触发**（部分浏览器对 complete 的图不再派发 load）：
 *     用 ref 回调在挂载时检查 `complete && naturalWidth > 0`，已就绪直接置亮；
 *   · **加载失败**：切到 failed 态渲染 `fallback`（如卡片回退成图标封面），
 *     避免一张裂图挂在那里；没给 fallback 就显示占位底。
 *
 * 只适合「块级」的图（卡片封面、详情大图）；行内小图直接用 `<img>` 即可。
 */
export function FadeImage({
  src,
  alt,
  className,
  imgClassName,
  fallback,
}: {
  src: string
  alt: string
  /** 外层占位容器的尺寸类（如 h-36 w-full） */
  className?: string
  /** img 自身的类（object-cover 之类） */
  imgClassName?: string
  /** 加载失败时的替代渲染（可选） */
  fallback?: React.ReactNode
}) {
  const [loaded, setLoaded] = React.useState(false)
  const [failed, setFailed] = React.useState(false)

  // 缓存命中的图在 src 设置那一刻就是 complete 的，onLoad 可能不再触发 ——
  // 挂载时主动查一次状态，别让已就绪的图停在透明态。
  const imgRef = React.useCallback((el: HTMLImageElement | null) => {
    if (el && el.complete && el.naturalWidth > 0) setLoaded(true)
  }, [])

  if (failed && fallback) return <>{fallback}</>

  return (
    <div className={cn("relative overflow-hidden bg-muted/40", className)}>
      {!loaded && (
        <div
          className="absolute inset-0 animate-pulse bg-gradient-to-br from-muted/70 via-muted/30 to-muted/50"
          aria-hidden
        />
      )}
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        className={cn(
          "h-full w-full object-cover transition-opacity duration-300",
          loaded ? "opacity-100" : "opacity-0",
          imgClassName
        )}
      />
    </div>
  )
}
