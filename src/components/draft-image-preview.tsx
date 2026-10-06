import * as React from "react"
import { createPortal } from "react-dom"
import { X } from "lucide-react"

import { useT } from "@/i18n"
import { removeImageFromBody } from "@/lib/chat-fluent"
import { cn } from "@/lib/utils"

/**
 * 草稿里的图片 / 表情包实时预览（站长反馈：表情包发送前只看到一串 `![](...)`）。
 *
 * 输入框底层仍然是纯文本（发送时原样以 Markdown 提交，数据层不变），
 * 这里把正文里出现的 `![](url)` 抽出来，在输入框上方渲染成真实缩略图 ——
 * 发送前就能看到「发出去长什么样」，而不是一串字符。
 * 上传的图片与站内表情包都走同一条路径，无需区分。
 *
 * 交互（2026-10-05 增强）：
 *   · 点缩略图 → 全屏放大看原图（与消息气泡里的表情包同一套观感）；
 *   · 右上角 × → 从草稿里删掉这张图（不用回到文本里手动删那一长串 markdown）。
 */
const IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g

/** 抽出草稿里所有图片地址（去重：同一个表情包插两次只显示一张缩略图） */
function extractImageUrls(text: string): string[] {
  const out: string[] = []
  const re = new RegExp(IMAGE_RE.source, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m[1] && !out.includes(m[1])) out.push(m[1])
  }
  return out
}

export function DraftImagePreview({
  text,
  onRemove,
  setText,
  className,
}: {
  text: string
  /** 需要额外副作用（例如草稿落盘）时用：回调收到图片地址 */
  onRemove?: (url: string) => void
  /** 最省事的接法：把输入框的 setState 直接传进来，组件内部完成删除 */
  setText?: React.Dispatch<React.SetStateAction<string>>
  className?: string
}) {
  const { t } = useT()
  const urls = React.useMemo(() => extractImageUrls(text), [text])
  const [zoom, setZoom] = React.useState<string | null>(null)
  const removable = Boolean(onRemove || setText)

  if (urls.length === 0) return null

  const remove = (url: string) => {
    if (onRemove) onRemove(url)
    else setText?.((prev) => removeImageFromBody(prev, url))
  }

  return (
    <>
      <div
        className={cn(
          "flex flex-wrap items-center gap-2 rounded-lg border border-dashed bg-muted/40 px-2.5 py-2",
          className
        )}
      >
        <span className="text-[11px] font-medium text-muted-foreground">
          {t("chat.preview.title")}
        </span>
        {urls.map((u) => (
          <div key={u} className="relative">
            <img
              src={u}
              alt=""
              loading="lazy"
              decoding="async"
              onClick={() => setZoom(u)}
              title={t("chat.preview.zoom")}
              className="h-16 w-16 cursor-zoom-in rounded-md border bg-background object-contain"
            />
            {removable && (
              <button
                type="button"
                onClick={() => remove(u)}
                title={t("chat.preview.remove")}
                aria-label={t("chat.preview.remove")}
                className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-destructive hover:text-destructive-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        ))}
      </div>
      {zoom &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/80 p-6"
            onClick={() => setZoom(null)}
          >
            <img src={zoom} alt="" className="max-h-full max-w-full rounded-lg shadow-2xl" />
          </div>,
          document.body
        )}
    </>
  )
}