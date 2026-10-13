import * as React from "react"
import { createPortal } from "react-dom"
import { toast } from "sonner"
import { BookOpen, Check, Copy, ChevronDown, ChevronRight, Eye, FileText, Gauge, Gift, Globe, List, Loader2, Pencil, Plus, Power, Search, Settings2, Bot, Link as LinkIcon, Sparkles, Paperclip, Terminal, Trash2, X, Camera } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { confirmDialog } from "@/components/confirm-dialog"
import { StatusMark } from "@/components/reactbits"
import {
  DeepSeekIcon,
  OpenAIIcon,
  AnthropicIcon,
  GeminiIcon,
  QwenIcon,
  ZhipuIcon,
  KimiIcon,
  MetaIcon,
  MistralIcon,
  XaiIcon,
  HuggingFaceIcon,
} from "@/components/brand-icons"
import { useMotionPref } from "@/hooks/use-motion-pref"
import { Markdown } from "@/components/markdown"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useT } from "@/i18n"
import { EFFORT_DESC_KEY, EFFORT_LABEL_KEY, EFFORT_LEVELS, type EffortLevel, type ToolName } from "@/lib/lab-agent"
import { cn } from "@/lib/utils"
import { labApi, type LabSkillEntry } from "@/services/api"
import type { CustomChannel, Entry, LabChannel, SiteChannel } from "./types"

/**
 * AI 实验室的时间线渲染层：消息气泡 / 工具卡片 / 思考块 / 各选择器与对话框。
 *
 * 从 lab.tsx **整块搬来（纯搬移，未改任何行为）**。原因：原 lab.tsx 有 5937 行，
 * 其中 LabPage 一个函数就占约 4100 行，任何改动都可能碰坏别处。
 * 这些组件本来就只吃 props，搬走不需要改一行逻辑。
 */
export function WorkingIndicator({ label }: { label: string }) {
  return (
    <div className="flex justify-start" data-lab-working="">
      <div className="flex items-center gap-2.5 rounded-2xl bg-muted px-3.5 py-2.5">
        <Sparkles className="lab-think-icon h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="lab-think-text text-sm">{label}</span>
      </div>
    </div>
  )
}

/**
 * 模型名 → 小图标与配色（2026-10-10 加；2026-10-12 换成**各厂商官方图标**）。
 *
 * 按**关键字**匹配厂商，认不出就用默认的机器人图标 —— 新模型上线、
 * 或用户填了自建渠道的怪名字，也不会显示成空白。
 *
 * 🔴 图标来源：`src/components/brand-icons.tsx` —— Simple Icons（CC0）与
 * @lobehub/icons-static-svg 的**官方品牌 SVG path 内嵌**，随构建打进 bundle，
 * 不引第三方包、不发网络请求。kimi 上游没有单色官方图标，用月亮（贴合品牌意象）。
 * 颜色都取中间调，浅色/深色主题下都看得清（深色下纯黑图标会消失）。
 */
export const MODEL_BADGES: { test: RegExp; Icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>; color: string }[] = [
  { test: /deepseek/i, Icon: DeepSeekIcon, color: "#4d6bfe" },
  { test: /gpt|openai|^o[13]|davinci/i, Icon: OpenAIIcon, color: "#10a37f" },
  { test: /claude|anthropic|sonnet|opus|haiku/i, Icon: AnthropicIcon, color: "#d97757" },
  { test: /gemini|google|gemma|palm/i, Icon: GeminiIcon, color: "#4285f4" },
  { test: /qwen|qwq|通义|tongyi|qoder/i, Icon: QwenIcon, color: "#615ced" },
  { test: /glm|chatglm|智谱|zhipu/i, Icon: ZhipuIcon, color: "#7c5cff" },
  { test: /kimi|moonshot/i, Icon: KimiIcon, color: "#6b7280" },
  { test: /llama|meta/i, Icon: MetaIcon, color: "#0866ff" },
  { test: /mistral|mixtral|codestral/i, Icon: MistralIcon, color: "#fa520f" },
  { test: /grok|xai/i, Icon: XaiIcon, color: "#6b7280" },
  { test: /hugging|hf/i, Icon: HuggingFaceIcon, color: "#b58900" },
]

/** 模型名 → {图标, 颜色}；认不出返回默认 */
export function modelBadge(name: string): { Icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>; color: string } {
  return MODEL_BADGES.find((b) => b.test.test(name)) ?? { Icon: Bot, color: "#6b7280" }
}

/** 模型名显示成一小枚标签：图标 + 名字（太长就截断，别把工具栏撑爆） */
export function ModelTag({ name }: { name: string }) {
  const { Icon, color } = modelBadge(name)
  return (
    <span className="inline-flex max-w-[11rem] items-center gap-1" title={name}>
      <Icon className="h-3.5 w-3.5 shrink-0" style={{ color }} />
      <span className="truncate">{name}</span>
    </span>
  )
}

/** 毫秒 → HH:MM（跟站点语言走） */
export function fmtTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

/**
 * 消息下面那排快捷操作（2026-10-10 站长要求）。
 *
 * ⚠️ **平时不显示**，鼠标移到这条消息上才浮出来（`group-hover`）——
 * 常驻会让每条消息下面都挂一行图标，把对话切得很碎。
 * 键盘用户走 `focus-within` 也能唤出来。
 */
export function MsgActions({
  text,
  onEdit,
  model,
  at,
  always,
}: {
  text: string
  onEdit?: () => void
  /** AI 的消息带上产出它的模型名 */
  model?: string
  /** 时间戳：**只在鼠标悬停这条消息时显示** */
  at?: number
  /** true = 整条工具栏常驻显示（AI 的消息）；false = 悬停才出现（用户的消息） */
  always?: boolean
}) {
  const { t } = useT()
  const [copied, setCopied] = React.useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      // 1.2 秒后变回复制图标 —— 太短看不清、太长会让人以为卡住了
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      toast.error(t("lab.msg.copyFailed"))
    }
  }

  return (
    <div
      className={cn(
        "mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground",
        "transition-opacity duration-150 motion-reduce:transition-none",
        always
          ? // AI 的消息：工具栏**常驻**
            ""
          : // 用户的消息：鼠标靠近才浮出来
            "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
      )}
    >
      {model && <ModelTag name={model} />}
      <button
        type="button"
        title={t("lab.msg.copy")}
        aria-label={t("lab.msg.copy")}
        onClick={() => void copy()}
        className="inline-grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      {onEdit && (
        <button
          type="button"
          title={t("lab.msg.edit")}
          aria-label={t("lab.msg.edit")}
          onClick={onEdit}
          className="inline-grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      )}
      {/*
        时间**始终是悬停才显示**，哪怕工具栏本身常驻 —— 时间只有部分场景有用，
        常驻会让每一行都多一截数字，反而更吵。
      */}
      {at ? (
        <span className="tabular-nums opacity-0 transition-opacity duration-150 group-hover:opacity-100 motion-reduce:transition-none">
          {fmtTime(at)}
        </span>
      ) : null}
    </div>
  )
}

/**
 * 手机端的「长按消息」菜单（2026-10-12 站长要求）。
 *
 * 为什么需要：时间戳 / 复制 / 编辑原来都靠 **hover**（group-hover）——
 * 触屏没有 hover，手机上这三样完全拿不到。
 *
 * 交互：**按住 ≥450ms 且手指没挪** ⇒ 在触点上方弹出一个小浮层
 * （时间小字 + 复制 + 编辑）。点浮层外 / 复制完成 自动关。
 * ⚠️ 只对 `pointerType === "touch"` 生效 —— 桌面鼠标继续用 hover 工具栏，
 * 两套并存互不干扰。长按会触发浏览器的文本选择/呼出菜单，这里要
 * `preventDefault` + `-webkit-touch-callout:none` 一并压掉。
 */
function LongPressMenu({
  text,
  at,
  onEdit,
  onCopy,
}: {
  text: string
  at?: number
  onEdit?: () => void
  /** 复制成功后回调（顺便关菜单） */
  onCopy?: () => void
}) {
  const { t } = useT()
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(t("lab.msg.copied"))
    } catch {
      toast.error(t("lab.msg.copyFailed"))
    }
    onCopy?.()
  }
  return (
    <div className="pointer-events-auto flex items-center gap-1 rounded-xl border border-border/70 bg-popover px-1.5 py-1 shadow-lg">
      {at ? (
        <span className="px-1.5 text-[10px] leading-none tabular-nums text-muted-foreground">
          {fmtTime(at)}
        </span>
      ) : null}
      <button
        type="button"
        aria-label={t("lab.msg.copy")}
        onClick={() => void copy()}
        className="inline-grid h-8 w-8 place-items-center rounded-lg text-foreground transition-colors hover:bg-accent"
      >
        <Copy className="h-4 w-4" />
      </button>
      {onEdit ? (
        <button
          type="button"
          aria-label={t("lab.msg.edit")}
          onClick={() => {
            onEdit()
            onCopy?.()
          }}
          className="inline-grid h-8 w-8 place-items-center rounded-lg text-foreground transition-colors hover:bg-accent"
        >
          <Pencil className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  )
}

/**
 * 把长按菜单挂到一个气泡上。返回要铺在气泡上的事件句柄 + 菜单定位 state。
 * 用法见 TimelineEntry / ThinkingBlock —— 它们把 `bind` 展开到气泡容器上。
 */
function useLongPressMenu(opts: { text: string; at?: number; onEdit?: () => void }) {
  const [pos, setPos] = React.useState<{ x: number; y: number } | null>(null)
  const timer = React.useRef<number | null>(null)
  const start = React.useRef<{ x: number; y: number } | null>(null)

  const close = React.useCallback(() => setPos(null), [])

  const bind = {
    onPointerDown: (e: React.PointerEvent) => {
      // 只管手指：鼠标走 hover 工具栏，别重复
      if (e.pointerType !== "touch") return
      start.current = { x: e.clientX, y: e.clientY }
      if (timer.current != null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        if (!start.current) return
        // 长按成立：弹菜单（压掉系统的文本选择/呼出）
        setPos({ x: start.current.x, y: start.current.y })
        if (navigator.vibrate) {
          try {
            navigator.vibrate(10)
          } catch {
            /* 忽略 */
          }
        }
        start.current = null
      }, 450)
    },
    onPointerMove: (e: React.PointerEvent) => {
      // 手指挪了超过 10px ⇒ 用户在滚动/拖拽，不是长按
      if (!start.current || !timer.current) return
      if (
        Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10
      ) {
        if (timer.current != null) window.clearTimeout(timer.current)
        timer.current = null
        start.current = null
      }
    },
    onPointerUp: () => {
      if (timer.current != null) window.clearTimeout(timer.current)
      timer.current = null
      start.current = null
    },
    onPointerCancel: () => {
      if (timer.current != null) window.clearTimeout(timer.current)
      timer.current = null
      start.current = null
    },
    // 手机上长按默认会选中文本 / 弹系统菜单 —— 在「长按确认成功」前先压掉选择起点，
    // 长按弹窗出现后允许在菜单里正常操作。
    onContextMenu: (e: React.MouseEvent) => {
      if (window.matchMedia("(pointer: coarse)").matches) e.preventDefault()
    },
  }

  React.useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current)
    },
    []
  )

  const menu = pos ? (
    <>
      {createPortal(
        <>
          <div
            className="fixed inset-0 z-[70]"
            onPointerDown={close}
            onClick={close}
          />
          <div
            className="fixed z-[71] -translate-x-1/2 -translate-y-full"
            style={{
              left: Math.min(Math.max(pos.x, 90), window.innerWidth - 90),
              top: Math.max(pos.y - 12, 56),
            }}
          >
            <LongPressMenu
              text={opts.text}
              at={opts.at}
              onEdit={opts.onEdit}
              onCopy={close}
            />
          </div>
        </>,
        document.body
      )}
    </>
  ) : null

  return { bind, menu, close }
}

/**
 * 内容列宽度的拖拽手柄（2026-10-12 站长要求，**照抄 DeepSeek Harness** 的
 * `WidthHandle` 组件 —— 样式与几何见 index.css 的 `.lab-width-handle`）。
 *
 * 为什么是「左右两条」而不是只给左边：DSH 就是左右各一条，两条拖拽等价
 * （内容居中，往哪边拖都是把这一侧往外推），多一条更好抓。
 *
 * 拖拽数学（与 DSH 逐行一致）：
 *   `width = base + outward * 2`，其中 outward = 右侧 ? dx : -dx
 *   ⚠️ 那个 **×2** 是关键：内容列是**居中**的，把左边往外推 d 像素，
 *   整列宽度增加 2d（右边对称地也扩了）—— 少了它手感会「跟不上鼠标」。
 *
 * 另两个细节也照抄：
 *   · `setPointerCapture` + `data-dragging`：拖出元素范围也继续跟手；
 *   · 用 `requestAnimationFrame` 节流宽度更新（每个 pointermove 都写样式会掉帧）。
 */
export function WidthHandle({
  side,
  onStart,
  onDrag,
  onCommit,
  onEnd,
}: {
  side: "left" | "right"
  /** 开始拖：返回当前宽度（作为基准） */
  onStart: () => number
  /** 拖动中：给出目标宽度（已由调用方钳制） */
  onDrag: (width: number) => void
  /** 松手：把最终宽度落盘 */
  onCommit: (width: number) => void
  /** 松手后收尾（重算实际生效宽度） */
  onEnd: () => void
}) {
  const callbacks = React.useRef({ side, onStart, onDrag, onCommit, onEnd })
  callbacks.current = { side, onStart, onDrag, onCommit, onEnd }
  const origin = React.useRef(0)
  const latest = React.useRef(0)
  const base = React.useRef(0)
  const dragging = React.useRef(false)
  const frame = React.useRef<number | null>(null)

  const outwardWidth = () => {
    const dx = latest.current - origin.current
    const outward = callbacks.current.side === "right" ? dx : -dx
    return base.current + outward * 2
  }
  const cancelFrame = () => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }
  /** 竖线跟随指针的 Y（hover 时也跟 —— 站长要的是「移过去就出现一条小线」） */
  const paintPointerY = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    e.currentTarget.style.setProperty("--lab-handle-y", `${e.clientY - box.top}px`)
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    origin.current = e.clientX
    latest.current = e.clientX
    base.current = callbacks.current.onStart()
    dragging.current = true
    e.currentTarget.setAttribute("data-dragging", "")
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    paintPointerY(e)
    if (!dragging.current) return
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    latest.current = e.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(outwardWidth())
    })
  }
  const finish = (e: React.PointerEvent<HTMLDivElement>, commit: boolean) => {
    if (!dragging.current) return
    dragging.current = false
    e.currentTarget.removeAttribute("data-dragging")
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    cancelFrame()
    if (commit) callbacks.current.onCommit(outwardWidth())
    callbacks.current.onEnd()
  }

  React.useEffect(() => () => cancelFrame(), [])

  return (
    <div
      className="lab-width-handle"
      data-side={side}
      aria-hidden="true"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finish(e, true)}
      onPointerCancel={(e) => finish(e, false)}
      onLostPointerCapture={(e) => finish(e, false)}
    />
  )
}

export function TimelineEntry({
  entry,
  onEdit,
}: {
  entry: Entry
  onEdit?: (entry: Extract<Entry, { kind: "user" }>) => void
}) {
  if (entry.kind === "user") {
    // 手机：长按气泡弹「时间/复制/编辑」菜单（桌面继续用 hover 工具栏）
    const lp = useLongPressMenu({
      text: entry.text,
      at: entry.at,
      onEdit: onEdit ? () => onEdit(entry) : undefined,
    })
    return (
      <div className="group flex flex-col items-end">
        <div
          {...lp.bind}
          className="max-w-[85%] touch-manipulation [-webkit-touch-callout:none] rounded-2xl bg-primary px-3.5 py-2 text-sm leading-relaxed text-primary-foreground select-none"
        >
          {entry.files?.length ? (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {entry.files.map((f) => (
                <span
                  key={f}
                  className="inline-flex max-w-[16rem] items-center gap-1 rounded-md bg-primary-foreground/15 px-1.5 py-0.5 text-[11px] leading-5"
                >
                  <Paperclip className="h-3 w-3 shrink-0" />
                  <span className="truncate">{f}</span>
                </span>
              ))}
            </div>
          ) : null}
          {entry.text ? (
            <p className="whitespace-pre-wrap break-words">{entry.text}</p>
          ) : null}
        </div>
        {lp.menu}
        <MsgActions
          text={entry.text}
          at={entry.at}
          onEdit={onEdit ? () => onEdit(entry) : undefined}
        />
      </div>
    )
  }
  if (entry.kind === "text") return <ThinkingBlock entry={entry} />
  return <ToolCard entry={entry} />
}

  /**
 * 「正在做的事」用**人话**说（2026-10-12 站长要求）。
 *
 * 站长原话：「我想要的那个正在思考下面的动作是具体在做的事情，但是他基本上只显示过
 * 『正在写入 xxx 文件』，我想让它写的是具体的事情，比如『正在查询服务器信息』
 * 『正在下载 xxx 应用程序』『正在检查程序漏洞』」。
 *
 * 所以这里不按「工具名 + 参数」直译（那是日志），而是**猜意图**：
 *   · 模型自己给的一行人话说明（`run` 的 desc，例如「下载环境依赖」）**优先**用；
 *   · 没有就按命令/地址里的关键字推断：curl/wget → 下载、npm install → 安装依赖、
 *     git clone → 拉取代码、grep/test/nmap → 检查、http GET → 查询信息……
 *   · 实在认不出就退回「正在执行 xxx」。
 *
 * ⚠️ 这是**纯展示**文案，绝不参与执行判断（认错了只是话说得不准，不影响行为）。
 */
export function toolIntent(
  t: (key: string, vars?: Record<string, string>) => string,
  e: Extract<Entry, { kind: "tool" }>
): string {
  /** 从命令里挑出「在对谁下手」：优先 URL 的域名，否则最后一个非选项参数 */
  const cmdTarget = (cmd: string): string => {
    const url = cmd.match(/https?:\/\/[^\s'"]+/)?.[0]
    if (url) {
      try {
        return new URL(url).host
      } catch {
        return url.slice(0, 40)
      }
    }
    const parts = cmd.split(/\s+/).filter((s) => s && !s.startsWith("-"))
    return parts[parts.length - 1] ?? ""
  }
  /** 从 URL 取域名（取不到就截断显示） */
  const host = (raw?: string): string => {
    if (!raw) return ""
    try {
      return new URL(raw).host
    } catch {
      return raw.slice(0, 40)
    }
  }
  switch (e.tool) {
    case "run": {
      const cmd = (e.command ?? "").trim()
      // 模型自己写的人话说明最准，直接用
      if (e.desc?.trim()) return e.desc.trim()
      if (/\b(curl|wget|aria2c)\b/.test(cmd)) {
        const what = cmdTarget(cmd)
        return what ? t("lab.act.download", { what }) : t("lab.act.downloading")
      }
      if (/git\s+clone/.test(cmd)) return t("lab.act.clone")
      if (
        /\b(npm|pnpm|yarn|bun|pip|pip3|apt|apt-get|apk|brew)\b[^\n]*\b(i|install|add)\b/.test(cmd)
      )
        return t("lab.act.install")
      if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(build|make)\b/.test(cmd)) return t("lab.act.build")
      if (/\b(grep|rg|find|test|nmap|audit|pip-audit|netstat)\b/.test(cmd) || /curl\s+-I/.test(cmd)) {
        const what = cmdTarget(cmd)
        return what ? t("lab.act.check", { what }) : t("lab.act.checking")
      }
      if (/\b(ls|cat|head|tail|wc|file|du|df|ps|top|env|which)\b/.test(cmd)) {
        const what = cmdTarget(cmd)
        return what ? t("lab.act.inspect", { what }) : t("lab.act.inspecting")
      }
      const first = cmd.split(/\s+/)[0] ?? ""
      return first ? t("lab.act.run", { what: first }) : t("lab.act.running")
    }
    case "read":
      return e.path ? t("lab.act.read", { what: e.path }) : t("lab.act.reading")
    case "write":
      return e.path ? t("lab.act.write", { what: e.path }) : t("lab.act.writing")
    case "replace":
      return e.path ? t("lab.act.replace", { what: e.path }) : t("lab.act.replacing")
    case "delete":
      return e.path ? t("lab.act.delete", { what: e.path }) : t("lab.act.deleting")
    case "list":
      return t("lab.act.list")
    case "grep":
      return e.pattern ? t("lab.act.grep", { what: e.pattern }) : t("lab.act.grepping")
    case "http": {
      const h = host(e.url)
      const post = (e.httpMethod ?? "GET").toUpperCase() !== "GET"
      if (!h) return t("lab.act.http")
      return post ? t("lab.act.httpPost", { what: h }) : t("lab.act.httpGet", { what: h })
    }
    case "web_search":
      return e.query ? t("lab.act.search", { what: e.query }) : t("lab.act.searching")
    case "site":
      return e.op ? t("lab.act.site", { what: e.op }) : t("lab.act.siteBare")
    case "skill":
      return e.skill ? t("lab.act.skill", { what: e.skill }) : t("lab.act.skillBare")
    case "inspect":
      return t("lab.act.inspectPage")
    case "screenshot":
      return t("lab.act.shot")
    case "need_vm":
      return t("lab.act.vm")
    default:
      return t(`lab.working.${e.tool}`)
  }
}


/**
 * 一轮对话里给模型的消息。
 * `content` 是字符串（纯文本）或 part 数组（带图的多模态）。
 * ⚠️ 必须与后端 `worker/src/handlers/lab.ts` 的 `ChatMessage` 保持一致 ——
 * 后端只认 `text` / `image_url` 两种 part，且图片只收 data URL。
 */
/**
 * 「思考过程」块（仿主流 agent 框架）：
 *   - 流式期间展开、文字逐字出现，标题带流光走马灯；
 *   - 这一轮说完（后面跟着工具调用）就自动折叠成一行，点一下还能展开；
 *   - 如果这段是直接给用户的答复（后面没有动作），就正常当气泡显示。
 */
export function ThinkingBlock({ entry }: { entry: Extract<Entry, { kind: "text" }> }) {
  const { t } = useT()
  // 流式期间默认展开；从草稿恢复出来的（live=false）默认就是收起的
  const [open, setOpen] = React.useState(entry.live)
  /** 用户手动点开过就不再自动收起（免得刚展开又被合上） */
  const touched = React.useRef(false)
  /**
   * ⚠️ 这个 hook 必须放在下面那个 `if (!entry.collapsible) return …` **之前**。
   * 放在后面会导致「普通气泡」少一个 hook、「思考块」多一个 ——
   * 同一个位置从气泡变成思考块时，React 发现 hook 数量对不上，
   * 直接抛 #310（站长 2026-10-10 发消息时遇到的那条报错）。
   */
  const { labFxOn } = useMotionPref()
  // 手机：长按正文气泡弹「时间/复制」菜单（AI 的消息没有编辑；桌面走 hover 工具栏）
  const replyLp = useLongPressMenu({ text: entry.text, at: entry.at })

  /**
   * 思考内容的**自动滚动**（2026-10-12 站长要求）。
   *
   * 规则（站长原话）：思考内容自动往下滚、显示最新的；**用户主动往上翻看旧内容时
   * 就别抢他的滚动条**；他再滚回最下面，就继续跟着最新内容走。
   *
   * 实现：一个「是否粘住底部」的 ref —— 内容变长时只要还粘着就滚到底；
   * `onScroll` 里按「离底 < 24px」判断要不要继续粘。
   * ⚠️ 阈值不能取 0：流式滚动有小数/取整误差，差 1px 就会被误判成「用户翻走了」，
   *    于是自动滚动永久失效（这类「滚一下就再也不跟」的毛病最难查）。
   */
  const thinkScrollRef = React.useRef<HTMLDivElement | null>(null)
  const stickBottomRef = React.useRef(true)
  React.useEffect(() => {
    if (!open) return
    const el = thinkScrollRef.current
    if (!el || !stickBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [entry.text, open])
  const onThinkScroll = () => {
    const el = thinkScrollRef.current
    if (!el) return
    stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  React.useEffect(() => {
    if (!entry.live && !touched.current) setOpen(false)
  }, [entry.live])

  // 直接给用户的答复：普通气泡。
  // 模型输出走 markdown 渲染 —— 以前是 `whitespace-pre-wrap` 纯文本，
  // `**加粗**`、`- 列表`、```代码块``` 全以**原文**露出来，看着很粗糙。
  if (!entry.collapsible) {
    return (
      <div className="group flex flex-col items-start" data-lab-reply="">
        <div
          {...replyLp.bind}
          className={cn(
            "min-w-0 max-w-[85%] touch-manipulation [-webkit-touch-callout:none] select-none rounded-2xl bg-muted px-3.5 py-2 text-sm leading-relaxed text-foreground",
            // 流式期间由 CSS（.lab-streaming）往最后一段文字末尾缀闪烁光标
            entry.live && "lab-streaming"
          )}
        >
          <Markdown linkCards={false}>{entry.text}</Markdown>
          {/* 还没吐字时 markdown 里没有任何块级元素，::after 无处可挂，补一个兜底光标 */}
          {entry.live && !entry.text.trim() && <span className="lab-caret" />}
        </div>
        {replyLp.menu}
        {/* 还在流式输出时不给复制 —— 那时内容是半截的，复制了也没用 */}
        {!entry.live && (
          <MsgActions text={entry.text} model={entry.model} at={entry.at} always />
        )}
      </div>
    )
  }

  const lines = entry.text ? entry.text.split("\n").length : 0

  return (
    <div
      className={cn(
        labFxOn
          ? "text-muted-foreground"
          : "overflow-hidden rounded-xl border border-border/60 bg-muted/30"
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          touched.current = true
          setOpen((v) => !v)
        }}
        className={cn(
          "flex w-full items-center gap-2 text-left text-xs",
          labFxOn ? "px-0 py-1" : "px-3 py-1.5 hover:bg-accent/40"
        )}
      >
        <Sparkles
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground",
            entry.live && "lab-think-icon"
          )}
        />
        <span
          className={cn(
            "shrink-0 font-medium",
            entry.live && "lab-think-text"
          )}
        >
          {entry.live ? t("lab.agent.thinking") : t("lab.agent.thought")}
        </span>
        {lines > 1 && (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
            {t("lab.agent.thoughtLines").replace("{n}", String(lines))}
          </span>
        )}
        <ChevronRight
          className={cn(
            "ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
            open && "rotate-90"
          )}
        />
      </button>
      {open && (
        <div
          ref={thinkScrollRef}
          onScroll={onThinkScroll}
          className={cn(
            // 🔴 最大高度 + 内部滚动（2026-10-12 站长反馈）：思考动辄几百行，
            // 不限高会把整页刷穿。max-h 里用 dvh（手机键盘弹出时跟随视口）。
            "max-h-[min(38vh,22rem)] overflow-y-auto overscroll-contain",
            "min-w-0 border-t border-border/50 px-3 py-2 text-[13px] leading-relaxed text-muted-foreground",
            entry.live && "lab-streaming"
          )}
        >
          <Markdown linkCards={false}>{entry.text}</Markdown>
          {entry.live && !entry.text.trim() && <span className="lab-caret" />}
        </div>
      )}
    </div>
  )
}

export const TOOL_ICON: Record<ToolName, typeof FileText> = {
  write: FileText,
  replace: Pencil,
  read: Eye,
  list: List,
  delete: Trash2,
  grep: Search,
  need_vm: Power,
  run: Terminal,
  site: Globe,
  site_manual: BookOpen,
  skill: Sparkles,
  web_search: Globe,
  http: LinkIcon,
  screenshot: Camera,
  inspect: Search,
}

/**
 * replace 卡片的 **diff 视图**（2026-10-12 站长要求）。
 *
 * replace 的内容在内部是「三段式」文本（`<<<<<<< 原文 / ======= / >>>>>>>`），
 * 直接摊给用户看很难读。这里渲染成 -旧（红）/ +新（绿），一眼看出改了什么。
 * 解析不出来就原样显示（宁可不漂亮，也不能显示错）。
 */
function ReplaceDiff({ content }: { content: string }) {
  const m = content.match(/^<<<<<<< 原文\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>>\s*$/)
  if (!m) return <>{content}</>
  const oldLines = m[1].split("\n")
  const newLines = m[2].split("\n")
  return (
    <>
      {oldLines.map((l, i) => (
        <div key={`o${i}`} className="text-destructive/80">
          {"- "}
          {l}
        </div>
      ))}
      {newLines.map((l, i) => (
        <div key={`n${i}`} className="text-emerald-600 dark:text-emerald-400">
          {"+ "}
          {l}
        </div>
      ))}
    </>
  )
}

export function ToolCard({
  entry,
}: {
  entry: Extract<Entry, { kind: "tool" }>
}) {
  const { t } = useT()
  const [open, setOpen] = React.useState(entry.tool === "screenshot" || entry.tool === "inspect")
  const Icon = TOOL_ICON[entry.tool]
  // 工具卡片的状态标要不要用动效版（设置页那个开关）
  const { labFxOn } = useMotionPref()
  const lines = entry.content ? entry.content.split("\n").length : 0
  const expandable = Boolean(entry.content)
  const running = entry.status === "running"
  // 站内操作失败 / 被用户拒绝时别打绿勾 —— 那会让人以为改动已经生效了
  const failed =
    entry.tool === "site" && /\] 失败：|用户拒绝/.test(entry.content ?? "")

 /**
 * 展开后的内容面板**粘住底部**（2026-10-12 站长要求，与思考块同一套规则）：
   * 写入/读取的内容是流式长出来的，展开着看时应该跟着最新一行走；
   * 用户自己往上翻就别抢滚动条，滚回最下面再继续跟。
   * ⚠️ 阈值取 24px（不是 0）：滚动有小数/取整误差，差 1px 会被误判成「用户翻走了」，
   *    自动滚动就永久失效了。
   */
  /** 截图灯箱：点图放大看（手机端尤其需要） */
  const [zoom, setZoom] = React.useState<string | null>(null)
  const bodyRef = React.useRef<HTMLPreElement | null>(null)
  const stickBodyRef = React.useRef(true)
  React.useEffect(() => {
    if (!open) return
    const el = bodyRef.current
    if (!el || !stickBodyRef.current) return
    el.scrollTop = el.scrollHeight
  }, [entry.content, open])
  const onBodyScroll = () => {
    const el = bodyRef.current
    if (!el) return
    stickBodyRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  return (
    <div
      className={cn(
        "animate-in fade-in slide-in-from-bottom-1 duration-200",
        // 动效模式：**不要卡片**（站长要求「让文字直接悬浮在空中」），统一灰字；
        // 朴素模式保留原来的卡片外观。
        labFxOn ? "text-muted-foreground" : "overflow-hidden rounded-xl border border-border/70 bg-card/50"
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => expandable && setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 text-left text-xs",
          labFxOn ? "px-0 py-1.5" : "px-3 py-2",
          expandable && !labFxOn && "hover:bg-accent/40"
        )}
      >
        {labFxOn ? (
          /*
            动效版：动词前面那枚「转圈 → 打勾 + 划线」的状态标（status-mark 风）。
            ⚠️ 只在本动作**还在跑**时显示：完成后站长不要绿勾、也不要横线划掉
            （2026-10-10 反馈），所以结束态直接退回纯文字。
          */
          running ? (
            <StatusMark
              status="running"
              label={t(`lab.tool.${entry.tool}`)}
              size={15}
              fontSize={12}
              className="shrink-0 font-medium"
            />
          ) : (
            <span className="shrink-0 font-medium">{t(`lab.tool.${entry.tool}`)}</span>
          )
        ) : (
          <>
            <Icon
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-muted-foreground",
                running && "animate-pulse"
              )}
            />
            <span className={cn("shrink-0 font-medium", running && "lab-think-text")}>
              {t(`lab.tool.${entry.tool}`)}
            </span>
          </>
        )}
        {entry.tool === "grep" ? (
          <code className="truncate font-mono text-[11px] text-muted-foreground">
            /{entry.pattern || ""}/{entry.scope ? ` in ${entry.scope}` : ""}
          </code>
        ) : entry.tool === "run" ? (
          /*
           * ⚠️ 有 `desc`（模型给的人话说明）就显示说明，**不要直接把命令行摆出来** ——
           * 「下载环境依赖」比 `npm ci --silent` 有意义得多（站长 2026-10-10 反馈）。
           * 模型没给说明时才退回显示命令，并且只显示第一行。
           */
          entry.desc ? (
            <span className="truncate text-[11px] text-muted-foreground">{entry.desc}</span>
          ) : (
            <code className="truncate font-mono text-[11px] text-muted-foreground">
              $ {entry.command?.split("\n")[0] ?? ""}
            </code>
          )
        ) : entry.tool === "http" ? (
          <code className="truncate font-mono text-[11px] text-muted-foreground">
            {entry.httpMethod ? `${entry.httpMethod} ` : ""}
            {entry.url || "?"}
          </code>
        ) : entry.tool === "site" ? (
          <code className="truncate font-mono text-[11px] text-muted-foreground">
            {entry.op || "?"}
          </code>
        ) : entry.path ? (
          <code className="truncate font-mono text-[11px] text-muted-foreground">
            {entry.path}
          </code>
        ) : (
          /**
           * 🔴 流式中的 write：`path` 参数可能还没传到（模型有时先吐 content）。
           * 原来这里什么都不显示 ⇒ 卡片只剩「写入 552 行」，文件名要等流完才蹦出来
           * （2026-10-12 站长反馈）。给一个占位：能从内容开头认出 HTML 时直接
           * 提示「HTML 页面」，否则用「（文件名传输中…）」—— 比空白强得多。
           */
          running && entry.tool === "write" && lines > 0 ? (
            <code className="truncate font-mono text-[11px] text-muted-foreground/70">
              {/^\s*<!doctype html|^\s*<html/i.test(entry.content ?? "")
                ? "HTML 页面（文件名传输中…）"
                : "（文件名传输中…）"}
            </code>
          ) : null
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
          {entry.tool === "write" && lines > 0 && (
            <span className="tabular-nums">
              {t("lab.tool.lines").replace("{n}", String(lines))}
            </span>
          )}
          {running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : failed ? (
            <X className="h-3.5 w-3.5 text-destructive" />
          ) : (
            <Check className="h-3.5 w-3.5 text-emerald-500" />
          )}
          {expandable && (
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 transition-transform duration-200",
                open && "rotate-90"
              )}
            />
          )}
        </span>
      </button>
      {/*
        ⚠️ 图片**不能**放进下面这个 `overflow-auto + overscroll-contain` 的 <pre>：
        手机端手指落在图上滑动时，滚动会被这个容器吃掉、又因为 overscroll-contain
        不往上传，结果**整页划不动**（2026-10-13 站长反馈）。所以图片单独一块渲染，
        并给 `touch-pan-y` 把纵向手势交还给页面滚动。
      */}
      {open && entry.image && (
        <div className="border-t border-border/60 p-2">
          <img
            src={entry.image}
            alt="页面截图"
            onClick={() => setZoom(entry.image ?? null)}
            className="max-h-[70vh] w-auto max-w-full cursor-zoom-in touch-pan-y rounded border border-border/60"
          />
        </div>
      )}
      {open && expandable && !entry.image && (
        <pre
          ref={bodyRef}
          onScroll={onBodyScroll}
          className="max-h-64 animate-in fade-in overflow-auto overscroll-contain border-t border-border/70 bg-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed duration-150"
        >
          {entry.tool === "replace" ? (
            <ReplaceDiff content={entry.content} />
          ) : (
            entry.content
          )}
        </pre>
      )}
      {/*
        灯箱：点图放大。点任意处 / 再点图关闭。
        `touch-auto` 是有意的 —— 让系统的手势（双指缩放、拖动）照常可用，
        这样手机上能自己捏合放大看细节。
      */}
      {zoom && (
        <div
          onClick={() => setZoom(null)}
          className="fixed inset-0 z-[100] flex items-center justify-center overflow-auto bg-black/85 p-3"
        >
          <img
            src={zoom}
            alt="页面截图"
            className="max-h-full max-w-full touch-auto rounded"
          />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 模型选择器
// ---------------------------------------------------------------------------

export function ModelPicker({
  models,
  value,
  loading,
  failed,
  onChange,
  channel,
  onChannelChange,
  custom,
  onEditChannel,
  stationFree = false,
  stationFreeModels = [],
  siteChannels = [],
  siteChannelId = "",
  onSiteChannelChange,
  siteQuotaHint = "",
}: {
  models: string[]
  value: string
  loading: boolean
  /** 拉取失败（不是「一个模型都没有」）—— 空列表时的文案要区分这两种情况 */
  failed?: boolean
  onChange: (m: string) => void
  channel: LabChannel
  onChannelChange: (c: LabChannel) => void
  custom: CustomChannel | null
  onEditChannel: () => void
  /** 站内模型走的是管理员的统一 Key ⇒ 标「免费试用」 */
  stationFree?: boolean
  /**
   * 具体哪些站内模型免费（服务端按白名单算好）。
   * 徽标只认它 —— 管理员可以把白名单收窄到几个模型，其余的不该被标成免费。
   */
  stationFreeModels?: string[]
  /** 管理员提供的免费渠道；为空则不显示「免费渠道」这一档 */
  siteChannels?: SiteChannel[]
  siteChannelId?: string
  onSiteChannelChange?: (id: string) => void
  /** 免费额度余量文案（空则不显示） */
  siteQuotaHint?: string
}) {
  const { t } = useT()
  const [open, setOpen] = React.useState(false)
  const [keyword, setKeyword] = React.useState("")

  const filtered = React.useMemo(() => {
    const k = keyword.trim().toLowerCase()
    const list = k ? models.filter((m) => m.toLowerCase().includes(k)) : models
    return list.slice(0, 300)
  }, [models, keyword])

  const isStation = channel === "station"
  const isSite = channel === "site"
  const activeSite = isSite ? siteChannels.find((c) => c.id === siteChannelId) ?? null : null

  const label = isStation
    ? loading
      ? t("lab.model.loading")
      : value || t("lab.model.placeholder")
    : isSite
      ? activeSite?.name || t("lab.channel.sitePick")
      : custom?.model || t("lab.channel.settings")

  /**
   * 渠道三档。中间那档「免费渠道」**有内容才出现** ——
   * 管理员没配渠道时显示一个空列表比不显示更让人困惑。
   */
  const tabs: { key: LabChannel; text: string }[] = [
    { key: "station", text: t("lab.channel.station") },
  ]
  if (siteChannels.length > 0) tabs.push({ key: "site", text: t("lab.channel.site") })
  tabs.push({ key: "custom", text: t("lab.channel.custom") })

  /**
   * 两枚小标刻意分开：
   *   · 站内模型 → 「免费试用」（**会**计入每人的免费额度，用完就没了）
   *   · 免费渠道 → 「免费使用」（站长提供的渠道，同样计数，但语义上是「有这条就能用」）
   * 统一写成一个词会让用户以为两者是同一回事。
   */
  const freeTag = (text: string) => (
    <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] leading-none text-primary">
      {text}
    </span>
  )

  /** 这个模型是不是能白用（服务端已经按白名单算过，这里只做包含判断） */
  const isModelFree = (m: string) => stationFreeModels.includes(m)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-8 min-w-0 max-w-[140px] shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-background/60 px-3 text-xs text-muted-foreground transition-colors hover:text-foreground sm:max-w-[220px]"
        >
          {isStation && loading ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          ) : isStation ? (
            <Sparkles className="h-3.5 w-3.5 shrink-0 opacity-70" />
          ) : isSite ? (
            <Gift className="h-3.5 w-3.5 shrink-0 opacity-70" />
          ) : (
            <Settings2 className="h-3.5 w-3.5 shrink-0 opacity-70" />
          )}
          <span className="truncate">{label}</span>
          {isSite
            ? freeTag(t("lab.free.channelBadge"))
            : isStation && isModelFree(value)
              ? freeTag(t("lab.free.trialBadge"))
              : null}
          <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="pointer-events-auto w-72 p-2">
        {/*
          渠道切换从输入框常驻位搬到这里（2026-10-09）。
          原来它和模型选择器并排占着输入框底部，加了思考强度之后一行放不下；
          它本来就只影响「用哪个模型」，收进模型面板最自然，输入框也清爽了。
        */}
        {/*
          ⚠️ 这里是「朴素模式」那一支（动效开着时整条输入框都被 PromptBar 换掉了，
          不会走到这儿），所以保持原来的瞬时切换写法即可。
        */}
        <div className="mb-2 flex items-center gap-0.5 rounded-full bg-muted/70 p-0.5">
          {tabs.map(({ key, text }) => (
            <button
              key={key}
              type="button"
              onClick={() => onChannelChange(key)}
              className={cn(
                "flex-1 rounded-full px-2.5 py-1 text-xs transition-colors",
                channel === key
                  ? "bg-background font-medium shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {text}
            </button>
          ))}
        </div>

        {isStation ? (
          <>
            {stationFree && (
              <p className="mb-2 rounded-md bg-muted/60 px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
                {t("lab.free.stationHint")}
              </p>
            )}
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={t("lab.model.search")}
              className="mb-2 h-8 text-xs"
            />
            <div className="max-h-60 overflow-y-auto">
              {filtered.length === 0 ? (
                <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                  {failed ? t("lab.err.modelsFailed") : t("lab.model.empty")}
                </p>
              ) : (
                filtered.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent",
                      m === value && "bg-accent font-medium"
                    )}
                    onClick={() => {
                      onChange(m)
                      setOpen(false)
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{m}</span>
                    {isModelFree(m) && freeTag(t("lab.free.trialBadge"))}
                  </button>
                ))
              )}
            </div>
          </>
        ) : isSite ? (
          <div className="space-y-1">
            <p className="px-1 pb-1.5 text-[11px] leading-relaxed text-muted-foreground">
              {t("lab.channel.siteHint")}
            </p>
            {siteChannels.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  onSiteChannelChange?.(c.id)
                  setOpen(false)
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent",
                  c.id === siteChannelId && "bg-accent font-medium"
                )}
              >
                <Gift className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                {c.model && (
                  <span className="shrink-0 text-[10px] text-muted-foreground">{c.model}</span>
                )}
                {freeTag(t("lab.free.channelBadge"))}
              </button>
            ))}
            {siteQuotaHint && (
              <p className="px-1 pt-1.5 text-[11px] text-muted-foreground">{siteQuotaHint}</p>
            )}
          </div>
        ) : (
          <div className="space-y-2 px-1 pt-1 pb-0.5">
            <p className="text-xs leading-relaxed text-muted-foreground">
              {custom?.model
                ? t("lab.channel.current", { model: custom.model })
                : t("lab.channel.notConfigured")}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-full gap-1.5 text-xs"
              onClick={() => {
                setOpen(false)
                onEditChannel()
              }}
            >
              <Settings2 className="h-3.5 w-3.5" />
              {t("lab.channel.settings")}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

/**
 * 思考强度滑块（参考 Codex）。
 *
 * 它改两件事：温度（所有模型都生效）+ reasoning_effort（只有推理型模型生效）。
 * 面板里必须把「越高越费时间越费额度」讲明白，别让它看起来像个装饰。
 */
export function EffortPicker({
  value,
  onChange,
}: {
  value: EffortLevel
  onChange: (lv: EffortLevel) => void
}) {
  const { t } = useT()
  const [open, setOpen] = React.useState(false)
  const max = EFFORT_LEVELS.length - 1
  const idx = EFFORT_LEVELS.indexOf(value)
  /**
   * 滑块的**连续位置**（0..max 的浮点数）。
   *
   * 挡位本身是离散的，但滑块不该「一格一格生跳」—— 拖动时按浮点值走，
   * 只在**取值**时四舍五入到最近的挡位（`Math.round`）。
   * 外部把 value 改掉时（例如恢复默认）再把位置同步过去。
   */
  const [pos, setPos] = React.useState(idx)
  React.useEffect(() => setPos(idx), [idx])
  const pct = max === 0 ? 0 : (pos / max) * 100

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={t("lab.effort")}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-background/60 px-3 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <Gauge className="h-3.5 w-3.5 shrink-0 opacity-70" />
          <span className="tabular-nums">{t(EFFORT_LABEL_KEY[value])}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="pointer-events-auto w-64 p-3">
        <div className="mb-2.5 flex items-baseline justify-between gap-2">
          <p className="text-xs font-medium">{t("lab.effort")}</p>
          <span className="text-xs tabular-nums text-muted-foreground">
            {t(EFFORT_LABEL_KEY[value])}
          </span>
        </div>

        {/* 粗管道滑块：底下是粗轨道，上面盖一层已选进度 + 挡位刻度 + 圆滑块 */}
        <div className="relative h-6">
          <div className="absolute inset-x-0 top-1/2 h-2.5 -translate-y-1/2 rounded-full bg-muted" />
          <div
            className="absolute left-0 top-1/2 h-2.5 -translate-y-1/2 rounded-full bg-primary transition-[width] duration-150 ease-out"
            style={{ width: `${pct}%` }}
          />
          {/* 挡位刻度：贴着管道的小凹点，让「有几档」一眼可见 */}
          {EFFORT_LEVELS.map((lv, i) => (
            <span
              key={lv}
              className="absolute top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-background/80"
              style={{ left: `${max === 0 ? 0 : (i / max) * 100}%` }}
            />
          ))}
          {/* 圆滑块：位置由浮点值算，所以拖动是连续的 */}
          <div
            className="pointer-events-none absolute top-1/2 h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-background shadow-sm transition-[left] duration-150 ease-out"
            style={{ left: `${pct}%` }}
          />
          {/* 真正的输入：完全透明盖在上面，键盘 / 无障碍 / 拖拽都靠它 */}
          <input
            type="range"
            min={0}
            max={max}
            step="any"
            value={pos}
            aria-label={t("lab.effort")}
            onChange={(e) => {
              const v = Number(e.target.value)
              setPos(v)
              onChange(EFFORT_LEVELS[Math.round(v)])
            }}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
        </div>

        <div className="mt-1.5 flex justify-between">
          {EFFORT_LEVELS.map((lv) => (
            <button
              key={lv}
              type="button"
              onClick={() => onChange(lv)}
              className={cn(
                "rounded px-1 text-[11px] transition-colors",
                lv === value
                  ? "font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t(EFFORT_LABEL_KEY[lv])}
            </button>
          ))}
        </div>
        <p className="mt-3 border-t pt-2.5 text-[11px] leading-relaxed text-muted-foreground">
          {t(EFFORT_DESC_KEY[value])}
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/70">
          {t("lab.effort.note")}
        </p>
      </PopoverContent>
    </Popover>
  )
}

/** 自定义渠道设置弹窗 */
export function ChannelDialog({
  open,
  onOpenChange,
  initial,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initial: CustomChannel | null
  onSave: (next: CustomChannel) => void
}) {
  const { t } = useT()
  const [baseUrl, setBaseUrl] = React.useState("")
  const [apiKey, setApiKey] = React.useState("")
  const [model, setModel] = React.useState("")
  /** 识别出来的候选模型（服务端代拉，见 probeModels 的注释） */
  const [fetched, setFetched] = React.useState<string[]>([])
  /** 勾选的模型（多选） */
  const [picked, setPicked] = React.useState<string[]>([])
  const [probing, setProbing] = React.useState(false)

  React.useEffect(() => {
    if (open) {
      setBaseUrl(initial?.baseUrl ?? "")
      setApiKey(initial?.apiKey ?? "")
      setModel(initial?.model ?? "")
      setPicked(initial?.models?.length ? initial.models : initial?.model ? [initial.model] : [])
      setFetched([])
    }
  }, [open, initial])

  /** 去对方服务拉一次可用模型。拉不到不影响手填 —— 只是少了个省事的路子 */
  const probe = async () => {
    if (!baseUrl.trim()) {
      toast.error(t("lab.channel.errNoUrl"))
      return
    }
    setProbing(true)
    try {
      const res = await labApi.probeModels({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim() })
      setFetched(res.models)
      // 已经勾过、且新列表里还有的保留；其余清掉（避免留下已不存在的模型）
      setPicked((prev) => prev.filter((m) => res.models.includes(m)))
      toast.success(t("lab.channel.probed", { n: res.models.length }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("lab.channel.probeFailed"))
    } finally {
      setProbing(false)
    }
  }

  const togglePick = (m: string) =>
    setPicked((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]))

  const submit = () => {
    if (!baseUrl.trim()) {
      toast.error(t("lab.channel.errNoUrl"))
      return
    }
    // 勾了就用勾的；没勾就用（或手填的）单个模型
    const list = picked.length ? picked : model.trim() ? [model.trim()] : []
    onSave({
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      model: list[0] ?? "",
      models: list,
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("lab.channel.custom")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {t("lab.channel.customHint")}
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="lab-ch-url">{t("lab.channel.baseUrl")}</Label>
            <Input
              id="lab-ch-url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={t("lab.channel.baseUrlPlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lab-ch-key">{t("lab.channel.apiKey")}</Label>
            <Input
              id="lab-ch-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={t("lab.channel.keyPlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="lab-ch-model">{t("lab.channel.modelName")}</Label>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[11px]"
                disabled={probing}
                onClick={() => void probe()}
              >
                {probing ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                {probing ? t("lab.channel.probing") : t("lab.channel.probe")}
              </Button>
            </div>
            {/*
              ⚠️ 手填这一栏**必须保留**：有些服务商不提供 /models，
              或地址写法特殊导致识别失败 —— 那时还能手动写。
            */}
            <Input
              id="lab-ch-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={t("lab.channel.modelPlaceholder")}
            />
            {fetched.length > 0 ? (
              <div className="max-h-44 space-y-0.5 overflow-y-auto rounded-lg border p-1.5">
                <p className="px-1 pb-1 text-[11px] text-muted-foreground">
                  {t("lab.channel.pickHint")}
                </p>
                {fetched.map((m) => (
                  <label
                    key={m}
                    className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-accent"
                  >
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 shrink-0 accent-[var(--primary)]"
                      checked={picked.includes(m)}
                      onChange={() => togglePick(m)}
                    />
                    <span className="truncate">{m}</span>
                  </label>
                ))}
              </div>
            ) : null}
            {picked.length > 0 ? (
              <p className="text-[11px] text-muted-foreground">
                {t("lab.channel.pickedCount", { n: picked.length })}
              </p>
            ) : null}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("lab.save.cancel")}
          </Button>
          <Button onClick={submit}>{t("lab.channel.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 「技能」对话框（2026-10-10）。
 *
 * 入口是输入框「+」菜单里的「技能」——那一条被 `onSource` 劫持了，
 * 所以点它不会往输入框里插 `@技能`，而是开这里。
 *
 * 两类技能都在这里看得见：
 *   · 站点默认（管理员在后台维护，所有人可用）—— 只能看，删不了；
 *   · 自己导入的 —— 可以删。
 *
 * ⚠️ 用户**不需要**在对话里 @ 某个技能：系统提示里已经带了技能目录，
 *    模型自己判断该不该用。这个对话框存在的意义是「往里加料 / 看看有什么」。
 */
export function SkillDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const { t } = useT()
  const [items, setItems] = React.useState<LabSkillEntry[]>([])
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [formOpen, setFormOpen] = React.useState(false)
  const [name, setName] = React.useState("")
  const [desc, setDesc] = React.useState("")
  const [content, setContent] = React.useState("")

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await labApi.listSkills()
      setItems(res.skills)
    } catch {
      /* 拉不到就当空的，不弹错 —— 这里只是「查看/添加」，不该打断用户 */
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (open) void load()
  }, [open, load])

  const resetForm = () => {
    setName("")
    setDesc("")
    setContent("")
    setFormOpen(false)
  }

  const submit = async () => {
    setBusy(true)
    try {
      await labApi.importSkill({ name, description: desc, content })
      toast.success(t("lab.skill.imported"))
      resetForm()
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("lab.skill.importFailed"))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (row: LabSkillEntry) => {
    const ok = await confirmDialog({
      title: t("lab.skill.delete"),
      desc: t("lab.skill.deleteConfirm"),
      okText: t("common.delete"),
      danger: true,
    })
    if (!ok) return
    try {
      await labApi.deleteSkill(row.id)
      setItems((prev) => prev.filter((x) => x.id !== row.id))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("lab.skill.importFailed"))
    }
  }

  const canSubmit = name.trim() && desc.trim() && content.trim() && !busy

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) resetForm()
        onOpenChange(o)
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("lab.skill.title")}</DialogTitle>
          <DialogDescription>{t("lab.skill.desc")}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[38vh] space-y-1.5 overflow-y-auto">
          {loading ? (
            <p className="rounded-md border border-dashed p-5 text-center text-xs text-muted-foreground">
              {t("lab.skill.loading")}
            </p>
          ) : items.length === 0 ? (
            <p className="rounded-md border border-dashed p-5 text-center text-xs text-muted-foreground">
              {t("lab.skill.empty")}
            </p>
          ) : (
            items.map((row) => (
              <div key={row.id} className="flex items-start gap-2 rounded-lg border p-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                      {row.name}
                    </code>
                    <span className="text-[10px] text-muted-foreground">
                      {row.mine ? t("lab.skill.mine") : t("lab.skill.fromSite")}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {row.description}
                  </p>
                </div>
                {row.mine && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => void remove(row)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            ))
          )}
        </div>

        {formOpen ? (
          <div className="space-y-2 border-t pt-3">
            <div className="space-y-1">
              <Label className="text-xs">{t("lab.skill.name")}</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="pdf-forms"
              />
              <p className="text-[11px] text-muted-foreground">{t("lab.skill.nameHint")}</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t("lab.skill.descLabel")}</Label>
              <Input
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                placeholder={t("lab.skill.descPlaceholder")}
              />
              <p className="text-[11px] text-muted-foreground">{t("lab.skill.descHint")}</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t("lab.skill.content")}</Label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={7}
                className="w-full resize-none rounded-md border bg-transparent px-3 py-2 font-mono text-[12px] leading-relaxed outline-none placeholder:text-muted-foreground/70"
                placeholder={t("lab.skill.contentPlaceholder")}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={resetForm}>
                {t("common.cancel")}
              </Button>
              <Button size="sm" disabled={!canSubmit} onClick={() => void submit()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {t("lab.skill.import")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end border-t pt-3">
            <Button variant="outline" size="sm" onClick={() => setFormOpen(true)}>
              <Plus className="h-4 w-4" />
              {t("lab.skill.import")}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * 「联网搜索」对话框（2026-10-10）。
 *
 * 从输入框「+」菜单的「联网搜索」进来。这里只做两件事：
 *   · 告诉用户当前能不能搜、走站点 key 要花多少积分；
 *   · 让他填一把自己的 Tavily key（**填了自己的就不扣积分**）。
 *
 * ⚠️ 自己的 key 只在这里填、只存服务端密文；这个框只显示「有没有配」，不回显内容。
 */
export function SearchKeyDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const { t } = useT()
  const [info, setInfo] = React.useState<{
    hasOwn: boolean
    siteAvailable: boolean
    cost: number
    enabled: boolean
    webSearchEnabled: boolean
  } | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [draft, setDraft] = React.useState("")

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      setInfo(await labApi.searchKeyInfo())
    } catch {
      /* 拿不到就当不支持，界面照常显示，不弹错 */
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (open) {
      setDraft("")
      void load()
    }
  }, [open, load])

  const save = async (payload: { key?: string; webSearchEnabled?: boolean }) => {
    setBusy(true)
    try {
      const res = await labApi.setSearchKey(payload)
      setInfo((prev) => (prev ? { ...prev, ...res } : prev))
      if ("key" in payload) {
        setDraft("")
        toast.success(payload.key ? t("lab.search.saved") : t("lab.search.cleared"))
      } else {
        toast.success(
          payload.webSearchEnabled ? t("lab.search.turnedOn") : t("lab.search.turnedOff")
        )
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("lab.search.saveFailed"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("lab.search.title")}</DialogTitle>
          <DialogDescription>{t("lab.search.desc")}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="rounded-md border border-dashed p-5 text-center text-xs text-muted-foreground">
            {t("lab.skill.loading")}
          </p>
        ) : (
          <div className="space-y-3">
            {/*
              总开关放最上面：关着时**模型根本不知道有这个工具**，所以也就不会被扣分。
              默认关（新用户不做任何操作就不会花钱）。
            */}
            <label className="flex cursor-pointer items-start gap-2 rounded-lg border p-2.5">
              <input
                type="checkbox"
                className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--primary)]"
                checked={info?.webSearchEnabled === true}
                disabled={busy}
                onChange={(e) => void save({ webSearchEnabled: e.target.checked })}
              />
              <span className="text-xs leading-relaxed">
                <span className="font-medium">{t("lab.search.toggle")}</span>
                <span className="mt-0.5 block text-muted-foreground">
                  {t("lab.search.toggleHint")}
                </span>
              </span>
            </label>

            <div className="rounded-lg border p-2.5 text-xs leading-relaxed">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">{t("lab.search.siteKey")}</span>
                <span className={info?.siteAvailable ? "" : "text-muted-foreground"}>
                  {info?.siteAvailable
                    ? t("lab.search.siteCost", { n: info.cost })
                    : t("lab.search.siteNone")}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="text-muted-foreground">{t("lab.search.ownKey")}</span>
                <span className={info?.hasOwn ? "" : "text-muted-foreground"}>
                  {info?.hasOwn ? t("lab.search.ownSet") : t("lab.search.ownUnset")}
                </span>
              </div>
            </div>

            {info?.enabled === false ? (
              <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                {t("lab.search.disabled")}
              </p>
            ) : (
              <div className="space-y-1.5">
                <Label className="text-xs">{t("lab.search.keyLabel")}</Label>
                <Input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="tvly-dev-…"
                  type="password"
                />
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t("lab.search.keyHint")}
                </p>
                <div className="flex justify-end gap-2">
                  {info?.hasOwn && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void save({ key: "" })}
                    >
                      {t("lab.search.clear")}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    disabled={busy || !draft.trim()}
                    onClick={() => void save({ key: draft.trim() })}
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {t("common.save")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
