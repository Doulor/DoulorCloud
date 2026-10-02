/**
 * 角标数据（`GET /api/attention`）在「外壳」与「页面」之间的共享层。
 *
 * 为什么需要：这份数据由 `DashboardLayout` 持有（一次请求拿齐、60 秒轮询、
 * 切页重取、正停在社区/聊天室时记已读）。但页面内部偶尔也要用同一个数 ——
 * 典型是社区页的「进入公共聊天室」卡片要显示聊天室未读数。
 *
 * 若不共享，社区页只能自己再发一次 `/api/attention` 并再养一套轮询：
 * 同一屏上出现两个来源，迟早一个显示 0、一个显示 3（刷新时机不同），
 * 而且每次轮询都会多打一次接口。走 context 则天然是「同一个数、同一时刻更新」。
 *
 * ⚠️ 这里下发的是**原始**计数（没有把「正停在这一页」归零那层处理）——
 * 卡片要显示的是真实未读数，不是侧边栏那种「你人在这儿就藏起来」的展示值。
 */
import * as React from "react"
import type { AttentionCounts } from "@/types"

export const AttentionContext = React.createContext<AttentionCounts | null>(null)

/**
 * 读取共享的角标计数。
 *
 * 返回 `null` 的两种情况，调用方都要能容忍：
 *   · 不在 `DashboardLayout` 内（例如公开页）；
 *   · 还没拉到数据 / 未登录。
 */
export function useAttentionCounts(): AttentionCounts | null {
  return React.useContext(AttentionContext)
}
