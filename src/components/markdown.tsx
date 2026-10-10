/**
 * Markdown 渲染组件（社区帖子/评论用）。
 *
 * 安全策略：
 *   - react-markdown **默认不渲染原始 HTML**——用户写的 `<script>`、`<img onerror>`
 *     等都会被当作纯文本显示，天然防 XSS，无需额外 sanitize。
 *   - 链接一律 `target="_blank" rel="noopener noreferrer nofollow"`，
 *     防止 `window.opener` 反代攻击与 SEO 权重外泄。
 *   - 只支持 markdown 语法（标题/加粗/斜体/代码/列表/引用/链接/表格/删除线），
 *     不支持内联 HTML（产品决策：社区帖子不该能塞任意 HTML）。
 *
 * 依赖：react-markdown + remark-gfm（GFM 扩展）+ remark-breaks（单换行即换行）。
 *
 * 链接卡片：**裸链接**（单独一行写一个 URL）会渲染成「富链接卡片」
 * （标题/描述/缩略图），行内链接 `[文字](url)` 仍是普通链接。
 * 预览数据来自后端（服务端抓取，避免浏览器 CORS），并有模块级缓存去重。
 */
import * as React from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkBreaks from "remark-breaks"
import { Check, Loader2, Plus } from "lucide-react"
import { toast } from "sonner"
import { FunLinkIcon } from "@/components/fun-link-icon"
import { stickerApi, errMsg } from "@/services/api"
import { GitHubMark, isGitHubUrl } from "@/components/github-mark"
import { useAuth } from "@/hooks/use-auth"
import { useT } from "@/i18n"
import { hostOf, loadLinkPreview, peekLinkPreview } from "@/lib/link-preview"
import { requestExternalLink } from "@/components/external-link-dialog"
import { ImageLightbox } from "@/components/image-lightbox"
import type { LinkPreview } from "@/types"

/** 链接卡片：异步拉取预览，渲染标题/描述/缩略图；拿不到则回退普通链接 */
function LinkCard({ href }: { href: string }) {
  const [preview, setPreview] = React.useState<LinkPreview | null | undefined>(
    peekLinkPreview(href)
  )
  /** og:image 加载失败时回退到站点图标（别留一块空白把文字挤到左边） */
  const [imageFailed, setImageFailed] = React.useState(false)
  const imageUrl = preview?.image ?? ""
  /**
   * GitHub 链接**不走 og:image**：那张 1200×600 的社交大图缩到 80×80 后
   * 只剩一团噪点，完全看不清（站长原话）。直接用章鱼猫徽标，干净又一眼可辨。
   */
  const useGitHubMark = isGitHubUrl(href)

  React.useEffect(() => {
    setImageFailed(false)
  }, [imageUrl])

  React.useEffect(() => {
    // 缓存里已有（含「查过但拿不到」的 null）就不再请求。
    // 缓存与去重都在 lib/link-preview.ts —— 与「外链确认弹窗」共用同一份，
    // 所以同一条链接在正文卡片和弹窗里只会真正抓取一次。
    if (peekLinkPreview(href) !== undefined) return
    let cancelled = false
    void loadLinkPreview(href).then((v) => {
      if (!cancelled) setPreview(v)
    })
    return () => {
      cancelled = true
    }
  }, [href])

  // 加载中：普通链接样式
  if (preview === undefined) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        onClick={(e) => guardExternalClick(e, href)}
        className="break-all text-primary underline underline-offset-2 hover:text-primary/80"
      >
        {href}
      </a>
    )
  }

  // 拿不到预览：普通链接
  if (preview === null) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        onClick={(e) => guardExternalClick(e, href)}
        className="break-all text-primary underline underline-offset-2 hover:text-primary/80"
      >
        {href}
      </a>
    )
  }

  // 有预览：渲染卡片
  //
  // 左侧永远占一块（80×80）：有 og:image 就铺大图，没有就用站点图标，
  // 连图标都没有（或加载失败）时回退成首字母色块 —— 否则文字会紧贴卡片
  // 左边缘，看着像坏了（QQ 群邀请页这类没 og:image 的页面以前就是这样）。
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      onClick={(e) => guardExternalClick(e, href)}
      className="glass-card mt-2 flex gap-3 overflow-hidden rounded-lg border transition-colors hover:bg-accent/40"
    >
      {useGitHubMark ? (
        <div className="flex h-20 w-20 shrink-0 items-center justify-center bg-foreground/[0.04]">
          <GitHubMark className="h-9 w-9 text-foreground/70" />
        </div>
      ) : preview.image && !imageFailed ? (
        <img
          src={preview.image}
          alt=""
          loading="lazy"
          className="h-20 w-20 shrink-0 object-cover"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <FunLinkIcon src={preview.icon} title={preview.title} size={80} className="rounded-none" />
      )}
      <div className="min-w-0 flex-1 py-2 pr-3">
        <p className="truncate text-sm font-medium text-foreground">{preview.title}</p>
        {preview.description && (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {preview.description}
          </p>
        )}
        <p className="mt-1 truncate text-xs text-muted-foreground/70">
          {preview.siteName || hostOf(href)}
        </p>
      </div>
    </a>
  )
}

/**
 * 判断 props 是不是「裸链接」（children 就是 href 本身，无其它文字）
 */
function isBareLink(href: string, children: React.ReactNode): boolean {
  // 裸链接的 children 通常是单个字符串，且内容等于 href（或去掉协议后的形式）
  if (typeof children !== "string") return false
  const text = children.trim()
  if (!text) return false
  // 匹配 https://x 或 x.com 这种形式
  return text === href || text === href.replace(/^https?:\/\//, "")
}

/**
 * 外链二次确认（用户反馈 5f489c9a）：正文里的链接点击后先弹一次确认，
 * 避免误点直接跳走；确认后在**新标签页**打开，当前页不丢。
 * 站内/相对链接（无 http(s) 前缀或同源）不拦。
 *
 * 2026-10-07：确认框从**浏览器原生 confirm** 换成站内风格弹窗
 * （见 components/external-link-dialog.tsx），并在弹窗里给出目标页的 OG 预览 ——
 * 原生 confirm 只有一行域名，用户其实无从判断"对面是什么"。
 */
function guardExternalClick(e: React.MouseEvent, href: string): void {
  if (!/^https?:\/\//i.test(href)) return
  let external = false
  try {
    external = new URL(href).host !== window.location.host
  } catch {
    external = false
  }
  if (!external) return
  e.preventDefault()
  requestExternalLink(href)
}

/** 普通链接（不抓取预览、不渲染富卡片）：外链先弹二次确认，站内链接直接开 */
function renderPlainLink(props: React.ComponentPropsWithoutRef<"a">) {
  const { href, children, ...rest } = props
  if (!href) {
    return <a {...rest}>{children}</a>
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      onClick={(e) => guardExternalClick(e, href)}
      className="break-all text-primary underline underline-offset-2 hover:text-primary/80"
      {...rest}
    >
      {children}
    </a>
  )
}

/** 链接渲染：裸链接走卡片，行内链接保持普通样式 */
function renderLink(props: React.ComponentPropsWithoutRef<"a">) {
  const { href, children } = props
  // 裸链接 → 富卡片
  if (href && isBareLink(href, children)) {
    return <LinkCard href={href} />
  }
  // 行内链接 → 普通
  return renderPlainLink(props)
}

/** 代码块 + 行内代码 */
function renderCode(props: React.ComponentPropsWithoutRef<"code"> & { node?: unknown }) {
  const { node, children, ...rest } = props
  // 去除 react-markdown 注入的 node 属性，避免透传非 DOM 属性
  return <code {...rest}>{children}</code>
}

/**
 * 图片渲染。
 *
 * 分两种，因为它们的意图完全不同：
 *   · **站内表情包**（`/api/stickers/<id>/image`）是**独占一行的块级小图**——
 *     不管前面有没有文字，都自动换行到新的一行再显示（2026-10-03 站长要求：
 *     贴一行文字 + 表情包时，表情包单独一行，视觉更对齐）。限制在 96px 见方。
 *     不限制的话，一张 512×512 的表情包会把整段话撑成一大块，聊天体感全毁。
 *   · **外链图片**按常规处理：限宽不溢出、限高不喧宾夺主，圆角加边。
 * 两者都开 lazy loading：一屏十几张表情包时，只有进视口的才真正去取。
 */
/**
 * 站内表情包：点一下放大看原图。
 *
 * 「存到我的表情包」有两种形态：
 *   · 默认（`showSaveButton` 不关）：右键/长按弹出本组件自己的保存按钮 ——
 *     给社区帖子、私信等**没有消息右键菜单**的场景用；
 *   · 聊天室（`showSaveButton=false`）：不弹自己的按钮，改由父级的消息右键菜单
 *     统一承载「存到我的表情包」（见 chat.tsx 的 msgMenu），避免右键同时弹出
 *     两个风格不一致的东西（2026-10-04 站长反馈）。
 */
function StickerImage({
  src,
  alt,
  showSaveButton = true,
}: {
  src: string
  alt: string
  showSaveButton?: boolean
}) {
  const { user } = useAuth()
  const { t } = useT()
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [zoom, setZoom] = React.useState(false)
  const [saved, setSaved] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const longPressTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressed = React.useRef(false)
  const id = src.match(/\/api\/stickers\/([0-9a-f-]{36})\/image/)?.[1]

  const openMenu = () => {
    if (showSaveButton && user && id && !saved) setMenuOpen(true)
  }
  const clearLongPress = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current)
    longPressTimer.current = null
  }

  // 点别处 / 滚动时收起菜单
  React.useEffect(() => {
    if (!menuOpen) return
    const close = () => setMenuOpen(false)
    document.addEventListener("click", close)
    document.addEventListener("scroll", close, true)
    return () => {
      document.removeEventListener("click", close)
      document.removeEventListener("scroll", close, true)
    }
  }, [menuOpen])

  const save = async () => {
    if (!id || saving || saved) return
    setSaving(true)
    try {
      await stickerApi.save(id)
      setSaved(true)
      setMenuOpen(false)
      toast.success(t("stk.ok.saved"))
    } catch (err) {
      toast.error(errMsg(err, t("stk.err.save")))
    } finally {
      setSaving(false)
    }
  }

  const onClick = (e: React.MouseEvent) => {
    // 社区概览页整张卡片可点（跳详情），点表情包只该放大 ——
    // 与 ZoomableImage 同一处理，否则点表情包会「放大 + 跳详情」双触发
    e.stopPropagation()
    // 长按触发的 touchend 之后的 click 不要放大，只放大普通点击/轻点
    if (longPressed.current) {
      longPressed.current = false
      return
    }
    setZoom(true)
  }

  return (
    <>
      <span
        className="relative my-1 block select-none"
        onClick={onClick}
        onContextMenu={
          showSaveButton
            ? (e) => {
                e.preventDefault()
                openMenu()
              }
            : undefined
        }
        onTouchStart={
          showSaveButton
            ? () => {
                longPressTimer.current = setTimeout(() => {
                  longPressed.current = true
                  openMenu()
                }, 500)
              }
            : undefined
        }
        onTouchEnd={showSaveButton ? clearLongPress : undefined}
        onTouchMove={showSaveButton ? clearLongPress : undefined}
        onTouchCancel={showSaveButton ? clearLongPress : undefined}
      >
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          className="sticker-img inline-block align-text-bottom"
        />
        {showSaveButton && user && id && !saved && menuOpen && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              void save()
            }}
            disabled={saving}
            className="absolute -top-7 right-0 z-20 flex items-center gap-1 whitespace-nowrap rounded-md border bg-popover px-2 py-0.5 text-xs font-medium shadow-md hover:bg-accent disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            {t("stk.save")}
          </button>
        )}
        {user && saved && (
          <span
            className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground"
            title={t("stk.saved")}
          >
            <Check className="h-2.5 w-2.5" />
          </span>
        )}
      </span>
      {zoom && (
        <ImageLightbox
          src={src}
          alt={alt}
          onClose={() => setZoom(false)}
          dialogLabel={t("feedback.preview")}
          closeLabel={t("feedback.closePreview")}
          zoomHint={t("lightbox.hint")}
          resizeLabel={t("lightbox.resize")}
        />
      )}
    </>
  )
}

/**
 * 普通 markdown 图片：点击放大（与表情包同款遮罩，portal 到 body）。
 *
 * 为什么需要（2026-10-06 社区反馈）：粘贴/拖入的图会以 `![](url)` 落在正文里，
 * 走的就是这条 renderImage 分支 —— 以前它只是个静态 <img>，点不开也放不大，
 * 而「选图片」按钮上传的图走 PostImages 组件、自带放大，两种入口体验不一致。
 * 这里补齐，让正文 markdown 图也能点开放大（含历史帖子与评论里的图）。
 */
function ZoomableImage({ src, alt }: { src: string; alt: string }) {
  const { t } = useT()
  const [zoom, setZoom] = React.useState(false)
  return (
    <>
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        className="my-2 max-h-80 max-w-full cursor-zoom-in rounded-md border"
        onClick={(e) => {
          // 阻止冒泡：帖子卡片整体可点（跳详情），不拦的话点图会「放大 + 跳转」双触发
          e.stopPropagation()
          setZoom(true)
        }}
      />
      {zoom && (
        <ImageLightbox
          src={src}
          alt={alt}
          onClose={() => setZoom(false)}
          dialogLabel={t("feedback.preview")}
          closeLabel={t("feedback.closePreview")}
          zoomHint={t("lightbox.hint")}
          resizeLabel={t("lightbox.resize")}
        />
      )}
    </>
  )
}

function renderImage(
  { src, alt }: React.ComponentProps<"img">,
  showSaveButton: boolean
) {
  const url = typeof src === "string" ? src : ""
  // 兼容相对与绝对两种写法（极少数历史数据的 body 里带上了完整 host）
  if (/\/api\/stickers\/[0-9a-f-]{36}\/image/.test(url)) {
    return <StickerImage src={url} alt={alt ?? ""} showSaveButton={showSaveButton} />
  }
  return <ZoomableImage src={url} alt={alt ?? ""} />
}

/**
 * `stickerSaveButton` 走 context 传给图片渲染器 —— **不能**在 `components` 里写闭包。
 *
 * 为什么（2026-10-09 线上排查「社区广场点赞有概率报错」）：
 *   react-markdown 是把 `components[name]` 的**函数本身**当作 React 元素类型用的
 *   （hast-util-to-jsx-runtime 里 `state.components[name]`）。
 *   以前这里写的是 `img: (props) => renderImage(props, stickerSaveButton)` ——
 *   每次渲染都是一个**新函数**，React 认为「这个位置的元素类型变了」，于是把每个
 *   正文图片/表情包整棵**卸载再重建**（`hast-util-to-jsx-runtime` 只认引用相等）。
 *
 *   实测（线上 cloud.doulor.cn）：**点一次赞 = 25 次 removeChild + 25 次 insertBefore**，
 *   全部落在 `.markdown-body` 里的图片/表情包节点上 —— 因为点赞是乐观更新，整个列表
 *   会重渲染，列表里每张卡的正文图片都被重建一遍。
 *   removeChild 正是「DOM 被 React 之外的东西改过」时最先崩掉的操作（浏览器翻译、
 *   改写 DOM 的扩展都会造成引用失效），所以「点赞就报错」的概率被这一步放大了很多；
 *   何况每次重建还会清掉图片组件自己的状态（已存表情包、放大态）。
 *
 *   把类型身份固定住之后，重渲染只会**更新**已有节点，不再重建（实测 removeChild 归零）。
 */
const StickerSaveButtonCtx = React.createContext(true)

/** 稳定的图片渲染组件：类型身份不随渲染变化（详见上面 StickerSaveButtonCtx 的说明） */
function MarkdownImage(props: React.ComponentProps<"img">) {
  return renderImage(props, React.useContext(StickerSaveButtonCtx))
}

export function Markdown({
  children,
  stickerSaveButton = true,
  linkCards = true,
}: {
  children: string
  /** false = 表情包不显示自己的「保存」按钮（由父级右键菜单承载，如聊天室） */
  stickerSaveButton?: boolean
  /**
   * false = 裸链接不渲染成富链接卡片（也不去后端抓预览），退化成普通链接。
   *
   * 给**容器很窄**的场景用：AI 实验室的回复气泡最宽只有 85%，卡片左侧那块
   * 80×80 缩略图会把标题挤成两三个字，还不如一个能看全的链接清楚。
   */
  linkCards?: boolean
}) {
  return (
    <div className="markdown-body break-words text-sm leading-relaxed">
      <StickerSaveButtonCtx.Provider value={stickerSaveButton}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkBreaks]}
          components={{
            a: linkCards ? renderLink : renderPlainLink,
            code: renderCode,
            img: MarkdownImage,
          }}
        >
          {children}
        </ReactMarkdown>
      </StickerSaveButtonCtx.Provider>
    </div>
  )
}
