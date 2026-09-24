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
import type { Env } from "../env"

/** 在线判定窗口：最近 N 秒内有心跳 */
const ONLINE_WINDOW_SECONDS = 120

/** 消息最大长度 */
const MAX_BODY = 2000

/** 拉取的历史消息上限 */
const MAX_MESSAGES = 100

/** GET /api/chat/messages?after=<id>&limit= */
export async function listMessages(env: Env, request: Request): Promise<Response> {
  await requireUser(env, request)
  const url = new URL(request.url)
  const after = url.searchParams.get("after") ?? ""
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), MAX_MESSAGES)

  // 带 after 则增量拉取（只取比 after 新的）；否则拉最新 N 条
  let rows
  if (after) {
    rows = await env.DB.prepare(
      `SELECT m.id, m.user_id, m.body, m.created_at, u.username, u.nickname, u.avatar_key
         FROM chat_messages m JOIN users u ON u.id = m.user_id
        WHERE m.id > ?
        ORDER BY m.id ASC LIMIT ?`
    )
      .bind(after, limit)
      .all()
  } else {
    rows = await env.DB.prepare(
      `SELECT m.id, m.user_id, m.body, m.created_at, u.username, u.nickname, u.avatar_key
         FROM (SELECT * FROM chat_messages ORDER BY id DESC LIMIT ?) m
         JOIN users u ON u.id = m.user_id
        ORDER BY m.id ASC`
    )
      .bind(limit)
      .all()
  }

  return json({
    messages: (rows.results ?? []).map(toMessage),
  })
}

function toMessage(r: Record<string, unknown>) {
  return {
    id: r.id,
    userId: r.user_id,
    username: r.username,
    nickname: r.nickname ?? null,
    hasAvatar: Boolean(r.avatar_key),
    body: r.body,
    createdAt: r.created_at,
  }
}

/** POST /api/chat/messages —— 发消息 */
export async function sendMessage(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  await guardRateLimit(
    env,
    `chat:send:ip:${clientIp(request)}`,
    30,
    60,
    "发言过于频繁"
  )

  const body = (await request.json().catch(() => ({}))) as { body?: string }
  const text = (body.body ?? "").trim()
  if (!text) throw new ApiError(400, "内容不能为空", "INVALID_INPUT")
  if (text.length > MAX_BODY) throw new ApiError(400, "内容过长", "TOO_LARGE")

  const id = uuid()
  const now = new Date().toISOString()
  await env.DB.prepare(
    "INSERT INTO chat_messages (id, user_id, body, created_at) VALUES (?, ?, ?, ?)"
  )
    .bind(id, user.id, text, now)
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
      createdAt: now,
    },
  }, 201)
}

/** POST /api/chat/heartbeat —— 心跳（前端每 30 秒一次） */
export async function heartbeat(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
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
  await requireUser(env, request)
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
