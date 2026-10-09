/**
 * 网页实验室的「agent 内核」—— 与 UI 无关的纯逻辑。
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
 *   标签之外的自然语言会被当成「旁白」原样显示给用户。
 */

export type FileMap = Record<string, string>

export type ToolName = "write" | "read" | "replace" | "list" | "delete"

/** 从（可能还没流完的）模型输出里解析出的片段，按出现顺序排列 */
export type Segment =
  | { type: "text"; text: string }
  | {
      type: "action"
      tool: ToolName
      path?: string
      content: string
      complete: boolean
    }

/** 单次对话里最多来回几轮（防止模型陷入「读—改—读」死循环） */
export const MAX_ROUNDS = 6

/** 读文件回喂给模型时的单文件上限 */
const MAX_READBACK_CHARS = 20_000

// 属性段用 [\s\S]*?（而不是 [^>]*?）：文件名里可能带 `>`（如 a>b.html），
// 用 [^>] 会把标签头判成非法、整段降级成旁白文字。
const TAG_RE = /^<lab_(write|read|replace|list|delete)\b([\s\S]*?)(\/?)>$/

/** 带正文体、需要等闭合标签的两个工具 */
const BODY_TOOLS: ToolName[] = ["write", "replace"]

/**
 * 找标签头收尾的 `>` —— 跳过属性值引号里的内容。
 *
 * 直接 `indexOf(">")` 会在 `path="a>b.html"` 这种引号内的 `>` 处提前截断，
 * 于是 path 解析成 undefined（上层再把它当「缺 path」处理）。这里按引号配对扫描。
 */
function findTagEnd(text: string, from: number): number {
  let quote = ""
  for (let i = from; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = ""
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === ">") {
      return i
    }
  }
  return -1
}

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

    const gt = findTagEnd(text, lt)
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
        content: text.slice(gt + 1, close).replace(/^\n/, ""),
        complete: true,
      })
      i = close + closer.length
    } else {
      flush()
      segments.push({ type: "action", tool, path, content: "", complete: true })
      i = gt + 1
    }
  }

  flush()
  return segments
}

/**
 * 动作缺 `path` 时回喂给模型的失败原因。
 *
 * 以前这种情况被静默当成功（不写任何文件、也不纠正），模型于是以为改好了继续往下改。
 * 文案是给模型纠错用的（和 PROTOCOL_NUDGE 一样不进 i18n）。
 */
export function missingPathReason(tool: ToolName): string {
  return `缺少 path：<lab_${tool}> 必须带 path="文件名"（这次没有改动任何文件，请带上文件名重发）`
}

/**
 * 需要回喂结果的动作：读 / 列 / 删（写和改只要成功就不用回）。
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
      (s.tool === "read" || s.tool === "list" || s.tool === "delete")
  )
}

/**
 * 把已执行的动作结果拼成一条「用户消息」回喂给模型（非原生 tool 协议下最稳的做法）。
 * `failures` 是「第几个动作失败了 + 为什么」，只需要在出错时才占用一轮。
 */
export function buildToolResults(
  segments: Segment[],
  files: FileMap,
  failures?: Map<number, string>
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
    } else if (s.tool === "delete") {
      parts.push(`[删除 ${s.path}] ${s.path && s.path in files ? "失败" : "成功"}`)
    } else if (failures?.get(i)) {
      const verb = s.tool === "write" ? "写入" : "修改"
      parts.push(`[${verb} ${s.path} 失败] ${failures.get(i)}`)
    }
  })
  parts.push("\n请根据结果继续。")
  return parts.join("\n\n")
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

  return html
}

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------

const AGENT_SYSTEM = `你是「网页实验室」里的网页开发助手。用户会用中文描述需求，你在一个虚拟项目文件夹里写代码。

你可以用下面 5 个标签操作文件（**必须严格按格式**，标签会由程序执行）：

1) 写入或覆盖一个文件（内容必须是完整文件，不能省略）：
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

5) 删除一个文件：
<lab_delete path="old.js"/>

工作方式：
- **小改动一律用 <lab_replace>**，不要为了改三行就重吐整个文件。
- 需要先看某个文件的现有内容时，先 <lab_read>，等结果回来再改，不要凭记忆改。
- 一次可以调用多个工具：连续写几个标签就行。
- 标签之外可以写一两句自然语言说明（会显示给用户），但**不要长篇解释**，也不要写 markdown 代码块（\`\`\`）。
- 用 <lab_write> 时必须给**完整文件内容**，不能只给片段、不能用「…」省略。
- 项目入口必须是 index.html；多文件之间用相对路径互相引用（如 ./style.css、./app.js）。
- 页面必须带 <meta name="viewport">，手机上也正常；第三方库用 CDN（cdn.jsdelivr.net、unpkg.com）。
- 界面文字用中文。配色干净现代。
- 需求不清楚时做合理假设直接实现，不要反问。
- 不要引用需要密钥的外部接口。`

/** 把「当前有哪些文件」告诉模型，省掉一轮摸索 */
export function buildSystemPrompt(files: FileMap): string {
  const paths = Object.keys(files).sort()
  const list = paths.length
    ? paths
        .map((p) => `- ${p}（${files[p].split("\n").length} 行）`)
        .join("\n")
    : "（空项目，还没有任何文件）"
  return `${AGENT_SYSTEM}\n\n当前项目文件：\n${list}`
}

/**
 * 项目还是空的、模型却把代码写进 markdown 代码块（完全没用标签）时的纠正提示。
 * 免费渠道的模型偶尔会无视协议，给它一次机会重来比让用户看到一坨 ``` 强。
 */
export const PROTOCOL_NUDGE = `（系统）你刚才没有使用文件工具，把代码写进了 markdown 代码块 —— 这里无法执行。
请重新输出：用 <lab_write path="index.html">（完整文件内容）</lab_write> 这样的标签写文件，
不要用 \`\`\` 代码块，不要在标签外面贴大段代码。`

/**
 * 压缩历史：老的 assistant 消息里的文件正文换掉，只留标签骨架。
 * 不这么做的话，几轮下来光历史就有几十万字符（模型每次都要重读一遍），
 * 而现在系统提示里已经有文件清单、模型也能随时 <lab_read> 取回。
 */
export function compactHistory(
  convo: { role: string; content: string }[],
  keepRaw = 4
): { role: string; content: string }[] {
  const cut = convo.length - keepRaw
  return convo.map((m, i) => {
    if (i >= cut || m.role !== "assistant") return m
    return {
      role: m.role,
      content: m.content.replace(
        /(<lab_write\s+path="[^"]*">)[\s\S]*?(<\/lab_write>)/g,
        "$1（内容略，见项目文件）$2"
      ),
    }
  })
}
