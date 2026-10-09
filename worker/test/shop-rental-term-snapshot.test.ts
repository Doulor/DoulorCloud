// 积分商城：租期写入必须取**订单快照**，不能取商品现值
//
// 事故模型：`deliverOrder` / `settleEscrow` 调 `applyRentalExpiry` 时传的是
// `product?.billingMode === "rental" ? product.rentalDays : null` —— 即**商品当前值**。
// 但 `point_orders` 从 0079 起就存了下单时的快照（`billing_mode` / `rental_days`），
// 0079 的迁移头明确写着「订单是**快照**，商品事后被改成买断 / 被删掉都不该影响历史订单」。
// 前端也是按快照展示的（`src/pages/admin-points.tsx:1663` 交付弹窗、`src/pages/points.tsx:319`
// 买家侧文案），所以现状是**同一单上 UI 承诺与落库结果可以不一致**。
//
// 触发不需要「改计费方式」这种低频动作，日常的改租期天数 / 删商品就够：
//   · D1 租用 30 天单 → 商品租期改成 90 天 → 交付 ⇒ 实得 90 天（白送 60 天）
//   · D2 租用 90 天单 → 商品租期改成 30 天 → 交付 ⇒ 实得 30 天（买家付 90 只拿 30）
//   · E  租用 30 天单 → 商品被删除       → 交付 ⇒ expires_at 为 NULL（永久有效）
//   · A  买断单       → 商品改成租用     → 交付 ⇒ 被写上 expires_at，进到期 cron 扫描面
//   · B  租用单       → 商品改成买断     → 交付 ⇒ expires_at 为 NULL（租期丢失）
//   · C  用户商品：买断方向同形（卖家标记交付 → 买家确认收货 → settleEscrow）
//   · D3 用户商品：租用单的天数也取快照（C 的对偶，补 settleEscrow 的天数方向）
//
// 修复：两处调用点改传 `order.rentalDays`（`applyRentalExpiry` 自身已有 `!rentalDays`
// 早退，买断单传 null 天然跳过），并删掉那次只为取现值而做的 `getProduct`。
// **无需迁移**（快照列已存在）。
//
// 被测的业务动作全部走真实 HTTP 路由（建商品 → 下单 → 改/删商品 → 交付/结算），
// 不直接调内部函数 —— 主张的是「管理员与卖家在正常操作顺序下就能触发」，只测内部
// 函数证明不了这一点。（充值 `applyPoints` 与断言直查 D1 属 setup / 观测手段。）

import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, type TestUser } from "./helpers"
import { applyPoints } from "../src/points"

interface ProductBody {
  name: string
  price: number
  delivery: string
  stock: number
  billingMode: "one_time" | "rental"
  rentalDays?: number
}

function jsonReq(
  user: TestUser,
  path: string,
  method: string,
  body?: unknown
): Request {
  return authRequest(user, path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function orderRow(id: string): Promise<Record<string, unknown> | null> {
  return env.DB.prepare("SELECT * FROM point_orders WHERE id = ?").bind(id).first()
}

async function productStock(productId: string): Promise<unknown> {
  const row = await env.DB.prepare("SELECT stock FROM point_products WHERE id = ?")
    .bind(productId)
    .first<{ stock: number | null }>()
  return row?.stock
}

/** 整数天差（expires_at 是「交付时刻 + N 天」，用交付时间做基准比用 now 精确） */
function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000)
}

/** 建一个官方商品（管理员），返回商品 id */
async function createOfficialProduct(admin: TestUser, body: ProductBody): Promise<string> {
  const res = await fetchSelf(jsonReq(admin, "/api/admin/points/products", "POST", body))
  expect(res.status).toBe(200)
  const data = (await res.json()) as { product: { id: string } }
  return data.product.id
}

/**
 * 改商品。⚠️ `updateProduct` 是**全量覆盖**（`SET name=?, price=?, stock=?, ...`），
 * 所以 stock 必须回填**当前真实值** —— 传建商品时的原值会把下单已扣掉的库存重置回去，
 * 从而掩盖其它现象（2026-10-08 踩过）。
 */
async function putProduct(
  admin: TestUser,
  productId: string,
  base: { name: string; price: number; delivery: string },
  overrides: Partial<ProductBody>
): Promise<number> {
  const stock = Number((await productStock(productId)) ?? 0)
  const res = await fetchSelf(
    jsonReq(admin, `/api/admin/points/products/${productId}`, "PUT", {
      ...base,
      stock,
      ...overrides,
    })
  )
  return res.status
}

/** 买家下单，返回订单 id（订单快照 = 下单那一刻的商品值） */
async function buy(buyer: TestUser, productId: string): Promise<string> {
  const res = await fetchSelf(
    jsonReq(buyer, "/api/points/shop/buy", "POST", { productId })
  )
  expect(res.status).toBe(200)
  const data = (await res.json()) as { order: { id: string } }
  return data.order.id
}

async function recharge(user: TestUser, delta = 500): Promise<void> {
  await applyPoints(env, { userId: user.id, delta, reason: "admin", detail: "测试充值" })
}

describe("商城租期写入取订单快照", () => {
  it("D1) 租用 30 天单，交付前商品租期改成 90 天 —— 仍按快照写 30 天", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const buyer = await makeUser()
    await recharge(buyer)

    const base = { name: "租期探针 D1", price: 30, delivery: "manual" }
    const productId = await createOfficialProduct(admin, {
      ...base,
      stock: 5,
      billingMode: "rental",
      rentalDays: 30,
    })
    const orderId = await buy(buyer, productId)

    const snap = await orderRow(orderId)
    expect(snap?.billing_mode).toBe("rental")
    expect(snap?.rental_days).toBe(30)

    // 交付前把商品租期改成 90 天
    expect(await putProduct(admin, productId, base, { billingMode: "rental", rentalDays: 90 })).toBe(200)

    const delivered = await fetchSelf(
      jsonReq(admin, `/api/admin/points/orders/${orderId}/deliver`, "POST", {})
    )
    expect(delivered.status).toBe(200)

    const after = await orderRow(orderId)
    expect(after?.expires_at).not.toBeNull()
    const actualDays = daysBetween(String(after?.delivered_at), String(after?.expires_at))
    // 订单快照 30 天 ⇒ 必须按 30 天写，而不是商品的现值 90 天
    expect(actualDays).toBe(30)
  })

  it("D2) 租用 90 天单，交付前商品租期改成 30 天 —— 仍按快照写 90 天", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const buyer = await makeUser()
    await recharge(buyer)

    const base = { name: "租期探针 D2", price: 30, delivery: "manual" }
    const productId = await createOfficialProduct(admin, {
      ...base,
      stock: 5,
      billingMode: "rental",
      rentalDays: 90,
    })
    const orderId = await buy(buyer, productId)

    const snap = await orderRow(orderId)
    expect(snap?.rental_days).toBe(90)

    expect(await putProduct(admin, productId, base, { billingMode: "rental", rentalDays: 30 })).toBe(200)

    const delivered = await fetchSelf(
      jsonReq(admin, `/api/admin/points/orders/${orderId}/deliver`, "POST", {})
    )
    expect(delivered.status).toBe(200)

    const after = await orderRow(orderId)
    expect(after?.expires_at).not.toBeNull()
    const actualDays = daysBetween(String(after?.delivered_at), String(after?.expires_at))
    // 买家按 90 天付的钱 ⇒ 少给 60 天是直接的用户侧损失
    expect(actualDays).toBe(90)
  })

  it("E) 租用 30 天单，交付前商品被删除 —— 租期仍按快照写入（不丢成永久有效）", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const buyer = await makeUser()
    await recharge(buyer)

    const base = { name: "租期探针 E", price: 30, delivery: "manual" }
    const productId = await createOfficialProduct(admin, {
      ...base,
      stock: 5,
      billingMode: "rental",
      rentalDays: 30,
    })
    const orderId = await buy(buyer, productId)

    // 商品下架/删除（管理员清理过期商品是日常操作）
    const deleted = await fetchSelf(
      jsonReq(admin, `/api/admin/points/products/${productId}`, "DELETE")
    )
    expect(deleted.status).toBe(200)

    const delivered = await fetchSelf(
      jsonReq(admin, `/api/admin/points/orders/${orderId}/deliver`, "POST", {})
    )
    expect(delivered.status).toBe(200)

    const after = await orderRow(orderId)
    // expires_at 为 NULL = 永久有效，且到期 cron 只扫 expires_at 非空的行 ⇒ 永远扫不到
    expect(after?.expires_at).not.toBeNull()
    const actualDays = daysBetween(String(after?.delivered_at), String(after?.expires_at))
    expect(actualDays).toBe(30)
  })

  it("A) 买断单，交付前商品改成租用 —— 不得被写上 expires_at（否则进 cron 扫描面）", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const buyer = await makeUser()
    await recharge(buyer)

    const base = { name: "租期探针 A", price: 30, delivery: "manual" }
    const productId = await createOfficialProduct(admin, {
      ...base,
      stock: 1,
      billingMode: "one_time",
    })
    const orderId = await buy(buyer, productId)

    const snap = await orderRow(orderId)
    expect(snap?.billing_mode).toBe("one_time")
    expect(snap?.rental_days).toBeNull()

    expect(await putProduct(admin, productId, base, { billingMode: "rental", rentalDays: 7 })).toBe(200)

    const delivered = await fetchSelf(
      jsonReq(admin, `/api/admin/points/orders/${orderId}/deliver`, "POST", {})
    )
    expect(delivered.status).toBe(200)

    const after = await orderRow(orderId)
    // 写上了 expires_at 就会被 expireRentalOrders 扫到 ⇒ 到期「收回权限 + 还库存」，
    // 而这是买断单（多还库存 = 可超卖），并打一条误导性的「租用到期」审计。
    expect(after?.expires_at).toBeNull()
  })

  it("B) 租用 30 天单，交付前商品改成买断 —— 租期不得丢失", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const buyer = await makeUser()
    await recharge(buyer)

    const base = { name: "租期探针 B", price: 30, delivery: "manual" }
    const productId = await createOfficialProduct(admin, {
      ...base,
      stock: 5,
      billingMode: "rental",
      rentalDays: 30,
    })
    const orderId = await buy(buyer, productId)

    expect(await putProduct(admin, productId, base, { billingMode: "one_time" })).toBe(200)

    const delivered = await fetchSelf(
      jsonReq(admin, `/api/admin/points/orders/${orderId}/deliver`, "POST", {})
    )
    expect(delivered.status).toBe(200)

    const after = await orderRow(orderId)
    expect(after?.expires_at).not.toBeNull()
    const actualDays = daysBetween(String(after?.delivered_at), String(after?.expires_at))
    expect(actualDays).toBe(30)
  })

  it("C) 用户商品：买断单结算时不得被写上 expires_at（settleEscrow 的买断方向）", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const seller = await makeUser()
    const buyer = await makeUser()
    await recharge(buyer)

    // 卖家上架一个买断商品
    const created = await fetchSelf(
      jsonReq(seller, "/api/points/products", "POST", {
        name: "租期探针 C",
        price: 30,
        delivery: "manual",
        stock: 3,
        billingMode: "one_time",
      })
    )
    expect(created.status).toBe(200)
    const product = ((await created.json()) as { product: { id: string } }).product

    const reviewed = await fetchSelf(
      jsonReq(admin, `/api/admin/points/products/${product.id}/review`, "POST", { approve: true })
    )
    expect(reviewed.status).toBe(200)

    const orderId = await buy(buyer, product.id)

    // 卖家标记交付（中间态）
    const sellerDelivered = await fetchSelf(
      jsonReq(seller, `/api/points/orders/${orderId}/deliver`, "POST", {})
    )
    expect(sellerDelivered.status).toBe(200)

    // 商品事后改成租用 —— 买家确认收货走 settleEscrow
    expect(
      await putProduct(
        admin,
        product.id,
        { name: "租期探针 C", price: 30, delivery: "manual" },
        { billingMode: "rental", rentalDays: 15 }
      )
    ).toBe(200)

    const confirmed = await fetchSelf(
      jsonReq(buyer, `/api/points/orders/${orderId}/confirm`, "POST", {})
    )
    expect(confirmed.status).toBe(200)

    const after = await orderRow(orderId)
    expect(after?.status).toBe("settled")
    expect(after?.expires_at).toBeNull()
  })

  it("D3) 用户商品租用 30 天单，卖家交付后商品租期改成 90 天 —— 结算时仍按快照写 30 天", async () => {
    // C 例只覆盖了 settleEscrow 的**买断方向**（不得写 expires_at）。这里补它的对偶：
    // 租用单的天数也必须取快照。缺了这条，「按订单 billingMode 门控、但天数仍取商品现值」
    // 的半吊子实现能蒙过全部用例（实测：变异版本下其余 8 例全绿）。
    const admin = await makeUser({ role: "superadmin" })
    const seller = await makeUser()
    const buyer = await makeUser()
    await recharge(buyer)

    const created = await fetchSelf(
      jsonReq(seller, "/api/points/products", "POST", {
        name: "租期探针 D3",
        price: 30,
        delivery: "manual",
        stock: 3,
        billingMode: "rental",
        rentalDays: 30,
      })
    )
    expect(created.status).toBe(200)
    const product = ((await created.json()) as { product: { id: string } }).product

    const reviewed = await fetchSelf(
      jsonReq(admin, `/api/admin/points/products/${product.id}/review`, "POST", { approve: true })
    )
    expect(reviewed.status).toBe(200)

    const orderId = await buy(buyer, product.id)
    const snap = await orderRow(orderId)
    expect(snap?.billing_mode).toBe("rental")
    expect(snap?.rental_days).toBe(30)

    // 卖家标记交付（中间态；租期尚未起算）
    const sellerDelivered = await fetchSelf(
      jsonReq(seller, `/api/points/orders/${orderId}/deliver`, "POST", {})
    )
    expect(sellerDelivered.status).toBe(200)

    // 卖家在买家确认收货之前把租期改成 90 天
    expect(
      await putProduct(
        admin,
        product.id,
        { name: "租期探针 D3", price: 30, delivery: "manual" },
        { billingMode: "rental", rentalDays: 90 }
      )
    ).toBe(200)

    const confirmed = await fetchSelf(
      jsonReq(buyer, `/api/points/orders/${orderId}/confirm`, "POST", {})
    )
    expect(confirmed.status).toBe(200)

    const after = await orderRow(orderId)
    expect(after?.status).toBe("settled")
    expect(after?.expires_at).not.toBeNull()
    // 基准用 delivered_at（settleEscrow 的 now 略晚于它），Math.round 吸收毫秒级差异
    const actualDays = daysBetween(String(after?.delivered_at), String(after?.expires_at))
    expect(actualDays).toBe(30)
  })

  // ── 反向守护：商品没被动过时，正常路径的行为不该被改宽或改死 ──
  // （旧代码上也应绿：只断言外部可观察量，不读本次改动涉及的内部实现）

  it("守护）正常租用单（商品未改动）交付 —— 仍按商品/快照的 30 天写入", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const buyer = await makeUser()
    await recharge(buyer)

    const productId = await createOfficialProduct(admin, {
      name: "租期守护 租用",
      price: 30,
      delivery: "manual",
      stock: 5,
      billingMode: "rental",
      rentalDays: 30,
    })
    const orderId = await buy(buyer, productId)

    const delivered = await fetchSelf(
      jsonReq(admin, `/api/admin/points/orders/${orderId}/deliver`, "POST", {})
    )
    expect(delivered.status).toBe(200)

    const after = await orderRow(orderId)
    expect(after?.expires_at).not.toBeNull()
    const actualDays = daysBetween(String(after?.delivered_at), String(after?.expires_at))
    expect(actualDays).toBe(30)
  })

  it("守护）正常买断单（商品未改动）交付 —— 仍不写 expires_at", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const buyer = await makeUser()
    await recharge(buyer)

    const productId = await createOfficialProduct(admin, {
      name: "租期守护 买断",
      price: 30,
      delivery: "manual",
      stock: 5,
      billingMode: "one_time",
    })
    const orderId = await buy(buyer, productId)

    const delivered = await fetchSelf(
      jsonReq(admin, `/api/admin/points/orders/${orderId}/deliver`, "POST", {})
    )
    expect(delivered.status).toBe(200)

    const after = await orderRow(orderId)
    expect(after?.status).toBe("delivered")
    expect(after?.expires_at).toBeNull()
  })
})
