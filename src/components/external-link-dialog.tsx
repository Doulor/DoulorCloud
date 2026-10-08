import * as React from "react"
import { ExternalLink, Loader2, ShieldAlert } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { FunLinkIcon } from "@/components/fun-link-icon"
import { hostOf, loadLinkPreview, peekLinkPreview } from "@/lib/link-preview"
import { tStatic, useT } from "@/i18n"
import type { LinkPreview } from "@/types"

/**
 * 外链跳转确认弹窗（2026-10-07 站长要求）。
 *
 * 原来点外链弹的是**浏览器原生 confirm**：样式与本站完全割裂，而且只给一个光秃秃的域名 ——
 * 而用户在被问「要不要跳走」时，最需要知道的恰恰是「对面是什么」。
 * 现在换成站内风格弹窗，并顺手把目标页的 OG 预览（标题 / 描述 / 图标 / 大图）拉出来，
 * 让人在决定跳走之前就能判断这条链接值不值得点。
 *
 * ── 架构：模块级单例 + 订阅 ──────────────────────────────
 * 链接点击可能发生在任意深度的 Markdown 里（帖子正文、评论、聊天、公告、反馈…），
 * 把「打开确认框」的回调一层层透传会污染一大串组件、且每次新增渲染点都要再传一遍。
 * 所以由本组件在 App 顶层挂**一次**，各处只调 `requestExternalLink(href)`。
 */

type Opener = (href: string) => void
let opener: Opener | null = null

/**
 * 请求一次「外链确认」。
 *
 * 组件未挂载时（比如在 App 之外的测试/独立页面里渲染 Markdown）回落原生 confirm，
 * 保证**不会出现「点链接没反应」**这种比丑更糟的结果。
 */
export function requestExternalLink(href: string): void {
  if (opener) {
    opener(href)
    return
  }
  if (window.confirm(tStatic("link.leaveConfirm", { host: hostOf(href) }))) {
    window.open(href, "_blank", "noopener,noreferrer")
  }
}

/** 新标签页打开（带上 noopener/noreferrer，别把 opener 交给外部站点） */
function openExternal(href: string): void {
  window.open(href, "_blank", "noopener,noreferrer")
}

export function ExternalLinkDialog() {
  const { t } = useT()
  const [href, setHref] = React.useState<string | null>(null)
  /** undefined = 还没查；null = 查了但没拿到 */
  const [preview, setPreview] = React.useState<LinkPreview | null | undefined>(undefined)
  /** og:image 加载失败 → 退回站点图标，别在弹窗里留一块空白 */
  const [imageFailed, setImageFailed] = React.useState(false)

  React.useEffect(() => {
    opener = (h) => setHref(h)
    return () => {
      opener = null
    }
  }, [])

  React.useEffect(() => {
    if (!href) return
    setImageFailed(false)
    // 同一链接若已被正文卡片抓过，这里直接用缓存，不再请求（也就没有加载态闪烁）
    const cached = peekLinkPreview(href)
    setPreview(cached)
    if (cached !== undefined) return
    let cancelled = false
    void loadLinkPreview(href).then((v) => {
      if (!cancelled) setPreview(v)
    })
    return () => {
      cancelled = true
    }
  }, [href])

  const host = href ? hostOf(href) : ""
  const showImage = Boolean(preview?.image) && !imageFailed

  return (
    <Dialog
      open={href !== null}
      onOpenChange={(o) => {
        if (!o) setHref(null)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ExternalLink className="h-4 w-4" />
            {t("link.leaveTitle")}
          </DialogTitle>
          <DialogDescription>{t("link.leaveDesc")}</DialogDescription>
        </DialogHeader>

        {/* 目标地址：域名放大，完整 URL 小字（让人一眼看清去哪个站） */}
        <div className="rounded-lg border bg-muted/40 px-3 py-2">
          <p className="text-sm font-medium">{host}</p>
          <p className="break-all text-xs text-muted-foreground">{href}</p>
        </div>

        {/* 目标页预览：抓不到就整块不渲染（不占位、不报错，照样能跳） */}
        {preview === undefined ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("link.leavePreviewLoading")}
          </p>
        ) : preview ? (
          <div className="overflow-hidden rounded-lg border">
            {showImage ? (
              <img
                src={preview.image ?? ""}
                alt=""
                loading="lazy"
                className="h-36 w-full object-cover"
                onError={() => setImageFailed(true)}
              />
            ) : null}
            <div className="flex items-start gap-2 p-3">
              {!showImage && (
                <FunLinkIcon
                  src={preview.icon}
                  title={preview.title}
                  size={32}
                  className="shrink-0 rounded"
                />
              )}
              <div className="min-w-0 space-y-1">
                <p className="line-clamp-2 text-sm font-medium">
                  {preview.title || host}
                </p>
                {preview.description && (
                  <p className="line-clamp-3 text-xs text-muted-foreground">
                    {preview.description}
                  </p>
                )}
                {preview.siteName && (
                  <p className="truncate text-[11px] text-muted-foreground/70">
                    {preview.siteName}
                  </p>
                )}
              </div>
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t("link.leaveNoPreview")}</p>
        )}

        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t("link.leaveNote")}
        </p>

        <DialogFooter>
          <Button variant="outline" onClick={() => setHref(null)}>
            {t("common.cancel")}
          </Button>
          <Button
            autoFocus
            onClick={() => {
              const target = href
              setHref(null)
              if (target) openExternal(target)
            }}
          >
            <ExternalLink className="h-4 w-4" />
            {t("link.leaveOpen")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
