/**
 * 站内互发（mailbox → mailbox）。
 *
 * 背景：2026-10-08 移除了依赖 Cloudflare Email Sending（付费）的「对外发信」，
 * 改为只支持**站内互发** —— 信不出门，直接落对方收件箱，不需要任何付费通道。
 *
 * 本测试钉住几条收口线（这些都是安全边界，改动时不能松）：
 *   1. 正常站内互发：信真的进到对方收件箱，且发件地址是发件邮箱本身；
 *   2. 收件人必须是本站域名 —— 外部地址一律拒绝（否则就是开放中继）；
 *   3. 收件邮箱必须已存在 —— 不存在报错，不静默吞信；
 *   4. 发件邮箱必须是自己的 —— 不能拿别人的邮箱发信；
 *   5. 正文不能为空。
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

async function send(
  user: TestUser,
  mailboxId: string,
  payload: { to: string; subject?: string; text: string; from?: string }
): Promise<Response> {
  return fetchSelf(
    authRequest(user, `/api/mailbox/${mailboxId}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  )
}

async function inboxOf(mailboxId: string) {
  return (
    await env.DB.prepare(
      "SELECT from_address, subject, text_body, read FROM messages WHERE mailbox_id = ? ORDER BY received_at DESC"
    )
      .bind(mailboxId)
      .all<{ from_address: string; subject: string; text_body: string; read: number }>()
  ).results ?? []
}

describe("站内互发", () => {
  it("A → B：信进到 B 的收件箱，发件地址是 A 的邮箱", async () => {
    const a = await makeUser()
    const b = await makeUser()
    const aBox = await seedMailbox(a, "alice")
    const bBox = await seedMailbox(b, "bob")

    const res = await send(a, aBox, {
      to: `bob@${ROOT()}`,
      subject: "你好",
      text: "这是一封站内信",
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; to: string }
    expect(body.ok).toBe(true)
    expect(body.to).toBe(`bob@${ROOT()}`)

    const inbox = await inboxOf(bBox)
    expect(inbox.length).toBe(1)
    expect(inbox[0].from_address).toBe(`alice@${ROOT()}`)
    expect(inbox[0].subject).toBe("你好")
    expect(inbox[0].text_body).toBe("这是一封站内信")
    expect(inbox[0].read).toBe(0) // 新信默认未读
  })

  it("发件地址由服务端推导：body 里塞 from 也不生效", async () => {
    const a = await makeUser()
    const b = await makeUser()
    const aBox = await seedMailbox(a, "alice2")
    const bBox = await seedMailbox(b, "bob2")

    const res = await send(a, aBox, {
      to: `bob2@${ROOT()}`,
      text: "hi",
      from: "ceo@evil.com", // 伪造发件人，应被忽略
    })
    expect(res.status).toBe(200)
    const inbox = await inboxOf(bBox)
    expect(inbox[0].from_address).toBe(`alice2@${ROOT()}`)
  })

  it("外部地址被拒（400 NOT_INTERNAL）", async () => {
    const a = await makeUser()
    const aBox = await seedMailbox(a, "alice3")
    const res = await send(a, aBox, { to: "someone@example.com", text: "hi" })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code?: string }
    expect(body.code).toBe("NOT_INTERNAL")
  })

  it("收件邮箱不存在 → 404（不静默吞信）", async () => {
    const a = await makeUser()
    const aBox = await seedMailbox(a, "alice4")
    const res = await send(a, aBox, { to: `nobody-${Date.now()}@${ROOT()}`, text: "hi" })
    expect(res.status).toBe(404)
  })

  it("收件地址格式非法 → 400", async () => {
    const a = await makeUser()
    const aBox = await seedMailbox(a, "alice5")
    const res = await send(a, aBox, { to: "not-an-email", text: "hi" })
    expect(res.status).toBe(400)
  })

  it("不能拿别人的邮箱发信 → 404", async () => {
    const a = await makeUser()
    const b = await makeUser()
    await seedMailbox(a, "alice6")
    const bBox = await seedMailbox(b, "bob6")

    // a 用 b 的 mailboxId 发信
    const res = await send(a, bBox, { to: `alice6@${ROOT()}`, text: "hi" })
    expect(res.status).toBe(404)
  })

  it("空正文 → 400", async () => {
    const a = await makeUser()
    const b = await makeUser()
    const aBox = await seedMailbox(a, "alice7")
    await seedMailbox(b, "bob7")
    const res = await send(a, aBox, { to: `bob7@${ROOT()}`, text: "   " })
    expect(res.status).toBe(400)
  })

  it("大小写不敏感：收件地址 BOB@ 也能投到 bob@", async () => {
    const a = await makeUser()
    const b = await makeUser()
    const aBox = await seedMailbox(a, "alice8")
    const bBox = await seedMailbox(b, "bob8")
    const res = await send(a, aBox, { to: `BOB8@${env.ROOT_DOMAIN.toUpperCase()}`, text: "hi" })
    expect(res.status).toBe(200)
    expect((await inboxOf(bBox)).length).toBe(1)
  })
})
