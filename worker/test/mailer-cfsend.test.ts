// `cf-send` 通道（Cloudflare Email Sending REST API）的载荷与错误映射回归测试。
//
// 契约来源：developers.cloudflare.com/email-service/api/send-emails/rest-api/
//   POST /accounts/{account_id}/email/sending/send
//   Authorization: Bearer <API_TOKEN>
//   { to, from: { address, name }, subject, text?, html? }
//
// ⚠️ 两个容易写错、这里专门钉住的点：
//   1. **具名地址的字段名是 `address`**（REST 口径），不是 Workers 绑定的 `email`。
//      写错不会报「字段名错」，而是报 10001 invalid_request_schema —— 很难猜回来。
//   2. **HTTP 200 不代表送达**：真正的结果在 `result.delivered / queued /
//      permanent_bounces` 里。收件人被硬退时照样回 200（与 Brevo「201 + 静默丢弃」
//      同一类坑），所以实现必须看那三个字段。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { setSetting } from "./helpers"
import { sendMail, MAIL_FROM, MAIL_FROM_NAME } from "../src/mailer"

let captured: Record<string, unknown> | null = null
let capturedUrl = ""
let capturedAuth = ""
let responder: () => Response = () => delivered("someone@example.com")
let restoreFetch: (() => void) | null = null

function delivered(address: string) {
  return new Response(
    JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result: { delivered: [address], permanent_bounces: [], queued: [] },
    }),
    { status: 200 }
  )
}

function cfError(status: number, code: number, message: string) {
  return new Response(
    JSON.stringify({ success: false, errors: [{ code, message }], messages: [], result: null }),
    { status }
  )
}

beforeEach(async () => {
  captured = null
  capturedUrl = ""
  capturedAuth = ""
  responder = () => delivered("someone@example.com")

  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.includes("/email/sending/send")) {
      capturedUrl = url
      capturedAuth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "")
      captured = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
      return responder()
    }
    return original(input as RequestInfo, init)
  }) as unknown as typeof fetch
  restoreFetch = () => {
    globalThis.fetch = original
  }

  // 只留 cf-send，确保这封信真的走这条通道（而不是被白名单或别的通道截胡）
  await setSetting("mail_transport_order", "cf-send")
  await setSetting("mail_cf_targets", "")
  await setSetting("cf_send_token", "")
  await setSetting("cf_send_from", MAIL_FROM)
  await setSetting("cf_send_from_name", MAIL_FROM_NAME)
})

afterEach(() => {
  restoreFetch?.()
  restoreFetch = null
})

describe("cf-send 发信载荷", () => {
  it("POST /accounts/{id}/email/sending/send，from/to 用具名地址 { address, name }", async () => {
    await setSetting("cf_send_from_name", "Doulor Cloud")
    await sendMail(env, {
      to: "someone@example.com",
      subject: "标题",
      text: "正文文字",
      html: "<p>正文</p>",
    })

    // 账户 ID 来自测试绑定（vitest.config.ts 的 ACCOUNT_ID）
    expect(capturedUrl).toBe(
      "https://api.cloudflare.com/client/v4/accounts/test-account-id/email/sending/send"
    )
    expect(captured).not.toBeNull()
    const body = captured as Record<string, unknown>
    expect(body.from).toEqual({ address: MAIL_FROM, name: "Doulor Cloud" })
    expect(body.to).toEqual([{ address: "someone@example.com" }])
    expect(body.subject).toBe("标题")
    expect(body.text).toBe("正文文字")
    expect(body.html).toBe("<p>正文</p>")
    // 没配面板 Token 时回落到 Worker 里那把 CF Token。
    // 不写死具体值：测试环境的值来自 worker/.dev.vars（先于 vitest 的 bindings 生效）
    const expectedToken = env.CLOUDFLARE_API_TOKEN_SECRET || env.CLOUDFLARE_API_TOKEN || ""
    expect(expectedToken).not.toBe("")
    expect(capturedAuth).toBe(`Bearer ${expectedToken}`)
  })

  it("面板里填了 Token 时优先用它（便于把发信权限单独拆一把最小权限 Token）", async () => {
    await setSetting("cf_send_token", "panel-only-token")
    await sendMail(env, { to: "a@example.com", subject: "s", text: "t" })
    expect(capturedAuth).toBe("Bearer panel-only-token")
    // 收回，避免污染其它用例
    await setSetting("cf_send_token", "")
  })

  it("未配置 html 时不带 html 字段", async () => {
    await sendMail(env, { to: "a@example.com", subject: "s", text: "t" })
    expect((captured as Record<string, unknown>).html).toBeUndefined()
  })
})

describe("cf-send 结果判定", () => {
  it("delivered 命中收件人 → 视为成功", async () => {
    await expect(
      sendMail(env, { to: "someone@example.com", subject: "s", text: "t" })
    ).resolves.toBeUndefined()
  })

  // ⚠️ 这条是整条通道的关键：HTTP 200 + permanent_bounces 绝不能当成「已发送」
  it("HTTP 200 但收件人在 permanent_bounces 里 → 抛 MAIL_SEND_FAILED", async () => {
    responder = () =>
      new Response(
        JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: {
            delivered: [],
            permanent_bounces: ["someone@example.com"],
            queued: [],
          },
        }),
        { status: 200 }
      )

    await expect(
      sendMail(env, { to: "someone@example.com", subject: "s", text: "t" })
    ).rejects.toMatchObject({ code: "MAIL_SEND_FAILED" })
  })

  it("queued（排队等投递）不算失败", async () => {
    responder = () =>
      new Response(
        JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: { delivered: [], permanent_bounces: [], queued: ["someone@example.com"] },
        }),
        { status: 200 }
      )
    await expect(
      sendMail(env, { to: "someone@example.com", subject: "s", text: "t" })
    ).resolves.toBeUndefined()
  })
})

describe("cf-send 错误映射", () => {
  it("403 / 10105（未开通 Email Sending）→ 提示需要 Workers Paid", async () => {
    responder = () =>
      cfError(403, 10105, "email.sending.error.authentication.not_entitled")
    await expect(
      sendMail(env, { to: "a@example.com", subject: "s", text: "t" })
    ).rejects.toThrow(/Workers Paid/)
  })

  it("403 / 10102（Token 缺权限）→ 提示要 Email Sending 权限", async () => {
    responder = () =>
      cfError(403, 10102, "email.sending.error.authentication.forbidden")
    await expect(
      sendMail(env, { to: "a@example.com", subject: "s", text: "t" })
    ).rejects.toThrow(/Email Sending/)
  })

  it("429 → MAIL_QUOTA_EXCEEDED（调用方据此暂停而不是记失败）", async () => {
    responder = () => cfError(429, 10004, "email.sending.error.throttled")
    await expect(
      sendMail(env, { to: "a@example.com", subject: "s", text: "t" })
    ).rejects.toMatchObject({ code: "MAIL_QUOTA_EXCEEDED" })
  })
})
