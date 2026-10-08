/**
 * 管理面板 → 邮箱管理（2026-10-08 新增，与「子域名管理」同形态）。
 *
 * 验证：
 *   1. 列表跨用户可见，带归属、邮件统计与「主邮箱」标记
 *   2. 代建：正常创建；保留名被拒；与他人重名 409；不占用户的 3 个名额
 *   3. 改名：地址更新；与他人冲突被拒
 *   4. 转发：管理端免「已验证」检查直接生效；可清空
 *   5. 删除：邮件一并清掉（CASCADE）；主邮箱也能删
 *   6. 查看内容：列表 + 正文；**管理端读取不改变用户的已读状态**
 *   7. 权限：普通用户一律 403
 */
import { describe, expect, it } from "vitest"
import { env } from "cloudflare:workers"
import { authRequest, fetchSelf, makeUser } from "./helpers"
import { resetRootDomainCache } from "../src/root-domains"

type U = Awaited<ReturnType<typeof makeUser>>

/** 测试用的免权限根域（与子域名测试同用 tyu.me） */
async function ensureRootDomain(name = "tyu.me"): Promise<void> {
  const exists = await env.DB.prepare("SELECT name FROM root_domains WHERE name = ?")
    .bind(name)
    .first()
  if (!exists) {
    await env.DB.prepare(
      `INSERT INTO root_domains (name, zone_id, label, requires_feature, is_default, enabled, created_at)
       VALUES (?, NULL, NULL, NULL, 0, 1, ?)`
    )
      .bind(name, new Date().toISOString())
      .run()
    resetRootDomainCache()
  }
}

/** 直接落库建邮箱（地址全局唯一，测试间用随机后缀避免撞） */
async function seedMailbox(
  user: U,
  localPart: string,
  domain = "tyu.me",
  forwardingTo: string[] | null = null
): Promise<string> {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    "INSERT INTO mailboxes (id, user_id, address, forwarding_to, source, created_at) VALUES (?, ?, ?, ?, 'web', ?)"
  )
    .bind(id, user.id, `${localPart}@${domain}`, forwardingTo ? JSON.stringify(forwardingTo) : null, new Date().toISOString())
    .run()
  return id
}

async function seedMessage(
  mailboxId: string,
  opts: { read?: boolean; subject?: string; body?: string } = {}
): Promise<string> {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO messages (id, mailbox_id, from_address, subject, text_body, read, received_at)
     VALUES (?, ?, 'sender@example.com', ?, ?, ?, ?)`
  )
    .bind(
      id,
      mailboxId,
      opts.subject ?? "测试邮件",
      opts.body ?? "你好",
      opts.read ? 1 : 0,
      new Date().toISOString()
    )
    .run()
  return id
}

async function unreadInDb(messageId: string): Promise<number | null> {
  const row = await env.DB.prepare("SELECT read FROM messages WHERE id = ?")
    .bind(messageId)
    .first<{ read: number }>()
  return row?.read ?? null
}

function jsonInit(body: unknown, method = "POST"): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }
}

let seq = 0
function addr(prefix: string): string {
  seq += 1
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`
}

interface AdminBox {
  id: string
  address: string
  primary: boolean
  isTemp: boolean
  forwardingTo: { email: string; verified: boolean }[]
  messageCount: number
  unreadCount: number
  owner: { id: string; username: string; email: string; status: string }
}

describe("管理端 · 邮箱管理", () => {
  it("列表跨用户可见，带归属、邮件统计与主邮箱标记", async () => {
    await ensureRootDomain()
    const admin = await makeUser({ role: "superadmin" })
    const a = await makeUser({})
    const b = await makeUser({})
    // 主邮箱地址由注册域推导，直接用推导结果当地址，才能稳定断言 primary=true
    const { primaryAddressFor } = await import("../src/root-domains")
    const primaryA = await primaryAddressFor(env, a.id, a.username)
    const maPrimary = await seedMailbox(a, primaryA.split("@")[0], primaryA.split("@")[1])
    const maOther = await seedMailbox(a, addr("other"))
    await seedMailbox(b, addr("b-box"))
    await seedMessage(maPrimary, { read: false })
    await seedMessage(maOther, { read: true })

    const res = await fetchSelf(authRequest(admin, "/api/admin/mailboxes"))
    expect(res.status).toBe(200)
    const body = await res.json<{ mailboxes: AdminBox[]; total: number }>()
    const mine = body.mailboxes.find((m) => m.id === maPrimary)!
    const other = body.mailboxes.find((m) => m.id === maOther)!
    const notMine = body.mailboxes.find((m) => m.owner.id === b.id)!
    expect(mine).toBeTruthy()
    expect(mine.owner.username).toBe(a.username)
    expect(mine.primary).toBe(true)
    expect(mine.messageCount).toBe(1)
    expect(mine.unreadCount).toBe(1)
    expect(other.primary).toBe(false)
    expect(other.messageCount).toBe(1)
    expect(other.unreadCount).toBe(0)
    expect(notMine.owner.username).toBe(b.username)
  })

  it("代建：正常创建；保留名被拒；与他人重名 409；不占用户的 3 个名额", async () => {
    await ensureRootDomain()
    const admin = await makeUser({ role: "superadmin" })
    const owner = await makeUser({})
    // 先占满 3 个名额（用户侧上限）
    for (let i = 0; i < 3; i++) await seedMailbox(owner, addr("quota"))

    const ok = await fetchSelf(
      authRequest(
        admin,
        "/api/admin/mailboxes",
        jsonInit({ userId: owner.id, localPart: addr("adm"), domain: "tyu.me" })
      )
    )
    expect(ok.status).toBe(201)
    const body = await ok.json<{ mailbox: AdminBox }>()
    expect(body.mailbox.source).toBe("admin")
    expect(body.mailbox.address.endsWith("@tyu.me")).toBe(true)

    // 保留名（www 是平台基础设施名）
    const reserved = await fetchSelf(
      authRequest(
        admin,
        "/api/admin/mailboxes",
        jsonInit({ userId: owner.id, localPart: "www", domain: "tyu.me" })
      )
    )
    expect(reserved.status).toBe(400)

    // 与已有地址冲突（大小写不敏感）
    const clash = await fetchSelf(
      authRequest(
        admin,
        "/api/admin/mailboxes",
        jsonInit({
          userId: owner.id,
          localPart: body.mailbox.address.split("@")[0].toUpperCase(),
          domain: "tyu.me",
        })
      )
    )
    expect(clash.status).toBe(409)
  })

  it("改名：地址更新；与他人冲突被拒", async () => {
    await ensureRootDomain()
    const admin = await makeUser({ role: "superadmin" })
    const owner = await makeUser({})
    const other = await makeUser({})
    const mine = await seedMailbox(owner, addr("rename"))
    const theirs = await seedMailbox(other, addr("clash-target"))

    // 改成合法新地址
    const ok = await fetchSelf(
      authRequest(
        admin,
        `/api/admin/mailboxes/${mine}`,
        jsonInit({ localPart: addr("renamed"), domain: "tyu.me" }, "PUT")
      )
    )
    expect(ok.status).toBe(200)
    const row = await env.DB.prepare("SELECT address FROM mailboxes WHERE id = ?")
      .bind(mine)
      .first<{ address: string }>()
    expect(row?.address.startsWith("renamed-")).toBe(true)

    // 改成别人已占用的地址 → 409（地址比对大小写不敏感）
    const theirsRow = await env.DB.prepare("SELECT address FROM mailboxes WHERE id = ?")
      .bind(theirs)
      .first<{ address: string }>()
    const clash = await fetchSelf(
      authRequest(
        admin,
        `/api/admin/mailboxes/${mine}`,
        jsonInit(
          { localPart: theirsRow!.address.split("@")[0].toUpperCase(), domain: "tyu.me" },
          "PUT"
        )
      )
    )
    expect(clash.status).toBe(409)
  })

  it("转发：管理端免「已验证」检查直接生效；可清空", async () => {
    await ensureRootDomain()
    const admin = await makeUser({ role: "superadmin" })
    const owner = await makeUser({})
    // 该用户没有任何已验证目标 —— 用户侧这样设必被拒，管理端允许
    const mb = await seedMailbox(owner, addr("fwd"))

    const set = await fetchSelf(
      authRequest(
        admin,
        `/api/admin/mailboxes/${mb}`,
        jsonInit({ forwardingTo: ["someone@example.com"] }, "PUT")
      )
    )
    expect(set.status).toBe(200)
    const row = await env.DB.prepare("SELECT forwarding_to FROM mailboxes WHERE id = ?")
      .bind(mb)
      .first<{ forwarding_to: string | null }>()
    expect(JSON.parse(row?.forwarding_to ?? "[]")).toEqual(["someone@example.com"])

    const clear = await fetchSelf(
      authRequest(admin, `/api/admin/mailboxes/${mb}`, jsonInit({ forwardingTo: [] }, "PUT"))
    )
    expect(clear.status).toBe(200)
    const after = await env.DB.prepare("SELECT forwarding_to FROM mailboxes WHERE id = ?")
      .bind(mb)
      .first<{ forwarding_to: string | null }>()
    expect(after?.forwarding_to).toBeNull()
  })

  it("删除：邮件一并清掉；主邮箱也能删", async () => {
    await ensureRootDomain()
    const admin = await makeUser({ role: "superadmin" })
    const owner = await makeUser({})
    const { primaryAddressFor } = await import("../src/root-domains")
    const primary = await primaryAddressFor(env, owner.id, owner.username)
    const local = primary.split("@")[0]
    const domain = primary.split("@")[1]
    const mb = await seedMailbox(owner, local, domain)
    await seedMessage(mb)
    await seedMessage(mb)

    const res = await fetchSelf(
      authRequest(admin, `/api/admin/mailboxes/${mb}`, { method: "DELETE" })
    )
    expect(res.status).toBe(200)
    const gone = await env.DB.prepare("SELECT id FROM mailboxes WHERE id = ?").bind(mb).first()
    expect(gone).toBeNull()
    const mails = await env.DB.prepare("SELECT COUNT(*) AS c FROM messages WHERE mailbox_id = ?")
      .bind(mb)
      .first<{ c: number }>()
    expect(Number(mails?.c ?? 0)).toBe(0)
  })

  it("查看内容：列表 + 正文；读取不改用户的已读状态", async () => {
    await ensureRootDomain()
    const admin = await makeUser({ role: "superadmin" })
    const owner = await makeUser({})
    const mb = await seedMailbox(owner, addr("read"))
    const unread = await seedMessage(mb, { read: false, subject: "看看我", body: "正文内容" })
    await seedMessage(mb, { read: true })

    const list = await fetchSelf(authRequest(admin, `/api/admin/mailboxes/${mb}/messages`))
    expect(list.status).toBe(200)
    const listBody = await list.json<{
      mailbox: { address: string }
      messages: { id: string; subject: string; read: boolean }[]
    }>()
    expect(listBody.mailbox.address.endsWith("@tyu.me")).toBe(true)
    expect(listBody.messages).toHaveLength(2)
    expect(listBody.messages.every((m) => typeof m.subject === "string")).toBe(true)

    const detail = await fetchSelf(
      authRequest(admin, `/api/admin/mailboxes/${mb}/messages/${unread}`)
    )
    expect(detail.status).toBe(200)
    const detailBody = await detail.json<{ message: { textBody: string; read: boolean } }>()
    expect(detailBody.message.textBody).toBe("正文内容")
    expect(detailBody.message.read).toBe(false)
    // 关键断言：管理端读取**不会**把用户的未读邮件改成已读
    expect(await unreadInDb(unread)).toBe(0)
  })

  it("权限：普通用户一律 403", async () => {
    const user = await makeUser({})
    const res = await fetchSelf(authRequest(user, "/api/admin/mailboxes"))
    expect(res.status).toBe(403)
    const del = await fetchSelf(
      authRequest(user, "/api/admin/mailboxes/whatever", { method: "DELETE" })
    )
    expect(del.status).toBe(403)
  })
})
