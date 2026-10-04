import { describe, it, expect } from "vitest"
import {
  parseCheckinMilestones,
  normalizeCheckinMilestones,
  parseCheckinRange,
  milestoneBonusFor,
  nextMilestone,
} from "../src/checkin-config"

describe("parseCheckinMilestones", () => {
  it("一行一个，升序", () => {
    const r = parseCheckinMilestones("30:300\n7:50\n100:1000")
    expect(r.map((m) => m.days)).toEqual([7, 30, 100])
    expect(r[0].points).toBe(50)
  })

  it("分隔符收宽：逗号/分号/顿号/全角冒号都认", () => {
    const r = parseCheckinMilestones("7：50，30=300；100 1000")
    expect(r.map((m) => m.days)).toEqual([7, 30, 100])
  })

  it("非法条目丢弃、同一天去重、天数升序", () => {
    const r = parseCheckinMilestones("7:50\nabc\n0:10\n7:999\n15:20")
    expect(r).toEqual([
      { days: 7, points: 50 },
      { days: 15, points: 20 },
    ])
  })

  it("空值返回空数组", () => {
    expect(parseCheckinMilestones("")).toEqual([])
    expect(parseCheckinMilestones(null)).toEqual([])
  })
})

describe("normalizeCheckinMilestones", () => {
  it("写回规范形式：升序 + 去重 + 一行一个", () => {
    expect(normalizeCheckinMilestones("30:300,7:50,7:999")).toBe("7:50\n30:300")
  })
})

describe("parseCheckinRange", () => {
  it("闭区间正常解析", () => {
    expect(parseCheckinRange("3", "10")).toEqual({ min: 3, max: 10 })
  })

  it("填反了自动扶正", () => {
    expect(parseCheckinRange("10", "3")).toEqual({ min: 3, max: 10 })
  })

  it("相等即固定值", () => {
    expect(parseCheckinRange("5", "5")).toEqual({ min: 5, max: 5 })
  })

  it("非法/负数按 0", () => {
    expect(parseCheckinRange("abc", "-1")).toEqual({ min: 0, max: 0 })
  })
})

describe("milestoneBonusFor / nextMilestone", () => {
  const ms = parseCheckinMilestones("7:50\n30:300")

  it("只发恰好等于当前连续天数那一条", () => {
    expect(milestoneBonusFor(7, ms)).toEqual({ days: 7, points: 50 })
    expect(milestoneBonusFor(8, ms)).toBeNull()
    expect(milestoneBonusFor(30, ms)).toEqual({ days: 30, points: 300 })
  })

  it("下一个里程碑", () => {
    expect(nextMilestone(5, ms)).toEqual({ days: 7, points: 50 })
    expect(nextMilestone(30, ms)).toBeNull()
  })
})
