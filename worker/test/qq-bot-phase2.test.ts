// QQ 机器人二期测试（2026-10-24）
//
// 覆盖：私聊绑定、群开关事件、好友欢迎、按钮签到。
// 所有出站请求都打桩 —— 测试不能真的往 QQ 发消息。
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { env } from "cloudflare:workers"
import { handleQqWebhook } from "../src/handlers/qq"
import { encryptSecret } from "../src/crypto"
import { makeUser } from "./helpers"

const SECRET = "b9YllZAYjhRyIPK1"
const GROUP = "GROUP_OPENID_TEST_AAA"
const C2C_USER = "C2C_USER_OPENID_1"

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

  // QQ 开放接口全部打桩：统一返回 ok
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    sent.push({ url, body: String(init?.body ?? "") })
    if (url.includes("/app/getAppAccessToken")) {
      return new Response(JSON.stringify({ access_token: "FAKE_TOKEN", expires_in: "7200" }), { status: 200 })
    }
    return new Response(JSON.stringify({ id: "MSG_OK" }), { status: 200 })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function hook(body: unknown): Request {
  return new Request("https://cloud.doulor.cn/api/qq/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function c2c(content: string): unknown {
  return {
    op: 0,
    t: "C2C_MESSAGE_CREATE",
    id: "EV_C2C",
    d: { id: "C2C_MSG_1", content, author: { user_openid: C2C_USER }, timestamp: new Date().toISOString() },
  }
}

describe("QQ 二期 · 私聊", () => {
  it("未绑定时提示去绑，而不是报错", async () => {
    await handleQqWebhook(env, hook(c2c("/积分")))
    expect(sent.some((s) => s.url.includes(`/v2/users/${C2C_USER}/messages`))).toBe(true)
    expect(sent.at(-1)?.body).toContain("还没绑定")
  })

  it("/bind <码> 成功绑定（复用站内一次性绑定码）", async () => {
    const user = await makeUser({ username: "qq_bind_user" })
    const code = "135790"
    await env.DB.prepare(
      "INSERT INTO tg_bind_tokens (code, user_id, expires_at, used_at) VALUES (?, ?, ?, NULL)"
    )
      .bind(code, user.id, Date.now() + 600_000)
      .run()

    await handleQqWebhook(env, hook(c2c(`/bind ${code}`)))
    const row = await env.DB.prepare("SELECT user_id FROM qq_bindings WHERE qq_openid = ?")
      .bind(`c2c:${C2C_USER}`)
      .first<{ user_id: string }>()
    expect(row?.user_id).toBe(user.id)
    // 一次性：用完即作废
    const token = await env.DB.prepare("SELECT used_at FROM tg_bind_tokens WHERE code = ?")
      .bind(code)
      .first<{ used_at: number | null }>()
    expect(token?.used_at).not.toBeNull()
  })

  it("/签到 返回带按钮的卡片", async () => {
    const user = await makeUser({ username: "qq_checkin_user" })
    await env.DB.prepare("INSERT INTO qq_bindings (qq_openid, user_id, bound_at) VALUES (?, ?, ?)")
      .bind(`c2c:${C2C_USER}`, user.id, Date.now())
      .run()

    await handleQqWebhook(env, hook(c2c("/签到")))
    const last = sent.at(-1)
    expect(last?.body).toContain("签到")
    // 键盘组件里应该有回调按钮（type:1）+ 跳转按钮（type:0）
    expect(last?.body).toContain('"type":1')
    expect(last?.body).toContain("checkin_now")
  })
})

describe("QQ 二期 · 群开关事件", () => {
  it("GROUP_MSG_REJECT / GROUP_DEL_ROBOT → 自动停用该群", async () => {
    await handleQqWebhook(env, hook({ op: 0, t: "GROUP_MSG_REJECT", id: "E1", d: { group_openid: GROUP } }))
    let row = await env.DB.prepare("SELECT enabled FROM qq_channels WHERE group_openid = ?").bind(GROUP).first<{ enabled: number }>()
    expect(row?.enabled).toBe(0)

    await handleQqWebhook(env, hook({ op: 0, t: "GROUP_MSG_RECEIVE", id: "E2", d: { group_openid: GROUP } }))
    row = await env.DB.prepare("SELECT enabled FROM qq_channels WHERE group_openid = ?").bind(GROUP).first<{ enabled: number }>()
    expect(row?.enabled).toBe(1)
  })
})

describe("QQ 二期 · 好友与按钮", () => {
  it("FRIEND_ADD → 发欢迎语并引导 /bind", async () => {
    await handleQqWebhook(env, hook({ op: 0, t: "FRIEND_ADD", id: "E3", d: { openid: C2C_USER } }))
    const last = sent.at(-1)
    expect(last?.url).toContain(`/v2/users/${C2C_USER}/messages`)
    expect(last?.body).toContain("/bind")
  })

  it("按钮回调 checkin → 真正签到（与站内同一套逻辑）", async () => {
    const user = await makeUser({ username: "qq_btn_checkin" })
    await env.DB.prepare("INSERT INTO qq_bindings (qq_openid, user_id, bound_at) VALUES (?, ?, ?)")
      .bind(`c2c:${C2C_USER}`, user.id, Date.now())
      .run()

    await handleQqWebhook(
      env,
      hook({
        op: 0,
        t: "INTERACTION_CREATE",
        id: "E4",
        d: {
          id: "INTER_1",
          user_openid: C2C_USER,
          data: { type: 11, resolved: { button_id: "checkin_now", button_data: "checkin" } },
        },
      })
    )
    const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM daily_checkins WHERE user_id = ?")
      .bind(user.id)
      .first<{ c: number }>()
    expect(row?.c).toBe(1)
  })
})
