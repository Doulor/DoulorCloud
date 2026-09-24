/**
 * 全局运行参数（app_settings 表）。
 *
 * 所有可调数值都放在这里，让管理员能在管理面板即时修改而不需要重新部署。
 * 读取失败时回落到默认值，保证功能不会因为配置缺失而完全不可用。
 */
import { uuid } from "./crypto"
import type { Env } from "./env"

export const SETTING_DEFAULTS = {
  /** 新开通网盘的默认配额（字节） */
  storage_quota_bytes: "1073741824", // 1 GiB
  /** 网盘功能总开关 */
  storage_enabled: "1",
  /** 单文件大小上限（字节） */
  storage_max_file_bytes: "104857600", // 100 MiB
  /** AI 中转站总开关 */
  newapi_enabled: "1",
  /** 新开通 AI 账号的试用额度（NewAPI quota 单位，500000 = $1） */
  newapi_trial_quota: "500000",
  /** 新账号所属分组 */
  newapi_group: "default",
  /** 是否给予不限额度（1/0），开启后忽略试用额度 */
  newapi_unlimited_quota: "0",
  /** NewAPI quota 与美元换算：quota_per_unit */
  newapi_quota_per_unit: "500000",
  /**
   * 推荐模型分档（JSON 数组字符串，由管理员在管理面板维护）。
   *
   * 为什么单独放一个设置项而不是硬编码：上游渠道随时增减，模型好坏也随版本变化，
   * 写死在代码里就得每次改代码重新部署。存 JSON 让管理员在面板里随时增删梯队。
   *
   * 形如：
   *   [{"tier":"第一梯队","desc":"综合最强，日常首选","models":["glm-5.2","deepseek-v4-pro"]}]
   * 数组顺序即展示顺序（第一梯队在最上）；模型名不校验是否真实存在 ——
   * 管理员可能预先填好尚未上线的模型名，前端只展示不调用。
   */
  newapi_recommended_models: "[]",
  /** 每个用户默认可创建的一级子域名数量（可被 users.max_subdomains 覆盖） */
  subdomain_quota_default: "5",
  /** 每个用户默认的邀请码创建额度（捐献会额外增加，见 quotas.ts） */
  invite_quota_base: "3",
  /**
   * 各模块在邀请码里是「基础权限」还是「受限模式」。逗号分隔的模块名列表。
   *
   *   基础权限：创建邀请码时可直接勾选，**不消耗模块额度**。
   *   受限模式：需消耗对应模块额度（由捐献获批或管理员发放获得）。
   *
   * 默认只有 r2 是基础权限 —— R2 由站长自持，无人能「捐献」网盘资源，
   * 若纳入额度体系则该额度永远为 0，形成死路。
   * 其余模块（ai/frp/proxy）默认受限，靠捐献获取额度。
   *
   * ⚠️ 这只是**默认值**，不是硬编码：管理员可以把 r2 也改成受限模式
   * （那样就得在管理面板「用户额度」里手动给它发额度）。
   * 空串是合法值，表示「全部受限」—— 解析见 quotas.parseBasicFeatures，
   * 别再把空串当成「没配」而回落默认值。
   */
  invite_basic_features: "r2",
  /**
   * 免权限访问的模块（逗号分隔的模块名列表）。
   *
   * 设置后该模块**不再要求用户权限**，没有权限的人也能访问/启用 ——
   * 用于把某个模块对所有人开放，而不必逐个改用户的 permissions。
   *
   * 空串 = 全部按权限卡（默认）。它只旁路「访问时的权限校验」这一层，
   * 不改 users.permissions，也不影响各模块自己的全局总开关（*_enabled），
   * 与 invite_basic_features（管「建码时能否勾选」）是两件事。
   */
  open_features: "",
  /**
   * 哪些模块的捐献走「自动审核」（逗号分隔的模块名列表）。
   *
   *   - ai：自动探测上游 + 逐个测模型，只留可用的；全不可用则自动拒绝。
   *   - proxy：逐个真实拉取订阅链接，能解析出节点的才导入；全无效则自动拒绝。
   *   - frp：仅做 config.yml 的语法/必填字段校验（**不验证连通性**，见下）。
   *
   * 不在列表里的模块一律转人工审核。默认只对 ai、proxy 自动 —— 因为这两者
   * 能「真的调一次」验证可用性；frp 的 config.yml 虽指向公网 frps，但 frpc↔frps
   * 是私有 TCP 协议（非 HTTP），Cloudflare Worker 出站只能发 HTTP/HTTPS、
   * 建不了任意 TCP 连接，无法握手验证，故只能静态校验、判定不可靠。
   *
   * 空串 = 全部转人工。若要关闭全部自动审核，存空串即可。
   */
  auto_review_features: "ai,proxy",
  /**
   * 昵称附加保留词（逗号分隔，大小写不敏感）。
   * 与「保留域名」同在管理面板「保留名」标签管理。
   * 基础保留词（管理员/站长/admin 等）硬编码在 identity.ts，无法删除。
   * 管理员自己设昵称时跳过这些检查，不会被自己的名单挡住。
   */
  reserved_nicknames: "",
  /** 代理节点功能总开关 */
  proxy_enabled: "1",
  /** 临时分享箱总开关 */
  tempbox_enabled: "1",
  /** 临时分享箱默认保存时长（分钟） */
  tempbox_default_minutes: "30",
  /** 临时分享箱单文件上限（字节，默认 256 MiB） */
  tempbox_max_file_bytes: "268435456",
  /** 临时分享箱每批次文件数上限 */
  tempbox_max_files: "20",
  /** 临时分享箱上传是否必须登录（1=默认，访客只可查看/下载） */
  tempbox_upload_requires_login: "1",
  /** frp 内网穿透总开关 */
  frp_enabled: "1",
  /** frp 核心包下载地址（可由后台替换） */
  frp_core_url: "https://r2data.doulor.cn/Firef%20Frp.zip",
  /** 管理员接收「新申请」通知的邮箱；为空则不发通知 */
  frp_admin_notify_email: "",
  /** 社区发帖最多图片数 */
  community_post_max_images: "9",
  /** 社区广场总开关 */
  community_enabled: "1",
  /** 是否允许访客（未登录）浏览社区广场 */
  community_guest_access: "1",
  /** 压缩后单张图片上限（字节，默认 1 MiB） */
  community_image_max_bytes: "1048576",
  /**
   * WorkBuddy 反代网关捐献通道总开关。
   *
   * 打开后捐献页会出现「反代账号」卡：捐献者登录自己的 WorkBuddy 国际版账号，
   * 登录成功即把账号加入网关共享池、并自动解锁本站「AI 中转站」权限（免审核）。
   */
  wb2api_enabled: "1",
  /** 反代网关站点地址（网关自身的 api_key 见 wb2api_credentials 表 / env Secret） */
  wb2api_base_url: "https://wb2api.doulor.cn",
  /**
   * 反代网关对接的 WorkBuddy 域：'cn'（国内版）或 'global'（国际版）。
   * 默认国内版。管理员可在管理面板「中转站/反代」设置里切换回国际版。
   */
  wb2api_realm: "cn",
  /**
   * 每个用户最多可绑定的 WorkBuddy 账号数。
   *
   * 为什么要有上限：绑定成功即自动解锁 ai 权限且免审核，不限量就等于
   * 「绑几个号 = 白拿几次权限」，也容易被单人用小号占满共享池。
   */
  wb2api_max_bindings: "3",
} as const

export type SettingKey = keyof typeof SETTING_DEFAULTS

/** 推荐模型的一个梯队（第一梯队 / 第二梯队 …） */
export interface RecommendedTier {
  /** 梯队名，如「第一梯队」 */
  tier: string
  /** 一句话说明，可空 */
  desc: string
  /** 该梯队包含的模型名 */
  models: string[]
}

/**
 * 清洗推荐模型分档。写入（管理面板保存）与读取（status 下发）共用，
 * 保证「存进去什么」和「读出来什么」走同一套规则。
 *
 * 丢弃规则：无梯队名 / 无模型的分档直接丢掉（空梯队展示出来只是噪音）；
 * 上限 8 个梯队 × 30 个模型，防管理员误粘超长内容撑爆前端。
 */
export function sanitizeRecommendedModels(input: unknown): RecommendedTier[] {
  if (!Array.isArray(input)) return []
  const out: RecommendedTier[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue
    const o = raw as Record<string, unknown>
    const tier = typeof o.tier === "string" ? o.tier.trim().slice(0, 20) : ""
    if (!tier) continue
    const models = Array.isArray(o.models)
      ? o.models
          .filter((m): m is string => typeof m === "string")
          .map((m) => m.trim().slice(0, 80))
          .filter(Boolean)
          .slice(0, 30)
      : []
    if (models.length === 0) continue
    out.push({
      tier,
      desc: typeof o.desc === "string" ? o.desc.trim().slice(0, 120) : "",
      models,
    })
    if (out.length >= 8) break
  }
  return out
}

/** 从设置值（JSON 字符串）解析推荐分档，坏 JSON 一律当空 */
export function parseRecommendedModels(raw: string | null | undefined): RecommendedTier[] {
  if (!raw) return []
  try {
    return sanitizeRecommendedModels(JSON.parse(raw))
  } catch {
    return []
  }
}

/** 一次性读取全部设置（含默认值兜底） */
export async function getSettings(env: Env): Promise<Record<SettingKey, string>> {
  const rows = await env.DB.prepare("SELECT key, value FROM app_settings")
    .all<{ key: string; value: string }>()

  const result = { ...SETTING_DEFAULTS } as Record<SettingKey, string>
  for (const row of rows.results ?? []) {
    if (row.key in SETTING_DEFAULTS) {
      result[row.key as SettingKey] = row.value
    }
  }
  return result
}

export async function getSetting(env: Env, key: SettingKey): Promise<string> {
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>()
  return row?.value ?? SETTING_DEFAULTS[key]
}

export async function getSettingNumber(
  env: Env,
  key: SettingKey
): Promise<number> {
  const raw = await getSetting(env, key)
  const n = Number(raw)
  return Number.isFinite(n) ? n : Number(SETTING_DEFAULTS[key])
}

export async function getSettingBool(env: Env, key: SettingKey): Promise<boolean> {
  const raw = await getSetting(env, key)
  return raw === "1" || raw.toLowerCase() === "true"
}

/** 写入设置（仅接受已知 key，避免前端塞入任意键） */
export async function updateSettings(
  env: Env,
  values: Partial<Record<SettingKey, string>>
): Promise<void> {
  const now = new Date().toISOString()
  const statements = Object.entries(values)
    .filter(([key]) => key in SETTING_DEFAULTS)
    .map(([key, value]) =>
      env.DB.prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).bind(key, String(value), now)
    )

  if (statements.length > 0) {
    await env.DB.batch(statements)
  }
}

/** 人类的字节数格式化（供前端复用同一套逻辑时参考） */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`
}

/** 记录审计日志（失败不影响主流程） */
export async function audit(
  env: Env,
  userId: string | null,
  action: string,
  detail: string,
  ip?: string | null
): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO audit_logs (id, user_id, action, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(uuid(), userId, action, detail, ip ?? null, new Date().toISOString())
      .run()
  } catch (err) {
    console.error("审计日志写入失败:", err)
  }
}