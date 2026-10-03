// WorkBuddy 反代网关捐献通道（登录即解锁 AI 权限）。
//
// 背景：本站的 `ai` 权限此前只能靠管理员审核 donations 才能解锁。反代网关
// 自带设备授权接口，登录成功即把账号加进共享池，故这条通道**免审核**：
// 登录成功就直接置 permissions.ai = true。
//
// 这里重点验证几条容易写错的语义：限额、会话归属、终态缓存（网关 poll 成功后
// state 即失效，重复 poll 只能回本地快照）、幂等、以及移除时权限该不该收回。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, setSetting } from "./helpers"
import { resetWb2ApiCache } from "../src/wb2api-client"
import { getPointsBalance } from "../src/points"

const BASE = "https://wb2api.doulor.cn"
const NEWAPI = "https://api.doulor.cn"

interface StubCall {
  url: string
  method: string
}

let calls: StubCall[] = []
let restore: (() => void) | null = null

/**
 * 发起登录时网关池里有哪些账号 —— 本站会在这个时点拍快照。
 *
 * 用例通过设置它来模拟「账号登录前是否已在池中」；默认空池。
 */
let poolUids: string[] = []

/** 发给 NewAPI 的调用（邀请奖励要给它开订阅）；未配置时一律 404 */
let newapiCalls: StubCall[] = []
let newapiHandler:
  | ((url: string, init?: RequestInit) => Response)
  | null = null

/** 模拟「拍池快照时网关不可达」：overview 直接 500 */
let overviewFails = false

/**
 * 打桩出站 fetch：只接管发往反代网关与 NewAPI 的请求，其余（含 SELF.fetch 内部调用）透传。
 * 记录每次调用便于断言「终态命中缓存后不再打上游」。
 *
 * `/panel/api/overview`（池快照）由本函数统一应答，避免每个用例重复处理；
 * 需要控制池内容的用例改 `poolUids` 即可。
 */
function stubWb2Api(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>
): void {
  const original = globalThis.fetch
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    if (url.startsWith(BASE)) {
      calls.push({ url, method: init?.method ?? "GET" })
      if (url.includes("/panel/api/overview")) {
        if (overviewFails) {
          return jsonResponse({ ok: false, error: "boom" }, 500)
        }
        return jsonResponse({
          ok: true,
          total: poolUids.length,
          healthy: poolUids.length,
          cooling: 0,
          disabled: 0,
          accounts: poolUids.map((uid) => ({ uid })),
        })
      }
      return handler(url, init)
    }
    if (url.startsWith(NEWAPI)) {
      newapiCalls.push({ url, method: init?.method ?? "GET" })
      if (newapiHandler) return newapiHandler(url, init)
      return jsonResponse({ success: false, message: "not stubbed" }, 404)
    }
    return original(input as RequestInfo, init)
  }) as unknown as typeof fetch
  globalThis.fetch = stub
  restore = () => {
    globalThis.fetch = original
  }
}

/** 只数发往 poll 的调用（start 会顺带查一次池快照，不能算进来） */
function pollCalls(): number {
  return calls.filter((c) => c.url.includes("/panel/api/login/poll")).length
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/** 默认上游：start 给链接，poll 恒 pending（用例按需覆盖） */
function stubPending() {
  stubWb2Api((url) => {
    if (url.includes("/login/start")) {
      return jsonResponse({ ok: true, url: "https://example.com/oauth", state: "st-1" })
    }
    return jsonResponse({ ok: true, done: false, message: "login ing" })
  })
}

/** 走一遍「发起登录」，返回本站 sessionId */
async function startLogin(user: { cookie: string }): Promise<string> {
  const res = await fetchSelf(
    authRequest(user, "/api/wb2api/login/start", {
      method: "POST",
      body: JSON.stringify({ acknowledged: true }),
    })
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { sessionId: string; url: string }
  expect(body.sessionId).toBeTruthy()
  expect(body.url).toBe("https://example.com/oauth")
  return body.sessionId
}

async function poll(user: { cookie: string }, sessionId: string) {
  const res = await fetchSelf(
    authRequest(user, `/api/wb2api/login/poll?session=${encodeURIComponent(sessionId)}`)
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

/** 直接读库确认权限位 */
async function aiPermission(userId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT permissions FROM users WHERE id = ?")
    .bind(userId)
    .first<{ permissions: string | null }>()
  if (!row?.permissions) return true // NULL = 全开
  return JSON.parse(row.permissions).ai === true
}

/**
 * 造一对「被邀请人 + 邀请人」：被邀请人用邀请人的码注册（users.invite_code_id），
 * 邀请人已开通中转站（newapi_accounts 有行，否则发不了订阅）。
 */
async function seedInviteeWithInviter(): Promise<{
  invitee: Awaited<ReturnType<typeof makeUser>>
  inviterId: string
}> {
  const inviter = await makeUser()
  const now = new Date().toISOString()
  const codeId = `code-${inviter.id}`
  await env.DB.prepare(
    "INSERT INTO invite_codes (id, code, created_by, max_uses, used_count, created_at) VALUES (?, ?, ?, 10, 1, ?)"
  )
    .bind(codeId, `CODE${inviter.id.slice(0, 8)}`, inviter.id, now)
    .run()
  // newapi_user_id 有唯一索引 —— 用例共用同一 D1，取随机数避免撞号
  const newapiUserId = Math.floor(Math.random() * 1_000_000) + 1000
  await env.DB.prepare(
    `INSERT INTO newapi_accounts (user_id, newapi_user_id, username, email, enc_token, quota, used_quota, request_count, created_at)
     VALUES (?, ?, ?, ?, 'x', 0, 0, 0, ?)`
  )
    .bind(inviter.id, newapiUserId, inviter.username, `${inviter.username}@doulor.cn`, now)
    .run()

  const invitee = await makeUser()
  await env.DB.prepare("UPDATE users SET invite_code_id = ? WHERE id = ?")
    .bind(codeId, invitee.id)
    .run()
  return { invitee, inviterId: inviter.id }
}

beforeEach(async () => {
  calls = []
  newapiCalls = []
  newapiHandler = null
  poolUids = []
  overviewFails = false
  // 凭据走 5 秒内存缓存且测试共用同一 isolate —— 每个用例都从干净状态开始
  resetWb2ApiCache()
  // 限流计数表也在同一 isolate 里累积：start 有 IP 维度限额（10 次/10 分钟），
  // 用例多跑几轮就会撞上，清空后每个用例从零开始。
  await env.DB.prepare("DELETE FROM rate_limits").run()
  // 邀请奖励记录是全局表，用例之间会互相干扰（同一被邀请人只发一次）
  await env.DB.prepare("DELETE FROM invite_rewards").run()
  // 用例之间可能改过限额，重置为默认
  await setSetting("wb2api_max_bindings", "3")
  await setSetting("wb2api_enabled", "1")
  await setSetting("invite_reward_enabled", "1")
  await setSetting("invite_reward_plan_id", "2")
})

afterEach(() => {
  restore?.()
  restore = null
  resetWb2ApiCache()
})

describe("POST /api/wb2api/login/start", () => {
  it("未勾选免责声明 → 400，且不打上游", async () => {
    const u = await makeUser()
    stubPending()
    const res = await fetchSelf(
      authRequest(u, "/api/wb2api/login/start", {
        method: "POST",
        body: JSON.stringify({ acknowledged: false }),
      })
    )
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it("上游 401（本站密钥不对）→ 502 + 可读文案，绝不能兜底成 500", async () => {
    const u = await makeUser()
    // 2026-10-01 站长报「捐献 workbuddy 反代节点显示内部错误」：
    // 当时网关 config.json 的 api_key 与本站库里存的差一个大小写 + 一个句点，
    // 网关回 401。但 Wb2UnauthorizedError 是裸 Error，loginStart 没捕获，
    // 冒泡到 index.ts 的兜底 ⇒ 用户看到 500「服务器内部错误」，
    // 把一个「改密钥就能好」的问题呈现成「代码坏了」。
    stubWb2Api(() => jsonResponse({ ok: false, error: "invalid_api_key" }, 401))
    const res = await fetchSelf(
      authRequest(u, "/api/wb2api/login/start", {
        method: "POST",
        body: JSON.stringify({ acknowledged: true }),
      })
    )
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: string; code: string }
    expect(body.code).toBe("WB2API_UNAUTHORIZED")
    expect(body.error).toContain("拒绝")
    // 上游原文（可能带请求细节）不得回显给前端
    expect(body.error).not.toContain("invalid_api_key")
  })

  it("通道关闭 → 403", async () => {
    const u = await makeUser()
    stubPending()
    await setSetting("wb2api_enabled", "0")
    const res = await fetchSelf(
      authRequest(u, "/api/wb2api/login/start", {
        method: "POST",
        body: JSON.stringify({ acknowledged: true }),
      })
    )
    expect(res.status).toBe(403)
  })

  it("已绑满限额 → 409，且不打上游", async () => {
    const u = await makeUser()
    stubPending()
    await setSetting("wb2api_max_bindings", "1")
    // 先造一个 active 绑定占满额度
    await env.DB.prepare(
      `INSERT INTO wb2api_bindings
         (id, user_id, uid, nickname, realm, status, granted_ai_permission, created_at)
       VALUES ('b1', ?, 'uid-existing', 'x', 'global', 'active', 1, ?)`
    )
      .bind(u.id, new Date().toISOString())
      .run()

    const res = await fetchSelf(
      authRequest(u, "/api/wb2api/login/start", {
        method: "POST",
        body: JSON.stringify({ acknowledged: true }),
      })
    )
    expect(res.status).toBe(409)
    expect(calls).toHaveLength(0)
  })

  it("返回授权链接与本站 sessionId，不泄露上游 state", async () => {
    const u = await makeUser()
    stubPending()
    const res = await fetchSelf(
      authRequest(u, "/api/wb2api/login/start", {
        method: "POST",
        body: JSON.stringify({ acknowledged: true }),
      })
    )
    const body = (await res.json()) as Record<string, unknown>
    expect(body.url).toBe("https://example.com/oauth")
    expect(body.sessionId).toBeTruthy()
    // 上游 state 绝不能出现在响应里（它是换取 token 的凭据）
    expect(JSON.stringify(body)).not.toContain("st-1")
  })

  // ---- realm 由捐献者自选（2026-09-30 起）----

  /** 打桩并记录每次 start 请求里上游收到的 realm */
  function stubStartCapturing(seen: string[]): void {
    stubWb2Api((url, init) => {
      if (url.includes("/login/start")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { realm?: string }
        seen.push(String(body.realm))
        return jsonResponse({ ok: true, url: "https://example.com/oauth", state: "st-1" })
      }
      return jsonResponse({ ok: true, done: false, message: "login ing" })
    })
  }

  it("用户选了国际版 → 上游收到 global，响应与会话落库都是 global", async () => {
    const u = await makeUser()
    const seen: string[] = []
    stubStartCapturing(seen)

    const res = await fetchSelf(
      authRequest(u, "/api/wb2api/login/start", {
        method: "POST",
        body: JSON.stringify({ acknowledged: true, realm: "global" }),
      })
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { realm: string }).realm).toBe("global")
    expect(seen).toEqual(["global"])

    // 会话必须落库成 global —— poll 成功后绑定行存的是这里的值
    const row = await env.DB.prepare(
      "SELECT realm FROM wb2api_login_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1"
    )
      .bind(u.id)
      .first<{ realm: string }>()
    expect(row?.realm).toBe("global")
  })

  it("不传 realm → 用管理员设的默认（wb2api_realm）", async () => {
    const u = await makeUser()
    const seen: string[] = []
    await setSetting("wb2api_realm", "global")
    stubStartCapturing(seen)

    const res = await fetchSelf(
      authRequest(u, "/api/wb2api/login/start", {
        method: "POST",
        body: JSON.stringify({ acknowledged: true }),
      })
    )
    expect(res.status).toBe(200)
    expect(seen).toEqual(["global"])
  })

  it("realm 传非法值 → 忽略并回落默认，绝不把任意字符串透给上游", async () => {
    const u = await makeUser()
    const seen: string[] = []
    await setSetting("wb2api_realm", "cn")
    stubStartCapturing(seen)

    const res = await fetchSelf(
      authRequest(u, "/api/wb2api/login/start", {
        method: "POST",
        body: JSON.stringify({ acknowledged: true, realm: "'; DROP TABLE users--" }),
      })
    )
    expect(res.status).toBe(200)
    expect(seen).toEqual(["cn"])
  })
})

describe("GET /api/wb2api/login/poll", () => {
  it("登录未完成 → pending", async () => {
    const u = await makeUser()
    stubPending()
    const sid = await startLogin(u)
    const r = await poll(u, sid)
    expect(r.status).toBe(200)
    expect(r.body.status).toBe("pending")
  })

  it("别人的 session → 403", async () => {
    const a = await makeUser()
    const b = await makeUser()
    stubPending()
    const sid = await startLogin(a)
    const r = await poll(b, sid)
    expect(r.status).toBe(403)
  })

  it("登录成功 → 绑定落库 + 解锁 ai 权限", async () => {
    const u = await makeUser()
    // 先显式关掉 ai（模拟「没有权限的新用户」）
    await env.DB.prepare("UPDATE users SET permissions = ? WHERE id = ?")
      .bind(JSON.stringify({ r2: true, ai: false, frp: true, profile: true, proxy: true }), u.id)
      .run()
    expect(await aiPermission(u.id)).toBe(false)

    stubWb2Api((url) => {
      if (url.includes("/login/start")) {
        return jsonResponse({ ok: true, url: "https://example.com/oauth", state: "st-1" })
      }
      return jsonResponse({
        ok: true,
        done: true,
        uid: "uid-abc",
        nickname: "测试账号",
        realm: "global",
        credits: 100,
        credits_total: 200,
      })
    })

    const sid = await startLogin(u)
    const r = await poll(u, sid)
    expect(r.body.status).toBe("done")
    expect((r.body.result as Record<string, unknown>).uid).toBe("uid-abc")

    expect(await aiPermission(u.id)).toBe(true)
    const binding = await env.DB.prepare(
      "SELECT * FROM wb2api_bindings WHERE uid = 'uid-abc'"
    ).first<{ user_id: string; status: string; granted_ai_permission: number }>()
    expect(binding?.user_id).toBe(u.id)
    expect(binding?.status).toBe("active")
    expect(binding?.granted_ai_permission).toBe(1)

    // 绑定成功不发任何邀请码额度（避免「绑几个号 = 白拿几个码」的刷量口子）
    const quota = await env.DB.prepare(
      "SELECT invite_quota_bonus FROM users WHERE id = ?"
    )
      .bind(u.id)
      .first<{ invite_quota_bonus: number | null }>()
    expect(quota?.invite_quota_bonus ?? 0).toBe(0)
  })

  it("带来新账号 → 发捐献奖励积分（WorkBuddy 默认 10 分）", async () => {
    const u = await makeUser()
    stubWb2Api((url) => {
      if (url.includes("/login/start")) {
        return jsonResponse({ ok: true, url: "https://example.com/oauth", state: "st-1" })
      }
      return jsonResponse({ ok: true, done: true, uid: "uid-points", nickname: "n" })
    })

    const sid = await startLogin(u)
    expect((await poll(u, sid)).body.status).toBe("done")

    expect(await getPointsBalance(env, u.id)).toBe(10)
    const tx = await env.DB.prepare(
      "SELECT reason, detail, delta FROM point_transactions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1"
    )
      .bind(u.id)
      .first<{ reason: string; detail: string; delta: number }>()
    expect(tx?.reason).toBe("donation")
    expect(tx?.delta).toBe(10)
    expect(tx?.detail).toContain("WorkBuddy")
  })

  it("登录前已在池中的账号 → 照常绑定，但不发捐献奖励积分", async () => {
    const u = await makeUser()
    // 这个账号登录前就已经在网关池里（管理员手动加的），用户并没有给池子添东西
    poolUids = ["uid-points-pool"]
    stubWb2Api((url) => {
      if (url.includes("/login/start")) {
        return jsonResponse({ ok: true, url: "https://example.com/oauth", state: "st-1" })
      }
      return jsonResponse({ ok: true, done: true, uid: "uid-points-pool", nickname: "n" })
    })

    const sid = await startLogin(u)
    expect((await poll(u, sid)).body.status).toBe("done")

    expect(await getPointsBalance(env, u.id)).toBe(0)
  })

  it("登录前已在池中的账号 → 照常绑定 + 授权限，但不发邀请奖励", async () => {
    const { invitee, inviterId } = await seedInviteeWithInviter()
    await env.DB.prepare("UPDATE users SET permissions = ? WHERE id = ?")
      .bind(JSON.stringify({ r2: true, ai: false, frp: true, profile: true, proxy: true }), invitee.id)
      .run()
    // 登录前这个账号就已经在网关池里（管理员手动加的 / 历史遗留）
    poolUids = ["uid-in-pool"]
    stubWb2Api((url) => {
      if (url.includes("/login/start")) {
        return jsonResponse({ ok: true, url: "https://example.com/oauth", state: "st-1" })
      }
      return jsonResponse({ ok: true, done: true, uid: "uid-in-pool", nickname: "n" })
    })

    const sid = await startLogin(invitee)
    const r = await poll(invitee, sid)

    // 不再拒绝（历史 bug：账号已进池、本站却没落库，用户重试被自己挡死）
    expect(r.body.status).toBe("done")
    expect(await aiPermission(invitee.id)).toBe(true)
    const n = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM wb2api_bindings WHERE uid = 'uid-in-pool'"
    ).first<{ c: number }>()
    expect(n?.c).toBe(1)
    // 没带来新资源 → 不给邀请人发订阅
    expect(newapiCalls).toHaveLength(0)
    const reward = await env.DB.prepare(
      "SELECT 1 AS x FROM invite_rewards WHERE invitee_user_id = ?"
    )
      .bind(invitee.id)
      .first()
    expect(reward).toBeNull()
    expect(inviterId).toBeTruthy()
  })

  it("登录前不在池中（带来新账号）→ 发邀请奖励订阅给邀请人", async () => {
    const { invitee, inviterId } = await seedInviteeWithInviter()
    await env.DB.prepare("UPDATE users SET permissions = ? WHERE id = ?")
      .bind(JSON.stringify({ r2: true, ai: false, frp: true, profile: true, proxy: true }), invitee.id)
      .run()
    poolUids = [] // 空池 ⇒ 这个账号是用户带来的
    stubWb2Api((url) => {
      if (url.includes("/login/start")) {
        return jsonResponse({ ok: true, url: "https://example.com/oauth", state: "st-1" })
      }
      return jsonResponse({ ok: true, done: true, uid: "uid-new", nickname: "n" })
    })
    newapiHandler = () => jsonResponse({ success: true, message: "ok" })

    const sid = await startLogin(invitee)
    await poll(invitee, sid)

    // 给邀请人开了一张订阅（套餐 2）
    const subCall = newapiCalls.find((c) => c.url.includes("/subscriptions"))
    expect(subCall).toBeTruthy()
    const reward = await env.DB.prepare(
      "SELECT inviter_user_id, plan_id FROM invite_rewards WHERE invitee_user_id = ?"
    )
      .bind(invitee.id)
      .first<{ inviter_user_id: string; plan_id: number }>()
    expect(reward?.inviter_user_id).toBe(inviterId)
    expect(reward?.plan_id).toBe(2)
  })

  it("池快照查询失败 → 不阻断绑定，但不发奖励", async () => {
    const { invitee } = await seedInviteeWithInviter()
    await env.DB.prepare("UPDATE users SET permissions = ? WHERE id = ?")
      .bind(JSON.stringify({ r2: true, ai: false, frp: true, profile: true, proxy: true }), invitee.id)
      .run()
    // overview 挂掉：快照落 null
    overviewFails = true
    stubWb2Api((url) => {
      if (url.includes("/login/start")) {
        return jsonResponse({ ok: true, url: "https://example.com/oauth", state: "st-1" })
      }
      return jsonResponse({ ok: true, done: true, uid: "uid-nosnap", nickname: "n" })
    })

    const sid = await startLogin(invitee)
    const r = await poll(invitee, sid)
    expect(r.body.status).toBe("done")
    expect(newapiCalls).toHaveLength(0)
  })

  it("终态缓存：done 之后重复 poll 不再打上游", async () => {
    const u = await makeUser()
    stubWb2Api((url) => {
      if (url.includes("/login/start")) {
        return jsonResponse({ ok: true, url: "https://example.com/oauth", state: "st-1" })
      }
      return jsonResponse({ ok: true, done: true, uid: "uid-cache", nickname: "n" })
    })

    const sid = await startLogin(u)
    await poll(u, sid)
    const afterFirst = calls.length

    const again = await poll(u, sid)
    expect(again.body.status).toBe("done")
    // 网关 poll 成功一次后 state 即失效，重复打上游只会 404 —— 必须命中本地快照
    expect(calls.length).toBe(afterFirst)
  })

  it("上游 404（state 已失效）→ 落 failed 终态", async () => {
    const u = await makeUser()
    stubWb2Api((url) => {
      if (url.includes("/login/start")) {
        return jsonResponse({ ok: true, url: "https://example.com/oauth", state: "st-1" })
      }
      return jsonResponse({ ok: false, error: "unknown or expired state" }, 404)
    })

    const sid = await startLogin(u)
    const r = await poll(u, sid)
    expect(r.body.status).toBe("failed")
    expect(String(r.body.message)).toContain("失效")

    // 第二次仍是 failed，且不再打上游
    const before = calls.length
    const again = await poll(u, sid)
    expect(again.body.status).toBe("failed")
    expect(calls.length).toBe(before)
  })

  it("同一用户重复登录同一账号 → 幂等，不二次授权", async () => {
    const u = await makeUser()
    await env.DB.prepare("UPDATE users SET permissions = ? WHERE id = ?")
      .bind(JSON.stringify({ r2: true, ai: false, frp: true, profile: true, proxy: true }), u.id)
      .run()

    let pollCount = 0
    stubWb2Api((url) => {
      if (url.includes("/login/start")) {
        return jsonResponse({ ok: true, url: "https://example.com/oauth", state: "st-1" })
      }
      pollCount += 1
      return jsonResponse({ ok: true, done: true, uid: "uid-dup", nickname: "n" })
    })

    const sid1 = await startLogin(u)
    await poll(u, sid1)
    // 手工把权限改回 false，以便观察第二次是否重复授权
    await env.DB.prepare("UPDATE users SET permissions = ? WHERE id = ?")
      .bind(JSON.stringify({ r2: true, ai: false, frp: true, profile: true, proxy: true }), u.id)
      .run()

    const sid2 = await startLogin(u)
    const r2 = await poll(u, sid2)
    expect(r2.body.status).toBe("done")
    expect((r2.body.result as Record<string, unknown>).alreadyBound).toBe(true)
    // 已有绑定 → 不再授予权限（权限本就该是当初给过的那次）
    expect(await aiPermission(u.id)).toBe(false)

    const n = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM wb2api_bindings WHERE uid = 'uid-dup'"
    ).first<{ c: number }>()
    expect(n?.c).toBe(1)
    // 两次登录各 poll 一次（start 里的池快照查询不算）
    expect(pollCalls()).toBe(2)
  })

  it("不同用户抢绑同一账号 → 409，且不动原绑主", async () => {
    const a = await makeUser()
    const b = await makeUser()
    stubWb2Api((url) => {
      if (url.includes("/login/start")) {
        return jsonResponse({ ok: true, url: "https://example.com/oauth", state: "st-1" })
      }
      return jsonResponse({ ok: true, done: true, uid: "uid-taken", nickname: "n" })
    })

    const sidA = await startLogin(a)
    await poll(a, sidA)

    const sidB = await startLogin(b)
    const r = await poll(b, sidB)
    expect(r.status).toBe(409)

    // 原绑主不受影响（不能去调网关 remove，那会摘掉别人可用的账号）
    const binding = await env.DB.prepare(
      "SELECT user_id FROM wb2api_bindings WHERE uid = 'uid-taken'"
    ).first<{ user_id: string }>()
    expect(binding?.user_id).toBe(a.id)
  })
})

describe("管理端移除绑定", () => {
  /** 造一个「仅此一个绑定」的场景并返回绑定 id */
  async function seedBinding(
    userId: string,
    uid: string,
    grantedAi: number
  ): Promise<string> {
    const id = `bind-${uid}`
    await env.DB.prepare(
      `INSERT INTO wb2api_bindings
         (id, user_id, uid, nickname, realm, status, granted_ai_permission, created_at)
       VALUES (?, ?, ?, 'n', 'global', 'active', ?, ?)`
    )
      .bind(id, userId, uid, grantedAi, new Date().toISOString())
      .run()
    return id
  }

  function setPerms(userId: string, ai: boolean) {
    return env.DB.prepare("UPDATE users SET permissions = ? WHERE id = ?")
      .bind(JSON.stringify({ r2: true, ai, frp: true, profile: true, proxy: true }), userId)
      .run()
  }

  beforeEach(() => {
    stubWb2Api(() => jsonResponse({ ok: true }))
  })

  it("仅有本绑定且由本绑定授予 → 收回 ai", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    await setPerms(u.id, true)
    const id = await seedBinding(u.id, "uid-only", 1)

    const res = await fetchSelf(
      authRequest(admin, `/api/admin/wb2api/bindings/${id}/remove`, {
        method: "POST",
        body: JSON.stringify({}),
      })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { aiRevoked: boolean }
    expect(body.aiRevoked).toBe(true)
    expect(await aiPermission(u.id)).toBe(false)
  })

  it("还有其他 active 绑定 → 保留 ai", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    await setPerms(u.id, true)
    const id = await seedBinding(u.id, "uid-1", 1)
    await seedBinding(u.id, "uid-2", 0)

    const res = await fetchSelf(
      authRequest(admin, `/api/admin/wb2api/bindings/${id}/remove`, {
        method: "POST",
        body: JSON.stringify({}),
      })
    )
    const body = (await res.json()) as { aiRevoked: boolean }
    expect(body.aiRevoked).toBe(false)
    expect(await aiPermission(u.id)).toBe(true)
  })

  it("有 approved 的 ai 捐献 → 保留 ai", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    await setPerms(u.id, true)
    const id = await seedBinding(u.id, "uid-don", 1)
    await env.DB.prepare(
      `INSERT INTO donations
         (id, user_id, type, payload, notify_email, status, created_at)
       VALUES ('d1', ?, 'ai', '{}', 'x@example.com', 'approved', ?)`
    )
      .bind(u.id, new Date().toISOString())
      .run()

    const res = await fetchSelf(
      authRequest(admin, `/api/admin/wb2api/bindings/${id}/remove`, {
        method: "POST",
        body: JSON.stringify({}),
      })
    )
    const body = (await res.json()) as { aiRevoked: boolean }
    expect(body.aiRevoked).toBe(false)
    expect(await aiPermission(u.id)).toBe(true)
  })

  it("管理员显式 revokeAi 可覆盖自动判定", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    await setPerms(u.id, true)
    const id = await seedBinding(u.id, "uid-force", 0)

    const res = await fetchSelf(
      authRequest(admin, `/api/admin/wb2api/bindings/${id}/remove`, {
        method: "POST",
        body: JSON.stringify({ revokeAi: true }),
      })
    )
    const body = (await res.json()) as { aiRevoked: boolean }
    expect(body.aiRevoked).toBe(true)
    expect(await aiPermission(u.id)).toBe(false)
  })

  it("普通用户调用 → 403", async () => {
    const u = await makeUser()
    const id = await seedBinding(u.id, "uid-noperm", 1)
    const res = await fetchSelf(
      authRequest(u, `/api/admin/wb2api/bindings/${id}/remove`, {
        method: "POST",
        body: JSON.stringify({}),
      })
    )
    expect(res.status).toBe(403)
  })

  it("网关移除失败 → 本地照常标记，但返回 warning", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    await setPerms(u.id, true)
    const id = await seedBinding(u.id, "uid-fail", 1)
    stubWb2Api(() => jsonResponse({ ok: false, error: "boom" }, 500))

    const res = await fetchSelf(
      authRequest(admin, `/api/admin/wb2api/bindings/${id}/remove`, {
        method: "POST",
        body: JSON.stringify({}),
      })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { upstreamWarning: string | null }
    expect(body.upstreamWarning).toBeTruthy()

    const row = await env.DB.prepare(
      "SELECT status FROM wb2api_bindings WHERE id = ?"
    )
      .bind(id)
      .first<{ status: string }>()
    expect(row?.status).toBe("removed")
  })
})

describe("GET /api/donations 附带 wb2api 概况", () => {
  it("返回额度与绑定列表", async () => {
    const u = await makeUser()
    const res = await fetchSelf(authRequest(u, "/api/donations"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      wb2api: { limit: number; used: number; remaining: number; feature: string }
    }
    expect(body.wb2api.limit).toBe(3)
    expect(body.wb2api.used).toBe(0)
    expect(body.wb2api.remaining).toBe(3)
    expect(body.wb2api.feature).toBe("ai")
  })
})
