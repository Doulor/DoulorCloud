/**
 * 表情选择面板：点一下把 emoji 插到光标处。
 *
 * 从 community.tsx 提取出来（2026-10-02）—— 私信、聊天室也要用同一套。
 * 两处各写一份的话，面板定位、分组、后续调整都得改两遍，迟早分叉。
 *
 * 面板用 `AnchoredPanel` 渲染到 body：社区/私信的输入框嵌在带 `overflow-hidden`
 * 的卡片里，普通 absolute 面板会被裁掉下半截（2026-10-02 站长反馈）。
 */
import * as React from "react"
import { Smile } from "lucide-react"
import { EMOJI_GROUPS } from "@/lib/emojis"
import { AnchoredPanel, isInsideAnchoredPanel } from "@/components/anchored-panel"
import { useT } from "@/i18n"

export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const { t } = useT()
  const [open, setOpen] = React.useState(false)
  const [group, setGroup] = React.useState(0)
  const boxRef = React.useRef<HTMLDivElement>(null)
  const btnRef = React.useRef<HTMLButtonElement>(null)

  // 点外部关闭。⚠️ 面板在 body 里、不在 boxRef 内，必须单独放行，
  // 否则点面板自身会被判成「点了外部」而立刻关掉
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

  return (
    <div className="relative" ref={boxRef}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={
          "rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground " +
          (open ? "bg-accent text-foreground" : "")
        }
        title={t("cm.emoji")}
        aria-label={t("cm.emojiInsert")}
        aria-expanded={open}
      >
        <Smile className="h-4 w-4" aria-hidden="true" />
      </button>
      <AnchoredPanel anchorRef={btnRef} open={open} onClose={() => setOpen(false)}>
        {/* 高度固定（AnchoredPanel 给的是 h-64）+ 内层 flex-1 滚动：
            各分组的 emoji 数量不同，面板高度跟着变的话切换分组时整块会上下跳 */}
        <div className="mb-1.5 flex flex-wrap gap-0.5 border-b pb-1.5">
          {EMOJI_GROUPS.map((g, i) => (
            <button
              key={g.name}
              type="button"
              onClick={() => setGroup(i)}
              className={
                "rounded-md px-2 py-1 text-xs transition-colors " +
                (i === group
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-muted-foreground hover:bg-accent")
              }
            >
              {t(g.name)}
            </button>
          ))}
        </div>
        <div className="grid flex-1 grid-cols-8 content-start gap-0.5 overflow-y-auto">
          {EMOJI_GROUPS[group].emojis.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => onPick(e)}
              className="rounded-md p-1 text-lg leading-none transition-colors hover:bg-accent"
            >
              {e}
            </button>
          ))}
        </div>
      </AnchoredPanel>
    </div>
  )
}
