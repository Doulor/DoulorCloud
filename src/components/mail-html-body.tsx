/**
 * 收件箱富文本正文：把**已消毒**的邮件 HTML 塞进沙箱 iframe 渲染。
 *
 * 为什么用 iframe 而不是 `dangerouslySetInnerHTML`：
 *   邮件正文是任意发信人可控的内容。直接内联进页面 = 它与我们的 React 应用
 *   同源，一旦消毒器有任何绕过，`<script>` 就能读 `document.cookie`、带着会话
 *   调 `/api/*`（存储型 XSS，触发方式只是"打开一封邮件"）。iframe 把这段内容
 *   关进**不透明源**，出错的最坏结果只是"这张卡片里花了"。
 *
 * `sandbox` 只给两个能力，其余全关：
 *   · `allow-popups` + `allow-popups-to-escape-sandbox` —— 邮件里的外链点了要在
 *     新标签页打开（且新标签页不被沙箱限制，否则外部网站在 iframe 里跑）。
 *   · **故意不给** `allow-scripts`（脚本一律不执行，这是第二层防御，与
 *     worker/src/mail-html.ts 的白名单互为兜底），也不给 `allow-same-origin`
 *     （给了它，脚本就能碰到本站的存储与 cookie）。
 *
 * ⚠️ 不要提供「在新标签页打开原文」这类入口：sanitize 后的 HTML 若以 blob: URL
 *    直接打开，`sandbox` 属性就**不再生效**（它只在被嵌入时起作用），等于绕开
 *    全部隔离 —— 仓库里 lab-agent.ts 已经为同一个坑写过一段注释。
 *
 * ⚠️ iframe 跨源拿不到内容高度，所以只能给固定高度 + 内部滚动。
 *    这是"安全隔离"换来的代价，不要为了自动撑高去加 allow-same-origin。
 */
import * as React from "react"

/** 邮件本身不带样式表（`<style>` 在消毒时已被丢弃），排版全靠这里兜底 */
const DOC_CSS = `
  :root { color-scheme: light; }
  html, body { margin: 0; padding: 0; background: #ffffff; }
  body {
    padding: 16px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
      'PingFang SC', 'Microsoft YaHei', sans-serif;
    font-size: 14px;
    line-height: 1.65;
    color: #111827;
    overflow-x: auto;
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  * { max-width: 100% !important; box-sizing: border-box; }
  /* 图片经本站代理加载（见 worker/src/handlers/mail-image.ts），这里只约束尺寸。
     消毒器把原始地址留在 data-mail-src，未换成代理地址时浏览器不会加载它。 */
  img { max-width: 100% !important; height: auto !important; border: 0; }
  video, audio, iframe, object, embed, picture, source { display: none !important; }
  p { margin: 0 0 12px; }
  h1, h2, h3, h4, h5, h6 { margin: 0 0 12px; line-height: 1.35; font-size: 16px; }
  a { color: #2563eb; }
  ul, ol { margin: 0 0 12px; padding-left: 22px; }
  li { margin: 0 0 4px; }
  table { border-collapse: collapse; }
  td, th { padding: 4px 8px; vertical-align: top; }
  th { text-align: left; }
  blockquote { margin: 0 0 12px; padding-left: 12px; border-left: 3px solid #e5e7eb; color: #4b5563; }
  pre { margin: 0 0 12px; padding: 10px; background: #f3f4f6; border-radius: 6px; white-space: pre-wrap; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 16px 0; }
`

export function MailHtmlBody({
  html,
  title,
  className,
}: {
  /** 后端白名单重建后的片段（不是原文） */
  html: string
  title?: string
  className?: string
}) {
  const doc = React.useMemo(
    () =>
      `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
      // 断掉 referer：邮件里的外链不该知道用户是从哪个页面点过去的
      `<meta name="referrer" content="no-referrer">` +
      `<style>${DOC_CSS}</style></head><body>${html}</body></html>`,
    [html]
  )

  return (
    <iframe
      title={title ?? "邮件正文"}
      srcDoc={doc}
      // 见文件头：只放开弹窗，脚本与同源一律不给
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      loading="lazy"
      className={
        className ??
        "h-[60vh] min-h-[280px] w-full rounded-lg border bg-white"
      }
    />
  )
}
