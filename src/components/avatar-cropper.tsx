import * as React from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { useT } from "@/i18n"

/**
 * 头像裁剪器：把任意比例的原图裁成正方形，避免非方形头像被 object-cover 拉伸变形。
 *
 * 交互：显示一张铺满的原图，上面叠一个可拖拽的正方形裁剪框，
 * 底部滑块调整裁剪框大小。确定后用 canvas 裁出正方形 Blob 回调给调用方。
 * 不引入第三方裁剪库 —— 需求就一个「裁成正方形」，自己用 canvas 画足够。
 */

interface CropperState {
  /** 原图显示区的尺寸（CSS 像素，已按容器缩放） */
  displayW: number
  displayH: number
  /** 裁剪框边长（CSS 像素） */
  size: number
  /** 裁剪框左上角（CSS 像素） */
  x: number
  y: number
}

export interface AvatarCropResult {
  blob: Blob
  /** 保持原图格式（png/jpeg/webp）；gif 会退化成 png 静态首帧 */
  type: string
}

export function AvatarCropper({
  file,
  onCancel,
  onConfirm,
}: {
  file: File
  onCancel: () => void
  onConfirm: (result: AvatarCropResult) => void
}) {
  const { t } = useT()
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const imgRef = React.useRef<HTMLImageElement | null>(null)
  const [natural, setNatural] = React.useState<{ w: number; h: number } | null>(null)
  const [state, setState] = React.useState<CropperState | null>(null)
  const [dragging, setDragging] = React.useState(false)
  const dragStart = React.useRef<{ px: number; py: number; ox: number; oy: number } | null>(null)
  const [busy, setBusy] = React.useState(false)

  const DISPLAY_MAX = 360 // 显示区最大宽度（CSS px）

  // 载入图片
  React.useEffect(() => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      imgRef.current = img
      const nw = img.naturalWidth
      const nh = img.naturalHeight
      setNatural({ w: nw, h: nh })
      // 显示区按最长边缩放到 DISPLAY_MAX
      const scale = Math.min(1, DISPLAY_MAX / Math.max(nw, nh))
      const dw = Math.round(nw * scale)
      const dh = Math.round(nh * scale)
      // 初始裁剪框：以短边为边长，居中
      const size = Math.min(dw, dh)
      setState({
        displayW: dw,
        displayH: dh,
        size,
        x: Math.round((dw - size) / 2),
        y: Math.round((dh - size) / 2),
      })
    }
    img.src = url
    return () => URL.revokeObjectURL(url)
  }, [file])

  // 绘制（原图 + 遮罩 + 裁剪框）
  React.useEffect(() => {
    if (!state || !imgRef.current) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const { displayW, displayH, size, x, y } = state
    canvas.width = displayW
    canvas.height = displayH
    // 原图
    ctx.drawImage(imgRef.current, 0, 0, displayW, displayH)
    // 半透明遮罩（裁剪框外变暗）
    ctx.fillStyle = "rgba(0,0,0,0.5)"
    ctx.fillRect(0, 0, displayW, displayH)
    // 裁剪框区域擦亮
    ctx.save()
    ctx.beginPath()
    ctx.rect(x, y, size, size)
    ctx.clip()
    ctx.drawImage(imgRef.current, 0, 0, displayW, displayH)
    ctx.restore()
    // 裁剪框描边
    ctx.strokeStyle = "#fff"
    ctx.lineWidth = 2
    ctx.strokeRect(x, y, size, size)
    // 九宫格参考线
    ctx.strokeStyle = "rgba(255,255,255,0.6)"
    ctx.lineWidth = 1
    for (let i = 1; i < 3; i++) {
      const lx = x + (size * i) / 3
      const ly = y + (size * i) / 3
      ctx.beginPath()
      ctx.moveTo(lx, y)
      ctx.lineTo(lx, y + size)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(x, ly)
      ctx.lineTo(x + size, ly)
      ctx.stroke()
    }
  }, [state])

  const clampState = (s: CropperState): CropperState => {
    const size = Math.max(40, Math.min(s.size, s.displayW, s.displayH))
    const x = Math.max(0, Math.min(s.x, s.displayW - size))
    const y = Math.max(0, Math.min(s.y, s.displayH - size))
    return { ...s, size, x, y }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!state) return
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    // 只有点在裁剪框内才拖拽
    if (px >= state.x && px <= state.x + state.size && py >= state.y && py <= state.y + state.size) {
      setDragging(true)
      dragStart.current = { px, py, ox: state.x, oy: state.y }
      ;(e.target as HTMLCanvasElement).setPointerCapture(e.pointerId)
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragging || !dragStart.current || !state) return
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    const dx = px - dragStart.current.px
    const dy = py - dragStart.current.py
    setState(clampState({ ...state, x: dragStart.current.ox + dx, y: dragStart.current.oy + dy }))
  }

  const onPointerUp = () => {
    setDragging(false)
    dragStart.current = null
  }

  const doConfirm = async () => {
    if (!state || !imgRef.current) return
    setBusy(true)
    try {
      // 显示区 → 原图像素的比例
      const sx = (state.x / state.displayW) * imgRef.current.naturalWidth
      const sy = (state.y / state.displayH) * imgRef.current.naturalHeight
      const ss = (state.size / state.displayW) * imgRef.current.naturalWidth
      const out = document.createElement("canvas")
      out.width = Math.round(ss)
      out.height = Math.round(ss)
      const octx = out.getContext("2d")
      if (!octx) throw new Error("canvas unavailable")
      octx.drawImage(imgRef.current, sx, sy, ss, ss, 0, 0, out.width, out.height)

      // GIF 不能可靠编码，退化成 png
      const mime = file.type === "image/gif" ? "image/png" : file.type
      const blob = await new Promise<Blob>((resolve, reject) => {
        out.toBlob((b) => (b ? resolve(b) : reject(new Error("crop failed"))), mime, 0.92)
      })
      onConfirm({ blob, type: mime })
    } catch (err) {
      onCancel()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("crop.title")}</DialogTitle>
          <DialogDescription>{t("crop.desc")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-3">
          {!state || !natural ? (
            <div className="flex h-64 w-64 items-center justify-center text-sm text-muted-foreground">
              {t("common.loading")}
            </div>
          ) : (
            <canvas
              ref={canvasRef}
              style={{ touchAction: "none", cursor: dragging ? "grabbing" : "grab" }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              className="max-w-full rounded-md border"
            />
          )}

          <div className="flex w-full items-center gap-3">
            <Label className="shrink-0 text-xs text-muted-foreground">{t("crop.range")}</Label>
            {/* ⚠️ 滑块**不能**用 Input 组件：它给文本框设计的 px-3 内边距会把原生
                range 的轨道两端各挤进去一段，滑块永远到不了进度条两边
                （2026-10-01 用户反馈「拉不满」，纯渲染问题、功能本身没坏）。
                项目里其它滑块（profile.tsx / audio-trim）都用原生 input + accent 色。 */}
            <input
              type="range"
              min={40}
              max={state ? Math.min(state.displayW, state.displayH) : 100}
              value={state?.size ?? 100}
              onChange={(e) =>
                state &&
                setState(
                  clampState({
                    ...state,
                    size: Number(e.target.value),
                    x: state.x + (state.size - Number(e.target.value)) / 2,
                    y: state.y + (state.size - Number(e.target.value)) / 2,
                  })
                )
              }
              className="w-full flex-1 cursor-pointer accent-primary"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button onClick={doConfirm} disabled={busy || !state}>
            {busy ? t("crop.processing") : t("common.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
