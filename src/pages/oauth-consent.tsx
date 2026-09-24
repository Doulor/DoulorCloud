/**
 * OAuth 授权同意页。
 *
 * 触发路径：第三方站点把用户送到 `/api/oauth/authorize`，
 * 该端点校验通过且用户已登录、但尚未授权过时，302 到这里（`/oauth/consent`）。
 *
 * 这里是用户唯一能看清「哪家应用、要什么权限」的地方，
 * 所以措辞必须具体、不能含糊 —— 含糊的同意页会训练用户无脑点允许。
 */
import * as React from "react"
import { useSearchParams } from "react-router-dom"
import { Loader2, ShieldCheck, AlertTriangle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { oauthApi, HttpError, errMsg, type OAuthAuthorizeParams } from "@/services/api"

/** scope → 给普通人看的中文说明。未知 scope 也不会隐藏，照样列出来。 */
const SCOPE_LABELS: Record<string, { title: string; desc: string }> = {
  openid: { title: "确认你的身份", desc: "用于判断你是本站的哪个账号。" },
  profile: { title: "读取你的公开资料", desc: "用户名、昵称、头像。" },
  email: { title: "读取你的邮箱地址", desc: "你在本站注册时填写的真实邮箱。" },
}

function scopeLabel(s: string) {
  return SCOPE_LABELS[s] ?? { title: s, desc: "（未知权限，请谨慎授权）" }
}

/** 从 URL 查询串里取出 authorize 端点的原始参数（原样透传给后端校验） */
function readParams(sp: URLSearchParams): OAuthAuthorizeParams | null {
  const client_id = sp.get("client_id") ?? ""
  const redirect_uri = sp.get("redirect_uri") ?? ""
  if (!client_id || !redirect_uri) return null
  return {
    client_id,
    redirect_uri,
    scope: sp.get("scope"),
    state: sp.get("state"),
    response_type: sp.get("response_type"),
    code_challenge: sp.get("code_challenge"),
    code_challenge_method: sp.get("code_challenge_method"),
  }
}

export default function OAuthConsentPage() {
  const [searchParams] = useSearchParams()
  const params = React.useMemo(() => readParams(searchParams), [searchParams])

  const [ctx, setCtx] = React.useState<{
    clientName: string
    scopes: string[]
  } | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  // 只拉一次：params 是 useMemo 出来的稳定引用
  const started = React.useRef(false)
  React.useEffect(() => {
    if (!params) {
      setError("授权请求缺少必要参数（client_id / redirect_uri）")
      return
    }
    if (started.current) return
    started.current = true
    oauthApi
      .context(params)
      .then((c) => setCtx({ clientName: c.clientName, scopes: c.scopes }))
      .catch((err) => {
        // 未登录：authorize 端点本应先跳登录页，这里兜底一次
        if (err instanceof HttpError && err.status === 401) {
          const back = encodeURIComponent(window.location.pathname + window.location.search)
          window.location.replace(`/login?next=${back}`)
          return
        }
        setError(errMsg(err, "无法加载授权信息"))
      })
  }, [params])

  const submit = async (approve: boolean) => {
    if (!params || busy) return
    setBusy(true)
    try {
      const { redirectTo } = await oauthApi.decide({ ...params, approve })
      // 用 location.replace：同意页不该留在浏览器历史里，
      // 否则用户按「后退」会回到一个已经没有意义的授权页面。
      window.location.replace(redirectTo)
    } catch (err) {
      setError(errMsg(err, "操作失败"))
      setBusy(false)
    }
  }

  if (error) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              无法完成授权
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button variant="outline" className="w-full" onClick={() => window.history.back()}>
              返回
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!ctx) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center p-6">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="flex min-h-[70vh] items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4 text-primary" />
            授权登录
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            <span className="font-medium">{ctx.clientName}</span>
            <span className="text-muted-foreground"> 想要使用你的 Doulor Cloud 账号</span>
          </div>

          <div>
            <p className="mb-2 text-sm font-medium">它将能够：</p>
            <ul className="space-y-2">
              {ctx.scopes.map((s) => {
                const { title, desc } = scopeLabel(s)
                return (
                  <li key={s} className="flex gap-2.5 text-sm">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                    <span>
                      <span className="font-medium">{title}</span>
                      <span className="block text-xs text-muted-foreground">{desc}</span>
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>

          <p className="text-xs text-muted-foreground">
            它不会拿到你的密码。你随时可以在面板里撤销这个授权。
          </p>

          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              disabled={busy}
              onClick={() => void submit(false)}
            >
              拒绝
            </Button>
            <Button
              className="flex-1"
              disabled={busy}
              onClick={() => void submit(true)}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "允许"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
