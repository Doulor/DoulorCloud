/**
 * 工具箱通用工具函数。
 *
 * 全部在浏览器本地执行 —— 这些函数不产生任何网络请求，
 * 用户选中的文件自始至终留在自己的设备上。
 */

/** 触发浏览器「另存为」下载 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
}

/** 人类可读的体积，如 1.2 MB */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const v = bytes / Math.pow(1024, i)
  return `${i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/** 去掉扩展名的文件名 */
export function baseName(name: string): string {
  return name.replace(/\.[^./\\]+$/, "")
}

/** 扩展名（小写，不含点）；没有扩展名时返回空串 */
export function extName(name: string): string {
  const m = /\.([^./\\]+)$/.exec(name)
  return m ? m[1].toLowerCase() : ""
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/** 从 File/Blob 加载为 Image 元素（用完自动释放 objectURL） */
export function loadImageFile(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file)
  return loadImageFromUrl(url).finally(() => URL.revokeObjectURL(url))
}

export function loadImageFromUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error("图片解码失败，可能格式不受支持"))
    img.src = url
  })
}

export function createCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas")
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("当前浏览器无法创建画布")
  return { canvas, ctx }
}

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  type = "image/png",
  quality?: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("导出图片失败，可能是画布过大"))),
      type,
      quality
    )
  })
}

/** 等比缩放到指定长边，返回新画布（只缩不放） */
export function scaleCanvasToLongEdge(src: HTMLCanvasElement, maxLong: number) {
  const long = Math.max(src.width, src.height)
  const scale = long > maxLong ? maxLong / long : 1
  const { canvas, ctx } = createCanvas(src.width * scale, src.height * scale)
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height)
  return canvas
}

export function readAsText(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result ?? ""))
    r.onerror = () => reject(new Error("读取文件失败"))
    r.readAsText(file)
  })
}

export function readAsArrayBuffer(file: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as ArrayBuffer)
    r.onerror = () => reject(new Error("读取文件失败"))
    r.readAsArrayBuffer(file)
  })
}

export function readAsDataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result ?? ""))
    r.onerror = () => reject(new Error("读取文件失败"))
    r.readAsDataURL(file)
  })
}

/**
 * 把画布导出成 ICO 文件。
 *
 * ICO 允许内嵌 PNG（Vista 以后全支持），所以不必手写 BMP 编码。
 * 结构：6 字节文件头 + 每个尺寸 16 字节目录项 + 依次排列的 PNG 数据。
 * 宽高字段是 1 字节，0 表示 256。
 */
export async function canvasToIco(sizes: { size: number; canvas: HTMLCanvasElement }[]): Promise<Blob> {
  const images = await Promise.all(
    sizes.map(async (s) => ({
      size: s.size,
      bytes: new Uint8Array(await (await canvasToBlob(s.canvas, "image/png")).arrayBuffer()),
    }))
  )

  const header = 6 + images.length * 16
  const total = header + images.reduce((n, i) => n + i.bytes.length, 0)
  const buf = new ArrayBuffer(total)
  const view = new DataView(buf)
  const out = new Uint8Array(buf)

  view.setUint16(0, 0, true) // reserved
  view.setUint16(2, 1, true) // type: 1 = icon
  view.setUint16(4, images.length, true)

  let offset = header
  images.forEach((img, i) => {
    const p = 6 + i * 16
    view.setUint8(p, img.size >= 256 ? 0 : img.size)
    view.setUint8(p + 1, img.size >= 256 ? 0 : img.size)
    view.setUint8(p + 2, 0) // 调色板数
    view.setUint8(p + 3, 0) // reserved
    view.setUint16(p + 4, 1, true) // 色彩平面
    view.setUint16(p + 6, 32, true) // 位深
    view.setUint32(p + 8, img.bytes.length, true)
    view.setUint32(p + 12, offset, true)
    out.set(img.bytes, offset)
    offset += img.bytes.length
  })

  return new Blob([buf], { type: "image/x-icon" })
}

/** 复制文本到剪贴板，带降级方案（非 HTTPS / 旧浏览器） */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement("textarea")
    ta.value = text
    ta.style.position = "fixed"
    ta.style.opacity = "0"
    document.body.appendChild(ta)
    ta.select()
    document.execCommand("copy")
    ta.remove()
  }
}

/** 把秒数格式化成 00:00 / 00:00:00 */
export function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "00:00"
  const s = Math.floor(seconds % 60)
  const m = Math.floor((seconds / 60) % 60)
  const h = Math.floor(seconds / 3600)
  const pad = (n: number) => String(n).padStart(2, "0")
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/** 把 Float32 PCM 编码成 16 位 WAV（音频类工具的统一出口） */
export function encodeWav(channels: Float32Array[], sampleRate: number): Blob {
  const numCh = channels.length
  const frames = channels[0]?.length ?? 0
  const dataBytes = frames * numCh * 2
  const buf = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buf)

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }

  writeStr(0, "RIFF")
  view.setUint32(4, 36 + dataBytes, true)
  writeStr(8, "WAVE")
  writeStr(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, numCh, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * numCh * 2, true)
  view.setUint16(32, numCh * 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, "data")
  view.setUint32(40, dataBytes, true)

  let offset = 44
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      const v = clamp(channels[c][i] ?? 0, -1, 1)
      view.setInt16(offset, v < 0 ? v * 0x8000 : v * 0x7fff, true)
      offset += 2
    }
  }
  return new Blob([buf], { type: "audio/wav" })
}
