import * as React from "react"

/**
 * 「界面动效」总开关（2026-10-08 站长要求：全站统一、可整体开/关的动效层）。
 *
 * 架构约定（加任何新动效前必读）：
 *   · 开启 = 给 <html> 挂 .motion-on 类；**新动效的每条规则（CSS / JS）都必须
 *     且只能写在这个类的作用域下** —— 开关一关、类一摘，一条规则都不命中，
 *     「关闭 = 站点现状」由架构保证，不用逐个效果去关，也不存在关不干净的残留。
 *   · 既有动效（page-enter 入场、光标光晕、聊天气泡浮入等）**不归这个开关管**：
 *     它们是「现状」的一部分，关闭时必须原样保留。
 *   · 偏好与主题切换同款模式（见 use-theme.ts）：存浏览器 localStorage，
 *     不进账号、不同步后端 —— 动效是纯客户端观感，没必要为它过一次 API。
 *
 * 未存储过时跟随系统「减少动态效果」（prefers-reduced-motion）：
 * 系统要求少动就默认关 —— 无障碍底线，不拿动效轰这类用户。
 */

const MOTION_KEY = "doulor-motion"
/** 点击粒子的独立偏好键（2026-10-08 站长要求：其他动效默认开，点击动效默认关） */
const SPARK_KEY = "doulor-motion-spark"

/** 动效层的总闸类名：挂在 <html> 上，所有新动效规则只认它 */
export const MOTION_CLASS = "motion-on"
/** 点击粒子的独立开关类名：ClickSpark 要「总闸 + 这个」两个类同时在才工作 */
export const SPARK_CLASS = "motion-spark"

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
}

/** 读初始值：存过听存的；没存过 = 默认开，但系统要求「减少动态」时默认关 */
export function motionPrefInitial(): boolean {
  if (typeof window === "undefined") return false
  const raw = localStorage.getItem(MOTION_KEY)
  if (raw === "1") return true
  if (raw === "0") return false
  return !reducedMotion()
}

/**
 * 点击粒子的初始值：**默认关**（站长的取舍 —— 选项卡/弹窗这类「跟着操作走」的
 * 动效默认开，全局每次点击都出粒子的默认别开，喜欢的人自己打开）。
 * 总闸（motion-on）关着时它本来就不工作，这里的偏好只决定「总闸开着时要不要出」。
 */
export function sparkPrefInitial(): boolean {
  if (typeof window === "undefined") return false
  return localStorage.getItem(SPARK_KEY) === "1"
}

/** 把偏好立刻落到 <html> 上（类才是真正生效的总闸） */
function applyFlag(cls: string, on: boolean) {
  document.documentElement.classList.toggle(cls, on)
}

/*
 * 模块加载时就先落一次类，**不等 React 挂载**：
 * 设置页之外没人调 useMotionPref，但全局效果（ClickSpark 等）只认 <html> 的类，
 * 类必须从首个 bundle 加载起就位 —— 否则用户进站到打开设置页之间动效是死的。
 */
if (typeof window !== "undefined") {
  applyFlag(MOTION_CLASS, motionPrefInitial())
  applyFlag(SPARK_CLASS, sparkPrefInitial())
}

export function useMotionPref() {
  const [motionOn, setMotionOn] = React.useState<boolean>(motionPrefInitial)
  const [sparkOn, setSparkOn] = React.useState<boolean>(sparkPrefInitial)

  React.useEffect(() => {
    applyFlag(MOTION_CLASS, motionOn)
    localStorage.setItem(MOTION_KEY, motionOn ? "1" : "0")
  }, [motionOn])

  React.useEffect(() => {
    applyFlag(SPARK_CLASS, sparkOn)
    localStorage.setItem(SPARK_KEY, sparkOn ? "1" : "0")
  }, [sparkOn])

  return { motionOn, setMotionOn, sparkOn, setSparkOn }
}
