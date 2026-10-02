/**
 * 用户自助创建邀请码。
 *
 * 与管理员创建的区别：
 *   * 只能创建「自己用」，权限受额度限制
 *   * 基础权限固定含「个人名片」（域名/邮箱本就不受限，无需授权），
 *     以及管理员设为「基础权限」的模块（invite_basic_features，默认 r2）
 *   * 受限模式模块（ai / frp / proxy 等）附加会消耗对应模块的转授额度
 *   * 每个码只能用一次（max_uses = 1）—— 额度语义即「能拉几个人」
 *
 * 额度来源见 quotas.ts：基础 3 个 + 每笔获批捐献 +2，且受限模块 +1。
 */
import { ApiError, json } from "../http"
import { uuid } from "../crypto"
import { requireUser } from "../auth"
import { parsePermissions, permissionsFromFeatures, type Permissions } from "../permissions"
import {
  QUOTA_FEATURES,
  QUOTA_FEATURE_LABELS,
  getBasicFeatures,
  loadUserQuota,
  consumeQuotaForInvite,
  refundQuotaForInvite,
  quotaFeaturesFromStored,
  type QuotaFeature,
} from "../quotas"
import type { Env } from "../env"

interface InviteRow {
  id: string
  code: string
  created_by: string | null
  max_uses: number
  used_count: number
  expires_at: string | null
  permissions: string | null
  created_at: string
}

/** 基础权限：个人名片 + 管理员设为「基础权限」的模块 */
function basePermissions(basic: Set<QuotaFeature>): Permissions {
  // 走 permissionsFromFeatures 而不是手写字面量：新增模块（如 doulor）时
  // 这里会自动补成 false，不会因为「漏写一个键」而编译不过或悄悄变成允许。
  return permissionsFromFeatures(basic)
}

/** 生成一个随机邀请码，形如 DC-XXXX-XXXX（去掉易混字符） */
function generateCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // 去掉 I O 0 1
  const pick = (n: number) =>
    Array.from(crypto.getRandomValues(new Uint8Array(n)))
      .map((b) => alphabet[b % alphabet.length])
      .join("")
  return `DC-${pick(4)}-${pick(4)}`
}

function toPublicInvite(row: InviteRow) {
  return {
    id: row.id,
    code: row.code,
    maxUses: row.max_uses,
    usedCount: row.used_count,
    expiresAt: row.expires_at,
    permissions: parsePermissions(row.permissions),
    createdAt: row.created_at,
  }
}

/**
 * GET /api/my-invites —— 我的额度 + 我创建的邀请码
 */
export async function listMyInvites(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const quota = await loadUserQuota(env, user.id)

  const rows = await env.DB.prepare(
    "SELECT * FROM invite_codes WHERE created_by = ? ORDER BY created_at DESC"
  )
    .bind(user.id)
    .all<InviteRow>()

  // 邀请奖励记录：被邀请人解锁 AI 权限时给本用户发的邀请订阅
  const rewardRows = await env.DB.prepare(
    `SELECT ir.granted_at, ir.plan_id, u.username AS invitee
       FROM invite_rewards ir
       JOIN users u ON u.id = ir.invitee_user_id
      WHERE ir.inviter_user_id = ?
      ORDER BY ir.granted_at DESC`
  )
    .bind(user.id)
    .all<{ granted_at: string; plan_id: number; invitee: string }>()

  return json({
    quota,
    invites: (rows.results ?? []).map(toPublicInvite),
    // 邀请奖励记录（有效邀请）：每笔 = 一个被邀请人解锁了 AI 权限
    rewards: (rewardRows.results ?? []).map((r) => ({
      invitee: r.invitee,
      planId: r.plan_id,
      grantedAt: r.granted_at,
    })),
    // 前端据此渲染权限勾选项与余额
    featureLabels: QUOTA_FEATURE_LABELS,
    quotaFeatures: QUOTA_FEATURES,
    basicFeatures: [...(await getBasicFeatures(env))],
  })
}

/**
 * POST /api/my-invites —— 创建邀请码
 * body: { code?, features?: QuotaFeature[] }
 *   features 省略 → 只含基础权限（个人名片 + 管理员设为基础权限的模块），
 *   基础权限模块不消耗模块额度，受限模块才消耗对应额度
 */
export async function createMyInvite(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json().catch(() => ({}))) as {
    code?: unknown
    features?: unknown
  }

  // 权限：基础（个人名片 + 基础权限模块）+ 用户勾选的受限模块
  const basic = await getBasicFeatures(env)
  const perms = basePermissions(basic)
  const requested: QuotaFeature[] = []
  if (Array.isArray(body.features)) {
    for (const raw of body.features) {
      const f = String(raw) as QuotaFeature
      if (!(QUOTA_FEATURES as readonly string[]).includes(f)) {
        throw new ApiError(400, "包含不支持的权限项", "INVALID_FEATURE")
      }
      if (!requested.includes(f)) requested.push(f)
      perms[f] = true
    }
  }

  // 邀请码文本：允许自定义，未填则自动生成
  let code = typeof body.code === "string" ? body.code.trim().toUpperCase() : ""
  if (code) {
    // ⚠️ 2026-09-25 审计（L13）：原下限是 **3 位**，而字符集只有
    // [A-Z0-9_-]（37 个）—— 3 位只有约 5 万种组合，配合多 IP 的注册爆破
    // （注册接口本身是 60 次/小时/IP，可被代理池绕过）足以猜中别人的邀请码，
    // 从而拿到对方设定的模块权限（r2/ai/frp/proxy）。
    // 自动生成的码是 `DC-XXXX-XXXX`（11 位），所以下限提到 8 位不影响自动生成。
    if (!/^[A-Z0-9_-]{8,32}$/.test(code)) {
      throw new ApiError(400, "邀请码只能包含大写字母、数字、- 和 _（8-32 位）", "INVALID_CODE")
    }
    const dup = await env.DB.prepare(
      "SELECT id FROM invite_codes WHERE code = ? COLLATE NOCASE LIMIT 1"
    )
      .bind(code)
      .first()
    if (dup) throw new ApiError(409, "该邀请码已存在，请换一个", "CONFLICT")
  } else {
    // 自动生成，最多试 5 次避免极端碰撞
    for (let i = 0; i < 5; i++) {
      const candidate = generateCode()
      const dup = await env.DB.prepare(
        "SELECT id FROM invite_codes WHERE code = ? COLLATE NOCASE LIMIT 1"
      )
        .bind(candidate)
        .first()
      if (!dup) {
        code = candidate
        break
      }
    }
    if (!code) {
      throw new ApiError(500, "邀请码生成失败，请重试", "CODE_GEN_FAILED")
    }
  }

  // 校验并扣减额度（额度不足会在这里抛错，不会留下已创建的码）
  await consumeQuotaForInvite(env, user.id, requested)

  const id = uuid()
  const now = new Date().toISOString()
  try {
    await env.DB.prepare(
      "INSERT INTO invite_codes (id, code, created_by, max_uses, used_count, permissions, created_at) VALUES (?, ?, ?, 1, 0, ?, ?)"
    )
      .bind(id, code, user.id, JSON.stringify(perms), now)
      .run()
  } catch (err) {
    // 插入失败要把刚扣的额度退回去，否则用户白掉一个额度
    await refundQuotaForInvite(env, user.id, requested)
    throw err
  }

  await env.DB.prepare(
    "INSERT INTO audit_logs (id, user_id, action, detail, created_at) VALUES (?, ?, 'invite.create', ?, ?)"
  )
    .bind(
      uuid(),
      user.id,
      `创建邀请码 ${code}${requested.length ? `（附加：${requested.map((f) => QUOTA_FEATURE_LABELS[f]).join("、")}）` : ""}`,
      now
    )
    .run()

  const row = await env.DB.prepare("SELECT * FROM invite_codes WHERE id = ?")
    .bind(id)
    .first<InviteRow>()

  const quota = await loadUserQuota(env, user.id)
  return json({ invite: toPublicInvite(row!), quota }, 201)
}

/**
 * DELETE /api/my-invites/:id —— 删除自己创建的邀请码
 * 仅当从未被使用过时退还额度（防止「建码→用掉→删码→再建」循环刷额度）。
 */
export async function deleteMyInvite(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const user = await requireUser(env, request)

  const row = await env.DB.prepare("SELECT * FROM invite_codes WHERE id = ?")
    .bind(id)
    .first<InviteRow>()

  // 只能删自己创建的（管理员走管理端接口）
  if (!row || row.created_by !== user.id) {
    throw new ApiError(404, "邀请码不存在", "NOT_FOUND")
  }

  if (row.used_count === 0) {
    // ⚠️ 2026-09-25 审计（L25）：这里原先写的是
    // `quotaFeaturesOf(parsePermissions(row.permissions))`，而
    // `parsePermissions(null)` 的语义是「全开」——于是删掉一个 permissions 为
    // NULL 的历史码会一次退还全部 4 个模块额度，「建码→删码」即可凭空刷额度。
    // 退还必须保守：只认库里明确写着 true 的模块。
    await refundQuotaForInvite(env, user.id, quotaFeaturesFromStored(row.permissions))
  }

  await env.DB.prepare("DELETE FROM invite_codes WHERE id = ?").bind(id).run()

  const quota = await loadUserQuota(env, user.id)
  return json({ quota, refunded: row.used_count === 0 })
}
