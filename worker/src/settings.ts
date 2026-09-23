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
   */
  invite_basic_features: "r2",
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
  /** 压缩后单张图片上限（字节，默认 1 MiB） */
  community_image_max_bytes: "1048576",
} as const

export type SettingKey = keyof typeof SETTING_DEFAULTS

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