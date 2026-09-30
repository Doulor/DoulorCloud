/**
 * App 端「消息中心」通知 —— 给 WebToApp 打包的安卓 App 用的拉取接口。
 *
 * 背景：站长用 WebToApp（原生安卓 WebView 壳）把本站打成了 App。它内置一个
 * 「轮询前台服务」（NotificationPollingService），按固定间隔请求一个 URL，
 * 把返回的 JSON 逐条弹成系统通知 —— 这条路不依赖 Firebase，是移动端通知最省事的接入方式。
 *
 * ⚠️ 两个由 App 侧决定、服务端必须配合的点（都读过 App 源码确认）：
 *   1. 它用 `HttpURLConnection` 直接发请求，**不带 Cookie** ⇒ 只能靠自定义请求头里的令牌认人。
 *   2. 它**完全不去重**（通知 id 用 `System.currentTimeMillis()` 拼），返回几条就弹几条，
 *      每条最多弹 5 个 ⇒ 「同一条消息只推一次」必须由服务端用游标记住，
 *      否则用户会每隔几分钟收到同一条重复通知。
 *
 * 返回格式（App 侧约定）：JSON 数组，每项 `{ title, body, url }`；
 * 空数组表示没有新消息（App 会直接跳过）。`url` 是点通知后要打开的地址，必须是**绝对地址**。
 */
import { ApiError, json } from "../http"
import { requireUser } from "../auth"
import { generateToken } from "../crypto"
import type { Env } from "../env"

/** 单次最多返回几条。App 侧自己也只取前 5 条（`notifications.take(5)`）。 */
const MAX_ITEMS = 5

/** 首次拉取时回溯多久的历史通知（没有游标的新用户） */
const FIRST_RUN_WINDOW_MS = 24 * 60 * 60 * 1000

/** 取令牌：优先 Authorization: Bearer，其次查询串里的 token（方便只想填一个 URL 的场景）。 */
function readToken(request: Request): string {
  const auth = request.headers.get("Authorization") ?? ""
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim())
  if (m) return m[1].trim()
  return (new URL(request.url).searchParams.get("token") ?? "").trim()
}

/** 把库里存的相对路径补成绝对地址 —— App 拿到的是要直接打开的 URL。 */
function absolute(link: string | null, request: Request, fallback: string): string {
  const raw = link && link.trim() ? link.trim() : fallback
  if (/^https?:\/\//i.test(raw)) return raw
  const origin = new URL(request.url).origin
  return origin + (raw.startsWith("/") ? raw : "/" + raw)
}

/**
 * GET /api/app/notifications
 *
 * 供 App 的轮询前台服务调用。鉴权走 `Authorization: Bearer <app_notify_token>`。
 * 每次调用都会把游标推进到当前时间：只返回「上次拉取之后新产生的」通知。
 */
export async function pullAppNotifications(env: Env, request: Request): Promise<Response> {
  const token = readToken(request)
  if (!token) throw new ApiError(401, "缺少令牌", "UNAUTHORIZED")

  const row = await env.DB.prepare(
    "SELECT id, notify_pushed_at FROM users WHERE app_notify_token = ?"
  )
    .bind(token)
    .first<{ id: string; notify_pushed_at: string | null }>()
  if (!row) throw new ApiError(401, "令牌无效", "UNAUTHORIZED")

  // 没有游标（刚开启 / 从没拉过）就只回溯最近 24 小时，避免一装上就弹一堆历史消息
  const since = row.notify_pushed_at ?? new Date(Date.now() - FIRST_RUN_WINDOW_MS).toISOString()

  const rows = await env.DB.prepare(
    `SELECT title, body, link
       FROM notifications
      WHERE user_id = ? AND created_at > ?
      ORDER BY created_at ASC
      LIMIT ?`
  )
    .bind(row.id, since, MAX_ITEMS)
    .all()

  // 推进游标：App 不会去重，所以「推过的不再推」只能记在这里。
  // ⚠️ 已知取舍：若响应在回程丢了，这批发过的就不会补发（宁可漏一次，也不要每几分钟重复骚扰）。
  await env.DB.prepare("UPDATE users SET notify_pushed_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), row.id)
    .run()

  const items = (rows.results ?? []).map((r) => {
    const rec = r as Record<string, unknown>
    return {
      title: (rec.title as string | null)?.trim() || "Doulor Cloud",
      body: ((rec.body as string | null) ?? "").trim(),
      url: absolute((rec.link as string | null) ?? null, request, "/dashboard/messages"),
    }
  })

  return json(items)
}

/** GET /api/app/notify-token —— 取当前令牌；没有就生成一个（设置页里展示给用户复制）。 */
export async function getAppNotifyToken(env: Env, request: Request): Promise<Response> {
  const me = await requireUser(env, request)
  const row = await env.DB.prepare("SELECT app_notify_token FROM users WHERE id = ?")
    .bind(me.id)
    .first<{ app_notify_token: string | null }>()

  let token = row?.app_notify_token ?? null
  if (!token) {
    token = generateToken()
    await env.DB.prepare("UPDATE users SET app_notify_token = ? WHERE id = ?")
      .bind(token, me.id)
      .run()
  }

  const origin = new URL(request.url).origin
  return json({
    token,
    // App 的通知配置里直接填这个地址（配合下面的请求头）
    url: `${origin}/api/app/notifications`,
    header: `Authorization: Bearer ${token}`,
    headerJson: JSON.stringify({ Authorization: `Bearer ${token}` }),
  })
}

/** POST /api/app/notify-token/rotate —— 重新生成，旧令牌立即失效。 */
export async function rotateAppNotifyToken(env: Env, request: Request): Promise<Response> {
  const me = await requireUser(env, request)
  const token = generateToken()
  await env.DB.prepare("UPDATE users SET app_notify_token = ? WHERE id = ?")
    .bind(token, me.id)
    .run()

  const origin = new URL(request.url).origin
  return json({
    token,
    url: `${origin}/api/app/notifications`,
    header: `Authorization: Bearer ${token}`,
    headerJson: JSON.stringify({ Authorization: `Bearer ${token}` }),
  })
}
