// 积分商城：买家取消「卖家还没发货」的订单（2026-10-30 站长要求）
//
// 需求原话：「如果用户购买了商品但是卖家一直没有发货，积分会自动退回吗」
//   —— 原先的答案是「不会」，而且买家**完全无路可走**：
//      `requestAfterSale` 明确拒绝 pending（「卖家还没有交付，请先等卖家发货」），
//      唯一出口是求管理员手动「取消订单并退款」，而管理员未必知道这单存在。
//
// 本文件钉住四条不变式：
//   1. pending 的单，买家可以自己取消 → 积分原路全额退回、库存归还、卖家收到通知；
//   2. **只**能取消 pending：卖家已交付（delivered）必须挡住，否则等于给
//      「白拿货再退款」开后门（这是本功能最危险的滥用面）；
//   3. 并发：卖家在同一刻点了「已交付」，抢占结果说了算 —— 订单不得被改成 cancelled；
//   4. 重复取消不重复退钱、不重复还库存（幂等）。
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf } from "./helpers"
import { applyPoints } from "../src/points"
import {
  buyerCancelOrder,
  buyProduct,
  createProduct,
  createUserProduct,
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

async function stockOf(productId: string): Promise<number | null> {
  const row = await env.DB.prepare("SELECT stock FROM point_products WHERE id = ?")
    .bind(productId)
    .first<{ stock: number | null }>()
  return row?.stock ?? null
}

/** 某个用户身上挂着订单 ID 的站内消息里，还有几条带「快捷按钮」的 */
async function orderMessagesWithButton(userId: string, orderId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM notifications
      WHERE user_id = ? AND json_valid(payload)
        AND json_extract(payload, '$.orderId') = ?
        AND json_extract(payload, '$.action') IS NOT NULL`
  )
    .bind(userId, orderId)
    .first<{ c: number }>()
  return Number(row?.c ?? 0)
}

/** 买家是否收到过某类订单消息（type 形如 order_cancelled） */
async function hasNotice(userId: string, type: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND type = ?"
  )
    .bind(userId, type)
    .first<{ c: number }>()
  return Number(row?.c ?? 0) > 0
}

/** 造一张「用户商品、已托管」的订单（pending）：买家 500 分买 100 分的商品，库存 10 */
async function makePendingOrder() {
  const buyer = await makeUser()
  const seller = await makeUser()
  const admin = await makeUser({ role: "admin" })
  await applyPoints(env, { userId: buyer.id, delta: 500, reason: "admin", detail: "测试充值" })

  const product = await createUserProduct(env, seller, {
    name: "买家取消测试商品",
    price: PRICE,
    delivery: "manual",
    stock: 10,
  })
  await reviewProduct(env, admin.id, product.id, true)

  const order = await buyProduct(env, buyer, product.id) // pending，买家 -100（托管）
  return { buyer, seller, admin, product, order }
}

function postCancel(user: { cookie: string }, orderId: string, reason = ""): Promise<Response> {
  return fetchSelf(
    authRequest(user, `/api/points/orders/${orderId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    })
  )
}

describe("积分商城：买家取消未发货订单", () => {
  it("卖家还没发货 → 买家可以取消，积分原路退回（HTTP 全链路）", async () => {
    const { buyer, seller, product, order } = await makePendingOrder()
    expect(await balance(buyer.id)).toBe(500 - PRICE) // 托管中
    expect(await stockOf(product.id)).toBe(9)

    const res = await postCancel(buyer, order.id, "等了两天一直没发货")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { order: { status: string; note: string | null } }
    expect(body.order.status).toBe("cancelled")
    expect(body.order.note).toContain("已退回")

    // 钱：买家全额拿回，卖家一分没动（本来就没拿到过）
    expect(await balance(buyer.id)).toBe(500)
    expect(await balance(seller.id)).toBe(0)
    // 库存归位
    expect(await stockOf(product.id)).toBe(10)
    // 双方都收到通知：卖家看到的是「订单被取消」，不是「退款成功」
    expect(await hasNotice(buyer.id, "order_cancelled")).toBe(true)
    expect(await hasNotice(seller.id, "order_cancelled")).toBe(true)
    // 卖家消息里那条「去交付」快捷按钮必须摘掉（否则点了只会报错）
    expect(await orderMessagesWithButton(seller.id, order.id)).toBe(0)

    // 理由进得了订单备注，卖家知道为什么被取消
    const row = await env.DB.prepare("SELECT note FROM point_orders WHERE id = ?")
      .bind(order.id)
      .first<{ note: string }>()
    expect(row?.note).toContain("等了两天一直没发货")
  })

  it("卖家已交付 → 不能取消（给「白拿货再退款」关门）", async () => {
    const { buyer, seller, order } = await makePendingOrder()
    await sellerDeliverOrder(env, seller.id, order.id)

    const res = await postCancel(buyer, order.id)
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe("ALREADY_DELIVERED")

    // 一分钱都没动，订单仍是 delivered（等买家确认或走售后）
    expect(await balance(buyer.id)).toBe(500 - PRICE)
    expect(await balance(seller.id)).toBe(0)
    expect((await getOrder(env, order.id))?.status).toBe("delivered")
  })

  it("别人的订单不能取消", async () => {
    const { order } = await makePendingOrder()
    const stranger = await makeUser()

    const res = await postCancel(stranger, order.id)
    expect(res.status).toBe(403)
    expect((await getOrder(env, order.id))?.status).toBe("pending")
  })

  it("重复取消：钱只退一次，库存也只还一次", async () => {
    const { buyer, product, order } = await makePendingOrder()

    const first = await postCancel(buyer, order.id)
    expect(first.status).toBe(200)

    const second = await postCancel(buyer, order.id)
    expect(second.status).toBe(409)
    expect(((await second.json()) as { code: string }).code).toBe("ORDER_CANCELLED")

    expect(await balance(buyer.id)).toBe(500)
    expect(await stockOf(product.id)).toBe(10) // 没有被还成 11
  })

  it("并发交错：卖家先交付、买家拿着 pending 旧快照取消 → 抢占拦住，订单不得变 cancelled（核心回归）", async () => {
    const { buyer, seller, order } = await makePendingOrder()

    // T0：买家页面读到的是 pending（真实世界里的快照）
    const stale = await getOrder(env, order.id)
    expect(stale?.status).toBe("pending")

    // T1：卖家抢先标记了已交付
    await sellerDeliverOrder(env, seller.id, order.id)

    // T2：买家那条请求继续往下走 —— 入口守卫会被旧快照骗过，
    //     真正拦住它的是 refundOrderCore 里「抢占结果必须是 pending」的那一步。
    await expect(
      refundOrderCore(env, stale!, {
        actorId: buyer.id,
        auditAction: "points.shop.buyer_cancel",
        reason: "并发回归",
        notifyEvent: "cancelled",
        onlyFrom: {
          status: "pending",
          code: "ALREADY_DELIVERED",
          message: "卖家刚刚已经交付了这单，不能再取消。",
        },
      })
    ).rejects.toMatchObject({ status: 409, code: "ALREADY_DELIVERED" })

    // 关键不变式：订单没有被写回 cancelled（否则卖家就白交付了）
    expect((await getOrder(env, order.id))?.status).toBe("delivered")
    expect(await balance(buyer.id)).toBe(500 - PRICE) // 没退款
    expect(await balance(seller.id)).toBe(0) // 也没结算
  })

  it("官方商品（没有卖家）的待发放订单同样可以取消", async () => {
    const buyer = await makeUser()
    await applyPoints(env, { userId: buyer.id, delta: 300, reason: "admin", detail: "测试充值" })
    const product = await createProduct(env, {
      name: "官方待发放商品",
      price: PRICE,
      delivery: "manual",
      stock: null,
    })
    const order = await buyProduct(env, buyer, product.id)
    expect(order.status).toBe("pending")

    const done = await buyerCancelOrder(env, buyer.id, order.id)
    expect(done.status).toBe("cancelled")
    expect(await balance(buyer.id)).toBe(300)
  })
})
