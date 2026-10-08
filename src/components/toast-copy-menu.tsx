/**
 * Toast（右下角通知）右键复制菜单 —— 2026-10-08 站长要求。
 *
 * 背景：右下角的 toast 可以**左右滑动关闭**（sonner 的滑动 dismiss 手势），
 * 想复制里面的报错信息时，鼠标一拖就被当成「滑动关闭」，文字根本选不中。
 * 于是改成：**右键** toast → 弹一个小菜单 → 点「复制」把整条通知拷进剪贴板，
 * 不用再跟滑动手势抢鼠标。
 *
 * 为什么挂在全局：toast 是 `toast.success/error(...)` 在任意地方触发的，
 * 逐个调用点加 onContextMenu 不现实。这里在 document 上监听一次，
 * **只有右键落在 `[data-sonner-toast]` 上才接管**，其它地方保持浏览器默认菜单。
 *
 * ⚠️ 菜单要盖在 toast 之上：sonner 的容器 z-index 是 999999999，这里用 int32 上限。
 * ⚠️ portal 到 body 必须带 `pointer-events-auto`（有 Radix modal 弹窗时 body 会被设成
 *    pointer-events:none，只挂在弹窗内部的节点恢复 auto，兄弟节点会继承 none）。
 */
import * as React from "react"
import { createPortal } from "react-dom"
import { Copy } from "lucide-react"
import { toast } from "sonner"
import { useT } from "@/i18n"

interface MenuState {
  x: number
  y: number
  text: string
}

/**
 * 取一条 toast 的可复制文本：**标题 + 描述**，不含操作按钮的文案。
 * sonner 2.x 的结构是 `[data-sonner-toast] > [data-content] > [data-title]/[data-description]`。
 */
function toastText(el: HTMLElement): string {
  const title = el.querySelector("[data-title]")?.textContent?.trim() ?? ""
  const desc = el.querySelector("[data-description]")?.textContent?.trim() ?? ""
  if (title && desc) return `${title}\n${desc}`
  return title || desc || (el.querySelector("[data-content]")?.textContent?.trim() ?? "")
}

export function ToastCopyMenu() {
  const { t } = useT()
  const [menu, setMenu] = React.useState<MenuState | null>(null)
  const menuRef = React.useRef<HTMLDivElement | null>(null)

  // 右键判定：只接管「落在 toast 上」的右键，其余交给浏览器
  React.useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.("[data-sonner-toast]")
      if (!el) return
      e.preventDefault()
      setMenu({
        x: e.clientX,
        y: e.clientY,
        text: toastText(el as HTMLElement),
      })
    }
    document.addEventListener("contextmenu", onCtx)
    return () => document.removeEventListener("contextmenu", onCtx)
  }, [])

  // 点菜单外 / 滚动 / Esc → 收起
  React.useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return
      setMenu(null)
    }
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close()
    }
    window.addEventListener("mousedown", onDown)
    window.addEventListener("scroll", close, true)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("mousedown", onDown)
      window.removeEventListener("scroll", close, true)
      window.removeEventListener("keydown", onKey)
    }
  }, [menu])

  if (!menu) return null

  return createPortal(
    <div
      ref={menuRef}
      data-toast-copy-menu=""
      className="pointer-events-auto fixed w-32 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
      style={{
        zIndex: 2147483647,
        top: Math.max(8, Math.min(menu.y, window.innerHeight - 52)),
        left: Math.max(8, Math.min(menu.x, window.innerWidth - 136)),
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          const text = menu.text
          setMenu(null)
          if (!text) {
            toast.error(t("common.copyFailed"))
            return
          }
          navigator.clipboard.writeText(text).then(
            () => toast.success(t("common.copied")),
            () => toast.error(t("common.copyFailed"))
          )
        }}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
      >
        <Copy className="h-4 w-4 shrink-0 text-muted-foreground" />
        {t("common.copy")}
      </button>
    </div>,
    document.body
  )
}
