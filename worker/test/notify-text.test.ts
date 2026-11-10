// 通知文案消毒（2026-11-10 渗透测试 finding#3）的单元测试。
//
// 这条规则同时被两条通知通道使用：轮询（/api/mailbox/latest-unread）与
// Web Push（收信后 pushToUser）。前端 `src/lib/web-notify.ts` 与 `public/sw.js`
// 里还有同规则的两份兜底 —— 三处必须一致，这里钉住的是服务端这份。
import { describe, it, expect } from "vitest"
import { sanitizeNotifyText } from "../src/notify-text"

describe("sanitizeNotifyText", () => {
  it("控制字符（含换行/回车）换成空格再压缩 —— 通知只显示一行，两行不会粘成一个词", () => {
    expect(sanitizeNotifyText("a\nb\r\nc\td", 100)).toBe("a b c d")
    expect(sanitizeNotifyText("x\u0000y\u001Fz", 100)).toBe("x y z")
  })

  it("零宽 / 双向控制符被删掉（不可见字符能伪造阅读顺序）", () => {
    expect(sanitizeNotifyText("a\u200Bb\u202Ec\uFEFFd", 100)).toBe("abcd")
  })

  it("尖括号被删掉 —— 通知里不该出现任何标记", () => {
    expect(sanitizeNotifyText("<img src=x onerror=alert(1)>", 100)).toBe(
      "img src=x onerror=alert(1)"
    )
  })

  it("连续空白压成单空格并 trim", () => {
    expect(sanitizeNotifyText("  多   空格   与\n\n换行  ", 100)).toBe("多 空格 与 换行")
  })

  it("先消毒、最后截断（超长控制符不会把结果撑爆）", () => {
    expect(sanitizeNotifyText("1234567890", 4)).toBe("1234")
    expect(sanitizeNotifyText(`${"\u0000".repeat(50)}abcdef`, 3)).toBe("abc")
  })

  it("空输入 / 非字符串输入都退化为空串，不抛错", () => {
    expect(sanitizeNotifyText("", 10)).toBe("")
    expect(sanitizeNotifyText(undefined as unknown as string, 10)).toBe("")
    expect(sanitizeNotifyText(null as unknown as string, 10)).toBe("")
    expect(sanitizeNotifyText("abc", -1)).toBe("")
  })
})
