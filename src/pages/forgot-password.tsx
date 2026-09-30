import * as React from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { AuthShell, AuthFooterLink } from "@/components/auth-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { authApi, HttpError } from "@/services/api"

export default function ForgotPasswordPage() {
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
      toast.success(res.message ?? "重置邮件已发送")
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "发送失败，请稍后重试")
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthShell
      title="找回密码"
      description="输入你的注册邮箱，我们会发送一封重置密码邮件。"
      footer={
        <>
          想起密码了？<AuthFooterLink to="/login" label="返回登录" />
        </>
      }
    >
      {sent ? (
        <div className="space-y-3 rounded-md border bg-muted/40 p-4 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">重置邮件已发送</p>
          <p>请到 {email} 查收邮件并点击其中的重置链接（可能进垃圾箱）。</p>
          <p className="text-xs">链接 15 分钟内有效，请尽快完成重置。</p>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">注册邮箱</Label>
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
            发送重置邮件
          </Button>
        </form>
      )}
    </AuthShell>
  )
}
