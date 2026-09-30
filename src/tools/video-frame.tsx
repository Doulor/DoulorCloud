import * as React from "react"
import { Camera, Package } from "lucide-react"

import { FileDrop } from "@/components/toolbox/file-drop"
import { ToolShell, ToolSection } from "@/components/toolbox/tool-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { canvasToBlob, createCanvas, downloadBlob, formatDuration } from "@/lib/toolbox/utils"
import { blobToBytes, createZip, type ZipEntry } from "@/lib/toolbox/zip"

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

export default function VideoFrameTool() {
  const [file, setFile] = React.useState<File | null>(null)
  const [url, setUrl] = React.useState<string | null>(null)
  const [duration, setDuration] = React.useState(0)
  const [time, setTime] = React.useState(0)
  const [interval, setIntervalSec] = React.useState(5)
  const [format, setFormat] = React.useState<"png" | "jpeg">("png")
  const [shots, setShots] = React.useState<{ url: string; name: string; blob: Blob }[]>([])
  const [busy, setBusy] = React.useState(false)
  const [progress, setProgress] = React.useState(0)
  const [error, setError] = React.useState<string | null>(null)

  const videoRef = React.useRef<HTMLVideoElement | null>(null)

  const handleFiles = (files: File[]) => {
    const f = files[0]
    if (!f) return
    setShots((prev) => {
      prev.forEach((s) => URL.revokeObjectURL(s.url))
      return []
    })
    setUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return URL.createObjectURL(f)
    })
    setFile(f)
    setTime(0)
    setDuration(0)
    setError(null)
  }

  const grab = async (t: number) => {
    const video = videoRef.current
    if (!video) throw new Error("视频还没准备好")
    await seekTo(video, t)
    const { canvas, ctx } = createCanvas(video.videoWidth, video.videoHeight)
    if (format === "jpeg") {
      ctx.fillStyle = "#ffffff"
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    return canvasToBlob(
      canvas,
      format === "png" ? "image/png" : "image/jpeg",
      format === "jpeg" ? 0.92 : undefined
    )
  }

  const captureOne = async () => {
    setBusy(true)
    try {
      const blob = await grab(time)
      const name = `frame-${time.toFixed(2).replace(".", "_")}s.${format === "png" ? "png" : "jpg"}`
      downloadBlob(blob, name)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "截帧失败")
    } finally {
      setBusy(false)
    }
  }

  const captureAll = async () => {
    const video = videoRef.current
    if (!video || duration <= 0) return
    setBusy(true)
    setProgress(0)
    setShots((prev) => {
      prev.forEach((s) => URL.revokeObjectURL(s.url))
      return []
    })
    try {
      const step = Math.max(0.5, interval)
      const total = Math.max(1, Math.floor(duration / step) + 1)
      const out: { url: string; name: string; blob: Blob }[] = []
      for (let i = 0; i < total; i++) {
        const t = Math.min(i * step, Math.max(0, duration - 0.05))
        const blob = await grab(t)
        out.push({
          url: URL.createObjectURL(blob),
          name: `frame-${String(i + 1).padStart(3, "0")}-${t.toFixed(1)}s.${format === "png" ? "png" : "jpg"}`,
          blob,
        })
        setProgress(Math.round(((i + 1) / total) * 100))
      }
      setShots(out)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "批量截帧失败")
    } finally {
      setBusy(false)
    }
  }

  const downloadZip = async () => {
    if (shots.length === 0) return
    setBusy(true)
    try {
      const entries: ZipEntry[] = []
      for (const s of shots) entries.push({ name: s.name, data: await blobToBytes(s.blob) })
      downloadBlob(createZip(entries), `视频截帧-${Date.now()}.zip`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <ToolShell
      title="视频截帧"
      description="把视频里某一秒的画面存成图片。想批量导出成图片序列（比如做逐帧素材）也可以。"
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <ToolSection title="视频">
          {!url ? (
            <FileDrop
              accept="video/*"
              onFiles={handleFiles}
              hint="支持浏览器能播放的格式，一般 mp4 / webm 都没问题"
            />
          ) : (
            <div className="space-y-3">
              <div className="overflow-hidden rounded-lg border bg-black">
                {/* 只用来取帧，不需要用户操作播放控件 */}
                <video
                  ref={videoRef}
                  src={url}
                  className="mx-auto block max-h-[380px] w-auto max-w-full"
                  onLoadedMetadata={(e) => {
                    const v = e.currentTarget
                    setDuration(v.duration || 0)
                  }}
                  playsInline
                  muted
                />
              </div>
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate font-medium">{file?.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  时长 {formatDuration(duration)}
                </span>
                <Button variant="ghost" size="sm" onClick={() => { setUrl(null); setFile(null) }}>
                  换一个
                </Button>
              </div>

              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">
                  当前时间点 {time.toFixed(1)}s / {duration.toFixed(1)}s
                </Label>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0.1, duration)}
                  step={0.05}
                  value={time}
                  onChange={(e) => {
                    const t = Number(e.target.value)
                    setTime(t)
                    const v = videoRef.current
                    if (v) v.currentTime = t
                  }}
                  className="w-full accent-primary"
                />
              </div>
            </div>
          )}
        </ToolSection>

        <ToolSection title="导出设置">
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">图片格式</Label>
              <div className="flex gap-2">
                {(["png", "jpeg"] as const).map((f) => (
                  <Button
                    key={f}
                    variant={format === f ? "default" : "outline"}
                    size="sm"
                    onClick={() => setFormat(f)}
                  >
                    {f === "png" ? "PNG 无损" : "JPG 小体积"}
                  </Button>
                ))}
              </div>
            </div>

            <Button className="w-full" disabled={!url || busy} onClick={() => void captureOne()}>
              <Camera className="h-4 w-4" />
              截取当前画面并下载
            </Button>

            <div className="space-y-1.5 border-t pt-4">
              <Label className="text-xs text-muted-foreground">批量截帧：每几秒一张</Label>
              <Input
                type="number"
                min={0.5}
                step={0.5}
                value={interval}
                onChange={(e) => setIntervalSec(Math.max(0.5, Number(e.target.value) || 0.5))}
              />
              <p className="text-xs text-muted-foreground">
                预计约 {duration > 0 ? Math.floor(duration / Math.max(0.5, interval)) + 1 : 0} 张
              </p>
            </div>

            <Button
              variant="outline"
              className="w-full"
              disabled={!url || busy || duration <= 0}
              onClick={() => void captureAll()}
            >
              {busy && progress > 0 ? `截取中 ${progress}%` : "批量截帧"}
            </Button>

            <Button
              className="w-full"
              disabled={shots.length === 0 || busy}
              onClick={() => void downloadZip()}
            >
              <Package className="h-4 w-4" />
              打包下载 ZIP（{shots.length} 张）
            </Button>

            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        </ToolSection>
      </div>

      {shots.length > 0 && (
        <ToolSection title={`已截取 ${shots.length} 张（点单张可单独下载）`}>
          <div className="grid gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {shots.map((s) => (
              <button
                key={s.name}
                type="button"
                title={s.name}
                onClick={() => downloadBlob(s.blob, s.name)}
                className="overflow-hidden rounded-lg border transition-opacity hover:opacity-80"
              >
                <img src={s.url} alt={s.name} className="block w-full" />
                <span className="block truncate px-1.5 py-1 text-[11px] text-muted-foreground">
                  {s.name}
                </span>
              </button>
            ))}
          </div>
        </ToolSection>
      )}
    </ToolShell>
  )
}
