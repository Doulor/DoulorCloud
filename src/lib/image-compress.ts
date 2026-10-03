import { tStatic } from "@/i18n"
import { GIFEncoder, applyPalette, quantize } from "gifenc"

/** 将图片文件压缩到长边 1600px，输出 WebP（质量自适应） */
export async function compressImage(
  file: File,
  maxLong = 1600,
  quality = 0.8
): Promise<File> {
  const img = await loadImage(file)
  let { width, height } = img
  if (Math.max(width, height) > maxLong) {
    const scale = maxLong / Math.max(width, height)
    width = Math.round(width * scale)
    height = Math.round(height * scale)
  }
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error(tStatic("icp.err.ctx"))
  ctx.drawImage(img, 0, 0, width, height)
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(tStatic("icp.err.compress")))), "image/webp", quality)
  )
  return new File([blob], file.name.replace(/\.[^.]+$/, ".webp"), { type: "image/webp" })
}

/**
 * 把图片压到 `limit` 字节以内（表情包用）。
 *
 *  · 静态图（png/jpg/webp）→ canvas 转 WebP，逐步「降长边 + 降质量」；
 *  · GIF → 用浏览器原生 `ImageDecoder` 解出每一帧、整体缩放后拿 `gifenc` 重编码
 *    （**保留动画与透明**）。这条路径不需要额外依赖（`gifenc` 项目里本来就有，
 *    工具箱的「视频转 GIF」在用）。
 *
 * 压不下去（或浏览器不支持 ImageDecoder / 帧数过多）返回 `null`，
 * 调用方按原来的「超过 X KB」提示报错即可 —— 绝不能把压不动的图硬传上去。
 */
export async function compressToLimit(file: File, limit: number): Promise<File | null> {
  try {
    return file.type === "image/gif"
      ? await compressGif(file, limit)
      : await compressRaster(file, limit)
  } catch {
    return null
  }
}

/** 静态图：逐档降长边 × 降质量，第一个达标就返回 */
const RASTER_LONG_SIDES = [1600, 1200, 900, 700, 520, 400]
const RASTER_QUALITIES = [0.8, 0.6, 0.45, 0.32]

async function compressRaster(file: File, limit: number): Promise<File | null> {
  const img = await loadImage(file)
  const srcW = img.naturalWidth || img.width
  const srcH = img.naturalHeight || img.height
  const srcLong = Math.max(srcW, srcH)
  // 候选长边 = 比原图小的档位 + 原图本身（去重后**从大到小**试，优先保住清晰度）
  const longs = [...new Set([...RASTER_LONG_SIDES.filter((n) => n < srcLong), srcLong])].sort(
    (a, b) => b - a
  )
  for (const maxLong of longs) {
    const scale = Math.min(1, maxLong / srcLong)
    const width = Math.max(1, Math.round(srcW * scale))
    const height = Math.max(1, Math.round(srcH * scale))
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext("2d")
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, width, height)
    for (const q of RASTER_QUALITIES) {
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/webp", q))
      if (blob && blob.size <= limit) {
        return new File([blob], file.name.replace(/\.[^.]+$/, ".webp"), { type: "image/webp" })
      }
    }
  }
  return null
}

// ImageDecoder 在部分浏览器（旧 Firefox）没有 —— 用最小本地类型，避免依赖 lib.dom 的版本
interface DecodedFrame {
  displayWidth: number
  displayHeight: number
  duration: number | null
  close?: () => void
}
interface GifDecoder {
  completed: Promise<void>
  tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } | null }
  decode(opts: { frameIndex: number }): Promise<{ image: DecodedFrame }>
}

/** 动图：解帧 → 缩放 → gifenc 重编码（保留动画/透明）。压不下去返回 null */
async function compressGif(file: File, limit: number): Promise<File | null> {
  const Ctor = (window as unknown as { ImageDecoder?: new (o: { data: ArrayBuffer; type: string }) => GifDecoder })
    .ImageDecoder
  if (!Ctor) return null

  const decoder = new Ctor({ data: await file.arrayBuffer(), type: "image/gif" })
  // ⚠️ 只 await `completed` 不够 —— 那只是「数据读完」，此时 `tracks.selectedTrack`
  //    还是 null，帧数会被 `?? 1` 兜成 1，编出来是**静止图**（动画没了）。
  //    必须等 `tracks.ready` 才能拿到真实帧数。
  await decoder.tracks.ready
  const totalFrames = decoder.tracks.selectedTrack?.frameCount ?? 0
  // 拿不到帧数（浏览器实现差异）→ 不压，交给调用方报「太大」，绝不冒险压成静止图
  if (totalFrames <= 0) return null
  // 单帧 GIF 其实是静态图，直接走 WebP 那条路（体积比 GIF 小得多）
  if (totalFrames === 1) return await compressRaster(file, limit)
  const frameCount = totalFrames
  // 帧数过多时逐帧重编码代价太大（阻塞主线程），直接让用户先裁一裁
  if (frameCount > 300) return null

  const first = await decoder.decode({ frameIndex: 0 })
  const srcW = first.image.displayWidth
  const srcH = first.image.displayHeight
  first.image.close?.()

  for (const scale of [1, 0.8, 0.65, 0.5, 0.4, 0.3, 0.22]) {
    const outW = Math.max(2, Math.round(srcW * scale))
    const outH = Math.max(2, Math.round(srcH * scale))
    const canvas = document.createElement("canvas")
    canvas.width = outW
    canvas.height = outH
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    if (!ctx) return null

    // 先采几帧算一份**全局调色板**（逐帧调色板会把体积推上去）
    const sampleCount = Math.min(6, frameCount)
    const merged = new Uint8Array(sampleCount * outW * outH * 4)
    for (let i = 0; i < sampleCount; i++) {
      const idx = Math.floor((i * frameCount) / sampleCount)
      const { image } = await decoder.decode({ frameIndex: idx })
      ctx.clearRect(0, 0, outW, outH)
      ctx.drawImage(image as unknown as CanvasImageSource, 0, 0, outW, outH)
      merged.set(ctx.getImageData(0, 0, outW, outH).data, i * outW * outH * 4)
      image.close?.()
    }
    // rgba4444 + oneBitAlpha：GIF 只支持 1 位透明，这样 quantize 才能正确处理透明像素
    const palette = quantize(merged, 256, { format: "rgba4444", oneBitAlpha: true })

    const gif = GIFEncoder()
    for (let i = 0; i < frameCount; i++) {
      const { image } = await decoder.decode({ frameIndex: i })
      ctx.clearRect(0, 0, outW, outH)
      ctx.drawImage(image as unknown as CanvasImageSource, 0, 0, outW, outH)
      const { data } = ctx.getImageData(0, 0, outW, outH)
      const index = applyPalette(data, palette, "rgba4444")
      // duration 单位是微秒；GIF 的 delay 单位是 1/100 秒（毫秒传入即可）
      const delay = Math.max(20, Math.round((image.duration ?? 100_000) / 1000))
      gif.writeFrame(index, outW, outH, { palette, delay, transparent: true, repeat: 0 })
      image.close?.()
    }
    gif.finish()
    const out = new File(
      [new Uint8Array(gif.bytesView())],
      file.name.replace(/\.[^.]+$/, ".gif"),
      { type: "image/gif" }
    )
    if (out.size <= limit) return out
  }
  return null
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(tStatic("icp.err.load"))) }
    img.src = url
  })
}
