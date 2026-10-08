// 积分商城：确认收货 × 售后退款的并发资金安全（2026-10-08 审查修复回归）
//
// 事故模型：两条路径各自基于**调用方传入的订单快照**决定要不要动钱 ——
//   T1 买家「确认收货」（结算给卖家）与 T2 卖家「同意退款」并发时，
//   两边读到的快照都是 delivered → 卖家 +price（结算）且买家 +price（退款）
//   = 一笔订单凭空增发 price 积分（可自买自卖反复刷成 NewAPI 真额度）。
//
// 修复：两条路径都改为**原子状态抢占**，以抢占结果为真相源：
//   · settleEscrow：`UPDATE ... SET settled WHERE id=? AND status='delivered'`
//   · refundOrderCore：claimRefundSlot 逐级占 pending/delivered/settled，
//     用抢到的「原状态」决定是否从卖家收回收益。
//   抢不到 → 返回冲突，不再动钱。
//
// 测试用「过期快照」精确复现竞态（HTTP 层 handler 每次都会重读库，
// 串行调用永远测不出这个窗口）：先读快照 → 让另一条路径结算掉 → 再用旧快照退款。

import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser } from "./helpers"
import { applyPoints } from "../src/points"
import {
  buyProduct,
  createUserProduct,
  getOrder,
  refundOrderCore,
  reviewProduct,
  sellerDeliverOrder,
  settleEscrow,
} from "../src/points-shop"

const PRICE = 100

/** 造「买家已下单（托管中）→ 卖家已标记交付」的订单；买家初始 500 分 */
async function makeDeliveredOrder() {
  const buyer = await makeUser()
  const seller = await makeUser()
  const admin = await makeUser({ role: "admin" })

  await applyPoints(env, { userId: buyer.id, delta: 500, reason: "admin", detail: "测试充值" })

  const product = await createUserProduct(env, seller, {
    name: "并发测试商品",
    price: PRICE,
    delivery: "manual",
    stock: 10,
  })
  await reviewProduct(env, admin.id, product.id, true)

  const order = await buyProduct(env, buyer, product.id) // 托管扣款：pending
  await sellerDeliverOrder(env, seller.id, order.id) // → delivered

  const fresh = await getOrder(env, order.id)
  if (!fresh) throw new Error("订单创建失败")
  return { buyer, seller, admin, order: fresh }
}

async function balance(userId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COALESCE(balance, 0) AS b FROM user_points WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ b: number }>()
  return Number(row?.b ?? 0)
}

describe("积分商城并发资金安全：确认收货 × 退款", () => {
  it("持过期快照退款时必须收回卖家收益（不得双拿）——核心回归", async () => {
    const { buyer, seller, order } = await makeDeliveredOrder()
    const buyerBefore = await balance(buyer.id) // 500 - 100（托管）
    const sellerBefore = await balance(seller.id) // 0

    // T1：买家确认收货（此路径持新鲜快照，属正常调用）
    await settleEscrow(env, order, buyer.id, "买家确认收货")
    expect(await balance(seller.id)).toBe(sellerBefore + PRICE) // 卖家已拿到结算款

    // T2：卖家同意退款 —— 但 **拿着 T0 读到的旧快照**（模拟并发请求的读-用错位）
    const after = await refundOrderCore(env, order, {
      actorId: seller.id,
      auditAction: "points.shop.after_sale_refund",
      reason: "卖家同意退款",
      afterSaleStatus: "refunded",
      afterSaleNote: "并发回归",
    })

    expect(after.status).toBe("cancelled")
    // 抢占识别出真实状态是 settled → 从卖家收回 100 → 卖家净 0（修复前此处为 +100）
    expect(await balance(seller.id)).toBe(sellerBefore)
    // 买家拿回钱：500 - 100 + 100 = 500
    expect(await balance(buyer.id)).toBe(buyerBefore + PRICE)
  })

  it("先退款后确认收货：结算被冲突拦住，不给卖家钱", async () => {
    const { buyer, seller, order } = await makeDeliveredOrder()

    await refundOrderCore(env, order, {
      actorId: seller.id,
      auditAction: "points.shop.after_sale_refund",
      reason: "卖家同意退款",
    })

    // 旧快照（delivered）也必须被抢占拦下
    await expect(settleEscrow(env, order, buyer.id, "买家确认收货")).rejects.toThrow()
    expect(await balance(seller.id)).toBe(0)
    expect(await balance(buyer.id)).toBe(500)
  })

  it("同一订单并发退款：第二个抢不到，钱只退一次", async () => {
    const { buyer, admin, order } = await makeDeliveredOrder()

    await refundOrderCore(env, order, {
      actorId: admin.id,
      auditAction: "points.shop.cancel",
      reason: "A",
    })
    await expect(
      refundOrderCore(env, order, {
        actorId: admin.id,
        auditAction: "points.shop.cancel",
        reason: "B",
      })
    ).rejects.toThrow()

    expect(await balance(buyer.id)).toBe(500) // 500（初始）退款后
  })

  it("已结算订单用新鲜快照退款：先收回卖家再退买家（正常路径不回归）", async () => {
    const { buyer, seller, admin, order } = await makeDeliveredOrder()

    await settleEscrow(env, order, buyer.id, "买家确认收货")
    const fresh = await getOrder(env, order.id)
    expect(fresh?.status).toBe("settled")

    const done = await refundOrderCore(env, fresh!, {
      actorId: admin.id,
      auditAction: "points.shop.cancel",
      reason: "测试取消",
    })
    expect(done.status).toBe("cancelled")
    expect(await balance(seller.id)).toBe(0) // 收益已收回
    expect(await balance(buyer.id)).toBe(500) // 已退款给买家

    // 重复结算 / 重复退款都被幂等拦住
    await expect(settleEscrow(env, order, buyer.id, "买家确认收货")).rejects.toThrow()
    await expect(
      refundOrderCore(env, fresh!, { actorId: admin.id, auditAction: "points.shop.cancel" })
    ).rejects.toThrow()
  })
})
