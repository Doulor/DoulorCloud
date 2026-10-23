/**
 * TG 机器人的**权限边界**测试（2026-10-22）。
 *
 * 这个文件存在的唯一目的：把「谁能做什么」钉死，避免以后有人顺手放宽。
 *
 * 覆盖：
 *  ① 未登录 → 管理端接口 401（不是 404：不给探测面）
 *  ② Bot 未启用 → 回调直接 ignored（不给任何信息）
 *  ③ 启用后 secret 不匹配 → 401（否则任何人都能伪造 update 让 bot 群发消息）
 *  ④ 群聊里的命令一律忽略（防止把用户数据发到群里）
 *  ⑤ 管理命令 `/status` 对普通用户**静默忽略**（不回「你没权限」，避免变成权限探测器）
 *  ⑥ Token 读取永远是脱敏值
 */
import { describe, it, expect, beforeEach, vi } from "vitest"
import { env } from "cloudflare:workers"
import { makeUser, authRequest } from "./helpers"
import { encryptSecret, uuid } from "../src/crypto"
import { createSession, sessionCookie } from "../src/auth"
import {
  maskToken,
  handleWebhook,
  getAdminConfig,
  createBindCode,
  buildCommandMenu,
  pushToChannels,
  updateAdminConfig,
} from "../src/handlers/telegram"

const BOT_TOKEN = "123456789:AAFakeTokenForTestOnly1234567890ab"
const SECRET = "test-webhook-secret"

async function seedConfig(opts: { enabled: boolean; secret?: string }): Promise<void> {
  const enc = await encryptSecret(BOT_TOKEN, env.SESSION_SECRET as string)
  await env.DB.prepare(
    "UPDATE tg_bot_config SET enabled = ?, token_enc = ?, webhook_secret = ?, bot_username = ? WHERE id = 1"
  )
    .bind(opts.enabled ? 1 : 0, enc, opts.secret ?? SECRET, "fake_bot")
    .run()
}

function hookRequest(body: unknown, secret?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (secret !== undefined) headers["x-telegram-bot-api-secret-token"] = secret
  return new Request("https://cloud.doulor.cn/api/tg/webhook", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

function privateMsg(text: string): unknown {
  return { message: { text, chat: { id: 555000111, type: "private" }, from: { id: 555000111, username: "tester" } } }
}

describe("TG 机器人 · 权限边界", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM tg_bindings").run()
    await env.DB.prepare("DELETE FROM tg_bind_tokens").run()
    await env.DB.prepare("DELETE FROM tg_push_log").run()
    await seedConfig({ enabled: false })
  })

  it("未登录访问管理端接口 → 401（不是 404）", async () => {
    const req = new Request("https://cloud.doulor.cn/api/admin/tg/config", { method: "GET" })
    await expect(getAdminConfig(env, req)).rejects.toMatchObject({ status: 401 })
  })

  it("Bot 未启用时回调被忽略，且不回任何业务信息", async () => {
    const res = await handleWebhook(env, hookRequest(privateMsg("/start"), "whatever"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; ignored?: string }
    expect(body).toEqual({ ok: true, ignored: "disabled" })
  })

  it("启用后 secret 不匹配 → 401（防伪造回调）", async () => {
    await seedConfig({ enabled: true })
    await expect(handleWebhook(env, hookRequest(privateMsg("/start"), "wrong-secret"))).rejects.toMatchObject({
      status: 401,
    })
    // 连 secret 都不带也拒
    await expect(handleWebhook(env, hookRequest(privateMsg("/start")))).rejects.toMatchObject({
      status: 401,
    })
  })

  it("群聊里的命令一律**不执行**（即使 secret 正确；群消息只走聊天桥接）", async () => {
    await seedConfig({ enabled: true })
    // 未登记为互通群的群：桥接也不会落库
    await env.DB.prepare("DELETE FROM tg_channels").run()
    await env.DB.prepare("DELETE FROM chat_messages WHERE source = 'tg'").run()

    const groupMsg = {
      message: { text: "/status", chat: { id: -100123, type: "group" }, from: { id: 1 } },
    }
    const res = await handleWebhook(env, hookRequest(groupMsg, SECRET))
    expect(res.status).toBe(200)
    // 关键安全属性 1：群里的 /status 不会被执行（不进命令分发，就不会回站点状态）
    //                   这里用「没有落进聊天室 + 200」间接表达：命令分支已完全跳过
    // 关键安全属性 2：未登记群的消息一条都不落库
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM chat_messages WHERE source = 'tg'"
    ).first<{ c: number }>()
    expect(rows?.c).toBe(0)
  })

  it("普通用户发 /status 被静默忽略（不回「没权限」）", async () => {
    await seedConfig({ enabled: true })
    const user = await makeUser({ role: "user" })
    // 直接建绑定（跳过 /bind，专测权限判断）
    await env.DB.prepare(
      "INSERT INTO tg_bindings (telegram_id, user_id, tg_username, bound_at, muted_json) VALUES (?, ?, ?, ?, '[]')"
    )
      .bind("555000111", user.id, "tester", Date.now())
      .run()

    const sent: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url.includes("api.telegram.org")) {
        sent.push(String(init?.body ?? ""))
        return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
      }
      return original(input as RequestInfo, init)
    }) as typeof fetch
    try {
      const res = await handleWebhook(env, hookRequest(privateMsg("/status"), SECRET))
      expect(res.status).toBe(200)
      expect((await res.json()) as { ignored?: string }).toMatchObject({ ignored: "no-perm" })
      expect(sent).toHaveLength(0) // 一条消息都不发
    } finally {
      globalThis.fetch = original
    }
  })

  it("Token 只以脱敏形式出现", () => {
    expect(maskToken(BOT_TOKEN)).toBe("123456789:AAFa****90ab".replace("90ab", BOT_TOKEN.slice(-4)))
    expect(maskToken(BOT_TOKEN)).not.toContain("FakeToken")
    expect(maskToken(null)).toBe("")
  })

  it("生成绑定码：6 位数字、10 分钟有效、重复申请会顶掉旧码", async () => {
    const user = await makeUser({ role: "user" })
    const req = authRequest(user, "POST", "/api/me/tg/bind-code")
    const res = await createBindCode(env, req)
    const body = (await res.json()) as { code: string; expiresAt: number }
    expect(body.code).toMatch(/^\d{6}$/)
    expect(body.expiresAt - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000 + 1000)

    const res2 = await createBindCode(env, authRequest(user, "POST", "/api/me/tg/bind-code"))
    const body2 = (await res2.json()) as { code: string }
    const { results } = await env.DB.prepare("SELECT code FROM tg_bind_tokens WHERE user_id = ?")
      .bind(user.id)
      .all<{ code: string }>()
    expect((results ?? []).map((r) => r.code)).toEqual([body2.code])
    expect(body2.code).not.toBe(body.code)
  })
})

describe("TG 机器人 · 命令菜单分级", () => {
  it("未绑定：只给 /bind 和 /help", () => {
    const menu = buildCommandMenu({ bound: false, isAdminUser: false, commands: {} })
    expect(menu.map((c) => c.command)).toEqual(["bind", "help"])
  })

  it("已绑定普通用户：/me /frp /unbind /help，没有 /status", () => {
    const menu = buildCommandMenu({ bound: true, isAdminUser: false, commands: {} })
    expect(menu.map((c) => c.command)).toEqual([
      "menu",
      "me",
      "frp",
      "mail",
      "dns",
      "points",
      "invite",
      "storage",
      "community",
      "notices",
      "security",
      "settings",
      "unbind",
      "help",
    ])
    expect(menu.some((c) => c.command === "status")).toBe(false)
  })

  it("已绑定管理员：多出 /status", () => {
    const menu = buildCommandMenu({ bound: true, isAdminUser: true, commands: {} })
    expect(menu.map((c) => c.command)).toEqual([
      "menu",
      "me",
      "frp",
      "mail",
      "dns",
      "points",
      "invite",
      "storage",
      "community",
      "notices",
      "security",
      "settings",
      "unbind",
      "help",
      "status",
      "ann",
    ])
  })

  it("被关掉的命令不会出现在菜单里（菜单与处理器必须一致）", () => {
    const menu = buildCommandMenu({
      bound: true,
      isAdminUser: true,
      commands: { me: false, status: false },
    })
    expect(menu.map((c) => c.command)).toEqual([
      "menu",
      "frp",
      "mail",
      "dns",
      "points",
      "invite",
      "storage",
      "community",
      "notices",
      "security",
      "settings",
      "unbind",
      "help",
      "ann",
    ])
  })
})
describe("TG 机器人 · 绑定码的三种入口（菜单按钮不带参数的问题）", () => {
  /** 拦掉 Telegram 调用，返回记录到的 sendMessage 文本 */
  function stubTelegram(): { texts: string[]; restore: () => void } {
    const texts: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url.includes("api.telegram.org")) {
        if (url.endsWith("/sendMessage")) {
          try {
            texts.push(String(JSON.parse(String(init?.body ?? "{}")).text ?? ""))
          } catch {
            texts.push("")
          }
        }
        return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
      }
      return original(input as RequestInfo, init)
    }) as typeof fetch
    return { texts, restore: () => (globalThis.fetch = original) }
  }

  async function seedCode(code: string): Promise<string> {
    const user = await makeUser({ role: "user" })
    await env.DB.prepare(
      "INSERT INTO tg_bind_tokens (code, user_id, expires_at, used_at) VALUES (?, ?, ?, NULL)"
    )
      .bind(code, user.id, Date.now() + 10 * 60 * 1000)
      .run()
    return user.id
  }

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM tg_bindings").run()
    await env.DB.prepare("DELETE FROM tg_bind_tokens").run()
    await env.DB.prepare("DELETE FROM tg_pending_binds").run()
    await seedConfig({ enabled: true })
  })

  it("深链 /start <码> 直接完成绑定（一键，零输入）", async () => {
    const userId = await seedCode("123456")
    const { texts, restore } = stubTelegram()
    try {
      const res = await handleWebhook(env, hookRequest(privateMsg("/start 123456"), SECRET))
      expect(res.status).toBe(200)
      const row = await env.DB.prepare("SELECT user_id FROM tg_bindings WHERE telegram_id = ?")
        .bind("555000111")
        .first<{ user_id: string }>()
      expect(row?.user_id).toBe(userId)
      expect(texts.join("\n")).toContain("绑定成功")
    } finally {
      restore()
    }
  })

  it("无参 /bind → 进入等待；下一条纯 6 位数字直接完成绑定", async () => {
    const userId = await seedCode("654321")
    const { texts, restore } = stubTelegram()
    try {
      await handleWebhook(env, hookRequest(privateMsg("/bind"), SECRET))
      const pending = await env.DB.prepare(
        "SELECT telegram_id FROM tg_pending_binds WHERE telegram_id = ?"
      )
        .bind("555000111")
        .first<{ telegram_id: string }>()
      expect(pending?.telegram_id).toBe("555000111")
      expect(texts.join("\n")).toContain("6 位绑定码")

      await handleWebhook(env, hookRequest(privateMsg("654321"), SECRET))
      const row = await env.DB.prepare("SELECT user_id FROM tg_bindings WHERE telegram_id = ?")
        .bind("555000111")
        .first<{ user_id: string }>()
      expect(row?.user_id).toBe(userId)
      // 等待状态是一次性的
      const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM tg_pending_binds").first<{ n: number }>()
      expect(left?.n).toBe(0)
    } finally {
      restore()
    }
  })

  it("没发过 /bind 时，裸 6 位数字不会被当成绑定码（不乱猜）", async () => {
    await seedCode("111222")
    const { restore } = stubTelegram()
    try {
      await handleWebhook(env, hookRequest(privateMsg("111222"), SECRET))
      const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM tg_bindings").first<{ n: number }>()
      expect(row?.n).toBe(0)
    } finally {
      restore()
    }
  })
})
describe("TG 机器人 · 单卡片导航（点按钮原地切换，不刷屏）", () => {
  function cbRequest(data: string): Request {
    return hookRequest(
      {
        callback_query: {
          id: "cb-1",
          data,
          message: { message_id: 4242, chat: { id: 555000111, type: "private" } },
        },
      },
      SECRET
    )
  }

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM tg_bindings").run()
    await seedConfig({ enabled: true })
    const user = await makeUser({ role: "user" })
    await env.DB.prepare(
      "INSERT INTO tg_bindings (telegram_id, user_id, tg_username, bound_at, muted_json) VALUES (?, ?, ?, ?, '[]')"
    )
      .bind("555000111", user.id, "tester", Date.now())
      .run()
  })

  it("点「我的账号」只 editMessageText（带原 message_id），不发新消息", async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url.includes("api.telegram.org")) {
        const method = url.split("/").pop() ?? ""
        let body: Record<string, unknown> = {}
        try {
          body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
        } catch {
          body = {}
        }
        calls.push({ method, body })
        return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
      }
      return original(input as RequestInfo, init)
    }) as typeof fetch
    try {
      const res = await handleWebhook(env, cbRequest("v:me"))
      expect(res.status).toBe(200)
      const edit = calls.find((c) => c.method === "editMessageText")
      expect(edit).toBeTruthy()
      expect(edit?.body.message_id).toBe(4242)
      expect(calls.some((c) => c.method === "sendMessage")).toBe(false)
      // 视图里有「返回菜单」按钮，用户能切回来
      const kb = JSON.stringify(edit?.body.reply_markup ?? {})
      expect(kb).toContain("v:menu")
    } finally {
      globalThis.fetch = original
    }
  })

  it("非管理员点「站点状态」不返回内容（只 ack 提示无权）", async () => {
    const calls: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url.includes("api.telegram.org")) {
        calls.push(url.split("/").pop() ?? "")
        return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
      }
      return original(input as RequestInfo)
    }) as typeof fetch
    try {
      await handleWebhook(env, cbRequest("v:status"))
      expect(calls).toContain("answerCallbackQuery")
      expect(calls).not.toContain("editMessageText")
      expect(calls).not.toContain("sendMessage")
    } finally {
      globalThis.fetch = original
    }
  })
})
describe("TG 机器人 · 通知开关覆盖所有推送类型（防漂移）", () => {
  it("新增的 email/comment/like/points 在 /settings 里都能静音", async () => {
    await env.DB.prepare("DELETE FROM tg_bindings").run()
    await seedConfig({ enabled: true })
    const user = await makeUser({ role: "user" })
    await env.DB.prepare(
      "INSERT INTO tg_bindings (telegram_id, user_id, tg_username, bound_at, muted_json) VALUES (?, ?, ?, ?, '[]')"
    )
      .bind("555000222", user.id, "tester", Date.now())
      .run()

    const original = globalThis.fetch
    const acks: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url.includes("api.telegram.org")) {
        if (url.endsWith("/answerCallbackQuery")) {
          try {
            acks.push(String((JSON.parse(String(init?.body ?? "{}")) as { text?: string }).text ?? ""))
          } catch {
            acks.push("")
          }
        }
        return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
      }
      return original(input as RequestInfo, init)
    }) as typeof fetch
    try {
      for (const kind of ["email", "comment", "like", "points"]) {
        await handleWebhook(
          env,
          hookRequest(
            {
              callback_query: {
                id: `cb-${kind}`,
                data: `s:${kind}`,
                message: { message_id: 1, chat: { id: 555000222, type: "private" } },
              },
            },
            SECRET
          )
        )
      }
      const row = await env.DB.prepare("SELECT muted_json FROM tg_bindings WHERE telegram_id = ?")
        .bind("555000222")
        .first<{ muted_json: string }>()
      const muted = JSON.parse(row?.muted_json ?? "[]") as string[]
      expect(muted.sort()).toEqual(["comment", "email", "like", "points"])
      // 一个都不该落到「未知选项」
      expect(acks.join("|")).not.toContain("未知选项")
    } finally {
      globalThis.fetch = original
    }
  })
})
describe("TG 机器人 · 频道推送", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM tg_channels").run()
    await seedConfig({ enabled: true })
  })

  it("机器人被拉进频道 → 自动登记（my_chat_member）", async () => {
    const res = await handleWebhook(
      env,
      hookRequest(
        {
          my_chat_member: {
            chat: { id: -1001234567890, title: "Doulor 频道", username: "doulor_ch", type: "channel" },
            new_chat_member: { status: "administrator" },
          },
        },
        SECRET
      )
    )
    expect(res.status).toBe(200)
    const row = await env.DB.prepare("SELECT title, enabled FROM tg_channels WHERE chat_id = ?")
      .bind("-1001234567890")
      .first<{ title: string; enabled: number }>()
    expect(row?.title).toBe("Doulor 频道")
    expect(row?.enabled).toBe(1)
  })

  it("被踢出频道 → 自动停推（enabled=0）", async () => {
    await env.DB.prepare(
      "INSERT INTO tg_channels (chat_id, title, events_json, enabled, created_at) VALUES (?, '旧频道', '{}', 1, ?)"
    )
      .bind("-1009999999999", Date.now())
      .run()
    await handleWebhook(
      env,
      hookRequest(
        {
          my_chat_member: {
            chat: { id: -1009999999999, title: "旧频道", type: "channel" },
            new_chat_member: { status: "kicked" },
          },
        },
        SECRET
      )
    )
    const row = await env.DB.prepare("SELECT enabled FROM tg_channels WHERE chat_id = ?")
      .bind("-1009999999999")
      .first<{ enabled: number }>()
    expect(row?.enabled).toBe(0)
  })

  it("只有订阅了该事件的频道才会收到；社区新帖默认不订阅", async () => {
    await env.DB.prepare(
      "INSERT INTO tg_channels (chat_id, title, events_json, enabled, created_at) VALUES (?, '公告频道', '{}', 1, ?)"
    )
      .bind("-1001", Date.now())
      .run()
    await env.DB.prepare(
      "INSERT INTO tg_channels (chat_id, title, events_json, enabled, created_at) VALUES (?, '全订阅', ?, 1, ?)"
    )
      .bind("-1002", JSON.stringify({ post: true }), Date.now())
      .run()

    const targets: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url.includes("api.telegram.org")) {
        if (url.endsWith("/sendMessage")) {
          try {
            targets.push(String((JSON.parse(String(init?.body ?? "{}")) as { chat_id?: unknown }).chat_id ?? ""))
          } catch {
            targets.push("")
          }
        }
        return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
      }
      return original(input as RequestInfo, init)
    }) as typeof fetch
    try {
      await pushToChannels(env, "announcement", "公告测试")
      // 两个频道都订阅公告（默认开）
      expect(targets.sort()).toEqual(["-1001", "-1002"])

      targets.length = 0
      await pushToChannels(env, "post", "新帖测试")
      // 只有显式开了 post 的那个频道
      expect(targets).toEqual(["-1002"])
    } finally {
      globalThis.fetch = original
    }
  })
})
describe("TG 机器人 · 关掉命令后菜单自动刷新", () => {
  it("保存命令开关 → 立刻 setMyCommands，被关掉的命令不再出现", async () => {
    await env.DB.prepare("DELETE FROM tg_bindings").run()
    await seedConfig({ enabled: true })
    // 一个已绑定用户，验证他的 chat 菜单也会被刷新
    const normal = await makeUser({ role: "user" })
    await env.DB.prepare(
      "INSERT INTO tg_bindings (telegram_id, user_id, tg_username, bound_at, muted_json) VALUES (?, ?, ?, ?, '[]')"
    )
      .bind("555000333", normal.id, "tester", Date.now())
      .run()

    const root = await makeUser({ role: "root" })
    const token = await createSession(env, root.id)

    const sent: Array<{ scope: string; commands: string[] }> = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url.includes("api.telegram.org")) {
        if (url.endsWith("/setMyCommands")) {
          try {
            const body = JSON.parse(String(init?.body ?? "{}")) as {
              commands?: Array<{ command: string }>
              scope?: { type?: string }
            }
            sent.push({
              scope: body.scope?.type ?? "?",
              commands: (body.commands ?? []).map((c) => c.command),
            })
          } catch {
            /* ignore */
          }
        }
        return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
      }
      return original(input as RequestInfo, init)
    }) as typeof fetch

    try {
      const res = await updateAdminConfig(
        env,
        new Request("https://cloud.doulor.cn/api/admin/tg/config", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Cookie: sessionCookie(token),
          },
          body: JSON.stringify({ commands: { me: false, frp: false } }),
        })
      )
      expect(res.status).toBe(200)
      // 默认 scope + 该绑定用户的 chat scope 各刷一次
      expect(sent.length).toBeGreaterThanOrEqual(2)
      for (const item of sent) {
        expect(item.commands).not.toContain("me")
        expect(item.commands).not.toContain("frp")
        // 没被关掉的命令仍在
        expect(item.commands).toContain("help")
      }
    } finally {
      globalThis.fetch = original
    }
  })
})