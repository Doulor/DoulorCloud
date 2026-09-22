import * as React from "react"
import { KeyRound, Loader2, User } from "lucide-react"
import { toast } from "sonner"

import { PageHeader } from "@/components/page-header"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { authApi, HttpError } from "@/services/api"
import { useAuth } from "@/hooks/use-auth"

export default function SettingsPage() {
  const { user } = useAuth()

  const [pwOpen, setPwOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [form, setForm] = React.useState({
    current: "",
    next: "",
    confirm: "",
  })
  const [error, setError] = React.useState<string | null>(null)

  const closeDialog = () => {
    setPwOpen(false)
    setForm({ current: "", next: "", confirm: "" })
    setError(null)
  }

  const handleChangePassword = async () => {
    setError(null)
    if (form.next !== form.confirm) {
      setError("两次输入的新密码不一致")
      return
    }
    if (form.next.length < 8) {
      setError("新密码至少需要 8 位")
      return
    }
    setSaving(true)
    try {
      await authApi.changePassword({
        currentPassword: form.current,
        newPassword: form.next,
      })
      toast.success("密码已修改，其他设备需重新登录")
      closeDialog()
    } catch (err) {
      setError(err instanceof HttpError ? err.message : "修改失败，请稍后重试")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <PageHeader
        title="设置"
        description="管理你的账户信息。"
      />

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <User className="h-4 w-4 text-muted-foreground" />
              账户信息
            </CardTitle>
            <CardDescription>你的基本账户资料</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="divide-y">
              <div className="flex items-center justify-between py-3 text-sm">
                <span className="text-muted-foreground">用户名</span>
                <span className="font-mono">{user?.username}</span>
              </div>
              <div className="flex items-center justify-between py-3 text-sm">
                <span className="text-muted-foreground">真实邮箱</span>
                <span className="font-mono">{user?.email}</span>
              </div>
              <div className="flex items-center justify-between py-3 text-sm">
                <span className="text-muted-foreground">我的域名</span>
                <span className="font-mono">
                  {user?.username}.doulor.cn
                </span>
              </div>
              <div className="flex items-center justify-between py-3 text-sm">
                <span className="text-muted-foreground">注册时间</span>
                <span>
                  {user?.createdAt
                    ? new Date(user.createdAt).toLocaleString("zh-CN")
                    : "—"}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="h-4 w-4 text-muted-foreground" />
              安全
            </CardTitle>
            <CardDescription>密码与账户安全设置</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">修改密码</p>
                <p className="text-xs text-muted-foreground">
                  修改后其他设备上的登录会失效
                </p>
              </div>
              <Button size="sm" onClick={() => setPwOpen(true)}>
                修改密码
              </Button>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">API Token</p>
                <p className="text-xs text-muted-foreground">
                  用于程序化访问的密钥
                </p>
              </div>
              <Badge variant="secondary">即将上线</Badge>
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog
        open={pwOpen}
        onOpenChange={(open) => {
          if (!open) closeDialog()
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>修改密码</DialogTitle>
            <DialogDescription>
              需要验证当前密码；修改成功后其他设备需重新登录。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="current">当前密码</Label>
              <Input
                id="current"
                type="password"
                autoComplete="current-password"
                value={form.current}
                onChange={(e) =>
                  setForm((f) => ({ ...f, current: e.target.value }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="next">新密码</Label>
              <Input
                id="next"
                type="password"
                autoComplete="new-password"
                value={form.next}
                onChange={(e) => setForm((f) => ({ ...f, next: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">至少 8 位</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirmPw">确认新密码</Label>
              <Input
                id="confirmPw"
                type="password"
                autoComplete="new-password"
                value={form.confirm}
                onChange={(e) =>
                  setForm((f) => ({ ...f, confirm: e.target.value }))
                }
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>
              取消
            </Button>
            <Button
              onClick={() => void handleChangePassword()}
              disabled={saving || !form.current || !form.next}
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              确认修改
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
