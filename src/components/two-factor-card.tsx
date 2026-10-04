/**
 * 设置页的「二次认证」卡片。
 *
 * 三种状态：
 *   1. 未开启 —— 给出两种开启方式（认证器 App / 邮箱码）；
 *   2. 配置中（TOTP）—— 显示二维码与密钥，等用户输一次动态码确认；
 *   3. 已开启 —— 展示启用的方式、剩余恢复码，并提供重新生成 / 关闭。
 *
 * ⚠️ 被强制要求 2FA 的角色（管理员 / 站长）**不能自行关闭** ——
 * 卡片会说明原因，只留「找站长重置」这条路。
 * 这是刻意的：否则拿到一个没锁屏的浏览器就能把这道锁卸掉。
 */
import * as React from "react"
import * as QRCode from "qrcode"
import { toast } from "sonner"
import { Loader2, ShieldCheck, KeyRound, Mail, Copy, AlertTriangle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { twoFactorApi, errMsg } from "@/services/api"
import { useT } from "@/i18n"

type Status = {
  enabled: boolean
  methods: string[]
  totpConfirmed: boolean
  emailEnabled: boolean
  recoveryLeft: number
  enforced: boolean
  maskedEmail: string
}

export function TwoFactorCard() {
  const { t } = useT()
  const [status, setStatus] = React.useState<Status | null>(null)
  const [busy, setBusy] = React.useState(false)

  /** TOTP 配置中的临时数据（未确认前不落库，所以只存在前端） */
  const [setup, setSetup] = React.useState<{ secret: string; otpauthUrl: string } | null>(null)
  const [code, setCode] = React.useState("")
  /** 刚生成/确认后的恢复码明文 —— 只在内存里，刷新即消失（库里只有哈希） */
  const [recoveryCodes, setRecoveryCodes] = React.useState<string[] | null>(null)
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)

  const load = React.useCallback(async () => {
    try {
      setStatus(await twoFactorApi.status())
    } catch (err) {
      toast.error(errMsg(err, t("s2fa.loadFailed")))
    }
  }, [t])

  React.useEffect(() => {
    void load()
  }, [load])

  // 拿到 otpauth 链接后画二维码
  React.useEffect(() => {
    if (!setup || !canvasRef.current) return
    void QRCode.toCanvas(canvasRef.current, setup.otpauthUrl, {
      width: 180,
      margin: 1,
    }).catch(() => {
      toast.error(t("s2fa.qrFailed"))
    })
  }, [setup, t])

  const startTotp = async () => {
    setBusy(true)
    try {
      const res = await twoFactorApi.startTotp()
      setSetup(res)
      setCode("")
    } catch (err) {
      toast.error(errMsg(err, t("s2fa.startFailed")))
    } finally {
      setBusy(false)
    }
  }

  const confirmTotp = async () => {
    setBusy(true)
    try {
      const res = await twoFactorApi.confirmTotp(code.trim())
      setRecoveryCodes(res.recoveryCodes)
      setSetup(null)
      setCode("")
      await load()
      toast.success(t("s2fa.totpEnabled"))
    } catch (err) {
      toast.error(errMsg(err, t("s2fa.confirmFailed")))
    } finally {
      setBusy(false)
    }
  }

  const toggleEmail = async (enabled: boolean) => {
    setBusy(true)
    try {
      await twoFactorApi.setEmail(enabled)
      await load()
      toast.success(enabled ? t("s2fa.emailOn") : t("s2fa.emailOff"))
    } catch (err) {
      toast.error(errMsg(err, t("s2fa.opFailed")))
    } finally {
      setBusy(false)
    }
  }

  const disableTotp = async () => {
    setBusy(true)
    try {
      await twoFactorApi.disableTotp()
      await load()
      toast.success(t("s2fa.totpOff"))
    } catch (err) {
      toast.error(errMsg(err, t("s2fa.opFailed")))
    } finally {
      setBusy(false)
    }
  }

  const regenerate = async () => {
    setBusy(true)
    try {
      const res = await twoFactorApi.regenerateRecovery()
      setRecoveryCodes(res.recoveryCodes)
      await load()
      toast.success(t("s2fa.recoveryRegenerated"))
    } catch (err) {
      toast.error(errMsg(err, t("s2fa.opFailed")))
    } finally {
      setBusy(false)
    }
  }

  const copySecret = async () => {
    if (!setup) return
    try {
      await navigator.clipboard.writeText(setup.secret)
      toast.success(t("s2fa.secretCopied"))
    } catch {
      toast.error(t("s2fa.copyFailed"))
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4" />
          {t("s2fa.title")}
          {status?.enforced && (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-normal text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">
              {t("s2fa.required")}
            </span>
          )}
        </CardTitle>
        <CardDescription>
          {status?.enforced ? t("s2fa.descRequired") : t("s2fa.descOptional")}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {!status ? (
          <div className="py-6">
            <Loader2 className="mx-auto h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : recoveryCodes ? (
          /* 恢复码只在这里出现一次，给足提示 */
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t("s2fa.recoveryWarn")}</span>
            </div>
            <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/40 p-3 font-mono text-sm sm:grid-cols-3">
              {recoveryCodes.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(recoveryCodes.join("\n"))
                    .then(() => toast.success(t("s2fa.recoveryCopied")))
                    .catch(() => toast.error(t("s2fa.copyFailed")))
                }}
              >
                <Copy className="mr-1 h-3.5 w-3.5" />
                {t("s2fa.copyAll")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRecoveryCodes(null)}>
                {t("s2fa.savedIt")}
              </Button>
            </div>
          </div>
        ) : setup ? (
          /* TOTP 配置中 */
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{t("s2fa.scanHint")}</p>
            <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
              <div className="rounded-md border bg-white p-2">
                <canvas ref={canvasRef} />
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-xs text-muted-foreground">{t("s2fa.manualHint")}</p>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
                    {setup.secret}
                  </code>
                  <Button size="sm" variant="outline" onClick={() => void copySecret()}>
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="s2fa-code">{t("s2fa.confirmLabel")}</Label>
              <Input
                id="s2fa-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                maxLength={6}
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" disabled={busy || code.trim().length < 6} onClick={() => void confirmTotp()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t("s2fa.confirm")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSetup(null)
                  setCode("")
                }}
              >
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          /* 正常状态：展示与开关 */
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between rounded-md border p-3">
                <div className="flex items-center gap-2 text-sm">
                  <KeyRound className="h-4 w-4 text-muted-foreground" />
                  <span>{t("s2fa.methodTotp")}</span>
                  {status.totpConfirmed && (
                    <span className="text-xs text-emerald-600 dark:text-emerald-400">
                      {t("s2fa.on")}
                    </span>
                  )}
                </div>
                {status.totpConfirmed ? (
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void disableTotp()}>
                      {t("s2fa.disable")}
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void startTotp()}>
                      {t("s2fa.reset")}
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" disabled={busy} onClick={() => void startTotp()}>
                    {t("s2fa.enable")}
                  </Button>
                )}
              </div>

              <div className="flex items-center justify-between rounded-md border p-3">
                <div className="flex items-center gap-2 text-sm">
                  <Mail className="h-4 w-4 text-muted-foreground" />
                  <span>{t("s2fa.methodEmail")}</span>
                  <span className="text-xs text-muted-foreground">{status.maskedEmail}</span>
                </div>
                <Button
                  size="sm"
                  variant={status.emailEnabled ? "outline" : "default"}
                  disabled={busy}
                  onClick={() => void toggleEmail(!status.emailEnabled)}
                >
                  {status.emailEnabled ? t("s2fa.disable") : t("s2fa.enable")}
                </Button>
              </div>
            </div>

            {status.enabled && (
              <div className="flex items-center justify-between rounded-md border p-3">
                <div className="text-sm">
                  {t("s2fa.recoveryLeft", { n: status.recoveryLeft })}
                </div>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void regenerate()}>
                  {t("s2fa.regenerate")}
                </Button>
              </div>
            )}

            {/* 2026-10-04 ventus 反馈：原「关闭全部二次认证」红色按钮毫无意义 ——
                TOTP 和邮箱验证各有自己的开关，用户自由开关每一种即可；两个都关掉
                二次认证自然完全关闭。红色按钮反而要求输入一个用户未必有的码，把人
                引向死路。故整块移除。 */}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
