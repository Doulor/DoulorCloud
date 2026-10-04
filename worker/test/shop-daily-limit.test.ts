/**
 * 积分商城：每日限量（2026-10-04 站长反馈）。
 *
 * 站长反馈的问题：总量不限（stock=null）时设置了每日限额，但前端**看不到
 * 「今日剩余几个」**，感觉限额没生效。经排查：后端限额逻辑本身独立于总量、
 * 是好的；缺的是把「今日已售」下发给前端展示。
 *
 * 本文件验证三件事：
 *   1. 总量不限 + 每日限额：限额真的会拦（第 N+1 单被拒）
 *   2. 商品列表带出的 `dailySold` 与实际售出数一致（前端靠它显示剩余）
 *   3. 每日额度用完后：下单被拒、dailySold 不再虚增（失败回退计数）
 */
import { describe, expect, it } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser } from "./helpers"

type U = Awaited<ReturnType<typeof makeUser>>

function jsonInit(body: unknown, method = "POST"): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }
}

async function givePoints(user: U, balance: number): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO user_points (user_id, balance, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(user_id) DO UPDATE SET balance = excluded.balance, updated_at = excluded.updated_at"
  )
    .bind(user.id, balance, new Date().toISOString())
    .run()
}

/** 管理员建一件「总量不限 + 每日限额」商品（固定内容交付，最简单） */
async function dailyProduct(admin: U, dailyLimit: number): Promise<string> {
  const res = await fetchSelf(
    authRequest(
      admin,
      "/api/admin/points/products",
      jsonInit({
        name: "每日限量商品",
        price: 3,
        stock: null, // 总量不限
        dailyLimit,
        delivery: "content",
        deliveryParams: { content: "内容" },
      })
    )
  )
  expect(res.status).toBe(200)
  return ((await res.json()) as { product: { id: string } }).product.id
}

function buy(user: U, productId: string): Promise<Response> {
  return fetchSelf(authRequest(user, "/api/points/shop/buy", jsonInit({ productId })))
}

/** 从某个用户的视角读商品列表里的 dailySold / dailyLimit */
async function dailySoldOf(viewer: U, pid: string) {
  const res = await fetchSelf(authRequest(viewer, "/api/points"))
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    products: { id: string; dailyLimit: number | null; dailySold: number; stock: number | null }[]
  }
  const p = body.products.find((x) => x.id === pid)
  expect(p).toBeTruthy()
  return p!
}

describe("每日限量（总量不限时也能限额 + 展示剩余）", () => {
  it("总量不限 + 每日 2 件：第三单被拒，且失败不虚增计数", async () => {
    const admin = await makeUser({ role: "admin" })
    const a = await makeUser()
    const b = await makeUser()
    const c = await makeUser()
    for (const u of [a, b, c]) await givePoints(u, 100)
    const pid = await dailyProduct(admin, 2)

    // 前两单成功
    expect((await buy(a, pid)).status).toBe(200)
    expect((await buy(b, pid)).status).toBe(200)

    // 列表反映已售 2（前端显示「今日已抢完」的依据）
    const view = await dailySoldOf(a, pid)
    expect(view.dailyLimit).toBe(2)
    expect(view.dailySold).toBe(2)
    expect(view.stock).toBeNull() // 总量不限

    // 第三单被拒
    const r3 = await buy(c, pid)
    expect(r3.status).toBe(400)
    expect(((await r3.json()) as { code?: string }).code).toBe("OUT_OF_STOCK")

    // 失败路径要回退计数：每日已售仍是 2，不是 3
    const view2 = await dailySoldOf(a, pid)
    expect(view2.dailySold).toBe(2)

    await env.DB.prepare("DELETE FROM point_products WHERE id = ?").bind(pid).run()
  })

  it("没用每日限额的商品：dailySold 恒为 0、不为 null", async () => {
    const admin = await makeUser({ role: "admin" })
    const viewer = await makeUser()
    const res = await fetchSelf(
      authRequest(
        admin,
        "/api/admin/points/products",
        jsonInit({
          name: "无每日限额商品",
          price: 3,
          stock: null,
          delivery: "content",
          deliveryParams: { content: "内容" },
        })
      )
    )
    const pid = ((await res.json()) as { product: { id: string } }).product.id
    const view = await dailySoldOf(viewer, pid)
    expect(view.dailyLimit).toBeNull()
    expect(view.dailySold).toBe(0)

    await env.DB.prepare("DELETE FROM point_products WHERE id = ?").bind(pid).run()
  })

  it("总量有限 + 每日限额：两个额度同时生效（每日 ≤ 总量）", async () => {
    const admin = await makeUser({ role: "admin" })
    const a = await makeUser()
    await givePoints(a, 100)
    // 总量 5，每日 3：今天最多卖 3 件
    const res = await fetchSelf(
      authRequest(
        admin,
        "/api/admin/points/products",
        jsonInit({
          name: "双额度商品",
          price: 3,
          stock: 5,
          dailyLimit: 3,
          delivery: "content",
          deliveryParams: { content: "内容" },
        })
      )
    )
    const pid = ((await res.json()) as { product: { id: string } }).product.id

    expect((await buy(a, pid)).status).toBe(200)
    expect((await buy(a, pid)).status).toBe(200)
    expect((await buy(a, pid)).status).toBe(200)
    const r4 = await buy(a, pid)
    expect(r4.status).toBe(400)
    expect(((await r4.json()) as { code?: string }).code).toBe("OUT_OF_STOCK")

    await env.DB.prepare("DELETE FROM point_products WHERE id = ?").bind(pid).run()
  })
})
