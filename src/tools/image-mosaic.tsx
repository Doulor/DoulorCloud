import * as React from "react"
import { Download, Undo2 } from "lucide-react"

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
import { baseName, canvasToBlob, createCanvas, downloadBlob, loadImageFile } from "@/lib/toolbox/utils"

interface Op {
  x: number
  y: number
  w: number
  h: number
  mode: "mosaic" | "blur"
  strength: number
}

/** 在给定矩形上做马赛克：先缩到很小再放大回来，像素块自然就粗了 */
function applyMosaic(ctx: CanvasRenderingContext2D, op: Op, W: number, H: number) {
  const sx = Math.round(op.x * W)
  const sy = Math.round(op.y * H)
  const sw = Math.max(1, Math.round(op.w * W))
  const sh = Math.max(1, Math.round(op.h * H))
  const block = Math.max(2, op.strength)
  const tw = Math.max(1, Math.round(sw / block))
  const th = Math.max(1, Math.round(sh / block))

  const small = createCanvas(tw, th)
  small.ctx.imageSmoothingEnabled = true
  small.ctx.drawImage(ctx.canvas, sx, sy, sw, sh, 0, 0, tw, th)

  ctx.save()
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(small.canvas, 0, 0, tw, th, sx, sy, sw, sh)
  ctx.restore()
}

function applyBlur(ctx: CanvasRenderingContext2D, op: Op, W: number, H: number) {
  const sx = Math.round(op.x * W)
  const sy = Math.round(op.y * H)
  const sw = Math.max(1, Math.round(op.w * W))
  const sh = Math.max(1, Math.round(op.h * H))
  const snapshot = createCanvas(ctx.canvas.width, ctx.canvas.height)
  snapshot.ctx.drawImage(ctx.canvas, 0, 0)

  ctx.save()
  ctx.beginPath()
  ctx.rect(sx, sy, sw, sh)
  ctx.clip()
  ctx.filter = `blur(${Math.max(1, op.strength)}px)`
  ctx.drawImage(snapshot.canvas, 0, 0)
  ctx.restore()
}

export default function ImageMosaicTool() {
  const [fileName, setFileName] = React.useState("")
  const [srcUrl, setSrcUrl] = React.useState<string | null>(null)
  const [ops, setOps] = React.useState<Op[]>([])
  const [mode, setMode] = React.useState<"mosaic" | "blur">("mosaic")
  const [strength, setStrength] = React.useState(12)
  const [sel, setSel] = React.useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  /** 换图计数：同一个文件再选一次时 fileName 不会变，靠它强制重画 */
  const [version, setVersion] = React.useState(0)

  const imgRef = React.useRef<HTMLImageElement | null>(null)
  const boxRef = React.useRef<HTMLDivElement | null>(null)
  const dragging = React.useRef(false)
  const startRef = React.useRef({ x: 0, y: 0 })

  const handleFiles = async (files: File[]) => {
    const f = files[0]
    if (!f) return
    try {
      imgRef.current = await loadImageFile(f)
      setFileName(f.name)
      setOps([])
      setSel(null)
      setError(null)
      setVersion((v) => v + 1)
    } catch (e) {
      setError(e instanceof Error ? e.message : "图片打开失败")
    }
  }

  // 每次 ops 变化都从原图重画一遍，撤销就是把最后一个操作弹出去。
  // 这里用离屏画布，不依赖页面上有没有 canvas 元素，避免「预览一直出不来」。
  React.useEffect(() => {
    const img = imgRef.current
    if (!img) return
    const maxW = 900
    const scale = Math.min(1, maxW / img.naturalWidth)
    const { canvas, ctx } = createCanvas(
      Math.max(1, Math.round(img.naturalWidth * scale)),
      Math.max(1, Math.round(img.naturalHeight * scale))
    )
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    for (const op of ops) {
      if (op.mode === "mosaic") applyMosaic(ctx, op, canvas.width, canvas.height)
      else applyBlur(ctx, op, canvas.width, canvas.height)
    }
    setSrcUrl(canvas.toDataURL("image/png"))
  }, [ops, version])

  const pointFrom = (e: React.PointerEvent) => {
    const box = boxRef.current
    if (!box) return null
    const r = box.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    }
  }

  const onDown = (e: React.PointerEvent) => {
    const p = pointFrom(e)
    if (!p) return
    dragging.current = true
    startRef.current = p
    boxRef.current?.setPointerCapture(e.pointerId)
    setSel({ x: p.x, y: p.y, w: 0, h: 0 })
  }

  const onMove = (e: React.PointerEvent) => {
    if (!dragging.current) return
    const p = pointFrom(e)
    if (!p) return
    setSel({
      x: startRef.current.x,
      y: startRef.current.y,
      w: p.x - startRef.current.x,
      h: p.y - startRef.current.y,
    })
  }

  const onUp = (e: React.PointerEvent) => {
    if (!dragging.current) return
    dragging.current = false
    boxRef.current?.releasePointerCapture(e.pointerId)
    setSel((s) => {
      if (!s) return null
      const x = s.w < 0 ? s.x + s.w : s.x
      const y = s.h < 0 ? s.y + s.h : s.y
      const w = Math.abs(s.w)
      const h = Math.abs(s.h)
      if (w < 0.01 || h < 0.01) return null
      return { x, y, w, h }
    })
  }

  const apply = () => {
    if (!sel) return
    setOps((prev) => [...prev, { ...sel, mode, strength }])
    setSel(null)
  }

  const download = async () => {
    const img = imgRef.current
    if (!img) return
    setBusy(true)
    try {
      const { canvas, ctx } = createCanvas(img.naturalWidth, img.naturalHeight)
      ctx.drawImage(img, 0, 0)
      for (const op of ops) {
        if (op.mode === "mosaic") applyMosaic(ctx, op, canvas.width, canvas.height)
        else applyBlur(ctx, op, canvas.width, canvas.height)
      }
      const blob = await canvasToBlob(canvas, "image/png")
      downloadBlob(blob, `${baseName(fileName || "image")}-mosaic.png`)
    } catch (e) {
      setError(e instanceof Error ? e.message : "导出失败")
    } finally {
      setBusy(false)
    }
  }

  const norm = sel
    ? {
        left: (sel.w < 0 ? sel.x + sel.w : sel.x) * 100,
        top: (sel.h < 0 ? sel.y + sel.h : sel.y) * 100,
        width: Math.abs(sel.w) * 100,
        height: Math.abs(sel.h) * 100,
      }
    : null

  return (
    <ToolShell
      title="打码与马赛克"
      description="在图上框出要遮住的地方，打马赛克或模糊，可连续处理多处，随时撤销。"
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <ToolSection title="图片（按住拖动框选要遮挡的区域）">
          {!srcUrl ? (
            <FileDrop accept="image/*" onFiles={(f) => void handleFiles(f)} />
          ) : (
            <div className="space-y-3">
              <div
                ref={boxRef}
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={onUp}
                className="relative w-full touch-none select-none overflow-hidden rounded-lg border bg-muted/30"
              >
                <img src={srcUrl} alt="编辑中" className="block w-full" draggable={false} />
                {norm && (
                  <div
                    className="absolute border-2 border-primary"
                    style={{
                      left: `${norm.left}%`,
                      top: `${norm.top}%`,
                      width: `${norm.width}%`,
                      height: `${norm.height}%`,
                      boxShadow: "0 0 0 9999px rgba(0,0,0,0.35)",
                    }}
                  />
                )}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="truncate font-medium">{fileName}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSrcUrl(null)
                    imgRef.current = null
                    setOps([])
                    setSel(null)
                  }}
                >
                  换一张
                </Button>
              </div>
            </div>
          )}
        </ToolSection>

        <ToolSection title="遮挡设置">
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">方式</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as "mosaic" | "blur")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mosaic">马赛克（格子）</SelectItem>
                  <SelectItem value="blur">模糊（高斯）</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                {mode === "mosaic" ? `格子大小 ${strength}px` : `模糊半径 ${strength}px`}
              </Label>
              <input
                type="range"
                min={2}
                max={60}
                value={strength}
                onChange={(e) => setStrength(Number(e.target.value))}
                className="w-full accent-primary"
              />
              <p className="text-xs text-muted-foreground">
                号码、姓名这类敏感信息建议把格子调到 20 以上，太细仍有被还原的风险。
              </p>
            </div>

            <div className="rounded-lg border p-3 text-xs text-muted-foreground">
              已处理 <span className="font-medium text-foreground">{ops.length}</span> 处
              {sel ? " · 已有选区，点下面的按钮生效" : " · 在图上按住拖动来框选"}
            </div>

            <Button className="w-full" disabled={!sel} onClick={apply}>
              应用遮挡
            </Button>
            <Button
              variant="outline"
              className="w-full"
              disabled={ops.length === 0}
              onClick={() => setOps((prev) => prev.slice(0, -1))}
            >
              <Undo2 className="h-4 w-4" />
              撤销上一步
            </Button>

            {error && <p className="text-xs text-destructive">{error}</p>}

            <Button className="w-full" disabled={!srcUrl || busy} onClick={() => void download()}>
              <Download className="h-4 w-4" />
              {busy ? "导出中…" : "下载处理后的图片"}
            </Button>
          </div>
        </ToolSection>
      </div>
    </ToolShell>
  )
}
