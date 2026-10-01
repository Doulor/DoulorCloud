import * as React from "react"
import { ArrowDown, ArrowUp, Download, X } from "lucide-react"

import { FileDrop } from "@/components/toolbox/file-drop"
import { ToolShell, ToolSection } from "@/components/toolbox/tool-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { canvasToBlob, createCanvas, downloadBlob, loadImageFile } from "@/lib/toolbox/utils"
import { useT } from "@/i18n"

interface Item {
  id: string
  name: string
  url: string
  img: HTMLImageElement
}

type Dir = "v" | "h"

export default function ImageStitchTool() {
  const { t } = useT()
  const [items, setItems] = React.useState<Item[]>([])
  const [dir, setDir] = React.useState<Dir>("v")
  const [gap, setGap] = React.useState(0)
  const [bg, setBg] = React.useState("#ffffff")
  const [unify, setUnify] = React.useState(true)
  const [format, setFormat] = React.useState<"png" | "jpeg">("png")
  const [preview, setPreview] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const add = async (files: File[]) => {
    try {
      const loaded: Item[] = []
      for (const f of files) {
        const img = await loadImageFile(f)
        loaded.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: f.name,
          url: URL.createObjectURL(f),
          img,
        })
      }
      setItems((prev) => [...prev, ...loaded])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : t("is.err.open"))
    }
  }

  const remove = (id: string) => {
    setItems((prev) => {
      const target = prev.find((x) => x.id === id)
      if (target) URL.revokeObjectURL(target.url)
      return prev.filter((x) => x.id !== id)
    })
  }

  const move = (index: number, delta: number) => {
    setItems((prev) => {
      const next = [...prev]
      const j = index + delta
      if (j < 0 || j >= next.length) return prev
      ;[next[index], next[j]] = [next[j], next[index]]
      return next
    })
  }

  /** 计算排版：返回画布尺寸与每张图的落点，预览与导出共用 */
  const layout = React.useCallback(
    (scale: number) => {
      const n = items.length
      if (n === 0) return null
      const g = gap * scale

      if (dir === "v") {
        const targetW = unify
          ? Math.max(...items.map((it) => it.img.naturalWidth))
          : Math.max(...items.map((it) => it.img.naturalWidth))
        const boxes = items.map((it) => {
          const w = unify ? targetW : it.img.naturalWidth
          const h = Math.round((it.img.naturalHeight / it.img.naturalWidth) * w)
          return { w, h }
        })
        const W = targetW
        const H = boxes.reduce((s, b) => s + b.h, 0) + g * (n - 1)
        return { W, H, boxes, g }
      }

      const targetH = Math.max(...items.map((it) => it.img.naturalHeight))
      const boxes = items.map((it) => {
        const h = unify ? targetH : it.img.naturalHeight
        const w = Math.round((it.img.naturalWidth / it.img.naturalHeight) * h)
        return { w, h }
      })
      const H = targetH
      const W = boxes.reduce((s, b) => s + b.w, 0) + g * (n - 1)
      return { W, H, boxes, g }
    },
    [items, dir, gap, unify]
  )

  const draw = React.useCallback(
    (scale: number) => {
      const lay = layout(scale)
      if (!lay) return null
      const { W, H, boxes, g } = lay
      const { canvas, ctx } = createCanvas(Math.round(W * scale), Math.round(H * scale))
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, canvas.width, canvas.height)

      let cursor = 0
      items.forEach((it, i) => {
        const b = boxes[i]
        const w = b.w * scale
        const h = b.h * scale
        if (dir === "v") {
          const x = unify ? 0 : (canvas.width - w) / 2
          ctx.drawImage(it.img, x, cursor, w, h)
          cursor += h + g
        } else {
          const y = unify ? 0 : (canvas.height - h) / 2
          ctx.drawImage(it.img, cursor, y, w, h)
          cursor += w + g
        }
      })
      return canvas
    },
    [layout, items, dir, unify, bg]
  )

  React.useEffect(() => {
    if (items.length === 0) {
      setPreview((p) => {
        if (p) URL.revokeObjectURL(p)
        return null
      })
      return
    }
    const lay = layout(1)
    if (!lay) return
    const maxDim = 1400
    const scale = Math.min(1, maxDim / Math.max(lay.W, lay.H))
    const timer = window.setTimeout(() => {
      const canvas = draw(scale)
      if (!canvas) return
      canvas.toBlob((b) => {
        if (!b) return
        setPreview((p) => {
          if (p) URL.revokeObjectURL(p)
          return URL.createObjectURL(b)
        })
      }, "image/png")
    }, 150)
    return () => window.clearTimeout(timer)
  }, [items, layout, draw])

  const download = async () => {
    setBusy(true)
    try {
      const canvas = draw(1)
      if (!canvas) return
      const blob = await canvasToBlob(
        canvas,
        format === "png" ? "image/png" : "image/jpeg",
        format === "jpeg" ? 0.92 : undefined
      )
      downloadBlob(blob, t("is.fileName", { ts: Date.now(), ext: format === "png" ? "png" : "jpg" }))
    } catch (e) {
      setError(e instanceof Error ? e.message : t("is.err.export"))
    } finally {
      setBusy(false)
    }
  }

  const lay = items.length > 0 ? layout(1) : null

  return (
    <ToolShell
      title={t("toolbox.imageStitch.name")}
      description={t("is.desc")}
      wide
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <ToolSection title={t("is.listTitle", { n: items.length })}>
          <FileDrop
            accept="image/*"
            multiple
            onFiles={(f) => void add(f)}
            label={t("is.pickLabel")}
            hint={t("is.pickHint")}
            className="py-6"
          />

          {items.length > 0 && (
            <ul className="mt-4 space-y-2">
              {items.map((it, i) => (
                <li key={it.id} className="flex items-center gap-3 rounded-lg border p-2">
                  <img
                    src={it.url}
                    alt={it.name}
                    className="h-12 w-12 shrink-0 rounded object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{it.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {it.img.naturalWidth} × {it.img.naturalHeight}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label={t("ip.moveUp")}
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label={t("ip.moveDown")}
                    disabled={i === items.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    aria-label={t("common.delete")}
                    onClick={() => remove(it.id)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {preview && (
            <div className="mt-4 space-y-2 border-t pt-4">
              <p className="text-xs text-muted-foreground">
                {t("is.previewHint")}
              </p>
              <div className="flex justify-center overflow-hidden rounded-lg border bg-muted/30 p-2">
                <img src={preview} alt={t("is.alt.preview")} className="h-auto max-h-[520px] w-auto max-w-full" />
              </div>
            </div>
          )}
        </ToolSection>

        <ToolSection title={t("is.section.settings")}>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t("is.direction")}</Label>
              <Select value={dir} onValueChange={(v) => setDir(v as Dir)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="v">{t("is.dir.vertical")}</SelectItem>
                  <SelectItem value="h">{t("is.dir.horizontal")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t("is.gap", { n: gap })}</Label>
              <input
                type="range"
                min={0}
                max={60}
                value={gap}
                onChange={(e) => setGap(Number(e.target.value))}
                className="w-full accent-primary"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t("is.gapColor")}</Label>
              <Input type="color" value={bg} onChange={(e) => setBg(e.target.value)} className="h-9 p-1" />
            </div>

            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={unify}
                onChange={(e) => setUnify(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-primary"
              />
              <span>
                {t("is.unify")}
                <span className="block text-xs text-muted-foreground">
                  {t("is.unifyHint")}
                </span>
              </span>
            </label>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t("is.outFormat")}</Label>
              <Select value={format} onValueChange={(v) => setFormat(v as "png" | "jpeg")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="png">{t("is.fmt.png")}</SelectItem>
                  <SelectItem value="jpeg">{t("is.fmt.jpeg")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {lay && (
              <p className="text-xs text-muted-foreground">
                {t("is.resultSize", { w: Math.round(lay.W), h: Math.round(lay.H) })}
              </p>
            )}
            {error && <p className="text-xs text-destructive">{error}</p>}

            <Button className="w-full" disabled={items.length === 0 || busy} onClick={() => void download()}>
              <Download className="h-4 w-4" />
              {busy ? t("is.exporting") : t("is.download")}
            </Button>
          </div>
        </ToolSection>
      </div>
    </ToolShell>
  )
}
