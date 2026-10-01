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
import { useT } from "@/i18n"
import {
  baseName,
  canvasToBlob,
  createCanvas,
  downloadBlob,
  formatBytes,
  loadImageFile,
} from "@/lib/toolbox/utils"

type OutFormat = "webp" | "jpeg" | "png"

const PRESETS = [
  { id: "origin", label: "ic.size.origin", long: 0 },
  { id: "1920", label: "ic.size.1920", long: 1920 },
  { id: "1600", label: "ic.size.1600", long: 1600 },
  { id: "1280", label: "ic.size.1280", long: 1280 },
  { id: "1080", label: "ic.size.1080", long: 1080 },
  { id: "800", label: "ic.size.800", long: 800 },
  { id: "400", label: "ic.size.400", long: 400 },
]

export default function ImageCompressTool() {
  const { t } = useT()
  const [file, setFile] = React.useState<File | null>(null)
  const [preset, setPreset] = React.useState("1600")
  const [format, setFormat] = React.useState<OutFormat>("webp")
  const [quality, setQuality] = React.useState(80)
  const [out, setOut] = React.useState<{ blob: Blob; name: string; url: string; w: number; h: number } | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const imgRef = React.useRef<HTMLImageElement | null>(null)

  const handleFiles = async (files: File[]) => {
    const f = files[0]
    if (!f) return
    try {
      imgRef.current = await loadImageFile(f)
      setFile(f)
      setOut(null)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : t("ic.err.open"))
    }
  }

  React.useEffect(() => {
    const img = imgRef.current
    if (!file || !img) return
    let cancelled = false
    let url: string | null = null
    setBusy(true)

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const long = PRESETS.find((p) => p.id === preset)?.long ?? 0
          const srcLong = Math.max(img.naturalWidth, img.naturalHeight)
          const scale = long > 0 && srcLong > long ? long / srcLong : 1
          const w = Math.max(1, Math.round(img.naturalWidth * scale))
          const h = Math.max(1, Math.round(img.naturalHeight * scale))

          const { canvas, ctx } = createCanvas(w, h)
          ctx.imageSmoothingEnabled = true
          ctx.imageSmoothingQuality = "high"
          if (format === "jpeg") {
            ctx.fillStyle = "#ffffff"
            ctx.fillRect(0, 0, w, h)
          }
          ctx.drawImage(img, 0, 0, w, h)

          const mime =
            format === "webp" ? "image/webp" : format === "jpeg" ? "image/jpeg" : "image/png"
          const blob = await canvasToBlob(canvas, mime, format === "png" ? undefined : quality / 100)
          if (cancelled) return
          url = URL.createObjectURL(blob)
          setOut({
            blob,
            name: `${baseName(file.name)}-compressed.${format === "jpeg" ? "jpg" : format}`,
            url,
            w,
            h,
          })
          setError(null)
        } catch (e) {
          if (!cancelled) setError(e instanceof Error ? e.message : t("ic.err.compress"))
        } finally {
          if (!cancelled) setBusy(false)
        }
      })()
    }, 180)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
      if (url) URL.revokeObjectURL(url)
    }
  }, [file, preset, format, quality])

  const saved = file && out ? file.size - out.blob.size : 0

  return (
    <ToolShell
      title={t("toolbox.imageCompress.name")}
      description={t("ic.desc")}
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <ToolSection title={t("ic.section.original")}>
          {!file ? (
            <FileDrop accept="image/*" onFiles={(f) => void handleFiles(f)} />
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate font-medium">{file.name}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setFile(null)
                    imgRef.current = null
                    setOut(null)
                  }}
                >
                  {t("ic.replace")}
                </Button>
              </div>
              <div className="flex items-center justify-center rounded-lg border bg-muted/30 p-3">
                {out ? (
                  <img src={out.url} alt={t("ic.alt.compressed")} className="max-h-[360px] w-auto rounded" />
                ) : (
                  <div className="py-10 text-sm text-muted-foreground">{t("ic.processing")}</div>
                )}
              </div>
              {file && out && (
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div className="rounded-lg border p-3">
                    <p className="text-xs text-muted-foreground">{t("ic.stat.original")}</p>
                    <p className="mt-1 text-sm font-medium">{formatBytes(file.size)}</p>
                  </div>
                  <div className="rounded-lg border p-3">
                    <p className="text-xs text-muted-foreground">{t("ic.stat.compressed")}</p>
                    <p className="mt-1 text-sm font-medium">{formatBytes(out.blob.size)}</p>
                  </div>
                  <div className="rounded-lg border p-3">
                    <p className="text-xs text-muted-foreground">{t("ic.stat.saved")}</p>
                    <p className="mt-1 text-sm font-medium">
                      {saved > 0 ? `${Math.round((saved / file.size) * 100)}%` : "—"}
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}
        </ToolSection>

        <ToolSection title={t("ic.section.settings")}>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t("ic.size")}</Label>
              <Select value={preset} onValueChange={setPreset}>
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
              <Label className="text-xs text-muted-foreground">{t("ic.format")}</Label>
              <Select value={format} onValueChange={(v) => setFormat(v as OutFormat)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="webp">{t("ic.fmt.webp")}</SelectItem>
                  <SelectItem value="jpeg">{t("ic.fmt.jpeg")}</SelectItem>
                  <SelectItem value="png">{t("ic.fmt.png")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {format !== "png" && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t("ic.quality", { n: quality })}</Label>
                <input
                  type="range"
                  min={20}
                  max={100}
                  value={quality}
                  onChange={(e) => setQuality(Number(e.target.value))}
                  className="w-full accent-primary"
                />
                <p className="text-xs text-muted-foreground">
                  {t("ic.qualityHint")}
                </p>
              </div>
            )}

            {out && (
              <p className="text-xs text-muted-foreground">
                {t("ic.outSize", { w: out.w, h: out.h })}
              </p>
            )}
            {error && <p className="text-xs text-destructive">{error}</p>}

            <Button
              className="w-full"
              disabled={!out || busy}
              onClick={() => out && downloadBlob(out.blob, out.name)}
            >
              <Download className="h-4 w-4" />
              {busy ? t("ic.processing") : t("ic.download")}
            </Button>
          </div>
        </ToolSection>
      </div>
    </ToolShell>
  )
}
