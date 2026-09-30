// Brevo 通道「多把 Key 叠加额度」的回归测试。
//
// 背景：Brevo 免费版按**账号**限 300 封/天。管理员多注册几个账号、各配一把 Key，
// 期望日额度累加（3 把 ≈ 900 封/天）。所以 sendViaBrevo 必须：
//   · 轮询各把 Key（而不是永远只用第一把）
//   · 某把额度用完 / 无效时，自动换下一把继续发
//   · 只有当**所有** Key 都发不出去时，才把错误抛给调用方
//   · 非额度类失败（如收件人被拒）不该无谓地换 Key 重试
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { setSetting } from "./helpers"
import { sendMail, parseBrevoKeys } from "../src/mailer"

/** 记录每次**发信**请求用到的 api-key（顺序即尝试顺序）；额度查询不计入 */
let usedKeys: string[] = []
let restoreFetch: (() => void) | null = null
/** api-key → 该 Key 的响应；默认 200 成功 */
let responder: (key: string) => Response = () => jsonOk()
/** api-key → `/v3/account` 的当日剩余封数；不配则默认 100（= 健康） */
let creditsByKey: (key: string) => number | null = () => 100
/** 发信 POST 次数（不含额度查询） */
let posts = 0
/** 额度查询 GET 次数 */
let probes = 0

function jsonOk() {
  return new Response(JSON.stringify({ messageId: "ok" }), { status: 200 })
}
/**
 * 模拟「当日额度已用尽」的账号。
 *
 * ⚠️ 2026-09-30 实测：额度用尽后 `POST /v3/smtp/email` **仍返回 201**，
 * 只是信被静默丢弃。所以这里必须让发信接口也回 200 —— 只有这样，
 * 「实现必须靠提前查额度来避开死 Key」这件事才真的被测试到。
 */
function accountBody(credits: number | null) {
  // credits === null 模拟「读不到额度」（账号开了 IP 白名单、或套餐语义不同）：
  // 返回一个**没有 plan 字段**的账号信息，实现应把它当「未知」而非「已用尽」。
  if (credits === null) {
    return new Response(JSON.stringify({ email: "x@example.com" }), { status: 200 })
  }
  return new Response(
    JSON.stringify({
      email: "x@example.com",
      plan: [{ type: "free", credits, creditsType: "sendLimit" }],
    }),
    { status: 200 }
  )
}
function quotaExceeded() {
  return new Response(
    JSON.stringify({ code: "max_emails_per_day_exceeded", message: "max emails per day exceeded" }),
    { status: 400 }
  )
}
function unauthorized() {
  return new Response(JSON.stringify({ message: "Key not found" }), { status: 401 })
}
function badRecipient() {
  return new Response(JSON.stringify({ message: "invalid email address" }), { status: 400 })
}

beforeEach(async () => {
  usedKeys = []
  posts = 0
  probes = 0
  responder = () => jsonOk()
  creditsByKey = () => 100

  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.includes("api.brevo.com")) {
      const key = String((init?.headers as Record<string, string> | undefined)?.["api-key"] ?? "")
      // 额度查询：只回账号信息，不计入「发信次数 / 尝试顺序」
      if (url.includes("/v3/account")) {
        probes++
        return accountBody(creditsByKey(key))
      }
      posts++
      usedKeys.push(key)
      return responder(key)
    }
    return original(input as RequestInfo, init)
  }) as unknown as typeof fetch
  restoreFetch = () => {
    globalThis.fetch = original
  }

  await setSetting("mail_transport_order", "brevo")
  await setSetting("mail_cf_targets", "")
  await setSetting("brevo_sender_email", "no-reply@doulor.cn")
  await setSetting("brevo_sender_name", "Doulor Cloud")
})

afterEach(() => {
  restoreFetch?.()
  restoreFetch = null
})

const MAIL = { to: "someone@example.com", subject: "标题", text: "正文" }

describe("parseBrevoKeys", () => {
  it("逗号 / 换行 / 分号 / 空格都能分隔，并去掉空项", () => {
    expect(parseBrevoKeys("k1,k2")).toEqual(["k1", "k2"])
    expect(parseBrevoKeys("k1\nk2\nk3")).toEqual(["k1", "k2", "k3"])
    expect(parseBrevoKeys(" k1 ; k2 ,, k3 \n\n")).toEqual(["k1", "k2", "k3"])
    expect(parseBrevoKeys("")).toEqual([])
    expect(parseBrevoKeys("   ")).toEqual([])
  })

  it("单把 Key 原样返回", () => {
    expect(parseBrevoKeys("xkeysib-abc")).toEqual(["xkeysib-abc"])
  })
})

describe("Brevo 多 Key 叠加额度", () => {
  it("单把 Key 正常发出", async () => {
    await setSetting("brevo_api_key", "k1")
    await sendMail(env, MAIL)
    expect(posts).toBe(1)
    expect(usedKeys).toEqual(["k1"])
    // 发信前确实查过一次额度（跳过「死 Key」的依据）
    expect(probes).toBeGreaterThan(0)
  })

  it("额度查询有缓存：同一次运行内不重复打 /v3/account", async () => {
    await setSetting("brevo_api_key", "cachekey")
    await sendMail(env, MAIL)
    const afterFirst = probes
    await sendMail(env, MAIL)
    expect(probes).toBe(afterFirst)
  })

  // ⚠️ 回归：2026-09-30 线上事故。Brevo 免费版当日额度用尽后**仍回 201**，
  // 只是把信静默丢弃。若实现只看 `res.ok`，这把死 Key 会把整封信吃掉。
  it("某把 Key 当日额度已用尽（credits=0）→ 发信前就跳过它，不把信交给它", async () => {
    await setSetting("brevo_api_key", "usedup,alive")
    creditsByKey = (k) => (k === "usedup" ? 0 : 120)

    await sendMail(env, MAIL)
    expect(posts).toBe(1)
    expect(usedKeys).toEqual(["alive"])
  })

  it("全部 Key 当日额度用尽 → 抛 MAIL_QUOTA_EXCEEDED，且一次都不发（绝不假装成功）", async () => {
    await setSetting("brevo_api_key", "q1,q2")
    creditsByKey = () => 0

    await expect(sendMail(env, MAIL)).rejects.toMatchObject({
      code: "MAIL_QUOTA_EXCEEDED",
    })
    expect(posts).toBe(0)
  })

  it("额度读不到（接口报错）→ 不拦截，按旧行为照常发", async () => {
    await setSetting("brevo_api_key", "unknownkey")
    creditsByKey = () => null

    await sendMail(env, MAIL)
    expect(posts).toBe(1)
    expect(usedKeys).toEqual(["unknownkey"])
  })

  it("多把 Key 会被轮询使用（同一次运行内每把都轮到）", async () => {
    await setSetting("brevo_api_key", "k1,k2,k3")
    for (let i = 0; i < 3; i++) await sendMail(env, MAIL)

    expect(posts).toBe(3)
    // 不写死起始位置（游标是模块级、可能被前面的用例推动），只断言「三把各用一次」
    expect(new Set(usedKeys)).toEqual(new Set(["k1", "k2", "k3"]))
    expect(usedKeys.length).toBe(3)
  })

  it("第一把额度用完 → 自动换下一把，整体仍然发成功", async () => {
    await setSetting("brevo_api_key", "dead,alive")
    // 用「第几次尝试」判定，而不是 Key 的身份 —— 轮转起点不确定，靠身份会偶发失败
    let attempt = 0
    responder = () => {
      attempt++
      return attempt === 1 ? quotaExceeded() : jsonOk()
    }

    await sendMail(env, MAIL)
    expect(posts).toBe(2) // 失败一次、换下一把成功
    expect(usedKeys[0]).not.toBe(usedKeys[1]) // 确实换了一把，而不是重试同一把
  })

  it("某把 Key 已失效（401）→ 也换下一把，不拖垮整体", async () => {
    await setSetting("brevo_api_key", "revoked,good")
    let attempt = 0
    responder = () => {
      attempt++
      return attempt === 1 ? unauthorized() : jsonOk()
    }

    await sendMail(env, MAIL)
    expect(posts).toBe(2)
    expect(usedKeys[0]).not.toBe(usedKeys[1])
  })

  it("所有 Key 都超额 → 抛 MAIL_QUOTA_EXCEEDED（调用方据此暂停而非记失败）", async () => {
    await setSetting("brevo_api_key", "a,b,c")
    responder = () => quotaExceeded()

    await expect(sendMail(env, MAIL)).rejects.toMatchObject({
      code: "MAIL_QUOTA_EXCEEDED",
    })
    // 三把都试过了
    expect(usedKeys.length).toBe(3)
  })

  it("非额度类失败（收件人被拒）→ 立即抛出，不做无谓的换 Key 重试", async () => {
    await setSetting("brevo_api_key", "k1,k2,k3")
    responder = () => badRecipient()

    await expect(sendMail(env, MAIL)).rejects.toMatchObject({ code: "MAIL_SEND_FAILED" })
    expect(usedKeys.length).toBe(1)
  })

  it("未配置任何 Key → MAIL_NOT_CONFIGURED", async () => {
    await setSetting("brevo_api_key", "")
    await expect(sendMail(env, MAIL)).rejects.toMatchObject({ code: "MAIL_NOT_CONFIGURED" })
    expect(posts).toBe(0)
  })
})
