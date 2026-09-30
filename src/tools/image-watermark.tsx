import * as React from "react"
import { Download } from "lucide-react"

import { FileDrop } from "@/components/toolbox/file-drop"
import { ToolShell, ToolSection } from "@/components/toolbox/tool-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  baseName,
  canvasToBlob,
  createCanvas,
  downloadBlob,
  loadImageFile,
} from "@/lib/toolbox/utils"

type Anchor =
  | "tl" | "tc" | "tr"
  | "ml" | "mc" | "mr"
  | "bl" | "bc" | "br"

const ANCHORS: { id: Anchor; label: string }[] = [
  { id: "tl", label: "左上" },
  { id: "tc", label: "上中" },
  { id: "tr", label: "右上" },
  { id: "ml", label: "左中" },
  { id: "mc", label: "居中" },
  { id: "mr", label: "右中" },
  { id: "bl", label: "左下" },
  { id: "bc", label: "下中" },
  { id: "br", label: "右下" },
]

interface PaintOptions {
  kind: "text" | "image"
  text: string
  /** 字号占图片宽度的百分比 */
  fontPct: number
  color: string
  opacity: number
  rotation: number
  anchor: Anchor
  tile: boolean
  gapPct: number
  mark: HTMLImageElement | null
  markPct: number
}

function anchorPoint(anchor: Anchor, W: number, H: number, m: number) {
  const x = anchor[1] === "l" ? m : anchor[1] === "r" ? W - m : W / 2
  const y = anchor[0] === "t" ? m : anchor[0] === "b" ? H - m : H / 2
  return { x, y }
}

/** 把水印画到给定画布上；预览和导出共用这一份逻辑，保证所见即所得 */
function paint(ctx: CanvasRenderingContext2D, W: number, H: number, o: PaintOptions) {
  const margin = Math.round(W * 0.035)
  const font = Math.max(8, Math.round((W * o.fontPct) / 100))
  const markW = Math.max(8, Math.round((W * o.markPct) / 100))

  const drawOne = (x: number, y: number, anchor: Anchor) => {
    if (o.kind === "text") {
      ctx.font = `600 ${font}px "PingFang SC", "Microsoft YaHei", sans-serif`
      ctx.fillStyle = o.color
      ctx.textAlign = anchor[1] === "l" ? "left" : anchor[1] === "r" ? "right" : "center"
      ctx.textBaseline = anchor[0] === "t" ? "top" : anchor[0] === "b" ? "bottom" : "middle"
      ctx.fillText(o.text, x, y)
    } else if (o.mark) {
      const w = markW
      const h = (o.mark.naturalHeight / o.mark.naturalWidth) * w
      const dx = anchor[1] === "l" ? 0 : anchor[1] === "r" ? -w : -w / 2
      const dy = anchor[0] === "t" ? 0 : anchor[0] === "b" ? -h : -h / 2
      ctx.drawImage(o.mark, x + dx, y + dy, w, h)
    }
  }

  ctx.save()
  ctx.globalAlpha = o.opacity

  if (o.tile) {
    // 平铺：先把坐标系转到画布中心再整体旋转，网格覆盖整张图的对角线范围
    ctx.translate(W / 2, H / 2)
    ctx.rotate((o.rotation * Math.PI) / 180)
    const diag = Math.sqrt(W * W + H * H)
    const stepX = Math.max(24, (W * o.gapPct) / 100)
    const stepY = Math.max(24, (H * o.gapPct) / 100)
    for (let y = -diag / 2; y <= diag / 2; y += stepY) {
      for (let x = -diag / 2; x <= diag / 2; x += stepX) {
        drawOne(x, y, "mc")
      }
    }
  } else {
    const p = anchorPoint(o.anchor, W, H, margin)
    ctx.translate(p.x, p.y)
    ctx.rotate((o.rotation * Math.PI) / 180)
    drawOne(0, 0, o.anchor)
  }

  ctx.restore()
}

export default function ImageWatermarkTool() {
  const [file, setFile] = React.useState<File | null>(null)
  const [markName, setMarkName] = React.useState("")
  const [kind, setKind] = React.useState<"text" | "image">("text")
  const [text, setText] = React.useState("© 你的名字")
  const [fontPct, setFontPct] = React.useState(6)
  const [color, setColor] = React.useState("#ffffff")
  const [opacity, setOpacity] = React.useState(0.55)
  const [rotation, setRotation] = React.useState(-25)
  const [anchor, setAnchor] = React.useState<Anchor>("br")
  const [tile, setTile] = React.useState(false)
  const [gapPct, setGapPct] = React.useState(28)
  const [markPct, setMarkPct] = React.useState(18)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const imgRef = React.useRef<HTMLImageElement | null>(null)
  const markRef = React.useRef<HTMLImageElement | null>(null)
  const previewRef = React.useRef<HTMLCanvasElement>(null)

  const handleMain = async (files: File[]) => {
    const f = files[0]
    if (!f) return
    try {
      imgRef.current = await loadImageFile(f)
      setFile(f)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "图片打开失败")
    }
  }

  const handleMark = async (files: File[]) => {
    const f = files[0]
    if (!f) return
    try {
      markRef.current = await loadImageFile(f)
      setMarkName(f.name)
      setKind("image")
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "水印图片打开失败")
    }
  }

  const options: PaintOptions = React.useMemo(
    () => ({
      kind,
      text,
      fontPct,
      color,
      opacity,
      rotation,
      anchor,
      tile,
      gapPct,
      mark: markRef.current,
      markPct,
    }),
    [kind, text, fontPct, color, opacity, rotation, anchor, tile, gapPct, markPct, markName]
  )

  React.useEffect(() => {
    const img = imgRef.current
    const canvas = previewRef.current
    if (!img || !canvas) return
    const maxW = 900
    const scale = Math.min(1, maxW / img.naturalWidth)
    const W = Math.round(img.naturalWidth * scale)
    const H = Math.round(img.naturalHeight * scale)
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.clearRect(0, 0, W, H)
    ctx.drawImage(img, 0, 0, W, H)
    paint(ctx, W, H, options)
  }, [options, file])

  const download = async () => {
    const img = imgRef.current
    if (!img) return
    setBusy(true)
    try {
      const { canvas, ctx } = createCanvas(img.naturalWidth, img.naturalHeight)
      ctx.drawImage(img, 0, 0)
      paint(ctx, canvas.width, canvas.height, options)
      const blob = await canvasToBlob(canvas, "image/png")
      downloadBlob(blob, `${baseName(file?.name ?? "image")}-watermark.png`)
    } catch (e) {
      setError(e instanceof Error ? e.message : "导出失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <ToolShell
      title="加水印"
      description="给图片盖上文字或图片水印，适合发原创作品、防盗图。"
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <ToolSection title="图片">
          {!file ? (
            <FileDrop accept="image/*" onFiles={(f) => void handleMain(f)} />
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
                  }}
                >
                  换一张
                </Button>
              </div>
              <div className="flex justify-center overflow-hidden rounded-lg border bg-muted/30 p-2">
                <canvas ref={previewRef} className="h-auto max-h-[420px] w-auto max-w-full" />
              </div>
              <p className="text-xs text-muted-foreground">
                预览已按比例缩小，导出的仍是原始尺寸
              </p>
            </div>
          )}
        </ToolSection>

        <ToolSection title="水印设置">
          <div className="space-y-4">
            <Tabs value={kind} onValueChange={(v) => setKind(v as "text" | "image")}>
              <TabsList className="w-full">
                <TabsTrigger value="text" className="flex-1">
                  文字水印
                </TabsTrigger>
                <TabsTrigger value="image" className="flex-1">
                  图片水印
                </TabsTrigger>
              </TabsList>
              <TabsContent value="text" className="mt-3">
                <Input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="水印文字"
                />
              </TabsContent>
              <TabsContent value="image" className="mt-3 space-y-2">
                <FileDrop
                  accept="image/*"
                  onFiles={(f) => void handleMark(f)}
                  label={markName || "选择水印图片"}
                  hint="建议用透明底的 PNG"
                  className="py-5"
                />
              </TabsContent>
            </Tabs>

            {kind === "text" && (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">颜色</Label>
                  <Input
                    type="color"
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                    className="h-9 p-1"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">字号 {fontPct}%</Label>
                  <input
                    type="range"
                    min={2}
                    max={20}
                    value={fontPct}
                    onChange={(e) => setFontPct(Number(e.target.value))}
                    className="w-full accent-primary"
                  />
                </div>
              </>
            )}

            {kind === "image" && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">水印宽度 {markPct}%</Label>
                <input
                  type="range"
                  min={5}
                  max={80}
                  value={markPct}
                  onChange={(e) => setMarkPct(Number(e.target.value))}
                  className="w-full accent-primary"
                />
              </div>
            )}

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                透明度 {Math.round(opacity * 100)}%
              </Label>
              <input
                type="range"
                min={5}
                max={100}
                value={Math.round(opacity * 100)}
                onChange={(e) => setOpacity(Number(e.target.value) / 100)}
                className="w-full accent-primary"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">旋转 {rotation}°</Label>
              <input
                type="range"
                min={-90}
                max={90}
                value={rotation}
                onChange={(e) => setRotation(Number(e.target.value))}
                className="w-full accent-primary"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">位置</Label>
              <div className="grid w-fit grid-cols-3 gap-1">
                {ANCHORS.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    disabled={tile}
                    onClick={() => setAnchor(a.id)}
                    title={a.label}
                    className={
                      "h-7 w-9 rounded border text-[11px] transition-colors disabled:opacity-40 " +
                      (anchor === a.id
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border text-muted-foreground hover:border-primary/50")
                    }
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={tile}
                onChange={(e) => setTile(e.target.checked)}
                className="h-4 w-4 accent-primary"
              />
              平铺整张图（防裁剪盗用）
            </label>

            {tile && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">平铺间距 {gapPct}%</Label>
                <input
                  type="range"
                  min={8}
                  max={60}
                  value={gapPct}
                  onChange={(e) => setGapPct(Number(e.target.value))}
                  className="w-full accent-primary"
                />
              </div>
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}

            <Button className="w-full" disabled={!file || busy} onClick={() => void download()}>
              <Download className="h-4 w-4" />
              {busy ? "导出中…" : "下载带水印的图片"}
            </Button>
          </div>
        </ToolSection>
      </div>
    </ToolShell>
  )
}
