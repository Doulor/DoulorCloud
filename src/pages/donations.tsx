import * as React from "react"
import { Link, useSearchParams } from "react-router-dom"
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  Download,
  ExternalLink,
  Gift,
  Heart,
  KeyRound,
  LayoutDashboard,
  Link2,
  Loader2,
  Network,
  Plus,
  Send,
  Sparkles,
  Ticket,
  RotateCw,
  Trash2,
  Unplug,
  WifiOff,
  Zap,
} from "lucide-react"
import { toast } from "sonner"

import { PageHeader } from "@/components/page-header"
import { EmptyState } from "@/components/empty-state"
import { LoadingBlock } from "@/components/loading-block"
import { NavItem, NavGroup } from "@/components/sub-nav"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent } from "@/components/ui/tabs"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  authApi,
  donationApi,
  myInviteApi,
  voucherApi,
  wb2apiApi,
  cli2apiApi,
  HttpError,
} from "@/services/api"
import { fmtTime } from "@/lib/format"
import { useT, tStatic } from "@/i18n"
import type {
  AiProbeResult,
  DonationOverview,
  MyInvite,
  MyInvitesOverview,
  Permissions,
  SenseNovaDonationBlock,
  VoucherOverview,
  Wb2ApiDonationBlock,
  Cli2ApiDonationBlock,
} from "@/types"

/**
 * 每种捐献类型的展示元数据。
 *
 * `sensenova` 不在这里 —— 它没有「弹窗表单」这一步（见 SenseNovaDonationCard），
 * 所以不需要 desc（那是给「资源有限，按需开放」那张列表用的）。
 * 但 `label` 要能查到，否则捐献记录列表会显示原始 type 名。
 */
const TYPE_META: Record<string, { label: string; desc: string }> = {
  // 卡片标题用「AI 模型」而不是「AI 中转站」：这里捐的是模型（渠道是载体），
  // 叫「中转站」会把「站点」和「模型资源」混起来，用户容易不知道该填什么。
  ai: { label: "don.type.ai", desc: "don.type.aiDesc" },
  frp: { label: "don.type.frp", desc: "don.type.frpDesc" },
  proxy: { label: "don.type.proxy", desc: "don.type.proxyDesc" },
  sensenova: { label: "don.type.sensenova", desc: "don.type.sensenovaDesc" },
}

/**
 * 「资源有限，按需开放」列表里要展示的类型。
 *
 * 排除 `sensenova`：它有自己的卡片（走免审核通道，不经过那个弹窗表单），
 * 放进这个列表会让用户点「贡献」后弹出一个不认识的表单。
 */
const LISTED_TYPES = ["ai", "frp", "proxy"]

/**
 * AI 上游的接口格式选项。
 *
 * 上游可能只实现了其中一种 —— 用错格式会直接被拒（典型报错是 401 / 404），
 * 而报错内容通常看不出是「格式不对」。所以让用户能自己切换着试。
 * `value` 是探测时用的格式名，`channelType` 是建渠道时给 NewAPI 的类型。
 */
const AI_FORMATS: { value: string; label: string; channelType: number }[] = [
  { value: "auto", label: "don.fmt.auto", channelType: 1 },
  { value: "openai", label: "don.fmt.openai", channelType: 1 },
  { value: "anthropic", label: "don.fmt.anthropic", channelType: 14 },
]

export default function DonationPage() {
  const { t } = useT()
  const [searchParams] = useSearchParams()
  const [data, setData] = React.useState<DonationOverview | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [dialogType, setDialogType] = React.useState<string | null>(null)
  /**
   * 当前分区。与 admin 面板一致：用受控 state 而非 URL 路由
   * （刷新回到默认的「概览」是可接受的）。
   * 支持通过 `?tab=invite` 直接跳到指定分区（如 AI 页「去邀请」的快捷入口）。
   */
  const [activeTab, setActiveTab] = React.useState(() => {
    const tab = searchParams.get("tab")
    return tab && ["overview", "invite", "ai", "frp", "proxy"].includes(tab)
      ? tab
      : "overview"
  })

  const load = React.useCallback(async () => {
    setLoading(true)
    setFailed(false)
    try {
      const res = await donationApi.list()
      setData(res)
    } catch (err) {
      // ⚠️ 2026-09-26：失败必须落成错误态。原先只 toast，`data` 保持 null ⇒
      // 页面显示成「还没有捐献记录」，用户以为本来就没人捐过。
      toast.error(err instanceof HttpError ? err.message : t("at.err.load"))
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  /** 捐献记录加载失败（用于区分「加载失败」与「确实没有记录」） */
  const [failed, setFailed] = React.useState(false)

  // 我的邀请码（额度 + 列表）
  const [invites, setInvites] = React.useState<MyInvitesOverview | null>(null)
  /** 邀请额度加载失败（原先完全静默，界面上会什么都不显示，看不出是失败还是没码） */
  const [invitesFailed, setInvitesFailed] = React.useState(false)
  const [inviteOpen, setInviteOpen] = React.useState(false)
  const [inviteCode, setInviteCode] = React.useState("")
  const [inviteFeatures, setInviteFeatures] = React.useState<string[]>([])
  const [inviteBusy, setInviteBusy] = React.useState(false)
  const [copiedCode, setCopiedCode] = React.useState<string | null>(null)
  /** 复制的是「邀请链接」时高亮的码（与只复制码分开，两个按钮互不抢高亮） */
  const [copiedLink, setCopiedLink] = React.useState<string | null>(null)
  /** 「一键生成邀请链接」时手上没有可用码 ⇒ 先弹创建框，建完自动复制链接 */
  const [linkAfterCreate, setLinkAfterCreate] = React.useState(false)

  /**
   * 当前是否处于「限时开放注册」（公开接口，无需登录）。
   *
   * 只用于界面提示：开放期间**不含权限**的邀请码不消耗次数、可无限次分享，
   * 且这时手上没有可用码也能直接分享注册页链接。拉取失败按「未开放」处理
   * （保守：最多不显示这条提示，不影响邀请码本身的真实行为）。
   */
  const [openRegistration, setOpenRegistration] = React.useState(false)

  React.useEffect(() => {
    let alive = true
    authApi
      .registerStatus()
      .then((s) => {
        if (alive) setOpenRegistration(s.openRegistration)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const loadInvites = React.useCallback(async () => {
    try {
      setInvites(await myInviteApi.list())
      setInvitesFailed(false)
    } catch {
      // 不再完全静默：额度区加载失败时给一个可重试的提示，
      // 否则界面上「什么都没有」，看不出是失败还是本来就没有邀请码。
      setInvitesFailed(true)
    }
  }, [])

  React.useEffect(() => {
    void loadInvites()
  }, [loadInvites])

  /**
   * 该邀请码在**当前**是否「不限次数使用」——与后端同一口径：
   * 限时开放注册期间，码上带的模块全部落在「基础权限」之内
   * （= 免码注册本来也能拿到）⇒ 注册时不消耗次数，可无限次分享。
   * 带权限的码不受影响，照旧一次性。
   *
   * ⚠️ 判断口径必须与 `worker/src/permissions.ts` 的
   * `isBasicOnlyInvitePermissions` 保持一致。后端还额外要求「四个键都显式写全」，
   * 而前端拿到的是解析后的对象（看不出缺键），所以极少数历史遗留码可能被前端
   * 多标一个徽章 —— 只是显示问题，真实行为以后端为准。
   */
  const isUnlimitedInvite = React.useCallback(
    (inv: MyInvite) => {
      if (!openRegistration || !invites) return false
      const basic = invites.basicFeatures ?? []
      return invites.quotaFeatures.every(
        (f) => !inv.permissions[f as keyof Permissions] || basic.includes(f)
      )
    },
    [openRegistration, invites]
  )

  const handleCreateInvite = async () => {
    setInviteBusy(true)
    try {
      const res = await myInviteApi.create({
        code: inviteCode.trim() || undefined,
        features: inviteFeatures,
      })
      toast.success(t("don.ok.inviteCreated"))
      setInviteOpen(false)
      setInviteCode("")
      setInviteFeatures([])
      await loadInvites()
      // 从「一键生成邀请链接」进来的：建完直接把链接塞进剪贴板，省一步
      if (linkAfterCreate) {
        setLinkAfterCreate(false)
        await copyLink(res.invite.code)
      }
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("dm.err.create"))
    } finally {
      setInviteBusy(false)
    }
  }

  const handleDeleteInvite = async (inv: MyInvite) => {
    try {
      const res = await myInviteApi.remove(inv.id)
      toast.success(res.refunded ? t("don.ok.deletedRefunded") : t("don.ok.deletedNoRefund"))
      await loadInvites()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("em.err.delete"))
    }
  }

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code)
      setCopiedCode(code)
      setTimeout(() => setCopiedCode(null), 1500)
    } catch {
      toast.error(t("ai.err.copy"))
    }
  }

  /**
   * 邀请链接：好友点开就是注册页，邀请码自动填好，不用再手抄。
   * 用当前 origin 而不是写死域名 —— 预览环境/自定义域下也拿到正确的地址。
   */
  const inviteLinkOf = (code: string) =>
    `${window.location.origin}/register?code=${encodeURIComponent(code)}`

  const copyLink = async (code: string) => {
    try {
      await navigator.clipboard.writeText(inviteLinkOf(code))
      setCopiedLink(code)
      setTimeout(() => setCopiedLink(null), 1500)
      toast.success(t("don.ok.linkCopied"))
    } catch {
      toast.error(t("ai.err.copy"))
    }
  }

  /**
   * 开放注册期间手上没有可用码时的兜底：直接分享注册页 —— 那时注册本就不需要码。
   */
  const copyRegisterLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/register`)
      toast.success(t("don.ok.openRegCopied"))
    } catch {
      toast.error(t("ai.err.copy"))
    }
  }

  /** 卡片右上角「一键生成邀请链接」：有可用码就直接复制，没有就先建一个再复制 */
  const handleQuickLink = async () => {
    const available = invites?.invites.find(
      (i) => isUnlimitedInvite(i) || i.usedCount < i.maxUses
    )
    if (available) {
      await copyLink(available.code)
      return
    }
    // 开放注册期间「额度用完 / 码都用掉了」不该是死路 —— 不给码也能注册
    if (openRegistration) {
      await copyRegisterLink()
      return
    }
    if ((invites?.quota.inviteRemaining ?? 0) < 1) {
      toast.error(t("don.err.quotaExhausted"))
      return
    }
    setLinkAfterCreate(true)
    setInviteOpen(true)
  }

  const perms = data?.permissions
  // 可捐献的类型（已解锁的用户也能主动贡献），只是未解锁的会标注出来，
  // 方便知道贡献哪个能解锁什么。sensenova 不在这个列表里 —— 它有自己的卡片。
  const allTypes = data
    ? LISTED_TYPES.filter((t) => t in data.typeLabels).map(
        (t) => [t, data.typeLabels[t]] as [string, string]
      )
    : []

  /**
   * 某个分区的捐献记录列表。
   *
   * 接受多个 type 是因为「AI 模型」分区里同时装着 `ai` 与 `sensenova`
   * 两种单据 —— 它们解锁的是同一个权限，用户视角看就是一回事，
   * 分成两个分区反而会让人以为少了一条记录。
   *
   * 抽成函数而不是就地内联：三类资源各在自己的分区里展示记录，
   * 复制三份的 JSX 迟早会漂移（改了一处的状态徽章忘了另两处）。
   */
  const renderRecords = (...types: string[]) => {
    const rows = (data?.donations ?? []).filter((d) => types.includes(d.type))
    if (loading) return <LoadingBlock />
    if (failed) {
      return (
        <EmptyState
          icon={WifiOff}
          title={t("cm.postFailed")}
          description={t("cm.loadFailedDesc")}
          action={
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RotateCw className="h-4 w-4" /> {t("common.retry")}
            </Button>
          }
        />
      )
    }
    if (rows.length === 0) {
      return (
        <EmptyState
          icon={Heart}
          title={t("don.records.empty")}
          description={t("don.records.emptyDesc")}
        />
      )
    }
    return (
      <div className="space-y-3">
        {rows.map((d) => (
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
                  d.status === "approved"
                    ? "success"
                    : d.status === "pending"
                      ? "secondary"
                      : "destructive"
                }
              >
                {d.status === "approved"
                  ? t("frp.st.approved")
                  : d.status === "pending"
                    ? t("frp.st.pending")
                    : d.status === "revoked"
                      ? t("don.status.expired")
                      : t("frp.st.rejected")}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-2">
              {d.autoReviewed && (
                <Badge variant="outline">
                  {d.status === "approved"
                    ? t("don.review.autoPassed")
                    : d.status === "revoked"
                      ? t("don.review.autoRevoked")
                      : t("don.review.autoFailed")}
                </Badge>
              )}
              {d.status === "approved" && d.channelId !== null && d.channelId !== undefined && (
                <p className="text-xs text-muted-foreground">
                  {t("don.records.channel", { id: d.channelId })}
                </p>
              )}
              {d.remark && <p className="text-sm text-muted-foreground">{t("don.records.remark", { text: d.remark })}</p>}
              {d.reviewNote && (
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                  {t("don.records.reviewNote", { text: d.reviewNote })}
                </p>
              )}
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
                      toast.success(t("don.ok.revoked"))
                      void load()
                    } catch (err) {
                      toast.error(err instanceof HttpError ? err.message : t("don.err.revoke"))
                    } finally {
                      setBusy(false)
                    }
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                  {t("don.records.revoke")}
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    )
  }

  /** 某个资源分区的「贡献」按钮 + 说明（三个分区共用同一套版式） */
  const renderResourceIntro = (type: string) => (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {TYPE_META[type]?.label}
          {perms?.[type as keyof Permissions] ? (
            <Badge variant="success">{t("don.unlocked")}</Badge>
          ) : (
            <Badge variant="secondary">{t("don.locked")}</Badge>
          )}
        </CardTitle>
        <CardDescription>
          {t(TYPE_META[type]?.desc ?? "")}{t("don.card.note")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button size="sm" onClick={() => setDialogType(type)}>
          <Plus className="h-4 w-4" />
          {t("don.card.contribute", { label: t(TYPE_META[type]?.label ?? "") })}
        </Button>
      </CardContent>
    </Card>
  )

  return (
    <div>
      <PageHeader title={t("don.title")} description={t("don.subtitle")} />

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <div className="flex flex-col gap-6 lg:flex-row">
          {/* 左侧二级导航：与 admin 面板同一套交互（受控 state，不改 URL 路由） */}
          <aside className="w-full shrink-0 lg:w-48">
            <Link
              to="/dashboard"
              className="mb-3 inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              {t("space.backToConsole")}
            </Link>
            <nav className="flex flex-col gap-0.5">
              <NavItem
                active={activeTab === "overview"}
                icon={LayoutDashboard}
                label={t("don.nav.overview")}
                onClick={() => setActiveTab("overview")}
              />
              <NavItem
                active={activeTab === "invite"}
                icon={Ticket}
                label={t("don.nav.invite")}
                onClick={() => setActiveTab("invite")}
              />
              <NavGroup label={t("don.nav.group")}>
                <NavItem
                  active={activeTab === "ai"}
                  icon={Sparkles}
                  label={t("don.type.ai")}
                  onClick={() => setActiveTab("ai")}
                />
                <NavItem
                  active={activeTab === "frp"}
                  icon={Network}
                  label={t("don.type.frp")}
                  onClick={() => setActiveTab("frp")}
                />
                <NavItem
                  active={activeTab === "proxy"}
                  icon={Zap}
                  label={t("don.type.proxy")}
                  onClick={() => setActiveTab("proxy")}
                />
              </NavGroup>
            </nav>
          </aside>

          <div className="min-w-0 flex-1">
            <TabsContent value="overview">
              <Card className="mb-6">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Heart className="h-4 w-4 text-muted-foreground" />
                    {t("don.intro.title")}
                  </CardTitle>
                  <CardDescription>
                    {t("don.intro.desc")}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                    {t("don.first.a")}
                    <span className="text-foreground">{t("don.first.bold")}</span>
                    {t("don.first.b")}
                  </div>
                  {allTypes.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
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
                              <Badge variant="success">{t("don.unlocked")}</Badge>
                            ) : (
                              <Badge variant="secondary">{t("don.locked")}</Badge>
                            )}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {TYPE_META[type]?.desc}
                          </p>
                        </div>
                        {/* 跳到对应分区，而不是直接弹表单 —— 那里有完整的说明与
                            （对 AI 而言）另两条免审核通道的入口 */}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setActiveTab(type)}
                        >
                          <Plus className="h-4 w-4" />
                          {t("don.card.contributeShort")}
                        </Button>
                      </div>
                      )
                    })
                  )}
                </CardContent>
              </Card>

              {/* 兑换码：放在概览最前面 —— 拿到码的人一进页面就要能用，
                  之前排在「我的邀请码」下面（那列表很长）导致根本看不到 */}
              <RedeemCard onChanged={() => void load()} />

              {/* 邀请功能已移至「邀请」分区 */}
              <Card>
                <CardContent className="flex items-center justify-between py-4">
                  <div className="space-y-1">
                    <p className="text-sm font-medium">{t("don.invite.title")}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("don.invite.desc")}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setActiveTab("invite")}>
                    {t("don.invite.go")}
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </CardContent>
              </Card>

            </TabsContent>

            <TabsContent value="invite">
              {/* 邀请奖励说明 */}
              <Card className="mb-6">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Ticket className="h-4 w-4 text-muted-foreground" />
                    {t("don.rewards.title")}
                  </CardTitle>
                  <CardDescription>
                    {t("don.rewards.wb")}
                    {t("don.rewards.channel")}
                  </CardDescription>
                </CardHeader>
              </Card>

              {/* 我的邀请码：额度 + 创建 + 列表 */}
              <Card className="mb-6">
                <CardHeader>
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <CardTitle className="flex items-center gap-2 text-base">
                        <Ticket className="h-4 w-4 text-muted-foreground" />
                        {t("don.invites.title")}
                      </CardTitle>
                      <CardDescription>
                        {t("don.invites.descA", { n: invites?.quota.inviteBase ?? 3 })}
                        {t("don.invites.descB")}
                        {t("don.invites.descC")}
                      </CardDescription>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void handleQuickLink()}
                        // 开放注册期间永远可用：就算没有码，也能直接分享注册页链接
                        disabled={
                          !openRegistration &&
                          (invites?.quota.inviteRemaining ?? 0) < 1 &&
                          !(
                            invites?.invites.some(
                              (i) => isUnlimitedInvite(i) || i.usedCount < i.maxUses
                            ) ?? false
                          )
                        }
                        title={t("don.invites.linkHint")}
                      >
                        <Link2 className="h-4 w-4" />
                        {t("don.invites.link")}
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => setInviteOpen(true)}
                        disabled={(invites?.quota.inviteRemaining ?? 0) < 1}
                      >
                        <Plus className="h-4 w-4" />
                        {t("common.create")}
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {invitesFailed && (
                    <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
                      <span>{t("don.invites.loadFailed")}</span>
                      <Button variant="outline" size="sm" onClick={() => void loadInvites()}>
                        {t("common.retry")}
                      </Button>
                    </div>
                  )}
                  {invites && (
                    <>
                      {/* 限时开放注册：这段时间免码也能注册，所以「不含权限」的码
                          不该再被烧掉 —— 后端已改为不消耗次数，这里把规则说清楚。 */}
                      {openRegistration && (
                        <div className="flex items-start gap-2.5 rounded-md border border-primary/30 bg-primary/5 p-3">
                          <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                          <p className="text-xs text-muted-foreground">
                            {t("don.openReg.a")}
                            <span className="font-medium text-foreground">
                              {t("don.openReg.bold")}
                            </span>
                            {t("don.openReg.b")}
                            <span className="font-medium text-foreground">
                              {t("don.openReg.c")}
                            </span>
                            {t("don.openReg.d")}
                            {t("don.openReg.e")}
                          </p>
                        </div>
                      )}
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="rounded-md border px-4 py-3">
                          <p className="text-xs text-muted-foreground">{t("don.quota.invite")}</p>
                          <p className="mt-1 text-lg font-semibold">
                            {invites.quota.inviteRemaining}
                            <span className="ml-1 text-sm font-normal text-muted-foreground">
                              / {invites.quota.inviteTotal}
                            </span>
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {t("don.quota.inviteLine", { base: invites.quota.inviteBase, bonus: invites.quota.inviteBonus })}
                          </p>
                        </div>
                        <div className="rounded-md border px-4 py-3">
                          <p className="text-xs text-muted-foreground">{t("don.quota.module")}</p>
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
                                      {t("don.quota.base")}
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
                            {t("don.quota.hint")}
                          </p>
                        </div>
                      </div>

                      {invites.invites.length === 0 ? (
                        <p className="py-2 text-sm text-muted-foreground">
                          {t("don.invites.empty")}
                        </p>
                      ) : (
                        <div className="divide-y rounded-md border">
                          {invites.invites.map((inv) => {
                            const extra = invites.quotaFeatures.filter(
                              (f) => inv.permissions[f as keyof Permissions]
                            )
                            // 开放注册期间的不限次码：哪怕 usedCount 已经顶到 maxUses，
                            // 链接依然能用（注册会走开放注册、码不消耗）。
                            const unlimited = isUnlimitedInvite(inv)
                            const used = inv.usedCount >= inv.maxUses && !unlimited
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
                                  title={t("don.invites.copyCode")}
                                >
                                  {copiedCode === inv.code ? (
                                    <Check className="h-3.5 w-3.5" />
                                  ) : (
                                    <Copy className="h-3.5 w-3.5" />
                                  )}
                                </Button>
                                {/* 未被使用过才给邀请链接 —— 用过的码再发也是白搭 */}
                                {!used && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7 gap-1.5 px-2 text-xs"
                                    onClick={() => void copyLink(inv.code)}
                                    title={t("don.invites.copyLink")}
                                  >
                                    {copiedLink === inv.code ? (
                                      <Check className="h-3.5 w-3.5" />
                                    ) : (
                                      <Link2 className="h-3.5 w-3.5" />
                                    )}
                                    {t("don.invites.link")}
                                  </Button>
                                )}
                                <Badge variant="outline">{t("don.invites.baseBadge")}</Badge>
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
                                <Badge
                                  variant={used ? 'destructive' : 'success'}
                                  title={
                                    used
                                      ? t("don.invites.state.used")
                                      : unlimited
                                        ? t("don.invites.state.openUnlimited")
                                        : t("don.invites.state.usable")
                                  }
                                >
                                  {used
                                    ? t("don.invites.state.usedShort")
                                    : unlimited
                                      ? t("don.invites.state.unusedOpen")
                                      : t("don.invites.state.unused")}
                                </Badge>
                                <span className="ml-auto text-xs text-muted-foreground">
                                  {fmtTime(inv.createdAt)}
                                </span>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                  onClick={() => void handleDeleteInvite(inv)}
                                  // 退款只看「有没有被用过」——不限次码的 usedCount 也可能 > 0
                                  title={
                                    inv.usedCount > 0 ? t("don.invites.deleteNoRefund") : t("don.invites.deleteRefund")
                                  }
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

              {/* 邀请奖励记录 */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Gift className="h-4 w-4 text-muted-foreground" />
                    {t("don.rew.title")}
                  </CardTitle>
                  <CardDescription>
                    {t("don.rew.desc")}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {!invites?.rewards || invites.rewards.length === 0 ? (
                    <p className="py-2 text-sm text-muted-foreground">
                      {t("don.rew.empty")}
                    </p>
                  ) : (
                    <div className="divide-y rounded-md border">
                      {invites.rewards.map((r, i) => (
                        <div
                          key={i}
                          className="flex flex-wrap items-center gap-2 px-4 py-2.5"
                        >
                          <Badge variant="success">{t("don.rew.daily200")}</Badge>
                          <span className="text-sm">{t("don.rew.invited")}</span>
                          <span className="font-medium">{r.invitee}</span>
                          <span className="ml-auto text-xs text-muted-foreground">
                            {fmtTime(r.grantedAt)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="ai">
              {/* 两条免审核通道排在最前：它们是「立刻可用」的，而下面那个
                  「贡献 AI 模型」要等自动校验 / 人工复核 */}
              <Wb2ApiDonationCard
                block={data?.wb2api}
                aiUnlocked={perms?.ai ?? false}
                onDone={() => void load()}
              />
              <Cli2ApiDonationCard
                block={data?.cli2api}
                aiUnlocked={perms?.ai ?? false}
                onDone={() => void load()}
              />
              <SenseNovaDonationCard
                block={data?.sensenova}
                aiUnlocked={perms?.ai ?? false}
                onDone={() => void load()}
              />
              {renderResourceIntro("ai")}
              {renderRecords("ai", "sensenova")}
            </TabsContent>

            <TabsContent value="frp">
              {renderResourceIntro("frp")}
              {renderRecords("frp")}
            </TabsContent>

            <TabsContent value="proxy">
              {renderResourceIntro("proxy")}
              {renderRecords("proxy")}
            </TabsContent>
          </div>
        </div>
      </Tabs>

      {dialogType && (
        <DonationForm
          type={dialogType}
          maxModels={data?.maxAiModels ?? 30}
          maxSubUrls={data?.maxSubUrls ?? 8}
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
            <DialogTitle>{t("don.create.title")}</DialogTitle>
            <DialogDescription>
              {t("don.create.desc")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="invCode">{t("don.create.code")}</Label>
              <Input
                id="invCode"
                placeholder="DC-XXXX-XXXX"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                className="font-mono"
              />
            </div>
            <div className="space-y-2">
              <Label>{t("don.create.perms")}</Label>
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
                      <Badge variant="outline">{t("don.create.base")}</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {t("don.create.remain", { n: remain })}
                      </span>
                    )}
                  </label>
                )
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("don.create.costA")}
              {inviteFeatures.length > 0 &&
                `{t("don.create.costB")}${
                  inviteFeatures.filter(
                    (f) => !(invites?.basicFeatures?.includes(f) ?? false)
                  ).length
                } {t("don.create.costC")}`}
              {t("don.create.costD", { n: invites?.quota.inviteRemaining ?? 0 })}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInviteOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void handleCreateInvite()} disabled={inviteBusy}>
              {inviteBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("common.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function DonationForm({
  type,
  maxModels,
  maxSubUrls,
  onClose,
  onSubmitted,
}: {
  type: string
  /** AI 类型一次最多能选多少个模型（每个都要真调一次验证可用性） */
  maxModels: number
  /** 代理类型一次最多能提交多少个订阅链接（每个都要真拉一次） */
  maxSubUrls: number
  onClose: () => void
  onSubmitted: () => void
}) {
  const { t } = useT()
  const meta = TYPE_META[type]
  const [busy, setBusy] = React.useState(false)
  const [remark, setRemark] = React.useState("")
  const [baseUrl, setBaseUrl] = React.useState("")
  const [apiKey, setApiKey] = React.useState("")
  const [subUrls, setSubUrls] = React.useState("")

  // ---- frp 捐献：登记一台 frps 服务端 ----
  const [frpForm, setFrpForm] = React.useState({
    nodeName: "",
    region: "",
    serverAddr: "",
    serverPort: "7000",
    portMin: "",
    portMax: "",
    maxPorts: "5",
    authMode: "token_user" as "none" | "token" | "token_user" | "custom",
    authToken: "",
    configSample: "",
    note: "",
  })
  const setFrp = (k: string, v: string) =>
    setFrpForm((prev) => ({ ...prev, [k]: v }))

  // ---- AI 捐献：探测上游 → 勾选模型 ----
  const [probing, setProbing] = React.useState(false)
  const [probe, setProbe] = React.useState<AiProbeResult | null>(null)
  const [selected, setSelected] = React.useState<string[]>([])
  const [filter, setFilter] = React.useState("")
  /**
   * 接口格式。
   *   auto      = 两种都试（先 OpenAI 再 Anthropic），用能读到模型列表的那个
   *   openai    = 只按 OpenAI 兼容试
   *   anthropic = 只按 Anthropic 原生试
   *
   * 之所以让用户能手动指定：有的上游**只实现了 Anthropic 原生接口**，
   * 用 OpenAI 格式去调一定失败，但自动识别时也只会在最后一个候选里报错，
   * 用户需要能自己试出来是哪种。
   */
  const [format, setFormat] = React.useState<"auto" | "openai" | "anthropic">("auto")
  /** 提交时带上的渠道类型；缺省 OpenAI 兼容 */
  const [channelType, setChannelType] = React.useState(1)
  /** 探测失败时的兜底：手填模型名，进管理员的「人工复核」队列 */
  const [manual, setManual] = React.useState(false)
  const [manualModels, setManualModels] = React.useState("")

  const handleProbe = async () => {
    if (!baseUrl.trim() || !apiKey.trim()) {
      toast.error(t("don.err.baseUrlKey"))
      return
    }
    setProbing(true)
    try {
      const res = await donationApi.probeAi({
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        format,
      })
      setProbe(res)
      if (res.ok) {
        // 服务端会给归一化后的地址（去掉尾部 /v1），回填让用户看到真正会用的那个
        setBaseUrl(res.baseUrl)
        if (res.channelType !== null) setChannelType(res.channelType)
        setSelected([])
        setManual(false)
        toast.success(
          t("don.ok.detected", { name: res.channelTypeName, n: res.models.length })
        )
      } else {
        setManual(true)
        toast.error(res.message)
      }
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("don.err.probe"))
    } finally {
      setProbing(false)
    }
  }

  const toggleModel = (m: string) => {
    setSelected((prev) => {
      if (prev.includes(m)) return prev.filter((x) => x !== m)
      if (prev.length >= maxModels) {
        toast.info(t("don.info.maxModels", { n: maxModels }))
        return prev
      }
      return [...prev, m]
    })
  }

  /** 全选：超过上限时只取前 N 个并说明原因，不静默截断 */
  const selectAll = () => {
    const all = probe?.models ?? []
    if (all.length > maxModels) {
      setSelected(all.slice(0, maxModels))
      toast.info(t("don.info.autoSelected", { all: all.length, max: maxModels }))
    } else {
      setSelected(all)
    }
  }

  const handleSubmit = async () => {
    setBusy(true)
    try {
      let payload: unknown
      if (type === "ai") {
        if (!baseUrl.trim() || !apiKey.trim()) {
          toast.error(t("don.err.baseUrlKey"))
          setBusy(false)
          return
        }
        const models = manual
          ? manualModels
              .split(/[\n,]/)
              .map((s) => s.trim())
              .filter(Boolean)
          : selected
        if (models.length === 0) {
          toast.error(manual ? t("don.err.manualModel") : t("don.err.pickModel"))
          setBusy(false)
          return
        }
        if (models.length > maxModels) {
          toast.error(t("don.err.tooManyModels", { max: maxModels, cur: models.length }))
          setBusy(false)
          return
        }
        payload = {
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim(),
          models,
          channelType,
          ...(manual ? { manualModels: true } : {}),
        }
      } else if (type === "frp") {
        // 服务端信息：必填字段在服务端还会校验一次，这里先做轻量提示
        if (!frpForm.serverAddr.trim() || !frpForm.configSample.trim()) {
          toast.error(t("don.err.frpRequired"))
          setBusy(false)
          return
        }
        payload = {
          nodeName: frpForm.nodeName.trim(),
          region: frpForm.region.trim(),
          serverAddr: frpForm.serverAddr.trim(),
          serverPort: Number(frpForm.serverPort) || 7000,
          portMin: Number(frpForm.portMin) || 0,
          portMax: Number(frpForm.portMax) || 0,
          maxPorts: Number(frpForm.maxPorts) || 5,
          authMode: frpForm.authMode,
          authToken: frpForm.authToken.trim(),
          configSample: frpForm.configSample.trim(),
          note: frpForm.note.trim(),
        }
      } else {
        const urls = subUrls.split("\n").map((s) => s.trim()).filter(Boolean)
        if (urls.length === 0) {
          toast.error(t("don.err.subRequired"))
          setBusy(false)
          return
        }
        if (urls.length > maxSubUrls) {
          toast.error(t("don.err.tooManySubs", { max: maxSubUrls, cur: urls.length }))
          setBusy(false)
          return
        }
        payload = { subUrls: urls }
      }

      const res = await donationApi.create({
        type: type as "ai" | "frp" | "proxy",
        payload,
        remark,
      })

      // AI 与代理都是自动化流程，提交后当场就有结论
      if (res.status === "approved") {
        const okMsg =
          type === "ai"
            ? t("don.submit.okAi")
            : type === "proxy"
              ? t("don.submit.okProxy")
              : t("don.submit.okGeneric")
        toast.success(okMsg, {
          description:
            [
              res.reviewNote,
              res.voucherCode
                ? t("don.submit.firstReward", { code: res.voucherCode })
                : "",
            ]
              .filter(Boolean)
              .join("\n") || undefined,
          duration: 12000,
        })
      } else if (res.status === "rejected") {
        toast.error(t("don.submit.autoFailed"), {
          // 后端会把「哪个模型为什么没通过」写在这里，原样给用户看
          description: res.reviewNote ?? t("don.submit.toManual"),
          duration: 10000,
        })
      } else {
        toast.success(t("don.submit.pending"), {
          description: res.reviewNote ?? undefined,
        })
      }
      onSubmitted()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("frp.err.submit"))
    } finally {
      setBusy(false)
    }
  }

  const visibleModels = probe?.ok
    ? probe.models.filter((m) =>
        filter.trim() ? m.toLowerCase().includes(filter.trim().toLowerCase()) : true
      )
    : []

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("don.dlg.title", { label: t(meta?.label ?? "") })}</DialogTitle>
          <DialogDescription>{meta?.desc}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {type === "ai" && (
            <>
              <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                {t("don.dlg.ai.a")}
                <span className="text-foreground">{t("don.dlg.ai.bold1")}</span>
                {t("don.dlg.ai.b", { max: maxModels })}
                <span className="text-foreground">{t("don.dlg.ai.bold2")}</span>
                {t("don.dlg.ai.c")}
              </div>
              <div className="space-y-2">
                <Label>Base URL</Label>
                <Input
                  placeholder="https://api.example.com"
                  value={baseUrl}
                  onChange={(e) => {
                    setBaseUrl(e.target.value)
                    setProbe(null)
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {t("don.dlg.ai.urlHint")}
                </p>
              </div>
              <div className="space-y-2">
                <Label>API Key</Label>
                <Input
                  type="password"
                  placeholder="sk-..."
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value)
                    setProbe(null)
                  }}
                />
              </div>

              <div className="space-y-2">
                <Label>{t("don.dlg.ai.format")}</Label>
                <Select
                  value={format}
                  onValueChange={(v) => {
                    setFormat(v as typeof format)
                    const picked = AI_FORMATS.find((f) => f.value === v)
                    // 手选格式时立刻定下渠道类型；auto 则等探测结果来决定
                    if (picked && v !== "auto") setChannelType(picked.channelType)
                    // 换了格式，之前的探测结果与勾选都作废
                    setProbe(null)
                    setSelected([])
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AI_FORMATS.map((f) => (
                      <SelectItem key={f.value} value={f.value}>
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t("don.dlg.ai.formatHint")}
                </p>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void handleProbe()}
                  disabled={probing || busy}
                >
                  {probing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  {t("don.dlg.ai.detect")}
                </Button>
                {probe?.ok && (
                  <Badge variant="secondary">
                    {t("don.probe.result", { name: probe.channelTypeName, n: probe.models.length })}
                  </Badge>
                )}
              </div>

              {probe?.ok && !manual && (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label>
                      {t("don.dlg.ai.pickModels")}
                      <span className="ml-1 font-normal text-muted-foreground">
                        {t("don.dlg.ai.selected", { n: selected.length, max: maxModels })}
                      </span>
                    </Label>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={selectAll}
                      >
                        {t("don.dlg.ai.selectAll")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setSelected([])}
                      >
                        {t("don.dlg.ai.clear")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setManual(true)}
                      >
                        {t("don.dlg.ai.manual")}
                      </Button>
                    </div>
                  </div>
                  <Input
                    placeholder={t("don.dlg.ai.filterPh")}
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                  <div className="max-h-56 overflow-y-auto rounded-md border p-2">
                    {visibleModels.length === 0 ? (
                      <p className="py-3 text-center text-xs text-muted-foreground">
                        {t("don.dlg.ai.noMatch")}
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {visibleModels.map((m) => {
                          const on = selected.includes(m)
                          return (
                            <button
                              key={m}
                              type="button"
                              onClick={() => toggleModel(m)}
                              className={
                                "rounded-full border px-2.5 py-1 text-xs transition-colors " +
                                (on
                                  ? "border-primary bg-primary text-primary-foreground"
                                  : "border-border hover:bg-muted")
                              }
                            >
                              {m}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("don.dlg.ai.prefixA")}{" "}
                    <code>donation-{"{model}"}</code>{t("don.dlg.ai.prefixB")}
                    {t("don.dlg.ai.testNoteA")}<span className="text-foreground">{t("don.dlg.ai.testNoteB")}</span>{t("don.dlg.ai.testNoteC")}
                  </p>
                </div>
              )}

              {manual && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>{t("don.dlg.ai.modelNames")}</Label>
                    {probe?.ok && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setManual(false)}
                      >
                        {t("don.dlg.ai.backToList")}
                      </Button>
                    )}
                  </div>
                  <Textarea
                    rows={4}
                    className="font-mono text-xs"
                    placeholder={"gpt-4o\ndeepseek-chat"}
                    value={manualModels}
                    onChange={(e) => setManualModels(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("don.dlg.ai.manualHint")}
                  </p>
                </div>
              )}
            </>
          )}
          {type === "frp" && (
            <>
              <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                {t("don.frp.a")}<span className="text-foreground">{t("don.frp.bold")}</span>{t("don.frp.b")}
                {t("don.frp.c")}
                <span className="text-foreground">{t("don.frp.bold2")}</span>，
                {t("don.frp.d")}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>{t("don.frp.name")}</Label>
                  <Input
                    placeholder={t("don.frp.namePh")}
                    value={frpForm.nodeName}
                    onChange={(e) => setFrp("nodeName", e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>{t("don.frp.region")}</Label>
                  <Input
                    placeholder={t("don.frp.regionPh")}
                    value={frpForm.region}
                    onChange={(e) => setFrp("region", e.target.value)}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>{t("don.frp.addr")}</Label>
                  <Input
                    placeholder={t("don.frp.addrPh")}
                    value={frpForm.serverAddr}
                    onChange={(e) => setFrp("serverAddr", e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>{t("don.frp.port")}</Label>
                  <Input
                    placeholder="7000"
                    value={frpForm.serverPort}
                    onChange={(e) => setFrp("serverPort", e.target.value)}
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label>{t("don.frp.rangeFrom")}</Label>
                  <Input
                    placeholder="20000"
                    value={frpForm.portMin}
                    onChange={(e) => setFrp("portMin", e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>{t("don.frp.rangeTo")}</Label>
                  <Input
                    placeholder="50000"
                    value={frpForm.portMax}
                    onChange={(e) => setFrp("portMax", e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>{t("don.frp.maxPorts")}</Label>
                  <Input
                    placeholder="5"
                    value={frpForm.maxPorts}
                    onChange={(e) => setFrp("maxPorts", e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>{t("don.frp.authMode")}</Label>
                <Select
                  value={frpForm.authMode}
                  onValueChange={(v) => setFrp("authMode", v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t("don.frp.auth.none")}</SelectItem>
                    <SelectItem value="token">{t("don.frp.auth.token")}</SelectItem>
                    <SelectItem value="token_user">
                      {t("don.frp.auth.tokenUser")}
                    </SelectItem>
                    <SelectItem value="custom">{t("don.frp.auth.custom")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {(frpForm.authMode === "token" || frpForm.authMode === "token_user") && (
                <div className="space-y-1.5">
                  <Label>{t("don.frp.authToken")}</Label>
                  <Input
                    placeholder={t("don.frp.authTokenPh")}
                    value={frpForm.authToken}
                    onChange={(e) => setFrp("authToken", e.target.value)}
                  />
                </div>
              )}

              <div className="space-y-1.5">
                <Label>{t("don.frp.sample")}</Label>
                <Textarea
                  rows={10}
                  className="font-mono text-xs"
                  placeholder={
                    'serverAddr = "firef.cc.cd"\nserverPort = 7000\n\nauth.token = "..."\n\nuser = "..."\n[metadatas]\ntoken = "..."'
                  }
                  value={frpForm.configSample}
                  onChange={(e) => setFrp("configSample", e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t("don.frp.sampleHintA")}
                  <b>{t("don.frp.sampleHintB")}</b>
                  {t("don.frp.sampleHintC")}
                </p>
              </div>

              <div className="space-y-1.5">
                <Label>{t("don.remark")}</Label>
                <Input
                  placeholder={t("don.frp.remarkPh")}
                  value={frpForm.note}
                  onChange={(e) => setFrp("note", e.target.value)}
                />
              </div>
            </>
          )}
          {type === "proxy" && (
            <>
              <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                {t("don.proxy.a")}
                <span className="text-foreground">{t("don.proxy.bold1")}</span>
                {t("don.proxy.b")}
                <span className="text-foreground">{t("don.proxy.bold2")}</span>
                {t("don.proxy.c", { max: maxSubUrls })}
              </div>
              <div className="space-y-2">
                <Label>{t("don.proxy.urls")}</Label>
                <Textarea
                  rows={5}
                  placeholder="https://example.com/sub/abc"
                  value={subUrls}
                  onChange={(e) => setSubUrls(e.target.value)}
                  className="font-mono text-xs"
                />
                <p className="text-xs text-muted-foreground">
                  {t("don.proxy.hint")}
                </p>
              </div>
            </>
          )}
          <div className="space-y-2">
            <Label>{t("don.remark")}</Label>
            <Input placeholder={t("don.proxy.remarkPh")} value={remark} onChange={(e) => setRemark(e.target.value)} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>{t("common.cancel")}</Button>
          <Button onClick={() => void handleSubmit()} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {busy
              ? type === "ai"
                ? t("don.submit.testingModels")
                : type === "proxy"
                  ? t("don.submit.testingSubs")
                  : t("don.submit.busy")
              : type === "ai"
                ? t("don.submit.ai")
                : type === "proxy"
                  ? t("don.submit.proxy")
                  : t("don.submit.generic")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 兑换码卡片。
 *
 * ⚠️ 这里把**邀请码**和**兑换券**当成同一种东西展示（后端 `GET /api/vouchers`
 * 就把两者合成一个 `codes` 列表返回）：
 *   - 发给别人：新用户拿去注册，已在站的用户拿它补权限
 *   - 给自己用：同一个按钮，补上自己还没有的模块
 * 所以卡片里不再区分「邀请码」「兑换券」，统一叫「码」。
 */
function RedeemCard({ onChanged }: { onChanged: () => void }) {
  const { t } = useT()
  const [data, setData] = React.useState<VoucherOverview | null>(null)
  /** 兑换码区加载失败（原先完全静默，界面上会一片空白） */
  const [failed, setFailed] = React.useState(false)
  const [code, setCode] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [copied, setCopied] = React.useState<string | null>(null)
  /** 每张自选码各自选了哪个模块 */
  const [choice, setChoice] = React.useState<Record<string, string>>({})
  /**
   * 「用别人的码」那一行选的模块。
   *
   * 别人转送过来的**自选券**同样需要使用者挑一个模块 —— 后端 `redeemVoucher(…, wanted)`
   * 一直支持，缺的只是这里的入口。非自选券 / 邀请码不读这个值，随便选也不会有副作用。
   */
  const [manualFeature, setManualFeature] = React.useState("")
  /**
   * 别人转送来的**自选券**：拥有者还没挑模块就把码发出去了。
   * 后端会回 `FEATURE_REQUIRED`（「这是一张自选券，请先选择要开通的权限」），
   * 这时才把选模块的面板亮出来，让**收码的人**自己挑 ——
   * 之前这里只报错不给出路，等于这条码在别人手里死掉了（2026-09-30 站长反馈）。
   */
  const [needPick, setNeedPick] = React.useState<string | null>(null)
  const [pick, setPick] = React.useState("")

  const load = React.useCallback(async () => {
    try {
      setData(await voucherApi.list())
      setFailed(false)
    } catch {
      // 不再完全静默：否则码区一片空白，看不出是失败还是真的没有码
      setFailed(true)
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const labelOf = (key: string) =>
    data?.features.find((f) => f.key === key)?.label ?? key

  const doRedeem = async (raw: string, feature?: string) => {
    const c = raw.trim()
    if (!c) {
      toast.error(t("don.voucher.err.empty"))
      return
    }
    setBusy(true)
    try {
      const res = await voucherApi.redeem({ code: c, feature })
      toast.success(t("don.voucher.ok.granted", { list: res.granted.map(labelOf).join(", ") }))
      setCode("")
      setManualFeature("")
      setNeedPick(null)
      setPick("")
      await load()
      // 权限变了，让外层的捐献页重新拉一次（解锁状态会同步刷新）
      onChanged()
    } catch (err) {
      if (err instanceof HttpError && err.code === "FEATURE_REQUIRED") {
        // 拥有者没选就转送出来的自选券 —— 把选择权交给收码的人
        setNeedPick(c)
        setPick("")
        toast.info(t("don.voucher.info.selfSelect"))
      } else {
        toast.error(err instanceof HttpError ? err.message : t("ai.err.redeem"))
      }
    } finally {
      setBusy(false)
    }
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(text)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      toast.error(t("ai.err.copy"))
    }
  }

  const codes = data?.codes ?? []
  const available = (data?.features ?? []).filter((f) => !f.owned)

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="text-base">{t("don.voucher.title")}</CardTitle>
        <CardDescription>
          {t("don.voucher.descA")}
          <span className="text-foreground">{t("don.voucher.descBold1")}</span>
          {t("don.voucher.descB")}
          <span className="text-foreground">{t("don.voucher.descBold2")}</span>
          {t("don.voucher.descC")}
          {t("don.voucher.descC")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {failed && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
            <span>{t("don.voucher.loadFailed")}</span>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              {t("common.retry")}
            </Button>
          </div>
        )}
        {codes.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">{t("don.voucher.mine")}</p>
            {codes.map((c) => {
              // 自选码只有在「还有没开的模块」时才能自用；否则它是给别人准备的
              const selfSelectable = c.selfSelect && available.length > 0
              const hasFeatures = c.features.length > 0
              const canSelfUse = c.selfSelect ? selfSelectable : hasFeatures
              return (
                <div
                  key={c.id}
                  className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2"
                >
                  <span className="font-mono text-sm">{c.code}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground"
                    onClick={() => void copy(c.code)}
                    title={t("don.voucher.copy")}
                  >
                    {copied === c.code ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  {c.selfSelect ? (
                    <>
                      <Badge variant="secondary">{t("don.voucher.selfSelect")}</Badge>
                      {/*
                        ⚠️ 下拉**始终渲染**，哪怕一个可选的模块都没有。
                        2026-09-30 之前是 `available.length === 0` 就整块换掉、只留一句
                        灰字提示 —— 结果「四个模块全开」的账号进来只看到「你已开通全部模块」，
                        观感上完全像「这张券根本没有选权限的地方」（站长自己踩到了）。
                        现在改为：**已开通的模块也列出来**，标「已开通」并置灰 ——
                        「选权限的地方」永远在，也能一眼看出为什么选不了。
                      */}
                      <Select
                        value={choice[c.id] ?? ""}
                        onValueChange={(val) =>
                          setChoice((prev) => ({ ...prev, [c.id]: val }))
                        }
                        disabled={!selfSelectable}
                      >
                        <SelectTrigger className="h-8 w-44">
                          <SelectValue
                            placeholder={
                              selfSelectable ? t("don.voucher.pickModule") : t("don.voucher.allOwned")
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {(data?.features ?? []).map((f) => (
                            <SelectItem key={f.key} value={f.key} disabled={f.owned}>
                              {f.label}
                              {f.owned ? t("don.voucher.owned") : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {!selfSelectable && (
                        <span className="text-xs text-amber-600 dark:text-amber-400">
                          {t("don.voucher.allOwnedNote")}
                        </span>
                      )}
                    </>
                  ) : hasFeatures ? (
                    c.features.map((f) => (
                      <Badge key={f} variant="outline">
                        {labelOf(f)}
                      </Badge>
                    ))
                  ) : (
                    <Badge variant="outline">{t("don.voucher.registerOnly")}</Badge>
                  )}
                  {c.transferable && (
                    <span className="text-xs text-muted-foreground">{t("don.voucher.shareable")}</span>
                  )}
                  {canSelfUse && (
                    <Button
                      size="sm"
                      className="ml-auto"
                      disabled={busy || (c.selfSelect && !choice[c.id])}
                      onClick={() =>
                        void doRedeem(c.code, c.selfSelect ? choice[c.id] : undefined)
                      }
                    >
                      {t("don.voucher.useForSelf")}
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        )}

        <div className="space-y-2">
          <Label>{t("don.voucher.useOther")}</Label>
          <div className="flex flex-wrap gap-2">
            <Input
              className="min-w-0 flex-1 font-mono"
              placeholder={t("don.voucher.codePh")}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            {/*
              模块下拉**常驻**（不限于自己持有的码）：
              别人转送过来的「自选权限券」需要由**使用者**挑模块，
              而兑换前前端无从知道手里这串码是不是自选券（用户自定的邀请码
              也可能以 VX- 开头），所以不能靠前缀猜、更不能等报错再出现。
            */}
            <Select value={manualFeature} onValueChange={setManualFeature}>
              <SelectTrigger className="h-9 w-44 shrink-0">
                <SelectValue placeholder={t("don.voucher.selfSelectPh")} />
              </SelectTrigger>
              <SelectContent>
                {(data?.features ?? []).map((f) => (
                  <SelectItem key={f.key} value={f.key} disabled={f.owned}>
                    {f.label}
                    {f.owned ? t("don.voucher.owned") : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              className="shrink-0"
              onClick={() => void doRedeem(code, manualFeature || undefined)}
              disabled={busy || !code.trim()}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t("ai.redeem.btn")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("don.voucher.hint")}
          </p>
        </div>

        {needPick && (
          <div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium">
                {t("don.voucher.needPickA")}<span className="font-mono">{needPick}</span>{t("don.voucher.needPickB")}
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setNeedPick(null)}
                disabled={busy}
              >
                {t("common.cancel")}
              </Button>
            </div>
            <div className="flex gap-2">
              <Select value={pick} onValueChange={setPick}>
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder={t("don.voucher.pickModulePh")} />
                </SelectTrigger>
                <SelectContent>
                  {available.map((f) => (
                    <SelectItem key={f.key} value={f.key}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button onClick={() => void doRedeem(needPick, pick)} disabled={busy || !pick}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {t("don.voucher.confirm")}
              </Button>
            </div>
            {available.length === 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {t("don.voucher.allOwnedNote2")}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * 商汤 Key 捐献卡（免审核通道）。
 *
 * 与反代账号卡同一语义：**校验通过即解锁 ai 权限，不等管理员审核**。
 * 但捐的东西完全不同 —— 反代账号是「把账号交给共享池」（有封号风险，
 * 必须强制勾选确认），商汤 Key 是「把你的 API Key 给站点用来建上游渠道」，
 * 风险是「Key 会被站点用于所有用户的调用」（额度被消耗），不是封号。
 *
 * 上游地址由管理面板配置、**用户不能自带** —— 所以这张卡只需要一个 Key 输入框，
 * 也正因为地址固定，才能保证「提交的 Key 确实属于商汤」。
 */
function SenseNovaDonationCard({
  block,
  aiUnlocked,
  onDone,
}: {
  block: SenseNovaDonationBlock | undefined
  aiUnlocked: boolean
  onDone: () => void
}) {
  const { t } = useT()
  const [apiKey, setApiKey] = React.useState("")
  const [acknowledged, setAcknowledged] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  // 通道未开启 → 整卡隐藏（避免用户点进去才发现不可用）
  if (!block || !block.enabled) return null

  // 管理员撤下了捐献入口（display-only 开关，与「开启捐献通道」区分）
  if (!block.visible) return null

  const submit = async () => {
    if (!apiKey.trim()) {
      toast.error(t("don.sn.err.empty"))
      return
    }
    setBusy(true)
    try {
      const res = await donationApi.create({
        type: "sensenova",
        payload: { apiKey: apiKey.trim() },
      })

      // 提交成功 ≠ 校验通过：这条通道是「提交即自动校验」，结论在 res.status 里。
      // 之前这里无条件弹「校验通过」，Key 明明是错的也报成功（用户实测反馈），
      // 所以必须按 status 分三种情况给文案。
      if (res.status === "approved") {
        toast.success(t("don.sn.ok.verified"), {
          description: res.reviewNote ?? undefined,
          duration: 10000,
        })
        setApiKey("")
        setAcknowledged(false)
      } else if (res.status === "rejected") {
        toast.error(t("don.sn.err.failed"), {
          // 后端把「为什么没通过」写在这里（Key 无效 / 目标渠道不是多密钥渠道…），
          // 原样给用户看，别用一句「提交失败」盖掉
          description: res.reviewNote ?? undefined,
          duration: 10000,
        })
        // 不清空输入框：用户多半是粘错了，让他直接在原值上改
      } else {
        toast.success(t("don.sn.ok.pending"), {
          description: res.reviewNote ?? undefined,
          duration: 10000,
        })
        setApiKey("")
        setAcknowledged(false)
      }
      onDone()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("frp.err.submit"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          {t("don.type.sensenova")}
          {aiUnlocked ? (
            <Badge variant="success">{t("don.sn.badge")}</Badge>
          ) : (
            <Badge variant="secondary">{t("don.locked")}</Badge>
          )}
        </CardTitle>
        <CardDescription>
          {t("don.sn.desc")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border border-dashed px-4 py-3 text-xs text-muted-foreground">
          {t("don.sn.noteA")}
          <span className="text-foreground">{t("don.sn.noteBold")}</span>
          {t("don.sn.noteB")}
          <a
            href={block.consoleUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="ml-1 inline-flex items-center gap-0.5 text-foreground underline underline-offset-2"
          >
            {t("don.sn.goConsole")}
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>

        <div className="space-y-2">
          <Label htmlFor="sensenovaKey">{t("don.sn.keyLabel")}</Label>
          <Input
            id="sensenovaKey"
            type="password"
            autoComplete="off"
            placeholder={t("don.sn.keyPh")}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {t("don.sn.shareNote")}
          </p>
        </div>

        <label className="flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span>
            {t("don.sn.consent")}
          </span>
        </label>

        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={busy || !acknowledged || !apiKey.trim()}
            onClick={() => void submit()}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            <Plus className="h-4 w-4" />
            {t("don.sn.submit")}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * WorkBuddy 反代账号捐献卡（免审核通道）。
 *
 * 与上面三张「提交 → 管理员审核」的卡不同：这里登录成功即自动解锁 ai 权限，
 * 不需要人工审核。因此**必须让用户清楚自己在捐什么** —— 账号会进共享池被
 * 其他用户使用、会被自动化任务使用，且有封号风险，故做成强制勾选。
 */
function Wb2ApiDonationCard({
  block,
  aiUnlocked,
  onDone,
}: {
  block: Wb2ApiDonationBlock | undefined
  aiUnlocked: boolean
  onDone: () => void
}) {
  const { t } = useT()
  const [acknowledged, setAcknowledged] = React.useState(false)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  /**
   * 用户自选的上游域（2026-09-30：站长要求捐献者自己挑国内版 / 国际版）。
   * 初值 null = 还没动过 → 用管理员设的默认（block.realm）。
   * 不能直接 useState(block.realm)：这里在 null 检查之前，block 可能还没到。
   */
  const [realmChoice, setRealmChoice] = React.useState<"cn" | "global" | null>(null)

  // 通道未开启或未配置 → 整卡隐藏（避免用户点进去才发现不可用）
  if (!block || !block.enabled || !block.configured) return null

  // 管理员撤下了捐献入口（display-only 开关）：只对**还没绑定过**的用户隐藏。
  // 已经绑定过的人仍看得到卡片 —— 否则就没法在这里撤销自己的绑定了。
  if (!block.visible && block.bindings.length === 0) return null

  const full = block.remaining < 1
  const realm: "cn" | "global" =
    realmChoice ?? (block.realm === "global" ? "global" : "cn")
  const realmLabel = realm === "global" ? tStatic("don.realm.global") : tStatic("don.realm.cn")

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Unplug className="h-4 w-4 text-muted-foreground" />
          {t("don.proxyAccount.title")}
          {aiUnlocked ? (
            <Badge variant="success">{t("don.sn.badge")}</Badge>
          ) : (
            <Badge variant="secondary">{t("don.locked")}</Badge>
          )}
        </CardTitle>
        <CardDescription>
          {t("don.wb.desc", { realm: realmLabel })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3">
          <p className="flex items-start gap-2 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <span>
              <span className="font-medium">{t("don.risk.title")}</span>
              {t("don.risk.a")}<span className="font-medium">{t("don.risk.bold1")}</span>{t("don.risk.b")}<span className="font-medium">{t("don.risk.bold2")}</span>{t("don.risk.c")}<span className="font-medium">{t("don.risk.bold3")}</span>{t("don.risk.d")}
            </span>
          </p>
        </div>

        {block.bindings.length > 0 && (
          <div className="divide-y rounded-md border">
            {block.bindings.map((b) => (
              <div key={b.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                <span className="text-sm font-medium">
                  {b.nickname || b.uid}
                </span>
                <Badge variant={b.status === "active" ? "success" : "secondary"}>
                  {b.status === "active" ? t("don.binding.active") : t("don.binding.removed")}
                </Badge>
                <span className="ml-auto text-xs text-muted-foreground">
                  {fmtTime(b.createdAt)}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* 版本选择：捐献者自己挑对接哪个域。选错会授权失败，所以给一句明确提示 */}
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">{t("don.wb.realmLabel")}</Label>
          <div className="flex gap-2">
            {(["cn", "global"] as const).map((r) => (
              <Button
                key={r}
                type="button"
                size="sm"
                variant={realm === r ? "default" : "outline"}
                onClick={() => setRealmChoice(r)}
              >
                {r === "cn" ? t("don.realm.cn") : t("don.realm.global")}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {t("don.wb.realmHint")}
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {t("don.binding.count", { used: block.used, limit: block.limit })}
            {full && t("don.binding.full")}
          </p>
          <Button
            size="sm"
            disabled={full || !acknowledged}
            onClick={() => setDialogOpen(true)}
          >
            <Plus className="h-4 w-4" />
            {t("don.binding.login")}
          </Button>
        </div>

        <label className="flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span>
            {t("don.binding.consent")}
          </span>
        </label>
      </CardContent>

      {dialogOpen && (
        <Wb2ApiLoginDialog
          realm={realm}
          onClose={() => setDialogOpen(false)}
          onDone={() => {
            setDialogOpen(false)
            setAcknowledged(false)
            onDone()
          }}
        />
      )}
    </Card>
  )
}

/** 登录弹窗：展示授权链接 + 轮询状态 */
function Wb2ApiLoginDialog({
  onClose,
  onDone,
  realm,
}: {
  onClose: () => void
  onDone: () => void
  /** 捐献者选的版本，直接透给服务端决定对接哪个域 */
  realm: "cn" | "global"
}) {
  const { t } = useT()
  const [url, setUrl] = React.useState<string | null>(null)
  const [sessionId, setSessionId] = React.useState<string | null>(null)
  const [phase, setPhase] = React.useState<"starting" | "waiting" | "done" | "failed">(
    "starting"
  )
  const [message, setMessage] = React.useState("")
  const [copied, setCopied] = React.useState(false)
  const timerRef = React.useRef<number | null>(null)

  // 发起登录（挂载即调一次）。realm 是捐献者在卡片上选的版本，随请求发给服务端。
  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await wb2apiApi.loginStart(realm)
        if (cancelled) return
        setUrl(res.url)
        setSessionId(res.sessionId)
        setPhase("waiting")
      } catch (err) {
        if (cancelled) return
        setPhase("failed")
        setMessage(err instanceof HttpError ? err.message : t("don.binding.err.start"))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [realm])

  // 轮询（3 秒一次，与网关面板同节奏）
  //
  // 必须**串行**：单次 poll 在「登录刚完成」那一次要等网关跑完落盘 + 热加载 +
  // 签到 + 余额刷新（本站给了 30 秒超时）。若用 setInterval，这 3 秒一轮的请求会
  // 叠成十几个并发，既打爆轮询限流、又让多个请求同时写同一行会话状态。
  // 故改成「上一次结束再排下一次」。
  React.useEffect(() => {
    if (phase !== "waiting" || !sessionId) return
    let stopped = false

    const tick = async () => {
      try {
        const res = await wb2apiApi.loginPoll(sessionId)
        if (stopped) return
        if (res.status === "done") {
          stopped = true
          setPhase("done")
          const r = res.result
          setMessage(
            t("don.binding.done", { name: r?.nickname || r?.uid || "" }) +
              (r?.alreadyBound
                ? t("don.binding.already")
                : r?.aiGranted
                  ? t("don.binding.granted")
                  : t("don.binding.grantedBefore"))
          )
          return
        }
        if (res.status === "failed") {
          stopped = true
          setPhase("failed")
          setMessage(res.message || t("don.binding.err.login"))
          return
        }
      } catch (err) {
        if (stopped) return
        stopped = true
        setPhase("failed")
        setMessage(err instanceof HttpError ? err.message : t("don.binding.err.poll"))
        return
      }
      if (!stopped) {
        timerRef.current = window.setTimeout(() => void tick(), 3000)
      }
    }

    void tick()
    return () => {
      stopped = true
      if (timerRef.current) window.clearTimeout(timerRef.current)
    }
  }, [phase, sessionId])

  const copyUrl = async () => {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error(t("ai.err.copy"))
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("don.wb.dlgTitle", { realm: realm === "global" ? t("don.realm.global") : t("don.realm.cn") })}</DialogTitle>
          <DialogDescription>
            {t("don.binding.dlgDesc")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {phase === "starting" && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("don.binding.generating")}
            </p>
          )}

          {url && (
            <>
              <div className="space-y-2">
                <Label>{t("don.binding.authLink")}</Label>
                <div className="flex gap-2">
                  <Input readOnly value={url} className="font-mono text-xs" />
                  <Button variant="outline" size="icon" onClick={() => void copyUrl()}>
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => window.open(url, "_blank", "noopener")}
                    aria-label={t("don.binding.openLink")}
                  >
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {phase === "waiting" && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("don.binding.waiting")}
                </p>
              )}
            </>
          )}

          {phase === "done" && (
            <p className="flex items-start gap-2 text-sm text-emerald-600 dark:text-emerald-400">
              <Check className="mt-0.5 h-4 w-4 shrink-0" />
              {message}
            </p>
          )}

          {phase === "failed" && (
            <p className="flex items-start gap-2 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {message}
            </p>
          )}
        </div>

        <DialogFooter>
          {phase === "done" ? (
            <Button onClick={onDone}>{t("common.done")}</Button>
          ) : (
            <Button variant="outline" onClick={onClose}>
              {phase === "failed" ? t("common.close") : t("common.cancel")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** CLI2API 反代账号捐献卡（第二条，与 Wb2ApiDonationCard 并列） */
function Cli2ApiDonationCard({
  block,
  aiUnlocked,
  onDone,
}: {
  block: Cli2ApiDonationBlock | undefined
  aiUnlocked: boolean
  onDone: () => void
}) {
  const { t } = useT()
  const [acknowledged, setAcknowledged] = React.useState(false)
  const [dialogOpen, setDialogOpen] = React.useState(false)

  if (!block || !block.enabled || !block.configured) return null

  // 同 Wb2ApiDonationCard：display-only 开关只对「还没绑定过」的用户隐藏
  if (!block.visible && block.bindings.length === 0) return null

  const full = block.remaining < 1
  const providerLabel =
    block.provider === "qoder"
      ? "Qoder"
      : block.provider === "workbuddy"
        ? "WorkBuddy"
        : block.provider === "trae"
          ? "Trae"
          : block.provider

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Unplug className="h-4 w-4 text-muted-foreground" />
          {t("don.provider.title", { provider: providerLabel })}
          {aiUnlocked ? (
            <Badge variant="success">{t("don.sn.badge")}</Badge>
          ) : (
            <Badge variant="secondary">{t("don.locked")}</Badge>
          )}
        </CardTitle>
        <CardDescription>
          {t("don.cli.desc", { provider: providerLabel, realm: block.region === "global" ? t("don.realm.global") : t("don.realm.cn") })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3">
          <p className="flex items-start gap-2 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <span>
              <span className="font-medium">{t("don.risk.title")}</span>
              {t("don.risk.a")}<span className="font-medium">{t("don.risk.bold1")}</span>{t("don.risk.b")}
              {t("don.risk.bold2pre")}<span className="font-medium">{t("don.risk.bold2")}</span>{t("don.risk.bold2post")}
              {t("don.risk.c")}<span className="font-medium">{t("don.risk.bold3cli", { provider: providerLabel })}</span>{t("don.risk.d")}
            </span>
          </p>
        </div>

        {block.bindings.length > 0 && (
          <div className="divide-y rounded-md border">
            {block.bindings.map((b) => (
              <div key={b.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                <span className="text-sm font-medium">
                  {b.nickname || b.accountId}
                </span>
                <Badge variant={b.status === "active" ? "success" : "secondary"}>
                  {b.status === "active" ? t("don.binding.active") : t("don.binding.removed")}
                </Badge>
                <span className="ml-auto text-xs text-muted-foreground">
                  {fmtTime(b.createdAt)}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {t("don.binding.count", { used: block.used, limit: block.limit })}
            {full && t("don.binding.full")}
          </p>
          <Button
            size="sm"
            disabled={full || !acknowledged}
            onClick={() => setDialogOpen(true)}
          >
            <Plus className="h-4 w-4" />
            {t("don.binding.login")}
          </Button>
        </div>

        <label className="flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span>
            {t("don.binding.consent")}
          </span>
        </label>
      </CardContent>

      {dialogOpen && (
        <Cli2ApiLoginDialog
          providerLabel={providerLabel}
          region={block.region}
          onClose={() => setDialogOpen(false)}
          onDone={() => {
            setDialogOpen(false)
            setAcknowledged(false)
            onDone()
          }}
        />
      )}
    </Card>
  )
}

/** CLI2API 登录弹窗：首次 poll 拿授权链接，之后轮询登录状态 */
function Cli2ApiLoginDialog({
  onClose,
  onDone,
  providerLabel,
  region,
}: {
  onClose: () => void
  onDone: () => void
  providerLabel: string
  region: string
}) {
  const { t } = useT()
  const [url, setUrl] = React.useState<string | null>(null)
  const [sessionId, setSessionId] = React.useState<string | null>(null)
  const [phase, setPhase] = React.useState<"starting" | "waiting" | "done" | "failed">(
    "starting"
  )
  const [message, setMessage] = React.useState("")
  const [copied, setCopied] = React.useState(false)
  const timerRef = React.useRef<number | null>(null)

  // 发起登录（挂载即调一次）。cli2api 的 start 只建账号，秒回。
  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await cli2apiApi.loginStart()
        if (cancelled) return
        setSessionId(res.sessionId)
        setPhase("waiting")
      } catch (err) {
        if (cancelled) return
        setPhase("failed")
        setMessage(err instanceof HttpError ? err.message : t("don.binding.err.start"))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 轮询（串行）：第一次 poll 会向上游取授权链接（worker 可能还没起，返回 pending 继续轮）
  React.useEffect(() => {
    if (phase !== "waiting" || !sessionId) return
    let stopped = false

    const tick = async () => {
      try {
        const res = await cli2apiApi.loginPoll(sessionId)
        if (stopped) return
        if (res.authUrl) setUrl(res.authUrl)
        if (res.status === "done") {
          stopped = true
          setPhase("done")
          const r = res.result
          setMessage(
            t("don.binding.doneProvider", { provider: providerLabel }) +
              (r?.alreadyBound
                ? t("don.binding.already")
                : r?.aiGranted
                  ? t("don.binding.granted")
                  : t("don.binding.grantedBefore"))
          )
          return
        }
        if (res.status === "failed") {
          stopped = true
          setPhase("failed")
          setMessage(res.message || t("don.binding.err.login"))
          return
        }
        // pending：更新提示语
        if (res.message) setMessage(res.message)
      } catch (err) {
        if (stopped) return
        stopped = true
        setPhase("failed")
        setMessage(err instanceof HttpError ? err.message : t("don.binding.err.poll"))
        return
      }
      if (!stopped) {
        timerRef.current = window.setTimeout(() => void tick(), 3000)
      }
    }

    void tick()
    return () => {
      stopped = true
      if (timerRef.current) window.clearTimeout(timerRef.current)
    }
  }, [phase, sessionId, providerLabel])

  const copyUrl = async () => {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error(t("ai.err.copy"))
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {t("don.cli.dlgTitle", { provider: providerLabel, realm: region === "global" ? t("don.realm.global") : t("don.realm.cn") })}
          </DialogTitle>
          <DialogDescription>
            {t("don.binding.dlgDesc")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {phase === "starting" && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("don.cli.creating")}
            </p>
          )}

          {url && (
            <>
              <div className="space-y-2">
                <Label>{t("don.binding.authLink")}</Label>
                <div className="flex gap-2">
                  <Input readOnly value={url} className="font-mono text-xs" />
                  <Button variant="outline" size="icon" onClick={() => void copyUrl()}>
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => window.open(url, "_blank", "noopener")}
                    aria-label={t("don.binding.openLink")}
                  >
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {phase === "waiting" && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {message || t("don.binding.waiting")}
                </p>
              )}
            </>
          )}

          {!url && phase === "waiting" && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {message || t("don.cli.starting")}
            </p>
          )}

          {phase === "done" && (
            <p className="flex items-start gap-2 text-sm text-emerald-600 dark:text-emerald-400">
              <Check className="mt-0.5 h-4 w-4 shrink-0" />
              {message}
            </p>
          )}

          {phase === "failed" && (
            <p className="flex items-start gap-2 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {message}
            </p>
          )}
        </div>

        <DialogFooter>
          {phase === "done" ? (
            <Button onClick={onDone}>{t("common.done")}</Button>
          ) : (
            <Button variant="outline" onClick={onClose}>
              {phase === "failed" ? t("common.close") : t("common.cancel")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}