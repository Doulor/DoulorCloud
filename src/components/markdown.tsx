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
import { FunLinkIcon } from "@/components/fun-link-icon"
import { communityApi } from "@/services/api"
import type { LinkPreview } from "@/types"

/** 链接预览的模块级缓存：同一链接在同一页面只请求一次 */
const previewCache = new Map<string, LinkPreview | null>()

/** 链接卡片：异步拉取预览，渲染标题/描述/缩略图；拿不到则回退普通链接 */
function LinkCard({ href }: { href: string }) {
  const [preview, setPreview] = React.useState<LinkPreview | null | undefined>(
    previewCache.get(href)
  )
  /** og:image 加载失败时回退到站点图标（别留一块空白把文字挤到左边） */
  const [imageFailed, setImageFailed] = React.useState(false)
  const imageUrl = preview?.image ?? ""

  React.useEffect(() => {
    setImageFailed(false)
  }, [imageUrl])

  React.useEffect(() => {
    if (previewCache.has(href)) return
    let cancelled = false
    communityApi
      .linkPreview(href)
      .then((r) => {
        const v = r.preview
        previewCache.set(href, v)
        if (!cancelled) setPreview(v)
      })
      .catch(() => {
        previewCache.set(href, null)
        if (!cancelled) setPreview(null)
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
      className="glass-card mt-2 flex gap-3 overflow-hidden rounded-lg border transition-colors hover:bg-accent/40"
    >
      {preview.image && !imageFailed ? (
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

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** 判断 props 是不是「裸链接」（children 就是 href 本身，无其它文字） */
function isBareLink(href: string, children: React.ReactNode): boolean {
  // 裸链接的 children 通常是单个字符串，且内容等于 href（或去掉协议后的形式）
  if (typeof children !== "string") return false
  const text = children.trim()
  if (!text) return false
  // 匹配 https://x 或 x.com 这种形式
  return text === href || text === href.replace(/^https?:\/\//, "")
}

/** 链接渲染：裸链接走卡片，行内链接保持普通样式 */
function renderLink(props: React.ComponentPropsWithoutRef<"a">) {
  const { href, children, ...rest } = props
  if (!href) {
    return <a {...rest}>{children}</a>
  }
  // 裸链接 → 富卡片
  if (isBareLink(href, children)) {
    return <LinkCard href={href} />
  }
  // 行内链接 → 普通
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="break-all text-primary underline underline-offset-2 hover:text-primary/80"
      {...rest}
    >
      {children}
    </a>
  )
}

/** 代码块 + 行内代码 */
function renderCode(props: React.ComponentPropsWithoutRef<"code"> & { node?: unknown }) {
  const { node, children, ...rest } = props
  // 去除 react-markdown 注入的 node 属性，避免透传非 DOM 属性
  return <code {...rest}>{children}</code>
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown-body break-words text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          a: renderLink,
          code: renderCode,
          // 链接里的图片等默认处理，不做额外定制
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
