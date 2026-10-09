/**
 * 管理面板 → OAuth 应用。
 *
 * 为什么单独一个文件、而内容不直接写进 admin.tsx：
 *   admin.tsx 已经 4500+ 行，且同一时间可能有其他改动在动它。
 *   把 UI 本体放这里，admin.tsx 里只需 3 行（import + 标签 + 挂载），
 *   即使那边整体覆盖了，也只需几秒重贴。
 *
 * 本页是「Doulor Cloud 作为身份提供方」的自助入口：
 * 用户在这里建应用、拿 client_id/secret、填回调地址，
 * 然后把上面的端点地址填进 NewAPI 之类的站点，即可实现用它登录。
 */
import * as React from "react"
import { toast } from "sonner"
import {
  AlertTriangle,
  Check,
  Copy,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { confirmDialog, promptDialog } from "@/components/confirm-dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { LoadingBlock } from "@/components/loading-block"
import { EmptyState } from "@/components/empty-state"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  oauthAdminApi,
  errMsg,
  type OAuthClient,
} from "@/services/api"
import { fmtTime } from "@/lib/format"
import { useT, tStatic } from "@/i18n"

const SCOPE_OPTIONS = [
  { value: "openid", label: "openid", hint: "ao.scope.openidHint" },
  { value: "profile", label: "profile", hint: "ao.scope.profileHint" },
  { value: "email", label: "email", hint: "ao.scope.emailHint" },
]

/** 供对方站点填写的端点地址。用当前 origin 拼，换域名也不会写错。 */
function endpoints(origin: string) {
  return [
    { label: "Discovery URL", value: `${origin}/api/.well-known/openid-configuration` },
    { label: "Authorization Endpoint", value: `${origin}/api/oauth/authorize` },
    { label: "Token Endpoint", value: `${origin}/api/oauth/token` },
    { label: "UserInfo Endpoint", value: `${origin}/api/oauth/userinfo` },
  ]
}

async function copy(value: string, what: string) {
  try {
    await navigator.clipboard.writeText(value)
    toast.success(tStatic("ao.ok.copied", { what }))
  } catch {
    toast.error(tStatic("ao.err.copy"))
  }
}

/** 一条端点地址 + 复制按钮 */
function EndpointRow({ label, value }: { label: string; value: string }) {
  const { t } = useT()
  return (
    <div className="flex items-center gap-2">
      <span className="w-44 shrink-0 text-xs text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
        {value}
      </code>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0"
        onClick={() => void copy(value, label)}
        title={t("ao.copyTitle", { label })}
        aria-label={t("ao.copyTitle", { label })}
      >
        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
    </div>
  )
}

export function OAuthAdminPanel() {
  const { t } = useT()
  const [clients, setClients] = React.useState<OAuthClient[]>([])
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [origin] = React.useState(() => window.location.origin)
  /** 用户自助创建当前是否「免审」（对应设置项 oauth_user_clients_open） */
  const [autoApprove, setAutoApprove] = React.useState(false)

  // 新建
  const [createOpen, setCreateOpen] = React.useState(false)
  const [name, setName] = React.useState("")
  const [urisText, setUrisText] = React.useState("")
  const [scopes, setScopes] = React.useState<string[]>(["openid", "profile", "email"])

  // 一次性密钥展示
  const [secretDialog, setSecretDialog] = React.useState<{
    clientName: string
    clientId: string
    clientSecret: string
  } | null>(null)

  // 删除确认
  const [toDelete, setToDelete] = React.useState<OAuthClient | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await oauthAdminApi.list()
      setClients(res.clients)
      setAutoApprove(res.autoApprove)
    } catch (err) {
      toast.error(errMsg(err, t("ao.err.load")))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  /** 切换「用户自建应用免审」开关（关着 = 用户提交的要逐个审核） */
  const toggleAutoApprove = async (v: boolean) => {
    setBusy(true)
    try {
      await oauthAdminApi.setAutoApprove(v)
      setAutoApprove(v)
      toast.success(v ? t("ao.policy.onToast") : t("ao.policy.offToast"))
    } catch (err) {
      toast.error(errMsg(err, t("ao.err.op")))
    } finally {
      setBusy(false)
    }
  }

  /** 审核用户提交的应用：通过 / 驳回 */
  const doReview = async (client: OAuthClient, approve: boolean) => {    let note = ""
    if (!approve) {
      note =
        (await promptDialog({
          title: t("ao.review.rejectPrompt", { name: client.name }),
          input: {},
        })) ?? ""
      if (note.trim() === "") return // 用户取消 / 没填原因
    }
    setBusy(true)
    try {
      await oauthAdminApi.review(client.id, { approve, note: note.trim() || undefined })
      toast.success(approve ? t("ao.review.approved") : t("ao.review.rejected"))
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("ao.err.op")))
    } finally {
      setBusy(false)
    }
  }

  const resetForm = () => {
    setName("")
    setUrisText("")
    setScopes(["openid", "profile", "email"])
  }

  const submitCreate = async () => {
    const redirectUris = urisText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
    if (!name.trim()) {
      toast.error(t("ao.err.nameRequired"))
      return
    }
    if (redirectUris.length === 0) {
      toast.error(t("ao.err.uriRequired"))
      return
    }
    if (!scopes.includes("openid")) {
      toast.error(t("ao.err.openidRequired"))
      return
    }

    setBusy(true)
    try {
      const res = await oauthAdminApi.create({
        name: name.trim(),
        redirectUris,
        scopes: scopes.join(" "),
      })
      setCreateOpen(false)
      resetForm()
      setSecretDialog({
        clientName: res.client.name,
        clientId: res.client.clientId,
        clientSecret: res.clientSecret,
      })
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("dm.err.create")))
    } finally {
      setBusy(false)
    }
  }

  const doResetSecret = async (client: OAuthClient) => {
    const ok = await confirmDialog({
      title: t("ao.confirmReset", { name: client.name }),
      danger: true,
    })
    if (!ok) return
    try {
      const res = await oauthAdminApi.resetSecret(client.id)
      setSecretDialog({
        clientName: client.name,
        clientId: client.clientId,
        clientSecret: res.clientSecret,
      })
    } catch (err) {
      toast.error(errMsg(err, t("ao.err.reset")))
    }
  }

  const toggleDisabled = async (client: OAuthClient) => {
    try {
      await oauthAdminApi.update(client.id, { disabled: !client.disabled })
      toast.success(client.disabled ? t("common.enabled") : t("common.disabled"))
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("em.err.op")))
    }
  }

  const doDelete = async () => {
    if (!toDelete) return
    setBusy(true)
    try {
      await oauthAdminApi.remove(toDelete.id)
      toast.success(t("at.ok.deleted"))
      setToDelete(null)
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("em.err.delete")))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* 端点地址：用户要填进对方站点，放最前面最方便 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("ao.info.title")}</CardTitle>
          <CardDescription>
            {t("ao.info.desc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {endpoints(origin).map((e) => (
            <EndpointRow key={e.label} label={e.label} value={e.value} />
          ))}
          <p className="pt-1 text-xs text-muted-foreground">
            {t("ao.info.callbackNoteA")}
            <code className="font-mono">{t("ao.info.peerDomain")}/oauth/oidc</code>
            {t("ao.info.callbackNoteB")}
          </p>
        </CardContent>
      </Card>

      {/* 用户自建应用的策略开关（2026-10-06） */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("ao.policy.title")}</CardTitle>
          <CardDescription>{t("ao.policy.desc")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4 rounded-md border px-4 py-3">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">{t("ao.policy.autoApprove")}</p>
              <p className="text-xs text-muted-foreground">
                {autoApprove ? t("ao.policy.onHint") : t("ao.policy.offHint")}
              </p>
            </div>
            <Switch
              checked={autoApprove}
              disabled={busy}
              onCheckedChange={(v) => void toggleAutoApprove(v)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">{t("ao.apps.title", { n: clients.length })}</CardTitle>
            <CardDescription>{t("ao.apps.desc")}</CardDescription>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {autoApprove ? t("ao.apps.autoApprove") : t("ao.apps.manualReview")}
            </p>
          </div>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {t("ao.apps.add")}
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <LoadingBlock variant="list" />
          ) : clients.length === 0 ? (
            <EmptyState
              icon={KeyRound}
              title={t("ao.apps.empty")}
              description={t("ao.apps.emptyDesc")}
            />
          ) : (
            <div className="space-y-3">
              {clients.map((c) => (
                <div key={c.id} className="rounded-lg border p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{c.name}</span>
                    {c.reviewStatus === "pending" && (
                      <Badge variant="outline" className="border-amber-500 text-amber-600">
                        {t("ao.review.pending")}
                      </Badge>
                    )}
                    {c.reviewStatus === "rejected" && (
                      <Badge variant="outline" className="border-destructive text-destructive">
                        {t("ao.review.rejectedBadge")}
                      </Badge>
                    )}
                    {c.disabled && <Badge variant="secondary">{t("common.disabled")}</Badge>}
                    {/* 谁创建的：放开用户自建后，站长要顺着这个 + 回调域名去审查 */}
                    {c.ownerName && (
                      <span className="text-xs text-muted-foreground">
                        {t("ao.owner", { name: c.ownerName })}
                      </span>
                    )}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {fmtTime(c.createdAt)}
                    </span>
                  </div>

                  {/* 待审核：给出「通过 / 驳回」这一条主操作 */}
                  {c.reviewStatus === "pending" && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5">
                      <span className="text-xs text-muted-foreground">{t("ao.review.hint")}</span>
                      <Button
                        size="sm"
                        className="ml-auto"
                        disabled={busy}
                        onClick={() => void doReview(c, true)}
                      >
                        <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                        {t("ao.review.approve")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => void doReview(c, false)}
                      >
                        <X className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                        {t("ao.review.reject")}
                      </Button>
                    </div>
                  )}
                  {c.reviewStatus === "rejected" && c.reviewNote && (
                    <p className="mt-2 text-xs text-destructive">
                      {t("ao.review.note", { note: c.reviewNote })}
                    </p>
                  )}

                  <div className="mt-2 space-y-1 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="w-24 shrink-0 text-muted-foreground">Client ID</span>
                      <code className="min-w-0 flex-1 truncate font-mono">{c.clientId}</code>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 shrink-0"
                        onClick={() => void copy(c.clientId, "Client ID")}
                        aria-label={t("ao.copyClientId")}
                      >
                        <Copy className="h-3 w-3" aria-hidden="true" />
                      </Button>
                    </div>
                    <div className="flex gap-2">
                      <span className="w-24 shrink-0 text-muted-foreground">{t("ao.field.redirect")}</span>
                      <div className="min-w-0 flex-1 space-y-0.5">
                        {c.redirectUris.map((u) => (
                          <div key={u} className="truncate font-mono">
                            {u}
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <span className="w-24 shrink-0 text-muted-foreground">{t("ao.field.scopes")}</span>
                      <span className="font-mono">{c.scopes}</span>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void doResetSecret(c)}
                    >
                      <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                      {t("ao.reset")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void toggleDisabled(c)}
                    >
                      {c.disabled ? t("common.enable") : t("common.disable")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setToDelete(c)}
                    >
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                      {t("common.delete")}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 新建应用 */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("ao.dlg.title")}</DialogTitle>
            <DialogDescription>
              {t("ao.dlg.desc")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="oauth-name">{t("ao.dlg.name")}</Label>
              <Input
                id="oauth-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("ao.dlg.namePh")}
              />
              <p className="text-xs text-muted-foreground">{t("ao.dlg.nameHint")}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="oauth-uris">{t("ao.dlg.uris")}</Label>
              <Textarea
                id="oauth-uris"
                value={urisText}
                onChange={(e) => setUrisText(e.target.value)}
                rows={3}
                placeholder={"https://api.example.com/oauth/oidc"}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                {t("ao.dlg.urisHint")}
              </p>
            </div>

            <div className="space-y-2">
              <Label>{t("ao.field.scopes")}</Label>
              {SCOPE_OPTIONS.map((s) => (
                <label key={s.value} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={scopes.includes(s.value)}
                    disabled={s.value === "openid"}
                    onChange={(e) =>
                      setScopes((prev) =>
                        e.target.checked
                          ? [...prev, s.value]
                          : prev.filter((v) => v !== s.value)
                      )
                    }
                  />
                  <code className="font-mono text-xs">{s.label}</code>
                  <span className="text-muted-foreground">{t(s.hint)}</span>
                </label>
              ))}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void submitCreate()} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t("common.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 一次性密钥展示 */}
      <Dialog open={secretDialog !== null} onOpenChange={(o) => !o && setSecretDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Check className="h-4 w-4 text-primary" aria-hidden="true" />
              {t("ao.secret.title")}
            </DialogTitle>
            <DialogDescription>
              <span className="font-medium text-destructive">
                {t("ao.secret.once")}
              </span>
              {t("ao.secret.desc")}
            </DialogDescription>
          </DialogHeader>

          {secretDialog && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="shrink-0 text-muted-foreground">{t("ao.secret.app")}</span>
                <span className="font-medium">{secretDialog.clientName}</span>
              </div>

              {/* 密钥字段用上下堆叠布局，避免长 secret 把弹窗撑变形 */}
              <div className="space-y-1.5">
                <div className="text-xs text-muted-foreground">Client ID</div>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1.5 font-mono text-xs leading-relaxed">
                    {secretDialog.clientId}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => void copy(secretDialog.clientId, "Client ID")}
                  >
                    <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                    {t("common.copy")}
                  </Button>
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="text-xs text-muted-foreground">Client Secret</div>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1.5 font-mono text-xs leading-relaxed">
                    {secretDialog.clientSecret}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => void copy(secretDialog.clientSecret, "Client Secret")}
                  >
                    <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                    {t("common.copy")}
                  </Button>
                </div>
              </div>

              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-muted-foreground">
                <AlertTriangle
                  className="mr-1 inline h-3.5 w-3.5 text-destructive"
                  aria-hidden="true"
                />
                {t("ao.secret.lost")}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button onClick={() => setSecretDialog(null)}>{t("common.close")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <Dialog open={toDelete !== null} onOpenChange={(o) => !o && setToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("ao.del.title")}</DialogTitle>
            <DialogDescription>
              {t("ao.del.desc", { name: toDelete?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToDelete(null)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button variant="destructive" onClick={() => void doDelete()} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t("ao.del.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
