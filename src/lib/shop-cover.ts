/**
 * 商品封面输入的前端校验（用户端 points.tsx 与管理端 admin-points.tsx 共用）。
 *
 * 后端才是权威（worker/src/points-shop.ts 的 sanitizeProductInput），这里保持
 * **同一套口径**，让用户在点保存前就拿到可理解的报错，而不是白等一次往返。
 *
 * 三种合法形态（与服务端一致）：
 *   ① http(s) 绝对链接 —— 外链图床；
 *   ② /api/shop-img/... —— 「本地上传」返回的站内路径；
 *   ③ data:image/... —— 内联 Data URL（白名单类型 + 长度上限，见下）。
 */

/** 封面 Data URL 的类型白名单与 base64 结构判定（与服务端正则同口径） */
const DATA_URL_PREFIX_RE =
  /^data:image\/(png|jpeg|jpg|webp|gif|avif|svg\+xml)(;base64)?,/i
const DATA_URL_B64_RE = /^[A-Za-z0-9+/=_-]+\s*$/

/** Data URL 封面长度上限（字符）：与服务端 MAX_COVER_DATA_URL_CHARS 一致 */
export const MAX_COVER_DATA_URL_CHARS = 100_000

/** 「本地上传」文件选择框的 accept 值：位图 + SVG */
export const COVER_FILE_ACCEPT = "image/jpeg,image/png,image/webp,image/gif,image/svg+xml"

/** 「本地上传」允许的 MIME（与 accept 一致；服务端 SHOP_IMAGE_TYPES 同口径） */
const COVER_FILE_TYPE_RE = /^image\/(jpeg|png|webp|gif|svg\+xml)$/

/** 位图封面的体积上限（服务端同款：5 MB） */
export const MAX_COVER_FILE_BYTES = 5 * 1024 * 1024
/** SVG 封面的体积上限（服务端同款：1 MB —— 文本格式没必要给到 5 MB） */
export const MAX_COVER_SVG_BYTES = 1024 * 1024

/** 封面输入的校验结果：ok = 放行；其余值对应具体的用户可读报错（i18n 键后缀） */
export type CoverInputVerdict = "ok" | "invalid" | "tooLarge"

/** 是否为白名单类型 + 结构合法的图片 Data URL（长度不管，由 validateCoverInput 判） */
export function isDataImageUrl(value: string): boolean {
  const m = DATA_URL_PREFIX_RE.exec(value)
  if (!m) return false
  if (m[2]) {
    const body = value.slice(m[0].length)
    return body.length > 0 && DATA_URL_B64_RE.test(body.trim())
  }
  return value.length > m[0].length
}

/**
 * 校验封面输入框的值。空值合法（封面可选）。
 *
 * 返回 "invalid" / "tooLarge" 时调用方拼 `pt.err.cover${Verdict}` 显示。
 */
export function validateCoverInput(value: string): CoverInputVerdict {
  const v = value.trim()
  if (!v) return "ok"
  if (isDataImageUrl(v)) {
    return v.length > MAX_COVER_DATA_URL_CHARS ? "tooLarge" : "ok"
  }
  if (/^https?:\/\//i.test(v)) return "ok"
  if (v.startsWith("/api/shop-img/")) return "ok"
  return "invalid"
}

/** 「本地上传」选中的文件是否在允许的类型里 */
export function isAllowedCoverFile(file: File): boolean {
  return COVER_FILE_TYPE_RE.test(file.type)
}

/** 「本地上传」的体积上限：SVG 单独收紧，其余位图 5 MB */
export function coverFileTooLarge(file: File): boolean {
  const cap = file.type === "image/svg+xml" ? MAX_COVER_SVG_BYTES : MAX_COVER_FILE_BYTES
  return file.size > cap
}
