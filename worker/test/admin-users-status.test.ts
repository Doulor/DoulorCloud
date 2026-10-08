/**
 * 管理面板 → 用户列表批量封禁 / 解封（POST /api/admin/users/bulk-status）。
 *
 * 守住的语义：
 *   · 与单人编辑**完全同一条链路**（applyUserStatusChange）：状态、原因、资源停用、
 *     IP 拉黑、NewAPI 同步、审计都在里面，批量不另写一套；
 *   · **先校验再动手**：白名单用户 / root 账户 / 缺原因，都在应用之前整体拒绝，
 *     不会封了一半才发现问题；
 *   · 幂等跳过：状态本来就是目标值的不重复联动（updated/skipped 分开计数）；
 *   · 普通用户 403（权限节点与单人一致：users.suspend）。
 */
import { describe, expect, it } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser } from "./helpers"

type U = Awaited<ReturnType<typeof makeUser>>

function bulkReq(user: U, body: unknown): Request {
  return authRequest(user, "/api/admin/users/bulk-status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function statusOf(userId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT status, suspend_reason FROM users WHERE id = ?")
    .bind(userId)
    .first<{ status: string; suspend_reason: string | null }>()
  return row?.status ?? null
}

async function reasonOf(userId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT suspend_reason FROM users WHERE id = ?")
    .bind(userId)
    .first<{ suspend_reason: string | null }>()
  return row?.suspend_reason ?? null
}

async function whitelist(username: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO moderation_whitelist (id, username, source, created_at) VALUES (?, ?, 'manual', ?)"
  )
    .bind(crypto.randomUUID(), username, new Date().toISOString())
    .run()
}

describe("用户列表 · 批量封禁 / 解封", () => {
  it("批量封禁：状态与原因都落库，计数正确", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const a = await makeUser({})
    const b = await makeUser({})

    const res = await fetchSelf(
      bulkReq(admin, {
        userIds: [a.id, b.id],
        action: "suspend",
        reason: "批量注册小号",
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json<{ updated: number; skipped: number }>()
    expect(body.updated).toBe(2)
    expect(body.skipped).toBe(0)
    expect(await statusOf(a.id)).toBe("suspended")
    expect(await statusOf(b.id)).toBe("suspended")
    expect(await reasonOf(a.id)).toBe("批量注册小号")
  })

  it("批量解封：状态恢复，封禁原因被清掉", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const a = await makeUser({})
    await fetchSelf(
      bulkReq(admin, { userIds: [a.id], action: "suspend", reason: "先封再说" })
    )
    expect(await statusOf(a.id)).toBe("suspended")

    const res = await fetchSelf(bulkReq(admin, { userIds: [a.id], action: "unsuspend" }))
    expect(res.status).toBe(200)
    expect(await statusOf(a.id)).toBe("active")
    expect(await reasonOf(a.id)).toBeNull()
  })

  it("封禁必须填原因（批量影响面大，原因更要留痕）", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const a = await makeUser({})
    const res = await fetchSelf(bulkReq(admin, { userIds: [a.id], action: "suspend", reason: "  " }))
    expect(res.status).toBe(400)
    expect(await statusOf(a.id)).toBe("active") // 什么都没动
  })

  it("白名单用户：整体拒绝，一个都不封（不做半截）", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const ok = await makeUser({})
    const wl = await makeUser({})
    await whitelist(wl.username)

    const res = await fetchSelf(
      bulkReq(admin, { userIds: [ok.id, wl.id], action: "suspend", reason: "一起封" })
    )
    expect(res.status).toBe(400)
    // 关键：白名单那个被拒，连带的普通用户也没被封（先校验再动手）
    expect(await statusOf(ok.id)).toBe("active")
    expect(await statusOf(wl.id)).toBe("active")
  })

  it("非 root 操作者不能批量动 root 账户", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const root = await makeUser({ role: "root" })
    const res = await fetchSelf(
      bulkReq(admin, { userIds: [root.id], action: "suspend", reason: "试试" })
    )
    expect(res.status).toBe(403)
    expect(await statusOf(root.id)).toBe("active")
  })

  it("幂等：已经是目标状态的被跳过（skipped）", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const a = await makeUser({})
    await fetchSelf(bulkReq(admin, { userIds: [a.id], action: "suspend", reason: "第一次" }))

    const res = await fetchSelf(
      bulkReq(admin, { userIds: [a.id], action: "suspend", reason: "第二次" })
    )
    const body = await res.json<{ updated: number; skipped: number }>()
    expect(body.updated).toBe(0)
    expect(body.skipped).toBe(1)
  })

  it("边界：空选择 / 未知操作 / 超过 90 人被拒；普通用户 403", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const u = await makeUser({})
    expect((await fetchSelf(bulkReq(admin, { userIds: [], action: "suspend", reason: "x" }))).status).toBe(400)
    expect((await fetchSelf(bulkReq(admin, { userIds: [u.id], action: "nuke" }))).status).toBe(400)
    const tooMany = Array.from({ length: 91 }, (_, i) => `u${i}`)
    expect(
      (await fetchSelf(bulkReq(admin, { userIds: tooMany, action: "suspend", reason: "x" }))).status
    ).toBe(400)

    const normal = await makeUser({})
    expect(
      (await fetchSelf(bulkReq(normal, { userIds: [u.id], action: "suspend", reason: "x" }))).status
    ).toBe(403)
  })

  it("回归：单人封禁仍然走同一条链路（重构没把联动弄丢）", async () => {
    const admin = await makeUser({ role: "superadmin" })
    const u = await makeUser({})
    const res = await fetchSelf(
      authRequest(admin, `/api/admin/users/${encodeURIComponent(u.username)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "suspended", suspendReason: "单人封禁回归" }),
      })
    )
    expect(res.status).toBe(200)
    expect(await statusOf(u.id)).toBe("suspended")
    expect(await reasonOf(u.id)).toBe("单人封禁回归")

    // 单人解封同样要恢复正常
    const back = await fetchSelf(
      authRequest(admin, `/api/admin/users/${encodeURIComponent(u.username)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      })
    )
    expect(back.status).toBe(200)
    expect(await statusOf(u.id)).toBe("active")
    expect(await reasonOf(u.id)).toBeNull()
  })
})
