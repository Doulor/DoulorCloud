/**
 * 管理端「通知」：站长给单个/多个用户发通知，可要求强制已读；
 * 可选「确认收到前禁用某些模块权限（如 AI 中转站，同步禁用 NewAPI 账户）」，
 * 用户确认收到后自动还原权限 + 重新启用 NewAPI。
 *
 * 2026-10-04 扩展「捐献门槛」：勾选后可要求用户**捐献指定渠道**
 * （wb 反代账号 / 内网穿透 / 代理节点）才解锁 —— 用户点「确认收到」时
 * 若还没捐，权限**保持锁定**、通知也不会标记已读（否则弹窗消失、用户再也不知道要去捐）。
 * 捐完点「我已捐献，重新检测」再走同一个 ack 接口即可解锁。
 *
 * 用户侧弹窗仿照 `appeal-ack-dialog.tsx`（封禁解除后的强制已读窗）。
 *
 * 接口：
 *   · POST /admin/notices            —— 发送（requireAdmin）
 *   · GET  /admin/notices            —— 列表（requireAdmin）
 *   · POST /admin/notices/revoke     —— 撤回（requireAdmin，自动还原权限）
 *   · GET  /api/notice/pending       —— 当前用户未确认的通知（requireUser）
 *   · POST /api/notice/ack           —— 确认收到（requireUser，满足门槛才还原权限）
 */
import { ApiError, json, readBodyCapped } from "../http"
import { requireUser } from "../auth"
import { requireAdminScope } from "./admin"
import { isUsernameWhitelisted } from "./moderation-lists"
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
  require_donation: string | null
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
 * 可要求的捐献渠道。
 *
 * · `wb`    —— 绑定 WorkBuddy 反代账号（`wb2api_bindings.status = 'active'`）
 * · `frp`   —— 捐献内网穿透（`donations.type = 'frp'` 且已批准）
 * · `proxy` —— 捐献代理节点（`donations.type = 'proxy'` 且已批准）
 *
 * ⚠️ `ai` / `sensenova`（捐献 AI 渠道）**刻意不在列表里** —— 那种捐献
 * 映射到的正是它们要解锁的 `ai` 权限，做成门槛会自相矛盾（捐了才解锁、
 * 而捐了就已经解锁了）。门槛只用来要求「用户实际贡献资源」。
 */
export const DONATION_CHANNELS = ["wb", "frp", "proxy"] as const
export type DonationChannel = (typeof DONATION_CHANNELS)[number]

/** 取合法捐献渠道名（去重、保持 DONATION_CHANNELS 的顺序） */
function normalizeDonationChannels(input: unknown): DonationChannel[] {
  if (!Array.isArray(input)) return []
  const wanted = new Set(input.filter((x): x is string => typeof x === "string"))
  return DONATION_CHANNELS.filter((c) => wanted.has(c))
}

/** 解析库里存的 require_donation（JSON 数组；损坏则视为「无要求」，宁可放行） */
function parseDonationChannels(raw: string | null | undefined): DonationChannel[] {
  if (!raw) return []
  try {
    return normalizeDonationChannels(JSON.parse(raw))
  } catch {
    return []
  }
}

/**
 * 检查用户是否已满足捐献门槛。
 *
 * ⚠️ 判定口径必须与「捐献生效」的既有逻辑一致，否则会出现
 * 「捐献明明批了但通知说没捐」。三个渠道各自的判据：
 *   · wb    查 `wb2api_bindings`（**不区分 realm**，国内版国际版都算，站长明确）
 *   · frp   / proxy 查 `donations.type + status = 'approved'`
 *
 * 语义是**任选其一**：`missing` 为空即满足。
 */
async function checkDonation(
  env: Env,
  userId: string,
  channels: DonationChannel[]
): Promise<{ satisfied: boolean; missing: DonationChannel[] }> {
  if (channels.length === 0) return { satisfied: true, missing: [] }

  const missing: DonationChannel[] = []
  for (const ch of channels) {
    if (ch === "wb") {
      const row = await env.DB.prepare(
        "SELECT 1 AS x FROM wb2api_bindings WHERE user_id = ? AND status = 'active' LIMIT 1"
      )
        .bind(userId)
        .first<{ x: number }>()
      if (!row) missing.push(ch)
    } else {
      const row = await env.DB.prepare(
        "SELECT 1 AS x FROM donations WHERE user_id = ? AND type = ? AND status = 'approved' LIMIT 1"
      )
        .bind(userId, ch)
        .first<{ x: number }>()
      if (!row) missing.push(ch)
    }
  }
  return { satisfied: missing.length === 0, missing }
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

/** 还原权限 + 重新启用 NewAPI（满足门槛后确认收到 / 撤回时调用） */
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

/**
 * GET /api/notice/pending —— 当前用户未确认、未撤回的通知（强制弹窗用它）。
 *
 * 附带实时计算的捐献门槛状态：前端据此决定弹窗是「确认收到」还是
 * 「还需捐献 X」。**每次现算**而不缓存 —— 用户刚捐完就刷新页面的场景下，
 * 缓存会让他看到过期的「未捐献」。
 */
export async function pendingNotices(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const rows = await env.DB.prepare(
    `SELECT id, title, body, created_at, require_donation
       FROM admin_notices
      WHERE user_id = ? AND require_ack = 1 AND read_at IS NULL AND revoked_at IS NULL
      ORDER BY created_at ASC`
  )
    .bind(user.id)
    .all<{
      id: string
      title: string
      body: string
      created_at: string
      require_donation: string | null
    }>()

  const notices = []
  for (const r of rows.results ?? []) {
    const required = parseDonationChannels(r.require_donation)
    const { missing } = await checkDonation(env, user.id, required)
    notices.push({
      id: r.id,
      title: r.title,
      body: r.body,
      createdAt: r.created_at,
      donationRequired: required,
      donationMissing: missing,
    })
  }
  return json({ notices })
}

/**
 * POST /api/notice/ack —— 确认收到。
 *
 * 若该通知要求捐献且**尚未满足**：不改任何权限、**也不写 read_at**
 * （弹窗必须继续拦着，否则用户点一下就再也看不到要去捐献这件事），
 * 返回 `{ ok: false, donationRequired: { required, missing } }`，前端切到
 * 「还需捐献」态并显示「我已捐献，重新检测」。用户捐完再点即走这里通过。
 */
export async function ackNotice(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = await readJson(request)
  const id = String(body.id ?? "").trim()
  if (!id) throw new ApiError(400, "缺少通知 id", "INVALID_INPUT")

  const notice = await env.DB.prepare("SELECT * FROM admin_notices WHERE id = ? AND user_id = ?")
    .bind(id, user.id)
    .first<NoticeRow>()
  if (!notice) throw new ApiError(404, "通知不存在", "NOT_FOUND")
  if (notice.read_at) return json({ ok: true, unlocked: true }) // 幂等

  // 捐献门槛：未满足则原地阻塞
  const required = parseDonationChannels(notice.require_donation)
  if (required.length > 0) {
    const { satisfied, missing } = await checkDonation(env, user.id, required)
    if (!satisfied) {
      await recordAudit(
        env,
        user.id,
        "notice.ack_blocked",
        `确认通知「${notice.title}」被捐献门槛拦住，还缺：${missing.join("、")}`
      )
      return json({ ok: false, donationRequired: { required, missing } })
    }
  }

  await restoreUserFeatures(env, notice)
  await env.DB.prepare("UPDATE admin_notices SET read_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), id)
    .run()
  await recordAudit(env, user.id, "notice.ack", `确认收到通知「${notice.title}」`)
  return json({ ok: true, unlocked: true })
}

// ---------------- 管理端 ----------------

/** POST /admin/notices —— 发送通知 */
export async function sendNotice(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "notices")
  const body = await readJson(request)
  const usernames = Array.isArray(body.usernames)
    ? (body.usernames as unknown[]).map(String).map((s) => s.trim()).filter(Boolean)
    : []
  const title = String(body.title ?? "").trim()
  const text = String(body.body ?? "").trim()
  if (usernames.length === 0) throw new ApiError(400, "请指定接收用户", "INVALID_INPUT")
  if (!title || !text) throw new ApiError(400, "标题和正文不能为空", "INVALID_INPUT")

  const restrictFeatures = normalizeFeatures(body.restrictFeatures)
  const requireDonation = normalizeDonationChannels(body.requireDonation)

  /**
   * 要求捐献时**必须**同时禁用 ai 权限 —— 否则「解锁」无从谈起：
   * 没有锁过任何东西，弹窗却关不掉，用户凭空被罚。
   * 前端已做联动禁用，这里是后端兜底（配置错误不能落库）。
   */
  if (requireDonation.length > 0 && !restrictFeatures.includes("ai")) {
    restrictFeatures.push("ai")
  }

  const now = new Date().toISOString()
  const sent: string[] = []
  const missing: string[] = []
  /** 白名单用户：通知照发，但不动权限（见下方注释） */
  const whitelisted: string[] = []
  /** 已满足捐献门槛的用户：整条跳过（见下方注释） */
  const alreadyDonated: string[] = []
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

    /**
     * 名单可能过时 —— 已满足捐献门槛的用户**整条跳过**
     * （2026-10-04 站长要求：「防止因为名单过时导致的误封」）。
     *
     * 场景：站长拿一份「没捐 wb」的名单去发通知，但名单生成之后有人已经捐了。
     * 若照发照锁：① 会给他发一条「请去捐献 wb」的通知 —— 但他已经捐了，
     * 这是**错误指控**；② 还会把明明有资格的人的中转站锁掉。
     * 所以这里在写库**之前**实时复查一遍：已满足就直接跳过，
     * 既不发通知也不动权限，并把他单独列进 `alreadyDonated` 让站长知道名单过时了。
     *
     * ⚠️ 判据与 `ackNotice` 完全一致（同一个 `checkDonation`）：
     *    勾了多个渠道时是「任选其一」—— 只要满足其中之一就跳过。
     */
    if (requireDonation.length > 0) {
      const { satisfied } = await checkDonation(env, target.id, requireDonation)
      if (satisfied) {
        alreadyDonated.push(username)
        continue
      }
    }

    /**
     * 白名单豁免（2026-10-04，站长要求「保持白名单状态」）。
     *
     * 白名单的语义是「这个账号不会被平台处置」。封禁路径早已豁免
     * （admin.ts::updateUser 在写库前拦），但**通知限权是另一条独立的
     * 处置路径**，原先没查白名单 —— 结果是「白名单用户照样被限权」，
     * 与白名单的存在意义矛盾。这里补上：**通知照常送达**（他仍需知道
     * 发生了什么事），但**不碰他的权限**。
     */
    const isWhite = await isUsernameWhitelisted(env, username)
    if (isWhite) whitelisted.push(username)

    let restore: string | null = null
    let newapiDisabled = false
    if (restrictFeatures.length > 0 && !isWhite) {
      const r = await restrictUserFeatures(env, target.id, restrictFeatures)
      restore = r.restore
      newapiDisabled = r.newapiDisabled
      if (r.restore) restricted++
    }

    await env.DB.prepare(
      `INSERT INTO admin_notices
         (id, user_id, title, body, require_ack, restrict_features, restore_permissions, newapi_disabled, require_donation, created_by, created_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        uuid(),
        target.id,
        title,
        text,
        restrictFeatures.length ? JSON.stringify(restrictFeatures) : null,
        restore,
        newapiDisabled ? 1 : 0,
        requireDonation.length ? JSON.stringify(requireDonation) : null,
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
    `给 ${sent.length} 人发通知「${title}」，限制权限 ${restricted} 人` +
      `${requireDonation.length ? `，要求捐献 ${requireDonation.join("/")}` : ""}` +
      `${alreadyDonated.length ? `，已捐献跳过 ${alreadyDonated.length} 人` : ""}` +
      `${whitelisted.length ? `，白名单跳过限权 ${whitelisted.length} 人` : ""}` +
      `${missing.length ? `，未找到 ${missing.length} 人` : ""}`
  )

  return json({
    sent,
    missing,
    restricted,
    whitelisted,
    alreadyDonated,
    requireDonation,
  })
}

/** GET /admin/notices —— 通知列表 */
export async function listNotices(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "notices")
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
      requireDonation: parseDonationChannels(r.require_donation),
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
  const admin = await requireAdminScope(env, request, "notices")
  const body = await readJson(request)
  const id = String(body.id ?? "").trim()
  if (!id) throw new ApiError(400, "缺少通知 id", "INVALID_INPUT")

  const notice = await env.DB.prepare("SELECT * FROM admin_notices WHERE id = ?")
    .bind(id)
    .first<NoticeRow>()
  if (!notice) throw new ApiError(404, "通知不存在", "NOT_FOUND")

  // 撤回 = 站长主动放弃这次要求 ⇒ **无条件**还原（哪怕捐献门槛没满足）
  if (!notice.read_at && !notice.revoked_at) {
    await restoreUserFeatures(env, notice)
  }
  await env.DB.prepare("UPDATE admin_notices SET revoked_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), id)
    .run()
  await recordAudit(env, admin.id, "notice.revoke", `撤回通知「${notice.title}」`)
  return json({ ok: true })
}
