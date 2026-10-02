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
  /** 收件人是管理员/站长时免申请（给管理团队发消息不该被拦） */
  role: string
}

/** 按用户名找对端（大小写不敏感，与站点其它地方口径一致） */
async function loadPeerByName(env: Env, username: string): Promise<PeerRow | null> {
  return env.DB.prepare(
    `SELECT id, username, nickname, avatar_key, status, role
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
      `SELECT id, username, nickname, avatar_key, status, role
         FROM users WHERE id IN (${placeholders})`
    )
      .bind(...chunk)
      .all<PeerRow>()
    for (const r of rows.results ?? []) map.set(r.id, r)
  }
  return map
}

/**
 * 能不能给对方发消息（2026-10-01 站长要求：陌生人私信要先申请、对方同意后才能发）。
 *
 * 免申请（不落 dm_contacts 表）：
 *   ① 收件人是管理员 / 站长 —— 给管理团队发消息不该被拦；
 *   ② 双方有订单关系 —— 买家卖家本来就该能直接联系（站长确认：免）。
 *
 * 其余情况按 dm_contacts 关系判断：
 *   · 任一方向 accepted → 自由发；
 *   · **对方给我发过申请**（owner=我, peer=对方, status=request）→ 允许（我在回他的申请）；
 *   · 我发过申请还没处理（owner=对方, peer=我, status=request）→ 拦住，提示等对方同意；
 *   · 被拒绝（declined）→ 拦住，提示对方已拒绝；
 *   · 完全没有关系 → **允许这一条**，它本身就是「聊天申请」，发完落一条 request 记录。
 */
type SendGate =
  | { ok: true; /** 发完要不要落一条申请记录 */ needRequestRow: boolean }
  | { ok: false; code: string; message: string }

async function checkSendGate(
  env: Env,
  me: { id: string },
  peer: PeerRow
): Promise<SendGate> {
  if (peer.role === "admin" || peer.role === "root") return { ok: true, needRequestRow: false }

  const order = await env.DB.prepare(
    `SELECT 1 AS x FROM point_orders
      WHERE (user_id = ? AND seller_id = ?) OR (user_id = ? AND seller_id = ?)
      LIMIT 1`
  )
    .bind(me.id, peer.id, peer.id, me.id)
    .first<{ x: number }>()
  if (order) return { ok: true, needRequestRow: false }

  // ③ 已经互相聊过 = 事实上的同意。
  //    ⚠️ 必须有这条：私信是在加「聊天申请」**之前**上线的，线上已有一批老会话
  //    没有关系记录；不加这条的话，老用户第二天再回复一句就会被要求「先申请」，
  //    等于把已经建立的对话掐断（2026-10-01 上线时线上已有 28 条真实消息）。
  const prior = await env.DB.prepare(
    `SELECT 1 AS x FROM direct_messages
      WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)
      LIMIT 1`
  )
    .bind(me.id, peer.id, peer.id, me.id)
    .first<{ x: number }>()
  if (prior) return { ok: true, needRequestRow: false }

  const rows = await env.DB.prepare(
    `SELECT owner_id, peer_id, status FROM dm_contacts
      WHERE (owner_id = ? AND peer_id = ?) OR (owner_id = ? AND peer_id = ?)`
  )
    .bind(peer.id, me.id, me.id, peer.id)
    .all<{ owner_id: string; peer_id: string; status: string }>()
  const rel = rows.results ?? []

  if (rel.some((r) => r.status === "accepted")) return { ok: true, needRequestRow: false }
  // 对方申请过我 → 我这是在回复，放行
  if (rel.some((r) => r.owner_id === me.id && r.status === "request")) {
    return { ok: true, needRequestRow: false }
  }
  const mine = rel.find((r) => r.owner_id === peer.id && r.peer_id === me.id)
  if (mine?.status === "declined") {
    return {
      ok: false,
      code: "DM_DECLINED",
      message: "对方已拒绝你的聊天申请，无法再给他发消息。",
    }
  }
  if (mine?.status === "request") {
    return {
      ok: false,
      code: "DM_PENDING",
      message: "你的聊天申请还在等对方同意。对方同意后就能继续聊。",
    }
  }
  // 从没接触过 → 这一条作为申请发出
  return { ok: true, needRequestRow: true }
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
 * GET /api/dm?peer=<用户名>&after=<游标>&before=<游标>
 *
 * `after` 拉**更新**的消息（轮询用）；`before` 拉**更早**的消息（往上翻历史用）。
 * 两者互斥，同时传以 `before` 为准。返回里 `nextCursor` 供 `after` 用、
 * `prevCursor` 供 `before` 用，`hasMore` 表示可能还有更早的。
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
  /**
   * 往前翻页游标：拉**比它更早**的消息（用户往上滑看历史）。
   *
   * 与 `after`（拉更新的、供轮询用）方向相反，两者互斥：
   * 同时传时以 `before` 为准 —— 它只会在「往上滑」时出现，
   * 那一刻用户要看的是历史，不是新消息。
   */
  const before = url.searchParams.get("before") ?? ""
  const limit = Math.min(
    Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1),
    MAX_MESSAGES
  )
  const cursor = after ? decodeCursor(after) : null
  const beforeCursor = before ? decodeCursor(before) : null

  // 会话条件：两个方向都算（我发给他的 + 他发给我的）
  const pair =
    "(from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)"
  let rows
  if (beforeCursor) {
    // 往前：取游标之前最近的 limit 条。先倒序取（才能拿到「最近的」），
    // 再在外层转回正序 —— 返回给前端的始终是时间升序，前端不用管方向。
    rows = await env.DB.prepare(
      `SELECT * FROM (SELECT * FROM direct_messages
          WHERE (${pair}) AND (created_at < ? OR (created_at = ? AND id < ?))
          ORDER BY created_at DESC, id DESC LIMIT ?)
        ORDER BY created_at ASC, id ASC`
    )
      .bind(
        me.id,
        peer.id,
        peer.id,
        me.id,
        beforeCursor.createdAt,
        beforeCursor.createdAt,
        beforeCursor.id,
        limit
      )
      .all()
  } else if (cursor) {
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
  const first = messages[0]
  return json({
    peer: {
      id: peer.id,
      username: peer.username,
      nickname: peer.nickname ?? null,
      hasAvatar: Boolean(peer.avatar_key),
    },
    messages,
    nextCursor: last ? encodeCursor(String(last.createdAt), String(last.id)) : after || null,
    /** 往前翻页游标：传给 `before` 就能取到更早的一批（没有更早的了则为 null） */
    prevCursor: first ? encodeCursor(String(first.createdAt), String(first.id)) : null,
    /**
     * 是否可能还有更早的消息。
     * 取满了 limit 条就认为「可能还有」—— 少一次精确 COUNT 查询，
     * 前端据此决定还要不要继续监听滚动加载。
     */
    hasMore: messages.length >= limit,
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

  // 陌生人的第一条消息 = 聊天申请；对方同意前只能发这一条
  const gate = await checkSendGate(env, me, peer)
  if (!gate.ok) throw new ApiError(403, gate.message, gate.code)

  const id = uuid()
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO direct_messages (id, from_user_id, to_user_id, body, created_at, read_at)
     VALUES (?, ?, ?, ?, ?, NULL)`
  )
    .bind(id, me.id, peer.id, text, now)
    .run()

  if (gate.needRequestRow) {
    // 落一条待处理申请（重复发不覆盖已同意/已拒绝的状态 —— 用 OR IGNORE）
    await env.DB.prepare(
      `INSERT OR IGNORE INTO dm_contacts (owner_id, peer_id, status, created_at, updated_at)
       VALUES (?, ?, 'request', ?, ?)`
    )
      .bind(peer.id, me.id, now, now)
      .run()
  }

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

/**
 * GET /api/dm/requests —— 我收到的**待处理聊天申请**。
 *
 * 带上对方发来的第一条（也是唯一一条）消息，好让用户知道「是谁、想干嘛」再决定。
 */
export async function listDmRequests(env: Env, request: Request): Promise<Response> {
  const me = await requireUser(env, request)
  const rows = await env.DB.prepare(
    `SELECT c.peer_id, c.created_at,
            u.username, u.nickname, u.avatar_key
       FROM dm_contacts c JOIN users u ON u.id = c.peer_id
      WHERE c.owner_id = ? AND c.status = 'request'
      ORDER BY c.created_at DESC
      LIMIT 50`
  )
    .bind(me.id)
    .all<{
      peer_id: string
      created_at: string
      username: string
      nickname: string | null
      avatar_key: string | null
    }>()

  const requests = []
  for (const r of rows.results ?? []) {
    // 对方发给我的最新一条（申请时只有一条；之后若对方再发，会被门槛拦住）
    const msg = await env.DB.prepare(
      `SELECT body, created_at FROM direct_messages
        WHERE from_user_id = ? AND to_user_id = ?
        ORDER BY created_at DESC, id DESC LIMIT 1`
    )
      .bind(r.peer_id, me.id)
      .first<{ body: string; created_at: string }>()
    requests.push({
      peer: {
        id: r.peer_id,
        username: r.username,
        nickname: r.nickname ?? null,
        hasAvatar: Boolean(r.avatar_key),
      },
      body: msg?.body ?? "",
      createdAt: msg?.created_at ?? r.created_at,
    })
  }
  return json({ requests })
}

/**
 * POST /api/dm/requests —— 处理申请：`{ peer: "<用户名>", action: "accept" | "decline" }`
 *
 * 只有**收到申请的一方**能处理；同意后双方即可自由发消息（发送门槛里看 accepted）。
 */
export async function respondDmRequest(env: Env, request: Request): Promise<Response> {
  const me = await requireUser(env, request)
  const body = await readJson(request)
  const peerName = typeof body.peer === "string" ? body.peer.trim() : ""
  const action = body.action === "accept" ? "accept" : body.action === "decline" ? "decline" : ""
  if (!peerName) throw new ApiError(400, "缺少对端用户名", "INVALID_INPUT")
  if (!action) throw new ApiError(400, "action 只能是 accept 或 decline", "INVALID_INPUT")

  const peer = await loadPeerByName(env, peerName)
  if (!peer) throw new ApiError(404, "找不到这个用户", "NOT_FOUND")

  const now = new Date().toISOString()
  const res = await env.DB.prepare(
    `UPDATE dm_contacts SET status = ?, updated_at = ?
      WHERE owner_id = ? AND peer_id = ? AND status = 'request'`
  )
    .bind(action === "accept" ? "accepted" : "declined", now, me.id, peer.id)
    .run()
  if ((res.meta?.changes ?? 0) === 0) {
    throw new ApiError(404, "没有待处理的聊天申请", "NOT_FOUND")
  }
  return json({ ok: true, status: action === "accept" ? "accepted" : "declined" })
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
