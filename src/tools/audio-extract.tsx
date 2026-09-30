import * as React from "react"
import { Download } from "lucide-react"

import { FileDrop } from "@/components/toolbox/file-drop"
import { ToolShell, ToolSection } from "@/components/toolbox/tool-shell"
import { Button } from "@/components/ui/button"
import { baseName, downloadBlob, encodeWav, formatDuration, readAsArrayBuffer } from "@/lib/toolbox/utils"

export default function AudioExtractTool() {
  const [fileName, setFileName] = React.useState("")
  const [audio, setAudio] = React.useState<AudioBuffer | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<{ url: string; blob: Blob } | null>(null)

  const ctxRef = React.useRef<AudioContext | null>(null)

  const handleFiles = async (files: File[]) => {
    const f = files[0]
    if (!f) return
    setBusy(true)
    setError(null)
    setResult((prev) => {
      if (prev) URL.revokeObjectURL(prev.url)
      return null
    })
    try {
      const buf = await readAsArrayBuffer(f)
      const ctx = ctxRef.current ?? new AudioContext()
      ctxRef.current = ctx
      const decoded = await ctx.decodeAudioData(buf.slice(0))
      setAudio(decoded)
      setFileName(f.name)
    } catch {
      setError("无法解析这个文件的音轨。如果它本身没有声音，或格式浏览器不支持（如部分 wmv、flac），就会失败。")
      setAudio(null)
    } finally {
      setBusy(false)
    }
  }

  const exportWav = () => {
    if (!audio) return
    setBusy(true)
    try {
      const channels: Float32Array[] = []
      for (let c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c))
      const blob = encodeWav(channels, audio.sampleRate)
      setResult((prev) => {
        if (prev) URL.revokeObjectURL(prev.url)
        return { url: URL.createObjectURL(blob), blob }
      })
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "导出失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <ToolShell
      title="提取音频"
      description="从视频里把声音单独取出来，导出成通用的 WAV 文件。也可以用来给音频格式转成 WAV。"
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <ToolSection title="来源文件">
          {!audio ? (
            <FileDrop
              accept="video/*,audio/*"
              onFiles={(f) => void handleFiles(f)}
              hint="mp4 / mov / webm / mp3 / m4a / wav 等都可以试试"
            />
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate font-medium">{fileName}</span>
                <Button variant="ghost" size="sm" onClick={() => setAudio(null)}>
                  换一个
                </Button>
              </div>
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">时长</p>
                  <p className="mt-1 text-sm font-medium">{formatDuration(audio.duration)}</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">声道</p>
                  <p className="mt-1 text-sm font-medium">
                    {audio.numberOfChannels === 1 ? "单声道" : "立体声"}
                  </p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">采样率</p>
                  <p className="mt-1 text-sm font-medium">{audio.sampleRate} Hz</p>
                </div>
              </div>

              {result && (
                <div className="space-y-2 rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">试听</p>
                  <audio controls src={result.url} className="w-full" />
                </div>
              )}
            </div>
          )}
        </ToolSection>

        <ToolSection title="导出">
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              WAV 是未压缩格式，音质无损但体积较大（每分钟约 10 MB）。要压小体积可以用「音频剪辑」或外部工具再转成 mp3。
            </p>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <Button className="w-full" disabled={!audio || busy} onClick={exportWav}>
              <Download className="h-4 w-4" />
              {busy ? "处理中…" : "导出 WAV"}
            </Button>
            <Button
              variant="outline"
              className="w-full"
              disabled={!result}
              onClick={() => result && downloadBlob(result.blob, `${baseName(fileName || "audio")}.wav`)}
            >
              <Download className="h-4 w-4" />
              保存到本地
            </Button>
          </div>
        </ToolSection>
      </div>
    </ToolShell>
  )
}
