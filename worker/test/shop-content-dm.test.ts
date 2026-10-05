/**
 * 商城「自动发货」的内容通过**私聊**发给买家（2026-10-06 站长要求）。
 *
 * 背景：完整内容此前只塞进「已发放」的站内通知正文，而通知在界面上就是右下角
 * 一闪而过的弹窗 —— 站长反馈「一瞬间就没了」，买家一眨眼就错过，只能回头去
 * 「我的交易」里翻订单。改为发私信：内容留在会话里，随时能翻、能复制。
 *
 * ⚠️ 本文件刻意用 **root** 建商品，而不是像 shop-content-delivery.test.ts 那样用
 *    `admin`：admin 目前受「权限组 admin_scope」那套改动影响，拿不到管理接口
 *    （403），那个文件整组用例都因此红着。root 不走那道白名单，能真正验证到
 *    「发货 → 私聊」这条链路本身。
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

/** 一段典型的交付正文：多行、带链接与提取码 */
const SAMPLE = "网盘链接：https://pan.example.com/s/abcd\n提取码：1234"

/** 下单要真扣积分，不先充钱会以「积分不足」这种无关原因失败 */
async function givePoints(user: U, balance: number): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO user_points (user_id, balance, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(user_id) DO UPDATE SET balance = excluded.balance, updated_at = excluded.updated_at"
  )
    .bind(user.id, balance, new Date().toISOString())
    .run()
}

/** 以 root 身份建一件「统一内容」的**官方**商品（owner_id 为 NULL） */
async function officialContentProduct(root: U, content: string): Promise<string> {
  const res = await fetchSelf(
    authRequest(
      root,
      "/api/admin/points/products",
      jsonInit({
        name: "官方统一内容",
        price: 10,
        stock: null,
        delivery: "content",
        deliveryParams: { content },
      })
    )
  )
  expect(res.status).toBe(200)
  return ((await res.json()) as { product: { id: string } }).product.id
}

function buy(user: U, productId: string): Promise<Response> {
  return fetchSelf(authRequest(user, "/api/points/shop/buy", jsonInit({ productId })))
}

describe("自动发货的内容通过私聊发给买家", () => {
  it("官方商品：完整原文私聊给买家（不被截断、不被弹窗吃掉）", async () => {
    const root = await makeUser({ role: "root" })
    const buyer = await makeUser()
    await givePoints(buyer, 100)
    const pid = await officialContentProduct(root, SAMPLE)

    const res = await buy(buyer, pid)
    expect(res.status).toBe(200)

    const dm = await env.DB.prepare(
      "SELECT from_user_id, to_user_id, body FROM direct_messages WHERE to_user_id = ? " +
        "ORDER BY created_at DESC LIMIT 1"
    )
      .bind(buyer.id)
      .first<{ from_user_id: string; to_user_id: string; body: string }>()
    expect(dm).not.toBeNull()
    expect(dm!.to_user_id).toBe(buyer.id)
    // 完整原文：多行内容一行都不能少
    expect(dm!.body).toContain("https://pan.example.com/s/abcd")
    expect(dm!.body).toContain("提取码：1234")
  })

  it("通知只留一句指路，不再把整段内容塞进弹窗", async () => {
    const root = await makeUser({ role: "root" })
    const buyer = await makeUser()
    await givePoints(buyer, 100)
    const pid = await officialContentProduct(root, SAMPLE)

    const res = await buy(buyer, pid)
    expect(res.status).toBe(200)

    const note = await env.DB.prepare(
      "SELECT body FROM notifications WHERE user_id = ? AND type = 'order_delivered' " +
        "ORDER BY created_at DESC LIMIT 1"
    )
      .bind(buyer.id)
      .first<{ body: string }>()
    expect(note?.body).toContain("私聊")
    expect(note?.body).not.toContain("提取码：1234")
  })

  it("顶到 2000 字上限时仍发得出去（宁可不要前缀，也不截内容）", async () => {
    const root = await makeUser({ role: "root" })
    const buyer = await makeUser()
    await givePoints(buyer, 100)
    // 刚好 2000 字：私信单条上限也是 2000，前缀会挤掉内容 ⇒ 应退化为只发内容
    const long = "A".repeat(2000)
    const pid = await officialContentProduct(root, long)

    const res = await buy(buyer, pid)
    expect(res.status).toBe(200)

    const dm = await env.DB.prepare(
      "SELECT body FROM direct_messages WHERE to_user_id = ? ORDER BY created_at DESC LIMIT 1"
    )
      .bind(buyer.id)
      .first<{ body: string }>()
    expect((dm?.body ?? "").length).toBe(2000)
  })
})
