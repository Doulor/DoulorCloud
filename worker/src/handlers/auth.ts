import { ApiError, json } from "../http"
import { hashPassword, verifyPassword, needsPasswordRehash, uuid, hashToken, generateToken } from "../crypto"
import { clientIp, normalizeKeyPart, guardRateLimit } from "../ratelimit"
import { isReservedName } from "../reserved-names"
import { cfListDestinations } from "../cloudflare"
import { revokeAllUserTokens } from "../oauth-provider"
import { sendMail, renderMail } from "../mailer"
import { getSettings } from "../settings"
import {
  isBasicOnlyInvitePermissions,
  permissionsFromFeatures,
} from "../permissions"
import { getBasicFeatures } from "../quotas"
import { grantInvitePoints } from "../points"
import {
  createSession,
  destroySession,
  requireUser,
  sessionCookie,
  clearedSessionCookie,
  getSessionTokens,
  toPublicUser,
  type UserRow,
} from "../auth"
import type { Env } from "../env"

/**
 * 累计登录/访问控制台的次数（用于「常客」成就）。
 * 节流：同一用户 10 分钟内只计一次。失败静默，不影响主流程。
 */
async function bumpVisit(env: Env, userId: string): Promise<void> {
  try {
    const now = Date.now()
    const row = await env.DB.prepare(
      "SELECT visit_count, last_visit_at FROM user_stats WHERE user_id = ?"
    )
      .bind(userId)
      .first<{ visit_count: number; last_visit_at: string | null }>()

    const last = row?.last_visit_at ? new Date(row.last_visit_at).getTime() : 0
    if (now - last < 600_000) return

    const iso = new Date(now).toISOString()
    if (row) {
      await env.DB.prepare(
        "UPDATE user_stats SET visit_count = visit_count + 1, last_visit_at = ? WHERE user_id = ?"
      )
        .bind(iso, userId)
        .run()
    } else {
      await env.DB.prepare(
        "INSERT INTO user_stats (user_id, visit_count, last_visit_at) VALUES (?, 1, ?)"
      )
        .bind(userId, iso)
        .run()
    }
  } catch {
    // 计数失败不影响登录态返回
  }
}

function isValidUsername(username: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(username)
}

/**
 * 限流护栏已抽到 ratelimit.ts 的 guardRateLimit()（email handler 也要用，
 * 避免两处各写一份 try/catch 导致 fail-open 行为漂移）。这里只保留策略常量。
 */

/** 登录：同一 IP 15 分钟 30 次（防广撒网）、同一账号 15 分钟 10 次（防定向爆破） */
const LOGIN_IP_LIMIT = 30
const LOGIN_IDENTIFIER_LIMIT = 10
const LOGIN_WINDOW_SECONDS = 15 * 60
/**
 * 注册：同一 IP 1 小时 60 次（邀请码猜测 + 批量注册）。
 *
 * ⚠️ 2026-09-30：由 10 放宽到 60。原因是「限时开放注册」期间大量用户来自
 * 同一出口 IP（校园网 / 运营商 NAT / 同一公司），10 次/小时对一整个网段的人
 * 来说太紧，正常用户会被邻居的表现连坐挡在门外。
 *
 * 放宽不会让邀请码变成可爆破面：码本身是 8–32 位随机串，60 次/小时连零头都猜不完；
 * 真正的护栏是「邀请码一次性消费」（见下方 inviteReusable 的原子消费逻辑）。
 */
const REGISTER_IP_LIMIT = 60
const REGISTER_WINDOW_SECONDS = 60 * 60
/** 改密码：同一账号 15 分钟 20 次（「当前密码」校验同样是爆破面） */
const PASSWORD_ATTEMPT_LIMIT = 20
const PASSWORD_WINDOW_SECONDS = 15 * 60

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

/**
 * 当前是否处于「限时开放注册」状态（注册无需邀请码）。
 *
 * 判定：总开关 `open_registration` 开着，且（未设截止时间 或 当前未过截止时间）。
 * 截止时间解析失败（管理员填了脏值）时**忽略截止时间** —— 总开关仍开着说明
 * 管理员本意就是开放，不该因为一个格式错误把注册全关掉。
 *
 * 放在 handler 层而不是 settings.ts：项目有 check-settings.mjs 护栏，
 * 要求每个设置项都在 handler 里被真正读一次，否则判为「假开关」。
 */
function isOpenRegistrationIn(s: Record<string, string>): boolean {
  const raw = s.open_registration ?? ""
  if (!(raw === "1" || raw.toLowerCase() === "true")) return false
  const until = (s.open_registration_until ?? "").trim()
  if (!until) return true
  const t = Date.parse(until)
  if (!Number.isFinite(t)) return true
  return Date.now() < t
}

async function isOpenRegistration(env: Env): Promise<boolean> {
  return isOpenRegistrationIn(await getSettings(env))
}

/**
 * GET /api/register-status —— 注册页需要的公开信息（无需登录）。
 *
 * 目前只回「是否开放注册」与截止时间，让前端决定邀请码是否必填、要不要展示
 * 「限时开放」横幅。这里刻意不暴露任何账号/统计信息。
 */
export async function registerStatus(env: Env): Promise<Response> {
  // 注册页是公开接口、每个未登录访客都会打；原来 4 次串行 D1 查询（限时开放窗口
  // 下）在跨境链路上要 ~0.5-1s，现在合并成 1 次 getSettings（读全表一次）。
  const s = await getSettings(env)
  const until = (s.open_registration_until ?? "").trim()
  return json({ openRegistration: isOpenRegistrationIn(s), until: until || null })
}

export async function register(env: Env, request: Request): Promise<Response> {
  const body = (await request.json()) as {
    username?: string
    email?: string
    password?: string
    inviteCode?: string
  }

  const username = body.username?.trim().toLowerCase() ?? ""
  const email = body.email?.trim().toLowerCase() ?? ""
  const password = body.password ?? ""
  const inviteCode = body.inviteCode?.trim() ?? ""

  // 限流：注册是「邀请码 + 用户名」的猜测面，且会写入 D1 与 Cloudflare 侧资源
  await guardRateLimit(
    env,
    `register:ip:${clientIp(request)}`,
    REGISTER_IP_LIMIT,
    REGISTER_WINDOW_SECONDS,
    "注册过于频繁"
  )

  if (!isValidUsername(username)) {
    throw new ApiError(400, "用户名只能包含小写字母、数字和连字符", "INVALID_USERNAME")
  }
  if (isReservedName(username)) {
    throw new ApiError(400, "该用户名为系统保留名称", "RESERVED_NAME")
  }
  if (!isValidEmail(email)) {
    throw new ApiError(400, "邮箱格式不正确", "INVALID_EMAIL")
  }
  if (password.length < 8) {
    throw new ApiError(400, "密码至少需要 8 位", "WEAK_PASSWORD")
  }

  // 是否处于「限时开放注册」窗口（管理面板可开，见 settings.isOpenRegistration）。
  // 开着时注册不需要邀请码。
  const openRegistration = await isOpenRegistration(env)

  if (!inviteCode && !openRegistration) {
    throw new ApiError(400, "需要邀请码", "INVITE_REQUIRED")
  }

  // 校验邀请码 —— 仅当用户**提供了码**时才校验。
  //
  // 开放注册窗口内，码**校验失败不报错**：直接当作「没填码」走开放注册。
  // 否则点了一条失效邀请链接的人会被挡在门外，与「限时开放」的本意相悖。
  // 非开放期则按失败原因明确报错 —— 邀请码是**一次性的**，邀请链接被转发几手后
  // 码很可能已被别人用掉，这时只回一句「邀请码无效」，拿到链接的人会以为是链接
  // 本身做错了，反而去找分享者吵架。注册接口本身有 60 次/小时/IP 的限流，逐个去猜
  // 8–32 位的码不现实，所以「不存在 / 已过期 / 已被使用」的区分不构成有效信息泄露。
  let invite: {
    id: string
    code: string
    permissions: string | null
    max_uses: number
    used_count: number
    expires_at: string | null
  } | null = null

  if (inviteCode) {
    const found = await env.DB.prepare(
      `SELECT id, code, permissions, max_uses, used_count, expires_at
         FROM invite_codes
        WHERE code = ? COLLATE NOCASE
        LIMIT 1`
    )
      .bind(inviteCode)
      .first<{
        id: string
        code: string
        permissions: string | null
        max_uses: number
        used_count: number
        expires_at: string | null
      }>()

    const expired =
      !!found?.expires_at && found.expires_at <= new Date().toISOString()
    const usedUp = !!found && found.used_count >= found.max_uses

    if (found && !expired && !usedUp) {
      invite = found
    } else if (!openRegistration) {
      if (!found) {
        throw new ApiError(400, "邀请码无效，请检查是否输入正确", "INVALID_INVITE")
      }
      if (expired) {
        throw new ApiError(400, "该邀请码已过期，请向邀请你的人索取新的邀请链接", "INVITE_EXPIRED")
      }
      throw new ApiError(
        400,
        "该邀请码已被使用，请向邀请你的人索取新的邀请链接",
        "INVITE_USED"
      )
    }
  }

  // 先查占用，避免因用户名/邮箱冲突而白烧邀请码。
  //
  // 用户名会同时占用 domains.name / subdomains.fqdn / mailboxes.address 的
  // UNIQUE 约束，而其它用户可以通过「创建子域名」「添加邮箱别名」抢先占用
  // 这些名字。必须把这三种情况一并查出，否则：
  //   - 名字被抢先后本人注册会在 batch 阶段失败，而邀请码已被消费（白烧一个码）；
  //   - subdomains.fqdn 被占用时该名字将永久无法注册。
  const requestedFqdn = `${username}.${env.ROOT_DOMAIN.toLowerCase()}`
  const mailboxAddress = `${username}@${env.ROOT_DOMAIN.toLowerCase()}`

  const conflicts = await env.DB.batch([
    env.DB.prepare(
      "SELECT id FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE LIMIT 1"
    ).bind(username, email),
    env.DB.prepare(
      "SELECT id FROM subdomains WHERE fqdn = ? COLLATE NOCASE LIMIT 1"
    ).bind(requestedFqdn),
    env.DB.prepare(
      "SELECT id FROM domains WHERE name = ? COLLATE NOCASE LIMIT 1"
    ).bind(requestedFqdn),
    env.DB.prepare(
      "SELECT id FROM mailboxes WHERE address = ? COLLATE NOCASE LIMIT 1"
    ).bind(mailboxAddress),
    // ⚠️ 2026-09-25 审计（M12）：`storage_accounts.prefix` 也有 UNIQUE 约束，
    // 且它的值就是 `users.username`（storage.ts 开通网盘时写入），**但改名不会迁移它**。
    // 于是：A（bob）改名 alice 并删掉 bob.doulor.cn 之后，B 可以正常注册 bob ——
    // 直到 B 去开通网盘时 INSERT 触发 UNIQUE 冲突，未捕获 → 500，B 永久无法开通。
    // 更糟的是 A 的旧文件仍在 /dl/bob/... 对外服务，而 "bob" 已经属于另一个人。
    // 把 prefix 一并纳入注册预检：宁可让这个用户名在旧存储释放前不可注册
    // （明确 409），也不要让人先注册成功、再在开通网盘时撞上一个无法理解的 500。
    env.DB.prepare(
      "SELECT user_id FROM storage_accounts WHERE prefix = ? COLLATE NOCASE LIMIT 1"
    ).bind(username),
  ])

  if (conflicts.some((r) => (r.results ?? []).length > 0)) {
    throw new ApiError(409, "用户名或邮箱已被占用", "CONFLICT")
  }

  // 注册邮箱不得是本站域名，防止转发成环
  if (email.endsWith(`@${env.ROOT_DOMAIN.toLowerCase()}`)) {
    throw new ApiError(400, "真实邮箱不能是 doulor.cn 邮箱", "INVALID_EMAIL")
  }

  const passwordHash = await hashPassword(password)
  const id = uuid()
  const now = new Date().toISOString()

  // ⚠️ 2026-09-26：**不再为主邮箱建 Cloudflare Email Routing 规则**。
  // 线上 catch-all 已改为「Send to a Worker」，所有 *@doulor.cn 的信都会进本 Worker，
  // 注册出来的邮箱靠 mailboxes 表就能查到，不需要逐地址建规则 ——
  // 那套逐条规则是历史包袱，还占「每域 200 条」的硬配额。
  //
  // ⚠️ 2026-09-27：注册时也**不再自动注册转发 destination**。
  // 之前注册即调 cfEnsureDestination，为每个新用户占一个 destination 配额，但绝大多数
  // 用户从不点验证邮件 → 账户下堆积 145 条 pending destination，把「每账户 200 个」的
  // 硬配额撑爆，导致后续注册/验证全部 Limit Exceeded。
  // 改为：注册时不建 destination，用户主动到「设置」点验证邮箱时才创建
  // （见 settings.ts 的 verifyRealEmail / cfEnsureDestination）。

  // ⚠️ 2026-09-25 审计（P0-5）：原实现把「条件消费邀请码」和 5 条 INSERT 放进
  // 同一个 batch，然后在 batch **之后**检查 `results[0].meta.changes === 0`，
  // 注释写着「整个 batch 已回滚」—— 这个前提是**错的**。
  //
  // D1 的 batch() 只在语句**抛错**时回滚；条件 UPDATE 影响 0 行是**成功**
  // （`changes: 0`），不是错误。所以并发打同一个码时，第 2–6 条 INSERT 已经提交：
  // 用户行 active、密码由攻击者所设，代码随后才抛 400。
  // 后果：一个 max_uses=1 的邀请码可以被并发注册出任意多个账号，
  // 每个还附带该码里的模块权限（r2/ai/frp/proxy）、子域名、邮箱与 Email Routing 规则。
  // 唯一阻力只剩注册接口 60 次/小时/IP 的限流。
  //
  // 正确顺序：先在**独立语句**里原子地消费邀请码并立刻判断结果，
  // 再执行插入；插入失败时把码退回去（保持「不因名字被抢而白烧码」的原意）。
  // 开放注册路径没有码可消费，跳过。
  //
  // ⚠️ 2026-09-29：「开放注册期间，**不含额外权限**的邀请码不消耗次数」。
  // 开放期人人免码即可注册，这类码本来就没多给任何东西（它授的模块都在
  // invite_basic_features 之内 = 免码注册也拿得到），再把它烧掉只是白白浪费
  // 分享者的额度 —— 线上就有 30+ 条 `max_uses = 1` 的普通码在开放期被用一次即废。
  // 带权限的码**不受影响**：它给的是免码注册拿不到的东西，必须照常一次性消费。
  // 判定本身极保守（NULL / 缺键 / 损坏 JSON 一律按「带权限」处理），见 permissions.ts。
  const inviteReusable =
    !!invite &&
    openRegistration &&
    isBasicOnlyInvitePermissions(invite.permissions, await getBasicFeatures(env))

  if (invite && !inviteReusable) {
    const consumed = await env.DB.prepare(
      `UPDATE invite_codes
          SET used_count = used_count + 1
        WHERE id = ? AND used_count < max_uses`
    )
      .bind(invite.id)
      .run()

    if ((consumed.meta?.changes ?? 0) === 0) {
      // 走到这里说明「查的时候还有名额、原子扣减时被别人抢走了」—— 同样是「已被使用」。
      throw new ApiError(
        400,
        "该邀请码刚刚被其他人使用，请向邀请你的人索取新的邀请链接",
        "INVITE_USED"
      )
    }
  }

  // 权限来源：
  //   · 有邀请码 → 码上带的权限（与历史行为一致）；
  //   · 开放注册 → 与「默认邀请码」一致的那套权限（r2 等基础模块）。
  //     ⚠️ 必须写**显式** JSON，绝不能写 NULL —— parsePermissions 把 NULL 当
  //     「全部允许」，开放注册的每个新号会白拿 AI/frp/proxy，免费额度被薅。
  const invitePermissions = invite
    ? invite.permissions ?? null
    : JSON.stringify(permissionsFromFeatures(await getBasicFeatures(env)))

  try {
    // 插入仍然放在 batch 里（事务性）：任一条 UNIQUE 冲突都会整体回滚，
    // 不会留下「有用户行但没子域名/邮箱」的半成品账号。
    await env.DB.batch([
      // uid = 当前最大号 + 1（第 1 个用户就是 1，前端展示时补零成 001）。
      // 用子查询而不是先查一次再插入：少一次往返，也避开「查到号之后、插入之前
      // 又有人注册」的窗口。idx_users_uid 唯一索引兜底，真撞了就让注册失败回滚，
      // 也好过留下两个同号用户。
      env.DB.prepare(
        `INSERT INTO users (id, username, email, password_hash, namespace, status, permissions, invite_code_id, uid, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, (SELECT COALESCE(MAX(uid), 0) + 1 FROM users), ?, ?)`
      ).bind(id, username, email, passwordHash, username, invitePermissions, invite?.id ?? null, now, now),
      env.DB.prepare(
        "INSERT INTO domains (id, user_id, name, zone_id, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)"
      ).bind(uuid(), id, requestedFqdn, env.ZONE_ID, now),
      env.DB.prepare(
        "INSERT INTO subdomains (id, user_id, name, fqdn, status, created_at) VALUES (?, ?, '@', ?, 'active', ?)"
      ).bind(uuid(), id, requestedFqdn, now),
      env.DB.prepare(
        "INSERT INTO mailboxes (id, user_id, address, forwarding_to, created_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(uuid(), id, mailboxAddress, JSON.stringify([email]), now),
      env.DB.prepare(
        "INSERT INTO audit_logs (id, user_id, action, detail, ip, created_at) VALUES (?, ?, 'register', ?, ?, ?)"
      ).bind(
        uuid(),
        id,
        // 复用（未消费）的码单独标出来：审计里要能区分「这条码被反复使用」与
        // 「正常一次性消费」，否则一个 used_count 常年为 0 的码看起来像没被用过。
        `用户 ${username} 注册${
          inviteReusable
            ? `（开放注册 · 复用邀请码 ${invite!.code}）`
            : invite
              ? ""
              : "（开放注册）"
        }`,
        request.headers.get("CF-Connecting-IP"),
        now
      ),
    ])
  } catch (err) {
    // 插入失败（并发抢名导致的 UNIQUE 冲突、D1 抖动…）：退回邀请码额度。
    // 递减同样是条件式，避免把 used_count 减成负数；退回失败也不影响原始报错。
    // ⚠️ 只有「真的消费过」才退 —— 可复用的码压根没加过 1，退回去会把它扣成负数
    // （条件式递减挡得住负数，但会白扣掉别人正常消费掉的次数）。
    if (invite && !inviteReusable) {
      await env.DB.prepare(
        "UPDATE invite_codes SET used_count = used_count - 1 WHERE id = ? AND used_count > 0"
      )
        .bind(invite.id)
        .run()
        .catch(() => {})
    }
    const message = err instanceof Error ? err.message : String(err)
    if (/unique constraint|sqlite_constraint_unique|already exists/i.test(message)) {
      throw new ApiError(409, "用户名或邮箱已被占用", "CONFLICT")
    }
    throw err
  }

  // 邀请奖励积分：给邀请人发分（总开关默认关闭，配置见管理面板 → 积分 → 邀请奖励）。
  // 放在 batch **之后** —— 注册主流程成功才算一次有效邀请。
  // `codeConsumed` 就是上面那个判断：可复用的码（开放注册期间的普通码）没被消费，
  // 默认不算有效邀请（见 settings.invite_points_require_consumed 的说明）。
  // 该函数内部自己 try/catch，永远不会把新用户挡在门外。
  await grantInvitePoints(env, {
    inviteeId: id,
    inviteeUsername: username,
    codeConsumed: !!invite && !inviteReusable,
  })

  const token = await createSession(env, id)
  const user: UserRow = {
    id,
    username,
    email,
    password_hash: passwordHash,
    namespace: username,
    role: "user",
    status: "active",
    // 必须带上实际写入库里的权限：漏掉会让 toPublicUser 回退到「全开」，
    // 导致新注册用户界面显示权限全开（与库中实际权限不符），
    // 直到刷新页面重新 /me 才恢复正确。
    permissions: invitePermissions,
    created_at: now,
    updated_at: now,
  }

  const res = new Response(JSON.stringify({ user: toPublicUser(user) }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  })
  res.headers.set("Set-Cookie", sessionCookie(token))
  return res
}

export async function login(env: Env, request: Request): Promise<Response> {
  const body = (await request.json()) as {
    identifier?: string
    password?: string
  }
  const identifier = body.identifier?.trim().toLowerCase() ?? ""
  const password = body.password ?? ""

  if (!identifier || !password) {
    throw new ApiError(400, "请输入用户名和密码", "INVALID_CREDENTIALS")
  }

  // 限流：登录是本站最大的爆破面（口令此前无失败锁定）。
  // 两个维度各记一次 —— IP 维度挡「一个 IP 打很多账号」，账号维度挡「很多 IP 打一个账号」。
  await guardRateLimit(
    env,
    `login:ip:${clientIp(request)}`,
    LOGIN_IP_LIMIT,
    LOGIN_WINDOW_SECONDS,
    "登录尝试过于频繁"
  )
  await guardRateLimit(
    env,
    `login:id:${normalizeKeyPart(identifier)}`,
    LOGIN_IDENTIFIER_LIMIT,
    LOGIN_WINDOW_SECONDS,
    "该账号登录尝试过于频繁"
  )

  const user = await env.DB.prepare(
    "SELECT * FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE LIMIT 1"
  )
    .bind(identifier, identifier)
    .first<UserRow>()

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    throw new ApiError(401, "用户名或密码错误", "INVALID_CREDENTIALS")
  }
  if (user.status !== "active") {
    throw new ApiError(403, "账户已被停用", "SUSPENDED")
  }

  // 口令哈希透明升级：旧格式（单次 SHA-256）或迭代次数偏低的哈希，
  // 在本次登录成功（已证明知道明文口令）时用当前算法重写一次。
  // 包 try/catch：升级失败绝不能让已经验证通过的登录失败。
  if (needsPasswordRehash(user.password_hash)) {
    try {
      const upgraded = await hashPassword(password)
      await env.DB.prepare(
        "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?"
      )
        .bind(upgraded, new Date().toISOString(), user.id)
        .run()
    } catch (err) {
      console.error("口令哈希升级失败（登录不受影响）:", user.username, err)
    }
  }

  // 登录时自动同步邮箱验证状态。
  //
  // 用户注册时 Cloudflare 会向真实邮箱发确认链接；用户点过后，Cloudflare 侧的
  // destination 就有了 verified 值，但本站的 users.email_verified 还停在 0 ——
  // 除非用户主动到「设置」页点验证（大多数人不会去）。这里在登录时补一次
  // 纯读检查，命中即置 1，让「点过确认链接」的用户在下一次登录时自动完成验证，
  // 无需任何额外操作。失败静默，绝不影响登录。
  if (user.email_verified !== 1) {
    try {
      const dests = await cfListDestinations(env)
      const found = dests.find(
        (d) => d.email.toLowerCase() === user.email.toLowerCase()
      )
      if (found && found.verified !== null) {
        await env.DB.prepare(
          "UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?"
        )
          .bind(new Date().toISOString(), user.id)
          .run()
        user.email_verified = 1
      }
    } catch (err) {
      console.error("登录同步邮箱验证状态失败:", user.username, err)
    }
  }

  // 记下最后登录时间（存活率统计用）。
  //
  // 为什么非要单独存一列：sessions 会被定时运维每小时清理（删 7 天前已过期的），
  // 光靠 sessions 只能算「最近 7 天登录过」，30 / 90 天存活率会严重低估。
  // 失败静默 —— 统计字段不该让已经验证通过的登录失败（迁移未执行时也会走到这里）。
  try {
    await env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), user.id)
      .run()
  } catch (err) {
    console.error("记录最后登录时间失败:", user.username, err)
  }

  const token = await createSession(env, user.id)
  const res = new Response(JSON.stringify({ user: toPublicUser(user) }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
  res.headers.set("Set-Cookie", sessionCookie(token))
  return res
}

export async function logout(env: Env, request: Request): Promise<Response> {
  const tokens = getSessionTokens(request)
  await destroySession(env, request)
  const res = new Response(null, { status: 204 })
  // 逐个清除同名 cookie，避免残留导致下次登录被判为未登录
  const count = Math.max(tokens.length, 1)
  for (let i = 0; i < count; i++) {
    res.headers.append("Set-Cookie", clearedSessionCookie())
  }
  return res
}

export async function me(
  env: Env,
  request: Request,
  ctx?: ExecutionContext
): Promise<Response> {
  const user = await requireUser(env, request)

  // 访问计数：同一用户 10 分钟内只计一次（节流），用于「常客」成就。
  //
  // 必须走 ctx.waitUntil —— 直接 void 的话，Worker 返回响应后会取消该 Promise，
  // 计数永远不会落库（这正是「常客一直不涨」的原因）。
  //
  // 合并备注：本处与 WorkBuddy 工作区提交的修复重合（两边独立修了同一个 bug），
  // 保留更稳的写法 —— 未传 ctx 时同步等待（便于单测直接调用）。
  // bumpVisit 自身已吞异常，无需额外 .catch。
  const visit = bumpVisit(env, user.id)
  if (ctx) ctx.waitUntil(visit)
  else await visit

  // 概览页需要的统计/列表共 11 项。原先逐条 await，等于 11 次串行往返；
  // D1 的 batch() 在一个往返里把这些语句一起发出去（语句内部仍是串行执行，
  // 省掉的是网络往返开销）。这是 /api/me，每次页面加载都会调，收益明显。
  //
  // 注意：domain 的查询结果被 dnsCount 依赖（要用 domain.id），
  // 不能放进同一个 batch，因此先取 domain，再把它之后的所有查询打包。
  const domain = await env.DB.prepare(
    "SELECT * FROM domains WHERE user_id = ? LIMIT 1"
  )
    .bind(user.id)
    .first<{ id: string; name: string; status: string; created_at: string }>()

  const [
    dnsRes,
    mailRes,
    unreadRes,
    subdomainRes,
    mailboxRes,
    storageUsedRes,
    storageAccountRes,
    recentStorageRes,
    recentMessagesRes,
    recentRes,
  ] = await env.DB.batch(
    [
      env.DB.prepare("SELECT COUNT(*) AS c FROM dns_records WHERE domain_id = ?").bind(
        domain?.id ?? ""
      ),
      env.DB.prepare(
        "SELECT COUNT(*) AS c FROM messages m JOIN mailboxes mb ON m.mailbox_id = mb.id WHERE mb.user_id = ?"
      ).bind(user.id),
      env.DB.prepare(
        "SELECT COUNT(*) AS c FROM messages m JOIN mailboxes mb ON m.mailbox_id = mb.id WHERE mb.user_id = ? AND m.read = 0"
      ).bind(user.id),
      env.DB.prepare(
        "SELECT COUNT(*) AS c FROM subdomains WHERE user_id = ? AND name != '@'"
      ).bind(user.id),
      env.DB.prepare("SELECT COUNT(*) AS c FROM mailboxes WHERE user_id = ?").bind(user.id),
      env.DB.prepare(
        "SELECT COALESCE(SUM(size), 0) AS c FROM storage_objects WHERE user_id = ?"
      ).bind(user.id),
      env.DB.prepare("SELECT quota_bytes FROM storage_accounts WHERE user_id = ?").bind(
        user.id
      ),
      env.DB.prepare(
        "SELECT id, filename, r2_key, size, created_at FROM storage_objects WHERE user_id = ? ORDER BY created_at DESC LIMIT 3"
      ).bind(user.id),
      env.DB.prepare(
        `SELECT m.id, m.from_address, m.subject, m.read, m.received_at, m.mailbox_id
           FROM messages m JOIN mailboxes mb ON m.mailbox_id = mb.id
          WHERE mb.user_id = ?
          ORDER BY m.received_at DESC LIMIT 5`
      ).bind(user.id),
      env.DB.prepare(
        "SELECT id, action, detail, created_at FROM audit_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 5"
      ).bind(user.id),
    ] as D1PreparedStatement[]
  )

  // batch 返回顺序与传入一致。D1Result 的泛型是联合的，逐项取用时收敛到具体结构。
  const num = (r: unknown) => ((r as { results?: { c?: number }[] }).results?.[0]?.c ?? 0)
  const rowsOf = <T,>(r: unknown): T[] =>
    ((r as { results?: T[] }).results ?? []) as T[]

  const dnsRecords = num(dnsRes)
  const emails = num(mailRes)
  const unread = num(unreadRes)
  const subdomains = num(subdomainRes)
  const mailboxes = num(mailboxRes)
  const storageUsedBytes = num(storageUsedRes)
  const storageQuotaBytes =
    (storageAccountRes as { results?: { quota_bytes: number | null }[] }).results?.[0]
      ?.quota_bytes ?? 0
  const recentStorageFiles = rowsOf<{
    id: string
    filename: string
    r2_key: string
    size: number
    created_at: string
  }>(recentStorageRes)
  const recentMessages = rowsOf<{
    id: string
    from_address: string
    subject: string
    read: number
    received_at: string
    mailbox_id: string
  }>(recentMessagesRes)
  const recent = rowsOf<{ id: string; action: string; detail: string; created_at: string }>(
    recentRes
  )

  return json({
    user: toPublicUser(user),
    domain: domain
      ? {
          id: domain.id,
          name: domain.name,
          status: domain.status,
          createdAt: domain.created_at,
        }
      : null,
    stats: {
      domains: domain ? 1 : 0,
      subdomains,
      emails,
      unread,
      dnsRecords,
      mailboxes,
      emailForwards: 0,
      // 网盘（未开通：usedBytes 0、quotaBytes 0）
      storageUsedBytes,
      storageQuotaBytes,
    },
    // 网盘最近 3 个文件（概览卡展示文件名 + 直链复制）
    recentStorageFiles: recentStorageFiles.map((f) => ({
      id: f.id,
      filename: f.filename,
      r2Key: f.r2_key,
      size: f.size,
      createdAt: f.created_at,
    })),
    // 管理员/站长不受配额限制（999999 作为「不限」哨兵值，前端据此显示）
    subdomainLimit: user.role === "admin" || user.role === "root" ? 999999 : 5,
    mailboxLimit: user.role === "admin" || user.role === "root" ? 999999 : 3,
    recentMessages: recentMessages.map((m) => ({
      id: m.id,
      from: m.from_address,
      subject: m.subject,
      read: m.read === 1,
      receivedAt: m.received_at,
      mailboxId: m.mailbox_id,
    })),
    recentActivity: recent.map((r) => ({
      id: r.id,
      action: r.action,
      detail: r.detail,
      createdAt: r.created_at,
    })),
  })
}

/**
 * PUT /api/password —— 修改密码。
 * 必须验证当前密码；修改成功后销毁其他会话（保留当前会话），
 * 避免密码泄露后旧会话仍可用。
 */
export async function changePassword(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json()) as {
    currentPassword?: string
    newPassword?: string
  }

  const currentPassword = body.currentPassword ?? ""
  const newPassword = body.newPassword ?? ""

  if (!currentPassword) {
    throw new ApiError(400, "请输入当前密码", "INVALID_INPUT")
  }

  // 限流：「当前密码」校验在会话被盗后是最后一层保护，必须防爆破
  await guardRateLimit(
    env,
    `password:user:${user.id}`,
    PASSWORD_ATTEMPT_LIMIT,
    PASSWORD_WINDOW_SECONDS,
    "尝试过于频繁"
  )
  if (newPassword.length < 8) {
    throw new ApiError(400, "新密码至少需要 8 位", "WEAK_PASSWORD")
  }
  if (newPassword === currentPassword) {
    throw new ApiError(400, "新密码不能与当前密码相同", "INVALID_INPUT")
  }

  if (!(await verifyPassword(currentPassword, user.password_hash))) {
    throw new ApiError(401, "当前密码不正确", "INVALID_CREDENTIALS")
  }

  const passwordHash = await hashPassword(newPassword)
  const now = new Date().toISOString()

  // 使除当前会话外的所有会话失效。
  // 必须保留**全部**当前 cookie 对应的会话：浏览器可能同时持有多个同名
  // doulor_session，只保留第一个会把用户真正在用的那个删掉，表现为
  // 「改完密码立刻被登出」。
  const currentTokens = getSessionTokens(request)
  const currentHashes = await Promise.all(currentTokens.map((t) => hashToken(t)))
  const keepPlaceholders = currentHashes.map(() => "?").join(", ")

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?"
    ).bind(passwordHash, now, user.id),
    currentHashes.length > 0
      ? env.DB.prepare(
          `DELETE FROM sessions WHERE user_id = ? AND token_hash NOT IN (${keepPlaceholders})`
        ).bind(user.id, ...currentHashes)
      : env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
    env.DB.prepare(
      "INSERT INTO audit_logs (id, user_id, action, detail, ip, created_at) VALUES (?, ?, 'password.change', ?, ?, ?)"
    ).bind(
      uuid(),
      user.id,
      "修改密码",
      request.headers.get("CF-Connecting-IP"),
      now
    ),
  ])

  // ⚠️ 2026-09-25 审计（L14）：改密码是「假定账号已泄露、切断一切既有授权」的动作，
  // 但原先只删 `sessions`，**OAuth 令牌完全不受影响** —— 攻击者已经拿到的
  // access_token 在改密码之后仍能继续调 `/userinfo`（最长 1 小时）。
  // 这里补上作废。失败不阻断改密码本身（密码已经改了，这是收尾动作）。
  // 审计日志直接 INSERT（与本文件其它地方一致，避免 import settings 形成环）。
  try {
    const revoked = await revokeAllUserTokens(env, user.id)
    if (revoked > 0) {
      await env.DB.prepare(
        "INSERT INTO audit_logs (id, user_id, action, detail, ip, created_at) VALUES (?, ?, 'oauth.tokens.revoke', ?, ?, ?)"
      )
        .bind(
          uuid(),
          user.id,
          `改密码，作废 ${revoked} 个 OAuth 令牌`,
          request.headers.get("CF-Connecting-IP"),
          now
        )
        .run()
    }
  } catch (err) {
    console.error("作废 OAuth 令牌失败（密码已改）:", user.id, err)
  }

  return json({ ok: true })
}

// ---------------------------------------------------------------------------
// 找回密码
// ---------------------------------------------------------------------------

/** 重置 token 的有效期（分钟） */
const RESET_TOKEN_TTL_MINUTES = 15
/** 单个 IP 每窗口允许发起的「找回密码」次数（防用本站邮箱轰炸他人） */
const FORGOT_IP_LIMIT = 5
const FORGOT_WINDOW_SECONDS = 15 * 60

/**
 * POST /api/auth/password/forgot —— 输入邮箱，发重置邮件。
 *
 * 无论邮箱是否存在都返回同样的成功文案（防账号枚举）。命中用户时生成一次性
 * token（DB 只存 sha256），发一封含重置链接的邮件。
 */
export async function forgotPassword(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { email?: string }
  const email = (body.email ?? "").trim().toLowerCase()

  await guardRateLimit(
    env,
    `forgot:ip:${clientIp(request)}`,
    FORGOT_IP_LIMIT,
    FORGOT_WINDOW_SECONDS,
    "请求过于频繁，请稍后再试"
  )

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, "邮箱格式不正确", "INVALID_EMAIL")
  }

  const user = await env.DB.prepare(
    "SELECT id, username, email FROM users WHERE email = ? COLLATE NOCASE AND status = 'active' LIMIT 1"
  )
    .bind(email)
    .first<{ id: string; username: string; email: string }>()

  // 命中用户才发信；否则静默返回成功（不泄露「该邮箱是否注册过」）
  if (user) {
    const token = generateToken()
    const now = new Date()
    const expiresAt = new Date(now.getTime() + RESET_TOKEN_TTL_MINUTES * 60_000).toISOString()

    await env.DB.prepare(
      "INSERT INTO password_resets (id, user_id, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)"
    )
      .bind(await hashToken(token), user.id, expiresAt, now.toISOString())
      .run()

    const link = `https://cloud.${env.ROOT_DOMAIN}/reset-password?token=${token}`
    const { text, html } = renderMail("重置密码", [
      `我们收到了你（${user.username}）的重置密码请求。`,
      `请在 ${RESET_TOKEN_TTL_MINUTES} 分钟内点击下方链接设置新密码（若未发起此请求，请忽略本邮件）：`,
    ])
    // 链接用明文塞进正文（renderMail 会转义 HTML，纯文本里保留原样）
    try {
      await sendMail(env, {
        to: user.email,
        subject: "【Doulor Cloud】重置密码",
        text: `${text}\n\n${link}`,
        html: `${html.replace(
          "</body></html>",
          `<p style="margin:20px 0 12px;font-size:14px;line-height:1.6;color:#374151">请点击：<a href="${link}" style="color:#2563eb">${link}</a></p></body></html>`
        )}`,
      })
    } catch (err) {
      console.error("重置密码邮件发送失败:", email, err)
      // 邮件失败仍返回成功文案，避免泄露；但 token 已落库，用户可再试
    }
  }

  return json({ ok: true, message: "如果该邮箱已注册，重置邮件已发送，请查收（可能进垃圾箱）" })
}

/**
 * POST /api/auth/password/reset —— 用 token 重置密码。
 *
 * 校验 token（存在 + 未过期 + 未使用）→ 重置密码 → 标记已用 → 撤销全部会话与 OAuth 令牌。
 */
export async function resetPassword(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    token?: string
    password?: string
  }
  const token = (body.token ?? "").trim()
  const password = body.password ?? ""

  if (!token) {
    throw new ApiError(400, "重置链接无效或已过期", "INVALID_TOKEN")
  }
  if (password.length < 8) {
    throw new ApiError(400, "新密码至少需要 8 位", "WEAK_PASSWORD")
  }

  const row = await env.DB.prepare(
    "SELECT id, user_id, expires_at, used FROM password_resets WHERE id = ? LIMIT 1"
  )
    .bind(await hashToken(token))
    .first<{ id: string; user_id: string; expires_at: string; used: number }>()

  if (!row || row.used === 1 || new Date(row.expires_at).getTime() < Date.now()) {
    throw new ApiError(400, "重置链接无效或已过期，请重新发起找回", "INVALID_TOKEN")
  }

  const now = new Date().toISOString()
  const passwordHash = await hashPassword(password)

  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").bind(
      passwordHash,
      now,
      row.user_id
    ),
    env.DB.prepare("UPDATE password_resets SET used = 1 WHERE id = ?").bind(row.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(row.user_id),
    env.DB.prepare(
      "INSERT INTO audit_logs (id, user_id, action, detail, ip, created_at) VALUES (?, ?, 'password.reset', ?, ?, ?)"
    ).bind(uuid(), row.user_id, "通过找回流程重置密码", request.headers.get("CF-Connecting-IP"), now),
  ])

  try {
    await revokeAllUserTokens(env, row.user_id)
  } catch (err) {
    console.error("重置密码后作废 OAuth 令牌失败:", row.user_id, err)
  }

  return json({ ok: true, message: "密码已重置，请使用新密码登录" })
}
