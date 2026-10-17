// 跨站写请求守卫（`assertNotCrossSite`）的两条边界。
//
// 为什么单独钉这两条：
//   ① `lab-store` 是本站**唯一一个对公网开放写入**的接口（作品页里存留言/计数器），
//      它不依赖 cookie、响应 CORS 是 `*`、数据本来就是公开的 —— CSRF 这层在它身上
//      没有任何要保护的东西。但它的调用方**必然跨源**：
//        · 作品绑在用户自己的子域（`foo.tyu.me`）→ 调 `cloud.doulor.cn`，host 不同；
//        · 作品跑在 `tyu.me/<页面名>` 的 CSP sandbox 里 → 浏览器发 `Origin: null`。
//      不豁免 ⟹ 这个功能在浏览器里**完全不可用**，而且报的是 403 CSRF_BLOCKED，
//      作者根本看不出原因（2026-10-17 的线上故障就是这么来的）。
//   ② 但豁免只能给这一条前缀 —— 其它写接口都带 cookie，正是这层要挡的。
//      一旦有人把豁免放宽成「所有 /api」，转积分、删资源、改资料全都裸奔，
//      而那时候不会有任何报错，只有静默的风险。
//
// 这里走的是真实入口（`fetchSelf` → 完整 fetch handler），不是单测那个函数本身。
import { describe, it, expect } from "vitest"

import { fetchSelf } from "./helpers"

const BASE = "https://cloud.doulor.cn"
/** 一个语法合法但必然不存在的作品 id —— 我们要验的是「没被 CSRF 先拦」，不是存储本身 */
const NO_SUCH_PROJECT = "00000000-0000-0000-0000-000000000000"

function makeRequest(
  path: string,
  opts: { method?: string; origin?: string | null } = {}
): Request {
  const method = opts.method ?? "POST"
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  // 浏览器在 CSP sandbox（不透明源）里发请求时，Origin 的字面值就是 "null"
  if (opts.origin !== null && opts.origin !== undefined) headers["Origin"] = opts.origin
  const init: RequestInit = { method, headers }
  if (method !== "GET" && method !== "HEAD") init.body = "{}"
  return new Request(BASE + path, init)
}

async function errorCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { code?: string }
    return body.code
  } catch {
    return undefined
  }
}

describe("CSRF 守卫：lab-store 豁免", () => {
  it("Origin: null（CSP sandbox 的作品页）写 lab-store 不被 CSRF 拦", async () => {
    const res = await fetchSelf(
      makeRequest(`/api/lab-store/${NO_SUCH_PROJECT}/k`, { method: "PUT", origin: "null" })
    )
    expect(await errorCode(res)).not.toBe("CSRF_BLOCKED")
  })

  it("Origin 是用户自己的作品子域（跨 host 同 site）写 lab-store 不被 CSRF 拦", async () => {
    const res = await fetchSelf(
      makeRequest(`/api/lab-store/${NO_SUCH_PROJECT}/k`, {
        method: "PUT",
        origin: "https://somebody.tyu.me",
      })
    )
    expect(await errorCode(res)).not.toBe("CSRF_BLOCKED")
  })

  it("DELETE 同样豁免（作品里删一条记录）", async () => {
    const res = await fetchSelf(
      makeRequest(`/api/lab-store/${NO_SUCH_PROJECT}/k`, { method: "DELETE", origin: "null" })
    )
    expect(await errorCode(res)).not.toBe("CSRF_BLOCKED")
  })
})

describe("CSRF 守卫：其它写接口保持拦截（豁免不能放宽）", () => {
  it("转积分：Origin: null → 403 CSRF_BLOCKED", async () => {
    const res = await fetchSelf(makeRequest("/api/points/transfer", { origin: "null" }))
    expect(res.status).toBe(403)
    expect(await errorCode(res)).toBe("CSRF_BLOCKED")
  })

  it("实验室技能：Origin: null → 403 CSRF_BLOCKED", async () => {
    const res = await fetchSelf(makeRequest("/api/lab/skills", { origin: "null" }))
    expect(res.status).toBe(403)
    expect(await errorCode(res)).toBe("CSRF_BLOCKED")
  })

  it("前缀不能被「包含」绕过：`/api/lab-storex/...` 仍要拦", async () => {
    // 豁免判断必须是 `/api/lab-store` 或 `/api/lab-store/` 开头，
    // 不能写成 includes —— 否则 /api/lab-store-evil 之类会被一起放行。
    const res = await fetchSelf(makeRequest("/api/lab-storex/whatever", { origin: "null" }))
    expect(res.status).toBe(403)
    expect(await errorCode(res)).toBe("CSRF_BLOCKED")
  })
})
