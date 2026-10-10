/**
 * 回归测试：自动签到所依赖的签到接口契约（`GET /api/checkin` 的 `today` 字段等）。
 *
 * 背景（2026-10-10）：线上「自动签到」开了却不生效。根因在前端守卫 ——
 * 旧实现用 `sessionStorage["auto-checkin-ran"] = "1"`（一个不含日期的布尔标记）
 * 表示「这次会话跑过了」，而 sessionStorage 会随标签页 / PWA / App 内 WebView
 * 的存活期一直留着：
 *   - 页面（或 App）开着过夜 → 标记还在，第二天永远不会再自动签；
 *   - 开关是本次会话中途才打开的 → 标记早已置上，本次会话不再生效。
 *
 * 修复把守卫改成按**站点日期**判定，但前端算不出站点时区，必须由服务端给出
 * 权威的「今天」。本文件锁住这个契约：`GET /api/checkin` 必须返回 `today`
 * （站点时区 YYYY-MM-DD），且它不随「是否签到」变化 —— 前端靠它判断同一站点日
 * 是否已经处理过。配套的前端判定内核用例见 scripts/check-auto-checkin.mjs。
 */
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, setSetting, type TestUser } from "./helpers"

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

function status(user: TestUser): Promise<Response> {
  return fetchSelf(authRequest(user, "/api/checkin"))
}

function setAuto(user: TestUser, enabled: boolean): Promise<Response> {
  return fetchSelf(
    authRequest(user, "/api/checkin/auto", {
      method: "POST",
      body: JSON.stringify({ enabled }),
      headers: { "Content-Type": "application/json" },
    })
  )
}

function checkin(user: TestUser): Promise<Response> {
  return fetchSelf(authRequest(user, "/api/checkin", { method: "POST" }))
}

interface StatusBody {
  enabled: boolean
  today: string
  checkedIn: boolean
  autoCheckin: boolean
  streak: number
  todayPoints: number
}

describe("GET /api/checkin —— 自动签到依赖的状态契约", () => {
  it("返回站点时区的 today（YYYY-MM-DD），自动签到开关随之变化", async () => {
    const u = await makeUser()

    const s1 = await status(u)
    expect(s1.status).toBe(200)
    const b1 = await s1.json<StatusBody>()
    expect(b1.enabled).toBe(true)
    expect(b1.today).toBe(siteToday())
    expect(b1.today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(b1.checkedIn).toBe(false)
    expect(b1.autoCheckin).toBe(false)

    // 打开自动签到后，状态接口应如实回显（前端据此决定要不要自动签）
    const set = await setAuto(u, true)
    expect(set.status).toBe(200)
    const b2 = await (await status(u)).json<StatusBody>()
    expect(b2.autoCheckin).toBe(true)
    // today 不因开关或签到而变：它是「当前站点日」，前端按天判定就靠它
    expect(b2.today).toBe(b1.today)
  })

  it("签到后 today 不变、checkedIn 变 true；重复签返回 409（前端据此记为已完成）", async () => {
    const u = await makeUser()
    await setAuto(u, true)

    const before = await (await status(u)).json<StatusBody>()
    expect(before.checkedIn).toBe(false)

    const first = await checkin(u)
    expect(first.status).toBe(200)
    const awarded = await first.json<{ total: number }>()
    expect(awarded.total).toBeGreaterThan(0)

    const after = await (await status(u)).json<StatusBody>()
    expect(after.checkedIn).toBe(true)
    expect(after.today).toBe(before.today) // 同一个站点日内 today 不变
    expect(after.todayPoints).toBe(awarded.total)

    // 前端把 409 ALREADY_CHECKED_IN 当作「今天已完成」，不再重试、不弹错
    const second = await checkin(u)
    expect(second.status).toBe(409)
    expect((await second.json<{ code?: string }>()).code).toBe("ALREADY_CHECKED_IN")
  })

  it("跨天：昨天签过、今天再签，today 前进且连续天数接上", async () => {
    const u = await makeUser()
    const today = siteToday()
    const yesterday = daysBefore(today, 1)

    // 直接落一条昨天的签到记录（模拟昨天签过）
    await env.DB.prepare(
      `INSERT INTO daily_checkins (user_id, checkin_date, points, base_points, bonus_points, streak, created_at)
       VALUES (?, ?, 10, 10, 0, 1, ?)`
    )
      .bind(u.id, yesterday, new Date().toISOString())
      .run()

    const s = await (await status(u)).json<StatusBody>()
    // 关键：今天的 today 必须已经不同于昨天 —— 前端的「按天」守卫正是靠它翻页
    expect(s.today).toBe(today)
    expect(s.today).not.toBe(yesterday)
    expect(s.checkedIn).toBe(false)

    const res = await checkin(u)
    expect(res.status).toBe(200)
    expect((await res.json<{ streak: number }>()).streak).toBe(2)
  })

  it("功能总开关关闭时仍返回 today（前端不必等到开启才知道今天几号）", async () => {
    await setSetting("checkin_enabled", "0")
    try {
      const u = await makeUser()
      const res = await status(u)
      expect(res.status).toBe(200)
      const body = await res.json<StatusBody>()
      expect(body.enabled).toBe(false)
      expect(body.autoCheckin).toBe(false)
      expect(body.today).toBe(siteToday())
    } finally {
      await setSetting("checkin_enabled", "1")
    }
  })
})
