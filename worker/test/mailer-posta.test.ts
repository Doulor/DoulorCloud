// 本文件原名「Posta 发信载荷」。
//
// 2026-11-08 站长决定下线自建的 Posta 网关（发信渠道改为 brevo → cf-send → cf-routing），
// 载荷测试已无对象。但**下线本身需要长期守住**，所以文件名与用例一起改写为：
//   · 管理接口不能再把 posta 写进任何与发信通道有关的设置项（否则库里又会躺一条
//     谁也实现不了的通道，排查时只会看到「顺序里写了却不生效」）；
//   · 重构前已经落到库里的旧值 `brevo,posta,cf` 不会让发信卡住 —— 解析侧会把它
//     升级成新版默认链，信照常从 cf-send 发出去。
//
// ⚠️ 文件名沿用是为了保住 git 历史（这段历史本身就是 Posta 从引进到下线的一条记录）。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, setSetting } from "./helpers"
import { sendMail } from "../src/mailer"

let hits: string[] = []
let restoreFetch: (() => void) | null = null

beforeEach(async () => {
  hits = []
  const original = globalThis.fetch
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
      hits.push("brevo")
      // 让 Brevo 必定失败，才能看出「后面那条通道有没有被走到」
      return new Response(JSON.stringify({ message: "Key not found" }), { status: 401 })
    }
    if (url.includes("/email/sending/send")) {
      hits.push("cf-send")
      return new Response(
        JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: { delivered: ["someone@example.com"], permanent_bounces: [], queued: [] },
        }),
        { status: 200 }
      )
    }
    return original(input as RequestInfo, init)
  }) as unknown as typeof fetch
  restoreFetch = () => {
    globalThis.fetch = original
  }

  await setSetting("mail_cf_targets", "")
  await setSetting("brevo_api_key", "k-posta-retired")
  await setSetting("brevo_sender_email", "no-reply@doulor.cn")
  await setSetting("cf_send_token", "")
})

afterEach(() => {
  restoreFetch?.()
  restoreFetch = null
})

describe("Posta 下线后的配置面", () => {
  it("发送顺序里再写 posta 会被拒绝（400，且提示可用通道）", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await fetchSelf(
      authRequest(admin, "/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mail_transport_order: "brevo,posta,cf" }),
      })
    )
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).toMatch(/Posta 通道已下线/)
    expect(text).toMatch(/cf-send/)
  })

  it("公告群发首选通道也不能选 posta", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await fetchSelf(
      authRequest(admin, "/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ announcement_mail_transport: "posta" }),
      })
    )
    expect(res.status).toBe(400)
    expect(await res.text()).toMatch(/Posta 通道已下线/)
  })

  it("合法值会被归一化后入库（`cf` 旧名换成 cf-routing、去空格）", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await fetchSelf(
      authRequest(admin, "/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mail_transport_order: " Brevo , CF ,cf-send " }),
      })
    )
    expect(res.status).toBe(200)
    const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'mail_transport_order'")
      .first<{ value: string }>()
    expect(row?.value).toBe("brevo,cf-routing,cf-send")
  })
})

describe("Posta 下线后的旧数据", () => {
  it("库里残留 `brevo,posta,cf` 时照常发信：posta 被跳过，落到 cf-send", async () => {
    await setSetting("mail_transport_order", "brevo,posta,cf")

    await sendMail(env, { to: "someone@example.com", subject: "s", text: "t" })
    // 旧值整体升级成新默认链 → brevo 401 后走 cf-send；根本不存在 posta 这一环
    expect(hits).toEqual(["brevo", "cf-send"])
  })
})
