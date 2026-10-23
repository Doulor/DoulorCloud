// QQ 机器人 ↔ 站内聊天室 测试（2026-10-24）
//
// 重点钉住三件事：
//   ① 回调地址验证的 Ed25519 签名**必须与官方文档示例一致**（黄金用例）
//   ② 群里 @机器人 的消息能进站内，未登记的群一条都不进
//   ③ 命令不桥接、限流生效、影子账号唯一
import { describe, it, expect, beforeEach } from "vitest"
import { env } from "cloudflare:workers"
import { handleQqWebhook, qqSignature, qqSeed } from "../src/handlers/qq"
import { encryptSecret } from "../src/crypto"

const APP_ID = "1905911344"
const SECRET = "b9YllZAYjhRyIPK1"
const GROUP = "GROUP_OPENID_TEST_AAA"

async function seedConfig(opts: { enabled?: boolean } = {}): Promise<void> {
  const enc = await encryptSecret(SECRET, env.SESSION_SECRET as string)
  await env.DB.prepare(
    `INSERT INTO qq_bot_config (id, enabled, app_id, secret_enc, created_at, updated_at)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, app_id = excluded.app_id,
       secret_enc = excluded.secret_enc`
  )
    .bind(opts.enabled === false ? 0 : 1, APP_ID, enc, Date.now(), Date.now())
    .run()
}

async function seedGroup(enabled = 1): Promise<void> {
  await env.DB.prepare("DELETE FROM qq_channels").run()
  await env.DB.prepare(
    "INSERT INTO qq_channels (group_openid, title, enabled, created_at) VALUES (?, NULL, ?, ?)"
  )
    .bind(GROUP, enabled, Date.now())
    .run()
}

function hook(body: unknown): Request {
  return new Request("https://cloud.doulor.cn/api/qq/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function atMessage(opts: { content?: string; member?: string; id?: string }): unknown {
  return {
    op: 0,
    t: "GROUP_AT_MESSAGE_CREATE",
    id: opts.id ?? "EVENT_1",
    d: {
      id: opts.id ?? "MSG_1",
      content: opts.content ?? " <@!123456> 群里问一句",
      group_openid: GROUP,
      author: { member_openid: opts.member ?? "MEMBER_OPENID_A" },
      timestamp: new Date().toISOString(),
    },
  }
}

async function qqRows(): Promise<Array<{ body: string; user_id: string; qq_message_id: string | null }>> {
  const { results } = await env.DB.prepare(
    "SELECT body, user_id, qq_message_id FROM chat_messages WHERE source = 'qq' ORDER BY created_at ASC"
  ).all<{ body: string; qq_message_id: string | null; user_id: string }>()
  return results ?? []
}

describe("QQ 机器人 · 回调验证", () => {
  it("Ed25519 签名与官方文档示例完全一致（黄金用例）", async () => {
    // 官方文档给出的示例：appid 11111111、secret DG5g3B4j9X2KOErG
    // event_ts 1725442341、plain_token Arq0D5A61EgUu4OxUvOp
    const sig = await qqSignature("DG5g3B4j9X2KOErG", "1725442341", "Arq0D5A61EgUu4OxUvOp")
    expect(sig).toBe(
      "87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706"
    )
  })

  it("seed 补足到 32 字节（secret 短于 32 时自我拼接）", () => {
    expect(qqSeed("abc").length).toBe(32)
    expect(new TextDecoder().decode(qqSeed("b9YllZAYjhRyIPK1"))).toBe("b9YllZAYjhRyIPK1b9YllZAYjhRyIPK1")
  })

  it("op=13 回调验证：即使机器人未启用也要能返回签名（否则后台配不了 URL）", async () => {
    await seedConfig({ enabled: false })
    const res = await handleQqWebhook(
      env,
      hook({ op: 13, d: { plain_token: "Arq0D5A61EgUu4OxUvOp", event_ts: "1725442341" } })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { plain_token: string; signature: string }
    expect(body.plain_token).toBe("Arq0D5A61EgUu4OxUvOp")
    expect(body.signature).toMatch(/^[0-9a-f]{128}$/)
    // 用我们自己的 secret 再算一遍，应与响应一致
    expect(body.signature).toBe(await qqSignature(SECRET, "1725442341", "Arq0D5A61EgUu4OxUvOp"))
  })
})

describe("QQ 机器人 · 群 @ 消息进站内", () => {
  beforeEach(async () => {
    await seedConfig()
    await seedGroup()
    await env.DB.prepare("DELETE FROM chat_messages WHERE source = 'qq'").run()
    await env.DB.prepare("DELETE FROM users WHERE role = 'guest'").run()
  })

  it("群里 @机器人 发言 → 落进站内聊天室，并去掉 @ 前缀", async () => {
    const res = await handleQqWebhook(env, hook(atMessage({ content: "<@!123456> 你好站内" })))
    expect(res.status).toBe(200)
    const rows = await qqRows()
    expect(rows.length).toBe(1)
    expect(rows[0].body).toBe("你好站内")
    expect(rows[0].qq_message_id).toBe("MSG_1")

    const shadow = await env.DB.prepare("SELECT role, nickname FROM users WHERE qq_shadow_id = ?")
      .bind("MEMBER_OPENID_A")
      .first<{ role: string; nickname: string }>()
    expect(shadow?.role).toBe("guest")
    expect(shadow?.nickname).toContain("QQ:")
  })

  it("未登记的群 → 一条都不落库", async () => {
    await seedGroup(0)
    await handleQqWebhook(env, hook(atMessage({ content: "<@!1> 不该进来的" })))
    expect((await qqRows()).length).toBe(0)
  })

  it("同一个人多条消息复用同一个影子账号", async () => {
    await handleQqWebhook(env, hook(atMessage({ content: "<@!1> 第一条", id: "M1" })))
    await handleQqWebhook(env, hook(atMessage({ content: "<@!1> 第二条", id: "M2" })))
    const n = await env.DB.prepare("SELECT COUNT(*) AS c FROM users WHERE qq_shadow_id = ?")
      .bind("MEMBER_OPENID_A")
      .first<{ c: number }>()
    expect(n?.c).toBe(1)
    expect((await qqRows()).length).toBe(2)
  })

  it("命令不桥接（/开头）", async () => {
    await handleQqWebhook(env, hook(atMessage({ content: "<@!1> /bind 123456" })))
    expect((await qqRows()).length).toBe(0)
  })

  it("限流：同一成员 1 分钟内超过 10 条被丢弃", async () => {
    for (let i = 0; i < 12; i++) {
      await handleQqWebhook(env, hook(atMessage({ content: `<@!1> 刷屏 ${i}`, id: `SPAM_${i}` })))
    }
    expect((await qqRows()).length).toBe(10)
  })

  it("机器人被拉进群 → 自动登记白名单", async () => {
    await env.DB.prepare("DELETE FROM qq_channels").run()
    await handleQqWebhook(env, hook({ op: 0, t: "GROUP_ADD_ROBOT", id: "E1", d: { group_openid: "NEW_GROUP_X" } }))
    const row = await env.DB.prepare("SELECT enabled FROM qq_channels WHERE group_openid = ?")
      .bind("NEW_GROUP_X")
      .first<{ enabled: number }>()
    expect(row?.enabled).toBe(1)
  })
})
