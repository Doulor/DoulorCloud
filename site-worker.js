/**
 * 静态站点的 Worker 入口：强制 HTTP → HTTPS 跳转 + 统一追加安全响应头。
 *
 * 为什么需要 HTTPS 跳转：会话 cookie 带 `Secure` 标志，浏览器在 HTTP 下会拒绝保存，
 * 表现为「登录接口返回 200 却立刻被踢回登录页」，且清缓存 / 换域名都无效。
 *
 * 实现说明（重要）：
 *   本站使用 assets 配置。带 `main` 的 Worker 必须显式声明 assets 绑定，
 *   否则 `env.ASSETS` 为 undefined，所有请求会 1101 崩溃。
 *   wrangler 会把 assets 绑定的名字定为 `ASSETS`（见 wrangler.jsonc 的
 *   assets.binding），这里做了兜底判断：绑定缺失时直接返回错误页，
 *   不让整站因跳转逻辑而不可用。
 *
 * 安全响应头（2026-09-23 安全审计补充）：
 *   审计发现全站此前**没有任何安全响应头**（无 CSP / X-Frame-Options / nosniff…）。
 *   其中 CSP 是最关键的兜底：网盘直链可以托管任意 MIME 的内容
 *   （见 docs/待办-交给R2方向的安全补丁.md），一旦有 CSP，
 *   即使某个响应被当成 HTML 执行，脚本也拿不到同源的 API 访问权。
 *
 *   ⚠️ CSP 先以 **Content-Security-Policy-Report-Only**（只上报、不阻断）上线：
 *   本工作区跑不起浏览器做端到端验证，直接上强制 CSP 有把 SPA 打挂的风险。
 *   转正步骤：
 *     1. 部署后在开发者工具 Console 观察 CSP 违规报告（Report-Only 会打印违规）；
 *     2. 违规清零后，把 CSP_REPORT_ONLY 的值复制给强制的
 *        `Content-Security-Policy` 头，并删掉 Report-Only 这一项；
 *     3. 若仍有零星违规（多半是内联样式），在策略里定向放开，不要整体放宽 default-src。
 */

/**
 * CSP 仅报告模式策略。
 * - script-src 'self'：Vite 产物是外链模块脚本，index.html 无内联脚本
 * - style-src 需要 'unsafe-inline'：Tailwind / Radix / sonner 会在 style 属性上写样式
 * - img/media 放开 https: 与 blob:/data:：前端压缩走 blob URL，用户内容可能是外链
 */
const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ")

/** 对所有响应都安全的头（不改行为，只收口浏览器能力） */
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=()",
  // 不加 includeSubDomains：本 Worker 只服务 cloud.doulor.cn，
  // 用户自定义域名（名片 / 直链）由 API Worker 处理，不应被这里影响。
  "Strict-Transport-Security": "max-age=31536000",
  "Content-Security-Policy-Report-Only": CSP_REPORT_ONLY,
}

/**
 * 复制响应并追加安全头。
 * 不能直接改 `env.ASSETS.fetch()` 返回值的 headers —— 那是不可变（immutable）的，
 * 直接 set 会抛错，必须重新构造一个 Response。
 */
function withSecurityHeaders(res) {
  const copy = new Response(res.body, res)
  for (const name of Object.keys(SECURITY_HEADERS)) {
    copy.headers.set(name, SECURITY_HEADERS[name])
  }
  return copy
}

export default {
  /**
   * @param {Request} request
   * @param {{ ASSETS?: { fetch: (r: Request) => Promise<Response> } }} env
   * @returns {Promise<Response>}
   */
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.protocol === "http:") {
      url.protocol = "https:"
      return Response.redirect(url.toString(), 301)
    }

    // assets 绑定缺失时不要抛错（否则整站 1101），尽力返回请求本身
    if (!env || !env.ASSETS || typeof env.ASSETS.fetch !== "function") {
      return new Response(
        "Static assets binding is unavailable. Check wrangler.jsonc assets.binding.",
        { status: 500 }
      )
    }

    const res = await env.ASSETS.fetch(request)
    const copy = withSecurityHeaders(res)

    // 字体走 CORS 严格模式：自定义域名（如 card.doulor.cn）访问名片时，
    // 字体从 cloud.doulor.cn/fonts/*.woff2 加载会被浏览器拒绝。字体公开可读，
    // 追加 Access-Control-Allow-Origin: * 即可。其他路径不加，保持默认行为。
    if (url.pathname.startsWith("/fonts/")) {
      copy.headers.set("Access-Control-Allow-Origin", "*")
    }

    // 缓存策略（关键）：
    //   - HTML（index.html 与 SPA 兜底的任何前端路由）→ 永不缓存。
    //     这是 SPA 部署后「旧入口引用已删除的旧 chunk」报
    //     「Failed to fetch dynamically imported module」的根因：
    //     若 index.html 被浏览器/边缘缓存，部署新版本后用户仍拿到旧入口，
    //     去请求已被新构建替换掉（hash 变化）的旧 JS → 404。
    //   - 带 hash 的静态资源（/assets/*.js|css|woff2|png、字体、favicon）
    //     → 长期缓存，文件名带内容 hash，内容变了名字就变，永不冲突。
    const isStaticAsset =
      url.pathname.startsWith("/assets/") ||
      url.pathname.startsWith("/fonts/") ||
      url.pathname === "/favicon.png"
    if (!isStaticAsset) {
      copy.headers.set("Cache-Control", "no-cache, no-store, must-revalidate")
      copy.headers.set("Pragma", "no-cache")
    } else {
      copy.headers.set("Cache-Control", "public, max-age=31536000, immutable")
    }

    return copy
  },
}
