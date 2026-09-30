// 名片模块宽度（half / full）：锁三件事。
//
//   1. 清洗：只认 half / full。编辑器的「自动」选项传的是 "auto"，必须**不写字段**
//      （写进去就等于给老数据凭空加了个非法的 size）。
//   2. 渲染：只有**显式设过**宽度的模块才输出 data-size。老数据一个都不输出 ——
//      这是「上线后所有人名片集体变样」的唯一防线，必须钉死。
//   3. CSS：两列网格由 `:has(>[data-size])` 做开关，所以没人设过宽度时 .mods
//      仍然是原来的单列流式；bento 里的覆盖规则必须排在按模块类型写死的名单**之后**
//      （同 specificity 后者胜），否则用户设了也不生效。
import { describe, it, expect } from "vitest"
import { sanitizeModules } from "../src/handlers/profile"
import { authRequest, fetchSelf, makeUser } from "./helpers"

const jsonHeaders = { "Content-Type": "application/json" }

/** 用实时预览接口拿渲染好的 HTML（不用发布，改完立刻能验证） */
async function previewHtml(layout: string, modules?: unknown): Promise<string> {
  const user = await makeUser()
  await fetchSelf(authRequest(user, "/api/profile/enable", { method: "POST" }))
  const res = await fetchSelf(
    authRequest(user, "/api/profile/preview", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ displayName: "宽度测试", layout, modules }),
    })
  )
  expect(res.status).toBe(200)
  const { html } = (await res.json()) as { html: string }
  return html
}

/** 取出某条 CSS 规则（选择器 → 声明块）。允许选择器前有缩进（@media 块内）。 */
function rule(css: string, selector: string): string | null {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const m = new RegExp("(?:^|\\n)\\s*" + esc + "\\{([^}]*)\\}").exec(css)
  return m ? m[1] : null
}

const TWO_MODULES = [
  { id: "tags", enabled: true, items: ["甲", "乙"] },
  { id: "quote", enabled: true, text: "你好" },
]

describe("模块宽度 —— 清洗", () => {
  it("half / full 原样保留", () => {
    expect(sanitizeModules([{ id: "tags", size: "half" }])[0].size).toBe("half")
    expect(sanitizeModules([{ id: "tags", size: "full" }])[0].size).toBe("full")
  })

  it("编辑器的「自动」选项传 auto，必须不写字段（等价于跟随骨架默认）", () => {
    const m = sanitizeModules([{ id: "tags", size: "auto" }])[0]
    expect("size" in m).toBe(false)
  })

  it("非法值一律丢弃，不会落库", () => {
    for (const bad of ["", "HALF", "Half", "wide", 1, null, undefined, {}, ["half"]]) {
      const m = sanitizeModules([{ id: "tags", size: bad }])[0]
      expect("size" in m, `size=${JSON.stringify(bad)} 不该被接受`).toBe(false)
    }
  })

  it("没设宽度就不写字段（老数据零影响）", () => {
    expect("size" in sanitizeModules([{ id: "tags" }])[0]).toBe(false)
  })
})

describe("模块宽度 —— 渲染", () => {
  it("显式设过宽度的模块带 data-size", async () => {
    const html = await previewHtml("bento", [
      { ...TWO_MODULES[0], size: "full" },
      { ...TWO_MODULES[1], size: "half" },
    ])
    expect(html).toMatch(/<section data-size="full" class="mod mod-tags"/)
    expect(html).toMatch(/<section data-size="half" class="mod mod-quote"/)
  })

  it("没设宽度时一个 data-size 都不输出（老数据渲染结果与改动前一致）", async () => {
    const html = await previewHtml("bento", TWO_MODULES)
    expect(html).toContain('<section class="mod mod-tags"')
    expect(html).toContain('<section class="mod mod-quote"')
    // 只看 <section> 标签，CSS 里的 [data-size] 选择器不算
    expect(html).not.toMatch(/<section[^>]*data-size/)
  })
})

describe("模块宽度 —— 桌面两列 CSS", () => {
  it("只在有人设过宽度时才把 .mods 切成两列网格（:has() 做开关）", async () => {
    const css = await previewHtml("center")
    const grid = rule(css, "body:not(.layout-bento) .mods:has(>[data-size])")
    expect(grid, "应有一条 :has() 开关规则").not.toBeNull()
    expect(grid).toContain("display:grid")
    expect(grid).toMatch(/grid-template-columns:\s*1fr\s+1fr/)
  })

  it("默认跨满整行，只有显式设了 half 的才占一列", async () => {
    const css = await previewHtml("center")
    // 没设宽度的模块身上**没有** data-size 属性，必须靠这条兜底跨列；
    // 否则它们不匹配任何规则，掉进 grid 默认行为占 1 列 —— 变成半宽，比改动前更糟
    expect(rule(css, "body:not(.layout-bento) .mods>.mod")).toMatch(/grid-column:\s*1\/-1/)
    expect(rule(css, 'body:not(.layout-bento) .mods>[data-size="half"]')).toMatch(
      /grid-column:\s*span 1/
    )
    // 兜底必须排在 half 规则**之前**：同 specificity 时后者胜
    const base = css.indexOf("body:not(.layout-bento) .mods>.mod{")
    const half = css.indexOf('body:not(.layout-bento) .mods>[data-size="half"]')
    expect(base).toBeGreaterThan(-1)
    expect(half).toBeGreaterThan(base)
  })

  it("两列网格只在桌面端生效，移动端保持单列", async () => {
    const css = await previewHtml("center")
    expect(css).toMatch(/@media\(min-width:641px\)\{[\s\S]*?\.mods:has\(>\[data-size\]\)/)
  })

  it("bento：用户设的宽度能覆盖按模块类型写死的跨列名单，且覆盖规则排在名单之后", async () => {
    const css = await previewHtml("bento")
    expect(rule(css, 'body.layout-bento .mod[data-size="half"]')).toMatch(
      /grid-column:\s*span 1/
    )
    expect(rule(css, 'body.layout-bento .mod[data-size="full"]')).toMatch(
      /grid-column:\s*1\/-1/
    )
    const hardcoded = css.indexOf("body.layout-bento .mod-gallery")
    const override = css.indexOf('body.layout-bento .mod[data-size="half"]')
    expect(hardcoded).toBeGreaterThan(-1)
    expect(override).toBeGreaterThan(hardcoded)
  })
})
