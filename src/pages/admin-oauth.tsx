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
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
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

const SCOPE_OPTIONS = [
  { value: "openid", label: "openid", hint: "标识用户身份（必选）" },
  { value: "profile", label: "profile", hint: "用户名 / 昵称 / 头像" },
  { value: "email", label: "email", hint: "邮箱地址" },
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
    toast.success(`${what}已复制`)
  } catch {
    toast.error("复制失败，请手动复制")
  }
}

/** 一条端点地址 + 复制按钮 */
function EndpointRow({ label, value }: { label: string; value: string }) {
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
        title={`复制 ${label}`}
        aria-label={`复制 ${label}`}
      >
        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
    </div>
  )
}

export function OAuthAdminPanel() {
  const [clients, setClients] = React.useState<OAuthClient[]>([])
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [origin] = React.useState(() => window.location.origin)

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
    } catch (err) {
      toast.error(errMsg(err, "加载 OAuth 应用失败"))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

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
      toast.error("请填写应用名")
      return
    }
    if (redirectUris.length === 0) {
      toast.error("请至少填一个回调地址")
      return
    }
    if (!scopes.includes("openid")) {
      toast.error("必须包含 openid")
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
      toast.error(errMsg(err, "创建失败"))
    } finally {
      setBusy(false)
    }
  }

  const doResetSecret = async (client: OAuthClient) => {
    if (
      !window.confirm(
        `重置「${client.name}」的密钥？\n\n旧密钥会立即失效，使用它的站点在你更新配置前将无法登录。`
      )
    ) {
      return
    }
    try {
      const res = await oauthAdminApi.resetSecret(client.id)
      setSecretDialog({
        clientName: client.name,
        clientId: client.clientId,
        clientSecret: res.clientSecret,
      })
    } catch (err) {
      toast.error(errMsg(err, "重置失败"))
    }
  }

  const toggleDisabled = async (client: OAuthClient) => {
    try {
      await oauthAdminApi.update(client.id, { disabled: !client.disabled })
      toast.success(client.disabled ? "已启用" : "已停用")
      await load()
    } catch (err) {
      toast.error(errMsg(err, "操作失败"))
    }
  }

  const doDelete = async () => {
    if (!toDelete) return
    setBusy(true)
    try {
      await oauthAdminApi.remove(toDelete.id)
      toast.success("已删除")
      setToDelete(null)
      await load()
    } catch (err) {
      toast.error(errMsg(err, "删除失败"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* 端点地址：用户要填进对方站点，放最前面最方便 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">接入信息</CardTitle>
          <CardDescription>
            把这些地址填进对方站点（如 NewAPI 的「自定义 OAuth 提供商」）。
            若对方的「自动发现」报错，就手动填下面三条 Endpoint。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {endpoints(origin).map((e) => (
            <EndpointRow key={e.label} label={e.label} value={e.value} />
          ))}
          <p className="pt-1 text-xs text-muted-foreground">
            对方的回调地址（redirect_uri）需填 <code className="font-mono">对方域名/oauth/oidc</code>
            （以 NewAPI 为例），并原样登记到下面应用的「回调地址」里。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">应用（{clients.length}）</CardTitle>
            <CardDescription>每个接入的站点是一个应用</CardDescription>
          </div>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
            添加应用
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <LoadingBlock />
          ) : clients.length === 0 ? (
            <EmptyState
              icon={KeyRound}
              title="还没有应用"
              description="添加一个应用，就能让对应站点用 Doulor Cloud 登录。"
            />
          ) : (
            <div className="space-y-3">
              {clients.map((c) => (
                <div key={c.id} className="rounded-lg border p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{c.name}</span>
                    {c.disabled && <Badge variant="secondary">已停用</Badge>}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {fmtTime(c.createdAt)}
                    </span>
                  </div>

                  <div className="mt-2 space-y-1 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="w-24 shrink-0 text-muted-foreground">Client ID</span>
                      <code className="min-w-0 flex-1 truncate font-mono">{c.clientId}</code>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 shrink-0"
                        onClick={() => void copy(c.clientId, "Client ID")}
                        aria-label="复制 Client ID"
                      >
                        <Copy className="h-3 w-3" aria-hidden="true" />
                      </Button>
                    </div>
                    <div className="flex gap-2">
                      <span className="w-24 shrink-0 text-muted-foreground">回调地址</span>
                      <div className="min-w-0 flex-1 space-y-0.5">
                        {c.redirectUris.map((u) => (
                          <div key={u} className="truncate font-mono">
                            {u}
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <span className="w-24 shrink-0 text-muted-foreground">权限</span>
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
                      重置密钥
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void toggleDisabled(c)}
                    >
                      {c.disabled ? "启用" : "停用"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setToDelete(c)}
                    >
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                      删除
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
            <DialogTitle>添加 OAuth 应用</DialogTitle>
            <DialogDescription>
              回调地址必须与对方站点配置的完全一致，否则对方会拒绝接收授权结果。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="oauth-name">应用名</Label>
              <Input
                id="oauth-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="如：NewAPI"
              />
              <p className="text-xs text-muted-foreground">用户在同意页上看到的就是这个名字。</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="oauth-uris">回调地址（每行一个）</Label>
              <Textarea
                id="oauth-uris"
                value={urisText}
                onChange={(e) => setUrisText(e.target.value)}
                rows={3}
                placeholder={"https://api.example.com/oauth/oidc"}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                必须 https。本机调试可填 http://127.0.0.1/… （需在对方站点也保持一致）。
              </p>
            </div>

            <div className="space-y-2">
              <Label>权限</Label>
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
                  <span className="text-muted-foreground">{s.hint}</span>
                </label>
              ))}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={busy}>
              取消
            </Button>
            <Button onClick={() => void submitCreate()} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "创建"}
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
              密钥已生成
            </DialogTitle>
            <DialogDescription>
              <span className="font-medium text-destructive">
                这段密钥只显示这一次
              </span>
              ，关掉后就查不到了（库里只存哈希）。请立刻复制到对方站点。
            </DialogDescription>
          </DialogHeader>

          {secretDialog && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="shrink-0 text-muted-foreground">应用</span>
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
                    复制
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
                    复制
                  </Button>
                </div>
              </div>

              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-muted-foreground">
                <AlertTriangle
                  className="mr-1 inline h-3.5 w-3.5 text-destructive"
                  aria-hidden="true"
                />
                没有存下来？关掉后只能用「重置密钥」重新生成一个（旧的会立即失效）。
              </div>
            </div>
          )}

          <DialogFooter>
            <Button onClick={() => setSecretDialog(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <Dialog open={toDelete !== null} onOpenChange={(o) => !o && setToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除应用</DialogTitle>
            <DialogDescription>
              删除「{toDelete?.name}」后，它的全部访问令牌与授权记录会立即作废，
              使用它的站点将无法再用 Doulor Cloud 登录。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToDelete(null)} disabled={busy}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void doDelete()} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "确认删除"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
