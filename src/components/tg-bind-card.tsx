/**
 * 账号设置里的「Telegram 绑定」卡片（2026-10-22）。
 *
 * 流程刻意做成「站内生成码 → 到 bot 里 /bind」：
 * **绝不让用户在机器人里输入账号密码**，否则 bot 一旦被冒充就是全站撞库入口。
 *
 * 绑定码由后端生成（6 位、10 分钟、单次、重复申请顶掉旧码），前端只负责展示与复制。
 */
import * as React from "react"
import { Check, Copy, ExternalLink, Send, Unlink } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { errMsg, tgBindApi } from "@/services/api"
import { fmtDateTime } from "@/lib/format"
import { useT } from "@/i18n"

export function TgBindCard() {
  const { t } = useT()
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [state, setState] = React.useState<{
    bound: boolean
    telegramId?: string
    tgUsername?: string | null
    boundAt?: number
  }>({ bound: false })
  const [code, setCode] = React.useState<{
    code: string
    expiresAt: number
    botUsername?: string | null
    botReady?: boolean
  } | null>(null)
  const [copied, setCopied] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      setState(await tgBindApi.status())
    } catch {
      // 接口未就绪时静默降级：卡片显示未绑定，不打断设置页其它功能
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
      const r = await tgBindApi.createCode()
      if (r.alreadyBound) {
        toast.info(t("tgb.alreadyBound"))
        await load()
        return
      }
      if (r.code && r.expiresAt) {
        setCode({
          code: r.code,
          expiresAt: r.expiresAt,
          botUsername: r.botUsername,
          botReady: r.botReady,
        })
      }
    } catch (e) {
      toast.error(errMsg(e, t("tgb.failed")))
    } finally {
      setBusy(false)
    }
  }

  async function unbind() {
    setBusy(true)
    try {
      await tgBindApi.unbind()
      setCode(null)
      toast.success(t("tgb.unboundDone"))
      await load()
    } catch (e) {
      toast.error(errMsg(e, t("tgb.failed")))
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    if (!code) return
    try {
      await navigator.clipboard.writeText(code.code)
      setCopied(true)
      toast.success(t("tgb.copied"))
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error(t("tgb.copyFailed"))
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Send className="h-4 w-4" />
          {t("tgb.title")}
        </CardTitle>
        <CardDescription>{t("tgb.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : state.bound ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge>{t("tgb.bound")}</Badge>
              <span className="font-mono text-xs text-muted-foreground">
                {state.tgUsername ? `@${state.tgUsername}` : state.telegramId}
              </span>
              {state.boundAt ? (
                <span className="text-xs text-muted-foreground">
                  {t("tgb.boundAt")} {fmtDateTime(new Date(state.boundAt).toISOString())}
                </span>
              ) : null}
            </div>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void unbind()}>
              <Unlink className="mr-1 h-3.5 w-3.5" />
              {t("tgb.unbind")}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{t("tgb.unbound")}</Badge>
              <Button size="sm" disabled={busy} onClick={() => void gen()}>
                {t("tgb.gen")}
              </Button>
            </div>
            {code ? (
              <div className="space-y-2 rounded-lg border p-3">
                {/* 一键深链：Telegram 会把 /start <码> 直接发给 bot，用户零输入 */}
                {code.botReady && code.botUsername ? (
                  <Button asChild size="sm" className="w-full sm:w-auto">
                    <a
                      href={`https://t.me/${code.botUsername}?start=${code.code}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ExternalLink className="mr-1 h-3.5 w-3.5" />
                      {t("tgb.oneClick")}
                    </a>
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground">{t("tgb.botNotReady")}</p>
                )}
                <p className="text-xs text-muted-foreground">{t("tgb.orManual", { code: code.code })}</p>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-2xl tracking-[0.3em]">{code.code}</span>
                  <Button size="sm" variant="ghost" onClick={() => void copy()}>
                    {copied ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("tgb.hint", { code: code.code })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("tgb.expires")} {fmtDateTime(new Date(code.expiresAt).toISOString())}
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{t("tgb.notBoundHint")}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
