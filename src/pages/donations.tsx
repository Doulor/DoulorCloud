import * as React from "react"
import { Check, Copy, Heart, Loader2, Plus, Send, Ticket, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { LoadingBlock } from "@/components/loading-block"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
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
import { Textarea } from "@/components/ui/textarea"
import { donationApi, myInviteApi, HttpError } from "@/services/api"
import type { DonationOverview, MyInvite, MyInvitesOverview, Permissions } from "@/types"

const TYPE_META: Record<string, { label: string; desc: string }> = {
  ai: { label: "AI 中转站", desc: "贡献一个模型渠道，让其他用户也能用" },
  frp: { label: "内网穿透", desc: "提供完整可用的 config.yml" },
  proxy: { label: "代理节点", desc: "贡献你的代理订阅链接" },
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export default function DonationPage() {
  const [data, setData] = React.useState<DonationOverview | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [dialogType, setDialogType] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await donationApi.list()
      setData(res)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "加载失败")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  // 我的邀请码（额度 + 列表）
  const [invites, setInvites] = React.useState<MyInvitesOverview | null>(null)
  const [inviteOpen, setInviteOpen] = React.useState(false)
  const [inviteCode, setInviteCode] = React.useState("")
  const [inviteFeatures, setInviteFeatures] = React.useState<string[]>([])
  const [inviteBusy, setInviteBusy] = React.useState(false)
  const [copiedCode, setCopiedCode] = React.useState<string | null>(null)

  const loadInvites = React.useCallback(async () => {
    try {
      setInvites(await myInviteApi.list())
    } catch {
      // 静默：额度区加载失败不影响捐献主流程
    }
  }, [])

  React.useEffect(() => {
    void loadInvites()
  }, [loadInvites])

  const handleCreateInvite = async () => {
    setInviteBusy(true)
    try {
      await myInviteApi.create({
        code: inviteCode.trim() || undefined,
        features: inviteFeatures,
      })
      toast.success("邀请码已创建")
      setInviteOpen(false)
      setInviteCode("")
      setInviteFeatures([])
      await loadInvites()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "创建失败")
    } finally {
      setInviteBusy(false)
    }
  }

  const handleDeleteInvite = async (inv: MyInvite) => {
    try {
      const res = await myInviteApi.remove(inv.id)
      toast.success(res.refunded ? "已删除，额度已退还" : "已删除（该码已被使用，额度不退还）")
      await loadInvites()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "删除失败")
    }
  }

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code)
      setCopiedCode(code)
      setTimeout(() => setCopiedCode(null), 1500)
    } catch {
      toast.error("复制失败，请手动复制")
    }
  }

  const perms = data?.permissions
  // 全部三种资源都可捐献（已解锁的用户也能主动贡献），
  // 只是未解锁的会标注出来，方便知道贡献哪个能解锁什么。
  const allTypes = data ? Object.entries(data.typeLabels) : []

  return (
    <div>
      <PageHeader title="捐献" description="贡献资源，解锁功能权限" />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Heart className="h-4 w-4 text-muted-foreground" />
            资源有限，按需开放
          </CardTitle>
          <CardDescription>
            站长资源有限，部分功能不会全量开放。如果你愿意贡献以下资源，
            管理员审核通过后将为你解锁对应功能权限。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {allTypes.length === 0 ? (
            <p className="text-sm text-muted-foreground">加载中…</p>
          ) : (
            allTypes.map(([type, label]) => {
              const unlocked = perms?.[type as keyof Permissions] ?? false
              return (
              <div
                key={type}
                className="flex items-center justify-between rounded-md border px-4 py-3"
              >
                <div className="space-y-0.5">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {label}
                    {unlocked ? (
                      <Badge variant="success">已解锁</Badge>
                    ) : (
                      <Badge variant="secondary">未解锁</Badge>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {TYPE_META[type]?.desc}
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={() => setDialogType(type)}>
                  <Plus className="h-4 w-4" />
                  贡献
                </Button>
              </div>
              )
            })
          )}
        </CardContent>
      </Card>

      {/* 我的邀请码：额度 + 创建 + 列表 */}
      <Card className="mb-6">
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-base">
                <Ticket className="h-4 w-4 text-muted-foreground" />
                我的邀请码
              </CardTitle>
              <CardDescription>
                每人默认 {invites?.quota.inviteBase ?? 3} 个额度；
                每笔捐献获批再 +2 个额度，并获得 1 个对应模块的权限额度。
              </CardDescription>
            </div>
            <Button
              size="sm"
              onClick={() => setInviteOpen(true)}
              disabled={(invites?.quota.inviteRemaining ?? 0) < 1}
            >
              <Plus className="h-4 w-4" />
              创建
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {invites && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-md border px-4 py-3">
                  <p className="text-xs text-muted-foreground">邀请码额度</p>
                  <p className="mt-1 text-lg font-semibold">
                    {invites.quota.inviteRemaining}
                    <span className="ml-1 text-sm font-normal text-muted-foreground">
                      / {invites.quota.inviteTotal}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    基础 {invites.quota.inviteBase} + 捐献 {invites.quota.inviteBonus}
                  </p>
                </div>
                <div className="rounded-md border px-4 py-3">
                  <p className="text-xs text-muted-foreground">模块权限额度（可转授）</p>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                    {invites.quotaFeatures.map((f) => {
                      const isBasic = invites.basicFeatures?.includes(f) ?? false
                      const remain =
                        invites.quota.featureRemaining[
                          f as keyof typeof invites.quota.featureRemaining
                        ]
                      return (
                        <span key={f} className="text-sm">
                          {invites.featureLabels[f]}
                          {isBasic ? (
                            <Badge variant="outline" className="ml-1.5 align-middle">
                              基础
                            </Badge>
                          ) : (
                            <span
                              className={
                                'ml-1 font-semibold ' +
                                (remain > 0
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : 'text-muted-foreground')
                              }
                            >
                              {remain}
                            </span>
                          )}
                        </span>
                      )
                    })}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    基础权限模块人人可授，不消耗额度；受限模块勾选时会消耗对应额度
                  </p>
                </div>
              </div>

              {invites.invites.length === 0 ? (
                <p className="py-2 text-sm text-muted-foreground">
                  还没有创建过邀请码。
                </p>
              ) : (
                <div className="divide-y rounded-md border">
                  {invites.invites.map((inv) => {
                    const extra = invites.quotaFeatures.filter(
                      (f) => inv.permissions[f as keyof Permissions]
                    )
                    const used = inv.usedCount >= inv.maxUses
                    return (
                      <div
                        key={inv.id}
                        className="flex flex-wrap items-center gap-2 px-4 py-2.5"
                      >
                        <span className="font-mono text-sm">{inv.code}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground"
                          onClick={() => void copyCode(inv.code)}
                          title="复制"
                        >
                          {copiedCode === inv.code ? (
                            <Check className="h-3.5 w-3.5" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </Button>
                        <Badge variant="outline">域名 · 邮箱 · 名片</Badge>
                        {extra.map((f) => (
                          <Badge
                            key={f}
                            variant={
                              invites.basicFeatures?.includes(f)
                                ? "outline"
                                : "secondary"
                            }
                          >
                            {invites.featureLabels[f]}
                          </Badge>
                        ))}
                        <Badge variant={used ? 'destructive' : 'success'}>
                          {used ? '已使用' : '未使用'}
                        </Badge>
                        <span className="ml-auto text-xs text-muted-foreground">
                          {fmtTime(inv.createdAt)}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          onClick={() => void handleDeleteInvite(inv)}
                          title={used ? '删除（额度不退还）' : '删除并退还额度'}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {loading ? (
        <LoadingBlock />
      ) : (data?.donations.length ?? 0) === 0 ? (
        <EmptyState icon={Heart} title="还没有捐献记录" description="贡献资源后，记录会显示在这里。" />
      ) : (
        <div className="space-y-3">
          {data!.donations.map((d) => (
            <Card key={d.id}>
              <CardHeader className="flex flex-row items-start justify-between">
                <div className="space-y-1">
                  <CardTitle className="text-base">
                    {TYPE_META[d.type]?.label ?? d.type}
                  </CardTitle>
                  <CardDescription>{fmtTime(d.createdAt)}</CardDescription>
                </div>
                <Badge
                  variant={
                    d.status === "approved" ? "success" : d.status === "rejected" ? "destructive" : "secondary"
                  }
                >
                  {d.status === "approved" ? "已通过" : d.status === "rejected" ? "未通过" : "待审核"}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-2">
                {d.remark && <p className="text-sm text-muted-foreground">备注：{d.remark}</p>}
                {d.reviewNote && <p className="text-sm text-muted-foreground">审核回复：{d.reviewNote}</p>}
                {d.status === "pending" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-destructive"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true)
                      try {
                        await donationApi.cancel(d.id)
                        toast.success("已撤销")
                        void load()
                      } catch (err) {
                        toast.error(err instanceof HttpError ? err.message : "撤销失败")
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                    撤销申请
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {dialogType && (
        <DonationForm
          type={dialogType}
          onClose={() => setDialogType(null)}
          onSubmitted={() => {
            setDialogType(null)
            void load()
          }}
        />
      )}

      {/* 创建邀请码 */}
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>创建邀请码</DialogTitle>
            <DialogDescription>
              基础权限含域名、邮箱、个人名片，以及标记为「基础」的模块（不消耗额度）。
              勾选受限模块会消耗对应额度。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="invCode">邀请码（留空自动生成）</Label>
              <Input
                id="invCode"
                placeholder="DC-XXXX-XXXX"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                className="font-mono"
              />
            </div>
            <div className="space-y-2">
              <Label>附加模块权限</Label>
              {invites?.quotaFeatures.map((f) => {
                const isBasic = invites.basicFeatures?.includes(f) ?? false
                const remain =
                  invites.quota.featureRemaining[
                    f as keyof typeof invites.quota.featureRemaining
                  ]
                const checked = inviteFeatures.includes(f)
                // 基础权限模块无需额度，始终可勾选
                const disabled = !checked && !isBasic && remain < 1
                return (
                  <label
                    key={f}
                    className={
                      'flex items-center gap-3 rounded-md border px-4 py-2.5 ' +
                      (disabled ? 'opacity-50' : 'cursor-pointer')
                    }
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={checked}
                      disabled={disabled}
                      onChange={(e) =>
                        setInviteFeatures((prev) =>
                          e.target.checked
                            ? [...prev, f]
                            : prev.filter((x) => x !== f)
                        )
                      }
                    />
                    <span className="flex-1 text-sm">
                      {invites.featureLabels[f]}
                    </span>
                    {isBasic ? (
                      <Badge variant="outline">基础权限</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        剩余 {remain}
                      </span>
                    )}
                  </label>
                )
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              本次将消耗 1 个邀请码额度
              {inviteFeatures.length > 0 &&
                `，以及 ${
                  inviteFeatures.filter(
                    (f) => !(invites?.basicFeatures?.includes(f) ?? false)
                  ).length
                } 个受限模块额度`}
              。当前剩余 {invites?.quota.inviteRemaining ?? 0} 个邀请码额度。
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInviteOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void handleCreateInvite()} disabled={inviteBusy}>
              {inviteBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function DonationForm({
  type,
  onClose,
  onSubmitted,
}: {
  type: string
  onClose: () => void
  onSubmitted: () => void
}) {
  const meta = TYPE_META[type]
  const [busy, setBusy] = React.useState(false)
  const [remark, setRemark] = React.useState("")
  const [baseUrl, setBaseUrl] = React.useState("")
  const [apiKey, setApiKey] = React.useState("")
  const [models, setModels] = React.useState("")
  const [configYml, setConfigYml] = React.useState("")
  const [subUrls, setSubUrls] = React.useState("")

  const handleSubmit = async () => {
    setBusy(true)
    try {
      let payload: unknown
      if (type === "ai") {
        if (!baseUrl || !apiKey) {
          toast.error("请填写 Base URL 和 API Key")
          setBusy(false)
          return
        }
        payload = { baseUrl, apiKey, models: models.split(",").map((s) => s.trim()).filter(Boolean) }
      } else if (type === "frp") {
        if (!configYml.trim()) {
          toast.error("请粘贴 config.yml")
          setBusy(false)
          return
        }
        payload = { configYml: configYml.trim() }
      } else {
        const urls = subUrls.split("\n").map((s) => s.trim()).filter(Boolean)
        if (urls.length === 0) {
          toast.error("请填写至少一个订阅链接")
          setBusy(false)
          return
        }
        payload = { subUrls: urls }
      }

      await donationApi.create({ type: type as "ai" | "frp" | "proxy", payload, remark })
      toast.success("捐献申请已提交，请等待管理员审核")
      onSubmitted()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "提交失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>捐献 · {meta?.label}</DialogTitle>
          <DialogDescription>{meta?.desc}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {type === "ai" && (
            <>
              <div className="space-y-2">
                <Label>Base URL</Label>
                <Input placeholder="https://api.example.com/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>API Key</Label>
                <Input type="password" placeholder="sk-..." value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>可用模型（逗号分隔）</Label>
                <Input placeholder="gpt-4o, claude-3.5-sonnet, deepseek-chat" value={models} onChange={(e) => setModels(e.target.value)} />
              </div>
            </>
          )}
          {type === "frp" && (
            <div className="space-y-2">
              <Label>完整 config.yml</Label>
              <Textarea rows={10} placeholder="serverAddr: ..." value={configYml} onChange={(e) => setConfigYml(e.target.value)} className="font-mono text-xs" />
            </div>
          )}
          {type === "proxy" && (
            <div className="space-y-2">
              <Label>订阅链接（每行一个）</Label>
              <Textarea rows={5} placeholder="https://example.com/sub/abc" value={subUrls} onChange={(e) => setSubUrls(e.target.value)} className="font-mono text-xs" />
            </div>
          )}
          <div className="space-y-2">
            <Label>备注（可选）</Label>
            <Input placeholder="渠道来源、稳定性说明等" value={remark} onChange={(e) => setRemark(e.target.value)} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={() => void handleSubmit()} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            提交申请
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}