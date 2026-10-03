import * as React from "react"
import {
  AlertTriangle,
  BadgeCheck,
  Bell,
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
import { MessageNotifyCard } from "@/components/message-notify-card"
import { TwoFactorCard } from "@/components/two-factor-card"
import { ApiSettingsCard } from "@/components/api-settings-card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  authApi,
  identityApi,
  settingsApi,
  getDefaultRootDomain,
  HttpError,
} from "@/services/api"
import { useAuth } from "@/hooks/use-auth"
import { useT } from "@/i18n"
import { UserAvatar } from "@/components/user-avatar"
import { AvatarCropper, type AvatarCropResult } from "@/components/avatar-cropper"
import type { EmailSettings } from "@/types"

export default function SettingsPage() {
  const { user, setUser } = useAuth()
  const { t } = useT()

  /**
   * 「发给用户的根域」（如 tyu.me）。由后端下发，**不写死** ——
   * 它是管理员可改的（root_domains 的默认行），换域后写死的地方会显示错地址
   * （2026-10-02 从 doulor.cn 整体迁到 tyu.me 时就踩到了）。拉不到就留空。
   */
  const [rootDomain, setRootDomain] = React.useState("")
  React.useEffect(() => {
    let alive = true
    getDefaultRootDomain()
      .then((d) => {
        if (alive) setRootDomain(d)
      })
      .catch(() => {
        /* 拉不到就不显示域名，别闪一个错的 */
      })
    return () => {
      alive = false
    }
  }, [])

  // 修改密码
  const [pwOpen, setPwOpen] = React.useState(false)
  // 注销账号
  const [delOpen, setDelOpen] = React.useState(false)
  const [delPwd, setDelPwd] = React.useState("")
  /** 注销验证码（发到注册邮箱，与密码双重确认） */
  const [delCode, setDelCode] = React.useState("")
  const [delCodeBusy, setDelCodeBusy] = React.useState(false)
  const [delBusy, setDelBusy] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [form, setForm] = React.useState({ current: "", next: "", confirm: "" })
  const [error, setError] = React.useState<string | null>(null)

  // 真实邮箱验证
  const [emailSettings, setEmailSettings] = React.useState<EmailSettings | null>(null)
  /** 邮箱设置加载失败（用于区分「加载失败」与「真的没配置」） */
  const [emailFailed, setEmailFailed] = React.useState(false)
  const [verifyBusy, setVerifyBusy] = React.useState(false)
  /** 已发送验证码（用于显示「输入验证码」输入框） */
  const [codeSent, setCodeSent] = React.useState(false)
  const [verifyCode, setVerifyCode] = React.useState("")

  // 改名 / 改邮箱
  const [nameOpen, setNameOpen] = React.useState(false)
  const [nameForm, setNameForm] = React.useState({ username: "", password: "" })
  const [emailOpen, setEmailOpen] = React.useState(false)
  const [emailForm, setEmailForm] = React.useState({
    email: "",
    password: "",
    code: "",
    step: "request" as "request" | "confirm",
  })

  // 昵称与头像
  const avatarInputRef = React.useRef<HTMLInputElement>(null)
  const [nickDraft, setNickDraft] = React.useState(user?.nickname ?? "")
  const [hasAvatar, setHasAvatar] = React.useState(user?.hasAvatar ?? false)
  const [nickBusy, setNickBusy] = React.useState(false)
  // 头像裁剪：选图后先打开裁剪器，确认后再上传
  const [cropFile, setCropFile] = React.useState<File | null>(null)
  const [avatarBusy, setAvatarBusy] = React.useState(false)

  const handleAvatarPicked = (f: File) => {
    setCropFile(f)
  }

  const handleCropConfirm = async (result: AvatarCropResult) => {
    setCropFile(null)
    setAvatarBusy(true)
    try {
      const cropped = new File([result.blob], "avatar", { type: result.type })
      await identityApi.uploadAvatar(cropped)
      setHasAvatar(true)
      if (user) setUser({ ...user, hasAvatar: true })
      toast.success(t("settings.toast.avatarUpdated"))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("settings.toast.uploadFailed"))
    } finally {
      setAvatarBusy(false)
    }
  }

  const loadEmailSettings = React.useCallback(async () => {
    try {
      setEmailSettings(await settingsApi.getEmail())
      setEmailFailed(false)
    } catch (err) {
      // ⚠️ 2026-09-26：失败要留下错误态。原先只有 toast，`emailSettings` 保持 null，
      // 下方会显示成「尚未验证」，用户以为自己的邮箱丢了验证。
      toast.error(err instanceof HttpError ? err.message : t("settings.toast.emailLoadFailed"))
      setEmailFailed(true)
    }
  }, [])

  React.useEffect(() => {
    void loadEmailSettings()
  }, [loadEmailSettings])

  const closeDialog = () => {
    setPwOpen(false)
    setForm({ current: "", next: "", confirm: "" })
    setError(null)
  }

  const handleChangePassword = async () => {
    setError(null)
    if (form.next !== form.confirm) {
      setError(t("settings.toast.passwordMismatch"))
      return
    }
    if (form.next.length < 8) {
      setError(t("settings.toast.passwordTooShort"))
      return
    }
    setSaving(true)
    try {
      await authApi.changePassword({
        currentPassword: form.current,
        newPassword: form.next,
      })
      toast.success(t("settings.toast.passwordChanged"))
      closeDialog()
    } catch (err) {
      setError(err instanceof HttpError ? err.message : t("settings.toast.updateFailed"))
    } finally {
      setSaving(false)
    }
  }

  /** 发起真实邮箱验证：生成 6 位验证码并发到邮箱 */
  const handleStartVerify = async () => {
    setVerifyBusy(true)
    try {
      const res = await settingsApi.verifyEmail()
      if (res.verified) {
        toast.success(t("settings.toast.emailAlreadyVerified"))
        await loadEmailSettings()
        if (user) setUser({ ...user, emailVerified: true })
      } else {
        setCodeSent(true)
        setVerifyCode("")
        toast.success(res.message ?? t("settings.toast.codeSentToEmail"))
      }
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("settings.toast.sendCodeFailed"))
    } finally {
      setVerifyBusy(false)
    }
  }

  /** 回填验证码完成验证 */
  const handleConfirmVerify = async () => {
    if (!/^\d{6}$/.test(verifyCode)) {
      toast.error(t("settings.toast.enter6DigitCode"))
      return
    }
    setVerifyBusy(true)
    try {
      const res = await settingsApi.verifyEmail("confirm", verifyCode)
      if (res.verified) {
        toast.success(t("settings.toast.emailVerified"))
        setCodeSent(false)
        setVerifyCode("")
        await loadEmailSettings()
        if (user) setUser({ ...user, emailVerified: true })
      }
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("settings.toast.verifyFailed"))
    } finally {
      setVerifyBusy(false)
    }
  }

  const handleToggleNotify = async (
    field: "enabled" | "announcements",
    value: boolean
  ) => {
    try {
      const res = await settingsApi.setNotify(
        field === "announcements" ? { announcements: value } : { enabled: value }
      )
      setEmailSettings((s) =>
        s ? { ...s, notifyEnabled: res.notifyEnabled, notifyAnnouncements: res.notifyAnnouncements } : s
      )
      if (user) {
        setUser({
          ...user,
          notifyEnabled: res.notifyEnabled,
          notifyAnnouncements: res.notifyAnnouncements,
        })
      }
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("settings.toast.saveFailed"))
    }
  }

  /** 发送注销验证码到注册邮箱 */
  const handleSendDeleteCode = async () => {
    setDelCodeBusy(true)
    try {
      const res = await settingsApi.requestDeleteCode()
      toast.success(t("settings.toast.codeSent"), { description: t("settings.toast.codeSentDesc", { email: res.email }) })
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("settings.toast.sendFailed"))
    } finally {
      setDelCodeBusy(false)
    }
  }

  /** 自助注销账号：密码 + 邮箱验证码双重校验后删除账户并回收外部资源，然后跳回首页 */
  const handleDeleteAccount = async () => {
    if (!delPwd) {
      toast.error(t("settings.toast.enterPasswordToDelete"))
      return
    }
    if (!/^\d{6}$/.test(delCode)) {
      toast.error(t("settings.toast.enter6DigitEmailCode"))
      return
    }
    setDelBusy(true)
    try {
      await settingsApi.deleteAccount(delPwd, delCode)
      setUser(null)
      toast.success(t("settings.toast.accountDeleted"))
      window.location.assign("/")
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("settings.toast.deleteFailed"))
      setDelBusy(false)
    }
  }

  const handleChangeUsername = async () => {
    setError(null)
    setSaving(true)
    try {
      const res = await settingsApi.changeUsername(nameForm)
      toast.success(t("settings.toast.usernameChanged"))
      setNameOpen(false)
      setNameForm({ username: "", password: "" })
      if (user) setUser(res.user)
      toast.message(res.warnings?.note ?? t("settings.toast.notMigrated"))
    } catch (err) {
      setError(err instanceof HttpError ? err.message : t("settings.toast.changeFailed"))
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
        code: emailForm.step === "confirm" ? emailForm.code : undefined,
      })
      if (emailForm.step === "request") {
        toast.success(res.message ?? t("settings.toast.verifyMailSent"))
        setEmailForm((f) => ({ ...f, step: "confirm", code: "" }))
      } else {
        toast.success(t("settings.toast.emailUpdated"))
        setEmailOpen(false)
        setEmailForm({ email: "", password: "", code: "", step: "request" })
        await loadEmailSettings()
        if (res.user) setUser(res.user)
      }
    } catch (err) {
      setError(err instanceof HttpError ? err.message : t("settings.toast.opFailed"))
    } finally {
      setSaving(false)
    }
  }

  const verified = emailSettings?.verified ?? user?.emailVerified ?? false

  /** 设置页分类：用 chips 切换，样式与管理面板的分类筛选一致 */
  const [group, setGroup] = React.useState("all")
  const SETTING_GROUPS = [
    { key: "all", label: t("settings.group.all") },
    { key: "account", label: t("settings.group.account") },
    { key: "security", label: t("settings.group.security") },
    { key: "notify", label: t("settings.group.notify") },
    { key: "api", label: t("settings.group.api") },
    { key: "danger", label: t("settings.group.danger") },
  ]
  /** 某分组是否可见（"all" 显示全部） */
  const show = (g: string) => group === "all" || group === g

  return (
    <div>
      <PageHeader title={t("settings.title")} description={t("settings.desc")} />

      {/* 分类筛选 */}
      <div className="mb-4 flex flex-wrap gap-2">
        {SETTING_GROUPS.map((g) => (
          <Button
            key={g.key}
            size="sm"
            variant={group === g.key ? "default" : "outline"}
            onClick={() => setGroup(g.key)}
          >
            {g.label}
          </Button>
        ))}
      </div>

      <div className="space-y-6">
        {show("account") && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <User className="h-4 w-4 text-muted-foreground" />
              {t("settings.profileSection")}
            </CardTitle>
            <CardDescription>{t("settings.profileSectionDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* 头像与昵称 */}
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
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    e.target.value = ""
                    if (f) handleAvatarPicked(f)
                  }}
                />
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={avatarBusy}
                    onClick={() => avatarInputRef.current?.click()}
                  >
                    {avatarBusy ? t("settings.avatar.uploading") : t("settings.avatar.upload")}
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
                          toast.success(t("settings.avatar.removed"))
                        } catch (err) {
                          toast.error(
                            err instanceof HttpError ? err.message : t("settings.avatar.removeFailed")
                          )
                        }
                      }}
                    >
                      {t("settings.avatar.remove")}
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("settings.avatar.hint")}
                </p>
              </div>
            </div>
            {cropFile && (
              <AvatarCropper
                file={cropFile}
                onCancel={() => setCropFile(null)}
                onConfirm={handleCropConfirm}
              />
            )}
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-2">
                <Label htmlFor="nick">{t("settings.label.nickname")}</Label>
                <Input
                  id="nick"
                  value={nickDraft}
                  onChange={(e) => setNickDraft(e.target.value)}
                  placeholder={t("settings.nicknameHint")}
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
                    toast.success(t("settings.toast.nicknameUpdated"))
                  } catch (err) {
                    toast.error(
                      err instanceof HttpError ? err.message : t("settings.toast.saveFailed")
                    )
                  } finally {
                    setNickBusy(false)
                  }
                }}
              >
                {t("common.save")}
              </Button>
            </div>

            <Separator />

            {/* 账户信息 */}
            <div className="divide-y">
              <div className="flex items-center justify-between py-3 text-sm">
                <span className="text-muted-foreground">{t("settings.label.username")}</span>
                <div className="flex items-center gap-3">
                  <span className="font-mono">{user?.username}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setNameOpen(true)}
                  >
                    {t("common.edit")}
                  </Button>
                </div>
              </div>
              <div className="flex items-center justify-between py-3 text-sm">
                <span className="text-muted-foreground">{t("settings.label.realEmail")}</span>
                <div className="flex items-center gap-3">
                  <span className="font-mono">{user?.email}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEmailOpen(true)}
                  >
                    {t("common.edit")}
                  </Button>
                </div>
              </div>
              <div className="flex items-center justify-between py-3 text-sm">
                <span className="text-muted-foreground">{t("settings.label.myDomain")}</span>
                <span className="font-mono">
                  {user?.namespace}
                  {rootDomain ? `.${rootDomain}` : ""}
                </span>
              </div>
              <div className="flex items-center justify-between py-3 text-sm">
                <span className="text-muted-foreground">{t("settings.label.joinedAt")}</span>
                <span>
                  {user?.createdAt
                    ? new Date(user.createdAt).toLocaleString("zh-CN")
                    : "—"}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
        )}

        {/* 二次认证（管理员/站长强制，普通用户可选） */}
        {show("security") && (
        <TwoFactorCard />
        )}

        {/* 真实邮箱验证 */}
        {show("account") && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Mail className="h-4 w-4 text-muted-foreground" />
              {t("settings.email.verifyTitle")}
              {verified ? (
                <Badge variant="success">
                  <BadgeCheck className="mr-1 h-3 w-3" />
                  {t("settings.email.verified")}
                </Badge>
              ) : (
                <Badge variant="destructive">{t("settings.email.unverified")}</Badge>
              )}
            </CardTitle>
            <CardDescription>
              {t("settings.email.verifyDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {emailFailed && (
              <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
                <span>{t("settings.email.loadFailedHint")}</span>
                <Button variant="outline" size="sm" onClick={() => void loadEmailSettings()}>
                  {t("common.retry")}
                </Button>
              </div>
            )}
            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">
                  {verified
                    ? t("settings.email.verifiedHint")
                    : t("settings.email.unverifiedHint", { email: emailSettings?.email ?? t("settings.email.yours") })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("settings.email.codeNote")}
                </p>
              </div>
              {!verified && !codeSent && (
                <Button
                  size="sm"
                  onClick={() => void handleStartVerify()}
                  disabled={verifyBusy}
                >
                  {verifyBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t("settings.btn.sendCode")}
                </Button>
              )}
              {verified && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void loadEmailSettings()}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t("common.refresh")}
                </Button>
              )}
            </div>

            {codeSent && !verified && (
              <div className="flex items-center gap-2">
                <Input
                  placeholder={t("settings.email.codeLabel")}
                  inputMode="numeric"
                  maxLength={6}
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, ""))}
                  className="font-mono text-sm tracking-widest"
                />
                <Button
                  size="sm"
                  onClick={() => void handleConfirmVerify()}
                  disabled={verifyBusy}
                >
                  {verifyBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t("settings.email.confirmVerify")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleStartVerify()}
                  disabled={verifyBusy}
                >
                  {t("settings.email.resend")}
                </Button>
              </div>
            )}

            <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
              {t("settings.email.forwardNote")}
            </div>
          </CardContent>
        </Card>
        )}

        {/* 通知偏好 */}
        {show("notify") && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Bell className="h-4 w-4 text-muted-foreground" />
              {t("settings.notify.prefTitle")}
            </CardTitle>
            <CardDescription>
              {t("settings.notify.desc2")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">{t("settings.notify.announcements")}</p>
                <p className="text-xs text-muted-foreground">
                  {t("settings.notify.announcementsDesc")}
                </p>
              </div>
              <Switch
                checked={emailSettings?.notifyAnnouncements ?? true}
                onCheckedChange={(v) => void handleToggleNotify("announcements", v)}
              />
            </div>
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">{t("settings.notify.personal")}</p>
                <p className="text-xs text-muted-foreground">
                  {t("settings.notify.personalDesc")}
                </p>
              </div>
              <Switch
                checked={emailSettings?.notifyEnabled ?? true}
                onCheckedChange={(v) => void handleToggleNotify("enabled", v)}
              />
            </div>
          </CardContent>
        </Card>
        )}

        {/* 安全：改密码等 */}
        {show("security") && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="h-4 w-4 text-muted-foreground" />
              {t("settings.security")}
            </CardTitle>
            <CardDescription>{t("settings.securitySectionDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">{t("settings.btn.changePassword")}</p>
                <p className="text-xs text-muted-foreground">
                  {t("settings.pw.changeNote")}
                </p>
              </div>
              <Button size="sm" onClick={() => setPwOpen(true)}>
                {t("settings.btn.changePassword")}
              </Button>
            </div>
          </CardContent>
        </Card>
        )}

        {/* 手机 App 通知：给打包成 App 的移动端提供拉取地址与令牌 */}
        {show("notify") && (
        <MessageNotifyCard />
        )}

        {show("danger") && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              {t("settings.delete.section")}
            </CardTitle>
            <CardDescription>
              {t("settings.delete.sectionDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button variant="destructive" size="sm" onClick={() => setDelOpen(true)}>
              {t("settings.delete.section")}
            </Button>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <a href="/terms" className="underline underline-offset-2 hover:text-foreground">{t("legal.terms")}</a>
              <a href="/privacy" className="underline underline-offset-2 hover:text-foreground">{t("legal.privacy")}</a>
            </div>
          </CardContent>
        </Card>
        )}

        {/* 公开 API：Key 管理 + 层级额度 + 接口文档 */}
        {show("api") && (
        <ApiSettingsCard />
        )}
      </div>

      {/* 注销账号确认 */}
      <Dialog
        open={delOpen}
        onOpenChange={(o) => {
          setDelOpen(o)
          if (!o) {
            setDelPwd("")
            setDelCode("")
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings.delete.confirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("settings.delete.body1")}
              <strong className="text-destructive">{t("settings.delete.irreversible")}</strong>
              {t("settings.delete.body2")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="delPwd">{t("settings.delete.enterPassword")}</Label>
            <Input
              id="delPwd"
              type="password"
              autoComplete="current-password"
              placeholder={t("settings.pw.currentPlaceholder")}
              value={delPwd}
              onChange={(e) => setDelPwd(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="delCode">{t("settings.delete.emailCode")}</Label>
            <div className="flex gap-2">
              <Input
                id="delCode"
                inputMode="numeric"
                maxLength={6}
                placeholder={t("settings.email.codeLabel")}
                className="font-mono tracking-widest"
                value={delCode}
                onChange={(e) => setDelCode(e.target.value.replace(/\D/g, ""))}
              />
              <Button
                type="button"
                variant="outline"
                className="shrink-0"
                onClick={() => void handleSendDeleteCode()}
                disabled={delCodeBusy}
              >
                {delCodeBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : t("settings.btn.sendCode")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("settings.delete.codeHint", { email: user?.email ?? "" })}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDelOpen(false)} disabled={delBusy}>
              {t("common.cancel")}
            </Button>
            <Button variant="destructive" onClick={() => void handleDeleteAccount()} disabled={delBusy}>
              {delBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("settings.delete.confirmBtn")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 修改密码 */}
      <Dialog
        open={pwOpen}
        onOpenChange={(open) => {
          if (!open) closeDialog()
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings.btn.changePassword")}</DialogTitle>
            <DialogDescription>
              {t("settings.pw.dialogDesc")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="current">{t("settings.pw.current")}</Label>
              <Input
                id="current"
                type="password"
                autoComplete="current-password"
                value={form.current}
                onChange={(e) => setForm((f) => ({ ...f, current: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="next">{t("settings.pw.new")}</Label>
              <Input
                id="next"
                type="password"
                autoComplete="new-password"
                value={form.next}
                onChange={(e) => setForm((f) => ({ ...f, next: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">{t("settings.pw.atLeast8")}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirmPw">{t("settings.pw.confirm")}</Label>
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
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => void handleChangePassword()}
              disabled={saving || !form.current || !form.next}
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("common.saveChanges")}
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
            <DialogTitle>{t("settings.rename.title")}</DialogTitle>
            <DialogDescription>{t("settings.rename.needPassword")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="space-y-1">
                <p className="font-medium">{t("settings.rename.warn")}</p>
                <p>{t("settings.rename.w1")} <code>{user?.username}/</code>{t("settings.rename.w1b")}</p>
                {/* 主域名/主邮箱按「namespace」展示（不是 username）：2026-10-02 起
                    少数短用户名账号的主域被补 0 改名（如 i → i00），两者不再一致 */}
                <p>
                  {t("settings.rename.w2")}{" "}
                  <code>
                    {user?.namespace}
                    {rootDomain ? `.${rootDomain}` : ""}
                  </code>
                </p>
                <p>
                  {t("settings.rename.w3")}{" "}
                  <code>
                    {user?.namespace}
                    {rootDomain ? `@${rootDomain}` : ""}
                  </code>
                </p>
                <p>{t("settings.rename.w4")}</p>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="newName">{t("settings.rename.newUsername")}</Label>
              <Input
                id="newName"
                placeholder={t("settings.usernameHint")}
                minLength={3}
                maxLength={32}
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
              <Label htmlFor="namePw">{t("settings.pw.current")}</Label>
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
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => void handleChangeUsername()}
              disabled={saving || !nameForm.username || !nameForm.password}
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("common.saveChanges")}
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
            setEmailForm({ email: "", password: "", code: "", step: "request" })
            setError(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings.rename.changeEmail")}</DialogTitle>
            <DialogDescription>
              {emailForm.step === "request"
                ? t("settings.email.changeNote1")
                : t("settings.email.changeNote2")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="newEmail">{t("settings.rename.newEmail")}</Label>
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
              <Label htmlFor="emailPw">{t("settings.pw.current")}</Label>
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
            {emailForm.step === "confirm" && (
              <div className="space-y-2">
                <Label htmlFor="emailChangeCode">{t("settings.email.codeLabel")}</Label>
                <Input
                  id="emailChangeCode"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder={t("settings.email.codeLabel")}
                  className="font-mono tracking-widest"
                  value={emailForm.code}
                  onChange={(e) =>
                    setEmailForm((f) => ({ ...f, code: e.target.value.replace(/\D/g, "") }))
                  }
                />
                <p className="text-xs text-muted-foreground">
                  {t("settings.email.changeCodeHint")}
                </p>
              </div>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEmailOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => void handleChangeEmail()}
              disabled={
                saving ||
                !emailForm.email ||
                !emailForm.password ||
                (emailForm.step === "confirm" && !/^\d{6}$/.test(emailForm.code))
              }
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {emailForm.step === "request" ? t("settings.btn.sendVerifyMail") : t("settings.btn.confirmedSubmit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}