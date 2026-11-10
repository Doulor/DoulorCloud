/**
 * 2026-11-10 渗透测试 finding #4（LOW）：转发目标验证邮件的滥用。
 *
 * 漏洞：任意登录用户 `POST /api/mailbox/forward-verify { email: "任意外部地址" }`，
 * 平台就会以**官方发件人**（DoulorCloud@doulor.cn，DKIM d=doulor.cn）向该地址发一封
 * 「转发目标验证码」邮件，正文里还带调用方可控的用户名。修复前只有"用户维度 10 次/小时"，
 * 于是：
 *   · 注册几个小号，就能对着同一个受害者邮箱连续轰炸（跨账号没有冷却）；
 *   · 也能打 postmaster@ / abuse@ 这类职务地址 —— 借我们的发信域名去给别人的
 *     运维 / 安全 / 注册邮箱开投诉工单，严重时把我们自己的域名打进黑名单。
 *
 * 本文件钉住修复后的三条边界：
 *   1. 职务 / 高价值地址直接 400 `INVALID_EMAIL`（一封都不发）；
 *   2. **收件地址维度** 3 次/小时、**跨账号全局生效**（第 4 个账号即 429）；
 *   3. **用户维度** 从 10 次收紧到 5 次/小时（第 6 个不同地址即 429）。
 *
 * ⚠️ 出站全部打桩（`globalThis.fetch`）：本文件绝不允许真的发信、也不许真出网络。
 *    只断言状态码与响应体里的 code，不断言邮件正文（模板文案属于另一个用例的事）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, setSetting, type TestUser } from "./helpers"

const JSON_HEADERS = { "Content-Type": "application/json" }

/** 放行 Brevo 的发信 / 额度接口并回 2xx；其它出站请求一律拦下（绝不真出网络） */
let restoreFetch: (() => void) | null = null
/** 真正走到「发信」这一步的次数（用于断言"被拦下时确实没发"） */
let smtpPosts = 0

function stubOutboundMail(): void {
  const original = globalThis.fetch
  smtpPosts = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    // 额度查询：sendLimit 类型 + 足够大的剩余量，保证实现认为这个 Key 健康
    if (url.includes("api.brevo.com/v3/account")) {
      return new Response(
        JSON.stringify({ plan: [{ type: "free", credits: 500, creditsType: "sendLimit" }] }),
        { status: 200 }
      )
    }
    if (url.includes("api.brevo.com/v3/smtp/email")) {
      smtpPosts++
      return new Response(JSON.stringify({ messageId: "stub-ok" }), { status: 200 })
    }
    // 兜底：任何没预料到的出站请求都直接失败，测试环境不许真的出网络
    return new Response(JSON.stringify({ message: "blocked in test" }), { status: 502 })
  }) as unknown as typeof fetch
  restoreFetch = () => {
    globalThis.fetch = original
  }
}

beforeEach(async () => {
  stubOutboundMail()
  // 限流是**全局**计数（rate_limits 表），用例之间必须清干净，否则相互污染
  await env.DB.prepare("DELETE FROM rate_limits").run()
  // 只留 brevo（已打桩），避免真的去请求 Cloudflare 的发信接口
  await setSetting("mail_transport_order", "brevo")
  await setSetting("mail_cf_targets", "")
  await setSetting("brevo_api_key", "k-forward-abuse")
  await setSetting("brevo_sender_email", "no-reply@doulor.cn")
})

afterEach(() => {
  restoreFetch?.()
  restoreFetch = null
})

/** 发起一次「发送转发验证码」请求 */
async function requestVerify(user: TestUser, email: string): Promise<Response> {
  return fetchSelf(
    authRequest(user, "/api/mailbox/forward-verify", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email }),
    })
  )
}

/** 读响应体里的业务 code（读完 body 之后 status 仍可读，顺序无所谓） */
async function expectCode(res: Response): Promise<string | undefined> {
  return ((await res.json().catch(() => ({}))) as { code?: string }).code
}

/** 某个目标地址当前存了几条验证码（被拦下的请求不该留下任何行） */
async function codeRowsFor(email: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM forward_verify_codes WHERE target_email = ?"
  )
    .bind(email)
    .first<{ c: number }>()
  return row?.c ?? 0
}

describe("转发目标验证邮件滥用（finding #4）", () => {
  it("职务 / 高价值地址不能作为转发目标 → 400 INVALID_EMAIL，且不发信", async () => {
    const u = await makeUser()
    // 抽查几个典型的职务地址（常量清单见 email.ts 的 FORWARD_BLOCKED_LOCALPARTS）
    for (const localpart of ["postmaster", "abuse", "security", "admin", "root", "noreply"]) {
      const email = `${localpart}@example.com`
      const res = await requestVerify(u, email)
      expect(res.status).toBe(400)
      expect(await expectCode(res)).toBe("INVALID_EMAIL")
      // 业务上必须已经收口：既没有验证码行，也没有真的发出去
      expect(await codeRowsFor(email)).toBe(0)
    }
    expect(smtpPosts).toBe(0)
  })

  it("收件地址维度全局冷却：3 个不同账号发给同一地址各 200，第 4 个账号 429", async () => {
    // 固定外部地址：rate_limits 已在 beforeEach 清空，这里跨账号共享同一个桶
    const target = "victim@example.com"

    for (let i = 0; i < 3; i++) {
      const u = await makeUser()
      const res = await requestVerify(u, target)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { email?: string; verified?: boolean }
      expect(body.email).toBe(target)
      expect(body.verified).toBe(false)
    }
    expect(smtpPosts).toBe(3)

    // 第 4 个账号：换成小号也没用 —— 冷却键是**收件地址**，不是账号
    const attacker = await makeUser()
    const blocked = await requestVerify(attacker, target)
    expect(blocked.status).toBe(429)
    expect(await expectCode(blocked)).toBe("RATE_LIMITED")
    // 被拦下就是真的没发（这条最关键：否则"限流"只是回了个 429 而已）
    expect(smtpPosts).toBe(3)
  })

  it("用户维度限流：同一账号 5 个不同地址各 200，第 6 个不同地址 429", async () => {
    const u = await makeUser()
    for (let i = 0; i < 5; i++) {
      const res = await requestVerify(u, `target${i}@example.com`)
      expect(res.status).toBe(200)
    }
    expect(smtpPosts).toBe(5)

    // 换个地址也绕不过用户维度的小时额度（10 → 5 的收紧点）
    const blocked = await requestVerify(u, "target5@example.com")
    expect(blocked.status).toBe(429)
    expect(await expectCode(blocked)).toBe("RATE_LIMITED")
    expect(smtpPosts).toBe(5)
  })
})
