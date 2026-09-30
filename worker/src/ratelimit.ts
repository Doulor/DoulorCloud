/**
 * 轻量限流（基于 D1 的固定窗口计数）。
 *
 * 为什么需要（2026-09-23 安全审计发现）：
 *   全站此前只有 3 处 429（社区发帖/评论、邮箱验证），而**登录、注册完全无限流**。
 *   密码用 8 位起、用户名可猜，攻击者可对 `POST /api/login` 做无限次在线爆破；
 *   `POST /api/register` 也是拿邀请码做无成本的猜测。
 *
 * 为什么用 D1 而不是 KV / Durable Objects：
 *   项目已有 D1，加一张小表即可，不引入新绑定、不增加部署配置；
 *   计数键（bucket）数量有限，表规模可控（每个键只有一行，窗口滚动时原地覆盖）。
 *
 * ⚠️ 可用性优先（fail-open）：
 *   本模块**故意不吞异常**，由调用方用 `guard()` 包装 —— 表未建（迁移未执行）或
 *   D1 抖动时**放行请求并打日志**，绝不能让「限流的存储故障」演变成「全站无法登录」。
 *   代价是故障期间失去防爆破能力，这是有意为之的取舍。
 */
import { ApiError } from "./http"
import type { Env } from "./env"

export interface RateLimitResult {
  /** 是否放行 */
  ok: boolean
  /** 当前窗口内已计数 */
  count: number
  limit: number
  /** 建议等待秒数（ok=true 时为 0） */
  retryAfter: number
}

/**
 * 记一次并判断是否超限。
 * @param bucket 计数键，建议形如 `login:ip:<ip>` / `login:user:<name>`
 * @param limit 窗口内允许的最大次数
 * @param windowSeconds 窗口长度（秒）
 */
export async function hitRateLimit(
  env: Env,
  bucket: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const now = Date.now()
  const windowMs = Math.max(1, windowSeconds) * 1000
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs).toISOString()
  const nowIso = new Date(now).toISOString()

  // 条件 UPSERT：同一窗口内自增，跨窗口重置为 1。
  // ⚠️ 2026-10-01 性能：原来「UPSERT + SELECT」是两次 D1 往返；改为 RETURNING
  // 一次往返（已在线上 D1 实测：RETURNING 会正确返回自增后的 count）。
  // 限流在 51 个接口上被调用，跨境用户每次可省 ~120ms。
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (bucket, count, window_start, updated_at)
          VALUES (?, 1, ?, ?)
     ON CONFLICT(bucket) DO UPDATE SET
          count = CASE
                    WHEN rate_limits.window_start = excluded.window_start
                    THEN rate_limits.count + 1
                    ELSE 1
                  END,
          window_start = excluded.window_start,
          updated_at = excluded.updated_at
     RETURNING count, window_start`
  )
    .bind(bucket, windowStart, nowIso)
    .first<{ count: number; window_start: string }>()

  const count = row?.count ?? 1
  const startMs = row?.window_start ? new Date(row.window_start).getTime() : now
  const retryAfter = Math.max(1, Math.ceil((startMs + windowMs - now) / 1000))

  return { ok: count <= limit, count, limit, retryAfter }
}

/** 取客户端 IP（Cloudflare 注入；取不到时给一个不参与限流算法的退化值） */
export function clientIp(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Real-IP") ??
    "unknown"
  )
}

/**
 * 限流键中的用户输入必须先规范化，否则 `a@b.com` 与 `A@B.COM ` 会被算成两个桶，
 * 白白送给攻击者「换个大小写」的绕过空间。
 */
export function normalizeKeyPart(input: string): string {
  return input.trim().toLowerCase().slice(0, 120)
}

/**
 * 限流护栏（fail-open 的唯一入口）。
 *
 * 放在这里而不是各处 handler，是为了避免"每个调用点自己 try/catch"导致行为漂移：
 *   - 超限 → 抛 429（带 retryAfter 秒数）；
 *   - **存储层故障 → 放行并打日志**。宁可短暂失去防爆破能力，
 *     也不能因为限流表没建好（迁移未执行）或 D1 抖动而让所有人登不进来。
 *
 * 注意 catch 里必须原样重抛 ApiError，否则刚抛出的 429 会被自己吞掉。
 */
export async function guardRateLimit(
  env: Env,
  bucket: string,
  limit: number,
  windowSeconds: number,
  message: string
): Promise<void> {
  try {
    const result = await hitRateLimit(env, bucket, limit, windowSeconds)
    if (!result.ok) {
      throw new ApiError(
        429,
        `${message}，请 ${result.retryAfter} 秒后再试`,
        "RATE_LIMITED"
      )
    }
  } catch (err) {
    if (err instanceof ApiError) throw err
    console.error("限流检查失败（已放行）:", bucket, err)
  }
}
