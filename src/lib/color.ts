/**
 * 自定义称号徽章的颜色工具（纯函数，无依赖）。
 *
 * 库里只存管理员填的两个主色（#RRGGBB），其余全部自动衍生：
 *   · 文字黑/白 —— 按渐变两端的平均亮度（YIQ）判断；
 *   · 描边流光 —— 主色按固定比例混白，复刻 RoleBadge 的观感
 *     （管理员徽章 = amber-100 底 + amber-300 光斑 ≈ 主色 28% / 62% 混白）。
 *
 * 为什么在 JS 里算而不是用 CSS color-mix()：conic-gradient 的色标里
 * 组合 var() + color-mix() 在部分内核上不可靠；直接算出具体 hex 内联，
 * 与 role-ring 的实现等价、兼容性一致。
 */

/** #RRGGBB → [r, g, b]；不合法返回 null */
export function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const toHex2 = (v: number) =>
  Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")

/** rgb → #rrggbb */
export function rgbToHex(r: number, g: number, b: number): string {
  return `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`
}

/** 把颜色与白色按比例混合（ratio = 白色占比，0 = 原色，1 = 纯白）；非法输入回灰色 */
export function mixWithWhite(hex: string, ratio: number): string {
  const c = parseHex(hex)
  if (!c) return "#e2e8f0"
  return rgbToHex(
    c[0] + (255 - c[0]) * ratio,
    c[1] + (255 - c[1]) * ratio,
    c[2] + (255 - c[2]) * ratio
  )
}

/** YIQ 亮度（0~255） */
function yiq(r: number, g: number, b: number): number {
  return (r * 299 + g * 587 + b * 114) / 1000
}

/** 徽章文字颜色：渐变两端平均亮度 > 150 用深色（浅底），否则白（深底） */
export function readableTextOn(from: string, to: string): string {
  const a = parseHex(from)
  const b = parseHex(to)
  if (!a || !b) return "#ffffff"
  const l = (yiq(a[0], a[1], a[2]) + yiq(b[0], b[1], b[2])) / 2
  return l > 150 ? "#1e293b" : "#ffffff"
}

/** 描边流光的底色：主色（起点色）约 28% 浓度混白，对标 amber-100 / rose-100 的观感 */
export function ringBaseColor(from: string): string {
  return mixWithWhite(from, 0.72)
}

/** 描边流光的流动光斑色：主色约 62% 浓度混白，对标 amber-300 / rose-400 的观感 */
export function ringSpotColor(from: string): string {
  return mixWithWhite(from, 0.38)
}
