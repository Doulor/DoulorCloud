// AI 实验室「模型来源」配置的三条硬规则。
//
// 这套东西的分量在于**钱**：统一 Key 是全站共用一把、扣站长的额度。
// 所以这里锁死的是「什么情况下会拿站长的钱去花」以及「哪些输入会被丢掉」：
//   1) 选了 admin 但 Key 是空的 ⇒ 必须回落成 user，否则全站用户一起撞报错；
//   2) 渠道没有可用密钥 ⇒ 整条丢掉，不能留一条点下去必然 401 的僵尸渠道；
//   3) 面板留空提交 ⇒ 沿用旧密钥（否则改个名字就把密钥清了）。
// 另外额度周期键必须按站点时区算，不能硬编码 +8。
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import {
  encryptLabSecret,
  labQuotaPeriodKey,
  labQuotaUsed,
  consumeLabQuota,
  loadLabRuntimeConfig,
  mergeChannels,
  parseFreeModels,
  isFreeModel,
  isSiteModelAllowed,
  parseStoredChannels,
  sanitizeChannelInputs,
  type LabRuntimeConfig,
} from "../src/lab-config"
import { updateSettings } from "../src/settings"
import "./helpers"

async function resetLabSettings() {
  await updateSettings(env, {
    lab_ai_source: "user",
    lab_admin_api_key: "",
    lab_free_quota: "0",
    lab_free_quota_period: "day",
    lab_free_models: "",
    lab_admin_channels: "[]",
    lab_agent_prompt: "",
    site_timezone_offset_hours: "8",
  })
}

describe("lab-config：渠道清洗", () => {
  it("丢掉非 http(s) 的地址，保留合法条目", () => {
    const out = sanitizeChannelInputs([
      { name: "ok", baseUrl: "https://api.example.com/v1", model: "gpt-4o" },
      { name: "bad", baseUrl: "javascript:alert(1)" },
      { name: "empty", baseUrl: "" },
      "not-an-object",
    ])
    expect(out).toHaveLength(1)
    expect(out[0].baseUrl).toBe("https://api.example.com/v1")
    expect(out[0].id).toBeTruthy()
  })

  it("没填名字时用域名兜底", () => {
    const out = sanitizeChannelInputs([{ baseUrl: "https://api.example.com/v1" }])
    expect(out[0].name).toBe("api.example.com")
  })
})

describe("lab-config：存库解析", () => {
  it("坏 JSON 当空数组", () => {
    expect(parseStoredChannels("{oops")).toEqual([])
    expect(parseStoredChannels(null)).toEqual([])
  })

  it("缺 baseUrl / apiKeyEnc 的条目直接丢", () => {
    const raw = JSON.stringify([
      { id: "a", name: "x", baseUrl: "https://a.com", apiKeyEnc: "v1:1:2" },
      { id: "b", name: "y", apiKeyEnc: "v1:1:2" },
      { name: "z", baseUrl: "https://c.com" },
    ])
    expect(parseStoredChannels(raw)).toHaveLength(1)
  })
})

describe("lab-config：合并提交", () => {
  beforeEach(resetLabSettings)

  it("apiKey 留空 = 沿用旧密钥", async () => {
    const old = await encryptLabSecret(env, "sk-old")
    const merged = await mergeChannels(
      env,
      [{ id: "c1", name: "改了个名字", baseUrl: "https://a.com/v1", model: "", apiKey: "" }],
      new Map([["c1", old]])
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].name).toBe("改了个名字")
    expect(merged[0].apiKeyEnc).toBe(old)
  })

  it("新渠道没填密钥 ⇒ 不落库", async () => {
    const merged = await mergeChannels(
      env,
      [{ id: "c2", name: "新的", baseUrl: "https://b.com/v1", model: "", apiKey: "" }],
      new Map()
    )
    expect(merged).toHaveLength(0)
  })
})

describe("lab-config：来源回落", () => {
  beforeEach(resetLabSettings)

  it("选了 admin 但没配 Key ⇒ 实际来源是 user", async () => {
    await updateSettings(env, { lab_ai_source: "admin", lab_admin_api_key: "" })
    const cfg = await loadLabRuntimeConfig(env)
    expect(cfg.configuredSource).toBe("admin")
    expect(cfg.source).toBe("user")
    expect(cfg.adminKey).toBe("")
  })

  it("配了 Key ⇒ 实际来源是 admin，且能解出明文", async () => {
    const enc = await encryptLabSecret(env, "sk-shared")
    await updateSettings(env, { lab_ai_source: "admin", lab_admin_api_key: enc })
    const cfg = await loadLabRuntimeConfig(env)
    expect(cfg.source).toBe("admin")
    expect(cfg.adminKey).toBe("sk-shared")
  })

  it("能解密的渠道才进 runtime 列表", async () => {
    const good = await encryptLabSecret(env, "sk-good")
    await updateSettings(env, {
      lab_admin_channels: JSON.stringify([
        { id: "c1", name: "能用", baseUrl: "https://a.com/v1", model: "", apiKeyEnc: good },
        { id: "c2", name: "解不开", baseUrl: "https://b.com/v1", model: "", apiKeyEnc: "v1:bad:bad" },
      ]),
    })
    const cfg = await loadLabRuntimeConfig(env)
    expect(cfg.channels.map((c) => c.id)).toEqual(["c1"])
    expect(cfg.channels[0].apiKey).toBe("sk-good")
  })
})

describe("lab-config：免费额度", () => {
  beforeEach(resetLabSettings)

  it("周期键按站点时区算（+8 与 +0 会落在不同的一天）", async () => {
    // 2026-10-09T17:00Z ⇒ 北京时间已经是 10-10
    const at = new Date("2026-10-09T17:00:00Z")
    expect(await labQuotaPeriodKey(env, "day", at)).toBe("2026-10-10")
    await updateSettings(env, { site_timezone_offset_hours: "0" })
    expect(await labQuotaPeriodKey(env, "day", at)).toBe("2026-10-09")
  })

  it("month 取年月，total 固定", async () => {
    const at = new Date("2026-10-09T02:00:00Z")
    expect(await labQuotaPeriodKey(env, "month", at)).toBe("2026-10")
    expect(await labQuotaPeriodKey(env, "total", at)).toBe("total")
  })

  it("计数按周期独立累加", async () => {
    const uid = "u-quota-1"
    expect(await labQuotaUsed(env, uid, "day")).toBe(0)
    await consumeLabQuota(env, uid, "day")
    await consumeLabQuota(env, uid, "day")
    expect(await labQuotaUsed(env, uid, "day")).toBe(2)
    // 另一个周期互不污染
    expect(await labQuotaUsed(env, uid, "month")).toBe(0)
    expect(await labQuotaUsed(env, "u-quota-2", "day")).toBe(0)
  })
})

// 白名单直接决定「哪次调用扣的是站长的钱」，判错就是烧钱，所以锁死在这里。
describe("lab-config：免费模型白名单", () => {
  beforeEach(resetLabSettings)

  it("空串 ⇒ 空名单（代表「全部免费」）", () => {
    expect(parseFreeModels("")).toEqual([])
    expect(parseFreeModels("  ,  , ")).toEqual([])
  })

  it("逗号分隔、去空白、去重", () => {
    expect(parseFreeModels("gpt-4o, claude-3.5 , gpt-4o,")).toEqual(["gpt-4o", "claude-3.5"])
  })

  it("空名单 ⇒ 所有模型都算免费", () => {
    const cfg = { freeModels: [] } as LabRuntimeConfig
    expect(isFreeModel(cfg, "anything")).toBe(true)
  })

  it("非空名单 ⇒ 只有名单内的算免费", () => {
    const cfg = { freeModels: ["gpt-4o"] } as LabRuntimeConfig
    expect(isFreeModel(cfg, "gpt-4o")).toBe(true)
    expect(isFreeModel(cfg, "gpt-4o-mini")).toBe(false)
  })

  it("站内白名单：空 ⇒ 不限制（升级后行为不变）", () => {
    const cfg = { siteModels: [] } as LabRuntimeConfig
    expect(isSiteModelAllowed(cfg, "anything")).toBe(true)
  })

  it("站内白名单：非空 ⇒ 名单外一律拒绝", () => {
    const cfg = { siteModels: ["gpt-4o"] } as LabRuntimeConfig
    expect(isSiteModelAllowed(cfg, "gpt-4o")).toBe(true)
    expect(isSiteModelAllowed(cfg, "gpt-4o-mini")).toBe(false)
  })

  it("站内白名单与免费白名单互不影响", () => {
    // 只在站内白名单里、不在免费名单里 ⇒ 能选，但要花自己的额度
    const cfg = {
      siteModels: ["a"],
      freeModels: ["b"],
    } as unknown as LabRuntimeConfig
    expect(isSiteModelAllowed(cfg, "a")).toBe(true)
    expect(isFreeModel(cfg, "a")).toBe(false)
  })

  it("loadLabRuntimeConfig 会把库里的白名单解析出来", async () => {
    await updateSettings(env, { lab_free_models: "a, b" })
    const cfg = await loadLabRuntimeConfig(env)
    expect(cfg.freeModels).toEqual(["a", "b"])
  })
})
