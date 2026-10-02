#!/usr/bin/env node
/**
 * 厂商归类的回归自检：拿线上真实出现过的模型名（以及几组容易认错的边界名）
 * 跑一遍 vendorOf / groupModelsByVendor，看有没有归错组、排序乱掉。
 *
 * 用例不是编的 —— 带 senseNova- / workbuddy- / donation- 前缀的那批就是
 * 「全部可用模型」卡片里实际出现的名字。
 *
 * 用法：node scripts/check-model-vendors.mjs
 */
import assert from "node:assert/strict"
import {
  vendorOf,
  groupModelsByVendor,
  OTHER_VENDOR,
} from "../src/lib/model-vendor.ts"

/** [模型名, 期望厂商] */
const CASES = [
  // ── 默认分组实际出现的名字（渠道前缀 + 真模型名）──
  ["senseNova-deepseek-v4.1-flash", "DeepSeek"],
  ["senseNova-deepseek-flash", "DeepSeek"],
  ["deepseek-v4-pro", "DeepSeek"],
  ["workbuddy-deepseek-v4.1-flash", "DeepSeek"],
  ["workbuddy-global-deepseek-v4.1-flash", "DeepSeek"],
  ["senseNova-kimi-k3", "Moonshot"],
  ["senseNova-glm-5.2", "Zhipu AI"],
  ["workbuddy-glm-5.3", "Zhipu AI"],
  ["workbuddy-glm-5.3-flash", "Zhipu AI"],
  ["senseNova-sensenova-6.8-flash-lite", "SenseTime"],
  ["sensenova-u1-fast", "SenseTime"],
  ["senseNova-u1.5-lite", "SenseTime"],
  ["gpt-oss-120b", "OpenAI"],
  ["Atria-Dawn-Preview", "Shanghai AI Lab"],
  ["workbuddy-hy3", "Tencent"],
  ["workbuddy-hy4-preview-f", "Tencent"],
  ["qwen3.8-27b", "Alibaba"],

  // ── 捐献分组实际出现的名字（大小写、HuggingFace 路径、渠道标注混在一起）──
  ["donation-gemini-3-pro", "Google"],
  ["donation-gemini-3.7-flash", "Google"],
  ["donation-gemini-3.1-flash-image", "Google"],
  ["donation-[OR号池]google/gemma-4-26b-a4b-it", "Google"],
  ["donation-claude-3-7-sonnet-20250219", "Anthropic"],
  ["donation-claude-opus-4-6", "Anthropic"],
  ["donation-claude-sonnet-4-5", "Anthropic"],
  ["donation-gpt-5.6-sol", "OpenAI"],
  ["donation-glm-5.3", "Zhipu AI"],
  ["donation-qwen.qwen3-coder-next", "Alibaba"],
  ["donation-qwen.qwen3-vl-235b-a22b-instruct", "Alibaba"],
  ["donation-qwen3.8-27b", "Alibaba"],
  ["donation-DeepSeek-V4-Flash-0731", "DeepSeek"],
  ["donation-MiniMax-M2.7", "MiniMax"],
  ["donation-muse-spark-1.3", "Meta"],
  ["donation-muse-spark-1.2-contributor-free", "Meta"],
  ["donation-ministral-8b-latest", "Mistral"],
  ["donation-[商汤]kimi-k3", "Moonshot"],
  ["donation-dots-studio/dots-3-note-preview:free", "RedNote"],

  // ── 容易认错的：别家借用了大厂名号，或被大厂名号包含 ──
  ["llama-3.1-nemotron-70b", "NVIDIA"],
  ["meta-llama/Llama-3.3-70B-Instruct", "Meta"],
  ["Nous-Hermes-3-Llama-3.1-405B", "Nous Research"],
  ["mistral-nemo-12b", "Mistral"],
  ["phi-4-mini-instruct", "Microsoft"],
  ["command-r-plus", "Cohere"],
  ["zai-org/GLM-5.2", "Zhipu AI"],
  ["moonshotai/Kimi-K3", "Moonshot"],
  ["inclusionAI/Ling-lite", "Ant Group"],
  ["rednote-hilab/dots.llm1.inst", "RedNote"],
  ["openPangu-2.0-Flash", "Huawei"],
  ["LongCat-2.0", "Meituan"],
  ["MiMo-V2.5-Pro", "Xiaomi"],
  ["BlueLM-7B", "vivo"],
  ["internlm/Atria-Dawn-Preview", "Shanghai AI Lab"],

  // ── 关键词是子串但不能误伤的 ──
  ["sampling-tuner-v1", OTHER_VENDOR], // 不含百灵的 Ling
  ["sparkling-water-1.3", OTHER_VENDOR], // 不含快手的 Kling
  ["string-2-chat", OTHER_VENDOR], // 不含蚂蚁的 Ring
  ["shy4-preview", OTHER_VENDOR], // 不含腾讯的 hy4
  ["seedling-1", OTHER_VENDOR], // 不含字节的 Seed
  ["palmyra-x-004", "Writer"], // \bpalm\b 不该误认成 Google
  ["some-new-model-v9", OTHER_VENDOR],
]

let failed = 0
for (const [model, want] of CASES) {
  const got = vendorOf(model)
  if (got !== want) {
    failed++
    console.error(`  ✗ ${model}\n      期望 ${want}，实得 ${got}`)
  }
}
assert.equal(failed, 0, `有 ${failed} 条归类不对`)

// ── 分组：数量降序、其他垫底、大小写不同的同一模型各归各的 ──
const groups = groupModelsByVendor([
  "donation-gemini-3-pro",
  "donation-Gemini-3.7-flash",
  "donation-deepseek-v4-flash",
  "donation-deepseek-v4-pro",
  "donation-some-unknown-model",
])
assert.deepEqual(
  groups.map((g) => [g.vendor, g.models.length]),
  [
    ["DeepSeek", 2],
    ["Google", 2],
    [OTHER_VENDOR, 1],
  ],
  "分组数量或顺序不对"
)
// 认不出的必须落在最后一组，「其他」不能被数量排序顶到前面去
assert.equal(groups.at(-1).vendor, OTHER_VENDOR, "「其他」没有垫底")

console.log(`厂商归类自检通过：${CASES.length} 条用例 + 分组排序`)
