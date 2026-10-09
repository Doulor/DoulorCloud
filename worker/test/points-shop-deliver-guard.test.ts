// 积分商城：交付路径写 delivered 的**状态守卫**（并发取消后不得复活订单）
//
// 事故模型（issue #39）：`deliverOrder`（管理员发放）与 `sellerDeliverOrder`
// （卖家标记交付）写 `status='delivered'` 时**没有状态守卫**：
//
//   const order = await getOrder(env, orderId)          // 读
//   if (order.status === "cancelled") throw ...         // 基于这次读的快照
//   UPDATE point_orders SET status = 'delivered' ... WHERE id = ?   // ← 无条件写
//
// ⚠️ 关键：这两条路径**自己会重读库**（不像 settleEscrow 收调用方传入的快照），
//    所以「调用方持过期快照」**复现不出**这个缺陷 —— 函数一进来就重新读了。
//    窗口在**函数内部**：`getOrder` 与那条 UPDATE 之间（一次 D1 往返）。要复现
//    必须在那一刻注入并发的取消，故用 `new Proxy(env.DB)` 拦 `prepare`
//    （仓库既有惯用法见 test/checkin-makeup-cards.test.ts:169）。
//
// 交错语义：
//   T0 卖家请求进入 → getOrder 读到 pending
//   T1 管理员取消 → 退买家 +price、订单置 cancelled、还库存
//   T2 卖家那条 UPDATE 落库（无守卫）⇒ 订单被写回 delivered
//
// 复活后它与正常交付单再无区别：到期 cron（autoConfirmDeliveries）扫到它、
// 正常结算 ⇒ **卖家又拿一次钱**，而买家已收到退款 = 平台净增发 price。
//
// 修复：两条 UPDATE 都加 `AND status = 'pending'`，按 `meta.changes` 判定，
// 拿不到占位就重读订单给出准确报错（沿用 settleEscrow 的 settleConflictError 写法）。

import { describe, it, expect, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, setSetting } from "./helpers"
import { applyPoints } from "../src/points"
import {
  autoConfirmDeliveries,
  buyProduct,
  createProduct,
  createUserProduct,
  deliverOrder,
  getOrder,
  refundOrderCore,
  reviewProduct,
  sellerDeliverOrder,
} from "../src/points-shop"

const PRICE = 100

async function balance(userId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COALESCE(balance, 0) AS b FROM user_points WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ b: number }>()
  return Number(row?.b ?? 0)
}

/**
 * 在「交付那条 UPDATE 即将落库」的那一刻注入并发的管理员取消。
 *
 * 过滤器刻意只匹配 `UPDATE point_orders SET status = 'delivered'` ——
 * 修复后 SQL 尾部会多出 `AND status = 'pending'`，用完整原文匹配会让注入在
 * 修复后**静默失效**、用例变成空转（实测踩过：加守卫前写成完整匹配）。
 */
function injectConcurrentCancel(
  orderId: string,
  adminId: string
): { patchedEnv: typeof env; fired: () => boolean } {
  const realDb = env.DB
  let injected = false
  const proxyDb = new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (!injected && sql.includes("UPDATE point_orders SET status = 'delivered'")) {
            injected = true
            const orig = target.prepare(sql)
            return {
              bind: (...args: unknown[]) => ({
                run: async () => {
                  const snap = await getOrder(env, orderId)
                  if (snap) {
                    await refundOrderCore(env, snap, {
                      actorId: adminId,
                      auditAction: "points.shop.cancel",
                      reason: "并发取消",
                    })
                  }
                  return orig.bind(...args).run()
                },
              }),
            }
          }
          return target.prepare(sql)
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  const patchedEnv = Object.create(env) as typeof env
  patchedEnv.DB = proxyDb as unknown as typeof env.DB
  return { patchedEnv, fired: () => injected }
}

/** 造一张「用户商品、已托管」的订单（pending） */
async function makeUserProductOrder() {
  const buyer = await makeUser()
  const seller = await makeUser()
  const admin = await makeUser({ role: "admin" })
  await applyPoints(env, { userId: buyer.id, delta: 500, reason: "admin", detail: "测试充值" })

  const product = await createUserProduct(env, seller, {
    name: "交付守卫测试商品",
    price: PRICE,
    delivery: "manual",
    stock: 10,
  })
  await reviewProduct(env, admin.id, product.id, true)

  const order = await buyProduct(env, buyer, product.id) // pending，买家 -100（托管）
  return { buyer, seller, admin, product, order }
}

/** 造一张「官方商品、待管理员发放」的订单（pending） */
async function makeOfficialOrder() {
  const buyer = await makeUser()
  const admin = await makeUser({ role: "admin" })
  await applyPoints(env, { userId: buyer.id, delta: 500, reason: "admin", detail: "测试充值" })

  const product = await createProduct(env, {
    name: "官方待发放商品",
    price: PRICE,
    delivery: "manual",
    stock: 10,
  })

  const order = await buyProduct(env, buyer, product.id) // pending
  return { buyer, admin, product, order }
}

describe("交付路径的状态守卫：并发取消后订单不得被复活", () => {
  it("卖家标记交付 × 管理员取消交错：订单不得复活，卖家拿不到钱（核心回归）", async () => {
    const { buyer, seller, admin, order } = await makeUserProductOrder()
    const { patchedEnv, fired } = injectConcurrentCancel(order.id, admin.id)

    // 卖家标记交付；在它那条 UPDATE 落库前，管理员取消已经跑完
    // 修复后：占位拿不到 ⇒ 抛准确报错（修复前：静默把订单写回 delivered）
    // 钉错误码（不只钉文案）：仓库既有惯例是断言稳定 code，
    // 否则有人改文案 / 挪 throw 位置时测试不会红。
    await expect(sellerDeliverOrder(patchedEnv, seller.id, order.id)).rejects.toMatchObject({
      status: 409,
      code: "ORDER_CANCELLED",
    })

    expect(fired()).toBe(true) // 注入确实生效（否则本用例是空转）
    expect(await balance(buyer.id)).toBe(500) // 已退款

    // 关键不变式：订单仍是 cancelled（修复前被写回 delivered）
    expect((await getOrder(env, order.id))?.status).toBe("cancelled")

    // 且到期 cron 扫不到它 ⇒ 不会再结算给卖家（修复前：卖家再得 100 = 平台净增发）
    await setSetting("shop_auto_confirm_days", "1")
    await env.DB.prepare("UPDATE point_orders SET delivered_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 2 * 86400_000).toISOString(), order.id)
      .run()
    expect(await autoConfirmDeliveries(env)).toBe(0)
    expect(await balance(seller.id)).toBe(0)
  })

  it("管理员发放 × 管理员取消交错：官方单不得复活", async () => {
    const { buyer, admin, order } = await makeOfficialOrder()
    const { patchedEnv, fired } = injectConcurrentCancel(order.id, admin.id)

    await expect(deliverOrder(patchedEnv, admin.id, order.id)).rejects.toMatchObject({
      status: 409,
      code: "ORDER_CANCELLED",
    })

    expect(fired()).toBe(true)
    expect((await getOrder(env, order.id))?.status).toBe("cancelled")
    expect(await balance(buyer.id)).toBe(500)
  })

  it("前提钉：调用方持过期快照**复现不出**本缺陷（函数自己会重读库）", async () => {
    // ⚠️ 这条**不验证修复**，它钉住的是「窗口在函数内部」这个前提：
    //    两条交付路径入口都 `getOrder` 重读，所以过期快照在这里是无效手法。
    //    将来若有人把函数改成收调用方快照（像 settleEscrow 那样），这条会红 ——
    //    那正是需要重新评估窗口形状的信号。
    const { buyer, seller, admin, order } = await makeUserProductOrder()

    const stale = await getOrder(env, order.id)
    expect(stale?.status).toBe("pending")

    await refundOrderCore(env, stale!, {
      actorId: admin.id,
      auditAction: "points.shop.cancel",
      reason: "先取消",
    })

    // 直接调用（不带注入）：函数重读到 cancelled ⇒ 入口守卫拦下，UPDATE 不执行
    await expect(sellerDeliverOrder(env, seller.id, order.id)).rejects.toThrow()
    expect((await getOrder(env, order.id))?.status).toBe("cancelled")
    expect(await balance(buyer.id)).toBe(500)
  })

  it("正常交付：pending → delivered 照常成功（闸门不得把正常路径改死）", async () => {
    const { seller, order } = await makeUserProductOrder()

    const done = await sellerDeliverOrder(env, seller.id, order.id)
    expect(done.status).toBe("delivered")
    expect((await getOrder(env, order.id))?.status).toBe("delivered")
  })

  it("管理员正常发放官方单：pending → delivered 照常成功", async () => {
    const { admin, order } = await makeOfficialOrder()

    const done = await deliverOrder(env, admin.id, order.id)
    expect(done.status).toBe("delivered")
  })

  it("同一单重复标记交付：第二次被拦下（不静默成功）", async () => {
    const { seller, order } = await makeUserProductOrder()

    await sellerDeliverOrder(env, seller.id, order.id)
    await expect(sellerDeliverOrder(env, seller.id, order.id)).rejects.toThrow()

    expect((await getOrder(env, order.id))?.status).toBe("delivered")
  })

  it("先标记交付再取消：取消仍能正常进行（反向不回归）", async () => {
    const { buyer, seller, admin, order } = await makeUserProductOrder()

    await sellerDeliverOrder(env, seller.id, order.id)
    const fresh = await getOrder(env, order.id)

    const done = await refundOrderCore(env, fresh!, {
      actorId: admin.id,
      auditAction: "points.shop.cancel",
      reason: "交付后取消",
    })
    expect(done.status).toBe("cancelled")
    expect(await balance(buyer.id)).toBe(500) // 已退款
  })
})

// ---------------------------------------------------------------------------
// 第三处写点：buyProduct 里「自动交付成功」那条 UPDATE
// （`UPDATE point_orders SET status = 'delivered', delivered_at = ?, note = ?,` +
//  `delivery_content = ? ...`；行号随主干漂移，以这段 SQL 为准）
//
// issue #39 的盘点表把它标为「同形；订单由本请求刚建成 pending，窗口窄」——
// **这个判断是错的，本组实测推翻**：它的窗口是 `deliverAuto` 里那次真实上游调用
// （NewAPI 充值 / 开订阅，最长 NEWAPI_TIMEOUT_MS = 20 秒），比另两处的
// 「一次 D1 往返」宽得多。探针实测：`deliverAuto` 期间注入并发取消，
// 旧代码订单被写回 delivered、买家已退款（本组第一条用例即其固化）。
//
// ⚠️ 语义与另两处不同：走到那一步**权益已经真的发出去了**（额度已充 / 订阅已开 /
//    卡密已取），撤不回来。占位失败只能抛错交给 `deliveryApplied` 分支记日志、
//    留给管理员对账 —— 「已交付但订单已被并发取消」的固有残留，修不掉。
describe("自动交付路径的同一守卫（窗口更宽：跨一次上游调用）", () => {
  const NEWAPI = "https://api.doulor.cn"
  let restoreFetch: (() => void) | null = null

  afterEach(() => {
    restoreFetch?.()
    restoreFetch = null
  })

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  }

  it("deliverAuto 期间被并发取消：订单不得复活（旧代码被写回 delivered）", async () => {
    const admin = await makeUser({ role: "admin" })
    const buyer = await makeUser()
    await applyPoints(env, { userId: buyer.id, delta: 500, reason: "admin", detail: "测试充值" })

    const now = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO newapi_accounts
         (user_id, newapi_user_id, username, email, enc_token, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(buyer.id, 9401, "na_9401", "na_9401@doulor.cn", "enc", now)
      .run()

    const product = await createProduct(env, {
      name: "自动充值商品",
      price: 30,
      delivery: "quota",
      quotaYuan: 10,
      stock: 5,
    })

    const original = globalThis.fetch
    restoreFetch = () => {
      globalThis.fetch = original
    }
    let injected = false
    let orderIdSeen: string | null = null
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (!url.startsWith(NEWAPI)) return original(input as RequestInfo, init)

      if (url.includes("/api/status")) {
        return jsonResponse({
          success: true,
          data: { quota_display_type: "CNY", quota_per_unit: 500000 },
        })
      }
      if (url.includes("/api/user/manage")) {
        // 交错点：deliverAuto 正在跑（订单行已 pending），管理员此刻取消。
        const row = await env.DB.prepare(
          "SELECT id FROM point_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 1"
        )
          .bind(buyer.id)
          .first<{ id: string }>()
        orderIdSeen = row?.id ?? null
        if (orderIdSeen) {
          const snap = await getOrder(env, orderIdSeen)
          if (snap) {
            await refundOrderCore(env, snap, {
              actorId: admin.id,
              auditAction: "points.shop.cancel",
              reason: "交错：管理员取消",
            })
            injected = true
          }
        }
        // 让上游**成功**：走「自动交付成功」那条 UPDATE（而非补偿分支）
        return jsonResponse({ success: true, data: {} })
      }
      return original(input as RequestInfo, init)
    }) as typeof fetch

    // 占位失败 ⇒ 抛错（交给 deliveryApplied 分支记审计）；关键是不静默复活订单。
    // 钉外层契约：权益已真实发出（上游已充值），所以对外必须是 500（不是 409，
    // 否则用户会以为没发货）；且这条交错里订单**已被取消** ⇒ 走
    // DELIVERED_ORDER_CANCELLED 那句（不承诺「稍后同步完成」，因为永远不会）。
    await expect(buyProduct(env, buyer, product.id)).rejects.toMatchObject({
      status: 500,
      code: "DELIVERED_ORDER_CANCELLED",
    })
    restoreFetch()
    restoreFetch = null

    expect(injected).toBe(true) // 注入确实生效（否则用例空转）
    const fresh = orderIdSeen ? await getOrder(env, orderIdSeen) : null
    expect(fresh?.status).toBe("cancelled") // 修复前：delivered
    expect(await balance(buyer.id)).toBe(500) // 已退款
  })

  it("用户商品（content 交付）同一交错：订单不得复活，卖家不得二次收款", async () => {
    // 这条比上一条更接近钱：官方单 seller_id 为 NULL，cron 不会结算它；
    // 而**用户商品**（content/code 交付走自动路径）被复活后 seller_id 非空，
    // autoConfirmDeliveries 会正常结算 ⇒ 卖家二次收款（探针实测：旧代码
    // 买家=500 已退款、卖家=100 ⇒ 平台净增发 100）。
    const admin = await makeUser({ role: "admin" })
    const buyer = await makeUser()
    const seller = await makeUser()
    await applyPoints(env, { userId: buyer.id, delta: 500, reason: "admin", detail: "测试充值" })

    const product = await createUserProduct(env, seller, {
      name: "用户固定内容商品",
      price: 100,
      delivery: "content",
      deliveryParams: { content: "这是一段固定内容" },
      stock: 5,
    })
    await reviewProduct(env, admin.id, product.id, true)

    // content 交付不调用上游，没有天然 await 窗口 ⇒ 用 Proxy 拦那条 UPDATE
    // （仓库既有惯用法见 checkin-makeup-cards.test.ts:169）
    const realDb = env.DB
    let injected = false
    let orderIdSeen: string | null = null
    const proxyDb = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (
              !injected &&
              sql.includes("UPDATE point_orders SET status = 'delivered'") &&
              sql.includes("delivery_content")
            ) {
              injected = true
              const orig = target.prepare(sql)
              return {
                bind: (...args: unknown[]) => ({
                  run: async () => {
                    const row = await target
                      .prepare(
                        "SELECT id FROM point_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 1"
                      )
                      .bind(buyer.id)
                      .first<{ id: string }>()
                    orderIdSeen = row?.id ?? null
                    if (orderIdSeen) {
                      const snap = await getOrder(env, orderIdSeen)
                      if (snap) {
                        await refundOrderCore(env, snap, {
                          actorId: admin.id,
                          auditAction: "points.shop.cancel",
                          reason: "交错：管理员取消",
                        })
                      }
                    }
                    return orig.bind(...args).run()
                  },
                }),
              }
            }
            return target.prepare(sql)
          }
        }
        const value = Reflect.get(target, prop, receiver)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    const patchedEnv = Object.create(env) as typeof env
    patchedEnv.DB = proxyDb as unknown as typeof env.DB

    await expect(buyProduct(patchedEnv, buyer, product.id)).rejects.toMatchObject({
      status: 500,
      code: "DELIVERED_ORDER_CANCELLED",
    })

    expect(injected).toBe(true)
    expect((await getOrder(env, orderIdSeen!))?.status).toBe("cancelled")

    // 残留必须落审计（console.error 在 wrangler.toml 无 observability 时不落盘，
    // 而这里的权益已真实发出 ⇒ 没有痕迹就等于无声损失）
    const audited = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM audit_logs WHERE action = ? AND detail LIKE ?"
    )
      .bind("points.shop.deliver_conflict_residual", `%${orderIdSeen}%`)
      .first<{ c: number }>()
    expect(Number(audited?.c ?? 0)).toBe(1)

    // 到期 cron：订单已是 cancelled ⇒ 扫不到，卖家拿不到钱（修复前结算 1 笔、卖家 +100）
    await setSetting("shop_auto_confirm_days", "1")
    await env.DB.prepare("UPDATE point_orders SET delivered_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 2 * 86400_000).toISOString(), orderIdSeen)
      .run()
    expect(await autoConfirmDeliveries(env)).toBe(0)
    expect(await balance(seller.id)).toBe(0) // 平台未净增发
    expect(await balance(buyer.id)).toBe(500) // 已退款
  })
})
