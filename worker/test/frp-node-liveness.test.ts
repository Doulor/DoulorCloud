/**
 * 内网穿透：节点「活着才能卖」（2026-10-21）。
 *
 * ## 这个文件为谁而写
 * 起因是一条用户反馈：「内网穿透一直开通中，是开通了吗？」
 * 查下来是 `捐献-hk159` 节点的 agent 从 10-16 就停止上报了，
 * 但那条记录 `status='ok'`、`last_push_at` 还天天更新 ——
 * 于是新用户照买不误，配置永远下发不出去，界面无限转圈。
 *
 * ## 钉住的四件事
 * 1. **判活只看 `frp_agent_state.last_seen_at`**。
 *    最后一个用例专门造出「`last_push_at` 是刚刚、心跳是半小时前」的组合：
 *    这正是 hk159 的形态，谁要是把判据改回 `last_push_at`，那条会立刻红。
 * 2. 失联节点的套餐**在列表里置灰**（`nodeOnline=false`），但**不消失** ——
 *    套餐凭空少一半比多一个置灰卡片更像故障。
 * 3. 失联节点**不能购买、不能续期**，而且**一分钱都不扣**。
 * 4. 自动续费遇到失联节点要**跳过并关掉开关**，绝不能「一边坏一边收钱」。
 */
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { uuid } from "../src/crypto"
import { applyPoints } from "../src/points"
import { autoRenewDueRentals } from "../src/handlers/frp-rental"
import { authRequest, fetchSelf, makeUser, type TestUser } from "./helpers"

const DAY_MS = 86_400_000

/**
 * 建一个节点。
 * `agentMinutesAgo` = agent 最后上报距今多少分钟（null = 从未上报）；
 * `pushMinutesAgo`  = 云端盲推配置距今多少分钟。
 * 两个分开传，才能造出「push 很新但 agent 已死」这种真实事故形态。
 */
async function seedNode(opts: {
  enabled?: number
  status?: string
  agentMinutesAgo?: number | null
  pushMinutesAgo?: number | null
} = {}): Promise<string> {
  const id = `n_${uuid().slice(0, 8)}`
  const now = Date.now()
  const iso = new Date(now).toISOString()
  const push =
    opts.pushMinutesAgo == null
      ? null
      : new Date(now - opts.pushMinutesAgo * 60_000).toISOString()

  await env.DB.prepare(
    `INSERT INTO frp_nodes
       (id, name, server_addr, server_port, auth_token, token_prefix,
        port_min, port_max, max_ports, enabled, sort_order, auth_mode,
        status, last_push_at, created_at, updated_at)
     VALUES (?, '存活测试节点', 'frp.test', 7000, 'shared-secret', '',
             33000, 33999, 5, ?, 0, 'token_user', ?, ?, ?, ?)`
  )
    .bind(id, opts.enabled ?? 1, opts.status ?? "ok", push, iso, iso)
    .run()

  if (opts.agentMinutesAgo !== undefined && opts.agentMinutesAgo !== null) {
    await env.DB.prepare(
      `INSERT INTO frp_agent_state (node_id, last_seen_at, revision, report_count)
       VALUES (?, ?, 'test', 1)`
    )
      .bind(id, new Date(now - opts.agentMinutesAgo * 60_000).toISOString())
      .run()
  }
  return id
}

async function seedPlan(nodeId: string, pricePoints = 100, maxPorts = 1): Promise<string> {
  const id = `plan_${uuid().slice(0, 8)}`
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO frp_plans
       (id, node_id, name, days, price_points, max_ports, allow_ranges, sort_order, enabled, note, created_at, updated_at)
     VALUES (?, ?, '30 天标准', 30, ?, ?, ?, 0, 1, NULL, ?, ?)`
  )
    .bind(id, nodeId, pricePoints, maxPorts, JSON.stringify([[33000, 33999]]), now, now)
    .run()
  return id
}

async function grant(userId: string, amount: number): Promise<void> {
  const res = await applyPoints(env, {
    userId,
    delta: amount,
    reason: "admin",
    detail: "存活测试发放",
  })
  expect(res.applied).toBe(true)
}

async function balanceOf(userId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT balance FROM user_points WHERE user_id = ?`)
    .bind(userId)
    .first<{ balance: number }>()
  return row?.balance ?? 0
}

async function post<T>(user: TestUser, path: string, payload: Record<string, unknown>) {
  const res = await fetchSelf(
    authRequest(user, `/api${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  )
  let body: T
  try {
    body = (await res.json()) as T
  } catch {
    body = {} as T
  }
  return { status: res.status, body }
}

async function get<T>(user: TestUser, path: string) {
  const res = await fetchSelf(authRequest(user, `/api${path}`))
  let body: T
  try {
    body = (await res.json()) as T
  } catch {
    body = {} as T
  }
  return { status: res.status, body }
}

describe("节点存活判据：列表", () => {
  it("心跳新鲜的节点 → nodeOnline=true", async () => {
    const nodeId = await seedNode({ agentMinutesAgo: 1 })
    const planId = await seedPlan(nodeId)
    const user = await makeUser()
    await grant(user.id, 500)

    const res = await get<{ plans: { id: string; nodeOnline: boolean }[] }>(
      user,
      "/frp/rental/plans"
    )
    expect(res.status).toBe(200)
    const plan = res.body.plans.find((p) => p.id === planId)
    expect(plan?.nodeOnline).toBe(true)
  })

  it("心跳超窗的节点 → 套餐仍在列表，但 nodeOnline=false（置灰而不是消失）", async () => {
    const nodeId = await seedNode({ agentMinutesAgo: 30 })
    const planId = await seedPlan(nodeId)
    const user = await makeUser()
    await grant(user.id, 500)

    const res = await get<{ plans: { id: string; nodeOnline: boolean; affordable: boolean }[] }>(
      user,
      "/frp/rental/plans"
    )
    const plan = res.body.plans.find((p) => p.id === planId)
    // 关键：还在列表里（凭空消失会让人以为页面坏了）
    expect(plan).toBeTruthy()
    expect(plan?.nodeOnline).toBe(false)
    // 而且不能把它算成「买不起」—— 这是两码事，混淆了会让人以为是积分问题
    expect(plan?.affordable).toBe(true)
  })

  it("后台把节点标成 offline → 套餐直接不出现在列表", async () => {
    const nodeId = await seedNode({ agentMinutesAgo: 1, status: "offline" })
    const planId = await seedPlan(nodeId)
    const user = await makeUser()
    await grant(user.id, 500)

    const res = await get<{ plans: { id: string }[] }>(user, "/frp/rental/plans")
    expect(res.body.plans.find((p) => p.id === planId)).toBeUndefined()
  })

  it("🔴 last_push_at 是刚刚、但 agent 心跳是半小时前 → 仍然判死（hk159 的真实形态）", async () => {
    // 这条是整个文件的命门：云端盲推会一直刷新 last_push_at，
    // agent 死透了它也是新的。判活必须用 last_seen_at。
    const nodeId = await seedNode({ agentMinutesAgo: 30, pushMinutesAgo: 0 })
    const planId = await seedPlan(nodeId)
    const user = await makeUser()
    await grant(user.id, 500)

    const res = await get<{ plans: { id: string; nodeOnline: boolean }[] }>(
      user,
      "/frp/rental/plans"
    )
    expect(res.body.plans.find((p) => p.id === planId)?.nodeOnline).toBe(false)
  })
})

describe("节点存活判据：购买", () => {
  it("健康节点可以正常购买", async () => {
    const nodeId = await seedNode({ agentMinutesAgo: 1 })
    const planId = await seedPlan(nodeId)
    const user = await makeUser()
    await grant(user.id, 500)

    const res = await post<{ ok: boolean; id: string }>(user, "/frp/rental/purchase", { planId })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it("失联节点：拒绝购买且**一分不扣**", async () => {
    const nodeId = await seedNode({ agentMinutesAgo: 30 })
    const planId = await seedPlan(nodeId)
    const user = await makeUser()
    await grant(user.id, 500)
    const before = await balanceOf(user.id)

    const res = await post<{ code?: string }>(user, "/frp/rental/purchase", { planId })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe("NODE_NO_AGENT")
    expect(await balanceOf(user.id)).toBe(before)

    // 也不能留下半张租约
    const sub = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM frp_subscriptions WHERE user_id = ?`
    )
      .bind(user.id)
      .first<{ c: number }>()
    expect(sub?.c).toBe(0)
  })

  it("status=offline 的节点：拒绝购买且不扣分", async () => {
    const nodeId = await seedNode({ agentMinutesAgo: 1, status: "offline" })
    const planId = await seedPlan(nodeId)
    const user = await makeUser()
    await grant(user.id, 500)
    const before = await balanceOf(user.id)

    const res = await post<{ code?: string }>(user, "/frp/rental/purchase", { planId })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe("NODE_OFFLINE")
    expect(await balanceOf(user.id)).toBe(before)
  })
})

describe("节点存活判据：续期", () => {
  it("节点后来失联 → 续期被拒且不扣分（不能为一份下发不出去的配置收钱）", async () => {
    const nodeId = await seedNode({ agentMinutesAgo: 1 })
    const planId = await seedPlan(nodeId)
    const user = await makeUser()
    await grant(user.id, 500)

    const buy = await post<{ id: string }>(user, "/frp/rental/purchase", { planId })
    expect(buy.status).toBe(200)
    const subId = buy.body.id

    // 节点随后挂掉
    await env.DB.prepare(`UPDATE frp_agent_state SET last_seen_at = ? WHERE node_id = ?`)
      .bind(new Date(Date.now() - 30 * 60_000).toISOString(), nodeId)
      .run()

    const before = await balanceOf(user.id)
    const renew = await post<{ code?: string }>(user, "/frp/rental/renew", { id: subId })
    expect(renew.status).toBe(409)
    expect(renew.body.code).toBe("NODE_UNAVAILABLE")
    expect(await balanceOf(user.id)).toBe(before)

    // 到期日也不能被偷偷改掉
    const row = await env.DB.prepare(`SELECT expires_at FROM frp_subscriptions WHERE id = ?`)
      .bind(subId)
      .first<{ expires_at: string }>()
    expect(row?.expires_at).toBeTruthy()
    expect(Date.parse(row!.expires_at)).toBeLessThan(Date.now() + 31 * DAY_MS)
  })
})

describe("节点存活判据：自动续费", () => {
  it("节点失联 → 跳过、不扣钱、关掉开关并写明原因", async () => {
    const nodeId = await seedNode({ agentMinutesAgo: 1 })
    const planId = await seedPlan(nodeId)
    const user = await makeUser()
    await grant(user.id, 500)

    const buy = await post<{ id: string }>(user, "/frp/rental/purchase", { planId })
    const subId = buy.body.id

    // 打开自动续费，并把到期时间挪到 24 小时内（cron 才会捡到它）
    await env.DB.prepare(`UPDATE frp_subscriptions SET auto_renew = 1, expires_at = ? WHERE id = ?`)
      .bind(new Date(Date.now() + 3600_000).toISOString(), subId)
      .run()
    // 节点随后挂掉
    await env.DB.prepare(`UPDATE frp_agent_state SET last_seen_at = ? WHERE node_id = ?`)
      .bind(new Date(Date.now() - 30 * 60_000).toISOString(), nodeId)
      .run()

    const before = await balanceOf(user.id)
    const r = await autoRenewDueRentals(env)
    expect(r.skipped).toBeGreaterThanOrEqual(1)
    // 一分不扣 —— 这是「一边坏一边收钱」的唯一防线
    expect(await balanceOf(user.id)).toBe(before)

    const row = await env.DB.prepare(
      `SELECT auto_renew, last_error FROM frp_subscriptions WHERE id = ?`
    )
      .bind(subId)
      .first<{ auto_renew: number; last_error: string | null }>()
    expect(row?.auto_renew).toBe(0)
    expect(row?.last_error ?? "").toContain("未扣分")
  })
})
