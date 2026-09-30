// 积分转账：用户间零和转移，只需转出方确认。
//
// 覆盖：
//   1. 正常转账：两边一减一加、总额不变，流水 reason 正确
//   2. 余额不足 → 失败且**两边都不变**
//   3. 不能转给自己 / 金额非法
//   4. HTTP 层：找不到用户 404、参数非法 400、非管理员不涉及
//   5. ⚠️ 不触发邀请返佣（转账不是平台增发，给它返佣等于凭空造分）
//   6. ⚠️ 「累计发放」统计必须排除 transfer_in（否则用户互转一次就凭空涨一倍）
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { uuid } from "../src/crypto"
import { applyPoints, getPointsBalance, transferPoints } from "../src/points"
import { makeUser, authRequest, fetchSelf, setSetting, type TestUser } from "./helpers"

/** 直接给某人发分（测试准备用；reason 用 admin，避免触发返佣） */
async function give(user: TestUser, amount: number): Promise<void> {
  await applyPoints(env, {
    userId: user.id,
    delta: amount,
    reason: "admin",
    detail: "测试预置",
    dedupKey: `seed:${uuid()}`,
  })
}

async function txRows(userId: string, reason?: string) {
  const sql =
    "SELECT delta, reason, detail FROM point_transactions WHERE user_id = ?" +
    (reason ? " AND reason = ?" : "")
  const stmt = env.DB.prepare(sql)
  const rows = reason ? await stmt.bind(userId, reason).all() : await stmt.bind(userId).all()
  return rows.results ?? []
}

async function transferViaHttp(user: TestUser, username: string, amount: number): Promise<Response> {
  return fetchSelf(
    authRequest(user, "/api/points/transfer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, amount }),
    })
  )
}

beforeEach(async () => {
  // 返佣开关默认关；下面「不返佣」那条用例会单独打开它
  await setSetting("invite_points_enabled", "0")
})

describe("积分转账：核心行为", () => {
  it("正常转账：一减一加，总额不变，流水 reason 正确", async () => {
    const a = await makeUser()
    const b = await makeUser()
    await give(a, 100)

    const res = await transferPoints(env, {
      fromUserId: a.id,
      fromUsername: a.username,
      toUserId: b.id,
      toUsername: b.username,
      amount: 30,
    })
    expect(res.ok).toBe(true)
    expect(await getPointsBalance(env, a.id)).toBe(70)
    expect(await getPointsBalance(env, b.id)).toBe(30)
    // 零和：总量守恒
    expect((await getPointsBalance(env, a.id)) + (await getPointsBalance(env, b.id))).toBe(100)

    const out = await txRows(a.id, "transfer_out")
    expect(out).toHaveLength(1)
    expect(out[0].delta).toBe(-30)
    const inn = await txRows(b.id, "transfer_in")
    expect(inn).toHaveLength(1)
    expect(inn[0].delta).toBe(30)
  })

  it("余额不足：失败且两边都不变（不会出现负余额）", async () => {
    const a = await makeUser()
    const b = await makeUser()
    await give(a, 10)

    const res = await transferPoints(env, {
      fromUserId: a.id,
      fromUsername: a.username,
      toUserId: b.id,
      toUsername: b.username,
      amount: 50,
    })
    expect(res.ok).toBe(false)
    expect(await getPointsBalance(env, a.id)).toBe(10)
    expect(await getPointsBalance(env, b.id)).toBe(0)
    expect(await txRows(a.id, "transfer_out")).toHaveLength(0)
    expect(await txRows(b.id, "transfer_in")).toHaveLength(0)
  })

  it("不能转给自己 / 金额必须 ≥ 1 的整数", async () => {
    const a = await makeUser()
    await give(a, 100)
    const base = { fromUserId: a.id, fromUsername: a.username, toUserId: a.id, toUsername: a.username }

    expect((await transferPoints(env, { ...base, amount: 10 })).ok).toBe(false)
    expect((await transferPoints(env, { ...base, toUserId: "x", toUsername: "y", amount: 0 })).ok).toBe(false)
    expect((await transferPoints(env, { ...base, toUserId: "x", toUsername: "y", amount: -5 })).ok).toBe(false)
    expect(await getPointsBalance(env, a.id)).toBe(100)
  })

  it("可以连续转多笔（每笔独立，不互相幂等掉）", async () => {
    const a = await makeUser()
    const b = await makeUser()
    await give(a, 100)

    for (const n of [10, 20, 30]) {
      const res = await transferPoints(env, {
        fromUserId: a.id,
        fromUsername: a.username,
        toUserId: b.id,
        toUsername: b.username,
        amount: n,
      })
      expect(res.ok).toBe(true)
    }
    expect(await getPointsBalance(env, a.id)).toBe(40)
    expect(await getPointsBalance(env, b.id)).toBe(60)
    expect(await txRows(a.id, "transfer_out")).toHaveLength(3)
  })
})

describe("积分转账：HTTP 接口", () => {
  it("凭用户名转给对方，返回新余额", async () => {
    const a = await makeUser()
    const b = await makeUser()
    await give(a, 50)

    const res = await transferViaHttp(a, b.username, 20)
    expect(res.status).toBe(200)
    const body = await res.json<{ ok: boolean; balance: number; to: string }>()
    expect(body.ok).toBe(true)
    expect(body.balance).toBe(30)
    expect(body.to).toBe(b.username)
    expect(await getPointsBalance(env, b.id)).toBe(20)
  })

  it("用户名不区分大小写", async () => {
    const a = await makeUser()
    const b = await makeUser()
    await give(a, 50)
    const res = await transferViaHttp(a, b.username.toUpperCase(), 5)
    expect(res.status).toBe(200)
    expect(await getPointsBalance(env, b.id)).toBe(5)
  })

  it("找不到用户 → 404；金额非法 → 400；转给自己 → 400", async () => {
    const a = await makeUser()
    await give(a, 50)

    expect((await transferViaHttp(a, "no_such_user_xyz", 5)).status).toBe(404)
    expect((await transferViaHttp(a, a.username, 0)).status).toBe(400)
    expect((await transferViaHttp(a, a.username, 5)).status).toBe(400)
    expect((await transferViaHttp(a, "", 5)).status).toBe(400)
  })

  it("余额不足 → 400，余额不变", async () => {
    const a = await makeUser()
    const b = await makeUser()
    await give(a, 5)
    const res = await transferViaHttp(a, b.username, 100)
    expect(res.status).toBe(400)
    expect(await getPointsBalance(env, a.id)).toBe(5)
    expect(await getPointsBalance(env, b.id)).toBe(0)
  })
})

describe("积分转账：与返佣 / 统计的关系", () => {
  it("⚠️ 收到转账**不触发**邀请返佣（否则等于凭空造分）", async () => {
    // 打开返佣开关并给 B 安排一个邀请人
    await setSetting("invite_points_enabled", "1")
    await setSetting("invite_points_commission_percent", "10")

    const inviter = await makeUser()
    const b = await makeUser()
    const a = await makeUser()
    await give(a, 100)

    // 把 B 挂到 inviter 名下（走 invite_codes 关系）
    const codeId = uuid()
    await env.DB.prepare(
      "INSERT INTO invite_codes (id, code, created_by, max_uses, used_count, permissions, created_at)" +
        " VALUES (?, ?, ?, 1, 1, ?, ?)"
    )
      .bind(codeId, `TC-${codeId.slice(0, 6)}`, inviter.id, JSON.stringify({ r2: false, ai: false, frp: false, proxy: false }), new Date().toISOString())
      .run()
    await env.DB.prepare("UPDATE users SET invite_code_id = ? WHERE id = ?").bind(codeId, b.id).run()

    // 对照组：给 B 发一笔「活动奖励」（在白名单里）→ 邀请人应拿到 10%
    await applyPoints(env, {
      userId: b.id,
      delta: 100,
      reason: "event",
      detail: "活动奖励",
      dedupKey: `evt-check:${uuid()}`,
    })
    expect(await getPointsBalance(env, inviter.id)).toBe(10)

    // 正式验证：A 转 50 给 B —— 邀请人**不该**再涨
    const res = await transferPoints(env, {
      fromUserId: a.id,
      fromUsername: a.username,
      toUserId: b.id,
      toUsername: b.username,
      amount: 50,
    })
    expect(res.ok).toBe(true)
    expect(await getPointsBalance(env, b.id)).toBe(150)
    expect(await getPointsBalance(env, inviter.id)).toBe(10) // 没变
  })

  it("⚠️「累计发放」统计排除 transfer_in（零和转移不算平台增发）", async () => {
    const a = await makeUser()
    const b = await makeUser()
    await give(a, 100)

    // ⚠️ 用「转账前后的差值」断言，不要写死绝对值 —— 同一文件里的用例共享数据库，
    // 前面用例发的分也在表里
    const sum = () =>
      env.DB.prepare(
        `SELECT COALESCE(SUM(CASE WHEN delta > 0 AND reason NOT IN ('shop_sell','transfer_in') THEN delta ELSE 0 END), 0) AS issued,
                COALESCE(SUM(CASE WHEN reason IN ('shop_sell','transfer_in') AND delta > 0 THEN delta ELSE 0 END), 0) AS traded
           FROM point_transactions`
      ).first<{ issued: number; traded: number }>()

    const before = await sum()
    await transferPoints(env, {
      fromUserId: a.id,
      fromUsername: a.username,
      toUserId: b.id,
      toUsername: b.username,
      amount: 100,
    })
    const after = await sum()

    // 转账不增加「累计发放」，但计入「用户间转移」
    expect(Number(after?.issued)).toBe(Number(before?.issued))
    expect(Number(after?.traded)).toBe(Number(before?.traded) + 100)
  })
})
