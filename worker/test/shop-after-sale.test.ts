/**
 * 积分商城：售后（退款）流程（2026-10-02 新增）。
 *
 * 覆盖站长要求的两条：
 *   1. 卖家已交付、买家没收到货 → 可以申请退款（原来无路可走）；
 *   2. 确认收货之后 → 仍有 7 天可以申请（原来完全没有退款入口）。
 *
 * 以及资金口径：已结算的订单退款要**先从卖家收益扣回**，卖家不够就报错
 * （绝不把卖家余额扣成负数 —— 与管理员「取消订单」同一口径）。
 */
import { describe, expect, it } from "vitest"
import { env } from "cloudflare:workers"
import { applyPoints, getPointsBalance } from "../src/points"
import { authRequest, fetchSelf, makeUser } from "./helpers"

type U = Awaited<ReturnType<typeof makeUser>>

function jsonInit(body: unknown, method = "POST"): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }
}

/** 卖家上架一件商品并让管理员审核通过，返回商品 id */
async function listedProduct(admin: U, seller: U, price: number): Promise<string> {
  const up = await fetchSelf(
    authRequest(seller, "/api/points/products", jsonInit({ name: "售后测试商品", price }))
  )
  expect(up.status).toBe(200)
  const id = ((await up.json()) as { product: { id: string } }).product.id
  const rv = await fetchSelf(
    authRequest(admin, `/api/admin/points/products/${id}/review`, jsonInit({ approve: true }))
  )
  expect(rv.status).toBe(200)
  return id
}

function buy(user: U, productId: string): Promise<Response> {
  return fetchSelf(authRequest(user, "/api/points/shop/buy", jsonInit({ productId })))
}

/** 读订单的售后字段 */
async function afterSaleOf(orderId: string) {
  return env.DB.prepare(
    "SELECT status, after_sale_status, after_sale_reason, after_sale_note FROM point_orders WHERE id = ?"
  )
    .bind(orderId)
    .first<{
      status: string
      after_sale_status: string | null
      after_sale_reason: string | null
      after_sale_note: string | null
    }>()
}

/** 买家申请售后 */
function postAfterSale(user: U, orderId: string, reason: string): Promise<Response> {
  return fetchSelf(
    authRequest(user, `/api/points/orders/${orderId}/after-sale`, jsonInit({ reason }))
  )
}

/** 买家撤销售后 */
function withdrawAfterSale(user: U, orderId: string): Promise<Response> {
  return fetchSelf(
    authRequest(user, `/api/points/orders/${orderId}/after-sale`, { method: "DELETE" })
  )
}

function escalate(user: U, orderId: string): Promise<Response> {
  return fetchSelf(
    authRequest(user, `/api/points/orders/${orderId}/after-sale/escalate`, { method: "POST" })
  )
}

function sellerDecide(seller: U, orderId: string, approve: boolean, note?: string): Promise<Response> {
  return fetchSelf(
    authRequest(
      seller,
      `/api/points/orders/${orderId}/after-sale/decide`,
      jsonInit({ approve, note })
    )
  )
}

function adminResolve(admin: U, orderId: string, approve: boolean, note?: string): Promise<Response> {
  return fetchSelf(
    authRequest(
      admin,
      `/api/admin/points/orders/${orderId}/after-sale`,
      jsonInit({ approve, note })
    )
  )
}

/** 造一张「买家已付 30、卖家已交付、等买家确认」的担保订单 */
async function deliveredOrder(price = 30) {
  const admin = await makeUser({ role: "admin" })
  const seller = await makeUser()
  const buyer = await makeUser()
  await applyPoints(env, { userId: buyer.id, delta: 100, reason: "admin" })
  const productId = await listedProduct(admin, seller, price)
  const res = await buy(buyer, productId)
  expect(res.status).toBe(200)
  const orderId = ((await res.json()) as { order: { id: string } }).order.id
  const dv = await fetchSelf(
    authRequest(seller, `/api/points/orders/${orderId}/deliver`, { method: "POST" })
  )
  expect(dv.status).toBe(200)
  return { admin, seller, buyer, orderId, price }
}

describe("积分商城：售后（退款）", () => {
  it("卖家已交付但买家没收到货 → 可以申请，卖家同意即退款", async () => {
    const { seller, buyer, orderId, price } = await deliveredOrder()

    const req = await postAfterSale(buyer, orderId, "付款后一直没收到货")
    expect(req.status).toBe(200)
    let row = await afterSaleOf(orderId)
    expect(row?.after_sale_status).toBe("requested")
    expect(row?.after_sale_reason).toBe("付款后一直没收到货")

    const ok = await sellerDecide(seller, orderId, true, "确实没发出去，同意退款")
    expect(ok.status).toBe(200)
    row = await afterSaleOf(orderId)
    expect(row?.status).toBe("cancelled") // 积分已原路退回
    expect(row?.after_sale_status).toBe("refunded")
    expect(await getPointsBalance(env, buyer.id)).toBe(100) // 退回全额
    expect(await getPointsBalance(env, seller.id)).toBe(0) // 卖家本来就没拿到托管积分
  })

  it("确认收货之后仍可申请（7 天内）；已结算的会先从卖家收益扣回", async () => {
    const { seller, buyer, orderId, price } = await deliveredOrder()

    // 买家确认收货 → 积分结算给卖家
    const cf = await fetchSelf(
      authRequest(buyer, `/api/points/orders/${orderId}/confirm`, { method: "POST" })
    )
    expect(cf.status).toBe(200)
    expect(await getPointsBalance(env, seller.id)).toBe(price)

    const req = await postAfterSale(buyer, orderId, "收到的内容与描述不符")
    expect(req.status).toBe(200)
    expect((await sellerDecide(seller, orderId, true)).status).toBe(200)

    expect(await afterSaleOf(orderId)).toMatchObject({
      status: "cancelled",
      after_sale_status: "refunded",
    })
    expect(await getPointsBalance(env, buyer.id)).toBe(100)
    expect(await getPointsBalance(env, seller.id)).toBe(0) // 收益被扣回
  })

  it("卖家拒绝 → 买家申请平台介入 → 管理员同意退款", async () => {
    const { admin, seller, buyer, orderId } = await deliveredOrder()
    expect((await postAfterSale(buyer, orderId, "一直没收到货")).status).toBe(200)

    const no = await sellerDecide(seller, orderId, false, "已经按描述交付了")
    expect(no.status).toBe(200)
    expect((await afterSaleOf(orderId))?.after_sale_status).toBe("rejected")

    expect((await escalate(buyer, orderId)).status).toBe(200)
    expect((await afterSaleOf(orderId))?.after_sale_status).toBe("platform")

    const done = await adminResolve(admin, orderId, true, "核实后同意退款")
    expect(done.status).toBe(200)
    expect(await afterSaleOf(orderId)).toMatchObject({
      status: "cancelled",
      after_sale_status: "refunded",
    })
    expect(await getPointsBalance(env, buyer.id)).toBe(100)
  })

  it("管理员驳回 → 售后终结，积分不动", async () => {
    const { admin, buyer, orderId, price } = await deliveredOrder()
    expect((await postAfterSale(buyer, orderId, "不想要了")).status).toBe(200)

    const rej = await adminResolve(admin, orderId, false, "商品已按描述交付")
    expect(rej.status).toBe(200)
    expect(await afterSaleOf(orderId)).toMatchObject({ after_sale_status: "closed" })
    expect(await getPointsBalance(env, buyer.id)).toBe(100 - price)
    // 驳回之后允许重新申请（买家可能补充新证据）
    expect((await postAfterSale(buyer, orderId, "补充说明：确实没收到")).status).toBe(200)
  })

  it("已结算但卖家积分不够时，拒绝退款并提示先调整", async () => {
    const { admin, seller, buyer, orderId, price } = await deliveredOrder()
    await fetchSelf(authRequest(buyer, `/api/points/orders/${orderId}/confirm`, { method: "POST" }))
    expect(await getPointsBalance(env, seller.id)).toBe(price)

    // 卖家把积分花掉
    await applyPoints(env, { userId: seller.id, delta: -price, reason: "admin" })

    expect((await postAfterSale(buyer, orderId, "有质量问题")).status).toBe(200)
    const res = await adminResolve(admin, orderId, true)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe("INSUFFICIENT_POINTS")
    // 失败时不能把订单改成已退款，也不能动买家的钱
    expect(await afterSaleOf(orderId)).toMatchObject({ status: "settled" })
    expect(await getPointsBalance(env, buyer.id)).toBe(100 - price)
  })

  it("确认收货超过 7 天不能申请", async () => {
    const { buyer, orderId } = await deliveredOrder()
    await fetchSelf(authRequest(buyer, `/api/points/orders/${orderId}/confirm`, { method: "POST" }))
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    await env.DB.prepare("UPDATE point_orders SET settled_at = ? WHERE id = ?")
      .bind(old, orderId)
      .run()

    const res = await postAfterSale(buyer, orderId, "过了很久才想起来")
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe("AFTER_SALE_EXPIRED")
  })

  it("订单还没交付（pending）不能申请售后", async () => {
    const admin = await makeUser({ role: "admin" })
    const seller = await makeUser()
    const buyer = await makeUser()
    await applyPoints(env, { userId: buyer.id, delta: 100, reason: "admin" })
    const productId = await listedProduct(admin, seller, 30)
    const orderId = (
      (await (await buy(buyer, productId)).json()) as { order: { id: string } }
    ).order.id

    const res = await postAfterSale(buyer, orderId, "还没发货但我想退")
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe("NOT_DELIVERED")
  })

  it("只有买家本人能申请、只有卖家本人能处理", async () => {
    const { seller, buyer, orderId } = await deliveredOrder()
    const stranger = await makeUser()

    const notMine = await postAfterSale(stranger, orderId, "我不是买家也想退")
    expect(notMine.status).toBe(403)

    expect((await postAfterSale(buyer, orderId, "没收到货")).status).toBe(200)
    const notSeller = await sellerDecide(stranger, orderId, true)
    expect(notSeller.status).toBe(403)
  })

  it("买家可以自己撤销售后申请", async () => {
    const { buyer, orderId } = await deliveredOrder()
    expect((await postAfterSale(buyer, orderId, "先申请一下")).status).toBe(200)
    expect((await withdrawAfterSale(buyer, orderId)).status).toBe(200)
    expect((await afterSaleOf(orderId))?.after_sale_status).toBeNull()
  })

  it("理由太短会被拒（拦掉「退」「1」这种）", async () => {
    const { buyer, orderId } = await deliveredOrder()
    const res = await postAfterSale(buyer, orderId, "退")
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe("INVALID_INPUT")
  })

  it("退款是幂等的：重复处理不会退两次", async () => {
    const { seller, buyer, orderId } = await deliveredOrder()
    expect((await postAfterSale(buyer, orderId, "没收到货")).status).toBe(200)
    expect((await sellerDecide(seller, orderId, true)).status).toBe(200)
    expect(await getPointsBalance(env, buyer.id)).toBe(100)

    // 订单已 cancelled → 再走一次售后处理应当被挡在入口
    const again = await sellerDecide(seller, orderId, true)
    expect(again.status).toBe(409)
    expect(await getPointsBalance(env, buyer.id)).toBe(100)
  })

  it("管理端能列出「待平台处理」的售后（列表 SQL 与筛选）", async () => {
    const { admin, seller, buyer, orderId } = await deliveredOrder()
    expect((await postAfterSale(buyer, orderId, "一直没收到货")).status).toBe(200)
    // 卖家拒绝 → 买家申请介入 → 状态变 platform
    expect((await sellerDecide(seller, orderId, false, "已交付")).status).toBe(200)
    expect((await escalate(buyer, orderId)).status).toBe(200)

    const res = await fetchSelf(authRequest(admin, "/api/admin/points/after-sales"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      orders: { id: string; afterSaleStatus: string | null }[]
      status: string
    }
    const mine = body.orders.find((o) => o.id === orderId)
    expect(mine?.afterSaleStatus).toBe("platform")

    // all 能把已终结的也带出来
    const all = await fetchSelf(authRequest(admin, "/api/admin/points/after-sales?status=all"))
    expect(all.status).toBe(200)
    expect(
      ((await all.json()) as { orders: { id: string }[] }).orders.some((o) => o.id === orderId)
    ).toBe(true)
  })
})
