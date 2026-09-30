import * as React from "react"
import { Download, FlipHorizontal, FlipVertical, RotateCcw, RotateCw } from "lucide-react"

import { FileDrop } from "@/components/toolbox/file-drop"
import { ToolShell, ToolSection } from "@/components/toolbox/tool-shell"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { baseName, canvasToBlob, createCanvas, downloadBlob, loadImageFile } from "@/lib/toolbox/utils"

interface Selection {
  x: number
  y: number
  w: number
  h: number
}

const FULL: Selection = { x: 0, y: 0, w: 1, h: 1 }

export default function ImageCropTool() {
  const [fileName, setFileName] = React.useState<string>("")
  const [srcUrl, setSrcUrl] = React.useState<string | null>(null)
  const [sel, setSel] = React.useState<Selection>(FULL)
  const [angle, setAngle] = React.useState(0)
  const [busy, setBusy] = React.useState(false)
  const [size, setSize] = React.useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const [error, setError] = React.useState<string | null>(null)

  const workRef = React.useRef<HTMLCanvasElement | null>(null)
  // 保留一份未旋转的原始画布，让「重置」能真的退回去
  const origRef = React.useRef<HTMLCanvasElement | null>(null)
  const boxRef = React.useRef<HTMLDivElement | null>(null)
  const dragging = React.useRef(false)

  const publish = React.useCallback(() => {
    const c = workRef.current
    if (!c) return
    setSize({ w: c.width, h: c.height })
    c.toBlob((b) => {
      if (!b) return
      setSrcUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return URL.createObjectURL(b)
      })
    }, "image/png")
  }, [])

  const handleFiles = async (files: File[]) => {
    const f = files[0]
    if (!f) return
    try {
      const img = await loadImageFile(f)
      const { canvas, ctx } = createCanvas(img.naturalWidth, img.naturalHeight)
      ctx.drawImage(img, 0, 0)
      workRef.current = canvas
      origRef.current = canvas
      setFileName(f.name)
      setSel(FULL)
      setAngle(0)
      setError(null)
      publish()
    } catch (e) {
      setError(e instanceof Error ? e.message : "图片打开失败")
    }
  }

  /** 以画布中心旋转任意角度，画布尺寸随之扩大，保证四角不被切掉 */
  const rotateBy = (deg: number) => {
    const c = workRef.current
    if (!c) return
    const rad = (deg * Math.PI) / 180
    const cos = Math.abs(Math.cos(rad))
    const sin = Math.abs(Math.sin(rad))
    const w = Math.round(c.width * cos + c.height * sin)
    const h = Math.round(c.width * sin + c.height * cos)
    const { canvas, ctx } = createCanvas(w, h)
    ctx.translate(w / 2, h / 2)
    ctx.rotate(rad)
    ctx.drawImage(c, -c.width / 2, -c.height / 2)
    workRef.current = canvas
    setSel(FULL)
    publish()
  }

  const flip = (dir: "h" | "v") => {
    const c = workRef.current
    if (!c) return
    const { canvas, ctx } = createCanvas(c.width, c.height)
    ctx.translate(dir === "h" ? c.width : 0, dir === "v" ? c.height : 0)
    ctx.scale(dir === "h" ? -1 : 1, dir === "v" ? -1 : 1)
    ctx.drawImage(c, 0, 0)
    workRef.current = canvas
    publish()
  }

  const pointFromEvent = (e: React.PointerEvent) => {
    const box = boxRef.current
    if (!box) return null
    const r = box.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    const p = pointFromEvent(e)
    if (!p) return
    dragging.current = true
    boxRef.current?.setPointerCapture(e.pointerId)
    setSel({ x: p.x, y: p.y, w: 0, h: 0 })
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return
    const p = pointFromEvent(e)
    if (!p) return
    setSel((s) => ({
      ...s,
      w: p.x - s.x,
      h: p.y - s.y,
    }))
  }

  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragging.current) return
    dragging.current = false
    boxRef.current?.releasePointerCapture(e.pointerId)
    setSel((s) => {
      // 把可能为负的宽高（从右下往左上拖）规整成正常矩形，并保证有最小面积
      const x = s.w < 0 ? s.x + s.w : s.x
      const y = s.h < 0 ? s.y + s.h : s.y
      const w = Math.abs(s.w)
      const h = Math.abs(s.h)
      if (w < 0.02 || h < 0.02) return FULL
      return { x, y, w, h }
    })
  }

  const crop = async () => {
    const c = workRef.current
    if (!c) return
    setBusy(true)
    try {
      const sx = Math.round(sel.x * c.width)
      const sy = Math.round(sel.y * c.height)
      const sw = Math.max(1, Math.round(sel.w * c.width))
      const sh = Math.max(1, Math.round(sel.h * c.height))
      const { canvas, ctx } = createCanvas(sw, sh)
      ctx.drawImage(c, sx, sy, sw, sh, 0, 0, sw, sh)
      const blob = await canvasToBlob(canvas, "image/png")
      downloadBlob(blob, `${baseName(fileName || "image")}-cropped.png`)
    } catch (e) {
      setError(e instanceof Error ? e.message : "裁剪失败")
    } finally {
      setBusy(false)
    }
  }

  const outW = Math.max(1, Math.round(sel.w * size.w))
  const outH = Math.max(1, Math.round(sel.h * size.h))

  return (
    <ToolShell
      title="裁剪旋转翻转"
      description="在图上按住拖动框出要保留的区域，也可以先把图片摆正再裁。"
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <ToolSection title="图片">
          {!srcUrl ? (
            <FileDrop accept="image/*" onFiles={(f) => void handleFiles(f)} />
          ) : (
            <div className="space-y-3">
              <div
                ref={boxRef}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                className="relative w-full touch-none select-none overflow-hidden rounded-lg border bg-muted/30"
              >
                <img src={srcUrl} alt="待裁剪" className="block w-full" draggable={false} />
                <div
                  className="absolute border-2 border-primary"
                  style={{
                    left: `${(sel.w < 0 ? sel.x + sel.w : sel.x) * 100}%`,
                    top: `${(sel.h < 0 ? sel.y + sel.h : sel.y) * 100}%`,
                    width: `${Math.abs(sel.w) * 100}%`,
                    height: `${Math.abs(sel.h) * 100}%`,
                    boxShadow: "0 0 0 9999px rgba(0,0,0,0.45)",
                  }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                原图 {size.w} × {size.h} · 选区 {outW} × {outH}（按住拖动可重新框选）
              </p>
            </div>
          )}
        </ToolSection>

        <ToolSection title="调整">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">旋转与翻转</Label>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" size="sm" disabled={!srcUrl} onClick={() => rotateBy(-90)}>
                  <RotateCcw className="h-4 w-4" />
                  左转 90°
                </Button>
                <Button variant="outline" size="sm" disabled={!srcUrl} onClick={() => rotateBy(90)}>
                  <RotateCw className="h-4 w-4" />
                  右转 90°
                </Button>
                <Button variant="outline" size="sm" disabled={!srcUrl} onClick={() => flip("h")}>
                  <FlipHorizontal className="h-4 w-4" />
                  水平翻转
                </Button>
                <Button variant="outline" size="sm" disabled={!srcUrl} onClick={() => flip("v")}>
                  <FlipVertical className="h-4 w-4" />
                  垂直翻转
                </Button>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">微调角度 {angle}°</Label>
              <input
                type="range"
                min={-45}
                max={45}
                value={angle}
                disabled={!srcUrl}
                onChange={(e) => setAngle(Number(e.target.value))}
                className="w-full accent-primary"
              />
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                disabled={!srcUrl || angle === 0}
                onClick={() => {
                  rotateBy(angle)
                  setAngle(0)
                }}
              >
                应用这个角度
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" size="sm" disabled={!srcUrl} onClick={() => setSel(FULL)}>
                全选
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!srcUrl}
                onClick={() => {
                  if (origRef.current) workRef.current = origRef.current
                  setSel(FULL)
                  setAngle(0)
                  publish()
                }}
              >
                重置
              </Button>
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}

            <Button className="w-full" disabled={!srcUrl || busy} onClick={() => void crop()}>
              <Download className="h-4 w-4" />
              {busy ? "处理中…" : "裁剪并下载"}
            </Button>
          </div>
        </ToolSection>
      </div>
    </ToolShell>
  )
}
