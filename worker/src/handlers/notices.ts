/**
 * 管理端「通知」：站长给单个/多个用户发通知，可要求强制已读；
 * 可选「确认收到前禁用某些模块权限（如 AI 中转站，同步禁用 NewAPI 账户）」，
 * 用户确认收到后自动还原权限 + 重新启用 NewAPI。
 *
 * 用户侧弹窗仿照 `appeal-ack-dialog.tsx`（封禁解除后的强制已读窗）。
 *
 * 接口：
 *   · POST /admin/notices            —— 发送（requireAdmin）
 *   · GET  /admin/notices            —— 列表（requireAdmin）
 *   · POST /admin/notices/revoke     —— 撤回（requireAdmin，自动还原权限）
 *   · GET  /api/notice/pending       —— 当前用户未确认的通知（requireUser）
 *   · POST /api/notice/ack           —— 确认收到（requireUser，自动还原权限）
 */
import { ApiError, json, readBodyCapped } from "../http"
import { requireUser } from "../auth"
import { requireAdmin } from "./admin"
import { audit as recordAudit } from "../settings"
import { parsePermissions, FEATURES, type Permissions } from "../permissions"
import { isNewApiConfigured, adminSetUserStatus } from "../newapi-client"
import { uuid } from "../crypto"
import type { Env } from "../env"

interface NoticeRow {
  id: string
  user_id: string
  title: string
  body: string
  require_ack: number
  restrict_features: string | null
  restore_permissions: string | null
  newapi_disabled: number
  created_by: string | null
  created_at: string
  read_at: string | null
  revoked_at: string | null
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const buf = await readBodyCapped(request, 128 * 1024, "请求体过大")
  try {
    const parsed = JSON.parse(new TextDecoder().decode(buf))
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
  } catch {
    throw new ApiError(400, "请求格式不正确", "INVALID_JSON")
  }
}

/** 取合法模块名（只认 FEATURES 里的） */
function normalizeFeatures(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const out = new Set<string>()
  for (const x of input) {
    if (typeof x === "string" && (FEATURES as readonly string[]).includes(x)) out.add(x)
  }
  return [...out]
}

/**
 * 禁用某用户的若干模块权限（并联动 NewAPI）。返回还原快照（显式 JSON）。
 * 若目标模块本来就没开（或用户不存在），返回 null = 无需禁用、也无需还原。
 */
async function restrictUserFeatures(
  env: Env,
  userId: string,
  features: string[]
): Promise<{ restore: string | null; newapiDisabled: boolean }> {
  const row = await env.DB.prepare("SELECT permissions FROM users WHERE id = ?")
    .bind(userId)
    .first<{ permissions: string | null }>()
  if (!row) return { restore: null, newapiDisabled: false }

  const perms = parsePermissions(row.permissions)
  let changed = false
  for (const f of features) {
    if (perms[f as keyof Permissions] === true) {
      perms[f as keyof Permissions] = false
      changed = true
    }
  }
  if (!changed) return { restore: null, newapiDisabled: false }

  // 快照 = 禁用前的**显式**权限（还原时写回，语义与原来一致）
  const restore = JSON.stringify(parsePermissions(row.permissions))
  const now = new Date().toISOString()
  await env.DB.prepare("UPDATE users SET permissions = ?, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(perms), now, userId)
    .run()

  let newapiDisabled = false
  if (features.includes("ai")) {
    const acct = await env.DB.prepare("SELECT newapi_user_id FROM newapi_accounts WHERE user_id = ?")
      .bind(userId)
      .first<{ newapi_user_id: number }>()
    if (acct && (await isNewApiConfigured(env))) {
      try {
        await adminSetUserStatus(env, acct.newapi_user_id, "disable")
        newapiDisabled = true
      } catch (err) {
        await recordAudit(
          env,
          userId,
          "notice.newapi.disable_failed",
          `通知禁用中转站，但 NewAPI 账户 #${acct.newapi_user_id} 禁用失败：${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    }
  }
  return { restore, newapiDisabled }
}

/** 还原权限 + 重新启用 NewAPI（确认收到 / 撤回时调用） */
async function restoreUserFeatures(env: Env, notice: NoticeRow): Promise<void> {
  if (notice.restore_permissions) {
    await env.DB.prepare("UPDATE users SET permissions = ?, updated_at = ? WHERE id = ?")
      .bind(notice.restore_permissions, new Date().toISOString(), notice.user_id)
      .run()
  }
  if (notice.newapi_disabled === 1) {
    const acct = await env.DB.prepare("SELECT newapi_user_id FROM newapi_accounts WHERE user_id = ?")
      .bind(notice.user_id)
      .first<{ newapi_user_id: number }>()
    if (acct && (await isNewApiConfigured(env))) {
      try {
        await adminSetUserStatus(env, acct.newapi_user_id, "enable")
      } catch (err) {
        await recordAudit(
          env,
          notice.user_id,
          "notice.newapi.enable_failed",
          `通知确认后重新启用 NewAPI 账户 #${acct.newapi_user_id} 失败：${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    }
  }
}

// ---------------- 用户侧 ----------------

/** GET /api/notice/pending —— 当前用户未确认、未撤回的通知（强制弹窗用它） */
export async function pendingNotices(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const rows = await env.DB.prepare(
    `SELECT id, title, body, created_at
       FROM admin_notices
      WHERE user_id = ? AND require_ack = 1 AND read_at IS NULL AND revoked_at IS NULL
      ORDER BY created_at ASC`
  )
    .bind(user.id)
    .all<{ id: string; title: string; body: string; created_at: string }>()
  return json({
    notices: (rows.results ?? []).map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      createdAt: r.created_at,
    })),
  })
}

/** POST /api/notice/ack —— 确认收到；若带权限禁用，一并还原 */
export async function ackNotice(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = await readJson(request)
  const id = String(body.id ?? "").trim()
  if (!id) throw new ApiError(400, "缺少通知 id", "INVALID_INPUT")

  const notice = await env.DB.prepare("SELECT * FROM admin_notices WHERE id = ? AND user_id = ?")
    .bind(id, user.id)
    .first<NoticeRow>()
  if (!notice) throw new ApiError(404, "通知不存在", "NOT_FOUND")
  if (notice.read_at) return json({ ok: true }) // 幂等

  await restoreUserFeatures(env, notice)
  await env.DB.prepare("UPDATE admin_notices SET read_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), id)
    .run()
  await recordAudit(env, user.id, "notice.ack", `确认收到通知「${notice.title}」`)
  return json({ ok: true })
}

// ---------------- 管理端 ----------------

/** POST /admin/notices —— 发送通知 */
export async function sendNotice(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdmin(env, request)
  const body = await readJson(request)
  const usernames = Array.isArray(body.usernames)
    ? (body.usernames as unknown[]).map(String).map((s) => s.trim()).filter(Boolean)
    : []
  const title = String(body.title ?? "").trim()
  const text = String(body.body ?? "").trim()
  if (usernames.length === 0) throw new ApiError(400, "请指定接收用户", "INVALID_INPUT")
  if (!title || !text) throw new ApiError(400, "标题和正文不能为空", "INVALID_INPUT")
  const restrictFeatures = normalizeFeatures(body.restrictFeatures)

  const now = new Date().toISOString()
  const sent: string[] = []
  const missing: string[] = []
  let restricted = 0

  for (const username of usernames) {
    const target = await env.DB.prepare(
      "SELECT id FROM users WHERE username = ? COLLATE NOCASE"
    )
      .bind(username)
      .first<{ id: string }>()
    if (!target) {
      missing.push(username)
      continue
    }

    let restore: string | null = null
    let newapiDisabled = false
    if (restrictFeatures.length > 0) {
      const r = await restrictUserFeatures(env, target.id, restrictFeatures)
      restore = r.restore
      newapiDisabled = r.newapiDisabled
      if (r.restore) restricted++
    }

    await env.DB.prepare(
      `INSERT INTO admin_notices
         (id, user_id, title, body, require_ack, restrict_features, restore_permissions, newapi_disabled, created_by, created_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
    )
      .bind(
        uuid(),
        target.id,
        title,
        text,
        restrictFeatures.length ? JSON.stringify(restrictFeatures) : null,
        restore,
        newapiDisabled ? 1 : 0,
        admin.id,
        now
      )
      .run()
    sent.push(username)
  }

  await recordAudit(
    env,
    admin.id,
    "notice.send",
    `给 ${sent.length} 人发通知「${title}」，限制权限 ${restricted} 人${missing.length ? `，未找到 ${missing.length} 人` : ""}`
  )

  return json({ sent, missing, restricted })
}

/** GET /admin/notices —— 通知列表 */
export async function listNotices(env: Env, request: Request): Promise<Response> {
  await requireAdmin(env, request)
  const rows = await env.DB.prepare(
    `SELECT n.*, u.username, a.username AS creator
       FROM admin_notices n
       JOIN users u ON u.id = n.user_id
       LEFT JOIN users a ON a.id = n.created_by
      ORDER BY n.created_at DESC
      LIMIT 200`
  ).all<NoticeRow & { username: string; creator: string | null }>()
  return json({
    notices: (rows.results ?? []).map((r) => ({
      id: r.id,
      username: r.username,
      title: r.title,
      body: r.body,
      restrictFeatures: r.restrict_features ? JSON.parse(r.restrict_features) : [],
      newapiDisabled: r.newapi_disabled === 1,
      creator: r.creator,
      createdAt: r.created_at,
      readAt: r.read_at,
      revokedAt: r.revoked_at,
    })),
  })
}

/** POST /admin/notices/revoke —— 撤回（未确认则还原权限） */
export async function revokeNotice(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdmin(env, request)
  const body = await readJson(request)
  const id = String(body.id ?? "").trim()
  if (!id) throw new ApiError(400, "缺少通知 id", "INVALID_INPUT")

  const notice = await env.DB.prepare("SELECT * FROM admin_notices WHERE id = ?")
    .bind(id)
    .first<NoticeRow>()
  if (!notice) throw new ApiError(404, "通知不存在", "NOT_FOUND")

  if (!notice.read_at && !notice.revoked_at) {
    await restoreUserFeatures(env, notice)
  }
  await env.DB.prepare("UPDATE admin_notices SET revoked_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), id)
    .run()
  await recordAudit(env, admin.id, "notice.revoke", `撤回通知「${notice.title}」`)
  return json({ ok: true })
}
