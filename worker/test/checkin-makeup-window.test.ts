// 补签窗口：只能补「最近 7 天」内漏掉的签到（2026-11-04 站长要求）
//
// 背景：补签原本只挡「今天与未来」，往前**不设下界** —— 断签很久的账号可以攒一堆
// 卡把过去几个月全补上，连续天数与里程碑奖励等于变成「可以补票」的东西
// （一张卡 50~100 积分，补到 30 天里程碑就回本还有赚）。
//
// 本文件钉住：
//   1. 窗口内（含第 7 天）可以补；
//   2. 第 8 天及更早一律 400 MAKEUP_OUT_OF_WINDOW，**不扣卡、不写签到记录**；
//   3. 今天 / 未来仍然是 INVALID_MAKEUP_DATE（老口径不变）；
//   4. 状态接口与日历接口都会下发 makeupWindowDays，前端不写死这个数字。
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, type TestUser } from "./helpers"

function siteToday(offsetHours = 8): string {
  return new Date(Date.now() + offsetHours * 3600 * 1000).toISOString().slice(0, 10)
}

function daysBefore(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

async function setCards(userId: string, n: number): Promise<void> {
  await env.DB.prepare("UPDATE users SET checkin_makeup_cards = ? WHERE id = ?")
    .bind(n, userId)
    .run()
}

async function cardsOf(userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT checkin_makeup_cards AS c FROM users WHERE id = ?")
    .bind(userId)
    .first<{ c: number }>()
  return Number(row?.c ?? 0)
}

async function makeupRows(userId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM daily_checkins WHERE user_id = ? AND is_makeup = 1"
  )
    .bind(userId)
    .first<{ c: number }>()
  return Number(row?.c ?? 0)
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

describe("补签窗口：最近 7 天", () => {
  it("第 7 天（窗口边界）可以补", async () => {
    const u = await makeUser()
    await setCards(u.id, 1)
    const today = siteToday()

    const res = await makeup(u, daysBefore(today, 7))
    expect(res.status).toBe(200)
    expect(await cardsOf(u.id)).toBe(0)
    expect(await makeupRows(u.id)).toBe(1)
  })

  it("第 8 天被拒：不扣卡、不写记录", async () => {
    const u = await makeUser()
    await setCards(u.id, 2)
    const today = siteToday()

    const res = await makeup(u, daysBefore(today, 8))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe("MAKEUP_OUT_OF_WINDOW")

    // 关键：被拒的请求不能有任何副作用
    expect(await cardsOf(u.id)).toBe(2)
    expect(await makeupRows(u.id)).toBe(0)
  })

  it("很老的日期同样被拒（防止「补票」里程碑）", async () => {
    const u = await makeUser()
    await setCards(u.id, 3)
    const today = siteToday()

    for (const n of [30, 90, 180]) {
      const res = await makeup(u, daysBefore(today, n))
      expect(res.status).toBe(400)
      expect(((await res.json()) as { code: string }).code).toBe("MAKEUP_OUT_OF_WINDOW")
    }
    expect(await cardsOf(u.id)).toBe(3)
    expect(await makeupRows(u.id)).toBe(0)
  })

  it("今天 / 未来仍然是「只能补签过去的日期」", async () => {
    const u = await makeUser()
    await setCards(u.id, 2)
    const today = siteToday()

    for (const date of [today, daysBefore(today, -1)]) {
      const res = await makeup(u, date)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { code: string }).code).toBe("INVALID_MAKEUP_DATE")
    }
    expect(await cardsOf(u.id)).toBe(2)
  })

  it("状态与日历接口都下发 makeupWindowDays（前端不写死 7）", async () => {
    const u = await makeUser()
    await setCards(u.id, 1)

    const status = await fetchSelf(authRequest(u, "/api/checkin"))
    expect(status.status).toBe(200)
    expect(((await status.json()) as { makeupWindowDays: number }).makeupWindowDays).toBe(7)

    const today = siteToday()
    const history = await fetchSelf(
      authRequest(u, `/api/checkin/history?month=${today.slice(0, 7)}`)
    )
    expect(history.status).toBe(200)
    expect(((await history.json()) as { makeupWindowDays: number }).makeupWindowDays).toBe(7)
  })
})
