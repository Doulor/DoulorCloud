/**
 * 积分系统的 HTTP 接口。
 *
 * 用户端：
 *   GET    /api/points                      —— 余额 + 兑换参数 + 商品（官方 / 用户）+ 我的订单
 *                                              + 我上架的商品 + 我收到的订单 + 最近流水
 *   POST   /api/points/redeem               —— 用积分兑换中转站余额（商城里那个可变金额的商品位）
 *   POST   /api/points/shop/buy             —— 购买商城里的某件商品（官方 / 用户商品都走这里）
 *   POST   /api/points/products             —— 上架自己的商品（进入待审核）
 *   PUT    /api/points/products/:id         —— 改自己的商品（改完重新待审核）
 *   DELETE /api/points/products/:id         —— 删自己的商品
 *   POST   /api/points/orders/:id/deliver   —— 卖家标记订单已交付
 *   POST   /api/points/orders/:id/confirm   —— 买家确认收货（结算积分给卖家）
 * 管理端：
 *   GET  /api/admin/points                    —— 用户积分总览（可搜索）
 *   POST /api/admin/points/adjust             —— 发放 / 扣减积分
 *   GET  /api/admin/points/:username/history  —— 某用户的流水
 *   GET  /api/admin/points/shop               —— 官方商品 + 用户商品 + 订单 + 兑换配置 + 捐献奖励 + 邀请奖励
 *   PUT  /api/admin/points/config             —— 保存兑换开关 / 比例 / 每日上限 / 捐献奖励积分 / 邀请奖励
 *   POST /api/admin/points/products           —— 新建官方商品
 *   PUT  /api/admin/points/products/:id       —— 编辑官方商品
 *   DELETE /api/admin/points/products/:id     —— 删除商品（官方 / 用户商品都可以）
 *   POST /api/admin/points/products/:id/review —— 审核用户商品（通过 / 拒绝）
 *   POST /api/admin/points/orders/:id/deliver —— 标记官方商品订单已发放
 *   POST /api/admin/points/orders/:id/settle  —— 强制结算用户商品订单
 *   POST /api/admin/points/orders/:id/cancel  —— 取消订单并退款
 *
 * 余额与流水的读写全部委托给 points.ts，商品与订单委托给 points-shop.ts
 * （那两处是唯一的写入口），本文件只负责鉴权、参数校验与响应组装。
 */
import { ApiError, json, assertContentLengthWithin } from "../http"
import { requireUser } from "../auth"
import { requireAdmin } from "./admin"
import { guardRateLimit } from "../ratelimit"
import { likeContains } from "../sql-like"
import { audit, updateSettings } from "../settings"
import type { SettingKey } from "../settings"
import {
  DONATION_REWARD_KINDS,
  DONATION_REWARD_SETTING_KEYS,
  adminAdjustPoints,
  getDonationDailyLimit,
  getDonationRewardPoints,
  getInvitePointsConfig,
  getPointsBalance,
  getRedeemConfig,
  listPointTransactions,
  redeemPoints,
  transferPoints,
} from "../points"
import { backfillDonationRewards, topUpDonationRewards } from "../donation-backfill"
import {
  adminCancelOrder,
  adminSettleOrder,
  buyProduct,
  confirmOrder,
  createProduct,
  createUserProduct,
  deleteProduct,
  deleteUserProduct,
  deliverOrder,
  listOrders,
  listProducts,
  reviewProduct,
  sellerDeliverOrder,
  updateProduct,
  updateUserProduct,
} from "../points-shop"
import type { OrderStatus } from "../points-shop"
import type { Env } from "../env"

const MAX_JSON_BODY_BYTES = 16 * 1024

/** GET /api/points —— 当前用户的积分概览（余额 / 配置 / 商品 / 订单 / 我上架的商品 / 流水） */
export async function getPoints(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const [
    balance,
    config,
    transactions,
    products,
    userProducts,
    myProducts,
    orders,
    sellerOrders,
    boundRow,
  ] = await Promise.all([
    getPointsBalance(env, user.id),
    getRedeemConfig(env),
    listPointTransactions(env, user.id, 50),
    // 官方商品：只要上架的
    listProducts(env, { onlyEnabled: true, scope: "official" }),
    // 用户商品：上架 + 审核通过（待审核 / 被拒的不给别人看）
    listProducts(env, {
      onlyEnabled: true,
      scope: "user",
      reviewStatus: "approved",
      limit: 100,
    }),
    // 我上架的：含待审核 / 已拒绝 / 已下架，自己要看得到进度
    listProducts(env, { ownerId: user.id, limit: 50 }),
    listOrders(env, { userId: user.id, limit: 50 }),
    // 我收到的订单（我是卖家）
    listOrders(env, { sellerId: user.id, limit: 50 }),
    env.DB.prepare("SELECT 1 AS x FROM newapi_accounts WHERE user_id = ?")
      .bind(user.id)
      .first(),
  ])

  return json({
    balance,
    config,
    transactions,
    products,
    userProducts,
    myProducts,
    orders,
    sellerOrders,
    /** 是否已绑定中转站账号（未绑定时「兑换」与自动充值商品置灰并提示先去开通） */
    bound: Boolean(boundRow),
  })
}

/** POST /api/points/redeem —— 兑换中转站余额 */
export async function redeem(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  // 兑换会真实调用 NewAPI 加额度，限流防止脚本刷（1 分钟最多 5 次，
  // 正常用户一天也就兑几次；真正的每日上限在 redeemPoints 里按配置卡）
  await guardRateLimit(env, `points-redeem:${user.id}`, 5, 60, "操作过于频繁")

  assertContentLengthWithin(request, MAX_JSON_BODY_BYTES, "请求内容过大")
  const body = (await request.json().catch(() => ({}))) as { points?: unknown }
  const points = Number(body.points)
  if (!Number.isFinite(points)) {
    throw new ApiError(400, "请填写要兑换的积分数", "INVALID_INPUT")
  }

  const result = await redeemPoints(env, user.id, user.username, points)
  return json(result)
}

/**
 * POST /api/points/transfer —— 用户间转账。
 *
 * **只需要转出方确认**（不需要收款方同意），凭用户名转给对方。
 * 限流 10 次/分钟：转账是资金操作，脚本刷起来会反复打 D1。
 */
export async function transfer(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  await guardRateLimit(env, `points-transfer:${user.id}`, 10, 60, "操作过于频繁")

  assertContentLengthWithin(request, MAX_JSON_BODY_BYTES, "请求内容过大")
  const body = (await request.json().catch(() => ({}))) as {
    username?: unknown
    amount?: unknown
  }
  const username = typeof body.username === "string" ? body.username.trim() : ""
  const amount = Math.floor(Number(body.amount))
  if (!username) throw new ApiError(400, "请填写收款人的用户名", "INVALID_INPUT")
  if (!Number.isFinite(amount) || amount < 1) {
    throw new ApiError(400, "转账数量必须是不小于 1 的整数", "INVALID_INPUT")
  }

  const target = await env.DB.prepare(
    "SELECT id, username, status FROM users WHERE username = ? COLLATE NOCASE"
  )
    .bind(username)
    .first<{ id: string; username: string; status: string }>()
  if (!target) throw new ApiError(404, "找不到这个用户", "NOT_FOUND")
  if (target.id === user.id) throw new ApiError(400, "不能转给自己", "INVALID_INPUT")
  if (target.status !== "active") {
    throw new ApiError(400, "该账号当前状态无法接收转账", "INVALID_INPUT")
  }

  const res = await transferPoints(env, {
    fromUserId: user.id,
    fromUsername: user.username,
    toUserId: target.id,
    toUsername: target.username,
    amount,
  })
  if (!res.ok) throw new ApiError(400, res.error, "TRANSFER_FAILED")

  // 资金操作记审计（谁转给谁多少），便于日后对账
  await audit(env, user.id, "points.transfer", `转给 @${target.username} ${amount} 积分`)

  return json({ ok: true, balance: res.balance, to: target.username })
}

/** POST /api/points/shop/buy —— 购买商品（官方 / 用户商品共用） */
export async function buyShopProduct(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  // 与兑换同一档限流：购买也可能真的调 NewAPI
  await guardRateLimit(env, `points-buy:${user.id}`, 10, 60, "操作过于频繁")

  assertContentLengthWithin(request, MAX_JSON_BODY_BYTES, "请求内容过大")
  const body = (await request.json().catch(() => ({}))) as { productId?: unknown }
  const productId = typeof body.productId === "string" ? body.productId.trim() : ""
  if (!productId) throw new ApiError(400, "请指定商品", "INVALID_INPUT")

  const order = await buyProduct(env, { id: user.id, username: user.username }, productId)
  return json({ order, balance: await getPointsBalance(env, user.id) })
}

// ---- 用户商品（上架 / 编辑 / 删除 / 交付 / 确认）----

/** POST /api/points/products —— 上架自己的商品 */
export async function createMyProduct(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  // 上架要限流：用户商城是所有人共享的一块地方，不限流等于开放刷屏
  await guardRateLimit(env, `points-product-new:${user.id}`, 10, 3600, "上架太频繁，请稍后再试")

  assertContentLengthWithin(request, MAX_JSON_BODY_BYTES, "请求内容过大")
  const body = await request.json().catch(() => ({}))
  const product = await createUserProduct(
    env,
    { id: user.id, username: user.username },
    body
  )
  await audit(
    env,
    user.id,
    "points.shop.upload",
    `${user.username} 上架商品「${product.name}」（${product.price} 积分，待审核）`
  )
  return json({ product })
}

/** PUT /api/points/products/:id —— 改自己的商品（改完重新待审核） */
export async function updateMyProduct(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const user = await requireUser(env, request)
  assertContentLengthWithin(request, MAX_JSON_BODY_BYTES, "请求内容过大")
  const body = await request.json().catch(() => ({}))
  const product = await updateUserProduct(env, user.id, id, body)
  await audit(env, user.id, "points.shop.upload", `${user.username} 修改商品「${product.name}」（重新待审核）`)
  return json({ product })
}

/** DELETE /api/points/products/:id —— 删自己的商品 */
export async function deleteMyProduct(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const user = await requireUser(env, request)
  await deleteUserProduct(env, user.id, id)
  await audit(env, user.id, "points.shop.upload", `${user.username} 删除自己上架的商品 ${id}`)
  return json({ ok: true })
}

/** POST /api/points/orders/:id/deliver —— 卖家标记已交付 */
export async function sellerDeliver(env: Env, request: Request, id: string): Promise<Response> {
  const user = await requireUser(env, request)
  const order = await sellerDeliverOrder(env, user.id, id)
  return json({ order })
}

/** POST /api/points/orders/:id/confirm —— 买家确认收货（结算给卖家） */
export async function confirmReceipt(env: Env, request: Request, id: string): Promise<Response> {
  const user = await requireUser(env, request)
  const order = await confirmOrder(env, user.id, id)
  return json({ order })
}

// ---- 管理端 ----

/** GET /api/admin/points —— 用户积分总览（含未持有积分的用户，余额记 0） */
export async function listPointsOverview(env: Env, request: Request): Promise<Response> {
  await requireAdmin(env, request)
  const url = new URL(request.url)
  // 上限 40 而不是 64：这个值最终会进 `LIKE '%...%'`，而 D1 的 LIKE 模式上限只有
  // 50 字符（见 sql-like.ts）。原来允许 64 ⇒ 搜长邮箱/长用户名会直接 500。
  const query = (url.searchParams.get("query") ?? "").trim().slice(0, 40)

  // 以 users 为主表 LEFT JOIN：从来没得过积分的用户也要出现在列表里
  // （否则管理员搜一个「0 积分」的用户会以为他不存在）。
  //
  // 排序**按注册时间倒序**，与「用户」标签的列表保持一致 —— 原先按余额倒序，
  // 用户一有变动就整表跳位，管理员找不到人（2026-09-28 站长反馈）。
  const base =
    "SELECT u.id, u.uid, u.username, u.email, u.nickname, u.role, u.status, " +
    "u.created_at, COALESCE(p.balance, 0) AS balance, p.updated_at " +
    "FROM users u LEFT JOIN user_points p ON p.user_id = u.id "
  const rows = query
    ? await env.DB.prepare(
        `${base} WHERE u.username LIKE ? OR u.nickname LIKE ? OR u.email LIKE ? ` +
          "ORDER BY u.created_at DESC, u.id LIMIT 200"
      )
        .bind(likeContains(query), likeContains(query), likeContains(query))
        .all<Record<string, unknown>>()
    : await env.DB.prepare(`${base} ORDER BY u.created_at DESC, u.id LIMIT 200`).all<
        Record<string, unknown>
      >()

  const users = (rows.results ?? []).map((r) => ({
    id: r.id,
    uid: (r.uid as number | null) ?? null,
    username: r.username,
    email: r.email,
    nickname: r.nickname,
    role: r.role,
    status: r.status,
    createdAt: r.created_at ?? null,
    balance: Number(r.balance ?? 0),
    updatedAt: r.updated_at ?? null,
  }))

  // 全站汇总：总发放 / 总消耗（按 reason 归类，给管理员一个全局感知）
  //
  // ⚠️ 两类**用户间转移**必须从「累计发放」里排除，它们不是平台增发：
  //    · `shop_sell` —— 用户商城的卖家收益，钱来自买家那笔 `shop` 支出；
  //    · `transfer_in` —— 用户间转账的收款方，钱来自转出方的 `transfer_out`。
  //    算进去的话，用户互相买卖/转账一次，平台「累计发放」就凭空涨一倍。
  const totals = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN delta > 0 AND reason NOT IN ('shop_sell','transfer_in') THEN delta ELSE 0 END), 0) AS issued,
       COALESCE(SUM(CASE WHEN reason IN ('redeem', 'shop') AND delta < 0 THEN -delta ELSE 0 END), 0) AS redeemed,
       COALESCE(SUM(CASE WHEN reason IN ('shop_sell','transfer_in') AND delta > 0 THEN delta ELSE 0 END), 0) AS traded
     FROM point_transactions`
  ).first<{ issued: number; redeemed: number; traded: number }>()

  const holding = users.reduce((sum, u) => sum + (u.balance > 0 ? u.balance : 0), 0)

  return json({
    users,
    stats: {
      issued: Number(totals?.issued ?? 0),
      redeemed: Number(totals?.redeemed ?? 0),
      /** 用户商城的累计成交额（买家付出的积分总和，零和转移） */
      traded: Number(totals?.traded ?? 0),
      /** 当前在用户手上的积分总量（列表内，最多 200 人） */
      holding,
      holders: users.filter((u) => u.balance > 0).length,
    },
  })
}

/** POST /api/admin/points/adjust —— 发放 / 扣减积分 */
export async function adjustPoints(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdmin(env, request)
  assertContentLengthWithin(request, MAX_JSON_BODY_BYTES, "请求内容过大")
  const body = (await request.json().catch(() => ({}))) as {
    username?: unknown
    delta?: unknown
    detail?: unknown
  }

  const username = typeof body.username === "string" ? body.username.trim() : ""
  if (!username) throw new ApiError(400, "请指定用户", "INVALID_INPUT")
  const delta = Number(body.delta)
  if (!Number.isFinite(delta) || Math.trunc(delta) === 0) {
    throw new ApiError(400, "积分变动值必须是非零整数（正数发放、负数扣减）", "INVALID_INPUT")
  }
  const detail = typeof body.detail === "string" ? body.detail.trim().slice(0, 200) : ""

  const target = await env.DB.prepare("SELECT id, username FROM users WHERE username = ? COLLATE NOCASE")
    .bind(username)
    .first<{ id: string; username: string }>()
  if (!target) throw new ApiError(404, "用户不存在", "NOT_FOUND")

  const res = await adminAdjustPoints(env, admin.id, target.id, Math.trunc(delta), detail)
  await audit(
    env,
    admin.id,
    "points.adjust",
    `${Math.trunc(delta) > 0 ? "发放" : "扣减"} ${Math.abs(Math.trunc(delta))} 积分给 ${target.username}` +
      `（余额 ${res.balance}）${detail ? ` · ${detail}` : ""}`
  )
  return json({ balance: res.balance })
}

/** GET /api/admin/points/:username/history —— 某用户流水 */
export async function userPointHistory(
  env: Env,
  request: Request,
  username: string
): Promise<Response> {
  await requireAdmin(env, request)
  const target = await env.DB.prepare("SELECT id, username FROM users WHERE username = ? COLLATE NOCASE")
    .bind(username)
    .first<{ id: string; username: string }>()
  if (!target) throw new ApiError(404, "用户不存在", "NOT_FOUND")

  const [balance, transactions] = await Promise.all([
    getPointsBalance(env, target.id),
    listPointTransactions(env, target.id, 100),
  ])
  return json({ username: target.username, balance, transactions })
}

const ORDER_STATUSES: readonly OrderStatus[] = ["pending", "delivered", "settled", "cancelled"]

/**
 * GET /api/admin/points/shop —— 商城标签页一次性拿齐。
 *
 * 官方商品与用户商品**分开返回**：管理端的商品表（可编辑 / 上下架）只应展示官方商品，
 * 用户商品要走审核流程，混在一起会给管理员一堆不该出现的「编辑」按钮。
 *
 * 顺带把 `donationRewards`（各档捐献奖励积分数）一起返回：它和兑换比例是同一类
 * 「积分经济旋钮」，管理端在同一个标签页里改，没必要再开一个请求。
 */
export async function getShopAdmin(env: Env, request: Request): Promise<Response> {
  await requireAdmin(env, request)
  const url = new URL(request.url)
  const statusRaw = (url.searchParams.get("status") ?? "").trim()
  const status = (ORDER_STATUSES as readonly string[]).includes(statusRaw)
    ? (statusRaw as OrderStatus)
    : undefined

  const [
    products,
    userProducts,
    orders,
    config,
    donationRewards,
    donationDailyLimit,
    inviteConfig,
  ] = await Promise.all([
    listProducts(env, { scope: "official" }),
    listProducts(env, { scope: "user", limit: 200 }),
    listOrders(env, { status, limit: 200 }),
    getRedeemConfig(env),
    getDonationRewardPoints(env),
    getDonationDailyLimit(env),
    getInvitePointsConfig(env),
  ])
  return json({
    products,
    userProducts,
    orders,
    config,
    /** 邀请奖励 / 返佣的四个旋钮（编辑入口：商城 → 「邀请奖励」） */
    inviteConfig,
    // 下发**数组**（带 label 与固定顺序）而不是 { key: 分数 }：
    // 档位清单与中文名只在服务端维护一份，前端照着渲染即可，不会出现两边漂移。
    donationRewards: DONATION_REWARD_KINDS.map(({ key, label }) => ({
      key,
      label,
      points: donationRewards[key],
    })),
    /** 每人每日捐献奖励发放次数上限（0 = 不限） */
    donationDailyLimit,
  })
}

/** PUT /api/admin/points/config —— 保存兑换开关 / 比例 / 每日上限 / 捐献奖励积分 */
export async function savePointsConfig(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdmin(env, request)
  assertContentLengthWithin(request, MAX_JSON_BODY_BYTES, "请求内容过大")
  const body = (await request.json().catch(() => ({}))) as {
    enabled?: unknown
    yuanPerPoint?: unknown
    dailyLimit?: unknown
    /** 捐献奖励：档位 → 积分数（只提交要改的档位即可） */
    donationRewards?: unknown
    /** 捐献奖励的每人每日发放次数上限（0 = 不限） */
    donationDailyLimit?: unknown
    /** 邀请奖励 / 返佣（只提交要改的字段即可） */
    invitePoints?: unknown
  }

  const values: Partial<Record<SettingKey, string>> = {}

  if (body.enabled !== undefined) {
    values.points_enabled = body.enabled ? "1" : "0"
  }
  if (body.yuanPerPoint !== undefined) {
    const n = Number(body.yuanPerPoint)
    // 比例是「每 1 积分值多少元」，允许小数；0 或负数没有意义
    if (!Number.isFinite(n) || n <= 0 || n > 100_000) {
      throw new ApiError(400, "兑换比例需大于 0 且不超过 100000", "INVALID_INPUT")
    }
    values.points_yuan_per_point = String(Math.round(n * 10_000) / 10_000)
  }
  if (body.dailyLimit !== undefined) {
    const n = Math.trunc(Number(body.dailyLimit))
    if (!Number.isFinite(n) || n < 0 || n > 1000) {
      throw new ApiError(400, "每日兑换次数上限需在 0 ~ 1000 之间", "INVALID_INPUT")
    }
    values.points_redeem_daily_limit = String(n)
  }
  if (body.donationRewards !== undefined) {
    const raw = body.donationRewards
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ApiError(400, "捐献奖励格式不正确", "INVALID_INPUT")
    }
    // 只认已知档位：多余的键直接忽略（前端版本不一致时不该 500），
    // 未知档位若照写进 app_settings 会变成「没人读的死设置项」。
    for (const { key } of DONATION_REWARD_KINDS) {
      const v = (raw as Record<string, unknown>)[key]
      if (v === undefined) continue
      const n = Math.trunc(Number(v))
      if (!Number.isFinite(n) || n < 0 || n > 100_000) {
        throw new ApiError(400, "捐献奖励积分需在 0 ~ 100000 之间（0 = 该类型不发）", "INVALID_INPUT")
      }
      values[DONATION_REWARD_SETTING_KEYS[key]] = String(n)
    }
  }
  if (body.donationDailyLimit !== undefined) {
    const n = Math.trunc(Number(body.donationDailyLimit))
    if (!Number.isFinite(n) || n < 0 || n > 1000) {
      throw new ApiError(400, "捐献奖励每日上限需在 0 ~ 1000 之间（0 = 不限）", "INVALID_INPUT")
    }
    values.donation_points_daily_limit = String(n)
  }
  if (body.invitePoints !== undefined) {
    const raw = body.invitePoints
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ApiError(400, "邀请奖励配置格式不正确", "INVALID_INPUT")
    }
    const o = raw as Record<string, unknown>
    // 两个开关：布尔归一化成 "1"/"0"（与 updateSettingsHandler 同一口径）
    if (o.enabled !== undefined) values.invite_points_enabled = o.enabled ? "1" : "0"
    if (o.requireConsumed !== undefined) {
      values.invite_points_require_consumed = o.requireConsumed ? "1" : "0"
    }
    if (o.perFriend !== undefined) {
      const n = Math.trunc(Number(o.perFriend))
      if (!Number.isFinite(n) || n < 0 || n > 100_000) {
        throw new ApiError(
          400,
          "每邀请 1 人的积分需在 0 ~ 100000 之间（0 = 不发）",
          "INVALID_INPUT"
        )
      }
      values.invite_points_per_friend = String(n)
    }
    if (o.commissionPercent !== undefined) {
      const n = Number(o.commissionPercent)
      // 允许小数比例（2.5%），但超过 100% 就是负数发放，没有意义
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        throw new ApiError(400, "返佣比例需在 0 ~ 100 之间（0 = 关闭）", "INVALID_INPUT")
      }
      values.invite_points_commission_percent = String(Math.round(n * 100) / 100)
    }
    if (o.dailyLimit !== undefined) {
      const n = Math.trunc(Number(o.dailyLimit))
      if (!Number.isFinite(n) || n < 0 || n > 1_000_000) {
        throw new ApiError(
          400,
          "邀请奖励每日上限需在 0 ~ 1000000 之间（0 = 不限）",
          "INVALID_INPUT"
        )
      }
      values.invite_points_daily_limit = String(n)
    }
  }
  if (Object.keys(values).length === 0) {
    throw new ApiError(400, "没有需要更新的配置", "INVALID_INPUT")
  }

  await updateSettings(env, values)
  await audit(
    env,
    admin.id,
    "points.config",
    `更新积分商城配置：${Object.entries(values)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}`
  )
  const donationRewards = await getDonationRewardPoints(env)
  return json({
    config: await getRedeemConfig(env),
    donationRewards: DONATION_REWARD_KINDS.map(({ key, label }) => ({
      key,
      label,
      points: donationRewards[key],
    })),
    donationDailyLimit: await getDonationDailyLimit(env),
    inviteConfig: await getInvitePointsConfig(env),
  })
}

/**
 * POST /api/admin/points/backfill-donations —— 一次性补发历史捐献积分。
 *
 * body: `{ dryRun?: boolean }`。**默认 dryRun = true（只统计不写库）** ——
 * 这个接口一次能给全站发几千分，必须先预演确认数字，再显式传 `false` 落账。
 *
 * 幂等：复用正常发放的 dedupKey，已发过的不会再发，可重复运行。
 */
export async function backfillDonations(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdmin(env, request)
  assertContentLengthWithin(request, MAX_JSON_BODY_BYTES, "请求内容过大")
  const body = (await request.json().catch(() => ({}))) as { dryRun?: unknown }
  const dryRun = body.dryRun !== false

  const report = await backfillDonationRewards(env, dryRun)

  if (!dryRun) {
    await audit(
      env,
      admin.id,
      "points.backfill",
      `补发历史捐献积分：${report.applied} 笔 / 共 ${report.totalPoints} 分 / 涉及 ${report.distinctUsers} 人`
    )
  }
  return json(report)
}

/**
 * POST /api/admin/points/backfill-donations/topup —— 把历史补发的积分按倍数补足差额。
 *
 * body: `{ dryRun?: boolean, multiplier?: number }`。**默认 dryRun = true**，
 * `multiplier` 默认 2（即「再发等额」= 翻倍）。
 *
 * 用于「档位值调高之后，把之前按旧值发出去的那批补齐」。只作用于首次历史补发那批，
 * 幂等（同一笔同一倍数只补一次），可重复运行。
 */
export async function topUpDonations(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdmin(env, request)
  assertContentLengthWithin(request, MAX_JSON_BODY_BYTES, "请求内容过大")
  const body = (await request.json().catch(() => ({}))) as {
    dryRun?: unknown
    multiplier?: unknown
  }
  const dryRun = body.dryRun !== false
  const multiplier = body.multiplier === undefined ? 2 : Math.trunc(Number(body.multiplier))
  if (!Number.isFinite(multiplier) || multiplier < 2 || multiplier > 100) {
    throw new ApiError(400, "倍数需在 2 ~ 100 之间", "INVALID_INPUT")
  }

  const report = await topUpDonationRewards(env, dryRun, multiplier)

  if (!dryRun) {
    await audit(
      env,
      admin.id,
      "points.backfill.topup",
      `捐献积分翻倍补差（×${report.multiplier}）：${report.applied} 笔 / 共 ${report.totalPoints} 分 / 涉及 ${report.distinctUsers} 人`
    )
  }
  return json(report)
}

/** POST /api/admin/points/products —— 新建官方商品 */
export async function createShopProduct(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdmin(env, request)
  assertContentLengthWithin(request, MAX_JSON_BODY_BYTES, "请求内容过大")
  const body = await request.json().catch(() => ({}))
  const product = await createProduct(env, body)
  await audit(env, admin.id, "points.shop.product", `新建商品「${product.name}」（${product.price} 积分）`)
  return json({ product })
}

/** PUT /api/admin/points/products/:id —— 编辑官方商品 */
export async function updateShopProduct(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireAdmin(env, request)
  assertContentLengthWithin(request, MAX_JSON_BODY_BYTES, "请求内容过大")
  const body = await request.json().catch(() => ({}))
  const product = await updateProduct(env, id, body)
  await audit(env, admin.id, "points.shop.product", `更新商品「${product.name}」（${product.price} 积分）`)
  return json({ product })
}

/** DELETE /api/admin/points/products/:id —— 删除商品（官方 / 用户商品都可以） */
export async function deleteShopProduct(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireAdmin(env, request)
  await deleteProduct(env, id)
  await audit(env, admin.id, "points.shop.product", `删除商品 ${id}`)
  return json({ ok: true })
}

/** POST /api/admin/points/products/:id/review —— 审核用户商品 */
export async function reviewShopProduct(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireAdmin(env, request)
  assertContentLengthWithin(request, MAX_JSON_BODY_BYTES, "请求内容过大")
  const body = (await request.json().catch(() => ({}))) as {
    approve?: unknown
    note?: unknown
  }
  if (typeof body.approve !== "boolean") {
    throw new ApiError(400, "请指明是通过还是拒绝", "INVALID_INPUT")
  }
  const note = typeof body.note === "string" ? body.note : undefined
  const product = await reviewProduct(env, admin.id, id, body.approve, note)
  return json({ product })
}

/** POST /api/admin/points/orders/:id/deliver —— 标记官方商品订单已发放 */
export async function deliverShopOrder(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireAdmin(env, request)
  assertContentLengthWithin(request, MAX_JSON_BODY_BYTES, "请求内容过大")
  const body = (await request.json().catch(() => ({}))) as { note?: unknown }
  const note = typeof body.note === "string" ? body.note : undefined
  const order = await deliverOrder(env, admin.id, id, note)
  return json({ order })
}

/** POST /api/admin/points/orders/:id/settle —— 强制结算用户商品订单 */
export async function settleShopOrder(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireAdmin(env, request)
  const order = await adminSettleOrder(env, admin.id, id)
  return json({ order })
}

/** POST /api/admin/points/orders/:id/cancel —— 取消订单并退款 */
export async function cancelShopOrder(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const admin = await requireAdmin(env, request)
  assertContentLengthWithin(request, MAX_JSON_BODY_BYTES, "请求内容过大")
  const body = (await request.json().catch(() => ({}))) as { reason?: unknown }
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 200) : ""
  const order = await adminCancelOrder(env, admin.id, id, reason || undefined)
  return json({ order })
}
