import { describe, it, expect } from "vitest"
import { validateNicknameFormat, NICKNAME_RESERVED } from "../src/identity"

describe("validateNicknameFormat", () => {
  it("accepts 2-16 chars of CJK/latin/digit/underscore", () => {
    expect(validateNicknameFormat("阿豆")).toBe(true)
    expect(validateNicknameFormat("test_2")).toBe(true)
    expect(validateNicknameFormat("a")).toBe(false)       // 太短
    expect(validateNicknameFormat("a".repeat(17))).toBe(false) // 太长
    expect(validateNicknameFormat("带 空格")).toBe(false)
    expect(validateNicknameFormat("emoji😀")).toBe(false)
  })
  it("rejects reserved words (case-insensitive) and any containing doulor", () => {
    expect(NICKNAME_RESERVED.has("管理员")).toBe(true)
    expect(validateNicknameFormat("站长")).toBe(false)
    expect(validateNicknameFormat("Admin")).toBe(false)
    expect(validateNicknameFormat("doulor官方")).toBe(false) // 含 doulor
    expect(validateNicknameFormat("我的doulor")).toBe(false)
  })
})
