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
  mail: true,
  dns: true,
  points: true,
  invite: true,
  storage: true,
  community: true,
  notices: true,
  security: true,
  menu: true,
  settings: true,
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
    { url: hookUrl, secret_token: secret, allowed_updates: ["message", "callback_query"] },
    token
  )
  if (!r.ok) throw new ApiError(400, `设置失败：${r.description ?? "未知错误"}`, "SET_WEBHOOK_FAILED")
  // 顺手把「默认命令菜单」也注册上：没绑定的人在 / 里只看到 /bind 和 /help。
  // 单独做一个按钮也行，但设置 webhook 本来就是一次性初始化动作，合并更省事。
  const commands = { ...DEFAULT_COMMANDS, ...parseJson<Record<string, boolean>>(cfg.commands_json, {}) }
  await tgApi(
    env,
    "setMyCommands",
    { commands: buildCommandMenu({ bound: false, isAdminUser: false, commands }), scope: { type: "default" } },
    token
  )
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
  // botUsername 用于前端拼一键深链 https://t.me/<bot>?start=<码>：
  // Telegram 会把 `/start <码>` 发给 bot，用户零输入即可完成绑定。
  const cfg = await loadConfig(env)
  return json({
    ok: true,
    code,
    expiresAt: now + BIND_CODE_TTL_MS,
    botUsername: cfg.bot_username,
    botReady: !!cfg.enabled && !!cfg.bot_username,
  })
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
  /** inline 按钮回调（/menu、/settings 用） */
  callback_query?: {
    id: string
    data?: string
    message?: { message_id?: number; chat?: { id?: number; type?: string } }
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
    "☁️ <b>DoulorCloud 机器人</b>",
    "",
    "<b>查询</b>",
    "/menu —— 快捷入口（按钮操作，不用记命令）",
    "/me —— 我的账号概览",
    "/frp —— 我的内网穿透租约",
    "/mail —— 我的邮箱与最近邮件",
    "/dns —— 我的域名与解析",
    "/points —— 积分与最近明细",
    "/invite —— 我的邀请码与战绩",
    "/storage —— 网盘用量与最近文件",
    "/community —— 我的创作与互动",
    "/notices —— 未读站内通知",
    "/security —— 登录环境与活跃会话",
    "",
    "<b>设置</b>",
    "/settings —— 通知开关",
    "/bind &lt;绑定码&gt; —— 绑定站内账号",
    "/unbind —— 解除绑定",
  ]
  if (isAdminUser) {
    lines.push("", "<b>管理员</b>", "/status —— 站点状态")
  }
  lines.push("", `☁️ ${SITE_URL}`)
  return lines.join("\n")
}

/** 记录「这个 chat 正在等绑定码」（10 分钟过期，下次成功消费即删） */
async function setPendingBind(env: Env, chatId: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO tg_pending_binds (telegram_id, created_at) VALUES (?, ?) " +
      "ON CONFLICT(telegram_id) DO UPDATE SET created_at = excluded.created_at"
  )
    .bind(chatId, Date.now())
    .run()
}

/** 消费等待状态：10 分钟内有效，命中即删（一次性） */
async function consumePendingBind(env: Env, chatId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT created_at FROM tg_pending_binds WHERE telegram_id = ?"
  )
    .bind(chatId)
    .first<{ created_at: number }>()
  if (!row) return false
  await env.DB.prepare("DELETE FROM tg_pending_binds WHERE telegram_id = ?").bind(chatId).run()
  return Date.now() - row.created_at <= BIND_CODE_TTL_MS
}

/**
 * 用绑定码完成绑定。三条入口（深链 /start <码>、/bind <码>、等待状态下直接发码）共用。
 * 校验顺序：码有效 → 这个 TG 没绑别人 → 落库 → 消费码 → 刷菜单 → 回执。
 */
async function tryBindCode(
  env: Env,
  chatId: string,
  code: string,
  cfg: TgConfigRow,
  tgUsername: string | null
): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT * FROM tg_bind_tokens WHERE code = ? AND used_at IS NULL AND expires_at > ?"
  )
    .bind(code, Date.now())
    .first<{ code: string; user_id: string; expires_at: number }>()
  if (!row) {
    await sendTo(env, chatId, "❌ 绑定码无效或已过期，回网站「账号设置 → Telegram 绑定」重新生成。")
    return
  }
  const taken = await bindingByTg(env, chatId)
  if (taken && taken.user_id !== row.user_id) {
    await sendTo(env, chatId, "❌ 这个 Telegram 已经绑定了别的账号，先 /unbind 再绑。")
    return
  }
  await env.DB.prepare(
    `INSERT INTO tg_bindings (telegram_id, user_id, tg_username, bound_at, muted_json)
     VALUES (?, ?, ?, ?, '[]')
     ON CONFLICT(telegram_id) DO UPDATE SET user_id = excluded.user_id, bound_at = excluded.bound_at`
  )
    .bind(chatId, row.user_id, tgUsername, Date.now())
    .run()
  await env.DB.prepare("UPDATE tg_bind_tokens SET used_at = ? WHERE code = ?")
    .bind(Date.now(), code)
    .run()
  await env.DB.prepare("DELETE FROM tg_pending_binds WHERE telegram_id = ?").bind(chatId).run()
  const u = await env.DB.prepare("SELECT username, role FROM users WHERE id = ?")
    .bind(row.user_id)
    .first<{ username: string; role: string }>()
  await refreshChatMenu(env, chatId, cfg)
  await sendTo(
    env,
    chatId,
    `✅ 绑定成功：<b>${u?.username ?? ""}</b>\n命令菜单已更新，点左下角 / 查看。`
  )
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

  // inline 按钮回调优先处理：它没有 message.text，走不到下面的命令分发
  if (update.callback_query) {
    await handleCallback(env, update.callback_query, cfg)
    return json({ ok: true })
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
  /**
   * 绑定码的三种输入方式（Telegram 菜单里的命令按钮**不会**带参数，这是它的硬行为）：
   *   ① 深链 `https://t.me/<bot>?start=<码>` → bot 收到 `/start <码>`，一键绑定零输入
   *   ② `/bind 123456` 手动带参
   *   ③ 先发 `/bind`（无参）→ 进入「等待输入」状态，下一条纯 6 位数字自动当码
   * 三条最终都汇到 `tryBindCode`，绑定成功后的菜单刷新与提示只有一份实现。
   */
  const codeArg = /^\d{6}$/.test(arg) ? arg : ""
  const looksLikeCode = /^\d{6}$/.test(text)

  if (cmd === "/bind" || cmd === "/start") {
    // ①/② 已带码（深链或手打）
    if (codeArg) {
      await tryBindCode(env, chatId, codeArg, cfg, msg?.from?.username ?? null)
      return json({ ok: true })
    }
    // ③ 无参 /bind → 记住等待状态，让用户直接发码
    if (cmd === "/bind") {
      await setPendingBind(env, chatId)
      await sendTo(
        env,
        chatId,
        "请把 <b>6 位绑定码</b>直接发给我（不用再打 /bind）。\n\n" +
          "绑定码在网站「账号设置 → Telegram 绑定」里生成，10 分钟内有效。"
      )
      return json({ ok: true })
    }
    // /start 无参 → 欢迎 + 帮助
    await refreshChatMenu(env, chatId, cfg)
    await sendTo(env, chatId, helpText(false))
    return json({ ok: true })
  }

  if (cmd === "/help") {
    await refreshChatMenu(env, chatId, cfg)
    const boundNow = await bindingByTg(env, chatId)
    const roleNow = boundNow
      ? (
          await env.DB.prepare("SELECT role FROM users WHERE id = ?")
            .bind(boundNow.user_id)
            .first<{ role: string }>()
        )?.role ?? ""
      : ""
    await sendTo(env, chatId, helpText(isAnyAdmin(roleNow)))
    return json({ ok: true })
  }

  // 非命令消息：只有「刚发过无参 /bind」的 chat 才会被当成绑定码，其它一律不猜
  if (!text.startsWith("/") && looksLikeCode && (await consumePendingBind(env, chatId))) {
    await tryBindCode(env, chatId, text, cfg, msg?.from?.username ?? null)
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
    await clearChatMenu(env, chatId) // 菜单回落到默认（只剩 /bind /help）
    await sendTo(env, chatId, "已解除绑定，命令菜单已恢复为默认。")
    return json({ ok: true })
  }

  if (cmd === "/me") {
    if (commands.me === false) {
      await sendTo(env, chatId, "/me 已被管理员关闭。")
      return json({ ok: true })
    }
    await sendTo(env, chatId, await meSummary(env, user))
    return json({ ok: true })
  }

  if (cmd === "/frp") {
    if (commands.frp === false) {
      await sendTo(env, chatId, "/frp 已被管理员关闭。")
      return json({ ok: true })
    }
    await sendTo(env, chatId, await frpSummary(env, binding.user_id))
    return json({ ok: true })
  }

  if (cmd === "/mail") {
    const view = await renderView(env, "mail", binding, user, cfg)
    if (view) await editOrSend(env, chatId, undefined, view)
    return json({ ok: true })
  }

  if (cmd === "/dns") {
    if (commands.dns === false) {
      await sendTo(env, chatId, "/dns 已被管理员关闭。")
      return json({ ok: true })
    }
    await sendTo(env, chatId, await dnsSummary(env, binding.user_id))
    return json({ ok: true })
  }

  if (cmd === "/menu") {
    const view = await renderView(env, "menu", binding, user, cfg)
    if (view) await editOrSend(env, chatId, undefined, view)
    return json({ ok: true })
  }

  if (cmd === "/settings") {
    const view = await renderView(env, "settings", binding, user, cfg)
    if (view) await editOrSend(env, chatId, undefined, view)
    return json({ ok: true })
  }

  for (const [cmdName, viewName] of [
    ["/points", "points"],
    ["/invite", "invite"],
    ["/storage", "storage"],
    ["/community", "community"],
    ["/notices", "notices"],
    ["/security", "security"],
  ] as const) {
    if (cmd === cmdName) {
      if (commands[viewName] === false) {
        await sendTo(env, chatId, `${cmdName} 已被管理员关闭。`)
        return json({ ok: true })
      }
      const view = await renderView(env, viewName, binding, user, cfg)
      if (view) await editOrSend(env, chatId, undefined, view)
      return json({ ok: true })
    }
  }

  if (cmd === "/status") {
    // 管理命令：已绑定 + 站内角色是管理员，两个条件缺一静默忽略
    if (!isAnyAdmin(role) || commands.status === false) return json({ ok: true, ignored: "no-perm" })
    await sendTo(env, chatId, await statusSummary(env, cfg))
    return json({ ok: true })
  }

  await sendTo(env, chatId, "未知命令，发送 /menu 看快捷入口，或 /help 看全部命令。")
  return json({ ok: true })
}

/* ==========================================================================
 * 各命令的「信息正文」
 *
 * 设计取向：一条消息里把**用户最常看的十几个字段**一次给全，但不啰嗦 ——
 * 每行一个模块，缺数据的模块整行省略（而不是显示「0 / 未知」占位）。
 * 所有查询都容错：任何一张表结构变动都不该让整条命令变哑巴。
 * ========================================================================== */

const SITE_URL = "https://cloud.doulor.cn"

/** 容错计数：表/列不存在时返回 null，调用方决定要不要显示 */
async function safeCount(env: Env, sql: string, ...binds: unknown[]): Promise<number | null> {
  try {
    const stmt = binds.length > 0 ? env.DB.prepare(sql).bind(...binds) : env.DB.prepare(sql)
    const row = await stmt.first<{ n: number | null }>()
    return row?.n ?? 0
  } catch {
    return null
  }
}

function fmtDate(v: unknown): string {
  if (!v) return "—"
  const ms = typeof v === "number" ? v : Date.parse(String(v))
  if (!Number.isFinite(ms)) return "—"
  return new Date(ms).toLocaleDateString("zh-CN")
}

function fmtDateTimeCn(v: unknown): string {
  if (!v) return "—"
  const ms = typeof v === "number" ? v : Date.parse(String(v))
  if (!Number.isFinite(ms)) return "—"
  return new Date(ms).toLocaleString("zh-CN", { hour12: false })
}

function fmtBytes(n: number): string {
  if (!n) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/** /me —— 个人信息（用户最常看的一条） */
async function meSummary(env: Env, user: Record<string, unknown>): Promise<string> {
  const userId = String(user.id)
  const [points, streak, mailboxCnt, msgCnt, unreadCnt, dnsCnt, domainCnt, subdomainCnt, storageUsed, storageQuota, frpCnt] =
    await Promise.all([
      env.DB.prepare("SELECT balance FROM user_points WHERE user_id = ?").bind(userId).first<{ balance: number }>().catch(() => null),
      env.DB.prepare("SELECT streak, checkin_date FROM daily_checkins WHERE user_id = ? ORDER BY checkin_date DESC LIMIT 1")
        .bind(userId)
        .first<{ streak: number; checkin_date: string }>()
        .catch(() => null),
      safeCount(env, "SELECT COUNT(*) AS n FROM mailboxes WHERE user_id = ?", userId),
      safeCount(env, "SELECT COUNT(*) AS n FROM messages m JOIN mailboxes mb ON m.mailbox_id = mb.id WHERE mb.user_id = ?", userId),
      safeCount(env, "SELECT COUNT(*) AS n FROM messages m JOIN mailboxes mb ON m.mailbox_id = mb.id WHERE mb.user_id = ? AND m.read = 0", userId),
      safeCount(env, "SELECT COUNT(*) AS n FROM dns_records WHERE domain_id IN (SELECT id FROM domains WHERE user_id = ?)", userId),
      safeCount(env, "SELECT COUNT(*) AS n FROM domains WHERE user_id = ?", userId),
      safeCount(env, "SELECT COUNT(*) AS n FROM subdomains WHERE user_id = ?", userId),
      env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM storage_objects WHERE user_id = ?").bind(userId).first<{ n: number }>().catch(() => null),
      env.DB.prepare("SELECT quota_bytes AS n FROM storage_accounts WHERE user_id = ?").bind(userId).first<{ n: number }>().catch(() => null),
      safeCount(env, "SELECT COUNT(*) AS n FROM frp_subscriptions WHERE user_id = ? AND status = 'active'", userId),
    ])

  const lines: string[] = ["☁️ <b>DoulorCloud · 我的账号</b>"]
  const nick = user.nickname ? String(user.nickname) : ""
  lines.push(`👤 <b>${String(user.username ?? "")}</b>${nick ? `（${nick}）` : ""} · ${String(user.role ?? "user")}`)
  if (user.uid != null) lines.push(`🆔 UID：<code>${String(user.uid)}</code>`)
  if (user.email) {
    lines.push(`📧 邮箱：${String(user.email)}${user.email_verified ? " ✅已验" : " ⏳未验"}`)
  }
  if (user.status && String(user.status) !== "active") {
    lines.push(`⚠️ 状态：${String(user.status)}${user.suspend_reason ? `（${String(user.suspend_reason)}）` : ""}`)
  }

  // 注册时长：比单纯一个日期更有"陪伴感"
  const created = user.created_at ? Date.parse(String(user.created_at)) : NaN
  if (Number.isFinite(created)) {
    const days = Math.max(1, Math.floor((Date.now() - created) / 86400000) + 1)
    lines.push(`🕒 注册：${fmtDate(created)} · 第 ${days} 天`)
  }
  if (user.last_login_at) lines.push(`🔐 最近登录：${fmtDateTimeCn(user.last_login_at)}`)

  if (points) lines.push(`💎 积分：<b>${points.balance.toLocaleString("zh-CN")}</b>`)
  if (streak) {
    const today = new Date().toISOString().slice(0, 10)
    const signed = streak.checkin_date === today
    lines.push(`✅ 签到：${signed ? "今日已签" : "今日未签"} · 连续 ${streak.streak ?? 0} 天`)
  }
  if (mailboxCnt !== null) {
    lines.push(`📮 邮件：${mailboxCnt} 个邮箱 · ${msgCnt ?? 0} 封${unreadCnt ? ` · <b>未读 ${unreadCnt}</b>` : ""}`)
  }
  if (domainCnt !== null || subdomainCnt !== null) {
    lines.push(`☁️ 域名：${domainCnt ?? 0} 个 · 解析 ${dnsCnt ?? 0} 条 · 子域 ${subdomainCnt ?? 0} 个`)
  }
  if (storageUsed) {
    lines.push(`💾 网盘：${fmtBytes(storageUsed.n)}${storageQuota?.n ? ` / ${fmtBytes(storageQuota.n)}` : ""}`)
  }
  if (frpCnt !== null) lines.push(`🚇 内网穿透：${frpCnt} 条在用`)
  if (user.max_subdomains != null) lines.push(`🔖 子域额度：${String(user.max_subdomains)}`)

  lines.push("", `☁️ ${SITE_URL}`)
  return lines.join("\n")
}

/** /mail —— 邮箱概览 + 最近几封 */
async function mailSummary(
  env: Env,
  userId: string,
  page = 1
): Promise<{ text: string; pages: number }> {
  const SIZE = 5
  try {
    const total = (await safeCount(env, "SELECT COUNT(*) AS n FROM mailboxes WHERE user_id = ?", userId)) ?? 0
    const pages = Math.max(1, Math.ceil(total / SIZE))
    const offset = (page - 1) * SIZE
    const { results: boxes } = await env.DB.prepare(
      `SELECT mb.address,
              (SELECT COUNT(*) FROM messages m WHERE m.mailbox_id = mb.id) AS total,
              (SELECT COUNT(*) FROM messages m WHERE m.mailbox_id = mb.id AND m.read = 0) AS unread
         FROM mailboxes mb WHERE mb.user_id = ? ORDER BY mb.created_at ASC LIMIT ? OFFSET ?`
    )
      .bind(userId, SIZE, offset)
      .all<{ address: string; total: number; unread: number }>()
    if (!boxes || boxes.length === 0) {
      return { text: `📮 你还没有邮箱。\n开通：${SITE_URL}`, pages: 1 }
    }
    const { results: recent } = await env.DB.prepare(
      `SELECT m.subject, m.from_address, m.read, m.received_at
         FROM messages m JOIN mailboxes mb ON m.mailbox_id = mb.id
        WHERE mb.user_id = ? ORDER BY m.received_at DESC LIMIT 3`
    )
      .bind(userId)
      .all<{ subject: string | null; from_address: string | null; read: number; received_at: string }>()

    const lines = [`📮 <b>我的邮箱</b>（共 ${total} 个 · 第 ${page}/${pages} 页）`]
    for (const b of boxes) {
      lines.push(`· ${b.address} —— ${b.total} 封${b.unread ? `（<b>未读 ${b.unread}</b>）` : ""}`)
    }
    if (recent && recent.length > 0) {
      lines.push("", "<b>最近收到</b>")
      for (const m of recent) {
        const mark = m.read ? "　" : "●"
        lines.push(`${mark} ${(m.subject || "(无主题)").slice(0, 40)}`)
        lines.push(`　　${(m.from_address || "?").slice(0, 40)} · ${fmtDate(m.received_at)}`)
      }
    }
    lines.push("", `☁️ ${SITE_URL}`)
    return { text: lines.join("\n"), pages }
  } catch (err) {
    return { text: `📮 读取邮箱失败：${err instanceof Error ? err.message : "未知错误"}`, pages: 1 }
  }
}

/** /dns —— 域名与解析概览 */
async function dnsSummary(env: Env, userId: string): Promise<string> {
  try {
    const { results: domains } = await env.DB.prepare(
      `SELECT d.name, d.status,
              (SELECT COUNT(*) FROM dns_records r WHERE r.domain_id = d.id) AS records
         FROM domains d WHERE d.user_id = ? ORDER BY d.created_at ASC`
    )
      .bind(userId)
      .all<{ name: string; status: string; records: number }>()
    const { results: subs } = await env.DB.prepare(
      "SELECT name FROM subdomains WHERE user_id = ? AND name != '@' ORDER BY name ASC LIMIT 10"
    )
      .bind(userId)
      .all<{ name: string }>()

    if ((!domains || domains.length === 0) && (!subs || subs.length === 0)) {
      return `☁️ 你还没有域名。\n申请：${SITE_URL}`
    }
    const lines = ["☁️ <b>我的域名</b>"]
    for (const d of domains ?? []) {
      lines.push(`· ${d.name} —— ${d.records} 条解析（${d.status}）`)
    }
    if (subs && subs.length > 0) {
      lines.push("", "<b>子域名</b>")
      lines.push(subs.map((s) => s.name).join(" / "))
    }
    lines.push("", `☁️ ${SITE_URL}`)
    return lines.join("\n")
  } catch (err) {
    return `☁️ 读取域名失败：${err instanceof Error ? err.message : "未知错误"}`
  }
}

/** /status —— 站点状态（管理员） */
async function statusSummary(env: Env, cfg: TgConfigRow): Promise<string> {
  const since = new Date(Date.now() - 86400000).toISOString()
  const [users, fresh, boxes, msgs, nodes, nodesDown, rentals, bound, push] = await Promise.all([
    safeCount(env, "SELECT COUNT(*) AS n FROM users"),
    safeCount(env, "SELECT COUNT(*) AS n FROM users WHERE created_at > ?", since),
    safeCount(env, "SELECT COUNT(*) AS n FROM mailboxes"),
    safeCount(env, "SELECT COUNT(*) AS n FROM messages"),
    safeCount(env, "SELECT COUNT(*) AS n FROM frp_nodes"),
    safeCount(env, "SELECT COUNT(*) AS n FROM frp_nodes n LEFT JOIN frp_agent_state a ON a.node_id = n.id WHERE a.last_seen_at IS NULL OR a.last_seen_at < ?", new Date(Date.now() - 600000).toISOString()),
    safeCount(env, "SELECT COUNT(*) AS n FROM frp_subscriptions WHERE status = 'active'"),
    safeCount(env, "SELECT COUNT(*) AS n FROM tg_bindings"),
    env.DB.prepare(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed FROM tg_push_log WHERE created_at > ?"
    )
      .bind(Date.now() - 86400000)
      .first<{ total: number | null; failed: number | null }>()
      .catch(() => null),
  ])
  const onlineNodes = nodes !== null && nodesDown !== null ? Math.max(0, nodes - nodesDown) : null
  return [
    "☁️ <b>DoulorCloud · 站点状态</b>",
    `👥 用户：${users ?? 0}（24h 新增 ${fresh ?? 0}）`,
    `📮 邮件：${boxes ?? 0} 个邮箱 · ${msgs ?? 0} 封`,
    `🚇 内网穿透：节点 ${onlineNodes ?? "?"}/${nodes ?? "?"} 在线 · 在用租约 ${rentals ?? 0}`,
    `🤖 机器人：绑定 ${bound ?? 0} 人 · 24h 推送 ${push?.total ?? 0}（失败 ${push?.failed ?? 0}）`,
    `⚙️ 状态：${cfg.enabled ? "已启用" : "未启用"}${cfg.bot_username ? ` · @${cfg.bot_username}` : ""}`,
    "",
    `🕒 ${fmtDateTimeCn(Date.now())}`,
    `☁️ ${SITE_URL}`,
  ].join("\n")
}

/* ==========================================================================
 * 通知设置（inline 键盘直接在聊天里开关，不用去网站）
 * ========================================================================== */

const MUTE_LABELS: Record<string, string> = {
  login: "登录提醒",
  frpExpiry: "穿透到期",
  nodeDown: "节点掉线",
  daily: "每日简报",
}


async function settingsText(_env: Env, binding: BindingRow): Promise<string> {
  const muted = parseJson<string[]>(binding.muted_json, [])
  const on = Object.keys(MUTE_LABELS).filter((k) => !muted.includes(k))
  return [
    "⚙️ <b>通知设置</b>",
    on.length > 0 ? `当前接收：${on.map((k) => MUTE_LABELS[k]).join("、")}` : "当前全部静音",
    "",
    "点下面的按钮切换 ✅/⛔（改完立刻生效）。",
    `☁️ ${SITE_URL}`,
  ].join("\n")
}


/**
 * 处理 inline 按钮回调（callback_query）。
 * 权限口径与命令一致：只私聊、必须已绑定、管理类数据额外校验角色。
 */
/* ==========================================================================
 * 单卡片导航（2026-10-22 站长要求：点按钮不要再刷出新卡片）
 *
 * 做法：所有按钮都是 callback_query，处理时用 **editMessageText** 原地改写同一条消息，
 * 只保留「发新消息」作为兜底（消息被删 / 内容没变化时的 not-modified 特判）。
 * 每个视图都带「⬅️ 返回菜单」，所以一个卡片可以在 菜单 → 账号 → 邮箱 → 菜单 之间来回切。
 * ========================================================================== */

const BACK_LABEL = "⬅️ 返回菜单"

type TgView = { text: string; keyboard: Record<string, unknown> }

/** /menu 的主键盘：全部是视图切换，不依赖前端路由，按钮永远可用 */
function menuKeyboard(isAdminUser: boolean): Record<string, unknown> {
  const rows: Array<Array<Record<string, unknown>>> = [
    [
      { text: "👤 我的账号", callback_data: "v:me" },
      { text: "🚇 内网穿透", callback_data: "v:frp" },
    ],
    [
      { text: "📮 我的邮箱", callback_data: "v:mail" },
      { text: "☁️ 我的域名", callback_data: "v:dns" },
    ],
    [
      { text: "💎 我的积分", callback_data: "v:points" },
      { text: "🎁 我的邀请", callback_data: "v:invite" },
    ],
    [
      { text: "💾 我的网盘", callback_data: "v:storage" },
      { text: "📝 我的创作", callback_data: "v:community" },
    ],
    [
      { text: "📬 站内通知", callback_data: "v:notices" },
      { text: "🔐 账号安全", callback_data: "v:security" },
    ],
    [
      { text: "⚙️ 通知设置", callback_data: "v:settings" },
      { text: "☁️ 打开网站", url: SITE_URL },
    ],
  ]
  if (isAdminUser) rows.push([{ text: "📊 站点状态", callback_data: "v:status" }])
  return { inline_keyboard: rows }
}

/** 子视图的键盘：返回菜单 +（管理员）站点状态 */
function subKeyboard(isAdminUser: boolean, view: string): Record<string, unknown> {
  const row: Array<Record<string, unknown>> = [
    { text: "🔄 刷新", callback_data: `v:${view}` },
    { text: BACK_LABEL, callback_data: "v:menu" },
  ]
  if (isAdminUser) row.push({ text: "📊 状态", callback_data: "v:status" })
  return { inline_keyboard: [row] }
}

/** 通知设置视图的键盘：每行一个开关 + 返回 */
function settingsKeyboard(muted: string[], isAdminUser: boolean): Record<string, unknown> {
  const rows: Array<Array<Record<string, unknown>>> = Object.keys(MUTE_LABELS).map((k) => [
    { text: `${muted.includes(k) ? "⛔" : "✅"} ${MUTE_LABELS[k]}`, callback_data: `s:${k}` },
  ])
  const back: Array<Record<string, unknown>> = [{ text: BACK_LABEL, callback_data: "v:menu" }]
  if (isAdminUser) back.push({ text: "📊 状态", callback_data: "v:status" })
  rows.push(back)
  return { inline_keyboard: rows }
}

/* ==========================================================================
 * A. 更多信息视图（2026-10-22 第二批）
 *
 * /invite /points /security /storage /community /notices
 * 全部只读、全部容错：任何一张表缺失都只让对应行消失，不影响其它行。
 * ========================================================================== */

/** /invite —— 邀请码与邀请战绩 */
async function inviteSummary(env: Env, userId: string): Promise<string> {
  const lines = ["☁️ <b>我的邀请</b>"]
  try {
    const { results: codes } = await env.DB.prepare(
      "SELECT code, max_uses, used_count, expires_at FROM invite_codes WHERE created_by = ? ORDER BY created_at DESC LIMIT 3"
    )
      .bind(userId)
      .all<{ code: string; max_uses: number; used_count: number; expires_at: string | null }>()
    const invited = await safeCount(env, "SELECT COUNT(*) AS n FROM invite_rewards WHERE inviter_user_id = ?", userId)
    if (invited !== null) lines.push(`👥 已邀请：<b>${invited}</b> 人`)
    if (codes && codes.length > 0) {
      lines.push("", "<b>我的邀请码</b>")
      for (const c of codes) {
        const left = c.max_uses ? `${c.used_count}/${c.max_uses} 已用` : `${c.used_count} 已用`
        lines.push(`· <code>${c.code}</code>（${left}${c.expires_at ? `，${fmtDate(c.expires_at)} 过期` : ""}）`)
      }
    } else {
      lines.push("", "还没有可用的邀请码，去网站生成一个。")
    }
  } catch {
    lines.push("邀请信息暂时读不到。")
  }
  lines.push("", `☁️ ${SITE_URL}`)
  return lines.join("\n")
}

/** /points —— 积分余额 + 最近明细 + 可兑换商品数 */
async function pointsSummary(env: Env, userId: string): Promise<string> {
  const lines = ["☁️ <b>我的积分</b>"]
  try {
    const bal = await env.DB.prepare("SELECT balance FROM user_points WHERE user_id = ?")
      .bind(userId)
      .first<{ balance: number }>()
    lines.push(`💎 余额：<b>${(bal?.balance ?? 0).toLocaleString("zh-CN")}</b>`)
    const products = await safeCount(env, "SELECT COUNT(*) AS n FROM point_products WHERE enabled = 1")
    if (products !== null) lines.push(`🎁 可兑换商品：${products} 个`)

    const { results: tx } = await env.DB.prepare(
      "SELECT delta, balance, reason, detail, created_at FROM point_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 6"
    )
      .bind(userId)
      .all<{ delta: number; balance: number; reason: string | null; detail: string | null; created_at: string }>()
    if (tx && tx.length > 0) {
      lines.push("", "<b>最近明细</b>")
      for (const t of tx) {
        const sign = t.delta > 0 ? `+${t.delta}` : String(t.delta)
        const why = (t.reason || t.detail || "积分变动").slice(0, 24)
        lines.push(`${t.delta > 0 ? "🟢" : "🔴"} ${sign} · ${why} · ${fmtDate(t.created_at)}`)
      }
    }
  } catch {
    lines.push("积分明细暂时读不到。")
  }
  lines.push("", `☁️ ${SITE_URL}`)
  return lines.join("\n")
}

/** /security —— 登录环境与活跃会话 */
async function securitySummary(env: Env, userId: string, user: Record<string, unknown>): Promise<string> {
  const lines = ["☁️ <b>账号安全</b>"]
  try {
    const nowIso = new Date().toISOString()
    const sessions = await safeCount(
      env,
      "SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?",
      userId,
      nowIso
    )
    if (sessions !== null) lines.push(`🔑 活跃会话：<b>${sessions}</b> 个`)
    if (user.last_login_at) lines.push(`🕒 最近登录：${fmtDateTimeCn(user.last_login_at)}`)
    if (user.email_verified) lines.push("📧 邮箱：已验证 ✅")
    else lines.push("📧 邮箱：<b>未验证</b> ⏳")

    const { results: ips } = await env.DB.prepare(
      "SELECT ip, last_seen_at, times FROM user_login_ips WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 5"
    )
      .bind(userId)
      .all<{ ip: string; last_seen_at: string; times: number }>()
    if (ips && ips.length > 0) {
      lines.push("", "<b>最近登录 IP</b>")
      for (const r of ips) lines.push(`· ${r.ip} · ${fmtDate(r.last_seen_at)}${r.times > 1 ? `（${r.times} 次）` : ""}`)
    }
    lines.push("", "发现陌生登录？立刻去网站改密码并退出其它设备。")
  } catch {
    lines.push("安全信息暂时读不到。")
  }
  lines.push("", `☁️ ${SITE_URL}`)
  return lines.join("\n")
}

/** /storage —— 网盘用量与最近文件 */
async function storageSummary(env: Env, userId: string): Promise<string> {
  const lines = ["☁️ <b>我的网盘</b>"]
  try {
    const used = await env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM storage_objects WHERE user_id = ?")
      .bind(userId)
      .first<{ n: number }>()
    const quota = await env.DB.prepare("SELECT quota_bytes AS n FROM storage_accounts WHERE user_id = ?")
      .bind(userId)
      .first<{ n: number }>()
    const u = used?.n ?? 0
    const q = quota?.n ?? 0
    if (q > 0) {
      const pct = Math.min(100, Math.round((u / q) * 100))
      const bar = "█".repeat(Math.round(pct / 10)).padEnd(10, "░")
      lines.push(`💾 已用 ${fmtBytes(u)} / ${fmtBytes(q)}`)
      lines.push(`${bar} ${pct}%`)
    } else {
      lines.push(`💾 已用 ${fmtBytes(u)}`)
    }
    const files = await safeCount(env, "SELECT COUNT(*) AS n FROM storage_objects WHERE user_id = ?", userId)
    if (files !== null) lines.push(`📄 文件数：${files}`)
    const { results: recent } = await env.DB.prepare(
      "SELECT filename, size, created_at FROM storage_objects WHERE user_id = ? ORDER BY created_at DESC LIMIT 3"
    )
      .bind(userId)
      .all<{ filename: string; size: number; created_at: string }>()
    if (recent && recent.length > 0) {
      lines.push("", "<b>最近上传</b>")
      for (const f of recent) lines.push(`· ${f.filename.slice(0, 30)}（${fmtBytes(f.size)}）`)
    }
  } catch {
    lines.push("网盘信息暂时读不到。")
  }
  lines.push("", `☁️ ${SITE_URL}`)
  return lines.join("\n")
}

/** /community —— 我的创作与互动 */
async function communitySummary(env: Env, userId: string): Promise<string> {
  const lines = ["☁️ <b>我的创作</b>"]
  try {
    const posts = await env.DB.prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(like_count), 0) AS likes,
              COALESCE(SUM(comment_count), 0) AS comments
         FROM posts WHERE user_id = ? AND deleted_at IS NULL`
    )
      .bind(userId)
      .first<{ n: number; likes: number; comments: number }>()
    lines.push(`📝 帖子：${posts?.n ?? 0} 条 · 获赞 ${posts?.likes ?? 0} · 收到评论 ${posts?.comments ?? 0}`)
    const mine = await safeCount(env, "SELECT COUNT(*) AS n FROM post_comments WHERE user_id = ? AND deleted_at IS NULL", userId)
    if (mine !== null) lines.push(`💬 我发出的评论：${mine} 条`)
    const week = await safeCount(
      env,
      `SELECT COUNT(*) AS n FROM post_comments c JOIN posts p ON c.post_id = p.id
        WHERE p.user_id = ? AND c.deleted_at IS NULL AND c.created_at > ?`,
      userId,
      new Date(Date.now() - 7 * 86400000).toISOString()
    )
    if (week !== null) lines.push(`🆕 近 7 天新评论：${week} 条`)
  } catch {
    lines.push("创作数据暂时读不到。")
  }
  lines.push("", `☁️ ${SITE_URL}`)
  return lines.join("\n")
}

/** /notices —— 未读站内通知 */
async function noticesSummary(env: Env, userId: string): Promise<string> {
  const lines = ["☁️ <b>站内通知</b>"]
  try {
    const { results } = await env.DB.prepare(
      `SELECT title, body, created_at, require_ack FROM admin_notices
        WHERE user_id = ? AND read_at IS NULL AND revoked_at IS NULL
        ORDER BY created_at DESC LIMIT 5`
    )
      .bind(userId)
      .all<{ title: string; body: string; created_at: string; require_ack: number }>()
    const unread = await safeCount(
      env,
      "SELECT COUNT(*) AS n FROM admin_notices WHERE user_id = ? AND read_at IS NULL AND revoked_at IS NULL",
      userId
    )
    if (unread !== null) lines.push(`📬 未读：<b>${unread}</b> 条`)
    if (!results || results.length === 0) {
      lines.push("", "没有未读通知 ✅")
    } else {
      lines.push("")
      for (const n of results) {
        lines.push(`· <b>${n.title.slice(0, 30)}</b>${n.require_ack ? "（需确认）" : ""} · ${fmtDate(n.created_at)}`)
        const brief = (n.body || "").replace(/\s+/g, " ").slice(0, 60)
        if (brief) lines.push(`　${brief}`)
      }
      lines.push("", "去网站查看并确认：", `☁️ ${SITE_URL}`)
    }
  } catch {
    lines.push("通知暂时读不到。")
  }
  lines.push("", `☁️ ${SITE_URL}`)
  return lines.join("\n")
}

/** 把一个视图名渲染成「正文 + 键盘」；视图名非法或无权时返回 null */
async function renderView(
  env: Env,
  view: string,
  binding: BindingRow,
  user: Record<string, unknown>,
  cfg: TgConfigRow
): Promise<TgView | null> {
  const isAdminUser = isAnyAdmin(String(user.role ?? ""))
  const [name, arg] = view.split(":")
  switch (name) {
    case "menu":
      return {
        text: "☁️ <b>DoulorCloud</b>\n点下面的按钮查看，卡片会原地切换，不用返回网页。",
        keyboard: menuKeyboard(isAdminUser),
      }
    case "me":
      return { text: await meSummary(env, user), keyboard: subKeyboard(isAdminUser, name) }
    case "frp":
      return { text: await frpSummary(env, binding.user_id), keyboard: subKeyboard(isAdminUser, name) }
    case "mail": {
      const page = Math.max(1, Number(arg) || 1)
      const { text, pages } = await mailSummary(env, binding.user_id, page)
      const row: Array<Record<string, unknown>> = []
      if (page > 1) row.push({ text: "⬅️ 上一页", callback_data: `v:mail:${page - 1}` })
      if (page < pages) row.push({ text: "下一页 ➡️", callback_data: `v:mail:${page + 1}` })
      const kb: Array<Array<Record<string, unknown>>> = []
      if (row.length > 0) kb.push(row)
      kb.push([
        { text: "🔄 刷新", callback_data: `v:mail:${page}` },
        { text: BACK_LABEL, callback_data: "v:menu" },
      ])
      return { text, keyboard: { inline_keyboard: kb } }
    }
    case "dns":
      return { text: await dnsSummary(env, binding.user_id), keyboard: subKeyboard(isAdminUser, name) }
    case "points":
      return { text: await pointsSummary(env, binding.user_id), keyboard: subKeyboard(isAdminUser, name) }
    case "invite":
      return { text: await inviteSummary(env, binding.user_id), keyboard: subKeyboard(isAdminUser, name) }
    case "storage":
      return { text: await storageSummary(env, binding.user_id), keyboard: subKeyboard(isAdminUser, name) }
    case "community":
      return { text: await communitySummary(env, binding.user_id), keyboard: subKeyboard(isAdminUser, name) }
    case "notices":
      return { text: await noticesSummary(env, binding.user_id), keyboard: subKeyboard(isAdminUser, name) }
    case "security":
      return { text: await securitySummary(env, binding.user_id, user), keyboard: subKeyboard(isAdminUser, name) }
    case "settings":
      return {
        text: await settingsText(env, binding),
        keyboard: settingsKeyboard(parseJson<string[]>(binding.muted_json, []), isAdminUser),
      }
    case "status":
      if (!isAdminUser) return null
      return { text: await statusSummary(env, cfg), keyboard: subKeyboard(isAdminUser, name) }
    default:
      return null
  }
}

/**
 * 原地改写卡片；只有「消息没了 / 改不动」才退回发新消息。
 * `message is not modified`（用户重复点同一个按钮）视为成功，不重发。
 */
async function editOrSend(
  env: Env,
  chatId: string,
  messageId: number | undefined,
  view: TgView
): Promise<void> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text: view.text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: view.keyboard,
  }
  if (messageId) {
    const r = await tgApi(env, "editMessageText", { ...payload, message_id: messageId })
    if (r.ok) return
    if ((r.description ?? "").toLowerCase().includes("not modified")) return
  }
  const sent = await tgApi(env, "sendMessage", payload)
  await logPush(env, "message", chatId, sent.ok, sent.ok ? undefined : sent.description)
}

/**
 * 处理 inline 按钮回调。
 * 权限口径与命令一致：只私聊、必须已绑定、站点状态额外校验角色。
 */
async function handleCallback(
  env: Env,
  cb: {
    id: string
    data?: string
    message?: { message_id?: number; chat?: { id?: number; type?: string } }
  },
  cfg: TgConfigRow
): Promise<void> {
  const chatId = cb.message?.chat?.id != null ? String(cb.message.chat.id) : ""
  const messageId = cb.message?.message_id
  const data = cb.data ?? ""
  const ack = (text?: string) =>
    tgApi(env, "answerCallbackQuery", text ? { callback_query_id: cb.id, text } : { callback_query_id: cb.id })

  if (!chatId || cb.message?.chat?.type !== "private") {
    await ack("仅支持私聊使用")
    return
  }
  const binding = await bindingByTg(env, chatId)
  if (!binding) {
    await ack("请先绑定账号")
    return
  }
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(binding.user_id)
    .first<Record<string, unknown>>()
  if (!user) {
    await ack("账号不存在")
    return
  }

  // 通知开关：切完立刻原地刷新设置视图
  if (data.startsWith("s:")) {
    const key = data.slice(2)
    if (!MUTE_LABELS[key]) {
      await ack("未知选项")
      return
    }
    const muted = parseJson<string[]>(binding.muted_json, [])
    const next = muted.includes(key) ? muted.filter((m) => m !== key) : [...muted, key]
    await env.DB.prepare("UPDATE tg_bindings SET muted_json = ? WHERE telegram_id = ?")
      .bind(JSON.stringify(next), chatId)
      .run()
    await ack(next.includes(key) ? `已静音：${MUTE_LABELS[key]}` : `已开启：${MUTE_LABELS[key]}`)
    const view = await renderView(env, "settings", { ...binding, muted_json: JSON.stringify(next) }, user, cfg)
    if (view) await editOrSend(env, chatId, messageId, view)
    return
  }

  // 视图切换：v:me / v:frp / v:mail / v:dns / v:settings / v:status / v:menu
  if (data.startsWith("v:")) {
    const view = await renderView(env, data.slice(2), binding, user, cfg)
    if (!view) {
      await ack("无权访问或视图不存在")
      return
    }
    await ack()
    await editOrSend(env, chatId, messageId, view)
    return
  }

  await ack()
}

export type PushKind =
  | "login"
  | "frpExpiry"
  | "nodeDown"
  | "daily"
  | "email"
  | "comment"
  | "like"
  | "points"

export async function pushMessage(
  env: Env,
  kind: PushKind,
  opts: { userId?: string; text: string; adminOnly?: boolean; dedupeHours?: number }
): Promise<number> {
  let sent = 0
  try {
    const cfg = await loadConfig(env)
    if (!cfg.enabled) return 0
    const pushes = { ...DEFAULT_PUSHES, ...parseJson<Record<string, boolean>>(cfg.pushes_json, {}) }
    if (pushes[kind] === false) return 0
    if (!(await botToken(env, cfg))) return 0
    let targets: string[]
    if (opts.userId) {
      const row = await env.DB.prepare("SELECT telegram_id, muted_json FROM tg_bindings WHERE user_id = ?")
        .bind(opts.userId)
        .first<{ telegram_id: string; muted_json: string }>()
      if (!row) return 0
      const muted = parseJson<string[]>(row.muted_json, [])
      if (muted.includes(kind)) return 0
      targets = [row.telegram_id]
    } else {
      targets = await adminTargets(env)
    }
    for (const t of targets) {
      // 去重：同一接收方在窗口内已经收过同类推送就不再发（到期提醒/掉线/日报都需要）
      if (opts.dedupeHours && (await pushedRecently(env, kind, t, opts.dedupeHours))) continue
      if (await sendTo(env, t, opts.text)) sent++
    }
  } catch {
    // 推送失败绝不影响业务主流程
  }
  return sent
}

/** 某个接收方在 N 小时内是否已收到过同类推送（配合 pushMessage 的 dedupeHours） */
async function pushedRecently(
  env: Env,
  kind: string,
  target: string,
  hours: number
): Promise<boolean> {
  const since = Date.now() - hours * 3600 * 1000
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM tg_push_log WHERE kind = ? AND target = ? AND ok = 1 AND created_at > ?"
  )
    .bind(kind, target, since)
    .first<{ n: number }>()
  return (row?.n ?? 0) > 0
}

/** GET /me/tg/binding —— 当前用户的绑定状态（没绑定返回 bound:false） */
export async function getMyBinding(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const row = await env.DB.prepare(
    "SELECT telegram_id, tg_username, bound_at, muted_json FROM tg_bindings WHERE user_id = ?"
  )
    .bind(user.id)
    .first<{ telegram_id: string; tg_username: string | null; bound_at: number; muted_json: string }>()
  if (!row) return json({ bound: false })
  return json({
    bound: true,
    telegramId: row.telegram_id,
    tgUsername: row.tg_username,
    boundAt: row.bound_at,
    muted: parseJson<string[]>(row.muted_json, []),
  })
}

/** DELETE /me/tg/binding —— 用户自助解绑 */
export async function deleteMyBinding(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  await env.DB.prepare("DELETE FROM tg_bindings WHERE user_id = ?").bind(user.id).run()
  return json({ ok: true })
}

/** POST /me/tg/binding/mute —— 用户关掉某类通知（目前页面上还没露出，先留接口） */
export async function setMyMuted(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = await readJson<{ muted?: string[] }>(request, 4 * 1024)
  const muted = (body.muted ?? []).filter((k) => typeof k === "string").slice(0, 10)
  await env.DB.prepare("UPDATE tg_bindings SET muted_json = ? WHERE user_id = ?")
    .bind(JSON.stringify(muted), user.id)
    .run()
  return json({ ok: true, muted })
}
/* ==========================================================================
 * 命令菜单（Telegram 的「/」按钮）
 *
 * 用 `setMyCommands` 的 **per-chat scope** 实现分级：
 *   · 默认 scope（未绑定的人看到）：/bind /help
 *   · 已绑定用户的 chat scope：/me /frp /unbind /help
 *   · 管理员再加 /status
 * 绑定时立刻同步一次，解绑时把该 chat 的 scope 删掉回落到默认。
 * ========================================================================== */

interface TgCommand {
  command: string
  description: string
}

/** 按「是否绑定 + 角色 + 命令开关」算出一份菜单；纯函数，便于单测 */
export function buildCommandMenu(opts: {
  bound: boolean
  isAdminUser: boolean
  commands: Record<string, boolean>
}): TgCommand[] {
  const out: TgCommand[] = []
  if (!opts.bound) {
    out.push({ command: "bind", description: "绑定站内账号（先在网站生成绑定码）" })
    out.push({ command: "help", description: "查看帮助" })
    return out
  }
  out.push({ command: "menu", description: "快捷入口（按钮操作）" })
  if (opts.commands.me !== false) out.push({ command: "me", description: "我的账号概览" })
  if (opts.commands.frp !== false) out.push({ command: "frp", description: "我的内网穿透租约" })
  if (opts.commands.mail !== false) out.push({ command: "mail", description: "我的邮箱与最近邮件" })
  if (opts.commands.dns !== false) out.push({ command: "dns", description: "我的域名与解析" })
  if (opts.commands.points !== false) out.push({ command: "points", description: "积分与最近明细" })
  if (opts.commands.invite !== false) out.push({ command: "invite", description: "我的邀请码与战绩" })
  if (opts.commands.storage !== false) out.push({ command: "storage", description: "网盘用量与最近文件" })
  if (opts.commands.community !== false) out.push({ command: "community", description: "我的创作与互动" })
  if (opts.commands.notices !== false) out.push({ command: "notices", description: "未读站内通知" })
  if (opts.commands.security !== false) out.push({ command: "security", description: "登录环境与活跃会话" })
  if (opts.commands.settings !== false) out.push({ command: "settings", description: "通知设置" })
  out.push({ command: "unbind", description: "解除绑定" })
  out.push({ command: "help", description: "查看帮助" })
  if (opts.isAdminUser && opts.commands.status !== false) {
    out.push({ command: "status", description: "站点状态（管理员）" })
  }
  return out
}

async function setChatMenu(env: Env, chatId: string, commands: TgCommand[]): Promise<boolean> {
  const r = await tgApi(env, "setMyCommands", {
    commands,
    scope: { type: "chat", chat_id: Number(chatId) },
  })
  return r.ok
}

async function clearChatMenu(env: Env, chatId: string): Promise<boolean> {
  const r = await tgApi(env, "deleteMyCommands", { scope: { type: "chat", chat_id: Number(chatId) } })
  return r.ok
}

/** 按 chat 当前状态刷新菜单（绑定时 / 解绑时 / 用户发 /start、/help 时都会调） */
async function refreshChatMenu(env: Env, chatId: string, cfg: TgConfigRow): Promise<void> {
  const commands = { ...DEFAULT_COMMANDS, ...parseJson<Record<string, boolean>>(cfg.commands_json, {}) }
  const binding = await bindingByTg(env, chatId)
  if (!binding) {
    await clearChatMenu(env, chatId)
    return
  }
  const role =
    (
      await env.DB.prepare("SELECT role FROM users WHERE id = ?")
        .bind(binding.user_id)
        .first<{ role: string }>()
    )?.role ?? ""
  await setChatMenu(
    env,
    chatId,
    buildCommandMenu({ bound: true, isAdminUser: isAnyAdmin(role), commands })
  )
}

/** 管理端「同步命令菜单」：刷新默认 scope + 所有已绑定 chat 的 scope */
export async function syncCommands(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "telegram")
  const cfg = await loadConfig(env)
  const commands = { ...DEFAULT_COMMANDS, ...parseJson<Record<string, boolean>>(cfg.commands_json, {}) }
  const def = await tgApi(env, "setMyCommands", {
    commands: buildCommandMenu({ bound: false, isAdminUser: false, commands }),
    scope: { type: "default" },
  })
  if (!def.ok) throw new ApiError(400, `设置默认菜单失败：${def.description ?? "未知错误"}`, "SET_MENU_FAILED")

  const { results } = await env.DB.prepare(
    `SELECT b.telegram_id, u.role FROM tg_bindings b LEFT JOIN users u ON u.id = b.user_id LIMIT 500`
  ).all<{ telegram_id: string; role: string | null }>()
  let ok = 0
  for (const row of results ?? []) {
    const done = await setChatMenu(
      env,
      row.telegram_id,
      buildCommandMenu({ bound: true, isAdminUser: isAnyAdmin(row.role ?? ""), commands })
    )
    if (done) ok++
  }
  await recordAudit(env, admin.id, "tg.commands.sync", `默认菜单 + ${ok} 个 chat`)
  return json({ ok: true, chats: ok, total: results?.length ?? 0 })
}

/** /frp：查自己的内网穿透租约（用户自助，最常用） */
async function frpSummary(env: Env, userId: string): Promise<string> {
  const { results } = await env.DB.prepare(
    `SELECT s.expires_at, s.status, s.ports, s.auto_renew, n.name AS node_name
       FROM frp_subscriptions s
       LEFT JOIN frp_nodes n ON n.id = s.node_id
      WHERE s.user_id = ?
      ORDER BY s.expires_at DESC
      LIMIT 5`
  )
    .bind(userId)
    .all<{
      expires_at: string
      status: string
      ports: string | null
      auto_renew: number
      node_name: string | null
    }>()
  if (!results || results.length === 0) {
    return "你还没有内网穿透租约。\n开通：${SITE_URL} → 内网穿透"
  }
  const lines = ["<b>我的内网穿透</b>"]
  for (const r of results) {
    const ports = parseJson<number[]>(r.ports, [])
    const left = Math.ceil((Date.parse(r.expires_at) - Date.now()) / (24 * 3600 * 1000))
    const state = r.status === "active" ? (left <= 0 ? "已过期" : "使用中") : r.status
    lines.push(
      "",
      `节点：${r.node_name ?? "未知"}（${state}）`,
      `端口：${ports.length ? ports.join(" / ") : "—"}`,
      `到期：${new Date(r.expires_at).toLocaleString("zh-CN", { hour12: false })}${left > 0 ? `（${left} 天后）` : ""}`,
      `自动续费：${r.auto_renew ? "开" : "关"}`
    )
  }
  lines.push("", `管理：${SITE_URL} → 内网穿透`)
  return lines.join("\n")
}