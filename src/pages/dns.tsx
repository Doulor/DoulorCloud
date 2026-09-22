import * as React from "react"
import { Loader2, Plus, RefreshCw, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { LoadingBlock } from "@/components/loading-block"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
import { Switch } from "@/components/ui/switch"
import { dnsApi, HttpError } from "@/services/api"
import { useAuth } from "@/hooks/use-auth"
import type { DnsRecord, DnsRecordType } from "@/types"

const RECORD_TYPES: DnsRecordType[] = ["A", "AAAA", "CNAME", "TXT", "MX"]
const MAX_RECORDS = 5

function StatusBadge({ status }: { status: DnsRecord["status"] }) {
  if (status === "active") return <Badge variant="success">active</Badge>
  if (status === "pending") return <Badge variant="secondary">pending</Badge>
  return <Badge variant="destructive">error</Badge>
}

export default function DnsPage() {
  const { user } = useAuth()
  const [records, setRecords] = React.useState<DnsRecord[]>([])
  const [loading, setLoading] = React.useState(true)
  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [deletingId, setDeletingId] = React.useState<string | null>(null)

  const [form, setForm] = React.useState({
    name: "",
    type: "A" as DnsRecordType,
    content: "",
    ttl: "1",
    proxied: false,
    priority: "",
  })

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await dnsApi.list()
      setRecords(res.records)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "加载 DNS 记录失败")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const resetForm = () =>
    setForm({ name: "", type: "A", content: "", ttl: "1", proxied: false, priority: "" })

  const handleCreate = async () => {
    if (!form.name || !form.content) {
      toast.error("请填写记录名称和内容")
      return
    }
    setSaving(true)
    try {
      await dnsApi.create({
        name: form.name,
        type: form.type,
        content: form.content,
        ttl: form.ttl === "1" ? 1 : Number(form.ttl),
        proxied: form.proxied,
        priority: form.priority ? Number(form.priority) : undefined,
      })
      toast.success("DNS 记录已创建")
      setOpen(false)
      resetForm()
      void load()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "创建失败")
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (record: DnsRecord) => {
    setDeletingId(record.id)
    try {
      await dnsApi.remove(record.id)
      toast.success("DNS 记录已删除")
      void load()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "删除失败")
    } finally {
      setDeletingId(null)
    }
  }

  const suffix = `.${user?.namespace}.doulor.cn`
  const canAdd = records.length < MAX_RECORDS

  return (
    <div>
      <PageHeader
        title="DNS"
        description={`${records.length} / ${MAX_RECORDS} 条记录`}
        actions={
          <>
            <Button variant="outline" size="icon" onClick={() => void load()} aria-label="刷新">
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button onClick={() => setOpen(true)} disabled={!canAdd}>
              <Plus className="h-4 w-4" />
              添加记录
            </Button>
          </>
        }
      />

      {loading ? (
        <LoadingBlock />
      ) : records.length === 0 ? (
        <EmptyState
          title="还没有 DNS 记录"
          description="添加一条记录，例如 blog 指向你的服务器。"
          action={
            <Button onClick={() => setOpen(true)} disabled={!canAdd}>
              <Plus className="h-4 w-4" />
              添加记录
            </Button>
          }
        />
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Content</TableHead>
                <TableHead>TTL</TableHead>
                <TableHead>Proxy</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-sm">
                    {r.fqdn || r.name}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{r.type}</Badge>
                  </TableCell>
                  <TableCell className="max-w-[240px] truncate font-mono text-xs">
                    {r.content}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.ttl === 1 ? "Auto" : r.ttl}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.proxied ? "已代理" : "仅 DNS"}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={r.status} />
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={() => void handleDelete(r)}
                      disabled={deletingId === r.id}
                    >
                      {deletingId === r.id ? (
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
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加 DNS 记录</DialogTitle>
            <DialogDescription>
              输入前缀，将自动生成完整的记录名称。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">名称</Label>
              <div className="flex items-center gap-1">
                <Input
                  id="name"
                  placeholder="blog"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  className="flex-1"
                />
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {suffix}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                实际记录：{" "}
                <span className="font-mono">
                  {form.name || "blog"}
                  {suffix}
                </span>
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>类型</Label>
                <Select
                  value={form.type}
                  onValueChange={(v) =>
                    setForm((f) => ({ ...f, type: v as DnsRecordType }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RECORD_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="ttl">TTL</Label>
                <Select
                  value={form.ttl}
                  onValueChange={(v) => setForm((f) => ({ ...f, ttl: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">自动</SelectItem>
                    <SelectItem value="60">60 秒</SelectItem>
                    <SelectItem value="300">5 分钟</SelectItem>
                    <SelectItem value="3600">1 小时</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="content">内容</Label>
              <Input
                id="content"
                placeholder={
                  form.type === "MX"
                    ? "cloud.doulor.cn"
                    : form.type === "TXT"
                      ? '"value"'
                      : "192.0.2.10"
                }
                value={form.content}
                onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
              />
            </div>

            {form.type === "MX" && (
              <div className="space-y-2">
                <Label htmlFor="priority">优先级</Label>
                <Input
                  id="priority"
                  type="number"
                  placeholder="10"
                  value={form.priority}
                  onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}
                />
              </div>
            )}

            {(form.type === "A" || form.type === "AAAA" || form.type === "CNAME") && (
              <div className="flex items-center justify-between rounded-md border px-4 py-3">
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">启用代理</p>
                  <p className="text-xs text-muted-foreground">
                    通过 Cloudflare 网络代理流量
                  </p>
                </div>
                <Switch
                  checked={form.proxied}
                  onCheckedChange={(v) => setForm((f) => ({ ...f, proxied: v }))}
                />
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void handleCreate()} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              创建记录
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
