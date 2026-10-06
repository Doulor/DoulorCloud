/**
 * Markdown 编辑工具（Discourse d-editor 同款交互的纯函数实现）。
 *
 * 服务于社区发帖/编辑的格式工具栏与上传占位协议（用户反馈 2026-10-06：
 * 学习 nodeloc.com 的发帖体验）。全部是「text in → { text, selectionStart,
 * selectionEnd } out」的纯函数，React 组件里用一次 setState 写回即可。
 *
 * 三态 surround（与 Discourse applySurround 行为一致）：
 *   · 无选中   → 插入 `标记+示例文案+标记`，并把**示例文案**选中之，直接打字就覆盖；
 *   · 有选中   → 包裹选中文字；
 *   · 已包裹   → 同一按钮再点一次 = 移除包裹（toggle）。
 * 列表/引用用逐行前缀，同一按钮再点一次逐行取消（可撤销的 toggle）。
 */

export interface TextEditResult {
  text: string
  selectionStart: number
  selectionEnd: number
}

/**
 * 逐行前缀（引用 / 列表）。已带该前缀的行会被移除前缀（toggle），
 * 有序列表用 `1. ` 起始、逐行递增编号。
 */
export function surround(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  head: string,
  tail: string,
  exampleText: string
): TextEditResult {
  const hasSelection = selectionEnd > selectionStart
  const selected = text.slice(selectionStart, selectionEnd)

  // 选区外紧邻已有包裹 → 移除（toggle off）
  if (hasSelection && text.slice(selectionStart - head.length, selectionStart) === head && text.slice(selectionEnd, selectionEnd + tail.length) === tail) {
    const next =
      text.slice(0, selectionStart - head.length) +
      selected +
      text.slice(selectionEnd + tail.length)
    return { text: next, selectionStart: selectionStart - head.length, selectionEnd: selectionEnd - head.length }
  }

  // 选区自身已含包裹（用户连 ** 一起选了）→ 剥掉内侧标记（Discourse 同款语义）
  if (hasSelection && selected.startsWith(head) && selected.endsWith(tail) && selected.length >= head.length + tail.length) {
    const inner = selected.slice(head.length, selected.length - tail.length)
    const next = text.slice(0, selectionStart) + inner + text.slice(selectionEnd)
    return { text: next, selectionStart, selectionEnd: selectionStart + inner.length }
  }

  if (hasSelection) {
    const next = text.slice(0, selectionStart) + head + selected + tail + text.slice(selectionEnd)
    return {
      text: next,
      selectionStart: selectionStart + head.length,
      selectionEnd: selectionEnd + head.length,
    }
  }

  // 无选中：插入示例并选中示例文字
  const example = exampleText || " "
  const insert = head + example + tail
  const at = selectionStart
  const next = text.slice(0, at) + insert + text.slice(at)
  return {
    text: next,
    selectionStart: at + head.length,
    selectionEnd: at + head.length + example.length,
  }
}

/**
 * 逐行前缀（引用 / 列表）。已带该前缀的行会被移除前缀（toggle），
 * 有序列表用 `1. ` 起始、逐行递增编号。
 */
export function applyList(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  kind: "quote" | "ul" | "ol"
): TextEditResult {
  // 展开到整行：光标落在行中间也能作用于该行
  const from = text.lastIndexOf("\n", selectionStart - 1) + 1
  const toIdx = text.indexOf("\n", selectionEnd)
  const to = toIdx === -1 ? text.length : toIdx
  const block = text.slice(from, to)
  const lines = block.split("\n")

  const prefixOf = (i: number): string => {
    if (kind === "quote") return "> "
    if (kind === "ul") return "- "
    return `${i + 1}. `
  }

  // 判定 toggle off：所有非空行都已带前缀 → 全部移除
  const nonEmpty = lines.filter((l) => l.trim() !== "")
  const allPrefixed =
    nonEmpty.length > 0 &&
    nonEmpty.every((l) => l.startsWith(prefixOf(0)))
  const nextLines = allPrefixed
    ? lines.map((l) => (l.startsWith(prefixOf(0)) ? l.slice(prefixOf(0).length) : l))
    : lines.map((l, i) => (l.trim() === "" ? l : lineStartIndent(l) + prefixOf(i) + l.slice(lineStartIndent(l).length)))

  const nextBlock = nextLines.join("\n")
  const next = text.slice(0, from) + nextBlock + text.slice(to)
  return {
    text: next,
    selectionStart: from,
    selectionEnd: from + nextBlock.length,
  }
}

/** 保留行首缩进，前缀加在缩进之后 */
function lineStartIndent(line: string): string {
  const m = /^[ \t]*/.exec(line)
  return m ? m[0] : ""
}

/** 代码块：单行/无选中 → 行内 `code`；多行 → 围栏代码块。exampleText 由调用方传 i18n 文案 */
export function applyCode(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  exampleText = "code"
): TextEditResult {
  const selected = text.slice(selectionStart, selectionEnd)
  if (selected.includes("\n") || (selected === "" && text.slice(selectionStart - 3, selectionStart) === "\n```")) {
    return surround(text, selectionStart, selectionEnd, "```\n", "\n```", exampleText)
  }
  return surround(text, selectionStart, selectionEnd, "`", "`", exampleText)
}

/**
 * 插入一段文本到光标处（不覆盖选中），返回新的光标位置。
 * 用于表情、图片 markdown 等。
 */
export function insertAtCursor(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  snippet: string
): TextEditResult {
  const next = text.slice(0, selectionStart) + snippet + text.slice(selectionEnd)
  const pos = selectionStart + snippet.length
  return { text: next, selectionStart: pos, selectionEnd: pos }
}

/* ── 上传占位协议（Discourse TextareaPlaceholderHandler 同款） ── */

/**
 * 占位符：空链接 markdown，预览里渲染为灰色文字、不会变成真图。
 * `label` 是 i18n 后的「上传中」一词 —— 本模块是纯函数拿不到 t()，由调用方传入。
 */
export function uploadPlaceholder(filename: string, taken: Set<string>, label = "Uploading"): string {
  // 同名文件（例如连截两张图都叫 image.png）自动加 (1)(2) 序号
  let name = filename
  let n = 1
  while (taken.has(uploadPlaceholderOf(name, label))) {
    const dot = filename.lastIndexOf(".")
    name = dot > 0 ? `${filename.slice(0, dot)}(${n})${filename.slice(dot)}` : `${filename}(${n})`
    n++
  }
  return uploadPlaceholderOf(name, label)
}
function uploadPlaceholderOf(name: string, label: string): string {
  return `[${label}: ${name}…]()`
}

/** 把某个占位符替换为最终 markdown（或失败时移除）。只替换恰好一处（按 index 定位可重复文件名） */
export function replacePlaceholder(
  text: string,
  placeholder: string,
  replacement: string
): string {
  const idx = text.indexOf(placeholder)
  if (idx === -1) return text
  return text.slice(0, idx) + replacement + text.slice(idx + placeholder.length)
}

/** 从 `[<label>: xxx…]()` 占位串反解文件名（进度条展示用），label 默认「上传中」 */
export function placeholderFilename(placeholder: string, label = "Uploading"): string {
  const m = new RegExp(`^\\[${label}: (.*?)…\\]\\(\\)$`).exec(placeholder)
  return m ? m[1] : placeholder
}
