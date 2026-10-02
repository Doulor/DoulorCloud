/**
 * GitHub 章鱼猫徽标（官方 mark 路径）。
 *
 * 用在哪：站内链接卡片（markdown.tsx 的 LinkCard）。GitHub 链接的 og:image
 * 是一张 1200×600 的社交分享大图，缩到卡片左侧 80×80 后完全看不清；
 * 所以 GitHub 链接**不用** og:image / favicon，直接用这个徽标。
 *
 * `fill="currentColor"`：颜色跟随文字色，深浅主题都不用额外处理。
 * 路径来自 GitHub 官方 octicon（mark-github，16×16 viewBox），可自由缩放。
 */
export function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor" className={className}>
      <path
        fillRule="evenodd"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  )
}

/** 判断一个 URL 是不是 GitHub 站点（含 gist）—— 链接卡片据此换章鱼猫徽标 */
export function isGitHubUrl(href: string): boolean {
  try {
    const host = new URL(href).hostname.toLowerCase()
    return host === "github.com" || host.endsWith(".github.com") || host === "github.io"
      ? true
      : host.endsWith(".github.io")
  } catch {
    return false
  }
}
