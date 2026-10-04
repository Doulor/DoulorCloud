/**
 * 临时邮箱「每天最多刷新次数」闸门（2026-10-04 站长要求）。
 *
 * 走真实路由验证：刷新（换地址）受 `temp_mailbox_refresh_daily_limit` 限制，
 * 默认 20、后台可配、0 = 不限、管理员/站长不限。计数按「站点时区当天」，
 * 超限返回 429 TEMP_MAILBOX_DAILY_LIMIT，且**不能动旧邮箱**（旧地址仍在）。
 */
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, setSetting } from "./helpers"

type TestUser = Awaited<ReturnType<typeof makeUser>>

async function addTempMailbox(user: TestUser): Promise<string> {
  const res = await fetchSelf(authRequest(user, "/api/mailbox/temp", { method: "POST" }))
  expect(res.status).toBe(201)
  return (await res.json<{ mailbox: { id: string; address: string } }>()).mailbox.id
}

async function refreshTempMailbox(user: TestUser, id: string): Promise<Response> {
  return fetchSelf(authRequest(user, `/api/mailbox/temp/${id}/refresh`, { method: "POST" }))
}

describe("临时邮箱每日刷新上限", () => {
  it("超过上限的刷新返回 429，且旧邮箱不被删除", async () => {
    await setSetting("temp_mailbox_refresh_daily_limit", "2")
    const user = await makeUser()
    let id = await addTempMailbox(user)

    // 第 1、2 次刷新：都在额度内
    for (let i = 0; i < 2; i++) {
      const res = await refreshTempMailbox(user, id)
      expect(res.status).toBe(201)
      id = (await res.json<{ mailbox: { id: string; address: string } }>()).mailbox.id
    }

    // 第 3 次：超限
    const denied = await refreshTempMailbox(user, id)
    expect(denied.status).toBe(429)
    expect((await denied.json<{ code: string }>()).code).toBe("TEMP_MAILBOX_DAILY_LIMIT")

    // 超限那次绝不能把旧邮箱删掉 —— 否则用户「今天的额度」白费
    const row = await env.DB.prepare("SELECT id FROM mailboxes WHERE id = ?")
      .bind(id)
      .first()
    expect(row).not.toBeNull()
  })

  it("设为 0 = 不限制", async () => {
    await setSetting("temp_mailbox_refresh_daily_limit", "0")
    const user = await makeUser()
    let id = await addTempMailbox(user)

    for (let i = 0; i < 5; i++) {
      const res = await refreshTempMailbox(user, id)
      expect(res.status).toBe(201)
      id = (await res.json<{ mailbox: { id: string } }>()).mailbox.id
    }
  })

  it("管理员不受每日上限限制", async () => {
    await setSetting("temp_mailbox_refresh_daily_limit", "1")
    const admin = await makeUser({ role: "admin" })
    let id = await addTempMailbox(admin)

    for (let i = 0; i < 3; i++) {
      const res = await refreshTempMailbox(admin, id)
      expect(res.status).toBe(201)
      id = (await res.json<{ mailbox: { id: string } }>()).mailbox.id
    }
  })
})
