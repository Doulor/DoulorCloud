import * as React from "react"
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { AuthShell, AuthFooterLink } from "@/components/auth-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { TermsDialog } from "@/components/terms-dialog"
import { authApi, HttpError } from "@/services/api"
import { useAuth } from "@/hooks/use-auth"
import { safeNextPath } from "@/lib/safe-next"
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const res = await authApi.login({ identifier, password })
      setUser(res.user)

      // 关键校验：登录接口返回 200 不代表浏览器真的存下了会话 cookie。
      // 若浏览器阻止了 Cookie（隐私模式、站点数据被禁、第三方 Cookie 策略等），
      // 紧接着的 /api/me 会 401，用户会被静默踢回登录页，形成「怎么都登不进去」
      // 且没有任何错误提示。这里主动验证一次，把原因明确告诉用户。
      try {
        await authApi.me()
      } catch {
        setUser(null)
        setError(
          t("lg.cookieFail")
        )
        return
      }

      const incomplete = res.user.emailVerified === false
      if (incomplete) {
        toast.warning(t("lg.verifyHint"))
      } else {
        toast.success(t("lg.ok"))
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
