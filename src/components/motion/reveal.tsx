import * as React from "react"

/**
 * 滚动入场（动效层，2026-10-08）：给带 .motion-reveal 类的元素做
 * 「滚进视口才淡入上浮」，每个元素只播一次。
 *
 * 用法分两半：
 *   1. 本组件挂 App 根部**一次**（全站唯一观察器，顺带 MutationObserver
 *      接住懒加载后补进 DOM 的 .motion-reveal 元素）；
 *   2. 哪个元素要入场动画，给它加 `motion-reveal` 类即可 —— 不用包组件、
 *      不改结构，适合直接落在 <section> 这种语义标签上。
 *
 * 「关 = 现状」：入场样式全部写在 `html.motion-on .motion-reveal` 下，
 * 开关关掉时这些元素是普通可见元素；本观察器虽然仍在打 .motion-revealed
 * 标记，但那只是个没人消费的类名，零视觉影响。
 *
 * 观察/标记与动效开关**解耦**是有意的：用户中途打开开关时，已在视口里的
 * 元素早被标记过、立即可见；还没滚到的照常等待 —— 不需要监听开关重扫。
 */
export function RevealAll() {
  React.useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("motion-revealed")
            io.unobserve(e.target)
          }
        }
      },
      // 底部收 8%：内容刚好贴着视口底边才露出时再播，观感更「滚进来」
      { rootMargin: "0px 0px -8% 0px" }
    )
    const scan = () => {
      document
        .querySelectorAll(".motion-reveal:not(.motion-revealed)")
        .forEach((el) => io.observe(el))
    }
    scan()
    const mo = new MutationObserver(scan)
    mo.observe(document.body, { childList: true, subtree: true })
    return () => {
      io.disconnect()
      mo.disconnect()
    }
  }, [])
  return null
}
