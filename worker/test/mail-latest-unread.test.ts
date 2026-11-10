/**
 * GET /api/mailbox/latest-unread —— 新邮件系统通知的数据源。
 *
 * 前端每 60 秒轮询这一条接口来决定"要不要弹通知"，所以它必须：
 *   1. 只返回**自己的**未读（别人的邮件不能漏过来）；
 *   2. 只返回**一封**（最新的）—— 弹窗只播报一条，多了会刷屏；
 *   3. 没有未读时返回 `null`（而不是空对象，前端据此判断"没新信"）；
 *   4. 标题优先用人名（`Name <addr>` 里的 Name），没有就退回地址。
 */
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, type TestUser } from "./helpers"
import { uuid } from "../src/crypto"

const ROOT = () => env.ROOT_DOMAIN.toLowerCase()

async function seedMailbox(user: TestUser, local: string): Promise<string> {
  const id = uuid()
  await env.DB.prepare(
    "INSERT INTO mailboxes (id, user_id, address, created_at) VALUES (?, ?, ?, ?)"
  )
    .bind(id, user.id, `${local}@${ROOT()}`, new Date().toISOString())
    .run()
  return id
}

async function seedMessage(
  mailboxId: string,
  args: { from: string; subject: string; read?: number; at?: string }
): Promise<string> {
  const id = uuid()
  await env.DB.prepare(
    `INSERT INTO messages (id, mailbox_id, from_address, subject, text_body, read, received_at)
     VALUES (?, ?, ?, ?, 'body', ?, ?)`
  )
    .bind(
      id,
      mailboxId,
      args.from,
      args.subject,
      args.read ?? 0,
      args.at ?? new Date().toISOString()
    )
    .run()
  return id
}

async function latest(user: TestUser, lang = "zh") {
  const res = await fetchSelf(
    authRequest(user, `/api/mailbox/latest-unread?lang=${lang}`)
  )
  expect(res.status).toBe(200)
  return (await res.json()) as {
    id: string
    title: string
    body: string
    link: string
    mailbox: string
  } | null
}

describe("最新未读邮件（通知数据源）", () => {
  it("没有未读 → null", async () => {
    const u = await makeUser()
    await seedMailbox(u, `nu_${Math.random().toString(36).slice(2, 7)}`)
    expect(await latest(u)).toBeNull()
  })

  it("有未读 → 返回最新那封，标题带人名、正文是主题", async () => {
    const u = await makeUser()
    const local = `n1_${Math.random().toString(36).slice(2, 7)}`
    const box = await seedMailbox(u, local)
    await seedMessage(box, {
      from: "Old Sender <old@example.com>",
      subject: "旧邮件",
      at: "2026-01-01T00:00:00.000Z",
    })
    const newest = await seedMessage(box, {
      from: "GitHub <noreply@github.com>",
      subject: "你有一条新的安全提醒",
      at: "2026-02-01T00:00:00.000Z",
    })

    const item = await latest(u)
    expect(item?.id).toBe(`mail:${newest}`)
    expect(item?.title).toContain("GitHub")
    expect(item?.body).toBe("你有一条新的安全提醒")
    expect(item?.link).toBe("/dashboard/email")
    expect(item?.mailbox).toBe(`${local}@${ROOT()}`)
  })

  it("已读的不算（read=1 不触发通知）", async () => {
    const u = await makeUser()
    const box = await seedMailbox(u, `r1_${Math.random().toString(36).slice(2, 7)}`)
    await seedMessage(box, { from: "a@example.com", subject: "已读", read: 1 })
    expect(await latest(u)).toBeNull()
  })

  it("看不到别人的邮件", async () => {
    const a = await makeUser()
    const b = await makeUser()
    const aBox = await seedMailbox(a, `x1_${Math.random().toString(36).slice(2, 7)}`)
    await seedMessage(aBox, { from: "someone@example.com", subject: "A 的信" })

    expect(await latest(b)).toBeNull()
    expect((await latest(a))?.body).toBe("A 的信")
  })

  it("只有裸地址时标题退回地址本身", async () => {
    const u = await makeUser()
    const box = await seedMailbox(u, `n2_${Math.random().toString(36).slice(2, 7)}`)
    await seedMessage(box, { from: "plain@example.com", subject: "hi" })
    expect((await latest(u))?.title).toContain("plain@example.com")
  })

  it("英文界面走英文文案", async () => {
    const u = await makeUser()
    const box = await seedMailbox(u, `n3_${Math.random().toString(36).slice(2, 7)}`)
    await seedMessage(box, { from: "GitHub <noreply@github.com>", subject: "Security alert" })
    const item = await latest(u, "en")
    expect(item?.title).toMatch(/^New mail from/)
  })
})
