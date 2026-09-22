/**
 * 静态站点的 Worker 入口：强制 HTTP → HTTPS 跳转。
 *
 * 为什么需要：会话 cookie 带 `Secure` 标志，浏览器在 HTTP 下会拒绝保存，
 * 表现为「登录接口返回 200 却立刻被踢回登录页」，且清缓存 / 换域名都无效。
 *
 * 实现说明（重要）：
 *   本站使用 assets 配置。带 `main` 的 Worker 必须显式声明 assets 绑定，
 *   否则 `env.ASSETS` 为 undefined，所有请求会 1101 崩溃。
 *   wrangler 会把 assets 绑定的名字定为 `ASSETS`（见 wrangler.jsonc 的
 *   assets.binding），这里做了兜底判断：绑定缺失时直接放行请求，
 *   不让整站因跳转逻辑而不可用。
 */

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

    return env.ASSETS.fetch(request)
  },
}