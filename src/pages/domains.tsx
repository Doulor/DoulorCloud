import * as React from "react"
import { ChevronDown, CornerDownRight, Globe, Loader2, Pencil, Plus, RefreshCw, ScrollText, Trash2 } from "lucide-react"
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
import { useT } from "@/i18n"
import { useAuth } from "@/hooks/use-auth"
import type { DnsRecord, DnsRecordType, RootDomainOption, Subdomain } from "@/types"

const RECORD_TYPES: DnsRecordType[] = ["A", "AAAA", "CNAME", "TXT", "MX", "SRV"]

/** SRV 的协议选项。RFC 2782 里这两个是实际会被用到的（其余少见，不列以免误导） */
const SRV_PROTOS = ["tcp", "udp"]

function StatusBadge({ status }: { status: DnsRecord["status"] }) {
  if (status === "active") return <Badge variant="success">active</Badge>
  if (status === "pending") return <Badge variant="secondary">pending</Badge>
  return <Badge variant="destructive">error</Badge>
}

export default function DomainsPage() {
  const { t } = useT()
  const { user } = useAuth()
  /**
   * 展示用的根域（xxx.<根域>，含主域名 '@' = username.<根域>）。
   * **由后端下发**（列表接口的 rootDomains，已按当前用户权限筛过），不再写死：
   * 2026-10-02 用户域从 doulor.cn 整体迁到 tyu.me 后，写死会让整页显示错域名。
   */
  const [rootDomain, setRootDomain] = React.useState("")
  /**
   * 可选的根域（后端按权限筛过：没解锁 `doulor` 权限就拿不到 doulor.cn）。
   * 只有多于一个时才渲染选择器 —— 绝大多数用户只有一个域，多一个下拉框只是噪音。
   */
  const [rootOptions, setRootOptions] = React.useState<RootDomainOption[]>([])
  /** 本次创建要用的根域（一级子域名才可选；二级由父级决定） */
  const [createRoot, setCreateRoot] = React.useState("")
  const ownDomain = `${user?.namespace}.${rootDomain}`

  const [subdomains, setSubdomains] = React.useState<Subdomain[]>([])
  const [selected, setSelected] = React.useState<Subdomain | null>(null)
  const [records, setRecords] = React.useState<DnsRecord[]>([])
  const [loading, setLoading] = React.useState(true)
  // 配额由服务端下发（用户级覆盖 > 全局设置 > 默认 5）
  const [quota, setQuota] = React.useState(5)
  const [childQuota, setChildQuota] = React.useState(5)
  const [minNameLen, setMinNameLen] = React.useState(3)
  const [saving, setSaving] = React.useState(false)
  const [deletingId, setDeletingId] = React.useState<string | null>(null)
  /**
   * 正在编辑的记录 id（null = 新建）。
   *
   * 新建与编辑共用同一个弹窗：非 null 时提交走 `dnsApi.update`。
   * 编辑时**不允许改记录名与类型** —— 改类型等于换一条记录，
   * 容易把 SRV 的 service/proto 弄丢，也让「改了什么」变得难以追溯。
   */
  const [editingId, setEditingId] = React.useState<string | null>(null)

  const [openSub, setOpenSub] = React.useState(false)
  const [openDns, setOpenDns] = React.useState(false)
  const [subName, setSubName] = React.useState("")
  // 非空表示「在该子域名之下创建子子域名」
  const [parentFor, setParentFor] = React.useState<Subdomain | null>(null)
  const [form, setForm] = React.useState({
    name: "",
    type: "A" as DnsRecordType,
    content: "",
    ttl: "1",
    proxied: false,
    priority: "",
    // SRV 专有字段。service / proto 分开填、由服务端拼成记录名
    // （`_service._proto.name`），前端不重复那套下划线与顺序规则。
    srvService: "",
    srvProto: "tcp",
    srvWeight: "0",
    srvPort: "",
    srvTarget: "",
  })

  const loadSubdomains = React.useCallback(async (keepId?: string) => {
    setLoading(true)
    try {
      const res = await domainApi.list()
      setSubdomains(res.subdomains)
      setQuota(res.limit)
      setChildQuota(res.childLimit)
      if (res.minRootNameLength) setMinNameLen(res.minRootNameLength)
      const roots = res.rootDomains ?? []
      const fallback = (roots.find((r) => r.isDefault) ?? roots[0])?.name ?? ""
      setRootDomain(fallback)
      setRootOptions(roots)
      // 只在「用户没选过 / 原选中项已不可用」时重置，避免把用户的选择冲掉
      setCreateRoot((prev) =>
        roots.some((r) => r.name === prev) ? prev : fallback
      )
      const target =
        res.subdomains.find((s) => s.id === keepId) ??
        res.subdomains.find((s) => s.name === "@") ??
        res.subdomains[0]
      setSelected(target ?? null)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("dm.err.load"))
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
      toast.error(err instanceof HttpError ? err.message : t("dm.err.loadRecords"))
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
      const res = await domainApi.create({
        name: subName,
        parentId: parentFor?.id,
        // 二级由父级的域名决定，不传；一级才带用户选的那个
        ...(parentFor ? {} : { rootDomain: createRoot || rootDomain }),
      })
      toast.success(t("dm.ok.created", { fqdn: res.subdomain.fqdn }))
      setSubName("")
      setParentFor(null)
      setOpenSub(false)
      await loadSubdomains(res.subdomain.id)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("dm.err.createFailed"))
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteSubdomain = async (sub: Subdomain) => {
    if (sub.name === "@") return
    setDeletingId(sub.id)
    try {
      await domainApi.remove(sub.id)
      toast.success(t("dm.ok.subDeleted"))
      await loadSubdomains()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("dm.err.deleteFailed"))
    } finally {
      setDeletingId(null)
    }
  }

  const resetForm = () =>
    setForm({
      name: "",
      type: "A",
      content: "",
      ttl: "1",
      proxied: false,
      priority: "",
      srvService: "",
      srvProto: "tcp",
      srvWeight: "0",
      srvPort: "",
      srvTarget: "",
    })

  /**
   * 打开「编辑」弹窗：把记录现有值填进表单。
   *
   * SRV 的记录名形如 `_sip._tcp.blog`，前两段是 service/proto（表单里是独立字段），
   * 剩下的才是「前缀」—— 拆错会把记录名改到别的名字上。
   */
  const openEditDns = (r: DnsRecord) => {
    const isSrv = r.type === "SRV"
    const labels = isSrv ? r.name.split(".") : []
    setForm({
      name: isSrv ? labels.slice(2).join(".") : r.name === "@" ? "" : r.name,
      type: r.type,
      content: isSrv ? "" : r.content,
      ttl: String(r.ttl),
      proxied: r.proxied,
      priority: r.priority != null ? String(r.priority) : "",
      srvService: isSrv ? (labels[0] ?? "").replace(/^_/, "") : "",
      srvProto: isSrv ? (labels[1] ?? "tcp").replace(/^_/, "") : "tcp",
      srvWeight: String(r.srv?.weight ?? 0),
      srvPort: r.srv?.port != null ? String(r.srv.port) : "",
      srvTarget: r.srv?.target ?? "",
    })
    setEditingId(r.id)
    setOpenDns(true)
  }

  /** 提交：editingId 为空走新建，否则走更新 */
  const handleSubmitDns = async () => {
    if (!selected) return
    // SRV 不填「内容」（由 service/proto/权重/端口/目标推导），校验分开走
    if (form.type === "SRV") {
      if (!form.srvService.trim() || !form.srvPort.trim() || !form.srvTarget.trim()) {
        toast.error(t("dm.err.srvRequired"))
        return
      }
    } else if (!form.content || (!form.name && selected.name !== "@")) {
      toast.error(t("dm.err.recordRequired"))
      return
    }
    setSaving(true)
    try {
      const payload = {
        name: selected.name === "@" ? (form.name || "@") : form.name || "@",
        type: form.type,
        content: form.content,
        ttl: form.ttl === "1" ? 1 : Number(form.ttl),
        proxied: form.proxied,
        priority: form.priority ? Number(form.priority) : undefined,
        ...(form.type === "SRV"
          ? {
              srvService: form.srvService.trim(),
              srvProto: form.srvProto,
              srvWeight: Number(form.srvWeight) || 0,
              srvPort: Number(form.srvPort),
              srvTarget: form.srvTarget.trim(),
            }
          : {}),
      }
      if (editingId) {
        await dnsApi.update(editingId, payload)
        toast.success(t("dm.ok.recordUpdated"))
      } else {
        await dnsApi.create({ subdomainId: selected.id, ...payload })
        toast.success(t("dm.ok.recordCreated"))
        bumpRecordCount(selected.id, 1)
      }
      closeDnsDialog()
      void loadRecords(selected.id)
    } catch (err) {
      toast.error(
        err instanceof HttpError
          ? err.message
          : t(editingId ? "dm.err.updateFailed" : "dm.err.createFailed")
      )
    } finally {
      setSaving(false)
    }
  }

  /** 关弹窗：表单与编辑态一起复位，避免下次打开还带着上一条记录 */
  const closeDnsDialog = () => {
    setOpenDns(false)
    setEditingId(null)
    resetForm()
  }

  /**
   * 本地调整某个域名的解析条数。
   *
   * 为什么不重新拉整个域名列表：增删一条 DNS 记录后，重拉 `loadSubdomains`
   * 会把 `loading` 置真，右侧的解析列表整块闪一下 LoadingBlock —— 为了一行
   * 数字付这个代价不值得。这里就地改数字，下一次真正加载域名列表时自然对齐。
   */
  const bumpRecordCount = (subdomainId: string, delta: number) => {
    setSubdomains((prev) =>
      prev.map((s) =>
        s.id === subdomainId
          ? { ...s, recordCount: Math.max(0, (s.recordCount ?? 0) + delta) }
          : s
      )
    )
  }

  const handleDeleteDns = async (record: DnsRecord) => {
    setDeletingId(record.id)
    try {
      await dnsApi.remove(record.id)
      toast.success(t("dm.ok.recordDeleted"))
      // 优先按记录自己的归属改数字；老数据 subdomainId 可能为空，退回当前选中项
      bumpRecordCount(record.subdomainId ?? selected?.id ?? "", -1)
      void loadRecords(selected?.id)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("dm.err.deleteFailed"))
    } finally {
      setDeletingId(null)
    }
  }

  // 一级子域名（parentId 为空，含 '@' 主域名）
  const rootSubs = subdomains.filter((s) => !s.parentId)
  const childrenOf = (id: string) => subdomains.filter((s) => s.parentId === id)
  const canAddRoot = rootSubs.length < quota
  // 选中子域名的 fqdn 即 DNS 记录的基准（例如 xxx1.doulor.cn）
  const base = selected ? selected.fqdn : ownDomain

  return (
    <div>
      <PageHeader
        title={t("dm.title")}
        description={ownDomain}
      />

      {/* 子域名列表 */}
      <div className="mb-6 rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="text-sm font-medium">
            {t("dm.myDomains")}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {quota >= 999999
                ? t("dm.quota.admin", { n: rootSubs.length })
                : t("dm.quota.user", { n: rootSubs.length, quota })}
            </span>
          </div>
          <Button
            size="sm"
            onClick={() => {
              setParentFor(null)
              setSubName("")
              setOpenSub(true)
            }}
            disabled={!canAddRoot}
          >
            <Plus className="h-4 w-4" />
            {t("common.add")}
          </Button>
        </div>
        <div className="space-y-3 p-3">
          {loading && subdomains.length === 0 ? (
            <LoadingBlock />
          ) : subdomains.length === 0 ? (
            <p className="px-2 py-6 text-sm text-muted-foreground">{t("dm.empty")}</p>
          ) : (
            rootSubs.map((sub) => {
              const children = childrenOf(sub.id)
              const canAddChild = children.length < childQuota
              return (
                <div key={sub.id} className="space-y-1.5">
                  {/* 一级。
                      整块可点选（而不是只有域名文字）：一行里能点的区域越大越好点。
                      外层用 div + onClick 而非 button —— 里面已经有删除/加子域名两个
                      真按钮，HTML 不允许按钮嵌套按钮。
                      键盘可达性靠域名文字那个 button 保住（Tab 聚焦 + Enter 触发），
                      鼠标则点整块任意位置都行。 */}
                  <div
                    onClick={() => setSelected(sub)}
                    className={`group flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 transition-colors ${
                      selected?.id === sub.id ? "bg-accent" : "hover:bg-accent/50"
                    }`}
                  >
                    <button
                      type="button"
                      className="font-mono text-sm"
                      onClick={(e) => {
                        e.stopPropagation()
                        setSelected(sub)
                      }}
                    >
                      {sub.fqdn}
                    </button>
                    {sub.name === "@" ? (
                      <Badge variant="outline">{t("dm.primary")}</Badge>
                    ) : (
                      <button
                        type="button"
                        className="hidden text-muted-foreground hover:text-destructive group-hover:block"
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleDeleteSubdomain(sub)
                        }}
                        title={t("dm.deleteTitle")}
                      >
                        {deletingId === sub.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </button>
                    )}
                    {/* 该域名下挂了几条解析。只算**直接挂的**，不含子子域名的 ——
                        列表里父子各占一行，各算各的才对得上点进去看到的那份列表 */}
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {t("dm.recordCount", { n: sub.recordCount ?? 0 })}
                    </span>
                    {/* 在一级之下加子子域名 */}
                    <button
                      type="button"
                      className="ml-auto hidden items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground group-hover:inline-flex"
                      onClick={(e) => {
                        e.stopPropagation()
                        setParentFor(sub)
                        setSubName("")
                        setOpenSub(true)
                      }}
                      disabled={!canAddChild}
                      title={
                        canAddChild
                          ? t("dm.addChildUnder", { name: sub.name })
                          : t("dm.childQuota", { n: childQuota })
                      }
                    >
                      <Plus className="h-3 w-3" />
                      {t("dm.subdomains")}
                    </button>
                  </div>

                  {/* 子子域名 */}
                  {children.map((child) => (
                    <div
                      key={child.id}
                      onClick={() => setSelected(child)}
                      className={`group ml-4 flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 transition-colors ${
                        selected?.id === child.id ? "bg-accent" : "hover:bg-accent/50"
                      }`}
                    >
                      <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <button
                        type="button"
                        className="font-mono text-sm"
                        onClick={(e) => {
                          e.stopPropagation()
                          setSelected(child)
                        }}
                      >
                        {child.fqdn}
                      </button>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {t("dm.recordCount", { n: child.recordCount ?? 0 })}
                      </span>
                      <button
                        type="button"
                        className="ml-auto hidden text-muted-foreground hover:text-destructive group-hover:block"
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleDeleteSubdomain(child)
                        }}
                        title={t("dm.deleteTitle")}
                      >
                        {deletingId === child.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* DNS 记录 */}
      {!selected ? (
        <EmptyState
          title={t("dm.selectTitle")}
          description={t("dm.selectDesc")}
        />
      ) : (
        <>
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-medium">{t("dm.recordsOf", { fqdn: selected.fqdn })}</h2>
              <span className="text-xs text-muted-foreground">
                {t("dm.recordCount", { n: records.length })}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                onClick={() => void loadRecords(selected.id)}
                aria-label={t("common.refresh")}
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  // 明确走「新建」：清掉可能残留的编辑态，否则会误改成编辑上一条
                  setEditingId(null)
                  resetForm()
                  setOpenDns(true)
                }}
              >
                <Plus className="h-4 w-4" />
                {t("dm.addRecord")}
              </Button>
            </div>
          </div>

          {records.length === 0 ? (
            <EmptyState
              title={t("dm.noRecords")}
              description={t("dm.noRecordsDesc")}
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
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span>{r.name}</span>
                          {r.managed && (
                            <Badge
                              variant="secondary"
                              className="font-sans text-[10px] font-normal"
                            >
                              {t("dm.managed.badge", {
                                module: t(
                                  r.managedBy === "storage"
                                    ? "dm.managed.storage"
                                    : "dm.managed.profile"
                                ),
                              })}
                            </Badge>
                          )}
                        </div>
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
                        {r.proxied ? t("dm.proxied") : t("dm.dnsOnly")}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={r.status} />
                      </TableCell>
                      <TableCell>
                        {/* 平台自动创建的解析不给删除入口：删了域名就解析不到本站，
                            而名片/网盘那边仍显示已绑定，用户无从自查 */}
                        {r.managed ? (
                          <span
                            className="text-xs text-muted-foreground"
                            title={t("dm.managed.hint")}
                          >
                            —
                          </span>
                        ) : (
                          <div className="flex items-center justify-end gap-0.5">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-foreground"
                              onClick={() => openEditDns(r)}
                              aria-label={t("dm.editRecord")}
                              title={t("dm.editRecord")}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
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
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {records.some((r) => r.managed) && (
                <p className="border-t px-4 py-3 text-xs text-muted-foreground">
                  {t("dm.managed.hint")}
                </p>
              )}
            </div>
          )}
        </>
      )}

      {/* 域名服务声明 / 免责条款（用户反馈 43441cdb + 9dcdbaab） */}
      <div className="mt-6 rounded-lg border bg-card">
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium">
            <span className="flex items-center gap-2">
              <ScrollText className="h-4 w-4 text-muted-foreground" />
              {t("dn.terms.title")}
            </span>
            <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
          </summary>
          <div className="space-y-3 border-t px-4 py-3 text-xs leading-relaxed text-muted-foreground">
            <p>{t("dn.terms.intro")}</p>
            <div>
              <p className="font-medium text-foreground">{t("dn.terms.forbiddenTitle")}</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                <li>{t("dn.terms.forbidden.1")}</li>
                <li>{t("dn.terms.forbidden.2")}</li>
                <li>{t("dn.terms.forbidden.3")}</li>
                <li>{t("dn.terms.forbidden.4")}</li>
                <li>{t("dn.terms.forbidden.5")}</li>
                <li>{t("dn.terms.forbidden.6")}</li>
                <li>{t("dn.terms.forbidden.7")}</li>
              </ul>
            </div>
            <div>
              <p className="font-medium text-foreground">{t("dn.terms.enforceTitle")}</p>
              <p className="mt-1">{t("dn.terms.enforce")}</p>
            </div>
            <p className="text-destructive/90">{t("dn.terms.recycle")}</p>
          </div>
        </details>
      </div>

      {/* 添加子域名 */}
      <Dialog
        open={openSub}
        onOpenChange={(o) => {
          setOpenSub(o)
          if (!o) setParentFor(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {parentFor ? t("dm.addChildUnderFull", { fqdn: parentFor.fqdn }) : t("dm.addSubdomain")}
            </DialogTitle>
            <DialogDescription>
              {parentFor
                ? t("dm.hint.child", { fqdn: parentFor.fqdn })
                : t("dm.hint.root", { domain: createRoot || rootDomain })}
            </DialogDescription>
          </DialogHeader>
          {/* 建在哪个根域下：只有「一级子域名 + 用户有多个可选域」时才需要选。
              可选域由后端按权限下发，这里的列表里出现 doulor.cn 就说明后端认了他有权限。 */}
          {!parentFor && rootOptions.length > 1 && (
            <div className="space-y-2">
              <Label htmlFor="rootDomain">{t("dm.domain")}</Label>
              <Select value={createRoot} onValueChange={setCreateRoot}>
                <SelectTrigger id="rootDomain">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {rootOptions.map((r) => (
                    <SelectItem key={r.name} value={r.name}>
                      {r.label || r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="subName">{t("dm.name")}</Label>
            <div className="flex items-center gap-1">
              <Input
                id="subName"
                placeholder={parentFor ? "profile" : "xxx"}
                value={subName}
                onChange={(e) => setSubName(e.target.value)}
                className="flex-1"
              />
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                .{parentFor ? parentFor.fqdn : createRoot || rootDomain}
              </span>
            </div>
            {/* 一级子域名有最短位数限制；二级是用户自己的细分空间，不限 */}
            {!parentFor && (
              <p className="text-xs text-muted-foreground">
                {t("dm.nameHint.root", {
                  min: minNameLen,
                  domain: createRoot || rootDomain,
                })}
              </p>
            )}
            {parentFor && (
              <p className="text-xs text-muted-foreground">
                {t("dm.nameHint.child", { fqdn: parentFor.fqdn })}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenSub(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void handleCreateSubdomain()} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("common.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 添加 DNS 记录 */}
      <Dialog
        open={openDns}
        onOpenChange={(o) => {
          // 关弹窗一律走 closeDnsDialog：顺带清掉编辑态，否则下次点「添加」
          // 会带着上一条记录进入编辑模式
          if (o) setOpenDns(true)
          else closeDnsDialog()
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(editingId ? "dm.editRecord" : "dm.addRecord")}</DialogTitle>
            <DialogDescription>
              {editingId ? t("dm.editRecordDesc", { base }) : t("dm.addRecordDesc", { base })}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {form.type !== "SRV" ? (
              <div className="space-y-2">
                <Label htmlFor="name">{t("dm.recordName")}</Label>
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
                  {t("dm.actualRecord")}
                  <span className="font-mono">
                    {(form.name || "@")}.{base}
                  </span>
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="srvService">{t("dm.srv.service")}</Label>
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    id="srvService"
                    placeholder="sip"
                    value={form.srvService}
                    onChange={(e) => setForm((f) => ({ ...f, srvService: e.target.value }))}
                  />
                  <Select
                    value={form.srvProto}
                    onValueChange={(v) => setForm((f) => ({ ...f, srvProto: v }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SRV_PROTOS.map((p) => (
                        <SelectItem key={p} value={p}>
                          {p.toUpperCase()}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {/* 服务标签之后、基准域名之前的那一段（可留空 = 直接挂在 {base} 下） */}
                <div className="flex items-center gap-1 pt-1">
                  <Input
                    id="name"
                    placeholder={t("dm.optional")}
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    className="flex-1"
                  />
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    .{base}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("dm.actualRecord")}
                  <span className="font-mono">
                    _{form.srvService.replace(/^_+/, "") || t("dm.srv.serviceFallback")}._
                    {form.srvProto}
                    {form.name ? `.${form.name}` : ""}.{base}
                  </span>
                </p>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>{t("dm.type")}</Label>
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
                    <SelectItem value="1">{t("dm.ttl.auto")}</SelectItem>
                    <SelectItem value="60">{t("dm.ttl.60")}</SelectItem>
                    <SelectItem value="300">{t("dm.ttl.300")}</SelectItem>
                    <SelectItem value="3600">{t("dm.ttl.3600")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {form.type !== "SRV" ? (
              <div className="space-y-2">
                <Label htmlFor="content">{t("dm.content")}</Label>
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
            ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="space-y-2">
                    <Label htmlFor="srvPriority">{t("dm.srv.priority")}</Label>
                    <Input
                      id="srvPriority"
                      type="number"
                      placeholder="10"
                      value={form.priority}
                      onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="srvWeight">{t("dm.srv.weight")}</Label>
                    <Input
                      id="srvWeight"
                      type="number"
                      placeholder="0"
                      value={form.srvWeight}
                      onChange={(e) => setForm((f) => ({ ...f, srvWeight: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="srvPort">{t("dm.srv.port")}</Label>
                    <Input
                      id="srvPort"
                      type="number"
                      placeholder="5060"
                      value={form.srvPort}
                      onChange={(e) => setForm((f) => ({ ...f, srvPort: e.target.value }))}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="srvTarget">{t("dm.srv.target")}</Label>
                  <Input
                    id="srvTarget"
                    placeholder="server.example.com"
                    value={form.srvTarget}
                    onChange={(e) => setForm((f) => ({ ...f, srvTarget: e.target.value }))}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("dm.srv.hint")}
                  </p>
                </div>
              </>
            )}

            {form.type === "MX" && (
              <div className="space-y-2">
                <Label htmlFor="priority">{t("dm.srv.priority")}</Label>
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
                  <p className="text-sm font-medium">{t("dm.proxiedToggle")}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("dm.proxiedToggleHint")}
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
            <Button variant="outline" onClick={closeDnsDialog}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void handleSubmitDns()} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {t(editingId ? "dm.saveEdit" : "dm.createRecord")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}