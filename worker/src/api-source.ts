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

export function isApiRequest(request: Request): boolean {
  return request.headers.get(API_SOURCE_HEADER) === "api"
}
