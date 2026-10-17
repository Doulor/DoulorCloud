/**
 * 把项目文件表里的「data URL」还原成二进制。
 *
 * 「添加素材」把字体 / 音频 / 视频 / 图片都编码成 data URL 存进 `Record<路径, 字符串>`
 * （见 lab.tsx 的 ingestAssets）。预览时直接当 URL 用没问题，但**导出**时
 * 不能再把 `data:image/png;base64,...` 这串文本写进 .png 文件 ——
 * 之前就是这样：导出的图片/字体全是文本，打不开。
 */
export function dataUrlToBytes(content: string): Uint8Array | null {
  const m = /^data:([^;,]*)((?:;[^,]*)*),([\s\S]*)$/i.exec(content.trim())
  if (!m) return null
  const params = m[2] ?? ""
  const body = m[3]

  if (/;base64/i.test(params)) {
    try {
      const bin = atob(body.replace(/\s+/g, ""))
      const out = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
      return out
    } catch {
      return null
    }
  }
  // 非 base64（典型是 SVG 的 URL 编码文本）
  try {
    return new TextEncoder().encode(decodeURIComponent(body))
  } catch {
    return new TextEncoder().encode(body)
  }
}
