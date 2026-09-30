// 名片页歌词渲染。
//
// 歌词是**用户可控文本**，会被直接拼进公开页 HTML，所以这里要盯住两件事：
//   1. LRC 解析是否准确（时间轴、一行多标签、两位小数 vs 三位小数）
//   2. 转义 —— 歌词里写 <script> 不能变成真脚本
//
// 另外「没有时间轴」是一条正常的降级路径（用户可能手填纯文本歌词），
// 必须渲染成静态块而不是报错或整块消失。
import { describe, it, expect } from "vitest"
import { renderProfileHtml } from "../src/profile-page"
import type { PublicProfile } from "../src/handlers/profile"

/** 只留音乐模块的最小名片 */
function profileWithMusic(musicLyrics: string | null): PublicProfile {
  return {
    slug: "t",
    username: "t",
    displayName: "测试",
    bio: null,
    theme: "void",
    accent: null,
    effects: [],
    intro: "none",
    font: "system",
    cjkFont: "system",
    layout: "center",
    scaleMode: "auto",
    scaleMin: 50,
    scaleManual: 100,
    avatar: null,
    background: null,
    // 搜索来的歌在公开页就是这个相对路径，由服务端实时解析成真实地址
    music: "/p/t/music",
    musicCover: null,
    musicTitle: "测试曲",
    musicAutoplay: false,
    musicSource: "netease:1330348068",
    musicLyrics,
    contacts: [],
    modules: [{ id: "music", enabled: true }],
    registeredAt: null,
    viewCount: 0,
  }
}

/** 数出渲染了多少行带时间轴的歌词 */
function lyricLineCount(html: string): number {
  return (html.match(/class="lrc-line"/g) ?? []).length
}

/**
 * 是否真的渲染出了歌词元素。
 *
 * ⚠️ 不能用 `toContain("lyrics-plain")` 之类判断 —— 那个类名在 <style> 里
 * 本来就存在，无论有没有歌词都会命中（写这条断言时正是踩了这个坑）。
 * 必须匹配标签本身。
 */
function hasLyricsBlock(html: string): boolean {
  return html.includes('<div class="lyrics')
}

describe("歌词渲染", () => {
  it("带时间轴 → 每行一个 data-t（两位小数）", () => {
    const html = renderProfileHtml(
      profileWithMusic("[00:12.34] 第一句\n[00:16.00] 第二句")
    )
    expect(html).toContain('data-t="12.34"')
    expect(html).toContain('data-t="16.00"')
    expect(html).toContain("第一句")
    expect(html).toContain("第二句")
    expect(lyricLineCount(html)).toBe(2)
  })

  it("三位小数按毫秒算，两位按百分秒算（差一个数量级）", () => {
    const html = renderProfileHtml(profileWithMusic("[01:02.500] 毫秒写法"))
    expect(html).toContain('data-t="62.50"')
    const html2 = renderProfileHtml(profileWithMusic("[01:02.50] 百分秒写法"))
    expect(html2).toContain('data-t="62.50"')
  })

  it("一行挂多个时间标签会展开成多行（LRC 的合法写法，常见于副歌复用）", () => {
    const html = renderProfileHtml(profileWithMusic("[00:01.00][00:02.00] 副歌"))
    expect(lyricLineCount(html)).toBe(2)
    expect(html).toContain('data-t="1.00"')
    expect(html).toContain('data-t="2.00"')
  })

  it("元信息标签（[ti:] / [ar:] / [by:]）被忽略，不会被当成歌词行", () => {
    const html = renderProfileHtml(
      profileWithMusic("[ti:歌名]\n[ar:歌手]\n[00:05.00] 真正的歌词")
    )
    expect(lyricLineCount(html)).toBe(1)
    expect(html).not.toContain("歌名")
  })

  it("没有时间轴的纯文本 → 静态块，不产出可同步的行", () => {
    const html = renderProfileHtml(profileWithMusic("第一行\n第二行"))
    expect(html).toContain("lyrics-plain")
    expect(html).toContain("第一行")
    expect(lyricLineCount(html)).toBe(0)
    expect(html).not.toContain("data-t=")
  })

  it("歌词里的 HTML 被转义（这是公开页，不能有注入面）", () => {
    const html = renderProfileHtml(
      profileWithMusic("[00:01.00] <script>alert(1)</script>")
    )
    expect(html).not.toContain("<script>alert(1)</script>")
    expect(html).toContain("&lt;script&gt;")
  })

  it("纯文本歌词里的 HTML 同样被转义", () => {
    const html = renderProfileHtml(profileWithMusic("<img src=x onerror=alert(1)>"))
    expect(html).not.toContain("<img src=x onerror=alert(1)>")
    expect(html).toContain("&lt;img")
  })

  it("没有歌词时不渲染歌词块", () => {
    const html = renderProfileHtml(profileWithMusic(null))
    expect(hasLyricsBlock(html)).toBe(false)
  })

  it("只有空白字符的歌词视为没有", () => {
    const html = renderProfileHtml(profileWithMusic("   \n  \n "))
    expect(hasLyricsBlock(html)).toBe(false)
  })

  it("只有时间标签、没有文字的行被丢弃（不会渲染出空行）", () => {
    const html = renderProfileHtml(profileWithMusic("[00:01.00]\n[00:02.00] 有字"))
    expect(lyricLineCount(html)).toBe(1)
  })
})

// ---- 只显示「当前行 + 下一行」：两个真实踩过的坑 ----
//
//   坑 1（线上可见）：.lrc-line 的**基准** opacity 写成 .42，于是所有没被标记的行
//     都停在 translateY(0) 上 —— 全部叠在卡片最顶上、一直显示。必须基准 0、只有
//     .on / .pre 两行可见。
//   坑 2：高度 calc(2 * 1.9em + ...) 里的 em 落在 .lrc-inner 身上，而字号写在 .lrc-line 上
//     ⇒ em 按 .lrc-inner 继承的 16px 算，容器 73px 而两行只占 46px，卡片又高又空。
//     修法是把 font-size 提到 .lrc-inner，让 em 与行高同源。
describe("歌词只显示两行", () => {
  /** 取出某条 CSS 规则（选择器 → 声明块）。允许选择器前有缩进（@media / @container 块内）。 */
  function rule(css: string, selector: string): string | null {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const m = new RegExp("(?:^|\\n)\\s*" + esc + "\\{([^}]*)\\}").exec(css)
    return m ? m[1] : null
  }

  const css = renderProfileHtml(profileWithMusic("[00:12.00] 甲\n[00:16.00] 乙\n[00:20.00] 丙"))

  it("基准透明度必须是 0 —— 否则所有歌词会叠在卡片最顶上", () => {
    const base = rule(css, ".lrc-line")
    expect(base, "应能找到 .lrc-line 基础规则").not.toBeNull()
    expect(base).toMatch(/opacity:\s*0(;|$)/)
  })

  it("只有当前行与下一行可见", () => {
    expect(rule(css, ".lrc-line.on")).toMatch(/opacity:\s*1/)
    expect(rule(css, ".lrc-line.pre")).toMatch(/opacity:\s*\.42/)
  })

  it("行高与高度同源：.lrc-inner 自己声明字号，em 才不会按 16px 算", () => {
    const inner = rule(css, ".lrc-inner")
    expect(inner).toMatch(/font-size:\s*12px/)
    expect(inner).toMatch(/line-height:\s*1\.75/)
    // 高度里的 em 倍数必须与 line-height 一致
    expect(inner).toMatch(/height:calc\(2\s*\*\s*1\.75em/)
  })

  it("歌词行继承容器的字号，不再自己写 font-size（否则 em 基准又会对不上）", () => {
    expect(rule(css, ".lrc-line")).toMatch(/font-size:inherit/)
  })

  it("音乐模块是容器查询的容器，够宽时歌词挪到右边、窄时在下面", () => {
    expect(rule(css, ".mod-music")).toMatch(/container-type:\s*inline-size/)
    expect(css).toMatch(/@container\s*\(min-width:620px\)/)
    // 容器查询里只能改**后代**的位置（容器改不了自己），所以并排靠给子元素分列实现
    expect(css).toMatch(/\.mod-music>\.player\{grid-column:1\}/)
    expect(css).toMatch(/\.mod-music>\.lyrics\{grid-column:2/)
  })
})

describe("歌词同步脚本", () => {
  const html = renderProfileHtml(profileWithMusic("[00:12.00] 甲\n[00:16.00] 乙"))

  it("idx 初值不能是 -1 —— 歌曲开头算出的 i 就是 -1，会命中提前 return 导致一行都不标记", () => {
    expect(html).toContain("var idx=-2")
    expect(html).not.toContain("var idx=-1")
  })

  it("还没唱到第一句时，把第一句当「下一行」先亮出来（否则歌词框是空的）", () => {
    expect(html).toContain("var cur=i, nxt=(i<rows.length-1)?i+1:-1")
  })
})
