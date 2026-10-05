/**
 * 回归：邮箱批量删除 ≥100 条。
 *
 * 缺陷原状（2026-10-05 用户 onevergiveapu 反馈「批量删除 ≥100 显示内部错误」）：
 * 后端一次性 `DELETE ... WHERE mailbox_id = ? AND id IN (?,?,…)` 最多塞 100 个 id，
 * 加上 mailbox_id 就是 **101 个绑定参数**，超过 D1 单条语句 100 个参数的上限 ⇒ 500。
 * 修复：按 99 个一批切分删除、累加删除数。
 *
 * 本测试钉住两条线：
 *   1. 恰好 100 条（旧实现必挂）→ 能删掉；
 *   2. 150 条（跨多个分批）→ 全部删掉且 deleted 计数正确。
 */
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, type TestUser } from "./helpers"
import { uuid } from "../src/crypto"

async function seedMailbox(): Promise<{ user: TestUser; mailboxId: string }> {
  const user = await makeUser()
  const mailboxId = uuid()
  await env.DB.prepare(
    "INSERT INTO mailboxes (id, user_id, address, created_at) VALUES (?, ?, ?, ?)"
  )
    .bind(
      mailboxId,
      user.id,
      `${user.username}@${env.ROOT_DOMAIN.toLowerCase()}`,
      new Date().toISOString()
    )
    .run()
  return { user, mailboxId }
}

async function seedMessages(mailboxId: string, n: number): Promise<string[]> {
  const ids: string[] = []
  const now = new Date().toISOString()
  const stmts = []
  for (let i = 0; i < n; i++) {
    const id = uuid()
    ids.push(id)
    stmts.push(
      env.DB.prepare(
        `INSERT INTO messages (id, mailbox_id, from_address, subject, text_body, read, received_at)
         VALUES (?, ?, 'sender@example.com', '主题', '', 0, ?)`
      ).bind(id, mailboxId, now)
    )
  }
  await env.DB.batch(stmts)
  return ids
}

async function batchDelete(
  user: TestUser,
  mailboxId: string,
  ids: string[]
): Promise<Response> {
  return fetchSelf(
    authRequest(user, `/api/mailbox/${mailboxId}/messages/batch-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    })
  )
}

async function countMessages(mailboxId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM messages WHERE mailbox_id = ?")
    .bind(mailboxId)
    .first<{ c: number }>()
  return row?.c ?? 0
}

describe("邮箱批量删除（≥100 条不再 500）", () => {
  it("恰好 100 条 → 全部删除（旧实现会 500）", async () => {
    const { user, mailboxId } = await seedMailbox()
    const ids = await seedMessages(mailboxId, 100)

    const res = await batchDelete(user, mailboxId, ids)
    expect(res.status).toBe(200)
    expect((await res.json<{ deleted: number }>()).deleted).toBe(100)
    expect(await countMessages(mailboxId)).toBe(0)
  })

  it("150 条 → 跨多个分批也全部删除，计数正确", async () => {
    const { user, mailboxId } = await seedMailbox()
    const ids = await seedMessages(mailboxId, 150)

    const res = await batchDelete(user, mailboxId, ids)
    expect(res.status).toBe(200)
    expect((await res.json<{ deleted: number }>()).deleted).toBe(150)
    expect(await countMessages(mailboxId)).toBe(0)
  })

  it("只删属于本邮箱的邮件（带 mailbox_id 守卫，不越权）", async () => {
    const a = await seedMailbox()
    const b = await seedMailbox()
    const aIds = await seedMessages(a.mailboxId, 120)
    const bIds = await seedMessages(b.mailboxId, 5)

    // 用 A 的身份、带 A 的 mailboxId，但混入 B 的 id：B 的邮件不该被删
    const res = await batchDelete(a.user, a.mailboxId, [...aIds, ...bIds])
    expect(res.status).toBe(200)
    expect((await res.json<{ deleted: number }>()).deleted).toBe(120)
    expect(await countMessages(a.mailboxId)).toBe(0)
    expect(await countMessages(b.mailboxId)).toBe(5)
  })
})
