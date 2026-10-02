import * as React from "react"
import { Link } from "react-router-dom"
import { ArrowUpRight, Loader2, Trophy } from "lucide-react"

import { UserAvatar } from "@/components/user-avatar"
import { RoleBadge } from "@/components/role-badge"
import { CustomTitleBadge } from "@/components/custom-title-badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { spaceApi } from "@/services/api"
import { fmtUid } from "@/lib/format"
import type { SpaceCardData } from "@/types"
import { useT } from "@/i18n"

/**
 * 点击头像弹出的「用户小卡片」。
 *
 * 数据来自 `GET /api/space/:username/card` —— 单独一个轻量接口，因为这是
 * 「点一次拉一次」的交互，不该顺带把帖子、贡献、成就墙全查一遍。
 *
 * 加载失败时**不弹空卡片**：整块包在触发元素上，但内容退化成一句
 * 「看不到资料」+ 仍然可跳转的个人空间链接 —— 卡片拉不到不该让人觉得点坏了。
 */
export function UserCardPopover({
  username,
  nickname,
  hasAvatar,
  className,
  children,
}: {
  username: string
  nickname?: string | null
  hasAvatar?: boolean
  /** 传给触发按钮的样式（一般给 inline-flex 之类） */
  className?: string
  children: React.ReactNode
}) {
  const { t } = useT()
  const [open, setOpen] = React.useState(false)
  const [data, setData] = React.useState<SpaceCardData | null>(null)
  const [failed, setFailed] = React.useState(false)

  // 只在第一次打开时拉，之后复用（换用户时重置）
  React.useEffect(() => {
    setData(null)
    setFailed(false)
  }, [username])

  React.useEffect(() => {
    if (!open || data || failed) return
    let cancelled = false
    void (async () => {
      try {
        const res = await spaceApi.card(username)
        if (!cancelled) setData(res)
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, username, data, failed])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={className ?? "inline-flex items-center gap-2.5 text-left"}
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 overflow-hidden p-0">
        {/* 头部：头像 + 名字 */}
        <div className="flex items-center gap-2.5 px-3 py-3">
          <UserAvatar
            username={username}
            nickname={nickname}
            hasAvatar={hasAvatar}
            className="h-10 w-10"
          />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-sm font-semibold">
                {data?.nickname ?? nickname ?? username}
              </span>
              {(data?.isAdmin ?? false) && (
                <RoleBadge role={data?.isRoot ? "root" : "admin"} />
              )}
              {data?.customTitle && <CustomTitleBadge title={data.customTitle} />}
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {data?.uid != null && (
                <span className="mr-1 font-medium text-foreground/70">{fmtUid(data.uid)}</span>
              )}
              @{username}
            </p>
          </div>
        </div>

        {/* 详情 */}
        <div className="space-y-1 border-t px-3 py-2.5 text-xs text-muted-foreground">
          {!data && !failed && (
            <p className="flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("uc2.loading")}
            </p>
          )}
          {failed && <p>{t("uc2.failed")}</p>}
          {data && (
            <>
              {data.motto && <p className="italic">「{data.motto}」</p>}
              <p className="flex items-center gap-1.5">
                <Trophy className="h-3 w-3" />
                {t("uc2.titleLine", { title: data.title, unlocked: data.unlocked, total: data.total })}
              </p>
              <p>
                {t("uc2.stats", { days: data.days, posts: data.posts })}
              </p>
            </>
          )}
        </div>

        <div className="border-t p-1.5">
          <Button asChild variant="ghost" size="sm" className="w-full justify-center">
            <Link to={`/space/${encodeURIComponent(username)}`}>
              {t("lay.viewSpace")}
              <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
