// 社区「N 条新帖子」角标：必须是「我看过之后新增的」，进页面即清零。
//
// 背景（用户实测报的 bug）：角标原来算的是「全站最近 24 小时新帖数」，
// 纯时间窗口、跟读没读过无关 —— 点进社区读完，角标还在，
// 读不掉的数字等于没有信息量。
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser } from "./helpers"
import { uuid } from "../src/crypto"

/**
 * 角标数是个**全表计数**，同一个 describe 里前面的用例留下的帖子会算进来
 * （实测：期望 1 得到 2/4）。每个用例前清空 posts，让断言不受顺序影响。
 */
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM posts").run()
})

/** 直接把帖子塞进库：本文件测的是角标口径，不走发帖接口的限流 */
async function seedPost(user: { id: string }, body = "hi", minutesAgo = 0) {
  const id = uuid()
  const at = new Date(Date.now() - minutesAgo * 60000).toISOString()
  await env.DB.prepare(
    "INSERT INTO posts (id, user_id, channel, body, created_at) VALUES (?, ?, 'general', ?, ?)"
  )
    .bind(id, user.id, body, at)
    .run()
  return id
}

async function count(user: { id: string; username: string; cookie: string }) {
  const res = await fetchSelf(authRequest(user, "/api/community/new-posts-count"))
  expect(res.status).toBe(200)
  return (await res.json<{ count: number }>()).count
}

async function markSeen(user: { id: string; username: string; cookie: string }) {
  const res = await fetchSelf(
    authRequest(user, "/api/community/seen", { method: "POST" })
  )
  expect(res.status).toBe(200)
}

describe("社区新帖角标", () => {
  it("未登录不返回全站数据（401）", async () => {
    const res = await fetchSelf(
      new Request("https://cloud.doulor.cn/api/community/new-posts-count")
    )
    expect(res.status).toBe(401)
  })

  it("没打开过社区时按「最近 24 小时」算，超过 24 小时的老帖不计", async () => {
    const me = await makeUser()
    const other = await makeUser()
    await seedPost(other, "刚发的", 5)
    await seedPost(other, "两天前的", 60 * 48)
    expect(await count(me)).toBe(1)
  })

  it("进过社区后角标归零，之后别人发帖才重新计数", async () => {
    const me = await makeUser()
    const other = await makeUser()
    await seedPost(other, "旧帖", 10)
    expect(await count(me)).toBe(1)

    await markSeen(me)
    expect(await count(me)).toBe(0)

    await seedPost(other, "我看过之后的新帖", 0)
    expect(await count(me)).toBe(1)
  })

  it("自己发的帖子不计入角标（自己发的不需要「去读」）", async () => {
    const me = await makeUser()
    await markSeen(me)
    await seedPost(me, "我自己发的")
    expect(await count(me)).toBe(0)
  })

  it("被软删的帖子不计入", async () => {
    const me = await makeUser()
    const other = await makeUser()
    await markSeen(me)
    const id = await seedPost(other, "待删除")
    await env.DB.prepare("UPDATE posts SET deleted_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), id)
      .run()
    expect(await count(me)).toBe(0)
  })

  it("markSeen 只影响自己，不影响别人", async () => {
    const me = await makeUser()
    const other = await makeUser()
    await seedPost(other, "帖子")
    await markSeen(me)
    expect(await count(me)).toBe(0)
    // other 没标记过 → 仍按 24 小时口径看到这 1 条（不过它是自己发的，被排除）
    const third = await makeUser()
    expect(await count(third)).toBe(1)
  })

  it("未登录不能标记已读（401）", async () => {
    const res = await fetchSelf(
      new Request("https://cloud.doulor.cn/api/community/seen", { method: "POST" })
    )
    expect(res.status).toBe(401)
  })
})
