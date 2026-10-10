/**
 * AI实验室的「agent 内核」—— 与 UI 无关的纯逻辑。
 *
 * 为什么不用原生 function calling：
 *   站内额度走的是中转站，各条上游渠道对 `tools` 的支持参差不齐（免费渠道尤其）。
 *   这里改用**带标签的文本协议**（<lab_write> / <lab_read> / …），
 *   任何能聊天的模型都能用，而且 SSE 流式解析很好做。
 *
 * 协议（模型侧的约定）：
 *   <lab_write path="index.html">…完整内容…</lab_write>
 *   <lab_read path="style.css"/>
 *   <lab_list/>
 *   <lab_delete path="old.js"/>
 *   <lab_grep pattern="btn|按钮" in="*.html"/>
 *   <lab_need_vm/>                 （申请启用浏览器终端，会弹给用户确认）
 *   <lab_run>ls -la</lab_run>      （在浏览器终端里执行命令）
 *   标签之外的自然语言会被当成「旁白」原样显示给用户。
 */

export type FileMap = Record<string, string>

/**
 * 一轮对话里给模型的消息。
 * `content` 是字符串（纯文本）或 part 数组（带图的多模态）。
 * ⚠️ 必须与后端 `worker/src/handlers/lab.ts` 的 `ChatMessage` 保持一致 ——
 * 后端只认 `text` / `image_url` 两种 part，且图片只收 data URL（不收 http 地址，防 SSRF）。
 */
export type LabConvoPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }

export interface LabConvoMessage {
  role: string
  content: string | LabConvoPart[]
}

export type ToolName =
  | "write"
  | "read"
  | "replace"
  | "list"
  | "delete"
  | "grep"
  | "need_vm"
  | "run"
  /** 调用一次「站内操作」（子域名 / DNS / 邮箱 / 网盘…），op 表示具体动作 */
  | "site"
  /** 请求注入「站内操作手册」——手册很长，按需给，不常驻系统提示 */
  | "site_manual"
  /**
   * 读取一个「技能」的正文 —— 渐进式披露的第二步。
   * 系统提示里只有技能的「名字 + 一句话」，模型判断相关时才用它去读全文。
   */
  | "skill"
  /** 联网搜索（Tavily）。**必须经服务端**——key 只在服务端，浏览器拿不到。 */
  | "web_search"

/** 从（可能还没流完的）模型输出里解析出的片段，按出现顺序排列 */
export type Segment =
  | { type: "text"; text: string }
  | {
      type: "action"
      tool: ToolName
      path?: string
      /** 仅 grep 用：正则；`in` 是可选的文件通配范围（如 *.html） */
      pattern?: string
      scope?: string
      /** 仅 <lab_site> 用：要执行哪个操作（见 lab-site.ts 的 SITE_OPS） */
      op?: string
      /** 仅 <lab_skill> 用：要读哪个技能（见迁移 0141 的 lab_skills.name） */
      skill?: string
      /** 仅 <lab_web_search> 用：搜索关键词 */
      query?: string
      content: string
      complete: boolean
    }

/**
 * 单次对话里的轮数**不设上限**。
 *
 * 2026-10-09 站长要求：去掉「最多 25 轮」与「连续几轮没改文件就掐掉」两条强制中断 ——
 * 它们会在做正经长任务时半路打断，体验很差。现在循环只在这三种情况下结束：
 *   1. 模型自己判断做完了（不再输出工具标签）；
 *   2. 用户点「停止」（abort）；
 *   3. 出错。
 * 代价：模型若原地打转，会一直消耗额度直到用户手动停 —— 这是明确接受的取舍。
 */

/** 读文件回喂给模型时的单文件上限 */
const MAX_READBACK_CHARS = 20_000

// ⚠️ 交替分支里 `site_manual` 必须排在 `site` **前面**：
// 虽然末尾的 \b 已经能挡住把 lab_site_manual 误读成 lab_site（"e" 与 "_" 之间没有词边界），
// 但顺序写对更不容易被人改坏。
const TAG_RE =
  /^<lab_(write|read|replace|list|delete|grep|run|need_vm|site_manual|skill|web_search|site)\b([^>]*?)(\/?)>$/

/**
 * 带正文体、需要等闭合标签的工具。
 * `<lab_site>` 的正文是一段 JSON 参数（可空 → 写成自闭合也行）。
 */
const BODY_TOOLS: ToolName[] = ["write", "replace", "run", "site"]

/**
 * 解析模型输出。传入的可以是**还没流完**的半截文本：
 * 未闭合的 <lab_write> 会以 complete=false 返回，UI 据此显示「正在写入」。
 */
export function parseAgentText(text: string): Segment[] {
  const segments: Segment[] = []
  let buf = ""
  let i = 0

  const flush = () => {
    const t = buf.trim()
    if (t) segments.push({ type: "text", text: t })
    buf = ""
  }

  while (i < text.length) {
    const lt = text.indexOf("<lab_", i)
    if (lt === -1) {
      buf += text.slice(i)
      break
    }
    buf += text.slice(i, lt)

    const gt = text.indexOf(">", lt)
    if (gt === -1) break // 标签还没收尾，等下一个 delta

    const head = text.slice(lt, gt + 1)
    const m = TAG_RE.exec(head)
    if (!m) {
      // 形如 <lab_xxx 但不是合法标签：当普通文字
      buf += head
      i = gt + 1
      continue
    }

    const tool = m[1] as ToolName
    const path = /path\s*=\s*["']([^"']*)["']/.exec(m[2])?.[1]
    const pattern = /pattern\s*=\s*["']([^"']*)["']/.exec(m[2])?.[1]
    const scope = /\bin\s*=\s*["']([^"']*)["']/.exec(m[2])?.[1]
    const op = /\bop\s*=\s*["']([^"']*)["']/.exec(m[2])?.[1]
    // <lab_skill name="pdf-forms"/> —— 用 name 属性（和站点技能表的主键同名）
    const skill = /\bname\s*=\s*["']([^"']*)["']/.exec(m[2])?.[1]
    // <lab_web_search query="…"/> —— 搜索关键词单独一个属性，别和 grep 的 pattern 混用
    const query = /\bquery\s*=\s*["']([^"']*)["']/.exec(m[2])?.[1]
    const selfClosed = m[3] === "/"

    if (BODY_TOOLS.includes(tool) && !selfClosed) {
      const closer = `</lab_${tool}>`
      const close = text.indexOf(closer, gt + 1)
      if (close === -1) {
        flush()
        segments.push({
          type: "action",
          tool,
          path,
          op,
          skill,
          query,
          content: text.slice(gt + 1).replace(/^\n/, ""),
          complete: false,
        })
        i = text.length
        break
      }
      flush()
      segments.push({
        type: "action",
        tool,
        path,
        op,
        skill,
        query,
        content: text.slice(gt + 1, close).replace(/^\n/, ""),
        complete: true,
      })
      i = close + closer.length
    } else {
      flush()
      segments.push({
        type: "action",
        tool,
        path,
        pattern,
        scope,
        op,
        skill,
        query,
        content: "",
        complete: true,
      })
      i = gt + 1
    }
  }

  flush()
  /**
   * 清掉「多出来的闭合标签」。
   *
   * 模型偶尔会连着吐好几个 `</lab_write>`（尤其是几轮写入之后），
   * 这些闭合标签既不是任何标签的开头、也没有配对的开始标签 ⇒ 会被当成正文原样显示，
   * 用户看到的就是一串莫名其妙的符号（2026-10-09 站长反馈「经常蹦出奇怪的结构」）。
   * 只清理 text 片段；action 的正文（文件内容）原样保留 —— 那里出现同样的字符串是合法的。
   */
  return segments
    .map((s) =>
      s.type === "text"
        ? { ...s, text: s.text.replace(/<\/lab_[a-z_]+>/gi, "").trim() }
        : s
    )
    .filter((s) => s.type !== "text" || s.text.length > 0)
}

/**
 * 需要回喂结果的动作：读 / 列 / 删 / 搜索（写和改只要成功就不用回）。
 * 另外：任何动作**失败**了也要回喂（否则模型以为改成功了，后面越改越乱）。
 */
export function needsToolResult(
  segments: Segment[],
  failures?: Map<number, string>
): boolean {
  if (failures && [...failures.values()].some((v) => v)) return true
  return segments.some(
    (s) =>
      s.type === "action" &&
      s.complete &&
      (s.tool === "read" ||
        s.tool === "list" ||
        s.tool === "delete" ||
        s.tool === "grep" ||
        s.tool === "run" ||
        s.tool === "site" ||
        // 技能正文要去服务端取，必须回喂一轮把正文交给模型，否则它拿不到内容
        s.tool === "skill" ||
        // 搜索结果同理：key 在服务端，结果必须回喂
        s.tool === "web_search")
  )
}

/**
 * 「你还没说话」的一次性提醒。
 *
 * 现场（2026-10-09 站长反馈「AI 还是会啥都不说直接结束」）：
 *   循环的结束条件之一是 `!needsToolResult(...)` —— 而 `write` / `replace` 这类
 *   **不需要回喂结果**的动作，会让循环在「模型刚写完文件」当场就 break。
 *   如果模型打算「先写文件、下一轮再总结」，它**永远等不到那一轮**：
 *   用户看到的就是「文件写完了，然后一句话都没有，结束了」。
 *   模型只输出思考（reasoning）而没有正文时同样如此。
 *   这不是提示词问题，是循环缺少「收尾机会」——所以在这里补一次，且**只补一次**。
 */
export const CLOSING_NUDGE =
  "（系统）你刚才这一轮没有给用户任何文字（只调用了工具，或者只输出了思考）。" +
  "如果活已经干完：请用中文写 3～6 行收尾说明（做了什么、涉及哪些文件、用户怎么看到效果），" +
  "不要再调用工具；如果还没干完：继续调用工具。不要只输出思考就停住。"

/**
 * 把已执行的动作结果拼成一条「用户消息」回喂给模型（非原生 tool 协议下最稳的做法）。
 * `failures` 是「第几个动作失败了 + 为什么」，只需要在出错时才占用一轮。
 * `runResults` 是 `<lab_run>` 的结果（已由调用方格式化成文本，这里不关心它怎么来的）。
 */
export function buildToolResults(
  segments: Segment[],
  files: FileMap,
  failures?: Map<number, string>,
  runResults?: Map<number, string>,
  siteResults?: Map<number, string>,
  skillResults?: Map<number, string>,
  searchResults?: Map<number, string>
): string {
  const parts: string[] = ["工具执行结果："]
  segments.forEach((s, i) => {
    if (s.type !== "action" || !s.complete) return
    if (s.tool === "read") {
      const content = s.path ? files[s.path] : undefined
      if (content == null) {
        parts.push(`[读取 ${s.path}]\n(文件不存在)`)
      } else {
        const clipped =
          content.length > MAX_READBACK_CHARS
            ? content.slice(0, MAX_READBACK_CHARS) + "\n…（内容过长已截断）"
            : content
        parts.push(`[读取 ${s.path}]\n${clipped}`)
      }
    } else if (s.tool === "list") {
      const paths = Object.keys(files).sort()
      parts.push(`[文件列表]\n${paths.length ? paths.join("\n") : "(空)"}`)
    } else if (s.tool === "grep") {
      const hit = grepFiles(files, s.pattern ?? "", s.scope)
      parts.push(`[搜索 /${s.pattern ?? ""}/ ${s.scope ? `范围 ${s.scope} ` : ""}]\n${hit}`)
    } else if (s.tool === "delete") {
      parts.push(`[删除 ${s.path}] ${s.path && s.path in files ? "失败" : "成功"}`)
    } else if (s.tool === "run") {
      const formatted = runResults?.get(i)
      parts.push(
        formatted ??
          `[执行命令] ${s.content.trim()}\n(没能执行：浏览器终端未就绪 —— 需要先申请 <lab_need_vm/>)`
      )
    } else if (s.tool === "web_search") {
      parts.push(
        searchResults?.get(i) ??
          `[联网搜索 ${s.query ?? "?"}] (没搜到：这次轮次被中断了，可以重试一次)`
      )
    } else if (s.tool === "skill") {
      parts.push(
        skillResults?.get(i) ??
          `[技能 ${s.skill ?? "?"}] (没读到：这次轮次被中断了，可以重试一次)`
      )
    } else if (s.tool === "site") {
      parts.push(
        siteResults?.get(i) ??
          `[站内操作 ${s.op ?? "?"}] (没能执行：这一轮被中断了，可以重试一次)`
      )
    } else if (failures?.get(i)) {
      const verb = s.tool === "write" ? "写入" : "修改"
      parts.push(`[${verb} ${s.path} 失败] ${failures.get(i)}`)
    }
  })
  parts.push("\n请根据结果继续。")
  return parts.join("\n\n")
}

// ---------------------------------------------------------------------------
// <lab_grep>：在项目里正则搜索（相当于 agent 的「grep」，避免为了找一行就读整个文件）
// ---------------------------------------------------------------------------

/** 一次搜索最多回喂多少条命中，防止把上下文撑爆 */
const MAX_GREP_HITS = 60
/** 单行命中最多保留多少字符 */
const MAX_HIT_LINE = 200

/** 把 *.html / src/*.js 这种通配符转成正则（没有通配符时按「路径里含这段」处理） */
function scopeToRe(glob: string): RegExp | null {
  const g = glob.trim()
  if (!g || g === "*" || g === "**") return null
  if (!/[*?]/.test(g)) return new RegExp(g.replace(/[.+^${}()|[\]\\]/g, "\\$&"), "i")
  const body = g
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`(^|/)${body}$`, "i")
}

/**
 * 在项目文件里做正则搜索，返回 `路径:行号: 该行内容` 的文本列表。
 * 正则是模型给的，可能非法（比如 `[`）——非法时退化成「按字面量找」，不让它把整轮打断。
 */
export function grepFiles(files: FileMap, pattern: string, scope?: string): string {
  const p = (pattern ?? "").trim()
  if (!p) return "(没有给出要搜索的内容)"
  let re: RegExp
  try {
    re = new RegExp(p, "i")
  } catch {
    re = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
  }
  const scopeRe = scope ? scopeToRe(scope) : null

  const hits: string[] = []
  let truncated = false
  for (const path of Object.keys(files).sort()) {
    if (scopeRe && !scopeRe.test(path)) continue
    const lines = files[path].split("\n")
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue
      if (hits.length >= MAX_GREP_HITS) {
        truncated = true
        break
      }
      hits.push(`${path}:${i + 1}: ${lines[i].trim().slice(0, MAX_HIT_LINE)}`)
    }
    if (truncated) break
  }
  if (!hits.length) return "(没有匹配)"
  return hits.join("\n") + (truncated ? "\n…（命中过多已截断）" : "")
}

// ---------------------------------------------------------------------------
// <lab_replace>：只改文件里的一小段，不用重吐整个文件
// ---------------------------------------------------------------------------

/**
 * 约定格式（用 git 冲突标记那套符号，模型最熟）：
 *
 *   <lab_replace path="style.css">
 *   <<<<<<<
 *   .btn { color: red; }
 *   =======
 *   .btn { color: blue; }
 *   >>>>>>>
 *   </lab_replace>
 *
 * 7 个以上同样的符号都接受，标记行后面的说明文字忽略。
 */
export function parseReplaceContent(
  raw: string
): { old: string; new: string } | null {
  const lines = raw.replace(/^\n/, "").split("\n")
  let iOld = -1
  let iSep = -1
  let iEnd = -1
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim()
    if (iOld === -1) {
      if (/^<{5,}/.test(s)) iOld = i
      continue
    }
    if (iSep === -1) {
      if (/^={5,}/.test(s)) iSep = i
      continue
    }
    if (/^>{5,}/.test(s)) {
      iEnd = i
      break
    }
  }
  if (iOld === -1 || iSep === -1 || iEnd === -1) return null
  return {
    old: lines.slice(iOld + 1, iSep).join("\n"),
    new: lines.slice(iSep + 1, iEnd).join("\n"),
  }
}

/** 在文件里把 old 换成 new。精确匹配不到时退一步做「忽略行首尾空白」的逐行匹配。 */
export function applyReplace(
  files: FileMap,
  path: string,
  oldText: string,
  newText: string
): { ok: true; value: string } | { ok: false; reason: string } {
  const src = files[path]
  if (src == null) return { ok: false, reason: `文件 ${path} 不存在` }
  if (!oldText.trim()) return { ok: false, reason: "没有给出要替换的原文" }

  const idx = src.indexOf(oldText)
  if (idx !== -1) {
    return {
      ok: true,
      value: src.slice(0, idx) + newText + src.slice(idx + oldText.length),
    }
  }

  // 宽松兜底：模型常把缩进/行尾空白写歪，按「去空白后的整行」再找一遍
  const srcLines = src.split("\n")
  const oldLines = oldText.split("\n")
  const norm = (s: string) => s.split("\n").map((l) => l.trim()).join("\n")
  const target = norm(oldText)
  for (let i = 0; i + oldLines.length <= srcLines.length; i++) {
    if (norm(srcLines.slice(i, i + oldLines.length).join("\n")) === target) {
      return {
        ok: true,
        value: [
          ...srcLines.slice(0, i),
          ...newText.split("\n"),
          ...srcLines.slice(i + oldLines.length),
        ].join("\n"),
      }
    }
  }
  return {
    ok: false,
    reason: `没在 ${path} 里找到这段原文（缩进或内容对不上）。请先 <lab_read path="${path}"/> 看准确内容，再用 <lab_replace> 或 <lab_write> 重来。`,
  }
}

// ---------------------------------------------------------------------------
// 预览：把多文件项目「内联」成一份可塞进 iframe 的单文件 HTML
// ---------------------------------------------------------------------------

const EXTERNAL_RE = /^(?:[a-z]+:)?\/\//i

/**
 * 作品在预览里跑之前，先给它装一份**本地存储垫片**。
 *
 * 为什么必须装：
 *   作品跑在 `sandbox`（**故意不带 `allow-same-origin`**）的 iframe 里 —— 这是隔离用户代码的
 *   红线，不能为了功能放开。但代价是文档变成「不透明源」，此时
 *   `window.localStorage` 的**读取本身就会抛 SecurityError**
 *   （"The document is sandboxed and lacks the 'allow-same-origin' flag"）。
 *   于是任何在开头 `localStorage.getItem(...)` 保存进度的作品（小游戏尤其常见）
 *   会在第一行就崩，事件监听全没绑上 ⇒ 表现就是「页面能打开，但按钮点了没反应」
 *   （2026-10-09 站长反馈：上传本地小游戏后按钮无响应，实测该 HTML 里有 40 处 localStorage）。
 *
 * 做法：先探一下真身能不能用；能用就原样不碰（正常域名下的预览完全不受影响），
 *   不能用就 `Object.defineProperty` 覆盖成一份**内存版 Storage**：
 *   接口对齐（getItem/setItem/removeItem/clear/key/length），当次会话内可读写，
 *   刷新后清空 —— 对预览来说足够，也避免了「每个作品都能往浏览器里塞持久数据」。
 */
const STORAGE_SHIM = `<script>(function(){var make=function(){var m={};var api={getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(m,k)?m[k]:null},setItem:function(k,v){m[String(k)]=String(v)},removeItem:function(k){delete m[String(k)]},clear:function(){m={}},key:function(i){var ks=Object.keys(m);return i>=0&&i<ks.length?ks[i]:null}};try{Object.defineProperty(api,"length",{get:function(){return Object.keys(m).length}})}catch(e){}return api};var live=function(s){try{s.setItem("__lab_probe__","1");s.removeItem("__lab_probe__");return true}catch(e){return false}};var install=function(name,fallback){var real=null;try{real=window[name]}catch(e){real=null}if(real&&live(real))return;try{Object.defineProperty(window,name,{configurable:true,get:function(){return fallback}})}catch(e){}};install("localStorage",make());install("sessionStorage",make());})();</script>`

/** 把垫片插到最前面（紧跟 <head>，确保早于作品自己的脚本执行） */
function withStorageShim(html: string): string {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + STORAGE_SHIM)
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + STORAGE_SHIM)
  return STORAGE_SHIM + html
}

/**
 * 单文件预览的限制：iframe 里没有「域名 + 目录」的概念，
 * 所以 ./style.css、./app.js 这类相对引用必须先内联进去。
 * 只处理 link[rel=stylesheet] 与 script[src]，其余（图片、fetch）暂不支持。
 */
export function buildPreviewDoc(files: FileMap): string {
  // 注意：这里要挑的是「文件名」，不是文件内容——写成 files["index.html"] 会拿到正文，
  // 再去 files[正文] 查必然是 undefined，预览就永远空白。
  const paths = Object.keys(files)
  const entry = paths.includes("index.html")
    ? "index.html"
    : (paths.find((p) => p.endsWith(".html")) ?? paths[0])
  if (!entry) return ""
  let html = files[entry]
  if (!html) return ""

  const lookup = (ref: string): string | undefined => {
    const clean = ref.split("?")[0].split("#")[0]
    const direct = clean.replace(/^\.\//, "").replace(/^\/+/, "")
    if (files[direct] != null) return files[direct]
    // 相对入口文件所在目录解析（入口在子目录时也能对上）
    const base = entry.includes("/") ? entry.replace(/[^/]+$/, "") : ""
    const joined = base + direct
    return files[joined]
  }

  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/\brel\s*=\s*["']?stylesheet/i.test(tag)) return tag
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]
    if (!href || EXTERNAL_RE.test(href)) return tag
    const css = lookup(href)
    return css == null ? tag : `<style>\n${css}\n</style>`
  })

  html = html.replace(
    /<script\b([^>]*?)\ssrc\s*=\s*["']([^"']+)["']([^>]*?)>\s*<\/script>/gi,
    (tag, pre: string, src: string, post: string) => {
      if (EXTERNAL_RE.test(src)) return tag
      const js = lookup(src)
      if (js == null) return tag
      const attrs = `${pre}${post}`.replace(/\stype\s*=\s*["'][^"']*["']/i, "")
      return `<script${attrs}>\n${js}\n</script>`
    }
  )

  return withStorageShim(html)
}

/** 转义 HTML 属性值（把整篇作品塞进 srcdoc="…" 里时用；先 & 后 "，顺序不能反） */
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
}

/**
 * 新标签预览的空壳页地址（2026-10-09 起优先走它）。
 *
 * 背景：站长希望预览的地址栏不要是 `blob:https://cloud.doulor.cn/...`。
 * 但 **blob 的 origin 跟着「创建它的页面」走**，光换域名改不了 —— 于是改由
 * tyu.me 自己提供一个空壳页，前端 postMessage 把作品 HTML 传进去。
 *
 * 🔴 改这里必须同步 `scripts/tyu-site-worker/wrangler.toml`：
 *   1) 路由只能是 `tyu.me/*`（写成 `*tyu.me/*` 会吞掉 48 个用户邮箱子域）；
 *   2) 空壳页里的来源白名单要和本站实际入口一致（见 worker 里的 SHELL_ORIGINS）。
 * ⚠️ 空壳页里的注入白名单也必须包含本站所有入口域名，否则握手会被拒。
 */
export const PREVIEW_SHELL_ORIGIN = "https://tyu.me"
export const PREVIEW_SHELL_URL = `${PREVIEW_SHELL_ORIGIN}/p`
/** 可分享作品页的基址：后面拼上作品 id（`/p/<id>`），任何人无需登录都能打开 */
export const PREVIEW_SHARE_URL = PREVIEW_SHELL_URL
/** 空壳页握手成功的回执类型（两侧必须一致） */
export const PREVIEW_SHELL_ACK = "doulor-lab-shell-ack"
/** 空壳页接收作品的指令类型（两侧必须一致） */
export const PREVIEW_SHELL_RENDER = "doulor-lab-shell-render"

/* ------------------------------------------------------------------ */
/* 思考强度                                                            */
/* ------------------------------------------------------------------ */

/**
 * 思考强度五档 —— **取值必须和上游 `reasoning_effort` 完全一致**，别自己编词。
 *
 * 官方口径（2026-10 核对）：
 *   · Codex CLI / 早期推理模型：`none` `minimal` `low` `medium` `high` `xhigh`
 *   · GPT-5.2 系：`none` `low` `medium` `high` `xhigh`
 *   · GPT-5.6 / Claude 这一代：`low` `medium` `high` `xhigh` `max`
 *
 * 这里取的就是最后那条 —— 五个档位在 GPT-5.6 和 Claude 上都成立，
 * 也更贴近用户直觉（低 / 中 / 高 / 超高 / 极致）。低档刻意不用 `none`/`minimal`：
 * 这两个只在部分模型上有效，而 `low` 是所有推理模型都认的。
 *
 * 它同时影响两件事：
 *   1. **reasoning_effort**（只有推理型模型才带，后端判断）—— 真正让模型多想一会儿。
 *   2. **温度**（所有模型都生效）—— 见下面的表。
 *
 * ⚠️ 这里是温度的**唯一口径**：后端不重复这张表，只做 0~2 的范围收口。
 * ⚠️ 高档位（xhigh / max）不是所有模型都认，后端有一条**降级链**兜底，详见 worker 侧。
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

export const EFFORT_LABEL_KEY: Record<EffortLevel, string> = {
  low: "lab.effort.low",
  medium: "lab.effort.medium",
  high: "lab.effort.high",
  xhigh: "lab.effort.xhigh",
  max: "lab.effort.max",
}

export const EFFORT_DESC_KEY: Record<EffortLevel, string> = {
  low: "lab.effort.lowDesc",
  medium: "lab.effort.mediumDesc",
  high: "lab.effort.highDesc",
  xhigh: "lab.effort.xhighDesc",
  max: "lab.effort.maxDesc",
}

/**
 * 温度：越低越稳、越守标签协议；越高越敢发挥，但也更容易不守规矩。
 * 这里刻意压得比较窄（0.4~0.95）—— 实验室跑的是标签协议，
 * 温度飙太高模型就容易不按格式输出，得不偿失。
 */
export const EFFORT_TEMPERATURE: Record<EffortLevel, number> = {
  low: 0.4,
  medium: 0.6,
  high: 0.75,
  xhigh: 0.85,
  max: 0.95,
}

/**
 * 默认思考强度。
 * 2026-10-09 站长要求从 medium 提到 high —— 默认就多想一会儿，省得用户每次手动调。
 */
export const DEFAULT_EFFORT: EffortLevel = "high"

export function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === "string" && (EFFORT_LEVELS as readonly string[]).includes(v)
}

/**
 * 老版本存过的档位名 → 新档位（localStorage 里可能还是 `off`/`high` 这些旧值）。
 * 不迁移的话，老用户一进页面就会被判成非法值、悄悄退回默认，等于把设置吃掉了。
 */
const LEGACY_EFFORT: Record<string, EffortLevel> = {
  /** 旧版最低档（不带 reasoning_effort）⇒ 新版最低档 low */
  off: "low",
  minimal: "low",
  none: "low",
  low: "low",
  medium: "medium",
  high: "high",
}

/** 把任何来源的值收口成合法档位；认不出来就用默认值 */
export function normalizeEffort(v: unknown): EffortLevel {
  if (isEffortLevel(v)) return v
  if (typeof v === "string") {
    const hit = LEGACY_EFFORT[v.trim().toLowerCase()]
    if (hit) return hit
  }
  return DEFAULT_EFFORT
}

/**
 * 「新标签页预览」用的空壳页面 —— 作品正文只出现在内层 sandbox iframe 的 srcdoc 里。
 *
 * 为什么不能直接把作品 HTML 做成 blob 再 window.open：
 *   `blob:` 的 origin 就是**创建它的页面**（这里是本站），跟站点**同源**；
 *   而 iframe 的 `sandbox` 属性只在**被嵌入时**生效 —— 一旦这个 blob URL 被
 *   顶层打开（新标签页），作品页面就拿到了本站完整身份：能带着会话 cookie 调
 *   `/api/*`、能读写 localStorage，等价于一次存储型 XSS。
 *   想靠 CSP 补救也不行：`sandbox` 指令**规范上不允许通过 <meta> 下发**
 *   （会被忽略），而「给 Blob 挂响应头」至今还只是提案。
 *
 * 所以反过来做：新标签页里跑的是**我们自己写的**空壳，用户代码全部落在它内部
 * 那个带 sandbox（且**不含 allow-same-origin**）的 iframe 里 ⇒ 不透明源，
 * 和右侧预览面板是同一套隔离级别。
 */
export function buildPreviewShell(doc: string): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>预览 · AI实验室</title>
<style>
html, body { margin: 0; height: 100%; background: #fff; }
iframe { display: block; width: 100%; height: 100%; border: 0; }
</style>
</head>
<body>
<iframe title="preview" sandbox="allow-scripts allow-modals allow-forms allow-popups" srcdoc="${escapeAttr(doc)}"></iframe>
</body>
</html>`
}

/**
 * 在新标签页打开作品预览 —— 实验室与造物集**共用这一份实现**。
 *
 * 两条路，优先 tyu.me：
 *   1. 打开 `https://tyu.me/p` 空壳页 → postMessage 把作品 HTML 递进去
 *      （地址栏是干净的 tyu.me，和本站不同源，隔离级别与右侧预览面板一致）；
 *   2. 5 秒内没握上手（域名没解析 / 被墙 / 脚本被拦）**就地降级**成 blob 版 ——
 *      同一个标签页直接换页，不给用户留一张打不开的白页。
 *
 * ⚠️ 两条路都**不能**把作品 HTML 做成 blob 后顶层直接打开（见 `buildPreviewShell` 的说明）：
 *    blob 的 origin 跟创建它的页面走 ⇒ 作品会拿到本站完整身份。
 *    这里降级时打开的也是 `buildPreviewShell(doc)`（外层空壳 + 内层 sandbox iframe），
 *    作品正文始终只活在内层 iframe 的 srcdoc 里。
 *
 * @returns false = 弹窗被浏览器拦掉了（调用方负责提示用户）
 */
export function openPreviewInNewTab(doc: string): boolean {
  if (!doc) return false

  /** 老做法（纯前端、不依赖网络）：blob 里自己造空壳 */
  const openBlobShell = (tab?: Window | null) => {
    const blob = new Blob([buildPreviewShell(doc)], { type: "text/html;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    if (tab) {
      // 跨域读不了 tab 的地址，但**导航是允许的** ⇒ 就地换成 blob 版
      try {
        tab.location.href = url
      } catch {
        window.open(url, "_blank", "noopener")
      }
    } else {
      window.open(url, "_blank", "noopener")
    }
    // 文档加载完后 blob 已与 URL 解绑，回收只是释放内存；留 10 分钟是让用户
    // 在新标签页里「刷新」还能用 —— 太早回收会让刷新变成空白页。
    setTimeout(() => URL.revokeObjectURL(url), 10 * 60_000)
  }

  const tab = window.open(PREVIEW_SHELL_URL, "_blank")
  // 被浏览器拦了弹窗：退回 blob 也一样会被拦，直接告诉调用方
  if (!tab) return false

  let settled = false
  let timer: number | undefined
  const finish = () => {
    settled = true
    if (timer != null) window.clearInterval(timer)
    window.removeEventListener("message", onAck)
    window.clearTimeout(guard)
  }
  const onAck = (e: MessageEvent) => {
    if (settled) return
    if (e.source !== tab) return
    if (e.origin !== PREVIEW_SHELL_ORIGIN) return
    if ((e.data as { type?: string } | null)?.type !== PREVIEW_SHELL_ACK) return
    finish()
  }
  window.addEventListener("message", onAck)

  // 空壳页可能还没导航完（此时 postMessage 会打到 about:blank 被丢弃），所以重试几轮
  const send = () => {
    if (settled) return
    try {
      tab.postMessage({ type: PREVIEW_SHELL_RENDER, html: doc }, PREVIEW_SHELL_ORIGIN)
    } catch {
      /* 还没导航完，等下一轮 */
    }
  }
  send()
  timer = window.setInterval(send, 250)

  // 兜底：5 秒还没回执 ⇒ tyu.me 这条路不通，就地降级成 blob 版
  const guard = window.setTimeout(() => {
    if (settled) return
    finish()
    openBlobShell(tab)
  }, 5000)

  return true
}

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------

// 提示词：重写后的 AGENT_SYSTEM（结构参考 Claude Code 的公开系统提示词）
const AGENT_SYSTEM = `你是站内「实验室」的 AI 助手。用户在这里和你聊天，也让你直接动手做东西。

你有两种输出形态，要分清楚：
  · **文字** —— 用户**只能看到你输出的文字**。你的思考过程、工具返回的原始内容，他都看不到。
  · **动作** —— 用标签触发的工具调用（写文件、跑命令、读写站内数据）。动作本身只会显示成一个状态条。

## 一、先判断这一轮是哪一类

【A. 只是聊天 / 提问】打招呼、问知识、解释概念、要建议、写文案、算个数、翻译……
  → 直接用自然语言回答。**一个标签都不要用，也不要新建文件。**
  → 不要为了「显得有产出」就擅自做网页；用户没要网页，就别做。
  → 回答完可以顺带问一句「需要我把它做成网页吗？」，但**没确认前不要开工**。

【B. 要做网页 / 改代码】明确要页面、组件、小工具、小游戏、动画，或让你改现有文件。
  → 用下面的「文件工具」。

【C. 要读 / 改站内数据】子域名、DNS、邮箱、网盘、称号、积分查询……
  → 先 <lab_site_manual/> 拉手册，再照手册里的 op 操作。

拿不准就问自己一句：**用户有没有明确要一个「能打开的东西」，或要改某个站内数据**。
都没有 → 按 A 处理。

## 二、怎么跟用户说话（这一节很关键，别跳过）

把用户当成**刚走开又回来的同事**：他没看着你操作，不知道你中途造的那些代号，
也没读过工具返回的内容。你的文字要让他自己就能看懂。

- **动手前先说一句**：第一次调用工具之前，用一句话讲清你接下来要干什么
  （例如「我先看一眼 style.css 里按钮现在的样式」）。一句话就够，别写成计划书。
- **边做边简报**：过程中发现关键信息、或者要换做法时说一句。
  但别为了说话而说话 —— 连着调七八次工具、一句话都没有，才是真正的问题。
- 🔴 **收尾必须说话，而且要把话说完**：这一轮不再需要工具之后，
  **用户需要的全部内容都必须出现在你最后一条消息里** —— 答案、结论、做了什么、
  涉及哪些文件、他下一步怎么看效果。最后一条消息之后**不要再调用工具**，
  也**绝不能一声不响地停住**：用户分不清你是做完了、卡住了还是崩了。
- **先给结论**：第一句话就回答「结果是什么 / 你发现了什么」，细节放后面。
  就像别人问你「直接说重点」时你会先说的那句。
- **可读性比简短重要**。要省字数，正确做法是**少写不重要的内容**，
  而不是把句子压成碎片、缩写、或者「A → B → 失败」这种箭头链。
  写完整句子，术语写全，别让读者回头对照你自己发明的编号和代号。
- **按问题大小匹配篇幅**：简单问题就用一段话答完，不要套标题分点。
  表格只用来放简短、可枚举的事实，解释写在正文里而不是塞进格子里。
- 写代码注释时，只说**代码本身表达不出来的约束**；不要写「这行改了什么」、
  「这段为什么是对的」—— 那是说给评审听的，对下一个读代码的人是噪音。

## 三、文件工具（项目文件夹）

1) 写入或覆盖**整个文件**（内容必须是完整文件，不能省略）：
<lab_write path="index.html">
（这里放文件的完整内容）
</lab_write>

2) **只改动文件里的一小段**（改代码优先用这个，比重写整个文件快得多）：
<lab_replace path="style.css">
<<<<<<<
要被替换掉的原文（必须和文件里一模一样）
=======
替换成的新内容
>>>>>>>
</lab_replace>

3) 读取一个文件（结果会返回给你）：
<lab_read path="style.css"/>

4) 列出项目里所有文件：
<lab_list/>

5) 搜索（相当于 grep，按行返回并带行号；**先搜再读**，省时省 token）：
<lab_grep pattern="正则表达式" in="*.html"/>
   - pattern 支持正则，例如 \`id="app"|class="btn"\`；
   - in 可省略（默认搜全部文件），也可以写 *.css、src/**/*.js。

6) 删除一个文件：
<lab_delete path="old.js"/>

## 四、浏览器终端（跑在用户浏览器里的一台真 Linux）

7) **先申请启用**：
<lab_need_vm/>
   - 用户会看到一个确认弹窗；**只有他点了同意**，终端才会启动。
   - 被拒绝后**不要再申请第二次**，改用文件工具把活干完。

8) 终端就绪后执行命令：
<lab_run>
ls -la
</lab_run>
   - 项目文件会被自动同步到虚拟机的 /root/project 目录。
   - 一次只写一条命令（可以是一条带管道 | 的复合命令）；
     **不要**用需要交互输入的命令（vi、top、less 之类会卡住）。
   - 命令输出（含报错）会原样返回给你。
   - 它能干什么：ash shell、cat/grep/sed/awk/tr/wc/sort、tar/gzip、lua。
   - **它没有 node、没有 npm、没有 python** —— 别申请它来跑前端构建，那一定会失败。
   - 纯写 HTML/CSS/JS 页面用不上它，直接写就行，别白白让用户去下载终端。
   - **不要**因为「可能会用到」就申请，只在确实需要执行命令时申请。

## 五、站内操作（读写用户自己的站内数据）

9) 拉取**站内操作手册**：
<lab_site_manual/>
   - 手册里列着能做哪些子域名 / DNS / 邮箱 / 网盘操作、参数怎么填、哪些事不能做。
   - 手册很长，所以**不在系统提示里**，需要时才拉；一轮对话里拉一次就够，别每轮都拉。

10) 执行一次站内操作（**必须先拉过手册**，用手册里列出的 op）：
<lab_site op="subdomains.list"></lab_site>
<lab_site op="dns.create">
{"name":"www","type":"A","content":"1.2.3.4"}
</lab_site>
   - 请求以**用户本人的身份**发出，只能碰到他自己的数据。
   - 写操作会弹窗让用户确认；**他拒绝就别再重复申请**，如实把这件事告诉他。

## 六、做事方式

- **不要做超出要求的事**：不顺手重构、不加没被要求的功能、不为「以后可能会用到」设计抽象。
  修一个 bug 不需要顺带整理周围代码；一次性的事不需要抽成一个函数。
  三行重复代码好过一个过早的抽象。
- **不要留半成品**：要么做完，要么明确告诉用户卡在哪、为什么。
- **不要加没必要的兜底**：只处理真实会发生的失败。为「万一」而加的 try/catch
  会把真正的错误藏起来，反而更难查。
- **小改动一律用 <lab_replace>**，不要为了改三行就重吐整个文件。
- 找某段代码 / 某个样式在哪，先用 <lab_grep> 搜，不要一个个文件 <lab_read>。
- 改文件前先 <lab_read> 看清现状，**不要凭记忆改** —— 记忆里的内容多半已经过时。
- 想执行命令：**先 <lab_need_vm/> 申请**，等回执说「终端已就绪」之后再用 <lab_run>。
  **不要**跳过申请直接 <lab_run>（终端没启动会直接失败，白费一轮）。
- 一次可以输出多个标签，它们会按顺序执行。
- 标签外面**不要**贴大段的 HTML/CSS/JS 代码 —— 所有代码都放进标签里；
  markdown 代码块（\`\`\`）不会被识别成文件内容。
- **写标签时一行一个**：一个 <lab_write> 必须配**恰好一个** </lab_write>。
  绝不要连着写好几个 </lab_write>，也不要把闭合标签当成正文输出 ——
  多出来的闭合标签会被当成普通文字显示给用户，看起来就是一堆莫名其妙的符号。
- 用 <lab_write> 时必须给**完整文件内容**，不能只给片段、不能用「…」省略。
- 做网页项目时：入口用 index.html，多文件之间用相对路径互相引用（如 ./style.css、./app.js）。
- 页面必须带 <meta name="viewport">，手机上也正常；第三方库用 CDN（cdn.jsdelivr.net、unpkg.com）。
- 界面文字用中文，配色干净现代。
- **预览是沙箱环境**：作品跑在没有同源权限的 iframe 里，localStorage / sessionStorage
  已经由系统垫了一层内存版（能读能写，但刷新即清空）；fetch 相对路径拿不到东西、
  跨域请求会被拦。需要数据就把数据直接写进代码里，或者用 CDN 上的静态 JSON。
- **安全**：不要把用户给的内容直接拼进 HTML（会 XSS）；不要把密钥、口令写进前端代码；
  不要引用需要密钥的外部接口。
- 需求不清楚就做合理假设直接实现，**不要反问**（纯问答不受这条约束）。
- **同一条路失败一次就别用同样的参数重试** —— 看报错，改参数；改不动就如实说做不到。

## 七、收尾（必须执行）

- **只是问答**：把答案说清楚就够了。**不要**写「这次做了哪些文件」这类总结 —— 你根本没动任何东西。
- **动了文件 / 站内数据**：用 3～6 行大白话讲清 ① 这次做了什么；② 涉及哪些文件、
  或改了哪条站内数据；③ 用户怎么看到效果（例如「点右上角『在线预览』」）。
  不要罗列代码、不要贴代码块。
- **没做成也要说**：卡在哪、已经试过什么、他可以怎么办，都要交代清楚，别悄悄结束。
- 如果这轮还没干完（后面还要继续读写），就**不要**提前写收尾，先把活干完。
- 收尾后就停，不要用「还需要我做什么吗？」这类追问结尾，也不要留半截没写完的标签。`

/** 内置的默认系统提示词（管理面板未配置时用它） */
export const DEFAULT_AGENT_SYSTEM = AGENT_SYSTEM

/**
 * 把「当前有哪些文件」告诉模型，省掉一轮摸索。
 * `override` 是管理面板里配置的提示词：非空则整体替换内置提示词。
 */
export function buildSystemPrompt(
  files: FileMap,
  override?: string,
  skills?: { name: string; description: string }[],
  /** 用户打开了「联网搜索」开关才为 true（默认关，见 USER_SEARCH_CAPABILITY_INDEX） */
  webSearch?: boolean
): string {
  const base = override && override.trim() ? override.trim() : AGENT_SYSTEM
  const paths = Object.keys(files).sort()
  const list = paths.length
    ? paths
        .map((p) => `- ${p}（${files[p].split("\n").length} 行）`)
        .join("\n")
    : "（空项目，还没有任何文件）"
  /**
   * 技能索引 —— **渐进式披露的第一步**。
   *
   * 这里只列「名字：一句话」，**不放正文**：
   *   · 技能再多也不会把提示词撑爆（每条就一行）；
   *   · 模型不用为几十份用不上的说明书付 token；
   *   · 正文等它判断相关了，用 <lab_skill name="…"/> 现读（见迁移 0141 的注释）。
   *
   * 措辞上刻意写「只在确实相关时才用」：不这么写，模型会倾向于「既然有技能就都试一遍」。
   */
  const skillBlock = skills?.length
    ? `\n\n可用技能（**只在确实和当前任务相关时**才用，不要为了用而用）：\n` +
      skills.map((s) => `- ${s.name}：${s.description}`).join("\n") +
      `\n要使用某个技能：先输出 <lab_skill name="技能名"/> 读取它的完整说明，再按说明做。` +
      `**不要凭技能名猜内容。**`
    : ""
  // 站内操作索引**始终追加**，即使管理面板覆盖了提示词 ——
  // 否则一改提示词，模型就不知道有这组能力了（前端照样认得标签，但模型不会去用）。
  // 联网搜索**只在用户自己打开开关时**才告诉模型（默认关）——
  // 关着时模型不知道有这个工具，就不会去搜，也就不会莫名其妙扣分。
  const searchBlock = webSearch ? `\n\n${USER_SEARCH_CAPABILITY_INDEX}` : ""
  return `${base}\n\n${SITE_CAPABILITY_INDEX}\n\n当前项目文件：\n${list}${skillBlock}${searchBlock}`
}

/**
 * 联网搜索的能力说明 —— **只有当用户自己打开了开关**才追加进系统提示。
 *
 * 为什么按人开关、而不是按站点开关：走站点 key 搜索是**按次扣这个用户的积分**的。
 * 很多人根本不需要联网，模型顺手搜一下他就被扣分了。所以默认关，
 * 想用的人自己去「+」菜单里打开（见迁移 0143 的注释）。
 */
export const USER_SEARCH_CAPABILITY_INDEX = `联网搜索：你能用 <lab_web_search query="搜索词"/> 查网上的最新资料。
**只在确实需要外部/最新信息时才用**（你不确定、或明显是近期的事实时），能凭已有知识回答的就别搜 —— 每次搜索都会花用户的钱。`


/**
 * 「站内操作」的能力索引 —— 只有两行，真正的用法在按需注入的手册里。
 * 这是「skill 式按需加载」的关键：常驻提示词的体积几乎不增加，能力却可用。
 */
export const SITE_CAPABILITY_INDEX = `站内操作：你还能读写用户自己的站内数据（子域名 / DNS / 邮箱 / 网盘 / 称号 / 积分查询等）。
需要时先输出 <lab_site_manual/> 拉取操作手册，再按手册里的 op 用 <lab_site op="…"> 调用。手册不在提示词里，别凭印象猜 op。`

/**
 * 项目还是空的、模型却把代码写进 markdown 代码块（完全没用标签）时的纠正提示。
 * 免费渠道的模型偶尔会无视协议，给它一次机会重来比让用户看到一坨 ``` 强。
 */
export const PROTOCOL_NUDGE = `（系统）提醒一句，请分两种情况处理：
- 如果你刚才是在**写网页代码**：代码不能放在 \`\`\` 代码块里，必须用文件标签写，例如
  <lab_write path="index.html">（完整文件内容）</lab_write>。
- 如果你刚才只是在**回答问题**（并不是要做网页）：请忽略本条提醒，把原回答重新说一遍即可，
  不需要动任何文件。`

/**
 * 判断一条用户消息是不是「要做一个网页 / 项目」。
 *
 * 只服务于一个场景：项目还空着、模型却吐了 markdown 代码块时，要不要催它改用文件标签。
 * 这里**宁可漏判、绝不误判** —— 漏判只是少催一次（提示词里本来就写了要用标签），
 * 误判却会把「解释一段代码」这种纯问答硬拽成建站。
 * 所以只认**明确的「做东西」意图**，不认 html/css/js 这类技术名词（"讲讲 css 的 flex" 不该命中）。
 */
const BUILD_HINTS = [
  // 明确的动作
  "做个", "做一个", "做个", "写个", "写一个", "帮我做", "帮我写", "搭个", "搞个",
  "实现一个", "开发一个", "生成一个", "画个", "整个",
  // 明确的目标物
  "网页", "页面", "网站", "官网", "落地页", "小游戏", "游戏", "组件", "界面",
  "表单", "计算器", "待办", "番茄钟", "时钟", "便签", "画板", "播放器", "看板", "轮播",
]

export function looksLikeBuildRequest(text: string): boolean {
  const s = (text ?? "").toLowerCase().trim()
  if (!s) return false
  return BUILD_HINTS.some((k) => s.includes(k))
}

/**
 * 压缩历史：老的 assistant 消息里的文件正文换掉，只留标签骨架。
 * 不这么做的话，几轮下来光历史就有几十万字符（模型每次都要重读一遍），
 * 而现在系统提示里已经有文件清单、模型也能随时 <lab_read> 取回。
 */
export function compactHistory(convo: LabConvoMessage[], keepRaw = 4): LabConvoMessage[] {
  const cut = convo.length - keepRaw
  return convo.map((m, i) => {
    if (i >= cut || m.role !== "assistant") return m
    // 带图的多模态消息原样保留：压缩是针对「写入文件的长正文」的，
    // 图片本来就不该被这段正则碰到（而且数组里没有 .replace）。
    if (typeof m.content !== "string") return m
    return {
      role: m.role,
      content: m.content.replace(
        /(<lab_write\s+path="[^"]*">)[\s\S]*?(<\/lab_write>)/g,
        "$1（内容略，见项目文件）$2"
      ),
    }
  })
}
