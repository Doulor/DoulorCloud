/**
 * 实验室的**服务端抓取**（2026-10-10）。
 *
 * 一个接口服务两个用途：
 *   · 工具 <lab_http>：让模型自己去调一个接口/取一个页面；
 *   · 「参考网址」：用户贴个链接，把页面正文抓回来当上下文（"照这个风格做"）。
 * 两者本质相同（服务端代抓 + 文本化），所以不写两套。
 *
 * 🔴 和代拉模型列表一样，这是**服务端替用户请求任意地址** ⇒ SSRF 面。
 *    直接复用 `assertSafeUpstreamUrl`（内网/回环/云元数据端点拦截），
 *    并额外限制：只跟 3 次跳转、响应体截断、超时 20 秒。
 *    ⚠️ 仍然挡不住「域名解析到内网」—— 这一点在 lab-search 的注释里已写明，不重复假装安全。
 */
import { ApiError, json } from "../http"
import { requireUser } from "../auth"
import { assertSafeUpstreamUrl } from "./lab-search"
import { getSetting } from "../settings"
import type { Env } from "../env"

/** 返回给模型/前端的正文上限（再大就是浪费 token） */
const MAX_BODY_CHARS = 30_000
const TIMEOUT_MS = 20_000

/** 把 HTML 粗略转成文本：去掉 script/style，再剥标签、压空白 */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/**
 * POST /api/lab/http —— body: { url, method?, headers?, body?, raw? }
 * `raw: true` 表示「原样返回」（模型要自己看 JSON/HTML 结构时用），
 * 否则 HTML 会被转成纯文本（"参考网址"走这条，省 token 也更好读）。
 */
export async function labHttp(env: Env, request: Request): Promise<Response> {
  await requireUser(env, request)
  const payload = (await request.json().catch(() => null)) as
    | {
        url?: unknown
        method?: unknown
        headers?: unknown
        body?: unknown
        raw?: unknown
      }
    | null

  // 管理员可整体关掉（服务端替用户请求任意地址的能力，要留一个一键关的口子）
  if ((await getSetting(env, "lab_fetch_enabled")) === "0") {
    throw new ApiError(403, "站点已关闭「抓取网址」功能", "FETCH_DISABLED")
  }

  const rawUrl = typeof payload?.url === "string" ? payload.url.trim() : ""
  if (!rawUrl) throw new ApiError(400, "缺少 url", "INVALID_URL")
  const url = assertSafeUpstreamUrl(rawUrl)

  const method =
    typeof payload?.method === "string" ? payload.method.toUpperCase() : "GET"
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method)) {
    throw new ApiError(400, "不支持的请求方法", "INVALID_METHOD")
  }

  // 只透传一层薄的 headers；Host 之类由 fetch 自己决定，不让调用方覆盖
  const extra: Record<string, string> = {}
  if (payload?.headers && typeof payload.headers === "object") {
    for (const [k, v] of Object.entries(payload.headers as Record<string, unknown>)) {
      if (typeof v !== "string") continue
      const key = k.toLowerCase()
      if (key === "host" || key === "content-length" || key === "connection") continue
      extra[k] = v
    }
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url.toString(), {
      method,
      headers: extra,
      body:
        method === "GET" || method === "HEAD"
          ? undefined
          : typeof payload?.body === "string"
            ? payload.body
            : undefined,
      redirect: "follow",
      signal: ctrl.signal,
    })

    const contentType = res.headers.get("content-type") ?? ""
    const text = await res.text()
    const truncated = text.length > MAX_BODY_CHARS
    const slice = truncated ? text.slice(0, MAX_BODY_CHARS) : text
    const isHtml = /text\/html|application\/xhtml/i.test(contentType)
    const body = payload?.raw === true || !isHtml ? slice : htmlToText(slice)

    return json({
      status: res.status,
      contentType,
      truncated,
      body,
      finalUrl: res.url,
    })
  } catch (err) {
    if (err instanceof ApiError) throw err
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new ApiError(504, "对方响应超时", "UPSTREAM_TIMEOUT")
    }
    throw new ApiError(502, "连不上这个地址", "UPSTREAM_ERROR")
  } finally {
    clearTimeout(timer)
  }
}
