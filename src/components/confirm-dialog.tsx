import * as React from "react"
import { AlertTriangle } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useT } from "@/i18n"

/**
 * 全局确认弹窗 —— 替代浏览器自带的 `confirm` / `prompt`。
 *
 * 为什么要做成全局单例：
 *   原生弹窗跟站内风格完全割裂（移动端尤其丑），但调用点散落在帖子、反馈、
 *   API 设置、AI 实验室、管理后台等一堆地方 —— 让每个组件各自维护一份弹窗
 *   state 既啰嗦又容易漏。这里沿用 `external-link-dialog` 的做法：
 *   在 App 顶层挂**一次** `<ConfirmDialogHost/>`，各处只调
 *   `await confirmDialog({...})` / `await promptDialog({...})`。
 *
 * 未挂载时（App 之外的测试、独立渲染的页面）回落原生弹窗 —— 宁可丑，
 * 也不能出现「点了没反应」这种比丑更糟的结果。
 */

export interface ConfirmOptions {
  title: string
  desc?: string
  /** 额外展示一段等宽文本（AI 想执行的命令、要删除的对象名等） */
  detail?: string
  okText?: string
  cancelText?: string
  /** 删除类等不可逆操作 → 标题带警示图标、确认键标红 */
  danger?: boolean
  /** 需要用户输入一段文字时给（等价于 window.prompt） */
  input?: {
    placeholder?: string
    defaultValue?: string
  }
}

type Resolver = (value: string | null) => void
type Opener = (opts: ConfirmOptions, resolve: Resolver) => void

let opener: Opener | null = null

/** 弹一个确认框，返回用户是否点了「确认」 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  if (!opener) {
    const text = opts.desc ? `${opts.title}\n\n${opts.desc}` : opts.title
    return Promise.resolve(window.confirm(text))
  }
  return new Promise<boolean>((resolve) => {
    opener!(opts, (v) => resolve(v !== null))
  })
}

/** 弹一个带输入框的弹窗，返回输入内容；用户取消则返回 null（替代 `window.prompt`） */
export function promptDialog(
  opts: ConfirmOptions & { input: NonNullable<ConfirmOptions["input"]> }
): Promise<string | null> {
  if (!opener) {
    return Promise.resolve(window.prompt(opts.desc ?? opts.title, opts.input.defaultValue ?? ""))
  }
  return new Promise<string | null>((resolve) => {
    opener!(opts, resolve)
  })
}

export function ConfirmDialogHost() {
  const { t } = useT()
  const [opts, setOpts] = React.useState<ConfirmOptions | null>(null)
  const [text, setText] = React.useState("")
  const resolveRef = React.useRef<Resolver | null>(null)

  React.useEffect(() => {
    opener = (o, resolve) => {
      setText(o.input?.defaultValue ?? "")
      setOpts(o)
      resolveRef.current = resolve
    }
    return () => {
      opener = null
    }
  }, [])

  const close = (value: string | null) => {
    const resolve = resolveRef.current
    resolveRef.current = null
    setOpts(null)
    resolve?.(value)
  }

  return (
    <Dialog open={opts !== null} onOpenChange={(o) => !o && close(null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {opts?.danger && <AlertTriangle className="h-4 w-4 text-destructive" />}
            {opts?.title}
          </DialogTitle>
          {opts?.desc && <DialogDescription>{opts.desc}</DialogDescription>}
        </DialogHeader>

        {opts?.detail && (
          <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
            {opts.detail}
          </pre>
        )}

        {opts?.input && (
          <Input
            autoFocus
            value={text}
            placeholder={opts.input.placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") close(text)
            }}
          />
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => close(null)}>
            {opts?.cancelText ?? t("common.cancel")}
          </Button>
          <Button
            autoFocus={!opts?.input}
            variant={opts?.danger ? "destructive" : "default"}
            onClick={() => close(opts?.input ? text : "")}
          >
            {opts?.okText ?? t("common.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
