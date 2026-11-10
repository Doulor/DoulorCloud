/**
 * GET /api/mail/img —— 邮件图片代理（公开，身份来自 URL 签名）。
 *
 * 存在的理由与残留风险见 ../mail-images.ts 的文件头。本文件只负责**安全边界**：
 *
 *   · 签名不对 → 404。代理不是开放的「帮任何人取任意 URL」的服务。
 *   · 目标必须是 http(s)，且**不能**是内网 / 保留地址 / 本站域名（SSRF）。
 *   · 不跟随重定向：3xx 是绕过地址检查的经典手法（跳到 127.0.0.1 之类）。
 *   · 只接受**位图**类型白名单，SVG 明确不收 —— SVG 能内嵌脚本，
 *     一旦有人直接把代理地址贴进浏览器，就是在我们的域上执行。
 *   · 响应体积硬上限，边读边数（Content-Length 可以缺失或撒谎）。
 *   · 出口响应加 `nosniff` + `CSP: sandbox` + `CORP: same-origin`：
 *     前者防内容嗅探，中者保证即使被直接打开也什么都跑不了，后者防别人盗链。
 */
import type { Env } from "../env"
import { verifyMailImage } from "../mail-images"
import { fetchWithTimeout } from "../async-utils"
import { clientIp, guardRateLimit } from "../ratelimit"

/** 单张图片上限：邮件的 logo / 配图远到不了这个量，超了基本就是滥用 */
const MAX_BYTES = 5 * 1024 * 1024

/**
 * 允许代理的 Content-Type 白名单。
 *
 * ⚠️ 故意不含 `image/svg+xml` —— 它本质是可执行文档。也不含任何 `text/*`。
 */
const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/avif",
  "image/x-icon",
  "image/vnd.microsoft.icon",
])

function notFound(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  })
}

/**
 * 是不是「不该从我们的 Worker 去访问」的地址。
 *
 * 覆盖：回环 / 私有网段 / 链路本地 / 组播 / 保留段、IPv6 字面量、
 * `.local` `.internal` 这类内部域名。宁可多拒 —— 拒错了只是图片不显示。
 */
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "")
  if (!h) return true
  if (h === "localhost" || h.endsWith(".localhost")) return true
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".home")) {
    return true
  }
  // IPv6 字面量（URL.hostname 带方括号）：邮件图片用不到，一律拒
  if (h.startsWith("[") || h.includes(":")) return true

  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true // 链路本地（云元数据服务就在这段）
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a >= 224) return true // 组播 / 保留
  return false
}

/** 取消上游响应体，避免连接挂着不放 */
async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel()
  } catch {
    /* 已经读完 / 已关闭，忽略 */
  }
}

export async function proxyMailImage(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const src = url.searchParams.get("src") ?? ""
  const sig = url.searchParams.get("s") ?? ""
  if (!src || !sig) return notFound()
  if (!(await verifyMailImage(env, src, sig))) return notFound()

  // 防「拿到一条签名链接就无限刷图」：按来源 IP 限流。
  // 限流本身 fail-open（见 ratelimit.ts），表没建也不会让图片全裂。
  await guardRateLimit(env, `mail-img:${clientIp(request)}`, 1200, 3600, "图片加载过于频繁")

  let target: URL
  try {
    target = new URL(src)
  } catch {
    return notFound()
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") return notFound()
  if (target.username || target.password) return notFound()
  if (isBlockedHost(target.hostname)) return notFound()

  // 本站自己的域名也不代理：既没意义（邮件图片不会托管在我们的 API 域），
  // 又避免代理被当成「绕过自家访问控制」的跳板
  const root = (env.ROOT_DOMAIN || "").toLowerCase()
  const host = target.hostname.toLowerCase()
  if (root && (host === root || host.endsWith(`.${root}`))) return notFound()

  let res: Response
  try {
    res = await fetchWithTimeout(
      target.toString(),
      {
        method: "GET",
        // 关键：不跟随重定向
        redirect: "manual",
        headers: {
          Accept: "image/png,image/jpeg,image/webp,image/gif,image/*;q=0.8",
          "User-Agent": "DoulorMailImageProxy/1.0 (+https://cloud.doulor.cn)",
        },
      },
      10_000
    )
  } catch (err) {
    console.warn("邮件图片拉取失败:", host, err instanceof Error ? err.message : err)
    return notFound()
  }

  if (!res.ok) {
    await discard(res)
    return notFound()
  }

  const type = (res.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase()
  if (!ALLOWED_TYPES.has(type)) {
    await discard(res)
    return notFound()
  }

  const declared = Number(res.headers.get("Content-Length") ?? "")
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    await discard(res)
    return notFound()
  }

  const reader = res.body?.getReader()
  if (!reader) return notFound()

  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > MAX_BYTES) {
      try {
        await reader.cancel()
      } catch {
        /* 忽略 */
      }
      return notFound()
    }
    chunks.push(value)
  }
  if (total === 0) return notFound()

  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }

  return new Response(body, {
    headers: {
      "Content-Type": type,
      "Content-Length": String(total),
      // 发件人换了图也最多缓存一天；图片地址带签名，换图会换地址
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      // 有人把这个地址直接贴进地址栏时：沙箱化，且不允许加载任何子资源
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Referrer-Policy": "no-referrer",
      /**
       * ⚠️ 这里**不能**写 `same-origin`。
       *
       * 邮件正文渲染在 `sandbox`（不含 allow-same-origin）的 iframe 里，那是个
       * **不透明源**：它发出的图片请求在旁边看来就是 cross-origin。
       * 一旦声明 `Cross-Origin-Resource-Policy: same-origin`，浏览器会把这些
       * 请求全部拦掉 —— 表现为「所有图片都裂」，而且是极其难查的那种裂。
       * 防盗链本来也不该靠它：地址本身带 HMAC 签名，别人推不出别人的图。
       */
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  })
}
