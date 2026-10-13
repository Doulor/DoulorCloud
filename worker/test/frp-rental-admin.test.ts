// 内网穿透「租用化」管理端（2026-10-13）。
//
// 这一层是「让管理员不再需要开 frps-panel 网页」的落点，所以测试钉的是
// **管理端真正会出错的那些边界**，而不是 happy path：
//   · 端口唯一性 —— 两人拿到同一个公网端口时，先连上的能跑、后连上的静默失败，
//     是这类服务最难排查的事故。这里既测「被别人占了要拒绝」，也测
//     「改端口时不能和自己已占的端口自撞」（很容易写错的一条）。
//   · 续期不能吞掉剩余天数 —— 未过期要从原到期日顺延，已过期才从「现在」起算。
//   · 回收要连端口租约一起清 —— 只删订阅会留下无人认领的端口占用，把区间慢慢漏干。
//   · 被订阅引用的套餐不能删 —— 否则订阅行的 plan_id 变成悬空引用。
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { uuid } from "../src/crypto"
import { authRequest, fetchSelf, makeUser, type TestUser } from "./helpers"

const DAY_MS = 86_400_000

/** 每个用例独立节点，避免 D1 在用例间共享造成串扰 */
async function seedNode(): Promise<string> {
  const id = `n_${uuid().slice(0, 8)}`
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO frp_nodes
       (id, name, server_addr, server_port, auth_token, token_prefix,
        port_min, port_max, max_ports, enabled, sort_order, auth_mode, created_at, updated_at)
     VALUES (?, '租用测试节点', 'frp.test', 7000, 'shared-secret', '', 31000, 31999, 5, 1, 0, 'token_user', ?, ?)`
  )
    .bind(id, now, now)
    .run()
  return id
}

async function jsonBody<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

async function call<T>(
  admin: TestUser,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: T }> {
  const res = await fetchSelf(authRequest(admin, `/api${path}`, init))
  let body: T
  try {
    body = await jsonBody<T>(res)
  } catch {
    body = {} as T
  }
  return { status: res.status, body }
}

async function createPlan(
  admin: TestUser,
  nodeId: string,
  over: Partial<{ name: string; days: number; pricePoints: number; maxPorts: number }> = {}
): Promise<string> {
  const res = await call<{ ok: boolean; id: string }>(admin, "/admin/frp/plans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nodeId,
      name: over.name ?? "测试套餐",
      days: over.days ?? 7,
      pricePoints: over.pricePoints ?? 100,
      maxPorts: over.maxPorts ?? 2,
    }),
  })
  expect(res.status).toBe(200)
  return res.body.id
}

async function createSub(
  admin: TestUser,
  payload: Record<string, unknown>
): Promise<{ status: number; body: { id?: string; frpUser?: string; ports?: number[]; expiresAt?: string; code?: string; error?: string } }> {
  return call(admin, "/admin/frp/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
}

describe("内网穿透租用化 · 管理端", () => {
  it("套餐 CRUD：建、列、改、删", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const nodeId = await seedNode()

    const id = await createPlan(admin, nodeId, { name: "7 天体验", days: 7, pricePoints: 100 })

    const listed = await call<{ plans: { id: string; name: string; days: number; pricePoints: number }[] }>(
      admin,
      "/admin/frp/plans"
    )
    const mine = listed.body.plans.find((p) => p.id === id)
    expect(mine?.name).toBe("7 天体验")
    expect(mine?.days).toBe(7)

    // 改名改价
    const upd = await call<{ ok: boolean }>(admin, "/admin/frp/plans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, nodeId, name: "7 天标准", days: 7, pricePoints: 150, maxPorts: 2 }),
    })
    expect(upd.status).toBe(200)

    const listed2 = await call<{ plans: { id: string; name: string; pricePoints: number }[] }>(
      admin,
      "/admin/frp/plans"
    )
    expect(listed2.body.plans.find((p) => p.id === id)?.pricePoints).toBe(150)

    // 删
    const del = await call<{ ok: boolean }>(admin, `/admin/frp/plans/${id}`, { method: "DELETE" })
    expect(del.status).toBe(200)
    const listed3 = await call<{ plans: { id: string }[] }>(admin, "/admin/frp/plans")
    expect(listed3.body.plans.find((p) => p.id === id)).toBeUndefined()
  })

  it("手工开订阅：自动从默认区间分配端口，账号名带 dcfrp_ 前缀", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const nodeId = await seedNode()
    const user = await makeUser()

    const res = await createSub(admin, { userId: user.id, nodeId, days: 30, portCount: 2 })
    expect(res.status).toBe(200)
    expect(res.body.frpUser).toMatch(/^dcfrp_[0-9a-f]{8}$/)
    expect(res.body.ports).toHaveLength(2)
    for (const p of res.body.ports!) {
      expect(p).toBeGreaterThanOrEqual(31000)
      expect(p).toBeLessThanOrEqual(31999)
    }

    // 端口租约要同步建出来
    const leases = await env.DB.prepare(
      `SELECT port FROM frp_port_leases WHERE sub_id = ?`
    )
      .bind(res.body.id!)
      .all<{ port: number }>()
    expect((leases.results ?? []).map((r) => r.port).sort()).toEqual([...res.body.ports!].sort())

    // 列表里能看到，且状态是待同步
    const list = await call<{ subscriptions: { id: string; frpUser: string; syncState: string; daysLeft: number }[] }>(
      admin,
      "/admin/frp/subscriptions"
    )
    const row = list.body.subscriptions.find((s) => s.id === res.body.id)
    expect(row?.syncState).toBe("pending")
    expect(row?.daysLeft).toBeGreaterThanOrEqual(29)
  })

  it("端口被别人占用时明确拒绝（而不是静默撞号）", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const nodeId = await seedNode()
    const a = await makeUser()
    const b = await makeUser()

    const first = await createSub(admin, { userId: a.id, nodeId, days: 7, portCount: 1 })
    expect(first.status).toBe(200)
    const used = first.body.ports![0]

    const second = await createSub(admin, { userId: b.id, nodeId, days: 7, ports: [used] })
    expect(second.status).toBe(409)
    expect(second.body.code).toBe("PORT_TAKEN")
  })

  it("续期：未过期从原到期日顺延，不吞剩余天数", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const nodeId = await seedNode()
    const user = await makeUser()

    const created = await createSub(admin, { userId: user.id, nodeId, days: 10, portCount: 1 })
    const id = created.body.id!
    const before = Date.parse(created.body.expiresAt!)

    const ext = await call<{ expiresAt: string }>(admin, `/admin/frp/subscriptions/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "extend", days: 10 }),
    })
    expect(ext.status).toBe(200)
    const after = Date.parse(ext.body.expiresAt)
    // 应约为 +20 天，而不是 +10 天（后者说明把已过的 10 天吞掉了）
    const deltaDays = (after - before) / DAY_MS
    expect(deltaDays).toBeGreaterThan(9.9)
    expect(deltaDays).toBeLessThan(10.1)
  })

  it("续期：已过期则从「现在」起算，外加会把 expired 拉回 active", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const nodeId = await seedNode()
    const user = await makeUser()

    const created = await createSub(admin, { userId: user.id, nodeId, days: 3, portCount: 1 })
    const id = created.body.id!

    // 造一份「已过期」的订阅
    const past = new Date(Date.now() - 5 * DAY_MS).toISOString()
    await env.DB.prepare(
      `UPDATE frp_subscriptions SET expires_at = ?, status = 'expired' WHERE id = ?`
    )
      .bind(past, id)
      .run()

    const ext = await call<{ expiresAt: string }>(admin, `/admin/frp/subscriptions/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "extend", days: 10 }),
    })
    expect(ext.status).toBe(200)
    const days = (Date.parse(ext.body.expiresAt) - Date.now()) / DAY_MS
    expect(days).toBeGreaterThan(9.5)
    expect(days).toBeLessThan(10.5)

    const row = await env.DB.prepare(`SELECT status FROM frp_subscriptions WHERE id = ?`)
      .bind(id)
      .first<{ status: string }>()
    expect(row?.status).toBe("active")
  })

  it("停用 / 恢复只改 status（agent 据此去 disable 面板账号）", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const nodeId = await seedNode()
    const user = await makeUser()
    const created = await createSub(admin, { userId: user.id, nodeId, days: 7, portCount: 1 })
    const id = created.body.id!

    await call(admin, `/admin/frp/subscriptions/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "suspend" }),
    })
    let row = await env.DB.prepare(`SELECT status FROM frp_subscriptions WHERE id = ?`)
      .bind(id)
      .first<{ status: string }>()
    expect(row?.status).toBe("cancelled")

    await call(admin, `/admin/frp/subscriptions/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resume" }),
    })
    row = await env.DB.prepare(`SELECT status FROM frp_subscriptions WHERE id = ?`)
      .bind(id)
      .first<{ status: string }>()
    expect(row?.status).toBe("active")
  })

  it("回收订阅时端口租约一并清掉（否则区间会被慢慢漏干）", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const nodeId = await seedNode()
    const user = await makeUser()
    const created = await createSub(admin, { userId: user.id, nodeId, days: 7, portCount: 2 })
    const id = created.body.id!

    const before = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM frp_port_leases WHERE sub_id = ?`
    )
      .bind(id)
      .first<{ n: number }>()
    expect(before?.n).toBe(2)

    const rev = await call<{ revoked: boolean }>(admin, `/admin/frp/subscriptions/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "revoke" }),
    })
    expect(rev.status).toBe(200)

    const sub = await env.DB.prepare(`SELECT id FROM frp_subscriptions WHERE id = ?`)
      .bind(id)
      .first()
    expect(sub).toBeNull()

    const after = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM frp_port_leases WHERE sub_id = ?`
    )
      .bind(id)
      .first<{ n: number }>()
    expect(after?.n).toBe(0)
  })

  it("改端口：和自己已占的端口不算冲突；被别人占了则拒绝", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const nodeId = await seedNode()
    const a = await makeUser()
    const b = await makeUser()

    const subA = await createSub(admin, { userId: a.id, nodeId, days: 7, portCount: 2 })
    const idA = subA.body.id!
    const [p1, p2] = subA.body.ports!

    // 只保留 p1、再加一个新端口：p1 是「自己已占」，绝不能被判成冲突
    const changed = await call<{ ports: number[] }>(admin, `/admin/frp/subscriptions/${idA}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "setPorts", ports: [p1, p2 + 1] }),
    })
    expect(changed.status).toBe(200)
    expect(changed.body.ports).toEqual([p1, p2 + 1])

    // B 想抢 A 的 p1 → 拒绝
    const subB = await createSub(admin, { userId: b.id, nodeId, days: 7, portCount: 1 })
    const steal = await call<{ code?: string }>(admin, `/admin/frp/subscriptions/${subB.body.id!}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "setPorts", ports: [p1] }),
    })
    expect(steal.status).toBe(409)
    expect(steal.body.code).toBe("PORT_TAKEN")
  })

  it("被订阅引用的套餐不能删，只能停用", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const nodeId = await seedNode()
    const user = await makeUser()
    const planId = await createPlan(admin, nodeId)

    const sub = await createSub(admin, { userId: user.id, nodeId, planId })
    expect(sub.status).toBe(200)

    const del = await call<{ code?: string }>(admin, `/admin/frp/plans/${planId}`, { method: "DELETE" })
    expect(del.status).toBe(409)
    expect(del.body.code).toBe("PLAN_IN_USE")

    // 停用则允许
    const off = await call(admin, "/admin/frp/plans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: planId, nodeId, name: "测试套餐", days: 7, pricePoints: 100, maxPorts: 2, enabled: false }),
    })
    expect(off.status).toBe(200)
  })

  it("套餐走不通的参数被拒（天数为 0 / 负数 / 非整数）", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const nodeId = await seedNode()
    for (const days of [0, -1, 1.5]) {
      const res = await call<{ code?: string }>(admin, "/admin/frp/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId, name: "x", days, pricePoints: 10, maxPorts: 1 }),
      })
      expect(res.status).toBe(400)
    }
  })

  it("普通用户不能碰这些接口", async () => {
    const nodeId = await seedNode()
    const user = await makeUser({ role: "user" })

    for (const [path, method] of [
      ["/admin/frp/plans", "GET"],
      ["/admin/frp/subscriptions", "GET"],
    ] as const) {
      const res = await fetchSelf(authRequest(user, `/api${path}`, { method }))
      expect(res.status).toBe(403)
    }

    // 未登录也应该被挡
    const anon = await fetchSelf(new Request(`https://cloud.doulor.cn/api/admin/frp/subscriptions`))
    expect(anon.status).toBe(401)
  })

  it("admin 角色但没有被授予 frp 范围时也要挡住（权限域是显式授予的）", async () => {
    // 这一条钉的是项目的权限模型：isPrivileged 只认 superadmin / root，
    // 普通 admin 必须由站长在管理端显式授予具体范围。
    // 新增的 frp.plans / frp.rentals 也必须走这条规则，不能因为「是 admin」就放行。
    await seedNode()
    const plainAdmin = await makeUser({ role: "admin" })

    const res = await fetchSelf(
      authRequest(plainAdmin, `/api/admin/frp/subscriptions`, { method: "GET" })
    )
    expect(res.status).toBe(403)

    const res2 = await fetchSelf(authRequest(plainAdmin, `/api/admin/frp/plans`, { method: "GET" }))
    expect(res2.status).toBe(403)
  })

  it("手工开通也接受用户名 —— 管理端界面填的就是用户名", async () => {
    // 这一条是补上的：前端提交的是 username，而后端最初只认 userId，
    // 结果是界面上点「开通」必然报「缺少用户」。测试只用 userId 时永远发现不了。
    const admin = await makeUser({ role: "superadmin" })
    const nodeId = await seedNode()
    const user = await makeUser()

    const ok = await createSub(admin, { username: user.username, nodeId, days: 7, portCount: 1 })
    expect(ok.status).toBe(200)
    expect(ok.body.frpUser).toMatch(/^dcfrp_/)

    const missing = await createSub(admin, { username: "__查无此人__", nodeId, days: 7, portCount: 1 })
    expect(missing.status).toBe(404)

    const empty = await createSub(admin, { nodeId, days: 7, portCount: 1 })
    expect(empty.status).toBe(400)
  })
})
