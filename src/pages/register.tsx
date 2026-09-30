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

export default function RegisterPage() {
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

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setInviteError(false)

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
      if (res.user.emailVerified === false) {
        toast.info("可前往「设置」验证真实邮箱，验证后才能使用邮件转发")
      }
      navigate("/dashboard", { replace: true })
    } catch (err) {
      const e = err instanceof HttpError ? err : null
      setError(e?.message ?? "注册失败，请稍后重试")
      // 邀请码相关的失败要单独标出来：用户多半是点好友的邀请链接进来的，
      // 这时候「换一个码」比「检查用户名」更可能是他要做的事。
      const inviteCodeErr = [
        "INVALID_INVITE",
        "INVITE_USED",
        "INVITE_EXPIRED",
        "INVITE_REQUIRED",
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
        {/* 限时开放注册：活动期间无需邀请码，给个显眼的提示 */}
        {openRegistration && (
          <div className="flex items-start gap-2.5 rounded-md border border-primary/30 bg-primary/5 p-3">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div className="space-y-1 text-xs">
              <p className="font-medium text-foreground">限时开放注册中</p>
              <p className="text-muted-foreground">
                当前无需邀请码，填写下方信息即可创建账户。
                {openUntil
                  ? ` 活动截止 ${new Date(openUntil).toLocaleString()}。`
                  : ""}
              </p>
            </div>
          </div>
        )}
        {/*
          ⚠️ 注册前就说清「注册后能拿到什么、什么需要贡献解锁」。
          原先这段说明缺失，新用户注册完进控制台才发现四个模块都是锁的，
          容易直接流失 —— 如实告知比让人抱着「全能」预期进来更好。
          权限模型以 worker/src/permissions.ts 的 FEATURES 为准。
        */}
        <div className="flex items-start gap-2.5 rounded-md border bg-muted/40 p-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">注册即用：</span>
              子域名、域名邮箱、网页收件箱、DNS 管理、临时分享箱、个人名片。
            </p>
            <p>
              <span className="font-medium text-foreground">贡献解锁：</span>
              AI 中转站、直链网盘、内网穿透、代理节点 —— 提交一份资源经审核通过后自动开放。
            </p>
          </div>
        </div>
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
            域名邮箱收到的邮件将转发到此邮箱，之后需在「设置」页验证。
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
          <Label htmlFor="inviteCode">
            邀请码{openRegistration ? "(选填)" : "(必填)"}
          </Label>
          <Input
            id="inviteCode"
            ref={inviteInputRef}
            placeholder={
              openRegistration ? "当前无需邀请码，可留空" : "输入邀请码"
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
              已自动填入邀请链接中的邀请码，确认无误后直接注册即可。
            </p>
          )}
          {inviteError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div className="space-y-1">
                <p className="font-medium">{error}</p>
                <p className="text-destructive/90">
                  每个邀请码只能使用一次。如果你是点朋友分享的邀请链接进来的，说明这条链接已经被人用过了，
                  请让朋友到「捐献与邀请 → 邀请」重新生成一条给你。
                </p>
              </div>
            </div>
          )}
        </div>
        {/* 邀请码的失败已经在字段下方单独提示了，这里只显示其余错误 */}
        {error && !inviteError && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="w-full" disabled={loading}>
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          创建账户
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          点击「创建账户」即表示你已阅读并同意{" "}
          <button
            type="button"
            className="text-foreground underline underline-offset-2 hover:text-primary"
            onClick={() => setTermsOpen(true)}
          >
            《服务条款》
          </button>
        </p>
      </form>

      <TermsDialog open={termsOpen} onOpenChange={setTermsOpen} />
    </AuthShell>
  )
}
