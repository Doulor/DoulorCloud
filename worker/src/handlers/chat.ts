/**
 * 公共聊天室。
 *
 * 一期只做一个默认公共聊天室（不分房间）。
 *
 * 实时性：前端 2 秒轮询一次新消息（个人站用户量小，够用；将来量大再上 SSE）。
 * 在线人数：用户停留在聊天室时每 30 秒心跳一次，最近 2 分钟内有心跳算「在线」。
 *
 * 为什么不用 WebSocket：Cloudflare Worker 原生不支持 WS 长连接（需 Durable Objects，
 * 架构重）。轮询 + 心跳对本场景最务实。
 */
import { ApiError, json } from "../http"
import { requireUser } from "../auth"
import { uuid } from "../crypto"
import { guardRateLimit, clientIp } from "../ratelimit"
import { getSettingBool } from "../settings"
import type { Env } from "../env"

/**
 * 聊天室门禁：登录 + 总开关打开（管理员放行）。
 *
 * ⚠️ 2026-09-30：`chat_enabled` 是应急开关 —— D1 行写额度被打满、连写一行
 *    把它关掉都做不到，所以用「默认关 + 部署」落地。关闭时普通用户一律
 *    403 CHAT_DISABLED（前端据此显示「聊天室已关闭」并停止轮询）。
 *    关闭状态反而更省读额度：一次设置读取 ≈ 1 行读，替代原来的整页消息查询。
 */
async function requireChatUser(
  env: Env,
  request: Request
): Promise<ReturnType<typeof requireUser>> {
  const user = await requireUser(env, request)
  if (user.role !== "admin" && user.role !== "root") {
    if (!(await getSettingBool(env, "chat_enabled"))) {
      throw new ApiError(403, "聊天室已关闭", "CHAT_DISABLED")
    }
  }
  return user
}

/** 在线判定窗口：最近 N 秒内有心跳 */
const ONLINE_WINDOW_SECONDS = 120

/** 消息最大长度 */
const MAX_BODY = 2000

/** 撤回时限：非管理员只能撤回 N 秒内自己发的消息 */
const RECALL_WINDOW_SECONDS = 600

/** 引用摘要的最大长度 */
const QUOTE_SNIPPET = 200

/** 拉取的历史消息上限 */
const MAX_MESSAGES = 100

/**
 * 游标编码：`<created_at>|<id>`（两者都按升序比较）。
 *
 * ⚠️ 2026-09-25 审计（H12）—— 这里原本直接把**消息 id** 当游标用：
 *   `WHERE m.id > ? ORDER BY m.id ASC` / `ORDER BY id DESC LIMIT ?`。
 * 但 `chat_messages.id` 是 `uuid()` 生成的 **v4 随机 UUID**（见 sendMessage），
 * 它既不单调也不按时间排序。后果：
 *   1. 「拉最新 50 条」实际返回的是**随机 50 条**，不是最新的；
 *   2. 增量轮询 `id > lastId` 会随机跳过大量消息、同时重复推送旧消息 ——
 *      聊天室看起来就是「消息时有时无、顺序错乱」。
 * 现在改为按 `(created_at, id)` 元组排序与比较（created_at 是 ISO 8601
 * 定长字符串，字典序 == 时间序；id 只用于同一毫秒内的稳定去重）。
 *
 * 长期更干净的做法是给表加一个 `seq INTEGER PRIMARY KEY AUTOINCREMENT`
 * 之类的单调列，但那要改 worker/schema.sql（当前由另一个 AI 占用），
 * 见修复清单待办项。
 */
function encodeCursor(createdAt: string, id: string): string {
  return `${createdAt}|${id}`
}

function decodeCursor(raw: string): { createdAt: string; id: string } | null {
  const sep = raw.lastIndexOf("|")
  if (sep <= 0) return null
  const createdAt = raw.slice(0, sep)
  const id = raw.slice(sep + 1)
  if (!createdAt || !id) return null
  if (Number.isNaN(new Date(createdAt).getTime())) return null
  return { createdAt, id }
}

/** GET /api/chat/messages?after=<游标或消息id>&limit= */
export async function listMessages(env: Env, request: Request): Promise<Response> {
  await requireChatUser(env, request)
  const url = new URL(request.url)
  const after = url.searchParams.get("after") ?? ""
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), MAX_MESSAGES)

  // 游标优先按新格式解析；解析不出来再当成**消息 id**（旧前端就是这样传的）
  // 反查它的 created_at，从而不必改动前端与 api.ts 的接口形状。
  let cursor = after ? decodeCursor(after) : null
  if (after && !cursor) {
    const row = await env.DB.prepare("SELECT created_at FROM chat_messages WHERE id = ?")
      .bind(after)
      .first<{ created_at: string }>()
    if (row) cursor = { createdAt: row.created_at, id: after }
  }

  // 带 after 则增量拉取（只取比游标新的）；否则拉最新 N 条
  let rows
  if (cursor) {
    rows = await env.DB.prepare(
      `SELECT m.id, m.user_id, m.body, m.created_at, m.recalled_at, m.reply_to,
              u.username, u.nickname, u.avatar_key
         FROM chat_messages m JOIN users u ON u.id = m.user_id
        WHERE m.created_at > ? OR (m.created_at = ? AND m.id > ?)
        ORDER BY m.created_at ASC, m.id ASC LIMIT ?`
    )
      .bind(cursor.createdAt, cursor.createdAt, cursor.id, limit)
      .all()
  } else {
    rows = await env.DB.prepare(
      `SELECT m.id, m.user_id, m.body, m.created_at, m.recalled_at, m.reply_to,
              u.username, u.nickname, u.avatar_key
         FROM (SELECT * FROM chat_messages ORDER BY created_at DESC, id DESC LIMIT ?) m
         JOIN users u ON u.id = m.user_id
        ORDER BY m.created_at ASC, m.id ASC`
    )
      .bind(limit)
      .all()
  }

  const messages = (rows.results ?? []).map(toMessage)
  await attachQuotes(env, messages)
  const last = messages[messages.length - 1]
  return json({
    messages,
    // 新增字段：前端可以改用 nextCursor 作为下一次的 after（当前前端仍传消息 id，
    // 服务端已能正确解析，两者都支持）
    nextCursor: last ? encodeCursor(String(last.createdAt), String(last.id)) : after || null,
  })
}

/** 引用摘要（前端右键「引用」时展示被引消息的作者 + 截断正文） */
interface QuoteRef {
  id: string
  username: string
  nickname: string | null
  recalled: boolean
  body: string
}

interface ChatMessageOut {
  id: string
  userId: string
  username: string
  nickname: string | null
  hasAvatar: boolean
  body: string
  recalled: boolean
  replyTo: string | null
  quote: QuoteRef | null
  createdAt: string
}

function toMessage(r: Record<string, unknown>): ChatMessageOut {
  const recalled = Boolean(r.recalled_at)
  return {
    id: String(r.id),
    userId: String(r.user_id),
    username: String(r.username),
    nickname: (r.nickname as string | null) ?? null,
    hasAvatar: Boolean(r.avatar_key),
    // 撤回后正文不下发，避免「撤回」变成只盖一层遮罩、内容其实还在
    body: recalled ? "" : String(r.body ?? ""),
    recalled,
    replyTo: recalled ? null : ((r.reply_to as string | null) ?? null),
    quote: null,
    createdAt: String(r.created_at),
  }
}

/** 批量补全被引用消息的摘要（一次查询，避免 N+1） */
async function attachQuotes(env: Env, messages: ChatMessageOut[]): Promise<void> {
  const ids = [...new Set(messages.map((m) => m.replyTo).filter((x): x is string => !!x))]
  if (ids.length === 0) return
  const placeholders = ids.map(() => "?").join(",")
  const res = await env.DB.prepare(
    `SELECT m.id, m.body, m.recalled_at, u.username, u.nickname
       FROM chat_messages m JOIN users u ON u.id = m.user_id
      WHERE m.id IN (${placeholders})`
  )
    .bind(...ids)
    .all<{
      id: string
      body: string
      recalled_at: string | null
      username: string
      nickname: string | null
    }>()
  const map = new Map((res.results ?? []).map((r) => [r.id, r]))
  for (const m of messages) {
    if (!m.replyTo) continue
    const q = map.get(m.replyTo)
    if (!q) continue
    const recalled = Boolean(q.recalled_at)
    m.quote = {
      id: q.id,
      username: q.username,
      nickname: q.nickname ?? null,
      recalled,
      body: recalled ? "" : String(q.body ?? "").slice(0, QUOTE_SNIPPET),
    }
  }
}

/** POST /api/chat/messages —— 发消息 */
export async function sendMessage(env: Env, request: Request): Promise<Response> {
  const user = await requireChatUser(env, request)
  await guardRateLimit(
    env,
    `chat:send:ip:${clientIp(request)}`,
    30,
    60,
    "发言过于频繁"
  )

  const body = (await request.json().catch(() => ({}))) as { body?: string; replyTo?: string }
  const text = (body.body ?? "").trim()
  if (!text) throw new ApiError(400, "内容不能为空", "INVALID_INPUT")
  if (text.length > MAX_BODY) throw new ApiError(400, "内容过长", "TOO_LARGE")

  // 引用：只接受「确实存在且未被撤回」的消息 id，否则按普通消息发（不报错，
  // 因为被引消息可能刚好在我们校验前被撤回，不该因此挡住用户发言）
  let replyTo: string | null = null
  let quote: QuoteRef | null = null
  if (body.replyTo) {
    const target = await env.DB.prepare(
      `SELECT m.id, m.body, m.recalled_at, u.username, u.nickname
         FROM chat_messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?`
    )
      .bind(body.replyTo)
      .first<{
        id: string
        body: string
        recalled_at: string | null
        username: string
        nickname: string | null
      }>()
    if (target && !target.recalled_at) {
      replyTo = target.id
      quote = {
        id: target.id,
        username: target.username,
        nickname: target.nickname ?? null,
        recalled: false,
        body: String(target.body ?? "").slice(0, QUOTE_SNIPPET),
      }
    }
  }

  const id = uuid()
  const now = new Date().toISOString()
  await env.DB.prepare(
    "INSERT INTO chat_messages (id, user_id, body, created_at, reply_to) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(id, user.id, text, now, replyTo)
    .run()

  // 发消息也算一次活跃（更新心跳），让在线列表及时反映
  await env.DB.prepare(
    `INSERT INTO chat_presence (user_id, last_seen_at) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`
  )
    .bind(user.id, now)
    .run()

  return json({
    message: {
      id,
      userId: user.id,
      username: user.username,
      nickname: user.nickname ?? null,
      hasAvatar: Boolean(user.avatar_key),
      body: text,
      recalled: false,
      replyTo,
      quote,
      createdAt: now,
    },
  }, 201)
}

/**
 * POST /api/chat/messages/:id/recall —— 撤回消息。
 * 作者本人 10 分钟内可撤回；管理员/站长不限。撤回后正文清空（不是只加遮罩）。
 */
export async function recallMessage(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const user = await requireChatUser(env, request)
  const row = await env.DB.prepare(
    "SELECT id, user_id, created_at, recalled_at FROM chat_messages WHERE id = ?"
  )
    .bind(id)
    .first<{ id: string; user_id: string; created_at: string; recalled_at: string | null }>()
  if (!row) throw new ApiError(404, "消息不存在", "NOT_FOUND")
  if (row.recalled_at) return json({ ok: true })

  const privileged = user.role === "admin" || user.role === "root"
  if (row.user_id !== user.id && !privileged) {
    throw new ApiError(403, "只能撤回自己的消息", "FORBIDDEN")
  }
  if (!privileged) {
    const age = Date.now() - new Date(row.created_at).getTime()
    if (age > RECALL_WINDOW_SECONDS * 1000) {
      throw new ApiError(400, "超过撤回时限（10 分钟）", "RECALL_EXPIRED")
    }
  }

  await env.DB.prepare(
    "UPDATE chat_messages SET recalled_at = ?, body = '' WHERE id = ? AND recalled_at IS NULL"
  )
    .bind(new Date().toISOString(), id)
    .run()

  return json({ ok: true })
}

/** POST /api/chat/heartbeat —— 心跳（前端每 30 秒一次） */
export async function heartbeat(env: Env, request: Request): Promise<Response> {
  const user = await requireChatUser(env, request)
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO chat_presence (user_id, last_seen_at) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`
  )
    .bind(user.id, now)
    .run()
  return json({ ok: true })
}

/** GET /api/chat/presence —— 在线用户（头像堆叠用） */
export async function presence(env: Env, request: Request): Promise<Response> {
  await requireChatUser(env, request)
  const cutoff = new Date(Date.now() - ONLINE_WINDOW_SECONDS * 1000).toISOString()
  const rows = await env.DB.prepare(
    `SELECT p.user_id, p.last_seen_at, u.username, u.nickname, u.avatar_key
       FROM chat_presence p JOIN users u ON u.id = p.user_id
      WHERE p.last_seen_at >= ?
      ORDER BY p.last_seen_at DESC LIMIT 50`
  )
    .bind(cutoff)
    .all()

  return json({
    online: (rows.results ?? []).map((r: Record<string, unknown>) => ({
      userId: r.user_id,
      username: r.username,
      nickname: r.nickname ?? null,
      hasAvatar: Boolean(r.avatar_key),
    })),
  })
}

/**
 * GET /api/chat/unread —— 「我看过之后」的新消息数（侧边栏角标用）。
 *
 * 口径与社区广场的 new-posts-count（迁移 0043）完全一致：
 *   - 看过：count(chat_messages where created_at > users.chat_seen_at)
 *   - 没看过（chat_seen_at 为 NULL，含上线前的老用户）：回落「最近 24 小时」，
 *     避免一上线就弹出一个积累了很久的大数字
 *   - 不算自己发的消息 —— 自己发的不需要「去读」
 *   - 进聊天室时前端调 POST /chat/seen 刷新 chat_seen_at，角标随之为 0
 */
export async function unreadCount(env: Env, request: Request): Promise<Response> {
  const me = await requireChatUser(env, request)

  const row = await env.DB.prepare("SELECT chat_seen_at FROM users WHERE id = ?")
    .bind(me.id)
    .first<{ chat_seen_at: string | null }>()

  const since =
    row?.chat_seen_at ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const r = await env.DB.prepare(
    "SELECT COUNT(*) c FROM chat_messages WHERE created_at > ? AND user_id <> ?"
  )
    .bind(since, me.id)
    .first<{ c: number }>()

  return json({ count: r?.c ?? 0 })
}

/**
 * POST /api/chat/seen —— 记下「我刚打开过聊天室」，把角标清零。
 *
 * 单独一个端点而不是塞进 listMessages 的副作用：消息列表会被 2 秒轮询反复调用，
 * 把它变成写操作会让缓存与语义都变脏（同社区 markCommunitySeen 的理由）。
 */
export async function markChatSeen(env: Env, request: Request): Promise<Response> {
  const me = await requireChatUser(env, request)
  await env.DB.prepare("UPDATE users SET chat_seen_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), me.id)
    .run()
  return json({ ok: true })
}

