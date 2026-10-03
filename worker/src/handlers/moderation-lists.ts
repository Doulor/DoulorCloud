/**
 * 监管 · 白名单 / 自动条件 / 黑名单（2026-10-03 站长要求）
 *
 * 需求原话拆解：
 *   · 白名单里的用户**不会被封禁**；
 *   · 白名单支持手动添加，也支持**按条件自动加入**（可多个条件，如「成就点 > 30」），
 *     条件开着就自动进、关掉就自动退出；
 *   · 列表按来源分组展示（「手动添加白名单: …」「成就点大于 20 用户白名单: …」）；
 *   · 黑名单主要针对 IP，内置一条默认条件：**账号被封禁时它的注册 IP 自动进黑名单**。
 *
 * 数据表见 migrations/0106_moderation_lists.sql。
 *
 * ⚠️ 成就点是**实时算的、不落库**（见 handlers/achievements.ts 顶部说明），
 *    所以条件同步要复用 `loadAllUserCounts` + `achievementPointsOf`
 *    —— 与排行榜、成就页同一口径，否则同一个人在三处显示的点数会不一样。
 */
import { ApiError, json } from "../http"
import { requireAdmin } from "./admin"
import { uuid } from "../crypto"
import { clientIp } from "../ratelimit"
import { audit } from "../settings"
import { achievementPointsOf, loadAllUserCounts } from "./achievements"
import type { Env } from "../env"

export type ConditionMetric = "achievement_points"
export type ConditionOp = "gt" | "gte" | "lt" | "lte"

const OPS: Record<ConditionOp, (a: number, b: number) => boolean> = {
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
}

interface ConditionRow {
  id: string
  metric: string
  op: string
  value: number
  enabled: number
  created_at: string
}

/**
 * 算出每个**启用中**的条件命中的用户（含成就点，用于界面展示）。
 * 每个用户只归入**第一个**命中的条件 —— whitelist 表 username 有唯一索引，
 * 一个人只能挂在一个来源下；否则关掉 A 条件时他会「消失」而不是落到 B。
 */
async function evaluateConditions(
  env: Env
): Promise<Map<string, { username: string; points: number }[]>> {
  const conds = await env.DB.prepare(
    "SELECT id, metric, op, value, enabled, created_at FROM moderation_conditions ORDER BY created_at ASC"
  ).all<ConditionRow>()
  const enabled = (conds.results ?? []).filter((c) => Number(c.enabled) === 1 && OPS[c.op as ConditionOp])
  const out = new Map<string, { username: string; points: number }[]>()
  for (const c of enabled) out.set(c.id, [])
  if (enabled.length === 0) return out

  // 只有「成就点」一种指标，所以统一先算一遍全员成就点
  const counts = await loadAllUserCounts(env)
  const histRows = await env.DB.prepare(
    "SELECT user_id, achievement_id, MAX(level) AS lv FROM user_achievements GROUP BY user_id, achievement_id"
  ).all<{ user_id: string; achievement_id: string; lv: number }>()
  const histByUser = new Map<string, Map<string, number>>()
  for (const r of histRows.results ?? []) {
    if (!histByUser.has(r.user_id)) histByUser.set(r.user_id, new Map())
    histByUser.get(r.user_id)!.set(r.achievement_id, r.lv)
  }

  for (const c of counts) {
    const points = achievementPointsOf(c, histByUser.get(c.uid) ?? new Map())
    for (const cond of enabled) {
      if (OPS[cond.op as ConditionOp](points, cond.value)) {
        out.get(cond.id)!.push({ username: c.username, points })
        break
      }
    }
  }
  return out
}

/**
 * 按当前条件把 `moderation_whitelist` 里的 auto 行同步到「应有的样子」：
 *   · 命中的用户补进来（手动加过的跳过，手动优先）；
 *   · 不再命中 / 条件已关 / 条件已删 的 auto 行删掉。
 * 站点是 1241 个用户量级，`loadAllUserCounts` 实测 ~9ms（见 achievements.ts 注释），
 * 所以直接在读取列表时同步即可，不必上定时任务。
 */
async function syncWhitelist(env: Env): Promise<void> {
  const matched = await evaluateConditions(env)

  const manualRows = await env.DB.prepare(
    "SELECT username FROM moderation_whitelist WHERE source = 'manual'"
  ).all<{ username: string }>()
  const manualSet = new Set((manualRows.results ?? []).map((r) => r.username))

  const desired = new Map<string, string>() // username -> conditionId
  for (const [cid, users] of matched) {
    for (const u of users) {
      if (manualSet.has(u.username)) continue
      if (!desired.has(u.username)) desired.set(u.username, cid)
    }
  }

  const autoRows = await env.DB.prepare(
    "SELECT id, username, condition_id FROM moderation_whitelist WHERE source = 'auto'"
  ).all<{ id: string; username: string; condition_id: string | null }>()
  const existing = new Map((autoRows.results ?? []).map((r) => [r.username, r]))

  const now = new Date().toISOString()
  const stmts: D1PreparedStatement[] = []
  // 退出
  for (const row of autoRows.results ?? []) {
    if (!desired.has(row.username)) {
      stmts.push(env.DB.prepare("DELETE FROM moderation_whitelist WHERE id = ?").bind(row.id))
    }
  }
  // 进入 / 来源条件变化
  for (const [username, cid] of desired) {
    const row = existing.get(username)
    if (!row) {
      stmts.push(
        env.DB.prepare(
          "INSERT OR IGNORE INTO moderation_whitelist (id, username, source, condition_id, created_at) VALUES (?, ?, 'auto', ?, ?)"
        ).bind(uuid(), username, cid, now)
      )
    } else if (row.condition_id !== cid) {
      stmts.push(
        env.DB.prepare("UPDATE moderation_whitelist SET condition_id = ? WHERE id = ?").bind(cid, row.id)
      )
    }
  }
  if (stmts.length) await env.DB.batch(stmts)
}

// ---------------------------------------------------------------------------
// 供封禁 / 注册流程调用的工具
// ---------------------------------------------------------------------------

/** 用户名是否在白名单里（不分来源）。用户不存在或表未建好时都返回 false。 */
export async function isUsernameWhitelisted(env: Env, username: string): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      "SELECT 1 AS x FROM moderation_whitelist WHERE username = ? COLLATE NOCASE LIMIT 1"
    )
      .bind(username)
      .first<{ x: number }>()
    return !!row
  } catch (err) {
    // 表没建好时**不能**让封禁流程挂掉：退化成「没有白名单」
    console.error("白名单查询失败:", err)
    return false
  }
}

/** IP 是否在黑名单里。表未建好时退化为 false（宁可放行，也别把注册全挡了）。 */
export async function isIpBlacklisted(env: Env, ip: string): Promise<boolean> {
  if (!ip) return false
  try {
    const row = await env.DB.prepare(
      "SELECT 1 AS x FROM moderation_blacklist WHERE ip = ? LIMIT 1"
    )
      .bind(ip)
      .first<{ x: number }>()
    return !!row
  } catch (err) {
    console.error("黑名单查询失败:", err)
    return false
  }
}

/** 把 IP 加入黑名单（已存在则忽略）。source=auto 表示来自封禁联动。 */
export async function addIpToBlacklist(
  env: Env,
  ip: string,
  reason: string,
  source: "manual" | "auto" = "auto"
): Promise<void> {
  if (!ip) return
  try {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO moderation_blacklist (id, ip, source, reason, created_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(uuid(), ip, source, reason.slice(0, 200), new Date().toISOString())
      .run()
  } catch (err) {
    console.error("写黑名单失败:", err)
  }
}

// ---------------------------------------------------------------------------
// HTTP 接口
// ---------------------------------------------------------------------------

/** GET /api/admin/moderation/lists —— 白名单（按来源分组）+ 黑名单 */
export async function listModerationLists(env: Env, request: Request): Promise<Response> {
  await requireAdmin(env, request)
  await syncWhitelist(env)

  const [conds, wl, bl] = await Promise.all([
    env.DB.prepare(
      "SELECT id, metric, op, value, enabled, created_at FROM moderation_conditions ORDER BY created_at ASC"
    ).all<ConditionRow>(),
    env.DB.prepare(
      // 带上昵称（和「自定义称号」面板一样显示「昵称 @用户名」）；
      // username 用 COLLATE NOCASE 关联，避免大小写不同导致昵称取不到
      `SELECT w.username, w.source, w.condition_id, u.nickname AS nickname
         FROM moderation_whitelist w
         LEFT JOIN users u ON u.username = w.username COLLATE NOCASE`
    ).all<{
      username: string
      source: string
      condition_id: string | null
      nickname: string | null
    }>(),
    env.DB.prepare(
      "SELECT ip, source, reason, created_at FROM moderation_blacklist ORDER BY created_at DESC"
    ).all<{ ip: string; source: string; reason: string | null; created_at: string }>(),
  ])

  const wlRows = wl.results ?? []
  /** 展示用：昵称优先，没设昵称就退回用户名（与「自定义称号」面板一致） */
  const asUser = (r: { username: string; nickname: string | null }) => ({
    username: r.username,
    nickname: r.nickname,
  })

  const manual = wlRows
    .filter((r) => r.source === "manual")
    .map(asUser)
    .sort((a, b) => a.username.localeCompare(b.username))

  const groups = (conds.results ?? []).map((c) => ({
    id: c.id,
    metric: c.metric as ConditionMetric,
    op: c.op as ConditionOp,
    value: c.value,
    enabled: Number(c.enabled) === 1,
    users: wlRows
      .filter((r) => r.source === "auto" && r.condition_id === c.id)
      .map(asUser)
      .sort((a, b) => a.username.localeCompare(b.username)),
  }))

  const blRows = bl.results ?? []
  return json({
    whitelist: { manual, groups },
    blacklist: {
      manual: blRows
        .filter((r) => r.source === "manual")
        .map((r) => ({ ip: r.ip, reason: r.reason, createdAt: r.created_at })),
      auto: blRows
        .filter((r) => r.source !== "manual")
        .map((r) => ({ ip: r.ip, reason: r.reason, createdAt: r.created_at })),
    },
  })
}

/** POST /api/admin/moderation/whitelist —— { action: "add" | "remove", username } */
export async function updateWhitelist(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdmin(env, request)
  const body = (await request.json()) as { action?: string; username?: string }
  const username = String(body.username ?? "").trim()
  if (!username) throw new ApiError(400, "请填写用户名", "INVALID_INPUT")

  if (body.action === "remove") {
    await env.DB.prepare(
      "DELETE FROM moderation_whitelist WHERE username = ? COLLATE NOCASE"
    )
      .bind(username)
      .run()
    await audit(env, admin.id, "moderation.whitelist.remove", `移除白名单：${username}`, clientIp(request))
    return json({ ok: true })
  }

  if (body.action !== "add") throw new ApiError(400, "未知操作", "INVALID_INPUT")

  // 校验用户确实存在（写错名字会让白名单形同虚设，还难排查）
  const user = await env.DB.prepare(
    "SELECT username FROM users WHERE username = ? COLLATE NOCASE"
  )
    .bind(username)
    .first<{ username: string }>()
  if (!user) throw new ApiError(404, "没有这个用户", "USER_NOT_FOUND")

  // 已在条件命中的 auto 行上时，手动添加要**升级**为 manual（手动优先，条件关掉也不退出）
  await env.DB.prepare("DELETE FROM moderation_whitelist WHERE username = ? COLLATE NOCASE")
    .bind(user.username)
    .run()
  await env.DB.prepare(
    "INSERT INTO moderation_whitelist (id, username, source, condition_id, created_at) VALUES (?, ?, 'manual', NULL, ?)"
  )
    .bind(uuid(), user.username, new Date().toISOString())
    .run()
  await audit(env, admin.id, "moderation.whitelist.add", `加入白名单：${user.username}`, clientIp(request))
  return json({ ok: true })
}

/** POST /api/admin/moderation/conditions —— { action: "create" | "toggle" | "delete", ... } */
export async function updateConditions(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdmin(env, request)
  const body = (await request.json()) as {
    action?: string
    id?: string
    metric?: string
    op?: string
    value?: number
    enabled?: boolean
  }

  if (body.action === "create") {
    const metric = String(body.metric ?? "achievement_points")
    const op = String(body.op ?? "gt") as ConditionOp
    const value = Math.trunc(Number(body.value))
    if (metric !== "achievement_points") throw new ApiError(400, "暂不支持该条件类型", "INVALID_INPUT")
    if (!OPS[op]) throw new ApiError(400, "比较方式不合法", "INVALID_INPUT")
    if (!Number.isFinite(value) || value < 0) throw new ApiError(400, "数值需为不小于 0 的整数", "INVALID_INPUT")

    await env.DB.prepare(
      "INSERT INTO moderation_conditions (id, metric, op, value, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)"
    )
      .bind(uuid(), metric, op, value, new Date().toISOString())
      .run()
    await audit(env, admin.id, "moderation.condition.create", `新增白名单条件：${metric} ${op} ${value}`, clientIp(request))
    await syncWhitelist(env)
    return json({ ok: true })
  }

  const id = String(body.id ?? "")
  if (!id) throw new ApiError(400, "缺少条件 id", "INVALID_INPUT")

  if (body.action === "toggle") {
    await env.DB.prepare("UPDATE moderation_conditions SET enabled = ? WHERE id = ?")
      .bind(body.enabled ? 1 : 0, id)
      .run()
    await audit(
      env,
      admin.id,
      "moderation.condition.toggle",
      `${body.enabled ? "启用" : "停用"}白名单条件：${id}`,
      clientIp(request)
    )
    await syncWhitelist(env)
    return json({ ok: true })
  }

  if (body.action === "delete") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM moderation_whitelist WHERE condition_id = ?").bind(id),
      env.DB.prepare("DELETE FROM moderation_conditions WHERE id = ?").bind(id),
    ])
    await audit(env, admin.id, "moderation.condition.delete", `删除白名单条件：${id}`, clientIp(request))
    await syncWhitelist(env)
    return json({ ok: true })
  }

  throw new ApiError(400, "未知操作", "INVALID_INPUT")
}

/** POST /api/admin/moderation/blacklist —— { action: "add" | "remove", ip, reason? } */
export async function updateBlacklist(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdmin(env, request)
  const body = (await request.json()) as { action?: string; ip?: string; reason?: string }
  const ip = String(body.ip ?? "").trim()
  if (!ip) throw new ApiError(400, "请填写 IP", "INVALID_INPUT")
  if (ip.length > 64) throw new ApiError(400, "IP 过长", "INVALID_INPUT")

  if (body.action === "remove") {
    await env.DB.prepare("DELETE FROM moderation_blacklist WHERE ip = ?").bind(ip).run()
    await audit(env, admin.id, "moderation.blacklist.remove", `移除黑名单：${ip}`, clientIp(request))
    return json({ ok: true })
  }

  if (body.action !== "add") throw new ApiError(400, "未知操作", "INVALID_INPUT")

  const reason = String(body.reason ?? "").trim()
  await env.DB.prepare(
    "INSERT OR REPLACE INTO moderation_blacklist (id, ip, source, reason, created_at) VALUES (?, ?, 'manual', ?, ?)"
  )
    .bind(uuid(), ip, reason.slice(0, 200), new Date().toISOString())
    .run()
  await audit(env, admin.id, "moderation.blacklist.add", `加入黑名单：${ip}`, clientIp(request))
  return json({ ok: true })
}
