export class ApiError extends Error {
  status: number
  code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/**
 * 安全响应头（2026-09-23 审计补充）。
 *
 * 背景：全站此前**没有任何安全响应头**（无 CSP / X-Frame-Options / nosniff…）。
 * 这会把其他漏洞的危害放大 —— 例如网盘直链可托管 HTML，若有 CSP 兜底，
 * 即使内容类型被透传，脚本也拿不到同源的 API 访问权。
 *
 * 这里只放「对 JSON 响应绝对安全」的两项；页面级 CSP 见根目录 site-worker.js
 * （静态站 SPA）与 docs/待办-交给R2方向的安全补丁.md（内容直链）。
 */
export const SAFE_JSON_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...SAFE_JSON_HEADERS,
    },
  })
}

export function errorResponse(status: number, message: string, code?: string) {
  return json({ error: message, code }, status)
}
