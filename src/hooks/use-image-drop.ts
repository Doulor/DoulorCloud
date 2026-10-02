/**
 * 给输入框加「拖入图片 / 粘贴图片」的能力 —— 私聊、聊天室、广场、反馈共用。
 *
 * ── 用法 ──
 * ```tsx
 * const { dragging, uploading, dropProps } = useImageDrop({ onImage: insert })
 * <div {...dropProps} className={cn("relative", dragging && "ring-2 ring-primary")}>
 *   <Input ... />
 * </div>
 * ```
 *
 * ⚠️ `dropProps` 要摊在**包住输入框的那层容器**上，不能直接给 `<input>`：
 * 浏览器的默认行为会让 input 自己接管拖拽，事件到不了我们的处理函数。
 *
 * ── 为什么同时管粘贴 ──
 * 用户截图后最自然的动作就是 Ctrl+V，而截图在剪贴板里是**文件**不是文本。
 * 不拦下来的话，粘贴会变成一串乱码或什么都不发生 —— 这正是「拖入图片」
 * 同一件事的另一种入口，一起做掉才完整。
 */
import * as React from "react"
import { chatUploadApi, errMsg } from "@/services/api"
import { toast } from "sonner"
import { useT } from "@/i18n"

/** 与后端一致：单张 5MB */
const MAX_BYTES = 5 * 1024 * 1024
const OK_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"]

export function useImageDrop(options: {
  /**
   * 上传成功后的回调，参数是可直接放进 markdown 的图片 URL。
   * 与 `onFiles` 二选一 —— 传了这个就走「自动上传 + 插 markdown」的默认流程。
   */
  onImage?: (url: string) => void
  /**
   * 只把拖进来/粘贴进来的图片文件原样交出去，由调用方自己处理。
   *
   * 给反馈页这种场景用：它已经有自己的压缩 + 上传流程（`usePickedImages`），
   * 再走一遍默认流程等于上传两次。
   */
  onFiles?: (files: File[]) => void
  /**
   * 关掉内置的粘贴处理。
   * 反馈页的 Textarea 自己已经处理了粘贴（把图收进它的待上传列表），
   * 两边都接会**重复上传**，所以那边只借拖拽。
   */
  noPaste?: boolean
  /** 禁用（例如未登录、聊天室已关闭） */
  disabled?: boolean
}) {
  const { onImage, onFiles, noPaste, disabled } = options
  const { t } = useT()
  const [dragging, setDragging] = React.useState(false)
  const [uploading, setUploading] = React.useState(false)

  /** 逐个上传，返回成功的 URL 列表 */
  const uploadFiles = React.useCallback(
    async (files: File[]) => {
      const images = files.filter((f) => OK_TYPES.includes(f.type))
      if (images.length === 0) return
      // 走自定义流程时，大小校验交给调用方（它可能自己会压缩）
      if (onFiles) {
        onFiles(images)
        return
      }
      if (!onImage) return
      const tooBig = images.find((f) => f.size > MAX_BYTES)
      if (tooBig) {
        toast.error(t("img.tooLarge", { mb: Math.round(MAX_BYTES / 1024 / 1024) }))
        return
      }
      setUploading(true)
      try {
        // 串行而不是 Promise.all：一次拖 5 张时并发上传容易撞到服务端限流
        for (const file of images) {
          try {
            const res = await chatUploadApi.upload(file)
            onImage(`![](${res.url})`)
          } catch (err) {
            toast.error(errMsg(err, t("img.uploadFailed")))
          }
        }
      } finally {
        setUploading(false)
      }
    },
    [onImage, onFiles, t]
  )

  /** 拖拽过程中进出子元素会反复触发 dragleave，用计数器避免闪烁 */
  const dragDepth = React.useRef(0)

  const dropProps = {
    onDragEnter: (e: React.DragEvent) => {
      if (disabled) return
      // 只有真的拖着文件才显示高亮，避免拖选文字时也亮
      if (!e.dataTransfer?.types?.includes("Files")) return
      e.preventDefault()
      dragDepth.current += 1
      setDragging(true)
    },
    onDragOver: (e: React.DragEvent) => {
      if (disabled) return
      if (!e.dataTransfer?.types?.includes("Files")) return
      // 必须 preventDefault，否则浏览器会直接打开这张图、离开当前页面
      e.preventDefault()
      e.dataTransfer.dropEffect = "copy"
    },
    onDragLeave: () => {
      if (disabled) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragging(false)
    },
    onDrop: (e: React.DragEvent) => {
      if (disabled) return
      e.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length) void uploadFiles(files)
    },
    onPaste: (e: React.ClipboardEvent) => {
      if (disabled || noPaste) return
      // 剪贴板里的图片以「文件」形式出现；纯文本粘贴不该被拦
      const files = Array.from(e.clipboardData?.files ?? [])
      if (files.length === 0) return
      e.preventDefault()
      void uploadFiles(files)
    },
  }

  return { dragging, uploading, dropProps }
}
