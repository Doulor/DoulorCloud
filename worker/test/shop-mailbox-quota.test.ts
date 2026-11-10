// 积分商城：邮箱数量扩容商品（2026-11-04 站长要求）
//
// 需求：「在商城购买邮箱的数量」—— 普通用户的邮箱上限一直是硬编码的 3 个，
// 现在改成「基础 3 + 商城买到的扩容（users.mailbox_quota_bonus）」。
//
// 本文件钉住四件事：
//   1. 没买过的人仍然是 3 个（老行为不许回归）；
//   2. 买 N 个 → 上限变成 3+N，并且**真的能建出来**（不是只改了个数字）；
//   3. 重复购买是**叠加**（+N 再加 N），不是覆盖；
//   4. 商品配置的合法性：数量缺失 / 越界要在保存时就拒掉，不能等用户花积分才发现。
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser } from "./helpers"
import { applyPoints } from "../src/points"
import { buyProduct, createProduct } from "../src/points-shop"
import { resetRootDomainCache } from "../src/root-domains"

type U = Awaited<ReturnType<typeof makeUser>>

/** 测试用的免权限根域（与邮箱/子域名测试同用 tyu.me） */
async function ensureRootDomain(name = "tyu.me"): Promise<void> {
  const exists = await env.DB.prepare("SELECT name FROM root_domains WHERE name = ?")
    .bind(name)
    .first()
  if (!exists) {
    await env.DB.prepare(
      `INSERT INTO root_domains (name, zone_id, label, requires_feature, is_default, enabled, created_at)
       VALUES (?, NULL, NULL, NULL, 1, 1, ?)`
    )
      .bind(name, new Date().toISOString())
      .run()
    resetRootDomainCache()
  }
}

let seq = 0
function localPart(prefix: string): string {
  seq += 1
  return `${prefix}${seq}${Math.random().toString(36).slice(2, 7)}`
}

function createMailbox(user: U, local: string): Promise<Response> {
  return fetchSelf(
    authRequest(user, "/api/mailbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localPart: local }),
    })
  )
}

async function mailboxLimit(user: U): Promise<number> {
  const res = await fetchSelf(authRequest(user, "/api/mailbox"))
  expect(res.status).toBe(200)
  const body = (await res.json()) as { limit: number }
  return body.limit
}

async function bonusOf(userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT mailbox_quota_bonus AS b FROM users WHERE id = ?")
    .bind(userId)
    .first<{ b: number }>()
  return Number(row?.b ?? 0)
}

/** 造一个「邮箱数量 +count」的官方商品，并给买家充够积分 */
async function buyMailboxQuota(buyer: U, count: number, price = 50) {
  const product = await createProduct(env, {
    name: `邮箱数量 +${count}`,
    price,
    delivery: "mailbox_quota",
    deliveryParams: { count },
    stock: null,
  })
  await applyPoints(env, { userId: buyer.id, delta: 1000, reason: "admin", detail: "测试充值" })
  const order = await buyProduct(env, buyer, product.id)
  return { product, order }
}

describe("积分商城：邮箱数量扩容", () => {
  it("没买过的普通用户上限仍是 3 个（老行为不回归）", async () => {
    await ensureRootDomain()
    const u = await makeUser()
    expect(await mailboxLimit(u)).toBe(3)
    for (let i = 0; i < 3; i++) {
      expect((await createMailbox(u, localPart("base"))).status).toBe(201)
    }
    const overflow = await createMailbox(u, localPart("base"))
    expect(overflow.status).toBe(400)
    expect(((await overflow.json()) as { code: string }).code).toBe("LIMIT_REACHED")
  })

  it("买 2 个 → 上限变 5，且真的能建到 5 个", async () => {
    await ensureRootDomain()
    const buyer = await makeUser()
    const { order } = await buyMailboxQuota(buyer, 2)

    // 自动发货，不需要人工
    expect(order.status).toBe("delivered")
    expect(await bonusOf(buyer.id)).toBe(2)
    expect(await mailboxLimit(buyer)).toBe(5)

    for (let i = 0; i < 5; i++) {
      expect((await createMailbox(buyer, localPart("plus"))).status).toBe(201)
    }
    const overflow = await createMailbox(buyer, localPart("plus"))
    expect(overflow.status).toBe(400)
    expect(((await overflow.json()) as { code: string }).code).toBe("LIMIT_REACHED")
  })

  it("重复购买是叠加：+2 再 +3 → 上限 8", async () => {
    await ensureRootDomain()
    const buyer = await makeUser()
    await buyMailboxQuota(buyer, 2)
    await buyMailboxQuota(buyer, 3)

    expect(await bonusOf(buyer.id)).toBe(5)
    expect(await mailboxLimit(buyer)).toBe(8)
  })

  it("商品配置非法时保存就拒：数量缺失 / 越界", async () => {
    await expect(
      createProduct(env, {
        name: "坏商品",
        price: 10,
        delivery: "mailbox_quota",
        deliveryParams: {},
        stock: null,
      })
    ).rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" })

    await expect(
      createProduct(env, {
        name: "坏商品",
        price: 10,
        delivery: "mailbox_quota",
        deliveryParams: { count: 101 },
        stock: null,
      })
    ).rejects.toMatchObject({ status: 400, code: "INVALID_INPUT" })

    const ok = await createProduct(env, {
      name: "好商品",
      price: 10,
      delivery: "mailbox_quota",
      deliveryParams: { count: 5 },
      stock: null,
    })
    expect(ok.deliveryParams?.count).toBe(5)
  })
})
