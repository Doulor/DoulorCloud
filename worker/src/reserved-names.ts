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
  // 应用入口域名 cloud.doulor.cn：若不拦截，用户可抢注该名字，
  // 导致平台自身入口被占用、或直链域名绑定冲突（绑定会创建 <fqdn>/* 路由）。
  "cloud",
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
/**
 * 数据库中的保留子域名（管理员可在面板里增删）。
 *
 * 与上面的静态 RESERVED_NAMES 的区别：
 *   - RESERVED_NAMES：写死的平台标识（mail/api/cloud…），任何场景都禁止
 *   - 本表：管理员为「给特定用途留位」而配置的名称（blog/dev/www…），
 *     仅限制**子域名**创建，不影响用户名与邮箱前缀的既有规则
 *
 * 即使位数合规也拒绝，这是用户明确要求的语义。
 */
export async function isReservedSubdomain(
  db: D1Database,
  name: string
): Promise<boolean> {
  const n = name.trim().toLowerCase()
  if (!n) return false
  const row = await db
    .prepare("SELECT name FROM reserved_subdomains WHERE name = ? COLLATE NOCASE LIMIT 1")
    .bind(n)
    .first()
  return !!row
}

/** 读取全部保留子域名（管理面板展示用） */
export async function listReservedSubdomains(
  db: D1Database
): Promise<{ name: string; note: string | null; createdAt: string }[]> {
  const rows = await db
    .prepare("SELECT name, note, created_at FROM reserved_subdomains ORDER BY name ASC")
    .all<{ name: string; note: string | null; created_at: string }>()
  return (rows.results ?? []).map((r) => ({
    name: r.name,
    note: r.note,
    createdAt: r.created_at,
  }))
}
