import * as React from "react"
import { Download, Video } from "lucide-react"

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

const MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
]

function pickMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null
  for (const m of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(m)) return m
  }
  return null
}

export default function VideoConvertTool() {
  const [file, setFile] = React.useState<File | null>(null)
  const [url, setUrl] = React.useState<string | null>(null)
  const [duration, setDuration] = React.useState(0)
  const [width, setWidth] = React.useState(720)
  const [bitrate, setBitrate] = React.useState(1200)
  const [fps, setFps] = React.useState(24)
  const [busy, setBusy] = React.useState(false)
  const [progress, setProgress] = React.useState(0)
  const [result, setResult] = React.useState<{ url: string; blob: Blob } | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const videoRef = React.useRef<HTMLVideoElement | null>(null)
  const rafRef = React.useRef<number | null>(null)
  const recorderRef = React.useRef<MediaRecorder | null>(null)
  const audioCtxRef = React.useRef<AudioContext | null>(null)

  const supported = React.useMemo(() => pickMime(), [])

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
    setError(null)
  }

  React.useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      if (recorderRef.current?.state === "recording") recorderRef.current.stop()
      void audioCtxRef.current?.close()
    },
    []
  )

  const stopAll = () => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    const rec = recorderRef.current
    if (rec && rec.state === "recording") rec.stop()
    videoRef.current?.pause()
  }

  const convert = async () => {
    const video = videoRef.current
    if (!video || !supported) return
    setBusy(true)
    setProgress(0)
    setError(null)

    try {
      const outW = Math.min(width, video.videoWidth || width)
      const outH = Math.max(2, Math.round((video.videoHeight / video.videoWidth) * outW))
      const { canvas, ctx } = createCanvas(outW, outH)
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = "high"

      const stream = canvas.captureStream(fps)

      // 音频走 WebAudio 图：既能把声音送进录制流，又不会真的从扬声器放出来
      try {
        const actx = audioCtxRef.current ?? new AudioContext()
        audioCtxRef.current = actx
        const src = actx.createMediaElementSource(video)
        const dest = actx.createMediaStreamDestination()
        src.connect(dest)
        dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t))
      } catch {
        // 拿不到音轨就只转视频，不阻断流程
      }

      const chunks: BlobPart[] = []
      const rec = new MediaRecorder(stream, {
        mimeType: supported,
        videoBitsPerSecond: bitrate * 1000,
      })
      recorderRef.current = rec
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data)
      }
      const finished = new Promise<void>((resolve) => {
        rec.onstop = () => resolve()
      })

      video.currentTime = 0
      video.muted = false
      await video.play()
      rec.start(250)

      const loop = () => {
        if (video.ended) {
          stopAll()
          return
        }
        ctx.drawImage(video, 0, 0, outW, outH)
        if (video.duration > 0) setProgress(Math.round((video.currentTime / video.duration) * 100))
        rafRef.current = requestAnimationFrame(loop)
      }
      rafRef.current = requestAnimationFrame(loop)

      await finished
      const blob = new Blob(chunks, { type: "video/webm" })
      if (blob.size === 0) throw new Error("没有录到内容，请重试")
      setResult({ url: URL.createObjectURL(blob), blob })
      setProgress(100)
    } catch (e) {
      setError(e instanceof Error ? e.message : "转换失败")
    } finally {
      setBusy(false)
      recorderRef.current = null
    }
  }

  return (
    <ToolShell
      title="视频压缩与转格式"
      description="把视频降分辨率、降码率重新录一遍，体积通常能小很多。输出 WebM 格式。"
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <ToolSection title="视频">
          {!url ? (
            <FileDrop
              accept="video/*"
              onFiles={handleFiles}
              hint="转换过程是实时播放的，视频多长就要等多久"
            />
          ) : (
            <div className="space-y-3">
              <div className="overflow-hidden rounded-lg border bg-black">
                <video
                  ref={videoRef}
                  src={url}
                  className="mx-auto block max-h-[360px] w-auto max-w-full"
                  onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
                  playsInline
                />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="truncate font-medium">{file?.name}</span>
                <span className="text-xs text-muted-foreground">
                  时长 {formatDuration(duration)}
                  {videoRef.current?.videoWidth
                    ? ` · 原始 ${videoRef.current.videoWidth}×${videoRef.current.videoHeight}`
                    : ""}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    stopAll()
                    setUrl(null)
                    setFile(null)
                    setResult(null)
                  }}
                >
                  换一个
                </Button>
              </div>

              {busy && (
                <div className="space-y-1.5">
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    正在转换 {progress}% —— 请保持这个页面在前台
                  </p>
                </div>
              )}

              {result && (
                <div className="space-y-2 rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">
                    转换完成，{formatBytes(result.blob.size)}
                  </p>
                  <video src={result.url} controls className="w-full rounded" />
                </div>
              )}
            </div>
          )}
        </ToolSection>

        <ToolSection title="输出设置">
          <div className="space-y-4">
            {!supported && (
              <p className="text-xs text-destructive">
                当前浏览器不支持视频录制（MediaRecorder），建议换 Chrome 或 Edge 使用本工具。
              </p>
            )}

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">输出分辨率（宽度）</Label>
              <Select value={String(width)} onValueChange={(v) => setWidth(Number(v))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="480">480px · 体积最小</SelectItem>
                  <SelectItem value="720">720p · 推荐</SelectItem>
                  <SelectItem value="1080">1080p · 较清晰</SelectItem>
                  <SelectItem value="1440">1440px · 基本不压</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">不会超过原视频的宽度</p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">码率 {bitrate} kbps</Label>
              <input
                type="range"
                min={200}
                max={6000}
                step={100}
                value={bitrate}
                onChange={(e) => setBitrate(Number(e.target.value))}
                className="w-full accent-primary"
              />
              <p className="text-xs text-muted-foreground">
                720p 建议 1000–1500；480p 用 500–800 就够
              </p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">帧率</Label>
              <Select value={String(fps)} onValueChange={(v) => setFps(Number(v))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[15, 20, 24, 30].map((f) => (
                    <SelectItem key={f} value={String(f)}>
                      {f} 帧/秒
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <p className="text-xs text-muted-foreground">
              预计体积约 {duration > 0 ? formatBytes((bitrate * 1000 * duration) / 8) : "—"}（实际以输出为准）
            </p>

            {error && <p className="text-xs text-destructive">{error}</p>}

            <Button
              className="w-full"
              disabled={!url || busy || !supported || duration <= 0}
              onClick={() => void convert()}
            >
              <Video className="h-4 w-4" />
              {busy ? "转换中…" : "开始转换"}
            </Button>

            {busy && (
              <Button variant="outline" className="w-full" onClick={stopAll}>
                中止
              </Button>
            )}

            <Button
              className="w-full"
              variant="outline"
              disabled={!result}
              onClick={() => result && downloadBlob(result.blob, `压缩-${Date.now()}.webm`)}
            >
              <Download className="h-4 w-4" />
              下载 WebM
            </Button>
          </div>
        </ToolSection>
      </div>
    </ToolShell>
  )
}
