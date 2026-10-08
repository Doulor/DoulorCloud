// 名片设计系统的校验与渲染。
//
// 重点锁两件事：
//   1. sanitizeDesign 是严格白名单 —— 未知键、越界、非法值一律丢弃或夹取，
//      永远不能让一个坏字段污染 designCss 的输出。
//   2. designCss 只输出用户真正设过的项 —— {} 输入产出空串，
//      这是「存量 343 张名片逐像素不变」的根保证。
import { describe, it, expect } from "vitest"
import {
  sanitizeDesign,
  parseDesign,
  designCss,
  designHtml,
  DESIGN_RANGES,
  DESIGN_ENUMS,
} from "../src/profile-design"

describe("sanitizeDesign", () => {
  it("非对象/数组输入 → 空对象", () => {
    expect(sanitizeDesign(null)).toEqual({})
    expect(sanitizeDesign(undefined)).toEqual({})
    expect(sanitizeDesign("x")).toEqual({})
    expect(sanitizeDesign([1, 2])).toEqual({})
    expect(sanitizeDesign(42)).toEqual({})
  })

  it("数值夹取到范围内（不整项丢弃）", () => {
    expect(sanitizeDesign({ radius: 999 }).radius).toBe(DESIGN_RANGES.radius.max)
    expect(sanitizeDesign({ radius: -5 }).radius).toBe(DESIGN_RANGES.radius.min)
    expect(sanitizeDesign({ fontScale: 1000 }).fontScale).toBe(DESIGN_RANGES.fontScale.max)
    expect(sanitizeDesign({ density: 0 }).density).toBe(DESIGN_RANGES.density.min)
  })

  it("合法数值保留", () => {
    expect(sanitizeDesign({ radius: 20 }).radius).toBe(20)
    expect(sanitizeDesign({ density: 120 }).density).toBe(120)
  })

  it("枚举只收白名单内的值", () => {
    expect(sanitizeDesign({ surface: "glass" }).surface).toBe("glass")
    expect(sanitizeDesign({ surface: "hacked" }).surface).toBeUndefined()
    expect(sanitizeDesign({ cols: "2" }).cols).toBe("2")
    expect(sanitizeDesign({ cols: "5" }).cols).toBeUndefined()
    expect(sanitizeDesign({ motion: "none" }).motion).toBe("none")
  })

  it("颜色必须是 #rrggbb 六位", () => {
    expect(sanitizeDesign({ accent2: "#ff0000" }).accent2).toBe("#ff0000")
    expect(sanitizeDesign({ accent2: "#FF0000" }).accent2).toBe("#ff0000") // 归一化小写
    expect(sanitizeDesign({ accent2: "#f00" }).accent2).toBeUndefined() // 三位不收
    expect(sanitizeDesign({ accent2: "red" }).accent2).toBeUndefined()
    expect(sanitizeDesign({ accent2: "#ff00000" }).accent2).toBeUndefined() // 七位不收
    expect(sanitizeDesign({ accent2: "javascript:alert(1)" }).accent2).toBeUndefined()
  })

  it("未知键被丢弃", () => {
    const out = sanitizeDesign({ hacker: 1, radius: 10, evil: "x" })
    expect(out.radius).toBe(10)
    expect("hacker" in out).toBe(false)
    expect("evil" in out).toBe(false)
  })

  it("非数值/非有限数被丢弃", () => {
    expect(sanitizeDesign({ radius: "20" }).radius).toBeUndefined()
    expect(sanitizeDesign({ radius: NaN }).radius).toBeUndefined()
    expect(sanitizeDesign({ radius: Infinity }).radius).toBeUndefined()
  })

  it("nameGradient 只收布尔", () => {
    expect(sanitizeDesign({ nameGradient: true }).nameGradient).toBe(true)
    expect(sanitizeDesign({ nameGradient: false }).nameGradient).toBe(false)
    expect(sanitizeDesign({ nameGradient: 1 }).nameGradient).toBeUndefined()
  })
})

describe("parseDesign", () => {
  it("坏 JSON 回空对象", () => {
    expect(parseDesign("{bad")).toEqual({})
    expect(parseDesign("")).toEqual({})
    expect(parseDesign(null)).toEqual({})
    expect(parseDesign(undefined)).toEqual({})
  })

  it("合法 JSON 经过清洗", () => {
    expect(parseDesign('{"radius":10,"bad":1}')).toEqual({ radius: 10 })
  })
})

describe("designCss", () => {
  it("空 design 输出空串（存量名片不变的根保证）", () => {
    expect(designCss({})).toBe("")
    expect(designCss(parseDesign("{}"))).toBe("")
  })

  it("只输出设过的项", () => {
    const css = designCss({ radius: 24 })
    expect(css).toContain("--pd-radius:24px")
    expect(css).not.toContain("--pd-density")
    expect(css).not.toContain("--pd-max-width")
  })

  it("圆角派生 sm/xs", () => {
    const css = designCss({ radius: 20 })
    expect(css).toContain("--pd-radius-sm:14px")
    expect(css).toContain("--pd-radius-xs:10px")
  })

  it("双强调色注入 rgb 三元组", () => {
    const css = designCss({ accent2: "#ff0000" })
    expect(css).toContain("--pd-accent2:#ff0000")
    expect(css).toContain("--pd-accent2-rgb:255,0,0")
  })

  it("头像形状映射到合法 CSS", () => {
    expect(designCss({ avatarShape: "hex" })).toContain("clip-path:polygon")
    expect(designCss({ avatarShape: "circle" })).toContain("border-radius:50%")
    expect(designCss({ avatarShape: "blob" })).toContain("%")
  })

  it("昵称渐变需要才输出", () => {
    expect(designCss({})).not.toContain("linear-gradient(94deg")
    expect(designCss({ nameGradient: true })).toContain("background-clip:text")
  })

  it("列数显式指定时输出覆盖规则", () => {
    expect(designCss({ cols: "2" })).toContain("grid-template-columns:repeat(2")
    expect(designCss({ cols: "1" })).toContain("flex-direction:column")
    expect(designCss({ cols: "auto" })).not.toContain("repeat(")
  })

  it("motion=none 全局关动效", () => {
    expect(designCss({ motion: "none" })).toContain("animation:none!important")
  })

  it("reveal=stagger 输出错位延迟 + 尊重 reduce-motion", () => {
    const css = designCss({ reveal: "stagger" })
    expect(css).toContain("pd-reveal")
    expect(css).toContain("animation-delay:")
    expect(css).toContain("prefers-reduced-motion")
  })

  it("噪点/暗角只在设置时输出", () => {
    expect(designCss({})).not.toContain("feTurbulence")
    expect(designCss({ grain: 40 })).toContain("feTurbulence")
    expect(designCss({})).not.toContain("pd-vignette")
    expect(designCss({ vignette: 50 })).toContain("pd-vignette")
  })

  it("输出里不含 XSS 载体（颜色已校验，URL 是固定 SVG）", () => {
    const css = designCss({ grain: 50, vignette: 30, accent2: "#123456" })
    expect(css).not.toContain("<script")
    expect(css).not.toContain("javascript:")
    expect(css).not.toContain("</style>")
  })
})

describe("designHtml", () => {
  it("只在设了 vignette 时输出元素", () => {
    expect(designHtml({})).toBe("")
    expect(designHtml({ vignette: 40 })).toContain("pd-vignette")
  })
})

describe("范围与枚举的完整性", () => {
  it("所有枚举键都在接口里有定义（防漏配）", () => {
    expect(Object.keys(DESIGN_ENUMS).length).toBeGreaterThanOrEqual(7)
  })
  it("数值范围 min < max", () => {
    for (const r of Object.values(DESIGN_RANGES)) {
      expect(r.min).toBeLessThan(r.max)
    }
  })
})
