import * as React from "react"
import { ArrowDown, ArrowUp, Download, Package, X } from "lucide-react"
import { PDFDocument } from "pdf-lib"
import * as pdfjsLib from "pdfjs-dist"
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url"

import { FileDrop } from "@/components/toolbox/file-drop"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  canvasToBlob,
  createCanvas,
  downloadBlob,
  loadImageFile,
} from "@/lib/toolbox/utils"
import { blobToBytes, createZip, type ZipEntry } from "@/lib/toolbox/zip"
import { useT } from "@/i18n"

// pdf.js 需要一个独立的 worker 文件；交给 Vite 打包成同源资源，避免依赖外部 CDN
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

export default function ImagePdfTool() {
  const { t } = useT()
  return (
    <ToolShell
      title={t("toolbox.imagePdf.name")}
      description={t("ip.desc")}
    >
      <Tabs defaultValue="to-pdf">
        <TabsList>
          <TabsTrigger value="to-pdf">{t("ip.tab.toPdf")}</TabsTrigger>
          <TabsTrigger value="to-image">{t("ip.tab.toImage")}</TabsTrigger>
        </TabsList>
        <TabsContent value="to-pdf" className="mt-4">
          <ImagesToPdf />
        </TabsContent>
        <TabsContent value="to-image" className="mt-4">
          <PdfToImages />
        </TabsContent>
      </Tabs>
    </ToolShell>
  )
}

interface Pic {
  id: string
  name: string
  url: string
  img: HTMLImageElement
}

const PAGE_PRESETS = {
  auto: null,
  a4: [595.28, 841.89] as const,
  a4l: [841.89, 595.28] as const,
  a5: [419.53, 595.28] as const,
  letter: [612, 792] as const,
}

function ImagesToPdf() {
  const { t } = useT()
  const [items, setItems] = React.useState<Pic[]>([])
  const [pageSize, setPageSize] = React.useState<keyof typeof PAGE_PRESETS>("auto")
  const [margin, setMargin] = React.useState(18)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const add = async (files: File[]) => {
    try {
      const loaded: Pic[] = []
      for (const f of files) {
        const img = await loadImageFile(f)
        loaded.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: f.name,
          url: URL.createObjectURL(f),
          img,
        })
      }
      setItems((prev) => [...prev, ...loaded])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : t("ip.err.openImage"))
    }
  }

  const remove = (id: string) =>
    setItems((prev) => {
      const t = prev.find((x) => x.id === id)
      if (t) URL.revokeObjectURL(t.url)
      return prev.filter((x) => x.id !== id)
    })

  const move = (i: number, d: number) =>
    setItems((prev) => {
      const next = [...prev]
      const j = i + d
      if (j < 0 || j >= next.length) return prev
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })

  const build = async () => {
    if (items.length === 0) return
    setBusy(true)
    try {
      const pdf = await PDFDocument.create()
      const preset = PAGE_PRESETS[pageSize]

      for (const it of items) {
        // 统一走一次画布：既解决 WebP 等 pdf-lib 不认的格式，也顺手把透明底压白
        const { canvas, ctx } = createCanvas(it.img.naturalWidth, it.img.naturalHeight)
        ctx.fillStyle = "#ffffff"
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(it.img, 0, 0)
        const blob = await canvasToBlob(canvas, "image/jpeg", 0.92)
        const bytes = await blobToBytes(blob)
        const embedded = await pdf.embedJpg(bytes)

        let pw: number
        let ph: number
        if (preset) {
          pw = preset[0]
          ph = preset[1]
        } else {
          pw = it.img.naturalWidth
          ph = it.img.naturalHeight
        }

        const page = pdf.addPage([pw, ph])
        const availW = Math.max(1, pw - margin * 2)
        const availH = Math.max(1, ph - margin * 2)
        const scale = Math.min(availW / embedded.width, availH / embedded.height)
        const dw = embedded.width * scale
        const dh = embedded.height * scale
        page.drawImage(embedded, {
          x: (pw - dw) / 2,
          y: (ph - dh) / 2,
          width: dw,
          height: dh,
        })
      }

      const bytes = await pdf.save()
      const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" })
      downloadBlob(blob, t("ip.file.merged", { ts: Date.now() }))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : t("ip.err.makePdf"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <ToolSection title={t("ip.listTitle", { n: items.length })}>
        <FileDrop
          accept="image/*"
          multiple
          onFiles={(f) => void add(f)}
          label={t("ip.pickLabel")}
          hint={t("ip.pickHint")}
          className="py-6"
        />
        {items.length > 0 && (
          <ul className="mt-4 space-y-2">
            {items.map((it, i) => (
              <li key={it.id} className="flex items-center gap-3 rounded-lg border p-2">
                <span className="w-6 shrink-0 text-center text-xs text-muted-foreground">
                  {i + 1}
                </span>
                <img src={it.url} alt={it.name} className="h-12 w-12 shrink-0 rounded object-cover" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{it.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {it.img.naturalWidth} × {it.img.naturalHeight}
                  </p>
                </div>
                <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t("ip.moveUp")} disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t("ip.moveDown")} disabled={i === items.length - 1} onClick={() => move(i, 1)}>
                  <ArrowDown className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" aria-label={t("common.delete")} onClick={() => remove(it.id)}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </ToolSection>

      <ToolSection title={t("ip.pdfSettings")}>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t("ip.paper")}</Label>
            <Select value={pageSize} onValueChange={(v) => setPageSize(v as keyof typeof PAGE_PRESETS)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t("ip.paper.auto")}</SelectItem>
                <SelectItem value="a4">{t("ip.paper.a4")}</SelectItem>
                <SelectItem value="a4l">{t("ip.paper.a4l")}</SelectItem>
                <SelectItem value="a5">{t("ip.paper.a5")}</SelectItem>
                <SelectItem value="letter">Letter</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t("ip.margin", { n: margin })}</Label>
            <input
              type="range"
              min={0}
              max={80}
              value={margin}
              onChange={(e) => setMargin(Number(e.target.value))}
              className="w-full accent-primary"
            />
          </div>

          <p className="text-xs text-muted-foreground">
            {t("ip.fitHint")}
          </p>
          {error && <p className="text-xs text-destructive">{error}</p>}

          <Button className="w-full" disabled={items.length === 0 || busy} onClick={() => void build()}>
            <Download className="h-4 w-4" />
            {busy ? t("ip.generating") : t("ip.generate")}
          </Button>
        </div>
      </ToolSection>
    </div>
  )
}

function PdfToImages() {
  const { t } = useT()
  const [file, setFile] = React.useState<File | null>(null)
  const [dpi, setDpi] = React.useState(150)
  const [format, setFormat] = React.useState<"png" | "jpeg">("png")
  const [pages, setPages] = React.useState<{ url: string; name: string; blob: Blob }[]>([])
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const clear = () => {
    setPages((prev) => {
      prev.forEach((p) => URL.revokeObjectURL(p.url))
      return []
    })
  }

  const run = async (f: File) => {
    setBusy(true)
    clear()
    setError(null)
    try {
      const buf = await f.arrayBuffer()
      const doc = await pdfjsLib.getDocument({ data: buf }).promise
      const scale = dpi / 72
      const out: { url: string; name: string; blob: Blob }[] = []
      const stem = f.name.replace(/\.pdf$/i, "")

      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i)
        const viewport = page.getViewport({ scale })
        const { canvas, ctx } = createCanvas(viewport.width, viewport.height)
        if (format === "jpeg") {
          ctx.fillStyle = "#ffffff"
          ctx.fillRect(0, 0, canvas.width, canvas.height)
        }
        await page.render({ canvas, canvasContext: ctx, viewport }).promise
        const blob = await canvasToBlob(
          canvas,
          format === "png" ? "image/png" : "image/jpeg",
          format === "jpeg" ? 0.92 : undefined
        )
        out.push({
          url: URL.createObjectURL(blob),
          name: `${stem}_${t("ip.pageNo", { n: i })}.${format === "png" ? "png" : "jpg"}`,
          blob,
        })
      }
      setPages(out)
      await (doc as unknown as { destroy: () => Promise<void> }).destroy()
    } catch (e) {
      setError(e instanceof Error ? e.message : t("ip.err.parse"))
    } finally {
      setBusy(false)
    }
  }

  const downloadZip = async () => {
    if (pages.length === 0) return
    setBusy(true)
    try {
      const entries: ZipEntry[] = []
      for (const p of pages) entries.push({ name: p.name, data: await blobToBytes(p.blob) })
      downloadBlob(createZip(entries), t("ip.file.zipName", { ts: Date.now() }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <ToolSection title={t("ip.pdfFile")}>
        {!file ? (
          <FileDrop
            accept="application/pdf,.pdf"
            onFiles={(f) => {
              const p = f[0]
              if (!p) return
              setFile(p)
              void run(p)
            }}
          />
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="truncate font-medium">{file.name}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setFile(null)
                  clear()
                }}
              >
                {t("ip.replace")}
              </Button>
            </div>
            {pages.length > 0 && (
              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {pages.map((p) => (
                  <button
                    key={p.name}
                    type="button"
                    title={t("ip.clickDownload", { name: p.name })}
                    onClick={() => downloadBlob(p.blob, p.name)}
                    className="overflow-hidden rounded-lg border transition-opacity hover:opacity-80"
                  >
                    <img src={p.url} alt={p.name} className="block w-full" />
                    <span className="block truncate px-2 py-1 text-[11px] text-muted-foreground">
                      {p.name}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </ToolSection>

      <ToolSection title={t("ip.exportSettings")}>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t("ip.dpi")}</Label>
            <Select value={String(dpi)} onValueChange={(v) => setDpi(Number(v))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="72">{t("ip.dpi.72")}</SelectItem>
                <SelectItem value="150">{t("ip.dpi.150")}</SelectItem>
                <SelectItem value="200">{t("ip.dpi.200")}</SelectItem>
                <SelectItem value="300">{t("ip.dpi.300")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t("ip.outFormat")}</Label>
            <Select value={format} onValueChange={(v) => setFormat(v as "png" | "jpeg")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="png">{t("ip.fmt.png")}</SelectItem>
                <SelectItem value="jpeg">{t("ip.fmt.jpeg")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <p className="text-xs text-muted-foreground">
            {t("ip.reconvertHint")}
          </p>
          {error && <p className="text-xs text-destructive">{error}</p>}

          <Button
            variant="outline"
            className="w-full"
            disabled={!file || busy}
            onClick={() => file && void run(file)}
          >
            {busy ? t("ip.converting") : t("ip.convert")}
          </Button>
          <Button
            className="w-full"
            disabled={pages.length === 0 || busy}
            onClick={() => void downloadZip()}
          >
            <Package className="h-4 w-4" />
            {t("ip.zipAll", { n: pages.length })}
          </Button>
          {pages.length === 1 && (
            <Button
              variant="ghost"
              className="w-full"
              onClick={() => downloadBlob(pages[0].blob, pages[0].name)}
            >
              <Download className="h-4 w-4" />
              {t("ip.downloadOne")}
            </Button>
          )}
        </div>
      </ToolSection>
    </div>
  )
}
