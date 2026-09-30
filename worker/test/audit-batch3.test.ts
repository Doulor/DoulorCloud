/**
 * 回归测试：第三批修复（2026-09-25 审计 M9 / M12 / L3）。
 *
 * 2026-09-25 更新：`/api/community/link-preview` 的路由已经补进
 * `worker/src/index.ts`（审计 F4），所以这里的用例**已从「直接调 handler」
 * 改回端到端 `SELF.fetch`** —— 这样它同时钉住两件事：限流逻辑本身，
 * 以及「路由真的注册了」。原先那个「直接调 handler」的写法对
 * 「路由忘了接」这种故障是完全无感的（这正是 F4 能长期存在的原因）。
 */
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { uuid } from "../src/crypto"
import { makeUser, authRequest, fetchSelf, setSetting } from "./helpers"

const PREVIEW_URL = `/api/community/link-preview?url=${encodeURIComponent(
  "https://cloud.doulor.cn/community/abc123"
)}`

describe("链接预览路由 + 限流（M9 / F4）", () => {
  it("路由已注册：端到端返回 200（F4 —— 原先固定 404，链接卡片从来不出）", async () => {
    const u = await makeUser()
    const res = await fetchSelf(authRequest(u, PREVIEW_URL))
    expect(res.status).toBe(200)
  })

  it("同一用户超过上限后被限流（原先可当免费抓取代理）", async () => {
    const u = await makeUser()

    // 直接把限流桶填到上限，再打一次就必然被拒。
    // 这样写而不是「循环打 121 次」：每次调用都是一次 D1 往返，
    // 在整仓测试并行执行时 121 次串行会超过默认 5s 超时（实测踩到过）。
    // ⚠️ 窗口起点是**对齐**的（ratelimit.ts:45 的 floor 取整），
    // 所以必须用同样的算法算出 window_start，否则会被当成新窗口而重置计数。
    const windowMs = 10 * 60 * 1000
    const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs).toISOString()
    await env.DB.prepare(
      `INSERT INTO rate_limits (bucket, count, window_start, updated_at)
            VALUES (?, ?, ?, ?)
       ON CONFLICT(bucket) DO UPDATE SET count = excluded.count, window_start = excluded.window_start`
    )
      .bind(`link-preview:user:${u.id}`, 120, windowStart, new Date().toISOString())
      .run()

    // `guardRateLimit` 内部抛 ApiError，由最外层路由统一转成 HTTP 响应，
    // 所以端到端看到的是 429 状态码。
    const res = await fetchSelf(authRequest(u, PREVIEW_URL))
    expect(res.status).toBe(429)
  })

  it("缺少 url 参数仍然 400（限流不改变参数校验语义）", async () => {
    const u = await makeUser()
    const res = await fetchSelf(authRequest(u, "/api/community/link-preview"))
    expect(res.status).toBe(400)
    expect((await res.json<{ code: string }>()).code).toBe("INVALID_PARAMS")
  })
})

describe("注册时检查存储命名空间占用（M12）", () => {
  it("用户名已被 storage_accounts.prefix 占用时注册返回 409，而不是先成功再 500", async () => {
    // D1 在测试环境**确实强制外键**（storage_accounts.user_id → users.id），
    // 所以必须先有真实用户行，不能随便塞一个 uuid。
    const owner = await makeUser()
    const taken = `m12pre${uuid().slice(0, 6)}`
    // 模拟「A 改名后遗留的旧存储前缀」
    await env.DB.prepare(
      "INSERT INTO storage_accounts (user_id, prefix, quota_bytes, used_bytes, file_count, enabled, created_at, updated_at) VALUES (?, ?, 100, 0, 0, 1, ?, ?)"
    )
      .bind(owner.id, taken, new Date().toISOString(), new Date().toISOString())
      .run()

    const code = `M12-${uuid().slice(0, 8)}`
    await env.DB.prepare(
      "INSERT INTO invite_codes (id, code, max_uses, used_count, created_at) VALUES (?, ?, 1, 0, ?)"
    )
      .bind(uuid(), code, new Date().toISOString())
      .run()

    const res = await fetchSelf(
      new Request("https://cloud.doulor.cn/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.9.1.1" },
        body: JSON.stringify({
          username: taken,
          email: `${taken}@example.com`,
          password: "pass12345",
          inviteCode: code,
        }),
      })
    )

    expect(res.status).toBe(409)
    const body = (await res.json()) as { code?: string }
    expect(body.code).toBe("CONFLICT")

    // 邀请码不能被白烧（预检在消费之前）
    const used = await env.DB.prepare("SELECT used_count FROM invite_codes WHERE code = ?")
      .bind(code)
      .first<{ used_count: number }>()
    expect(used?.used_count).toBe(0)
  })

  it("未被占用的用户名仍可正常注册", async () => {
    const code = `M12OK-${uuid().slice(0, 8)}`
    await env.DB.prepare(
      "INSERT INTO invite_codes (id, code, max_uses, used_count, created_at) VALUES (?, ?, 1, 0, ?)"
    )
      .bind(uuid(), code, new Date().toISOString())
      .run()
    const name = `m12ok${uuid().slice(0, 6)}`

    const res = await fetchSelf(
      new Request("https://cloud.doulor.cn/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.9.2.1" },
        body: JSON.stringify({
          username: name,
          email: `${name}@example.com`,
          password: "pass12345",
          inviteCode: code,
        }),
      })
    )
    expect(res.status).toBe(201)
  })
})

describe("分享箱 404 文案统一（L3）", () => {
  it("码不存在与文件不存在必须是同一句文案（否则成为枚举 oracle）", async () => {
    // 「码不存在」路径在 R2 未配置时也会先命中（assertBatchAlive 在配置检查之前）
    const res = await fetchSelf(
      new Request("https://cloud.doulor.cn/api/tempbox/000000/nope.txt")
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error?: string; code?: string }
    expect(body.code).toBe("NOT_FOUND")
    expect(body.error).toBe("接收码不存在或已失效")
  })

  it("下载接口与列表接口对同一个无效码给出完全一致的响应", async () => {
    const a = await fetchSelf(new Request("https://cloud.doulor.cn/api/tempbox/000001"))
    const b = await fetchSelf(
      new Request("https://cloud.doulor.cn/api/tempbox/000001/x.txt")
    )
    expect(a.status).toBe(b.status)
    const ba = (await a.json()) as { error?: string; code?: string }
    const bb = (await b.json()) as { error?: string; code?: string }
    expect(ba.error).toBe(bb.error)
    expect(ba.code).toBe(bb.code)
  })
})

describe("全局设置不再跨用例污染（M24）", () => {
  it("把开关关掉，验证下一个用例读到的是默认值", async () => {
    await setSetting("community_enabled", "0")
    const u = await makeUser()
    const res = await fetchSelf(authRequest(u, "/api/community/posts"))
    expect(res.status).toBe(403)
  })

  it("本用例不应受上一个用例影响（设置已自动复位）", async () => {
    const u = await makeUser()
    const res = await fetchSelf(authRequest(u, "/api/community/posts"))
    expect(res.status).toBe(200)
  })
})
