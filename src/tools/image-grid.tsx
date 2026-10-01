import * as React from "react"
import { Download, Package } from "lucide-react"

import { FileDrop } from "@/components/toolbox/file-drop"
import { ToolShell, ToolSection } from "@/components/toolbox/tool-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { baseName, canvasToBlob, createCanvas, downloadBlob, loadImageFile } from "@/lib/toolbox/utils"
import { blobToBytes, createZip, type ZipEntry } from "@/lib/toolbox/zip"
import { useT } from "@/i18n"

export default function ImageGridTool() {
  const { t } = useT()
  const [file, setFile] = React.useState<File | null>(null)
  const [srcUrl, setSrcUrl] = React.useState<string | null>(null)
  const [rows, setRows] = React.useState(3)
  const [cols, setCols] = React.useState(3)
  const [gap, setGap] = React.useState(0)
  const [format, setFormat] = React.useState<"png" | "jpeg">("png")
  const [tiles, setTiles] = React.useState<{ url: string; name: string; blob: Blob }[]>([])
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const imgRef = React.useRef<HTMLImageElement | null>(null)

  const handleFiles = async (files: File[]) => {
    const f = files[0]
    if (!f) return
    try {
      const img = await loadImageFile(f)
      imgRef.current = img
      setFile(f)
      setSrcUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return URL.createObjectURL(f)
      })
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : t("ig.err.open"))
    }
  }

  const generate = async () => {
    const img = imgRef.current
    if (!img) return
    setBusy(true)
    try {
      const tw = Math.floor(img.naturalWidth / cols)
      const th = Math.floor(img.naturalHeight / rows)
      if (tw < 1 || th < 1) throw new Error(t("ig.err.tooMany"))

      const next: { url: string; name: string; blob: Blob }[] = []
      const stem = baseName(file?.name ?? "image")
      const ext = format === "png" ? "png" : "jpg"
      const mime = format === "png" ? "image/png" : "image/jpeg"

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const { canvas, ctx } = createCanvas(tw, th)
          if (format === "jpeg") {
            ctx.fillStyle = "#ffffff"
            ctx.fillRect(0, 0, tw, th)
          }
          ctx.drawImage(img, c * tw, r * th, tw, th, 0, 0, tw, th)
          const blob = await canvasToBlob(canvas, mime, format === "jpeg" ? 0.92 : undefined)
          next.push({
            url: URL.createObjectURL(blob),
            name: `${stem}_${r + 1}-${c + 1}.${ext}`,
            blob,
          })
        }
      }
      setTiles((prev) => {
        prev.forEach((t) => URL.revokeObjectURL(t.url))
        return next
      })
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : t("ig.err.slice"))
    } finally {
      setBusy(false)
    }
  }

  const downloadZip = async () => {
    if (tiles.length === 0) return
    setBusy(true)
    try {
      const entries: ZipEntry[] = []
      for (const t of tiles) entries.push({ name: t.name, data: await blobToBytes(t.blob) })
      const zip = createZip(entries)
      downloadBlob(zip, `${baseName(file?.name ?? t("ig.fallbackName"))}${t("ig.zipSuffix")}.zip`)
    } finally {
      setBusy(false)
    }
  }

  // 换图或改行列数后，旧切片就不再对应了，先清掉避免误下载
  React.useEffect(() => {
    setTiles((prev) => {
      prev.forEach((t) => URL.revokeObjectURL(t.url))
      return []
    })
  }, [file, rows, cols, format])

  return (
    <ToolShell
      title={t("toolbox.imageGrid.name")}
      description={t("ig.desc")}
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <ToolSection title={t("ig.section.preview")}>
          {!srcUrl ? (
            <FileDrop accept="image/*" onFiles={(f) => void handleFiles(f)} />
          ) : (
            <div className="space-y-3">
              <div className="relative mx-auto w-full max-w-[420px] overflow-hidden rounded-lg border">
                <img src={srcUrl} alt={t("ig.alt.original")} className="block w-full" />
                <div
                  className="pointer-events-none absolute inset-0"
                  style={{
                    display: "grid",
                    gridTemplateColumns: `repeat(${cols}, 1fr)`,
                    gridTemplateRows: `repeat(${rows}, 1fr)`,
                  }}
                >
                  {Array.from({ length: rows * cols }).map((_, i) => (
                    <div key={i} className="border border-white/50" />
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="truncate font-medium">{file?.name}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setFile(null)
                    setSrcUrl(null)
                    imgRef.current = null
                  }}
                >
                  {t("ig.replace")}
                </Button>
              </div>
            </div>
          )}

          {tiles.length > 0 && (
            <div className="mt-4 space-y-2 border-t pt-4">
              <p className="text-xs text-muted-foreground">
                {t("ig.tilesCount", { n: tiles.length })}
              </p>
              <div
                className="grid gap-1.5"
                style={{ gridTemplateColumns: `repeat(${Math.min(cols, 6)}, minmax(0, 1fr))` }}
              >
                {tiles.map((t) => (
                  <button
                    key={t.name}
                    type="button"
                    title={t.name}
                    onClick={() => downloadBlob(t.blob, t.name)}
                    className="overflow-hidden rounded border transition-opacity hover:opacity-80"
                  >
                    <img src={t.url} alt={t.name} className="block w-full" />
                  </button>
                ))}
              </div>
            </div>
          )}
        </ToolSection>

        <ToolSection title={t("ig.section.settings")}>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t("ig.rows")}</Label>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={rows}
                  onChange={(e) => setRows(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t("ig.cols")}</Label>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={cols}
                  onChange={(e) => setCols(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {[
                { label: "3 × 3", r: 3, c: 3 },
                { label: "2 × 2", r: 2, c: 2 },
                { label: t("ig.preset.1x3"), r: 1, c: 3 },
                { label: t("ig.preset.3x1"), r: 3, c: 1 },
                { label: "2 × 3", r: 2, c: 3 },
              ].map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => {
                    setRows(p.r)
                    setCols(p.c)
                  }}
                  className={
                    "rounded-md border px-2.5 py-1 text-xs transition-colors " +
                    (rows === p.r && cols === p.c
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border text-muted-foreground hover:border-primary/50")
                  }
                >
                  {p.label}
                </button>
              ))}
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t("ig.gap", { n: gap })}</Label>
              <input
                type="range"
                min={0}
                max={20}
                value={gap}
                onChange={(e) => setGap(Number(e.target.value))}
                className="w-full accent-primary"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t("ig.outFormat")}</Label>
              <Select value={format} onValueChange={(v) => setFormat(v as "png" | "jpeg")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="png">{t("ig.fmt.png")}</SelectItem>
                  <SelectItem value="jpeg">{t("ig.fmt.jpeg")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <p className="text-xs text-muted-foreground">
              {t("ig.note")}
            </p>

            {error && <p className="text-xs text-destructive">{error}</p>}

            <Button className="w-full" disabled={!srcUrl || busy} onClick={() => void generate()}>
              {busy ? t("ig.slicing") : t("ig.start")}
            </Button>
            <Button
              variant="outline"
              className="w-full"
              disabled={tiles.length === 0 || busy}
              onClick={() => void downloadZip()}
            >
              <Package className="h-4 w-4" />
              {t("ig.zipAll", { n: tiles.length })}
            </Button>
            {tiles.length === 1 && (
              <Button
                variant="ghost"
                className="w-full"
                onClick={() => downloadBlob(tiles[0].blob, tiles[0].name)}
              >
                <Download className="h-4 w-4" />
                {t("ig.downloadOne")}
              </Button>
            )}
          </div>
        </ToolSection>
      </div>
    </ToolShell>
  )
}
