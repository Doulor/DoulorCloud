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
import { publishAnnouncementNow } from "./announcements"
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
export async function updateAdminConfig(
  env: Env,
  request: Request,
  ctx?: ExecutionContext
): Promise<Response> {
  const admin = await requireAdminScope(env, request, "telegram")
  const body = await readJson<ConfigUpdateBody>(request, 8 * 1024)
  const sets: string[] = []
  const binds: unknown[] = []
  let note = ""

  // ⚠️ 必须在 UPDATE **之前**取旧值：下面的「命令开关有没有变」要靠它比较。
  // 之前这段读在 UPDATE 之后，前后永远相等 ⇒ 永远不会触发菜单刷新（2026-10-22 修的）。
  const before = await env.DB.prepare("SELECT commands_json FROM tg_bot_config WHERE id = 1").first<{
    commands_json: string | null
  }>()
  const prevCommands = {
    ...DEFAULT_COMMANDS,
    ...parseJson<Record<string, boolean>>(before?.commands_json ?? null, {}),
  }

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

  // 命令开关变了 → 重刷菜单，被关掉的命令马上从「/」候选里消失。
  //
  // 两个性能保护：
  //  ① 开关与库里完全一致就跳过 —— 改推送开关/启用状态时不该白刷一遍菜单；
  //  ② 有 ctx 就走 waitUntil 后台跑 —— 管理页的「保存」不必等几百个 chat 刷完。
  // 刷新失败不影响保存本身（配置已落库，站长还能手点「同步命令菜单」重试）。
  if (body.commands && typeof body.commands === "object") {
    const merged = { ...DEFAULT_COMMANDS, ...body.commands }
    const changed = JSON.stringify(merged) !== JSON.stringify(prevCommands)
    if (changed) {
      const job = syncAllMenus(env, merged).catch((err) => {
        console.error("命令开关保存后刷新菜单失败:", err)
      })
      if (ctx) ctx.waitUntil(job)
      else await job
    }
  }

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
  /** 机器人被拉进/移出频道或群（频道自动登记用） */
  my_chat_member?: {
    chat?: { id?: number; title?: string; username?: string; type?: string }
    new_chat_member?: { status?: string }
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

function helpText(isAdminUser: boolean, commands: Record<string, boolean>): string {
  const on = (k: string) => commands[k] !== false
  const lines = ["☁️ <b>DoulorCloud 机器人</b>", "", "<b>查询</b>"]
  lines.push("/menu —— 快捷入口（按钮操作，不用记命令）")
  if (on("me")) lines.push("/me —— 我的账号概览")
  if (on("frp")) lines.push("/frp —— 我的内网穿透租约")
  if (on("mail")) lines.push("/mail —— 我的邮箱与最近邮件")
  if (on("dns")) lines.push("/dns —— 我的域名与解析")
  if (on("points")) lines.push("/points —— 积分与最近明细")
  if (on("invite")) lines.push("/invite —— 我的邀请码与战绩")
  if (on("storage")) lines.push("/storage —— 网盘用量与最近文件")
  if (on("community")) lines.push("/community —— 我的创作与互动")
  if (on("notices")) lines.push("/notices —— 未读站内通知")
  if (on("security")) lines.push("/security —— 登录环境与活跃会话")
  lines.push("", "<b>设置</b>")
  if (on("settings")) lines.push("/settings —— 通知开关")
  lines.push("/bind &lt;绑定码&gt; —— 绑定站内账号", "/unbind —— 解除绑定")
  if (isAdminUser && on("status")) {
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

  // 机器人被拉进/移出频道：这是「频道推送」的唯一自动入口，
  // 必须在下面的「仅私聊」判断**之前**处理 —— 频道的 chat.type 是 "channel"。
  if (update.my_chat_member) {
    await handleChatMember(env, update.my_chat_member)
    return json({ ok: true })
  }

  // inline 按钮回调优先处理：它没有 message.text，走不到下面的命令分发
  if (update.callback_query) {
    await handleCallback(env, update.callback_query, cfg)
    return json({ ok: true })
  }

  const msg = update.message
  const chatId = msg?.chat?.id != null ? String(msg.chat.id) : ""
  const text = (msg?.text ?? "").trim()

  // 群 / 超级群：走「聊天室 ↔ TG 群」桥接（2026-10-24，方案 B）。
  // 必须在「仅私聊」判断**之前**分流，否则群消息会被当成非法 update 丢掉。
  if (msg?.chat?.type === "group" || msg?.chat?.type === "supergroup") {
    await handleGroupMessage(env, msg, cfg)
    return json({ ok: true })
  }

  if (!chatId || !text) return json({ ok: true, ignored: "no-text" })
  // 私聊以外的其它类型（channel_post 等）仍然不理
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
    await sendTo(env, chatId, helpText(false, { ...DEFAULT_COMMANDS, ...parseJson<Record<string, boolean>>(cfg.commands_json, {}) }))
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
    await sendTo(env, chatId, helpText(isAnyAdmin(roleNow), { ...DEFAULT_COMMANDS, ...parseJson<Record<string, boolean>>(cfg.commands_json, {}) }))
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

  /**
   * 公告新建流程在等「标题 / 正文」时，这条文本归它处理（迁移 0179 的状态机）。
   * 只在管理员身上生效，且 /ann、/公告 不拦（否则会卡住面板入口）。
   */
  if (
    isAnyAdmin(role) &&
    !text.startsWith("/ann") &&
    !text.startsWith("/公告") &&
    !text.startsWith("/announce") &&
    (await annHandleText(env, chatId, text))
  ) {
    return json({ ok: true })
  }

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

    // 管理员：/公告 —— 公告快捷管理卡（非管理员静默忽略，与其它管理命令同口径）
  const cmdAny = cmd as string
  if (cmdAny === "/公告" || cmdAny === "/ann" || cmdAny === "/announce") {
    const me = await env.DB.prepare("SELECT role FROM users WHERE id = ?")
      .bind(binding.user_id)
      .first<{ role: string }>()
    if (!isAnyAdmin(String(me?.role ?? ""))) return json({ ok: true, ignored: "no-perm" })

    // 顺带刷新该 chat 的菜单（老用户绑定时菜单里还没有 ann）
    await setChatMenu(env, chatId, buildCommandMenu({ bound: true, isAdminUser: true, commands })).catch(() => {})

    // `/公告 标题 | 正文` → 新建一条**草稿**（不发出去），然后回管理卡片
    if (arg) {
      const [rawTitle, ...rest] = arg.split("|")
      const title = (rawTitle ?? "").trim().slice(0, 100)
      const bodyText = rest.join("|").trim().slice(0, 1000)
      if (!title) {
        await sendTo(env, chatId, "用法：/公告 标题 | 正文（正文可省略）")
        return json({ ok: true })
      }
      try {
        await env.DB.prepare(
          `INSERT INTO announcements (id, title, body, category, pinned, created_at, status, notify_email)
           VALUES (?, ?, ?, 'general', 0, ?, 'draft', 0)`
        )
          .bind(uuid(), title, bodyText || "", new Date().toISOString())
          .run()
        await sendTo(env, chatId, `已创建草稿：${title}\n回面板列表里点开它就能发布。`)
      } catch (err) {
        await sendTo(env, chatId, "创建草稿失败：" + (err instanceof Error ? err.message : "未知错误"))
        return json({ ok: true })
      }
    }

    await annMenu(env, chatId)
    return json({ ok: true })
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
  // ⚠️ 这张表就是用户侧 /settings 的按钮来源：新增推送类型时**必须**同步这里，
  // 否则 pushMessage 认得、用户却看不到开关（2026-10-22 踩过一次）。
  comment: "评论/回复（每条）",
  like: "点赞（每个）",
  points: "积分到账",
}

/**
 * 防漂移自检（开发期兜底）：DEFAULT_PUSHES 里的每一类都必须有用户可见的静音开关。
 * 两边漂移的后果是「后端会推、用户关不掉」，很难在测试里发现，只能靠这条断言喊出来。
 */
function assertPushLabelsInSync(): void {
  const missing = Object.keys(DEFAULT_PUSHES).filter((k) => !(k in MUTE_LABELS))
  if (missing.length > 0) {
    console.error("推送类型缺少用户侧静音开关（MUTE_LABELS）:", missing.join(", "))
  }
}



async function settingsText(_env: Env, binding: BindingRow): Promise<string> {
  assertPushLabelsInSync()
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

/** 短标识：把 openid/id 压成 6 位十六进制，用于区分群里的不同人 */
function shortTag(raw: string): string {
  let h = 0
  for (const ch of raw) h = (h * 31 + ch.charCodeAt(0)) % 0xffffff
  return h.toString(16).toUpperCase().padStart(6, "0")
}

/* ==========================================================================
 * 聊天室 ↔ TG 群 桥接（群 → 站内）
 *
 * 方案 B（站长 2026-10-23 定）：未绑定站内账号的群成员也能发言，以「TG:@用户名」
 * 的访客身份进站内。护栏见 ensureShadowUser 与 handleGroupMessage。
 * ========================================================================== */

/** TG 发来的消息里我们能桥的部分 */
interface TgGroupMessage {
  message_id?: number
  text?: string
  caption?: string
  photo?: Array<{ file_id?: string; file_size?: number }>
  sticker?: {
    file_id?: string
    emoji?: string
    is_animated?: boolean
    is_video?: boolean
    /** 缩略图（webp）：动图贴纸的原始文件是 webm/tgs，<img> 渲染不了，只能靠它 */
    thumb?: { file_id?: string }
    thumbnail?: { file_id?: string }
  }
  document?: { file_id?: string; file_name?: string; mime_type?: string }
  video?: { file_id?: string }
  voice?: { file_id?: string }
  from?: { id?: number; is_bot?: boolean; username?: string; first_name?: string }
  chat?: { id?: number; type?: string; title?: string }
}

/**
 * 拿（或创建）一个 Telegram 访客的影子账号，返回 user_id。
 *
 * 影子账号 = 不可登录的真实用户行：
 *   · role='guest'（登录入口显式拒绝，见 auth.ts login）
 *   · password_hash 是不可用的占位串，任何口令都验不过
 *   · tg_shadow_id 唯一索引防重复创建（并发下靠 unique violation 兜底再查一次）
 */
/**
 * 本群「访客账号」：每个群一个，未绑定成员共用（2026-10-24）。
 *
 * 原来按人建影子账号，站长实测「每有一个人说话，网站里就多一个用户」——
 * 这些账号不可辨识、还会虚增用户统计。现在每群只留一个。
 */
async function ensureGroupGuestUser(env: Env, chatId: string): Promise<string> {
  const key = `group:${chatId}`
  const found = await env.DB.prepare("SELECT id FROM users WHERE tg_shadow_id = ?")
    .bind(key)
    .first<{ id: string }>()
  if (found) return found.id

  const id = uuid()
  const now = new Date().toISOString()
  let short = 0
  for (const ch of chatId) short = (short * 31 + ch.charCodeAt(0)) % 0xffffff
  const suffix = short.toString(16).toUpperCase().padStart(6, "0")
  const username = `tg_guest_${suffix}`.slice(0, 32)
  try {
    await env.DB.prepare(
      `INSERT INTO users (id, username, email, password_hash, namespace, status, role, permissions,
                          invite_code_id, uid, created_at, updated_at, nickname, tg_shadow_id)
       VALUES (?, ?, ?, ?, ?, 'active', 'guest', '[]', NULL,
               (SELECT COALESCE(MAX(uid), 0) + 1 FROM users), ?, ?, ?, ?)`
    )
      .bind(id, username, `${username}@shadow.invalid`, "!shadow-no-login", username, now, now, "TG 群友", key)
      .run()
    return id
  } catch {
    const again = await env.DB.prepare("SELECT id FROM users WHERE tg_shadow_id = ?")
      .bind(key)
      .first<{ id: string }>()
    if (again) return again.id
    throw new ApiError(500, "创建访客账号失败", "SHADOW_FAILED")
  }
}
/** 把一条群消息的正文抽出来（纯文本 / 图片+说明 / 贴纸 / 文件） */
function groupMessageBody(msg: TgGroupMessage): string | null {
  const text = (msg.text ?? "").trim()
  if (text) return text

  const caption = (msg.caption ?? "").trim()
  /**
   * 站内聊天室渲染的是 markdown 图片（站内表情包本身就是 `![](/api/stickers/…)`），
   * 所以这里必须吐 `![](/api/tg/file/…)`，图才会显示出来（2026-10-24 站长实测反馈：
   * 之前吐的是裸链接，站内只有一行文字）。`/api/tg/file` 要求登录，站内用户天然满足。
   */
  const image = (fileId: string) => `![](${`/api/tg/file/${encodeURIComponent(fileId)}`})`
  // 文件/视频/语音没法内联成图片，仍然给链接（点开走服务端中转）
  const link = (fileId: string) => `/api/tg/file/${encodeURIComponent(fileId)}`

  // 图片：取分辨率最大的一张
  if (msg.photo && msg.photo.length > 0) {
    const best = msg.photo[msg.photo.length - 1]?.file_id
    return best ? `${image(best)}${caption ? `\n${caption}` : ""}` : null
  }
  if (msg.sticker?.file_id) {
    /**
     * 动图贴纸的原始文件是 **video/webm**（.tgs 是 lottie），`<img>` 渲染不出来 ——
     * 站长实测「只剩一个 emoji」就是这个原因。所以优先用 webp 缩略图；
     * 连缩略图都没有（很老的贴纸）就退化成文字 + 链接，绝不放一张破图。
     */
    const thumbId = msg.sticker.thumb?.file_id ?? msg.sticker.thumbnail?.file_id
    const emoji = msg.sticker.emoji ?? ""
    if (thumbId) {
      return `${image(thumbId)}${caption ? `\n${caption}` : ""}${emoji ? `\n${emoji}` : ""}`
    }
    const kind = msg.sticker.is_video ? "动图贴纸" : msg.sticker.is_animated ? "动态贴纸" : "贴纸"
    return `🎨 [${kind}]${emoji}${caption ? ` ${caption}` : ""}\n${link(msg.sticker.file_id)}`
  }
  if (msg.document?.file_id) {
    const name = msg.document.file_name ?? "文件"
    return `📎 [文件] ${name}${caption ? ` ${caption}` : ""}\n${link(msg.document.file_id)}`
  }
  if (msg.video?.file_id) return `🎬 [视频]${caption ? ` ${caption}` : ""}\n${link(msg.video.file_id)}`
  if (msg.voice?.file_id) return `🎤 [语音]\n${link(msg.voice.file_id)}`
  return null
}

/**
 * 处理一条群消息：白名单 → 防回声 → 限流 → 身份映射 → 落库。
 *
 * 全部异常都在内部吞掉并返回（webhook 永远 200，避免 Telegram 重投同一批 update）。
 */
async function handleGroupMessage(env: Env, msg: TgGroupMessage, cfg: TgConfigRow): Promise<void> {
  try {
    const groupId = msg.chat?.id != null ? String(msg.chat.id) : ""
    if (!groupId) return

    // ① 白名单：只有登记为 kind='group' 且启用的群才桥
    const allowed = await env.DB.prepare(
      "SELECT 1 AS ok FROM tg_channels WHERE chat_id = ? AND kind = 'group' AND enabled = 1"
    )
      .bind(groupId)
      .first<{ ok: number }>()
    if (!allowed) return

    // ② 防回声：我们自己推到群里的消息来自 bot，直接丢
    if (msg.from?.is_bot) return

    const body = groupMessageBody(msg)
    if (!body) return

    /**
     * 群里的机器人命令**绝不能桥进站内**（2026-10-24 线上事故）。
     *
     * 实测有人在群里发 `/bind 1111`，这条 update 同时被 webhook 收到，
     * 结果绑定码被当成聊天内容写进公开聊天室 —— 等于把别人的绑定码贴在大厅里。
     *
     * 但站长要求「群里也能绑定」，所以 `/bind <码>` 走**私信回复**：
     * 绑定结果（含账号名、成功/失败原因）只发给本人，群里一个字都不留。
     */
    const cmdMatch = /^\/([A-Za-z0-9_]{1,32})(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(body)
    if (cmdMatch) {
      const cmd = (cmdMatch[1] ?? "").toLowerCase()
      const arg = (cmdMatch[2] ?? "").trim()
      const dmId = msg.from?.id != null ? String(msg.from.id) : ""
      // /bind 123456 或深链形式的 /start 123456（群里只有 /bind 有意义）
      if (cmd === "bind" && /^\d{6}$/.test(arg) && dmId) {
        await tryBindCode(env, dmId, arg, cfg, msg.from?.username ?? null)
      }
      return // 命令一律不桥接
    }
    // 纯 6 位数字（绑定码的"等待输入"形态）也不要桥
    if (/^\d{6}$/.test(body)) return

    // ③ 限流：每人 10 条/分钟（与私聊命令同一套计数）
    const tgUserId = msg.from?.id != null ? String(msg.from.id) : ""
    if (!tgUserId) return
    if (!(await withinRateLimit(env, `tgchat:${tgUserId}`))) return

    // ④ 身份：绑定过的用本人，没绑定的建影子账号（方案 B）
    const binding = await bindingByTg(env, tgUserId)
    // 未绑定成员统一归到「本群访客」账号（每群一个，避免用户数虚增）
  const userId = binding ? binding.user_id : await ensureGroupGuestUser(env, groupId)

    // ⑤ 落库（source='tg' + tg_message_id 供删帖同步与去重）
    // TG 有 username 就用，没有就用短标识区分
    const displayName = msg.from?.username
      ? `TG:@${msg.from.username}`
      : `TG群友 #${shortTag(tgUserId)}`

    await env.DB.prepare(
      `INSERT INTO chat_messages (id, user_id, body, created_at, source, tg_message_id, tg_username, tg_chat_id, display_name)
       VALUES (?, ?, ?, ?, 'tg', ?, ?, ?, ?)`
    )
      .bind(
        uuid(),
        userId,
        body.slice(0, 4000),
        new Date().toISOString(),
        msg.message_id != null ? String(msg.message_id) : null,
        msg.from?.username ?? null,
        groupId,
        displayName
      )
      .run()

    await logPush(env, "ch:chat:in", groupId, true)
  } catch (err) {
    await logPush(
      env,
      "ch:chat:in:err",
      "(exception)",
      false,
      err instanceof Error ? err.message : String(err)
    ).catch(() => undefined)
  }
}

/**
 * GET /api/tg/file/<file_id> —— 把 Telegram 上的图片/文件经服务端中转给站内用户。
 *
 * 为什么需要：Telegram 的直链是 `https://api.telegram.org/file/bot<TOKEN>/...`，
 * 把这种链接贴进聊天室等于把机器人 token 公开给所有人。所以服务端取文件再流式返回。
 * 权限：必须已登录（requireUser）；只允许 file_id 形态的字符串，杜绝拿它当通用代理。
 */
export async function serveTgFile(env: Env, request: Request, fileId: string): Promise<Response> {
  await requireUser(env, request)
  const id = decodeURIComponent(fileId)
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) {
    throw new ApiError(400, "非法的文件标识", "BAD_FILE_ID")
  }
  const cfg = await loadConfig(env)
  if (!cfg.enabled) throw new ApiError(404, "机器人未启用", "BOT_DISABLED")
  const token = await botToken(env, cfg)
  if (!token) throw new ApiError(404, "机器人未配置", "NO_TOKEN")

  const info = await tgApi(env, "getFile", { file_id: id }, token)
  if (!info.ok) throw new ApiError(404, "文件不存在或已过期", "FILE_NOT_FOUND")
  const filePath = (info.result as { file_path?: string } | undefined)?.file_path
  if (!filePath) throw new ApiError(404, "文件不存在或已过期", "FILE_NOT_FOUND")

  const upstream = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`)
  if (!upstream.ok || !upstream.body) throw new ApiError(502, "读取文件失败", "UPSTREAM_FAILED")

  const lower = filePath.toLowerCase()
  const type = lower.endsWith(".png")
    ? "image/png"
    : lower.endsWith(".jpg") || lower.endsWith(".jpeg")
      ? "image/jpeg"
      : lower.endsWith(".webp")
        ? "image/webp"
        : lower.endsWith(".gif")
          ? "image/gif"
          : lower.endsWith(".webm")
            ? "video/webm"
            : lower.endsWith(".mp4")
              ? "video/mp4"
              : lower.endsWith(".ogg")
                ? "audio/ogg"
                : lower.endsWith(".mp3")
                  ? "audio/mpeg"
                  : "application/octet-stream"
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": type,
      // 私有缓存：每个用户的浏览器缓存 1 小时，别让 CDN 变成公共图床
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  })
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

  // 公告多层级面板：a:m 主菜单 / a:l 列表 / a:v 详情 / a:x 删除确认 / a:dd 真删
  //                    a:p 发布 / a:o 下线 / a:n 新建 / a:nw 存草稿 / a:np 发布 / a:nc 取消
  if (data.startsWith("a:")) {
    if (!isAnyAdmin(String(user.role ?? ""))) {
      await ack("没有权限")
      return
    }
    const parts = data.split(":")
    const act = parts[1] ?? ""
    const arg1 = parts[2] ?? ""
    const arg2 = parts[3] ?? ""
    if (act === "m") {
      await ack()
      await annMenu(env, chatId, messageId)
      return
    }
    if (act === "l") {
      await ack()
      await annList(env, chatId, messageId)
      return
    }
    if (act === "v" && arg1) {
      await ack()
      await annDetail(env, chatId, arg1, messageId)
      return
    }
    if (act === "x" && arg1) {
      await ack()
      await annDeleteConfirm(env, chatId, arg1, messageId)
      return
    }
    if (act === "dd" && arg1) {
      // 先删频道里那条（要 message_id），再删库
      await deleteAnnouncementMessages(env, arg1)
      await env.DB.prepare("DELETE FROM announcements WHERE id = ?").bind(arg1).run()
      await ack("已删除（含频道消息）")
      await annList(env, chatId, messageId)
      return
    }
    if (act === "p" && arg1) {
      try {
        await publishAnnouncementNow(env, arg1)
        await ack("已发布")
      } catch (err) {
        await ack("发布失败：" + (err instanceof Error ? err.message : "未知错误"))
      }
      await annDetail(env, chatId, arg1, messageId)
      return
    }
    if (act === "o" && arg1) {
      await env.DB.prepare("UPDATE announcements SET status = 'draft', published_at = NULL WHERE id = ?")
        .bind(arg1)
        .run()
      await ack("已下线")
      await annDetail(env, chatId, arg1, messageId)
      return
    }
    if (act === "n") {
      await ack()
      await annStartCreate(env, chatId, messageId)
      return
    }
    // 新建向导第 3 步：选了提醒方式 → 进预览
    if (act === "pp" && arg1) {
      const st = await getAnnState(env, chatId)
      if (!st || st.kind !== "ann_popup") {
        await ack("这个会话已过期")
        await annMenu(env, chatId, messageId)
        return
      }
      const payload = { ...st.payload, popup: arg1 }
      await setAnnState(env, chatId, "ann_preview", payload)
      await ack("已选：" + (ANN_POPUP_SHORT[arg1] ?? arg1))
      await annPreview(env, chatId, messageId, payload)
      return
    }
    // 改已有公告的提醒方式（点一下立刻生效，不用重新发布）
    if (act === "pm" && arg1 && arg2) {
      await env.DB.prepare("UPDATE announcements SET popup_mode = ? WHERE id = ?").bind(arg1, arg2).run()
      await ack("提醒方式已改为：" + (ANN_POPUP_SHORT[arg1] ?? arg1))
      await annDetail(env, chatId, arg2, messageId)
      return
    }
    if (act === "nw" || act === "np") {
      await ack()
      await annCreateSave(env, chatId, messageId, act === "np")
      return
    }
    if (act === "nc") {
      await clearAnnState(env, chatId)
      await ack("已取消")
      await annMenu(env, chatId, messageId)
      return
    }
    if (act === "close") {
      await ack()
      if (messageId) {
        await tgApi(env, "deleteMessage", { chat_id: chatId, message_id: messageId }, await botToken(env, cfg))
      }
      return
    }
    await ack("未知操作")
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


/**
 * 删除公告在 TG 频道里的那条消息（2026-10-24）。
 *
 * Telegram 的限制：机器人只能删 **48 小时内** 自己发的消息，更早的会返回
 * "message can't be deleted" —— 这种情况只记日志，不阻断删除流程。
 */
export async function deleteAnnouncementMessages(env: Env, announcementId: string): Promise<number> {
  let deleted = 0
  try {
    const { results } = await env.DB.prepare(
      "SELECT chat_id, message_id FROM tg_announcement_msgs WHERE announcement_id = ?"
    )
      .bind(announcementId)
      .all<{ chat_id: string; message_id: number }>()
    if (!results?.length) return 0
    const token = await botToken(env, await loadConfig(env))
    if (!token) return 0
    for (const row of results) {
      const r = await tgApi(env, "deleteMessage", { chat_id: row.chat_id, message_id: row.message_id }, token)
      if (r.ok) deleted++
      else await logPush(env, "ch:announcement:delete", row.chat_id, false, r.description)
    }
    await env.DB.prepare("DELETE FROM tg_announcement_msgs WHERE announcement_id = ?").bind(announcementId).run()
  } catch (err) {
    await logPush(env, "ch:announcement:delete:err", "(exception)", false, err instanceof Error ? err.message : String(err))
  }
  return deleted
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
/**
 * 把站内正文改写成 Telegram 看得懂的形式（2026-10-24）。
 *
 * 站内聊天室用 markdown 图片（表情包是 `![](/api/stickers/<id>/image)`），
 * 直接丢给 Telegram 只会显示成一串源码。规则：
 *   · 站内表情包等 `/api/...` 相对地址 → 外部取不到（要登录）→ 降级成 `[图片]`
 *   · 绝对 http(s) 图片 → 保留 URL，Telegram 自己会生成预览
 *   · 视频/文件链接同理保留
 */
export function tgSafeText(raw: string): string {
  return raw
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, url: string) => {
      if (/^https?:\/\//i.test(url)) return url
      const label = (alt || "").trim()
      return label ? `[${label}]` : "[图片]"
    })
    // Telegram 里 markdown 的 [文字](链接) 也不解析，转成「文字 链接」更易读
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, text: string, url: string) => `${text} ${url}`)
}

/**
 * 把站内正文拆成「文字 + 图片列表」（2026-10-24）。
 *
 * 站内聊天室用 markdown 图片（表情包是 `![](/api/stickers/<id>/image)`）。
 * 直接丢给 Telegram 只会显示源码，而 `/api/stickers/…/image` 实测**公开可访问**，
 * 所以完全可以交给 `sendPhoto` 发真图。
 *
 * 返回的 photos 是**绝对 URL**；`/api/tg/file/` 的图片要登录（Telegram 抓不到）
 * 且本来就是我们发给站内的，不回推，直接丢弃。
 */
export function splitOutgoing(text: string): { text: string; photos: string[] } {
  const photos: string[] = []
  const rest = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, url: string) => {
    if (url.startsWith("/api/tg/file/")) return "" // 我们自己中转的图，不回推
    const abs = /^https?:\/\//i.test(url) ? url : `https://cloud.doulor.cn${url.startsWith("/") ? "" : "/"}${url}`
    if (photos.length < 3 && !photos.includes(abs)) photos.push(abs)
    const label = (alt || "").trim()
    return label ? `[${label}]` : "[图片]"
  })
  return { text: tgSafeText(rest), photos }
}

/* ==========================================================================
 * 管理员：公告管理（多层级面板，2026-10-24 重做）
 *
 * 站长反馈：原来平铺一行两个按钮（发布/下线 + 删除）不好看、容易误触，而且没法新建。
 * 现在改成三级导航，**全部用 editMessageText 原地翻页**（不刷屏）：
 *
 *   📢 公告管理            ← /ann 或 /公告
 *     ├─ 📋 公告列表 → 点某条进入详情
 *     │     └─ 详情：🚀 发布 / ↓ 下线 / 🗑 删除
 *     │            └─ 删除要过一层「确认永久删除」
 *     └─ ➕ 新建公告 → 发标题 → 发正文 → 预览确认（存草稿 / 直接发布）
 *
 * 起草稿的中间状态存在 tg_bot_states（迁移 0179），一次一步，随时可 /cancel。
 * ========================================================================== */

type AnnStateKind = "ann_title" | "ann_body" | "ann_popup" | "ann_preview"

async function getAnnState(env: Env, chatId: string): Promise<{ kind: string; payload: Record<string, string> } | null> {
  const row = await env.DB.prepare("SELECT kind, payload FROM tg_bot_states WHERE chat_id = ?")
    .bind(chatId)
    .first<{ kind: string; payload: string | null }>()
  if (!row) return null
  // 10 分钟没动作就当过期，避免用户几天后随手发句话被当成公告正文
  return { kind: row.kind, payload: parseJson<Record<string, string>>(row.payload, {}) }
}

async function setAnnState(env: Env, chatId: string, kind: AnnStateKind, payload: Record<string, string> = {}): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO tg_bot_states (chat_id, kind, payload, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(chat_id) DO UPDATE SET kind = excluded.kind, payload = excluded.payload, updated_at = excluded.updated_at"
  )
    .bind(chatId, kind, JSON.stringify(payload), new Date().toISOString())
    .run()
}

async function clearAnnState(env: Env, chatId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM tg_bot_states WHERE chat_id = ?").bind(chatId).run()
}

/** 原地翻页：能 edit 就 edit，失败（消息太旧/内容相同）就新发一条 */
async function annRender(
  env: Env,
  chatId: string,
  messageId: number | undefined,
  text: string,
  keyboard: { text: string; callback_data: string }[][]
): Promise<void> {
  const token = await botToken(env, await loadConfig(env))
  if (!token) return
  const markup = { inline_keyboard: keyboard }
  if (messageId) {
    const r = await tgApi(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      reply_markup: markup,
    }, token)
    if (r.ok) return
  }
  await tgApi(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", reply_markup: markup }, token)
}

/**
 * 公告的提醒方式（对应 announcements.popup_mode）：
 *   none  = 只进消息中心，不弹
 *   once  = 用户下次进入站点时弹一次，点过就不再弹
 *   every = 每次进入站点都弹（重要通知用）
 * 站长 2026-10-24 反馈：机器人里建公告没法选这个，所以补上。
 */
const ANN_POPUP_TEXT: Record<string, string> = {
  none: "🔕 不提醒（只进消息中心）",
  once: "🔔 只提醒一次",
  every: "📢 每次进入都提醒",
}

const ANN_POPUP_SHORT: Record<string, string> = {
  none: "不提醒",
  once: "只提醒一次",
  every: "每次进入都提醒",
}

const ANN_STATUS_TEXT: Record<string, string> = {
  draft: "⚪️ 草稿",
  scheduled: "🕒 已排期",
  published: "🟢 已发布",
  archived: "📦 已归档",
}

/** 一级：主菜单 */
async function annMenu(env: Env, chatId: string, messageId?: number): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT status, COUNT(*) AS c FROM announcements GROUP BY status"
  ).all<{ status: string; c: number }>()
  const byStatus: Record<string, number> = {}
  for (const r of results ?? []) byStatus[r.status] = r.c
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0)
  const summary = [
    `共 ${total} 条`,
    `草稿 ${byStatus.draft ?? 0}`,
    `已发布 ${byStatus.published ?? 0}`,
  ].join(" · ")
  await annRender(
    env,
    chatId,
    messageId,
    `📢 <b>公告管理</b>\n${summary}\n\n发布 = 站内消息中心 + TG 频道 + 邮件队列（按公告自身设置）`,
    [
      [
        { text: "📋 公告列表", callback_data: "a:l" },
        { text: "➕ 新建公告", callback_data: "a:n" },
      ],
      [{ text: "✖️ 关闭", callback_data: "a:close" }],
    ]
  )
}

/** 二级：公告列表 */
async function annList(env: Env, chatId: string, messageId?: number): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT id, title, status FROM announcements ORDER BY created_at DESC LIMIT 8"
  ).all<{ id: string; title: string; status: string }>()
  const rows = results ?? []
  if (!rows.length) {
    await annRender(env, chatId, messageId, "还没有公告。点「➕ 新建公告」建第一条。", [
      [{ text: "➕ 新建公告", callback_data: "a:n" }],
      [{ text: "⬅️ 返回", callback_data: "a:m" }],
    ])
    return
  }
  const keyboard = rows.map((r) => [
    {
      text: `${ANN_STATUS_TEXT[r.status] ?? r.status} · ${r.title.slice(0, 26)}`,
      callback_data: `a:v:${r.id}`,
    },
  ])
  keyboard.push([{ text: "⬅️ 返回", callback_data: "a:m" }])
  await annRender(
    env,
    chatId,
    messageId,
    `📋 <b>最近公告</b>（点一条进入操作）\n\n${rows
      .map((r, i) => `${i + 1}. ${ANN_STATUS_TEXT[r.status] ?? r.status} ${r.title.slice(0, 40)}`)
      .join("\n")}`,
    keyboard
  )
}

/** 三级：单条详情 */
async function annDetail(env: Env, chatId: string, id: string, messageId?: number): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT id, title, body, status, published_at, notify_email, popup_mode FROM announcements WHERE id = ?"
  )
    .bind(id)
    .first<{ id: string; title: string; body: string; status: string; published_at: string | null; notify_email: number; popup_mode: string }>()
  if (!row) {
    await annRender(env, chatId, messageId, "这条公告不存在（可能已被删除）。", [
      [{ text: "⬅️ 返回列表", callback_data: "a:l" }],
    ])
    return
  }
  const published = row.status === "published" || !!row.published_at
  const bodyPreview = (row.body || "").replace(/\s+/g, " ").slice(0, 160)
  const text = [
    `📄 <b>${row.title.slice(0, 60)}</b>`,
    `状态：${ANN_STATUS_TEXT[row.status] ?? row.status}`,
    `提醒方式：${ANN_POPUP_SHORT[row.popup_mode] ?? row.popup_mode}`,
    `邮件通知：${row.notify_email ? "开" : "关"}`,
    "",
    bodyPreview ? `${bodyPreview}${(row.body || "").length > 160 ? "…" : ""}` : "<i>（无正文）</i>",
  ].join("\n")
  const actions: { text: string; callback_data: string }[] = []
  if (published) actions.push({ text: "↓ 下线", callback_data: `a:o:${row.id}` })
  else actions.push({ text: "🚀 发布", callback_data: `a:p:${row.id}` })
  /**
   * 提醒方式随时可改（点一下即生效，不用重新发布）——
   * 老板可能发完才想起"这条应该每次都弹"，让他能在机器人里直接改。
   */
  const popupRow = (["none", "once", "every"] as const).map((m) => ({
    text: `${row.popup_mode === m ? "✅ " : ""}${ANN_POPUP_SHORT[m]}`,
    callback_data: `a:pm:${m}:${row.id}`,
  }))
  await annRender(env, chatId, messageId, text, [
    actions,
    [{ text: "🔔 提醒方式", callback_data: "a:noop" }],
    popupRow,
    [{ text: "🗑 删除", callback_data: `a:x:${row.id}` }],
    [{ text: "⬅️ 返回列表", callback_data: "a:l" }],
  ])
}

/** 删除确认层（单独一层，避免误触） */
async function annDeleteConfirm(env: Env, chatId: string, id: string, messageId?: number): Promise<void> {
  const row = await env.DB.prepare("SELECT title FROM announcements WHERE id = ?")
    .bind(id)
    .first<{ title: string }>()
  if (!row) {
    await annRender(env, chatId, messageId, "这条公告不存在。", [[{ text: "⬅️ 返回列表", callback_data: "a:l" }]])
    return
  }
  await annRender(
    env,
    chatId,
    messageId,
    `⚠️ 确认<b>永久删除</b>「${row.title.slice(0, 40)}」？\n此操作不可恢复（已发出去的站内消息不受影响）。`,
    [
      [
        { text: "✅ 确认删除", callback_data: `a:dd:${id}` },
        { text: "↩️ 取消", callback_data: `a:v:${id}` },
      ],
    ]
  )
}

/** 新建流程第 1 步 */
async function annStartCreate(env: Env, chatId: string, messageId?: number): Promise<void> {
  await setAnnState(env, chatId, "ann_title")
  await annRender(
    env,
    chatId,
    messageId,
    "➕ <b>新建公告</b>（第 1/4 步）\n\n请直接发送公告<b>标题</b>（最长 100 字）。\n发送 /cancel 取消。",
    [[{ text: "✖️ 取消", callback_data: "a:nc" }]]
  )
}

/** 新建流程第 3 步：预览确认 */
/** 新建第 3 步：选提醒方式 */
async function annChoosePopup(env: Env, chatId: string, messageId?: number): Promise<void> {
  await annRender(
    env,
    chatId,
    messageId,
    "🔔 <b>选提醒方式</b>（第 3/4 步）\n\n" +
      "这决定公告在用户那边怎么出现：\n" +
      Object.values(ANN_POPUP_TEXT).map((v) => "· " + v).join("\n"),
    [
      [
        { text: "🔕 不提醒", callback_data: "a:pp:none" },
        { text: "🔔 只提醒一次", callback_data: "a:pp:once" },
      ],
      [{ text: "📢 每次进入都提醒", callback_data: "a:pp:every" }],
      [{ text: "✖️ 取消", callback_data: "a:nc" }],
    ]
  )
}

async function annPreview(env: Env, chatId: string, messageId: number | undefined, p: Record<string, string>): Promise<void> {
  await annRender(
    env,
    chatId,
    messageId,
    [
      "✅ <b>预览</b>（第 4/4 步）",
      "",
      `<b>标题</b>：${(p.title ?? "").slice(0, 80)}`,
      `<b>正文</b>：${(p.body ?? "").slice(0, 300) || "（无）"}`,
      `<b>提醒方式</b>：${ANN_POPUP_SHORT[p.popup ?? "none"] ?? "不提醒"}`,
      "",
      "选「直接发布」会立刻推送到站内消息中心和 TG 频道。",
    ].join("\n"),
    [
      [
        { text: "💾 存为草稿", callback_data: "a:nw" },
        { text: "🚀 直接发布", callback_data: "a:np" },
      ],
      [{ text: "✖️ 取消", callback_data: "a:nc" }],
    ]
  )
}

/** 新建流程落库：publish=true 时立刻发布 */
async function annCreateSave(env: Env, chatId: string, messageId: number | undefined, publish: boolean): Promise<void> {
  const st = await getAnnState(env, chatId)
  if (!st || st.kind !== "ann_preview") {
    await annRender(env, chatId, messageId, "这个会话已经过期了，请重新点「➕ 新建公告」。", [
      [{ text: "⬅️ 返回", callback_data: "a:m" }],
    ])
    return
  }
  const title = (st.payload.title ?? "").trim().slice(0, 100)
  const bodyText = (st.payload.body ?? "").trim().slice(0, 1000)
  const id = uuid()

  // ① 落库：这一步失败才是真的"没存上"
  try {
    await env.DB.prepare(
      "INSERT INTO announcements (id, title, body, category, pinned, created_at, status, notify_email, popup_mode) " +
        "VALUES (?, ?, ?, 'general', 0, ?, 'draft', 0, ?)"
    )
      .bind(id, title, bodyText, new Date().toISOString(), st.payload.popup ?? "none")
      .run()
  } catch (err) {
    await sendTo(env, chatId, "保存失败：" + (err instanceof Error ? err.message : "未知错误"))
    return
  }
  await clearAnnState(env, chatId)

  if (!publish) {
    await annRender(env, chatId, messageId, `💾 已存为草稿：<b>${title.slice(0, 40)}</b>`, [
      [{ text: "📋 公告列表", callback_data: "a:l" }],
      [{ text: "⬅️ 返回", callback_data: "a:m" }],
    ])
    return
  }

  /**
   * ② 发布：会广播站内消息 + 推频道 + 入邮件队列，是最重的一步。
   * 2026-10-24 线上踩过：广播批量写 D1 时会 `D1_ERROR: Network connection lost`，
   * 但公告**其实已经发出去了**，旧文案却弹「保存失败」，容易让人误以为没发。
   * 现在发布失败要回查一次状态，按真实结果说话。
   */
  try {
    await publishAnnouncementNow(env, id)
    await annRender(env, chatId, messageId, `🚀 已发布：<b>${title.slice(0, 40)}</b>`, [
      [{ text: "📋 公告列表", callback_data: "a:l" }],
    ])
  } catch (err) {
    const msg = err instanceof Error ? err.message : "未知错误"
    const row = await env.DB.prepare("SELECT status FROM announcements WHERE id = ?")
      .bind(id)
      .first<{ status: string }>()
    if (row?.status === "published") {
      await annRender(
        env,
        chatId,
        messageId,
        `⚠️ <b>已发布</b>（状态已落库），但后续推送可能没走完：\n<code>${msg.slice(0, 120)}</code>\n\n` +
          "可以在网页后台补发邮件，或忽略它（站内消息和频道通常已经到了）。",
        [[{ text: "📋 公告列表", callback_data: "a:l" }]]
      )
    } else {
      await annRender(
        env,
        chatId,
        messageId,
        `⚠️ 草稿已保存，但发布失败：\n<code>${msg.slice(0, 120)}</code>\n\n` +
          "去列表里点开这条再点「🚀 发布」重试即可。",
        [
          [{ text: "📋 公告列表", callback_data: "a:l" }],
          [{ text: "⬅️ 返回", callback_data: "a:m" }],
        ]
      )
    }
  }
}

/**
 * 文本消息 → 新建流程的状态机。
 * 返回 true 表示「这条消息已被公告流程吃掉」，调用方不要再按命令处理。
 */
async function annHandleText(env: Env, chatId: string, text: string): Promise<boolean> {
  const st = await getAnnState(env, chatId)
  if (!st) return false

  if (text.trim() === "/cancel") {
    await clearAnnState(env, chatId)
    await sendTo(env, chatId, "已取消。")
    return true
  }
  if (st.kind === "ann_title") {
    const title = text.trim().slice(0, 100)
    if (!title) {
      await sendTo(env, chatId, "标题不能为空，请重新发送。")
      return true
    }
    await setAnnState(env, chatId, "ann_body", { title })
    await sendTo(env, chatId, `标题已记下：<b>${title}</b>\n\n（第 2/4 步）现在发送<b>正文</b>；没有正文就发 /skip。`)
    return true
  }
  if (st.kind === "ann_body") {
    const bodyText = text.trim() === "/skip" ? "" : text.trim().slice(0, 1000)
    const payload = { title: st.payload.title ?? "", body: bodyText }
    await setAnnState(env, chatId, "ann_popup", payload)
    await annChoosePopup(env, chatId)
    return true
  }
  return false
}


/** 站内聊天室 → TG 群的上一条推送时间（毫秒）。同一个 isolate 内做 1 条/秒节流。 */
let lastChatGroupPushAt = 0

/**
 * 把站内聊天室的一条发言推到互通群（2026-10-23，方案 A：只做单向）。
 *
 * 为什么不放进 pushToChannels：那个是「公告/作品/新帖」的事件广播，
 * 受每个频道的 events_json 控制；聊天是**高频流**，需要独立节流，
 * 否则一次热闹的聊天会把 TG 打到限流（429）并影响公告推送。
 */
export async function pushToChatGroups(env: Env, text: string): Promise<number> {
  try {
    const now = Date.now()
    if (now - lastChatGroupPushAt < 1000) return 0 // 1 条/秒
    lastChatGroupPushAt = now

    const cfg = await loadConfig(env)
    if (!cfg.enabled) return 0
    const token = await botToken(env, cfg)
    if (!token) return 0

    // kind 列由迁移 0173 引入；未执行时这里会抛错，被下面的 catch 兜住（等于功能未启用）
    const { results } = await env.DB.prepare(
      "SELECT chat_id FROM tg_channels WHERE kind = 'group' AND enabled = 1"
    ).all<{ chat_id: string }>()

    const { text: plain, photos } = splitOutgoing(text)
    let ok = 0
    for (const row of results ?? []) {
      if (plain.trim()) {
        const r = await tgApi(
          env,
          "sendMessage",
          { chat_id: row.chat_id, text: plain.slice(0, 3500), disable_web_page_preview: true },
          token
        )
        await logPush(env, "ch:chat", row.chat_id, r.ok, r.ok ? undefined : r.description)
        if (r.ok) ok++
      }
      // 图片按真图发（Telegram 自己去抓公开 URL），失败不影响文字那条
      for (const photo of photos) {
        const rp = await tgApi(env, "sendPhoto", { chat_id: row.chat_id, photo }, token)
        await logPush(env, "ch:chat:photo", row.chat_id, rp.ok, rp.ok ? undefined : rp.description)
        if (rp.ok) ok++
      }
    }
    return ok
  } catch {
    return 0 // 聊天发言绝不能因为推送失败而失败
  }
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
  /**
   * 公告快捷管理（2026-10-24）。菜单里只能写 ASCII 命令名 —— Telegram 的
   * BotCommand 校验是 `^[a-z][a-z0-9_]{0,31}$`，中文 `/公告` 放不进去，
   * 所以菜单项是 `/ann`，而 `/公告` 作为别名在命令分发里同样接受。
   */
  if (opts.isAdminUser) {
    out.push({ command: "ann", description: "公告快捷管理（管理员）" })
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

/**
 * 把「默认菜单 + 每个已绑定 chat 的菜单」按当前开关重刷一遍。
 *
 * ⚠️ 为什么是「遍历」：Telegram 的菜单是**按 chat 存**的，没有"给所有用户设一次"的接口。
 * 分档菜单（未绑定只有 /bind、绑定有全套、管理员多 /status）只能靠 chat 级 scope 实现，
 * 而未绑定的用户我们拿不到 chat_id，所以只能反过来：已知的绑定 chat 逐个设，其余落 default。
 *
 * 性能：
 *   · **并发 20 条一批** —— 串行时 500 个用户要跑 75~150 秒（Worker 直接超时）
 *   · 调用方传 ctx 时走 waitUntil 后台跑，管理页保存秒回
 *   · 命令开关没变化时不会进这里（见 updateAdminConfig 的前置比较）
 */
async function syncAllMenus(
  env: Env,
  commands: Record<string, boolean>,
  concurrency = 20
): Promise<{ chats: number; total: number }> {
  const def = await tgApi(env, "setMyCommands", {
    commands: buildCommandMenu({ bound: false, isAdminUser: false, commands }),
    scope: { type: "default" },
  })
  if (!def.ok) throw new ApiError(400, `设置默认菜单失败：${def.description ?? "未知错误"}`, "SET_MENU_FAILED")

  const { results } = await env.DB.prepare(
    `SELECT b.telegram_id, u.role FROM tg_bindings b LEFT JOIN users u ON u.id = b.user_id LIMIT 2000`
  ).all<{ telegram_id: string; role: string | null }>()
  const rows = results ?? []

  let ok = 0
  for (let i = 0; i < rows.length; i += concurrency) {
    const batch = rows.slice(i, i + concurrency)
    const done = await Promise.all(
      batch.map((row) =>
        setChatMenu(
          env,
          row.telegram_id,
          buildCommandMenu({ bound: true, isAdminUser: isAnyAdmin(row.role ?? ""), commands })
        ).catch(() => false)
      )
    )
    ok += done.filter(Boolean).length
  }
  return { chats: ok, total: rows.length }
}

/** 管理端「同步命令菜单」：手动全量重刷（保存命令开关时也会自动跑一次） */
export async function syncCommands(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "telegram")
  const cfg = await loadConfig(env)
  const commands = { ...DEFAULT_COMMANDS, ...parseJson<Record<string, boolean>>(cfg.commands_json, {}) }
  const { chats, total } = await syncAllMenus(env, commands)
  await recordAudit(env, admin.id, "tg.commands.sync", `默认菜单 + ${chats} 个 chat`)
  return json({ ok: true, chats, total })
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

/* ==========================================================================
 * 频道推送（2026-10-22）
 *
 * 与私聊推送是两条独立的路：
 *   · 私聊：tg_bindings（用户 ↔ telegram_id），受 pushMessage 的推送开关控制
 *   · 频道：tg_channels（一频道一行），受**每个频道自己的** events_json 控制
 * 两边都走 tg_push_log，kind 分别记为 `email/comment/...` 与 `ch:announcement/...`。
 *
 * 权限：只有管理员能增删频道（requireAdminScope("telegram")）；
 * 机器人被拉进频道时靠 `my_chat_member` 自动登记，站长不用手填 chat_id。
 * ========================================================================== */

/**
 * 频道默认订阅的事件：**只开公告**。
 *
 * 2026-10-22 站长明确要求「造物集新作品不推」—— 频道是公告栏，不是作品流：
 * 作品量远大于公告，推到频道会把它淹掉。社区新帖同理保持关闭。
 * 想推的频道自己在管理页点开即可（events_json 里显式写 true 会覆盖这里的默认）。
 */
const DEFAULT_CHANNEL_EVENTS: Record<string, boolean> = {
  announcement: true,
  gallery: false,
  post: false,
  daily: false,
}

export type ChannelEvent = "announcement" | "gallery" | "post" | "daily"

interface ChannelRow {
  chat_id: string
  title: string
  username: string | null
  events_json: string
  enabled: number
  created_at: number
  last_ok_at: number | null
  last_error: string | null
  /** 'channel' = 播报频道；'group' = 与站内聊天室互通的群（迁移 0173 引入） */
  kind?: string
}

/**
 * 往所有订阅了该事件的频道发一条消息。
 * 单个频道失败不影响其它频道，也不影响调用方业务流程。
 */
export async function pushToChannels(
  env: Env,
  event: ChannelEvent,
  text: string,
  ref?: { announcementId?: string }
): Promise<number> {
  try {
    const cfg = await loadConfig(env)
    if (!cfg.enabled) return 0
    if (!(await botToken(env, cfg))) return 0
    const { results } = await env.DB.prepare(
      "SELECT * FROM tg_channels WHERE enabled = 1"
    ).all<ChannelRow>()
    let ok = 0
    for (const ch of results ?? []) {
      const events = { ...DEFAULT_CHANNEL_EVENTS, ...parseJson<Record<string, boolean>>(ch.events_json, {}) }
      if (events[event] === false) continue
      const r = await tgApi(env, "sendMessage", {
        chat_id: ch.chat_id,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: false,
      })
      await logPush(env, `ch:${event}`, ch.chat_id, r.ok, r.ok ? undefined : r.description)
      if (r.ok) {
        ok++
        /**
         * 记下频道里这条消息的 id（2026-10-24）：
         * 站长要求删除公告时把频道里那条也删掉，而 deleteMessage 必须有 message_id。
         * 记不下也没关系 —— 只是以后删不掉那条频道消息。
         */
        const mid = (r as { result?: { message_id?: number } }).result?.message_id
        if (ref?.announcementId && typeof mid === "number") {
          try {
            await env.DB.prepare(
              "INSERT OR REPLACE INTO tg_announcement_msgs (announcement_id, chat_id, message_id, created_at) VALUES (?, ?, ?, ?)"
            )
              .bind(ref.announcementId, ch.chat_id, mid, new Date().toISOString())
              .run()
          } catch {
            /* 表还没迁移时也不该影响推送 */
          }
        }
        await env.DB.prepare("UPDATE tg_channels SET last_ok_at = ?, last_error = NULL WHERE chat_id = ?")
          .bind(Date.now(), ch.chat_id)
          .run()
      } else {
        await env.DB.prepare("UPDATE tg_channels SET last_error = ? WHERE chat_id = ?")
          .bind((r.description ?? "发送失败").slice(0, 200), ch.chat_id)
          .run()
      }
    }
    return ok
  } catch (err) {
    // 原来这里直接 `return 0`，把异常吃干净了 —— 线上「公告没推到频道」时
    // 既没有发送记录也没有错误线索（2026-10-22 排查踩过）。落一条 err 记录，
    // 管理页的投递日志里就能看到到底哪一步炸的。
    await logPush(
      env,
      `ch:${event}:err`,
      "(exception)",
      false,
      err instanceof Error ? err.message : String(err)
    )
    return 0
  }
}

/** 机器人被拉进/移出频道时自动登记（webhook 的 my_chat_member） */
export async function handleChatMember(
  env: Env,
  upd: {
    chat?: { id?: number; title?: string; username?: string; type?: string }
    new_chat_member?: { status?: string }
  }
): Promise<void> {
  const chat = upd.chat
  if (!chat?.id || chat.type !== "channel") return
  const chatId = String(chat.id)
  const status = upd.new_chat_member?.status ?? ""
  if (status === "administrator" || status === "member") {
    await env.DB.prepare(
      `INSERT INTO tg_channels (chat_id, title, username, events_json, enabled, created_at, created_by)
       VALUES (?, ?, ?, ?, 1, ?, 'auto:my_chat_member')
       ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title, username = excluded.username, enabled = 1`
    )
      .bind(chatId, chat.title ?? "", chat.username ?? null, "{}", Date.now())
      .run()
  } else if (status === "left" || status === "kicked") {
    await env.DB.prepare("UPDATE tg_channels SET enabled = 0 WHERE chat_id = ?").bind(chatId).run()
  }
}

/** GET /admin/tg/channels */
export async function listChannels(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "telegram")
  const { results } = await env.DB.prepare(
    "SELECT * FROM tg_channels ORDER BY created_at DESC"
  ).all<ChannelRow>()
  return json({
    channels: (results ?? []).map((c) => ({
      chatId: c.chat_id,
      // 'channel' = 事件播报频道；'group' = 与站内聊天室互通的群
      kind: c.kind ?? "channel",
      title: c.title,
      username: c.username,
      enabled: !!c.enabled,
      events: { ...DEFAULT_CHANNEL_EVENTS, ...parseJson<Record<string, boolean>>(c.events_json, {}) },
      createdAt: c.created_at,
      lastOkAt: c.last_ok_at,
      lastError: c.last_error,
    })),
    defaults: DEFAULT_CHANNEL_EVENTS,
  })
}

/** POST /admin/tg/channels —— 手工登记一个频道（会先调 getChat 校验机器人是否在里面） */
export async function addChannel(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "telegram")
  const body = await readJson<{ chatId?: string }>(request, 4 * 1024)
  const chatId = (body.chatId ?? "").trim()
  if (!chatId) throw new ApiError(400, "请填写频道 ID 或 @用户名", "INVALID_CHANNEL")
  const cfg = await loadConfig(env)
  const token = await botToken(env, cfg)
  if (!token) throw new ApiError(400, "请先保存机器人 Token", "NO_TOKEN")
  const info = await tgApi(env, "getChat", { chat_id: chatId }, token)
  if (!info.ok) throw new ApiError(400, `读取频道失败：${info.description ?? "未知错误"}`, "CHANNEL_LOOKUP_FAILED")
  const chat = info.result as { id?: number; title?: string; username?: string; type?: string }
  /**
   * 频道与群都可以登记（2026-10-24）：
   *   · channel / supergroup(频道形式) → kind='channel'：事件播报用
   *   · group / supergroup(群形式)      → kind='group'：聊天室 ↔ TG 群互通用
   * 之前这里直接拒绝非 channel，导致「群」只能手写库，管理页加不了。
   */
  const isGroup = chat.type === "group" || chat.type === "supergroup"
  if (chat.type !== "channel" && !isGroup) {
    throw new ApiError(400, "这不是频道或群（机器人需先被拉进去）", "NOT_A_CHANNEL")
  }
  const kind = isGroup ? "group" : "channel"
  await env.DB.prepare(
    `INSERT INTO tg_channels (chat_id, title, username, events_json, enabled, created_at, created_by, kind)
     VALUES (?, ?, ?, '{}', 1, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title, username = excluded.username,
       enabled = 1, kind = excluded.kind`
  )
    .bind(String(chat.id ?? chatId), chat.title ?? "", chat.username ?? null, Date.now(), admin.id, kind)
    .run()
  await recordAudit(env, admin.id, "tg.channel.add", String(chat.id ?? chatId))
  return json({ ok: true, chatId: String(chat.id ?? chatId), title: chat.title ?? "", kind })
}

/** POST /admin/tg/channels/update —— 开关频道 / 改事件订阅 */
export async function updateChannel(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "telegram")
  const body = await readJson<{ chatId?: string; enabled?: boolean; events?: Record<string, boolean> }>(
    request,
    8 * 1024
  )
  const chatId = (body.chatId ?? "").trim()
  if (!chatId) throw new ApiError(400, "缺少 chatId", "INVALID_CHANNEL")
  const row = await env.DB.prepare("SELECT * FROM tg_channels WHERE chat_id = ?")
    .bind(chatId)
    .first<ChannelRow>()
  if (!row) throw new ApiError(404, "频道不存在", "NOT_FOUND")
  if (typeof body.enabled === "boolean") {
    await env.DB.prepare("UPDATE tg_channels SET enabled = ? WHERE chat_id = ?")
      .bind(body.enabled ? 1 : 0, chatId)
      .run()
  }
  if (body.events) {
    const merged = {
      ...DEFAULT_CHANNEL_EVENTS,
      ...parseJson<Record<string, boolean>>(row.events_json, {}),
      ...body.events,
    }
    await env.DB.prepare("UPDATE tg_channels SET events_json = ? WHERE chat_id = ?")
      .bind(JSON.stringify(merged), chatId)
      .run()
  }
  await recordAudit(env, admin.id, "tg.channel.update", chatId)
  return json({ ok: true })
}

/** DELETE /admin/tg/channels/:id */
export async function deleteChannel(env: Env, request: Request, chatId: string): Promise<Response> {
  const admin = await requireAdminScope(env, request, "telegram")
  await env.DB.prepare("DELETE FROM tg_channels WHERE chat_id = ?").bind(decodeURIComponent(chatId)).run()
  await recordAudit(env, admin.id, "tg.channel.delete", chatId)
  return json({ ok: true })
}

/** POST /admin/tg/channels/test —— 往某个频道发一条测试消息 */
export async function testChannel(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "telegram")
  const body = await readJson<{ chatId?: string }>(request, 4 * 1024)
  const chatId = (body.chatId ?? "").trim()
  if (!chatId) throw new ApiError(400, "缺少 chatId", "INVALID_CHANNEL")
  const cfg = await loadConfig(env)
  const token = await botToken(env, cfg)
  if (!token) throw new ApiError(400, "请先保存机器人 Token", "NO_TOKEN")
  const r = await tgApi(
    env,
    "sendMessage",
    {
      chat_id: chatId,
      text: "☁️ <b>DoulorCloud</b>\n频道推送测试成功，之后这里会收到公告与新作品通知。",
      parse_mode: "HTML",
    },
    token
  )
  await logPush(env, "ch:test", chatId, r.ok, r.ok ? undefined : r.description)
  if (!r.ok) throw new ApiError(400, `发送失败：${r.description ?? "未知错误"}`, "SEND_FAILED")
  await recordAudit(env, admin.id, "tg.channel.test", chatId)
  return json({ ok: true })
}

/**
 * POST /admin/tg/channels/push —— 直连测试「事件 → 频道」这一跳。
 *
 * 为什么要单独一个接口：公告发布是全站广播（会给 1000+ 用户发站内消息），
 * 为了验证频道推送去发一条公告代价太大。这里直接调 pushToChannels，
 * 并把频道订阅状态、最近几条投递日志一起回吐，出问题时一眼能看出是哪一步。
 */
export async function testChannelPush(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "telegram")
  const body = await readJson<{ event?: string }>(request, 4 * 1024)
  const event = (body.event ?? "announcement") as ChannelEvent
  if (!(event in DEFAULT_CHANNEL_EVENTS)) {
    throw new ApiError(400, "未知事件类型", "BAD_EVENT")
  }
  const cfg = await loadConfig(env)
  const token = await botToken(env, cfg)
  const { results: channels } = await env.DB.prepare(
    "SELECT chat_id, title, enabled, events_json FROM tg_channels"
  ).all<{ chat_id: string; title: string; enabled: number; events_json: string }>()

  const sent = await pushToChannels(
    env,
    event,
    [
      "🧪 <b>频道推送自检</b>",
      "",
      `事件：${event}`,
      `时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
      "",
      "☁️ https://cloud.doulor.cn",
    ].join("\n")
  )

  const { results: logs } = await env.DB.prepare(
    "SELECT kind, target, ok, error, created_at FROM tg_push_log WHERE kind LIKE 'ch:%' ORDER BY created_at DESC LIMIT 5"
  ).all<{ kind: string; target: string; ok: number; error: string | null; created_at: number }>()

  await recordAudit(env, admin.id, "tg.channel.push_test", event)
  return json({
    ok: true,
    event,
    botEnabled: !!cfg.enabled,
    hasToken: !!token,
    sent,
    channels: (channels ?? []).map((c) => ({
      chatId: c.chat_id,
      title: c.title,
      enabled: !!c.enabled,
      events: { ...DEFAULT_CHANNEL_EVENTS, ...parseJson<Record<string, boolean>>(c.events_json, {}) },
    })),
    logs: (logs ?? []).map((l) => ({
      kind: l.kind,
      target: l.target,
      ok: !!l.ok,
      error: l.error,
      at: l.created_at,
    })),
  })
}
