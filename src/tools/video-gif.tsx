import * as React from "react"
import { Download, Film } from "lucide-react"
import { GIFEncoder, applyPalette, quantize } from "gifenc"

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
import { createCanvas, downloadBlob, formatBytes, formatDuration } from "@/lib/toolbox/utils"
import { useT } from "@/i18n"

function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener("seeked", done)
      resolve()
    }
    video.addEventListener("seeked", done)
    video.currentTime = Math.max(0, Math.min(t, Math.max(0, video.duration - 0.05)))
  })
}

export default function VideoGifTool() {
  const { t } = useT()
  const [file, setFile] = React.useState<File | null>(null)
  const [url, setUrl] = React.useState<string | null>(null)
  const [duration, setDuration] = React.useState(0)
  const [start, setStart] = React.useState(0)
  const [end, setEnd] = React.useState(3)
  const [fps, setFps] = React.useState(10)
  const [width, setWidth] = React.useState(320)
  const [loop, setLoop] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [progress, setProgress] = React.useState(0)
  const [result, setResult] = React.useState<{ url: string; blob: Blob } | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const videoRef = React.useRef<HTMLVideoElement | null>(null)

  const handleFiles = (files: File[]) => {
    const f = files[0]
    if (!f) return
    setUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return URL.createObjectURL(f)
    })
    setResult((prev) => {
      if (prev) URL.revokeObjectURL(prev.url)
      return null
    })
    setFile(f)
    setDuration(0)
    setStart(0)
    setEnd(3)
    setError(null)
  }

  const onMeta = (v: HTMLVideoElement) => {
    const d = v.duration || 0
    setDuration(d)
    setStart(0)
    setEnd(Math.min(3, d))
  }

  const generate = async () => {
    const video = videoRef.current
    if (!video || duration <= 0) return
    const from = Math.min(start, end)
    const to = Math.max(start, end)
    const span = Math.max(0.1, to - from)
    const outW = width
    const outH = Math.max(2, Math.round((video.videoHeight / video.videoWidth) * outW))
    const frameCount = Math.max(1, Math.round(span * fps))
    const delay = Math.round(1000 / fps)

    setBusy(true)
    setProgress(0)
    setError(null)

    try {
      const { ctx } = createCanvas(outW, outH)
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = "high"

      // 先从若干帧里采一份全局调色板，整段 GIF 共用，体积比逐帧调色板小很多
      const samples: Uint8ClampedArray[] = []
      const sampleCount = Math.min(8, frameCount)
      for (let i = 0; i < sampleCount; i++) {
        const t = from + (span * i) / Math.max(1, sampleCount - 1 || 1)
        await seekTo(video, t)
        ctx.drawImage(video, 0, 0, outW, outH)
        samples.push(ctx.getImageData(0, 0, outW, outH).data)
      }
      const merged = new Uint8Array(samples.length * outW * outH * 4)
      samples.forEach((s, i) => merged.set(s, i * outW * outH * 4))
      const palette = quantize(merged, 256)

      const gif = GIFEncoder()
      for (let i = 0; i < frameCount; i++) {
        const t = from + (span * i) / Math.max(1, frameCount - 1 || 1)
        await seekTo(video, t)
        ctx.drawImage(video, 0, 0, outW, outH)
        const { data } = ctx.getImageData(0, 0, outW, outH)
        const index = applyPalette(data, palette)
        gif.writeFrame(index, outW, outH, {
          palette,
          delay,
          repeat: loop ? 0 : -1,
        })
        setProgress(Math.round(((i + 1) / frameCount) * 100))
      }
      gif.finish()
      const blob = new Blob([new Uint8Array(gif.bytes())], { type: "image/gif" })
      setResult((prev) => {
        if (prev) URL.revokeObjectURL(prev.url)
        return { url: URL.createObjectURL(blob), blob }
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : t("vg.err.generate"))
    } finally {
      setBusy(false)
    }
  }

  const frameCount = Math.max(1, Math.round(Math.abs(end - start) * fps))

  return (
    <ToolShell
      title={t("toolbox.videoGif.name")}
      description={t("vg.desc")}
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <ToolSection title={t("vg.section.video")}>
          {!url ? (
            <FileDrop accept="video/*" onFiles={handleFiles} hint={t("vg.pickHint")} />
          ) : (
            <div className="space-y-3">
              <div className="overflow-hidden rounded-lg border bg-black">
                <video
                  ref={videoRef}
                  src={url}
                  controls
                  className="mx-auto block max-h-[360px] w-auto max-w-full"
                  onLoadedMetadata={(e) => onMeta(e.currentTarget)}
                  playsInline
                />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="truncate font-medium">{file?.name}</span>
                <span className="text-xs text-muted-foreground">
                  {t("vc.duration", { d: formatDuration(duration) })}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setUrl(null)
                    setFile(null)
                    setResult(null)
                  }}
                >
                  {t("vg.replace")}
                </Button>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    {t("vg.start", { n: start.toFixed(1) })}
                  </Label>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0.1, duration)}
                    step={0.1}
                    value={start}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      setStart(v)
                      if (v >= end) setEnd(Math.min(duration, v + 1))
                      const el = videoRef.current
                      if (el) el.currentTime = v
                    }}
                    className="w-full accent-primary"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">{t("vg.end", { n: end.toFixed(1) })}</Label>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0.1, duration)}
                    step={0.1}
                    value={end}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      setEnd(v)
                      if (v <= start) setStart(Math.max(0, v - 1))
                      const el = videoRef.current
                      if (el) el.currentTime = v
                    }}
                    className="w-full accent-primary"
                  />
                </div>
              </div>
            </div>
          )}
        </ToolSection>

        <ToolSection title={t("vg.section.settings")}>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t("vg.fps")}</Label>
              <Select value={String(fps)} onValueChange={(v) => setFps(Number(v))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[6, 8, 10, 12, 15, 20].map((f) => (
                    <SelectItem key={f} value={String(f)}>
                      {t("vc.fpsUnit", { n: f })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t("vg.width")}</Label>
              <Select value={String(width)} onValueChange={(v) => setWidth(Number(v))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="240">{t("vg.w.240")}</SelectItem>
                  <SelectItem value="320">{t("vg.w.320")}</SelectItem>
                  <SelectItem value="480">{t("vg.w.480")}</SelectItem>
                  <SelectItem value="640">{t("vg.w.640")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={loop}
                onChange={(e) => setLoop(e.target.checked)}
                className="h-4 w-4 accent-primary"
              />
              {t("vg.loop")}
            </label>

            <p className="text-xs text-muted-foreground">
              {t("vg.frameNote", { n: frameCount })}
            </p>

            {busy && (
              <div className="space-y-1.5">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">{t("vg.generating", { n: progress })}</p>
              </div>
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}

            <Button className="w-full" disabled={!url || busy || duration <= 0} onClick={() => void generate()}>
              <Film className="h-4 w-4" />
              {busy ? t("vg.generatingShort") : t("vg.generate")}
            </Button>

            <Button
              className="w-full"
              variant="outline"
              disabled={!result}
              onClick={() => result && downloadBlob(result.blob, t("vg.fileName", { ts: Date.now() }))}
            >
              <Download className="h-4 w-4" />
              {t("vg.download")}
            </Button>
          </div>
        </ToolSection>
      </div>

      {result && (
        <ToolSection title={t("vg.section.preview")}>
          <div className="flex flex-col items-center gap-3">
            <img src={result.url} alt={t("vg.alt.preview")} className="max-h-[420px] rounded-lg border" />
            <p className="text-xs text-muted-foreground">{t("vg.fileSize", { size: formatBytes(result.blob.size) })}</p>
          </div>
        </ToolSection>
      )}
    </ToolShell>
  )
}
