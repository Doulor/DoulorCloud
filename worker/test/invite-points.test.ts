/**
 * 邀请奖励积分 + 邀请返佣（2026-09-30）。
 *
 * 两笔账都发给**邀请人**：
 *   1. `invite`            —— 每成功邀请 1 个好友注册，固定发 `invite_points_per_friend` 分
 *   2. `invite_commission` —— 被邀请人之后赚到分（捐献 / 活动）时按比例返佣（**一级**）
 *
 * 最要守住的几条（都有对应用例）：
 *   · **误发比漏发严重得多**：积分能按 `points_yuan_per_point` 兑成真钱，
 *     所以返佣必须排除 admin / shop_sell / invite 自身，且零头（< 1 分）不发；
 *   · **不能变成多级传销**：返佣不对「返佣」返佣（A→B→C 只有 B 拿钱）；
 *   · **不能变成小号刷分**：开放注册期间「不含权限的邀请码」不消耗次数，
 *     默认 `requireConsumed` 必须把这种邀请挡在奖励之外；
 *   · 幂等：同一个被邀请人只发一次，同一笔源流水只返一次。
 */
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { uuid } from "../src/crypto"
import { applyPoints, getInvitePointsConfig, getPointsBalance } from "../src/points"
import { makeUser, authRequest, fetchSelf, setSetting } from "./helpers"

/** 建一条邀请码，返回 id */
async function makeInviteCode(
  code: string,
  createdBy: string | null,
  permissions = JSON.stringify({ r2: false, ai: false, frp: false, proxy: false }),
  maxUses = 1
): Promise<string> {
  const id = uuid()
  await env.DB.prepare(
    "INSERT INTO invite_codes (id, code, created_by, max_uses, used_count, permissions, created_at)" +
      " VALUES (?, ?, ?, ?, 0, ?, ?)"
  )
    .bind(id, code, createdBy, maxUses, permissions, new Date().toISOString())
    .run()
  return id
}

/** 把某个用户标记成「由该邀请码注册来的」 */
async function markInvited(userId: string, codeId: string): Promise<void> {
  await env.DB.prepare("UPDATE users SET invite_code_id = ? WHERE id = ?")
    .bind(codeId, userId)
    .run()
}

/** 走真实注册路由建一个号（返回用户名） */
async function registerWith(username: string, code: string, ip: string): Promise<number> {
  const res = await fetchSelf(
    new Request("https://cloud.doulor.cn/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({
        username,
        email: `${username}@example.com`,
        password: "pass12345",
        inviteCode: code,
      }),
    })
  )
  return res.status
}

/** 某用户某来源的流水 */
async function txRows(userId: string, reason: string) {
  const r = await env.DB.prepare(
    "SELECT delta, detail, dedup_key FROM point_transactions WHERE user_id = ? AND reason = ? ORDER BY created_at"
  )
    .bind(userId, reason)
    .all<{ delta: number; detail: string | null; dedup_key: string | null }>()
  return r.results ?? []
}

/** 打开邀请奖励（默认参数，用例按需覆盖） */
async function enableInvitePoints(opts: {
  perFriend?: number
  percent?: number
  dailyLimit?: number
  requireConsumed?: boolean
} = {}): Promise<void> {
  await setSetting("invite_points_enabled", "1")
  await setSetting("invite_points_per_friend", String(opts.perFriend ?? 20))
  await setSetting("invite_points_commission_percent", String(opts.percent ?? 10))
  await setSetting("invite_points_daily_limit", String(opts.dailyLimit ?? 0))
  await setSetting("invite_points_require_consumed", opts.requireConsumed === false ? "0" : "1")
}

beforeEach(async () => {
  // app_settings 在用例间共享（同一个 D1），逐条清掉本文件涉及的键
  await env.DB.prepare(
    "DELETE FROM app_settings WHERE key IN (" +
      "'invite_points_enabled','invite_points_per_friend'," +
      "'invite_points_commission_percent','invite_points_daily_limit'," +
      "'invite_points_require_consumed'," +
      "'open_registration','open_registration_until','invite_basic_features')"
  ).run()
})

describe("邀请奖励配置的默认值与清洗", () => {
  it("默认**关闭**（绝不能一上线就开始发钱）", async () => {
    const cfg = await getInvitePointsConfig(env)
    expect(cfg.enabled).toBe(false)
    // 数值字段的默认值只是「面板里预填的数字」，开关关着就一分不发
    expect(cfg.perFriend).toBe(20)
    expect(cfg.commissionPercent).toBe(10)
    expect(cfg.requireConsumed).toBe(true)
  })

  it("负数 / 脏值一律按 0（不发）处理，比例上限 100%", async () => {
    await setSetting("invite_points_per_friend", "-5")
    await setSetting("invite_points_commission_percent", "500")
    await setSetting("invite_points_daily_limit", "abc")
    const cfg = await getInvitePointsConfig(env)
    expect(cfg.perFriend).toBe(0)
    expect(cfg.commissionPercent).toBe(100)
    expect(cfg.dailyLimit).toBe(0)
  })
})

describe("邀请奖励：每邀请 1 个好友", () => {
  it("开关关闭时，带邀请码注册不发分", async () => {
    const inviter = await makeUser()
    const code = `IV0-${uuid().slice(0, 8)}`
    await makeInviteCode(code, inviter.id)

    expect(await registerWith(`ivin-${uuid().slice(0, 8)}`, code, "10.31.0.1")).toBe(201)
    expect(await getPointsBalance(env, inviter.id)).toBe(0)
  })

  it("开启后：邀请人得 20 分，流水来源是 invite", async () => {
    await enableInvitePoints()
    const inviter = await makeUser()
    const code = `IV1-${uuid().slice(0, 8)}`
    await makeInviteCode(code, inviter.id)

    const invitee = `ivin-${uuid().slice(0, 8)}`
    expect(await registerWith(invitee, code, "10.31.1.1")).toBe(201)

    expect(await getPointsBalance(env, inviter.id)).toBe(20)
    const rows = await txRows(inviter.id, "invite")
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].delta)).toBe(20)
    expect(rows[0].detail).toContain(invitee)
  })

  it("幂等：同一个被邀请人只发一次（重复触发不会翻倍）", async () => {
    await enableInvitePoints()
    const inviter = await makeUser()
    const code = `IV2-${uuid().slice(0, 8)}`
    const codeId = await makeInviteCode(code, inviter.id)
    const invitee = await makeUser()
    await markInvited(invitee.id, codeId)

    // 直接调两次（模拟「注册成功」被重复触发）
    const { grantInvitePoints } = await import("../src/points")
    await grantInvitePoints(env, {
      inviteeId: invitee.id,
      inviteeUsername: invitee.username,
      codeConsumed: true,
    })
    await grantInvitePoints(env, {
      inviteeId: invitee.id,
      inviteeUsername: invitee.username,
      codeConsumed: true,
    })

    expect(await getPointsBalance(env, inviter.id)).toBe(20)
    expect(await txRows(inviter.id, "invite")).toHaveLength(1)
  })

  it("自己邀请自己不发（防「建码→自己用→奖励回自己口袋」）", async () => {
    await enableInvitePoints()
    const u = await makeUser()
    const codeId = await makeInviteCode(`IV3-${uuid().slice(0, 8)}`, u.id)
    await markInvited(u.id, codeId)

    const { grantInvitePoints } = await import("../src/points")
    const got = await grantInvitePoints(env, {
      inviteeId: u.id,
      inviteeUsername: u.username,
      codeConsumed: true,
    })
    expect(got).toBe(0)
    expect(await getPointsBalance(env, u.id)).toBe(0)
  })

  it("没人邀请注册的账号不发（没有邀请码可溯源）", async () => {
    await enableInvitePoints()
    const u = await makeUser()
    const { grantInvitePoints } = await import("../src/points")
    expect(
      await grantInvitePoints(env, {
        inviteeId: u.id,
        inviteeUsername: u.username,
        codeConsumed: true,
      })
    ).toBe(0)
  })
})

describe("有效邀请的门槛：requireConsumed（防小号刷分）", () => {
  it("开放注册期间：不含权限的码不消耗次数 ⇒ 默认不发奖励", async () => {
    await setSetting("open_registration", "1")
    await setSetting("invite_basic_features", "")
    await enableInvitePoints() // requireConsumed 默认 true

    const inviter = await makeUser()
    const code = `IV4-${uuid().slice(0, 8)}`
    await makeInviteCode(code, inviter.id)

    expect(await registerWith(`ivin-${uuid().slice(0, 8)}`, code, "10.31.2.1")).toBe(201)

    // 码没被消费（可无限复用），所以不算有效邀请
    const used = await env.DB.prepare("SELECT used_count FROM invite_codes WHERE code = ?")
      .bind(code)
      .first<{ used_count: number }>()
    expect(Number(used?.used_count)).toBe(0)
    expect(await getPointsBalance(env, inviter.id)).toBe(0)
  })

  it("关掉这道闸之后，同样的邀请就发分（站长自己权衡）", async () => {
    await setSetting("open_registration", "1")
    await setSetting("invite_basic_features", "")
    await enableInvitePoints({ requireConsumed: false })

    const inviter = await makeUser()
    const code = `IV5-${uuid().slice(0, 8)}`
    await makeInviteCode(code, inviter.id)

    expect(await registerWith(`ivin-${uuid().slice(0, 8)}`, code, "10.31.3.1")).toBe(201)
    expect(await getPointsBalance(env, inviter.id)).toBe(20)
  })
})

describe("邀请返佣：好友赚分时邀请人抽成", () => {
  /** 建一对「A 邀请了 B」的用户 */
  async function pair() {
    const inviter = await makeUser()
    const codeId = await makeInviteCode(`IC-${uuid().slice(0, 8)}`, inviter.id)
    const invitee = await makeUser()
    await markInvited(invitee.id, codeId)
    return { inviter, invitee }
  }

  it("捐献积分：100 分 → 邀请人得 10 分（10%）", async () => {
    await enableInvitePoints({ percent: 10 })
    const { inviter, invitee } = await pair()

    await applyPoints(env, {
      userId: invitee.id,
      delta: 100,
      reason: "donation",
      dedupKey: "donation:t1",
    })

    expect(await getPointsBalance(env, invitee.id)).toBe(100)
    expect(await getPointsBalance(env, inviter.id)).toBe(10)
    const rows = await txRows(inviter.id, "invite_commission")
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].delta)).toBe(10)
  })

  it("活动奖励也参与返佣", async () => {
    await enableInvitePoints({ percent: 10 })
    const { inviter, invitee } = await pair()
    await applyPoints(env, { userId: invitee.id, delta: 50, reason: "event" })
    expect(await getPointsBalance(env, inviter.id)).toBe(5)
  })

  it("管理员手动发放 / 商城售出 / 邀请奖励本身 **都不**返佣", async () => {
    await enableInvitePoints({ percent: 10 })
    const { inviter, invitee } = await pair()

    await applyPoints(env, { userId: invitee.id, delta: 100, reason: "admin" })
    await applyPoints(env, { userId: invitee.id, delta: 100, reason: "shop_sell" })
    await applyPoints(env, { userId: invitee.id, delta: 100, reason: "invite" })

    expect(await getPointsBalance(env, invitee.id)).toBe(300)
    expect(await getPointsBalance(env, inviter.id)).toBe(0)
  })

  it("不多级抽成：A→B→C，C 捐献只有 B 拿钱，A 拿 0", async () => {
    await enableInvitePoints({ percent: 10 })
    const a = await makeUser()
    const codeA = await makeInviteCode(`IC2-${uuid().slice(0, 8)}`, a.id)
    const b = await makeUser()
    await markInvited(b.id, codeA)
    const codeB = await makeInviteCode(`IC3-${uuid().slice(0, 8)}`, b.id)
    const c = await makeUser()
    await markInvited(c.id, codeB)

    await applyPoints(env, { userId: c.id, delta: 100, reason: "donation" })

    expect(await getPointsBalance(env, b.id)).toBe(10)
    // A 是 B 的邀请人，但 B 这笔收入来源是 invite_commission ⇒ 不再返佣
    expect(await getPointsBalance(env, a.id)).toBe(0)
  })

  it("零头不发：3 分 × 10% = 0.3 分 ⇒ 一分都不发（积分是整数）", async () => {
    await enableInvitePoints({ percent: 10 })
    const { inviter, invitee } = await pair()
    await applyPoints(env, { userId: invitee.id, delta: 3, reason: "donation" })
    expect(await getPointsBalance(env, inviter.id)).toBe(0)
  })

  it("幂等：同一笔源流水重复落账只会返一次", async () => {
    await enableInvitePoints({ percent: 10 })
    const { inviter, invitee } = await pair()

    await applyPoints(env, {
      userId: invitee.id,
      delta: 100,
      reason: "donation",
      dedupKey: "donation:same",
    })
    // 第二次同 dedupKey 会走「幂等命中」分支，不会再加分、也不会再返佣
    const again = await applyPoints(env, {
      userId: invitee.id,
      delta: 100,
      reason: "donation",
      dedupKey: "donation:same",
    })
    expect(again.applied).toBe(false)
    expect(again.reason).toBe("duplicated")

    expect(await getPointsBalance(env, invitee.id)).toBe(100)
    expect(await getPointsBalance(env, inviter.id)).toBe(10)
  })

  it("返佣是「平台增发」：邀请人的分来自平台，不是从被邀请人账上扣", async () => {
    await enableInvitePoints({ percent: 10 })
    const { inviter, invitee } = await pair()
    await applyPoints(env, { userId: invitee.id, delta: 100, reason: "donation" })

    expect(await getPointsBalance(env, invitee.id)).toBe(100) // 一分没少
    expect(await getPointsBalance(env, inviter.id)).toBe(10)
  })
})

describe("每日上限：奖励与返佣共用一个额度", () => {
  it("当日额度用满后，后续邀请与返佣都不再发", async () => {
    await enableInvitePoints({ perFriend: 20, percent: 10, dailyLimit: 20 })

    const inviter = await makeUser()
    const code = `ID1-${uuid().slice(0, 8)}`
    const codeId = await makeInviteCode(code, inviter.id, undefined, 100)
    const invitee = await makeUser()
    await markInvited(invitee.id, codeId)

    const { grantInvitePoints } = await import("../src/points")
    // 第一笔：拿满 20
    expect(
      await grantInvitePoints(env, {
        inviteeId: invitee.id,
        inviteeUsername: invitee.username,
        codeConsumed: true,
      })
    ).toBe(20)
    // 第二笔：当日额度已用尽
    const another = await makeUser()
    await markInvited(another.id, codeId)
    expect(
      await grantInvitePoints(env, {
        inviteeId: another.id,
        inviteeUsername: another.username,
        codeConsumed: true,
      })
    ).toBe(0)

    // 返佣同样被这个额度挡住
    await applyPoints(env, { userId: invitee.id, delta: 100, reason: "donation" })
    expect(await getPointsBalance(env, inviter.id)).toBe(20)
  })
})

describe("PUT /api/admin/points/config —— 邀请奖励配置", () => {
  const put = (admin: { cookie: string }, payload: Record<string, unknown>) =>
    fetchSelf(
      authRequest(admin, "/api/admin/points/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
    )

  it("能保存并在 GET shop 里读回来", async () => {
    const admin = await makeUser({ role: "admin" })
    const res = await put(admin, {
      invitePoints: {
        enabled: true,
        perFriend: 5,
        commissionPercent: 2.5,
        dailyLimit: 100,
        requireConsumed: false,
      },
    })
    expect(res.status).toBe(200)
    const body = await res.json<{ inviteConfig: Record<string, unknown> }>()
    expect(body.inviteConfig).toEqual({
      enabled: true,
      perFriend: 5,
      commissionPercent: 2.5,
      dailyLimit: 100,
      requireConsumed: false,
    })

    const shop = await fetchSelf(authRequest(admin, "/api/admin/points/shop"))
    const shopBody = await shop.json<{ inviteConfig: Record<string, unknown> }>()
    expect(shopBody.inviteConfig).toEqual(body.inviteConfig)
  })

  it("非法值被拒（400）", async () => {
    const admin = await makeUser({ role: "admin" })
    expect((await put(admin, { invitePoints: { commissionPercent: 200 } })).status).toBe(400)
    expect((await put(admin, { invitePoints: { perFriend: -1 } })).status).toBe(400)
    expect((await put(admin, { invitePoints: { dailyLimit: 99999999 } })).status).toBe(400)
    expect((await put(admin, { invitePoints: "oops" })).status).toBe(400)
  })

  it("非管理员改不了", async () => {
    const u = await makeUser()
    expect((await put(u, { invitePoints: { enabled: true } })).status).toBe(403)
  })
})
