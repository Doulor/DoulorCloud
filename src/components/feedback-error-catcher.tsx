/**
 * 报错时的「附日志反馈」入口（2026-10-10）。
 *
 * 背景：用户遇到报错时，多数人不会主动去提反馈；等他提了，复现现场已经没了。
 * 这里在 window error / unhandledrejection 上做一层**冷却型**提示：同一会话内
 * 错误攒到 3 条（说明不是偶发抖动），弹一次 sonner toast，带「附日志反馈」
 * 按钮 —— 点了直接跳反馈页并预选「附诊断日志」（用 navigate 的 location.state
 * 传递，反馈页挂载时读取；不要用「navigate 后立刻 dispatch 事件」——组件还没
 * 挂载，事件会丢）。
 *
 * 纪律：
 *   · 冷却 10 分钟：报错风暴时也至多 10 分钟提醒一次，绝不刷屏；
 *   · 监听是被动回调、零轮询；诊断日志没启用（站点开关关）时完全不提示 ——
 *     提示了也附不了日志，白打扰；
 *   · toast 在这里弹而不放进 diag-log 循环：本组件只消费错误事件，不产生。
 */
import * as React from "react"
import { toast } from "sonner"
import { useNavigate } from "react-router-dom"
import { isDiagLogEnabled, lastErrorTime } from "@/lib/diag-log"
import { useT } from "@/i18n"

/** 攒够多少条错误才提示（少于这个数多半是偶发，不打扰） */
const ERROR_THRESHOLD = 3
/** 两次提示之间的最小间隔 */
const COOLDOWN_MS = 10 * 60_000
/** 窗口时长：最近 60 秒内的错误才计数（旧错误不算数） */
const WINDOW_MS = 60_000

/** 跳反馈页时携带的 location.state 形状（反馈页据此预选「附诊断日志」） */
export interface FeedbackDiagNavState {
  attachDiag?: boolean
}

export function FeedbackErrorCatcher() {
  const { t } = useT()
  const navigate = useNavigate()

  React.useEffect(() => {
    let timestamps: number[] = []
    let lastToastAt = 0

    const consider = () => {
      if (!isDiagLogEnabled()) return
      const now = Date.now()
      timestamps = timestamps.filter((x) => now - x <= WINDOW_MS)
      if (timestamps.length < ERROR_THRESHOLD) return
      if (now - lastToastAt < COOLDOWN_MS) return
      lastToastAt = now
      timestamps = []
      toast.error(t("diag.errorToast.title"), {
        description: t("diag.errorToast.desc"),
        action: {
          label: t("diag.errorToast.action"),
          onClick: () => {
            // state 随导航一起提交，反馈页首次挂载就能读到（事件做不到：那时
            // 页面组件还没挂载，监听器尚未注册）
            navigate("/dashboard/feedback", {
              state: { attachDiag: true } satisfies FeedbackDiagNavState,
            })
          },
        },
      })
    }

    const onError = () => {
      timestamps.push(lastErrorTime() || Date.now())
      consider()
    }
    window.addEventListener("error", onError)
    window.addEventListener("unhandledrejection", onError)
    return () => {
      window.removeEventListener("error", onError)
      window.removeEventListener("unhandledrejection", onError)
    }
  }, [t, navigate])

  return null
}
