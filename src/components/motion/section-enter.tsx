import * as React from "react"

/**
 * 「按钮组当选项卡」的内容切换入场（动效层，2026-10-08）。
 *
 * 站里两类选项卡：
 *   · Radix Tabs（管理后台 / 捐献页 / 工具页）—— 切换动效由 index.css 里
 *     `[role="tabpanel"][data-state="active"]` 那条规则直接覆盖，零 JS；
 *   · **按钮组 + 条件渲染**（设置页分类筛选、商城分类筛选）—— 没有
 *     data-state 可蹭，切换时「留在场上的卡片」不会重新挂载、不会自己重播。
 *
 * 这个组件就是给第二类用的：`watch` 变化时做
 * 「摘掉 .section-enter 类 → 读一次 offsetWidth 强制 reflow → 加回」
 * 来重启 CSS 动画 —— 与 PageEnter 完全同一手法：
 *   · **不重新挂载子树**：React 的 key 重建会丢掉表单输入、滚动位置
 *     并重发所有请求，代价远大于一次同步布局；
 *   · 动画规则写在 index.css 的 `.section-enter > *`（只在 html.motion-on
 *     下生效）—— 开关关掉时这个类还在 DOM 里，但一条规则都不命中，
 *     切换就是瞬间替换，与现状完全一致。
 *
 * 用法：把它当容器 div 用，把要一起入场的内容放进去，
 * `watch` 传「哪个筛选在变」（分类、排序、页码都可以拼进去）：
 *   <SectionEnter watch={`${cat}|${sort}|${page}`} className="grid gap-4 …">
 */
export function SectionEnter({
  watch,
  className,
  children,
}: {
  /** 值一变就重播一次入场（字符串 / 数字；多个维度拼成一个 key 传进来） */
  watch: string | number
  className?: string
  children: React.ReactNode
}) {
  const ref = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    el.classList.remove("section-enter")
    // 读一次 offsetWidth 强制浏览器结算样式，否则「移除 + 立刻加回」
    // 会被合并成一次、动画不重播（与 PageEnter 同一个坑）。
    void el.offsetWidth
    el.classList.add("section-enter")
  }, [watch])

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  )
}
