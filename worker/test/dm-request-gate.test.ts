// 私信「聊天申请」门槛（2026-10-01 站长要求）：陌生人只能发一条，对方同意前不能再发；
// 被拒绝后不能再发。门槛是**唯一**防线 —— 仓库里没有拉黑 / 免打扰功能。
//
// 背景（issue #44）：`checkSendGate` 里「已经互相聊过 = 事实上的同意」那条历史消息判断
// 用的是**双向**匹配，而「聊天申请」本身就是 `direct_messages` 里的一行 ⇒ 陌生人发出的
// 第一条立刻让该条件恒真，`DM_PENDING` / `DM_DECLINED` 两个分支成了死代码。
// 第二处：`declined` 判断排在历史判断**之后**，「对方先回我一句、之后才点拒绝」这条真实
// 可达路径上拒绝仍然失效。
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, type TestUser } from "./helpers"
import { sendSystemDm } from "../src/handlers/dm"

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM direct_messages").run()
  await env.DB.prepare("DELETE FROM dm_contacts").run()
})

async function send(
  user: TestUser,
  to: string,
  body: string
): Promise<{ status: number; code: string }> {
  const res = await fetchSelf(
    authRequest(user, "/api/dm", { method: "POST", body: JSON.stringify({ to, body }) })
  )
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, code: (payload.code as string) ?? "-" }
}

async function respond(
  user: TestUser,
  peer: string,
  action: "accept" | "decline"
): Promise<number> {
  const res = await fetchSelf(
    authRequest(user, "/api/dm/requests", {
      method: "POST",
      body: JSON.stringify({ peer, action }),
    })
  )
  return res.status
}

async function messageCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM direct_messages").first<{ c: number }>()
  return Number(row?.c ?? 0)
}

/** 直接造历史消息，模拟「门槛上线前就存在的会话」（无 dm_contacts 行） */
async function seedLegacyMessage(from: string, to: string, body: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO direct_messages (id, from_user_id, to_user_id, body, created_at, read_at) VALUES (?, ?, ?, ?, ?, NULL)"
  )
    .bind(crypto.randomUUID(), from, to, body, new Date().toISOString())
    .run()
}

describe("私信聊天申请门槛：陌生人只能发一条", () => {
  it("对方未处理时，第二条起被拦（DM_PENDING）且不落库", async () => {
    const a = await makeUser()
    const b = await makeUser()

    const m1 = await send(a, b.username, "第一条（这就是申请）")
    expect(m1.status).toBe(201)

    const m2 = await send(a, b.username, "第二条")
    expect(m2.status).toBe(403)
    expect(m2.code).toBe("DM_PENDING")

    const m3 = await send(a, b.username, "第三条")
    expect(m3.status).toBe(403)

    // 关键：被拦的消息不能落库（否则「拦住了」只是表象，对方仍能在列表里读到）
    expect(await messageCount()).toBe(1)
  })

  it("对方拒绝后不能再发（DM_DECLINED）", async () => {
    const a = await makeUser()
    const b = await makeUser()

    expect((await send(a, b.username, "申请")).status).toBe(201)
    expect(await respond(b, a.username, "decline")).toBe(200)

    const after = await send(a, b.username, "被拒后还想发")
    expect(after.status).toBe(403)
    expect(after.code).toBe("DM_DECLINED")
    expect(await messageCount()).toBe(1)
  })

  it("对方**回复过**再点拒绝：拒绝仍然生效（declined 必须先于历史消息判断）", async () => {
    const a = await makeUser()
    const b = await makeUser()

    expect((await send(a, b.username, "申请")).status).toBe(201)
    expect((await send(b, a.username, "收到，你说")).status).toBe(201)
    // 此刻 A 能发（B 先开过口）—— 既有语义，必须保持
    expect((await send(a, b.username, "那我继续说")).status).toBe(201)

    expect(await respond(b, a.username, "decline")).toBe(200)
    const after = await send(a, b.username, "拒绝后还想发")
    expect(after.status).toBe(403)
    expect(after.code).toBe("DM_DECLINED")
  })
})

describe("私信聊天申请门槛：不得误伤既有会话", () => {
  it("对方回复过（未点同意）→ 申请人可以继续发", async () => {
    const a = await makeUser()
    const b = await makeUser()

    expect((await send(a, b.username, "申请")).status).toBe(201)
    expect((await send(b, a.username, "收到，你说")).status).toBe(201)

    expect((await send(a, b.username, "第二条")).status).toBe(201)
    expect((await send(a, b.username, "第三条")).status).toBe(201)
  })

  it("对方点同意后双方自由发", async () => {
    const a = await makeUser()
    const b = await makeUser()

    expect((await send(a, b.username, "申请")).status).toBe(201)
    expect(await respond(b, a.username, "accept")).toBe(200)

    expect((await send(a, b.username, "第二条")).status).toBe(201)
    expect((await send(a, b.username, "第三条")).status).toBe(201)
    expect((await send(b, a.username, "回你一条")).status).toBe(201)
  })

  it("老会话（门槛上线前的历史消息、无 dm_contacts 行）不被掐断", async () => {
    const a = await makeUser()
    const b = await makeUser()
    await seedLegacyMessage(a.id, b.id, "老消息")
    await seedLegacyMessage(b.id, a.id, "老回复")

    expect((await send(a, b.username, "老会话里再说一句")).status).toBe(201)
    // 老会话不该因为这条被落成「待处理申请」
    const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM dm_contacts").first<{ c: number }>()
    expect(Number(row?.c ?? 0)).toBe(0)
  })

  it("对方是管理员 / 站长：免申请", async () => {
    for (const role of ["admin", "superadmin", "root"] as const) {
      const stranger = await makeUser()
      const admin = await makeUser({ role })
      expect((await send(stranger, admin.username, "第一条")).status).toBe(201)
      expect((await send(stranger, admin.username, "第二条")).status).toBe(201)
    }
  })

  it("双方有订单关系：免申请（买家卖家本就该能直接联系）", async () => {
    const seller = await makeUser()
    const buyer = await makeUser()
    const now = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO point_orders
         (id, user_id, username, seller_id, product_id, product_name, price, delivery, status, created_at)
       VALUES (?, ?, ?, ?, ?, '测试商品', 10, 'manual', 'pending', ?)`
    )
      .bind(
        crypto.randomUUID(),
        buyer.id,
        buyer.username,
        seller.id,
        crypto.randomUUID(),
        now
      )
      .run()

    expect((await send(buyer, seller.username, "第一条")).status).toBe(201)
    expect((await send(buyer, seller.username, "第二条")).status).toBe(201)
  })

  it("系统私信（官方商品交付）后买家能回复 —— sendSystemDm 不走闸门", async () => {
    const admin = await makeUser({ role: "admin" })
    const buyer = await makeUser()

    const id = await sendSystemDm(env, {
      fromUserId: admin.id,
      toUserId: buyer.id,
      body: "你买的卡密：XXXX-XXXX",
    })
    expect(id).toBeTruthy()

    // 方向性放行：对方先给我发过 ⇒ 我能回
    expect((await send(buyer, admin.username, "收到了，谢谢")).status).toBe(201)
  })
})
