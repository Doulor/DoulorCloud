/**
 * 「未验证邮箱」功能门槛（2026-10-02 站长要求）。
 *
 * 口径：未验证邮箱的账号**可以进所有页面**（GET 一律放行），
 * 但**不能开通/创建/提交**任何业务功能（中转站、网盘、域名解析、邮箱转发、
 * 聊天、私信、社区发帖…），只能改自己的账户信息（用户名/密码/昵称/头像/注销）。
 *
 * 规则实体在 `worker/src/auth.ts` 的 `EMAIL_VERIFY_REQUIRED_PREFIXES`。
 */
import { describe, expect, it } from "vitest"
import { authRequest, fetchSelf, makeUser } from "./helpers"

/** 断言这次响应不是被邮箱门槛拦下的（可能因其它原因失败，那不属于本用例范围） */
async function expectNotGated(res: Response): Promise<void> {
  const body = await res
    .json<{ code?: string }>()
    .catch((): { code?: string } => ({}))
  expect(body.code).not.toBe("EMAIL_NOT_VERIFIED")
}

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }
}

describe("未验证邮箱：写操作被拦", () => {
  it("建子域名 → 403 EMAIL_NOT_VERIFIED", async () => {
    const u = await makeUser({ emailVerified: false })
    const res = await fetchSelf(authRequest(u, "/api/subdomains", post({ name: "whatever" })))
    expect(res.status).toBe(403)
    expect((await res.json<{ code?: string }>()).code).toBe("EMAIL_NOT_VERIFIED")
  })

  it("社区发帖 → 403 EMAIL_NOT_VERIFIED", async () => {
    const u = await makeUser({ emailVerified: false })
    const res = await fetchSelf(
      authRequest(u, "/api/community/posts", post({ content: "hi" }))
    )
    expect(res.status).toBe(403)
    expect((await res.json<{ code?: string }>()).code).toBe("EMAIL_NOT_VERIFIED")
  })

  it("聊天室发言 → 403 EMAIL_NOT_VERIFIED", async () => {
    const u = await makeUser({ emailVerified: false })
    const res = await fetchSelf(
      authRequest(u, "/api/chat/messages", post({ content: "hi" }))
    )
    expect(res.status).toBe(403)
    expect((await res.json<{ code?: string }>()).code).toBe("EMAIL_NOT_VERIFIED")
  })
})

describe("未验证邮箱：只读与账户设置照常可用", () => {
  it("只读 GET 放行（可以进页面）", async () => {
    const u = await makeUser({ emailVerified: false })
    await expectNotGated(await fetchSelf(authRequest(u, "/api/dev/status")))
    await expectNotGated(await fetchSelf(authRequest(u, "/api/subdomains")))
    await expectNotGated(await fetchSelf(authRequest(u, "/api/community/posts")))
  })

  it("改用户名放行（站长要求保留）", async () => {
    const u = await makeUser({ emailVerified: false })
    await expectNotGated(
      await fetchSelf(authRequest(u, "/api/settings/username", post({ username: "" })))
    )
  })

  it("改昵称 / 验证邮箱 / 注销接口都不被门槛拦", async () => {
    const u = await makeUser({ emailVerified: false })
    await expectNotGated(
      await fetchSelf(authRequest(u, "/api/settings/nickname", post({ nickname: "x" })))
    )
    await expectNotGated(
      await fetchSelf(
        authRequest(u, "/api/settings/email/verify", post({ action: "status" }))
      )
    )
    await expectNotGated(
      await fetchSelf(authRequest(u, "/api/settings/account/delete-code", post({})))
    )
  })
})

describe("未验证邮箱：豁免与对照组", () => {
  it("已验证账号：同样的写操作不被门槛拦", async () => {
    const u = await makeUser()
    await expectNotGated(
      await fetchSelf(authRequest(u, "/api/subdomains", post({ name: "whatever" })))
    )
  })

  it("管理员即使未验证也豁免（否则站长被锁在后台外）", async () => {
    const admin = await makeUser({ role: "admin", emailVerified: false })
    await expectNotGated(
      await fetchSelf(authRequest(admin, "/api/subdomains", post({ name: "whatever" })))
    )
  })

  it("未验证账号调管理接口仍被 admin 校验拦住（门槛不改变管理员边界）", async () => {
    const u = await makeUser({ emailVerified: false })
    const res = await fetchSelf(authRequest(u, "/api/admin/users"))
    expect(res.status).toBe(403)
  })
})
