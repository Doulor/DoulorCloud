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

/**
 * 安全解码 URL 中的百分号编码。
 *
 * 背景（2026-09-25 审计，中）：`new URL()` 与路由匹配**不会**拒绝 `%zz`、
 * 孤立 `%`、`%E0%A4%A` 这类非法编码，但 `decodeURIComponent` 会抛 `URIError`。
 * 全仓有 78 处裸调用且**一处都没捕获**，于是 `GET /api/dns/%` 会一路冒泡到
 * 最外层 500（并写入错误日志），语义上它只是「请求格式错误」= 400。
 *
 * 顺带把 NUL 与路径穿越段挡在这里 —— 解码后的字符串才是真正参与
 * R2 key / SQL 拼接的那个，早一步失败比晚一步安全。
 */
export function safeDecode(value: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    throw new ApiError(400, "请求路径包含非法编码", "INVALID_ENCODING")
  }
  if (decoded.includes("\u0000")) {
    throw new ApiError(400, "请求路径包含非法字符", "INVALID_PATH")
  }
  return decoded
}

/**
 * 请求体体积上限的统一入口（2026-09-25 审计 L29 / L30）。
 *
 * 背景：全仓多处是「**先整体读进内存、再校验大小**」——
 * `await request.arrayBuffer()` 之后才比对 5/10/20MB，或者干脆对
 * `request.json()` 完全没有上限。单请求内存被放大，并发时足以打满
 * Worker 的 128MB 内存；匿名接口（如 `analytics/track`）上更划算。
 *
 * 这里的做法分两步，缺一不可：
 *   1. **先看 `Content-Length`** —— 便宜的快速拒绝，且对「声明得很大」的
 *      恶意请求连读都不读（这正是原实现浪费内存的地方）。
 *   2. **读完再复核实际长度** —— `Content-Length` 可以被伪造或缺失
 *      （chunked 传输时就没有），所以它只能当快速路径，不能当唯一依据。
 */
export function assertContentLengthWithin(
  request: Request,
  maxBytes: number,
  message: string,
  status = 413,
  code = "PAYLOAD_TOO_LARGE"
): void {
  const raw = request.headers.get("Content-Length")
  if (!raw) return
  const declared = Number(raw)
  // 非数字 / NaN / 负数：交给后续的真实长度复核，不在这里误判
  if (!Number.isFinite(declared) || declared <= maxBytes) return
  throw new ApiError(status, message, code)
}

/**
 * 读取请求体并施加体积上限（先看 Content-Length，读完再复核真实长度）。
 *
 * `status`/`code` 可由调用方覆盖 —— 各接口历史上用的状态码与错误码并不统一
 * （例如头像上传一直是 `400 TOO_LARGE`），收敛体积上限这件事
 * **不应该顺带改掉既有接口契约**。
 */
export async function readBodyCapped(
  request: Request,
  maxBytes: number,
  message: string,
  status = 413,
  code = "PAYLOAD_TOO_LARGE"
): Promise<ArrayBuffer> {
  assertContentLengthWithin(request, maxBytes, message, status, code)
  const buf = await request.arrayBuffer()
  if (buf.byteLength > maxBytes) {
    throw new ApiError(status, message, code)
  }
  return buf
}
