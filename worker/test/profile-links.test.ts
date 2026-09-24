// 公开名片页的联系方式链接拼接。
//
// 背景（用户实测报的 bug）：card.doulor.cn 上的 B 站按钮跳到了
//   https://space.bilibili.com/UID%3A1307574205
// 值里存的是 "UID:1307574205"（用户照提示词填的），渲染层直接 encodeURIComponent，
// 冒号变成 %3A → B 站 404。
//
// 排查时发现这不是 B 站独有的问题：telegram / github / x / discord / youtube
// 都只对「完整 URL」做了判断，其余直接拼前缀，于是任何带前缀或带域名的输入
// 都会拼出打不开的链接（如 https://t.me/https%3A%2F%2Ft.me%2FDoulor）。
//
// 现在统一走 bareId() 归一化成裸标识；识别不出来的**不给链接**，
// 只渲染成不可点的文本 —— 宁可不可点，也别把访客引到陌生人主页。
import { describe, it, expect } from "vitest"
import { renderProfileHtml } from "../src/profile-page"
import type { Contact, PublicProfile } from "../src/handlers/profile"

/** 只留一个联系方式模块的最小名片 */
function profileWith(contacts: Contact[]): PublicProfile {
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
    avatar: null,
    background: null,
    music: null,
    musicCover: null,
    musicTitle: null,
    musicAutoplay: false,
    contacts,
    modules: [{ id: "links", enabled: true }],
    registeredAt: null,
    viewCount: 0,
  }
}

/** 渲染单个联系方式，取出它的 href（无链接时为 null） */
function hrefOf(type: Contact["type"], value: string, label?: string): string | null {
  const html = renderProfileHtml(profileWith([{ type, value, label, visible: true }]))
  const nav = html.match(/<nav class="links">([\s\S]*?)<\/nav>/)
  if (!nav) throw new Error("未渲染出联系方式模块")
  const m = nav[1].match(/<a class="link" href="([^"]*)"/)
  return m ? m[1] : null
}

/** 渲染单个联系方式，取出它的显示文字 */
function labelOf(type: Contact["type"], value: string, label?: string): string {
  const html = renderProfileHtml(profileWith([{ type, value, label, visible: true }]))
  const m = html.match(/<span class="t">([\s\S]*?)<\/span>/)
  return m ? m[1] : ""
}

describe("Bilibili", () => {
  it("纯数字 UID → 正常链接", () => {
    expect(hrefOf("bilibili", "1307574205")).toBe("https://space.bilibili.com/1307574205")
  })

  it("带 UID: 前缀（线上实际存的值）→ 剥掉前缀", () => {
    expect(hrefOf("bilibili", "UID:1307574205")).toBe("https://space.bilibili.com/1307574205")
  })

  it("大小写 / 空格混杂的前缀、全角冒号都能剥掉", () => {
    for (const v of ["uid: 1307574205", "UID :1307574205", "  Uid:  1307574205  ", "UID：1307574205"]) {
      expect(hrefOf("bilibili", v)).toBe("https://space.bilibili.com/1307574205")
    }
  })

  it("整条空间链接（带/不带协议）→ 只取 UID", () => {
    for (const v of [
      "https://space.bilibili.com/1307574205",
      "space.bilibili.com/1307574205",
      "https://space.bilibili.com/1307574205/",
    ]) {
      expect(hrefOf("bilibili", v)).toBe("https://space.bilibili.com/1307574205")
    }
  })

  it("b23.tv 短链无法在服务端还原成 UID → 不给链接", () => {
    expect(hrefOf("bilibili", "https://b23.tv/abc123")).toBeNull()
  })

  it("「Bilibili: 1307574205」这种前缀标签也能剥掉", () => {
    expect(hrefOf("bilibili", "Bilibili: 1307574205")).toBe(
      "https://space.bilibili.com/1307574205"
    )
  })

  it("认不出 UID 时不给链接（避免跳到陌生人主页）", () => {
    for (const v of ["某用户", "abc123", "uUID: uid:4"]) {
      expect(hrefOf("bilibili", v)).toBeNull()
      // 值本身仍要展示出来，不能凭空消失
      expect(labelOf("bilibili", v)).toContain("Bilibili")
    }
  })
})

describe("Telegram", () => {
  it("裸 handle / @handle 都能用", () => {
    expect(hrefOf("telegram", "Doulor")).toBe("https://t.me/Doulor")
    expect(hrefOf("telegram", "@Doulor")).toBe("https://t.me/Doulor")
  })

  it("整条链接（修复前会拼成 https://t.me/https%3A%2F%2F...）", () => {
    expect(hrefOf("telegram", "https://t.me/Doulor")).toBe("https://t.me/Doulor")
    expect(hrefOf("telegram", "t.me/Doulor")).toBe("https://t.me/Doulor")
    expect(hrefOf("telegram", "https://telegram.me/Doulor")).toBe("https://t.me/Doulor")
  })

  it("「Telegram: @Doulor」这类前缀标签", () => {
    expect(hrefOf("telegram", "Telegram: @Doulor")).toBe("https://t.me/Doulor")
    expect(hrefOf("telegram", "Telegram：@Doulor")).toBe("https://t.me/Doulor")
  })
})

describe("GitHub", () => {
  it("裸用户名 / @用户名", () => {
    expect(hrefOf("github", "Doulor")).toBe("https://github.com/Doulor")
    expect(hrefOf("github", "@Doulor")).toBe("https://github.com/Doulor")
  })

  it("整条链接（含带仓库路径的）", () => {
    expect(hrefOf("github", "https://github.com/Doulor")).toBe("https://github.com/Doulor")
    expect(hrefOf("github", "github.com/Doulor")).toBe("https://github.com/Doulor")
    expect(hrefOf("github", "https://github.com/Doulor/repo")).toBe("https://github.com/Doulor")
  })

  it("填了别的站点地址 → 不给链接（不拼出 github.com/example.com）", () => {
    expect(hrefOf("github", "https://gitlab.com/foo")).toBeNull()
    expect(hrefOf("github", "example.com/foo")).toBeNull()
  })
})

describe("X / Twitter", () => {
  it("裸 handle / @handle / 整条链接", () => {
    expect(hrefOf("x", "foo")).toBe("https://x.com/foo")
    expect(hrefOf("x", "@foo")).toBe("https://x.com/foo")
    expect(hrefOf("x", "https://x.com/foo")).toBe("https://x.com/foo")
    expect(hrefOf("x", "x.com/foo")).toBe("https://x.com/foo")
  })

  it("twitter.com 的链接归一到 x.com", () => {
    expect(hrefOf("x", "https://twitter.com/foo")).toBe("https://x.com/foo")
    expect(hrefOf("x", "twitter.com/foo")).toBe("https://x.com/foo")
  })
})

describe("Discord", () => {
  it("裸邀请码 / discord.gg 链接 / discord.com/invite 链接", () => {
    expect(hrefOf("discord", "abc123")).toBe("https://discord.gg/abc123")
    expect(hrefOf("discord", "https://discord.gg/abc123")).toBe("https://discord.gg/abc123")
    expect(hrefOf("discord", "discord.gg/abc123")).toBe("https://discord.gg/abc123")
    expect(hrefOf("discord", "https://discord.com/invite/abc123")).toBe(
      "https://discord.gg/abc123"
    )
  })
})

describe("YouTube", () => {
  it("整条 youtube.com 链接原样采用（/channel/ 与 /@handle 都合法）", () => {
    expect(hrefOf("youtube", "https://www.youtube.com/@foo")).toBe("https://www.youtube.com/@foo")
    expect(hrefOf("youtube", "youtube.com/@foo")).toBe("https://www.youtube.com/@foo")
    expect(hrefOf("youtube", "https://youtube.com/channel/UCabc")).toBe(
      "https://www.youtube.com/channel/UCabc"
    )
  })

  it("裸 handle 补成 /@handle", () => {
    expect(hrefOf("youtube", "@foo")).toBe("https://youtube.com/@foo")
    expect(hrefOf("youtube", "foo")).toBe("https://youtube.com/@foo")
  })

  it("youtu.be 视频短链不给链接（转成频道地址必然错）", () => {
    expect(hrefOf("youtube", "https://youtu.be/dQw4w9WgXcQ")).toBeNull()
  })
})

describe("QQ", () => {
  it("纯数字号 → 头像 API", () => {
    expect(hrefOf("qq", "2737855297")).toBe("https://res.abeim.cn/api/qq/?qq=2737855297")
  })

  it("「QQ: 123」前缀标签剥掉（修复前会把冒号编码进 qq 参数）", () => {
    expect(hrefOf("qq", "QQ: 2737855297")).toBe(
      "https://res.abeim.cn/api/qq/?qq=2737855297"
    )
  })

  it("非数字不给链接", () => {
    expect(hrefOf("qq", "not-a-number")).toBeNull()
    expect(hrefOf("qq", "user.qzone.qq.com/2737855297")).toBeNull()
  })
})

describe("邮箱 / 微信 / 自定义", () => {
  it("邮箱支持 mailto: 前缀，非法地址不给链接", () => {
    expect(hrefOf("email", "a@doulor.cn")).toBe("mailto:a@doulor.cn")
    expect(hrefOf("email", "mailto:a@doulor.cn")).toBe("mailto:a@doulor.cn")
    expect(hrefOf("email", "不是邮箱")).toBeNull()
  })

  it("微信只支持图片链接（无个人主页可跳转）", () => {
    expect(hrefOf("wechat", "AIDoulor")).toBeNull()
    expect(hrefOf("wechat", "https://example.com/qr.png")).toBe("https://example.com/qr.png")
  })

  it("自定义链接只接受完整 URL", () => {
    expect(hrefOf("custom", "https://example.com")).toBe("https://example.com")
    expect(hrefOf("custom", "example.com")).toBeNull()
    expect(hrefOf("custom", "javascript:alert(1)")).toBeNull()
  })
})

describe("显示文字", () => {
  it("自定义 label 优先于自动生成的文字", () => {
    expect(labelOf("bilibili", "1307574205", "我的 B 站")).toBe("我的 B 站")
    expect(labelOf("telegram", "Doulor", "找我")).toBe("找我")
  })

  it("自动文字用归一化后的值，不是原始脏值", () => {
    expect(labelOf("bilibili", "UID:1307574205")).toBe("Bilibili 1307574205")
    expect(labelOf("telegram", "https://t.me/Doulor")).toBe("Telegram @Doulor")
  })
})

describe("多平台混排（回归护栏）", () => {
  it("一条名片里的多个平台互不干扰", () => {
    const html = renderProfileHtml(
      profileWith([
        { type: "github", value: "Doulor", visible: true },
        { type: "telegram", value: "@doulor", visible: true },
        { type: "bilibili", value: "UID:1307574205", visible: true },
        { type: "qq", value: "QQ: 2737855297", visible: true },
      ])
    )
    expect(html).toContain('href="https://github.com/Doulor"')
    expect(html).toContain('href="https://t.me/doulor"')
    expect(html).toContain('href="https://space.bilibili.com/1307574205"')
    expect(html).toContain('href="https://res.abeim.cn/api/qq/?qq=2737855297"')
    // 不该出现任何被二次编码的痕迹
    expect(html).not.toContain("%3A")
    expect(html).not.toContain("%2F")
  })
})
