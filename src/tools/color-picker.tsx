import * as React from "react"
import { Check, Copy } from "lucide-react"

import { FileDrop } from "@/components/toolbox/file-drop"
import { ToolShell, ToolSection } from "@/components/toolbox/tool-shell"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { copyText, loadImageFile } from "@/lib/toolbox/utils"
import { cn } from "@/lib/utils"
import { useT } from "@/i18n"

interface Rgb {
  r: number
  g: number
  b: number
}

function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`
}

function toHsl({ r, g, b }: Rgb): string {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
    else if (max === gn) h = ((bn - rn) / d + 2) / 6
    else h = ((rn - gn) / d + 4) / 6
  }
  return `hsl(${Math.round(h * 360)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`
}

function distance(a: Rgb, b: Rgb): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2)
}

/** 把画布像素按 4bit/通道分桶，取出现最多的若干桶，再把桶内像素求平均 */
function extractPalette(data: Uint8ClampedArray, count: number): Rgb[] {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>()
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4)
    const cur = buckets.get(key)
    if (cur) {
      cur.n++
      cur.r += data[i]
      cur.g += data[i + 1]
      cur.b += data[i + 2]
    } else {
      buckets.set(key, { n: 1, r: data[i], g: data[i + 1], b: data[i + 2] })
    }
  }

  const sorted = [...buckets.values()]
    .sort((a, b) => b.n - a.n)
    .map((v) => ({
      r: Math.round(v.r / v.n),
      g: Math.round(v.g / v.n),
      b: Math.round(v.b / v.n),
    }))

  const out: Rgb[] = []
  for (const c of sorted) {
    if (out.length >= count) break
    if (out.some((o) => distance(o, c) < 36)) continue
    out.push(c)
  }
  return out
}

export default function ColorPickerTool() {
  const { t } = useT()
  const [fileName, setFileName] = React.useState("")
  const [ready, setReady] = React.useState(false)
  const [picked, setPicked] = React.useState<Rgb | null>(null)
  const [hover, setHover] = React.useState<Rgb | null>(null)
  const [palette, setPalette] = React.useState<Rgb[]>([])
  const [copied, setCopied] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const dataRef = React.useRef<ImageData | null>(null)

  const handleFiles = async (files: File[]) => {
    const f = files[0]
    if (!f) return
    try {
      const img = await loadImageFile(f)
      const canvas = canvasRef.current
      if (!canvas) return
      const maxW = 900
      const scale = Math.min(1, maxW / img.naturalWidth)
      canvas.width = Math.round(img.naturalWidth * scale)
      canvas.height = Math.round(img.naturalHeight * scale)
      const ctx = canvas.getContext("2d", { willReadFrequently: true })
      if (!ctx) throw new Error(t("cp.err.canvas"))
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
      dataRef.current = data
      setPalette(extractPalette(data.data, 8))
      setPicked(null)
      setFileName(f.name)
      setReady(true)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : t("cp.err.open"))
    }
  }

  const readAt = (e: React.MouseEvent<HTMLCanvasElement>): Rgb | null => {
    const canvas = canvasRef.current
    const data = dataRef.current
    if (!canvas || !data) return null
    const r = canvas.getBoundingClientRect()
    const x = Math.floor(((e.clientX - r.left) / r.width) * canvas.width)
    const y = Math.floor(((e.clientY - r.top) / r.height) * canvas.height)
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return null
    const i = (y * canvas.width + x) * 4
    return { r: data.data[i], g: data.data[i + 1], b: data.data[i + 2] }
  }

  const doCopy = async (text: string) => {
    await copyText(text)
    setCopied(text)
    window.setTimeout(() => setCopied((c) => (c === text ? null : c)), 1200)
  }

  const current = hover ?? picked

  return (
    <ToolShell
      title={t("toolbox.colorPicker.name")}
      description={t("cp.desc")}
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <ToolSection title={t("cp.section.image")}>
          {/* 画布必须一直挂载着：handleFiles 里要拿它读像素。若画布跟着 ready 一起
              条件渲染，第一次选图时 canvasRef.current 还是 null，会直接 return，
              表现就是「点了没反应」。所以只把整块藏起来，不用卸载。 */}
          {!ready && <FileDrop accept="image/*" onFiles={(f) => void handleFiles(f)} />}
          <div className={cn("space-y-3", !ready && "hidden")}>
            <div className="flex justify-center overflow-hidden rounded-lg border bg-muted/30 p-2">
              <canvas
                ref={canvasRef}
                onClick={(e) => {
                  const c = readAt(e)
                  if (c) setPicked(c)
                }}
                onMouseMove={(e) => setHover(readAt(e))}
                onMouseLeave={() => setHover(null)}
                className="h-auto max-h-[520px] w-auto max-w-full cursor-crosshair"
              />
            </div>
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="truncate font-medium">{fileName}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setReady(false)
                  setPalette([])
                  setPicked(null)
                  dataRef.current = null
                }}
              >
                {t("cp.replace")}
              </Button>
            </div>
          </div>
        </ToolSection>

        <ToolSection title={t("cp.section.color")}>
          <div className="space-y-4">
            <div className="rounded-lg border p-3">
              <div
                className="h-16 w-full rounded border"
                style={{ background: current ? toHex(current) : "transparent" }}
              />
              {current ? (
                <div className="mt-3 space-y-1.5">
                  {[
                    { label: "HEX", value: toHex(current) },
                    { label: "RGB", value: `rgb(${current.r}, ${current.g}, ${current.b})` },
                    { label: "HSL", value: toHsl(current) },
                  ].map((row) => (
                    <button
                      key={row.label}
                      type="button"
                      onClick={() => void doCopy(row.value)}
                      className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
                    >
                      <span className="text-xs text-muted-foreground">{row.label}</span>
                      <span className="font-mono text-xs">{row.value}</span>
                      {copied === row.value ? (
                        <Check className="h-3.5 w-3.5 shrink-0" />
                      ) : (
                        <Copy className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-xs text-muted-foreground">
                  {t("cp.hint")}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">{t("cp.palette")}</Label>
              {palette.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("cp.paletteHint")}</p>
              ) : (
                <div className="grid grid-cols-4 gap-2">
                  {palette.map((c) => {
                    const hex = toHex(c)
                    return (
                      <button
                        key={hex}
                        type="button"
                        title={hex}
                        onClick={() => void doCopy(hex)}
                        className="group flex flex-col items-center gap-1"
                      >
                        <span
                          className="flex h-12 w-full items-center justify-center rounded border"
                          style={{ background: hex }}
                        >
                          {copied === hex && <Check className="h-4 w-4 text-white mix-blend-difference" />}
                        </span>
                        <span className="font-mono text-[10px] text-muted-foreground">{hex}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        </ToolSection>
      </div>
    </ToolShell>
  )
}
