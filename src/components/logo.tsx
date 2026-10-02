import * as React from "react"
import { Cloud } from "lucide-react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import { useT } from "@/i18n"

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
  const { t } = useT()
  const location = useLocation()
  const navigate = useNavigate()

  /**
   * 已经站在落地页时，点 Logo 再 `to="/"` 是「原地导航」——什么都不会发生。
   * 站长 2026-10-02 反馈：滚到中间后点左上角图标/文字应该回到页面最上面。
   * 所以此时拦掉导航、改成滚回顶部（顺手清掉 hash，免得 hash 滚动逻辑又拉回去）。
   */
  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (location.pathname === "/") {
      e.preventDefault()
      if (location.hash) navigate("/", { replace: true })
      window.scrollTo({ top: 0, behavior: "smooth" })
    }
  }

  return (
    <Link
      to="/"
      onClick={handleClick}
      className={`flex items-center gap-2 font-semibold tracking-tight ${className ?? ""}`}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-foreground text-background">
        <Cloud className="h-4 w-4" />
      </span>
      {tagline ? (
        <span className="flex min-w-0 flex-col leading-tight">
          <span>Doulor Cloud</span>
          <span className="truncate pl-[2em] text-[10px] font-normal text-muted-foreground">
            {t("logo.tagline")}
          </span>
        </span>
      ) : (
        <span>Doulor Cloud</span>
      )}
    </Link>
  )
}
