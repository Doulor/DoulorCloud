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
  created_at: string
}

/** 捐献类型 → 对应的功能权限 */
const DONATION_TYPES: Record<string, Feature> = {
  ai: "ai",
  frp: "frp",
  proxy: "proxy",
}

function toPublicDonation(row: DonationRow, username: string) {
  let payload = null
  try {
    payload = JSON.parse(row.payload)
  } catch {
    // fallthrough
  }
  return {
    id: row.id,
    type: row.type,
    username,
    payload,
    notifyEmail: row.notify_email,
    remark: row.remark,
    status: row.status,
    reviewNote: row.review_note,
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

/**
 * GET /api/donations —— 当前用户的捐献记录
 * 普通用户：只看自己的；管理员看全部
 */
export async function listDonations(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const isAdmin = user.role === "admin"

  const sql = isAdmin
    ? `SELECT d.*, u.username FROM donations d JOIN users u ON u.id = d.user_id ORDER BY d.created_at DESC`
    : `SELECT d.*, u.username FROM donations d JOIN users u ON u.id = d.user_id WHERE d.user_id = ? ORDER BY d.created_at DESC`

  const stmt = env.DB.prepare(sql)
  const query = isAdmin ? stmt : stmt.bind(user.id)
  const rows = await query.all<DonationRow & { username: string }>()

  return json({
    donations: (rows.results ?? []).map((r) => toPublicDonation(r, r.username)),
    types: Object.keys(DONATION_TYPES),
    typeLabels: Object.fromEntries(
      Object.entries(DONATION_TYPES).map(([t, f]) => [t, FEATURE_LABELS[f]])
    ),
    // 用户当前权限（前端据此判断哪些功能需要捐献）
    permissions: parsePermissions(user.permissions),
  })
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
  // 已经有该权限的用户不需要捐献
  const perms = parsePermissions(user.permissions)
  if (perms[feature]) {
    throw new ApiError(400, "你已拥有该功能权限，无需捐献", "ALREADY_PERMITTED")
  }

  // 校验 payload
  if (!body.payload || typeof body.payload !== "object") {
    throw new ApiError(400, "请填写资源详情", "INVALID_PAYLOAD")
  }

  const payloadStr = JSON.stringify(body.payload)
  if (payloadStr.length > 10000) {
    throw new ApiError(400, "资源详情过长", "TOO_LARGE")
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

  // 管理员邮件通知
  const adminRow = await env.DB.prepare(
    "SELECT value FROM app_settings WHERE key = 'frp_admin_notify_email'"
  )
    .first<{ value: string }>()
  const adminEmail = adminRow?.value?.trim() ?? ""

  if (adminEmail) {
    try {
      const lines = [
        `用户：${user.username}`,
        `捐献类型：${FEATURE_LABELS[feature]}`,
        `通知邮箱：${notifyEmail}`,
        body.remark ? `备注：${body.remark.trim().slice(0, 200)}` : "",
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

  return json({ id, status: "pending" }, 201)
}

/**
 * POST /api/admin/donations/review —— 管理员审核
 * body: { id, action: "approve" | "reject", note? }
 * 批准时自动解锁该用户对应功能的权限
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
    .first<DonationRow & { username: string; permissions: string | null }>()

  if (!app) throw new ApiError(404, "申请不存在", "NOT_FOUND")
  if (app.status !== "pending") {
    throw new ApiError(409, "该申请已被处理", "ALREADY_REVIEWED")
  }

  const approve = body.action === "approve"
  const note = (body.note ?? "").trim().slice(0, 500) || null
  const now = new Date().toISOString()
  const feature = DONATION_TYPES[app.type] as Feature

  if (approve) {
    // 解锁权限：把对应 feature 置为 true
    const perms = parsePermissions(app.permissions)
    perms[feature] = true
    const permsStr = JSON.stringify(perms)

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE donations SET status = 'approved', review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?`
      ).bind(note, admin.id, now, id),
      env.DB.prepare(
        "UPDATE users SET permissions = ?, updated_at = ? WHERE id = ?"
      ).bind(permsStr, now, app.user_id),
    ])
  } else {
    await env.DB.prepare(
      `UPDATE donations SET status = 'rejected', review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?`
    ).bind(note, admin.id, now, id).run()
  }

  await env.DB.prepare(
    "INSERT INTO audit_logs (id, user_id, action, detail, created_at) VALUES (?, ?, 'donation.review', ?, ?)"
  )
    .bind(
      uuid(),
      admin.id,
      `${app.username} 的${FEATURE_LABELS[feature]}捐献：${approve ? "批准" : "拒绝"}`,
      now
    )
    .run()

  // 通知申请人
  try {
    const lines = approve
      ? [
          `捐献类型：${FEATURE_LABELS[feature]}`,
          "你的捐献申请已通过审核，对应功能权限已解锁。",
          note ? `管理员备注：${note}` : "",
          "请到 Doulor Cloud 对应功能页面查看。",
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

  return json({ ok: true, status: approve ? "approved" : "rejected" })
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