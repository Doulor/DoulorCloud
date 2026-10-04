/**
 * 「我的表情包」面板 —— 上传自己的图，点一下就插到编辑器光标处。
 *
 * 与 EmojiPicker 的分工：那个是系统 emoji（字符），这个是**用户上传的图片**。
 * 两者并列放在工具栏里，各管各的。
 *
 * ── 缓存分三层，这里负责最上面那层 ──
 *   1. R2 对象：URL 是 `/api/stickers/<uuid>/image`，内容永不变 ⇒ 一年 immutable（服务端设的）；
 *   2. 列表接口：ETag + `private, no-cache`，浏览器自己协商 304（对 fetch 透明）；
 *   3. **本组件的 localStorage**：打开面板**立刻**用本地数据渲染，网络回来再对齐。
 *      没有这层的话，每次展开面板都会先空白一下再「啪」地跳出图来。
 *
 * 上传/删除后**就地更新**列表与缓存，不等下一次拉取 —— 用户点完立刻能看到结果，
 * 也不会因为「先刷新后落库」的时序把刚传的图弄丢。
 */
import * as React from "react"
// ⚠️ 图标叫 Sticker，本项目的数据类型也叫 Sticker —— 必须起别名，否则撞名
import { ImagePlus, Loader2, Smile, Sticker as StickerIcon, X } from "lucide-react"
import { toast } from "sonner"
import { stickerApi, errMsg } from "@/services/api"
import { compressToLimit } from "@/lib/image-compress"
import { AnchoredPanel, isInsideAnchoredPanel } from "@/components/anchored-panel"
import { useT } from "@/i18n"
import type { Sticker } from "@/types"

/** localStorage 键。带版本号，日后结构变了直接换 key，不做迁移 */
const CACHE_KEY = "doulor:stickers:v1"

/** 单张表情包大小上限（与后端 sticker_max_bytes 默认值一致，超了前端会先自动压缩） */
const MAX_BYTES = 1024 * 1024

interface CacheShape {
  stickers: Sticker[]
  version: string
}

function readCache(): CacheShape | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CacheShape
    return Array.isArray(parsed?.stickers) ? parsed : null
  } catch {
    return null
  }
}

function writeCache(stickers: Sticker[]) {
  try {
    const version = `${stickers.length}-${stickers[stickers.length - 1]?.createdAt ?? "0"}`
    localStorage.setItem(CACHE_KEY, JSON.stringify({ stickers, version }))
  } catch {
    // 隐私模式 / 配额满：缓存只是体验优化，失败了不该影响功能
  }
}

export function StickerPanel({ onPick }: { onPick: (markdown: string) => void }) {
  const { t } = useT()
  const [open, setOpen] = React.useState(false)
  // 首帧就用缓存渲染 —— 这是「打开即见」的关键
  const [stickers, setStickers] = React.useState<Sticker[]>(() => readCache()?.stickers ?? [])
  const [uploading, setUploading] = React.useState(false)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const fileRef = React.useRef<HTMLInputElement>(null)
  const boxRef = React.useRef<HTMLDivElement>(null)
  const btnRef = React.useRef<HTMLButtonElement>(null)

  // 点外部关闭。⚠️ 面板由 AnchoredPanel 渲染到 body，不在 boxRef 内，
  // 必须单独放行，否则点面板自身会被判成「点了外部」而立刻关掉
  React.useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (isInsideAnchoredPanel(e.target)) return
      if (boxRef.current && boxRef.current.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [open])

  const refresh = React.useCallback(async () => {
    try {
      const res = await stickerApi.list()
      setStickers(res.stickers)
      writeCache(res.stickers)
    } catch {
      // 静默：缓存里还有旧数据可用，弹错误反而打扰
    }
  }, [])

  React.useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  const pickFile = async (file: File | undefined) => {
    if (!file) return
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) {
      toast.error(t("stk.err.type"))
      return
    }
    // 超过上限先自动压缩：静态图转 WebP，动图（GIF）解帧重编码，保留动画；
    // 压不下去（或浏览器不支持）才报「超过 X KB」。
    let toUpload = file
    if (file.size > MAX_BYTES) {
      setUploading(true)
      const compressed = await compressToLimit(file, MAX_BYTES)
      setUploading(false)
      if (!compressed) {
        toast.error(t("stk.err.size", { kb: Math.round(MAX_BYTES / 1024) }))
        return
      }
      toUpload = compressed
    }
    setUploading(true)
    try {
      const { sticker } = await stickerApi.upload(toUpload, toUpload.type)
      setStickers((prev) => {
        const next = [...prev, sticker]
        writeCache(next)
        return next
      })
      toast.success(t("stk.ok.uploaded"))
    } catch (err) {
      toast.error(errMsg(err, t("stk.err.upload")))
    } finally {
      setUploading(false)
      // 清空 input，否则连选同一个文件不会再触发 change
      if (fileRef.current) fileRef.current.value = ""
    }
  }

  const remove = async (id: string) => {
    setBusyId(id)
    try {
      await stickerApi.remove(id)
      setStickers((prev) => {
        const next = prev.filter((s) => s.id !== id)
        writeCache(next)
        return next
      })
    } catch (err) {
      toast.error(errMsg(err, t("stk.err.delete")))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="relative" ref={boxRef}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(true)}
        className={
          "rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground " +
          (open ? "bg-accent text-foreground" : "")
        }
        title={t("stk.title")}
        aria-label={t("stk.title")}
        aria-expanded={open}
      >
        {/* 用「贴纸」图标而不是「图片+」：后者和工具栏左边的「图片」按钮太像，
            用户会认不出来（2026-10-02 反馈「找不到发表情的按钮」） */}
        <StickerIcon className="h-4 w-4" aria-hidden="true" />
      </button>

      <AnchoredPanel anchorRef={btnRef} open={open} onClose={() => setOpen(false)}>
        <div className="mb-1.5 flex items-center justify-between border-b pb-1.5">
            <span className="inline-flex items-center gap-1 text-xs font-medium">
              <Smile className="h-3.5 w-3.5 text-muted-foreground" />
              {t("stk.title")}
            </span>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
            >
              {uploading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ImagePlus className="h-3.5 w-3.5" />
              )}
              {t("stk.upload")}
            </button>
          </div>

          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            className="hidden"
            onChange={(e) => void pickFile(e.target.files?.[0])}
          />

          {stickers.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
              <p className="text-xs text-muted-foreground">{t("stk.empty")}</p>
              <p className="text-[11px] text-muted-foreground">{t("stk.emptyHint")}</p>
            </div>
          ) : (
            <div className="grid flex-1 grid-cols-4 content-start gap-1 overflow-y-auto">
              {stickers.map((s) => (
                <div key={s.id} className="group relative aspect-square">
                  <button
                    type="button"
                    onClick={() => onPick(`![](${s.url})`)}
                    className="h-full w-full rounded-md border p-1 transition-colors hover:border-primary hover:bg-accent"
                    title={t("stk.send")}
                  >
                    <img
                      src={s.url}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="h-full w-full object-contain"
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(s.id)}
                    disabled={busyId === s.id}
                    className="absolute -right-1 -top-1 hidden h-5 w-5 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm transition-colors hover:text-destructive group-hover:flex"
                    title={t("common.delete")}
                    aria-label={t("common.delete")}
                  >
                    {busyId === s.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <X className="h-3 w-3" />
                    )}
                  </button>
                </div>
              ))}
            </div>
          )}

          <p className="mt-1.5 border-t pt-1.5 text-[11px] text-muted-foreground">
            {t("stk.footer", { kb: Math.round(MAX_BYTES / 1024) })}
          </p>
      </AnchoredPanel>
    </div>
  )
}
