/**
 * QQ 机器人（DoulorCloud）—— 与站内聊天室互通（2026-10-24）。
 *
 * ## 平台限制（官方文档，必须先读懂这段）
 *
 * 普通 QQ 群的机器人事件只有：
 *   · `GROUP_AT_MESSAGE_CREATE` —— **用户在群里 @机器人** 时才推
 *   · `GROUP_ADD_ROBOT` / `GROUP_DEL_ROBOT` —— 被拉进/移出群
 *
 * 也就是说官方**没有给"读取全部群消息"的权限**（那个能力只有频道 guild 的
 * 私域机器人有）。所以这里的互通是单向偏重的：
 *   · 群 → 站内：只有 @机器人 的那条进来
 *   · 站内 → 群：能发，但属于「主动消息」，受平台配额限制（失败只记日志不重试）
 *
 * ## 安全
 *   · webhook 无鉴权，靠 op=13 的 Ed25519 签名验证（见 `qqValidationReply`）
 *   · AppSecret 用 AES-GCM 加密存 D1（与 TG token 同法）
 *   · 群白名单 `qq_channels`：只有登记并启用的群才桥接
 *   · 按 member_openid 限流 10 条/分钟
 */
import { ApiError, json, readBodyCapped } from "../http"
import { requireAdminScope } from "./admin"
import { decryptSecret, encryptSecret, uuid } from "../crypto"
import { tgSafeText } from "./telegram"
import type { Env } from "../env"

const API = "https://api.sgroup.qq.com"
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken"

interface QqConfigRow {
  enabled: number
  app_id: string | null
  secret_enc: string | null
}

/** webhook payload（只列我们关心的字段） */
interface QqPayload {
  id?: string
  op?: number
  t?: string
  d?: {
    id?: string
    content?: string
    group_openid?: string
    timestamp?: string
    plain_token?: string
    event_ts?: string
    op_member_openid?: string
    author?: { member_openid?: string; union_openid?: string; username?: string }
  }
}

async function loadConfig(env: Env): Promise<QqConfigRow> {
  const row = await env.DB.prepare("SELECT enabled, app_id, secret_enc FROM qq_bot_config WHERE id = 1").first<QqConfigRow>()
  if (row) return row
  await env.DB.prepare("INSERT OR IGNORE INTO qq_bot_config (id, enabled) VALUES (1, 0)").run()
  return (
    (await env.DB.prepare("SELECT enabled, app_id, secret_enc FROM qq_bot_config WHERE id = 1").first<QqConfigRow>()) ?? {
      enabled: 0,
      app_id: null,
      secret_enc: null,
    }
  )
}

async function appSecret(env: Env, cfg: QqConfigRow): Promise<string | null> {
  if (!cfg.secret_enc) return null
  try {
    return await decryptSecret(cfg.secret_enc, env.SESSION_SECRET as string)
  } catch {
    return null
  }
}

/** access_token 缓存（有效期约 2 小时，提前 1 分钟失效） */
let tokenCache: { token: string; exp: number } | null = null

async function accessToken(env: Env, cfg: QqConfigRow): Promise<string | null> {
  if (tokenCache && Date.now() < tokenCache.exp) return tokenCache.token
  const secret = await appSecret(env, cfg)
  if (!secret || !cfg.app_id) return null
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: cfg.app_id, clientSecret: secret }),
    })
    const data = (await res.json()) as { access_token?: string; expires_in?: string | number }
    if (!data.access_token) return null
    const ttl = Number(data.expires_in ?? 7000)
    tokenCache = { token: data.access_token, exp: Date.now() + Math.max(60, ttl - 60) * 1000 }
    return data.access_token
  } catch {
    return null
  }
}

/* ==========================================================================
 * 回调地址验证（op=13）
 * ========================================================================== */

/**
 * 官方算法：把 BotSecret 反复自我拼接补到 32 字节当 Ed25519 的 seed，
 * 对 `event_ts + plain_token` 签名，返回 hex。
 *
 * 实现上用 PKCS8 包装 seed（`302e020100300506032b657004220420` 前缀 + 32 字节 seed），
 * 这在 Cloudflare Workers 的 WebCrypto 里是通用写法，不必依赖第三方库。
 */
export function qqSeed(secret: string): Uint8Array {
  let s = secret
  while (s.length < 32) s = s + s
  s = s.slice(0, 32)
  return new TextEncoder().encode(s)
}

export async function qqSignature(secret: string, eventTs: string, plainToken: string): Promise<string> {
  const seed = qqSeed(secret)
  const prefix = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20])
  const pkcs8 = new Uint8Array(prefix.length + seed.length)
  pkcs8.set(prefix, 0)
  pkcs8.set(seed, prefix.length)
  // TS 的 DOM 类型里没有 Ed25519，运行时 Workers 支持（BoringSSL），这里显式放宽类型
  const subtle = crypto.subtle as unknown as {
    importKey: (fmt: string, key: BufferSource, alg: unknown, ext: boolean, usage: string[]) => Promise<unknown>
    sign: (alg: unknown, key: unknown, data: BufferSource) => Promise<ArrayBuffer>
  }
  const key = await subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"])
  const msg = new TextEncoder().encode(eventTs + plainToken)
  const sig = new Uint8Array(await subtle.sign({ name: "Ed25519" }, key, msg))
  return Array.from(sig)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/* ==========================================================================
 * webhook
 * ========================================================================== */

export async function handleQqWebhook(env: Env, request: Request): Promise<Response> {
  const raw = new TextDecoder().decode(await readBodyCapped(request, 64 * 1024, "回调数据过大"))
  let payload: QqPayload
  try {
    payload = JSON.parse(raw) as QqPayload
  } catch {
    throw new ApiError(400, "无法解析回调数据", "BAD_PAYLOAD")
  }

  const cfg = await loadConfig(env)

  // ① 回调地址验证：即使机器人功能未启用也要能通过，否则后台配置不了 URL
  if (payload.op === 13) {
    const secret = await appSecret(env, cfg)
    const plainToken = payload.d?.plain_token ?? ""
    const eventTs = payload.d?.event_ts ?? ""
    if (!secret || !plainToken || !eventTs) throw new ApiError(400, "验证参数缺失", "BAD_VALIDATION")
    return json({ plain_token: plainToken, signature: await qqSignature(secret, eventTs, plainToken) })
  }

  if (!cfg.enabled) return json({ op: 12 })

  // ② 事件
  if (payload.op === 0) {
    try {
      if (payload.t === "GROUP_ADD_ROBOT") {
        await registerGroup(env, payload.d?.group_openid)
      } else if (payload.t === "GROUP_AT_MESSAGE_CREATE") {
        await bridgeAtMessage(env, payload.d)
      }
    } catch (err) {
      // webhook 永远回 200，避免平台重投同一批事件
      console.warn("QQ 事件处理失败:", payload.t, err instanceof Error ? err.message : err)
    }
  }

  return json({ op: 12 })
}

/** 机器人被拉进群时登记（后续消息靠它过白名单） */
async function registerGroup(env: Env, groupOpenid: string | undefined): Promise<void> {
  if (!groupOpenid) return
  await env.DB.prepare(
    "INSERT INTO qq_channels (group_openid, title, enabled, created_at) VALUES (?, NULL, 1, ?) " +
      "ON CONFLICT(group_openid) DO UPDATE SET enabled = 1"
  )
    .bind(groupOpenid, Date.now())
    .run()
}

/** QQ 群的 @ 消息 → 站内聊天室 */
async function bridgeAtMessage(env: Env, d: QqPayload["d"]): Promise<void> {
  if (!d) return
  const groupOpenid = d.group_openid ?? ""
  const memberOpenid = d.author?.member_openid ?? ""
  const rawText = (d.content ?? "").trim()
  if (!groupOpenid || !memberOpenid) return

  // 白名单：群必须先登记（GROUP_ADD_ROBOT 会自动登记）
  const allowed = await env.DB.prepare(
    "SELECT 1 AS ok FROM qq_channels WHERE group_openid = ? AND enabled = 1"
  )
    .bind(groupOpenid)
    .first<{ ok: number }>()
  if (!allowed) return

  // 去掉开头的 @机器人（平台会把 mention 拼在正文里）
  const text = rawText.replace(/^<@!?[^>]+>\s*/, "").replace(/^@\S+\s*/, "").trim()
  if (!text) return
  // 命令不桥接（与 TG 同口径）
  if (/^\/[A-Za-z0-9_]{1,32}(\s|$)/.test(text)) return

  const userId = await ensureShadowUser(env, memberOpenid, d.author?.username ?? null)

  // 限流：同一 QQ 用户 10 条/分钟（直接数 chat_messages，不额外建表）
  const since = new Date(Date.now() - 60_000).toISOString()
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM chat_messages WHERE user_id = ? AND created_at > ?"
  )
    .bind(userId, since)
    .first<{ c: number }>()
  if ((recent?.c ?? 0) >= 10) return

  await env.DB.prepare(
    `INSERT INTO chat_messages (id, user_id, body, created_at, source, qq_message_id, qq_group_openid)
     VALUES (?, ?, ?, ?, 'qq', ?, ?)`
  )
    .bind(uuid(), userId, text.slice(0, 4000), new Date().toISOString(), d.id ?? null, groupOpenid)
    .run()

  await logPush(env, "qq:chat:in", groupOpenid, true)
}

/**
 * QQ 侧访客的影子账号（role='guest'，与 TG 桥接同款护栏）。
 *
 * 注意：QQ 的 member_openid 是**按群隔离**的 —— 同一个人在不同群里 openid 不同，
 * 所以这里一个群里的人对应一个站内影子账号，昵称无法跨群统一。
 */
async function ensureShadowUser(env: Env, memberOpenid: string, username: string | null): Promise<string> {
  const found = await env.DB.prepare("SELECT id FROM users WHERE qq_shadow_id = ?")
    .bind(memberOpenid)
    .first<{ id: string }>()
  if (found) return found.id

  const id = uuid()
  const now = new Date().toISOString()
  // openid 很长且含特殊字符，用户名取短哈希避免重复/超长
  const short = Array.from(memberOpenid)
    .reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 0xffffffff, 7)
    .toString(36)
  const uname = `qq_${short}`.slice(0, 32)
  const nickname = (username ? `QQ:${username}` : `QQ:${uname}`).slice(0, 32)
  try {
    await env.DB.prepare(
      `INSERT INTO users (id, username, email, password_hash, namespace, status, role, permissions,
                          invite_code_id, uid, created_at, updated_at, nickname, qq_shadow_id)
       VALUES (?, ?, ?, ?, ?, 'active', 'guest', '[]', NULL,
               (SELECT COALESCE(MAX(uid), 0) + 1 FROM users), ?, ?, ?, ?)`
    )
      .bind(id, uname, `${uname}@shadow.invalid`, "!shadow-no-login", uname, now, now, nickname, memberOpenid)
      .run()
    return id
  } catch {
    const again = await env.DB.prepare("SELECT id FROM users WHERE qq_shadow_id = ?")
      .bind(memberOpenid)
      .first<{ id: string }>()
    if (again) return again.id
    throw new ApiError(500, "创建 QQ 访客账号失败", "SHADOW_FAILED")
  }
}

/* ==========================================================================
 * 站内 → QQ 群
 * ========================================================================== */

/**
 * 把站内聊天室的一条发言推到已登记的 QQ 群。
 *
 * ⚠️ 这是「主动消息」，平台有配额（每月每群有限条数）。因此：
 *   · 1 条/秒节流
 *   · 失败只记日志，绝不重试（重试会把配额烧光）
 */
let lastQqPushAt = 0

export async function pushToQqGroups(env: Env, text: string): Promise<number> {
  try {
    const now = Date.now()
    if (now - lastQqPushAt < 1000) return 0
    const cfg = await loadConfig(env)
    if (!cfg.enabled) return 0
    const token = await accessToken(env, cfg)
    if (!token) return 0

    const { results } = await env.DB.prepare(
      "SELECT group_openid FROM qq_channels WHERE enabled = 1"
    ).all<{ group_openid: string }>()
    if (!results?.length) return 0
    lastQqPushAt = now

    // QQ 群文本不渲染 markdown：图片一律降级成 [图片]
    const content = tgSafeText(text).slice(0, 1500)
    let ok = 0
    for (const row of results) {
      const res = await fetch(`${API}/v2/groups/${encodeURIComponent(row.group_openid)}/messages`, {
        method: "POST",
        headers: { authorization: `QQBot ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ content, msg_type: 0 }),
      })
      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; code?: number }
      const success = res.ok && !!body.id
      await logPush(env, "qq:chat", row.group_openid, success, success ? undefined : (body.message ?? `HTTP ${res.status}`))
      if (success) ok++
    }
    return ok
  } catch {
    return 0
  }
}

/* ==========================================================================
 * 管理接口
 * ========================================================================== */

/** GET /admin/qq/config —— 读配置（secret 永远脱敏） */
export async function getQqConfig(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "telegram")
  const cfg = await loadConfig(env)
  const groups = await env.DB.prepare(
    "SELECT group_openid, enabled, last_ok_at, last_error FROM qq_channels ORDER BY created_at DESC"
  ).all<{ group_openid: string; enabled: number; last_ok_at: number | null; last_error: string | null }>()
  return json({
    enabled: !!cfg.enabled,
    appId: cfg.app_id ?? "",
    hasSecret: !!cfg.secret_enc,
    channels: (groups.results ?? []).map((c) => ({
      groupOpenid: c.group_openid,
      enabled: !!c.enabled,
      lastOkAt: c.last_ok_at,
      lastError: c.last_error,
    })),
  })
}

/** POST /admin/qq/config —— 保存 AppID/Secret 与开关 */
export async function saveQqConfig(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "telegram")
  const raw = new TextDecoder().decode(await readBodyCapped(request, 8 * 1024, "配置数据过大"))
  const body = JSON.parse(raw || "{}") as { enabled?: boolean; appId?: string; secret?: string }
  const cfg = await loadConfig(env)
  const appId = (body.appId ?? cfg.app_id ?? "").trim()
  const enabled = body.enabled ?? !!cfg.enabled
  const secretEnc = body.secret
    ? await encryptSecret(body.secret.trim(), env.SESSION_SECRET as string)
    : cfg.secret_enc
  if (!appId) throw new ApiError(400, "请填写 AppID", "INVALID_APP_ID")

  await env.DB.prepare(
    `INSERT INTO qq_bot_config (id, enabled, app_id, secret_enc, created_at, updated_at)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, app_id = excluded.app_id,
       secret_enc = excluded.secret_enc, updated_at = excluded.updated_at`
  )
    .bind(enabled ? 1 : 0, appId, secretEnc, Date.now(), Date.now())
    .run()
  tokenCache = null // 换了凭据，缓存必须失效
  await logPush(env, "qq:config", admin.id, true)
  return json({ ok: true })
}

/** 统一写投递日志（复用 tg_push_log，kind 前缀 qq:） */
async function logPush(env: Env, kind: string, target: string, ok: boolean, error?: string): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO tg_push_log (id, kind, target, ok, error, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(uuid(), kind, target, ok ? 1 : 0, error ?? null, Date.now())
      .run()
  } catch {
    /* 日志失败不影响主流程 */
  }
}
