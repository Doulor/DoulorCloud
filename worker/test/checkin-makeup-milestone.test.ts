// 连续签到里程碑 × 补签卡（2026-11-03 用户反馈修复）
//
// 用户原话（工单 a897c635 / 766e3268）：
//   「连续签到29天，第30天断签，买了补签卡，使用后 30 天连续签到 积分奖励
//     标记发了，但是没有积分入账」
//   「补签达成里程碑 不给里程碑奖励」
//
// 根因：补签只把 daily_checkins 的连续天数改写上去（points/base/bonus 全写 0），
// 从来不判里程碑；而正常签到只发「**恰好等于**当前连续天数」那一条
// （见 checkin-config.ts 的 milestoneBonusFor）。补签把天数从 29 直接推到 30
// 之后，第 30 天那条里程碑再也不会被「恰好命中」—— 前端却又按
// `streak >= days` 把 chip 点亮，用户看到「发了」、账户里却没有。
//
// 修复：补签（以及它触发的后续链重算）跨过哪些里程碑，就补发哪些。
// 本文件钉住：
//   1. 跨过里程碑 → 补发对应积分，并记账到那一天；
//   2. 不跨里程碑 → 一分不发（补签本身不发日常签到分）；
//   3. 同一张单重复提交 → 幂等，不重复发；
//   4. 一次补两格、跨过多个里程碑 → 一条都不漏。
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { getPointsBalance } from "../src/points"
import { makeUser, authRequest, fetchSelf, setSetting, type TestUser } from "./helpers"

/** 站点时区（默认 UTC+8）的今天 */
function siteToday(offsetHours = 8): string {
  return new Date(Date.now() + offsetHours * 3600 * 1000).toISOString().slice(0, 10)
}

function daysBefore(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

/** 造一段连续签到：endDate 是这一段最后一天，从 endDate 往前数 days 天 */
async function seedStreak(userId: string, endDate: string, days: number): Promise<void> {
  for (let i = 0; i < days; i++) {
    const date = daysBefore(endDate, days - 1 - i)
    await env.DB.prepare(
      `INSERT INTO daily_checkins (user_id, checkin_date, points, base_points, bonus_points, streak, created_at)
       VALUES (?, ?, 10, 10, 0, ?, ?)`
    )
      .bind(userId, date, i + 1, new Date().toISOString())
      .run()
  }
}

async function setCards(userId: string, n: number): Promise<void> {
  await env.DB.prepare("UPDATE users SET checkin_makeup_cards = ? WHERE id = ?")
    .bind(n, userId)
    .run()
}

function makeup(user: TestUser, date: string): Promise<Response> {
  return fetchSelf(
    authRequest(user, "/api/checkin/makeup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date }),
    })
  )
}

/** 某一天的签到行（看补发的积分有没有记账到那一天） */
async function dayRow(userId: string, date: string) {
  return env.DB.prepare(
    "SELECT points, base_points, bonus_points, streak, is_makeup FROM daily_checkins WHERE user_id = ? AND checkin_date = ?"
  )
    .bind(userId, date)
    .first<{ points: number; base_points: number; bonus_points: number; streak: number; is_makeup: number }>()
}

describe("补签 × 连续签到里程碑", () => {
  it("补回第 30 天 → 补发里程碑 220 分（核心回归）", async () => {
    await setSetting("checkin_milestones", "2:10\n3:10\n7:50\n14:120\n30:220\n90:999\n365:1999")
    const u = await makeUser()
    await setCards(u.id, 1)

    const today = siteToday()
    // 连续 29 天，最后一天是「前天」→ 昨天漏签
    await seedStreak(u.id, daysBefore(today, 2), 29)

    const res = await makeup(u, daysBefore(today, 1))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      streak: number
      grantedPoints: number
      milestonesGranted: { days: number; points: number }[]
    }
    expect(body.streak).toBe(30)
    expect(body.grantedPoints).toBe(220)
    expect(body.milestonesGranted).toEqual([{ days: 30, points: 220 }])

    // 钱真的进账了（修复前这里是 0）
    expect(await getPointsBalance(env, u.id)).toBe(220)
    // 并且记账到补签那一天，日历里看得见
    const row = await dayRow(u.id, daysBefore(today, 1))
    expect(row?.is_makeup).toBe(1)
    expect(row?.streak).toBe(30)
    expect(row?.bonus_points).toBe(220)
    expect(row?.points).toBe(220)
  })

  it("不跨里程碑的补签：不发任何积分（补签本身不发日常分）", async () => {
    await setSetting("checkin_milestones", "2:10\n3:10\n7:50\n14:120\n30:220")
    const u = await makeUser()
    await setCards(u.id, 1)

    const today = siteToday()
    await seedStreak(u.id, daysBefore(today, 2), 5) // 连续 5 天

    const res = await makeup(u, daysBefore(today, 1))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { grantedPoints: number; milestonesGranted: unknown[] }
    expect(body.grantedPoints).toBe(0)
    expect(body.milestonesGranted).toEqual([])
    expect(await getPointsBalance(env, u.id)).toBe(0)
  })

  it("同一天重复提交：幂等，只发一次", async () => {
    await setSetting("checkin_milestones", "30:220")
    const u = await makeUser()
    await setCards(u.id, 2)

    const today = siteToday()
    await seedStreak(u.id, daysBefore(today, 2), 29)

    const first = await makeup(u, daysBefore(today, 1))
    expect(first.status).toBe(200)

    // 第二次补同一天：入口就按「该日已签」挡掉 → 409，且不能再发奖
    const second = await makeup(u, daysBefore(today, 1))
    expect(second.status).toBe(409)
    expect(await getPointsBalance(env, u.id)).toBe(220)
  })

  it("一次补两格、跨过多个里程碑 → 逐条补发，一条不漏", async () => {
    await setSetting("checkin_milestones", "2:10\n3:10\n7:50\n14:120\n30:220")
    const u = await makeUser()
    await setCards(u.id, 2)

    const today = siteToday()
    // 连续 13 天（到 3 天前）→ 补 2 天前 = 第 14 天（120），再补 1 天前 = 第 15 天（无）
    await seedStreak(u.id, daysBefore(today, 3), 13)

    const a = await makeup(u, daysBefore(today, 2))
    expect(a.status).toBe(200)
    const aBody = (await a.json()) as { grantedPoints: number; milestonesGranted: { days: number }[] }
    expect(aBody.milestonesGranted).toEqual([{ days: 14, points: 120 }])
    expect(await getPointsBalance(env, u.id)).toBe(120)

    const b = await makeup(u, daysBefore(today, 1))
    expect(b.status).toBe(200)
    const bBody = (await b.json()) as { grantedPoints: number }
    expect(bBody.grantedPoints).toBe(0) // 第 15 天没有里程碑
    expect(await getPointsBalance(env, u.id)).toBe(120)
  })
})
