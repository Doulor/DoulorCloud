/**
 * 广场的界面偏好（2026-10-12 站长要求）。
 *
 * 「不看水帖」原先只是筛选下拉里的一个选项，每次刷新都要重新选一次 ——
 * 站长要求把它**拿出来做成勾选并长期记住**。
 *
 * 存 localStorage，与本项目其它界面偏好（主题 `use-theme`、动效 `use-motion-pref`、
 * 消息通知 `use-message-notify`）同一套做法：不占服务端、不跨设备同步，
 * 但「同一个浏览器长期记住」正是这里要的效果。
 */
import * as React from "react"

const HIDE_WATER_KEY = "plaza-hide-water"

/** 读初始值：隐私模式 / 禁用存储时按「不隐藏」处理，绝不能让页面挂掉 */
function readInitial(): boolean {
  try {
    return localStorage.getItem(HIDE_WATER_KEY) === "1"
  } catch {
    return false
  }
}

/** [是否隐藏水帖, 设置] —— 设置会立刻落盘，长期生效 */
export function useHideWater(): readonly [boolean, (v: boolean) => void] {
  const [hideWater, setHideWaterState] = React.useState(readInitial)

  const setHideWater = React.useCallback((v: boolean) => {
    setHideWaterState(v)
    try {
      localStorage.setItem(HIDE_WATER_KEY, v ? "1" : "0")
    } catch {
      /* 存不下就算了：本次会话内仍然生效 */
    }
  }, [])

  return [hideWater, setHideWater] as const
}
