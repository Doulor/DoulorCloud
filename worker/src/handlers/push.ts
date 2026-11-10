/**
 * Web Push 订阅管理（HTTP 接口）。
 *
 * 三个端点：
 *   GET  /api/push/public-key   前端订阅时要用的 VAPID 公钥（可缓存）
 *   POST /api/push/subscribe    浏览器 `pushManager.subscribe()` 的结果上报入库
 *   POST /api/push/unsubscribe  退订（关闭通知 / 换设备）
 *
 * 安全口径：
 *   · 订阅与**当前登录用户**绑定，端点里不接受 userId（否则能把通知推到别人设备）；
 *   · endpoint 天然唯一，重复订阅按 endpoint 覆盖（同一浏览器重装后不会堆一堆死订阅）；
 *   · 只存推送服务给的 endpoint 与两个公开展示用的密钥，不存任何会话/令牌。
 */
import { ApiError, json } from "../http"
import { requireUser } from "../auth"
import { uuid } from "../crypto"
import { assertPublicHttpUrl } from "../url-guard"
import { vapidPublicKey } from "../web-push"
import type { Env } from "../env"

/**
 * 校验并规范化推送端点。
 *
 * 为什么必须过 `assertPublicHttpUrl`：这个地址是**用户提交**的，而服务端会主动
 * 向它 POST（`pushToUser` → `sendPush`）—— 不过守卫就是一个现成的 SSRF 面
 * （让 Worker 去打内网 / 元数据地址）。浏览器给的推送端点都是公网 https
 * （FCM / Mozilla / Apple / WNS），所以这里额外要求 https。
 *
 * 规范化成 `URL.href` 再入库：同一个端点的不同写法（大小写主机名、默认端口、
 * 尾斜杠）必须命中同一条记录，否则 `ON CONFLICT(endpoint)` 覆盖不掉旧行。
 */
function normalizePushEndpoint(raw: unknown, label: string): string {
  const value = typeof raw === "string" ? raw.trim() : ""
  if (!value) throw new ApiError(400, "缺少推送端点", "INVALID_INPUT")
  let parsed: { url: URL }
  try {
    parsed = assertPublicHttpUrl(value, label)
  } catch (err) {
    throw new ApiError(
      400,
      err instanceof Error ? err.message : "推送端点不合法",
      "INVALID_INPUT"
    )
  }
  if (parsed.url.protocol !== "https:") {
    throw new ApiError(400, "推送端点必须使用 https", "INVALID_INPUT")
  }
  return parsed.url.href
}

/** GET /api/push/public-key */
export async function getPushPublicKey(env: Env): Promise<Response> {
  const key = await vapidPublicKey(env)
  return json({ key })
}

/** POST /api/push/subscribe */
export async function subscribePush(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json().catch(() => ({}))) as {
    endpoint?: unknown
    keys?: { p256dh?: unknown; auth?: unknown }
    ua?: unknown
  }

  const endpoint = normalizePushEndpoint(body.endpoint, "推送端点")
  const p256dh = typeof body.keys?.p256dh === "string" ? body.keys.p256dh.trim() : ""
  const auth = typeof body.keys?.auth === "string" ? body.keys.auth.trim() : ""
  const ua = typeof body.ua === "string" ? body.ua.slice(0, 200) : ""

  if (!p256dh || !auth) {
    throw new ApiError(400, "缺少推送密钥", "INVALID_INPUT")
  }
  // 长度兜底：p256dh 是 65 字节点的 base64url（~87 字符），auth 是 16 字节（~22 字符）
  if (p256dh.length > 200 || auth.length > 100) {
    throw new ApiError(400, "推送密钥过长", "INVALID_INPUT")
  }

  // 同一个 endpoint 可能已经属于别的账号（用户换号登录）—— 直接改归属
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, ua, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       ua = excluded.ua`
  )
    .bind(uuid(), user.id, endpoint, p256dh, auth, ua, new Date().toISOString())
    .run()

  return json({ ok: true })
}

/** POST /api/push/unsubscribe */
export async function unsubscribePush(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  const body = (await request.json().catch(() => ({}))) as { endpoint?: unknown }
  // 与订阅同一套规范化，否则「订阅时存的 href」和「退订时传的原串」对不上，删不掉
  const endpoint = normalizePushEndpoint(body.endpoint, "推送端点")

  // 只删自己的那条（别人的订阅不能靠猜 endpoint 删掉）
  await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?")
    .bind(endpoint, user.id)
    .run()
  return json({ ok: true })
}
