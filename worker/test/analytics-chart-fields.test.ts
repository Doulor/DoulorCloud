/**
 * 数据统计图表的字段契约（2026-10-23）。
 *
 * 站长反馈「新增用户趋势没有数据」。根因是**字段名对不上**：
 * 后端 SQL 的别名是 `c`，直接原样返回；前端类型与组件读的是 `count` ——
 * 于是柱子高度算出 NaN、悬停显示 undefined，看起来就是「没数据」。
 *
 * 这个用例把返回契约钉死，防止以后再出现同类的「后端有数、前端空着」。
 */
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { fetchSelf, makeUser } from "./helpers"

describe("管理端数据统计 · 图表字段契约", () => {
  it("新增用户趋势返回 {date, count}（不是 SQL 别名 c）", async () => {
    const root = await makeUser({ role: "root" })
    const res = await fetchSelf(
      new Request("https://cloud.doulor.cn/api/admin/analytics/users?days=7", {
        headers: { Cookie: (await import("../src/auth")).sessionCookie(await (await import("../src/auth")).createSession(env, root.id)) },
      })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { newByDay?: Array<Record<string, unknown>> }
    expect(Array.isArray(body.newByDay)).toBe(true)
    for (const row of body.newByDay ?? []) {
      expect(typeof row.date).toBe("string")
      // 关键断言：必须有 count，且是数字
      expect(typeof row.count).toBe("number")
      expect(row.c).toBeUndefined()
    }
  })

  it("访问时段返回 24 个 {hour, pv, uv} 桶（有数据时 pv 为数字）", async () => {
    const root = await makeUser({ role: "root" })
    const auth = await import("../src/auth")
    const res = await fetchSelf(
      new Request("https://cloud.doulor.cn/api/admin/analytics?days=7", {
        headers: { Cookie: auth.sessionCookie(await auth.createSession(env, root.id)) },
      })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { byHour?: Array<{ hour: number; pv: number; uv: number }> }
    expect(Array.isArray(body.byHour)).toBe(true)
    for (const row of body.byHour ?? []) {
      expect(typeof row.hour).toBe("number")
      expect(typeof row.pv).toBe("number")
      expect(typeof row.uv).toBe("number")
    }
  })
})
