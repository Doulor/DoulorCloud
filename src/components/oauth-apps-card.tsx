/**
 * 设置页「我的 OAuth 应用」卡片（2026-10-06）。
 *
 * 用途：让用户创建 OAuth 应用，把「用 Doulor Cloud 登录」接到自己的站点上。
 *
 * ⚠️ 安全设计（与后端配套，改动时两边一起看）：
 *   · 应用名有**敏感词拦截**（防冒充官方 / 客服）——后端 assertClientNameAllowed；
 *   · 改了**名字或回调地址会重新排队审核**（否则先过审、再偷偷改成钓鱼地址就白审了）；
 *   · `client_secret` 明文**只显示一次**，库里只有哈希，丢了只能删掉重建；
 *   · 用户创建的应用要站长在后台点通过后才能用（除非站长开着「免审」开关）。
 *
 * 权限（scope）固定为 `openid profile email`，不给用户选：普通用户接登录
 * 基本就是这三样，少一个选项少一类出错。要更细的权限走管理端。
 */
import * as React from "react"
import { toast } from "sonner"
import { Loader2, Plus, Trash2, Pencil, Copy, ShieldAlert, KeyRound } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
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
import { oauthApi, errMsg, type OAuthClient } from "@/services/api"
import { useT } from "@/i18n"
import { fmtTime } from "@/lib/format"

/** 用户侧固定的权限集合（见文件头注释） */
const USER_SCOPES = "openid profile email"

export function OAuthAppsCard() {
  const { t } = useT()
  const [clients, setClients] = React.useState<OAuthClient[]>([])
  const [autoApprove, setAutoApprove] = React.useState(false)
  const [maxClients, setMaxClients] = React.useState(5)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)

  // 新建 / 编辑
  const [formOpen, setFormOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<OAuthClient | null>(null)
  const [name, setName] = React.useState("")
  const [urisText, setUrisText] = React.useState("")

  // 一次性密钥展示
  const [secretDialog, setSecretDialog] = React.useState<{
    clientId: string
    clientSecret: string
    pending: boolean
  } | null>(null)

  const [toDelete, setToDelete] = React.useState<OAuthClient | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await oauthApi.myClients()
      setClients(res.clients)
      setAutoApprove(res.autoApprove)
      setMaxClients(res.maxClients)
    } catch (err) {
      toast.error(errMsg(err, t("oapp.err.load")))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const openCreate = () => {
    setEditing(null)
    setName("")
    setUrisText("")
    setFormOpen(true)
  }

  const openEdit = (c: OAuthClient) => {
    setEditing(c)
    setName(c.name)
    setUrisText(c.redirectUris.join("\n"))
    setFormOpen(true)
  }

  const submit = async () => {
    const redirectUris = urisText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
    if (!name.trim()) {
      toast.error(t("oapp.err.nameRequired"))
      return
    }
    if (redirectUris.length === 0) {
      toast.error(t("oapp.err.uriRequired"))
      return
    }
    setBusy(true)
    try {
      if (editing) {
        await oauthApi.updateMyClient(editing.id, {
          name: name.trim(),
          redirectUris,
          scopes: USER_SCOPES,
        })
        toast.success(t("oapp.ok.updated"))
        setFormOpen(false)
      } else {
        const res = await oauthApi.createMyClient({
          name: name.trim(),
          redirectUris,
          scopes: USER_SCOPES,
        })
        setFormOpen(false)
        setSecretDialog({
          clientId: res.client.clientId,
          clientSecret: res.clientSecret,
          pending: res.pending,
        })
      }
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("oapp.err.save")))
    } finally {
      setBusy(false)
    }
  }

  const doDelete = async () => {
    if (!toDelete) return
    setBusy(true)
    try {
      await oauthApi.deleteMyClient(toDelete.id)
      toast.success(t("oapp.ok.deleted"))
      setToDelete(null)
      await load()
    } catch (err) {
      toast.error(errMsg(err, t("oapp.err.delete")))
    } finally {
      setBusy(false)
    }
  }

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(t("common.copied"))
    } catch {
      toast.error(t("oapp.err.copy"))
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4 text-muted-foreground" />
            {t("oapp.title")}
          </CardTitle>
          <CardDescription>{t("oapp.desc")}</CardDescription>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {autoApprove
              ? t("oapp.autoApprove")
              : t("oapp.manualReview")}
            {" · "}
            {t("oapp.quota", { used: clients.length, max: maxClients })}
          </p>
        </div>
        <Button
          size="sm"
          onClick={openCreate}
          disabled={loading || clients.length >= maxClients}
        >
          <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
          {t("oapp.add")}
        </Button>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("common.loading")}
          </div>
        ) : clients.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">{t("oapp.empty")}</p>
        ) : (
          <div className="space-y-3">
            {clients.map((c) => (
              <div key={c.id} className="rounded-lg border p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{c.name}</span>
                  {c.reviewStatus === "pending" && (
                    <Badge variant="outline" className="border-amber-500 text-amber-600">
                      {t("oapp.status.pending")}
                    </Badge>
                  )}
                  {c.reviewStatus === "rejected" && (
                    <Badge variant="outline" className="border-destructive text-destructive">
                      {t("oapp.status.rejected")}
                    </Badge>
                  )}
                  {c.reviewStatus === "approved" && !c.disabled && (
                    <Badge variant="secondary">{t("oapp.status.approved")}</Badge>
                  )}
                  {c.disabled && <Badge variant="secondary">{t("common.disabled")}</Badge>}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {fmtTime(c.createdAt)}
                  </span>
                </div>

                {c.reviewStatus === "rejected" && c.reviewNote && (
                  <p className="mt-2 text-xs text-destructive">
                    {t("oapp.rejectNote", { note: c.reviewNote })}
                  </p>
                )}

                <div className="mt-2 space-y-1 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="w-20 shrink-0 text-muted-foreground">Client ID</span>
                    <code className="min-w-0 flex-1 truncate font-mono">{c.clientId}</code>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0"
                      onClick={() => void copyText(c.clientId)}
                      aria-label={t("ao.copyClientId")}
                    >
                      <Copy className="h-3 w-3" aria-hidden="true" />
                    </Button>
                  </div>
                  <div className="flex gap-2">
                    <span className="w-20 shrink-0 text-muted-foreground">
                      {t("oapp.field.redirect")}
                    </span>
                    <div className="min-w-0 flex-1 space-y-0.5">
                      {c.redirectUris.map((u) => (
                        <div key={u} className="truncate font-mono">
                          {u}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => openEdit(c)}>
                    <Pencil className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                    {t("common.edit")}
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

      {/* 新建 / 编辑 */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? t("oapp.dlg.editTitle") : t("oapp.dlg.title")}</DialogTitle>
            <DialogDescription>
              {editing ? t("oapp.dlg.editDesc") : t("oapp.dlg.desc")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="oapp-name">{t("oapp.dlg.name")}</Label>
              <Input
                id="oapp-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("oapp.dlg.namePh")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="oapp-uris">{t("oapp.dlg.uris")}</Label>
              <Textarea
                id="oapp-uris"
                rows={3}
                value={urisText}
                onChange={(e) => setUrisText(e.target.value)}
                placeholder={"https://example.com/auth/callback"}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">{t("oapp.dlg.urisHint")}</p>
            </div>
            <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
              <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
              <p className="text-muted-foreground">{t("oapp.dlg.warning")}</p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void submit()} disabled={busy}>
              {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 一次性密钥 */}
      <Dialog open={secretDialog !== null} onOpenChange={(o) => !o && setSecretDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("oapp.secret.title")}</DialogTitle>
            <DialogDescription>
              {secretDialog?.pending
                ? t("oapp.secret.pendingDesc")
                : t("oapp.secret.desc")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Client ID</Label>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
                  {secretDialog?.clientId}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  onClick={() => void copyText(secretDialog?.clientId ?? "")}
                >
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </div>
            </div>
            <div className="space-y-1">
              <Label>Client Secret</Label>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
                  {secretDialog?.clientSecret}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  onClick={() => void copyText(secretDialog?.clientSecret ?? "")}
                >
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t("oapp.secret.once")}</p>
          </div>
          <DialogFooter>
            <Button onClick={() => setSecretDialog(null)}>{t("common.done")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <Dialog open={toDelete !== null} onOpenChange={(o) => !o && setToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("oapp.delete.title")}</DialogTitle>
            <DialogDescription>
              {t("oapp.delete.desc", { name: toDelete?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToDelete(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="destructive" onClick={() => void doDelete()} disabled={busy}>
              {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
