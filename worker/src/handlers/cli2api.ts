/**
 * 捐献通道：CLI2API 反代账号（登录即解锁 AI 权限）。
 *
 * 与 handlers/wb2api.ts 的关系：**并行的第二条同类通道**，不是同一张表也不是同一套接口。
 * 两者都是「用户登录自己的上游账号 → 账号进共享池 → 自动解锁 ai 权限」，免管理员审核；
 * 但 cli2api 的流程是三步（建账号 → 触发登录 → 轮询），且账号由本站建在上游，
 * 所以独立实现、前端并列展示。
 *
 * ⚠️ 本通道与 wb2api 最关键的一条差异：**账号是本站建的**（`POST /api/accounts`），
 * 所以「未完成登录的空账号」也留在上游池子里 —— 会话失败/过期时必须把它删掉
 * （见 `discardSessionAccount`），否则每次用户中途放弃都在池子里堆一个僵尸账号。
 *
 * 权限回收的准确性同 wb2api：用户的 `ai` 可能来自 ①本通道 ②donations 的 ai 捐献
 * ③邀请码注册时带的权限（③无法溯源）。因此移除绑定时按「有依据就不收回」实时判定，
 * 管理端留人工覆盖开关。
 */
import { ApiError, json } from "../http"
import { generateToken, hashToken, uuid } from "../crypto"
import { requireUser, type UserRow } from "../auth"
import { parsePermissions, featurePermissionSql } from "../permissions"
import { audit, getSetting, getSettingBool, getSettingNumber } from "../settings"
import { clientIp, guardRateLimit } from "../ratelimit"
import { donationRewardLabel, grantDonationReward, isDonationRewardKind } from "../points"
import {
  Cli2NotFoundError,
  Cli2UnauthorizedError,
  Cli2UpstreamError,
  cli2CreateAccount,
  cli2DeleteAccount,
  cli2ListAccounts,
  cli2PollLogin,
  cli2StartLogin,
  getCli2ApiCredentialInfo,
  isCli2ApiConfigured,
  saveCli2ApiConsoleKey,
} from "../cli2api-client"
import { grantInviteReward } from "../invite-rewards"
import type { Env } from "../env"

/** 本站登录会话有效期（上游 device 授权链接通常也是这个量级） */
const SESSION_TTL_MS = 15 * 60 * 1000

interface BindingRow {
  id: string
  user_id: string
  account_id: string
  provider: string
  region: string
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
  account_id: string
  provider: string
  region: string
  auth_url: string | null
  status: string
  message: string | null
  acknowledged_ip: string | null
  created_at: string
  expires_at: string
}

async function requireAdminUser(env: Env, request: Request): Promise<UserRow> {
  const user = await requireUser(env, request)
  if (user.role !== "admin" && user.role !== "root") {
    throw new ApiError(403, "需要管理员权限", "FORBIDDEN")
  }
  return user
}

/** 读取通道开关、限额、以及要绑的上游与区域（都在管理面板可改） */
async function channelConfig(env: Env) {
  const enabled = (await getSetting(env, "cli2api_enabled")) === "1"
  // 纯展示开关：与 enabled（通道总开关）区分开 —— 见 cli2api_donation_visible 的注释
  const visible = await getSettingBool(env, "cli2api_donation_visible")
  const limit = await getSettingNumber(env, "cli2api_max_bindings")
  const provider = (await getSetting(env, "cli2api_provider")).trim() || "qoder"
  const region = (await getSetting(env, "cli2api_region")).trim() || "cn"
  return {
    enabled,
    visible,
    limit: Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 3,
    provider,
    region,
  }
}

async function activeBindingCount(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM cli2api_bindings WHERE user_id = ? AND status = 'active'"
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
    provider: row.provider,
    region: row.region,
    nickname: row.nickname,
    status: row.status,
    createdAt: row.created_at,
    removedAt: row.removed_at,
  }
}

/**
 * 把会话在上游占用的账号删掉。
 *
 * 用于「用户中途放弃 / 拿不到授权链接 / 会话过期」这些场景 —— 账号是本站建的，
 * 不删就在池子里留一个 enabled 但永远登录不上的僵尸账号。
 * 删除失败不抛错（上游抖动不该让调用方挂掉），只记日志。
 */
async function discardSessionAccount(env: Env, accountId: string): Promise<void> {
  if (!accountId) return
  try {
    await cli2DeleteAccount(env, accountId)
  } catch (err) {
    console.error("清理 CLI2API 僵尸账号失败（需人工处理）:", accountId, err)
  }
}

// ---------------------------------------------------------------------------
// 用户端
// ---------------------------------------------------------------------------

/** GET /api/cli2api/status —— 通道状态 + 当前用户的绑定列表 */
export async function getStatus(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const { enabled, limit, provider, region } = await channelConfig(env)
  const configured = await isCli2ApiConfigured(env)

  const rows = await env.DB.prepare(
    "SELECT * FROM cli2api_bindings WHERE user_id = ? ORDER BY created_at DESC"
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
    /** 当前配置要绑的上游与区域（前端展示用） */
    provider,
    region,
    bindings: bindings.map(toPublicBinding),
  })
}

/**
 * POST /api/cli2api/login/start —— 发起登录。
 *
 * body: { acknowledged: true }
 *
 * 只做两件事：**建上游账号 + 落会话**，立即返回（1~2 秒）。
 * 拿授权链接放在 poll 里做 —— 因为 cli2api 要先给账号起 worker 进程，
 * 实测要 ~8 秒 `login/device` 才有响应（否则 `account_not_running`）。
 * 若在这里同步等，用户点「绑定」要白等十秒。
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

  const { enabled, limit, provider, region } = await channelConfig(env)
  if (!enabled) {
    throw new ApiError(403, "CLI2API 账号捐献通道已关闭", "CLI2API_DISABLED")
  }
  if (!(await isCli2ApiConfigured(env))) {
    throw new ApiError(503, "CLI2API 网关未配置管理密钥，请联系管理员", "CLI2API_NOT_CONFIGURED")
  }

  const ip = clientIp(request)
  await guardRateLimit(env, `cli2api:start:user:${user.id}`, 5, 10 * 60, "发起登录过于频繁")
  await guardRateLimit(env, `cli2api:start:ip:${ip}`, 10, 10 * 60, "发起登录过于频繁")

  const used = await activeBindingCount(env, user.id)
  if (used >= limit) {
    throw new ApiError(
      409,
      `最多只能绑定 ${limit} 个账号，你已绑定 ${used} 个`,
      "CLI2API_LIMIT_REACHED"
    )
  }

  // 建一个 enabled 的上游账号（cli2api 会为它起 worker，登录由那个进程处理）。
  // 名字带上本站用户名，便于管理员在上游控制台辨认来源。
  let accountId = ""
  try {
    const account = await cli2CreateAccount(env, {
      name: `doulor-${user.username}-${uuid().slice(0, 6)}`,
      provider,
      region,
      enabled: true,
    })
    accountId = account.id
  } catch (err) {
    if (err instanceof Cli2UnauthorizedError) {
      throw new ApiError(503, "CLI2API 拒绝了本站的管理密钥，请联系管理员", "CLI2API_UNAUTHORIZED")
    }
    throw err
  }

  const sessionId = generateToken()
  const now = new Date()
  await env.DB.prepare(
    `INSERT INTO cli2api_login_sessions
       (id, user_id, account_id, provider, region, auth_url, status, acknowledged_ip, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, NULL, 'pending', ?, ?, ?)`
  )
    .bind(
      await hashToken(sessionId),
      user.id,
      accountId,
      provider,
      region,
      ip,
      now.toISOString(),
      new Date(now.getTime() + SESSION_TTL_MS).toISOString()
    )
    .run()

  await audit(
    env,
    user.id,
    "cli2api.login.start",
    `发起 CLI2API 账号登录（${provider}/${region}，上游账号 ${accountId}）`,
    ip
  )

  return json({ sessionId, provider, region })
}

/**
 * GET /api/cli2api/login/poll?session= —— 轮询登录结果。
 *
 * 第一次 poll 顺带把授权链接取回来（见 loginStart 的说明）；拿到后缓存进会话，
 * 之后只查 `login/status`，不再重复触发。
 */
export async function loginPoll(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const sessionId = new URL(request.url).searchParams.get("session") ?? ""
  if (!sessionId) {
    throw new ApiError(400, "缺少 session 参数", "INVALID_INPUT")
  }

  await guardRateLimit(env, `cli2api:poll:user:${user.id}`, 60, 5 * 60, "轮询过于频繁")

  const sess = await env.DB.prepare("SELECT * FROM cli2api_login_sessions WHERE id = ?")
    .bind(await hashToken(sessionId))
    .first<SessionRow>()

  if (!sess) {
    throw new ApiError(404, "会话不存在，请重新发起登录", "SESSION_NOT_FOUND")
  }
  if (sess.user_id !== user.id) {
    throw new ApiError(403, "该会话不属于当前账号", "FORBIDDEN")
  }

  // 终态直回，不再打上游
  if (sess.status === "done") {
    return json({ status: "done", result: parseResult(sess.message) })
  }
  if (sess.status === "failed") {
    return json({ status: "failed", message: sess.message ?? "登录失败" })
  }

  if (new Date(sess.expires_at).getTime() < Date.now()) {
    const msg = "登录会话已过期，请重新发起"
    await failSession(env, sess.id, msg)
    await discardSessionAccount(env, sess.account_id)
    return json({ status: "failed", message: msg })
  }

  try {
    // 还没拿到授权链接：先取链接（worker 可能还在启动，此时返回 pending 让前端继续轮）
    if (!sess.auth_url) {
      try {
        const started = await cli2StartLogin(env, sess.account_id)
        if (!started.authUrl) {
          return json({ status: "pending", message: "正在启动上游账号…" })
        }
        await env.DB.prepare("UPDATE cli2api_login_sessions SET auth_url = ? WHERE id = ?")
          .bind(started.authUrl, sess.id)
          .run()
        return json({ status: "pending", authUrl: started.authUrl })
      } catch (err) {
        if (err instanceof Cli2UpstreamError && err.code === "account_not_running") {
          return json({ status: "pending", message: "正在启动上游账号…" })
        }
        if (err instanceof Cli2UnauthorizedError) {
          throw new ApiError(503, "CLI2API 拒绝了本站的管理密钥，请联系管理员", "CLI2API_UNAUTHORIZED")
        }
        throw err
      }
    }

    const polled = await cli2PollLogin(env, sess.account_id)

    if (polled.status === "failed") {
      const msg = polled.message || "上游登录失败，请重新发起"
      await failSession(env, sess.id, msg)
      // 失败的上游账号是本站建的、且没登录成功 ⇒ 当场删掉，否则池子堆僵尸账号。
      // （状态词表修好后失败会即时上报，不再靠 15 分钟过期兜底清理，所以这里必须收。）
      await discardSessionAccount(env, sess.account_id)
      return json({ status: "failed", message: msg })
    }
    if (polled.status !== "done") {
      return json({
        status: "pending",
        authUrl: sess.auth_url,
        message: polled.message || "等待浏览器完成登录",
      })
    }

    // 登录完成 → 落绑定
    const result = await completeBinding(env, user, sess)
    return json({ status: "done", result })
  } catch (err) {
    if (err instanceof Cli2NotFoundError) {
      // 上游账号被删了（人工清理等）：会话无法继续
      const msg = "上游账号已不存在，请重新发起"
      await failSession(env, sess.id, msg)
      return json({ status: "failed", message: msg })
    }
    if (err instanceof Cli2UnauthorizedError) {
      throw new ApiError(503, "CLI2API 拒绝了本站的管理密钥，请联系管理员", "CLI2API_UNAUTHORIZED")
    }
    throw err
  }
}

/** 把会话标记为失败（只在仍 pending 时写，避免并发 poll 把成功结果抹掉） */
async function failSession(env: Env, id: string, message: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE cli2api_login_sessions SET status = 'failed', message = ? WHERE id = ? AND status = 'pending'"
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
 * ⚠️ 上游账号就是本次新建的，所以一定是「新资源」——但**权限**是否新增要看
 * 用户当时有没有 ai（决定移除时该不该收回），以及要不要发邀请奖励。
 */
async function completeBinding(
  env: Env,
  user: UserRow,
  sess: SessionRow
): Promise<Record<string, unknown>> {
  // 跨用户抢绑：上游账号 id 全局唯一，被别的人绑了就直接拒绝
  const existing = await env.DB.prepare(
    "SELECT * FROM cli2api_bindings WHERE account_id = ?"
  )
    .bind(sess.account_id)
    .first<BindingRow>()

  if (existing && existing.user_id !== user.id) {
    await failSession(env, sess.id, "该账号已被其他用户绑定")
    await audit(
      env,
      user.id,
      "cli2api.login.conflict",
      `上游账号 ${sess.account_id} 已被用户 ${existing.user_id} 绑定`,
      sess.acknowledged_ip
    )
    throw new ApiError(409, "该账号已被其他用户绑定", "CLI2API_ACCOUNT_TAKEN")
  }

  const id = existing?.id ?? uuid()
  const now = new Date().toISOString()

  // 本次是否真的把 ai 从无变有：决定移除时该不该收回，以及是否发邀请奖励。
  const aiGranted = !parsePermissions(user.permissions).ai

  const result = {
    id,
    accountId: sess.account_id,
    provider: sess.provider,
    region: sess.region,
    aiGranted,
  }

  if (existing) {
    // 重复登录同一个 upstream 账号：复活墓碑，不二次授权
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE cli2api_bindings SET status = 'active', removed_at = NULL, removed_by = NULL WHERE id = ?"
      ).bind(id),
      env.DB.prepare(
        "UPDATE cli2api_login_sessions SET status = 'done', message = ? WHERE id = ?"
      ).bind(JSON.stringify({ ...result, alreadyBound: true }), sess.id),
    ])
    return { ...result, alreadyBound: true }
  }

  const statements = [
    env.DB.prepare(
      `INSERT INTO cli2api_bindings
         (id, user_id, account_id, provider, region, nickname, status,
          granted_ai_permission, acknowledged_ip, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, 'active', ?, ?, ?)`
    ).bind(
      id,
      user.id,
      sess.account_id,
      sess.provider,
      sess.region,
      aiGranted ? 1 : 0,
      sess.acknowledged_ip,
      now
    ),
    env.DB.prepare(
      "UPDATE cli2api_login_sessions SET status = 'done', message = ? WHERE id = ?"
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
    "cli2api.login.done",
    `CLI2API 账号绑定成功（${sess.provider}/${sess.region}，上游账号 ${sess.account_id}）` +
      `${aiGranted ? "，已解锁 AI 权限" : ""}`,
    sess.acknowledged_ip
  )

  // 捐献奖励积分：**每次新绑定发一次**（dedup 用绑定 id，重复登录同一账号时
  // 走的是上面的 existing 分支，压根到不了这里）。上限由 max_bindings 天然封住。
  //
  // 档位取上游 provider（qoder / workbuddy / trae）：provider 是管理员随时可切的，
  // 按通道定价会出现「换个 provider 奖励就变了」。认不出的 provider 不发。
  if (isDonationRewardKind(sess.provider)) {
    await grantDonationReward(env, {
      userId: user.id,
      kind: sess.provider,
      dedupKey: `cli2api:${id}`,
      detail: `${donationRewardLabel(sess.provider)}捐献奖励`,
    })
  }

  // 邀请奖励：本次绑定确实带来了新账号（上游账号是新建的），且真的解锁了 ai
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

/** GET /api/admin/cli2api/config —— 通道配置（含掩码后的凭据信息） */
export async function adminGetConfig(env: Env, request: Request): Promise<Response> {
  await requireAdminUser(env, request)
  const { enabled, limit, provider, region } = await channelConfig(env)
  const cred = await getCli2ApiCredentialInfo(env)
  const baseUrl = (await getSetting(env, "cli2api_base_url")).trim()

  return json({
    enabled,
    limit,
    provider,
    region,
    baseUrl,
    credential: cred,
  })
}

/** PUT /api/admin/cli2api/config —— 保存 console key（校验通过才落库） */
export async function adminSaveConfig(env: Env, request: Request): Promise<Response> {
  await requireAdminUser(env, request)
  const body = (await request.json().catch(() => ({}))) as { consoleKey?: unknown }
  const key = String(body.consoleKey ?? "").trim()
  if (!key) throw new ApiError(400, "请填写 console key", "INVALID_INPUT")

  await saveCli2ApiConsoleKey(env, key)
  const cred = await getCli2ApiCredentialInfo(env)
  return json({ ok: true, credential: cred })
}

/** GET /api/admin/cli2api/bindings —— 全部绑定（含已移除） */
export async function adminListBindings(env: Env, request: Request): Promise<Response> {
  await requireAdminUser(env, request)
  const rows = await env.DB.prepare(
    `SELECT b.*, u.username FROM cli2api_bindings b
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
 * POST /api/admin/cli2api/bindings/:id/remove —— 摘除绑定（可选一并收回 ai）。
 *
 * 与 wb2api 一致：先从上游摘掉账号，再改本地状态；上游失败不阻断本地标记。
 */
export async function adminRemoveBinding(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireAdminUser(env, request)
  const body = (await request.json().catch(() => ({}))) as { revokeAi?: unknown }

  const binding = await env.DB.prepare("SELECT * FROM cli2api_bindings WHERE id = ?")
    .bind(id)
    .first<BindingRow>()
  if (!binding) throw new ApiError(404, "绑定不存在", "NOT_FOUND")

  let upstreamWarning: string | null = null
  try {
    await cli2DeleteAccount(env, binding.account_id)
  } catch (err) {
    upstreamWarning = `上游账号删除失败：${errText(err)}`
    console.error("移除 CLI2API 账号失败（本地仍标记）:", binding.account_id, err)
  }

  const now = new Date().toISOString()
  await env.DB.prepare(
    "UPDATE cli2api_bindings SET status = 'removed', removed_at = ?, removed_by = ? WHERE id = ?"
  )
    .bind(now, admin.id, id)
    .run()

  // 权限回收：默认「有依据就不收回」（还有别的 active 绑定 / 有 approved 的 ai 捐献）
  let aiRevoked = false
  const explicit =
    typeof body.revokeAi === "boolean" ? (body.revokeAi as boolean) : null
  const shouldRevoke = explicit ?? (await shouldRevokeAi(env, binding))

  if (shouldRevoke) {
    const res = await env.DB.prepare(
      `UPDATE users SET permissions = ${featurePermissionSql("ai", false)}, updated_at = ?
        WHERE id = ? AND COALESCE(json_extract(CASE WHEN json_valid(permissions) THEN permissions ELSE '{}' END, '$.ai'), 1) = 1`
    )
      .bind(now, binding.user_id)
      .run()
    aiRevoked = (res.meta?.changes ?? 0) > 0
  }

  await audit(
    env,
    admin.id,
    "cli2api.binding.remove",
    `摘除 CLI2API 绑定（用户 ${binding.user_id}，上游账号 ${binding.account_id}）；` +
      `AI 权限${aiRevoked ? "已收回" : "保留"}`
  )

  return json({ ok: true, aiRevoked, upstreamWarning })
}

/** 是否该收回 ai：还有别的依据就不收 */
async function shouldRevokeAi(env: Env, binding: BindingRow): Promise<boolean> {
  // 当初绑定就没带来 ai（用户本来就有）→ 不该动
  if (binding.granted_ai_permission !== 1) return false
  // 还有其它 active 的 cli2api 绑定 → 保留
  const other = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM cli2api_bindings WHERE user_id = ? AND status = 'active'"
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

/** GET /api/admin/cli2api/pool —— 上游池子概览（账号列表） */
export async function adminGetPool(env: Env, request: Request): Promise<Response> {
  await requireAdminUser(env, request)
  if (!(await isCli2ApiConfigured(env))) {
    return json({ available: false, reason: "未配置 console key", accounts: [] })
  }
  try {
    const accounts = await cli2ListAccounts(env)
    return json({ available: true, accounts })
  } catch (err) {
    return json({ available: false, reason: errText(err), accounts: [] })
  }
}

/**
 * 供 donations.ts 复用：把通道概况塞进 `GET /api/donations` 的响应，
 * 让捐献页一次请求就拿到「能不能捐 / 捐了几个」。
 *
 * `visible` 是**纯展示开关**（`cli2api_donation_visible`，2026-09-30 加）：
 * 关掉后只对「还没有任何绑定」的用户隐藏卡片 —— 通道本身照常工作，
 * 已绑定的用户仍看得到卡片以便撤销绑定。
 */
export async function cli2apiDonationBlock(
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
  provider: string
  region: string
  bindings: ReturnType<typeof toPublicBinding>[]
  feature: string
}> {
  const { enabled, visible, limit, provider, region } = await channelConfig(env)
  const configured = await isCli2ApiConfigured(env)
  const rows = await env.DB.prepare(
    "SELECT * FROM cli2api_bindings WHERE user_id = ? ORDER BY created_at DESC"
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
    provider,
    region,
    bindings: bindings.map(toPublicBinding),
    feature: "ai",
  }
}
