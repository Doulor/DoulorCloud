import * as React from "react"
import { useLocation } from "react-router-dom"

/**
 * 页面内容入场：路由切换或整页刷新时，页面里的各个区块依次淡入上浮。
 *
 * 三条刻意的约束：
 *   1. **外壳不参与** —— 侧边栏与顶栏包在这一层外面，所以点导航时它们不会跟着闪。
 *      整个侧边栏每次都动一下，用两次就会烦。
 *   2. **不重新挂载子树** —— 常见的写法是给容器加 `key={location.key}` 让 React 重建，
 *      但那会丢掉组件状态（表单输入、滚动位置）并重发所有请求。
 *      这里改成「移除类 → 强制 reflow → 加回类」来重启 CSS 动画，代价只有一次同步布局。
 *   3. **同页子切换不重播** —— 见 suppressNextPageEnter()。
 *
 * 具体哪些元素动、错开多少，见 index.css 里的 `.page-enter` 规则。
 */

/**
 * 一次性开关：**下一次路由变化不要重播入场动画**。
 *
 * 为什么需要（2026-10-08 站长反馈「消息中心换分类、私聊换会话时整个界面跳一下」）：
 * 这两处的「子切换」也走路由 —— 消息中心是 `/dashboard/messages/<分类>`、
 * 私聊是 `/dashboard/dm/<用户名>`。它们只改了 URL 上的**一个参数**，
 * 页面主体（标题、标签栏、列表容器）根本没变，但 `location.key` 变了
 * ⇒ 整页区块重播一遍入场 ⇒ 观感是「整个界面闪/跳一下」。
 * 那一下既多余，又盖掉了本该看到的过渡（分类面板自己的淡入）。
 *
 * 用法：**在 navigate() 之前同步调用**。effect 里消费掉，所以只影响紧随其后的
 * 那一次路由变化；万一 navigate 没真的改变路由，最坏结果也只是下一次导航少播
 * 一次入场动画（纯观感，不会留下状态）。
 */
let suppressNext = false

export function suppressNextPageEnter(): void {
  suppressNext = true
}

export function PageEnter({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const ref = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const el = ref.current
    if (!el) return

    // 同页子切换：保持现状（类一直挂着、动画早已播完），不摘也不重加 ⇒ 不重播。
    if (suppressNext) {
      suppressNext = false
      el.classList.add("page-enter")
      return
    }

    el.classList.remove("page-enter")
    // 读一次 offsetWidth 强制浏览器结算样式，否则「移除 + 立刻加回」会被合并成一次、动画不重播。
    void el.offsetWidth
    el.classList.add("page-enter")
  }, [location.key])

  return <div ref={ref}>{children}</div>
}
