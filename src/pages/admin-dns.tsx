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
  Timer,
  Trash2,
  UserCog,
  XCircle,
} from "lucide-react"
import { toast } from "sonner"

import { EmptyState } from "@/components/empty-state"
import { LoadingBlock } from "@/components/loading-block"
import { confirmDialog } from "@/components/confirm-dialog"
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
import { AdminMailboxes } from "@/components/admin-mailboxes"
import { adminDnsApi, adminRootDomainsApi, adminSubdomainsApi, errMsg } from "@/services/api"
import { fmtDateTime } from "@/lib/format"
import { notifyAttentionChanged } from "@/lib/attention-events"
import { useT } from "@/i18n"
import type {
  AdminCfZoneCandidate,
  AdminDnsCfDiff,
  AdminDnsFinding,
  AdminDnsFindingRow,
  AdminDnsFindingsResponse,
  AdminDnsListResponse,
  AdminDnsRecord,
  AdminDnsRentalRoot,
  AdminDnsRentalsResponse,
  AdminDnsRentalUser,
  AdminRootDomainsResponse,
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

  // ---- 根域与租用（2026-10-14）----
  // DNS 改成按根域计的积分租用后，站长要在这一个页签里回答三件事：
  // 每个域卖多少钱/配额用了多少、某个人是「免费开通」还是「租的」、全局还剩多少余量。
  const [rentals, setRentals] = React.useState<AdminDnsRentalsResponse | null>(null)
  const [rentalsLoading, setRentalsLoading] = React.useState(false)
  const [rentalsQ, setRentalsQ] = React.useState("")
  /** 正在提交的处置动作（`price:tyu.me` 之类），用来禁用按钮防连点 */
  const [rentalBusy, setRentalBusy] = React.useState("")
  /** 年价输入框的本地草稿（按根域名索引），避免每敲一个字就打一次接口 */
  const [priceDraft, setPriceDraft] = React.useState<Record<string, string>>({})
  /** 每用户上限输入框的本地草稿（按用户名索引） */
  const [limitDraft, setLimitDraft] = React.useState<Record<string, string>>({})

  // ---- 根域的「导入 / 初始化 / 删除」（2026-10-15）----
  //
  // 与上面 rentals 的关系：rentals 回答「已登记的根域卖多少钱、用了多少配额」，
  // rootInfo 回答「这个域在 Cloudflare 上是什么状态、收信通道通没通」，
  // 两者按根域名合并展示。分开取是因为它们的数据来源不同
  // （一个来自本地台账 + D1，一个要打 CF 的 Email Routing 接口）。
  const [rootInfo, setRootInfo] = React.useState<AdminRootDomainsResponse | null>(null)
  /** 导入对话框：打开时现拉候选 zone（CF 侧会变，缓存没有意义） */
  const [importOpen, setImportOpen] = React.useState(false)
  const [importZones, setImportZones] = React.useState<AdminCfZoneCandidate[] | null>(null)
  const [importTokenScope, setImportTokenScope] = React.useState<"account" | "single-zone" | "unknown">("unknown")
  const [importForm, setImportForm] = React.useState({
    name: "",
    price: "0",
    feature: "",
    isDefault: false,
  })
  /** 删除对话框：目标根域（影响面取自 rentals 里服务端算好的数字） */
  const [rootDelete, setRootDelete] = React.useState<AdminDnsRentalRoot | null>(null)
  /** 手输域名确认（后端也会独立校验一遍） */
  const [rootDeleteConfirm, setRootDeleteConfirm] = React.useState("")
  /** 是否连带删除 CF 上的记录 —— **默认关闭**（见对话框里的说明） */
  const [rootDeleteCf, setRootDeleteCf] = React.useState(false)
  const [rootBusy, setRootBusy] = React.useState("")

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

  /**
   * 载入「根域与租用」。
   *
   * ⚠️ 不把 `rentalsQ` 放进这个 callback 的依赖里再由 effect 触发：那样每敲一个
   * 字都会重拉一次（用户维度是按用户名模糊搜的）。改为输入框回车 / 点搜索时才调用
   * `loadRentals()`，依赖只有 `t`。
   */
  const loadRentals = React.useCallback(
    async (query?: string) => {
      setRentalsLoading(true)
      try {
        const res = await adminDnsApi.rentals((query ?? rentalsQ).trim() || undefined)
        setRentals(res)
        // 草稿跟着服务端数据重置：否则改价后再刷新，输入框里还留着旧草稿，
        // 看起来像「改了没生效」
        setPriceDraft({})
        setLimitDraft({})
      } catch (err) {
        toast.error(errMsg(err, t("dns.err.load")))
      } finally {
        setRentalsLoading(false)
      }
    },
    [rentalsQ, t]
  )

  /**
   * 提交一个「根域 / 用户 / 租约」处置动作。
   *
   * 成功后一律**重拉列表**而不是本地改一行：价格、启用状态、上限、租约状态
   * 都会影响多行展示（比如停用根域会连带改变「可用」的判断），
   * 本地补丁迟早与服务端算出来的口径分叉 —— 管理端宁可多一次请求。
   */
  const runRentalAction = async (
    key: string,
    payload: Parameters<typeof adminDnsApi.rentalAction>[0],
    okKey: string
  ) => {
    setRentalBusy(key)
    try {
      await adminDnsApi.rentalAction(payload)
      toast.success(t(okKey))
      await loadRentals()
    } catch (err) {
      toast.error(errMsg(err, t("dns.rental.actionErr")))
    } finally {
      setRentalBusy("")
    }
  }

  /**
   * 载入「根域在 Cloudflare 上的现状」（Email Routing / catch-all 是否已指向本 Worker）。
   *
   * 与 loadRentals 同一时机拉（切到该页签）。失败**不弹 toast**：它只是给已有列表
   * 补一列状态，拉不到时那一列显示「—」；而它要逐根域打两次 CF 接口，
   * 在 Token 权限不足时每次进页签都糊一层错误提示，反而盖住了真正要看的配额数据。
   */
  const loadRootInfo = React.useCallback(async () => {
    try {
      setRootInfo(await adminRootDomainsApi.list())
    } catch {
      setRootInfo(null)
    }
  }, [])

  /** 打开导入对话框：候选 zone 每次现拉（CF 侧随时可能加域，缓存没有意义） */
  const openImport = async () => {
    setImportOpen(true)
    setImportZones(null)
    setImportForm({ name: "", price: "0", feature: "", isDefault: false })
    try {
      const res = await adminRootDomainsApi.cfZones()
      setImportZones(res.zones)
      setImportTokenScope(res.tokenScope)
    } catch (err) {
      setImportZones([])
      toast.error(errMsg(err, t("dns.root.import.err")))
    }
  }

  /**
   * 提交导入（登记 + 自动初始化）。
   *
   * 后端整条链路是幂等的，所以**失败可以直接再按一次**：已建好的泛解析会跳过、
   * 设置项是去重追加。这也是这里不做任何「失败后回滚本地状态」的原因 ——
   * 真正的状态在服务端，重拉一次列表就是最新的。
   */
  const submitImport = async () => {
    const name = importForm.name.trim()
    if (!name) return
    const price = importForm.price.trim() === "" ? 0 : Number(importForm.price)
    if (!Number.isInteger(price) || price < 0 || price > 1_000_000) {
      toast.error(t("dns.root.import.priceErr"))
      return
    }
    setRootBusy("import")
    try {
      const res = await adminRootDomainsApi.import({
        name,
        zoneId: importZones?.find((z) => z.name === name)?.zoneId ?? "",
        dnsPricePerYear: price,
        requiresFeature: importForm.feature || undefined,
        isDefault: importForm.isDefault,
      })
      toast.success(t("dns.root.import.done", { v0: res.name, v1: res.wildcard.detail }))
      // 把每一步的结果摊出来：站长要能一眼看出「这次是新建还是复用了已有泛解析」——
      // 这正是「重试安全」这句话在界面上的证据，而不是一句口头承诺。
      toast.message(
        res.steps
          .map(
            (s) =>
              `${t(`dns.root.import.step.${s.step}`)}：${t(`dns.root.import.state.${s.state}`)}`
          )
          .join(" · ")
      )
      setImportOpen(false)
      await Promise.all([loadRentals(), loadRootInfo()])
    } catch (err) {
      toast.error(errMsg(err, t("dns.root.import.err")))
    } finally {
      setRootBusy("")
    }
  }

  /**
   * 删除根域。
   *
   * ⚠️ `confirm` 必须等于完整域名：后端会**独立**再校验一遍（不信任前端的弹窗），
   * 而且 `deleteCfRecords` 默认 false —— 删 CF 记录会静默掐断用户正在跑的服务。
   */
  const submitRootDelete = async () => {
    if (!rootDelete) return
    const name = rootDelete.name
    const typed = rootDeleteConfirm.trim().toLowerCase()
    if (typed !== name) {
      toast.error(t("dns.root.delete.err.confirm"))
      return
    }
    setRootBusy(`delete:${name}`)
    try {
      const res = await adminRootDomainsApi.action({
        action: "delete",
        name,
        confirm: typed,
        deleteCfRecords: rootDeleteCf,
      })
      toast.success(t("dns.root.delete.ok", { v0: name }))
      // 连带删除的结果要逐条讲清楚：删了几条、跳过了几条（跳过的是 MX/TXT 这类
      // 不属于平台自建的记录，需要站长自己去 CF 处理）。
      const cf = "cf" in res ? res.cf : null
      if (cf) {
        toast.message(
          t("dns.root.delete.cfResult", {
            v0: String(cf.deleted.length),
            v1: String(cf.keptTotal),
          })
        )
        if (cf.kept.length > 0) {
          toast.message(t("dns.root.delete.keptList", { v0: cf.kept.slice(0, 5).join("、") }))
        }
      } else {
        toast.message(t("dns.root.delete.cfKept"))
      }
      setRootDelete(null)
      await Promise.all([loadRentals(), loadRootInfo()])
    } catch (err) {
      toast.error(errMsg(err, t("dns.root.delete")))
    } finally {
      setRootBusy("")
    }
  }

  /**
   * 开通邮件路由 / 把 catch-all 指向本 Worker。
   *
   * 刻意拆成两个动作（后端也是两个 action）：CF 侧这两步的前置条件不同
   * （先有 Email Routing 才能设 catch-all），合起来做一旦失败就分不清卡在哪。
   */
  const runRootMailAction = async (
    name: string,
    action: "enable-email" | "set-catchall"
  ) => {
    setRootBusy(`mail:${name}:${action}`)
    try {
      const res = await adminRootDomainsApi.action({ action, name })
      // ⚠️ 200 不等于成功：后端历史上在「开通失败」时也回 200 + `ok:false`。
      // 那时只 await 响应就弹「已开通 Email Routing」，站长以为配好了、
      // 实际 CF 上一条记录都没建，该域**收不到任何信** —— 假成功比报错更坏。
      // 后端已改成失败回 502（走下面的 catch），这里再复核一次 `ok`：
      // 两侧都拦，任一侧将来退化都不会再出现「200 就报喜」。
      if (!res.ok) {
        toast.error(
          t(action === "enable-email" ? "dns.root.mail.enableFail" : "dns.root.mail.catchallFail")
        )
        return
      }
      toast.success(
        t(action === "enable-email" ? "dns.root.mail.enabledOk" : "dns.root.mail.catchallOk")
      )
      await loadRootInfo()
    } catch (err) {
      toast.error(errMsg(err, t("dns.rental.actionErr")))
    } finally {
      setRootBusy("")
    }
  }

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
    // 切到这个页签时才拉：它比其它几个页签重（根域逐域 COUNT + 用户维度 + 租约）
    if (tab === "rentals") {
      void loadRentals()
      // 根域在 CF 侧的现状（Email Routing / catch-all）与上面的配额数据来源不同，
      // 分开拉、失败互不影响
      void loadRootInfo()
    }
  }, [tab, loadFindings, loadCfDiff, loadSubdomains, loadRentals, loadRootInfo])

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
        {/* h-auto + flex-wrap：移动端窄屏放不下时换行，而不是横向溢出屏幕外 */}
        <TabsList className="h-auto max-w-full flex-wrap">
          <TabsTrigger value="subdomains">{t("dns.tab.subdomains")}</TabsTrigger>
          {/* 邮箱管理与子域名管理同形态（跨用户增删改 + 查看内容），紧挨着放 */}
          <TabsTrigger value="mailboxes">{t("dns.tab.mailboxes")}</TabsTrigger>
          <TabsTrigger value="records">{t("dns.tab.records")}</TabsTrigger>
          <TabsTrigger value="findings">
            {t("dns.tab.findings")}
            {/* 用列表接口就带的 openFindings，而不是 findings 接口的计数 ——
                后者只在切到该页签后才加载，角标会晚一拍才出现 */}
            {data?.stats.openFindings ? ` (${data.stats.openFindings})` : ""}
          </TabsTrigger>
          <TabsTrigger value="cf">{t("dns.tab.cf")}</TabsTrigger>
          {/* 根域定价与租用：紧挨着 Cloudflare 对账放，两者都是「容量与事实」类信息 */}
          <TabsTrigger value="rentals">{t("dns.tab.rentals")}</TabsTrigger>
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
            <LoadingBlock variant="table" />
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

        {/* ================= 邮箱管理（与子域名管理同形态）================= */}
        <TabsContent value="mailboxes" className="space-y-3">
          <AdminMailboxes />
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
            <LoadingBlock variant="table" />
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
            <LoadingBlock variant="table" />
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
            <LoadingBlock variant="table" />
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

        {/* ================= 根域与租用 =================
            DNS 从「权限闸」改成「按根域定价的积分租用」之后，站长需要的观测点
            全在这一个页签里（后端 GET /admin/dns/rentals 一次给全）：
              · 每个根域：卖多少钱、开没开、CF 配额用掉多少；
              · 每个用户：是免费开通还是租的、什么时候到期、占了多少条、上限多少；
              · 全局：总记录数、活跃租约、即将到期数。
            处置动作走 POST /admin/dns/rental-action（一个接口多个动作，都写审计）。 */}
        <TabsContent value="rentals" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={rentalsQ}
              onChange={(e) => setRentalsQ(e.target.value)}
              onKeyDown={(e) => {
                // 回车才搜：这条请求会带一串逐根域的 COUNT，不该每敲一个字打一次
                if (e.key === "Enter") void loadRentals()
              }}
              placeholder={t("dns.rental.search")}
              className="h-8 w-64"
            />
            <Button size="sm" variant="outline" onClick={() => void loadRentals()}>
              {t("common.search")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={rentalsLoading}
              onClick={() => void loadRentals()}
            >
              <RefreshCw className={`mr-1.5 h-4 w-4 ${rentalsLoading ? "animate-spin" : ""}`} />
              {t("common.refresh")}
            </Button>
          </div>

          {rentalsLoading && !rentals ? (
            <LoadingBlock />
          ) : !rentals ? (
            <EmptyState title={t("dns.rental.empty")} description={t("dns.rental.emptyHint")} />
          ) : (
            <>
              {/* ---- 全局汇总 ---- */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                <StatBox label={t("dns.rental.sum.records")} value={rentals.summary.totalRecords} tone="clean" />
                <StatBox label={t("dns.rental.sum.active")} value={rentals.summary.rentalsActive} tone="low" />
                <StatBox
                  label={t("dns.rental.sum.expiring", { n: String(rentals.summary.expiringSoonDays) })}
                  value={rentals.summary.expiringSoon}
                  tone={rentals.summary.expiringSoon > 0 ? "medium" : "clean"}
                />
                <StatBox label={t("dns.rental.sum.expired")} value={rentals.summary.rentalsExpired} tone="open" />
                <StatBox label={t("dns.rental.sum.users")} value={rentals.summary.usersTracked} tone="open" />
                <StatBox
                  label={t("dns.rental.sum.usersWithRecords")}
                  value={rentals.summary.usersWithRecords}
                  tone="low"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {t("dns.rental.sum.note", {
                  v0: String(rentals.summary.globalRecordLimit),
                  v1: String(rentals.summary.cfZoneRecordLimit),
                })}
              </p>

              {/* ---- 根域维度：定价 + 配额 + 导入/删除 ---- */}
              <Card>
                <CardHeader>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="space-y-1.5">
                      <CardTitle className="flex items-center gap-2 text-base">
                        <Globe className="h-4 w-4 text-muted-foreground" />
                        {t("dns.rental.roots.title")}
                      </CardTitle>
                      <CardDescription>{t("dns.rental.roots.desc")}</CardDescription>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      // 没有 CF Token 时导入必然失败，直接禁掉比让站长点了再看报错好；
                      // rootInfo 拉不到时（`=== false` 不成立）不禁用，让请求自己去报错。
                      disabled={rootInfo?.hasCfToken === false}
                      onClick={() => void openImport()}
                    >
                      <Cloud className="mr-1.5 h-4 w-4" />
                      {t("dns.root.import")}
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("dns.rental.roots.name")}</TableHead>
                        <TableHead>zone_id</TableHead>
                        <TableHead>{t("dns.rental.roots.default")}</TableHead>
                        <TableHead>{t("dns.rental.roots.enabled")}</TableHead>
                        <TableHead>{t("dns.rental.roots.feature")}</TableHead>
                        <TableHead>{t("dns.rental.roots.price")}</TableHead>
                        <TableHead>{t("dns.rental.roots.usage")}</TableHead>
                        <TableHead>{t("dns.rental.roots.rentals")}</TableHead>
                        <TableHead>{t("dns.root.mail")}</TableHead>
                        <TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rentals.roots.map((r) => {
                        const draft = priceDraft[r.name] ?? String(r.yearPrice)
                        const busyKey = `price:${r.name}`
                        // 配额压力用颜色说话：>=90% 红、>=70% 黄，其余正常。
                        // 撞上 CF 的 81045 是**全站**一起建不了记录，必须提前看见。
                        const ratio = r.recordsUsed / r.recordsLimit
                        // 该根域在 CF 侧的收信通道现状（rootInfo 拉不到时是 undefined，
                        // 单元格会显示「—」，不影响定价与配额这两列可用）
                        const mail = rootInfo?.rootDomains.find((d) => d.name === r.name)
                          ?.emailRouting
                        // 两道禁删线与后端一致：默认域（注册无处可去）＋站点主域
                        // （`cloud.doulor.cn` 等入口都从它拼出来）。后端也会拒，
                        // 前端禁用只是别让站长白点一次。
                        const isSiteRoot = r.name === rootInfo?.siteDomain
                        const deleteBlocked = r.isDefault || isSiteRoot
                        return (
                          <TableRow key={r.name}>
                            <TableCell className="font-mono text-xs">
                              {r.name}
                              {r.label !== r.name && (
                                <span className="ml-1 text-muted-foreground">({r.label})</span>
                              )}
                            </TableCell>
                            <TableCell className="max-w-[140px] truncate font-mono text-[11px] text-muted-foreground">
                              {r.zoneId ?? t("dns.rental.roots.noZone")}
                            </TableCell>
                            <TableCell>
                              {r.isDefault ? <Badge variant="secondary">{t("dns.rental.roots.isDefault")}</Badge> : "—"}
                            </TableCell>
                            <TableCell>
                              <Switch
                                checked={r.enabled}
                                disabled={rentalBusy === `enabled:${r.name}`}
                                onCheckedChange={(v) =>
                                  void runRentalAction(
                                    `enabled:${r.name}`,
                                    { action: "set-enabled", name: r.name, enabled: v },
                                    v ? "dns.rental.roots.enabledOk" : "dns.rental.roots.disabledOk"
                                  )
                                }
                              />
                            </TableCell>
                            <TableCell className="text-xs">
                              {r.requiresFeature ? (
                                <Badge variant="outline">{r.requiresFeature}</Badge>
                              ) : (
                                <span className="text-muted-foreground">{t("dns.rental.roots.noFeature")}</span>
                              )}
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1">
                                <Input
                                  value={draft}
                                  inputMode="numeric"
                                  className="h-8 w-24"
                                  onChange={(e) =>
                                    setPriceDraft((prev) => ({ ...prev, [r.name]: e.target.value }))
                                  }
                                />
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-8"
                                  disabled={
                                    rentalBusy === busyKey || draft === String(r.yearPrice)
                                  }
                                  onClick={() =>
                                    void runRentalAction(
                                      busyKey,
                                      {
                                        action: "set-price",
                                        name: r.name,
                                        dnsPricePerYear: Number(draft),
                                      },
                                      "dns.rental.roots.priceOk"
                                    )
                                  }
                                >
                                  {rentalBusy === busyKey ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    t("common.save")
                                  )}
                                </Button>
                              </div>
                              {r.yearPrice === 0 && (
                                <p className="mt-1 text-[11px] text-muted-foreground">
                                  {t("dns.rental.roots.notForSale")}
                                </p>
                              )}
                            </TableCell>
                            <TableCell
                              className={`text-xs tabular-nums ${
                                ratio >= 0.9
                                  ? "text-red-600"
                                  : ratio >= 0.7
                                    ? "text-amber-600"
                                    : "text-muted-foreground"
                              }`}
                            >
                              {r.recordsUsed} / {r.recordsLimit}
                            </TableCell>
                            <TableCell className="text-xs tabular-nums text-muted-foreground">
                              {r.rentalsActive} / {r.rentalsTotal}
                            </TableCell>
                            <TableCell>
                              <RootMailCell
                                name={r.name}
                                mail={mail}
                                busy={rootBusy}
                                onAction={runRootMailAction}
                              />
                            </TableCell>
                            <TableCell className="text-right">
                              {/* 禁用按钮上挂 Tooltip 需要一个真实的包裹元素：
                                  禁用元素的鼠标事件不触发，Tooltip 会永远不弹。 */}
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="inline-block">
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-8 text-xs text-destructive"
                                      disabled={deleteBlocked || rootBusy === `delete:${r.name}`}
                                      onClick={() => {
                                        setRootDelete(r)
                                        setRootDeleteConfirm("")
                                        // 每次打开都回到默认（不删 CF 记录）：
                                        // 上次勾过的状态不该被继承 —— 那是「静默掐断服务」的开关
                                        setRootDeleteCf(false)
                                      }}
                                    >
                                      {rootBusy === `delete:${r.name}` ? (
                                        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                                      ) : (
                                        <Trash2 className="mr-1 h-3.5 w-3.5" />
                                      )}
                                      {t("dns.root.delete")}
                                    </Button>
                                  </span>
                                </TooltipTrigger>
                                {deleteBlocked && (
                                  <TooltipContent>
                                    {r.isDefault
                                      ? t("dns.root.delete.blockedDefault")
                                      : t("dns.root.delete.blockedSite")}
                                  </TooltipContent>
                                )}
                              </Tooltip>
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              {/* ---- 用户维度 ---- */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <UserCog className="h-4 w-4 text-muted-foreground" />
                    {t("dns.rental.users.title")}
                  </CardTitle>
                  <CardDescription>{t("dns.rental.users.desc")}</CardDescription>
                </CardHeader>
                <CardContent className="overflow-x-auto">
                  {rentals.users.length === 0 ? (
                    <EmptyState title={t("dns.rental.users.empty")} description={t("dns.rental.users.emptyHint")} />
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("dns.rental.users.user")}</TableHead>
                          <TableHead>{t("dns.rental.users.source")}</TableHead>
                          <TableHead>{t("dns.rental.users.expires")}</TableHead>
                          <TableHead>{t("dns.rental.users.usage")}</TableHead>
                          <TableHead>{t("dns.rental.users.limit")}</TableHead>
                          <TableHead>{t("dns.rental.users.lastRecord")}</TableHead>
                          <TableHead>{t("dns.rental.users.actions")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rentals.users.map((u) => (
                          <UserRentalRow
                            key={u.id}
                            user={u}
                            roots={rentals.roots.map((r) => r.name)}
                            busy={rentalBusy}
                            limitDraft={limitDraft[u.username]}
                            onLimitDraft={(v) =>
                              setLimitDraft((prev) => ({ ...prev, [u.username]: v }))
                            }
                            onAction={runRentalAction}
                          />
                        ))}
                      </TableBody>
                    </Table>
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

      {/* ---- 从 Cloudflare 导入根域（添加 + 自动初始化）---- */}
      <Dialog open={importOpen} onOpenChange={(o) => !o && setImportOpen(false)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("dns.root.import.title")}</DialogTitle>
            <DialogDescription>{t("dns.root.import.desc")}</DialogDescription>
          </DialogHeader>

          {importZones === null ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("dns.root.import.loading")}
            </div>
          ) : importZones.length === 0 ? (
            <EmptyState
              title={t("dns.root.import.empty")}
              description={t("dns.root.import.emptyHint")}
            />
          ) : (
            <div className="space-y-3">
              {importTokenScope === "single-zone" && (
                <p className="text-xs text-amber-600">{t("dns.root.import.tokenScope")}</p>
              )}
              {/* 候选 zone 用表格而不是下拉：站长要先看「这个 zone 的记录配额还剩多少、
                  泛解析是什么状态」才能决定要不要导入，下拉框里塞不下这些事实。 */}
              <div className="max-h-64 overflow-y-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8" />
                      <TableHead>{t("dns.root.import.col.zone")}</TableHead>
                      <TableHead className="w-24">{t("dns.root.import.col.status")}</TableHead>
                      <TableHead className="w-28">{t("dns.root.import.col.usage")}</TableHead>
                      <TableHead className="w-40">{t("dns.root.import.col.wildcard")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {importZones.map((z) => {
                      const picked = importForm.name === z.name
                      const usage = z.recordsUsed ?? null
                      const hot = usage !== null && usage / z.recordsLimit >= 0.9
                      return (
                        <TableRow
                          key={z.zoneId}
                          className="cursor-pointer"
                          onClick={() => setImportForm((f) => ({ ...f, name: z.name }))}
                        >
                          <TableCell>
                            <input
                              type="radio"
                              name="cf-zone"
                              checked={picked}
                              onChange={() => setImportForm((f) => ({ ...f, name: z.name }))}
                              className="h-4 w-4"
                              aria-label={z.name}
                            />
                          </TableCell>
                          <TableCell className="font-mono text-xs">{z.name}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {z.status}
                            {z.paused ? " · paused" : ""}
                          </TableCell>
                          <TableCell
                            className={`text-xs tabular-nums ${
                              hot ? "text-red-600" : "text-muted-foreground"
                            }`}
                          >
                            {usage === null ? "?" : usage} / {z.recordsLimit}
                          </TableCell>
                          <TableCell className="text-xs">
                            <WildcardBadge status={z.wildcard} detail={z.wildcardDetail} />
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="root-import-price">{t("dns.root.import.price")}</Label>
                  <Input
                    id="root-import-price"
                    inputMode="numeric"
                    value={importForm.price}
                    onChange={(e) => setImportForm({ ...importForm, price: e.target.value })}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    {t("dns.root.import.priceHint")}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="root-import-feature">{t("dns.root.import.feature")}</Label>
                  {/* 权限清单来自后端（与 FEATURES 同源），前端不硬编码 ——
                      否则新加一个权限位时这里会静默少一个选项 */}
                  <Select
                    value={importForm.feature || "__none__"}
                    onValueChange={(v) =>
                      setImportForm({ ...importForm, feature: v === "__none__" ? "" : v })
                    }
                  >
                    <SelectTrigger id="root-import-feature">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">{t("dns.rental.roots.noFeature")}</SelectItem>
                      {(rootInfo?.features ?? []).map((f) => (
                        <SelectItem key={f.key} value={f.key}>
                          {f.key} · {f.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex items-start gap-2 rounded-md border p-3">
                <Switch
                  id="root-import-default"
                  checked={importForm.isDefault}
                  onCheckedChange={(v) => setImportForm({ ...importForm, isDefault: v })}
                />
                <div className="space-y-0.5">
                  <Label htmlFor="root-import-default">{t("dns.root.import.default")}</Label>
                  <p className="text-[11px] text-muted-foreground">
                    {t("dns.root.import.defaultHint")}
                  </p>
                </div>
              </div>

              <p className="text-[11px] text-muted-foreground">
                {t("dns.root.import.retryHint")}
              </p>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={!importForm.name || rootBusy === "import"}
              onClick={() => void submitImport()}
            >
              {rootBusy === "import" ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Plus className="mr-1.5 h-4 w-4" />
              )}
              {t("dns.root.import.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- 删除根域（二次确认 + 影响面 + 是否连带删 CF 记录）---- */}
      <Dialog
        open={rootDelete !== null}
        onOpenChange={(o) => {
          if (!o) setRootDelete(null)
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-mono">
              {t("dns.root.delete.title", { v0: rootDelete?.name ?? "" })}
            </DialogTitle>
            <DialogDescription>{t("dns.root.delete.desc")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {/* 影响面用 rentals 里**服务端算好的**数字（该接口逐根域 COUNT 过），
                不在前端自己数 —— 后端删除时会再算一遍并写进审计日志，
                两边口径一致才解释得清「删之前看到 3 条、删之后审计里是 3 条」。 */}
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-500">
              {t("dns.root.delete.impact", {
                v0: String(rootDelete?.recordsUsed ?? 0),
                v1: String(rootDelete?.rentalsActive ?? 0),
                v2: String(rootDelete?.rentalsTotal ?? 0),
              })}
            </p>

            <label className="flex cursor-pointer items-start gap-2 rounded-md border p-3">
              <input
                type="checkbox"
                checked={rootDeleteCf}
                onChange={(e) => setRootDeleteCf(e.target.checked)}
                className="mt-0.5 h-4 w-4"
              />
              <span className="space-y-1">
                <span className="block text-sm font-medium">{t("dns.root.delete.cf")}</span>
                <span className="block text-[11px] text-muted-foreground">
                  {t("dns.root.delete.cfHint")}
                </span>
              </span>
            </label>

            <div className="space-y-1.5">
              <Label htmlFor="root-delete-confirm">
                {t("dns.root.delete.confirmLabel", { v0: rootDelete?.name ?? "" })}
              </Label>
              <Input
                id="root-delete-confirm"
                value={rootDeleteConfirm}
                onChange={(e) => setRootDeleteConfirm(e.target.value)}
                placeholder={rootDelete?.name ?? ""}
                className="font-mono text-xs"
                autoComplete="off"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setRootDelete(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={
                rootBusy === `delete:${rootDelete?.name ?? ""}` ||
                rootDeleteConfirm.trim().toLowerCase() !== (rootDelete?.name ?? "")
              }
              onClick={() => void submitRootDelete()}
            >
              {rootBusy === `delete:${rootDelete?.name ?? ""}` && (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              )}
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * 「根域与租用」表里的「邮箱」列。
 *
 * 为什么需要它：根域被登记进 `root_domains` 之后，`用户名@该域` 就已经能建出来了，
 * 但只有 catch-all 指向本 Worker 才**真的收得到信**（见 admin-root-domains.ts 开头的
 * 说明）。少了这一列，站长在面板里看到的是一个「一切正常」的根域，
 * 而用户那边的邮件其实全丢了 —— 这是要靠界面暴露出来、不能靠记忆的一件事。
 *
 * 两个动作（开通 Email Routing / 指向本 Worker）刻意分开：CF 侧前者是后者的前置条件，
 * 合成一个「一键收信」按钮一旦失败就分不清卡在哪一步。
 */
function RootMailCell({
  name,
  mail,
  busy,
  onAction,
}: {
  name: string
  /** undefined = 该根域的 CF 状态没拉到（`—`），不是「没开通」 */
  mail?: { enabled: boolean; workerMatches: boolean }
  busy: string
  onAction: (name: string, action: "enable-email" | "set-catchall") => Promise<void>
}) {
  const { t } = useT()
  if (!mail) return <span className="text-xs text-muted-foreground">—</span>
  if (mail.workerMatches) {
    return <Badge variant="secondary">{t("dns.root.mail.ready")}</Badge>
  }
  const action = mail.enabled ? "set-catchall" : "enable-email"
  return (
    <div className="space-y-1">
      <span className="block text-[11px] text-amber-600">
        {mail.enabled ? t("dns.root.mail.needsCatchall") : t("dns.root.mail.needsRouting")}
      </span>
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-[11px]"
        disabled={busy === `mail:${name}:${action}`}
        onClick={() => void onAction(name, action)}
      >
        {busy === `mail:${name}:${action}` && (
          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
        )}
        {mail.enabled ? t("dns.root.mail.catchall") : t("dns.root.mail.enable")}
      </Button>
    </div>
  )
}

/**
 * 泛解析现状的徽标（导入候选列表用）。
 *
 * 重点是把「有 AAAA 100:: 但没开代理」和「同名记录不是本站占位」这两种
 * **看着像配好了**的状态标成警告色 —— 它们正是导入会被后端拒绝的原因
 * （灰云的泛解析接不住 Worker 路由，见 ensureWildcardRecord 的注释）。
 */
function WildcardBadge({
  status,
  detail,
}: {
  status: AdminCfZoneCandidate["wildcard"]
  detail: string | null
}) {
  const { t } = useT()
  const cls =
    status === "ok"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600"
      : status === "missing"
        ? "border-border bg-muted/40 text-muted-foreground"
        : "border-amber-500/30 bg-amber-500/10 text-amber-600"
  return (
    <span className="flex flex-col gap-0.5">
      <span className={`inline-flex w-fit rounded-md border px-1.5 py-0.5 text-[10px] ${cls}`}>
        {t(`dns.root.wc.${status}`)}
      </span>
      {detail && <span className="font-mono text-[10px] text-muted-foreground">{detail}</span>}
    </span>
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

/**
 * 「根域与租用」里的一个用户行。
 *
 * 抽成独立组件而不是内联在 map 里：这一行自己有状态（手工开租约时选的根域），
 * 内联就得把状态提到父组件里做成 `Record<username, root>`，为一行表单付这个代价不值得。
 *
 * 展示口径与后端 listAdminDnsRentals 一一对应：
 *   · `source` 是**综合判定**（特权 > 权限位 > 租用 > 已过期 > 无），
 *     单看 `dnsPermission` 会把「有权限位但被租期卡住」这种不可能的状态当真；
 *   · `recordLimit === null` = 不限（管理员 / 站长），显示「不限」而不是一个假数字。
 */
function UserRentalRow({
  user: u,
  roots,
  busy,
  limitDraft,
  onLimitDraft,
  onAction,
}: {
  user: AdminDnsRentalUser
  /** 可手工开租约的根域（取自根域列表，避免拼出不存在的域） */
  roots: string[]
  busy: string
  limitDraft?: string
  onLimitDraft: (v: string) => void
  onAction: (
    key: string,
    payload: Parameters<typeof adminDnsApi.rentalAction>[0],
    okKey: string
  ) => Promise<void>
}) {
  const { t } = useT()
  /** 手工开租约用的根域（默认取第一个可用根域） */
  const [grantRoot, setGrantRoot] = React.useState("")
  const activeRental = u.rentals.find((r) => r.status === "active" && r.daysLeft > 0) ?? null

  const sourceBadge = () => {
    if (u.source === "privileged") return <Badge variant="outline">{t("dns.rental.src.privileged")}</Badge>
    if (u.source === "permission") return <Badge variant="secondary">{t("dns.rental.src.permission")}</Badge>
    if (u.source === "rental") return <Badge>{t("dns.rental.src.rental")}</Badge>
    if (u.source === "expired") return <Badge variant="destructive">{t("dns.rental.src.expired")}</Badge>
    return <span className="text-xs text-muted-foreground">{t("dns.rental.src.none")}</span>
  }

  return (
    <TableRow>
      <TableCell className="text-xs">
        <div className="font-medium">{u.username}</div>
        <div className="text-muted-foreground">
          {u.uid !== null ? `#${u.uid} · ` : ""}
          {u.email}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {u.role}
          {u.status !== "active" ? ` · ${u.status}` : ""}
        </div>
      </TableCell>
      <TableCell className="text-xs">{sourceBadge()}</TableCell>
      <TableCell className="text-xs tabular-nums">
        {u.expiresAt ? (
          <>
            <div>{fmtDateTime(u.expiresAt)}</div>
            <div className={u.daysLeft !== null && u.daysLeft <= 7 ? "text-amber-600" : "text-muted-foreground"}>
              {t("dns.rental.users.daysLeft", { n: String(u.daysLeft ?? 0) })}
            </div>
            {u.activeRoots.length > 0 && (
              <div className="font-mono text-[11px] text-muted-foreground">
                {u.activeRoots.join(", ")}
              </div>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-xs tabular-nums text-muted-foreground">
        {u.recordsUsed} / {u.recordLimit === null ? t("dns.rental.unlimited") : u.recordLimit}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1">
          <Input
            value={limitDraft ?? String(u.recordLimit ?? "")}
            inputMode="numeric"
            placeholder={t("dns.rental.users.noOverride")}
            className="h-8 w-20"
            onChange={(e) => onLimitDraft(e.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            disabled={busy === `limit:${u.username}`}
            onClick={() =>
              void onAction(
                `limit:${u.username}`,
                {
                  action: "set-limit",
                  username: u.username,
                  // 留空 = 取消用户级覆盖（回落全局设置）。**不能**当成 0：
                  // 0 是「一条都不许建」这个合法的上限，两者混起来会让「锁死」静默失效。
                  limit: (limitDraft ?? "").trim() === "" ? null : Number(limitDraft),
                },
                "dns.rental.users.limitOk"
              )
            }
          >
            {busy === `limit:${u.username}` ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              t("common.save")
            )}
          </Button>
        </div>
        {u.limitOverridden && (
          <p className="mt-1 text-[11px] text-muted-foreground">{t("dns.rental.users.overridden")}</p>
        )}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {u.lastRecordAt ? fmtDateTime(u.lastRecordAt) : "—"}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1">
          {/* 权限位开关：与「成员详情」里勾权限是同一件事（同一个 JSON 键），
              放在这里是因为站长排查 DNS 问题时不想再跳一次页面。 */}
          <Button
            size="sm"
            variant={u.dnsPermission ? "outline" : "default"}
            className="h-8 text-xs"
            disabled={busy === `perm:${u.username}`}
            onClick={async () => {
              if (u.dnsPermission) {
                const ok = await confirmDialog({
                  title: t("dns.rental.users.revoke"),
                  desc: t("dns.rental.users.revokeConfirm", { v0: u.username }),
                  okText: t("dns.rental.users.revoke"),
                })
                if (!ok) return
              }
              await onAction(
                `perm:${u.username}`,
                {
                  action: u.dnsPermission ? "revoke-permission" : "grant-permission",
                  username: u.username,
                },
                u.dnsPermission ? "dns.rental.users.revoked" : "dns.rental.users.granted"
              )
            }}
          >
            {busy === `perm:${u.username}` ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : u.dnsPermission ? (
              <XCircle className="h-3.5 w-3.5" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" />
            )}
            {u.dnsPermission ? t("dns.rental.users.revoke") : t("dns.rental.users.grant")}
          </Button>

          {/* 续期 / 停用：只对「当前有效的那一份租约」操作（一个用户在一个根域上
              至多一份有效租约，见 0161 的部分唯一索引）。 */}
          {activeRental && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                disabled={busy === `extend:${activeRental.id}`}
                onClick={() =>
                  void onAction(
                    `extend:${activeRental.id}`,
                    { action: "extend-rental", id: activeRental.id, days: 365 },
                    "dns.rental.users.extended"
                  )
                }
              >
                {busy === `extend:${activeRental.id}` ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Timer className="h-3.5 w-3.5" />
                )}
                {t("dns.rental.users.extend")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 text-xs text-destructive"
                disabled={busy === `revoke:${activeRental.id}`}
                onClick={async () => {
                  const ok = await confirmDialog({
                    title: t("dns.rental.users.revokeRental"),
                    desc: t("dns.rental.users.revokeRentalConfirm", { v0: u.username }),
                    okText: t("dns.rental.users.revokeRental"),
                  })
                  if (!ok) return
                  await onAction(
                    `revoke:${activeRental.id}`,
                    { action: "revoke-rental", id: activeRental.id },
                    "dns.rental.users.revokedRental"
                  )
                }}
              >
                {t("dns.rental.users.revokeRental")}
              </Button>
            </>
          )}

          {/* 手工开租约（不扣分）：用户已付费但自动落库失败、或线下结算时用。
              天数固定一年，需要别的时长走接口。 */}
          {!u.activeRoots.length && roots.length > 0 && (
            <div className="flex items-center gap-1">
              <Select value={grantRoot} onValueChange={setGrantRoot}>
                <SelectTrigger className="h-8 w-28 text-xs">
                  <SelectValue placeholder={t("dns.rental.users.pickRoot")} />
                </SelectTrigger>
                <SelectContent>
                  {roots.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                disabled={!grantRoot || busy === `create:${u.username}`}
                onClick={() =>
                  void onAction(
                    `create:${u.username}`,
                    {
                      action: "create-rental",
                      username: u.username,
                      rootDomain: grantRoot,
                      days: 365,
                    },
                    "dns.rental.users.created"
                  )
                }
              >
                {busy === `create:${u.username}` ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                {t("dns.rental.users.create")}
              </Button>
            </div>
          )}
        </div>
      </TableCell>
    </TableRow>
  )
}
