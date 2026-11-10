// 捐献额度发放：用户级原子占位（2026-11-07 抽出后供反代通道复用）
//
// 背景：经典捐献（handlers/donations.ts）原本内联了「同一类型只发一次」的占位逻辑；
// 2026-11-07 站长要求「反代账号捐献也要发 +2 邀请码额度」，两条通道必须共用
// 同一份实现，于是抽成 quotas.claimDonationQuota。抽出来之后，这条防刷闸门的
// 正确性就变成**两个**通道共同依赖的东西，必须单独钉住：
//
//   1. 首次发放：+2 邀请码额度，并写下占位标记；
//   2. 同类型第二次：一分不发（这就是「无限邀请权」漏洞的闸门）；
//   3. 不同类型：各发一次（ai / proxy 是两档）；
//   4. feature=null（frp）：**只占位、不发额度**，且同样只占一次；
//   5. 并发：同一用户同一类型同时打 5 次，只发一次。
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser } from "./helpers"
import { claimDonationQuota } from "../src/quotas"

const INVITE_BONUS = 2

/** 读用户的邀请码额度加成与占位 JSON */
async function state(userId: string) {
  const row = await env.DB.prepare(
    "SELECT invite_quota_bonus AS bonus, donation_quota_types AS types FROM users WHERE id = ?"
  )
    .bind(userId)
    .first<{ bonus: number | null; types: string | null }>()
  let types: Record<string, unknown> = {}
  try {
    types = row?.types ? JSON.parse(row.types) : {}
  } catch {
    types = {}
  }
  return { bonus: Number(row?.bonus ?? 0), types }
}

describe("捐献额度：用户级原子占位", () => {
  it("首次发放 +2 并写下占位", async () => {
    const u = await makeUser()
    const granted = await claimDonationQuota(env, u.id, "ai", "ai")
    expect(granted).toBe(true)

    const s = await state(u.id)
    expect(s.bonus).toBe(INVITE_BONUS)
    expect(s.types.ai).toBe(1)
  })

  it("同类型第二次不再发放（防「无限邀请权」）", async () => {
    const u = await makeUser()
    expect(await claimDonationQuota(env, u.id, "ai", "ai")).toBe(true)
    expect(await claimDonationQuota(env, u.id, "ai", "ai")).toBe(false)

    expect((await state(u.id)).bonus).toBe(INVITE_BONUS)
  })

  it("不同类型各发一次（ai 与 proxy 是两档）", async () => {
    const u = await makeUser()
    expect(await claimDonationQuota(env, u.id, "ai", "ai")).toBe(true)
    expect(await claimDonationQuota(env, u.id, "proxy", "proxy")).toBe(true)

    const s = await state(u.id)
    expect(s.bonus).toBe(INVITE_BONUS * 2)
    expect(s.types.ai).toBe(1)
    expect(s.types.proxy).toBe(1)
  })

  it("feature=null（frp）：只占位、不发额度，且只占一次", async () => {
    const u = await makeUser()
    expect(await claimDonationQuota(env, u.id, "frp", null)).toBe(false)
    expect(await claimDonationQuota(env, u.id, "frp", null)).toBe(false)

    const s = await state(u.id)
    expect(s.bonus).toBe(0) // 没发额度
    expect(s.types.frp).toBe(1) // 但已占位，不会反复尝试
  })

  it("并发 5 次同类型：只发一次", async () => {
    const u = await makeUser()
    const results = await Promise.all(
      Array.from({ length: 5 }, () => claimDonationQuota(env, u.id, "ai", "ai"))
    )
    expect(results.filter(Boolean)).toHaveLength(1)
    expect((await state(u.id)).bonus).toBe(INVITE_BONUS)
  })
})
