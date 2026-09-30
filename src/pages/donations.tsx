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
  ai: { label: "AI 模型", desc: "贡献一个模型渠道，让其他用户也能用" },
  frp: { label: "内网穿透", desc: "提供完整可用的 config.yml" },
  proxy: { label: "代理节点", desc: "贡献你的代理订阅链接" },
  sensenova: { label: "商汤 Key", desc: "贡献一个商汤日日新 API Key" },
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
  { value: "auto", label: "自动识别（推荐）", channelType: 1 },
  { value: "openai", label: "OpenAI 兼容（/v1/chat/completions）", channelType: 1 },
  { value: "anthropic", label: "Anthropic 原生（/v1/messages）", channelType: 14 },
]

export default function DonationPage() {
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
      toast.error(err instanceof HttpError ? err.message : "加载失败")
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
      toast.success("邀请码已创建")
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
      toast.error(err instanceof HttpError ? err.message : "创建失败")
    } finally {
      setInviteBusy(false)
    }
  }

  const handleDeleteInvite = async (inv: MyInvite) => {
    try {
      const res = await myInviteApi.remove(inv.id)
      toast.success(res.refunded ? "已删除，额度已退还" : "已删除（该码已被使用，额度不退还）")
      await loadInvites()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "删除失败")
    }
  }

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code)
      setCopiedCode(code)
      setTimeout(() => setCopiedCode(null), 1500)
    } catch {
      toast.error("复制失败，请手动复制")
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
      toast.success("邀请链接已复制，发给好友即可")
    } catch {
      toast.error("复制失败，请手动复制")
    }
  }

  /**
   * 开放注册期间手上没有可用码时的兜底：直接分享注册页 —— 那时注册本就不需要码。
   */
  const copyRegisterLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/register`)
      toast.success("当前限时开放注册，已复制注册页链接（无需邀请码）")
    } catch {
      toast.error("复制失败，请手动复制")
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
      toast.error("邀请码额度已用完，捐献资源可增加额度")
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
          title="捐献记录加载失败"
          description="网络或服务异常，请稍后重试。"
          action={
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RotateCw className="h-4 w-4" /> 重试
            </Button>
          }
        />
      )
    }
    if (rows.length === 0) {
      return (
        <EmptyState
          icon={Heart}
          title="还没有捐献记录"
          description="贡献资源后，记录会显示在这里。"
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
                  ? "已通过"
                  : d.status === "pending"
                    ? "待审核"
                    : d.status === "revoked"
                      ? "已失效"
                      : "未通过"}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-2">
              {d.autoReviewed && (
                <Badge variant="outline">
                  {d.status === "approved"
                    ? "系统自动校验通过"
                    : d.status === "revoked"
                      ? "系统巡检发现已失效"
                      : "系统自动校验未通过"}
                </Badge>
              )}
              {d.status === "approved" && d.channelId !== null && d.channelId !== undefined && (
                <p className="text-xs text-muted-foreground">
                  已接入中转站渠道 #{d.channelId}
                </p>
              )}
              {d.remark && <p className="text-sm text-muted-foreground">备注：{d.remark}</p>}
              {d.reviewNote && (
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                  审核回复：{d.reviewNote}
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
    )
  }

  /** 某个资源分区的「贡献」按钮 + 说明（三个分区共用同一套版式） */
  const renderResourceIntro = (type: string) => (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {TYPE_META[type]?.label}
          {perms?.[type as keyof Permissions] ? (
            <Badge variant="success">已解锁</Badge>
          ) : (
            <Badge variant="secondary">未解锁</Badge>
          )}
        </CardTitle>
        <CardDescription>
          {TYPE_META[type]?.desc}。提交后系统会自动校验，
          通过即解锁对应功能权限；未能自动校验的会转人工复核。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button size="sm" onClick={() => setDialogType(type)}>
          <Plus className="h-4 w-4" />
          贡献{TYPE_META[type]?.label ?? ""}
        </Button>
      </CardContent>
    </Card>
  )

  return (
    <div>
      <PageHeader title="捐献与邀请" description="贡献资源解锁功能，邀请好友获得奖励" />

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <div className="flex flex-col gap-6 lg:flex-row">
          {/* 左侧二级导航：与 admin 面板同一套交互（受控 state，不改 URL 路由） */}
          <aside className="w-full shrink-0 lg:w-48">
            <Link
              to="/dashboard"
              className="mb-3 inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              返回控制台
            </Link>
            <nav className="flex flex-col gap-0.5">
              <NavItem
                active={activeTab === "overview"}
                icon={LayoutDashboard}
                label="概览"
                onClick={() => setActiveTab("overview")}
              />
              <NavItem
                active={activeTab === "invite"}
                icon={Ticket}
                label="邀请"
                onClick={() => setActiveTab("invite")}
              />
              <NavGroup label="捐献资源">
                <NavItem
                  active={activeTab === "ai"}
                  icon={Sparkles}
                  label="AI 模型"
                  onClick={() => setActiveTab("ai")}
                />
                <NavItem
                  active={activeTab === "frp"}
                  icon={Network}
                  label="内网穿透"
                  onClick={() => setActiveTab("frp")}
                />
                <NavItem
                  active={activeTab === "proxy"}
                  icon={Zap}
                  label="代理节点"
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
                    资源有限，按需开放
                  </CardTitle>
                  <CardDescription>
                    站长资源有限，部分功能不会全量开放。如果你愿意贡献以下资源，
                    管理员审核通过后将为你解锁对应功能权限。
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                    你的
                    <span className="text-foreground">首次捐献成功</span>
                    会额外赠送一张「自选权限」兑换码 —— 可以自己拿来开通任意一个还没开的模块，
                    也可以送给别人。
                  </div>
                  {allTypes.length === 0 ? (
                    <p className="text-sm text-muted-foreground">加载中…</p>
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
                              <Badge variant="success">已解锁</Badge>
                            ) : (
                              <Badge variant="secondary">未解锁</Badge>
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
                          贡献
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
                    <p className="text-sm font-medium">邀请好友</p>
                    <p className="text-xs text-muted-foreground">
                      创建邀请码、查看邀请奖励，请前往「邀请」分区。
                    </p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setActiveTab("invite")}>
                    前往邀请
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
                    邀请好友，获得奖励
                  </CardTitle>
                  <CardDescription>
                    好友用你的邀请码注册，并通过贡献 workbuddy 账户解锁 AI 中转站权限后，
                    你将获得一张「wb邀请套餐」订阅（每天额外 ¥500 额度）。
                    好友通过贡献 其他AI渠道 解锁 AI 中转站权限后，
                    你将获得一张「邀请套餐」订阅（每天额外 ¥200 额度）。
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
                        我的邀请码
                      </CardTitle>
                      <CardDescription>
                        每人默认 {invites?.quota.inviteBase ?? 3} 个额度；
                        每笔捐献获批再 +2 个额度，并获得 1 个对应模块的权限额度。
                        点「邀请链接」可一键拿到一条注册链接，好友打开后邀请码会自动填好。
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
                        title="复制一条可直接发给好友的注册链接"
                      >
                        <Link2 className="h-4 w-4" />
                        邀请链接
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => setInviteOpen(true)}
                        disabled={(invites?.quota.inviteRemaining ?? 0) < 1}
                      >
                        <Plus className="h-4 w-4" />
                        创建
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {invitesFailed && (
                    <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
                      <span>邀请额度加载失败，下方数字与列表可能不准确。</span>
                      <Button variant="outline" size="sm" onClick={() => void loadInvites()}>
                        重试
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
                            当前处于
                            <span className="font-medium text-foreground">
                              「限时开放注册」
                            </span>
                            ：不含权限的邀请码
                            <span className="font-medium text-foreground">
                              不消耗次数
                            </span>
                            ，可以无限次分享给不同的人；带权限的邀请码仍是一次性的。
                            这段时间好友直接打开注册页也能注册。
                          </p>
                        </div>
                      )}
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="rounded-md border px-4 py-3">
                          <p className="text-xs text-muted-foreground">邀请码额度</p>
                          <p className="mt-1 text-lg font-semibold">
                            {invites.quota.inviteRemaining}
                            <span className="ml-1 text-sm font-normal text-muted-foreground">
                              / {invites.quota.inviteTotal}
                            </span>
                          </p>
                          <p className="text-xs text-muted-foreground">
                            基础 {invites.quota.inviteBase} + 捐献 {invites.quota.inviteBonus}
                          </p>
                        </div>
                        <div className="rounded-md border px-4 py-3">
                          <p className="text-xs text-muted-foreground">模块权限额度（可转授）</p>
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
                                      基础
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
                            基础权限模块人人可授，不消耗额度；受限模块勾选时会消耗对应额度
                          </p>
                        </div>
                      </div>

                      {invites.invites.length === 0 ? (
                        <p className="py-2 text-sm text-muted-foreground">
                          还没有创建过邀请码。
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
                                  title="复制邀请码"
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
                                    title="复制邀请链接（好友打开自动填码）"
                                  >
                                    {copiedLink === inv.code ? (
                                      <Check className="h-3.5 w-3.5" />
                                    ) : (
                                      <Link2 className="h-3.5 w-3.5" />
                                    )}
                                    邀请链接
                                  </Button>
                                )}
                                <Badge variant="outline">域名 · 邮箱 · 名片</Badge>
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
                                      ? '这个邀请码已经被用掉了，发给别人也注册不了'
                                      : unlimited
                                        ? '开放注册期间不限次数：发给几个人都不会消耗'
                                        : '还可用：分享给好友注册'
                                  }
                                >
                                  {used
                                    ? '已使用 · 链接失效'
                                    : unlimited
                                      ? '未使用 · 开放期不限次'
                                      : '未使用'}
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
                                    inv.usedCount > 0 ? '删除（额度不退还）' : '删除并退还额度'
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
                    邀请奖励记录
                  </CardTitle>
                  <CardDescription>
                    好友解锁 AI 权限后，这里会记录你获得的邀请订阅奖励。
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {!invites?.rewards || invites.rewards.length === 0 ? (
                    <p className="py-2 text-sm text-muted-foreground">
                      还没有好友完成有效邀请。
                    </p>
                  ) : (
                    <div className="divide-y rounded-md border">
                      {invites.rewards.map((r, i) => (
                        <div
                          key={i}
                          className="flex flex-wrap items-center gap-2 px-4 py-2.5"
                        >
                          <Badge variant="success">+¥200/天</Badge>
                          <span className="text-sm">邀请了好友</span>
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
            <DialogTitle>创建邀请码</DialogTitle>
            <DialogDescription>
              基础权限含域名、邮箱、个人名片，以及标记为「基础」的模块（不消耗额度）。
              勾选受限模块会消耗对应额度。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="invCode">邀请码（留空自动生成）</Label>
              <Input
                id="invCode"
                placeholder="DC-XXXX-XXXX"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                className="font-mono"
              />
            </div>
            <div className="space-y-2">
              <Label>附加模块权限</Label>
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
                      <Badge variant="outline">基础权限</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        剩余 {remain}
                      </span>
                    )}
                  </label>
                )
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              本次将消耗 1 个邀请码额度
              {inviteFeatures.length > 0 &&
                `，以及 ${
                  inviteFeatures.filter(
                    (f) => !(invites?.basicFeatures?.includes(f) ?? false)
                  ).length
                } 个受限模块额度`}
              。当前剩余 {invites?.quota.inviteRemaining ?? 0} 个邀请码额度。
            </p>
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
      toast.error("请先填写 Base URL 和 API Key")
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
          `识别为「${res.channelTypeName}」，共 ${res.models.length} 个模型`
        )
      } else {
        setManual(true)
        toast.error(res.message)
      }
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "探测失败")
    } finally {
      setProbing(false)
    }
  }

  const toggleModel = (m: string) => {
    setSelected((prev) => {
      if (prev.includes(m)) return prev.filter((x) => x !== m)
      if (prev.length >= maxModels) {
        toast.info(`一次最多选 ${maxModels} 个模型（每个都要真实调用一次验证可用性）`)
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
      toast.info(`共 ${all.length} 个模型，一次最多捐 ${maxModels} 个，已为你选上前 ${maxModels} 个`)
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
          toast.error("请填写 Base URL 和 API Key")
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
          toast.error(manual ? "请填写至少一个模型名" : "请至少选择一个要捐献的模型")
          setBusy(false)
          return
        }
        if (models.length > maxModels) {
          toast.error(`一次最多捐献 ${maxModels} 个模型（当前 ${models.length} 个）`)
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
          toast.error("请填写服务端地址，并粘贴一份能连上它的 frpc.toml 示例")
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
          toast.error("请填写至少一个订阅链接")
          setBusy(false)
          return
        }
        if (urls.length > maxSubUrls) {
          toast.error(`一次最多提交 ${maxSubUrls} 个订阅链接（当前 ${urls.length} 个）`)
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
            ? "校验通过，渠道已接入中转站，AI 权限已解锁"
            : type === "proxy"
              ? "校验通过，订阅已接入节点池，代理节点权限已解锁"
              : "已自动通过审核，对应功能权限已解锁"
        toast.success(okMsg, {
          description:
            [
              res.reviewNote,
              res.voucherCode
                ? `首次捐献奖励：自选权限兑换码 ${res.voucherCode}，可在下方「兑换码」里使用。`
                : "",
            ]
              .filter(Boolean)
              .join("\n") || undefined,
          duration: 12000,
        })
      } else if (res.status === "rejected") {
        toast.error("未通过自动校验", {
          // 后端会把「哪个模型为什么没通过」写在这里，原样给用户看
          description: res.reviewNote ?? "已转人工复核，管理员会跟进",
          duration: 10000,
        })
      } else {
        toast.success("捐献申请已提交，请等待管理员审核", {
          description: res.reviewNote ?? undefined,
        })
      }
      onSubmitted()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "提交失败")
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
          <DialogTitle>捐献 · {meta?.label}</DialogTitle>
          <DialogDescription>{meta?.desc}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {type === "ai" && (
            <>
              <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                提交后系统会把渠道接入中转站，并
                <span className="text-foreground">逐个模型真实调用一次</span>
                验证可用性：只保留可用的（最多 {maxModels} 个），
                <span className="text-foreground">通过即当场解锁 AI 权限</span>
                ；全部不可用则拒绝并写明原因。逐个测试需要几秒到几十秒，请耐心等待。
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
                  填到域名即可，末尾的 <code>/v1</code> 会自动去掉。
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
                <Label>接口格式</Label>
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
                  读不到模型列表时先换一种格式再检测 —— 有的上游只实现了 Anthropic 原生接口，
                  用 OpenAI 格式去调必然失败。
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
                  自动检测并获取模型
                </Button>
                {probe?.ok && (
                  <Badge variant="secondary">
                    {probe.channelTypeName} · {probe.models.length} 个模型
                  </Badge>
                )}
              </div>

              {probe?.ok && !manual && (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label>
                      选择要捐献的模型
                      <span className="ml-1 font-normal text-muted-foreground">
                        （已选 {selected.length} / {maxModels}）
                      </span>
                    </Label>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={selectAll}
                      >
                        全选
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setSelected([])}
                      >
                        清空
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setManual(true)}
                      >
                        手动填写
                      </Button>
                    </div>
                  </div>
                  <Input
                    placeholder="筛选模型名…"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                  <div className="max-h-56 overflow-y-auto rounded-md border p-2">
                    {visibleModels.length === 0 ? (
                      <p className="py-3 text-center text-xs text-muted-foreground">
                        没有匹配的模型
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
                    捐献的模型在中转站里会显示为{" "}
                    <code>donation-模型名</code>，方便与其他来源区分。
                    提交时会逐个真实调用一次，<span className="text-foreground">测试不通过的模型不会被上传</span>。
                  </p>
                </div>
              )}

              {manual && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>模型名（每行一个，或逗号分隔）</Label>
                    {probe?.ok && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setManual(false)}
                      >
                        回到列表选择
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
                    无法自动读取上游模型列表时才需要手填。提交后仍会尝试接入并做真实测试，
                    测试通过就自动解锁；失败则转给管理员人工复核。
                  </p>
                </div>
              )}
            </>
          )}
          {type === "frp" && (
            <>
              <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                捐献的是一台 <span className="text-foreground">frps 服务端</span>：
                审核通过后，它会成为本站的节点，所有用户都能申请端口与隧道。
                本站验证不了服务器能否连通，所以提交后
                <span className="text-foreground">一律转人工复核</span>，
                管理员确认后才正式上线。
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>节点名称</Label>
                  <Input
                    placeholder="如：阿里云-香港"
                    value={frpForm.nodeName}
                    onChange={(e) => setFrp("nodeName", e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>地区（可选）</Label>
                  <Input
                    placeholder="如：香港"
                    value={frpForm.region}
                    onChange={(e) => setFrp("region", e.target.value)}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>服务端地址（serverAddr）</Label>
                  <Input
                    placeholder="如 firef.cc.cd"
                    value={frpForm.serverAddr}
                    onChange={(e) => setFrp("serverAddr", e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>服务端端口（serverPort）</Label>
                  <Input
                    placeholder="7000"
                    value={frpForm.serverPort}
                    onChange={(e) => setFrp("serverPort", e.target.value)}
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label>可用端口范围（起）</Label>
                  <Input
                    placeholder="20000"
                    value={frpForm.portMin}
                    onChange={(e) => setFrp("portMin", e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>可用端口范围（止）</Label>
                  <Input
                    placeholder="50000"
                    value={frpForm.portMax}
                    onChange={(e) => setFrp("portMax", e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>每用户端口上限</Label>
                  <Input
                    placeholder="5"
                    value={frpForm.maxPorts}
                    onChange={(e) => setFrp("maxPorts", e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>服务端鉴权方式</Label>
                <Select
                  value={frpForm.authMode}
                  onValueChange={(v) => setFrp("authMode", v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">无鉴权（最基础的 frps）</SelectItem>
                    <SelectItem value="token">全局 auth.token</SelectItem>
                    <SelectItem value="token_user">
                      全局 token + 每用户账号（带鉴权插件）
                    </SelectItem>
                    <SelectItem value="custom">其它 / 自定义插件</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {(frpForm.authMode === "token" || frpForm.authMode === "token_user") && (
                <div className="space-y-1.5">
                  <Label>服务端全局 token（auth.token）</Label>
                  <Input
                    placeholder="frps 服务端配置里的 auth.token"
                    value={frpForm.authToken}
                    onChange={(e) => setFrp("authToken", e.target.value)}
                  />
                </div>
              )}

              <div className="space-y-1.5">
                <Label>一份能连上这台服务器的 frpc.toml 示例</Label>
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
                  把它自己的账号、token 换成任何占位都行——系统会自动识别并参数化。
                  你在这里填的账号口令<b>只用于管理员复核</b>，不会出现在生成给其他用户的配置里。
                  如果你用了第三方鉴权插件，把插件需要的字段也写进示例即可，我们会原样保留。
                </p>
              </div>

              <div className="space-y-1.5">
                <Label>备注（可选）</Label>
                <Input
                  placeholder="带宽、到期时间等说明"
                  value={frpForm.note}
                  onChange={(e) => setFrp("note", e.target.value)}
                />
              </div>
            </>
          )}
          {type === "proxy" && (
            <>
              <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                提交后系统会
                <span className="text-foreground">逐个真实拉取订阅链接</span>
                ，能解析出节点的才算有效：
                <span className="text-foreground">有可用的就自动通过并接入节点池</span>
                ，全部无效则拒绝并写明原因。一次最多 {maxSubUrls} 个链接。
              </div>
              <div className="space-y-2">
                <Label>订阅链接（每行一个）</Label>
                <Textarea
                  rows={5}
                  placeholder="https://example.com/sub/abc"
                  value={subUrls}
                  onChange={(e) => setSubUrls(e.target.value)}
                  className="font-mono text-xs"
                />
                <p className="text-xs text-muted-foreground">
                  只支持 http/https 的订阅地址（不是单个节点链接）；
                  识别的协议有 vless / vmess / trojan / ss / ssr / anytls / hysteria2 / tuic。
                  节点能不能连上我们测不了（Cloudflare 出网无法对节点端口探测），
                  但「链接是否有效、拿到的是不是节点列表」会自动校验。
                </p>
              </div>
            </>
          )}
          <div className="space-y-2">
            <Label>备注（可选）</Label>
            <Input placeholder="渠道来源、稳定性说明等" value={remark} onChange={(e) => setRemark(e.target.value)} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>取消</Button>
          <Button onClick={() => void handleSubmit()} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {busy
              ? type === "ai"
                ? "正在逐个测试模型…"
                : type === "proxy"
                  ? "正在逐个校验订阅…"
                  : "提交中…"
              : type === "ai"
                ? "提交并接入中转站"
                : type === "proxy"
                  ? "提交并校验订阅"
                  : "提交申请"}
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
      toast.error("请填写兑换码")
      return
    }
    setBusy(true)
    try {
      const res = await voucherApi.redeem({ code: c, feature })
      toast.success(`已开通：${res.granted.map(labelOf).join("、")}`)
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
        toast.info("这张码是「自选权限」，请选一个要开通的模块")
      } else {
        toast.error(err instanceof HttpError ? err.message : "兑换失败")
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
      toast.error("复制失败，请手动复制")
    }
  }

  const codes = data?.codes ?? []
  const available = (data?.features ?? []).filter((f) => !f.owned)

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="text-base">兑换码</CardTitle>
        <CardDescription>
          邀请码和兑换码是同一个东西：<span className="text-foreground">可以发给别人</span>
          （新用户注册，或让对方补权限），
          <span className="text-foreground">也可以给自己用</span>
          —— 把自己没有的模块开通。首次捐献成功会赠送一张「自选权限」的码。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {failed && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
            <span>兑换码加载失败，下面可能不完整。</span>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              重试
            </Button>
          </div>
        )}
        {codes.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">我持有的码</p>
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
                    title="复制这个码"
                  >
                    {copied === c.code ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  {c.selfSelect ? (
                    <>
                      <Badge variant="secondary">自选权限</Badge>
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
                              selfSelectable ? "选择要开通的模块" : "已开通全部模块"
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {(data?.features ?? []).map((f) => (
                            <SelectItem key={f.key} value={f.key} disabled={f.owned}>
                              {f.label}
                              {f.owned ? "（已开通）" : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {!selfSelectable && (
                        <span className="text-xs text-amber-600 dark:text-amber-400">
                          你已开通全部模块，这张码自己用不上，可以转送给别人
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
                    <Badge variant="outline">仅用于注册</Badge>
                  )}
                  {c.transferable && (
                    <span className="text-xs text-muted-foreground">可发给别人</span>
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
                      给自己开通
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        )}

        <div className="space-y-2">
          <Label>用别人的码</Label>
          <div className="flex flex-wrap gap-2">
            <Input
              className="min-w-0 flex-1 font-mono"
              placeholder="VX-XXXX-XXXX，或别人给你的邀请码"
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
                <SelectValue placeholder="自选券：选模块" />
              </SelectTrigger>
              <SelectContent>
                {(data?.features ?? []).map((f) => (
                  <SelectItem key={f.key} value={f.key} disabled={f.owned}>
                    {f.label}
                    {f.owned ? "（已开通）" : ""}
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
              兑换
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            只会补上你还没有的权限，已有的会跳过并提示。
            别人转送给你的「自选权限券」，要在这里先选一个模块再兑换。
          </p>
        </div>

        {needPick && (
          <div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium">
                码 <span className="font-mono">{needPick}</span> 是「自选权限」，需要你挑一个模块
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setNeedPick(null)}
                disabled={busy}
              >
                取消
              </Button>
            </div>
            <div className="flex gap-2">
              <Select value={pick} onValueChange={setPick}>
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder="选择要开通的模块" />
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
                确认开通
              </Button>
            </div>
            {available.length === 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                你已开通全部模块，这张自选码在你这里用不上，可以转给别人。
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
  const [apiKey, setApiKey] = React.useState("")
  const [acknowledged, setAcknowledged] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  // 通道未开启 → 整卡隐藏（避免用户点进去才发现不可用）
  if (!block || !block.enabled) return null

  // 管理员撤下了捐献入口（display-only 开关，与「开启捐献通道」区分）
  if (!block.visible) return null

  const submit = async () => {
    if (!apiKey.trim()) {
      toast.error("请填写商汤 API Key")
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
        toast.success("商汤 Key 校验通过，已解锁「AI 中转站」权限", {
          description: res.reviewNote ?? undefined,
          duration: 10000,
        })
        setApiKey("")
        setAcknowledged(false)
      } else if (res.status === "rejected") {
        toast.error("商汤 Key 未通过校验，权限未解锁", {
          // 后端把「为什么没通过」写在这里（Key 无效 / 目标渠道不是多密钥渠道…），
          // 原样给用户看，别用一句「提交失败」盖掉
          description: res.reviewNote ?? undefined,
          duration: 10000,
        })
        // 不清空输入框：用户多半是粘错了，让他直接在原值上改
      } else {
        toast.success("已提交，等待管理员复核", {
          description: res.reviewNote ?? undefined,
          duration: 10000,
        })
        setApiKey("")
        setAcknowledged(false)
      }
      onDone()
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : "提交失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          商汤 Key
          {aiUnlocked ? (
            <Badge variant="success">已解锁 AI 中转站</Badge>
          ) : (
            <Badge variant="secondary">未解锁</Badge>
          )}
        </CardTitle>
        <CardDescription>
          提交你的商汤日日新 API Key，系统会真实调一次商汤接口验证有效性。
          校验通过即解锁「AI 中转站」权限 —— 无需等待管理员审核。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border border-dashed px-4 py-3 text-xs text-muted-foreground">
          商汤的 Key 只能在控制台手动创建，且
          <span className="text-foreground">只在创建时完整显示一次</span>
          —— 请先创建并复制好再回来提交。
          <a
            href={block.consoleUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="ml-1 inline-flex items-center gap-0.5 text-foreground underline underline-offset-2"
          >
            去商汤控制台创建
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>

        <div className="space-y-2">
          <Label htmlFor="sensenovaKey">商汤 API Key</Label>
          <Input
            id="sensenovaKey"
            type="password"
            autoComplete="off"
            placeholder="粘贴你的商汤 API Key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            该 Key 会被加入本站的商汤上游渠道（与其它 Key 轮询使用），供全站用户调用，
            会消耗你的账户额度。
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
            我已阅读并同意上述说明，理解该 Key 会被本站用于全站用户的模型调用、
            消耗我账户的额度，并自行承担可能的账号风险。
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
            校验并捐献
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
  const realmLabel = realm === "global" ? "国际版" : "国内版"

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Unplug className="h-4 w-4 text-muted-foreground" />
          反代账号
          {aiUnlocked ? (
            <Badge variant="success">已解锁 AI 中转站</Badge>
          ) : (
            <Badge variant="secondary">未解锁</Badge>
          )}
        </CardTitle>
        <CardDescription>
          登录你自己的 WorkBuddy {realmLabel}账号，把账号贡献到共享池，
          即可解锁「AI 中转站」权限 —— 无需等待管理员审核，登录成功立即生效。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3">
          <p className="flex items-start gap-2 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <span>
              <span className="font-medium">请务必知悉：</span>
              你的账号将<span className="font-medium">加入共享账号池，被本站其他用户使用</span>，
              并且会被站点的<span className="font-medium">自动化任务</span>
              （签到、活跃上报、旅行、奖励任务等）操作。
              这可能<span className="font-medium">违反 WorkBuddy 服务条款，并导致你的账号被封禁</span>。
              请仅在你自愿接受该后果时继续。
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
                  {b.status === "active" ? "使用中" : "已移除"}
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
          <Label className="text-xs text-muted-foreground">你的账号是哪个版本</Label>
          <div className="flex gap-2">
            {(["cn", "global"] as const).map((r) => (
              <Button
                key={r}
                type="button"
                size="sm"
                variant={realm === r ? "default" : "outline"}
                onClick={() => setRealmChoice(r)}
              >
                {r === "cn" ? "国内版" : "国际版"}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            用中国大陆的账号请选「国内版」，海外 / 国际站账号请选「国际版」——
            选错了登录会失败，改选另一边重试即可。
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            已绑定 {block.used} / {block.limit} 个账号
            {full && "（已达上限，可联系管理员移除后重试）"}
          </p>
          <Button
            size="sm"
            disabled={full || !acknowledged}
            onClick={() => setDialogOpen(true)}
          >
            <Plus className="h-4 w-4" />
            登录并捐献
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
            我已阅读并同意上述说明，理解账号会进入共享池供他人使用、
            会被自动化任务操作，并自行承担可能的封号风险。
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
        setMessage(err instanceof HttpError ? err.message : "发起登录失败")
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
            `已绑定 ${r?.nickname || r?.uid || ""}` +
              (r?.alreadyBound
                ? "（该账号此前已绑定过）"
                : r?.aiGranted
                  ? "，已为你解锁 AI 中转站权限"
                  : "，你的 AI 中转站权限此前已解锁")
          )
          return
        }
        if (res.status === "failed") {
          stopped = true
          setPhase("failed")
          setMessage(res.message || "登录失败")
          return
        }
      } catch (err) {
        if (stopped) return
        stopped = true
        setPhase("failed")
        setMessage(err instanceof HttpError ? err.message : "轮询失败")
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
      toast.error("复制失败，请手动复制")
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>登录 WorkBuddy {realm === "global" ? "国际版" : "国内版"}账号</DialogTitle>
          <DialogDescription>
            在打开的页面登录你的账号，本站会自动检测登录结果并完成绑定。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {phase === "starting" && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在生成授权链接…
            </p>
          )}

          {url && (
            <>
              <div className="space-y-2">
                <Label>授权链接</Label>
                <div className="flex gap-2">
                  <Input readOnly value={url} className="font-mono text-xs" />
                  <Button variant="outline" size="icon" onClick={() => void copyUrl()}>
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => window.open(url, "_blank", "noopener")}
                    aria-label="打开链接"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {phase === "waiting" && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  等待你在浏览器中完成登录…（链接 15 分钟内有效）
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
            <Button onClick={onDone}>完成</Button>
          ) : (
            <Button variant="outline" onClick={onClose}>
              {phase === "failed" ? "关闭" : "取消"}
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
          反代账号（{providerLabel}）
          {aiUnlocked ? (
            <Badge variant="success">已解锁 AI 中转站</Badge>
          ) : (
            <Badge variant="secondary">未解锁</Badge>
          )}
        </CardTitle>
        <CardDescription>
          登录你自己的 {providerLabel} {block.region === "global" ? "国际版" : "国内版"}账号，
          把账号贡献到共享池，即可解锁「AI 中转站」权限 —— 无需等待管理员审核。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3">
          <p className="flex items-start gap-2 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <span>
              <span className="font-medium">请务必知悉：</span>
              你的账号将<span className="font-medium">加入共享账号池，被本站其他用户使用</span>，
              并且会被站点的<span className="font-medium">自动化任务</span>（签到、活跃上报等）操作。
              这可能<span className="font-medium">违反 {providerLabel} 服务条款，并导致你的账号被封禁</span>。
              请仅在你自愿接受该后果时继续。
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
                  {b.status === "active" ? "使用中" : "已移除"}
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
            已绑定 {block.used} / {block.limit} 个账号
            {full && "（已达上限，可联系管理员移除后重试）"}
          </p>
          <Button
            size="sm"
            disabled={full || !acknowledged}
            onClick={() => setDialogOpen(true)}
          >
            <Plus className="h-4 w-4" />
            登录并捐献
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
            我已阅读并同意上述说明，理解账号会进入共享池供他人使用、
            会被自动化任务操作，并自行承担可能的封号风险。
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
        setMessage(err instanceof HttpError ? err.message : "发起登录失败")
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
            `已绑定 ${providerLabel} 账号` +
              (r?.alreadyBound
                ? "（该账号此前已绑定过）"
                : r?.aiGranted
                  ? "，已为你解锁 AI 中转站权限"
                  : "，你的 AI 中转站权限此前已解锁")
          )
          return
        }
        if (res.status === "failed") {
          stopped = true
          setPhase("failed")
          setMessage(res.message || "登录失败")
          return
        }
        // pending：更新提示语
        if (res.message) setMessage(res.message)
      } catch (err) {
        if (stopped) return
        stopped = true
        setPhase("failed")
        setMessage(err instanceof HttpError ? err.message : "轮询失败")
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
      toast.error("复制失败，请手动复制")
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            登录 {providerLabel} {region === "global" ? "国际版" : "国内版"}账号
          </DialogTitle>
          <DialogDescription>
            在打开的页面登录你的账号，本站会自动检测登录结果并完成绑定。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {phase === "starting" && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在创建上游账号…
            </p>
          )}

          {url && (
            <>
              <div className="space-y-2">
                <Label>授权链接</Label>
                <div className="flex gap-2">
                  <Input readOnly value={url} className="font-mono text-xs" />
                  <Button variant="outline" size="icon" onClick={() => void copyUrl()}>
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => window.open(url, "_blank", "noopener")}
                    aria-label="打开链接"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {phase === "waiting" && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {message || "等待你在浏览器中完成登录…（链接 15 分钟内有效）"}
                </p>
              )}
            </>
          )}

          {!url && phase === "waiting" && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {message || "正在启动上游账号并生成授权链接…"}
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
            <Button onClick={onDone}>完成</Button>
          ) : (
            <Button variant="outline" onClick={onClose}>
              {phase === "failed" ? "关闭" : "取消"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}