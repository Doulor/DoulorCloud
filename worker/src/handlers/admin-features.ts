/**
 * 管理面板 → 功能开关（2026-11-16）。
 *
 * 站长需求原话：「关闭不只是关闭入口，关键是关闭整个功能，以及其对应的功能消耗。」
 * 所以这里的写操作不是「改一个前端开关」，而是改 `features.ts` 注册表里那个
 * **后端守卫真正读取的** `app_settings` 键 —— 改完立刻：
 *   · 该功能所有 HTTP 入口 403 FEATURE_DISABLED（index.ts 的 route()）
 *   · 公开资源入口（直链/名片/社区图/TG webhook…）同样被拦
 *   · 对应后台定时任务跳过（index.ts 的 scheduled）
 *
 * 三条设计约束：
 *   1. **只允许改注册表里登记过的 id** —— 前端传来的任意 key 一律丢弃，
 *      否则等于给了「往 app_settings 里写任意键」的口子。
 *   2. **写库走 updateSettings**（只接受 SETTING_DEFAULTS 里有的键），
 *      并且改完立刻 `invalidateFeatureStates()`，否则同 isolate 要等 10 秒 TTL，
 *      管理员会以为「点了没反应」。
 *   3. **每条变更都写审计**（含关/开两个方向）—— 这类操作影响全站，
 *      出问题时要能查到「谁在什么时候关了什么」。
 */
import { ApiError, json } from "../http"
import { requireAdminScope } from "./admin"
import { updateSettings, audit } from "../settings"
import {
  FEATURE_DEFS,
  FEATURE_GROUPS,
  featureById,
  getFeatureStates,
  invalidateFeatureStates,
  type FeatureDef,
} from "../features"
import type { Env } from "../env"

/** 单个功能对外的形状（管理端） */
function publicDef(f: FeatureDef, states: Record<string, boolean>) {
  return {
    id: f.id,
    label: f.label,
    group: f.group,
    settingKey: f.settingKey,
    impact: f.impact,
    costHint: f.costHint,
    enabled: states[f.id] !== false,
    /** 这条开关会拦下多少个接口前缀（给管理员一个「关掉影响面」的直观数字） */
    routeCount: f.routes.length,
    /** 关掉后会停掉几个后台任务 */
    jobCount: f.jobs?.length ?? 0,
  }
}

/**
 * GET /api/admin/features —— 功能开关总览。
 *
 * 返回**全部**功能（含已关闭的），分组交给前端渲染；同时回 `groups` 定义，
 * 这样前端不硬编码分组顺序（与权限树同一思路）。
 */
export async function listFeatureSwitches(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "features")
  const states = await getFeatureStates(env)
  return json({
    groups: FEATURE_GROUPS,
    features: FEATURE_DEFS.map((f) => publicDef(f, states)),
    /** 服务端时间：前端可据此判断「刚保存过」 */
    at: new Date().toISOString(),
  })
}

/**
 * PUT /api/admin/features —— 批量开关。
 *
 * body: `{ updates: { [featureId]: boolean }, note?: string }`
 *
 * 为什么是批量：管理员经常要「一次性关掉三四个省额度的功能」，
 * 一个一个保存会写四次审计、发四次请求，而且中间态可能让用户看到半关的站。
 * 批量写入用同一个 batch 落库（updateSettings 内部就是 batch）。
 */
export async function updateFeatureSwitches(env: Env, request: Request): Promise<Response> {
  const admin = await requireAdminScope(env, request, "features")

  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw new ApiError(400, "请求体不是合法 JSON", "INVALID_INPUT")
  }
  if (!body || typeof body !== "object") {
    throw new ApiError(400, "请求体格式错误", "INVALID_INPUT")
  }
  const updates = (body as { updates?: unknown }).updates
  if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
    throw new ApiError(400, "updates 必须是 { 功能id: true/false }", "INVALID_INPUT")
  }

  const values: Record<string, string> = {}
  const changed: { id: string; label: string; enabled: boolean }[] = []
  for (const [id, raw] of Object.entries(updates as Record<string, unknown>)) {
    const def = featureById(id)
    if (!def) throw new ApiError(400, `未登记的功能 id：${id}`, "UNKNOWN_FEATURE")
    if (typeof raw !== "boolean") {
      throw new ApiError(400, `功能 ${id} 的开关值必须是布尔`, "INVALID_INPUT")
    }
    values[def.settingKey] = raw ? "1" : "0"
    changed.push({ id: def.id, label: def.label, enabled: raw })
  }
  if (changed.length === 0) {
    throw new ApiError(400, "没有要更新的开关", "INVALID_INPUT")
  }

  await updateSettings(env, values)
  // 立刻失效：同一个 isolate 的下一个请求就会按新状态拦截
  invalidateFeatureStates()

  const note = typeof (body as { note?: unknown }).note === "string"
    ? String((body as { note?: unknown }).note).slice(0, 120)
    : ""
  await audit(
    env,
    admin.id,
    "admin.features.update",
    changed.map((c) => `${c.id}=${c.enabled ? "on" : "off"}`).join(", ") + (note ? ` | ${note}` : ""),
    request.headers.get("CF-Connecting-IP")
  )

  const states = await getFeatureStates(env)
  return json({
    ok: true,
    changed,
    features: FEATURE_DEFS.map((f) => publicDef(f, states)),
  })
}

/**
 * GET /api/features —— 公开的「哪些功能被关了」。
 *
 * 前端用它：① 侧边栏/页面入口按这个隐藏；② 轮询 hook 据此停止（省额度）。
 * 只回**状态表**，不含 impact/成本等管理端信息；也不需要登录（未登录访客
 * 同样要看到「该功能已关闭」，而不是点了才 403）。
 *
 * ⚠️ 这里刻意**不做**「只返回关闭项」的裁剪：前端要按 id 判断，
 * 缺项会让「新增功能」时前端默认当成关闭（保守但错误）。
 */
export async function publicFeatureStates(env: Env, _request: Request): Promise<Response> {
  const states = await getFeatureStates(env)
  return json({ states, at: new Date().toISOString() })
}
