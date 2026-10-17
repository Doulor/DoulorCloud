/**
 * 捐献通道：WorkBuddy 反代账号（登录即解锁 AI 权限）。
 *
 * 与 donations.ts 的关系：**并行通道，不是同一张表**。donations 是
 * 「提交 → pending → 管理员审核 → 解锁」的人工流程；本通道是「登录成功即解锁」，
 * 免审核。两者的 payload 校验、pending 去重、通知邮箱要求都不同，硬塞进
 * DONATION_TYPES 会让两套语义打架，故独立建表（wb2api_bindings）。
 *
 * 权限回收的准确性是这里最需要小心的地方：用户的 `ai` 权限可能来自
 *   ① 本通道的绑定  ② donations 里 approved 的 ai 渠道捐献  ③ 邀请码注册时带的权限
 * 其中 ③ **无法溯源**（注册时直接把 invite.permissions 写进 users.permissions，
 * 没有反向索引）。因此移除绑定时按「有依据就不收回」的原则实时判定，
 * 并在管理端留一个人工覆盖开关，让管理员处理 ③ 那种情况。
 */
import { ApiError, json } from "../http"
import { generateToken, hashToken, uuid } from "../crypto"
import { requireUser, type UserRow, isAnyAdmin } from "../auth"
import {
  parsePermissions,
  featurePermissionSql,
  featurePermittedGuard,
  notWhitelistedGuard,
  type Feature,
} from "../permissions"
import { audit, getSetting, getSettingBool, getSettingNumber } from "../settings"
import { clientIp, guardRateLimit } from "../ratelimit"
import { grantDonationReward } from "../points"
import { sendMail, renderMail } from "../mailer"
import {
  getWb2ApiCredentialInfo,
  isWb2ApiConfigured,
  probeWb2ApiCredential,
  saveWb2ApiKey,
  Wb2StateGoneError,
  Wb2UnauthorizedError,
  wb2ImportCockpit,
  wb2Overview,
  wb2Poll,
  wb2RemoveAccount,
  wb2Start,
  type Wb2ImportResult,
} from "../wb2api-client"
import { grantInviteReward } from "../invite-rewards"
// 复用「强制通知」那套：发通知时收权限存快照，撤回时精确还原
import { restrictUserFeatures, restoreUserFeatures } from "./notices"
import type { Env } from "../env"

/** 本站登录会话与网关 state 的 15 分钟有效期对齐 */
const SESSION_TTL_MS = 15 * 60 * 1000

/** 允许对接的上游域（与设置项 wb2api_realm 的取值域一致） */
const REALMS = ["cn", "global"] as const
type Realm = (typeof REALMS)[number]

/**
 * 归一化「这次登录对接哪个域」。
 *
 * 2026-09-30 起改为**用户自选**（站长要求）：捐献时自己挑国内版 / 国际版，
 * 不再被管理员的全站设置定死。设置项 `wb2api_realm` 退化为**默认选中项**。
 *
 * 返回 null 表示「没选 / 选了非法值」→ 调用方回落到管理员默认。
 * 必须服务端校验：前端传什么都得在这收口，否则等于给了个任意字符串。
 */
function normalizeRealm(v: unknown): Realm | null {
  const s = String(v ?? "").trim().toLowerCase()
  return (REALMS as readonly string[]).includes(s) ? (s as Realm) : null
}

/**
 * 当前允许对接的上游域（2026-10-03 站长要求：国内版/国际版可用开关）。
 *
 * 捐献/邀请里用户本可自选国内版/国际版，但管理员可以关掉其中一项 ——
 * 关掉的版本在捐献页隐藏、接口拒绝绑定。返回空数组 = 通道实际不可用。
 */
export async function availableRealms(env: Env): Promise<Realm[]> {
  const out: Realm[] = []
  if (await getSettingBool(env, "wb2api_realm_cn")) out.push("cn")
  if (await getSettingBool(env, "wb2api_realm_global")) out.push("global")
  return out
}

interface BindingRow {
  id: string
  user_id: string
  uid: string
  nickname: string | null
  realm: string
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
  status: string
  result_json: string | null
  message: string | null
  acknowledged_ip: string | null
  /** 发起登录那一刻的网关池 uid 快照（JSON 数组）；老会话为 null */
  pool_uids_json: string | null
  created_at: string
  expires_at: string
}

async function requireAdminUser(env: Env, request: Request): Promise<UserRow> {
  const user = await requireUser(env, request)
  if (!isAnyAdmin(user.role)) {
    throw new ApiError(403, "需要管理员权限", "FORBIDDEN")
  }
  return user
}

/** 读取通道开关与限额 */
async function channelConfig(env: Env) {
  const enabled = (await getSetting(env, "wb2api_enabled")) === "1"
  const limit = await getSettingNumber(env, "wb2api_max_bindings")
  return { enabled, limit: Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 10 }
}

/** 当前用户 active 绑定的数量 */
async function activeBindingCount(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM wb2api_bindings WHERE user_id = ? AND status = 'active'"
  )
    .bind(userId)
    .first<{ c: number }>()
  return row?.c ?? 0
}

function toPublicBinding(row: BindingRow) {
  return {
    id: row.id,
    uid: row.uid,
    nickname: row.nickname,
    realm: row.realm,
    status: row.status,
    createdAt: row.created_at,
    removedAt: row.removed_at,
  }
}

// ---------------------------------------------------------------------------
// 用户端
// ---------------------------------------------------------------------------

/**
 * GET /api/wb2api/status —— 通道状态 + 当前用户的绑定列表。
 *
 * 捐献页与「已解锁」判断都读这里；`configured` 为 false 时前端整卡隐藏，
 * 避免用户点进去才发现没配好。
 */
export async function getStatus(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const { enabled, limit } = await channelConfig(env)
  const configured = await isWb2ApiConfigured(env)

  const rows = await env.DB.prepare(
    "SELECT * FROM wb2api_bindings WHERE user_id = ? ORDER BY created_at DESC"
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
    bindings: bindings.map(toPublicBinding),
  })
}

/**
 * POST /api/wb2api/login/start —— 发起登录，返回授权链接。
 *
 * body: { acknowledged: true, realm?: "cn" | "global" }
 *
 * `realm` 是**用户自选**的上游域（2026-09-30 起）：国内版 / 国际版由捐献者自己挑，
 * 不传或传非法值时回落到设置项 `wb2api_realm`（管理员设的默认）。
 *
 * `acknowledged` **必须在服务端校验**并连同来源 IP 落审计：这是「用户已被明确
 * 告知账号会进共享池、且可能被自动化任务使用」的证据，不能只靠前端勾选框。
 */
export async function loginStart(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json().catch(() => ({}))) as {
    acknowledged?: unknown
    realm?: unknown
  }

  if (body.acknowledged !== true) {
    throw new ApiError(
      400,
      "请先阅读并勾选免责声明：账号会加入共享池供其他用户使用",
      "ACKNOWLEDGEMENT_REQUIRED"
    )
  }

  const { enabled, limit } = await channelConfig(env)
  if (!enabled) {
    throw new ApiError(403, "反代账号捐献通道已关闭", "WB2API_DISABLED")
  }
  if (!(await isWb2ApiConfigured(env))) {
    throw new ApiError(
      503,
      "反代网关未配置访问密钥，请联系管理员",
      "WB2API_NOT_CONFIGURED"
    )
  }

  // 限流：发起一次就换一个上游 state，放任刷会白占网关内存与会话表
  const ip = clientIp(request)
  await guardRateLimit(
    env,
    `wb2api:start:user:${user.id}`,
    5,
    10 * 60,
    "发起登录过于频繁"
  )
  await guardRateLimit(env, `wb2api:start:ip:${ip}`, 10, 10 * 60, "发起登录过于频繁")

  // 限额：先查一次给用户明确的提示，避免走完整个 OAuth 才被拒
  const used = await activeBindingCount(env, user.id)
  if (used >= limit) {
    throw new ApiError(
      409,
      `最多只能绑定 ${limit} 个账号，你已绑定 ${used} 个`,
      "WB2API_LIMIT_REACHED"
    )
  }

  // 用户自选的上游域；没选或非法 → 用管理员设的默认（wb2Start 内部读 wb2api_realm）
  const chosenRealm = normalizeRealm(body.realm)

  // 国内版/国际版开关校验（2026-10-03 站长要求）：关掉的版本不可选
  const allowed = await availableRealms(env)
  if (allowed.length === 0) {
    throw new ApiError(503, "反代账号通道当前不可用", "WB2API_NO_REALM")
  }
  if (chosenRealm && !allowed.includes(chosenRealm)) {
    throw new ApiError(403, "该版本已停用，请选择其他版本", "WB2API_REALM_DISABLED")
  }
  const defaultRealm: Realm =
    (await getSetting(env, "wb2api_realm")).trim().toLowerCase() === "global" ? "global" : "cn"
  // 最终用的域：用户选且开放 → 用它；否则用默认（若默认被关则落到第一个仍开放的）
  const effectiveRealm: Realm =
    chosenRealm && allowed.includes(chosenRealm)
      ? chosenRealm
      : allowed.includes(defaultRealm)
        ? defaultRealm
        : allowed[0]

  const started = await wb2Start(env, effectiveRealm)

  // 拍一张「此刻网关池里有哪些账号」的快照，随会话落库。
  //
  // 为什么不在 poll 时查池：网关的 login/poll 会**先**把登录成功的账号
  // `Pool.Add` 进池、**再**返回结果（见网关 internal/panel/login.go）。等本站
  // poll 拿到 uid 时，这个账号必然已在池中 —— 事后查池无法区分「用户带来的新账号」
  // 与「本来就在池里的账号」。快照必须取在「用户还没登录完」之前。
  //
  // 查询失败不阻断（网关抖动时不能让整个登录流程挂掉）：快照落 null，
  // poll 时按「未知」处理 —— 允许绑定但不发邀请奖励。
  let poolUidsJson: string | null = null
  try {
    const overview = await wb2Overview(env)
    poolUidsJson = JSON.stringify(overview.accounts.map((a) => a.uid))
  } catch (err) {
    console.error("拍网关池快照失败，本次绑定将不发邀请奖励:", err)
  }

  // 本站 session_id 下发前端，网关 state 只留在服务端：
  // state 就是换取 token 的凭据，泄露给他人等于把账号送人。
  const sessionId = generateToken()
  const now = new Date()
  await env.DB.prepare(
    `INSERT INTO wb2api_login_sessions
       (id, user_id, upstream_state, realm, status, acknowledged_ip,
        pool_uids_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
  )
    .bind(
      await hashToken(sessionId),
      user.id,
      started.state,
      started.realm,
      ip,
      poolUidsJson,
      now.toISOString(),
      new Date(now.getTime() + SESSION_TTL_MS).toISOString()
    )
    .run()

  await audit(
    env,
    user.id,
    "wb2api.login.start",
    `发起反代账号登录（realm=${started.realm}${chosenRealm ? "，用户自选" : "，用管理员默认"}）`,
    ip
  )

  return json({ sessionId, url: started.url, realm: started.realm })
}

/**
 * GET /api/wb2api/login/poll?session= —— 轮询登录结果。
 *
 * 终态缓存是关键：网关 poll 成功一次后 state 即从内存删除，重复 poll 只会 404。
 * 因此本地 `done`/`failed` 直接回快照，只有 `pending` 才打上游。
 */
export async function loginPoll(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const sessionId = new URL(request.url).searchParams.get("session") ?? ""
  if (!sessionId) {
    throw new ApiError(400, "缺少 session 参数", "INVALID_INPUT")
  }

  await guardRateLimit(
    env,
    `wb2api:poll:user:${user.id}`,
    60,
    5 * 60,
    "轮询过于频繁"
  )

  const sess = await env.DB.prepare(
    "SELECT * FROM wb2api_login_sessions WHERE id = ?"
  )
    .bind(await hashToken(sessionId))
    .first<SessionRow>()

  if (!sess) {
    throw new ApiError(404, "会话不存在，请重新发起登录", "SESSION_NOT_FOUND")
  }
  // 归属校验：A 拿到 B 的 session_id 也不能替他完成绑定
  if (sess.user_id !== user.id) {
    throw new ApiError(403, "该会话不属于当前账号", "FORBIDDEN")
  }

  // 终态直回，不再打上游
  if (sess.status === "done") {
    return json({ status: "done", result: parseResult(sess.result_json) })
  }
  if (sess.status === "failed") {
    return json({ status: "failed", message: sess.message ?? "登录失败" })
  }

  if (new Date(sess.expires_at).getTime() < Date.now()) {
    await failSession(env, sess.id, "登录会话已过期，请重新发起")
    return json({ status: "failed", message: "登录会话已过期，请重新发起" })
  }

  let polled
  try {
    polled = await wb2Poll(env, sess.upstream_state)
  } catch (err) {
    if (err instanceof Wb2StateGoneError) {
      // 网关那边 state 已被消费或网关重启 —— 本站无法再取回结果
      const msg = "登录会话已失效（网关侧已过期），请重新发起"
      await failSession(env, sess.id, msg)
      return json({ status: "failed", message: msg })
    }
    // 网关拒绝密钥（Wb2UnauthorizedError）不再单独包装：它本身就是
    // `ApiError(502, "…请联系管理员检查「捐献通道」里配置的网关密钥", "WB2API_UNAUTHORIZED")`，
    // 落到下面的 `throw err` 即可 —— 多包一层只会把可操作文案换短。
    // 超时（本站主动放弃等待）：网关那一次 poll 可能仍在跑，也可能已经完成
    // 落盘 + 热加载 —— 它的 handler 不因客户端断开而停止。所以这里必须给出
    // 可操作的文案：让用户重新发起一次登录即可完成绑定（重新登录同一账号会命中
    // 幂等/新快照逻辑，不会再被池去重挡死）。
    if (err instanceof ApiError && err.code === "WB2API_TIMEOUT") {
      const msg =
        "反代网关响应超时。你的账号可能已加入共享池，请关闭后重新发起一次登录即可完成绑定"
      await failSession(env, sess.id, msg)
      return json({ status: "failed", message: msg })
    }
    throw err
  }

  if (!polled.done) {
    return json({
      status: "pending",
      message: polled.pendingMessage ?? "等待浏览器完成登录",
    })
  }

  const result = await completeBinding(env, user, sess, {
    uid: polled.uid!,
    nickname: polled.nickname ?? null,
    realm: polled.realm ?? "cn",
    credits: polled.credits,
    creditsTotal: polled.creditsTotal,
  })
  return json({ status: "done", result })
}

/** 把会话标记为失败（终态缓存，避免下次再打上游） */
async function failSession(env: Env, id: string, message: string): Promise<void> {
  // 只在仍是 pending 时才落 failed：poll 可能被并发调用（前端 3 秒轮询 + 单次
  // poll 本身可能跑十几秒，两个请求会重叠），其中一个成功写了 done 之后，
  // 另一个拿到的只是「state 已失效」——若无条件覆盖，会把成功结果抹成失败。
  await env.DB.prepare(
    "UPDATE wb2api_login_sessions SET status = 'failed', message = ? WHERE id = ? AND status = 'pending'"
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
 * 解析 start 时拍的网关池 uid 快照。
 *
 * 返回 null 表示「快照不可用」（老会话没有这列、或内容坏了）——调用方按
 * 「未知」处理：不阻断绑定，但不发邀请奖励。空数组是合法值（发起登录时池是空的）。
 */
function parsePoolSnapshot(raw: string | null): string[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as string[]) : null
  } catch {
    return null
  }
}

/**
 * 登录成功后的收尾：落库绑定 + 授予 ai 权限 + 记审计 + 发邮件。
 *
 * 幂等要点（`uid` 有唯一索引）：
 *   - 同一用户重复登录同一个 WorkBuddy 账号 → 幂等返回，不重复授权、不重复发邮件
 *   - 不同用户抢绑同一账号 → 拒绝并审计。**此时网关已经完成登录、凭证已进池**，
 *     本站不能撤销（调 remove 会把原绑主的可用账号摘掉），只能如实告知。
 */
async function completeBinding(
  env: Env,
  user: UserRow,
  sess: SessionRow,
  info: {
    uid: string
    nickname: string | null
    realm: string
    credits?: number
    creditsTotal?: number
  }
): Promise<Record<string, unknown>> {
  const existing = await env.DB.prepare(
    "SELECT * FROM wb2api_bindings WHERE uid = ?"
  )
    .bind(info.uid)
    .first<BindingRow>()

  // 「登录前是否已在网关池里」——决定这次绑定算不算「带来新资源」（影响邀请奖励）。
  //
  // 用 start 时拍的快照判断，**不能**现在查池：网关 poll 是先 `Pool.Add` 进池、
  // 再返回结果的，此刻查池必然命中自己刚登进去的账号（历史 bug：于是所有正常绑定
  // 都被误判为「重复绑定」直接拒绝，账号却已经进了池，用户永久卡死）。
  //
  // 快照缺失（老会话 / 拍快照时网关抖动）按「未知」处理：不阻断绑定，但不发奖励。
  const poolUids = parsePoolSnapshot(sess.pool_uids_json)
  const inPoolBefore = poolUids ? poolUids.includes(info.uid) : null
  if (inPoolBefore === null) {
    console.warn("会话缺少网关池快照，本次绑定不发邀请奖励:", sess.id)
  } else if (inPoolBefore && !existing) {
    // 池里本来就有、绑定表里却没登记 —— 通常是管理员手动加进池的账号，或历史遗留。
    // 用户确实登录了它，所以照常绑定 + 授权限；只是没带来新资源，不发邀请奖励。
    await audit(
      env,
      user.id,
      "wb2api.login.pool_existing",
      `绑定了一个登录前就已在池中的账号 uid=${info.uid}（照常绑定，不发邀请奖励）`
    )
  }

  if (existing && existing.user_id !== user.id) {
    const msg = "该 WorkBuddy 账号已被其他用户绑定"
    await failSession(env, sess.id, msg)
    await audit(
      env,
      user.id,
      "wb2api.login.conflict",
      `尝试绑定已被占用的账号 uid=${info.uid}（原绑定用户 ${existing.user_id}）`
    )
    throw new ApiError(409, msg, "WB2API_UID_TAKEN")
  }

  if (existing) {
    // 同一用户重复登录：把墓碑复活成 active，但**不再二次授权**（权限早已给过）
    if (existing.status !== "active") {
      await env.DB.prepare(
        "UPDATE wb2api_bindings SET status = 'active', removed_at = NULL, removed_by = NULL WHERE id = ?"
      )
        .bind(existing.id)
        .run()
    }
    const result = {
      uid: info.uid,
      nickname: info.nickname ?? existing.nickname,
      credits: info.credits ?? null,
      creditsTotal: info.creditsTotal ?? null,
      alreadyBound: true,
      aiGranted: false,
    }
    await env.DB.prepare(
      "UPDATE wb2api_login_sessions SET status = 'done', result_json = ? WHERE id = ?"
    )
      .bind(JSON.stringify(result), sess.id)
      .run()
    return result
  }

  // 建绑定：与「JSON 文件导入」共用同一段逻辑（见 createWb2Binding 的说明）。
  // ⚠️ 限额不足时它会抛错，这里补一次 failSession —— 原实现是「标失败 + 抛错」，
  // 保持行为不变（让前端立刻知道这次会话废了，而不是一直轮询）。
  let created: { id: string; aiGranted: boolean }
  try {
    created = await createWb2Binding(env, user, info, {
      acknowledgedIp: sess.acknowledged_ip,
      isNewToPool: inPoolBefore === false,
    })
  } catch (err) {
    if (err instanceof ApiError && err.code === "WB2API_LIMIT_REACHED") {
      await failSession(env, sess.id, err.message)
    }
    throw err
  }
  const { aiGranted } = created

  const result = {
    uid: info.uid,
    nickname: info.nickname,
    credits: info.credits ?? null,
    creditsTotal: info.creditsTotal ?? null,
    alreadyBound: false,
    aiGranted,
  }
  await env.DB.prepare(
    "UPDATE wb2api_login_sessions SET status = 'done', result_json = ? WHERE id = ?"
  )
    .bind(JSON.stringify(result), sess.id)
    .run()

  // 审计 / 捐献奖励 / 邀请奖励 / 通知邮件都已经在 createWb2Binding 里做过
  // （2026-10-10 抽出来给「登录绑定」和「JSON 文件导入」共用，避免两份逻辑分家）
  return result
}

// ---------------------------------------------------------------------------
// 管理端
// ---------------------------------------------------------------------------

/**
 * 建一条 wb 反代账号绑定（**登录成功**这条路的写入实现）。
 *
 * 为什么要抽出来：绑定不只是插一行 —— 它连带「判断该不该批 ai 权限 → 原子写回
 * permissions → 审计 → 捐献/邀请奖励 → 发通知邮件」。复制一份必然分家
 * （改一边漏一边），与 `public-api.ts` 里 `runAs` 的教训同源。
 *
 * ⚠️ 2026-10-17 起，「JSON 文件导入」**不再**复用它（见 `importWb2ApiAccounts`）：
 *    导入必须"先核验后发放"、且要批量写 + 只发一封邮件、只发一份积分，逐条调用
 *    这个函数做不到。两处的**收尾口径必须一致**（ai 判定 / 审计 / 通知撤回 / 积分 /
 *    邀请奖励 / 邮件），所以：**改这里的收尾逻辑，必须同步改导入路径那一份。**
 *
 * @param opts.acknowledgedIp 免责声明的来源 IP（留痕，证明用户被告知账号进共享池）
 * @param opts.isNewToPool    该账号在本次操作**之前**是否已在网关池里。
 *                            只有「真的给池子添了新东西」才发奖励 —— 绑一个管理员
 *                            早就手工加进池的账号不算贡献（原实现即此口径）。
 */
export async function createWb2Binding(
  env: Env,
  user: UserRow,
  info: { uid: string; nickname: string | null; realm: string },
  opts: { acknowledgedIp: string | null; isNewToPool: boolean }
): Promise<{ id: string; aiGranted: boolean }> {
  const { limit } = await channelConfig(env)
  const used = await activeBindingCount(env, user.id)
  if (used >= limit) {
    throw new ApiError(
      409,
      `最多只能绑定 ${limit} 个账号，你已绑定 ${used} 个`,
      "WB2API_LIMIT_REACHED"
    )
  }

  // 记录「本次绑定是否真的把 ai 从无变有」——移除时据此判断该不该收回。
  // ⚠️ 判断基于传入用户的快照（并发下可能偏保守）；写回走原子 json_set，
  // 不会覆盖并发写入的其他模块权限。
  // 先看「捐献授权开关」：关掉时绑定照常进池，只是不再授予 ai 权限。
  const aiGranted =
    (await getSettingBool(env, "donation_grant_wb2api")) &&
    !parsePermissions(user.permissions).ai

  const id = uuid()
  const now = new Date().toISOString()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO wb2api_bindings
         (id, user_id, uid, nickname, realm, status, granted_ai_permission,
          acknowledged_ip, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`
    ).bind(
      id,
      user.id,
      info.uid,
      info.nickname,
      info.realm,
      aiGranted ? 1 : 0,
      opts.acknowledgedIp,
      now
    ),
    ...(aiGranted
      ? [
          env.DB.prepare(
            `UPDATE users SET permissions = ${featurePermissionSql("ai", true)}, updated_at = ? WHERE id = ?`
          ).bind(now, user.id),
        ]
      : []),
  ])

  await audit(
    env,
    user.id,
    "wb2api.login.done",
    `反代账号已绑定 uid=${info.uid} nickname=${info.nickname ?? "-"}` +
      (aiGranted ? "（已解锁 AI 中转站权限）" : "（用户已有该权限，未重复授予）")
  )

  // 重新登录成功 ⇒ 撤回「账号失效」通知，被暂时收回的权限自动还原
  //（站长要求：登录失效的账号，用户重新登录原账号即可解锁）
  await revokeInvalidWbNotices(env, user.id)

  // 捐献奖励积分：只有「这次真的带来了新资源」（操作前不在网关池里）才发。
  // ⚠️ 不能只看「新建了绑定行」：池里本来就有、绑定表却没登记的情况是存在的，
  //    那时新建的只是一行绑定记录，用户并没有给池子添任何东西。
  if (opts.isNewToPool) {
    await grantDonationReward(env, {
      userId: user.id,
      kind: "workbuddy",
      dedupKey: `wb2api:${id}`,
      detail: "WorkBuddy 反代账号捐献奖励",
    })

    // 邀请奖励：还必须「真的从无到有解锁了 AI 权限」
    if (aiGranted) {
      const planId = await getSettingNumber(env, "invite_reward_plan_id")
      if (planId && planId > 0) {
        await grantInviteReward(env, user, planId)
      }
    }
  }

  // 通知邮件失败不影响绑定结果（权限已生效，只是少一封告知）
  try {
    const { text, html } = renderMail("反代账号绑定成功", [
      `WorkBuddy 账号：${info.nickname ?? info.uid}`,
      aiGranted
        ? "已为你解锁「AI 中转站」权限，可到该模块创建 API Key。"
        : "你的「AI 中转站」权限此前已解锁，本次绑定不影响。",
      "账号已加入共享池供其他用户使用；如需移除，请在捐献页撤销或联系管理员。",
    ])
    await sendMail(env, {
      to: user.email,
      subject: "【Doulor Cloud】反代账号绑定成功",
      text,
      html,
    })
  } catch (err) {
    console.error("反代绑定通知邮件发送失败:", user.email, err)
  }

  return { id, aiGranted }
}

/*
 * ---------------------------------------------------------------------------
 * JSON 导入的几条硬规则（2026-10-17，安全审计 #13 / #53 修复 —— 与 qoder2api 同口径）
 * ---------------------------------------------------------------------------
 *
 * 🔴 修复前的洞：上传 JSON 里的 `uid` 被直接当成「已入池的新账号」，
 *    对每个 uid 调用 `createWb2Binding(..., { isNewToPool: true })` ——
 *    而「是否真的进了网关池」**从未被核实过一次**（网关的导入接口只回计数、
 *    不回 uid 列表，老实现拿不到也就不查了）。
 *    于是 `[{"uid":"随便编一个"}]` 就能换到：`ai` 权限 + 一次捐献积分（kind=workbuddy）
 *    + 一个绑定位（外加邀请奖励），再顺着 `/api/dev/bind` → `/api/dev/subscription`
 *    → `/api/dev/key` 白嫖真实计费模型（报告 #13 → #11 那条变现链）。
 *
 * ⚠️ 与 qoder2api 的**唯一**差异在"怎么核实"：那边的池列表是
 *    `GET /accounts?realm=cn|intl`（两套区各拉一次）；wb 这边的池列表是
 *    `GET /panel/api/overview` —— 一次拿全池（含 disabled 标记），没有分页参数，
 *    cn/global 只是每个账号自己的 `realm` 字段、不是查询维度。
 *    也就是说这里**一次上游请求**就能完成全批核验，代价与 uid 数量无关。
 *
 * 现在的顺序（**发权益必须在校验之后**，因为发权限/发积分是不可逆副作用）：
 *   1. 本地解析 uid（形状校验 + 去重）→ 2. 本地查既有绑定（跳过/复活/名额）
 *   → 3. 只把候选行送去网关导入 → 4. **拉一次池概览逐 uid 核实存在性**
 *   → 5. 核验通过的才建绑定 → 6. 再写 ai 权限 → 7. 最后发积分。
 *
 * 两个显式取舍：
 *   · 上游不可用 ⇒ **fail-closed**（整批拒绝，不建绑定、不发任何东西）；
 *   · 部分失败 ⇒ **部分成功**（通过的发，失败的逐条列在 `rejected` 里）。
 *
 * ⚠️ 残余边界（诚实记录，与 qoder2api 一样）：池概览的"存在"是**存在性**背书，
 *    不是**归属**背书 —— 归属只有 OAuth 登录（poll）那条路才拿得到。若网关的
 *    `/panel/api/import/cockpit` 对凭据不做任何自校验就入池，伪造行仍可能进池
 *    （进而被本函数认成"存在"）。这一层只能在网关侧关掉，本站的缓解手段是
 *    管理端的号池观测（`adminGetPool` / `scanInvalidWb2Bindings`）与下面的 disabled 判定。
 */

/**
 * 单次导入最多处理的账号数（与 qoder2api 的 200 对齐）。
 *
 * 不设上限时，一个 5 MB 的 JSON 能塞几万个 uid，建绑定就是几万次 D1 往返，
 * 用户看到的是「500 服务器内部错误」而不是一句可读的提示。200 覆盖正常导出，
 * 也能在一两个 `DB.batch` 轮次内跑完。
 */
const MAX_IMPORT_ACCOUNTS = 200

/** D1 单条语句的绑定参数上限约 100 ⇒ `IN (...)` 查询按 90 分片 */
const SQL_IN_CHUNK = 90

/** 批量写绑定/复活时的单批语句数（一个 batch = 一次 D1 往返） */
const DB_BATCH_CHUNK = 25

/**
 * 账号标识的**形状**校验。
 *
 * 这不是安全边界（真正的边界是下面的上游池核实），只是一道便宜的本地闸门：
 * 把空串、控制字符、超长串这类明显不是账号的输入挡在 D1 与共享池之外 ——
 * 这类行进了共享池会污染池子，也会让审计日志不可读。
 * （cockpit 的 uid 是 UUID 形态，字符集与长度都落在这个范围内。）
 */
const UID_PATTERN = /^[A-Za-z0-9._:@+-]{1,128}$/

/** 核验不通过 / 无法绑定的账号（逐条回给前端，便于用户自己排查） */
interface RejectedAccount {
  uid: string
  reason: string
}

/** 池概览里我们核验时真正关心的字段（其余字段不用，别把上游全量结构带进来） */
interface PoolAccountLite {
  uid: string
  nickname?: string
  realm?: string
  disabled?: boolean
}

/**
 * 一次性把本批 uid 在本地的既有绑定读出来（**含墓碑**）。
 *
 * 一次 `IN (...)` 分片查询，而不是每个 uid 单查一次（N 次 D1 往返）。
 * 必须含 `status='removed'` 的行：uid 上有唯一索引，墓碑还在时直接 INSERT 会撞索引
 * 变成 500；正确做法是与 poll 路径一样「复活墓碑」。
 */
async function loadWb2BindingsByUid(
  env: Env,
  uids: string[]
): Promise<Map<string, { id: string; user_id: string; status: string }>> {
  const out = new Map<string, { id: string; user_id: string; status: string }>()
  for (let i = 0; i < uids.length; i += SQL_IN_CHUNK) {
    const chunk = uids.slice(i, i + SQL_IN_CHUNK)
    const rows = await env.DB.prepare(
      `SELECT id, user_id, uid, status FROM wb2api_bindings
        WHERE uid IN (${chunk.map(() => "?").join(",")})`
    )
      .bind(...chunk)
      .all<{ id: string; user_id: string; uid: string; status: string }>()
    for (const r of rows.results ?? []) out.set(r.uid, r)
  }
  return out
}

/** 分批执行写语句：一个 batch = 一次往返，比逐条 await 快一个量级 */
async function runInBatches(env: Env, statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += DB_BATCH_CHUNK) {
    await env.DB.batch(statements.slice(i, i + DB_BATCH_CHUNK))
  }
}

/**
 * POST /api/wb2api/import —— 上传 cockpit 导出的 JSON 文件，批量导入账号并绑定。
 *
 * 与「登录绑定」的区别：账号不是走授权流程进来的，而是用户手里已有的凭据文件。
 * 因为**文件内容是用户自述**、没有任何上游背书，所以必须去网关池核实（见上面的段注释）。
 *
 * ⚠️ 网关的导入接口**不返回导入后的 uid 列表**（只有总/成功/跳过计数），
 *    所以"核实"只能靠随后拉一次池概览（`GET /panel/api/overview`）做 uid→账号映射。
 *    解析不出任何一个 uid 就整体失败，绝不建「不知道绑了谁」的空绑定。
 *
 * ⚠️ 收尾（ai 权限 / 通知撤回 / 审计 / 积分 / 邀请奖励 / 邮件）这里是**批量版**，
 *    与 `createWb2Binding`（登录路径）是同一套口径 —— **改一处必须改两处**。
 *    没有直接复用 `createWb2Binding` 的原因有两个：① 它按单条绑定做完全套副作用
 *    （含一封邮件），一次导入 200 个账号就是 200 个 D1 事务 + 200 封出站邮件，
 *    Worker 的子请求与时长都扛不住；② 它的奖励幂等键是**新 uuid**（`wb2api:<绑定id>`），
 *    复用它就会让「一次导入 N 个账号发 N 份捐献积分」，与 qoder2api 的
 *    "一次导入算一次捐献"口径不一致。
 */
export async function importWb2ApiAccounts(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  await guardRateLimit(env, `wb2api:import:user:${user.id}`, 5, 3600, "导入过于频繁，请稍后再试")

  const { enabled, limit } = await channelConfig(env)
  if (!enabled) {
    throw new ApiError(403, "反代账号捐献通道已关闭", "WB2API_DISABLED")
  }
  if (!(await isWb2ApiConfigured(env))) {
    throw new ApiError(503, "反代网关未配置访问密钥，请联系管理员", "WB2API_NOT_CONFIGURED")
  }

  const form = await request.formData().catch(() => null)
  const file = form?.get("file")
  if (!(file instanceof File)) {
    throw new ApiError(400, "请选择要上传的 JSON 文件", "INVALID_INPUT")
  }
  if (file.size > 5 * 1024 * 1024) {
    throw new ApiError(400, "文件过大（上限 5 MB）", "FILE_TOO_LARGE")
  }

  const raw = await file.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ApiError(400, "文件不是合法的 JSON", "INVALID_JSON")
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ApiError(
      400,
      "文件里没有账号 —— 需要 cockpit 导出的 JSON 数组",
      "INVALID_JSON"
    )
  }

  // ---- 1) 解析出「想绑定」的账号标识（形状校验 + 去重，保留原始行） ----
  // 保留原始行是必须的：送去网关导入时要按原样回传凭据字段，不能只发 uid。
  const rowByUid = new Map<string, Record<string, unknown>>()
  const rejected: RejectedAccount[] = []
  for (const r of parsed as unknown[]) {
    const row = (r ?? {}) as Record<string, unknown>
    const uid = String(row.uid ?? "").trim()
    if (!uid) continue // 没有标识的行既无法校验也无法绑定
    if (!UID_PATTERN.test(uid)) {
      rejected.push({ uid: uid.slice(0, 64), reason: "账号标识格式非法" })
      continue
    }
    if (!rowByUid.has(uid)) rowByUid.set(uid, row)
  }
  const uids = Array.from(rowByUid.keys())
  if (uids.length === 0) {
    throw new ApiError(400, "文件里没有可用的账号（缺少 uid 字段）", "INVALID_JSON")
  }
  if (uids.length > MAX_IMPORT_ACCOUNTS) {
    // 早于任何上游调用就拒：超限的请求不该在网关上留下任何痕迹
    throw new ApiError(
      400,
      `一次最多导入 ${MAX_IMPORT_ACCOUNTS} 个账号（本次 ${uids.length} 个），请分批上传`,
      "IMPORT_TOO_LARGE"
    )
  }

  const now = new Date().toISOString()
  const ackIp = clientIp(request)
  const used = await activeBindingCount(env, user.id)
  let room = Math.max(0, limit - used)

  // 与 createWb2Binding 同一口径：只有「本次真的把 ai 从无变有」才记 granted=1
  const aiGranted =
    (await getSettingBool(env, "donation_grant_wb2api")) &&
    !parsePermissions(user.permissions).ai
  let granted = false

  // ---- 2) 本地分类：已在名下 / 自己的墓碑 / 别人的 / 超名额 ----
  const existingByUid = await loadWb2BindingsByUid(env, uids)

  const alreadyMine: string[] = []
  const skippedByLimit: string[] = []
  /**
   * 待上游核实的候选：`reviveId` 非空 = 复活自己的墓碑。墓碑也要过一遍存在性核验，
   * 口径与新建统一（不然"先删绑定、再伪造 uid 复活"就是另一条绕过路径）。
   */
  const candidates: { uid: string; reviveId: string | null }[] = []

  for (const uid of uids) {
    const existing = existingByUid.get(uid)
    if (existing && existing.user_id !== user.id) {
      // 网关账号 uid 全局唯一，被别人绑过就绝不能再绑一次（与 poll 的冲突判定同口径）
      rejected.push({ uid, reason: "该账号已被其他用户绑定" })
      continue
    }
    if (existing) {
      if (existing.status === "active") {
        alreadyMine.push(uid)
        continue
      }
      candidates.push({ uid, reviveId: existing.id })
      continue
    }
    if (room <= 0) {
      skippedByLimit.push(uid)
      continue
    }
    candidates.push({ uid, reviveId: null })
    // 名额先到先得地扣：宁少勿多 —— 不把超额的行塞进共享池。
    // 核验失败的候选让出的名额不回填（回填要么多打一次上游，要么把逻辑绕成两轮，不值）。
    room--
  }

  // ---- 3) 只把候选行送去网关（别把整份文件塞进共享池） ----
  // ⚠️ 这一步不产生任何本地权益：绑定、ai 权限、积分全部在后面核验通过之后才发生。
  let upstream: Wb2ImportResult = {}
  if (candidates.length > 0) {
    try {
      // 网关收 multipart 的 `file` 字段，内容仍是 JSON 文本；这里只序列化候选行，
      // 所以"已被别人绑定 / 超名额 / 格式非法"的行**根本不会进共享池**。
      upstream = await wb2ImportCockpit(
        env,
        JSON.stringify(candidates.map((c) => rowByUid.get(c.uid)))
      )
    } catch (err) {
      // 密钥错这类「管理员可修」的错误保持原样下抛，文案更可操作
      if (err instanceof Wb2UnauthorizedError) throw err
      /**
       * 🔴 fail-closed（默认且唯一分支）。
       *
       * 上游导入失败时**一个绑定都不建**。理由：此刻我们没有任何核验结果，
       * 无法区分「真账号」与「伪造 uid」；而发 ai 权限、发积分都是不可逆副作用，
       * 一旦放行就只能靠事后人工回收。反过来，拒绝对正常用户的代价只是
       * 「稍后重导一次」—— 两害相权，宁可失败也不放行。
       *
       * 注意上游可能已经吃进去一部分（HTTP 超时也可能入库成功），所以这里
       * 不假装状态干净：只保证**本站**没有因此产生任何绑定/权限/积分。
       */
      console.error("wb2api 导入调用失败，按 fail-closed 拒绝本次导入:", err)
      throw new ApiError(
        503,
        "上游网关暂时不可用，本次导入已取消（未建绑定、未发放任何权限或积分），请稍后重试",
        "WB2API_IMPORT_UNAVAILABLE"
      )
    }
  }

  // ---- 4) 向上游核实：这些 uid 是否真的在网关账号池里 ----
  const verified = new Map<string, PoolAccountLite>()
  if (candidates.length > 0) {
    let pool: PoolAccountLite[]
    try {
      /**
       * 批量策略：**一次概览拿全池**（`GET /panel/api/overview`，无分页、无 realm 维度），
       * 代价是常数级、与 uid 数量无关；绝不逐个 uid 打一次上游 —— 那样 1000 个 uid
       * 就是 1000 次请求，Worker 会先撞子请求/时长上限，同时把网关面板打成限流。
       */
      pool = (await wb2Overview(env)).accounts
    } catch (err) {
      // 同上：核验不了就不放行（fail-closed），而不是「查不到就当通过」。
      console.error("wb2api 账号池概览拉取失败，按 fail-closed 拒绝本次导入:", err)
      throw new ApiError(
        503,
        "无法向上游核实账号，本次导入已取消（未建绑定、未发放任何权限或积分），请稍后重试",
        "WB2API_VERIFY_UNAVAILABLE"
      )
    }

    const byUid = new Map(pool.map((a) => [a.uid, a]))
    for (const c of candidates) {
      const acc = byUid.get(c.uid)
      if (!acc) {
        // 上游不认这个 uid（伪造、或网关根本没接受这条导入）→ 不建绑定、不发权益
        rejected.push({
          uid: c.uid,
          reason: "上游账号池里查无此账号（伪造或导入被上游拒绝）",
        })
        continue
      }
      if (acc.disabled === true) {
        // 网关把「上游判定需要重新登录」的账号标成 disabled（如 11140 request illegal），
        // 这种账号进池也没用，按拒收处理；用户重新登录一次即可恢复正常绑定。
        rejected.push({ uid: c.uid, reason: "上游已禁用该账号（需重新登录后再绑定）" })
        continue
      }
      // 注：`paused`（运维临时让位）只影响派发、不影响账号有效性，故照常通过 ——
      // 与「disabled 才是账号坏了」这条网关语义保持一致。
      verified.set(c.uid, acc)
    }
  }

  // ---- 5) 核验通过的才落库（批量写，一次往返顶多条） ----
  const statements: D1PreparedStatement[] = []
  let newlyBound = 0
  let revived = 0
  /** 本次真正「新建」的第一个账号 uid —— 捐献积分的幂等键用它（下面有说明） */
  let firstNewUid = ""

  for (const c of candidates) {
    const acc = verified.get(c.uid)
    if (!acc) continue // 未通过核验：不建绑定、不发权限、不发积分
    const row = rowByUid.get(c.uid) ?? {}

    // 昵称优先用用户文件里的（更贴近本人习惯），其次用上游池里的
    const nickname = String(row.nickname ?? row.email ?? "").trim() || acc.nickname || null

    /**
     * realm 由 domain 推断，与网关内的判定一致（workbuddy.ai 家族 → global）。
     * 文件里没给 domain 时退回**池概览里该账号自带的 realm**（刚核实时拿到的事实，
     * 比无条件猜 'cn' 准）；仍不可信则回 'cn'，与历史行为一致。
     */
    const domain = String(row.domain ?? "").toLowerCase()
    const poolRealm = String(acc.realm ?? "").toLowerCase()
    const realm = domain
      ? domain.includes("workbuddy.ai")
        ? "global"
        : "cn"
      : poolRealm === "global" || poolRealm === "cn"
        ? poolRealm
        : "cn"

    if (c.reviveId) {
      // 复活墓碑：不动 granted_ai_permission（那是历史事实），昵称缺省时保留原值。
      // 与 poll 路径的「重复登录」同一处理：复活本身不算新贡献，不发奖励。
      statements.push(
        env.DB.prepare(
          `UPDATE wb2api_bindings
              SET status = 'active', removed_at = NULL, removed_by = NULL,
                  nickname = COALESCE(?, nickname), realm = ?
            WHERE id = ?`
        ).bind(nickname, realm, c.reviveId)
      )
      revived++
      continue
    }

    const grant = aiGranted && !granted
    if (grant) granted = true
    statements.push(
      env.DB.prepare(
        `INSERT INTO wb2api_bindings
           (id, user_id, uid, nickname, realm, status, granted_ai_permission,
            acknowledged_ip, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`
      ).bind(uuid(), user.id, c.uid, nickname, realm, grant ? 1 : 0, ackIp, now)
    )
    newlyBound++
    if (!firstNewUid) firstNewUid = c.uid
  }
  await runInBatches(env, statements)

  const bound = newlyBound + revived

  // ---- 6) 权限：核验通过并已落库之后才写，且只写一次 ----
  // 逐条绑定各 UPDATE 一次 users 纯属白费 D1 往返（同一行的同一个值）。
  if (granted) {
    await env.DB.prepare(
      `UPDATE users SET permissions = ${featurePermissionSql("ai", true)}, updated_at = ? WHERE id = ?`
    )
      .bind(now, user.id)
      .run()
  }

  // ---- 7) 重新绑定成功 ⇒ 撤回「账号失效」通知，被暂时收回的权限自动还原 ----
  // （站长要求：登录失效的账号，用户重新登录/重导原账号即可解锁；
  //   与 createWb2Binding 里的同一调用同口径，只是这里整批调一次。）
  if (bound > 0) {
    await revokeInvalidWbNotices(env, user.id)
  }

  await audit(
    env,
    user.id,
    "wb2api.import",
    `通过 JSON 文件导入反代账号：核验通过 ${bound} 个` +
      `（新建 ${newlyBound}、复活 ${revived}），拒绝 ${rejected.length} 个，` +
      `超名额 ${skippedByLimit.length} 个，已是本人 ${alreadyMine.length} 个` +
      (granted ? "（已解锁 AI 中转站权限）" : "")
  )

  /**
   * ---- 8) 积分：最后发，且只在「真的新建了一条经核验的绑定」时发 ----
   *
   * · 复活自己的墓碑不算新贡献（这个号本来就在池里，删了再加回来不该再算一次捐献）；
   * · 一个都没建成（全是重复/被拒/超名额）当然也不发；
   * · 一次导入**只发一份**（幂等键 = 本次新建的第一个 uid）：
   *   重复导入同一批账号时上面已经进了 alreadyMine，根本走不到这里，所以不会重复发分。
   *
   * ⚠️ 这与修复前的行为有意不同：老实现复用了 `createWb2Binding`，奖励幂等键是
   *    每条绑定的新 uuid ⇒ 一次导入 N 个账号就发 N 份积分。现在与 qoder2api 对齐成
   *    "一次导入算一次捐献"，同时这也让"批量导入刷分"失去意义。
   */
  if (newlyBound > 0 && firstNewUid) {
    await grantDonationReward(env, {
      userId: user.id,
      kind: "workbuddy",
      dedupKey: `wb2api:import:${firstNewUid}`,
      detail: "WorkBuddy 反代账号捐献奖励（JSON 导入）",
    })

    // 邀请奖励：口径与 createWb2Binding 一致 —— 必须「真的从无到有解锁了 AI 权限」。
    // `grantInviteReward` 本身按被邀请人去重，故整批调一次与逐条调效果相同。
    if (granted) {
      const planId = await getSettingNumber(env, "invite_reward_plan_id")
      if (planId && planId > 0) {
        await grantInviteReward(env, user, planId)
      }
    }
  }

  // 通知邮件：整批只发一封（老实现每条绑定一封，一次导入 200 个账号就是 200 封）。
  // 失败不影响绑定结果 —— 权限已生效，只是少一封告知。
  if (bound > 0) {
    try {
      const { text, html } = renderMail("反代账号绑定成功", [
        `本次导入已绑定 ${bound} 个 WorkBuddy 账号（新建 ${newlyBound}、恢复 ${revived}）。`,
        granted
          ? "已为你解锁「AI 中转站」权限，可到该模块创建 API Key。"
          : "你的「AI 中转站」权限此前已解锁，本次绑定不影响。",
        "账号已加入共享池供其他用户使用；如需移除，请在捐献页撤销或联系管理员。",
      ])
      await sendMail(env, {
        to: user.email,
        subject: "【Doulor Cloud】反代账号绑定成功",
        text,
        html,
      })
    } catch (err) {
      console.error("反代导入绑定通知邮件发送失败:", user.email, err)
    }
  }

  /**
   * 部分成功语义：**只对核验通过的发放，失败的逐条列出**，不整批回滚。
   *
   * 为什么不做全局事务/整批回滚：
   *   · 发放（权限/积分）不可逆，顺序上已保证「核验在前、发放在后」，
   *     整批回滚并不会让安全性更好，只会把「45 个真号被 5 个假号拖累」变成新问题；
   *   · 上游导入本来就是部分语义（`imported/skipped/errors`）；
   *   · 用户拿到 `rejected` 明细才知道该删哪几行、重传什么。
   */
  return json({
    ok: true,
    total: uids.length,
    bound,
    newlyBound,
    revived,
    alreadyBound: alreadyMine,
    skippedByLimit,
    rejected,
    limit,
    upstream: {
      total: upstream.total ?? null,
      imported: upstream.imported ?? null,
      skipped: upstream.skipped ?? null,
      errors: upstream.errors ?? [],
    },
  })
}

/**
 * 扫描网关池里「被上游判死、需要捐献者重新登录」的账号，映射回本站的捐献者。
 *
 * 触发背景（2026-10-10 站长反馈）：号池里大量账号变成
 * `account banned by upstream (11140 request illegal), re-login required` ——
 * 网关收到 11140 时会 `Pool.Disable(uid, …)`，但**捐献者这边毫不知情**，
 * 还以为自己的贡献有效、权限也该一直有效。
 *
 * 判定：`disabled === true` 且原因里带 11140 / banned / re-login required。
 * 返回的每一项都带「哪个用户 / 哪条绑定」，便于管理端展示与后续批量通知。
 *
 * ⚠️ D1 的 `IN (?,?,…)` 参数上限约为 100 ⇒ 只取前 90 个 uid 一批
 *（账号失效是持续状态，下一轮还能扫到剩下的，不会漏）。
 */
export async function scanInvalidWb2Bindings(
  env: Env
): Promise<{ uid: string; reason: string; bindingId: string; userId: string }[]> {
  const pool = await wb2Overview(env)
  const dead = (pool.accounts ?? [])
    .filter(
      (a) =>
        a.disabled === true &&
        /11140|re-?login required|banned by upstream/i.test(a.disabled_reason ?? "")
    )
    .slice(0, 90)
  if (dead.length === 0) return []

  const uids = dead.map((a) => a.uid)
  const rows = await env.DB.prepare(
    `SELECT id, user_id, uid FROM wb2api_bindings
      WHERE status = 'active' AND uid IN (${uids.map(() => "?").join(",")})`
  )
    .bind(...uids)
    .all<{ id: string; user_id: string; uid: string }>()

  const reasonByUid = new Map(dead.map((a) => [a.uid, a.disabled_reason ?? ""]))
  return (rows.results ?? []).map((r) => ({
    uid: r.uid,
    reason: reasonByUid.get(r.uid) ?? "",
    bindingId: r.id,
    userId: r.user_id,
  }))
}

/** GET /api/admin/wb2api/invalid —— 被上游判死、需要捐献者重新登录的账号 */
export async function adminListInvalidBindings(
  env: Env,
  request: Request
): Promise<Response> {
  await requireAdminUser(env, request)
  if (!(await isWb2ApiConfigured(env))) {
    throw new ApiError(503, "反代网关未配置访问密钥", "WB2API_NOT_CONFIGURED")
  }

  const invalid = await scanInvalidWb2Bindings(env)
  if (invalid.length === 0) {
    return json({ invalid: [] })
  }

  const userIds = Array.from(new Set(invalid.map((i) => i.userId)))
  const us = await env.DB.prepare(
    `SELECT id, username, email FROM users WHERE id IN (${userIds.map(() => "?").join(",")})`
  )
    .bind(...userIds)
    .all<{ id: string; username: string; email: string }>()
  const byId = new Map((us.results ?? []).map((u) => [u.id, u]))

  return json({
    invalid: invalid.map((i) => ({
      uid: i.uid,
      reason: i.reason,
      bindingId: i.bindingId,
      userId: i.userId,
      username: byId.get(i.userId)?.username ?? null,
      email: byId.get(i.userId)?.email ?? null,
    })),
  })
}

/** 「wb 账号失效」通知的标题标记（用它识别/去重/自动撤回，改文案时别丢掉） */
const WB_INVALID_NOTICE_TAG = "[wb-account-invalid]"

/**
 * 撤回该用户所有「wb 账号失效」通知，并**精确还原**被收回的权限。
 *
 * 在哪调用：用户**重新登录原账号成功**之后（见 createWb2Binding）——
 * 站长要求「重新登录原来的账号就行，然后就可以重新解锁权限」，这就是那条恢复路径。
 */
async function revokeInvalidWbNotices(env: Env, userId: string): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT * FROM admin_notices
      WHERE user_id = ? AND revoked_at IS NULL AND title LIKE ?`
  )
    .bind(userId, `%${WB_INVALID_NOTICE_TAG}%`)
    .all<{ id: string; restore_permissions: string | null; newapi_disabled: number }>()

  let n = 0
  for (const notice of rows.results ?? []) {
    // restoreUserFeatures 只补回「被本通知收回的字段」，不会覆盖别的模块权限
    await restoreUserFeatures(env, notice as never)
    await env.DB.prepare("UPDATE admin_notices SET revoked_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), notice.id)
      .run()
    n++
  }
  return n
}

/**
 * 给「账号被上游判死」的捐献者发强制通知，并收回 ai 权限（连带禁用 NewAPI 侧用户）。
 *
 * 复用管理端「强制通知」那一套（`restrictUserFeatures`）：发通知时把权限快照写进
 * `restore_permissions`，撤回时精确还原 ⇒ 用户重新登录原账号后调用
 * `revokeInvalidWbNotices` 即可把权限还回去。
 *
 * ⚠️ 同一用户已有未确认的同类通知时**跳过**，避免每天刷一条。
 */
export async function notifyInvalidWb2Bindings(
  env: Env,
  opts: { dryRun?: boolean } = {}
): Promise<{ candidates: number; users: number; notified: number; skipped: number }> {
  const invalid = await scanInvalidWb2Bindings(env)
  const userIds = Array.from(new Set(invalid.map((i) => i.userId)))
  if (opts.dryRun) {
    return { candidates: invalid.length, users: userIds.length, notified: 0, skipped: 0 }
  }

  const now = new Date().toISOString()
  let notified = 0
  let skipped = 0

  for (const userId of userIds) {
    const dup = await env.DB.prepare(
      `SELECT id FROM admin_notices
        WHERE user_id = ? AND revoked_at IS NULL AND read_at IS NULL AND title LIKE ?`
    )
      .bind(userId, `%${WB_INVALID_NOTICE_TAG}%`)
      .first<{ id: string }>()
    if (dup) {
      skipped++
      continue
    }

    const restricted = await restrictUserFeatures(env, userId, ["ai"])
    await env.DB.prepare(
      `INSERT INTO admin_notices
         (id, user_id, title, body, require_ack, restrict_features,
          restore_permissions, newapi_disabled, created_by, created_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, NULL, ?)`
    )
      .bind(
        uuid(),
        userId,
        `${WB_INVALID_NOTICE_TAG} 你捐献的 WorkBuddy 账号登录已失效`,
        "你捐献的 WorkBuddy 账号被上游判定为「需要重新登录」（错误码 11140，通常是登录态过期或被风控）。\n\n" +
          "在重新登录之前，这个账号无法继续为共享池提供额度，所以「AI 中转站」权限**已暂时收回**。\n\n" +
          "**怎么恢复**：到「捐献与邀请」页面，用**原来那个** WorkBuddy 账号重新登录一次即可 —— 权限会自动恢复，不用联系管理员。",
        JSON.stringify(["ai"]),
        restricted.restore,
        restricted.newapiDisabled ? 1 : 0,
        now
      )
      .run()
    notified++
  }

  await audit(
    env,
    null,
    "wb2api.invalid.notify",
    `扫描到 ${invalid.length} 条失效绑定（${userIds.length} 个用户），新发通知 ${notified} 条、跳过 ${skipped} 条`
  )

  return { candidates: invalid.length, users: userIds.length, notified, skipped }
}

/** POST /api/admin/wb2api/invalid/notify —— 给失效账号的捐献者发通知并收回 ai 权限 */
export async function adminNotifyInvalidBindings(
  env: Env,
  request: Request
): Promise<Response> {
  await requireAdminUser(env, request)
  if (!(await isWb2ApiConfigured(env))) {
    throw new ApiError(503, "反代网关未配置访问密钥", "WB2API_NOT_CONFIGURED")
  }
  const body = (await request.json().catch(() => ({}))) as { dryRun?: unknown }
  const result = await notifyInvalidWb2Bindings(env, { dryRun: body.dryRun === true })
  return json(result)
}

/** GET /api/admin/wb2api/bindings —— 全部绑定（含用户名） */
export async function adminListBindings(
  env: Env,
  request: Request
): Promise<Response> {
  await requireAdminUser(env, request)
  const rows = await env.DB.prepare(
    `SELECT b.*, u.username FROM wb2api_bindings b
       JOIN users u ON u.id = b.user_id
      ORDER BY b.created_at DESC`
  ).all<BindingRow & { username: string }>()

  return json({
    bindings: (rows.results ?? []).map((r) => ({
      ...toPublicBinding(r),
      username: r.username,
      grantedAi: r.granted_ai_permission === 1,
    })),
  })
}

/**
 * POST /api/admin/wb2api/bindings/:id/remove —— 摘掉一个绑定。
 *
 * body: { revokeAi?: boolean }
 *
 * 权限处理：`revokeAi` 未指定时按「有依据就不收回」自动判定（见
 * shouldKeepAiPermission），管理员可显式覆盖以处理邀请码那种无法溯源的情况。
 */
export async function adminRemoveBinding(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireAdminUser(env, request)
  const body = (await request.json().catch(() => ({}))) as {
    revokeAi?: unknown
  }

  const binding = await env.DB.prepare(
    "SELECT * FROM wb2api_bindings WHERE id = ?"
  )
    .bind(id)
    .first<BindingRow>()
  if (!binding) throw new ApiError(404, "绑定不存在", "NOT_FOUND")
  if (binding.status !== "active") {
    throw new ApiError(409, "该绑定已被移除", "ALREADY_REMOVED")
  }

  // 先从网关共享池摘掉账号。失败不阻断本地标记 —— 但要在响应里如实告知，
  // 否则管理员会以为池里已经干净了。
  let upstreamWarning: string | null = null
  try {
    await wb2RemoveAccount(env, binding.uid)
  } catch (err) {
    upstreamWarning =
      err instanceof ApiError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err)
    console.error("网关移除账号失败:", binding.uid, err)
  }

  const now = new Date().toISOString()
  await env.DB.prepare(
    `UPDATE wb2api_bindings
        SET status = 'removed', removed_at = ?, removed_by = ?
      WHERE id = ?`
  )
    .bind(now, admin.id, id)
    .run()

  const keep = await shouldKeepAiPermission(env, binding)
  const revoke = typeof body.revokeAi === "boolean" ? body.revokeAi : !keep
  let aiRevoked = false
  if (revoke) {
    // 只有「原本确实开了 ai」才需要收回 —— 守卫写进 WHERE，用 changes 判定结果。
    // 这样既省掉一次 SELECT，也不会整列覆盖并发写入的其他模块权限。
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
    "wb2api.binding.remove",
    `摘除绑定 uid=${binding.uid}（用户 ${binding.user_id}）；` +
      `AI 权限${aiRevoked ? "已收回" : "保留"}` +
      `（${typeof body.revokeAi === "boolean" ? "管理员指定" : "自动判定"}）` +
      (upstreamWarning ? `；网关移除失败：${upstreamWarning}` : "")
  )

  return json({ ok: true, aiRevoked, upstreamWarning })
}

/**
 * 判断移除该绑定后是否应保留该用户的 ai 权限。
 *
 * 保留条件（任一成立即保留）：
 *   a) 该用户还有其他 active 绑定
 *   b) 该用户有 approved 的 ai 渠道捐献（donations）
 *   c) 本次绑定当时并没有授予 ai（granted_ai_permission = 0）
 *
 * 覆盖不到的情况：ai 权限来自邀请码注册（注册时直接写进 users.permissions，
 * 没有反向索引，无法事后溯源）—— 交给管理端的 revokeAi 开关人工处理。
 */
async function shouldKeepAiPermission(
  env: Env,
  binding: BindingRow
): Promise<boolean> {
  if (binding.granted_ai_permission !== 1) return true

  const other = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM wb2api_bindings
      WHERE user_id = ? AND status = 'active' AND id != ?`
  )
    .bind(binding.user_id, binding.id)
    .first<{ c: number }>()
  if ((other?.c ?? 0) > 0) return true

  const donation = await env.DB.prepare(
    `SELECT id FROM donations
      WHERE user_id = ? AND type = 'ai' AND status = 'approved' LIMIT 1`
  )
    .bind(binding.user_id)
    .first<{ id: string }>()
  return Boolean(donation)
}

/** GET /api/admin/wb2api/config —— 凭据来源 + 掩码 + 连通性探测 */
export async function adminGetConfig(
  env: Env,
  request: Request
): Promise<Response> {
  await requireAdminUser(env, request)
  const info = await getWb2ApiCredentialInfo(env)
  const health = await probeWb2ApiCredential(env)
  const { enabled, limit } = await channelConfig(env)

  return json({
    baseUrl: info.baseUrl,
    source: info.source,
    maskedApiKey: info.maskedApiKey,
    updatedAt: info.updatedAt,
    configured: await isWb2ApiConfigured(env),
    enabled,
    limit,
    health,
  })
}

/** PUT /api/admin/wb2api/config —— 更新网关访问密钥（先真实探测再落库） */
export async function adminUpdateConfig(
  env: Env,
  request: Request
): Promise<Response> {
  const admin = await requireAdminUser(env, request)
  const body = (await request.json().catch(() => ({}))) as { apiKey?: unknown }
  const apiKey = String(body.apiKey ?? "").trim()

  if (!apiKey) throw new ApiError(400, "请填写访问密钥", "INVALID_INPUT")
  if (apiKey.length > 256) throw new ApiError(400, "密钥长度异常", "INVALID_INPUT")

  const saved = await saveWb2ApiKey(env, apiKey)
  if (!saved.ok) {
    // 不落库：错密钥会把原本可用的 env 凭据一起顶掉
    throw new ApiError(400, `密钥校验失败：${saved.message}`, "INVALID_API_KEY")
  }

  await audit(env, admin.id, "wb2api.config.update", "更新反代网关访问密钥")
  return json({ ok: true, message: saved.message })
}

/** GET /api/admin/wb2api/pool —— 转发网关账号池概览（健康度观测） */
export async function adminGetPool(
  env: Env,
  request: Request
): Promise<Response> {
  await requireAdminUser(env, request)
  if (!(await isWb2ApiConfigured(env))) {
    throw new ApiError(
      503,
      "反代网关未配置访问密钥",
      "WB2API_NOT_CONFIGURED"
    )
  }
  try {
    return json({ pool: await wb2Overview(env) })
  } catch (err) {
    // 网关拒绝密钥 = `Wb2UnauthorizedError`，本身就是带可读文案的 ApiError(502)，
    // 直接放行给全局兜底即可（原先在这里再包一层，文案反而更短）。
    throw err
  }
}

/**
 * 供 donations.ts 复用：把通道概况塞进 `GET /api/donations` 的响应，
 * 让捐献页一次请求就拿到「能不能捐 / 捐了几个」。
 *
 * `realm` 自 2026-09-30 起是**默认选中项**（管理员设的），用户可以在捐献时改选 ——
 * 前端拿它做初始值，实际以 `loginStart` 收到的参数为准。
 *
 * `visible` 是**纯展示开关**（`wb2api_donation_visible`，2026-09-30 加）：
 * 关掉后只对「还没有任何绑定」的用户隐藏卡片 —— 通道本身照常工作，
 * 已绑定的用户仍看得到卡片以便撤销绑定。与 `enabled`（通道总开关）不是一回事。
 */
export async function wb2apiDonationBlock(
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
  /** 当前允许用户自选的版本（国内版/国际版开关决定）；前端据此隐藏被关的版本 */
  availableRealms: Realm[]
  bindings: ReturnType<typeof toPublicBinding>[]
  /** 该通道解锁的功能（前端据此在卡片上标注） */
  feature: Feature
}> {
  const { enabled, limit } = await channelConfig(env)
  const visible = await getSettingBool(env, "wb2api_donation_visible")
  const configured = await isWb2ApiConfigured(env)
  const realm = (await getSetting(env, "wb2api_realm")).trim().toLowerCase() === "global"
    ? "global"
    : "cn"
  const rows = await env.DB.prepare(
    "SELECT * FROM wb2api_bindings WHERE user_id = ? ORDER BY created_at DESC"
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
    availableRealms: await availableRealms(env),
    bindings: bindings.map(toPublicBinding),
    feature: "ai",
  }
}

/**
 * ⚠️ 2026-10-13：这里原本有 `wb2apiBaseUrl(env)`（一行包 `resolveWb2ApiConfig(env).baseUrl`），
 * 注释写着「供管理端设置页展示当前地址」。全仓复核后删除，理由：
 *   · 没有任何调用点；
 *   · 同文件的 `adminGetConfig`（GET /api/admin/wb2api/config）**已经**把
 *     `baseUrl: info.baseUrl` 直接放进响应（见上面 1142 行的内联实现），
 *     管理端拿到的一直是那一份；
 *   · 留着第二个出口只会出现「改了 A 忘了 B」的漂移。
 */
