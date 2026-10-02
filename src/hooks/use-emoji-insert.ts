import * as React from "react"

/**
 * 在 textarea 光标处插入一段文本（表情等），并把光标移到插入内容之后。
 *
 * 抽出来的原因：社区页的评论框、回复框、发帖框各写了一份几乎相同的实现，
 * 有三处重复；光标定位这类细节出问题时容易只改到其中一处。
 *
 * @param ref    目标 textarea 的 ref
 * @param value  当前文本
 * @param setValue 文本更新函数
 */
export function useEmojiInsert(
  // 社区用多行 textarea、私信用单行 input —— 两者的 selectionStart/setSelectionRange
  // 行为一致，所以共用这一个 hook（2026-10-02 扩宽类型以支持私信）
  ref: React.RefObject<HTMLTextAreaElement | HTMLInputElement | null>,
  value: string,
  setValue: React.Dispatch<React.SetStateAction<string>>
) {
  return React.useCallback(
    (text: string) => {
      const ta = ref.current
      // 输入框还没挂载时（例如面板先于输入框渲染）直接追加到末尾
      if (!ta) {
        setValue((v) => v + text)
        return
      }
      const start = ta.selectionStart ?? value.length
      const end = ta.selectionEnd ?? value.length
      setValue(value.slice(0, start) + text + value.slice(end))
      // 等 React 把新值渲染进 DOM 后再定位光标，否则会被重置到末尾
      requestAnimationFrame(() => {
        ta.focus()
        const pos = start + text.length
        ta.setSelectionRange(pos, pos)
      })
    },
    [ref, value, setValue]
  )
}
