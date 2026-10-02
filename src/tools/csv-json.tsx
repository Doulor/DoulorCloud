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
import { useT } from "@/i18n"

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
  const { t } = useT()
  return (
    <ToolShell
      title={t("toolbox.csvJson.name")}
      description={t("cj.desc")}
      wide
    >
      <Tabs defaultValue="to-json">
        <TabsList>
          <TabsTrigger value="to-json">{t("cj.tab.toJson")}</TabsTrigger>
          <TabsTrigger value="to-csv">{t("cj.tab.toCsv")}</TabsTrigger>
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
  const { t } = useT()
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
      setError(parsed.length === 0 ? t("cj.err.noRows") : null)
    } catch (e) {
      setError(e instanceof Error ? e.message : t("cj.err.parse"))
      setRows([])
    }
  }

  const loadExcel = async (file: File) => {
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: "array" })
      const first = wb.SheetNames[0]
      if (!first) throw new Error(t("cj.err.noSheet"))
      const sheet = wb.Sheets[first]
      const data = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "" })
      setRows(data.filter((r) => r.some((c) => String(c ?? "").trim() !== "")))
      setSource(t("cj.sourceWithSheet", { name: file.name, sheet: first }))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : t("cj.err.excel"))
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
        obj[k || t("cj.colFallback", { n: i + 1 })] = r[i] ?? ""
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
      <ToolSection title={t("cj.section.source")}>
        <div className="space-y-3">
          <FileDrop
            accept=".csv,.tsv,.txt,.xlsx,.xls"
            onFiles={(files) => {
              const f = files[0]
              if (!f) return
              if (/\.(xlsx|xls)$/i.test(f.name)) void loadExcel(f)
              else void f.text().then((text) => { setSource(t("cj.source", { name: f.name })); loadText(text) })
            }}
            label={t("cj.pickFile")}
            hint={t("cj.pickHint")}
            className="py-5"
          />

          <Textarea
            value={source.startsWith(t("cj.sourcePrefix")) ? "" : source}
            onChange={(e) => {
              setSource(e.target.value)
              loadText(e.target.value)
            }}
            rows={10}
            spellCheck={false}
            className="min-h-[220px] font-mono text-[12.5px]"
            placeholder={t("cj.csvPlaceholder")}
          />
          {source.startsWith(t("cj.sourcePrefix")) && (
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
              {t("cj.firstRowHeader")}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={compact}
                onChange={(e) => setCompact(e.target.checked)}
                className="h-4 w-4 accent-primary"
              />
              {t("cj.minify")}
            </label>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      </ToolSection>

      <ToolSection
        title={t("cj.resultTitle", { n: rows.length })}
        actions={
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" disabled={!json} onClick={() => void copy()}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? t("common.copied") : t("common.copy")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!json}
              onClick={() => downloadBlob(new Blob([json], { type: "application/json" }), "data.json")}
            >
              <Download className="h-4 w-4" />
              {t("cj.download")}
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
          placeholder={t("cj.resultPlaceholder")}
        />
      </ToolSection>
    </div>
  )
}

function JsonToTable() {
  const { t } = useT()
  const [text, setText] = React.useState(t("cj.jsonSample"))
  const [error, setError] = React.useState<string | null>(null)

  const csv = React.useMemo(() => {
    if (!text.trim()) {
      setError(null)
      return ""
    }
    try {
      const parsed = JSON.parse(text)
      const list: unknown[] = Array.isArray(parsed) ? parsed : [parsed]
      if (list.length === 0) throw new Error(t("cj.err.emptyArray"))
      if (typeof list[0] !== "object" || list[0] === null) {
        throw new Error(t("cj.err.objectArray"))
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
      setError(e instanceof Error ? e.message : t("cj.err.json"))
      return ""
    }
  }, [text])

  const [copied, setCopied] = React.useState(false)

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ToolSection title={t("cj.section.jsonInput")}>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={20}
          spellCheck={false}
          className="min-h-[420px] font-mono text-[12.5px]"
          placeholder={t("cj.jsonPlaceholder")}
        />
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      </ToolSection>

      <ToolSection
        title={t("cj.csvResult")}
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
              {copied ? t("common.copied") : t("common.copy")}
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
              {t("cj.downloadCsv")}
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
          placeholder={t("cj.csvPlaceholderOut")}
        />
        <Label className="mt-2 block text-xs text-muted-foreground">
          {t("cj.bomNote")}
        </Label>
      </ToolSection>
    </div>
  )
}
