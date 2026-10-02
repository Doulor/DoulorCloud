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
  getChannel,
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
/**
 * 捐献渠道所属的 NewAPI 分组名（设置项 `newapi_donation_group` 被清空时的兜底）。
 *
 * 与 `DONATION_CHANNEL_TAG` 的区别（两者同名但不是一回事，别混）：
 *   - tag 只是渠道列表里的「文件夹」，纯展示，不影响谁能调用；
 *   - **group 决定路由** —— 令牌的分组必须匹配渠道的分组才调得到。
 */
export const DONATION_CHANNEL_GROUP = "donation"

/**
 * 从设置值解析捐献分组名。
 *
 * 空串/未配置一律兜底成 `DONATION_CHANNEL_GROUP` —— 分组名是**路由键**，
 * 解析出空串会让渠道落在「没有分组」上，谁都调不到，比落回默认更糟。
 * 三处调用（建渠道 / 复核自愈 / 用户分组拼接）共用它，避免口径漂移。
 */
export function resolveDonationGroup(raw: string | null | undefined): string {
  return (raw ?? "").trim() || DONATION_CHANNEL_GROUP
}

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
export function extractModelIds(payload: unknown): string[] {
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
        const res = await fetchProbeResponse(url, candidate.headers)
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
  /**
   * 渠道 id。
   *
   * ⚠️ `ok: false` **不代表一定没有渠道**：唯一例外是「全部模型都不确定」
   * （见 provisionDonationChannel 的收尾规则）—— 那种情况渠道被刻意保留、
   * 转人工审核，此时 channelId 有效。其余失败情形渠道已被删除，为 null。
   */
  channelId: number | null
  /**
   * 这次失败是不是**确定性**的 —— 只有 `true` 才允许自动拒绝。
   *
   * 用户的明确要求（2026-09-25）：「自动判断错了的不能直接算失败，
   * 应该由人工手动审核确定失败才算失败」。理由是本模块能观察到的一切
   * （上游 401/403、超时、中转站故障、读不到渠道列表）**都可能只是这次不巧**，
   * 而不是资源不可用；误拒的代价（丢掉一个真的资源、用户以为站点坏了）
   * 远大于误转人工（管理员多点一次按钮）。
   *
   * 判据：
   *   - `true`：失败原因只关于**我们自己的输入规则**（如模型名全部非法），
   *     与上游可用性无关 —— 重试或换格式都不会变；
   *   - `false`：其余一切（上游报错、超时、平台侧故障、定位不到渠道、回滚）
   *     ⇒ 调用方**必须转人工**，不得自动拒绝。
   */
  definitive: boolean
  /** 面向用户的结论（通过/失败原因） */
  message: string
  /** 面向管理员的细节（NewAPI 原始报错、被剔除的模型） */
  detail: string
  /** 测试通过的模型（上游真实名） */
  passed: string[]
  /** 未通过的模型及原因（含 uncertain 与 failed，便于调用方落库） */
  failed: { model: string; reason: string }[]
  /**
   * 「不确定」的模型：限流 / 超时 / 网络抖动 —— 这些失败**不能证明模型不可用**，
   * 因此保留在渠道里，并交给重试任务确认。
   */
  uncertain: { model: string; reason: string }[]
}

/**
 * 清洗上游模型名：去掉空值/重复，挡掉会破坏逗号分隔或超出长度的名字。
 *
 * 长度上限按「加前缀后」算（`DONATION_MODEL_PREFIX` 的长度）—— 对不加前缀的
 * 调用方（如商汤）偏保守，但这只是拒绝几个超长名字，代价可以忽略。
 */
export function sanitizeModels(models: string[]): {
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
 * 把测试失败的原因分成两类。
 *
 * 为什么必须分：`testChannel` 的失败可能是「模型真的不可用」（401 / 模型不存在），
 * 也可能是「**这次调用**没成功」（429 限流、10 秒超时、网络抖动）—— 后者完全
 * 不能证明模型不可用。此前两者一律从渠道里剔除，导致「当时抖了一下」的模型被
 * 永久排除（用户实测：一个上游 9 个模型只有 1 个通过，其余全是超时）。
 *
 * 归类规则：
 *   - 限流 / 超时 / 网络类 → `uncertain`（保留在渠道里，交给重试任务确认）
 *   - 鉴权 / 模型不存在类 → `failed`（真的不可用，剔除）
 *   - **无法判定一律按 `uncertain`** —— 保守取向：宁可留一个暂时不可用的模型
 *     （用户调用会失败，但重试任务会把它清掉），也不要误删一个本来可用的模型
 *     （删了就只能靠人工重新拉取才能补回）。
 */
export function classifyTestFailure(message: string): "failed" | "uncertain" {
  const m = (message ?? "").toLowerCase()

  // 鉴权 / 权限 / 模型不存在 —— 确定性失败，重试也不会好
  if (
    /unauthorized|forbidden|invalid[_ -]?(api[_ -]?)?key|无权限|没有权限|鉴权失败/.test(m) ||
    /\b401\b|\b403\b/.test(m) ||
    /不存在|not found|无可用渠道|不支持|unsupported|unknown model|model[_ -]?not/.test(m)
  ) {
    return "failed"
  }

  // 限流 / 超时 / 网络 —— 不确定，可能只是这次不巧
  if (
    /\b429\b|rate[_ -]?limit|too many|限流|频率|请求过频/.test(m) ||
    /超时|timeout|timed out/.test(m) ||
    /fetch failed|econnreset|econnrefused|network|网络|connection|socket hang up/.test(m)
  ) {
    return "uncertain"
  }

  // 认不出来：宁可留着（重试任务会兜底），也不误删
  return "uncertain"
}

/**
 * 建渠道 → **逐个模型测试** → 只保留可用模型。
 *
 * 为什么要逐个测：上游的 `/v1/models` 只是「声称支持」，实际经常有个别模型
 * 没有可用渠道 / 名字是别名 / 需要额外权限。只测第一个模型的话，这些坏模型会
 * 一起进中转站，用户调它时报错 —— 而这正是用户反馈过的问题。
 *
 * 收尾规则：
 *   - 全部不可用 → **删掉渠道**（不留一个必然报错的），但**交由人工复核定案**
 *     —— 绝不自动拒绝，见 `definitive`
 *   - 一个都没通过但全是「不确定」→ 渠道保留，转人工（重试任务会继续确认）
 *   - 部分可用 → 把**确定失败**的从渠道里剔掉，保留 passed + uncertain
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
      uncertain: [],
      // 唯一确定性失败：模型名不合我们的规则（含逗号/超长/去重后为空），
      // 与「上游到底能不能用」无关，换格式或重试都不会变。
      definitive: true,
    }
  }

  const settings = await getSettings(env)
  // ⚠️ 2026-10-01 起捐献渠道走**独立分组**（`newapi_donation_group`，默认 donation），
  // 不再混进站点的 `newapi_group`。站长口径：default 分组只放非捐献渠道，
  // 想用捐献模型的用户要单独建一个选了捐献分组的 Key。
  // 旧行为（`settings.newapi_group`）已废弃，别改回去。
  const group = opts.group || resolveDonationGroup(settings.newapi_donation_group)
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
      uncertain: [],
      // 这是**平台侧**故障（中转站挂/令牌失效/接口报错），绝不能算用户的资源不可用
      definitive: false,
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
      uncertain: [],
      definitive: false,
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
      uncertain: [],
      definitive: false,
    }
  }

  // ---- 逐个模型测试 ----
  const results = await mapLimit(models, TEST_CONCURRENCY, async (model) => {
    const r = await testChannel(env, channelId as number, model, TEST_TIMEOUT_MS)
    return { model, ok: r.ok, reason: r.message }
  })

  const passed = results.filter((r) => r.ok).map((r) => r.model)
  const allFailed = results
    .filter((r) => !r.ok)
    .map((r) => ({ model: r.model, reason: r.reason || "未通过" }))
  // 失败再分两类：不确定的（限流/超时/网络）保留，确定失败的（401/模型不存在）剔除
  const uncertain = allFailed.filter(
    (f) => classifyTestFailure(f.reason) === "uncertain"
  )
  const failed = allFailed.filter((f) => classifyTestFailure(f.reason) === "failed")

  // ---- 收尾规则（三种情形）----

  // ① 全失败（一个通过、一个不确定都没有）→ 删掉渠道（不留必然报错的），
  //    但**不自动拒绝** —— 转人工。见 definitive 的说明：这里的「失败」全部来自
  //    上游的报错文案，而同一份资源换个接口格式/换个时间很可能就是好的
  //    （实测过 `api.justwoker.icu`：OpenAI 路径被上游 Cloudflare 403、
  //    Anthropic 路径正常）。自动拒绝等于把一个真资源判死。
  if (passed.length === 0 && uncertain.length === 0) {
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
        "。若确认模型名没问题，多半是接口格式选错了，管理员可换另一种格式复核",
      passed: [],
      failed,
      uncertain: [],
      definitive: false,
    }
  }

  // ② 一个都没通过，但全是「不确定」→ 渠道保留、**转人工**，不自动放行。
  //
  // 为什么不直接批准：渠道里一个模型都没验证过。429 通常说明 Key 有效，但
  // 「全模型 429」也可能是 Key 无效或上游整体故障 —— 自动放行等于把完全未验证的
  // 渠道推给所有用户。保留渠道是为了不丢模型（重试任务会确认它们），
  // 转人工是让管理员拍板。
  if (passed.length === 0) {
    return {
      ok: false,
      channelId, // ← 有效！调用方据此把 id 落到单据，转人工审核
      message: `${models.length} 个模型全部未能验证（限流或超时，不代表不可用）`,
      detail:
        `${formatFailures(uncertain)}。这些失败都是限流/超时/网络抖动，` +
        "不能证明模型不可用，已全部保留在渠道里待重试确认。",
      passed: [],
      failed,
      uncertain,
      definitive: false,
    }
  }

  // ③ 有模型通过 → 剔除确定失败的，保留 passed + uncertain
  const kept = [...passed, ...uncertain.map((u) => u.model)]
  if (failed.length > 0) {
    const keptExposed = kept.map((m) =>
      m.startsWith(DONATION_MODEL_PREFIX) ? m : DONATION_MODEL_PREFIX + m
    )
    const keptMapping = Object.fromEntries(
      kept.map((m, i) => [keptExposed[i], m])
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
        uncertain,
        definitive: false,
      }
    }
  }

  const format = channelTypeLabel(opts.channelType)
  const summary =
    failed.length > 0 || uncertain.length > 0
      ? `渠道「${name}」已加入中转站（${passed.length}/${models.length} 个模型通过测试，${format}，分组 ${group}）`
      : `渠道「${name}」已加入中转站（${passed.length} 个模型，${format}，分组 ${group}）`
  const tails = [
    failed.length > 0 ? `不可用：${formatFailures(failed)}` : "",
    uncertain.length > 0
      ? `待重试（限流/超时，已保留在渠道里）：${formatFailures(uncertain)}`
      : "",
  ].filter(Boolean)
  return {
    ok: true,
    channelId,
    message: "渠道可用性校验通过",
    detail: tails.length > 0 ? `${summary}。${tails.join("；")}` : summary,
    passed,
    failed,
    uncertain,
    definitive: true,
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

// ---------------------------------------------------------------------------
// 失败模型的重试与补全
// ---------------------------------------------------------------------------

/**
 * 重试退避（小时），下标 = 已尝试次数。
 *
 * 为什么需要退避：一个模型可能是**长期**不可用（上游没渠道 / 名字是别名），
 * 若每小时都试一次，纯属浪费上游请求配额。递增退避兼顾两个诉求：
 * 「早期快速确认」+「长期不再打扰」。1h → 2h → 4h → 8h → 24h，5 次后放弃。
 */
const RETRY_BACKOFF_HOURS = [1, 2, 4, 8, 24]

/** 最多重试多少次（用尽后标记 exhausted，不再入选） */
export const MAX_MODEL_RETRIES = RETRY_BACKOFF_HOURS.length

/**
 * 单次批处理上限。
 *
 * 每个模型要发 1 次 `testChannel`（命中时再加 1 次 `updateChannelModels`）。
 * Cloudflare 免费版单请求子请求上限 50，而 `runMaintenance` 已有约 15 个 ——
 * 取 5 留足余量。定时任务每小时跑一次，5 个/次也够用（重试记录本来就不多）。
 */
export const RETRY_BATCH = 5

/** 单条重试记录（对应 donation_model_retries 表一行） */
interface RetryRow {
  donation_id: string
  model: string
  channel_id: number
  status: string
  reason: string | null
  attempts: number
}

export interface RetryResult {
  /** 本轮恢复成功、已并回渠道的模型 */
  recovered: string[]
  /**
   * 有模型恢复的捐献单据 id（去重）。
   *
   * 用途：把「全模型不确定 → 转人工」的单据自动推进到已通过。
   * 那种单据的判据是 status='pending' + newapi_channel_id 有值（见
   * `autoProvisionAiDonation`），只要有一个模型被重试确认可用，就说明
   * Key 与上游都是好的 —— 没必要让管理员再点一次。这里只把 id 交出去，
   * **由调用方决定怎么推进**（donation-provision 不该反过来依赖 handler）。
   */
  recoveredDonations: string[]
  /** 仍不确定（本轮又失败，还有重试机会） */
  stillUncertain: number
  /** 重试次数用尽或渠道已消失，已放弃 */
  exhausted: number
  errors: string[]
}

/**
 * 重试「没通过测试」的模型，通过的并回渠道。
 *
 * 由定时任务（maintenance 步骤 7）与管理员手动按钮共同调用。
 *
 * 设计边界：
 *   - **只加不删**：恢复时把模型并进渠道现有 models 里，不动其他模型 ——
 *     免得因为一次重试把管理员手工调过的模型列表覆盖掉；
 *   - 渠道已被删除（撤销捐献）→ 直接标 exhausted，不反复试；
 *   - `dryRun` 只统计不写库，供上线前观察。
 */
export async function retryDonationModels(
  env: Env,
  opts: { donationId?: string; dryRun?: boolean; limit?: number } = {}
): Promise<RetryResult> {
  const out: RetryResult = {
    recovered: [],
    recoveredDonations: [],
    stillUncertain: 0,
    exhausted: 0,
    errors: [],
  }
  const limit = Math.max(1, Math.min(opts.limit ?? RETRY_BATCH, 50))
  const now = new Date().toISOString()

  let rows: RetryRow[] = []
  try {
    const sql = opts.donationId
      ? `SELECT donation_id, model, channel_id, status, reason, attempts
           FROM donation_model_retries
          WHERE donation_id = ? AND status IN ('uncertain','failed')
          ORDER BY next_retry_at ASC LIMIT ?`
      : `SELECT donation_id, model, channel_id, status, reason, attempts
           FROM donation_model_retries
          WHERE status IN ('uncertain','failed') AND next_retry_at <= ?
          ORDER BY next_retry_at ASC LIMIT ?`
    const stmt = opts.donationId
      ? env.DB.prepare(sql).bind(opts.donationId, limit)
      : env.DB.prepare(sql).bind(now, limit)
    const r = await stmt.all<RetryRow>()
    rows = r.results ?? []
  } catch (err) {
    // 表未迁移（0047 未应用）不该让定时任务整体失败
    out.errors.push(`读取重试记录失败: ${err instanceof Error ? err.message : String(err)}`)
    return out
  }

  if (rows.length === 0) return out

  // 按渠道分组，避免同一渠道被并发 PUT 互相覆盖
  const byChannel = new Map<number, RetryRow[]>()
  for (const row of rows) {
    const list = byChannel.get(row.channel_id) ?? []
    list.push(row)
    byChannel.set(row.channel_id, list)
  }

  for (const [channelId, list] of byChannel) {
    // 先确认渠道还在（撤销捐献会删渠道）。
    // 用单查：列表接口每页最多 100 条，渠道一多就可能漏掉目标 id，
    // 会被误判成「渠道已不存在」而把待重试记录全部判死。
    let channelModels: string | null = null
    try {
      const ch = await getChannel(env, channelId)
      if (!ch) {
        for (const row of list) {
          if (!opts.dryRun) {
            await markRetry(env, row, "exhausted", "渠道已不存在（捐献可能已被撤销）", now)
          }
          out.exhausted += 1
        }
        continue
      }
      channelModels = ch.models
    } catch (err) {
      out.errors.push(
        `读取渠道 ${channelId} 失败: ${err instanceof Error ? err.message : String(err)}`
      )
      continue
    }

    // 逐条测试（渠道内串行：够用，且不会打爆上游）
    const recoveredHere: string[] = []
    for (const row of list) {
      const r = await testChannel(env, channelId, row.model, TEST_TIMEOUT_MS)
      if (r.ok) {
        recoveredHere.push(row.model)
        out.recovered.push(row.model)
        if (!out.recoveredDonations.includes(row.donation_id)) {
          out.recoveredDonations.push(row.donation_id)
        }
        if (!opts.dryRun) {
          await markRetry(env, row, "recovered", r.message || "重试通过", now)
        }
        continue
      }

      const attempts = row.attempts + 1
      const giveUp = attempts >= MAX_MODEL_RETRIES
      if (giveUp) out.exhausted += 1
      else out.stillUncertain += 1
      if (!opts.dryRun) {
        await markRetry(
          env,
          row,
          giveUp ? "exhausted" : "uncertain",
          r.message || "未通过",
          now,
          attempts
        )
      }
    }

    // 把本轮恢复的模型并回渠道（只加不删）
    if (recoveredHere.length > 0 && !opts.dryRun) {
      try {
        const existing = (channelModels ?? "")
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean)
        const merged = Array.from(new Set([...existing, ...recoveredHere]))
        const mapping = Object.fromEntries(merged.map((m) => [m, m]))
        await updateChannelModels(env, channelId, merged.join(","), JSON.stringify(mapping))
      } catch (err) {
        out.errors.push(
          `把恢复的模型并回渠道 ${channelId} 失败: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }

  return out
}

/** 写入一条重试记录的终态与下次重试时间 */
async function markRetry(
  env: Env,
  row: RetryRow,
  status: string,
  reason: string,
  nowIso: string,
  attempts?: number
): Promise<void> {
  const n = attempts ?? row.attempts
  const backoff = RETRY_BACKOFF_HOURS[Math.min(n, RETRY_BACKOFF_HOURS.length - 1)]
  const next = new Date(Date.now() + backoff * 3600_000).toISOString()
  try {
    await env.DB.prepare(
      `UPDATE donation_model_retries
          SET status = ?, reason = ?, attempts = ?, last_tried_at = ?, next_retry_at = ?
        WHERE donation_id = ? AND model = ?`
    )
      .bind(status, reason.slice(0, 300), n, nowIso, next, row.donation_id, row.model)
      .run()
  } catch (err) {
    console.error("更新重试记录失败:", row.donation_id, row.model, err)
  }
}

/**
 * 重新拉取上游模型列表，把渠道里缺的模型补上。
 *
 * 为什么需要它（而不只是 retryDonationModels）：重试只能覆盖**落过库**的模型。
 * 而在这张表存在之前，失败的模型名只写进了 `donations.review_note` 文本，
 * 没有结构化记录 —— 那些历史单的模型已无从得知，只能重新拉一次上游列表，
 * 与渠道当前内容做差集，再逐个验证补进去。
 *
 * 场景：管理员在面板上对一笔已通过的 AI 捐献点「补全模型」。
 */
export async function refetchDonationModels(
  env: Env,
  donationId: string
): Promise<{
  ok: boolean
  added: string[]
  stillMissing: { model: string; reason: string }[]
  message: string
}> {
  const app = await env.DB.prepare(
    "SELECT payload, newapi_channel_id FROM donations WHERE id = ?"
  )
    .bind(donationId)
    .first<{ payload: string; newapi_channel_id: number | null }>()

  if (!app) return { ok: false, added: [], stillMissing: [], message: "捐献记录不存在" }
  if (!app.newapi_channel_id) {
    return { ok: false, added: [], stillMissing: [], message: "该捐献尚未接入渠道，无法补全" }
  }
  const channelId = app.newapi_channel_id

  let payload: { baseUrl?: string; apiKey?: string } = {}
  try {
    payload = JSON.parse(app.payload) as typeof payload
  } catch {
    return { ok: false, added: [], stillMissing: [], message: "捐献 payload 解析失败" }
  }
  const baseUrl = (payload.baseUrl ?? "").trim()
  const apiKey = (payload.apiKey ?? "").trim()
  if (!baseUrl || !apiKey) {
    return { ok: false, added: [], stillMissing: [], message: "缺少上游地址或密钥，无法重新拉取" }
  }

  // 拉上游当前的全量模型
  let upstreamModels: string[] = []
  try {
    const probe = await probeUpstream(baseUrl, apiKey, "openai")
    if (!probe.ok) {
      return { ok: false, added: [], stillMissing: [], message: `拉取上游模型失败：${probe.message}` }
    }
    upstreamModels = probe.models
  } catch (err) {
    return {
      ok: false,
      added: [],
      stillMissing: [],
      message: `拉取上游模型出错：${err instanceof Error ? err.message : String(err)}`,
    }
  }

  // 渠道当前有哪些模型
  let current: string[] = []
  try {
    const ch = await getChannel(env, channelId)
    if (!ch) {
      return { ok: false, added: [], stillMissing: [], message: "渠道已不存在（可能已被撤销）" }
    }
    current = ch.models
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean)
  } catch (err) {
    return {
      ok: false,
      added: [],
      stillMissing: [],
      message: `读取渠道失败：${err instanceof Error ? err.message : String(err)}`,
    }
  }

  // 差集：上游有、渠道没有的（去掉 donation- 前缀再比）
  const currentBase = new Set(
    current.map((m) =>
      m.startsWith(DONATION_MODEL_PREFIX) ? m.slice(DONATION_MODEL_PREFIX.length) : m
    )
  )
  const missing = upstreamModels.filter((m) => !currentBase.has(m))
  if (missing.length === 0) {
    return { ok: true, added: [], stillMissing: [], message: "渠道已包含上游全部模型，无需补全" }
  }

  // 逐个验证后并入
  const added: string[] = []
  const stillMissing: { model: string; reason: string }[] = []
  const results = await mapLimit(missing, TEST_CONCURRENCY, async (model) => {
    const r = await testChannel(env, channelId, model, TEST_TIMEOUT_MS)
    return { model, ok: r.ok, reason: r.message }
  })

  for (const r of results) {
    if (r.ok) added.push(r.model)
    else stillMissing.push({ model: r.model, reason: r.reason || "未通过" })
  }

  if (added.length > 0) {
    try {
      const merged = Array.from(new Set([...current, ...added]))
      const mapping = Object.fromEntries(merged.map((m) => [m, m]))
      await updateChannelModels(env, channelId, merged.join(","), JSON.stringify(mapping))
    } catch (err) {
      return {
        ok: false,
        added: [],
        stillMissing,
        message: `验证通过 ${added.length} 个，但写回渠道失败：${
          err instanceof Error ? err.message : String(err)
        }`,
      }
    }
  }

  // 仍缺的落库，交给定时重试（下次就不用再手动点）
  const nowIso = new Date().toISOString()
  for (const m of stillMissing) {
    try {
      await env.DB.prepare(
        `INSERT INTO donation_model_retries
           (donation_id, model, channel_id, status, reason, attempts, last_tried_at, next_retry_at, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
         ON CONFLICT(donation_id, model) DO UPDATE SET
           status = excluded.status, reason = excluded.reason, next_retry_at = excluded.next_retry_at`
      )
        .bind(
          donationId,
          m.model,
          channelId,
          classifyTestFailure(m.reason) === "failed" ? "failed" : "uncertain",
          m.reason.slice(0, 300),
          nowIso,
          new Date(Date.now() + 3600_000).toISOString(),
          nowIso
        )
        .run()
    } catch (err) {
      console.error("落库补全失败的模型出错:", donationId, m.model, err)
    }
  }

  return {
    ok: true,
    added,
    stillMissing,
    message:
      added.length > 0
        ? `已补入 ${added.length} 个模型${
            stillMissing.length > 0 ? `；${stillMissing.length} 个仍不可用（已排入重试）` : ""
          }`
        : `上游有 ${missing.length} 个模型不在渠道里，但逐个测试都没通过（已排入重试）`,
  }
}

/** Redirects are handled manually so each destination is checked before a request. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_PROBE_REDIRECTS = 4

async function fetchProbeResponse(
  rawUrl: string,
  headers: Record<string, string>
): Promise<Response> {
  let current = assertPublicHttpUrl(rawUrl, "上游 API 地址").url
  const initialOrigin = current.origin

  for (let redirects = 0; ; redirects++) {
    const destination = assertPublicHttpUrl(current.href, "上游 API 地址").url
    const requestHeaders = new Headers(headers)
    if (destination.origin !== initialOrigin) {
      requestHeaders.delete("Authorization")
      requestHeaders.delete("x-api-key")
    }

    const response = await fetch(destination.href, {
      method: "GET",
      headers: requestHeaders,
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!REDIRECT_STATUSES.has(response.status)) return response
    if (redirects >= MAX_PROBE_REDIRECTS) {
      throw new Error("上游重定向次数过多")
    }

    const location = response.headers.get("Location")
    if (!location) throw new Error("上游重定向缺少目标地址")
    try {
      current = new URL(location, destination)
    } catch {
      throw new Error("上游重定向地址无效")
    }
    assertPublicHttpUrl(current.href, "上游 API 地址")
  }
}
