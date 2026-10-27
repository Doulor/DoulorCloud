/**
 * 羊毛记录（QQ 机器人自助登记，2026-10-26）。
 *
 * 背景：站长要一个「谁都能用」的群里指令，把看到的福利羊毛记下来、归纳、看图。
 * 机器人跑在 Worker 里（handlers/qq.ts 的官方 Bot webhook），所以这里只做数据层。
 *
 * 鉴权：机器人侧用 BOT_API_KEY（shared secret）调用，不带用户会话；
 *       scope_id 由机器人从事件里取（群 group_openid / 私聊 user_openid），
 *       命令里不允许客户端自定义 scope_id，避免越权读别的群。
 */
import { json, assertContentLengthWithin } from "../http"
import type { Env } from "../env"
import { uuid } from "../crypto"

const MAX_PER_HOUR = 12
const MAX_TITLE = 120
const MAX_NOTE = 300

type Row = {
  id: string
  seq: number
  title: string
  source: string | null
  link: string | null
  value: string | null
  note: string | null
  status: string
  expires_at: number | null
  scope: string
  scope_id: string | null
  created_by: string | null
  created_at: number
  updated_at: number
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

async function bodyOf<T>(request: Request, limit = 8 * 1024): Promise<T> {
  assertContentLengthWithin(request, limit, "请求内容过大")
  return (await request.json().catch(() => ({}))) as T
}

/** 机器人共享密钥校验。 */
function assertBot(env: Env, request: Request): void {
  const key = env.BOT_API_KEY
  const got = request.headers.get("x-bot-key") || ""
  if (!key || got !== key) {
    throw new Error("forbidden")
  }
}

async function bumpQuota(env: Env, userKey: string): Promise<boolean> {
  const now = nowSec()
  const windowStart = now - 3600
  const row = await env.DB.prepare(`SELECT window_at, count FROM wool_quota WHERE user_key = ?`)
    .bind(userKey)
    .first<{ window_at: number; count: number }>()
  if (!row || row.window_at < windowStart) {
    await env.DB.prepare(
      `INSERT INTO wool_quota (user_key, window_at, count) VALUES (?, ?, 1)
       ON CONFLICT(user_key) DO UPDATE SET window_at = excluded.window_at, count = 1`
    )
      .bind(userKey, now)
      .run()
    return true
  }
  if (row.count >= MAX_PER_HOUR) return false
  await env.DB.prepare(`UPDATE wool_quota SET count = count + 1 WHERE user_key = ?`).bind(userKey).run()
  return true
}

/** 把过期的 open 记录标成 dead（读时顺手收敛，省一个定时任务）。 */
async function sweepExpired(env: Env, scope: string, scopeId: string): Promise<void> {
  const now = nowSec()
  await env.DB.prepare(
    `UPDATE wool_items SET status = 'dead', updated_at = ?
      WHERE scope = ? AND scope_id = ? AND status = 'open' AND expires_at IS NOT NULL AND expires_at <= ?`
  )
    .bind(now, scope, scopeId, now)
    .run()
}

/** POST /wool/add { scope, scopeId, title, source?, link?, value?, note?, expiresInHours?, createdBy? } */
export async function woolAdd(env: Env, request: Request): Promise<Response> {
  assertBot(env, request)
  const b = await bodyOf<{
    scope?: string
    scopeId?: string
    title?: string
    source?: string
    link?: string
    value?: string
    note?: string
    expiresInHours?: number
    createdBy?: string
  }>(request)

  const scope = b.scope === "private" ? "private" : "group"
  const scopeId = (b.scopeId || "").trim()
  const title = (b.title || "").trim().slice(0, MAX_TITLE)
  if (!scopeId || !title) return json({ ok: false, reason: "bad_params" }, 400)

  const userKey = `${scope}:${scopeId}:${b.createdBy || "anon"}`
  if (!(await bumpQuota(env, userKey))) {
    return json({ ok: false, reason: "rate_limited", detail: `每小时最多 ${MAX_PER_HOUR} 条` }, 429)
  }

  const now = nowSec()
  const maxSeq =
    (await env.DB.prepare(`SELECT MAX(seq) AS m FROM wool_items WHERE scope = ? AND scope_id = ?`)
      .bind(scope, scopeId)
      .first<{ m: number | null }>())?.m ?? 0

  const expiresAt = b.expiresInHours && b.expiresInHours > 0 ? now + Math.floor(b.expiresInHours * 3600) : null

  await env.DB.prepare(
    `INSERT INTO wool_items
       (id, seq, title, source, link, value, note, status, expires_at, scope, scope_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      uuid(),
      maxSeq + 1,
      title,
      b.source?.slice(0, 60) ?? null,
      b.link?.slice(0, 500) ?? null,
      b.value?.slice(0, 60) ?? null,
      b.note?.slice(0, MAX_NOTE) ?? null,
      expiresAt,
      scope,
      scopeId,
      b.createdBy ?? null,
      now,
      now
    )
    .run()

  return json({ ok: true, seq: maxSeq + 1, expiresAt })
}

/** POST /wool/list { scope, scopeId, limit? } → 最近 N 条（默认 8） */
export async function woolList(env: Env, request: Request): Promise<Response> {
  assertBot(env, request)
  const b = await bodyOf<{ scope?: string; scopeId?: string; limit?: number }>(request)
  const scope = b.scope === "private" ? "private" : "group"
  const scopeId = (b.scopeId || "").trim()
  if (!scopeId) return json({ ok: false, reason: "bad_params" }, 400)

  await sweepExpired(env, scope, scopeId)

  const limit = Math.min(Math.max(b.limit ?? 8, 1), 20)
  const rows = await env.DB.prepare(
    `SELECT * FROM wool_items WHERE scope = ? AND scope_id = ?
      ORDER BY (status = 'open') DESC, seq DESC LIMIT ?`
  )
    .bind(scope, scopeId, limit)
    .all<Row>()

  return json({ ok: true, items: rows.results ?? [] })
}

/** POST /wool/done { scope, scopeId, seq } */
export async function woolDone(env: Env, request: Request): Promise<Response> {
  assertBot(env, request)
  const b = await bodyOf<{ scope?: string; scopeId?: string; seq?: number; status?: string }>(request)
  const scope = b.scope === "private" ? "private" : "group"
  const scopeId = (b.scopeId || "").trim()
  const seq = Number(b.seq)
  if (!scopeId || !Number.isFinite(seq)) return json({ ok: false, reason: "bad_params" }, 400)

  const status = b.status === "dead" ? "dead" : "done"
  const res = await env.DB.prepare(
    `UPDATE wool_items SET status = ?, updated_at = ?
      WHERE scope = ? AND scope_id = ? AND seq = ?`
  )
    .bind(status, nowSec(), scope, scopeId, seq)
    .run()

  return json({ ok: (res.meta?.changes ?? 0) > 0, seq, status })
}

/** POST /wool/summary { scope, scopeId } → 给 LLM 归纳用的紧凑数据 */
export async function woolSummary(env: Env, request: Request): Promise<Response> {
  assertBot(env, request)
  const b = await bodyOf<{ scope?: string; scopeId?: string }>(request)
  const scope = b.scope === "private" ? "private" : "group"
  const scopeId = (b.scopeId || "").trim()
  if (!scopeId) return json({ ok: false, reason: "bad_params" }, 400)

  await sweepExpired(env, scope, scopeId)

  const open = await env.DB.prepare(
    `SELECT seq, title, source, value, expires_at FROM wool_items
      WHERE scope = ? AND scope_id = ? AND status = 'open'
      ORDER BY (expires_at IS NULL), expires_at ASC LIMIT 40`
  )
    .bind(scope, scopeId)
    .all<Row>()

  const counts = await env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM wool_items WHERE scope = ? AND scope_id = ? GROUP BY status`
  )
    .bind(scope, scopeId)
    .all<{ status: string; n: number }>()

  return json({
    ok: true,
    open: open.results ?? [],
    counts: Object.fromEntries((counts.results ?? []).map((r) => [r.status, r.n])),
  })
}
