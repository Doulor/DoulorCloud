// 活动抽奖（0087）：报名不发奖 → 开奖随机抽人发积分。
//
// 覆盖：
//   1. splitPool 纯函数：总和精确等于奖池、每份至少 1（平均分 / 随机分）
//   2. parseLotteryConfig 的边界（人数 0 / 奖池少于人数 / 分配方式非法 / 超过上限）
//   3. 报名只是登记：返回 pending、余额不变
//   4. 开奖：中奖者拿到积分、未中奖标 lost、总发放额精确等于奖池
//   5. 幂等：重复开奖 409；开奖后不能再报名
//   6. 无人报名开奖 → 400 且不留开奖锁（之后还能开）
//   7. 未中奖记录不能被「手动标记已发放」
//   8. 参与人数上限：报满即拒
//   9. 自动开奖：过了结束时间由 drawDueLotteries 开
//  10. 创建活动时的参数校验（非法参数 / 奖励类型不是积分）
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, type TestUser } from "./helpers"
import { splitPool, parseLotteryConfig } from "../src/event-rewards"
import { drawDueLotteries } from "../src/handlers/events"
import { getPointsBalance } from "../src/points"

async function makeAdmin(): Promise<TestUser> {
  return makeUser({ role: "admin" })
}

/** 建一条抽奖活动（直接落库，聚焦报名/开奖逻辑） */
async function seedLottery(opts: {
  winners: number
  pool: number
  mode?: "even" | "random"
  maxClaims?: number | null
  endsAt?: string | null
  status?: string
}): Promise<string> {
  const id = `ev_${Math.random().toString(36).slice(2, 10)}`
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO events
       (id, title, body, status, starts_at, ends_at, max_claims, reward_label, reward_type,
        reward_params, condition_type, condition_params, created_by, created_at, updated_at)
     VALUES (?, '抽奖测试', '正文', ?, NULL, ?, ?, '奖池积分', 'points',
             NULL, 'lottery', ?, NULL, ?, ?)`
  )
    .bind(
      id,
      opts.status ?? "active",
      opts.endsAt ?? null,
      opts.maxClaims ?? null,
      JSON.stringify({ winners: opts.winners, pool: opts.pool, mode: opts.mode ?? "even" }),
      now,
      now
    )
    .run()
  return id
}

async function claim(evId: string, user: TestUser): Promise<Response> {
  return fetchSelf(authRequest(user, `/api/events/${evId}/claim`, { method: "POST" }))
}

async function draw(evId: string, admin: TestUser): Promise<Response> {
  return fetchSelf(authRequest(admin, `/api/admin/events/${evId}/draw`, { method: "POST" }))
}

interface ClaimRow {
  id: string
  userId: string
  rewardStatus: string
}

async function claimsOf(evId: string, admin: TestUser): Promise<ClaimRow[]> {
  const res = await fetchSelf(authRequest(admin, `/api/admin/events/${evId}/claims`))
  return (await res.json<{ claims: ClaimRow[] }>()).claims
}

async function drawnAt(evId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT drawn_at FROM events WHERE id = ?")
    .bind(evId)
    .first<{ drawn_at: string | null }>()
  return row?.drawn_at ?? null
}

describe("抽奖：奖池分配算法", () => {
  it("平均分：总和精确等于奖池，每份差不超过 1", () => {
    for (const [pool, n] of [
      [100, 3],
      [10, 10],
      [7, 3],
      [1000, 7],
    ] as const) {
      const shares = splitPool(pool, n, "even")
      expect(shares).toHaveLength(n)
      expect(shares.reduce((a, b) => a + b, 0)).toBe(pool)
      expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1)
    }
  })

  it("随机分：总和精确等于奖池，且每份至少 1", () => {
    // 换几个不同的随机序列都成立（避免只测到一次巧合）
    for (const seed of [0.01, 0.3, 0.5, 0.77, 0.99]) {
      const shares = splitPool(100, 6, "random", () => seed)
      expect(shares).toHaveLength(6)
      expect(shares.reduce((a, b) => a + b, 0)).toBe(100)
      expect(Math.min(...shares)).toBeGreaterThanOrEqual(1)
    }
  })

  it("随机分：奖池刚好等于人数时人人 1 分", () => {
    const shares = splitPool(5, 5, "random", () => 0.9)
    expect(shares).toEqual([1, 1, 1, 1, 1])
  })

  it("只有 1 人中奖时独得奖池", () => {
    expect(splitPool(123, 1, "even")).toEqual([123])
    expect(splitPool(123, 1, "random")).toEqual([123])
  })

  it("解析配置：非法值一律 null（不猜、不静默回落）", () => {
    expect(parseLotteryConfig({ winners: 3, pool: 100, mode: "even" })).toEqual({
      winners: 3,
      pool: 100,
      mode: "even",
    })
    // 中奖人数 < 1
    expect(parseLotteryConfig({ winners: 0, pool: 100, mode: "even" })).toBeNull()
    // 奖池少于人数 ⇒ 有人分不到 1 分
    expect(parseLotteryConfig({ winners: 5, pool: 3, mode: "even" })).toBeNull()
    // 分配方式非法
    expect(parseLotteryConfig({ winners: 2, pool: 100, mode: "shuffle" })).toBeNull()
    // 超过中奖人数上限
    expect(parseLotteryConfig({ winners: 201, pool: 10000, mode: "even" })).toBeNull()
    expect(parseLotteryConfig(null)).toBeNull()
  })
})

describe("抽奖：报名与开奖", () => {
  it("报名只是登记：返回 pending、积分余额不变", async () => {
    const u = await makeUser()
    const evId = await seedLottery({ winners: 2, pool: 100 })

    const res = await claim(evId, u)
    expect(res.status).toBe(200)
    const body = await res.json<{ status: string; detail: string }>()
    expect(body.status).toBe("pending")
    expect(body.detail).toContain("等待开奖")

    // 关键：报名不发奖
    expect(await getPointsBalance(env, u.id)).toBe(0)
    // 重复报名 → 409，且仍不发奖
    const again = await claim(evId, u)
    expect(again.status).toBe(409)
    expect(await getPointsBalance(env, u.id)).toBe(0)
  })

  it("开奖：中奖者拿分、未中奖标 lost、总发放额精确等于奖池", async () => {
    const admin = await makeAdmin()
    const users = [await makeUser(), await makeUser(), await makeUser()]
    const evId = await seedLottery({ winners: 2, pool: 100, mode: "even" })
    for (const u of users) await claim(evId, u)

    const res = await draw(evId, admin)
    expect(res.status).toBe(200)
    const outcome = await res.json<{
      winners: number
      distributed: number
      participants: number
      failed: number
    }>()
    expect(outcome.participants).toBe(3)
    expect(outcome.winners).toBe(2)
    expect(outcome.distributed).toBe(100) // 2 人 × 50
    expect(outcome.failed).toBe(0)

    // 2 人中奖各 50，1 人未中奖 0 分 —— 具体谁中奖是随机的，只断言集合性质
    const balances = await Promise.all(users.map((u) => getPointsBalance(env, u.id)))
    expect(balances.filter((b) => b === 50)).toHaveLength(2)
    expect(balances.filter((b) => b === 0)).toHaveLength(1)
    expect(balances.reduce((a, b) => a + b, 0)).toBe(100)

    const claims = await claimsOf(evId, admin)
    expect(claims.filter((c) => c.rewardStatus === "granted")).toHaveLength(2)
    expect(claims.filter((c) => c.rewardStatus === "lost")).toHaveLength(1)
    expect(await drawnAt(evId)).toBeTruthy()
  })

  it("重复开奖 → 409（幂等，不会发第二遍）", async () => {
    const admin = await makeAdmin()
    const u = await makeUser()
    const evId = await seedLottery({ winners: 1, pool: 30 })
    await claim(evId, u)

    expect((await draw(evId, admin)).status).toBe(200)
    expect((await draw(evId, admin)).status).toBe(409)
    // 只发了一遍
    expect(await getPointsBalance(env, u.id)).toBe(30)
  })

  it("开奖后不能再报名（报了也拿不到奖）", async () => {
    const admin = await makeAdmin()
    const u1 = await makeUser()
    const u2 = await makeUser()
    const evId = await seedLottery({ winners: 1, pool: 10 })
    await claim(evId, u1)
    await draw(evId, admin)

    const res = await claim(evId, u2)
    expect(res.status).toBe(400)
    expect(await getPointsBalance(env, u2.id)).toBe(0)
  })

  it("无人报名时开奖 → 400，且不留开奖锁（之后还能开）", async () => {
    const admin = await makeAdmin()
    const u = await makeUser()
    const evId = await seedLottery({ winners: 1, pool: 10 })

    expect((await draw(evId, admin)).status).toBe(400)
    expect(await drawnAt(evId)).toBeNull()

    // 有人报名后仍可正常开奖
    await claim(evId, u)
    expect((await draw(evId, admin)).status).toBe(200)
    expect(await getPointsBalance(env, u.id)).toBe(10)
  })

  it("报名人数不足中奖人数时，报名的都中奖", async () => {
    const admin = await makeAdmin()
    const users = [await makeUser(), await makeUser()]
    const evId = await seedLottery({ winners: 10, pool: 100, mode: "even" })
    for (const u of users) await claim(evId, u)

    const res = await draw(evId, admin)
    const outcome = await res.json<{ winners: number; distributed: number }>()
    expect(outcome.winners).toBe(2)
    expect(outcome.distributed).toBe(100) // 2 人各 50
    for (const u of users) {
      expect(await getPointsBalance(env, u.id)).toBe(50)
    }
  })

  it("参与人数上限：报满即拒（文案是「参与人数已满」）", async () => {
    const u1 = await makeUser()
    const u2 = await makeUser()
    const evId = await seedLottery({ winners: 1, pool: 10, maxClaims: 1 })

    expect((await claim(evId, u1)).status).toBe(200)
    const res = await claim(evId, u2)
    expect(res.status).toBe(409)
    const body = await res.json<{ error: string }>()
    expect(body.error).toContain("参与人数已满")
  })

  it("未中奖记录不能被手动标记为已发放", async () => {
    const admin = await makeAdmin()
    const users = [await makeUser(), await makeUser()]
    const evId = await seedLottery({ winners: 1, pool: 20 })
    for (const u of users) await claim(evId, u)
    await draw(evId, admin)

    const claims = await claimsOf(evId, admin)
    const lost = claims.find((c) => c.rewardStatus === "lost")!
    expect(lost).toBeTruthy()

    const res = await fetchSelf(
      authRequest(admin, `/api/admin/events/${evId}/claims/${lost.id}/grant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ detail: "硬要发" }),
      })
    )
    expect(res.status).toBe(400)
  })

  it("非管理员不能开奖", async () => {
    const u = await makeUser()
    const evId = await seedLottery({ winners: 1, pool: 10 })
    await claim(evId, u)
    expect((await draw(evId, u)).status).toBe(403)
  })
})

describe("抽奖：到点自动开奖", () => {
  it("过了结束时间且未开奖 → drawDueLotteries 开奖", async () => {
    const u = await makeUser()
    // 先报名（报名期必须未结束），再把结束时间改到过去 —— 模拟「活动到期」。
    // 直接建一条 ends_at 已过期的活动是不行的：那时用户根本报不了名（活动已结束）。
    const evId = await seedLottery({ winners: 1, pool: 40, endsAt: null })
    expect((await claim(evId, u)).status).toBe(200)
    await env.DB.prepare("UPDATE events SET ends_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 60_000).toISOString(), evId)
      .run()

    const r = await drawDueLotteries(env)
    expect(r.drawn).toBeGreaterThanOrEqual(1)
    expect(await drawnAt(evId)).toBeTruthy()
    expect(await getPointsBalance(env, u.id)).toBe(40)
  })

  it("没设结束时间的抽奖不会自动开（等管理员手动）", async () => {
    const u = await makeUser()
    const evId = await seedLottery({ winners: 1, pool: 40, endsAt: null })
    await claim(evId, u)

    await drawDueLotteries(env)
    expect(await drawnAt(evId)).toBeNull()
    expect(await getPointsBalance(env, u.id)).toBe(0)
  })

  it("还没到结束时间不会自动开", async () => {
    const u = await makeUser()
    const future = new Date(Date.now() + 3_600_000).toISOString()
    const evId = await seedLottery({ winners: 1, pool: 40, endsAt: future })
    await claim(evId, u)

    await drawDueLotteries(env)
    expect(await drawnAt(evId)).toBeNull()
  })
})

describe("抽奖：管理端创建校验", () => {
  const post = (admin: TestUser, body: Record<string, unknown>) =>
    fetchSelf(
      authRequest(admin, "/api/admin/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "抽奖活动", body: "正文", ...body }),
      })
    )

  it("合法的抽奖配置可以创建（奖励类型被固定为积分）", async () => {
    const admin = await makeAdmin()
    const res = await post(admin, {
      status: "draft",
      rewardType: "points",
      conditionType: "lottery",
      conditionParams: { winners: 3, pool: 300, mode: "random" },
    })
    expect(res.status).toBe(201)
    const ev = (await res.json<{ event: { lottery: unknown; rewardType: string } }>()).event
    expect(ev.rewardType).toBe("points")
    expect(ev.lottery).toEqual({ winners: 3, pool: 300, mode: "random", drawn: false })
  })

  it("抽奖参数非法 → 400", async () => {
    const admin = await makeAdmin()
    // 奖池少于中奖人数
    const res = await post(admin, {
      status: "draft",
      rewardType: "points",
      conditionType: "lottery",
      conditionParams: { winners: 5, pool: 3, mode: "even" },
    })
    expect(res.status).toBe(400)
  })

  it("抽奖活动配非积分奖励 → 400", async () => {
    const admin = await makeAdmin()
    const res = await post(admin, {
      status: "draft",
      rewardType: "newapi_quota",
      rewardParams: { amount: 10 },
      conditionType: "lottery",
      conditionParams: { winners: 2, pool: 100, mode: "even" },
    })
    expect(res.status).toBe(400)
  })
})
