// TG 群 → 站内聊天室 桥接测试（2026-10-24，方案 B）
//
// 这一组把「群消息能不能进站内」的边界钉死：
//   ① 白名单群 + 未绑定成员 → 建影子账号（role='guest'）并落库
//   ② 已绑定成员 → 落到本人头上
//   ③ 非白名单群 / bot 自己发的 → 一条都不落库（防回声）
//   ④ 图片消息 → 正文带 [图片] 与服务端中转链接（不暴露 bot token）
//   ⑤ 影子账号不能登录
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { handleWebhook } from "../src/handlers/telegram"
import { login } from "../src/handlers/auth"
import { pushMessage, tgSafeText, splitOutgoing } from "../src/handlers/telegram"
import { makeUser } from "./helpers"
import { encryptSecret } from "../src/crypto"

const SECRET = "test-webhook-secret"
const BOT_TOKEN = "8599825025:AAFLFRGhijhdi4NPUjSbfmZWN6HfvZERDUU"
const GROUP_ID = -1004424749412

async function seedConfig(): Promise<void> {
  const enc = await encryptSecret(BOT_TOKEN, env.SESSION_SECRET as string)
  await env.DB.prepare(
    "UPDATE tg_bot_config SET enabled = 1, token_enc = ?, webhook_secret = ?, bot_username = ? WHERE id = 1"
  )
    .bind(enc, SECRET, "fake_bot")
    .run()
}

async function seedGroup(enabled = 1): Promise<void> {
  await env.DB.prepare("DELETE FROM tg_channels").run()
  await env.DB.prepare(
    "INSERT INTO tg_channels (chat_id, title, username, events_json, enabled, created_at, kind) VALUES (?, '测试群', 'testgroup', '{}', ?, ?, 'group')"
  )
    .bind(String(GROUP_ID), enabled, Date.now())
    .run()
}

function groupMsg(opts: {
  text?: string
  caption?: string
  photo?: boolean
  fromId?: number
  username?: string
  isBot?: boolean
  messageId?: number
}): unknown {
  const from = { id: opts.fromId ?? 700000001, username: opts.username ?? "gmember", is_bot: opts.isBot ?? false }
  return {
    message: {
      message_id: opts.messageId ?? 9001,
      text: opts.text,
      caption: opts.caption,
      ...(opts.photo
        ? { photo: [{ file_id: "small_FILEID_111", file_size: 100 }, { file_id: "big_FILEID_222", file_size: 900 }] }
        : {}),
      from,
      chat: { id: GROUP_ID, type: "supergroup", title: "测试群" },
    },
  }
}

function hook(body: unknown): Request {
  return new Request("https://cloud.doulor.cn/api/tg/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
    body: JSON.stringify(body),
  })
}

async function chatRows(): Promise<Array<{ user_id: string; body: string; source: string; tg_message_id: string | null }>> {
  const { results } = await env.DB.prepare(
    "SELECT user_id, body, source, tg_message_id FROM chat_messages WHERE source = 'tg' ORDER BY created_at DESC"
  ).all<{ user_id: string; body: string; source: string; tg_message_id: string | null }>()
  return results ?? []
}

describe("TG 群 → 站内聊天室", () => {
  beforeEach(async () => {
    await seedConfig()
    await seedGroup()
    await env.DB.prepare("DELETE FROM tg_bindings").run()
    await env.DB.prepare("DELETE FROM chat_messages WHERE source = 'tg'").run()
    await env.DB.prepare("DELETE FROM users WHERE role = 'guest'").run()
  })

  it("未绑定成员发言 → 自动建影子账号并落库（role='guest'）", async () => {
    const res = await handleWebhook(env, hook(groupMsg({ text: "群里说句话", fromId: 700000123 })))
    expect(res.status).toBe(200)

    const rows = await chatRows()
    expect(rows.length).toBe(1)
    expect(rows[0].body).toBe("群里说句话")
    expect(rows[0].tg_message_id).toBe("9001")

    const guest = await env.DB.prepare("SELECT id, role, nickname, username FROM users WHERE tg_shadow_id = ?")
      .bind("700000123")
      .first<{ id: string; role: string; nickname: string; username: string }>()
    expect(guest?.role).toBe("guest")
    expect(guest?.username).toBe("tg_700000123")
    expect(guest?.nickname).toContain("TG:")
    expect(rows[0].user_id).toBe(guest?.id)
  })

  it("同一个人连发两条 → 复用同一个影子账号（不会重复建号）", async () => {
    await handleWebhook(env, hook(groupMsg({ text: "第一条", fromId: 700000200, messageId: 1 })))
    await handleWebhook(env, hook(groupMsg({ text: "第二条", fromId: 700000200, messageId: 2 })))
    const n = await env.DB.prepare("SELECT COUNT(*) AS c FROM users WHERE tg_shadow_id = ?")
      .bind("700000200")
      .first<{ c: number }>()
    expect(n?.c).toBe(1)
    expect((await chatRows()).length).toBe(2)
  })

  it("已绑定成员发言 → 落到站内本人头上", async () => {
    const user = await makeUser({ username: "bound_user" })
    await env.DB.prepare(
      "INSERT INTO tg_bindings (telegram_id, user_id, tg_username, bound_at, muted_json) VALUES (?, ?, ?, ?, '[]')"
    )
      .bind("700000300", user.id, "bound_user", Date.now())
      .run()

    await handleWebhook(env, hook(groupMsg({ text: "绑定了的人", fromId: 700000300 })))
    const rows = await chatRows()
    expect(rows[0].user_id).toBe(user.id)
    // 不应为已绑定用户建影子账号
    const shadow = await env.DB.prepare("SELECT COUNT(*) AS c FROM users WHERE tg_shadow_id = ?")
      .bind("700000300")
      .first<{ c: number }>()
    expect(shadow?.c).toBe(0)
  })

  it("非白名单群 / 群已停用 → 一条都不落库", async () => {
    await seedGroup(0)
    await handleWebhook(env, hook(groupMsg({ text: "不该进来的", fromId: 700000400 })))
    expect((await chatRows()).length).toBe(0)
  })

  it("bot 自己发的消息（防回声）→ 不落库", async () => {
    await handleWebhook(env, hook(groupMsg({ text: "我是机器人", fromId: 555, isBot: true })))
    expect((await chatRows()).length).toBe(0)
  })

  it("图片消息 → 正文是 markdown 图片（站内直接显示图），且不暴露 bot token", async () => {
    await handleWebhook(env, hook(groupMsg({ caption: "看这张", photo: true, fromId: 700000500 })))
    const rows = await chatRows()
    expect(rows.length).toBe(1)
    // 站内聊天室渲染 markdown 图片；取分辨率最大那张，走站内中转路径
    expect(rows[0].body).toContain("![](/api/tg/file/big_FILEID_222)")
    expect(rows[0].body).toContain("看这张")
    expect(rows[0].body).not.toContain("api.telegram.org")
    expect(rows[0].body).not.toContain(BOT_TOKEN)
  })

  it("贴纸消息 → 用 webp 缩略图（原文件是 webm，<img> 渲染不了）", async () => {
    const stickerMsg = {
      message: {
        message_id: 9100,
        sticker: {
          file_id: "STICKER_WEBM_ID_123",
          emoji: "👍",
          is_video: true,
          thumb: { file_id: "STICKER_THUMB_WEBP_456" },
        },
        from: { id: 700000700, is_bot: false, username: "stickerfan" },
        chat: { id: GROUP_ID, type: "supergroup" },
      },
    }
    await handleWebhook(env, hook(stickerMsg))
    const rows = await chatRows()
    expect(rows.length).toBe(1)
    // 用缩略图，不用 webm 原文件
    expect(rows[0].body).toContain("![](/api/tg/file/STICKER_THUMB_WEBP_456)")
    expect(rows[0].body).not.toContain("STICKER_WEBM_ID_123")
    expect(rows[0].body).toContain("👍")
  })

  it("贴纸没有缩略图 → 退化成文字，不放破图", async () => {
    const stickerMsg = {
      message: {
        message_id: 9101,
        sticker: { file_id: "OLD_STICKER_NO_THUMB", emoji: "🎉", is_animated: true },
        from: { id: 700000701, is_bot: false, username: "oldsticker" },
        chat: { id: GROUP_ID, type: "supergroup" },
      },
    }
    await handleWebhook(env, hook(stickerMsg))
    const rows = await chatRows()
    expect(rows.length).toBe(1)
    expect(rows[0].body).not.toContain("![](")
    expect(rows[0].body).toContain("动态贴纸")
    expect(rows[0].body).toContain("/api/tg/file/OLD_STICKER_NO_THUMB")
  })

  it("群里的机器人命令 / 绑定码**不桥接**进站内（隐私）", async () => {
    // 线上事故复现：有人在群里发 /bind 1111，绑定码被写进了公开聊天室
    await handleWebhook(env, hook(groupMsg({ text: "/bind 1111", fromId: 700000800, messageId: 9101 })))
    await handleWebhook(env, hook(groupMsg({ text: "123456", fromId: 700000801, messageId: 9102 })))
    expect((await chatRows()).length).toBe(0)
  })

  it("群里 /bind <码> 能绑定，但绑定码绝不进聊天室", async () => {
    const user = await makeUser({ username: "group_bind_user" })
    const code = "246810"
    await env.DB.prepare(
      "INSERT INTO tg_bind_tokens (code, user_id, expires_at, used_at) VALUES (?, ?, ?, NULL)"
    )
      .bind(code, user.id, Date.now() + 10 * 60 * 1000)
      .run()

    await handleWebhook(env, hook(groupMsg({ text: `/bind ${code}`, fromId: 700000900, messageId: 9201 })))

    // 绑定成功
    const bound = await env.DB.prepare("SELECT user_id FROM tg_bindings WHERE telegram_id = ?")
      .bind("700000900")
      .first<{ user_id: string }>()
    expect(bound?.user_id).toBe(user.id)
    // 一次性：用过即置 used_at
    const token = await env.DB.prepare("SELECT used_at FROM tg_bind_tokens WHERE code = ?")
      .bind(code)
      .first<{ used_at: number | null }>()
    expect(token?.used_at).not.toBeNull()
    // 绑定码不进聊天室
    expect((await chatRows()).length).toBe(0)
  })

  it("影子账号不能登录（显式 403，不依赖『没有密码』这个隐性条件）", async () => {
    await handleWebhook(env, hook(groupMsg({ text: "先建号", fromId: 700000600 })))
    // login() 走的是 ApiError（统一错误处理在路由层转成 403 JSON），
    // 所以这里断言的是 reject 的 status/code，而不是 Response。
    await expect(
      login(
        env,
        new Request("https://cloud.doulor.cn/api/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ identifier: "tg_700000600", password: "whatever" }),
        })
      )
    ).rejects.toMatchObject({ status: 403, code: "GUEST_NO_LOGIN" })
  })
})

describe("站内 → TG 的正文改写（tgSafeText）", () => {
  it("站内表情包（相对地址，外部取不到）降级成 [图片]", () => {
    expect(tgSafeText("多萝：![](/api/stickers/abc-123/image)")).toBe("多萝：[图片]")
  })

  it("绝对 http(s) 图片保留 URL，交给 Telegram 预览", () => {
    expect(tgSafeText("看这个 ![](https://example.com/a.png)")).toBe("看这个 https://example.com/a.png")
  })

  it("markdown 链接转成「文字 链接」（Telegram 不解析 md 链接）", () => {
    expect(tgSafeText("[文档](https://example.com/doc)")).toBe("文档 https://example.com/doc")
  })

  it("普通文本原样返回", () => {
    expect(tgSafeText("你好呀")).toBe("你好呀")
  })
})

describe("站内 → TG 的图片拆分（splitOutgoing）", () => {
  it("站内表情包 → 变成绝对 URL 交给 sendPhoto 发真图", () => {
    const r = splitOutgoing("多萝：![](/api/stickers/abc-123/image)")
    expect(r.photos).toEqual(["https://cloud.doulor.cn/api/stickers/abc-123/image"])
    expect(r.text).toContain("[图片]")
  })

  it("绝对 http 图片直接被收集", () => {
    const r = splitOutgoing("![](https://example.com/a.png)")
    expect(r.photos).toEqual(["https://example.com/a.png"])
  })

  it("/api/tg/file/（站内中转的 TG 图）不回推", () => {
    const r = splitOutgoing("![](/api/tg/file/CAACAgUAAA)")
    expect(r.photos).toEqual([])
    expect(r.text).not.toContain("/api/tg/file")
  })

  it("纯文字没有图片", () => {
    const r = splitOutgoing("你好呀")
    expect(r.photos).toEqual([])
    expect(r.text).toBe("你好呀")
  })
})
