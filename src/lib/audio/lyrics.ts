/** LRC / TTML / 纯文本歌词互转与解析（纯 TS，无依赖）。 */

export interface LyricLine {
  /** 秒；null 表示该行无时间戳 */
  time: number | null
  text: string
}

const LRC_TIME_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g

function parseTime(min: string, sec: string, frac?: string): number {
  const base = parseInt(min, 10) * 60 + parseInt(sec, 10)
  if (!frac) return base
  const f = (frac + "000").slice(0, 3)
  return base + parseInt(f, 10) / 1000
}

/** 解析 LRC 文本（含逐字歌词的行内时间戳会被保留在文本里）。 */
export function parseLrc(text: string): LyricLine[] {
  return text.split(/\r?\n/).map((raw) => {
    const times: number[] = []
    let m: RegExpExecArray | null
    LRC_TIME_RE.lastIndex = 0
    while ((m = LRC_TIME_RE.exec(raw)) !== null) {
      times.push(parseTime(m[1], m[2], m[3]))
    }
    const lineText = raw.replace(LRC_TIME_RE, "").trim()
    return { time: times.length ? times[0] : null, text: lineText }
  }).filter((l) => l.text.length > 0 || l.time !== null)
}

export function formatLrcTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  const ms = Math.round((sec - Math.floor(sec)) * 100)
  const pad = (n: number, w = 2) => String(n).padStart(w, "0")
  return `[${pad(m)}:${pad(s)}.${pad(ms)}]`
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function formatTtmlTime(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const ms = Math.round((sec - Math.floor(sec)) * 1000)
  const pad = (n: number, w = 2) => String(n).padStart(w, "0")
  return `${pad(h)}:${pad(m)}:${pad(s)}.${String(ms).padStart(3, "0")}`
}

/** LRC → 纯文本（去掉时间戳）。 */
export function lrcToText(lrc: string): string {
  return parseLrc(lrc).map((l) => l.text).join("\n")
}

/** 纯文本 → LRC（无时间戳的行补 [00:00.00]，已有时间戳的行保留）。 */
export function textToLrc(text: string): string {
  return text.split(/\r?\n/).map((raw) => {
    const line = raw.trimEnd()
    if (!line.trim()) return ""
    LRC_TIME_RE.lastIndex = 0
    return LRC_TIME_RE.test(line) ? line : `[00:00.00]${line}`
  }).join("\n")
}

/** LRC → TTML（无时间戳的行按顺序放在 body 末尾，不带 begin）。 */
export function lrcToTtml(lrc: string): string {
  const lines = parseLrc(lrc)
  const timed = lines.filter((l) => l.time !== null)
  const untimed = lines.filter((l) => l.time === null)
  const paras: string[] = []
  timed.forEach((l, i) => {
    const begin = formatTtmlTime(l.time as number)
    const next = timed[i + 1]
    const endAttr = next?.time != null ? ` end="${formatTtmlTime(next.time)}"` : ""
    paras.push(`    <p begin="${begin}"${endAttr}>${escapeXml(l.text)}</p>`)
  })
  for (const l of untimed) paras.push(`    <p>${escapeXml(l.text)}</p>`)
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="">`,
    `  <body>`,
    `    <div>`,
    ...paras,
    `    </div>`,
    `  </body>`,
    `</tt>`,
  ].join("\n")
}

const TTML_P_RE = /<p(?:\s+begin="([^"]*)")?[^>]*>([\s\S]*?)<\/p>/gi
const TTML_TIME_RE = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?$/

function parseTtmlTime(s: string): number | null {
  const m = TTML_TIME_RE.exec(s.trim())
  if (!m) return null
  const h = m[1] ? parseInt(m[1], 10) : 0
  const base = h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10)
  if (!m[4]) return base
  return base + parseInt((m[4] + "000").slice(0, 3), 10) / 1000
}

function stripTags(s: string): string {
  return s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
}

/** TTML → LRC。 */
export function ttmlToLrc(ttml: string): string {
  const lines: string[] = []
  let m: RegExpExecArray | null
  TTML_P_RE.lastIndex = 0
  while ((m = TTML_P_RE.exec(ttml)) !== null) {
    const t = m[1] ? parseTtmlTime(m[1]) : null
    const text = stripTags(m[2]).trim()
    if (!text) continue
    lines.push(t !== null ? `${formatLrcTime(t)}${text}` : text)
  }
  return lines.join("\n")
}

/** 粗略判断文本是否为 TTML。 */
export function looksLikeTtml(text: string): boolean {
  return /<tt[\s>]|<p[\s>]/i.test(text)
}

/** 粗略判断文本是否为 LRC（含时间戳）。 */
export function looksLikeLrc(text: string): boolean {
  LRC_TIME_RE.lastIndex = 0
  return LRC_TIME_RE.test(text)
}
