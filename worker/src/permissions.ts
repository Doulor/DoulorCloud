/**
 * 按功能维度的权限控制。
 *
 * 管理员在创建邀请码时勾选「该码注册出的账号能用哪些功能」，
 * 也可在成员详情里单独调整某个用户的权限。
 *
 * 存储：users.permissions / invite_codes.permissions 都是 JSON 文本，
 * 形如 {"r2":true,"ai":true,"frp":false}。
 *
 * 向后兼容：字段为 NULL 时视为「全部允许」——
 * 升级前就存在的老用户不会因为新增权限系统而突然失去功能。
 *
 * ⚠️ 个人名片（profile）**不在权限体系内**：它基本不消耗资源，全量开放。
 * 历史数据里可能残留 `"profile": false`，因该键已不在 FEATURES 中，
 * parsePermissions 会直接忽略它 —— 即存量用户自动获得完整名片功能。
 */
import { ApiError } from "./http"
import { getSetting } from "./settings"
import type { Env } from "./env"

export const FEATURES = ["r2", "ai", "frp", "proxy"] as const
export type Feature = (typeof FEATURES)[number]

export const FEATURE_LABELS: Record<Feature, string> = {
  r2: "直链网盘",
  ai: "AI 中转站",
  frp: "内网穿透",
  proxy: "代理节点",
}

export type Permissions = Record<Feature, boolean>

/** 全开（老数据 / 未指定时的默认值） */
export function allPermissions(): Permissions {
  return { r2: true, ai: true, frp: true, proxy: true }
}

/** 解析权限 JSON；NULL / 非法值按「全开」处理 */
export function parsePermissions(raw: string | null | undefined): Permissions {
  if (!raw) return allPermissions()
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed !== "object" || parsed === null) return allPermissions()
    const result = allPermissions()
    for (const f of FEATURES) {
      // 只在该键确实存在时覆盖，缺失的键保持「允许」
      if (typeof parsed[f] === "boolean") result[f] = parsed[f] as boolean
    }
    return result
  } catch {
    return allPermissions()
  }
}

/** 规范化前端传来的权限对象（只保留已知 feature） */
export function normalizePermissions(input: unknown): Permissions {
  const base = allPermissions()
  if (typeof input !== "object" || input === null) return base
  const obj = input as Record<string, unknown>
  for (const f of FEATURES) {
    if (typeof obj[f] === "boolean") base[f] = obj[f] as boolean
  }
  return base
}

export function hasFeature(
  permissions: Permissions,
  feature: Feature
): boolean {
  return permissions[feature] === true
}

/**
 * 解析 open_features（逗号分隔的模块名列表）。
 * 非法值直接忽略（不信任历史数据）；全部非法或为空 → 空集 = 都不放行。
 */
export function parseOpenFeatures(raw: string | null | undefined): Set<Feature> {
  const out = new Set<Feature>()
  for (const seg of String(raw ?? "").split(",")) {
    const f = seg.trim() as Feature
    if ((FEATURES as readonly string[]).includes(f)) out.add(f)
  }
  return out
}

/**
 * 某模块当前是否被设为「免权限访问」—— 设置后不再要求用户权限，
 * 没有权限的人也能访问/启用（管理面板「免权限访问」卡片）。
 *
 * 只在权限校验**失败**时才被调用（见 auth.ts 的 requireFeatureUser），
 * 因此有权限的用户走不到这里，不会产生额外的 D1 读。
 */
export async function isFeatureOpen(env: Env, feature: Feature): Promise<boolean> {
  return parseOpenFeatures(await getSetting(env, "open_features")).has(feature)
}

/**
 * 要求当前用户具备某功能权限，否则 403。
 * 不信任前端——所有涉及该功能的接口都必须先过这里。
 */
export function requireFeature(
  permissions: Permissions,
  feature: Feature
): void {
  if (!hasFeature(permissions, feature)) {
    throw new ApiError(
      403,
      `你的账号未被授予「${FEATURE_LABELS[feature]}」权限，请联系管理员`,
      "FEATURE_NOT_PERMITTED"
    )
  }
}

/** 便捷：从用户行取权限 */
export function userPermissions(user: {
  permissions?: string | null
}): Permissions {
  return parsePermissions(user.permissions)
}