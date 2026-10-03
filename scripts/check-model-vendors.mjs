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
  sectionOf,
  groupModelsBySection,
  MODALITY_AUDIO,
  MODALITY_IMAGE,
  MODALITY_VIDEO,
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
  ["sensenova-u1-fast", MODALITY_IMAGE], // 商汤 U 系列是图片创作模型，名字里没有 image
  ["senseNova-u1.5-lite", MODALITY_IMAGE],
  ["gpt-oss-120b", "OpenAI"],
  ["Atria-Dawn-Preview", "Shanghai AI Lab"],
  ["workbuddy-hy3", "Tencent"],
  ["workbuddy-hy4-preview-f", "Tencent"],
  ["qwen3.8-27b", "Alibaba"],

  // ── 捐献分组实际出现的名字（大小写、HuggingFace 路径、渠道标注混在一起）──
  ["donation-gemini-3-pro", "Google"],
  ["donation-gemini-3.7-flash", "Google"],
  ["donation-gemini-3.1-flash-image", MODALITY_IMAGE],
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

  // ── 曾经整批落进「其他」的（2026-10 线上清单）──
  // 声音/图片/视频这类非文本模型用厂商自有词命名（senseaudio、agnes、inkling…），
  // 现在按模态归，不再看厂商：名字里带 audio 的就是声音节
  ["donation-senseaudio-asr-stream-1.5-260910", MODALITY_AUDIO],
  ["donation-senseaudio-asr-lite-1.5-260319", MODALITY_AUDIO],
  ["donation-senseaudio-asr-deepthink-1.5-260319", MODALITY_AUDIO],
  ["donation-senseaudio-tts-1.5-260319", MODALITY_AUDIO],
  ["donation-senseaudio-voice-isolation-1.0-260319", MODALITY_AUDIO],
  ["donation-senseaudio-image-2.0-260319", MODALITY_IMAGE],
  ["donation-senseaudio-music-2.0-260626", MODALITY_AUDIO],
  ["donation-senseaudio-sfx-1.0-260626", MODALITY_AUDIO],
  ["donation-SenseAudio-Design-1.0", MODALITY_AUDIO],
  ["donation-sense-text", "SenseTime"],
  ["donation-agnes-2.5-pro", "Agnes AI"],
  ["donation-agnes-3.0-flash-free", "Agnes AI"],
  ["donation-agnes-image-2.1-flash", MODALITY_IMAGE],
  ["donation-agnes-video-2.5-flash", MODALITY_VIDEO],
  ["donation-laguna-s-2.1", "Poolside"],
  ["donation-poolside/laguna-xs-2.1:free", "Poolside"],
  ["donation-inkling-free", "Thinking Machines"],
  ["donation-thinkingmachines/inkling-small:free", "Thinking Machines"],
  ["donation-jev-latest", "TypeSafe AI"],
  ["donation-big-pickle", "OpenCode"],
  ["donation-@cf/pipelcat-ai/smart-turn-v2", MODALITY_AUDIO],
  ["donation-stepaudio-2.5-chat", MODALITY_AUDIO],
  ["donation-step-router-v1", "StepFun"],

  // ── 非文本模型按模态分节，不管厂商 ──
  ["donation-senseaudio-asr-lite-1.5-260319", MODALITY_AUDIO],
  ["donation-senseaudio-tts-1.5-260319", MODALITY_AUDIO],
  ["donation-senseaudio-music-2.0-260626", MODALITY_AUDIO],
  ["donation-senseaudio-sfx-1.0-260626", MODALITY_AUDIO],
  ["donation-senseaudio-voice-isolation-1.0-260319", MODALITY_AUDIO],
  ["donation-senseaudio-s2", MODALITY_AUDIO],
  ["donation-stepaudio-2.5-chat", MODALITY_AUDIO],
  ["donation-@cf/pipelcat-ai/smart-turn-v2", MODALITY_AUDIO],
  ["whisper-large-v3", MODALITY_AUDIO],
  ["donation-agnes-image-2.1-flash", MODALITY_IMAGE],
  ["donation-agnes-image-2.5-flash", MODALITY_IMAGE],
  // 品牌名带 audio、产物却是图：图片规则排在声音之前才不会被拽进声音节
  ["donation-senseaudio-image-2.0-260319", MODALITY_IMAGE],
  ["donation-gemini-3.1-flash-image", MODALITY_IMAGE],
  ["dall-e-3", MODALITY_IMAGE],
  ["seedream-5.0-pro", MODALITY_IMAGE],
  // 商汤 U 系列是图片创作模型，名字里却没有 image
  ["sensenova-u1-fast", MODALITY_IMAGE],
  ["senseNova-u1.5-lite", MODALITY_IMAGE],
  ["donation-agnes-video-2.5-flash", MODALITY_VIDEO],
  ["donation-agnes-video-2.0", MODALITY_VIDEO],
  ["veo-3", MODALITY_VIDEO],
  ["sora-2", MODALITY_VIDEO],
  ["kling-v2-master", MODALITY_VIDEO],
  ["seedance-2.0", MODALITY_VIDEO],

  // 「看得懂」不等于「画得出」：视觉理解模型输出仍是文本，按厂商归
  ["donation-qwen.qwen3-vl-235b-a22b-instruct", "Alibaba"],
  ["gemini-3-pro", "Google"],
  ["donation-agnes-2.5-pro", "Agnes AI"],
  ["donation-agnes-2.0-flash", "Agnes AI"],

  // ── 不是厂商的（网关功能位、匿名预览模型）一律进「其他」──
  ["donation-stealth/space-bunny-alpha", OTHER_VENDOR],
  ["donation-[反代][匿名]space-bunny", OTHER_VENDOR],
  ["donation-space-bunny-free", OTHER_VENDOR],
  ["donation-auto", OTHER_VENDOR],
  ["donation-Auto-Model", OTHER_VENDOR],
  ["donation-Agents-A1", OTHER_VENDOR],
  ["donation-translation1", OTHER_VENDOR],
  ["donation-translation3", OTHER_VENDOR],
  ["donation-openrouter", OTHER_VENDOR],
  ["donation-tierflow", OTHER_VENDOR],
  ["donation-TierSense", OTHER_VENDOR],
  // 厂商词压过渠道标注：反代/匿名只是渠道说明，模型仍是 OpenCode 的
  ["donation-[反代]big-pickle", "OpenCode"],
  // 平台前缀不抢厂商：@cf/ 是 Cloudflare 托管，模型仍是 Meta 的
  ["@cf/meta/llama-3-8b-instruct", "Meta"],
  // 量子计算校准看图模型是英伟达自研（基于 Gemma 4 31B 微调），不是 Google 的
  ["donation-ising-calibration-31b", "NVIDIA"],
  ["donation-Bouquet", "Bouquet"],

  // ── 真认不出的就该留在「其他」，不为凑数瞎认 ──
  ["donation-入梦 Pro", OTHER_VENDOR],
  ["donation-u2-flash", OTHER_VENDOR],
  ["donation-SN-dpv4f", OTHER_VENDOR],
  ["donation-Swift-exl3-5.0bpw", OTHER_VENDOR],
  ["donation-小学生公益自研-V1-Flash", OTHER_VENDOR],
]

let failed = 0
for (const [model, want] of CASES) {
  const got = sectionOf(model)
  if (got !== want) {
    failed++
    console.error(`  ✗ ${model}\n      期望 ${want}，实得 ${got}`)
  }
}
assert.equal(failed, 0, `有 ${failed} 条归类不对`)

// ── 分节：数量降序、模态与厂商混排、「其他」垫底 ──
const groups = groupModelsBySection([
  "donation-agnes-video-2.5-flash",
  "donation-agnes-video-2.0",
  "donation-veo-3",
  "donation-agnes-image-2.1-flash",
  "donation-dall-e-3",
  "donation-gemini-3-pro",
  "donation-openrouter",
  "donation-some-unknown-model",
])
const shape = groups.map((g) => [g.section, g.models.length])
assert.deepEqual(
  shape,
  [
    [MODALITY_VIDEO, 3],
    [MODALITY_IMAGE, 2],
    ["Google", 1],
    [OTHER_VENDOR, 2],
  ],
  "分节数量或顺序不对"
)
// 「其他」永远最后一节，哪怕它比某些厂商节还多
assert.equal(groups.at(-1).section, OTHER_VENDOR, "「其他」没有垫底")

console.log(`厂商归类自检通过：${CASES.length} 条用例 + 分组排序`)
