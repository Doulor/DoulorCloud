/**
 * 捐献：用户贡献资源（模型渠道 / 内网穿透 / 代理订阅）来解锁功能权限。
 *
 * 流程与 frp_applications 一致：申请 → 管理员审核（带邮件通知）→ 批准即解锁权限。
 */
import { ApiError, json } from "../http"
import { uuid } from "../crypto"
import { requireUser, type UserRow } from "../auth"
import {
  FEATURE_LABELS,
  parsePermissions,
  type Feature,
} from "../permissions"
import { sendMail, renderMail } from "../mailer"
import { wb2apiDonationBlock } from "./wb2api"
import {
  grantQuotaForDonation,
  INVITE_BONUS_PER_DONATION,
  isBasicFeature,
  QUOTA_FEATURE_LABELS,
  type QuotaFeature,
} from "../quotas"
import {
  DONATION_CHANNEL_OPENAI,
  DONATION_CHANNEL_TYPES,
  MAX_DONATION_MODELS,
  probeUpstream,
  provisionDonationChannel,
  releaseDonationChannel,
  validateUpstreamUrl,
  type UpstreamFormat,
} from "../donation-provision"
import { isNewApiConfigured, testChannel } from "../newapi-client"
import {
  MAX_DONATION_SUB_URLS,
  detectSubscriptionProfile,
  verifySubscriptionUrls,
  type SubscriptionCheck,
} from "./proxy"
import { guardRateLimit } from "../ratelimit"
import { grantFirstDonationVoucher } from "../vouchers"
import { getSettings } from "../settings"
import type { Env } from "../env"

interface DonationRow {
  id: string
  user_id: string
  type: string
  payload: string
  notify_email: string
  remark: string | null
  status: string
  review_note: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  granted_feature: number | null
  /** 自动创建的 NewAPI 渠道 id（AI 类型才有值） */
  newapi_channel_id: number | null
  /** 本次审核是否由系统自动完成 */
  auto_reviewed: number | null
  created_at: string
}

/** AI 捐献的 payload 结构（提交时由前端组装） */
interface AiDonationPayload {
  baseUrl?: string
  apiKey?: string
  models?: unknown
  /** 用户手填模型的兜底路径（探测失败时使用），标记后强制走人工复核 */
  manualModels?: boolean
  /** 接口格式对应的 NewAPI 渠道类型（1 = OpenAI 兼容，14 = Anthropic） */
  channelType?: number
}

/** 从 payload JSON 里取出 AI 捐献的要素；缺失则返回 null */
function parseAiPayload(payloadStr: string): {
  baseUrl: string
  apiKey: string
  models: string[]
  /** 模型名是用户手填的（上游 /v1/models 读不到），拒绝时在原因里点明 */
  manual: boolean
  /** NewAPI 渠道类型；缺省按 OpenAI 兼容 */
  channelType: number
} | null {
  let raw: AiDonationPayload
  try {
    raw = JSON.parse(payloadStr) as AiDonationPayload
  } catch {
    return null
  }
  const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : ""
  const apiKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : ""
  const models = Array.isArray(raw.models)
    ? raw.models.filter((m): m is string => typeof m === "string" && m.trim() !== "")
    : []
  if (!baseUrl || !apiKey) return null
  // 白名单：只认我们支持的两种格式，其余一律回落到 OpenAI 兼容
  const channelType = DONATION_CHANNEL_TYPES.includes(Number(raw.channelType))
    ? Number(raw.channelType)
    : DONATION_CHANNEL_OPENAI
  return { baseUrl, apiKey, models, manual: raw.manualModels === true, channelType }
}

/** 捐献类型 → 对应的功能权限 */
const DONATION_TYPES: Record<string, Feature> = {
  ai: "ai",
  frp: "frp",
  proxy: "proxy",
}

/**
 * 代理节点捐献通过后，把订阅链接写入节点池（proxy_subscriptions）。
 *
 * payload 形如 `{ subUrls: ["https://...", ...] }`。
 *
 * 两种调用方式：
 *   - 带 `checks`（自动审核路径）：**只导入校验通过的**，并把识别出的协议/地区一起写上，
 *     省得管理员再去补。这是主要路径。
 *   - 不带 `checks`（管理员手工放行）：按原样全部导入，尽量识别协议/地区但失败也不拦
 *     —— 管理员已经明确批准了，不该因为我们抓不到就丢弃。
 *
 * 幂等：同一个 URL 已在节点池里（无论来自谁）就跳过，避免重复条目。
 * `donationId` 用于记录来源，撤销这笔捐献时据此精确收回。
 */
async function importProxySubscriptions(
  env: Env,
  payloadStr: string,
  opts: { checks?: SubscriptionCheck[]; donationId?: string } = {}
): Promise<number> {
  let subUrls: string[] = []
  try {
    const parsed = JSON.parse(payloadStr) as { subUrls?: unknown }
    if (Array.isArray(parsed.subUrls)) {
      subUrls = parsed.subUrls
        .filter((u): u is string => typeof u === "string")
        .map((u) => u.trim())
        .filter((u) => /^https?:\/\//i.test(u))
    }
  } catch {
    return 0
  }
  if (subUrls.length === 0) return 0

  // 自动审核路径：只保留通过校验的，并带上识别结果
  const byUrl = new Map((opts.checks ?? []).map((c) => [c.url, c]))
  const targets = opts.checks
    ? subUrls.filter((u) => byUrl.get(u)?.ok)
    : subUrls

  let imported = 0
  for (const url of targets) {
    const exists = await env.DB.prepare(
      "SELECT id FROM proxy_subscriptions WHERE url = ? LIMIT 1"
    )
      .bind(url)
      .first()
    if (exists) continue

    let host = url
    try {
      host = new URL(url).hostname
    } catch {
      /* 保留原 url 作为 name */
    }

    // 手工放行路径没有识别结果，就地补一次（失败不阻断，协议地区留空由管理员补）
    let protocol = byUrl.get(url)?.protocol ?? null
    let region = byUrl.get(url)?.region ?? null
    let status = byUrl.get(url)?.ok ? "online" : "unknown"
    if (!opts.checks) {
      try {
        const profile = await detectSubscriptionProfile(env, { id: "", url })
        protocol = profile.protocol
        region = profile.region
        status = profile.ok ? "online" : "unknown"
      } catch {
        /* 忽略 */
      }
    }

    await env.DB.prepare(
      `INSERT INTO proxy_subscriptions
         (id, name, region, url, protocol, status, enabled, sort_order, note,
          source_donation_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)`
    )
      .bind(
        uuid(),
        host,
        region,
        url,
        protocol ?? "mixed",
        status,
        "由捐献导入",
        opts.donationId ?? null,
        new Date().toISOString(),
        new Date().toISOString()
      )
      .run()
    imported += 1
  }
  return imported
}

/** 敏感字段：用户端列表一律不返回（管理端核验时才需要） */
const SENSITIVE_KEYS = ["apiKey", "baseUrl", "subUrls", "configYml", "password", "token"]

function toPublicDonation(
  row: DonationRow,
  username: string,
  opts: { redactPayload?: boolean } = {}
) {
  let payload: unknown = null
  try {
    payload = JSON.parse(row.payload)
  } catch {
    // fallthrough
  }

  if (opts.redactPayload && payload && typeof payload === "object") {
    const copy = { ...(payload as Record<string, unknown>) }
    for (const k of SENSITIVE_KEYS) delete copy[k]
    payload = copy
  }

  return {
    id: row.id,
    type: row.type,
    username,
    payload,
    // 通知邮箱也只在管理端返回
    notifyEmail: opts.redactPayload ? undefined : row.notify_email,
    remark: row.remark,
    status: row.status,
    reviewNote: row.review_note,
    /** 系统自动创建的 NewAPI 渠道 id；null = 尚未接入中转站 */
    channelId: row.newapi_channel_id ?? null,
    /** true = 这次审核是系统自动做的（自动通过或自动拒绝） */
    autoReviewed: (row.auto_reviewed ?? 0) === 1,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  }
}

async function requireAdminUser(env: Env, request: Request): Promise<UserRow> {
  const user = await requireUser(env, request)
  if (user.role !== "admin") {
    throw new ApiError(403, "需要管理员权限", "FORBIDDEN")
  }
  return user
}

/** 带用户名的捐献行（管理端 / 审核路径都要用） */
type DonationRowWithUser = DonationRow & {
  username: string
  permissions: string | null
}

/**
 * 「AI 渠道捐献」下一步该用的渠道序号。
 *
 * 为什么不用 NewAPI 的渠道列表去算：`GET /api/channel/` 是分页接口，
 * 拿到的只是某一页，据此算序号会撞名。改用**本库自己的计数** ——
 * `newapi_channel_id` 一旦写入就不再清空，所以「曾经接入过的捐献笔数 + 1」
 * 单调递增，撤销后重新批准也不会复用同一个「捐献NN」。
 * 管理员在中转站手工建的渠道不占用这个序号（名字不同，不冲突）。
 */
async function resolveDonationChannelSeq(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM donations WHERE newapi_channel_id IS NOT NULL"
  ).first<{ n: number }>()
  return Number(row?.n ?? 0) + 1
}

/**
 * 批准一笔捐献的**全部副作用**：解锁权限 → 更新单据 → 发额度 → 类型专属动作。
 *
 * 抽出来是因为「系统自动通过」和「管理员点通过」必须做完全一样的事情，
 * 差别只在 `adminId`（自动为 null，用于区分审计与 auto_reviewed 标记）。
 * 邮件通知**不在这里**——自动流程与人工流程的措辞不同，由调用方各发各的。
 */
async function applyDonationApproval(
  env: Env,
  app: DonationRowWithUser,
  opts: {
    adminId: string | null
    note: string | null
    channelId?: number | null
    /** 代理捐献：自动审核算出的校验结果（只导入通过的） */
    proxyChecks?: SubscriptionCheck[]
  }
): Promise<{ voucherCode: string | null }> {
  const feature = DONATION_TYPES[app.type] as Feature
  const now = new Date().toISOString()

  const perms = parsePermissions(app.permissions)
  // 记录「这次是否真正授予了权限」：置 true 之前若为 false，才算新增
  const granted = perms[feature] !== true
  perms[feature] = true

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE donations
          SET status = 'approved', review_note = ?, reviewed_by = ?, reviewed_at = ?,
              granted_feature = ?, auto_reviewed = ?,
              newapi_channel_id = COALESCE(?, newapi_channel_id)
        WHERE id = ?`
    ).bind(
      opts.note,
      opts.adminId,
      now,
      granted ? 1 : 0,
      opts.adminId ? 0 : 1,
      opts.channelId ?? null,
      app.id
    ),
    env.DB.prepare("UPDATE users SET permissions = ?, updated_at = ? WHERE id = ?").bind(
      JSON.stringify(perms),
      now,
      app.user_id
    ),
  ])

  // 发放邀请码额度：+2 邀请码额度，且 +1 对应模块的可转授额度。
  // 放在 permissions 更新之后，失败会让整次审核报错，避免「权限给了但额度没给」
  // 的静默不一致（管理员可重试）。
  await grantQuotaForDonation(env, app.user_id, feature)

  // 代理节点捐献：把订阅链接写进节点池（proxy_subscriptions），供所有用户使用。
  // 自动审核路径只导入校验通过的；管理员手工放行则全部导入。
  if (app.type === "proxy") {
    await importProxySubscriptions(env, app.payload, {
      checks: opts.proxyChecks,
      donationId: app.id,
    })
  }

  await env.DB.prepare(
    "INSERT INTO audit_logs (id, user_id, action, detail, created_at) VALUES (?, ?, 'donation.review', ?, ?)"
  )
    .bind(
      uuid(),
      opts.adminId ?? app.user_id,
      `${app.username} 的${FEATURE_LABELS[feature]}捐献：${
        opts.adminId ? "批准" : "系统自动批准"
      }`,
      now
    )
    .run()

  // 首次捐献成功 → 送一张「自选权限」券（幂等，失败不影响审核本身）。
  // 放在最后：券是奖励，不能因为它出错就把已经生效的权限回滚。
  let voucherCode: string | null = null
  try {
    voucherCode = await grantFirstDonationVoucher(env, app.user_id)
  } catch (err) {
    console.error("发放首捐券失败:", app.user_id, err)
  }
  return { voucherCode }
}

/**
 * 代理节点捐献的自动审核：逐个校验订阅链接 → 只导入可用的，全不可用则拒绝。
 *
 * 判据与 AI 那条线同构（「真的调一次，能用的才留」），只是这里能验证的边界不同：
 * Cloudflare 出网**拿不到节点的真实连通性**（无法对任意 TCP/UDP 端口探测），
 * 所以只能验证「订阅链接有效 + 能解析出节点列表」。
 * 现实里这已经能挡掉绝大多数无效捐献 —— 链接失效、被墙、给的是网页而不是订阅。
 */
async function autoReviewProxyDonation(
  env: Env,
  input: { id: string; payloadStr: string }
): Promise<{
  status: "pending" | "approved" | "rejected"
  note: string | null
  channelId: null
  voucherCode?: string | null
}> {
  let subUrls: string[] = []
  try {
    const parsed = JSON.parse(input.payloadStr) as { subUrls?: unknown }
    if (Array.isArray(parsed.subUrls)) {
      subUrls = parsed.subUrls
        .filter((u): u is string => typeof u === "string")
        .map((u) => u.trim())
        .filter(Boolean)
    }
  } catch {
    // 下面按「没填链接」处理
  }
  if (subUrls.length === 0) {
    return { status: "pending", note: null, channelId: null }
  }

  const app = await env.DB.prepare(
    `SELECT d.*, u.username, u.permissions FROM donations d
       JOIN users u ON u.id = d.user_id
      WHERE d.id = ?`
  )
    .bind(input.id)
    .first<DonationRowWithUser>()
  if (!app) return { status: "pending", note: null, channelId: null }

  const now = new Date().toISOString()

  const reject = async (
    reason: string
  ): Promise<{ status: "rejected"; note: string; channelId: null }> => {
    const note = `系统自动校验未通过：${reason}`
    await env.DB.prepare(
      `UPDATE donations SET status = 'rejected', review_note = ?, reviewed_at = ?, auto_reviewed = 1 WHERE id = ?`
    )
      .bind(note, now, input.id)
      .run()
    await notifyDonationResult(env, app, false, note, { auto: true })
    return { status: "rejected", note, channelId: null }
  }

  let checks: SubscriptionCheck[]
  try {
    checks = await verifySubscriptionUrls(env, subUrls)
  } catch (err) {
    // 校验本身出错（不该发生）→ 交人工，别让用户的提交白白失败
    console.error("代理订阅自动校验失败，转为待人工审核:", err)
    return { status: "pending", note: null, channelId: null }
  }

  const good = checks.filter((c) => c.ok)
  const failed = checks.filter((c) => !c.ok)

  if (good.length === 0) {
    return reject(
      `${subUrls.length} 个订阅链接都没有解析出节点 —— ${failed
        .map((f) => `${f.url}（${f.error}）`)
        .join("；")}`
    )
  }

  const usable = good.reduce((n, c) => n + c.nodeCount, 0)
  const summary = `自动校验通过：${good.length}/${subUrls.length} 个订阅可用，共 ${usable} 个节点（${good
    .map((c) => `${c.protocol ?? "未知协议"}${c.region ? `·${c.region}` : ""} ${c.nodeCount} 个`)
    .join("；")}）`
  const note =
    failed.length > 0
      ? `${summary}。未通过：${failed.map((f) => `${f.url}（${f.error}）`).join("；")}`
      : summary

  const applied = await applyDonationApproval(env, app, {
    adminId: null,
    note,
    proxyChecks: checks,
  })
  await notifyDonationResult(env, app, true, null, {
    auto: true,
    voucherCode: applied.voucherCode,
  })
  return {
    status: "approved",
    note,
    channelId: null,
    voucherCode: applied.voucherCode,
  }
}

/**
 * 解析「哪些模块走自动审核」的设置（auto_review_features）。
 * 逗号分隔的模块名；只认 ai/frp/proxy，认不出的直接丢掉（**不做兜底**，
 * 与 invite_basic_features 同一教训：兜底会让某个开关关不掉）。
 */
export function parseAutoReviewFeatures(raw: string | null | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of (raw ?? "").split(",")) {
    const f = part.trim().toLowerCase()
    if (!f) continue
    if (!["ai", "frp", "proxy"].includes(f)) continue
    if (seen.has(f)) continue
    seen.add(f)
    out.push(f)
  }
  return out
}

/**
 * frp 捐献的自动审核：对 config.yml 做**静态**校验。
 *
 * ⚠️ 能做的只有这些，而且**验证不了连通性**：
 *   - YAML 语法合法（不炸解析）
 *   - 包含 frp 客户端连 frps 必须的字段（serverAddr；token 可缺省但推荐有）
 *
 * 为什么验证不了连通性：内网穿透的架构是「**公网**服务器跑 frps、内网机器跑 frpc
 * 主动连上去」。这段 yml 是 frpc 客户端配置，`serverAddr` 指向一台**公网** frps ——
 * 理论上可达。但 frpc↔frps 之间是 **frp 私有 TCP 协议**（默认 7000 端口），不是
 * HTTP；而本站 Worker 跑在 Cloudflare 上，出站**只能发 HTTP/HTTPS、不能建立任意
 * TCP 连接**，所以没法做握手验证。能做的顶多是「若那台 frps 恰好还开着 HTTP 端口
 * 就探一下」，但 config.yml 里不写 dashboard 地址，探不了、也不可靠。
 *
 * 因此这个模块默认**不**开自动审核（auto_review_features 默认只含 ai,proxy）；
 * 管理员若想「格式合理就自动放行」，再手动把 frp 加进开关即可。
 */
async function autoReviewFrpDonation(
  env: Env,
  input: { id: string; payloadStr: string }
): Promise<{
  status: "pending" | "approved" | "rejected"
  note: string | null
  channelId: null
  voucherCode?: string | null
}> {
  let configYml = ""
  try {
    const parsed = JSON.parse(input.payloadStr) as { configYml?: unknown }
    if (typeof parsed.configYml === "string") configYml = parsed.configYml.trim()
  } catch {
    // 下面按「没填」处理
  }
  if (!configYml) {
    return { status: "pending", note: null, channelId: null }
  }

  const app = await env.DB.prepare(
    `SELECT d.*, u.username, u.permissions FROM donations d
       JOIN users u ON u.id = d.user_id
      WHERE d.id = ?`
  )
    .bind(input.id)
    .first<DonationRowWithUser>()
  if (!app) return { status: "pending", note: null, channelId: null }

  const now = new Date().toISOString()
  const reject = async (
    reason: string
  ): Promise<{ status: "rejected"; note: string; channelId: null }> => {
    const note = `系统自动校验未通过：${reason}`
    await env.DB.prepare(
      `UPDATE donations SET status = 'rejected', review_note = ?, reviewed_at = ?, auto_reviewed = 1 WHERE id = ?`
    )
      .bind(note, now, input.id)
      .run()
    await notifyDonationResult(env, app, false, note, { auto: true })
    return { status: "rejected", note, channelId: null }
  }

  // 1) YAML 语法：用一个极简的「行缩进 + 冒号」探测，够用即可。
  //    真正的 YAML 解析器体积大，这里只做能抓出「明显不是 yml」的校验。
  if (configYml.length > 64 * 1024) {
    return reject("config.yml 超过 64 KB，内容异常")
  }
  const looksLikeYaml = /^[A-Za-z_][\w.-]*\s*:/.test(configYml.split("\n")[0] ?? "")
  if (!looksLikeYaml) {
    return reject("config.yml 首行不是「键: 值」格式，可能不是合法的 frp 配置")
  }

  // 2) 必填字段：frp 客户端要能连上 frps，serverAddr 是硬性要求。
  if (!/^\s*serverAddr\s*:/m.test(configYml)) {
    return reject("config.yml 缺少 serverAddr（frp 服务端地址），无法判断可用")
  }

  // 3) 可选但推荐的 token / auth。没有也不拦（有的部署确实不设 token），
  //    只是放进备注提醒管理员留意。
  const hasAuth = /^\s*(token|auth\.token|user|auth)\s*:/m.test(configYml)

  const note = `自动校验通过：config.yml 为合法 YAML 且含 serverAddr${
    hasAuth ? "、鉴权字段" : "（未发现鉴权字段，请确认该 frps 是否真的无需鉴权）"
  }`
  const applied = await applyDonationApproval(env, app, {
    adminId: null,
    note,
  })
  await notifyDonationResult(env, app, true, null, {
    auto: true,
    voucherCode: applied.voucherCode,
  })
  return {
    status: "approved",
    note,
    channelId: null,
    voucherCode: applied.voucherCode,
  }
}

/**
 * AI 捐献的自动接入流程：建渠道 → 测试 → 自动通过 / 自动拒绝。
 *
 * 返回给调用方的是**最终状态**，直接作为提交接口的响应告诉用户结果。
 * 若中转站本身没配置好（缺 NEWAPI_BASE_URL / 管理员令牌），不擅自拒绝，
 * 保留 pending 交给管理员手工处理 —— 那是平台侧的问题，不该由用户承担。
 */
async function autoProvisionAiDonation(
  env: Env,
  input: { id: string; payloadStr: string }
): Promise<{
  status: "pending" | "approved" | "rejected"
  note: string | null
  channelId: number | null
  /** 首次捐献成功时发的「自选权限」券码，用于回显给用户 */
  voucherCode?: string | null
}> {
  if (!(await isNewApiConfigured(env))) return { status: "pending", note: null, channelId: null }

  const parsed = parseAiPayload(input.payloadStr)
  if (!parsed) return { status: "pending", note: null, channelId: null }

  const app = await env.DB.prepare(
    `SELECT d.*, u.username, u.permissions FROM donations d
       JOIN users u ON u.id = d.user_id
      WHERE d.id = ?`
  )
    .bind(input.id)
    .first<DonationRowWithUser>()
  if (!app) return { status: "pending", note: null, channelId: null }

  const now = new Date().toISOString()

  // 一次拒绝：把原因写进 review_note 并标 auto_reviewed，管理员据此复核
  const reject = async (reason: string): Promise<{
    status: "rejected"
    note: string
    channelId: null
  }> => {
    const note = `系统自动校验未通过：${reason}`
    await env.DB.prepare(
      `UPDATE donations SET status = 'rejected', review_note = ?, reviewed_at = ?, auto_reviewed = 1 WHERE id = ?`
    )
      .bind(note, now, input.id)
      .run()
    await notifyDonationResult(env, app, false, note, { auto: true })
    return { status: "rejected", note, channelId: null }
  }

  let baseUrl: string
  try {
    baseUrl = validateUpstreamUrl(parsed.baseUrl).baseUrl
  } catch (err) {
    return reject(err instanceof Error ? err.message : String(err))
  }

  if (parsed.models.length === 0) {
    return reject("没有选择任何模型")
  }

  const seq = await resolveDonationChannelSeq(env)
  const result = await provisionDonationChannel(env, {
    baseUrl,
    apiKey: parsed.apiKey,
    models: parsed.models,
    channelType: parsed.channelType,
    seq,
  })

  if (!result.ok) {
    const reason = result.detail ? `${result.message}（${result.detail}）` : result.message
    return reject(parsed.manual ? `${reason}；模型名由用户手填，请重点核对` : reason)
  }

  const note = `自动校验通过：${result.detail}`
  const { voucherCode } = await applyDonationApproval(env, app, {
    adminId: null,
    note,
    channelId: result.channelId,
  })
  await notifyDonationResult(env, app, true, null, { auto: true, voucherCode })
  return { status: "approved", note, channelId: result.channelId, voucherCode }
}

/** 发结果邮件（失败只记日志，不影响审核本身） */
async function notifyDonationResult(
  env: Env,
  app: DonationRowWithUser,
  approve: boolean,
  note: string | null,
  opts: { auto?: boolean; voucherCode?: string | null } = {}
): Promise<void> {
  const feature = DONATION_TYPES[app.type] as Feature
  const quotaFeature = feature as QuotaFeature
  try {
    const basic = await isBasicFeature(env, quotaFeature)
    // 基础权限模块的人人可授，获批时无需发放模块额度，文案也要同步去掉
    const quotaLine = basic
      ? `同时获得 ${INVITE_BONUS_PER_DONATION} 个邀请码创建额度` +
        `（「${QUOTA_FEATURE_LABELS[quotaFeature] ?? FEATURE_LABELS[feature]}」已是基础权限，人人可授）。`
      : `同时获得 ${INVITE_BONUS_PER_DONATION} 个邀请码创建额度，` +
        `以及 1 个「${QUOTA_FEATURE_LABELS[quotaFeature] ?? FEATURE_LABELS[feature]}」权限额度` +
        "（创建邀请码时可授予该权限）。"
    const lines = approve
      ? [
          `捐献类型：${FEATURE_LABELS[feature]}`,
          opts.auto
            ? "你的捐献资源已通过系统自动校验，对应功能权限已解锁。"
            : "你的捐献申请已通过审核，对应功能权限已解锁。",
          quotaLine,
          opts.voucherCode
            ? `另外，这是你的首次捐献成功 —— 送你一张「自选权限」兑换券：${opts.voucherCode}`
            : "",
          opts.voucherCode
            ? "可在 Doulor Cloud 的「捐献」页面「兑换权限」里选一个你还没开通的模块使用。"
            : "",
          note ? `管理员备注：${note}` : "",
          "请到 Doulor Cloud 的「捐献」页面查看额度并创建邀请码。",
        ]
      : [
          `捐献类型：${FEATURE_LABELS[feature]}`,
          "很抱歉，你的捐献申请未通过审核。",
          note ? `原因：${note}` : "",
          "如有疑问可联系管理员，或修改后重新提交。",
        ]
    const { text, html } = renderMail(
      approve ? "捐献申请已通过" : "捐献申请未通过",
      lines.filter(Boolean)
    )
    await sendMail(env, {
      to: app.notify_email,
      subject: approve
        ? "【Doulor Cloud】捐献申请已通过"
        : "【Doulor Cloud】捐献申请未通过",
      text,
      html,
    })
  } catch (err) {
    console.error("捐献结果邮件发送失败:", app.notify_email, err)
  }
}

/**
 * GET /api/donations —— 当前用户的捐献记录
 * 普通用户：只看自己的；管理员看全部
 */
/**
 * GET /api/donations —— 用户端列表：**只返回自己的申请**。
 *
 * 管理员看全部是管理页的职责（/api/admin/donations），
 * 这里绝不能因为调用者是管理员就把别人的申请也返回：
 * 那会让管理员的用户端看到他人申请，且带出 payload（可能含 API Key、
 * 订阅链接等敏感凭据）与通知邮箱。
 */
export async function listDonations(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)

  const rows = await env.DB.prepare(
    `SELECT * FROM donations WHERE user_id = ? ORDER BY created_at DESC`
  )
    .bind(user.id)
    .all<DonationRow>()

  // 反代账号捐献通道（WorkBuddy 网关）是**免审核**的独立通道，记录不在本表里。
  // 捐献页需要一次请求就拿到「能不能捐 / 捐了几个」，故顺带带出。
  const wb2api = await wb2apiDonationBlock(env, user.id)

  return json({
    // 用户端不回显敏感凭据（API Key / 订阅链接等）——列表只用于看状态与撤回，
    // 提交后无需再次展示；这也避免他人（含管理员误操作）在用户端读取到凭据。
    donations: (rows.results ?? []).map((r) =>
      toPublicDonation(r, user.username, { redactPayload: true })
    ),
    types: Object.keys(DONATION_TYPES),
    typeLabels: Object.fromEntries(
      Object.entries(DONATION_TYPES).map(([t, f]) => [t, FEATURE_LABELS[f]])
    ),
    // 用户当前权限（前端据此判断哪些功能需要捐献）
    permissions: parsePermissions(user.permissions),
    /** AI 捐献一次最多可选多少个模型（前端据此提示并限制勾选） */
    maxAiModels: MAX_DONATION_MODELS,
    /** 代理捐献一次最多可提交多少个订阅链接（每个都要真拉一次） */
    maxSubUrls: MAX_DONATION_SUB_URLS,
    wb2api,
  })
}

/**
 * GET /api/admin/donations —— 管理端列表：全部申请，含完整 payload
 * （管理页需要看 API Key / 订阅链接来核验资源是否可用）。
 */
export async function listAllDonations(
  env: Env,
  request: Request
): Promise<Response> {
  const admin = await requireUser(env, request)
  if (admin.role !== "admin") {
    throw new ApiError(403, "需要管理员权限", "FORBIDDEN")
  }

  const rows = await env.DB.prepare(
    `SELECT d.*, u.username FROM donations d
       JOIN users u ON u.id = d.user_id
      ORDER BY d.created_at DESC`
  ).all<DonationRow & { username: string }>()

  return json({
    donations: (rows.results ?? []).map((r) => toPublicDonation(r, r.username)),
    typeLabels: Object.fromEntries(
      Object.entries(DONATION_TYPES).map(([t, f]) => [t, FEATURE_LABELS[f]])
    ),
  })
}

/**
 * POST /api/donations/ai/probe —— 探测上游，取回可选模型列表。
 * body: { baseUrl, apiKey }
 *
 * 用「自动获取模型让用户勾选」替代「手打模型名」：手打的名字十有八九写错，
 * 而且我们无法确认它上游到底有没有。探测成功同时意味着 baseUrl/key 是真的。
 *
 * 这个接口**不写库**，但它会由服务端向用户提供的地址发起请求 —— 属于 SSRF 面，
 * 所以做了三层约束：① 必须登录；② 限流（同一用户 10 次 / 5 分钟）；
 * ③ 拒绝本机与内网地址（见 donation-provision.ts 的 validateUpstreamUrl）。
 */
export async function probeAiUpstream(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  await guardRateLimit(
    env,
    `donation:ai-probe:user:${user.id}`,
    10,
    300,
    "探测上游过于频繁"
  )

  const body = (await request.json()) as {
    baseUrl?: unknown
    apiKey?: unknown
    format?: unknown
  }
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl : ""
  const apiKey = typeof body.apiKey === "string" ? body.apiKey : ""
  if (apiKey.length > 500 || baseUrl.length > 500) {
    throw new ApiError(400, "地址或密钥过长", "INVALID_PAYLOAD")
  }

  const format: UpstreamFormat =
    body.format === "openai" || body.format === "anthropic" ? body.format : "auto"

  const result = await probeUpstream(baseUrl, apiKey, format)
  return json(result)
}

/**
 * POST /api/donations —— 提交捐献申请
 * body: { type, payload, remark? }
 */
export async function createDonation(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json()) as {
    type?: string
    payload?: unknown
    remark?: string
  }

  const type = (body.type ?? "").trim().toLowerCase()
  if (!DONATION_TYPES[type]) {
    throw new ApiError(400, "不支持的捐献类型", "INVALID_TYPE")
  }

  const feature = DONATION_TYPES[type]
  // 注意：**已拥有权限的用户也允许捐献**（用户明确要求）。
  // 未解锁者会从受限页面被引导过来；已解锁者也可主动贡献资源。
  // 批准时只是把对应 feature 再置为 true，对已解锁用户无副作用。

  // 校验 payload
  if (!body.payload || typeof body.payload !== "object") {
    throw new ApiError(400, "请填写资源详情", "INVALID_PAYLOAD")
  }

  // AI 类型：先把 baseUrl 归一化并**回写进 payload**（去掉尾部 `/v1` 等）。
  // 入库的必须是「真正会拿去建渠道的那个地址」，否则管理员事后看详情、
  // 或走人工复核重试时，拿到的还是用户原始输入，会出现 `.../v1/v1/...`。
  if (type === "ai") {
    const p = body.payload as { baseUrl?: unknown }
    if (typeof p.baseUrl !== "string" || !p.baseUrl.trim()) {
      throw new ApiError(400, "请填写上游 API 地址", "INVALID_BASE_URL")
    }
    try {
      p.baseUrl = validateUpstreamUrl(p.baseUrl).baseUrl
    } catch (err) {
      throw new ApiError(
        400,
        err instanceof Error ? err.message : "上游 API 地址不合法",
        "INVALID_BASE_URL"
      )
    }
  }

  const payloadStr = JSON.stringify(body.payload)
  if (payloadStr.length > 10000) {
    throw new ApiError(400, "资源详情过长", "TOO_LARGE")
  }

  // AI 类型的提交，除了格式还要求「真的像一份资源」：
  // 必须选到模型、同一上游不能重复提交。
  // 这些校验放在入库之前，避免用无效 payload 去调中转站的建渠道接口。
  if (type === "ai") {
    // 接口格式只认白名单；传了不认识的直接拒，别静默回落（那会让用户以为生效了）
    const rawFormat = (body.payload as { channelType?: unknown }).channelType
    if (rawFormat !== undefined && !DONATION_CHANNEL_TYPES.includes(Number(rawFormat))) {
      throw new ApiError(
        400,
        "不支持的接口格式，只支持 OpenAI 兼容 / Anthropic 原生",
        "INVALID_CHANNEL_TYPE"
      )
    }
    const parsed = parseAiPayload(payloadStr)
    if (!parsed) {
      throw new ApiError(
        400,
        "请填写上游 API 地址与密钥，并至少选择 1 个模型",
        "INVALID_PAYLOAD"
      )
    }
    if (parsed.models.length === 0) {
      throw new ApiError(400, "请至少选择 1 个要捐献的模型", "NO_MODELS")
    }
    if (parsed.models.length > MAX_DONATION_MODELS) {
      // 上限的原因：每个模型都要真的向上游发一次请求来验证可用性，
      // 数量不受限会让提交请求等到超时，而「超时但其实建好了」最难排查。
      throw new ApiError(
        400,
        `一次最多捐献 ${MAX_DONATION_MODELS} 个模型（当前 ${parsed.models.length} 个）。` +
          "每个模型都要真实调用一次来验证可用性，请只挑最常用的。",
        "TOO_MANY_MODELS"
      )
    }
    // 同一上游重复提交没有意义（会建出重复渠道），只挡未被拒绝的那些
    const dup = await env.DB.prepare(
      `SELECT id FROM donations
        WHERE user_id = ? AND type = 'ai' AND status IN ('pending','approved')
          AND payload LIKE ? LIMIT 1`
    )
      .bind(user.id, `%"baseUrl":"${parsed.baseUrl}"%`)
      .first()
    if (dup) {
      throw new ApiError(409, "这个上游地址你已经提交过了", "DUPLICATE_UPSTREAM")
    }
  }

  // 代理捐献：只校验数量与协议格式；**地址是否可用交给自动校验**逐个判定，
  // 这样一条坏链接不会把同一批里好的那些一起废掉。
  if (type === "proxy") {
    const p = body.payload as { subUrls?: unknown }
    const urls = Array.isArray(p.subUrls)
      ? p.subUrls.filter((u): u is string => typeof u === "string").map((u) => u.trim()).filter(Boolean)
      : []
    if (urls.length === 0) {
      throw new ApiError(400, "请填写至少一个订阅链接", "NO_SUB_URLS")
    }
    if (urls.length > MAX_DONATION_SUB_URLS) {
      throw new ApiError(
        400,
        `一次最多提交 ${MAX_DONATION_SUB_URLS} 个订阅链接（当前 ${urls.length} 个）。` +
          "每个都要真实拉取一次来验证，请分批提交。",
        "TOO_MANY_SUB_URLS"
      )
    }
    for (const u of urls) {
      let ok = false
      try {
        const parsed = new URL(u)
        ok = parsed.protocol === "http:" || parsed.protocol === "https:"
      } catch {
        ok = false
      }
      if (!ok) {
        throw new ApiError(
          400,
          `订阅链接必须是 http/https 地址：${u.slice(0, 60)}`,
          "INVALID_SUB_URL"
        )
      }
    }
  }

  // 通知邮箱：优先用已验证的真实邮箱
  const notifyEmail = user.email
  if (!notifyEmail || notifyEmail.endsWith(`@${env.ROOT_DOMAIN.toLowerCase()}`)) {
    throw new ApiError(400, "请先在「设置」中验证真实邮箱", "NO_NOTIFY_EMAIL")
  }

  // 同类型不能有 pending 申请
  const pending = await env.DB.prepare(
    "SELECT id FROM donations WHERE user_id = ? AND type = ? AND status = 'pending' LIMIT 1"
  )
    .bind(user.id, type)
    .first()
  if (pending) {
    throw new ApiError(409, "你已有一个该类型的申请待审核", "PENDING_EXISTS")
  }

  const id = uuid()
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO donations (id, user_id, type, payload, notify_email, remark, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
  )
    .bind(
      id,
      user.id,
      type,
      payloadStr,
      notifyEmail,
      (body.remark ?? "").trim().slice(0, 500) || null,
      now
    )
    .run()

  // ---- AI 类型：入库后立刻走自动化（建渠道 → 测试 → 自动通过 / 自动拒绝）----
  //
  // 为什么放在提交这一步而不是等管理员点审核：审核能做的判断（模型列表是否真实、
  // 接口是否可用）系统都能做，而且做得更实——它会真的向上游发一次对话请求。
  // 自动通过的用户当场拿到权限，自动拒绝的进管理员的「待复核」队列。
  let auto: {
    status: "pending" | "approved" | "rejected"
    note: string | null
    channelId: number | null
    voucherCode?: string | null
  } | null = null

  // 是否对该模块开自动审核 —— 由管理员在「设置」里控制（auto_review_features）。
  const settings = await getSettings(env)
  const autoReviewOn = parseAutoReviewFeatures(settings.auto_review_features).includes(
    type as "ai" | "proxy" | "frp"
  )

  if (type === "ai" && autoReviewOn) {
    try {
      auto = await autoProvisionAiDonation(env, { id, payloadStr })
    } catch (err) {
      // 自动流程本身出错（中转站抖动等）不能让提交失败——单据已入库，
      // 退化成「待人工审核」是安全的兜底。
      console.error("AI 捐献自动接入失败，转为待人工审核:", err)
      auto = { status: "pending", note: null, channelId: null }
    }
  } else if (type === "proxy" && autoReviewOn) {
    try {
      auto = await autoReviewProxyDonation(env, { id, payloadStr })
    } catch (err) {
      console.error("代理捐献自动审核失败，转为待人工审核:", err)
      auto = { status: "pending", note: null, channelId: null }
    }
  } else if (type === "frp" && autoReviewOn) {
    // frp 的自动审核只能做「config.yml 语法 + 必填字段」的静态校验，
    // **不验证连通性**（yml 指向用户自己的服务，服务器侧够不到）。
    // 见 autoReviewFrpDonation 的说明。默认不开启。
    try {
      auto = await autoReviewFrpDonation(env, { id, payloadStr })
    } catch (err) {
      console.error("frp 捐献自动审核失败，转为待人工审核:", err)
      auto = { status: "pending", note: null, channelId: null }
    }
  }

  // 管理员邮件通知：只有真正需要人工介入时才发（自动通过的没必要打扰）
  const needsHuman = !auto || auto.status === "pending"
  const adminRow = await env.DB.prepare(
    "SELECT value FROM app_settings WHERE key = 'frp_admin_notify_email'"
  )
    .first<{ value: string }>()
  const adminEmail = adminRow?.value?.trim() ?? ""

  if (adminEmail && needsHuman) {
    try {
      const lines = [
        `用户：${user.username}`,
        `捐献类型：${FEATURE_LABELS[feature]}`,
        `通知邮箱：${notifyEmail}`,
        body.remark ? `备注：${body.remark.trim().slice(0, 200)}` : "",
        type === "ai" ? "该申请需要人工复核（自动校验未能完成）。" : "",
        "请到 Doulor Cloud 管理面板「捐献审核」处理。",
      ]
      const { text, html } = renderMail("新的捐献申请", lines.filter(Boolean))
      await sendMail(env, {
        to: adminEmail,
        subject: `【Doulor Cloud】新的捐献申请（${user.username}）`,
        text,
        html,
      })
    } catch (err) {
      console.error("捐献管理员通知失败:", err)
    }
  }

  return json(
    {
      id,
      status: auto?.status ?? "pending",
      autoReviewed: Boolean(auto),
      reviewNote: auto?.note ?? null,
      channelId: auto?.channelId ?? null,
      /** 首次捐献成功时会带上一张自选权限券的码 */
      voucherCode: auto?.voucherCode ?? null,
    },
    auto?.status === "approved" || auto?.status === "rejected" ? 200 : 201
  )
}

/**
 * POST /api/admin/donations/review —— 管理员审核
 * body: { id, action: "approve" | "reject", note? }
 * 批准时自动解锁该用户对应功能的权限
 *
 * AI 类型的特殊性：批准时会**尽力把渠道接进中转站**（建渠道 + 测试）。
 * 但它**不阻断批准** —— 管理员点「通过」本身就是人工复核的结论，
 * 渠道失败只写进备注，避免「上游测试接口抖动 → 权限发不出去」。
 */
export async function reviewDonation(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminUser(env, request)
  const body = (await request.json()) as {
    id?: string
    action?: string
    note?: string
  }

  const id = body.id ?? ""
  const app = await env.DB.prepare(
    `SELECT d.*, u.username, u.permissions FROM donations d
       JOIN users u ON u.id = d.user_id
      WHERE d.id = ?`
  )
    .bind(id)
    .first<DonationRowWithUser>()

  if (!app) throw new ApiError(404, "申请不存在", "NOT_FOUND")

  const approve = body.action === "approve"
  // 被**系统自动拒绝**的单据允许复核放行（这正是「人工复核」的用途）；
  // 已经批准过的不允许重复批准。
  const canApprove = app.status === "pending" || app.status === "rejected"
  if (approve ? !canApprove : app.status !== "pending") {
    throw new ApiError(
      409,
      app.status === "approved" ? "该申请已通过审核" : "该申请已被处理",
      "ALREADY_REVIEWED"
    )
  }

  let note = (body.note ?? "").trim().slice(0, 500) || null
  const now = new Date().toISOString()
  const feature = DONATION_TYPES[app.type] as Feature
  let voucherCode: string | null = null

  if (approve) {
    // AI 类型：批准时把渠道接进中转站（best-effort）。
    // 已经接入过（channelId 有值，比如撤销后复核放行）就不再重复建。
    let channelId: number | null = app.newapi_channel_id ?? null
    if (app.type === "ai" && channelId === null) {
      const line = await tryProvisionForReview(env, app)
      if (line.channelId !== null) channelId = line.channelId
      if (line.message) {
        note = `${note ? note + "\n" : ""}${line.message}`.slice(0, 500)
      }
    }

    const applied = await applyDonationApproval(env, app, { adminId: admin.id, note, channelId })
    voucherCode = applied.voucherCode
  } else {
    await env.DB.prepare(
      `UPDATE donations SET status = 'rejected', review_note = ?, reviewed_by = ?, reviewed_at = ?, auto_reviewed = 0 WHERE id = ?`
    ).bind(note, admin.id, now, id).run()

    await env.DB.prepare(
      "INSERT INTO audit_logs (id, user_id, action, detail, created_at) VALUES (?, ?, 'donation.review', ?, ?)"
    )
      .bind(
        uuid(),
        admin.id,
        `${app.username} 的${FEATURE_LABELS[feature]}捐献：拒绝`,
        now
      )
      .run()
  }

  await notifyDonationResult(env, app, approve, note, { voucherCode })

  return json({ ok: true, status: approve ? "approved" : "rejected", voucherCode })
}

/**
 * 人工复核时的渠道接入尝试。返回一行可贴进备注的说明。
 * 不抛错 —— 调用方（审核）不能因为它失败而失败。
 */
async function tryProvisionForReview(
  env: Env,
  app: DonationRowWithUser
): Promise<{ channelId: number | null; message: string }> {
  const parsed = parseAiPayload(app.payload)
  if (!parsed) return { channelId: null, message: "（未能解析捐献详情，渠道未创建）" }
  if (!(await isNewApiConfigured(env))) {
    return { channelId: null, message: "（中转站未配置，渠道未创建）" }
  }
  let baseUrl: string
  try {
    baseUrl = validateUpstreamUrl(parsed.baseUrl).baseUrl
  } catch (err) {
    return {
      channelId: null,
      message: `（上游地址不合法：${err instanceof Error ? err.message : String(err)}）`,
    }
  }
  try {
    const seq = await resolveDonationChannelSeq(env)
    const result = await provisionDonationChannel(env, {
      baseUrl,
      apiKey: parsed.apiKey,
      models: parsed.models,
      channelType: parsed.channelType,
      seq,
    })
    if (!result.ok) {
      return {
        channelId: null,
        message: `（渠道接入失败：${result.message}${
          result.detail ? ` —— ${result.detail}` : ""
        }）`,
      }
    }
    return {
      channelId: result.channelId,
      message: `渠道接入成功：${result.detail}`,
    }
  } catch (err) {
    return {
      channelId: null,
      message: `（渠道接入出错：${err instanceof Error ? err.message : String(err)}）`,
    }
  }
}

/**
 * POST /api/admin/donations/:id/provision —— 人工复核：重试把渠道接进中转站。
 *
 * 「自动校验未通过」的单据里，有一部分其实只是**我们的判断出了问题**
 * （上游 /v1/models 不可靠、测试接口偶发超时），资源本身是好的。
 * 管理员看过详情后点这个按钮，用同一份 payload 重跑一次「建渠道 + 测试」。
 *
 * **不改单据状态**：复核只负责把资源接进来，放行与否仍由管理员点「通过」决定
 * （那时 review 会复用已建的渠道，不会重复创建）。
 */
export async function provisionDonation(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  await requireAdminUser(env, request)
  const app = await env.DB.prepare(
    `SELECT d.*, u.username, u.permissions FROM donations d
       JOIN users u ON u.id = d.user_id
      WHERE d.id = ?`
  )
    .bind(id)
    .first<DonationRowWithUser>()

  if (!app) throw new ApiError(404, "申请不存在", "NOT_FOUND")
  if (app.type !== "ai") {
    throw new ApiError(400, "只有 AI 类型捐献需要接入渠道", "INVALID_TYPE")
  }

  // 已经接进来过就不用再建一遍（重复建会多出一个「捐献NN」渠道）
  if (app.newapi_channel_id !== null && app.newapi_channel_id !== undefined) {
    const existing = await testExistingChannel(env, app.newapi_channel_id)
    return json({
      ok: existing.ok,
      channelId: app.newapi_channel_id,
      message: existing.ok ? "渠道此前已接入，复测通过" : "渠道此前已接入，但复测未通过",
      detail: existing.message,
    })
  }

  const line = await tryProvisionForReview(env, app)
  if (line.channelId !== null) {
    await env.DB.prepare("UPDATE donations SET newapi_channel_id = ? WHERE id = ?")
      .bind(line.channelId, app.id)
      .run()
    await env.DB.prepare(
      "INSERT INTO audit_logs (id, user_id, action, detail, created_at) VALUES (?, ?, 'donation.provision', ?, ?)"
    )
      .bind(uuid(), app.user_id, `人工复核接入渠道成功：${app.username}（渠道 ${line.channelId}）`, new Date().toISOString())
      .run()
  }

  return json({
    ok: line.channelId !== null,
    channelId: line.channelId,
    message: line.channelId !== null ? "渠道已接入中转站" : "渠道接入失败",
    detail: line.message,
  })
}

/** 复测一个已知渠道（人工复核时用） */
async function testExistingChannel(
  env: Env,
  channelId: number
): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await testChannel(env, channelId)
    return { ok: r.ok, message: r.ok ? `测试通过（${r.time.toFixed(2)}s）` : r.message }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * POST /api/admin/donations/:id/revoke —— 管理员撤销一次已审核的捐献。
 *
 * 撤销后捐献回到 pending（重新审核）；若该捐献审核通过时**真正授予了权限**
 * （granted_feature = 1，即用户此前没有该权限），则收回该 feature 权限。
 * 若用户此前已有该权限（granted_feature = 0），则不收回 —— 权限不是这次捐献给的。
 *
 * AI 类型额外把已接入的 NewAPI 渠道**删掉**（真正收回资源，而不只是收回站点权限）。
 *
 * ⚠️ 配额不回退：撤销只收回权限、回到待审核，不回退审核时发放的邀请码/模块额度
 * （额度回退涉及多表、易算错，且多给不致命；如需严格回退另行处理）。
 */
export async function revokeDonation(env: Env, request: Request, id: string): Promise<Response> {
  const admin = await requireAdminUser(env, request)
  const app = await env.DB.prepare(
    `SELECT d.*, u.username, u.permissions FROM donations d JOIN users u ON u.id = d.user_id WHERE d.id = ?`
  )
    .bind(id)
    .first<DonationRowWithUser>()

  if (!app) throw new ApiError(404, "申请不存在", "NOT_FOUND")
  if (app.status !== "approved") {
    throw new ApiError(409, "只有已通过的捐献才能撤销", "INVALID_STATE")
  }

  const feature = DONATION_TYPES[app.type] as Feature
  const now = new Date().toISOString()

  const batch: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE donations SET status = 'pending', review_note = NULL, reviewed_by = NULL, reviewed_at = NULL, granted_feature = NULL, auto_reviewed = 0 WHERE id = ?`
    ).bind(id),
  ]

  // 只有「本次确实授予了权限」才收回
  if (app.granted_feature === 1) {
    const perms = parsePermissions(app.permissions)
    perms[feature] = false
    batch.push(
      env.DB.prepare("UPDATE users SET permissions = ?, updated_at = ? WHERE id = ?")
        .bind(JSON.stringify(perms), now, app.user_id)
    )
  }

  await env.DB.batch(batch)

  // 收回资源：把这条捐献接入的渠道从中转站删掉。
  // ⚠️ 故意**保留** newapi_channel_id 不清空 —— 序号是按「有过渠道的条数」推进的，
  // 清空会让下一笔捐献复用同一个「捐献NN」名字。重新批准时会覆盖成新的 id。
  let released = false
  if (app.type === "ai" && app.newapi_channel_id) {
    released = await releaseDonationChannel(env, app.newapi_channel_id)
  }

  // 代理捐献同理：撤销时把「这笔捐献导入的订阅源」从节点池里删掉，
  // 否则资源还挂在池子里被所有人用着（只收回自己的 proxy 权限没有意义）。
  // 只删 source_donation_id 指向本单的行，不碰管理员手工添加的。
  let releasedSubs = 0
  if (app.type === "proxy") {
    const del = await env.DB.prepare(
      "DELETE FROM proxy_subscriptions WHERE source_donation_id = ?"
    )
      .bind(app.id)
      .run()
    releasedSubs = del.meta?.changes ?? 0
  }

  await env.DB.prepare(
    "INSERT INTO audit_logs (id, user_id, action, detail, created_at) VALUES (?, ?, 'donation.revoke', ?, ?)"
  )
    .bind(
      uuid(),
      admin.id,
      `撤销 ${app.type} 捐献审核（用户 ${app.user_id}）${app.granted_feature === 1 ? "，已收回权限" : ""}${released ? "，已删除中转站渠道" : ""}${releasedSubs > 0 ? `，已移出 ${releasedSubs} 个订阅源` : ""}`,
      now
    )
    .run()

  return json({
    ok: true,
    revokedPermission: app.granted_feature === 1,
    releasedChannel: released,
    releasedSubscriptions: releasedSubs,
  })
}

/**
 * DELETE /api/donations/:id —— 用户撤销自己的 pending 申请
 */
export async function cancelDonation(env: Env, request: Request, id: string): Promise<Response> {
  const user = await requireUser(env, request)
  const app = await env.DB.prepare(
    "SELECT * FROM donations WHERE id = ? AND user_id = ?"
  )
    .bind(id, user.id)
    .first<DonationRow>()
  if (!app) throw new ApiError(404, "申请不存在", "NOT_FOUND")
  if (app.status !== "pending") {
    throw new ApiError(409, "已处理的申请不能撤销", "ALREADY_REVIEWED")
  }
  await env.DB.prepare("DELETE FROM donations WHERE id = ?").bind(id).run()
  return new Response(null, { status: 204 })
}