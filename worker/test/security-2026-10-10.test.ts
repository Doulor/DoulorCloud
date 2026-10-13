// 2026-10-10 渗透测试发现项的回归测试。
//
// 覆盖：
//   1. tempbox proxy-upload / commit 的 key 前缀逃逸（finding#2 / #3）
//   2. email-verified 白名单的覆盖缺口（finding#7）
//   3. 改密码后旧 API Key 必须失效（finding#11）
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, type TestUser } from "./helpers"
import { hashToken, uuid } from "../src/crypto"

/** 直接造一条存活中的分享箱批次 */
async function makeBatch(user: TestUser, code = String(Math.floor(100000 + Math.random() * 899999))) {
  await env.DB.prepare(
    `INSERT INTO tempbox_batches (id, code, creator_user_id, expire_at, file_count, total_bytes, created_at)
     VALUES (?, ?, ?, ?, 0, 0, ?)`
  )
    .bind(
      uuid(),
      code,
      user.id,
      new Date(Date.now() + 3600_000).toISOString(),
      new Date().toISOString()
    )
    .run()
  return code
}

async function giveApiKey(userId: string): Promise<string> {
  const key = "doulor_" + uuid().replace(/-/g, "")
  await env.DB.prepare(
    `INSERT INTO user_api_keys (user_id, key_hash, key_prefix, created_at, last_used_at, is_admin)
     VALUES (?, ?, ?, ?, NULL, 0)
     ON CONFLICT(user_id) DO UPDATE SET key_hash = excluded.key_hash, key_prefix = excluded.key_prefix`
  )
    .bind(userId, await hashToken(key), key.slice(0, 8), new Date().toISOString())
    .run()
  return key
}

async function codeOf(res: Response): Promise<string | undefined> {
  return ((await res.json().catch(() => ({}))) as { code?: string }).code
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM rate_limits").run()
})

describe("tempbox 路径前缀逃逸（finding#2/#3）", () => {
  it("proxy-upload 的 key 含 `..` 段必须 403（原本能写到别的前缀）", async () => {
    const u = await makeUser()
    const code = await makeBatch(u)

    const escape = `temporary/${code}/../../profiles/${u.username}/background.jpg`
    const res = await fetchSelf(
      authRequest(u, `/api/tempbox/${code}/proxy-upload?key=${encodeURIComponent(escape)}`, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "ESCAPE",
      })
    )
    expect(res.status).toBe(403)
    expect(await codeOf(res)).toBe("FORBIDDEN")
  })

  it("`../` 逃到别人批次的 key 也必须 403", async () => {
    const a = await makeUser()
    const b = await makeUser()
    const codeA = await makeBatch(a)
    const codeB = await makeBatch(b)

    const escape = `temporary/${codeA}/../${codeB}/injected.txt`
    const res = await fetchSelf(
      authRequest(a, `/api/tempbox/${codeA}/proxy-upload?key=${encodeURIComponent(escape)}`, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "INJECT",
      })
    )
    expect(res.status).toBe(403)
  })

  it("commit 的 key 含 `..` 段同样 403（两个入口都堵）", async () => {
    const u = await makeUser()
    const code = await makeBatch(u)

    const res = await fetchSelf(
      authRequest(u, `/api/tempbox/${code}/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: `temporary/${code}/../x/y.txt` }),
      })
    )
    expect(res.status).toBe(403)
  })
})

describe("email-verified 白名单缺口（finding#7）", () => {
  it("未验证邮箱账号不得写平台桶 / 铸 OAuth 客户端", async () => {
    const u = await makeUser({ emailVerified: false })

    const lab = await fetchSelf(
      authRequest(u, "/api/lab/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "verify-gate", files: { "index.html": "<h1>x</h1>" } }),
      })
    )
    expect(lab.status).toBe(403)
    expect(await codeOf(lab)).toBe("EMAIL_NOT_VERIFIED")

    const stickers = await fetchSelf(
      authRequest(u, "/api/stickers", {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: "not-a-real-png",
      })
    )
    expect(stickers.status).toBe(403)
    expect(await codeOf(stickers)).toBe("EMAIL_NOT_VERIFIED")

    const oauth = await fetchSelf(
      authRequest(u, "/api/oauth/my-clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "gate", redirectUris: ["https://example.com/cb"] }),
      })
    )
    expect(oauth.status).toBe(403)
    expect(await codeOf(oauth)).toBe("EMAIL_NOT_VERIFIED")
  })

  it("已验证邮箱的账号不受影响（写操作能走到业务逻辑）", async () => {
    const u = await makeUser()
    const res = await fetchSelf(
      authRequest(u, "/api/lab/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "verify-gate-ok", files: { "index.html": "<h1>x</h1>" } }),
      })
    )
    expect(await codeOf(res)).not.toBe("EMAIL_NOT_VERIFIED")
  })
})

describe("凭证变更吊销（finding#11）", () => {
  it("改密码后旧 API Key 必须失效", async () => {
    const u = await makeUser()
    const key = await giveApiKey(u.id)

    // 改密前：Key 可用（这里只断言「不是 401 API Key 无效」）
    const before = await fetchSelf(
      new Request("https://cloud.doulor.cn/api/v1/subdomain", {
        headers: { Authorization: `Bearer ${key}` },
      })
    )
    expect(await codeOf(before)).not.toBe("UNAUTHORIZED")

    const changed = await fetchSelf(
      authRequest(u, "/api/password", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: "pass1234", newPassword: "pass1234-new" }),
      })
    )
    expect(changed.status).toBe(200)

    // 改密后：旧 Key 必须已经没了
    const after = await fetchSelf(
      new Request("https://cloud.doulor.cn/api/v1/subdomain", {
        headers: { Authorization: `Bearer ${key}` },
      })
    )
    expect(after.status).toBe(401)
    expect(await codeOf(after)).toBe("UNAUTHORIZED")

    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM user_api_keys WHERE user_id = ?"
    )
      .bind(u.id)
      .first<{ c: number }>()
    expect(left?.c ?? 0).toBe(0)
  })
})
