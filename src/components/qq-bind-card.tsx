/**
 * 账号设置里的「QQ 绑定」卡片（2026-10-24）。
 *
 * 与 Telegram 绑定同一套流程：**站内生成一次性码 → 到 QQ 里 /bind**，
 * 绝不让用户在机器人里输入账号密码。
 *
 * 与 TG 的差别：QQ 没有 `t.me/<bot>?start=<码>` 那种深链，所以这里只给
 * 「去 QQ 搜机器人 + 发送 /bind 码」的提示，用户手动发一次命令即可。
 */
import * as React from "react"
import { Check, Copy, Unlink } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { errMsg, qqBindApi } from "@/services/api"
import { fmtDateTime } from "@/lib/format"
import { useT } from "@/i18n"

export function QqBindCard() {
  const { t } = useT()
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [state, setState] = React.useState<{
    bound: boolean
    shortId?: string
    scope?: "c2c" | "group"
    label?: string
    boundAt?: number
    count?: number
  }>({ bound: false })
  const [code, setCode] = React.useState<{ code: string; expiresAt: number; qqBotHint?: string } | null>(
    null
  )
  const [copied, setCopied] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const st = await qqBindApi.status()
      setState(st)
    } catch {
      // 接口未就绪时静默降级，不影响设置页其它功能
      setState({ bound: false })
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  async function gen() {
    setBusy(true)
    try {
      const r = await qqBindApi.createCode()
      if (r.alreadyBound) {
        toast.info(t("qqb.alreadyBound"))
        await load()
      } else if (r.code && r.expiresAt) {
        setCode({ code: r.code, expiresAt: r.expiresAt, qqBotHint: r.qqBotHint })
      }
    } catch (e) {
      toast.error(errMsg(e, t("api.networkError")))
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    if (!code) return
    try {
      await navigator.clipboard.writeText(code.code)
      setCopied(true)
      toast.success(t("common.copied"))
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error(errMsg(new Error("clipboard"), t("api.networkError")))
    }
  }

  async function unbind() {
    if (!window.confirm(t("qqb.unbind") + "?")) return
    setBusy(true)
    try {
      await qqBindApi.unbind()
      toast.success(t("common.saved"))
      setCode(null)
      await load()
    } catch (e) {
      toast.error(errMsg(e, t("api.networkError")))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base">{t("qqb.title")}</CardTitle>
            <CardDescription className="mt-1">{t("qqb.desc")}</CardDescription>
          </div>
          <Badge variant={state.bound ? "default" : "secondary"}>
            {state.bound ? t("qqb.bound") : t("qqb.notBound")}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="h-9 animate-pulse rounded bg-muted" />
        ) : state.bound ? (
          <>
            <div className="space-y-1 text-sm text-muted-foreground">
              <div>
                {state.scope === "group" ? "绑定于 QQ 群" : "绑定于 QQ 私聊"}
                {state.shortId ? ` · 标识 ${state.shortId}` : ""}
                {state.count && state.count > 1 ? `（共 ${state.count} 个）` : ""}
              </div>
              <div>{state.boundAt ? fmtDateTime(new Date(state.boundAt).toISOString()) : ""}</div>
            </div>
            <Button variant="outline" size="sm" disabled={busy} onClick={unbind}>
              <Unlink className="mr-1.5 h-3.5 w-3.5" />
              {t("qqb.unbind")}
            </Button>
          </>
        ) : code ? (
          <>
            <div className="flex items-center gap-2">
              <code className="rounded bg-muted px-3 py-1.5 font-mono text-lg tracking-widest">
                {code.code}
              </code>
              <Button variant="outline" size="icon" onClick={copy} aria-label={t("common.copy")}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("qqb.codeHint", { code: code.code })}
            </p>
            <p className="text-xs text-muted-foreground">{t("qqb.expiresHint")}</p>
            {code.qqBotHint && <p className="text-xs text-muted-foreground">{t("qqb.searchBot")}</p>}
          </>
        ) : (
          <Button size="sm" disabled={busy} onClick={gen}>
            {t("qqb.gen")}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
