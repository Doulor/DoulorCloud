import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * 网站图标。有图标就显示图标，没有（或加载失败）就回退成首字母色块。
 *
 * ⚠️ 前端**不要**把库里的 `iconUrl` 直接塞进 `<img src>`：
 * 那个地址是第三方的，可能是 http（在 https 页面上会被浏览器当混合内容拦掉），
 * 也可能有防盗链。所以统一传 `src="/api/fun-links/icon/<id>"` 让 Worker 代理。
 * 弹窗里预览未保存的草稿时才直连。
 */

/** 字母头像的配色。必须是字面量类名，否则 Tailwind 扫不到。 */
const AVATAR_TONES = [
  "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
]

/** 同一站点永远同一个颜色（按名字算个稳定哈希） */
export function funLinkTone(title: string): string {
  let h = 0
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) % 997
  return AVATAR_TONES[h % AVATAR_TONES.length]
}

export function FunLinkIcon({
  src,
  title,
  size = 36,
  className,
}: {
  /** 已经算好的图片地址（代理地址或草稿里的原始地址）；空 = 直接显示首字母 */
  src?: string | null
  title: string
  size?: number
  className?: string
}) {
  const [failed, setFailed] = React.useState(false)

  // 换了一条链接要给它重新试一次的机会
  React.useEffect(() => {
    setFailed(false)
  }, [src])

  const showImage = Boolean(src) && !failed
  const initial = (title.trim() || "?").slice(0, 1).toUpperCase()

  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-lg",
        showImage ? "bg-muted" : funLinkTone(title),
        className
      )}
      style={{ width: size, height: size }}
    >
      {showImage ? (
        <img
          src={src as string}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="h-full w-full object-contain"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="font-semibold" style={{ fontSize: Math.round(size * 0.4) }}>
          {initial}
        </span>
      )}
    </span>
  )
}
