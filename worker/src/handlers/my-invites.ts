/**
 * 用户自助创建邀请码。
 *
 * 与管理员创建的区别：
 *   * 只能创建「自己用」，权限受额度限制
 *   * 基础权限固定含「个人名片」（域名/邮箱本就不受限，无需授权）
 *   * 附加 r2 / ai / frp / proxy 会消耗对应模块的转授额度
 *   * 每个码只能用一次（max_uses = 1）—— 额度语义即「能拉几个人」
 *
 * 额度来源见 quotas.ts：基础 3 个 + 每笔获批捐献 +2，且捐献对应模块 +1。
 */
import { ApiError, json } from "../http"
import { uuid } from "../crypto"
import { requireUser } from "../auth"
import { parsePermissions, type Permissions } from "../permissions"
import {
  QUOTA_FEATURES,
  QUOTA_FEATURE_LABELS,
  loadUserQuota,
  consumeQuotaForInvite,
  refundQuotaForInvite,
  quotaFeaturesOf,
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

/** 基础权限：仅个人名片（其余模块需消耗额度） */
function basePermissions(): Permissions {
  return {
    r2: false,
    ai: false,
    frp: false,
    profile: true,
    proxy: false,
  }
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

  return json({
    quota,
    invites: (rows.results ?? []).map(toPublicInvite),
    // 前端据此渲染权限勾选项与余额
    featureLabels: QUOTA_FEATURE_LABELS,
    quotaFeatures: QUOTA_FEATURES,
  })
}

/**
 * POST /api/my-invites —— 创建邀请码
 * body: { code?, features?: QuotaFeature[] }
 *   features 省略 → 只含基础权限（个人名片），不消耗模块额度
 */
export async function createMyInvite(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json().catch(() => ({}))) as {
    code?: unknown
    features?: unknown
  }

  // 权限：基础 + 用户勾选的模块
  const perms = basePermissions()
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
    if (!/^[A-Z0-9_-]{3,32}$/.test(code)) {
      throw new ApiError(400, "邀请码只能包含大写字母、数字、- 和 _（3-32 位）", "INVALID_CODE")
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
    await refundQuotaForInvite(env, user.id, quotaFeaturesOf(parsePermissions(row.permissions)))
  }

  await env.DB.prepare("DELETE FROM invite_codes WHERE id = ?").bind(id).run()

  const quota = await loadUserQuota(env, user.id)
  return json({ quota, refunded: row.used_count === 0 })
}
