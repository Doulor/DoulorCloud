/**
 * 保留名称。
 *
 * 两处需要拦截：
 *   1. 用户名 → 决定 `<用户名>.doulor.cn` 与 `<用户名>@doulor.cn`，占用平台自身标识
 *   2. 邮箱前缀 → 防止用户冒充平台（如 admin@doulor.cn、postmaster@doulor.cn）
 *
 * 这些名称同时也会占用 domains/subdomains/mailboxes 的 UNIQUE 约束，
 * 若不拦截，攻击者可抢先占用他人想要的用户名，使其注册时邀请码被烧掉。
 */
export const RESERVED_NAMES = new Set([
  // 平台/基础设施
  "www",
  "mail",
  "smtp",
  "imap",
  "pop",
  "pop3",
  "mx",
  "ns",
  "ns1",
  "ns2",
  "dns",
  "api",
  "cdn",
  "static",
  "assets",
  "img",
  "dl",
  "ftp",
  "vpn",
  "proxy",
  "gateway",
  "gw",
  "app",
  "admin",
  "panel",
  "dashboard",
  "console",
  "manage",
  // 身份/信任相关，冒充风险最高
  "root",
  "administrator",
  "sysadmin",
  "postmaster",
  "hostmaster",
  "webmaster",
  "abuse",
  "security",
  "support",
  "help",
  "service",
  "info",
  "contact",
  "billing",
  "pay",
  "payment",
  "legal",
  "privacy",
  "compliance",
  "noreply",
  "no-reply",
  "donotreply",
  "mailer-daemon",
  "daemon",
  "notifications",
  "newsletter",
  "system",
  "official",
  "team",
  "staff",
  "ops",
  "status",
  "monitor",
  "alert",
  "alerts",
  // 其它易混淆
  "test",
  "demo",
  "example",
  "localhost",
  "announce",
  "verify",
  "account",
  "accounts",
])

export function isReservedName(name: string): boolean {
  return RESERVED_NAMES.has(name.trim().toLowerCase())
}