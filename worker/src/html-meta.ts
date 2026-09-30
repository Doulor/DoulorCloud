/**
 * 从 HTML 文本里抠元信息：标题、描述、图标地址，以及「只读前 N 字节」的读取器。
 *
 * 两个地方共用这一份：
 *   · `handlers/fun-link-probe.ts` —— 工具箱「网页分享」的自动识别；
 *   · `link-preview.ts`            —— 社区 / 公告里裸链接渲染成卡片。
 * 抽出来是因为两边都需要「找 title」「找 favicon」这两件事，各写一份迟早会漂移。
 *
 * 用正则而不是完整 HTML 解析器：只需要 head 里的几个标签，够用且零依赖。
 */

const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g

/** 把一个标签里的属性拆成对象（key 统一小写） */
export function parseAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  ATTR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ATTR_RE.exec(tag))) {
    out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? ""
  }
  return out
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
}

function codePoint(n: number, fallback: string): string {
  try {
    return String.fromCodePoint(n)
  } catch {
    return fallback
  }
}

/** 解码 `&amp;` `&#39;` `&#x27;` 这类实体（标题里很常见） */
export function decodeEntities(s: string): string {
  return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) {
      return codePoint(parseInt(code.slice(2), 16), all)
    }
    if (code.startsWith("#")) {
      return codePoint(parseInt(code.slice(1), 10), all)
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? all
  })
}

/** 解实体 + 折叠空白 */
export function tidy(s: string): string {
  return decodeEntities(s).replace(/\s+/g, " ").trim()
}

/** 页面标题（最长 60 字，与保存时的上限一致） */
export function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return m ? tidy(m[1]).slice(0, 60) : ""
}

/** 描述：优先 `<meta name="description">`，其次 og:description */
export function extractMetaDescription(html: string): string {
  const metas = html.match(/<meta\b[^>]*>/gi) ?? []
  let fallback = ""
  for (const tag of metas) {
    const attrs = parseAttrs(tag)
    const key = (attrs.name ?? attrs.property ?? "").trim().toLowerCase()
    if (key !== "description" && key !== "og:description") continue
    const content = tidy(attrs.content ?? "")
    if (!content) continue
    if (key === "description") return content.slice(0, 200)
    if (!fallback) fallback = content
  }
  return fallback.slice(0, 200)
}

/** 相对地址补齐成绝对地址；非 http/https（比如 `data:` 内联图标）一律丢掉 */
export function resolveAbsolute(raw: string, baseUrl: string): string {
  try {
    const abs = new URL(raw, baseUrl)
    if (abs.protocol !== "http:" && abs.protocol !== "https:") return ""
    return abs.toString().slice(0, 500)
  } catch {
    return ""
  }
}

/**
 * 找图标。顺序按通行做法：
 *   普通 icon（多个时挑尺寸最大的）→ apple-touch-icon → 兜底 `/favicon.ico`。
 */
export function extractIconUrl(html: string, baseUrl: string): string {
  const links = html.match(/<link\b[^>]*>/gi) ?? []
  const plain: { href: string; size: number }[] = []
  const apple: { href: string; size: number }[] = []

  for (const tag of links) {
    const attrs = parseAttrs(tag)
    const rel = (attrs.rel ?? "").toLowerCase().trim()
    const href = (attrs.href ?? "").trim()
    if (!href) continue
    const isApple = rel.includes("apple-touch-icon")
    // rel 可能是 "icon" / "shortcut icon" / "icon shortcut" / "apple-touch-icon-precomposed"
    if (!isApple && !/(^|\s)(shortcut\s+)?icon(\s|$)/.test(rel)) continue
    const sizeMatch = (attrs.sizes ?? "").match(/(\d+)\s*x\s*(\d+)/i)
    const size = sizeMatch ? Number(sizeMatch[1]) : 0
    ;(isApple ? apple : plain).push({ href, size })
  }

  // 只留能落成 http/https 绝对地址的候选（内联 `data:` 图标会被 resolveAbsolute 丢掉）
  const pool = (plain.length ? plain : apple)
    .map((c) => ({ size: c.size, abs: resolveAbsolute(c.href, baseUrl) }))
    .filter((c) => c.abs)
  if (pool.length) {
    const best = pool.reduce((a, b) => (b.size > a.size ? b : a))
    return best.abs
  }
  return resolveAbsolute("/favicon.ico", baseUrl)
}

/** 只读前 cap 字节，读完立刻断开——防止对方挂一个几百 MB 的页面把 Worker 拖死 */
export async function readTextCapped(res: Response, cap: number): Promise<string> {
  if (!res.body) return ""
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < cap) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      chunks.push(value)
      total += value.byteLength
    }
  } catch {
    // 读一半断了也能用已经拿到的部分
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* 已经关掉了 */
    }
  }

  const size = Math.min(total, cap)
  const merged = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    if (offset >= size) break
    const take = Math.min(chunk.byteLength, size - offset)
    merged.set(chunk.subarray(0, take), offset)
    offset += take
  }
  return new TextDecoder().decode(merged)
}
