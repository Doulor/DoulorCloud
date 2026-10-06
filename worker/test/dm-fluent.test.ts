// 私信流畅性升级（2026-10-05，与聊天室一起借鉴 Telegram）：
//   1. 引用回复 —— reply_to 落库、list 批量补 quote 摘要；被引消息已撤回则降级普通消息；
//   2. 撤回 —— 本人 10 分钟内可撤、撤回后正文真的清掉、他人不能撤我的消息；
//   3. client_id 幂等发送 —— 乐观发送超时重发只落一行；
//   4. peerTyping —— 对端上报「正在输入」后随 list 轮询下发。
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, type TestUser } from "./helpers"

interface DmListPayload {
  messages: {
    id: string
    fromUserId: string
    body: string
    replyTo: string | null
    quote: { id: string; username: string; body: string; recalled: boolean } | null
    recalled: boolean
    createdAt: string
  }[]
  nextCursor: string | null
  prevCursor: string | null
  hasMore: boolean
  peerTyping: boolean
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM direct_messages").run()
  await env.DB.prepare("DELETE FROM dm_contacts").run()
  await env.DB.prepare("DELETE FROM dm_typing").run()
})

async function sendDm(
  user: TestUser,
  to: string,
  body: string,
  opts: { replyTo?: string; clientId?: string } = {}
): Promise<{ status: number; payload: { message: { id: string; replyTo: string | null } } }> {
  const res = await fetchSelf(
    authRequest(user, "/api/dm", {
      method: "POST",
      body: JSON.stringify({ to, body, ...opts }),
    })
  )
  return { status: res.status, payload: await res.json() }
}

async function listDm(user: TestUser, peer: string, qs = ""): Promise<DmListPayload> {
  const res = await fetchSelf(authRequest(user, `/api/dm?peer=${encodeURIComponent(peer)}${qs}`))
  expect(res.status).toBe(200)
  return await res.json<DmListPayload>()
}

/**
 * 建一个「已建立关系」的会话：A 发第一条（对 B 是聊天申请）、B 回一条
 * （收到申请的一方回复放行），此后双方都能自由发 —— 后续用例不用再管门槛。
 */
async function establishPair() {
  const a = await makeUser()
  const b = await makeUser()
  const first = await sendDm(a, b.username, "你好，我想问个事")
  expect(first.status).toBe(201)
  const reply = await sendDm(b, a.username, "好的，你说")
  expect(reply.status).toBe(201)
  return { a, b, firstId: first.payload.message.id, replyId: reply.payload.message.id }
}

describe("私信引用回复", () => {
  it("带 replyTo 发送：列表里回显 replyTo 并批量补全 quote 摘要", async () => {
    const { a, b, firstId } = await establishPair()

    const r = await sendDm(a, b.username, "引用你第一条", { replyTo: firstId })
    expect(r.status).toBe(201)
    expect(r.payload.message.replyTo).toBe(firstId)

    const list = await listDm(a, b.username)
    const quotedMsg = list.messages.find((m) => m.replyTo === firstId)
    expect(quotedMsg).toBeTruthy()
    expect(quotedMsg!.quote).toBeTruthy()
    expect(quotedMsg!.quote!.username).toBe(a.username) // 被引消息是 A 自己发的
    expect(quotedMsg!.quote!.body).toContain("我想问个事")
    expect(quotedMsg!.quote!.recalled).toBe(false)
  })

  it("被引消息已撤回 → 按普通消息发（replyTo 为空），不报错", async () => {
    const { a, b, firstId } = await establishPair()

    const recall = await fetchSelf(
      authRequest(a, `/api/dm/messages/${firstId}/recall`, { method: "POST" })
    )
    expect(recall.status).toBe(200)

    const r = await sendDm(a, b.username, "试着引用一条已撤回的", { replyTo: firstId })
    expect(r.status).toBe(201)
    expect(r.payload.message.replyTo).toBeNull()
  })

  it("引用不存在的消息 id：也按普通消息发", async () => {
    const { a, b } = await establishPair()
    const r = await sendDm(a, b.username, "引用一个不存在的", {
      replyTo: "00000000-0000-0000-0000-000000000000",
    })
    expect(r.status).toBe(201)
    expect(r.payload.message.replyTo).toBeNull()
  })
})

describe("私信撤回", () => {
  it("本人撤回：200，正文被真的清掉（不是盖遮罩）", async () => {
    const { a, b, firstId } = await establishPair()

    const res = await fetchSelf(
      authRequest(a, `/api/dm/messages/${firstId}/recall`, { method: "POST" })
    )
    expect(res.status).toBe(200)

    const list = await listDm(a, b.username)
    const msg = list.messages.find((m) => m.id === firstId)
    expect(msg!.recalled).toBe(true)
    expect(msg!.body).toBe("")
  })

  it("别人不能撤我的消息：403", async () => {
    const { a, b, firstId } = await establishPair()
    const res = await fetchSelf(
      authRequest(b, `/api/dm/messages/${firstId}/recall`, { method: "POST" })
    )
    expect(res.status).toBe(403)
  })

  it("重复撤回幂等：第二次仍 200", async () => {
    const { a, b, firstId } = await establishPair()
    await fetchSelf(authRequest(a, `/api/dm/messages/${firstId}/recall`, { method: "POST" }))
    const again = await fetchSelf(
      authRequest(a, `/api/dm/messages/${firstId}/recall`, { method: "POST" })
    )
    expect(again.status).toBe(200)
  })

  it("撤回不存在的消息：404", async () => {
    const { a } = await establishPair()
    const res = await fetchSelf(
      authRequest(
        a,
        "/api/dm/messages/00000000-0000-0000-0000-000000000000/recall",
        { method: "POST" }
      )
    )
    expect(res.status).toBe(404)
  })
})

describe("私信 client_id 幂等发送", () => {
  it("同 clientId 提交两次：同一条消息、库里一行", async () => {
    const { a, b } = await establishPair()
    const clientId = "dm-client-id-0001"

    const r1 = await sendDm(a, b.username, "网络可能超时重发的那条", { clientId })
    const r2 = await sendDm(a, b.username, "网络可能超时重发的那条", { clientId })
    expect(r1.status).toBe(201)
    expect(r2.status).toBe(201)
    expect(r2.payload.message.id).toBe(r1.payload.message.id)

    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM direct_messages WHERE from_user_id = ? AND body = ?"
    )
      .bind(a.id, "网络可能超时重发的那条")
      .first<{ n: number }>()
    expect(row?.n).toBe(1)
  })

  it("不带 clientId 行为不变：两次各落一条", async () => {
    const { a, b } = await establishPair()
    await sendDm(a, b.username, "普通一")
    await sendDm(a, b.username, "普通二")
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM direct_messages WHERE from_user_id = ?"
    )
      .bind(a.id)
      .first<{ n: number }>()
    expect(row?.n).toBe(3) // establishPair 里 A 还发过一条
  })
})

describe("私信对端正在输入（peerTyping）", () => {
  it("A 给 B 打字 → B 拉会话看到 peerTyping=true；A 自己拉看不到", async () => {
    const { a, b } = await establishPair()

    const res = await fetchSelf(
      authRequest(a, "/api/dm/typing", {
        method: "POST",
        body: JSON.stringify({ peer: b.username }),
      })
    )
    expect(res.status).toBe(200)

    const forB = await listDm(b, a.username)
    expect(forB.peerTyping).toBe(true)

    const forA = await listDm(a, b.username)
    expect(forA.peerTyping).toBe(false)
  })

  it("没打字时 peerTyping=false", async () => {
    const { a, b } = await establishPair()
    const forB = await listDm(b, a.username)
    expect(forB.peerTyping).toBe(false)
  })

  it("翻历史（before）不查 typing：恒为 false（省一次查询）", async () => {
    const { a, b } = await establishPair()
    await fetchSelf(
      authRequest(a, "/api/dm/typing", {
        method: "POST",
        body: JSON.stringify({ peer: b.username }),
      })
    )
    const first = await listDm(b, a.username)
    const earlier = await listDm(b, a.username, `&before=${encodeURIComponent(first.prevCursor!)}`)
    expect(earlier.peerTyping).toBe(false)
  })
})
