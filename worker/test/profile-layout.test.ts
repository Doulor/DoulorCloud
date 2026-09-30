// 名片骨架布局：锁两个「桌面端错位」回归。
//
// 这两个 bug 都只在桌面宽度下才暴露，而且都不是「难看」而是「完全不能用」：
//   1. side 侧栏型：.wrap 原来是 display:flex 单行，可 DOM 里 .wrap 的子元素除了
//      .hero / .mods，还有 .stats / .attribution 两个 <footer>。四个挤在同一行互相
//      压缩，模块区被压成 0 像素宽 —— 页面等于空白。
//   2. bento 网格拼贴：.mods{display:contents} 后每个 .mod 都是网格项，而 .mod-music
//      不在跨列名单里，只有它一个模块时就孤零零占左半边。
//
// 断言的写法刻意只锁「结构意图」（是不是 grid、页脚在第几列、音乐卡跨不跨列），
// 不锁具体数值，免得调间距也要改测试。真正的像素表现由 Playwright 人工核对。
import { describe, it, expect, beforeEach } from "vitest"
import { authRequest, fetchSelf, makeUser } from "./helpers"

const jsonHeaders = { "Content-Type": "application/json" }

/** 用实时预览接口拿渲染好的 HTML（不用发布，改完立刻能验证） */
async function previewHtml(layout: string): Promise<string> {
  const user = await makeUser()
  await fetchSelf(authRequest(user, "/api/profile/enable", { method: "POST" }))
  const res = await fetchSelf(
    authRequest(user, "/api/profile/preview", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ displayName: "布局测试", layout }),
    })
  )
  expect(res.status).toBe(200)
  const { html } = (await res.json()) as { html: string }
  return html
}

/** 取出某条 CSS 规则（选择器 → 声明块），方便按结构断言而不是整串比对 */
function rule(css: string, selector: string): string | null {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const m = new RegExp("(?:^|\\n)" + esc + "\\{([^}]*)\\}").exec(css)
  return m ? m[1] : null
}

describe("名片骨架 —— 侧栏型（side）桌面端", () => {
  let css: string
  beforeEach(async () => {
    css = await previewHtml("side")
  })

  it("容器用两列 grid，而不是把所有子元素挤在一行 flex 里", () => {
    const wrap = rule(css, "body.layout-side .wrap")
    expect(wrap).not.toBeNull()
    expect(wrap).toContain("display:grid")
    // 关键：两列（左身份栏固定宽 + 右模块栏自适应）
    expect(wrap).toMatch(/grid-template-columns:\s*250px\s+minmax\(0,1fr\)/)
    expect(wrap).not.toContain("display:flex")
  })

  it("身份区在第 1 列，模块区在第 2 列，互不压缩", () => {
    expect(rule(css, "body.layout-side .hero")).toMatch(/grid-column:\s*1(;|$)/)
    expect(rule(css, "body.layout-side .mods")).toMatch(/grid-column:\s*2(;|$)/)
  })

  it("页脚统计与署名被放到第 2 列（跟着模块列走），不再横插进 flex 行", () => {
    expect(rule(css, "body.layout-side .stats")).toMatch(/grid-column:\s*2(;|$)/)
    expect(rule(css, "body.layout-side .attribution")).toMatch(/grid-column:\s*2(;|$)/)
  })

  it("窄屏回落到单列堆叠，身份区恢复居中", () => {
    expect(css).toMatch(
      /@media\(max-width:640px\)\{[\s\S]*?body\.layout-side \.wrap\{[^}]*grid-template-columns:\s*minmax\(0,1fr\)/
    )
    expect(css).toMatch(
      /@media\(max-width:640px\)\{[\s\S]*?body\.layout-side \.hero\{[^}]*align-items:center/
    )
  })
})

describe("名片骨架 —— 网格拼贴（bento）音乐卡", () => {
  let css: string
  beforeEach(async () => {
    css = await previewHtml("bento")
  })

  it("音乐卡跨满整行（横排的封面+标题+进度条，半宽会挤掉标题）", () => {
    const m = /body\.layout-bento ([^{]*\.mod-music)\{([^}]*)\}/.exec(css)
    expect(m, "音乐卡应有一条跨列规则").not.toBeNull()
    expect(m![2]).toMatch(/grid-column:\s*1\/-1/)
  })

  it("任何模块单独存在时都铺满整行（兜底，避免只剩半张卡的突兀感）", () => {
    expect(rule(css, "body.layout-bento .mods>.mod:only-child")).toMatch(
      /grid-column:\s*1\/-1/
    )
  })

  it("网格本身仍是两列（跨列规则不能被写坏成单列）", () => {
    expect(rule(css, "body.layout-bento .wrap")).toMatch(
      /grid-template-columns:\s*1fr\s+1fr/
    )
  })
})
