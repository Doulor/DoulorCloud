import * as React from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { AuthShell, AuthFooterLink } from "@/components/auth-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { authApi, HttpError } from "@/services/api"
import { useAuth } from "@/hooks/use-auth"

export default function LoginPage() {
  const { setUser } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from ?? "/dashboard"

  const [identifier, setIdentifier] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const res = await authApi.login({ identifier, password })
      setUser(res.user)
      toast.success("登录成功")
      navigate(from, { replace: true })
    } catch (err) {
      setError(err instanceof HttpError ? err.message : "登录失败，请稍后重试")
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthShell
      title="登录"
      description="使用用户名或邮箱登录你的命名空间。"
      footer={
        <>
          还没有账户？<AuthFooterLink to="/register" label="注册" />
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="identifier">用户名 / 邮箱</Label>
          <Input
            id="identifier"
            autoComplete="username"
            placeholder="example 或 example@doulor.cn"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">密码</Label>
            <Link
              to="/login"
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              忘记密码？
            </Link>
          </div>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="w-full" disabled={loading}>
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          登录
        </Button>
      </form>
    </AuthShell>
  )
}
