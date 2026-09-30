// 账户注销（迁移 0073）：注销需邮箱验证码二次确认 + 留痕 + 管理端「已注销用户」。
//
// 覆盖：
//   1. 发送注销验证码（走邮件通道，从邮件正文里取出 6 位码）
//   2. 注销必须同时提供「当前密码 + 邮箱验证码」（缺一即 400）
//   3. 密码错误不消耗验证码；验证码错误计入尝试次数
//   4. 成功后：users 行删除 + deleted_users 写入 reason='self' 的留痕
//   5. 管理端用户列表把留痕作为只读「已注销用户」行返回
//   6. root（站长）不可自助注销
//   7. 管理员删号同样写留痕（reason='admin'）
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, setSetting, type TestUser } from "./helpers"

// 出站邮件打桩：注销验证码经 Brevo 通道发出，这里接管并把「验证码」抓出来。
// （测试环境没有 send_email 绑定，只能走 HTTP 通道 —— 与 mailer-brevo.test.ts 同法。）
const BREVO_BODY: string[] = []
let restoreFetch: (() => void) | null = null

beforeEach(async () => {
  BREVO_BODY.length = 0
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.includes("api.brevo.com")) {
      BREVO_BODY.push(String(init?.body ?? ""))
      return new Response(JSON.stringify({ messageId: "ok" }), { status: 200 })
    }
    // 注销会顺带回收外部资源（DNS / Email Routing / R2）。测试用户没有这些资源，
    // 正常不会真的发起调用；万一发了，这里给一个空成功响应兜住，避免打真实网络。
    if (url.includes("api.cloudflare.com")) {
      return new Response(JSON.stringify({ success: true, result: [], result_info: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
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
  await setSetting("brevo_api_key", "k1")
})

afterEach(() => {
  restoreFetch?.()
  restoreFetch = null
})

/** 请求注销验证码，并从最近一封邮件正文里取出 6 位码 */
async function requestCode(u: TestUser): Promise<string> {
  const res = await fetchSelf(
    authRequest(u, "/api/settings/account/delete-code", { method: "POST" })
  )
  expect(res.status).toBe(200)
  const raw = BREVO_BODY.at(-1) ?? ""
  const m = /注销验证码是：(\d{6})/.exec(raw)
  expect(m, "邮件正文应包含 6 位注销验证码").not.toBeNull()
  return m![1]
}

function deleteRequest(u: TestUser, body: Record<string, unknown>): Request {
  return authRequest(u, "/api/settings/account/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("注销验证码", () => {
  it("发送成功并落库（10 分钟有效）", async () => {
    const u = await makeUser()
    const code = await requestCode(u)
    expect(code).toMatch(/^\d{6}$/)

    const row = await env.DB.prepare(
      "SELECT code_hash, attempts, expires_at FROM account_delete_codes WHERE user_id = ?"
    )
      .bind(u.id)
      .first<{ code_hash: string; attempts: number; expires_at: string }>()
    expect(row).not.toBeNull()
    expect(row?.attempts).toBe(0)
    // 存的必须是哈希而不是明文码
    expect(row?.code_hash).not.toBe(code)
  })

  it("站长（root）不可自助注销 → 403", async () => {
    const root = await makeUser({ role: "root" })
    const res = await fetchSelf(
      authRequest(root, "/api/settings/account/delete-code", { method: "POST" })
    )
    expect(res.status).toBe(403)
  })
})

describe("自助注销：双重校验", () => {
  it("只给密码、不给验证码 → 400 INVALID_CODE，账号仍在", async () => {
    const u = await makeUser()
    const res = await fetchSelf(deleteRequest(u, { password: "pass1234" }))
    expect(res.status).toBe(400)
    expect((await res.json<{ code: string }>()).code).toBe("INVALID_CODE")

    const still = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(u.id).first()
    expect(still).not.toBeNull()
  })

  it("密码错误 → 400 INVALID_PASSWORD，且不消耗验证码", async () => {
    const u = await makeUser()
    const code = await requestCode(u)
    const res = await fetchSelf(deleteRequest(u, { password: "wrong-pass", code }))
    expect(res.status).toBe(400)
    expect((await res.json<{ code: string }>()).code).toBe("INVALID_PASSWORD")

    // 验证码未被判错（attempts 仍为 0），账号还在
    const row = await env.DB.prepare(
      "SELECT attempts FROM account_delete_codes WHERE user_id = ?"
    )
      .bind(u.id)
      .first<{ attempts: number }>()
    expect(row?.attempts).toBe(0)
  })

  it("验证码错误 → 400 INVALID_CODE，且计入尝试次数", async () => {
    const u = await makeUser()
    const real = await requestCode(u)
    const wrong = real === "000000" ? "111111" : "000000"
    const res = await fetchSelf(deleteRequest(u, { password: "pass1234", code: wrong }))
    expect(res.status).toBe(400)
    expect((await res.json<{ code: string }>()).code).toBe("INVALID_CODE")

    const row = await env.DB.prepare(
      "SELECT attempts FROM account_delete_codes WHERE user_id = ?"
    )
      .bind(u.id)
      .first<{ attempts: number }>()
    expect(row?.attempts).toBe(1)
  })

  it("站长（root）不可自助注销 → 403", async () => {
    const root = await makeUser({ role: "root" })
    const res = await fetchSelf(deleteRequest(root, { password: "pass1234", code: "123456" }))
    expect(res.status).toBe(403)
  })
})

describe("自助注销：留痕", () => {
  it("密码 + 验证码都正确 → 204，users 行删除且写入 self 留痕", async () => {
    const u = await makeUser()
    const code = await requestCode(u)
    const res = await fetchSelf(deleteRequest(u, { password: "pass1234", code }))
    expect(res.status).toBe(204)

    const gone = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(u.id).first()
    expect(gone).toBeNull()

    const tomb = await env.DB.prepare(
      "SELECT username, email, reason, deleted_by FROM deleted_users WHERE id = ?"
    )
      .bind(u.id)
      .first<{ username: string; email: string; reason: string; deleted_by: string }>()
    expect(tomb).not.toBeNull()
    expect(tomb?.username).toBe(u.username)
    expect(tomb?.reason).toBe("self")
    expect(tomb?.deleted_by).toBe(u.id)

    // 验证码随注销一起清掉，不留残余
    const codeRow = await env.DB.prepare(
      "SELECT user_id FROM account_delete_codes WHERE user_id = ?"
    )
      .bind(u.id)
      .first()
    expect(codeRow).toBeNull()

    // 审计留痕：注销动作本身应被记录。user_id 会被外键（ON DELETE SET NULL）置空，
    // 但审计行必须保留 —— 若写成「删行后再审计」会撞 FK 被静默丢弃。
    const audited = await env.DB.prepare(
      "SELECT user_id, action FROM audit_logs WHERE action = 'user.account.delete' AND detail LIKE ?"
    )
      .bind(`%${u.username}%`)
      .first<{ user_id: string | null; action: string }>()
    expect(audited).not.toBeNull()
    expect(audited?.user_id).toBeNull()
  })

  it("注销后用户名可被重新注册（留痕不占用唯一约束）", async () => {
    const u = await makeUser()
    const code = await requestCode(u)
    await fetchSelf(deleteRequest(u, { password: "pass1234", code }))

    const now = new Date().toISOString()
    // 直接插库：同名用户应能插入成功（users 表已无该行，墓碑在另一张表）
    await env.DB.prepare(
      "INSERT INTO users (id, username, email, password_hash, namespace, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'user', 'active', ?, ?)"
    )
      .bind(`new-${u.id}`, u.username, "reuse@doulor.cn", "x", u.username, now, now)
      .run()

    const n = await env.DB.prepare("SELECT COUNT(*) c FROM users WHERE username = ?")
      .bind(u.username)
      .first<{ c: number }>()
    expect(n?.c).toBe(1)
  })
})

describe("管理端：已注销用户展示", () => {
  it("用户列表把留痕作为只读「已注销用户」行返回", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    const code = await requestCode(u)
    await fetchSelf(deleteRequest(u, { password: "pass1234", code }))

    const res = await fetchSelf(authRequest(admin, "/api/admin/users"))
    expect(res.status).toBe(200)
    const users = (
      await res.json<{
        users: {
          username: string
          deleted: boolean
          status: string
          deletedReason: string | null
          permissions: Record<string, boolean>
        }[]
      }>()
    ).users
    const tomb = users.find((x) => x.username === u.username)
    expect(tomb).toBeDefined()
    expect(tomb?.deleted).toBe(true)
    expect(tomb?.status).toBe("deleted")
    expect(tomb?.deletedReason).toBe("self")
    // 留痕行不参与鉴权：权限一律视为无
    expect(tomb?.permissions).toEqual({ r2: false, ai: false, frp: false, proxy: false })
  })

  it("管理员删号同样写留痕（reason='admin'）", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    const res = await fetchSelf(
      authRequest(admin, `/api/admin/users/${u.username}`, { method: "DELETE" })
    )
    expect(res.status).toBe(204)

    const tomb = await env.DB.prepare("SELECT reason, deleted_by FROM deleted_users WHERE id = ?")
      .bind(u.id)
      .first<{ reason: string; deleted_by: string }>()
    expect(tomb?.reason).toBe("admin")
    expect(tomb?.deleted_by).toBe(admin.id)
  })
})
