import { describe, it, expect } from "vitest"
import { tierFor, accountLimitFor, POINTS_PER_TIER, MAX_TIER } from "../src/api-engine"

describe("tierFor（成就点 → 层级）", () => {
  it("每 10 点一层", () => {
    expect(tierFor(0)).toBe(0)
    expect(tierFor(9)).toBe(0)
    expect(tierFor(10)).toBe(1)
    expect(tierFor(19)).toBe(1)
    expect(tierFor(20)).toBe(2)
    expect(tierFor(99)).toBe(9)
  })

  it("封顶 MAX_TIER，超出都按最高层", () => {
    expect(tierFor(100)).toBe(10)
    expect(tierFor(150)).toBe(MAX_TIER)
    expect(tierFor(1000)).toBe(MAX_TIER)
  })
})

describe("accountLimitFor（层级 → 账号每日限额）", () => {
  const limits = [10, 20, 30, 40]

  it("正常取对应层级", () => {
    expect(accountLimitFor(0, limits)).toBe(10)
    expect(accountLimitFor(2, limits)).toBe(30)
  })

  it("超出数组长度用最后一项", () => {
    expect(accountLimitFor(3, limits)).toBe(40)
    expect(accountLimitFor(10, limits)).toBe(40)
  })

  it("空数组返回 0（未配置 = 不给额度）", () => {
    expect(accountLimitFor(0, [])).toBe(0)
  })
})

describe("POINTS_PER_TIER / MAX_TIER 常量", () => {
  it("每 10 点一层、封顶 10 层", () => {
    expect(POINTS_PER_TIER).toBe(10)
    expect(MAX_TIER).toBe(10)
  })
})
