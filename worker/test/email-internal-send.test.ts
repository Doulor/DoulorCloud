/**
 * 站内互发 + 对外发信（`POST /api/mailbox/:id/send`）。
 *
 * 2026-10-08 曾把「对外发信」整条移除（当时依赖付费的 CF Email Sending），
 * 2026-11-08 随着 cf-send 通道上线重新打通：收件人是本站根域 → 直接落库（不出门）；
 * 否则走发信通道链（Brevo → CF Send），与系统通知共用同一份额度。
 *
 * 本测试钉住几条收口线（这些都是安全边界，改动时不能松）：
 *   1. 正常站内互发：信真的进到对方收件箱，且发件地址是发件邮箱本身；
 *   2. 站内信不出门：走对外通道的发送**不会**在本站留收件箱行；
 *   3. 对外发信只允许从**已认证的发信域名**（ROOT_DOMAIN）发出；
 *   4. 对外发信有每人每日上限，0 = 关闭；
 *   5. 收件邮箱必须已存在；发件邮箱必须是自己的；正文不能为空（站内路径）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, setSetting, type TestUser } from "./helpers"
import { uuid } from "../src/crypto"

const ROOT = () => env.ROOT_DOMAIN.toLowerCase()

/** 打桩出站 fetch：记录发往 Brevo 的发信请求（对外发信用例用） */
let brevoPosts: { to: string; from: string; replyTo?: string }[] = []
let restoreFetch: (() => void) | null = null

function stubOutbound(): void {
  const original = globalThis.fetch
  brevoPosts = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.includes("api.brevo.com/v3/account")) {
      return new Response(
        JSON.stringify({ plan: [{ type: "free", credits: 100, creditsType: "sendLimit" }] }),
        { status: 200 }
      )
    }
    if (url.includes("api.brevo.com/v3/smtp/email")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        to?: { email: string }[]
        sender?: { email: string }
        replyTo?: { email: string }
      }
      brevoPosts.push({
        to: body.to?.[0]?.email ?? "",
        from: body.sender?.email ?? "",
        replyTo: body.replyTo?.email,
      })
      return new Response(JSON.stringify({ messageId: "ok" }), { status: 200 })
    }
    return original(input as RequestInfo, init)
  }) as unknown as typeof fetch
  restoreFetch = () => {
    globalThis.fetch = original
  }
}

beforeEach(async () => {
  stubOutbound()
  // 对外发信只留 brevo（测试里打桩），避免真的去请求 Cloudflare
  await setSetting("mail_transport_order", "brevo")
  await setSetting("mail_cf_targets", "")
  await setSetting("brevo_api_key", "k-mailbox-external")
  await setSetting("brevo_sender_email", "no-reply@doulor.cn")
  await setSetting("mailbox_external_daily_limit", "20")
})

afterEach(() => {
  restoreFetch?.()
  restoreFetch = null
})

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

describe("对外发信（站外收件人）", () => {
  it("发往站外 → 走发信通道真正寄出，且不在本站留收件箱行", async () => {
    const a = await makeUser()
    const aBox = await seedMailbox(a, "ext1")

    const res = await send(a, aBox, {
      to: "someone@example.com",
      subject: "打招呼",
      text: "你好呀",
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; external?: boolean }
    expect(body.ok).toBe(true)
    expect(body.external).toBe(true)

    // 发件人 = **用户自己的邮箱**（不是站点通用地址），回信地址也是它
    expect(brevoPosts).toEqual([
      { to: "someone@example.com", from: `ext1@${ROOT()}`, replyTo: `ext1@${ROOT()}` },
    ])
    // 站外信不落本站收件箱
    expect((await inboxOf(aBox)).length).toBe(0)
  })

  it("发件人由服务端从邮箱推导：body 里塞 from 不生效（不能冒充别人）", async () => {
    const a = await makeUser()
    const aBox = await seedMailbox(a, "ext4")
    await send(a, aBox, { to: "outside@example.com", text: "hi", from: "ceo@evil.com" })
    expect(brevoPosts[0].from).toBe(`ext4@${ROOT()}`)
  })

  it("只在做过发信认证的主域名下才能外发：自定义根域的邮箱 → 400", async () => {
    const a = await makeUser()
    const id = uuid()
    // 直接塞一条不属于 ROOT_DOMAIN 的邮箱（模拟用户绑定的自定义域名邮箱）
    await env.DB.prepare(
      "INSERT INTO mailboxes (id, user_id, address, created_at) VALUES (?, ?, ?, ?)"
    )
      .bind(id, a.id, "someone@other-domain.test", new Date().toISOString())
      .run()

    const res = await send(a, id, { to: "outside@example.com", text: "hi" })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code?: string }).code).toBe("SENDER_DOMAIN_NOT_SUPPORTED")
    expect(brevoPosts.length).toBe(0)
  })

  it("每日上限为 0 → 关闭对外发信（403）", async () => {
    await setSetting("mailbox_external_daily_limit", "0")
    const a = await makeUser()
    const aBox = await seedMailbox(a, "ext2")

    const res = await send(a, aBox, { to: "someone@example.com", text: "hi" })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { code?: string }).code).toBe("EXTERNAL_SEND_DISABLED")
    await setSetting("mailbox_external_daily_limit", "20")
  })

  it("超出每日上限 → 429，且不再发信", async () => {
    await setSetting("mailbox_external_daily_limit", "1")
    const a = await makeUser()
    const aBox = await seedMailbox(a, "ext3")

    const first = await send(a, aBox, { to: "one@example.com", text: "hi" })
    expect(first.status).toBe(200)

    const second = await send(a, aBox, { to: "two@example.com", text: "hi" })
    expect(second.status).toBe(429)
    expect(brevoPosts.length).toBe(1) // 第二封根本没用发出
    await setSetting("mailbox_external_daily_limit", "20")
  })
})
