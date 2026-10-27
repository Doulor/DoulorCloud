/**
 * AutoClaw（国内版）捐献卡片（2026-10-27）。
 *
 * AutoClaw 国内版**没有网页授权登录**，只能手机验证码登录，所以这张卡就是
 * 「填手机号 → 收码 → 提交」两段式，不涉及书签、不涉及跳转。
 *
 * 后端：
 *   POST /api/donations/autoclaw/sms/send   { phone }
 *   POST /api/donations/autoclaw/sms/verify { phone, code }
 * 成功后账号直接进 Agent2API 池，每日额度 ¥200（管理面板可改）1 分钟内生效。
 */
import * as React from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"

type Step = "phone" | "code" | "done"

export function AutoclawDonationCard() {
  const [phone, setPhone] = React.useState("")
  const [code, setCode] = React.useState("")
  const [step, setStep] = React.useState<Step>("phone")
  const [busy, setBusy] = React.useState(false)
  const [countdown, setCountdown] = React.useState(0)
  const [result, setResult] = React.useState<{ accountId: string; accountName: string } | null>(null)

  React.useEffect(() => {
    if (countdown <= 0) return
    const t = window.setTimeout(() => setCountdown((n) => n - 1), 1000)
    return () => window.clearTimeout(t)
  }, [countdown])

  const phoneOk = /^1\d{10}$/.test(phone.replace(/\D/g, ""))

  const sendCode = async () => {
    if (!phoneOk) {
      toast.error("请填写 11 位手机号")
      return
    }
    setBusy(true)
    try {
      const r = await fetch("/api/donations/autoclaw/sms/send", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone }),
      })
      const d = (await r.json()) as { ok?: boolean; message?: string; error?: string }
      if (!r.ok || !d.ok) throw new Error(d.message || d.error || "验证码发送失败")
      setStep("code")
      setCountdown(60)
      toast.success("验证码已发送，请查收短信")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "验证码发送失败")
    } finally {
      setBusy(false)
    }
  }

  const submit = async () => {
    if (!/^\d{4,8}$/.test(code.replace(/\D/g, ""))) {
      toast.error("请填写收到的验证码")
      return
    }
    setBusy(true)
    try {
      const r = await fetch("/api/donations/autoclaw/sms/verify", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone, code }),
      })
      const d = (await r.json()) as {
        ok?: boolean
        message?: string
        error?: string
        accountId?: string
        accountName?: string
      }
      if (!r.ok || !d.ok) throw new Error(d.message || d.error || "验证码不正确或已失效")
      setResult({ accountId: d.accountId ?? "", accountName: d.accountName ?? "" })
      setStep("done")
      toast.success("捐献成功！")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "提交失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          AutoClaw
          <Badge variant="outline">手机验证码</Badge>
        </CardTitle>
        <CardDescription>
          捐献一个 AutoClaw（国内版）账号 = <span className="font-medium">每天 ¥200 免费额度</span>
          。只需要手机号 + 短信验证码，账号会直接进入共享号池供大家使用；额度每 1 分钟结算一次。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {step === "done" ? (
          <div className="rounded-lg border-2 border-emerald-500/60 bg-emerald-500/10 p-4">
            <p className="text-base font-semibold text-emerald-600 dark:text-emerald-400">
              ✅ 捐献成功！
            </p>
            <p className="mt-1 text-sm">
              账号{result?.accountName ? `「${result.accountName}」` : ""}已加入 Doulor 号池，
              每日免费额度将在 1 分钟内生效。若该账号之后失效，额度会自动收回并在这里提醒你重新登录。
            </p>
            <Button
              className="mt-3"
              size="sm"
              variant="outline"
              onClick={() => {
                setStep("phone")
                setPhone("")
                setCode("")
                setResult(null)
              }}
            >
              再捐一个
            </Button>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor="autoclawPhone">手机号</Label>
              <div className="flex gap-2">
                <Input
                  id="autoclawPhone"
                  value={phone}
                  placeholder="11 位中国大陆手机号"
                  inputMode="numeric"
                  maxLength={11}
                  onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
                  disabled={busy || step === "code"}
                />
                <Button
                  variant="outline"
                  disabled={busy || countdown > 0 || !phoneOk}
                  onClick={() => void sendCode()}
                >
                  {countdown > 0 ? `${countdown}s 后重发` : step === "code" ? "重发验证码" : "发送验证码"}
                </Button>
              </div>
            </div>

            {step === "code" && (
              <div className="space-y-2">
                <Label htmlFor="autoclawCode">短信验证码</Label>
                <div className="flex gap-2">
                  <Input
                    id="autoclawCode"
                    value={code}
                    placeholder="收到的验证码"
                    inputMode="numeric"
                    maxLength={8}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  />
                  <Button disabled={busy} onClick={() => void submit()}>
                    {busy ? "提交中…" : "提交捐献"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  验证码由 AutoClaw 官方短信发出；提交成功后账号立即入池，无需再做任何操作。
                </p>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
