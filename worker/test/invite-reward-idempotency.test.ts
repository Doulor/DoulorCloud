/**
 * 回归测试：邀请奖励的防重复必须是**原子占位**，不能「先查、再发、最后记录」。
 *
 * 漏洞原貌（2026-10-09 审计，issue #38）：
 *   `grantInviteReward` 的顺序是「① SELECT 查去重表 → ② 调 NewAPI 开订阅 → ③ INSERT 记去重」。
 *   两条触发路径并发时（同一被邀请人绑定第二个账号 / 走另一条捐献通道），
 *   两边都在 ① 读到「没有记录」，于是都去 ② 开订阅；③ 的唯一主键只拦住了**记录行**，
 *   没拦住**订阅** —— 后到的那次 INSERT 撞主键抛错，被函数最外层的 catch 静默吞掉。
 *   实测：NewAPI 订阅发放 2 次、`invite_rewards` 只有 1 行。
 *
 * 这个测试之所以必须存在：它是**唯一**能证明「去重真的生效」的手段。
 * 单线程顺序调用永远看不出问题 —— 第一次调用结束后记录已落库，第二次自然命中 ①。
 * 而并发窗口在真实环境里不需要精确同时：`aiGranted` 取的是 `requireUser` 读的那份
 * 用户快照（`wb2api.ts:536`），窗口 = 读快照到写权限之间的整段（含一次网关 poll 往返）。
 *
 * 断言取**不变式**（发放次数 == 记录行数 ≤ 1）而不是具体路径：这样即便将来实现方式
 * 再变，只要「一次奖励」的语义被破坏就会红。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, setSetting, authRequest, fetchSelf } from "./helpers"
import { uuid } from "../src/crypto"
import { grantInviteReward } from "../src/invite-rewards"
import { resetWb2ApiCache } from "../src/wb2api-client"

const NEWAPI = "https://api.doulor.cn"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/** 发往 NewAPI 的订阅开通请求（邀请奖励的唯一副作用） */
interface GrantCall {
  url: string
  body: unknown
}

let grantCalls: GrantCall[] = []
let restoreFetch: (() => void) | null = null
/** 让 NewAPI 的这次开通返回失败（验证「失败不记去重」的语义） */
let grantFails = false
/**
 * 让 NewAPI 以「该套餐购买上限」拒绝。
 *
 * 这一支必须与普通失败**分开测**：`adminGrantSubscription` 对「上限 / 已订阅 / already /
 * limit」这类文案有一条「当作已开通」的宽容分支，只有传了 `strictLimit: true` 才不吃它。
 * 邀请套餐一旦被设了限购，这条宽容分支会把「真实失败」误判成成功 ⇒ 邀请人静默丢奖励
 * （2026-10-08 成就奖励事故的同款根因）。本文件守住这个开关。
 */
let grantLimitRejected = false
/**
 * 人为拉宽「查去重 → 开订阅」之间的窗口，模拟真实网络往返（几十~几百 ms）。
 *
 * 不加这个延迟，两次并发调用可能在 miniflare 的语句串行化下错开，用例会侥幸通过 ——
 * 那正是最坏的情况：测试绿着，线上双发。
 */
const GRANT_LATENCY_MS = 80

/**
 * 打桩出站 fetch：只接管发往 NewAPI 的请求并计数，其余透传。
 * （workerd 里 `vi.mock` 拦不住模块内部的 `fetch`，只能替换 `globalThis.fetch`。）
 */
function stubNewApi(): void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(NEWAPI)) return original(input as RequestInfo, init)

    if (url.includes("/subscription/admin/users/")) {
      grantCalls.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      await new Promise((r) => setTimeout(r, GRANT_LATENCY_MS))
      if (grantLimitRejected) {
        // NewAPI model.CreateUserSubscriptionFromPlanTx 的原话
        return jsonResponse({ success: false, message: "已达到该套餐购买上限" }, 400)
      }
      if (grantFails) {
        return jsonResponse({ success: false, message: "上游开订阅失败" }, 500)
      }
      return jsonResponse({ success: true, message: "ok" })
    }
    // 其余 NewAPI 接口（币种信息等）不属于本用例的断言范围，一律成功应答
    return jsonResponse({ success: true, data: {} })
  }) as unknown as typeof fetch
  restoreFetch = () => {
    globalThis.fetch = original
  }
}

/** 造一对「邀请人 ← 邀请码 ← 被邀请人」，并给邀请人开通中转站账号（没开通则无从发订阅） */
async function seedInviterAndInvitee(): Promise<{
  inviterId: string
  invitee: { id: string; username: string }
}> {
  const inviter = await makeUser()
  const invitee = await makeUser()
  const now = new Date().toISOString()

  const codeId = uuid()
  await env.DB.prepare(
    "INSERT INTO invite_codes (id, code, created_by, max_uses, used_count, permissions, created_at)" +
      " VALUES (?, ?, ?, ?, 0, ?, ?)"
  )
    .bind(codeId, `INV${Date.now()}${Math.floor(Math.random() * 1000)}`, inviter.id, 10, "{}", now)
    .run()
  await env.DB.prepare("UPDATE users SET invite_code_id = ? WHERE id = ?")
    .bind(codeId, invitee.id)
    .run()

  // newapi_user_id 有唯一索引，用例共用同一 D1 —— 取随机数避免撞号
  await env.DB.prepare(
    "INSERT INTO newapi_accounts (user_id, newapi_user_id, username, email, enc_token, created_at)" +
      " VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(
      inviter.id,
      Math.floor(Math.random() * 1_000_000) + 1000,
      inviter.username,
      `${inviter.username}@doulor.cn`,
      "enc",
      now
    )
    .run()

  return { inviterId: inviter.id, invitee: { id: invitee.id, username: invitee.username } }
}

/** 去重表的行数（= 账面上「发过几次奖励」） */
async function rewardRows(inviteeId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM invite_rewards WHERE invitee_user_id = ?"
  )
    .bind(inviteeId)
    .first<{ c: number }>()
  return Number(row?.c ?? 0)
}

beforeEach(async () => {
  grantCalls = []
  grantFails = false
  grantLimitRejected = false
  restoreFetch = null
  await setSetting("invite_reward_enabled", "1")
  // 邀请奖励记录是全局表，用例之间会互相干扰（同一被邀请人只发一次）
  await env.DB.prepare("DELETE FROM invite_rewards").run()
})

describe("邀请奖励：原子占位（并发只能发一次）", () => {
  it("同一被邀请人并发触发两次：只开一张订阅，记录也只有一行（旧代码开两张）", async () => {
    const { invitee } = await seedInviterAndInvitee()
    stubNewApi()

    try {
      await Promise.all([
        grantInviteReward(env, invitee, 2),
        grantInviteReward(env, invitee, 2),
      ])
    } finally {
      restoreFetch?.()
    }

    const rows = await rewardRows(invitee.id)
    // 不变式：副作用次数不得超过记录行数（记录是「发过一次」的凭据）
    expect({ grants: grantCalls.length, rows }).toEqual({ grants: 1, rows: 1 })
  })

  it("三个并发也只发一次（不是「只防两次」）", async () => {
    const { invitee } = await seedInviterAndInvitee()
    stubNewApi()

    try {
      await Promise.all([
        grantInviteReward(env, invitee, 2),
        grantInviteReward(env, invitee, 2),
        grantInviteReward(env, invitee, 2),
      ])
    } finally {
      restoreFetch?.()
    }

    expect({ grants: grantCalls.length, rows: await rewardRows(invitee.id) }).toEqual({
      grants: 1,
      rows: 1,
    })
  })

  it("已发过奖励的被邀请人：连 NewAPI 都不该调（占位拿不到就提前返回）", async () => {
    const { inviterId, invitee } = await seedInviterAndInvitee()
    await env.DB.prepare(
      "INSERT INTO invite_rewards (invitee_user_id, inviter_user_id, granted_at, plan_id)" +
        " VALUES (?, ?, ?, ?)"
    )
      .bind(invitee.id, inviterId, new Date().toISOString(), 2)
      .run()
    stubNewApi()

    try {
      await grantInviteReward(env, invitee, 2)
    } finally {
      restoreFetch?.()
    }

    expect(grantCalls).toHaveLength(0)
    expect(await rewardRows(invitee.id)).toBe(1)
  })
})

describe("邀请奖励：正常路径与失败语义不回归", () => {
  it("首次触发：正常开一张订阅并记一行", async () => {
    const { inviterId, invitee } = await seedInviterAndInvitee()
    stubNewApi()

    try {
      await grantInviteReward(env, invitee, 2)
    } finally {
      restoreFetch?.()
    }

    expect(grantCalls).toHaveLength(1)
    expect(grantCalls[0].body).toEqual({ plan_id: 2 })
    const row = await env.DB.prepare(
      "SELECT inviter_user_id, plan_id FROM invite_rewards WHERE invitee_user_id = ?"
    )
      .bind(invitee.id)
      .first<{ inviter_user_id: string; plan_id: number }>()
    expect(row?.inviter_user_id).toBe(inviterId)
    expect(row?.plan_id).toBe(2)
  })

  it("发放失败**不记去重**：留出下次重试的机会，且重试能成功", async () => {
    const { invitee } = await seedInviterAndInvitee()
    stubNewApi()
    grantFails = true

    try {
      await grantInviteReward(env, invitee, 2)
      // 失败 → 占位必须撤回，否则该被邀请人被永久判为「已发过」而实际一分没拿到
      expect(await rewardRows(invitee.id)).toBe(0)

      // 上游恢复后重试：这次应当发出去
      grantFails = false
      await grantInviteReward(env, invitee, 2)
    } finally {
      restoreFetch?.()
    }

    expect(grantCalls).toHaveLength(2)
    expect(await rewardRows(invitee.id)).toBe(1)
  })

  it("发放失败后并发重试：也只有一个请求真正发出去", async () => {
    const { invitee } = await seedInviterAndInvitee()
    stubNewApi()
    grantFails = true
    try {
      await grantInviteReward(env, invitee, 2)
    } finally {
      restoreFetch?.()
    }
    expect(await rewardRows(invitee.id)).toBe(0)

    // 上游恢复：这次并发重试应当只有一次真正发出去
    grantFails = false
    grantCalls = []
    stubNewApi()
    try {
      await Promise.all([
        grantInviteReward(env, invitee, 2),
        grantInviteReward(env, invitee, 2),
      ])
    } finally {
      restoreFetch?.()
    }

    expect({ grants: grantCalls.length, rows: await rewardRows(invitee.id) }).toEqual({
      grants: 1,
      rows: 1,
    })
  })

  it("上游以「套餐购买上限」拒绝：算真实失败（strictLimit 没被去掉），占位撤回", async () => {
    const { invitee } = await seedInviterAndInvitee()
    stubNewApi()
    grantLimitRejected = true

    try {
      await grantInviteReward(env, invitee, 2)
    } finally {
      restoreFetch?.()
    }

    // 若 strictLimit 被去掉，adminGrantSubscription 会把「上限」当成「已订阅」返回 ok，
    // 于是这里会变成 rows=1（占位保留）—— 邀请人静默丢奖励。
    expect(grantCalls).toHaveLength(1)
    expect(await rewardRows(invitee.id)).toBe(0)
  })

  it("占位写入成功但 NewAPI 抛异常：也撤回占位（不变式两侧都守）", async () => {
    const { invitee } = await seedInviterAndInvitee()
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith(NEWAPI) && url.includes("/subscription/admin/users/")) {
        grantCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
        // 网络层直接抛（DNS 失败 / 连接被重置）——不是 ok:false，而是异常
        throw new Error("network down")
      }
      if (url.startsWith(NEWAPI)) return jsonResponse({ success: true, data: {} })
      return original(input as RequestInfo, init)
    }) as unknown as typeof fetch
    restoreFetch = () => {
      globalThis.fetch = original
    }

    try {
      // 函数自身吞掉异常（奖励是附加项，不阻断主流程），但**占位必须撤回**：
      // 否则该被邀请人被永久判为「已发过」，邀请人一分没拿到且无法重试。
      await grantInviteReward(env, invitee, 2)
    } finally {
      restoreFetch?.()
    }

    expect(grantCalls).toHaveLength(1)
    expect(await rewardRows(invitee.id)).toBe(0)
  })

  it("奖励开关关闭 / 套餐非法：不占位、不调 NewAPI", async () => {
    const { invitee } = await seedInviterAndInvitee()
    stubNewApi()
    await setSetting("invite_reward_enabled", "0")

    try {
      await grantInviteReward(env, invitee, 2)
      await grantInviteReward(env, invitee, 0)
    } finally {
      restoreFetch?.()
    }

    expect(grantCalls).toHaveLength(0)
    expect(await rewardRows(invitee.id)).toBe(0)
  })

  it("被邀请人不是邀请码注册的：不占位（没有邀请人就无从发奖）", async () => {
    const { invitee } = await seedInviterAndInvitee()
    await env.DB.prepare("UPDATE users SET invite_code_id = NULL WHERE id = ?")
      .bind(invitee.id)
      .run()
    stubNewApi()

    try {
      await grantInviteReward(env, invitee, 2)
    } finally {
      restoreFetch?.()
    }

    expect(grantCalls).toHaveLength(0)
    expect(await rewardRows(invitee.id)).toBe(0)
  })

  it("邀请人自己还没开通中转站：不占位，留待开通后再触发", async () => {
    const { inviterId, invitee } = await seedInviterAndInvitee()
    await env.DB.prepare("DELETE FROM newapi_accounts WHERE user_id = ?").bind(inviterId).run()
    stubNewApi()

    try {
      await grantInviteReward(env, invitee, 2)
    } finally {
      restoreFetch?.()
    }

    expect(grantCalls).toHaveLength(0)
    expect(await rewardRows(invitee.id)).toBe(0)
  })
})

/**
 * 端到端复现：**用户不写脚本就能撞上**的那条路径。
 *
 * 上面所有用例都是直接调 `grantInviteReward`，证明的是「这个函数是原子的」；
 * 但 issue #38 的核心主张是「两条触发路径并发时用户能自然撞上」，那要证明的是
 * 「经真实 HTTP 路由并发请求时只发一次」。两者不是同一件事 —— 中间还隔着
 * `requireUser` 读快照、二次限额校验、`env.DB.batch` 写绑定与权限。
 *
 * 实测（旧代码，3 轮一致）：两个标签页各走一遍 `login/poll`，NewAPI 发订阅 **2** 次、
 * `invite_rewards` 只有 1 行 —— 与 issue 里的探针数字吻合。
 */
describe("邀请奖励：经真实路由并发（用户可自然触发）", () => {
  const BASE = "https://wb2api.doulor.cn"
  /** poll 依次返回的上游 uid：模拟「两个标签页各登一个账号」 */
  let uidQueue: string[] = []
  let poolUids: string[] = []
  let restoreRouteFetch: (() => void) | null = null

  /**
   * 打桩反代网关：`overview` 报池内容（本站据此判断「有没有带来新资源」），
   * `login/poll` 按 `uidQueue` 依次返回不同上游账号。
   *
   * ⚠️ 必须用**两个不同 uid**：`wb2api_bindings.uid` 有唯一索引（0034_wb2api.sql:37），
   * 同一账号并发时第二个请求在写绑定那步就撞索引 500 了，压根走不到发奖 ——
   * 实测确认（同 uid 时两个 poll 状态 = 200/500）。所以「两个标签页」这个说法
   * 必须限定为「两个上游账号」，否则不成立。
   */
  function stubGateway(): void {
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith(BASE)) {
        if (url.includes("/panel/api/overview")) {
          return jsonResponse({
            ok: true,
            total: poolUids.length,
            healthy: poolUids.length,
            cooling: 0,
            disabled: 0,
            accounts: poolUids.map((uid) => ({ uid })),
          })
        }
        if (url.includes("/login/start")) {
          return jsonResponse({ ok: true, url: "https://example.com/oauth", state: "st-1" })
        }
        if (url.includes("/login/poll")) {
          const uid = uidQueue.shift() ?? "uid-fallback"
          // 网关是先 Add 进池、再返回结果
          poolUids.push(uid)
          await new Promise((r) => setTimeout(r, GRANT_LATENCY_MS))
          return jsonResponse({ ok: true, done: true, uid, nickname: uid })
        }
        return jsonResponse({ ok: false }, 404)
      }
      if (url.startsWith(NEWAPI)) {
        if (url.includes("/subscription/admin/users/")) {
          grantCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
          await new Promise((r) => setTimeout(r, GRANT_LATENCY_MS))
          return jsonResponse({ success: true, message: "ok" })
        }
        return jsonResponse({ success: true, data: {} })
      }
      return original(input as RequestInfo, init)
    }) as unknown as typeof fetch
    restoreRouteFetch = () => {
      globalThis.fetch = original
    }
  }

  /** 造一对「被邀请人（已用邀请人的码注册、ai 权限明确为 false）+ 邀请人（已开通中转站）」 */
  async function seedForRoute() {
    const inviter = await makeUser()
    const now = new Date().toISOString()
    const codeId = `code-${inviter.id}`
    await env.DB.prepare(
      "INSERT INTO invite_codes (id, code, created_by, max_uses, used_count, created_at)" +
        " VALUES (?, ?, ?, 10, 1, ?)"
    )
      .bind(codeId, `CODE${inviter.id.slice(0, 8)}`, inviter.id, now)
      .run()
    await env.DB.prepare(
      "INSERT INTO newapi_accounts (user_id, newapi_user_id, username, email, enc_token, created_at)" +
        " VALUES (?, ?, ?, ?, 'x', ?)"
    )
      .bind(
        inviter.id,
        Math.floor(Math.random() * 100_000_000) + 1000,
        inviter.username,
        `${inviter.username}@doulor.cn`,
        now
      )
      .run()

    const invitee = await makeUser()
    await env.DB.prepare("UPDATE users SET invite_code_id = ? WHERE id = ?")
      .bind(codeId, invitee.id)
      .run()
    await env.DB.prepare("UPDATE users SET permissions = ? WHERE id = ?")
      .bind(
        JSON.stringify({ r2: true, ai: false, frp: true, profile: true, proxy: true }),
        invitee.id
      )
      .run()
    return { invitee, inviterId: inviter.id }
  }

  async function startLogin(user: { cookie: string }): Promise<string> {
    const res = await fetchSelf(
      authRequest(user, "/api/wb2api/login/start", {
        method: "POST",
        body: JSON.stringify({ acknowledged: true }),
      })
    )
    expect(res.status).toBe(200)
    return ((await res.json()) as { sessionId: string }).sessionId
  }

  async function poll(user: { cookie: string }, sessionId: string) {
    const res = await fetchSelf(
      authRequest(user, `/api/wb2api/login/poll?session=${encodeURIComponent(sessionId)}`)
    )
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  beforeEach(async () => {
    uidQueue = []
    poolUids = []
    restoreRouteFetch = null
    resetWb2ApiCache()
    await env.DB.prepare("DELETE FROM rate_limits").run()
    await setSetting("wb2api_max_bindings", "3")
    await setSetting("wb2api_enabled", "1")
    await setSetting("invite_reward_enabled", "1")
    await setSetting("invite_reward_plan_id", "2")
  })

  afterEach(() => {
    restoreRouteFetch?.()
    restoreRouteFetch = null
    resetWb2ApiCache()
  })

  it("两个标签页各登一个上游账号、并发 poll：只开一张订阅（旧代码开两张）", async () => {
    const { invitee } = await seedForRoute()
    stubGateway()
    uidQueue = ["uid-a", "uid-b"]

    const s1 = await startLogin(invitee)
    const s2 = await startLogin(invitee)
    const [r1, r2] = await Promise.all([poll(invitee, s1), poll(invitee, s2)])

    // 两个请求都成功走到了发奖环节（没被前置校验挡掉）—— 否则这条用例是假绿
    expect([r1.status, r2.status]).toEqual([200, 200])
    expect({ grants: grantCalls.length, rows: await rewardRows(invitee.id) }).toEqual({
      grants: 1,
      rows: 1,
    })
  })

  it("同一上游账号并发 poll：第二个请求到不了发奖环节（钉住「两个上游账号」这个前提）", async () => {
    const { invitee } = await seedForRoute()
    stubGateway()
    uidQueue = ["uid-same", "uid-same"]

    const s1 = await startLogin(invitee)
    const s2 = await startLogin(invitee)
    const [r1, r2] = await Promise.all([poll(invitee, s1), poll(invitee, s2)])

    // ⚠️ 这条用例**不验证修复**（`grants: 1` 由第一个请求单独保证，去掉占位也照样绿）。
    //    它的作用是钉住一个前提：同 uid 并发时第二个请求根本走不到 `grantInviteReward` ——
    //    要么 `SELECT existing` 早于对方 INSERT 提交、走 `existing` 分支（200，但那条路
    //    `aiGranted` 恒为 false），要么撞 `wb2api_bindings.uid` 唯一索引（500）。
    //    实测 6 轮：5 次 [200,500]、1 次 [200,200] ⇒ **不能断言状态码**，那是在赌时序。
    //    所以 issue/PR 里「两个标签页」必须限定为「两个上游账号」，否则不成立。
    const statuses = [r1.status, r2.status].sort()
    expect(statuses[0]).toBe(200)
    expect(statuses[1]).toBeGreaterThanOrEqual(200)
    expect(grantCalls.length).toBeLessThanOrEqual(1)
  })
})
