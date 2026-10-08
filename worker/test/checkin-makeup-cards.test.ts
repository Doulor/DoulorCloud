/**
 * 回归测试：补签卡扣减的并发安全（`POST /api/checkin/makeup`）。
 *
 * 原貌（「先读后判」）：
 *   `makeupCheckin` 先 `SELECT checkin_makeup_cards` 读出余额，在 JS 里判
 *   `if (cards < 1) throw`，之后再无条件 `UPDATE ... SET cards = cards - 1`。
 *   判余额与扣卡是两次独立往返，中间没有原子性 —— 两个并发请求只要补的是
 *   **不同日期**，就都会读到同一份「还有卡」的余额、各扣一次，余额被扣成负数。
 *
 *   当时代码里的注释认为「并发重复补签会被 PK 拦住、不会多扣卡」，但
 *   `daily_checkins` 的主键是 (user_id, checkin_date)，只能拦住**同一日期**；
 *   不同日期各插一行，谁都拦不住。一张卡因此能补两天，白拿连续天数
 *   （而连续天数直接触发里程碑奖励：默认 7 天 +50 / 30 天 +300 / 100 天 +1000 积分）。
 *
 * 修复：`UPDATE ... WHERE id = ? AND checkin_makeup_cards >= 1 RETURNING ...`
 * 一次往返完成「判余额 + 扣卡」，并以扣减结果为准（扣不到 = 没卡）；
 * 记录写失败时把卡退回，避免「扣了卡但没补上签」。
 *
 * 与既有测试的关系：`checkin-config.test.ts` 只覆盖里程碑解析（纯函数），
 * 补签接口此前没有任何用例。
 */
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeupCheckin } from "../src/handlers/checkin"
import { ApiError } from "../src/http"
import { makeUser, authRequest, fetchSelf, type TestUser } from "./helpers"

/** 站点时区（默认 UTC+8）的今天 */
function siteToday(offsetHours = 8): string {
  return new Date(Date.now() + offsetHours * 3600 * 1000).toISOString().slice(0, 10)
}

/** 某个日期串往前 n 天 */
function daysBefore(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

/** 直接设定补签卡余额 */
async function setCards(userId: string, n: number): Promise<void> {
  await env.DB.prepare("UPDATE users SET checkin_makeup_cards = ? WHERE id = ?")
    .bind(n, userId)
    .run()
}

/** 读当前补签卡余额 */
async function cardsOf(userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT checkin_makeup_cards AS c FROM users WHERE id = ?")
    .bind(userId)
    .first<{ c: number }>()
  return Number(row?.c ?? 0)
}

/** 该用户已补签的日期集合 */
async function makeupDates(userId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT checkin_date FROM daily_checkins WHERE user_id = ? AND is_makeup = 1 ORDER BY checkin_date"
  )
    .bind(userId)
    .all<{ checkin_date: string }>()
  return (rows.results ?? []).map((r) => r.checkin_date)
}

/** 发一次补签请求 */
function makeup(user: TestUser, date: string): Promise<Response> {
  return fetchSelf(
    authRequest(user, "/api/checkin/makeup", {
      method: "POST",
      body: JSON.stringify({ date }),
      headers: { "Content-Type": "application/json" },
    })
  )
}

describe("POST /api/checkin/makeup —— 补签卡扣减的并发安全", () => {
  it("并发 6 次、只有 2 张卡：成功数恰好 2，余额归零不为负", async () => {
    const u = await makeUser()
    await setCards(u.id, 2)

    const today = siteToday()
    const dates = [1, 2, 3, 4, 5, 6].map((n) => daysBefore(today, n))

    // 这是本文件的核心回归用例：并发度高于卡数时，旧逻辑（先 SELECT 判余额、
    // 再无条件 UPDATE 扣减）会让所有请求都读到同一份「还有卡」的余额并各扣一次。
    // 实测在旧代码上稳定复现：`expected 6 to be 2`，余额被扣成负数。
    const results = await Promise.all(dates.map((d) => makeup(u, d)))
    const okCount = results.filter((r) => r.status === 200).length

    expect(okCount).toBe(2)
    expect(await cardsOf(u.id)).toBe(0)
    expect(await makeupDates(u.id)).toHaveLength(2)
  })

  it("只剩 1 张卡时并发补多个不同日期：成功数不超过 1，余额不能为负", async () => {
    const u = await makeUser()
    await setCards(u.id, 1)

    const today = siteToday()
    // 关键：这些请求补的是**不同日期**，所以 PK 兜底拦不住它们。
    // 旧逻辑下它们都会读到同一份 cards=1、都判定「有卡」、各扣一次
    // → 余额变负、多个日期都被补上。
    const dates = [1, 2, 3, 4].map((n) => daysBefore(today, n))

    const results = await Promise.all(dates.map((d) => makeup(u, d)))
    const statuses = results.map((r) => r.status)
    const okCount = statuses.filter((s) => s === 200).length

    expect(okCount).toBe(1)

    // 核心不变式：**扣掉的卡数必须等于成功的补签数**，且余额永不为负。
    // 这条断言不依赖具体调度顺序 —— 只要发生了并发交错，旧逻辑就会因
    // 「余额为负 / 补签数多于卡数」而失败。
    const left = await cardsOf(u.id)
    expect(left).toBeGreaterThanOrEqual(0)
    expect(left).toBe(1 - okCount)
    expect(await makeupDates(u.id)).toHaveLength(okCount)

    // 失败者必须拿到明确的「没有可用的补签卡」，而不是 500。
    for (const r of results.filter((x) => x.status !== 200)) {
      expect(r.status).toBe(409)
      const body = await r.json<{ code?: string }>()
      expect(body.code).toBe("NO_MAKEUP_CARDS")
    }
  })

  it("0 张卡：补签被拒且不写任何记录", async () => {
    const u = await makeUser()
    await setCards(u.id, 0)

    const res = await makeup(u, daysBefore(siteToday(), 1))
    expect(res.status).toBe(409)
    const body = await res.json<{ code?: string }>()
    expect(body.code).toBe("NO_MAKEUP_CARDS")

    expect(await cardsOf(u.id)).toBe(0)
    expect(await makeupDates(u.id)).toHaveLength(0)
  })

  it("同一日期并发补签：PK 拦住重复，且被拦下的那些要把卡退回", async () => {
    const u = await makeUser()
    const N = 6
    await setCards(u.id, N)

    const date = daysBefore(siteToday(), 1)
    // 并发打同一天：多个请求会同时通过「该日已签？」的前置查询，
    // 各自先扣一张卡，然后抢着 INSERT —— 只有一个能成，其余撞 PK。
    // 撞 PK 的那些必须把卡退回来，否则「同一天重复点」会白吃卡。
    const results = await Promise.all(Array.from({ length: N }, () => makeup(u, date)))
    const okCount = results.filter((r) => r.status === 200).length

    // 同一天只能补一次
    expect(okCount).toBe(1)
    expect(await makeupDates(u.id)).toHaveLength(1)

    // 核心不变式：最终余额 = 初始卡数 - 成功次数。
    // 少退回一张卡，这里就会少 1（实测把退回改成 no-op 会稳定失败）。
    expect(await cardsOf(u.id)).toBe(N - okCount)
  })

  it("写记录失败时必须把已扣的卡退回（否则「扣了卡但没补上签」）", async () => {
    const u = await makeUser()
    await setCards(u.id, 3)

    // miniflare 里 D1 会把语句串行化，很难稳定复现「前置查询通过之后、
    // INSERT 之前另一个请求插进来」这个窗口，所以这里直接注入一个失败的 INSERT，
    // 确定性地走一遍退回分支（等价于真实并发下撞 PK 的那次）。
    const realDb = env.DB
    const proxyDb = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("INSERT INTO daily_checkins")) {
              return {
                bind: () => ({
                  run: async () => {
                    throw new Error(
                      "UNIQUE constraint failed: daily_checkins.user_id, daily_checkins.checkin_date"
                    )
                  },
                }),
              }
            }
            return target.prepare(sql)
          }
        }
        const value = Reflect.get(target, prop, receiver)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    const patchedEnv = Object.create(env) as typeof env
    patchedEnv.DB = proxyDb as unknown as typeof env.DB

    const date = daysBefore(siteToday(), 1)
    // 直接调 handler（不走 SELF.fetch）：ApiError 会以异常形式抛出，
    // 便于断言错误码，也避免被上层的错误处理包装成 Response。
    let caught: unknown
    try {
      await makeupCheckin(
        patchedEnv,
        authRequest(u, "/api/checkin/makeup", {
          method: "POST",
          body: JSON.stringify({ date }),
          headers: { "Content-Type": "application/json" },
        })
      )
    } catch (err) {
      caught = err
    }

    // 撞 PK 应报「该日期已经签过到了」，而不是把原始错误漏出去变成 500
    expect(caught).toBeInstanceOf(ApiError)
    expect((caught as ApiError).status).toBe(409)
    expect((caught as ApiError).code).toBe("ALREADY_CHECKED_IN")

    // 关键：卡必须原样退回来（3 张还是 3 张），不能被白吃一张
    expect(await cardsOf(u.id)).toBe(3)
    expect(await makeupDates(u.id)).toHaveLength(0)
  })

  it("正常路径不回归：有卡时顺序补签可连补多天，余额按次递减", async () => {
    const u = await makeUser()
    await setCards(u.id, 2)

    const today = siteToday()
    const d1 = daysBefore(today, 1)
    const d2 = daysBefore(today, 2)

    // 按时间先后补：先补更早的那天，再补靠后的 —— 这样连续天数才会接成链。
    const r2 = await makeup(u, d2)
    expect(r2.status).toBe(200)
    const b2 = await r2.json<{ streak: number; makeupCards: number }>()
    // 响应里的余额应是**扣减后**的真实值，而不是「读到的旧值 - 1」
    expect(b2.makeupCards).toBe(1)
    // d2 之前没有记录，所以它自己开启一条新链
    expect(b2.streak).toBe(1)
    expect(await cardsOf(u.id)).toBe(1)

    const r1 = await makeup(u, d1)
    expect(r1.status).toBe(200)
    const b1 = await r1.json<{ streak: number; makeupCards: number }>()
    expect(b1.makeupCards).toBe(0)
    // d1 的前一天（d2）已补上，连续天数接上
    expect(b1.streak).toBe(2)
    expect(await cardsOf(u.id)).toBe(0)

    // 库里两天都在，且链上的 streak 正确
    expect(await makeupDates(u.id)).toEqual([d2, d1])
    const rows = await env.DB.prepare(
      "SELECT checkin_date, streak FROM daily_checkins WHERE user_id = ? AND is_makeup = 1 ORDER BY checkin_date"
    )
      .bind(u.id)
      .all<{ checkin_date: string; streak: number }>()
    expect((rows.results ?? []).map((r) => [r.checkin_date, r.streak])).toEqual([
      [d2, 1],
      [d1, 2],
    ])
  })

  it("今天与未来的日期不能补（原有校验不回归）", async () => {
    const u = await makeUser()
    await setCards(u.id, 3)

    const today = siteToday()
    for (const bad of [today, daysBefore(today, -1)]) {
      const res = await makeup(u, bad)
      expect(res.status).toBe(400)
      const body = await res.json<{ code?: string }>()
      expect(body.code).toBe("INVALID_MAKEUP_DATE")
    }

    // 被拒的请求不能消耗卡
    expect(await cardsOf(u.id)).toBe(3)
  })
})
