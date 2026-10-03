/**
 * 管理面板「API」板块的后端：功能开关 + 各层级限额 + 「计入成就」开关。
 *
 * 与 `public-api.ts` 的分工：
 *   · 这里管**配置**（管理员读写 api_config 表）；
 *   · 那边管**执行**（用户用 Key 调用，读同一张表做限额判断）。
 * 读写同一份数据，但权限不同（这里要 admin，那边要 API Key）。
 */
import { json } from "../http"
import { requireAdmin } from "./admin"
import { listApiFeatures } from "../api-engine"
import { getSettingBool } from "../settings"
import type { Env } from "../env"

/** 功能清单：固定这三类（以后加功能在这里登记） */
const KNOWN_FEATURES = ["dns", "mailbox", "temp_mailbox"] as const

/** GET /api/admin/api-config —— 读全部功能配置 + 计入成就开关 */
export async function getApiConfig(env: Env, request: Request): Promise<Response> {
  await requireAdmin(env, request)
  const features = await listApiFeatures(env)
  return json({
    features,
    countAchievements: await getSettingBool(env, "api_count_achievements"),
  })
}

/**
 * POST /api/admin/api-config —— 整体保存。
 *
 * body: `{ countAchievements, features: [{ feature, enabled, tierLimits: number[], ipLimit }] }`
 *
 * 白名单校验：只接受 `KNOWN_FEATURES` 里的 feature，未知的直接忽略
 * （防止前端被篡改后往表里塞脏功能）。
 */
export async function saveApiConfig(env: Env, request: Request): Promise<Response> {
  await requireAdmin(env, request)
  const body = (await request.json().catch(() => ({}))) as {
    countAchievements?: boolean
    features?: {
      feature?: string
      enabled?: boolean
      tierLimits?: number[]
      ipLimit?: number
    }[]
  }

  const stmts: ReturnType<typeof env.DB.prepare>[] = []
  const seen = new Set<string>()
  for (const f of body.features ?? []) {
    const feature = String(f.feature ?? "").trim()
    if (!feature || !(KNOWN_FEATURES as readonly string[]).includes(feature)) continue
    if (seen.has(feature)) continue
    seen.add(feature)
    // 层级限额：非负整数，上限 32 项，超出截断
    const tierLimits = (Array.isArray(f.tierLimits) ? f.tierLimits : [])
      .map((v) => Math.max(0, Math.floor(Number(v)) || 0))
      .slice(0, 32)
    const ipLimit = Math.max(0, Math.floor(Number(f.ipLimit)) || 0)
    stmts.push(
      env.DB.prepare(
        `UPDATE api_config SET enabled = ?, tier_limits = ?, ip_limit = ? WHERE feature = ?`
      ).bind(f.enabled ? 1 : 0, JSON.stringify(tierLimits), ipLimit, feature)
    )
  }

  // 「计入成就」开关走 app_settings（布尔，走统一归一化）
  if (typeof body.countAchievements === "boolean") {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ('api_count_achievements', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).bind(body.countAchievements ? "1" : "0", new Date().toISOString())
    )
  }

  if (stmts.length > 0) await env.DB.batch(stmts)
  return json({ ok: true })
}
