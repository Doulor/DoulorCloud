import * as React from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { Info, Loader2, Sparkles } from "lucide-react"
import { toast } from "sonner"

import { AuthShell, AuthFooterLink } from "@/components/auth-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { TermsDialog } from "@/components/terms-dialog"
import { authApi, HttpError } from "@/services/api"
import { useAuth } from "@/hooks/use-auth"
import { useT } from "@/i18n"

export default function RegisterPage() {
  const { t } = useT()
  const { setUser } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  /**
   * 邀请链接形如 /register?code=DC-XXXX-XXXX。
   * 有值就预填进邀请码输入框（好友点链接过来不用手抄），
   * 并且这份「初始值」也用来决定是否显示「已自动填入」的提示。
   */
  const prefilledCode = React.useMemo(
    () => (searchParams.get("code") ?? "").trim().toUpperCase(),
    [searchParams]
  )

  const [form, setForm] = React.useState({
    username: "",
    email: "",
    password: "",
    confirm: "",
    inviteCode: prefilledCode,
  })
  const [error, setError] = React.useState<string | null>(null)
  /** 失败原因出在邀请码上（无效/过期/已被使用）—— 单独醒目提示，并聚焦到输入框 */
  const [inviteError, setInviteError] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [termsOpen, setTermsOpen] = React.useState(false)
  const inviteInputRef = React.useRef<HTMLInputElement>(null)

  /**
   * 服务端的「限时开放注册」状态。开着时无需邀请码即可注册，
   * 邀请码输入框自动降级为选填，并在顶部展示活动横幅。
   * 拉取失败时按「需要邀请码」处理（保守）——不能让前端误判成开放。
   */
  const [regStatus, setRegStatus] = React.useState<{
    openRegistration: boolean
    until: string | null
    /** 当前发给用户的根域（管理员可改；由后端下发，不写死） */
    defaultRootDomain: string
  } | null>(null)

  React.useEffect(() => {
    let alive = true
    authApi
      .registerStatus()
      .then((s) => {
        if (alive) setRegStatus(s)
      })
      .catch(() => {
        /* 拉不到就保持「需要邀请码」，不影响正常注册流程 */
      })
    return () => {
      alive = false
    }
  }, [])

  const openRegistration = regStatus?.openRegistration ?? false
  const openUntil = regStatus?.until ?? null
  // 域名还没拉到时留空，避免闪出一个错的（写成 "username." 看着像坏了）
  const rootSuffix = regStatus?.defaultRootDomain
    ? `.${regStatus.defaultRootDomain}`
    : ""

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setInviteError(false)

    if (form.password !== form.confirm) {
      setError(t("reg.err.passwordMismatch"))
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
      toast.success(t("reg.ok.welcome", { username: res.user.username }))
      if (res.user.emailVerified === false) {
        toast.info(t("reg.info.verifyEmail"))
      }
      navigate("/dashboard", { replace: true })
    } catch (err) {
      const e = err instanceof HttpError ? err : null
      setError(e?.message ?? t("reg.err.failed"))
      // 邀请码相关的失败要单独标出来：用户多半是点好友的邀请链接进来的，
      // 这时候「换一个码」比「检查用户名」更可能是他要做的事。
      const inviteCodeErr = [
        "INVALID_INVITE",
        "INVITE_USED",
        "INVITE_EXPIRED",
        "INVITE_REQUIRED",
        // 邀请人被封禁 ⇒ 码失效。同属「换个码」这一类，所以要一起标出来。
        "INVITE_DISABLED",
      ]
      if (e?.code && inviteCodeErr.includes(e.code)) {
        setInviteError(true)
        inviteInputRef.current?.focus()
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthShell
      title={t("reg.title")}
      footer={
        <>
          {t("reg.haveAccount")}
          <AuthFooterLink to="/login" label={t("nav.login")} />
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* 限时开放注册：活动期间无需邀请码，给个显眼的提示 */}
        {openRegistration && (
          <div className="flex items-start gap-2.5 rounded-md border border-primary/30 bg-primary/5 p-3">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div className="space-y-1 text-xs">
              <p className="font-medium text-foreground">{t("reg.open.title")}</p>
              <p className="text-muted-foreground">
                {t("reg.open.desc")}
                {openUntil
                  ? t("reg.open.until", { at: new Date(openUntil).toLocaleString() })
                  : ""}
              </p>
            </div>
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="username">{t("settings.label.username")}</Label>
          <Input
            id="username"
            autoComplete="username"
            placeholder="example"
            value={form.username}
            onChange={set("username")}
            required
            minLength={3}
            maxLength={32}
          />
          <p className="text-xs text-muted-foreground">
            {t("reg.usernameHint.prefix")}{" "}
            <span className="font-mono">
              {form.username || "username"}
              {rootSuffix}
            </span>
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">{t("settings.label.realEmail")}</Label>
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
            {t("reg.emailHint")}
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="password">{t("settings.pw.new")}</Label>
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
            <Label htmlFor="confirm">{t("settings.pw.confirm")}</Label>
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
          <Label htmlFor="inviteCode">
            {t("reg.invite")}
              {openRegistration ? t("reg.invite.optional") : t("reg.invite.required")}
          </Label>
          <Input
            id="inviteCode"
            ref={inviteInputRef}
            placeholder={
              openRegistration ? t("reg.invite.optionalHint") : t("reg.invite.placeholder")
            }
            value={form.inviteCode}
            onChange={set("inviteCode")}
            aria-invalid={inviteError}
            className={inviteError ? "border-destructive focus-visible:ring-destructive" : undefined}
            required={!openRegistration}
          />
          {/* 只在「还是链接带来的那个码」时提示，用户手动改过就不再啰嗦 */}
          {prefilledCode !== "" && form.inviteCode === prefilledCode && !inviteError && (
            <p className="text-xs text-muted-foreground">
              {t("reg.invite.autoFilled")}
            </p>
          )}
          {inviteError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div className="space-y-1">
                <p className="font-medium">{error}</p>
                <p className="text-destructive/90">
                  {t("reg.invite.usedHint")}
                </p>
              </div>
            </div>
          )}
        </div>
        {/* 邀请码的失败已经在字段下方单独提示了，这里只显示其余错误 */}
        {error && !inviteError && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="w-full" disabled={loading}>
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          {t("reg.submit")}
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          {t("reg.agree.prefix")}{" "}
          <button
            type="button"
            className="text-foreground underline underline-offset-2 hover:text-primary"
            onClick={() => setTermsOpen(true)}
          >
            {t("reg.agree.terms")}
          </button>
        </p>
      </form>

      <TermsDialog open={termsOpen} onOpenChange={setTermsOpen} />
    </AuthShell>
  )
}
