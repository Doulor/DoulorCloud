/**
 * 前端性能样本（RUM）采集端点的回归测试（2026-10-10）。
 *
 * 锁死四件事：
 *   A. POST /perf/collect 登录上报落库（user_id 带上、字段裁剪）；
 *   B. 匿名上报也收（user_id 空串）；
 *   C. 脏数据防御：page 为空 / 非法值被钳制或丢弃，一律静默 204 不抛错；
 *   D. GET /admin/perf/overview 聚合正确；scope=perf 之外的管理员 403。
 */
import { describe, expect, it, beforeAll } from "vitest"
import { env } from "cloudflare:workers"
import { fetchSelf, makeUser, authRequest } from "./helpers"

let admin: { id: string; username: string; cookie: string }
let user: { id: string; username: string; cookie: string }

beforeAll(async () => {
  admin = await makeUser({ role: "root" })
  user = await makeUser({})
})

/** 给 admin 直写 admin_scope（resolveAdminScope 读的是这列，不是 permissions） */
async function setAdminScope(userId: string, scope: string[]): Promise<void> {
  await env.DB.prepare("UPDATE users SET admin_scope = ? WHERE id = ?")
    .bind(JSON.stringify(scope), userId)
    .run()
}

function post(cookie?: string, payload?: unknown) {
  return fetchSelf(
    cookie
      ? authRequest(user, "/api/perf/collect", {
          method: "POST",
          body: JSON.stringify(payload),
        })
      : new Request("https://cloud.doulor.cn/api/perf/collect", {
          method: "POST",
          body: JSON.stringify(payload),
          headers: { "Content-Type": "application/json" },
        })
  )
}

describe("perf collect", () => {
  it("A: 登录上报落库（user_id + 指标裁剪）", async () => {
    const res = await post(user.cookie, {
      page: "/dashboard/points?btnstress=1",
      device: "mobile",
      ttfbMs: 123.7,
      dclMs: 456,
      lcpMs: 999999999,
      longTasks: 3,
      errors: 1,
      navMs: 88,
    })
    expect(res.status).toBe(204)

    const row = await env.DB.prepare(
      "SELECT user_id, page, device, ttfb_ms, lcp_ms FROM perf_samples WHERE user_id = ? ORDER BY created_at DESC LIMIT 1"
    )
      .bind(user.id)
      .first<{ user_id: string; page: string; device: string; ttfb_ms: number; lcp_ms: number }>()
    expect(row?.user_id).toBe(user.id)
    expect(row?.page).toBe("/dashboard/points") // 查询串被剥掉
    expect(row?.device).toBe("mobile")
    expect(row?.ttfb_ms).toBe(124)
    expect(row?.lcp_ms).toBe(600000) // 超大值被钳到上限
  })

  it("B: 匿名上报也收（user_id 空串）", async () => {
    const res = await post(undefined, { page: "/login", device: "desktop", longTasks: 0 })
    expect(res.status).toBe(204)
    const row = await env.DB.prepare(
      "SELECT user_id, page FROM perf_samples WHERE page = '/login' ORDER BY created_at DESC LIMIT 1"
    ).first<{ user_id: string; page: string }>()
    expect(row?.user_id).toBe("")
  })

  it("C: 脏数据防御 —— 空 page / 根路径被丢，仍是 204", async () => {
    const empty = await post(user.cookie, { page: "", ttfbMs: 1 })
    expect(empty.status).toBe(204)
    const root = await post(user.cookie, { page: "/" })
    expect(root.status).toBe(204)
    // 垃圾 body 也不炸
    const junk = await post(user.cookie, "not-json" as unknown as undefined)
    expect(junk.status).toBe(204)
  })
})

describe("admin perf overview", () => {
  it("D: 聚合返回 + 权限（root 可看、无 perf scope 的 admin 403）", async () => {
    const ok = await fetchSelf(authRequest(admin, "/api/admin/perf/overview?days=7"))
    expect(ok.status).toBe(200)
    const data = (await ok.json()) as {
      summary: { samples: number }
      byDay: unknown[]
      byPage: Array<{ page: string; samples: number }>
      byDevice: unknown[]
    }
    expect(data.summary.samples).toBeGreaterThan(0)
    expect(data.byPage.length).toBeGreaterThan(0)
    expect(data.byPage[0].page).toBe("/dashboard/points")

    // 有部分权限的 admin：没有 perf scope → 403
    const scoped = await makeUser({ role: "admin" })
    await setAdminScope(scoped.id, ["feedback"])
    const denied = await fetchSelf(authRequest(scoped, "/api/admin/perf/overview"))
    expect(denied.status).toBe(403)

    // 带 perf scope → 200
    await setAdminScope(scoped.id, ["feedback", "perf"])
    const allowed = await fetchSelf(authRequest(scoped, "/api/admin/perf/overview"))
    expect(allowed.status).toBe(200)

    // 单页样本接口
    const samples = await fetchSelf(
      authRequest(admin, "/api/admin/perf/samples?page=/dashboard/points&days=7")
    )
    expect(samples.status).toBe(200)
    const sdata = (await samples.json()) as { samples: unknown[]; page: string }
    expect(sdata.page).toBe("/dashboard/points")
    expect(sdata.samples.length).toBeGreaterThan(0)
  })
})
