/**
 * 管理面板 → 用户列表批量封禁 / 解封（2026-10-08）。
 *
 * 入口：用户列表点「编辑」→ 出现行勾选框 → 勾选若干用户 → 「封禁」/「解封」。
 *
 * 三条硬约束：
 *   1. **每个用户的联动与单人编辑完全同一条路**（applyUserStatusChange）——
 *      封禁要连带停用 DNS/子域名、拉黑注册 IP、同步 NewAPI，另写一份必然漂移。
 *   2. **先校验再动手**：白名单用户、root 账户、参数问题都在应用之前拦住，
 *      不会出现「封了一半才发现第 3 个是白名单」的半截状态。
 *   3. **单次上限 90 人** —— 不只是防呆：D1 单条语句的绑定参数上限是 100，
 *      留出余量。真要大范围处置应该走监管模块，不是在用户列表里圈人。
 */
import { ApiError, json } from "../http"
import { requireAdminScope, applyUserStatusChange } from "./admin"
import { isUsernameWhitelisted } from "./moderation-lists"
import { audit as recordAudit } from "../settings"
import type { Env } from "../env"

/** 单次最多多少个用户（D1 绑定参数上限 100，留余量） */
const MAX_BATCH = 90

/** POST /api/admin/users/bulk-status —— 批量封禁 / 解封 */
export async function bulkSetUserStatus(env: Env, request: Request): Promise<Response> {
  const operator = await requireAdminScope(env, request, "users.suspend")

  const body = (await request.json().catch(() => ({}))) as {
    userIds?: unknown
    action?: unknown
    reason?: unknown
  }

  // ---- 参数 ----
  const ids = Array.isArray(body.userIds)
    ? Array.from(
        new Set(
          body.userIds.filter((v): v is string => typeof v === "string" && v.length > 0)
        )
      )
    : []
  if (ids.length === 0) throw new ApiError(400, "请先勾选用户", "NO_USERS")
  if (ids.length > MAX_BATCH) {
    throw new ApiError(400, `单次最多 ${MAX_BATCH} 个用户`, "TOO_MANY_USERS")
  }

  const action = body.action === "suspend" || body.action === "unsuspend" ? body.action : null
  if (!action) throw new ApiError(400, "未知的操作", "INVALID_ACTION")
  const next = action === "suspend" ? ("suspended" as const) : ("active" as const)

  // 批量封禁必须写原因：影响面比单人大，「为什么封」更要留痕
  // （用户在登录页会看到，写清楚能少一半申诉）。
  const reason =
    action === "suspend" ? String(body.reason ?? "").trim().slice(0, 300) : null
  if (action === "suspend" && !reason) {
    throw new ApiError(400, "批量封禁必须填写原因（用户登录时会看到）", "REASON_REQUIRED")
  }

  // ---- 目标用户（一次查完，顺带拿 role/status 做前置校验）----
  const placeholders = ids.map(() => "?").join(",")
  const rows = await env.DB.prepare(
    `SELECT id, username, role, status FROM users WHERE id IN (${placeholders})`
  )
    .bind(...ids)
    .all<{ id: string; username: string; role: string; status: string }>()
  const targets = rows.results ?? []
  if (targets.length === 0) throw new ApiError(404, "选中的用户不存在", "NOT_FOUND")

  // ---- 应用前校验：任何一个不满足就整体拒绝（不做半截）----
  // root 账户：与单人编辑同口径 —— 非 root 操作者动不了 root
  const rootTargets = targets.filter((t) => t.role === "root")
  if (rootTargets.length > 0 && operator.role !== "root") {
    throw new ApiError(
      403,
      `站长账户不可被批量操作：${rootTargets.map((t) => t.username).join("、")}`,
      "FORBIDDEN"
    )
  }
  // 白名单用户不会被封禁（解封不受限）
  if (action === "suspend") {
    const whitelisted: string[] = []
    for (const t of targets) {
      if (await isUsernameWhitelisted(env, t.username)) whitelisted.push(t.username)
    }
    if (whitelisted.length > 0) {
      throw new ApiError(
        400,
        `以下用户在白名单里，不会被封禁（如需封禁请先从白名单移除）：${whitelisted.join("、")}`,
        "USER_WHITELISTED"
      )
    }
  }

  // ---- 逐个应用（复用单人链路的全部联动）----
  let updated = 0
  let skipped = 0
  for (const t of targets) {
    const changed = await applyUserStatusChange(env, operator, t, next, reason, request)
    if (changed) updated++
    else skipped++ // 状态本来就是目标值
  }

  // 批量操作本身留一条总账（每个用户的联动审计由 applyUserStatusChange 按目标记）
  await recordBulkAudit(env, operator.username, targets, action, reason, updated, skipped)

  return json({
    ok: true,
    action,
    updated,
    skipped,
    /** 操作涉及的用户名（前端 toast 里可以展示前几个） */
    usernames: targets.map((t) => t.username),
  })
}

/** 批量操作的总账审计：每个用户的联动审计由 applyUserStatusChange 按目标记，
 *  这里再补一条批次总账（user_id 记第一个目标，detail 写全名单与原因） */
async function recordBulkAudit(
  env: Env,
  operatorName: string,
  targets: { id: string; username: string }[],
  action: "suspend" | "unsuspend",
  reason: string | null,
  updated: number,
  skipped: number
): Promise<void> {
  const names = targets.map((t) => t.username).join("、")
  await recordAudit(
    env,
    targets[0]?.id ?? null,
    action === "suspend" ? "admin.user.bulk_suspend" : "admin.user.bulk_unsuspend",
    `管理员 ${operatorName} 批量${action === "suspend" ? "封禁" : "解封"} ${targets.length} 个用户` +
      `（生效 ${updated}，跳过 ${skipped}）：${names.slice(0, 200)}` +
      (action === "suspend" && reason ? `；原因：${reason}` : "")
  )
}
