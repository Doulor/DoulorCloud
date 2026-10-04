import { ApiError, json } from "../http"
import { isPrivileged, requireUser } from "../auth"
import { requireAdminScope } from "./admin"
import { assertPublicHttpUrl } from "../url-guard"
import { extractIconUrl, extractMetaDescription, extractTitle, readTextCapped } from "../html-meta"
import type { Env } from "../env"

/**
 * 「有趣的网页分享」的两个辅助能力：
 *
 *   1. `POST /api/admin/fun-links/probe` —— 管理员填完链接，服务端去把对方的
 *      `<title>`、`<meta description>`、图标地址抓回来，省得手填。
 *   2. `GET  /api/fun-links/icon/:id`    —— 图标的**代理**。
 *
 * 为什么图标一定要代理、不能让前端直接 `<img src="对方域名">`：
 *   · 很多站点的图标只有 http，在 https 页面上会被浏览器当「混合内容」直接拦掉；
 *   · 部分站点对图标做防盗链（校验 Referer），外站引用会 403；
 *   · 顺带也不把用户的浏览器 IP 暴露给第三方站点。
 *
 * 安全：
 *   · 两个入口都有权限门槛（probe 管理员、icon 登录用户）；
 *   · 地址一律过 `assertPublicHttpUrl`（`url-guard.ts`）—— 拒绝内网 / 本地地址，
 *     避免这里变成「用 Worker 探内网」的工具；
 *   · HTML 只读前 256 KB、图标超过 2 MB 不收，防止被超大响应拖死。
 */

const PROBE_TIMEOUT_MS = 8000
const ICON_TIMEOUT_MS = 8000
const MAX_HTML_BYTES = 256 * 1024
const MAX_ICON_BYTES = 2 * 1024 * 1024

/** 普通 UA + 带个说明页，免得被当成采集器 */
const USER_AGENT =
  "Mozilla/5.0 (compatible; DoulorLinkBot/1.0; +https://cloud.doulor.cn) / 网页分享自动识别"

/**
 * 地址守卫：把 `url-guard` 抛的普通 Error 转成 400。
 * （守卫是共享模块，不依赖 http 层，所以这里做一次转换。）
 */
function assertSafeUrl(raw: string, label: string): URL {
  try {
    return assertPublicHttpUrl(raw, label).url
  } catch (e) {
    throw new ApiError(400, e instanceof Error ? e.message : `${label}不可用`, "INVALID_INPUT")
  }
}

/** POST /api/admin/fun-links/probe —— 管理员填完链接，抓标题 / 描述 / 图标 */
export async function probeFunLink(env: Env, request: Request): Promise<Response> {
  await requireAdminScope(env, request, "funLinks")

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const raw = String(body.url ?? "").trim()
  if (!raw) throw new ApiError(400, "先把链接填上", "INVALID_INPUT")

  const target = assertSafeUrl(raw, "链接")

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(target.toString(), {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    })
  } catch {
    throw new ApiError(400, "打不开这个网站（超时或被对方拒绝）", "PROBE_FAILED")
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) throw new ApiError(400, `对方返回了 ${res.status}`, "PROBE_FAILED")
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase()
  if (contentType && !contentType.includes("html") && !contentType.includes("text/plain")) {
    throw new ApiError(400, "这个链接看起来不是网页", "PROBE_FAILED")
  }

  const html = await readTextCapped(res, MAX_HTML_BYTES)
  const finalUrl = res.url || target.toString()
  return json({
    title: extractTitle(html),
    description: extractMetaDescription(html),
    iconUrl: extractIconUrl(html, finalUrl),
    finalUrl,
  })
}

/**
 * GET /api/fun-links/icon/:id —— 图标代理。
 *
 * 只认库里存过的图标地址（不做「随便传个 URL 就帮你取」的开放代理），
 * 所以不会被人拿去当免费跳板刷流量。
 */
export async function getFunLinkIcon(
  env: Env,
  request: Request,
  id: string
): Promise<Response> {
  const user = await requireUser(env, request)

  const row = await env.DB.prepare("SELECT icon_url, enabled FROM fun_links WHERE id = ?")
    .bind(id)
    .first<{ icon_url: string; enabled: number }>()
  if (!row?.icon_url) return new Response(null, { status: 404 })
  // 下架的条目只有管理员还能看到图标
  if (row.enabled !== 1 && !isPrivileged(user.role)) return new Response(null, { status: 404 })

  let target: URL
  try {
    target = assertPublicHttpUrl(row.icon_url, "图标地址").url
  } catch {
    return new Response(null, { status: 404 })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ICON_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(target.toString(), {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "image/*,*/*;q=0.8",
        // 有些站点校验 Referer，伪装成「从它自己首页点进来的」
        Referer: `${target.origin}/`,
      },
      // 说明：这里不用 `cf: { cacheTtl }` —— 本地测试环境（miniflare）对它的支持
      // 不一致，会直接抛错。缓存交给响应头让浏览器存（见下面的 Cache-Control）。
    })
  } catch {
    return new Response(null, { status: 404 })
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) return new Response(null, { status: 404 })
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase()
  if (!contentType.startsWith("image/")) return new Response(null, { status: 404 })
  const declared = Number(res.headers.get("content-length") ?? "0")
  if (Number.isFinite(declared) && declared > MAX_ICON_BYTES) {
    return new Response(null, { status: 404 })
  }

  return new Response(res.body, {
    headers: {
      "Content-Type": contentType,
      // 前端拿到就缓存一天；换图标要等缓存过期（重进任意带 ?v 的链接即可绕过）
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
