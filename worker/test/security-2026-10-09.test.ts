// 2026-10-09 渗透测试发现项的回归测试。
//
// 覆盖三类：
//   1. /api/v1/*（公开 API）绕过「未验证邮箱」写入门槛 —— finding#2 / #6
//   2. 受配额约束的资源创建被并发击穿（TOCTOU）—— finding#1 / #4 / #5
//   3. 配额守卫的确定性边界（顺序创建也必须严格封顶）
//
// ⚠️ 为什么并发用例有意义：`COUNT → 判额度 → INSERT` 之间夹着 `await`，
// 事件循环会交错，本地 SQLite 也能复现「同时通过判定」。
// 即便某个环境恰好复现不出来，这些断言也不会误报（只能变宽松，不会变严）。
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, setSetting } from "./helpers"
import { hashToken, uuid } from "../src/crypto"

/** 直接给用户造一把 API Key（绕开 /api/api-key 的会话流程，聚焦被测逻辑） */
async function giveApiKey(userId: string): Promise<string> {
  const key = "doulor_" + uuid().replace(/-/g, "")
  await env.DB.prepare(
    `INSERT INTO user_api_keys (user_id, key_hash, key_prefix, created_at, last_used_at, is_admin)
     VALUES (?, ?, ?, ?, NULL, 0)
     ON CONFLICT(user_id) DO UPDATE SET key_hash = excluded.key_hash,
       key_prefix = excluded.key_prefix, is_admin = 0`
  )
    .bind(userId, await hashToken(key), key.slice(0, 8), new Date().toISOString())
    .run()
  return key
}

function apiRequest(path: string, key: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers)
  headers.set("Authorization", `Bearer ${key}`)
  headers.set("Content-Type", "application/json")
  return new Request(`https://cloud.doulor.cn${path}`, { ...init, headers })
}

async function expectCode(res: Response): Promise<string | undefined> {
  return ((await res.json().catch(() => ({}))) as { code?: string }).code
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM rate_limits").run()
})

// ─────────────────────────────────────────────────────────────
// 1. 公开 API 的邮箱验证门槛
// ─────────────────────────────────────────────────────────────

describe("/api/v1 写操作必须过「邮箱已验证」门槛（finding#2/#6）", () => {
  it("未验证邮箱：会话路径与 API Key 路径都被 403 EMAIL_NOT_VERIFIED", async () => {
    const u = await makeUser({ emailVerified: false })
    const key = await giveApiKey(u.id)

    // 基线：站内会话路径本来就是拦的
    const viaSession = await fetchSelf(
      authRequest(u, "/api/mailbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localPart: "v1gate" }),
      })
    )
    expect(viaSession.status).toBe(403)
    expect(await expectCode(viaSession)).toBe("EMAIL_NOT_VERIFIED")

    // 修复点：API Key 路径以前能绕过（/api/v1/mailbox 归一化成 /v1/mailbox，不命中前缀表）
    const viaKey = await fetchSelf(
      apiRequest("/api/v1/mailbox", key, {
        method: "POST",
        body: JSON.stringify({ localPart: "v1gate" }),
      })
    )
    expect(viaKey.status).toBe(403)
    expect(await expectCode(viaKey)).toBe("EMAIL_NOT_VERIFIED")

    // 落库确认：真的没建出来
    const created = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM mailboxes WHERE user_id = ?"
    )
      .bind(u.id)
      .first<{ c: number }>()
    expect(created?.c ?? 0).toBe(0)
  })

  it("只读请求不受该门槛影响（未验证也能 GET）", async () => {
    const u = await makeUser({ emailVerified: false })
    const key = await giveApiKey(u.id)

    const res = await fetchSelf(apiRequest("/api/v1/mailbox", key))
    expect(await expectCode(res)).not.toBe("EMAIL_NOT_VERIFIED")
  })

  it("已验证邮箱不被这道门槛拦（写操作能走到业务逻辑）", async () => {
    const u = await makeUser()
    const key = await giveApiKey(u.id)

    const res = await fetchSelf(
      apiRequest("/api/v1/mailbox", key, {
        method: "POST",
        body: JSON.stringify({ localPart: "okgate" }),
      })
    )
    expect(await expectCode(res)).not.toBe("EMAIL_NOT_VERIFIED")
  })
})

// ─────────────────────────────────────────────────────────────
// 2. 配额守卫：顺序创建严格封顶 + 并发不超额
// ─────────────────────────────────────────────────────────────

describe("普通邮箱配额（finding#1/#4）", () => {
  it("顺序创建到上限后，下一次必须被拒", async () => {
    const u = await makeUser()
    await env.DB.prepare("DELETE FROM mailboxes WHERE user_id = ?").bind(u.id).run()

    const add = (localPart: string) =>
      fetchSelf(
        authRequest(u, "/api/mailbox", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ localPart }),
        })
      )

    for (let i = 0; i < 3; i++) {
      expect((await add(`seq${i}box`)).status).toBe(201)
    }
    const over = await add("seq3box")
    expect(over.status).toBe(400)
    expect(await expectCode(over)).toBe("LIMIT_REACHED")
  })

  it("并发创建不会突破上限", async () => {
    const u = await makeUser()
    await env.DB.prepare("DELETE FROM mailboxes WHERE user_id = ?").bind(u.id).run()

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        fetchSelf(
          authRequest(u, "/api/mailbox", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ localPart: `race${i}box` }),
          })
        )
      )
    )

    const ok = results.filter((r) => r.status === 201).length
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM mailboxes WHERE user_id = ? AND is_temp = 0"
    )
      .bind(u.id)
      .first<{ c: number }>()

    expect(ok).toBeLessThanOrEqual(3)
    expect(row?.c ?? 0).toBeLessThanOrEqual(3)
  })
})

describe("临时邮箱配额（finding#4）", () => {
  it("同时最多 1 个：并发创建不会突破", async () => {
    const u = await makeUser()
    await env.DB.prepare("DELETE FROM mailboxes WHERE user_id = ?").bind(u.id).run()

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        fetchSelf(authRequest(u, "/api/mailbox/temp", { method: "POST" }))
      )
    )

    const ok = results.filter((r) => r.status === 201).length
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM mailboxes WHERE user_id = ? AND is_temp = 1"
    )
      .bind(u.id)
      .first<{ c: number }>()

    expect(ok).toBeLessThanOrEqual(1)
    expect(row?.c ?? 0).toBeLessThanOrEqual(1)
  })
})

describe("一级子域名配额（finding#1/#5）", () => {
  it(
    "并发创建不会突破配额",
    async () => {
      await setSetting("subdomain_quota_default", "3")
      const u = await makeUser()

      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          fetchSelf(
            authRequest(u, "/api/subdomains", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: `race${i}sub` }),
            })
          )
        )
      )

      const ok = results.filter((r) => r.status === 201).length
      const row = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM subdomains WHERE user_id = ? AND parent_id IS NULL"
      )
        .bind(u.id)
        .first<{ c: number }>()

      expect(ok).toBeLessThanOrEqual(3)
      expect(row?.c ?? 0).toBeLessThanOrEqual(3)

      // 收尾：清掉本用例造的行与改过的设置，别污染同一次 run 里的其它测试
      await env.DB.prepare("DELETE FROM subdomains WHERE user_id = ?").bind(u.id).run()
      await setSetting("subdomain_quota_default", "5")
    },
    // 子域名创建会顺带打一次 Cloudflare（查 zone / 查同名记录），本地很慢
    30000
  )
})
