import * as React from "react"
import { ArrowDownUp, Check, Copy, Search } from "lucide-react"

import { ToolShell, ToolSection } from "@/components/toolbox/tool-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { copyText } from "@/lib/toolbox/utils"
import { useT } from "@/i18n"

type Mode = "escape" | "unescape" | "inspect"

const MODES: { id: Mode; label: string }[] = [
  { id: "escape", label: "ucv.mode.escape" },
  { id: "unescape", label: "ucv.mode.unescape" },
  { id: "inspect", label: "ucv.mode.inspect" },
]

/** 16 进制补足 4 位并套上 \u 前缀 */
function toEscape(cp: number, upper: boolean): string {
  const hex = cp.toString(16).padStart(4, "0")
  return "\\u" + (upper ? hex.toUpperCase() : hex.toLowerCase())
}

/**
 * 一个码点对应的转义写法。
 *
 * ⚠️ 超出 BMP 的字符（emoji 等，码点 > 0xFFFF）**没有**单条 `\uXXXX` 能表示它 ——
 * 必须拆成代理对两个转义（`\uD83D\uDE00`）。直接写 `\u1F600` 是无效转义，
 * 粘贴到代码里会报错，所以这里统一走代理对，和下面的转义输出保持一个口径。
 */
function escapeCodePoint(cp: number, upper: boolean): string {
  if (cp > 0xffff) {
    const h = Math.floor((cp - 0x10000) / 0x400) + 0xd800
    const l = ((cp - 0x10000) % 0x400) + 0xdc00
    return toEscape(h, upper) + toEscape(l, upper)
  }
  return toEscape(cp, upper)
}

/**
 * 文本 → `\uXXXX` 转义序列。
 *
 * 超出 BMP 的字符（emoji 等，码点 > 0xFFFF）必须拆成**代理对**两个 `\uXXXX`，
 * 否则解码端拿到的会是乱码 —— 这也是手写时常踩的坑，这里自动处理。
 */
function escapeUnicode(text: string, onlyNonAscii: boolean, upper: boolean): string {
  let out = ""
  // 用 for...of 按「码点」遍历，emoji 才不会被拆成两个半截字符
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (onlyNonAscii && cp < 0x80) {
      out += ch
      continue
    }
    out += escapeCodePoint(cp, upper)
  }
  return out
}

/**
 * 转义序列 → 文本。
 *
 * 兼容几种常见写法（很多人从不同地方拷来的串格式不一样，全认更省事）：
 *   · `\uXXXX`（含连续代理对）、`\u{1F600}`（ES6 写法）
 *   · `%uXXXX`（老式 JS `escape()` 的输出）
 *   · `&#x4E2D;` / `&#20013;`（HTML 数字实体）
 */
function unescapeUnicode(text: string): string {
  let out = text
  out = out.replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, h: string) =>
    safeFromCodePoint(parseInt(h, 16))
  )
  out = out.replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) =>
    String.fromCharCode(parseInt(h, 16))
  )
  out = out.replace(/%u([0-9a-fA-F]{4})/g, (_, h: string) =>
    String.fromCharCode(parseInt(h, 16))
  )
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) =>
    safeFromCodePoint(parseInt(h, 16))
  )
  out = out.replace(/&#(\d+);/g, (_, d: string) => safeFromCodePoint(parseInt(d, 10)))
  return out
}

/** 码点非法时原样返回一个替代符，避免整个转换抛错 */
function safeFromCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "\uFFFD"
  try {
    return String.fromCodePoint(cp)
  } catch {
    return "\uFFFD"
  }
}

/** 单个字符的 UTF-8 字节串（如 `E4 B8 AD`） */
function utf8Hex(ch: string): string {
  return Array.from(new TextEncoder().encode(ch))
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(" ")
}

interface CharRow {
  ch: string
  cp: number
  escaped: string
}

/** 把文本按码点拆成一行行，供码点表渲染 */
function toRows(text: string): CharRow[] {
  const rows: CharRow[] = []
  let cpIndex = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    rows.push({ ch, cp, escaped: escapeCodePoint(cp, true) })
    cpIndex++
    if (cpIndex >= 500) break // 防止超长文本把表格撑爆
  }
  return rows
}

export default function UnicodeConvertTool() {
  const { t } = useT()
  const [mode, setMode] = React.useState<Mode>("escape")
  const [input, setInput] = React.useState("")
  const [output, setOutput] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState(false)
  // 转义选项
  const [onlyNonAscii, setOnlyNonAscii] = React.useState(true)
  const [upper, setUpper] = React.useState(true)
  // 码点表搜索
  const [filter, setFilter] = React.useState("")

  const rows = React.useMemo(() => toRows(input), [input])

  React.useEffect(() => {
    if (!input) {
      setOutput("")
      setError(null)
      return
    }
    try {
      if (mode === "escape") {
        setOutput(escapeUnicode(input, onlyNonAscii, upper))
      } else if (mode === "unescape") {
        setOutput(unescapeUnicode(input))
      } else {
        setOutput(input)
      }
      setError(null)
    } catch {
      setOutput("")
      setError(t("ucv.err.convert"))
    }
  }, [input, mode, onlyNonAscii, upper])

  const copy = async (text: string) => {
    await copyText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  /** 码点表按关键词过滤：支持按字符本身、`4E2D`、`U+4E2D`、十进制数字搜 */
  const shownRows = React.useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) => {
      const hex = r.cp.toString(16)
      return (
        r.ch.toLowerCase() === q ||
        hex === q.replace(/^u\+/, "") ||
        r.escaped.toLowerCase().includes(q) ||
        String(r.cp) === q
      )
    })
  }, [rows, filter])

  /** 把码点表导成制表符分隔的文本，可直接粘进表格软件 */
  const tableText = React.useMemo(
    () =>
      [t("ucv.tsvHeader")]
        .concat(
          shownRows.map(
            (r) => `${r.ch}\tU+${r.cp.toString(16).toUpperCase().padStart(4, "0")}\t${r.cp}\t${utf8Hex(r.ch)}\t&#x${r.cp.toString(16).toUpperCase()};`
          )
        )
        .join("\n"),
    [shownRows]
  )

  return (
    <ToolShell
      title={t("toolbox.unicode.name")}
      description={t("ucv.desc")}
      wide
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <ToolSection title={t("ucv.section.input")}>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Select value={mode} onValueChange={(v) => setMode(v as Mode)}>
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODES.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {t(m.label)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="icon"
                title={t("ucv.swapHint")}
                disabled={!output || mode === "inspect"}
                onClick={() => {
                  setInput(output)
                  setMode(mode === "escape" ? "unescape" : "escape")
                }}
              >
                <ArrowDownUp className="h-4 w-4" />
              </Button>
            </div>

            {mode === "escape" && (
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md border bg-muted/30 px-3 py-2">
                {/* 注意：Radix 的 Switch 渲染出来是 <button>，套在 <label> 里点文字不会触发它，
                    所以文字单独挂 onClick —— 这样整行都好点，也不会出现 button 套 button */}
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Switch checked={onlyNonAscii} onCheckedChange={setOnlyNonAscii} />
                  <span
                    className="cursor-pointer select-none"
                    onClick={() => setOnlyNonAscii((v) => !v)}
                  >
                    {t("ucv.onlyNonAscii")}
                  </span>
                </span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Switch checked={upper} onCheckedChange={setUpper} />
                  <span className="cursor-pointer select-none" onClick={() => setUpper((v) => !v)}>
                    {t("ucv.upperHex")}
                  </span>
                </span>
              </div>
            )}

            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={12}
              spellCheck={false}
              className="min-h-[260px] font-mono text-[13px]"
              placeholder={
                mode === "unescape"
                  ? t("ucv.placeholder.escaped")
                  : t("ucv.placeholder.raw")
              }
            />
          </div>
        </ToolSection>

        <ToolSection
          title={t("ucv.result")}
          actions={
            mode !== "inspect" ? (
              <Button variant="ghost" size="sm" disabled={!output} onClick={() => void copy(output)}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied ? t("common.copied") : t("common.copy")}
              </Button>
            ) : undefined
          }
        >
          {error ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
              <p className="text-xs text-destructive">{error}</p>
            </div>
          ) : (
            <Textarea
              value={output}
              readOnly
              rows={12}
              spellCheck={false}
              className="min-h-[260px] font-mono text-[13px]"
              placeholder={t("ucv.resultPlaceholder")}
            />
          )}
          {mode === "unescape" && (
            <p className="text-xs text-muted-foreground">
              {t("ucv.compat.a")}
              <code className="font-mono">{"&#x4E2D;"}</code>
              {t("ucv.compat.b")}
            </p>
          )}
        </ToolSection>
      </div>

      <ToolSection
        title={t("ucv.charsTitle", { n: rows.length })}
        actions={
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={t("ucv.filterPlaceholder")}
                className="h-8 w-52 pl-7 text-xs"
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={shownRows.length === 0}
              onClick={() => void copy(tableText)}
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {t("ucv.copyTable")}
            </Button>
          </div>
        }
      >
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t("ucv.emptyHint")}
          </p>
        ) : shownRows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t("ucv.noMatch")}</p>
        ) : (
          <div className="max-h-[420px] overflow-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted/60 text-xs text-muted-foreground backdrop-blur">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">{t("ucv.col.char")}</th>
                  <th className="px-3 py-2 text-left font-medium">{t("ucv.col.codePoint")}</th>
                  <th className="px-3 py-2 text-left font-medium">{t("ucv.col.decimal")}</th>
                  <th className="px-3 py-2 text-left font-medium">{t("ucv.col.escape")}</th>
                  <th className="px-3 py-2 text-left font-medium">UTF-8</th>
                  <th className="px-3 py-2 text-left font-medium">{t("ucv.col.htmlEntity")}</th>
                </tr>
              </thead>
              <tbody>
                {shownRows.map((r, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-3 py-1.5 font-mono text-base">
                      {/* 空格、换行这类看不见的字符给个可见占位，否则表格里是一行空 */}
                      {r.ch === " " ? "␣" : r.ch === "\n" ? "⏎" : r.ch === "\t" ? "⇥" : r.ch}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-xs">
                      U+{r.cp.toString(16).toUpperCase().padStart(4, "0")}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-xs">{r.cp}</td>
                    <td className="px-3 py-1.5 font-mono text-xs">{r.escaped}</td>
                    <td className="px-3 py-1.5 font-mono text-xs">{utf8Hex(r.ch)}</td>
                    <td className="px-3 py-1.5 font-mono text-xs">
                      {`&#x${r.cp.toString(16).toUpperCase()};`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ToolSection>
    </ToolShell>
  )
}
