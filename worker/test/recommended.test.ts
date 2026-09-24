import { describe, it, expect } from "vitest"
import { sanitizeRecommendedModels, parseRecommendedModels } from "../src/settings"

describe("推荐模型分档清洗", () => {
  it("保留合法分档与顺序", () => {
    const r = sanitizeRecommendedModels([
      { tier: "第一梯队", desc: "综合最强", models: ["glm-5.2", "deepseek-v4-pro"] },
      { tier: "第二梯队", desc: "", models: ["kimi-k3"] },
    ])
    expect(r.length).toBe(2)
    expect(r[0].tier).toBe("第一梯队")
    expect(r[0].models).toEqual(["glm-5.2", "deepseek-v4-pro"])
  })

  it("丢弃空梯队名 / 无模型的梯队", () => {
    const r = sanitizeRecommendedModels([
      { tier: "", models: ["a"] },
      { tier: "有名字但没模型", models: [] },
      { tier: "   ", models: ["b"] },
      { tier: "正常", models: ["c"] },
    ])
    expect(r.length).toBe(1)
    expect(r[0].tier).toBe("正常")
  })

  it("非数组输入 → 空", () => {
    expect(sanitizeRecommendedModels(null).length).toBe(0)
    expect(sanitizeRecommendedModels("{}").length).toBe(0)
    expect(sanitizeRecommendedModels(undefined).length).toBe(0)
  })

  it("模型名去空白并丢弃空串", () => {
    const r = sanitizeRecommendedModels([
      { tier: "T", models: [" a ", "", "   ", "b"] },
    ])
    expect(r[0].models).toEqual(["a", "b"])
  })

  it("上限：8 个梯队 / 每档 30 个模型", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      tier: `T${i}`,
      models: Array.from({ length: 50 }, (_, j) => `m${j}`),
    }))
    const r = sanitizeRecommendedModels(many)
    expect(r.length).toBe(8)
    expect(r[0].models.length).toBe(30)
  })

  it("梯队名与描述按长度截断", () => {
    const r = sanitizeRecommendedModels([
      { tier: "梯".repeat(50), desc: "说".repeat(500), models: ["m"] },
    ])
    expect(r[0].tier.length).toBe(20)
    expect(r[0].desc.length).toBe(120)
  })

  it("parseRecommendedModels 坏 JSON → 空", () => {
    expect(parseRecommendedModels("{oops").length).toBe(0)
    expect(parseRecommendedModels(null).length).toBe(0)
    expect(parseRecommendedModels("").length).toBe(0)
  })

  it("parseRecommendedModels 正常往返", () => {
    const raw = JSON.stringify([{ tier: "第一梯队", desc: "x", models: ["m1"] }])
    const r = parseRecommendedModels(raw)
    expect(r.length).toBe(1)
    expect(r[0].models).toEqual(["m1"])
  })
})
