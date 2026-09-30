import * as React from "react"
import { Download, Pause, Play } from "lucide-react"

import { FileDrop } from "@/components/toolbox/file-drop"
import { ToolShell, ToolSection } from "@/components/toolbox/tool-shell"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  baseName,
  downloadBlob,
  encodeWav,
  formatDuration,
  readAsArrayBuffer,
} from "@/lib/toolbox/utils"

export default function AudioTrimTool() {
  const [fileName, setFileName] = React.useState("")
  const [audio, setAudio] = React.useState<AudioBuffer | null>(null)
  const [start, setStart] = React.useState(0)
  const [end, setEnd] = React.useState(1)
  const [playing, setPlaying] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const boxRef = React.useRef<HTMLDivElement | null>(null)
  const ctxRef = React.useRef<AudioContext | null>(null)
  const sourceRef = React.useRef<AudioBufferSourceNode | null>(null)
  const dragging = React.useRef<"start" | "end" | null>(null)

  const handleFiles = async (files: File[]) => {
    const f = files[0]
    if (!f) return
    setBusy(true)
    setError(null)
    try {
      const buf = await readAsArrayBuffer(f)
      const ctx = ctxRef.current ?? new AudioContext()
      ctxRef.current = ctx
      const decoded = await ctx.decodeAudioData(buf.slice(0))
      setAudio(decoded)
      setFileName(f.name)
      setStart(0)
      setEnd(1)
    } catch {
      setError("无法解析这个音频文件，请确认它是浏览器支持的格式（mp3 / m4a / wav / ogg 等）。")
      setAudio(null)
    } finally {
      setBusy(false)
    }
  }

  // 画波形：按像素列取该列内采样点的最大绝对值
  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !audio) return
    const W = canvas.clientWidth || 800
    const H = 120
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const data = audio.getChannelData(0)
    const step = Math.max(1, Math.floor(data.length / W))
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = "rgba(120,120,120,0.55)"
    for (let x = 0; x < W; x++) {
      let peak = 0
      const from = x * step
      for (let i = 0; i < step && from + i < data.length; i++) {
        const v = Math.abs(data[from + i])
        if (v > peak) peak = v
      }
      const h = Math.max(1, peak * H)
      ctx.fillRect(x, (H - h) / 2, 1, h)
    }
  }, [audio])

  React.useEffect(
    () => () => {
      sourceRef.current?.stop()
      void ctxRef.current?.close()
    },
    []
  )

  const preview = () => {
    const ctx = ctxRef.current
    if (!audio || !ctx) return
    if (playing) {
      sourceRef.current?.stop()
      setPlaying(false)
      return
    }
    const s = start * audio.duration
    const d = (end - start) * audio.duration
    const src = ctx.createBufferSource()
    src.buffer = audio
    src.connect(ctx.destination)
    src.onended = () => setPlaying(false)
    src.start(0, s, d)
    sourceRef.current = src
    setPlaying(true)
  }

  const exportWav = () => {
    if (!audio) return
    setBusy(true)
    try {
      const s = Math.floor(start * audio.duration * audio.sampleRate)
      const e = Math.floor(end * audio.duration * audio.sampleRate)
      const len = Math.max(1, e - s)
      const channels: Float32Array[] = []
      for (let c = 0; c < audio.numberOfChannels; c++) {
        channels.push(audio.getChannelData(c).slice(s, s + len))
      }
      const blob = encodeWav(channels, audio.sampleRate)
      downloadBlob(blob, `${baseName(fileName || "audio")}-剪辑.wav`)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "导出失败")
    } finally {
      setBusy(false)
    }
  }

  const pointToRatio = (clientX: number) => {
    const box = boxRef.current
    if (!box) return 0
    const r = box.getBoundingClientRect()
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width))
  }

  const onDown = (e: React.PointerEvent) => {
    if (!audio) return
    const ratio = pointToRatio(e.clientX)
    // 离哪个端点近就拖哪个，否则从当前位置重新框一段
    dragging.current =
      Math.abs(ratio - start) < Math.abs(ratio - end) ? "start" : "end"
    if (Math.abs(ratio - start) > 0.03 && Math.abs(ratio - end) > 0.03) {
      dragging.current = "end"
      setStart(ratio)
      setEnd(ratio)
    }
    boxRef.current?.setPointerCapture(e.pointerId)
  }

  const onMove = (e: React.PointerEvent) => {
    if (!dragging.current) return
    const ratio = pointToRatio(e.clientX)
    if (dragging.current === "start") setStart(Math.min(ratio, end - 0.005))
    else setEnd(Math.max(ratio, start + 0.005))
  }

  const onUp = (e: React.PointerEvent) => {
    dragging.current = null
    boxRef.current?.releasePointerCapture(e.pointerId)
  }

  const selLen = audio ? (end - start) * audio.duration : 0

  return (
    <ToolShell
      title="音频剪辑"
      description="在波形上拖出要保留的一段，试听满意后导出。适合截手机铃声、剪一段语音。"
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <ToolSection title="音频">
          {!audio ? (
            <FileDrop accept="audio/*,video/*" onFiles={(f) => void handleFiles(f)} />
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate font-medium">{fileName}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    sourceRef.current?.stop()
                    setPlaying(false)
                    setAudio(null)
                  }}
                >
                  换一个
                </Button>
              </div>

              <div
                ref={boxRef}
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={onUp}
                className="relative touch-none select-none overflow-hidden rounded-lg border bg-muted/30 p-2"
              >
                <canvas ref={canvasRef} className="block h-[120px] w-full" />
                <div
                  className="pointer-events-none absolute inset-y-0 border-x-2 border-primary bg-primary/15"
                  style={{ left: `${start * 100}%`, width: `${(end - start) * 100}%` }}
                />
              </div>

              <p className="text-xs text-muted-foreground">
                选中 {formatDuration(start * audio.duration)} → {formatDuration(end * audio.duration)}
                {"  "}（时长 {formatDuration(selLen)}）
              </p>
            </div>
          )}
        </ToolSection>

        <ToolSection title="操作">
          <div className="space-y-4">
            {audio && (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    起点 {formatDuration(start * audio.duration)}
                  </Label>
                  <input
                    type="range"
                    min={0}
                    max={1000}
                    value={Math.round(start * 1000)}
                    onChange={(e) => setStart(Math.min(Number(e.target.value) / 1000, end - 0.005))}
                    className="w-full accent-primary"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    终点 {formatDuration(end * audio.duration)}
                  </Label>
                  <input
                    type="range"
                    min={0}
                    max={1000}
                    value={Math.round(end * 1000)}
                    onChange={(e) => setEnd(Math.max(Number(e.target.value) / 1000, start + 0.005))}
                    className="w-full accent-primary"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <Button variant="outline" size="sm" onClick={() => { setStart(0); setEnd(1) }}>
                    全选
                  </Button>
                  <Button variant="outline" size="sm" onClick={preview}>
                    {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                    {playing ? "停止" : "试听"}
                  </Button>
                </div>
              </>
            )}

            <p className="text-xs text-muted-foreground">
              导出的是未压缩 WAV，音质无损但体积较大。
            </p>
            {error && <p className="text-xs text-destructive">{error}</p>}

            <Button className="w-full" disabled={!audio || busy} onClick={exportWav}>
              <Download className="h-4 w-4" />
              {busy ? "导出中…" : "导出选中的片段"}
            </Button>
          </div>
        </ToolSection>
      </div>
    </ToolShell>
  )
}
