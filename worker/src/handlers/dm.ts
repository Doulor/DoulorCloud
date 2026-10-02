/**
 * 一对一私信（2026-10-01 新增）。
 *
 * 用在哪：
 *   ① 积分商城交易双方互相联系（下单后商量交付、催确认收货）；
 *   ② 个人空间 / 聊天室里想私聊某人。
 *
 * 与聊天室（`chat.ts`）的区别：聊天室是**一个公共房间**，没有「对端」；
 * 这里每条消息都有明确的收件人，未读也是按「对端」算的。
 *
 * 表：`direct_messages`（migration 0088）。已读只用一列 `read_at`（收件人读的时间）——
 * 一对一场景下这就够了，不需要额外的位点表。
 *
 * ⚠️ 排序与游标一律按 `(created_at, id)` 元组，**绝不能只按 id**：
 * id 是 v4 随机 UUID，既不单调也不按时间排序（聊天室当初就是踩了这个坑，
 * 见 chat.ts 里那段注释）。created_at 是 ISO 8601 定长字符串，字典序 == 时间序。
 */
import { ApiError, json, readBodyCapped } from "../http"
import { requireUser } from "../auth"
import { uuid } from "../crypto"
import { guardRateLimit } from "../ratelimit"
import type { Env } from "../env"

/** 单条消息最大长度 */
const MAX_BODY = 2000
/** 一次最多拉多少条历史 */
const MAX_MESSAGES = 100
/** 会话列表最多返回多少个对端 */
const MAX_CONVERSATIONS = 50
/** 请求体上限（含 JSON 包装） */
const MAX_JSON_BODY_BYTES = 8 * 1024

/** 读取并解析 JSON 请求体（`readBodyCapped` 返回的是 ArrayBuffer，这里包一层） */
async function readJson(request: Request): Promise<Record<string, unknown>> {
  const buf = await readBodyCapped(request, MAX_JSON_BODY_BYTES, "请求内容过大")
  try {
    const parsed = JSON.parse(new TextDecoder().decode(buf))
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
  } catch {
    throw new ApiError(400, "请求内容不是合法 JSON", "INVALID_JSON")
  }
}

/** 游标编码：`<created_at>|<id>`（理由见文件头注释） */
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

interface PeerRow {
  id: string
  username: string
  nickname: string | null
  avatar_key: string | null
  status: string
}

/** 按用户名找对端（大小写不敏感，与站点其它地方口径一致） */
async function loadPeerByName(env: Env, username: string): Promise<PeerRow | null> {
  return env.DB.prepare(
    `SELECT id, username, nickname, avatar_key, status
       FROM users WHERE username = ? COLLATE NOCASE`
  )
    .bind(username)
    .first<PeerRow>()
}

/** 按 id 取对端（发过消息的对端可能已注销，取不到就跳过） */
async function loadPeersByIds(env: Env, ids: string[]): Promise<Map<string, PeerRow>> {
  const map = new Map<string, PeerRow>()
  if (ids.length === 0) return map
  // 分批查，避免 SQL 里的占位符过多（D1 对语句长度也有限制）
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20)
    const placeholders = chunk.map(() => "?").join(",")
    const rows = await env.DB.prepare(
      `SELECT id, username, nickname, avatar_key, status
         FROM users WHERE id IN (${placeholders})`
    )
      .bind(...chunk)
      .all<PeerRow>()
    for (const r of rows.results ?? []) map.set(r.id, r)
  }
  return map
}

/** 统一的消息下发形状 */
function toMessage(r: Record<string, unknown>) {
  return {
    id: r.id,
    fromUserId: r.from_user_id,
    toUserId: r.to_user_id,
    body: r.body,
    createdAt: r.created_at,
    readAt: r.read_at ?? null,
  }
}

/**
 * GET /api/dm?peer=<用户名>&after=<游标>
 *
 * 注意：**拉取不会自动标记已读**。已读由前端在「用户真的看到」时单独调
 * `/api/dm/seen`（与消息中心「点开才标已读」的语义一致）——
 * 否则轮询一次就把未读清零了，用户根本没看。
 */
export async function listDm(env: Env, request: Request): Promise<Response> {
  const me = await requireUser(env, request)
  const url = new URL(request.url)
  const peerName = (url.searchParams.get("peer") ?? "").trim()
  if (!peerName) throw new ApiError(400, "缺少对端用户名", "INVALID_INPUT")

  const peer = await loadPeerByName(env, peerName)
  if (!peer) throw new ApiError(404, "找不到这个用户", "NOT_FOUND")

  const after = url.searchParams.get("after") ?? ""
  const limit = Math.min(
    Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1),
    MAX_MESSAGES
  )
  const cursor = after ? decodeCursor(after) : null

  // 会话条件：两个方向都算（我发给他的 + 他发给我的）
  const pair =
    "(from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)"
  let rows
  if (cursor) {
    rows = await env.DB.prepare(
      `SELECT * FROM direct_messages
        WHERE (${pair}) AND (created_at > ? OR (created_at = ? AND id > ?))
        ORDER BY created_at ASC, id ASC LIMIT ?`
    )
      .bind(me.id, peer.id, peer.id, me.id, cursor.createdAt, cursor.createdAt, cursor.id, limit)
      .all()
  } else {
    rows = await env.DB.prepare(
      `SELECT * FROM (SELECT * FROM direct_messages WHERE ${pair}
          ORDER BY created_at DESC, id DESC LIMIT ?)
        ORDER BY created_at ASC, id ASC`
    )
      .bind(me.id, peer.id, peer.id, me.id, limit)
      .all()
  }

  const messages = (rows.results ?? []).map(toMessage)
  const last = messages[messages.length - 1]
  return json({
    peer: {
      id: peer.id,
      username: peer.username,
      nickname: peer.nickname ?? null,
      hasAvatar: Boolean(peer.avatar_key),
    },
    messages,
    nextCursor: last ? encodeCursor(String(last.createdAt), String(last.id)) : after || null,
  })
}

/** POST /api/dm —— 发送 `{ to: "<用户名>", body: "..." }` */
export async function sendDm(env: Env, request: Request): Promise<Response> {
  const me = await requireUser(env, request)
  // 私信是能骚扰到人的功能，限流比聊天室更紧一点（20 条/分钟/人）
  await guardRateLimit(env, `dm:send:${me.id}`, 20, 60, "发送过于频繁，请稍后再试")

  const body = await readJson(request)
  const toName = typeof body.to === "string" ? body.to.trim() : ""
  const text = typeof body.body === "string" ? body.body.trim() : ""
  if (!toName) throw new ApiError(400, "缺少收件人", "INVALID_INPUT")
  if (!text) throw new ApiError(400, "消息内容不能为空", "INVALID_INPUT")
  if (text.length > MAX_BODY) {
    throw new ApiError(400, `消息最长 ${MAX_BODY} 字`, "INVALID_INPUT")
  }

  const peer = await loadPeerByName(env, toName)
  if (!peer) throw new ApiError(404, "找不到这个用户", "NOT_FOUND")
  if (peer.id === me.id) throw new ApiError(400, "不能给自己发私信", "INVALID_INPUT")
  if (peer.status !== "active") {
    throw new ApiError(400, "该账号当前状态无法接收私信", "INVALID_INPUT")
  }

  const id = uuid()
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO direct_messages (id, from_user_id, to_user_id, body, created_at, read_at)
     VALUES (?, ?, ?, ?, ?, NULL)`
  )
    .bind(id, me.id, peer.id, text, now)
    .run()

  return json(
    {
      message: {
        id,
        fromUserId: me.id,
        toUserId: peer.id,
        body: text,
        createdAt: now,
        readAt: null,
      },
    },
    201
  )
}

/**
 * POST /api/dm/seen —— 把「与某个对端的会话里我收到的消息」标为已读。
 *
 * idempotent，随时可重复调用。
 */
export async function markDmSeen(env: Env, request: Request): Promise<Response> {
  const me = await requireUser(env, request)
  const body = await readJson(request)
  const peerName = typeof body.peer === "string" ? body.peer.trim() : ""
  if (!peerName) throw new ApiError(400, "缺少对端用户名", "INVALID_INPUT")

  const peer = await loadPeerByName(env, peerName)
  if (!peer) throw new ApiError(404, "找不到这个用户", "NOT_FOUND")

  const res = await env.DB.prepare(
    `UPDATE direct_messages SET read_at = ?
      WHERE to_user_id = ? AND from_user_id = ? AND read_at IS NULL`
  )
    .bind(new Date().toISOString(), me.id, peer.id)
    .run()
  return json({ ok: true, marked: res.meta?.changes ?? 0 })
}

/**
 * GET /api/dm/conversations —— 会话列表（每个对端一条，带最后一条与未读数）。
 *
 * 用窗口函数取「每个对端最近的一条」。`ROW_NUMBER() OVER (PARTITION BY ...)` 在
 * D1 的 SQLite 上是支持的；分成两条查询（最近一条 + 未读汇总）比一条巨型 JOIN 好读。
 */
export async function listConversations(env: Env, request: Request): Promise<Response> {
  const me = await requireUser(env, request)

  // 每个对端最近的一条消息
  const latest = await env.DB.prepare(
    `SELECT peer, from_user_id, to_user_id, body, created_at, read_at
       FROM (
         SELECT CASE WHEN from_user_id = ? THEN to_user_id ELSE from_user_id END AS peer,
                from_user_id, to_user_id, body, created_at, read_at,
                ROW_NUMBER() OVER (
                  PARTITION BY CASE WHEN from_user_id = ? THEN to_user_id ELSE from_user_id END
                  ORDER BY created_at DESC, id DESC
                ) AS rn
           FROM direct_messages
          WHERE from_user_id = ? OR to_user_id = ?
       )
      WHERE rn = 1
      ORDER BY created_at DESC
      LIMIT ?`
  )
    .bind(me.id, me.id, me.id, me.id, MAX_CONVERSATIONS)
    .all<Record<string, unknown>>()

  const rows = latest.results ?? []
  if (rows.length === 0) return json({ conversations: [], unreadTotal: 0 })

  // 未读汇总（我收到的、还没读的）
  const unreadRows = await env.DB.prepare(
    `SELECT from_user_id AS peer, COUNT(*) AS n
       FROM direct_messages
      WHERE to_user_id = ? AND read_at IS NULL
      GROUP BY from_user_id`
  )
    .bind(me.id)
    .all<{ peer: string; n: number }>()
  const unreadMap = new Map((unreadRows.results ?? []).map((r) => [r.peer, r.n]))
  const unreadTotal = (unreadRows.results ?? []).reduce((s, r) => s + Number(r.n ?? 0), 0)

  const peers = await loadPeersByIds(
    env,
    rows.map((r) => String(r.peer))
  )

  return json({
    conversations: rows
      .map((r) => {
        const peerId = String(r.peer)
        const p = peers.get(peerId)
        // 对端已注销：跳过（不然前端要处理一堆空用户名）
        if (!p) return null
        const last = toMessage(r)
        return {
          peer: {
            id: p.id,
            username: p.username,
            nickname: p.nickname ?? null,
            hasAvatar: Boolean(p.avatar_key),
          },
          last: {
            body: last.body,
            createdAt: last.createdAt,
            /** 最近这条是不是我发的（列表里显示「我：」前缀） */
            mine: last.fromUserId === me.id,
          },
          unread: unreadMap.get(peerId) ?? 0,
        }
      })
      .filter(Boolean),
    unreadTotal,
  })
}

/** GET /api/dm/unread —— 只取未读总数（侧边栏角标用，别为它拉整个列表） */
export async function dmUnreadCount(env: Env, request: Request): Promise<Response> {
  const me = await requireUser(env, request)
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM direct_messages WHERE to_user_id = ? AND read_at IS NULL"
  )
    .bind(me.id)
    .first<{ n: number }>()
  return json({ unread: Number(row?.n ?? 0) })
}
