import * as React from "react"
import { useNavigate } from "react-router-dom"
import { Coins } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useAuth } from "@/hooks/use-auth"
import { pointsApi } from "@/services/api"

/**
 * 积分变动广播：积分页兑换成功后调用，顶栏徽章据此立即刷新。
 *
 * 为什么不用轮询：积分不像未读消息那样会在别的页面变化（只有本人在积分页
 * 兑换才会变），60 秒轮询一次纯属浪费；用一次性的自定义事件更省也更准。
 * 另外补一个 visibilitychange 兜底 —— 用户在别的标签页被别人发放了积分时，
 * 切回来能看到新数字。
 */
const POINTS_CHANGED_EVENT = "points:changed"

/** 通知顶栏积分徽章刷新（积分页兑换成功后调用） */
export function notifyPointsChanged() {
  window.dispatchEvent(new Event(POINTS_CHANGED_EVENT))
}

/** 顶栏积分余额徽章：显示当前积分，点击进入积分页。未登录不渲染。 */
export function PointsBadge() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [balance, setBalance] = React.useState<number | null>(null)

  React.useEffect(() => {
    if (!user) {
      setBalance(null)
      return
    }
    let cancelled = false
    const tick = () => {
      pointsApi
        .overview()
        .then((r) => !cancelled && setBalance(r.balance))
        .catch(() => {})
    }
    tick()
    const onVisible = () => {
      if (!document.hidden) tick()
    }
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener(POINTS_CHANGED_EVENT, tick)
    return () => {
      cancelled = true
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener(POINTS_CHANGED_EVENT, tick)
    }
  }, [user])

  // 未登录、或还没拉到余额时不渲染 —— 避免先闪一个「0 积分」再跳成真实值
  if (!user || balance === null) return null

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 gap-1.5 px-2"
      onClick={() => navigate("/dashboard/points")}
      aria-label={`我的积分：${balance}`}
      title="我的积分"
    >
      <Coins className="h-4 w-4 text-amber-500" />
      <span className="text-sm font-medium tabular-nums">{balance}</span>
    </Button>
  )
}
