import { ApiError } from "./http"
import type { Env } from "./env"
import type { DomainRow } from "./auth"

/**
 * 域名所有权校验 —— 权限核心。
 *
 * 任何对 DNS / 邮箱的写操作，都必须先通过此函数确认：
 * 当前用户拥有该 domain 记录，且目标 FQDN 落在其命名空间内。
 * 绝不信任前端传入的 owner / domain / user_id。
 */
export async function requireOwnedDomain(
  env: Env,
  userId: string,
  domainId: string
): Promise<DomainRow> {
  const domain = await env.DB.prepare(
    "SELECT * FROM domains WHERE id = ? AND user_id = ? LIMIT 1"
  )
    .bind(domainId, userId)
    .first<DomainRow>()

  if (!domain) {
    throw new ApiError(403, "无权访问该域名", "FORBIDDEN")
  }
  return domain
}

/**
 * 校验某个完整 FQDN 是否落在「用户拥有的任一子域名」之下（基于数据库，async）。
 * 新模型示例（用户拥有主域名 smtest.doulor.cn 和 xxx1.doulor.cn）：
 *   smtest.doulor.cn / blog.smtest.doulor.cn   -> 允许
 *   xxx1.doulor.cn / blog.xxx1.doulor.cn       -> 允许
 *   alice.doulor.cn / blog.xxx.doulor.cn       -> 403
 */
export async function assertFqdnOwned(
  env: Env,
  userId: string,
  fqdn: string
): Promise<void> {
  const target = fqdn.toLowerCase()
  const rows = await env.DB.prepare(
    "SELECT fqdn FROM subdomains WHERE user_id = ?"
  )
    .bind(userId)
    .all<{ fqdn: string }>()

  const owned = (rows.results ?? []).some((s) => {
    const base = s.fqdn.toLowerCase()
    return target === base || target.endsWith(`.${base}`)
  })

  if (!owned) {
    throw new ApiError(403, "该域名不在你的名下", "FORBIDDEN")
  }
}
