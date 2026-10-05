/**
 * 回归：「消费达人」（shop_orders）成就应把「直接兑换中转站余额」也算进去。
 *
 * 缺陷原状（2026-10-05 用户 zzy 反馈「用积分换了中转站额度，但成就没计次」）：
 * 该成就原先只数 `point_orders`（商城订单），而「直接兑换中转站余额」
 * （points.ts redeemPoints）只写一条 reason='redeem' 的积分流水、**不生成订单**，
 * 于是兑换了也白兑换、成就不动。成就自述的 how 里明说「兑换商品或中转站余额」。
 *
 * 修复：shop_orders = 商城订单(delivered/settled) + redeem 成功流水(delta<0)。
 * 失败退回是正数，天然不计入。
 */
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, type TestUser } from "./helpers"
import { uuid } from "../src/crypto"

async function seedShopOrder(user: TestUser, status = "delivered"): Promise<void> {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO point_orders
       (id, user_id, username, product_name, price, delivery, status, created_at)
     VALUES (?, ?, ?, '测试商品', 10, 'manual', ?, ?)`
  )
    .bind(uuid(), user.id, user.username, status, now)
    .run()
}

async function seedRedeem(user: TestUser, delta = -1): Promise<void> {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO point_transactions
       (id, user_id, delta, balance, reason, detail, created_at)
     VALUES (?, ?, ?, 0, 'redeem', '兑换中转站余额 ¥10', ?)`
  )
    .bind(uuid(), user.id, delta, now)
    .run()
}

async function shopOrdersValue(user: TestUser): Promise<number> {
  const res = await fetchSelf(authRequest(user, "/api/achievements"))
  expect(res.status).toBe(200)
  const data = await res.json<{ achievements: { id: string; value: number }[] }>()
  return data.achievements.find((a) => a.id === "shop_orders")?.value ?? -1
}

describe("消费达人成就：直接兑换中转站余额也计数", () => {
  it("商城订单 + 直接兑换 → 两者都算", async () => {
    const u = await makeUser()
    await seedShopOrder(u, "delivered") // 商城订单 1 笔
    await seedRedeem(u, -1) // 直接兑换 1 次

    expect(await shopOrdersValue(u)).toBe(2)
  })

  it("只有直接兑换（无商城订单）→ 计 1", async () => {
    const u = await makeUser()
    await seedRedeem(u, -1)

    expect(await shopOrdersValue(u)).toBe(1)
  })

  it("兑换失败退回（正数流水）不算入", async () => {
    const u = await makeUser()
    await seedRedeem(u, 1) // 退回：delta 为正

    expect(await shopOrdersValue(u)).toBe(0)
  })

  it("取消的商城订单不计入（只数 delivered/settled）", async () => {
    const u = await makeUser()
    await seedShopOrder(u, "cancelled")

    expect(await shopOrdersValue(u)).toBe(0)
  })
})
