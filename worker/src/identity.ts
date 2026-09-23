/** 昵称字符集：中文 + 英文 + 数字 + 下划线，2-16 字符 */
export const NICKNAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_]{2,16}$/

/**
 * 不可冒充的基础保留词（硬编码，无法删除）。
 * 侧重「官方/管理员」类身份词与平台名，防普通用户冒充。
 * 管理员自己设昵称时跳过这些检查，不会被自己的名单挡住。
 */
export const NICKNAME_RESERVED_BASE = new Set([
  "管理员", "站长", "官方", "客服", "系统",
  "admin", "administrator", "root", "support", "official", "system", "moderator",
])

/**
 * 解析 app_settings.reserved_nicknames（逗号分隔）为附加保留词集合。
 * 管理员可在「保留名」标签里增删，与保留域名同页管理。
 */
export function parseReservedNicknames(raw: string | null | undefined): Set<string> {
  const out = new Set<string>()
  for (const seg of String(raw ?? "").split(",")) {
    const w = seg.trim().toLowerCase()
    if (w) out.add(w)
  }
  return out
}

/**
 * 判定昵称是否被保留词规则禁止。
 * - 永远禁止含「doulor」（防冒充平台名）
 * - 禁止命中基础保留词 + 管理员配置的附加保留词
 * - isAdmin=true 时跳过保留词检查（管理员能给自己设任意昵称，不被自己的名单挡）
 */
export function isReservedNickname(
  nick: string,
  extra: Set<string> = new Set(),
  isAdmin = false
): boolean {
  const lower = nick.toLowerCase()
  // 平台名恒禁（即便管理员也不能用 doulor 开头，避免和根域/账号混淆）
  if (lower.includes("doulor")) return true
  if (isAdmin) return false
  for (const w of NICKNAME_RESERVED_BASE) {
    if (lower === w) return true
  }
  for (const w of extra) {
    if (lower === w) return true
  }
  return false
}

/** 仅校验格式（字符集/长度），不查保留词与库 */
export function validateNicknameFormat(nick: string): boolean {
  return NICKNAME_RE.test(nick)
}

/** 头像在 R2 的对象键：avatars/<username>.<ext> */
export function avatarKey(username: string, ext: string): string {
  return `avatars/${username}.${ext}`
}

/** 头像允许的 Content-Type → 扩展名（与 profile 模块一致） */
export const AVATAR_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
}
