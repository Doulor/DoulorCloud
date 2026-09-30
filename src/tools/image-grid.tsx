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

export default function ImageGridTool() {
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
      setError(e instanceof Error ? e.message : "图片打开失败")
    }
  }

  const generate = async () => {
    const img = imgRef.current
    if (!img) return
    setBusy(true)
    try {
      const tw = Math.floor(img.naturalWidth / cols)
      const th = Math.floor(img.naturalHeight / rows)
      if (tw < 1 || th < 1) throw new Error("格子太多，单格尺寸不足 1 像素")

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
      setError(e instanceof Error ? e.message : "切图失败")
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
      downloadBlob(zip, `${baseName(file?.name ?? "image")}_切图.zip`)
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
      title="九宫格切图"
      description="把一张图切成 N × N 小图，发朋友圈、小红书时按顺序发出去就是完整一张。"
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <ToolSection title="原图与切分预览">
          {!srcUrl ? (
            <FileDrop accept="image/*" onFiles={(f) => void handleFiles(f)} />
          ) : (
            <div className="space-y-3">
              <div className="relative mx-auto w-full max-w-[420px] overflow-hidden rounded-lg border">
                <img src={srcUrl} alt="原图" className="block w-full" />
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
                  换一张
                </Button>
              </div>
            </div>
          )}

          {tiles.length > 0 && (
            <div className="mt-4 space-y-2 border-t pt-4">
              <p className="text-xs text-muted-foreground">
                切好的 {tiles.length} 张（点单张可单独下载）
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

        <ToolSection title="切分设置">
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">行数</Label>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={rows}
                  onChange={(e) => setRows(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">列数</Label>
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
                { label: "1 × 3 长条", r: 1, c: 3 },
                { label: "3 × 1 长条", r: 3, c: 1 },
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
              <Label className="text-xs text-muted-foreground">格子间隔 {gap}px（仅预览提示）</Label>
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
              <Label className="text-xs text-muted-foreground">输出格式</Label>
              <Select value={format} onValueChange={(v) => setFormat(v as "png" | "jpeg")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="png">PNG · 无损</SelectItem>
                  <SelectItem value="jpeg">JPG · 体积小</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <p className="text-xs text-muted-foreground">
              原图会按整行整列切分，除不尽的边缘像素会被舍弃，所以先把图片裁成合适的比例效果最好。
            </p>

            {error && <p className="text-xs text-destructive">{error}</p>}

            <Button className="w-full" disabled={!srcUrl || busy} onClick={() => void generate()}>
              {busy ? "切分中…" : "开始切分"}
            </Button>
            <Button
              variant="outline"
              className="w-full"
              disabled={tiles.length === 0 || busy}
              onClick={() => void downloadZip()}
            >
              <Package className="h-4 w-4" />
              打包下载 ZIP（{tiles.length} 张）
            </Button>
            {tiles.length === 1 && (
              <Button
                variant="ghost"
                className="w-full"
                onClick={() => downloadBlob(tiles[0].blob, tiles[0].name)}
              >
                <Download className="h-4 w-4" />
                下载单张
              </Button>
            )}
          </div>
        </ToolSection>
      </div>
    </ToolShell>
  )
}
