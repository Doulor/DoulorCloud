/**
 * 链接预览：把 URL 解析成「富链接卡片」所需的元数据（标题 / 描述 / 图片 / 图标 / 站点名）。
 *
 * 为什么在 Worker 端做：浏览器前端受 CORS 限制，不能直接抓取外站；
 * Worker 无此限制，由它去抓目标 URL 的 HTML 并解析 Open Graph 标签。
 * 这也是 Discord / Slack / 飞书等「链接展开卡片」都是服务端抓取的原因。
 *
 * 缓存：同一 URL 被多人引用时不能反复抓，解析结果存 D1（link_previews 表），
 * 过期后重新抓取以反映目标站点内容更新。
 *
 * 图片与图标的区别（2026-09-29 补）：
 *   - `image` = og:image，大图，卡片左侧铺满；
 *   - `icon`  = 站点 favicon，小图。
 *   很多页面（如 QQ 群邀请页 `qm.qq.com/q/xxx`）只有 title 没有 og:image，
 *   这时用 icon 补一个图标位，卡片不至于空着一块。
 *
 * ⚠️ 安全：
 *   - 只抓 http/https，拒绝其它协议（file://、javascript: 等）。
 *   - 目标响应过大直接放弃（限制抓取字节数），防止被塞超大文件拖垮 Worker。
 *   - 解析用正则而非完整 HTML 解析器（见 `html-meta.ts`），够用且不引入重量级依赖。
 *
 * ⚠️ 2026-09-25 审计（H5）：上面这三条**没有一条覆盖 SSRF**，而
 * `url-guard.ts` 的模块契约明确写着「**任何**服务端请求用户地址的
 * 功能都必须过 assertPublicHttpUrl」—— 本文件此前连 import 都没有，
 * 于是任何登录用户都能让 Worker 去请求 169.254.169.254 / 127.0.0.1 /
 * 10.x 内网地址，并用「能不能取到 title」当盲探针。同时
 * `redirect: "follow"` 让首跳校验（即使补上）也能被一个 302 绕过。
 * 现在：入口先过 assertPublicHttpUrl，重定向改为手动逐跳校验。
 */
import { assertPublicHttpUrl } from "./url-guard"
import {
  extractIconUrl,
  extractTitle,
  parseAttrs,
  readTextCapped,
  resolveAbsolute,
  tidy,
} from "./html-meta"
import type { Env } from "./env"

/** 预览缓存的有效期（天） */
const PREVIEW_TTL_DAYS = 7

/** 单次抓取最多读取的字节数（约 512KB，足够拿到 head 里的 OG 标签） */
const MAX_FETCH_BYTES = 512 * 1024

/** 抓取超时（毫秒） */
const FETCH_TIMEOUT_MS = 5000

/** 手动跟随的最大重定向跳数 */
const MAX_REDIRECT_HOPS = 3
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export interface LinkPreview {
  title: string
  description: string | null
  /** og:image —— 大图 */
  image: string | null
  /** 站点图标（favicon）—— 没有大图时用它顶上 */
  icon: string | null
  siteName: string | null
}

/** 规范化 URL：去 hash、去尾部斜杠，作为缓存键 */
export function normalizeUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  url.hash = ""
  // 根路径的 / 去掉，避免 https://a.com 和 https://a.com/ 被当成两个键
  if (url.pathname === "/") url.pathname = ""
  return url.toString()
}

/** 从 HTML 里提取预览信息；相对地址（og:image / favicon）按 baseUrl 补全 */
function extractMeta(html: string, baseUrl: string): LinkPreview {
  const metas = html.match(/<meta\b[^>]*>/gi) ?? []
  const metaMap = new Map<string, string>()
  for (const tag of metas) {
    const attrs = parseAttrs(tag)
    // property 优先于 name：og 系列用 property，description 用 name，
    // 但也有站点两者写反，所以两个都认（键就是属性值本身）
    const key = (attrs.property || attrs.name || "").trim().toLowerCase()
    const value = tidy(attrs.content ?? "")
    if (key && value && !metaMap.has(key)) metaMap.set(key, value)
  }
  const meta = (k: string): string | null => metaMap.get(k) ?? null

  const title = meta("og:title") ?? meta("twitter:title") ?? extractTitle(html)
  const description =
    meta("og:description") ?? meta("twitter:description") ?? meta("description")
  const imageRaw = meta("og:image") ?? meta("twitter:image")

  return {
    title: title || "",
    description: description || null,
    // og:image 可能是相对路径，补全；data: 之类会被 resolveAbsolute 丢掉
    image: imageRaw ? resolveAbsolute(imageRaw, baseUrl) || null : null,
    icon: extractIconUrl(html, baseUrl) || null,
    siteName: meta("og:site_name"),
  }
}

/** 抓取并解析一个外站 URL 的预览信息 */
async function fetchPreview(url: string): Promise<LinkPreview | null> {
  // 手动逐跳跟随重定向：每一跳都必须过 SSRF 闸（redirect: "follow" 做不到）
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    try {
      assertPublicHttpUrl(current, "链接")
    } catch {
      return null
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          // 伪装成普通浏览器，避免部分站点对非浏览器 UA 返回 403
          "User-Agent":
            "Mozilla/5.0 (compatible; DoulorCloudBot/1.0; +https://cloud.doulor.cn)",
          Accept: "text/html,application/xhtml+xml",
        },
      })
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }

    if (REDIRECT_STATUSES.has(res.status)) {
      const location = res.headers.get("Location")
      if (!location) return null
      try {
        current = new URL(location, current).toString()
      } catch {
        return null
      }
      continue
    }

    // 只处理 HTML
    const contentType = res.headers.get("Content-Type") ?? ""
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      return null
    }
    if (!res.ok) return null

    const html = await readTextCapped(res, MAX_FETCH_BYTES)
    const meta = extractMeta(html, current)
    // 连标题都拿不到就没意义
    if (!meta.title) return null
    return meta
  }
  // 跳数用尽
  return null
}

/**
 * 获取 URL 的预览信息（带缓存）。
 * 返回 null 表示「拿不到预览」（无效 URL / 抓取失败 / 非 HTML），
 * 调用方应回退为普通链接，不展示卡片。
 */
export async function getLinkPreview(env: Env, rawUrl: string): Promise<LinkPreview | null> {
  const url = normalizeUrl(rawUrl)
  if (!url) return null

  // 先查缓存
  const cached = await env.DB.prepare(
    "SELECT title, description, image, icon, site_name, fetched_at FROM link_previews WHERE url = ?"
  )
    .bind(url)
    .first<{
      title: string
      description: string | null
      image: string | null
      icon: string | null
      site_name: string | null
      fetched_at: string
    }>()

  const now = Date.now()
  const ttlMs = PREVIEW_TTL_DAYS * 24 * 60 * 60 * 1000
  if (cached && now - new Date(cached.fetched_at).getTime() < ttlMs) {
    return {
      title: cached.title,
      description: cached.description,
      image: cached.image,
      icon: cached.icon ?? null,
      siteName: cached.site_name,
    }
  }

  // 未命中或已过期：抓取
  const meta = await fetchPreview(url)
  if (!meta) return null

  // 写缓存（有就覆盖，同时刷新 fetched_at）
  await env.DB.prepare(
    `INSERT INTO link_previews (url, title, description, image, icon, site_name, fetched_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET
          title = excluded.title,
          description = excluded.description,
          image = excluded.image,
          icon = excluded.icon,
          site_name = excluded.site_name,
          fetched_at = excluded.fetched_at`
  )
    .bind(
      url,
      meta.title,
      meta.description,
      meta.image,
      meta.icon,
      meta.siteName,
      new Date(now).toISOString()
    )
    .run()

  return meta
}

/**
 * 清理过期缓存（供定时运维调用）。
 * 删除 fetched_at 超过 TTL 的记录，避免表无限增长。
 */
export async function purgeExpiredPreviews(env: Env): Promise<number> {
  const cutoff = new Date(Date.now() - PREVIEW_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const r = await env.DB.prepare("DELETE FROM link_previews WHERE fetched_at < ?")
    .bind(cutoff)
    .run()
  return r.meta?.changes ?? 0
}
