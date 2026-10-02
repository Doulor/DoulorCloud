import * as React from "react"
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom"
import { Loader2, ShieldAlert } from "lucide-react"
import { toast } from "sonner"

import { AuthShell, AuthFooterLink } from "@/components/auth-shell"
import { AppealForm } from "@/components/appeal-form"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { TermsDialog } from "@/components/terms-dialog"
import { authApi, twoFactorApi, errMsg, HttpError } from "@/services/api"
import { useAuth } from "@/hooks/use-auth"
import { safeNextPath } from "@/lib/safe-next"
import { fmtDateTime } from "@/lib/format"
import { useT } from "@/i18n"

export default function LoginPage() {
  const { t } = useT()
  const { setUser } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  // 优先用 ?next=（OAuth 授权流程靠它「登录后跳回 authorize」），
  // 其次用路由 state.from（原有的受保护页面回跳），最后回落到面板首页。
  const from =
    safeNextPath(searchParams.get("next")) ??
    (location.state as { from?: string } | null)?.from ??
    "/dashboard"

  const [identifier, setIdentifier] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [termsOpen, setTermsOpen] = React.useState(false)

  /**
   * 二次验证的挂起状态。非 null 时，登录页整体切换到「验证」界面。
   *
   * ⚠️ 注意此刻**还没有登录态** —— 口令这一关过了，但后端故意没发 cookie。
   * 所以这个界面上不能跳转、不能当已登录用。
   */
  const [challenge, setChallenge] = React.useState<{
    id: string
    methods: string[]
    maskedEmail: string
  } | null>(null)
  const [code, setCode] = React.useState("")
  const [method, setMethod] = React.useState("")
  const [sendingCode, setSendingCode] = React.useState(false)
  /** 登录被拒是因为账号被封禁（SUSPENDED）→ 换成申诉界面 */
  const [suspended, setSuspended] = React.useState(false)
  /**
   * 封禁详情（后端在 403 响应里一并返回）。
   *
   * 2026-10-02 站长要求：用户**下一次登录就能看见封禁的原因以及管理员的回复**。
   * 此时他没有任何会话，登录页是唯一能承载这些说明的地方。
   */
  const [suspendInfo, setSuspendInfo] = React.useState<{
    reason: string | null
    at: string | null
    appeal: {
      status: string
      reviewNote: string | null
      createdAt: string
      reviewedAt: string | null
    } | null
  } | null>(null)

  /**
   * 登录成功后的收尾：校验 cookie 真的存下了、给提示、跳转。
   *
   * 抽出来是因为有**两条路径**走到这里：口令直接通过、以及二次验证通过之后。
   * 两处各写一份的话，「cookie 存不下」这类边界处理迟早漏掉一边。
   */
  const finishLogin = async (
    loggedInUser: NonNullable<Awaited<ReturnType<typeof authApi.login>>["user"]>,
    mustSetupTwoFactor = false
  ) => {
    setUser(loggedInUser)

    // 关键校验：登录接口返回 200 不代表浏览器真的存下了会话 cookie。
    // 若浏览器阻止了 Cookie（隐私模式、站点数据被禁、第三方 Cookie 策略等），
    // 紧接着的 /api/me 会 401，用户会被静默踢回登录页，形成「怎么都登不进去」
    // 且没有任何错误提示。这里主动验证一次，把原因明确告诉用户。
    try {
      await authApi.me()
    } catch {
      setUser(null)
      setError(t("lg.cookieFail"))
      return
    }

    const incomplete = loggedInUser.emailVerified === false
    if (incomplete) {
      toast.warning(t("lg.verifyHint"))
    } else {
      toast.success(t("lg.ok"))
    }

    // 被要求开 2FA 但还没配的管理员：登录是放行的（不能把人锁在门外），
    // 但明确告诉他该去配了 —— 前端随后在布局里持续提示。
    if (mustSetupTwoFactor) {
      toast.warning(t("lg.mustSetup2fa"))
    }

    // ⚠️ 2026-09-25 审计（F5）：`next` 指向 **API 路由**时必须整页跳转。
    //
    // OAuth 授权流程是这样的：第三方把用户送到 `/api/oauth/authorize?...`，
    // 该端点在用户未登录时 302 到 `/login?next=%2Fapi%2Foauth%2Fauthorize...`。
    // 而 `/api/*` 是 **Worker 的路由**，不是 React Router 的页面路由 ——
    // 原来一律 `navigate(from)` 做客户端跳转，结果被 `*` 兜底成 404 页，
    // 用户登录后卡在「页面不存在」，OAuth 授权永远走不完。
    // 改成整页跳转，让浏览器重新请求 Worker，由它继续 302 到同意页。
    if (from.startsWith("/api/")) {
      window.location.assign(from)
      return
    }
    navigate(from, { replace: true })
  }

  /** 给当前挑战的账号重发一封邮箱验证码 */
  const sendLoginEmailCode = async (challengeId: string) => {
    setSendingCode(true)
    try {
      await twoFactorApi.sendLoginEmail(challengeId)
      toast.success(t("lg.2fa.codeSent"))
    } catch (err) {
      toast.error(errMsg(err, t("lg.2fa.codeSendFailed")))
    } finally {
      setSendingCode(false)
    }
  }

  /** 提交二次验证码 */
  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!challenge) return
    setError(null)
    setLoading(true)
    try {
      const res = await twoFactorApi.verifyLogin({
        challengeId: challenge.id,
        method,
        code: code.trim(),
      })
      await finishLogin(res.user, res.mustSetupTwoFactor)
    } catch (err) {
      // 挑战超时/作废 → 退回口令界面重来，否则用户会一直卡在一个死掉的挑战上
      if (err instanceof HttpError && err.code === "CHALLENGE_EXPIRED") {
        setChallenge(null)
        setCode("")
        setError(t("lg.2fa.expired"))
      } else {
        setError(errMsg(err, t("lg.2fa.failed")))
      }
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const res = await authApi.login({ identifier, password })

      // 口令过了但还需要二次验证：**此时没有登录态**，切到验证界面。
      // 必须在这里就返回 —— 下面那些「已登录」的动作（/me 校验、跳转）现在都不能做。
      if (res.needTwoFactor && res.challengeId) {
        const methods = res.methods ?? []
        setChallenge({
          id: res.challengeId,
          methods,
          maskedEmail: res.maskedEmail ?? "",
        })
        // 默认选第一种；若含邮箱方式，顺手把码发出去（省一次点击）
        const first = methods[0] ?? ""
        setMethod(first)
        setCode("")
        if (methods.includes("email")) {
          void sendLoginEmailCode(res.challengeId)
        }
        return
      }

      await finishLogin(res.user!, res.mustSetupTwoFactor)
    } catch (err) {
      // 账号被封禁：不只是报个错，直接把申诉入口摆出来 ——
      // 用户此刻登不进来，再让他自己去找申诉页就太绕了。
      if (err instanceof HttpError && err.code === "SUSPENDED") {
        const d = (err.detail ?? {}) as {
          suspendReason?: string | null
          suspendAt?: string | null
          appeal?: {
            status: string
            reviewNote: string | null
            createdAt: string
            reviewedAt: string | null
          } | null
        }
        setSuspendInfo({
          reason: d.suspendReason ?? null,
          at: d.suspendAt ?? null,
          appeal: d.appeal ?? null,
        })
        setSuspended(true)
        return
      }
      setError(err instanceof HttpError ? err.message : "登录失败，请稍后重试")
    } finally {
      setLoading(false)
    }
  }

  // 封禁态：换成「封禁说明 + 申诉表单」，不再显示登录表单
  if (suspended) {
    return (
      <AuthShell
        title={t("login.bannedTitle")}
        description={t("login.bannedDesc")}
        footer={
          <>
            {t("login.registerInstead")}
            <AuthFooterLink to="/register" label={t("nav.register")} />
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="min-w-0 space-y-1">
              <p className="text-xs text-muted-foreground">{t("login.bannedNotice")}</p>
              {suspendInfo?.reason && (
                <p className="text-xs">
                  <span className="font-medium">{t("login.suspendReason")}</span>
                  {suspendInfo.reason}
                </p>
              )}
              {suspendInfo?.at && (
                <p className="text-[11px] text-muted-foreground">
                  {t("login.suspendAt", { time: fmtDateTime(suspendInfo.at) })}
                </p>
              )}
            </div>
          </div>

          {/* 上次申诉的处理结果 —— 用户申诉完最想知道的就是这个 */}
          {suspendInfo?.appeal && (
            <div className="space-y-1.5 rounded-lg border p-3">
              <p className="text-xs font-medium">
                {t("login.appealStatus")}
                {t(
                  suspendInfo.appeal.status === "pending"
                    ? "login.appeal.pending"
                    : suspendInfo.appeal.status === "accepted"
                      ? "login.appeal.accepted"
                      : "login.appeal.rejected"
                )}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {t("login.appealSubmittedAt", { time: fmtDateTime(suspendInfo.appeal.createdAt) })}
              </p>
              {suspendInfo.appeal.reviewNote ? (
                <p className="whitespace-pre-wrap text-xs">
                  <span className="font-medium">{t("login.appealReply")}</span>
                  {suspendInfo.appeal.reviewNote}
                </p>
              ) : (
                suspendInfo.appeal.status !== "pending" && (
                  <p className="text-[11px] text-muted-foreground">{t("login.appealNoReply")}</p>
                )
              )}
              {suspendInfo.appeal.status === "pending" && (
                <p className="text-[11px] text-muted-foreground">{t("login.appealPendingHint")}</p>
              )}
            </div>
          )}

          <AppealForm defaultUsername={identifier} />
          <Button
            type="button"
            variant="ghost"
            className="w-full"
            onClick={() => setSuspended(false)}
          >
            {t("login.backToLogin")}
          </Button>
        </div>
      </AuthShell>
    )
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
      {challenge ? (
        /*
          二次验证界面。此界面出现时**尚未登录**（后端故意没发 cookie），
          所以除了「提交验证码」和「重发邮件」，不放任何需要登录态的东西。
        */
        <form onSubmit={handleVerify} className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {method === "email"
              ? t("lg.2fa.emailSentTo", { email: challenge.maskedEmail })
              : method === "totp"
                ? t("lg.2fa.enterTotp")
                : t("lg.2fa.enterRecovery")}
          </p>

          {challenge.methods.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {challenge.methods.map((m) => (
                <Button
                  key={m}
                  type="button"
                  size="sm"
                  variant={m === method ? "default" : "outline"}
                  onClick={() => {
                    setMethod(m)
                    setCode("")
                    // 切到邮箱方式时立刻补发一封，否则用户面对空输入框不知从哪拿码
                    if (m === "email") void sendLoginEmailCode(challenge.id)
                  }}
                >
                  {t(`lg.2fa.method.${m}`)}
                </Button>
              ))}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="twofa-code">
              {method === "recovery" ? t("lg.2fa.recoveryLabel") : t("lg.2fa.codeLabel")}
            </Label>
            <Input
              id="twofa-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              // 数字键盘 + 关掉自动更正/首字母大写，验证码输入体验会好很多
              inputMode={method === "recovery" ? "text" : "numeric"}
              autoComplete="one-time-code"
              autoFocus
              placeholder={method === "recovery" ? "··········" : "000000"}
              maxLength={method === "recovery" ? 12 : 6}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" className="w-full" disabled={loading || !code.trim()}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : t("lg.2fa.submit")}
          </Button>

          <div className="flex items-center justify-between text-xs">
            {method === "email" ? (
              <button
                type="button"
                className="text-muted-foreground underline-offset-4 hover:underline disabled:opacity-50"
                disabled={sendingCode}
                onClick={() => void sendLoginEmailCode(challenge.id)}
              >
                {sendingCode ? t("lg.2fa.sending") : t("lg.2fa.resend")}
              </button>
            ) : (
              <span />
            )}
            <button
              type="button"
              className="text-muted-foreground underline-offset-4 hover:underline"
              onClick={() => {
                setChallenge(null)
                setCode("")
                setError(null)
              }}
            >
              {t("lg.2fa.back")}
            </button>
          </div>
        </form>
      ) : (
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="identifier">用户名 / 邮箱</Label>
          <Input
            id="identifier"
            autoComplete="username"
            placeholder="example 或 example@mail.com"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">密码</Label>
            <Link
              to="/forgot-password"
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
        <p className="text-center text-xs text-muted-foreground">
          点击「登录」即表示你已阅读并同意{" "}
          <button
            type="button"
            className="text-foreground underline underline-offset-2 hover:text-primary"
            onClick={() => setTermsOpen(true)}
          >
            《服务条款》
          </button>
        </p>
      </form>
      )}

      <TermsDialog open={termsOpen} onOpenChange={setTermsOpen} />

      <Diagnostics />
    </AuthShell>
  )
}

/**
 * 环境自检。
 * 手机浏览器往往没有开发者工具，登录失败时无法排查。
 * 这里直接暴露关键前提：能否写 Cookie、是否 https、是否无痕模式。
 * 默认折叠，点击展开。
 */
function Diagnostics() {
  const { t } = useT()
  const [open, setOpen] = React.useState(false)
  const [cookieOk, setCookieOk] = React.useState<boolean | null>(null)

  React.useEffect(() => {
    try {
      // HttpOnly cookie 由服务端下发，JS 只能验证「非 HttpOnly」的写入能力。
      // 若连这个都写不进去，说明站点数据被完全禁止。
      document.cookie = "__doulor_probe=1; Path=/; SameSite=Lax"
      const ok = document.cookie.includes("__doulor_probe=1")
      setCookieOk(ok)
      // 清理探针
      document.cookie = "__doulor_probe=; Path=/; Max-Age=0"
    } catch {
      setCookieOk(false)
    }
  }, [])

  const isHttps = window.location.protocol === "https:"
  const hasStorage = (() => {
    try {
      window.localStorage.setItem("__probe", "1")
      window.localStorage.removeItem("__probe")
      return true
    } catch {
      return false
    }
  })()

  const allGood = cookieOk === true && isHttps && hasStorage

  return (
    <div className="mt-6 border-t pt-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left text-xs text-muted-foreground hover:text-foreground"
      >
        {allGood ? t("lg.diag.ok") : t("lg.diag.bad")} · {open ? t("lg.collapse") : t("lg.expand")}
      </button>
      {open && (
        <dl className="mt-3 space-y-1.5 text-xs">
          <DiagRow label={t("lg.diag.https")} ok={isHttps} hint={isHttps ? "" : t("lg.diag.httpsHint")} />
          <DiagRow
            label={t("lg.diag.cookie")}
            ok={cookieOk === true}
            hint={cookieOk === true ? "" : t("lg.diag.cookieHint")}
          />
          <DiagRow
            label={t("lg.diag.storage")}
            ok={hasStorage}
            hint={hasStorage ? "" : t("lg.diag.storageHint")}
          />
          <div className="pt-1 text-muted-foreground">
            {t("lg.diag.domain")}<span className="font-mono">{window.location.host}</span>
          </div>
          {!allGood && (
            <p className="pt-2 text-muted-foreground">
              {t("lg.diag.tip")}
            </p>
          )}
        </dl>
      )}
    </div>
  )
}

function DiagRow({
  label,
  ok,
  hint,
}: {
  label: string
  ok: boolean
  hint: string
}) {
  const { t } = useT()
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}>
        {ok ? t("lg.diag.rowOk") : t("lg.diag.rowBad", { hint: hint ? ` (${hint})` : "" })}
      </dd>
    </div>
  )
}
