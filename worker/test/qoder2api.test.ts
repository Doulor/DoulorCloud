// Qoder2API 反代网关捐献通道（登录即解锁 AI 权限）。
//
// 与 wb2api 那条通道同构（都是「用户登录自己的上游账号 → 账号进共享池 → 免审核解锁 ai」），
// 但接口形态完全不同，这里重点锁住几条容易写错的语义：
//
//   1. **面板会话是内存态**：上游 `POST /panel/login` 换来的 token 存在进程内存里，
//      容器一重启就失效 ⇒ 数据面请求收到 401 必须**自动重登一次再重试**；
//   2. `/accounts/login/start` **一次性**给出授权链接，poll 才拿结果（两步，不是三步）；
//   3. 账号由**上游在授权成功那一刻创建** ⇒ 本站没有「僵尸账号」要清，只有本地会话行；
//   4. 该通道**固定对接 Qoder**，没有 provider 可切，realm 只有 cn / intl；
//   5. `/accounts` 默认只列当前面板区域的账号 ⇒ 必须分区各拉一次再合并；
//   6. 移除绑定时「还有别的依据就保留 ai 权限」。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, setSetting, setPermissions, type TestUser } from "./helpers"
import {
  resetQoder2ApiCache,
  saveQoder2ApiPassword,
  normalizeRealm,
  q2ListAccounts,
} from "../src/qoder2api-client"
import { getPointsBalance } from "../src/points"
import { uuid } from "../src/crypto"

const BASE = "https://q2.test"

interface StubCall {
  url: string
  method: string
}

let calls: StubCall[] = []
let restore: (() => void) | null = null

/** 上游 `/accounts/*` 的应答（各用例按需覆盖；默认空对象） */
let upstream: (url: string, init?: RequestInit) => Response | Promise<Response> = () =>
  jsonResponse({})

/** `/panel/login` 是否拒绝（模拟面板密码不对） */
let panelFails = false
/** 已签发的会话 token 序号（用于断言「重登了一次」） */
let panelTokens = 0

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/**
 * 打桩出站 fetch：只接管发往测试网关 BASE 的请求，其余透传。
 * `/panel/login` 由本函数统一应答（记录签发次数），`/accounts/*` 交给 `upstream`。
 */
function stubUpstream(): void {
  const original = globalThis.fetch
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith(BASE)) {
      calls.push({ url, method: init?.method ?? "GET" })
      if (url.includes("/panel/login")) {
        if (panelFails) {
          return jsonResponse({ error: { message: "面板密码错误" } }, 401)
        }
        return jsonResponse({ token: `tk-${++panelTokens}` })
      }
      return upstream(url, init)
    }
    return original(input as RequestInfo, init)
  }) as unknown as typeof fetch
  globalThis.fetch = stub
  restore = () => {
    globalThis.fetch = original
  }
}

/** 发往 panel/login 的调用次数 */
function panelLoginCalls(): number {
  return calls.filter((c) => c.url.includes("/panel/login")).length
}

/** 走管理端真实路径配置一个可用面板密码（会探测一次上游） */
async function configure(): Promise<void> {
  await saveQoder2ApiPassword(env, "panel-pw")
}

async function startLogin(user: TestUser): Promise<{ sessionId: string; authUrl: string }> {
  const res = await fetchSelf(
    authRequest(user, "/api/qoder2api/login/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ acknowledged: true }),
    })
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { sessionId: string; authUrl: string; realm: string }
  expect(body.sessionId).toBeTruthy()
  expect(body.realm).toBe("cn")
  return { sessionId: body.sessionId, authUrl: body.authUrl }
}

async function poll(user: TestUser, sessionId: string) {
  const res = await fetchSelf(
    authRequest(user, `/api/qoder2api/login/poll?session=${encodeURIComponent(sessionId)}`)
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

/** 直接插一条 active 绑定（模拟用户已捐过一个号） */
async function insertBinding(userId: string, accountId = `acc_${uuid()}`): Promise<string> {
  const id = uuid()
  await env.DB.prepare(
    `INSERT INTO qoder2api_bindings
       (id, user_id, account_id, realm, nickname, status, granted_ai_permission, created_at)
     VALUES (?, ?, ?, 'cn', '已有账号', 'active', 1, ?)`
  )
    .bind(id, userId, accountId, new Date().toISOString())
    .run()
  return id
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM qoder2api_bindings").run()
  await env.DB.prepare("DELETE FROM qoder2api_login_sessions").run()
  await env.DB.prepare("DELETE FROM qoder2api_credentials").run()
  await env.DB.prepare("DELETE FROM rate_limits").run()
  await env.DB.prepare("DELETE FROM point_transactions").run()
  await env.DB.prepare("DELETE FROM user_points").run()
  await env.DB.prepare(
    "DELETE FROM app_settings WHERE key LIKE 'qoder2api%' OR key = 'donation_grant_qoder2api'"
  ).run()

  await setSetting("qoder2api_base_url", BASE)
  calls = []
  panelFails = false
  panelTokens = 0
  upstream = () => jsonResponse({})
  resetQoder2ApiCache()
  stubUpstream()
})

afterEach(() => {
  restore?.()
  restore = null
})

describe("realm 收敛", () => {
  it("只认 cn / intl，认不出一律回 cn", () => {
    expect(normalizeRealm("CN")).toBe("cn")
    expect(normalizeRealm("intl")).toBe("intl")
    expect(normalizeRealm("global")).toBe("cn") // wb2api 的叫法，这里不认
    expect(normalizeRealm("")).toBe("cn")
    expect(normalizeRealm(null)).toBe("cn")
  })
})

describe("通道门禁", () => {
  it("未配置面板密码：configured=false，发起登录报 503", async () => {
    const u = await makeUser()

    const status = (await (
      await fetchSelf(authRequest(u, "/api/qoder2api/status"))
    ).json()) as { configured: boolean; enabled: boolean }
    expect(status.enabled).toBe(true)
    expect(status.configured).toBe(false)

    const res = await fetchSelf(
      authRequest(u, "/api/qoder2api/login/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acknowledged: true }),
      })
    )
    expect(res.status).toBe(503)
  })

  it("通道关闭时发起登录报 403", async () => {
    await configure()
    await setSetting("qoder2api_enabled", "0")
    const u = await makeUser()

    const res = await fetchSelf(
      authRequest(u, "/api/qoder2api/login/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acknowledged: true }),
      })
    )
    expect(res.status).toBe(403)
  })

  it("未勾选免责声明 → 400", async () => {
    await configure()
    const u = await makeUser()
    const res = await fetchSelf(
      authRequest(u, "/api/qoder2api/login/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    )
    expect(res.status).toBe(400)
  })

  it("未登录访问状态接口 → 401", async () => {
    const res = await fetchSelf(
      new Request("https://cloud.doulor.cn/api/qoder2api/status")
    )
    expect(res.status).toBe(401)
  })
})

describe("登录 → 绑定 → 解锁", () => {
  it("完整两步登录：start 给链接、poll pending → ok 落绑定并解锁 ai", async () => {
    await configure()
    const u = await makeUser()
    // 显式「还没有 ai」：否则 NULL permissions 视为全开，就不算「本次解锁」
    await setPermissions(u.id, JSON.stringify({ ai: false }))

    upstream = (url) => {
      if (url.includes("/accounts/login/start")) {
        return jsonResponse({ state: "st-1", authUrl: "https://qoder.test/auth", realm: "cn" })
      }
      return jsonResponse({ status: "pending" })
    }

    const { sessionId, authUrl } = await startLogin(u)
    expect(authUrl).toBe("https://qoder.test/auth")

    // 第一次 poll：上游还在等浏览器授权
    const p1 = await poll(u, sessionId)
    expect(p1.status).toBe(200)
    expect(p1.body.status).toBe("pending")
    expect(p1.body.authUrl).toBe("https://qoder.test/auth")

    // 用户在浏览器完成授权 → 上游下一次 poll 即 ok
    upstream = () =>
      jsonResponse({ status: "ok", account: { uid: "acc_1", nickname: "我的 Qoder", realm: "cn" } })

    const p2 = await poll(u, sessionId)
    expect(p2.body.status).toBe("done")
    const result = p2.body.result as Record<string, unknown>
    expect(result.accountId).toBe("acc_1")
    expect(result.realm).toBe("cn")
    expect(result.aiGranted).toBe(true)
    expect(result.alreadyBound).toBe(false)

    // 落库：一条 active 绑定
    const binding = await env.DB.prepare(
      "SELECT * FROM qoder2api_bindings WHERE user_id = ?"
    )
      .bind(u.id)
      .first<{ account_id: string; status: string; realm: string }>()
    expect(binding?.account_id).toBe("acc_1")
    expect(binding?.status).toBe("active")
    expect(binding?.realm).toBe("cn")

    // 解锁 ai 权限 + 发捐献积分（默认档位 10）
    expect(await aiPermission(u.id)).toBe(true)
    expect(await getPointsBalance(env, u.id)).toBe(10)
  })

  it("重复登录同一个上游账号：幂等返回，不再二次发积分", async () => {
    await configure()
    const u = await makeUser()
    await setPermissions(u.id, JSON.stringify({ ai: false }))
    const account = { uid: "acc_dup", nickname: "重复", realm: "cn" }

    const runOnce = async () => {
      upstream = (url) => {
        if (url.includes("/accounts/login/start")) {
          return jsonResponse({ state: `st-${uuid()}`, authUrl: "https://qoder.test/auth", realm: "cn" })
        }
        return jsonResponse({ status: "ok", account })
      }
      const { sessionId } = await startLogin(u)
      return (await poll(u, sessionId)).body
    }

    const first = (await runOnce()).result as Record<string, unknown>
    expect(first.alreadyBound).toBe(false)
    expect(await getPointsBalance(env, u.id)).toBe(10)

    const second = (await runOnce()).result as Record<string, unknown>
    expect(second.alreadyBound).toBe(true)
    expect(second.aiGranted).toBe(false)
    // 绑定还是一条，积分没有翻倍
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM qoder2api_bindings WHERE user_id = ?"
    )
      .bind(u.id)
      .first<{ c: number }>()
    expect(count?.c).toBe(1)
    expect(await getPointsBalance(env, u.id)).toBe(10)
  })

  it("上游会话失效（404）→ poll 回 failed，不让前端一直转圈", async () => {
    await configure()
    const u = await makeUser()

    upstream = (url) => {
      if (url.includes("/accounts/login/start")) {
        return jsonResponse({ state: "st-gone", authUrl: "https://qoder.test/auth", realm: "cn" })
      }
      return jsonResponse({ error: { message: "unknown state" } }, 404)
    }

    const { sessionId } = await startLogin(u)
    const p = await poll(u, sessionId)
    expect(p.body.status).toBe("failed")
    expect(String(p.body.message)).toContain("失效")
  })

  it("超出 max_bindings → 409", async () => {
    await configure()
    await setSetting("qoder2api_max_bindings", "1")
    const u = await makeUser()
    await insertBinding(u.id)
    await env.DB.prepare("DELETE FROM rate_limits").run()

    const res = await fetchSelf(
      authRequest(u, "/api/qoder2api/login/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acknowledged: true }),
      })
    )
    expect(res.status).toBe(409)
  })
})

describe("面板会话自愈", () => {
  it("数据面 401 → 自动重登一次再重试，用户无感", async () => {
    await configure()
    const before = panelLoginCalls()

    let first = true
    upstream = (url) => {
      if (url.includes("/accounts/login/start")) {
        if (first) {
          first = false
          // 模拟「上游容器重启后内存会话丢了」
          return jsonResponse({ error: { message: "invalid panel session" } }, 401)
        }
        return jsonResponse({ state: "st-2", authUrl: "https://qoder.test/auth", realm: "cn" })
      }
      return jsonResponse({})
    }

    const u = await makeUser()
    const { authUrl } = await startLogin(u)
    expect(authUrl).toBe("https://qoder.test/auth")
    // 原来那次 401 之外，又重登了一次
    expect(panelLoginCalls()).toBe(before + 2)
  })
})

describe("上游账号池", () => {
  it("cn / intl 各拉一次再合并（否则看不到另一个区的号）", async () => {
    await configure()

    upstream = (url) => {
      if (url.includes("realm=intl")) {
        return jsonResponse({ accounts: [{ uid: "acc_intl", nickname: "国际", realm: "intl" }] })
      }
      return jsonResponse({ accounts: [{ uid: "acc_cn", nickname: "国内", realm: "cn" }] })
    }

    const list = await q2ListAccounts(env)
    expect(list.map((a) => a.uid).sort()).toEqual(["acc_cn", "acc_intl"])
    expect(list.find((a) => a.uid === "acc_intl")?.realm).toBe("intl")
    expect(calls.filter((c) => c.url.includes("/accounts?realm=")).length).toBe(2)
  })
})

describe("管理端", () => {
  it("保存面板密码：上游拒绝则 400 且不落库；通过则入库并回掩码", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const put = (pw: string) =>
      fetchSelf(
        authRequest(admin, "/api/admin/qoder2api/config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ panelPassword: pw }),
        })
      )

    panelFails = true
    const bad = await put("wrong-pw")
    expect(bad.status).toBe(400)
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS c FROM qoder2api_credentials").first<{ c: number }>()
    ).toMatchObject({ c: 0 })

    panelFails = false
    const ok = await put("right-pw")
    expect(ok.status).toBe(200)

    const cfg = (await (
      await fetchSelf(authRequest(admin, "/api/admin/qoder2api/config"))
    ).json()) as { credential: { source: string; masked: string | null } }
    expect(cfg.credential.source).toBe("db")
    // 明文绝不下发
    expect(cfg.credential.masked).not.toBe("right-pw")
    expect(String(cfg.credential.masked)).toContain("****")
  })

  it("摘除绑定：还有别的依据就保留 ai，否则收回", async () => {
    await configure()
    const admin = await makeUser({ role: "superadmin" })
    const donor = await makeUser()
    // 该用户当初是靠这个绑定拿到 ai 的
    await env.DB.prepare("UPDATE users SET permissions = ? WHERE id = ?")
      .bind(JSON.stringify({ ai: true }), donor.id)
      .run()
    const bindingId = await insertBinding(donor.id, "acc_rm")

    upstream = (url) => {
      if (url.includes("/accounts/delete")) return jsonResponse({ deleted: true })
      return jsonResponse({})
    }

    const res = await fetchSelf(
      authRequest(admin, `/api/admin/qoder2api/bindings/${bindingId}/remove`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    )
    expect(res.status).toBe(200)
    const out = (await res.json()) as { aiRevoked: boolean }
    expect(out.aiRevoked).toBe(true)
    expect(await aiPermission(donor.id)).toBe(false)

    const row = await env.DB.prepare("SELECT status FROM qoder2api_bindings WHERE id = ?")
      .bind(bindingId)
      .first<{ status: string }>()
    expect(row?.status).toBe("removed")
  })
})
