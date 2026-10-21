import * as React from "react"
import { ChevronDown, CornerDownRight, Globe, ListChecks, Loader2, Pencil, Plus, RefreshCw, ScrollText, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { DomainRecordsSkeleton } from "@/components/skeletons"
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
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DnsRentalPanel } from "@/components/dns-rental-panel"
import { dnsApi, domainApi, HttpError } from "@/services/api"
import {
  dnsAccessView,
  recordDomainChoices as deriveRecordDomainChoices,
  usableDnsRoots,
} from "@/lib/dns-access"
import { useT } from "@/i18n"
import { useAuth } from "@/hooks/use-auth"
import type { DnsRecord, DnsRecordType, DnsRentalState, RootDomainOption, Subdomain } from "@/types"

const RECORD_TYPES: DnsRecordType[] = ["A", "AAAA", "CNAME", "TXT", "MX", "SRV"]

/** SRV 的协议选项。RFC 2782 里这两个是实际会被用到的（其余少见，不列以免误导） */
const SRV_PROTOS = ["tcp", "udp"]

function StatusBadge({ status }: { status: DnsRecord["status"] }) {
  if (status === "active") return <Badge variant="success">active</Badge>
  if (status === "pending") return <Badge variant="secondary">pending</Badge>
  return <Badge variant="destructive">error</Badge>
}

/**
 * 一条记录挂在哪个域名下（列表的 Domain 列、编辑弹窗的基准域名都用它）。
 *
 * 为什么不在组件里现算：列表、弹窗、提交前的校验都要用到同一个答案，
 * 各写一份迟早出现「列表说是 A 域、弹窗按 B 域算」的不一致。
 *
 * 优先用服务端下发的 `subdomainFqdn`（LEFT JOIN subdomains 得来）；老数据的
 * `subdomain_id` 为空时服务端给 null，这里按「fqdn 去掉记录名」兜底：
 * `blog.xxxxx.tyu.me` 去掉 `blog` 就是 `xxxxx.tyu.me`；记录名是 `@` 时
 * fqdn 本身就是它所在的域名。`managed`（平台派生）项同理。
 */
function ownerFqdn(r: DnsRecord): string {
  if (r.subdomainFqdn) return r.subdomainFqdn
  if (r.name && r.name !== "@" && r.fqdn.endsWith(`.${r.name}`)) {
    return r.fqdn.slice(0, r.fqdn.length - r.name.length - 1)
  }
  return r.fqdn
}

/**
 * 记录名是不是「就挂在基准域名本身」（2026-10-21）。
 *
 * `@`、全角 `＠`、留空 都算 —— 与后端 `normalizeRecordName` 完全同一口径。
 * 前端拿它决定两件事：预览里要不要拼 `.<base>` 尾缀、要不要提示「@ = 你的域名」。
 *
 * ⚠️ 之前预览是死写 `(form.name || "@") + "." + base`，用户填 `@` 会看到
 *    `@.xxx.tyu.me` —— 看着像要建一条坏记录，实际服务端建的是对的。
 *    预览必须说真话，否则没人敢用 `@`。
 */
function isApexName(raw: string): boolean {
  const v = (raw ?? "").trim().replace(/＠/g, "@").replace(/\.+$/, "")
  return v === "" || v === "@"
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

  /**
   * DNS 解析是否**本来就有免费额度**（权限位 / 管理员特权）。
   *
   * 口径与后端 `dnsAccessFor` 的 `full` 档一致，否则会出现「看得见但点不动」
   * 或「有权限却没入口」两种都很难解释的状态：
   *   · 有 `dns` 权限位 —— 后端放行；
   *   · `root` / `superadmin` —— 后端 `isPrivileged()` 直接放行。**必须**带上这一条：
   *     他们的 permissions 里 dns 大概率是 false（迁移不给管理员写），
   *     只看权限位就等于把站长自己关在门外。
   *     ⚠️ 普通 `admin` **不算**：后端 isPrivileged 只认 root/superadmin。
   *
   * ⚠️ 2026-10-14 起 DNS 改成**积分租用**后，没有权限位的用户也能用 ——
   * 只是要自己买（见下方 dnsRental 与 DnsRentalPanel）。所以「选项卡是否渲染」
   * 不再由这个布尔量决定：**所有人都能看到两个选项卡**，买不起的人看到的是价目表。
   *
   * ⚠️ 2026-10-16（paji 故障后）：这个布尔量只是**乐观短路**，不是权威口径 ——
   * 它依赖 `/api/me` 的用户快照（可能还没到、也可能拿不到），而权威是服务端
   * `dnsAccessFor` 判出的档位。真正的判定一律走下面的 access（见 lib/dns-access.ts）。
   */
  const hasFreeDns =
    user?.permissions?.dns === true ||
    user?.role === "root" ||
    user?.role === "superadmin"

  /**
   * 我的 DNS 租用状态（价目 + 我的租约 + 我到底能不能建记录）。
   *
   * 只在**没有免费额度**时才请求：有权限位 / 管理员的人不需要它，
   * 让他们白付一次 D1 往返没有意义。
   */
  const [dnsRental, setDnsRental] = React.useState<DnsRentalState | null>(null)
  const [dnsRentalLoading, setDnsRentalLoading] = React.useState(false)
  /** 「新建记录」时选中的**域名**（一级子域名的 id；非一级由选中项自己决定） */
  const [createDnsSub, setCreateDnsSub] = React.useState("")

  const loadDnsRental = React.useCallback(async () => {
    setDnsRentalLoading(true)
    try {
      setDnsRental(await dnsApi.rental())
    } catch (err) {
      // 不打 toast：这条请求挂了不影响页面其它部分，而面板自己会显示「加载失败」
      // （state 保持 null），再弹一条 toast 只是重复同一件事。
      console.error("读取 DNS 租用状态失败:", err)
      setDnsRental(null)
    } finally {
      setDnsRentalLoading(false)
    }
  }, [])

  /**
   * 访问档位与「能不能看 / 能不能写」的唯一出处（推导见 lib/dns-access.ts）。
   *
   * 🔴 2026-10-16 修的真实故障（站长报的 paji）：这里原先是
   *   `canManageDns = hasFreeDns || dnsAccessMode === "rented" || ... === "expired"`
   * —— **漏掉了服务端的 "full" 档**。服务端 `dnsAccessFor` 是三档（权限位 /
   * 免权限访问 / 有效租约），"full" 正是「有免费额度」那一档；而前端只认
   * rented / expired，于是「服务端说 full、前端自己的 hasFreeDns 快照却是 false」
   * 的用户会被整块关在门外：只看到价目表 + 「你的账号已开通 DNS 解析额度」横幅
   * （横幅的渲染条件就是服务端 `freeAccess === true`），看不到记录列表、也看不到
   * 「添加记录」按钮 —— 可服务端对他其实是全放开的（GET /api/dns 200）。
   *
   * 前端快照为 false 而服务端为 full 是**合法**状态，至少两种：
   *   · 管理面板把 dns 设成「免权限访问」（open_features 含 dns）—— 与权限位互相独立；
   *   · `/api/me` 还没回来 / 失败（useAuth 失败时把 user 置 null，而本页不看 loading）。
   * 所以现在**以服务端 accessMode 为准**，前端快照只作为「还没等到服务端回答时的
   * 乐观短路」—— 有权限位的人不必白等一次 D1 往返。
   */
  const access = dnsAccessView(hasFreeDns, dnsRental?.accessMode)
  /** 能不能看记录列表（expired 也放行 —— 后端允许他们删掉自己的旧记录） */
  const canManageDns = access.canManage
  /** 能不能**新建 / 修改**记录（到期后就不行了，只能删） */
  const canWriteDns = access.canWrite
  /**
   * 手上还有租约（含已过期）—— 即使当前是 full 档也要把租用面板显示出来。
   *
   * 为什么需要这条例外：full 档的人本来不用再买，隐藏价目表是合理的；但他**已经买过**
   * 的那份租约（尤其是开着自动续费的）必须有地方看与关 —— 免权限访问（open_features）
   * 一旦开着，所有人都会变成 full 档，那时若连「我的租约」都藏掉，
   * 一个开着自动续费的用户会**在界面上找不到任何关闭入口**却继续被扣分。
   * 面板里 full 档用户的购买/续期按钮本来就不渲染（见 dns-rental-panel 的 freeAccess 分支），
   * 所以显示它不会诱导他重复付费。
   */
  const hasRentalsToManage = (dnsRental?.rentals.length ?? 0) > 0

  /**
   * 新建记录时可选的根域（买过 / 有权限的才算，与后端闸门口径一致）。
   * `access.mode === "full"` 而不是 `hasFreeDns`：服务端判定的 freeAccess
   * 同样要给全部根域（否则免权限访问的用户连自己已有的域都选不到）。
   */
  const dnsRootChoices = React.useMemo(
    () => usableDnsRoots(access.mode === "full", rootOptions, dnsRental?.options ?? []),
    [access.mode, rootOptions, dnsRental]
  )

  const [subdomains, setSubdomains] = React.useState<Subdomain[]>([])
  const [selected, setSelected] = React.useState<Subdomain | null>(null)

  /**
   * DNS 记录列表的域名筛选：`"all"` = 跨全部域名（默认），否则是某个子域名 id。
   *
   * 为什么默认「全部」而不是跟着上面选中的域名（2026-10-16 站长要求）：
   * 他名下有 3 个子域名，记录都建在 `xxxxx.tyu.me` 下，但页面默认停在
   * `ttest.tyu.me`，于是显示「0 条解析 / 还没有 DNS 记录」——看着像记录丢了。
   * 记录本来就都在自己名下，默认全看见才不会漏。
   * 下拉筛选仍然保留：要只看某一个域时选它即可。
   *
   * ⚠️ 这个状态**只**影响「看哪些记录」，绝不参与编辑/删除的参数 ——
   * 那两个动作一律按记录自己的 id/域名走（见 handleSubmitDns / handleDeleteDns）。
   */
  const [dnsFilter, setDnsFilter] = React.useState("all")
  /**
   * 实际生效的筛选。
   *
   * 指向的子域名已经不存在时（比如刚把它删了）回落「全部」：否则 Select 会显示空值、
   * 列表也拉不到任何东西，用户看到的是一个「什么都没有」的页面而且不知道该改哪里。
   */
  const activeFilter = React.useMemo(() => {
    if (dnsFilter === "all") return "all"
    return subdomains.some((s) => s.id === dnsFilter) ? dnsFilter : "all"
  }, [dnsFilter, subdomains])

  /**
   * 「新建记录」时可选的**域名**（= 我名下的子域名，含 '@' 主域名与二级子域名）。
   *
   * 为什么不是直接列根域：DNS 记录必须挂在用户**确实拥有**的子域名之下
   * （后端 `assertFqdnOwned` 就是这么卡的，它只认 `subdomains` 表里的行）。
   * 所以「记录建在哪个根域下」在数据结构上的等价说法是「建在我名下的哪个域名下」——
   * 列根域再拼一个 `用户名.<根域>`，拼出来的是用户并不拥有的 fqdn，必然 403。
   *
   * 可选范围 = 我名下的子域名 ∩ 我能用的根域：
   *   · 有权限位 / 管理员 ⇒ 能用的根域是后端下发的全部 rootDomains；
   *   · 租用用户 ⇒ 只有买过的那个根域（买 200 的 tyu.me 不等于能用 500 的 7u.nz）。
   *
   * ⚠️ 2026-10-16：二级子域名**也**列进来（原先只列一级）。理由是那次改造把
   * 「批量添加」的目标域名从「当前选中的域名」换成了这个列表 —— 只列一级的话，
   * 批量添加就没法再建在二级子域名下了，属于功能倒退。而且过滤下拉本来就列出
   * 全部子域名，两处口径一致才不会被问「为什么这里看不到我的 xxx.blog 域名」。
   * `root` 仍然按 fqdn 的后缀从可用根域里取，新建时随 `subdomainId` 一起上报，
   * 让服务端做「声明的根域 vs 实际子域名」的一致性校验（见 handlers/dns.ts）。
   *
   * 推导本身抽到了 lib/dns-access.ts 的 recordDomainChoices（纯函数，可单测）：
   * 它的**返回可能是空数组**（名下子域名都不在当前可用根域之下），
   * 那时记录区照常渲染，只是新建入口 disabled —— 见那边的注释。
   */
  const recordDomainChoices = React.useMemo(
    () => deriveRecordDomainChoices(subdomains, dnsRootChoices),
    [subdomains, dnsRootChoices]
  )
  const [records, setRecords] = React.useState<DnsRecord[]>([])
  /**
   * DNS 记录用量（**服务端口径**：跨该用户全部域名），null = 还没拉到。
   * 见 `dnsApi.list` 的注释：不本地数 `records.length` —— 它随筛选变化、
   * 还会带上平台托管的派生项，而上限是全账号**真实记录**合计的，两者对不上
   * 就会显示出一个假的「已用」。
   */
  const [dnsUsage, setDnsUsage] = React.useState<{
    used: number
    limit: number | null
  } | null>(null)
  const [loading, setLoading] = React.useState(true)
  // 配额由服务端下发（用户级覆盖 > 全局设置 > 默认 5）
  const [quota, setQuota] = React.useState(5)
  const [childQuota, setChildQuota] = React.useState(5)
  const [minNameLen, setMinNameLen] = React.useState(3)
  const [saving, setSaving] = React.useState(false)
  const [deletingId, setDeletingId] = React.useState<string | null>(null)
  // ---- 批量操作（DNS 记录）----
  /** 已勾选的记录 id（只在当前域名下有效，切域名/刷新后清空；平台托管的记录不可删，不进勾选） */
  const [batchSelected, setBatchSelected] = React.useState<Set<string>>(new Set())
  /** 「编辑模式」：默认关，点工具栏「编辑」才显示勾选框（与邮箱页同一交互，2026-10-05 站长要求） */
  const [batchSelecting, setBatchSelecting] = React.useState(false)
  const [batchDeleteOpen, setBatchDeleteOpen] = React.useState(false)
  const [batchAddOpen, setBatchAddOpen] = React.useState(false)
  const [batchText, setBatchText] = React.useState("")
  const [batchBusy, setBatchBusy] = React.useState(false)
  /**
   * 正在编辑的记录 id（null = 新建）。
   *
   * 新建与编辑共用同一个弹窗：非 null 时提交走 `dnsApi.update`。
   * 编辑时**不允许改记录名与类型** —— 改类型等于换一条记录，
   * 容易把 SRV 的 service/proto 弄丢，也让「改了什么」变得难以追溯。
   */
  const [editingId, setEditingId] = React.useState<string | null>(null)
  /**
   * 正在编辑的**那条记录本身**（新建时为 null）。
   *
   * 为什么要留整条而不只是 id（2026-10-16，跨域名列表）：弹窗里的基准域名、
   * 「记录名能否留空」的校验、提交的目标，都必须取**这条记录自己的**归属域名，
   * 而不是「当前筛选/选中的域名」—— 全部视图下那两者根本没关系，
   * 拿后者去算会显示错域名、改错记录。
   */
  const [editingRecord, setEditingRecord] = React.useState<DnsRecord | null>(null)
  /**
   * 增删改后让列表重新拉一次的计数器。
   *
   * 把「重新加载」收敛成一件事：筛选变化、手动刷新、增删改之后都走同一个 effect
   * （依赖里带它）。原先每个操作各自 `void loadRecords(selected.id)`——
   * 那种写法在跨域名视图下必然传错域名，而且漏掉一处就静默失效。
   */
  const [reloadTick, setReloadTick] = React.useState(0)
  const reloadRecords = React.useCallback(() => setReloadTick((n) => n + 1), [])

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

  /**
   * 拉记录列表。
   *
   * `subdomainId` 不传 = 要**全部域名**的记录（后端语义，见 dnsApi.list）。
   * 用 `filter`（而不是某个 ref）当参数：每次加载都跟着当前筛选走，
   * 不会出现「筛着 A 域却拉到 B 域」的错配。
   */
  const loadRecords = React.useCallback(async (subdomainId?: string) => {
    setLoading(true)
    try {
      const res = await dnsApi.list(subdomainId)
      setRecords(res.records)
      // 用量跟着列表一起回来（服务端算好，与筛选无关），增删改后的重载会顺带刷新它
      setDnsUsage(res.dnsUsage)
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
    // 有免费额度的人不需要租用状态（后端给他们的一定是 full 档）
    if (hasFreeDns) return
    void loadDnsRental()
  }, [hasFreeDns, loadDnsRental])

  React.useEffect(() => {
    // 拿不到额度就**不要**请求记录：后端会 403，用户每打开一次页面
    // 都会看到一条权限报错 —— 那是噪音，他并没有做错什么，只是还没买。
    // （2026-10-14 起「没额度」的表现是面板里的一张价目表，不是报错。）
    if (!canManageDns) return
    // 连域名都没有时没什么可列（也用不着为此多发一次请求）；
    // 依赖里的 selected?.id 同时负责「域名列表刚加载完」这一次触发。
    if (!selected) return
    void loadRecords(activeFilter === "all" ? undefined : activeFilter)
  }, [activeFilter, selected?.id, reloadTick, loadRecords, canManageDns])

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
      // 正在筛这个域名就退回「全部」：否则筛选指向一个已经不存在 id，
      // 列表会显示成空的，看着像「删个域名把解析也删没了」
      if (dnsFilter === sub.id) setDnsFilter("all")
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
    // 记录整条留下：弹窗的基准域名与校验都要看**它自己的**归属域名（见 editingRecord）
    setEditingRecord(r)
    setOpenDns(true)
  }

  /**
   * 提交：editingId 为空走新建，否则走更新。
   *
   * ⚠️ 跨域名列表下最容易写错的一步就在这里，两条铁律：
   *   · **编辑 / 删除一律用记录自己的 id**（`dnsApi.update(editingId, …)` /
   *     `dnsApi.remove(record.id)`）—— update 的域名基准由服务端按该记录
   *     `subdomain_id` 现算（handlers/dns.ts 的 updateDns），前端传域名不但没用，
   *     还会改成别的域下的同名记录。所以 payload 里**不带** subdomainId / rootDomain。
   *   · **只有新建才需要明确目标域名**（`subdomainId` + `rootDomain`）——
   *     记录只能建在自己确实拥有的子域名下（服务端 assertFqdnOwned 会拒），
   *     「全部」视图下没有「当前域名」可依赖，必须由 createTarget 给出答案。
   */
  const handleSubmitDns = async () => {
    // 编辑：目标就是这条记录自己（openEditDns 与 editingId 一起设置，这里只是防御，
    // 真丢了就静默放弃 —— 弹一条「修改失败」会让人以为改动丢了）。
    // 新建：必须有一个**具体**的目标域名（一个可选域名都没有时为 null，见下方禁用）。
    if (editingId) {
      if (!editingRecord) return
    } else if (!createTarget) {
      toast.error(t("dm.err.noTargetDomain"))
      return
    }
    // SRV 不填「内容」（由 service/proto/权重/端口/目标推导），校验分开走
    if (form.type === "SRV") {
      if (!form.srvService.trim() || !form.srvPort.trim() || !form.srvTarget.trim()) {
        toast.error(t("dm.err.srvRequired"))
        return
      }
    } else if (!form.content) {
      // 记录名现在可以留空（2026-10-21）：留空与填 `@` 同义 = 直接挂在基准域名上，
      // 服务端按同一口径放开。所以这里只卡内容 ——
      // 再拿「名称不能为空」挡人，会和「填 @ 也行」自相矛盾。
      toast.error(t("dm.err.contentRequired"))
      return
    }
    setSaving(true)
    try {
      const payload = {
        name: form.name || "@",
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
        // 只带记录自己的 id 与记录内容：域名不在请求里，改不到别的域上去
        await dnsApi.update(editingId, payload)
        toast.success(t("dm.ok.recordUpdated"))
      } else {
        // 新建：归属子域名与 `rootDomain` 必须同步给出。
        // `rootDomain` 是给服务端做「声明的根域 vs 子域名实际根域」一致性校验用的
        // （见 handlers/dns.ts 的 ROOT_DOMAIN_MISMATCH），不传也能建，但传了才
        // 能挡住「前端选择器与实际子域对不上」这种不一致。
        await dnsApi.create({
          subdomainId: createTarget!.id,
          rootDomain: createTarget!.root,
          ...payload,
        })
        toast.success(t("dm.ok.recordCreated"))
        bumpRecordCount(createTarget!.id, 1)
        // 建到别的域名下时把筛选切过去，否则用户在「只看 A 域」的视图里
        // 看不到刚建在 B 域的那条，会以为「建了但没生效」。
        // 「全部」视图不用切 —— 它本来就看得见。
        if (activeFilter !== "all" && activeFilter !== createTarget!.id) {
          setDnsFilter(createTarget!.id)
        }
      }
      closeDnsDialog()
      reloadRecords()
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
    setEditingRecord(null)
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

  /**
   * 按**记录自己的归属**调整域名列表里的条数。
   *
   * 老数据 `subdomainId` 可能为空，那种情况下什么都不改 —— 拿「当前选中的域名」
   * 顶替只会把另一个域名的数字改错（跨域名视图下这是常态，不是边角）。
   */
  const bumpRecordCountOf = (r: DnsRecord, delta: number) => {
    if (r.subdomainId) bumpRecordCount(r.subdomainId, delta)
  }

  const handleDeleteDns = async (record: DnsRecord) => {
    setDeletingId(record.id)
    try {
      // ⚠️ 删除用记录自己的 id：服务端按它查出这条记录、按记录自己的域判权限与 zone。
      // 这里**不传**任何域名参数（接口也没有这个参数），所以「当前筛选的是哪个域」
      // 不可能影响删哪一条。
      await dnsApi.remove(record.id)
      toast.success(t("dm.ok.recordDeleted"))
      bumpRecordCountOf(record, -1)
      reloadRecords()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("dm.err.deleteFailed"))
    } finally {
      setDeletingId(null)
    }
  }

  // ---------- 批量删除 ----------
  // 切筛选后清空勾选并退出编辑模式：勾选只在当前这份列表内有效。
  // 依赖筛选（而不是上面选中的域名）：跨域名视图下两者已经不是一回事。
  React.useEffect(() => {
    setBatchSelected(new Set())
    setBatchSelecting(false)
  }, [activeFilter])

  /** 可勾选的记录：平台托管（managed）的没有删除入口，不进批量 */
  const deletableRecords = React.useMemo(() => records.filter((r) => !r.managed), [records])
  const deletableIds = React.useMemo(() => deletableRecords.map((r) => r.id), [deletableRecords])
  const allDeletableSelected =
    deletableIds.length > 0 && deletableIds.every((id) => batchSelected.has(id))

  const toggleBatchSelect = (id: string) => {
    setBatchSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleBatchSelectAll = () => {
    setBatchSelected((prev) => {
      const next = new Set(prev)
      if (allDeletableSelected) deletableIds.forEach((id) => next.delete(id))
      else deletableIds.forEach((id) => next.add(id))
      return next
    })
  }

  /** 退出编辑模式：清空勾选并隐藏勾选框（与邮箱页一致） */
  const exitBatchSelecting = () => {
    setBatchSelecting(false)
    setBatchSelected(new Set())
  }

  const confirmBatchDelete = async () => {
    if (batchSelected.size === 0) return
    setBatchBusy(true)
    let ok = 0
    let fail = 0
    try {
      for (const id of batchSelected) {
        try {
          await dnsApi.remove(id)
          ok++
        } catch {
          fail++
        }
      }
      setBatchDeleteOpen(false)
      setBatchSelected(new Set())
      setBatchSelecting(false)
      if (fail === 0) toast.success(t("dm.batch.deletedOk", { n: String(ok) }))
      else toast.warning(t("dm.batch.deletedPart", { ok: String(ok), fail: String(fail) }))
      // 每条按**自己的**归属域名改数字：批量列表在跨域名视图下可能横跨好几个域
      for (const r of records) {
        if (batchSelected.has(r.id)) bumpRecordCountOf(r, -1)
      }
      reloadRecords()
    } finally {
      setBatchBusy(false)
    }
  }

  // ---------- 批量添加 ----------
  const BATCH_TYPES = ["A", "AAAA", "CNAME", "TXT", "MX"]

  interface ParsedBatchLine {
    name: string
    type: string
    content: string
    priority?: number
    error?: string
  }

  const parsedBatch: ParsedBatchLine[] = React.useMemo(() => {
    return batchText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => {
        const parts = line.split(/\s+/)
        if (parts.length < 3) {
          return { name: line, type: "", content: "", error: t("dm.batch.lineError") }
        }
        const [name, rawType, ...rest] = parts
        const type = rawType.toUpperCase()
        if (!BATCH_TYPES.includes(type)) {
          return { name, type, content: rest.join(" "), error: t("dm.batch.badType", { type }) }
        }
        if (type === "SRV") {
          return { name, type, content: "", error: t("dm.batch.noSrv") }
        }
        // MX 允许第 4 段写优先级：`@ MX mail.example.com 20`
        let content = rest.join(" ")
        let priority: number | undefined
        if (type === "MX" && rest.length >= 2) {
          const maybePriority = Number(rest[rest.length - 1])
          if (Number.isInteger(maybePriority) && maybePriority >= 0 && maybePriority <= 65535) {
            priority = maybePriority
            content = rest.slice(0, -1).join(" ")
          }
        }
        return { name, type, content, priority }
      })
  }, [batchText, t])

  const batchValid = parsedBatch.filter((l) => !l.error)

  const submitBatchAdd = async () => {
    // 批量添加同样必须**明确目标域名**：整批建在同一个用户选定的域名下
    // （「全部」视图下没有「当前域名」可用，见 createTarget）。
    if (!createTarget || batchValid.length === 0) return
    setBatchBusy(true)
    let ok = 0
    let fail = 0
    try {
      for (const l of batchValid) {
        try {
          await dnsApi.create({
            subdomainId: createTarget.id,
            rootDomain: createTarget.root,
            name: l.name,
            type: l.type as DnsRecordType,
            content: l.content,
            ttl: 1,
            proxied: false,
            ...(l.type === "MX" ? { priority: l.priority ?? 10 } : {}),
          })
          ok++
        } catch {
          fail++
        }
      }
      setBatchAddOpen(false)
      setBatchText("")
      if (fail === 0) toast.success(t("dm.batch.addedOk", { n: String(ok) }))
      else toast.warning(t("dm.batch.addedPart", { ok: String(ok), fail: String(fail) }))
      bumpRecordCount(createTarget.id, ok)
      // 与单条新建同一处理：建到别的域名下时切过去，否则用户看不到刚建的那批
      if (activeFilter !== "all" && activeFilter !== createTarget.id) {
        setDnsFilter(createTarget.id)
      }
      reloadRecords()
    } finally {
      setBatchBusy(false)
    }
  }

  // 一级子域名（parentId 为空，含 '@' 主域名）
  const rootSubs = subdomains.filter((s) => !s.parentId)
  const childrenOf = (id: string) => subdomains.filter((s) => s.parentId === id)
  const canAddRoot = rootSubs.length < quota
  /**
   * DNS 记录数是否已达上限（服务端口径）。
   * `limit === null` = 不限（管理员 / 管理员 Key）⇒ 恒 false。
   * 未拿到用量（还没加载完）时也一律 false：宁可先让人点，也不要拿一个
   * 还没确认的数字去禁用按钮（服务端始终是最终裁判，真到顶了会返回
   * DNS_RECORD_LIMIT 并由 toast 说明）。
   */
  const atDnsLimit =
    dnsUsage !== null && dnsUsage.limit !== null && dnsUsage.used >= dnsUsage.limit
  /**
   * 「新建 / 修改」是否被禁用：到上限，或租用已到期（到期后只能删，不能再写）。
   * 删除**不**受这两者影响 —— 它是用户腾出额度、也是腾出 CF zone 配额的手段。
   */
  const writeDisabled = atDnsLimit || !canWriteDns

  /**
   * 「新建记录」的目标域名（弹窗里选中的那个）。
   *
   * 优先弹窗里明确选的；没选 / 选了个已不存在的就依次回落到
   * 「当前筛选的域名」→「域名列表里选中的域名」→ 第一个可用域名。
   * 兜底顺序刻意让**筛选视图**优先：用户在「只看 xxxxx.tyu.me」时点添加，
   * 想要的多半就是建在那个域下。
   *
   * 为什么这里必须算出一个**具体域名**而不能是「全部」：记录只能挂在自己拥有的
   * 子域名下（服务端 assertFqdnOwned 会拒），「全部」不是可以落记录的地方。
   */
  const createTarget = React.useMemo(() => {
    const pick = (id?: string | null) => recordDomainChoices.find((d) => d.id === id) ?? null
    return (
      pick(createDnsSub) ??
      pick(activeFilter === "all" ? null : activeFilter) ??
      pick(selected?.id) ??
      recordDomainChoices[0] ??
      null
    )
  }, [createDnsSub, recordDomainChoices, activeFilter, selected])

  /**
   * 当前筛选的域名**不是**一个可落记录的目标（它现在没有解析额度 / 权限）。
   *
   * 这时 createTarget 会回落到另一个域名，必须让用户看见 —— 否则他会以为记录建在
   * 正在看的那个域下（改造前是把选中的子域名直接发给服务端、由后端 403 明确报错，
   * 现在静默换域就更糟）。见下面 showCreateTargetPicker 与那段琥珀色提示。
   */
  const filterTargetUnusable = activeFilter !== "all" && createTarget?.id !== activeFilter

  /**
   * 新建记录时是否显示「域名」选择器：
   *   · 可选域名多于一个 —— 当然要能选；
   *   · 当前是「全部域名」视图 —— 哪怕只有一个可选域名也摆出来：这时没有
   *     「当前域名」可依赖，必须让用户**看见**记录将建在哪里；
   *   · 筛选的域名不可用（见 filterTargetUnusable）—— 同上，目标已经被换掉了。
   */
  const showCreateTargetPicker =
    !editingId &&
    recordDomainChoices.length > 0 &&
    (recordDomainChoices.length > 1 || activeFilter === "all" || filterTargetUnusable)

  /**
   * 记录名一律可留空（2026-10-21 起）。
   *
   * 留空 = 直接挂在基准域名上，与填 `@` 完全等价，服务端 `normalizeRecordName`
   * 走同一口径。原来这里还有个 `nameMayBeEmpty`，只在「基准是 '@' 主域名」时
   * 才允许留空 —— 那套判断的出发点是「名称不能为空」，现在前提变了（名称本来
   * 就可以空），留着只会让同一件事有两个说法。
   *
   * 弹窗里仍会实时预览 `实际记录：…`，所以留空造成的后果用户看得见。
   */

  /**
   * 弹窗里显示的记录基准域名。
   *
   * 编辑时取**这条记录自己的**归属域名（ownerFqdn）—— 跨域名列表下「当前筛选的
   * 域名」跟它没关系，用它会让弹窗显示错域名、用户以为自己改的是另一条。
   * 新建时取弹窗里选中的目标域名（createTarget），没有可选域名时退化成展示用的 ownDomain。
   */
  const base = editingId
    ? (editingRecord ? ownerFqdn(editingRecord) : ownDomain)
    : (createTarget?.fqdn ?? ownDomain)

  /**
   * 点域名列表里的某个域名：既让它成为「新建记录」的默认归属，也把 DNS 列表筛到它。
   *
   * 同步筛选是改造前就有的行为（点一个域名 = 看它的记录），保留下来才不别扭 ——
   * 只是现在多了一个「全部域名」可以退回去。⚠️ 它只影响**看哪些记录**，
   * 编辑/删除永远按记录自己的 id 走（见 handleSubmitDns）。
   */
  const selectSubdomain = (sub: Subdomain) => {
    setSelected(sub)
    setDnsFilter(sub.id)
  }

  return (
    <div>
      <PageHeader
        title={t("dm.title")}
        description={ownDomain}
      />

      {/* 两块功能拆成两个选项卡：子域名（人人可用）+ DNS 解析（积分租用）。
          ⚠️ 2026-10-14 起第二个选项卡**对所有人渲染** —— DNS 改成了明码标价的
          积分租用，入口藏起来等于让想买的人找不到地方；没买的人在面板里看到的是
          一张价目表（components/dns-rental-panel.tsx），而不是一个点不动的按钮。
          defaultValue 固定指向第一个选项卡：先看域名列表是这一页的主线。 */}
      <Tabs defaultValue="subdomain">
        <TabsList className="mb-4">
          <TabsTrigger value="subdomain">{t("dm.tab.subdomains")}</TabsTrigger>
          <TabsTrigger value="dns">{t("dm.tab.dns")}</TabsTrigger>
        </TabsList>

        <TabsContent value="subdomain">
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
                <DomainRecordsSkeleton />
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
                        onClick={() => selectSubdomain(sub)}
                        className={`group flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 transition-colors ${
                          selected?.id === sub.id ? "bg-accent" : "hover:bg-accent/50"
                        }`}
                      >
                        <button
                          type="button"
                          className="font-mono text-sm"
                          onClick={(e) => {
                            e.stopPropagation()
                            selectSubdomain(sub)
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
                          onClick={() => selectSubdomain(child)}
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
                              selectSubdomain(child)
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
        </TabsContent>

        {/* DNS 解析：租用价目 +（有额度时）记录管理。
            Radix 的 TabsContent 默认**按需挂载**（未选中即不渲染），
            所以不打开这个选项卡就不会产生任何 DNS 请求。 */}
        <TabsContent value="dns" className="space-y-6">
          {/* 已经有免费额度的（权限位 / 管理员 / **服务端判定的 full**）不显示价目面板 ——
              他们本来就不用买，摆一排「购买」按钮只会让人以为自己也要付钱。
              ⚠️ 判据必须是 access.showRentalPanel（= 档位非 full），不能只看 `hasFreeDns`：
              只看前端快照的话，免权限访问（open_features）的用户会一边看到
              「已开通额度」横幅、一边被藏掉整块记录界面（2026-10-16 paji 的故障）。
              例外：手上还有租约时照样显示（见 hasRentalsToManage —— 否则开着自动续费
              的人连「在哪关掉它」都找不到）。 */}
          {(access.showRentalPanel || hasRentalsToManage) && (
            <DnsRentalPanel
              state={dnsRental}
              loading={dnsRentalLoading}
              onChanged={loadDnsRental}
            />
          )}

          {/* 还没买（或买过但已到期且只想删记录）时不渲染记录界面：
              后端会 403，渲染出来只会是一堆报错。 */}
          {!canManageDns ? null : !selected ? (
            <EmptyState
              title={t("dm.selectTitle")}
              description={t("dm.selectDesc")}
            />
          ) : (
            <>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Globe className="h-4 w-4 text-muted-foreground" />
                  <h2 className="text-sm font-medium">{t("dm.recordsOf")}</h2>
                  {/* 域名筛选：默认「全部域名」，选某个域名 = 只看它的记录。
                      站长反馈（2026-10-16）：他 3 个子域名、记录都在其中一个下，
                      而列表原来看的只是「当前选中的域名」，于是显示 0 条、以为丢了。
                      默认全量 + 这个下拉，两个方向都能一眼看明白。 */}
                  <Select value={activeFilter} onValueChange={setDnsFilter}>
                    <SelectTrigger
                      className="h-8 w-[220px]"
                      aria-label={t("dm.dnsFilter.label")}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t("dm.dnsFilter.all")}</SelectItem>
                      {subdomains.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.fqdn}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {/* 条数口径（与筛选联动，别再写死「当前域名」）：
                      · 筛选到某个域名时，写「该域名 N 条解析」；
                      · 「全部」视图下**不**单独显示列表条数 —— 右边那句 dnsUsage
                        说的就是同一个数（跨全部域名的真实记录数），两个数字并排
                        只会让人怀疑哪个才是真的（列表还可能多出平台托管的派生项，
                        数字对不上时更没法解释）。 */}
                  {activeFilter !== "all" && (
                    <span className="text-xs text-muted-foreground">
                      {t("dm.recordsInDomain", { n: records.length })}
                    </span>
                  )}
                  {/* 账号级用量（跨该用户全部域名，服务端算好随列表下发）。
                      筛选视图下它与左边那个「该域名 N 条」口径不同 —— 一个是这个域、
                      一个是全账号合计，文案里都写清楚了，并排显示也不会误读。 */}
                  {dnsUsage && (
                    <span className="text-xs text-muted-foreground">
                      {dnsUsage.limit === null
                        ? t("dm.dnsUsage.admin", { used: dnsUsage.used })
                        : t("dm.dnsUsage", { used: dnsUsage.used, limit: dnsUsage.limit })}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {batchSelecting ? (
                    <>
                      <Button variant="outline" size="sm" onClick={toggleBatchSelectAll}>
                        <ListChecks className="mr-1 h-3.5 w-3.5" />
                        {allDeletableSelected ? t("dm.batch.deselectAll") : t("dm.batch.selectAll")}
                      </Button>
                      <span className="text-xs text-muted-foreground">
                        {t("dm.batch.selected", { n: String(batchSelected.size) })}
                      </span>
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={batchBusy || batchSelected.size === 0}
                        onClick={() => setBatchDeleteOpen(true)}
                      >
                        <Trash2 className="mr-1 h-3.5 w-3.5" />
                        {t("dm.batch.delete")}
                      </Button>
                      <Button variant="outline" size="sm" onClick={exitBatchSelecting}>
                        {t("common.cancel")}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={reloadRecords}
                        aria-label={t("common.refresh")}
                      >
                        <RefreshCw className="h-4 w-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        // 批量添加也受同一个上限约束（它就是一条条调 create）：
                        // 到顶时一并禁用，免得用户粘 20 行、逐条失败之后才从 toast 里知道原因。
                        // 同理，租用已到期时也禁用（那时连单条都建不了）。
                        // ⚠️ 没有任何可选域名（createTarget 为空）时也禁用：那样点开也建不了。
                        disabled={writeDisabled || !createTarget}
                        onClick={() => {
                          setBatchText("")
                          // 与单条新建同一套目标域名解析：批量也必须落在**明确的**域名下，
                          // 「全部」视图下没有「当前域名」可以依赖（见 createTarget）。
                          setCreateDnsSub(createTarget?.id ?? "")
                          setBatchAddOpen(true)
                        }}
                      >
                        {t("dm.batch.add")}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setBatchSelecting(true)}>
                        <Pencil className="mr-1 h-3.5 w-3.5" />
                        {t("common.edit")}
                      </Button>
                      <Button
                        size="sm"
                        // 到上限 / 租用已到期就禁用（服务端也会拒，这里是提前告知）。
                        // disabled 的按钮不触发 hover 提示，所以文案另外用下面那行 <p> 说明。
                        // 没有任何可选域名（createTarget 为空）时同样禁用 —— 记录必须
                        // 挂在自己拥有的子域名下，没有目标就无从建起。
                        disabled={writeDisabled || !createTarget}
                        onClick={() => {
                          // 明确走「新建」：清掉可能残留的编辑态，否则会误改成编辑上一条
                          setEditingId(null)
                          setEditingRecord(null)
                          resetForm()
                          // 目标域名取 createTarget（筛选中的域名 → 域名列表里选中的 →
                          // 第一个可用）；「全部」视图下它保证是一个**具体**的域名，
                          // 而不是一个没法落记录的「全部」
                          setCreateDnsSub(createTarget?.id ?? "")
                          setOpenDns(true)
                        }}
                      >
                        <Plus className="h-4 w-4" />
                        {t("dm.addRecord")}
                      </Button>
                    </>
                  )}
                </div>
              </div>

              {/* 到上限的明确提示：光禁用按钮不说原因，用户只会以为是页面坏了 */}
              {atDnsLimit && (
                <p className="mb-3 text-xs text-destructive">
                  {t("dm.dnsLimitReached", { limit: String(dnsUsage?.limit ?? "") })}
                </p>
              )}
              {/* 租用到期：与「到上限」是两回事，文案必须分开 ——
                  一个要删记录，一个要续费，让人看错会白折腾半天 */}
              {!canWriteDns && (
                <p className="mb-3 text-xs text-destructive">{t("dm.dnsRentalExpired")}</p>
              )}

              {records.length === 0 ? (
                // 空状态要分清两种「0 条」，否则又会误导人（站长这次就是这么被绕进去的）：
                //   · 筛到某个域名、但账号里其实有记录 ⇒ 说明白「其它域名下还有 N 条」
                //     并给一个一键切回「全部」的出口，而不是干巴巴一句「还没有 DNS 记录」；
                //   · 真的是一条都没有（全部视图下 0 条）⇒ 才是「还没有 DNS 记录」。
                // dnsUsage.used 是全账号真实记录数；筛选视图下列表为空时，那 N 条必然
                // 都在别的域名下，所以这里直接用它，不必再发一次请求。
                activeFilter !== "all" && (dnsUsage?.used ?? 0) > 0 ? (
                  <div className="space-y-3">
                    <EmptyState
                      title={t("dm.noRecordsHere")}
                      description={t("dm.elsewhere", { n: dnsUsage?.used ?? 0 })}
                    />
                    <div className="flex justify-center">
                      <Button variant="outline" size="sm" onClick={() => setDnsFilter("all")}>
                        <Globe className="mr-1 h-3.5 w-3.5" />
                        {t("dm.dnsFilter.viewAll")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <EmptyState
                    title={t("dm.noRecords")}
                    description={
                      activeFilter === "all"
                        ? t("dm.noRecordsDescAll")
                        : t("dm.noRecordsDesc")
                    }
                  />
                )
              ) : (
                <div className="rounded-lg border bg-card">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {batchSelecting && (
                          <TableHead className="w-10">
                            <input
                              type="checkbox"
                              aria-label={t("dm.batch.selectAll")}
                              className="h-4 w-4 accent-primary"
                              checked={allDeletableSelected}
                              onChange={toggleBatchSelectAll}
                            />
                          </TableHead>
                        )}
                        <TableHead>Name</TableHead>
                        {/* 归属域名列（跨域名列表的必要信息）：
                            一屏里混着好几个子域名的记录，没有它用户分不清哪条是谁的 ——
                            站长「记录丢了」的观感正是由此而来。 */}
                        <TableHead>Domain</TableHead>
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
                          {batchSelecting && (
                            <TableCell>
                              {!r.managed && (
                                <input
                                  type="checkbox"
                                  // 无障碍名带上归属域名：跨域名列表里同名记录不止一条
                                  aria-label={`${r.name} (${ownerFqdn(r)})`}
                                  className="h-4 w-4 accent-primary"
                                  checked={batchSelected.has(r.id)}
                                  onChange={() => toggleBatchSelect(r.id)}
                                />
                              )}
                            </TableCell>
                          )}
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
                          {/* 归属域名取记录**自己**的（ownerFqdn），不是当前筛选的那个 ——
                              编辑/删除也一律按这个归属走，见 handleSubmitDns */}
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {ownerFqdn(r)}
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
                                  // 租用到期后只能删、不能改（改记录是「写」能力）
                                  disabled={!canWriteDns}
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
        </TabsContent>
      </Tabs>

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

      {/* 批量删除确认 */}
      <Dialog open={batchDeleteOpen} onOpenChange={setBatchDeleteOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("dm.batch.deleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("dm.batch.deleteDesc", { n: String(batchSelected.size) })}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border bg-muted/40 p-2">
            {records
              .filter((r) => batchSelected.has(r.id))
              .map((r) => (
                // 带上归属域名：跨域名列表里两条同名记录（如各自的 '@'）光看名字分不清谁是谁
                <p key={r.id} className="font-mono text-xs">
                  {r.name} · {ownerFqdn(r)} · {r.type} {r.content}
                </p>
              ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchDeleteOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="destructive" disabled={batchBusy} onClick={() => void confirmBatchDelete()}>
              {batchBusy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {t("dm.batch.deleteConfirm", { n: String(batchSelected.size) })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 批量添加 */}
      <Dialog open={batchAddOpen} onOpenChange={setBatchAddOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("dm.batch.addTitle")}</DialogTitle>
            <DialogDescription>
              {t("dm.batch.addDesc", { fqdn: createTarget?.fqdn ?? "" })}
            </DialogDescription>
          </DialogHeader>
          {/* 目标域名：与单条新建同一个选择器与同一个 state（createTarget）。
              批量同样是「写」，必须落在**明确的**域名下 —— 「全部」视图下没有
              「当前域名」可以默认，所以这里也要能选（见 createTarget 的兜底顺序）。 */}
          {recordDomainChoices.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="dnsBatchRoot">{t("dm.dnsRoot")}</Label>
              <Select
                value={createTarget?.id ?? ""}
                onValueChange={setCreateDnsSub}
              >
                <SelectTrigger id="dnsBatchRoot">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {recordDomainChoices.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.fqdn}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="dm-batch-text">{t("dm.batch.addLabel")}</Label>
            <Textarea
              id="dm-batch-text"
              rows={8}
              className="font-mono text-xs"
              placeholder={t("dm.batch.addPlaceholder")}
              value={batchText}
              onChange={(e) => setBatchText(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">{t("dm.batch.addHint")}</p>
          </div>
          {parsedBatch.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium">
                {t("dm.batch.preview", {
                  ok: String(batchValid.length),
                  fail: String(parsedBatch.length - batchValid.length),
                })}
              </p>
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border bg-muted/40 p-2">
                {parsedBatch.map((l, i) => (
                  <p key={i} className={`font-mono text-xs ${l.error ? "text-destructive" : ""}`}>
                    {l.error ? `✕ ${l.name} — ${l.error}` : `✓ ${l.name} ${l.type} ${l.content}`}
                  </p>
                ))}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchAddOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button disabled={batchBusy || batchValid.length === 0} onClick={() => void submitBatchAdd()}>
              {batchBusy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {t("dm.batch.addConfirm", { n: String(batchValid.length) })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
            {/* 建在哪个**域名**下（2026-10-14 站长要求）。
                DNS 改成按根域计的积分租用后，「记录落在哪个域」必须能明着选，
                而不是只能悄悄用注册时分到的那个域。
                只列**我名下的子域名**（含二级，每个都属于某个根域），因为记录必须挂在
                用户确实拥有的子域名下（见 recordDomainChoices 的注释）：
                列根域再拼一个 `用户名.<根域>`，拼出来的是用户并不拥有的 fqdn，必然 403。
                显示条件（见 showCreateTargetPicker）：
                  · 编辑时**不显示**（改域名等于换一条记录，后端按原 base 重建）——
                    改为在弹窗说明里写出这条记录自己的域名（base）；
                  · 新建且可选域名多于一个 —— 当然要能选；
                  · 新建且当前是「全部域名」视图 —— 哪怕只有一个可选域名也显示出来：
                    这时没有「当前域名」可依赖，必须让用户**看见**记录将建在哪里
                    （2026-10-16：目标域名由 createTarget 兜底选中，这里负责可见）；
                  · 新建且当前筛选的域名不可用（没额度）—— 目标已被换到别的域名，
                    更要摆出来，不能让用户在不知情的情况下建到另一个域下。 */}
            {showCreateTargetPicker && (
              <div className="space-y-2">
                <Label htmlFor="dnsRoot">{t("dm.dnsRoot")}</Label>
                <Select
                  value={createTarget?.id ?? ""}
                  onValueChange={setCreateDnsSub}
                >
                  <SelectTrigger id="dnsRoot">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {recordDomainChoices.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.fqdn}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{t("dm.dnsRootHint")}</p>
                {/* 目标域名是**替用户默认选好的**，明说一句，免得他以为记录会
                    「自动落到某个域」：全部视图下没有「当前域名」，
                    筛选的域名又可能因为没有额度而落选。 */}
                {activeFilter === "all" && createTarget && (
                  <p className="text-xs text-amber-600 dark:text-amber-500">
                    {t("dm.dnsRootAllHint", { fqdn: createTarget.fqdn })}
                  </p>
                )}
                {filterTargetUnusable && createTarget && (
                  <p className="text-xs text-amber-600 dark:text-amber-500">
                    {t("dm.dnsRootOtherHint", { fqdn: createTarget.fqdn })}
                  </p>
                )}
              </div>
            )}

            {form.type !== "SRV" ? (
              <div className="space-y-2">
                <Label htmlFor="name">{t("dm.recordName")}</Label>
                <div className="flex items-center gap-1">
                  <Input
                    id="name"
                    // `@` / 留空 都表示「直接挂在基准域名上」（服务端 normalizeRecordName 同口径）
                    placeholder={t("dm.namePh")}
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    className="flex-1"
                  />
                  {/* 填 @ / 留空时，记录名就是域名本身，不该再拖一个尾缀 */}
                  {!isApexName(form.name) && (
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      .{base}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("dm.actualRecord")}
                  <span className="font-mono">
                    {isApexName(form.name) ? base : `${form.name.trim()}.${base}`}
                  </span>
                </p>
                {/* 把「@ 到底建在哪」说死：否则用户只能靠猜，或以为 @ 会被原样当成前缀 */}
                <p className="text-xs text-muted-foreground">
                  {t("dm.nameApexHint", { fqdn: base })}
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