import * as React from "react"
import { useLocation } from "react-router-dom"

/**
 * 页面内容入场：路由切换或整页刷新时，页面里的各个区块依次淡入上浮。
 *
 * 两条刻意的约束：
 *   1. **外壳不参与** —— 侧边栏与顶栏包在这一层外面，所以点导航时它们不会跟着闪。
 *      整个侧边栏每次都动一下，用两次就会烦。
 *   2. **不重新挂载子树** —— 常见的写法是给容器加 `key={location.key}` 让 React 重建，
 *      但那会丢掉组件状态（表单输入、滚动位置）并重发所有请求。
 *      这里改成「移除类 → 强制 reflow → 加回类」来重启 CSS 动画，代价只有一次同步布局。
 *
 * 具体哪些元素动、错开多少，见 index.css 里的 `.page-enter` 规则。
 */
export function PageEnter({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const ref = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    el.classList.remove("page-enter")
    // 读一次 offsetWidth 强制浏览器结算样式，否则「移除 + 立刻加回」会被合并成一次、动画不重播。
    void el.offsetWidth
    el.classList.add("page-enter")
  }, [location.key])

  return <div ref={ref}>{children}</div>
}
