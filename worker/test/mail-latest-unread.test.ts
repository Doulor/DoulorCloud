/**
 * GET /api/mailbox/latest-unread —— 新邮件系统通知的数据源。
 *
 * 前端每 60 秒轮询这一条接口来决定"要不要弹通知"，所以它必须：
 *   1. 只返回**自己的**未读（别人的邮件不能漏过来）；
 *   2. 只返回**一封**（最新的）—— 弹窗只播报一条，多了会刷屏；
 *   3. 没有未读时返回 `null`（而不是空对象，前端据此判断"没新信"）；
 *   4. 🔒 `title` 是**固定文案**、不含任何邮件内容（2026-11-10 渗透测试 finding #3：
 *      修复前标题是 `${From 显示名} 发来一封邮件` —— 任何能给受害者平台邮箱直投 SMTP
 *      的人，都能弹一条 "Doulor Cloud Security Center 发来一封邮件" 做通知钓鱼）；
 *   5. 邮件内容只出现在**消毒后**的 `body`（`发件人：主题`）里。
 */
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, type TestUser } from "./helpers"
import { uuid } from "../src/crypto"

const ROOT = () => env.ROOT_DOMAIN.toLowerCase()

/** 固定标题文案（服务端就这两个常量，前端不需要也不应该自己拼） */
const TITLE_ZH = "新邮件提醒 · Doulor Cloud"
const TITLE_EN = "New mail · Doulor Cloud"

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

  it("有未读 → 返回最新那封，标题是固定文案、正文是「发件人：主题」", async () => {
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
    // 标题不再带任何邮件内容（finding #3 的修复点）
    expect(item?.title).toBe(TITLE_ZH)
    expect(item?.title).not.toContain("GitHub")
    // 人名与主题都还在，用户才认得出"是谁、什么事"
    expect(item?.body).toBe("GitHub：你有一条新的安全提醒")
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
    expect((await latest(a))?.body).toBe("someone@example.com：A 的信")
  })

  it("只有裸地址时，正文里是地址本身（标题仍是固定文案）", async () => {
    const u = await makeUser()
    const box = await seedMailbox(u, `n2_${Math.random().toString(36).slice(2, 7)}`)
    await seedMessage(box, { from: "plain@example.com", subject: "hi" })
    const item = await latest(u)
    expect(item?.title).toBe(TITLE_ZH)
    expect(item?.body).toBe("plain@example.com：hi")
  })

  it("英文界面走英文文案", async () => {
    const u = await makeUser()
    const box = await seedMailbox(u, `n3_${Math.random().toString(36).slice(2, 7)}`)
    await seedMessage(box, { from: "GitHub <noreply@github.com>", subject: "Security alert" })
    const item = await latest(u, "en")
    expect(item?.title).toBe(TITLE_EN)
    expect(item?.body).toBe("GitHub: Security alert")
  })

  /**
   * 注入用例（finding #3，2026-11-10）。
   *
   * 攻击面：任何人都能给受害者的平台邮箱直投 SMTP，From 显示名与 Subject 全由他写。
   * 修复前这两段会原样变成系统通知的**标题与正文** —— 标题里出现
   * "Doulor Cloud Security Center 发来一封邮件"，就是一条足以骗到人的通知钓鱼。
   */
  it("注入用例：From 显示名 / Subject 里的标记与链接进不了标题，正文不留尖括号", async () => {
    const u = await makeUser()
    const box = await seedMailbox(u, `inj_${Math.random().toString(36).slice(2, 7)}`)
    const id = await seedMessage(box, {
      from: "Doulor Cloud Security Center <x@evil.test>",
      subject: "<img src=x onerror=alert(9)> https://evil.example/phish",
    })

    const item = await latest(u)
    expect(item).not.toBeNull()

    // 1) 标题必须**完全等于**固定文案：一个字符都不能来自邮件
    expect(item?.title).toBe(TITLE_ZH)
    expect(item?.title).not.toContain("Security Center")
    expect(item?.title).not.toContain("evil")

    // 2) 正文里不能残留会被当成标签 / 标记的尖括号
    expect(item?.body).not.toContain("<")
    expect(item?.body).not.toContain(">")
    // 但仍要保留"谁发的、什么事"——否则通知就没有任何信息量了
    expect(item?.body).toContain("Doulor Cloud Security Center")
    expect(item?.body).toContain("https://evil.example/phish")

    // 3) id / link 语义不变（前端靠 id 去重、靠 link 跳转）
    expect(item?.id).toBe(`mail:${id}`)
    expect(item?.link).toBe("/dashboard/email")
  })
})
