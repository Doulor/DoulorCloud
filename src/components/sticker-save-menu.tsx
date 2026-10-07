/**
 * 站内表情包的「存到我的表情包」右键菜单 —— 聊天室 / 私信 / 社区共用。
 *
 * 为什么抽出来：这几处都是「右键落在 `img.sticker-img` 上 → 弹一个（可能只有
 * 『存到我的表情包』一个选项的）小菜单」。聊天室和私信各写了一份，社区帖子的
 * 评论区漏了 —— 那里还是表情包自带的老式小按钮（2026-10-06 站长反馈）。
 *
 * 用法：
 * ```tsx
 * const { onContextMenu, renderMenu } = useStickerSaveMenu()
 * <div onContextMenu={onContextMenu}>
 *   <Markdown stickerSaveButton={false}>{body}</Markdown>
 * </div>
 * {renderMenu()}
 * ```
 * ⚠️ 必须同时把 `<Markdown>` 的 `stickerSaveButton` 关掉，否则小按钮和右键菜单并存。
 */
import * as React from "react"
import { createPortal } from "react-dom"
import { Plus } from "lucide-react"
import { toast } from "sonner"
import { stickerApi, errMsg } from "@/services/api"
import { useT } from "@/i18n"
import { useAuth } from "@/hooks/use-auth"

/** 站内表情包图片的 src 模式（与 markdown.tsx 的 StickerImage 识别保持一致） */
const STICKER_SRC_RE = /\/api\/stickers\/([0-9a-f-]{36})\/image/

interface StickerMenuState {
  x: number
  y: number
  stickerId: string
}

export function useStickerSaveMenu() {
  const { t } = useT()
  const { user } = useAuth()
  const [menu, setMenu] = React.useState<StickerMenuState | null>(null)
  const menuRef = React.useRef<HTMLDivElement | null>(null)

  // 点菜单外 / 滚动 / Esc → 收起（与聊天室、私信行为一致）
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

  /**
   * 挂到「包住 markdown 的容器」上。
   * 只有右键**落在站内表情包上**才拦截并弹菜单；否则不 preventDefault，保留浏览器默认菜单。
   */
  const onContextMenu = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest?.("img.sticker-img") as HTMLImageElement | null
    const id = el ? el.src.match(STICKER_SRC_RE)?.[1] ?? null : null
    if (!id) return
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, stickerId: id })
  }

  const saveSticker = async (id: string) => {
    try {
      const res = await stickerApi.save(id)
      toast.success(res.alreadySaved ? t("stk.saved") : t("stk.ok.saved"))
    } catch (err) {
      toast.error(errMsg(err, t("stk.err.save")))
    }
  }

  /** 渲染右键菜单（portal 到 body，跟随鼠标并夹在视口内） */
  const renderMenu = () => {
    if (!menu) return null
    return createPortal(
      <div
        ref={menuRef}
        className="fixed z-50 w-40 rounded-lg border bg-popover p-1 shadow-lg"
        style={{
          top: Math.max(8, Math.min(menu.y, window.innerHeight - 60)),
          left: Math.max(8, Math.min(menu.x, window.innerWidth - 168)),
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {user && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const id = menu.stickerId
              setMenu(null)
              void saveSticker(id)
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
          >
            <Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
            {t("stk.save")}
          </button>
        )}
      </div>,
      document.body
    )
  }

  return { onContextMenu, renderMenu }
}
