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

      // 关键校验：登录接口返回 200 不代表浏览器真的存下了会话 cookie。
      // 若浏览器阻止了 Cookie（隐私模式、站点数据被禁、第三方 Cookie 策略等），
      // 紧接着的 /api/me 会 401，用户会被静默踢回登录页，形成「怎么都登不进去」
      // 且没有任何错误提示。这里主动验证一次，把原因明确告诉用户。
      try {
        await authApi.me()
      } catch {
        setUser(null)
        setError(
          "登录成功，但浏览器没有保存登录状态。请检查：① 是否禁用了本站的 Cookie / 站点数据；② 是否处于无痕或隐私模式；③ 是否通过 https 访问。"
        )
        return
      }

      const incomplete = res.user.emailVerified === false
      if (incomplete) {
        toast.warning("登录成功，建议前往「设置」验证真实邮箱")
      } else {
        toast.success("登录成功")
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
        {allGood ? "环境检测正常" : "⚠️ 环境检测发现问题"} · 点击{open ? "收起" : "展开"}
      </button>
      {open && (
        <dl className="mt-3 space-y-1.5 text-xs">
          <DiagRow label="HTTPS 访问" ok={isHttps} hint={isHttps ? "" : "请用 https:// 打开本站"} />
          <DiagRow
            label="允许写入 Cookie"
            ok={cookieOk === true}
            hint={cookieOk === true ? "" : "浏览器阻止了本站 Cookie / 站点数据"}
          />
          <DiagRow
            label="本地存储可用"
            ok={hasStorage}
            hint={hasStorage ? "" : "可能处于无痕或隐私模式"}
          />
          <div className="pt-1 text-muted-foreground">
            当前域名：<span className="font-mono">{window.location.host}</span>
          </div>
          {!allGood && (
            <p className="pt-2 text-muted-foreground">
              若「允许写入 Cookie」为否：请在本站设置里允许 Cookie／站点数据，
              或关闭无痕模式。iOS 还需检查「设置 → Safari → 阻止所有 Cookie」
              与「隐私 → 网站数据」。
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
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}>
        {ok ? "正常" : `异常${hint ? `（${hint}）` : ""}`}
      </dd>
    </div>
  )
}
