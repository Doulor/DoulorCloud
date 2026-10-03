import { describe, it, expect } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest, fetchSelf } from "./helpers"

/**
 * 临时邮箱（2026-09-25 新增）。
 *
 * 它复用 mailboxes 表（只多一个 is_temp 标记），所以这里**走真实路由**验证，
 * 而不是单独调 handler —— 路由注册写错（例如被 `/mailbox/:id` 正则抢先匹配）
 * 是这类新增接口最常见的翻车方式，只有经过完整入口才能测出来。
 */
type TestUser = Awaited<ReturnType<typeof makeUser>>

const JSON_HEADERS = { "Content-Type": "application/json" }

function addMailbox(user: TestUser, localPart: string): Promise<Response> {
  return fetchSelf(
    authRequest(user, "/api/mailbox", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ localPart }),
    })
  )
}

function addTempMailbox(user: TestUser): Promise<Response> {
  return fetchSelf(authRequest(user, "/api/mailbox/temp", { method: "POST" }))
}

function refreshTempMailbox(user: TestUser, id: string): Promise<Response> {
  return fetchSelf(
    authRequest(user, `/api/mailbox/temp/${id}/refresh`, { method: "POST" })
  )
}

/** 直接读库，用来确认「旧地址是真的没了」而不是只在响应里没出现 */
async function mailboxRow(address: string) {
  return env.DB.prepare("SELECT * FROM mailboxes WHERE address = ?")
    .bind(address)
    .first<{ id: string; user_id: string; address: string; is_temp: number; forwarding_to: string | null }>()
}

async function insertMessage(mailboxId: string, subject: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO messages (id, mailbox_id, from_address, subject, text_body, read, received_at) VALUES (?, ?, ?, ?, ?, 0, ?)"
  )
    .bind(crypto.randomUUID(), mailboxId, "sender@example.com", subject, "正文", new Date().toISOString())
    .run()
}

describe("临时邮箱", () => {
  it("地址是 8 位随机前缀，且不含易混字符 l/o/0/1", async () => {
    const user = await makeUser()
    const res = await addTempMailbox(user)
    expect(res.status).toBe(201)

    const { mailbox } = await res.json<{
      mailbox: { address: string; isTemp: boolean; primary: boolean }
    }>()

    expect(mailbox.isTemp).toBe(true)
    // 随机地址不可能是主邮箱，所以不该被当成主邮箱（否则前端会禁止删除）
    expect(mailbox.primary).toBe(false)
    expect(mailbox.address.endsWith("@doulor.cn")).toBe(true)

    const local = mailbox.address.split("@")[0]
    expect(local).toHaveLength(8)
    // 字符集必须与后端 TEMP_ALPHABET 一致：剔除了 l / o / 0 / 1
    expect(local).toMatch(/^[abcdefghijkmnpqrstuvwxyz23456789]{8}$/)
  })

  // 每个 makeUser 都要跑一次 PBKDF2(100k)，全量并发执行时很容易顶破 5s 默认超时，
  // 所以这里显式放宽 —— 慢的是建用户，不是被测逻辑。
  it("不同用户生成的地址互不相同", async () => {
    const seen = new Set<string>()
    for (let i = 0; i < 5; i++) {
      const user = await makeUser()
      const res = await addTempMailbox(user)
      const { mailbox } = await res.json<{ mailbox: { address: string } }>()
      expect(seen.has(mailbox.address)).toBe(false)
      seen.add(mailbox.address)
    }
  }, 30000)

  it("临时邮箱不占用普通邮箱的 3 个额度", async () => {
    const user = await makeUser()

    for (const lp of ["aaa", "bbb", "ccc"]) {
      expect((await addMailbox(user, lp)).status).toBe(201)
    }
    // 第 4 个普通邮箱必须被拒
    const denied = await addMailbox(user, "ddd")
    expect(denied.status).toBe(400)
    expect((await denied.json<{ code: string }>()).code).toBe("LIMIT_REACHED")

    // 但临时邮箱仍然可以生成 —— 这就是「额度分开」的实际含义
    expect((await addTempMailbox(user)).status).toBe(201)
  })

  it("临时邮箱有自己的上限，占满后也不影响普通邮箱额度", async () => {
    const user = await makeUser()

    // 上限是 1：第二个就该被拒
    expect((await addTempMailbox(user)).status).toBe(201)
    const denied = await addTempMailbox(user)
    expect(denied.status).toBe(400)
    expect((await denied.json<{ code: string }>()).code).toBe("LIMIT_REACHED")

    // 反向验证：临时邮箱占满后，普通邮箱照样能建满 3 个
    for (const lp of ["x1", "x2", "x3"]) {
      expect((await addMailbox(user, lp)).status).toBe(201)
    }
  })

  it("列表接口返回独立的 tempLimit / tempUsed，且按标记分组正确", async () => {
    const user = await makeUser()
    expect((await addMailbox(user, "normal")).status).toBe(201)
    expect((await addTempMailbox(user)).status).toBe(201)

    const res = await fetchSelf(authRequest(user, "/api/mailbox"))
    expect(res.status).toBe(200)
    const data = await res.json<{
      limit: number
      tempLimit: number
      tempUsed: number
      mailboxes: { isTemp: boolean }[]
    }>()

    expect(data.limit).toBe(3)
    expect(data.tempLimit).toBe(1)
    expect(data.tempUsed).toBe(1)
    expect(data.mailboxes.filter((m) => m.isTemp)).toHaveLength(1)
    expect(data.mailboxes.filter((m) => !m.isTemp)).toHaveLength(1)
  })

  it("刷新会换一个新地址，旧地址连同它的邮件一起作废", async () => {
    const user = await makeUser()
    const created = await addTempMailbox(user)
    const old = (await created.json<{ mailbox: { id: string; address: string } }>()).mailbox

    // 模拟「已经用它收到验证码」
    await insertMessage(old.id, "验证码 123456")

    const res = await refreshTempMailbox(user, old.id)
    expect(res.status).toBe(201)
    const fresh = (await res.json<{ mailbox: { id: string; address: string; isTemp: boolean } }>()).mailbox

    expect(fresh.address).not.toBe(old.address)
    expect(fresh.isTemp).toBe(true)

    // 旧地址必须彻底消失（不能只是界面上看不到）
    expect(await mailboxRow(old.address)).toBeNull()
    const orphan = await env.DB.prepare("SELECT COUNT(*) c FROM messages WHERE mailbox_id = ?")
      .bind(old.id)
      .first<{ c: number }>()
    expect(orphan?.c).toBe(0)

    // 新地址确实落库、属于本人、且被标记为临时
    const row = await mailboxRow(fresh.address)
    expect(row?.is_temp).toBe(1)
    expect(row?.user_id).toBe(user.id)
  })

  it("刷新不会改变数量，因此不会撑破临时邮箱额度", async () => {
    const user = await makeUser()
    const created = await addTempMailbox(user)
    let currentId = (await created.json<{ mailbox: { id: string } }>()).mailbox.id

    // 刷到上限次数依然应该是 201（刷新是「删旧建新」，不是「新增」）。
    // 注意每次刷新都会换掉邮箱行，所以下一轮必须用**新 id**。
    for (let i = 0; i < 3; i++) {
      const res = await refreshTempMailbox(user, currentId)
      expect(res.status).toBe(201)
      currentId = (await res.json<{ mailbox: { id: string } }>()).mailbox.id
    }

    const count = await env.DB.prepare(
      "SELECT COUNT(*) c FROM mailboxes WHERE user_id = ? AND is_temp = 1"
    )
      .bind(user.id)
      .first<{ c: number }>()
    expect(count?.c).toBe(1)
  })

  it("普通邮箱不能被刷新", async () => {
    const user = await makeUser()
    const created = await addMailbox(user, "keeper")
    const mb = (await created.json<{ mailbox: { id: string } }>()).mailbox

    const res = await refreshTempMailbox(user, mb.id)
    expect(res.status).toBe(400)
    expect((await res.json<{ code: string }>()).code).toBe("NOT_TEMP_MAILBOX")
  })

  it("不能刷新别人的临时邮箱", async () => {
    const owner = await makeUser()
    const other = await makeUser()
    const created = await addTempMailbox(owner)
    const mb = (await created.json<{ mailbox: { id: string } }>()).mailbox

    // 404 而不是 403：不泄露「这个 id 存在」这一信息
    const res = await refreshTempMailbox(other, mb.id)
    expect(res.status).toBe(404)
  })

  it("临时邮箱默认不配置转发，也不会自动带上转发目标", async () => {
    const user = await makeUser()
    const created = await addTempMailbox(user)
    const mb = (await created.json<{ mailbox: { id: string; forwardingTo: string[] } }>()).mailbox

    expect(mb.forwardingTo).toEqual([])
    const row = await env.DB.prepare("SELECT forwarding_to FROM mailboxes WHERE id = ?")
      .bind(mb.id)
      .first<{ forwarding_to: string | null }>()
    // 必须是 NULL 而不是 "[]"：入站处理器按 JSON 解析，两者都不转发，
    // 但 NULL 才是「从未配置过」的语义，也是这里刻意保持的形态
    expect(row?.forwarding_to).toBeNull()
  })

  it("临时邮箱的收件箱可以正常读信", async () => {
    const user = await makeUser()
    const created = await addTempMailbox(user)
    const mb = (await created.json<{ mailbox: { id: string } }>()).mailbox

    await insertMessage(mb.id, "hi")

    const res = await fetchSelf(authRequest(user, `/api/mailbox/${mb.id}/messages`))
    expect(res.status).toBe(200)
    const data = await res.json<{ messages: { subject: string }[] }>()
    expect(data.messages).toHaveLength(1)
    expect(data.messages[0].subject).toBe("hi")
  })

  it("临时邮箱可以直接删除", async () => {
    const user = await makeUser()
    const created = await addTempMailbox(user)
    const mb = (await created.json<{ mailbox: { id: string; address: string } }>()).mailbox

    const res = await fetchSelf(
      authRequest(user, `/api/mailbox/${mb.id}`, { method: "DELETE" })
    )
    expect(res.status).toBe(204)
    expect(await mailboxRow(mb.address)).toBeNull()
  })
})
