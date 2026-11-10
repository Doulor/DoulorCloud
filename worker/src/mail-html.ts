/**
 * 收件箱 HTML 消毒器（白名单）。
 *
 * 背景：收件箱原先只存纯文本（`htmlToText` 把 HTML 拍平），营销邮件 / 验证邮件
 * 的排版、按钮、表格全丢，站长反馈「体验不好」。现在保留 HTML，但**入库前必须
 * 消毒** —— 正文是第三方完全可控的内容。
 *
 * 三层防御（本文件只是第一层，别把它当成唯一保险）：
 *   1. **本文件**：白名单渲染。不在白名单的标签、属性、协议一律丢掉；
 *      `<script>/<style>/<iframe>/<svg>` 这类**连内容一起丢**。
 *   2. **前端**：消毒后的 HTML 只塞进 `sandbox`（**不含 allow-scripts**）的 iframe，
 *      就算这里被绕过漏进一个 `<script>`，它也不会执行、也摸不到本站 cookie。
 *   3. **网络**：所有会「向外发起请求」的东西都不允许 ——
 *      图片地址只留成 `data-mail-src`（浏览器**不会**加载它），
 *      读取时再由 mail-images.ts 换成我们自己的签名代理地址；
 *      `style` 里出现 `url(...)` 就整条属性丢弃（`background-image` 同样是回连）。
 *
 * 为什么图片要绕一道代理，而不是直接删掉：
 *   直接删 = 发件人拿不到任何回连（最安全），但收件箱里全是空白和裂图。
 *   走代理 = 发件人只看到 Cloudflare 的出口 IP，看不到用户的 IP / 地区；
 *   同时代理侧拦掉 SVG（可内嵌脚本）与非图片类型，风险面收窄到「一次图片下载」。
 *   ——「这封信被打开了」这件事仍可能被唯一的图片 URL 暴露，这是代理方案
 *   的固有残留，已在 mail-images.ts 里写明。
 *
 * ⚠️ 这是入站投递路径上的代码：`incomingEmail` 一旦抛错，Cloudflare Email Routing
 *    会**重投**同一封邮件。所以：
 *      · 全程单遍线性扫描，不跑复杂正则（历史教训见 email-delivery.ts 的 P0-4）；
 *      · 输入有硬上限，超了直接截断；
 *      · 任何解析不出来的畸形结构都**当文本处理**，绝不抛错。
 */

/**
 * 输入上限（字符）。与 `MAX_BODY_CHARS` 同量级：
 * 原文最大 2MB，这里截到 256K 之后再做白名单重建，输出也在这个量级内。
 */
export const MAX_MAIL_HTML_CHARS = 256 * 1024

/** 允许保留的标签（其余一律丢标签、保留内部文字） */
const ALLOWED_TAGS = new Set([
  "a", "abbr", "address", "article", "aside", "b", "big", "blockquote", "br",
  "caption", "center", "cite", "code", "col", "colgroup", "dd", "del", "div",
  "dl", "dt", "em", "figcaption", "figure", "font", "footer", "h1", "h2", "h3",
  "h4", "h5", "h6", "header", "hr", "i", "img", "ins", "kbd", "li", "main",
  "nav", "ol", "p", "pre", "q", "s", "samp", "section", "small", "span",
  "strike", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th",
  "thead", "tr", "u", "ul", "var", "wbr",
])

/** 自闭合 / 空元素 */
const VOID_TAGS = new Set(["br", "hr", "img", "wbr", "col"])

/**
 * 连**内容一起**丢弃的标签。
 * `<script>` 里的 JS 如果只丢标签会把源码当正文吐出来；`<style>` 同理；
 * `<iframe>/<svg>/<math>/<template>` 则是可以藏脚本或外部加载的容器。
 */
const DROP_WITH_CONTENT = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet",
  "svg", "math", "template", "noscript", "head", "title", "link", "meta", "base",
  "form", "input", "button", "textarea", "select", "option", "optgroup",
  "audio", "video", "canvas", "map", "area", "portal", "slot",
])

/** 这些丢弃标签本身是空元素，没有闭合标签要跳过 */
const DROP_VOID = new Set(["link", "meta", "base", "input", "area", "frame"])

/**
 * 「原始文本」元素：内容一直延续到闭合标签为止，里面不解析其它标签。
 *
 * 没有闭合标签时，浏览器会把**文档剩余部分**全当它的内容（页面一片空白）。
 * 这里必须照同样处理：否则 `<script>alert(1)` 之后的所有东西都会被当正文
 * 显示出来 —— 用户会看到一段 JS 源码。
 */
const RAW_TEXT_DROP = new Set(["script", "style"])

/** 所有标签都允许的属性（值还要再过一遍校验） */
const GLOBAL_ATTRS = new Set(["style", "title", "dir", "lang", "align"])

/** 按标签细分的属性白名单 */
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "name"]),
  img: new Set(["alt", "width", "height", "border"]),
  font: new Set(["color", "face", "size"]),
  table: new Set(["width", "border", "cellpadding", "cellspacing", "bgcolor", "summary"]),
  caption: new Set(["align"]),
  col: new Set(["span", "width"]),
  colgroup: new Set(["span", "width"]),
  tr: new Set(["valign", "bgcolor", "height"]),
  td: new Set(["colspan", "rowspan", "width", "height", "valign", "bgcolor", "nowrap"]),
  th: new Set(["colspan", "rowspan", "width", "height", "valign", "bgcolor", "nowrap", "scope"]),
  ol: new Set(["start", "type"]),
  ul: new Set(["type"]),
  li: new Set(["value", "type"]),
  hr: new Set(["width", "size", "noshade"]),
  q: new Set(["cite"]),
  blockquote: new Set(["cite"]),
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  copy: "\u00a9",
  reg: "\u00ae",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
}

function isSpace(c: number): boolean {
  // 空格 / \t / \n / \r / \f
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12
}

function isNameChar(c: number): boolean {
  // 字母 / 数字 / - / : / _
  return (
    (c >= 97 && c <= 122) ||
    (c >= 65 && c <= 90) ||
    (c >= 48 && c <= 57) ||
    c === 45 ||
    c === 58 ||
    c === 95
  )
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/**
 * 解码常见实体。
 *
 * 为什么必须先解码再校验：浏览器解析属性值时会解实体，所以
 * `href="javascript&#58;alert(1)"` 在浏览器眼里就是 `javascript:alert(1)`。
 * 只看原始字符串的过滤器会被这一手绕过。
 */
function decodeEntities(s: string): string {
  if (s.indexOf("&") < 0) return s
  return s.replace(/&(#[xX]?[0-9a-fA-F]{1,6}|[a-zA-Z]{2,10});/g, (m, body: string) => {
    if (body.charCodeAt(0) === 35 /* # */) {
      const hex = body[1] === "x" || body[1] === "X"
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return ""
      // 控制字符（除制表/换行）一律丢掉：它们常被用来切碎 `javascript:` 这类关键字
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) return ""
      try {
        return String.fromCodePoint(code)
      } catch {
        return ""
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m
  })
}

interface ParsedTag {
  name: string
  closing: boolean
  selfClosing: boolean
  attrs: { name: string; value: string }[]
  /** 标签结束（`>` 之后）的位置 */
  end: number
}

/**
 * 从 `<` 处读一个标签。
 *
 * 只做词法，不做语义；畸形内容返回 null，由调用方当文本处理。
 * 属性值里的 `>` 不会被误判成标签结束（引号内不算）。
 */
function readTag(src: string, lt: number): ParsedTag | null {
  const n = src.length
  let j = lt + 1
  let closing = false

  if (src.charCodeAt(j) === 47 /* / */) {
    closing = true
    j++
  }
  const nameStart = j
  while (j < n && isNameChar(src.charCodeAt(j))) j++
  if (j === nameStart) return null
  const name = src.slice(nameStart, j).toLowerCase()

  const attrs: { name: string; value: string }[] = []
  let selfClosing = false

  while (j < n) {
    while (j < n && isSpace(src.charCodeAt(j))) j++
    if (j >= n) break
    const c = src.charCodeAt(j)
    if (c === 62 /* > */) {
      j++
      break
    }
    if (c === 47 /* / */) {
      if (src.charCodeAt(j + 1) === 62) {
        selfClosing = true
        j += 2
        break
      }
      j++
      continue
    }

    const aStart = j
    while (j < n) {
      const cc = src.charCodeAt(j)
      if (isSpace(cc) || cc === 61 /* = */ || cc === 62 /* > */) break
      j++
    }
    const aName = src.slice(aStart, j).toLowerCase()

    while (j < n && isSpace(src.charCodeAt(j))) j++

    let value = ""
    if (src.charCodeAt(j) === 61 /* = */) {
      j++
      while (j < n && isSpace(src.charCodeAt(j))) j++
      const q = src.charCodeAt(j)
      if (q === 34 || q === 39) {
        j++
        const vStart = j
        while (j < n && src.charCodeAt(j) !== q) j++
        value = src.slice(vStart, j)
        if (j < n) j++
      } else {
        const vStart = j
        while (j < n) {
          const cc = src.charCodeAt(j)
          if (isSpace(cc) || cc === 62) break
          j++
        }
        value = src.slice(vStart, j)
      }
    }

    if (aName) attrs.push({ name: aName, value })
  }

  return { name, closing, selfClosing, attrs, end: j }
}

/**
 * 校验链接。只放行 http / https / mailto ——
 * `javascript:` / `data:` / `vbscript:` 以及**相对地址**一律丢弃。
 *
 * 为什么要丢相对地址：消毒后的片段最终会落进我们的文档上下文，`/dashboard`
 * 这类相对链接会被解析成**本站**地址，等于让发件人借我们的域名做钓鱼。
 */
function safeHref(raw: string): string | null {
  const v = decodeEntities(raw).trim()
  if (!v || v.length > 2048) return null
  // 判协议前先去掉所有空白与控制字符，防止 "java\tscript:" 这种切碎写法
  const compact = v.replace(/[\u0000-\u0020\u007f]/g, "").toLowerCase()
  if (!/^(https?:\/\/|mailto:)/.test(compact)) return null
  return v
}

/**
 * 校验图片地址：只收 http / https（不收 mailto / data:）。
 *
 * ⚠️ 返回值只是「原始地址」，**不会**被当作 `src` 输出 ——
 * 调用方必须把它放进 `data-mail-src`。浏览器不加载这个属性，
 * 图片只有在读取侧（mail-images.ts）换成签名代理地址后才会请求。
 */
function safeImageSrc(raw: string): string | null {
  const v = decodeEntities(raw).trim()
  if (!v || v.length > 2048) return null
  const compact = v.replace(/[\u0000-\u0020\u007f]/g, "").toLowerCase()
  if (!/^https?:\/\//.test(compact)) return null
  return v
}

/**
 * 校验内联样式。
 *
 * 允许它是因为：绝大多数邮件用 `style` 属性排版，全砍掉基本就只剩一堆散字。
 * 但 `url(...)` 会让浏览器去拉外部资源（背景图 = 另一种追踪像素），
 * `expression()` / `behavior` 是 IE 时代的脚本入口，一律整条丢弃。
 */
function safeStyle(raw: string): string | null {
  const v = decodeEntities(raw).trim()
  if (!v || v.length > 400) return null
  /**
   * 反斜杠一律拒绝。
   *
   * CSS 允许用转义序列拼出关键字：`background:\75 rl(https://x/p.png)`
   * 在浏览器里就是 `background:url(...)` —— 只匹配字面 `url(` 会被绕过，
   * 结果是发件人依然能拿到「谁在什么时候打开了邮件」。正常的邮件排版
   * 用不到反斜杠转义，直接整条丢弃最省事。
   */
  if (v.includes("\\")) return null
  if (/url\s*\(|image-set\s*\(|expression\s*\(|javascript\s*:|vbscript\s*:|behavior\s*:|-moz-binding|@import/i.test(v)) {
    return null
  }
  if (/[<>]/.test(v)) return null
  return v
}

/** 重建属性串 */
function rebuildAttrs(tag: string, attrs: { name: string; value: string }[]): string {
  const allowed = TAG_ATTRS[tag]
  const out: string[] = []

  for (const a of attrs) {
    const name = a.name
    // 事件处理器（onerror / onclick / onload…）绝对不放行
    if (name.startsWith("on")) continue

    if (name === "href") {
      if (tag !== "a") continue
      const href = safeHref(a.value)
      if (!href) continue
      out.push(`href="${escapeHtml(href)}"`)
      continue
    }

    if (name === "style") {
      const style = safeStyle(a.value)
      if (!style) continue
      out.push(`style="${escapeHtml(style)}"`)
      continue
    }

    if (name === "src") {
      // 只对 <img> 放行，而且改写成浏览器不会自动加载的 data-mail-src
      if (tag !== "img") continue
      const src = safeImageSrc(a.value)
      if (!src) continue
      out.push(`data-mail-src="${escapeHtml(src)}"`)
      continue
    }

    // srcset / background / formaction / action 等一切「加载或提交」类属性
    if (name === "srcset" || name === "background" || name === "formaction" || name === "action" || name === "poster" || name === "data") {
      continue
    }

    if (!GLOBAL_ATTRS.has(name) && !allowed?.has(name)) continue

    const value = decodeEntities(a.value)
    if (value.length > 200) continue
    out.push(`${name}="${escapeHtml(value)}"`)
  }

  // 外链一律新开标签页，并且断掉 opener：邮件里的链接默认不可信
  if (tag === "a") {
    out.push('target="_blank"', 'rel="noopener noreferrer nofollow"')
  }

  return out.length ? ` ${out.join(" ")}` : ""
}

/**
 * 消毒一份邮件 HTML，返回可安全渲染的片段。
 *
 * 输入为空、全被过滤、或解析异常时返回 `""`（调用方据此回落到纯文本）。
 */
export function sanitizeMailHtml(input: string | null | undefined): string {
  if (!input) return ""
  const src = input.length > MAX_MAIL_HTML_CHARS ? input.slice(0, MAX_MAIL_HTML_CHARS) : input
  // 预先把整串转小写用于「跳过丢弃标签内容」的查找，
  // 避免每次 indexOf 都重新 toLowerCase（那会退化成 O(n²)）
  const lower = src.toLowerCase()
  const n = src.length
  const out: string[] = []
  let i = 0

  /**
   * 已输出的开标签栈。
   *
   * 为什么需要：`</a>` 这类闭合标签不能无条件输出 —— 开标签可能已经因为
   * 「href 不安全」被丢掉，此时再吐一个 `</a>` 就多出一个孤立闭合标签。
   * 这里只认**栈顶匹配**：对不上的闭合标签直接忽略，未闭合的标签交给浏览器
   * 在文档末尾自动收尾（HTML 解析器本身就这么容错）。
   */
  const openStack: string[] = []

  /**
   * 「按标签名找闭合标签失败」的记忆位。
   *
   * 没有它的话，一封全是 `<script>` 却没有 `</script>` 的邮件会让每次跳过
   * 都一路扫到串尾 —— 4 万个 `<script>` × 256KB = 几十 GB 的扫描量，
   * 直接把这次投递拖到 CPU 超时（进而被 Email Routing 重投，反复烧）。
   * 记下「从这个位置往后找必然失败」，后续判断就是 O(1)。
   *
   * ⚠️ 必须**按标签名**分开记：`<script>` 找不到闭合标签，不代表 `<style>` 也找不到。
   * 共用一个记录会让后面的 `<style>…</style>` 整段跳过、把 CSS 当正文漏出来。
   */
  const deadDropFrom = new Map<string, number>()

  const pushText = (raw: string): void => {
    if (!raw) return
    const escaped = escapeHtml(decodeEntities(raw))
    if (escaped) out.push(escaped)
  }

  while (i < n) {
    const lt = src.indexOf("<", i)

    if (lt < 0) {
      pushText(src.slice(i))
      break
    }
    if (lt > i) pushText(src.slice(i, lt))

    // 注释 / DOCTYPE / CDATA / 处理指令：整段丢掉
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4)
      i = end < 0 ? n : end + 3
      continue
    }
    if (src.startsWith("<!", lt) || src.startsWith("<?", lt)) {
      const end = src.indexOf(">", lt)
      i = end < 0 ? n : end + 1
      continue
    }

    const tag = readTag(src, lt)
    if (!tag) {
      // 畸形的 `<`：当普通字符输出，别吞掉后面的正文
      pushText("<")
      i = lt + 1
      continue
    }
    i = tag.end

    if (tag.closing) {
      const top = openStack.length > 0 ? openStack[openStack.length - 1] : ""
      if (top === tag.name) {
        openStack.pop()
        out.push(`</${tag.name}>`)
      }
      continue
    }

    if (DROP_WITH_CONTENT.has(tag.name)) {
      if (DROP_VOID.has(tag.name) || tag.selfClosing) continue
      const closeTag = `</${tag.name}`
      const dead = deadDropFrom.get(tag.name)
      if (dead !== undefined && tag.end >= dead) {
        // 已经知道往后找不到闭合标签：只丢这个开标签，正文照常保留
        continue
      }
      const closeAt = lower.indexOf(closeTag, tag.end)
      if (closeAt < 0) {
        deadDropFrom.set(tag.name, tag.end)
        // 原始文本元素没有闭合标签 ⇒ 剩下的都是它的内容，全部丢弃（与浏览器一致）
        if (RAW_TEXT_DROP.has(tag.name)) i = n
        continue
      }
      const gt = src.indexOf(">", closeAt)
      i = gt < 0 ? n : gt + 1
      continue
    }

    // 未知标签：丢标签、保留内部文字（例如 Word 导出的 <o:p>）
    if (!ALLOWED_TAGS.has(tag.name)) continue

    /**
     * `<a>` 没有（安全的）href 时整个标签都不输出。
     *
     * 否则会渲染出一段「蓝色下划线、看着能点、其实点不动」的文字 ——
     * 这种假链接正是钓鱼邮件爱用的样子，不该在收件箱里保留。
     */
    if (
      tag.name === "a" &&
      !tag.attrs.some((a) => a.name === "href" && safeHref(a.value))
    ) {
      continue
    }

    out.push(`<${tag.name}${rebuildAttrs(tag.name, tag.attrs)}>`)
    if (VOID_TAGS.has(tag.name) || tag.selfClosing) continue
    openStack.push(tag.name)
  }

  const html = out.join("").trim()
  // 全被过滤干净时返回空串，让调用方回落到纯文本（否则用户会看到一张空白卡片）
  return html
}
