import * as React from "react"
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom"
import {
  Globe,
  Mail,
  Settings,
  LayoutDashboard,
  ShieldCheck,
  LogOut,
  Menu,
  X,
  HardDrive,
  Heart,  Sparkles,
  Contact,
  Network,
  Zap,
  Trophy,
  Medal,
  Coins,
  MessagesSquare,
  MessageSquare,
  Wrench,
  LogIn,
} from "lucide-react"

import { Logo } from "@/components/logo"
import { ThemeToggle } from "@/components/theme-toggle"
import { LangToggle } from "@/components/lang-toggle"
import { useT } from "@/i18n"
import { MessageBell } from "@/components/message-bell"
import { DmBell } from "@/components/dm-bell"
import { PointsBadge } from "@/components/points-badge"
import { ScrollToTop } from "@/components/scroll-to-top"
import { PageEnter } from "@/components/page-enter"
import { AutoCheckin } from "@/components/auto-checkin"
import { Button } from "@/components/ui/button"
import { UserAvatar } from "@/components/user-avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Separator } from "@/components/ui/separator"
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
import { useAuth } from "@/hooks/use-auth"
import { AttentionContext } from "@/lib/attention-context"
import {
  authApi,
  attentionApi,
  chatApi,
  communityApi,
  settingsApi,
  getDefaultRootDomain,
  HttpError,
} from "@/services/api"
import type { AttentionCounts } from "@/types"
import { cn } from "@/lib/utils"
import { onAttentionChanged } from "@/lib/attention-events"
import { idlePreload, preloadRoute } from "@/lib/route-preload"
import { SlidingPill } from "@/components/motion/sliding-pill"
import { toast } from "sonner"

/** 角标轮询间隔（社区/聊天室/反馈/管理共用一次请求） */
const ATTENTION_POLL_MS = 60_000

/** 主体功能，排在侧边栏上部 */
const baseNav = [
  { to: "/dashboard", labelKey: "nav.overview", icon: LayoutDashboard, end: true },
  { to: "/dashboard/domains", labelKey: "nav.domains", icon: Globe, end: false },
  { to: "/dashboard/email", labelKey: "nav.email", icon: Mail, end: false },
  { to: "/dashboard/storage", labelKey: "nav.storage", icon: HardDrive, end: false },
  { to: "/dashboard/ai", labelKey: "nav.ai", icon: Sparkles, end: false },
  { to: "/dashboard/frp", labelKey: "nav.frp", icon: Network, end: false },
  { to: "/dashboard/proxy", labelKey: "nav.proxy", icon: Zap, end: false },
  { to: "/dashboard/profile", labelKey: "nav.profile", icon: Contact, end: false },
  { to: "/dashboard/community", labelKey: "nav.community", icon: MessagesSquare, end: false },
  { to: "/dashboard/toolbox", labelKey: "nav.toolbox", icon: Wrench, end: false },
]

/**
 * 底部固定区：紧贴账户信息上方，与上方主体功能之间留出空白。
 * 顺序按「从下往上」定义：最底部是设置，往上依次是管理、捐献、反馈。
 * 因此数组按自上而下书写为 [反馈, 捐献, 管理, 设置]。
 *
 * 「反馈」排在「捐献」之上：两者都是「我 → 站点」的单向沟通（捐献是给资源、
 * 反馈是给意见），放一起符合直觉；而它比捐献更常用，位置高一点更好点到。
 */
const settingsNav = { to: "/dashboard/settings", labelKey: "nav.settings", icon: Settings, end: false }
const adminNav = { to: "/dashboard/admin", labelKey: "nav.admin", icon: ShieldCheck, end: false }
// 「成就」不再占侧边栏位置，收进右下角账户菜单（排在「个人空间」上方）。
// 侧边栏底部队列只留更常用的入口，成就属于「偶尔看一眼」的荣誉页。
const achievementNav = { to: "/dashboard/achievements", labelKey: "nav.achievements", icon: Trophy, end: false }
/**
 * 排行榜。
 *
 * 放在账户菜单（左下角齿轮 / 移动端头像）里而不是侧边栏主队列：
 * 侧边栏只留「日常要用」的入口，排行榜属于「偶尔看一眼」的荣誉页 ——
 * 与「成就」同一性质，所以跟它并排。
 */
const leaderboardNav = { to: "/dashboard/leaderboard", labelKey: "nav.leaderboard", icon: Medal, end: false }
// 积分与成就原本并列（都是「成长/奖励」体系），成就移入账户菜单后这里只剩积分。
// 文案用「积分与商城」：该页同时承载「积分余额」与「积分商城」两块，光写「积分」看不出有商城。
const pointsNav = { to: "/dashboard/points", labelKey: "nav.points", icon: Coins, end: false }
const donationNav = { to: "/dashboard/donations", labelKey: "nav.donations", icon: Heart, end: false }
const feedbackNav = { to: "/dashboard/feedback", labelKey: "nav.feedback", icon: MessageSquare, end: false }

/**
 * 游客可公开浏览的侧边栏入口（其余入口在游客态引导去登录）。
 * 社区广场的开放与否还受后台开关约束。
 *
 * ⚠️ 临时分享箱已从侧边栏撤下（改由「工具箱」进入），这里保留它是因为
 * 分享链接 `/t?code=...` 会收敛到 `/dashboard/tempbox`，收件人（含访客）
 * 必须能直接打开，不能被这条 guestBlocked 规则挡去登录页。
 */
const GUEST_PUBLIC_PATHS = ["/dashboard/community", "/dashboard/tempbox"]

export function DashboardLayout({
  allowGuest = false,
  children,
}: {
  allowGuest?: boolean
  children?: React.ReactNode
}) {
  const { user, setUser } = useAuth()
  /** 「发给用户的根域」（如 tyu.me），由后端下发，不写死 —— 管理员可改 */
  const [rootDomain, setRootDomain] = React.useState("")
  React.useEffect(() => {
    let alive = true
    getDefaultRootDomain()
      .then((d) => {
        if (alive) setRootDomain(d)
      })
      .catch(() => {
        /* 拉不到就不显示域名 */
      })
    return () => {
      alive = false
    }
  }, [])
  const location = useLocation()
  const navigate = useNavigate()
  const { t } = useT()
  const [open, setOpen] = React.useState(false)
  // 角标计数（社区新帖 / 聊天室新消息 / 反馈新回复 / 管理待处理），一次请求拿齐
  const [attention, setAttention] = React.useState<AttentionCounts | null>(null)
  // 是否正停在社区（含帖子详情）／聊天室 —— 是的话对应角标立刻归零并记已读
  const onCommunity = location.pathname.startsWith("/dashboard/community")
  const onChat = location.pathname.startsWith("/dashboard/chat")
  // 未验证横幅 + 验证码弹窗
  const [verifyOpen, setVerifyOpen] = React.useState(false)
  const [verifyBusy, setVerifyBusy] = React.useState(false)
  const [codeSent, setCodeSent] = React.useState(false)
  const [verifyCode, setVerifyCode] = React.useState("")

  /** 发送验证码（横幅 / 弹窗共用），发送后进入输入验证码状态 */
  const handleResendVerify = async () => {
    setVerifyBusy(true)
    try {
      const res = await settingsApi.verifyEmail()
      if (res.verified) {
        toast.success(t("lay.emailVerified"))
        if (setUser && user) setUser({ ...user, emailVerified: true })
        setVerifyOpen(false)
      } else {
        setCodeSent(true)
        setVerifyCode("")
        toast.success(t("lay.codeSent"))
      }
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("lay.sendFailed"))
    } finally {
      setVerifyBusy(false)
    }
  }

  /** 回填验证码完成验证 */
  const handleConfirmVerify = async () => {
    if (!/^\d{6}$/.test(verifyCode)) {
      toast.error(t("em.err.enter6"))
      return
    }
    setVerifyBusy(true)
    try {
      const res = await settingsApi.verifyEmail("confirm", verifyCode)
      if (res.verified) {
        toast.success(t("lay.verifyOk"))
        if (setUser && user) setUser({ ...user, emailVerified: true })
        setVerifyOpen(false)
        setCodeSent(false)
        setVerifyCode("")
      }
    } catch (err) {
      toast.error(err instanceof HttpError ? err.message : t("em.err.verify"))
    } finally {
      setVerifyBusy(false)
    }
  }

  /** 打开验证弹窗 */
  const openVerify = () => {
    setCodeSent(false)
    setVerifyCode("")
    setVerifyOpen(true)
  }

  /**
   * 功能接口因「邮箱未验证」被服务端拦下时，直接把验证对话框弹出来。
   *
   * 背景（2026-10-02）：未验证账号可以照常浏览页面，但所有写操作（开通中转站、
   * 建子域名、发帖、发言…）都会被 403 拦掉。只靠 toast 提示，用户得自己摸到
   * 这里找入口；这里做一次全局兜底，点到哪被拦就在哪弹窗。
   */
  React.useEffect(() => {
    const onGated = () => {
      setCodeSent(false)
      setVerifyCode("")
      setVerifyOpen(true)
    }
    window.addEventListener("auth:email-unverified", onGated)
    return () => window.removeEventListener("auth:email-unverified", onGated)
  }, [])

  /**
   * 角标数据：一次请求拿齐社区 / 聊天室 / 反馈 / 管理四项。
   *
   * 依赖里带 `location.pathname`：每切一次页就重取一遍。这样「刚看完反馈，
   * 侧边栏角标还在」不会持续到下一次 60 秒轮询 —— 用户会以为没消掉。
   *
   * 正停在社区 / 聊天室上时**先落库记已读、再拉计数**（顺序不能反，
   * 否则拉到的还是旧数字），并把该页角标本地钉为 0 —— 人就在页面上，
   * 此时冒出角标只会让人困惑（用户反馈过的原始问题）。
   */
  React.useEffect(() => {
    if (!user) {
      setAttention(null)
      return
    }
    let cancelled = false

    const fetchAttention = () => {
      attentionApi
        .get()
        .then((r) => !cancelled && setAttention(r))
        .catch(() => {})
    }

    /**
     * 拉取前先把「我正停在这一页」落库。
     *   1) 顺序不能反 —— 先记已读再拉，否则拉到的还是旧数字；
     *   2) 轮询里也要做 —— 人在聊天室待着时消息一直在进来，只记进入那一次的话，
     *      一离开就会冒出一堆「其实早就看过」的角标。
     */
    const refresh = () => {
      const seen: Promise<unknown>[] = []
      if (onCommunity) seen.push(communityApi.markSeen().catch(() => {}))
      if (onChat) seen.push(chatApi.markSeen().catch(() => {}))
      if (seen.length > 0) void Promise.all(seen).then(fetchAttention)
      else fetchAttention()
    }

    refresh()
    // 轮询：页面不可见时跳过，省一次请求
    const t = setInterval(() => {
      if (!document.hidden) refresh()
    }, ATTENTION_POLL_MS)
    // 别处（管理面板各栏目）处理完待办时会广播一声，收到后立即重拉 —— 不用等下一轮轮询
    const off = onAttentionChanged(refresh)
    return () => {
      cancelled = true
      clearInterval(t)
      off()
    }
  }, [user, onCommunity, onChat, location.pathname])

  /**
   * 对外展示用的角标：正停在的那一页恒为 0。
   * 其余页面照常轮询更新，不会被「我在社区页」这种状态拖住。
   */
  const badges = React.useMemo(() => {
    if (!attention) return null
    return {
      ...attention,
      community: onCommunity ? 0 : attention.community,
      chat: onChat ? 0 : attention.chat,
    }
  }, [attention, onCommunity, onChat])

  const handleLogout = async () => {
    try {
      await authApi.logout()
    } finally {
      setUser(null)
      navigate("/login")
    }
  }

  // root / superadmin / admin 都显示管理入口（admin 权限由白名单逐项控制）
  const isAdmin = user?.role === "admin" || user?.role === "superadmin" || user?.role === "root"
  // 底部队列（自上而下）：反馈 → 捐献 → 积分与商城 → 管理（仅管理员）→ 设置
  // 即「从下往上」为 设置 → 管理 → 积分与商城 → 捐献 → 反馈，设置紧贴账户信息。
  // 「成就」已移入右下角账户菜单（个人空间上方），不再占侧边栏位置。
  const bottomNav = isAdmin
    ? [feedbackNav, donationNav, pointsNav, adminNav, settingsNav]
    : [feedbackNav, donationNav, pointsNav, settingsNav]

  /**
   * 空闲预载侧边栏一级入口（2026-10-08）。
   *
   * 目的是让侧边栏「点哪到哪」——与管理员面板的手感对齐。悬停时的那一次预载
   * （见 renderNavItem）已能覆盖绝大多数点击，这里再补一层：用户进了控制台
   * 之后没事的那几秒，把一级页面的 chunk 慢慢取回来，那么**直接点**（触屏、
   * 或手快没停顿）也不用等。
   *
   * 三个刻意的约束：
   *   · 挂在布局组件而非 App 根：只有真进了控制台才预载，访客在落地页浏览时
   *     不会白白下载一堆用不到的页面代码；
   *   · 用 bottomNav 而不是硬写列表：它已按权限过滤，普通用户不会去下
   *     admin.tsx（那是全站最大的单个页面 chunk，几百 KB）；
   *   · 移动端不做（idlePreload 内部判断 hover 能力），免得替用户花流量。
   */
  React.useEffect(() => {
    const paths = [...baseNav.map((n) => n.to), ...bottomNav.map((n) => n.to)]
    return idlePreload(paths)
    // bottomNav 只随 isAdmin 变化；baseNav 是模块级常量，永远不变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin])

  /**
   * 每个入口该显示多少角标。
   * 口径都在服务端（`/api/attention`），前端只做「哪个入口看哪个数」的映射。
   */
  const badgeFor = (to: string): number => {
    if (!badges) return 0
    switch (to) {
      case "/dashboard/community":
        // 聊天室入口收在广场里（侧边栏不再单列），故它的未读并入广场角标 ——
        // 广场是聊天室的唯一入口，挂在这里用户才看得到。
        return badges.community + badges.chat
      case "/dashboard/feedback":
        return badges.feedback
      case "/dashboard/admin":
        // 管理入口显示「全部待处理之和」，点进去再看各栏目自己的角标
        return badges.admin?.total ?? 0
      default:
        return 0
    }
  }

  const renderNavItem = (item: {
    to: string
    labelKey: string
    icon: React.ElementType
    end: boolean
  }) => {
    const active = item.end
      ? location.pathname === item.to
      : location.pathname.startsWith(item.to)
    // 游客态：除「公开可浏览」的入口外，其余都引导去登录页（带 from 回跳）。
    // 公开入口 = 社区广场（受后台开关控制）与临时分享箱（分享链接本就给访客看）。
    const guestBlocked =
      allowGuest && !user && !GUEST_PUBLIC_PATHS.includes(item.to)
    const to = guestBlocked ? "/login" : item.to
    const state = guestBlocked ? { from: item.to } : undefined
    /**
     * 悬停/聚焦/触摸按下即预载目标页面（2026-10-08）。
     *
     * 用户把鼠标移到某一项上时，他大概率就是要进去 —— 趁这几百毫秒把那个页面
     * 的 JS chunk 取回来，点下去就直接渲染，不再出现整页转圈。这正是管理员面板
     * 侧边栏「点哪到哪」的手感来源（那边是同一文件内的切换，无需下载）。
     *
     * 三个事件都要：鼠标悬停（桌面主力）、键盘聚焦（Tab 导航要同样跟手）、
     * touchstart（触屏没有 hover，按下瞬间就开始取，比 click 早一点点）。
     * 游客态会跳登录页，预载原目标没有意义，故直接跳过（guestBlocked）。
     */
    const warm = guestBlocked ? undefined : () => preloadRoute(item.to)
    return (
      <Link
        key={item.to}
        to={to}
        state={state}
        onClick={() => setOpen(false)}
        onMouseEnter={warm}
        onFocus={warm}
        onTouchStart={warm}
        // data-nav-active：动效层滑动指示器的定位锚点（与 sub-nav 的 NavItem 同一约定）。
        // 用独立属性而非类名：属性不参与样式，motion 关闭时对现状零影响。
        data-nav-active={active ? "1" : undefined}
        className={cn(
          "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
          active
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        )}
      >
        <item.icon className="h-4 w-4" />
        {t(item.labelKey)}
        {badgeFor(item.to) > 0 && (
          <span
            className={cn(
              "ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-medium leading-none tabular-nums",
              // 「管理」是待办（要你去处理），用实心深色与「有新内容可看」的浅灰区分开。
              // 本站是黑白灰极简风（主题色均为无彩色），不用大红色，避免突兀。
              item.to === "/dashboard/admin"
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground"
            )}
          >
            {badgeFor(item.to) > 99 ? "99+" : badgeFor(item.to)}
          </span>
        )}
      </Link>
    )
  }

  /**
   * 账户菜单的内容。
   *
   * 抽成变量是因为它现在有**两个触发点**：桌面端侧边栏底部那个齿轮、以及移动端顶栏
   * 右上角的头像。站长要求两者点开是同一个二级菜单（2026-09-29）。
   * 只在这里维护一份，避免两处菜单日后各改各的。
   *
   * 说明：`DropdownMenuContent` 挂在 `DropdownMenu` 内部，两处各自渲染一份；
   * 因为同一时刻只会展开一个，这里复用「内容」即可，无需共享展开状态。
   */
  const accountMenuItems = (
    <>
      <DropdownMenuLabel>{user?.email}</DropdownMenuLabel>
      <DropdownMenuSeparator />
      {/* 「成就」从侧边栏挪到这里，排在「个人空间」上方 */}
      <DropdownMenuItem onClick={() => navigate(achievementNav.to)}>
        <Trophy className="h-4 w-4" />
        {t("nav.achievements")}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => navigate(leaderboardNav.to)}>
        <Medal className="h-4 w-4" />
        {t("nav.leaderboard")}
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={() => navigate(`/space/${encodeURIComponent(user?.username ?? "")}`)}
      >
        <Contact className="h-4 w-4" />
        {t("nav.space")}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => navigate("/dashboard/settings")}>
        <Settings className="h-4 w-4" />
        {t("nav.accountSettings")}
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={handleLogout}
        className="text-destructive focus:text-destructive"
      >
        <LogOut className="h-4 w-4" />
        {t("nav.logout")}
      </DropdownMenuItem>
    </>
  )

  const sidebar = (
    <div className="flex h-full flex-col gap-6 overflow-y-auto pb-4">
      {/* Logo 区与顶栏同高（h-14）并各带一条 border-b，两条线在同一水平线上
          连成一条；Logo 垂直居中后副标题离下边界有约 13px 留白，不再贴线。
          左右内边距下移到各区块，让分隔线横贯侧边栏整个宽度。 */}
      <div className="flex h-14 shrink-0 items-center border-b px-3">
        <Logo tagline />
      </div>
      {/*
        两组导航各放一个滑动指示器（动效层）：
        上组与底组在视觉上是两段（中间隔着 mt-auto 撑开的大片空白），
        用**一个**跨组滑块会看到一块背景横穿空白滑过去，很怪；分开放则
        「同组换项平滑滑、跨组切换直接落位」（落位逻辑见 SlidingPill 的 hadActive）。
        关＝现状：关掉动效时滑块不显示，导航项自带的 active 背景由 CSS 还回来。
      */}
      <nav className="flex flex-col gap-1 px-3">
        <SlidingPill
          activeSelector='[data-nav-active="1"]'
          className="rounded-md bg-accent"
        />
        {baseNav.map((item) => renderNavItem(item))}
      </nav>

      {/* 底部固定区：与上方功能之间留白，紧贴账户信息 */}
      <div className="mt-auto flex flex-col gap-1 px-3 pt-6">
        <SlidingPill
          activeSelector='[data-nav-active="1"]'
          className="rounded-md bg-accent"
        />
        {bottomNav.map((item) => renderNavItem(item))}
      </div>

      <div className="flex flex-col gap-2 px-3">
        <Separator className="mb-2" />
        {user ? (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => navigate(`/space/${encodeURIComponent(user.username)}`)}
              title={t("lay.viewSpace")}
              className="shrink-0 rounded-full transition-opacity hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <UserAvatar
                username={user.username}
                nickname={user.nickname}
                hasAvatar={user.hasAvatar}
              />
            </button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{user.username}</p>
              <p className="truncate text-xs text-muted-foreground">
                {/* 根域由后端下发（root_domains 的默认行，管理员可改），
                    2026-10-02 起是 tyu.me —— 写死 doulor.cn 会在换域后显示错地址 */}
                {user.namespace}
                {rootDomain ? `.${rootDomain}` : ""}
              </p>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label={t("lay.accountMenu")}
                >
                  <Settings className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {accountMenuItems}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-muted text-muted-foreground">
              <LogIn className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{t("lay.notLoggedIn")}</p>
              <p className="truncate text-xs text-muted-foreground">{t("lay.loginHint")}</p>
            </div>
            <Button
              size="sm"
              className="h-8 shrink-0"
              onClick={() => navigate("/login", { state: { from: location.pathname } })}
            >
              {t("nav.login")}
            </Button>
          </div>
        )}
      </div>
    </div>
  )

  return (
    <div className="min-h-screen">
      {/* 自动签到：进站触发，无 UI（见组件内说明） */}
      <AutoCheckin />
      {/* 这层刻意不铺 bg-background：底色由 body 提供，云纹背景画在 body 上，
          这里再铺一次不透明色就会把它整块盖住。
          侧边栏用 glass-sidebar（轻度档，与卡片同档）—— 原为不透明的 bg-card。 */}
      <aside className="glass-sidebar fixed inset-y-0 left-0 z-30 hidden w-60 border-r lg:block">
        {sidebar}
      </aside>

      <div className="lg:pl-60">
        {/* 顶栏原本就是 bg-background/80 + backdrop-blur；改为与侧边栏同一档玻璃，两者手感统一。 */}
        <header className="glass-panel sticky top-0 z-20 flex h-14 items-center gap-3 border-b px-4 lg:px-8">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setOpen((v) => !v)}
            aria-label={t("lay.menu")}
          >
            {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </Button>
          <div className="ml-auto flex items-center gap-2">
            {user && <PointsBadge />}
            {user && <DmBell />}
            {user && <MessageBell />}
            <LangToggle />
            <ThemeToggle />
            {user ? (
              /*
               * 移动端顶栏头像：点开与桌面端侧边栏的齿轮**同一个**账户菜单。
               * 之前这里只是张静态头像，点了没反应（2026-09-29 站长反馈）。
               * 手势区按 44px 做（-m-1.5 p-1.5），头像仍是 28px，视觉不变但好点。
               */
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="-m-1.5 shrink-0 rounded-full p-1.5 transition-opacity hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={t("lay.accountMenu")}
                  >
                    <UserAvatar
                      username={user.username}
                      nickname={user.nickname}
                      hasAvatar={user.hasAvatar}
                      className="h-7 w-7 lg:hidden"
                    />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  {accountMenuItems}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="lg:hidden"
                onClick={() => navigate("/login", { state: { from: location.pathname } })}
              >
                {t("nav.login")}
              </Button>
            )}
          </div>
        </header>

        {open && (
          <div className="fixed inset-0 z-30 lg:hidden">
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => setOpen(false)}
            />
            <div className="glass-sidebar absolute inset-y-0 left-0 w-64 border-r">
              {sidebar}
            </div>
          </div>
        )}

        {user && user.emailVerified === false && (
          <div className="border-b border-amber-500/30 bg-amber-50 dark:bg-amber-950/40">
            <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 lg:px-8">
              <Mail className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <p className="min-w-0 flex-1 text-sm text-amber-800 dark:text-amber-200">
                {t("lay.verifyBanner.a")}
                <span className="font-mono">{user.email}</span>
                {t("lay.verifyBanner.b")}
              </p>
              <div className="flex shrink-0 items-center gap-2">
                <Button size="sm" onClick={openVerify}>
                  {t("lay.verifyNow")}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* 邮箱验证弹窗 */}
        <Dialog open={verifyOpen} onOpenChange={setVerifyOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("lay.verifyTitle")}</DialogTitle>
              <DialogDescription>
                {t("lay.verifyDesc.a")}
                <span className="font-mono">{user?.email}</span>
                {t("lay.verifyDesc.b")}
                {" "}
                {t("lay.verifyWhy")}
              </DialogDescription>
            </DialogHeader>
            {codeSent ? (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="verifyCode">{t("em.codePlaceholder")}</Label>
                  <Input
                    id="verifyCode"
                    inputMode="numeric"
                    maxLength={6}
                    placeholder={t("lay.codePlaceholder")}
                    value={verifyCode}
                    onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, ""))}
                    className="font-mono text-sm tracking-widest"
                  />
                </div>
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => void handleResendVerify()}
                    disabled={verifyBusy}
                  >
                    {t("settings.email.resend")}
                  </Button>
                  <Button onClick={() => void handleConfirmVerify()} disabled={verifyBusy}>
                    {verifyBusy ? t("lay.verifying") : t("settings.email.confirmVerify")}
                  </Button>
                </DialogFooter>
              </div>
            ) : (
              <DialogFooter>
                <Button onClick={() => void handleResendVerify()} disabled={verifyBusy}>
                  {verifyBusy ? t("lay.sending") : t("settings.btn.sendCode")}
                </Button>
              </DialogFooter>
            )}
          </DialogContent>
        </Dialog>

        <main className="mx-auto w-full max-w-6xl px-4 py-8 lg:px-8">
          {/* 页面内容渐入：只包内容区，侧边栏与顶栏在外面 ⇒ 点导航时外壳不会跟着闪。
              同时把角标数据下发给页面（社区页的聊天室入口卡要用同一个未读数，
              见 @/lib/attention-context）。 */}
          <PageEnter>
            <AttentionContext.Provider value={attention}>
              {children ?? <Outlet />}
            </AttentionContext.Provider>
          </PageEnter>
        </main>
        <ScrollToTop />
      </div>
    </div>
  )
}
