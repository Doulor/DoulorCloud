import * as React from "react"
import { Download } from "lucide-react"

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
import { useT } from "@/i18n"
import {
  baseName,
  canvasToBlob,
  canvasToIco,
  createCanvas,
  downloadBlob,
  formatBytes,
  loadImageFile,
} from "@/lib/toolbox/utils"

type OutFormat = "png" | "jpeg" | "webp" | "ico"

const ICO_SIZE_OPTIONS = [16, 32, 48, 64, 128, 256]

export default function ImageConvertTool() {
  const { t } = useT()
  const [file, setFile] = React.useState<File | null>(null)
  const [format, setFormat] = React.useState<OutFormat>("png")
  const [quality, setQuality] = React.useState(0.9)
  const [bg, setBg] = React.useState("#ffffff")
  const [icoSizes, setIcoSizes] = React.useState<number[]>([16, 32, 48, 256])
  const [out, setOut] = React.useState<{ blob: Blob; name: string; url: string } | null>(null)
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
      setError(e instanceof Error ? e.message : t("icv.err.open"))
    }
  }

  React.useEffect(() => {
    const img = imgRef.current
    if (!file || !img) return
    let cancelled = false
    let url: string | null = null
    setBusy(true)

    void (async () => {
      try {
        const w = img.naturalWidth
        const h = img.naturalHeight
        const stem = baseName(file.name)
        let blob: Blob
        let name: string

        if (format === "ico") {
          const sizes = [...new Set(icoSizes)].sort((a, b) => a - b)
          if (sizes.length === 0) throw new Error(t("icv.err.pickSize"))
          const canvases = sizes.map((size) => {
            const { canvas, ctx } = createCanvas(size, size)
            ctx.imageSmoothingEnabled = true
            ctx.imageSmoothingQuality = "high"
            const scale = Math.min(size / w, size / h)
            const dw = Math.max(1, Math.round(w * scale))
            const dh = Math.max(1, Math.round(h * scale))
            ctx.drawImage(img, Math.round((size - dw) / 2), Math.round((size - dh) / 2), dw, dh)
            return { size, canvas }
          })
          blob = await canvasToIco(canvases)
          name = `${stem}.ico`
        } else {
          const { canvas, ctx } = createCanvas(w, h)
          // JPEG 没有透明通道，透明像素会变黑，先铺一层底色
          if (format === "jpeg") {
            ctx.fillStyle = bg
            ctx.fillRect(0, 0, w, h)
          }
          ctx.drawImage(img, 0, 0)
          const mime =
            format === "png" ? "image/png" : format === "webp" ? "image/webp" : "image/jpeg"
          blob = await canvasToBlob(canvas, mime, format === "png" ? undefined : quality)
          name = `${stem}.${format === "jpeg" ? "jpg" : format}`
        }

        if (cancelled) return
        url = URL.createObjectURL(blob)
        setOut({ blob, name, url })
        setError(null)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : t("icv.err.convert"))
      } finally {
        if (!cancelled) setBusy(false)
      }
    })()

    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [file, format, quality, bg, icoSizes])

  return (
    <ToolShell
      title={t("toolbox.imageConvert.name")}
      description={t("icv.desc")}
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <ToolSection title={t("icv.section.original")}>
          {!file ? (
            <FileDrop
              accept="image/*"
              onFiles={(f) => void handleFiles(f)}
              hint={t("icv.pickHint")}
            />
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate font-medium">{file.name}</span>
                <Button variant="ghost" size="sm" onClick={() => { setFile(null); imgRef.current = null; setOut(null) }}>
                  {t("icv.replace")}
                </Button>
              </div>
              <div className="flex items-center justify-center rounded-lg border bg-muted/30 p-3">
                {out ? (
                  <img src={out.url} alt={t("icv.alt.result")} className="max-h-[320px] w-auto rounded" />
                ) : (
                  <div className="py-10 text-sm text-muted-foreground">{t("icv.processing")}</div>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {t("icv.originalSize", { w: imgRef.current?.naturalWidth ?? 0, h: imgRef.current?.naturalHeight ?? 0 })}{" "}
                {formatBytes(file.size)}
                {out && (
                  <>
                    {" → "}
                    {t("icv.outSize", { size: formatBytes(out.blob.size) })}
                    {file.size > 0 && (
                      <span className="ml-1">
                        （
                        {out.blob.size < file.size
                          ? t("icv.smaller", { n: Math.round((1 - out.blob.size / file.size) * 100) })
                          : t("icv.larger", { n: Math.round((out.blob.size / file.size - 1) * 100) })}
                        ）
                      </span>
                    )}
                  </>
                )}
              </p>
            </div>
          )}
        </ToolSection>

        <ToolSection title={t("icv.section.output")}>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t("icv.target")}</Label>
              <Select value={format} onValueChange={(v) => setFormat(v as OutFormat)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="png">{t("icv.fmt.png")}</SelectItem>
                  <SelectItem value="jpeg">{t("icv.fmt.jpeg")}</SelectItem>
                  <SelectItem value="webp">{t("icv.fmt.webp")}</SelectItem>
                  <SelectItem value="ico">{t("icv.fmt.ico")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {(format === "jpeg" || format === "webp") && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  {t("icv.quality", { n: Math.round(quality * 100) })}
                </Label>
                <input
                  type="range"
                  min={10}
                  max={100}
                  value={Math.round(quality * 100)}
                  onChange={(e) => setQuality(Number(e.target.value) / 100)}
                  className="w-full accent-primary"
                />
              </div>
            )}

            {format === "jpeg" && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  {t("icv.bgFill")}
                </Label>
                <Input
                  type="color"
                  value={bg}
                  onChange={(e) => setBg(e.target.value)}
                  className="h-9 p-1"
                />
              </div>
            )}

            {format === "ico" && (
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">
                  {t("icv.icoSizes")}
                </Label>
                <div className="flex flex-wrap gap-2">
                  {ICO_SIZE_OPTIONS.map((s) => {
                    const on = icoSizes.includes(s)
                    return (
                      <button
                        key={s}
                        type="button"
                        onClick={() =>
                          setIcoSizes(on ? icoSizes.filter((x) => x !== s) : [...icoSizes, s])
                        }
                        className={
                          "rounded-md border px-2.5 py-1 text-xs transition-colors " +
                          (on
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border text-muted-foreground hover:border-primary/50")
                        }
                      >
                        {s}×{s}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}

            <Button
              className="w-full"
              disabled={!out || busy}
              onClick={() => out && downloadBlob(out.blob, out.name)}
            >
              <Download className="h-4 w-4" />
              {busy ? t("icv.processing") : t("common.download")}
            </Button>
          </div>
        </ToolSection>
      </div>
    </ToolShell>
  )
}
