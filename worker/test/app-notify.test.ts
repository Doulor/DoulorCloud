// App 端通知拉取接口的契约。
//
// 调用方是打包成 App 的手机端（WebToApp 的「轮询前台服务」），它有两个
// 由 App 侧决定、我们改不了的特性 —— 这个文件主要就是把应对它们的约定锁住：
//   1. 用 HttpURLConnection 直接发请求，**不带 Cookie** ⇒ 只能靠 Bearer 令牌认人；
//   2. **完全不去重**，返回几条就弹几条 ⇒ 「同一条消息只推一次」必须由服务端游标保证。
// 另外锁住返回的字段形状（title / body / url），因为 App 是按这三个 key 解析的。
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf } from "./helpers"

interface PullItem {
  title: string
  body: string
  url: string
}

async function getToken(user: { cookie: string }) {
  const res = await fetchSelf(authRequest(user, "/api/app/notify-token"))
  expect(res.status).toBe(200)
  return await res.json<{ token: string; url: string; headerJson: string }>()
}

/** 直接插一条通知（绕过产生通知的业务流程，测试只关心拉取契约）。 */
async function seedNotification(userId: string, title: string, body: string, link: string) {
  await env.DB.prepare(
    `INSERT INTO notifications (id, user_id, category, type, title, body, link, read, created_at)
     VALUES (?, ?, 'system', 'system', ?, ?, ?, 0, ?)`
  )
    .bind(crypto.randomUUID(), userId, title, body, link, new Date().toISOString())
    .run()
}

/** 用令牌调拉取接口（模拟 App 的请求：不带 Cookie，只带 Authorization 头）。 */
async function pull(token: string) {
  return fetchSelf(
    new Request("https://cloud.doulor.cn/api/app/notifications", {
      headers: { Authorization: `Bearer ${token}` },
    })
  )
}

describe("GET /api/app/notifications —— App 轮询拉取", () => {
  it("没有令牌 → 401", async () => {
    const res = await fetchSelf(new Request("https://cloud.doulor.cn/api/app/notifications"))
    expect(res.status).toBe(401)
  })

  it("令牌错误 → 401", async () => {
    const res = await pull("not-a-real-token")
    expect(res.status).toBe(401)
  })

  it("令牌有效 → 返回 title / body / url 三项，且 url 是绝对地址", async () => {
    const user = await makeUser()
    const { token } = await getToken(user)
    await seedNotification(user.id, "有人回复了你", "看看这条评论", "/dashboard/community/abc")

    const res = await pull(token)
    expect(res.status).toBe(200)
    const items = await res.json<PullItem[]>()
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe("有人回复了你")
    expect(items[0].body).toBe("看看这条评论")
    // App 会把 url 直接打开，所以必须是绝对地址（库里存的是相对路径）
    expect(items[0].url).toBe("https://cloud.doulor.cn/dashboard/community/abc")
  })

  it("第二次拉取不重复返回同一条（游标生效）", async () => {
    const user = await makeUser()
    const { token } = await getToken(user)
    await seedNotification(user.id, "第一条", "", "/dashboard/messages")

    const first = await (await pull(token)).json<PullItem[]>()
    expect(first).toHaveLength(1)

    // App 不去重，所以这里必须是空的 —— 否则用户会每隔几分钟收到同一条
    const second = await (await pull(token)).json<PullItem[]>()
    expect(second).toHaveLength(0)
  })

  it("拉取后再产生的通知，下一次能拿到", async () => {
    const user = await makeUser()
    const { token } = await getToken(user)

    await (await pull(token)).json<PullItem[]>()
    await seedNotification(user.id, "新消息", "", "/dashboard/messages")

    const next = await (await pull(token)).json<PullItem[]>()
    expect(next).toHaveLength(1)
    expect(next[0].title).toBe("新消息")
  })

  it("看不到别人的通知", async () => {
    const me = await makeUser()
    const other = await makeUser()
    const { token } = await getToken(me)
    await seedNotification(other.id, "别人的消息", "", "/dashboard/messages")

    const items = await (await pull(token)).json<PullItem[]>()
    expect(items).toHaveLength(0)
  })

  it("重新生成令牌后，旧令牌立即失效", async () => {
    const user = await makeUser()
    const old = await getToken(user)
    const res = await fetchSelf(
      new Request("https://cloud.doulor.cn/api/app/notify-token/rotate", {
        method: "POST",
        headers: { Cookie: user.cookie },
      })
    )
    expect(res.status).toBe(200)
    const fresh = await res.json<{ token: string }>()
    expect(fresh.token).not.toBe(old.token)

    expect((await pull(old.token)).status).toBe(401)
    expect((await pull(fresh.token)).status).toBe(200)
  })

  it("未登录不能取令牌", async () => {
    const res = await fetchSelf(new Request("https://cloud.doulor.cn/api/app/notify-token"))
    expect(res.status).toBe(401)
  })
})
