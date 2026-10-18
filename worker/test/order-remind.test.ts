// 订单超时未交付 → 提醒卖家（2026-10-17）
//
// 背景：线上 13 单停在 pending、11 个买家、289 积分锁在托管里，最久 15 天。
// 根因不是系统缺陷 —— 下单时卖家确实收到过带「去交付」按钮的消息，
// 但没人再管：没有超时提醒、没有超时退款。这里只补「再提醒一次」，
// 不动钱（自动退款是站长的策略决定）。
//
// 幂等靠 notifyOrder 的 dedupKey（order-remind:<订单号>）：
// 定时任务反复跑，同一单只会真正推送一次。本文件钉住这一点。
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser } from "./helpers"
import { remindStaleOrders } from "../src/points-shop"

/** 造一条 pending 订单；hoursAgo 控制下单时间 */
async function seedOrder(
  buyerId: string,
  buyerName: string,
  sellerId: string,
  hoursAgo: number
): Promise<string> {
  const id = crypto.randomUUID()
  const createdAt = new Date(Date.now() - hoursAgo * 3600_000).toISOString()
  await env.DB.prepare(
    `INSERT INTO point_orders
       (id, user_id, username, product_name, price, delivery, status, seller_id, seller_name, created_at)
     VALUES (?, ?, ?, '测试商品', 10, 'manual', 'pending', ?, '卖家', ?)`
  )
    .bind(id, buyerId, buyerName, sellerId, createdAt)
    .run()
  return id
}

async function remindCount(userId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND type = 'order_remind'"
  )
    .bind(userId)
    .first<{ c: number }>()
  return Number(row?.c ?? 0)
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM point_orders").run()
  await env.DB.prepare("DELETE FROM notifications").run()
})

describe("订单超时提醒卖家", () => {
  it("超过 48 小时未交付 → 提醒卖家一次；重复跑也不会重复提醒", async () => {
    const seller = await makeUser()
    const buyer = await makeUser()
    await seedOrder(buyer.id, buyer.username, seller.id, 72)

    const first = await remindStaleOrders(env)
    expect(first.considered).toBe(1)
    expect(await remindCount(seller.id)).toBe(1)

    // 再跑一次：dedupKey 幂等，通知数不应该增加
    const second = await remindStaleOrders(env)
    expect(second.considered).toBe(1)
    expect(await remindCount(seller.id)).toBe(1)
  })

  it("刚下单几小时的不提醒（避免骚扰正常交付节奏）", async () => {
    const seller = await makeUser()
    const buyer = await makeUser()
    await seedOrder(buyer.id, buyer.username, seller.id, 3)

    const r = await remindStaleOrders(env)

    expect(r.considered).toBe(0)
    expect(await remindCount(seller.id)).toBe(0)
  })

  it("官方商品（seller_id 为空）不提醒 —— 那由管理员手动发放", async () => {
    const buyer = await makeUser()
    const id = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO point_orders
         (id, user_id, username, product_name, price, delivery, status, created_at)
       VALUES (?, ?, ?, '官方商品', 5, 'manual', 'pending', ?)`
    )
      .bind(id, buyer.id, buyer.username, new Date(Date.now() - 72 * 3600_000).toISOString())
      .run()

    const r = await remindStaleOrders(env)

    expect(r.considered).toBe(0)
    expect(await remindCount(buyer.id)).toBe(0)
  })
})
