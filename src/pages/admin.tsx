import * as React from "react"
import { Link } from "react-router-dom"
import {
  Ban,
  KeyRound,
  Loader2,
  Ticket,
  Pencil,
  Plus,
  Megaphone,
  Database,
  RefreshCw,
  Search,
  ShieldBan,
  SlidersHorizontal,
  Network,
  Zap,
  CheckCircle2,
  XCircle,
  Trash2,
  UserCheck,
  Users,
  Heart,
  MessagesSquare,
  RotateCcw,
  PlugZap,
  X,
  Sparkles,
  Unplug,
  AlertCircle,
  BarChart3,
  ArrowLeft,
  ExternalLink,
} from "lucide-react"
import { toast } from "sonner"

// OAuth 应用的 UI 本体单独放一个文件，避免继续撑大本文件
// （本文件已 4500+ 行，且可能有其他改动同时在动它）。
import { OAuthAdminPanel } from "./admin-oauth"
import { AnalyticsPanel } from "./admin-analytics"

import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { Textarea } from "@/components/ui/textarea"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip"
import { LoadingBlock } from "@/components/loading-block"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
  Tabs,
  TabsContent,
} from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  adminApi,
  announcementApi,
  donationApi,
  r2AdminApi,
  wb2apiApi,
  HttpError,
} from "@/services/api"
import { useAuth } from "@/hooks/use-auth"
/**
 * 可授权的功能（与后端 permissions.ts 的 FEATURES 保持一致）。
 * ⚠️ 不含「个人名片」：名片不消耗资源，已从权限体系移出、全量开放，
 * 因此创建/编辑邀请码与成员详情里都不再出现名片开关。
 */
const FEATURES: { key: FeatureKey; label: string; desc: string }[] = [
  { key: "r2", label: "直链网盘", desc: "R2 存储与直链分享" },
  { key: "ai", label: "AI 中转站", desc: "NewAPI 账号与 API Key" },
  { key: "frp", label: "内网穿透", desc: "frp 隧道申请" },
  { key: "proxy", label: "代理节点", desc: "代理订阅与节点" },
]

import type {
  AdminFrpApplication,
  AdminFrpNode,
  AdminInviteQuotasResponse,
  AdminUserInviteQuotaResponse,
  FeatureCounts,
  Donation,
  ReservedSubdomain,
  Announcement,
  R2Bucket,
  R2BucketsResponse,
  R2Operations,
  AdminInvite,
  AdminProxySubscription,
  AdminSettings,
  AdminUser,
  AdminUserDetail,
  FeatureKey,
  MailMessage,
  Permissions,
  AdminCommunityPost,
  AdminNewApiConfig,
  AdminWb2ApiConfig,
  AdminWb2ApiBinding,
  AdminWb2ApiPool,
  RecommendedTier,
} from "@/types"
import { FEATURE_LABELS } from "@/types"

/** 与 Worker 端 settings.ts 的 formatBytes 保持一致 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/** 管理面板左侧导航的单个项 */
function NavItem({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean
  icon: React.ComponentType<{ className?: string }>
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors " +
        (active
          ? "bg-accent font-medium text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground")
      }
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  )
}

/** 管理面板左侧导航的分组（带小标题 + 分隔） */
function NavGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-3 first:mt-0">
      <p className="mb-1 px-2.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">
        {label}
      </p>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  )
}

/** realm（cn/global）→ 中文标签 */
function realmLabel(realm: string | null | undefined): string {
  if (realm === "global") return "国际版"
  if (realm === "cn") return "国内版"
  return "未知"
}

/** 用户列表里的布尔列：开通打勾，未开通画叉（居中对齐，无多余留白） */
function BoolMark({ on, title }: { on: boolean; title?: string }) {
  return (
    <span
      className="inline-flex items-center justify-center"
      title={title ?? (on ? "已开通" : "未开通")}
    >
      {on ? (
        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
      ) : (
        <XCircle className="h-4 w-4 text-muted-foreground/40" />
      )}
    </span>
  )
}

/** 名片的公开访问地址：绑了自定义域名优先，否则回落到 /profile/<slug> */
function profilePublicUrl(slug: string | null, fqdn: string | null): string | null {
  if (fqdn) return `https://${fqdn}`
  if (slug) return `${window.location.origin}/profile/${encodeURIComponent(slug)}`
  return null
}

export default function AdminPage() {
  const { user } = useAuth()
  const [users, setUsers] = React.useState<AdminUser[]>([])
  const [filter, setFilter] = React.useState("")
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  // 管理面板当前激活的 tab（受控，供「更多」下拉切换）
  const [activeTab, setActiveTab] = React.useState("users")

  const [detail, setDetail] = React.useState<AdminUserDetail | null>(null)
  const [detailUser, setDetailUser] = React.useState<string>("")
  const [openedMessage, setOpenedMessage] = React.useState<MailMessage | null>(null)

  // 邀请码
  const [invites, setInvites] = React.useState<AdminInvite[]>([])
  const [inviteLoading, setInviteLoading] = React.useState(false)
  const [inviteOpen, setInviteOpen] = React.useState(false)
  const [inviteCode, setInviteCode] = React.useState("")
  const [inviteMax, setInviteMax] = React.useState("1")
  const [inviteBusy, setInviteBusy] = React.useState(false)
  const [invitePerms, setInvitePerms] = React.useState<Permissions>({
    r2: true,
    ai: true,
    frp: true,
    proxy: true,
  })

  // 子域名配额编辑
  const [quotaDraft, setQuotaDraft] = React.useState<string | null>(null)
  const [globalQuota, setGlobalQuota] = React.useState(5)
  const [subQuota, setSubQuota] = React.useState("5")

  // 用户详情里的昵称编辑（与配额一样先存草稿，点保存才提交）
  const [nickDraft, setNickDraft] = React.useState("")

  // 编辑邀请码权限
  const [permInvite, setPermInvite] = React.useState<AdminInvite | null>(null)
  const [permDraft, setPermDraft] = React.useState<Permissions | null>(null)
  const [permBusy, setPermBusy] = React.useState(false)

  // 用户邀请码额度
  const [inviteQuotas, setInviteQuotas] =
    React.useState<AdminInviteQuotasResponse | null>(null)
  const [inviteQuotaLoading, setInviteQuotaLoading] = React.useState(false)
  const [quotaDetail, setQuotaDetail] =
    React.useState<AdminUserInviteQuotaResponse | null>(null)
  const [quotaDetailBusy, setQuotaDetailBusy] = React.useState(false)

  // 保留子域名
  const [reserved, setReserved] = React.useState<ReservedSubdomain[]>([])
  const [reservedLoading, setReservedLoading] = React.useState(false)
  const [reservedName, setReservedName] = React.useState("")
  const [reservedNote, setReservedNote] = React.useState("")
  const [reservedBusy, setReservedBusy] = React.useState(false)
  // 昵称保留词（与保留域名同页管理）
  const [nickReserved, setNickReserved] = React.useState<string[]>([])
  const [nickReservedInput, setNickReservedInput] = React.useState("")
  const [nickReservedBusy, setNickReservedBusy] = React.useState(false)

  // 公告 / 网站动态
  const [announcements, setAnnouncements] = React.useState<Announcement[]>([])
  const [announcementLoading, setAnnouncementLoading] = React.useState(false)
  const [announcementOpen, setAnnouncementOpen] = React.useState(false)
  const [announcementBusy, setAnnouncementBusy] = React.useState(false)
  const [annDraft, setAnnDraft] = React.useState<{
    id: string | null
    title: string
    body: string
    category: string
    pinned: boolean
    popupMode: "none" | "once" | "every"
  }>({ id: null, title: "", body: "", category: "general", pinned: false, popupMode: "none" })

  // R2 多桶管理
  const [r2Data, setR2Data] = React.useState<R2BucketsResponse | null>(null)
  const [r2Loading, setR2Loading] = React.useState(false)
  const [r2Ops, setR2Ops] = React.useState<Record<string, R2Operations>>({})
  const [r2BucketOpen, setR2BucketOpen] = React.useState(false)
  const [r2Busy, setR2Busy] = React.useState(false)
  /** 正在编辑的桶 id；null = 新建 */
  const [r2EditId, setR2EditId] = React.useState<string | null>(null)
  const [r2Draft, setR2Draft] = React.useState({
    id: "",
    name: "",
    accountId: "",
    endpoint: "",
    bucketName: "",
    accessKeyId: "",
    secretAccessKey: "",
    analyticsToken: "",
    maxUsers: "8",
    quotaPerUser: "1073741824",
    sortOrder: "0",
    kind: "user",
  })
  /** 用户改派：{ 用户名: 目标桶 id } 的临时选择 */
  const [assignTarget, setAssignTarget] = React.useState<Record<string, string>>({})
  /** 自动发现的账户与桶（用全局 token 拉取） */
  const [r2Discovered, setR2Discovered] = React.useState<{
    available: boolean
    reason?: string
    accounts: {
      id: string
      name: string
      buckets: { name: string; createdAt: string | null; imported: boolean }[]
    }[]
  } | null>(null)
  const [r2DiscoverLoading, setR2DiscoverLoading] = React.useState(false)
  /** 选中的「账户|桶名」组合 */
  const [r2Pick, setR2Pick] = React.useState("")

  // 全局设置
  const [settingsStats, setSettingsStats] =
    React.useState<AdminSettings["stats"] | null>(null)
  const [settingsLoading, setSettingsLoading] = React.useState(false)
  const [settingsBusy, setSettingsBusy] = React.useState(false)
  const [quotaGb, setQuotaGb] = React.useState("1")
  const [maxFileMb, setMaxFileMb] = React.useState("100")
  const [storageEnabled, setStorageEnabled] = React.useState(true)
  const [trialQuotaUsd, setTrialQuotaUsd] = React.useState("1")
  /** NewAPI quota ↔ 金额换算率（由服务端 newapi_quota_per_unit 提供） */
  const [quotaPerUnit, setQuotaPerUnit] = React.useState(500000)
  /** 展示币种符号，跟随 NewAPI 站点设置 */
  const [currencySymbol, setCurrencySymbol] = React.useState("$")
  const [newapiGroup, setNewapiGroup] = React.useState("default")
  const [newapiUnlimited, setNewapiUnlimited] = React.useState(false)
  const [newapiEnabled, setNewapiEnabled] = React.useState(true)
  /** 推荐模型分档（管理员维护，用户在 AI 页看到的就是这份） */
  const [recommendedTiers, setRecommendedTiers] = React.useState<RecommendedTier[]>([])
  /** 候选模型名（来自中转站 pricing），用于「添加模型」下拉 */
  const [modelOptions, setModelOptions] = React.useState<string[]>([])

  // ---- 中转站管理员凭据（令牌轮换后可在网页更新）----
  const [newapiCred, setNewapiCred] = React.useState<AdminNewApiConfig | null>(null)
  const [newapiCredLoading, setNewapiCredLoading] = React.useState(false)
  const [newapiCredBusy, setNewapiCredBusy] = React.useState(false)
  /** 待更新的新令牌（明文只存在于当前输入框，提交后立即清空） */
  const [newapiNewToken, setNewapiNewToken] = React.useState("")
  const [newapiUserId, setNewapiUserId] = React.useState("1")

  // ---- WorkBuddy 反代账号捐献（登录即解锁 AI 权限）----
  const [wb2apiConfig, setWb2apiConfig] = React.useState<AdminWb2ApiConfig | null>(null)
  const [wb2apiBindings, setWb2apiBindings] = React.useState<AdminWb2ApiBinding[]>([])
  const [wb2apiPool, setWb2apiPool] = React.useState<AdminWb2ApiPool | null>(null)
  const [wb2apiLoading, setWb2apiLoading] = React.useState(false)
  const [wb2apiBusy, setWb2apiBusy] = React.useState(false)
  /** 待更新的网关访问密钥（明文只在输入框，提交后立即清空） */
  const [wb2apiNewKey, setWb2apiNewKey] = React.useState("")
  /** 移除确认弹窗：记录待摘的绑定 + 是否同时收回 ai 权限 */
  const [wb2apiRemoving, setWb2apiRemoving] = React.useState<AdminWb2ApiBinding | null>(null)
  const [wb2apiRevokeAi, setWb2apiRevokeAi] = React.useState(false)
  /** 通道开关与限额（走全局设置接口，与其它开关一起保存） */
  const [wb2apiEnabled, setWb2apiEnabled] = React.useState(true)
  const [wb2apiMaxBindings, setWb2apiMaxBindings] = React.useState("3")
  const [wb2apiBaseUrl, setWb2apiBaseUrl] = React.useState("")
  const [wb2apiRealm, setWb2apiRealm] = React.useState<"cn" | "global">("cn")
  const [frpEnabled, setFrpEnabled] = React.useState(true)
  const [frpCoreUrl, setFrpCoreUrl] = React.useState("")
  const [frpNotifyEmail, setFrpNotifyEmail] = React.useState("")
  const [notifyEmailOptions, setNotifyEmailOptions] = React.useState<string[]>([])
  // 临时分享箱
  const [tempboxEnabled, setTempboxEnabled] = React.useState(true)
  const [tempboxMinutes, setTempboxMinutes] = React.useState("30")
  const [tempboxMaxFileMb, setTempboxMaxFileMb] = React.useState("256")
  const [tempboxMaxFiles, setTempboxMaxFiles] = React.useState("20")
  const [tempboxUploadLogin, setTempboxUploadLogin] = React.useState(true)
  // 邀请码模块权限：基础权限（不消耗额度）vs 受限模式
  const [inviteBasic, setInviteBasic] = React.useState<Record<string, boolean>>({
    r2: true,
    ai: false,
    frp: false,
    proxy: false,
  })
  // 免权限访问：打开后该模块不再要求用户权限（没有权限的人也能用）
  const [openFeatures, setOpenFeatures] = React.useState<Record<string, boolean>>({
    r2: false,
    ai: false,
    frp: false,
    proxy: false,
  })
  // 自动审核：打开后该模块的捐献提交即自动审核（r2 没有捐献，不在列表里）
  const [autoReview, setAutoReview] = React.useState<Record<string, boolean>>({
    ai: true,
    frp: false,
    proxy: true,
  })

  // ---- 社区管理 ----
  const [communityPosts, setCommunityPosts] = React.useState<AdminCommunityPost[]>([])
  const [communityLoading, setCommunityLoading] = React.useState(false)
  const [communityShowDeleted, setCommunityShowDeleted] = React.useState(false)
  const [communityUserFilter, setCommunityUserFilter] = React.useState("")
  // 社区广场设置
  const [communityEnabled, setCommunityEnabled] = React.useState(true)
  const [communityGuestAccess, setCommunityGuestAccess] = React.useState(true)
  const [communityPostMaxImages, setCommunityPostMaxImages] = React.useState("9")
  const [communityImageMaxKb, setCommunityImageMaxKb] = React.useState("1024")

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await adminApi.listUsers()
      setUsers(res.users)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "加载用户失败")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const loadInvites = React.useCallback(async () => {
    setInviteLoading(true)
    try {
      const res = await adminApi.listInvites()
      setInvites(res.invites)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "加载邀请码失败")
    } finally {
      setInviteLoading(false)
    }
  }, [])

  const handleCreateInvite = async () => {
    setInviteBusy(true)
    try {
      await adminApi.createInvite({
        code: inviteCode,
        maxUses: Number(inviteMax) || 1,
        permissions: invitePerms,
      })
      toast.success("邀请码已创建")
      setInviteCode("")
      setInviteMax("1")
      setInviteOpen(false)
      void loadInvites()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "创建失败")
    } finally {
      setInviteBusy(false)
    }
  }

  const handleDeleteInvite = async (invite: AdminInvite) => {
    try {
      await adminApi.deleteInvite(invite.id)
      toast.success("邀请码已删除")
      void loadInvites()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "删除失败")
    }
  }

  // ---- frp 内网穿透审核 ----

  const [frpApps, setFrpApps] = React.useState<AdminFrpApplication[]>([])
  const [frpNodes, setFrpNodes] = React.useState<AdminFrpNode[]>([])
  const [frpLoading, setFrpLoading] = React.useState(false)
  const [frpBusy, setFrpBusy] = React.useState(false)
  const [frpStatus, setFrpStatus] = React.useState("pending")
  const [frpNote, setFrpNote] = React.useState("")
  const [nodeOpen, setNodeOpen] = React.useState(false)
  const [nodeForm, setNodeForm] = React.useState({
    id: "",
    name: "",
    region: "",
    serverAddr: "",
    serverPort: "7000",
    authToken: "",
    portMin: "20000",
    portMax: "50000",
    maxPorts: "5",
    note: "",
    status: "unknown",
    statusNote: "",
  })

  // ---- 捐献审核 ----
  const [donations, setDonations] = React.useState<Donation[]>([])
  const [donationLoading, setDonationLoading] = React.useState(false)
  const [donationBusy, setDonationBusy] = React.useState(false)
  // 待审核目标 + 理由弹窗
  const [reviewTarget, setReviewTarget] = React.useState<{
    donation: Donation
    action: "approve" | "reject"
  } | null>(null)
  const [reviewNote, setReviewNote] = React.useState("")

  const loadDonations = React.useCallback(async () => {
    setDonationLoading(true)
    try {
      const res = await donationApi.listAll()
      setDonations(res.donations)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "加载捐献申请失败")
    } finally {
      setDonationLoading(false)
    }
  }, [])

  const handleReviewDonation = async (
    d: Donation,
    action: "approve" | "reject"
  ) => {
    // 打开理由弹窗，由用户在弹窗里填理由后确认
    setReviewNote("")
    setReviewTarget({ donation: d, action })
  }

  const confirmReview = async () => {
    if (!reviewTarget) return
    setDonationBusy(true)
    try {
      await donationApi.review(
        reviewTarget.donation.id,
        reviewTarget.action,
        reviewNote.trim() || undefined
      )
      toast.success(
        reviewTarget.action === "approve"
          ? `已通过，${reviewTarget.donation.username} 的对应功能已解锁`
          : "已拒绝，结果已邮件通知申请人"
      )
      setReviewTarget(null)
      setReviewNote("")
      await loadDonations()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "操作失败")
    } finally {
      setDonationBusy(false)
    }
  }

  /** 撤销已审核的捐献：回到待审核，若权限因此捐献获得则自动收回 */
  const handleRevokeDonation = async (d: Donation) => {
    const extra =
      d.type === "ai"
        ? "，并把它接入中转站的渠道删掉"
        : d.type === "proxy"
          ? "，并把它导入节点池的订阅源移出去"
          : ""
    if (!confirm(`撤销「${d.username}」的捐献审核？\n\n撤销后回到待审核；若该捐献授予过权限，会自动收回${extra}。`)) return
    setDonationBusy(true)
    try {
      const res = await donationApi.revoke(d.id)
      const parts = [res.revokedPermission ? "已撤销并收回权限" : "已撤销（该捐献未授予新权限）"]
      if (res.releasedChannel) parts.push("中转站渠道已删除")
      if (res.releasedSubscriptions) parts.push(`已移出 ${res.releasedSubscriptions} 个订阅源`)
      toast.success(parts.join("，"))
      await loadDonations()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "操作失败")
    } finally {
      setDonationBusy(false)
    }
  }

  /**
   * 人工复核：用原始 payload 重试接入中转站。
   *
   * 不改单据状态 —— 接入成功后管理员再点「复核通过」放行，
   * 那时审核会复用刚建好的渠道，不会重复创建。
   */
  const handleProvisionDonation = async (d: Donation) => {
    setDonationBusy(true)
    try {
      const res = await donationApi.provision(d.id)
      if (res.ok) {
        toast.success(res.detail ? `渠道已接入：${res.detail}` : "渠道已接入中转站")
      } else {
        toast.error(res.detail || res.message || "接入失败")
      }
      await loadDonations()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "接入失败")
    } finally {
      setDonationBusy(false)
    }
  }

  const loadFrp = React.useCallback(async () => {
    setFrpLoading(true)
    try {
      const [apps, nodes] = await Promise.all([
        adminApi.listFrpApplications(frpStatus),
        adminApi.listFrpNodes(),
      ])
      setFrpApps(apps.applications)
      setFrpNodes(nodes.nodes)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "加载失败")
    } finally {
      setFrpLoading(false)
    }
  }, [frpStatus])

  const handleReview = async (
    app: AdminFrpApplication,
    action: "approve" | "reject"
  ) => {
    setFrpBusy(true)
    try {
      await adminApi.reviewFrp({ id: app.id, action, note: frpNote })
      toast.success(
        action === "approve"
          ? `已通过，结果已邮件通知 ${app.notifyEmail}`
          : `已拒绝，结果已邮件通知 ${app.notifyEmail}`
      )
      setFrpNote("")
      await loadFrp()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "操作失败")
    } finally {
      setFrpBusy(false)
    }
  }

  const handleSaveNode = async () => {
    setFrpBusy(true)
    try {
      await adminApi.upsertFrpNode({
        id: nodeForm.id || undefined,
        name: nodeForm.name,
        region: nodeForm.region,
        serverAddr: nodeForm.serverAddr,
        serverPort: Number(nodeForm.serverPort),
        authToken: nodeForm.authToken,
        portMin: Number(nodeForm.portMin),
        portMax: Number(nodeForm.portMax),
        maxPorts: Number(nodeForm.maxPorts),
        note: nodeForm.note,
        status: nodeForm.status,
        statusNote: nodeForm.statusNote,
      })
      toast.success("节点已保存")
      setNodeOpen(false)
      await loadFrp()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "保存失败")
    } finally {
      setFrpBusy(false)
    }
  }

  const handleDeleteNode = async (id: string) => {
    try {
      await adminApi.deleteFrpNode(id)
      toast.success("节点已删除")
      await loadFrp()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "删除失败")
    }
  }

  // ---- 代理节点订阅源 ----

  const [proxySubs, setProxySubs] = React.useState<AdminProxySubscription[]>([])
  const [proxyLoading, setProxyLoading] = React.useState(false)
  const [proxyBusy, setProxyBusy] = React.useState(false)
  const [proxyOpen, setProxyOpen] = React.useState(false)
  const [proxyForm, setProxyForm] = React.useState({
    id: "",
    name: "",
    region: "",
    url: "",
    protocol: "mixed",
    status: "unknown",
    statusNote: "",
    enabled: true,
    sortOrder: "0",
    note: "",
  })

  const loadProxy = React.useCallback(async () => {
    setProxyLoading(true)
    try {
      const res = await adminApi.listProxySubscriptions()
      setProxySubs(res.subscriptions)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "加载订阅源失败")
    } finally {
      setProxyLoading(false)
    }
  }, [])

  const handleSaveProxy = async () => {
    setProxyBusy(true)
    try {
      await adminApi.upsertProxySubscription({
        id: proxyForm.id || undefined,
        name: proxyForm.name,
        region: proxyForm.region,
        url: proxyForm.url,
        // 协议/状态留空时交给服务端自动识别
        protocol: proxyForm.protocol.trim() || undefined,
        status: proxyForm.status === "unknown" ? undefined : proxyForm.status,
        statusNote: proxyForm.statusNote,
        enabled: proxyForm.enabled,
        sortOrder: Number(proxyForm.sortOrder),
        note: proxyForm.note,
      })
      toast.success("订阅源已保存")
      setProxyOpen(false)
      await loadProxy()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "保存失败")
    } finally {
      setProxyBusy(false)
    }
  }

  const handleDeleteProxy = async (id: string) => {
    try {
      await adminApi.deleteProxySubscription(id)
      toast.success("订阅源已删除")
      await loadProxy()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "删除失败")
    }
  }

  // ---- 社区管理 ----

  const loadCommunity = React.useCallback(async () => {
    setCommunityLoading(true)
    try {
      const res = await adminApi.listCommunityPosts({ includeDeleted: communityShowDeleted, user: communityUserFilter || undefined })
      setCommunityPosts(res.posts)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "加载失败")
    } finally {
      setCommunityLoading(false)
    }
  }, [communityShowDeleted, communityUserFilter])

  const handleDeleteCommunityPost = async (id: string) => {
    try {
      await adminApi.deleteCommunityPost(id)
      toast.success("帖子已删除")
      await loadCommunity()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "删除失败")
    }
  }

  const handleRestoreCommunityPost = async (id: string) => {
    try {
      await adminApi.restoreCommunityPost(id)
      toast.success("帖子已恢复")
      await loadCommunity()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "恢复失败")
    }
  }

  // ---- 全局设置 ----

  const loadSettings = React.useCallback(async () => {
    setSettingsLoading(true)
    try {
      const res = await adminApi.getSettings()
      setSettingsStats(res.stats)
      if (res.currency?.symbol) setCurrencySymbol(res.currency.symbol)
      const s = res.settings
      const quotaBytes = Number(s.storage_quota_bytes ?? 1073741824)
      // 字节 → GB（按 GiB 换算，与后端一致）
      setQuotaGb(String(Math.round((quotaBytes / 1024 / 1024 / 1024) * 100) / 100))
      setMaxFileMb(
        String(Math.round(Number(s.storage_max_file_bytes ?? 104857600) / 1024 / 1024))
      )
      setStorageEnabled(s.storage_enabled === "1")
      const perUnit = Number(s.newapi_quota_per_unit ?? 500000)
      // 记下服务端的换算率：保存时要按同一比率换算回去，
      // 否则改了 quota_per_unit 后「显示 $X」再保存会写成另一个额度
      setQuotaPerUnit(perUnit)
      setTrialQuotaUsd(
        String(
          Math.round((Number(s.newapi_trial_quota ?? 500000) / perUnit) * 10000) /
            10000
        )
      )
      setNewapiGroup(s.newapi_group ?? "default")
      setNewapiUnlimited(s.newapi_unlimited_quota === "1")
      setNewapiEnabled(s.newapi_enabled === "1")
      // 反代账号捐献通道
      setWb2apiEnabled(s.wb2api_enabled === "1")
      setWb2apiMaxBindings(s.wb2api_max_bindings ?? "3")
      setWb2apiBaseUrl(s.wb2api_base_url ?? "")
      setWb2apiRealm(s.wb2api_realm === "global" ? "global" : "cn")
      // 推荐模型分档：坏 JSON 一律当空，不能让一个脏设置项把整个设置页打崩
      try {
        const parsed = JSON.parse(s.newapi_recommended_models ?? "[]")
        setRecommendedTiers(Array.isArray(parsed) ? (parsed as RecommendedTier[]) : [])
      } catch {
        setRecommendedTiers([])
      }
      setGlobalQuota(Number(s.subdomain_quota_default ?? 5))
      setSubQuota(s.subdomain_quota_default ?? "5")
      setFrpEnabled(s.frp_enabled === "1")
      setFrpCoreUrl(s.frp_core_url ?? "")
      setFrpNotifyEmail(s.frp_admin_notify_email ?? "")
      setNotifyEmailOptions(res.notifyEmailOptions ?? [])
      setTempboxEnabled(s.tempbox_enabled === "1")
      setTempboxMinutes(s.tempbox_default_minutes ?? "30")
      setTempboxMaxFileMb(
        String(Math.round(Number(s.tempbox_max_file_bytes ?? 268435456) / 1024 / 1024))
      )
      setTempboxMaxFiles(s.tempbox_max_files ?? "20")
      setTempboxUploadLogin(s.tempbox_upload_requires_login === "1")
      setCommunityEnabled(s.community_enabled === "1")
      setCommunityGuestAccess(s.community_guest_access !== "0")
      setCommunityPostMaxImages(s.community_post_max_images ?? "9")
      setCommunityImageMaxKb(
        String(Math.round(Number(s.community_image_max_bytes ?? 1048576) / 1024))
      )
      const basicRaw = (s.invite_basic_features ?? "r2").split(",").map((x) => x.trim()).filter(Boolean)
      setInviteBasic({
        r2: basicRaw.includes("r2"),
        ai: basicRaw.includes("ai"),
        frp: basicRaw.includes("frp"),
        proxy: basicRaw.includes("proxy"),
      })
      // 免权限访问：后端存空串表示「全部按权限卡」
      const openRaw = (s.open_features ?? "").split(",").map((x) => x.trim()).filter(Boolean)
      setOpenFeatures({
        r2: openRaw.includes("r2"),
        ai: openRaw.includes("ai"),
        frp: openRaw.includes("frp"),
        proxy: openRaw.includes("proxy"),
      })
      // 自动审核：后端存空串表示「全部转人工」
      const autoRaw = (s.auto_review_features ?? "").split(",").map((x) => x.trim()).filter(Boolean)
      setAutoReview({
        ai: autoRaw.includes("ai"),
        frp: autoRaw.includes("frp"),
        proxy: autoRaw.includes("proxy"),
      })
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "加载设置失败")
    } finally {
      setSettingsLoading(false)
    }
  }, [])

  // 详情弹窗里的 AI 余额要按服务端的 quota 换算率与币种显示，这两项来自
  // 全局设置。进页面就拉一次，避免管理员没点过「设置」标签时用默认值算错。
  React.useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  const handleSaveSettings = async () => {
    setSettingsBusy(true)
    try {
      await adminApi.updateSettings({
        storage_quota_bytes: Math.round(Number(quotaGb) * 1024 * 1024 * 1024),
        storage_max_file_bytes: Math.round(Number(maxFileMb) * 1024 * 1024),
        storage_enabled: storageEnabled,
        newapi_trial_quota: Math.round(Number(trialQuotaUsd) * quotaPerUnit),
        newapi_group: newapiGroup,
        newapi_unlimited_quota: newapiUnlimited,
        newapi_enabled: newapiEnabled,
        // JSON 字符串：后端对该键有专门分支（先解析再 sanitize），
        // 不走通用的「截断到 100 字」；空数组会序列化成 "[]" 正常写入。
        newapi_recommended_models: JSON.stringify(
          recommendedTiers
            .map((t) => ({
              tier: t.tier.trim(),
              desc: t.desc.trim(),
              models: t.models.map((m) => m.trim()).filter(Boolean),
            }))
            .filter((t) => t.tier && t.models.length > 0)
        ),
        frp_enabled: frpEnabled,
        frp_core_url: frpCoreUrl,
        frp_admin_notify_email: frpNotifyEmail,
        tempbox_enabled: tempboxEnabled,
        tempbox_default_minutes: Math.round(Number(tempboxMinutes) || 30),
        tempbox_max_file_bytes: Math.round(Number(tempboxMaxFileMb) * 1024 * 1024),
        tempbox_max_files: Math.round(Number(tempboxMaxFiles) || 20),
        tempbox_upload_requires_login: tempboxUploadLogin,
        community_enabled: communityEnabled,
        community_guest_access: communityGuestAccess,
        community_post_max_images: Math.round(Number(communityPostMaxImages) || 9),
        community_image_max_bytes: Math.round(Number(communityImageMaxKb) * 1024),
        // 邀请码模块权限：基础 vs 受限，逗号分隔
        invite_basic_features: Object.entries(inviteBasic)
          .filter(([, on]) => on)
          .map(([k]) => k)
          .join(","),
        // 免权限访问的模块，逗号分隔；全关时发空串（后端允许空串 = 全部按权限卡）
        open_features: Object.entries(openFeatures)
          .filter(([, on]) => on)
          .map(([k]) => k)
          .join(","),
        // 自动审核的模块，逗号分隔；全关时发空串 = 全部转人工
        auto_review_features: Object.entries(autoReview)
          .filter(([, on]) => on)
          .map(([k]) => k)
          .join(","),
        // 反代账号捐献通道
        wb2api_enabled: wb2apiEnabled,
        wb2api_max_bindings: String(Math.max(1, Math.round(Number(wb2apiMaxBindings) || 3))),
        wb2api_base_url: wb2apiBaseUrl.trim(),
        wb2api_realm: wb2apiRealm,
      })
      toast.success("设置已保存")
      await loadSettings()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "保存失败")
    } finally {
      setSettingsBusy(false)
    }
  }

  const handleSaveQuota = async () => {
    if (!detail) return
    setBusy(true)
    try {
      const raw = (quotaDraft ?? "").trim()
      const res = await adminApi.updateUser(detail.user.username, {
        // 留空表示恢复全局默认（传 null）
        maxSubdomains: raw === "" ? null : Number(raw),
      })
      setDetail(res)
      toast.success("配额已更新")
      void load()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "保存失败")
    } finally {
      setBusy(false)
    }
  }

  // ---- 中转站管理员凭据 ----

  const loadNewApiConfig = React.useCallback(async () => {
    setNewapiCredLoading(true)
    try {
      const res = await adminApi.getNewApiConfig()
      setNewapiCred(res)
      setNewapiUserId(res.adminUserId || "1")
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "读取中转站凭据失败")
    } finally {
      setNewapiCredLoading(false)
    }
    // 模型候选单独拉：失败只是没有下拉可选（降级为手输），不该弹错误打扰管理员
    try {
      const m = await adminApi.listNewApiModels()
      setModelOptions(m.models)
    } catch {
      setModelOptions([])
    }
  }, [])

  // ---- WorkBuddy 反代账号捐献 ----

  const loadWb2api = React.useCallback(async () => {
    setWb2apiLoading(true)
    try {
      const cfg = await wb2apiApi.getConfig()
      setWb2apiConfig(cfg)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "读取反代网关配置失败")
    } finally {
      setWb2apiLoading(false)
    }
    // 绑定列表与池概览各自容错：一个失败不该让整页空白
    try {
      const b = await wb2apiApi.listBindings()
      setWb2apiBindings(b.bindings)
    } catch {
      setWb2apiBindings([])
    }
    try {
      const p = await wb2apiApi.getPool()
      setWb2apiPool(p.pool)
    } catch {
      setWb2apiPool(null)
    }
  }, [])

  const handleSaveWb2apiKey = async () => {
    const key = wb2apiNewKey.trim()
    if (!key) {
      toast.error("请粘贴反代网关面板的访问密钥")
      return
    }
    setWb2apiBusy(true)
    try {
      const res = await wb2apiApi.saveConfig(key)
      setWb2apiNewKey("") // 明文用完即弃，不留内存
      toast.success(res.message || "密钥已更新并生效")
      void loadWb2api()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "密钥验证失败")
    } finally {
      setWb2apiBusy(false)
    }
  }

  const handleRemoveWb2apiBinding = async () => {
    const b = wb2apiRemoving
    if (!b) return
    setWb2apiBusy(true)
    try {
      const res = await wb2apiApi.removeBinding(b.id, wb2apiRevokeAi)
      toast.success(
        res.aiRevoked
          ? "已移除绑定，并收回了该用户的 AI 权限"
          : "已移除绑定（保留其 AI 权限）"
      )
      if (res.upstreamWarning) {
        toast.warning(`网关侧移除失败：${res.upstreamWarning}`)
      }
      setWb2apiRemoving(null)
      void loadWb2api()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "移除失败")
    } finally {
      setWb2apiBusy(false)
    }
  }

  const handleUpdateNewApiToken = async () => {
    const token = newapiNewToken.trim()
    if (!token) {
      toast.error("请粘贴 NewAPI 的新访问令牌")
      return
    }
    setNewapiCredBusy(true)
    try {
      const res = await adminApi.updateNewApiConfig({ token, adminUserId: newapiUserId })
      setNewapiCred((prev) =>
        prev
          ? {
              ...prev,
              source: res.source,
              maskedToken: res.maskedToken,
              adminUserId: res.adminUserId,
              updatedAt: res.updatedAt,
              configured: true,
            }
          : prev
      )
      setNewapiNewToken("") // 明文用完即弃，不留内存
      toast.success(res.message || "令牌已更新并生效")
      void loadNewApiConfig()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "令牌验证失败")
    } finally {
      setNewapiCredBusy(false)
    }
  }

  const openInvitePerms = (inv: AdminInvite) => {
    setPermInvite(inv)
    setPermDraft({ ...inv.permissions })
  }

  const handleSaveInvitePerms = async () => {
    if (!permInvite || !permDraft) return
    setPermBusy(true)
    try {
      await adminApi.updateInvite(permInvite.id, { permissions: permDraft })
      toast.success("权限已更新（只影响之后注册的新账号）")
      setPermInvite(null)
      setPermDraft(null)
      void loadInvites()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "保存失败")
    } finally {
      setPermBusy(false)
    }
  }

  const loadInviteQuotas = React.useCallback(async () => {
    setInviteQuotaLoading(true)
    try {
      setInviteQuotas(await adminApi.listInviteQuotas())
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "加载额度失败")
    } finally {
      setInviteQuotaLoading(false)
    }
  }, [])

  const openQuotaDetail = async (username: string) => {
    setQuotaDetailBusy(true)
    try {
      setQuotaDetail(await adminApi.getUserInviteQuota(username))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "加载详情失败")
    } finally {
      setQuotaDetailBusy(false)
    }
  }

  const handleAdjustQuota = async (
    username: string,
    payload: {
      inviteBonus?: number
      featureQuota?: Partial<FeatureCounts>
    }
  ) => {
    setQuotaDetailBusy(true)
    try {
      const res = await adminApi.updateUserInviteQuota(username, payload)
      setQuotaDetail(res)
      toast.success("额度已更新")
      void loadInviteQuotas()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "更新失败")
    } finally {
      setQuotaDetailBusy(false)
    }
  }

  const loadReserved = React.useCallback(async () => {
    setReservedLoading(true)
    try {
      const [res, s] = await Promise.all([
        adminApi.listReserved(),
        adminApi.getSettings(),
      ])
      setReserved(res.reserved)
      setNickReserved(
        (s.settings.reserved_nicknames ?? "")
          .split(",")
          .map((x: string) => x.trim())
          .filter(Boolean)
      )
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "加载保留名失败")
    } finally {
      setReservedLoading(false)
    }
  }, [])

  const handleAddReserved = async () => {
    if (!reservedName.trim()) return
    setReservedBusy(true)
    try {
      const res = await adminApi.addReserved({
        name: reservedName,
        note: reservedNote || undefined,
      })
      setReserved(res.reserved)
      setReservedName("")
      setReservedNote("")
      toast.success("已加入保留列表")
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "添加失败")
    } finally {
      setReservedBusy(false)
    }
  }

  const handleRemoveReserved = async (name: string) => {
    try {
      const res = await adminApi.removeReserved(name)
      setReserved(res.reserved)
      toast.success(`已取消保留 ${name}`)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "移除失败")
    }
  }

  // 昵称保留词：增/删都直接写 settings.reserved_nicknames
  const saveNickReserved = async (next: string[]) => {
    setNickReservedBusy(true)
    try {
      await adminApi.updateSettings({ reserved_nicknames: next.join(",") })
      setNickReserved(next)
      toast.success("保留词已更新")
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "保存失败")
    } finally {
      setNickReservedBusy(false)
    }
  }
  const handleAddNickReserved = async () => {
    const w = nickReservedInput.trim()
    if (!w) return
    if (nickReserved.some((x) => x.toLowerCase() === w.toLowerCase())) {
      toast.error("该保留词已存在")
      return
    }
    await saveNickReserved([...nickReserved, w])
    setNickReservedInput("")
  }
  const handleRemoveNickReserved = (w: string) => {
    void saveNickReserved(nickReserved.filter((x) => x !== w))
  }

  // ---- 公告 ----
  const loadAnnouncements = React.useCallback(async () => {
    setAnnouncementLoading(true)
    try {
      const res = await announcementApi.listAll()
      setAnnouncements(res.announcements)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "加载公告失败")
    } finally {
      setAnnouncementLoading(false)
    }
  }, [])

  const openAnnouncementDialog = (a?: Announcement) => {
    setAnnDraft(
      a
        ? { id: a.id, title: a.title, body: a.body, category: a.category, pinned: a.pinned, popupMode: a.popupMode }
        : { id: null, title: "", body: "", category: "general", pinned: false, popupMode: "none" }
    )
    setAnnouncementOpen(true)
  }

  const handleSaveAnnouncement = async () => {
    if (!annDraft.title.trim() || !annDraft.body.trim()) return
    setAnnouncementBusy(true)
    try {
      if (annDraft.id) {
        await announcementApi.update(annDraft.id, annDraft)
        toast.success("已更新")
      } else {
        await announcementApi.create(annDraft)
        toast.success("已发布")
      }
      setAnnouncementOpen(false)
      void loadAnnouncements()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "保存失败")
    } finally {
      setAnnouncementBusy(false)
    }
  }

  const handleDeleteAnnouncement = async (id: string) => {
    try {
      await announcementApi.remove(id)
      void loadAnnouncements()
      toast.success("已删除")
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "删除失败")
    }
  }

  // ---- R2 多桶 ----
  const loadR2 = React.useCallback(async () => {
    setR2Loading(true)
    try {
      const res = await r2AdminApi.buckets()
      setR2Data(res)
      // 顺带拉各桶的操作数（未配置 token 的会返回 configured:false）
      const ops: Record<string, R2Operations> = {}
      await Promise.all(
        res.buckets
          .filter((b) => b.id)
          .map(async (b) => {
            try {
              ops[b.id] = await r2AdminApi.operations(b.id)
            } catch {
              // 忽略单桶失败，不影响整体
            }
          })
      )
      setR2Ops(ops)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "加载 R2 桶失败")
    } finally {
      setR2Loading(false)
    }
  }, [])

  const openR2BucketDialog = (
    bucket?: R2Bucket,
    prefill?: { endpoint?: string; bucketName?: string }
  ) => {
    if (bucket) {
      setR2EditId(bucket.id)
      setR2Draft({
        id: bucket.id,
        name: bucket.name,
        accountId: bucket.accountId ?? "",
        endpoint: bucket.endpoint,
        bucketName: bucket.bucketName,
        accessKeyId: "",
        secretAccessKey: "",
        analyticsToken: "",
        maxUsers: String(bucket.maxUsers),
        quotaPerUser: String(bucket.quotaPerUser),
        sortOrder: String(bucket.sortOrder),
        kind: bucket.kind ?? "user",
      })
    } else {
      setR2EditId(null)
      setR2Draft({
        id: "",
        name: "",
        accountId: "",
        endpoint: prefill?.endpoint ?? "",
        bucketName: prefill?.bucketName ?? "",
        accessKeyId: "",
        secretAccessKey: "",
        analyticsToken: "",
        maxUsers: "8",
        quotaPerUser: "1073741824",
        sortOrder: "0",
        kind: "user",
      })
      setR2Pick("")
      // 新建时拉一次可选桶列表（用全局 token 自动发现）
      void loadR2Discover()
    }
    setR2BucketOpen(true)
  }

  /** 用全局 token 拉取所有账户及其桶 */
  const loadR2Discover = React.useCallback(async () => {
    setR2DiscoverLoading(true)
    try {
      const res = await r2AdminApi.discover()
      setR2Discovered(res)
    } catch (err) {
      setR2Discovered({
        available: false,
        reason: err instanceof HttpError ? err.message : "自动发现失败",
        accounts: [],
      })
    } finally {
      setR2DiscoverLoading(false)
    }
  }, [])

  /** 选中某个「账户|桶」后自动填充 endpoint / 桶名 / 账户 ID / 默认名称 */
  const handlePickBucket = (value: string) => {
    setR2Pick(value)
    const [accountId, bucketName] = value.split("|")
    if (!accountId || !bucketName) return
    const acc = r2Discovered?.accounts.find((a) => a.id === accountId)
    setR2Draft((d) => ({
      ...d,
      accountId,
      bucketName,
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      // 名称/ id 建议值，用户可改
      name: d.name || `${acc?.name ?? accountId.slice(0, 8)} / ${bucketName}`,
      id: d.id || bucketName.replace(/[^a-z0-9_-]/gi, "").slice(0, 40),
    }))
  }

  const handleSaveR2Bucket = async () => {
    if (!r2Draft.name.trim() || !r2Draft.endpoint.trim() || !r2Draft.bucketName.trim()) {
      toast.error(
        r2Pick || r2EditId
          ? "名称不能为空"
          : "请先从上方选择一个桶（或展开「高级选项」手动填写端点与桶名）"
      )
      return
    }
    setR2Busy(true)
    try {
      const base = {
        name: r2Draft.name,
        accountId: r2Draft.accountId || undefined,
        endpoint: r2Draft.endpoint,
        bucketName: r2Draft.bucketName,
        maxUsers: Number(r2Draft.maxUsers) || 8,
        quotaPerUser: Number(r2Draft.quotaPerUser) || 1073741824,
        sortOrder: Number(r2Draft.sortOrder) || 0,
      }
      if (r2EditId) {
        await r2AdminApi.update(r2EditId, {
          ...base,
          kind: r2Draft.kind,
          // 留空表示不修改凭据
          ...(r2Draft.accessKeyId ? { accessKeyId: r2Draft.accessKeyId } : {}),
          ...(r2Draft.secretAccessKey ? { secretAccessKey: r2Draft.secretAccessKey } : {}),
          ...(r2Draft.analyticsToken ? { analyticsToken: r2Draft.analyticsToken } : {}),
        })
        toast.success("已更新")
      } else {
        if (!r2Draft.id.trim()) {
          toast.error("新建时必须填 id")
          setR2Busy(false)
          return
        }
        await r2AdminApi.create({
          ...base,
          id: r2Draft.id,
          kind: r2Draft.kind,
          accessKeyId: r2Draft.accessKeyId,
          secretAccessKey: r2Draft.secretAccessKey,
          ...(r2Draft.analyticsToken ? { analyticsToken: r2Draft.analyticsToken } : {}),
        })
        toast.success("已创建")
      }
      setR2BucketOpen(false)
      void loadR2()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "保存失败")
    } finally {
      setR2Busy(false)
    }
  }

  const handleDeleteR2Bucket = async (id: string, name: string) => {
    if (!confirm(`确定删除桶「${name}」？仍有用户分配时会被拒绝。`)) return
    try {
      await r2AdminApi.remove(id)
      void loadR2()
      toast.success("已删除")
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "删除失败")
    }
  }

  const handleTestR2Bucket = async (id: string, write: boolean) => {
    try {
      const res = write ? await r2AdminApi.writeTest(id) : await r2AdminApi.test(id)
      if (res.ok) toast.success(res.message ?? "连通正常")
      else toast.error(res.error ?? "测试失败")
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "测试失败")
    }
  }

  const handleAssignBucket = async (username: string, bucketId: string) => {
    try {
      await r2AdminApi.assign(username, bucketId)
      void loadR2()
      toast.success(`已把 ${username} 改派到 ${bucketId || "默认桶"}`)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "改派失败")
    }
  }

  /** 把所有未分配用户一次性迁入某桶（接管 env 默认桶时用） */
  const handleAssignAll = async (bucketId: string, bucketName: string) => {
    if (
      !confirm(
        `把全部「未分配桶」的用户迁入「${bucketName}」？\n\n` +
          `只改数据库归属，不搬文件。若该桶与默认桶指向同一物理桶则完全安全。`
      )
    )
      return
    try {
      const res = await r2AdminApi.assignAll(bucketId)
      void loadR2()
      toast.success(`已迁入 ${res.moved} 个用户`)
    } catch (err) {
      if (err instanceof HttpError && err.code === "BUCKET_FULL") {
        // 超上限：明确告知后可强制
        if (confirm(`${err.message}\n\n仍要强制迁移吗？`)) {
          try {
            const res = await r2AdminApi.assignAll(bucketId, true)
            void loadR2()
            toast.success(`已强制迁入 ${res.moved} 个用户`)
          } catch (e2) {
            toast.error(e2 instanceof HttpError ? e2.message : "迁移失败")
          }
        }
        return
      }
      toast.error(err instanceof HttpError ? err.message : "迁移失败")
    }
  }

  const handleRecalculate = async () => {
    setSettingsBusy(true)
    try {
      const res = await adminApi.recalculateStorage()
      toast.success(
        `已重算 ${res.accounts} 个账户，合计 ${formatBytes(res.totalBytes)}`
      )
      await loadSettings()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "重算失败")
    } finally {
      setSettingsBusy(false)
    }
  }

  const filtered = users.filter((u) =>
    (u.username + u.email + u.namespace).toLowerCase().includes(filter.toLowerCase())
  )

  const openDetail = async (username: string) => {
    setBusy(true)
    try {
      const res = await adminApi.getUser(username)
      setDetail(res)
      // 配额草稿：有覆盖则显示该值，否则留空表示「用全局默认」
      setQuotaDraft(
        res.user.maxSubdomains === null || res.user.maxSubdomains === undefined
          ? ""
          : String(res.user.maxSubdomains)
      )
      setNickDraft(res.user.nickname ?? "")
      setDetailUser(username)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "加载详情失败")
    } finally {
      setBusy(false)
    }
  }

  /** 保存昵称（留空 = 清空）；与用户自助改名共用同一套后端校验 */
  const handleSaveNickname = async () => {
    if (!detail) return
    setBusy(true)
    try {
      const res = await adminApi.updateUser(detail.user.username, {
        nickname: nickDraft.trim() === "" ? null : nickDraft.trim(),
      })
      setDetail(res)
      toast.success(nickDraft.trim() === "" ? "昵称已清空" : "昵称已更新")
      void load()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "保存失败")
    } finally {
      setBusy(false)
    }
  }

  /** 切换邮箱验证 / 通知开关 */
  const handleToggleUserFlag = async (
    field: "emailVerified" | "notifyEnabled",
    value: boolean
  ) => {
    if (!detail) return
    setBusy(true)
    try {
      const res = await adminApi.updateUser(detail.user.username, { [field]: value })
      setDetail(res)
      const label = field === "emailVerified" ? "邮箱验证" : "通知邮件"
      toast.success(`${label}已${value ? "开启" : "关闭"}`)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "操作失败")
    } finally {
      setBusy(false)
    }
  }

  /** 切换角色（admin / user）；主管理员在后端被拒 */
  const handleToggleRole = async (nextRole: "admin" | "user") => {
    if (!detail) return
    setBusy(true)
    try {
      const res = await adminApi.updateUser(detail.user.username, { role: nextRole })
      setDetail(res)
      toast.success(nextRole === "admin" ? "已设为管理员" : "已降为普通用户")
      void load()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "操作失败")
    } finally {
      setBusy(false)
    }
  }

  const handleToggleStatusByName = async (username: string, currentStatus: string) => {
    setBusy(true)
    try {
      const res = await adminApi.updateUser(username, {
        status: currentStatus === "suspended" ? "active" : "suspended",
      })
      setDetail(res)
      toast.success(res.user.status === "suspended" ? "已封禁" : "已解封")
      void load()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "操作失败")
    } finally {
      setBusy(false)
    }
  }

  /** 切换某用户的功能权限（管理员在成员详情里调整） */
  const handleTogglePermission = async (key: FeatureKey, value: boolean) => {
    if (!detail) return
    setBusy(true)
    try {
      const nextPerms = { ...detail.user.permissions, [key]: value }
      const res = await adminApi.updateUser(detail.user.username, {
        permissions: nextPerms,
      })
      setDetail(res)
      toast.success(
        `${FEATURE_LABELS[key]}已${value ? "开启" : "关闭"}`
      )
      void load()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "操作失败")
    } finally {
      setBusy(false)
    }
  }

  const handleToggleStatus = (u: AdminUser) =>
    handleToggleStatusByName(u.username, u.status)

  const handleDelete = async (u: AdminUser) => {
    setBusy(true)
    try {
      await adminApi.deleteUser(u.username)
      toast.success("用户已删除")
      setDetail(null)
      setDetailUser("")
      void load()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "删除失败")
    } finally {
      setBusy(false)
    }
  }

  const openMessage = async (messageId: string) => {
    if (!detailUser) return
    try {
      const res = await adminApi.getUserMessage(detailUser, messageId)
      setOpenedMessage(res.message)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "加载邮件失败")
    }
  }

  /** 切换管理面板 tab：切到对应标签时懒加载该标签的数据 */
  const handleTabChange = (v: string) => {
    setActiveTab(v)
    if (v === "invites") void loadInvites()
    if (v === "settings") void loadSettings()
    if (v === "frp") void loadFrp()
    if (v === "proxy") void loadProxy()
    if (v === "reserved") void loadReserved()
    if (v === "donations") { void loadDonations(); void loadWb2api() }
    if (v === "announcements") void loadAnnouncements()
    if (v === "inviteQuotas") void loadInviteQuotas()
    if (v === "r2") void loadR2()
    if (v === "community") void loadCommunity()
    if (v === "newapi") { void loadSettings(); void loadNewApiConfig() }
    if (v === "wb2api") void loadWb2api()
  }

  return (
    <div>
      <PageHeader
        title="管理"
        description={`已注册用户 ${users.length} 个 · 邀请码 ${invites.length} 个`}
      />

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <div className="flex flex-col gap-6 lg:flex-row">
          {/* 左侧二级导航 */}
          <aside className="w-full shrink-0 lg:w-48">
            <Link
              to="/dashboard"
              className="mb-3 inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              返回控制台
            </Link>

            <nav className="flex flex-col gap-0.5">
              <NavItem active={activeTab === "users"} icon={Users} label="用户" onClick={() => handleTabChange("users")} />
              <NavGroup label="账号与邀请">
                <NavItem active={activeTab === "invites"} icon={KeyRound} label="邀请码" onClick={() => handleTabChange("invites")} />
                <NavItem active={activeTab === "inviteQuotas"} icon={Ticket} label="用户邀请码" onClick={() => handleTabChange("inviteQuotas")} />
                <NavItem active={activeTab === "reserved"} icon={ShieldBan} label="保留名" onClick={() => handleTabChange("reserved")} />
              </NavGroup>
              <NavGroup label="资源服务">
                <NavItem active={activeTab === "frp"} icon={Network} label="内网穿透" onClick={() => handleTabChange("frp")} />
                <NavItem active={activeTab === "proxy"} icon={Zap} label="代理节点" onClick={() => handleTabChange("proxy")} />
                <NavItem active={activeTab === "donations"} icon={Heart} label="捐献" onClick={() => handleTabChange("donations")} />
                <NavItem active={activeTab === "wb2api"} icon={Unplug} label="反代账号" onClick={() => handleTabChange("wb2api")} />
              </NavGroup>
              <NavGroup label="内容与运营">
                <NavItem active={activeTab === "announcements"} icon={Megaphone} label="公告" onClick={() => handleTabChange("announcements")} />
                <NavItem active={activeTab === "community"} icon={MessagesSquare} label="社区" onClick={() => handleTabChange("community")} />
                <NavItem active={activeTab === "r2"} icon={Database} label="R2 存储" onClick={() => handleTabChange("r2")} />
              </NavGroup>
              <NavGroup label="系统">
                <NavItem active={activeTab === "newapi"} icon={Sparkles} label="中转站" onClick={() => handleTabChange("newapi")} />
                <NavItem active={activeTab === "oauth"} icon={KeyRound} label="OAuth 应用" onClick={() => handleTabChange("oauth")} />
                <NavItem active={activeTab === "analytics"} icon={BarChart3} label="网站统计" onClick={() => handleTabChange("analytics")} />
                <NavItem active={activeTab === "settings"} icon={SlidersHorizontal} label="设置" onClick={() => handleTabChange("settings")} />
              </NavGroup>
            </nav>
          </aside>

          {/* 右侧内容区 */}
          <div className="min-w-0 flex-1">
        <TabsContent value="users">
          <div className="mb-4 relative max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="搜索用户名 / 邮箱 / 域名"
              className="pl-8"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>

      {loading ? (
        <LoadingBlock />
      ) : filtered.length === 0 ? (
        <EmptyState title="没有匹配的用户" description="换个关键词试试。" />
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>用户</TableHead>
                <TableHead>邀请码</TableHead>
                <TableHead>创建时间</TableHead>
                <TableHead className="text-center">网盘</TableHead>
                <TableHead className="text-center">AI 中转站</TableHead>
                <TableHead className="text-center">内网穿透</TableHead>
                <TableHead className="text-center">代理节点</TableHead>
                <TableHead className="text-center">个人名片</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((u) => (
                <TableRow key={u.id}>
                  <TableCell>
                    <button
                      type="button"
                      className="text-left hover:underline"
                      onClick={() => void openDetail(u.username)}
                    >
                      <p className="font-mono text-sm">{u.username}</p>
                      <p className="text-xs text-muted-foreground">{u.email}</p>
                    </button>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {u.inviteCode ? (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className="font-mono text-xs text-primary hover:underline"
                            >
                              {u.inviteCode}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>
                              创建者：{u.inviteCreatedBy ?? "未知"}
                            </p>
                            <p className="text-muted-foreground">
                              {u.inviteCreatedAt
                                ? fmtTime(u.inviteCreatedAt)
                                : "时间未知"}
                            </p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {fmtTime(u.createdAt)}
                  </TableCell>
                  <TableCell className="text-center">
                    <BoolMark on={u.storageEnabled} />
                  </TableCell>
                  <TableCell className="text-center">
                    <BoolMark on={u.aiEnabled} />
                  </TableCell>
                  <TableCell className="text-center">
                    <BoolMark on={u.frpEnabled} />
                  </TableCell>
                  <TableCell className="text-center">
                    <BoolMark on={u.proxyEnabled} />
                  </TableCell>
                  <TableCell className="text-center">
                    <div className="flex items-center justify-center gap-1.5">
                      <BoolMark on={u.profileEnabled} />
                      {u.profileEnabled &&
                        (() => {
                          const url = profilePublicUrl(u.profileSlug, u.profileFqdn)
                          return url ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 text-muted-foreground"
                              asChild
                              title="打开公开名片页"
                            >
                              <a href={url} target="_blank" rel="noopener noreferrer">
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                            </Button>
                          ) : null
                        })()}
                    </div>
                  </TableCell>
                  <TableCell>
                    {u.status === "active" ? (
                      <Badge variant="success">active</Badge>
                    ) : (
                      <Badge variant="destructive">suspended</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1 px-2 text-xs"
                        onClick={() => void openDetail(u.username)}
                        disabled={busy}
                        title="编辑该用户"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground"
                        onClick={() => void handleToggleStatus(u)}
                        disabled={busy || u.username === user?.username}
                        title={u.status === "active" ? "封禁" : "解封"}
                      >
                        {u.status === "active" ? (
                          <Ban className="h-4 w-4" />
                        ) : (
                          <UserCheck className="h-4 w-4" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        onClick={() => void handleDelete(u)}
                        disabled={busy || u.username === user?.username}
                        title="删除"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
        </TabsContent>

        <TabsContent value="invites">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              邀请码用于注册；每个码有使用次数上限。
            </p>
            <Button size="sm" onClick={() => setInviteOpen(true)}>
              <Plus className="h-4 w-4" />
              添加邀请码
            </Button>
          </div>

          {inviteLoading ? (
            <LoadingBlock />
          ) : invites.length === 0 ? (
            <EmptyState title="还没有邀请码" description="创建一个邀请码用于注册。" />
          ) : (
            <div className="rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>邀请码</TableHead>
                    <TableHead>已用 / 上限</TableHead>
                    <TableHead>权限</TableHead>
                    <TableHead>创建时间</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invites.map((inv) => {
                    const exhausted = inv.usedCount >= inv.maxUses
                    const expired =
                      inv.expiresAt !== null &&
                      new Date(inv.expiresAt).getTime() < Date.now()
                    return (
                      <TableRow key={inv.id}>
                        <TableCell className="font-mono text-sm">
                          {inv.code}
                        </TableCell>
                        <TableCell>
                          {inv.usedCount} / {inv.maxUses}
                        </TableCell>
                        <TableCell>
                          <button
                            type="button"
                            className="flex flex-wrap gap-1 text-left"
                            onClick={() => openInvitePerms(inv)}
                            title="点击编辑权限"
                          >
                            {FEATURES.filter((f) => inv.permissions[f.key]).length ===
                            FEATURES.length ? (
                              <Badge variant="secondary">全部</Badge>
                            ) : FEATURES.filter((f) => inv.permissions[f.key]).length ===
                              0 ? (
                              <Badge variant="destructive">无</Badge>
                            ) : (
                              FEATURES.filter((f) => inv.permissions[f.key]).map((f) => (
                                <Badge key={f.key} variant="outline">
                                  {f.label}
                                </Badge>
                              ))
                            )}
                          </button>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {fmtTime(inv.createdAt)}
                        </TableCell>
                        <TableCell>
                          {exhausted ? (
                            <Badge variant="destructive">已用完</Badge>
                          ) : expired ? (
                            <Badge variant="destructive">已过期</Badge>
                          ) : (
                            <Badge variant="success">可用</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground"
                              onClick={() => openInvitePerms(inv)}
                              title="编辑权限"
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-destructive"
                              onClick={() => void handleDeleteInvite(inv)}
                              title="删除"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="frp">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Select value={frpStatus} onValueChange={setFrpStatus}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending">待审核</SelectItem>
                  <SelectItem value="approved">已通过</SelectItem>
                  <SelectItem value="rejected">已拒绝</SelectItem>
                  <SelectItem value="all">全部</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" onClick={() => void loadFrp()}>
                <RefreshCw className="h-3.5 w-3.5" />
                刷新
              </Button>
            </div>
            <Button
              size="sm"
              onClick={() => {
                setNodeForm({
                  id: "",
                  name: "",
                  region: "",
                  serverAddr: "",
                  serverPort: "7000",
                  authToken: "",
                  portMin: "20000",
                  portMax: "50000",
                  maxPorts: "5",
                  note: "",
                  status: "unknown",
                  statusNote: "",
                })
                setNodeOpen(true)
              }}
            >
              <Plus className="h-4 w-4" />
              添加节点
            </Button>
          </div>

          {frpLoading ? (
            <LoadingBlock />
          ) : (
            <div className="space-y-4">
              {frpApps.length === 0 ? (
                <EmptyState
                  title="没有符合条件的申请"
                  description="用户在内网穿透页面提交申请后会出现在这里。"
                />
              ) : (
                <div className="space-y-3">
                  {frpApps.map((a) => (
                    <div key={a.id} className="rounded-lg border bg-card p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-1">
                          <p className="text-sm font-medium">
                            {a.siteUsername}
                            <span className="ml-2 font-mono text-xs text-muted-foreground">
                              {a.frpUser}
                            </span>
                            <Badge
                              variant={
                                a.status === "pending"
                                  ? "secondary"
                                  : a.status === "approved"
                                    ? "success"
                                    : "destructive"
                              }
                              className="ml-2"
                            >
                              {a.status === "pending"
                                ? "待审核"
                                : a.status === "approved"
                                  ? "已通过"
                                  : "已拒绝"}
                            </Badge>
                          </p>
                          <p className="text-xs text-muted-foreground">
                            节点 {a.nodeName} · 端口 {a.ports.join(", ")} · 密码{" "}
                            <code className="font-mono">{a.frpPassword}</code>
                          </p>
                          <p className="text-xs text-muted-foreground">
                            通知邮箱 {a.notifyEmail} · {fmtTime(a.createdAt)}
                          </p>
                          {a.tunnels.length > 0 && (
                            <p className="font-mono text-xs text-muted-foreground">
                              {a.tunnels
                                .map(
                                  (t) =>
                                    `${t.name}(${t.type} ${t.remotePort}->${t.localPort})`
                                )
                                .join("、")}
                            </p>
                          )}
                          {a.remark && (
                            <p className="text-xs text-muted-foreground">
                              备注：{a.remark}
                            </p>
                          )}
                          {a.reviewNote && (
                            <p className="text-xs text-muted-foreground">
                              审批意见：{a.reviewNote}
                            </p>
                          )}
                        </div>
                        {a.status === "pending" && (
                          <div className="flex items-center gap-2">
                            <Button
                              size="sm"
                              onClick={() => void handleReview(a, "approve")}
                              disabled={frpBusy}
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              通过
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => void handleReview(a, "reject")}
                              disabled={frpBusy}
                            >
                              <XCircle className="h-3.5 w-3.5" />
                              拒绝
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                  <div className="space-y-2">
                    <Label htmlFor="frpNote">
                      审批意见（可选，会随结果邮件发出）
                    </Label>
                    <Input
                      id="frpNote"
                      placeholder="例如：已在 frps-panel 建号 / 端口冲突请重选"
                      value={frpNote}
                      onChange={(e) => setFrpNote(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      提示：在 frps-panel 建号时，请把用户申请里填的
                      <strong>密码</strong>原样作为该用户的 token
                      （它就是 config.toml 里的 metadatas.token）。
                    </p>
                  </div>
                </div>
              )}

              <Separator />

              <div>
                <h3 className="mb-2 text-sm font-medium">
                  节点（{frpNodes.length}）
                </h3>
                <div className="rounded-lg border bg-card">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>名称</TableHead>
                        <TableHead>serverAddr</TableHead>
                        <TableHead>端口范围</TableHead>
                        <TableHead>已占用</TableHead>
                        <TableHead className="w-28" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {frpNodes.map((n) => (
                        <TableRow key={n.id}>
                          <TableCell className="text-sm">
                            {n.name}
                            {n.region && (
                              <span className="ml-1 text-xs text-muted-foreground">
                                {n.region}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {n.serverAddr}:{n.serverPort}
                          </TableCell>
                          <TableCell className="text-xs">
                            {n.portMin}-{n.portMax}（最多 {n.maxPorts}）
                          </TableCell>
                          <TableCell className="text-xs">{n.usedPorts}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setNodeForm({
                                    id: n.id,
                                    name: n.name,
                                    region: n.region ?? "",
                                    serverAddr: n.serverAddr,
                                    serverPort: String(n.serverPort),
                                    authToken: n.authToken,
                                    portMin: String(n.portMin),
                                    portMax: String(n.portMax),
                                    maxPorts: String(n.maxPorts),
                                    note: n.note ?? "",
                                    status: n.status ?? "unknown",
                                    statusNote: n.statusNote ?? "",
                                  })
                                  setNodeOpen(true)
                                }}
                              >
                                编辑
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                onClick={() => void handleDeleteNode(n.id)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="proxy">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              维护代理订阅源：用户启用「代理节点」后即可看到所有已启用的订阅源。
            </p>
            <Button
              size="sm"
              onClick={() => {
                setProxyForm({
                  id: "",
                  name: "",
                  region: "",
                  url: "",
                  protocol: "",
                  status: "unknown",
                  statusNote: "",
                  enabled: true,
                  sortOrder: "0",
                  note: "",
                })
                setProxyOpen(true)
              }}
            >
              <Plus className="h-4 w-4" />
              添加订阅源
            </Button>
          </div>

          {proxyLoading ? (
            <LoadingBlock />
          ) : proxySubs.length === 0 ? (
            <EmptyState
              title="还没有订阅源"
              description="添加一个代理订阅链接（vless / vmess / trojan / ss / ssr / anytls / hysteria2 / tuic）。"
            />
          ) : (
            <div className="rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead>订阅链接</TableHead>
                    <TableHead>协议</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>启用</TableHead>
                    <TableHead className="w-28" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {proxySubs.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="text-sm">
                        {s.name}
                        {s.region && (
                          <span className="ml-1 text-xs text-muted-foreground">
                            {s.region}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[260px] truncate font-mono text-xs">
                        {s.url}
                      </TableCell>
                      <TableCell className="text-xs">{s.protocol}</TableCell>
                      <TableCell>
                        {s.status === "online" ? (
                          <Badge variant="success">运行中</Badge>
                        ) : s.status === "offline" ? (
                          <Badge variant="destructive">不可用</Badge>
                        ) : s.status === "maintenance" ? (
                          <Badge variant="secondary">维护中</Badge>
                        ) : (
                          <Badge variant="outline">未知</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {s.enabled ? (
                          <Badge variant="success">公开</Badge>
                        ) : (
                          <Badge variant="secondary">停用</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setProxyForm({
                                id: s.id,
                                name: s.name,
                                region: s.region ?? "",
                                url: s.url,
                                protocol: s.protocol,
                                status: s.status,
                                statusNote: s.statusNote ?? "",
                                enabled: s.enabled,
                                sortOrder: String(s.sortOrder),
                                note: s.note ?? "",
                              })
                              setProxyOpen(true)
                            }}
                          >
                            编辑
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-destructive"
                            onClick={() => void handleDeleteProxy(s.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="inviteQuotas">
          <p className="mb-4 text-sm text-muted-foreground">
            每个用户默认可创建 {inviteQuotas?.baseQuota ?? 3} 个邀请码；
            每笔捐献获批再 +2 个额度，并获得 1 个对应模块的权限额度。
            点「详情」可查看该用户创建的邀请码并调整额度。
          </p>

          {inviteQuotaLoading ? (
            <LoadingBlock />
          ) : (inviteQuotas?.users.length ?? 0) === 0 ? (
            <EmptyState title="还没有数据" description="用户注册后会出现在这里。" />
          ) : (
            <div className="rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>用户</TableHead>
                    <TableHead>邀请码额度</TableHead>
                    <TableHead>模块权限额度（剩余）</TableHead>
                    <TableHead>已创建</TableHead>
                    <TableHead className="w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {inviteQuotas!.users.map((u) => (
                    <TableRow key={u.id}>
                      <TableCell className="font-mono text-sm">
                        {u.username}
                      </TableCell>
                      <TableCell className="text-sm">
                        <span className="font-semibold">{u.inviteRemaining}</span>
                        <span className="text-muted-foreground">
                          {" / "}
                          {u.inviteTotal}
                        </span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          （基础 {u.inviteBase} + 捐献 {u.inviteBonus}）
                        </span>
                      </TableCell>
                      <TableCell className="text-xs">
                        <div className="flex flex-wrap gap-x-3 gap-y-1">
                          {inviteQuotas!.quotaFeatures.map((f) => {
                            const remain =
                              u.featureRemaining[
                                f as keyof typeof u.featureRemaining
                              ]
                            const isBasic =
                              inviteQuotas!.basicFeatures?.includes(f) ?? false
                            return (
                              <span key={f}>
                                {inviteQuotas!.featureLabels[f]}{" "}
                                {isBasic ? (
                                  <Badge variant="outline">基础</Badge>
                                ) : (
                                  <span
                                    className={
                                      remain > 0
                                        ? "font-semibold text-emerald-600 dark:text-emerald-400"
                                        : "text-muted-foreground"
                                    }
                                  >
                                    {remain}
                                  </span>
                                )}
                              </span>
                            )
                          })}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">{u.inviteCount}</TableCell>
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 text-xs"
                          disabled={quotaDetailBusy}
                          onClick={() => void openQuotaDetail(u.username)}
                        >
                          详情
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="reserved">
          {/* 保留域名 */}
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-sm font-medium">保留域名</h3>
            <span className="text-xs text-muted-foreground">
              命中后用户无法创建同名一级子域名
            </span>
          </div>
          <div className="mb-4 space-y-3">
            <p className="text-sm text-muted-foreground">
              名单中的名称不允许用户创建为一级子域名（即使位数合规）。
              邮箱前缀与用户名不受此名单影响。
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="rname" className="text-xs">名称</Label>
                <Input
                  id="rname"
                  placeholder="brand"
                  className="w-40"
                  value={reservedName}
                  onChange={(e) => setReservedName(e.target.value.toLowerCase())}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="rnote" className="text-xs">备注（可选）</Label>
                <Input
                  id="rnote"
                  placeholder="用途说明"
                  className="w-48"
                  value={reservedNote}
                  onChange={(e) => setReservedNote(e.target.value)}
                />
              </div>
              <Button onClick={() => void handleAddReserved()} disabled={reservedBusy || !reservedName.trim()}>
                {reservedBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                <Plus className="h-4 w-4" />
                添加
              </Button>
            </div>
          </div>

          {reservedLoading ? (
            <LoadingBlock />
          ) : reserved.length === 0 ? (
            <EmptyState title="没有保留域名" description="添加后用户将无法创建同名一级子域名。" />
          ) : (
            <div className="rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead>完整域名</TableHead>
                    <TableHead>备注</TableHead>
                    <TableHead className="w-12" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reserved.map((r) => (
                    <TableRow key={r.name}>
                      <TableCell className="font-mono text-sm">{r.name}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {r.name}.doulor.cn
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.note ?? "—"}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={() => void handleRemoveReserved(r.name)}
                          title="取消保留"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {/* 昵称保留词 */}
          <div className="mt-8 mb-2 flex items-center gap-2">
            <h3 className="text-sm font-medium">昵称保留词</h3>
            <span className="text-xs text-muted-foreground">
              命中后普通用户无法用该昵称（管理员自身不受限）
            </span>
          </div>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              用户设置昵称时，命中此列表的昵称会被拒绝。基础保留词（管理员、站长、admin 等）
              硬编码无法删除。管理员自己设昵称时跳过此名单，但仍禁止含「doulor」。
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="rnick" className="text-xs">保留词</Label>
                <Input
                  id="rnick"
                  placeholder="小助手"
                  className="w-40"
                  value={nickReservedInput}
                  onChange={(e) => setNickReservedInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      void handleAddNickReserved()
                    }
                  }}
                />
              </div>
              <Button
                onClick={() => void handleAddNickReserved()}
                disabled={nickReservedBusy || !nickReservedInput.trim()}
              >
                {nickReservedBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                <Plus className="h-4 w-4" />
                添加
              </Button>
            </div>
            {nickReserved.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {nickReserved.map((w) => (
                  <Badge
                    key={w}
                    variant="secondary"
                    className="gap-1 py-1 pl-2.5 pr-1.5"
                  >
                    <span className="font-mono">{w}</span>
                    <button
                      onClick={() => handleRemoveNickReserved(w)}
                      className="rounded-sm p-0.5 hover:bg-background hover:text-foreground"
                      aria-label={`移除 ${w}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">还没有附加保留词。</p>
            )}
          </div>
        </TabsContent>

        <TabsContent value="donations">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              用户贡献资源以解锁功能。通过后会自动为其开通对应权限，并邮件通知申请人。
            </p>
            <Button variant="outline" size="sm" onClick={() => void loadDonations()}>
              <RefreshCw className="h-4 w-4" />
              刷新
            </Button>
          </div>

          {donationLoading ? (
            <LoadingBlock />
          ) : donations.length === 0 ? (
            <EmptyState
              title="还没有捐献申请"
              description="用户在「捐献」页面提交后会出现在这里。"
            />
          ) : (
            <div className="space-y-3">
              {donations.map((d) => (
                <div key={d.id} className="rounded-lg border bg-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1.5">
                      <p className="text-sm font-medium">
                        {d.username}
                        <Badge variant="outline" className="ml-2">
                          {DONATION_LABEL[d.type] ?? d.type}
                        </Badge>
                        <Badge
                          variant={
                            d.status === "pending"
                              ? "secondary"
                              : d.status === "approved"
                                ? "success"
                                : "destructive"
                          }
                          className="ml-2"
                        >
                          {d.status === "pending"
                            ? "待审核"
                            : d.status === "approved"
                              ? "已通过"
                              : "已拒绝"}
                        </Badge>
                      </p>
                      <DonationDetail type={d.type} payload={d.payload} />
                      {d.type === "ai" && (
                        <p className="text-xs text-muted-foreground">
                          {d.channelId !== null && d.channelId !== undefined
                            ? `中转站渠道 #${d.channelId} 已接入`
                            : "尚未接入中转站渠道"}
                          {d.autoReviewed && " · 本次为系统自动审核"}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        通知邮箱 {d.notifyEmail} · {fmtTime(d.createdAt)}
                      </p>
                      {d.remark && (
                        <p className="text-xs text-muted-foreground">
                          备注：{d.remark}
                        </p>
                      )}
                      {d.reviewNote && (
                        <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                          审批回复：{d.reviewNote}
                        </p>
                      )}
                    </div>
                    {d.status === "pending" && (
                      <div className="flex shrink-0 items-center gap-2">
                        <Button
                          size="sm"
                          onClick={() => void handleReviewDonation(d, "approve")}
                          disabled={donationBusy}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          通过并解锁
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void handleReviewDonation(d, "reject")}
                          disabled={donationBusy}
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          拒绝
                        </Button>
                      </div>
                    )}
                    {d.status === "rejected" && (
                      <div className="flex shrink-0 items-center gap-2">
                        {/* AI 渠道可以「先用原始信息重试接入」；代理/内网穿透没有
                            可重试的自动动作，直接人工放行即可 */}
                        {d.type === "ai" && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void handleProvisionDonation(d)}
                            disabled={donationBusy}
                          >
                            <PlugZap className="h-3.5 w-3.5" />
                            复核：重试接入
                          </Button>
                        )}
                        <Button
                          size="sm"
                          onClick={() => void handleReviewDonation(d, "approve")}
                          disabled={donationBusy}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          复核通过
                        </Button>
                      </div>
                    )}
                    {d.status === "approved" && (
                      <div className="flex shrink-0 items-center">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => void handleRevokeDonation(d)}
                          disabled={donationBusy}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          撤销并重新审核
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 反代账号贡献：免审核通道，登录即生效，这里只做观察与摘除 */}
          <div className="mt-6 border-t pt-6">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium">反代账号贡献</h3>
                <p className="text-xs text-muted-foreground">
                  用户登录 WorkBuddy 账号即自动生效，无需审核。这里用于观察与摘除。
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => void loadWb2api()}>
                <RefreshCw className="h-4 w-4" />
                刷新
              </Button>
            </div>
            {wb2apiBindings.length === 0 ? (
              <EmptyState
                icon={Unplug}
                title="还没有反代账号贡献"
                description="用户在「捐献」页登录 WorkBuddy 账号后会出现在这里。"
              />
            ) : (
              <div className="divide-y rounded-md border">
                {wb2apiBindings.map((b) => (
                  <div
                    key={b.id}
                    className="flex flex-wrap items-center gap-2 px-4 py-3"
                  >
                    <span className="text-sm font-medium">{b.username}</span>
                    <span className="text-sm">{b.nickname || b.uid}</span>
                    <Badge variant="outline">{realmLabel(b.realm)}</Badge>
                    <Badge variant={b.status === "active" ? "success" : "secondary"}>
                      {b.status === "active" ? "使用中" : "已移除"}
                    </Badge>
                    <Badge variant={b.grantedAi ? "outline" : "secondary"}>
                      {b.grantedAi ? "AI 权限由本次授予" : "未授予（此前已有）"}
                    </Badge>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {fmtTime(b.createdAt)}
                    </span>
                    {b.status === "active" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => {
                          setWb2apiRevokeAi(b.grantedAi)
                          setWb2apiRemoving(b)
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                        摘除
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 审核理由弹窗 */}
          <Dialog open={reviewTarget !== null} onOpenChange={(o) => !o && setReviewTarget(null)}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  {reviewTarget?.action === "approve" ? "通过捐献" : "拒绝捐献"}
                </DialogTitle>
                <DialogDescription>
                  用户「{reviewTarget?.donation.username}」的捐献
                  {reviewTarget?.action === "approve"
                    ? "将通过并解锁对应功能。"
                    : "将被拒绝。"}
                  {reviewTarget?.action === "approve" &&
                    reviewTarget.donation.type === "ai" &&
                    (reviewTarget.donation.channelId === null ||
                      reviewTarget.donation.channelId === undefined) &&
                    "该 AI 捐献尚未接入中转站，通过时会自动尝试创建渠道并测试。"}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor="reviewNote">
                  {reviewTarget?.action === "approve" ? "审批回复（可选）" : "拒绝理由（可选，建议填写）"}
                </Label>
                <Textarea
                  id="reviewNote"
                  rows={3}
                  placeholder={
                    reviewTarget?.action === "reject"
                      ? "例如：渠道已失效 / 订阅链接无法使用，请更换后重新提交"
                      : "例如：渠道已验证可用，已为你开通"
                  }
                  value={reviewNote}
                  onChange={(e) => setReviewNote(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  会随结果邮件一并通知申请人。
                </p>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setReviewTarget(null)} disabled={donationBusy}>
                  取消
                </Button>
                <Button
                  variant={reviewTarget?.action === "reject" ? "destructive" : "default"}
                  onClick={() => void confirmReview()}
                  disabled={donationBusy}
                >
                  {donationBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  确认{reviewTarget?.action === "approve" ? "通过" : "拒绝"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </TabsContent>

        <TabsContent value="announcements">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              发布网站动态，用户在概览页可见（pinned 优先，最多展示 5 条）
            </p>
            <Button size="sm" onClick={() => openAnnouncementDialog()}>
              <Plus className="h-4 w-4" />
              发布公告
            </Button>
          </div>
          {announcementLoading ? (
            <LoadingBlock />
          ) : announcements.length === 0 ? (
            <EmptyState
              icon={Megaphone}
              title="还没有公告"
              description="发布公告后，用户会在概览页「网站动态」看到。"
            />
          ) : (
            <div className="space-y-3">
              {announcements.map((a) => (
                <Card key={a.id}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center gap-2">
                          {a.pinned && <Badge variant="success">置顶</Badge>}
                          <Badge variant="secondary">{a.category}</Badge>
                          <span className="text-xs text-muted-foreground">
                            {new Date(a.createdAt).toLocaleString("zh-CN")}
                          </span>
                        </div>
                        <p className="text-sm font-medium">{a.title}</p>
                        <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                          {a.body}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => openAnnouncementDialog(a)}
                          aria-label="编辑"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          onClick={() => void handleDeleteAnnouncement(a.id)}
                          aria-label="删除"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="r2">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              多桶横向扩容：免费额度每账户 10 GB。用户开通网盘时自动分配到人数最少的桶，
              每桶人数上限与每人配额可随时调整。
            </p>
            <Button size="sm" onClick={() => openR2BucketDialog()}>
              <Plus className="h-4 w-4" />
              添加桶
            </Button>
          </div>

          {r2Loading ? (
            <LoadingBlock />
          ) : !r2Data || (r2Data.buckets.length === 0 && !r2Data.legacyBucket) ? (
            <EmptyState
              icon={Database}
              title="还没有配置 R2 桶"
              description="添加桶后，新开通网盘的用户会被自动分配。"
            />
          ) : (
            <div className="space-y-4">
              {/* 免费额度图例 */}
              <div className="flex flex-wrap items-center gap-4 rounded-lg border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Cloudflare 免费额度（每月）</span>
                <span>存储 {formatBytes(r2Data.freeTier.storageBytes)}</span>
                <span>A 类操作 {r2Data.freeTier.classAOps.toLocaleString()}</span>
                <span>B 类操作 {r2Data.freeTier.classBOps.toLocaleString()}</span>
              </div>

              {/* 各桶卡片 */}
              {[...r2Data.buckets, ...(r2Data.legacyBucket ? [r2Data.legacyBucket] : [])].map(
                (b) => {
                  const s = b.stats
                  const userPct = b.maxUsers ? Math.min((s.users / b.maxUsers) * 100, 100) : 0
                  const capacityPct =
                    s.capacityBytes > 0 ? Math.min((s.usedBytes / s.capacityBytes) * 100, 100) : 0
                  const ops = b.id ? r2Ops[b.id] : undefined
                  return (
                    <Card key={b.id || "legacy"}>
                      <CardHeader>
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="space-y-1">
                            <CardTitle className="flex items-center gap-2 text-base">
                              <Database className="h-4 w-4 text-muted-foreground" />
                              {b.name}
                              {b.kind === "platform" && (
                                <Badge variant="secondary">平台数据</Badge>
                              )}
                              {!b.enabled && <Badge variant="secondary">已停用</Badge>}
                              {b.id === "" && <Badge variant="outline">默认桶</Badge>}
                            </CardTitle>
                            <CardDescription className="font-mono text-xs">
                              {b.bucketName}
                              {b.accountId ? ` · ${b.accountId.slice(0, 8)}…` : ""}
                              {b.id === "" && " · 来自环境变量，未纳入数据库管理"}
                            </CardDescription>
                          </div>
                          {b.id !== "" ? (
                            <div className="flex items-center gap-1.5">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => void handleTestR2Bucket(b.id, false)}
                              >
                                连通测试
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => void handleTestR2Bucket(b.id, true)}
                              >
                                读写测试
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => openR2BucketDialog(b)}
                                aria-label="编辑"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                onClick={() => void handleDeleteR2Bucket(b.id, b.name)}
                                aria-label="删除"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          ) : (
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                  openR2BucketDialog(undefined, {
                                    endpoint: b.endpoint,
                                    bucketName: b.bucketName,
                                  })
                                }
                              >
                                <Plus className="h-3.5 w-3.5" />
                                纳入管理
                              </Button>
                              {r2Data.assignableBuckets.length > 0 && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => {
                                    const first = r2Data.assignableBuckets[0]
                                    void handleAssignAll(first.id, first.name)
                                  }}
                                >
                                  用户迁入 {r2Data.assignableBuckets[0].name}
                                </Button>
                              )}
                            </div>
                          )}
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        {/* 存储用量：占免费额度百分比 */}
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-muted-foreground">存储占用（免费额度）</span>
                            <span className="font-medium">
                              {formatBytes(s.usedBytes)}
                              <span className="ml-1 text-xs text-muted-foreground">
                                / {formatBytes(r2Data.freeTier.storageBytes)}（
                                {s.storagePercent.toFixed(1)}%）
                              </span>
                            </span>
                          </div>
                          <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                            <div
                              className={`h-full rounded-full transition-all ${
                                s.storagePercent > 85
                                  ? "bg-destructive"
                                  : s.storagePercent > 60
                                    ? "bg-amber-500"
                                    : "bg-primary"
                              }`}
                              style={{ width: `${s.storagePercent}%` }}
                            />
                          </div>
                        </div>

                        {/* 容量分配 + 人数分配：仅用户网盘桶有意义 */}
                        {b.kind !== "platform" && b.maxUsers > 0 && (
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-muted-foreground">容量分配</span>
                              <span className="font-medium">
                                {formatBytes(s.usedBytes)}
                                <span className="ml-1 text-xs text-muted-foreground">
                                  / {formatBytes(s.capacityBytes)}（{capacityPct.toFixed(1)}%）
                                </span>
                              </span>
                            </div>
                            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full bg-emerald-500 transition-all"
                                style={{ width: `${capacityPct}%` }}
                              />
                            </div>
                          </div>
                        )}

                        {/* 人数分配 */}
                        {b.kind === "platform" ? (
                          <div className="grid grid-cols-2 gap-3">
                            <div className="rounded-md border px-3 py-2">
                              <p className="text-xs text-muted-foreground">用途</p>
                              <p className="text-sm font-semibold">名片 + 分享箱</p>
                            </div>
                            <div className="rounded-md border px-3 py-2">
                              <p className="text-xs text-muted-foreground">文件数</p>
                              <p className="text-sm font-semibold">{s.fileCount}</p>
                            </div>
                          </div>
                        ) : (
                          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                            <div className="rounded-md border px-3 py-2">
                              <p className="text-xs text-muted-foreground">已分配用户</p>
                              <p className="text-sm font-semibold">
                                {s.users} / {b.maxUsers || "—"}
                              </p>
                            </div>
                            <div className="rounded-md border px-3 py-2">
                              <p className="text-xs text-muted-foreground">文件数</p>
                              <p className="text-sm font-semibold">{s.fileCount}</p>
                            </div>
                            <div className="rounded-md border px-3 py-2">
                              <p className="text-xs text-muted-foreground">每人配额</p>
                              <p className="text-sm font-semibold">
                                {formatBytes(b.quotaPerUser)}
                              </p>
                            </div>
                            <div className="rounded-md border px-3 py-2">
                              <p className="text-xs text-muted-foreground">人数占用</p>
                              <p className="text-sm font-semibold">{userPct.toFixed(0)}%</p>
                            </div>
                          </div>
                        )}

                        {/* A/B 类操作数 */}
                        {b.id !== "" && (
                          <div className="space-y-2 rounded-md border p-3">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-medium">本月操作数</span>
                              {!ops?.configured && (
                                <span className="text-xs text-muted-foreground">
                                  {ops?.reason ?? "未接入 Analytics"}
                                </span>
                              )}
                              {ops?.error && (
                                <span className="text-xs text-destructive">
                                  {ops.error.slice(0, 60)}
                                </span>
                              )}
                            </div>
                            {ops?.configured && !ops.error && (
                              <>
                                <div className="space-y-1">
                                  <div className="flex items-center justify-between text-xs">
                                    <span className="text-muted-foreground">A 类操作</span>
                                    <span>
                                      {(ops.classA ?? 0).toLocaleString()} /{" "}
                                      {ops.freeTier.classAOps.toLocaleString()}（
                                      {(ops.classAPercent ?? 0).toFixed(1)}%）
                                    </span>
                                  </div>
                                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                                    <div
                                      className={`h-full rounded-full ${
                                        (ops.classAPercent ?? 0) > 85
                                          ? "bg-destructive"
                                          : "bg-primary"
                                      }`}
                                      style={{ width: `${ops.classAPercent ?? 0}%` }}
                                    />
                                  </div>
                                </div>
                                <div className="space-y-1">
                                  <div className="flex items-center justify-between text-xs">
                                    <span className="text-muted-foreground">B 类操作</span>
                                    <span>
                                      {(ops.classB ?? 0).toLocaleString()} /{" "}
                                      {ops.freeTier.classBOps.toLocaleString()}（
                                      {(ops.classBPercent ?? 0).toFixed(1)}%）
                                    </span>
                                  </div>
                                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                                    <div
                                      className={`h-full rounded-full ${
                                        (ops.classBPercent ?? 0) > 85
                                          ? "bg-destructive"
                                          : "bg-emerald-500"
                                      }`}
                                      style={{ width: `${ops.classBPercent ?? 0}%` }}
                                    />
                                  </div>
                                </div>
                              </>
                            )}
                          </div>
                        )}

                        {/* 用户列表 + 改派 */}
                        {b.users.length > 0 && (
                          <div className="space-y-1">
                            <p className="text-xs font-medium text-muted-foreground">
                              已分配用户（点击「改派」可迁移到其他桶，仅改归属不搬文件）
                            </p>
                            <div className="divide-y rounded-md border">
                              {b.users.map((u) => (
                                <div
                                  key={u.userId}
                                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                                >
                                  <div className="flex min-w-0 items-center gap-2">
                                    <span className="font-mono">{u.username}</span>
                                    {!u.enabled && (
                                      <Badge variant="secondary" className="text-xs">
                                        已停用
                                      </Badge>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-3">
                                    <span className="text-xs text-muted-foreground">
                                      {formatBytes(u.usedBytes)} / {formatBytes(u.quotaBytes)} ·{" "}
                                      {u.fileCount} 文件
                                    </span>
                                    {b.id !== "" && (
                                      <>
                                        <Select
                                          value={assignTarget[u.username] ?? b.id}
                                          onValueChange={(v) =>
                                            setAssignTarget((p) => ({
                                              ...p,
                                              [u.username]: v,
                                            }))
                                          }
                                        >
                                          <SelectTrigger className="h-7 w-32 text-xs">
                                            <SelectValue />
                                          </SelectTrigger>
                                          <SelectContent>
                                            {r2Data.assignableBuckets.map((ab) => (
                                              <SelectItem key={ab.id} value={ab.id}>
                                                {ab.name}
                                              </SelectItem>
                                            ))}
                                          </SelectContent>
                                        </Select>
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          className="h-7 text-xs"
                                          onClick={() =>
                                            void handleAssignBucket(
                                              u.username,
                                              assignTarget[u.username] ?? b.id
                                            )
                                          }
                                        >
                                          改派
                                        </Button>
                                      </>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  )
                }
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="community">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="relative max-w-xs flex-1">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="按用户名筛选"
                value={communityUserFilter}
                onChange={(e) => setCommunityUserFilter(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void loadCommunity() }}
                className="pl-8"
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={communityShowDeleted}
                onCheckedChange={(v) => { setCommunityShowDeleted(v); }}
              />
              显示已删帖
            </label>
            <Button variant="outline" size="sm" onClick={() => void loadCommunity()}>
              <RefreshCw className="h-4 w-4" />
              刷新
            </Button>
          </div>

          {communityLoading ? (
            <LoadingBlock />
          ) : communityPosts.length === 0 ? (
            <EmptyState
              icon={MessagesSquare}
              title="没有帖子"
              description="当前筛选条件下没有社区帖子。"
            />
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-32">作者</TableHead>
                    <TableHead>内容</TableHead>
                    <TableHead className="w-28">时间</TableHead>
                    <TableHead className="w-28">互动</TableHead>
                    <TableHead className="w-20">状态</TableHead>
                    <TableHead className="w-24">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {communityPosts.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">
                        {p.nickname || p.username}
                        <div className="text-xs text-muted-foreground">@{p.username}</div>
                      </TableCell>
                      <TableCell className="max-w-xs truncate" title={p.body}>
                        {p.body}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {fmtTime(p.created_at)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {p.like_count} 赞 · {p.comment_count} 评 · {p.share_count} 转
                      </TableCell>
                      <TableCell>
                        {p.deleted_at ? (
                          <Badge variant="destructive">已删</Badge>
                        ) : (
                          <Badge variant="secondary">正常</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {p.deleted_at ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleRestoreCommunityPost(p.id)}
                          >
                            <RotateCcw className="h-4 w-4" />
                            恢复
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleDeleteCommunityPost(p.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                            删除
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="newapi">
          <div className="space-y-6">
            {/* 管理员凭据：NewAPI 的「系统访问令牌」会被后台轮换，旧令牌立即失效，
                这里允许直接在网页上验证并替换，不必重跑 wrangler secret put。 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">管理员凭据（系统访问令牌）</CardTitle>
                <CardDescription>
                  NewAPI 后台每次「生成 / 重新生成」系统访问令牌都会覆盖旧值，旧令牌随即失效，
                  本站的管理员级调用（建号、查账号、设额度、健康检查）会全部报令牌无效。
                  在此粘贴新令牌即可恢复，无需重新部署。
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {newapiCredLoading ? (
                  <LoadingBlock />
                ) : (
                  <>
                    <div className="space-y-1 rounded-md border p-3 text-sm">
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground">当前来源</span>
                        {newapiCred?.source === "db" ? (
                          <Badge variant="secondary">管理面板设置（优先）</Badge>
                        ) : newapiCred?.source === "env" ? (
                          <Badge variant="outline">Worker 环境变量</Badge>
                        ) : (
                          <Badge variant="destructive">未配置</Badge>
                        )}
                        {newapiCred?.configured ? (
                          <Badge variant="secondary">已启用</Badge>
                        ) : (
                          <Badge variant="destructive">不可用</Badge>
                        )}
                      </div>
                      <p className="text-muted-foreground">
                        站点地址：{newapiCred?.baseUrl || "（未配置 NEWAPI_BASE_URL）"}
                      </p>
                      <p className="font-mono text-xs">
                        当前令牌：{newapiCred?.maskedToken ?? "（未设置）"}
                      </p>
                      <p className="text-muted-foreground">
                        令牌所属用户 id：{newapiCred?.adminUserId ?? "1"}
                        {newapiCred?.updatedAt
                          ? ` · 更新于 ${new Date(newapiCred.updatedAt).toLocaleString("zh-CN")}`
                          : ""}
                      </p>
                      {/* 真实探测一次管理接口：NewAPI 的令牌会被后台轮换，
                          不主动测就只能等用户建 Key 时才发现已经失效 */}
                      <p className="flex items-center gap-1.5">
                        <span className="text-muted-foreground">连通性</span>
                        {newapiCred?.health?.ok ? (
                          <span className="flex items-center gap-1 text-emerald-600">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            令牌有效
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-destructive">
                            <XCircle className="h-3.5 w-3.5" />
                            {newapiCred?.health?.message || "未知"}
                          </span>
                        )}
                      </p>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-2 sm:col-span-2">
                        <Label htmlFor="newapiNewToken">新的访问令牌</Label>
                        <Input
                          id="newapiNewToken"
                          type="password"
                          autoComplete="off"
                          placeholder="在 NewAPI「个人设置 → 安全设置 → 系统访问令牌」复制"
                          value={newapiNewToken}
                          onChange={(e) => setNewapiNewToken(e.target.value)}
                        />
                        <p className="text-xs text-muted-foreground">
                          提交前会先真实调用一次中转站管理接口验证；验证不通过不会覆盖现有凭据。
                          令牌加密存储，明文不回传。
                        </p>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="newapiAdminUserId">令牌所属用户 id</Label>
                        <Input
                          id="newapiAdminUserId"
                          inputMode="numeric"
                          value={newapiUserId}
                          onChange={(e) => setNewapiUserId(e.target.value)}
                        />
                        <p className="text-xs text-muted-foreground">
                          root 账户通常为 1；该值会作为 New-Api-User 头下发。
                        </p>
                      </div>
                    </div>

                    <div className="flex justify-end">
                      <Button
                        onClick={() => void handleUpdateNewApiToken()}
                        disabled={newapiCredBusy || !newapiNewToken.trim()}
                      >
                        {newapiCredBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                        验证并更新令牌
                      </Button>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            {/* 开通策略：与原「设置」标签里的 AI 中转站卡片同一份状态 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">AI 中转站</CardTitle>
                <CardDescription>
                  仅影响新开通的账号。当前{" "}
                  {settingsStats?.newapiAccounts ?? 0} 个账号、
                  {settingsStats?.newapiKeys ?? 0} 个 Key。
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="trialQuota">
                      新账号试用额度（{currencySymbol}）
                    </Label>
                    <Input
                      id="trialQuota"
                      type="number"
                      min={0}
                      step="0.5"
                      value={trialQuotaUsd}
                      onChange={(e) => setTrialQuotaUsd(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="newapiGroup">默认分组</Label>
                    <Input
                      id="newapiGroup"
                      value={newapiGroup}
                      onChange={(e) => setNewapiGroup(e.target.value)}
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between rounded-md border p-3">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">新账号不限额度</p>
                    <p className="text-xs text-muted-foreground">
                      开启后忽略上面的试用额度
                    </p>
                  </div>
                  <Switch
                    checked={newapiUnlimited}
                    onCheckedChange={setNewapiUnlimited}
                  />
                </div>
                <div className="flex items-center justify-between rounded-md border p-3">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">启用 AI 中转站</p>
                    <p className="text-xs text-muted-foreground">
                      关闭后用户无法开通或创建 Key
                    </p>
                  </div>
                  <Switch
                    checked={newapiEnabled}
                    onCheckedChange={setNewapiEnabled}
                  />
                </div>
                <div className="flex justify-end">
                  <Button
                    onClick={() => void handleSaveSettings()}
                    disabled={settingsBusy}
                  >
                    {settingsBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                    保存设置
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* 推荐模型：用户在 AI 页看到的「第一梯队 / 第二梯队」就是这份 */}
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <CardTitle className="text-base">推荐模型</CardTitle>
                    <CardDescription>
                      用户在「AI 中转站」页看到的推荐分档。数组顺序即梯队顺序
                      （第一梯队在最上），梯队之间会显示向下的箭头。留空则不显示该区块。
                      本标签页的设置共用一份提交，任一处保存都会一并写入。
                    </CardDescription>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setRecommendedTiers((t) => [
                        ...t,
                        { tier: `第${t.length + 1}梯队`, desc: "", models: [] },
                      ])
                    }
                    disabled={recommendedTiers.length >= 8}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    添加梯队
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {recommendedTiers.length === 0 ? (
                  <p className="rounded-md border border-dashed py-6 text-center text-sm text-muted-foreground">
                    还没有推荐分档。点右上角「添加梯队」开始配置。
                  </p>
                ) : (
                  recommendedTiers.map((t, i) => (
                    <div key={i} className="space-y-3 rounded-lg border p-3.5">
                      <div className="flex items-center gap-2">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground">
                          {i + 1}
                        </span>
                        <Input
                          value={t.tier}
                          placeholder="梯队名，如：第一梯队"
                          maxLength={20}
                          className="h-8 flex-1"
                          onChange={(e) =>
                            setRecommendedTiers((list) =>
                              list.map((x, idx) =>
                                idx === i ? { ...x, tier: e.target.value } : x
                              )
                            )
                          }
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={() =>
                            setRecommendedTiers((list) =>
                              list.filter((_, idx) => idx !== i)
                            )
                          }
                          title="删除该梯队"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>

                      <Input
                        value={t.desc}
                        placeholder="一句话说明（可选），如：综合最强，日常首选"
                        maxLength={120}
                        className="h-8 text-sm"
                        onChange={(e) =>
                          setRecommendedTiers((list) =>
                            list.map((x, idx) =>
                              idx === i ? { ...x, desc: e.target.value } : x
                            )
                          )
                        }
                      />

                      <div className="space-y-2">
                        <div className="flex flex-wrap gap-1.5">
                          {t.models.length === 0 ? (
                            <span className="text-xs text-muted-foreground">
                              还没有模型
                            </span>
                          ) : (
                            t.models.map((m) => (
                              <Badge
                                key={m}
                                variant="outline"
                                className="gap-1 font-mono text-xs"
                              >
                                {m}
                                <button
                                  type="button"
                                  className="text-muted-foreground hover:text-destructive"
                                  onClick={() =>
                                    setRecommendedTiers((list) =>
                                      list.map((x, idx) =>
                                        idx === i
                                          ? {
                                              ...x,
                                              models: x.models.filter((mm) => mm !== m),
                                            }
                                          : x
                                      )
                                    )
                                  }
                                  aria-label={`移除 ${m}`}
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              </Badge>
                            ))
                          )}
                        </div>
                        {/* 候选来自中转站 pricing；拉不到时降级为手输 */}
                        {modelOptions.length > 0 ? (
                          <div className="flex gap-2">
                            <Select
                              value=""
                              onValueChange={(m) =>
                                setRecommendedTiers((list) =>
                                  list.map((x, idx) =>
                                    idx === i && !x.models.includes(m)
                                      ? { ...x, models: [...x.models, m] }
                                      : x
                                  )
                                )
                              }
                            >
                              <SelectTrigger className="h-8 flex-1 text-xs">
                                <SelectValue placeholder="从中转站模型里选择…" />
                              </SelectTrigger>
                              <SelectContent>
                                {modelOptions
                                  .filter((m) => !t.models.includes(m))
                                  .map((m) => (
                                    <SelectItem key={m} value={m} className="font-mono text-xs">
                                      {m}
                                    </SelectItem>
                                  ))}
                              </SelectContent>
                            </Select>
                          </div>
                        ) : (
                          <Input
                            placeholder="手动输入模型名后按回车添加"
                            className="h-8 font-mono text-xs"
                            onKeyDown={(e) => {
                              if (e.key !== "Enter") return
                              e.preventDefault()
                              const v = e.currentTarget.value.trim()
                              if (!v) return
                              setRecommendedTiers((list) =>
                                list.map((x, idx) =>
                                  idx === i && !x.models.includes(v)
                                    ? { ...x, models: [...x.models, v] }
                                    : x
                                )
                              )
                              e.currentTarget.value = ""
                            }}
                          />
                        )}
                      </div>
                    </div>
                  ))
                )}
                {/* 推荐模型走的是同一个 handleSaveSettings（整个 newapi 标签页共用一份
                    payload），但只靠上面「AI 中转站」卡片里那个按钮太不显眼，这里再给一个
                    就近入口。 */}
                <div className="flex justify-end">
                  <Button
                    onClick={() => void handleSaveSettings()}
                    disabled={settingsBusy}
                  >
                    {settingsBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                    保存推荐模型
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="wb2api">
          <div className="space-y-6">
            {/* 通道开关与限额：走全局设置接口，与「设置」标签一起保存 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">捐献通道设置</CardTitle>
                <CardDescription>
                  关闭通道后，捐献页不再显示「反代账号」卡（已绑定的账号仍留在网关池中）。
                  这些设置与「设置」标签共用同一个保存接口，改完点下面的保存即可。
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between rounded-md border px-4 py-3">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">开启捐献通道</p>
                    <p className="text-xs text-muted-foreground">
                      允许用户登录 WorkBuddy 账号换取 AI 中转站权限
                    </p>
                  </div>
                  <Switch checked={wb2apiEnabled} onCheckedChange={setWb2apiEnabled} />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="wb2apiLimit">每人可绑定上限</Label>
                    <Input
                      id="wb2apiLimit"
                      type="number"
                      min={1}
                      value={wb2apiMaxBindings}
                      onChange={(e) => setWb2apiMaxBindings(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      绑定即自动解锁 AI 权限且免审核，故需要上限防止刷额度
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="wb2apiBaseUrl">网关地址</Label>
                    <Input
                      id="wb2apiBaseUrl"
                      placeholder="https://wb2api.doulor.cn"
                      value={wb2apiBaseUrl}
                      onChange={(e) => setWb2apiBaseUrl(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      留空则用内置默认值
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label>对接域</Label>
                    <Select
                      value={wb2apiRealm}
                      onValueChange={(v) => setWb2apiRealm(v as "cn" | "global")}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="cn">国内版（cn）</SelectItem>
                        <SelectItem value="global">国际版（global）</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      决定用户贡献的 WorkBuddy 账号对接哪个域，默认国内版。
                    </p>
                  </div>
                </div>
                <Button
                  onClick={() => void handleSaveSettings()}
                  disabled={settingsBusy}
                >
                  {settingsBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                  保存通道设置
                </Button>
              </CardContent>
            </Card>

            {/* 网关访问密钥：反代网关面板的 api_key 可能被随时改，允许在网页上验证并替换 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">网关访问密钥</CardTitle>
                <CardDescription>
                  捐献页让用户登录自己的 WorkBuddy {realmLabel(wb2apiRealm)}账号来解锁 AI 权限，
                  本站需要持有反代网关面板的访问密钥（Bearer）才能代为发起登录与轮询。
                  密钥会先做一次真实探测，通过后才加密入库。
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {wb2apiLoading ? (
                  <LoadingBlock />
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <Badge
                        variant={
                          wb2apiConfig?.source === "db"
                            ? "success"
                            : wb2apiConfig?.source === "env"
                              ? "secondary"
                              : "destructive"
                        }
                      >
                        {wb2apiConfig?.source === "db"
                          ? "已在线配置"
                          : wb2apiConfig?.source === "env"
                            ? "来自环境变量"
                            : "未配置"}
                      </Badge>
                      <span className="font-mono text-xs text-muted-foreground">
                        {wb2apiConfig?.maskedApiKey ?? "（无）"}
                      </span>
                      {wb2apiConfig?.updatedAt && (
                        <span className="text-xs text-muted-foreground">
                          更新于 {fmtTime(wb2apiConfig.updatedAt)}
                        </span>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="text-muted-foreground">网关地址：</span>
                      <span className="font-mono text-xs">
                        {wb2apiConfig?.baseUrl || "（未配置）"}
                      </span>
                      <span className="text-muted-foreground">
                        · 通道{wb2apiConfig?.enabled ? "已开启" : "已关闭"} ·
                        每人上限 {wb2apiConfig?.limit ?? "-"}
                      </span>
                    </div>

                    {wb2apiConfig?.health && (
                      <p
                        className={
                          "flex items-start gap-2 text-sm " +
                          (wb2apiConfig.health.ok
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-destructive")
                        }
                      >
                        {wb2apiConfig.health.ok ? (
                          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                        ) : (
                          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                        )}
                        {wb2apiConfig.health.message}
                      </p>
                    )}

                    <div className="space-y-2">
                      <Label htmlFor="wb2apiKey">更新访问密钥</Label>
                      <div className="flex gap-2">
                        <Input
                          id="wb2apiKey"
                          type="password"
                          placeholder="粘贴反代网关面板的 api_key"
                          value={wb2apiNewKey}
                          onChange={(e) => setWb2apiNewKey(e.target.value)}
                        />
                        <Button
                          onClick={() => void handleSaveWb2apiKey()}
                          disabled={wb2apiBusy || !wb2apiNewKey.trim()}
                        >
                          {wb2apiBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                          保存
                        </Button>
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            {/* 账号池概览：直接读网关的池状态，确认捐献的账号是否真的进池 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">网关账号池</CardTitle>
                <CardDescription>
                  账号池健康度来自网关自身，用于确认捐献的账号已正常入池。
                </CardDescription>
              </CardHeader>
              <CardContent>
                {!wb2apiPool ? (
                  <p className="text-sm text-muted-foreground">
                    暂无数据（密钥未配置或网关不可达）
                  </p>
                ) : (
                  <>
                    <div className="mb-4 flex flex-wrap gap-4 text-sm">
                      <span>
                        总数 <span className="font-semibold">{wb2apiPool.total}</span>
                      </span>
                      <span className="text-emerald-600 dark:text-emerald-400">
                        可用 <span className="font-semibold">{wb2apiPool.healthy}</span>
                      </span>
                      <span className="text-amber-600 dark:text-amber-400">
                        冷却 <span className="font-semibold">{wb2apiPool.cooling}</span>
                      </span>
                      <span className="text-muted-foreground">
                        禁用 <span className="font-semibold">{wb2apiPool.disabled}</span>
                      </span>
                    </div>
                    {wb2apiPool.accounts.length > 0 && (
                      <div className="divide-y rounded-md border">
                        {wb2apiPool.accounts.map((a) => (
                          <div
                            key={a.uid}
                            className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm"
                          >
                            <span>{a.nickname || a.uid}</span>
                            {a.realm && <Badge variant="outline">{realmLabel(a.realm)}</Badge>}
                            <span className="ml-auto font-mono text-xs text-muted-foreground">
                              {typeof a.credits === "number" ? `积分 ${a.credits}` : ""}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>

            {/* 绑定列表：谁捐了哪个账号，可摘除 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  捐献绑定（{wb2apiBindings.length}）
                </CardTitle>
                <CardDescription>
                  摘除绑定时会尝试从网关账号池移除该账号。
                  「AI 权限」一列表示该绑定当时是否新授予了权限 ——
                  若该用户还有其它捐献依据（其他绑定 / 已通过的 AI 渠道捐献），
                  默认会保留其权限，可在弹窗中勾选强制收回。
                </CardDescription>
              </CardHeader>
              <CardContent>
                {wb2apiBindings.length === 0 ? (
                  <EmptyState
                    icon={Unplug}
                    title="还没有捐献绑定"
                    description="用户在「捐献」页登录 WorkBuddy 账号后会出现在这里。"
                  />
                ) : (
                  <div className="divide-y rounded-md border">
                    {wb2apiBindings.map((b) => (
                      <div
                        key={b.id}
                        className="flex flex-wrap items-center gap-2 px-4 py-3"
                      >
                        <span className="text-sm font-medium">{b.username}</span>
                        <span className="text-sm">{b.nickname || b.uid}</span>
                        <Badge variant={b.status === "active" ? "success" : "secondary"}>
                          {b.status === "active" ? "使用中" : "已移除"}
                        </Badge>
                        <Badge variant={b.grantedAi ? "outline" : "secondary"}>
                          {b.grantedAi ? "AI 权限由本次授予" : "未授予（此前已有）"}
                        </Badge>
                        <span className="ml-auto text-xs text-muted-foreground">
                          {fmtTime(b.createdAt)}
                        </span>
                        {b.status === "active" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground hover:text-destructive"
                            onClick={() => {
                              // 默认勾选 = 服务端的自动判定结果（无其他依据则收回）
                              setWb2apiRevokeAi(b.grantedAi)
                              setWb2apiRemoving(b)
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                            摘除
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="oauth">
          <OAuthAdminPanel />
        </TabsContent>

        <TabsContent value="analytics">
          <AnalyticsPanel />
        </TabsContent>

        <TabsContent value="settings">
          {settingsLoading ? (
            <LoadingBlock />
          ) : (
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">子域名配额</CardTitle>
                  <CardDescription>
                    每个用户默认可创建的一级子域名数量（不含注册时分配的主域名）。
                    可在成员详情里为单个用户单独调整。
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="subQuota">默认数量</Label>
                    <Input
                      id="subQuota"
                      type="number"
                      min={0}
                      max={100}
                      className="w-32"
                      value={subQuota}
                      onChange={(e) => setSubQuota(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      一级子域名形如 xxx.doulor.cn（至少 3 位）；其下还可各建 5 个二级域名。
                    </p>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">网盘配额</CardTitle>
                  <CardDescription>
                    仅影响新开通的网盘；已开通用户的配额保持不变。
                    当前 {settingsStats?.storageAccounts ?? 0} 个网盘，
                    占用 {formatBytes(settingsStats?.storageUsedBytes ?? 0)}。
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="storageQuota">默认存储配额（GB）</Label>
                      <Input
                        id="storageQuota"
                        type="number"
                        min={1}
                        value={quotaGb}
                        onChange={(e) => setQuotaGb(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="maxFile">单文件上限（MB）</Label>
                      <Input
                        id="maxFile"
                        type="number"
                        min={1}
                        value={maxFileMb}
                        onChange={(e) => setMaxFileMb(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium">启用网盘功能</p>
                      <p className="text-xs text-muted-foreground">
                        关闭后用户无法开通或上传（已有直链仍可访问）
                      </p>
                    </div>
                    <Switch
                      checked={storageEnabled}
                      onCheckedChange={setStorageEnabled}
                    />
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleRecalculate()}
                    disabled={settingsBusy}
                  >
                    {settingsBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    <RefreshCw className="h-3.5 w-3.5" />
                    重算所有用户用量
                  </Button>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">内网穿透</CardTitle>
                  <CardDescription>
                    核心包下载地址与「新申请」通知邮箱。
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="frpCoreUrl">frp 核心包下载地址</Label>
                    <Input
                      id="frpCoreUrl"
                      value={frpCoreUrl}
                      onChange={(e) => setFrpCoreUrl(e.target.value)}
                      className="font-mono text-xs"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="frpNotify">管理员通知邮箱</Label>
                    <Select
                      value={frpNotifyEmail || "__none__"}
                      onValueChange={(v) =>
                        setFrpNotifyEmail(v === "__none__" ? "" : v)
                      }
                    >
                      <SelectTrigger id="frpNotify">
                        <SelectValue placeholder="选择接收申请的邮箱" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">不接收通知</SelectItem>
                        {notifyEmailOptions.map((e) => (
                          <SelectItem key={e} value={e}>
                            {e}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      用户提交内网穿透申请时会发信到这里。
                      候选项来自「已在 Cloudflare 验证的邮箱」与「管理员的真实邮箱」；
                      留空则不发送通知。
                    </p>
                  </div>
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium">启用内网穿透</p>
                      <p className="text-xs text-muted-foreground">
                        关闭后用户无法启用或提交申请
                      </p>
                    </div>
                    <Switch
                      checked={frpEnabled}
                      onCheckedChange={setFrpEnabled}
                    />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">临时分享箱</CardTitle>
                  <CardDescription>
                    无需注册即可查看/下载，上传权限可单独控制；文件到点自动失效。
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div className="space-y-2">
                      <Label htmlFor="tempboxMinutes">默认保存时长（分钟）</Label>
                      <Input
                        id="tempboxMinutes"
                        type="number"
                        min={1}
                        value={tempboxMinutes}
                        onChange={(e) => setTempboxMinutes(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="tempboxMaxFile">单次上传上限（MB）</Label>
                      <Input
                        id="tempboxMaxFile"
                        type="number"
                        min={1}
                        value={tempboxMaxFileMb}
                        onChange={(e) => setTempboxMaxFileMb(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="tempboxMaxFiles">每接收码文件数上限</Label>
                      <Input
                        id="tempboxMaxFiles"
                        type="number"
                        min={1}
                        value={tempboxMaxFiles}
                        onChange={(e) => setTempboxMaxFiles(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium">上传需登录</p>
                      <p className="text-xs text-muted-foreground">
                        关闭后访客无需登录也可上传（查看/下载始终无需登录）
                      </p>
                    </div>
                    <Switch
                      checked={tempboxUploadLogin}
                      onCheckedChange={setTempboxUploadLogin}
                    />
                  </div>
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium">启用临时分享箱</p>
                      <p className="text-xs text-muted-foreground">
                        关闭后页面提示不可用，已生成的内容照常失效
                      </p>
                    </div>
                    <Switch
                      checked={tempboxEnabled}
                      onCheckedChange={setTempboxEnabled}
                    />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">社区广场</CardTitle>
                  <CardDescription>
                    用户发帖、评论、点赞的公共社区；关闭后页面提示不可用。
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="communityPostMaxImages">每帖图片上限</Label>
                      <Input
                        id="communityPostMaxImages"
                        type="number"
                        min={0}
                        max={9}
                        value={communityPostMaxImages}
                        onChange={(e) => setCommunityPostMaxImages(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="communityImageMaxKb">单图大小上限（KB）</Label>
                      <Input
                        id="communityImageMaxKb"
                        type="number"
                        min={1}
                        value={communityImageMaxKb}
                        onChange={(e) => setCommunityImageMaxKb(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium">允许访客访问帖子广场</p>
                      <p className="text-xs text-muted-foreground">
                        关闭后未登录用户访问社区会被引导去登录页
                      </p>
                    </div>
                    <Switch
                      checked={communityGuestAccess}
                      onCheckedChange={setCommunityGuestAccess}
                    />
                  </div>
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium">启用社区广场</p>
                      <p className="text-xs text-muted-foreground">
                        关闭后用户无法访问社区页面
                      </p>
                    </div>
                    <Switch
                      checked={communityEnabled}
                      onCheckedChange={setCommunityEnabled}
                    />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">邀请码模块权限</CardTitle>
                  <CardDescription>
                    每个模块可设为「基础权限」或「受限模式」。
                    基础权限：创建邀请码时人人可勾选，不消耗模块额度。
                    受限模式：需消耗模块额度（捐献获批或手动发放）。
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {Object.keys(inviteBasic).map((f) => (
                    <div
                      key={f}
                      className="flex items-center justify-between rounded-md border p-3"
                    >
                      <div className="space-y-0.5">
                        <p className="text-sm font-medium">
                          {FEATURE_LABELS[f as FeatureKey] ?? f}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {inviteBasic[f]
                            ? "基础权限：创建邀请码时人人可勾选，不消耗模块额度"
                            : "受限模式：勾选需消耗模块额度（捐献获批或管理员发放）"}
                        </p>
                      </div>
                      <Switch
                        checked={inviteBasic[f] ?? false}
                        onCheckedChange={(v) =>
                          setInviteBasic((prev) => ({ ...prev, [f]: v }))
                        }
                      />
                    </div>
                  ))}
                  <p className="text-xs text-muted-foreground">
                    基础权限的模块不消耗额度；受限模块靠捐献或手动发放获取转授额度。
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">免权限访问</CardTitle>
                  <CardDescription>
                    打开某个模块，则该模块不再检查用户权限 —— 没有该权限的人也能正常访问、开通与使用，
                    相当于把该模块对所有人开放。默认全关（按权限卡）。
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {Object.keys(openFeatures).map((f) => (
                    <div
                      key={f}
                      className="flex items-center justify-between rounded-md border p-3"
                    >
                      <div className="space-y-0.5">
                        <p className="text-sm font-medium">
                          {FEATURE_LABELS[f as FeatureKey] ?? f}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {openFeatures[f]
                            ? "已开放：任何人都能访问与启用，不检查该模块权限"
                            : "按权限卡：需拥有该模块权限才能访问（管理员不受限）"}
                        </p>
                      </div>
                      <Switch
                        checked={openFeatures[f] ?? false}
                        onCheckedChange={(v) =>
                          setOpenFeatures((prev) => ({ ...prev, [f]: v }))
                        }
                      />
                    </div>
                  ))}
                  <p className="text-xs text-muted-foreground">
                    只旁路「访问时的权限校验」：不会改动任何用户的权限数据，关掉开关即恢复按权限卡。
                    也不影响各模块自己的「启用」总开关，与上方邀请码权限设置互不相关。
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">捐献自动审核</CardTitle>
                  <CardDescription>
                    打开某个模块后，用户提交该模块的捐献会**当场自动审核**（能用的自动通过并解锁，
                    全部无效则自动拒绝并写明原因），不再进管理员的待审核队列。关闭则回到人工审核。
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {Object.keys(autoReview).map((f) => (
                    <div
                      key={f}
                      className="flex items-center justify-between rounded-md border p-3"
                    >
                      <div className="space-y-0.5">
                        <p className="text-sm font-medium">
                          {FEATURE_LABELS[f as FeatureKey] ?? f}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {f === "ai"
                            ? "自动探测上游 + 逐个测模型，只留可用的；全不可用则自动拒绝"
                            : f === "proxy"
                              ? "逐个真实拉取订阅链接，能解析出节点的才导入；全无效则自动拒绝"
                              : "仅校验 config.yml 的语法与必填字段（frpc↔frps 是私有 TCP 协议，Worker 只能发 HTTP，验证不了连通性）"}
                        </p>
                      </div>
                      <Switch
                        checked={autoReview[f] ?? false}
                        onCheckedChange={(v) =>
                          setAutoReview((prev) => ({ ...prev, [f]: v }))
                        }
                      />
                    </div>
                  ))}
                  <p className="text-xs text-muted-foreground">
                    AI 与代理能「真的调一次」验证可用性，判定可靠；内网穿透的 config.yml
                    虽指向公网 frps，但 frpc↔frps 是私有 TCP 协议、不是 HTTP，
                    本站后端出站只能发 HTTP/HTTPS、连不了 TCP 端口，验证不了连通性，
                    只能做语法/字段静态校验。默认建议保持关闭。
                    自动拒绝的单据仍可在「捐献」页里人工复核通过。
                  </p>
                </CardContent>
              </Card>

              <div className="flex justify-end">
                <Button onClick={() => void handleSaveSettings()} disabled={settingsBusy}>
                  {settingsBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                  保存设置
                </Button>
              </div>
            </div>
          )}
        </TabsContent>
          </div>
        </div>
      </Tabs>

      {/* 摘除反代捐献绑定 */}
      <Dialog
        open={wb2apiRemoving !== null}
        onOpenChange={(o) => {
          if (!o) setWb2apiRemoving(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>摘除捐献绑定</DialogTitle>
            <DialogDescription>
              将从网关账号池移除 {wb2apiRemoving?.nickname || wb2apiRemoving?.uid}
              （捐献者 {wb2apiRemoving?.username}）。
              网关侧移除失败时本地仍会标记为已移除，并提示失败原因。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="flex cursor-pointer items-start gap-3 rounded-md border px-4 py-3">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                checked={wb2apiRevokeAi}
                onChange={(e) => setWb2apiRevokeAi(e.target.checked)}
              />
              <span className="text-sm">
                同时收回该用户的「AI 中转站」权限
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  默认按「还有其它捐献依据就保留」自动判定。
                  若该用户的权限来自邀请码（本站无法溯源），需要在此手动勾选才会收回。
                </span>
              </span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWb2apiRemoving(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleRemoveWb2apiBinding()}
              disabled={wb2apiBusy}
            >
              {wb2apiBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              确认摘除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 编辑邀请码权限 */}
      <Dialog
        open={permInvite !== null}
        onOpenChange={(o) => {
          if (!o) {
            setPermInvite(null)
            setPermDraft(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑邀请码权限</DialogTitle>
            <DialogDescription>
              {permInvite?.code} · 只影响之后用该码注册的新账号；
              已注册用户的权限请在其详情里单独修改。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {FEATURES.map((f) => (
              <div
                key={f.key}
                className="flex items-center justify-between rounded-md border px-4 py-3"
              >
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">{f.label}</p>
                  <p className="text-xs text-muted-foreground">{f.desc}</p>
                </div>
                <Switch
                  checked={permDraft?.[f.key] ?? false}
                  onCheckedChange={(v) =>
                    setPermDraft((d) => (d ? { ...d, [f.key]: v } : d))
                  }
                />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setPermInvite(null)
                setPermDraft(null)
              }}
            >
              取消
            </Button>
            <Button onClick={() => void handleSaveInvitePerms()} disabled={permBusy}>
              {permBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 用户邀请码详情 */}
      <Dialog
        open={quotaDetail !== null}
        onOpenChange={(o) => {
          if (!o) setQuotaDetail(null)
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          {quotaDetail && (
            <>
              <DialogHeader>
                <DialogTitle className="font-mono">
                  {quotaDetail.username} 的邀请码额度
                </DialogTitle>
                <DialogDescription>
                  可手动调整额度用于补偿或纠错；输入框失去焦点即保存。
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div className="rounded-md border p-3">
                  <p className="text-sm font-medium">邀请码额度</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    剩余 {quotaDetail.quota.inviteRemaining} / 共{" "}
                    {quotaDetail.quota.inviteTotal}（基础{" "}
                    {quotaDetail.quota.inviteBase} + 捐献{" "}
                    {quotaDetail.quota.inviteBonus}），已用{" "}
                    {quotaDetail.quota.inviteUsed}
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <Label className="text-xs">捐献额度</Label>
                    <Input
                      type="number"
                      min={0}
                      className="h-8 w-24"
                      disabled={quotaDetailBusy}
                      defaultValue={quotaDetail.quota.inviteBonus}
                      onBlur={(e) =>
                        void handleAdjustQuota(quotaDetail.username, {
                          inviteBonus: Number(e.target.value),
                        })
                      }
                    />
                  </div>
                </div>

                <div className="rounded-md border p-3">
                  <p className="text-sm font-medium">模块权限额度</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    决定该用户能给邀请码授予多少模块权限
                  </p>
                  <div className="mt-2 space-y-2">
                    {quotaDetail.quotaFeatures.map((f) => {
                      const isBasic =
                        quotaDetail.basicFeatures?.includes(f) ?? false
                      return (
                        <div key={f} className="flex items-center gap-2">
                          <Label className="w-24 text-xs">
                            {quotaDetail.featureLabels[f]}
                          </Label>
                          {isBasic ? (
                            <span className="text-xs text-muted-foreground">
                              基础权限（不消耗额度）
                            </span>
                          ) : (
                            <>
                              <Input
                                type="number"
                                min={0}
                                className="h-8 w-24"
                                disabled={quotaDetailBusy}
                                defaultValue={
                                  quotaDetail.quota.featureQuota[
                                    f as keyof typeof quotaDetail.quota.featureQuota
                                  ]
                                }
                                onBlur={(e) =>
                                  void handleAdjustQuota(quotaDetail.username, {
                                    featureQuota: {
                                      [f]: Number(e.target.value),
                                    } as Partial<FeatureCounts>,
                                  })
                                }
                              />
                              <span className="text-xs text-muted-foreground">
                                已用{" "}
                                {
                                  quotaDetail.quota.featureUsed[
                                    f as keyof typeof quotaDetail.quota.featureUsed
                                  ]
                                }
                              </span>
                            </>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>

                <section>
                  <h3 className="mb-2 text-sm font-medium">
                    该用户创建的邀请码（{quotaDetail.invites.length}）
                  </h3>
                  {quotaDetail.invites.length === 0 ? (
                    <p className="rounded-md border px-3 py-4 text-sm text-muted-foreground">
                      无
                    </p>
                  ) : (
                    <div className="divide-y rounded-md border">
                      {quotaDetail.invites.map((inv) => {
                        const extra = quotaDetail.quotaFeatures.filter(
                          (f) => inv.permissions[f as keyof Permissions]
                        )
                        const used = inv.usedCount >= inv.maxUses
                        return (
                          <div
                            key={inv.id}
                            className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs"
                          >
                            <span className="font-mono">{inv.code}</span>
                            <Badge variant="outline">域名 · 邮箱 · 名片</Badge>
                            {extra.map((f) => (
                              <Badge
                                key={f}
                                variant={
                                  quotaDetail.basicFeatures?.includes(f)
                                    ? "outline"
                                    : "secondary"
                                }
                              >
                                {quotaDetail.featureLabels[f]}
                              </Badge>
                            ))}
                            <Badge variant={used ? "destructive" : "success"}>
                              {used ? "已使用" : "未使用"}
                            </Badge>
                            <span className="ml-auto text-muted-foreground">
                              {fmtTime(inv.createdAt)}
                            </span>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-destructive"
                              title="删除（未使用的会退还额度）"
                              onClick={async () => {
                                try {
                                  await adminApi.deleteInvite(inv.id)
                                  toast.success("已删除")
                                  void openQuotaDetail(quotaDetail.username)
                                  void loadInviteQuotas()
                                } catch (err) {
                                  toast.error(
                                    err instanceof HttpError
                                      ? err.message
                                      : "删除失败"
                                  )
                                }
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </section>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* 添加邀请码 */}
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加邀请码</DialogTitle>
            <DialogDescription>
              分享给他人用于注册。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="inviteCode">邀请码</Label>
              <Input
                id="inviteCode"
                placeholder="FRIENDS-02"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="inviteMax">可使用次数</Label>
              <Input
                id="inviteMax"
                type="number"
                min={1}
                max={1000}
                value={inviteMax}
                onChange={(e) => setInviteMax(e.target.value)}
              />
            </div>
            <div className="space-y-3">
              <Label>该码注册的账号可用功能</Label>
              {FEATURES.map((f) => (
                <div
                  key={f.key}
                  className="flex items-center justify-between rounded-md border p-3"
                >
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">{f.label}</p>
                    <p className="text-xs text-muted-foreground">{f.desc}</p>
                  </div>
                  <Switch
                    checked={invitePerms[f.key]}
                    onCheckedChange={(v) =>
                      setInvitePerms((prev) => ({ ...prev, [f.key]: v }))
                    }
                  />
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                未勾选的功能，用该码注册的账号将无法使用（管理员可事后在成员详情里调整）。
              </p>
            </div>
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

      {/* 公告编辑弹窗 */}
      <Dialog open={announcementOpen} onOpenChange={setAnnouncementOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{annDraft.id ? "编辑公告" : "发布公告"}</DialogTitle>
            <DialogDescription>
              用户在概览页「网站动态」可见，pinned 优先展示。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="annTitle">标题</Label>
              <Input
                id="annTitle"
                placeholder="如：新增内网穿透节点"
                value={annDraft.title}
                onChange={(e) => setAnnDraft((d) => ({ ...d, title: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="annBody">正文</Label>
              <Textarea
                id="annBody"
                placeholder="支持换行"
                rows={4}
                value={annDraft.body}
                onChange={(e) => setAnnDraft((d) => ({ ...d, body: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>分类</Label>
                <Select
                  value={annDraft.category}
                  onValueChange={(v) => setAnnDraft((d) => ({ ...d, category: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="general">公告</SelectItem>
                    <SelectItem value="frp">内网穿透</SelectItem>
                    <SelectItem value="ai">AI 中转站</SelectItem>
                    <SelectItem value="proxy">代理节点</SelectItem>
                    <SelectItem value="storage">网盘</SelectItem>
                    <SelectItem value="profile">名片</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end">
                <div className="flex w-full items-center justify-between rounded-md border p-3">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">置顶</p>
                    <p className="text-xs text-muted-foreground">优先展示在概览</p>
                  </div>
                  <Switch
                    checked={annDraft.pinned}
                    onCheckedChange={(v) => setAnnDraft((d) => ({ ...d, pinned: v }))}
                  />
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label>弹窗提醒</Label>
              <Select
                value={annDraft.popupMode}
                onValueChange={(v) => setAnnDraft((d) => ({ ...d, popupMode: v as "none" | "once" | "every" }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">不弹窗（仅概览显示）</SelectItem>
                  <SelectItem value="once">仅弹窗一次</SelectItem>
                  <SelectItem value="every">每次进入都弹（可「不再显示」）</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                弹窗提醒登录用户。用户关闭后，「仅一次」不再出现；「每次都弹」时用户可自行选择「不再显示」。
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAnnouncementOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void handleSaveAnnouncement()} disabled={announcementBusy}>
              {announcementBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              {annDraft.id ? "保存" : "发布"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* R2 桶编辑弹窗 */}
      <Dialog open={r2BucketOpen} onOpenChange={setR2BucketOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{r2EditId ? "编辑 R2 桶" : "添加 R2 桶"}</DialogTitle>
            <DialogDescription>
              {r2EditId
                ? "凭据与端点一般无需改动，通常只调人数上限与每人配额。"
                : "直接选一个桶即可 —— 端点、账户 ID 会自动填好，凭据用全局 token 无需填写。"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {/* 新建时：从已发现的桶里选（大幅简化填写） */}
            {!r2EditId && (
              <div className="space-y-2">
                <Label>选择桶</Label>
                {r2DiscoverLoading ? (
                  <p className="text-xs text-muted-foreground">正在读取账户与桶…</p>
                ) : r2Discovered?.available ? (
                  <>
                    <Select value={r2Pick} onValueChange={handlePickBucket}>
                      <SelectTrigger>
                        <SelectValue placeholder="选择一个桶" />
                      </SelectTrigger>
                      <SelectContent>
                        {r2Discovered.accounts.flatMap((a) =>
                          a.buckets.map((b) => (
                            <SelectItem
                              key={`${a.id}|${b.name}`}
                              value={`${a.id}|${b.name}`}
                              disabled={b.imported}
                            >
                              {a.name} / {b.name}
                              {b.imported ? "（已导入）" : ""}
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      列表来自全局 token 可访问的所有账户。也可以跳过此项，在下面手动填写。
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {r2Discovered?.reason ?? "无法自动发现，请在下面手动填写"}
                  </p>
                )}
              </div>
            )}

            {/* 桶类型：决定用途 */}
            <div className="space-y-2">
              <Label>桶类型</Label>
              <Select
                value={r2Draft.kind}
                onValueChange={(v) => setR2Draft((d) => ({ ...d, kind: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">用户网盘桶（存用户文件，参与分配）</SelectItem>
                  <SelectItem value="platform">平台数据桶（存名片/分享箱，全局唯一）</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {r2Draft.kind === "platform"
                  ? "平台数据桶只应有一个：存 profiles/（名片头像/背景/音乐）与 temporary/（分享箱）。不参与用户分配、不占用户配额。"
                  : "用户网盘桶：存 <用户名>/ 前缀的文件，新用户开通时自动分配到人数最少的桶。"}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="r2id">标识 id</Label>
                <Input
                  id="r2id"
                  placeholder="b2"
                  value={r2Draft.id}
                  disabled={Boolean(r2EditId)}
                  onChange={(e) => setR2Draft((d) => ({ ...d, id: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="r2name">显示名</Label>
                <Input
                  id="r2name"
                  placeholder="2 号桶 network2"
                  value={r2Draft.name}
                  onChange={(e) => setR2Draft((d) => ({ ...d, name: e.target.value }))}
                />
              </div>
            </div>
            <details className="rounded-md border" open={Boolean(r2EditId) || !r2Discovered?.available}>
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground">
                高级选项（端点 / 桶名 / 账户 ID / 凭据）— 选桶后已自动填好，一般无需改动
              </summary>
              <div className="space-y-4 border-t px-3 pb-3 pt-3">
                <div className="space-y-2">
                  <Label htmlFor="r2endpoint">S3 Endpoint</Label>
                  <Input
                    id="r2endpoint"
                    placeholder="https://<account>.r2.cloudflarestorage.com"
                    className="font-mono text-xs"
                    value={r2Draft.endpoint}
                    onChange={(e) => setR2Draft((d) => ({ ...d, endpoint: e.target.value }))}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="r2bucket">桶名</Label>
                    <Input
                      id="r2bucket"
                      placeholder="network2"
                      className="font-mono text-xs"
                      value={r2Draft.bucketName}
                      onChange={(e) => setR2Draft((d) => ({ ...d, bucketName: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="r2account">账户 ID</Label>
                    <Input
                      id="r2account"
                      placeholder="d20b3b86…"
                      className="font-mono text-xs"
                      value={r2Draft.accountId}
                      onChange={(e) => setR2Draft((d) => ({ ...d, accountId: e.target.value }))}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="r2ak">Access Key ID</Label>
                  <Input
                    id="r2ak"
                    placeholder={r2EditId ? "留空则不修改" : "留空 = 用全局 R2_API_TOKEN"}
                    className="font-mono text-xs"
                    value={r2Draft.accessKeyId}
                    onChange={(e) => setR2Draft((d) => ({ ...d, accessKeyId: e.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="r2sk">Secret Access Key</Label>
                  <Input
                    id="r2sk"
                    type="password"
                    placeholder={r2EditId ? "留空则不修改" : "留空 = 用全局 R2_API_TOKEN"}
                    className="font-mono text-xs"
                    value={r2Draft.secretAccessKey}
                    onChange={(e) => setR2Draft((d) => ({ ...d, secretAccessKey: e.target.value }))}
                  />
                </div>
              </div>
            </details>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-2">
                <Label htmlFor="r2max">人数上限</Label>
                <Input
                  id="r2max"
                  type="number"
                  min={1}
                  value={r2Draft.maxUsers}
                  onChange={(e) => setR2Draft((d) => ({ ...d, maxUsers: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="r2quota">每人配额（字节）</Label>
                <Input
                  id="r2quota"
                  type="number"
                  min={0}
                  value={r2Draft.quotaPerUser}
                  onChange={(e) => setR2Draft((d) => ({ ...d, quotaPerUser: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="r2sort">排序</Label>
                <Input
                  id="r2sort"
                  type="number"
                  value={r2Draft.sortOrder}
                  onChange={(e) => setR2Draft((d) => ({ ...d, sortOrder: e.target.value }))}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              每人配额 1073741824 字节 = 1 GiB。容量上限 = 人数上限 × 每人配额。
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setR2BucketOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void handleSaveR2Bucket()} disabled={r2Busy}>
              {r2Busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {r2EditId ? "保存" : "创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={detail !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDetail(null)
            setOpenedMessage(null)
          }
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <span className="font-mono">{detail.user.username}</span>
                  {detail.user.status === "suspended" ? (
                    <Badge variant="destructive">suspended</Badge>
                  ) : (
                    <Badge variant="success">active</Badge>
                  )}
                  {detail.user.role === "admin" && (
                    <Badge variant="secondary">admin</Badge>
                  )}
                </DialogTitle>
                <DialogDescription>
                  {detail.user.nickname ? `${detail.user.nickname} · ` : ""}
                  {detail.user.email} · 注册于 {fmtTime(detail.user.createdAt)}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                {/* ---- 账号：昵称 / 邮箱验证 / 通知 / 角色 ---- */}
                <section>
                  <h3 className="mb-2 text-sm font-medium">账号</h3>
                  <div className="space-y-2">
                    <div className="flex items-center gap-3 rounded-md border p-3">
                      <Input
                        className="max-w-xs"
                        value={nickDraft}
                        placeholder="未设置昵称"
                        disabled={busy || detail.user.username === user?.username}
                        onChange={(e) => setNickDraft(e.target.value)}
                      />
                      <span className="text-xs text-muted-foreground">
                        展示昵称（2-16 位中文/英文/数字/下划线，留空 = 清空）
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="ml-auto"
                        disabled={busy || detail.user.username === user?.username}
                        onClick={() => void handleSaveNickname()}
                      >
                        保存
                      </Button>
                    </div>

                    <div className="flex items-center justify-between rounded-md border p-3">
                      <div className="space-y-0.5">
                        <p className="text-sm font-medium">邮箱已验证</p>
                        <p className="text-xs text-muted-foreground">
                          {detail.user.email} · 验证后才能接收转发与通知
                        </p>
                      </div>
                      <Switch
                        checked={detail.user.emailVerified}
                        disabled={busy || detail.user.username === user?.username}
                        onCheckedChange={(v) =>
                          void handleToggleUserFlag("emailVerified", v)
                        }
                      />
                    </div>

                    <div className="flex items-center justify-between rounded-md border p-3">
                      <div className="space-y-0.5">
                        <p className="text-sm font-medium">接收通知邮件</p>
                        <p className="text-xs text-muted-foreground">
                          审批结果、系统公告等平台邮件的开关
                        </p>
                      </div>
                      <Switch
                        checked={detail.user.notifyEnabled}
                        disabled={busy || detail.user.username === user?.username}
                        onCheckedChange={(v) =>
                          void handleToggleUserFlag("notifyEnabled", v)
                        }
                      />
                    </div>

                    <div className="flex items-center justify-between rounded-md border p-3">
                      <div className="space-y-0.5">
                        <p className="text-sm font-medium">管理员</p>
                        <p className="text-xs text-muted-foreground">
                          设为管理员后可使用整个管理面板
                        </p>
                      </div>
                      <Switch
                        checked={detail.user.role === "admin"}
                        disabled={busy || detail.user.username === user?.username}
                        onCheckedChange={(v) =>
                          void handleToggleRole(v ? "admin" : "user")
                        }
                      />
                    </div>
                  </div>
                </section>

                {/* ---- 各模块用量与开通状态 ---- */}
                <section>
                  <h3 className="mb-2 text-sm font-medium">模块开通与用量</h3>
                  <div className="rounded-md border">
                    {/* 网盘 */}
                    <div className="border-b px-3 py-2 text-xs last:border-b-0">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">直链网盘</span>
                        {detail.storage ? (
                          <Badge variant={detail.storage.enabled ? "success" : "secondary"}>
                            {detail.storage.enabled ? "已开通" : "已停用"}
                          </Badge>
                        ) : (
                          <Badge variant="outline">未开通</Badge>
                        )}
                      </div>
                      {detail.storage && (
                        <p className="mt-1 text-muted-foreground">
                          {detail.storage.prefix}/ · {formatBytes(detail.storage.usedBytes)} /{" "}
                          {formatBytes(detail.storage.quotaBytes)} · {detail.storage.fileCount} 个文件
                          {detail.storage.bucketName && ` · 桶 ${detail.storage.bucketName}`}
                        </p>
                      )}
                    </div>

                    {/* AI 中转站 */}
                    <div className="border-b px-3 py-2 text-xs last:border-b-0">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">AI 中转站</span>
                        {detail.newapi ? (
                          <Badge variant="success">已开通</Badge>
                        ) : (
                          <Badge variant="outline">未开通</Badge>
                        )}
                      </div>
                      {detail.newapi && (
                        <p className="mt-1 text-muted-foreground">
                          #{detail.newapi.newapiUserId} · 余额{" "}
                          {currencySymbol}
                          {(detail.newapi.quota / quotaPerUnit).toFixed(2)} · 已用{" "}
                          {currencySymbol}
                          {(detail.newapi.usedQuota / quotaPerUnit).toFixed(2)} ·{" "}
                          {detail.newapi.requestCount} 次请求
                          {detail.newapi.syncedAt && ` · 同步于 ${fmtTime(detail.newapi.syncedAt)}`}
                        </p>
                      )}
                    </div>

                    {/* 内网穿透 */}
                    <div className="border-b px-3 py-2 text-xs last:border-b-0">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">内网穿透</span>
                        {detail.frp ? (
                          <Badge variant={detail.frp.enabled ? "success" : "secondary"}>
                            {detail.frp.enabled ? "已启用" : "已关闭"}
                          </Badge>
                        ) : (
                          <Badge variant="outline">未启用</Badge>
                        )}
                      </div>
                      {(detail.frpPorts.length > 0 || detail.frpApplications.length > 0) && (
                        <div className="mt-1 space-y-1 text-muted-foreground">
                          {detail.frpPorts.length > 0 && (
                            <p>
                              占用端口：
                              {detail.frpPorts
                                .map((p) => `${p.nodeName ?? "节点"} ${p.remotePort}`)
                                .join("、")}
                            </p>
                          )}
                          {detail.frpApplications.slice(0, 5).map((a) => (
                            <p key={a.id}>
                              申请 {a.ports.join("/")} · {a.status}
                              {a.reviewNote && ` · ${a.reviewNote}`}
                              {" · "}
                              {fmtTime(a.createdAt)}
                            </p>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* 代理节点 */}
                    <div className="px-3 py-2 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">代理节点</span>
                        {detail.proxy ? (
                          <Badge variant={detail.proxy.enabled ? "success" : "secondary"}>
                            {detail.proxy.enabled ? "已启用" : "已关闭"}
                          </Badge>
                        ) : (
                          <Badge variant="outline">未启用</Badge>
                        )}
                      </div>
                      {detail.proxy?.consentedAt && (
                        <p className="mt-1 text-muted-foreground">
                          已同意使用协议 v{detail.proxy.consentVersion} ·{" "}
                          {fmtTime(detail.proxy.consentedAt)}
                        </p>
                      )}
                    </div>
                  </div>
                </section>

                {/* ---- 个人名片 ---- */}
                <section>
                  <h3 className="mb-2 text-sm font-medium">个人名片</h3>
                  <div className="rounded-md border p-3 text-xs">
                    {detail.profile ? (
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <Badge variant={detail.profile.published ? "success" : "secondary"}>
                            {detail.profile.published ? "已启用" : "未启用"}
                          </Badge>
                          <span className="text-muted-foreground">
                            {detail.profile.displayName ?? "未设置展示名"}
                          </span>
                          {(() => {
                            const url = profilePublicUrl(
                              detail.profile.slug,
                              detail.profile.fqdn
                            )
                            return url ? (
                              <a
                                href={url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="ml-auto inline-flex items-center gap-1 text-primary hover:underline"
                              >
                                打开
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            ) : null
                          })()}
                        </div>
                        <p className="text-muted-foreground">
                          {detail.profile.fqdn ?? `/profile/${detail.profile.slug}`} ·
                          访问 {detail.profile.viewCount} 次 · 更新于{" "}
                          {fmtTime(detail.profile.updatedAt)}
                        </p>
                      </div>
                    ) : (
                      <p className="text-muted-foreground">未开通名片</p>
                    )}
                  </div>
                </section>

                {/* ---- 邀请码 / 模块额度 ---- */}
                <section>
                  <h3 className="mb-2 text-sm font-medium">邀请码与模块额度</h3>
                  <div className="rounded-md border p-3 text-xs">
                    <p className="text-muted-foreground">
                      邀请码：共 {detail.quota.inviteTotal} 个（基础{" "}
                      {detail.quota.inviteBase} + 捐献 {detail.quota.inviteBonus}）· 已用{" "}
                      {detail.quota.inviteUsed} · 剩余 {detail.quota.inviteRemaining}
                    </p>
                    <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
                      {Object.keys(detail.quota.featureQuota).map((f) => (
                        <div key={f} className="flex items-center justify-between">
                          <span>{detail.quota.featureLabels[f] ?? f}</span>
                          <span className="text-muted-foreground">
                            {detail.quota.featureRemaining[f]} / {detail.quota.featureQuota[f]}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </section>

                {/* ---- 最近活动 ---- */}
                <section>
                  <h3 className="mb-2 text-sm font-medium">
                    最近活动（{detail.activity.length}）
                  </h3>
                  <div className="rounded-md border">
                    {detail.activity.length === 0 ? (
                      <p className="px-3 py-4 text-sm text-muted-foreground">无</p>
                    ) : (
                      detail.activity.map((a) => (
                        <div
                          key={a.id}
                          className="flex items-center justify-between border-b px-3 py-2 text-xs last:border-b-0"
                        >
                          <span className="truncate">{a.detail || a.action}</span>
                          <span className="ml-2 shrink-0 text-muted-foreground">
                            {fmtTime(a.createdAt)}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </section>

                <section>
                  <h3 className="mb-2 text-sm font-medium">子域名（{detail.subdomains.length}）</h3>
                  <div className="flex flex-wrap gap-2">
                    {detail.subdomains.map((s) => (
                      <span
                        key={s.id}
                        className="rounded-md border px-2.5 py-1 font-mono text-xs"
                      >
                        {s.fqdn}
                      </span>
                    ))}
                  </div>
                </section>

                <section>
                  <h3 className="mb-2 text-sm font-medium">DNS 记录（{detail.dns.length}）</h3>
                  <div className="rounded-md border">
                    {detail.dns.length === 0 ? (
                      <p className="px-3 py-4 text-sm text-muted-foreground">无</p>
                    ) : (
                      detail.dns.slice(0, 30).map((r) => (
                        <div
                          key={r.id}
                          className="flex items-center justify-between border-b px-3 py-2 text-xs last:border-b-0"
                        >
                          <span className="font-mono">{r.fqdn}</span>
                          <span className="text-muted-foreground">
                            {r.type} · {r.content}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </section>

                <section>
                  <h3 className="mb-2 text-sm font-medium">邮箱（{detail.mailboxes.length}）</h3>
                  <div className="flex flex-wrap gap-2">
                    {detail.mailboxes.map((mb) => (
                      <span
                        key={mb.id}
                        className="rounded-md border px-2.5 py-1 font-mono text-xs"
                      >
                        {mb.address}
                        {mb.primary && (
                          <span className="ml-1 text-muted-foreground">主</span>
                        )}
                      </span>
                    ))}
                  </div>
                </section>

                <section>
                  <h3 className="mb-2 text-sm font-medium">
                    邮件（{detail.messages.length}）
                  </h3>
                  <div className="rounded-md border">
                    {detail.messages.length === 0 ? (
                      <p className="px-3 py-4 text-sm text-muted-foreground">无</p>
                    ) : (
                      detail.messages.slice(0, 20).map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          className="flex w-full items-center justify-between border-b px-3 py-2 text-left text-xs hover:bg-accent/50 last:border-b-0"
                          onClick={() => void openMessage(m.id)}
                        >
                          <span className="truncate font-medium">
                            {m.read ? "" : "● "}
                            {m.subject || "无主题"}
                          </span>
                          <span className="ml-2 shrink-0 text-muted-foreground">
                            {m.from}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                </section>

                <section>
                  <h3 className="mb-2 text-sm font-medium">功能权限</h3>
                  <div className="space-y-2">
                    {FEATURES.map((f) => (
                      <div
                        key={f.key}
                        className="flex items-center justify-between rounded-md border p-3"
                      >
                        <div className="space-y-0.5">
                          <p className="text-sm font-medium">{f.label}</p>
                          <p className="text-xs text-muted-foreground">{f.desc}</p>
                        </div>
                        <Switch
                          checked={detail.user.permissions[f.key]}
                          disabled={busy || detail.user.username === user?.username}
                          onCheckedChange={(v) =>
                            void handleTogglePermission(f.key, v)
                          }
                        />
                      </div>
                    ))}
                  </div>
                </section>

                <section>
                  <h3 className="mb-2 text-sm font-medium">子域名配额</h3>
                  <div className="rounded-md border p-3">
                    <div className="flex items-center gap-3">
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        className="w-24"
                        value={quotaDraft ?? ""}
                        placeholder="默认"
                        disabled={busy || detail.user.username === user?.username}
                        onChange={(e) => setQuotaDraft(e.target.value)}
                      />
                      <span className="text-xs text-muted-foreground">
                        个一级子域名（留空 = 用全局默认）
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="ml-auto"
                        disabled={busy || detail.user.username === user?.username}
                        onClick={() => void handleSaveQuota()}
                      >
                        保存
                      </Button>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      当前有效配额：
                      {detail.user.maxSubdomains ?? globalQuota} 个
                      {detail.user.maxSubdomains === null && "（全局默认）"}
                    </p>
                  </div>
                </section>

                <div className="flex justify-end gap-2 border-t pt-4">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void handleToggleStatusByName(
                        detail.user.username,
                        detail.user.status
                      )
                    }
                    disabled={busy || detail.user.username === user?.username}
                  >
                    {detail.user.status === "active" ? (
                      <>
                        <Ban className="h-3.5 w-3.5" />
                        封禁
                      </>
                    ) : (
                      <>
                        <UserCheck className="h-3.5 w-3.5" />
                        解封
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* 邮件全文 */}
      <Dialog
        open={openedMessage !== null}
        onOpenChange={(open) => {
          if (!open) setOpenedMessage(null)
        }}
      >
        <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
          {openedMessage && (
            <>
              <DialogHeader>
                <DialogTitle>{openedMessage.subject || "无主题"}</DialogTitle>
                <DialogDescription>
                  {openedMessage.from} · {fmtTime(openedMessage.receivedAt)}
                </DialogDescription>
              </DialogHeader>
              <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
                {openedMessage.body || "（无正文内容）"}
              </pre>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* frp 节点编辑 */}
      <Dialog open={nodeOpen} onOpenChange={setNodeOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{nodeForm.id ? "编辑节点" : "添加节点"}</DialogTitle>
            <DialogDescription>
              serverAddr / serverPort / auth.token 会写进用户生成的 config.toml。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>名称</Label>
                <Input
                  value={nodeForm.name}
                  onChange={(e) => setNodeForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="北京"
                />
              </div>
              <div className="space-y-2">
                <Label>地区说明</Label>
                <Input
                  value={nodeForm.region}
                  onChange={(e) => setNodeForm((f) => ({ ...f, region: e.target.value }))}
                  placeholder="北京地区"
                />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>serverAddr</Label>
                <Input
                  value={nodeForm.serverAddr}
                  onChange={(e) =>
                    setNodeForm((f) => ({ ...f, serverAddr: e.target.value }))
                  }
                  placeholder="firef.qzz.io"
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-2">
                <Label>serverPort</Label>
                <Input
                  type="number"
                  value={nodeForm.serverPort}
                  onChange={(e) =>
                    setNodeForm((f) => ({ ...f, serverPort: e.target.value }))
                  }
                />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>auth.token</Label>
                <Input
                  value={nodeForm.authToken}
                  onChange={(e) =>
                    setNodeForm((f) => ({ ...f, authToken: e.target.value }))
                  }
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-2">
                <Label>auth.token 说明</Label>
                <p className="text-xs text-muted-foreground">
                  auth.token 是 frps 服务端的共享密钥，所有用户相同。
                  每个用户自己的 <code>metadatas.token</code> 由用户在申请时自设，
                  无需在此配置。
                </p>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label>端口下限</Label>
                <Input
                  type="number"
                  value={nodeForm.portMin}
                  onChange={(e) =>
                    setNodeForm((f) => ({ ...f, portMin: e.target.value }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>端口上限</Label>
                <Input
                  type="number"
                  value={nodeForm.portMax}
                  onChange={(e) =>
                    setNodeForm((f) => ({ ...f, portMax: e.target.value }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>每账号最多端口</Label>
                <Input
                  type="number"
                  value={nodeForm.maxPorts}
                  onChange={(e) =>
                    setNodeForm((f) => ({ ...f, maxPorts: e.target.value }))
                  }
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>备注</Label>
              <Input
                value={nodeForm.note}
                onChange={(e) => setNodeForm((f) => ({ ...f, note: e.target.value }))}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>节点状态</Label>
                <Select
                  value={nodeForm.status}
                  onValueChange={(v) => setNodeForm((f) => ({ ...f, status: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="online">运行中</SelectItem>
                    <SelectItem value="offline">不可用</SelectItem>
                    <SelectItem value="maintenance">维护中</SelectItem>
                    <SelectItem value="unknown">状态未知</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  用户在节点列表会看到该状态；不可用/维护中时无法提交申请。
                </p>
              </div>
              <div className="space-y-2">
                <Label>状态说明（可选）</Label>
                <Input
                  value={nodeForm.statusNote}
                  onChange={(e) =>
                    setNodeForm((f) => ({ ...f, statusNote: e.target.value }))
                  }
                  placeholder="例如：机房维护至 22:00"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNodeOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void handleSaveNode()} disabled={frpBusy}>
              {frpBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 代理订阅源编辑 */}
      <Dialog open={proxyOpen} onOpenChange={setProxyOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{proxyForm.id ? "编辑订阅源" : "添加订阅源"}</DialogTitle>
            <DialogDescription>
              订阅链接会被 Worker 抓取并解析成节点；剩余流量 / 到期日取决于订阅源
              是否在响应里附带信息（解析不到时用户端显示「未知」）。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>名称</Label>
                <Input
                  value={proxyForm.name}
                  onChange={(e) =>
                    setProxyForm((f) => ({ ...f, name: e.target.value }))
                  }
                  placeholder="香港中继"
                />
              </div>
              <div className="space-y-2">
                <Label>地区说明</Label>
                <Input
                  value={proxyForm.region}
                  onChange={(e) =>
                    setProxyForm((f) => ({ ...f, region: e.target.value }))
                  }
                  placeholder="香港"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>订阅链接</Label>
              <Input
                value={proxyForm.url}
                onChange={(e) =>
                  setProxyForm((f) => ({ ...f, url: e.target.value }))
                }
                placeholder="https://example.com/api/v1/client/subscribe?token=..."
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                需要鉴权的订阅可在 Worker secret 里配置 PROXY_API_TOKEN，
                抓取时会自动带上 Authorization: Bearer。
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label>协议</Label>
                <Input
                  value={proxyForm.protocol}
                  onChange={(e) =>
                    setProxyForm((f) => ({ ...f, protocol: e.target.value }))
                  }
                  placeholder="留空自动识别"
                />
                <p className="text-xs text-muted-foreground">
                  留空则保存时自动从订阅内容识别
                </p>
              </div>
              <div className="space-y-2">
                <Label>排序</Label>
                <Input
                  type="number"
                  value={proxyForm.sortOrder}
                  onChange={(e) =>
                    setProxyForm((f) => ({ ...f, sortOrder: e.target.value }))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label>节点状态</Label>
                <Select
                  value={proxyForm.status}
                  onValueChange={(v) =>
                    setProxyForm((f) => ({ ...f, status: v }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="online">运行中</SelectItem>
                    <SelectItem value="offline">不可用</SelectItem>
                    <SelectItem value="maintenance">维护中</SelectItem>
                    <SelectItem value="unknown">未知</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  留空则保存时按订阅 URL 能否访问自动判定
                </p>
              </div>
            </div>
            <div className="space-y-2">
              <Label>状态说明（可选）</Label>
              <Input
                value={proxyForm.statusNote}
                onChange={(e) =>
                  setProxyForm((f) => ({ ...f, statusNote: e.target.value }))
                }
                placeholder="例如：机房维护至 22:00"
              />
            </div>
            <div className="space-y-2">
              <Label>备注（可选）</Label>
              <Input
                value={proxyForm.note}
                onChange={(e) =>
                  setProxyForm((f) => ({ ...f, note: e.target.value }))
                }
              />
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">对该订阅源启用</p>
                <p className="text-xs text-muted-foreground">
                  停用后用户看不到这个订阅源（不影响其它订阅源）
                </p>
              </div>
              <Switch
                checked={proxyForm.enabled}
                onCheckedChange={(v) => setProxyForm((f) => ({ ...f, enabled: v }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setProxyOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void handleSaveProxy()} disabled={proxyBusy}>
              {proxyBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

const DONATION_LABEL: Record<string, string> = {
  ai: "AI 渠道",
  frp: "内网穿透",
  proxy: "代理订阅",
}

/** 按类型渲染捐献详情（payload 结构随类型不同） */
function DonationDetail({ type, payload }: { type: string; payload: unknown }) {
  const p = (payload ?? {}) as Record<string, unknown>
  const rows: [string, string][] = []

  if (type === "ai") {
    if (p.baseUrl) rows.push(["Base URL", String(p.baseUrl)])
    if (p.apiKey) rows.push(["API Key", String(p.apiKey)])
    const models = Array.isArray(p.models) ? p.models.join("、") : p.models
    if (models) rows.push(["可用模型", String(models)])
  } else if (type === "frp") {
    if (p.nodeStatus) rows.push(["渠道状态", String(p.nodeStatus)])
    const channels = Array.isArray(p.channels) ? p.channels.length : 0
    if (channels) rows.push(["渠道数", String(channels)])
  } else if (type === "proxy") {
    const subs = Array.isArray(p.subUrls) ? p.subUrls : []
    if (subs.length) rows.push(["订阅链接", subs.join("、")])
    if (p.nodeCount) rows.push(["节点数", String(p.nodeCount)])
  }

  const configYml = typeof p.configYml === "string" ? p.configYml : ""

  return (
    <div className="space-y-1">
      {rows.map(([k, v]) => (
        <p key={k} className="break-all font-mono text-xs text-muted-foreground">
          {k}：{v}
        </p>
      ))}
      {configYml && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            查看 config.yml
          </summary>
          <pre className="mt-1 max-h-56 overflow-auto rounded border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
            {configYml}
          </pre>
        </details>
      )}
    </div>
  )
}
