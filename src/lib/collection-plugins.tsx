import * as React from "react"

/**
 * 造物典藏 —— **前端插件注册表**。
 *
 * 服务端的 `collection_plugins` 表是清单的**权威源**（名字、图标、简介、排序、
 * 上架状态都在那里）；这个文件只负责一件事：**把 slug 映射到一个 React 组件**。
 *
 * ---------------------------------------------------------------------------
 * 为什么清单在服务端、组件在前端（而不是两边都写一份）
 * ---------------------------------------------------------------------------
 * 服务端那份可以动态增删（将来用户在管理端发布自己的游戏，服务端会多出一行），
 * 前端这份必须随代码构建 —— 它是代码，不是数据。两边各自演进而互不阻塞：
 *   · 清单里有、注册表里没有 ⇒ 大厅显示「即将上线」（组件还没接上）；
 *   · 注册表里有、清单里没有 ⇒ 大厅看不到（没上架，符合预期）。
 *
 * ---------------------------------------------------------------------------
 * `runtime` 是宿主分流的关键
 * ---------------------------------------------------------------------------
 *   · `react`   —— 本站写的组件，从这个注册表取（内置插件，能拿完整服务端能力）；
 *   · `sandbox` —— 用户写的 HTML，将来由沙盒宿主渲染（拿不到会话 cookie，
 *                  只能通过站内白名单能力读写数据）。
 * v1 只有 `react` 这一种。**不要把 slug 判断写死到页面里** —— 那正是将来
 * 开放用户插件时要逐个翻出来改的东西。
 */
export const COLLECTION_PLUGIN_VIEWS: Record<
  string,
  React.LazyExoticComponent<React.ComponentType>
> = {
  // 「在线投资」：多人 K 线合约。懒加载 —— 交易界面（含自绘 K 线）不该进首屏包
  invest: React.lazy(() => import("@/pages/collection-invest")),
}

/** 取某个插件的组件；没接上返回 null（大厅据此显示「即将上线」） */
export function pluginViewFor(
  slug: string
): React.LazyExoticComponent<React.ComponentType> | null {
  return COLLECTION_PLUGIN_VIEWS[slug] ?? null
}

/** 卡片强调色的兜底（插件没声明 accent 时用站点中性灰） */
export const DEFAULT_PLUGIN_ACCENT = "#6b7280"
