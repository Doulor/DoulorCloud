import * as React from "react"
import { useNavigate } from "react-router-dom"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { AuthShell, AuthFooterLink } from "@/components/auth-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { authApi, HttpError } from "@/services/api"
import { useAuth } from "@/hooks/use-auth"

export default function RegisterPage() {
  const { setUser } = useAuth()
  const navigate = useNavigate()

  const [form, setForm] = React.useState({
    username: "",
    email: "",
    password: "",
    confirm: "",
    inviteCode: "",
  })
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (form.password !== form.confirm) {
      setError("两次输入的密码不一致")
      return
    }

    setLoading(true)
    try {
      const res = await authApi.register({
        username: form.username,
        email: form.email,
        password: form.password,
        inviteCode: form.inviteCode,
      })
      setUser(res.user)
      toast.success(`欢迎，${res.user.username}！你的命名空间已创建`)
      navigate("/dashboard", { replace: true })
    } catch (err) {
      setError(err instanceof HttpError ? err.message : "注册失败，请稍后重试")
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthShell
      title="创建账户"
      description={
        <>
          注册后将获得{" "}
          <span className="font-mono text-foreground">username.doulor.cn</span>{" "}
          子域名和 <span className="font-mono text-foreground">username@doulor.cn</span>{" "}
          邮箱。
        </>
      }
      footer={
        <>
          已有账户？<AuthFooterLink to="/login" label="登录" />
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="username">用户名</Label>
          <Input
            id="username"
            autoComplete="username"
            placeholder="example"
            value={form.username}
            onChange={set("username")}
            required
          />
          <p className="text-xs text-muted-foreground">
            将生成{" "}
            <span className="font-mono">
              {form.username || "username"}.doulor.cn
            </span>
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">真实邮箱</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={form.email}
            onChange={set("email")}
            required
          />
          <p className="text-xs text-muted-foreground">
            域名邮箱收到的邮件将转发到此邮箱，之后可在「邮箱」页修改。
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              value={form.password}
              onChange={set("password")}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm">确认密码</Label>
            <Input
              id="confirm"
              type="password"
              autoComplete="new-password"
              value={form.confirm}
              onChange={set("confirm")}
              required
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="inviteCode">邀请码</Label>
          <Input
            id="inviteCode"
            placeholder="输入邀请码"
            value={form.inviteCode}
            onChange={set("inviteCode")}
            required
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="w-full" disabled={loading}>
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          创建账户
        </Button>
      </form>
    </AuthShell>
  )
}
