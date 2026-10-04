/**
 * 权限兑换码接口。
 *
 *   GET  /api/vouchers        我持有的未使用券 + 可选的权限项（含是否已拥有）
 *   POST /api/vouchers/redeem 兑换（code 可以是券码，也可以是别人给的邀请码）
 */
import { ApiError, json } from "../http"
import { requireUser } from "../auth"
import { guardRateLimit } from "../ratelimit"
import { FEATURES, FEATURE_LABELS } from "../permissions"
import {
  featuresInInvite,
  getAllowedFirstDonationFeatures,
  loadPermissions,
  redeemInvite,
  redeemVoucher,
  type VoucherRow,
} from "../vouchers"
import type { Env } from "../env"

interface InviteForRedeem {
  id: string
  code: string
  created_by: string | null
  permissions: string | null
}

/**
 * GET /api/vouchers —— 我持有的「码」+ 可兑模块。
 *
 * ⚠️ 这里把**券**和**我创建的未用邀请码**合成一个 `codes` 列表返回。
 * 因为在产品语义上它们是同一种东西：都能发给别人（注册 / 补权限），
 * 也都能自己用（`redeem` 里不区分来源）。前端照一张列表渲染即可。
 */
export async function listMyVouchers(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)

  const [voucherRows, inviteRows, perms, allowed] = await Promise.all([
    env.DB.prepare(
      "SELECT * FROM vouchers WHERE owner_user_id = ? AND status = 'unused' ORDER BY created_at DESC"
    )
      .bind(user.id)
      .all<VoucherRow>(),
    env.DB.prepare(
      `SELECT id, code, permissions, created_at FROM invite_codes
        WHERE created_by = ?
          AND used_count < max_uses
          AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY created_at DESC LIMIT 50`
    )
      .bind(user.id, new Date().toISOString())
      .all<{
        id: string
        code: string
        permissions: string | null
        created_at: string
      }>(),
    loadPermissions(env, user.id),
    getAllowedFirstDonationFeatures(env),
  ])

  const codes = [
    ...(voucherRows.results ?? []).map((r) => ({
      id: r.id,
      code: r.code,
      kind: "voucher" as const,
      /** 自带模块；自选券为空，由使用者挑一个 */
      features: r.feature ? [r.feature] : [],
      selfSelect: r.feature === null,
      /** 能否转送别人 */
      transferable: r.transferable === 1,
      note: r.note,
      createdAt: r.created_at,
    })),
    ...(inviteRows.results ?? []).map((r) => ({
      id: r.id,
      code: r.code,
      kind: "invite" as const,
      features: featuresInInvite(r.permissions),
      selfSelect: false,
      // 邀请码天生就是发给别人的
      transferable: true,
      note: null,
      createdAt: r.created_at,
    })),
  ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))

  return json({
    codes,
    /**
     * 自选券的候选：带上是否已拥有，前端只列还没开的。
     *
     * `allowed` = 该模块当前是否在「首捐奖励券可兑换」范围内
     * （设置项 first_donation_voucher_features，默认全部）。
     * ⚠️ 它只约束**首捐券**这一条路；别人给的邀请码带什么权限由码自己决定，
     *    与这一列无关，所以前端不能拿 `allowed` 去过滤邀请码那部分。
     */
    features: FEATURES.map((f) => ({
      key: f,
      label: FEATURE_LABELS[f],
      owned: perms[f],
      allowed: allowed.has(f),
    })),
  })
}

/**
 * POST /api/vouchers/redeem
 * body: { code, feature? }   —— feature 只在「自选券」时需要
 *
 * code 先当券查，再当邀请码查：两条路都能「补齐权限」，
 * 用户不需要知道手里的码是哪一种。
 */
export async function redeem(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  // 码虽然随机，但仍是「猜了就有收益」的接口，加限流
  await guardRateLimit(env, `voucher:redeem:user:${user.id}`, 10, 300, "兑换过于频繁")

  const body = (await request.json().catch(() => ({}))) as {
    code?: unknown
    feature?: unknown
  }
  const code = String(body.code ?? "").trim().toUpperCase()
  const wanted =
    body.feature === undefined || body.feature === null ? null : String(body.feature)
  if (!code) throw new ApiError(400, "请填写兑换码", "CODE_REQUIRED")
  if (code.length > 64) throw new ApiError(400, "兑换码格式不正确", "INVALID_CODE")

  // ---- 1) 兑换券 ----
  const voucher = await env.DB.prepare(
    "SELECT * FROM vouchers WHERE code = ? COLLATE NOCASE LIMIT 1"
  )
    .bind(code)
    .first<VoucherRow>()
  if (voucher) {
    const result = await redeemVoucher(env, user, voucher, wanted)
    return json({ ok: true, kind: "voucher", ...result })
  }

  // ---- 2) 邀请码（别人给的，用来补齐自己缺的模块）----
  const invite = await env.DB.prepare(
    `SELECT id, code, created_by, permissions FROM invite_codes
      WHERE code = ? COLLATE NOCASE
        AND used_count < max_uses
        AND (expires_at IS NULL OR expires_at > ?)
      LIMIT 1`
  )
    .bind(code, new Date().toISOString())
    .first<InviteForRedeem>()
  if (invite) {
    const result = await redeemInvite(env, user, invite)
    return json({ ok: true, kind: "invite", ...result })
  }

  throw new ApiError(404, "兑换码无效、已失效或已用完", "INVALID_CODE")
}
