// Posta 通道的请求载荷（回归测试）。
//
// 契约来源：Posta 的 OpenAPI（实例 /openapi.json → POST /api/v1/emails/send）：
//   Authorization: Bearer <api-key>
//   { from, to: string[], subject, text?, html? }
// `html` 是一等字段 —— renderMail 的卡片样式在 Posta 通道直接生效
// （2026-09-27 Posthorn 时代 html 会被当未知字段拼进正文，换 Posta 后不存在该问题）。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { setSetting } from "./helpers"
import { sendMail, MAIL_FROM, MAIL_FROM_NAME } from "../src/mailer"

let captured: Record<string, unknown> | null = null
let capturedUrl = ""
let restoreFetch: (() => void) | null = null

beforeEach(async () => {
  captured = null
  capturedUrl = ""
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.includes("posta.test")) {
      capturedUrl = url
      captured = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
      return new Response(
        JSON.stringify({ success: true, data: { id: "x", status: "queued" } }),
        { status: 200 }
      )
    }
    return original(input as RequestInfo, init)
  }) as unknown as typeof fetch
  restoreFetch = () => {
    globalThis.fetch = original
  }

  await setSetting("posta_url", "https://posta.test")
  await setSetting("posta_key", "psk_test")
  await setSetting("mail_transport_order", "posta")
  // 清掉 CF 白名单，确保这封信真的走 Posta 而不是被 CF 截胡
  await setSetting("mail_cf_targets", "")
})

afterEach(() => {
  restoreFetch?.()
  restoreFetch = null
})

describe("Posta 发信载荷", () => {
  it("POST {基础地址}/api/v1/emails/send，from/to/subject/text/html 按契约传递", async () => {
    await setSetting("posta_from", "Test Sender <test@posta.test>")
    await sendMail(env, {
      to: "someone@example.com",
      subject: "标题",
      text: "正文文字",
      html: "<p>正文</p>",
    })

    expect(capturedUrl).toBe("https://posta.test/api/v1/emails/send")
    expect(captured).not.toBeNull()
    expect((captured as Record<string, unknown>).from).toBe("Test Sender <test@posta.test>")
    expect((captured as Record<string, unknown>).to).toEqual(["someone@example.com"])
    expect((captured as Record<string, unknown>).subject).toBe("标题")
    expect((captured as Record<string, unknown>).text).toBe("正文文字")
    expect((captured as Record<string, unknown>).html).toBe("<p>正文</p>")
  })

  it("未配置发件人时回落默认值（QQ SMTP 要求 MAIL FROM = 登录账号）", async () => {
    await sendMail(env, { to: "a@example.com", subject: "s", text: "t" })
    expect((captured as Record<string, unknown>).from).toBe(
      "Doulor Cloud <DoulorCloud@foxmail.com>"
    )
    expect((captured as Record<string, unknown>).html).toBeUndefined()
  })
})
