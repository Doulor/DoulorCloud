/**
 * 聊天图片 key → URL 的还原规则。
 *
 * 为什么单独测这个看似不起眼的小函数（2026-10-06 站长反馈）：
 *   他在聊天室粘贴图片，输入框里出现的是 **`![]()`（空占位符）**。
 *   根因就是这个函数：原先只认 **36 位标准 UUID** 的用户 id，
 *   而线上有历史账号的 id 是 **32 位无横线 hex**（站长本人就是），
 *   匹配失败返回空串 ⇒ 前端插进去的 markdown 没有地址。
 *   同一个规则还用在 `serveChatImage` 的只读校验上，写错会导致「能传不能看」。
 *
 * 这里锁死：两种 id 长度都能还原；非法 key 仍必须返回空串（防路径穿越）。
 */
import { describe, it, expect } from "vitest"
import { chatImageKeyToUrl } from "../src/handlers/chat-upload"

const UUID36 = "6e796efa-0fc7-48e2-896e-4545f9122a4d"
const HEX32 = "e0279e8ed4afea1c6067398c39e4f1eb"
const FILE = "5c31257d-e681-4801-af4e-33f57ec71e49.png"

describe("chatImageKeyToUrl", () => {
  it("36 位标准 UUID 的用户 id（绝大多数账号）", () => {
    const url = chatImageKeyToUrl(`chat/${UUID36}/${FILE}`)
    expect(url).toBe(`/api/chat/image/${UUID36}/${FILE}`)
  })

  it("32 位无横线 hex 的用户 id（早期账号，站长就是）也能还原", () => {
    const url = chatImageKeyToUrl(`chat/${HEX32}/${FILE}`)
    // ⚠️ 回归点：这里以前返回空字符串，导致前端插入 `![]()`
    expect(url).toBe(`/api/chat/image/${HEX32}/${FILE}`)
    expect(url).not.toBe("")
  })

  it("四种扩展名都能还原（含 jpg，因为 jpeg 会被映射成 jpg）", () => {
    for (const ext of ["jpg", "png", "webp", "gif"]) {
      expect(chatImageKeyToUrl(`chat/${HEX32}/abc.${ext}`)).toBe(`/api/chat/image/${HEX32}/abc.${ext}`)
    }
  })

  it("非法 key 一律返回空串（不能拼出越权/穿越 URL）", () => {
    const bad = [
      "",
      "chat/",
      `chat/${HEX32}`, // 缺文件名
      `chat/${HEX32}/`,
      "community/posts/x/y.png", // 别的命名空间
      "chat/../../etc/passwd",
      "chat/short/abc.png", // 用户 id 太短
      `chat/${HEX32}/abc.svg`, // 不在白名单的扩展名
      `chat/${HEX32}/abc.png?x=1`, // 带查询串
      `chat/${HEX32}/sub/abc.png`, // 多一层目录
    ]
    for (const k of bad) {
      expect(chatImageKeyToUrl(k), `「${k}」应为空串`).toBe("")
    }
  })
})
