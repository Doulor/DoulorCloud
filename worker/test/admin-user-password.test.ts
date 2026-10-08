/**
 * 管理端「为用户重置密码」。
 *
 * 这是 rootOnly 的高危操作（改密码 = 接管账号），所以本测试钉住几条硬边界：
 *   1. 站长可以重置普通用户的密码，且**新密码真的能用**（哈希写对了）；
 *   2. 重置会**清空该用户全部会话**（否则旧会话还能用，等于没改）；
 *   3. 普通管理员不能做（403）—— 后端是 rootOnly 节点；
 *   4. 密码太短拒绝（与注册/找回同一口径：至少 8 位）；
 *   5. 目标用户不存在 → 404；
 *   6. 不能通过这个接口改 root 账户的密码。
 */
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, type TestUser } from "./helpers"
import { uuid, hashPassword, verifyPassword } from "../src/crypto"

async function setPassword(operator: TestUser, username: string, password: string): Promise<Response> {
  return fetchSelf(
    authRequest(operator, `/api/admin/users/${encodeURIComponent(username)}/password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    })
  )
}

async function passwordHashOf(userId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?")
    .bind(userId)
    .first<{ password_hash: string }>()
  return row?.password_hash ?? ""
}

async function sessionCount(userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?")
    .bind(userId)
    .first<{ c: number }>()
  return row?.c ?? 0
}

describe("管理端重置用户密码", () => {
  it("站长重置成功，且新密码可用", async () => {
    const root = await makeUser({ role: "root" })
    const target = await makeUser()
    const before = await passwordHashOf(target.id)

    const res = await setPassword(root, target.username, "NewPw@2026abc")
    expect(res.status).toBe(200)

    const after = await passwordHashOf(target.id)
    expect(after).not.toBe(before)
    expect(await verifyPassword("NewPw@2026abc", after)).toBe(true)
    // 旧密码不再可用
    expect(await verifyPassword("password123", after)).toBe(false)
  })

  it("重置后清空该用户全部会话", async () => {
    const root = await makeUser({ role: "root" })
    const target = await makeUser()
    const oldHash = await hashPassword("whatever-old")
    await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .bind(oldHash, target.id)
      .run()
    const now = new Date().toISOString()
    await env.DB.prepare(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(uuid(), target.id, uuid(), now, now)
      .run()
    expect(await sessionCount(target.id)).toBeGreaterThan(0)

    const res = await setPassword(root, target.username, "NewPw@2026abc")
    expect(res.status).toBe(200)
    expect(await sessionCount(target.id)).toBe(0)
  })

  it("普通管理员无权重置（rootOnly）", async () => {
    const admin = await makeUser({ role: "admin" })
    const target = await makeUser()
    const res = await setPassword(admin, target.username, "NewPw@2026abc")
    expect(res.status).toBe(403)
  })

  it("密码太短 → 400", async () => {
    const root = await makeUser({ role: "root" })
    const target = await makeUser()
    const res = await setPassword(root, target.username, "short")
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code?: string }
    expect(body.code).toBe("WEAK_PASSWORD")
  })

  it("目标用户不存在 → 404", async () => {
    const root = await makeUser({ role: "root" })
    const res = await setPassword(root, `nobody-${Date.now()}`, "NewPw@2026abc")
    expect(res.status).toBe(404)
  })

  it("不能改 root 账户的密码 → 403", async () => {
    const root = await makeUser({ role: "root" })
    const otherRoot = await makeUser({ role: "root" })
    const res = await setPassword(root, otherRoot.username, "NewPw@2026abc")
    expect(res.status).toBe(403)
  })
})
