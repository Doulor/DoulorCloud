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
import { useT } from "@/i18n"

/** scope → 给普通人看的中文说明。未知 scope 也不会隐藏，照样列出来。 */
const SCOPE_LABELS: Record<string, { title: string; desc: string }> = {
  openid: { title: "oc.scope.openid.title", desc: "oc.scope.openid.desc" },
  profile: { title: "oc.scope.profile.title", desc: "oc.scope.profile.desc" },
  email: { title: "oc.scope.email.title", desc: "oc.scope.email.desc" },
}

function scopeLabel(s: string) {
  return SCOPE_LABELS[s] ?? { title: s, desc: "oc.scope.unknown" }
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
  const { t } = useT()
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
      setError(t("oc.err.params"))
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
        setError(errMsg(err, t("oc.err.load")))
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
      setError(errMsg(err, t("oc.err.op")))
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
              {t("oc.failed")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button variant="outline" className="w-full" onClick={() => window.history.back()}>
              {t("oc.back")}
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
            {t("oc.title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            <span className="font-medium">{ctx.clientName}</span>
            <span className="text-muted-foreground"> {t("oc.wantsAccess")}</span>
          </div>

          <div>
            <p className="mb-2 text-sm font-medium">{t("oc.willBeAble")}</p>
            <ul className="space-y-2">
              {ctx.scopes.map((s) => {
                const { title, desc } = scopeLabel(s)
                return (
                  <li key={s} className="flex gap-2.5 text-sm">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                    <span>
                      <span className="font-medium">{t(title)}</span>
                      <span className="block text-xs text-muted-foreground">{t(desc)}</span>
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>

          <p className="text-xs text-muted-foreground">
            {t("oc.note")}
          </p>

          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              disabled={busy}
              onClick={() => void submit(false)}
            >
              {t("oc.deny")}
            </Button>
            <Button
              className="flex-1"
              disabled={busy}
              onClick={() => void submit(true)}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t("oc.allow")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
