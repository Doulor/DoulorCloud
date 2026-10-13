/**
 * 「我」在中转站的账号如何认人（2026-10-12 修）。
 *
 * 🔴 惨痛实例：用户 `masters` 在中转站的账号叫 **`master3test`**（OIDC 登录时建的，
 * oidc_id 就是他的 cloud 用户 id，等于早绑好了），但我们一直按**用户名**去搜 ⇒
 * 永远找不到 ⇒ 前端提示「中转站里还没有你的账号，请先去用 Doulor Cloud 登录」，
 * 用户被指去反复登录、怎么都开通不了。
 *
 * 这里用桩 fetch 锁住规则：
 *   · 用户名搜到**别人**的账号 + 邮箱搜到**我的**账号 ⇒ 认邮箱那个（oidc_id 命中）；
 *   · 只有用户名命中但 oidc_id 不是我的 ⇒ 不能拿去绑定（others）；
 *   · 都搜不到 ⇒ 谁都不认（让上层给出「还没有你的账号」）。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { env } from "cloudflare:workers"
import { resolveMyRelayAccount } from "../src/newapi-client"

const ME = "a096b5ea-2afb-4751-b133-7111e1051dd4"

/** NewAPI 的 search 响应外壳：{data:{items:[…]}} */
function search(items: Record<string, unknown>[]): Response {
  return new Response(JSON.stringify({ success: true, message: "", data: { items } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

/** 按 keyword 分派桩响应 */
function stubSearch(byKeyword: Record<string, Record<string, unknown>[]>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const kw = decodeURIComponent(new URL(url).searchParams.get("keyword") ?? "")
      return search(byKeyword[kw] ?? [])
    })
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("中转站账号认人（oidc_id 优先）", () => {
  it("用户名指向别人、邮箱指向我 ⇒ 必须认出我的那台（用户名可以不一样）", async () => {
    stubSearch({
      masters: [{ id: 1, username: "masters", email: "someone-else@example.com", oidc_id: null }],
      "421016757@qq.com": [
        { id: 399, username: "master3test", email: "421016757@qq.com", oidc_id: ME },
      ],
    })
    const { mine, others } = await resolveMyRelayAccount(env, {
      userId: ME,
      username: "masters",
      emails: ["421016757@qq.com"],
    })
    expect(mine?.id).toBe(399)
    expect(mine?.username).toBe("master3test")
    expect(others.map((o) => o.id)).toEqual([1])
  })

  it("只搜到同名但 oidc_id 不是我的 ⇒ 不能认（走「同名账号不是用 Doulor Cloud 建的」提示）", async () => {
    stubSearch({
      masters: [{ id: 1, username: "masters", email: "x@example.com", oidc_id: "other-user-id" }],
      "me@example.com": [],
    })
    const { mine, others } = await resolveMyRelayAccount(env, {
      userId: ME,
      username: "masters",
      emails: ["me@example.com"],
    })
    expect(mine).toBeNull()
    expect(others.map((o) => o.id)).toEqual([1])
  })

  it("谁都搜不到 ⇒ 都不认（上层提示「还没有你的账号」）", async () => {
    stubSearch({})
    const { mine, others } = await resolveMyRelayAccount(env, {
      userId: ME,
      username: "nobody",
      emails: ["nobody@example.com"],
    })
    expect(mine).toBeNull()
    expect(others).toEqual([])
  })

  it("已注销（DeletedAt）的账号不算数", async () => {
    stubSearch({
      "421016757@qq.com": [
        {
          id: 399,
          username: "master3test",
          email: "421016757@qq.com",
          oidc_id: ME,
          DeletedAt: "2026-10-01T00:00:00Z",
        },
      ],
    })
    const { mine } = await resolveMyRelayAccount(env, {
      userId: ME,
      username: "masters",
      emails: ["421016757@qq.com"],
    })
    expect(mine).toBeNull()
  })
})
