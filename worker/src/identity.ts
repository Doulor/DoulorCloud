/** 昵称字符集：中文 + 英文 + 数字 + 下划线，2-16 字符 */
export const NICKNAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_]{2,16}$/

/** 预留名黑名单（防冒充），全部小写 */
export const NICKNAME_RESERVED = new Set([
  "管理员", "站长", "官方", "客服", "系统",
  "doulor", "admin", "administrator", "root", "support", "official", "system", "moderator",
])

/** 判定昵称是否被预留名规则禁止（含黑名单词或含 doulor） */
export function isReservedNickname(nick: string): boolean {
  const lower = nick.toLowerCase()
  if (lower.includes("doulor")) return true
  for (const w of NICKNAME_RESERVED) {
    if (lower === w.toLowerCase()) return true
  }
  return false
}

/** 仅校验格式（字符集/长度/预留名），不查库 */
export function validateNicknameFormat(nick: string): boolean {
  if (!NICKNAME_RE.test(nick)) return false
  return !isReservedNickname(nick)
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
