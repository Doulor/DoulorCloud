/**
 * 回归测试：额度记账的并发安全与退还边界（2026-09-25 审计 M1 / 旧 P2-5 / L25）。
 *
 * M1（读-改-写竞态）原貌：
 *   `consumeQuotaForInvite` 先 `loadUserQuota()` 读出 `invite_quota_used`，
 *   在 JS 里 `+1`，再写回**绝对值**。并发两个建码请求都读到 0、都判定「还有额度」、
 *   都写回 1 —— **建出 2 个码却只扣 1 个额度**（模块额度同理）。
 *   项目在邀请码**消费**处早就用条件 UPDATE 做对了，额度记账一直没对齐。
 *
 * L25（退还不保守）原貌：
 *   删除邀请码时退还模块额度用的是 `quotaFeaturesOf(parsePermissions(raw))`，
 *   而 `parsePermissions(null)` 的语义是「**全开**」（为兼容老用户）。
 *   于是删掉一个 `permissions` 为 NULL 的历史码会一次退还全部 4 个模块额度，
 *   「建码 → 删码」循环即可凭空刷额度。
 *
 * 这两个都是「单线程调用完全看不出来」的缺陷，所以必须靠本文件的并发用例守住。
 */
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { uuid } from "../src/crypto"
import {
  consumeQuotaForInvite,
  refundQuotaForInvite,
  grantQuotaForDonation,
  loadUserQuota,
  quotaFeaturesFromStored,
} from "../src/quotas"
import { makeUser, authRequest, fetchSelf, setSetting } from "./helpers"

/** 把 r2 设为**受限**模块（invite_basic_features 为空串 = 全部受限） */
async function restrictAll() {
  await setSetting("invite_basic_features", "")
}

/** 直接设定某用户的额度字段 */
async function setQuota(
  userId: string,
  fields: {
    bonus?: number
    used?: number
    featureQuota?: string | null
    featureUsed?: string | null
  }
) {
  const sets: string[] = []
  const binds: unknown[] = []
  if (fields.bonus !== undefined) {
    sets.push("invite_quota_bonus = ?")
    binds.push(fields.bonus)
  }
  if (fields.used !== undefined) {
    sets.push("invite_quota_used = ?")
    binds.push(fields.used)
  }
  if (fields.featureQuota !== undefined) {
    sets.push("feature_quota = ?")
    binds.push(fields.featureQuota)
  }
  if (fields.featureUsed !== undefined) {
    sets.push("feature_quota_used = ?")
    binds.push(fields.featureUsed)
  }
  binds.push(userId)
  await env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run()
}

/** 读取原始列（绕过 loadUserQuota 的容错，看库里真实存了什么） */
async function rawRow(userId: string) {
  return env.DB.prepare(
    "SELECT invite_quota_bonus, invite_quota_used, feature_quota, feature_quota_used FROM users WHERE id = ?"
  )
    .bind(userId)
    .first<{
      invite_quota_bonus: number
      invite_quota_used: number
      feature_quota: string | null
      feature_quota_used: string | null
    }>()
}

beforeEach(async () => {
  await setSetting("invite_basic_features", "r2")
  await setSetting("invite_quota_base", "3")
})

describe("consumeQuotaForInvite 的并发原子性（M1）", () => {
  it("并发 5 次消费、额度只剩 1 时，只能成功 1 次", async () => {
    await setSetting("invite_quota_base", "1")
    const u = await makeUser()
    await setQuota(u.id, { used: 0, bonus: 0 })

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => consumeQuotaForInvite(env, u.id, []))
    )
    const ok = results.filter((r) => r.status === "fulfilled").length
    const rejected = results.filter((r) => r.status === "rejected")

    expect(ok).toBe(1)
    expect(rejected).toHaveLength(4)
    // 关键断言：**已用数必须等于成功数**。原实现会写回绝对值，
    // 5 个并发请求互相覆盖，最终 used 可能只有 1 而 5 次都「成功」。
    const row = await rawRow(u.id)
    expect(row?.invite_quota_used).toBe(1)
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason?.code).toBe("INVITE_QUOTA_EXCEEDED")
    }
  })

  it("并发 6 次消费、额度剩 3 时，成功数恰好 3", async () => {
    await setSetting("invite_quota_base", "3")
    const u = await makeUser()
    await setQuota(u.id, { used: 0, bonus: 0 })

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => consumeQuotaForInvite(env, u.id, []))
    )
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3)
    expect((await rawRow(u.id))?.invite_quota_used).toBe(3)
  })

  it("并发消费模块额度时也不会超额（feature_quota_used 走 JSON 相对累加）", async () => {
    await restrictAll()
    const u = await makeUser()
    // 邀请码额度给足，只让模块额度成为瓶颈：r2 只授了 2 个
    await setQuota(u.id, {
      used: 0,
      bonus: 100,
      featureQuota: JSON.stringify({ r2: 2 }),
      featureUsed: JSON.stringify({ r2: 0 }),
    })

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => consumeQuotaForInvite(env, u.id, ["r2"]))
    )
    const ok = results.filter((r) => r.status === "fulfilled").length
    expect(ok).toBe(2)

    const row = await rawRow(u.id)
    // 邀请码额度按成功次数扣（2），不能因为模块额度失败而多扣
    expect(row?.invite_quota_used).toBe(2)
    expect(JSON.parse(row?.feature_quota_used ?? "{}").r2).toBe(2)
    for (const r of results.filter((x) => x.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason?.code).toBe("FEATURE_QUOTA_EXCEEDED")
    }
  })

  it("多模块一次消费要么全扣、要么全不扣（不能出现半成品状态）", async () => {
    await restrictAll()
    const u = await makeUser()
    await setQuota(u.id, {
      used: 0,
      bonus: 100,
      // ai 有额度、frp 没有 —— 整笔必须失败，ai 也不能被扣
      featureQuota: JSON.stringify({ ai: 5, frp: 0 }),
      featureUsed: JSON.stringify({ ai: 0, frp: 0 }),
    })

    await expect(consumeQuotaForInvite(env, u.id, ["ai", "frp"])).rejects.toThrow()

    const row = await rawRow(u.id)
    expect(row?.invite_quota_used).toBe(0)
    expect(JSON.parse(row?.feature_quota_used ?? "{}")).toEqual({ ai: 0, frp: 0 })
  })
})

describe("JSON 计数列的边界（原先会写出 NULL 或 500）", () => {
  it("feature_quota_used 为 NULL 时消费，写出来的是合法 JSON 而不是 NULL", async () => {
    await restrictAll()
    const u = await makeUser()
    await setQuota(u.id, {
      used: 0,
      bonus: 10,
      featureQuota: JSON.stringify({ r2: 3 }),
      featureUsed: null,
    })

    await consumeQuotaForInvite(env, u.id, ["r2"])

    const row = await rawRow(u.id)
    // json_set(NULL, …) 会返回 NULL —— 那等于把计数整个抹掉
    expect(row?.feature_quota_used).not.toBe(null)
    expect(JSON.parse(row?.feature_quota_used ?? "null")).toEqual({ r2: 1 })
  })

  it("feature_quota_used 是损坏 JSON 时不 500，按 0 起算", async () => {
    await restrictAll()
    const u = await makeUser()
    await setQuota(u.id, {
      used: 0,
      bonus: 10,
      featureQuota: JSON.stringify({ r2: 3 }),
      featureUsed: "这不是 JSON",
    })

    await expect(consumeQuotaForInvite(env, u.id, ["r2"])).resolves.toBeUndefined()

    const row = await rawRow(u.id)
    expect(JSON.parse(row?.feature_quota_used ?? "null")).toEqual({ r2: 1 })
  })
})

describe("发放与退还都是相对运算（M1 的另一半）", () => {
  it("并发发放 5 次，+2 累加为 +10（原实现会互相覆盖）", async () => {
    await restrictAll()
    const u = await makeUser()
    await setQuota(u.id, {
      bonus: 0,
      featureQuota: JSON.stringify({ ai: 0 }),
      featureUsed: JSON.stringify({ ai: 0 }),
    })

    await Promise.all(
      Array.from({ length: 5 }, () => grantQuotaForDonation(env, u.id, "ai"))
    )

    const row = await rawRow(u.id)
    expect(row?.invite_quota_bonus).toBe(10)
    expect(JSON.parse(row?.feature_quota ?? "{}").ai).toBe(5)
  })

  it("基础权限模块发放时只加邀请码额度，不加模块额度", async () => {
    await setSetting("invite_basic_features", "r2")
    const u = await makeUser()
    await setQuota(u.id, { bonus: 0, featureQuota: JSON.stringify({ r2: 0 }) })

    await grantQuotaForDonation(env, u.id, "r2")

    const row = await rawRow(u.id)
    expect(row?.invite_quota_bonus).toBe(2)
    expect(JSON.parse(row?.feature_quota ?? "{}").r2).toBe(0)
  })

  it("退还不会把已用数减成负数", async () => {
    const u = await makeUser()
    await setQuota(u.id, {
      used: 0,
      featureUsed: JSON.stringify({ r2: 0, ai: 0, frp: 0, proxy: 0 }),
    })

    await refundQuotaForInvite(env, u.id, ["r2", "ai", "frp", "proxy"])

    const row = await rawRow(u.id)
    expect(row?.invite_quota_used).toBe(0)
    expect(JSON.parse(row?.feature_quota_used ?? "{}")).toEqual({
      r2: 0,
      ai: 0,
      frp: 0,
      proxy: 0,
    })
  })
})

describe("quotaFeaturesFromStored：退还必须保守（L25）", () => {
  it("NULL / 空串 / 损坏 JSON 一律视为「没消耗过模块额度」", () => {
    expect(quotaFeaturesFromStored(null)).toEqual([])
    expect(quotaFeaturesFromStored(undefined)).toEqual([])
    expect(quotaFeaturesFromStored("")).toEqual([])
    expect(quotaFeaturesFromStored("不是 JSON")).toEqual([])
    expect(quotaFeaturesFromStored("null")).toEqual([])
    expect(quotaFeaturesFromStored("[]")).toEqual([])
  })

  it("只认明确写着 true 的模块", () => {
    expect(
      quotaFeaturesFromStored(JSON.stringify({ r2: true, ai: false, frp: true }))
    ).toEqual(["r2", "frp"])
    // 非布尔真值不算（老数据里可能有 1 / "true"）
    expect(quotaFeaturesFromStored(JSON.stringify({ r2: 1, ai: "true" }))).toEqual([])
  })

  it("删除 permissions 为 NULL 的历史邀请码时，不会退还任何模块额度", async () => {
    const u = await makeUser()
    // 造一个「老数据」：permissions 为 NULL、从未被使用
    const inviteId = uuid()
    await env.DB.prepare(
      "INSERT INTO invite_codes (id, code, created_by, max_uses, used_count, permissions, created_at) VALUES (?, ?, ?, 1, 0, NULL, ?)"
    )
      .bind(inviteId, `LEGACY-${uuid().slice(0, 8)}`, u.id, new Date().toISOString())
      .run()
    await setQuota(u.id, {
      used: 2,
      featureUsed: JSON.stringify({ r2: 1, ai: 1, frp: 1, proxy: 1 }),
    })

    const res = await fetchSelf(
      authRequest(u, `/api/my-invites/${inviteId}`, { method: "DELETE" })
    )
    expect(res.status).toBe(200)

    const row = await rawRow(u.id)
    // 邀请码额度退 1（这部分本来就该退）
    expect(row?.invite_quota_used).toBe(1)
    // 模块额度一个都不能退 —— 原实现会一次退掉全部 4 个
    expect(JSON.parse(row?.feature_quota_used ?? "{}")).toEqual({
      r2: 1,
      ai: 1,
      frp: 1,
      proxy: 1,
    })
  })

  it("删除明确授予了模块的邀请码时，正常退还那一个模块", async () => {
    await restrictAll()
    const u = await makeUser()
    await setQuota(u.id, {
      used: 1,
      bonus: 10,
      featureQuota: JSON.stringify({ r2: 2 }),
      featureUsed: JSON.stringify({ r2: 1 }),
    })

    // 走真实接口建码（会消耗 1 个 r2 额度）
    const created = await fetchSelf(
      authRequest(u, "/api/my-invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ features: ["r2"] }),
      })
    )
    expect(created.status).toBe(201)
    const inviteId = (await created.json<{ invite: { id: string } }>()).invite.id

    let row = await rawRow(u.id)
    expect(row?.invite_quota_used).toBe(2)
    expect(JSON.parse(row?.feature_quota_used ?? "{}").r2).toBe(2)

    const del = await fetchSelf(
      authRequest(u, `/api/my-invites/${inviteId}`, { method: "DELETE" })
    )
    expect(del.status).toBe(200)

    row = await rawRow(u.id)
    expect(row?.invite_quota_used).toBe(1)
    expect(JSON.parse(row?.feature_quota_used ?? "{}").r2).toBe(1)
  })
})

describe("loadUserQuota 仍能正确读出相对累加后的值", () => {
  it("消费与发放交错后，剩余额度自洽", async () => {
    await restrictAll()
    const u = await makeUser()
    await setQuota(u.id, {
      used: 0,
      bonus: 0,
      featureQuota: JSON.stringify({ ai: 0 }),
      featureUsed: JSON.stringify({ ai: 0 }),
    })
    await setSetting("invite_quota_base", "2")

    await grantQuotaForDonation(env, u.id, "ai") // bonus +2, ai +1
    await consumeQuotaForInvite(env, u.id, ["ai"]) // used +1, ai_used +1

    const quota = await loadUserQuota(env, u.id)
    expect(quota.inviteTotal).toBe(4) // base 2 + bonus 2
    expect(quota.inviteUsed).toBe(1)
    expect(quota.inviteRemaining).toBe(3)
    expect(quota.featureQuota.ai).toBe(1)
    expect(quota.featureUsed.ai).toBe(1)
    expect(quota.featureRemaining.ai).toBe(0)
  })
})
