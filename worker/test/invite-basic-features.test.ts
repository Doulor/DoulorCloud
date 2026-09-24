// 邀请码「基础权限 / 受限模式」开关的语义 —— 特别是「全部关掉」这个状态。
//
// 背景（用户实测报的 bug）：管理面板里把「直链网盘」的开关关掉、保存后再看，
// 创建邀请码时它仍然显示「基础权限 · 不消耗额度」。
// 根因不在存储（存库确实是空串），而在读取：解析函数把**空串**和
// **设置项缺失** 混为一谈，一律回落默认的 r2，于是 r2 永远关不掉。
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser, setSetting } from "./helpers"
import { parseBasicFeatures } from "../src/quotas"

describe("parseBasicFeatures", () => {
  it("空串 = 全部受限（这是最容易写错的一个）", () => {
    expect([...parseBasicFeatures("")]).toEqual([])
    // 只写空白/逗号的脏值也应当等价于空
    expect([...parseBasicFeatures(" , ")]).toEqual([])
  })

  it("设置项缺失才回落默认的 r2", () => {
    expect([...parseBasicFeatures(null)]).toEqual(["r2"])
    expect([...parseBasicFeatures(undefined)]).toEqual(["r2"])
  })

  it("正常解析并忽略非法项", () => {
    expect([...parseBasicFeatures("r2,ai")].sort()).toEqual(["ai", "r2"])
    expect([...parseBasicFeatures(" ai , proxy ")].sort()).toEqual(["ai", "proxy"])
    expect([...parseBasicFeatures("r2,bogus")]).toEqual(["r2"])
  })

  it("全是脏数据也当空处理（按字面解析，不猜意图）", () => {
    // 「认不出就兜底 r2」正是让 r2 开关关不掉的根源，所以这里刻意不兜底
    expect([...parseBasicFeatures("bogus")]).toEqual([])
    expect([...parseBasicFeatures("r2x,ai2")]).toEqual([])
  })
})

describe("基础权限开关影响创建邀请码", () => {
  /** 直接改全局设置，避免依赖管理接口（那条路径另有测试覆盖） */
  async function setBasic(raw: string) {
    await setSetting("invite_basic_features", raw)
  }

  async function myInvites(user: { id: string; username: string; cookie: string }) {
    const res = await fetchSelf(authRequest(user, "/api/my-invites"))
    return res.json<{
      basicFeatures: string[]
      quota: { featureRemaining: Record<string, number> }
      invites: { id: string; code: string; permissions: Record<string, boolean> }[]
    }>()
  }

  async function createInvite(
    user: { id: string; username: string; cookie: string },
    features: string[]
  ) {
    return fetchSelf(
      authRequest(user, "/api/my-invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ features }),
      })
    )
  }

  it("把 r2 改成受限后，前端拿到的 basicFeatures 里就没有 r2 了", async () => {
    const user = await makeUser()
    await setBasic("")
    const data = await myInvites(user)
    expect(data.basicFeatures).toEqual([])

    await setBasic("ai")
    const data2 = await myInvites(user)
    expect(data2.basicFeatures).toEqual(["ai"])
  })

  it("r2 受限且额度为 0 时，勾选它会失败并提示额度不足", async () => {
    const user = await makeUser()
    await setBasic("")

    const res = await createInvite(user, ["r2"])
    expect(res.status).toBe(400)
    const body = (await res.json()) as { code?: string; error?: string }
    expect(body.code).toBe("FEATURE_QUOTA_EXCEEDED")
    expect(body.error).toContain("直链网盘")

    // 失败不该留下半个邀请码
    const data = await myInvites(user)
    expect(data.invites).toHaveLength(0)
  })

  it("管理员手动发放 r2 额度后即可创建，并真正扣掉 1 个", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await setBasic("")

    // 管理员在「用户额度」面板里给 r2 发 2 个额度
    const grant = await fetchSelf(
      authRequest(admin, `/api/admin/users/${user.username}/invite-quota`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featureQuota: { r2: 2 } }),
      })
    )
    expect(grant.status).toBe(200)

    const res = await createInvite(user, ["r2"])
    expect(res.status).toBe(201)
    const created = (await res.json()) as {
      invite: { code: string; permissions: Record<string, boolean> }
    }
    expect(created.invite.permissions.r2).toBe(true)

    const after = await myInvites(user)
    expect(after.quota.featureRemaining.r2).toBe(1)
  })

  it("r2 仍是基础权限时，勾选它不消耗模块额度", async () => {
    const admin = await makeUser({ role: "admin" })
    const user = await makeUser()
    await setBasic("r2")

    // 先给它 1 个 r2 额度，才能看出「有没有被扣」
    await fetchSelf(
      authRequest(admin, `/api/admin/users/${user.username}/invite-quota`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featureQuota: { r2: 1 } }),
      })
    )

    const res = await createInvite(user, ["r2"])
    expect(res.status).toBe(201)

    const after = await myInvites(user)
    expect(after.quota.featureRemaining.r2).toBe(1)
  })
})
