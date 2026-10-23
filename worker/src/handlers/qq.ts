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
import { requireUser } from "../auth"
import { requireAdminScope } from "./admin"
import { decryptSecret, encryptSecret, uuid } from "../crypto"
import { tgSafeText } from "./telegram"
import { getPointsBalance } from "../points"
import { siteDayString, siteOffsetHours } from "../settings"
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
    openid?: string
    user_openid?: string
    /** INTERACTION_CREATE 的按钮数据 */
    data?: { type?: number; resolved?: { button_data?: string; button_id?: string } }
    /** 按钮点击者的 openid（私聊场景在 d.user_openid，群场景在 d.group_openid + 点击者 member） */
    group_member_openid?: string
    author?: { member_openid?: string; union_openid?: string; username?: string; user_openid?: string }
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
      if (payload.t === "GROUP_ADD_ROBOT" || payload.t === "GROUP_MSG_RECEIVE") {
        await setGroupEnabled(env, payload.d?.group_openid, true)
      } else if (payload.t === "GROUP_DEL_ROBOT" || payload.t === "GROUP_MSG_REJECT") {
        // 机器人被移出 / 群主关掉了消息推送 → 立刻停用，否则会一直发失败、白烧主动消息配额
        await setGroupEnabled(env, payload.d?.group_openid, false)
      } else if (payload.t === "C2C_MESSAGE_CREATE") {
        await handleC2cMessage(env, payload.d)
      } else if (payload.t === "FRIEND_ADD") {
        await handleFriendAdd(env, payload.d)
      } else if (payload.t === "FRIEND_DEL" || payload.t === "C2C_MSG_REJECT") {
        await setC2cPush(env, c2cOpenidOf(payload.d), false)
      } else if (payload.t === "C2C_MSG_RECEIVE") {
        await setC2cPush(env, c2cOpenidOf(payload.d), true)
      } else if (payload.t === "INTERACTION_CREATE") {
        await handleInteraction(env, payload)
      } else if (payload.t === "GROUP_MESSAGE_CREATE" || payload.t === "GROUP_AT_MESSAGE_CREATE") {
        /**
         * 两种事件都接（2026-10-24 站长在后台看到 `GROUP_MESSAGE_CREATE` 群消息事件创建，
         * 说明平台已经开放**全量群消息**订阅，不再只限于 @机器人）。
         * 两者 payload 结构相同，区别只是 GROUP_AT_MESSAGE_CREATE 的 content 里带 <@!...> 前缀。
         * 订阅了 GROUP_MESSAGE_CREATE 就等于「不用 @ 也能进站内」。
         */
        await bridgeGroupMessage(env, payload.d)
      }
    } catch (err) {
      // webhook 永远回 200，避免平台重投同一批事件
      console.warn("QQ 事件处理失败:", payload.t, err instanceof Error ? err.message : err)
    }
  }

  return json({ op: 12 })
}

/** QQ 群消息（全量或 @机器人） → 站内聊天室 */
async function bridgeGroupMessage(env: Env, d: QqPayload["d"]): Promise<void> {
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

  // 去掉 @ 占位：平台把 mention 拼成 `<@!id>`（可能在任意位置）；
  // 只额外清掉**开头**的 `@某个名字`，避免把正文里的邮箱/社交账号一起吃掉
  const text = rawText
    .replace(/<@!?[^>]+>/g, "")
    .replace(/^@\S+\s+/, "")
    .trim()
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


/* ==========================================================================
 * 二期（2026-10-24）：私聊命令 / 群开关 / 好友欢迎 / 按钮签到
 * ========================================================================== */

/** 群开关（被移出群、群主关闭消息推送时调用） */
export async function setGroupEnabled(env: Env, groupOpenid: string | undefined, enabled: boolean): Promise<void> {
  if (!groupOpenid) return
  await env.DB.prepare(
    `INSERT INTO qq_channels (group_openid, title, enabled, created_at) VALUES (?, NULL, ?, ?)
     ON CONFLICT(group_openid) DO UPDATE SET enabled = excluded.enabled`
  )
    .bind(groupOpenid, enabled ? 1 : 0, Date.now())
    .run()
  await logPush(env, enabled ? "qq:group:on" : "qq:group:off", groupOpenid, true)
}

/** 记录用户对主动消息的开关（C2C_MSG_REJECT / RECEIVE） */
export async function setC2cPush(env: Env, openid: string | undefined, allow: boolean): Promise<void> {
  if (!openid) return
  await env.DB.prepare(
    `INSERT INTO qq_c2c_state (qq_openid, allow_push, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(qq_openid) DO UPDATE SET allow_push = excluded.allow_push, updated_at = excluded.updated_at`
  )
    .bind(openid, allow ? 1 : 0, Date.now())
    .run()
}

function c2cOpenidOf(d: QqPayload["d"]): string | undefined {
  return d?.author?.user_openid ?? d?.user_openid ?? d?.openid
}

/**
 * 给 QQ 用户发私聊消息（可带按钮）。
 *
 * keyboard 为 QQ 的按钮组件结构；用它的目的：签到卡上的按钮点击后会推
 * INTERACTION_CREATE，我们就能在 **QQ 里直接完成签到**，不用跳浏览器。
 */
export async function sendC2c(
  env: Env,
  openid: string,
  content: string,
  keyboard?: unknown
): Promise<boolean> {
  const cfg = await loadConfig(env)
  if (!cfg.enabled) return false
  const token = await accessToken(env, cfg)
  if (!token) return false
  const res = await fetch(`${API}/v2/users/${encodeURIComponent(openid)}/messages`, {
    method: "POST",
    headers: { authorization: `QQBot ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ content: content.slice(0, 1500), msg_type: 0, ...(keyboard ? { keyboard } : {}) }),
  })
  const ok = res.ok
  if (!ok) {
    const body = (await res.text().catch(() => "")) ?? ""
    await logPush(env, "qq:c2c", openid, false, body.slice(0, 200))
  }
  return ok
}

/** 按钮卡片：签到（点头像按钮 = 回调按钮，点下面按钮 = 跳站点） */
function checkinKeyboard(): unknown {
  return {
    content: {
      rows: [
        {
          buttons: [
            {
              id: "checkin_now",
              render_data: { label: "立即签到", style: 1, visited_label: "已签到" },
              action: { type: 1, permission: { type: 2 }, data: "checkin", enter: false },
            },
            {
              id: "open_site",
              render_data: { label: "打开积分页", style: 0, visited_label: "打开" },
              action: { type: 0, permission: { type: 2 }, data: "https://cloud.doulor.cn/dashboard/points", enter: true },
            },
          ],
        },
      ],
    },
  }
}

/** QQ 私聊命令 */
async function handleC2cMessage(env: Env, d: QqPayload["d"]): Promise<void> {
  if (!d) return
  const openid = c2cOpenidOf(d)
  if (!openid) return
  const text = (d.content ?? "").trim()
  if (!text) return

  // 只有绑定过才能用的命令
  const binding = await bindingByQq(env, openid)
  const cmd = (text.split(/\s+/)[0] ?? "").toLowerCase()
  const arg = text.slice(cmd.length).trim()

  if (cmd === "/bind" || cmd === "/start") {
    if (!arg) return void (await sendC2c(env, openid, "用法：/bind 123456\n绑定码在网站「账号设置 → Telegram/QQ 绑定」生成（10 分钟有效、一次性）。"))
    return void (await handleQqBind(env, openid, arg))
  }

  if (cmd === "/help" || cmd === "/") {
    return void (await sendC2c(env, openid, ["DoulorCloud 机器人", "", "/bind 123456  绑定站内账号", "/签到  每日签到（带按钮）", "/积分  查看积分余额", "/me  账号概览"].join("\n")))
  }

  if (!binding) {
    return void (await sendC2c(env, openid, "还没绑定账号。先到网站「账号设置」生成绑定码，然后发：/bind 123456"))
  }

  if (cmd === "/签到" || cmd === "/checkin") {
    const status = await checkinStatusText(env, binding.user_id)
    return void (await sendC2c(env, openid, status, checkinKeyboard()))
  }
  if (cmd === "/积分" || cmd === "/points") {
    const bal = await pointsBalance(env, binding.user_id)
    return void (await sendC2c(env, openid, `当前积分：${bal}`))
  }
  if (cmd === "/me") {
    const row = await env.DB.prepare("SELECT username, nickname, role FROM users WHERE id = ?")
      .bind(binding.user_id)
      .first<{ username: string; nickname: string | null; role: string }>()
    return void (await sendC2c(env, openid, `账号：${row?.username ?? "?"}\n昵称：${row?.nickname ?? "-"}\n角色：${row?.role ?? "-"}`))
  }
  return void (await sendC2c(env, openid, "未知命令。发 /help 看可用命令。"))
}

/** `/bind <码>`：复用站内那张一次性绑定码表（tg_bind_tokens，站内生成、10 分钟过期） */
async function handleQqBind(env: Env, openid: string, code: string): Promise<void> {
  if (!/^\d{6}$/.test(code)) {
    await sendC2c(env, openid, "绑定码是 6 位数字。")
    return
  }
  const row = await env.DB.prepare(
    "SELECT user_id FROM tg_bind_tokens WHERE code = ? AND used_at IS NULL AND expires_at > ?"
  )
    .bind(code, Date.now())
    .first<{ user_id: string }>()
  if (!row) {
    await sendC2c(env, openid, "绑定码无效或已过期，回网站重新生成。")
    return
  }
  const taken = await bindingByQq(env, openid)
  if (taken && taken.user_id !== row.user_id) {
    await sendC2c(env, openid, "这个 QQ 已经绑定了别的账号。")
    return
  }
  await env.DB.prepare(
    `INSERT INTO qq_bindings (qq_openid, user_id, bound_at) VALUES (?, ?, ?)
     ON CONFLICT(qq_openid) DO UPDATE SET user_id = excluded.user_id, bound_at = excluded.bound_at`
  )
    .bind(openid, row.user_id, Date.now())
    .run()
  await env.DB.prepare("UPDATE tg_bind_tokens SET used_at = ? WHERE code = ?").bind(Date.now(), code).run()
  await logPush(env, "qq:bind", openid, true)
  await sendC2c(env, openid, "绑定成功 ✅ 试试 /签到 或 /积分。")
}

async function bindingByQq(env: Env, openid: string): Promise<{ user_id: string } | null> {
  return await env.DB.prepare("SELECT user_id FROM qq_bindings WHERE qq_openid = ?")
    .bind(openid)
    .first<{ user_id: string }>()
}

async function pointsBalance(env: Env, userId: string): Promise<number> {
  // 复用站内的余额读取（表是 user_points，别自己拼 SQL）
  return await getPointsBalance(env, userId)
}

async function checkinStatusText(env: Env, userId: string): Promise<string> {
  // 「今天」必须按站点时区算（用站内同一套 helper，避免和网站对不上）
  const today = siteDayString(new Date(), await siteOffsetHours(env))
  const row = await env.DB.prepare(
    "SELECT points, streak FROM daily_checkins WHERE user_id = ? AND checkin_date = ?"
  )
    .bind(userId, today)
    .first<{ points: number; streak: number }>()
  if (row) return `今天已签到 ✅ 连续 ${row.streak} 天，本次 +${row.points} 积分`
  return "今天还没签到 —— 点下面的「立即签到」按钮即可。"
}

/** 好友添加 → 欢迎语 + 绑定引导 */
async function handleFriendAdd(env: Env, d: QqPayload["d"]): Promise<void> {
  const openid = c2cOpenidOf(d)
  if (!openid) return
  await sendC2c(
    env,
    openid,
    ["👋 我是 DoulorCloud 机器人。", "", "先绑定站内账号就能在这里签到、查积分：", "1) 打开网站「账号设置」生成 6 位绑定码", "2) 这里发 /bind 123456"].join("\n")
  )
  await logPush(env, "qq:friend:add", openid, true)
}

/**
 * 按钮回调（INTERACTION_CREATE）。
 *
 * 目前只做「立即签到」：站内 `checkinForUser` 是同一份逻辑，
 * 所以在 QQ 里点按钮和网站里点签到效果完全一致（连续天数、里程碑都不分叉）。
 */
async function handleInteraction(env: Env, payload: QqPayload): Promise<void> {
  const d = payload.d
  const buttonData = d?.data?.resolved?.button_data ?? ""
  const openid = c2cOpenidOf(d)
  if (!buttonData || !openid) return
  if (buttonData !== "checkin") return

  const binding = await bindingByQq(env, openid)
  if (!binding) {
    await sendC2c(env, openid, "先绑定账号：/bind 123456")
    return
  }
  const { checkinForUser } = await import("./checkin")
  try {
    const res = await checkinForUser(env, binding.user_id)
    const body = (await res.json()) as { streak?: number; total?: number; milestoneHit?: { days: number; points: number } | null }
    const lines = [`签到成功 ✅ 连续 ${body.streak ?? 1} 天，+${body.total ?? 0} 积分`]
    if (body.milestoneHit) lines.push(`🎉 里程碑：连续 ${body.milestoneHit.days} 天，额外 +${body.milestoneHit.points}`)
    await sendC2c(env, openid, lines.join("\n"))
    await logPush(env, "qq:checkin", openid, true)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await sendC2c(env, openid, msg.includes("已经签过") ? "今天已经签过到啦 😄" : "签到失败，稍后再试。")
    await logPush(env, "qq:checkin", openid, false, msg.slice(0, 200))
  }
}

/* ==========================================================================
 * 用户侧：QQ 绑定（与 TG 绑定同风格：站内生成一次性码 → 到 QQ 里 /bind）
 * ========================================================================== */

/** 掩码：openid 很长，界面上只露头尾 */
function maskOpenid(openid: string): string {
  if (openid.length <= 10) return openid
  return `${openid.slice(0, 6)}……${openid.slice(-4)}`
}

/** GET /me/qq/binding */
export async function getMyQqBinding(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const row = await env.DB.prepare("SELECT qq_openid, bound_at FROM qq_bindings WHERE user_id = ?")
    .bind(user.id)
    .first<{ qq_openid: string; bound_at: number }>()
  if (!row) return json({ bound: false })
  return json({ bound: true, qqOpenid: maskOpenid(row.qq_openid), boundAt: row.bound_at })
}

/**
 * POST /me/qq/bind-code —— 生成一次性 6 位绑定码。
 *
 * ⚠️ 复用 `tg_bind_tokens` 这张表：绑定码本质是「某个 user_id 的一次性凭证」，
 * 与渠道无关。**谁先消费算谁的**（TG 或 QQ 都可以用它完成绑定）。
 */
export async function createMyQqBindCode(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const existing = await env.DB.prepare("SELECT qq_openid FROM qq_bindings WHERE user_id = ?")
    .bind(user.id)
    .first<{ qq_openid: string }>()
  if (existing) return json({ ok: true, alreadyBound: true, qqOpenid: maskOpenid(existing.qq_openid) })

  const code = String(Math.floor(100000 + Math.random() * 900000))
  const now = Date.now()
  const ttl = 10 * 60 * 1000
  await env.DB.prepare("DELETE FROM tg_bind_tokens WHERE user_id = ? AND used_at IS NULL")
    .bind(user.id)
    .run()
  await env.DB.prepare(
    "INSERT INTO tg_bind_tokens (code, user_id, expires_at, used_at) VALUES (?, ?, ?, NULL)"
  )
    .bind(code, user.id, now + ttl)
    .run()

  const cfg = await loadConfig(env)
  return json({
    ok: true,
    code,
    expiresAt: now + ttl,
    botReady: !!cfg.enabled && !!cfg.app_id,
    // QQ 没有 t.me 那种深链，前端给「去 QQ 搜机器人」的提示即可
    qqBotHint: "QQ 里搜索并添加机器人 DoulorCloud（QQ 4012701880），私聊发送 /bind 码",
  })
}

/** DELETE /me/qq/binding */
export async function deleteMyQqBinding(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  await env.DB.prepare("DELETE FROM qq_bindings WHERE user_id = ?").bind(user.id).run()
  await logPush(env, "qq:unbind", user.id, true)
  return json({ ok: true })
}
