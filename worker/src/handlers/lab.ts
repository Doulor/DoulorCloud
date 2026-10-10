/**
 * 网页实验室（Web Lab）。
 *
 * 用户在站内通过聊天让 AI 生成小网页（单文件 HTML），保存为「作品」。
 *
 * 额度来源（一期）：
 *   · 站内额度：后端用一个「自动创建的专用 Key」调 NewAPI 的
 *     /v1/chat/completions，扣用户自己的中转站账户额度。
 *     Key 每次现找现取（listTokens + readApiKey），本地不缓存明文；
 *     用户在 NewAPI 侧删了它会自动重建，不需要手动维护。
 *   · 自定义渠道：前端直连（baseUrl + key 只存浏览器本地），不经过本模块。
 *
 * 鉴权用 requireUser 而非 requireFeatureUser("ai")：
 *   未开通中转站的用户也能进实验室用「自定义渠道」，只在真正要走
 *   站内额度时（resolveLabKey）才要求已开通并给出明确指引。
 */
import { ApiError, json, readBodyCapped } from "../http"
import { requireUser } from "../auth"
import { uuid } from "../crypto"
import { hardenUserContentResponse } from "../content-type"
import { guardRateLimit } from "../ratelimit"
import {
  createApiKey,
  listTokens,
  newApiBaseUrl,
  readApiKey,
} from "../newapi-client"
import { fetchWithTimeout } from "../async-utils"
import {
  deleteObject,
  deletePrefix,
  getObject,
  getPlatformBucketId,
  isStorageConfigured,
  putObject,
} from "../r2"
import { loadAccount, mapUserTokenError, runWithUserToken } from "./newapi"
import { getSetting } from "../settings"
import { likeContains } from "../sql-like"
import { LAB_KEY_NAME, LAB_KEY_NAMES, isLabKeyName } from "../lab-key"
import { buildPreviewDoc } from "../lab-preview"
import { loadEnabledTemplates } from "./lab-prompts"
import { loadSkillIndex } from "./lab-skills"
import { loadSearchCost, isUserSearchEnabled, loadSiteKeysForInfo } from "./lab-search"
import {
  consumeLabQuota,
  isFreeModel,
  isSiteModelAllowed,
  labQuotaUsed,
  loadLabRuntimeConfig,
  type LabRuntimeConfig,
} from "../lab-config"
import type { Env } from "../env"

/**
 * 把管理员填的 base url 规范成 chat/completions 端点。
 * 与前端 `customEndpoint()` 同一个口径（用户自己的渠道也走这套）。
 */
function channelEndpoint(raw: string): string {
  const base = raw.trim().replace(/\/+$/, "")
  if (/\/chat\/completions$/i.test(base)) return base
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`
  return `${base}/v1/chat/completions`
}

/** 这一次请求最终要打的上游 */
interface LabTarget {
  /** chat/completions 完整端点 */
  endpoint: string
  /** 上游密钥（只在本请求内存里存在，绝不下发前端） */
  key: string
  /** 实际使用的模型名（管理员渠道可以把模型写死） */
  model: string
  /** 走的是不是「免费」额度（管理员统一 Key 或管理员渠道） */
  free: boolean
  /** 命中的管理员渠道 id（站内统一 Key 时为空） */
  channelId: string
}

/**
 * 决定这次调用打哪儿、用谁的密钥。
 *
 * 三个来源，优先级从高到低：
 *   1. `channelId` 命中管理员渠道 ⇒ 打该渠道，密钥用渠道的（渠道天然免费）；
 *   2. `lab_ai_source === "admin"` **且这个模型在免费白名单里** ⇒ 打站内中转站，
 *      用管理员统一 Key；
 *   3. 其余 ⇒ 打站内中转站，用**该用户自己的**专用 Key（原来的一期行为）。
 *
 * ⚠️ 管理员开了「统一 Key」又配了免费模型白名单时，名单外的模型**仍然可选**，
 * 只是掉到第 3 条 —— 用户用自己的额度，站长不用替他买单。
 * 用户没开通中转站时 resolveLabKey 会抛出带引导文案的 NOT_BOUND，这是预期行为。
 *
 * ⚠️ 走 1 / 2 都算「免费额度」。没有额度概念的话，用户只要切到渠道
 * 就能无限吃站长的钱，限额就形同虚设。
 */
async function resolveLabTarget(
  env: Env,
  userId: string,
  cfg: LabRuntimeConfig,
  requestedModel: string,
  channelId: string
): Promise<LabTarget> {
  if (channelId) {
    const ch = cfg.channels.find((c) => c.id === channelId)
    if (!ch) {
      throw new ApiError(404, "这条免费渠道已被管理员移除，请重新选一个", "CHANNEL_GONE")
    }
    return {
      endpoint: channelEndpoint(ch.baseUrl),
      key: ch.apiKey,
      // 渠道写了固定模型就以它为准 —— 渠道按模型计费/售卖时，用户自己改名会直接 404
      model: ch.model || requestedModel,
      free: true,
      channelId: ch.id,
    }
  }

  if (cfg.source === "admin" && isFreeModel(cfg, requestedModel)) {
    return {
      endpoint: `${newApiBaseUrl(env)}/v1/chat/completions`,
      key: cfg.adminKey,
      model: requestedModel,
      free: true,
      channelId: "",
    }
  }

  return {
    endpoint: `${newApiBaseUrl(env)}/v1/chat/completions`,
    key: await resolveLabKey(env, userId),
    model: requestedModel,
    free: false,
    channelId: "",
  }
}

/**
 * 免费额度闸门。
 *
 * 只拦「免费」的调用；用的是自己的额度时不受任何限制。
 * 额度为 0 表示不限量（默认），此时仍然计数 —— 管理端能看到消耗量，
 * 将来想收紧时也有历史数据可看。
 */
async function assertFreeQuota(
  env: Env,
  userId: string,
  cfg: LabRuntimeConfig,
  target: LabTarget
): Promise<void> {
  if (!target.free) return
  if (cfg.quotaLimit <= 0) return
  const used = await labQuotaUsed(env, userId, cfg.quotaPeriod)
  if (used >= cfg.quotaLimit) {
    const unit = cfg.quotaPeriod === "month" ? "本月" : cfg.quotaPeriod === "total" ? "总计" : "今天"
    throw new ApiError(
      429,
      `免费试用额度已用完（${unit} ${cfg.quotaLimit} 次）。可以等下一个周期，或到「AI 中转站」用自己账号的额度继续。`,
      "FREE_QUOTA_EXCEEDED"
    )
  }
}

/**
 * 用户**自己**有没有可用的额度（拿得到 Key 就说明开通了且凭据有效）。
 * 拿不到返回 null 而不抛 —— 调用方要据此决定「降级」还是「按原样拦」。
 */
async function tryResolveOwnKey(env: Env, userId: string): Promise<string | null> {
  try {
    return await resolveLabKey(env, userId)
  } catch {
    return null
  }
}

/** 拿（或自动创建）用户的实验室专用 Key 的完整值。 */
async function resolveLabKey(env: Env, userId: string): Promise<string> {
  const account = await loadAccount(env, userId)
  if (!account) {
    throw new ApiError(
      404,
      "尚未开通 AI 中转站：去「AI 中转站」页开通后即可用站内额度，或在左下角切到自定义渠道",
      "NOT_BOUND"
    )
  }
  try {
    return await runWithUserToken(env, account, async (token, uid) => {
      // 1) 上游找同名 Key —— 现找现取，本地不缓存明文；被删掉会自动重建
      const tokens = await listTokens(env, token, uid)
      const hits = tokens.filter((t) => isLabKeyName(t.name))
      // 规范名优先；同名的取最新 id
      const existing =
        hits
          .filter((t) => t.name === LAB_KEY_NAME)
          .sort((a, b) => b.id - a.id)[0] ??
        hits.sort((a, b) => b.id - a.id)[0]
      if (existing) {
        // 老名字顺手在**本地**改成规范名，列表显示就统一了（上游名字不动，见上面的注释）
        if (existing.name !== LAB_KEY_NAME) {
          await env.DB.prepare(
            "UPDATE newapi_keys SET name = ? WHERE user_id = ? AND token_id = ?"
          )
            .bind(LAB_KEY_NAME, userId, existing.id)
            .run()
        }
        return readApiKey(env, token, uid, existing.id)
      }

      // 2) 没有就建一个，并同步进本地 Key 列表（用户在 AI 页能看到它）
      const created = await createApiKey(env, token, uid, LAB_KEY_NAME)
      const now = new Date().toISOString()
      await env.DB.batch([
        env.DB.prepare(
          "DELETE FROM newapi_keys WHERE user_id = ? AND name IN (?, ?)"
        ).bind(userId, LAB_KEY_NAME, LAB_KEY_NAMES[1]),
        env.DB.prepare(
          `INSERT INTO newapi_keys (id, user_id, token_id, name, key_prefix, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(uuid(), userId, created.tokenId, LAB_KEY_NAME, created.maskedKey, now),
      ])
      return created.fullKey
    })
  } catch (err) {
    throw mapUserTokenError(err)
  }
}

/**
 * 「这是推理型模型吗」的粗判 —— 只用来决定**要不要带 reasoning_effort**。
 *
 * 为什么不无脑带上：非推理模型带上它通常会被忽略，但少数中转渠道会直接 400。
 * 这里的匹配故意写得保守（宁可漏带，也不误带），而且外层还有「被拒就摘掉重发」的兜底。
 */
const REASONING_MODEL_RE =
  /(^|[/_.-])(o[1-9]|gpt-5|qwq|deepseek[-_.]?r\d?|r1|reason\w*|think\w*|magistral)/i

/**
 * 思考强度的合法取值（从低到高），与上游 `reasoning_effort` 对齐。
 *
 * 口径：GPT-5.6 / Claude 这一代用的是 low / medium / high / xhigh / max。
 * ⚠️ 前端 `src/lib/lab-agent.ts` 的 `EFFORT_LEVELS` 是同一份口径，
 *    改这里记得一起改（温度表只在前端，后端不重复）。
 */
const REASONING_EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"] as const

// ---------------------------------------------------------------------------
// 聊天（流式转发到上游 /v1/chat/completions）
// ---------------------------------------------------------------------------

const MAX_MESSAGES = 60
/**
 * ⚠️ 单条消息上限要放得比「一个源文件」大。
 * agent 模式下模型的回复里直接带着 <lab_write> 的**完整文件正文**，
 * 40k 字符会把一个正常大小的 HTML 从中间截断 —— 用户看到的是「AI 写了个残缺文件」，
 * 而没有任何报错。这里按「单文件 800KB 上限」留足余量。
 */
const MAX_CONTENT_CHARS = 160_000
const MAX_TOTAL_CHARS = 400_000

/**
 * 多模态消息里的一段内容。
 * 只认这两种 —— **不接受 `http(s)://` 的图片地址**：那等于让 Worker 去替用户
 * 抓任意 URL（SSRF），而且上游多半也要自己再抓一次。图片一律走 data URL（前端已压过）。
 */
type ChatPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }

interface ChatMessage {
  role: "system" | "user" | "assistant"
  /** 纯文本消息是 string；带图的用户消息是 part 数组 */
  content: string | ChatPart[]
}

/** 图片 data URL 的白名单格式（只收常见位图，不收 svg —— svg 里能塞脚本） */
const IMAGE_DATA_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+=*$/
/** 单条消息最多几张图（模型对一次能看多少张有上限，也不该让一条消息无限大） */
const MAX_IMAGES_PER_MESSAGE = 6
/** 单张图的 base64 字符上限（≈3MB 二进制；前端已压到 1.5MB 以内，留足余量） */
const MAX_IMAGE_CHARS = 4_000_000
/** 所有图片合计的字符上限 */
const MAX_TOTAL_IMAGE_CHARS = 12_000_000

/** 一段内容里的纯文字长度（用于「总量超限丢最老的」那套预算） */
function textCharsOf(content: string | ChatPart[]): number {
  if (typeof content === "string") return content.length
  return content.reduce((n, p) => n + (p.type === "text" ? p.text.length : 0), 0)
}

/** 一段内容里的图片字符数 */
function imageCharsOf(content: string | ChatPart[]): number {
  if (typeof content === "string") return 0
  return content.reduce((n, p) => n + (p.type === "image_url" ? p.image_url.url.length : 0), 0)
}

/**
 * 清洗多模态内容。返回 null = 这段内容不可用（调用方整条丢掉）。
 * 规则：文字截断；图片只认 data URL、张数与体积都有上限；**任何一段图片不合法就丢掉那张**，
 * 但整条消息只要还剩文字就保留 —— 用户辛苦打的字不该因为一张图挂了而消失。
 */
function cleanContent(raw: unknown): string | ChatPart[] | null {
  if (typeof raw === "string") {
    return raw.trim() ? raw.slice(0, MAX_CONTENT_CHARS) : null
  }
  if (!Array.isArray(raw)) return null

  const parts: ChatPart[] = []
  let images = 0
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const type = (item as { type?: unknown }).type
    if (type === "text") {
      const text = (item as { text?: unknown }).text
      if (typeof text !== "string" || !text.trim()) continue
      parts.push({ type: "text", text: text.slice(0, MAX_CONTENT_CHARS) })
    } else if (type === "image_url") {
      if (images >= MAX_IMAGES_PER_MESSAGE) continue
      const url = (item as { image_url?: { url?: unknown } }).image_url?.url
      if (typeof url !== "string" || !IMAGE_DATA_RE.test(url)) continue
      if (url.length > MAX_IMAGE_CHARS) continue
      parts.push({ type: "image_url", image_url: { url } })
      images++
    }
  }
  // 一张图都没有、也没有文字 ⇒ 这条没有意义
  return parts.length ? parts : null
}

/** 校验并收敛消息数组：跳非法项、限单条/总量、system 只留最后一条。 */
function sanitizeMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) {
    throw new ApiError(400, "对话内容格式不对", "INVALID_MESSAGES")
  }
  const all: ChatMessage[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const role = (item as { role?: unknown }).role
    const content = (item as { content?: unknown }).content
    if (role !== "system" && role !== "user" && role !== "assistant") continue
    const clean = cleanContent(content)
    if (!clean) continue
    // 图片只允许出现在用户消息里：助手/系统的「图」没有语义，多半是注入
    if (typeof clean !== "string" && role !== "user") continue
    all.push({ role, content: clean })
  }

  const system = [...all].reverse().find((m) => m.role === "system")
  let talk = all.filter((m) => m.role !== "system").slice(-MAX_MESSAGES)

  /**
   * 总量超限时从最老的对话开始丢（system 与最近的内容优先保留）。
   *
   * ⚠️ 这里**只按文字长度算**，图片单独一套预算。
   * 否则一张 3MB 的图会让 total 直接爆掉 MAX_TOTAL_CHARS，
   * 循环会把所有历史（包括刚带图的那条）全丢光 —— 用户看到的是「图发了没反应」。
   */
  let total =
    talk.reduce((sum, m) => sum + textCharsOf(m.content), 0) +
    (system ? textCharsOf(system.content) : 0)
  while (total > MAX_TOTAL_CHARS && talk.length > 1) {
    total -= textCharsOf(talk[0].content)
    talk = talk.slice(1)
  }

  // 图片总预算：超了就从最老的带图消息开始、把它的图摘掉（文字留着）
  let imageTotal = talk.reduce((sum, m) => sum + imageCharsOf(m.content), 0)
  for (let i = 0; imageTotal > MAX_TOTAL_IMAGE_CHARS && i < talk.length; i++) {
    const m = talk[i]
    if (typeof m.content === "string") continue
    imageTotal -= imageCharsOf(m.content)
    const kept = m.content.filter((p) => p.type === "text")
    // 只剩文字就是纯文本消息了 —— 转回 string，别让上游看到空数组
    talk[i] = { role: m.role, content: kept.map((p) => p.text).join("\n") }
  }

  if (!talk.some((m) => m.role === "user")) {
    throw new ApiError(400, "至少需要一条用户消息", "INVALID_MESSAGES")
  }
  return system ? [system, ...talk] : talk
}

/** POST /api/lab/chat —— 以用户额度流式调用 AI（SSE 透传）。 */
export async function chat(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)

  const body = (await request
    .json()
    .catch(() => null)) as {
    model?: unknown
    messages?: unknown
    temperature?: unknown
    effort?: unknown
    /** 选了管理员提供的免费渠道时带上它的 id；不传 = 走站内 */
    channelId?: unknown
  } | null
  if (!body) throw new ApiError(400, "请求体不是合法 JSON", "INVALID_BODY")

  const model =
    typeof body.model === "string" ? body.model.trim().slice(0, 120) : ""
  // 管理员渠道允许把模型写死（此时前端可以不传 model），所以这里不做非空强制，
  // 真正有没有模型由 resolveLabTarget 决定。
  const channelId =
    typeof body.channelId === "string" ? body.channelId.trim().slice(0, 64) : ""
  if (!model && !channelId) throw new ApiError(400, "请选择模型", "INVALID_MODEL")

  // 温度由前端按「思考强度」算好传上来（前端是唯一的口径来源，别在这边重复一张表）。
  // 只做范围收口：越界或非数字一律退回默认 0.6。
  const temperature =
    typeof body.temperature === "number" &&
    Number.isFinite(body.temperature) &&
    body.temperature >= 0 &&
    body.temperature <= 2
      ? body.temperature
      : 0.6

  const messages = sanitizeMessages(body.messages)

  const cfg = await loadLabRuntimeConfig(env)
  const target = await resolveLabTarget(env, user.id, cfg, model, channelId)

  /**
   * 站内模型白名单：**只在走站内中转站时生效**。
   * 管理员配的免费渠道有自己的固定模型（`channelId` 非空），不受这份名单约束。
   * 空名单 = 不限制。
   * ⚠️ 前端下拉过滤只是「看不见」，请求可以手工构造 ⇒ 这条必须在后端拦一次。
   */
  if (!target.channelId && !isSiteModelAllowed(cfg, target.model)) {
    throw new ApiError(
      400,
      "这个模型没有开放使用，请在列表里换一个",
      "MODEL_NOT_ALLOWED"
    )
  }

  /**
   * 免费额度用完后**先尝试降级，而不是直接拦**（站长 2026-10-10 要求）：
   *   · 用户开通过中转站 ⇒ 自动改用**他自己账号的 Key** 继续，前端提示一下即可；
   *   · 没开通 ⇒ 才走原来的 429「免费额度已用完」。
   *
   * 直接拦的问题：明明有账号的人都用不了，还得用户自己去切渠道 —— 没必要。
   * ⚠️ 降级后必须把 `free` 与 `channelId` 一起改掉：否则这次调用仍会被算进
   *    免费额度（`assertFreeQuota` 与用量记账都看 `target.free`）。
   */
  let autoFellBack = false
  if (target.free && cfg.quotaLimit > 0) {
    const used = await labQuotaUsed(env, user.id, cfg.quotaPeriod)
    if (used >= cfg.quotaLimit) {
      const ownKey = await tryResolveOwnKey(env, user.id)
      if (ownKey) {
        target.key = ownKey
        target.free = false
        target.channelId = ""
        // 走的是站内中转站自己的额度，端点要跟着换回去
        target.endpoint = `${newApiBaseUrl(env)}/v1/chat/completions`
        autoFellBack = true
      }
    }
  }
  await assertFreeQuota(env, user.id, cfg, target)
  const finalModel = target.model

  /**
   * 思考强度（reasoning_effort）：
   *   - 取值 low / medium / high / xhigh / max，与上游对齐（见 REASONING_EFFORT_ORDER）。
   *   - 只有「推理型」模型才带这个参数（名字匹配 REASONING_MODEL_RE）。
   *     非推理模型带上它多半被忽略，极少数中转渠道会直接 400。
   *   - ⚠️ 高档位不是所有模型/渠道都认（很多只到 high）。所以有一条**降级链**：
   *     被 400/422 拒了就往下退一档重发（max → xhigh → high …），
   *     一路退到底仍被拒，才摘掉这个参数裸发一次。
   *     宁可悄悄退化，也不能让用户看到调用失败。
   *   - 非法值 → 不带（等于让模型自己决定）。
   */
  const effortRaw =
    typeof body.effort === "string" ? body.effort.trim().toLowerCase() : ""
  const effortIdx = (REASONING_EFFORT_ORDER as readonly string[]).indexOf(effortRaw)
  const wantEffort = effortIdx >= 0 && REASONING_MODEL_RE.test(finalModel)

  const payload: Record<string, unknown> = {
    model: finalModel,
    messages,
    stream: true,
    temperature,
  }
  if (wantEffort) payload.reasoning_effort = REASONING_EFFORT_ORDER[effortIdx]

  const sendUpstream = async (b: Record<string, unknown>) => {
    // ⚠️ 流式请求不能用 fetchWithTimeout 包：到点会把正在输出的流掐断。
    //    连不上/挂死由平台的连接超时与客户端断开兜底。
    return await fetch(target.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${target.key}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify(b),
    })
  }

  let upstream: Response
  try {
    upstream = await sendUpstream(payload)
    // 渠道/模型不认这个档位（400/422）⇒ 一档一档往下退，退到底再摘掉参数裸发。
    if (wantEffort && !upstream.ok && (upstream.status === 400 || upstream.status === 422)) {
      for (let i = effortIdx - 1; i >= 0; i--) {
        payload.reasoning_effort = REASONING_EFFORT_ORDER[i]
        upstream = await sendUpstream(payload)
        if (upstream.ok) break
        // 不是「不认参数」类的拒绝，就别继续退了（退也没用）
        if (upstream.status !== 400 && upstream.status !== 422) break
      }
      if (!upstream.ok && (upstream.status === 400 || upstream.status === 422)) {
        delete payload.reasoning_effort
        upstream = await sendUpstream(payload)
      }
    }
  } catch (err) {
    console.error("实验室直连上游失败:", err)
    throw new ApiError(
      502,
      "无法连接 AI 上游（网络超时），请重试",
      "UPSTREAM_UNREACHABLE"
    )
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "")
    let message = `AI 调用失败（HTTP ${upstream.status}）`
    try {
      const parsed = JSON.parse(text) as {
        error?: { message?: string }
        message?: string
      }
      const m = parsed?.error?.message ?? parsed?.message
      if (m) message = m
    } catch {
      /* 非 JSON 就保留兜底文案 */
    }
    throw new ApiError(502, message.slice(0, 300), "UPSTREAM_ERROR")
  }

  // 计数放在「确认上游接受了」之后：还没开始生成就失败，不该扣用户一次额度。
  // 写失败也不影响这次回答 —— 大不了少记一次，别把用户的对话掐了。
  if (target.free) {
    try {
      await consumeLabQuota(env, user.id, cfg.quotaPeriod)
    } catch (err) {
      console.error("记录 AI 实验室免费额度失败:", err)
    }
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      // 给可能存在的中间层一个「别缓冲」的提示
      "X-Accel-Buffering": "no",
      /**
       * 这次调用是「免费额度用完、自动改用你自己账号的额度」跑的。
       * 前端据此弹一条提示 —— 不弹的话用户会一头雾水：
       * 明明选的是免费模型，怎么突然开始花自己的额度了。
       */
      ...(autoFellBack ? { "X-Lab-Auto-Fallback": "1" } : {}),
    },
  })
}

/**
 * GET /api/lab/models —— 站内模型列表。
 *
 * `free: true` 表示当前处于「管理员统一 Key」模式（用户免费试用）。
 * 管理员没配 Key 时会自动退回用户自己的额度（见 lab-config.ts 的规则 2）。
 *
 * `freeModels` 是**真的免费**的那些模型名（已按白名单过滤）：
 *   · 统一 Key 模式 + 白名单为空 ⇒ 全部模型；
 *   · 统一 Key 模式 + 白名单非空 ⇒ 只有名单里、且上游确实有的模型；
 *   · 非统一 Key 模式 ⇒ 空数组。
 * 规则在服务端算一次就够了 —— 前端各自再判一遍「空 = 全部免费」迟早会分家。
 */
export async function listModels(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const cfg = await loadLabRuntimeConfig(env)
  const sk = cfg.source === "admin" ? cfg.adminKey : await resolveLabKey(env, user.id)
  const base = newApiBaseUrl(env)

  const res = await fetchWithTimeout(
    `${base}/v1/models`,
    { headers: { Authorization: `Bearer ${sk}` } },
    20_000
  )
  if (!res.ok) {
    throw new ApiError(502, "拉取模型列表失败，请稍后重试", "UPSTREAM_ERROR")
  }
  const data = (await res.json().catch(() => null)) as {
    data?: { id?: unknown }[]
  } | null
  const models = (data?.data ?? [])
    .map((m) => m?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
  models.sort((a, b) => a.localeCompare(b))

  /**
   * 站内模型白名单：只影响「站内中转站返回的这份列表」。
   * 空名单 = 不过滤（默认）。免费渠道有自己的固定模型，不走这里。
   */
  const visible =
    cfg.siteModels.length === 0 ? models : models.filter((m) => cfg.siteModels.includes(m))

  // 免费标记只在**可见**的模型上标：名单外的已经不显示了，再返回它的免费状态没有意义
  const freeModels =
    cfg.source === "admin"
      ? cfg.freeModels.length === 0
        ? visible
        : visible.filter((m) => cfg.freeModels.includes(m))
      : []

  return json({ models: visible, free: cfg.source === "admin", freeModels })
}

/**
 * GET /api/lab/channels —— 管理员提供的**免费渠道** + 免费额度余量。
 *
 * 只回 id / 名字 / 模型，**不回 baseUrl 与密钥**：渠道调用一律走服务端代理，
 * 浏览器拿到的只是一个 id。这样即使渠道密钥泄露也不出站长的机器。
 */
export async function listLabChannels(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const cfg = await loadLabRuntimeConfig(env)
  const quotaUsed = cfg.quotaLimit > 0 ? await labQuotaUsed(env, user.id, cfg.quotaPeriod) : 0

  return json({
    /** 站内模型走谁的额度：user = 自己的，admin = 管理员的（免费试用） */
    source: cfg.source,
    quotaLimit: cfg.quotaLimit,
    quotaPeriod: cfg.quotaPeriod,
    quotaUsed,
    channels: cfg.channels.map((c) => ({
      id: c.id,
      name: c.name,
      model: c.model,
      free: true as const,
    })),
  })
}

/**
 * 实验室的前端配置：系统提示词覆盖值 + 造物集的审核开关。
 *
 * 为什么要单独一个接口：agent 跑在浏览器里（解析 SSE、在内存文件系统里改文件），
 * 系统提示词得由前端拼进 messages，所以前端必须能拿到这个可配置项。
 * `reviewRequired` 也放这里 —— 造物集要据此把按钮文案从「公开」换成「提交审核」，
 * 否则用户点了「公开」却什么都没发生（进了待审队列），会以为是 bug。
 *
 * 不返回默认提示词：默认那份写在前端（`src/lib/lab-agent.ts`），
 * 空串就表示「用默认」，避免同一段长文本在前后端各存一份、改一处漏一处。
 */
export async function getLabSettings(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const agentPrompt = await getSetting(env, "lab_agent_prompt")
  const reviewRequired = (await getSetting(env, "lab_review_required")) === "1"
  /**
   * 启用中的提示词模板。用户端要在浏览器里拼系统提示词（agent 跑在前端），
   * 所以正文必须一起下发 —— 模板通常只有一两份、每份几 KB，可以接受。
   * 一份都没有时前端回退到 agentPrompt / 内置默认（见 buildSystemPrompt 的优先级）。
   */
  const templates = await loadEnabledTemplates(env)
  /**
   * 技能**索引**（只有 name + description，**不含正文**）。
   * 这就是「渐进式披露」：系统提示里只放一行行目录，让模型自己判断该不该用；
   * 真要用了它输出 <lab_skill name="…"/>，由 chat 去读全文再回喂。
   * 所以这里可以放心把索引全量下发，正文一份都不带。
   */
  const skills = await loadSkillIndex(env, user.id)
  /**
   * 联网搜索的**用户级开关**（默认关）。
   * 前端只有在这里拿到 true 时，才会把 `<lab_web_search>` 告诉模型 ——
   * 关着时模型压根不知道有这东西，也就不会去搜、不会被扣分。
   * 后端 `/api/lab/web-search` 还会再拦一道（前端能被绕过）。
   */
  return json({
    agentPrompt,
    reviewRequired,
    templates,
    skills,
    webSearch: {
      enabled: await isUserSearchEnabled(env, user.id),
      siteAvailable: (await loadSiteKeysForInfo(env)).length > 0,
      cost: await loadSearchCost(env),
    },
  })
}

// ---------------------------------------------------------------------------
// 作品 CRUD
// ---------------------------------------------------------------------------

export interface LabProjectRow {
  id: string
  user_id: string
  name: string
  slug: string
  description: string
  icon: string
  files: string
  visibility: string
  review_note: string | null
  views: number
  likes: number
  created_at: string
  updated_at: string
  published_at: string | null
  storage: string
  bucket_id: string | null
  /** R2 封面对象 key（平台桶）；NULL = 没上传，前端回退 emoji */
  cover_key: string | null
}

// ---------------------------------------------------------------------------
// 文件存储（R2 优先，未配置时回退 D1）
//
// 为什么不全塞 D1：D1 免费版**单个库**上限 500MB，作品文件（HTML/CSS/JS）
// 直接写在 lab_projects.files 里会很快吃掉它，而且行越大整表扫描越慢。
// 现在文件正文放 R2（平台桶），D1 只留「路径 → 大小」的清单。
//
//   storage = 'd1' → files 是 {"path": "<正文>"}      （历史行，读取时兼容）
//   storage = 'r2' → files 是 {"path": {"size": N}}   （正文在 lab/<uid>/<pid>/<path>）
// ---------------------------------------------------------------------------

/** 每个用户最多保存多少个作品（文件进了 R2 后没有天然上限，靠这条兜住） */
const MAX_PROJECTS_PER_USER = 50

/** 作品规模上限：文件数 / 单文件 / 合计 */
const MAX_FILES = 60
const MAX_FILE_BYTES = 800_000
const MAX_TOTAL_BYTES = 3_000_000

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
}

function contentTypeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  return CONTENT_TYPES[ext] ?? "application/octet-stream"
}

/** 收敛相对路径：去掉 ./ 与开头的 /，拒绝 .. 与奇怪字符。非法返回 null。 */
function normalizePath(raw: string): string | null {
  const p = raw.trim().replace(/^\.\//, "").replace(/^\/+/, "")
  if (!p || p.length > 120 || p.endsWith("/") || p.includes("//")) return null
  if (p.includes("..")) return null
  if (!/^[a-zA-Z0-9._\-/]+$/.test(p)) return null
  return p
}

/** 校验 files（路径 → 正文）。 */
function normalizeFiles(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError(400, "files 必须是「路径 → 内容」的对象", "INVALID_FILES")
  }
  const out: Record<string, string> = {}
  let total = 0
  for (const [path, content] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof content !== "string") continue
    const clean = normalizePath(path)
    if (!clean) continue
    if (content.length > MAX_FILE_BYTES) {
      throw new ApiError(
        413,
        `文件 ${clean} 太大（超过 800KB），精简后再保存`,
        "TOO_LARGE"
      )
    }
    out[clean] = content
    total += content.length
  }
  if (!Object.keys(out).length) {
    throw new ApiError(400, "至少需要一个文件", "INVALID_FILES")
  }
  if (Object.keys(out).length > MAX_FILES) {
    throw new ApiError(413, `文件数超过 ${MAX_FILES} 个，精简后再保存`, "TOO_LARGE")
  }
  if (total > MAX_TOTAL_BYTES) {
    throw new ApiError(413, "作品太大（合计超过 3MB），精简后再保存", "TOO_LARGE")
  }
  if (!out["index.html"]) {
    throw new ApiError(400, "缺少入口文件 index.html", "INVALID_FILES")
  }
  return out
}

type Manifest = Record<string, { size: number }>

function parseManifest(json: string): Manifest {
  try {
    const obj = JSON.parse(json || "{}") as Record<string, unknown>
    const out: Manifest = {}
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        out[k] = { size: Number((v as { size?: unknown }).size ?? 0) }
      }
    }
    return out
  } catch {
    return {}
  }
}

/**
 * 作品文件在桶里的路径：`_lab/<用户id>/<作品id>/<文件名>`。
 *
 * ⚠️ 前缀必须是**不可能被当作用户名**的名字（前导下划线）。
 * 网盘文件存在 `<用户名>/…` 下，如果这里用 `lab/`，那么一个叫「lab」的
 * 用户，他的网盘根目录会和实验室的作品目录撞在一起（互相看得见、甚至同名覆盖）。
 * `_lab/` 与用户目录彻底分开，且两边的目录结构独立，不会串。
 */
function projectPrefix(userId: string, projectId: string): string {
  return `_lab/${userId}/${projectId}/`
}

/**
 * 作品文件该放哪个桶。
 *
 * 优先放**用户自己的网盘桶**（storage_accounts.bucket_id）—— 他自己的存储，
 * 用超了也是他自己担着；没开通网盘的用户才回退到平台桶。
 * key 前缀两者一致（lab/<uid>/<pid>/），只是桶不同，所以桶 id 必须存进
 * lab_projects.bucket_id（见 0133 迁移），否则用户换桶后老作品会「消失」。
 */
async function resolveLabStorage(
  env: Env,
  userId: string
): Promise<{ bucketId: string | null; shared: boolean }> {
  const acct = await env.DB.prepare(
    "SELECT bucket_id FROM storage_accounts WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ bucket_id: string | null }>()
  if (acct?.bucket_id) return { bucketId: acct.bucket_id, shared: false }
  return { bucketId: await getPlatformBucketId(env), shared: true }
}

/**
 * 把文件写进 R2，返回清单 JSON。
 * R2 没配好时返回 null，调用方回退 D1（本地开发 / 未配置桶的环境仍可用）。
 */
async function writeFilesToR2(
  env: Env,
  userId: string,
  projectId: string,
  files: Record<string, string>,
  previousPaths: string[],
  bucketId: string | null
): Promise<string | null> {
  if (!(await isStorageConfigured(env))) return null
  const prefix = projectPrefix(userId, projectId)
  const manifest: Manifest = {}
  const tasks: Promise<unknown>[] = []
  for (const [path, content] of Object.entries(files)) {
    tasks.push(putObject(env, prefix + path, content, contentTypeFor(path), bucketId))
    manifest[path] = { size: content.length }
  }
  // 本轮删掉的文件，R2 上也要删（否则改个文件名就永久留垃圾）
  for (const path of previousPaths) {
    if (!(path in files)) tasks.push(deleteObject(env, prefix + path, bucketId))
  }
  await Promise.all(tasks)
  return JSON.stringify(manifest)
}

/** 读出作品的完整文件内容（兼容历史的 D1 存储行）。 */
export async function readFiles(
  env: Env,
  row: LabProjectRow
): Promise<Record<string, string>> {
  if (row.storage !== "r2") {
    try {
      return JSON.parse(row.files || "{}") as Record<string, string>
    } catch {
      return {}
    }
  }
  const manifest = parseManifest(row.files)
  // 认作品自己记下的桶，不去猜「当前该用户的桶」
  const bucketId = row.bucket_id
  const prefix = projectPrefix(row.user_id, row.id)
  const pairs = await Promise.all(
    Object.keys(manifest).map(async (p) => {
      try {
        const res = await getObject(env, prefix + p, undefined, bucketId)
        return [p, await res.text()] as const
      } catch {
        // 单个文件丢失不该让整个作品打不开
        return [p, ""] as const
      }
    })
  )
  return Object.fromEntries(pairs)
}

/** 上一次保存过的文件路径（用于算出「这次删了哪些」）。 */
function previousPaths(row: LabProjectRow): string[] {
  if (row.storage === "r2") return Object.keys(parseManifest(row.files))
  try {
    return Object.keys(JSON.parse(row.files || "{}"))
  } catch {
    return []
  }
}

/** 删作品时清空它在 R2 上的整个前缀（尽力而为，失败只记日志）。 */
async function purgeProjectFiles(env: Env, row: LabProjectRow): Promise<void> {
  if (row.storage !== "r2") return
  try {
    await deletePrefix(env, projectPrefix(row.user_id, row.id), 5, row.bucket_id)
  } catch (err) {
    console.error("清理作品 R2 文件失败:", err)
  }
}

/** 由作品名生成 URL 友好 slug；中文名等会得到空串，用 id 前缀兜底。 */
function slugify(name: string, fallback: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return base || `p-${fallback.replace(/[^a-z0-9]/gi, "").slice(0, 8)}`
}

async function uniqueSlug(
  env: Env,
  userId: string,
  name: string,
  fallback: string,
  excludeId?: string
): Promise<string> {
  const base = slugify(name, fallback)
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`
    const row = await env.DB.prepare(
      "SELECT id FROM lab_projects WHERE user_id = ? AND slug = ? AND id != ?"
    )
      .bind(userId, candidate, excludeId ?? "")
      .first()
    if (!row) return candidate
  }
  return `${base}-${Date.now().toString(36)}`
}

/**
 * 从封面 key 里取出「版本号」。
 *
 * key 的样式是 `lab-cover/<uid>/<pid>-<token>.<ext>`（token 由上传时生成）。
 * 前端把它拼到封面 URL 的 `?v=` 上 —— 换封面 ⇒ token 变 ⇒ URL 变 ⇒ 缓存立刻失效。
 * 老数据（升级前上传的）没有 token，返回空串，前端就不带 `?v`，行为与以前一致。
 */
export function coverVersionOf(key: string | null | undefined): string {
  if (!key) return ""
  const file = key.split("/").pop() ?? ""
  const stem = file.replace(/\.[a-z0-9]+$/i, "")
  const i = stem.lastIndexOf("-")
  return i === -1 ? "" : stem.slice(i + 1)
}

function toClientJson(row: LabProjectRow, files?: Record<string, string>) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    icon: row.icon,
    description: row.description,
    visibility: row.visibility,
    /** 审核驳回理由；只在 visibility='rejected' 时有值 */
    reviewNote: row.review_note ?? "",
    /** 有上传过封面图时为 true（前端据此决定用图片还是 emoji） */
    hasCover: !!row.cover_key,
    /** 封面版本号 —— 必须带回前端拼进 URL，否则换图后仍显示缓存里的旧图 */
    coverV: coverVersionOf(row.cover_key),
    views: row.views,
    likes: row.likes,
    storage: row.storage,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    ...(files ? { files } : {}),
  }
}

async function loadProject(
  env: Env,
  id: string,
  userId: string
): Promise<LabProjectRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM lab_projects WHERE id = ? AND user_id = ?"
  )
    .bind(id, userId)
    .first<LabProjectRow>()
  if (!row) throw new ApiError(404, "作品不存在", "NOT_FOUND")
  return row
}

/** GET /api/lab/projects —— 我的作品列表（不含文件内容）。 */
export async function listProjects(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const rows = await env.DB.prepare(
    `SELECT id, user_id, name, slug, icon, description, visibility, review_note,
            views, likes, created_at, updated_at, published_at, storage, bucket_id,
            cover_key, '' AS files
     FROM lab_projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200`
  )
    .bind(user.id)
    .all<LabProjectRow>()
  return json({ projects: (rows.results ?? []).map((r) => toClientJson(r)) })
}

/** GET /api/lab/projects/:id —— 单个作品（含文件内容，编辑器用）。 */
export async function getProject(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const user = await requireUser(env, request)
  const row = await loadProject(env, id, user.id)
  return json({ project: toClientJson(row, await readFiles(env, row)) })
}

/** POST /api/lab/projects —— 新建（无 id）或更新（带 id）作品。 */
export async function saveProject(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)

  const body = (await request.json().catch(() => null)) as {
    id?: unknown
    name?: unknown
    description?: unknown
    icon?: unknown
    files?: unknown
  } | null
  if (!body) throw new ApiError(400, "请求体不是合法 JSON", "INVALID_BODY")

  const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : ""
  if (!name) throw new ApiError(400, "给作品起个名字", "INVALID_NAME")
  const description =
    typeof body.description === "string"
      ? body.description.trim().slice(0, 200)
      : ""
  const icon =
    typeof body.icon === "string" && body.icon.trim()
      ? body.icon.trim().slice(0, 8)
      : "🌐"
  const files = normalizeFiles(body.files)
  const now = new Date().toISOString()
  const { bucketId } = await resolveLabStorage(env, user.id)

  const id = typeof body.id === "string" && body.id ? body.id : null
  if (id) {
    const existing = await loadProject(env, id, user.id)
    const slug = await uniqueSlug(env, user.id, name, existing.slug, id)
    // 先写文件再改行：宁可留几个 R2 孤儿对象，也不要「行在、文件没了」
    const manifest = await writeFilesToR2(
      env,
      user.id,
      id,
      files,
      previousPaths(existing),
      bucketId
    )
    await env.DB.prepare(
      `UPDATE lab_projects
       SET name = ?, slug = ?, description = ?, icon = ?, files = ?, storage = ?,
           bucket_id = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`
    )
      .bind(
        name,
        slug,
        description,
        icon,
        manifest ?? JSON.stringify(files),
        manifest ? "r2" : "d1",
        manifest ? bucketId : null,
        now,
        id,
        user.id
      )
      .run()
    const fresh = await loadProject(env, id, user.id)
    return json({ project: toClientJson(fresh, await readFiles(env, fresh)) })
  }

  // 数量上限：文件在 R2 里没有 D1 那样的天然约束，靠这条拦住无节制占用
  const countRow = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM lab_projects WHERE user_id = ?"
  )
    .bind(user.id)
    .first<{ c: number }>()
  if ((countRow?.c ?? 0) >= MAX_PROJECTS_PER_USER) {
    throw new ApiError(
      413,
      `最多保存 ${MAX_PROJECTS_PER_USER} 个作品，先删掉一些再存`,
      "TOO_MANY_PROJECTS"
    )
  }

  const newId = uuid()
  const slug = await uniqueSlug(env, user.id, name, newId)
  const manifest = await writeFilesToR2(env, user.id, newId, files, [], bucketId)
  await env.DB.prepare(
    `INSERT INTO lab_projects
       (id, user_id, name, slug, description, icon, files, storage, bucket_id,
        visibility, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'private', ?, ?)`
  )
    .bind(
      newId,
      user.id,
      name,
      slug,
      description,
      icon,
      manifest ?? JSON.stringify(files),
      manifest ? "r2" : "d1",
      manifest ? bucketId : null,
      now,
      now
    )
    .run()
  const created = await loadProject(env, newId, user.id)
  return json({ project: toClientJson(created, files) }, 201)
}

/** DELETE /api/lab/projects/:id */
export async function deleteProject(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const user = await requireUser(env, request)
  const existing = await loadProject(env, id, user.id)
  // 先删行再清 R2：万一清理失败只会留孤儿对象，不会留下「行在、文件没了」的坏作品
  await env.DB.prepare("DELETE FROM lab_projects WHERE id = ?").bind(id).run()
  await purgeProjectFiles(env, existing)
  // 封面在平台桶，和作品文件不在一个前缀里，要单独清
  if (existing.cover_key && (await isStorageConfigured(env))) {
    try {
      await deleteObject(env, existing.cover_key, await getPlatformBucketId(env))
    } catch {
      /* 尽力而为 */
    }
  }
  return new Response(null, { status: 204 })
}

// ---------------------------------------------------------------------------
// 造物集（作品公开托管 + 展示大厅）
//
// 与「实验室里的作品」是同一张表（lab_projects）、同一份 R2 文件，区别只在可见性：
//   private（默认，只有自己） / public（进展示大厅，别人能看）
// 所以这里不需要新的存储层 —— 公开 = 把 visibility 翻成 public，并补上对外信息。
//
// ⚠️ 公开作品给**别人**看时，只能在 `sandbox` 且**不带 allow-same-origin** 的 iframe 里渲染
//    （前端的 buildPreviewDoc + srcDoc）。否则作品脚本能带着会话 cookie 调 /api/*，
//    等于把整个站点的身份交出去。
// ---------------------------------------------------------------------------

const GALLERY_PAGE_SIZE = 24

/** lab_projects 行 + 作者信息 */
interface GalleryRow extends LabProjectRow {
  author_name: string
  /** 真实用户名 —— 头像 URL 是 /u/<用户名>/avatar，必须用它 */
  author_username: string
  author_avatar: string | null
  /** 当前访问者有没有赞过（SQL 里 LEFT JOIN 出来，0/1） */
  liked: number
}

/** R2/D1 两种存储下都能算出文件路径清单 */
function filePathsOf(row: LabProjectRow): string[] {
  return previousPaths(row)
}

/**
 * 作品里有没有 HTML 入口。
 * 没有的话公开出去别人打开只会是一片空白 —— 这种「假公开」不如直接拒绝，
 * 免得作者以为发出去了、访客却什么都看不到。
 */
function hasHtmlEntry(row: LabProjectRow): boolean {
  return filePathsOf(row).some((p) => p.toLowerCase().endsWith(".html"))
}

function toGalleryJson(row: GalleryRow, isOwner: boolean) {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    description: row.description,
    /** 有封面图时前端直接用 /api/gallery/:id/cover 当背景，否则回退 emoji */
    hasCover: !!row.cover_key,
    /** 封面版本号：拼进封面 URL，换图后立刻生效（不带就会被缓存旧图） */
    coverV: coverVersionOf(row.cover_key),
    views: row.views,
    likes: row.likes,
    /** 我有没有赞过（决定按钮是不是已点亮） */
    liked: !!row.liked,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    authorName: row.author_name,
    authorUsername: row.author_username,
    authorAvatar: row.author_avatar,
    /** 只有 public 的作品才有可分享链接（`tyu.me/p/<id>`） */
    visibility: row.visibility,
    isMine: isOwner,
  }
}

/**
 * POST /api/lab/projects/:id/publish —— 公开 / 取消公开，并顺手更新对外信息。
 *
 * 为什么和「保存作品」分开：保存是编辑动作（改一行代码就会调一次），
 * 公开是对外承诺（名字 / 简介 / 可见性）。混在一起就会出
 * 「改个背景色顺手把简介清空了」这种事。
 */
export async function publishProject(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const user = await requireUser(env, request)
  const row = await loadProject(env, id, user.id)

  const body = (await request.json().catch(() => null)) as {
    visibility?: unknown
    name?: unknown
    description?: unknown
    icon?: unknown
  } | null
  if (!body) throw new ApiError(400, "请求体不是合法 JSON", "INVALID_BODY")

  const wantPublic = body.visibility === "public"
  const name =
    typeof body.name === "string" ? body.name.trim().slice(0, 60) : row.name
  if (!name) throw new ApiError(400, "给作品起个名字", "INVALID_NAME")
  const description =
    typeof body.description === "string"
      ? body.description.trim().slice(0, 200)
      : row.description
  const icon =
    typeof body.icon === "string" && body.icon.trim()
      ? body.icon.trim().slice(0, 8)
      : row.icon

  if (wantPublic && !hasHtmlEntry(row)) {
    throw new ApiError(
      400,
      "这个作品里没有 HTML 文件，公开出去别人打开会是空白页 —— 先让 AI 生成一个 index.html",
      "NO_HTML_ENTRY"
    )
  }

  const now = new Date().toISOString()

  /**
   * 没带 `visibility` ⇒ 只改对外信息，**可见性原样不动**。
   *
   * 这条不是可有可无的便利：编辑一个「待审核」作品的名字时如果顺手把可见性
   * 当成 private 写回去，用户的公开申请就被悄悄撤了，而他完全不知情。
   * 所以「改名/改简介」和「改可见性」必须是两件事。
   */
  if (body.visibility !== "public" && body.visibility !== "private") {
    await env.DB.prepare(
      `UPDATE lab_projects SET name = ?, description = ?, icon = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`
    )
      .bind(name, description, icon, now, id, user.id)
      .run()
    const kept = await loadProject(env, id, user.id)
    return json({ project: toClientJson(kept) })
  }

  /**
   * 可见性流转：
   *   · 取消公开            → private（顺手清掉旧的驳回理由）
   *   · 已经是公开的作品改介绍 → 保持 public，**不重新送审**（否则改个简介都要等审核）
   *   · 非公开 → 公开，且开着审核 → pending（进管理端待审队列）
   *   · 非公开 → 公开，且关着审核 → public（老行为）
   */
  const reviewRequired = (await getSetting(env, "lab_review_required")) === "1"
  const wasPublic = row.visibility === "public"
  let visibility: string
  if (!wantPublic) visibility = "private"
  else if (wasPublic) visibility = "public"
  else visibility = reviewRequired ? "pending" : "public"

  await env.DB.prepare(
    `UPDATE lab_projects
     SET name = ?, description = ?, icon = ?, visibility = ?, review_note = NULL,
         published_at = CASE WHEN ? = 'public' THEN COALESCE(published_at, ?) ELSE published_at END,
         updated_at = ?
     WHERE id = ? AND user_id = ?`
  )
    .bind(name, description, icon, visibility, visibility, now, now, id, user.id)
    .run()

  const fresh = await loadProject(env, id, user.id)
  return json({ project: toClientJson(fresh) })
}

/** GET /api/gallery —— 展示大厅：全体用户的公开作品（分页 + 关键词） */
export async function listGallery(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const url = new URL(request.url)
  const rawPage = Number(url.searchParams.get("page") ?? "1")
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.min(500, Math.trunc(rawPage))) : 1
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 40)

  // 只展示**正常账号**的公开作品：被封禁用户的作品不该继续挂在大厅里
  const where = ["p.visibility = 'public'", "u.status = 'active'"]
  const binds: unknown[] = []
  if (q) {
    where.push("(p.name LIKE ? OR p.description LIKE ?)")
    binds.push(likeContains(q), likeContains(q))
  }
  const whereSql = where.join(" AND ")

  const [totalRow, rows] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS c FROM lab_projects p JOIN users u ON u.id = p.user_id WHERE ${whereSql}`
    )
      .bind(...binds)
      .first<{ c: number }>(),
    env.DB.prepare(
      `SELECT p.*, COALESCE(NULLIF(u.nickname, ''), u.username) AS author_name,
              u.username AS author_username,
              u.avatar_key AS author_avatar,
              CASE WHEN l.user_id IS NULL THEN 0 ELSE 1 END AS liked
       FROM lab_projects p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN lab_project_likes l ON l.project_id = p.id AND l.user_id = ?
       WHERE ${whereSql}
       ORDER BY p.published_at DESC, p.updated_at DESC
       LIMIT ? OFFSET ?`
    )
      .bind(user.id, ...binds, GALLERY_PAGE_SIZE, (page - 1) * GALLERY_PAGE_SIZE)
      .all<GalleryRow>(),
  ])

  return json({
    total: totalRow?.c ?? 0,
    page,
    pageSize: GALLERY_PAGE_SIZE,
    items: (rows.results ?? []).map((r) => toGalleryJson(r, r.user_id === user.id)),
  })
}

/**
 * GET /api/gallery/:id —— 公开作品详情（含文件内容），顺带计一次浏览。
 *
 * 本人也能看（比如从「我的造物集」点进自己未公开的作品），但**本人访问不计浏览数** ——
 * 否则作者自己刷新几下就把数字刷起来了。
 */
export async function getGalleryItem(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const user = await requireUser(env, request)
  const row = await env.DB.prepare(
    `SELECT p.*, COALESCE(NULLIF(u.nickname, ''), u.username) AS author_name,
            u.username AS author_username,
            u.avatar_key AS author_avatar,
            CASE WHEN l.user_id IS NULL THEN 0 ELSE 1 END AS liked
     FROM lab_projects p
     JOIN users u ON u.id = p.user_id
     LEFT JOIN lab_project_likes l ON l.project_id = p.id AND l.user_id = ?
     WHERE p.id = ? AND (p.visibility = 'public' OR p.user_id = ?)`
  )
    .bind(user.id, id, user.id)
    .first<GalleryRow>()
  if (!row) throw new ApiError(404, "作品不存在或未公开", "NOT_FOUND")

  const isOwner = row.user_id === user.id
  if (!isOwner) {
    await env.DB.prepare(
      "UPDATE lab_projects SET views = views + 1 WHERE id = ?"
    )
      .bind(id)
      .run()
    row.views += 1
  }

  const files = await readFiles(env, row)
  return json({ project: { ...toGalleryJson(row, isOwner), files } })
}

// ---------------------------------------------------------------------------
// 点赞（造物集）
// ---------------------------------------------------------------------------

/**
 * POST /api/gallery/:id/like —— 点赞 / 取消点赞（同一个接口来回切）。
 *
 * 「一个用户对一个作品只有一票」由 `lab_project_likes` 的复合主键保证，
 * 不靠应用层先查再写 —— 双击、并发请求下那种写法必然多算。
 *
 * 计数用「先动明细、再按明细重算」：`likes` 只是明细的缓存，
 * 任何时刻都能从 `COUNT(*)` 重建，绝不让两者各自漂移。
 */
export async function likeGalleryItem(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const user = await requireUser(env, request)

  // 只能给「公开且作者正常」的作品点赞（未公开的作品压根不在大厅里）
  const row = await env.DB.prepare(
    `SELECT p.id, p.user_id FROM lab_projects p
     JOIN users u ON u.id = p.user_id
     WHERE p.id = ? AND p.visibility = 'public' AND u.status = 'active'`
  )
    .bind(id)
    .first<{ id: string; user_id: string }>()
  if (!row) throw new ApiError(404, "作品不存在或未公开", "NOT_FOUND")

  const now = new Date().toISOString()

  // 先尝试插入；插进去了说明这次是「点赞」，没插进去说明本来就已经赞过 → 改为取消
  const ins = await env.DB.prepare(
    "INSERT INTO lab_project_likes (project_id, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING"
  )
    .bind(id, user.id, now)
    .run()
  const added = (ins.meta?.changes ?? 0) > 0

  if (!added) {
    await env.DB.prepare(
      "DELETE FROM lab_project_likes WHERE project_id = ? AND user_id = ?"
    )
      .bind(id, user.id)
      .run()
  }

  // 按明细重算计数（而不是 +1/-1）：这样即使历史上计数被写歪过，也会自动纠正回来
  const counted = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM lab_project_likes WHERE project_id = ?"
  )
    .bind(id)
    .first<{ c: number }>()
  const likes = counted?.c ?? 0
  await env.DB.prepare("UPDATE lab_projects SET likes = ? WHERE id = ?")
    .bind(likes, id)
    .run()

  return json({ likes, liked: added })
}

// ---------------------------------------------------------------------------
// 分享页：把公开作品吐成一份「谁都能打开」的 HTML
//
// 造物集的分享链接是 `https://tyu.me/p/<id>` —— 那个壳页里的 iframe 直接把这个
// 接口当 src 用，所以这里**不能要求登录**，只认「作品已公开 + 作者账号正常」。
// ---------------------------------------------------------------------------

/**
 * GET /api/gallery/:id/raw —— 公开作品的可直接打开版本（单文件内联）。
 *
 * 🔴 安全红线：响应体是**用户自己写的 HTML**，绝不能让它以本站源的身份运行。
 *    必须由**响应头**下发 `Content-Security-Policy: sandbox …`（且**不含** allow-same-origin）：
 *    它把文档降级成不透明源 —— 拿不到本站 cookie、读不到 localStorage、也调不了 /api/*。
 *    ⚠️ 不能改用 <meta http-equiv>：规范上 `sandbox` 指令经 meta 下发会被忽略。
 */
export async function serveGalleryRaw(
  env: Env,
  _request: Request,
  id: string
): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT p.* FROM lab_projects p
     JOIN users u ON u.id = p.user_id
     WHERE p.id = ? AND p.visibility = 'public' AND u.status = 'active'`
  )
    .bind(id)
    .first<LabProjectRow>()
  if (!row) return new Response("Not Found", { status: 404 })

  const doc = buildPreviewDoc(await readFiles(env, row))
  if (!doc) return new Response("Not Found", { status: 404 })

  const headers = new Headers({
    "content-type": "text/html;charset=utf-8",
    // 沙箱：脚本/弹窗/表单允许（作品要用），但**不给同源** ⇒ 不透明源
    "content-security-policy":
      "sandbox allow-scripts allow-modals allow-forms allow-popups",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    // 作品可能随时被作者改，别让边缘缓存拿太久
    "cache-control": "public, max-age=60",
  })
  return new Response(doc, { status: 200, headers })
}

// ---------------------------------------------------------------------------
// 作品封面（上传图片，替代单一的 emoji）
//
// 封面体积小、又要在展示大厅给所有人看，所以固定放**平台桶**，
// key = lab-cover/<uid>/<pid>.<ext>。跟作品文件的桶（用户自己的网盘桶）刻意分开：
// 封面是公开资源，不该因为用户换/删网盘桶而消失。
// ---------------------------------------------------------------------------

/** 封面允许的图片类型（与头像同一口径） */
const COVER_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
}
/** 封面大小上限：600 KB（前端会先压缩，这个值只是服务端的硬闸） */
const COVER_MAX_BYTES = 600 * 1024

/**
 * 封面对象 key。
 *
 * ⚠️ 带上一段**版本号**（token）是有意的：封面接口对外只有
 * `/api/gallery/:id/cover` 这一个固定地址，如果对象 key 也固定，换图后
 * URL 不变 ⇒ 浏览器与边缘节点会继续吐旧图（2026-10-09 站长反馈「换封面一直是第一张」）。
 * 带上 token 后：新图 = 新 URL，缓存自然失效；旧对象在写入成功后删掉。
 */
function coverKeyOf(userId: string, projectId: string, ext: string, token: string): string {
  return `lab-cover/${userId}/${projectId}-${token}.${ext}`
}

/** 升级前的无 token 老 key（换图时顺手清掉，避免残留） */
function legacyCoverKeyOf(userId: string, projectId: string, ext: string): string {
  return `lab-cover/${userId}/${projectId}.${ext}`
}

/** POST /api/lab/projects/:id/cover —— 上传作品封面（原图直传，≤600KB） */
export async function uploadProjectCover(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const user = await requireUser(env, request)
  await guardRateLimit(env, `lab-cover:${user.id}`, 20, 60, "封面上传过于频繁")
  const row = await loadProject(env, id, user.id)

  if (!(await isStorageConfigured(env))) {
    throw new ApiError(503, "存储未配置，无法上传封面", "R2_NOT_CONFIGURED")
  }
  const contentType = (request.headers.get("Content-Type") ?? "").split(";")[0].trim()
  const ext = COVER_TYPES[contentType]
  if (!ext) throw new ApiError(400, "仅支持 JPG / PNG / WebP / GIF", "INVALID_TYPE")

  const buf = await readBodyCapped(
    request,
    COVER_MAX_BYTES,
    "封面过大，上限 600 KB",
    400,
    "TOO_LARGE"
  )
  if (buf.byteLength === 0) throw new ApiError(400, "文件为空", "INVALID_INPUT")

  const bucketId = await getPlatformBucketId(env)
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const key = coverKeyOf(user.id, id, ext, token)
  await putObject(env, key, buf, contentType, bucketId)

  // 写入成功后清理旧对象：上一版封面 + 升级前遗留的无 token 各扩展名版本。
  // 都是「尽力而为」——删不掉只留孤儿对象，不影响正确性。
  const stale = new Set<string>()
  if (row.cover_key && row.cover_key !== key) stale.add(row.cover_key)
  for (const e of Object.values(COVER_TYPES)) {
    stale.add(legacyCoverKeyOf(user.id, id, e))
  }
  stale.delete(key)
  for (const oldKey of stale) {
    try {
      await deleteObject(env, oldKey, bucketId)
    } catch {
      /* 尽力而为 */
    }
  }

  await env.DB.prepare("UPDATE lab_projects SET cover_key = ?, updated_at = ? WHERE id = ?")
    .bind(key, new Date().toISOString(), row.id)
    .run()
  return json({ hasCover: true, coverV: coverVersionOf(key) })
}

/** DELETE /api/lab/projects/:id/cover —— 移除封面（回退 emoji） */
export async function deleteProjectCover(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const user = await requireUser(env, request)
  const row = await loadProject(env, id, user.id)
  if (await isStorageConfigured(env)) {
    const bucketId = await getPlatformBucketId(env)
    // 当前这一版（带 token）+ 升级前遗留的无 token 老 key，全部清掉
    const keys = new Set<string>()
    if (row.cover_key) keys.add(row.cover_key)
    for (const ext of Object.values(COVER_TYPES)) {
      keys.add(legacyCoverKeyOf(user.id, id, ext))
    }
    for (const key of keys) {
      try {
        await deleteObject(env, key, bucketId)
      } catch {
        /* 尽力而为 */
      }
    }
  }
  await env.DB.prepare("UPDATE lab_projects SET cover_key = NULL, updated_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), row.id)
    .run()
  return json({ hasCover: false })
}

/**
 * GET /api/gallery/:id/cover —— 读取封面字节流。
 *
 * 公开作品任何人可读；未公开的作品只有作者本人能读（「我的造物集」里要显示自己的封面）。
 * ⚠️ 走 `hardenUserContentResponse`：这是用户上传的字节，
 * 不能让它带着 image/svg+xml 之类的类型在主源上被当文档渲染。
 */
export async function serveGalleryCover(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const user = await requireUser(env, request)
  if (!(await isStorageConfigured(env))) return new Response("Not Found", { status: 404 })

  const row = await env.DB.prepare(
    "SELECT cover_key FROM lab_projects WHERE id = ? AND (visibility = 'public' OR user_id = ?)"
  )
    .bind(id, user.id)
    .first<{ cover_key: string | null }>()
  if (!row?.cover_key) return new Response("Not Found", { status: 404 })

  const bucketId = await getPlatformBucketId(env)
  try {
    const res = await getObject(env, row.cover_key, undefined, bucketId)
    const headers = new Headers(res.headers)
    // 封面内容不会变（换图 = 换 key/覆盖同名），给个短缓存即可
    headers.set("Cache-Control", "public, max-age=300")
    headers.set("X-Content-Type-Options", "nosniff")
    return hardenUserContentResponse(
      new Response(res.body, { status: res.status, headers }),
      row.cover_key.split("/").pop() || "cover"
    )
  } catch {
    return new Response("Not Found", { status: 404 })
  }
}
