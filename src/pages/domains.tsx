import * as React from "react"
import { Globe, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react"
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
import { dnsApi, domainApi, HttpError } from "@/services/api"
import { useAuth } from "@/hooks/use-auth"
import type { DnsRecord, DnsRecordType, Subdomain } from "@/types"

const RECORD_TYPES: DnsRecordType[] = ["A", "AAAA", "CNAME", "TXT", "MX"]
const MAX_SUBDOMAINS = 5

function StatusBadge({ status }: { status: DnsRecord["status"] }) {
  if (status === "active") return <Badge variant="success">active</Badge>
  if (status === "pending") return <Badge variant="secondary">pending</Badge>
  return <Badge variant="destructive">error</Badge>
}

export default function DomainsPage() {
  const { user } = useAuth()
  // 新模型：子域名是 doulor.cn 的直系（xxx.doulor.cn，含主域名 '@' = username.doulor.cn）
  const rootDomain = "doulor.cn"
  const ownDomain = `${user?.namespace}.${rootDomain}`

  const [subdomains, setSubdomains] = React.useState<Subdomain[]>([])
  const [selected, setSelected] = React.useState<Subdomain | null>(null)
  const [records, setRecords] = React.useState<DnsRecord[]>([])
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [deletingId, setDeletingId] = React.useState<string | null>(null)

  const [openSub, setOpenSub] = React.useState(false)
  const [openDns, setOpenDns] = React.useState(false)
  const [subName, setSubName] = React.useState("")
  const [form, setForm] = React.useState({
    name: "",
    type: "A" as DnsRecordType,
    content: "",
    ttl: "1",
    proxied: false,
    priority: "",
  })

  const loadSubdomains = React.useCallback(async (keepId?: string) => {
    setLoading(true)
    try {
      const res = await domainApi.list()
      setSubdomains(res.subdomains)
      const target =
        res.subdomains.find((s) => s.id === keepId) ??
        res.subdomains.find((s) => s.name === "@") ??
        res.subdomains[0]
      setSelected(target ?? null)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "加载域名失败")
    } finally {
      setLoading(false)
    }
  }, [])

  const loadRecords = React.useCallback(async (subdomainId?: string) => {
    setLoading(true)
    try {
      const res = await dnsApi.list(subdomainId)
      setRecords(res.records)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "加载 DNS 记录失败")
      setRecords([])
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void loadSubdomains()
  }, [loadSubdomains])

  React.useEffect(() => {
    if (selected) void loadRecords(selected.id)
  }, [selected?.id, loadRecords])

  const handleCreateSubdomain = async () => {
    setSaving(true)
    try {
      const res = await domainApi.create({ name: subName })
      toast.success(`子域名已创建`)
      setSubName("")
      setOpenSub(false)
      await loadSubdomains(res.subdomain.id)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "创建失败")
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteSubdomain = async (sub: Subdomain) => {
    if (sub.name === "@") return
    setDeletingId(sub.id)
    try {
      await domainApi.remove(sub.id)
      toast.success("子域名已删除")
      await loadSubdomains()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "删除失败")
    } finally {
      setDeletingId(null)
    }
  }

  const resetForm = () =>
    setForm({ name: "", type: "A", content: "", ttl: "1", proxied: false, priority: "" })

  const handleCreateDns = async () => {
    if (!selected) return
    if (!form.content || (!form.name && selected.name !== "@")) {
      toast.error("请填写记录名称和内容")
      return
    }
    setSaving(true)
    try {
      await dnsApi.create({
        subdomainId: selected.id,
        name: selected.name === "@" ? (form.name || "@") : form.name || "@",
        type: form.type,
        content: form.content,
        ttl: form.ttl === "1" ? 1 : Number(form.ttl),
        proxied: form.proxied,
        priority: form.priority ? Number(form.priority) : undefined,
      })
      toast.success("DNS 记录已创建")
      setOpenDns(false)
      resetForm()
      void loadRecords(selected.id)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "创建失败")
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteDns = async (record: DnsRecord) => {
    setDeletingId(record.id)
    try {
      await dnsApi.remove(record.id)
      toast.success("DNS 记录已删除")
      void loadRecords(selected?.id)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "删除失败")
    } finally {
      setDeletingId(null)
    }
  }

  const canAddSub = subdomains.length < MAX_SUBDOMAINS
  // 选中子域名的 fqdn 即 DNS 记录的基准（例如 xxx1.doulor.cn）
  const base = selected ? selected.fqdn : ownDomain

  return (
    <div>
      <PageHeader
        title="域名"
        description={ownDomain}
      />

      {/* 子域名列表 */}
      <div className="mb-6 rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="text-sm font-medium">
            我的域名
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {subdomains.length} / {MAX_SUBDOMAINS} 个（含主域名）
            </span>
          </div>
          <Button size="sm" onClick={() => setOpenSub(true)} disabled={!canAddSub}>
            <Plus className="h-4 w-4" />
            添加
          </Button>
        </div>
        <div className="flex flex-wrap gap-2 p-3">
          {loading && subdomains.length === 0 ? (
            <LoadingBlock />
          ) : subdomains.length === 0 ? (
            <p className="px-2 py-6 text-sm text-muted-foreground">还没有域名</p>
          ) : (
            subdomains.map((sub) => (
              <div
                key={sub.id}
                className={`group flex items-center gap-2 rounded-md border px-3 py-2 transition-colors ${
                  selected?.id === sub.id ? "bg-accent" : "hover:bg-accent/50"
                }`}
              >
                <button
                  type="button"
                  className="font-mono text-sm"
                  onClick={() => setSelected(sub)}
                >
                  {sub.fqdn}
                </button>
                {sub.name === "@" ? (
                  <Badge variant="outline">主域名</Badge>
                ) : (
                  <button
                    type="button"
                    className="hidden text-muted-foreground hover:text-destructive group-hover:block"
                    onClick={() => void handleDeleteSubdomain(sub)}
                  >
                    {deletingId === sub.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* DNS 记录 */}
      {!selected ? (
        <EmptyState
          title="选择或创建一个域名"
          description="创建子域名后即可在其下添加 DNS 记录。"
        />
      ) : (
        <>
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-medium">DNS 记录 · {selected.fqdn}</h2>
              <span className="text-xs text-muted-foreground">
                {records.length} 条
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                onClick={() => void loadRecords(selected.id)}
                aria-label="刷新"
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
              <Button size="sm" onClick={() => setOpenDns(true)}>
                <Plus className="h-4 w-4" />
                添加记录
              </Button>
            </div>
          </div>

          {records.length === 0 ? (
            <EmptyState
              title="还没有 DNS 记录"
              description="为这个域名添加一条记录，指向你的服务器或服务。"
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
                        {r.name}
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
                          onClick={() => void handleDeleteDns(r)}
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
        </>
      )}

      {/* 添加子域名 */}
      <Dialog open={openSub} onOpenChange={setOpenSub}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加子域名</DialogTitle>
            <DialogDescription>
              新的子域名会直接创建在 {rootDomain} 之下。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="subName">名称</Label>
            <div className="flex items-center gap-1">
              <Input
                id="subName"
                placeholder="xxx1"
                value={subName}
                onChange={(e) => setSubName(e.target.value)}
                className="flex-1"
              />
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                .{rootDomain}
              </span>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenSub(false)}>
              取消
            </Button>
            <Button onClick={() => void handleCreateSubdomain()} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 添加 DNS 记录 */}
      <Dialog open={openDns} onOpenChange={setOpenDns}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加 DNS 记录</DialogTitle>
            <DialogDescription>
              添加到 {base} 的记录。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">名称</Label>
              <div className="flex items-center gap-1">
                <Input
                  id="name"
                  placeholder={selected?.name === "@" ? "blog" : "@"}
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  className="flex-1"
                />
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  .{base}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                实际记录：
                <span className="font-mono">
                  {(form.name || "@")}.{base}
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
            <Button variant="outline" onClick={() => setOpenDns(false)}>
              取消
            </Button>
            <Button onClick={() => void handleCreateDns()} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              创建记录
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}