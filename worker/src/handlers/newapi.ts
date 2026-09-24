/**
 * AI 中转站（NewAPI 集成）。
 *
 * 开通流程（OIDC + 复用 cloud 密码）：
 *   1. 用户在 NewAPI 用「Doulor Cloud 登录」（OIDC）—— 这一步在 NewAPI 建号
 *      并写入 oidc_id（= 本站 users.id）。
 *   2. 回到本站点「开通」：输入 Doulor Cloud 密码。
 *   3. 本站校验该密码确实是 cloud 密码，再按用户名在 NewAPI 找到账号，
 *      验证其 oidc_id 等于当前用户 id（防止绑定到别人的同名账号）。
 *   4. 用管理员接口 `PUT /api/user` 给该账号补上这个密码（NewAPI 负责哈希）。
 *   5. 服务端用「用户名 + 密码」登录换 session，再换长期 access token，加密存库。
 *
 * 为什么必须补一个密码：NewAPI 只能用「密码登录得到的 session」换取
 * access token（`/api/user/token` 需要 UserAuth + session），而本站代用户
 * 建 Key、查额度都依赖这个 token。OIDC 账号本身没有密码，所以要用
 * 「复用的 cloud 密码」补上，实现两边同一个密码。
 *
 * 明文密码只在第 3、4 步短暂出现，绝不落库。access token 加密存储，
 * 仅用于代用户创建 API Key；用户可在 NewAPI 后台随时吊销。
 */
import { ApiError, json } from "../http"
import { encryptSecret, decryptSecret, uuid, verifyPassword } from "../crypto"
import { requireFeatureUser } from "../auth"
import {
  adminSetQuota,
  adminSetUserPassword,
  adminSetUserStatus,
  createApiKey,
  deleteApiKey,
  findUserByUsername,
  getCurrencyInfo,
  getUserSelf,
  isNewApiConfigured,
  listModels,
  listPricing,
  listTokens,
  login,
  redeemCode,
  checkHealth,
  changePassword as changePasswordRemote,
} from "../newapi-client"
import { audit, getSetting, getSettings, parseRecommendedModels } from "../settings"
import { hasFeature, parsePermissions, parseOpenFeatures } from "../permissions"
import { requireAdmin } from "./admin"
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

// ---- 状态 ----

/** GET /api/dev/status —— 开通状态、额度、模型列表 */
export async function getStatus(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "ai")
  const settings = await getSettings(env)
  const configured = await isNewApiConfigured(env)
  const account = configured ? await loadAccount(env, user.id) : null

  // 币种与换算率以 NewAPI 站点为准
  const currency = configured
    ? await getCurrencyInfo(env)
    : { symbol: "$", code: "USD", perUnit: Number(settings.newapi_quota_per_unit) }
  const perUnit = currency.perUnit

  // 中转站健康状态（在线/离线 + 延迟），供界面顶部徽章显示
  const health = await checkHealth(env)

  const base = {
    configured,
    featureEnabled: settings.newapi_enabled === "1",
    // 仅 @doulor.cn 邮箱可开通 —— 这是本功能的核心限制
    eligibleEmail: `${user.username}@${env.ROOT_DOMAIN}`,
    currencySymbol: currency.symbol,
    currencyCode: currency.code,
    trialQuotaUsd: quotaToDisplay(Number(settings.newapi_trial_quota), perUnit),
    group: settings.newapi_group,
    health,
    /** 管理员维护的推荐模型分档（数组顺序即梯队顺序） */
    recommended: parseRecommendedModels(settings.newapi_recommended_models),
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
  // 未开通也要给出可用分组（前端用于说明默认/付费分组的差异）
  if (!account) {
    const pricing = await listPricing(env)
    return json({
      ...base,
      models: [],
      modelGroups: [],
      availableGroups: collectGroups(pricing),
      groupModels: {},
    })
  }

  let models: string[] = []
  try {
    const { token, userId } = await decryptAccountToken(env, account)
    models = await listModels(env, token, userId)
  } catch (err) {
    console.error("获取模型列表失败:", err)
  }

  // 按分组归类模型（默认分组 / 付费分组 / 捐献分组分开显示）
  const pricing = await listPricing(env)
  const availableGroups = collectGroups(pricing)

  // 「捐献」分组：模型名以 donation 开头的，统一归到这里，
  // 不再出现在 default / 付费分组里（管理员用来标记「捐献解锁的模型」）。
  const isDonationModel = (name: string) => /^donation/i.test(name)
  const donationModels = new Set(
    pricing
      .filter((p) => models.includes(p.model) && isDonationModel(p.model))
      .map((p) => p.model)
  )

  const groupModels: Record<string, string[]> = {}
  for (const g of availableGroups) {
    groupModels[g] = pricing
      .filter(
        (p) =>
          p.groups.includes(g) &&
          models.includes(p.model) &&
          !donationModels.has(p.model)
      )
      .map((p) => p.model)
  }

  // 有捐献模型时才追加「捐献」分组（排在最后）
  if (donationModels.size > 0) {
    availableGroups.push("donation")
    groupModels["donation"] = Array.from(donationModels)
  }

  return json({
    ...base,
    models,
    /** 可用分组名列表（顺序：默认分组在前） */
    availableGroups,
    /** 分组 → 该分组可用模型；仅包含用户可用的模型 */
    groupModels,
    /** 用户当前账号所属分组 */
    accountGroup: account.group_name,
    /** 管理员维护的推荐模型分档（数组顺序即梯队顺序） */
    recommended: parseRecommendedModels(settings.newapi_recommended_models),
  })
}

/** 收集全部分组名，默认分组排在最前 */
function collectGroups(pricing: { groups: string[] }[]): string[] {
  const set = new Set<string>()
  for (const p of pricing) for (const g of p.groups) set.add(g)
  const all = [...set]
  return all.sort((a, b) => {
    if (a === "default") return -1
    if (b === "default") return 1
    return a.localeCompare(b, "zh-CN")
  })
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
  const user = await requireFeatureUser(env, request, "ai")
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

/**
 * GET /api/dev/preflight —— 开通前的账号探测。
 *
 * 决定前端该展示哪套流程，避免让用户猜：
 *   - 中转站已有同名账号、且已用 OIDC 绑定（oidc_id === 本站用户 id）
 *     → 可以直接补密码开通
 *   - 没有 / 未 OIDC 绑定 → 先引导用户去中转站用 Doulor Cloud 登录
 *
 * 只回传「是否存在」与「是否已 OIDC 绑定」，**不泄露**该账号的邮箱、额度等资料。
 */
export async function preflight(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "ai")
  const settings = await getSettings(env)

  const base = {
    featureEnabled: settings.newapi_enabled === "1",
    username: user.username,
  }

  if (!(await isNewApiConfigured(env)) || settings.newapi_enabled !== "1") {
    return json({ ...base, exists: false, oidcBound: false })
  }

  let exists = false
  let oidcBound = false
  try {
    const remote = await findUserByUsername(env, user.username)
    exists = Boolean(remote)
    oidcBound = remote?.oidc_id === user.id
  } catch (err) {
    // 探测失败不阻断：按「不存在」处理，后续绑定仍会给出真实错误
    console.error("探测 NewAPI 账号失败:", err)
  }

  return json({ ...base, exists, oidcBound })
}

/** POST /api/dev/bind —— 开通 AI 中转站账号 */
export async function bindAccount(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "ai")
  if (!(await isNewApiConfigured(env))) {
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

  // ⚠️ 「复用 cloud 密码」：先验证用户输入的确实是本站密码，
  // 才把它同步设到 NewAPI。这样开通后两边共用同一个密码。
  if (!(await verifyPassword(password, user.password_hash))) {
    throw new ApiError(401, "密码错误：请输入你的 Doulor Cloud 登录密码", "INVALID_PASSWORD")
  }

  // 先确认具备加密密钥再产生任何副作用
  const secret = requireEncryptionSecret(env)
  const username = user.username

  // 找到 NewAPI 侧账号。它必须是「用 OIDC 登录」创建出来的 ——
  // 即该账号的 oidc_id 等于当前 cloud 用户的 id。
  const remote = await findUserByUsername(env, username)
  if (!remote) {
    throw new ApiError(
      409,
      "中转站里还没有你的账号。请先点击「去中转站用 Doulor Cloud 登录」完成授权，再回来开通",
      "OIDC_NOT_BOUND"
    )
  }
  if (remote.oidc_id !== user.id) {
    throw new ApiError(
      409,
      "中转站里的同名账号不是用 Doulor Cloud 登录创建的，无法安全绑定。请先在中转站用 Doulor Cloud 登录该账号",
      "OIDC_MISMATCH"
    )
  }

  const settings2 = await getSettings(env)
  const unlimited = settings2.newapi_unlimited_quota === "1"

  // 1. 给 OIDC 账号补一个密码（= 复用的 cloud 密码），
  //    之后才能用它登录换 access token
  await adminSetUserPassword(env, remote.id, username, password)

  // 2. 设试用额度
  if (!unlimited) {
    await adminSetQuota(
      env,
      remote.id,
      Number(settings2.newapi_trial_quota),
      "override"
    )
  }

  // 3. 登录直接拿长期 access token（rc.40 起登录响应里直接返回 access_token）
  const loginResult = await login(env, username, password)
  const accessToken = loginResult.accessToken

  const now = new Date().toISOString()
  const email = `${username}@${env.ROOT_DOMAIN}`.toLowerCase()

  await env.DB.prepare(
    `INSERT INTO newapi_accounts
       (user_id, newapi_user_id, username, email, enc_token, group_name, quota, used_quota, request_count, synced_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`
  )
    .bind(
      user.id,
      loginResult.userId,
      username,
      email,
      await encryptSecret(accessToken, secret),
      settings2.newapi_group,
      unlimited ? 0 : Number(settings2.newapi_trial_quota),
      now,
      now
    )
    .run()

  await audit(
    env,
    user.id,
    "newapi.bind",
    `开通 AI 中转站账号 ${username} (id ${loginResult.userId})，通过 OIDC 绑定并复用 cloud 密码`
  )

  return json(
    {
      account: {
        newapiUserId: loginResult.userId,
        username,
        email,
        quota: unlimited ? 0 : Number(settings2.newapi_trial_quota),
        group: settings2.newapi_group,
        unlimited,
      },
    },
    201
  )
}

// ---- API Key ----

/** GET /api/dev/keys —— 已创建的 Key（掩码） */
export async function listKeys(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "ai")
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
  const user = await requireFeatureUser(env, request, "ai")
  const account = await loadAccount(env, user.id)
  if (!account) throw new ApiError(404, "尚未开通 AI 中转站", "NOT_BOUND")

  const body = (await request.json()) as { name?: string; group?: string }
  const name = (body.name ?? "").trim().slice(0, 50) || `doulor-${user.username}`

  // 分组：默认使用 default 分组；用户也可选付费分组。
  // 必须是 NewAPI 侧真实存在的分组，避免建出用不了的 Key。
  const pricing = await listPricing(env)
  const availableGroups = collectGroups(pricing)
  const defaultGroup = availableGroups.includes("default")
    ? "default"
    : (availableGroups[0] ?? "")
  const group = (body.group ?? "").trim() || defaultGroup
  if (availableGroups.length > 0 && !availableGroups.includes(group)) {
    throw new ApiError(400, "无效的分组", "INVALID_GROUP")
  }

  const { token, userId } = await decryptAccountToken(env, account)
  const created = await createApiKey(env, token, userId, name, group)

  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO newapi_keys (id, user_id, token_id, name, key_prefix, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(uuid(), user.id, created.tokenId, name, created.maskedKey, now)
    .run()

  await audit(
    env,
    user.id,
    "newapi.key.create",
    `创建 API Key「${name}」（分组 ${group || "默认"}）`
  )

  return json(
    {
      key: {
        tokenId: created.tokenId,
        name,
        group,
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
  const user = await requireFeatureUser(env, request, "ai")
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
  const user = await requireFeatureUser(env, request, "ai")
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
// ---- 额度兑换 ----

/**
 * POST /api/dev/redeem —— 用兑换码（邀请码）充值额度。
 * 兑换码由管理员在 NewAPI 后台生成；本站只做转发与额度同步。
 */
export async function redeem(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "ai")
  const account = await loadAccount(env, user.id)
  if (!account) throw new ApiError(404, "尚未开通 AI 中转站", "NOT_BOUND")

  const body = (await request.json()) as { code?: string }
  const code = (body.code ?? "").trim()
  if (!code) throw new ApiError(400, "请输入兑换码", "INVALID_INPUT")
  if (code.length > 128) throw new ApiError(400, "兑换码过长", "INVALID_INPUT")

  const { token, userId } = await decryptAccountToken(env, account)
  const result = await redeemCode(env, token, userId, code)

  // 兑换成功后立即同步最新额度，前端无需再点一次同步
  let quota = account.quota
  try {
    const self = await getUserSelf(env, token, userId)
    quota = self.quota ?? account.quota
    await env.DB.prepare(
      `UPDATE newapi_accounts
          SET quota = ?, used_quota = ?, request_count = ?, synced_at = ?
        WHERE user_id = ?`
    )
      .bind(
        quota,
        self.used_quota ?? account.used_quota,
        self.request_count ?? account.request_count,
        new Date().toISOString(),
        user.id
      )
      .run()
  } catch (err) {
    console.error("兑换后同步额度失败:", err)
  }

  await audit(
    env,
    user.id,
    "newapi.redeem",
    `兑换码充值 +${result.added} quota`
  )

  const currency = await getCurrencyInfo(env)
  return json({
    added: result.added,
    addedDisplay: Math.round((result.added / currency.perUnit) * 10000) / 10000,
    currencySymbol: currency.symbol,
    quota,
    message: "兑换成功",
  })
}

// ---- 修改中转站密码 ----

/**
 * POST /api/dev/password —— 修改 NewAPI 账号密码。
 * 需提供原密码校验；修改后 NewAPI 侧的登录态会失效，但已存的
 * access token 仍可用于代建 Key（不受影响）。
 */
export async function changePassword(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "ai")
  const account = await loadAccount(env, user.id)
  if (!account) throw new ApiError(404, "尚未开通 AI 中转站", "NOT_BOUND")

  const body = (await request.json()) as {
    currentPassword?: string
    newPassword?: string
  }
  const currentPassword = body.currentPassword ?? ""
  const newPassword = body.newPassword ?? ""

  if (!currentPassword) {
    throw new ApiError(400, "请输入当前密码", "INVALID_INPUT")
  }
  if (newPassword.length < 8) {
    throw new ApiError(400, "新密码至少需要 8 位", "WEAK_PASSWORD")
  }

  const { token, userId } = await decryptAccountToken(env, account)
  await changePasswordRemote(
    env,
    token,
    userId,
    account.username,
    currentPassword,
    newPassword
  )

  await audit(env, user.id, "newapi.password.change", "修改中转站密码")
  return json({ ok: true, message: "中转站密码已修改" })
}

// ---- 权限同步（供定时运维调用）----

/**
 * 判断某用户「当前是否应该有 AI 中转站权限」。
 *
 * 与 `requireFeatureUser` 的判据**完全一致**，绝不能在这里另写一套逻辑，
 * 否则会出现「云上能访问、但这里判定无权限」或反之的漂移：
 *   1. 管理员始终放行（豁免）
 *   2. 有 ai 功能权限 → 放行
 *   3. ai 在「免权限开放」列表（open_features）里 → 放行
 */
function shouldHaveAiAccess(
  role: string,
  permissionsRaw: string | null | undefined,
  openFeatures: Set<string>
): boolean {
  if (role === "admin") return true
  const perms = parsePermissions(permissionsRaw)
  if (hasFeature(perms, "ai")) return true
  return openFeatures.has("ai")
}

export interface NewApiSyncResult {
  /** 账号已不存在、被清理的 cloud 记录数 */
  removedOrphans: number
  /** 本次被禁用的账号数 */
  disabled: number
  /** 本次被启用的账号数 */
  enabled: number
  /** 处理过程中出错的信息（不阻断，只记录） */
  errors: string[]
}

/**
 * 每小时一次的「NewAPI 权限同步」。
 *
 * 做两件事：
 *   1. **孤儿清理**：cloud 的 newapi_accounts 记录指向的 NewAPI 账号若已不存在
 *      （用户在中转站被删了），删掉 cloud 侧记录 → 用户界面回到「未开通」。
 *   2. **权限对齐**：用户的 cloud ai 权限被收回（或免权限开关关闭）时，
 *      在 NewAPI 侧 disable 该账号（其 API Key 立即失效）；
 *      权限恢复时再 enable 回来。
 *
 * ⚠️ 为什么放定时任务而不是实时：权限变更最长延迟 1 小时生效，可接受；
 * 且 NewAPI 的 disable 会清 token 缓存，代价不低，不宜高频触发。
 * 管理员（admin）永远豁免，不会被禁用。
 */
export async function syncPermissionState(env: Env): Promise<NewApiSyncResult> {
  const result: NewApiSyncResult = {
    removedOrphans: 0,
    disabled: 0,
    enabled: 0,
    errors: [],
  }

  if (!(await isNewApiConfigured(env))) return result

  const openFeatures = parseOpenFeatures(
    (await getSetting(env, "open_features")) ?? ""
  )

  // 拉取所有已开通的 cloud 用户及其 NewAPI 账号
  const rows = await env.DB.prepare(
    `SELECT na.user_id, na.newapi_user_id, na.username,
            u.role, u.permissions
       FROM newapi_accounts na
       JOIN users u ON u.id = na.user_id
      WHERE u.status = 'active'`
  ).all<{
    user_id: string
    newapi_user_id: number
    username: string
    role: string
    permissions: string | null
  }>()

  for (const row of rows.results ?? []) {
    try {
      // 1) 孤儿检测：按用户名查 NewAPI，查不到（或 id 对不上）就删 cloud 记录
      const remote = await findUserByUsername(env, row.username)
      if (!remote || remote.id !== row.newapi_user_id) {
        await env.DB.prepare(
          "DELETE FROM newapi_accounts WHERE user_id = ?"
        )
          .bind(row.user_id)
          .run()
        result.removedOrphans++
        continue
      }

      // 2) 权限对齐
      const shouldHave = shouldHaveAiAccess(
        row.role,
        row.permissions,
        openFeatures
      )
      const remoteDisabled = remote.status === 2 // NewAPI 里 status=2 是禁用

      if (shouldHave && remoteDisabled) {
        await adminSetUserStatus(env, row.newapi_user_id, "enable")
        result.enabled++
      } else if (!shouldHave && !remoteDisabled) {
        await adminSetUserStatus(env, row.newapi_user_id, "disable")
        result.disabled++
      }
    } catch (err) {
      result.errors.push(
        `${row.username}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  return result
}

/**
 * POST /api/admin/newapi/sync-permissions —— 管理员手动触发一次权限同步。
 *
 * 定时任务每小时跑一次，但管理员可能想立即看到效果（例如刚删了某个
 * NewAPI 账号、或刚收回某人权限，想马上清理/封禁）。这个接口立即执行
 * 一次 syncPermissionState 并返回结果，方便验证与排障。
 */
export async function adminSyncPermissions(
  env: Env,
  request: Request
): Promise<Response> {
  await requireAdmin(env, request)
  const result = await syncPermissionState(env)
  return json({ ...result })
}
