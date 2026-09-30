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
      setError(e instanceof Error ? e.message : "生成 GIF 失败")
    } finally {
      setBusy(false)
    }
  }

  const frameCount = Math.max(1, Math.round(Math.abs(end - start) * fps))

  return (
    <ToolShell
      title="视频转 GIF"
      description="选一段视频导出成 GIF 动图，可调时长、帧率、宽度。全部在本机完成，不会上传视频。"
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <ToolSection title="视频">
          {!url ? (
            <FileDrop accept="video/*" onFiles={handleFiles} hint="建议先用 5 秒以内的片段，GIF 体积增长很快" />
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
                  时长 {formatDuration(duration)}
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
                  换一个
                </Button>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    起点 {start.toFixed(1)}s
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
                  <Label className="text-xs text-muted-foreground">终点 {end.toFixed(1)}s</Label>
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

        <ToolSection title="GIF 设置">
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">帧率</Label>
              <Select value={String(fps)} onValueChange={(v) => setFps(Number(v))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[6, 8, 10, 12, 15, 20].map((f) => (
                    <SelectItem key={f} value={String(f)}>
                      {f} 帧/秒
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">宽度</Label>
              <Select value={String(width)} onValueChange={(v) => setWidth(Number(v))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="240">240px · 微信表情</SelectItem>
                  <SelectItem value="320">320px · 通用推荐</SelectItem>
                  <SelectItem value="480">480px · 清晰</SelectItem>
                  <SelectItem value="640">640px · 大图（体积大）</SelectItem>
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
              循环播放
            </label>

            <p className="text-xs text-muted-foreground">
              将生成 {frameCount} 帧。帧数和宽度都直接影响体积，GIF 一般控制在 3 MB 以内比较合适。
            </p>

            {busy && (
              <div className="space-y-1.5">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">正在生成 {progress}%</p>
              </div>
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}

            <Button className="w-full" disabled={!url || busy || duration <= 0} onClick={() => void generate()}>
              <Film className="h-4 w-4" />
              {busy ? "生成中…" : "生成 GIF"}
            </Button>

            <Button
              className="w-full"
              variant="outline"
              disabled={!result}
              onClick={() => result && downloadBlob(result.blob, `动图-${Date.now()}.gif`)}
            >
              <Download className="h-4 w-4" />
              下载 GIF
            </Button>
          </div>
        </ToolSection>
      </div>

      {result && (
        <ToolSection title="效果预览">
          <div className="flex flex-col items-center gap-3">
            <img src={result.url} alt="GIF 预览" className="max-h-[420px] rounded-lg border" />
            <p className="text-xs text-muted-foreground">文件大小 {formatBytes(result.blob.size)}</p>
          </div>
        </ToolSection>
      )}
    </ToolShell>
  )
}
