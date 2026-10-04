/**
 * 权限兑换码。
 *
 * 两种来源，同一个兑换入口：
 *   1. **首捐奖励**（`source = first_donation`）：用户第一次捐献成功时自动发放一张
 *      「自选权限」券，他挑一个自己还没开的模块。
 *   2. **别人给的邀请码**：邀请码的 `permissions` 就是一张权限凭证，
 *      已在站的用户可以用它补齐自己缺的模块（不用重新注册）。
 *
 * ⚠️ 为什么邀请码要挡「自己用自己建的码」：
 *   `invite_basic_features` 里的模块创建邀请码**不消耗模块额度**。
 *   若不挡，任何用户都能「建一个只含模块 X 的码 → 自己用掉」来白拿 X 权限，
 *   绕过「权限要靠捐献解锁」这条主线。别人（含管理员）发的码不受影响。
 */
import { uuid } from "./crypto"
import { ApiError } from "./http"
import {
  FEATURES,
  FEATURE_LABELS,
  parsePermissions,
  grantFeaturesSql,
  type Feature,
} from "./permissions"
import { ensureNewApiAccountEnabled } from "./newapi-access"
import { getSetting } from "./settings"
import type { Env } from "./env"

/** 首捐奖励券的来源标记（也是「一辈子只发一张」的幂等键） */
export const FIRST_DONATION_VOUCHER_SOURCE = "first_donation"

/** 生成兑换码，形如 VX-XXXX-XXXX（去掉易混字符 I/O/0/1） */
export function generateVoucherCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  const pick = (n: number) =>
    Array.from(crypto.getRandomValues(new Uint8Array(n)))
      .map((b) => alphabet[b % alphabet.length])
      .join("")
  return `VX-${pick(4)}-${pick(4)}`
}

export interface VoucherRow {
  id: string
  code: string
  owner_user_id: string
  source: string
  feature: string | null
  transferable: number
  status: string
  used_by: string | null
  used_feature: string | null
  used_at: string | null
  note: string | null
  created_at: string
}

/** 读取某用户当前的权限（NULL 视为全开） */
export async function loadPermissions(env: Env, userId: string) {
  const row = await env.DB.prepare("SELECT permissions FROM users WHERE id = ?")
    .bind(userId)
    .first<{ permissions: string | null }>()
  return parsePermissions(row?.permissions)
}

/** 把若干模块打开（只写 users.permissions，不动额度） */
export async function grantFeatures(
  env: Env,
  userId: string,
  features: Feature[]
): Promise<void> {
  if (features.length === 0) return

  // ⚠️ 2026-09-26 审计：原先是「读出 permissions → 在 JS 里合并 → 整列写回」。
  // 同时兑两张券时，两个请求各自基于旧快照写回绝对值，后写的一方会把先写方
  // 刚授予的模块整列覆盖掉 —— 表现为「兑了两张券却只生效一张」。
  // 改用 json_set 在原列上只动目标键，D1/SQLite 单条语句原子生效。
  await env.DB.prepare(
    `UPDATE users SET permissions = ${grantFeaturesSql(features)}, updated_at = ? WHERE id = ?`
  )
    .bind(new Date().toISOString(), userId)
    .run()

  // 给到 `ai` 时顺带确保中转站账号是启用的（写在权限落库**之后**：权限才是主操作）。
  //
  // 与捐献审核那条路（handlers/donations.ts）是同一个洞的不同入口：商汤巡检
  // 收回 ai 时会连带 disable 中转站账号，用户后来通过**兑换码 / 积分商城**
  // 把 ai 拿回来，账号却还是禁用 —— 表现成「有权限但调不通」。
  // 放在这里是因为「授予权限」在本文件只有这一个函数，堵一处覆盖两条路。
  // 该函数内部自己 try/catch，失败不影响授权本身。
  if (features.includes("ai")) {
    await ensureNewApiAccountEnabled(env, userId)
  }
}

/** 校验一个模块名是否合法（前端传进来的东西不能信） */
export function requireFeature(raw: unknown): Feature {
  const f = String(raw ?? "") as Feature
  if (!(FEATURES as readonly string[]).includes(f)) {
    throw new ApiError(400, "不支持的权限项", "INVALID_FEATURE")
  }
  return f
}

export function featureLabel(f: string): string {
  return FEATURE_LABELS[f as Feature] ?? f
}

/**
 * 首捐奖励券**可兑换**的模块集合（设置项 `first_donation_voucher_features`）。
 *
 * 口径刻意与 `quotas.parseBasicFeatures` 保持一致，别在这里做「猜意图」的兜底：
 *   · `null` / `undefined`（设置项真的缺失）→ **全部模块**
 *     （这正是「默认全都可以兑换」；缺省时若回落成空集，
 *      站长没配过这个键就会把所有人的首捐券变成废纸）；
 *   · **空串**（站长在全关之后保存）→ **空集合**，即一个都不给；
 *   · 其余按字面解析，认不出的名字直接丢掉（写入口已校验）。
 */
export function parseFirstDonationFeatures(
  raw: string | null | undefined
): Set<Feature> {
  if (raw === null || raw === undefined) return new Set<Feature>(FEATURES)

  const out = new Set<Feature>()
  for (const seg of raw.split(",")) {
    const f = seg.trim() as Feature
    if ((FEATURES as readonly string[]).includes(f)) out.add(f)
  }
  return out
}

/** 读取首捐券当前允许兑换的模块（每次调用读库，站长改设置即时生效） */
export async function getAllowedFirstDonationFeatures(
  env: Env
): Promise<Set<Feature>> {
  return parseFirstDonationFeatures(await getSetting(env, "first_donation_voucher_features"))
}

/**
 * 首次捐献成功时发放「自选权限」券。返回券码；不该发时返回 null。
 *
 * 幂等保证（两道，缺一不可）：
 *   1. `source = first_donation` 的券一辈子只有一张 —— 撤销后再批准不会重复发；
 *   2. 必须「本次之外没有别的已通过捐献」，避免管理员把历史捐献批量通过时
 *      给老用户补发一堆（那时 approved 计数必然 > 1）。
 */
export async function grantFirstDonationVoucher(
  env: Env,
  userId: string
): Promise<string | null> {
  const existing = await env.DB.prepare(
    "SELECT id FROM vouchers WHERE owner_user_id = ? AND source = ? LIMIT 1"
  )
    .bind(userId, FIRST_DONATION_VOUCHER_SOURCE)
    .first()
  if (existing) return null

  // 调用点已经把本次置为 approved，所以「首次」= 计数恰好为 1
  const approved = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM donations WHERE user_id = ? AND status = 'approved'"
  )
    .bind(userId)
    .first<{ c: number }>()
  if (Number(approved?.c ?? 0) !== 1) return null

  const code = generateVoucherCode()
  await env.DB.prepare(
    `INSERT INTO vouchers
       (id, code, owner_user_id, source, feature, transferable, status, note, created_at)
     VALUES (?, ?, ?, ?, NULL, 1, 'unused', ?, ?)`
  )
    .bind(
      uuid(),
      code,
      userId,
      FIRST_DONATION_VOUCHER_SOURCE,
      "首次捐献成功奖励：可自选一个模块权限",
      new Date().toISOString()
    )
    .run()
  return code
}

export interface RedeemResult {
  /** 实际打开的模块 */
  granted: string[]
  /** 授予后该用户拥有的权限（前端用来刷新界面） */
  permissions: ReturnType<typeof parsePermissions>
  /** 券码（邀请码路径下是邀请码本身），用于回显 */
  code: string
}

/** 兑换一张券。`wanted` 只在自选券时有意义。 */
export async function redeemVoucher(
  env: Env,
  user: { id: string },
  voucher: VoucherRow,
  wanted: string | null
): Promise<RedeemResult> {
  if (voucher.status !== "unused") {
    throw new ApiError(409, "这个兑换码已经被使用过了", "ALREADY_USED")
  }
  if (voucher.owner_user_id !== user.id && voucher.transferable !== 1) {
    throw new ApiError(
      403,
      "这个兑换码是发给别人的，不能替你兑换",
      "NOT_YOUR_VOUCHER"
    )
  }

  const feature = voucher.feature ?? (wanted ? requireFeature(wanted) : null)
  if (!feature) {
    throw new ApiError(
      400,
      "这是一张自选券，请先选择要开通的权限",
      "FEATURE_REQUIRED"
    )
  }
  const f = requireFeature(feature)

  // 首捐奖励券：站长可以在管理面板里限定它能换哪几个模块
  // （设置项 first_donation_voucher_features，默认全部）。
  //
  // ⚠️ 必须放在「扣券」之前 —— 校验不过就报错走人，券不能变成 used。
  // 前端虽已按设置过滤候选列表，但请求可以伪造，真正的门在这里。
  if (voucher.source === FIRST_DONATION_VOUCHER_SOURCE) {
    const allowed = await getAllowedFirstDonationFeatures(env)
    if (!allowed.has(f)) {
      throw new ApiError(
        400,
        allowed.size === 0
          ? "首捐奖励券当前不可兑换任何权限，请联系管理员"
          : `首捐奖励券不能兑换「${featureLabel(f)}」，可兑换：${[...allowed].map(featureLabel).join("、")}`,
        "FEATURE_NOT_ALLOWED"
      )
    }
  }

  const perms = await loadPermissions(env, user.id)
  if (perms[f]) {
    throw new ApiError(
      400,
      `你已经有「${featureLabel(f)}」权限了，换一个试试`,
      "ALREADY_OWNED"
    )
  }

  const now = new Date().toISOString()
  const status = await env.DB.prepare(
    `UPDATE vouchers SET status = 'used', used_by = ?, used_feature = ?, used_at = ?
      WHERE id = ? AND status = 'unused'`
  )
    .bind(user.id, f, now, voucher.id)
    .run()
  // 并发下可能被别人先兑掉：changes=0 说明这一张已经没了
  if ((status.meta?.changes ?? 0) === 0) {
    throw new ApiError(409, "这个兑换码已经被使用过了", "ALREADY_USED")
  }

  await grantFeatures(env, user.id, [f])
  await writeAudit(env, user.id, `兑换权限券 ${voucher.code}：${featureLabel(f)}`, now)

  return {
    granted: [f],
    permissions: await loadPermissions(env, user.id),
    code: voucher.code,
  }
}

/**
 * 严格读「邀请码带了哪些模块权限」：**只有显式写成 `true` 的键才算**。
 *
 * ⚠️ 这里刻意不用 `parsePermissions`：它把「缺失的键」当作允许（那是给老用户的
 * 兼容兜底），用在邀请码上会让一个只写了 `{"frp":true}` 的码膨胀成「四个模块全给」——
 * 等于凭一张码拿到全部权限。邀请码走的是「码里写什么就给什么」的语义。
 */
export function featuresInInvite(raw: string | null): Feature[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed !== "object" || parsed === null) return []
    return FEATURES.filter((f) => parsed[f] === true)
  } catch {
    return []
  }
}

/**
 * 「码」是**一种东西**：既能发给别人，也能给自己用。所以这里不挡自用。
 *
 * 用户明确要求统一：「邀请码和兑换码是同一个东西，这个东西可以给别人用，
 * 也可以给自己增加权限」。所以自建码自用是**允许**的。
 *
 * 为什么自用不会变成白拿权限：创建邀请码时已经付过代价 ——
 * 1 个邀请码额度 + **每个受限模块各 1 个模块额度**（`consumeQuotaForInvite`）。
 * 而模块额度只能靠捐献或管理员发放获得。所以「自建自用」本质是
 * 「用额度换权限」，与捐献主线自洽。
 *
 * ⚠️ 唯一的例外：被管理员设为**基础权限**的模块，创建邀请码时不消耗模块额度
 * （见 `invite_basic_features`），于是自建自用能免费拿到那个模块。
 * 但「基础权限」正是管理员声明「这个模块可以人人免费授予」，
 * 所以这与该设置并不矛盾 —— 想收口就把该模块留在「受限模式」。
 *
 * 另外删除已使用的码不会退还额度（`used_count > 0` 不退款），
 * 所以不存在「建码 → 自用 → 删码 → 再建」的额度循环。
 */
export async function redeemInvite(
  env: Env,
  user: { id: string },
  invite: {
    id: string
    code: string
    created_by: string | null
    permissions: string | null
  }
): Promise<RedeemResult> {
  const offered = featuresInInvite(invite.permissions)
  if (offered.length === 0) {
    throw new ApiError(
      400,
      "这个邀请码没有携带任何模块权限",
      "NO_FEATURES"
    )
  }

  const perms = await loadPermissions(env, user.id)
  const missing = offered.filter((f) => !perms[f])
  if (missing.length === 0) {
    throw new ApiError(
      400,
      `这个邀请码带的权限（${offered.map(featureLabel).join("、")}）你都已经拥有了`,
      "ALREADY_OWNED"
    )
  }

  const now = new Date().toISOString()
  const consumed = await env.DB.prepare(
    "UPDATE invite_codes SET used_count = used_count + 1 WHERE id = ? AND used_count < max_uses"
  )
    .bind(invite.id)
    .run()
  if ((consumed.meta?.changes ?? 0) === 0) {
    throw new ApiError(409, "这个邀请码已经被用完了", "INVITE_EXHAUSTED")
  }

  await grantFeatures(env, user.id, missing)
  await writeAudit(
    env,
    user.id,
    `用邀请码 ${invite.code} 补齐权限：${missing.map(featureLabel).join("、")}`,
    now
  )

  return {
    granted: missing,
    permissions: await loadPermissions(env, user.id),
    code: invite.code,
  }
}

async function writeAudit(
  env: Env,
  userId: string,
  detail: string,
  at: string
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_logs (id, user_id, action, detail, created_at) VALUES (?, ?, 'voucher.redeem', ?, ?)"
  )
    .bind(uuid(), userId, detail, at)
    .run()
}
