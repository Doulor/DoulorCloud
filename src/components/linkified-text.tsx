import * as React from "react"

import { requestExternalLink } from "@/components/external-link-dialog"

/**
 * 把**纯文本**里的 URL 变成可点链接。
 *
 * 为什么需要它：`messages` 表只存了 `text_body`（HTML 正文在投递时就被转成文本了），
 * 邮件阅读页又是用 `<pre>` 原样输出 —— 于是「点这里验证邮箱」这种邮件里，
 * 地址是一串死文字，用户只能手动选中复制。2026-10-17 的反馈就是这条：
 * 「一些需要验证登录或二次跳转的邮件无法使用」。
 *
 * ⚠️ 只认 `http` / `https`：
 *   · 邮件的 `text_body` 是**别人可控的内容**，`javascript:` / `data:` 之类绝不能变成 `<a href>`；
 *   · `mailto:` 也不做 —— 邮件正文里的邮箱地址本来就该用「回复」按钮，不是跳到本机邮件客户端。
 *
 * ⚠️ 点击走 `requestExternalLink()`（全站统一的外链确认弹窗，带目标站 OG 预览），
 *    不直接 `window.open` —— 收信人点的是陌生人给的链接，多一道确认是应该的。
 */

/** 匹配 URL；尾部标点交给 `splitTrailingPunct` 处理（邮件里常写成「…/verify?token=x.」） */
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi

/** 右括号配对：只有当 URL 里右括号**多于**左括号时，尾部那个才属于句子 */
const PAIRS: Record<string, string> = { ")": "(", "]": "[", "}": "{" }
/** 一定属于句子、不属于 URL 的尾部字符 */
const TRAILING = new Set([".", ",", ";", ":", "!", "?", "'", '"', "”", "’", "）", "】", "》"])

function countOccurrences(haystack: string, needle: string): number {
  let n = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    n++
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return n
}

/** 把粘在 URL 尾巴上的标点剥下来，单独当普通文字输出 */
function splitTrailingPunct(raw: string): { url: string; tail: string } {
  let url = raw
  let tail = ""
  while (url.length > 0) {
    const ch = url[url.length - 1]
    if (TRAILING.has(ch)) {
      tail = ch + tail
      url = url.slice(0, -1)
      continue
    }
    const opener = PAIRS[ch]
    if (opener && countOccurrences(url, ch) > countOccurrences(url, opener)) {
      tail = ch + tail
      url = url.slice(0, -1)
      continue
    }
    break
  }
  return { url, tail }
}

type Segment = { kind: "text"; value: string } | { kind: "url"; value: string }

export function splitByUrls(text: string): Segment[] {
  if (!text) return []
  const segments: Segment[] = []
  let last = 0
  URL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = URL_RE.exec(text)) !== null) {
    const { url, tail } = splitTrailingPunct(m[0])
    // 剥完可能只剩 "https://" 这种没意义的东西，那就别当链接
    if (url.length <= "https://".length) continue
    if (m.index > last) segments.push({ kind: "text", value: text.slice(last, m.index) })
    segments.push({ kind: "url", value: url })
    if (tail) segments.push({ kind: "text", value: tail })
    last = m.index + m[0].length
  }
  if (last < text.length) segments.push({ kind: "text", value: text.slice(last) })
  return segments
}

/**
 * 纯文本 + 自动链接。默认渲染成 `<pre>`（保留换行），与邮件阅读页原来的排版一致。
 */
export function LinkifiedText({
  text,
  className,
  fallback,
}: {
  text: string
  className?: string
  /** 文本为空时显示的内容（调用方传 i18n 文案） */
  fallback?: string
}) {
  const segments = React.useMemo(() => splitByUrls(text), [text])

  if (!text) {
    return <pre className={className}>{fallback ?? ""}</pre>
  }

  return (
    <pre className={className}>
      {segments.map((seg, i) =>
        seg.kind === "url" ? (
          <a
            key={i}
            href={seg.value}
            // 保留 href 是为了右键「复制链接地址」还能用；实际跳转走统一确认弹窗
            rel="noopener noreferrer nofollow"
            className="break-all text-primary underline underline-offset-2 hover:opacity-80"
            onClick={(e) => {
              e.preventDefault()
              requestExternalLink(seg.value)
            }}
          >
            {seg.value}
          </a>
        ) : (
          <React.Fragment key={i}>{seg.value}</React.Fragment>
        )
      )}
    </pre>
  )
}
