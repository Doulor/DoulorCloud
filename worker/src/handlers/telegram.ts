/**
 * TG 机器人（DoulorCloud Bot）：配置、绑定、推送、命令。
 *
 * ## 权限模型（三层，缺一不可）
 *
 * **第 1 层 站内管理端**：`/admin/tg/*` 全部走 `requireAdminScope(env, request, "telegram")`，
 * 非管理员在 `isAnyAdmin` 那一步就被 403 挡住，不会泄露「这个页面存在」。
 *
 * **第 2 层 机器人调用者**：只能通过**一次性绑定码**建立 `tg_bindings`——
 *   站内生成 6 位码（10 分钟过期、单次使用）→ bot 里 `/bind 123456`。
 *   **绝不接受在 bot 里输入账号密码/邮箱验证**：那样一旦 bot 被冒充就是全站撞库。
 *   命令一律用绑定记录的 `user_id` 查数据，不用 telegram_id 直接查业务表，
 *   保证「只能看自己」。
 *
 * **第 3 层 管理命令**：`/status` 之类要求「telegram_id 已绑定」**且**对应站内账号
 *   `isAnyAdmin(role)`。任一不满足就**静默忽略**（不回「你没权限」），
 *   否则 bot 就成了一个权限探测器。
 *
 * ## 其它硬约束
 * · **只处理私聊**：群聊里的任何命令直接丢弃，避免把用户数据发到群里。
 * · **命令限流**：同一 telegram_id 60 秒内超过 10 条即丢弃（用 `tg_push_log` 计数）。
 * · **Token 不落明文**：`encryptSecret(Bot Token, env.SESSION_SECRET)`，
 *   读取接口永远只返回 `8887249358:AAHx****HPck` 这种脱敏值；日志里也不打。
 * · **回调来源校验**：Telegram 每次回调都带 `X-Telegram-Bot-Api-Secret-Token`，
 *   与库里 `webhook_secret` 比对，不匹配 401——否则任何人都能伪造 update 刷我们接口。
 */

import { ApiError, json, readBodyCapped } from "../http"
import { requireUser, isAnyAdmin } from "../auth"
import { requireAdminScope } from "./admin"
import { audit as recordAudit } from "../settings"
import { decryptSecret, encryptSecret, uuid } from "../crypto"
import type { Env } from "../env"

const TG_API = "https://api.telegram.org"
const BIND_CODE_TTL_MS = 10 * 60 * 1000
/** 60 秒窗口内允许的命令条数 */
const CMD_RATE_LIMIT = 10
const CMD_RATE_WINDOW_MS = 60 * 1000

export interface TgConfigRow {
  id: number
  enabled: number
  token_enc: string | null
  bot_username: string | null
  webhook_secret: string | null
  commands_json: string
  pushes_json: string
  updated_at: number
  updated_by: string | null
}

interface BindingRow {
  telegram_id: string
  user_id: string
  tg_username: string | null
  bound_at: number
  muted_json: string
  last_seen_at: number | null
}

/** 命令开关默认值：`/me` `/frp` `/help` 开，`/status` 仅管理员可见（这里只控开关，权限另判） */
const DEFAULT_COMMANDS: Record<string, boolean> = {
  me: true,
  frp: true,
  status: true,
  help: true,
}

/** 推送开关默认值：先全开，用户可在页面上逐项关 */
const DEFAULT_PUSHES: Record<string, boolean> = {
  login: true,
  frpExpiry: true,
  nodeDown: true,
  daily: true,
}

/** 加密密钥：SESSION_SECRET 缺失时直接报错（不能静默用空串当密钥） */
function requireSessionSecret(env: Env): string {
  const s = env.SESSION_SECRET
  if (!s) {
    throw new ApiError(500, "服务端未配置 SESSION_SECRET，无法加密 Bot Token", "NO_SECRET")
  }
  return s
}

/** 带体积上限的 JSON 读取（http.ts 的 readBodyCapped 只返回 ArrayBuffer） */
async function readJson<T>(request: Request, maxBytes: number): Promise<T> {
  const buf = await readBodyCapped(request, maxBytes, "请求体过大")
  try {
    return JSON.parse(new TextDecoder().decode(buf)) as T
  } catch {
    throw new ApiError(400, "请求体不是合法 JSON", "BAD_JSON")
  }
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    const v = JSON.parse(raw)
    return (v && typeof v === "object" ? v : fallback) as T
  } catch {
    return fallback
  }
}

/** 脱敏：只留 bot_id 与前缀 + 末 4 位，页面/日志都用这个 */
export function maskToken(token: string | null | undefined): string {
  if (!token) return ""
  const [id, rest] = token.split(":")
  if (!rest) return "***"
  const tail = rest.slice(-4)
  return `${id}:${rest.slice(0, 4)}****${tail}`
}

async function loadConfig(env: Env): Promise<TgConfigRow> {
  const row = await env.DB.prepare("SELECT * FROM tg_bot_config WHERE id = 1").first<TgConfigRow>()
  if (row) return row
  await env.DB.prepare("INSERT OR IGNORE INTO tg_bot_config (id) VALUES (1)").run()
  const fresh = await env.DB.prepare("SELECT * FROM tg_bot_config WHERE id = 1").first<TgConfigRow>()
  return (
    fresh ?? {
      id: 1,
      enabled: 0,
      token_enc: null,
      bot_username: null,
      webhook_secret: null,
      commands_json: "{}",
      pushes_json: "{}",
      updated_at: 0,
      updated_by: null,
    }
  )
}

/** 解出明文 token；未配置返回 null（调用方必须处理，不能把 null 拼进 URL） */
async function botToken(env: Env, config?: TgConfigRow): Promise<string | null> {
  const cfg = config ?? (await loadConfig(env))
  if (!cfg.token_enc) return null
  try {
    return await decryptSecret(cfg.token_enc, requireSessionSecret(env))
  } catch {
    // 密钥轮换后旧密文解不开：当作未配置，让页面重新填一次
    return null
  }
}

async function tgApi(
  env: Env,
  method: string,
  payload: Record<string, unknown>,
  token?: string | null
): Promise<{ ok: boolean; result?: unknown; description?: string }> {
  const t = token ?? (await botToken(env))
  if (!t) return { ok: false, description: "BOT_TOKEN_MISSING" }
  try {
    const res = await fetch(`${TG_API}/bot${t}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
    return (await res.json()) as { ok: boolean; result?: unknown; description?: string }
  } catch (err) {
    return { ok: false, description: err instanceof Error ? err.message : String(err) }
  }
}

async function logPush(
  env: Env,
  kind: string,
  target: string,
  ok: boolean,
  error?: string
): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO tg_push_log (id, kind, target, ok, error, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(uuid(), kind, target, ok ? 1 : 0, error ? error.slice(0, 300) : null, Date.now())
      .run()
  } catch {
    // 审计写失败不能影响主流程
  }
}

/** 同一 telegram_id 的命令限流（命令本身也会记进 tg_push_log，kind='cmd'） */
async function withinRateLimit(env: Env, telegramId: string): Promise<boolean> {
  const since = Date.now() - CMD_RATE_WINDOW_MS
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM tg_push_log WHERE target = ? AND kind = 'cmd' AND created_at > ?"
  )
    .bind(telegramId, since)
    .first<{ n: number }>()
  return (row?.n ?? 0) < CMD_RATE_LIMIT
}

async function bindingByTg(env: Env, telegramId: string): Promise<BindingRow | null> {
  return await env.DB.prepare("SELECT * FROM tg_bindings WHERE telegram_id = ?")
    .bind(telegramId)
    .first<BindingRow>()
}

async function sendTo(env: Env, chatId: string, text: string): Promise<boolean> {
  const r = await tgApi(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  })
  await logPush(env, "message", chatId, r.ok, r.ok ? undefined : r.description)
  return r.ok
}

/* ==========================================================================
 * 管理端接口（全部 requireAdminScope("telegram")）
 * ========================================================================== */

/** GET /admin/tg/config —— 只吐脱敏值，永不返回 token 明文 */
export async function getAdminConfig(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "telegram")
  const cfg = await loadConfig(env)
  const token = await botToken(env, cfg)
  const since = Date.now() - 24 * 3600 * 1000
  const stat = await env.DB.prepare(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed FROM tg_push_log WHERE created_at > ?"
  )
    .bind(since)
    .first<{ total: number | null; failed: number | null }>()
  const bound = await env.DB.prepare("SELECT COUNT(*) AS n FROM tg_bindings").first<{ n: number }>()
  return json({
    enabled: !!cfg.enabled,
    hasToken: !!token,
    tokenMasked: maskToken(token),
    botUsername: cfg.bot_username,
    webhookSet: !!cfg.webhook_secret,
    commands: { ...DEFAULT_COMMANDS, ...parseJson<Record<string, boolean>>(cfg.commands_json, {}) },
    pushes: { ...DEFAULT_PUSHES, ...parseJson<Record<string, boolean>>(cfg.pushes_json, {}) },
    stats: { total24h: stat?.total ?? 0, failed24h: stat?.failed ?? 0, boundUsers: bound?.n ?? 0 },
    updatedAt: cfg.updated_at,
  })
}

interface ConfigUpdateBody {
  enabled?: boolean
  token?: string
  commands?: Record<string, boolean>
  pushes?: Record<string, boolean>
  rotateSecret?: boolean
}

/**
 * POST /admin/tg/config —— 局部更新。
 * 传 `token` 时先 `getMe` 验真再落库（避免存一个错 token 还显示「已配置」）；
 * 落库前用 SESSION_SECRET 加密，审计只记脱敏值。
 */
export async function updateAdminConfig(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "telegram")
  const body = await readJson<ConfigUpdateBody>(request, 8 * 1024)
  const sets: string[] = []
  const binds: unknown[] = []
  let note = ""

  if (typeof body.enabled === "boolean") {
    sets.push("enabled = ?")
    binds.push(body.enabled ? 1 : 0)
    note += body.enabled ? "启用 " : "停用 "
  }

  if (typeof body.token === "string" && body.token.trim()) {
    const raw = body.token.trim()
    if (!/^\d{5,}:[A-Za-z0-9_\-]{30,}$/.test(raw)) {
      throw new ApiError(400, "Bot Token 格式不对（应为 数字:字母数字串）", "BAD_TOKEN")
    }
    const me = await tgApi(env, "getMe", {}, raw)
    if (!me.ok) {
      throw new ApiError(400, `Token 校验失败：${me.description ?? "未知错误"}`, "BAD_TOKEN")
    }
    const username = (me.result as { username?: string } | undefined)?.username ?? null
    sets.push("token_enc = ?", "bot_username = ?")
    binds.push(await encryptSecret(raw, requireSessionSecret(env)), username)
    note += "更新 Token "
  }

  if (body.commands && typeof body.commands === "object") {
    sets.push("commands_json = ?")
    binds.push(JSON.stringify({ ...DEFAULT_COMMANDS, ...body.commands }))
    note += "命令开关 "
  }
  if (body.pushes && typeof body.pushes === "object") {
    sets.push("pushes_json = ?")
    binds.push(JSON.stringify({ ...DEFAULT_PUSHES, ...body.pushes }))
    note += "推送开关 "
  }
  if (body.rotateSecret) {
    sets.push("webhook_secret = ?")
    binds.push(uuid().replace(/-/g, ""))
    note += "轮换回调密钥 "
  }

  if (sets.length === 0) {
    return json({ ok: true, changed: false })
  }
  sets.push("updated_at = ?", "updated_by = ?")
  binds.push(Date.now(), admin.id)
  await env.DB.prepare(`UPDATE tg_bot_config SET ${sets.join(", ")} WHERE id = 1`)
    .bind(...binds)
    .run()
  await recordAudit(env, admin.id, "tg.config.update", note.trim() || "无变化")
  return json({ ok: true, changed: true })
}

/** POST /admin/tg/webhook —— 用已存的 token + secret 调 setWebhook（url 由服务端拼，不接受前端传） */
export async function setWebhook(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "telegram")
  const cfg = await loadConfig(env)
  const token = await botToken(env, cfg)
  if (!token) throw new ApiError(400, "还没配置 Bot Token", "NO_TOKEN")
  let secret = cfg.webhook_secret
  if (!secret) {
    secret = uuid().replace(/-/g, "")
    await env.DB.prepare("UPDATE tg_bot_config SET webhook_secret = ?, updated_at = ? WHERE id = 1")
      .bind(secret, Date.now())
      .run()
  }
  const url = new URL(request.url)
  const hookUrl = `${url.origin}/api/tg/webhook`
  const r = await tgApi(
    env,
    "setWebhook",
    { url: hookUrl, secret_token: secret, allowed_updates: ["message"] },
    token
  )
  if (!r.ok) throw new ApiError(400, `设置失败：${r.description ?? "未知错误"}`, "SET_WEBHOOK_FAILED")
  await recordAudit(env, admin.id, "tg.webhook.set", hookUrl)
  return json({ ok: true, url: hookUrl })
}

/** POST /admin/tg/webhook/delete */
export async function deleteWebhook(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "telegram")
  const r = await tgApi(env, "deleteWebhook", {})
  if (!r.ok) throw new ApiError(400, `取消失败：${r.description ?? "未知错误"}`, "DELETE_WEBHOOK_FAILED")
  await recordAudit(env, admin.id, "tg.webhook.delete", "")
  return json({ ok: true })
}

/** POST /admin/tg/test —— 给所有已绑定的管理员发一条测试消息 */
export async function testPush(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "telegram")
  const token = await botToken(env)
  if (!token) throw new ApiError(400, "还没配置 Bot Token", "NO_TOKEN")
  const targets = await adminTargets(env)
  if (targets.length === 0) {
    return json({ ok: false, sent: 0, message: "还没有管理员绑定 Telegram（先在页面上生成绑定码）" })
  }
  const text = `✅ <b>DoulorCloud 机器人连通正常</b>\n👤 触发者：${admin.username}\n🕒 ${new Date().toLocaleString("zh-CN", { hour12: false })}`
  let sent = 0
  for (const t of targets) {
    if (await sendTo(env, t, text)) sent++
  }
  return json({ ok: sent > 0, sent, total: targets.length })
}

/** GET /admin/tg/bindings */
export async function listBindings(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "telegram")
  const { results } = await env.DB.prepare(
    `SELECT b.telegram_id, b.user_id, b.tg_username, b.bound_at, b.muted_json, u.username, u.role
       FROM tg_bindings b LEFT JOIN users u ON u.id = b.user_id
      ORDER BY b.bound_at DESC
      LIMIT 200`
  ).all<{
    telegram_id: string
    user_id: string
    tg_username: string | null
    bound_at: number
    muted_json: string
    username: string | null
    role: string | null
  }>()
  return json({
    bindings: (results ?? []).map((r) => ({
      telegramId: r.telegram_id,
      userId: r.user_id,
      username: r.username,
      role: r.role,
      tgUsername: r.tg_username,
      boundAt: r.bound_at,
      muted: parseJson<string[]>(r.muted_json, []),
    })),
  })
}

/** DELETE /admin/tg/bindings/:telegramId */
export async function deleteBinding(
  env: Env,
  request: Request,
  telegramId: string
): Promise<Response> {
  const admin = await requireAdminScope(env, request, "telegram")
  await env.DB.prepare("DELETE FROM tg_bindings WHERE telegram_id = ?").bind(telegramId).run()
  await recordAudit(env, admin.id, "tg.binding.delete", telegramId)
  return json({ ok: true })
}

/** GET /admin/tg/logs */
export async function listLogs(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "telegram")
  const { results } = await env.DB.prepare(
    "SELECT id, kind, target, ok, error, created_at FROM tg_push_log ORDER BY created_at DESC LIMIT 100"
  ).all<{ id: string; kind: string; target: string | null; ok: number; error: string | null; created_at: number }>()
  return json({ logs: results ?? [] })
}

/**
 * POST /me/tg/bind-code —— **普通用户**即可调用（requireUser，不是 admin）。
 * 生成 6 位一次性码，10 分钟内到 bot 里 `/bind <码>` 完成绑定。
 */
export async function createBindCode(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const existing = await env.DB.prepare("SELECT telegram_id FROM tg_bindings WHERE user_id = ?")
    .bind(user.id)
    .first<{ telegram_id: string }>()
  if (existing) {
    return json({ ok: true, alreadyBound: true, telegramId: existing.telegram_id })
  }
  // 6 位数字，避免 0 开头被前端吃掉就补 1
  const code = String(Math.floor(100000 + Math.random() * 900000))
  const now = Date.now()
  await env.DB.prepare("DELETE FROM tg_bind_tokens WHERE user_id = ? AND used_at IS NULL")
    .bind(user.id)
    .run()
  await env.DB.prepare(
    "INSERT INTO tg_bind_tokens (code, user_id, expires_at, used_at) VALUES (?, ?, ?, NULL)"
  )
    .bind(code, user.id, now + BIND_CODE_TTL_MS)
    .run()
  return json({ ok: true, code, expiresAt: now + BIND_CODE_TTL_MS })
}

/* ==========================================================================
 * 机器人回调
 * ========================================================================== */

interface TgUpdate {
  message?: {
    text?: string
    chat?: { id?: number; type?: string }
    from?: { id?: number; username?: string }
  }
}

function adminTargets(env: Env): Promise<string[]> {
  return env.DB.prepare(
    `SELECT b.telegram_id FROM tg_bindings b JOIN users u ON u.id = b.user_id
      WHERE u.role IN ('root', 'superadmin', 'admin')`
  )
    .all<{ telegram_id: string }>()
    .then((r) => (r.results ?? []).map((x) => x.telegram_id))
}

function helpText(isAdminUser: boolean): string {
  const lines = [
    "<b>DoulorCloud 机器人</b>",
    "",
    "/bind &lt;绑定码&gt; —— 绑定站内账号（在网站「账号设置」里生成）",
    "/me —— 我的账号概览",
    "/unbind —— 解除绑定",
  ]
  if (isAdminUser) {
    lines.push("/status —— 站点与机器人状态（仅管理员）")
  }
  lines.push("", "🌐 cloud.doulor.cn")
  return lines.join("\n")
}

/**
 * POST /tg/webhook（公开入口）。
 * 注意：**永远返回 200**（除非回调密钥不对）——返回 4xx/5xx 会让 Telegram 反复重投，
 * 一条畸形 update 就能把我们打出一堆重复消息。
 */
export async function handleWebhook(env: Env, request: Request): Promise<Response> {
  const cfg = await loadConfig(env)
  if (!cfg.enabled) return json({ ok: true, ignored: "disabled" })
  const secret = request.headers.get("x-telegram-bot-api-secret-token") ?? ""
  if (!cfg.webhook_secret || secret !== cfg.webhook_secret) {
    // 来源不可信：这里必须硬拒，否则任何人都能伪造 update 让 bot 发消息
    throw new ApiError(401, "回调来源校验失败", "BAD_WEBHOOK_SECRET")
  }

  let update: TgUpdate
  try {
    update = (await request.json()) as TgUpdate
  } catch {
    return json({ ok: true, ignored: "bad-json" })
  }

  const msg = update.message
  const chatId = msg?.chat?.id != null ? String(msg.chat.id) : ""
  const text = (msg?.text ?? "").trim()
  if (!chatId || !text) return json({ ok: true, ignored: "no-text" })
  // 只处理私聊：群聊里一律不理，避免用户数据泄露到群里
  if (msg?.chat?.type !== "private") return json({ ok: true, ignored: "not-private" })

  if (!(await withinRateLimit(env, chatId))) {
    return json({ ok: true, ignored: "rate-limited" })
  }
  await logPush(env, "cmd", chatId, true)

  const cmd = (text.split(/\s+/)[0] || "").split("@")[0].toLowerCase()
  const arg = text.slice(cmd.length).trim()
  const commands = { ...DEFAULT_COMMANDS, ...parseJson<Record<string, boolean>>(cfg.commands_json, {}) }

  // 自服务命令：/start /help /bind 不需要已绑定
  if (cmd === "/start" || cmd === "/help" || cmd === "/bind") {
    if (cmd === "/bind") {
      if (!arg) {
        await sendTo(env, chatId, "用法：<code>/bind 123456</code>\n绑定码在网站「账号设置 → Telegram 绑定」里生成。")
        return json({ ok: true })
      }
      const row = await env.DB.prepare(
        "SELECT * FROM tg_bind_tokens WHERE code = ? AND used_at IS NULL AND expires_at > ?"
      )
        .bind(arg, Date.now())
        .first<{ code: string; user_id: string; expires_at: number }>()
      if (!row) {
        await sendTo(env, chatId, "❌ 绑定码无效或已过期，回网站重新生成一个。")
        return json({ ok: true })
      }
      const taken = await bindingByTg(env, chatId)
      if (taken && taken.user_id !== row.user_id) {
        await sendTo(env, chatId, "❌ 这个 Telegram 已经绑定了别的账号，先 /unbind。")
        return json({ ok: true })
      }
      await env.DB.prepare(
        `INSERT INTO tg_bindings (telegram_id, user_id, tg_username, bound_at, muted_json)
         VALUES (?, ?, ?, ?, '[]')
         ON CONFLICT(telegram_id) DO UPDATE SET user_id = excluded.user_id, bound_at = excluded.bound_at`
      )
        .bind(chatId, row.user_id, msg?.from?.username ?? null, Date.now())
        .run()
      await env.DB.prepare("UPDATE tg_bind_tokens SET used_at = ? WHERE code = ?")
        .bind(Date.now(), arg)
        .run()
      const u = await env.DB.prepare("SELECT username, role FROM users WHERE id = ?")
        .bind(row.user_id)
        .first<{ username: string; role: string }>()
      await sendTo(
        env,
        chatId,
        `✅ 绑定成功：<b>${u?.username ?? ""}</b>\n发送 /help 查看可用命令。`
      )
      return json({ ok: true })
    }
    const bound = await bindingByTg(env, chatId)
    const role = bound
      ? (
          await env.DB.prepare("SELECT role FROM users WHERE id = ?")
            .bind(bound.user_id)
            .first<{ role: string }>()
        )?.role ?? ""
      : ""
    await sendTo(env, chatId, helpText(isAnyAdmin(role)))
    return json({ ok: true })
  }

  // 以下命令要求已绑定
  const binding = await bindingByTg(env, chatId)
  if (!binding) {
    await sendTo(env, chatId, "还没绑定账号。回网站「账号设置 → Telegram 绑定」生成绑定码，再 <code>/bind 123456</code>。")
    return json({ ok: true })
  }
  await env.DB.prepare("UPDATE tg_bindings SET last_seen_at = ? WHERE telegram_id = ?")
    .bind(Date.now(), chatId)
    .run()
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(binding.user_id)
    .first<Record<string, unknown>>()
  if (!user) {
    await sendTo(env, chatId, "账号不存在了，请重新绑定。")
    return json({ ok: true })
  }
  const role = String(user.role ?? "")

  if (cmd === "/unbind") {
    await env.DB.prepare("DELETE FROM tg_bindings WHERE telegram_id = ?").bind(chatId).run()
    await sendTo(env, chatId, "已解除绑定。")
    return json({ ok: true })
  }

  if (cmd === "/me") {
    if (commands.me === false) {
      await sendTo(env, chatId, "/me 已被管理员关闭。")
      return json({ ok: true })
    }
    const created = user.created_at ? new Date(String(user.created_at)).toLocaleDateString("zh-CN") : "未知"
    const lines = [
      `<b>${String(user.username ?? "")}</b>`,
      `角色：${role || "user"}`,
      `注册：${created}`,
    ]
    if (typeof user.points === "number") lines.push(`积分：${user.points}`)
    lines.push("", "🌐 cloud.doulor.cn")
    await sendTo(env, chatId, lines.join("\n"))
    return json({ ok: true })
  }

  if (cmd === "/status") {
    // 管理命令：已绑定 + 站内角色是管理员，两个条件缺一静默忽略
    if (!isAnyAdmin(role) || commands.status === false) return json({ ok: true, ignored: "no-perm" })
    const u = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>()
    const b = await env.DB.prepare("SELECT COUNT(*) AS n FROM tg_bindings").first<{ n: number }>()
    const since = Date.now() - 24 * 3600 * 1000
    const p = await env.DB.prepare(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed FROM tg_push_log WHERE created_at > ?"
    )
      .bind(since)
      .first<{ total: number | null; failed: number | null }>()
    await sendTo(
      env,
      chatId,
      [
        "<b>DoulorCloud 状态</b>",
        `用户数：${u?.n ?? 0}`,
        `TG 绑定：${b?.n ?? 0}`,
        `24h 推送：${p?.total ?? 0} 条（失败 ${p?.failed ?? 0}）`,
        `机器人：${cfg.enabled ? "已启用" : "未启用"} ${cfg.bot_username ? "@" + cfg.bot_username : ""}`,
      ].join("\n")
    )
    return json({ ok: true })
  }

  await sendTo(env, chatId, "未知命令，发送 /help 查看列表。")
  return json({ ok: true })
}

/* ==========================================================================
 * 供其它模块复用的推送入口（登录提醒、frp 到期、节点掉线、每日简报）
 * ========================================================================== */

export type PushKind = "login" | "frpExpiry" | "nodeDown" | "daily"

/**
 * 按开关把消息推给「绑定了 TG 的管理员」或「指定用户」。
 * 其它模块只需 `void pushMessage(env, "login", { userId, text })`，
 * 失败不影响主流程（内部已 try/catch 并记审计）。
 */
export async function pushMessage(
  env: Env,
  kind: PushKind,
  opts: { userId?: string; text: string; adminOnly?: boolean }
): Promise<void> {
  try {
    const cfg = await loadConfig(env)
    if (!cfg.enabled) return
    const pushes = { ...DEFAULT_PUSHES, ...parseJson<Record<string, boolean>>(cfg.pushes_json, {}) }
    if (pushes[kind] === false) return
    if (!(await botToken(env, cfg))) return
    let targets: string[]
    if (opts.userId) {
      const row = await env.DB.prepare("SELECT telegram_id, muted_json FROM tg_bindings WHERE user_id = ?")
        .bind(opts.userId)
        .first<{ telegram_id: string; muted_json: string }>()
      if (!row) return
      const muted = parseJson<string[]>(row.muted_json, [])
      if (muted.includes(kind)) return
      targets = [row.telegram_id]
    } else {
      targets = await adminTargets(env)
    }
    for (const t of targets) await sendTo(env, t, opts.text)
  } catch {
    // 推送失败绝不影响业务主流程
  }
}
