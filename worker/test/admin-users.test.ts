// 管理面板「用户」列表与详情的字段契约。
//
// 背景：列表原先展示「子域名 / DNS / 邮箱 / 邮件」四个计数，这些是资源明细，
// 放在列表里既不好读也没法一眼看出「这人到底在用哪些服务」。
// 现在改成四个模块 + 名片的**开通状态**（勾/叉），明细全部收敛到详情弹窗。
//
// 这里锁定两件事，避免以后有人「顺手」把明细塞回列表：
//   1. 列表只回开通状态，且判定口径与各 handler 的 isActivated 一致
//      （有记录 **且** enabled=1，名片以 published=1 为准）；
//   2. 详情带上模块用量、额度与最近活动，供弹窗渲染。
import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf } from "./helpers"

interface ListUser {
  username: string
  storageEnabled: boolean
  aiEnabled: boolean
  frpEnabled: boolean
  proxyEnabled: boolean
  profileEnabled: boolean
  profileSlug: string | null
  profileFqdn: string | null
  subdomainCount?: number
  dnsCount?: number
  mailboxCount?: number
  mailCount?: number
}

async function listUsers(admin: { cookie: string }): Promise<ListUser[]> {
  const res = await fetchSelf(authRequest(admin, "/api/admin/users"))
  expect(res.status).toBe(200)
  const body = await res.json<{ users: ListUser[] }>()
  return body.users
}

async function detail(admin: { cookie: string }, username: string) {
  const res = await fetchSelf(authRequest(admin, `/api/admin/users/${username}`))
  expect(res.status).toBe(200)
  return res.json<Record<string, unknown>>()
}

describe("GET /api/admin/users —— 列表只回模块开通状态", () => {
  it("不再回传子域名/DNS/邮箱/邮件计数", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    const row = (await listUsers(admin)).find((x) => x.username === u.username)!
    expect(row).toBeDefined()
    expect(row.subdomainCount).toBeUndefined()
    expect(row.dnsCount).toBeUndefined()
    expect(row.mailboxCount).toBeUndefined()
    expect(row.mailCount).toBeUndefined()
  })

  it("全新用户：五个模块全为未开通", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    const row = (await listUsers(admin)).find((x) => x.username === u.username)!
    expect(row.storageEnabled).toBe(false)
    expect(row.aiEnabled).toBe(false)
    expect(row.frpEnabled).toBe(false)
    expect(row.proxyEnabled).toBe(false)
    expect(row.profileEnabled).toBe(false)
    expect(row.profileSlug).toBeNull()
  })

  it("网盘：有记录但 enabled=0 视为未开通", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    const now = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO storage_accounts (user_id, prefix, quota_bytes, used_bytes, file_count, enabled, created_at, updated_at)
       VALUES (?, ?, 0, 0, 0, 0, ?, ?)`
    ).bind(u.id, u.username, now, now).run()
    let row = (await listUsers(admin)).find((x) => x.username === u.username)!
    expect(row.storageEnabled).toBe(false)

    await env.DB.prepare("UPDATE storage_accounts SET enabled = 1 WHERE user_id = ?").bind(u.id).run()
    row = (await listUsers(admin)).find((x) => x.username === u.username)!
    expect(row.storageEnabled).toBe(true)
  })

  it("AI 中转站：只要建了账号就算开通（无 enabled 列）", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    await env.DB.prepare(
      `INSERT INTO newapi_accounts (user_id, newapi_user_id, username, email, enc_token, created_at)
       VALUES (?, 42, ?, ?, 'x', ?)`
    ).bind(u.id, u.username, `${u.username}@doulor.cn`, new Date().toISOString()).run()
    const row = (await listUsers(admin)).find((x) => x.username === u.username)!
    expect(row.aiEnabled).toBe(true)
  })

  it("内网穿透 / 代理节点：区分「有记录但关着」与「已启用」", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    const now = new Date().toISOString()
    await env.DB.prepare(
      "INSERT INTO frp_accounts (user_id, enabled, created_at, updated_at) VALUES (?, 0, ?, ?)"
    ).bind(u.id, now, now).run()
    await env.DB.prepare(
      `INSERT INTO proxy_activation (user_id, enabled, consent_version, created_at, updated_at)
       VALUES (?, 1, 1, ?, ?)`
    ).bind(u.id, now, now).run()

    const row = (await listUsers(admin)).find((x) => x.username === u.username)!
    expect(row.frpEnabled).toBe(false)
    expect(row.proxyEnabled).toBe(true)
  })

  it("名片：回 published 与公开地址所需的 slug/fqdn", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    const now = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO profiles (user_id, slug, published, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?)`
    ).bind(u.id, u.username, now, now).run()

    const row = (await listUsers(admin)).find((x) => x.username === u.username)!
    expect(row.profileEnabled).toBe(true)
    expect(row.profileSlug).toBe(u.username)
    expect(row.profileFqdn).toBeNull()
  })

  it("非管理员看不到列表", async () => {
    const u = await makeUser()
    const res = await fetchSelf(authRequest(u, "/api/admin/users"))
    expect(res.status).toBe(403)
  })
})

describe("GET /api/admin/users/:username —— 详情带模块用量与额度", () => {
  it("账号字段：昵称/邮箱验证/通知开关/头像", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    const body = await detail(admin, u.username)
    const user = body.user as Record<string, unknown>
    expect(user.nickname).toBeNull()
    // makeUser 建号时未验证邮箱，notify_enabled 默认 1
    expect(user.emailVerified).toBe(false)
    expect(user.notifyEnabled).toBe(true)
    expect(user.hasAvatar).toBe(false)
  })

  it("未开通任何模块时，各模块明细为 null 而非 undefined", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    const body = await detail(admin, u.username)
    expect(body.storage).toBeNull()
    expect(body.newapi).toBeNull()
    expect(body.frp).toBeNull()
    expect(body.proxy).toBeNull()
    expect(body.profile).toBeNull()
    expect(body.activity).toEqual([])
  })

  it("网盘明细：用量 / 配额 / 桶名", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    const now = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO storage_accounts (user_id, prefix, quota_bytes, used_bytes, file_count, enabled, created_at, updated_at)
       VALUES (?, ?, 1024, 512, 3, 1, ?, ?)`
    ).bind(u.id, u.username, now, now).run()

    const body = await detail(admin, u.username)
    const storage = body.storage as Record<string, unknown>
    expect(storage.prefix).toBe(u.username)
    expect(storage.quotaBytes).toBe(1024)
    expect(storage.usedBytes).toBe(512)
    expect(storage.fileCount).toBe(3)
    expect(storage.enabled).toBe(true)
    expect(storage.bucketName).toBeNull()
  })

  it("额度：基础 + 捐献 - 已用", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    await env.DB.prepare(
      "UPDATE users SET invite_quota_bonus = 2, invite_quota_used = 1 WHERE id = ?"
    ).bind(u.id).run()

    const body = await detail(admin, u.username)
    const quota = body.quota as Record<string, unknown>
    const base = quota.inviteBase as number
    expect(quota.inviteBonus).toBe(2)
    expect(quota.inviteUsed).toBe(1)
    expect(quota.inviteTotal).toBe(base + 2)
    expect(quota.inviteRemaining).toBe(base + 2 - 1)
  })

  it("最近活动：只回该用户自己的审计日志", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    const other = await makeUser()
    const now = new Date().toISOString()
    await env.DB.prepare(
      "INSERT INTO audit_logs (id, user_id, action, detail, created_at) VALUES ('a1', ?, 'storage.upload', '上传了 1 个文件', ?)"
    ).bind(u.id, now).run()
    await env.DB.prepare(
      "INSERT INTO audit_logs (id, user_id, action, detail, created_at) VALUES ('a2', ?, 'storage.upload', '别人的操作', ?)"
    ).bind(other.id, now).run()

    const body = await detail(admin, u.username)
    const activity = body.activity as { detail: string }[]
    expect(activity).toHaveLength(1)
    expect(activity[0].detail).toBe("上传了 1 个文件")
  })
})

describe("PUT /api/admin/users/:username —— 新增的可编辑项", () => {
  async function put(admin: { cookie: string }, username: string, payload: unknown) {
    return fetchSelf(
      authRequest(admin, `/api/admin/users/${username}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
    )
  }

  it("设置与清空昵称", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    expect((await put(admin, u.username, { nickname: "小豆" })).status).toBe(200)
    let body = await detail(admin, u.username)
    expect((body.user as { nickname: string }).nickname).toBe("小豆")

    expect((await put(admin, u.username, { nickname: null })).status).toBe(200)
    body = await detail(admin, u.username)
    expect((body.user as { nickname: string | null }).nickname).toBeNull()
  })

  it("昵称格式非法 / 命中保留词时被拒", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    expect((await put(admin, u.username, { nickname: "a" })).status).toBe(400)
    expect((await put(admin, u.username, { nickname: "管理员" })).status).toBe(400)
  })

  it("切换邮箱验证与通知开关", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    await put(admin, u.username, { emailVerified: true, notifyEnabled: false })
    const body = await detail(admin, u.username)
    const user = body.user as { emailVerified: boolean; notifyEnabled: boolean }
    expect(user.emailVerified).toBe(true)
    expect(user.notifyEnabled).toBe(false)
  })

  it("切换角色 admin / user", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    await put(admin, u.username, { role: "admin" })
    let body = await detail(admin, u.username)
    expect((body.user as { role: string }).role).toBe("admin")

    await put(admin, u.username, { role: "user" })
    body = await detail(admin, u.username)
    expect((body.user as { role: string }).role).toBe("user")
  })

  it("主管理员不可改", async () => {
    const admin = await makeUser({ role: "admin" })
    await makeUser({ username: "doulor" })
    expect((await put(admin, "doulor", { nickname: "换个名" })).status).toBe(400)
    expect((await put(admin, "doulor", { role: "user" })).status).toBe(400)
  })

  it("只改昵称不会顺带清掉权限（COALESCE 语义）", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    await put(admin, u.username, { permissions: { r2: false, ai: true, frp: true, proxy: true } })
    await put(admin, u.username, { nickname: "改名了" })
    const body = await detail(admin, u.username)
    const user = body.user as { permissions: Record<string, boolean> }
    expect(user.permissions.r2).toBe(false)
    expect(user.permissions.ai).toBe(true)
  })
})
