import * as React from "react"
import { Link } from "react-router-dom"
import {
  Ban,
  Compass,
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
  Medal,
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
  MessageSquare,
  RotateCcw,
  PlugZap,
  X,
  Sparkles,
  Unplug,
  AlertCircle,
  BarChart3,
  Gauge,
  Globe,
  ArrowLeft,
  ExternalLink,
  Mail,
  PartyPopper,
  Clock,
  ScrollText,
  Coins,
} from "lucide-react"
import { toast } from "sonner"

// OAuth 应用的 UI 本体单独放一个文件，避免继续撑大本文件
// （本文件已 4500+ 行，且可能有其他改动同时在动它）。
import { OAuthAdminPanel } from "./admin-oauth"
import { AnalyticsPanel } from "./admin-analytics"
import { CfQuotaPanel } from "./admin-cf-quota"
import { BrevoQuotaPanel } from "./admin-brevo-quota"
// 反馈面板同理单独成文件（本文件太大，新增内容尽量外置）
import { FeedbackPanel } from "./admin-feedback"
import { AuditPanel } from "./admin-audit"
import { PointsAdminPanel } from "./admin-points"
import { FunLinksAdminPanel } from "./admin-fun-links"
import { TitlesAdminPanel } from "./admin-titles"
// DNS 解析管理（全站记录 / 合规扫描 / 与 Cloudflare 对账）同理外置
import { DnsAdminPanel } from "./admin-dns"

import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { NavItem, NavGroup } from "@/components/sub-nav"
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
  adminEventApi,
  donationApi,
  r2AdminApi,
  wb2apiApi,
  cli2apiApi,
  attentionApi,
  HttpError,
} from "@/services/api"
import { useT, tStatic } from "@/i18n"
import { useAuth } from "@/hooks/use-auth"
/**
 * 可授权的功能（与后端 permissions.ts 的 FEATURES 保持一致）。
 * ⚠️ 不含「个人名片」：名片不消耗资源，已从权限体系移出、全量开放，
 * 因此创建/编辑邀请码与成员详情里都不再出现名片开关。
 */
const FEATURES: { key: FeatureKey; label: string; desc: string }[] = [
  { key: "r2", label: "feat.r2", desc: "adm.feat.r2Desc" },
  { key: "ai", label: "feat.ai", desc: "adm.feat.aiDesc" },
  { key: "frp", label: "feat.frp", desc: "adm.feat.frpDesc" },
  { key: "proxy", label: "feat.proxy", desc: "adm.feat.proxyDesc" },
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
  AnnouncementStatus,
  EventItem,
  EventClaim,
  EventPayload,
  EventStatus,
  EventRewardType,
  EventConditionType,
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
  AdminCli2ApiConfig,
  AdminCli2ApiBinding,
  AdminCli2ApiPool,
  RecommendedTier,
  AttentionCounts,
} from "@/types"
import { FEATURE_LABELS } from "@/types"
import { fmtUid } from "@/lib/format"
import { onAttentionChanged, notifyAttentionChanged } from "@/lib/attention-events"

/** 与 Worker 端 settings.ts 的 formatBytes 保持一致 */
/**
 * 解析后端的布尔设置项。
 *
 * ⚠️ 2026-09-26 发现的问题：后端 `updateSettings` 会做 `String(value)`，
 * 而前端保存时传的是 JS 布尔 ⇒ **管理员改过一次之后，库里存的就是
 * "true"/"false"**（不再是最初的 "1"/"0"）。后端 `getSettingBool` 两种都认，
 * 但前端原先一律写 `=== "1"`，于是：
 *   · 任何开关「关 → 开」操作后再刷新，开关会显示成「关闭」（功能其实是开的）；
 *   · `community_guest_access` 原先用 `!== "0"` 判断，存了 "false" 时会显示
 *     「允许访客」—— 与后端实际值**完全相反**。
 * 所以读取必须同时认 "1" 与 "true"（大小写不敏感）。fallback 取后端默认值。
 */
function isSettingOn(raw: string | undefined, fallback = false): boolean {
  if (raw === undefined || raw === "") return fallback
  return raw === "1" || raw.toLowerCase() === "true"
}

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

/** 管理面板左侧导航的单个项（实现见 components/sub-nav.tsx，与捐献页共用） */

/** realm（cn/global）→ 中文标签 */
function realmLabel(realm: string | null | undefined): string {
  if (realm === "global") return tStatic("don.realm.global")
  if (realm === "cn") return tStatic("don.realm.cn")
  return tStatic("common.unknown")
}

/** 用户列表里的布尔列：开通打勾，未开通画叉（居中对齐，无多余留白） */
function BoolMark({ on, title }: { on: boolean; title?: string }) {
  return (
    <span
      className="inline-flex items-center justify-center"
      title={title ?? (on ? tStatic("adm.on") : tStatic("adm.off"))}
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

// ---- 活动表单 ----

interface EventDraft {
  id: string | null
  title: string
  body: string
  status: EventStatus
  /** datetime-local 的值（本地时区，形如 2026-09-27T10:00） */
  startsAt: string
  endsAt: string
  rewardLabel: string
  rewardType: EventRewardType
  /** 奖励数量：newapi_quota 用 amount（元），invite_quota 用 count，points 用 amount（积分数） */
  rewardAmount: string
  /**
   * 积分奖励是否走「区间随机」（仅 rewardType = points 时有意义）。
   * 勾上后改用 rewardMin / rewardMax 两个输入框，发放时在闭区间内取一个整数。
   */
  pointsRandom: boolean
  /** 区间下限（积分数） */
  rewardMin: string
  /** 区间上限（积分数） */
  rewardMax: string
  conditionType: EventConditionType
  conditionFeature: string
  /** 认证码（conditionType = code 时用）：用户凭它领取，通常公布在 QQ 群等站外 */
  conditionCode: string
  /** 要核验 star 的 GitHub 仓库（conditionType = github_star 时用），形如 owner/repo */
  conditionRepo: string
  /** 抽奖（conditionType = lottery 时用）：中奖人数 */
  lotteryWinners: string
  /** 抽奖：奖池总积分（中奖者共享） */
  lotteryPool: string
  /** 抽奖：分配方式（平均分 / 随机分） */
  lotteryMode: "even" | "random"
  /** 限量总份数：留空 = 不限量；先到先得，领满即止。抽奖时是「参与人数上限」 */
  maxClaims: string
  /** 定时上线时间（datetime-local）；status=scheduled 时用 */
  publishAt: string
}

function emptyEventDraft(): EventDraft {
  return {
    id: null,
    title: "",
    body: "",
    status: "draft",
    startsAt: "",
    endsAt: "",
    rewardLabel: "",
    rewardType: "none",
    rewardAmount: "",
    pointsRandom: false,
    rewardMin: "",
    rewardMax: "",
    conditionType: "always",
    conditionFeature: "ai",
    conditionCode: "",
    conditionRepo: "Doulor/DoulorCloud",
    lotteryWinners: "10",
    lotteryPool: "1000",
    lotteryMode: "even",
    maxClaims: "",
    publishAt: "",
  }
}

/** ISO → datetime-local 输入框的值（本地时区） */
function toLocalInput(iso: string | null): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** datetime-local 值 → ISO（空串 → null，交由后端当「不限」处理） */
function fromLocalInput(v: string): string | null {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function eventDraftToPayload(d: EventDraft): EventPayload {
  const amount = Number(d.rewardAmount)
  /** 抽奖活动：奖励固定是积分，奖池在 conditionParams.pool 里，不走 rewardParams */
  const isLottery = d.conditionType === "lottery"
  const rewardParams = isLottery
    ? null
    : d.rewardType === "newapi_quota"
      ? { amount: Number.isFinite(amount) && amount > 0 ? Math.floor(amount) : 1 }
      : d.rewardType === "invite_quota"
        ? { count: Number.isFinite(amount) && amount > 0 ? Math.floor(amount) : 2 }
        : d.rewardType === "points"
          ? d.pointsRandom
            ? // 区间随机：下限至少 1，上限不小于下限（后端还会再校验一遍）
              {
                min: Math.max(1, Math.floor(Number(d.rewardMin)) || 1),
                max: Math.max(
                  Math.max(1, Math.floor(Number(d.rewardMin)) || 1),
                  Math.floor(Number(d.rewardMax)) || 1
                ),
              }
            : { amount: Number.isFinite(amount) && amount > 0 ? Math.floor(amount) : 10 }
          : null
  const conditionParams = isLottery
    ? {
        winners: Math.floor(Number(d.lotteryWinners)) || 1,
        pool: Math.floor(Number(d.lotteryPool)) || 1,
        mode: d.lotteryMode,
      }
    : d.conditionType === "has_feature"
      ? { feature: d.conditionFeature }
      : d.conditionType === "code"
        ? { code: d.conditionCode.trim() }
        : d.conditionType === "github_star"
          ? { repo: d.conditionRepo.trim() }
          : null

  const maxClaims = d.maxClaims.trim() === "" ? null : Math.floor(Number(d.maxClaims))
  return {
    title: d.title.trim(),
    body: d.body.trim(),
    status: d.status,
    startsAt: fromLocalInput(d.startsAt),
    endsAt: fromLocalInput(d.endsAt),
    // 仅在「定时发布」时提交时间；其它状态忽略，避免残留脏值
    publishAt: d.status === "scheduled" ? fromLocalInput(d.publishAt) : null,
    // 非正数/Nan → null（不限量）
    maxClaims: maxClaims != null && Number.isFinite(maxClaims) && maxClaims >= 1 ? maxClaims : null,
    rewardLabel: d.rewardLabel.trim() || null,
    // 抽奖固定发积分（后端也会校验，这里是为了提交值自洽）
    rewardType: isLottery ? "points" : d.rewardType,
    rewardParams,
    conditionType: d.conditionType,
    conditionParams,
  }
}

const EVENT_STATUS_OPTIONS: { value: EventStatus; label: string }[] = [
  { value: "draft", label: "adm.evStatus.draft" },
  { value: "scheduled", label: "adm.evStatus.scheduled" },
  { value: "active", label: "adm.evStatus.active" },
  { value: "ended", label: "adm.evStatus.ended" },
  { value: "archived", label: "adm.evStatus.archived" },
]

const REWARD_TYPE_OPTIONS: { value: EventRewardType; label: string }[] = [
  { value: "none", label: "adm.reward.none" },
  { value: "newapi_quota", label: "adm.reward.quota" },
  { value: "invite_quota", label: "adm.reward.inviteQuota" },
  // 积分：记在用户积分余额上，任何用户都能领（不必先绑中转站），
  // 之后由用户自己在「积分与商城」页兑换成中转站余额
  { value: "points", label: "adm.reward.points" },
]

const CONDITION_TYPE_OPTIONS: { value: EventConditionType; label: string }[] = [
  { value: "always", label: "adm.cond.always" },
  { value: "code", label: "adm.cond.code" },
  // 判据是「已发布 **且** 填了昵称」——开通名片默认就是已发布状态，
  // 只卡「已发布」等于点一下开通就能领奖，所以还要有昵称（见 event-rewards.ts）
  { value: "has_profile", label: "adm.cond.profile" },
  { value: "has_feature", label: "adm.cond.feature" },
  // 抽奖：参与只是「报名」，开奖时从报名者里随机抽取中奖者发积分（奖励类型固定为积分）
  { value: "lottery", label: "adm.cond.lottery" },
  // 点 star：用户填自己的 GitHub 用户名，服务端去该仓库的 stargazers 名单里核验
  { value: "github_star", label: "adm.cond.githubStar" },
]

const EVENT_STATUS_BADGE: Record<EventStatus, "default" | "secondary" | "success" | "outline"> = {
  draft: "secondary",
  scheduled: "default",
  active: "success",
  ended: "outline",
  archived: "secondary",
}

const EVENT_STATUS_TEXT: Record<EventStatus, string> = {
  draft: "adm.evStatus.draft",
  scheduled: "adm.evStatus.scheduledShort",
  active: "adm.evStatus.activeShort",
  ended: "adm.evStatus.endedShort",
  archived: "adm.evStatus.archivedShort",
}

export default function AdminPage() {
  const { t } = useT()
  const { user } = useAuth()
  const [users, setUsers] = React.useState<AdminUser[]>([])
  const [filter, setFilter] = React.useState("")
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  // 管理面板当前激活的 tab（受控，供「更多」下拉切换）
  const [activeTab, setActiveTab] = React.useState("users")
  // 各栏目「待处理」角标（反馈 / 捐献 / 积分 / 活动），与侧边栏「管理」总角标同源
  const [attention, setAttention] = React.useState<AttentionCounts["admin"]>(null)

  const [detail, setDetail] = React.useState<AdminUserDetail | null>(null)
  const [detailUser, setDetailUser] = React.useState<string>("")
  const [openedMessage, setOpenedMessage] = React.useState<MailMessage | null>(null)
  /** 成员详情里「对齐中转站状态」按钮的忙碌态 */
  const [newapiSyncBusy, setNewapiSyncBusy] = React.useState(false)

  // 邀请码
  const [invites, setInvites] = React.useState<AdminInvite[]>([])
  const [inviteLoading, setInviteLoading] = React.useState(false)
  const [inviteOpen, setInviteOpen] = React.useState(false)
  const [inviteCode, setInviteCode] = React.useState("")
  const [inviteMax, setInviteMax] = React.useState("1")
  const [inviteBusy, setInviteBusy] = React.useState(false)
  /** 邀请码分类筛选："" 全部 / "unused" 未使用 / "partial" 部分使用 / "used" 已使用 */
  const [inviteFilter, setInviteFilter] = React.useState<string>("")
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

  // 用户详情里的网盘配额编辑（单位 MB，与「单文件上限」同口径，避免站长手算字节）
  const [storageQuotaMbDraft, setStorageQuotaMbDraft] = React.useState("")
  const [storageQuotaBusy, setStorageQuotaBusy] = React.useState(false)
  /** 「把存量用户配额刷成所属桶配额」的进行中标记 */
  const [syncQuotaBusy, setSyncQuotaBusy] = React.useState(false)

  // 编辑邀请码权限
  const [permInvite, setPermInvite] = React.useState<AdminInvite | null>(null)
  const [permDraft, setPermDraft] = React.useState<Permissions | null>(null)
  const [permBusy, setPermBusy] = React.useState(false)

  // 用户邀请码额度
  const [inviteQuotas, setInviteQuotas] =
    React.useState<AdminInviteQuotasResponse | null>(null)
  const [inviteQuotaLoading, setInviteQuotaLoading] = React.useState(false)
  /** 用户邀请码列表的顶部搜索（用户名 / 邮箱 / 域名），与用户列表同款 */
  const [quotaFilter, setQuotaFilter] = React.useState("")
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
    notifyByEmail: boolean
    /** draft=草稿；scheduled=定时发布；published=立即发布 */
    status: AnnouncementStatus
    /** datetime-local 值（本地时区）；status=scheduled 时用 */
    publishAt: string
  }>({
    id: null,
    title: "",
    body: "",
    category: "general",
    pinned: false,
    popupMode: "none",
    notifyByEmail: false,
    status: "published",
    publishAt: "",
  })

  // 活动（消息中心「活动推广」）
  const [events, setEvents] = React.useState<EventItem[]>([])
  const [eventLoading, setEventLoading] = React.useState(false)
  const [eventOpen, setEventOpen] = React.useState(false)
  const [eventBusy, setEventBusy] = React.useState(false)
  const [eventDraft, setEventDraft] = React.useState<EventDraft>(emptyEventDraft())
  /** 领取名单弹窗 */
  const [claimsOpen, setClaimsOpen] = React.useState(false)
  const [claimsEvent, setClaimsEvent] = React.useState<EventItem | null>(null)
  const [claims, setClaims] = React.useState<EventClaim[]>([])
  const [claimsLoading, setClaimsLoading] = React.useState(false)

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
    /** 单位 MB（界面按 MB 填，提交时 ×1024×1024 换算成字节） */
    quotaPerUser: "1024",
    sortOrder: "0",
    kind: "user",
  })
  /** 用户改派：{ 用户名: 目标桶 id } 的临时选择 */
  const [assignTarget, setAssignTarget] = React.useState<Record<string, string>>({})
  /** 设置页「每桶人数上限」的草稿值（桶 id → 输入框内容）；有草稿才算「未保存」 */
  const [bucketMaxDraft, setBucketMaxDraft] = React.useState<Record<string, string>>({})
  const [bucketMaxBusy, setBucketMaxBusy] = React.useState<string | null>(null)
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
  const [quotaMb, setQuotaMb] = React.useState("1024")
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
  /** 前端「全部可用模型」要展示的分组（逗号分隔，donation 自动追加） */
  const [newapiVisibleGroups, setNewapiVisibleGroups] = React.useState("default")
  /** 推荐模型分档（管理员维护，用户在 AI 页看到的就是这份） */
  const [recommendedTiers, setRecommendedTiers] = React.useState<RecommendedTier[]>([])
  /** 候选模型名（来自中转站 pricing），用于「添加模型」下拉 */
  const [modelOptions, setModelOptions] = React.useState<string[]>([])

  // ---- 2026-09-26 补齐：以下设置项后端一直有默认值，但面板从没有输入框 ----
  /** 免费订阅套餐 id（0 = 不自动开订阅） */
  const [newapiFreePlanId, setNewapiFreePlanId] = React.useState("1")
  /** quota ↔ 金额换算率的可编辑值 */
  const [quotaPerUnitInput, setQuotaPerUnitInput] = React.useState("500000")
  /** 邀请奖励总开关 */
  const [inviteRewardEnabled, setInviteRewardEnabled] = React.useState(true)
  /** 邀请奖励：反代绑定奖励套餐 id */
  const [inviteRewardPlanId, setInviteRewardPlanId] = React.useState("2")
  /** 邀请奖励：AI 渠道捐献奖励套餐 id */
  const [inviteRewardAiPlanId, setInviteRewardAiPlanId] = React.useState("3")
  /** 成就奖励总开关 */
  const [achievementRewardEnabled, setAchievementRewardEnabled] = React.useState(false)
  /** 成就奖励套餐 id */
  const [achievementRewardPlanId, setAchievementRewardPlanId] = React.useState("4")
  /** 每满多少成就点发一份 */
  const [achievementRewardPoints, setAchievementRewardPoints] = React.useState("10")
  /** 每个用户默认的邀请码额度 */
  const [inviteQuotaBase, setInviteQuotaBase] = React.useState("3")
  /** 代理节点功能总开关 */
  const [proxyEnabled, setProxyEnabled] = React.useState(true)
  /** 新反馈通知邮箱（空 = 不通知） */
  const [feedbackNotifyEmail, setFeedbackNotifyEmail] = React.useState("")

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
  /** 纯展示开关：是否在捐献页显示该入口（关掉不影响通道本身） */
  const [wb2apiDonationVisible, setWb2apiDonationVisible] = React.useState(true)
  const [wb2apiMaxBindings, setWb2apiMaxBindings] = React.useState("3")
  const [wb2apiBaseUrl, setWb2apiBaseUrl] = React.useState("")
  const [wb2apiRealm, setWb2apiRealm] = React.useState<"cn" | "global">("cn")

  // ---- CLI2API 反代账号捐献（第二条通道）----
  const [cli2apiConfig, setCli2apiConfig] = React.useState<AdminCli2ApiConfig | null>(null)
  const [cli2apiBindings, setCli2apiBindings] = React.useState<AdminCli2ApiBinding[]>([])
  const [cli2apiPool, setCli2apiPool] = React.useState<AdminCli2ApiPool | null>(null)
  const [cli2apiLoading, setCli2apiLoading] = React.useState(false)
  const [cli2apiBusy, setCli2apiBusy] = React.useState(false)
  /** 待更新的 console key（明文只在输入框，提交后立即清空） */
  const [cli2apiNewKey, setCli2apiNewKey] = React.useState("")
  const [cli2apiRemoving, setCli2apiRemoving] = React.useState<AdminCli2ApiBinding | null>(null)
  const [cli2apiRevokeAi, setCli2apiRevokeAi] = React.useState(false)
  /** 通道开关 / 上限 / provider / region（走全局设置接口，与其它开关一起保存） */
  const [cli2apiEnabled, setCli2apiEnabled] = React.useState(true)
  /** 纯展示开关：是否在捐献页显示该入口（关掉不影响通道本身） */
  const [cli2apiDonationVisible, setCli2apiDonationVisible] = React.useState(true)
  const [cli2apiMaxBindings, setCli2apiMaxBindings] = React.useState("3")
  const [cli2apiBaseUrl, setCli2apiBaseUrl] = React.useState("")
  const [cli2apiProvider, setCli2apiProvider] = React.useState("qoder")
  const [cli2apiRegion, setCli2apiRegion] = React.useState("cn")

  // 商汤 Key 捐献通道
  const [sensenovaEnabled, setSensenovaEnabled] = React.useState(true)
  /** 纯展示开关：是否在捐献页显示该入口（关掉不影响提交接口） */
  const [sensenovaDonationVisible, setSensenovaDonationVisible] = React.useState(true)
  const [sensenovaBaseUrl, setSensenovaBaseUrl] = React.useState("")
  /** 捐献来的 Key 要并入的渠道 ID（NewAPI 渠道 ID，必须是多密钥渠道） */
  const [sensenovaChannelId, setSensenovaChannelId] = React.useState("")
  const [frpEnabled, setFrpEnabled] = React.useState(true)
  const [frpCoreUrl, setFrpCoreUrl] = React.useState("")
  const [frpNotifyEmail, setFrpNotifyEmail] = React.useState("")
  const [notifyEmailOptions, setNotifyEmailOptions] = React.useState<string[]>([])
  // 出站邮件通道
  const [mailTransportOrder, setMailTransportOrder] = React.useState("posta,brevo,cf")
  const [announcementMailTransport, setAnnouncementMailTransport] = React.useState("posta")
  const [mailCfTargets, setMailCfTargets] = React.useState("")
  const [postaUrl, setPostaUrl] = React.useState("")
  const [postaKey, setPostaKey] = React.useState("")
  const [postaFrom, setPostaFrom] = React.useState("")
  const [postaConfigured, setPostaConfigured] = React.useState(false)
  // Brevo 多把 Key：明文永不回前端，这里存的是「中间打码」的列表（顺序 = 轮询顺序）
  const [brevoKeys, setBrevoKeys] = React.useState<string[]>([])
  const [brevoAddInput, setBrevoAddInput] = React.useState("")
  const [brevoBusy, setBrevoBusy] = React.useState(false)
  const [brevoSenderEmail, setBrevoSenderEmail] = React.useState("")
  const [brevoSenderName, setBrevoSenderName] = React.useState("Doulor Cloud")
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
  // 限时开放注册：打开后注册无需邀请码；可设截止时间（datetime-local 本地值）
  const [openRegistration, setOpenRegistration] = React.useState(false)
  const [openRegistrationUntil, setOpenRegistrationUntil] = React.useState("")
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
  /** 聊天室总开关（应急断流用：聊天是请求与写库的大头）。默认按「关」展示，加载后被真实值覆盖 */
  const [chatEnabled, setChatEnabled] = React.useState(false)
  const [communityGuestAccess, setCommunityGuestAccess] = React.useState(true)
  const [communityPostMaxImages, setCommunityPostMaxImages] = React.useState("9")
  const [communityImageMaxKb, setCommunityImageMaxKb] = React.useState("1024")

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await adminApi.listUsers()
      setUsers(res.users)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.1"))
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
      toast.error(err instanceof HttpError ? err.message : t("adm.2"))
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
      toast.success(t("adm.3"))
      setInviteCode("")
      setInviteMax("1")
      setInviteOpen(false)
      void loadInvites()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.4"))
    } finally {
      setInviteBusy(false)
    }
  }

  const handleDeleteInvite = async (invite: AdminInvite) => {
    try {
      await adminApi.deleteInvite(invite.id)
      toast.success(t("adm.5"))
      void loadInvites()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.6"))
    }
  }

  // ---- frp 内网穿透审核 ----

  const [frpApps, setFrpApps] = React.useState<AdminFrpApplication[]>([])
  const [frpNodes, setFrpNodes] = React.useState<AdminFrpNode[]>([])
  const [frpLoading, setFrpLoading] = React.useState(false)
  const [frpBusy, setFrpBusy] = React.useState(false)
  /** frp 申请分类筛选："" 全部 / "pending" 待审核 / "approved" 已通过 / "rejected" 已拒绝 */
  const [frpFilter, setFrpFilter] = React.useState<string>("")
  /** 待审核目标 + 意见弹窗 */
  const [frpReviewTarget, setFrpReviewTarget] = React.useState<{
    app: AdminFrpApplication
    action: "approve" | "reject"
  } | null>(null)
  const [frpReviewNote, setFrpReviewNote] = React.useState("")
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
    authMode: "token",
  })

  // ---- 捐献审核 ----
  const [donations, setDonations] = React.useState<Donation[]>([])
  /** 捐献列表分类筛选："" 全部 / "pending" 未处理 / "approved" 已通过 /
   *  "rejected" 已拒绝 / "autoApproved" 自动通过 / "autoRejected" 自动拒绝 */
  const [donationFilter, setDonationFilter] = React.useState<string>("")
  /** 捐献列表类别筛选："" 全部 / "ai" / "frp" / "proxy" / "sensenova" */
  const [donationTypeFilter, setDonationTypeFilter] = React.useState<string>("")
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
      toast.error(err instanceof HttpError ? err.message : t("adm.7"))
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
          : t("adm.8")
      )
      setReviewTarget(null)
      setReviewNote("")
      await loadDonations()
      notifyAttentionChanged() // 捐献角标当场减一，不用等 60 秒轮询
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.9"))
    } finally {
      setDonationBusy(false)
    }
  }

  /** 撤销已审核的捐献：回到待审核，若权限因此捐献获得则自动收回 */
  const handleRevokeDonation = async (d: Donation) => {
    // 商汤的 Key 是并进「你自己的那个多密钥渠道」的，撤销时只能摘掉这一把 Key，
    // 渠道本身必须保留（里面还有别处来的 Key）—— 所以文案要和 AI 区分开。
    const extra =
      d.type === "ai"
        ? t("adm.10")
        : d.type === "sensenova"
          ? t("adm.11")
          : d.type === "proxy"
            ? t("adm.12")
            : ""
    if (!confirm(`撤销「${d.username}」的捐献审核？\n\n撤销后回到待审核；若该捐献授予过权限，会自动收回${extra}。`)) return
    setDonationBusy(true)
    try {
      const res = await donationApi.revoke(d.id)
      const parts = [res.revokedPermission ? "已撤销并收回权限" : "已撤销（该捐献未授予新权限）"]
      // 商汤通道返回的是一句话说明（已移除 / 没找到那把 Key，请手工处理），
      // 不能笼统地说「渠道已删除」—— 那个渠道是共享的，根本没删。
      if (res.releaseMessage) parts.push(res.releaseMessage.replace(/^（|）$/g, ""))
      else if (res.releasedChannel) parts.push(t("adm.13"))
      if (res.releasedSubscriptions) parts.push(`已移出 ${res.releasedSubscriptions} 个订阅源`)
      toast.success(parts.join("，"))
      await loadDonations()
      notifyAttentionChanged() // 撤销后回到待审核，捐献角标当场 +1
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.14"))
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
        toast.success(res.detail ? `渠道已接入：${res.detail}` : t("adm.15"))
      } else {
        toast.error(res.detail || res.message || t("adm.16"))
      }
      await loadDonations()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.17"))
    } finally {
      setDonationBusy(false)
    }
  }

  /** 补全模型：重新拉上游列表，把渠道里缺的补上（救历史单） */
  const handleRefetchModels = async (d: Donation) => {
    setDonationBusy(true)
    try {
      const res = await donationApi.refetchModels(d.id)
      if (res.ok) toast.success(res.message)
      else toast.error(res.message)
      await loadDonations()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.18"))
    } finally {
      setDonationBusy(false)
    }
  }

  /** 重试失败模型：只试已落库的那些（限流/超时的可能已恢复） */
  const handleRetryModels = async (d: Donation) => {
    setDonationBusy(true)
    try {
      const res = await donationApi.retryModels(d.id)
      if (res.ok) toast.success(res.message)
      else toast.error(res.detail || res.message || t("adm.19"))
      await loadDonations()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.20"))
    } finally {
      setDonationBusy(false)
    }
  }

  const loadFrp = React.useCallback(async () => {
    setFrpLoading(true)
    try {
      const [apps, nodes] = await Promise.all([
        adminApi.listFrpApplications("all"),
        adminApi.listFrpNodes(),
      ])
      setFrpApps(apps.applications)
      setFrpNodes(nodes.nodes)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.21"))
    } finally {
      setFrpLoading(false)
    }
  }, [])

  const openReview = (app: AdminFrpApplication, action: "approve" | "reject") => {
    setFrpReviewNote("")
    setFrpReviewTarget({ app, action })
  }

  const confirmFrpReview = async () => {
    if (!frpReviewTarget) return
    setFrpBusy(true)
    try {
      await adminApi.reviewFrp({
        id: frpReviewTarget.app.id,
        action: frpReviewTarget.action,
        note: frpReviewNote.trim() || undefined,
      })
      toast.success(
        frpReviewTarget.action === "approve"
          ? `已通过，结果已邮件通知 ${frpReviewTarget.app.notifyEmail}`
          : `已拒绝，结果已邮件通知 ${frpReviewTarget.app.notifyEmail}`
      )
      setFrpReviewTarget(null)
      setFrpReviewNote("")
      await loadFrp()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.22"))
    } finally {
      setFrpBusy(false)
    }
  }

  const handleRevokeFrp = async (app: AdminFrpApplication) => {
    if (!confirm(`撤销「${app.siteUsername}」的申请审核？\n\n撤销后回到待审核；已占用的端口会被释放。`)) return
    setFrpBusy(true)
    try {
      await adminApi.revokeFrp(app.id)
      toast.success(t("adm.23"))
      await loadFrp()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.24"))
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
        authMode: nodeForm.authMode as "none" | "token" | "token_user" | "custom",
      })
      toast.success(t("adm.25"))
      setNodeOpen(false)
      await loadFrp()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.26"))
    } finally {
      setFrpBusy(false)
    }
  }

  const handleDeleteNode = async (id: string) => {
    try {
      await adminApi.deleteFrpNode(id)
      toast.success(t("adm.27"))
      await loadFrp()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.28"))
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
      toast.error(err instanceof HttpError ? err.message : t("adm.29"))
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
      toast.success(t("adm.30"))
      setProxyOpen(false)
      await loadProxy()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.31"))
    } finally {
      setProxyBusy(false)
    }
  }

  const handleDeleteProxy = async (id: string) => {
    try {
      await adminApi.deleteProxySubscription(id)
      toast.success(t("adm.32"))
      await loadProxy()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.33"))
    }
  }

  // ---- 社区管理 ----

  const loadCommunity = React.useCallback(async () => {
    setCommunityLoading(true)
    try {
      const res = await adminApi.listCommunityPosts({ includeDeleted: communityShowDeleted, user: communityUserFilter || undefined })
      setCommunityPosts(res.posts)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.34"))
    } finally {
      setCommunityLoading(false)
    }
  }, [communityShowDeleted, communityUserFilter])

  const handleDeleteCommunityPost = async (id: string) => {
    try {
      await adminApi.deleteCommunityPost(id)
      toast.success(t("adm.35"))
      await loadCommunity()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.36"))
    }
  }

  const handleRestoreCommunityPost = async (id: string) => {
    try {
      await adminApi.restoreCommunityPost(id)
      toast.success(t("adm.37"))
      await loadCommunity()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.38"))
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
      // 字节 → MB（界面统一按 MB 填，避免 512 MB 这种非整 GB 的值没法表达）
      setQuotaMb(String(Math.round((quotaBytes / 1024 / 1024) * 100) / 100))
      setMaxFileMb(
        String(Math.round(Number(s.storage_max_file_bytes ?? 104857600) / 1024 / 1024))
      )
      setStorageEnabled(isSettingOn(s.storage_enabled, true))
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
      setNewapiUnlimited(isSettingOn(s.newapi_unlimited_quota))
      setNewapiEnabled(isSettingOn(s.newapi_enabled, true))
      setNewapiVisibleGroups(s.newapi_visible_groups ?? "default")
      // 反代账号捐献通道
      setWb2apiEnabled(isSettingOn(s.wb2api_enabled, true))
      setWb2apiDonationVisible(isSettingOn(s.wb2api_donation_visible, true))
      setWb2apiMaxBindings(s.wb2api_max_bindings ?? "3")
      setWb2apiBaseUrl(s.wb2api_base_url ?? "")
      setWb2apiRealm(s.wb2api_realm === "global" ? "global" : "cn")
      // CLI2API 反代账号捐献通道
      setCli2apiEnabled(isSettingOn(s.cli2api_enabled, true))
      setCli2apiDonationVisible(isSettingOn(s.cli2api_donation_visible, true))
      setCli2apiMaxBindings(s.cli2api_max_bindings ?? "3")
      setCli2apiBaseUrl(s.cli2api_base_url ?? "")
      setCli2apiProvider(s.cli2api_provider ?? "qoder")
      setCli2apiRegion(s.cli2api_region ?? "cn")
      // 商汤 Key 捐献通道
      setSensenovaEnabled(isSettingOn(s.sensenova_enabled, true))
      setSensenovaDonationVisible(isSettingOn(s.sensenova_donation_visible, true))
      setSensenovaBaseUrl(s.sensenova_base_url ?? "")
      setSensenovaChannelId(s.sensenova_channel_id ?? "")
      // 推荐模型分档：坏 JSON 一律当空，不能让一个脏设置项把整个设置页打崩
      try {
        const parsed = JSON.parse(s.newapi_recommended_models ?? "[]")
        setRecommendedTiers(Array.isArray(parsed) ? (parsed as RecommendedTier[]) : [])
      } catch {
        setRecommendedTiers([])
      }
      setGlobalQuota(Number(s.subdomain_quota_default ?? 5))
      setSubQuota(s.subdomain_quota_default ?? "5")
      setFrpEnabled(isSettingOn(s.frp_enabled, true))
      setFrpCoreUrl(s.frp_core_url ?? "")
      setFrpNotifyEmail(s.frp_admin_notify_email ?? "")
      setNotifyEmailOptions(res.notifyEmailOptions ?? [])
      setTempboxEnabled(isSettingOn(s.tempbox_enabled, true))
      setTempboxMinutes(s.tempbox_default_minutes ?? "30")
      setTempboxMaxFileMb(
        String(Math.round(Number(s.tempbox_max_file_bytes ?? 268435456) / 1024 / 1024))
      )
      setTempboxMaxFiles(s.tempbox_max_files ?? "20")
      setTempboxUploadLogin(isSettingOn(s.tempbox_upload_requires_login, true))
      setCommunityEnabled(isSettingOn(s.community_enabled, true))
      // ⚠️ 默认 false 而不是 true：这个开关是应急断流用的，取不到值时按「关」更安全
      setChatEnabled(isSettingOn(s.chat_enabled, false))
      // ⚠️ 原先是 `!== "0"` ⇒ 存了 "false" 时显示「允许访客」，与后端相反
      setCommunityGuestAccess(isSettingOn(s.community_guest_access, true))
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
      // 限时开放注册：总开关 + 截止时间（后端存 ISO，转成本地 datetime-local 显示）
      setOpenRegistration(isSettingOn(s.open_registration, false))
      setOpenRegistrationUntil(toLocalInput(s.open_registration_until || null))
      // 自动审核：后端存空串表示「全部转人工」
      const autoRaw = (s.auto_review_features ?? "").split(",").map((x) => x.trim()).filter(Boolean)
      setAutoReview({
        ai: autoRaw.includes("ai"),
        frp: autoRaw.includes("frp"),
        proxy: autoRaw.includes("proxy"),
      })
      // ---- 2026-09-26 补齐的设置项 ----
      setNewapiFreePlanId(s.newapi_free_plan_id ?? "1")
      setQuotaPerUnitInput(s.newapi_quota_per_unit ?? "500000")
      setInviteRewardEnabled(isSettingOn(s.invite_reward_enabled, true))
      setInviteRewardPlanId(s.invite_reward_plan_id ?? "2")
      setInviteRewardAiPlanId(s.invite_reward_ai_plan_id ?? "3")
      setAchievementRewardEnabled(isSettingOn(s.achievement_reward_enabled, false))
      setAchievementRewardPlanId(s.achievement_reward_plan_id ?? "4")
      setAchievementRewardPoints(s.achievement_reward_points ?? "10")
      setInviteQuotaBase(s.invite_quota_base ?? "3")
      setProxyEnabled(isSettingOn(s.proxy_enabled, true))
      setFeedbackNotifyEmail(s.feedback_admin_notify_email ?? "")
      // 积分系统的开关/比例/每日上限不在这里：改由 管理面板 → 积分 → 商城 维护
      // （见 admin-points.tsx 商品表第一行的「内置商品」行，接口是 PUT /api/admin/points/config）
      // 出站邮件通道
      setMailTransportOrder(s.mail_transport_order ?? "posta,brevo,cf")
      setAnnouncementMailTransport(s.announcement_mail_transport ?? "posta")
      setMailCfTargets(s.mail_cf_targets ?? "")
      setPostaUrl(s.posta_url ?? "")
      setPostaFrom(s.posta_from ?? "")
      setBrevoSenderEmail(s.brevo_sender_email ?? "")
      setBrevoSenderName(s.brevo_sender_name ?? "Doulor Cloud")
      setPostaConfigured(Boolean(res.mailSecrets?.postaConfigured))
      setBrevoKeys(res.mailSecrets?.brevoKeys ?? [])
      // 密钥明文不回传，输入框清空（placeholder 显示「已配置」）
      setPostaKey("")
      setBrevoAddInput("")
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.39"))
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
        storage_quota_bytes: Math.round(Number(quotaMb) * 1024 * 1024),
        storage_max_file_bytes: Math.round(Number(maxFileMb) * 1024 * 1024),
        storage_enabled: storageEnabled,
        newapi_trial_quota: Math.round(Number(trialQuotaUsd) * quotaPerUnit),
        newapi_group: newapiGroup,
        newapi_unlimited_quota: newapiUnlimited,
        newapi_enabled: newapiEnabled,
        newapi_visible_groups: newapiVisibleGroups,
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
        chat_enabled: chatEnabled,
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
        // 限时开放注册：总开关 + 截止时间（本地时间转 ISO；留空 = 不自动关闭）
        open_registration: openRegistration,
        open_registration_until: fromLocalInput(openRegistrationUntil) ?? "",
        // 自动审核的模块，逗号分隔；全关时发空串 = 全部转人工
        auto_review_features: Object.entries(autoReview)
          .filter(([, on]) => on)
          .map(([k]) => k)
          .join(","),
        // 反代账号捐献通道
        wb2api_enabled: wb2apiEnabled,
        wb2api_donation_visible: wb2apiDonationVisible,
        wb2api_max_bindings: String(Math.max(1, Math.round(Number(wb2apiMaxBindings) || 3))),
        wb2api_base_url: wb2apiBaseUrl.trim(),
        wb2api_realm: wb2apiRealm,
        // CLI2API 反代账号捐献通道
        cli2api_enabled: cli2apiEnabled,
        cli2api_donation_visible: cli2apiDonationVisible,
        cli2api_max_bindings: String(Math.max(1, Math.round(Number(cli2apiMaxBindings) || 3))),
        cli2api_base_url: cli2apiBaseUrl.trim(),
        cli2api_provider: cli2apiProvider,
        cli2api_region: cli2apiRegion,
        // 商汤 Key 捐献通道
        sensenova_enabled: sensenovaEnabled,
        sensenova_donation_visible: sensenovaDonationVisible,
        sensenova_base_url: sensenovaBaseUrl.trim(),
        // 空串是合法值（= 通道未配置、捐献转人工），要原样提交才能「清空」
        sensenova_channel_id: sensenovaChannelId.trim(),
        // ---- 2026-09-26 补齐：原先有输入框但漏在 payload 里 / 完全没有入口的设置项 ----
        // ⚠️ subdomain_quota_default 原先就是「有框但不保存」，改完会被 loadSettings 刷回去
        subdomain_quota_default: Math.max(0, Math.round(Number(subQuota) || 0)),
        newapi_free_plan_id: Math.max(0, Math.round(Number(newapiFreePlanId) || 0)),
        newapi_quota_per_unit: Math.max(1, Math.round(Number(quotaPerUnitInput) || 500000)),
        invite_reward_enabled: inviteRewardEnabled,
        invite_reward_plan_id: Math.max(0, Math.round(Number(inviteRewardPlanId) || 0)),
        invite_reward_ai_plan_id: Math.max(0, Math.round(Number(inviteRewardAiPlanId) || 0)),
        achievement_reward_enabled: achievementRewardEnabled,
        achievement_reward_plan_id: Math.max(0, Math.round(Number(achievementRewardPlanId) || 0)),
        achievement_reward_points: Math.max(1, Math.round(Number(achievementRewardPoints) || 10)),
        invite_quota_base: Math.max(0, Math.round(Number(inviteQuotaBase) || 0)),
        proxy_enabled: proxyEnabled,
        feedback_admin_notify_email: feedbackNotifyEmail.trim(),
        // ---- 出站邮件通道 ----
        // 密钥留空则不更新（后端空串跳过，见 updateSettingsHandler），
        // 所以这里原样传，用户没填新 key 就不会覆盖旧值。
        mail_transport_order: mailTransportOrder.trim(),
        announcement_mail_transport: announcementMailTransport,
        mail_cf_targets: mailCfTargets.trim(),
        posta_url: postaUrl.trim(),
        posta_key: postaKey.trim(),
        posta_from: postaFrom.trim(),
        // brevo_api_key 不在这里提交：它的列表是「改完立刻生效」的，
        // 且前端只有打码串、无法原样回传（见 saveBrevoKeys 的 keep:<n> 协议）。
        brevo_sender_email: brevoSenderEmail.trim(),
        brevo_sender_name: brevoSenderName.trim(),
      })
      toast.success(t("adm.40"))
      await loadSettings()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.41"))
    } finally {
      setSettingsBusy(false)
    }
  }

  /**
   * 保存 Brevo Key 列表（改完立刻生效，不等下面的「保存设置」）。
   *
   * 为什么用 keep:<n> 协议：明文永不回前端，前端拿不到「原 Key」，
   * 只能用序号表示「保留第 n 把」，后端据此把原值取回来。
   * 传空数组 = 一把都不留 ⇒ 后端清空全部。
   */
  const saveBrevoKeys = async (keepIndices: number[], newKeys: string[]) => {
    const parts = [...keepIndices.map((i) => `keep:${i}`), ...newKeys]
    setBrevoBusy(true)
    try {
      const res = await adminApi.updateSettings({ brevo_api_key: parts.join(",") })
      setBrevoKeys(res.mailSecrets?.brevoKeys ?? [])
      return true
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.42"))
      return false
    } finally {
      setBrevoBusy(false)
    }
  }

  const handleAddBrevoKey = async () => {
    const added = brevoAddInput
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (added.length === 0) {
      toast.error(t("adm.43"))
      return
    }
    const keep = brevoKeys.map((_, i) => i + 1)
    if (await saveBrevoKeys(keep, added)) {
      setBrevoAddInput("")
      toast.success(`已添加 ${added.length} 把 Brevo Key`)
    }
  }

  const handleRemoveBrevoKey = async (index1Based: number) => {
    const keep = brevoKeys.map((_, i) => i + 1).filter((n) => n !== index1Based)
    if (await saveBrevoKeys(keep, [])) toast.success(t("adm.44"))
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
      toast.success(t("adm.45"))
      void load()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.46"))
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
      toast.error(err instanceof HttpError ? err.message : t("adm.47"))
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
      toast.error(err instanceof HttpError ? err.message : t("adm.48"))
    } finally {
      setWb2apiLoading(false)
    }
    // 绑定列表与池概览各自容错：一个失败不该让整页空白。
    // ⚠️ 2026-09-26：但失败要**提示**，不能静默置空 —— 否则管理员会把
    // 「读取失败」误判成「确实没有绑定 / 池是空的」。
    try {
      const b = await wb2apiApi.listBindings()
      setWb2apiBindings(b.bindings)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.49"))
      setWb2apiBindings([])
    }
    try {
      const p = await wb2apiApi.getPool()
      setWb2apiPool(p.pool)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.50"))
      setWb2apiPool(null)
    }
  }, [])

  const handleSaveWb2apiKey = async () => {
    const key = wb2apiNewKey.trim()
    if (!key) {
      toast.error(t("adm.51"))
      return
    }
    setWb2apiBusy(true)
    try {
      const res = await wb2apiApi.saveConfig(key)
      setWb2apiNewKey("") // 明文用完即弃，不留内存
      toast.success(res.message || t("adm.52"))
      void loadWb2api()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.53"))
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
          ? t("adm.54")
          : t("adm.55")
      )
      if (res.upstreamWarning) {
        toast.warning(`网关侧移除失败：${res.upstreamWarning}`)
      }
      setWb2apiRemoving(null)
      void loadWb2api()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.56"))
    } finally {
      setWb2apiBusy(false)
    }
  }

  // ---- CLI2API 反代账号捐献（第二条通道）----

  const loadCli2api = React.useCallback(async () => {
    setCli2apiLoading(true)
    try {
      const cfg = await cli2apiApi.getConfig()
      setCli2apiConfig(cfg)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.57"))
    } finally {
      setCli2apiLoading(false)
    }
    try {
      const b = await cli2apiApi.listBindings()
      setCli2apiBindings(b.bindings)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.58"))
      setCli2apiBindings([])
    }
    try {
      const p = await cli2apiApi.getPool()
      setCli2apiPool(p)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.59"))
      setCli2apiPool(null)
    }
  }, [])

  const handleSaveCli2apiKey = async () => {
    const key = cli2apiNewKey.trim()
    if (!key) {
      toast.error(t("adm.60"))
      return
    }
    setCli2apiBusy(true)
    try {
      await cli2apiApi.saveConfig(key)
      setCli2apiNewKey("")
      toast.success(t("adm.61"))
      void loadCli2api()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.62"))
    } finally {
      setCli2apiBusy(false)
    }
  }

  const handleRemoveCli2apiBinding = async () => {
    const b = cli2apiRemoving
    if (!b) return
    setCli2apiBusy(true)
    try {
      const res = await cli2apiApi.removeBinding(b.id, cli2apiRevokeAi)
      toast.success(
        res.aiRevoked
          ? t("adm.63")
          : t("adm.64")
      )
      if (res.upstreamWarning) {
        toast.warning(`上游删除失败：${res.upstreamWarning}`)
      }
      setCli2apiRemoving(null)
      void loadCli2api()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.65"))
    } finally {
      setCli2apiBusy(false)
    }
  }

  const handleUpdateNewApiToken = async () => {
    const token = newapiNewToken.trim()
    if (!token) {
      toast.error(t("adm.66"))
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
      toast.success(res.message || t("adm.67"))
      void loadNewApiConfig()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.68"))
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
      toast.success(t("adm.69"))
      setPermInvite(null)
      setPermDraft(null)
      void loadInvites()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.70"))
    } finally {
      setPermBusy(false)
    }
  }

  const loadInviteQuotas = React.useCallback(async () => {
    setInviteQuotaLoading(true)
    try {
      setInviteQuotas(await adminApi.listInviteQuotas())
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.71"))
    } finally {
      setInviteQuotaLoading(false)
    }
  }, [])

  const openQuotaDetail = async (username: string) => {
    setQuotaDetailBusy(true)
    try {
      setQuotaDetail(await adminApi.getUserInviteQuota(username))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.72"))
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
      toast.success(t("adm.73"))
      void loadInviteQuotas()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.74"))
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
      toast.error(err instanceof HttpError ? err.message : t("adm.75"))
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
      toast.success(t("adm.76"))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.77"))
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
      toast.error(err instanceof HttpError ? err.message : t("adm.78"))
    }
  }

  // 昵称保留词：增/删都直接写 settings.reserved_nicknames
  const saveNickReserved = async (next: string[]) => {
    setNickReservedBusy(true)
    try {
      await adminApi.updateSettings({ reserved_nicknames: next.join(",") })
      setNickReserved(next)
      toast.success(t("adm.79"))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.80"))
    } finally {
      setNickReservedBusy(false)
    }
  }
  const handleAddNickReserved = async () => {
    const w = nickReservedInput.trim()
    if (!w) return
    if (nickReserved.some((x) => x.toLowerCase() === w.toLowerCase())) {
      toast.error(t("adm.81"))
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
      toast.error(err instanceof HttpError ? err.message : t("adm.82"))
    } finally {
      setAnnouncementLoading(false)
    }
  }, [])

  const openAnnouncementDialog = (a?: Announcement) => {
    setAnnDraft(
      a
        ? {
            id: a.id,
            title: a.title,
            body: a.body,
            category: a.category,
            pinned: a.pinned,
            popupMode: a.popupMode,
            notifyByEmail: a.notifyEmail,
            status: a.status,
            publishAt: toLocalInput(a.publishAt),
          }
        : {
            id: null,
            title: "",
            body: "",
            category: "general",
            pinned: false,
            popupMode: "none",
            notifyByEmail: false,
            status: "published",
            publishAt: "",
          }
    )
    setAnnouncementOpen(true)
  }

  const handleSaveAnnouncement = async () => {
    if (!annDraft.title.trim() || !annDraft.body.trim()) return
    if (annDraft.status === "scheduled" && !annDraft.publishAt) {
      toast.error(t("adm.83"))
      return
    }
    setAnnouncementBusy(true)
    try {
      const payload = {
        title: annDraft.title,
        body: annDraft.body,
        category: annDraft.category,
        pinned: annDraft.pinned,
        popupMode: annDraft.popupMode,
        notifyByEmail: annDraft.notifyByEmail,
        status: annDraft.status,
        // 仅定时发布提交时间；其它状态传 null，避免残留脏值
        publishAt: annDraft.status === "scheduled" ? fromLocalInput(annDraft.publishAt) : null,
      }
      const res = annDraft.id
        ? await announcementApi.update(annDraft.id, payload)
        : await announcementApi.create(payload)
      // 邮件已入队、后台分批发送：这里只说「已排入队列」，真实进度看列表里的
      // 「推送中 x/y」标记（loadAnnouncements 会刷新）
      if (res.queued) {
        toast.success(`已排入邮件队列（${res.queued} 个收件人），后台正在分批发送`)
      } else if (annDraft.status === "draft") {
        toast.success(t("adm.84"))
      } else if (annDraft.status === "scheduled") {
        toast.success(`已设置定时发布（${new Date(fromLocalInput(annDraft.publishAt)!).toLocaleString("zh-CN")}）`)
      } else {
        toast.success(annDraft.id ? t("adm.85") : t("adm.86"))
      }
      setAnnouncementOpen(false)
      void loadAnnouncements()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.87"))
    } finally {
      setAnnouncementBusy(false)
    }
  }

  const handleDeleteAnnouncement = async (id: string) => {
    try {
      await announcementApi.remove(id)
      void loadAnnouncements()
      toast.success(t("adm.88"))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.89"))
    }
  }

  /**
   * 重发某条公告里发送失败的邮件。
   *
   * 服务端只重置 failed 行、并校正计数，然后照常分批发送（走的是和首次群发
   * 完全相同的那条通道链），所以发送期间列表会显示「推送中 x/y」。
   */
  const handleResendAnnouncementMails = async (a: Announcement) => {
    try {
      const res = await announcementApi.resendFailed(a.id)
      if (res.requeued === 0) {
        toast.info(t("adm.90"))
      } else {
        toast.success(`已重新排入队列（${res.requeued} 封），后台正在发送`)
      }
      void loadAnnouncements()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.91"))
    }
  }

  // ---- 活动 ----
  const loadEvents = React.useCallback(async () => {
    setEventLoading(true)
    try {
      const res = await adminEventApi.list()
      setEvents(res.events)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.92"))
    } finally {
      setEventLoading(false)
    }
  }, [])

  const openEventDialog = (ev?: EventItem) => {
    setEventDraft(
      ev
        ? {
            id: ev.id,
            title: ev.title,
            body: ev.body,
            status: ev.status,
            startsAt: toLocalInput(ev.startsAt),
            endsAt: toLocalInput(ev.endsAt),
            rewardLabel: ev.rewardLabel ?? "",
            rewardType: ev.rewardType,
            rewardAmount: String(ev.rewardParams?.amount ?? ev.rewardParams?.count ?? ""),
            // 「区间随机」的判据就是存了 min/max（老配置只有 amount）
            pointsRandom:
              ev.rewardParams?.min !== undefined || ev.rewardParams?.max !== undefined,
            rewardMin: String(ev.rewardParams?.min ?? ""),
            rewardMax: String(ev.rewardParams?.max ?? ""),
            conditionType: ev.conditionType,
            conditionFeature: String(ev.conditionParams?.feature ?? "ai"),
            conditionCode: String(ev.conditionParams?.code ?? ""),
            conditionRepo: String(ev.conditionParams?.repo ?? "Doulor/DoulorCloud"),
            lotteryWinners: String(ev.conditionParams?.winners ?? "10"),
            lotteryPool: String(ev.conditionParams?.pool ?? "1000"),
            lotteryMode: ev.conditionParams?.mode === "random" ? "random" : "even",
            maxClaims: ev.maxClaims != null ? String(ev.maxClaims) : "",
            publishAt: toLocalInput(ev.publishAt),
          }
        : emptyEventDraft()
    )
    setEventOpen(true)
  }

  const handleSaveEvent = async () => {
    if (!eventDraft.title.trim() || !eventDraft.body.trim()) {
      toast.error(t("adm.93"))
      return
    }
    if (eventDraft.status === "scheduled" && !eventDraft.publishAt) {
      toast.error(t("adm.94"))
      return
    }
    if (eventDraft.maxClaims.trim() !== "" && !(Number(eventDraft.maxClaims) >= 1)) {
      toast.error(t("adm.95"))
      return
    }
    setEventBusy(true)
    try {
      const payload = eventDraftToPayload(eventDraft)
      const res = eventDraft.id
        ? await adminEventApi.update(eventDraft.id, payload)
        : await adminEventApi.create(payload)
      toast.success(
        eventDraft.id
          ? t("adm.96")
          : res.inserted > 0
            ? `已发布，推送给 ${res.inserted} 个用户`
            : t("adm.97")
      )
      setEventOpen(false)
      void loadEvents()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.98"))
    } finally {
      setEventBusy(false)
    }
  }

  const handleDeleteEvent = async (ev: EventItem) => {
    if (!confirm(`确定删除活动「${ev.title}」？领取记录会一并删除。`)) return
    try {
      await adminEventApi.remove(ev.id)
      void loadEvents()
      toast.success(t("adm.99"))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.100"))
    }
  }

  /** 抽奖开奖：二次确认后调接口（不可撤销，且真发积分） */
  const handleDrawEvent = async (ev: EventItem) => {
    const l = ev.lottery
    if (!l) return
    if (
      !confirm(
        `现在给「${ev.title}」开奖？\n\n当前 ${ev.claimCount ?? 0} 人报名，` +
          `将随机抽 ${Math.min(l.winners, ev.claimCount ?? 0)} 人，` +
          `共发放 ${l.pool} 积分（${l.mode === "even" ? "平均分" : "随机分"}）。\n` +
          `开奖后不可撤销，也不能再有人报名。`
      )
    ) {
      return
    }
    setEventBusy(true)
    try {
      const res = await adminEventApi.draw(ev.id)
      toast.success(
        `开奖完成：${res.participants} 人报名，抽中 ${res.winners} 人，共发放 ${res.distributed} 积分` +
          (res.failed > 0 ? `（${res.failed} 份发放失败，可在领取名单手动补）` : "")
      )
      void loadEvents()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.101"))
    } finally {
      setEventBusy(false)
    }
  }

  const openClaimsDialog = async (ev: EventItem) => {
    setClaimsEvent(ev)
    setClaimsOpen(true)
    setClaimsLoading(true)
    try {
      const res = await adminEventApi.claims(ev.id)
      setClaims(res.claims)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.102"))
      setClaims([])
    } finally {
      setClaimsLoading(false)
    }
  }

  const handleGrantClaim = async (claim: EventClaim) => {
    if (!claimsEvent) return
    try {
      await adminEventApi.grant(claimsEvent.id, claim.id)
      toast.success(t("adm.103"))
      const res = await adminEventApi.claims(claimsEvent.id)
      setClaims(res.claims)
      notifyAttentionChanged() // 活动角标当场减一，不用等 60 秒轮询
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.104"))
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
      toast.error(err instanceof HttpError ? err.message : t("adm.105"))
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
        // 草稿单位 MB（库里存的是字节）
        quotaPerUser: String(Math.round((bucket.quotaPerUser / 1024 / 1024) * 100) / 100),
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
        quotaPerUser: "1024",
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
          ? t("adm.106")
          : t("adm.107")
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
        // 草稿是 MB，后端要字节
        quotaPerUser: Math.round((Number(r2Draft.quotaPerUser) || 1024) * 1024 * 1024),
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
        toast.success(t("adm.108"))
      } else {
        if (!r2Draft.id.trim()) {
          toast.error(t("adm.109"))
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
        toast.success(t("adm.110"))
      }
      setR2BucketOpen(false)
      void loadR2()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.111"))
    } finally {
      setR2Busy(false)
    }
  }

  const handleDeleteR2Bucket = async (id: string, name: string) => {
    if (!confirm(`确定删除桶「${name}」？仍有用户分配时会被拒绝。`)) return
    try {
      await r2AdminApi.remove(id)
      void loadR2()
      toast.success(t("adm.112"))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.113"))
    }
  }

  const handleTestR2Bucket = async (id: string, write: boolean) => {
    try {
      const res = write ? await r2AdminApi.writeTest(id) : await r2AdminApi.test(id)
      if (res.ok) toast.success(res.message ?? t("adm.114"))
      else toast.error(res.error ?? t("adm.115"))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.116"))
    }
  }

  /**
   * 设置页直接改某个桶的「人数上限」。
   *
   * 只发 maxUsers 一个字段：后端是「undefined 就保留原值」的局部更新，
   * 这样不必把端点/凭据等敏感字段回传（回传空串反而会被当成「要清空」）。
   */
  const handleSaveBucketMaxUsers = async (bucketId: string) => {
    const raw = bucketMaxDraft[bucketId]
    const n = Math.trunc(Number(raw))
    if (!Number.isFinite(n) || n < 1) {
      toast.error(t("adm.117"))
      return
    }
    setBucketMaxBusy(bucketId)
    try {
      await r2AdminApi.update(bucketId, { maxUsers: n })
      // 清掉这一行的草稿，让它回到「已保存」状态
      setBucketMaxDraft((d) => {
        const next = { ...d }
        delete next[bucketId]
        return next
      })
      await loadR2()
      toast.success(t("adm.118"))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.119"))
    } finally {
      setBucketMaxBusy(null)
    }
  }

  const handleAssignBucket = async (username: string, bucketId: string) => {
    try {
      await r2AdminApi.assign(username, bucketId)
      void loadR2()
      toast.success(`已把 ${username} 改派到 ${bucketId || t("adm.120")}`)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.121"))
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
            toast.error(e2 instanceof HttpError ? e2.message : t("adm.122"))
          }
        }
        return
      }
      toast.error(err instanceof HttpError ? err.message : t("adm.123"))
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
      toast.error(err instanceof HttpError ? err.message : t("adm.124"))
    } finally {
      setSettingsBusy(false)
    }
  }

  const filtered = users.filter((u) =>
    (u.username + u.email + u.namespace).toLowerCase().includes(filter.toLowerCase())
  )

  // 用户邀请码列表的搜索（用户名 / 邮箱 / 域名），与用户列表同口径
  const quotaUsers = (inviteQuotas?.users ?? []).filter((u) =>
    (u.username + u.email + u.namespace)
      .toLowerCase()
      .includes(quotaFilter.trim().toLowerCase())
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
      // 网盘配额草稿（MB，保留两位小数，够 512 MB / 1.5 GB 这种）
      setStorageQuotaMbDraft(
        res.storage ? String(Math.round((res.storage.quotaBytes / 1024 / 1024) * 100) / 100) : ""
      )
      setDetailUser(username)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.125"))
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
      toast.success(nickDraft.trim() === "" ? t("adm.126") : t("adm.127"))
      void load()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.128"))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 保存单个用户的网盘配额（MB → 字节）。
   *
   * 为什么需要这个：`storage_accounts.quota_bytes` 是**开通那一刻写死的快照**，
   * 改桶的「每人配额」只影响之后新开通的人，存量用户不会跟着变。
   */
  const handleSaveStorageQuota = async () => {
    if (!detail?.storage) return
    const mb = Number(storageQuotaMbDraft)
    if (!Number.isFinite(mb) || mb <= 0) {
      toast.error(t("adm.129"))
      return
    }
    const bytes = Math.round(mb * 1024 * 1024)
    // 配额低于已用量：不删已有文件，但用户传不了新东西 ⇒ 让站长确认
    if (bytes < detail.storage.usedBytes) {
      if (
        !confirm(
          `该用户已用 ${formatBytes(detail.storage.usedBytes)}，改成 ${formatBytes(bytes)} 后会超额。\n` +
            `已有文件不会被删，但该用户将无法再上传。确定继续？`
        )
      ) {
        return
      }
    }
    setStorageQuotaBusy(true)
    try {
      await adminApi.updateStorageQuota(detail.user.username, bytes)
      const res = await adminApi.getUser(detail.user.username)
      setDetail(res)
      toast.success(t("adm.130"))
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.131"))
    } finally {
      setStorageQuotaBusy(false)
    }
  }

  /**
   * 把存量用户的配额一次性刷成「所属桶的每人配额」。
   *
   * 先用前端已有的桶/用户数据算一遍预览，把「谁从多少改成多少」摆给站长看，再提交。
   */
  const handleSyncStorageQuota = async () => {
    const buckets = (r2Data?.buckets ?? []).filter((b) => b.kind !== "platform")
    if (buckets.length === 0) {
      toast.error(t("adm.132"))
      return
    }
    // 预览要跟后端口径一致：管理员被跳过，不能列进「会被改成多少」里误导站长
    const isAdminRole = (r: string) => r === "admin" || r === "root"
    const preview: string[] = []
    let adminCount = 0
    for (const b of buckets) {
      for (const u of b.users) {
        if (isAdminRole(u.role)) {
          adminCount++
          continue
        }
        if (u.quotaBytes !== b.quotaPerUser) {
          preview.push(`${u.username}：${formatBytes(u.quotaBytes)} → ${formatBytes(b.quotaPerUser)}`)
        }
      }
    }
    // 未纳入多桶的老用户（bucket_id 为空）会被刷成「默认存储配额」，也要一并预告
    const defaultBytes = Math.round(Number(quotaMb) * 1024 * 1024)
    for (const u of r2Data?.legacyBucket?.users ?? []) {
      if (isAdminRole(u.role)) {
        adminCount++
        continue
      }
      if (u.quotaBytes !== defaultBytes) {
        preview.push(
          `${u.username}：${formatBytes(u.quotaBytes)} → ${formatBytes(defaultBytes)}（默认桶）`
        )
      }
    }
    const shown = preview.slice(0, 12)
    const more = preview.length > shown.length ? `\n…另外 ${preview.length - shown.length} 人` : ""
    const ok = confirm(
      `把存量用户的网盘配额改成「所属桶的每人配额」？\n\n` +
        `各桶配额：${buckets.map((b) => `${b.name} ${formatBytes(b.quotaPerUser)}`).join("、")}\n\n` +
        (preview.length ? shown.join("\n") + more : "（所有普通用户已经一致，无需改动）") +
        `\n\n管理员 ${adminCount} 个会被跳过（需要的话在成员详情里单独改）；已有文件不会被删。`
    )
    if (!ok) return
    setSyncQuotaBusy(true)
    try {
      const res = await adminApi.syncStorageQuota()
      toast.success(
        `已更新 ${res.updated} 个用户` +
          (res.skippedAdmins ? `，跳过 ${res.skippedAdmins} 个管理员` : "") +
          (res.overQuota ? `，其中 ${res.overQuota} 人已超额` : "")
      )
      await loadR2()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.133"))
    } finally {
      setSyncQuotaBusy(false)
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
      toast.success(`${label}已${value ? t("adm.134") : t("adm.135")}`)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.136"))
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
      toast.success(nextRole === "admin" ? t("adm.137") : t("adm.138"))
      void load()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.139"))
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
      toast.success(res.user.status === "suspended" ? t("adm.140") : t("adm.141"))
      void load()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.142"))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 对齐该用户的中转站账号状态（启用 / 禁用）。
   *
   * 用途：商汤 Key 巡检收回 `ai` 权限时会连带**禁用**中转站账号；用户后来
   * 重新捐到权限后审批会自动解禁，但**修复上线之前**被禁的账号仍是禁用的
   * （用户 pillbox 就是这种历史遗留），需要在这里一键对齐。
   *
   * 方向由服务端判断（按「该不该有 ai 权限」），前端不做决定 —— 只传用户名，
   * 避免全量同步撞满 Worker 的 subrequest 上限。
   */
  const handleSyncNewApi = async () => {
    if (!detail) return
    setNewapiSyncBusy(true)
    try {
      const res = await adminApi.syncNewApiPermissions({
        username: detail.user.username,
      })
      toast.success(
        `已对齐中转站状态：启用 ${res.enabled} 个、禁用 ${res.disabled} 个` +
          (res.errors.length ? `，${res.errors.length} 个出错` : "")
      )
      if (res.errors.length) console.warn("中转站对齐出错：", res.errors)
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.143"))
    } finally {
      setNewapiSyncBusy(false)
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
      toast.error(err instanceof HttpError ? err.message : t("adm.144"))
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
      toast.success(t("adm.145"))
      setDetail(null)
      setDetailUser("")
      void load()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("adm.146"))
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
      toast.error(err instanceof HttpError ? err.message : t("adm.147"))
    }
  }

  /**
   * 拉取各栏目「待处理」角标（反馈 / 捐献 / 积分），与侧边栏「管理」总角标同源。
   *
   * 依赖 `activeTab`：管理员处理完一批事通常会切走，切 tab 顺手重取一次，
   * 不必等下一次轮询；60 秒轮询是兜底，让「处理完一条角标自己减一」也能生效。
   */
  React.useEffect(() => {
    let cancelled = false
    const tick = () => {
      attentionApi
        .get()
        .then((r) => !cancelled && setAttention(r.admin))
        .catch(() => {})
    }
    tick()
    const t = setInterval(() => {
      if (!document.hidden) tick()
    }, 60_000)
    // 处理完一条待办后立即重拉（见 confirmReview / handleGrantClaim；
    // 反馈与积分的处理在各自子组件里，也会广播同一事件）
    const off = onAttentionChanged(tick)
    return () => {
      cancelled = true
      clearInterval(t)
      off()
    }
  }, [activeTab])

  /** 切换管理面板 tab：切到对应标签时懒加载该标签的数据 */
  const handleTabChange = (v: string) => {
    setActiveTab(v)
    if (v === "invites") void loadInvites()
    if (v === "settings") {
      void loadSettings()
      // 「网盘配额」卡片里要展示/编辑每个桶的人数上限，所以设置页也要拉一次桶列表
      void loadR2()
    }
    if (v === "mail") void loadSettings()
    if (v === "frp") void loadFrp()
    if (v === "proxy") void loadProxy()
    if (v === "reserved") void loadReserved()
    if (v === "donations") { void loadDonations(); void loadWb2api() }
    if (v === "announcements") void loadAnnouncements()
    if (v === "events") void loadEvents()
    if (v === "inviteQuotas") void loadInviteQuotas()
    if (v === "r2") void loadR2()
    if (v === "community") void loadCommunity()
    if (v === "newapi") { void loadSettings(); void loadNewApiConfig() }
    // 「捐献通道」一个选项卡里放三条通道（wb2api / cli2api / 商汤），
    // 三条的设置都走同一个 PUT /admin/settings ⇒ 进这个 tab 要一次把三方数据都拉齐
    if (v === "wb2api") {
      void loadWb2api()
      void loadCli2api()
      void loadSettings()
    }
  }

  return (
    <div>
      <PageHeader
        title={t("adm.213")}
        description={`已注册用户 ${users.length} 个 · 邀请码 ${invites.length} 个`}
      />

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <div className="flex flex-col gap-6 lg:flex-row">
          {/* 左侧二级导航：sticky 固定，右侧内容再长也能随时切栏目。
              「返回控制台」固定在最上，不随下方 nav 滚动 */}
          <aside className="flex w-full shrink-0 flex-col lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:w-48 lg:self-start">
            <Link
              to="/dashboard"
              className="mb-3 inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              {t("adm.326")}
            </Link>

            <nav className="flex flex-col gap-0.5 lg:overflow-y-auto lg:pr-1">
              <NavItem active={activeTab === "users"} icon={Users} label={t("adm.214")} onClick={() => handleTabChange("users")} />
              <NavGroup label={t("adm.215")}>
                <NavItem active={activeTab === "invites"} icon={KeyRound} label={t("adm.216")} onClick={() => handleTabChange("invites")} />
                <NavItem active={activeTab === "inviteQuotas"} icon={Ticket} label={t("adm.217")} onClick={() => handleTabChange("inviteQuotas")} />
                <NavItem active={activeTab === "reserved"} icon={ShieldBan} label={t("adm.218")} onClick={() => handleTabChange("reserved")} />
                <NavItem active={activeTab === "titles"} icon={Medal} label={t("adm.219")} onClick={() => handleTabChange("titles")} />
              </NavGroup>
              <NavGroup label={t("adm.220")}>
                <NavItem active={activeTab === "newapi"} icon={Sparkles} label={t("adm.221")} onClick={() => handleTabChange("newapi")} />
                {/* 三条免审核捐献通道（wb2api / cli2api / 商汤）合并在一个选项卡里 */}
                <NavItem active={activeTab === "wb2api"} icon={Unplug} label={t("adm.222")} onClick={() => handleTabChange("wb2api")} />
                <NavItem active={activeTab === "r2"} icon={Database} label={t("adm.223")} onClick={() => handleTabChange("r2")} />
                <NavItem active={activeTab === "frp"} icon={Network} label={t("adm.224")} onClick={() => handleTabChange("frp")} />
                <NavItem active={activeTab === "proxy"} icon={Zap} label={t("adm.225")} onClick={() => handleTabChange("proxy")} />

                {/* 角标 = DNS 合规扫描里待处理的问题条数（原先解析功能完全没有审核）。
                    标签用 dns.* 前缀，避开并发进行的 adm.* 编号 */}
                <NavItem
                  active={activeTab === "dns"}
                  icon={Globe}
                  label={t("dns.nav")}
                  count={attention?.dnsFindings}
                  onClick={() => handleTabChange("dns")}
                />
              </NavGroup>
              <NavGroup label={t("adm.226")}>
                <NavItem active={activeTab === "announcements"} icon={Megaphone} label={t("adm.227")} onClick={() => handleTabChange("announcements")} />
                <NavItem active={activeTab === "funLinks"} icon={Compass} label={t("adm.228")} onClick={() => handleTabChange("funLinks")} />
                {/* 角标 = 活动奖励里「自动发放失败、要人工发」的条数（见各活动的「领取名单」） */}
                <NavItem
                  active={activeTab === "events"}
                  icon={PartyPopper}
                  label={t("adm.229")}
                  count={attention?.eventClaims}
                  onClick={() => handleTabChange("events")}
                />
                {/* 「积分」角标 = 待审核商品 + 待处理订单，两项之和与侧边栏总角标口径一致 */}
                <NavItem
                  active={activeTab === "points"}
                  icon={Coins}
                  label={t("adm.230")}
                  count={(attention?.pointProducts ?? 0) + (attention?.pointOrders ?? 0)}
                  onClick={() => handleTabChange("points")}
                />
                <NavItem active={activeTab === "community"} icon={MessagesSquare} label={t("adm.231")} onClick={() => handleTabChange("community")} />
                <NavItem
                  active={activeTab === "donations"}
                  icon={Heart}
                  label={t("adm.232")}
                  count={attention?.donations}
                  onClick={() => handleTabChange("donations")}
                />
                <NavItem
                  active={activeTab === "feedback"}
                  icon={MessageSquare}
                  label={t("adm.233")}
                  count={attention?.feedback}
                  onClick={() => handleTabChange("feedback")}
                />
              </NavGroup>
              <NavGroup label={t("adm.234")}>
                <NavItem active={activeTab === "oauth"} icon={KeyRound} label={t("adm.235")} onClick={() => handleTabChange("oauth")} />
                <NavItem active={activeTab === "analytics"} icon={BarChart3} label={t("adm.236")} onClick={() => handleTabChange("analytics")} />
                <NavItem active={activeTab === "cfQuota"} icon={Gauge} label={t("adm.237")} onClick={() => handleTabChange("cfQuota")} />
                <NavItem active={activeTab === "audit"} icon={ScrollText} label={t("adm.238")} onClick={() => handleTabChange("audit")} />
                <NavItem active={activeTab === "mail"} icon={Mail} label={t("adm.239")} onClick={() => handleTabChange("mail")} />
                <NavItem active={activeTab === "settings"} icon={SlidersHorizontal} label={t("adm.240")} onClick={() => handleTabChange("settings")} />
              </NavGroup>
            </nav>
          </aside>

          {/* 右侧内容区 */}
          <div className="min-w-0 flex-1">
        <TabsContent value="users">
          <div className="sticky top-4 z-20 -mx-1 mb-3 bg-background px-1 pb-1">
            <div className="relative max-w-sm">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={t("adm.241")}
                className="pl-8"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
          </div>

      {loading ? (
        <LoadingBlock />
      ) : filtered.length === 0 ? (
        <EmptyState title={t("adm.242")} description={t("adm.243")} />
      ) : (
        <div className="rounded-lg border bg-card">
          <Table wrapperClassName="overflow-x-auto lg:overflow-clip">
            <TableHeader>
              <TableRow>
                <TableHead className="sticky top-[56px] z-10 w-16 border-b bg-card">UID</TableHead>
                <TableHead className="sticky top-[56px] z-10 border-b bg-card">{t("adm.327")}</TableHead>
                <TableHead className="sticky top-[56px] z-10 border-b bg-card">{t("adm.328")}</TableHead>
                <TableHead className="sticky top-[56px] z-10 border-b bg-card">{t("adm.329")}</TableHead>
                <TableHead className="sticky top-[56px] z-10 border-b bg-card text-center">{t("adm.330")}</TableHead>
                <TableHead className="sticky top-[56px] z-10 border-b bg-card text-center">{t("adm.331")}</TableHead>
                <TableHead className="sticky top-[56px] z-10 border-b bg-card text-center">{t("adm.332")}</TableHead>
                <TableHead className="sticky top-[56px] z-10 border-b bg-card text-center">{t("adm.333")}</TableHead>
                <TableHead className="sticky top-[56px] z-10 border-b bg-card text-center">{t("adm.334")}</TableHead>
                <TableHead className="sticky top-[56px] z-10 border-b bg-card">{t("adm.335")}</TableHead>
                <TableHead className="sticky top-[56px] z-10 w-24 border-b bg-card" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((u) =>
                u.deleted ? (
                  // 已注销/被删用户：留痕行，只读展示，无可执行操作
                  <TableRow key={u.id} className="text-muted-foreground">
                    <TableCell className="font-mono text-xs">
                      {u.uid != null ? fmtUid(u.uid) : "—"}
                    </TableCell>
                    <TableCell colSpan={10}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm line-through">{u.username}</span>
                        <span className="text-xs">{u.email}</span>
                        <Badge variant="outline">{t("adm.336")}</Badge>
                        {u.deletedReason === "admin" && (
                          <Badge variant="destructive">{t("adm.337")}</Badge>
                        )}
                        <span className="text-xs">
                          注销于 {u.deletedAt ? fmtTime(u.deletedAt) : t("adm.148")}
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                <TableRow key={u.id}>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {u.uid != null ? fmtUid(u.uid) : "—"}
                  </TableCell>
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
                                : t("adm.149")}
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
                              title={t("adm.244")}
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
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground"
                        asChild
                        title={t("adm.245")}
                      >
                        <Link to={`/space/${encodeURIComponent(u.username)}`}>
                          <ExternalLink className="h-3.5 w-3.5" />
                        </Link>
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1 px-2 text-xs"
                        onClick={() => void openDetail(u.username)}
                        disabled={busy}
                        title={t("adm.246")}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        {t("adm.338")}
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
                        title={t("adm.247")}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
                )
              )}
            </TableBody>
          </Table>
        </div>
      )}
        </TabsContent>

        <TabsContent value="invites">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {t("adm.339")}
            </p>
            <Button size="sm" onClick={() => setInviteOpen(true)}>
              <Plus className="h-4 w-4" />
              {t("adm.340")}
            </Button>
          </div>

          {/* 分类筛选：数字是各分类的条数 */}
          <div className="mb-4 flex flex-wrap gap-2">
            {INVITE_FILTERS.map((f) => {
              const n = f.key === "" ? invites.length : filterInvites(invites, f.key).length
              const active = inviteFilter === f.key
              return (
                <Button
                  key={f.key || "all"}
                  size="sm"
                  variant={active ? "default" : "outline"}
                  onClick={() => setInviteFilter(f.key)}
                >
                  {f.label}
                  <span className="ml-1.5 tabular-nums opacity-70">{n}</span>
                </Button>
              )
            })}
          </div>

          {inviteLoading ? (
            <LoadingBlock />
          ) : invites.length === 0 ? (
            <EmptyState title={t("adm.248")} description={t("adm.249")} />
          ) : filterInvites(invites, inviteFilter).length === 0 ? (
            <EmptyState
              title={`没有${INVITE_FILTERS.find((f) => f.key === inviteFilter)?.label ?? ""}的邀请码`}
              description={t("adm.250")}
            />
          ) : (
            <div className="rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("adm.341")}</TableHead>
                    <TableHead>{t("adm.342")}</TableHead>
                    <TableHead>{t("adm.343")}</TableHead>
                    <TableHead>{t("adm.344")}</TableHead>
                    <TableHead>{t("adm.345")}</TableHead>
                    <TableHead className="w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filterInvites(invites, inviteFilter).map((inv) => {
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
                            title={t("adm.251")}
                          >
                            {FEATURES.filter((f) => inv.permissions[f.key]).length ===
                            FEATURES.length ? (
                              <Badge variant="secondary">{t("adm.346")}</Badge>
                            ) : FEATURES.filter((f) => inv.permissions[f.key]).length ===
                              0 ? (
                              <Badge variant="destructive">{t("adm.347")}</Badge>
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
                            <Badge variant="destructive">{t("adm.348")}</Badge>
                          ) : expired ? (
                            <Badge variant="destructive">{t("adm.349")}</Badge>
                          ) : (
                            <Badge variant="success">{t("adm.350")}</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground"
                              onClick={() => openInvitePerms(inv)}
                              title={t("adm.252")}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-destructive"
                              onClick={() => void handleDeleteInvite(inv)}
                              title={t("adm.253")}
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
              <Button variant="outline" size="sm" onClick={() => void loadFrp()}>
                <RefreshCw className="h-3.5 w-3.5" />
                {t("adm.351")}
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
                  authMode: "token",
                })
                setNodeOpen(true)
              }}
            >
              <Plus className="h-4 w-4" />
              {t("adm.352")}
            </Button>
          </div>

          {/* 申请分类筛选：数字是各分类的条数 */}
          <div className="mb-4 flex flex-wrap gap-2">
            {FRP_FILTERS.map((f) => {
              const n = f.key === "" ? frpApps.length : filterFrpApps(frpApps, f.key).length
              const active = frpFilter === f.key
              return (
                <Button
                  key={f.key || "all"}
                  size="sm"
                  variant={active ? "default" : "outline"}
                  onClick={() => setFrpFilter(f.key)}
                >
                  {f.label}
                  <span className="ml-1.5 tabular-nums opacity-70">{n}</span>
                </Button>
              )
            })}
          </div>

          {frpLoading ? (
            <LoadingBlock />
          ) : (
            <div className="space-y-4">
              {frpApps.length === 0 ? (
                <EmptyState
                  title={t("adm.254")}
                  description={t("adm.255")}
                />
              ) : filterFrpApps(frpApps, frpFilter).length === 0 ? (
                <EmptyState
                  title={`没有${FRP_FILTERS.find((f) => f.key === frpFilter)?.label ?? ""}的申请`}
                  description={t("adm.256")}
                />
              ) : (
                <div className="space-y-3">
                  {filterFrpApps(frpApps, frpFilter).map((a) => (
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
                                ? t("adm.150")
                                : a.status === "approved"
                                  ? t("adm.151")
                                  : t("adm.152")}
                            </Badge>
                          </p>
                          <p className="text-xs text-muted-foreground">
                            节点 {a.nodeName} · 端口 {a.ports.join(", ")}
                            {/* 免账号的节点没有密码可看，别展示成空白让人以为漏了 */}
                            {a.needAccount ? (
                              <>
                                {" "}
                                · 密码 <code className="font-mono">{a.frpPassword}</code>
                              </>
                            ) : (
                              " · 免账号（该节点只用服务端全局 token）"
                            )}
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
                              onClick={() => openReview(a, "approve")}
                              disabled={frpBusy}
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              {t("adm.353")}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => openReview(a, "reject")}
                              disabled={frpBusy}
                            >
                              <XCircle className="h-3.5 w-3.5" />
                              {t("adm.354")}
                            </Button>
                          </div>
                        )}
                        {a.status !== "pending" && (
                          <div className="flex items-center gap-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-muted-foreground hover:text-destructive"
                              onClick={() => void handleRevokeFrp(a)}
                              disabled={frpBusy}
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                              {t("adm.355")}
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
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
                        <TableHead>{t("adm.356")}</TableHead>
                        <TableHead>serverAddr</TableHead>
                        <TableHead>{t("adm.357")}</TableHead>
                        <TableHead>{t("adm.358")}</TableHead>
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
                                    authMode: n.authMode ?? "token",
                                  })
                                  setNodeOpen(true)
                                }}
                              >
                                {t("adm.359")}
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

          {/* frp 审核意见弹窗 */}
          <Dialog open={frpReviewTarget !== null} onOpenChange={(o) => !o && setFrpReviewTarget(null)}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  {frpReviewTarget?.action === "approve" ? "通过申请" : "拒绝申请"}
                </DialogTitle>
                <DialogDescription>
                  用户「{frpReviewTarget?.app.siteUsername}」在 {frpReviewTarget?.app.nodeName} 上的申请
                  {frpReviewTarget?.action === "approve" ? "，通过后会占用所选端口并邮件通知。" : "。"}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor="frpReviewNote">
                  {frpReviewTarget?.action === "approve" ? "审批意见（可选）" : "拒绝理由（可选，建议填写）"}
                </Label>
                <Textarea
                  id="frpReviewNote"
                  rows={3}
                  placeholder={
                    frpReviewTarget?.action === "reject"
                      ? t("adm.153")
                      : t("adm.154")
                  }
                  value={frpReviewNote}
                  onChange={(e) => setFrpReviewNote(e.target.value)}
                />
                {frpReviewTarget?.action === "approve" &&
                  (frpReviewTarget.app.needAccount ? (
                    <p className="text-xs text-muted-foreground">
                      {t("adm.360")}
                      <strong>密码</strong>（<code className="font-mono">{frpReviewTarget.app.frpPassword}</code>）
                      {t("adm.361")}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      这个节点只用服务端全局 <code className="font-mono">auth.token</code>，
                      <strong>不需要去 frps-panel 建号</strong>，直接批准即可。
                    </p>
                  ))}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setFrpReviewTarget(null)} disabled={frpBusy}>
                  {t("adm.362")}
                </Button>
                <Button
                  variant={frpReviewTarget?.action === "reject" ? "destructive" : "default"}
                  onClick={() => void confirmFrpReview()}
                  disabled={frpBusy}
                >
                  {frpBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  确认{frpReviewTarget?.action === "approve" ? "通过" : "拒绝"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </TabsContent>

        <TabsContent value="proxy">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {t("adm.363")}
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
              {t("adm.364")}
            </Button>
          </div>

          {proxyLoading ? (
            <LoadingBlock />
          ) : proxySubs.length === 0 ? (
            <EmptyState
              title={t("adm.257")}
              description={t("adm.258")}
            />
          ) : (
            <div className="rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("adm.365")}</TableHead>
                    <TableHead>{t("adm.366")}</TableHead>
                    <TableHead>{t("adm.367")}</TableHead>
                    <TableHead>{t("adm.368")}</TableHead>
                    <TableHead>{t("adm.369")}</TableHead>
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
                          <Badge variant="success">{t("adm.370")}</Badge>
                        ) : s.status === "offline" ? (
                          <Badge variant="destructive">{t("adm.371")}</Badge>
                        ) : s.status === "maintenance" ? (
                          <Badge variant="secondary">{t("adm.372")}</Badge>
                        ) : (
                          <Badge variant="outline">{t("adm.373")}</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {s.enabled ? (
                          <Badge variant="success">{t("adm.374")}</Badge>
                        ) : (
                          <Badge variant="secondary">{t("adm.375")}</Badge>
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
                                url: s.url ?? "",
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
                            {t("adm.376")}
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
            {t("adm.377")}
            {t("adm.378")}
          </p>

          {/* 顶部搜索：与用户列表同款，按用户名 / 邮箱 / 域名过滤 */}
          <div className="relative mb-3 max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t("adm.259")}
              className="pl-8"
              value={quotaFilter}
              onChange={(e) => setQuotaFilter(e.target.value)}
            />
          </div>

          {inviteQuotaLoading ? (
            <LoadingBlock />
          ) : (inviteQuotas?.users.length ?? 0) === 0 ? (
            <EmptyState title={t("adm.260")} description={t("adm.261")} />
          ) : quotaUsers.length === 0 ? (
            <EmptyState title={t("adm.262")} description={t("adm.263")} />
          ) : (
            <div className="rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16">UID</TableHead>
                    <TableHead>{t("adm.379")}</TableHead>
                    <TableHead>{t("adm.380")}</TableHead>
                    <TableHead>{t("adm.381")}</TableHead>
                    <TableHead>{t("adm.382")}</TableHead>
                    <TableHead className="w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {quotaUsers.map((u) => (
                    <TableRow key={u.id}>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {u.uid != null ? fmtUid(u.uid) : "—"}
                      </TableCell>
                      <TableCell>
                        <p className="font-mono text-sm">{u.username}</p>
                        <p className="text-xs text-muted-foreground">{u.email}</p>
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
                                  <Badge variant="outline">{t("adm.383")}</Badge>
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
                          {t("adm.384")}
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
            <h3 className="text-sm font-medium">{t("adm.385")}</h3>
            <span className="text-xs text-muted-foreground">
              {t("adm.386")}
            </span>
          </div>
          <div className="mb-4 space-y-3">
            <p className="text-sm text-muted-foreground">
              {t("adm.387")}
              {t("adm.388")}
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="rname" className="text-xs">{t("adm.389")}</Label>
                <Input
                  id="rname"
                  placeholder="brand"
                  className="w-40"
                  value={reservedName}
                  onChange={(e) => setReservedName(e.target.value.toLowerCase())}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="rnote" className="text-xs">{t("adm.390")}</Label>
                <Input
                  id="rnote"
                  placeholder={t("adm.264")}
                  className="w-48"
                  value={reservedNote}
                  onChange={(e) => setReservedNote(e.target.value)}
                />
              </div>
              <Button onClick={() => void handleAddReserved()} disabled={reservedBusy || !reservedName.trim()}>
                {reservedBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                <Plus className="h-4 w-4" />
                {t("adm.391")}
              </Button>
            </div>
          </div>

          {reservedLoading ? (
            <LoadingBlock />
          ) : reserved.length === 0 ? (
            <EmptyState title={t("adm.265")} description={t("adm.266")} />
          ) : (
            <div className="rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("adm.392")}</TableHead>
                    <TableHead>{t("adm.393")}</TableHead>
                    <TableHead>{t("adm.394")}</TableHead>
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
                          title={t("adm.267")}
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
            <h3 className="text-sm font-medium">{t("adm.395")}</h3>
            <span className="text-xs text-muted-foreground">
              {t("adm.396")}
            </span>
          </div>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {t("adm.397")}
              {t("adm.398")}
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="rnick" className="text-xs">{t("adm.399")}</Label>
                <Input
                  id="rnick"
                  placeholder={t("adm.268")}
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
                {t("adm.400")}
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
              <p className="text-xs text-muted-foreground">{t("adm.401")}</p>
            )}
          </div>
        </TabsContent>

        <TabsContent value="donations">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {t("adm.402")}
            </p>
            <Button variant="outline" size="sm" onClick={() => void loadDonations()}>
              <RefreshCw className="h-4 w-4" />
              {t("adm.403")}
            </Button>
          </div>

          {/* 类别筛选（上层）：全部 / AI / 内网穿透 / 代理 / 商汤 */}
          <div className="mb-2 flex flex-wrap gap-2">
            {DONATION_TYPE_FILTERS.map((f) => {
              const n =
                f.key === ""
                  ? donations.length
                  : donations.filter((d) => d.type === f.key).length
              const active = donationTypeFilter === f.key
              return (
                <Button
                  key={f.key || "all"}
                  size="sm"
                  variant={active ? "default" : "outline"}
                  onClick={() => setDonationTypeFilter(f.key)}
                >
                  {f.label}
                  <span className="ml-1.5 tabular-nums opacity-70">{n}</span>
                </Button>
              )
            })}
          </div>

          {/* 状态分类（下层）：数字是「当前类别下」各状态的条数 */}
          <div className="mb-4 flex flex-wrap gap-2">
            {DONATION_FILTERS.map((f) => {
              const n =
                f.key === ""
                  ? filterDonationsByTypeAndStatus(donations, donationTypeFilter, "").length
                  : filterDonationsByTypeAndStatus(donations, donationTypeFilter, f.key).length
              const active = donationFilter === f.key
              return (
                <Button
                  key={f.key || "all"}
                  size="sm"
                  variant={active ? "default" : "outline"}
                  onClick={() => setDonationFilter(f.key)}
                >
                  {f.label}
                  <span className="ml-1.5 tabular-nums opacity-70">{n}</span>
                </Button>
              )
            })}
          </div>

          {donationLoading ? (
            <LoadingBlock />
          ) : donations.length === 0 ? (
            <EmptyState
              title={t("adm.269")}
              description={t("adm.270")}
            />
          ) : filterDonationsByTypeAndStatus(donations, donationTypeFilter, donationFilter).length === 0 ? (
            <EmptyState
              title={t("adm.271")}
              description={t("adm.272")}
            />
          ) : (
            <div className="space-y-3">
              {filterDonationsByTypeAndStatus(donations, donationTypeFilter, donationFilter).map((d) => (
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
                            ? t("adm.155")
                            : d.status === "approved"
                              ? d.autoReviewed
                                ? t("adm.156")
                                : t("adm.157")
                              : d.status === "revoked"
                                ? t("adm.158")
                                : d.autoReviewed
                                  ? t("adm.159")
                                  : t("adm.160")}
                        </Badge>
                      </p>
                      <DonationDetail type={d.type} payload={d.payload} />
                      {(d.type === "ai" || d.type === "sensenova") && (
                        <p className="text-xs text-muted-foreground">
                          {d.status === "revoked"
                            ? t("adm.161")
                            : d.channelId !== null && d.channelId !== undefined
                              ? `中转站渠道 #${d.channelId} 已接入`
                              : t("adm.162")}
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
                          {t("adm.404")}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void handleReviewDonation(d, "reject")}
                          disabled={donationBusy}
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          {t("adm.405")}
                        </Button>
                      </div>
                    )}
                    {(d.status === "rejected" || d.status === "revoked") && (
                      <div className="flex shrink-0 items-center gap-2">
                        {/* AI 渠道可以「先用原始信息重试接入」；代理/内网穿透没有
                            {t("adm.406")}
                            {t("adm.407")}
                            这是管理员的人工兜底 —— 复核接入会重新校验并并入。 */}
                        {(d.type === "ai" || d.type === "sensenova") && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void handleProvisionDonation(d)}
                            disabled={donationBusy}
                          >
                            <PlugZap className="h-3.5 w-3.5" />
                            {t("adm.408")}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          onClick={() => void handleReviewDonation(d, "approve")}
                          disabled={donationBusy}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          {t("adm.409")}
                        </Button>
                      </div>
                    )}
                    {d.status === "approved" && (
                      <div className="flex shrink-0 items-center gap-2">
                        {/* 渠道已接入 → 才有「补全/重试」的对象。补全用于救
                            {t("adm.410")}
                            重试用于补回当时因限流/超时而没通过的模型。 */}
                        {d.type === "ai" && d.channelId != null && (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => void handleRefetchModels(d)}
                              disabled={donationBusy}
                            >
                              <PlugZap className="h-3.5 w-3.5" />
                              {t("adm.411")}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => void handleRetryModels(d)}
                              disabled={donationBusy}
                            >
                              <RefreshCw className="h-3.5 w-3.5" />
                              {t("adm.412")}
                            </Button>
                          </>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => void handleRevokeDonation(d)}
                          disabled={donationBusy}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          {t("adm.413")}
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
                <h3 className="text-sm font-medium">{t("adm.414")}</h3>
                <p className="text-xs text-muted-foreground">
                  {t("adm.415")}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => void loadWb2api()}>
                <RefreshCw className="h-4 w-4" />
                {t("adm.416")}
              </Button>
            </div>
            {wb2apiBindings.length === 0 ? (
              <EmptyState
                icon={Unplug}
                title={t("adm.273")}
                description={t("adm.274")}
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
                        {t("adm.417")}
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
                    ? t("adm.163")
                    : t("adm.164")}
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
                      ? t("adm.165")
                      : t("adm.166")
                  }
                  value={reviewNote}
                  onChange={(e) => setReviewNote(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t("adm.418")}
                </p>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setReviewTarget(null)} disabled={donationBusy}>
                  {t("adm.419")}
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

        <TabsContent value="feedback">
          <FeedbackPanel />
        </TabsContent>

        <TabsContent value="announcements">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {t("adm.420")}
            </p>
            <Button size="sm" onClick={() => openAnnouncementDialog()}>
              <Plus className="h-4 w-4" />
              {t("adm.421")}
            </Button>
          </div>
          {announcementLoading ? (
            <LoadingBlock />
          ) : announcements.length === 0 ? (
            <EmptyState
              icon={Megaphone}
              title={t("adm.275")}
              description={t("adm.276")}
            />
          ) : (
            <div className="space-y-3">
              {announcements.map((a) => (
                <Card key={a.id}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center gap-2">
                          {a.status === "draft" && <Badge variant="secondary">草稿</Badge>}
                          {a.status === "scheduled" && (
                            <Badge variant="default" className="gap-1">
                              <Clock className="h-3 w-3" />
                              定时 {a.publishAt ? new Date(a.publishAt).toLocaleString("zh-CN") : ""}
                            </Badge>
                          )}
                          {a.pinned && <Badge variant="success">置顶</Badge>}
                          <Badge variant="secondary">{a.category}</Badge>
                          {/* 邮件群发进度：推送中显示 x/y，完成后显示结果与失败数 */}
                          {a.mailStatus === "sending" && (
                            <Badge variant="default" className="tabular-nums">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              推送中 {a.mailSent}/{a.mailTotal}
                            </Badge>
                          )}
                          {a.mailStatus === "done" && (
                            <Badge
                              variant={a.mailFailed > 0 ? "destructive" : "outline"}
                              className="tabular-nums"
                            >
                              已推送 {a.mailSent}/{a.mailTotal}
                              {a.mailFailed > 0 ? ` · 失败 ${a.mailFailed}` : ""}
                            </Badge>
                          )}
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
                        {/* 只有「已推送完且有失败」才给重发入口：推送中重复点会撞车，
                            失败重发是唯一有意义的场景 */}
                        {a.mailStatus === "done" && a.mailFailed > 0 && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 gap-1 px-2 text-xs"
                            onClick={() => void handleResendAnnouncementMails(a)}
                          >
                            <RefreshCw className="h-3 w-3" />
                            重发失败 {a.mailFailed}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => openAnnouncementDialog(a)}
                          aria-label={t("adm.277")}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          onClick={() => void handleDeleteAnnouncement(a.id)}
                          aria-label={t("adm.278")}
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

        <TabsContent value="funLinks">
          <FunLinksAdminPanel />
        </TabsContent>

        <TabsContent value="titles">
          <TitlesAdminPanel />
        </TabsContent>

        <TabsContent value="dns">
          <DnsAdminPanel />
        </TabsContent>

        <TabsContent value="events">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {t("adm.422")}
            </p>
            <Button size="sm" onClick={() => openEventDialog()}>
              <Plus className="h-4 w-4" />
              {t("adm.423")}
            </Button>
          </div>
          {eventLoading ? (
            <LoadingBlock />
          ) : events.length === 0 ? (
            <EmptyState
              icon={PartyPopper}
              title={t("adm.279")}
              description={t("adm.280")}
            />
          ) : (
            <div className="space-y-3">
              {events.map((ev) => (
                <Card key={ev.id}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={EVENT_STATUS_BADGE[ev.status]}>
                            {EVENT_STATUS_TEXT[ev.status]}
                          </Badge>
                          {ev.rewardLabel && <Badge variant="secondary">{ev.rewardLabel}</Badge>}
                          {ev.lottery && (
                            <Badge variant={ev.lottery.drawn ? "secondary" : "default"}>
                              {ev.lottery.drawn ? "已开奖" : "待开奖"} · 抽 {ev.lottery.winners} 人 /
                              {ev.lottery.pool} 积分（
                              {ev.lottery.mode === "even" ? "平均分" : "随机分"}）
                            </Badge>
                          )}
                          <span className="text-xs text-muted-foreground">
                            {ev.claimCount ?? 0}
                            {ev.maxClaims != null ? `/${ev.maxClaims}` : ""} 人参与
                          </span>
                        </div>
                        <p className="text-sm font-medium">{ev.title}</p>
                        <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                          {ev.body}
                        </p>
                        <p className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          {ev.startsAt || ev.endsAt
                            ? `${ev.startsAt ? new Date(ev.startsAt).toLocaleString("zh-CN") : t("adm.167")} 至 ${ev.endsAt ? new Date(ev.endsAt).toLocaleString("zh-CN") : t("adm.168")}`
                            : t("adm.169")}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {ev.lottery && !ev.lottery.drawn && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7"
                            disabled={eventBusy}
                            onClick={() => void handleDrawEvent(ev)}
                          >
                            {t("adm.424")}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7"
                          onClick={() => void openClaimsDialog(ev)}
                        >
                          {t("adm.425")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => openEventDialog(ev)}
                          aria-label={t("adm.281")}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          onClick={() => void handleDeleteEvent(ev)}
                          aria-label={t("adm.282")}
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

        <TabsContent value="points">
          <PointsAdminPanel />
        </TabsContent>

        <TabsContent value="r2">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {t("adm.426")}
              {t("adm.427")}
            </p>
            <Button size="sm" onClick={() => openR2BucketDialog()}>
              <Plus className="h-4 w-4" />
              {t("adm.428")}
            </Button>
          </div>

          {r2Loading ? (
            <LoadingBlock />
          ) : !r2Data || (r2Data.buckets.length === 0 && !r2Data.legacyBucket) ? (
            <EmptyState
              icon={Database}
              title={t("adm.283")}
              description={t("adm.284")}
            />
          ) : (
            <div className="space-y-4">
              {/* 免费额度图例 */}
              <div className="flex flex-wrap items-center gap-4 rounded-lg border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{t("adm.429")}</span>
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
                                <Badge variant="secondary">{t("adm.430")}</Badge>
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
                                {t("adm.431")}
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => void handleTestR2Bucket(b.id, true)}
                              >
                                {t("adm.432")}
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => openR2BucketDialog(b)}
                                aria-label={t("adm.285")}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                onClick={() => void handleDeleteR2Bucket(b.id, b.name)}
                                aria-label={t("adm.286")}
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
                                {t("adm.433")}
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
                            <span className="text-muted-foreground">{t("adm.434")}</span>
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
                              <span className="text-muted-foreground">{t("adm.435")}</span>
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
                              <p className="text-xs text-muted-foreground">{t("adm.436")}</p>
                              <p className="text-sm font-semibold">{t("adm.437")}</p>
                            </div>
                            <div className="rounded-md border px-3 py-2">
                              <p className="text-xs text-muted-foreground">{t("adm.438")}</p>
                              <p className="text-sm font-semibold">{s.fileCount}</p>
                            </div>
                          </div>
                        ) : (
                          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                            <div className="rounded-md border px-3 py-2">
                              <p className="text-xs text-muted-foreground">{t("adm.439")}</p>
                              <p className="text-sm font-semibold">
                                {s.users} / {b.maxUsers || "—"}
                              </p>
                            </div>
                            <div className="rounded-md border px-3 py-2">
                              <p className="text-xs text-muted-foreground">{t("adm.440")}</p>
                              <p className="text-sm font-semibold">{s.fileCount}</p>
                            </div>
                            <div className="rounded-md border px-3 py-2">
                              <p className="text-xs text-muted-foreground">{t("adm.441")}</p>
                              <p className="text-sm font-semibold">
                                {formatBytes(b.quotaPerUser)}
                              </p>
                            </div>
                            <div className="rounded-md border px-3 py-2">
                              <p className="text-xs text-muted-foreground">{t("adm.442")}</p>
                              <p className="text-sm font-semibold">{userPct.toFixed(0)}%</p>
                            </div>
                          </div>
                        )}

                        {/* A/B 类操作数 */}
                        {b.id !== "" && (
                          <div className="space-y-2 rounded-md border p-3">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-medium">{t("adm.443")}</span>
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
                                    <span className="text-muted-foreground">{t("adm.444")}</span>
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
                                    <span className="text-muted-foreground">{t("adm.445")}</span>
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
                              {t("adm.446")}
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
                                        {t("adm.447")}
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
                                          {t("adm.448")}
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
                placeholder={t("adm.287")}
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
              {t("adm.449")}
            </label>
            <Button variant="outline" size="sm" onClick={() => void loadCommunity()}>
              <RefreshCw className="h-4 w-4" />
              {t("adm.450")}
            </Button>
          </div>

          {communityLoading ? (
            <LoadingBlock />
          ) : communityPosts.length === 0 ? (
            <EmptyState
              icon={MessagesSquare}
              title={t("adm.288")}
              description={t("adm.289")}
            />
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-32">{t("adm.451")}</TableHead>
                    <TableHead>{t("adm.452")}</TableHead>
                    <TableHead className="w-28">{t("adm.453")}</TableHead>
                    <TableHead className="w-28">{t("adm.454")}</TableHead>
                    <TableHead className="w-20">{t("adm.455")}</TableHead>
                    <TableHead className="w-24">{t("adm.456")}</TableHead>
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
                          <Badge variant="destructive">{t("adm.457")}</Badge>
                        ) : (
                          <Badge variant="secondary">{t("adm.458")}</Badge>
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
                            {t("adm.459")}
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleDeleteCommunityPost(p.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                            {t("adm.460")}
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
                <CardTitle className="text-base">{t("adm.461")}</CardTitle>
                <CardDescription>
                  {t("adm.462")}
                  {t("adm.463")}
                  {t("adm.464")}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {newapiCredLoading ? (
                  <LoadingBlock />
                ) : (
                  <>
                    <div className="space-y-1 rounded-md border p-3 text-sm">
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground">{t("adm.465")}</span>
                        {newapiCred?.source === "db" ? (
                          <Badge variant="secondary">{t("adm.466")}</Badge>
                        ) : newapiCred?.source === "env" ? (
                          <Badge variant="outline">{t("adm.467")}</Badge>
                        ) : (
                          <Badge variant="destructive">{t("adm.468")}</Badge>
                        )}
                        {newapiCred?.configured ? (
                          <Badge variant="secondary">{t("adm.469")}</Badge>
                        ) : (
                          <Badge variant="destructive">{t("adm.470")}</Badge>
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
                        <span className="text-muted-foreground">{t("adm.471")}</span>
                        {newapiCred?.health?.ok ? (
                          <span className="flex items-center gap-1 text-emerald-600">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            {t("adm.472")}
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
                        <Label htmlFor="newapiNewToken">{t("adm.473")}</Label>
                        <Input
                          id="newapiNewToken"
                          type="password"
                          autoComplete="off"
                          placeholder={t("adm.290")}
                          value={newapiNewToken}
                          onChange={(e) => setNewapiNewToken(e.target.value)}
                        />
                        <p className="text-xs text-muted-foreground">
                          {t("adm.474")}
                          {t("adm.475")}
                        </p>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="newapiAdminUserId">{t("adm.476")}</Label>
                        <Input
                          id="newapiAdminUserId"
                          inputMode="numeric"
                          value={newapiUserId}
                          onChange={(e) => setNewapiUserId(e.target.value)}
                        />
                        <p className="text-xs text-muted-foreground">
                          {t("adm.477")}
                        </p>
                      </div>
                    </div>

                    <div className="flex justify-end">
                      <Button
                        onClick={() => void handleUpdateNewApiToken()}
                        disabled={newapiCredBusy || !newapiNewToken.trim()}
                      >
                        {newapiCredBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                        {t("adm.478")}
                      </Button>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            {/* 开通策略：与原「设置」标签里的 AI 中转站卡片同一份状态 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("adm.479")}</CardTitle>
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
                    <Label htmlFor="newapiGroup">{t("adm.480")}</Label>
                    <Input
                      id="newapiGroup"
                      value={newapiGroup}
                      onChange={(e) => setNewapiGroup(e.target.value)}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="newapiVisibleGroups">{t("adm.481")}</Label>
                  <Input
                    id="newapiVisibleGroups"
                    value={newapiVisibleGroups}
                    onChange={(e) => setNewapiVisibleGroups(e.target.value)}
                    placeholder="default"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("adm.482")}
                    {t("adm.483")}
                    例如：<span className="font-mono">default</span> 或{" "}
                    <span className="font-mono">default,付费</span>。
                  </p>
                </div>
                <div className="flex items-center justify-between rounded-md border p-3">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">{t("adm.484")}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("adm.485")}
                    </p>
                  </div>
                  <Switch
                    checked={newapiUnlimited}
                    onCheckedChange={setNewapiUnlimited}
                  />
                </div>
                <div className="flex items-center justify-between rounded-md border p-3">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">{t("adm.486")}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("adm.487")}
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
                    {t("adm.488")}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* 推荐模型：用户在 AI 页看到的「第一梯队 / 第二梯队」就是这份 */}
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <CardTitle className="text-base">{t("adm.489")}</CardTitle>
                    <CardDescription>
                      {t("adm.490")}
                      {t("adm.491")}
                      {t("adm.492")}
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
                    {t("adm.493")}
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {recommendedTiers.length === 0 ? (
                  <p className="rounded-md border border-dashed py-6 text-center text-sm text-muted-foreground">
                    {t("adm.494")}
                  </p>
                ) : (
                  recommendedTiers.map((tier, i) => (
                    <div key={i} className="space-y-3 rounded-lg border p-3.5">
                      <div className="flex items-center gap-2">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground">
                          {i + 1}
                        </span>
                        <Input
                          value={tier.tier}
                          placeholder={t("adm.291")}
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
                          title={t("adm.292")}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>

                      <Input
                        value={tier.desc}
                        placeholder={t("adm.293")}
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
                          {tier.models.length === 0 ? (
                            <span className="text-xs text-muted-foreground">
                              {t("adm.495")}
                            </span>
                          ) : (
                            tier.models.map((m) => (
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
                                <SelectValue placeholder={t("adm.294")} />
                              </SelectTrigger>
                              <SelectContent>
                                {modelOptions
                                  .filter((m) => !tier.models.includes(m))
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
                            placeholder={t("adm.295")}
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
                    {t("adm.496")}
                    就近入口。 */}
                <div className="flex justify-end">
                  <Button
                    onClick={() => void handleSaveSettings()}
                    disabled={settingsBusy}
                  >
                    {settingsBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                    {t("adm.497")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="wb2api">
          <div className="space-y-6">
            {/* 三条免审核捐献通道都在这一页：① 反代账号（wb2api）② CLI2API ③ 商汤 Key。
                每条通道自带「通道开关」（管功能）与「显示入口」（只管捐献页给不给看）。 */}
            <p className="text-sm text-muted-foreground">
              这一页集中管理三条<b className="font-medium">免审核</b>捐献通道：
              {t("adm.498")}
              {t("adm.499")}
              {t("adm.500")}
            </p>

            {/* ① 反代账号（wb2api）：通道开关与限额，走全局设置接口 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("adm.501")}</CardTitle>
                <CardDescription>
                  {t("adm.502")}
                  {t("adm.503")}
                  {t("adm.504")}
                  {t("adm.505")}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between rounded-md border px-4 py-3">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">{t("adm.506")}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("adm.507")}
                    </p>
                  </div>
                  <Switch checked={wb2apiEnabled} onCheckedChange={setWb2apiEnabled} />
                </div>
                <div className="flex items-center justify-between rounded-md border px-4 py-3">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">{t("adm.508")}</p>
                    <p className="text-xs text-muted-foreground">
                      关掉后，<span className="font-medium">还没有绑定过</span>的用户看不到
                      {t("adm.509")}
                    </p>
                  </div>
                  <Switch
                    checked={wb2apiDonationVisible}
                    onCheckedChange={setWb2apiDonationVisible}
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="wb2apiLimit">{t("adm.510")}</Label>
                    <Input
                      id="wb2apiLimit"
                      type="number"
                      min={1}
                      value={wb2apiMaxBindings}
                      onChange={(e) => setWb2apiMaxBindings(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("adm.511")}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="wb2apiBaseUrl">{t("adm.512")}</Label>
                    <Input
                      id="wb2apiBaseUrl"
                      placeholder="https://wb2api.doulor.cn"
                      value={wb2apiBaseUrl}
                      onChange={(e) => setWb2apiBaseUrl(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("adm.513")}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label>{t("adm.514")}</Label>
                    <Select
                      value={wb2apiRealm}
                      onValueChange={(v) => setWb2apiRealm(v as "cn" | "global")}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="cn">{t("adm.515")}</SelectItem>
                        <SelectItem value="global">{t("adm.516")}</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      {t("adm.517")}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* 网关访问密钥：反代网关面板的 api_key 可能被随时改，允许在网页上验证并替换 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("adm.518")}</CardTitle>
                <CardDescription>
                  捐献页让用户登录自己的 WorkBuddy {realmLabel(wb2apiRealm)}账号来解锁 AI 权限，
                  {t("adm.519")}
                  {t("adm.520")}
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
                          ? t("adm.170")
                          : wb2apiConfig?.source === "env"
                            ? t("adm.171")
                            : t("adm.172")}
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
                      <span className="text-muted-foreground">{t("adm.521")}</span>
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
                      <Label htmlFor="wb2apiKey">{t("adm.522")}</Label>
                      <div className="flex gap-2">
                        <Input
                          id="wb2apiKey"
                          type="password"
                          placeholder={t("adm.296")}
                          value={wb2apiNewKey}
                          onChange={(e) => setWb2apiNewKey(e.target.value)}
                        />
                        <Button
                          onClick={() => void handleSaveWb2apiKey()}
                          disabled={wb2apiBusy || !wb2apiNewKey.trim()}
                        >
                          {wb2apiBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                          {t("adm.523")}
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
                <CardTitle className="text-base">{t("adm.524")}</CardTitle>
                <CardDescription>
                  {t("adm.525")}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {!wb2apiPool ? (
                  <p className="text-sm text-muted-foreground">
                    {t("adm.526")}
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
                  {t("adm.527")}
                  {t("adm.528")}
                  {t("adm.529")}
                  {t("adm.530")}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {wb2apiBindings.length === 0 ? (
                  <EmptyState
                    icon={Unplug}
                    title={t("adm.297")}
                    description={t("adm.298")}
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
                            {t("adm.531")}
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
            {/* ============ 第二条通道：CLI2API ============
                {t("adm.532")}
                同一个选项卡**里，所以这里不再是 <TabsContent>，只是同一页里的一段。
                别再拆成兄弟 tab（2026-10-01 合并，站长要求）。 */}
            {/* 通道开关 / 上限 / provider / region：走全局设置接口 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("adm.533")}</CardTitle>
                <CardDescription>
                  {t("adm.534")}
                  {t("adm.535")}
                  {t("adm.536")}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between rounded-md border px-4 py-3">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">{t("adm.537")}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("adm.538")}
                    </p>
                  </div>
                  <Switch checked={cli2apiEnabled} onCheckedChange={setCli2apiEnabled} />
                </div>
                <div className="flex items-center justify-between rounded-md border px-4 py-3">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">{t("adm.539")}</p>
                    <p className="text-xs text-muted-foreground">
                      关掉后，<span className="font-medium">还没有绑定过</span>的用户看不到
                      {t("adm.540")}
                    </p>
                  </div>
                  <Switch
                    checked={cli2apiDonationVisible}
                    onCheckedChange={setCli2apiDonationVisible}
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="cli2apiLimit">{t("adm.541")}</Label>
                    <Input
                      id="cli2apiLimit"
                      type="number"
                      min={1}
                      value={cli2apiMaxBindings}
                      onChange={(e) => setCli2apiMaxBindings(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="cli2apiBaseUrl">{t("adm.542")}</Label>
                    <Input
                      id="cli2apiBaseUrl"
                      placeholder="https://cli2api.doulor.cn"
                      value={cli2apiBaseUrl}
                      onChange={(e) => setCli2apiBaseUrl(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">{t("adm.543")}</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="cli2apiProvider">{t("adm.544")}</Label>
                    <Select
                      value={cli2apiProvider}
                      onValueChange={(v) => setCli2apiProvider(v)}
                    >
                      <SelectTrigger id="cli2apiProvider">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="qoder">Qoder</SelectItem>
                        <SelectItem value="workbuddy">WorkBuddy</SelectItem>
                        <SelectItem value="trae">Trae</SelectItem>
                        <SelectItem value="devin">Devin</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      {t("adm.545")}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="cli2apiRegion">{t("adm.546")}</Label>
                    <Select
                      value={cli2apiRegion}
                      onValueChange={(v) => setCli2apiRegion(v)}
                    >
                      <SelectTrigger id="cli2apiRegion">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="cn">{t("adm.547")}</SelectItem>
                        <SelectItem value="global">{t("adm.548")}</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      {t("adm.549")}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* console key：会先探测再加密入库 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("adm.550")}</CardTitle>
                <CardDescription>
                  <span className="text-destructive">{t("adm.551")}</span>
                  {t("adm.552")}
                  {t("adm.553")}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {cli2apiLoading ? (
                  <LoadingBlock />
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <Badge
                        variant={
                          cli2apiConfig?.source === "db"
                            ? "success"
                            : cli2apiConfig?.source === "env"
                              ? "secondary"
                              : "destructive"
                        }
                      >
                        {cli2apiConfig?.source === "db"
                          ? t("adm.173")
                          : cli2apiConfig?.source === "env"
                            ? t("adm.174")
                            : t("adm.175")}
                      </Badge>
                      <span className="font-mono text-xs text-muted-foreground">
                        {cli2apiConfig?.maskedKey ?? "（无）"}
                      </span>
                      {cli2apiConfig?.updatedAt && (
                        <span className="text-xs text-muted-foreground">
                          更新于 {fmtTime(cli2apiConfig.updatedAt)}
                        </span>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="cli2apiKey">{t("adm.554")}</Label>
                      <div className="flex gap-2">
                        <Input
                          id="cli2apiKey"
                          type="password"
                          placeholder={t("adm.299")}
                          value={cli2apiNewKey}
                          onChange={(e) => setCli2apiNewKey(e.target.value)}
                        />
                        <Button
                          onClick={() => void handleSaveCli2apiKey()}
                          disabled={cli2apiBusy || !cli2apiNewKey.trim()}
                        >
                          {cli2apiBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                          {t("adm.555")}
                        </Button>
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            {/* 账号池概览 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("adm.556")}</CardTitle>
                <CardDescription>
                  {t("adm.557")}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {!cli2apiPool ? (
                  <p className="text-sm text-muted-foreground">
                    {t("adm.558")}
                  </p>
                ) : !cli2apiPool.available ? (
                  <p className="text-sm text-destructive">{cli2apiPool.reason}</p>
                ) : cli2apiPool.accounts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("adm.559")}</p>
                ) : (
                  <div className="divide-y rounded-md border">
                    {cli2apiPool.accounts.map((a) => (
                      <div key={a.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
                        <span className="font-medium">{a.name}</span>
                        <Badge variant="outline">
                          {a.provider}/{a.region}
                        </Badge>
                        <Badge variant={a.enabled ? "success" : "secondary"}>
                          {a.enabled ? "启用" : "停用"}
                        </Badge>
                        {a.ready && <Badge variant="success">就绪</Badge>}
                        <span className="ml-auto font-mono text-xs text-muted-foreground">
                          {a.id}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* 绑定列表 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  捐献绑定（{cli2apiBindings.length}）
                </CardTitle>
                <CardDescription>
                  {t("adm.560")}
                  {t("adm.561")}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {cli2apiBindings.length === 0 ? (
                  <EmptyState
                    icon={Unplug}
                    title={t("adm.300")}
                    description={t("adm.301")}
                  />
                ) : (
                  <div className="divide-y rounded-md border">
                    {cli2apiBindings.map((b) => (
                      <div key={b.id} className="flex flex-wrap items-center gap-2 px-4 py-3">
                        <span className="text-sm font-medium">{b.username}</span>
                        <span className="text-sm">{b.nickname || b.accountId}</span>
                        <Badge variant="outline">
                          {b.provider}/{b.region}
                        </Badge>
                        <Badge variant={b.status === "active" ? "success" : "secondary"}>
                          {b.status === "active" ? "使用中" : "已移除"}
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
                              setCli2apiRevokeAi(false)
                              setCli2apiRemoving(b)
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                            {t("adm.562")}
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* ============ 第三条通道：商汤 Key ============
                {t("adm.563")}
                （上游地址与「并入哪个渠道」都做成可配置）。 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("adm.564")}</CardTitle>
                <CardDescription>
                  {t("adm.565")}
                  {t("adm.566")}
                  {t("adm.567")}
                  {t("adm.568")}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between rounded-md border px-4 py-3">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">{t("adm.569")}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("adm.570")}
                    </p>
                  </div>
                  <Switch
                    checked={sensenovaEnabled}
                    onCheckedChange={setSensenovaEnabled}
                  />
                </div>
                <div className="flex items-center justify-between rounded-md border px-4 py-3">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">{t("adm.571")}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("adm.572")}
                      {t("adm.573")}
                    </p>
                  </div>
                  <Switch
                    checked={sensenovaDonationVisible}
                    onCheckedChange={setSensenovaDonationVisible}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sensenovaBaseUrl">{t("adm.574")}</Label>
                  <Input
                    id="sensenovaBaseUrl"
                    placeholder="https://token.sensenova.cn"
                    value={sensenovaBaseUrl}
                    onChange={(e) => setSensenovaBaseUrl(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("adm.575")}
                    {t("adm.576")}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sensenovaChannelId">{t("adm.577")}</Label>
                  <Input
                    id="sensenovaChannelId"
                    inputMode="numeric"
                    placeholder={t("adm.302")}
                    value={sensenovaChannelId}
                    onChange={(e) => setSensenovaChannelId(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("adm.578")}
                    {t("adm.579")}
                    {t("adm.580")}
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* 三条通道的「开关 / 地址 / 上限」都走同一个 PUT /admin/settings，
                所以整页只留一个保存按钮 —— 免得出现三个「保存」而不知道到底存了什么。 */}
            <Card>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
                <p className="text-xs text-muted-foreground">
                  {t("adm.581")}
                </p>
                <Button onClick={() => void handleSaveSettings()} disabled={settingsBusy}>
                  {settingsBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t("adm.582")}
                </Button>
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

        <TabsContent value="cfQuota">
          <CfQuotaPanel />
        </TabsContent>

        <TabsContent value="audit">
          <AuditPanel />
        </TabsContent>

        <TabsContent value="settings">
          {settingsLoading ? (
            <LoadingBlock />
          ) : (
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t("adm.583")}</CardTitle>
                  <CardDescription>
                    {t("adm.584")}
                    {t("adm.585")}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="subQuota">{t("adm.586")}</Label>
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
                      {t("adm.587")}
                    </p>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t("adm.588")}</CardTitle>
                  <CardDescription>
                    {t("adm.589")}
                    {t("adm.590")}
                    当前 {settingsStats?.storageAccounts ?? 0} 个网盘，
                    占用 {formatBytes(settingsStats?.storageUsedBytes ?? 0)}。
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="storageQuota">{t("adm.591")}</Label>
                      <Input
                        id="storageQuota"
                        type="number"
                        min={1}
                        value={quotaMb}
                        onChange={(e) => setQuotaMb(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="maxFile">{t("adm.592")}</Label>
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
                      <p className="text-sm font-medium">{t("adm.593")}</p>
                      <p className="text-xs text-muted-foreground">
                        {t("adm.594")}
                      </p>
                    </div>
                    <Switch
                      checked={storageEnabled}
                      onCheckedChange={setStorageEnabled}
                    />
                  </div>

                  {/* 每桶人数上限：用户开通网盘时按「占用比例最低」分配，桶满即不再分配 */}
                  <div className="space-y-3 rounded-md border p-3">
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium">{t("adm.595")}</p>
                      <p className="text-xs text-muted-foreground">
                        {t("adm.596")}
                        {t("adm.597")}
                      </p>
                    </div>
                    {r2Loading && !r2Data ? (
                      <p className="text-xs text-muted-foreground">{t("adm.598")}</p>
                    ) : (r2Data?.buckets.filter((b) => b.kind !== "platform") ?? []).length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        {t("adm.599")}
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {(r2Data?.buckets ?? [])
                          .filter((b) => b.kind !== "platform")
                          .map((b) => {
                            const value = bucketMaxDraft[b.id] ?? String(b.maxUsers)
                            const dirty = value !== String(b.maxUsers)
                            const full = b.maxUsers > 0 && b.stats.users >= b.maxUsers
                            return (
                              <div
                                key={b.id}
                                className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/30 px-3 py-2"
                              >
                                <div className="min-w-0 flex-1">
                                  <p className="flex items-center gap-2 truncate text-sm font-medium">
                                    {b.name}
                                    {full && <Badge variant="secondary">已满</Badge>}
                                    {!b.enabled && <Badge variant="secondary">已停用</Badge>}
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    已分配 {b.stats.users} 人 · 每人 {formatBytes(b.quotaPerUser)}
                                  </p>
                                </div>
                                <Input
                                  type="number"
                                  min={1}
                                  className="w-24"
                                  aria-label={`${b.name} 人数上限`}
                                  value={value}
                                  onChange={(e) =>
                                    setBucketMaxDraft((d) => ({ ...d, [b.id]: e.target.value }))
                                  }
                                />
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={!dirty || bucketMaxBusy === b.id}
                                  onClick={() => void handleSaveBucketMaxUsers(b.id)}
                                >
                                  {bucketMaxBusy === b.id && (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  )}
                                  {t("adm.600")}
                                </Button>
                              </div>
                            )
                          })}
                      </div>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleSyncStorageQuota()}
                      disabled={syncQuotaBusy}
                    >
                      {syncQuotaBusy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                      )}
                      {t("adm.601")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleRecalculate()}
                      disabled={settingsBusy}
                    >
                      {settingsBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      <RefreshCw className="h-3.5 w-3.5" />
                      {t("adm.602")}
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      {t("adm.603")}
                      {t("adm.604")}
                    </span>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t("adm.605")}</CardTitle>
                  <CardDescription>
                    {t("adm.606")}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="frpCoreUrl">{t("adm.607")}</Label>
                    <Input
                      id="frpCoreUrl"
                      value={frpCoreUrl}
                      onChange={(e) => setFrpCoreUrl(e.target.value)}
                      className="font-mono text-xs"
                    />
                  </div>
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium">{t("adm.608")}</p>
                      <p className="text-xs text-muted-foreground">
                        {t("adm.609")}
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
                  <CardTitle className="text-base">{t("adm.610")}</CardTitle>
                  <CardDescription>
                    {t("adm.611")}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div className="space-y-2">
                      <Label htmlFor="tempboxMinutes">{t("adm.612")}</Label>
                      <Input
                        id="tempboxMinutes"
                        type="number"
                        min={1}
                        value={tempboxMinutes}
                        onChange={(e) => setTempboxMinutes(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="tempboxMaxFile">{t("adm.613")}</Label>
                      <Input
                        id="tempboxMaxFile"
                        type="number"
                        min={1}
                        value={tempboxMaxFileMb}
                        onChange={(e) => setTempboxMaxFileMb(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="tempboxMaxFiles">{t("adm.614")}</Label>
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
                      <p className="text-sm font-medium">{t("adm.615")}</p>
                      <p className="text-xs text-muted-foreground">
                        {t("adm.616")}
                      </p>
                    </div>
                    <Switch
                      checked={tempboxUploadLogin}
                      onCheckedChange={setTempboxUploadLogin}
                    />
                  </div>
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium">{t("adm.617")}</p>
                      <p className="text-xs text-muted-foreground">
                        {t("adm.618")}
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
                  <CardTitle className="text-base">{t("adm.619")}</CardTitle>
                  <CardDescription>
                    {t("adm.620")}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="communityPostMaxImages">{t("adm.621")}</Label>
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
                      <Label htmlFor="communityImageMaxKb">{t("adm.622")}</Label>
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
                      <p className="text-sm font-medium">{t("adm.623")}</p>
                      <p className="text-xs text-muted-foreground">
                        {t("adm.624")}
                      </p>
                    </div>
                    <Switch
                      checked={communityGuestAccess}
                      onCheckedChange={setCommunityGuestAccess}
                    />
                  </div>
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium">{t("adm.625")}</p>
                      <p className="text-xs text-muted-foreground">
                        {t("adm.626")}
                      </p>
                    </div>
                    <Switch
                      checked={communityEnabled}
                      onCheckedChange={setCommunityEnabled}
                    />
                  </div>
                  {/*
                    {t("adm.627")}
                    {t("adm.628")}
                    {t("adm.629")}
                  */}
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium">{t("adm.630")}</p>
                      <p className="text-xs text-muted-foreground">
                        {t("adm.631")}
                        {t("adm.632")}
                      </p>
                    </div>
                    <Switch checked={chatEnabled} onCheckedChange={setChatEnabled} />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t("adm.633")}</CardTitle>
                  <CardDescription>
                    {t("adm.634")}
                    {t("adm.635")}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium">{t("adm.636")}</p>
                      <p className="text-xs text-muted-foreground">
                        {openRegistration
                          ? t("adm.176")
                          : t("adm.177")}
                      </p>
                    </div>
                    <Switch
                      checked={openRegistration}
                      onCheckedChange={setOpenRegistration}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="openRegUntil">截止时间（留空 = 不自动关闭）</Label>
                    <Input
                      id="openRegUntil"
                      type="datetime-local"
                      value={openRegistrationUntil}
                      onChange={(e) => setOpenRegistrationUntil(e.target.value)}
                      disabled={!openRegistration}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("adm.637")}
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("adm.638")}
                    {t("adm.639")}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t("adm.640")}</CardTitle>
                  <CardDescription>
                    {t("adm.641")}
                    {t("adm.642")}
                    {t("adm.643")}
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
                            ? t("adm.178")
                            : t("adm.179")}
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
                    {t("adm.644")}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t("adm.645")}</CardTitle>
                  <CardDescription>
                    {t("adm.646")}
                    {t("adm.647")}
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
                            ? t("adm.180")
                            : t("adm.181")}
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
                    {t("adm.648")}
                    {t("adm.649")}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t("adm.650")}</CardTitle>
                  <CardDescription>
                    {t("adm.651")}
                    {t("adm.652")}
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
                            ? t("adm.182")
                            : f === "proxy"
                              ? t("adm.183")
                              : t("adm.184")}
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
                    {t("adm.653")}
                    {t("adm.654")}
                    {t("adm.655")}
                    {t("adm.656")}
                    {t("adm.657")}
                  </p>
                </CardContent>
              </Card>

              {/* ⚠️ 商汤 Key 捐献的配置卡片已挪到「捐献通道」选项卡（三条通道合并），
                  {t("adm.658")}
                  改哪边会互相覆盖。 */}

              {/* ---- 2026-09-26 补齐的设置卡片 ---- */}
              <Card>
                <CardHeader>
                  <CardTitle>{t("adm.659")}</CardTitle>
                  <CardDescription>
                    {t("adm.660")}
                    {t("adm.661")}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium">{t("adm.662")}</p>
                      <p className="text-xs text-muted-foreground">
                        {t("adm.663")}
                      </p>
                    </div>
                    <Switch
                      checked={inviteRewardEnabled}
                      onCheckedChange={setInviteRewardEnabled}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="inviteRewardPlanId">{t("adm.664")}</Label>
                    <Input
                      id="inviteRewardPlanId"
                      inputMode="numeric"
                      value={inviteRewardPlanId}
                      onChange={(e) => setInviteRewardPlanId(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      被邀请人绑定 WorkBuddy 反代账号后，给邀请人开的套餐（默认 2 = ¥500/天）
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="inviteRewardAiPlanId">{t("adm.665")}</Label>
                    <Input
                      id="inviteRewardAiPlanId"
                      inputMode="numeric"
                      value={inviteRewardAiPlanId}
                      onChange={(e) => setInviteRewardAiPlanId(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      被邀请人捐献的 AI 渠道审核通过后，给邀请人开的套餐（默认 3 = ¥200/天）
                    </p>
                  </div>
                  <div className="space-y-2 rounded-md border p-3">
                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <p className="text-sm font-medium">{t("adm.666")}</p>
                        <p className="text-xs text-muted-foreground">
                          {t("adm.667")}
                        </p>
                      </div>
                      <Switch
                        checked={achievementRewardEnabled}
                        onCheckedChange={setAchievementRewardEnabled}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3 pt-1">
                      <div className="space-y-2">
                        <Label htmlFor="achievementRewardPlanId">{t("adm.668")}</Label>
                        <Input
                          id="achievementRewardPlanId"
                          inputMode="numeric"
                          value={achievementRewardPlanId}
                          onChange={(e) => setAchievementRewardPlanId(e.target.value)}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="achievementRewardPoints">{t("adm.669")}</Label>
                        <Input
                          id="achievementRewardPoints"
                          inputMode="numeric"
                          value={achievementRewardPoints}
                          onChange={(e) => setAchievementRewardPoints(e.target.value)}
                        />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t("adm.670")}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="inviteQuotaBase">{t("adm.671")}</Label>
                    <Input
                      id="inviteQuotaBase"
                      inputMode="numeric"
                      value={inviteQuotaBase}
                      onChange={(e) => setInviteQuotaBase(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("adm.672")}
                    </p>
                  </div>
                </CardContent>
              </Card>

              {/* 积分系统的配置（开关 / 比例 / 每日上限）已挪到 管理面板 → 积分 → 商城，
                  因为「兑换」现在就是商城里的一件商品（2026-09-28 站长要求）。 */}

              <Card>
                <CardHeader>
                  <CardTitle>{t("adm.673")}</CardTitle>
                  <CardDescription>{t("adm.674")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="newapiFreePlanId">{t("adm.675")}</Label>
                    <Input
                      id="newapiFreePlanId"
                      inputMode="numeric"
                      value={newapiFreePlanId}
                      onChange={(e) => setNewapiFreePlanId(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      用户点「领取免费订阅」时开的套餐（默认 1）。填 0 = 关闭自动开订阅。
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="quotaPerUnitInput">额度换算率（1 单位金额 = 多少 quota）</Label>
                    <Input
                      id="quotaPerUnitInput"
                      inputMode="numeric"
                      value={quotaPerUnitInput}
                      onChange={(e) => setQuotaPerUnitInput(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("adm.676")}
                      <strong>改动会让所有已配置额度的显示基准一起变化</strong>，一般不需要改。
                    </p>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>{t("adm.677")}</CardTitle>
                  <CardDescription>{t("adm.678")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium">{t("adm.679")}</p>
                      <p className="text-xs text-muted-foreground">
                        {t("adm.680")}
                      </p>
                    </div>
                    <Switch checked={proxyEnabled} onCheckedChange={setProxyEnabled} />
                  </div>
                </CardContent>
              </Card>

              <div className="flex justify-end">
                <Button onClick={() => void handleSaveSettings()} disabled={settingsBusy}>
                  {settingsBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t("adm.681")}
                </Button>
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="mail">
          <div className="space-y-6">
            {/* 管理员通知邮箱 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("adm.682")}</CardTitle>
                <CardDescription>
                  {t("adm.683")}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="frpNotify">{t("adm.684")}</Label>
                  <Select
                    value={frpNotifyEmail || "__none__"}
                    onValueChange={(v) =>
                      setFrpNotifyEmail(v === "__none__" ? "" : v)
                    }
                  >
                    <SelectTrigger id="frpNotify">
                      <SelectValue placeholder={t("adm.303")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">{t("adm.685")}</SelectItem>
                      {notifyEmailOptions.map((e) => (
                        <SelectItem key={e} value={e}>
                          {e}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {t("adm.686")}
                    {t("adm.687")}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="feedbackNotify">{t("adm.688")}</Label>
                  <Textarea
                    id="feedbackNotify"
                    rows={3}
                    placeholder={"留空则不通知\n一行一个邮箱"}
                    value={feedbackNotifyEmail}
                    onChange={(e) => setFeedbackNotifyEmail(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("adm.689")}
                    {notifyEmailOptions.length > 0 && (
                      <> 本站在册邮箱：{notifyEmailOptions.join("、")}</>
                    )}
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* 邮件发送通道 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("adm.690")}</CardTitle>
                <CardDescription>
                  {t("adm.691")}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="mailOrder">{t("adm.692")}</Label>
                  <Input
                    id="mailOrder"
                    value={mailTransportOrder}
                    onChange={(e) => setMailTransportOrder(e.target.value)}
                    className="font-mono text-xs"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("adm.693")}
                    {t("adm.694")}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label>{t("adm.695")}</Label>
                  <Select
                    value={announcementMailTransport}
                    onValueChange={setAnnouncementMailTransport}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="posta">{t("adm.696")}</SelectItem>
                      <SelectItem value="brevo">{t("adm.697")}</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {t("adm.698")}
                    {t("adm.699")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    ⚠️ 群发量 = 全部活跃用户数，一次可能吃掉第三方免费额度的一大截
                    {t("adm.700")}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mailCfTargets">{t("adm.701")}</Label>
                  <Textarea
                    id="mailCfTargets"
                    rows={3}
                    value={mailCfTargets}
                    onChange={(e) => setMailCfTargets(e.target.value)}
                    placeholder={"admin@foxmail.com\nanother@qq.com"}
                    className="font-mono text-xs"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("adm.702")}
                    {t("adm.703")}
                  </p>
                </div>

                <Separator />

                <div className="space-y-3 rounded-md border p-3">
                  <p className="text-sm font-medium">{t("adm.704")}</p>
                  <div className="space-y-2">
                    <Label htmlFor="postaUrl">{t("adm.705")}</Label>
                    <Input
                      id="postaUrl"
                      value={postaUrl}
                      onChange={(e) => setPostaUrl(e.target.value)}
                      placeholder="https://xxx.doulor.cn"
                      className="font-mono text-xs"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="postaKey">
                      API Key{postaConfigured && "（已配置）"}
                    </Label>
                    <Input
                      id="postaKey"
                      type="password"
                      value={postaKey}
                      onChange={(e) => setPostaKey(e.target.value)}
                      placeholder={postaConfigured ? "已配置，留空则保持不变" : "未配置"}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="postaFrom">{t("adm.706")}</Label>
                    <Input
                      id="postaFrom"
                      value={postaFrom}
                      onChange={(e) => setPostaFrom(e.target.value)}
                      placeholder="Doulor Cloud <DoulorCloud@foxmail.com>"
                      className="font-mono text-xs"
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("adm.707")}
                      {t("adm.708")}
                      {t("adm.709")}
                    </p>
                  </div>
                </div>

                <div className="space-y-3 rounded-md border p-3">
                  <p className="text-sm font-medium">{t("adm.710")}</p>
                  <div className="space-y-2">
                    <Label>
                      API Key
                      {brevoKeys.length > 0 && `（已配置 ${brevoKeys.length} 把）`}
                    </Label>

                    {/* 已配置的 Key 列表：只显示中间打码的串，明文永不回前端 */}
                    {brevoKeys.length > 0 ? (
                      <ul className="space-y-1">
                        {brevoKeys.map((k, i) => (
                          <li
                            key={`${i}-${k}`}
                            className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5"
                          >
                            <span className="flex items-center gap-2 overflow-hidden">
                              <span className="shrink-0 text-[11px] text-muted-foreground">
                                第 {i + 1} 把
                              </span>
                              <span className="truncate font-mono text-xs">{k}</span>
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 shrink-0 px-2 text-xs text-destructive hover:text-destructive"
                              disabled={brevoBusy}
                              onClick={() => void handleRemoveBrevoKey(i + 1)}
                            >
                              {t("adm.711")}
                            </Button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="rounded-md border border-dashed px-2.5 py-1.5 text-xs text-muted-foreground">
                        {t("adm.712")}
                      </p>
                    )}

                    {/* 添加：支持一次粘多把（逗号 / 换行分隔） */}
                    <div className="flex gap-2">
                      <Input
                        id="brevoKeyAdd"
                        type="password"
                        value={brevoAddInput}
                        onChange={(e) => setBrevoAddInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault()
                            void handleAddBrevoKey()
                          }
                        }}
                        placeholder={t("adm.304")}
                        className="font-mono text-xs"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        disabled={brevoBusy || !brevoAddInput.trim()}
                        onClick={() => void handleAddBrevoKey()}
                      >
                        {t("adm.713")}
                      </Button>
                    </div>

                    <p className="text-xs text-muted-foreground">
                      {t("adm.714")}
                      {t("adm.715")}
                      <span className="font-medium">
                        {t("adm.716")}
                      </span>
                    </p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="brevoSenderEmail">{t("adm.717")}</Label>
                      <Input
                        id="brevoSenderEmail"
                        value={brevoSenderEmail}
                        onChange={(e) => setBrevoSenderEmail(e.target.value)}
                        placeholder="no-reply@doulor.cn"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="brevoSenderName">{t("adm.718")}</Label>
                      <Input
                        id="brevoSenderName"
                        value={brevoSenderName}
                        onChange={(e) => setBrevoSenderName(e.target.value)}
                      />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("adm.719")}
                  </p>
                  <BrevoQuotaPanel />
                </div>
              </CardContent>
            </Card>

            <div className="flex justify-end">
              <Button onClick={() => void handleSaveSettings()} disabled={settingsBusy}>
                {settingsBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                {t("adm.720")}
              </Button>
            </div>
          </div>
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
            <DialogTitle>{t("adm.721")}</DialogTitle>
            <DialogDescription>
              将从网关账号池移除 {wb2apiRemoving?.nickname || wb2apiRemoving?.uid}
              （捐献者 {wb2apiRemoving?.username}）。
              {t("adm.722")}
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
                {t("adm.723")}
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {t("adm.724")}
                  {t("adm.725")}
                </span>
              </span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWb2apiRemoving(null)}>
              {t("adm.726")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleRemoveWb2apiBinding()}
              disabled={wb2apiBusy}
            >
              {wb2apiBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("adm.727")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 摘除 CLI2API 绑定 */}
      <Dialog
        open={cli2apiRemoving !== null}
        onOpenChange={(o) => {
          if (!o) setCli2apiRemoving(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("adm.728")}</DialogTitle>
            <DialogDescription>
              将从 cli2api 删除账号 {cli2apiRemoving?.accountId}
              （捐献者 {cli2apiRemoving?.username}）。
              {t("adm.729")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="flex cursor-pointer items-start gap-3 rounded-md border px-4 py-3">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                checked={cli2apiRevokeAi}
                onChange={(e) => setCli2apiRevokeAi(e.target.checked)}
              />
              <span className="text-sm">
                {t("adm.730")}
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {t("adm.731")}
                  {t("adm.732")}
                </span>
              </span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCli2apiRemoving(null)}>
              {t("adm.733")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleRemoveCli2apiBinding()}
              disabled={cli2apiBusy}
            >
              {cli2apiBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("adm.734")}
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
            <DialogTitle>{t("adm.735")}</DialogTitle>
            <DialogDescription>
              {permInvite?.code} · 只影响之后用该码注册的新账号；
              {t("adm.736")}
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
              {t("adm.737")}
            </Button>
            <Button onClick={() => void handleSaveInvitePerms()} disabled={permBusy}>
              {permBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("adm.738")}
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
                  {t("adm.739")}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div className="rounded-md border p-3">
                  <p className="text-sm font-medium">{t("adm.740")}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    剩余 {quotaDetail.quota.inviteRemaining} / 共{" "}
                    {quotaDetail.quota.inviteTotal}（基础{" "}
                    {quotaDetail.quota.inviteBase} + 捐献{" "}
                    {quotaDetail.quota.inviteBonus}），已用{" "}
                    {quotaDetail.quota.inviteUsed}
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <Label className="text-xs">{t("adm.741")}</Label>
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
                  <p className="text-sm font-medium">{t("adm.742")}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("adm.743")}
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
                              {t("adm.744")}
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
                      {t("adm.745")}
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
                            <Badge variant="outline">{t("adm.746")}</Badge>
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
                              title={t("adm.305")}
                              onClick={async () => {
                                try {
                                  await adminApi.deleteInvite(inv.id)
                                  toast.success(t("adm.185"))
                                  void openQuotaDetail(quotaDetail.username)
                                  void loadInviteQuotas()
                                } catch (err) {
                                  toast.error(
                                    err instanceof HttpError
                                      ? err.message
                                      : t("adm.186")
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
            <DialogTitle>{t("adm.747")}</DialogTitle>
            <DialogDescription>
              {t("adm.748")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="inviteCode">{t("adm.749")}</Label>
              <Input
                id="inviteCode"
                placeholder="FRIENDS-02"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="inviteMax">{t("adm.750")}</Label>
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
              <Label>{t("adm.751")}</Label>
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
                {t("adm.752")}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInviteOpen(false)}>
              {t("adm.753")}
            </Button>
            <Button onClick={() => void handleCreateInvite()} disabled={inviteBusy}>
              {inviteBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("adm.754")}
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
              {t("adm.755")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="annTitle">{t("adm.756")}</Label>
              <Input
                id="annTitle"
                placeholder={t("adm.306")}
                value={annDraft.title}
                onChange={(e) => setAnnDraft((d) => ({ ...d, title: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="annBody">{t("adm.757")}</Label>
              <Textarea
                id="annBody"
                placeholder={t("adm.307")}
                rows={4}
                value={annDraft.body}
                onChange={(e) => setAnnDraft((d) => ({ ...d, body: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>{t("adm.758")}</Label>
                <Select
                  value={annDraft.category}
                  onValueChange={(v) => setAnnDraft((d) => ({ ...d, category: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="general">{t("adm.759")}</SelectItem>
                    <SelectItem value="frp">{t("adm.760")}</SelectItem>
                    <SelectItem value="ai">{t("adm.761")}</SelectItem>
                    <SelectItem value="proxy">{t("adm.762")}</SelectItem>
                    <SelectItem value="storage">{t("adm.763")}</SelectItem>
                    <SelectItem value="profile">{t("adm.764")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end">
                <div className="flex w-full items-center justify-between rounded-md border p-3">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">{t("adm.765")}</p>
                    <p className="text-xs text-muted-foreground">{t("adm.766")}</p>
                  </div>
                  <Switch
                    checked={annDraft.pinned}
                    onCheckedChange={(v) => setAnnDraft((d) => ({ ...d, pinned: v }))}
                  />
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label>{t("adm.767")}</Label>
              <Select
                value={annDraft.status}
                onValueChange={(v) => setAnnDraft((d) => ({ ...d, status: v as AnnouncementStatus }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="published">{t("adm.768")}</SelectItem>
                  <SelectItem value="scheduled">{t("adm.769")}</SelectItem>
                  <SelectItem value="draft">{t("adm.770")}</SelectItem>
                </SelectContent>
              </Select>
              {annDraft.status === "scheduled" && (
                <div className="space-y-2 pt-1">
                  <Label htmlFor="annPublishAt">{t("adm.771")}</Label>
                  <Input
                    id="annPublishAt"
                    type="datetime-local"
                    value={annDraft.publishAt}
                    onChange={(e) => setAnnDraft((d) => ({ ...d, publishAt: e.target.value }))}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("adm.772")}
                  </p>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label>{t("adm.773")}</Label>
              <Select
                value={annDraft.popupMode}
                onValueChange={(v) => setAnnDraft((d) => ({ ...d, popupMode: v as "none" | "once" | "every" }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("adm.774")}</SelectItem>
                  <SelectItem value="once">{t("adm.775")}</SelectItem>
                  <SelectItem value="every">{t("adm.776")}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t("adm.777")}
              </p>
            </div>

            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">{t("adm.778")}</p>
                <p className="text-xs text-muted-foreground">
                  {t("adm.779")}
                </p>
              </div>
              <Switch
                checked={annDraft.notifyByEmail}
                onCheckedChange={(v) => setAnnDraft((d) => ({ ...d, notifyByEmail: v }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAnnouncementOpen(false)}>
              {t("adm.780")}
            </Button>
            <Button onClick={() => void handleSaveAnnouncement()} disabled={announcementBusy}>
              {announcementBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              {annDraft.status === "draft"
                ? t("adm.187")
                : annDraft.status === "scheduled"
                  ? t("adm.188")
                  : annDraft.id
                    ? t("adm.189")
                    : t("adm.190")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 活动编辑弹窗 */}
      <Dialog open={eventOpen} onOpenChange={setEventOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{eventDraft.id ? "编辑活动" : "发布活动"}</DialogTitle>
            <DialogDescription>
              {t("adm.781")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="evTitle">{t("adm.782")}</Label>
              <Input
                id="evTitle"
                placeholder={t("adm.308")}
                value={eventDraft.title}
                onChange={(e) => setEventDraft((d) => ({ ...d, title: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="evBody">{t("adm.783")}</Label>
              <Textarea
                id="evBody"
                rows={6}
                placeholder={t("adm.309")}
                value={eventDraft.body}
                onChange={(e) => setEventDraft((d) => ({ ...d, body: e.target.value }))}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>{t("adm.784")}</Label>
                <Select
                  value={eventDraft.status}
                  onValueChange={(v) => setEventDraft((d) => ({ ...d, status: v as EventStatus }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EVENT_STATUS_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="evRewardLabel">{t("adm.785")}</Label>
                <Input
                  id="evRewardLabel"
                  placeholder={t("adm.310")}
                  value={eventDraft.rewardLabel}
                  onChange={(e) => setEventDraft((d) => ({ ...d, rewardLabel: e.target.value }))}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="evStart">开始时间（留空 = 立即）</Label>
                <Input
                  id="evStart"
                  type="datetime-local"
                  value={eventDraft.startsAt}
                  onChange={(e) => setEventDraft((d) => ({ ...d, startsAt: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="evEnd">结束时间（留空 = 不过期）</Label>
                <Input
                  id="evEnd"
                  type="datetime-local"
                  value={eventDraft.endsAt}
                  onChange={(e) => setEventDraft((d) => ({ ...d, endsAt: e.target.value }))}
                />
              </div>
            </div>

            {eventDraft.status === "scheduled" && (
              <div className="space-y-2">
                <Label htmlFor="evPublishAt">{t("adm.786")}</Label>
                <Input
                  id="evPublishAt"
                  type="datetime-local"
                  value={eventDraft.publishAt}
                  onChange={(e) => setEventDraft((d) => ({ ...d, publishAt: e.target.value }))}
                />
                <p className="text-xs text-muted-foreground">
                  {t("adm.787")}
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label>{t("adm.788")}</Label>
              <Select
                value={eventDraft.rewardType}
                disabled={eventDraft.conditionType === "lottery"}
                onValueChange={(v) =>
                  setEventDraft((d) => ({ ...d, rewardType: v as EventRewardType }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REWARD_TYPE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {eventDraft.conditionType === "lottery" && (
                <p className="text-xs text-muted-foreground">
                  {t("adm.789")}
                </p>
              )}
              {eventDraft.conditionType !== "lottery" &&
                (eventDraft.rewardType === "newapi_quota" ||
                  eventDraft.rewardType === "invite_quota" ||
                  eventDraft.rewardType === "points") && (
                  <div className="space-y-2 pt-1">
                    {/* 积分奖励支持「区间随机」：打开后改用上下限两个输入框 */}
                    {eventDraft.rewardType === "points" && (
                      <div className="flex items-center justify-between rounded-md border px-3 py-2">
                        <div className="space-y-0.5">
                          <p className="text-sm font-medium">{t("adm.790")}</p>
                          <p className="text-xs text-muted-foreground">
                            {t("adm.791")}
                          </p>
                        </div>
                        <Switch
                          checked={eventDraft.pointsRandom}
                          onCheckedChange={(v) =>
                            setEventDraft((d) => ({ ...d, pointsRandom: v }))
                          }
                        />
                      </div>
                    )}

                    {eventDraft.rewardType === "points" && eventDraft.pointsRandom ? (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor="evRewardMin">{t("adm.792")}</Label>
                          <Input
                            id="evRewardMin"
                            type="number"
                            min={1}
                            placeholder="5"
                            value={eventDraft.rewardMin}
                            onChange={(e) =>
                              setEventDraft((d) => ({ ...d, rewardMin: e.target.value }))
                            }
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="evRewardMax">{t("adm.793")}</Label>
                          <Input
                            id="evRewardMax"
                            type="number"
                            min={1}
                            placeholder="20"
                            value={eventDraft.rewardMax}
                            onChange={(e) =>
                              setEventDraft((d) => ({ ...d, rewardMax: e.target.value }))
                            }
                          />
                        </div>
                      </div>
                    ) : (
                      <>
                        <Label htmlFor="evAmount">
                          {eventDraft.rewardType === "newapi_quota"
                            ? t("adm.191")
                            : eventDraft.rewardType === "points"
                              ? t("adm.192")
                              : t("adm.193")}
                        </Label>
                        <Input
                          id="evAmount"
                          type="number"
                          min={1}
                          placeholder={
                            eventDraft.rewardType === "newapi_quota"
                              ? "1"
                              : eventDraft.rewardType === "points"
                                ? "10"
                                : "2"
                          }
                          value={eventDraft.rewardAmount}
                          onChange={(e) =>
                            setEventDraft((d) => ({ ...d, rewardAmount: e.target.value }))
                          }
                        />
                      </>
                    )}
                    {eventDraft.rewardType === "newapi_quota" && (
                      <p className="text-xs text-muted-foreground">
                        按「元」填写，发放时会自动换算成中转站额度（1 元 ={" "}
                        {quotaPerUnit.toLocaleString()} 额度）加到对方的余额里。
                        {t("adm.794")}
                      </p>
                    )}
                    {eventDraft.rewardType === "points" && (
                      <p className="text-xs text-muted-foreground">
                        发放到用户的「积分」余额。兑换比例（每 1 积分 = 多少元）在
                        {t("adm.795")}
                        {t("adm.796")}
                        {t("adm.797")}
                        {eventDraft.pointsRandom && (
                          <>
                            <br />
                            {t("adm.798")}
                            {t("adm.799")}
                          </>
                        )}
                      </p>
                    )}
                  </div>
                )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="evMaxClaims">
                {eventDraft.conditionType === "lottery"
                  ? t("adm.194")
                  : t("adm.195")}
              </Label>
              <Input
                id="evMaxClaims"
                type="number"
                min={1}
                placeholder={t("adm.311")}
                value={eventDraft.maxClaims}
                onChange={(e) => setEventDraft((d) => ({ ...d, maxClaims: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">
                {eventDraft.conditionType === "lottery"
                  ? t("adm.196")
                  : t("adm.197")}
              </p>
            </div>

            <div className="space-y-2">
              <Label>{t("adm.800")}</Label>
              <Select
                value={eventDraft.conditionType}
                onValueChange={(v) =>
                  setEventDraft((d) => ({
                    ...d,
                    conditionType: v as EventConditionType,
                    // 抽奖固定发积分：选它时顺手把奖励类型切过去，避免提交时被后端拒绝
                    rewardType: v === "lottery" ? "points" : d.rewardType,
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONDITION_TYPE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {eventDraft.conditionType === "has_feature" && (
                <div className="pt-1">
                  <Select
                    value={eventDraft.conditionFeature}
                    onValueChange={(v) => setEventDraft((d) => ({ ...d, conditionFeature: v }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FEATURES.map((f) => (
                        <SelectItem key={f.key} value={f.key}>
                          {f.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {eventDraft.conditionType === "code" && (
                <div className="space-y-1.5 pt-1">
                  <Input
                    placeholder={t("adm.312")}
                    maxLength={64}
                    value={eventDraft.conditionCode}
                    onChange={(e) =>
                      setEventDraft((d) => ({ ...d, conditionCode: e.target.value }))
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("adm.801")}
                    {t("adm.802")}
                  </p>
                </div>
              )}
              {eventDraft.conditionType === "github_star" && (
                <div className="space-y-1.5 pt-1">
                  <Input
                    placeholder={t("adm.313")}
                    maxLength={120}
                    value={eventDraft.conditionRepo}
                    onChange={(e) =>
                      setEventDraft((d) => ({ ...d, conditionRepo: e.target.value }))
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("adm.803")}
                    <span className="font-medium">{t("adm.804")}</span>
                    {t("adm.805")}
                    {t("adm.806")}
                    {t("adm.807")}
                    <br />
                    <span className="font-medium text-destructive">
                      {t("adm.808")}
                    </span>
                    （环境变量/密钥 <code className="font-mono">GITHUB_TOKEN</code>）：
                    {t("adm.809")}
                  </p>
                </div>
              )}
              {eventDraft.conditionType === "lottery" && (
                <div className="space-y-3 pt-1">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="evLotteryWinners">{t("adm.810")}</Label>
                      <Input
                        id="evLotteryWinners"
                        type="number"
                        min={1}
                        max={200}
                        value={eventDraft.lotteryWinners}
                        onChange={(e) =>
                          setEventDraft((d) => ({ ...d, lotteryWinners: e.target.value }))
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="evLotteryPool">{t("adm.811")}</Label>
                      <Input
                        id="evLotteryPool"
                        type="number"
                        min={1}
                        value={eventDraft.lotteryPool}
                        onChange={(e) =>
                          setEventDraft((d) => ({ ...d, lotteryPool: e.target.value }))
                        }
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>{t("adm.812")}</Label>
                    <Select
                      value={eventDraft.lotteryMode}
                      onValueChange={(v) =>
                        setEventDraft((d) => ({ ...d, lotteryMode: v as "even" | "random" }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="even">{t("adm.813")}</SelectItem>
                        <SelectItem value="random">{t("adm.814")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("adm.815")}
                    {t("adm.816")}
                    {t("adm.817")}
                    {t("adm.818")}
                    {t("adm.819")}
                  </p>
                  {Number(eventDraft.lotteryPool) > 0 &&
                    Number(eventDraft.lotteryPool) < Number(eventDraft.lotteryWinners) && (
                      <p className="text-xs text-destructive">
                        {t("adm.820")}
                      </p>
                    )}
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEventOpen(false)}>
              {t("adm.821")}
            </Button>
            <Button onClick={() => void handleSaveEvent()} disabled={eventBusy}>
              {eventBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              {eventDraft.status === "draft"
                ? t("adm.198")
                : eventDraft.status === "scheduled"
                  ? t("adm.199")
                  : eventDraft.id
                    ? t("adm.200")
                    : t("adm.201")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 活动领取名单 */}
      <Dialog open={claimsOpen} onOpenChange={setClaimsOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>领取名单 · {claimsEvent?.title}</DialogTitle>
            <DialogDescription>
              {t("adm.822")}
            </DialogDescription>
          </DialogHeader>
          {claimsLoading ? (
            <LoadingBlock />
          ) : claims.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t("adm.823")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("adm.824")}</TableHead>
                  <TableHead>{t("adm.825")}</TableHead>
                  <TableHead>{t("adm.826")}</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {claims.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">
                      {c.nickname || c.username || c.userId}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(c.claimedAt).toLocaleString("zh-CN")}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          c.rewardStatus === "granted"
                            ? "success"
                            : c.rewardStatus === "failed"
                              ? "destructive"
                              : "secondary"
                        }
                      >
                        {c.rewardStatus === "granted"
                          ? t("adm.202")
                          : c.rewardStatus === "failed"
                            ? t("adm.203")
                            : c.rewardStatus === "manual"
                              ? t("adm.204")
                              : c.rewardStatus === "lost"
                                ? t("adm.205")
                                : t("adm.206")}
                      </Badge>
                      {c.rewardDetail && (
                        <p className="mt-0.5 text-xs text-muted-foreground">{c.rewardDetail}</p>
                      )}
                    </TableCell>
                    <TableCell>
                      {/* 抽奖未中奖（lost）不是待发放，不给「标记已发放」按钮 */}
                      {c.rewardStatus !== "granted" && c.rewardStatus !== "lost" && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7"
                          onClick={() => void handleGrantClaim(c)}
                        >
                          {t("adm.827")}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </DialogContent>
      </Dialog>

      {/* R2 桶编辑弹窗 */}
      <Dialog open={r2BucketOpen} onOpenChange={setR2BucketOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{r2EditId ? "编辑 R2 桶" : "添加 R2 桶"}</DialogTitle>
            <DialogDescription>
              {r2EditId
                ? t("adm.207")
                : t("adm.208")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {/* 新建时：从已发现的桶里选（大幅简化填写） */}
            {!r2EditId && (
              <div className="space-y-2">
                <Label>{t("adm.828")}</Label>
                {r2DiscoverLoading ? (
                  <p className="text-xs text-muted-foreground">{t("adm.829")}</p>
                ) : r2Discovered?.available ? (
                  <>
                    <Select value={r2Pick} onValueChange={handlePickBucket}>
                      <SelectTrigger>
                        <SelectValue placeholder={t("adm.314")} />
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
                      {t("adm.830")}
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
              <Label>{t("adm.831")}</Label>
              <Select
                value={r2Draft.kind}
                onValueChange={(v) => setR2Draft((d) => ({ ...d, kind: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">{t("adm.832")}</SelectItem>
                  <SelectItem value="platform">{t("adm.833")}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {r2Draft.kind === "platform"
                  ? t("adm.209")
                  : t("adm.210")}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="r2id">{t("adm.834")}</Label>
                <Input
                  id="r2id"
                  placeholder="b2"
                  value={r2Draft.id}
                  disabled={Boolean(r2EditId)}
                  onChange={(e) => setR2Draft((d) => ({ ...d, id: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="r2name">{t("adm.835")}</Label>
                <Input
                  id="r2name"
                  placeholder={t("adm.315")}
                  value={r2Draft.name}
                  onChange={(e) => setR2Draft((d) => ({ ...d, name: e.target.value }))}
                />
              </div>
            </div>
            <details className="rounded-md border" open={Boolean(r2EditId) || !r2Discovered?.available}>
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground">
                {t("adm.836")}
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
                    <Label htmlFor="r2bucket">{t("adm.837")}</Label>
                    <Input
                      id="r2bucket"
                      placeholder="network2"
                      className="font-mono text-xs"
                      value={r2Draft.bucketName}
                      onChange={(e) => setR2Draft((d) => ({ ...d, bucketName: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="r2account">{t("adm.838")}</Label>
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
                <Label htmlFor="r2max">{t("adm.839")}</Label>
                <Input
                  id="r2max"
                  type="number"
                  min={1}
                  value={r2Draft.maxUsers}
                  onChange={(e) => setR2Draft((d) => ({ ...d, maxUsers: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="r2quota">{t("adm.840")}</Label>
                <Input
                  id="r2quota"
                  type="number"
                  min={1}
                  value={r2Draft.quotaPerUser}
                  onChange={(e) => setR2Draft((d) => ({ ...d, quotaPerUser: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="r2sort">{t("adm.841")}</Label>
                <Input
                  id="r2sort"
                  type="number"
                  value={r2Draft.sortOrder}
                  onChange={(e) => setR2Draft((d) => ({ ...d, sortOrder: e.target.value }))}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              每人配额按 MB 填（1024 MB = 1 GiB）。容量上限 = 人数上限 × 每人配额。
              {t("adm.842")}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setR2BucketOpen(false)}>
              {t("adm.843")}
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
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto overflow-x-hidden">
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
                  {detail.user.role === "root" ? (
                    <Badge variant="secondary">{t("adm.844")}</Badge>
                  ) : detail.user.role === "admin" ? (
                    <Badge variant="secondary">admin</Badge>
                  ) : null}
                </DialogTitle>
                <DialogDescription>
                  {detail.user.nickname ? `${detail.user.nickname} · ` : ""}
                  {detail.user.email} · 注册于 {fmtTime(detail.user.createdAt)}
                </DialogDescription>
              </DialogHeader>

              <div className="min-w-0 space-y-4">
                {/* ---- 账号：昵称 / 邮箱验证 / 通知 / 角色 ---- */}
                <section>
                  <h3 className="mb-2 text-sm font-medium">{t("adm.845")}</h3>
                  <div className="space-y-2">
                    <div className="flex items-center gap-3 rounded-md border p-3">
                      <Input
                        className="max-w-xs"
                        value={nickDraft}
                        placeholder={t("adm.316")}
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
                        {t("adm.846")}
                      </Button>
                    </div>

                    <div className="flex items-center justify-between rounded-md border p-3">
                      <div className="space-y-0.5">
                        <p className="text-sm font-medium">{t("adm.847")}</p>
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
                        <p className="text-sm font-medium">{t("adm.848")}</p>
                        <p className="text-xs text-muted-foreground">
                          {t("adm.849")}
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
                        <p className="text-sm font-medium">
                          {detail.user.role === "root" ? "站长" : "管理员"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {detail.user.role === "root"
                            ? t("adm.211")
                            : t("adm.212")}
                        </p>
                      </div>
                      <Switch
                        checked={
                          detail.user.role === "admin" || detail.user.role === "root"
                        }
                        // root 不能被改（被查看者是 root 时锁定）；非 root 操作者也不能改角色
                        disabled={
                          busy ||
                          detail.user.username === user?.username ||
                          detail.user.role === "root" ||
                          user?.role !== "root"
                        }
                        onCheckedChange={(v) =>
                          void handleToggleRole(v ? "admin" : "user")
                        }
                      />
                    </div>
                  </div>
                </section>

                {/* ---- 各模块用量与开通状态 ---- */}
                <section>
                  <h3 className="mb-2 text-sm font-medium">{t("adm.850")}</h3>
                  <div className="rounded-md border">
                    {/* 网盘 */}
                    <div className="border-b px-3 py-2 text-xs last:border-b-0">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{t("adm.851")}</span>
                        {detail.storage ? (
                          <Badge variant={detail.storage.enabled ? "success" : "secondary"}>
                            {detail.storage.enabled ? "已开通" : "已停用"}
                          </Badge>
                        ) : (
                          <Badge variant="outline">{t("adm.852")}</Badge>
                        )}
                      </div>
                      {detail.storage && (
                        <>
                          <p className="mt-1 text-muted-foreground">
                            {detail.storage.prefix}/ · {formatBytes(detail.storage.usedBytes)} /{" "}
                            {formatBytes(detail.storage.quotaBytes)} · {detail.storage.fileCount} 个文件
                            {detail.storage.bucketName && ` · 桶 ${detail.storage.bucketName}`}
                          </p>
                          {/* 单独改这个人的配额：配额是开通时写死的快照，改桶不会回填老用户 */}
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <Input
                              type="number"
                              min={1}
                              className="h-8 w-28"
                              aria-label={t("adm.317")}
                              value={storageQuotaMbDraft}
                              onChange={(e) => setStorageQuotaMbDraft(e.target.value)}
                            />
                            <span className="text-muted-foreground">MB</span>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8"
                              disabled={
                                storageQuotaBusy ||
                                storageQuotaMbDraft ===
                                  String(
                                    Math.round((detail.storage.quotaBytes / 1024 / 1024) * 100) /
                                      100
                                  )
                              }
                              onClick={() => void handleSaveStorageQuota()}
                            >
                              {storageQuotaBusy && (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              )}
                              {t("adm.853")}
                            </Button>
                            {detail.storage.usedBytes > 0 && (
                              <span className="text-muted-foreground">
                                已用 {formatBytes(detail.storage.usedBytes)}
                              </span>
                            )}
                          </div>
                        </>
                      )}
                    </div>

                    {/* AI 中转站 */}
                    <div className="border-b px-3 py-2 text-xs last:border-b-0">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{t("adm.854")}</span>
                        {detail.newapi ? (
                          <Badge variant="success">{t("adm.855")}</Badge>
                        ) : (
                          <Badge variant="outline">{t("adm.856")}</Badge>
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
                      {detail.newapi && (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8"
                            disabled={newapiSyncBusy}
                            onClick={() => void handleSyncNewApi()}
                          >
                            {newapiSyncBusy && (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            )}
                            {t("adm.857")}
                          </Button>
                          <span className="text-muted-foreground">
                            {t("adm.858")}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* 内网穿透 */}
                    <div className="border-b px-3 py-2 text-xs last:border-b-0">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{t("adm.859")}</span>
                        {detail.frp ? (
                          <Badge variant={detail.frp.enabled ? "success" : "secondary"}>
                            {detail.frp.enabled ? "已启用" : "已关闭"}
                          </Badge>
                        ) : (
                          <Badge variant="outline">{t("adm.860")}</Badge>
                        )}
                      </div>
                      {(detail.frpPorts.length > 0 || detail.frpApplications.length > 0) && (
                        <div className="mt-1 space-y-1 text-muted-foreground">
                          {detail.frpPorts.length > 0 && (
                            <p>
                              {t("adm.861")}
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
                        <span className="font-medium">{t("adm.862")}</span>
                        {detail.proxy ? (
                          <Badge variant={detail.proxy.enabled ? "success" : "secondary"}>
                            {detail.proxy.enabled ? "已启用" : "已关闭"}
                          </Badge>
                        ) : (
                          <Badge variant="outline">{t("adm.863")}</Badge>
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
                  <h3 className="mb-2 text-sm font-medium">{t("adm.864")}</h3>
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
                                {t("adm.865")}
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
                      <p className="text-muted-foreground">{t("adm.866")}</p>
                    )}
                  </div>
                </section>

                {/* ---- 邀请码 / 模块额度 ---- */}
                <section>
                  <h3 className="mb-2 text-sm font-medium">{t("adm.867")}</h3>
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
                      <p className="px-3 py-4 text-sm text-muted-foreground">{t("adm.868")}</p>
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
                        className="rounded-md border px-2.5 py-1 font-mono text-xs break-all"
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
                      <p className="px-3 py-4 text-sm text-muted-foreground">{t("adm.869")}</p>
                    ) : (
                      detail.dns.slice(0, 30).map((r) => (
                        <div
                          key={r.id}
                          className="flex items-center justify-between gap-2 border-b px-3 py-2 text-xs last:border-b-0"
                        >
                          <span className="font-mono break-all">{r.fqdn}</span>
                          <span className="shrink-0 text-muted-foreground">
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
                        className="rounded-md border px-2.5 py-1 font-mono text-xs break-all"
                      >
                        {mb.address}
                        {mb.primary && (
                          <span className="ml-1 text-muted-foreground">{t("adm.870")}</span>
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
                      <p className="px-3 py-4 text-sm text-muted-foreground">{t("adm.871")}</p>
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
                  <h3 className="mb-2 text-sm font-medium">{t("adm.872")}</h3>
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
                  <h3 className="mb-2 text-sm font-medium">{t("adm.873")}</h3>
                  <div className="rounded-md border p-3">
                    <div className="flex items-center gap-3">
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        className="w-24"
                        value={quotaDraft ?? ""}
                        placeholder={t("adm.318")}
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
                        {t("adm.874")}
                      </Button>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t("adm.875")}
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
                        {t("adm.876")}
                      </>
                    ) : (
                      <>
                        <UserCheck className="h-3.5 w-3.5" />
                        {t("adm.877")}
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
              {t("adm.878")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>{t("adm.879")}</Label>
                <Input
                  value={nodeForm.name}
                  onChange={(e) => setNodeForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder={t("adm.319")}
                />
              </div>
              <div className="space-y-2">
                <Label>{t("adm.880")}</Label>
                <Input
                  value={nodeForm.region}
                  onChange={(e) => setNodeForm((f) => ({ ...f, region: e.target.value }))}
                  placeholder={t("adm.320")}
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
                <Label>{t("adm.881")}</Label>
                <Select
                  value={nodeForm.authMode}
                  onValueChange={(v) => setNodeForm((f) => ({ ...f, authMode: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t("adm.882")}</SelectItem>
                    <SelectItem value="token">{t("adm.883")}</SelectItem>
                    <SelectItem value="token_user">{t("adm.884")}</SelectItem>
                    <SelectItem value="custom">{t("adm.885")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
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
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>{t("adm.886")}</Label>
                <p className="text-xs text-muted-foreground">
                  {t("adm.887")}
                  每个用户自己的 <code>metadatas.token</code> 由用户在申请时自设，
                  {t("adm.888")}
                </p>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label>{t("adm.889")}</Label>
                <Input
                  type="number"
                  value={nodeForm.portMin}
                  onChange={(e) =>
                    setNodeForm((f) => ({ ...f, portMin: e.target.value }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>{t("adm.890")}</Label>
                <Input
                  type="number"
                  value={nodeForm.portMax}
                  onChange={(e) =>
                    setNodeForm((f) => ({ ...f, portMax: e.target.value }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>{t("adm.891")}</Label>
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
              <Label>{t("adm.892")}</Label>
              <Input
                value={nodeForm.note}
                onChange={(e) => setNodeForm((f) => ({ ...f, note: e.target.value }))}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>{t("adm.893")}</Label>
                <Select
                  value={nodeForm.status}
                  onValueChange={(v) => setNodeForm((f) => ({ ...f, status: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="online">{t("adm.894")}</SelectItem>
                    <SelectItem value="offline">{t("adm.895")}</SelectItem>
                    <SelectItem value="maintenance">{t("adm.896")}</SelectItem>
                    <SelectItem value="unknown">{t("adm.897")}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t("adm.898")}
                </p>
              </div>
              <div className="space-y-2">
                <Label>{t("adm.899")}</Label>
                <Input
                  value={nodeForm.statusNote}
                  onChange={(e) =>
                    setNodeForm((f) => ({ ...f, statusNote: e.target.value }))
                  }
                  placeholder={t("adm.321")}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNodeOpen(false)}>
              {t("adm.900")}
            </Button>
            <Button onClick={() => void handleSaveNode()} disabled={frpBusy}>
              {frpBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("adm.901")}
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
              {t("adm.902")}
              {t("adm.903")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>{t("adm.904")}</Label>
                <Input
                  value={proxyForm.name}
                  onChange={(e) =>
                    setProxyForm((f) => ({ ...f, name: e.target.value }))
                  }
                  placeholder={t("adm.322")}
                />
              </div>
              <div className="space-y-2">
                <Label>{t("adm.905")}</Label>
                <Input
                  value={proxyForm.region}
                  onChange={(e) =>
                    setProxyForm((f) => ({ ...f, region: e.target.value }))
                  }
                  placeholder={t("adm.323")}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>{t("adm.906")}</Label>
              <Input
                value={proxyForm.url}
                onChange={(e) =>
                  setProxyForm((f) => ({ ...f, url: e.target.value }))
                }
                placeholder="https://example.com/api/v1/client/subscribe?token=..."
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                {t("adm.907")}
                抓取时会自动带上 Authorization: Bearer。
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label>{t("adm.908")}</Label>
                <Input
                  value={proxyForm.protocol}
                  onChange={(e) =>
                    setProxyForm((f) => ({ ...f, protocol: e.target.value }))
                  }
                  placeholder={t("adm.324")}
                />
                <p className="text-xs text-muted-foreground">
                  {t("adm.909")}
                </p>
              </div>
              <div className="space-y-2">
                <Label>{t("adm.910")}</Label>
                <Input
                  type="number"
                  value={proxyForm.sortOrder}
                  onChange={(e) =>
                    setProxyForm((f) => ({ ...f, sortOrder: e.target.value }))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("adm.911")}</Label>
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
                    <SelectItem value="online">{t("adm.912")}</SelectItem>
                    <SelectItem value="offline">{t("adm.913")}</SelectItem>
                    <SelectItem value="maintenance">{t("adm.914")}</SelectItem>
                    <SelectItem value="unknown">{t("adm.915")}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t("adm.916")}
                </p>
              </div>
            </div>
            <div className="space-y-2">
              <Label>{t("adm.917")}</Label>
              <Input
                value={proxyForm.statusNote}
                onChange={(e) =>
                  setProxyForm((f) => ({ ...f, statusNote: e.target.value }))
                }
                placeholder={t("adm.325")}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("adm.918")}</Label>
              <Input
                value={proxyForm.note}
                onChange={(e) =>
                  setProxyForm((f) => ({ ...f, note: e.target.value }))
                }
              />
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">{t("adm.919")}</p>
                <p className="text-xs text-muted-foreground">
                  {t("adm.920")}
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
              {t("adm.921")}
            </Button>
            <Button onClick={() => void handleSaveProxy()} disabled={proxyBusy}>
              {proxyBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("adm.922")}
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
  sensenova: "商汤 Key",
}

/** 捐献的分类维度：未处理 / 人工通过 / 人工拒绝 / 自动通过 / 自动拒绝 */
type DonationBucket = "pending" | "approved" | "rejected" | "autoApproved" | "autoRejected"

const DONATION_FILTERS: { key: string; label: string }[] = [
  { key: "", label: "全部" },
  { key: "pending", label: "未处理" },
  { key: "approved", label: "已通过" },
  { key: "rejected", label: "已拒绝" },
  { key: "autoApproved", label: "自动通过" },
  { key: "autoRejected", label: "自动拒绝" },
]

/**
 * 判断一条捐献属于哪个分类（pending 归「未处理」，其余按 autoReviewed 分人工/自动）。
 *
 * `revoked`（已通过后被系统巡检撤销，如商汤 Key 失效）走最后一行 —— 它是系统
 * 自动处置的，因此落在「自动拒绝」分类里，管理员能在那里看到并复核。
 */
function donationBucket(d: Donation): DonationBucket {
  if (d.status === "pending") return "pending"
  if (d.status === "approved") return d.autoReviewed ? "autoApproved" : "approved"
  return d.autoReviewed ? "autoRejected" : "rejected"
}

/** 捐献类别筛选（上层）：全部 / AI / 内网穿透 / 代理 / 商汤 */
const DONATION_TYPE_FILTERS: { key: string; label: string }[] = [
  { key: "", label: "全部" },
  { key: "ai", label: "AI" },
  { key: "frp", label: "内网穿透" },
  { key: "proxy", label: "代理" },
  { key: "sensenova", label: "商汤" },
]

/** 先按类别筛，再按状态分类筛 */
function filterDonationsByTypeAndStatus(
  list: Donation[],
  typeFilter: string,
  statusFilter: string
): Donation[] {
  let out = list
  if (typeFilter) out = out.filter((d) => d.type === typeFilter)
  if (statusFilter) out = out.filter((d) => donationBucket(d) === statusFilter)
  return out
}

/** 邀请码分类：未使用 / 部分使用 / 已使用 */
function inviteBucket(inv: AdminInvite): "unused" | "partial" | "used" {
  if (inv.usedCount <= 0) return "unused"
  if (inv.usedCount >= inv.maxUses) return "used"
  return "partial"
}

const INVITE_FILTERS: { key: string; label: string }[] = [
  { key: "", label: "全部" },
  { key: "unused", label: "未使用" },
  { key: "partial", label: "部分使用" },
  { key: "used", label: "已使用" },
]

function filterInvites(list: AdminInvite[], filter: string): AdminInvite[] {
  if (!filter) return list
  return list.filter((inv) => inviteBucket(inv) === filter)
}

/** frp 申请分类：待审核 / 已通过 / 已拒绝 */
const FRP_FILTERS: { key: string; label: string }[] = [
  { key: "", label: "全部" },
  { key: "pending", label: "待审核" },
  { key: "approved", label: "已通过" },
  { key: "rejected", label: "已拒绝" },
]

function filterFrpApps(list: AdminFrpApplication[], filter: string): AdminFrpApplication[] {
  if (!filter) return list
  return list.filter((a) => a.status === filter)
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
  } else if (type === "sensenova") {
    // 只展示 Key：上游地址是管理面板的全局配置（不在 payload 里），
    // 模型列表是建渠道时从上游拉来的、也没存进 payload。
    if (p.apiKey) rows.push(["API Key", String(p.apiKey)])
  } else if (type === "frp") {
    // 捐献的是服务端信息（迁移 0054 改版后）；旧数据是 configYml（客户端配置）
    if (p.serverAddr) rows.push(["服务端地址", `${String(p.serverAddr)}:${String(p.serverPort ?? "")}`])
    if (p.nodeName) rows.push(["节点名称", String(p.nodeName)])
    if (p.region) rows.push(["地区", String(p.region)])
    if (p.portMin != null || p.portMax != null) {
      rows.push(["端口范围", `${String(p.portMin ?? "")}-${String(p.portMax ?? "")}`])
    }
    if (p.maxPorts != null) rows.push(["每用户端口上限", String(p.maxPorts)])
    const authModeLabel: Record<string, string> = {
      none: "无鉴权",
      token: "全局 auth.token",
      token_user: "全局 token + 每用户账号",
      custom: "自定义插件",
    }
    if (p.authMode) rows.push(["鉴权方式", authModeLabel[String(p.authMode)] ?? String(p.authMode)])
    if (p.note) rows.push(["备注", String(p.note)])
  } else if (type === "proxy") {
    const subs = Array.isArray(p.subUrls) ? p.subUrls : []
    if (subs.length) rows.push(["订阅链接", subs.join("、")])
    if (p.nodeCount) rows.push(["节点数", String(p.nodeCount)])
  }

  const configYml = typeof p.configYml === "string" ? p.configYml : ""
  const configSample = typeof p.configSample === "string" ? p.configSample : ""
  const configText = configYml || configSample

  return (
    <div className="space-y-1">
      {rows.map(([k, v]) => (
        <p key={k} className="break-all font-mono text-xs text-muted-foreground">
          {k}：{v}
        </p>
      ))}
      {configText && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            {configYml ? "查看 config.yml" : "查看 frpc.toml 示例"}
          </summary>
          <pre className="mt-1 max-h-56 overflow-auto rounded border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
            {configText}
          </pre>
        </details>
      )}
    </div>
  )
}
