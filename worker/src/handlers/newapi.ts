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
import { primaryAddressFor } from "../root-domains"
import { encryptSecret, decryptSecret, uuid, verifyPassword } from "../crypto"
import { requireFeatureUser, isPrivileged } from "../auth"
import {
  adminGrantSubscription,
  adminSetQuota,
  adminSetUserGroup,
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
  listAllUserSubscriptions,
  listSubscriptionPlans,
  listTokens,
  listUserSubscriptions,
  login,
  readApiKey,
  redeemCode,
  checkHealth,
  changePassword as changePasswordRemote,
} from "../newapi-client"
import { audit, getSetting, getSettings, parseRecommendedModels } from "../settings"
import { LAB_KEY_NAME, isLabKeyName } from "../lab-key"
import { resolveDonationGroup } from "../donation-provision"
import { hasFeature, parsePermissions, parseOpenFeatures } from "../permissions"
import { guardRateLimit } from "../ratelimit"
import { requireAdminScope } from "./admin"
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
  enc_password: string | null
  group_name: string | null
  quota: number
  used_quota: number
  request_count: number
  synced_at: string | null
  created_at: string
}

export async function loadAccount(
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
  // ⚠️ 2026-10-01 性能：这三项互不依赖（两个设置读取 + 一个账号行），
  // 原来是三次串行 D1 往返；并行后只花最慢的那一次。
  const [settings, configured, accountRow] = await Promise.all([
    getSettings(env),
    isNewApiConfigured(env),
    loadAccount(env, user.id),
  ])
  const account = configured ? accountRow : null

  // ⚠️ 同样并行：币种 / 健康互不依赖，且两者都有 TTL 缓存
  // （见 newapi-client.ts 的 newapiGlobalCache）。原先是串行 3 次
  // 「Worker→CF→隧道→VPS1」往返，首屏要等 3 倍时间。
  //
  // ⚠️ 2026-10-08：定价（`listPricing`）已从这里移除 —— 它只服务于「模型清单」，
  // 而那部分整体拆到了 GET /api/dev/models 懒加载（见 getModels）。首屏因此
  // 少一趟「Worker→CF→隧道→VPS1」往返，也不用去上游拉全量模型（实测 2.8~20s）。
  const [currency, health] = await Promise.all([
    // 币种与换算率以 NewAPI 站点为准
    configured
      ? getCurrencyInfo(env)
      : Promise.resolve({
          symbol: "$",
          code: "USD",
          perUnit: Number(settings.newapi_quota_per_unit),
        }),
    // 中转站健康状态（在线/离线 + 延迟），供界面顶部徽章显示
    checkHealth(env),
  ])
  const perUnit = currency.perUnit

  const base = {
    configured,
    featureEnabled: settings.newapi_enabled === "1",
    // 仅 @doulor.cn 邮箱可开通 —— 这是本功能的核心限制
    // 用户自己的主邮箱（tyu.me / doulor.cn 都可能），不要写死主域
    eligibleEmail: await primaryAddressFor(env, user.id, user.username),
    currencySymbol: currency.symbol,
    currencyCode: currency.code,
    /** quota ↔ 金额的换算率（前端把订阅额度换算成金额展示） */
    quotaPerUnit: perUnit,
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
          /**
           * 是否已完成密码绑定（有真实 access token，可代建 Key）。
           * 自动认领的账号 enc_token 是哨兵值 NO_TOKEN，只能「显示已开通」，
           * 但建 Key / 查额度会失败，必须回来走 bindAccount 补密码。
           */
          bound: account.enc_token !== NO_TOKEN_SENTINEL,
        }
      : null,
  }

  // 未开通：模型清单相关的三个字段一律给空 —— 前端在这个状态下只渲染
  // 「开通 / 绑定密码」卡片，根本用不到它们（模型清单只在已绑定账户的
  // 「全部模型」折叠区里用）。真实清单走 GET /api/dev/models。
  if (!account) {
    return json({
      ...base,
      models: [],
      modelGroups: [],
      availableGroups: [],
      groupModels: {},
      // 未开通必然没有订阅；字段要给全，前端按类型直接读（不做 undefined 兜底）
      subscription: null,
      subscriptions: [],
      freePlanId: Number(settings.newapi_free_plan_id ?? "0"),
    })
  }

  // ⚠️ 2026-10-08：模型清单（`listModels` + 分组归类）整体移出本函数，
  // 改由 GET /api/dev/models 懒加载（见下面的 getModels）。
  //
  // 原因：`listModels` 每次都去上游 NewAPI 拉**全量模型清单**，且**没有缓存**
  // （币种/健康/定价有 TTL 缓存，它和订阅是用户维度的，不在缓存里）。
  // 而它唯一的用途是页面上那个**默认折叠**的「全部模型」卡片 ⇒ 每次打开
  // AI 中转站页都要为它多等一趟「Worker→CF→隧道→VPS1」往返（实测 TTFB 2.8~20s）。

  // 全部活跃订阅：一个用户可能同时持有多张（免费套餐 + 各档邀请/奖励套餐）。
  // 消费时按 `end_time asc, id asc` 逐张接力，所以「总额度 = 各张之和」。
  // 前端要按**套餐类型**分段展示这个总额，因此这里把整份列表按 plan_id 合并后交出去。
  //
  // 合并口径：同类多张订阅合并成一条（额度相加、张数累加、有效期取最晚一张），
  // 这样进度条上一个颜色 = 一个套餐，语义稳定。
  let subscriptions: {
    planId: number
    /** 套餐名（取自套餐表；取不到时降级成「套餐 #id」） */
    title: string
    amountTotal: number
    amountUsed: number
    endTime: number
    nextResetTime: number
    /** 该套餐名下有几张订阅 */
    count: number
  }[] = []
  /** 免费套餐订阅（按设置项 newapi_free_plan_id 定位），未领取为 null */
  let subscription: (typeof subscriptions)[number] | null = null
  const freePlanId = Number(settings.newapi_free_plan_id ?? "0")
  try {
    const [active, plans] = await Promise.all([
      listAllUserSubscriptions(env, account.newapi_user_id),
      listSubscriptionPlans(env),
    ])
    const titleOf = new Map(plans.map((p) => [p.planId, p.title]))

    const byPlan = new Map<number, (typeof subscriptions)[number]>()
    for (const s of active) {
      const cur = byPlan.get(s.planId)
      if (cur) {
        cur.amountTotal += s.amountTotal
        cur.amountUsed += s.amountUsed
        cur.count += 1
        // 有效期取最晚的一张：合并后「有效期至」应表示这份额度最后什么时候失效
        cur.endTime = Math.max(cur.endTime, s.endTime)
        // 各张的重置时刻本应对齐（都是 UTC 次日 0 点），取最早的一个更保守
        cur.nextResetTime =
          cur.nextResetTime > 0 && s.nextResetTime > 0
            ? Math.min(cur.nextResetTime, s.nextResetTime)
            : cur.nextResetTime || s.nextResetTime
      } else {
        byPlan.set(s.planId, {
          planId: s.planId,
          title: titleOf.get(s.planId) || `套餐 #${s.planId}`,
          amountTotal: s.amountTotal,
          amountUsed: s.amountUsed,
          endTime: s.endTime,
          nextResetTime: s.nextResetTime,
          count: 1,
        })
      }
    }
    // 顺序固定按 plan_id 升序：颜色与分段的对应关系不随额度变化而漂移
    subscriptions = [...byPlan.values()].sort((a, b) => a.planId - b.planId)
    subscription = subscriptions.find((s) => s.planId === freePlanId) ?? null
  } catch (err) {
    console.error("查询订阅失败:", err)
  }

  return json({
    ...base,
    /**
     * ⚠️ 2026-10-08：`models` / `availableGroups` / `groupModels` 三个字段
     * 已移到 GET /api/dev/models 懒加载返回。这里保留**空值**只是为了不改变
     * 响应形状（前端类型仍声明了它们，旧客户端也不会读到 undefined）。
     * 前端已改为：只有用户展开「全部模型」卡片时才去取真实清单。
     */
    models: [],
    /** 可用分组名列表（顺序：默认分组在前）—— 见上，懒加载 */
    availableGroups: [] as string[],
    /** 分组 → 该分组可用模型 —— 见上，懒加载 */
    groupModels: {} as Record<string, string[]>,
    /**
     * 捐献渠道所在的分组名（默认 `donation`）。
     * 前端要拿它提示用户「捐献模型得单独建一个选这个分组的 Key」——
     * 分组名可在管理面板改，所以不能在前端写死。
     */
    donationGroup: resolveDonationGroup(settings.newapi_donation_group),
    /** 建 Key 时可自选的分组（顺序：站点分组在前，即默认值） */
    keyGroups: userSelectableGroups(settings),
    /** 用户当前账号所属分组 */
    accountGroup: account.group_name,
    /** 管理员维护的推荐模型分档（数组顺序即梯队顺序） */
    recommended: parseRecommendedModels(settings.newapi_recommended_models),
    /** 免费套餐订阅，未领取为 null */
    subscription,
    /** 免费套餐的 plan_id：前端据此把「免费」与「邀请/奖励」订阅分开展示 */
    freePlanId,
    /** 全部活跃订阅（按套餐类型合并），供奖励订阅卡片分段展示 */
    subscriptions,
  })
}

/**
 * 「全部可用模型」清单 + 分组归类（懒加载接口，路由 GET /api/dev/models）。
 *
 * 为什么要单独一个接口：`getStatus` 原先每次都要等 `listModels` 去上游 NewAPI
 * 拉**全量模型清单**（无缓存，实测 TTFB 2.8~20s），而这份清单唯一的用途是页面
 * 底部那个**默认折叠**的「全部模型」卡片 ⇒ 首屏白白被它拖住。
 * 现在前端只在用户真正展开那张卡片时才请求这里。
 *
 * 返回口径与原来内联在 getStatus 里的完全一致（models / availableGroups /
 * groupModels），前端只是把数据来源从 status 换成这个接口，展示逻辑不用动。
 */
export async function getModels(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "ai")
  // 四项互不依赖：设置 / 是否配置 / 账号行 / 定价（定价有 2 分钟 TTL 缓存）
  const [settings, configured, accountRow, pricing] = await Promise.all([
    getSettings(env),
    isNewApiConfigured(env),
    loadAccount(env, user.id),
    listPricing(env),
  ])
  const account = configured ? accountRow : null
  if (!account) {
    return json({ models: [], availableGroups: [], groupModels: {} })
  }

  // 用用户自己的 token 拉（受其所属分组限制）。上游抖动时降级为空清单，
  // 不能让整个接口 500 —— 前端拿到空清单会显示「暂无可用模型」。
  let models: string[] = []
  try {
    models = await runWithUserToken(env, account, (token, userId) =>
      listModels(env, token, userId)
    )
  } catch (err) {
    console.error("获取模型列表失败:", err)
  }

  // 按分组归类模型。展示的分组由设置项 newapi_visible_groups 控制（默认只 default），
  // donation（捐献）分组始终动态追加 —— 这样「∞」等管理员专用分组不会暴露给普通用户。
  const allGroups = collectGroups(pricing)
  const visible = (settings.newapi_visible_groups ?? "default")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  const availableGroups = allGroups.filter((g) => visible.includes(g))

  // 「捐献」分组：模型名以 donation 开头的，统一归到这里，
  // 不再出现在 default / 付费分组里（管理员用来标记「捐献解锁的模型」）。
  //
  // ⚠️ 2026-10-01：这里**不能**要求 `models.includes(p.model)`。
  // 捐献渠道已移到独立分组（`newapi_donation_group`），而 `models` 是用
  // 用户那个 `default` 分组的令牌拉的 ⇒ 捐献模型根本不在里面，加了这层过滤
  // 会让整个「捐献」分组凭空消失。改成只看 pricing（管理员凭据拉的、不过滤分组）
  // 里的模型名前缀 —— 这正是「用户还没建捐献 Key，也看得到自己能得到什么」的语义。
  const isDonationModel = (name: string) => /^donation/i.test(name)
  const donationModels = new Set(
    pricing.filter((p) => isDonationModel(p.model)).map((p) => p.model)
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

  return json({ models, availableGroups, groupModels })
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

/** 哨兵值：自动认领（用户已在 NewAPI 有号但未回来完成密码绑定）时占位。
 *  这类账号「显示已开通」成立，但没有真实 access token，代建 Key / 查额度会失败，
 *  届时引导用户走完整 bindAccount 补密码。 */
const NO_TOKEN_SENTINEL = "NO_TOKEN"

/** 已解析出来的用户凭据（NewAPI access token + 该账号在 NewAPI 的 id） */
interface UserCreds {
  token: string
  userId: number
}

/** 解析缓存的 access token；没有缓存 / 解密失败一律返回 null（不抛错） */
async function readCachedCreds(
  env: Env,
  account: NewApiAccountRow
): Promise<UserCreds | null> {
  if (!account.enc_token || account.enc_token === NO_TOKEN_SENTINEL) return null
  try {
    const token = await decryptSecret(account.enc_token, requireEncryptionSecret(env))
    return token ? { token, userId: account.newapi_user_id } : null
  } catch {
    return null
  }
}

/**
 * 用绑定时存的加密密码向 NewAPI 重新登录，换一个**最新**的 access token，
 * 并顺手刷新缓存。只有「缓存 token 已失效」或「压根没有缓存」时才走到这里。
 */
async function loginWithStoredPassword(
  env: Env,
  account: NewApiAccountRow
): Promise<UserCreds> {
  const secret = requireEncryptionSecret(env)

  let password = ""
  if (account.enc_password) {
    try {
      password = await decryptSecret(account.enc_password, secret)
    } catch {
      password = ""
    }
  }
  // 没有密码可用（自动认领的存量账号）→ 只能引导用户手动重新绑定
  if (!password) {
    throw new ApiError(
      401,
      "你的中转站登录已失效，请重新输入密码绑定",
      "USER_TOKEN_EXPIRED"
    )
  }

  const fresh = await (async () => {
    try {
      return await login(env, account.username, password)
    } catch (err) {
      // ⚠️ 2026-10-04 用户 ventus 反馈：同步额度时报「NewAPI 登录失败: Conflict」，
      // 因为 NewAPI 对「账号状态异常 / 凭据不再匹配」返回 409，它落进了 client 的
      // 通用分支（NEWAPI_ERROR），于是用户只看到一句看不懂的 502，也不知道要重新绑定。
      // 这里统一兜底：**存库密码已经登不进去了** ⇒ 一律转成 USER_TOKEN_EXPIRED，
      // 前端据此弹出「重新输入密码绑定」。限流（429）不在此列，它有自己的可读提示。
      if (err instanceof ApiError && err.code === "NEWAPI_RATE_LIMITED") throw err
      throw new ApiError(
        401,
        "你的中转站登录已失效，请重新输入密码绑定",
        "USER_TOKEN_EXPIRED"
      )
    }
  })()
  await env.DB.prepare(
    "UPDATE newapi_accounts SET enc_token = ?, synced_at = ? WHERE user_id = ?"
  )
    .bind(
      await encryptSecret(fresh.accessToken, secret),
      new Date().toISOString(),
      account.user_id
    )
    .run()
  return { token: fresh.accessToken, userId: fresh.userId ?? account.newapi_user_id }
}

/**
 * 以「用户身份」执行一次 NewAPI 操作 —— 所有需要用户 access token 的地方都必须走这里。
 *
 * ⚠️ 2026-09-30 线上事故修复：**不要改回「每次操作都先重登换 token」**。
 *
 * 旧实现每次都先用存的密码 `POST /api/user/login` 换最新 token（理由写的是
 * 「NewAPI 的 login token 会过期/被吊销，缓存不可靠，多一次 login 开销可接受」）。
 * 但那个「开销」根本不是开销问题：NewAPI 的 `CriticalRateLimit` 是**按来源 IP**
 * 限流的（`CRITICAL_RATE_LIMIT`，本站当时为 60 次 / 20 分钟），而本站**所有服务端
 * 调用都从同一个 Cloudflare 出口 IP 发出** ⇒ 全体用户共用同一个桶。
 * 加上 AI 页面一次加载就会触发「拉模型 / 列 Key / 同步额度」三次取 token，
 * 实测 login 请求量长期顶在阈值上（90 分钟 276 次，其中 108 次被 429 拒），
 * 于是用户「开通中转站 / 输密码确认」时被限流打回 —— 而 NewAPI 的限流响应体是
 * **空的**（`Content-Length: 0`），前端只能显示一句毫无线索的 `HTTP 429`。
 *
 * 现在改为：**先用缓存 token，只有它真的失效（NewAPI 明确回 token 无效）才重登一次并重试**。
 * 正常路径下 login 次数从「每次操作 1 次」降到「几乎为 0」，同时保留自愈能力：
 * 缓存被 disable/enable、转组等操作吊销时，用户无感（不会被迫重新绑定）。
 */
export async function runWithUserToken<T>(
  env: Env,
  account: NewApiAccountRow,
  fn: (token: string, userId: number) => Promise<T>
): Promise<T> {
  const cached = await readCachedCreds(env, account)
  if (cached) {
    try {
      return await fn(cached.token, cached.userId)
    } catch (err) {
      // 只有「token 无效」才值得重登；限流 / 网络 / 业务错误原样抛出
      if (!(err instanceof ApiError) || err.code !== "NEWAPI_TOKEN_INVALID") throw err
    }
  }
  const fresh = await loginWithStoredPassword(env, account)
  return fn(fresh.token, fresh.userId)
}

/** 把「用户 access token 失效」统一转成 USER_TOKEN_EXPIRED，前端据此弹出重新绑定框。
 *  其余错误原样抛出。 */
export function mapUserTokenError(err: unknown): unknown {
  if (err instanceof ApiError && err.code === "NEWAPI_TOKEN_INVALID") {
    return new ApiError(
      401,
      "你的中转站登录已失效，请重新输入密码绑定",
      "USER_TOKEN_EXPIRED"
    )
  }
  return err
}

/** POST /api/dev/sync —— 拉取最新额度用量 */
export async function syncAccount(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "ai")
  const account = await loadAccount(env, user.id)
  if (!account) throw new ApiError(404, "尚未开通 AI 中转站", "NOT_BOUND")

  let self
  try {
    self = await runWithUserToken(env, account, (token, userId) =>
      getUserSelf(env, token, userId)
    )
  } catch (err) {
    throw mapUserTokenError(err)
  }
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
  // ⚠️ 2026-10-05：已真绑定（有真实 access token）**不再直接拒绝**，改为允许
  //    「重新绑定 / 刷新凭据」。
  //
  //    背景：access token 失效、且用**存库密码**也重登不上时（用户在中转站改过
  //    密码、账号被吊销等），后端会回 USER_TOKEN_EXPIRED 引导用户「重新输入密码
  //    绑定」。若这里仍抛 409 ALREADY_BOUND，用户填完密码还是失败 —— 等于这条路
  //    根本走不通（用户反馈：key 管理总报「登录已失效」却救不回来）。
  //
  //    重绑**只刷新密码 + access token**，绝不重置额度、不补发订阅（下面按
  //    isRebind 分支跳过这些副作用）。「自动认领」账号（enc_token 是哨兵 NO_TOKEN）
  //    走的是正常「补密码」流程，不属于重绑。
  const isRebind = Boolean(existing && existing.enc_token !== NO_TOKEN_SENTINEL)

  const body = (await request.json()) as { password?: string }
  const password = body.password ?? ""
  if (password.length < 8) {
    throw new ApiError(400, "密码至少需要 8 位", "WEAK_PASSWORD")
  }

  // 限流（2026-09-30 补）：这一步在校验「用户的 cloud 登录密码」，是本模块
  // 唯一可被在线爆破的密码校验点 —— 会话被盗后攻击者能无限次试密码，
  // 一旦命中就等价于拿到该用户在 NewAPI 的账号。此前这里完全没有限流，
  // 与 `handlers/auth.ts` 的改密码接口（有 20 次/15 分钟）严重不对称。
  await guardRateLimit(
    env,
    `newapi-bind:user:${user.id}`,
    10,
    600,
    "密码尝试过于频繁，请稍后再试"
  )

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

  // 2. 设试用额度。**重绑不重置额度** —— 否则把用户余额抹成试用额度，是灾难性副作用。
  if (!unlimited && !isRebind) {
    await adminSetQuota(
      env,
      remote.id,
      Number(settings2.newapi_trial_quota),
      "override"
    )
  }

  // 2.5 转组必须在「换 access token」之前做。
  // NewAPI 的 EditWithTx 里 group 变化会触发 AuthVersion++ 并吊销该用户所有
  // session/access token；若放在 login 之后，会把刚换到的 token 立刻吊销，
  // 表现为「绑定成功但建 Key 报 not logged in」。先转组、再 login，token 才能拿到
  // group 已定型之后的版本。
  // 失败不阻断开通主流程，只记审计（group 默认值在多数场景本来就一致）。
  // 分组列表 = 站点分组 + 捐献分组（NewAPI 的 user.group 是逗号分隔的多选，
  // 第一个是默认分组）。**必须把捐献分组带上**，否则用户在面板/建 Key 时
  // 根本选不到它 —— 连带我们自己在 createKey 里传 `group: donation` 也可能被拒。
  // 顺序有意把站点分组放第一：不显式选分组时走的还是它（付费倍率口径不变）。
  const userGroups = userSelectableGroups(settings2)
  try {
    await adminSetUserGroup(env, remote.id, username, userGroups.join(","))
  } catch (err) {
    await audit(
      env,
      user.id,
      "newapi.group_sync_failed",
      `开通时转组到 ${userGroups.join(",")} 失败：${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }

  // 3. 登录直接拿长期 access token（rc.40 起登录响应里直接返回 access_token）
  const loginResult = await login(env, username, password)
  const accessToken = loginResult.accessToken

  const now = new Date().toISOString()
  const email = (await primaryAddressFor(env, user.id, username)).toLowerCase()
  const encToken = await encryptSecret(accessToken, secret)
  const encPassword = await encryptSecret(password, secret)

  if (isRebind) {
    // 重绑：**只刷新凭据**，绝不动 quota / used_quota / request_count / group_name。
    await env.DB.prepare(
      `UPDATE newapi_accounts
          SET newapi_user_id = ?, username = ?, email = ?,
              enc_token = ?, enc_password = ?, synced_at = ?
        WHERE user_id = ?`
    )
      .bind(loginResult.userId, username, email, encToken, encPassword, now, user.id)
      .run()
  } else {
    await env.DB.prepare(
      `INSERT INTO newapi_accounts
         (user_id, newapi_user_id, username, email, enc_token, enc_password, group_name, quota, used_quota, request_count, synced_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         newapi_user_id = excluded.newapi_user_id,
         username = excluded.username,
         email = excluded.email,
         enc_token = excluded.enc_token,
         enc_password = excluded.enc_password,
         group_name = excluded.group_name,
         quota = excluded.quota,
         synced_at = excluded.synced_at`
    )
      .bind(
        user.id,
        loginResult.userId,
        username,
        email,
        encToken,
        encPassword,
        settings2.newapi_group,
        unlimited ? 0 : Number(settings2.newapi_trial_quota),
        now,
        now
      )
      .run()
  }

  await audit(
    env,
    user.id,
    "newapi.bind",
    isRebind
      ? `重新绑定 AI 中转站账号 ${username} (id ${loginResult.userId})，刷新密码与 access token`
      : `开通 AI 中转站账号 ${username} (id ${loginResult.userId})，通过 OIDC 绑定并复用 cloud 密码`
  )

  // 开通后自动领免费订阅（plan_id 由设置项 newapi_free_plan_id 决定，0 = 不自动开）。
  // **重绑不补发订阅**（避免把用户已有的订阅/每日额度重置）；失败不阻断主流程，只记审计。
  const freePlanId = Number(settings2.newapi_free_plan_id ?? "0")
  if (!isRebind && Number.isFinite(freePlanId) && freePlanId > 0) {
    try {
      const sub = await adminGrantSubscription(env, loginResult.userId, freePlanId)
      await audit(
        env,
        user.id,
        "newapi.subscribe",
        `开通时自动领取免费订阅（套餐 ${freePlanId}）${sub.message ? "：" + sub.message : ""}`
      )
    } catch (err) {
      console.error("开通后自动领订阅失败:", err)
      await audit(
        env,
        user.id,
        "newapi.subscribe_failed",
        `开通后自动领订阅失败：${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  return json(
    {
      account: {
        newapiUserId: loginResult.userId,
        username,
        email,
        // 重绑沿用账号现有额度 / 分组，别回报成试用额度误导前端
        quota: isRebind
          ? (existing?.quota ?? 0)
          : unlimited
            ? 0
            : Number(settings2.newapi_trial_quota),
        group: isRebind
          ? (existing?.group_name ?? settings2.newapi_group)
          : settings2.newapi_group,
        unlimited,
        rebind: isRebind,
      },
    },
    isRebind ? 200 : 201
  )
}

/**
 * 用户可以**自选**的分组（建 Key 时可选、开通账号时写进 user.group）。
 *
 * 只有两个：站点分组 + 捐献分组。刻意不放开更多 —— 付费/管理员分组由管理员
 * 单独开通，让用户自选等于绕过计费。三处（开通转组 / 建 Key 校验 / 概览下发）
 * 共用它，避免口径漂移。
 */
function userSelectableGroups(settings: {
  newapi_group?: string
  newapi_donation_group?: string
}): string[] {
  return [
    (settings.newapi_group || "").trim() || "default",
    resolveDonationGroup(settings.newapi_donation_group),
  ].filter((g, i, arr) => g && arr.indexOf(g) === i)
}

// ---- API Key ----

/**
 * 把 `newapi_keys` 的一行映射成下发给前端的形状。
 *
 * ⚠️ **列表接口和同步接口必须共用这一个映射**。
 * 之前同步接口自己拼了一份「少字段」的返回（没有 `system`、名字也没归一化），
 * 前端一点「同步」就把列表换成那份 ⇒ 「系统」标记和禁用的复制/删除按钮全没了
 * （2026-10-10 站长反馈）。**同一个东西的两种返回形状，迟早会对不上。**
 */
function mapKeyRow(
  r: Record<string, unknown>,
  groupByTokenId: Map<number, string>
): Record<string, unknown> {
  // 「AI 实验室」自动建的那个 Key 是**系统 Key**：显示名统一成规范名
  // （老库里存的是「网页实验室」），并打上标记 —— 前端据此隐藏复制/删除按钮。
  const system = isLabKeyName(String(r.name ?? ""))
  return {
    id: r.id,
    tokenId: r.token_id,
    name: system ? LAB_KEY_NAME : r.name,
    maskedKey: r.key_prefix,
    /** 该 Key 所属分组；读不到为 null */
    group: groupByTokenId.get(Number(r.token_id)) ?? null,
    createdAt: r.created_at,
    /** 系统 Key：供 AI 实验室内部使用，网页端不可复制、不可删除 */
    system,
  }
}

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

  // 顺带把每个 Key 的**所属分组**带出去 —— 用户要靠它分辨「这个 Key 能不能调捐献模型」。
  //
  // 分组**刻意不落库**：它是 NewAPI 侧的属性，管理员可能在面板里改过，实时读才准；
  // 读不到就留 null（列表照样能用，只是不显示分组）。
  const groupByTokenId = new Map<number, string>()
  try {
    const tokens = await runWithUserToken(env, account, (token, userId) =>
      listTokens(env, token, userId)
    )
    for (const t of tokens) groupByTokenId.set(t.id, t.group)
  } catch (err) {
    console.error("读取 Key 分组失败（不影响列表）:", err)
  }

  return json({
    keys: (rows.results ?? []).map((r: Record<string, unknown>) => mapKeyRow(r, groupByTokenId)),
  })
}

/** POST /api/dev/key —— 创建 API Key（完整 key 只返回这一次） */
export async function createKey(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "ai")
  const account = await loadAccount(env, user.id)
  if (!account) throw new ApiError(404, "尚未开通 AI 中转站", "NOT_BOUND")

  // 必须先领取免费订阅才能创建 Key（免费额度来自订阅的每日发放）
  const sub = await listUserSubscriptions(env, account.newapi_user_id)
  if (!sub) {
    throw new ApiError(403, "请先领取免费订阅，再创建 API Key", "SUBSCRIPTION_REQUIRED")
  }

  const body = (await request.json()) as { name?: string; group?: string }
  const name = (body.name ?? "").trim().slice(0, 50) || `doulor-${user.username}`

  // 实验室那个 Key 的名字是**系统保留**的：如果允许用户手工占用，
  // 不但列表里会出现两个同名 Key，还会把「系统 Key」的判定搞乱
  // （判定只看名字，见 lab-key.ts）。
  if (isLabKeyName(name)) {
    throw new ApiError(
      400,
      `「${name}」是系统保留名称，请换一个名字`,
      "RESERVED_NAME"
    )
  }

  // 可选分组 = 站点分组 + 捐献分组（2026-10-01 起放开）。
  //
  // 为什么只放开这两个：捐献模型被分到了独立分组（`newapi_donation_group`），
  // 用站点分组的旧 Key 调不到它们，所以用户必须能建一个「选了捐献分组」的 Key。
  // 而**付费/管理员分组仍然不能自选** —— 那等于绕过计费，只能由管理员单独开通。
  const settings = await getSettings(env)
  const allowedGroups = userSelectableGroups(settings)

  const requested = (body.group ?? "").trim()
  if (requested && !allowedGroups.includes(requested)) {
    throw new ApiError(
      400,
      `不支持的分组「${requested}」，只能选：${allowedGroups.join(" / ")}`,
      "INVALID_GROUP"
    )
  }
  const group = requested || allowedGroups[0]

  let created
  try {
    created = await runWithUserToken(env, account, (token, userId) =>
      createApiKey(env, token, userId, name, group)
    )
  } catch (err) {
    throw mapUserTokenError(err)
  }

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
        // 完整 key 随创建响应下发；之后可用 POST /dev/key/:id/reveal 随时再取
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

  // 系统 Key（AI 实验室专用）不允许删除：界面里不显示删除按钮，
  // 但接口是公开的，所以服务端必须自己拦一道。
  if (isLabKeyName(row.name)) {
    throw new ApiError(
      403,
      "「AI实验室」是系统自动维护的 Key，不能删除（删掉也会被自动重建）",
      "SYSTEM_KEY"
    )
  }

  try {
    await runWithUserToken(env, account, (token, userId) =>
      deleteApiKey(env, token, userId, row.token_id)
    )
  } catch (err) {
    // NewAPI 侧已删除时不阻断本地清理（但 token 失效仍要转给前端引导重绑）
    const mapped = mapUserTokenError(err)
    if (mapped !== err) throw mapped
    console.error("NewAPI 删除 Key 失败:", err)
  }

  await env.DB.prepare("DELETE FROM newapi_keys WHERE id = ?").bind(row.id).run()
  await audit(env, user.id, "newapi.key.delete", `删除 API Key「${row.name}」`)

  return new Response(null, { status: 204 })
}

/**
 * POST /api/dev/key/:id/reveal —— 读取某个 Key 的完整内容（随时复制用）。
 *
 * 背景：原先「完整 Key 只在创建时显示一次」，用户丢了只能删掉重建。
 * 现在每次**现取现复制**：从 NewAPI 按 token id 取回，本地不缓存明文。
 * 只能取自己的 Key（user_id 归属校验）。
 */
export async function revealKey(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const user = await requireFeatureUser(env, request, "ai")
  const account = await loadAccount(env, user.id)
  if (!account) throw new ApiError(404, "尚未开通 AI 中转站", "NOT_BOUND")

  const row = await env.DB.prepare(
    "SELECT id, token_id, name FROM newapi_keys WHERE id = ? AND user_id = ?"
  )
    .bind(id, user.id)
    .first<{ id: string; token_id: number; name: string }>()
  if (!row) throw new ApiError(404, "Key 不存在", "NOT_FOUND")

  // 系统 Key（AI 实验室专用）不提供「读取完整内容」。
  // 只藏按钮是不够的 —— 不然用户直接调这个接口照样能拿到明文，
  // 「不可复制」就成了纸面规定。实验室自己取 Key 走的是服务端内部路径，不受影响。
  if (isLabKeyName(row.name)) {
    throw new ApiError(
      403,
      "「AI实验室」是系统自动维护的 Key，仅供站内使用，不提供复制",
      "SYSTEM_KEY"
    )
  }

  let key: string
  try {
    key = await runWithUserToken(env, account, (token, userId) =>
      readApiKey(env, token, userId, row.token_id)
    )
  } catch (err) {
    throw mapUserTokenError(err)
  }

  return json({ key })
}

/**
 * 从 NewAPI 同步 Key 列表（用户可能直接在 NewAPI 后台建了 Key）。
 * 只登记本站未见过的 token，key 仍为掩码形式。
 */
export async function syncKeys(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "ai")
  const account = await loadAccount(env, user.id)
  if (!account) throw new ApiError(404, "尚未开通 AI 中转站", "NOT_BOUND")

  let remote
  try {
    remote = await runWithUserToken(env, account, (token, userId) =>
      listTokens(env, token, userId)
    )
  } catch (err) {
    throw mapUserTokenError(err)
  }

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

  /**
   * 反向：上游**已经不在了**的 Key 要从本地删掉（站长 2026-10-10 反馈「只加不删」）。
   *
   * ⚠️ 但**必须确认拿到的是完整列表**才敢删 —— `listTokens` 写死
   * `page_size=100` 且只取第 1 页：正好返回 100 条时很可能还有下一页，
   * 这时按「不在列表里」去删，会把用户**真实存在**的 Key 删掉。
   * （这正是「上游列表静默截断」那类事故：列表里没有 ≠ 不存在。）
   * 拿不准就**只加不删**，并把 truncated 告诉前端，让界面说清楚。
   */
  const PAGE_SIZE = 100
  const truncated = remote.length >= PAGE_SIZE
  let removed = 0
  if (!truncated) {
    const remoteIds = new Set(remote.map((t) => t.id))
    const stale = Array.from(knownIds).filter((id) => !remoteIds.has(id))
    if (stale.length > 0) {
      await env.DB.batch(
        stale.map((id) =>
          env.DB.prepare("DELETE FROM newapi_keys WHERE user_id = ? AND token_id = ?").bind(
            user.id,
            id
          )
        )
      )
      removed = stale.length
    }
  }

  const rows = await env.DB.prepare(
    "SELECT id, token_id, name, key_prefix, created_at FROM newapi_keys WHERE user_id = ? ORDER BY created_at DESC"
  )
    .bind(user.id)
    .all()

  // 分组与列表接口同样实时读（读不到就 null，不影响列表）
  const groupByTokenId = new Map<number, string>()
  try {
    for (const t of remote) groupByTokenId.set(t.id, t.group)
  } catch {
    /* 忽略 */
  }

  return json({
    added: toAdd.length,
    removed,
    /** 上游列表可能被截断（≥100 条）⇒ 这次**没有删任何东西** */
    truncated,
    keys: (rows.results ?? []).map((r: Record<string, unknown>) => mapKeyRow(r, groupByTokenId)),
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

  let result
  // 记下实际用到的凭据，供下方「兑换后同步额度」复用（少一次取 token）
  let token = ""
  let userId = account.newapi_user_id
  try {
    result = await runWithUserToken(env, account, (t, u) => {
      token = t
      userId = u
      return redeemCode(env, t, u, code)
    })
  } catch (err) {
    throw mapUserTokenError(err)
  }

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

// ---- 领取免费订阅 ----

/**
 * POST /api/dev/subscribe —— 给当前用户开通「免费套餐」订阅（免支付，立即生效）。
 * 订阅发放周期额度（如每天 ¥1000），是「免费额度」的正规机制。
 * 套餐 id 来自设置项 newapi_free_plan_id（默认 1），0 表示未配置免费套餐。
 */
export async function grantSubscription(env: Env, request: Request): Promise<Response> {
  const user = await requireFeatureUser(env, request, "ai")
  const account = await loadAccount(env, user.id)
  if (!account) throw new ApiError(404, "尚未开通 AI 中转站", "NOT_BOUND")

  const settings = await getSettings(env)
  const planId = Number(settings.newapi_free_plan_id ?? "0")
  if (!Number.isFinite(planId) || planId <= 0) {
    throw new ApiError(503, "暂未开放免费订阅", "NO_FREE_PLAN")
  }

  const result = await adminGrantSubscription(env, account.newapi_user_id, planId)
  if (!result.ok) {
    throw new ApiError(502, `开通订阅失败：${result.message}`, "NEWAPI_ERROR")
  }

  await audit(
    env,
    user.id,
    "newapi.subscribe",
    `领取免费订阅（套餐 ${planId}）${result.message ? "：" + result.message : ""}`
  )

  return json({ message: result.message || "已领取免费订阅" })
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

  // 限流（2026-09-30 补）：`currentPassword` 会被送到 NewAPI 校验，
  // 不放行就是又一个可无限爆破的口令校验点。
  await guardRateLimit(
    env,
    `newapi-password:user:${user.id}`,
    10,
    600,
    "密码尝试过于频繁，请稍后再试"
  )

  try {
    await runWithUserToken(env, account, (token, userId) =>
      changePasswordRemote(
        env,
        token,
        userId,
        account.username,
        currentPassword,
        newPassword
      )
    )
  } catch (err) {
    throw mapUserTokenError(err)
  }

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
  if (isPrivileged(role)) return true
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
export async function syncPermissionState(
  env: Env,
  opts: { username?: string } = {}
): Promise<NewApiSyncResult> {
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

  // 拉取已开通的 cloud 用户及其 NewAPI 账号。
  //
  // ⚠️ `opts.username` 是「只对齐某一个人」用的，**不是**可选的优化：
  //    全量同步要逐个用户调一次 NewAPI，线上已有 170+ 个账号，直接撞满 Worker
  //    的 subrequest 上限（这正是这个定时任务被停掉的原因，见 maintenance.ts 第 6 条）。
  //    所以「某个用户的账号状态不对」时，管理端必须能把范围收窄到 1 个人（1~2 次 subrequest）。
  const sql =
    `SELECT na.user_id, na.newapi_user_id, na.username,
            u.role, u.permissions
       FROM newapi_accounts na
       JOIN users u ON u.id = na.user_id
      WHERE u.status = 'active'` +
    (opts.username ? " AND na.username = ? COLLATE NOCASE" : "")

  const stmt = env.DB.prepare(sql)
  const rows = await (opts.username ? stmt.bind(opts.username) : stmt).all<{
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
  await requireAdminScope(env, request, "newapi.subscriptions")

  // 可选：只对齐**一个**用户（`?username=` 或 body `{username}`）。
  // 不带就是全量 —— 线上 170+ 个账号会撞 subrequest 上限，除非确实需要，
  // 否则管理端一律带用户名调（成员详情的「对齐中转站状态」按钮就是这么用的）。
  const url = new URL(request.url)
  let username = (url.searchParams.get("username") ?? "").trim()
  if (!username) {
    const body = (await request.json().catch(() => ({}))) as { username?: unknown }
    username = typeof body.username === "string" ? body.username.trim() : ""
  }

  const result = await syncPermissionState(env, username ? { username } : {})
  return json({ ...result, username: username || null })
}

/**
 * 批量刷新所有「已绑定 token」的中转站账号的最新调用次数 / 额度 / 配额。
 *
 * 为什么需要：排行榜用的是 `newapi_accounts.request_count`（本地缓存），
 * 它只在**用户打开中转站页**时才刷新 —— 不打开就一直是旧的。于是排行榜
 * 「数据不对」（2026-10-02 实测：kuromi 本地 806、上游实际 10272）。
 * 这个函数由定时任务定时调用，按 `synced_at` 从旧到新每轮刷一批，
 * 把榜单数字拉回接近真实。
 *
 * 约束（都踩过 / 都想清楚了）：
 *   - **只刷有 token 的**：`enc_token` 为 NO_TOKEN（自动认领）的账号无法主动同步。
 *   - **别触发上游限流**：所有调用都从同一个 CF 出口 IP 发出，量要控制 ——
 *     每轮最多 BATCH 条，条与条之间留 DELAY 毫秒。
 *   - **单账号失败不中断整批**：token 失效且无密码可重登的账号跳过，
 *     不能让一个坏账号挡住后面所有账号。
 */
export async function syncAllNewapiAccounts(
  env: Env
): Promise<{ synced: number; failed: number; skipped: number; failedNames: string[] }> {
  const BATCH = 60
  const DELAY_MS = 100

  // 不再要求账号有「用户自己的 token」—— 用**管理员 token** 调
  // `/api/user/search` 能读任意账号的用量（kuromi 这种管理员账号、token 失效的
  // 账号都覆盖得到）。之前用用户 token 路径，一半账号因 token/密码过期而失败，
  // 排行榜数字就一直错。
  const accounts = await env.DB.prepare(
    `SELECT user_id, username, quota, used_quota, request_count
       FROM newapi_accounts
      ORDER BY (synced_at IS NULL) ASC, synced_at ASC
      LIMIT ${BATCH}`
  ).all<{
    user_id: string
    username: string
    quota: number
    used_quota: number
    request_count: number
  }>()

  let synced = 0
  let failed = 0
  let skipped = 0
  const failedNames: string[] = []

  for (const account of accounts.results ?? []) {
    try {
      const u = await findUserByUsername(env, account.username)
      if (!u) {
        // 上游已删除/不存在：不再重试，直接跳过并把 synced_at 顶到「现在」
        skipped++
        await env.DB.prepare(
          "UPDATE newapi_accounts SET synced_at = ? WHERE user_id = ?"
        )
          .bind(new Date().toISOString(), account.user_id)
          .run()
      } else {
        await env.DB.prepare(
          `UPDATE newapi_accounts
              SET quota = ?, used_quota = ?, request_count = ?, synced_at = ?
            WHERE user_id = ?`
        )
          .bind(
            u.quota ?? account.quota,
            u.used_quota ?? account.used_quota,
            u.request_count ?? account.request_count,
            new Date().toISOString(),
            account.user_id
          )
          .run()
        synced++
      }
    } catch (err) {
      failed++
      failedNames.push(account.username)
      console.warn("批量同步中转站账号失败:", account.username, err instanceof Error ? err.message : err)
      // 失败也把 synced_at 顶到「现在」，避免失败账号永远卡在队首挡住后面的
      await env.DB.prepare(
        "UPDATE newapi_accounts SET synced_at = ? WHERE user_id = ?"
      )
        .bind(new Date().toISOString(), account.user_id)
        .run()
    }
    if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS))
  }

  return { synced, failed, skipped, failedNames: failedNames.slice(0, 10) }
}

/**
 * POST /api/admin/newapi/sync-all —— 手动触发一次中转站批量同步。
 * 给站长一个「立即刷新」的入口：排行榜数字过期时不用等下一轮定时任务。
 */
export async function adminSyncAllNewapiAccounts(
  env: Env,
  request: Request
): Promise<Response> {
  await requireAdminScope(env, request, "newapi.subscriptions")
  const r = await syncAllNewapiAccounts(env)
  return json({ ok: true, ...r })
}
