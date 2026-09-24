/**
 * 全站共用的时间 / 体积格式化。
 *
 * 为什么要有这个文件：这些函数原先在 8 个页面里各写了一份，格式已经开始分叉
 * （比如有的带秒、有的 null 返回 "—"、有的按"是否今天"分支）。散落各处时
 * 想统一调整格式要改 8 个地方，且很容易漏。
 *
 * 注意：这里刻意保留了两种「体积」格式，因为它们的显示效果本来就不同：
 *   - formatBytes  ：精确到小数位（1.5 MB / 23 MB），用于网盘、名片等需要准确的场景
 *   - formatBytesShort：取整（2 MB / 1024 KB），用于概览卡等只需大致感知的场景
 * 不要为了「统一」把它们合并成一个 —— 那会改变现有页面的显示数字。
 */

/** 时间戳格式化：`9/23 14:05`。null / 非法值经 opts.fallback 处理 */
export function fmtTime(iso: string | null | undefined, fallback = "—"): string {
  if (!iso) return fallback
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return fallback
  return d.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/**
 * 邮件列表用的时间：今天只显示时刻（14:05），更早显示日期（9/23）。
 * 邮件列表里同一天的邮件最多，省掉重复的日期更利于扫读。
 */
export function fmtMailTime(iso: string | null | undefined, fallback = "—"): string {
  if (!iso) return fallback
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return fallback
  if (d.toDateString() === new Date().toDateString()) {
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
  }
  return d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })
}

/** 完整日期时间（含年份），用于 tooltip / 详情等需要精确时间的场景 */
export function fmtDateTime(iso: string | null | undefined, fallback = "—"): string {
  if (!iso) return fallback
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return fallback
  return d.toLocaleString("zh-CN")
}

/** 相对时间：刚刚 / 3 分钟前 / 2 小时前 / 昨天 / 3 天前，超过 7 天回退到日期 */
export function relTime(iso: string | null | undefined, fallback = "—"): string {
  if (!iso) return fallback
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return fallback
  const m = Math.floor((Date.now() - t) / 60000)
  if (m < 1) return "刚刚"
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d === 1) return "昨天"
  if (d < 7) return `${d} 天前`
  return fmtTime(iso, fallback)
}

/**
 * 体积：精确到小数位。
 * 1.5 MB / 23 MB / 1.2 GB —— 用于需要准确数字的场景。
 */
export function formatBytes(bytes: number): string {
  if (!bytes) return "0 B"
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`
}

/**
 * 体积：取整。
 * 2 MB / 1024 KB —— 用于概览卡等只需大致感知大小的场景。
 */
export function formatBytesShort(n: number): string {
  if (!n) return "0 B"
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (n >= 1024 * 1024) return `${Math.round(n / 1024 / 1024)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}
