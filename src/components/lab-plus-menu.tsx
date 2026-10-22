/**
 * 实验室输入框的「+」菜单 —— **两套输入框共用一份**（2026-10-22）。
 *
 * ## 为什么要有这个文件
 * 实验室的输入区是二选一渲染：动效版 `PromptBar`（自带「+」菜单）与朴素输入框。
 * 这五项（附件 / 站内操作 / 技能 / 联网搜索 / 参考网址）原本只做在动效版里，
 * 于是关掉动效、或系统开了「减少动态效果」的用户（`labFxOn` 默认跟随
 * `prefers-reduced-motion`）**一个入口都没有** —— 用户 fxz 反馈的
 * 「ai实验室缺少联网开关等选项」就是这么来的。
 *
 * 上一版先给朴素版补了一份，等于同一件事写两处：加第六项时必须记得改两边，
 * 迟早漏。现在把三件东西收到这里：
 *   1. **五项的定义**（`useLabPlusItems`）—— 唯一来源；
 *   2. **点击后的分发**（`dispatchLabPlus`）—— files/site/skills/web/ref 的语义只有一份；
 *   3. **朴素版的菜单 UI**（`LabPlusMenu`，含按钮、浮层、外部点击关闭）。
 *
 * 动效版仍由 `PromptBar` 自己画「+」按钮和浮层（那是它的观感），
 * 但它的 `sources` 与点击行为都从这里取 —— 两套 UI，一套语义。
 *
 * ⚠️ 图标要备两份：lucide 的能直接吃 `className`，`PromptBar.sources` 只认
 *    `@hugeicons/core-free-icons` 那套图标数据。两边视觉本来就不同，不必强求同图。
 */
import * as React from "react"
import { Database, Link2, Paperclip, Plus, Search, Sparkles } from "lucide-react"
import type { IconSvgElement } from "@hugeicons/react"
import {
  Attachment01Icon,
  Database02Icon,
  Link01Icon,
  Search01Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons"

import { AnchoredPanel, isInsideAnchoredPanel } from "@/components/anchored-panel"
import { useT } from "@/i18n"
import { cn } from "@/lib/utils"

/** 菜单项标识。⚠️ 与 `lab.src.*` 文案键、以及 `PromptBar` 的 `sources[].key` 一一对应 */
export type LabPlusKey = "files" | "site" | "skills" | "web" | "ref"

export interface LabPlusItem {
  key: LabPlusKey
  name: string
  description: string
  /** 朴素版用：lucide 图标组件，接受 className */
  lucide: React.ComponentType<{ className?: string }>
  /** 动效版用：hugeicons 图标数据（`PromptBarSource.icon` 接受的那套类型） */
  huge: IconSvgElement
}

/**
 * 五项的唯一来源。**加第六项只改这里**（外加 `dispatchLabPlus` 里加一个分支）。
 * 文案沿用 `lab.src.*`：两个菜单同源，翻译不用抄两遍。
 */
export function useLabPlusItems(): LabPlusItem[] {
  const { t } = useT()
  return React.useMemo(
    () => [
      {
        key: "files",
        name: t("lab.src.files"),
        description: t("lab.src.filesDesc"),
        lucide: Paperclip,
        huge: Attachment01Icon,
      },
      {
        key: "site",
        name: t("lab.src.site"),
        description: t("lab.src.siteDesc"),
        lucide: Database,
        huge: Database02Icon,
      },
      {
        key: "skills",
        name: t("lab.src.skills"),
        description: t("lab.src.skillsDesc"),
        lucide: Sparkles,
        huge: SparklesIcon,
      },
      {
        key: "web",
        name: t("lab.src.web"),
        description: t("lab.src.webDesc"),
        lucide: Search,
        huge: Search01Icon,
      },
      {
        key: "ref",
        name: t("lab.src.ref"),
        description: t("lab.src.refDesc"),
        lucide: Link2,
        huge: Link01Icon,
      },
    ],
    [t]
  )
}

/**
 * 点击某一项要干什么 —— 两套输入框共用这一份语义。
 *
 * 各 composer 只在**自己的差异部分**上做文章：
 *   · `onFiles`：朴素版把返回的文件名加进自己的附件条；动效版走 `PromptBar` 的
 *     `onAttach`，这里传空实现即可（它自己会插卡片）；
 *   · `onSite`：往输入框里插 `@站内操作`（与动效版插入的文本完全一致，
 *     `send()` 靠 `@站内操作|@site\b` 识别）。
 */
export interface LabPlusHandlers {
  onFiles: () => void | Promise<void>
  onSite: () => void
  onSkills: () => void
  onWeb: () => void
  onRef: () => void
}

export function dispatchLabPlus(key: string, h: LabPlusHandlers): boolean {
  switch (key) {
    case "files":
      void h.onFiles()
      return true
    case "site":
      h.onSite()
      return true
    case "skills":
      h.onSkills()
      return true
    case "web":
      h.onWeb()
      return true
    case "ref":
      h.onRef()
      return true
    default:
      return false
  }
}

/**
 * 朴素输入框的「+」按钮 + 浮层。
 *
 * 自带开合状态与「点外部关闭」：**必须豁免锚点按钮本身**，
 * 否则点按钮时先被文档监听关掉、再被 onClick 翻回来，表现为「点一下闪一下打不开」。
 */
export function LabPlusMenu({
  handlers,
  className,
}: {
  handlers: LabPlusHandlers
  className?: string
}) {
  const { t } = useT()
  const items = useLabPlusItems()
  const [open, setOpen] = React.useState(false)
  const btnRef = React.useRef<HTMLButtonElement>(null)

  React.useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (isInsideAnchoredPanel(e.target)) return
      if (btnRef.current && btnRef.current.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [open])

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={cn(
          "grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
          open && "bg-accent text-foreground",
          className
        )}
        title={t("lab.plus.title")}
        aria-label={t("lab.plus.title")}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Plus className="h-4 w-4" />
      </button>

      <AnchoredPanel
        anchorRef={btnRef}
        open={open}
        onClose={() => setOpen(false)}
        width={280}
        height={Math.min(320, 16 + items.length * 52)}
      >
        <div className="mb-1 border-b px-1 pb-1.5 text-xs font-medium">{t("lab.plus.title")}</div>
        <div className="flex-1 space-y-0.5 overflow-y-auto">
          {items.map((item) => {
            const Icon = item.lucide
            return (
              <button
                key={item.key}
                type="button"
                className="flex w-full items-start gap-2 rounded-md px-1.5 py-1.5 text-left text-xs transition-colors hover:bg-accent/60"
                onClick={() => {
                  setOpen(false)
                  dispatchLabPlus(item.key, handlers)
                }}
              >
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{item.name}</span>
                  <span className="block text-[11px] leading-snug text-muted-foreground">
                    {item.description}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </AnchoredPanel>
    </>
  )
}
