// 聊天室在线人数（2026-10-17）：`GET /api/chat/presence` 必须把「来问的人」自己算进去。
//
// 背景（用户 yangshu 反馈「进入公共聊天室，明明有人在线却显示 0」）：
//   原来 presence 只读不写，而前端进聊天室时 pollPresence() 与 heartbeat() 是同一个
//   effect 里连着发出的两个请求 —— SELECT 常常先于 INSERT 到达，首屏就显示 0 人，
//   要等 30 秒后的下一次轮询才补上。
//   修法是 presence 在查询前先把自己 UPSERT 进 chat_presence。
//
// 这两个用例就是钉住这个顺序无关性：**不调用 heartbeat** 也能看到自己。
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, setSetting, type TestUser } from "./helpers"

interface PresenceUser {
  userId: string
  username: string
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM chat_presence").run()
  await setSetting("chat_enabled", "1")
})

async function online(user: TestUser): Promise<PresenceUser[]> {
  const res = await fetchSelf(authRequest(user, "/api/chat/presence"))
  expect(res.status).toBe(200)
  const data = await res.json<{ online: PresenceUser[] }>()
  return data.online
}

describe("聊天室在线人数", () => {
  it("首次查询就能看到自己 —— 不需要先发心跳", async () => {
    const u = await makeUser()
    const list = await online(u)
    expect(list.map((x) => x.username)).toContain(u.username)
  })

  it("两个人分别查询：各自都能看到对方和自己", async () => {
    const a = await makeUser()
    const b = await makeUser()

    await online(a)
    const fromB = await online(b)
    const names = fromB.map((x) => x.username)

    expect(names).toContain(a.username)
    expect(names).toContain(b.username)
  })
})
