// 内网穿透申请：**鉴权方式决定要不要「每用户账号 + 密码」**（2026-09-30）。
//
// 背景（站长反馈 tangwz 那台节点）：捐献者可以选「全局 auth.token」模式 ——
// 那种服务器上只有一个共享密钥，没有按用户区分的账号。再强制申请人填账号密码，
// 等于让他凭空编一个**永远用不到**的密码；管理员收到的通知里还会写着
// 「请在 frps-panel 用同样的值建号」，等于骗管理员去建一个没用的号。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf, setSetting, setPermissions } from "./helpers"

/** 造一个「已启用 frp、邮箱可用」的用户 */
async function frpUser() {
  const u = await makeUser()
  await setPermissions(u.id, JSON.stringify({ frp: true }))
  // 申请时的通知邮箱必须是「自己的本站邮箱」或「本人已验证的真实邮箱」——
  // 默认的 {username}@doulor.cn 在 mailboxes 里没有对应行，会被判为不属于本人。
  // 所以这里把账号邮箱换成一个非本站域名并标记已验证，省掉建 mailbox 的步骤。
  await env.DB.prepare("UPDATE users SET email = ?, email_verified = 1 WHERE id = ?")
    .bind(`${u.username}@example.com`, u.id)
    .run()
  await env.DB.prepare(
    "INSERT INTO frp_accounts (user_id, enabled, created_at, updated_at) VALUES (?, 1, ?, ?)"
  )
    .bind(u.id, new Date().toISOString(), new Date().toISOString())
    .run()
  return u
}

/** 造一个指定鉴权方式的节点 */
async function makeNode(authMode: string): Promise<string> {
  const id = `node-${authMode}-${Math.random().toString(36).slice(2, 8)}`
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO frp_nodes
       (id, name, server_addr, server_port, auth_token, token_prefix,
        port_min, port_max, max_ports, enabled, sort_order, auth_mode, created_at, updated_at)
     VALUES (?, ?, 'frp.test', 7000, 'shared-secret', '', 20000, 20010, 5, 1, 0, ?, ?, ?)`
  )
    .bind(id, `节点-${authMode}`, authMode, now, now)
    .run()
  return id
}

function apply(u: { cookie: string }, nodeId: string, extra: Record<string, unknown> = {}) {
  return fetchSelf(
    authRequest(u, "/api/frp/apply", {
      method: "POST",
      body: JSON.stringify({ nodeId, ports: [20001], tunnels: [], ...extra }),
    })
  )
}

async function lastApp(userId: string) {
  return env.DB.prepare(
    "SELECT frp_user, frp_password FROM frp_applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1"
  )
    .bind(userId)
    .first<{ frp_user: string; frp_password: string }>()
}

describe("内网穿透申请：鉴权方式决定要不要账号密码", () => {
  beforeEach(async () => {
    // 关掉管理员通知邮件，避免测试真发信
    await setSetting("frp_admin_notify_email", "")
  })
  afterEach(async () => {
    await setSetting("frp_admin_notify_email", "")
  })

  it("全局 auth.token 的节点：不填账号密码也能申请，库里存空", async () => {
    const u = await frpUser()
    const nodeId = await makeNode("token")

    const res = await apply(u, nodeId)
    expect(res.status).toBe(201)

    const row = await lastApp(u.id)
    expect(row?.frp_password).toBe("")
  })

  it("无鉴权的节点：同样不需要账号密码", async () => {
    const u = await frpUser()
    const nodeId = await makeNode("none")

    expect((await apply(u, nodeId)).status).toBe(201)
    expect((await lastApp(u.id))?.frp_password).toBe("")
  })

  it("token_user 的节点：不填密码仍然拒绝（该模式的密码就是 metadatas.token）", async () => {
    const u = await frpUser()
    const nodeId = await makeNode("token_user")

    const res = await apply(u, nodeId)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe("WEAK_PASSWORD")
  })

  it("token_user 的节点：密码合法时正常受理并原样保存", async () => {
    const u = await frpUser()
    const nodeId = await makeNode("token_user")

    expect((await apply(u, nodeId, { frpPassword: "abc12345" })).status).toBe(201)
    expect((await lastApp(u.id))?.frp_password).toBe("abc12345")
  })

  it("免账号的节点：前端即使带上了密码也不会存（那是个用不到的凭据）", async () => {
    const u = await frpUser()
    const nodeId = await makeNode("token")

    expect((await apply(u, nodeId, { frpPassword: "will-be-dropped" })).status).toBe(201)
    expect((await lastApp(u.id))?.frp_password).toBe("")
  })

  it("账号名留空 → 回落到本站用户名（前端在免账号节点上会隐藏这个输入框）", async () => {
    const u = await frpUser()
    const nodeId = await makeNode("token")

    expect((await apply(u, nodeId, { frpUser: "" })).status).toBe(201)
    expect((await lastApp(u.id))?.frp_user).toBe(u.username)
  })

  it("自定义插件的节点（custom）：保守起见仍然要密码", async () => {
    const u = await frpUser()
    const nodeId = await makeNode("custom")

    const res = await apply(u, nodeId)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe("WEAK_PASSWORD")
  })
})
