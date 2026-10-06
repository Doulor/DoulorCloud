// 聊天室与私信的三项互动升级（2026-10-05，迁移 0121）：
//   1. 表情回应 —— toggle 幂等、聚合下发（mine/count/names）、撤回消息拒绝回应；
//   2. 编辑消息 —— 作者 10 分钟内可改、他人 403、撤回后 400、超时 EDIT_EXPIRED、editedAt 下发；
//   3. 消息转发 —— "<kind>:<id>" 跨场景转发、正文取来源防篡改、
//      私信来源必须是我参与的会话（否则降级普通消息）、来源撤回则降级。
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, setSetting, type TestUser } from "./helpers"

interface ChatMsg {
  id: string
  body: string
  editedAt: string | null
  forwardFrom: { userId: string; username: string } | null
  reactions: { emoji: string; count: number; mine: boolean; names: string[] }[]
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM chat_messages").run()
  await env.DB.prepare("DELETE FROM direct_messages").run()
  await env.DB.prepare("DELETE FROM dm_contacts").run()
  await env.DB.prepare("DELETE FROM dm_typing").run()
  await env.DB.prepare("DELETE FROM message_reactions").run()
  await setSetting("chat_enabled", "1")
})

async function sendChat(user: TestUser, body: string, extra: Record<string, unknown> = {}) {
  const res = await fetchSelf(
    authRequest(user, "/api/chat/messages", {
      method: "POST",
      body: JSON.stringify({ body, ...extra }),
    })
  )
  return { status: res.status, payload: await res.json<{ message: ChatMsg }>() }
}

async function listChat(user: TestUser): Promise<{ messages: ChatMsg[] }> {
  const res = await fetchSelf(authRequest(user, "/api/chat/messages?limit=50"))
  expect(res.status).toBe(200)
  return await res.json()
}

async function react(user: TestUser, msgId: string, emoji: string) {
  const res = await fetchSelf(
    authRequest(user, `/api/chat/messages/${msgId}/reactions`, {
      method: "POST",
      body: JSON.stringify({ emoji }),
    })
  )
  return { status: res.status, payload: await res.json<{ emoji: string; active: boolean }>() }
}

async function edit(user: TestUser, msgId: string, body: string) {
  const res = await fetchSelf(
    authRequest(user, `/api/chat/messages/${msgId}/edit`, {
      method: "POST",
      body: JSON.stringify({ body }),
    })
  )
  return { status: res.status, payload: await res.json<{ message?: ChatMsg; code?: string }>() }
}

describe("表情回应（聊天室）", () => {
  it("toggle：点一下加上、再点取消；聚合里 mine/count 正确", async () => {
    const u = await makeUser()
    const { payload } = await sendChat(u, "被回应的消息")
    const id = payload.message.id

    const on = await react(u, id, "👍")
    expect(on.status).toBe(200)
    expect(on.payload).toEqual({ emoji: "👍", active: true })

    const list1 = await listChat(u)
    expect(list1.messages[0].reactions).toEqual([
      { emoji: "👍", count: 1, mine: true, names: [u.username] },
    ])

    const off = await react(u, id, "👍")
    expect(off.payload.active).toBe(false)
    const list2 = await listChat(u)
    expect(list2.messages[0].reactions).toEqual([])
  })

  it("两人点同一表情：count=2、各自 mine 独立", async () => {
    const a = await makeUser()
    const b = await makeUser()
    const { payload } = await sendChat(a, "都来点")
    await react(a, payload.message.id, "❤️")
    await react(b, payload.message.id, "❤️")

    const forA = await listChat(a)
    expect(forA.messages[0].reactions[0].count).toBe(2)
    expect(forA.messages[0].reactions[0].mine).toBe(true)
    expect(forA.messages[0].reactions[0].names.sort()).toEqual([a.username, b.username].sort())

    const forB = await listChat(b)
    expect(forB.messages[0].reactions[0].mine).toBe(true)
  })

  it("撤回的消息拒绝回应：400", async () => {
    const u = await makeUser()
    const { payload } = await sendChat(u, "要撤回的")
    await fetchSelf(
      authRequest(u, `/api/chat/messages/${payload.message.id}/recall`, { method: "POST" })
    )
    const r = await react(u, payload.message.id, "👍")
    expect(r.status).toBe(400)
  })

  it("非法表情（超长文本 / 空白）：400", async () => {
    const u = await makeUser()
    const { payload } = await sendChat(u, "校验用")
    expect((await react(u, payload.message.id, "")).status).toBe(400)
    expect((await react(u, payload.message.id, "这不是表情是整段话")).status).toBe(400)
    // 8 个码点以内允许（能放下 👨‍👩‍👧‍👦 这类 ZWJ 序列）
    expect((await react(u, payload.message.id, "👍")).status).toBe(200)
  })
})

describe("编辑消息（聊天室）", () => {
  it("作者 10 分钟内编辑：正文替换、editedAt 下发", async () => {
    const u = await makeUser()
    const { payload } = await sendChat(u, "第一版")
    const r = await edit(u, payload.message.id, "第二版")
    expect(r.status).toBe(200)
    expect(r.payload.message!.body).toBe("第二版")
    expect(r.payload.message!.editedAt).toBeTruthy()

    const list = await listChat(u)
    expect(list.messages[0].body).toBe("第二版")
    expect(list.messages[0].editedAt).toBeTruthy()
  })

  it("别人不能编辑：403", async () => {
    const a = await makeUser()
    const b = await makeUser()
    const { payload } = await sendChat(a, "我的话")
    const r = await edit(b, payload.message.id, "篡改")
    expect(r.status).toBe(403)
  })

  it("撤回后不能编辑：400", async () => {
    const u = await makeUser()
    const { payload } = await sendChat(u, "先撤")
    await fetchSelf(
      authRequest(u, `/api/chat/messages/${payload.message.id}/recall`, { method: "POST" })
    )
    const r = await edit(u, payload.message.id, "还能改吗")
    expect(r.status).toBe(400)
  })

  it("超过 10 分钟：400 EDIT_EXPIRED", async () => {
    const u = await makeUser()
    const { payload } = await sendChat(u, "很老的消息")
    const old = new Date(Date.now() - 11 * 60 * 1000).toISOString()
    await env.DB.prepare("UPDATE chat_messages SET created_at = ? WHERE id = ?")
      .bind(old, payload.message.id)
      .run()
    const r = await edit(u, payload.message.id, "改不动")
    expect(r.status).toBe(400)
    expect(r.payload.code).toBe("EDIT_EXPIRED")
  })
})

describe("消息转发", () => {
  it("聊天室 → 聊天室：正文取来源、forwardFrom 带作者名", async () => {
    const u = await makeUser()
    const { payload } = await sendChat(u, "原汁原味的内容")
    const r = await sendChat(u, "被忽略的客户端正文", {
      forwardFrom: `chat:${payload.message.id}`,
    })
    expect(r.status).toBe(201)
    expect(r.payload.message.body).toBe("原汁原味的内容")
    expect(r.payload.message.forwardFrom).toMatchObject({ username: u.username })
  })

  it("来源已撤回：降级普通消息（forwardFrom 为空、正文用客户端的）", async () => {
    const u = await makeUser()
    const { payload } = await sendChat(u, "会被撤回")
    await fetchSelf(
      authRequest(u, `/api/chat/messages/${payload.message.id}/recall`, { method: "POST" })
    )
    const r = await sendChat(u, "普通消息正文", {
      forwardFrom: `chat:${payload.message.id}`,
    })
    expect(r.status).toBe(201)
    expect(r.payload.message.forwardFrom).toBeNull()
    expect(r.payload.message.body).toBe("普通消息正文")
  })

  it("私信 → 聊天室：我参与的私信可以转发出去", async () => {
    const a = await makeUser()
    const b = await makeUser()
    // 建立会话：a 发申请、b 回复
    const r1 = await fetchSelf(
      authRequest(a, "/api/dm", {
        method: "POST",
        body: JSON.stringify({ to: b.username, body: "私聊内容" }),
      })
    )
    expect(r1.status).toBe(201)
    const dmId = (await r1.json<{ message: { id: string } }>().valueOf() as { message: { id: string } }).message.id

    const fwd = await sendChat(a, "会被覆盖", { forwardFrom: `dm:${dmId}` })
    expect(fwd.status).toBe(201)
    expect(fwd.payload.message.body).toBe("私聊内容")
    expect(fwd.payload.message.forwardFrom).toMatchObject({ username: a.username })
  })

  it("别人的私信：拿 id 也转发不出去（降级普通消息）", async () => {
    const a = await makeUser()
    const b = await makeUser()
    const c = await makeUser()
    const r1 = await fetchSelf(
      authRequest(a, "/api/dm", {
        method: "POST",
        body: JSON.stringify({ to: b.username, body: "他们的私聊" }),
      })
    )
    const dmId = (await r1.json<{ message: { id: string } }>().valueOf() as { message: { id: string } }).message.id

    // c 不是会话参与方：查不到来源 → 降级
    const fwd = await sendChat(c, "我自己的正文", { forwardFrom: `dm:${dmId}` })
    expect(fwd.status).toBe(201)
    expect(fwd.payload.message.forwardFrom).toBeNull()
    expect(fwd.payload.message.body).toBe("我自己的正文")
  })
})

describe("sinceEdit 增量回传（编辑/回应越过游标后能被轮询拉回）", () => {
  it("编辑与回应过的旧消息随 after+sinceEdit 回传；不带 sinceEdit 则拉不回", async () => {
    const u = await makeUser()
    const { payload } = await sendChat(u, "会被编辑的旧消息")

    // 先把游标推进到这条消息之后（此后 created_at > cursor 恒为假）
    const first = await fetchSelf(authRequest(u, "/api/chat/messages"))
    const { nextCursor } = await first.json<{ nextCursor: string }>()
    expect(nextCursor).toBeTruthy()

    // 不带 sinceEdit：增量拉不到这条（已过游标）
    const noSince = await fetchSelf(
      authRequest(u, `/api/chat/messages?after=${encodeURIComponent(nextCursor!)}`)
    )
    expect(((await noSince.json()) as { messages: ChatMsg[] }).messages).toEqual([])

    // 编辑 + 回应后，带 sinceEdit 能把这条消息拉回来
    await edit(u, payload.message.id, "编辑后的内容")
    await react(u, payload.message.id, "👍")
    const since = new Date(Date.now() - 60_000).toISOString()
    const withSince = await fetchSelf(
      authRequest(
        u,
        `/api/chat/messages?after=${encodeURIComponent(nextCursor!)}&sinceEdit=${encodeURIComponent(since)}`
      )
    )
    const { messages } = (await withSince.json()) as { messages: ChatMsg[] }
    const back = messages.find((m) => m.id === payload.message.id)
    expect(back).toBeTruthy()
    expect(back!.body).toBe("编辑后的内容")
    expect(back!.editedAt).toBeTruthy()
    expect(back!.reactions.some((r) => r.emoji === "👍" && r.mine)).toBe(true)
  })
})

describe("私信侧的回应与编辑", () => {
  /** 建一个 a↔b 的既有会话，返回 a 的一条消息 id */
  async function establish() {
    const a = await makeUser()
    const b = await makeUser()
    const r1 = await fetchSelf(
      authRequest(a, "/api/dm", {
        method: "POST",
        body: JSON.stringify({ to: b.username, body: "第一条" }),
      })
    )
    expect(r1.status).toBe(201)
    const id = ((await r1.json()) as { message: { id: string } }).message.id
    await fetchSelf(
      authRequest(b, "/api/dm", {
        method: "POST",
        body: JSON.stringify({ to: a.username, body: "第二条" }),
      })
    )
    return { a, b, firstId: id }
  }

  async function dmReact(user: TestUser, msgId: string, emoji: string) {
    const res = await fetchSelf(
      authRequest(user, `/api/dm/messages/${msgId}/reactions`, {
        method: "POST",
        body: JSON.stringify({ emoji }),
      })
    )
    return { status: res.status, payload: await res.json<{ active?: boolean }>() }
  }

  async function dmList(user: TestUser, peer: string) {
    const res = await fetchSelf(authRequest(user, `/api/dm?peer=${peer}&limit=50`))
    return (await res.json()) as {
      messages: { id: string; body: string; editedAt: string | null; reactions: unknown[] }[]
    }
  }

  it("回应：参与双方都能点，聚合在 list 里可见", async () => {
    const { a, b, firstId } = await establish()
    const r = await dmReact(b, firstId, "🎉")
    expect(r.status).toBe(200)
    expect(r.payload.active).toBe(true)

    const list = await dmList(a, b.username)
    const msg = list.messages.find((m) => m.id === firstId)!
    expect(msg.reactions).toEqual([
      { emoji: "🎉", count: 1, mine: false, names: [b.username] },
    ])
  })

  it("非参与方回应：404（拿到 id 也碰不到别人的会话）", async () => {
    const { a, b, firstId } = await establish()
    const c = await makeUser()
    const r = await dmReact(c, firstId, "👍")
    expect(r.status).toBe(404)
  })

  it("编辑：作者改成功、对方改 403", async () => {
    const { a, b, firstId } = await establish()
    const ok = await fetchSelf(
      authRequest(a, `/api/dm/messages/${firstId}/edit`, {
        method: "POST",
        body: JSON.stringify({ body: "改过的第一条" }),
      })
    )
    expect(ok.status).toBe(200)
    const after = (await ok.json()) as { message: { body: string; editedAt: string | null } }
    expect(after.message.body).toBe("改过的第一条")
    expect(after.message.editedAt).toBeTruthy()

    const no = await fetchSelf(
      authRequest(b, `/api/dm/messages/${firstId}/edit`, {
        method: "POST",
        body: JSON.stringify({ body: "篡改" }),
      })
    )
    expect(no.status).toBe(403)
  })
})
