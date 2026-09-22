import * as React from "react"
import {
  AlertTriangle,
  Bot,
  Copy,
  ExternalLink,
  Gift,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Wallet,
} from "lucide-react"
import { toast } from "sonner"

import { PageHeader } from "@/components/page-header"
import { FeatureLockedNotice } from "@/components/feature-locked-notice"
import { EmptyState } from "@/components/empty-state"
import { LoadingBlock } from "@/components/loading-block"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Label } from "@/components/ui/label"
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { newapiApi, HttpError } from "@/services/api"
import type { NewApiKey, NewApiPreflight, NewApiStatus } from "@/types"

function fmtTime(iso: string | null) {
  if (!iso) return "—"
  return new Date(iso).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export default function AiPage() {
  const [status, setStatus] = React.useState<NewApiStatus | null>(null)
  const [keys, setKeys] = React.useState<NewApiKey[]>([])
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [syncing, setSyncing] = React.useState(false)
  const [deletingKeyId, setDeletingKeyId] = React.useState<string | null>(null)

  // 开通
  const [bindOpen, setBindOpen] = React.useState(false)
  const [preflight, setPreflight] = React.useState<NewApiPreflight | null>(null)
  const [preflightLoading, setPreflightLoading] = React.useState(false)
  const [password, setPassword] = React.useState("")
  const [confirm, setConfirm] = React.useState("")

  // 新建 Key
  const [keyOpen, setKeyOpen] = React.useState(false)
  const [keyName, setKeyName] = React.useState("")
  const [keyGroup, setKeyGroup] = React.useState("default")

  // 兑换码
  const [redeemCode, setRedeemCode] = React.useState("")
  const [redeemBusy, setRedeemBusy] = React.useState(false)

  // 改中转站密码
  const [aiPwOpen, setAiPwOpen] = React.useState(false)
  const [aiPw, setAiPw] = React.useState({ current: "", next: "", confirm: "" })
  const [aiPwBusy, setAiPwBusy] = React.useState(false)
  /** 完整 key 只在创建时展示一次，不落库 */
  const [createdKey, setCreatedKey] = React.useState<string | null>(null)

  /** 拉取状态与 Key 列表；silent 用于对话框流程中刷新，避免整页 loading 卸载弹窗 */
  // 无权限（403 FEATURE_NOT_PERMITTED）：整页显示提示 + 捐献入口
  const [locked, setLocked] = React.useState(false)

  const load = React.useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const res = await newapiApi.status()
      setStatus(res)
      if (res.account) {
        const k = await newapiApi.listKeys()
        setKeys(k.keys)
      } else {
        setKeys([])
      }
    } catch (err) {
      if (err instanceof HttpError && err.code === "FEATURE_NOT_PERMITTED") {
        setLocked(true)
        return
      }
      toast.error(err instanceof HttpError ? err.message : "加载失败")
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const copyText = async (text: string, label = "已复制") => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(label)
    } catch {
      toast.error("复制失败，请手动选择复制")
    }
  }

  /** 打开开通弹窗前先探测：中转站是否已有同名账号 */
  const openBind = async () => {
    setPreflightLoading(true)
    setBindOpen(true)
    try {
      setPreflight(await newapiApi.preflight())
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "无法连接中转站")
      setBindOpen(false)
    } finally {
      setPreflightLoading(false)
    }
  }

  const handleBind = async () => {
    // 新账号流程需要确认两次密码；绑定已有账号只有一个密码框
    const isBindExisting = Boolean(preflight?.exists)
    if (!isBindExisting && password !== confirm) {
      toast.error("两次输入的密码不一致")
      return
    }
    setBusy(true)
    try {
      await newapiApi.bind(password)
      toast.success("AI 中转站已开通")
      setBindOpen(false)
      setPassword("")
      setConfirm("")
      // 静默刷新：非静默会整页 loading，把弹窗和错误提示一起卸载掉
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "开通失败")
    } finally {
      setBusy(false)
    }
  }

  const handleSync = async () => {
    if (syncing) return
    setSyncing(true)
    try {
      await newapiApi.sync()
      await load(true)
      toast.success("已同步额度")
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "同步失败")
    } finally {
      setSyncing(false)
    }
  }

  const handleCreateKey = async () => {
    setBusy(true)
    try {
      const res = await newapiApi.createKey(keyName, keyGroup)
      setCreatedKey(res.key.fullKey)
      setKeyName("")
      // 静默刷新列表，不能让整页 loading 卸载掉展示完整 Key 的弹窗
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "创建失败")
    } finally {
      setBusy(false)
    }
  }

  const handleRedeem = async () => {
    if (!redeemCode.trim()) return
    setRedeemBusy(true)
    try {
      const res = await newapiApi.redeem(redeemCode.trim())
      toast.success(
        `兑换成功：+${res.currencySymbol}${res.addedDisplay}`
      )
      setRedeemCode("")
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "兑换失败")
    } finally {
      setRedeemBusy(false)
    }
  }

  const handleAiPassword = async () => {
    if (aiPw.next !== aiPw.confirm) {
      toast.error("两次输入的新密码不一致")
      return
    }
    setAiPwBusy(true)
    try {
      await newapiApi.changePassword({
        currentPassword: aiPw.current,
        newPassword: aiPw.next,
      })
      toast.success("中转站密码已修改")
      setAiPwOpen(false)
      setAiPw({ current: "", next: "", confirm: "" })
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "修改失败")
    } finally {
      setAiPwBusy(false)
    }
  }

  const handleDeleteKey = async (key: NewApiKey) => {
    if (deletingKeyId) return
    setDeletingKeyId(key.id)
    try {
      await newapiApi.removeKey(key.id)
      toast.success("Key 已删除")
      await load(true)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "删除失败")
    } finally {
      setDeletingKeyId(null)
    }
  }

  const handleSyncKeys = async () => {
    if (syncing) return
    setSyncing(true)
    try {
      const res = await newapiApi.syncKeys()
      setKeys(res.keys)
      toast.success(
        res.added > 0 ? `已同步 ${res.added} 个 Key` : "没有新的 Key"
      )
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "同步失败")
    } finally {
      setSyncing(false)
    }
  }

  if (locked) {
    return (
      <FeatureLockedNotice
        feature="ai"
        featureLabel="AI 中转站"
        description="你的账号未被授予「AI 中转站」权限。站长资源有限，该服务暂未全量开放。"
      />
    )
  }

  if (loading) {
    return (
      <div>
        <PageHeader title="AI 中转站" description="NewAPI 集成" />
        <LoadingBlock />
      </div>
    )
  }

  if (!status?.configured) {
    return (
      <div>
        <PageHeader title="AI 中转站" description="NewAPI 集成" />
        <EmptyState
          title="AI 中转站尚未配置"
          description="管理员还未配置 NewAPI 凭据，请稍后再试。"
        />
      </div>
    )
  }

  if (!status.featureEnabled) {
    return (
      <div>
        <PageHeader title="AI 中转站" description="NewAPI 集成" />
        <EmptyState
          title="功能已关闭"
          description="管理员暂时关闭了 AI 中转站功能。"
        />
      </div>
    )
  }

  // 未开通
  if (!status.account) {
    return (
      <div>
        <PageHeader title="AI 中转站" description="统一的大模型 API 入口" />
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-muted-foreground" />
              开通 AI 中转站
            </CardTitle>
            <CardDescription>
              将为你创建 NewAPI 账号（{status.eligibleEmail}），附赠试用额度
              {status.currencySymbol}
              {status.trialQuotaUsd}。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-1.5 text-sm text-muted-foreground">
              <li>· 账号邮箱固定为 {status.eligibleEmail}（仅限本站邮箱）</li>
              <li>· 密码由你自己设置，本站不会保存你的密码</li>
              <li>· 开通后可查看可用模型并自助创建 API Key</li>
              <li>· 开通时需等待一封验证码邮件，通常几秒内到达</li>
            </ul>
            <Button onClick={() => void openBind()}>
              <Sparkles className="h-4 w-4" />
              立即开通
            </Button>
          </CardContent>
        </Card>

        <BindDialog
          open={bindOpen}
          onOpenChange={(o) => {
            setBindOpen(o)
            if (!o) {
              setPreflight(null)
              setPassword("")
              setConfirm("")
            }
          }}
          preflight={preflight}
          preflightLoading={preflightLoading}
          email={status.eligibleEmail}
          password={password}
          confirm={confirm}
          setPassword={setPassword}
          setConfirm={setConfirm}
          busy={busy}
          onConfirm={() => void handleBind()}
        />
      </div>
    )
  }

  const account = status.account

  return (
    <div>
      <PageHeader
        title="AI 中转站"
        description={`账号 ${account.username} · ${account.email}`}
      />

      <div className="space-y-6">
        {/* 额度 */}
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Wallet className="h-4 w-4 text-muted-foreground" />
                  额度
                </CardTitle>
                <CardDescription>
                  剩余 {status.currencySymbol}
                  {account.quotaUsd.toFixed(4)} · 已用 {status.currencySymbol}
                  {account.usedUsd.toFixed(4)} · 请求 {account.requestCount} 次
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleSync()}
                disabled={syncing}
              >
                {syncing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                同步
              </Button>
            </div>
          </CardHeader>
          {account.syncedAt && (
            <CardContent>
              <p className="text-xs text-muted-foreground">
                最后同步：{fmtTime(account.syncedAt)}
                {account.group ? ` · 分组 ${account.group}` : ""}
              </p>
            </CardContent>
          )}
        </Card>

        {/* API Key */}
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <KeyRound className="h-4 w-4 text-muted-foreground" />
                  API Key
                </CardTitle>
                <CardDescription>
                  用于调用 OpenAI 兼容接口，完整 Key 只在创建时显示一次。
                </CardDescription>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleSyncKeys()}
                  disabled={syncing}
                >
                  {syncing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  同步
                </Button>
                <Button size="sm" onClick={() => setKeyOpen(true)}>
                  <Plus className="h-3.5 w-3.5" />
                  新建 Key
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {keys.length === 0 ? (
              <EmptyState
                title="还没有 API Key"
                description="创建一个 Key 即可开始调用模型。"
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead>Key</TableHead>
                    <TableHead>创建时间</TableHead>
                    <TableHead className="w-24" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {keys.map((k) => (
                    <TableRow key={k.id}>
                      <TableCell className="text-sm">{k.name}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {k.maskedKey}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {fmtTime(k.createdAt)}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={() => void handleDeleteKey(k)}
                          disabled={deletingKeyId !== null}
                          title="删除"
                        >
                          {deletingKeyId === k.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* 模型列表：按分组分类 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Bot className="h-4 w-4 text-muted-foreground" />
              可用模型（{status.models.length}）
            </CardTitle>
            <CardDescription>
              按分组分类显示。点击模型名可复制；不同分组的计费与可用渠道不同。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {status.models.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无可用模型</p>
            ) : (
              status.availableGroups.map((g) => {
                const list = status.groupModels[g] ?? []
                if (list.length === 0) return null
                return (
                  <div key={g} className="space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{g} 分组</span>
                      <Badge variant="secondary" className="text-xs">
                        {list.length} 个模型
                      </Badge>
                      {status.accountGroup === g && (
                        <Badge variant="success" className="text-xs">
                          当前账号
                        </Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {list.map((m) => (
                        <Badge
                          key={`${g}-${m}`}
                          variant="outline"
                          className="cursor-pointer font-mono text-xs"
                          onClick={() => void copyText(m, `已复制模型名 ${m}`)}
                        >
                          {m}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )
              })
            )}
          </CardContent>
        </Card>

        {/* 额度兑换 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Gift className="h-4 w-4 text-muted-foreground" />
              兑换码充值
            </CardTitle>
            <CardDescription>
              输入兑换码（邀请码）为你的中转站额度充值。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              <Input
                placeholder="输入兑换码"
                value={redeemCode}
                onChange={(e) => setRedeemCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleRedeem()
                }}
              />
              <Button
                onClick={() => void handleRedeem()}
                disabled={redeemBusy || !redeemCode.trim()}
              >
                {redeemBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                兑换
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* 使用方式：baseURL 显眼 + 跳转中转站 */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-muted-foreground" />
              接入信息
            </CardTitle>
            <CardDescription>
              在任意 OpenAI 兼容客户端中填入以下两项即可使用。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Base URL</Label>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value="https://api.doulor.cn/v1"
                  className="font-mono text-sm"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() =>
                    void copyText("https://api.doulor.cn/v1", "Base URL 已复制")
                  }
                  title="复制"
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label>API Key</Label>
              <p className="text-xs text-muted-foreground">
                填上面创建的 Key（完整值只在创建时显示一次）
              </p>
            </div>
            <Separator />
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" asChild>
                <a
                  href="https://api.doulor.cn"
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  前往中转站本站
                </a>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAiPwOpen(true)}
              >
                <KeyRound className="h-3.5 w-3.5" />
                修改中转站密码
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              充值、渠道、日志等复杂操作请前往中转站本站完成。
            </p>
          </CardContent>
        </Card>
      </div>

      {/* 新建 Key */}
      <Dialog
        open={keyOpen}
        onOpenChange={(open) => {
          setKeyOpen(open)
          if (!open) setCreatedKey(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建 API Key</DialogTitle>
            <DialogDescription>
              {createdKey
                ? "请立即复制保存，关闭后无法再次查看完整 Key。"
                : "给这个 Key 起个名字，便于日后分辨用途。"}
            </DialogDescription>
          </DialogHeader>

          {createdKey ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Input readOnly value={createdKey} className="font-mono text-xs" />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => void copyText(createdKey, "API Key 已复制")}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
                完整 Key 仅此一次显示，服务端不保存，请务必现在复制。
              </div>
            </div>
          ) : (
            <>
            <div className="space-y-2">
              <Label htmlFor="keyName">名称</Label>
              <Input
                id="keyName"
                placeholder="例如 chatbox、my-script"
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
              />
            </div>
            {status.availableGroups.length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="keyGroup">分组</Label>
                <Select value={keyGroup} onValueChange={setKeyGroup}>
                  <SelectTrigger id="keyGroup">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {status.availableGroups.map((g) => (
                      <SelectItem key={g} value={g}>
                        {g}
                        {g === "default" ? "（默认）" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  分组决定该 Key 可用的模型与计费方式。
                </p>
              </div>
            )}
            </>
          )}

          <DialogFooter>
            {createdKey ? (
              <Button onClick={() => setKeyOpen(false)}>完成</Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => setKeyOpen(false)}>
                  取消
                </Button>
                <Button onClick={() => void handleCreateKey()} disabled={busy}>
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  创建
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 修改中转站密码 */}
      <Dialog
        open={aiPwOpen}
        onOpenChange={(open) => {
          setAiPwOpen(open)
          if (!open) setAiPw({ current: "", next: "", confirm: "" })
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>修改中转站密码</DialogTitle>
            <DialogDescription>
              需要当前密码验证；修改后不影响已创建的 API Key。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="aiPwCurrent">当前密码</Label>
              <Input
                id="aiPwCurrent"
                type="password"
                autoComplete="current-password"
                value={aiPw.current}
                onChange={(e) =>
                  setAiPw((f) => ({ ...f, current: e.target.value }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="aiPwNext">新密码</Label>
              <Input
                id="aiPwNext"
                type="password"
                autoComplete="new-password"
                value={aiPw.next}
                onChange={(e) => setAiPw((f) => ({ ...f, next: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">至少 8 位</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="aiPwConfirm">确认新密码</Label>
              <Input
                id="aiPwConfirm"
                type="password"
                autoComplete="new-password"
                value={aiPw.confirm}
                onChange={(e) =>
                  setAiPw((f) => ({ ...f, confirm: e.target.value }))
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAiPwOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => void handleAiPassword()}
              disabled={
                aiPwBusy ||
                !aiPw.current ||
                aiPw.next.length < 8 ||
                aiPw.next !== aiPw.confirm
              }
            >
              {aiPwBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              确认修改
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

interface BindDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  preflight: NewApiPreflight | null
  preflightLoading: boolean
  email: string
  password: string
  confirm: string
  setPassword: (v: string) => void
  setConfirm: (v: string) => void
  busy: boolean
  onConfirm: () => void
}

function BindDialog({
  open,
  onOpenChange,
  preflight,
  preflightLoading,
  email,
  password,
  confirm,
  setPassword,
  setConfirm,
  busy,
  onConfirm,
}: BindDialogProps) {
  const exists = Boolean(preflight?.exists)
  // 探测尚未返回时不渲染表单，避免用户先填了再被告知流程不同
  const ready = !preflightLoading && preflight !== null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {exists ? "绑定已有中转站账号" : "开通 AI 中转站"}
          </DialogTitle>
          <DialogDescription>
            {!ready
              ? "正在检查中转站账号…"
              : exists
                ? `中转站已存在账号「${preflight?.username}」，验证密码后即可绑定。`
                : `将创建 NewAPI 账号 ${email}，请设置一个密码。`}
          </DialogDescription>
        </DialogHeader>

        {!ready ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在检查…
          </div>
        ) : (
          <div className="space-y-4">
            {exists ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="aiPassword">中转站账号密码</Label>
                  <Input
                    id="aiPassword"
                    type="password"
                    autoComplete="current-password"
                    placeholder="输入该账号在中转站的密码"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
                <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                  该账号是你在中转站已有的账号，本站只保存访问令牌（不保存密码），
                  用于代你管理 API Key。邮箱与额度保持中转站现状，不再发放试用额度。
                </div>
              </>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="aiPassword">设置密码</Label>
                  <Input
                    id="aiPassword"
                    type="password"
                    autoComplete="new-password"
                    placeholder="至少 8 位"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="aiConfirm">确认密码</Label>
                  <Input
                    id="aiConfirm"
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                </div>
                {!preflight?.hasMailbox ? (
                  <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <div>
                      需要先创建 <code>{email}</code> 收件箱才能开通
                      （用于接收注册验证码）。请到「邮箱」页添加主邮箱。
                    </div>
                  </div>
                ) : (
                  <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                    开通需要接收一封验证码邮件到 {email}，本站会自动读取并完成验证，
                    通常几秒内完成，请保持页面打开。
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            onClick={onConfirm}
            disabled={
              busy ||
              !ready ||
              password.length < 8 ||
              // 仅新账号流程需要两次输入一致
              (!exists && password !== confirm) ||
              // 新账号流程要求收件箱存在，否则后端必然报错
              (!exists && preflight?.hasMailbox === false)
            }
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {busy ? "处理中…" : exists ? "验证并绑定" : "开通"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}