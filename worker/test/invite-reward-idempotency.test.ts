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
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, setSetting } from "./helpers"
import { uuid } from "../src/crypto"
import { grantInviteReward } from "../src/invite-rewards"

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
