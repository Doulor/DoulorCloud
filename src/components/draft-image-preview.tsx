import * as React from "react"
import { cn } from "@/lib/utils"

/**
 * 草稿里的图片/表情包实时预览（用户反馈：表情包在发送前显示成一串 `![](...)` 字符）。
 *
 * 输入框底层仍是文本（发送时原样以 Markdown 提交），这里只是把正文里出现的
 * `![](url)` 图片抽出来，在输入框旁边/上方渲染成小缩略图，让用户在发送前
 * 就能看到真实图片，而不是一串字符。上传的图片、表情包都能识别。
 */
const IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g

function extractImageUrls(text: string): string[] {
  const out: string[] = []
  let m: RegExpExecArray | null
  IMAGE_RE.lastIndex = 0
  while ((m = IMAGE_RE.exec(text)) !== null) {
    if (m[1] && !out.includes(m[1])) out.push(m[1])
  }
  return out
}

export function DraftImagePreview({
  text,
  className,
}: {
  text: string
  className?: string
}) {
  const urls = React.useMemo(() => extractImageUrls(text), [text])
  if (urls.length === 0) return null
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {urls.map((u, i) => (
        <img
          key={`${i}-${u}`}
          src={u}
          alt=""
          className="h-12 w-12 rounded-md border object-cover"
        />
      ))}
    </div>
  )
}
