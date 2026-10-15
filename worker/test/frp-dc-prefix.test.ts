// 账号命名与前缀边界（2026-10-14）。
//
// 需求原话：「买 frp 套餐时用户名密码都是随机的，改为可修改的。用户名不能修改，
// 默认使用 DC_xxx 的格式。然后直接在 DoulorCloud 里面修改密码。」
//
// 这里钉的是三件容易出错的事：
//
//   1. 新账号必须用 DC_ 前缀 —— 但**不是简单地换个字符串**。dcfrp_ 前缀不只是命名，
//      它是「自动化只能碰这个前缀」的安全边界：面板里 46 个历史人工账号之所以
//      永远不会被 agent 误改，靠的就是这条线。所以边界必须**同时认两个前缀**，
//      已经发出去的 dcfrp_xxx 账号不能因为改名就掉出管理范围。
//
//   2. 改密码必须**真的落地**，不只是改了 D1 里的一个字段 ——
//      agent 是拿 frp_token 去写面板的，所以返回值和列表都要能看到新密码。
//
//   3. 面板对 token 有格式校验（只收 A-Za-z0-9），实测 `dsh-probe-token` 会被拒。
//      所以改密码这个入口必须先自己挡住非法字符，否则用户会收到一个
//      「面板连不上但看不出原因」的账号。
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { uuid } from "../src/crypto"
import { authRequest, fetchSelf, makeUser, type TestUser } from "./helpers"

/** 每个用例独立节点，避免 D1 在用例间共享造成串扰 */
async function seedNode(): Promise<string> {
  const id = `n_${uuid().slice(0, 8)}`
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO frp_nodes
       (id, name, server_addr, server_port, auth_token, token_prefix,
        port_min, port_max, max_ports, enabled, sort_order, auth_mode, created_at, updated_at)
     VALUES (?, '前缀测试节点', 'frp.test', 7000, 'shared-secret', '', 31100, 31199, 5, 1, 0, 'token_user', ?, ?)`
  )
    .bind(id, now, now)
    .run()
  return id
}

async function call<T>(
  admin: TestUser,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: T }> {
  const res = await fetchSelf(authRequest(admin, `/api${path}`, init))
  let body: T
  try {
    body = (await res.json()) as T
  } catch {
    body = {} as T
  }
  return { status: res.status, body }
}

async function makePlan(admin: TestUser, nodeId: string): Promise<string> {
  const res = await call<{ id: string }>(admin, "/admin/frp/plans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodeId, name: "前缀套餐", days: 7, pricePoints: 100, maxPorts: 2 }),
  })
  expect(res.status).toBe(200)
  return res.body.id
}

async function newSub(
  admin: TestUser,
  nodeId: string
): Promise<{ id: string; frpUser: string; frpToken: string }> {
  const planId = await makePlan(admin, nodeId)
  const res = await call<{ id: string; frpUser: string; frpToken: string }>(
    admin,
    "/admin/frp/subscriptions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: (await makeUser()).id, nodeId, planId, days: 7, portCount: 1 }),
    }
  )
  expect(res.status).toBe(200)
  return res.body
}

describe("用户自己改密码", () => {
  /** 管理员替 owner 开一条租约（不用积分，走管理端） */
  async function giveSub(ownerId: string): Promise<string> {
    const admin = await makeUser({ role: "superadmin" })
    const nodeId = await seedNode()
    const planId = await makePlan(admin, nodeId)
    const res = await call<{ id: string }>(admin, "/admin/frp/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: ownerId, nodeId, planId, days: 7, portCount: 1 }),
    })
    expect(res.status).toBe(200)
    return res.body.id
  }

  it("租约所有者能改自己的密码", async () => {
    const owner = await makeUser()
    const subId = await giveSub(owner.id)

    const res = await call<{ ok: boolean; frpToken: string }>(owner, "/frp/rental/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: subId, token: "OwnerChosen123" }),
    })
    expect(res.status).toBe(200)
    expect(res.body.frpToken).toBe("OwnerChosen123")

    const row = await env.DB.prepare(`SELECT frp_token FROM frp_subscriptions WHERE id = ?`)
      .bind(subId)
      .first<{ frp_token: string }>()
    expect(row?.frp_token).toBe("OwnerChosen123")
  })

  it("🔴 不能改别人的密码（拿着别人的租约 id 也不行）", async () => {
    const owner = await makeUser()
    const attacker = await makeUser()
    const subId = await giveSub(owner.id)

    const before = await env.DB.prepare(`SELECT frp_token FROM frp_subscriptions WHERE id = ?`)
      .bind(subId)
      .first<{ frp_token: string }>()

    const res = await call<{ frpToken?: string }>(attacker, "/frp/rental/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: subId, token: "AttackerSet1" }),
    })

    // 404 而不是 403：403 会告诉攻击者「这个 id 确实存在」
    expect(res.status).toBe(404)

    const after = await env.DB.prepare(`SELECT frp_token FROM frp_subscriptions WHERE id = ?`)
      .bind(subId)
      .first<{ frp_token: string }>()
    expect(after?.frp_token).toBe(before?.frp_token)

    // ⚠️ 关键：必须在同一个用例里证明「本人改是能成的」。
    //    否则路由整个不存在时，攻击者也会拿到 404，这条用例就会**假通过**
    //    —— 它通过的原因就不是「越权被拦住了」。
    const ok = await call<{ ok: boolean; frpToken: string }>(owner, "/frp/rental/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: subId, token: "OwnerCanStill1" }),
    })
    expect(ok.status).toBe(200)
    expect(ok.body.frpToken).toBe("OwnerCanStill1")
  })

  it("用户改密码同样要过格式校验", async () => {
    const owner = await makeUser()
    const subId = await giveSub(owner.id)
    const before = await env.DB.prepare(`SELECT frp_token FROM frp_subscriptions WHERE id = ?`)
      .bind(subId)
      .first<{ frp_token: string }>()

    for (const bad of ["short1", "with-dash", "有中文", ""]) {
      const res = await call(owner, "/frp/rental/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: subId, token: bad }),
      })
      expect(res.status).toBe(400)
    }

    const after = await env.DB.prepare(`SELECT frp_token FROM frp_subscriptions WHERE id = ?`)
      .bind(subId)
      .first<{ frp_token: string }>()
    expect(after?.frp_token).toBe(before?.frp_token)
  })

  it("已停用的租约不让改密码", async () => {
    const owner = await makeUser()
    const subId = await giveSub(owner.id)
    await env.DB.prepare(`UPDATE frp_subscriptions SET status = 'cancelled' WHERE id = ?`)
      .bind(subId)
      .run()

    const res = await call(owner, "/frp/rental/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: subId, token: "ShouldBeBlocked1" }),
    })
    expect(res.status).toBe(409)
  })
})

describe("账号命名与前缀边界", () => {
  it("新建订阅的账号名用 DC_ 前缀，且不含容易混淆的字符", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const nodeId = await seedNode()
    const sub = await newSub(admin, nodeId)

    // 需求指定格式：DC_xxx
    expect(sub.frpUser).toMatch(/^DC_[A-Za-z0-9]{4,32}$/)
    // 不能再出现旧前缀
    expect(sub.frpUser.startsWith("dcfrp_")).toBe(false)
  })

  it("账号名不可修改：请求体里塞 frpUser 也不会被采纳", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const nodeId = await seedNode()
    const planId = await makePlan(admin, nodeId)
    const owner = await makeUser()

    const res = await call<{ frpUser: string }>(admin, "/admin/frp/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: owner.id,
        nodeId,
        planId,
        days: 7,
        portCount: 1,
        // 用户想自己指定账号名 —— 必须被忽略，不能改
        frpUser: "HACKER",
        user: "HACKER",
      }),
    })
    expect(res.status).toBe(200)
    expect(res.body.frpUser).toMatch(/^DC_/)
    expect(res.body.frpUser).not.toBe("HACKER")
  })

  it("setToken 能把密码改掉，并回显新密码", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const nodeId = await seedNode()
    const sub = await newSub(admin, nodeId)
    const oldToken = sub.frpToken

    const wanted = "MyOwnPassword123"
    const res = await call<{ ok: boolean; frpToken: string }>(
      admin,
      `/admin/frp/subscriptions/${sub.id}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setToken", token: wanted }),
      }
    )
    expect(res.status).toBe(200)
    expect(res.body.frpToken).toBe(wanted)
    expect(res.body.frpToken).not.toBe(oldToken)

    // 真的落到了 D1 —— agent 就是从这里读 frp_token 去写面板的
    const row = await env.DB.prepare(`SELECT frp_token FROM frp_subscriptions WHERE id = ?`)
      .bind(sub.id)
      .first<{ frp_token: string }>()
    expect(row?.frp_token).toBe(wanted)
  })

  it("setToken 拒绝面板会拒收的字符，并给出人能看懂的原因", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const nodeId = await seedNode()
    const sub = await newSub(admin, nodeId)
    const before = sub.frpToken

    // 面板只收 A-Za-z0-9，实测带 `-` 的会被拒（operate failed, token format error）
    for (const bad of ["has-dash", "has space", "中文密码", "", "a".repeat(200)]) {
      const res = await call<{ code?: string }>(admin, `/admin/frp/subscriptions/${sub.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setToken", token: bad }),
      })
      expect(res.status).toBe(400)
    }

    const row = await env.DB.prepare(`SELECT frp_token FROM frp_subscriptions WHERE id = ?`)
      .bind(sub.id)
      .first<{ frp_token: string }>()
    expect(row?.frp_token).toBe(before)
  })

  it("改密码不能顺手改掉账号名和端口", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const nodeId = await seedNode()
    const sub = await newSub(admin, nodeId)

    const before = await env.DB.prepare(
      `SELECT frp_user, ports FROM frp_subscriptions WHERE id = ?`
    )
      .bind(sub.id)
      .first<{ frp_user: string; ports: string }>()

    await call(admin, `/admin/frp/subscriptions/${sub.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "setToken", token: "AnotherGoodToken1", frpUser: "CHANGED", ports: [1, 2] }),
    })

    const after = await env.DB.prepare(
      `SELECT frp_user, ports FROM frp_subscriptions WHERE id = ?`
    )
      .bind(sub.id)
      .first<{ frp_user: string; ports: string }>()

    expect(after?.frp_user).toBe(before?.frp_user)
    expect(after?.ports).toBe(before?.ports)
  })
})
