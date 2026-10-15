/**
 * 集合投票（问卷）核心逻辑单测。
 * 跑：cd worker && npx vitest run test/event-quiz.test.ts
 */
import { describe, expect, it } from "vitest"
import {
  MAX_QUIZ_QUESTIONS,
  parseQuizConfig,
  pickQuizTier,
  quizLinearPoints,
  quizScorePercent,
  type QuizTier,
} from "../src/event-rewards"

const q = (id: string, correct: string, opts = ["a", "b", "c"]) => ({
  id,
  title: `题干 ${id}`,
  options: opts.map((o) => ({ id: o, label: `选项 ${o}` })),
  correctOptionId: correct,
})

describe("parseQuizConfig", () => {
  it("接受合法配置，并按高到低排档", () => {
    const c = parseQuizConfig({
      questions: [q("q1", "a"), q("q2", "b")],
      retake: "best",
      reveal: "immediate",
      scoring: {
        kind: "tiers",
        tiers: [
          { minPercent: 60, rewardType: "points", params: { amount: 10 } },
          { minPercent: 90, rewardType: "points", params: { amount: 50 } },
        ],
      },
      timeLimit: { totalSec: 300 },
    })
    expect(c).not.toBeNull()
    expect(c!.questions).toHaveLength(2)
    expect(c!.retake).toBe("best")
    expect(c!.reveal).toBe("immediate")
    expect(c!.scoring.kind).toBe("tiers")
    if (c!.scoring.kind === "tiers") {
      // ⚠️ 顺序必须高→低，否则「第一个满足」会取到低档，发少
      expect(c!.scoring.tiers.map((t) => t.minPercent)).toEqual([90, 60])
    }
    expect(c!.timeLimit).toEqual({ totalSec: 300, perQuestionSec: undefined })
  })

  it("缺省策略：retake=once、reveal=afterDeadline、不限时", () => {
    const c = parseQuizConfig({
      questions: [q("q1", "a")],
      scoring: { kind: "tiers", tiers: [{ minPercent: 0, rewardType: "points", params: { amount: 1 } }] },
    })
    expect(c!.retake).toBe("once")
    expect(c!.reveal).toBe("afterDeadline")
    expect(c!.timeLimit).toBeNull()
  })

  it("非法一律拒绝（宁可拒绝写入，也不要出现「答对判错」）", () => {
    const ok = { kind: "tiers", tiers: [{ minPercent: 0, rewardType: "points", params: { amount: 1 } }] }
    expect(parseQuizConfig(null)).toBeNull()
    expect(parseQuizConfig({ scoring: ok })).toBeNull() // 没题目
    expect(parseQuizConfig({ questions: [], scoring: ok })).toBeNull()
    // 选项少于 2 个
    expect(parseQuizConfig({ questions: [{ ...q("q1", "a"), options: [{ id: "a", label: "A" }] }], scoring: ok })).toBeNull()
    // 正确答案不在选项里 —— 这道题会永远答不对
    expect(parseQuizConfig({ questions: [{ ...q("q1", "a"), correctOptionId: "zzz" }], scoring: ok })).toBeNull()
    // 题干为空
    expect(parseQuizConfig({ questions: [{ ...q("q1", "a"), title: "  " }], scoring: ok })).toBeNull()
    // 🔴 档位**缺 amount**（例如字段名写成 points）必须拒绝 —— 否则要等到发奖那一刻
    // 才失败，用户看到"奖励发放失败"，站长完全不知道是自己参数名写错了（实测踩过）
    expect(
      parseQuizConfig({
        questions: [q("q1", "a")],
        scoring: { kind: "tiers", tiers: [{ minPercent: 10, rewardType: "points", params: { points: 2 } }] },
      })
    ).toBeNull()
    // 区间 min/max 是合法的另一种写法，不能被误拒
    expect(
      parseQuizConfig({
        questions: [q("q1", "a")],
        scoring: { kind: "tiers", tiers: [{ minPercent: 10, rewardType: "points", params: { min: 1, max: 3 } }] },
      })
    ).not.toBeNull()
    // 奖励类型不认识
    expect(parseQuizConfig({ questions: [q("q1", "a")], scoring: { kind: "tiers", tiers: [{ minPercent: 10, rewardType: "wat" }] } })).toBeNull()
    // 分档为空
    expect(parseQuizConfig({ questions: [q("q1", "a")], scoring: { kind: "tiers", tiers: [] } })).toBeNull()
    // 线性：maxPoints 必须为正
    expect(parseQuizConfig({ questions: [q("q1", "a")], scoring: { kind: "linear", maxPoints: 0 } })).toBeNull()
  })

  it("题目数量封顶", () => {
    const many = Array.from({ length: MAX_QUIZ_QUESTIONS + 5 }, (_, i) => q(`q${i}`, "a"))
    const c = parseQuizConfig({ questions: many, scoring: { kind: "linear", maxPoints: 10 } })
    expect(c!.questions).toHaveLength(MAX_QUIZ_QUESTIONS)
  })

  it("重复题目 id 去重", () => {
    const c = parseQuizConfig({
      questions: [q("same", "a"), q("same", "b")],
      scoring: { kind: "linear", maxPoints: 10 },
    })
    expect(c!.questions).toHaveLength(1)
  })

  it("线性模式固定为 points，并带上 maxPoints", () => {
    const c = parseQuizConfig({ questions: [q("q1", "a")], scoring: { kind: "linear", maxPoints: 88 } })
    expect(c!.scoring).toEqual({
      kind: "linear",
      maxPoints: 88,
      rewardType: "points",
      params: { amount: 88 },
    })
  })
})

describe("quizScorePercent", () => {
  const qs = [{ id: "q1", correctOptionId: "a" }, { id: "q2", correctOptionId: "b" }, { id: "q3", correctOptionId: "c" }]

  it("按题目总数算（没答的按错）", () => {
    expect(quizScorePercent(qs, { q1: "a", q2: "b", q3: "c" })).toBe(100)
    expect(quizScorePercent(qs, { q1: "a", q2: "b" })).toBe(67) // 2/3
    expect(quizScorePercent(qs, { q1: "a" })).toBe(33) // ⚠️ 只答对一题交卷 ≠ 100%
    expect(quizScorePercent(qs, {})).toBe(0)
    expect(quizScorePercent(qs, { q1: "b", q2: "b", q3: "c" })).toBe(67)
  })

  it("没有题目时为 0（不除零）", () => {
    expect(quizScorePercent([], {})).toBe(0)
  })
})

describe("pickQuizTier / quizLinearPoints", () => {
  const tiers: QuizTier[] = [
    { minPercent: 90, rewardType: "points", params: { amount: 50 } },
    { minPercent: 60, rewardType: "points", params: { amount: 20 } },
    { minPercent: 0, rewardType: "points", params: { amount: 5 } },
  ]

  it("取第一个满足的档（高→低）", () => {
    expect(pickQuizTier(tiers, 100)?.minPercent).toBe(90)
    expect(pickQuizTier(tiers, 90)?.minPercent).toBe(90)
    expect(pickQuizTier(tiers, 89)?.minPercent).toBe(60)
    expect(pickQuizTier(tiers, 0)?.minPercent).toBe(0)
  })

  it("没有满足的档返回 null（比如最低档 > 0 且答对率不够）", () => {
    expect(pickQuizTier([{ minPercent: 50, rewardType: "points", params: { amount: 1 } }], 49)).toBeNull()
  })

  it("线性折算", () => {
    expect(quizLinearPoints(100, 100)).toBe(100)
    expect(quizLinearPoints(100, 0)).toBe(0)
    expect(quizLinearPoints(100, 50)).toBe(50)
    expect(quizLinearPoints(9, 33)).toBe(3) // 2.97 → 3
    // 越界钳制
    expect(quizLinearPoints(100, 150)).toBe(100)
    expect(quizLinearPoints(100, -10)).toBe(0)
  })
})
