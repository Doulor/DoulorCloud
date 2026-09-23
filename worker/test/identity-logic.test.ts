import { describe, it, expect } from "vitest"
import {
  validateNicknameFormat,
  isReservedNickname,
  parseReservedNicknames,
  NICKNAME_RESERVED_BASE,
} from "../src/identity"

describe("validateNicknameFormat", () => {
  it("accepts 2-16 chars of CJK/latin/digit/underscore", () => {
    expect(validateNicknameFormat("阿豆")).toBe(true)
    expect(validateNicknameFormat("test_2")).toBe(true)
    expect(validateNicknameFormat("a")).toBe(false) // 太短
    expect(validateNicknameFormat("a".repeat(17))).toBe(false) // 太长
    expect(validateNicknameFormat("带 空格")).toBe(false)
    expect(validateNicknameFormat("emoji😀")).toBe(false)
  })
  it("只校验格式，不查保留词（保留词由 isReservedNickname 负责）", () => {
    // 格式合法但属保留词：format 仍返回 true
    expect(validateNicknameFormat("Admin")).toBe(true)
    expect(validateNicknameFormat("站长")).toBe(true)
  })
})

describe("isReservedNickname", () => {
  it("基础保留词命中（大小写不敏感）", () => {
    expect(NICKNAME_RESERVED_BASE.has("admin")).toBe(true)
    expect(isReservedNickname("Admin")).toBe(true)
    expect(isReservedNickname("站长")).toBe(true)
  })
  it("含 doulor 恒禁（即便管理员）", () => {
    expect(isReservedNickname("doulor官方")).toBe(true)
    expect(isReservedNickname("我的doulor")).toBe(true)
    // 管理员也禁
    expect(isReservedNickname("doulor官方", new Set(), true)).toBe(true)
  })
  it("管理员跳过保留词（但 doulor 仍禁）", () => {
    expect(isReservedNickname("Admin", new Set(), true)).toBe(false)
    expect(isReservedNickname("站长", new Set(), true)).toBe(false)
  })
  it("附加保留词（管理员配置的）对普通用户生效，管理员跳过", () => {
    const extra = parseReservedNicknames("小助手, mod2")
    expect(extra.has("小助手")).toBe(true)
    expect(isReservedNickname("小助手", extra)).toBe(true)
    expect(isReservedNickname("Mod2", extra)).toBe(true) // 大小写不敏感
    // 管理员不受附加保留词限制
    expect(isReservedNickname("小助手", extra, true)).toBe(false)
  })
})
