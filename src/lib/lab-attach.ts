import { compressToLimit } from "@/lib/image-compress"

/**
 * 实验室「导入文件」的读取内核。
 *
 * 原则：**纯本地读，不经过服务器**。按「模型能不能用得上」分三路：
 *   · 图片 → 压成 data URL，走多模态 content parts；
 *   · 文档（PDF / Word / Excel / PPT / EPUB / 压缩包）→ 在本地抽成文本，
 *     抽不出文本的 PDF（扫描件）再把前几页渲染成图片；
 *   · 文本 / 代码 → 按扩展名或 MIME 识别，UTF-8 解不开时退回 GB18030。
 *
 * 这里**不做静默丢弃**：读不了的文件必须带原因回到调用方，由界面提示用户，
 * 否则用户只会看到「文件名挂上去了，模型却完全不知道有这个东西」。
 */

export interface AttachPayload {
  /** 并进正文的文本（文档抽取结果 / 源码原文） */
  text?: string
  /** 多模态图片（data URL，已压缩） */
  images?: string[]
}

export type AttachIssueReason =
  | "unsupported"
  | "tooLarge"
  | "readFailed"
  | "imageFormat"
  | "imageTooLarge"
  | "imageLimit"

export interface AttachIssue {
  name: string
  reason: AttachIssueReason
}

export interface AttachOutcome {
  /** key = 文件名；只有**真的读到了内容**的才会出现在这里 */
  items: Record<string, AttachPayload>
  issues: AttachIssue[]
  /** 内容太长被截断的文件名 */
  truncated: string[]
}

/** 单个文件最多并入多少字符（≈1500 行代码，足够模型理解上下文） */
export const MAX_TEXT_CHARS_PER_FILE = 60_000
/**
 * 一轮附件合计的文本上限。
 * 后端单条消息硬上限是 160k 字符，这里留出用户自己输入与文件头的余量。
 */
export const MAX_TEXT_CHARS_TOTAL = 120_000
/** 后端单条消息最多 6 张图，前端先挡一下并提示，免得「发出去但模型没看到」 */
export const MAX_IMAGES_PER_TURN = 6
/** 单张图 base64 字符上限（与后端 4M 留出余量） */
const MAX_IMAGE_CHARS = 2_000_000
/** 超过这个体积的文本/文档不再整体读入（几十 MB 的文件读进来也只会被截断） */
const MAX_READ_BYTES = 16 * 1024 * 1024
/** 扫描版 PDF 最多渲染几页（每页都是一张图，会占图片额度） */
const MAX_PDF_RENDER_PAGES = 3
/** PDF 抽出的文字少于这个长度，就认为多半是扫描件 */
const PDF_TEXT_ENOUGH = 40

/** 文本类扩展名（覆盖常见源码 / 配置 / 文档 / 字幕） */
const TEXT_EXT = new Set(
  (
    "txt text md markdown mdx rst adoc org log csv tsv json jsonl ndjson geojson ipynb " +
    "yaml yml toml ini cfg conf properties env xml html htm xhtml css scss sass less styl " +
    "svg gltf obj mtl ply glsl frag vert wgsl " +
    "js mjs cjs jsx ts tsx mts cts vue svelte astro " +
    "py pyi pyw go rs java kt kts scala groovy c h cc cpp cxx hpp hh hxx cs fs fsx vb vbs " +
    "swift m mm dart rb php pl pm lua r jl ex exs erl hrl clj cljs cljc edn hs lhs ml mli " +
    "pas pp d zig nim sol move tf tfvars hcl nix " +
    "sh bash zsh fish ps1 psm1 bat cmd awk sed make mk cmake gradle proto graphql gql " +
    "sql tex bib sty cls rtf srt vtt ass lrc diff patch " +
    "dockerfile gitignore gitattributes gitmodules editorconfig npmrc yarnrc nvmrc " +
    "prettierrc babelrc eslintrc htaccess"
  ).split(/\s+/)
)

/** 没有扩展名但一定是文本的文件名 */
const TEXT_BASENAMES = new Set(
  (
    "dockerfile makefile cmakelists.txt license licence readme changelog authors notice " +
    "procfile gemfile rakefile vagrantfile brewfile .gitignore .gitattributes .editorconfig " +
    ".npmrc .yarnrc .nvmrc .env .env.local .env.example .prettierrc .babelrc .eslintrc"
  ).split(/\s+/)
)

/**
 * 文本 MIME。
 * ⚠️ 必须**锚定在 application/ 之后**：`application/vnd.openxmlformats-officedocument…`
 * 里也含 "xml"，早期用裸 `xml` 子串匹配，直接把 docx/xlsx 的 ZIP 二进制当文本发给了模型
 * （用户看到一屏 PK… 乱码，模型也读不懂）。
 */
const TEXT_MIME =
  /^(?:text\/|application\/(?:json|ld\+json|xml|xhtml\+xml|javascript|ecmascript|typescript|x-sh|x-httpd-php|x-python|x-ruby|x-perl|x-shellscript|x-yaml|yaml|toml|x-toml|sql|x-sql|rtf|graphql|x-ndjson|ndjson|manifest\+json|vnd\.api\+json))/i

const IMAGE_EXT = new Set(
  "png jpg jpeg webp gif bmp avif heic heif svg ico tif tiff".split(/\s+/)
)

const extOf = (name: string): string => {
  const i = name.lastIndexOf(".")
  return i > 0 ? name.slice(i + 1).toLowerCase() : ""
}

const isTextName = (name: string): boolean => {
  const lower = name.toLowerCase()
  return TEXT_EXT.has(extOf(lower)) || TEXT_BASENAMES.has(lower)
}

/**
 * 给「添加素材」复用：这个文件是不是应该按**文本**存进项目。
 * （例如 `.svg`、`.gltf`、`.obj` —— 存原文比 base64 更小、AI 也能直接读改。）
 */
export function isTextLikeFile(name: string, type: string): boolean {
  return TEXT_MIME.test(type) || isTextName(name)
}

const startsWithBytes = (bytes: Uint8Array, sig: number[], offset = 0): boolean =>
  sig.every((b, i) => bytes[offset + i] === b)

const isZip = (bytes: Uint8Array): boolean =>
  startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
  startsWithBytes(bytes, [0x50, 0x4b, 0x05, 0x06])

const isPdf = (bytes: Uint8Array): boolean =>
  bytes.length >= 5 &&
  bytes[0] === 0x25 && // %
  bytes[1] === 0x50 && // P
  bytes[2] === 0x44 && // D
  bytes[3] === 0x46 && // F
  bytes[4] === 0x2d // -

/** UTF-16 BOM（Windows 记事本另存为 Unicode 时会带） */
const BOM_UTF16LE = [0xff, 0xfe]
const BOM_UTF16BE = [0xfe, 0xff]

/**
 * 二进制嗅探：含 NUL 的几乎一定是二进制。
 * （UTF-16 文本也含 NUL，但会先按 BOM 分支解码，不会走到这里。）
 */
const looksBinary = (bytes: Uint8Array): boolean => {
  const n = Math.min(bytes.length, 8192)
  let zeros = 0
  for (let i = 0; i < n; i++) if (bytes[i] === 0) zeros++
  return zeros > Math.max(2, n * 0.01)
}

/**
 * 解码文本：优先严格 UTF-8，失败退回 GB18030（中文 Windows 的老 txt 多半是 GBK）。
 * `TextDecoder("gb18030")` 在现代浏览器与 Node 18+ 都有。
 */
function decodeText(bytes: Uint8Array): string {
  if (startsWithBytes(bytes, BOM_UTF16LE)) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2))
  }
  if (startsWithBytes(bytes, BOM_UTF16BE)) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2))
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    try {
      return new TextDecoder("gb18030").decode(bytes)
    } catch {
      return new TextDecoder("utf-8").decode(bytes)
    }
  }
}

/** 文本解码（严格 UTF-8 → GB18030 回退）；「添加素材」也复用这一份 */
export function decodeTextBytes(bytes: Uint8Array): string {
  return decodeText(bytes)
}

/** 去掉 BOM 与 NUL，统一换行 */
const normalizeText = (s: string): string =>
  s.replace(/^\uFEFF/, "").replace(/\u0000/g, "").replace(/\r\n?/g, "\n")

// ---------------------------------------------------------------------------
// ZIP / OOXML 读取
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  size: number
  offset: number
}

/** 从 EOCD（中央目录结束记录）倒着找目录项 */
function listZipEntries(buf: ArrayBuffer): ZipEntry[] {
  const bytes = new Uint8Array(buf)
  const dv = new DataView(buf)
  const min = Math.max(0, bytes.length - 65_557)
  let eocd = -1
  for (let i = bytes.length - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error("zip eocd not found")
  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)
  const out: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== 0x02014b50) break
    const method = dv.getUint16(p + 10, true)
    const compressedSize = dv.getUint32(p + 20, true)
    const size = dv.getUint32(p + 24, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const offset = dv.getUint32(p + 42, true)
    const name = new TextDecoder("utf-8").decode(bytes.subarray(p + 46, p + 46 + nameLen))
    out.push({ name, method, compressedSize, size, offset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/** 读一个 ZIP 条目（只支持 STORE / DEFLATE） */
async function readZipEntry(buf: ArrayBuffer, entry: ZipEntry): Promise<Uint8Array> {
  const bytes = new Uint8Array(buf)
  const dv = new DataView(buf)
  if (dv.getUint32(entry.offset, true) !== 0x04034b50) throw new Error("zip local header broken")
  const nameLen = dv.getUint16(entry.offset + 26, true)
  const extraLen = dv.getUint16(entry.offset + 28, true)
  const start = entry.offset + 30 + nameLen + extraLen
  const data = bytes.subarray(start, start + entry.compressedSize)
  if (entry.size > MAX_READ_BYTES) throw new AttachError("tooLarge")
  if (entry.method === 0) return data
  if (entry.method !== 8) throw new Error("zip method not supported")
  if (typeof DecompressionStream === "undefined") throw new Error("deflate not supported")
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
}

const decodeXmlEntities = (s: string): string =>
  s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) ? String.fromCodePoint(n) : m
    }
    return XML_ENTITIES[code.toLowerCase()] ?? m
  })

/** 把 WordprocessingML 转成近似纯文本（段落换行、制表符保留） */
function docxXmlToText(xml: string): string {
  return normalizeText(
    decodeXmlEntities(
      xml
        .replace(/<w:tab[^>]*\/>/g, "\t")
        .replace(/<w:br[^>]*\/>/g, "\n")
        .replace(/<\/w:p>/g, "\n")
        .replace(/<\/w:tc>/g, "\t")
        .replace(/<[^>]+>/g, "")
    )
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** PPTX：每页按段落收 `<a:t>` 文本 */
function pptxXmlToText(xml: string): string {
  const paragraphs = xml.split(/<\/a:p>/)
  const lines: string[] = []
  for (const p of paragraphs) {
    const texts = [...p.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXmlEntities(m[1]))
    const line = texts.join("").trim()
    if (line) lines.push(line)
  }
  return lines.join("\n")
}

/** 通用 HTML/XHTML → 文本 */
function htmlToText(html: string): string {
  return normalizeText(
    decodeXmlEntities(
      html
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
        .replace(/<[^>]+>/g, "")
    )
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** Excel（xlsx/xls/ods）：每个工作表转成 CSV */
async function readSpreadsheet(file: File): Promise<string> {
  const XLSX = await import("xlsx")
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" })
  const parts: string[] = []
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name]
    if (!sheet) continue
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false })
    if (csv.trim()) parts.push(`## 工作表：${name}\n${csv.trim()}`) // i18n-exempt: 这是给模型看的抽取文本，不是界面文案
  }
  return parts.join("\n\n")
}

/** OOXML / ODF / EPUB / 普通 ZIP 的分发 */
async function readZipLike(file: File): Promise<AttachPayload> {
  const buf = await file.arrayBuffer()
  const entries = listZipEntries(buf)
  const names = new Set(entries.map((e) => e.name))
  const lower = file.name.toLowerCase()

  const readEntryText = async (entry: ZipEntry): Promise<string> =>
    decodeText(await readZipEntry(buf, entry))

  // Word
  const docEntry = entries.find((e) => e.name === "word/document.xml")
  if (docEntry) return { text: docxXmlToText(await readEntryText(docEntry)) }

  // PowerPoint：slide1.xml, slide2.xml …（按数字排序，别按字典序）
  const slides = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(e.name))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a.name)?.[1]) - Number(/(\d+)\.xml$/.exec(b.name)?.[1]))
  if (slides.length) {
    const parts: string[] = []
    for (let i = 0; i < slides.length; i++) {
      const text = pptxXmlToText(await readEntryText(slides[i]))
      if (text.trim()) parts.push(`## 第 ${i + 1} 页\n${text.trim()}`) // i18n-exempt: 给模型看的抽取文本
    }
    return { text: parts.join("\n\n") }
  }

  // EPUB：按 spine 顺序读 xhtml（简化：按文件名排序）
  const isEpub = names.has("META-INF/container.xml") || lower.endsWith(".epub")
  if (isEpub) {
    const docs = entries
      .filter((e) => /\.(xhtml|html|htm)$/i.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name))
    const parts: string[] = []
    for (const e of docs) parts.push(htmlToText(await readEntryText(e)))
    return { text: parts.filter(Boolean).join("\n\n") }
  }

  // 普通 ZIP：列出条目，并尽量抽出文本类小文件
  const listing = entries
    .filter((e) => !e.name.endsWith("/"))
    .slice(0, 200)
    .map((e) => `${e.name}（${formatBytes(e.size)}）`)
  const textParts: string[] = []
  for (const e of entries) {
    if (e.name.endsWith("/") || e.size > 1_000_000) continue
    if (!isTextName(e.name)) continue
    try {
      const t = normalizeText(await readEntryText(e))
      if (t.trim()) textParts.push(`### ${e.name}\n${t.slice(0, 20_000)}`)
    } catch {
      /* 单个条目解不开就跳过 */
    }
    if (textParts.join("\n\n").length > MAX_TEXT_CHARS_PER_FILE) break
  }
  const text = [
    `ZIP 压缩包，共 ${entries.length} 个条目：`, // i18n-exempt: 给模型看的抽取文本
    ...listing,
    textParts.length ? `\n\n--- 包内文本文件 ---\n\n${textParts.join("\n\n")}` : "", // i18n-exempt: 给模型看的抽取文本
  ].join("\n")
  return { text }
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

let pdfWorkerReady = false

/**
 * pdfjs-dist 6 用了 TC39 提案里的 `Map.prototype.getOrInsertComputed`，
 * 但不少仍在流通的 Chromium/Edge（以及 Safari）没有实现 —— 表现为
 * 「带图层/图片的 PDF 一渲染就 TypeError: ...getOrInsertComputed is not a function」。
 * 这里补一份最小实现，只影响 pdfjs 用到的语义。
 */
function ensureMapHelpers(): void {
  type MapProto = Map<unknown, unknown> & {
    getOrInsertComputed?: (key: unknown, fn: (key: unknown) => unknown) => unknown
    getOrInsert?: (key: unknown, value: unknown) => unknown
  }
  const proto = Map.prototype as MapProto
  if (typeof proto.getOrInsertComputed !== "function") {
    proto.getOrInsertComputed = function (this: Map<unknown, unknown>, key, fn) {
      if (!this.has(key)) this.set(key, fn(key))
      return this.get(key)
    }
  }
  if (typeof proto.getOrInsert !== "function") {
    proto.getOrInsert = function (this: Map<unknown, unknown>, key, value) {
      if (!this.has(key)) this.set(key, value)
      return this.get(key)
    }
  }
}

async function readPdf(file: File): Promise<AttachPayload> {
  ensureMapHelpers()
  const pdfjs = await import("pdfjs-dist")
  if (!pdfWorkerReady) {
    const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url")
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default
    pdfWorkerReady = true
  }
  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    useSystemFonts: true,
  })
  try {
    // ⚠️ 取 promise 也要在 try 里：加密/损坏的 PDF 会在这里 reject，
    // 放在外面就漏掉了 finally 的 destroy，worker 会一直挂着。
    const doc = await task.promise
    const pageCount = Math.min(doc.numPages, 50)
    const chunks: string[] = []
    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      const lines: string[] = []
      let line = ""
      for (const item of content.items) {
        if (!("str" in item)) continue
        line += item.str
        if (item.hasEOL) {
          lines.push(line)
          line = ""
        }
      }
      if (line) lines.push(line)
      const text = lines.join("\n").trim()
      if (text) chunks.push(text)
      page.cleanup()
    }
    const text = chunks.join("\n\n").trim()
    if (text.length >= PDF_TEXT_ENOUGH) {
      return { text: doc.numPages > pageCount ? `${text}\n\n（仅提取前 ${pageCount} 页）` : text } // i18n-exempt: 给模型看的抽取文本
    }

    /**
     * 扫描件：没有文字层，只能渲染成图片让多模态模型看。
     * 只渲染前几页 —— 每页都是一张图，既占 6 张额度也很吃 token。
     */
    const images: string[] = []
    const pages = Math.min(doc.numPages, MAX_PDF_RENDER_PAGES)
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i)
      const viewport = page.getViewport({ scale: 1.5 })
      const canvas = document.createElement("canvas")
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      const ctx = canvas.getContext("2d")
      if (!ctx) break
      await page.render({ canvasContext: ctx, viewport, canvas }).promise
      let url = canvas.toDataURL("image/jpeg", 0.8)
      if (url.length > MAX_IMAGE_CHARS) url = canvas.toDataURL("image/jpeg", 0.6)
      if (url.length <= MAX_IMAGE_CHARS) images.push(url)
      page.cleanup()
    }
    if (images.length) return { text: text || undefined, images }
    return { text: text || "（这份 PDF 没有可提取的文字，也没能渲染成图片）" } // i18n-exempt: 给模型看的抽取结果
  } finally {
    await task.destroy()
  }
}

// ---------------------------------------------------------------------------
// 图片
// ---------------------------------------------------------------------------

const fileToDataUrl = (file: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error("read failed"))
    r.readAsDataURL(file)
  })

async function readImage(file: File): Promise<AttachPayload> {
  // 不能压的（或压完还是太大）就退回原图
  const small = (await compressToLimit(file, 1_500_000)) ?? file
  const url = await fileToDataUrl(small)
  if (!/^data:image\/(png|jpe?g|webp|gif);base64,/.test(url)) {
    throw new AttachError("imageFormat")
  }
  if (url.length > MAX_IMAGE_CHARS) throw new AttachError("imageTooLarge")
  return { images: [url] }
}

// ---------------------------------------------------------------------------
// 文本
// ---------------------------------------------------------------------------

/**
 * 解码后的二次嗅探。
 * 只看字节里的 NUL 不够：随机二进制往往没有 NUL，却会在 UTF-8 解码失败后
 * 被 GB18030「成功」解成一堆控制字符 —— 不拦下来就会把乱码当正文发给模型。
 */
function looksBinaryText(s: string): boolean {
  const n = Math.min(s.length, 20_000)
  if (!n) return false
  let bad = 0
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i)
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 0xfffd || (c >= 0x7f && c <= 0x9f)) bad++
  }
  return bad > Math.max(4, n * 0.01)
}

async function readPlainText(file: File): Promise<AttachPayload> {
  if (file.size > MAX_READ_BYTES) throw new AttachError("tooLarge")
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (looksBinary(bytes)) throw new AttachError("unsupported")
  const text = normalizeText(decodeText(bytes))
  if (looksBinaryText(text)) throw new AttachError("unsupported")
  return { text }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

class AttachError extends Error {
  reason: AttachIssueReason
  constructor(reason: AttachIssueReason) {
    super(reason)
    this.reason = reason
  }
}

/** 读一个文件；返回 null = 这个格式我们不认识 */
async function readOne(file: File): Promise<AttachPayload> {
  const ext = extOf(file.name)
  const lower = file.name.toLowerCase()

  if (file.type.startsWith("image/") || IMAGE_EXT.has(ext)) {
    return readImage(file)
  }

  // 文档/压缩包整体读入内存，超过上限直接拒绝（反正正文也会被截断）
  if (file.size > MAX_READ_BYTES) throw new AttachError("tooLarge")

  // 先看魔数：扩展名可能被改过（.doc 实为 zip、.txt 实为 PDF 之类）
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer())
  if (isPdf(head) || file.type === "application/pdf" || ext === "pdf") {
    return readPdf(file)
  }
  /**
   * ⚠️ 表格要排在 ZIP 前面：xlsx / ods 本身就是 ZIP，
   * 落到通用的 ZIP 分支只会得到一份「包内文件清单」，模型读不到单元格。
   */
  if (["xlsx", "xls", "xlsb", "xlsm", "ods"].includes(ext) || file.type.includes("spreadsheet")) {
    return { text: await readSpreadsheet(file) }
  }
  if (ext === "csv" || file.type === "text/csv") return readPlainText(file)
  if (isZip(head) || ["docx", "pptx", "epub", "odt", "odp"].includes(ext)) {
    return readZipLike(file)
  }
  // 老式 Word / PPT 是 OLE 复合文档，纯前端抽文本成本很高，明确告诉用户
  if (["doc", "ppt"].includes(ext)) throw new AttachError("unsupported")

  if (TEXT_MIME.test(file.type) || isTextName(file.name) || lower === "dockerfile") {
    return readPlainText(file)
  }

  // 扩展名不认识、MIME 也没有：最后再赌一把「它其实是文本」
  if (!file.type || file.type === "application/octet-stream") {
    try {
      return await readPlainText(file)
    } catch {
      throw new AttachError("unsupported")
    }
  }
  throw new AttachError("unsupported")
}

const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 读取一批文件。**只有读到内容的才会进 `items`**；
 * 失败的按原因放进 `issues`，由调用方提示用户。
 */
export async function readLabAttachments(files: File[]): Promise<AttachOutcome> {
  const items: Record<string, AttachPayload> = {}
  const issues: AttachIssue[] = []
  const truncated: string[] = []
  let textBudget = MAX_TEXT_CHARS_TOTAL
  let imageCount = 0

  for (const file of files) {
    try {
      const payload = await readOne(file)
      if (payload.images?.length) {
        const room = MAX_IMAGES_PER_TURN - imageCount
        if (room <= 0) {
          issues.push({ name: file.name, reason: "imageLimit" })
          continue
        }
        payload.images = payload.images.slice(0, room)
        imageCount += payload.images.length
      }
      if (payload.text !== undefined) {
        const text = payload.text
        if (textBudget <= 0) {
          issues.push({ name: file.name, reason: "tooLarge" })
          continue
        }
        if (text.length > MAX_TEXT_CHARS_PER_FILE) {
          payload.text = text.slice(0, MAX_TEXT_CHARS_PER_FILE)
          truncated.push(file.name)
        }
        if (payload.text.length > textBudget) {
          payload.text = payload.text.slice(0, textBudget)
          if (!truncated.includes(file.name)) truncated.push(file.name)
        }
        textBudget -= payload.text.length
      }
      if (payload.text !== undefined && !payload.text.trim() && !payload.images?.length) {
        issues.push({ name: file.name, reason: "readFailed" })
        continue
      }
      items[file.name] = payload
    } catch (e) {
      // 预期内的「不支持 / 太大」不吵控制台；真正意外的异常留一条，方便排查
      if (!(e instanceof AttachError)) console.warn("[lab-attach] failed:", file.name, e)
      issues.push({ name: file.name, reason: e instanceof AttachError ? e.reason : "readFailed" })
    }
  }

  return { items, issues, truncated }
}
