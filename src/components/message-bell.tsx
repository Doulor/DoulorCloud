import * as React from "react"
import { useNavigate } from "react-router-dom"
import { Bell } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useAuth } from "@/hooks/use-auth"
import { notificationApi } from "@/services/api"
import { onMessagesChanged } from "@/lib/message-events"
import { useT } from "@/i18n"

/** 未读数轮询间隔：与侧边栏「新帖」角标一致 */
const POLL_MS = 60_000

/**
 * 顶栏消息铃铛。
 *
 * 只显示未读**总数**（含系统 / 网站动态 / 社交 / 活动四类），点击进消息中心。
 * 未登录不渲染 —— 消息是登录用户的东西，游客点了也只是被拦回登录页。
 *
 * 刷新时机有三处，缺一都会出现「已读后红点还在」：
 *   1. 挂载 + 每 60 秒轮询（兜底）
 *   2. 消息中心页标记已读时广播的 onMessagesChanged（立即生效）
 *   3. 标签页重新可见时（轮询在后台被跳过，切回来要立刻纠正）
 */
export function MessageBell() {
  const { t } = useT()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [count, setCount] = React.useState(0)

  React.useEffect(() => {
    if (!user) {
      setCount(0)
      return
    }
    let cancelled = false
    const tick = () => {
      notificationApi
        .unreadCount()
        .then((r) => !cancelled && setCount(r.count))
        .catch(() => {})
    }
    // 轮询：页面不可见时跳过，省一次请求
    const poll = () => {
      if (document.hidden) return
      tick()
    }
    poll()
    const t = setInterval(poll, POLL_MS)
    // 消息中心已读后立即刷新，不等下一次轮询
    const off = onMessagesChanged(tick)
    const onVisible = () => {
      if (!document.hidden) tick()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      cancelled = true
      clearInterval(t)
      off()
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [user])

  if (!user) return null

  return (
    <Button
      variant="ghost"
      size="icon"
      className="relative"
      onClick={() => navigate("/dashboard/messages")}
      aria-label={count > 0 ? t("mb.aria", { n: count }) : t("mb.title")}
      title={t("mb.title")}
    >
      <Bell className="h-4 w-4" />
      {count > 0 && (
        // 用绝对定位的小圆点而不是 Badge：Badge 有高度，会把顶栏撑高
        <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium leading-none tabular-nums text-primary-foreground">
          {count > 99 ? "99+" : count}
        </span>
      )}
    </Button>
  )
}
