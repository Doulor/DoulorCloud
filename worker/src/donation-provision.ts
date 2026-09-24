/**
 * 「AI 渠道捐献」自动化：探测上游 → 建渠道 → **逐个模型测可用性** → 通过/退回。
 *
 * 为什么要做这一层自动化：
 *   用户捐一个「OpenAI 兼容中转站」的 baseUrl + key，人工审核其实只能做一件事——
 *   点一次测试看是否可用。而这件事能自动做，且**做得比人工更准**
 *   （测试是真的发一次对话请求给上游）。所以流程改为：
 *
 *     提交 → 自动探测模型 → 用户勾选 → 自动建渠道 → 自动逐个测模型
 *          ├─ 有可用模型 → 只保留可用的，自动批准（解锁 AI 权限）
 *          └─ 全部不可用 → 删渠道、自动拒绝并写明原因 → 管理员可「人工复核」重试
 *
 * 关键设计取舍：
 *   - **逐个模型测试**（不是只测第一个）：上游的 `/v1/models` 只是「声称支持」，
 *     实际常有个别模型没有可用渠道 / 名字是别名 / 需要额外权限。只测一个的话
 *     这些坏模型会一起进中转站，用户调它才报错。
 *   - **剔掉不通的模型**，渠道只保留验证过的；**全不可用就删掉渠道**，
 *     不留「看着能用、一调就报错」的条目。
 *   - **模型名统一加 `donation-` 前缀**，靠 NewAPI 的 `model_mapping` 做重定向：
 *     客户端请求 `donation-x`，上游收到 `x`。这样前端能一眼分辨捐献模型。
 *   - 渠道统一打 `DONATION_CHANNEL_TAG`，在 NewAPI 的「标签模式」下自成一个分组（文件夹）。
 *   - 上游给的模型名不可直接当渠道模型名（可能含逗号/超长），先做清洗。
 *   - 模型数**有上限**（见 MAX_DONATION_MODELS）：逐个测要真发请求，越多越慢。
 */
import { mapLimit } from "./async-utils"
import { assertPublicHttpUrl } from "./url-guard"
import { getSettings } from "./settings"
import type { Env } from "./env"
import {
  addChannel,
  deleteChannel,
  listChannels,
  testChannel,
  updateChannelModels,
} from "./newapi-client"

/** 捐献模型的对外前缀（前端按这个前缀把模型归入「捐献」分组） */
export const DONATION_MODEL_PREFIX = "donation-"
/** 捐献渠道的命名前缀，最终形如「捐献01」 */
export const DONATION_CHANNEL_PREFIX = "捐献"
/**
 * 捐献渠道统一打的 NewAPI 渠道标签。
 *
 * NewAPI 的渠道列表有「标签模式」，同一 tag 的渠道会归成一组、并能整组启停 ——
 * 这正好当作「文件夹」用来收纳所有捐献渠道，管理员一眼能和自建渠道分开。
 */
export const DONATION_CHANNEL_TAG = "捐献"

/** 探测 + 建渠道的总超时预算（毫秒）。单次 fetch 用更短的超时。 */
const PROBE_TIMEOUT_MS = 12000
const CHANNEL_TEST_HINT_MS = 20000

/** NewAPI 渠道类型（constant/channel.go）：我们只支持这两种上游格式 */
export const DONATION_CHANNEL_OPENAI = 1
export const DONATION_CHANNEL_ANTHROPIC = 14
/** 支持的渠道类型白名单 */
export const DONATION_CHANNEL_TYPES = [DONATION_CHANNEL_OPENAI, DONATION_CHANNEL_ANTHROPIC]

export function channelTypeLabel(type: number): string {
  return type === DONATION_CHANNEL_ANTHROPIC ? "Anthropic 原生" : "OpenAI 兼容"
}

/**
 * 用户可选的「接口格式」。
 *
 * 为什么要让用户选：同一个中转站可能**只实现了 Anthropic 原生接口**
 * （`/v1/messages` + `x-api-key`），用 OpenAI 格式（`/v1/chat/completions` +
 * `Authorization: Bearer`）去调会直接被拒 —— 用户实测遇到过一个上游
 * 「Anthropic 格式能用、OpenAI 格式失败」。所以探测与建渠道都必须能指定格式。
 */
export type UpstreamFormat = "auto" | "openai" | "anthropic"

export interface ProbeAttempt {
  type: number
  name: string
  ok: boolean
  error: string
}

export interface UpstreamProbe {
  ok: boolean
  /** 规范化后的 baseUrl（已去掉尾部斜杠与多余的 `/v1`） */
  baseUrl: string
  /** 识别出的 NewAPI 渠道类型；未识别为 null */
  channelType: number | null
  channelTypeName: string
  models: string[]
  message: string
  /** 依次尝试过的格式及结果，便于用户判断该选哪个 */
  attempts: ProbeAttempt[]
}

/** 去掉末尾的 `/` 与 `/v1`（NewAPI 的 OpenAI 适配器会自己补 `/v1`） */
export function normalizeBaseUrl(raw: string): string {
  let url = (raw ?? "").trim().replace(/\/+$/, "")
  // 只剥一层 `/v1`：user 常把 `https://api.x.com/v1` 整段粘进来，
  // 不退掉就会变成 `.../v1/v1/chat/completions`。
  if (/\/v1$/i.test(url)) url = url.replace(/\/v1$/i, "")
  return url.replace(/\/+$/, "")
}

/** baseUrl 合规校验；通过则返回规范化结果，否则抛错 */
export function validateUpstreamUrl(raw: string): { baseUrl: string; host: string } {
  const baseUrl = normalizeBaseUrl(raw)
  const { host } = assertPublicHttpUrl(baseUrl, "上游 API 地址")
  return { baseUrl, host }
}

/** 把上游 /v1/models 的各种返回形态揉成一个字符串数组 */
function extractModelIds(payload: unknown): string[] {
  const out: string[] = []
  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim()) out.push(v.trim())
    else if (v && typeof v === "object") {
      const id = (v as { id?: unknown }).id
      if (typeof id === "string" && id.trim()) out.push(id.trim())
    }
  }
  if (Array.isArray(payload)) {
    payload.forEach(push)
  } else if (payload && typeof payload === "object") {
    const obj = payload as { data?: unknown; models?: unknown }
    if (Array.isArray(obj.data)) obj.data.forEach(push)
    else if (Array.isArray(obj.models)) obj.models.forEach(push)
  }
  return Array.from(new Set(out))
}

/**
 * 探测上游：拉模型列表，顺带识别接口格式。
 *
 * 两种格式各试一遍（用户也可指定只试其中一种）：
 *   - OpenAI 兼容：`GET {base}/v1/models` + `Authorization: Bearer <key>`
 *   - Anthropic：  `GET {base}/v1/models` + `x-api-key` + `anthropic-version`
 *     （与 NewAPI 的 Anthropic 适配器发出去的头一致，见 relay/channel/claude）
 *
 * 识别不出来的最常见原因不是「资源不可用」，而是格式选错了 ——
 * 所以失败时把每种格式各自的报错一并回传，前端能直接提示用户换一个格式再试。
 */
export async function probeUpstream(
  rawBaseUrl: string,
  apiKey: string,
  format: UpstreamFormat = "auto"
): Promise<UpstreamProbe> {
  let baseUrl: string
  try {
    baseUrl = validateUpstreamUrl(rawBaseUrl).baseUrl
  } catch (err) {
    return {
      ok: false,
      baseUrl: "",
      channelType: null,
      channelTypeName: "",
      models: [],
      message: err instanceof Error ? err.message : String(err),
      attempts: [],
    }
  }
  if (!apiKey.trim()) {
    return {
      ok: false,
      baseUrl,
      channelType: null,
      channelTypeName: "",
      models: [],
      message: "请填写上游 API Key",
      attempts: [],
    }
  }

  const key = apiKey.trim()
  const candidates: { type: number; name: string; headers: Record<string, string> }[] = []
  if (format !== "anthropic") {
    candidates.push({
      type: DONATION_CHANNEL_OPENAI,
      name: "OpenAI 兼容",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    })
  }
  if (format !== "openai") {
    candidates.push({
      type: DONATION_CHANNEL_ANTHROPIC,
      name: "Anthropic 原生",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        Accept: "application/json",
      },
    })
  }

  const attempts: ProbeAttempt[] = []
  for (const candidate of candidates) {
    let lastError = ""
    for (const url of [`${baseUrl}/v1/models`, `${baseUrl}/models`]) {
      try {
        const res = await fetch(url, {
          method: "GET",
          headers: candidate.headers,
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        })
        if (!res.ok) {
          lastError = `HTTP ${res.status}`
          continue
        }
        const models = extractModelIds(await res.json().catch(() => null))
        if (models.length === 0) {
          lastError = "接口可达，但没有返回任何模型"
          continue
        }
        attempts.push({ type: candidate.type, name: candidate.name, ok: true, error: "" })
        return {
          ok: true,
          baseUrl,
          channelType: candidate.type,
          channelTypeName: candidate.name,
          models: models.sort((a, b) => a.localeCompare(b)),
          message: "",
          attempts,
        }
      } catch (err) {
        lastError =
          err instanceof Error && err.name === "TimeoutError"
            ? "请求超时"
            : err instanceof Error
              ? err.message
              : String(err)
      }
    }
    attempts.push({
      type: candidate.type,
      name: candidate.name,
      ok: false,
      error: lastError || "无响应",
    })
  }

  // 只有一种格式被试过时，提示还可以换个格式再试 —— 这正是用户会踩的坑
  const hint =
    candidates.length === 1
      ? "。可以换另一种「接口格式」再检测一次"
      : ""
  return {
    ok: false,
    baseUrl,
    channelType: null,
    channelTypeName: "",
    models: [],
    message: `无法从该地址读到模型列表（${attempts
      .map((a) => `${a.name}：${a.error}`)
      .join("；")}）${hint}`,
    attempts,
  }
}

export interface ProvisionResult {
  ok: boolean
  /** 创建成功的渠道 id；失败时为 null（失败的渠道已被删除） */
  channelId: number | null
  /** 面向用户的结论（通过/失败原因） */
  message: string
  /** 面向管理员的细节（NewAPI 原始报错、被剔除的模型） */
  detail: string
  /** 测试通过的模型（上游真实名） */
  passed: string[]
  /** 未通过的模型及原因 */
  failed: { model: string; reason: string }[]
}

/** 清洗上游模型名：去掉空值/重复，挡掉会破坏逗号分隔或超出长度的名字 */
function sanitizeModels(models: string[]): {
  models: string[]
  rejected: string[]
} {
  const seen = new Set<string>()
  const kept: string[] = []
  const rejected: string[] = []
  for (const raw of models) {
    const name = (raw ?? "").trim()
    if (!name) continue
    if (name.includes(",")) {
      rejected.push(name)
      continue
    }
    if (name.length + DONATION_MODEL_PREFIX.length > 255) {
      rejected.push(name)
      continue
    }
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(name)
  }
  return { models: kept, rejected }
}

/**
 * 单次捐献最多允许多少个模型。
 *
 * 为什么要有上限：可用性校验要**逐个模型真实调用一次**（见 provisionDonationChannel），
 * 耗时 ≈ 模型数 / 并发数 × 上游延迟。30 个模型、并发 10 时最坏 3 轮 × 10 秒超时 = 30 秒，
 * 仍在 Cloudflare 的单次请求预算内。再多就会把提交请求拖到超时，
 * 而「请求超时但渠道其实建好了」是最难排查的那种状态。
 *
 * 需要更多模型时，用户分几次捐献即可 —— 但注意同一上游地址只能捐一次
 * （见 createDonation 里的重复校验），所以实际取的是「挑最想要的 30 个」。
 */
export const MAX_DONATION_MODELS = 30
/** 逐个测试的并发度：太高会打爆上游，太低则慢 */
const TEST_CONCURRENCY = 10
/** 单个模型的测试超时（毫秒） */
const TEST_TIMEOUT_MS = 10000

/** 把失败原因整理成一行行可读文本（截断，免得把 review_note 撑爆） */
function formatFailures(
  failed: { model: string; reason: string }[],
  max = 6
): string {
  const shown = failed.slice(0, max).map((f) => `${f.model}（${f.reason}）`)
  const rest = failed.length - shown.length
  return shown.join("；") + (rest > 0 ? `；另有 ${rest} 个未列出` : "")
}

/**
 * 建渠道 → **逐个模型测试** → 只保留可用模型。
 *
 * 为什么要逐个测：上游的 `/v1/models` 只是「声称支持」，实际经常有个别模型
 * 没有可用渠道 / 名字是别名 / 需要额外权限。只测第一个模型的话，这些坏模型会
 * 一起进中转站，用户调它时报错 —— 而这正是用户反馈过的问题。
 *
 * 收尾规则：
 *   - 全部不可用 → **删掉渠道并拒绝**（不留一个必然报错的渠道）
 *   - 部分可用 → 把不可用的从渠道里剔掉（`PUT` 只改 models / model_mapping）
 *   - 全部可用 → 原样保留
 */
export async function provisionDonationChannel(
  env: Env,
  opts: {
    baseUrl: string
    apiKey: string
    /** 上游真实模型名（未加前缀） */
    models: string[]
    channelType: number
    /** 渠道序号，用于生成「捐献NN」 */
    seq: number
    /** 渠道所属分组；缺省用全局 newapi_group */
    group?: string
  }
): Promise<ProvisionResult> {
  const { models, rejected } = sanitizeModels(opts.models)
  if (models.length === 0) {
    return {
      ok: false,
      channelId: null,
      message: "没有可用的模型名",
      detail: rejected.length ? `被拒绝的模型名：${rejected.join("、")}` : "",
      passed: [],
      failed: [],
    }
  }

  const settings = await getSettings(env)
  const group = opts.group || settings.newapi_group || "default"
  const exposed = models.map((m) =>
    m.startsWith(DONATION_MODEL_PREFIX) ? m : DONATION_MODEL_PREFIX + m
  )
  const name = `${DONATION_CHANNEL_PREFIX}${String(opts.seq).padStart(2, "0")}`

  // 建渠道前后的 id 差集 = 新渠道（比按名字找可靠：NewAPI 的 name 无唯一约束）
  let beforeIds = new Set<number>()
  try {
    beforeIds = new Set((await listChannels(env)).map((c) => c.id))
  } catch {
    // 列表读不到不致命，退回「按名字找最大 id」
  }

  // 先按全量建出来，方便拿它逐个测；测完再把不通的剔掉
  try {
    await addChannel(env, {
      name,
      type: opts.channelType,
      key: opts.apiKey.trim(),
      baseUrl: opts.baseUrl,
      models: exposed.join(","),
      modelMapping: JSON.stringify(
        Object.fromEntries(models.map((m, i) => [exposed[i], m]))
      ),
      group,
      tag: DONATION_CHANNEL_TAG,
      testModel: models[0],
    })
  } catch (err) {
    return {
      ok: false,
      channelId: null,
      message: "在 NewAPI 创建渠道失败",
      detail: err instanceof Error ? err.message : String(err),
      passed: [],
      failed: [],
    }
  }

  // 定位新建的渠道
  let channelId: number | null = null
  try {
    const after = await listChannels(env)
    const created = after.filter((c) => !beforeIds.has(c.id))
    channelId =
      (created.length ? Math.max(...created.map((c) => c.id)) : null) ??
      after
        .filter((c) => c.name === name)
        .reduce<number | null>((acc, c) => (acc === null || c.id > acc ? c.id : acc), null)
  } catch (err) {
    return {
      ok: false,
      channelId: null,
      message: "渠道已创建，但读取渠道列表失败，无法验证",
      detail: err instanceof Error ? err.message : String(err),
      passed: [],
      failed: [],
    }
  }

  if (channelId === null) {
    return {
      ok: false,
      channelId: null,
      message: "渠道已创建，但未能定位到它，无法验证",
      detail: `渠道名：${name}`,
      passed: [],
      failed: [],
    }
  }

  // ---- 逐个模型测试 ----
  const results = await mapLimit(models, TEST_CONCURRENCY, async (model) => {
    const r = await testChannel(env, channelId as number, model, TEST_TIMEOUT_MS)
    return { model, ok: r.ok, reason: r.message }
  })

  const passed = results.filter((r) => r.ok).map((r) => r.model)
  const failed = results
    .filter((r) => !r.ok)
    .map((r) => ({ model: r.model, reason: r.reason || "未通过" }))

  // 全部不可用 → 不留半坏的渠道
  if (passed.length === 0) {
    try {
      await deleteChannel(env, channelId)
    } catch (err) {
      console.error("清理全部测试失败的捐献渠道出错:", channelId, err)
    }
    return {
      ok: false,
      channelId: null,
      message: `${models.length} 个模型全部未通过可用性测试（按「${channelTypeLabel(
        opts.channelType
      )}」格式调用）`,
      detail:
        formatFailures(failed) +
        "。若确认模型名没问题，多半是接口格式选错了，换另一种格式再提交一次",
      passed: [],
      failed,
    }
  }

  // 部分可用 → 把不通的剔掉（只改 models / model_mapping，其余字段不动）
  if (failed.length > 0) {
    const keptExposed = passed.map((m) =>
      m.startsWith(DONATION_MODEL_PREFIX) ? m : DONATION_MODEL_PREFIX + m
    )
    const keptMapping = Object.fromEntries(
      passed.map((m, i) => [keptExposed[i], m])
    )
    try {
      await updateChannelModels(
        env,
        channelId,
        keptExposed.join(","),
        JSON.stringify(keptMapping)
      )
    } catch (err) {
      // 改不动就删掉重来（下次复核会重建），避免留下「含坏模型」的渠道
      try {
        await deleteChannel(env, channelId)
      } catch (delErr) {
        console.error("回滚捐献渠道失败:", channelId, delErr)
      }
      return {
        ok: false,
        channelId: null,
        message: "渠道已创建，但剔除不可用模型时失败，已回滚",
        detail: err instanceof Error ? err.message : String(err),
        passed,
        failed,
      }
    }
  }

  const format = channelTypeLabel(opts.channelType)
  const summary =
    failed.length > 0
      ? `渠道「${name}」已加入中转站（${failed.length > 0 ? `${passed.length}/${models.length}` : passed.length} 个模型通过测试，${format}，分组 ${group}）`
      : `渠道「${name}」已加入中转站（${passed.length} 个模型，${format}，分组 ${group}）`
  return {
    ok: true,
    channelId,
    message: "渠道可用性校验通过",
    detail: failed.length > 0 ? `${summary}。未通过：${formatFailures(failed)}` : summary,
    passed,
    failed,
  }
}

/**
 * 撤销捐献时收回资源：删掉该渠道。
 * 不抛错 —— 撤销权限是主流程，删渠道失败只记日志（管理员可到中转站手删）。
 */
export async function releaseDonationChannel(
  env: Env,
  channelId: number
): Promise<boolean> {
  try {
    await deleteChannel(env, channelId)
    return true
  } catch (err) {
    console.error("删除捐献渠道失败:", channelId, err)
    return false
  }
}

/** 供管理端展示：探测超时提示文案（避免用测试接口时管理员以为卡死） */
export const CHANNEL_TEST_HINT = `渠道测试由中转站实际发起一次对话请求，通常 1–${Math.round(
  CHANNEL_TEST_HINT_MS / 1000
)} 秒内返回。`
