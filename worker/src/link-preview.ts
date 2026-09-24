/**
 * 链接预览：把 URL 解析成「富链接卡片」所需的元数据（标题 / 描述 / 图片 / 站点名）。
 *
 * 为什么在 Worker 端做：浏览器前端受 CORS 限制，不能直接抓取外站；
 * Worker 无此限制，由它去抓目标 URL 的 HTML 并解析 Open Graph 标签。
 * 这也是 Discord / Slack / 飞书等「链接展开卡片」都是服务端抓取的原因。
 *
 * 缓存：同一 URL 被多人引用时不能反复抓，解析结果存 D1（link_previews 表），
 * 过期后重新抓取以反映目标站点内容更新。
 *
 * ⚠️ 安全：
 *   - 只抓 http/https，拒绝其它协议（file://、javascript: 等）。
 *   - 目标响应过大直接放弃（限制抓取字节数），防止被塞超大文件拖垮 Worker。
 *   - 解析用正则而非完整 HTML 解析器，够用且不引入重量级依赖。
 */
import type { Env } from "./env"

/** 预览缓存的有效期（天） */
const PREVIEW_TTL_DAYS = 7

/** 单次抓取最多读取的字节数（约 512KB，足够拿到 head 里的 OG 标签） */
const MAX_FETCH_BYTES = 512 * 1024

/** 抓取超时（毫秒） */
const FETCH_TIMEOUT_MS = 5000

export interface LinkPreview {
  title: string
  description: string | null
  image: string | null
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

/** 从 HTML 文本里提取 og 标签值（也回退到 title / meta description） */
function extractMeta(html: string): LinkPreview {
  const getMeta = (prop: string): string | null => {
    // 优先 og:xxx，其次 name=xxx
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, "i"),
    ]
    for (const p of patterns) {
      const m = p.exec(html)
      if (m && m[1]) return decodeEntities(m[1])
    }
    return null
  }

  const title =
    getMeta("og:title") ??
    getMeta("twitter:title") ??
    /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ??
    null
  const description = getMeta("og:description") ?? getMeta("twitter:description") ?? getMeta("description")
  const image = getMeta("og:image") ?? getMeta("twitter:image")
  const siteName = getMeta("og:site_name")

  return {
    title: title || "",
    description: description || null,
    image: image || null,
    siteName: siteName || null,
  }
}

/** 解码常见 HTML 实体（&amp; &lt; &quot; &#39;） */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
}

/** 抓取并解析一个外站 URL 的预览信息 */
async function fetchPreview(url: string): Promise<LinkPreview | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        // 伪装成普通浏览器，避免部分站点对非浏览器 UA 返回 403
        "User-Agent":
          "Mozilla/5.0 (compatible; DoulorCloudBot/1.0; +https://cloud.doulor.cn)",
        Accept: "text/html,application/xhtml+xml",
      },
    })
    // 只处理 HTML
    const contentType = res.headers.get("Content-Type") ?? ""
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      return null
    }
    if (!res.ok) return null

    const reader = res.body?.getReader()
    if (!reader) return null

    let received = 0
    const chunks: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      chunks.push(value)
      if (received >= MAX_FETCH_BYTES) break
    }

    const html = new TextDecoder().decode(concatBytes(chunks, received))
    const meta = extractMeta(html)
    // 连标题都拿不到就没意义
    if (!meta.title) return null
    return meta
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
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
    "SELECT title, description, image, site_name, fetched_at FROM link_previews WHERE url = ?"
  )
    .bind(url)
    .first<{
      title: string
      description: string | null
      image: string | null
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
      siteName: cached.site_name,
    }
  }

  // 未命中或已过期：抓取
  const meta = await fetchPreview(url)
  if (!meta) return null

  // 写缓存（有就覆盖，同时刷新 fetched_at）
  await env.DB.prepare(
    `INSERT INTO link_previews (url, title, description, image, site_name, fetched_at)
          VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET
          title = excluded.title,
          description = excluded.description,
          image = excluded.image,
          site_name = excluded.site_name,
          fetched_at = excluded.fetched_at`
  )
    .bind(url, meta.title, meta.description, meta.image, meta.siteName, new Date(now).toISOString())
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
