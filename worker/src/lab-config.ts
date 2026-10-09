/**
 * AI 实验室（网页 agent）的「模型来源」配置。
 *
 * 背景：实验室原来只有一个额度来源 —— 每个用户自己的中转站专用 Key。
 * 现在管理员可以在面板里改成「全站统一用我提供的 Key」，用户端标为**免费试用**；
 * 也可以自己添加若干条**自定义渠道**，挂到用户端「外部渠道」里供大家直接选用。
 *
 * 三条硬规则：
 *   1. **密钥只在服务端出现**。统一 Key 与渠道 apiKey 都以 AES-GCM 密文存在
 *      `app_settings`，读出来解密后只在本次请求内存里用；管理面板只回「尾号」，
 *      用户端**连尾号都拿不到**。渠道调用一律走服务端代理，不下发浏览器。
 *   2. **配了 "admin" 但没有可用 Key 时自动退回 "user"**。否则全站用户会撞上
 *      一个谁也看不懂的报错，而管理员还以为自己配好了。
 *   3. 「每天」的周期键走 `siteDayString` + `siteOffsetHours`，**不硬编码 +8**。
 */
import { decryptSecret, encryptSecret, uuid } from "./crypto"
import { getSettings, siteDayString, siteOffsetHours } from "./settings"
import type { Env } from "./env"

/** 模型来源：用户自己的额度 / 管理员统一提供 */
export type LabAiSource = "user" | "admin"

/** 免费额度的重置周期 */
export type LabQuotaPeriod = "day" | "month" | "total"

/** 存库形态的一条管理员渠道（含密文密钥） */
export interface LabAdminChannel {
  id: string
  name: string
  baseUrl: string
  /** 该渠道默认模型；空串表示沿用用户在站内选的那个模型名 */
  model: string
  /** 加密后的 apiKey（`v1:iv:ct`） */
  apiKeyEnc: string
}

/** 解密后的渠道（仅在服务端流转） */
export interface LabAdminChannelRuntime extends Omit<LabAdminChannel, "apiKeyEnc"> {
  apiKey: string
}

/** 一次请求内用到的全部实验室来源配置 */
export interface LabRuntimeConfig {
  /** 实际生效的来源（已把「配了 admin 但没 Key」回落成 user） */
  source: LabAiSource
  /** 统一 Key 的明文；`source === "user"` 时为 "" */
  adminKey: string
  /** 管理员渠道（已解密） */
  channels: LabAdminChannelRuntime[]
  /** 免费额度上限，0 = 不限 */
  quotaLimit: number
  quotaPeriod: LabQuotaPeriod
  /**
   * 免费模型白名单（已解析）。
   * **空数组 = 全部模型免费**；非空时只有名单内的模型走统一 Key。
   */
  freeModels: string[]
  /**
   * **站内模型白名单**（已解析）。
   * **空数组 = 不过滤**（站内中转站给什么就显示什么）；非空时，
   * 名单外的模型既不出现在下拉里，直接调用也会被拒。
   */
  siteModels: string[]
  /** 管理面板里配的是不是 "admin"（不管有没有回落，用于面板提示） */
  configuredSource: LabAiSource
}

export const LAB_CHANNEL_MAX = 20
const CHANNEL_NAME_MAX = 20
const CHANNEL_URL_MAX = 200
const CHANNEL_MODEL_MAX = 80

/**
 * 取加解密用的主密钥。
 * 和 `handlers/newapi.ts::requireEncryptionSecret` 同一个口径：
 * 没有 SESSION_SECRET 就**拒绝写**，而不是明文落库。
 */
function requireLabSecret(env: Env): string {
  if (!env.SESSION_SECRET) {
    throw new Error("未配置 SESSION_SECRET，无法安全保存 AI 实验室密钥")
  }
  return env.SESSION_SECRET
}

/** 明文 → 密文（写库前）。缺密钥时抛出，调用方负责转成 503。 */
export async function encryptLabSecret(env: Env, plaintext: string): Promise<string> {
  return encryptSecret(plaintext, requireLabSecret(env))
}

/** 密文 → 明文；解不开（如 SESSION_SECRET 换过）返回 ""，不抛 */
export async function decryptLabSecret(env: Env, ciphertext: string): Promise<string> {
  if (!ciphertext || !env.SESSION_SECRET) return ""
  try {
    return await decryptSecret(ciphertext, env.SESSION_SECRET)
  } catch (err) {
    console.error("解密 AI 实验室密钥失败（SESSION_SECRET 可能已更换）:", err)
    return ""
  }
}

function normalizeSource(raw: string): LabAiSource {
  return raw === "admin" ? "admin" : "user"
}

function normalizePeriod(raw: string): LabQuotaPeriod {
  return raw === "month" || raw === "total" ? raw : "day"
}

/** 白名单单条模型名的长度上限（超过的一律丢弃，不做截断 —— 截断后永远匹配不上） */
const FREE_MODEL_NAME_MAX = 120
/** 白名单条数上限 */
export const FREE_MODELS_MAX = 200

/**
 * 解析「免费模型白名单」。
 *
 * **空串 = 不限制（全部免费）**，这是向后兼容的默认值 —— 部署后不会突然
 * 把已经在白用统一 Key 的用户挡在门外。
 *
 * 分隔符收宽到 逗号 / 换行 / 分号 / 空白：管理面板提交的是数组 join(",")，
 * 但管理员手动补一个模型名时很可能用换行或空格分隔。
 */
export function parseFreeModels(raw: string): string[] {
  const out: string[] = []
  for (const part of String(raw ?? "").split(/[\s,;]+/)) {
    const name = part.trim()
    if (!name || name.length > FREE_MODEL_NAME_MAX) continue
    if (out.includes(name)) continue
    out.push(name)
    if (out.length >= FREE_MODELS_MAX) break
  }
  return out
}

/**
 * 这个模型算不算「免费」—— 走管理员统一 Key、吃免费额度、用户端标「免费试用」。
 *
 * 白名单为空 = 全部免费。白名单非空时，名单外的模型**仍然可选**，
 * 只是回落成用户自己的中转站额度（见 handlers/lab.ts::resolveLabTarget）。
 */
export function isFreeModel(cfg: LabRuntimeConfig, model: string): boolean {
  return cfg.freeModels.length === 0 || cfg.freeModels.includes(model)
}

/**
 * 这个模型允不允许被用（站内白名单）。
 *
 * **空名单 = 不限制**（默认，升级后行为不变）；非空时名单外一律拒绝。
 * ⚠️ 这条必须在**后端**执行，不能只靠前端把下拉过滤掉 ——
 *    下拉只是「看不见」，请求是可以直接构造的。
 */
export function isSiteModelAllowed(cfg: LabRuntimeConfig, model: string): boolean {
  return cfg.siteModels.length === 0 || cfg.siteModels.includes(model)
}

/**
 * 成对的「读库 → 解析渠道 → 解密密钥」。
 *
 * 用 `getSettings()` 一次把 app_settings 全读回来（单个查询），
 * 而不是对每个键各发一次 —— 这个函数在每次聊天请求里都会跑。
 */
export async function loadLabRuntimeConfig(env: Env): Promise<LabRuntimeConfig> {
  const settings = await getSettings(env)
  const configuredSource = normalizeSource(settings.lab_ai_source)
  const adminKey = await decryptLabSecret(env, settings.lab_admin_api_key)
  const quotaLimitRaw = Number(settings.lab_free_quota)
  const quotaLimit = Number.isFinite(quotaLimitRaw) && quotaLimitRaw > 0 ? Math.trunc(quotaLimitRaw) : 0
  const quotaPeriod = normalizePeriod(settings.lab_free_quota_period)
  const freeModels = parseFreeModels(settings.lab_free_models)
  const siteModels = parseFreeModels(settings.lab_site_models)

  const stored = parseStoredChannels(settings.lab_admin_channels)
  const channels: LabAdminChannelRuntime[] = []
  for (const ch of stored) {
    const apiKey = await decryptLabSecret(env, ch.apiKeyEnc)
    // 解不出密钥的渠道直接跳过：留着只会在用户点下去时报错
    if (!apiKey) continue
    channels.push({ id: ch.id, name: ch.name, baseUrl: ch.baseUrl, model: ch.model, apiKey })
  }

  // 规则 2：没配 Key 就不算 admin，省得全站报错
  const source: LabAiSource = configuredSource === "admin" && adminKey ? "admin" : "user"

  return { source, adminKey: source === "admin" ? adminKey : "", channels, quotaLimit, quotaPeriod, freeModels, siteModels, configuredSource }
}

/* ------------------------------------------------------------------ */
/* 渠道的解析与清洗                                                     */
/* ------------------------------------------------------------------ */

/** 从存库 JSON 里解析出渠道数组（坏 JSON / 坏字段一律丢弃） */
export function parseStoredChannels(raw: string | null | undefined): LabAdminChannel[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: LabAdminChannel[] = []
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue
    const o = item as Record<string, unknown>
    const id = typeof o.id === "string" ? o.id.trim() : ""
    const baseUrl = typeof o.baseUrl === "string" ? o.baseUrl.trim() : ""
    const apiKeyEnc = typeof o.apiKeyEnc === "string" ? o.apiKeyEnc.trim() : ""
    if (!id || !baseUrl || !apiKeyEnc) continue
    out.push({
      id,
      name: typeof o.name === "string" ? o.name.trim().slice(0, CHANNEL_NAME_MAX) : "",
      baseUrl: baseUrl.slice(0, CHANNEL_URL_MAX),
      model: typeof o.model === "string" ? o.model.trim().slice(0, CHANNEL_MODEL_MAX) : "",
      apiKeyEnc,
    })
    if (out.length >= LAB_CHANNEL_MAX) break
  }
  return out
}

/** 管理面板提交上来的单条渠道（apiKey 为明文，空串表示沿用原值） */
export interface LabChannelInput {
  id: string
  name: string
  baseUrl: string
  model: string
  /** 明文；空串 = 不修改已存的密钥 */
  apiKey: string
}

/**
 * 清洗管理面板提交的渠道数组。
 *
 * 丢掉没有 baseUrl 的条目（没地址的渠道毫无意义），
 * baseUrl 只接受 http/https —— 否则 `javascript:` 之类会被当成地址存进去。
 */
export function sanitizeChannelInputs(input: unknown): LabChannelInput[] {
  if (!Array.isArray(input)) return []
  const out: LabChannelInput[] = []
  for (const item of input) {
    if (!item || typeof item !== "object") continue
    const o = item as Record<string, unknown>
    const baseUrl = typeof o.baseUrl === "string" ? o.baseUrl.trim().slice(0, CHANNEL_URL_MAX) : ""
    if (!/^https?:\/\//i.test(baseUrl)) continue
    out.push({
      id: typeof o.id === "string" && o.id.trim() ? o.id.trim() : uuid(),
      name:
        typeof o.name === "string" && o.name.trim()
          ? o.name.trim().slice(0, CHANNEL_NAME_MAX)
          : baseUrl.replace(/^https?:\/\//i, "").split("/")[0].slice(0, CHANNEL_NAME_MAX),
      baseUrl,
      model: typeof o.model === "string" ? o.model.trim().slice(0, CHANNEL_MODEL_MAX) : "",
      apiKey: typeof o.apiKey === "string" ? o.apiKey.trim() : "",
    })
    if (out.length >= LAB_CHANNEL_MAX) break
  }
  return out
}

/**
 * 把面板提交的渠道与库里已有的合并，产出**可存库**的数组。
 *
 * 关键点：`apiKey` 留空表示「这条不改密钥」，沿用旧的密文；
 * 新渠道若没填密钥则整条丢弃（没有密钥的渠道调用必然 401）。
 */
export async function mergeChannels(
  env: Env,
  inputs: LabChannelInput[],
  previousEnc: Map<string, string>
): Promise<LabAdminChannel[]> {
  const out: LabAdminChannel[] = []
  for (const item of inputs) {
    const apiKeyEnc = item.apiKey
      ? await encryptLabSecret(env, item.apiKey)
      : previousEnc.get(item.id) ?? ""
    // 新加的渠道没填密钥 ⇒ 整条丢掉。存下来只会在用户点下去时 401。
    if (!apiKeyEnc) continue
    out.push({ id: item.id, name: item.name, baseUrl: item.baseUrl, model: item.model, apiKeyEnc })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 免费额度                                                             */
/* ------------------------------------------------------------------ */

/**
 * 额度计数键。
 *   · day   → `YYYY-MM-DD`（站点时区）
 *   · month → `YYYY-MM`（站点时区）
 *   · total → 固定 `total`（一次性发放，永不重置）
 */
export async function labQuotaPeriodKey(
  env: Env,
  period: LabQuotaPeriod,
  now: Date = new Date()
): Promise<string> {
  if (period === "total") return "total"
  const offset = await siteOffsetHours(env)
  const day = siteDayString(now, offset)
  return period === "month" ? day.slice(0, 7) : day
}

/** 该用户在**当前周期**已经用掉的免费次数 */
export async function labQuotaUsed(env: Env, userId: string, period: LabQuotaPeriod): Promise<number> {
  const pk = await labQuotaPeriodKey(env, period)
  const row = await env.DB.prepare(
    "SELECT used FROM lab_free_usage WHERE user_id = ? AND period_key = ?"
  )
    .bind(userId, pk)
    .first<{ used: number }>()
  return row?.used ?? 0
}

/**
 * 用掉一次免费额度。
 *
 * 先读配置是为了拿周期，调用方已经把 `LabRuntimeConfig` 拿到了，
 * 所以这里收 config 而不是重新 `loadLabRuntimeConfig`（一次聊天只读一次库）。
 */
export async function consumeLabQuota(
  env: Env,
  userId: string,
  period: LabQuotaPeriod
): Promise<void> {
  const pk = await labQuotaPeriodKey(env, period)
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO lab_free_usage (user_id, period_key, used, updated_at) VALUES (?, ?, 1, ?)
     ON CONFLICT(user_id, period_key) DO UPDATE SET used = used + 1, updated_at = excluded.updated_at`
  )
    .bind(userId, pk, now)
    .run()
}
