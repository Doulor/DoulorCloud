/**
 * 捐献：用户贡献资源（模型渠道 / 内网穿透 / 代理订阅）来解锁功能权限。
 *
 * 流程与 frp_applications 一致：申请 → 管理员审核（带邮件通知）→ 批准即解锁权限。
 */
import { ApiError, json, assertContentLengthWithin } from "../http"
import { requireAdmin, assertAdminScope } from "./admin"
import { uuid } from "../crypto"
import { requireUser, isPrivileged, type UserRow } from "../auth"
import {
  FEATURE_LABELS,
  parsePermissions,
  parseOpenFeatures,
  featurePermissionSql,
  featurePermittedGuard,
  notWhitelistedGuard,
  type Feature,
} from "../permissions"
import { sendMail, renderMail } from "../mailer"
import { isOwnDomain } from "../root-domains"
import { wb2apiDonationBlock } from "./wb2api"
import { cli2apiDonationBlock } from "./cli2api"
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
  refetchDonationModels,
  releaseDonationChannel,
  resolveDonationGroup,
  retryDonationModels,
  validateUpstreamUrl,
  type UpstreamFormat,
} from "../donation-provision"
import {
  isNewApiConfigured,
  testChannel,
  adminSetUserStatus,
  updateChannelGroup,
} from "../newapi-client"
import { ensureNewApiAccountEnabled } from "../newapi-access"
import {
  SENSENOVA_CONSOLE_URL,
  appendSenseNovaKey,
  probeSenseNova,
  releaseSenseNovaKey,
  type SenseNovaProbeResult,
} from "../sensenova"
import {
  MAX_DONATION_SUB_URLS,
  detectSubscriptionProfile,
  verifySubscriptionUrls,
  type SubscriptionCheck,
} from "./proxy"
import { guardRateLimit } from "../ratelimit"
import { donationRewardLabel, grantDonationReward, isDonationRewardKind } from "../points"
import { grantFirstDonationVoucher } from "../vouchers"
import { getSettings, getSettingBool, getSettingNumber, type SettingKey } from "../settings"
import { pushMessage } from "../user-messages"
import { grantInviteReward } from "../invite-rewards"
import {
  buildTemplateFromSample,
  normalizeFrpDonationPayload,
} from "../frp-config"
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

/**
 * 「同一上游是否已被该用户提交过」—— 提交前的重复校验。
 *
 * ⚠️ **必须用 `json_extract(...) = ?` 做精确比对，绝不能用
 * `payload LIKE '%"baseUrl":"<地址>"%'`。** 原因（2026-09-30 线上事故）：
 *
 *   1. **D1 的 SQLite 把 `LIKE` 模式长度限制在 50 字符**
 *      （`SQLITE_MAX_LIKE_PATTERN_LENGTH`）。实测：模式 50 字符通过、
 *      **51 字符即报 `LIKE or GLOB pattern too complex [code: 7500]`**。
 *      而旧写法拼出来的模式 = `%"baseUrl":"`（13）+ 地址 + `"%`（2），
 *      **地址超过 35 个字符就必然把一个 500 甩给用户** —— 表现是
 *      「自定义 AI 渠道捐献报服务器内部错误」，且**连单子都不会入库**
 *      （校验在 INSERT 之前），管理端查不到任何痕迹。
 *      站长反馈的 `https://opc.fiime.cn/api/model-service`（38 字符）正是此例。
 *      常见上游地址几乎都超 35 字符，所以这条路径实际上大面积不可用。
 *   2. `LIKE` 的 `%` / `_` 是通配符，地址里带它们（百分号编码、下划线域名）
 *      会**误判**（把不同地址当成重复）或**漏判**，与代理捐献那段的注释同一个道理。
 *
 * `json_valid` 兜底是为了历史数据里万一有非 JSON 的 payload ——
 * `json_extract` 遇到非法 JSON 会直接抛错，那又是一次 500。
 */
async function hasDuplicateUpstream(
  env: Env,
  opts: { userId: string; type: string; jsonPath: string; value: string }
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT id FROM donations
      WHERE user_id = ? AND type = ? AND status IN ('pending', 'approved')
        AND json_extract(
              CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,
              ?
            ) = ?
      LIMIT 1`
  )
    .bind(opts.userId, opts.type, opts.jsonPath, opts.value)
    .first<{ id: string }>()
  return row?.id ?? null
}

/** 捐献类型 → 对应的功能权限 */
const DONATION_TYPES: Record<string, Feature> = {
  ai: "ai",
  frp: "frp",
  proxy: "proxy",
  /**
   * 商汤 Key 捐献：权限仍映射到 `ai`（捐的是一个 AI 上游的 Key）。
   *
   * 与 `ai` 分成两个 type 而不是复用 `ai`，因为两者的**校验与奖励语义完全不同**：
   * `ai` 要用户提供 baseUrl、逐个测模型、发额度发券；`sensenova` 只收一个 Key、
   * 上游地址由管理面板配置、不发额度不发券。混用一个 type 会让
   * `autoProvisionAiDonation` 里到处是 `if (type === ...)` 的分叉。
   */
  sensenova: "ai",
}

/**
 * 捐献类型 → 「是否授予权限」的设置键。
 *
 * 反代账号（wb2api / cli2api）不在这里 —— 那是独立通道、走各自的绑定表，
 * 开关在其 handler 里单独读（`donation_grant_wb2api` / `donation_grant_cli2api`）。
 * 未列出的类型默认授予（保守，宁可多授不漏）。
 */
const DONATION_GRANT_SETTING: Record<string, SettingKey> = {
  ai: "donation_grant_ai",
  sensenova: "donation_grant_sensenova",
  frp: "donation_grant_frp",
  proxy: "donation_grant_proxy",
}

/** 某捐献类型通过后是否授予对应权限（默认 true，保持历史行为） */
async function donationGrantsPermission(env: Env, type: string): Promise<boolean> {
  const key = DONATION_GRANT_SETTING[type]
  if (!key) return true
  return getSettingBool(env, key)
}

/**
 * 捐献类型的**展示名**，与 `FEATURE_LABELS` 解耦。
 *
 * 为什么不能直接用 FEATURE_LABELS：`ai` 与 `sensenova` 的 feature 都是 `ai`，
 * 管理端列表里两笔不同的捐献会显示成同一个「AI 中转站」，无法区分。
 * 这里的名字描述的是「捐了什么」，不是「解锁了什么」。
 */
export const DONATION_TYPE_LABELS: Record<string, string> = {
  ai: "AI 模型",
  frp: "内网穿透",
  proxy: "代理节点",
  sensenova: "商汤 Key",
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
/** 查这批节点指纹里有多少个已经存在于节点池（「导入时拒绝相同节点」用） */
async function countDuplicateFingerprints(
  env: Env,
  fingerprints: string[]
): Promise<number> {
  if (fingerprints.length === 0) return 0
  let dup = 0
  const BATCH = 100
  for (let i = 0; i < fingerprints.length; i += BATCH) {
    const batch = fingerprints.slice(i, i + BATCH)
    const placeholders = batch.map(() => "?").join(",")
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM proxy_node_fingerprints WHERE fingerprint IN (${placeholders})`
    )
      .bind(...batch)
      .first<{ c: number }>()
    dup += r?.c ?? 0
  }
  return dup
}

/** 写入某订阅源的节点指纹（INSERT OR IGNORE：一个指纹只能归属一个订阅源） */
async function writeNodeFingerprints(
  env: Env,
  subscriptionId: string,
  fingerprints: string[]
): Promise<void> {
  if (fingerprints.length === 0) return
  const now = new Date().toISOString()
  const stmt = env.DB.prepare(
    "INSERT OR IGNORE INTO proxy_node_fingerprints (fingerprint, subscription_id, created_at) VALUES (?, ?, ?)"
  )
  await env.DB.batch(fingerprints.map((fp) => stmt.bind(fp, subscriptionId, now)))
}

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

    const check = byUrl.get(url)
    const fingerprints = check?.nodeFingerprints ?? []

    // 节点查重（2026-10-03 站长要求：导入时拒绝相同节点）。
    // 只在自动审核路径（有 checks）做；手工放行是管理员明确批准的，不强拦。
    // 全部节点都已在池里 = 同一份资源换个 URL，直接拒绝导入。
    if (opts.checks && fingerprints.length > 0) {
      const dup = await countDuplicateFingerprints(env, fingerprints)
      if (dup >= fingerprints.length) continue
    }

    let host = url
    try {
      host = new URL(url).hostname
    } catch {
      /* 保留原 url 作为 name */
    }

    // 手工放行路径没有识别结果，就地补一次（失败不阻断，协议地区留空由管理员补）
    let protocol = check?.protocol ?? null
    let region = check?.region ?? null
    let status = check?.ok ? "online" : "unknown"
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

    const newId = uuid()
    await env.DB.prepare(
      `INSERT INTO proxy_subscriptions
         (id, name, region, url, protocol, status, enabled, sort_order, note,
          source_donation_id, review_source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?)`
    )
      .bind(
        newId,
        host,
        region,
        url,
        protocol ?? "mixed",
        status,
        "由捐献导入",
        opts.donationId ?? null,
        // 审核来源：带 checks（自动审核路径）= auto，否则（管理员手工放行）= manual
        opts.checks ? "auto" : "manual",
        new Date().toISOString(),
        new Date().toISOString()
      )
      .run()

    // 写节点指纹（后续导入据此查重拒绝）
    await writeNodeFingerprints(env, newId, fingerprints)

    imported += 1
  }
  return imported
}

/** 敏感字段：用户端列表一律不返回（管理端核验时才需要） */
const SENSITIVE_KEYS = [
  "apiKey",
  "baseUrl",
  "subUrls",
  "configYml",
  "configSample",
  "authToken",
  "password",
  "token",
]

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

async function requireAdminUser(env: Env, request: Request, permKey?: string): Promise<UserRow> {
  const admin = await requireAdmin(env, request)
  if (permKey) await assertAdminScope(env, admin, permKey)
  return admin as unknown as UserRow
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
 * 批准一笔 frp 捐献时，把捐献的服务端落成一条 `frp_nodes`。
 *
 * 节点名统一成「捐献-<用户名>」，便于在节点管理里一眼认出来源；
 * `source_donation_id` 指向本单，撤销捐献时据此反查停用。
 * `config_template` 由捐献者的 frpc.toml 样例参数化而来（个人凭据已剥掉）。
 *
 * 若同一笔捐献重复批准（管理员误操作），幂等：已存在 source_donation_id
 * 的节点就直接复用，不重复建。
 *
 * 返回值：`{ok, nodeId?, reason?}` —— 让调用方把「没建成节点」显式告诉管理员，
 * 而不是静默吞掉（2026-09-27 修复：旧格式单批准后节点建不出，管理员完全无感）。
 */
async function provisionFrpNodeFromDonation(
  env: Env,
  app: DonationRowWithUser
): Promise<{ ok: boolean; nodeId?: string; reason?: string }> {
  let normalized
  try {
    normalized = normalizeFrpDonationPayload(JSON.parse(app.payload))
  } catch {
    return { ok: false, reason: "捐献 payload 无法解析（可能是旧格式）" }
  }
  if (!normalized.ok) {
    return { ok: false, reason: `节点未上架：${normalized.error}` }
  }
  const v = normalized.value

  const existing = await env.DB.prepare(
    "SELECT id FROM frp_nodes WHERE source_donation_id = ? LIMIT 1"
  )
    .bind(app.id)
    .first<{ id: string }>()
  if (existing) return { ok: true, nodeId: existing.id }

  const template = buildTemplateFromSample(v.configSample, v.authMode)
  const id = uuid()
  const now = new Date().toISOString()
  const name = `捐献-${app.username}`

  try {
    await env.DB.prepare(
      `INSERT INTO frp_nodes
         (id, name, region, server_addr, server_port, auth_token, token_prefix,
          port_min, port_max, max_ports, enabled, sort_order, note,
          status, status_note, status_updated_at, auth_mode, config_template,
          source_donation_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, 1, 0, ?, 'unknown', NULL, NULL, ?, ?, ?, ?, ?)`
    )
      .bind(
        id, name, v.region, v.serverAddr, v.serverPort, v.authToken,
        v.portMin, v.portMax, v.maxPorts, v.note,
        v.authMode, template, app.id, now, now
      )
      .run()
    return { ok: true, nodeId: id }
  } catch (err) {
    return { ok: false, reason: `节点入库失败：${err instanceof Error ? err.message : String(err)}` }
  }
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
    /**
     * 是否发放邀请码额度与首捐券。默认 true。
     *
     * 置 false 的通道：商汤 Key 捐献（只解锁权限，与反代账号通道同一语义）——
     * 那两个通道的门槛极低（提交一个 Key 即可），若也发额度就容易被刷。
     */
    grantRewards?: boolean
  }
): Promise<{ voucherCode: string | null }> {
  const feature = DONATION_TYPES[app.type] as Feature
  const grantRewards = opts.grantRewards !== false
  const now = new Date().toISOString()

  // 是否授予权限：先看「这条捐献通道是否还开着授权」，再看「用户是否本来就有」。
  // 关掉授权开关时，捐献照常受理（资源照收、额度与积分照发），只是不写权限。
  const grantPerm = await donationGrantsPermission(env, app.type)

  // 记录「这次是否真正授予了权限」：置 true 之前若为 false，才算新增。
  // ⚠️ 这个判断仍基于 app.permissions 的快照（并发下可能有微小误差）；
  // 但下面写回 permissions 走的是原子 json_set，不会再整列覆盖别人的变更。
  const granted = grantPerm && parsePermissions(app.permissions)[feature] !== true

  const approvalStatements = [
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
  ]

  // 授权开关关掉时不写权限（granted 为 false 时同样不写 —— 本来就有的不重复写）。
  if (granted) {
    approvalStatements.push(
      env.DB.prepare(
        `UPDATE users SET permissions = ${featurePermissionSql(feature, true)}, updated_at = ? WHERE id = ?`
      ).bind(now, app.user_id)
    )
  }

  await env.DB.batch(approvalStatements)

  // 授予 **ai** 权限时，把被商汤巡检禁用的中转站账号重新启用。
  //
  // 商汤 Key 巡检收回权限时会连带 disable 中转站账号；用户后来重新捐到有效资源、
  // `ai` 回来了，账号却还躺在禁用状态 —— 表现成「明明有 ai 权限，怎么调都失败」
  // （用户 pillbox 就是这么踩中的，详见 `newapi-access.ts` 的说明）。
  //
  // 只对 `ai` 做：其它模块的授予与中转站账号状态无关，不该顺手把管理员
  // **手动**禁用的账号又打开。对已启用的账号调 enable 是无害空操作。
  // 该函数内部自己 try/catch（失败只记日志），不会阻断审批。
  //
  // 同一个洞的另外两个入口（权限兑换码 / 积分商城买权限）在 `vouchers.grantFeatures` 里
  // 也调了同一个函数 —— 别再往这里加特判。
  if (feature === "ai" && granted) {
    await ensureNewApiAccountEnabled(env, app.user_id)
  }

  // 发放邀请码额度：+2 邀请码额度，且 +1 对应模块的可转授额度。
  // 放在 permissions 更新之后，失败会让整次审核报错，避免「权限给了但额度没给」
  // 的静默不一致（管理员可重试）。
  //
  // ⚠️ 2026-09-25 审计（H2）：把奖励限制成「**同一类型只发一次**」——
  // 这是本次修复的核心。
  //
  // 原先只要 `grantRewards` 就发，与「这次是不是又贡献了一份新资源」无关。而
  // 「重复提交同一份资源」在系统里是**拦不干净**的：
  //   · 代理：订阅链接按 URL 去重（proxy_subscriptions），但加个 `?a=2` 就是
  //     一条「新」链接，返回的还是那一个节点；
  //   · AI：按 baseUrl 去重，换一个指向同一上游的域名同理；
  //   · 节点池只按订阅 URL 去重，**没有节点级指纹**，所以「同一份资源换个 URL」
  //     永远能过。
  // 于是形成一条闭环：自建订阅 → 提交 → 自动审核通过（proxy 默认在白名单里）
  // → +2 邀请码额度 +1 模块可转授额度 → 换个 URL 再来 → **无限邀请权**。
  // 邀请码是本站唯一的准入门槛，这个洞等价于把门槛拆掉。
  //
  // ⚠️ 为什么**不能**用上面那个 `granted` 标志来判：
  //   它算的是 `perms[feature] !== true`，而 `parsePermissions(null)` 的语义是
  //   「**全开**」（兼容老用户，见 permissions.ts:10）。新建用户的
  //   `users.permissions` 就是 NULL —— 于是 `granted` 对绝大多数用户恒为 false，
  //   拿它当发放条件会变成**一个人都发不出来**。
  //   （这不是推测：第一版就是这么写的，被回归测试当场抓住。）
  //
  // 改用「库里是否已有同类型的已批准捐献」作为判据 —— 与 permissions 的
  // 兼容语义完全无关，且是真正落库的事实：
  //   · 同一类型最多奖励一次 ⇒ 单个用户一生最多拿 3 份（ai / proxy / frp；
  //     sensenova 本来就 grantRewards:false），刷额度这条路变成**有界**的；
  //   · 必须 `id != app.id`：上面那个 batch 已经把**当前这笔**置成 approved 了。
  //
  // 取舍（如实记录）：用户捐第二份**真正不同**的资源时不会再拿到第二份奖励。
  //   这是有意的 —— 在无法区分「真·第二份贡献」与「重放同一份资源」之前，
  //   宁可少发，也不能让奖励无界。
  const priorSameType = await env.DB.prepare(
    `SELECT 1 AS x FROM donations
      WHERE user_id = ? AND type = ? AND status = 'approved' AND id != ?
      LIMIT 1`
  )
    .bind(app.user_id, app.type, app.id)
    .first()

  if (grantRewards && !priorSameType) {
    await grantQuotaForDonation(env, app.user_id, feature)
  }

  // 捐献奖励积分：**每通过一笔捐献就发一次** —— 这是用户**可重复赚积分**的通道
  // （站长 2026-09-29 明确：它不是一次性奖励）。
  //
  // 幂等键用**单据 id**（`donation:<单据id>`，唯一索引在
  // point_transactions(user_id, dedup_key)），语义是「同一笔单据只发一次」：
  //   · 同一笔单据被重复审核（撤销后重新批准）→ 不会重复发；
  //   · 用户再捐一份**新资源**（新单据）→ 会再发一次。
  //
  // ⚠️ 与上面的 `priorSameType`（邀请码额度「同类型只发一次」）**刻意分开**：
  //    那条是为了堵「无限邀请权」而收紧的，只作用于邀请码额度，与积分无关，
  //    别把两者的口径混为一谈。
  // ⚠️ 与 `grantRewards` 无关：商汤通道刻意不发邀请码额度与首捐券
  //    （门槛太低容易被刷），但站长明确要求它照样发 2 积分，所以这里单独判。
  if (isDonationRewardKind(app.type)) {
    await grantDonationReward(env, {
      userId: app.user_id,
      kind: app.type,
      dedupKey: `donation:${app.id}`,
      detail: `${donationRewardLabel(app.type)}捐献奖励`,
    })
  }

  // 邀请奖励：其他 AI 渠道捐献（自定义渠道 ai / 商汤 sensenova）审核通过、且真的
  // 解锁了 ai 权限 → 给邀请人开「AI 邀请套餐」订阅（plan 3，¥200/天）。
  // 与 wb2api 绑定（plan 2，¥500）是两套不同的奖励；防重复由 invite_rewards 表统一兜底。
  if (DONATION_TYPES[app.type] === "ai" && granted) {
    try {
      const planId = await getSettingNumber(env, "invite_reward_ai_plan_id")
      if (planId && planId > 0) {
        await grantInviteReward(
          env,
          { id: app.user_id, username: app.username },
          planId
        )
      }
    } catch (err) {
      console.error("AI 渠道邀请奖励发放失败:", app.user_id, err)
    }
  }

  // 代理节点捐献：把订阅链接写进节点池（proxy_subscriptions），供所有用户使用。
  // 自动审核路径只导入校验通过的；管理员手工放行则全部导入。
  if (app.type === "proxy") {
    await importProxySubscriptions(env, app.payload, {
      checks: opts.proxyChecks,
      donationId: app.id,
    })
  }

  // 内网穿透捐献：批准时把捐献的服务端落成一条 frp_nodes，用户立刻能申请端口。
  // 失败不回滚权限，但要把原因显式写进 review_note —— 让管理员当场知道「节点没上架」，
  // 而不是批准后以为上架了（旧格式单就会走这里）。
  let frpProvisionWarning: string | null = null
  if (app.type === "frp") {
    const provision = await provisionFrpNodeFromDonation(env, app)
    if (!provision.ok) {
      frpProvisionWarning = provision.reason ?? "节点未上架"
      await env.DB.prepare(
        `UPDATE donations SET review_note = COALESCE(review_note || '\n', '') || ? WHERE id = ?`
      )
        .bind(`⚠️ ${frpProvisionWarning}（需在节点管理里手工补建）`, app.id)
        .run()
    }
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
  if (grantRewards) {
    try {
      voucherCode = await grantFirstDonationVoucher(env, app.user_id)
    } catch (err) {
      console.error("发放首捐券失败:", app.user_id, err)
    }
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
  const uncertain = failed.filter((c) => c.uncertain)

  if (good.length === 0) {
    const detail = failed.map((f) => `${f.url}（${f.error}）`).join("；")

    // 「没能验证」≠「不可用」。这是本模块此前最主要的误判来源：
    // 订阅站抖动一下（超时 / 5xx / 429 / 拦 UA 的 403）就把用户的链接判死，
    // 然后自动拒绝 —— 而那条链接在用户的客户端里其实好好的。
    // 判据与 AI 通道一致：**证据不够就不下终局结论**，转人工让管理员拍板。
    // 代价不对称：误拒丢掉一个真实资源，误转人工只多花管理员一次点击。
    if (uncertain.length > 0) {
      const note =
        `系统自动校验未完成：${subUrls.length} 个订阅链接都没能验证出节点` +
        `（其中 ${uncertain.length} 个是拉取失败/超时/订阅站错误，不代表链接不可用）。` +
        `已转人工复核。详情：${detail}`
      await env.DB.prepare(
        `UPDATE donations SET review_note = ?, reviewed_at = ?, auto_reviewed = 1 WHERE id = ?`
      )
        .bind(note, now, input.id)
        .run()
      await notifyDonationResult(env, app, false, note, { auto: true, pending: true })
      return { status: "pending", note, channelId: null }
    }

    // 全部是确定性失败（内容拉到了，但确实不是节点列表）→ 可以自动拒绝
    return reject(
      `${subUrls.length} 个订阅链接都没有解析出节点 —— ${detail}`
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
 * frp 捐献的自动审核：解析 frpc.toml 样例，批准后建出节点。
 *
 * ⚠️ 本站**验证不了对端 frps 的连通性**：frpc↔frps 是 frp 私有 TCP 协议（默认
 * 7000 端口），而 Worker 跑在 Cloudflare 上，出站只能发 HTTP/HTTPS、不能建立
 * 任意 TCP 连接，所以没法握手。能做的只有**静态校验**：
 *   - frpc.toml 样例能解析、且 serverAddr 与表单填的一致
 *   - 鉴权方式与全局 token 一致
 *
 * 按「自动判断错了的不能直接算失败」的最高原则：这些静态校验**全对**、但
 * 「服务器到底能不能用」我们一无所知 —— 所以即便全对也不自动通过，
 * 一律转人工（管理员复核后才真正建节点、解锁权限）。
 *
 * 只有「样例解析不出来 / 与表单不一致」这种**属于我们输入规则**的问题，
 * 才在提交时就拒绝（用户当场改），但那是 `normalizeFrpDonationPayload` 在
 * 提交阶段做的，走不到这里。
 *
 * 因此这个函数**永远不自动 approve、也永远不自动 reject**：要么 pending
 * （走人工），要么把「样例解析失败」也归到 pending 让管理员拍板。
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
  let parsed: unknown
  try {
    parsed = JSON.parse(input.payloadStr)
  } catch {
    return { status: "pending", note: "frp 捐献 payload 无法解析，转人工复核", channelId: null }
  }

  const app = await env.DB.prepare(
    `SELECT d.*, u.username, u.permissions FROM donations d
       JOIN users u ON u.id = d.user_id
      WHERE d.id = ?`
  )
    .bind(input.id)
    .first<DonationRowWithUser>()
  if (!app) return { status: "pending", note: null, channelId: null }

  // 重新归一化一遍（提交时已校验过，这里防御性地再来一次，失败转人工而非拒绝）
  const normalized = normalizeFrpDonationPayload(parsed)
  if (!normalized.ok) {
    return {
      status: "pending",
      note: `frp 捐献自动校验未能确认（转人工复核）：${normalized.error}`,
      channelId: null,
    }
  }
  const value = normalized.value

  // 生成参数化模板（剥掉捐献者自己的个人凭据），写进 review_note 供管理员参考。
  // 这里只生成、不建节点 —— 建节点在管理员批准（applyDonationApproval）时才做。
  const template = buildTemplateFromSample(value.configSample, value.authMode)
  await env.DB.prepare(
    `UPDATE donations SET review_note = ?, auto_reviewed = 1 WHERE id = ?`
  )
    .bind(`frp 服务端已通过静态校验（serverAddr=${value.serverAddr}:${value.serverPort}，鉴权=${value.authMode}），等待管理员复核并建节点`, input.id)
    .run()

  return { status: "pending", note: template ? "已生成配置模板" : null, channelId: null }
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
    // 同一用户对同一上游「覆盖」重提时，单据上已挂着旧渠道 id —— 就地更新它的
    // Key，而不是新建一个（避免重复渠道 / 该上游短暂失联）。普通首次提交为 null。
    existingChannelId: app.newapi_channel_id ?? null,
  })

  if (!result.ok) {
    // 特例：全部模型都「不确定」（限流/超时）→ 渠道已被刻意保留，转人工而非拒绝。
    // 这里把 channelId 落进单据，管理员点「复核通过」时会直接复用该渠道
    // （reviewDonation 里 channelId 非 null 就不会重建），不会产生重复渠道。
    if (result.channelId !== null) {
      const note = `系统自动校验未完成：${result.detail || result.message}`
      await env.DB.prepare(
        `UPDATE donations
            SET review_note = ?, reviewed_at = ?, auto_reviewed = 1, newapi_channel_id = ?
          WHERE id = ?`
      )
        .bind(note, now, result.channelId, input.id)
        .run()
      await recordFailedModelRetries(env, input.id, result, result.channelId)
      await notifyDonationResult(env, app, false, note, { auto: true, pending: true })
      return { status: "pending", note, channelId: result.channelId }
    }

    // 「自动判断失败」≠「确定失败」。只有 result.definitive 为真（失败原因
    // 只关乎我们自己的输入规则，与上游可用性无关）才允许自动拒绝；
    // 其余一律转人工 —— 上游报错、超时、平台侧故障都可能只是这次不巧。
    // 用户的明确要求（2026-09-25）：由人工确认失败才算失败。
    if (!result.definitive) {
      const note = `系统自动校验未通过（已转人工复核）：${
        result.detail ? `${result.message}（${result.detail}）` : result.message
      }`
      await env.DB.prepare(
        `UPDATE donations SET review_note = ?, reviewed_at = ?, auto_reviewed = 1 WHERE id = ?`
      )
        .bind(note, now, input.id)
        .run()
      await notifyDonationResult(env, app, false, note, { auto: true, pending: true })
      return { status: "pending", note, channelId: null }
    }

    const reason = result.detail ? `${result.message}（${result.detail}）` : result.message
    return reject(parsed.manual ? `${reason}；模型名由用户手填，请重点核对` : reason)
  }

  const note = `自动校验通过：${result.detail}`
  const { voucherCode } = await applyDonationApproval(env, app, {
    adminId: null,
    note,
    channelId: result.channelId,
  })
  // 把没通过测试的模型落库，交给定时任务重试（此前只写进 review_note 文本，
  // 于是「当时抖了一下」的模型永远不会被补回渠道）
  await recordFailedModelRetries(env, input.id, result, result.channelId)
  await notifyDonationResult(env, app, true, null, { auto: true, voucherCode })
  return { status: "approved", note, channelId: result.channelId, voucherCode }
}

/**
 * 商汤 Key 捐献：验证 Key → **追加进管理员已有的多密钥渠道** → 只解锁权限
 * （不发额度、不发券、不新建渠道、不动渠道模型）。
 *
 * 与 `autoProvisionAiDonation` 的三点关键差别：
 *   ① 上游地址与「Key 并进哪个渠道」都来自管理面板配置（`sensenova_base_url` /
 *      `sensenova_channel_id`），**用户不能自带** —— 这同时保证了「这个 Key 确实
 *      属于该上游」：只有真 Key 才能通过它的鉴权；
 *   ② **不逐个测模型**（商汤的模型由上游说了算，逐个测既慢又容易被限流误判），
 *      拉一次 `/v1/models` 只为了校验 Key 有效性；
 *   ③ **不新建渠道**：商汤是多密钥渠道（一个渠道挂多把 Key，轮询使用），
 *      捐献来的 Key 追加进去即可，渠道的模型列表由管理员手工维护。
 *
 * 奖励语义：与反代账号通道一致 —— **只解锁权限**，不发邀请码额度、不发首捐券。
 * 理由见 `applyDonationApproval` 的 `grantRewards` 说明（门槛太低，容易被刷）。
 */
async function autoProvisionSenseNovaDonation(
  env: Env,
  input: { id: string; payloadStr: string }
): Promise<{
  status: "pending" | "approved" | "rejected"
  note: string | null
  channelId: number | null
}> {
  const settings = await getSettings(env)

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
    await notifyDonationResult(env, app, false, note, { auto: true, noReward: true })
    return { status: "rejected", note, channelId: null }
  }

  // 通道总开关关着 → 不该走到这里（前端会隐藏入口）。真走到了就拒绝，
  // 而不是静默 pending —— 否则用户会一直等一个不会有人处理的申请。
  if (settings.sensenova_enabled !== "1") {
    return reject("商汤 Key 捐献通道当前未开启")
  }

  if (!(await isNewApiConfigured(env))) {
    // 中转站没配好是平台侧的问题，不该由用户承担 → 保留 pending 转人工
    return { status: "pending", note: null, channelId: null }
  }

  const parsed = JSON.parse(input.payloadStr) as { apiKey?: string }
  const apiKey = (parsed.apiKey ?? "").trim()
  if (!apiKey) return reject("缺少商汤 API Key")

  const baseUrl = (settings.sensenova_base_url || "").trim()
  if (!baseUrl) return reject("管理员尚未配置商汤上游地址")

  // 目标渠道（管理面板配置的 NewAPI 渠道 ID）：没配就**转人工**而不是拒绝 ——
  // 和「中转站没配好」同一性质，是平台侧的问题，不该让捐献者收到「未通过」。
  const targetChannelId = Math.trunc(Number((settings.sensenova_channel_id || "").trim()))
  if (!Number.isFinite(targetChannelId) || targetChannelId <= 0) {
    const note =
      "系统自动校验未完成：管理面板尚未配置「商汤接入渠道 ID」，无法把 Key 并入渠道"
    await env.DB.prepare(
      `UPDATE donations SET review_note = ?, reviewed_at = ?, auto_reviewed = 1 WHERE id = ?`
    )
      .bind(note, now, input.id)
      .run()
    await notifyDonationResult(env, app, false, note, {
      auto: true,
      noReward: true,
      pending: true,
    })
    return { status: "pending", note, channelId: null }
  }

  // 校验 Key：401/403 → 无效；404 → 地址配错；其余 → 网络问题（不怪用户）
  const probe = await probeSenseNova(baseUrl, apiKey)
  if (!probe.ok) {
    if (probe.kind === "network") {
      // 上游抖动不是用户的错 → 转人工，让管理员稍后重试（而不是让用户重提）
      const note = `系统自动校验未完成：${probe.message}`
      await env.DB.prepare(
        `UPDATE donations SET review_note = ?, reviewed_at = ?, auto_reviewed = 1 WHERE id = ?`
      )
        .bind(note, now, input.id)
        .run()
      await notifyDonationResult(env, app, false, note, { auto: true, noReward: true, pending: true })
      return { status: "pending", note, channelId: null }
    }
    return reject(probe.message)
  }

  // 只追加 Key：不新建渠道、不动渠道的模型列表（模型由管理员手工维护）
  const result = await appendSenseNovaKey(env, { apiKey, channelId: targetChannelId })
  if (!result.ok) {
    // 与 AI 通道同一原则（见 ProvisionResult.definitive）：
    // appendSenseNovaKey 的失败全是平台侧的（渠道不存在 / 不是多密钥 / 接口报错 /
    // 密钥数异常），不是「这个 Key 不可用」⇒ 转人工，不自动拒绝。
    if (!result.definitive) {
      const note = `系统自动校验未通过（已转人工复核）：${
        result.detail ? `${result.message}（${result.detail}）` : result.message
      }`
      await env.DB.prepare(
        `UPDATE donations SET review_note = ?, reviewed_at = ?, auto_reviewed = 1 WHERE id = ?`
      )
        .bind(note, now, input.id)
        .run()
      await notifyDonationResult(env, app, false, note, {
        auto: true,
        noReward: true,
        pending: true,
      })
      return { status: "pending", note, channelId: null }
    }
    return reject(result.detail ? `${result.message}（${result.detail}）` : result.message)
  }

  const note = `自动校验通过：${result.detail}`
  await applyDonationApproval(env, app, {
    adminId: null,
    note,
    channelId: result.channelId,
    grantRewards: false,
  })
  await notifyDonationResult(env, app, true, null, { auto: true, noReward: true })
  return { status: "approved", note, channelId: result.channelId }
}

/**
 * 把「没通过测试」的模型结构化落库，供定时任务重试。
 *
 * 分两类存（见 classifyTestFailure）：`uncertain`（限流/超时，保留在渠道里）
 * 与 `failed`（鉴权/模型不存在，已从渠道剔除）—— 两类都值得重试，
 * 因为「剔除」只是基于一次调用，未必是永久结论。
 *
 * 失败不抛：落库失败不该让已经成功的捐献审核回滚（模型顶多是晚一点被重试）。
 */
async function recordFailedModelRetries(
  env: Env,
  donationId: string,
  result: { failed: { model: string; reason: string }[]; uncertain: { model: string; reason: string }[] },
  channelId: number | null
): Promise<void> {
  if (channelId === null) return
  const rows = [
    ...result.uncertain.map((m) => ({ ...m, status: "uncertain" })),
    ...result.failed.map((m) => ({ ...m, status: "failed" })),
  ]
  if (rows.length === 0) return

  const nowIso = new Date().toISOString()
  const next = new Date(Date.now() + 3600_000).toISOString()
  for (const r of rows) {
    try {
      await env.DB.prepare(
        `INSERT INTO donation_model_retries
           (donation_id, model, channel_id, status, reason, attempts, last_tried_at, next_retry_at, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
         ON CONFLICT(donation_id, model) DO UPDATE SET
           status = excluded.status, reason = excluded.reason, next_retry_at = excluded.next_retry_at`
      )
        .bind(donationId, r.model, channelId, r.status, r.reason.slice(0, 300), nowIso, next, nowIso)
        .run()
    } catch (err) {
      console.error("落库失败模型重试记录出错:", donationId, r.model, err)
    }
  }
}

/** 发结果邮件（失败只记日志，不影响审核本身） */
async function notifyDonationResult(
  env: Env,
  app: DonationRowWithUser,
  approve: boolean,
  note: string | null,
  opts: {
    auto?: boolean
    voucherCode?: string | null
    /** 不发放额度/券（商汤 Key 通道：只解锁权限） */
    noReward?: boolean
    /** 「自动校验未完成、转人工」——既不是通过也不是失败，文案要另写 */
    pending?: boolean
    /**
     * 「已通过的捐献被系统撤销」（定时巡检发现资源真的失效）。
     *
     * 与 pending / 通过 / 拒绝三者都不同：不是用户填错（不是拒绝），
     * 也不是还在等复核（不是 pending），而是「曾经有效、现在失效了」。
     * 照搬拒绝文案会让用户以为自己被判成作弊，必须单独写。
     */
    revoked?: boolean
  } = {}
): Promise<void> {
  const feature = DONATION_TYPES[app.type] as Feature
  const quotaFeature = feature as QuotaFeature
  try {
    const basic = await isBasicFeature(env, quotaFeature)
    // 基础权限模块的人人可授，获批时无需发放模块额度，文案也要同步去掉
    const quotaLine = opts.noReward
      ? ""
      : basic
        ? `同时获得 ${INVITE_BONUS_PER_DONATION} 个邀请码创建额度` +
          `（「${QUOTA_FEATURE_LABELS[quotaFeature] ?? FEATURE_LABELS[feature]}」已是基础权限，人人可授）。`
        : `同时获得 ${INVITE_BONUS_PER_DONATION} 个邀请码创建额度，` +
          `以及 1 个「${QUOTA_FEATURE_LABELS[quotaFeature] ?? FEATURE_LABELS[feature]}」权限额度` +
          "（创建邀请码时可授予该权限）。"
    const lines = opts.revoked
      ? [
          `捐献类型：${FEATURE_LABELS[feature]}`,
          "系统定期巡检时发现你提交的这份资源**已失效**（上游明确拒绝了它，不是网络抖动或限流）。",
          note ? `详情：${note}` : "",
          "该资源已从我们的服务里移除；如果它当时为你解锁了权限，权限也已一并收回。",
          "换成一份有效的资源重新提交，即可再次解锁。",
        ]
      : opts.pending
        ? [
            `捐献类型：${FEATURE_LABELS[feature]}`,
            "系统自动校验没能确认这份资源可用（上游未正常响应，或接口格式/名称不匹配）。",
            "**这不代表你的资源不可用**，已转交人工复核；管理员确认通过后会自动为你解锁权限。",
            note ? `详情：${note}` : "",
            // 不再写「系统会定时自动重试」——那只对「不确定」那一支成立，
            // 其余情形（平台侧故障、格式不匹配）重试并不会自愈，写了就是骗人。
            "无需重新提交。",
          ]
        : approve
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
            opts.noReward
              ? ""
              : "请到 Doulor Cloud 的「捐献」页面查看额度并创建邀请码。",
          ]
        : [
            `捐献类型：${FEATURE_LABELS[feature]}`,
            "很抱歉，你的捐献申请未通过审核。",
            note ? `原因：${note}` : "",
            "如有疑问可联系管理员，或修改后重新提交。",
          ]
    const title = opts.revoked
      ? "捐献资源已失效，相关权限已收回"
      : opts.pending
        ? "捐献申请待人工复核"
        : approve
          ? "捐献申请已通过"
          : "捐献申请未通过"
    const { text, html } = renderMail(title, lines.filter(Boolean))
    await sendMail(env, {
      to: app.notify_email,
      subject: `【Doulor Cloud】${title}`,
      text,
      html,
    })

    // 站内消息：捐献结果同时进「系统消息」，用户不必翻邮箱。
    // dedup_key 含结果状态：同一次审批被重试（或自动审核 + 人工复核走两遍）时不会重复。
    const state = opts.revoked
      ? "revoked"
      : opts.pending
        ? "pending"
        : approve
          ? "approved"
          : "rejected"
    await pushMessage(env, app.user_id, {
      category: "system",
      type: "donation",
      title,
      body: lines.filter(Boolean).join("\n"),
      link: "/dashboard/donations",
      dedupKey: `donation:${app.id}:${state}`,
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
  // CLI2API 反代通道（第二条，同样免审核）—— 前端据此渲染第二张卡
  const cli2api = await cli2apiDonationBlock(env, user.id)

  // 商汤 Key 通道同理：前端据此决定要不要渲染那张卡（以及给控制台跳转链接）。
  // 上游地址不回传 —— 那是服务端配置，用户不需要知道，也不该能改。
  const settings = await getSettings(env)

  return json({
    // 用户端不回显敏感凭据（API Key / 订阅链接等）——列表只用于看状态与撤回，
    // 提交后无需再次展示；这也避免他人（含管理员误操作）在用户端读取到凭据。
    donations: (rows.results ?? []).map((r) =>
      toPublicDonation(r, user.username, { redactPayload: true })
    ),
    types: Object.keys(DONATION_TYPES),
    typeLabels: DONATION_TYPE_LABELS,
    // 用户当前权限（前端据此判断哪些功能需要捐献）
    permissions: parsePermissions(user.permissions),
    /** AI 捐献一次最多可选多少个模型（前端据此提示并限制勾选） */
    maxAiModels: MAX_DONATION_MODELS,
    /** 代理捐献一次最多可提交多少个订阅链接（每个都要真拉一次） */
    maxSubUrls: MAX_DONATION_SUB_URLS,
    wb2api,
    cli2api,
    sensenova: {
      enabled: settings.sensenova_enabled === "1",
      // 纯展示开关（与 sensenova_enabled 的「通道总开关」区分）：见 settings.ts 注释
      visible: await getSettingBool(env, "sensenova_donation_visible"),
      consoleUrl: SENSENOVA_CONSOLE_URL,
    },
    /**
     * 各捐献/绑定通道是否「授予权限」（对应 donation_grant_* 开关）。
     * 前端据此把「通过即解锁权限」的文案换成「仅收录资源、不授予权限」，
     * 避免站长关掉授权后捐献页还在误导用户。
     */
    grantPermissions: {
      ai: settings.donation_grant_ai !== "0",
      sensenova: settings.donation_grant_sensenova !== "0",
      frp: settings.donation_grant_frp !== "0",
      proxy: settings.donation_grant_proxy !== "0",
      wb2api: settings.donation_grant_wb2api !== "0",
      cli2api: settings.donation_grant_cli2api !== "0",
    },
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
  await requireAdminUser(env, request, "donations.ai")

  const rows = await env.DB.prepare(
    `SELECT d.*, u.username FROM donations d
       JOIN users u ON u.id = d.user_id
      ORDER BY d.created_at DESC`
  ).all<DonationRow & { username: string }>()

  return json({
    donations: (rows.results ?? []).map((r) => toPublicDonation(r, r.username)),
    typeLabels: DONATION_TYPE_LABELS,
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

  // ⚠️ 2026-09-25 审计（H2）：这个接口原先**既没有限流、也没有体积上限**。
  // 它每次调用都可能触发「向上游发请求 + 建渠道」（AI/proxy 默认自动审核），
  // 是本站最贵的用户可触发路径之一。限流按用户计，10 次 / 10 分钟足够宽松
  // （正常人不会连续提交捐献），但足以掐断脚本化刷额度。
  await guardRateLimit(env, `donation:create:user:${user.id}`, 10, 600, "提交捐献过于频繁")

  // L30 同类：先看 Content-Length 再解析，别把任意大的 body 读进内存。
  // 上限与下面 payloadStr 的 10000 字符检查留足余量。
  assertContentLengthWithin(request, 64 * 1024, "请求内容过大")

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

  // frp 的 payload 含 frpc.toml 样例（最长 16 KB），放宽上限；
  // 其它类型仍按 10000 字符封顶。
  const payloadStr = JSON.stringify(body.payload)
  const payloadMax = type === "frp" ? 20000 : 10000
  if (payloadStr.length > payloadMax) {
    throw new ApiError(400, "资源详情过长", "TOO_LARGE")
  }

  // AI 类型的提交，除了格式还要求「真的像一份资源」：
  // 必须选到模型、同一上游不能重复提交。
  // 这些校验放在入库之前，避免用无效 payload 去调中转站的建渠道接口。
  //
  // `overwriteId`：同一用户对**同一个上游**再次提交时（2026-10-05 站长要求
  // 「让它覆盖」），命中的那条旧单据 id —— 走「更新它」而不是「新建一条」。
  let overwriteId: string | null = null
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
    // 同一上游重复提交：**覆盖**（2026-10-05 站长要求）。
    //
    // 背景：用户 mianke 反馈 —— 同一个上游地址（如 DeepSeek 官址）拿到了一把新
    // Key 想更新，却被「这个上游地址你已经提交过了」挡住。站长口径：同一用户对
    // 同一上游再提交，**让它覆盖**。
    //
    // 做法：命中旧单据就**更新那一条**（写入新 payload、重置为待审核、清掉上次的
    // 审核痕迹），而不是新建。自动接入时会带着旧的 newapi_channel_id 就地替换
    // 渠道里的 Key（见 autoProvisionAiDonation），既不产生重复渠道、也不会失联。
    // 奖励幂等由 dedup_key=`donation:<id>` 兜底，重复审核不会重复发积分。
    //
    // ⚠️ 走 hasDuplicateUpstream（json_extract 精确比对），别改回 payload LIKE —— 见该函数注释。
    const dupId = await hasDuplicateUpstream(env, {
      userId: user.id,
      type: "ai",
      jsonPath: "$.baseUrl",
      value: parsed.baseUrl,
    })
    if (dupId) overwriteId = dupId
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

    // ⚠️ 2026-09-25 审计（H2）：**这里原先没有任何重复校验**。
    //   AI 类型有（见上面 baseUrl 的 dup 检查）、商汤有、frp 有，
    //   只有 proxy 没有 —— 而 proxy 恰好默认就在自动审核白名单里
    //   （`settings.auto_review_features` 默认值是 "ai,proxy"）。
    //
    //   于是形成一条完整的刷额度链路：
    //     自建一个订阅链接（返回单个 vless 节点即可）→ 提交 → 自动审核通过
    //     → +2 邀请码额度、+1 个 proxy 可转授额度 → 再提交同一个链接 → 再来一轮…
    //   结果是**无限邀请权 + 无限权限转授权**，而平台侧只多了一条重复节点。
    //
    //   用 `json_each` 精确比对数组里的每个 URL，而**不是** `payload LIKE '%url%'`：
    //   URL 里天然含 `%`（百分号编码）和 `_`，这两个都是 LIKE 的元字符 ——
    //   `%` 会变成通配符（误判成「已提交」），`_` 会匹配任意单字符（漏判）。
    //   同一份 payload 用 LIKE 既会误伤也会放过，必须按 JSON 值精确比。
    for (const u of urls) {
      const dup = await env.DB.prepare(
        `SELECT 1 AS x
           FROM donations d, json_each(d.payload, '$.subUrls') je
          WHERE d.user_id = ? AND d.type = 'proxy'
            AND d.status IN ('pending', 'approved')
            AND je.value = ?
          LIMIT 1`
      )
        .bind(user.id, u)
        .first()
      if (dup) {
        throw new ApiError(409, "这个订阅链接你已经提交过了", "DUPLICATE_UPSTREAM")
      }
    }
  }

  // 商汤 Key 捐献：payload 只有 { apiKey }。上游地址由管理面板配置（用户不能自带），
  // 所以这里**不做地址校验** —— 地址不对是管理员的问题，不是用户的问题。
  if (type === "sensenova") {
    const p = body.payload as { apiKey?: unknown }
    const apiKey = typeof p.apiKey === "string" ? p.apiKey.trim() : ""
    if (!apiKey) {
      throw new ApiError(400, "请填写商汤 API Key", "INVALID_API_KEY")
    }
    if (apiKey.length > 500) {
      throw new ApiError(400, "Key 长度异常", "INVALID_API_KEY")
    }
    p.apiKey = apiKey
    // 同一 Key 重复提交无意义（会建出重复渠道）—— 只挡未被拒绝的那些。
    // 用完整 Key 精确匹配（不是 LIKE 前缀），避免误伤。
    const dup = await env.DB.prepare(
      `SELECT id FROM donations
        WHERE user_id = ? AND type = 'sensenova' AND status IN ('pending','approved')
          AND payload = ? LIMIT 1`
    )
      .bind(user.id, JSON.stringify({ apiKey }))
      .first()
    if (dup) {
      throw new ApiError(409, "这个商汤 Key 你已经提交过了", "DUPLICATE_UPSTREAM")
    }
  }

  // 内网穿透捐献：捐献的是一台 **frps 服务端**（不是客户端配置）。
  // 提交时只做「我们自己的输入规则」校验（字段缺失 / 地址格式 / 端口范围 /
  // 样例与表单是否一致）——这些错了当场让用户改；能不能连上本站测不了，
  // 一律转人工复核（见 autoReviewFrpDonation）。
  if (type === "frp") {
    const normalized = normalizeFrpDonationPayload(body.payload)
    if (!normalized.ok) {
      throw new ApiError(400, normalized.error, "INVALID_PAYLOAD")
    }
    // 归一化后回写，入库的是「真正会拿去建节点的值」（去掉空白、补默认端口等）
    const v = normalized.value
    body.payload = {
      nodeName: v.nodeName,
      region: v.region,
      serverAddr: v.serverAddr,
      serverPort: v.serverPort,
      portMin: v.portMin,
      portMax: v.portMax,
      maxPorts: v.maxPorts,
      authMode: v.authMode,
      authToken: v.authToken,
      configSample: v.configSample,
      note: v.note,
    }
    // 同一服务器重复提交无意义（会建出重复节点）—— 只挡未被拒绝的那些。
    // ⚠️ 同上：LIKE 模式里还要加 `%"serverAddr":"` 这种固定前缀，
    //    **域名只要超过约 25 字符就会撞 50 字符上限** —— 比 AI 那条更容易炸。
    if (
      await hasDuplicateUpstream(env, {
        userId: user.id,
        type: "frp",
        jsonPath: "$.serverAddr",
        value: v.serverAddr,
      })
    ) {
      throw new ApiError(409, "这台服务器你已经提交过了", "DUPLICATE_UPSTREAM")
    }
  }

  // 通知邮箱：优先用已验证的真实邮箱
  const notifyEmail = user.email
  // 「本站域名邮箱」= 任一已登记根域（tyu.me / doulor.cn），不能只判主域
  if (!notifyEmail || (await isOwnDomain(env, notifyEmail))) {
    throw new ApiError(400, "请先在「设置」中验证真实邮箱", "NO_NOTIFY_EMAIL")
  }

  // 同类型不能有 pending 申请。
  // ⚠️ 「覆盖」时**跳过**这条闸：我们正是在更新那条命中单据（它本身可能就是
  //    pending / approved），再拦一次就没有覆盖可言了。只有新建才需要它。
  if (!overwriteId) {
    const pending = await env.DB.prepare(
      "SELECT id FROM donations WHERE user_id = ? AND type = ? AND status = 'pending' LIMIT 1"
    )
      .bind(user.id, type)
      .first()
    if (pending) {
      throw new ApiError(409, "你已有一个该类型的申请待审核", "PENDING_EXISTS")
    }
  }

  // 覆盖 → 复用命中单据的 id（更新它）；否则新建一条。
  const id = overwriteId ?? uuid()
  const now = new Date().toISOString()
  // frp 类型在上面被归一化回写过 body.payload，入库的是归一化后的值
  const finalPayloadStr = type === "frp" ? JSON.stringify(body.payload) : payloadStr
  const remarkVal = (body.remark ?? "").trim().slice(0, 500) || null
  if (overwriteId) {
    // 覆盖：写入新 payload / 邮箱 / 备注，重置为待审核并清掉上次的审核痕迹
    // （newapi_channel_id 刻意**保留** —— 自动接入据此就地替换渠道里的 Key）
    await env.DB.prepare(
      `UPDATE donations
          SET payload = ?, notify_email = ?, remark = ?, status = 'pending',
              review_note = NULL, reviewed_at = NULL, auto_reviewed = 0
        WHERE id = ?`
    )
      .bind(finalPayloadStr, notifyEmail, remarkVal, overwriteId)
      .run()
  } else {
    await env.DB.prepare(
      `INSERT INTO donations (id, user_id, type, payload, notify_email, remark, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
    )
      .bind(id, user.id, type, finalPayloadStr, notifyEmail, remarkVal, now)
      .run()
  }

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
  } else if (type === "sensenova") {
    // 商汤通道**不受 auto_review_features 约束**（与反代账号通道同一语义）：
    // 它的门槛极低（提交一个 Key 即可），若也走「自动审核」开关，管理员关掉
    // 自动审核后这条通道就会退化成人工审核，与「免审核」的设计相悖。
    // 它只受自己的 sensenova_enabled 开关控制（在 autoProvisionSenseNovaDonation 里）。
    try {
      auto = await autoProvisionSenseNovaDonation(env, { id, payloadStr })
    } catch (err) {
      console.error("商汤捐献自动接入失败，转为待人工审核:", err)
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
        `捐献类型：${DONATION_TYPE_LABELS[type] ?? FEATURE_LABELS[feature]}`,
        `通知邮箱：${notifyEmail}`,
        body.remark ? `备注：${body.remark.trim().slice(0, 200)}` : "",
        type === "ai" || type === "sensenova"
          ? "该申请需要人工复核（自动校验未能完成）。"
          : "",
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

  // 细粒度：审核不同类型要对应节点（站长 2026-10-04 要求分 ai / 代理 / 内网穿透）
  const reviewPerm =
    app.type === "proxy" ? "donations.proxy"
    : app.type === "frp" ? "donations.frp"
    : "donations.ai"
  await assertAdminScope(env, admin, reviewPerm)

  const approve = body.action === "approve"
  // 被**系统自动拒绝**的单据允许复核放行（这正是「人工复核」的用途）；
  // 被**系统撤销**（资源失效）的同样允许 —— 管理员可能在核对了新情况后
  // 决定照样放行（例如用户已在别处补齐了同等资源），这只是人工兜底。
  // 已经批准过的不允许重复批准。
  const canApprove =
    app.status === "pending" || app.status === "rejected" || app.status === "revoked"
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
    // AI / 商汤类型：批准时把渠道接进中转站（best-effort）。
    // 已经接入过（channelId 有值，比如撤销后复核放行）就不再重复建。
    let channelId: number | null = app.newapi_channel_id ?? null
    if (app.type === "ai" && channelId === null) {
      const line = await tryProvisionForReview(env, app)
      if (line.channelId !== null) channelId = line.channelId
      if (line.message) {
        note = `${note ? note + "\n" : ""}${line.message}`.slice(0, 500)
      }
    } else if (
      app.type === "sensenova" &&
      // 被系统巡检撤销（资源失效）后管理员又复核放行：**要再验一次并重新并入**，
      // 因为撤销时已经把 Key 从渠道摘掉了 —— 只看 channelId 会在渠道里
      // 没有这把 Key 的情况下直接放行权限（等于再造一次同一个漏洞）。
      (channelId === null || app.status === "revoked")
    ) {
      // 商汤通道通常是自动接入的；走到人工复核说明当时上游抖动（network）。
      // 管理员点「复核通过」就是让它再试一次 —— 成功则渠道接上，
      // 失败也不阻断放行（权限照给，渠道留给管理员在中转站手工处理）。
      const line = await tryProvisionSenseNovaForReview(env, app)
      if (line.channelId !== null) channelId = line.channelId
      if (line.message) {
        note = `${note ? note + "\n" : ""}${line.message}`.slice(0, 500)
      }
    }

    const applied = await applyDonationApproval(env, app, {
      adminId: admin.id,
      note,
      channelId,
      // 商汤通道不发额度不发券（与自动路径保持一致，否则「管理员手工放行」
      // 会变成绕过奖励限制的后门）
      grantRewards: app.type !== "sensenova",
    })
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

  await notifyDonationResult(env, app, approve, note, {
    voucherCode,
    // 商汤通道的邮件文案要去掉额度/券那几行（该通道不发奖励）
    noReward: app.type === "sensenova",
  })

  return json({ ok: true, status: approve ? "approved" : "rejected", voucherCode })
}

/**
 * 商汤通道的人工复核接入尝试。返回一行可贴进备注的说明。
 * 不抛错 —— 调用方（审核）不能因为它失败而失败。
 */
async function tryProvisionSenseNovaForReview(
  env: Env,
  app: DonationRowWithUser
): Promise<{ channelId: number | null; message: string }> {
  if (!(await isNewApiConfigured(env))) {
    return { channelId: null, message: "（中转站未配置，渠道未创建）" }
  }
  let apiKey = ""
  try {
    apiKey = String((JSON.parse(app.payload) as { apiKey?: unknown }).apiKey ?? "").trim()
  } catch {
    return { channelId: null, message: "（未能解析捐献详情，渠道未创建）" }
  }
  if (!apiKey) return { channelId: null, message: "（缺少商汤 API Key，渠道未创建）" }

  const settings = await getSettings(env)
  const baseUrl = (settings.sensenova_base_url || "").trim()
  if (!baseUrl) return { channelId: null, message: "（管理员尚未配置商汤上游地址）" }

  const targetChannelId = Math.trunc(Number((settings.sensenova_channel_id || "").trim()))
  if (!Number.isFinite(targetChannelId) || targetChannelId <= 0) {
    return { channelId: null, message: "（管理员尚未配置「商汤接入渠道 ID」）" }
  }

  try {
    const probe = await probeSenseNova(baseUrl, apiKey)
    if (!probe.ok) {
      return { channelId: null, message: `（商汤校验失败：${probe.message}）` }
    }
    // 只追加 Key：不新建渠道、不动模型（与自动路径同一套语义）
    const result = await appendSenseNovaKey(env, { apiKey, channelId: targetChannelId })
    if (!result.ok) {
      return {
        channelId: result.channelId,
        message: `（Key 接入未完成：${result.message}${
          result.detail ? ` —— ${result.detail}` : ""
        }）`,
      }
    }
    return { channelId: result.channelId, message: `Key 接入成功：${result.detail}` }
  } catch (err) {
    return {
      channelId: null,
      message: `（渠道接入出错：${err instanceof Error ? err.message : String(err)}）`,
    }
  }
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
      // 全 uncertain 的情形渠道被刻意保留（channelId 非 null），照样返回它，
      // 让调用方把 id 落进单据 —— 管理员随后批准时可直接复用，不会重复建渠道。
      return {
        channelId: result.channelId,
        message: `（渠道接入未完成：${result.message}${
          result.detail ? ` —— ${result.detail}` : ""
        }）`,
      }
    }
    // 人工复核路径同样把失败模型落库，交给定时任务重试
    await recordFailedModelRetries(env, app.id, result, result.channelId)
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
  await requireAdminUser(env, request, "donations.ai")
  const app = await env.DB.prepare(
    `SELECT d.*, u.username, u.permissions FROM donations d
       JOIN users u ON u.id = d.user_id
      WHERE d.id = ?`
  )
    .bind(id)
    .first<DonationRowWithUser>()

  if (!app) throw new ApiError(404, "申请不存在", "NOT_FOUND")
  if (app.type !== "ai" && app.type !== "sensenova") {
    throw new ApiError(400, "只有 AI 类型捐献需要接入渠道", "INVALID_TYPE")
  }

  // 已经接进来过就不必再跑一遍接入（AI 会多建一个「捐献NN」渠道；商汤那句
  // 「追加」虽然天然幂等，但重跑没有意义）—— 这里退化成「复测一次」。
  if (app.newapi_channel_id !== null && app.newapi_channel_id !== undefined) {
    // 顺手把分组纠正到捐献分组：2026-10-01 之前建的捐献渠道留在 `default` 组里，
    // 这里自愈一笔是一笔（改分组不需要明文 key，见 updateChannelGroup）。
    // 失败不阻断复测 —— 分组不对只是「default 的 Key 也能调捐献模型」，不该因此拦住复核。
    if (app.type === "ai") {
      try {
        const settings = await getSettings(env)
        await updateChannelGroup(
          env,
          app.newapi_channel_id,
          resolveDonationGroup(settings.newapi_donation_group)
        )
      } catch (err) {
        console.error("复核时同步捐献渠道分组失败（不影响复测）:", app.newapi_channel_id, err)
      }
    }
    const existing = await testExistingChannel(env, app.newapi_channel_id)
    return json({
      ok: existing.ok,
      channelId: app.newapi_channel_id,
      message: existing.ok ? "渠道此前已接入，复测通过" : "渠道此前已接入，但复测未通过",
      detail: existing.message,
    })
  }

  const line =
    app.type === "sensenova"
      ? await tryProvisionSenseNovaForReview(env, app)
      : await tryProvisionForReview(env, app)
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

/**
 * POST /api/admin/donations/:id/retry-models —— 手动重试该单里没通过的模型。
 *
 * 与定时任务（maintenance 步骤 7）跑的是同一个函数，区别只是限定在本单、
 * 且**忽略 next_retry_at 的退避**（管理员点了就是想立刻试）。
 */
export async function retryDonationModelsNow(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  await requireAdminUser(env, request, "donations.ai")
  const app = await env.DB.prepare("SELECT id, type FROM donations WHERE id = ?")
    .bind(id)
    .first<{ id: string; type: string }>()
  if (!app) throw new ApiError(404, "申请不存在", "NOT_FOUND")

  const r = await retryDonationModels(env, { donationId: id, limit: 30 })
  // 若有模型恢复，顺手把「全不确定转人工」的单据自动放行（见该函数说明）
  const promoted = await promoteRecoveredDonations(env, r.recoveredDonations)
  const parts = [
    r.recovered.length > 0 ? `恢复 ${r.recovered.length} 个：${r.recovered.join("、")}` : "",
    r.stillUncertain > 0 ? `${r.stillUncertain} 个仍不可用（已排下次重试）` : "",
    r.exhausted > 0 ? `${r.exhausted} 个已放弃（重试次数用尽或渠道已删除）` : "",
    promoted.length > 0 ? "该捐献已自动通过审核" : "",
  ].filter(Boolean)

  return json({
    ok: r.errors.length === 0,
    recovered: r.recovered,
    stillUncertain: r.stillUncertain,
    exhausted: r.exhausted,
    promoted: promoted.length > 0,
    message: parts.length > 0 ? parts.join("；") : "没有待重试的模型",
    detail: r.errors.join("；"),
  })
}

/**
 * POST /api/admin/donations/:id/refetch-models —— 重新拉上游模型列表并补全渠道。
 *
 * 用途：救「这张重试表存在之前」的历史单 —— 那些单据的失败模型名只留在
 * review_note 文本里，已无从得知，只能重新拉一次上游列表做差集。
 */
export async function refetchDonationModelsNow(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  await requireAdminUser(env, request, "donations.ai")
  const r = await refetchDonationModels(env, id)
  return json({
    ok: r.ok,
    added: r.added,
    stillMissing: r.stillMissing,
    message: r.message,
  })
}

/**
 * 把「全模型不确定 → 转人工」的单据推进到已通过。
 *
 * 那种单据的特征是 `status='pending'` + `newapi_channel_id IS NOT NULL`
 * （由 `autoProvisionAiDonation` 的轻量 UPDATE 写入）。只要有一个模型被
 * 重试确认可用，就说明 Key 与上游都正常 —— 没必要让管理员再点一次。
 *
 * **只处理 AI 类型**：商汤通道的「全不确定」是 network 类失败（Key 本身
 * 可能没问题但上游整体故障），重试通过同样说明可用；但商汤的重试记录不走
 * 这套（它不逐个测模型），所以这里的判据天然只命中 AI 单据。
 *
 * 失败只记日志：这是「锦上添花」的自动推进，出错不该影响重试本身的结果。
 *
 * 导出给 maintenance 复用（定时重试跑完后同样要推进，否则「全模型 429」的
 * 单据会一直卡在 pending，等管理员发现才处理）。
 */
export async function promoteRecoveredDonations(
  env: Env,
  donationIds: string[]
): Promise<string[]> {
  const promoted: string[] = []
  for (const id of donationIds) {
    try {
      const app = await env.DB.prepare(
        `SELECT d.*, u.username, u.permissions FROM donations d
           JOIN users u ON u.id = d.user_id
          WHERE d.id = ?`
      )
        .bind(id)
        .first<DonationRowWithUser>()

      // 判据要严：必须是「转人工」的那种单据，别把别的状态也顺手改了
      if (!app || app.status !== "pending" || app.newapi_channel_id == null) continue
      if (app.type !== "ai") continue

      const note = "系统重试已确认至少一个模型可用，自动通过审核。"
      const applied = await applyDonationApproval(env, app, {
        adminId: null,
        note,
        channelId: app.newapi_channel_id,
      })
      await notifyDonationResult(env, app, true, note, {
        auto: true,
        voucherCode: applied.voucherCode,
      })
      promoted.push(id)
    } catch (err) {
      console.error("自动推进「转人工」单据失败:", id, err)
    }
  }
  return promoted
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
  const admin = await requireAdminUser(env, request, "donations.ai")
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
    // 原子写：只把该模块置 false，不整列覆盖（见 permissions.ts 的说明）
    batch.push(
      env.DB.prepare(
        `UPDATE users SET permissions = ${featurePermissionSql(feature, false)}, updated_at = ?
          WHERE id = ? AND ${notWhitelistedGuard()}`
      ).bind(now, app.user_id)
    )
  }

  await env.DB.batch(batch)

  // 收回资源 —— 两条通道的「资源形态」完全不同，动作也**必须**分开：
  //
  //   · AI 渠道捐献：渠道是本单专属的（每单新建一个「捐献NN」），直接删掉。
  //   · 商汤 Key 捐献：Key 是**追加进管理员自己的那个多密钥渠道**的
  //     （见 sensenova.ts），那个渠道不属于本单、里面还有别处来的 Key ——
  //     按 id 删掉等于把整个商汤上游下架。只能把这一把 Key 从渠道里摘掉。
  //
  // ⚠️ 因此这里的 `app.newapi_channel_id` 对商汤来说指向的是**共享渠道**，
  // 将来任何人想「按 id 删渠道」都必须先看类型，别再写成 `["ai","sensenova"]`。
  //
  // ⚠️ 故意**保留** newapi_channel_id 不清空 —— 序号是按「有过渠道的条数」推进的，
  // 清空会让下一笔捐献复用同一个「捐献NN」名字。重新批准时会覆盖成新的 id。
  let released = false
  let releaseMessage = ""
  if (app.type === "ai" && app.newapi_channel_id) {
    released = await releaseDonationChannel(env, app.newapi_channel_id)
  } else if (app.type === "sensenova" && app.newapi_channel_id) {
    let apiKey = ""
    try {
      apiKey = String((JSON.parse(app.payload) as { apiKey?: unknown }).apiKey ?? "").trim()
    } catch {
      apiKey = ""
    }
    const r = await releaseSenseNovaKey(env, { channelId: app.newapi_channel_id, apiKey })
    released = r.ok
    releaseMessage = r.message
  }

  // 代理捐献同理：撤销时把「这笔捐献导入的订阅源」从节点池里删掉，
  // 否则资源还挂在池子里被所有人用着（只收回自己的 proxy 权限没有意义）。
  // 只删 source_donation_id 指向本单的行，不碰管理员手工添加的。
  let releasedSubs = 0
  if (app.type === "proxy") {
    // 先取出要删的订阅源 id，删掉后对称清理它们的节点指纹
    const ids = await env.DB.prepare(
      "SELECT id FROM proxy_subscriptions WHERE source_donation_id = ?"
    )
      .bind(app.id)
      .all<{ id: string }>()
    const idList = (ids.results ?? []).map((r) => r.id)
    const del = await env.DB.prepare(
      "DELETE FROM proxy_subscriptions WHERE source_donation_id = ?"
    )
      .bind(app.id)
      .run()
    releasedSubs = del.meta?.changes ?? 0
    if (idList.length > 0) {
      const placeholders = idList.map(() => "?").join(",")
      await env.DB.prepare(
        `DELETE FROM proxy_node_fingerprints WHERE subscription_id IN (${placeholders})`
      )
        .bind(...idList)
        .run()
    }
  }

  // 内网穿透捐献：撤销时把捐献的服务端节点**停用**（不删，删了会级联
  // 清掉已分配端口与申请单，产生额外副作用）。只停 source_donation_id
  // 指向本单的节点，管理员手工建的节点（该列为 NULL）不受影响。
  let releasedFrpNode = false
  if (app.type === "frp") {
    const upd = await env.DB.prepare(
      `UPDATE frp_nodes
         SET enabled = 0, status = 'offline',
             status_note = '捐献已撤销', status_updated_at = ?
       WHERE source_donation_id = ? AND enabled = 1`
    )
      .bind(now, app.id)
      .run()
    releasedFrpNode = (upd.meta?.changes ?? 0) > 0
  }

  await env.DB.prepare(
    "INSERT INTO audit_logs (id, user_id, action, detail, created_at) VALUES (?, ?, 'donation.revoke', ?, ?)"
  )
    .bind(
      uuid(),
      admin.id,
      `撤销 ${app.type} 捐献审核（用户 ${app.user_id}）${app.granted_feature === 1 ? "，已收回权限" : ""}${released ? "，已收回中转站资源" : ""}${releaseMessage ? `，${releaseMessage.replace(/[（）]/g, "")}` : ""}${releasedSubs > 0 ? `，已移出 ${releasedSubs} 个订阅源` : ""}${releasedFrpNode ? "，已停用 frp 节点" : ""}`,
      now
    )
    .run()

  return json({
    ok: true,
    revokedPermission: app.granted_feature === 1,
    releasedChannel: released,
    /** 商汤通道：说明是否真的从渠道里摘掉了那把 Key（含「没找到，请手工处理」的原因） */
    releaseMessage: releaseMessage || null,
    releasedSubscriptions: releasedSubs,
    releasedFrpNode,
  })
}

/* --------------------------------------------------------------------------
 * 商汤 Key 定期可用性巡检（2026-09-28）
 *
 * 背景（用户反馈的漏洞）：商汤通道的门槛是「提交一个 Key」，这个 Key 只用来
 * 解锁权限、不发额度。于是存在一条白嫖路径：
 *   建一个 Key → 捐献拿到 ai 权限 → **去商汤控制台把 Key 删掉** → 权限留着。
 * 渠道里那把 Key 已死，平台白养一个「有权限但没贡献」的账号。
 *
 * 封堵：定期（每小时 cron）真调一次上游，**只有上游明确拒绝（401/403）
 * 才算「Key 真的没了」**；超时 / 5xx / 429 / 地址配错一律放过。
 * 判据与提交时完全一致 —— 都走 `probeSenseNova`，不另写一套。
 *
 * 判定失效后的动作，按用户明确划定的边界执行：
 *   ① 把这把 Key 从共享渠道里摘掉（死 Key 留着只会拖慢上游轮询）；
 *   ② 收回 ai 权限 —— **仅当**这次捐献确实是该用户 ai 权限的唯一来源；
 *   ③ 权限真被收回时，连带封禁其 NewAPI 中转站账号
 *      （否则「云端没权限、中转站照样能调」，等于没收回）。
 *
 * 「唯一来源」怎么判：
 *   `granted_feature === 1` 是必要条件 —— 它意味着审批那一刻用户本来没有 ai
 *   （顺带排除了「注册时邀请码就带了 ai」的老用户：那种情况 granted_feature
 *   会是 0，本函数直接不动）。在此基础上再排除其它 ai 依据：
 *   别的已通过 ai 捐献 / 仍 active 的反代绑定 / 用过的 ai 权限券。
 *
 * ⚠️ 已知残余盲区（与 wb2api 的 shouldKeepAiPermission 同一处境，不硬凑）：
 *   管理员在「成员详情」里手工给某人开过 ai，库里没有反向索引、事后无法溯源 ——
 *   这类用户会被一起收回。但管理员本来就知道这个人没捐献，可人工恢复。
 * ----------------------------------------------------------------------- */

export interface SenseNovaKeyAuditResult {
  /** 本轮实际探测的笔数（受 SENSENOVA_AUDIT_BATCH 限制） */
  checked: number
  /** 判定「Key 真的失效」的笔数（仅 401/403） */
  invalid: number
  /** 上游抖动/超时/地址问题而**放过**的笔数（不判定、不动手） */
  uncertain: number
  /** 已从中转站渠道摘掉 Key 的笔数（预演时恒为 0） */
  keysRemoved: number
  /** 收回 ai 权限的用户数；`dryRun` 时为「将会收回」的预测值 */
  permissionsRevoked: number
  /** 连带禁用 NewAPI 中转站账号的数量（预演时恒为 0） */
  newapiDisabled: number
  /** 判定失效、但用户还有别的 ai 依据 ⇒ 保留权限的用户数（预演时也会统计） */
  keptWithOtherSource: number
  /** 判定失效、但权限本来就不是这次捐献给的 ⇒ 不动权限的笔数（预演时也会统计） */
  keptNotGranted: number
  errors: string[]
  /** 需要管理员知道的逐条明细（会被运维报告原样带到 warnings 里） */
  notes: string[]
}

/**
 * 每轮最多真调多少次上游。
 *
 * 为什么要设上限：每次探测都是一次 outbound subrequest，而 Cloudflare 免费版
 * **单次请求子请求上限 50**，同一个 cron 里还跑着公告群发（一次最多 20 封）、
 * 失败模型重试（最多 5×2 次）等 —— 本模块自述的基线就已有约 15 个。
 * 取 10 是给上面那两项留余地：宁可多转一轮，也不能把别的运维项挤失败
 * （那种失败是静默的，只在 maintenance_runs.errors 里留一行）。
 *
 * 轮转方式：按「当前小时数 % 窗口数」取一个窗口（见下方 start 的计算）。
 * 总量不超过上限时 windows=1、start 恒为 0（每轮全查）；超过后自动变成
 * 「多轮覆盖一轮」—— 不需要新增时间戳列（本仓线上加列要手工执行迁移，代价高）。
 *
 * ⚠️ 这个上限只约束**定时任务**。管理员手动入口传 `all: true` 时不受此限
 * （手动是一次性的、有人盯着，且能先预演；让它只查一半反而是坑）。
 */
const SENSENOVA_AUDIT_BATCH = 10

/**
 * 查这个用户还有没有别的「ai 权限依据」。有则返回一句人话说明，没有返回 null。
 *
 * 只覆盖**库里能反查到的**来源。三种都在这里：
 *   · 其它已通过的 ai / 商汤捐献（用户说的「提交了好几个 ai 渠道」）
 *   · 仍 active 的反代绑定（wb2api / cli2api，绑定时也会授予 ai）
 *   · 用掉的 ai 权限券（vouchers.used_feature='ai'）
 *
 * 为什么券要查：券可能是**捐献之后**才兑的，那时 ai 已由捐献解锁，券会提示
 * 「你已经有这个权限了」吗？—— 不会，自选券正是用来补没开的模块的，
 * 所以「捐了商汤 → 后来用券换了 ai」在库里是两笔独立事实，必须分别认。
 */
async function findOtherAiSource(
  env: Env,
  userId: string,
  excludeDonationId: string
): Promise<string | null> {
  const otherDonation = await env.DB.prepare(
    `SELECT type FROM donations
      WHERE user_id = ? AND id != ? AND status = 'approved'
        AND type IN ('ai', 'sensenova')
      LIMIT 1`
  )
    .bind(userId, excludeDonationId)
    .first<{ type: string }>()
  if (otherDonation) {
    return `还有一笔已通过的${otherDonation.type === "sensenova" ? "商汤 Key" : "AI 渠道"}捐献`
  }

  const wb = await env.DB.prepare(
    "SELECT 1 AS x FROM wb2api_bindings WHERE user_id = ? AND status = 'active' LIMIT 1"
  )
    .bind(userId)
    .first()
  if (wb) return "还有在用中的反代（WorkBuddy）绑定"

  const cli = await env.DB.prepare(
    "SELECT 1 AS x FROM cli2api_bindings WHERE user_id = ? AND status = 'active' LIMIT 1"
  )
    .bind(userId)
    .first()
  if (cli) return "还有在用中的反代（CLI2API）绑定"

  const voucher = await env.DB.prepare(
    "SELECT 1 AS x FROM vouchers WHERE used_by = ? AND used_feature = 'ai' LIMIT 1"
  )
    .bind(userId)
    .first()
  if (voucher) return "还用过一张 AI 权限兑换券"

  return null
}

/**
 * 巡检一遍「已通过」的商汤 Key 捐献，处理真正失效的那些。
 *
 * 由 `runMaintenance` 每小时调用（`dryRun` 时只观察、不写库、不摘 Key）。
 * 单笔失败不中断整轮 —— 全部记进 errors，让管理员在运维报告里看见。
 */
export async function auditSenseNovaKeys(
  env: Env,
  opts: { dryRun?: boolean; all?: boolean } = {}
): Promise<SenseNovaKeyAuditResult> {
  const dryRun = opts.dryRun === true
  const out: SenseNovaKeyAuditResult = {
    checked: 0,
    invalid: 0,
    uncertain: 0,
    keysRemoved: 0,
    permissionsRevoked: 0,
    newapiDisabled: 0,
    keptWithOtherSource: 0,
    keptNotGranted: 0,
    errors: [],
    notes: [],
  }

  const settings = await getSettings(env)
  const baseUrl = (settings.sensenova_base_url || "").trim()
  // 上游地址没配 ⇒ 连「该拿哪个地址去验」都不知道，整轮跳过（这不是错误）
  if (!baseUrl) return out
  if (!(await isNewApiConfigured(env))) return out

  const fallbackChannelId = Math.trunc(Number((settings.sensenova_channel_id || "").trim()))
  const aiIsOpen = parseOpenFeatures(settings.open_features).has("ai")

  const rows = await env.DB.prepare(
    `SELECT d.*, u.username, u.permissions, u.role
       FROM donations d JOIN users u ON u.id = d.user_id
      WHERE d.type = 'sensenova' AND d.status = 'approved'
      ORDER BY d.created_at ASC`
  ).all<DonationRowWithUser & { role: string }>()

  const all = rows.results ?? []
  // 轮转窗口：总量 ≤ 上限时 windows=1、start 恒为 0（每轮全查）。
  // 定时任务必须轮转（省 subrequest 预算）；但**管理员手动跑**（opts.all）要一次
  // 看全，否则「手动点一次只查了一半」会让人误以为已经查完了。
  const windows = Math.max(1, Math.ceil(all.length / SENSENOVA_AUDIT_BATCH))
  const start = (Math.floor(Date.now() / 3_600_000) % windows) * SENSENOVA_AUDIT_BATCH
  const batch = opts.all ? all : all.slice(start, start + SENSENOVA_AUDIT_BATCH)

  // 白名单用户：即使 Key 失效也不收回权限、不封禁中转站（2026-10-03 站长要求）。
  // 循环外一次性查成全量 Set，避免每个捐献各查一次白名单表。
  const whitelist = new Set<string>()
  try {
    const wlRows = await env.DB.prepare("SELECT username FROM moderation_whitelist").all<{
      username: string
    }>()
    for (const r of wlRows.results ?? []) whitelist.add(r.username.toLowerCase())
  } catch {
    // 表未建好时按「无白名单」处理（与 isUsernameWhitelisted 同口径）
  }

  for (const row of batch) {
    let apiKey = ""
    try {
      apiKey = String((JSON.parse(row.payload) as { apiKey?: unknown }).apiKey ?? "").trim()
    } catch {
      apiKey = ""
    }
    // 没有明文 Key 就没法验（理论上不该发生：提交时强制要 Key）
    if (!apiKey) continue

    out.checked++
    let probe: SenseNovaProbeResult
    try {
      probe = await probeSenseNova(baseUrl, apiKey)
    } catch (err) {
      out.errors.push(
        `商汤 Key 探测异常（捐献 ${row.id}）：${err instanceof Error ? err.message : String(err)}`
      )
      continue
    }

    // 能用 → 什么都不做（这才是绝大多数情况）
    if (probe.ok) continue

    // ⚠️ 核心红线：只有「上游明确拒绝」才算失效。超时、5xx、429、地址配错
    // 全都可能是我们这边或上游的一时问题，绝不能据此收回别人的权限。
    if (probe.kind !== "invalid_key") {
      out.uncertain++
      continue
    }

    out.invalid++

    // ---- 判断该不该收回 ai ----
    // ⚠️ 必须放在 dryRun 之前算：预演的全部价值就是让站长先看清「会收回谁」，
    // 若在预演分支里提前 continue，权限数永远是 0，预演就成了「只看得到失效、
    // 看不到影响」。findOtherAiSource 是只读查询，预演里跑它没有任何副作用。
    /** 非 null = 「不收回」，值是给管理员/用户看的原因 */
    let keepReason: string | null = null
    if (row.granted_feature !== 1) {
      out.keptNotGranted++
      keepReason = "该捐献通过时你已有 ai 权限，不是这次给的"
    } else if (isPrivileged(row.role)) {
      out.keptWithOtherSource++
      keepReason = "管理员账号不受捐献权限约束"
    } else if (whitelist.has(row.username.toLowerCase())) {
      out.keptWithOtherSource++
      keepReason = "白名单用户，不收回权限"
    } else if (aiIsOpen) {
      out.keptWithOtherSource++
      keepReason = "「AI 中转站」当前设为免权限开放，收回无意义"
    } else {
      const other = await findOtherAiSource(env, row.user_id, row.id)
      if (other) {
        out.keptWithOtherSource++
        keepReason = other
      }
    }

    if (dryRun) {
      // 预演：如实报出「会做什么」，但一个字都不写库、不摘 Key
      if (!keepReason) out.permissionsRevoked++
      out.notes.push(
        `[预演] ${row.username} 的商汤 Key 已失效（${probe.message}）：${
          keepReason
            ? `不会收回权限（${keepReason}）`
            : "将摘除 Key、收回 AI 权限并封禁中转站账号"
        }`
      )
      continue
    }

    const now = new Date().toISOString()

    // ---- ① 摘 Key（摘不掉也不阻断后续：权限该收还是要收）----
    const channelId = row.newapi_channel_id ?? fallbackChannelId
    const released = await releaseSenseNovaKey(env, {
      channelId: Number.isFinite(channelId) ? channelId : 0,
      apiKey,
    })
    if (released.ok) out.keysRemoved++

    let revokedAi = false
    let newapiDisabled = false
    if (!keepReason) {
      // 原子写 + 守卫：只有「原本确实开着」才算真收回，且不整列覆盖并发写入
      const res = await env.DB.prepare(
        `UPDATE users SET permissions = ${featurePermissionSql("ai", false)}, updated_at = ?
          WHERE id = ? AND ${featurePermittedGuard("ai")} AND ${notWhitelistedGuard()}`
      )
        .bind(now, row.user_id)
        .run()
      revokedAi = (res.meta?.changes ?? 0) > 0

      if (revokedAi) {
        out.permissionsRevoked++
        // ---- ③ 连带封禁中转站账号 ----
        try {
          const acct = await env.DB.prepare(
            "SELECT newapi_user_id FROM newapi_accounts WHERE user_id = ?"
          )
            .bind(row.user_id)
            .first<{ newapi_user_id: number | null }>()
          if (acct?.newapi_user_id) {
            await adminSetUserStatus(env, acct.newapi_user_id, "disable")
            newapiDisabled = true
            out.newapiDisabled++
          }
        } catch (err) {
          // 与封禁用户时同一条原则：NewAPI 失败不阻断主操作（权限已经收回）
          out.errors.push(
            `禁用 NewAPI 账号失败（${row.username}）：${
              err instanceof Error ? err.message : String(err)
            }`
          )
        }
      }
    }

    // ---- ④ 单据置为 revoked ----
    // 用独立状态而不是 rejected：用户端要能看出「不是你填错了，是资源后来失效」。
    // 同时它天然幂等 —— 本巡检只扫 approved，处理过的不再被扫到。
    const note = [
      `系统定期巡检发现该 Key 已被上游拒绝（${probe.message}）。`,
      released.ok
        ? "已从中转站渠道移除。"
        : `Key 未能自动移除：${released.message.replace(/[（）]/g, "")}。`,
      revokedAi
        ? `已收回由本次捐献解锁的 AI 中转站权限${newapiDisabled ? "，并已封禁其对应的中转站账号" : ""}。`
        : `未收回权限（${keepReason}）。`,
    ].join("")

    await env.DB.prepare(
      `UPDATE donations
          SET status = 'revoked', review_note = ?, reviewed_at = ?,
              granted_feature = NULL, auto_reviewed = 1
        WHERE id = ? AND status = 'approved'`
    )
      .bind(note.slice(0, 500), now, row.id)
      .run()

    await env.DB.prepare(
      "INSERT INTO audit_logs (id, user_id, action, detail, created_at) VALUES (?, ?, 'donation.sensenova_audit', ?, ?)"
    )
      .bind(uuid(), row.user_id, note, now)
      .run()

    await notifyDonationResult(env, row, false, note, {
      auto: true,
      noReward: true,
      revoked: true,
    })

    out.notes.push(
      `商汤 Key 失效：${row.username} —— Key ${
        released.ok ? "已移出渠道" : "移除失败（请到中转站手工处理）"
      }；${revokedAi ? `已收回 AI 权限${newapiDisabled ? "并封禁中转站账号" : ""}` : `保留权限（${keepReason}）`}`
    )
  }

  return out
}

/**
 * POST /api/admin/sensenova/audit —— 管理员手动跑一次商汤 Key 巡检。
 *
 * **默认只预演**（`dryRun`），必须显式带 `{"apply": true}` 才真动手 ——
 * 这个动作会收回权限、封禁中转站账号，绝不能因为误点/误调用而触发。
 *
 * 为什么要有这个入口：定时巡检每小时一轮，且为了不挤占 subrequest 预算，
 * 单轮只覆盖一批 Key（轮转）。站长想知道「现在到底有没有人在白嫖」时，
 * 需要一个马上能跑、且能先看结果的入口 —— 所以这里**全量**扫描（`all: true`），
 * 并支持先预演再动手。
 */
export async function adminAuditSenseNovaKeys(
  env: Env,
  request: Request
): Promise<Response> {
  const admin = await requireAdminUser(env, request, "donations.ai")
  let apply = false
  try {
    const body = (await request.json()) as { apply?: unknown } | null
    apply = body?.apply === true
  } catch {
    // 空 body / 非 JSON 一律当预演，安全侧默认
    apply = false
  }

  const result = await auditSenseNovaKeys(env, { dryRun: !apply, all: true })

  if (apply) {
    await env.DB.prepare(
      "INSERT INTO audit_logs (id, user_id, action, detail, created_at) VALUES (?, ?, 'donation.sensenova_audit', ?, ?)"
    )
      .bind(
        uuid(),
        admin.id,
        `管理员手动执行商汤 Key 巡检：探测 ${result.checked}，失效 ${result.invalid}，` +
          `摘 Key ${result.keysRemoved}，收回权限 ${result.permissionsRevoked}，` +
          `连带封禁中转站账号 ${result.newapiDisabled}`,
        new Date().toISOString()
      )
      .run()
  }

  return json({ ok: true, dryRun: !apply, ...result })
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

  // ⚠️ 2026-09-26 审计：pending 的单据也可能**已经产出过资源** ——
  // AI 捐献在审核过程中就会建渠道，全模型探测不确定时保留 newapi_channel_id
  // 并把单据挂回 pending（见本文件 applyDonationApproval 的说明）。
  // 原先直接 DELETE 会让那个渠道带着捐献者的 Key 留在 NewAPI 里继续被调用。
  // 所以按类型先回收资源，再删行。回收失败不阻断删除（否则用户永远撤不掉）。
  if (app.newapi_channel_id) {
    try {
      if (app.type === "ai") {
        await releaseDonationChannel(env, app.newapi_channel_id)
      } else if (app.type === "sensenova") {
        // 商汤只能摘这一把 Key —— channel_id 指向管理员自己的共享渠道
        let apiKey = ""
        try {
          apiKey = String((JSON.parse(app.payload) as { apiKey?: unknown }).apiKey ?? "").trim()
        } catch {
          apiKey = ""
        }
        await releaseSenseNovaKey(env, { channelId: app.newapi_channel_id, apiKey })
      }
    } catch (err) {
      console.error("撤销申请时回收捐献资源失败（仍继续删除）:", id, err)
    }
  }

  await env.DB.prepare("DELETE FROM donations WHERE id = ?").bind(id).run()
  return new Response(null, { status: 204 })
}