/**
 * 作品导出（2026-10-10 站长要求）：
 *   · `buildSingleFileHtml()` —— 把 CSS / JS 内联进一个 .html，双击就能看；
 *   · `zipFiles()`            —— 打成 zip，保留原来的目录结构。
 *
 * ⚠️ 这里**自己写了一个最小 ZIP 编码器**，没有引第三方库。
 * 理由：只用得上「不压缩地存进去」（STORE）这一种能力，
 * 为它多背一个依赖（还得多过一遍供应链审计）不划算。
 * 代价是导出的包比能压缩的大一些 —— 作品都是文本，几百 KB 量级，可以接受。
 */

/** HTML 里的转义（内联脚本内容时不能让它提前闭合） */
function escapeForInlineScript(code: string): string {
  return code.replace(/<\/script/gi, "<\\/script")
}

/** 去掉路径首尾的 `./`、`/`，统一成 zip 内的相对路径 */
function normalizePath(p: string): string {
  return p.replace(/^\.?\//, "").replace(/\/+/g, "/")
}

/**
 * 单文件 HTML：把同目录（或相对路径）的 CSS/JS 内联进去。
 *
 * ⚠️ 只内联**本项目里能找到的**相对路径；`https://` 开头的一律留着 ——
 * 那些是 CDN，内联不了（也不该替用户去下载）。
 * 找不到的文件也留着原样：宁可导出后缺一个文件，也不要静默删掉引用。
 */
export function buildSingleFileHtml(files: Record<string, string>): string {
  const entry =
    files["index.html"] ??
    Object.keys(files).find((p) => p.toLowerCase().endsWith(".html")) ??
    null
  if (!entry) return ""

  const dir = entry.includes("/") ? entry.slice(0, entry.lastIndexOf("/") + 1) : ""
  const resolve = (href: string): string | null => {
    if (/^(https?:)?\/\//i.test(href) || href.startsWith("data:")) return null
    const clean = normalizePath(href.replace(/^\.\//, ""))
    return files[clean] ?? files[dir + clean] ?? null
  }

  let html = files[entry]

  // <link rel="stylesheet" href="x.css"> → <style>…</style>
  html = html.replace(
    /<link\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*?>/gi,
    (tag, href: string) => {
      if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) return tag
      const css = resolve(href)
      return css == null ? tag : `<style>\n${css}\n</style>`
    }
  )

  // <script src="x.js"></script> → <script>…</script>
  html = html.replace(
    /<script\b([^>]*?)src\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi,
    (tag, pre: string, src: string, post: string) => {
      // 带 type="module" 的外链脚本内联后行为会变（相对导入失效），保守起见跳过
      if (/type\s*=\s*["']?module/i.test(pre + post)) return tag
      const js = resolve(src)
      return js == null ? tag : `<script>${escapeForInlineScript(js)}</script>`
    }
  )

  return html
}

/* ------------------------------------------------------------------ */
/* 最小 ZIP 编码器（STORE，不压缩）                                     */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * 打成 zip。
 * ⚠️ 文件名统一用 UTF-8 并置上 flag 0x0800，否则中文名在 Windows 上会变乱码。
 */
export function zipFiles(files: Record<string, string>): Blob {
  const enc = new TextEncoder()
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  // ZIP 的时间戳用 DOS 格式。这里固定成当前时间（导出时间），对用户更直观。
  const now = new Date()
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)
  const dosDate =
    (((now.getFullYear() - 1980) & 0x7f) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()

  const u16 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff])
  const u32 = (n: number) =>
    new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff])

  for (const [rawPath, content] of Object.entries(files)) {
    const name = normalizePath(rawPath)
    if (!name) continue
    const nameBytes = enc.encode(name)
    const data = enc.encode(content)
    const crc = crc32(data)

    const local = [
      u32(0x04034b50),
      u16(20),
      u16(0x0800), // UTF-8 文件名
      u16(0), // STORE
      u16(dosTime),
      u16(dosDate),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
    ]
    chunks.push(...local, data)

    central.push(
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(dosTime),
      u16(dosDate),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBytes
    )

    // 本地头的总长度 = 固定 30 字节 + 文件名 + 数据
    offset += 30 + nameBytes.length + data.length
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0)
  const eocd = [
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(central.length === 0 ? 0 : central.length / 21),
    u16(central.length === 0 ? 0 : central.length / 21),
    u32(centralSize),
    u32(offset),
    u16(0),
  ]

  // TS 对 Uint8Array<ArrayBufferLike> 与 BlobPart 的兼容判得比较死，
  // 这里显式收成 BlobPart[]（运行时就是普通二进制，没问题）
  const parts = [...chunks, ...central, ...eocd] as unknown as BlobPart[]
  return new Blob(parts, { type: "application/zip" })
}

/** 触发浏览器下载（临时 a 标签，用完即撤） */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 立刻 revoke 会让部分浏览器来不及下载，延后一点释放
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
