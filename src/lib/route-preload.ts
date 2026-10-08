import * as React from "react"

/**
 * 路由预加载（2026-10-08，站长反馈「侧边栏点一下要等，管理面板点一下就到」）。
 *
 * 问题：主侧边栏是**跨路由**跳转，页面都是 React.lazy 懒加载 ⇒ 点下去才去下载
 * 那个页面的 JS chunk，下载+解析期间 Suspense 只会显示一个转圈。管理员面板
 * 的侧边栏是**同一个已加载文件内**的 state 切换，所以「点哪到哪」。
 *
 * 解法：把「下载」提前到**点击之前**——鼠标悬停（或键盘聚焦、触摸按下）时就把
 * 那个页面的 chunk 取回来；等真正点下去，代码已经在浏览器里，直接渲染。
 * 这与管理面板的手感等价，且不改变任何现有路由/懒加载结构。
 *
 * 三条实现约束：
 *   1. **只请求一次**：loader 的 Promise 在这里缓存，`React.lazy` 与 `preload()`
 *      共用同一个 —— 预载过之后再点，不会重复下载。
 *   2. **预载失败不影响体验**：`preload()` 吞掉 rejection。真正渲染时
 *      React.lazy 才把错误交给 ErrorBoundary（与没有预载时行为一致）。
 *   3. **不做无差别预取**：只预取「用户已经表现出兴趣」的目标（悬停/聚焦），
 *      外加桌面端空闲时的侧边栏一级页面（见 idlePreloadDashboard）。移动端
 *      （无 hover）不做空闲预取，免得替用户在蜂窝流量上偷偷下几百 KB。
 */

/**
 * 带预载能力的懒加载组件。
 *
 * 约束用 `ComponentType<any>` 是**继承 React.lazy 自己的签名**（它内部就是这个
 * 上界）：本站各页面 props 各不相同（多数无 props，CommunityPage 有 inDashboard），
 * 用一个更窄的上界会把泛型推导掐死、调用处 `<CommunityPage inDashboard />` 直接报错。
 * 这里的 any 只出现在「上界」位置，不影响任何调用点的类型安全。
 */
export type PreloadablePage<T extends React.ComponentType<any>> =
  React.LazyExoticComponent<T> & { preload: () => void }

/**
 * 把 `React.lazy` 包一层，挂上 `preload()`。
 *
 * `cache` 保证 loader 只被真正调用一次（浏览器对同一模块的重复 import 本身
 * 也会走模块缓存，但显式缓存让「谁先触发」这件事变得确定、可见）。
 */
export function lazyPage<T extends React.ComponentType<any>>(
  loader: () => Promise<{ default: T }>
): PreloadablePage<T> {
  let cache: Promise<{ default: T }> | null = null
  const load = () => (cache ??= loader())
  const Comp = React.lazy(load) as PreloadablePage<T>
  Comp.preload = () => {
    void load().catch(() => {
      /* 预载失败静默：真正渲染时 React.lazy 会抛给 ErrorBoundary */
    })
  }
  return Comp
}

/** 路由路径 → 预载函数 */
const registry = new Map<string, () => void>()

/**
 * 定义一个路由页面：既是懒加载组件，又把「路径 → 预载」登记进表。
 *
 * 路径用于**前缀匹配**（`/dashboard/toolbox/timestamp` 会命中
 * `/dashboard/toolbox`），所以注册时给「页面级」路径即可，不必列全子路由。
 */
export function page<T extends React.ComponentType<any>>(
  path: string,
  loader: () => Promise<{ default: T }>
): PreloadablePage<T> {
  const Comp = lazyPage(loader)
  registry.set(path, Comp.preload)
  return Comp
}

/**
 * 按路径预载对应页面。找不到匹配（或页面已加载）时**静默什么都不做** ——
 * 悬停一个还没注册的路径不该报错。
 *
 * 匹配规则：精确相等，或该路径是注册路径的**子路径**（`path + "/"` 前缀）。
 * 命中多个时取最长的那个（`/dashboard/toolbox/timestamp` 优先命中
 * `/dashboard/toolbox` 而不是 `/dashboard`）。
 */
export function preloadRoute(path: string): void {
  let best: string | null = null
  for (const key of registry.keys()) {
    if (path === key || path.startsWith(key + "/")) {
      if (!best || key.length > best.length) best = key
    }
  }
  if (best) registry.get(best)!()
}

/**
 * 桌面端空闲时预取一组路径（通常传侧边栏的一级入口）。
 *
 * 为什么限定桌面：`(hover: hover)` 为假说明是触屏设备，空闲预取等于替用户
 * 在移动网络上多下几百 KB —— 收益（省一次等待）不值这个代价。
 *
 * 逐个串行、每个之间隔一点时间：并发发起十几个请求会跟首屏/接口抢带宽，
 * 反而拖慢用户正在看的东西。串行则是在网络真正空闲时才慢慢取。
 */
export function idlePreload(paths: readonly string[]): () => void {
  if (typeof window === "undefined") return () => {}
  if (!window.matchMedia("(hover: hover)").matches) return () => {}

  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const queue = [...paths]
  const step = () => {
    if (cancelled || queue.length === 0) return
    preloadRoute(queue.shift()!)
    // 每个之间 500ms：够让出带宽，又能在一两秒内铺完侧边栏
    timer = setTimeout(step, 500)
  }
  // requestIdleCallback 不支持时退到「首屏之后再等一会儿」
  const idle = (window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
  }).requestIdleCallback
  if (idle) {
    idle(step, { timeout: 3000 })
  } else {
    timer = setTimeout(step, 2000)
  }
  return () => {
    cancelled = true
    if (timer) clearTimeout(timer)
  }
}
