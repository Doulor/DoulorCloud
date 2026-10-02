import * as React from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { AuthShell, AuthFooterLink } from "@/components/auth-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { authApi, HttpError } from "@/services/api"
import { useT } from "@/i18n"

export default function ResetPasswordPage() {
  const { t } = useT()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const token = searchParams.get("token") ?? ""

  const [password, setPassword] = React.useState("")
  const [confirm, setConfirm] = React.useState("")
  const [loading, setLoading] = React.useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!token) {
      toast.error(t("rp.err.invalidLink"))
      return
    }
    if (password.length < 8) {
      toast.error(t("settings.toast.passwordTooShort"))
      return
    }
    if (password !== confirm) {
      toast.error(t("settings.toast.passwordMismatch"))
      return
    }
    setLoading(true)
    try {
      await authApi.resetPassword(token, password)
      toast.success(t("rp.ok"))
      navigate("/login", { replace: true })
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("rp.err.failed"))
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthShell
      title={t("rp.title")}
      description={t("rp.pageDesc")}
      footer={
        <>
          <AuthFooterLink to="/forgot-password" label={t("rp.restart")} />
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="password">{t("settings.pw.new")}</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            placeholder={t("settings.pw.atLeast8")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm">{t("settings.pw.confirm")}</Label>
          <Input
            id="confirm"
            type="password"
            autoComplete="new-password"
            placeholder={t("rp.confirmPlaceholder")}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </div>
        <Button type="submit" className="w-full" disabled={loading}>
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          {t("rp.submit")}
        </Button>
      </form>
    </AuthShell>
  )
}
