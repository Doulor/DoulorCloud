import { tStatic } from "@/i18n"
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

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(tStatic("icp.err.load"))) }
    img.src = url
  })
}
