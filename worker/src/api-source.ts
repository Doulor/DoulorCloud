/**
 * 请求来源标记：判断一个请求是否来自公开 API（而非网页/session 调用）。
 *
 * 用途：公开 API 复用现有 handler 时，通过 `runAs` 往请求头注入
 * `X-Doulor-Api-Source: api`，handler 据此给业务记录打 `source='api'`，
 * 成就计数按「API 计入成就」开关决定是否排除这些记录。
 *
 * 放在独立小文件里，避免 dns.ts / email.ts 与 public-api.ts 互相 import
 * 造成循环依赖。
 */
export const API_SOURCE_HEADER = "X-Doulor-Api-Source"

/**
 * 管理员 Key 标记（2026-10-07）。
 *
 * `runAs` 在**该 Key 打了 is_admin** 时注入 `X-Doulor-Api-Admin: 1`，
 * 各处的限额检查据此放行（API 速率 / 子域名速率 / 子域名数量 / 邮箱数量）。
 *
 * ⚠️⚠️ **这两个头都必须由入口剥掉客户端传来的同名值**
 * （见 `stripInternalHeaders`）。否则任何人只要自己加一个
 * `X-Doulor-Api-Admin: 1` 就能绕过全部限额 —— 等于把限额系统整个关掉。
 */
export const API_ADMIN_HEADER = "X-Doulor-Api-Admin"

export function isApiRequest(request: Request): boolean {
  return request.headers.get(API_SOURCE_HEADER) === "api"
}

/** 是否来自「管理员 Key」的公开 API 调用（限额一律放行）。两个头都要对，缺一不可 */
export function isAdminApiRequest(request: Request): boolean {
  return isApiRequest(request) && request.headers.get(API_ADMIN_HEADER) === "1"
}

/**
 * 剥掉客户端伪造的内部标记头（入口必调）。
 *
 * 没有这一步的话，`X-Doulor-Api-Source` / `X-Doulor-Api-Admin` 就是两个
 * **任何人都能自己加**的头，限额形同虚设。只在真的带了这些头时才重建
 * Request（避免给所有请求增加无谓开销）。
 */
export function stripInternalHeaders(request: Request): Request {
  if (!request.headers.has(API_SOURCE_HEADER) && !request.headers.has(API_ADMIN_HEADER)) {
    return request
  }
  const headers = new Headers(request.headers)
  headers.delete(API_SOURCE_HEADER)
  headers.delete(API_ADMIN_HEADER)
  return new Request(request, { headers })
}
