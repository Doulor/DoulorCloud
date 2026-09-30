import * as React from "react"
import { Check, Copy, Download } from "lucide-react"
import * as XLSX from "xlsx"

import { FileDrop } from "@/components/toolbox/file-drop"
import { ToolShell, ToolSection } from "@/components/toolbox/tool-shell"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { copyText, downloadBlob } from "@/lib/toolbox/utils"

/** 标准 CSV 解析：处理引号包裹、字段内换行、双引号转义 */
function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
      continue
    }
    if (c === '"') inQuotes = true
    else if (c === delimiter) {
      row.push(field)
      field = ""
    } else if (c === "\n") {
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else if (c !== "\r") {
      field += c
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""))
}

function detectDelimiter(text: string): string {
  const line = text.split(/\r?\n/)[0] ?? ""
  const counts: [string, number][] = [
    [",", (line.match(/,/g) ?? []).length],
    ["\t", (line.match(/\t/g) ?? []).length],
    [";", (line.match(/;/g) ?? []).length],
    ["|", (line.match(/\|/g) ?? []).length],
  ]
  counts.sort((a, b) => b[1] - a[1])
  return counts[0][1] > 0 ? counts[0][0] : ","
}

function toCsvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export default function CsvJsonTool() {
  return (
    <ToolShell
      title="表格转 JSON"
      description="CSV / Excel 转成 JSON 给程序用，或者把 JSON 数组导出成 CSV 用表格打开。"
      wide
    >
      <Tabs defaultValue="to-json">
        <TabsList>
          <TabsTrigger value="to-json">表格 → JSON</TabsTrigger>
          <TabsTrigger value="to-csv">JSON → 表格</TabsTrigger>
        </TabsList>
        <TabsContent value="to-json" className="mt-4">
          <TableToJson />
        </TabsContent>
        <TabsContent value="to-csv" className="mt-4">
          <JsonToTable />
        </TabsContent>
      </Tabs>
    </ToolShell>
  )
}

function TableToJson() {
  const [source, setSource] = React.useState("")
  const [rows, setRows] = React.useState<string[][]>([])
  const [header, setHeader] = React.useState(true)
  const [compact, setCompact] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState(false)

  const loadText = (text: string) => {
    try {
      const d = detectDelimiter(text)
      const parsed = parseCsv(text, d)
      setRows(parsed)
      setError(parsed.length === 0 ? "没有解析到数据" : null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "解析失败")
      setRows([])
    }
  }

  const loadExcel = async (file: File) => {
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: "array" })
      const first = wb.SheetNames[0]
      if (!first) throw new Error("工作簿里没有工作表")
      const sheet = wb.Sheets[first]
      const data = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "" })
      setRows(data.filter((r) => r.some((c) => String(c ?? "").trim() !== "")))
      setSource(`（来自 ${file.name} · 工作表 ${first}）`)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Excel 读取失败")
      setRows([])
    }
  }

  const json = React.useMemo(() => {
    if (rows.length === 0) return ""
    if (!header) return JSON.stringify(rows, null, compact ? 0 : 2)
    const keys = rows[0]
    const body = rows.slice(1).map((r) => {
      const obj: Record<string, string> = {}
      keys.forEach((k, i) => {
        obj[k || `列${i + 1}`] = r[i] ?? ""
      })
      return obj
    })
    return JSON.stringify(body, null, compact ? 0 : 2)
  }, [rows, header, compact])

  const copy = async () => {
    await copyText(json)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ToolSection title="数据源">
        <div className="space-y-3">
          <FileDrop
            accept=".csv,.tsv,.txt,.xlsx,.xls"
            onFiles={(files) => {
              const f = files[0]
              if (!f) return
              if (/\.(xlsx|xls)$/i.test(f.name)) void loadExcel(f)
              else void f.text().then((t) => { setSource(`（来自 ${f.name}）`); loadText(t) })
            }}
            label="选择 CSV / TSV / Excel 文件"
            hint="也可以直接在下面粘贴 CSV 文本"
            className="py-5"
          />

          <Textarea
            value={source.startsWith("（来自") ? "" : source}
            onChange={(e) => {
              setSource(e.target.value)
              loadText(e.target.value)
            }}
            rows={10}
            spellCheck={false}
            className="min-h-[220px] font-mono text-[12.5px]"
            placeholder={"name,age,city\n张三,28,杭州\n李四,35,成都"}
          />
          {source.startsWith("（来自") && (
            <p className="text-xs text-muted-foreground">{source}</p>
          )}

          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={header}
                onChange={(e) => setHeader(e.target.checked)}
                className="h-4 w-4 accent-primary"
              />
              第一行是表头
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={compact}
                onChange={(e) => setCompact(e.target.checked)}
                className="h-4 w-4 accent-primary"
              />
              压缩成一行
            </label>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      </ToolSection>

      <ToolSection
        title={`JSON 结果${rows.length > 0 ? `（${header ? rows.length - 1 : rows.length} 条）` : ""}`}
        actions={
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" disabled={!json} onClick={() => void copy()}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? "已复制" : "复制"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!json}
              onClick={() => downloadBlob(new Blob([json], { type: "application/json" }), "data.json")}
            >
              <Download className="h-4 w-4" />
              下载
            </Button>
          </div>
        }
      >
        <Textarea
          value={json}
          readOnly
          rows={22}
          spellCheck={false}
          className="min-h-[420px] font-mono text-[12.5px]"
          placeholder="转换结果会出现在这里"
        />
      </ToolSection>
    </div>
  )
}

function JsonToTable() {
  const [text, setText] = React.useState('[\n  { "name": "张三", "age": 28 },\n  { "name": "李四", "age": 35 }\n]')
  const [error, setError] = React.useState<string | null>(null)

  const csv = React.useMemo(() => {
    if (!text.trim()) {
      setError(null)
      return ""
    }
    try {
      const parsed = JSON.parse(text)
      const list: unknown[] = Array.isArray(parsed) ? parsed : [parsed]
      if (list.length === 0) throw new Error("数组是空的")
      if (typeof list[0] !== "object" || list[0] === null) {
        throw new Error("需要是对象数组，例如 [{ \"a\": 1 }]")
      }
      const keys: string[] = []
      for (const item of list) {
        if (item && typeof item === "object") {
          for (const k of Object.keys(item as Record<string, unknown>)) {
            if (!keys.includes(k)) keys.push(k)
          }
        }
      }
      const lines = [keys.map(toCsvCell).join(",")]
      for (const item of list) {
        const obj = (item ?? {}) as Record<string, unknown>
        lines.push(keys.map((k) => toCsvCell(obj[k])).join(","))
      }
      setError(null)
      // 加 BOM，Excel 打开中文才不乱码
      return "\ufeff" + lines.join("\r\n")
    } catch (e) {
      setError(e instanceof Error ? e.message : "JSON 解析失败")
      return ""
    }
  }, [text])

  const [copied, setCopied] = React.useState(false)

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ToolSection title="JSON 输入">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={20}
          spellCheck={false}
          className="min-h-[420px] font-mono text-[12.5px]"
          placeholder='[{ "name": "张三", "age": 28 }]'
        />
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      </ToolSection>

      <ToolSection
        title="CSV 结果"
        actions={
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={!csv}
              onClick={async () => {
                await copyText(csv)
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1200)
              }}
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? "已复制" : "复制"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!csv}
              onClick={() =>
                downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), "data.csv")
              }
            >
              <Download className="h-4 w-4" />
              下载 CSV
            </Button>
          </div>
        }
      >
        <Textarea
          value={csv}
          readOnly
          rows={20}
          spellCheck={false}
          className="min-h-[420px] font-mono text-[12.5px]"
          placeholder="CSV 会出现在这里"
        />
        <Label className="mt-2 block text-xs text-muted-foreground">
          已带 UTF-8 BOM，用 Excel 直接打开中文不会乱码
        </Label>
      </ToolSection>
    </div>
  )
}
