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
import {
  maskToken,
  handleWebhook,
  getAdminConfig,
  createBindCode,
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

  it("群聊里的命令一律忽略（即使 secret 正确）", async () => {
    await seedConfig({ enabled: true })
    const groupMsg = {
      message: { text: "/status", chat: { id: -100123, type: "group" }, from: { id: 1 } },
    }
    const res = await handleWebhook(env, hookRequest(groupMsg, SECRET))
    expect(res.status).toBe(200)
    expect((await res.json()) as { ignored?: string }).toMatchObject({ ignored: "not-private" })
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
