// 公开名片页的链接拼接 —— 重点是 B 站。
//
// 背景（用户实测报的 bug）：card.doulor.cn 上的 B 站按钮跳到了
//   https://space.bilibili.com/UID%3A1307574205
// 原因是联系方式的值里存着 "UID:1307574205"（用户照着提示词填的），
// 而渲染层直接 encodeURIComponent，冒号变成 %3A → B 站 404。
//
// 这里锁定「值 → 链接」的归一化行为：容忍前缀与整条链接，
// 但认不出数字 UID 时**不给链接**（宁可不可点，也不要指向陌生人主页）。
import { describe, it, expect } from "vitest"
import { renderProfileHtml } from "../src/profile-page"
import type { PublicProfile } from "../src/handlers/profile"

/** 只留一个联系方式模块的最小名片 */
function profileWith(value: string, label?: string): PublicProfile {
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
    contacts: [{ type: "bilibili", value, label, visible: true }],
    modules: [{ id: "links", enabled: true }],
    registeredAt: null,
    viewCount: 0,
  }
}

/** 取出渲染结果里所有指向 bilibili 的 href */
function bilibiliHrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*space\.bilibili\.com[^"]*)"/g)].map((m) => m[1])
}

describe("名片 B 站链接", () => {
  it("纯数字 UID → 正常链接", () => {
    const hrefs = bilibiliHrefs(renderProfileHtml(profileWith("1307574205")))
    expect(hrefs).toEqual(["https://space.bilibili.com/1307574205"])
  })

  it("带 UID: 前缀（线上实际存的值）→ 剥掉前缀", () => {
    const hrefs = bilibiliHrefs(renderProfileHtml(profileWith("UID:1307574205")))
    expect(hrefs).toEqual(["https://space.bilibili.com/1307574205"])
  })

  it("大小写 / 空格混杂的 uid: 前缀也能剥掉", () => {
    for (const v of ["uid: 1307574205", "UID :1307574205", "  Uid:  1307574205  "]) {
      expect(bilibiliHrefs(renderProfileHtml(profileWith(v)))).toEqual([
        "https://space.bilibili.com/1307574205",
      ])
    }
  })

  it("整条空间链接 → 只取 UID，不再二次编码", () => {
    const hrefs = bilibiliHrefs(
      renderProfileHtml(profileWith("https://space.bilibili.com/1307574205"))
    )
    expect(hrefs).toEqual(["https://space.bilibili.com/1307574205"])
  })

  it("认不出 UID 时不给链接（避免跳到陌生人主页）", () => {
    for (const v of ["uUID: uid:4", "某用户", "abc123", "1307574205/extra"]) {
      const html = renderProfileHtml(profileWith(v))
      expect(bilibiliHrefs(html)).toEqual([])
      // 值本身仍要展示出来，不能凭空消失
      expect(html).toContain("Bilibili")
    }
  })

  it("自定义 label 优先于自动生成的文字", () => {
    const html = renderProfileHtml(profileWith("1307574205", "我的 B 站"))
    expect(html).toContain("我的 B 站")
    expect(html).not.toContain("Bilibili 1307574205")
  })

  it("其它平台的链接拼接未被波及（回归护栏）", () => {
    const p = profileWith("1307574205")
    p.contacts = [
      { type: "telegram", value: "@doulor", visible: true },
      { type: "github", value: "Doulor", visible: true },
    ]
    const html = renderProfileHtml(p)
    expect(html).toContain('href="https://t.me/doulor"')
    expect(html).toContain('href="https://github.com/Doulor"')
  })
})
