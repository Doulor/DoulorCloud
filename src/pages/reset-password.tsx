import * as React from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { AuthShell, AuthFooterLink } from "@/components/auth-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { authApi, HttpError } from "@/services/api"

export default function ResetPasswordPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const token = searchParams.get("token") ?? ""

  const [password, setPassword] = React.useState("")
  const [confirm, setConfirm] = React.useState("")
  const [loading, setLoading] = React.useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!token) {
      toast.error("重置链接无效，请重新发起找回")
      return
    }
    if (password.length < 8) {
      toast.error("新密码至少需要 8 位")
      return
    }
    if (password !== confirm) {
      toast.error("两次输入的密码不一致")
      return
    }
    setLoading(true)
    try {
      await authApi.resetPassword(token, password)
      toast.success("密码已重置，请使用新密码登录")
      navigate("/login", { replace: true })
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "重置失败，请重新发起找回")
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthShell
      title="设置新密码"
      description="为你的账号设置一个新的登录密码。"
      footer={
        <>
          <AuthFooterLink to="/forgot-password" label="重新发起找回" />
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="password">新密码</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            placeholder="至少 8 位"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm">确认密码</Label>
          <Input
            id="confirm"
            type="password"
            autoComplete="new-password"
            placeholder="再次输入"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </div>
        <Button type="submit" className="w-full" disabled={loading}>
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          重置密码
        </Button>
      </form>
    </AuthShell>
  )
}
