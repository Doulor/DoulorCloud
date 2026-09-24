// 权限兑换码：首捐奖励的「自选权限」券 + 用别人给的邀请码补齐权限。
//
// 这条链路的风险集中在「谁能用、能开什么、会不会重复」三件事上，
// 所以用例围绕边界写：自己建的码不能自用、已拥有的模块不能重复开、
// 一张券只能用一次、首捐券一辈子只有一张。
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, setPermissions, type TestUser } from "./helpers"
import { uuid } from "../src/crypto"
import { grantFirstDonationVoucher } from "../src/vouchers"
import { parsePermissions } from "../src/permissions"

/** 直接塞一张券 */
async function seedVoucher(opts: {
  owner: string
  feature?: string | null
  transferable?: boolean
  status?: string
  source?: string
  code?: string
}): Promise<string> {
  const code = opts.code ?? `VX-TEST-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
  await env.DB.prepare(
    `INSERT INTO vouchers
       (id, code, owner_user_id, source, feature, transferable, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      uuid(),
      code,
      opts.owner,
      opts.source ?? "admin",
      opts.feature ?? null,
      opts.transferable ? 1 : 0,
      opts.status ?? "unused",
      new Date().toISOString()
    )
    .run()
  return code
}

/** 直接塞一个邀请码（默认由别人创建） */
async function seedInvite(opts: {
  createdBy: string
  permissions: Record<string, boolean>
  code?: string
  maxUses?: number
  usedCount?: number
}): Promise<string> {
  const code = opts.code ?? `INV-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
  await env.DB.prepare(
    `INSERT INTO invite_codes (id, code, created_by, max_uses, used_count, permissions, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      uuid(),
      code,
      opts.createdBy,
      opts.maxUses ?? 1,
      opts.usedCount ?? 0,
      JSON.stringify(opts.permissions),
      new Date().toISOString()
    )
    .run()
  return code
}

/** 直接塞一条已通过的捐献（用于触发首捐券） */
async function seedApprovedDonation(userId: string, status = "approved") {
  await env.DB.prepare(
    `INSERT INTO donations (id, user_id, type, payload, notify_email, status, created_at)
     VALUES (?, ?, 'frp', '{}', 'x@example.net', ?, ?)`
  )
    .bind(uuid(), userId, status, new Date().toISOString())
    .run()
}

async function redeem(user: TestUser, code: string, feature?: string) {
  const res = await fetchSelf(
    authRequest(user, "/vouchers/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, feature }),
    })
  )
  return { res, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}

async function permsOf(userId: string) {
  const row = await env.DB.prepare("SELECT permissions FROM users WHERE id = ?")
    .bind(userId)
    .first<{ permissions: string | null }>()
  return parsePermissions(row?.permissions)
}

beforeEach(async () => {
  // 券/邀请码都是跨用例可查的表，清掉避免互相干扰
  await env.DB.prepare("DELETE FROM vouchers").run()
  await env.DB.prepare("DELETE FROM invite_codes").run()
})

describe("首捐奖励券", () => {
  it("第一次捐献成功发一张自选券，且一辈子只有一张", async () => {
    const user = await makeUser()
    await seedApprovedDonation(user.id)

    const code = await grantFirstDonationVoucher(env, user.id)
    expect(code).toMatch(/^VX-[A-Z2-9]{4}-[A-Z2-9]{4}$/)

    // 再调一次（例如撤销后重新批准）不能重复发
    expect(await grantFirstDonationVoucher(env, user.id)).toBeNull()
    const row = await env.DB.prepare(
      "SELECT feature, transferable, source, status FROM vouchers WHERE owner_user_id = ?"
    )
      .bind(user.id)
      .first<{ feature: string | null; transferable: number; source: string; status: string }>()
    expect(row?.feature).toBeNull() // 自选
    expect(row?.transferable).toBe(1) // 码可以送给别人
    expect(row?.source).toBe("first_donation")
    expect(row?.status).toBe("unused")

    const count = await env.DB.prepare(
      "SELECT COUNT(*) c FROM vouchers WHERE owner_user_id = ?"
    )
      .bind(user.id)
      .first<{ c: number }>()
    expect(count?.c).toBe(1)
  })

  it("已经有别的已通过捐献时不再发（不是首次）", async () => {
    const user = await makeUser()
    await seedApprovedDonation(user.id)
    await seedApprovedDonation(user.id)

    expect(await grantFirstDonationVoucher(env, user.id)).toBeNull()
  })

  it("捐献还没通过时不发", async () => {
    const user = await makeUser()
    await seedApprovedDonation(user.id, "pending")
    expect(await grantFirstDonationVoucher(env, user.id)).toBeNull()
  })
})

describe("GET /api/vouchers", () => {
  it("未登录 401", async () => {
    const res = await fetchSelf(new Request("https://cloud.doulor.cn/api/vouchers"))
    expect(res.status).toBe(401)
  })

  it("返回我持有的「码」与模块选项（带是否已拥有）", async () => {
    const user = await makeUser()
    await setPermissions(user.id, JSON.stringify({ r2: true, ai: false, frp: false, proxy: false }))
    await seedVoucher({ owner: user.id, feature: null })
    await seedVoucher({ owner: user.id, feature: "frp" })
    // 我创建的、还没用过的邀请码也应当出现在同一个列表里（码是同一种东西）
    const myInvite = await seedInvite({
      createdBy: user.id,
      permissions: { r2: false, ai: true, frp: false, proxy: false },
    })
    // 别人的券不该出现
    const other = await makeUser()
    await seedVoucher({ owner: other.id, feature: "ai" })
    await seedInvite({
      createdBy: other.id,
      permissions: { frp: true },
    })

    const res = await fetchSelf(authRequest(user, "/vouchers"))
    expect(res.status).toBe(200)
    const body = await res.json<{
      codes: { code: string; kind: string; selfSelect: boolean; features: string[] }[]
      features: { key: string; label: string; owned: boolean }[]
    }>()
    expect(body.codes).toHaveLength(3)
    expect(body.codes.filter((c) => c.selfSelect)).toHaveLength(1)
    expect(body.codes.filter((c) => c.kind === "invite")).toHaveLength(1)
    const inviteCode = body.codes.find((c) => c.kind === "invite")
    expect(inviteCode?.code).toBe(myInvite)
    expect(inviteCode?.features).toEqual(["ai"])
    expect(body.features.find((f) => f.key === "r2")?.owned).toBe(true)
    expect(body.features.find((f) => f.key === "frp")?.owned).toBe(false)
  })
})

describe("兑换自选券", () => {
  it("选一个未拥有的模块 → 开通成功", async () => {
    const user = await makeUser()
    await setPermissions(user.id, JSON.stringify({ r2: true, ai: false, frp: false, proxy: false }))
    const code = await seedVoucher({ owner: user.id, feature: null })

    const { res, body } = await redeem(user, code, "frp")
    expect(res.status).toBe(200)
    expect(body.granted).toEqual(["frp"])
    expect((await permsOf(user.id)).frp).toBe(true)
    // 只开这一个，别的不动
    expect((await permsOf(user.id)).ai).toBe(false)
  })

  it("不选模块 → 400 FEATURE_REQUIRED", async () => {
    const user = await makeUser()
    await setPermissions(user.id, JSON.stringify({ r2: true, ai: false, frp: false, proxy: false }))
    const code = await seedVoucher({ owner: user.id, feature: null })
    const { res, body } = await redeem(user, code)
    expect(res.status).toBe(400)
    expect(body.code).toBe("FEATURE_REQUIRED")
  })

  it("选一个已经拥有的模块 → 400，且券还在", async () => {
    const user = await makeUser()
    await setPermissions(user.id, JSON.stringify({ r2: true, ai: false, frp: false, proxy: false }))
    const code = await seedVoucher({ owner: user.id, feature: null })

    const { res, body } = await redeem(user, code, "r2")
    expect(res.status).toBe(400)
    expect(body.code).toBe("ALREADY_OWNED")

    const still = await env.DB.prepare("SELECT status FROM vouchers WHERE code = ?")
      .bind(code)
      .first<{ status: string }>()
    expect(still?.status).toBe("unused")
  })

  it("一张券只能用一次", async () => {
    const user = await makeUser()
    await setPermissions(user.id, JSON.stringify({ r2: true, ai: false, frp: false, proxy: false }))
    const code = await seedVoucher({ owner: user.id, feature: null })

    expect((await redeem(user, code, "frp")).res.status).toBe(200)
    const again = await redeem(user, code, "ai")
    expect(again.res.status).toBe(409)
    expect(again.body.code).toBe("ALREADY_USED")
  })

  it("不是发给我的券不能替我用（transferable=0）", async () => {
    const me = await makeUser()
    const other = await makeUser()
    await setPermissions(me.id, JSON.stringify({ r2: true, ai: false, frp: false, proxy: false }))
    const code = await seedVoucher({ owner: other.id, feature: "frp" })

    const { res, body } = await redeem(me, code)
    expect(res.status).toBe(403)
    expect(body.code).toBe("NOT_YOUR_VOUCHER")
  })

  it("可转送的券别人能用", async () => {
    const me = await makeUser()
    const other = await makeUser()
    await setPermissions(me.id, JSON.stringify({ r2: true, ai: false, frp: false, proxy: false }))
    const code = await seedVoucher({ owner: other.id, feature: "frp", transferable: true })

    const { res } = await redeem(me, code)
    expect(res.status).toBe(200)
    expect((await permsOf(me.id)).frp).toBe(true)
  })
})

describe("用邀请码补权限", () => {
  it("别人给的、带模块权限的邀请码 → 补齐我缺的那些", async () => {
    const owner = await makeUser()
    const me = await makeUser()
    await setPermissions(me.id, JSON.stringify({ r2: true, ai: true, frp: false, proxy: false }))
    const code = await seedInvite({
      createdBy: owner.id,
      permissions: { r2: true, ai: true, frp: true, proxy: false },
    })

    const { res, body } = await redeem(me, code)
    expect(res.status).toBe(200)
    expect(body.granted).toEqual(["frp"]) // r2/ai 已有 → 跳过
    const after = await permsOf(me.id)
    expect(after.frp).toBe(true)
    expect(after.proxy).toBe(false)
  })

  it("用完会消耗该邀请码一次使用次数", async () => {
    const owner = await makeUser()
    const me = await makeUser()
    await setPermissions(me.id, JSON.stringify({ r2: true, ai: true, frp: false, proxy: false }))
    const code = await seedInvite({
      createdBy: owner.id,
      permissions: { frp: true },
      maxUses: 1,
    })

    await redeem(me, code)
    const row = await env.DB.prepare("SELECT used_count FROM invite_codes WHERE code = ?")
      .bind(code)
      .first<{ used_count: number }>()
    expect(row?.used_count).toBe(1)

    // 已被用满 → 再兑就找不到了
    const other = await makeUser()
    await setPermissions(other.id, JSON.stringify({ frp: false }))
    const second = await redeem(other, code)
    expect(second.res.status).toBe(404)
  })

  it("自己创建的邀请码也能给自己用（码是同一种东西）", async () => {
    const me = await makeUser()
    await setPermissions(me.id, JSON.stringify({ r2: true, ai: true, frp: false, proxy: false }))
    const code = await seedInvite({ createdBy: me.id, permissions: { frp: true } })

    const { res, body } = await redeem(me, code)
    expect(res.status).toBe(200)
    expect(body.granted).toEqual(["frp"])
    expect((await permsOf(me.id)).frp).toBe(true)

    // 自用后该码被消耗，删除时不会退还额度（used_count > 0）⇒ 不存在额度循环
    const row = await env.DB.prepare("SELECT used_count FROM invite_codes WHERE code = ?")
      .bind(code)
      .first<{ used_count: number }>()
    expect(row?.used_count).toBe(1)
  })

  it("码里的权限我都已拥有 → 400 且不消耗次数", async () => {
    const owner = await makeUser()
    const me = await makeUser()
    await setPermissions(me.id, JSON.stringify({ r2: true, ai: true, frp: true, proxy: false }))
    // 码里所有键都显式写出（真实创建路径就是这么写的）
    const code = await seedInvite({
      createdBy: owner.id,
      permissions: { r2: false, ai: false, frp: true, proxy: false },
    })

    const { res, body } = await redeem(me, code)
    expect(res.status).toBe(400)
    expect(body.code).toBe("ALREADY_OWNED")
    const row = await env.DB.prepare("SELECT used_count FROM invite_codes WHERE code = ?")
      .bind(code)
      .first<{ used_count: number }>()
    expect(row?.used_count).toBe(0)
  })

  it("只按码里**显式写着 true** 的键授权，缺的键不算（不能膨胀成全部权限）", async () => {
    const owner = await makeUser()
    const me = await makeUser()
    await setPermissions(me.id, JSON.stringify({ r2: true, ai: false, frp: false, proxy: false }))
    // 只写 frp：不能用 parsePermissions 那套「缺失 = 允许」的兜底，
    // 否则这张码会变成「四个模块全给」
    const code = await seedInvite({ createdBy: owner.id, permissions: { frp: true } })

    const { res, body } = await redeem(me, code)
    expect(res.status).toBe(200)
    expect(body.granted).toEqual(["frp"])
    const after = await permsOf(me.id)
    expect(after.frp).toBe(true)
    expect(after.ai).toBe(false)
    expect(after.proxy).toBe(false)
  })

  it("不存在的码 → 404", async () => {
    const me = await makeUser()
    const { res, body } = await redeem(me, "VX-NOPE-NOPE")
    expect(res.status).toBe(404)
    expect(body.code).toBe("INVALID_CODE")
  })
})

describe("兑换接口的鉴权", () => {
  it("未登录 401", async () => {
    const res = await fetchSelf(
      new Request("https://cloud.doulor.cn/api/vouchers/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "X" }),
      })
    )
    expect(res.status).toBe(401)
  })

  it("兑换码大小写不敏感", async () => {
    const user = await makeUser()
    await setPermissions(user.id, JSON.stringify({ r2: true, ai: false, frp: false, proxy: false }))
    const code = await seedVoucher({ owner: user.id, feature: "ai" })
    const { res } = await redeem(user, code.toLowerCase())
    expect(res.status).toBe(200)
  })
})
