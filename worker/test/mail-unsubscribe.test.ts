// 邮件模板规范化 + 一键退订（RFC 8058）。
//
// 覆盖：
//   1. renderMail：转义、按钮只收 http(s)、按类别生成页脚 / 退订头、旧的「第三参数传验证码」兼容
//   2. 退订签名：往返通过；改 uid / 改类别 / 改签名都失败
//   3. GET 只出确认页、不改库（防邮件安全网关预取链接误退订）
//   4. POST 执行退订（含跨站来源的 One-Click 请求不被 CSRF 层拦掉）
//   5. 公告群发每封都带 List-Unsubscribe 头，且链接属于该收件人
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, fetchSelf, setSetting } from "./helpers"
import { renderMail } from "../src/mailer"
import { unsubscribeUrl, verifyUnsubscribe } from "../src/mail-unsubscribe"
import { runAnnouncementMailJob } from "../src/handlers/announcements"
import { uuid } from "../src/crypto"

async function readFlags(id: string) {
  return env.DB.prepare("SELECT notify_enabled, notify_announcements FROM users WHERE id = ?")
    .bind(id)
    .first<{ notify_enabled: number; notify_announcements: number }>()
}

describe("renderMail", () => {
  it("正文与标题被转义，正文里的 URL 不会变成可点链接", () => {
    const { html } = renderMail("<b>标题</b>", ['<a href="https://evil.example">点我</a>'])
    expect(html).not.toContain('<a href="https://evil.example"')
    expect(html).toContain("&lt;b&gt;标题&lt;/b&gt;")
  })

  it("规范的 HTML 骨架：lang / charset / viewport / title / 预览摘要", () => {
    const { html } = renderMail("标题", ["第一段正文"])
    expect(html).toContain('<html lang="zh-CN">')
    expect(html).toContain('<meta charset="utf-8">')
    expect(html).toContain('name="viewport"')
    expect(html).toContain("<title>标题</title>")
    expect(html).toMatch(/display:none[^>]*>第一段正文/)
  })

  it("action 生成按钮 + 备用链接；纯文本版也带完整地址", () => {
    const url = "https://cloud.doulor.cn/dashboard/feedback"
    const { html, text } = renderMail("t", ["p"], { action: { label: "去看看", url } })
    expect(html).toContain(`href="${url}"`)
    expect(html).toContain("按钮无法点击")
    expect(text).toContain(`去看看：${url}`)
  })

  it("非 http(s) 的 action 被丢弃", () => {
    const { html } = renderMail("t", ["p"], { action: { label: "x", url: "javascript:alert(1)" } })
    expect(html).not.toContain("javascript:")
  })

  it("事务邮件：无退订、无 List-Unsubscribe，但有 Auto-Submitted", () => {
    const m = renderMail("t", ["p"], { code: "123456" })
    expect(m.headers["Auto-Submitted"]).toBe("auto-generated")
    expect(m.headers["List-Unsubscribe"]).toBeUndefined()
    expect(m.html).not.toContain(">退订<")
    expect(m.text).toContain("验证码：123456")
    expect(m.text).toContain("无法退订")
  })

  it("旧用法：第三个参数直接传验证码字符串", () => {
    const m = renderMail("t", ["p"], "654321")
    expect(m.html).toContain("654321")
    expect(m.text).toContain("验证码：654321")
  })

  it("通知邮件 + 退订地址：页脚有退订链接，并生成 RFC 8058 头", () => {
    const unsub = "https://cloud.doulor.cn/api/mail/unsubscribe?u=1&c=personal&s=x"
    const m = renderMail("t", ["p"], { kind: "notification", unsubscribeUrl: unsub })
    expect(m.headers["List-Unsubscribe"]).toBe(`<${unsub}>`)
    expect(m.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click")
    expect(m.html).toContain(">退订<")
    expect(m.html).toContain("通知设置")
    expect(m.text).toContain("个人通知")
  })

  it("管理员通知：页脚指向管理面板", () => {
    const m = renderMail("t", ["p"], { kind: "admin" })
    expect(m.html).toContain("/dashboard/admin")
    expect(m.headers["List-Unsubscribe"]).toBeUndefined()
  })
})

describe("退订签名", () => {
  it("往返通过；篡改任一参数都失败", async () => {
    const url = new URL((await unsubscribeUrl(env, "user-1", "announcements"))!)
    expect(url.origin).toBe("https://cloud.doulor.cn")
    expect(await verifyUnsubscribe(env, url.searchParams)).toEqual({
      uid: "user-1",
      cat: "announcements",
    })

    const otherUser = new URLSearchParams(url.searchParams)
    otherUser.set("u", "user-2")
    expect(await verifyUnsubscribe(env, otherUser)).toBeNull()

    const otherCat = new URLSearchParams(url.searchParams)
    otherCat.set("c", "personal")
    expect(await verifyUnsubscribe(env, otherCat)).toBeNull()

    const badSig = new URLSearchParams(url.searchParams)
    badSig.set("s", "AAAAAAAAAAAAAAAAAAAAAA")
    expect(await verifyUnsubscribe(env, badSig)).toBeNull()

    const badCat = new URLSearchParams(url.searchParams)
    badCat.set("c", "transactional")
    expect(await verifyUnsubscribe(env, badCat)).toBeNull()
  })
})

describe("GET/POST /api/mail/unsubscribe", () => {
  it("GET 只出确认页，不改库", async () => {
    const u = await makeUser()
    const link = (await unsubscribeUrl(env, u.id, "announcements"))!
    const res = await fetchSelf(new Request(link))
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toContain("text/html")
    const html = await res.text()
    expect(html).toContain('method="post"')
    expect(html).toContain("站点公告邮件")
    expect((await readFlags(u.id))?.notify_announcements).toBe(1)
  })

  it("签名不对 → 400 页面", async () => {
    const res = await fetchSelf(
      new Request("https://cloud.doulor.cn/api/mail/unsubscribe?u=x&c=personal&s=bad")
    )
    expect(res.status).toBe(400)
    expect(await res.text()).toContain("链接无效")
  })

  it("One-Click POST（邮件客户端跨站发起）关闭对应开关，另一个开关不受影响", async () => {
    const u = await makeUser()
    const link = (await unsubscribeUrl(env, u.id, "personal"))!
    const res = await fetchSelf(
      new Request(link, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Sec-Fetch-Site": "cross-site",
          Origin: "https://mail.google.com",
        },
        body: "List-Unsubscribe=One-Click",
      })
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("已退订")
    const flags = await readFlags(u.id)
    expect(flags?.notify_enabled).toBe(0)
    expect(flags?.notify_announcements).toBe(1)
  })

  it("POST 签名不对 → 400 且不改库", async () => {
    const u = await makeUser()
    const res = await fetchSelf(
      new Request(
        `https://cloud.doulor.cn/api/mail/unsubscribe?u=${u.id}&c=announcements&s=AAAAAAAAAAAAAAAAAAAAAA`,
        { method: "POST", body: "List-Unsubscribe=One-Click" }
      )
    )
    expect(res.status).toBe(400)
    expect((await readFlags(u.id))?.notify_announcements).toBe(1)
  })
})

describe("公告群发带退订头", () => {
  let captured: { to: string; headers?: Record<string, string>; html?: string }[] = []
  let restore: (() => void) | null = null

  beforeEach(async () => {
    captured = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url.includes("/email/sending/send")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          to: { address: string }[]
          headers?: Record<string, string>
          html?: string
        }
        const to = body.to[0].address
        captured.push({ to, headers: body.headers, html: body.html })
        return new Response(
          JSON.stringify({ success: true, result: { delivered: [to], permanent_bounces: [], queued: [] } }),
          { status: 200 }
        )
      }
      return original(input as RequestInfo, init)
    }) as unknown as typeof fetch
    restore = () => {
      globalThis.fetch = original
    }
    await setSetting("mail_transport_order", "cf-send")
    await setSetting("announcement_mail_transport", "cf-send")
    await setSetting("mail_cf_targets", "")
    await setSetting("cf_send_from", "no-reply@doulor.cn")
  })

  afterEach(() => {
    restore?.()
    restore = null
  })

  it("每封都带属于该收件人的 List-Unsubscribe，点进去能退订公告", async () => {
    const u = await makeUser()
    const email = `${u.username}@doulor.cn`
    const annId = uuid()
    const now = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO announcements
         (id, title, body, category, pinned, popup_mode, created_at, mail_status, mail_total, mail_sent, mail_failed)
       VALUES (?, '退订测试', '正文', 'general', 0, 'none', ?, 'sending', 1, 0, 0)`
    )
      .bind(annId, now)
      .run()
    await env.DB.prepare(
      `INSERT INTO announcement_mail_queue (id, announcement_id, user_id, email, status, attempts, created_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?)`
    )
      .bind(uuid(), annId, u.id, email, now)
      .run()

    await runAnnouncementMailJob(env, annId)

    const mail = captured.find((c) => c.to === email)
    expect(mail).toBeTruthy()
    expect(mail!.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click")
    const m = /^<(https:\/\/[^>]+)>$/.exec(mail!.headers?.["List-Unsubscribe"] ?? "")
    expect(m).not.toBeNull()
    expect(mail!.html).toContain("/dashboard/messages/site")

    const params = new URL(m![1]).searchParams
    expect(await verifyUnsubscribe(env, params)).toEqual({ uid: u.id, cat: "announcements" })

    const res = await fetchSelf(new Request(m![1], { method: "POST", body: "List-Unsubscribe=One-Click" }))
    expect(res.status).toBe(200)
    expect((await readFlags(u.id))?.notify_announcements).toBe(0)
  })
})
