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

export async function handleQqWebhook(
  env: Env,
  request: Request,
  ctx?: ExecutionContext
): Promise<Response> {
  const raw = new TextDecoder().decode(await readBodyCapped(request, 64 * 1024, "回调数据过大"))
  let payload: QqPayload
  try {
    payload = JSON.parse(raw) as QqPayload
  } catch {
    throw new ApiError(400, "无法解析回调数据", "BAD_PAYLOAD")
  }

  const cfg = await loadConfig(env)

  /**
   * 事件探针（2026-10-24）：**任何**进来的回调都先落一条日志。
   *
   * 起因：站长反馈群里发「绑定 xxx」没反应，而库里连一条事件都没有 ——
   * 有这行就能立刻区分「平台没推给我」和「推了但我处理失败」，
   * 不用再靠猜。kind 固定 qq:event，target 写事件类型。
   */
  if (payload.op !== 13) {
    await logPush(env, "qq:event", payload.t ?? `op:${payload.op ?? "?"}`, true)
  }

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
        // 出图/发消息要几秒，QQ 的 webhook 等不了 —— 立刻 ack，把处理丢到 waitUntil
          if (ctx) {
            ctx.waitUntil(
              bridgeGroupMessage(env, payload.d).catch((e) =>
                console.warn("群消息处理失败:", e instanceof Error ? e.message : e)
              )
            )
          } else {
            await bridgeGroupMessage(env, payload.d)
          }
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

  // 占位符统一处理（表情 → emoji、图片 → markdown、@ → 去掉），
  // 再清掉开头的 `@某个名字`，避免把正文里的邮箱一起吃掉
  const text = normalizeQqText(rawText).replace(/^@\S+\s+/, "").trim()
    // REFIDX 索引：QQ 的引用用的是 msg_idx/ref_msg_idx，不是 message id，
    // 所以**每条**群消息都要登记，否则之后被引用时就查不到正文。
    // REFIDX 索引：QQ 引用用的是 msg_idx/ref_msg_idx，不是 message id，必须自己建映射
    const scene = (d as unknown as { message_scene?: { ext?: string[] }; message_type?: number })
    const ext = scene.message_scene?.ext
    const idxOf = (tag: string): string => {
      // 不能直接用正则 tag+"="：会命中 "ref_msg_idx="，导致引用时覆盖被引用消息的正文
      for (const e of ext || []) {
        const str = String(e)
        const at = str.indexOf(tag + "=")
        if (at < 0) continue
        const prev = at > 0 ? str[at - 1] : ""
        if (prev && /[A-Za-z0-9_]/.test(prev)) continue
        return str.slice(at + tag.length + 1).split(/[,\]\s]/)[0]
      }
      return ""
    }
    const ownIdx = scene.message_type === 103 ? "" : idxOf("msg_idx")
    if (ownIdx) {
    await env.DB.prepare(
    "INSERT INTO qq_msg_index (group_openid, msg_idx, body, ts) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(group_openid, msg_idx) DO UPDATE SET body=excluded.body, ts=excluded.ts"
    ).bind(groupOpenid, ownIdx, text.slice(0, 500), Math.floor(Date.now() / 1000)).run().catch(() => undefined)
    }
  if (!text) return
  /**
   * 群里的命令：
   *   · `/bind 123456` → 允许，绑定这个 QQ 用户在**本群**的身份，随后在群内简短回复
   *   · 其它命令一律不桥接（避免站内数据被发到群里）
   */
  // 命令名可能是中文（/积分 /签到），所以字符类不能只写 A-Za-z0-9_
  /**
   * 群里绑定：**必须支持不带斜杠的写法**。
   *
   * 踩过的坑（2026-10-24 实测）：QQ 群把 `/` 开头的文本当「指令」处理，
   * 那条消息**根本不会推到机器人** —— 日志里连事件都没有。
   * 所以这里同时接受「绑定 123456」「bind 123456」「!bind 123456」「/bind 123456」。
   */
  const bindMatch = /^[\s/!！＃#]*(?:bind|绑定)[\s:：]*([0-9]{6})$/i.exec(text)
  if (bindMatch) {
    await handleGroupBind(env, memberOpenid, groupOpenid, bindMatch[1], d.id)
    return
  }
  // 「绑定状态」：群里随时查自己有没有绑上
  if (/^[\s/!！]*(?:我的绑定|绑定状态|绑定查询)[\s\S]*$/i.test(text)) {
    const bound = await bindingByQq(env, memberOpenid, "group")
    await sendGroupText(
      env,
      groupOpenid,
      bound ? "你这个 QQ 在本群已绑定账号 ✅" : "还没绑定。回网站生成绑定码，然后在群里发「绑定 123456」。",
      d.id
    )
    return
  }

    // 状态 / 羊毛（谁都能用；识别不带前缀的中文命令）

    // AT 事件的 content 带 <@!botid> 前缀（见上方注释），必须先剥掉再匹配指令
    const cleanText = text.replace(/^(\s*<@!?[^>]*>)+\s*/g, "").trim()
    const mine = /^[\s/!！]*(状态|status|模型|models|羊毛)\s*([\s\S]*)$/i.exec(cleanText)
    if (mine) {
      // 引用消息：QQ 事件只给 ref_msg_idx（被引用消息的索引），正文要靠本地 chat_messages 反查
      let refBody = ""
      try {
        const scene = (d as unknown as { message_scene?: { ext?: string[] }; message_type?: number })
        const ext = scene.message_scene?.ext
        const refIdx = (ext || [])
          .map((x) => /ref_msg_idx=([^,\]\s]+)/.exec(String(x))?.[1])
          .find(Boolean)
        if (refIdx) {
          const row = await env.DB.prepare(
            "SELECT body FROM qq_msg_index WHERE group_openid = ? AND msg_idx = ? LIMIT 1"
          )
            .bind(groupOpenid, refIdx)
            .first<{ body: string }>()
          refBody = (row?.body ?? "").trim()
          void logDbgRow(env, "REFHIT idx=" + refIdx.slice(0, 18) + " body=" + refBody.slice(0, 50))
        }
      } catch {
        /* 引用解析失败不影响普通指令 */
      }
      // 任何异常都要回一句，否则表现为「完全没反应」，排查时无从下手
      try {
        const hasRef = (ext || []).some((x) => String(x).includes("ref_msg_idx="))
        const hookRet = await handleGroupCommand(env, groupOpenid, memberOpenid, mine[1], (mine[2] || "").trim(), d.id, refBody, hasRef)
          if (hookRet) return
      } catch (e) {
        const msg = String((e as Error)?.message ?? e).slice(0, 120)
        console.warn("指令执行失败:", msg)
        await sendGroupText(env, groupOpenid, `指令执行出错：${msg}`, d.id).catch(() => undefined)
        return
      }
    }

  // 其它以 / 或 ! 开头（或已知中文命令）的，一律不桥接，只提示去私聊
  const groupCmd = /^[\s/!！]([^\s]{1,32})(?:\s+([\s\S]*))?$/.exec(text)
  if (groupCmd) {
    const name = (groupCmd[1] ?? "").toLowerCase()
    if (["bind", "绑定", "help", "帮助", "签到", "积分", "checkin", "points", "me"].includes(name)) {
      await sendGroupText(
        env,
        groupOpenid,
        "群里只支持「绑定 123456」这种绑定指令；签到/积分等请私聊机器人。",
        d.id
      )
    }
    return
  }

  // 群里绑定过 → 记到本人名下；没绑定则归到「本群访客」账号
  const bound = await bindingByQq(env, memberOpenid, "group")
  const userId = bound ? bound.user_id : await ensureGroupGuestUser(env, groupOpenid)

  // 限流：同一 QQ 用户 10 条/分钟（直接数 chat_messages，不额外建表）
  const since = new Date(Date.now() - 60_000).toISOString()
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM chat_messages WHERE user_id = ? AND created_at > ?"
  )
    .bind(userId, since)
    .first<{ c: number }>()
  if ((recent?.c ?? 0) >= 10) return

  // QQ 不提供昵称：有 username 就用它，否则用 member_openid 的短标识区分不同的人
  const displayName = d.author?.username
    ? `QQ:@${d.author.username}`
    : `QQ群友 #${shortTag(memberOpenid)}`

  await env.DB.prepare(
    `INSERT INTO chat_messages (id, user_id, body, created_at, source, qq_message_id, qq_group_openid, display_name)
     VALUES (?, ?, ?, ?, 'qq', ?, ?, ?)`
  )
    .bind(uuid(), userId, text.slice(0, 4000), new Date().toISOString(), d.id ?? null, groupOpenid, displayName)
    .run()

  await logPush(env, "qq:chat:in", groupOpenid, true)
}

/**
 * QQ 侧访客的影子账号（role='guest'，与 TG 桥接同款护栏）。
 *
 * 注意：QQ 的 member_openid 是**按群隔离**的 —— 同一个人在不同群里 openid 不同，
 * 所以这里一个群里的人对应一个站内影子账号，昵称无法跨群统一。
 */
/**
 * 本群的「访客账号」（2026-10-24 改）。
 *
 * 原来每个未绑定的群成员都会建一个影子账号 —— 站长实测「每有一个人说话网站就多一个用户」，
 * 而 QQ 官方根本不提供昵称，这些账号既不可辨识又污染后台统计。
 * 现在**每个群只保留一个访客账号**，群里未绑定成员的发言都归到它名下；
 * 想要自己的名字出现在站内，就 `/bind` 绑定账号。
 */
async function ensureGroupGuestUser(env: Env, groupOpenid: string): Promise<string> {
  const key = `group:${groupOpenid}`
  const found = await env.DB.prepare("SELECT id FROM users WHERE qq_shadow_id = ?")
    .bind(key)
    .first<{ id: string }>()
  if (found) return found.id

  const id = uuid()
  const now = new Date().toISOString()
  let short = 0
  for (const ch of groupOpenid) short = (short * 31 + ch.charCodeAt(0)) % 0xffffff
  const suffix = short.toString(16).toUpperCase().padStart(6, "0")
  const uname = `qq_guest_${suffix}`.slice(0, 32)
  try {
    await env.DB.prepare(
      `INSERT INTO users (id, username, email, password_hash, namespace, status, role, permissions,
                          invite_code_id, uid, created_at, updated_at, nickname, qq_shadow_id)
       VALUES (?, ?, ?, ?, ?, 'active', 'guest', '[]', NULL,
               (SELECT COALESCE(MAX(uid), 0) + 1 FROM users), ?, ?, ?, ?)`
    )
      .bind(id, uname, `${uname}@shadow.invalid`, "!shadow-no-login", uname, now, now, "QQ 群友", key)
      .run()
    return id
  } catch {
    const again = await env.DB.prepare("SELECT id FROM users WHERE qq_shadow_id = ?")
      .bind(key)
      .first<{ id: string }>()
    if (again) return again.id
    throw new ApiError(500, "创建 QQ 访客账号失败", "SHADOW_FAILED")
  }
}


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

/** 绑定 key 的作用域前缀：群里的 member_openid 与私聊的 user_openid 不是一回事 */
type QqScope = "c2c" | "group"

function qqIdentityKey(scope: QqScope, openid: string): string {
  return `${scope}:${openid}`
}

/**
 * QQ 系统表情 faceId → emoji 映射（常用的一批）。
 *
 * QQ 群消息里的表情是 `<faceType=6,faceId="0",ext="…">` 这种占位符，
 * 直接落库就会在站内显示成一串源码（站长实测）。
 * 表里没有的 id 统一降级成 `[表情]` —— 宁可少一个 emoji，也不能把源码甩给用户。
 */
const QQ_FACES: Record<string, string> = {
  "0": "🙂", "1": "😒", "2": "😍", "3": "😳", "4": "😎", "5": "😭", "6": "😊", "7": "🤐",
  "8": "😴", "9": "😩", "10": "😅", "11": "😡", "12": "😜", "13": "😁", "14": "😱", "15": "😞",
  "16": "😏", "17": "😰", "18": "😫", "19": "😷", "20": "😏", "21": "🥰", "22": "🙄", "23": "😤",
  "24": "😋", "25": "😪", "26": "😨", "27": "😓", "28": "😄", "29": "😌", "30": "💪", "31": "🤬",
  "32": "❓", "33": "🤫", "34": "😵", "35": "😖", "36": "😔", "37": "💀", "38": "🔨", "39": "👋",
  "40": "😅", "41": "👃", "42": "👏", "43": "😳", "44": "😏", "47": "🥱", "48": "👎", "49": "🥺",
  "50": "😢", "51": "😈", "52": "😘", "53": "😱", "54": "🥺", "55": "🔪", "56": "🍉", "57": "🍺",
  "58": "🏀", "59": "🏓", "60": "☕", "61": "🍚", "62": "🐷", "63": "🌹", "64": "🥀", "65": "💗",
  "66": "❤️", "67": "💔", "68": "🎂", "69": "⚡", "70": "💣", "71": "🔪", "72": "⚽", "74": "💩",
  "75": "🌙", "76": "☀️", "77": "🎁", "78": "🤗", "79": "👍", "80": "👎", "81": "🤝", "82": "✌️",
  "83": "🙏", "85": "👊", "86": "👎", "87": "💋", "88": "🙅", "89": "👌", "90": "💘", "91": "😚",
  "96": "🙇", "99": "👋", "100": "🤩", "178": "😊", "179": "😊", "182": "😂", "212": "😭",
}

/** 把 QQ 消息正文里的占位符转成人类可读内容（表情 / 图片 / @） */
export function normalizeQqText(raw: string): string {
  let text = raw
  // ① 系统表情：<faceType=6,faceId="0",ext="…">
  text = text.replace(/<faceType=\d+\s*,\s*faceId="(\d+)"[^>]*>/gi, (_m, id: string) => QQ_FACES[id] ?? "[表情]")
  // ② @ 占位
  text = text.replace(/<@!?[^>]+>/g, "")
  // ③ 图片：<img src="https://…"> / <image url="…"> → markdown 图片
  text = text.replace(/<(?:img|image)\b[^>]*?src=["']([^"']+)["'][^>]*>/gi, (_m, url: string) => `![](${url})`)
  text = text.replace(/<(?:img|image)\b[^>]*?url=["']([^"']+)["'][^>]*>/gi, (_m, url: string) => `![](${url})`)
  // ④ 其它 <tag> 形式的表情包/链接残留：<faceType=…> 已处理，这里兜底清掉无主尖括号标签
  text = text.replace(/<(?!\/?[a-z][^>]*>)[^>]{0,80}>/gi, "")
  return text.trim()
}

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
  const text = normalizeQqText(d.content ?? "")
  if (!text) return

  // 状态 / 羊毛：谁都能用，不需要先绑定账号
  if (await handlePrivateCommand(env, openid, text)) return

  // 只有绑定过才能用的命令
  const binding = await bindingByQq(env, openid)
  const cmd = (text.split(/\s+/)[0] ?? "").toLowerCase()
  const arg = text.slice(cmd.length).trim()

  if (cmd === "/bind" || cmd === "/start" || cmd === "bind" || cmd === "绑定") {
    if (!arg) return void (await sendC2c(env, openid, "用法：/bind 123456\n绑定码在网站「账号设置 → Telegram/QQ 绑定」生成（10 分钟有效、一次性）。"))
    return void (await handleQqBind(env, openid, arg))
  }

  if (cmd === "/help" || cmd === "/") {
    return void (await sendC2c(env, openid, ["DoulorCloud 机器人", "", "/bind 123456 或 绑定 123456　绑定站内账号", "/签到  每日签到（带按钮）", "/积分  查看积分余额", "/me  账号概览"].join("\n")))
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
    `INSERT INTO qq_bindings (qq_openid, user_id, bound_at, scope, group_openid) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(qq_openid) DO UPDATE SET user_id = excluded.user_id, bound_at = excluded.bound_at,
       scope = excluded.scope, group_openid = excluded.group_openid`
  )
    .bind(qqIdentityKey("c2c", openid), row.user_id, Date.now(), "c2c", null)
    .run()
  await env.DB.prepare("UPDATE tg_bind_tokens SET used_at = ? WHERE code = ?").bind(Date.now(), code).run()
  await logPush(env, "qq:bind", openid, true)
  await sendC2c(env, openid, "绑定成功 ✅ 试试 /签到 或 /积分。")
}

async function bindingByQq(
  env: Env,
  openid: string,
  scope: QqScope = "c2c"
): Promise<{ user_id: string } | null> {
  return await env.DB.prepare("SELECT user_id FROM qq_bindings WHERE qq_openid = ?")
    .bind(qqIdentityKey(scope, openid))
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

/** 短标识：把 openid 压成 6 位十六进制，界面上用于区分「哪个 QQ」 */
function shortTag(raw: string): string {
  let h = 0
  for (const ch of raw) h = (h * 31 + ch.charCodeAt(0)) % 0xffffff
  return h.toString(16).toUpperCase().padStart(6, "0")
}


/** GET /me/qq/binding */
export async function getMyQqBinding(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const rows = await env.DB.prepare(
    "SELECT qq_openid, bound_at, scope, group_openid, label FROM qq_bindings WHERE user_id = ? ORDER BY bound_at DESC"
  )
    .bind(user.id)
    .all<{ qq_openid: string; bound_at: number; scope: string; group_openid: string | null; label: string | null }>()
  const list = rows.results ?? []
  if (!list.length) return json({ bound: false, bindings: [] })
  return json({
    bound: true,
    // 列表形式：一个人可能同时有「群绑定」和「私聊绑定」（openid 作用域不同）
    bindings: list.map((r) => ({
      scope: r.scope === "group" ? "group" : "c2c",
      // QQ 官方 API 不返回 QQ 号，只能给稳定短标识让用户区分
      shortId: shortTag(r.qq_openid),
      label: r.label ?? "",
      boundAt: r.bound_at,
    })),
    count: list.length,
  })
}

/**
 * POST /me/qq/bind-code —— 生成一次性 6 位绑定码。
 *
 * ⚠️ 复用 `tg_bind_tokens` 这张表：绑定码本质是「某个 user_id 的一次性凭证」，
 * 与渠道无关。**谁先消费算谁的**（TG 或 QQ 都可以用它完成绑定）。
 */
export async function createMyQqBindCode(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  /**
   * 不要因为「已经绑过」就不给码（2026-10-24 站长踩到）。
   *
   * QQ 身份分作用域：群里是 member_openid（按群隔离）、私聊是 user_openid。
   * 所以「群绑定」和「私聊绑定」是两条独立记录，同一个人可以都绑（甚至绑多个群）。
   * 这里只把已有数量带回去做提示，**依然发新码**。
   */
  const existing = await env.DB.prepare("SELECT COUNT(*) AS c FROM qq_bindings WHERE user_id = ?")
    .bind(user.id)
    .first<{ c: number }>()
  const boundCount = existing?.c ?? 0

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
    boundCount,
    // QQ 没有 t.me 那种深链，前端给「去 QQ 搜机器人」的提示即可
    qqBotHint: "QQ 里搜索并添加机器人 DoulorCloud（QQ 4012701880），私聊或群里发送「绑定 码」",
  })
}

/** DELETE /me/qq/binding */
export async function deleteMyQqBinding(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const shortId = (new URL(request.url).searchParams.get("shortId") ?? "").trim().toUpperCase()
  if (shortId) {
    // 解掉指定那条（前端每条绑定后面的「解除」）
    const rows = await env.DB.prepare("SELECT qq_openid FROM qq_bindings WHERE user_id = ?")
      .bind(user.id)
      .all<{ qq_openid: string }>()
    const target = (rows.results ?? []).find((r) => shortTag(r.qq_openid) === shortId)
    if (!target) throw new ApiError(404, "找不到这条绑定", "NOT_FOUND")
    await env.DB.prepare("DELETE FROM qq_bindings WHERE qq_openid = ?").bind(target.qq_openid).run()
  } else {
    await env.DB.prepare("DELETE FROM qq_bindings WHERE user_id = ?").bind(user.id).run()
  }
  await logPush(env, "qq:unbind", user.id, true)
  return json({ ok: true })
}

/** 群内被动回复（带 msg_id 才是「被动」消息，不消耗主动消息配额） */

/**
 * 状态 / 羊毛 指令（2026-10-26）。谁都能用，靠每用户限流兜底。
 *
 * 返回 true 表示已消费该消息，调用方直接 return。
 */
async function handleGroupCommand(
  env: Env,
  groupOpenid: string,
  memberOpenid: string,
  verb: string,
  arg: string,
  msgId?: string,
  refBody = "",
  hasRef = false
): Promise<boolean> {
  const cmd_t0 = Date.now()
  const v = verb.replace(/^[\s/!！]+/, "")

  if (v === "状态" || v.toLowerCase() === "status") {
    // ⚠️ 不能在这里做外部 fetch：QQ webhook 要求快速应答，之前现场探测 3 个站点
    // 导致调用被 Canceled（tail 里可见），机器人表现为「完全没反应」。
    // 现在只读 D1 缓存（cron 写入），毫秒级返回。
    const rows = await env.DB.prepare(
      // 排除排查期误写进本表的调试行（dbg:*）与指令耗时行（cmd:*）
      "SELECT name, ok, detail, ms, checked_at FROM probe_latest WHERE name NOT LIKE 'dbg:%' AND name NOT LIKE 'cmd:%' ORDER BY name"
    ).all<{ name: string; ok: number; detail: string; ms: number; checked_at: number }>()
    const items = rows.results ?? []
    if (!items.length) {
      await sendGroupText(
        env,
        groupOpenid,
        "【Doulor 状态】\n暂无探测数据（探针尚未接入，下一版上线后这里会显示主站/中转站/模型状态）",
        msgId
      )
      return true
    }
    const lines = items.map((r) => `${r.ok ? "🟢" : "🔴"} ${r.name} — ${(r.detail || "").slice(0, 24)}${r.ms ? ` · ${r.ms}ms` : ""}`)
    const last = Math.max(...items.map((r) => r.checked_at || 0))
    const ago = last ? Math.max(0, Math.floor(Date.now() / 1000) - last) : 0
    let sentImg = false
    try {
      const { statusHtml, shotHtml } = await import("./qq-card")
      const rowsForCard = items.map((r) => ({ name: r.name, ok: !!r.ok, detail: (r.detail || "").slice(0, 22), ms: r.ms || 0 }))
      const png = await shotHtml(env, statusHtml(rowsForCard, `${ago}s 前 · ${rowsForCard.length} 项`))
      void logDbgRow(env, "IMGSIZE " + (png ? png.length : 0) + " browser=" + (env.BROWSER ? "yes" : "NO"))
      if (png && png.length > 1000) sentImg = await sendGroupImage(env, groupOpenid, png, msgId)
    } catch (e) {
      void logDbgRow(env, "IMGERRL " + (e instanceof Error ? e.message : String(e)).slice(0, 160))
    }
    if (!sentImg) {
      await sendGroupText(env, groupOpenid, `【Doulor 状态】${ago}s 前\n${lines.join("\n")}`, msgId)
    }
    console.log("cmd:状态 用时", Date.now() - cmd_t0, "ms；数据龄", ago, "s")
    return true
  }

  if (v === "模型" || v.toLowerCase() === "models") {
    // 左连清单：没探过的也列出来（ok = null → 显示「待探测」），这样清单是完整的
    const rows = await env.DB.prepare(
      `SELECT l.model AS model, p.ok AS ok, p.ms AS ms, p.checked_at AS checked_at
         FROM probe_model_list l LEFT JOIN probe_model_latest p ON p.model = l.model
        ORDER BY COALESCE(p.ok, -1) ASC, l.model`
    ).all<{ model: string; ok: number | null; ms: number | null; checked_at: number | null }>()
    const items = rows.results ?? []
    if (!items.length) {
      await sendGroupText(env, groupOpenid, "【模型状态】还没有探测数据（10 分钟一轮，稍后再试）", msgId)
      return true
    }
    const last = Math.max(...items.map((r) => r.checked_at || 0))
    const ago = last ? Math.max(0, Math.floor(Date.now() / 1000) - last) : 0
    const cardRows = items.map((r) => ({
      model: r.model,
      ok: r.ok === 1,
      ms: r.ms || 0,
      unknown: r.ok === null,
    }))
    let sent = false
    try {
      const { modelsHtml, shotHtml } = await import("./qq-card")
      const png = await shotHtml(env, modelsHtml(cardRows, `${ago}s 前 · 共 ${items.length} 个`))
      if (png && png.length > 1000) sent = await sendGroupImage(env, groupOpenid, png, msgId)
    } catch (e) {
      console.warn("模型出图失败:", e instanceof Error ? e.message : e)
    }
    if (!sent) {
      const body = items
        .map((r) => `${r.ok === null ? "⚪" : r.ok ? "🟢" : "🔴"} ${r.model}${r.ms ? ` · ${r.ms}ms` : ""}`)
        .join("\n")
      await sendGroupText(env, groupOpenid, `【模型状态】${ago}s 前\n${body.slice(0, 1400)}`, msgId)
    }
    return true
  }

  if (v === "羊毛") {
    let effArg = arg
    // 「引用某条消息 + @机器人 羊毛」→ 直接把被引用的正文当作要记的内容
    // 引用了但查不到正文：明确提示，别静默变成清单
    if (!effArg.trim() && !refBody) {
      if (hasRef) {
        await sendGroupText(
          env,
          groupOpenid,
          "没找到被引用的消息正文（可能机器人当时不在线）。可以改用「羊毛 加 内容」手动记录。",
          msgId
        )
        return true
      }
    }
    if (!effArg.trim() && refBody) effArg = "加 " + refBody
    else if (/^[^\s]+$/.test(effArg.trim()) && refBody && ["加", "add"].includes(effArg.trim().toLowerCase()))
      effArg = "加 " + refBody

    const m = /^(\S+)\s*([\s\S]*)$/.exec(effArg)
    const sub = (m?.[1] ?? "列表").toLowerCase()
    const rest = (m?.[2] ?? "").trim()
    const now = Math.floor(Date.now() / 1000)

    if (sub === "加" || sub === "add") {
      if (!rest) {
        await sendGroupText(env, groupOpenid, "用法：羊毛 加 <内容>（例如：羊毛 加 某云新人 10 元券）", msgId)
        return true
      }
      const maxSeq =
        (await env.DB.prepare(
          "SELECT MAX(seq) AS m FROM wool_items WHERE scope = 'group' AND scope_id = ?"
        ).bind(groupOpenid).first<{ m: number | null }>())?.m ?? 0
      const seq = maxSeq + 1
      const id = crypto.randomUUID()
      const ts = now
      await env.DB.prepare(
        `INSERT INTO wool_items (id, seq, title, source, status, scope, scope_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'open', 'group', ?, ?, ?, ?)`
      ).bind(id, seq, rest.slice(0, 120), "群友", groupOpenid, memberOpenid, ts, ts).run()
      await sendGroupText(env, groupOpenid, `✅ 已记录 #${seq}：${rest.slice(0, 60)}`, msgId)
      return true
    }

    if (sub === "完成" || sub === "done") {
      const seq = Number(rest)
      if (!Number.isFinite(seq)) {
        await sendGroupText(env, groupOpenid, "用法：羊毛 完成 <编号>", msgId)
        return true
      }
      const res = await env.DB.prepare(
        "UPDATE wool_items SET status = 'done', updated_at = ? WHERE scope = 'group' AND scope_id = ? AND seq = ?"
      ).bind(now, groupOpenid, seq).run()
      const n = res.meta?.changes ?? 0
      await sendGroupText(env, groupOpenid, n > 0 ? `✅ #${seq} 已标记为已领` : `没找到 #${seq}`, msgId)
      return true
    }

    // 取消标记：把已领/失效改回「未领」（误标记时用）
    if (sub === "取消" || sub === "undo" || sub === "恢复") {
      const seq = Number(rest)
      if (!Number.isFinite(seq)) {
        await sendGroupText(env, groupOpenid, "用法：羊毛 取消 <编号>（把「已领」改回未领）", msgId)
        return true
      }
      const res = await env.DB.prepare(
        "UPDATE wool_items SET status = 'open', updated_at = ? WHERE scope = 'group' AND scope_id = ? AND seq = ?"
      ).bind(now, groupOpenid, seq).run()
      const n = res.meta?.changes ?? 0
      await sendGroupText(env, groupOpenid, n > 0 ? `↩️ #${seq} 已改回未领` : `没找到 #${seq}`, msgId)
      return true
    }

    // 删除记录：彻底移除（记错了用这个）
    if (sub === "删除" || sub === "del" || sub === "remove") {
      const seq = Number(rest)
      if (!Number.isFinite(seq)) {
        await sendGroupText(env, groupOpenid, "用法：羊毛 删除 <编号>", msgId)
        return true
      }
      const res = await env.DB.prepare(
        "DELETE FROM wool_items WHERE scope = 'group' AND scope_id = ? AND seq = ?"
      ).bind(groupOpenid, seq).run()
      const n = res.meta?.changes ?? 0
      await sendGroupText(env, groupOpenid, n > 0 ? `🗑️ #${seq} 已删除` : `没找到 #${seq}`, msgId)
      return true
    }


    // 输入编号（羊毛 5 / 羊毛 #5）→ 回该条的文字详情，方便复制给朋友
    const numMatch = /^#?(\d+)$/.exec(sub)
    if (numMatch) {
      const seq = Number(numMatch[1])
      const woolDetail = await env.DB.prepare(
        `SELECT seq, title, source, link, value, note, status, expires_at, created_at
           FROM wool_items WHERE scope = 'group' AND scope_id = ? AND seq = ?`
      )
        .bind(groupOpenid, seq)
        .first<{
          seq: number
          title: string
          source: string | null
          link: string | null
          value: string | null
          note: string | null
          status: string
          expires_at: number | null
          created_at: number
        }>()
      if (!woolDetail) {
        await sendGroupText(env, groupOpenid, `没找到 #${seq}`, msgId)
        return true
      }
      const fmt = (sec: number) =>
        new Date(sec * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })
      const st =
        woolDetail.status === "done" ? "已领" : woolDetail.status === "dead" ? "已过期" : "未领"
      const lines2 = [`#${woolDetail.seq} ${woolDetail.title}`, `状态：${st}`]
      if (woolDetail.source) lines2.push(`来源：${woolDetail.source}`)
      if (woolDetail.value) lines2.push(`价值：${woolDetail.value}`)
      if (woolDetail.link) lines2.push(`链接：${woolDetail.link}`)
      if (woolDetail.note) lines2.push(`备注：${woolDetail.note}`)
      lines2.push(`记录：${fmt(woolDetail.created_at)}`)
      if (woolDetail.expires_at) lines2.push(`过期：${fmt(woolDetail.expires_at)}`)
      await sendGroupText(env, groupOpenid, lines2.join("\n"), msgId)
      return true
    }

    // 汇总：统计 + 未领条目归纳（站内提过要「能归纳」的需求）
    if (sub === "汇总" || sub === "summary") {
      const counts = await env.DB.prepare(
        `SELECT status, COUNT(*) AS n FROM wool_items WHERE scope = 'group' AND scope_id = ? GROUP BY status`
      )
        .bind(groupOpenid)
        .all<{ status: string; n: number }>()
      const c = { open: 0, done: 0, dead: 0 }
      for (const r of counts.results ?? []) {
        if (r.status === "open") c.open = r.n
        else if (r.status === "done") c.done = r.n
        else if (r.status === "dead") c.dead = r.n
      }
      const opens = await env.DB.prepare(
        `SELECT seq, title, created_at, expires_at FROM wool_items
          WHERE scope = 'group' AND scope_id = ? AND status = 'open'
          ORDER BY seq DESC LIMIT 8`
      )
        .bind(groupOpenid)
        .all<{ seq: number; title: string; created_at: number; expires_at: number | null }>()
      const openRows = (opens.results ?? []).map((r) => ({
        seq: r.seq,
        title: r.title,
        status: "未领",
        meta: r.expires_at
          ? `${Math.max(0, Math.ceil((r.expires_at - now) / 3600))} 小时后过期`
          : new Date(r.created_at * 1000).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" }),
      }))
      let sent = false
      try {
        const { woolSummaryHtml, shotHtml } = await import("./qq-card")
        const png = await shotHtml(env, woolSummaryHtml(c, openRows, `${c.open + c.done + c.dead} 条记录`))
        if (png && png.length > 1000) sent = await sendGroupImage(env, groupOpenid, png, msgId)
      } catch (e) {
        console.warn("羊毛汇总出图失败:", e instanceof Error ? e.message : e)
      }
      if (!sent) {
        const body = openRows.map((r) => `🎁 #${r.seq} ${r.title}`).join("\n") || "暂无未领的羊毛"
        await sendGroupText(
          env,
          groupOpenid,
          `【羊毛汇总】未领 ${c.open} / 已领 ${c.done} / 过期 ${c.dead}\n${body.slice(0, 1200)}`,
          msgId
        )
      }
      return true
    }

    // 默认：列表
    await env.DB.prepare(
      `UPDATE wool_items SET status = 'dead', updated_at = ?
        WHERE scope = 'group' AND scope_id = ? AND status = 'open' AND expires_at IS NOT NULL AND expires_at <= ?`
    ).bind(now, groupOpenid, now).run()
    // 分页：默认第 1 页，每页 10 条；「羊毛 2」「羊毛 列表 2」都指向第 2 页
    const totalRow = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM wool_items WHERE scope = 'group' AND scope_id = ?"
    )
      .bind(groupOpenid)
      .first<{ n: number }>()
    const total = totalRow?.n ?? 0
    const pages = Math.max(1, Math.ceil(total / 10))
    const isListSub = sub === "列表" || sub === "list"
    const woolPage = Math.min(Math.max(isListSub ? Number(rest) || 1 : 1, 1), pages)
    const rows = await env.DB.prepare(
      `SELECT seq, title, status FROM wool_items WHERE scope = 'group' AND scope_id = ?
        ORDER BY seq DESC LIMIT 10 OFFSET ?`
    )
      .bind(groupOpenid, (woolPage - 1) * 10)
      .all<{ seq: number; title: string; status: string }>()
    const items = rows.results ?? []
    if (!items.length) {
      await sendGroupText(env, groupOpenid, "还没有羊毛记录。用「羊毛 加 <内容>」记一条。", msgId)
      return true
    }
    const body = items
      .map((it) => {
        const tag = it.status === "done" ? "✅" : it.status === "dead" ? "⌛" : "🎁"
        return `${tag} #${it.seq} ${it.title}`
      })
      .join("\n")
    const open = items.filter((i) => i.status === "open").length
    // 优先出图，失败降级文字
      let woolImg = false
      try {
        const { woolHtml, shotHtml } = await import("./qq-card")
        const rowsForCard = items.map((it) => ({
          seq: it.seq,
          title: it.title,
          meta: it.status === "done" ? "已领" : it.status === "dead" ? "已过期" : "未领",
          status: it.status === "done" ? "已领" : it.status === "dead" ? "已过期" : "可领",
        }))
        const pageNote =
          pages > 1 ? `第 ${woolPage}/${pages} 页 · 共 ${total} 条` : `未领 ${open} 条 · 共 ${total} 条`
        const png = await shotHtml(env, woolHtml(rowsForCard, pageNote, "发「羊毛 编号」看某条详情"))
        if (png && png.length > 1000) woolImg = await sendGroupImage(env, groupOpenid, png, msgId)
      } catch (e) {
        console.warn("羊毛出图失败:", e instanceof Error ? e.message : e)
      }
      if (!woolImg) {
        await sendGroupText(
          env,
          groupOpenid,
          `【羊毛清单】第 ${woolPage}/${pages} 页 · 共 ${total} 条\n${body}`,
          msgId
        )
      }
    return true
  }

  return false
}

/** 被动回复序号：同一 msg_id 必须递增且 ≤5（官方 API v2 强制要求 msg_seq） */
const seqCache = new Map<string, number>()
function nextSeq(msgId: string): number {
  const cur = (seqCache.get(msgId) ?? 0) + 1
  const v = Math.min(cur, 5)
  seqCache.set(msgId, v)
  return v
}


/**
 * 发图片到群里（2026-10-27）。
 *   ① POST /v2/groups/{openid}/files {file_type:1, file_data:<base64>, srv_send_msg:0} → file_info
 *   ② POST /v2/groups/{openid}/messages {msg_type:7, media:{file_info}, msg_id, msg_seq}
 * 图片由 env.BROWSER 渲染（handlers/qq-card.ts），不需要任何服务器。
 */
async function sendGroupImage(
  env: Env,
  groupOpenid: string,
  png: Uint8Array,
  msgId?: string
): Promise<boolean> {
  await logDbgRow(env, "IMGCALL bytes=" + png.length)
  const cfg = await loadConfig(env)
  if (!cfg.enabled) return false
  const token = await accessToken(env, cfg)
  if (!token) return false

  // 分块转换：逐字符拼接在 Workers 里会超 CPU 限制
  let bin = ""
  const CHUNK = 8192
  for (let i = 0; i < png.length; i += CHUNK) {
    bin += String.fromCharCode(...png.subarray(i, Math.min(i + CHUNK, png.length)))
  }
  let fileData: string
  try {
    fileData = btoa(bin)
  } catch (e) {
    await logDbgRow(env, "IMGB64-THROW " + String((e as Error)?.message ?? e).slice(0, 120))
    return false
  }
  await logDbgRow(env, "IMGUPLOAD-START b64len=" + fileData.length)

  let up: Response
  try {
    up = await fetch(`${API}/v2/groups/${encodeURIComponent(groupOpenid)}/files`, {
      method: "POST",
      headers: { authorization: `QQBot ${token}`, "content-type": "application/json" },
      // 注意：不要带 srv_send_msg——带 false 会 400(40011000)，带 true 会"上传即发送"导致重复一张图。
      // 省略时返回 file_info 且不发送，再走 msg_type=7 精确回复（可带 msg_id，不烧主动额度）。
      body: JSON.stringify({ file_type: 1, file_data: fileData }),
    })
  } catch (e) {
    await logDbgRow(env, "IMGUPLOAD-THROW " + String((e as Error)?.message ?? e).slice(0, 160))
    return false
  }

  const upText = await up.text()
  await logDbgRow(env, "UPLOAD " + up.status + " " + upText.slice(0, 180))
  if (!up.ok) return false

  let fileInfo = ""
  try {
    fileInfo = (JSON.parse(upText) as { file_info?: string }).file_info ?? ""
  } catch {
    return false
  }
  if (!fileInfo) return false

  const body: Record<string, unknown> = { content: " ", msg_type: 7, media: { file_info: fileInfo } }
  if (msgId) {
    body.msg_id = msgId
    body.msg_seq = nextSeq(msgId)
  }
  const res = await fetch(`${API}/v2/groups/${encodeURIComponent(groupOpenid)}/messages`, {
    method: "POST",
    headers: { authorization: `QQBot ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  await logDbgRow(env, "SENDIMG " + res.status + " " + (await res.text()).slice(0, 140))
  return res.ok
}


/** 调试出口（当前为空实现，保留签名便于临时排查） */
/** 调试出口：保留签名但不再写库（排查结束后关闭，见 2026-10-27 清理） */
async function logDbgRow(_env: Env, _msg: string): Promise<void> {
  return
}

export async function sendGroupText(
  env: Env,
  groupOpenid: string,
  content: string,
  msgId?: string
): Promise<boolean> {
  const cfg = await loadConfig(env)
  if (!cfg.enabled) return false
  const token = await accessToken(env, cfg)
  if (!token) return false
  const send = async (withMsgId: boolean): Promise<{ ok: boolean; err?: string }> => {
    const res = await fetch(`${API}/v2/groups/${encodeURIComponent(groupOpenid)}/messages`, {
      method: "POST",
      headers: { authorization: `QQBot ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        content: content.slice(0, 1500),
        msg_type: 0,
        ...(withMsgId && msgId ? { msg_id: msgId, msg_seq: nextSeq(msgId) } : {}),
      }),
    })
    if (res.ok) return { ok: true }
    const t = await res.text().catch(() => "")
    return { ok: false, err: t.slice(0, 200) }
  }

  /**
   * 双保险（2026-10-24 实测教训）：
   *   先按「被动回复」发（带 msg_id，不烧主动消息配额）；
   *   万一平台说 msg_id 无效/越权（比如事件重投、或我们重试过晚），
   *   再退化成**普通群消息**发一次 —— 宁可烧一条配额，也不能让用户
   *   绑成功了却看不到任何确认（站长就是被这个坑到的）。
   */
  let r = await send(false)
  if (!r.ok) {
    await logPush(env, "qq:group:reply:passive", groupOpenid, false, r.err)
    r = await send(false)
    if (r.ok) await logPush(env, "qq:group:reply:active", groupOpenid, true)
  }
  await logPush(env, "qq:group:reply", groupOpenid, r.ok, r.ok ? undefined : r.err)
  return r.ok
}

/**
 * 群里 `/bind <码>`。
 *
 * 安全考量：绑定码是一次性的、且在群里发出后**本群其它成员也可能看到**。
 * 所以这里只回「绑定成功 / 无效」这类不含账号信息的短句，绝不回显账号名或邮箱。
 */
async function handleGroupBind(
  env: Env,
  memberOpenid: string,
  groupOpenid: string,
  code: string,
  msgId?: string
): Promise<void> {
  /**
   * 绑定失败要说清是哪种（2026-10-24 站长被"无效或已过期"绕了一圈）：
   *   ① 已经绑过了 → 直接告诉他「已绑定」，不用再找码
   *   ② 这个码用过了（一次性）→ 说「已被使用」而不是含糊的"无效"
   *   ③ 这个码过期了 → 说「已过期」
   *   ④ 根本没这个码 → 说「没有这个码」
   */
  const taken = await bindingByQq(env, memberOpenid, "group")
  if (taken) {
    await sendGroupText(
      env,
      groupOpenid,
      "你在这个群已经绑定过账号了 ✅\n发言会自动记在你的账号名下；想换号请先到网站解绑。",
      msgId
    )
    return
  }

  const any = await env.DB.prepare(
    "SELECT user_id, used_at, expires_at FROM tg_bind_tokens WHERE code = ?"
  )
    .bind(code)
    .first<{ user_id: string; used_at: number | null; expires_at: number }>()
  if (!any) {
    await sendGroupText(env, groupOpenid, "没有这个绑定码，回网站「账号设置 → QQ 绑定」重新生成一个。", msgId)
    return
  }
  if (any.used_at) {
    await sendGroupText(
      env,
      groupOpenid,
      "这个绑定码**已经被用过了**（绑定码是一次性的）—— 回网站重新生成一个新的再发。",
      msgId
    )
    return
  }
  if (any.expires_at <= Date.now()) {
    await sendGroupText(env, groupOpenid, "这个绑定码已过期（10 分钟有效），回网站重新生成一个。", msgId)
    return
  }
  await env.DB.prepare(
    `INSERT INTO qq_bindings (qq_openid, user_id, bound_at, scope, group_openid) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(qq_openid) DO UPDATE SET user_id = excluded.user_id, bound_at = excluded.bound_at,
       scope = excluded.scope, group_openid = excluded.group_openid`
  )
    .bind(qqIdentityKey("group", memberOpenid), any.user_id, Date.now(), "group", groupOpenid)
    .run()
  await env.DB.prepare("UPDATE tg_bind_tokens SET used_at = ? WHERE code = ?").bind(Date.now(), code).run()
  await logPush(env, "qq:bind:group", groupOpenid, true)
  await sendGroupText(env, groupOpenid, "绑定成功 ✅ 之后你在这个群的发言会记在你的账号名下。", msgId)
}

/**
 * PATCH /me/qq/binding —— 设置备注（用户可以把 QQ 号写进来）。
 *
 * QQ 官方 API 不返回 QQ 号（只给 openid，且不可反查），
 * 所以「这条绑定是哪个 QQ」只能由用户自己标注，界面上原样显示。
 */
export async function setMyQqLabel(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const raw = new TextDecoder().decode(await readBodyCapped(request, 2 * 1024, "备注过长"))
  const body = JSON.parse(raw || "{}") as { label?: string }
  const label = (body.label ?? "").trim().slice(0, 40)
  const res = await env.DB.prepare("UPDATE qq_bindings SET label = ? WHERE user_id = ?")
    .bind(label || null, user.id)
    .run()
  if (!res.meta.changes) throw new ApiError(404, "还没绑定 QQ", "NOT_BOUND")
  return json({ ok: true, label })
}

/**
 * 私聊指令（2026-10-27）：状态 / 羊毛。
 *
 * 和群里共用同一套表，但 scope='private'、scope_id=用户 openid，
 * 所以私聊记的羊毛不会串到群里。私聊先只回文本（图片走 /v2/users 的
 * 上传接口，还没接），够用且稳定。
 */
async function handlePrivateCommand(env: Env, openid: string, text: string): Promise<boolean> {
  const m = /^[\s/!！]*(状态|status|羊毛)\s*([\s\S]*)$/i.exec(text.trim())
  if (!m) return false
  const verb = m[1]
  const rest0 = (m[2] || "").trim()

  if (verb === "状态" || verb.toLowerCase() === "status") {
    const rows = await env.DB.prepare(
      "SELECT name, ok, detail, ms, checked_at FROM probe_latest WHERE name NOT LIKE 'dbg:%' AND name NOT LIKE 'cmd:%' ORDER BY name"
    ).all<{ name: string; ok: number; detail: string; ms: number; checked_at: number }>()
    const items = rows.results ?? []
    if (!items.length) {
      await sendC2c(env, openid, "【Doulor 状态】暂无探测数据")
      return true
    }
    const lines = items.map((r) => `${r.ok ? "🟢" : "🔴"} ${r.name} — ${(r.detail || "").slice(0, 24)}${r.ms ? ` · ${r.ms}ms` : ""}`)
    const last = Math.max(...items.map((r) => r.checked_at || 0))
    const ago = last ? Math.max(0, Math.floor(Date.now() / 1000) - last) : 0
    await sendC2c(env, openid, `【Doulor 状态】${ago}s 前\n${lines.join("\n")}`)
    return true
  }

  // ---- 羊毛（私聊）----
  const now = Math.floor(Date.now() / 1000)
  const seg = /^(\S+)\s*([\s\S]*)$/.exec(rest0)
  const sub = (seg?.[1] ?? "列表").toLowerCase()
  const rest = (seg?.[2] ?? "").trim()

  const nextSeq = async (): Promise<number> => {
    const r = await env.DB.prepare(
      "SELECT MAX(seq) AS m FROM wool_items WHERE scope = 'private' AND scope_id = ?"
    )
      .bind(openid)
      .first<{ m: number | null }>()
    return (r?.m ?? 0) + 1
  }

  if (sub === "加" || sub === "add") {
    if (!rest) {
      await sendC2c(env, openid, "用法：羊毛 加 <内容>")
      return true
    }
    const seq = await nextSeq()
    await env.DB.prepare(
      `INSERT INTO wool_items (id, seq, title, source, status, scope, scope_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, '私聊', 'open', 'private', ?, ?, ?, ?)`
    )
      .bind(crypto.randomUUID(), seq, rest.slice(0, 120), openid, openid, now, now)
      .run()
    await sendC2c(env, openid, `✅ 已记录 #${seq}：${rest.slice(0, 60)}`)
    return true
  }

  if (sub === "完成" || sub === "done" || sub === "取消" || sub === "undo" || sub === "删除" || sub === "del") {
    const seq = Number(rest)
    if (!Number.isFinite(seq)) {
      await sendC2c(env, openid, "用法：羊毛 完成/取消/删除 <编号>")
      return true
    }
    if (sub === "删除" || sub === "del") {
      const r = await env.DB.prepare(
        "DELETE FROM wool_items WHERE scope = 'private' AND scope_id = ? AND seq = ?"
      )
        .bind(openid, seq)
        .run()
      await sendC2c(env, openid, (r.meta?.changes ?? 0) > 0 ? `🗑️ #${seq} 已删除` : `没找到 #${seq}`)
      return true
    }
    const open = sub === "完成" || sub === "done" ? 0 : 1
    const r = await env.DB.prepare(
      "UPDATE wool_items SET status = ?, updated_at = ? WHERE scope = 'private' AND scope_id = ? AND seq = ?"
    )
      .bind(open ? "open" : "done", now, openid, seq)
      .run()
    const okN = (r.meta?.changes ?? 0) > 0
    await sendC2c(env, openid, okN ? (open ? `↩️ #${seq} 已改回未领` : `✅ #${seq} 已标记为已领`) : `没找到 #${seq}`)
    return true
  }

  // 默认：列表
  const rows = await env.DB.prepare(
    "SELECT seq, title, status FROM wool_items WHERE scope = 'private' AND scope_id = ? ORDER BY seq DESC LIMIT 10"
  )
    .bind(openid)
    .all<{ seq: number; title: string; status: string }>()
  const items = rows.results ?? []
  if (!items.length) {
    await sendC2c(env, openid, "还没有羊毛记录。用「羊毛 加 <内容>」记一条。")
    return true
  }
  const body = items
    .map((it) => `${it.status === "done" ? "✅" : it.status === "dead" ? "⌛" : "🎁"} #${it.seq} ${it.title}`)
    .join("\n")
  await sendC2c(env, openid, `【羊毛清单】\n${body}`)
  return true
}

