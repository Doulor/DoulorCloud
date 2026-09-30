import * as React from "react"
import { ImagePlus, X, Loader2 } from "lucide-react"
import { toast } from "sonner"

import { compressImage } from "@/lib/image-compress"
import { useT } from "@/i18n"

export const MAX_FEEDBACK_IMAGES = 9

export interface PickedImage {
  file: File
  preview: string
}

/**
 * 管理「待上传图片」的状态：选择、压缩、预览、删除、清空。
 *
 * 选择后先在前端压缩成 WebP、用 blob URL 预览，真正上传（拿 R2 key）由调用方
 * 在「提交反馈 / 发送回复」时逐张进行 —— 与社区发帖「先建后传」不同，反馈要在
 * 提交动作里才落库，图片 key 不依赖反馈 id。
 */
export function usePickedImages() {
  const { t } = useT()
  const [images, setImages] = React.useState<PickedImage[]>([])
  const [compressing, setCompressing] = React.useState(false)
  const fileRef = React.useRef<HTMLInputElement>(null)

  // 卸载时释放预览 URL，避免内存泄漏
  React.useEffect(() => {
    return () => {
      for (const img of images) URL.revokeObjectURL(img.preview)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pick = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    const room = MAX_FEEDBACK_IMAGES - images.length
    if (room <= 0) {
      toast.error(t("feedback.maxImages", { n: MAX_FEEDBACK_IMAGES }))
      return
    }
    const list = Array.from(files).slice(0, room)
    setCompressing(true)
    try {
      const added: PickedImage[] = []
      for (const f of list) {
        if (!f.type.startsWith("image/")) continue
        const compressed = await compressImage(f)
        added.push({ file: compressed, preview: URL.createObjectURL(compressed) })
      }
      setImages((prev) => [...prev, ...added])
    } catch {
      toast.error(t("feedback.processFailed"))
    } finally {
      setCompressing(false)
      if (fileRef.current) fileRef.current.value = ""
    }
  }

  const remove = (idx: number) => {
    setImages((prev) => {
      const target = prev[idx]
      if (target) URL.revokeObjectURL(target.preview)
      return prev.filter((_, i) => i !== idx)
    })
  }

  const reset = () => {
    for (const img of images) URL.revokeObjectURL(img.preview)
    setImages([])
  }

  return { images, compressing, pick, remove, reset, fileRef }
}

/**
 * 图片选择按钮 + 缩略图预览 + 删除。
 * 受控组件：images/compressing 来自 usePickedImages，onPick/onRemove 透传。
 */
export function ImagePickerField({
  images,
  compressing,
  onPick,
  onRemove,
  fileRef,
}: {
  images: PickedImage[]
  compressing: boolean
  onPick: (files: FileList | null) => void
  onRemove: (idx: number) => void
  fileRef: React.RefObject<HTMLInputElement | null>
}) {
  const { t } = useT()
  return (
    <div>
      {images.length > 0 && (
        <div className="mb-2 grid grid-cols-3 gap-1.5 sm:grid-cols-4">
          {images.map((img, i) => (
            <div
              key={img.preview}
              className="group relative aspect-square overflow-hidden rounded-lg border"
            >
              <img src={img.preview} alt="" className="h-full w-full object-cover" />
              <button
                type="button"
                onClick={() => onRemove(i)}
                className="absolute right-1 top-1 rounded-full bg-black/60 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100"
                aria-label={t("feedback.removeImage")}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          {compressing && (
            <div className="flex aspect-square items-center justify-center rounded-lg border border-dashed">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        multiple
        className="hidden"
        onChange={(e) => onPick(e.target.files)}
      />

      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={compressing || images.length >= MAX_FEEDBACK_IMAGES}
        className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        title={t("feedback.addImageTitle", { n: MAX_FEEDBACK_IMAGES })}
      >
        <ImagePlus className="h-4 w-4" />
        {t("feedback.addImage")}
        {images.length > 0 && (
          <span className="tabular-nums">
            {images.length}/{MAX_FEEDBACK_IMAGES}
          </span>
        )}
      </button>
    </div>
  )
}

/**
 * 九宫格展示已上传图片（URL 数组），点击放大预览、ESC 关闭。
 * 1 张大图，2-4 张两列，5+ 张三列。
 */
export function ImageGallery({ images }: { images: string[] }) {
  const { t } = useT()
  const [preview, setPreview] = React.useState<number | null>(null)
  const closeRef = React.useRef<HTMLButtonElement>(null)

  React.useEffect(() => {
    if (preview === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPreview(null)
    }
    document.addEventListener("keydown", onKey)
    closeRef.current?.focus()
    return () => document.removeEventListener("keydown", onKey)
  }, [preview])

  if (images.length === 0) return null

  const cols =
    images.length === 1 ? "grid-cols-1" : images.length <= 4 ? "grid-cols-2" : "grid-cols-3"

  const current = preview === null ? null : images[preview]

  return (
    <>
      <div className={"mt-2 grid gap-1.5 " + cols}>
        {images.map((src, i) => (
          <button
            key={src}
            type="button"
            onClick={() => setPreview(i)}
            aria-label={t("feedback.viewImage", { n: i + 1 })}
            className={"group overflow-hidden rounded-lg border " + (images.length === 1 ? "" : "aspect-square")}
          >
            <img
              src={src}
              alt={t("feedback.imageAlt", { n: i + 1 })}
              loading="lazy"
              decoding="async"
              className={
                "h-full w-full object-cover transition-transform group-hover:scale-[1.02] " +
                (images.length === 1 ? "max-h-80 object-contain" : "")
              }
            />
          </button>
        ))}
      </div>
      {current && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("feedback.preview")}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setPreview(null)}
        >
          <img
            src={current}
            alt={t("feedback.imageNAlt", { n: (preview ?? 0) + 1 })}
            className="max-h-full max-w-full rounded-lg object-contain"
          />
          <button
            ref={closeRef}
            type="button"
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
            onClick={() => setPreview(null)}
            aria-label={t("feedback.closePreview")}
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
      )}
    </>
  )
}
