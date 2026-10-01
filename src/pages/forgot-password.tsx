import * as React from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { AuthShell, AuthFooterLink } from "@/components/auth-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { authApi, HttpError } from "@/services/api"
import { useT } from "@/i18n"

export default function ForgotPasswordPage() {
  const { t } = useT()
  const [email, setEmail] = React.useState("")
  const [sent, setSent] = React.useState(false)
  const [loading, setLoading] = React.useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim()) return
    setLoading(true)
    try {
      const res = await authApi.forgotPassword(email.trim())
      setSent(true)
      toast.success(res.message ?? t("fp.ok"))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("lay.sendFailed"))
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthShell
      title={t("fp.title")}
      description={t("fp.desc")}
      footer={
        <>
          {t("fp.remember")}<AuthFooterLink to="/login" label={t("fp.backToLogin")} />
        </>
      }
    >
      {sent ? (
        <div className="space-y-3 rounded-md border bg-muted/40 p-4 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">{t("fp.ok")}</p>
          <p>{t("fp.checkEmail", { email })}</p>
          <p className="text-xs">{t("fp.expiry")}</p>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">{t("fp.emailLabel")}</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("fp.submit")}
          </Button>
        </form>
      )}
    </AuthShell>
  )
}
