// 积分商城：库存归还的订单级幂等（退款 × 到期 cron 不得双还）
//
// 事故模型：归还库存有两条路径会碰到同一张单 —— 退款（refundOrderCore）与到期
// cron（expireRentalOrders）。旧实现用**调用方快照**的 expireHandledAt 判断
// 「这单的库存还过没有」：
//
//   if (!order.expireHandledAt) await restoreStock(env, order.productId)
//
// cron 在两次 await 之间把标记写掉之后，退款那侧的快照仍是 null
// ⇒ 两边各还一次，一件商品的库存凭空 +1（探针实测：stock 1 → 2）。
//
// 修复：新增 point_orders.stock_restored（0/1）做订单级原子占位，
// 抢到占位的那一方才真的 +1（restoreStockForOrder）。判据从「调用方读到的快照」
// 换成「库里的原子占位」—— 与 points-shop-escrow-race.test.ts 同一条原则。
//
// 复现手法（与 points-shop-escrow-race.test.ts 一致）：先读快照 → 让另一条路径
// 改库 → 再用旧快照调用。**串行调用永远测不出这个窗口**。
import { describe, it, expect, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser } from "./helpers"
import { applyPoints } from "../src/points"
import {
  buyProduct,
  createProduct,
  deliverOrder,
  expireRentalOrders,
  getOrder,
  refundOrderCore,
} from "../src/points-shop"

const PAST = new Date(Date.now() - 3600_000).toISOString()

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

/** 读商品当前库存（不限量返回 null） */
async function stockOf(productId: string): Promise<number | null> {
  const row = await env.DB.prepare("SELECT stock FROM point_products WHERE id = ?")
    .bind(productId)
    .first<{ stock: number | null }>()
  return row?.stock == null ? null : Number(row.stock)
}

/** 读订单的库存占位标记 */
async function restoredFlag(orderId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT stock_restored FROM point_orders WHERE id = ?")
    .bind(orderId)
    .first<{ stock_restored: number | null }>()
  return Number(row?.stock_restored ?? 0)
}

/**
 * 造一张「已交付、已到期、库存已被占用」的租用单。
 * stock=1 → 下单后为 0，交付后租期起算，再把 expires_at 拨到过去。
 */
async function makeExpiredRentalOrder(opts: { stock?: number | null; price?: number } = {}) {
  const admin = await makeUser({ role: "superadmin" })
  const buyer = await makeUser()
  await applyPoints(env, { userId: buyer.id, delta: 100, reason: "admin", detail: "测试充值" })

  const product = await createProduct(env, {
    name: "租用商品",
    price: opts.price ?? 20,
    delivery: "manual",
    stock: opts.stock === undefined ? 1 : opts.stock,
    billingMode: "rental",
    rentalDays: 7,
  })

  const order = await buyProduct(env, buyer, product.id)
  await deliverOrder(env, admin.id, order.id) // 人工发放 → 租期起算
  await env.DB.prepare("UPDATE point_orders SET expires_at = ? WHERE id = ?")
    .bind(PAST, order.id)
    .run()

  return { admin, buyer, product, order }
}

describe("库存归还：退款 × 到期 cron 的订单级幂等", () => {
  it("到期 cron 已还库存后，再用过期快照退款：库存不得再还一次（旧代码 1→2）", async () => {
    const { admin, product, order } = await makeExpiredRentalOrder()
    expect(await stockOf(product.id)).toBe(0) // 下单占用

    // T0：读出快照（此时 expire_handled_at 还是 null）
    const snapshot = await getOrder(env, order.id)
    expect(snapshot?.expireHandledAt).toBeNull()

    // T1：cron 先跑 —— 归还库存 + 打到期标记
    const r = await expireRentalOrders(env)
    expect(r.stockReturned).toBeGreaterThanOrEqual(1)
    expect(await stockOf(product.id)).toBe(1)

    // T2：退款用 T0 的旧快照进来（并发场景下 handler 读完快照后 cron 才跑）
    await refundOrderCore(env, snapshot!, {
      actorId: admin.id,
      auditAction: "points.shop.cancel",
      reason: "过期快照退款",
    })

    // 库存只有一份：还过一次就是 1
    expect(await stockOf(product.id)).toBe(1)
    expect(await restoredFlag(order.id)).toBe(1)
  })

  it("退款先还库存后，cron 再扫到同一单：不再还第二次", async () => {
    const { admin, product, order } = await makeExpiredRentalOrder()
    const snapshot = await getOrder(env, order.id)

    // T1：退款先跑（还库存 + 占位）
    await refundOrderCore(env, snapshot!, {
      actorId: admin.id,
      auditAction: "points.shop.cancel",
      reason: "先退款",
    })
    expect(await stockOf(product.id)).toBe(1)

    // T2：cron 再跑。该单 status=cancelled，已不在扫描范围（IN ('delivered','settled')），
    //     所以这里断言的是「cron 不会碰它」这个事实本身。
    const r = await expireRentalOrders(env)
    expect(r.checked).toBe(0)
    expect(await stockOf(product.id)).toBe(1)
  })

  it("正常退款（没有 cron 参与）：库存确实还回去（闸门不得把正常路径改死）", async () => {
    const { admin, product, order } = await makeExpiredRentalOrder()
    const snapshot = await getOrder(env, order.id)

    await refundOrderCore(env, snapshot!, {
      actorId: admin.id,
      auditAction: "points.shop.cancel",
      reason: "正常退款",
    })

    // 只断言**可观察行为**（库存），不读内部占位列 —— 反向守护要在旧代码上也绿，
    // 否则它测的是「新列存在」而不是「正常路径没被改死」。
    expect(await stockOf(product.id)).toBe(1)
  })

  it("同一单重复退款：第二个被拦下，库存仍只还一次", async () => {
    const { admin, product, order } = await makeExpiredRentalOrder()
    const snapshot = await getOrder(env, order.id)

    await refundOrderCore(env, snapshot!, {
      actorId: admin.id,
      auditAction: "points.shop.cancel",
      reason: "A",
    })
    await expect(
      refundOrderCore(env, snapshot!, {
        actorId: admin.id,
        auditAction: "points.shop.cancel",
        reason: "B",
      })
    ).rejects.toThrow()

    expect(await stockOf(product.id)).toBe(1)
  })

  it("cron 连跑两次：第二次扫不到，库存不变", async () => {
    const { product } = await makeExpiredRentalOrder()

    const r1 = await expireRentalOrders(env)
    expect(r1.stockReturned).toBeGreaterThanOrEqual(1)
    expect(await stockOf(product.id)).toBe(1)

    const r2 = await expireRentalOrders(env)
    expect(r2.checked).toBe(0)
    expect(r2.stockReturned).toBe(0)
    expect(await stockOf(product.id)).toBe(1)
  })

  it("回填语义：占位已是 1 的老单（迁移回填过的）退款时不再还库存", async () => {
    const { admin, product, order } = await makeExpiredRentalOrder()

    // 模拟迁移回填：老单历史上已被 cron 处理过（expire_handled_at 有值），
    // 0135 的回填语句会把它标成 stock_restored=1。
    await env.DB.prepare(
      "UPDATE point_orders SET expire_handled_at = ?, stock_restored = 1 WHERE id = ?"
    )
      .bind(PAST, order.id)
      .run()

    const snapshot = await getOrder(env, order.id)
    expect(snapshot?.expireHandledAt).toBe(PAST) // 快照里带着「已处理」标记

    await refundOrderCore(env, snapshot!, {
      actorId: admin.id,
      auditAction: "points.shop.cancel",
      reason: "老单退款",
    })

    // 回填把它标成「已还过」⇒ 退款不再 +1（旧代码这里也会跳过，因为快照带标记；
    // 本用例守的是「占位与快照判据一致」，防止将来只删快照判据而漏掉回填）
    expect(await stockOf(product.id)).toBe(0)
    expect(await restoredFlag(order.id)).toBe(1)
  })

  it("不限量商品（stock IS NULL）：退款不涨库存、也不报错", async () => {
    const { admin, product, order } = await makeExpiredRentalOrder({ stock: null })
    expect(await stockOf(product.id)).toBeNull()

    const snapshot = await getOrder(env, order.id)
    await refundOrderCore(env, snapshot!, {
      actorId: admin.id,
      auditAction: "points.shop.cancel",
      reason: "不限量商品退款",
    })

    // 占位拿到了（订单级），但商品不限量 ⇒ 库存仍是 NULL，不报错。
    // 只断言可观察行为（库存），理由同「正常退款」那条。
    expect(await stockOf(product.id)).toBeNull()
  })

  it("商品已删除后退款：不报错，订单仍能正常取消", async () => {
    const { admin, product, order } = await makeExpiredRentalOrder()

    // 管理员删掉商品（DELETE FROM point_products，见 deleteProduct）
    await env.DB.prepare("DELETE FROM point_products WHERE id = ?").bind(product.id).run()

    const snapshot = await getOrder(env, order.id)
    const done = await refundOrderCore(env, snapshot!, {
      actorId: admin.id,
      auditAction: "points.shop.cancel",
      reason: "商品已删",
    })

    expect(done.status).toBe("cancelled")
    // 只断言可观察行为（订单正常取消），理由同「正常退款」那条
  })

  it("第二条窗口：自动交付失败补偿 × 管理员当场取消，库存只还一次（旧代码 1→2）", async () => {
    // 这条不用「过期快照」技巧 —— 它是**真实交错**：下单请求正在 await 上游充值
    // 时，管理员把这单取消了（打桩的 fetch 里直接调 refundOrderCore 模拟）。
    // 随后上游返回失败 ⇒ 下单请求走补偿分支，两处都碰同一份库存。
    const admin = await makeUser({ role: "superadmin" })
    const buyer = await makeUser()
    await applyPoints(env, { userId: buyer.id, delta: 100, reason: "admin", detail: "测试充值" })

    const now = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO newapi_accounts
         (user_id, newapi_user_id, username, email, enc_token, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(buyer.id, 9301, "na_9301", "na_9301@doulor.cn", "enc", now)
      .run()

    const product = await createProduct(env, {
      name: "自动充值商品",
      price: 30,
      delivery: "quota",
      quotaYuan: 10,
      stock: 1,
    })
    expect(await stockOf(product.id)).toBe(1)

    // 打桩：在「上游充值」这一步插入管理员的取消，然后返回失败
    const original = globalThis.fetch
    restoreFetch = () => {
      globalThis.fetch = original
    }
    let cancelled: string | null = null
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
        // 交错点：此刻订单行已落库（pending），库存已被占 1 份。
        // 管理员「取消订单」→ 退款路径归还库存。
        const row = await env.DB.prepare(
          "SELECT id FROM point_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 1"
        )
          .bind(buyer.id)
          .first<{ id: string }>()
        cancelled = row?.id ?? null
        const fresh = cancelled ? await getOrder(env, cancelled) : null
        if (fresh) {
          await refundOrderCore(env, fresh, {
            actorId: admin.id,
            auditAction: "points.shop.cancel",
            reason: "交错：管理员当场取消",
          })
        }
        // 让交付**失败**，把下单请求推进补偿分支
        return jsonResponse({ success: false, message: "上游炸了" }, 500)
      }
      return original(input as RequestInfo, init)
    }) as typeof fetch

    await expect(buyProduct(env, buyer, product.id)).rejects.toThrow()
    restoreFetch()
    restoreFetch = null

    expect(cancelled).toBeTruthy()
    // 关键断言：库存只有 1 份 —— 退款还过一次之后，补偿分支不得再还
    expect(await stockOf(product.id)).toBe(1)
  })
})
