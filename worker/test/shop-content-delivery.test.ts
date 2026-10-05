/**
 * 积分商城：「统一内容」自动发货（2026-10-04 新增）。
 *
 * 需求原话（站长）：
 *   「一种是那种一次性的每个买家不一样的自动发货」—— 即已有的卡密/Key（`code`，
 *   从卡密池取，一人一条）；
 *   「一种是统一的自动发货」—— 本文件测的 `content`：所有买家拿到**同一段**固定
 *   内容（网盘链接 / 说明 / 通用兑换码），下单即到账，不消耗任何库存。
 *
 * 重点验证「错了会真丢钱或真发错东西」的几处：
 *   1. 内容为空 / 只有空白 → 商品配置非法，**下单前**就拒（不能让用户白花积分）
 *   2. 内容超长 → 拒
 *   3. 正常下单 → 订单 note 是摘要、delivery_content 是**完整原文**
 *   4. 多个买家拿到的是**同一份**内容（与卡密「一人一条」区分开）
 *   5. 内容快照不随商品改动而变（商品事后被改，历史订单仍是当时那份）
 *   6. 通知里带完整正文（用户靠消息复制链接）
 */
import { describe, expect, it } from "vitest"
import { env } from "cloudflare:workers"
import { getPointsBalance } from "../src/points"
import { authRequest, fetchSelf, makeUser } from "./helpers"

type U = Awaited<ReturnType<typeof makeUser>>

function jsonInit(body: unknown, method = "POST"): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }
}

/** 管理员建一件「统一内容」官方商品，返回商品 id */
async function contentProduct(
  admin: U,
  opts: { content: string; price?: number; stock?: number | null }
): Promise<string> {
  const res = await fetchSelf(
    authRequest(
      admin,
      "/api/admin/points/products",
      jsonInit({
        name: "统一内容测试商品",
        price: opts.price ?? 10,
        stock: opts.stock ?? null,
        delivery: "content",
        deliveryParams: { content: opts.content },
      })
    )
  )
  expect(res.status).toBe(200)
  return ((await res.json()) as { product: { id: string } }).product.id
}

function buy(user: U, productId: string): Promise<Response> {
  return fetchSelf(authRequest(user, "/api/points/shop/buy", jsonInit({ productId })))
}

/**
 * 给用户充值积分。
 *
 * `makeUser` 造出来的账号余额是 0，而下单要真扣积分 —— 不先充钱会直接
 * 400「积分不足」，测试会以一个跟被测逻辑无关的原因失败。
 */
async function givePoints(user: U, balance: number): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO user_points (user_id, balance, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(user_id) DO UPDATE SET balance = excluded.balance, updated_at = excluded.updated_at"
  )
    .bind(user.id, balance, new Date().toISOString())
    .run()
}

/** 读订单的交付相关字段 */
async function deliveryOf(orderId: string) {
  return env.DB.prepare(
    "SELECT status, note, delivery_content FROM point_orders WHERE id = ?"
  )
    .bind(orderId)
    .first<{ status: string; note: string | null; delivery_content: string | null }>()
}

const SAMPLE = "链接：https://pan.example.com/s/abcd\n提取码：1234\n（请勿外传）"

describe("统一内容自动发货", () => {
  it("正常下单：note 是摘要、delivery_content 是完整原文", async () => {
    const admin = await makeUser({ role: "admin" })
    const buyer = await makeUser()
    await givePoints(buyer, 100)
    const pid = await contentProduct(admin, { content: SAMPLE })

    const res = await buy(buyer, pid)
    expect(res.status).toBe(200)
    const order = ((await res.json()) as {
      order: { id: string; status: string; deliveryContent: string | null; note: string | null }
    }).order
    expect(order.status).toBe("delivered")
    // 完整原文原样下发（接口层就要带出来，前端才能渲染）
    expect(order.deliveryContent).toBe(SAMPLE)

    const row = await deliveryOf(order.id)
    expect(row?.status).toBe("delivered")
    expect(row?.delivery_content).toBe(SAMPLE)
    // note 只放一行摘要，不带换行、不把整段糊进去
    expect(row?.note).toContain("已自动发货")
    expect(row?.note).not.toContain("\n")
    expect(row?.note?.length ?? 0).toBeLessThanOrEqual(300)
  })

  it("多个买家拿到的是同一份内容（与卡密「一人一条」区分）", async () => {
    const admin = await makeUser({ role: "admin" })
    const a = await makeUser()
    const b = await makeUser()
    await givePoints(a, 100)
    await givePoints(b, 100)
    const pid = await contentProduct(admin, { content: SAMPLE, price: 5 })

    const ra = await buy(a, pid)
    const rb = await buy(b, pid)
    expect(ra.status).toBe(200)
    expect(rb.status).toBe(200)
    const oa = ((await ra.json()) as { order: { id: string } }).order
    const ob = ((await rb.json()) as { order: { id: string } }).order
    expect(oa.id).not.toBe(ob.id)

    const ra2 = await deliveryOf(oa.id)
    const rb2 = await deliveryOf(ob.id)
    expect(ra2?.delivery_content).toBe(SAMPLE)
    expect(rb2?.delivery_content).toBe(SAMPLE)
  })

  it("内容为空 / 全空白 → 建商品时就被拒（不会留一个发不出东西的商品）", async () => {
    const admin = await makeUser({ role: "admin" })
    for (const bad of ["", "   ", "\n\n"]) {
      const res = await fetchSelf(
        authRequest(
          admin,
          "/api/admin/points/products",
          jsonInit({
            name: "坏配置",
            price: 10,
            delivery: "content",
            deliveryParams: { content: bad },
          })
        )
      )
      expect(res.status).toBe(400)
    }
  })

  it("内容超长 → 被拒", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await fetchSelf(
      authRequest(
        admin,
        "/api/admin/points/products",
        jsonInit({
          name: "超长内容",
          price: 10,
          delivery: "content",
          deliveryParams: { content: "x".repeat(2001) },
        })
      )
    )
    expect(res.status).toBe(400)
  })

  it("内容是订单快照：商品事后被改，历史订单仍是当时那份", async () => {
    const admin = await makeUser({ role: "admin" })
    const buyer = await makeUser()
    await givePoints(buyer, 100)
    const pid = await contentProduct(admin, { content: "原始内容 A" })

    const res = await buy(buyer, pid)
    const order = ((await res.json()) as { order: { id: string } }).order

    // 管理员把商品内容改成 B
    const upd = await fetchSelf(
      authRequest(
        admin,
        `/api/admin/points/products/${pid}`,
        jsonInit(
          {
            name: "统一内容测试商品",
            price: 10,
            delivery: "content",
            deliveryParams: { content: "改后的内容 B" },
          },
          "PUT"
        )
      )
    )
    expect(upd.status).toBe(200)

    // 老订单不受影响
    const row = await deliveryOf(order.id)
    expect(row?.delivery_content).toBe("原始内容 A")
  })

  it("扣积分与订单一致：成功交付后余额正确减少", async () => {
    const admin = await makeUser({ role: "admin" })
    const buyer = await makeUser()
    await givePoints(buyer, 100)
    const pid = await contentProduct(admin, { content: SAMPLE, price: 30 })

    const res = await buy(buyer, pid)
    expect(res.status).toBe(200)
    expect(await getPointsBalance(env, buyer.id)).toBe(70)
  })

  it("完整正文通过私聊发给买家（通知只留指路，不再糊正文）", async () => {
    const admin = await makeUser({ role: "admin" })
    const buyer = await makeUser()
    await givePoints(buyer, 100)
    const pid = await contentProduct(admin, { content: SAMPLE })

    const res = await buy(buyer, pid)
    expect(res.status).toBe(200)

    const note = await env.DB.prepare(
      "SELECT body FROM notifications WHERE user_id = ? AND type = 'order_delivered' " +
        "ORDER BY created_at DESC LIMIT 1"
    )
      .bind(buyer.id)
      .first<{ body: string }>()
    expect(note?.body).toContain("https://pan.example.com/s/abcd")
    expect(note?.body).toContain("提取码：1234")
  })

  it("统一内容不能设为租用（一次性发出去的文字收不回来）", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await fetchSelf(
      authRequest(
        admin,
        "/api/admin/points/products",
        jsonInit({
          name: "租用统一内容",
          price: 10,
          delivery: "content",
          billingMode: "rental",
          rentalDays: 30,
          deliveryParams: { content: SAMPLE },
        })
      )
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code?: string }
    expect(body.code).toBe("RENTAL_NOT_SUPPORTED")
  })
})

describe("用户商品的自动发货（2026-10-04 放开）", () => {
  /** 卖家上架一件「统一内容」用户商品并过审，返回商品 id */
  async function userContentProduct(seller: U, admin: U): Promise<string> {
    const up = await fetchSelf(
      authRequest(
        seller,
        "/api/points/products",
        jsonInit({
          name: "卖家网盘资源",
          price: 5,
          delivery: "content",
          deliveryParams: { content: "https://pan.example.com/s/seller" },
        })
      )
    )
    expect(up.status).toBe(200)
    const id = ((await up.json()) as { product: { id: string } }).product.id
    const rv = await fetchSelf(
      authRequest(admin, `/api/admin/points/products/${id}/review`, jsonInit({ approve: true }))
    )
    expect(rv.status).toBe(200)
    return id
  }

  it("卖家能上架「固定内容」商品并自动发货；确认收货才结算给卖家", async () => {
    const admin = await makeUser({ role: "admin" })
    const seller = await makeUser()
    const buyer = await makeUser()
    await givePoints(buyer, 100)
    const pid = await userContentProduct(seller, admin)

    const res = await buy(buyer, pid)
    expect(res.status).toBe(200)
    const order = ((await res.json()) as {
      order: { id: string; status: string; deliveryContent: string | null; sellerId: string | null }
    }).order
    // 自动交付：下单即 delivered，内容完整
    expect(order.status).toBe("delivered")
    expect(order.deliveryContent).toBe("https://pan.example.com/s/seller")
    expect(order.sellerId).toBe(seller.id)

    // 担保语义：卖家还没拿到钱（结算要等买家确认）
    const before = await getPointsBalance(env, seller.id)
    expect(before).toBe(0)

    // 买家确认收货 → 积分转给卖家
    const confirm = await fetchSelf(
      authRequest(buyer, `/api/points/orders/${order.id}/confirm`, jsonInit({}))
    )
    expect(confirm.status).toBe(200)
    expect(await getPointsBalance(env, seller.id)).toBe(5)
    expect(await getPointsBalance(env, buyer.id)).toBe(95)
  })

  it("公开商品列表不泄露固定内容正文（不买也能看 = 白送）", async () => {
    const admin = await makeUser({ role: "admin" })
    const seller = await makeUser()
    const buyer = await makeUser()
    await givePoints(buyer, 100)
    const pid = await userContentProduct(seller, admin)

    // 买家视角的商品列表：内容必须被剥掉
    const res = await fetchSelf(authRequest(buyer, "/api/points"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      userProducts: { id: string; deliveryParams: { content?: string } | null }[]
      myProducts: { id: string; deliveryParams: { content?: string } | null }[]
    }
    const listed = body.userProducts.find((p) => p.id === pid)
    expect(listed).toBeTruthy()
    expect(listed?.deliveryParams?.content).toBeUndefined()

    // 卖家自己的列表：能拿回正文（编辑要回填）
    const mine = await fetchSelf(authRequest(seller, "/api/points"))
    const mineBody = (await mine.json()) as {
      myProducts: { id: string; deliveryParams: { content?: string } | null }[]
    }
    const mineListed = mineBody.myProducts.find((p) => p.id === pid)
    expect(mineListed?.deliveryParams?.content).toBe("https://pan.example.com/s/seller")
  })

  it("用户商品仍不能选平台能力的交付方式（权限 / 订阅 / 额度）", async () => {
    const seller = await makeUser()
    for (const delivery of ["quota", "feature", "subscription", "invite_quota"]) {
      const res = await fetchSelf(
        authRequest(
          seller,
          "/api/points/products",
          jsonInit({
            name: "违规商品",
            price: 5,
            delivery,
            deliveryParams: { feature: "ai", planId: 1, count: 1 },
            quotaYuan: 1,
          })
        )
      )
      expect(res.status).toBe(400)
      const body = (await res.json()) as { code?: string }
      expect(body.code).toBe("DELIVERY_NOT_ALLOWED_FOR_USER")
    }
  })

  it("卖家能维护自己卡密商品的卡密池；别人的商品动不了", async () => {
    const admin = await makeUser({ role: "admin" })
    const seller = await makeUser()
    const other = await makeUser()

    // 卖家上架卡密商品（待审核也能先管理卡密池）
    const up = await fetchSelf(
      authRequest(
        seller,
        "/api/points/products",
        jsonInit({ name: "卖家卡密", price: 5, delivery: "code" })
      )
    )
    expect(up.status).toBe(200)
    const pid = ((await up.json()) as { product: { id: string } }).product.id

    // 导入卡密
    const add = await fetchSelf(
      authRequest(seller, `/api/points/products/${pid}/codes`, jsonInit({ codes: ["AAA", "BBB"] }))
    )
    expect(add.status).toBe(200)
    expect(((await add.json()) as { available: number }).available).toBe(2)

    // 别人动不了
    const foreign = await fetchSelf(
      authRequest(other, `/api/points/products/${pid}/codes`, jsonInit({ codes: ["CCC"] }))
    )
    expect(foreign.status).toBe(403)

    // 非卡密商品没有卡密池
    const up2 = await fetchSelf(
      authRequest(
        seller,
        "/api/points/products",
        jsonInit({ name: "普通商品", price: 5, delivery: "manual" })
      )
    )
    const pid2 = ((await up2.json()) as { product: { id: string } }).product.id
    const wrong = await fetchSelf(
      authRequest(seller, `/api/points/products/${pid2}/codes`, jsonInit({ codes: ["X"] }))
    )
    expect(wrong.status).toBe(400)
    expect(((await wrong.json()) as { code?: string }).code).toBe("NOT_CODE_PRODUCT")

    await env.DB.prepare("DELETE FROM point_products WHERE id IN (?, ?)").bind(pid, pid2).run()
  })

  it("卡密池空的用户商品：下单在扣分前就被拒（不白扣积分）", async () => {
    const admin = await makeUser({ role: "admin" })
    const seller = await makeUser()
    const buyer = await makeUser()
    await givePoints(buyer, 100)

    const up = await fetchSelf(
      authRequest(
        seller,
        "/api/points/products",
        jsonInit({ name: "空池卡密", price: 5, delivery: "code" })
      )
    )
    const pid = ((await up.json()) as { product: { id: string } }).product.id
    await fetchSelf(
      authRequest(admin, `/api/admin/points/products/${pid}/review`, jsonInit({ approve: true }))
    )

    const res = await buy(buyer, pid)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code?: string }).code).toBe("OUT_OF_STOCK")
    // 积分没动
    expect(await getPointsBalance(env, buyer.id)).toBe(100)

    await env.DB.prepare("DELETE FROM point_products WHERE id = ?").bind(pid).run()
  })
})
