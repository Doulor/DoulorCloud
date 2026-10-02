import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf } from "./helpers"

/**
 * 转发目标验证状态复现（2026-10-02 用户报告）。
 *
 * 症状：确认验证后列表变绿「已转发」，再点「保存」又变回琥珀色「转发待验证」，
 * 但转发实际正常工作。怀疑 updateMailbox 的响应里 forwardingVerified 是 null。
 */
type TestUser = Awaited<ReturnType<typeof makeUser>>

const JSON_HEADERS = { "Content-Type": "application/json" }

interface MailboxPublic {
  id: string
  address: string
  forwardingTo: string[]
  forwardingVerified: (boolean | null)[]
}

async function listMailboxes(user: TestUser): Promise<MailboxPublic[]> {
  const res = await fetchSelf(authRequest(user, "/api/mailbox"))
  expect(res.status).toBe(200)
  const { mailboxes } = await res.json<{ mailboxes: MailboxPublic[] }>()
  return mailboxes
}

async function updateForwarding(
  user: TestUser,
  id: string,
  targets: string[]
): Promise<Response> {
  return fetchSelf(
    authRequest(user, `/api/mailbox/${id}`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ forwardingTo: targets }),
    })
  )
}

/** 直接写 forwarding_verifications，模拟「已通过验证码验证」（省掉发信环节） */
async function markVerified(userId: string, email: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO forwarding_verifications (user_id, target_email, verified_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id, target_email) DO UPDATE SET verified_at = excluded.verified_at`
  ).bind(userId, email, new Date().toISOString()).run()
}

async function primaryMailbox(user: TestUser): Promise<MailboxPublic> {
  // makeUser 只建 users 行不建邮箱：与注册流程不同，这里先手动建一个
  const created = await fetchSelf(
    authRequest(user, "/api/mailbox", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ localPart: user.username }),
    })
  )
  expect(created.status).toBe(201)
  const all = await listMailboxes(user)
  const mb = all.find((m) => m.address === `${user.username}@doulor.cn`)
  expect(mb).toBeTruthy()
  return mb!
}

describe("转发目标验证状态", () => {
  it("PUT 保存后，响应里的 forwardingVerified 必须是已验证的 true 而非 null", async () => {
    const user = await makeUser()
    const target = `t${Date.now()}@example.com`
    await markVerified(user.id, target)
    const mb = await primaryMailbox(user)

    const res = await updateForwarding(user, mb.id, [target])
    expect(res.status).toBe(200)
    const { mailbox, forwardingStatus } = await res.json<{
      mailbox: MailboxPublic
      forwardingStatus: { email: string; verified: boolean }[]
    }>()

    // forwardingStatus 是前端 toast 的依据，本就正确
    expect(forwardingStatus).toEqual([{ email: target, verified: true }])
    // ⚠️ Bug 复现点：mailbox.forwardingVerified 全是 null → 前端主列表
    // 用 every(v => v === true) 判定，null 会把「已转发」打成「转发待验证」
    expect(mailbox.forwardingTo).toEqual([target])
    expect(mailbox.forwardingVerified).toEqual([true])
  })

  it("GET 列表的验证状态保持正常（对照组：确认验证后变绿的那条路径）", async () => {
    const user = await makeUser()
    const target = `g${Date.now()}@example.com`
    await markVerified(user.id, target)
    const mb = await primaryMailbox(user)
    await updateForwarding(user, mb.id, [target])

    const all = await listMailboxes(user)
    const got = all.find((m) => m.id === mb.id)!
    expect(got.forwardingVerified).toEqual([true])
  })

  it("重复目标应去重：[t@x, t@x] 只存一份（修复前会存两份并重复转发）", async () => {
    const user = await makeUser()
    const target = `d${Date.now()}@example.com`
    await markVerified(user.id, target)
    const mb = await primaryMailbox(user)

    const res = await updateForwarding(user, mb.id, [target, target])
    expect(res.status).toBe(200)
    const { mailbox } = await res.json<{ mailbox: MailboxPublic }>()
    // 期望去重后只存一份；当前实现会原样存两份（邮件将被重复转发）
    expect(mailbox.forwardingTo).toEqual([target])
  })

  it("大小写变体也应去重：[DUP@X, dup@x] 只存一份（保留首例的原始大小写）", async () => {
    const user = await makeUser()
    const target = `c${Date.now()}@example.com`
    await markVerified(user.id, target)
    const mb = await primaryMailbox(user)

    const res = await updateForwarding(user, mb.id, [target.toUpperCase(), target])
    expect(res.status).toBe(200)
    const { mailbox } = await res.json<{ mailbox: MailboxPublic }>()
    // 去重按 toLowerCase 比对（与 verifiedSet 口径一致），存库保留首例的原始大小写
    expect(mailbox.forwardingTo).toEqual([target.toUpperCase()])
    // 验证状态判定走小写口径，所以仍能命中已验证记录
    expect(mailbox.forwardingVerified).toEqual([true])
  })

  it("重复验证码验证是幂等的（重复绑定同一目标无需再验证 = 设计行为）", async () => {
    const user = await makeUser()
    const target = `r${Date.now()}@example.com`
    await markVerified(user.id, target)
    await markVerified(user.id, target)

    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM forwarding_verifications WHERE user_id = ? AND target_email = ?"
    ).bind(user.id, target).first<{ c: number }>()
    expect(rows?.c).toBe(1)
  })
})
