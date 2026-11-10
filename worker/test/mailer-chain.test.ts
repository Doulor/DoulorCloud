// 发信通道链的回归测试（2026-11-08 重构）。
//
// 背景：站长要求「brevo 失败后继续往后走」+「去掉 posta、加 cf-send」，
// 顺序定为 brevo → cf-send → cf-routing。这个文件钉住三件事：
//   1. 旧配置值（`brevo,posta,cf`、单独的 `cf`）能正确迁移到新名字；
//   2. **任何**失败都会回退到下一个通道（旧实现在额度类错误上直接中断整条链）；
//   3. 全部失败时的错误码：出现过额度类失败就以 MAIL_QUOTA_EXCEEDED 收尾，
//      否则沿用最后一条通道的错误码。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { setSetting } from "./helpers"
import {
  sendMail,
  normalizeTransportOrder,
  MAIL_TRANSPORTS,
  type MailTransport,
} from "../src/mailer"

const MAIL = { to: "someone@example.com", subject: "标题", text: "正文" }

/** 记录实际打到的通道（顺序 = 尝试顺序） */
let hits: string[] = []
let restoreFetch: (() => void) | null = null
/** 各通道的响应工厂，默认全部成功 */
let brevoResponder: () => Response = () => ok()
let cfSendResponder: () => Response = () => ok()
let brevoCredits = 100

function ok() {
  return new Response(
    JSON.stringify({
      success: true,
      result: { delivered: ["someone@example.com"], permanent_bounces: [], queued: [] },
      messageId: "ok",
    }),
    { status: 200 }
  )
}
function brevo401() {
  return new Response(JSON.stringify({ message: "Key not found" }), { status: 401 })
}
function brevoQuota() {
  return new Response(
    JSON.stringify({ code: "max_emails_per_day_exceeded", message: "max emails per day exceeded" }),
    { status: 400 }
  )
}

beforeEach(async () => {
  hits = []
  brevoResponder = () => ok()
  cfSendResponder = () => ok()
  brevoCredits = 100

  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.includes("api.brevo.com/v3/account")) {
      return new Response(
        JSON.stringify({ plan: [{ type: "free", credits: brevoCredits, creditsType: "sendLimit" }] }),
        { status: 200 }
      )
    }
    if (url.includes("api.brevo.com/v3/smtp/email")) {
      hits.push("brevo")
      return brevoResponder()
    }
    if (url.includes("/email/sending/send")) {
      hits.push("cf-send")
      return cfSendResponder()
    }
    return original(input as RequestInfo, init)
  }) as unknown as typeof fetch
  restoreFetch = () => {
    globalThis.fetch = original
  }

  await setSetting("mail_cf_targets", "")
  await setSetting("brevo_api_key", "k1")
  await setSetting("brevo_sender_email", "no-reply@doulor.cn")
  await setSetting("cf_send_token", "")
  await setSetting("cf_send_from", "no-reply@doulor.cn")
})

afterEach(() => {
  restoreFetch?.()
  restoreFetch = null
})

describe("通道标识与旧值迁移", () => {
  it("三条通道：brevo / cf-send / cf-routing（posta 已彻底消失）", () => {
    expect([...MAIL_TRANSPORTS]).toEqual(["brevo", "cf-send", "cf-routing"])
    expect((MAIL_TRANSPORTS as readonly string[]).includes("posta")).toBe(false)
  })

  it("重构前的 `brevo,posta,cf` → 新版默认链（posta 丢掉、cf 略去、只留 brevo+cf-send）", () => {
    expect(normalizeTransportOrder("brevo,posta,cf")).toEqual(["brevo", "cf-send"])
  })

  it("只写了旧名 `cf` → cf-routing（旧名仍可解析，只是不再进默认链）", () => {
    expect(normalizeTransportOrder("brevo,cf")).toEqual(["brevo", "cf-routing"])
  })

  it("大小写 / 空格 / 分隔符都收宽，并去重", () => {
    expect(normalizeTransportOrder(" CF-Send , cf-routing ; BREVO ")).toEqual([
      "cf-send",
      "cf-routing",
      "brevo",
    ])
    expect(normalizeTransportOrder("brevo,brevo")).toEqual(["brevo"])
  })

  it("空串 / 全是垃圾值 → 回落默认链（配错了不会变成「没有通道」）", () => {
    expect(normalizeTransportOrder("")).toEqual(["brevo", "cf-send"])
    expect(normalizeTransportOrder("nonsense")).toEqual(["brevo", "cf-send"])
  })

  it("默认链里没有 cf-routing：它发不了任意收件人，只靠白名单那条路走", () => {
    expect(normalizeTransportOrder("")).not.toContain("cf-routing")
  })
})

describe("失败自动回退", () => {
  it("brevo 401（Key 失效）→ 自动改用 cf-send", async () => {
    await setSetting("mail_transport_order", "brevo,cf-send,cf-routing")
    // 每例用不同的 Key：Brevo 的额度缓存是模块级、按 Key 存的（5 分钟），
    // 复用同一个 Key 会让上一例的探测结果漏到下一例
    await setSetting("brevo_api_key", "k-chain-401")
    brevoResponder = () => brevo401()

    await sendMail(env, MAIL)
    expect(hits).toEqual(["brevo", "cf-send"])
  })

  // ⚠️ 这就是站长反馈的那个问题：旧实现在额度错误上直接 throw，后面的通道一律不走
  it("brevo 额度用尽 → 仍然自动改用 cf-send（不再中断整条链）", async () => {
    await setSetting("mail_transport_order", "brevo,cf-send,cf-routing")
    await setSetting("brevo_api_key", "k-chain-quota")
    brevoResponder = () => brevoQuota()

    await sendMail(env, MAIL)
    expect(hits).toEqual(["brevo", "cf-send"])
  })

  it("brevo 的 Key 全部额度为 0（发信前就被拦）→ 也继续走 cf-send", async () => {
    await setSetting("mail_transport_order", "brevo,cf-send,cf-routing")
    await setSetting("brevo_api_key", "k-chain-zero")
    brevoCredits = 0

    await sendMail(env, MAIL)
    // 一把都没发（被额度预检拦下），直接落到 cf-send
    expect(hits).toEqual(["cf-send"])
  })

  it("严格按设置里的顺序走（把 cf-send 放最前就先打它）", async () => {
    await setSetting("mail_transport_order", "cf-send,brevo,cf-routing")
    await setSetting("brevo_api_key", "k-chain-order")
    cfSendResponder = () =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 10203, message: "sending_disabled" }] }), {
        status: 403,
      })

    await sendMail(env, MAIL)
    expect(hits).toEqual(["cf-send", "brevo"])
  })

  it("命中 mail_cf_targets 白名单 → 直接走 cf-routing，不消耗第三方额度", async () => {
    await setSetting("mail_transport_order", "brevo,cf-send,cf-routing")
    await setSetting("mail_cf_targets", "someone@example.com")

    // 测试环境里 send_email 绑定是个「什么都不做、直接 resolve」的桩，
    // 所以这里断言「没有任何 HTTP 通道被打到」—— 那就只可能是走了 cf-routing。
    await expect(sendMail(env, MAIL)).resolves.toBeUndefined()
    expect(hits).toEqual([])
  })
})

describe("全部失败时的错误码", () => {
  it("出现过额度类失败 → MAIL_QUOTA_EXCEEDED（公告群发据此暂停而非记失败）", async () => {
    await setSetting("brevo_api_key", "k-chain-all-quota")
    brevoResponder = () => brevoQuota()
    cfSendResponder = () => new Response(JSON.stringify({}), { status: 500 })

    // 刻意不带 cf-routing：它是环境里的桩、永远成功，会把「全部失败」这个前提破坏掉
    await expect(
      sendMail(env, MAIL, { chain: ["brevo", "cf-send"] })
    ).rejects.toMatchObject({ code: "MAIL_QUOTA_EXCEEDED" })
  })

  it("全是非额度失败 → 沿用最后一条通道的错误码，并带上每一环的原因", async () => {
    await setSetting("brevo_api_key", "k-chain-all-fail")
    brevoResponder = () => brevo401()
    cfSendResponder = () =>
      new Response(
        JSON.stringify({ success: false, errors: [{ code: 10203, message: "sending_disabled" }] }),
        { status: 403 }
      )

    // 只留这两条：cf-routing 在测试环境必然「未配置」，会把错误码盖成 NOT_CONFIGURED，
    // 反而看不出「最后一条真试过的通道报了什么」
    const err = await sendMail(env, MAIL, { chain: ["brevo", "cf-send"] }).catch(
      (e: unknown) => e as { code: string; message: string }
    )
    expect((err as { code: string }).code).toBe("MAIL_SEND_FAILED")
    expect(hits).toEqual(["brevo", "cf-send"])
    expect((err as { message: string }).message).toContain("brevo:")
    expect((err as { message: string }).message).toContain("cf-send:")
  })

  it("opts.prefer 只改优先级，不做通道裁剪（首选失败仍按顺序回退）", async () => {
    await setSetting("mail_transport_order", "brevo,cf-send,cf-routing")
    await setSetting("brevo_api_key", "k-chain-prefer")
    brevoResponder = () => brevo401()

    const prefer: MailTransport = "brevo"
    await sendMail(env, MAIL, { prefer })
    expect(hits).toEqual(["brevo", "cf-send"])
  })

  it("opts.chain 完全以传入值为准（公告群发用它钉死链路）", async () => {
    await setSetting("mail_transport_order", "brevo")
    await sendMail(env, MAIL, { chain: ["cf-send", "brevo"] })
    expect(hits).toEqual(["cf-send"])
  })
})

describe("CF 月度预算闸（不允许超额扣费）", () => {
  /** 清掉本表所有计数，让每个用例都从 0 开始（跨用例共享同一个 D1） */
  async function resetUsage(): Promise<void> {
    await env.DB.prepare("DELETE FROM mail_send_usage").run()
  }

  beforeEach(async () => {
    await resetUsage()
    await setSetting("cf_send_monthly_cap", "2900")
    await setSetting("cf_cycle_day", "1")
  })

  afterEach(async () => {
    await resetUsage()
    await setSetting("cf_send_monthly_cap", "2900")
  })

  it("发一封 CF 信就记一次数（本账期用量 +1）", async () => {
    await setSetting("mail_transport_order", "cf-send")
    await sendMail(env, MAIL)
    await sendMail(env, MAIL)

    const row = await env.DB.prepare(
      "SELECT SUM(count) AS c FROM mail_send_usage WHERE channel = 'cf'"
    ).first<{ c: number }>()
    expect(row?.c).toBe(2)
  })

  it("到上限后**不再调 CF 接口**，自动回退到下一个通道", async () => {
    await setSetting("mail_transport_order", "cf-send,brevo")
    await setSetting("cf_send_monthly_cap", "2")

    await sendMail(env, MAIL)
    await sendMail(env, MAIL)
    hits = []
    await sendMail(env, MAIL) // 第 3 封：cf-send 被闸住 → 走 brevo

    expect(hits).toEqual(["brevo"])
  })

  it("上限是 0 = 不设限（会用出账单，所以这是个显式选择）", async () => {
    await setSetting("mail_transport_order", "cf-send")
    await setSetting("cf_send_monthly_cap", "0")

    for (let i = 0; i < 3; i++) await sendMail(env, MAIL)
    expect(hits).toEqual(["cf-send", "cf-send", "cf-send"])
  })

  it("到量时抛的是 MAIL_BUDGET_REACHED（不是额度错误，不该触发群发暂停）", async () => {
    await setSetting("cf_send_monthly_cap", "0") // 先确认不被拦
    await setSetting("cf_send_monthly_cap", "1")

    await setSetting("mail_transport_order", "cf-send")
    await sendMail(env, MAIL)

    await setSetting("mail_transport_order", "cf-send")
    const err = await sendMail(env, MAIL).catch((e: unknown) => e as { code: string })
    expect((err as { code: string }).code).toBe("MAIL_BUDGET_REACHED")
  })

  it("白名单（已验证 destination）的发送不计数 —— 那类是永远免费的", async () => {
    await setSetting("mail_cf_targets", "someone@example.com")
    await setSetting("mail_transport_order", "brevo,cf-send")

    // 命中白名单 → 走 cf-routing（测试环境是成功的桩），不经过预算闸
    await sendMail(env, MAIL)
    const row = await env.DB.prepare(
      "SELECT SUM(count) AS c FROM mail_send_usage"
    ).first<{ c: number }>()
    expect(row?.c ?? 0).toBe(0)

    await setSetting("mail_cf_targets", "")
  })
})
