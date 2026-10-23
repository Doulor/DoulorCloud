// QQ 群里 /bind 的测试（2026-10-24）
//
// QQ 的身份标识分作用域：群里是 member_openid（按群隔离），私聊是 user_openid。
// 所以绑定 key 带前缀 `group:` / `c2c:`，这里钉住这条规则不会串。
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { handleQqWebhook } from "../src/handlers/qq"
import { encryptSecret } from "../src/crypto"
import { makeUser } from "./helpers"

const SECRET = "b9YllZAYjhRyIPK1"
const GROUP = "GROUP_OPENID_TEST_AAA"
const MEMBER = "MEMBER_OPENID_X"

const sent: Array<{ url: string; body: string }> = []

beforeEach(async () => {
  sent.length = 0
  const enc = await encryptSecret(SECRET, env.SESSION_SECRET as string)
  await env.DB.prepare(
    `INSERT INTO qq_bot_config (id, enabled, app_id, secret_enc, created_at, updated_at)
     VALUES (1, 1, '1905911344', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET enabled = 1, secret_enc = excluded.secret_enc`
  )
    .bind(enc, Date.now(), Date.now())
    .run()
  await env.DB.prepare("DELETE FROM qq_channels").run()
  await env.DB.prepare(
    "INSERT INTO qq_channels (group_openid, title, enabled, created_at) VALUES (?, NULL, 1, ?)"
  )
    .bind(GROUP, Date.now())
    .run()
  await env.DB.prepare("DELETE FROM qq_bindings").run()
  await env.DB.prepare("DELETE FROM chat_messages WHERE source = 'qq'").run()
  await env.DB.prepare("DELETE FROM users WHERE role = 'guest'").run()

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    sent.push({ url, body: String(init?.body ?? "") })
    if (url.includes("/app/getAppAccessToken")) {
      return new Response(JSON.stringify({ access_token: "T", expires_in: "7200" }), { status: 200 })
    }
    return new Response(JSON.stringify({ id: "OK" }), { status: 200 })
  })
})

afterEach(() => vi.unstubAllGlobals())

function groupMsg(content: string, msgId = "G_MSG_1"): Request {
  return new Request("https://cloud.doulor.cn/api/qq/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      op: 0,
      t: "GROUP_MESSAGE_CREATE",
      id: "EV_G",
      d: {
        id: msgId,
        content,
        group_openid: GROUP,
        author: { member_openid: MEMBER },
        timestamp: new Date().toISOString(),
      },
    }),
  })
}

describe("QQ 群内 /bind", () => {
  it("群里 /bind <码> 绑定成功，并在群里被动回复确认", async () => {
    const user = await makeUser({ username: "group_bind_qq" })
    const code = "654321"
    await env.DB.prepare(
      "INSERT INTO tg_bind_tokens (code, user_id, expires_at, used_at) VALUES (?, ?, ?, NULL)"
    )
      .bind(code, user.id, Date.now() + 600_000)
      .run()

    await handleQqWebhook(env, groupMsg(`/bind ${code}`, "GB_1"))

    // 绑定 key 带 group: 前缀
    const row = await env.DB.prepare("SELECT user_id FROM qq_bindings WHERE qq_openid = ?")
      .bind(`group:${MEMBER}`)
      .first<{ user_id: string }>()
    expect(row?.user_id).toBe(user.id)

    // 群内回复（被动消息，带 msg_id）
    const reply = sent.find((s) => s.url.includes(`/v2/groups/${GROUP}/messages`))
    expect(reply?.body).toContain("绑定成功")
    expect(reply?.body).toContain('"msg_id"')
    // 回复里不能出现账号信息
    expect(reply?.body).not.toContain("group_bind_qq")
  })

  it("绑定后群里的普通发言记到本人名下（不再建影子账号）", async () => {
    const user = await makeUser({ username: "group_owner_user" })
    const code = "112233"
    await env.DB.prepare(
      "INSERT INTO tg_bind_tokens (code, user_id, expires_at, used_at) VALUES (?, ?, ?, NULL)"
    )
      .bind(code, user.id, Date.now() + 600_000)
      .run()
    await handleQqWebhook(env, groupMsg(`/bind ${code}`, "GB_2"))
    await handleQqWebhook(env, groupMsg("绑定之后说的话", "GB_3"))

    const rows = await env.DB.prepare(
      "SELECT user_id, body FROM chat_messages WHERE source = 'qq' ORDER BY created_at DESC"
    ).all<{ user_id: string; body: string }>()
    expect(rows.results?.[0]?.user_id).toBe(user.id)
    expect(rows.results?.[0]?.body).toBe("绑定之后说的话")
    // 不应为已绑定成员建影子账号
    const shadow = await env.DB.prepare("SELECT COUNT(*) AS c FROM users WHERE qq_shadow_id = ?")
      .bind(MEMBER)
      .first<{ c: number }>()
    expect(shadow?.c).toBe(0)
  })

  it("中文写法「绑定 123456」也能绑（QQ 群不认斜杠命令）", async () => {
    const user = await makeUser({ username: "cn_bind_user" })
    const code = "778899"
    await env.DB.prepare(
      "INSERT INTO tg_bind_tokens (code, user_id, expires_at, used_at) VALUES (?, ?, ?, NULL)"
    )
      .bind(code, user.id, Date.now() + 600_000)
      .run()
    await handleQqWebhook(env, groupMsg(`绑定 ${code}`, "GB_CN"))
    const row = await env.DB.prepare("SELECT user_id FROM qq_bindings WHERE qq_openid = ?")
      .bind(`group:${MEMBER}`)
      .first<{ user_id: string }>()
    expect(row?.user_id).toBe(user.id)
  })

  it("无效码 → 群里回「无效或已过期」", async () => {
    await handleQqWebhook(env, groupMsg("/bind 999999", "GB_4"))
    const reply = sent.find((s) => s.url.includes(`/v2/groups/${GROUP}/messages`))
    expect(reply?.body).toContain("无效或已过期")
    const n = await env.DB.prepare("SELECT COUNT(*) AS c FROM qq_bindings").first<{ c: number }>()
    expect(n?.c).toBe(0)
  })

  it("群里的其它命令仍然不桥接、也不执行", async () => {
    await handleQqWebhook(env, groupMsg("/积分", "GB_5"))
    const rows = await env.DB.prepare("SELECT COUNT(*) AS c FROM chat_messages WHERE source='qq'").first<{
      c: number
    }>()
    expect(rows?.c).toBe(0)
  })
})
