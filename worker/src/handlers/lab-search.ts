/**
 * AI 实验室的「联网搜索」（Tavily）。
 *
 * 两条 key 来源，**用户填了自己的就用自己的，没填才回落到站点 key**：
 *   · 用户自己的 key：存在 `lab_user_settings.tavily_key_enc`（密文），**不扣积分**；
 *   · 站点 key：管理面板维护的 `app_settings.lab_tavily_keys`（一个字符串放多把，
 *     与 `brevo_api_key` 同一口径），**走它要扣积分**（每次多少由
 *     `lab_tavily_credit_cost` 决定，默认 5）。
 *
 * 为什么允许用站点 key 扣积分：站长要的是「用户可以直接用，但站点不能被白嫖」。
 * 用自己的 key 是免费的替代路径 —— 不想花积分的人有出路，站点也不用替他付钱。
 *
 * ⚠️ key 只以明文出现在服务端内存里：接口对外只回「有没有配 / 打码后的样子」，
 *    永远不回内容（同 `handlers/storage.ts` 里 R2 凭据的处理口径）。
 */
import { ApiError, json } from "../http"
import { requireUser } from "../auth"
import { requireAdminScope } from "./admin"
import { audit as recordAudit, getSetting, getSettings, updateSettings } from "../settings"
import { decryptSecret, encryptSecret } from "../crypto"
import { applyPoints, getPointsBalance } from "../points"
import type { Env } from "../env"

/** 一次最多返回几条搜索结果（Tavily 上限 20；5 条足够模型判断，也省 token） */
const MAX_RESULTS = 5
/** 单次搜索的等待上限（毫秒）—— 超时就当失败，别把整轮对话卡死 */
const SEARCH_TIMEOUT_MS = 20_000
/** 一次对话里最多能搜几次（防模型打转把额度刷光） */
export const SEARCH_MAX_PER_TURN = 8

/** 站点 key 的解析口径：换行或逗号分隔，去空去重 */
export function parseTavilyKeys(raw: string): string[] {
  return Array.from(
    new Set(
      (raw ?? "")
        .split(/[\n,]/)
        .map((k) => k.trim())
        .filter(Boolean)
    )
  )
}

/** 打码：只露头 10 位与尾 4 位（Tavily 的 key 形如 tvly-dev-xxxxx…） */
export function maskTavilyKey(key: string): string {
  if (key.length <= 16) return `${key.slice(0, 4)}****`
  return `${key.slice(0, 10)}…${key.slice(-4)}`
}

/** 站点有没有配 key（只回数量，不回内容；给 getLabSettings 用） */
export async function loadSiteKeysForInfo(env: Env): Promise<string[]> {
  return loadSiteKeys(env)
}

/** 读站点 key 列表（明文，仅服务端内部用） */
async function loadSiteKeys(env: Env): Promise<string[]> {
  const raw = await getSetting(env, "lab_tavily_keys")
  return parseTavilyKeys(raw)
}

/** 读「每次扣多少积分」，非法值回落到 5 */
export async function loadSearchCost(env: Env): Promise<number> {
  const raw = await getSetting(env, "lab_tavily_credit_cost")
  const n = Math.floor(Number(raw))
  return Number.isFinite(n) && n >= 0 ? n : 5
}

/**
 * 读用户的整行设置。
 * ⚠️ 没有行 = 全都是默认值（**联网搜索默认关**）—— 新用户不该被默认扣分。
 */
async function loadUserRow(
  env: Env,
  userId: string
): Promise<{ tavily_key_enc: string | null; web_search_enabled: number }> {
  const row = await env.DB.prepare(
    "SELECT tavily_key_enc, web_search_enabled FROM lab_user_settings WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ tavily_key_enc: string | null; web_search_enabled: number }>()
  return { tavily_key_enc: row?.tavily_key_enc ?? null, web_search_enabled: row?.web_search_enabled ?? 0 }
}

/** 用户有没有打开「联网搜索」开关（默认关） */
export async function isUserSearchEnabled(env: Env, userId: string): Promise<boolean> {
  return (await loadUserRow(env, userId)).web_search_enabled === 1
}

/** 读用户自己的 key（解密失败按「没配」处理，别把整个搜索功能搞挂） */
export async function loadUserSearchKey(env: Env, userId: string): Promise<string | null> {
  const row = await loadUserRow(env, userId)
  if (!row.tavily_key_enc) return null
  try {
    return await decryptSecret(row.tavily_key_enc, env.SESSION_SECRET ?? "")
  } catch {
    return null
  }
}

interface TavilyResult {
  title?: string
  url?: string
  content?: string
  score?: number
}

interface TavilyResponse {
  answer?: string
  results?: TavilyResult[]
}

/** 调一次 Tavily。失败抛 ApiError，调用方决定是换 key 还是放弃。 */
async function callTavily(apiKey: string, query: string): Promise<TavilyResponse> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS)
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        // 新式鉴权走 header；旧的 body.api_key 官方仍兼容，这里用前者
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        include_answer: true,
        max_results: MAX_RESULTS,
      }),
      signal: ctrl.signal,
    })
    if (res.status === 401 || res.status === 403) {
      throw new ApiError(502, "搜索服务的 key 无效或已失效", "TAVILY_KEY_INVALID")
    }
    if (res.status === 429) {
      throw new ApiError(502, "搜索服务当前额度已用完", "TAVILY_QUOTA_EXCEEDED")
    }
    if (!res.ok) {
      throw new ApiError(502, `搜索服务返回 ${res.status}`, "TAVILY_ERROR")
    }
    return (await res.json()) as TavilyResponse
  } catch (err) {
    if (err instanceof ApiError) throw err
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new ApiError(504, "搜索超时，稍后再试", "TAVILY_TIMEOUT")
    }
    throw new ApiError(502, "连不上搜索服务", "TAVILY_ERROR")
  } finally {
    clearTimeout(timer)
  }
}

/** 把 Tavily 的返回压成给模型看的一段文字（省得模型自己去啃 JSON） */
function formatResults(query: string, data: TavilyResponse): string {
  const lines: string[] = [`[联网搜索] ${query}`]
  if (data.answer?.trim()) lines.push(`摘要：${data.answer.trim()}`)
  const items = (data.results ?? []).slice(0, MAX_RESULTS)
  if (items.length) {
    lines.push("结果：")
    items.forEach((r, i) => {
      const body = (r.content ?? "").replace(/\s+/g, " ").trim()
      lines.push(`${i + 1}. ${r.title ?? "(无标题)"} — ${r.url ?? ""}\n   ${body.slice(0, 600)}`)
    })
  } else if (!data.answer?.trim()) {
    lines.push("（没有返回结果）")
  }
  lines.push("请基于以上信息回答；引用时把来源链接一并给出。")
  return lines.join("\n")
}

/**
 * POST /api/lab/web-search
 * body: { query: string }
 *
 * 计费口径：**先搜成功、再扣分**。这样「搜失败还扣钱」的情况不会发生，
 * 也不用写退款补偿逻辑。代价是理论上存在「余额刚好花完时并发多扣一次」的窗口 ——
 * 对每次几分钱的场景，这个取舍换来的是少一整条退款链路。
 */
export async function webSearch(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json().catch(() => null)) as { query?: unknown } | null
  const query = typeof body?.query === "string" ? body.query.trim().slice(0, 400) : ""
  if (!query) throw new ApiError(400, "缺少搜索关键词", "INVALID_QUERY")

  /**
   * ⚠️ 开关的**第二道**（第一道在前端：没打开就压根不告诉模型有这个工具）。
   * 前端可以被绕过，而这里是真花钱的动作，所以必须自己再查一遍。
   * 默认关 ⇒ 新用户不做任何操作就不会被扣分。
   */
  if (!(await isUserSearchEnabled(env, user.id))) {
    throw new ApiError(
      403,
      "你还没有启用联网搜索。到输入框「+」菜单的「联网搜索」里把开关打开即可。",
      "SEARCH_DISABLED_BY_USER"
    )
  }

  // 1) 优先用户自己的 key
  const own = await loadUserSearchKey(env, user.id)
  if (own) {
    const data = await callTavily(own, query)
    return json({ text: formatResults(query, data), charged: 0, source: "own" })
  }

  // 2) 回落到站点 key
  const keys = await loadSiteKeys(env)
  if (!keys.length) {
    throw new ApiError(
      400,
      "站点没有配置联网搜索，你也没有填自己的 key。去「设置」里填一把自己的 Tavily key 即可使用。",
      "NO_SEARCH_KEY"
    )
  }

  const cost = await loadSearchCost(env)
  if (cost > 0) {
    const balance = await getPointsBalance(env, user.id)
    if (balance < cost) {
      throw new ApiError(
        400,
        `积分不足：走站点搜索每次扣 ${cost} 积分，你当前有 ${balance}。也可以填自己的 key（免费）。`,
        "INSUFFICIENT_POINTS"
      )
    }
  }

  // 一把 key 被限流/失效就换下一把 —— 这是配多把的主要意义
  let lastErr: unknown = null
  for (const key of keys) {
    try {
      const data = await callTavily(key, query)
      if (cost > 0) {
        // 搜成功了才扣。dedupKey 不用给：每次搜索本来就该各扣一次
        await applyPoints(env, {
          userId: user.id,
          delta: -cost,
          reason: "lab_search",
          detail: `联网搜索：${query.slice(0, 60)}`,
        })
      }
      return json({ text: formatResults(query, data), charged: cost, source: "site" })
    } catch (err) {
      lastErr = err
      // key 无效 / 额度用完 ⇒ 值得试下一把；其余错误（超时、网络）直接抛
      if (
        err instanceof ApiError &&
        (err.code === "TAVILY_KEY_INVALID" || err.code === "TAVILY_QUOTA_EXCEEDED")
      ) {
        continue
      }
      throw err
    }
  }
  throw lastErr instanceof ApiError
    ? lastErr
    : new ApiError(502, "所有搜索 key 都不可用", "TAVILY_ERROR")
}

/* ------------------------------------------------------------------ */
/* 用户自己的 key                                                      */
/* ------------------------------------------------------------------ */

/** GET /api/lab/search-key —— 只回「有没有配」，不回内容 */
export async function getMySearchKey(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const row = await env.DB.prepare(
    "SELECT tavily_key_enc FROM lab_user_settings WHERE user_id = ?"
  )
    .bind(user.id)
    .first<{ tavily_key_enc: string | null }>()
  const keys = await loadSiteKeys(env)
  return json({
    hasOwn: !!row?.tavily_key_enc,
    siteAvailable: keys.length > 0,
    cost: await loadSearchCost(env),
    /** 站点允不允许用户自带 key */
    enabled: (await getSetting(env, "lab_user_search_key_enabled")) !== "0",
    /** **用户自己的**联网搜索开关（默认关） */
    webSearchEnabled: (await loadUserRow(env, user.id)).web_search_enabled === 1,
  })
}

/**
 * PUT /api/lab/search-key
 * body: { key?: string, webSearchEnabled?: boolean }
 *   · `key` 传空串 = 删除自己的 key（**不动开关**）；
 *   · `webSearchEnabled` 是那个总开关（默认关）。
 * 两者可以分开发 —— 用户可能只想开开关（走站点 key），或只想清掉 key。
 */
export async function setMySearchKey(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json().catch(() => null)) as
    | { key?: unknown; webSearchEnabled?: unknown }
    | null
  if (!body) throw new ApiError(400, "请求体格式错误", "INVALID_BODY")
  const now = new Date().toISOString()

  // 确保有一行，后面按需 UPDATE（分开 set 语句，避免把没传的字段覆盖掉）
  await env.DB.prepare(
    "INSERT INTO lab_user_settings (user_id, updated_at) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING"
  )
    .bind(user.id, now)
    .run()

  if ("webSearchEnabled" in body) {
    await env.DB.prepare(
      "UPDATE lab_user_settings SET web_search_enabled = ?, updated_at = ? WHERE user_id = ?"
    )
      .bind(body.webSearchEnabled === true ? 1 : 0, now, user.id)
      .run()
  }

  if ("key" in body) {
    if ((await getSetting(env, "lab_user_search_key_enabled")) === "0") {
      throw new ApiError(400, "站点已关闭自定义搜索 key", "SEARCH_KEY_DISABLED")
    }
    const raw = typeof body.key === "string" ? body.key.trim() : ""
    if (raw.length > 200) throw new ApiError(400, "key 太长，不像是 Tavily 的 key", "INVALID_KEY")
    const enc = raw ? await encryptSecret(raw, env.SESSION_SECRET ?? "") : null
    await env.DB.prepare(
      "UPDATE lab_user_settings SET tavily_key_enc = ?, updated_at = ? WHERE user_id = ?"
    )
      .bind(enc, now, user.id)
      .run()
  }

  const row = await loadUserRow(env, user.id)
  return json({
    hasOwn: !!row.tavily_key_enc,
    webSearchEnabled: row.web_search_enabled === 1,
  })
}

/* ------------------------------------------------------------------ */
/* 管理端：站点 key + 计费                                              */
/* ------------------------------------------------------------------ */

/**
 * GET /api/admin/lab/search —— 打码后的 key 列表 + 计费设置。
 * ⚠️ 永不回明文（即使是管理员）—— 想改就整串重新粘一遍。
 */
export async function getSearchConfig(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "lab")
  const keys = await loadSiteKeys(env)
  return json({
    keys: keys.map(maskTavilyKey),
    keyCount: keys.length,
    cost: await loadSearchCost(env),
    userKeyEnabled: (await getSetting(env, "lab_user_search_key_enabled")) !== "0",
  })
}

/**
 * PUT /api/admin/lab/search
 * body: { keys?: string; cost?: number; userKeyEnabled?: boolean }
 *
 * `keys` 传整串（换行/逗号分隔）覆盖 —— 和 Brevo 那个设置项一样，
 * 不做「单把增删」的接口：多把 key 的场景本来就少，整串覆盖最不容易出错。
 */
export async function updateSearchConfig(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "lab")
  const body = (await request.json().catch(() => null)) as
    | { keys?: unknown; cost?: unknown; userKeyEnabled?: unknown }
    | null
  if (!body) throw new ApiError(400, "请求体格式错误", "INVALID_BODY")

  const patch: Record<string, string> = {}
  const changed: string[] = []

  if ("keys" in body) {
    const raw = typeof body.keys === "string" ? body.keys : ""
    const parsed = parseTavilyKeys(raw)
    // 超过 20 把纯属误粘，挡一下
    if (parsed.length > 20) throw new ApiError(400, "最多 20 把 key", "TOO_MANY_KEYS")
    patch.lab_tavily_keys = parsed.join("\n")
    changed.push(`key 数量 ${parsed.length}`)
  }
  if ("cost" in body) {
    const n = Math.floor(Number(body.cost))
    if (!Number.isFinite(n) || n < 0 || n > 1000) {
      throw new ApiError(400, "每次消耗积分要在 0 ~ 1000 之间", "INVALID_COST")
    }
    patch.lab_tavily_credit_cost = String(n)
    changed.push(`每次 ${n} 积分`)
  }
  if ("userKeyEnabled" in body) {
    const on = body.userKeyEnabled === true
    patch.lab_user_search_key_enabled = on ? "1" : "0"
    changed.push(on ? "允许用户自带 key" : "禁止用户自带 key")
  }

  if (Object.keys(patch).length) {
    await updateSettings(env, patch)
    await recordAudit(env, admin.id, "admin.lab_search", `联网搜索设置：${changed.join("、")}`)
  }
  const keys = await loadSiteKeys(env)
  return json({
    keys: keys.map(maskTavilyKey),
    keyCount: keys.length,
    cost: await loadSearchCost(env),
    userKeyEnabled: (await getSetting(env, "lab_user_search_key_enabled")) !== "0",
  })
}

/**
 * POST /api/admin/lab/search/quota —— 逐把 key 查 Tavily 官方额度。
 *
 * ⚠️ 一把一把串行查，不并发：并发打同一家的接口容易被风控，
 *    而且这里本来就是管理端点、不赶时间。
 * 单把失败不影响其他把 —— 把错误也带回前端，管理员才知道是哪把坏了。
 */
export async function checkSearchQuota(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "lab")
  const keys = await loadSiteKeys(env)
  const out: {
    masked: string
    ok: boolean
    usage?: number
    limit?: number
    error?: string
  }[] = []

  for (const key of keys) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS)
    try {
      const res = await fetch("https://api.tavily.com/usage", {
        headers: { Authorization: `Bearer ${key}` },
        signal: ctrl.signal,
      })
      if (!res.ok) {
        out.push({ masked: maskTavilyKey(key), ok: false, error: `HTTP ${res.status}` })
        continue
      }
      const data = (await res.json()) as {
        key?: { usage?: number; limit?: number }
        account?: { current_plan?: string; plan_usage?: number; plan_limit?: number }
      }
      out.push({
        masked: maskTavilyKey(key),
        ok: true,
        // key 维度的额度优先；没有就退回账户维度
        usage: data.key?.usage ?? data.account?.plan_usage,
        limit: data.key?.limit ?? data.account?.plan_limit,
      })
    } catch (err) {
      out.push({
        masked: maskTavilyKey(key),
        ok: false,
        error: err instanceof Error && err.name === "AbortError" ? "超时" : "请求失败",
      })
    } finally {
      clearTimeout(timer)
    }
  }
  return json({ keys: out })
}

/** 搜索是否可用（供 /lab/settings 告诉前端要不要显示「联网搜索」入口） */
export async function searchAvailability(env: Env): Promise<{
  siteAvailable: boolean
  cost: number
}> {
  const s = await getSettings(env)
  return {
    siteAvailable: parseTavilyKeys(s.lab_tavily_keys ?? "").length > 0,
    cost: await loadSearchCost(env),
  }
}

/* ------------------------------------------------------------------ */
/* 代拉模型列表（自定义渠道）                                          */
/* ------------------------------------------------------------------ */

/**
 * 🔴 这是一个**服务端代为请求用户给定地址**的接口 —— 典型的 SSRF 风险面。
 * 必须挡住的：内网地址、回环、云元数据端点（169.254.169.254）。
 * 挡不住的：域名解析到内网 IP 的情况（Worker 内部解析，拿不到解析结果）——
 * 这一点在注释里写清楚，不能假装万无一失。
 */
function assertSafeUpstreamUrl(raw: string): URL {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new ApiError(400, "地址格式不对", "INVALID_URL")
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new ApiError(400, "只支持 http/https 地址", "INVALID_URL")
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") {
    throw new ApiError(400, "不能填本机地址", "BLOCKED_HOST")
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (m) {
    const a = Number(m[1])
    const b = Number(m[2])
    const blocked =
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      // 169.254.0.0/16：链路本地，云厂商元数据端点就在这（169.254.169.254）
      (a === 169 && b === 254)
    if (blocked) throw new ApiError(400, "不能填内网地址", "BLOCKED_HOST")
  }
  return u
}

/**
 * POST /api/lab/probe-models —— body: { baseUrl, apiKey }
 * 去 `{baseUrl}/models` 拉一份可用模型名列表，回给前端让用户勾选。
 *
 * 为什么要服务端代拉：**浏览器直接请求第三方地址会被跨域（CORS）拦掉**，
 * 前端拿不到响应；而且有些服务商要求 Authorization 头，预检也过不去。
 */
export async function probeModels(env: Env, request: Request): Promise<Response> {
  await requireUser(env, request)
  const body = (await request.json().catch(() => null)) as
    | { baseUrl?: unknown; apiKey?: unknown }
    | null
  const baseUrl = typeof body?.baseUrl === "string" ? body.baseUrl.trim() : ""
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : ""
  if (!baseUrl) throw new ApiError(400, "先填接口地址", "INVALID_URL")

  // 常见写法是填到 `/v1` 或填到站点根，两种都兼容
  const base = assertSafeUpstreamUrl(baseUrl)
  const target = new URL(base.toString())
  target.pathname = `${target.pathname.replace(/\/+$/, "")}/models`

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const res = await fetch(target.toString(), {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: ctrl.signal,
    })
    if (!res.ok) {
      throw new ApiError(
        502,
        `对方返回 ${res.status}${res.status === 401 || res.status === 403 ? "（API Key 可能不对）" : ""}`,
        "UPSTREAM_ERROR"
      )
    }
    const data = (await res.json()) as { data?: { id?: unknown }[]; models?: unknown[] }
    // OpenAI 兼容是 `{data:[{id}]}`；有些自建服务直接给 `{models:[...]}`，两种都收
    const ids: string[] = Array.isArray(data?.data)
      ? data.data.map((m) => (typeof m?.id === "string" ? m.id : "")).filter(Boolean)
      : Array.isArray(data?.models)
        ? data.models.filter((m): m is string => typeof m === "string")
        : []
    if (!ids.length) {
      throw new ApiError(502, "对方没返回可用的模型列表", "EMPTY_MODELS")
    }
    return json({ models: Array.from(new Set(ids)).sort() })
  } catch (err) {
    if (err instanceof ApiError) throw err
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new ApiError(504, "对方响应超时", "UPSTREAM_TIMEOUT")
    }
    throw new ApiError(502, "连不上这个地址", "UPSTREAM_ERROR")
  } finally {
    clearTimeout(timer)
  }
}
