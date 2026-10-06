// 聊天室流畅性升级（2026-10-05，借鉴 Telegram Android）：
//   1. before 向前翻页 —— 滑到顶加载更早消息的底座（offset_id 分页的 Web 版）；
//   2. client_id 幂等发送 —— 乐观发送的超时重发 / 双击只落一行（random_id 同思路）；
//   3. typing 心跳 —— 上报后随消息轮询下发，不新增轮询通道；
//   4. after 增量与首屏字段的回归（nextCursor / prevCursor / hasMore 口径）。
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, setSetting, type TestUser } from "./helpers"
import { uuid } from "../src/crypto"

interface ChatListPayload {
  messages: { id: string; body: string; createdAt: string; replyTo: string | null }[]
  nextCursor: string | null
  prevCursor: string | null
  hasMore: boolean
  typing: { userId: string; username: string }[]
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM chat_messages").run()
  await env.DB.prepare("DELETE FROM chat_presence").run()
  await setSetting("chat_enabled", "1")
})

/** 直接插库造消息：翻页用例要精确控制条数与顺序，走 API 会撞发言限流 */
async function seedMessages(userId: string, n: number, startMs = Date.now() - 60_000) {
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const id = uuid()
    ids.push(id)
    // 每条间隔 1 秒，ISO 字典序 == 时间序（游标按 (created_at, id) 元组比较）
    const createdAt = new Date(startMs + i * 1000).toISOString()
    await env.DB.prepare(
      "INSERT INTO chat_messages (id, user_id, body, created_at) VALUES (?, ?, ?, ?)"
    )
      .bind(id, userId, `msg-${i}`, createdAt)
      .run()
  }
  return ids
}

async function list(user: TestUser, qs = ""): Promise<ChatListPayload> {
  const res = await fetchSelf(authRequest(user, `/api/chat/messages${qs}`))
  expect(res.status).toBe(200)
  return await res.json<ChatListPayload>()
}

async function send(
  user: TestUser,
  body: string,
  clientId?: string
): Promise<{ status: number; payload: { message: { id: string; body: string } } }> {
  const res = await fetchSelf(
    authRequest(user, "/api/chat/messages", {
      method: "POST",
      body: JSON.stringify(clientId ? { body, clientId } : { body }),
    })
  )
  return { status: res.status, payload: await res.json() }
}

describe("聊天室 before 向前翻页", () => {
  it("首屏取最新 N 条，prevCursor/hasMore 指向更早的一批", async () => {
    const u = await makeUser()
    await seedMessages(u.id, 5)

    const first = await list(u, "?limit=3")
    // 首屏是**最新** 3 条，且整体升序
    expect(first.messages.map((m) => m.body)).toEqual(["msg-2", "msg-3", "msg-4"])
    expect(first.hasMore).toBe(true)
    expect(first.prevCursor).toBeTruthy()
    expect(first.nextCursor).toBeTruthy()
  })

  it("before 取游标之前的一批：与首屏不重叠、合起来是完整升序", async () => {
    const u = await makeUser()
    await seedMessages(u.id, 5)

    const first = await list(u, "?limit=3")
    const earlier = await list(u, `?before=${encodeURIComponent(first.prevCursor!)}&limit=3`)
    // 更早的一批：msg-0 msg-1（取满 2 条 < limit → 还有更早的？不，2 < 3 → hasMore=false）
    expect(earlier.messages.map((m) => m.body)).toEqual(["msg-0", "msg-1"])
    expect(earlier.hasMore).toBe(false)
    // 两批无重叠
    const firstIds = new Set(first.messages.map((m) => m.id))
    expect(earlier.messages.some((m) => firstIds.has(m.id))).toBe(false)
    // 翻页方向不返回 typing（那一轮用户要的是历史，省一次查询）
    expect(earlier.typing).toEqual([])
  })

  it("没有更早的了：before 传首屏第一条的游标 → 空列表", async () => {
    const u = await makeUser()
    await seedMessages(u.id, 2)
    const first = await list(u, "?limit=50")
    const earlier = await list(u, `?before=${encodeURIComponent(first.prevCursor!)}`)
    expect(earlier.messages).toEqual([])
    expect(earlier.hasMore).toBe(false)
  })
})

describe("聊天室 client_id 幂等发送", () => {
  it("同一个 clientId 提交两次：都成功、返回同一条、库里只有一行", async () => {
    const u = await makeUser()
    const clientId = "test-client-id-0001"

    const r1 = await send(u, "乐观发送的一句话", clientId)
    expect(r1.status).toBe(201)
    const r2 = await send(u, "乐观发送的一句话", clientId)
    expect(r2.status).toBe(201)
    expect(r2.payload.message.id).toBe(r1.payload.message.id)

    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM chat_messages WHERE user_id = ?"
    )
      .bind(u.id)
      .first<{ n: number }>()
    expect(row?.n).toBe(1)
  })

  it("不带 clientId 的旧调用方：每次都落一条（行为不变）", async () => {
    const u = await makeUser()
    await send(u, "第一条")
    await send(u, "第二条")
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM chat_messages WHERE user_id = ?"
    )
      .bind(u.id)
      .first<{ n: number }>()
    expect(row?.n).toBe(2)
  })

  it("不同用户的相同 clientId 互不影响（唯一索引是 (user_id, client_id)）", async () => {
    const a = await makeUser()
    const b = await makeUser()
    const clientId = "shared-client-id-0002"
    const r1 = await send(a, "A 的话", clientId)
    const r2 = await send(b, "B 的话", clientId)
    expect(r1.status).toBe(201)
    expect(r2.status).toBe(201)
    expect(r2.payload.message.id).not.toBe(r1.payload.message.id)
  })
})

describe("聊天室 typing 心跳", () => {
  it("上报后消息列表带出自己；未上报的人不在窗口里", async () => {
    const a = await makeUser()
    const b = await makeUser()

    // 都还没打字：列表里没有 typing
    const before = await list(a)
    expect(before.typing).toEqual([])

    // A 打字 → A 自己拉列表能看到自己；B 拉列表也能看到 A（typing 是广播）
    const res = await fetchSelf(authRequest(a, "/api/chat/typing", { method: "POST" }))
    expect(res.status).toBe(200)

    const forA = await list(a)
    expect(forA.typing.map((t) => t.username)).toEqual([a.username])

    const forB = await list(b)
    expect(forB.typing.map((t) => t.username)).toEqual([a.username])
  })
})

describe("聊天室列表字段回归", () => {
  it("after 增量只回比游标新的消息", async () => {
    const u = await makeUser()
    const r1 = await send(u, "第一条")
    const first = await list(u)
    expect(first.messages.map((m) => m.id)).toEqual([r1.payload.message.id])

    const r2 = await send(u, "第二条")
    const inc = await list(u, `?after=${encodeURIComponent(first.nextCursor!)}`)
    expect(inc.messages.map((m) => m.id)).toEqual([r2.payload.message.id])

    // 旧前端传「消息 id」也要能解析（服务端兼容路径）
    const incById = await list(u, `?after=${encodeURIComponent(r1.payload.message.id)}`)
    expect(incById.messages.map((m) => m.id)).toEqual([r2.payload.message.id])
  })
})
