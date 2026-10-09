/**
 * 账号监管：封禁申诉 + 风险账户。
 *
 * 两块东西放在一起，是因为它们在管理面板里同属「监管」栏目：
 *   · account_appeals —— 被封禁用户提交的申诉（管理端处理，通过即解封）
 *   · risk_accounts   —— 定时任务扫出来的风险账号（机制见 risk-scan.ts）
 *
 * ⚠️ 申诉接口必须是**公开**的：被封禁用户 status='suspended'，login 直接 403，
 * 他拿不到任何会话。所以这里用「用户名 + 正文」提交，不依赖登录态。
 */
import { ApiError, json, assertContentLengthWithin } from "../http"
import { requireAdminScope } from "./admin"
import { requireUser, loadPendingReply } from "../auth"
import { clientIp, guardRateLimit } from "../ratelimit"
import { audit } from "../settings"
import { uuid } from "../crypto"
import { isNewApiConfigured, adminSetUserStatus } from "../newapi-client"
import type { Env } from "../env"

const MAX_BODY_BYTES = 8 * 1024

// ---- 用户端：提交申诉 ----

/**
 * POST /api/appeal —— 提交封禁申诉（公开）。
 *
 * 只允许「当前确实处于 suspended」的账号提交：否则这个接口等于给所有人
 * 开了一个公开留言板，会被拿来发广告。
 */
export async function submitAppeal(env: Env, request: Request): Promise<Response> {
  // 限流按 IP：5 次/小时。正常用户申诉一次就够，反复提交只会刷屏
  await guardRateLimit(env, `appeal:ip:${clientIp(request)}`, 5, 3600, "提交过于频繁，请稍后再试")
  assertContentLengthWithin(request, MAX_BODY_BYTES, "内容过长")

  const body = (await request.json().catch(() => ({}))) as {
    username?: unknown
    identifier?: unknown
    contact?: unknown
    content?: unknown
  }
  /**
   * 账号标识：**用户名或邮箱**都行（2026-10-02 起）。
   *
   * 为什么加邮箱：被封禁的人往往是「只记得自己注册时用的邮箱」，用户名可能
   * 是随手打的（如 `a8f3k2`），填错一次就被 404 挡回去，只能放弃申诉。
   * `identifier` 是新字段名（语义准确），`username` 保留兼容老前端。
   */
  const identifier = String(body.identifier ?? body.username ?? "")
    .trim()
    .slice(0, 128)
  const contact = String(body.contact ?? "").trim().slice(0, 128)
  const content = String(body.content ?? "").trim().slice(0, 2000)

  if (!identifier || !content) {
    throw new ApiError(400, "请填写账号（用户名或邮箱）和申诉说明", "INVALID_INPUT")
  }
  if (content.length < 10) {
    throw new ApiError(400, "申诉说明太短，请把情况写清楚（至少 10 个字）", "INVALID_INPUT")
  }

  const user = await env.DB.prepare(
    "SELECT id, username, status FROM users " +
      "WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE"
  )
    .bind(identifier, identifier)
    .first<{ id: string; username: string; status: string }>()

  /**
   * 🔴 不区分「账号不存在」与「账号未被封禁」（2026-10-09 渗透测试 finding#8）。
   *
   * 原实现是两条分支：查不到 → `404 NOT_FOUND`；查到但状态正常 → `400 NOT_SUSPENDED`。
   * 响应码不同，于是一个**公开**接口变成了账号枚举器 —— 实测可据此判定
   * `doulor` / `aeson` 存在而 `admin` / `root` 不存在，为口令喷洒、定向钓鱼提供目标清单。
   *
   * 现在两种情况返回**同一个响应**（同码同文案），外部无法分辨；
   * 只有「确实处于 suspended」的账号才真正受理申诉。
   * ⚠️ 保留 200（受理成功）与 400（不受理）的区别是业务必需 —— 它只暴露
   * 「该账号是否被封禁」，不暴露「该账号是否存在」。
   */
  if (!user || user.status !== "suspended") {
    throw new ApiError(
      400,
      "无法为该账号提交申诉：请核对用户名或邮箱是否填写正确；若账号状态正常则无需申诉。",
      "APPEAL_NOT_ACCEPTED"
    )
  }

  const now = new Date().toISOString()
  const id = uuid()
  await env.DB.prepare(
    `INSERT INTO account_appeals (id, user_id, username, contact, content, status, ip, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
  )
    // 存**真实用户名**而不是用户填的标识：管理端列表里才不会出现「邮箱」这种半截值
    .bind(id, user.id, user.username, contact || null, content, clientIp(request), now)
    .run()

  await audit(env, user.id, "appeal.submit", `账号申诉：${user.username}`)
  return json({ ok: true, id })
}

// ---- 管理端：申诉处理 ----

/** GET /api/admin/appeals —— 申诉列表（待处理在前） */
export async function listAppeals(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "moderation.appeals")
  const rows = await env.DB.prepare(
    `SELECT a.id, a.user_id, a.username, a.contact, a.content, a.status,
            a.review_note, a.reviewed_by, a.ip, a.created_at, a.reviewed_at,
            u.status AS user_status
       FROM account_appeals a
       LEFT JOIN users u ON u.id = a.user_id
      ORDER BY CASE a.status WHEN 'pending' THEN 0 ELSE 1 END, a.created_at DESC
      LIMIT 200`
  ).all<{
    id: string
    user_id: string | null
    username: string
    contact: string | null
    content: string
    status: string
    review_note: string | null
    reviewed_by: string | null
    ip: string | null
    created_at: string
    reviewed_at: string | null
    user_status: string | null
  }>()

  return json({
    appeals: (rows.results ?? []).map((r) => ({
      id: r.id,
      userId: r.user_id,
      username: r.username,
      contact: r.contact,
      content: r.content,
      status: r.status,
      reviewNote: r.review_note,
      reviewedBy: r.reviewed_by,
      ip: r.ip,
      createdAt: r.created_at,
      reviewedAt: r.reviewed_at,
      /** 该账号当前在 cloud 侧的状态（suspended = 仍在封禁中） */
      userStatus: r.user_status,
    })),
  })
}

/**
 * POST /api/admin/appeals/:id/review —— 处理申诉。
 *
 * action = accept（通过，解封）/ reject（驳回）
 * 通过时会**同步启用 NewAPI 账户**（封禁时禁过，解封要还回去）——
 * 复用与 updateUser 同一套逻辑，保持两条路径行为一致。
 */
export async function reviewAppeal(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireAdminScope(env, request, "moderation.appeals")
  assertContentLengthWithin(request, MAX_BODY_BYTES, "内容过长")
  const body = (await request.json().catch(() => ({}))) as {
    action?: unknown
    note?: unknown
  }
  const action = String(body.action ?? "")
  const note = String(body.note ?? "").trim().slice(0, 300)
  if (action !== "accept" && action !== "reject") {
    throw new ApiError(400, "请指定处理方式（accept / reject）", "INVALID_INPUT")
  }

  const appeal = await env.DB.prepare(
    "SELECT id, user_id, username, status FROM account_appeals WHERE id = ?"
  )
    .bind(id)
    .first<{ id: string; user_id: string | null; username: string; status: string }>()
  if (!appeal) throw new ApiError(404, "申诉不存在", "NOT_FOUND")
  if (appeal.status !== "pending") {
    throw new ApiError(400, "这条申诉已经处理过了", "ALREADY_REVIEWED")
  }

  const now = new Date().toISOString()
  const nextStatus = action === "accept" ? "accepted" : "rejected"

  // 通过 → 解封（只解「当前仍是 suspended」的，避免把管理员后来的手动操作覆盖掉）
  let unblocked = false
  if (action === "accept" && appeal.user_id) {
    const res = await env.DB.prepare(
      "UPDATE users SET status = 'active', updated_at = ? WHERE id = ? AND status = 'suspended'"
    )
      .bind(now, appeal.user_id)
      .run()
    unblocked = (res.meta?.changes ?? 0) > 0

    if (unblocked) {
      // NewAPI 侧同步启用：失败不阻断（cloud 侧解封已生效），只记审计
      const account = await env.DB.prepare(
        "SELECT newapi_user_id FROM newapi_accounts WHERE user_id = ?"
      )
        .bind(appeal.user_id)
        .first<{ newapi_user_id: number }>()
      if (account && (await isNewApiConfigured(env))) {
        try {
          await adminSetUserStatus(env, account.newapi_user_id, "enable")
          await audit(
            env,
            appeal.user_id,
            "admin.newapi.activate",
            `申诉通过 → NewAPI 账户 #${account.newapi_user_id} 已同步启用`
          )
        } catch (err) {
          await audit(
            env,
            appeal.user_id,
            "admin.newapi.sync_failed",
            `申诉通过已解封，但 NewAPI 账户 #${account.newapi_user_id} 启用失败：${
              err instanceof Error ? err.message : String(err)
            }`
          )
        }
      }
    }
  }

  await env.DB.prepare(
    `UPDATE account_appeals
        SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ?
      WHERE id = ?`
  )
    .bind(nextStatus, note || null, admin.id, now, id)
    .run()

  await audit(
    env,
    admin.id,
    "appeal.review",
    `${action === "accept" ? "通过" : "驳回"}账号申诉：${appeal.username}` +
      (action === "accept" && !unblocked ? "（该账号当前不是封禁状态，未改动）" : "")
  )

  return json({ ok: true, status: nextStatus, unblocked })
}

// ---- 用户端：申诉回复的「强制已读」确认（2026-10-02）----

/**
 * GET /api/appeal/pending-reply —— 取「有管理员回复、但用户还没确认看过」的申诉。
 *
 * 两种命中路径：
 *   1. 登录响应里的 `pendingReply`（auth.ts 的 login 已带上）；
 *   2. 已登录用户在前端主动拉一次 —— 这是**补发**通道：老用户早就解封、
 *      当时也没看到回复，这次打开页面就会命中，前端据此弹强制确认框。
 */
export async function getPendingAppealReply(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  return json({ reply: await loadPendingReply(env, user.id) })
}

/**
 * POST /api/appeal/acknowledge —— 用户确认「已看过管理员的申诉回复」。
 *
 * body: { appealId?: string, choice?: string }
 *   · appealId 省略时，自动定位「最新一条有回复且未读」的申诉（与弹窗数据同源）；
 *   · choice 是用户在弹窗里勾的那一项：`understood` / `unclear`。
 *
 * 🚨 **只有 `choice === "understood"` 才会写 `note_read_at`**（站长要求「必须勾第一个」）。
 *    勾第二个只是留痕（管理员能在审计里看到「这人自称没明白」），不解除弹窗；
 *    用户随时可以改成勾第一个、再点确认 —— 所以不会有人被永久卡住。
 *
 * 幂等：`note_read_at IS NULL` 条件保证重复提交只写一次时间戳。
 */
export async function acknowledgeAppealNote(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  assertContentLengthWithin(request, MAX_BODY_BYTES, "内容过长")
  const body = (await request.json().catch(() => ({}))) as {
    appealId?: unknown
    choice?: unknown
  }
  const appealId = String(body.appealId ?? "").trim()
  const choice = String(body.choice ?? "").trim().slice(0, 32)

  // 定位目标申诉：优先用前端传的 id，但必须校验「属于当前用户」，
  // 否则任何人拿别人的申诉 id 就能替别人标记已读（虽无实害，但不该留口子）。
  let id = ""
  if (appealId) {
    const row = await env.DB.prepare(
      "SELECT id FROM account_appeals WHERE id = ? AND user_id = ?"
    )
      .bind(appealId, user.id)
      .first<{ id: string }>()
    if (!row) throw new ApiError(404, "未找到这条申诉", "NOT_FOUND")
    id = row.id
  } else {
    const pending = await loadPendingReply(env, user.id)
    if (!pending) return json({ ok: true, nothing: true })
    id = pending.id
  }

  const understood = choice === "understood"
  const now = new Date().toISOString()
  if (understood) {
    await env.DB.prepare(
      "UPDATE account_appeals SET note_read_at = ? WHERE id = ? AND note_read_at IS NULL"
    )
      .bind(now, id)
      .run()
  }

  await audit(
    env,
    user.id,
    "appeal.ack",
    understood
      ? `确认已读申诉回复（已明白并承诺不再违规）：${user.username}`
      : `用户在强制弹窗里勾选了「未明白且未联系管理员」，回复仍未标记已读：${user.username}`
  )
  return json({ ok: true, read: understood })
}

// ---- 管理端：风险账户 ----

/** GET /api/admin/risk-accounts —— 风险账户列表 */
export async function listRiskAccounts(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "moderation.risk")
  const rows = await env.DB.prepare(
    `SELECT r.user_id, r.username, r.risk_level, r.score, r.reasons, r.peak_per_min,
            r.requests_7d, r.first_seen_at, r.last_seen_at, r.status,
            u.status AS user_status
       FROM risk_accounts r
       LEFT JOIN users u ON u.id = r.user_id
      ORDER BY CASE r.status WHEN 'open' THEN 0 ELSE 1 END, r.score DESC, r.last_seen_at DESC
      LIMIT 300`
  ).all<{
    user_id: string
    username: string
    risk_level: string
    score: number
    reasons: string | null
    peak_per_min: number
    requests_7d: number
    first_seen_at: string
    last_seen_at: string
    status: string
    user_status: string | null
  }>()

  return json({
    accounts: (rows.results ?? []).map((r) => ({
      userId: r.user_id,
      username: r.username,
      riskLevel: r.risk_level,
      score: r.score,
      /** JSON 字符串（数组）；前端解析后逐条展示 */
      reasons: r.reasons,
      peakPerMin: r.peak_per_min,
      requests7d: r.requests_7d,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      status: r.status,
      userStatus: r.user_status,
    })),
  })
}

/** POST /api/admin/risk-accounts/:userId/status —— 更新风险记录状态（watching/banned/cleared） */
export async function updateRiskStatus(
  env: Env,
  request: Request,
  userId: string
): Promise<Response> {
  const admin = await requireAdminScope(env, request, "moderation.risk")
  assertContentLengthWithin(request, MAX_BODY_BYTES, "内容过长")
  const body = (await request.json().catch(() => ({}))) as { status?: unknown }
  const status = String(body.status ?? "")
  if (!["open", "watching", "banned", "cleared"].includes(status)) {
    throw new ApiError(400, "状态不合法", "INVALID_INPUT")
  }
  const res = await env.DB.prepare(
    "UPDATE risk_accounts SET status = ?, updated_at = ? WHERE user_id = ?"
  )
    .bind(status, new Date().toISOString(), userId)
    .run()
  if ((res.meta?.changes ?? 0) === 0) {
    throw new ApiError(404, "风险记录不存在", "NOT_FOUND")
  }
  await audit(env, admin.id, "risk.status", `风险账户 ${userId} 标记为 ${status}`)
  return json({ ok: true })
}

// ---- 角标计数（供 /api/attention）----

/**
 * 待处理申诉数。
 *
 * ⚠️ 内部吞异常返回 0：`account_appeals` 是 0096 才加的表，万一线上漏执行迁移，
 * 这里必须退化成「没有待办」—— 绝不能把整个 `/api/attention` 带崩
 * （它一挂，侧边栏角标和管理后台入口就一起没了）。同理见 dns-audit.ts。
 */
export async function countPendingAppeals(env: Env): Promise<number> {
  try {
    const r = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM account_appeals WHERE status = 'pending'"
    ).first<{ c: number }>()
    return Number(r?.c ?? 0)
  } catch {
    return 0
  }
}
