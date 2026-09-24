import { Cloud } from "lucide-react"
import { Link } from "react-router-dom"

/**
 * 站点 Logo。`tagline` 为 true 时在名称下方追加一行小字副标题
 * （侧边栏宽度有限，默认关闭，仅控制台侧边栏开启）。
 */
export function Logo({
  className,
  tagline = false,
}: {
  className?: string
  tagline?: boolean
}) {
  return (
    <Link
      to="/"
      className={`flex items-center gap-2 font-semibold tracking-tight ${className ?? ""}`}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-foreground text-background">
        <Cloud className="h-4 w-4" />
      </span>
      {tagline ? (
        <span className="flex min-w-0 flex-col leading-tight">
          <span>Doulor Cloud</span>
          <span className="truncate pl-[2em] text-[10px] font-normal text-muted-foreground">
            一个不断向共产主义靠拢的社区
          </span>
        </span>
      ) : (
        <span>Doulor Cloud</span>
      )}
    </Link>
  )
}
