import * as React from "react"
import { cn } from "@/lib/utils"

/**
 * 标题逐字浮现（动效层，2026-10-08）。
 *
 * 切分规则：**CJK 逐字、拉丁按整词**——中文字天然一字一格、逐字浮现节奏最好；
 * 拉丁词若拆成单字母，字距（kerning）会被 span 切断、单词散架，所以保词。
 * 空格保持纯文本节点，不参与动画。
 *
 * 「关 = 现状」：span 常年在 DOM 里，但动画规则只写在 html.motion-on 下；
 * 关闭时 span 是普通 inline 文本，渲染结果与一整串字符串完全一致
 * （连 inline-block 都只在 motion-on 下才加上，避免单词内断行差异）。
 *
 * 可访问性：外层带 aria-label 存完整文本，内部字符 aria-hidden ——
 * 屏幕阅读器读整句，不会被切散。
 */

/** CJK：汉字 + 通用标点 + 全角符号 */
const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/
const SPACE = /\s/

/** 切分成「动画 token（CJK 单字 / 拉丁词）+ 空格」序列 */
function tokenize(text: string): { text: string; anim: boolean }[] {
  const out: { text: string; anim: boolean }[] = []
  for (const ch of text) {
    if (SPACE.test(ch)) {
      out.push({ text: ch, anim: false })
      continue
    }
    if (CJK.test(ch)) {
      out.push({ text: ch, anim: true })
      continue
    }
    // 拉丁字母/数字/半角符号：与上一个同类的动画 token 拼成一个词
    const last = out[out.length - 1]
    if (last && last.anim && !CJK.test(last.text) && !SPACE.test(last.text)) {
      last.text += ch
    } else {
      out.push({ text: ch, anim: true })
    }
  }
  return out
}

export function SplitText({
  text,
  className,
}: {
  text: string
  className?: string
}) {
  const tokens = React.useMemo(() => tokenize(text), [text])
  let idx = 0
  return (
    <span className={cn("split-text", className)} aria-label={text}>
      {tokens.map((tk, i) =>
        tk.anim ? (
          <span
            key={i}
            aria-hidden="true"
            className="split-token"
            style={{ "--i": idx++ } as React.CSSProperties}
          >
            {tk.text}
          </span>
        ) : (
          tk.text
        )
      )}
    </span>
  )
}
