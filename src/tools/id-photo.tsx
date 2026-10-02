import * as React from "react"
import { Download } from "lucide-react"

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
import { baseName, canvasToBlob, createCanvas, downloadBlob, loadImageFile } from "@/lib/toolbox/utils"
import { useT } from "@/i18n"

interface Preset {
  id: string
  label: string
  w: number
  h: number
}

/** 300 DPI 下的像素尺寸，按 mm 换算：px = mm / 25.4 × 300 */
const PRESETS: Preset[] = [
  { id: "1cun", label: "ipho.preset.1cun", w: 295, h: 413 },
  { id: "x1cun", label: "ipho.preset.x1cun", w: 260, h: 378 },
  { id: "d1cun", label: "ipho.preset.d1cun", w: 390, h: 567 },
  { id: "2cun", label: "ipho.preset.2cun", w: 413, h: 579 },
  { id: "x2cun", label: "ipho.preset.x2cun", w: 413, h: 531 },
  { id: "passport", label: "ipho.preset.passport", w: 390, h: 567 },
  { id: "visa-us", label: "ipho.preset.visaUs", w: 602, h: 602 },
  { id: "idcard", label: "ipho.preset.idcard", w: 307, h: 378 },
]

const BG_COLORS = [
  { id: "none", label: "ipho.bg.none", hex: "" },
  { id: "white", label: "ipho.bg.white", hex: "#ffffff" },
  { id: "blue", label: "ipho.bg.blue", hex: "#2e6bd6" },
  { id: "red", label: "ipho.bg.red", hex: "#d0342c" },
  { id: "gray", label: "ipho.bg.gray", hex: "#e8e8e8" },
]

/** 从四角采样，估算原背景色 */
function sampleBackground(data: Uint8ClampedArray, w: number, h: number) {
  const pts: [number, number][] = []
  const k = Math.max(2, Math.min(8, Math.floor(Math.min(w, h) / 20)))
  for (let i = 0; i < k; i++) {
    pts.push([i, i], [w - 1 - i, i], [i, h - 1 - i], [w - 1 - i, h - 1 - i])
  }
  let r = 0
  let g = 0
  let b = 0
  for (const [x, y] of pts) {
    const i = (y * w + x) * 4
    r += data[i]
    g += data[i + 1]
    b += data[i + 2]
  }
  const n = pts.length
  return [r / n, g / n, b / n] as const
}

/**
 * 从图片四周向内做泛洪填充，把与原背景色接近的连通区域换成目标色。
 * 用连通性而不是「全局替换同色像素」，可以避免误伤衣服上与背景相近的颜色。
 */
function replaceBackground(img: ImageData, hex: string, tolerance: number) {
  const { data, width, height } = img
  const target = hexToRgb(hex)
  const ref = sampleBackground(data, width, height)
  const maxDist = (tolerance / 100) * 260

  const visited = new Uint8Array(width * height)
  const queue = new Int32Array(width * height)
  let head = 0
  let tail = 0

  const tryPush = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const idx = y * width + x
    if (visited[idx]) return
    const i = idx * 4
    const dr = data[i] - ref[0]
    const dg = data[i + 1] - ref[1]
    const db = data[i + 2] - ref[2]
    if (Math.sqrt(dr * dr + dg * dg + db * db) > maxDist) return
    visited[idx] = 1
    queue[tail++] = idx
  }

  for (let x = 0; x < width; x++) {
    tryPush(x, 0)
    tryPush(x, height - 1)
  }
  for (let y = 0; y < height; y++) {
    tryPush(0, y)
    tryPush(width - 1, y)
  }

  while (head < tail) {
    const idx = queue[head++]
    const i = idx * 4
    data[i] = target[0]
    data[i + 1] = target[1]
    data[i + 2] = target[2]
    data[i + 3] = 255
    const x = idx % width
    const y = (idx - x) / width
    tryPush(x + 1, y)
    tryPush(x - 1, y)
    tryPush(x, y + 1)
    tryPush(x, y - 1)
  }

  return img
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [255, 255, 255]
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export default function IdPhotoTool() {
  const { t } = useT()
  const [fileName, setFileName] = React.useState("")
  const [presetId, setPresetId] = React.useState("1cun")
  const [bgId, setBgId] = React.useState("white")
  const [tolerance, setTolerance] = React.useState(28)
  const [offsetY, setOffsetY] = React.useState(0)
  const [zoom, setZoom] = React.useState(100)
  const [format, setFormat] = React.useState<"png" | "jpeg">("jpeg")
  const [preview, setPreview] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const imgRef = React.useRef<HTMLImageElement | null>(null)
  const outRef = React.useRef<HTMLCanvasElement | null>(null)

  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0]
  const bg = BG_COLORS.find((b) => b.id === bgId) ?? BG_COLORS[0]

  const handleFiles = async (files: File[]) => {
    const f = files[0]
    if (!f) return
    try {
      imgRef.current = await loadImageFile(f)
      setFileName(f.name)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : t("ipho.err.open"))
    }
  }

  const render = React.useCallback(() => {
    const img = imgRef.current
    if (!img) return null
    const { canvas, ctx } = createCanvas(preset.w, preset.h)
    const scale = (zoom / 100) * Math.max(preset.w / img.naturalWidth, preset.h / img.naturalHeight)
    const dw = img.naturalWidth * scale
    const dh = img.naturalHeight * scale
    const dx = (preset.w - dw) / 2
    const dy = (preset.h - dh) / 2 + (offsetY / 100) * (dh - preset.h) * 0.5
    ctx.fillStyle = bg.hex || "#ffffff"
    ctx.fillRect(0, 0, preset.w, preset.h)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = "high"
    ctx.drawImage(img, dx, dy, dw, dh)

    if (bg.hex) {
      const data = ctx.getImageData(0, 0, preset.w, preset.h)
      replaceBackground(data, bg.hex, tolerance)
      ctx.putImageData(data, 0, 0)
    }
    return canvas
  }, [preset, bg, tolerance, offsetY, zoom])

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      const canvas = render()
      outRef.current = canvas
      if (!canvas) {
        setPreview(null)
        return
      }
      setPreview(canvas.toDataURL("image/png"))
    }, 160)
    return () => window.clearTimeout(timer)
  }, [render, fileName])

  const download = async () => {
    const canvas = outRef.current ?? render()
    if (!canvas) return
    setBusy(true)
    try {
      const blob = await canvasToBlob(
        canvas,
        format === "png" ? "image/png" : "image/jpeg",
        format === "jpeg" ? 0.95 : undefined
      )
      downloadBlob(
        blob,
        `${baseName(fileName || "photo")}-${preset.w}x${preset.h}.${format === "png" ? "png" : "jpg"}`
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : t("ipho.err.export"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ToolShell
      title={t("toolbox.idPhoto.name")}
      description={t("ipho.desc")}
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <ToolSection title={t("ipho.section.preview")}>
          {!preview ? (
            <FileDrop
              accept="image/*"
              onFiles={(f) => void handleFiles(f)}
              hint={t("ipho.pickHint")}
            />
          ) : (
            <div className="space-y-3">
              <div className="flex justify-center">
                <img
                  src={preview}
                  alt={t("ipho.alt.preview")}
                  className="h-auto rounded border shadow-sm"
                  style={{ width: Math.min(320, preset.w * 1.1) }}
                />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="truncate font-medium">{fileName}</span>
                <span className="text-xs text-muted-foreground">
                  {t("ipho.pixels", { w: preset.w, h: preset.h })}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setPreview(null)
                    imgRef.current = null
                  }}
                >
                  {t("ipho.replace")}
                </Button>
              </div>
            </div>
          )}
        </ToolSection>

        <ToolSection title={t("ipho.section.params")}>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t("ipho.size")}</Label>
              <Select value={presetId} onValueChange={setPresetId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRESETS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t("ipho.bgColor")}</Label>
              <div className="flex flex-wrap gap-2">
                {BG_COLORS.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => setBgId(b.id)}
                    className={
                      "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors " +
                      (bgId === b.id
                        ? "border-primary bg-primary/10"
                        : "border-border text-muted-foreground hover:border-primary/50")
                    }
                  >
                    {b.hex && (
                      <span
                        className="h-3 w-3 rounded-full border"
                        style={{ background: b.hex }}
                      />
                    )}
                    {b.label}
                  </button>
                ))}
              </div>
            </div>

            {bg.hex && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  {t("ipho.tolerance", { n: tolerance })}
                </Label>
                <input
                  type="range"
                  min={5}
                  max={70}
                  value={tolerance}
                  onChange={(e) => setTolerance(Number(e.target.value))}
                  className="w-full accent-primary"
                />
                <p className="text-xs text-muted-foreground">
                  {t("ipho.toleranceHint")}
                </p>
              </div>
            )}

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t("ipho.zoom", { n: zoom })}</Label>
              <input
                type="range"
                min={100}
                max={200}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                className="w-full accent-primary"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t("ipho.offsetY", { n: offsetY })}</Label>
              <input
                type="range"
                min={-100}
                max={100}
                value={offsetY}
                onChange={(e) => setOffsetY(Number(e.target.value))}
                className="w-full accent-primary"
              />
              <p className="text-xs text-muted-foreground">
                {t("ipho.offsetHint")}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t("ipho.outFormat")}</Label>
              <Select value={format} onValueChange={(v) => setFormat(v as "png" | "jpeg")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="jpeg">{t("ipho.fmt.jpeg")}</SelectItem>
                  <SelectItem value="png">{t("ipho.fmt.png")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}

            <Button className="w-full" disabled={!preview || busy} onClick={() => void download()}>
              <Download className="h-4 w-4" />
              {busy ? t("ipho.exporting") : t("ipho.download")}
            </Button>
          </div>
        </ToolSection>
      </div>
    </ToolShell>
  )
}
