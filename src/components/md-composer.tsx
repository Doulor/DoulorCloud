import * as React from "react"
import {
  Bold, Italic, Code, List, ListOrdered, Quote, Link as LinkIcon, ImagePlus,
  Loader2, X,
} from "lucide-react"
import { toast } from "sonner"

import { useT } from "@/i18n"
import { cn } from "@/lib/utils"
import {
  surround, applyList, applyCode, insertAtCursor,
  uploadPlaceholder, replacePlaceholder,
  type TextEditResult,
} from "@/lib/md-edit"
import { useImageDrop } from "@/hooks/use-image-drop"
import { useEmojiInsert } from "@/hooks/use-emoji-insert"
import { DraftImagePreview } from "@/components/draft-image-preview"
import { EmojiPicker } from "@/components/emoji-picker"
import { StickerPanel } from "@/components/sticker-panel"
import { chatUploadApi } from "@/services/api"

/**
 * 社区 Markdown 编辑器（发帖 / 编辑帖子共用，2026-10-06）。
 *
 * 交互对标 nodeloc.com（Discourse d-editor，调研结论见 .workbuddy/memory）：
 *   · 底部格式工具栏：B / I / 引用 / 代码 / 列表 / 链接 / 图片 / 表情 / 预览切换，
 *     按钮 onMouseDown preventDefault（点击不夺走 textarea 焦点，Discourse 同款）；
 *   · 上传占位协议：粘贴/拖入图片**立即**在光标处插入 `[上传中: 文件名…]()`
 *     （空链接 markdown，预览渲染为灰色文字），成功后原位替换为 `![](url)`，
 *     失败则移除占位并 toast —— 用户不用干等上传才知道图插没插上；
 *   · 正文里出现的 `![](url)` 实时渲染成缩略图条（DraftImagePreview），
 *     点 × 即从正文删掉这张图；
 *   · 编辑帖子时额外渲染 `post.images`（帖子级图片网格），删除走
 *     DELETE /community/posts/:id/images/:filename（真删 R2）。
 *
 * 组件受控：value/onChange 由父级持有，光标操作通过 ref 拿 textarea。
 */
export function MdComposer({
  value,
  onChange,
  textareaRef,
  placeholder,
  rows = 5,
  minRows,
  autoFocus,
  className,
  onCmdEnter,
  /** 编辑帖子时传入：帖子 id + 帖子级图片列表 + 变更回调（渲染可删除的图片网格） */
  postId,
  postImages,
  onPostImagesChange,
  /** 帖子图片数量上限（与后端 community_post_max_images 一致，默认 9） */
  maxPostImages = 9,
}: {
  value: string
  onChange: (next: string) => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  placeholder?: string
  rows?: number
  minRows?: number
  autoFocus?: boolean
  className?: string
  onCmdEnter?: () => void
  postId?: string
  postImages?: string[]
  onPostImagesChange?: (next: string[]) => void
  maxPostImages?: number
}) {
  const { t } = useT()

  /** 始终指向最新的 value/onChange —— 异步上传回调里要用，闭包里的 props 会过期 */
  const valueRef = React.useRef(value)
  valueRef.current = value
  const onChangeRef = React.useRef(onChange)
  onChangeRef.current = onChange

  /** 把一次纯文本编辑写回 state，并恢复光标（等 React 渲染完后 setSelectionRange） */
  const applyEdit = React.useCallback(
    (r: TextEditResult) => {
      onChange(r.text)
      const ta = textareaRef.current
      if (ta) {
        requestAnimationFrame(() => {
          ta.focus()
          ta.setSelectionRange(r.selectionStart, r.selectionEnd)
        })
      }
    },
    [onChange, textareaRef]
  )

  /** 工具栏动作 → 当前 textarea 选区 + 对应纯函数 */
  const withSelection = (fn: (text: string, s: number, e: number) => TextEditResult) => {
    const ta = textareaRef.current
    const s = ta?.selectionStart ?? value.length
    const e = ta?.selectionEnd ?? value.length
    applyEdit(fn(value, s, e))
  }

  const wrap = (head: string, tail: string, example: string) =>
    withSelection((text, s, e) => surround(text, s, e, head, tail, example))
  const list = (kind: "quote" | "ul" | "ol") =>
    withSelection((text, s, e) => applyList(text, s, e, kind))

  /* ── 上传占位协议 ── */
  /** 进行中的上传：placeholder → { name, percent }。percent=null 表示不确定进度 */
  const [uploads, setUploads] = React.useState<Map<string, { name: string; percent: number | null }>>(new Map())
  const cancelledRef = React.useRef(new Set<string>())
  /** 已占用的占位串（含进行中 + 历史成功/失败），保证同名文件占位不重复 */
  const uploadedPlaceholders = React.useRef(new Set<string>())

  const insertSnippet = React.useCallback(
    (snippet: string) => {
      const ta = textareaRef.current
      const s = ta?.selectionStart ?? value.length
      const e = ta?.selectionEnd ?? value.length
      applyEdit(insertAtCursor(value, s, e, snippet))
    },
    [applyEdit, value, textareaRef]
  )

  /** 上传一张图：先插占位，成功原位替换，失败移除占位（Discourse 协议）。
   *  ⚠️ 全程用函数式 setState 读「最新正文」—— 异步上传期间用户可能继续打字，
   *  闭包里的 value 早已过期（否则会把用户打的字回滚掉）。 */
  const uploadWithPlaceholder = React.useCallback(
    async (file: File) => {
      const placeholder = uploadPlaceholder(file.name, new Set(uploadedPlaceholders.current), t("cm.uploadingWord"))
      uploadedPlaceholders.current.add(placeholder)
      insertSnippet(placeholder + "\n")
      setUploads((m) => new Map(m).set(placeholder, { name: file.name, percent: null }))
      const finish = (replacement: string) => {
        setUploads((m) => {
          const n = new Map(m)
          n.delete(placeholder)
          return n
        })
        uploadedPlaceholders.current.delete(placeholder)
        // 占位原位替换为最终 markdown（成功）或空串（失败/取消）
        onChangeRef.current(replacePlaceholder(valueRef.current, placeholder, replacement))
      }
      try {
        const res = await chatUploadApi.upload(file)
        if (cancelledRef.current.has(placeholder)) return
        finish(`![](${res.url})`)
      } catch {
        finish("")
        toast.error(t("cm.tb.uploadFailed", { name: file.name }))
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [insertSnippet, t]
  )

  /** 拖入/粘贴：立即插占位再串行上传。⚠️ 编辑器有自己独立的管线，不与评论区共享 */
  const pickAndUpload = React.useCallback(
    async (files: File[]) => {
      const room = maxPostImages - (postImages?.length ?? 0)
      const images = files.filter((f) => f.type.startsWith("image/"))
      if (images.length === 0) return
      if (room <= 0) {
        toast.error(t("feedback.maxImages", { n: maxPostImages }))
        return
      }
      for (const f of images.slice(0, room)) {
        // 5MB 上限与 useImageDrop 一致（chat/upload-image 服务端同样限制）
        if (f.size > 5 * 1024 * 1024) {
          toast.error(t("img.tooLarge", { mb: 5 }))
          continue
        }
        await uploadWithPlaceholder(f)
      }
    },
    [maxPostImages, postImages, uploadWithPlaceholder, t]
  )

  const { dragging, dropProps } = useImageDrop({ onFiles: (files) => void pickAndUpload(files) })
  const fileRef = React.useRef<HTMLInputElement>(null)
  const emojiInsert = useEmojiInsert(textareaRef, value, (n) => onChange(typeof n === "string" ? n : n(value)))

  /* 键盘快捷键（Ctrl+B/I/K、Ctrl+Shift+8/7、Ctrl+E），Discourse 同款 */
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (onCmdEnter && (e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault()
      onCmdEnter()
      return
    }
    if (!(e.ctrlKey || e.metaKey)) return
    const k = e.key.toLowerCase()
    if (k === "b") { e.preventDefault(); wrap("**", "**", t("cm.tb.exampleBold")) }
    else if (k === "i") { e.preventDefault(); wrap("*", "*", t("cm.tb.exampleItalic")) }
    else if (k === "k") { e.preventDefault(); setLinkDlg(true) }
    else if (k === "e") { e.preventDefault(); withSelection((text, s, ee) => applyCode(text, s, ee)) }
    else if (e.shiftKey && k === "8") { e.preventDefault(); list("ul") }
    else if (e.shiftKey && k === "7") { e.preventDefault(); list("ol") }
  }

  /* ── 链接插入小弹层 ── */
  const [linkDlg, setLinkDlg] = React.useState(false)
  const [linkUrl, setLinkUrl] = React.useState("")
  const [linkText, setLinkText] = React.useState("")
  const openLinkDlg = () => {
    const ta = textareaRef.current
    const sel = ta && ta.selectionStart !== ta.selectionEnd ? value.slice(ta.selectionStart, ta.selectionEnd) : ""
    setLinkText(sel)
    setLinkUrl("")
    setLinkDlg(true)
  }
  const confirmLink = () => {
    const url = linkUrl.trim()
    if (!url) {
      toast.error(t("cm.tb.linkEmpty"))
      return
    }
    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`
    const label = linkText.trim() || url
    withSelection((text, s, e) => {
      // 有选中文字且与 linkText 一致 → 包裹；否则插入 [label](url)
      const selected = text.slice(s, e)
      const snippet = selected && selected === linkText.trim()
        ? `[${label}](${href})`
        : `[${label}](${href})`
      return insertAtCursor(text, selected ? s : e, selected ? e : e, snippet)
    })
    setLinkDlg(false)
  }

  /* ── 帖子级图片（编辑模式）── */
  const [deleting, setDeleting] = React.useState<string | null>(null)
  const removePostImage = async (url: string) => {
    if (!postId || !onPostImagesChange) return
    const filename = url.split("/").pop() ?? ""
    setDeleting(url)
    try {
      const { deletePostImage } = await import("@/services/api").then((m) => m.communityApi)
      await deletePostImage(postId, filename)
      onPostImagesChange((postImages ?? []).filter((u) => u !== url))
      toast.success(t("cm.ok.imageDeleted"))
    } catch (err) {
      toast.error(t("cm.err.imageDelete"))
    } finally {
      setDeleting(null)
    }
  }

  const toolbarBtn =
    "flex h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"

  return (
    <div
      {...dropProps}
      className={cn(
        "relative rounded-lg border bg-card",
        dragging && "ring-2 ring-primary",
        className
      )}
    >
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        rows={rows}
        autoFocus={autoFocus}
        className="w-full resize-y rounded-t-lg bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground"
        style={minRows ? { minHeight: `${minRows * 1.6}rem` } : undefined}
      />

      {/* 正文图片实时预览：点 × 从正文删除该 markdown 引用 */}
      <div className="px-3">
        <DraftImagePreview text={value} setText={(n) => onChange(typeof n === "string" ? n : n(value))} className="mb-2 border-0 bg-transparent px-0 py-0" />
      </div>

      {/* 帖子级图片网格（编辑模式）：这些图存在 posts.images，删除走后端接口 */}
      {postId && postImages && postImages.length > 0 && (
        <div className="px-3 pb-2">
          <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
            {t("cm.editImages", { n: postImages.length })}
            <span className="ml-2 font-normal opacity-70">{t("cm.editImagesHint")}</span>
          </p>
          <div className="flex flex-wrap gap-2">
            {postImages.map((u) => (
              <div key={u} className="group relative h-16 w-16 overflow-hidden rounded-md border bg-muted/40">
                <img src={u} alt="" className="h-full w-full object-cover" loading="lazy" />
                <button
                  type="button"
                  onClick={() => void removePostImage(u)}
                  disabled={deleting === u}
                  title={t("common.delete")}
                  aria-label={t("common.delete")}
                  className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity hover:bg-destructive group-hover:opacity-100 disabled:opacity-100"
                >
                  {deleting === u ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 上传进度条（Discourse 位置：底部工具栏行内） */}
      {uploads.size > 0 && (
        <div className="flex items-center gap-2 border-t px-3 py-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          {Array.from(uploads.entries()).map(([ph, info]) => (
            <span key={ph} className="flex items-center gap-1.5">
              {info.percent !== null
                ? t("cm.tb.uploading", { name: info.name, percent: `${info.percent}%` })
                : t("cm.tb.uploadingIndet", { name: info.name })}
              <button
                type="button"
                title={t("cm.tb.uploadCancel")}
                aria-label={t("cm.tb.uploadCancel")}
                onClick={() => {
                  cancelledRef.current.add(ph)
                  uploadedPlaceholders.current.delete(ph)
                  setUploads((m) => {
                    const n = new Map(m)
                    n.delete(ph)
                    return n
                  })
                  onChangeRef.current(replacePlaceholder(valueRef.current, ph, ""))
                }}
                className="rounded p-0.5 hover:bg-accent hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* 工具栏（Discourse preventFocus 同款：mousedown preventDefault 不夺焦） */}
      <div className="flex flex-wrap items-center gap-0.5 border-t px-2 py-1.5">
        <button type="button" className={toolbarBtn} title={t("cm.tb.bold")}
          onMouseDown={(e) => e.preventDefault()} onClick={() => wrap("**", "**", t("cm.tb.exampleBold"))}>
          <Bold className="h-4 w-4" />
        </button>
        <button type="button" className={toolbarBtn} title={t("cm.tb.italic")}
          onMouseDown={(e) => e.preventDefault()} onClick={() => wrap("*", "*", t("cm.tb.exampleItalic"))}>
          <Italic className="h-4 w-4" />
        </button>
        <button type="button" className={toolbarBtn} title={t("cm.tb.quote")}
          onMouseDown={(e) => e.preventDefault()} onClick={() => list("quote")}>
          <Quote className="h-4 w-4" />
        </button>
        <button type="button" className={toolbarBtn} title={t("cm.tb.code")}
          onMouseDown={(e) => e.preventDefault()} onClick={() => withSelection((text, s, e) => applyCode(text, s, e, t("cm.tb.exampleCode")))}>
          <Code className="h-4 w-4" />
        </button>
        <button type="button" className={toolbarBtn} title={t("cm.tb.ul")}
          onMouseDown={(e) => e.preventDefault()} onClick={() => list("ul")}>
          <List className="h-4 w-4" />
        </button>
        <button type="button" className={toolbarBtn} title={t("cm.tb.ol")}
          onMouseDown={(e) => e.preventDefault()} onClick={() => list("ol")}>
          <ListOrdered className="h-4 w-4" />
        </button>
        <button type="button" className={toolbarBtn} title={t("cm.tb.link")}
          onMouseDown={(e) => e.preventDefault()} onClick={openLinkDlg}>
          <LinkIcon className="h-4 w-4" />
        </button>
        <button type="button" className={toolbarBtn} title={t("cm.tb.image")}
          onMouseDown={(e) => e.preventDefault()} onClick={() => fileRef.current?.click()}>
          <ImagePlus className="h-4 w-4" />
        </button>
        <EmojiPicker onPick={emojiInsert} />
        <StickerPanel onPick={emojiInsert} />
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length) void pickAndUpload(files)
          e.target.value = ""
        }}
      />

      {/* 链接插入弹层 */}
      {linkDlg && (
        <div className="absolute inset-x-3 top-3 z-20 rounded-lg border bg-popover p-3 shadow-lg">
          <p className="mb-2 text-xs font-medium">{t("cm.tb.linkPrompt")}</p>
          <input
            autoFocus
            value={linkText}
            onChange={(e) => setLinkText(e.target.value)}
            placeholder={t("cm.tb.linkText")}
            className="mb-1.5 w-full rounded-md border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
          />
          <input
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") confirmLink(); if (e.key === "Escape") setLinkDlg(false) }}
            placeholder={t("cm.tb.linkUrl")}
            className="mb-2 w-full rounded-md border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
          />
          <div className="flex justify-end gap-1.5">
            <button type="button" onClick={() => setLinkDlg(false)}
              className="rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
              {t("common.cancel")}
            </button>
            <button type="button" onClick={confirmLink}
              className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90">
              {t("cm.tb.insert")}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
