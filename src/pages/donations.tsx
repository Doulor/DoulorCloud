import * as React from "react"
import { Heart, Loader2, Plus, Send, Trash2 } from "lucide-react"
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
import { donationApi, HttpError } from "@/services/api"
import type { DonationOverview, Permissions } from "@/types"

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

  const perms = data?.permissions
  const needsDonation = data
    ? Object.entries(data.typeLabels).filter(([_type, _label]) => {
        const idx = _type as keyof Permissions
        return !(perms?.[idx] ?? false)
      })
    : []

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
          {needsDonation.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              你已拥有全部功能权限，感谢支持。
            </p>
          ) : (
            needsDonation.map(([type, label]) => (
              <div
                key={type}
                className="flex items-center justify-between rounded-md border px-4 py-3"
              >
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">{label}</p>
                  <p className="text-xs text-muted-foreground">
                    {TYPE_META[type]?.desc}
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={() => setDialogType(type)}>
                  <Plus className="h-4 w-4" />
                  贡献
                </Button>
              </div>
            ))
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