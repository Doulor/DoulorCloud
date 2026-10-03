// 账号监管：注册准入（邮箱白名单 / 同 IP 上限）+ 封禁申诉 + 风险账户。
//
// 覆盖：
//   1. 邮箱域名白名单：白名单外拒绝、白名单内通过、留空不限制
//   2. 同 IP 24h 累计注册上限：超限 429、不同 IP 互不影响、0 = 不限
//   3. 封禁申诉：正常账号不能申诉、被封禁可申诉、管理端通过即解封、驳回不解封、重复处理 400
//   4. 风险账户：管理端列表 + 标记状态；/api/attention 带上监管角标字段
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { uuid } from "../src/crypto"
import { makeUser, authRequest, fetchSelf, setSetting } from "./helpers"

async function makeAdmin() {
  return makeUser({ role: "admin" })
}

/** 走真实注册路由，带指定来源 IP */
async function registerAt(username: string, email: string, ip: string): Promise<Response> {
  return fetchSelf(
    new Request("https://cloud.doulor.cn/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({ username, email, password: "pass12345" }),
    })
  )
}

async function submitAppeal(username: string, content: string): Promise<Response> {
  return fetchSelf(
    new Request("https://cloud.doulor.cn/api/appeal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, content, contact: "me@qq.com" }),
    })
  )
}

async function suspend(username: string): Promise<void> {
  await env.DB.prepare("UPDATE users SET status = 'suspended' WHERE username = ?")
    .bind(username)
    .run()
}

async function userStatus(id: string): Promise<string> {
  const row = await env.DB.prepare("SELECT status FROM users WHERE id = ?")
    .bind(id)
    .first<{ status: string }>()
  return row?.status ?? ""
}

const uname = (p: string) => `${p}-${uuid().slice(0, 8)}`

beforeEach(async () => {
  // 本文件会改注册设置，统一在这里摆到「不限制」的起点
  await setSetting("open_registration", "1")
  await setSetting("register_email_domains", "")
  await setSetting("register_ip_daily_limit", "0")
})

afterEach(async () => {
  // ⚠️ 必须还原：这些设置是全局的，残留会污染同一次 run 里的其它测试文件
  //    （比如「邮箱白名单」留着会把别人的 @example.com 注册全拦掉）
  await setSetting("open_registration", "0")
  await setSetting("register_email_domains", "")
  await setSetting("register_ip_daily_limit", "0")
})

describe("注册准入：邮箱域名白名单", () => {
  it("不在白名单的域名 → 400 EMAIL_DOMAIN_NOT_ALLOWED", async () => {
    await setSetting("register_email_domains", "qq.com,gmail.com,outlook.com")
    const res = await registerAt(uname("wl"), "someone@smailr.com", "10.40.0.1")
    expect(res.status).toBe(400)
    const body = await res.json<{ code?: string }>()
    expect(body.code).toBe("EMAIL_DOMAIN_NOT_ALLOWED")
  })

  it("白名单内的域名 → 注册成功", async () => {
    await setSetting("register_email_domains", "qq.com,gmail.com,outlook.com")
    const res = await registerAt(uname("wl"), "ok@gmail.com", "10.40.0.2")
    expect(res.status).toBe(201)
  })

  it("白名单留空 = 不限制（临时邮箱也能注册）", async () => {
    await setSetting("register_email_domains", "")
    const res = await registerAt(uname("wl"), "someone@smailr.com", "10.40.0.3")
    expect(res.status).toBe(201)
  })

  it("大小写与空格容错：白名单写成大写也能匹配", async () => {
    await setSetting("register_email_domains", " QQ.com , Gmail.com ")
    expect((await registerAt(uname("wl"), "a@QQ.com", "10.40.0.4")).status).toBe(201)
  })

  it("换行 / 分号分隔也认（后台是个多行输入框，一行一个域名是最自然的写法）", async () => {
    await setSetting("register_email_domains", "qq.com\ngmail.com; outlook.com")
    expect((await registerAt(uname("wl"), "a@gmail.com", "10.40.0.5")).status).toBe(201)
    expect((await registerAt(uname("wl"), "b@outlook.com", "10.40.0.6")).status).toBe(201)
  })

  it("写成 @qq.com（带 @）也能匹配", async () => {
    await setSetting("register_email_domains", "@qq.com")
    expect((await registerAt(uname("wl"), "c@qq.com", "10.40.0.7")).status).toBe(201)
  })
})

describe("注册准入：同 IP 累计上限", () => {
  it("同一 IP 超过 24h 上限 → 429 REGISTER_IP_LIMIT", async () => {
    await setSetting("register_ip_daily_limit", "2")
    const ip = "10.41.7.7"
    expect((await registerAt(uname("ip"), "a1@qq.com", ip)).status).toBe(201)
    expect((await registerAt(uname("ip"), "a2@qq.com", ip)).status).toBe(201)
    const third = await registerAt(uname("ip"), "a3@qq.com", ip)
    expect(third.status).toBe(429)
    const body = await third.json<{ code?: string }>()
    expect(body.code).toBe("REGISTER_IP_LIMIT")
  })

  it("不同 IP 互不影响", async () => {
    await setSetting("register_ip_daily_limit", "1")
    expect((await registerAt(uname("ip"), "b1@qq.com", "10.42.1.1")).status).toBe(201)
    expect((await registerAt(uname("ip"), "b2@qq.com", "10.42.1.2")).status).toBe(201)
  })

  it("设为 0 = 不限", async () => {
    await setSetting("register_ip_daily_limit", "0")
    const ip = "10.43.9.9"
    for (let i = 0; i < 3; i++) {
      expect((await registerAt(uname("ip"), `c${i}@qq.com`, ip)).status).toBe(201)
    }
  })
})

describe("封禁申诉", () => {
  it("正常账号不能申诉（否则等于公开留言板）", async () => {
    const u = await makeUser()
    const res = await submitAppeal(u.username, "我是正常账号，随便提交一下试试看")
    expect(res.status).toBe(400)
    expect((await res.json<{ code?: string }>()).code).toBe("NOT_SUSPENDED")
  })

  it("找不到账号 → 404；正文太短 → 400", async () => {
    expect((await submitAppeal("no_such_user_zzz", "我被封了，请复核一下我的账号")).status).toBe(404)
    const u = await makeUser()
    await suspend(u.username)
    expect((await submitAppeal(u.username, "太短")).status).toBe(400)
  })

  it("被封禁账号可申诉；管理端「通过」→ 自动解封", async () => {
    const admin = await makeAdmin()
    const u = await makeUser()
    await suspend(u.username)

    const res = await submitAppeal(u.username, "我没有刷接口，都是正常使用，请复核一下")
    expect(res.status).toBe(200)

    const list = await fetchSelf(authRequest(admin, "/api/admin/appeals"))
    const appeals = (
      await list.json<{ appeals: { id: string; username: string; status: string }[] }>()
    ).appeals
    const mine = appeals.find((a) => a.username === u.username)
    expect(mine).toBeTruthy()
    expect(mine!.status).toBe("pending")

    const review = await fetchSelf(
      authRequest(admin, `/api/admin/appeals/${mine!.id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "accept", note: "核实后解封" }),
      })
    )
    expect(review.status).toBe(200)
    expect((await review.json<{ unblocked: boolean }>()).unblocked).toBe(true)
    expect(await userStatus(u.id)).toBe("active")
  })

  it("「驳回」不解封；同一条不能重复处理", async () => {
    const admin = await makeAdmin()
    const u = await makeUser()
    await suspend(u.username)
    await submitAppeal(u.username, "请复核，我确实是正常使用这个账号")

    const list = await fetchSelf(authRequest(admin, "/api/admin/appeals"))
    const appeals = (await list.json<{ appeals: { id: string; username: string }[] }>()).appeals
    const id = appeals.find((a) => a.username === u.username)!.id

    const reject = await fetchSelf(
      authRequest(admin, `/api/admin/appeals/${id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reject", note: "证据确凿" }),
      })
    )
    expect(reject.status).toBe(200)
    expect(await userStatus(u.id)).toBe("suspended")

    // 重复处理同一条 → 400
    const again = await fetchSelf(
      authRequest(admin, `/api/admin/appeals/${id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "accept" }),
      })
    )
    expect(again.status).toBe(400)
  })

  it("非管理员不能看申诉列表", async () => {
    const u = await makeUser()
    expect((await fetchSelf(authRequest(u, "/api/admin/appeals"))).status).toBe(403)
  })
})

describe("风险账户（管理端）", () => {
  it("列表能读到 + 可以标记状态", async () => {
    const admin = await makeAdmin()
    const u = await makeUser()
    const now = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO risk_accounts
         (user_id, username, risk_level, score, reasons, peak_per_min, requests_7d,
          first_seen_at, last_seen_at, status, updated_at)
       VALUES (?, ?, 'high', 80, ?, 120, 5000, ?, ?, 'open', ?)`
    )
      .bind(u.id, u.username, JSON.stringify(["单分钟最高 120 次请求（阈值 20 次/分钟）"]), now, now, now)
      .run()

    const list = await fetchSelf(authRequest(admin, "/api/admin/risk-accounts"))
    const accounts = (
      await list.json<{ accounts: { userId: string; riskLevel: string; peakPerMin: number }[] }>()
    ).accounts
    const mine = accounts.find((a) => a.userId === u.id)
    expect(mine).toBeTruthy()
    expect(mine!.riskLevel).toBe("high")
    expect(mine!.peakPerMin).toBe(120)

    const upd = await fetchSelf(
      authRequest(admin, `/api/admin/risk-accounts/${u.id}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "cleared" }),
      })
    )
    expect(upd.status).toBe(200)
    const after = await env.DB.prepare("SELECT status FROM risk_accounts WHERE user_id = ?")
      .bind(u.id)
      .first<{ status: string }>()
    expect(after?.status).toBe("cleared")
  })

  it("非法状态值 → 400；不存在的记录 → 404", async () => {
    const admin = await makeAdmin()
    const bad = await fetchSelf(
      authRequest(admin, "/api/admin/risk-accounts/some-id/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "whatever" }),
      })
    )
    expect(bad.status).toBe(400)

    const missing = await fetchSelf(
      authRequest(admin, "/api/admin/risk-accounts/no-such-user/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "watching" }),
      })
    )
    expect(missing.status).toBe(404)
  })

  it("/api/attention 的 admin 计数带上待处理申诉（新表不能把接口带崩）", async () => {
    const admin = await makeAdmin()
    const res = await fetchSelf(authRequest(admin, "/api/attention"))
    expect(res.status).toBe(200)
    const body = await res.json<{
      admin: { appeals: number; frpApplications: number } | null
    }>()
    expect(typeof body.admin?.appeals).toBe("number")
    expect(typeof body.admin?.frpApplications).toBe("number")
  })
})
