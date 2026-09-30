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
import { describe, it, expect, afterEach, vi } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf } from "./helpers"
import { resetAdminCredentialCache } from "../src/newapi-client"

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

  it("切换角色 admin / user（root 专属）", async () => {
    const root = await makeUser({ role: "root" })
    const u = await makeUser()
    await put(root, u.username, { role: "admin" })
    let body = await detail(root, u.username)
    expect((body.user as { role: string }).role).toBe("admin")

    await put(root, u.username, { role: "user" })
    body = await detail(root, u.username)
    expect((body.user as { role: string }).role).toBe("user")
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

// ---- 封禁/解封联动 NewAPI 账户（2026-09-25 新增）----
//
// 需求：技术封禁 cloud 账户时，连带 disable 他在 NewAPI 里的账户（API Key 立即失效），
// 解封时 enable 回来。这里锁定三条关键语义：
//   1. 封禁 → 调 NewAPI manage{action:disable}；解封 → enable（对称）
//   2. 只改昵称/权限（status 没变）→ 不触发任何 NewAPI 调用
//   3. NewAPI 调用失败 → cloud 侧封禁照常生效（不回滚、不抛错）

describe("封禁/解封联动 NewAPI 账户", () => {
  const BASE = "https://api.doulor.cn"

  let restore: (() => void) | null = null
  let manageCalls: Array<{ body: Record<string, unknown> }> = []

  function stubNewApi(opts: { failManage?: boolean } = {}) {
    const original = globalThis.fetch
    manageCalls = []
    const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith(BASE)) {
        if (url.includes("/api/user/manage")) {
          if (opts.failManage) {
            return new Response(JSON.stringify({ success: false, message: "上游拒绝" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          }
          manageCalls.push({ body: JSON.parse((init?.body as string) ?? "{}") })
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        }
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return original(input as RequestInfo, init)
    }) as unknown as typeof fetch
    globalThis.fetch = stub
    restore = () => {
      globalThis.fetch = original
    }
  }

  afterEach(() => {
    restore?.()
    restore = null
    resetAdminCredentialCache()
    vi.restoreAllMocks()
  })

  /** 给用户塞一条 newapi_accounts，模拟「已开通中转站」 */
  async function seedAccount(userId: string, newapiUserId: number, username: string) {
    await env.DB.prepare(
      `INSERT INTO newapi_accounts
         (user_id, newapi_user_id, username, email, enc_token, group_name, quota, used_quota, request_count, synced_at, created_at)
       VALUES (?, ?, ?, ?, 'enc', 'default', 0, 0, 0, NULL, ?)`
    )
      .bind(userId, newapiUserId, username, `${username}@doulor.cn`, new Date().toISOString())
      .run()
  }

  async function put(admin: { cookie: string }, username: string, payload: unknown) {
    return fetchSelf(
      authRequest(admin, `/api/admin/users/${username}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
    )
  }

  it("封禁 → 调 NewAPI disable", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    await seedAccount(u.id, 5001, u.username)
    stubNewApi()

    const res = await put(admin, u.username, { status: "suspended" })
    expect(res.status).toBe(200)
    expect(manageCalls).toHaveLength(1)
    expect(manageCalls[0].body).toMatchObject({ id: 5001, action: "disable" })
  })

  it("解封 → 调 NewAPI enable（对称）", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    await seedAccount(u.id, 5002, u.username)
    stubNewApi()

    await put(admin, u.username, { status: "suspended" })
    await put(admin, u.username, { status: "active" })
    expect(manageCalls).toHaveLength(2)
    expect(manageCalls[0].body.action).toBe("disable")
    expect(manageCalls[1].body.action).toBe("enable")
  })

  /**
   * 「按用户名对齐」这条分支（`POST /api/admin/newapi/sync-permissions`）。
   *
   * 只验证「范围收窄 + SQL 绑定 + 响应形状」：传一个不存在的用户名时，
   * 查询返回 0 行 ⇒ 一个 NewAPI 请求都不该发（这也是它能安全用于单用户修复的原因 ——
   * 全量同步会逐个用户调 NewAPI，线上 170+ 个账号直接撞满 subrequest 上限）。
   * 真正的「启用被禁用账号」由线上对 pillbox 的修复验证。
   */
  it("按用户名对齐：只查这一个用户，查不到就不发任何请求", async () => {
    const admin = await makeUser({ role: "admin" })
    stubNewApi()

    const res = await fetchSelf(
      authRequest(admin, "/api/admin/newapi/sync-permissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "no-such-user-xyz" }),
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json<{
      username: string | null
      enabled: number
      disabled: number
      removedOrphans: number
      errors: string[]
    }>()
    expect(body.username).toBe("no-such-user-xyz")
    expect(body.enabled).toBe(0)
    expect(body.disabled).toBe(0)
    expect(body.removedOrphans).toBe(0)
    expect(body.errors).toEqual([])
    expect(manageCalls).toHaveLength(0)
  })

  it("只改昵称（status 未变）→ 不触发任何 NewAPI 调用", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    await seedAccount(u.id, 5003, u.username)
    stubNewApi()

    await put(admin, u.username, { nickname: "改名" })
    expect(manageCalls).toHaveLength(0)
  })

  it("没有 NewAPI 账户的用户封禁 → 静默跳过（不报错）", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser() // 不开通 NewAPI
    stubNewApi()

    const res = await put(admin, u.username, { status: "suspended" })
    expect(res.status).toBe(200)
    expect(manageCalls).toHaveLength(0)
  })

  it("NewAPI 调用失败 → cloud 封禁照常生效，不抛错", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    await seedAccount(u.id, 5004, u.username)
    stubNewApi({ failManage: true })

    const res = await put(admin, u.username, { status: "suspended" })
    // cloud 侧封禁是主操作，必须成功返回
    expect(res.status).toBe(200)

    // 库里 status 已真的改成 suspended（证明没被 NewAPI 失败回滚）
    const row = await env.DB.prepare("SELECT status FROM users WHERE id = ?")
      .bind(u.id)
      .first<{ status: string }>()
    expect(row?.status).toBe("suspended")
  })
})

// ---- root（站长）角色权限边界（2026-09-25 新增）----
//
// root 是凌驾于 admin 的角色：拥有 admin 全部权限，但 admin 无法修改/删除 root，
// 且只有 root 能变更角色。这里锁定这些边界，防止以后有人「顺手」把 root 当普通 admin 处理。

describe("root（站长）角色权限边界", () => {
  /** 造一个 root + 一个普通 admin，方便对比 */
  async function seedRoot(): Promise<{ root: { cookie: string; username: string } }> {
    const root = await makeUser({ role: "root", username: `root_${Math.random().toString(36).slice(2, 8)}` })
    return { root }
  }

  async function put(operator: { cookie: string }, username: string, payload: unknown) {
    return fetchSelf(
      authRequest(operator, `/api/admin/users/${username}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
    )
  }

  async function del(operator: { cookie: string }, username: string) {
    return fetchSelf(
      authRequest(operator, `/api/admin/users/${username}`, { method: "DELETE" })
    )
  }

  it("admin 不能修改 root 的任何字段（昵称）", async () => {
    const { root } = await seedRoot()
    const admin = await makeUser({ role: "admin" })
    expect((await put(admin, root.username, { nickname: "篡改" })).status).toBe(403)
  })

  it("admin 不能封禁 root", async () => {
    const { root } = await seedRoot()
    const admin = await makeUser({ role: "admin" })
    expect((await put(admin, root.username, { status: "suspended" })).status).toBe(403)
  })

  it("admin 不能把 root 降为普通用户", async () => {
    const { root } = await seedRoot()
    const admin = await makeUser({ role: "admin" })
    expect((await put(admin, root.username, { role: "user" })).status).toBe(403)
  })

  it("admin 不能删除 root", async () => {
    const { root } = await seedRoot()
    const admin = await makeUser({ role: "admin" })
    expect((await del(admin, root.username)).status).toBe(403)
  })

  it("admin 不能变更任何人的角色（不能互提/降级）", async () => {
    const admin = await makeUser({ role: "admin" })
    const u = await makeUser()
    // admin 想把普通用户提为 admin → 被拒
    expect((await put(admin, u.username, { role: "admin" })).status).toBe(403)
    // admin 想把另一个 admin 降级 → 也被拒
    const admin2 = await makeUser({ role: "admin" })
    expect((await put(admin, admin2.username, { role: "user" })).status).toBe(403)
  })

  it("root 可以提别人为 admin / 撤销 admin", async () => {
    const { root } = await seedRoot()
    const u = await makeUser()
    expect((await put(root, u.username, { role: "admin" })).status).toBe(200)

    const admin = await makeUser({ role: "admin" })
    expect((await put(root, admin.username, { role: "user" })).status).toBe(200)
  })

  it("root 角色不可被变更（即使是 root 自己也不能把另一个 root 降级）", async () => {
    const { root } = await seedRoot()
    const root2 = await makeUser({ role: "root" })
    expect((await put(root, root2.username, { role: "user" })).status).toBe(403)
  })
})
