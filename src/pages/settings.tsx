import * as React from "react"
import {
  AlertTriangle,
  BadgeCheck,
  KeyRound,
  Loader2,
  Mail,
  RefreshCw,
  User,
} from "lucide-react"
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
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { authApi, identityApi, settingsApi, HttpError } from "@/services/api"
import { useAuth } from "@/hooks/use-auth"
import { UserAvatar } from "@/components/user-avatar"
import type { EmailSettings } from "@/types"

export default function SettingsPage() {
  const { user, setUser } = useAuth()

  // 修改密码
  const [pwOpen, setPwOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [form, setForm] = React.useState({ current: "", next: "", confirm: "" })
  const [error, setError] = React.useState<string | null>(null)

  // 真实邮箱验证
  const [emailSettings, setEmailSettings] = React.useState<EmailSettings | null>(null)
  const [verifyBusy, setVerifyBusy] = React.useState(false)
  const [polling, setPolling] = React.useState(false)
  const pollRef = React.useRef<number | null>(null)

  // 改名 / 改邮箱
  const [nameOpen, setNameOpen] = React.useState(false)
  const [nameForm, setNameForm] = React.useState({ username: "", password: "" })
  const [emailOpen, setEmailOpen] = React.useState(false)
  const [emailForm, setEmailForm] = React.useState({
    email: "",
    password: "",
    step: "request" as "request" | "confirm",
  })

  // 昵称与头像
  const avatarInputRef = React.useRef<HTMLInputElement>(null)
  const [nickDraft, setNickDraft] = React.useState(user?.nickname ?? "")
  const [hasAvatar, setHasAvatar] = React.useState(user?.hasAvatar ?? false)
  const [nickBusy, setNickBusy] = React.useState(false)

  const loadEmailSettings = React.useCallback(async () => {
    try {
      setEmailSettings(await settingsApi.getEmail())
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "加载邮箱设置失败")
    }
  }, [])

  React.useEffect(() => {
    void loadEmailSettings()
  }, [loadEmailSettings])

  // 组件卸载时停止轮询
  React.useEffect(() => {
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current)
    }
  }, [])

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

  /** 发起真实邮箱验证：Cloudflare 会向该邮箱发确认链接 */
  const handleStartVerify = async () => {
    setVerifyBusy(true)
    try {
      const res = await settingsApi.verifyEmail()
      if (res.verified) {
        toast.success("该邮箱已验证")
        await loadEmailSettings()
        if (user) setUser({ ...user, emailVerified: true })
      } else {
        toast.success(res.message ?? "验证邮件已发送，请查收并点击确认链接")
        startPolling()
      }
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "发送验证邮件失败")
    } finally {
      setVerifyBusy(false)
    }
  }

  /** 轮询验证状态（用户可能在别处点了确认链接） */
  const startPolling = () => {
    if (pollRef.current !== null) window.clearInterval(pollRef.current)
    setPolling(true)
    let tries = 0
    pollRef.current = window.setInterval(async () => {
      tries++
      try {
        const res = await settingsApi.verifyEmail("status")
        if (res.verified) {
          window.clearInterval(pollRef.current!)
          pollRef.current = null
          setPolling(false)
          toast.success("真实邮箱验证成功")
          await loadEmailSettings()
          if (user) setUser({ ...user, emailVerified: true })
        }
      } catch {
        // 轮询失败静默
      }
      if (tries >= 20) {
        window.clearInterval(pollRef.current!)
        pollRef.current = null
        setPolling(false)
      }
    }, 5000)
  }

  const handleToggleNotify = async (enabled: boolean) => {
    try {
      await settingsApi.setNotify(enabled)
      setEmailSettings((s) => (s ? { ...s, notifyEnabled: enabled } : s))
      if (user) setUser({ ...user, notifyEnabled: enabled })
      toast.success(enabled ? "已开启通知邮件" : "已关闭通知邮件")
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "保存失败")
    }
  }

  const handleChangeUsername = async () => {
    setError(null)
    setSaving(true)
    try {
      const res = await settingsApi.changeUsername(nameForm)
      toast.success("用户名已修改")
      setNameOpen(false)
      setNameForm({ username: "", password: "" })
      if (user) setUser(res.user)
      toast.message(res.warnings?.note ?? "网盘目录等未迁移")
    } catch (err) {
      setError(err instanceof HttpError ? err.message : "修改失败")
    } finally {
      setSaving(false)
    }
  }

  const handleChangeEmail = async () => {
    setError(null)
    setSaving(true)
    try {
      const res = await settingsApi.changeEmail({
        email: emailForm.email,
        password: emailForm.password,
        action: emailForm.step,
      })
      if (emailForm.step === "request") {
        toast.success(res.message ?? "验证邮件已发送，请点击确认后再提交")
        setEmailForm((f) => ({ ...f, step: "confirm" }))
      } else {
        toast.success("真实邮箱已更新")
        setEmailOpen(false)
        setEmailForm({ email: "", password: "", step: "request" })
        await loadEmailSettings()
        if (res.user) setUser(res.user)
      }
    } catch (err) {
      setError(err instanceof HttpError ? err.message : "操作失败")
    } finally {
      setSaving(false)
    }
  }

  const verified = emailSettings?.verified ?? user?.emailVerified ?? false

  return (
    <div>
      <PageHeader title="设置" description="管理你的账户信息。" />

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
                <div className="flex items-center gap-3">
                  <span className="font-mono">{user?.username}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setNameOpen(true)}
                  >
                    修改
                  </Button>
                </div>
              </div>
              <div className="flex items-center justify-between py-3 text-sm">
                <span className="text-muted-foreground">真实邮箱</span>
                <div className="flex items-center gap-3">
                  <span className="font-mono">{user?.email}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEmailOpen(true)}
                  >
                    修改
                  </Button>
                </div>
              </div>
              <div className="flex items-center justify-between py-3 text-sm">
                <span className="text-muted-foreground">我的域名</span>
                <span className="font-mono">{user?.namespace}.doulor.cn</span>
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

        {/* 昵称与头像 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">昵称与头像</CardTitle>
            <CardDescription>
              社区与侧边栏会展示昵称；未设置时显示用户名。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-4">
              <UserAvatar
                username={user?.username ?? ""}
                nickname={nickDraft || null}
                hasAvatar={hasAvatar}
                className="h-16 w-16"
              />
              <div className="space-y-2">
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  ref={avatarInputRef}
                  className="hidden"
                  onChange={async (e) => {
                    const f = e.target.files?.[0]
                    if (!f) return
                    try {
                      await identityApi.uploadAvatar(f)
                      setHasAvatar(true)
                      if (user) setUser({ ...user, hasAvatar: true })
                      toast.success("头像已更新")
                    } catch (err) {
                      toast.error(
                        err instanceof HttpError ? err.message : "上传失败"
                      )
                    }
                  }}
                />
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => avatarInputRef.current?.click()}
                  >
                    上传头像
                  </Button>
                  {hasAvatar && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={async () => {
                        try {
                          await identityApi.deleteAvatar()
                          setHasAvatar(false)
                          if (user) setUser({ ...user, hasAvatar: false })
                          toast.success("头像已删除")
                        } catch (err) {
                          toast.error(
                            err instanceof HttpError ? err.message : "删除失败"
                          )
                        }
                      }}
                    >
                      删除头像
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  支持 JPG/PNG/WebP/GIF，上限 2 MB
                </p>
              </div>
            </div>
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-2">
                <Label htmlFor="nick">昵称</Label>
                <Input
                  id="nick"
                  value={nickDraft}
                  onChange={(e) => setNickDraft(e.target.value)}
                  placeholder="2-16 位中文/英文/数字/下划线"
                  maxLength={16}
                />
              </div>
              <Button
                disabled={nickBusy}
                onClick={async () => {
                  setNickBusy(true)
                  try {
                    const res = await identityApi.updateNickname(
                      nickDraft.trim()
                    )
                    setNickDraft(res.nickname ?? "")
                    if (user) setUser({ ...user, nickname: res.nickname })
                    toast.success("昵称已更新")
                  } catch (err) {
                    toast.error(
                      err instanceof HttpError ? err.message : "保存失败"
                    )
                  } finally {
                    setNickBusy(false)
                  }
                }}
              >
                保存
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* 真实邮箱验证 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Mail className="h-4 w-4 text-muted-foreground" />
              真实邮箱验证
              {verified ? (
                <Badge variant="success">
                  <BadgeCheck className="mr-1 h-3 w-3" />
                  已验证
                </Badge>
              ) : (
                <Badge variant="destructive">未验证</Badge>
              )}
            </CardTitle>
            <CardDescription>
              验证后可将该邮箱设为转发目标，并接收 Doulor Cloud 的通知邮件。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">
                  {verified
                    ? "邮箱已验证，可用于转发与接收通知"
                    : `尚未验证：请查收 ${emailSettings?.email ?? ""} 的确认邮件`}
                </p>
                <p className="text-xs text-muted-foreground">
                  验证由 Cloudflare 发送确认链接完成，本站不接触你的邮箱密码。
                </p>
              </div>
              {!verified && (
                <Button
                  size="sm"
                  onClick={() => void handleStartVerify()}
                  disabled={verifyBusy || polling}
                >
                  {verifyBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                  {polling ? "等待确认…" : "发送验证邮件"}
                </Button>
              )}
              {verified && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void loadEmailSettings()}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  刷新
                </Button>
              )}
            </div>

            <Separator />

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">接收通知邮件</p>
                <p className="text-xs text-muted-foreground">
                  站点功能更新、维护公告等（仅发送到已验证邮箱）
                </p>
              </div>
              <Switch
                checked={emailSettings?.notifyEnabled ?? true}
                onCheckedChange={(v) => void handleToggleNotify(v)}
                disabled={!verified}
              />
            </div>

            <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
              规则：只有**已验证**的真实邮箱才能被设为邮箱转发目标。
              未验证的地址 Cloudflare 会拒绝转发。
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
          </CardContent>
        </Card>
      </div>

      {/* 修改密码 */}
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
                onChange={(e) => setForm((f) => ({ ...f, current: e.target.value }))}
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
                onChange={(e) => setForm((f) => ({ ...f, confirm: e.target.value }))}
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

      {/* 修改用户名 */}
      <Dialog
        open={nameOpen}
        onOpenChange={(open) => {
          if (!open) {
            setNameOpen(false)
            setNameForm({ username: "", password: "" })
            setError(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>修改用户名</DialogTitle>
            <DialogDescription>需要验证当前密码。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="space-y-1">
                <p className="font-medium">改名不会自动迁移以下内容：</p>
                <p>· 网盘目录仍为 <code>{user?.username}/</code>，旧直链不变</p>
                <p>· 子域名仍为 <code>{user?.namespace}.doulor.cn</code></p>
                <p>· 主邮箱仍为 <code>{user?.username}@doulor.cn</code></p>
                <p>· AI 中转站账号名不变（NewAPI 不允许改用户名）</p>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="newName">新用户名</Label>
              <Input
                id="newName"
                placeholder="小写字母、数字、连字符"
                value={nameForm.username}
                onChange={(e) =>
                  setNameForm((f) => ({
                    ...f,
                    username: e.target.value.toLowerCase(),
                  }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="namePw">当前密码</Label>
              <Input
                id="namePw"
                type="password"
                autoComplete="current-password"
                value={nameForm.password}
                onChange={(e) =>
                  setNameForm((f) => ({ ...f, password: e.target.value }))
                }
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNameOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => void handleChangeUsername()}
              disabled={saving || !nameForm.username || !nameForm.password}
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              确认修改
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 修改真实邮箱 */}
      <Dialog
        open={emailOpen}
        onOpenChange={(open) => {
          if (!open) {
            setEmailOpen(false)
            setEmailForm({ email: "", password: "", step: "request" })
            setError(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>修改真实邮箱</DialogTitle>
            <DialogDescription>
              {emailForm.step === "request"
                ? "新邮箱需要先通过 Cloudflare 的验证邮件确认。"
                : "已发送验证邮件，请点击确认后回到这里提交。"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="newEmail">新邮箱</Label>
              <Input
                id="newEmail"
                type="email"
                disabled={emailForm.step === "confirm"}
                value={emailForm.email}
                onChange={(e) =>
                  setEmailForm((f) => ({ ...f, email: e.target.value }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="emailPw">当前密码</Label>
              <Input
                id="emailPw"
                type="password"
                autoComplete="current-password"
                value={emailForm.password}
                onChange={(e) =>
                  setEmailForm((f) => ({ ...f, password: e.target.value }))
                }
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEmailOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => void handleChangeEmail()}
              disabled={saving || !emailForm.email || !emailForm.password}
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {emailForm.step === "request" ? "发送验证邮件" : "我已确认，提交"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}