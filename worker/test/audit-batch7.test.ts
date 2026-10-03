/**
 * 回归测试：M16 邮件列表游标分页。
 *
 * 缺陷原状（2026-09-25 审计）：`GET /api/mailbox/:id/messages` 写死
 * `ORDER BY received_at DESC LIMIT 100`，**没有游标也不告知截断** ——
 * 收件箱超过 100 封之后，旧邮件在界面上永久不可达。
 *
 * ⚠️ 这个测试的重点不是「能翻页」，而是「**同一时间戳上的邮件不会被整批跳过**」：
 *   邮件是**批量到达**的（同一次投递 / 导入的时间戳完全相同），所以
 *   「用上一页最后一个 received_at 当游标」这种看似够用的写法，
 *   只要某一批的条数超过每页条数，就会把该批剩下的邮件**整批丢掉**。
 *   测试里特意让第一批（15 封）**大于**每页条数（10），把这条路径钉住。
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

async function seedMessage(
  mailboxId: string,
  id: string,
  receivedAt: string
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO messages (id, mailbox_id, from_address, subject, text_body, read, received_at)
     VALUES (?, ?, 'sender@example.com', '主题', '', 0, ?)`
  )
    .bind(id, mailboxId, receivedAt)
    .run()
}

async function fetchPage(
  user: TestUser,
  mailboxId: string,
  limit: number,
  cursor?: string | null
): Promise<{ messages: { id: string }[]; nextCursor: string | null }> {
  const qs = new URLSearchParams({ limit: String(limit) })
  if (cursor) qs.set("cursor", cursor)
  const res = await fetchSelf(
    authRequest(user, `/api/mailbox/${mailboxId}/messages?${qs.toString()}`)
  )
  expect(res.status).toBe(200)
  return (await res.json()) as { messages: { id: string }[]; nextCursor: string | null }
}

/** 从第一页开始一直翻到底，返回所有 id（按返回顺序） */
async function fetchAll(
  user: TestUser,
  mailboxId: string,
  limit: number,
  maxPages = 20
): Promise<{ ids: string[]; pages: number; lastCursor: string | null }> {
  const ids: string[] = []
  let cursor: string | null = null
  let pages = 0
  for (let i = 0; i < maxPages; i++) {
    const page = await fetchPage(user, mailboxId, limit, cursor)
    pages += 1
    ids.push(...page.messages.map((m) => m.id))
    cursor = page.nextCursor
    if (!cursor) break
  }
  return { ids, pages, lastCursor: cursor }
}

describe("邮件列表游标分页（M16）", () => {
  it("某一批邮件多于每页条数时，翻页不跳过也不重复", async () => {
    const { user, mailboxId } = await seedMailbox()

    // 第一批 15 封（> 每页 10 封，全部同一时间戳），第二批 12 封
    const batches = [
      { at: "2026-09-25T10:00:00.000Z", n: 15 },
      { at: "2026-09-25T09:00:00.000Z", n: 12 },
    ]
    const expected: string[] = []
    for (const b of batches) {
      for (let i = 0; i < b.n; i++) {
        const id = `${b.at}-${String(i).padStart(3, "0")}`
        await seedMessage(mailboxId, id, b.at)
        expected.push(id)
      }
    }
    expect(expected).toHaveLength(27)

    const { ids, pages } = await fetchAll(user, mailboxId, 10)

    // 27 封 / 每页 10 → 10 + 10 + 7 = 3 页
    expect(pages).toBe(3)
    expect(ids).toHaveLength(27)
    // 不重复
    expect(new Set(ids).size).toBe(27)
    // 一封都没丢 —— 单键游标在这里会丢掉第一批剩下的 5 封
    expect([...ids].sort()).toEqual([...expected].sort())

    // 顺序：received_at DESC，同时间戳内 id DESC
    const firstBatch = ids.slice(0, 15)
    expect(firstBatch.every((id) => id.startsWith(batches[0].at))).toBe(true)
    expect(firstBatch).toEqual([...firstBatch].sort().reverse())
  })

  it("每页不满时 nextCursor 为 null（不再谎称还有下一页）", async () => {
    const { user, mailboxId } = await seedMailbox()
    await seedMessage(mailboxId, "m1", "2026-09-25T10:00:00.000Z")
    await seedMessage(mailboxId, "m2", "2026-09-25T09:00:00.000Z")

    const page = await fetchPage(user, mailboxId, 10)
    expect(page.messages).toHaveLength(2)
    expect(page.nextCursor).toBeNull()
  })

  it("恰好取满一页时给出 nextCursor，但下一页为空", async () => {
    const { user, mailboxId } = await seedMailbox()
    for (let i = 0; i < 10; i++) {
      await seedMessage(mailboxId, `x${i}`, `2026-09-25T10:00:0${i}.000Z`)
    }

    const first = await fetchPage(user, mailboxId, 10)
    expect(first.messages).toHaveLength(10)
    expect(first.nextCursor).not.toBeNull()

    // 恰好取满一页时无法区分「刚好到底」和「还有下一页」——保守地给出游标，
    // 再取一次即可确认为空（这也是 community.ts 的既有语义）。
    const second = await fetchPage(user, mailboxId, 10, first.nextCursor)
    expect(second.messages).toHaveLength(0)
    expect(second.nextCursor).toBeNull()
  })

  it("limit 被夹在 1..100 之间（不能靠 limit=99999 拖垮响应）", async () => {
    const { user, mailboxId } = await seedMailbox()
    await seedMessage(mailboxId, "only", "2026-09-25T10:00:00.000Z")

    // 超上限 → 夹到 100（这里只有 1 封，能返回即可）
    const big = await fetchPage(user, mailboxId, 99999)
    expect(big.messages).toHaveLength(1)
    // 0 / 负数 → 夹到 1
    const zero = await fetchPage(user, mailboxId, 0)
    expect(zero.messages).toHaveLength(1)
  })

  it("坏游标被忽略，退回第一页（不 500）", async () => {
    const { user, mailboxId } = await seedMailbox()
    await seedMessage(mailboxId, uuid(), "2026-09-25T10:00:00.000Z")

    const page = await fetchPage(user, mailboxId, 10, "这不是 base64 的 JSON")
    expect(page.messages).toHaveLength(1)
  })
})
