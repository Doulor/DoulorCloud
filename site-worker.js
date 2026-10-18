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

/**
 * 整站 301 到主站的域名（2026-10-17 站长要求：让 7u.nz 跳转到自己的网站）。
 *
 * ⚠️ **只**包含根域与 www —— `*.7u.nz` 是站内用户绑定的子域名（名片 / 网盘直链），
 *    它们由 API Worker 的动态 Route 处理，绝不能被这里截走，所以：
 *    · 不匹配泛域名，逐个 host 精确判断
 *    · 子域名不会命中这个 Set
 *
 * 用 301 而不是 302：这两个 host 之前**没有对外提供过任何内容**（根域无 DNS 记录、
 * www 走通配占位返回 522），所以不存在"用户浏览器已缓存 301 改不回来"的风险；
 * 反过来 301 能正确把搜索权重合并到主站。
 */
const SITE_REDIRECTS = new Map([["7u.nz", "https://cloud.doulor.cn"], ["www.7u.nz", "https://cloud.doulor.cn"]])

/**
 * 需要转发给 API Worker 的**根级**路径白名单（2026-10-17）。
 *
 * 背景（用户 ventus 反馈「中转站用 oauth 登不进去」）：
 *   API Worker 在 CF 上只挂了 `api/* dl/* p/* u/* c/* profile/*` 这些 Route
 *   （见 worker/wrangler.toml 的清单），于是根级的 `/.well-known/*` 与 `/oauth/*`
 *   全落进本 Worker，被 SPA 兜底成 index.html —— NewAPI 的「自动发现」拿回一段
 *   HTML，解析失败；手动填根级地址换取令牌同样失败。
 *
 *   而 `worker/src/handlers/oauth.ts` 的 `oauthBase()` 里 `/api` 是**写死**的，
 *   所以只要把发现文档这一个路径代理过去，它宣告的 issuer 与三个端点就都是
 *   `/api/...`（本来就可用）—— 对方的自动发现即可成功，**不用改任何配置**。
 *   顺手把 token / userinfo / authorize 也代理上，让手动填根级地址的人也能用。
 *
 * ⚠️ `/oauth/consent` 是**前端**的同意页，绝不能进这个白名单，
 *    否则同意页会被 API Worker 截走（worker/src/index.ts 的注释也强调了这一点）。
 */
function shouldProxyToApi(pathname) {
  if (pathname === "/.well-known/openid-configuration") return true
  if (pathname === "/oauth/token") return true
  if (pathname === "/oauth/userinfo") return true
  // authorize 及其子路径（/oauth/authorize/context、/decision）都是 API 端点；
  // 注意 /oauth/consent 不在这个前缀下，仍然是 SPA 页面。
  if (pathname === "/oauth/authorize" || pathname.startsWith("/oauth/authorize/")) return true
  return false
}

/** 服务绑定不可用时的明确报错（不要静默回落到 SPA，否则又变成"拿到 HTML"） */
function apiBindingUnavailable() {
  return new Response(
    JSON.stringify({ error: "api_binding_unavailable", message: "API 服务绑定缺失" }),
    {
      status: 503,
      headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS },
    }
  )
}

export default {
  /**
   * @param {Request} request
   * @param {{ ASSETS?: { fetch: (r: Request) => Promise<Response> }, API?: { fetch: (r: Request) => Promise<Response> } }} env
   * @returns {Promise<Response>}
   */
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.protocol === "http:") {
      url.protocol = "https:"
      return Response.redirect(url.toString(), 301)
    }

    // 整站跳转（7u.nz / www.7u.nz → 主站），保留原路径与查询串
    const redirectBase = SITE_REDIRECTS.get(url.hostname)
    if (redirectBase) {
      return Response.redirect(redirectBase + url.pathname + url.search, 301)
    }

    // OIDC 根级端点 → 转发给 API Worker（白名单见上）
    if (shouldProxyToApi(url.pathname)) {
      if (!env || !env.API || typeof env.API.fetch !== "function") {
        return apiBindingUnavailable()
      }
      // 原样转发：request.url 仍是 cloud.doulor.cn 上的地址，
      // API Worker 的 canonicalOrigin() 据此得出正确 issuer ✅
      return env.API.fetch(request)
    }

    // assets 绑定缺失时不要抛错（否则整站 1101），尽力返回请求本身
    if (!env || !env.ASSETS || typeof env.ASSETS.fetch !== "function") {
      return new Response(
        "Static assets binding is unavailable. Check wrangler.jsonc assets.binding.",
        { status: 500 }
      )
    }

    // 带内容哈希的静态资源（/assets/*、/fonts/*、favicon）
    // ⚠️ /webvm/*（浏览器终端的 v86 运行时与镜像，约 7.4MB）也必须算长期缓存，
    //    见下方缓存策略的分支 —— 2026-10-09 之前它落进了「不缓存」那一支，
    //    响应头是 no-store ⇒ **每次启用终端都重新下载 7.4MB**，这就是「启用要等半天」的真凶。
    const isStaticAsset =
      url.pathname.startsWith("/assets/") ||
      url.pathname.startsWith("/fonts/") ||
      url.pathname.startsWith("/webvm/") ||
      url.pathname === "/favicon.png"

    const res = await env.ASSETS.fetch(request)

    // ⚠️ 静态资源「不存在」时必须返回 404，**绝不能走 SPA 兜底**。
    //
    // 本站 assets 配的是 `not_found_handling: single-page-application`，于是
    // 请求一个不存在的 `/assets/xxx-HASH.js` 会拿到 **index.html（200 + text/html）**。
    // 后果（2026-10-02 线上事故）：
    //   · 用户浏览器里还开着旧版本页面（记的是旧 chunk 名），点进懒加载路由去请求
    //     已被新构建替换掉的旧 chunk → 拿到一段 HTML 被当 JS 解析 → 报
    //     `Cannot read properties of undefined (reading 'default')`，
    //     **而不是**前端 chunk 自愈（src/lib/chunk-error.ts）能识别的
    //     `Failed to fetch dynamically imported module` ⇒ 不触发自动刷新，用户卡死；
    //   · 下面还会给它打 `immutable` 长缓存，让它顽固不化。
    //   · Service Worker 也会把这个 200 缓存下来（它只按 res.ok 判断）。
    // 所以：静态资源路径只要拿回来的是 HTML（= 走了 SPA 兜底），一律改成 404，
    // 让前端的「404 → 自动刷新换新版本」自愈链路恢复正常。
    if (isStaticAsset && (res.headers.get("Content-Type") || "").includes("text/html")) {
      return new Response("Not Found", { status: 404, headers: SECURITY_HEADERS })
    }

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
    if (!isStaticAsset) {
      copy.headers.set("Cache-Control", "no-cache, no-store, must-revalidate")
      copy.headers.set("Pragma", "no-cache")
    } else {
      copy.headers.set("Cache-Control", "public, max-age=31536000, immutable")
    }

    return copy
  },
}
