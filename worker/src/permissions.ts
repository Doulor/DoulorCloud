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

export const FEATURES = ["r2", "ai", "frp", "proxy", "doulor"] as const
export type Feature = (typeof FEATURES)[number]

export const FEATURE_LABELS: Record<Feature, string> = {
  r2: "直链网盘",
  ai: "AI 中转站",
  frp: "内网穿透",
  proxy: "代理节点",
  doulor: "doulor.cn 专属域名与邮箱",
}

export type Permissions = Record<Feature, boolean>

/**
 * 「缺键即允许」的模块 —— 老数据 / 权限 JSON 里没写这个键时的回落值。
 *
 * ⚠️ 这**不是** FEATURES 的副本，两者必须分开维护。
 * 原因：`parsePermissions` 对 JSON 里**没有出现的键**是按 `allPermissions()`
 * 兜底的（历史兼容：权限系统上线前的老用户不能突然失去功能）。所以任何
 * 「新增时必须默认关闭」的权限**绝不能**进这个列表 —— 进了就等于给所有
 * 存量用户、以及所有显式 JSON 里缺这个键的新账号**白送**。
 *
 * `doulor`（doulor.cn 专属域）正是这种：
 *   doulor.cn 是站点主域，用户的邮箱与子域名挂上去会把滥用风险引到主域声誉上，
 *   而主域同时承担「给用户发验证码 / 找回密码」的发件人角色。
 *   站长明确要求先「只定义、不放开」⇒ 它的默认值必须是 false，
 *   只能由管理员在成员详情里显式勾选。
 */
export const DEFAULT_ALLOWED: readonly Feature[] = ["r2", "ai", "frp", "proxy"]

/** 默认权限（“全开”指 DEFAULT_ALLOWED 里的那些；doulor 不在其中） */
export function allPermissions(): Permissions {
  const out = {} as Permissions
  for (const f of FEATURES) out[f] = DEFAULT_ALLOWED.includes(f)
  return out
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

/**
 * 由「允许的模块集合」构造**显式**权限对象（缺失的键一律 false）。
 *
 * 为什么要它：`parsePermissions` 把 NULL 当「全部允许」，所以任何「新账号默认权限」
 * 的场景（开放注册等）都**不能**写 NULL —— 那会让新号白拿 AI/frp/proxy。
 * 用本函数把「默认邀请码的那套权限」显式落成 `{"r2":true,"ai":false,...}`，
 * 语义明确、与 NULL 划清界限。
 */
export function permissionsFromFeatures(enabled: ReadonlySet<string>): Permissions {
  const out = {} as Permissions
  for (const f of FEATURES) out[f] = enabled.has(f)
  return out
}

/**
 * 该邀请码是否**不含任何额外权限** —— 即它授予的模块全部落在 `basic`
 * （`invite_basic_features`：管理员当前设为基础权限的模块）之内。
 *
 * 用途：**限时开放注册期间，这类码不消耗使用次数**（可无限重复使用）。
 * 理由：开放期人人免码即可注册，拿一条普通码去注册并不会多拿到任何东西，
 * 再把它烧掉只是白白浪费分享者的邀请码额度（`max_uses = 1` 的码被用一次就废）。
 *
 * ⚠️ 判定必须**极保守**：宁可判成「带权限」（照旧消费、次数照扣），
 * 也绝不能误判成「无权限」，否则一条码就能无限量发放 AI/frp/proxy。
 * 三道防线，缺一不可：
 *   1. `raw` 必须是**合法 JSON 对象** —— NULL / 损坏 JSON 在 parsePermissions 里
 *      等于「全部允许」（老数据兼容），当成「无权限」= 白送四个模块；
 *   2. 四个键必须**都显式写成布尔** —— 缺键同样是「允许」，连 `{}` 都会膨胀成
 *      「全开」；
 *   3. 只有「显式为 true 且**不在** basic 里」的模块才算「带权限」。
 *
 * 对照线上数据：用户自助创建的码一律是 `JSON.stringify(perms)`（四个键齐全），
 * 管理员建的码可能带历史遗留的 `profile` 键（多出的键不影响判定，一律忽略）。
 */
export function isBasicOnlyInvitePermissions(
  raw: string | null | undefined,
  basic: ReadonlySet<string>
): boolean {
  if (!raw) return false

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return false
  }

  const obj = parsed as Record<string, unknown>
  for (const f of FEATURES) {
    const v = obj[f]
    if (typeof v === "boolean") {
      if (v === true && !basic.has(f)) return false
      continue
    }
    // 缺键 / 非布尔：parsePermissions 会回落到 allPermissions()[f]，所以要看那个回落值 ——
    //   · 回落成 **true**（`DEFAULT_ALLOWED` 里的 r2/ai/frp/proxy）⇒ 复用等于白送该模块，
    //     保守判「带权限」（照旧消费次数）。这条不能松，松了就是无限发放。
    //   · 回落成 **false**（`doulor` 这类默认拒绝的）⇒ 缺键并不构成额外权限，
    //     继续往下看。
    //
    // 为什么必须区分（2026-10-01 加 doulor 时踩到）：那时 FEATURES 多了一个键，
    // 而**所有存量邀请码**的 JSON 都没有它 ⇒ 旧码全被判成「带权限」，
    // 在开放注册期被白白烧掉。语义上旧码确实没授予 doulor（那时它还不存在），
    // 所以正确做法是按回落值判，而不是一律保守。
    if (DEFAULT_ALLOWED.includes(f)) return false
  }
  return true
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

/* --------------------------------------------------------------------------
 * 「原子写权限」的 SQL 片段（2026-09-26 审计修复）
 *
 * 背景：全仓原先都是「SELECT permissions → 在 JS 里合并 → 整列写回绝对值」。
 * 两个并发请求（例如同时兑两张券、或一边兑券一边被撤销捐献）会各自基于旧快照
 * 写回，后写的一方把先写方的变更**整列覆盖掉**，已授予的权限被静默抹掉。
 *
 * 下面这些片段用于在单条 UPDATE 里只动目标键（SQLite 单语句原子生效），
 * 从根上消除覆盖。配额类的原子写法见 quotas.ts，思路同源。
 * ----------------------------------------------------------------------- */

/**
 * `users.permissions` 列的 JSON 表达式：NULL / 损坏的 JSON 一律兜底成 `'{}'`。
 *
 * 为什么必须兜底：
 *   · `json_set(NULL, …)` 返回 NULL —— 会把整列直接抹掉；
 *   · `json_extract` 遇到损坏的 JSON 会抛错（表现为线上 500）。
 *
 * 为什么用 `'{}'` 而不是补齐成「全 true」：`parsePermissions` 的口径是
 * **缺失的键 = 允许**，所以 `'{}'` 与 NULL 语义完全等价，可以安全互换。
 */
export const PERMISSIONS_JSON_EXPR =
  "CASE WHEN json_valid(permissions) THEN permissions ELSE '{}' END"

/**
 * 「把某个模块权限置为 value」的 SQL 表达式。
 *
 * `feature` 是编译期的枚举字面量（`FEATURES`），不是用户输入，拼接安全。
 */
export function featurePermissionSql(feature: Feature, value: boolean): string {
  return `json_set(${PERMISSIONS_JSON_EXPR}, '$.${feature}', json('${value ? "true" : "false"}'))`
}

/** 「若干模块一次性置为 true」的 SQL 表达式（嵌套 json_set） */
export function grantFeaturesSql(features: Feature[]): string {
  return features.reduce(
    (expr, f) => `json_set(${expr}, '$.${f}', json('true'))`,
    PERMISSIONS_JSON_EXPR
  )
}

/**
 * 仅用于 `WHERE` 的守卫：该模块**原本已是允许**。
 * 缺失键按「允许」解释，所以用 `COALESCE(..., 1) = 1` 而不是 `= json('true')`。
 */
export function featurePermittedGuard(feature: Feature): string {
  return `COALESCE(json_extract(${PERMISSIONS_JSON_EXPR}, '$.${feature}'), 1) = 1`
}

/** 仅用于 `WHERE` 的守卫：该模块**原本不是允许**（用于「本次是否真的新增授予」判定） */
export function featureNotPermittedGuard(feature: Feature): string {
  return `COALESCE(json_extract(${PERMISSIONS_JSON_EXPR}, '$.${feature}'), 1) != 1`
}

/**
 * 仅用于 `WHERE` 的守卫：该用户**不在监管白名单里**。
 *
 * 用途：所有「收回权限」的 UPDATE 都要带上它。
 *
 * 背景（2026-10-04）：白名单从「各功能自己记得查」升级为**数据库触发器**
 * （见 migrations/0114）—— 一旦用户在白名单里，任何把权限从「允许」改成
 * 「不允许」的写入都会被触发器 ABORT，**包括以后新写的代码路径**。
 * 那保证了「白名单免疫一切处置」，但副作用是：没带这个守卫的回收语句
 * 会直接抛 `SQLITE_CONSTRAINT_TRIGGER`，把一个正常的业务流程打成 500。
 *
 * 所以规约是：**收回权限时必须带本守卫**（带上了就是「静默跳过」：
 * 不改权限、也不报错，与触发器的语义完全一致），触发器只作为兜底。
 *
 * ⚠️ 必须写 `users.username` 全限定：子查询里 `moderation_whitelist` 自己也有
 *    `username` 列，不限定会解析到内层表的列上，守卫恒为 true（等于没写）。
 * ⚠️ 表不存在（迁移未执行）时这里会报 `no such table`，所以 `moderation_whitelist`
 *    必须比用到它的代码先建好（0111 已建）。
 */
export function notWhitelistedGuard(): string {
  return "NOT EXISTS (SELECT 1 FROM moderation_whitelist w WHERE w.username = users.username COLLATE NOCASE)"
}