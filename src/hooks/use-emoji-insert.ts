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
      /*
       * ⚠️ 以 **DOM 的当前值** 为基准，而不是闭包里的 `value`。
       *
       * 背景（2026-10-08 站长反馈「反馈回复写了很长文字 + 插表情包，结果只剩表情包」）：
       * 原实现是 `value.slice(0, start) + text + value.slice(end)` —— `value` 来自
       * React state，`selectionStart/End` 来自 DOM。两者一旦不同步（受控组件的
       * 值更新有延迟、输入法组合期间、面板展开触发重渲染等），就会**拿旧文本
       * 去算新文本**，把用户已经打进去的内容整段覆盖掉。用 `ta.value` 就不会：
       * 它永远是用户眼前正在看的那个字符串。
       */
      const cur = ta.value ?? value

      /*
       * 归一化选择区间。
       *
       * 失焦的 textarea 在部分浏览器里 `selectionStart` 会归 0（规范允许），
       * 于是插入点变成开头 —— 用户会看到「表情包跑到了最前面、自己写的字像被顶掉了」
       * （即使文字其实还在后面）。这里把「内容非空、却是 (0,0) 区间」解释为
       * 「插到末尾」：站长点表情包时，绝大多数情况是刚在末尾写完字。
       */
      let start = ta.selectionStart
      let end = ta.selectionEnd
      if (start == null) start = cur.length
      if (end == null) end = cur.length
      if (cur.length > 0 && start === 0 && end === 0) {
        start = cur.length
        end = cur.length
      }

      setValue(cur.slice(0, start) + text + cur.slice(end))
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
