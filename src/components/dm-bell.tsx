import * as React from "react"
import { useNavigate } from "react-router-dom"
import { MessagesSquare } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useAuth } from "@/hooks/use-auth"
import { dmApi } from "@/services/api"

/** 未读数轮询间隔：与消息铃铛一致（60 秒） */
const POLL_MS = 60_000

/**
 * 顶栏「私信」入口（2026-10-01 新增）。
 *
 * 与消息铃铛并排放在一起，样式刻意保持一致（同样是绝对定位的小圆点而不是
 * Badge —— Badge 有高度会把顶栏撑高）。
 *
 * 为什么单独一个组件而不是往 MessageBell 里加：那个组件的语义是「消息中心未读」，
 * 私信是另一套（未读按会话算）。分开之后两边互不影响，也方便日后各自演化。
 *
 * ⚠️ 私信页自己会把「当前打开的会话」标已读，所以这里只需要 60 秒轮询兜底 +
 * 切回页面时立刻纠正；不引入跨组件事件总线，少一处耦合。
 */
export function DmBell() {
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
      dmApi
        .unread()
        .then((r) => !cancelled && setCount(r.unread))
        .catch(() => {
          /* 静默：顶栏角标不值得打扰用户 */
        })
    }
    const poll = () => {
      if (document.hidden) return
      tick()
    }
    poll()
    const t = setInterval(poll, POLL_MS)
    const onVisible = () => {
      if (!document.hidden) tick()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      cancelled = true
      clearInterval(t)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [user])

  if (!user) return null

  return (
    <Button
      variant="ghost"
      size="icon"
      className="relative"
      onClick={() => navigate("/dashboard/dm")}
      aria-label={count > 0 ? `私信（${count} 条未读）` : "私信"}
      title="私信"
    >
      <MessagesSquare className="h-4 w-4" />
      {count > 0 && (
        <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium leading-none tabular-nums text-primary-foreground">
          {count > 99 ? "99+" : count}
        </span>
      )}
    </Button>
  )
}
