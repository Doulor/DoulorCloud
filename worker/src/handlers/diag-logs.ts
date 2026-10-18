/**
 * 诊断日志（用户反馈附带的前端运行记录）。
 *
 * 前端 src/lib/diag-log.ts 维护一个环形缓冲（路由 / JS 错误 / 接口失败 /
 * 长任务 / 加载指标）。用户提交反馈时可选「附上诊断日志」+ 时间窗
 * （5 / 15 / 60 分钟），前端把窗口内的条目打包 POST 到这里，随反馈一起落库。
 *
 * 设计边界：
 *   · 单份日志上限 64KB —— 超了前端自己先截（丢最旧的条目），后端兜底再截一次；
 *   · 时间窗只有 5/15/60 三档：再大上传包就失去定位意义（也就没有「5 分钟前
 *     的问题」这种粒度了），前端选项与服务端白名单保持一致；
 *   · 日志只属于上传者本人，读取走反馈详情（管理端）——这里不做独立读接口，
 *     避免多出一个可枚举用户日志的面。
 */
import { ApiError, json, readBodyCapped } from "../http"
import { requireUser } from "../auth"
import { guardRateLimit } from "../ratelimit"
import { uuid } from "../crypto"
import type { Env } from "../env"

/** 请求体上限：前端单份日志包最大 64KB，留一倍余量 */
const MAX_LOG_BODY_BYTES = 128 * 1024
/** 允许的时间窗（分钟）：与前端 DIAG_WINDOWS 一致 */
const ALLOWED_WINDOWS = [5, 15, 60] as const
/** 单份日志落库上限（字符数）。超出视为前端没截干净，返回错误让前端收紧。 */
const MAX_PAYLOAD_CHARS = 64 * 1024

/** 上传一份诊断日志，返回 id（提交反馈时塞进 diagLogId 字段） */
export async function uploadDiagLog(env: Env, request: Request): Promise<Response> {
  const user = await requireUser(env, request)
  // 每小时 12 份：正常使用（反馈时附一次）远用不到，挡住滥用即可
  await guardRateLimit(env, `diag-log:${user.id}`, 12, 3600, "诊断日志上传过于频繁")

  const buf = await readBodyCapped(
    request,
    MAX_LOG_BODY_BYTES,
    "诊断日志过大，请缩小时间范围后重试"
  )
  let parsed: { windowMinutes?: unknown; entries?: unknown; truncated?: unknown }
  try {
    parsed = JSON.parse(new TextDecoder().decode(buf))
  } catch {
    throw new ApiError(400, "请求格式不正确", "INVALID_JSON")
  }

  const windowMinutes = Number(parsed.windowMinutes)
  if (!(ALLOWED_WINDOWS as readonly number[]).includes(windowMinutes)) {
    throw new ApiError(400, "无效的时间范围", "INVALID_INPUT")
  }

  const entries = Array.isArray(parsed.entries) ? parsed.entries : []
  if (entries.length === 0) {
    throw new ApiError(400, "日志内容为空", "INVALID_INPUT")
  }
  const payload = JSON.stringify(entries)
  if (payload.length > MAX_PAYLOAD_CHARS) {
    throw new ApiError(400, "诊断日志过大，请缩小时间范围后重试", "TOO_LARGE")
  }

  const id = uuid()
  await env.DB.prepare(
    `INSERT INTO diagnostic_logs (id, user_id, window_minutes, entry_count, truncated, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      user.id,
      windowMinutes,
      entries.length,
      parsed.truncated === true ? 1 : 0,
      payload,
      new Date().toISOString()
    )
    .run()

  return json({ id }, 201)
}

/**
 * 反馈详情用：按 id 读一份日志，不存在的返回 null。
 *
 * ⚠️ 这里**不做归属校验**，因为唯一调用方是管理端的反馈详情
 * （handlers/feedback.ts 的 adminFeedbackDetail，路由 /api/admin/feedback/detail，
 * 已由 requireAdminScope 把关）。日志的 id 是 uuid，不对普通用户暴露任何读接口，
 * 所以不存在「枚举别人的日志」这条面 —— 加 user_id 条件反而会让「管理员看
 * 用户反馈附带的日志」这个唯一用途失效。
 */
export async function getDiagLogForFeedback(
  env: Env,
  logId: string | null
): Promise<{ id: string; windowMinutes: number; entryCount: number; truncated: boolean; createdAt: string; entries: unknown[] } | null> {
  if (!logId) return null
  const row = await env.DB.prepare(
    "SELECT id, window_minutes, entry_count, truncated, payload, created_at FROM diagnostic_logs WHERE id = ?"
  )
    .bind(logId)
    .first<{
      id: string
      window_minutes: number
      entry_count: number
      truncated: number
      payload: string
      created_at: string
    }>()
  if (!row) return null
  let entries: unknown[] = []
  try {
    const parsed = JSON.parse(row.payload)
    if (Array.isArray(parsed)) entries = parsed
  } catch {
    // 坏 JSON：按空处理，不让整条反馈详情挂掉
  }
  return {
    id: row.id,
    windowMinutes: row.window_minutes,
    entryCount: row.entry_count,
    truncated: row.truncated === 1,
    createdAt: row.created_at,
    entries,
  }
}
