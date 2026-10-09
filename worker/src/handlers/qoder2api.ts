/**
 * 捐献通道：Qoder2API-Hub 反代账号（登录即解锁 AI 权限）。
 *
 * 本文件**取代**原来的 handlers/cli2api.ts：上游从 cli2api 换成了 qoder2api-hub，
 * 但对用户而言功能完全一样 —— 捐献者在浏览器登录自己的 Qoder 账号 → 账号进共享池
 * → 自动解锁本站「AI 中转站」权限，免管理员审核。
 *
 * 与 wb2api 通道的关系：**并行的第二条同类通道**，不是同一张表也不是同一套接口。
 * 两者都是「登录上游账号 → 进池 → 解锁 ai」，流程形态也相近（start → poll → uid）；
 * 但 qoder2api 走面板会话鉴权、双区（cn/intl），且**不需要本站预建账号**，故独立实现。
 *
 * ⚠️ 与 cli2api 的一条关键差异（简化）：**账号由上游在授权成功那一刻才创建**，
 * 所以不存在「用户中途放弃 → 上游留个登录不上的僵尸账号」的问题，
 * 原来那套 `discardSessionAccount` 不需要了 —— 失败时只需取消上游 state。
 *
 * 权限回收的准确性同 wb2api：用户的 `ai` 可能来自 ①本通道 ②donations 的 ai 捐献
 * ③邀请码注册时带的权限（③无法溯源）。因此移除绑定时按「有依据就不收回」实时判定，
 * 管理端留人工覆盖开关。
 */
import { ApiError, json } from "../http"
import { requireAdminScope } from "./admin"
import { generateToken, hashToken, uuid } from "../crypto"
import { requireUser, type UserRow } from "../auth"
import {
  parsePermissions,
  featurePermissionSql,
  featurePermittedGuard,
  notWhitelistedGuard,
} from "../permissions"
import { audit, getSetting, getSettingBool, getSettingNumber } from "../settings"
import { clientIp, guardRateLimit } from "../ratelimit"
import { donationRewardLabel, grantDonationReward, isDonationRewardKind } from "../points"
import {
  Q2UnauthorizedError,
  Q2UpstreamError,
  getQoder2ApiCredentialInfo,
  isQoder2ApiConfigured,
  normalizeRealm,
  q2CancelLogin,
  q2DeleteAccount,
  q2ListAccounts,
  q2PollLogin,
  q2StartLogin,
  saveQoder2ApiPassword,
  type Qoder2ApiRealm,
} from "../qoder2api-client"
import { grantInviteReward } from "../invite-rewards"
import type { Env } from "../env"

/**
 * 本站登录会话有效期。
 * 上游设备授权窗口是 **10 分钟**（LOGIN_TTL_SECONDS=600），比原来 cli2api 的 15 分钟短，
 * 这里对齐 10 分钟：超时后本站直接判失败，不再去轮询一个已经死掉的 state。
 */
const SESSION_TTL_MS = 10 * 60 * 1000

/** 绑定档位（用于捐献奖励）：上游固定是 Qoder */
const PROVIDER = "qoder"

interface BindingRow {
  id: string
  user_id: string
  account_id: string
  realm: string
  nickname: string | null
  status: string
  granted_ai_permission: number
  acknowledged_ip: string | null
  created_at: string
  removed_at: string | null
  removed_by: string | null
}

interface SessionRow {
  id: string
  user_id: string
  upstream_state: string
  realm: string
  auth_url: string | null
  status: string
  message: string | null
  acknowledged_ip: string | null
  created_at: string
  expires_at: string
}

async function requireAdminUser(env: Env, request: Request, permKey: string): Promise<UserRow> {
  const admin = await requireAdminScope(env, request, permKey)
  return admin as unknown as UserRow
}

/** 读取通道开关、限额、以及要绑的区域（都在管理面板可改） */
async function channelConfig(env: Env) {
  const enabled = (await getSetting(env, "qoder2api_enabled")) === "1"
  // 纯展示开关：与 enabled（通道总开关）区分开 —— 见 qoder2api_donation_visible 的注释
  const visible = await getSettingBool(env, "qoder2api_donation_visible")
  const limit = await getSettingNumber(env, "qoder2api_max_bindings")
  const realm = normalizeRealm(await getSetting(env, "qoder2api_realm"))
  return {
    enabled,
    visible,
    limit: Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 3,
    realm,
  }
}

async function activeBindingCount(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM qoder2api_bindings WHERE user_id = ? AND status = 'active'"
  )
    .bind(userId)
    .first<{ c: number }>()
  return row?.c ?? 0
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function toPublicBinding(row: BindingRow) {
  return {
    id: row.id,
    accountId: row.account_id,
    realm: row.realm,
    nickname: row.nickname,
    status: row.status,
    createdAt: row.created_at,
    removedAt: row.removed_at,
  }
}

/**
 * 取消一次还没完成的上游登录。
 *
 * 用于「用户中途放弃 / 拿到链接却不授权 / 会话过期」这些场景 ——
 * qoder2api 没有僵尸账号要删，但 state 不取消会一直挂在上游内存里到 TTL 才清。
 * 失败不抛错（上游抖动不该让调用方挂掉），只记日志。
 */
async function discardSessionLogin(env: Env, upstreamState: string): Promise<void> {
  if (!upstreamState) return
  try {
    await q2CancelLogin(env, upstreamState)
  } catch (err) {
    console.error("取消 Qoder2API 登录 state 失败（不影响结果）:", upstreamState, err)
  }
}

/** 把上游鉴权/不可达错误映射成给用户看的文案 */
function mapUpstreamError(err: unknown): never {
  if (err instanceof Q2UnauthorizedError) {
    throw new ApiError(503, "Qoder2API 拒绝了本站的面板密码，请联系管理员", "QODER2API_UNAUTHORIZED")
  }
  throw err
}

// ---------------------------------------------------------------------------
// 用户端
// ---------------------------------------------------------------------------

/** GET /api/qoder2api/status —— 通道状态 + 当前用户的绑定列表 */
export async function getStatus(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const { enabled, limit, realm } = await channelConfig(env)
  const configured = await isQoder2ApiConfigured(env)

  const rows = await env.DB.prepare(
    "SELECT * FROM qoder2api_bindings WHERE user_id = ? ORDER BY created_at DESC"
  )
    .bind(user.id)
    .all<BindingRow>()

  const bindings = rows.results ?? []
  const used = bindings.filter((b) => b.status === "active").length

  return json({
    enabled,
    configured,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    /** 当前配置要绑的区域（前端展示用） */
    realm,
    bindings: bindings.map(toPublicBinding),
  })
}

/**
 * POST /api/qoder2api/login/start —— 发起登录。
 *
 * body: { acknowledged: true }
 *
 * 与 cli2api 不同：上游 `/accounts/login/start` **一次性**就把授权链接给了，
 * 所以这里直接返回 authUrl（前端可立即打开），poll 里也会带回来（兼容旧前端逻辑）。
 */
export async function loginStart(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json().catch(() => ({}))) as { acknowledged?: unknown }

  if (body.acknowledged !== true) {
    throw new ApiError(
      400,
      "请先阅读并勾选免责声明：账号会加入共享池供其他用户使用",
      "ACKNOWLEDGEMENT_REQUIRED"
    )
  }

  const { enabled, limit, realm } = await channelConfig(env)
  if (!enabled) {
    throw new ApiError(403, "Qoder2API 账号捐献通道已关闭", "QODER2API_DISABLED")
  }
  if (!(await isQoder2ApiConfigured(env))) {
    throw new ApiError(503, "Qoder2API 网关未配置面板密码，请联系管理员", "QODER2API_NOT_CONFIGURED")
  }

  const ip = clientIp(request)
  await guardRateLimit(env, `qoder2api:start:user:${user.id}`, 5, 10 * 60, "发起登录过于频繁")
  await guardRateLimit(env, `qoder2api:start:ip:${ip}`, 10, 10 * 60, "发起登录过于频繁")

  const used = await activeBindingCount(env, user.id)
  if (used >= limit) {
    throw new ApiError(
      409,
      `最多只能绑定 ${limit} 个账号，你已绑定 ${used} 个`,
      "QODER2API_LIMIT_REACHED"
    )
  }

  let started: { state: string; authUrl: string; realm: Qoder2ApiRealm }
  try {
    started = await q2StartLogin(env, realm)
  } catch (err) {
    mapUpstreamError(err)
  }

  const sessionId = generateToken()
  const now = new Date()
  await env.DB.prepare(
    `INSERT INTO qoder2api_login_sessions
       (id, user_id, upstream_state, realm, auth_url, status, acknowledged_ip, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
  )
    .bind(
      await hashToken(sessionId),
      user.id,
      started.state,
      started.realm,
      started.authUrl,
      ip,
      now.toISOString(),
      new Date(now.getTime() + SESSION_TTL_MS).toISOString()
    )
    .run()

  await audit(
    env,
    user.id,
    "qoder2api.login.start",
    `发起 Qoder2API 账号登录（${started.realm}）`,
    ip
  )

  return json({ sessionId, realm: started.realm, authUrl: started.authUrl })
}

/** GET /api/qoder2api/login/poll?session= —— 轮询登录结果 */
export async function loginPoll(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const sessionId = new URL(request.url).searchParams.get("session") ?? ""
  if (!sessionId) {
    throw new ApiError(400, "缺少 session 参数", "INVALID_INPUT")
  }

  await guardRateLimit(env, `qoder2api:poll:user:${user.id}`, 60, 5 * 60, "轮询过于频繁")

  const sess = await env.DB.prepare("SELECT * FROM qoder2api_login_sessions WHERE id = ?")
    .bind(await hashToken(sessionId))
    .first<SessionRow>()

  if (!sess) {
    throw new ApiError(404, "会话不存在，请重新发起登录", "SESSION_NOT_FOUND")
  }
  if (sess.user_id !== user.id) {
    throw new ApiError(403, "该会话不属于当前账号", "FORBIDDEN")
  }

  // 终态直回，不再打上游（上游成功一次后 state 即被删除，重复 poll 只会拿到 unknown）
  if (sess.status === "done") {
    return json({ status: "done", result: parseResult(sess.message) })
  }
  if (sess.status === "failed") {
    return json({ status: "failed", message: sess.message ?? "登录失败" })
  }

  if (new Date(sess.expires_at).getTime() < Date.now()) {
    const msg = "登录会话已过期，请重新发起"
    await failSession(env, sess.id, msg)
    await discardSessionLogin(env, sess.upstream_state)
    return json({ status: "failed", message: msg })
  }

  try {
    const polled = await q2PollLogin(env, sess.upstream_state)

    if (polled.status === "failed") {
      const msg = polled.message || "上游登录失败，请重新发起"
      await failSession(env, sess.id, msg)
      await discardSessionLogin(env, sess.upstream_state)
      return json({ status: "failed", message: msg })
    }
    if (polled.status !== "done") {
      return json({
        status: "pending",
        authUrl: sess.auth_url ?? "",
        message: polled.message || "等待浏览器完成登录",
      })
    }

    // 登录完成 → 落绑定
    const result = await completeBinding(env, user, sess, polled.account!)
    return json({ status: "done", result })
  } catch (err) {
    if (err instanceof Q2UpstreamError && err.status === 404) {
      // 上游 state 未知/已过期（人工取消过、或 TTL 到了）
      const msg = "授权会话已在网关侧失效，请重新发起"
      await failSession(env, sess.id, msg)
      return json({ status: "failed", message: msg })
    }
    mapUpstreamError(err)
  }
}

/** 把会话标记为失败（只在仍 pending 时写，避免并发 poll 把成功结果抹掉） */
async function failSession(env: Env, id: string, message: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE qoder2api_login_sessions SET status = 'failed', message = ? WHERE id = ? AND status = 'pending'"
  )
    .bind(message, id)
    .run()
}

function parseResult(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * 登录成功 → 落绑定 + 授予 ai 权限。
 *
 * 上游账号就是本次授权新建的，所以一定是「新资源」——但**权限**是否新增要看
 * 用户当时有没有 ai（决定移除时该不该收回），以及要不要发邀请奖励。
 */
async function completeBinding(
  env: Env,
  user: UserRow,
  sess: SessionRow,
  account: { uid: string; nickname: string; realm: string }
): Promise<Record<string, unknown>> {
  // 跨用户抢绑：上游账号 id 全局唯一，被别的人绑了就直接拒绝
  const existing = await env.DB.prepare("SELECT * FROM qoder2api_bindings WHERE account_id = ?")
    .bind(account.uid)
    .first<BindingRow>()

  if (existing && existing.user_id !== user.id) {
    await failSession(env, sess.id, "该账号已被其他用户绑定")
    await audit(
      env,
      user.id,
      "qoder2api.login.conflict",
      `上游账号 ${account.uid} 已被用户 ${existing.user_id} 绑定`,
      sess.acknowledged_ip
    )
    throw new ApiError(409, "该账号已被其他用户绑定", "QODER2API_ACCOUNT_TAKEN")
  }

  const id = existing?.id ?? uuid()
  const now = new Date().toISOString()
  const realm = normalizeRealm(account.realm || sess.realm)

  // 本次是否真的把 ai 从无变有：决定移除时该不该收回，以及是否发邀请奖励。
  // 先看「捐献授权开关」：关掉时绑定照常进池，只是不再授予 ai 权限。
  const aiGranted =
    (await getSettingBool(env, "donation_grant_qoder2api")) &&
    !parsePermissions(user.permissions).ai

  const result = {
    id,
    accountId: account.uid,
    realm,
    nickname: account.nickname,
    aiGranted,
    // 终态快照会原样回给重复 poll 的前端，故两个分支都要带上这个字段
    alreadyBound: false,
  }

  if (existing) {
    // 重复登录同一个 upstream 账号：复活墓碑，不二次授权
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE qoder2api_bindings
            SET status = 'active', removed_at = NULL, removed_by = NULL,
                nickname = ?, realm = ?
          WHERE id = ?`
      ).bind(account.nickname, realm, id),
      env.DB.prepare(
        "UPDATE qoder2api_login_sessions SET status = 'done', message = ? WHERE id = ?"
      ).bind(JSON.stringify({ ...result, alreadyBound: true }), sess.id),
    ])
    return { ...result, alreadyBound: true }
  }

  const statements = [
    env.DB.prepare(
      `INSERT INTO qoder2api_bindings
         (id, user_id, account_id, realm, nickname, status,
          granted_ai_permission, acknowledged_ip, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`
    ).bind(
      id,
      user.id,
      account.uid,
      realm,
      account.nickname,
      aiGranted ? 1 : 0,
      sess.acknowledged_ip,
      now
    ),
    env.DB.prepare(
      "UPDATE qoder2api_login_sessions SET status = 'done', message = ? WHERE id = ?"
    ).bind(JSON.stringify(result), sess.id),
  ]

  if (aiGranted) {
    statements.push(
      env.DB.prepare(
        `UPDATE users SET permissions = ${featurePermissionSql("ai", true)}, updated_at = ? WHERE id = ?`
      ).bind(now, user.id)
    )
  }

  await env.DB.batch(statements)

  await audit(
    env,
    user.id,
    "qoder2api.login.done",
    `Qoder2API 账号绑定成功（${realm}，上游账号 ${account.uid}）` +
      `${aiGranted ? "，已解锁 AI 权限" : ""}`,
    sess.acknowledged_ip
  )

  // 捐献奖励积分：**每次新绑定发一次**（dedup 用绑定 id，重复登录同一账号时
  // 走的是上面的 existing 分支，压根到不了这里）。上限由 max_bindings 天然封住。
  // 档位固定取 `qoder`（qoder2api 只对接 Qoder，不再有 provider 可切）。
  if (isDonationRewardKind(PROVIDER)) {
    await grantDonationReward(env, {
      userId: user.id,
      kind: PROVIDER,
      dedupKey: `qoder2api:${id}`,
      detail: `${donationRewardLabel(PROVIDER)}捐献奖励`,
    })
  }

  // 邀请奖励：本次绑定确实带来了新账号，且真的解锁了 ai
  if (aiGranted) {
    try {
      const planId = Number(await getSetting(env, "invite_reward_plan_id")) || 2
      await grantInviteReward(env, user, planId)
    } catch (err) {
      // 奖励失败不影响绑定本身
      console.error("发放邀请奖励失败:", err)
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// 管理端
// ---------------------------------------------------------------------------

/** GET /api/admin/qoder2api/config —— 通道配置（含掩码后的凭据信息） */
export async function adminGetConfig(env: Env, request: Request): Promise<Response> {
  await requireAdminUser(env, request, "wb2api.config")
  const { enabled, limit, realm } = await channelConfig(env)
  const cred = await getQoder2ApiCredentialInfo(env)
  const baseUrl = (await getSetting(env, "qoder2api_base_url")).trim()

  return json({
    enabled,
    limit,
    realm,
    baseUrl,
    credential: cred,
  })
}

/** PUT /api/admin/qoder2api/config —— 保存面板密码（校验通过才落库） */
export async function adminSaveConfig(env: Env, request: Request): Promise<Response> {
  await requireAdminUser(env, request, "wb2api.config")
  const body = (await request.json().catch(() => ({}))) as { panelPassword?: unknown }
  const pw = String(body.panelPassword ?? "").trim()
  if (!pw) throw new ApiError(400, "请填写面板密码", "INVALID_INPUT")

  await saveQoder2ApiPassword(env, pw)
  const cred = await getQoder2ApiCredentialInfo(env)
  return json({ ok: true, credential: cred })
}

/** GET /api/admin/qoder2api/bindings —— 全部绑定（含已移除） */
export async function adminListBindings(env: Env, request: Request): Promise<Response> {
  await requireAdminUser(env, request, "wb2api.config")
  const rows = await env.DB.prepare(
    `SELECT b.*, u.username FROM qoder2api_bindings b
       LEFT JOIN users u ON u.id = b.user_id
     ORDER BY b.created_at DESC LIMIT 500`
  ).all<BindingRow & { username: string | null }>()

  return json({
    bindings: (rows.results ?? []).map((r) => ({
      ...toPublicBinding(r),
      username: r.username,
    })),
  })
}

/**
 * POST /api/admin/qoder2api/bindings/:id/remove —— 摘除绑定（可选一并收回 ai）。
 *
 * 与 wb2api 一致：先从上游摘掉账号，再改本地状态；上游失败不阻断本地标记。
 */
export async function adminRemoveBinding(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireAdminUser(env, request, "wb2api.config")
  const body = (await request.json().catch(() => ({}))) as { revokeAi?: unknown }

  const binding = await env.DB.prepare("SELECT * FROM qoder2api_bindings WHERE id = ?")
    .bind(id)
    .first<BindingRow>()
  if (!binding) throw new ApiError(404, "绑定不存在", "NOT_FOUND")

  let upstreamWarning: string | null = null
  try {
    await q2DeleteAccount(env, binding.account_id)
  } catch (err) {
    upstreamWarning = `上游账号删除失败：${errText(err)}`
    console.error("移除 Qoder2API 账号失败（本地仍标记）:", binding.account_id, err)
  }

  const now = new Date().toISOString()
  await env.DB.prepare(
    "UPDATE qoder2api_bindings SET status = 'removed', removed_at = ?, removed_by = ? WHERE id = ?"
  )
    .bind(now, admin.id, id)
    .run()

  // 权限回收：默认「有依据就不收回」（还有别的 active 绑定 / 有 approved 的 ai 捐献）
  let aiRevoked = false
  const explicit = typeof body.revokeAi === "boolean" ? (body.revokeAi as boolean) : null
  const shouldRevoke = explicit ?? (await shouldRevokeAi(env, binding))

  if (shouldRevoke) {
    const res = await env.DB.prepare(
      `UPDATE users SET permissions = ${featurePermissionSql("ai", false)}, updated_at = ?
        WHERE id = ? AND ${featurePermittedGuard("ai")} AND ${notWhitelistedGuard()}`
    )
      .bind(now, binding.user_id)
      .run()
    aiRevoked = (res.meta?.changes ?? 0) > 0
  }

  await audit(
    env,
    admin.id,
    "qoder2api.binding.remove",
    `摘除 Qoder2API 绑定（用户 ${binding.user_id}，上游账号 ${binding.account_id}）；` +
      `AI 权限${aiRevoked ? "已收回" : "保留"}`
  )

  return json({ ok: true, aiRevoked, upstreamWarning })
}

/** 是否该收回 ai：还有别的依据就不收 */
async function shouldRevokeAi(env: Env, binding: BindingRow): Promise<boolean> {
  // 当初绑定就没带来 ai（用户本来就有）→ 不该动
  if (binding.granted_ai_permission !== 1) return false
  // 还有其它 active 的 qoder2api 绑定 → 保留
  const other = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM qoder2api_bindings WHERE user_id = ? AND status = 'active'"
  )
    .bind(binding.user_id)
    .first<{ c: number }>()
  if ((other?.c ?? 0) > 0) return false
  // 还有 active 的 wb2api 绑定 → 保留（另一条通道给过 ai）
  const wb2 = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM wb2api_bindings WHERE user_id = ? AND status = 'active'"
  )
    .bind(binding.user_id)
    .first<{ c: number }>()
  if ((wb2?.c ?? 0) > 0) return false
  // 有 approved 的 ai 捐献 → 保留
  const donation = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM donations WHERE user_id = ? AND status = 'approved' AND type IN ('ai','sensenova')"
  )
    .bind(binding.user_id)
    .first<{ c: number }>()
  if ((donation?.c ?? 0) > 0) return false
  return true
}

/** GET /api/admin/qoder2api/pool —— 上游池子概览（账号列表） */
export async function adminGetPool(env: Env, request: Request): Promise<Response> {
  await requireAdminUser(env, request, "wb2api.config")
  if (!(await isQoder2ApiConfigured(env))) {
    return json({ available: false, reason: "未配置面板密码", accounts: [] })
  }
  try {
    const accounts = await q2ListAccounts(env)
    return json({
      available: true,
      reason: "",
      accounts: accounts.map((a) => ({
        id: a.uid,
        name: a.nickname,
        realm: a.realm,
        enabled: a.enabled,
      })),
    })
  } catch (err) {
    return json({ available: false, reason: errText(err), accounts: [] })
  }
}

/**
 * 供 donations.ts 复用：把通道概况塞进 `GET /api/donations` 的响应，
 * 让捐献页一次请求就拿到「能不能捐 / 捐了几个」。
 *
 * `visible` 是**纯展示开关**（`qoder2api_donation_visible`）：
 * 关掉后只对「还没有任何绑定」的用户隐藏卡片 —— 通道本身照常工作，
 * 已绑定的用户仍看得到卡片以便撤销绑定。
 */
export async function qoder2apiDonationBlock(
  env: Env,
  userId: string
): Promise<{
  enabled: boolean
  /** 是否在捐献页显示入口（关掉 + 无绑定 ⇒ 前端整卡隐藏） */
  visible: boolean
  configured: boolean
  limit: number
  used: number
  remaining: number
  realm: string
  bindings: ReturnType<typeof toPublicBinding>[]
  feature: string
}> {
  const { enabled, visible, limit, realm } = await channelConfig(env)
  const configured = await isQoder2ApiConfigured(env)
  const rows = await env.DB.prepare(
    "SELECT * FROM qoder2api_bindings WHERE user_id = ? ORDER BY created_at DESC"
  )
    .bind(userId)
    .all<BindingRow>()
  const bindings = rows.results ?? []
  const used = bindings.filter((b) => b.status === "active").length

  return {
    enabled,
    visible,
    configured,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    realm,
    bindings: bindings.map(toPublicBinding),
    feature: "ai",
  }
}
