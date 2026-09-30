// `LIKE` 模式长度护栏。
//
// 为什么值得单独测：D1 的 SQLite 把 `LIKE` 模式限制在 **50 字符**，超过直接报
//   LIKE or GLOB pattern too complex: SQLITE_ERROR [code: 7500]
// 而且只有**线上**才会暴露（本地 miniflare 用的是标准 SQLite，上限 50000）。
// 2026-09-30 的线上事故就是这么来的：捐款提交时拼 `payload LIKE '%"baseUrl":"<地址>"%'`，
// 地址一过 35 字符就 500，且**连单子都进不了库**，管理端完全看不到痕迹。
//
// 所以这里锁住「任何输入都不能让模式超过上限」这条硬约束 ——
// 它是本地唯一能验证的部分。
import { describe, it, expect } from "vitest"
import { LIKE_PATTERN_MAX, likeContains, likeStartsWith } from "../src/sql-like"

describe("LIKE 模式长度护栏", () => {
  it("上限就是 D1 实测的 50（50 通过 / 51 失败）", () => {
    expect(LIKE_PATTERN_MAX).toBe(50)
  })

  it("超长输入会被截断，模式永远不超过上限", () => {
    // 分别用 ASCII / 中文 / emoji 构造超长输入
    const long = [
      "a".repeat(500),
      "测".repeat(500),
      "https://opc.fiime.cn/api/model-service" + "/x".repeat(50),
      "🙂".repeat(200),
    ]
    for (const input of long) {
      expect(likeContains(input).length, `contains: ${input.slice(0, 20)}…`).toBeLessThanOrEqual(
        LIKE_PATTERN_MAX
      )
      expect(
        likeStartsWith(input).length,
        `startsWith: ${input.slice(0, 20)}…`
      ).toBeLessThanOrEqual(LIKE_PATTERN_MAX)
    }
  })

  it("短输入原样包两侧 `%`（不改变匹配语义）", () => {
    expect(likeContains("abc")).toBe("%abc%")
    expect(likeStartsWith("donation.")).toBe("donation.%")
  })

  it("空输入按原样包 `%` —— 「空搜索 = 匹配一切」由调用方判空来避免", () => {
    // 这里刻意不做特殊处理：各调用点都是 `if (query)` / `if (action)` 才拼 LIKE 条件，
    // 真传空串说明上游漏了判空，让 SQL 暴露出来比悄悄改语义好排查。
    expect(likeContains("")).toBe("%%")
    expect(likeStartsWith("")).toBe("%")
  })
})
