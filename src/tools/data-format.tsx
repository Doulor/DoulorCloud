import * as React from "react"
import { ArrowRight, Check, Copy, Download } from "lucide-react"
import { dump as yamlDump, load as yamlLoad } from "js-yaml"

import { ToolShell, ToolSection } from "@/components/toolbox/tool-shell"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { copyText, downloadBlob } from "@/lib/toolbox/utils"

type Fmt = "json" | "yaml" | "xml"

const EXT: Record<Fmt, string> = { json: "json", yaml: "yaml", xml: "xml" }

/** XML → 普通对象。约定：属性加 @ 前缀，纯文本节点用 #text */
function elementToValue(el: Element): unknown {
  const obj: Record<string, unknown> = {}
  for (const attr of Array.from(el.attributes)) obj[`@${attr.name}`] = attr.value

  const children = Array.from(el.children)
  if (children.length === 0) {
    const text = (el.textContent ?? "").trim()
    if (Object.keys(obj).length === 0) return text
    if (text) obj["#text"] = text
    return obj
  }

  for (const child of children) {
    const value = elementToValue(child)
    const key = child.tagName
    if (key in obj) {
      const cur = obj[key]
      if (Array.isArray(cur)) cur.push(value)
      else obj[key] = [cur, value]
    } else {
      obj[key] = value
    }
  }
  return obj
}

function xmlToValue(text: string): unknown {
  const doc = new DOMParser().parseFromString(text, "application/xml")
  if (doc.querySelector("parsererror")) {
    throw new Error("XML 解析失败，请检查标签是否闭合、属性有没有加引号")
  }
  return { [doc.documentElement.tagName]: elementToValue(doc.documentElement) }
}

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

function valueToXml(name: string, value: unknown, depth: number): string {
  const pad = "  ".repeat(depth)

  if (Array.isArray(value)) {
    return value.map((v) => valueToXml(name, v, depth)).join("\n")
  }

  if (value === null || value === undefined || typeof value !== "object") {
    return `${pad}<${name}>${escapeXml(String(value ?? ""))}</${name}>`
  }

  const obj = value as Record<string, unknown>
  const attrs = Object.entries(obj)
    .filter(([k]) => k.startsWith("@"))
    .map(([k, v]) => ` ${k.slice(1)}="${escapeXml(String(v))}"`)
    .join("")

  const children = Object.entries(obj).filter(([k]) => !k.startsWith("@") && k !== "#text")
  const text = typeof obj["#text"] === "string" ? escapeXml(obj["#text"]) : ""

  if (children.length === 0) {
    return `${pad}<${name}${attrs}>${text}</${name}>`
  }

  const inner = children
    .map(([k, v]) => valueToXml(k, v, depth + 1))
    .join("\n")
  return `${pad}<${name}${attrs}>\n${inner}\n${pad}</${name}>`
}

function valueToXmlDoc(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 1) {
      return `<?xml version="1.0" encoding="UTF-8"?>\n${valueToXml(entries[0][0], entries[0][1], 0)}`
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n${valueToXml("root", value, 0)}`
}

/** 把一段 XML 重新缩进，用于「格式化」 */
function prettyXml(text: string): string {
  const doc = new DOMParser().parseFromString(text, "application/xml")
  if (doc.querySelector("parsererror")) throw new Error("XML 解析失败，无法格式化")
  const raw = new XMLSerializer().serializeToString(doc)
  return raw.replace(/>\s*</g, ">\n<")
}

function parseInput(text: string, fmt: Fmt): unknown {
  if (fmt === "json") return JSON.parse(text)
  if (fmt === "yaml") return yamlLoad(text)
  return xmlToValue(text)
}

function serialize(value: unknown, fmt: Fmt, compact: boolean): string {
  if (fmt === "json") return JSON.stringify(value, null, compact ? 0 : 2)
  if (fmt === "yaml") return yamlDump(value, { indent: 2, lineWidth: 120 })
  return valueToXmlDoc(value)
}

export default function DataFormatTool() {
  const [from, setFrom] = React.useState<Fmt>("json")
  const [to, setTo] = React.useState<Fmt>("yaml")
  const [input, setInput] = React.useState('{\n  "name": "doulor",\n  "tags": ["cloud", "mail"],\n  "nested": { "a": 1, "b": true }\n}')
  const [output, setOutput] = React.useState("")
  const [compact, setCompact] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState(false)

  const run = React.useCallback(
    (src: string, fromFmt: Fmt, toFmt: Fmt, isCompact: boolean) => {
      if (!src.trim()) {
        setOutput("")
        setError(null)
        return
      }
      try {
        const value = parseInput(src, fromFmt)
        setOutput(serialize(value, toFmt, isCompact))
        setError(null)
      } catch (e) {
        setOutput("")
        setError(e instanceof Error ? e.message : "转换失败")
      }
    },
    []
  )

  React.useEffect(() => {
    run(input, from, to, compact)
  }, [input, from, to, compact, run])

  const copy = async () => {
    await copyText(output)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <ToolShell
      title="JSON / XML / YAML"
      description="三种结构化数据互转，也能单纯用来格式化或压缩。数据不离开你的浏览器。"
      wide
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-40 space-y-1.5">
          <Label className="text-xs text-muted-foreground">输入格式</Label>
          <Select
            value={from}
            onValueChange={(v) => {
              const f = v as Fmt
              setFrom(f)
              if (to === f) setTo(f === "json" ? "yaml" : "json")
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="json">JSON</SelectItem>
              <SelectItem value="yaml">YAML</SelectItem>
              <SelectItem value="xml">XML</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <ArrowRight className="mb-2.5 h-4 w-4 text-muted-foreground" />

        <div className="w-40 space-y-1.5">
          <Label className="text-xs text-muted-foreground">输出格式</Label>
          <Select value={to} onValueChange={(v) => setTo(v as Fmt)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="json">JSON</SelectItem>
              <SelectItem value="yaml">YAML</SelectItem>
              <SelectItem value="xml">XML</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {to === "json" && (
          <label className="mb-2 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={compact}
              onChange={(e) => setCompact(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            压缩成一行
          </label>
        )}

        <div className="mb-1.5 ml-auto flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              try {
                setOutput(prettyXml(input))
                setError(null)
              } catch (e) {
                setError(e instanceof Error ? e.message : "格式化失败")
              }
            }}
          >
            直接格式化原文
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!output}
            onClick={() => downloadBlob(new Blob([output], { type: "text/plain;charset=utf-8" }), `data.${EXT[to]}`)}
          >
            <Download className="h-4 w-4" />
            下载
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ToolSection title="输入">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={20}
            spellCheck={false}
            className="min-h-[420px] font-mono text-[13px]"
            placeholder="粘贴 JSON / YAML / XML…"
          />
        </ToolSection>

        <ToolSection
          title="输出"
          actions={
            <Button variant="ghost" size="sm" disabled={!output} onClick={() => void copy()}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? "已复制" : "复制"}
            </Button>
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
              rows={20}
              spellCheck={false}
              className="min-h-[420px] font-mono text-[13px]"
              placeholder="转换结果会出现在这里"
            />
          )}
        </ToolSection>
      </div>

      <p className="text-xs text-muted-foreground">
        提示：XML 转成 JSON 时，属性名会带上 <code className="font-mono">@</code> 前缀，
        纯文本节点放在 <code className="font-mono">#text</code> 里；再转回 XML 时会自动还原。
      </p>
    </ToolShell>
  )
}
