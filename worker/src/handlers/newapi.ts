/**
 * AI 中转站（NewAPI 集成）。
 *
 * 开通流程（每一步都是实测确认过的）：
 *   1. 管理员建号 `POST /api/user/`（该接口会丢弃 email，只建账号）
 *   2. 用管理员身份调用自助注册 `POST /api/user/register` 并带上验证码 ——
 *      这是**唯一**能把 email 写进 NewAPI 的途径。
 *      验证码由 NewAPI 发到 `<用户名>@doulor.cn`，而本站正是该域名的收件方，
 *      因此可以从 D1 的收件箱里读出验证码。
 *      （已验证：/api/verification 生成的验证码会真的投递进本站收件箱）
 *   3. 用管理员接口把额度调整为试用额度（add_quota + mode=override）
 *   4. 服务端登录换 session，再换长期 access token，加密后存库
 *
 * 用户密码只在第 1、2 步短暂使用，绝不落库。access token 加密存储，
 * 仅用于代用户创建 API Key；用户可在 NewAPI 后台随时吊销。
 */
import { ApiError, json } from "../http"
import { encryptSecret, decryptSecret, uuid } from "../crypto"
import { requireUser } from "../auth"
import {
  adminSetQuota,
  createApiKey,
  deleteApiKey,
  extractVerificationCode,
  findUserByUsername,
  generateAccessToken,
  getCurrencyInfo,
  getUserSelf,
  isNewApiConfigured,
  listModels,
  listTokens,
  login,
  registerUser,
  requestEmailCode,
} from "../newapi-client"
import { audit, getSettings } from "../settings"
import type { Env } from "../env"

function requireEncryptionSecret(env: Env): string {
  if (!env.SESSION_SECRET) {
    throw new ApiError(
      503,
      "未配置 SESSION_SECRET，无法安全保存凭据",
      "NOT_CONFIGURED"
    )
  }
  return env.SESSION_SECRET
}

interface NewApiAccountRow {
  user_id: string
  newapi_user_id: number
  username: string
  email: string
  enc_token: string
  group_name: string | null
  quota: number
  used_quota: number
  request_count: number
  synced_at: string | null
  created_at: string
}

async function loadAccount(
  env: Env,
  userId: string
): Promise<NewApiAccountRow | null> {
  return env.DB.prepare("SELECT * FROM newapi_accounts WHERE user_id = ?")
    .bind(userId)
    .first<NewApiAccountRow>()
}

/**
 * quota 单位 → 展示金额。
 * 币种与换算率都跟随 NewAPI 站点设置（本实例为 CNY，500000 quota = ¥1），
 * 避免本站显示 $ 而 NewAPI 控制台显示 ¥ 的不一致。
 */
function quotaToDisplay(quota: number, perUnit: number): number {
  if (!perUnit) return 0
  return Math.round((quota / perUnit) * 10000) / 10000
}

/**
 * 在本站收件箱里等待 NewAPI 的验证码邮件。
 *
 * 同一个收件箱会堆积历史验证码邮件（用户可能反复触发），而 NewAPI 只认最新
 * 那一次下发的码，因此必须排除请求验证码之前就存在的邮件，否则会读到过期码。
 * NewAPI 是同步发信的，通常几秒内到达；最多轮询 attempts 次。
 */
async function waitForVerificationCode(
  env: Env,
  email: string,
  ignoreBefore: number,
  attempts = 20,
  intervalMs = 3000
): Promise<{ code: string; messageId: string } | null> {
  for (let i = 0; i < attempts; i++) {
    const row = await env.DB.prepare(
      `SELECT m.id, m.text_body, m.subject, m.received_at FROM messages m
         JOIN mailboxes mb ON m.mailbox_id = mb.id
        WHERE mb.address = ? COLLATE NOCASE
        ORDER BY m.received_at DESC
        LIMIT 10`
    )
      .bind(email)
      .all<{
        id: string
        text_body: string
        subject: string
        received_at: string
      }>()

    for (const msg of row.results ?? []) {
      // 只接受本次请求之后到达的邮件
      if (new Date(msg.received_at).getTime() <= ignoreBefore) continue
      const code = extractVerificationCode(`${msg.subject}\n${msg.text_body}`)
      if (code) return { code, messageId: msg.id }
    }

    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
  return null
}

/**
 * 清理用于开通的验证码邮件：核销后从收件箱删除，避免堆在用户邮箱里。
 * 失败不影响主流程。
 */
async function consumeCodeMessage(
  env: Env,
  mailboxId: string,
  messageId: string
): Promise<void> {
  try {
    await env.DB.prepare("DELETE FROM messages WHERE id = ? AND mailbox_id = ?")
      .bind(messageId, mailboxId)
      .run()
  } catch (err) {
    console.error("清理验证码邮件失败:", err)
  }
}

// ---- 状态 ----

/** GET /api/dev/status —— 开通状态、额度、模型列表 */
export async function getStatus(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const settings = await getSettings(env)
  const configured = isNewApiConfigured(env)
  const account = configured ? await loadAccount(env, user.id) : null

  // 币种与换算率以 NewAPI 站点为准
  const currency = configured
    ? await getCurrencyInfo(env)
    : { symbol: "$", code: "USD", perUnit: Number(settings.newapi_quota_per_unit) }
  const perUnit = currency.perUnit

  const base = {
    configured,
    featureEnabled: settings.newapi_enabled === "1",
    // 仅 @doulor.cn 邮箱可开通 —— 这是本功能的核心限制
    eligibleEmail: `${user.username}@${env.ROOT_DOMAIN}`,
    currencySymbol: currency.symbol,
    currencyCode: currency.code,
    trialQuotaUsd: quotaToDisplay(Number(settings.newapi_trial_quota), perUnit),
    group: settings.newapi_group,
    account: account
      ? {
          newapiUserId: account.newapi_user_id,
          username: account.username,
          email: account.email,
          quota: account.quota,
          usedQuota: account.used_quota,
          requestCount: account.request_count,
          quotaUsd: quotaToDisplay(account.quota, perUnit),
          usedUsd: quotaToDisplay(account.used_quota, perUnit),
          group: account.group_name,
          syncedAt: account.synced_at,
        }
      : null,
  }

  // 未开通就不必拉模型列表，避免无谓地消耗 NewAPI 的速率限制
  if (!account) {
    return json({ ...base, models: [] })
  }

  let models: string[] = []
  try {
    const { token, userId } = await decryptAccountToken(env, account)
    models = await listModels(env, token, userId)
  } catch (err) {
    console.error("获取模型列表失败:", err)
  }

  return json({ ...base, models })
}

async function decryptAccountToken(
  env: Env,
  account: NewApiAccountRow
): Promise<{ token: string; userId: number }> {
  const secret = requireEncryptionSecret(env)
  const token = await decryptSecret(account.enc_token, secret)
  return { token, userId: account.newapi_user_id }
}

/** POST /api/dev/sync —— 拉取最新额度用量 */
export async function syncAccount(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const account = await loadAccount(env, user.id)
  if (!account) throw new ApiError(404, "尚未开通 AI 中转站", "NOT_BOUND")

  const { token, userId } = await decryptAccountToken(env, account)
  const self = await getUserSelf(env, token, userId)
  const currency = await getCurrencyInfo(env)
  const now = new Date().toISOString()

  await env.DB.prepare(
    `UPDATE newapi_accounts
        SET quota = ?, used_quota = ?, request_count = ?, group_name = COALESCE(?, group_name), synced_at = ?
      WHERE user_id = ?`
  )
    .bind(
      self.quota ?? account.quota,
      self.used_quota ?? account.used_quota,
      self.request_count ?? account.request_count,
      self.group ?? null,
      now,
      user.id
    )
    .run()

  return json({
    account: {
      quota: self.quota ?? account.quota,
      usedQuota: self.used_quota ?? account.used_quota,
      requestCount: self.request_count ?? account.request_count,
      quotaUsd: quotaToDisplay(self.quota ?? account.quota, currency.perUnit),
      usedUsd: quotaToDisplay(self.used_quota ?? account.used_quota, currency.perUnit),
      currencySymbol: currency.symbol,
      syncedAt: now,
    },
  })
}

// ---- 开通 ----

/** POST /api/dev/bind —— 开通 AI 中转站账号 */
export async function bindAccount(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  if (!isNewApiConfigured(env)) {
    throw new ApiError(503, "AI 中转站未配置", "NEWAPI_NOT_CONFIGURED")
  }

  const settings = await getSettings(env)
  if (settings.newapi_enabled !== "1") {
    throw new ApiError(403, "AI 中转站功能已关闭", "FEATURE_DISABLED")
  }

  const existing = await loadAccount(env, user.id)
  if (existing) {
    throw new ApiError(409, "你已经开通过 AI 中转站了", "ALREADY_BOUND")
  }

  const body = (await request.json()) as { password?: string }
  const password = body.password ?? ""
  if (password.length < 8) {
    throw new ApiError(400, "密码至少需要 8 位", "WEAK_PASSWORD")
  }

  // 先确认具备加密密钥再产生任何副作用，避免建了账号却存不下凭据
  const secret = requireEncryptionSecret(env)

  // 强制使用本站域名的邮箱，这是唯一的邮箱来源
  const email = `${user.username}@${env.ROOT_DOMAIN}`.toLowerCase()
  const username = user.username

  // 邮箱必须真实存在，否则无法收到验证码
  const mailbox = await env.DB.prepare(
    "SELECT id FROM mailboxes WHERE address = ? COLLATE NOCASE LIMIT 1"
  )
    .bind(email)
    .first<{ id: string }>()
  if (!mailbox) {
    throw new ApiError(
      400,
      `需要先创建 ${email} 收件箱才能开通（用于接收验证码）`,
      "NO_MAILBOX"
    )
  }

  // NewAPI 侧同名账号已存在时无法再绑定邮箱（Register 拒绝已存在的用户名），
  // 提前拦下给出明确提示，避免白跑一遍验证码流程
  const remoteExisting = await findUserByUsername(env, username)
  if (remoteExisting) {
    throw new ApiError(
      409,
      `NewAPI 中已存在同名账号「${username}」。请先在 NewAPI 后台删除或改名后再开通（本站无法为已有账号补写邮箱）`,
      "REMOTE_USER_EXISTS"
    )
  }

  // 1. 用本站的 <用户名>@doulor.cn 邮箱自助注册 —— 一步同时建号并绑定邮箱
  //    这是唯一能写入 email 的途径，因此必须放在最前面
  const requestedAt = Date.now()
  await requestEmailCode(env, email)

  // 2. 从自己的收件箱里读出新收到的验证码
  const found = await waitForVerificationCode(env, email, requestedAt)
  if (!found) {
    throw new ApiError(
      504,
      "未能在收件箱中收到 NewAPI 的验证码邮件，请稍后重试",
      "CODE_TIMEOUT"
    )
  }

  try {
    await registerUser(env, username, password, email, found.code)
  } finally {
    // 无论成功与否都核销掉验证码邮件，不留在用户收件箱里
    await consumeCodeMessage(env, mailbox.id, found.messageId)
  }

  // 3. 定位账号并设置试用额度
  const remote = await findUserByUsername(env, username)
  if (!remote) {
    throw new ApiError(502, "NewAPI 账号创建后未能查到该用户", "NEWAPI_ERROR")
  }

  const unlimited = settings.newapi_unlimited_quota === "1"
  if (!unlimited) {
    await adminSetQuota(
      env,
      remote.id,
      Number(settings.newapi_trial_quota),
      "override"
    )
  }

  // 4. 登录换取长期 access token（用于后续代用户建 Key）
  const session = await login(env, username, password)
  if (!session.session) {
    throw new ApiError(
      502,
      "NewAPI 登录成功但未返回会话，无法生成访问令牌",
      "NEWAPI_ERROR"
    )
  }
  const accessToken = await generateAccessToken(
    env,
    session.session,
    session.userId
  )

  const now = new Date().toISOString()

  await env.DB.prepare(
    `INSERT INTO newapi_accounts
       (user_id, newapi_user_id, username, email, enc_token, group_name, quota, used_quota, request_count, synced_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`
  )
    .bind(
      user.id,
      session.userId,
      username,
      email,
      await encryptSecret(accessToken, secret),
      settings.newapi_group,
      unlimited ? 0 : Number(settings.newapi_trial_quota),
      now,
      now
    )
    .run()

  await audit(
    env,
    user.id,
    "newapi.bind",
    `开通 AI 中转站账号 ${username} (id ${session.userId})，邮箱 ${email}`
  )

  return json(
    {
      account: {
        newapiUserId: session.userId,
        username,
        email,
        quota: unlimited ? 0 : Number(settings.newapi_trial_quota),
        group: settings.newapi_group,
        unlimited,
      },
    },
    201
  )
}

// ---- API Key ----

/** GET /api/dev/keys —— 已创建的 Key（掩码） */
export async function listKeys(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const account = await loadAccount(env, user.id)
  if (!account) throw new ApiError(404, "尚未开通 AI 中转站", "NOT_BOUND")

  const rows = await env.DB.prepare(
    "SELECT id, token_id, name, key_prefix, created_at FROM newapi_keys WHERE user_id = ? ORDER BY created_at DESC"
  )
    .bind(user.id)
    .all()

  return json({
    keys: (rows.results ?? []).map((r: Record<string, unknown>) => ({
      id: r.id,
      tokenId: r.token_id,
      name: r.name,
      maskedKey: r.key_prefix,
      createdAt: r.created_at,
    })),
  })
}

/** POST /api/dev/key —— 创建 API Key（完整 key 只返回这一次） */
export async function createKey(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const account = await loadAccount(env, user.id)
  if (!account) throw new ApiError(404, "尚未开通 AI 中转站", "NOT_BOUND")

  const body = (await request.json()) as { name?: string }
  const name = (body.name ?? "").trim().slice(0, 50) || `doulor-${user.username}`

  const { token, userId } = await decryptAccountToken(env, account)
  const created = await createApiKey(env, token, userId, name)

  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO newapi_keys (id, user_id, token_id, name, key_prefix, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(uuid(), user.id, created.tokenId, name, created.maskedKey, now)
    .run()

  await audit(env, user.id, "newapi.key.create", `创建 API Key「${name}」`)

  return json(
    {
      key: {
        tokenId: created.tokenId,
        name,
        // 完整 key 仅此一次下发，服务端不保存
        fullKey: created.fullKey,
        maskedKey: created.maskedKey,
        createdAt: now,
      },
    },
    201
  )
}

/** DELETE /api/dev/key/:id —— 删除 API Key */
export async function removeKey(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const user = await requireUser(env, request)
  const account = await loadAccount(env, user.id)
  if (!account) throw new ApiError(404, "尚未开通 AI 中转站", "NOT_BOUND")

  const row = await env.DB.prepare(
    "SELECT * FROM newapi_keys WHERE id = ? AND user_id = ?"
  )
    .bind(id, user.id)
    .first<{ id: string; token_id: number; name: string }>()
  if (!row) throw new ApiError(404, "Key 不存在", "NOT_FOUND")

  const { token, userId } = await decryptAccountToken(env, account)
  try {
    await deleteApiKey(env, token, userId, row.token_id)
  } catch (err) {
    // NewAPI 侧已删除时不阻断本地清理
    console.error("NewAPI 删除 Key 失败:", err)
  }

  await env.DB.prepare("DELETE FROM newapi_keys WHERE id = ?").bind(row.id).run()
  await audit(env, user.id, "newapi.key.delete", `删除 API Key「${row.name}」`)

  return new Response(null, { status: 204 })
}

/**
 * 从 NewAPI 同步 Key 列表（用户可能直接在 NewAPI 后台建了 Key）。
 * 只登记本站未见过的 token，key 仍为掩码形式。
 */
export async function syncKeys(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const account = await loadAccount(env, user.id)
  if (!account) throw new ApiError(404, "尚未开通 AI 中转站", "NOT_BOUND")

  const { token, userId } = await decryptAccountToken(env, account)
  const remote = await listTokens(env, token, userId)

  const known = await env.DB.prepare(
    "SELECT token_id FROM newapi_keys WHERE user_id = ?"
  )
    .bind(user.id)
    .all<{ token_id: number }>()
  const knownIds = new Set((known.results ?? []).map((r) => r.token_id))

  const now = new Date().toISOString()
  const toAdd = remote.filter((t) => !knownIds.has(t.id))

  if (toAdd.length > 0) {
    await env.DB.batch(
      toAdd.map((t) =>
        env.DB.prepare(
          `INSERT INTO newapi_keys (id, user_id, token_id, name, key_prefix, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(
          uuid(),
          user.id,
          t.id,
          t.name || `token-${t.id}`,
          t.key,
          new Date((t.created_time || 0) * 1000).toISOString() || now
        )
      )
    )
  }

  const rows = await env.DB.prepare(
    "SELECT id, token_id, name, key_prefix, created_at FROM newapi_keys WHERE user_id = ? ORDER BY created_at DESC"
  )
    .bind(user.id)
    .all()

  return json({
    added: toAdd.length,
    keys: (rows.results ?? []).map((r: Record<string, unknown>) => ({
      id: r.id,
      tokenId: r.token_id,
      name: r.name,
      maskedKey: r.key_prefix,
      createdAt: r.created_at,
    })),
  })
}