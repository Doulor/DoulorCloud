/**
 * 限时开放注册（open_registration / open_registration_until）。
 *
 * 走真实路由（miniflare SELF.fetch），是端到端证据：注册链路
 * 路由 → handler → 设置读取 → 权限落库 全程真实执行。
 *
 * 最要守住的一条：开放注册**绝不能**把 users.permissions 写成 NULL ——
 * parsePermissions 把 NULL 当「全部允许」，那会让每个开放注册的新号白拿
 * AI / frp / proxy（免费额度被薅）。所以这里显式断言落库的是一份 JSON，
 * 且 ai/frp/proxy 均为 false。
 */
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { uuid } from "../src/crypto"
import { makeUser, authRequest, fetchSelf, setSetting } from "./helpers"

/** 构造一个注册请求；每个用例用不同 IP，避开 60 次/小时/IP 的注册限流 */
function registerReq(
  username: string,
  email: string,
  inviteCode: string,
  ip: string
): Request {
  return new Request("https://cloud.doulor.cn/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify({ username, email, password: "pass12345", inviteCode }),
  })
}

/** 随机用户名：只用小写字母/数字/连字符（isValidUsername 不接受下划线） */
function randUser(tag: string): string {
  return `${tag}-${uuid().slice(0, 8)}`
}

async function makeInvite(
  code: string,
  permissions: string | null,
  maxUses = 1
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO invite_codes (id, code, max_uses, used_count, permissions, created_at) VALUES (?, ?, ?, 0, ?, ?)"
  )
    .bind(uuid(), code, maxUses, permissions, new Date().toISOString())
    .run()
}

async function userRow(username: string) {
  return env.DB.prepare(
    "SELECT permissions, invite_code_id FROM users WHERE username = ?"
  )
    .bind(username)
    .first<{ permissions: string | null; invite_code_id: string | null }>()
}

/** 该码被消费了几次 */
async function usedCount(code: string): Promise<number> {
  const row = await env.DB.prepare("SELECT used_count FROM invite_codes WHERE code = ?")
    .bind(code)
    .first<{ used_count: number }>()
  return Number(row?.used_count ?? -1)
}

/** 无任何模块权限的「普通邀请码」（用户建码时不勾任何模块） */
const NO_PERMS = JSON.stringify({ r2: false, ai: false, frp: false, proxy: false })

beforeEach(async () => {
  // app_settings 在用例间共享（同一个 D1），逐条清掉本文件涉及的键，避免互相污染。
  // invite_basic_features 也要清 —— 否则上一个用例把它设成 "r2" 后，
  // 下一个用例的「无权限码」判定会因为基础权限集合不同而漂移。
  await env.DB.prepare(
    "DELETE FROM app_settings WHERE key IN ('open_registration','open_registration_until','invite_basic_features')"
  ).run()
})

describe("限时开放注册", () => {
  it("默认关闭：无邀请码注册被拒（INVITE_REQUIRED）", async () => {
    const u = randUser("oroff")
    const res = await fetchSelf(registerReq(u, `${u}@example.com`, "", "10.9.1.1"))
    expect(res.status).toBe(400)
    const body = await res.json<{ code: string }>()
    expect(body.code).toBe("INVITE_REQUIRED")
  })

  it("打开后：无邀请码可注册，权限是显式 JSON（不给 AI/frp/proxy）", async () => {
    await setSetting("open_registration", "1")
    await setSetting("invite_basic_features", "r2")

    const u = randUser("oron")
    const res = await fetchSelf(registerReq(u, `${u}@example.com`, "", "10.9.2.1"))
    expect(res.status).toBe(201)

    const row = await userRow(u)
    // ⚠️ 关键：绝不能是 NULL（NULL = 全开）
    expect(row?.permissions).not.toBeNull()
    expect(JSON.parse(row!.permissions!)).toEqual({
      r2: true,
      ai: false,
      frp: false,
      proxy: false,
      doulor: false,
    })
    // 无码注册不该挂任何邀请码
    expect(row?.invite_code_id).toBeNull()

    // 下发到前端的用户对象也不能显示 AI 权限
    const body = await res.json<{ user: { permissions: Record<string, boolean> } }>()
    expect(body.user.permissions.ai).toBe(false)
    expect(body.user.permissions.frp).toBe(false)
    expect(body.user.permissions.proxy).toBe(false)
  })

  it("截止时间已过：即使总开关开着也要邀请码", async () => {
    await setSetting("open_registration", "1")
    await setSetting("open_registration_until", "2020-01-01T00:00:00.000Z")

    const u = randUser("orexp")
    const res = await fetchSelf(registerReq(u, `${u}@example.com`, "", "10.9.3.1"))
    expect(res.status).toBe(400)
    expect((await res.json<{ code: string }>()).code).toBe("INVITE_REQUIRED")
  })

  it("截止时间未到：仍然开放", async () => {
    await setSetting("open_registration", "1")
    await setSetting(
      "open_registration_until",
      new Date(Date.now() + 3600_000).toISOString()
    )

    const u = randUser("oruntil")
    const res = await fetchSelf(registerReq(u, `${u}@example.com`, "", "10.9.4.1"))
    expect(res.status).toBe(201)
  })

  it("提供邀请码时仍按码走：采用码上权限、消费码、记录 invite_code_id", async () => {
    await setSetting("open_registration", "1")
    const code = `ORC-${uuid().slice(0, 8)}`
    await makeInvite(code, JSON.stringify({ r2: false, ai: true, frp: false, proxy: false }))

    const u = randUser("orcode")
    const res = await fetchSelf(registerReq(u, `${u}@example.com`, code, "10.9.5.1"))
    expect(res.status).toBe(201)

    const row = await userRow(u)
    expect(JSON.parse(row!.permissions!)).toEqual({
      r2: false,
      ai: true,
      frp: false,
      proxy: false,
      doulor: false,
    })
    expect(row?.invite_code_id).not.toBeNull()

    const used = await env.DB.prepare("SELECT used_count FROM invite_codes WHERE code = ?")
      .bind(code)
      .first<{ used_count: number }>()
    expect(used?.used_count).toBe(1)
  })

  it("开放期间：无效邀请码不报错，回退为开放注册", async () => {
    await setSetting("open_registration", "1")
    await setSetting("invite_basic_features", "r2")

    const u = randUser("orfall")
    // 一条不存在的码（例如点了一条早已失效的邀请链接）
    const res = await fetchSelf(
      registerReq(u, `${u}@example.com`, "NOPE-1234-5678", "10.9.6.1")
    )
    expect(res.status).toBe(201)

    const row = await userRow(u)
    expect(row?.invite_code_id).toBeNull()
    expect(JSON.parse(row!.permissions!)).toEqual({
      r2: true,
      ai: false,
      frp: false,
      proxy: false,
      doulor: false,
    })
  })

  it("开放期间：已被用尽的邀请码也回退为开放注册", async () => {
    await setSetting("open_registration", "1")
    const code = `ORX-${uuid().slice(0, 8)}`
    await makeInvite(code, JSON.stringify({ r2: false, ai: true, frp: false, proxy: false }), 1)
    // 直接把码标成已用尽，模拟「链接被转发几手、名额已满」
    await env.DB.prepare("UPDATE invite_codes SET used_count = 1 WHERE code = ?")
      .bind(code)
      .run()

    const u = randUser("orused")
    const res = await fetchSelf(registerReq(u, `${u}@example.com`, code, "10.9.7.1"))
    expect(res.status).toBe(201)

    const row = await userRow(u)
    expect(row?.invite_code_id).toBeNull()
  })

  it("非开放期：无效邀请码仍明确报错（不静默放行）", async () => {
    const u = randUser("orbad")
    const res = await fetchSelf(
      registerReq(u, `${u}@example.com`, "NOPE-1234-5678", "10.9.8.1")
    )
    expect(res.status).toBe(400)
    expect((await res.json<{ code: string }>()).code).toBe("INVALID_INVITE")
  })
})

/**
 * 2026-09-29 新增：**开放注册期间，不含额外权限的邀请码不消耗次数**。
 *
 * 背景：开放期人人免码即可注册，这类码本来就没多给任何东西，
 * 再把它烧掉只是白白浪费分享者的额度（线上 30+ 条 max_uses=1 的普通码
 * 在开放期被用一次即废）。带权限的码不受影响。
 *
 * 这一组用例同时是**安全用例**：判定必须极保守，宁可判成「带权限」。
 */
describe("开放注册期间：不含权限的邀请码不消耗次数", () => {
  it("可无限重复使用：连注册 3 次，used_count 始终为 0", async () => {
    await setSetting("open_registration", "1")
    await setSetting("invite_basic_features", "")
    const code = `ORF-${uuid().slice(0, 8)}`
    await makeInvite(code, NO_PERMS, 1)

    for (let i = 0; i < 3; i++) {
      const u = randUser(`orfree${i}`)
      const res = await fetchSelf(
        registerReq(u, `${u}@example.com`, code, `10.20.0.${i + 1}`)
      )
      expect(res.status).toBe(201)
      // 码仍然被应用、并记录在用户行上（只是不扣次数）
      const row = await userRow(u)
      expect(row?.invite_code_id).not.toBeNull()
    }

    expect(await usedCount(code)).toBe(0)
  })

  it("带权限的码照常消费（开放注册也不能白送 AI）", async () => {
    await setSetting("open_registration", "1")
    await setSetting("invite_basic_features", "")
    const code = `ORP-${uuid().slice(0, 8)}`
    await makeInvite(
      code,
      JSON.stringify({ r2: false, ai: true, frp: false, proxy: false }),
      1
    )

    const u = randUser("orpaid")
    const res = await fetchSelf(registerReq(u, `${u}@example.com`, code, "10.20.1.1"))
    expect(res.status).toBe(201)
    expect(await usedCount(code)).toBe(1)
  })

  it("码上只有「基础权限」模块时也算无权限（免码注册本来就拿得到）", async () => {
    await setSetting("open_registration", "1")
    await setSetting("invite_basic_features", "r2")
    const code = `ORB-${uuid().slice(0, 8)}`
    await makeInvite(
      code,
      JSON.stringify({ r2: true, ai: false, frp: false, proxy: false }),
      1
    )

    const u = randUser("orbasic")
    const res = await fetchSelf(registerReq(u, `${u}@example.com`, code, "10.20.2.1"))
    expect(res.status).toBe(201)
    expect(JSON.parse((await userRow(u))!.permissions!)).toEqual({
      r2: true,
      ai: false,
      frp: false,
      proxy: false,
      doulor: false,
    })
    expect(await usedCount(code)).toBe(0)
  })

  // ⚠️ 下面两条是「不能误判」的安全用例：一旦误判成「无权限」，
  //    一条历史码就能无限量发放 AI/frp/proxy。
  it("permissions 为 NULL 的历史码**不**被当成无权限（NULL = 全开）", async () => {
    await setSetting("open_registration", "1")
    await setSetting("invite_basic_features", "")
    const code = `ORN-${uuid().slice(0, 8)}`
    await makeInvite(code, null, 5)

    const u = randUser("ornull")
    const res = await fetchSelf(registerReq(u, `${u}@example.com`, code, "10.20.3.1"))
    expect(res.status).toBe(201)
    expect(await usedCount(code)).toBe(1)
  })

  it("缺键的码**不**被当成无权限（缺键在 parsePermissions 里 = 允许）", async () => {
    await setSetting("open_registration", "1")
    await setSetting("invite_basic_features", "")
    const code = `ORM-${uuid().slice(0, 8)}`
    // 只写了 r2:false，其余三个键缺失 ⇒ 旧语义下 ai/frp/proxy 全是「允许」
    await makeInvite(code, JSON.stringify({ r2: false }), 5)

    const u = randUser("ormiss")
    const res = await fetchSelf(registerReq(u, `${u}@example.com`, code, "10.20.4.1"))
    expect(res.status).toBe(201)
    expect(await usedCount(code)).toBe(1)
  })

  it("非开放期：无权限的码照常一次性消费", async () => {
    const code = `ORO-${uuid().slice(0, 8)}`
    await makeInvite(code, NO_PERMS, 1)

    const u1 = randUser("oroff1")
    const res1 = await fetchSelf(registerReq(u1, `${u1}@example.com`, code, "10.20.5.1"))
    expect(res1.status).toBe(201)
    expect(await usedCount(code)).toBe(1)

    // 第二个拿到链接的人应被挡住（码已用尽）
    const u2 = randUser("oroff2")
    const res2 = await fetchSelf(registerReq(u2, `${u2}@example.com`, code, "10.20.5.2"))
    expect(res2.status).toBe(400)
    expect((await res2.json<{ code: string }>()).code).toBe("INVITE_USED")
  })
})

describe("GET /api/register-status（公开）", () => {
  it("反映开关与截止时间，无需登录", async () => {
    let res = await fetchSelf(new Request("https://cloud.doulor.cn/api/register-status"))
    expect(res.status).toBe(200)
    // defaultRootDomain：`root_domains` 表在测试环境里是空的 ⇒ 回落 env.ROOT_DOMAIN
    expect(await res.json()).toEqual({
      openRegistration: false,
      until: null,
      defaultRootDomain: "doulor.cn",
    })

    await setSetting("open_registration", "1")
    await setSetting("open_registration_until", "2030-01-01T00:00:00.000Z")
    res = await fetchSelf(new Request("https://cloud.doulor.cn/api/register-status"))
    expect(await res.json()).toEqual({
      openRegistration: true,
      until: "2030-01-01T00:00:00.000Z",
      defaultRootDomain: "doulor.cn",
    })
  })
})

describe("PUT /api/admin/settings —— 开放注册设置校验", () => {
  const put = (admin: { cookie: string }, payload: Record<string, unknown>) =>
    fetchSelf(
      authRequest(admin, "/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
    )

  it("非法截止时间被拒（400）", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await put(admin, { open_registration_until: "not-a-date" })
    expect(res.status).toBe(400)
  })

  it("空串可清空截止时间（= 不自动关闭）", async () => {
    const admin = await makeUser({ role: "admin" })
    await setSetting("open_registration_until", "2030-01-01T00:00:00.000Z")

    const res = await put(admin, { open_registration_until: "" })
    expect(res.status).toBe(200)

    const row = await env.DB.prepare(
      "SELECT value FROM app_settings WHERE key = 'open_registration_until'"
    ).first<{ value: string }>()
    expect(row?.value).toBe("")
  })

  it("布尔开关落库为 \"1\"", async () => {
    const admin = await makeUser({ role: "admin" })
    await put(admin, { open_registration: true })

    const row = await env.DB.prepare(
      "SELECT value FROM app_settings WHERE key = 'open_registration'"
    ).first<{ value: string }>()
    expect(row?.value).toBe("1")
  })
})
describe("并发重复注册冲突", () => {
  it("同一用户名并发请求不会返回 500", async () => {
    await setSetting("open_registration", "1")
    const u = randUser("dup")
    const results = await Promise.all(
      [1, 2].map((i) => fetchSelf(registerReq(u, `${u}${i}@example.com`, "", `10.50.0.${i}`)))
    )
    const statuses = results.map((r) => r.status)
    expect(statuses.filter((status) => status === 201)).toHaveLength(1)
    expect(statuses).toContain(409)
    const conflict = results.find((r) => r.status === 409)
    expect(conflict).toBeTruthy()
    expect((await conflict!.json<{ code: string }>()).code).toBe("CONFLICT")
  })
})
