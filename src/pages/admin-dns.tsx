import * as React from "react"
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  Eye,
  Globe,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  ScanSearch,
  ShieldAlert,
  Trash2,
  UserCog,
} from "lucide-react"
import { toast } from "sonner"

import { EmptyState } from "@/components/empty-state"
import { LoadingBlock } from "@/components/loading-block"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { adminDnsApi, adminSubdomainsApi, errMsg } from "@/services/api"
import { fmtDateTime } from "@/lib/format"
import { notifyAttentionChanged } from "@/lib/attention-events"
import { useT } from "@/i18n"
import type {
  AdminDnsCfDiff,
  AdminDnsFinding,
  AdminDnsFindingRow,
  AdminDnsFindingsResponse,
  AdminDnsListResponse,
  AdminDnsRecord,
  AdminSubdomain,
  AdminSubdomainListResponse,
  DnsSeverity,
} from "@/types"

/** 归属用户联想搜索的候选项（与后端 searchSubdomainOwners 对齐） */
interface OwnerOption {
  id: string
  username: string
  email: string
  status: string
}

/**
 * 管理面板 → DNS 解析。
 *
 * 为什么需要这个页面（2026-10-01）：
 *   站内 DNS 解析功能此前**没有任何审核** —— 用户建记录直接打 Cloudflare API，
 *   唯一会拒绝它的是 CF 的字段格式校验。于是平台上出现了「整段域名转发给外部
 *   站点」「用平台域名托管第三方 Pages」「指向内网地址」这类记录，而管理面板里
 *   完全看不到：只有翻到某个用户的详情，才会露出属于他的那 200 条。
 *
 * 这个页面回答三个问题：
 *   1. **现在全站有哪些解析记录？**（跨用户列表 + 归属）
 *   2. **哪些看着有问题？**（规则引擎的实时判定 + 定时扫描落库的问题单）
 *   3. **有没有绕过站内表直接写在 Cloudflare 上的记录？**（对账）
 *
 * ⚠️ 严重度是**服务端算出来的**（见 worker/src/dns-audit.ts），不是数据库字段。
 *    所以筛选要传参数给服务端，分页也不是纯粹的 SQL 分页。
 */

const SEVERITY_STYLE: Record<DnsSeverity, { badge: string; dot: string }> = {
  high: { badge: "bg-red-500/15 text-red-600 border-red-500/30", dot: "bg-red-500" },
  medium: { badge: "bg-amber-500/15 text-amber-600 border-amber-500/30", dot: "bg-amber-500" },
  low: { badge: "bg-sky-500/15 text-sky-600 border-sky-500/30", dot: "bg-sky-500" },
}

const RECORD_TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "SRV"]

/** 严重度 → 展示文案键（用 i18n key 而不是中文，方便英文站） */
function severityKey(s: DnsSeverity) {
  return s === "high" ? "dns.sev.high" : s === "medium" ? "dns.sev.medium" : "dns.sev.low"
}

/** 编辑草稿 */
interface DraftState {
  id: string
  fqdn: string
  name: string
  type: string
  content: string
  ttl: string
  proxied: boolean
  priority: string
  status: string
  hasCf: boolean
  username: string | null
}

export function DnsAdminPanel() {
  const { t } = useT()

  const [tab, setTab] = React.useState("subdomains")

  // ---- 记录列表 ----
  const [data, setData] = React.useState<AdminDnsListResponse | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [q, setQ] = React.useState("")
  const [typeFilter, setTypeFilter] = React.useState("")
  const [severityFilter, setSeverityFilter] = React.useState("")
  const [proxiedFilter, setProxiedFilter] = React.useState("")
  const [statusFilter, setStatusFilter] = React.useState("")
  const [page, setPage] = React.useState(1)

  // ---- 问题单 ----
  const [findings, setFindings] = React.useState<AdminDnsFindingsResponse | null>(null)
  const [findingsLoading, setFindingsLoading] = React.useState(false)
  const [findingStatus, setFindingStatus] = React.useState("open")
  const [findingPage, setFindingPage] = React.useState(1)

  // ---- 对话框 ----
  const [draft, setDraft] = React.useState<DraftState | null>(null)
  const [detailRecord, setDetailRecord] = React.useState<AdminDnsRecord | null>(null)
  const [deleting, setDeleting] = React.useState<AdminDnsRecord | null>(null)
  const [reviewing, setReviewing] = React.useState<AdminDnsFindingRow | null>(null)
  const [reviewNote, setReviewNote] = React.useState("")

  // ---- 子域名管理 ----
  const [subData, setSubData] = React.useState<AdminSubdomainListResponse | null>(null)
  const [subLoading, setSubLoading] = React.useState(false)
  const [subQ, setSubQ] = React.useState("")
  const [subPage, setSubPage] = React.useState(1)
  // 新建（parent 非空 = 在某域名下建子子域名，归属由父级决定）
  const [subCreate, setSubCreate] = React.useState<{ parent: AdminSubdomain | null } | null>(null)
  const [subCreateForm, setSubCreateForm] = React.useState({
    name: "",
    rootDomain: "",
  })
  // 改名 / 转移
  const [subEdit, setSubEdit] = React.useState<AdminSubdomain | null>(null)
  const [subEditForm, setSubEditForm] = React.useState({ name: "" })
  // 删除
  const [subDelete, setSubDelete] = React.useState<AdminSubdomain | null>(null)
  // 归属用户：联想搜索词 + 当前选中（编辑时预填为现归属）
  const [ownerQuery, setOwnerQuery] = React.useState("")
  const [ownerOptions, setOwnerOptions] = React.useState<OwnerOption[]>([])
  const [ownerSelected, setOwnerSelected] = React.useState<OwnerOption | null>(null)
  const [ownerSearching, setOwnerSearching] = React.useState(false)

  // ---- CF 对账 ----
  const [cfDiff, setCfDiff] = React.useState<AdminDnsCfDiff | null>(null)
  const [cfLoading, setCfLoading] = React.useState(false)

  const loadRecords = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await adminDnsApi.list({
        q: q.trim() || undefined,
        type: typeFilter || undefined,
        severity: severityFilter || undefined,
        proxied: proxiedFilter || undefined,
        status: statusFilter || undefined,
        page,
      })
      setData(res)
    } catch (err) {
      toast.error(errMsg(err, t("dns.err.load")))
    } finally {
      setLoading(false)
    }
  }, [q, typeFilter, severityFilter, proxiedFilter, statusFilter, page, t])

  const loadFindings = React.useCallback(async () => {
    setFindingsLoading(true)
    try {
      const res = await adminDnsApi.findings({ status: findingStatus, page: findingPage })
      setFindings(res)
    } catch (err) {
      toast.error(errMsg(err, t("dns.err.load")))
    } finally {
      setFindingsLoading(false)
    }
  }, [findingStatus, findingPage, t])

  const loadCfDiff = React.useCallback(async () => {
    setCfLoading(true)
    try {
      setCfDiff(await adminDnsApi.cfDiff())
    } catch (err) {
      toast.error(errMsg(err, t("dns.err.cf")))
    } finally {
      setCfLoading(false)
    }
  }, [t])

  const loadSubdomains = React.useCallback(async () => {
    setSubLoading(true)
    try {
      const res = await adminSubdomainsApi.list({ q: subQ.trim() || undefined, page: subPage })
      setSubData(res)
      // 新建对话框可能在列表数据到达之前就打开了（页面刚进、手快点「新建」）：
      // 那时根域下拉是空的，预览会显示成「名字.」这种缺后缀的样子。数据到了
      // 就补上默认根域——只在用户还没选过时补（选过的以用户为准）。
      if (res.rootDomains.length > 0) {
        setSubCreateForm((f) => (f.rootDomain ? f : { ...f, rootDomain: res.rootDomains[0].name }))
      }
    } catch (err) {
      toast.error(errMsg(err, t("dns.err.load")))
    } finally {
      setSubLoading(false)
    }
  }, [subQ, subPage, t])

  React.useEffect(() => {
    void loadRecords()
  }, [loadRecords])

  // 筛选条件变了就回到第 1 页：否则「筛完显示空白」会被当成没数据
  React.useEffect(() => {
    setPage(1)
  }, [q, typeFilter, severityFilter, proxiedFilter, statusFilter])

  React.useEffect(() => {
    setSubPage(1)
  }, [subQ])

  React.useEffect(() => {
    if (tab === "findings") void loadFindings()
    if (tab === "cf") void loadCfDiff()
    if (tab === "subdomains") void loadSubdomains()
  }, [tab, loadFindings, loadCfDiff, loadSubdomains])

  /**
   * 归属用户联想搜索（防抖 300ms）。
   *
   * 只在新建/转移对话框打开时才发请求 —— 关着的时候搜纯属浪费。
   */
  React.useEffect(() => {
    if (!subCreate && !subEdit) return
    const query = ownerQuery.trim()
    if (!query) {
      setOwnerOptions([])
      return
    }
    let alive = true
    setOwnerSearching(true)
    const timer = setTimeout(() => {
      adminSubdomainsApi
        .searchOwners(query)
        .then((res) => {
          if (alive) setOwnerOptions(res.owners)
        })
        .catch(() => {
          if (alive) setOwnerOptions([])
        })
        .finally(() => {
          if (alive) setOwnerSearching(false)
        })
    }, 300)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [ownerQuery, subCreate, subEdit])

  /** 跑一次扫描。deep = 额外做真实解析探测（慢，但能发现悬空 CNAME） */
  const runScan = async (deep: boolean) => {
    setBusy(true)
    try {
      const res = await adminDnsApi.audit(deep)
      const s = res.summary
      toast.success(
        t("dns.scanResult", {
          scanned: String(s.scanned),
          found: String(s.found),
          fresh: String(s.fresh),
        })
      )
      if (s.note) toast.message(s.note)
      await loadRecords()
      if (tab === "findings") await loadFindings()
      notifyAttentionChanged()
    } catch (err) {
      toast.error(errMsg(err, t("dns.err.scan")))
    } finally {
      setBusy(false)
    }
  }

  const openEdit = (rec: AdminDnsRecord) => {
    setDraft({
      id: rec.id,
      fqdn: rec.fqdn,
      name: rec.name,
      type: rec.type,
      content: rec.content,
      ttl: String(rec.ttl),
      proxied: rec.proxied,
      priority: rec.priority === null ? "" : String(rec.priority),
      status: rec.status,
      hasCf: rec.hasCf,
      username: rec.username,
    })
  }

  const saveDraft = async () => {
    if (!draft) return
    setBusy(true)
    try {
      const res = await adminDnsApi.update(draft.id, {
        name: draft.name,
        type: draft.type,
        content: draft.content,
        ttl: Number(draft.ttl),
        proxied: draft.proxied,
        ...(draft.type === "MX" ? { priority: Number(draft.priority || 10) } : {}),
      })
      if (res.cfError) {
        // 本地写成功但 Cloudflare 拒绝：必须显式说出来，否则「保存成功」是假的
        toast.error(t("dns.savedCfRejected", { msg: res.cfError }))
      } else {
        toast.success(t("dns.saved"))
      }
      setDraft(null)
      await loadRecords()
    } catch (err) {
      toast.error(errMsg(err, t("dns.err.save")))
    } finally {
      setBusy(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleting) return
    setBusy(true)
    try {
      const res = await adminDnsApi.remove(deleting.id)
      if (res.cfError) toast.error(t("dns.deletedCfFailed", { msg: res.cfError }))
      else toast.success(t("dns.deleted"))
      setDeleting(null)
      await loadRecords()
      notifyAttentionChanged()
    } catch (err) {
      toast.error(errMsg(err, t("dns.err.delete")))
    } finally {
      setBusy(false)
    }
  }

  const submitReview = async (status: "ignored" | "open") => {
    if (!reviewing) return
    setBusy(true)
    try {
      await adminDnsApi.reviewFinding(reviewing.id, status, reviewNote.trim() || undefined)
      toast.success(status === "ignored" ? t("dns.findingIgnored") : t("dns.findingRestored"))
      setReviewing(null)
      setReviewNote("")
      await loadFindings()
      await loadRecords()
      notifyAttentionChanged()
    } catch (err) {
      toast.error(errMsg(err, t("dns.err.review")))
    } finally {
      setBusy(false)
    }
  }

  const stats = data?.stats
  const pageCount = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1
  const findingPageCount = findings ? Math.max(1, Math.ceil(findings.total / findings.pageSize)) : 1
  const subPageCount = subData ? Math.max(1, Math.ceil(subData.total / subData.pageSize)) : 1

  /** 新建对话框打开时的默认根域（取列表里第一个，通常是默认域） */
  const openSubCreate = (parent: AdminSubdomain | null) => {
    setOwnerQuery("")
    setOwnerOptions([])
    setOwnerSelected(null)
    setSubCreateForm({
      name: "",
      rootDomain: subData?.rootDomains[0]?.name ?? "",
    })
    setSubCreate({ parent })
  }

  const submitSubCreate = async () => {
    if (!subCreate) return
    const name = subCreateForm.name.trim().toLowerCase()
    if (!name) {
      toast.error(t("dns.sub.err.nameRequired"))
      return
    }
    // 一级必须选归属用户；建子子域名时归属由父级决定（后端会校验）
    if (!subCreate.parent && !ownerSelected) {
      toast.error(t("dns.sub.err.ownerRequired"))
      return
    }
    setBusy(true)
    try {
      const res = await adminSubdomainsApi.create({
        name,
        ...(subCreate.parent
          ? { parentId: subCreate.parent.id }
          : {
              userId: ownerSelected!.id,
              ...(subCreateForm.rootDomain ? { rootDomain: subCreateForm.rootDomain } : {}),
            }),
      })
      toast.success(t("dns.sub.ok.created", { fqdn: res.subdomain.fqdn }))
      setSubCreate(null)
      await loadSubdomains()
    } catch (err) {
      toast.error(errMsg(err, t("dns.sub.err.createFailed")))
    } finally {
      setBusy(false)
    }
  }

  const openSubEdit = (sub: AdminSubdomain) => {
    setOwnerQuery("")
    setOwnerOptions([])
    setOwnerSelected({
      id: sub.owner.id,
      username: sub.owner.username,
      email: sub.owner.email,
      status: sub.owner.status,
    })
    setSubEditForm({ name: sub.name })
    setSubEdit(sub)
  }

  const submitSubEdit = async () => {
    if (!subEdit) return
    const name = subEditForm.name.trim().toLowerCase()
    setBusy(true)
    try {
      await adminSubdomainsApi.update(subEdit.id, {
        // 名字没改就不传：传相同的值会被后端拒绝（NAME_UNCHANGED）
        ...(name && name !== subEdit.name ? { name } : {}),
        ...(ownerSelected && ownerSelected.id !== subEdit.owner.id
          ? { userId: ownerSelected.id }
          : {}),
      })
      toast.success(t("dns.sub.ok.updated"))
      setSubEdit(null)
      await loadSubdomains()
    } catch (err) {
      toast.error(errMsg(err, t("dns.sub.err.updateFailed")))
    } finally {
      setBusy(false)
    }
  }

  const submitSubDelete = async () => {
    if (!subDelete) return
    setBusy(true)
    try {
      await adminSubdomainsApi.remove(subDelete.id)
      toast.success(t("dns.sub.ok.deleted"))
      setSubDelete(null)
      await loadSubdomains()
    } catch (err) {
      toast.error(errMsg(err, t("dns.sub.err.deleteFailed")))
    } finally {
      setBusy(false)
    }
  }

  /** 归属用户选择器（新建一级 / 转移共用） */
  const renderOwnerPicker = () => (
    <div className="space-y-1.5">
      <Label htmlFor="sub-owner">{t("dns.sub.owner")}</Label>
      <Input
        id="sub-owner"
        value={ownerQuery}
        onChange={(e) => setOwnerQuery(e.target.value)}
        placeholder={t("dns.sub.ownerSearch")}
      />
      {ownerSelected && (
        <p className="flex flex-wrap items-center gap-1.5 text-xs">
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
          <span className="font-medium">{ownerSelected.username}</span>
          <span className="text-muted-foreground">{ownerSelected.email}</span>
          <button
            type="button"
            className="text-muted-foreground underline"
            onClick={() => setOwnerSelected(null)}
          >
            {t("dns.sub.ownerClear")}
          </button>
        </p>
      )}
      <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-1">
        {ownerSearching ? (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">
            <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
            {t("dns.sub.ownerSearching")}
          </p>
        ) : ownerOptions.length === 0 ? (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">
            {ownerQuery.trim() ? t("dns.sub.ownerNoResult") : t("dns.sub.ownerHint")}
          </p>
        ) : (
          ownerOptions.map((o) => (
            <button
              key={o.id}
              type="button"
              className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs hover:bg-muted ${
                o.id === ownerSelected?.id ? "bg-muted" : ""
              }`}
              onClick={() => setOwnerSelected(o)}
            >
              <span className="font-medium">{o.username}</span>
              <span className="text-muted-foreground">{o.email}</span>
            </button>
          ))
        )}
      </div>
    </div>
  )

  return (
    <div className="space-y-6">
      {/* ---- 顶部：扫描入口与上次结果 ---- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Globe className="h-4 w-4" />
            {t("dns.title")}
          </CardTitle>
          <CardDescription>{t("dns.desc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void runScan(false)}>
              {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <ScanSearch className="mr-1.5 h-4 w-4" />}
              {t("dns.scan")}
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void runScan(true)}>
                  <ShieldAlert className="mr-1.5 h-4 w-4" />
                  {t("dns.scanDeep")}
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-xs">{t("dns.scanDeepHint")}</TooltipContent>
            </Tooltip>
            <Button size="sm" variant="ghost" disabled={loading} onClick={() => void loadRecords()}>
              <RefreshCw className={`mr-1.5 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              {t("common.refresh")}
            </Button>
            {data?.lastRun ? (
              <span className="text-xs text-muted-foreground">
                {t("dns.lastRun", {
                  time: fmtDateTime(data.lastRun.ranAt),
                  mode: data.lastRun.mode === "manual" ? t("dns.modeManual") : t("dns.modeHourly"),
                })}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">{t("dns.neverScanned")}</span>
            )}
          </div>

          {stats && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <StatBox label={t("dns.sev.high")} value={stats.high} tone="high" />
              <StatBox label={t("dns.sev.medium")} value={stats.medium} tone="medium" />
              <StatBox label={t("dns.sev.low")} value={stats.low} tone="low" />
              <StatBox label={t("dns.stat.clean")} value={stats.clean} tone="clean" />
              <StatBox label={t("dns.stat.open")} value={stats.openFindings} tone="open" />
            </div>
          )}

          {data?.truncated && (
            <p className="text-xs text-amber-600">{t("dns.truncated", { n: String(stats?.scanned ?? 0) })}</p>
          )}
          {data?.lastRun?.note && (
            <p className="text-xs text-muted-foreground">{data.lastRun.note}</p>
          )}
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="subdomains">{t("dns.tab.subdomains")}</TabsTrigger>
          <TabsTrigger value="records">{t("dns.tab.records")}</TabsTrigger>
          <TabsTrigger value="findings">
            {t("dns.tab.findings")}
            {/* 用列表接口就带的 openFindings，而不是 findings 接口的计数 ——
                后者只在切到该页签后才加载，角标会晚一拍才出现 */}
            {data?.stats.openFindings ? ` (${data.stats.openFindings})` : ""}
          </TabsTrigger>
          <TabsTrigger value="cf">{t("dns.tab.cf")}</TabsTrigger>
        </TabsList>

        {/* ================= 子域名管理 ================= */}
        <TabsContent value="subdomains" className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={subQ}
              onChange={(e) => setSubQ(e.target.value)}
              placeholder={t("dns.sub.search")}
              className="h-8 w-64"
            />
            <Button size="sm" onClick={() => openSubCreate(null)}>
              <Plus className="mr-1.5 h-4 w-4" />
              {t("dns.sub.new")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={subLoading}
              onClick={() => void loadSubdomains()}
            >
              <RefreshCw className={`mr-1.5 h-4 w-4 ${subLoading ? "animate-spin" : ""}`} />
              {t("common.refresh")}
            </Button>
            {subData && (
              <span className="text-xs text-muted-foreground">
                {t("dns.sub.total", { n: String(subData.total) })}
              </span>
            )}
          </div>

          {subLoading && !subData ? (
            <LoadingBlock />
          ) : !subData || subData.subdomains.length === 0 ? (
            <EmptyState
              title={t("dns.sub.empty.title")}
              description={t("dns.sub.empty.desc")}
            />
          ) : (
            <div className="rounded-lg border bg-card">
              <Table wrapperClassName="overflow-x-auto">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("dns.sub.col.fqdn")}</TableHead>
                    <TableHead>{t("dns.sub.col.owner")}</TableHead>
                    <TableHead className="w-28">{t("dns.sub.col.parent")}</TableHead>
                    <TableHead className="w-20 text-right">{t("dns.sub.col.records")}</TableHead>
                    <TableHead className="w-36">{t("dns.sub.col.created")}</TableHead>
                    <TableHead className="w-44 text-right">{t("dns.col.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {subData.subdomains.map((sub) => (
                    <TableRow key={sub.id}>
                      <TableCell className="align-top">
                        <div className="font-mono text-xs break-all">{sub.fqdn}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          {sub.name === "@" && (
                            <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                              {t("dns.sub.primary")}
                            </Badge>
                          )}
                          {sub.owner.status !== "active" && (
                            <Badge
                              variant="outline"
                              className="h-5 border-destructive/40 px-1.5 text-[10px] text-destructive"
                            >
                              {sub.owner.status}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="align-top text-xs">
                        <div className="font-medium">{sub.owner.username}</div>
                        <div className="text-muted-foreground">{sub.owner.email}</div>
                      </TableCell>
                      <TableCell className="align-top font-mono text-xs break-all">
                        {sub.parentFqdn ?? <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="align-top text-right tabular-nums">
                        {sub.recordCount}
                      </TableCell>
                      <TableCell className="align-top text-xs text-muted-foreground">
                        {fmtDateTime(sub.createdAt)}
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs"
                            onClick={() => openSubEdit(sub)}
                          >
                            <UserCog className="mr-1 h-3.5 w-3.5" />
                            {t("dns.sub.editBtn")}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs"
                            onClick={() => openSubCreate(sub)}
                          >
                            <Plus className="mr-1 h-3.5 w-3.5" />
                            {t("dns.sub.child")}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs text-destructive"
                            disabled={sub.name === "@"}
                            title={sub.name === "@" ? t("dns.sub.primaryNoDelete") : undefined}
                            onClick={() => setSubDelete(sub)}
                          >
                            <Trash2 className="mr-1 h-3.5 w-3.5" />
                            {t("common.delete")}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {subData && subData.total > subData.pageSize && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {t("dns.pageInfo", {
                  total: String(subData.total),
                  page: String(subData.page),
                  pages: String(subPageCount),
                })}
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={subPage <= 1}
                  onClick={() => setSubPage((p) => p - 1)}
                >
                  {t("common.back")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={subPage >= subPageCount}
                  onClick={() => setSubPage((p) => p + 1)}
                >
                  {t("common.next")}
                </Button>
              </div>
            </div>
          )}
        </TabsContent>

        {/* ================= 记录列表 ================= */}
        <TabsContent value="records" className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("dns.filter.search")}
              className="h-8 w-56"
            />
            <Select value={typeFilter || "ALL"} onValueChange={(v) => setTypeFilter(v === "ALL" ? "" : v)}>
              <SelectTrigger className="h-8 w-28">
                <SelectValue placeholder={t("dns.filter.type")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t("common.all")}</SelectItem>
                {RECORD_TYPES.map((ty) => (
                  <SelectItem key={ty} value={ty}>
                    {ty}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={severityFilter || "ALL"}
              onValueChange={(v) => setSeverityFilter(v === "ALL" ? "" : v)}
            >
              <SelectTrigger className="h-8 w-32">
                <SelectValue placeholder={t("dns.filter.severity")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t("common.all")}</SelectItem>
                <SelectItem value="any">{t("dns.filter.risky")}</SelectItem>
                <SelectItem value="high">{t("dns.sev.high")}</SelectItem>
                <SelectItem value="medium">{t("dns.sev.medium")}</SelectItem>
                <SelectItem value="low">{t("dns.sev.low")}</SelectItem>
                <SelectItem value="none">{t("dns.filter.clean")}</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={proxiedFilter || "ALL"}
              onValueChange={(v) => setProxiedFilter(v === "ALL" ? "" : v)}
            >
              <SelectTrigger className="h-8 w-28">
                <SelectValue placeholder={t("dns.col.proxy")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t("common.all")}</SelectItem>
                <SelectItem value="1">{t("dns.proxy.on")}</SelectItem>
                <SelectItem value="0">{t("dns.proxy.off")}</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={statusFilter || "ALL"}
              onValueChange={(v) => setStatusFilter(v === "ALL" ? "" : v)}
            >
              <SelectTrigger className="h-8 w-28">
                <SelectValue placeholder={t("dns.col.status")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t("common.all")}</SelectItem>
                <SelectItem value="active">active</SelectItem>
                <SelectItem value="pending">pending</SelectItem>
                <SelectItem value="error">error</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {loading && !data ? (
            <LoadingBlock />
          ) : !data || data.records.length === 0 ? (
            <EmptyState title={t("dns.empty.records.title")} description={t("dns.empty.records.desc")} />
          ) : (
            <div className="rounded-lg border bg-card">
              <Table wrapperClassName="overflow-x-auto">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("dns.col.record")}</TableHead>
                    <TableHead className="w-16">{t("dns.col.type")}</TableHead>
                    <TableHead>{t("dns.col.content")}</TableHead>
                    <TableHead className="w-28">{t("dns.col.owner")}</TableHead>
                    <TableHead className="w-28">{t("dns.col.risk")}</TableHead>
                    <TableHead className="w-24 text-right">{t("dns.col.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.records.map((rec) => (
                    <TableRow key={rec.id}>
                      <TableCell className="align-top">
                        <div className="font-mono text-xs break-all">{rec.fqdn}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          {rec.proxied && (
                            <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                              <Cloud className="mr-0.5 h-3 w-3" />
                              {t("dns.proxy.on")}
                            </Badge>
                          )}
                          {rec.status !== "active" && (
                            <Badge variant="outline" className="h-5 border-destructive/40 px-1.5 text-[10px] text-destructive">
                              {rec.status}
                            </Badge>
                          )}
                          {!rec.hasCf && (
                            <Badge variant="outline" className="h-5 border-destructive/40 px-1.5 text-[10px] text-destructive">
                              {t("dns.noCfId")}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="align-top font-mono text-xs">{rec.type}</TableCell>
                      <TableCell className="align-top font-mono text-xs break-all">{rec.content}</TableCell>
                      <TableCell className="align-top text-xs">
                        {rec.username ? (
                          <span className={rec.userStatus === "banned" ? "text-destructive" : ""}>
                            {rec.username}
                            {rec.uid ? <span className="text-muted-foreground"> #{rec.uid}</span> : null}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="align-top">
                        {rec.topSeverity ? (
                          <button
                            type="button"
                            onClick={() => setDetailRecord(rec)}
                            className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] ${SEVERITY_STYLE[rec.topSeverity].badge}`}
                          >
                            <span className={`h-1.5 w-1.5 rounded-full ${SEVERITY_STYLE[rec.topSeverity].dot}`} />
                            {t(severityKey(rec.topSeverity))}
                            <span className="opacity-70">{rec.risks.filter((r) => !r.ignored).length}</span>
                          </button>
                        ) : rec.risks.length > 0 ? (
                          <button
                            type="button"
                            onClick={() => setDetailRecord(rec)}
                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] text-muted-foreground"
                          >
                            <CheckCircle2 className="h-3 w-3" />
                            {t("dns.allIgnored")}
                          </button>
                        ) : (
                          <span className="text-[11px] text-muted-foreground">{t("dns.clean")}</span>
                        )}
                      </TableCell>
                      <TableCell className="align-top text-right">
                        <div className="flex justify-end gap-1">
                          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openEdit(rec)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-destructive"
                            onClick={() => setDeleting(rec)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {data && data.total > data.pageSize && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {t("dns.pageInfo", { total: String(data.total), page: String(data.page), pages: String(pageCount) })}
              </span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  {t("common.back")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page >= pageCount}
                  onClick={() => setPage((p) => p + 1)}
                >
                  {t("common.next")}
                </Button>
              </div>
            </div>
          )}
        </TabsContent>

        {/* ================= 待处理问题 ================= */}
        <TabsContent value="findings" className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={findingStatus}
              onValueChange={(v) => {
                setFindingStatus(v)
                setFindingPage(1)
              }}
            >
              <SelectTrigger className="h-8 w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">{t("dns.findingStatus.open")}</SelectItem>
                <SelectItem value="ignored">{t("dns.findingStatus.ignored")}</SelectItem>
                <SelectItem value="resolved">{t("dns.findingStatus.resolved")}</SelectItem>
                <SelectItem value="all">{t("common.all")}</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" variant="ghost" disabled={findingsLoading} onClick={() => void loadFindings()}>
              <RefreshCw className={`mr-1.5 h-4 w-4 ${findingsLoading ? "animate-spin" : ""}`} />
              {t("common.refresh")}
            </Button>
            {findings?.counts && (
              <span className="text-xs text-muted-foreground">
                {t("dns.findingCounts", {
                  open: String(findings.counts.open),
                  ignored: String(findings.counts.ignored),
                  resolved: String(findings.counts.resolved),
                })}
              </span>
            )}
          </div>

          {findings && !findings.tableReady ? (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
              <p className="flex items-center gap-2 font-medium text-amber-600">
                <AlertTriangle className="h-4 w-4" />
                {t("dns.tableMissing")}
              </p>
              <p className="mt-2 font-mono text-xs text-muted-foreground">
                npx wrangler d1 execute doulor-mail --remote --file=./migrations/0093_dns_audit.sql
              </p>
            </div>
          ) : findingsLoading && !findings ? (
            <LoadingBlock />
          ) : !findings || findings.findings.length === 0 ? (
            <EmptyState title={t("dns.empty.findings.title")} description={t("dns.empty.findings.desc")} />
          ) : (
            <div className="space-y-2">
              {findings.findings.map((f) => (
                <div key={f.id} className="rounded-lg border bg-card p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] ${SEVERITY_STYLE[f.severity].badge}`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${SEVERITY_STYLE[f.severity].dot}`} />
                      {t(severityKey(f.severity))}
                    </span>
                    <span className="font-mono text-xs">{f.fqdn}</span>
                    <Badge variant="outline" className="h-5 px-1.5 font-mono text-[10px]">
                      {f.type}
                    </Badge>
                    <span className="font-mono text-xs text-muted-foreground break-all">{f.content}</span>
                    <Badge variant="secondary" className="h-5 px-1.5 font-mono text-[10px]">
                      {f.rule}
                    </Badge>
                    {f.username && <span className="text-xs text-muted-foreground">@{f.username}</span>}
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      {t("dns.findingLastSeen", { time: fmtDateTime(f.lastSeenAt) })}
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed">{f.detail}</p>
                  {f.reviewedBy && (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {t("dns.findingReviewed", {
                        who: f.reviewedBy,
                        time: f.reviewedAt ? fmtDateTime(f.reviewedAt) : "",
                      })}
                      {f.note ? ` · ${f.note}` : ""}
                    </p>
                  )}
                  <div className="mt-2 flex gap-2">
                    {f.status === "open" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => {
                          setReviewing(f)
                          setReviewNote("")
                        }}
                      >
                        <Eye className="mr-1 h-3.5 w-3.5" />
                        {t("dns.findingIgnore")}
                      </Button>
                    ) : f.status === "ignored" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        disabled={busy}
                        onClick={() => {
                          setReviewing(f)
                          setReviewNote("")
                        }}
                      >
                        {t("dns.findingRestore")}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}

          {findings && findings.total > findings.pageSize && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {t("dns.pageInfo", {
                  total: String(findings.total),
                  page: String(findings.page),
                  pages: String(findingPageCount),
                })}
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={findingPage <= 1}
                  onClick={() => setFindingPage((p) => p - 1)}
                >
                  {t("common.back")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={findingPage >= findingPageCount}
                  onClick={() => setFindingPage((p) => p + 1)}
                >
                  {t("common.next")}
                </Button>
              </div>
            </div>
          )}
        </TabsContent>

        {/* ================= Cloudflare 对账 ================= */}
        <TabsContent value="cf" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={cfLoading} onClick={() => void loadCfDiff()}>
              {cfLoading ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-4 w-4" />
              )}
              {t("dns.cf.check")}
            </Button>
            {cfDiff && (
              <span className="text-xs text-muted-foreground">
                {t("dns.cf.summary", {
                  cf: String(cfDiff.cfTotal),
                  db: String(cfDiff.dbTotal),
                  managed: String(cfDiff.platformManaged),
                  time: fmtDateTime(cfDiff.checkedAt),
                })}
              </span>
            )}
          </div>

          {cfLoading && !cfDiff ? (
            <LoadingBlock />
          ) : !cfDiff ? (
            <EmptyState title={t("dns.cf.empty.title")} description={t("dns.cf.empty.desc")} />
          ) : (
            <>
              <p className="text-xs text-muted-foreground">{cfDiff.note}</p>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">{t("dns.cf.onlyInCf", { n: String(cfDiff.onlyInCf.length) })}</CardTitle>
                  <CardDescription className="text-xs">{t("dns.cf.onlyInCfDesc")}</CardDescription>
                </CardHeader>
                <CardContent>
                  {cfDiff.onlyInCf.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t("dns.cf.none")}</p>
                  ) : (
                    <div className="space-y-2">
                      {cfDiff.onlyInCf.map((r) => (
                        <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                          <span className="font-mono text-xs">{r.name}</span>
                          <Badge variant="outline" className="h-5 px-1.5 font-mono text-[10px]">
                            {r.type}
                          </Badge>
                          <span className="font-mono text-xs text-muted-foreground break-all">{r.content}</span>
                          {r.proxied && (
                            <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                              {t("dns.proxy.on")}
                            </Badge>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="ml-auto h-7 text-xs text-destructive"
                            disabled={busy}
                            onClick={async () => {
                              setBusy(true)
                              try {
                                await adminDnsApi.removeOrphan(r.id)
                                toast.success(t("dns.cf.orphanDeleted"))
                                await loadCfDiff()
                              } catch (err) {
                                toast.error(errMsg(err, t("dns.err.delete")))
                              } finally {
                                setBusy(false)
                              }
                            }}
                          >
                            <Trash2 className="mr-1 h-3.5 w-3.5" />
                            {t("common.delete")}
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">{t("dns.cf.onlyInDb", { n: String(cfDiff.onlyInDb.length) })}</CardTitle>
                  <CardDescription className="text-xs">{t("dns.cf.onlyInDbDesc")}</CardDescription>
                </CardHeader>
                <CardContent>
                  {cfDiff.onlyInDb.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t("dns.cf.none")}</p>
                  ) : (
                    <div className="space-y-2">
                      {cfDiff.onlyInDb.map((r) => (
                        <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                          <span className="font-mono text-xs">{r.fqdn}</span>
                          <Badge variant="outline" className="h-5 px-1.5 font-mono text-[10px]">
                            {r.type}
                          </Badge>
                          <span className="font-mono text-xs text-muted-foreground break-all">{r.content}</span>
                          <span className="text-[11px] text-muted-foreground">{r.reason}</span>
                          {r.username && <span className="text-xs text-muted-foreground">@{r.username}</span>}
                          <Button
                            size="sm"
                            variant="outline"
                            className="ml-auto h-7 text-xs"
                            onClick={() => {
                              setTab("records")
                              setQ(r.fqdn)
                            }}
                          >
                            {t("dns.cf.gotoRecord")}
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>
      </Tabs>

      {/* ---- 风险详情 ---- */}
      <Dialog open={detailRecord !== null} onOpenChange={(o) => !o && setDetailRecord(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">{detailRecord?.fqdn}</DialogTitle>
            <DialogDescription>
              {detailRecord
                ? t("dns.detail.desc", {
                    type: detailRecord.type,
                    content: detailRecord.content,
                    owner: detailRecord.username ?? "—",
                  })
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {detailRecord?.risks.map((f: AdminDnsFinding) => (
              <div key={f.rule} className="rounded-md border p-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] ${SEVERITY_STYLE[f.severity].badge}`}
                  >
                    {t(severityKey(f.severity))}
                  </span>
                  <span className="font-mono text-[11px]">{f.rule}</span>
                  {f.ignored && (
                    <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                      {t("dns.findingStatus.ignored")}
                    </Badge>
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed">{f.detail}</p>
              </div>
            ))}
            {detailRecord && detailRecord.risks.length === 0 && (
              <p className="text-xs text-muted-foreground">{t("dns.clean")}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailRecord(null)}>
              {t("common.close")}
            </Button>
            <Button
              onClick={() => {
                if (detailRecord) openEdit(detailRecord)
                setDetailRecord(null)
              }}
            >
              <Pencil className="mr-1.5 h-4 w-4" />
              {t("common.edit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- 编辑记录 ---- */}
      <Dialog open={draft !== null} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("dns.edit.title")}</DialogTitle>
            <DialogDescription className="font-mono text-xs">
              {draft?.fqdn} · @{draft?.username ?? "—"}
            </DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="dns-type">{t("dns.col.type")}</Label>
                <Select value={draft.type} onValueChange={(v) => setDraft({ ...draft, type: v })}>
                  <SelectTrigger id="dns-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RECORD_TYPES.map((ty) => (
                      <SelectItem key={ty} value={ty}>
                        {ty}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dns-name">{t("dns.edit.name")}</Label>
                <Input
                  id="dns-name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dns-content">{t("dns.col.content")}</Label>
                <Textarea
                  id="dns-content"
                  value={draft.content}
                  onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                  className="font-mono text-xs"
                  rows={draft.type === "SRV" ? 2 : 1}
                />
                {draft.type === "SRV" && (
                  <p className="text-[11px] text-muted-foreground">{t("dns.edit.srvHint")}</p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="dns-ttl">{t("dns.col.ttl")}</Label>
                  <Input
                    id="dns-ttl"
                    value={draft.ttl}
                    onChange={(e) => setDraft({ ...draft, ttl: e.target.value })}
                    inputMode="numeric"
                  />
                  <p className="text-[11px] text-muted-foreground">{t("dns.edit.ttlHint")}</p>
                </div>
                {draft.type === "MX" && (
                  <div className="space-y-1.5">
                    <Label htmlFor="dns-priority">{t("dns.edit.priority")}</Label>
                    <Input
                      id="dns-priority"
                      value={draft.priority}
                      onChange={(e) => setDraft({ ...draft, priority: e.target.value })}
                      inputMode="numeric"
                    />
                  </div>
                )}
              </div>
              {(draft.type === "A" || draft.type === "AAAA" || draft.type === "CNAME") && (
                <div className="flex items-center justify-between rounded-md border p-2">
                  <div>
                    <Label className="text-sm">{t("dns.edit.proxied")}</Label>
                    <p className="text-[11px] text-muted-foreground">{t("dns.edit.proxiedHint")}</p>
                  </div>
                  <Switch
                    checked={draft.proxied}
                    onCheckedChange={(v) => setDraft({ ...draft, proxied: v })}
                  />
                </div>
              )}
              {!draft.hasCf && (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-600">
                  {t("dns.edit.willCreateCf")}
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>
              {t("common.cancel")}
            </Button>
            <Button disabled={busy} onClick={() => void saveDraft()}>
              {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- 删除确认 ---- */}
      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("dns.delete.title")}</DialogTitle>
            <DialogDescription>{t("dns.delete.desc")}</DialogDescription>
          </DialogHeader>
          <p className="rounded-md border bg-muted/40 p-2 font-mono text-xs">
            {deleting?.fqdn} · {deleting?.type} {deleting?.content}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void confirmDelete()}>
              {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- 处置问题（忽略 / 恢复） ---- */}
      <Dialog
        open={reviewing !== null}
        onOpenChange={(o) => {
          if (!o) {
            setReviewing(null)
            setReviewNote("")
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {reviewing?.status === "ignored" ? t("dns.findingRestore") : t("dns.findingIgnore")}
            </DialogTitle>
            <DialogDescription className="font-mono text-xs">
              {reviewing?.fqdn} · {reviewing?.rule}
            </DialogDescription>
          </DialogHeader>
          {reviewing?.status === "open" ? (
            <div className="space-y-1.5">
              <Label htmlFor="dns-note">{t("dns.findingNote")}</Label>
              <Textarea
                id="dns-note"
                value={reviewNote}
                onChange={(e) => setReviewNote(e.target.value)}
                placeholder={t("dns.findingNotePlaceholder")}
                rows={3}
              />
              <p className="text-[11px] text-muted-foreground">{t("dns.findingNoteHint")}</p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t("dns.findingRestoreHint")}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewing(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={busy || (reviewing?.status === "open" && !reviewNote.trim())}
              onClick={() => void submitReview(reviewing?.status === "open" ? "ignored" : "open")}
            >
              {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {t("common.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- 新建子域名 ---- */}
      <Dialog
        open={subCreate !== null}
        onOpenChange={(o) => {
          if (!o) setSubCreate(null)
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {subCreate?.parent ? t("dns.sub.create.childTitle") : t("dns.sub.create.title")}
            </DialogTitle>
            <DialogDescription>
              {subCreate?.parent
                ? t("dns.sub.create.childDesc", { parent: subCreate.parent.fqdn })
                : t("dns.sub.create.desc")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {subCreate?.parent ? (
              // 建子子域名：归属由父级决定，只让填名字
              <p className="rounded-md border bg-muted/40 p-2 text-xs">
                <span className="text-muted-foreground">{t("dns.sub.col.owner")}：</span>
                <span className="font-medium">{subCreate.parent.owner.username}</span>
                <span className="ml-2 text-muted-foreground">{subCreate.parent.owner.email}</span>
              </p>
            ) : (
              <>
                {renderOwnerPicker()}
                {subData && subData.rootDomains.length > 0 && (
                  <div className="space-y-1.5">
                    <Label htmlFor="sub-root">{t("dns.sub.create.root")}</Label>
                    <Select
                      value={subCreateForm.rootDomain}
                      onValueChange={(v) => setSubCreateForm({ ...subCreateForm, rootDomain: v })}
                    >
                      <SelectTrigger id="sub-root">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {subData.rootDomains.map((r) => (
                          <SelectItem key={r.name} value={r.name}>
                            {r.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="sub-name">{t("dns.sub.create.name")}</Label>
              <Input
                id="sub-name"
                value={subCreateForm.name}
                onChange={(e) => setSubCreateForm({ ...subCreateForm, name: e.target.value })}
                className="font-mono text-xs"
                placeholder="my-site"
              />
              <p className="text-[11px] text-muted-foreground">{t("dns.sub.create.nameHint")}</p>
              {subCreateForm.name.trim() && (
                <p className="font-mono text-xs">
                  {t("dns.sub.create.preview")}：
                  <span className="font-medium">
                    {subCreateForm.name.trim().toLowerCase()}.
                    {subCreate?.parent
                      ? subCreate.parent.fqdn
                      : (subData?.rootDomains.find((r) => r.name === subCreateForm.rootDomain)
                          ?.name ?? (subCreateForm.rootDomain || subData?.rootDomains[0]?.name) ?? "")}
                  </span>
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSubCreate(null)}>
              {t("common.cancel")}
            </Button>
            <Button disabled={busy} onClick={() => void submitSubCreate()}>
              {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {t("common.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- 改名 / 转移 ---- */}
      <Dialog
        open={subEdit !== null}
        onOpenChange={(o) => {
          if (!o) setSubEdit(null)
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("dns.sub.edit.title")}</DialogTitle>
            <DialogDescription className="font-mono text-xs">{subEdit?.fqdn}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="sub-edit-name">{t("dns.sub.edit.name")}</Label>
              <Input
                id="sub-edit-name"
                value={subEditForm.name}
                onChange={(e) => setSubEditForm({ ...subEditForm, name: e.target.value })}
                className="font-mono text-xs"
              />
              {subEdit && subEditForm.name.trim() && subEditForm.name.trim() !== subEdit.name && (
                <p className="font-mono text-xs">
                  {t("dns.sub.create.preview")}：
                  <span className="font-medium">
                    {subEditForm.name.trim().toLowerCase()}.
                    {subEdit.fqdn.slice(subEdit.name.length + 1)}
                  </span>
                </p>
              )}
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-600">
                {t("dns.sub.edit.renameWarn")}
              </p>
            </div>
            {renderOwnerPicker()}
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-600">
              {t("dns.sub.edit.transferWarn")}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSubEdit(null)}>
              {t("common.cancel")}
            </Button>
            <Button disabled={busy} onClick={() => void submitSubEdit()}>
              {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- 删除子域名确认 ---- */}
      <Dialog
        open={subDelete !== null}
        onOpenChange={(o) => {
          if (!o) setSubDelete(null)
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("dns.sub.delete.title")}</DialogTitle>
            <DialogDescription>{t("dns.sub.delete.desc")}</DialogDescription>
          </DialogHeader>
          <p className="rounded-md border bg-muted/40 p-2 font-mono text-xs">
            {subDelete?.fqdn}
            <span className="ml-2 text-muted-foreground">@{subDelete?.owner.username}</span>
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSubDelete(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void submitSubDelete()}>
              {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** 统计小卡片 */
function StatBox({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: "high" | "medium" | "low" | "clean" | "open"
}) {
  const cls =
    tone === "high"
      ? "border-red-500/30 bg-red-500/10 text-red-600"
      : tone === "medium"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-600"
        : tone === "low"
          ? "border-sky-500/30 bg-sky-500/10 text-sky-600"
          : tone === "clean"
            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600"
            : "border-border bg-muted/40 text-foreground"
  return (
    <div className={`rounded-lg border px-3 py-2 ${cls}`}>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] opacity-80">{label}</div>
    </div>
  )
}
