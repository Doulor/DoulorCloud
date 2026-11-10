import * as React from "react"
import { Copy, Loader2, Lock } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { aiAccessApi, HttpError } from "@/services/api"
import { useT } from "@/i18n"
import { cn } from "@/lib/utils"

/**
 * 「付费直连地址」展示块（2026-11-02）
 *
 * 规则：
 *   - 默认一律是马赛克，**谁都不自动显示**
 *   - 持有称号「赞助伙伴」→ 点一下直接查看（不需要码）
 *   - 其他人 → 点一下弹窗输认证码，通过后查看
 *
 * 安全性：GET 接口只返回「有没有资格」，地址本身要点下去（reveal / unlock）才下发，
 * 所以页面加载时任何响应里都拿不到地址；马赛克里放的是假占位串。
 */
const LS_KEY = "doulor.ai.direct.url"
const SAMPLE = "https://direct-XXXXXXXXXXXX.example/v1"

export function AiDirectEndpoint() {
  const { t } = useT()
  const [loading, setLoading] = React.useState(true)
  /** 有资格查看（称号持有人，或本机曾用认证码解锁） */
  const [canReveal, setCanReveal] = React.useState(false)
  const [reason, setReason] = React.useState<string | null>(null)
  /** 只有用户主动点击后才填充，初始恒为 null */
  const [url, setUrl] = React.useState<string | null>(null)
  const [cached, setCached] = React.useState<string | null>(null)
  const [open, setOpen] = React.useState(false)
  const [code, setCode] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await aiAccessApi.directEndpoint()
        if (!alive) return
        if (res.unlocked) {
          setCanReveal(true)
          setReason(res.reason ?? "title")
        } else {
          let saved: string | null = null
          try {
            saved = localStorage.getItem(LS_KEY)
          } catch {
            saved = null
          }
          if (saved) {
            setCanReveal(true)
            setReason("code")
            setCached(saved)
          }
        }
      } catch {
        /* 未登录或接口异常：保持锁定态 */
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      toast.success(t("ai.access.directCopied"))
    } catch {
      toast.error(t("common.copyFailed"))
    }
  }

  /** 点击马赛克：有资格就直接揭开，没资格就弹认证码 */
  async function handleReveal() {
    if (!canReveal) {
      setOpen(true)
      return
    }
    if (reason === "code" && cached) {
      setUrl(cached)
      return
    }
    setBusy(true)
    try {
      const res = await aiAccessApi.revealDirect()
      setUrl(res.url)
      toast.success(t("ai.access.directUnlocked"))
    } catch (err) {
      const msg = err instanceof HttpError ? err.message : t("ai.access.directWrong")
      toast.error(msg)
    } finally {
      setBusy(false)
    }
  }

  async function submit() {
    const value = code.trim()
    if (!value) return
    setBusy(true)
    try {
      const res = await aiAccessApi.unlockDirect(value)
      setUrl(res.url)
      setCanReveal(true)
      setReason("code")
      setCached(res.url)
      try {
        localStorage.setItem(LS_KEY, res.url)
      } catch {
        /* ignore */
      }
      setOpen(false)
      setCode("")
      toast.success(t("ai.access.directUnlocked"))
    } catch (err) {
      const msg = err instanceof HttpError ? err.message : t("ai.access.directWrong")
      toast.error(msg)
    } finally {
      setBusy(false)
    }
  }

  const unlocked = Boolean(url)

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="ai-direct-endpoint">{t("ai.access.directLabel")}</Label>
        <span className="text-xs font-medium text-destructive">
          {t("ai.access.directPerf")}
        </span>
        {reason === "title" && (
          <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-medium">
            {t("ai.access.directBadge")}
          </Badge>
        )}
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Input
            id="ai-direct-endpoint"
            readOnly
            value={unlocked ? url! : SAMPLE}
            className={cn(
              "font-mono text-sm",
              !unlocked && "select-none blur-[5px] pointer-events-none"
            )}
            tabIndex={-1}
          />
          {!unlocked && !loading && (
            <button
              type="button"
              onClick={() => void handleReveal()}
              disabled={busy}
              className="absolute inset-0 flex items-center justify-center gap-1.5 rounded-md text-xs font-medium text-foreground/80 transition-colors hover:bg-muted/50 disabled:opacity-60"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Lock className="h-3.5 w-3.5" />
              )}
              {reason === "title"
                ? t("ai.access.directClickReveal")
                : t("ai.access.directLocked")}
            </button>
          )}
          {!unlocked && loading && (
            <span className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            </span>
          )}
        </div>
        {unlocked && (
          <Button
            variant="outline"
            size="icon"
            title={t("common.copy")}
            onClick={() => void copy(url!)}
          >
            <Copy className="h-4 w-4" />
          </Button>
        )}
      </div>

      <p className="text-xs text-muted-foreground">{t("ai.access.directHint")}</p>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("ai.access.directDialogTitle")}</DialogTitle>
            <DialogDescription>{t("ai.access.directDialogDesc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="ai-direct-code">{t("ai.access.directCodeLabel")}</Label>
            <Input
              id="ai-direct-code"
              autoFocus
              value={code}
              placeholder={t("ai.access.directCodePlaceholder")}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit()
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void submit()} disabled={busy || !code.trim()}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("ai.access.directUnlock")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
