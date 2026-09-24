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
  Package,
  Trophy,
  MessagesSquare,
  LogIn,
} from "lucide-react"

import { Logo } from "@/components/logo"
import { ThemeToggle } from "@/components/theme-toggle"
import { ScrollToTop } from "@/components/scroll-to-top"
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
import { useAuth } from "@/hooks/use-auth"
import { authApi, communityApi } from "@/services/api"
import { cn } from "@/lib/utils"

/** 主体功能，排在侧边栏上部 */
const baseNav = [
  { to: "/dashboard", label: "概览", icon: LayoutDashboard, end: true },
  { to: "/dashboard/domains", label: "域名", icon: Globe, end: false },
  { to: "/dashboard/email", label: "邮箱", icon: Mail, end: false },
  { to: "/dashboard/storage", label: "网盘", icon: HardDrive, end: false },
  { to: "/dashboard/ai", label: "AI 中转站", icon: Sparkles, end: false },
  { to: "/dashboard/frp", label: "内网穿透", icon: Network, end: false },
  { to: "/dashboard/proxy", label: "代理节点", icon: Zap, end: false },
  { to: "/dashboard/tempbox", label: "临时分享箱", icon: Package, end: false },
  { to: "/dashboard/profile", label: "个人名片", icon: Contact, end: false },
  { to: "/dashboard/community", label: "社区广场", icon: MessagesSquare, end: false },
]

/**
 * 底部固定区：紧贴账户信息上方，与上方主体功能之间留出空白。
 * 顺序按「从下往上」定义：最底部是设置，往上依次是管理、捐献。
 * 因此数组按自上而下书写为 [捐献, 管理, 设置]。
 */
const settingsNav = { to: "/dashboard/settings", label: "设置", icon: Settings, end: false }
const adminNav = { to: "/dashboard/admin", label: "管理", icon: ShieldCheck, end: false }
const achievementNav = { to: "/dashboard/achievements", label: "成就", icon: Trophy, end: false }
const donationNav = { to: "/dashboard/donations", label: "捐献", icon: Heart, end: false }

export function DashboardLayout({
  allowGuest = false,
  children,
}: {
  allowGuest?: boolean
  children?: React.ReactNode
}) {
  const { user, setUser } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [open, setOpen] = React.useState(false)
  // 社区「N 条新帖子」角标（我看过之后别人新增的帖子）
  const [newPosts, setNewPosts] = React.useState(0)
  // 是否正停在社区（含帖子详情）—— 是的话角标立刻归零并记已读
  const onCommunity = location.pathname.startsWith("/dashboard/community")

  React.useEffect(() => {
    if (!user) {
      setNewPosts(0)
      return
    }
    let cancelled = false

    // 已经站在社区页面（含帖子详情）上 ⇒ 当场算已读：
    //   1) 落库（之后切到别的页面，角标也不会复活）
    //   2) 本地立刻清零 —— 只靠 60 秒轮询的话，用户会以为「还是没消掉」
    // 这一支**不轮询**：人就在页面上，此时冒出角标只会让人困惑
    // （用户反馈的原始问题就是「一直显示」）。
    if (onCommunity) {
      communityApi
        .markSeen()
        .then(() => !cancelled && setNewPosts(0))
        .catch(() => {})
      return () => {
        cancelled = true
      }
    }

    const tick = () => {
      communityApi
        .newPostsCount()
        .then((r) => !cancelled && setNewPosts(r.count))
        .catch(() => {})
    }
    tick()
    const t = setInterval(tick, 60000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [user, onCommunity])

  const handleLogout = async () => {
    try {
      await authApi.logout()
    } finally {
      setUser(null)
      navigate("/login")
    }
  }

  const isAdmin = user?.role === "admin"
  // 底部队列（自上而下）：捐献 → 成就 → 管理（仅管理员）→ 设置
  // 即「从下往上」为 设置 → 管理 → 成就 → 捐献，设置紧贴账户信息
  const bottomNav = isAdmin
    ? [donationNav, achievementNav, adminNav, settingsNav]
    : [donationNav, achievementNav, settingsNav]

  const renderNavItem = (item: {
    to: string
    label: string
    icon: React.ElementType
    end: boolean
  }) => {
    const active = item.end
      ? location.pathname === item.to
      : location.pathname.startsWith(item.to)
    // 游客态：除社区广场（公开可浏览）外的入口都引导去登录页（带 from 回跳）
    const guestBlocked = allowGuest && !user && item.to !== "/dashboard/community"
    const to = guestBlocked ? "/login" : item.to
    const state = guestBlocked ? { from: item.to } : undefined
    return (
      <Link
        key={item.to}
        to={to}
        state={state}
        onClick={() => setOpen(false)}
        className={cn(
          "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
          active
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        )}
      >
        <item.icon className="h-4 w-4" />
        {item.label}
        {item.to === "/dashboard/community" && newPosts > 0 && (
          <span className="ml-auto rounded-full bg-muted px-1.5 text-[11px] leading-5 text-muted-foreground">
            {newPosts > 99 ? "99+" : newPosts}
          </span>
        )}
      </Link>
    )
  }

  const sidebar = (
    <div className="flex h-full flex-col gap-6 pb-4">
      {/* Logo 区与顶栏同高（h-14）并各带一条 border-b，两条线在同一水平线上
          连成一条；Logo 垂直居中后副标题离下边界有约 13px 留白，不再贴线。
          左右内边距下移到各区块，让分隔线横贯侧边栏整个宽度。 */}
      <div className="flex h-14 shrink-0 items-center border-b px-3">
        <Logo tagline />
      </div>
      <nav className="flex flex-col gap-1 px-3">
        {baseNav.map((item) => renderNavItem(item))}
      </nav>

      {/* 底部固定区：与上方功能之间留白，紧贴账户信息 */}
      <div className="mt-auto flex flex-col gap-1 px-3 pt-6">
        {bottomNav.map((item) => renderNavItem(item))}
      </div>

      <div className="flex flex-col gap-2 px-3">
        <Separator className="mb-2" />
        {user ? (
          <div className="flex items-center gap-3">
            <UserAvatar
              username={user.username}
              nickname={user.nickname}
              hasAvatar={user.hasAvatar}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{user.username}</p>
              <p className="truncate text-xs text-muted-foreground">
                {user.namespace}.doulor.cn
              </p>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label="账户菜单"
                >
                  <Settings className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel>{user.email}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => navigate("/dashboard/settings")}>
                  <Settings className="h-4 w-4" />
                  账户设置
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={handleLogout}
                  className="text-destructive focus:text-destructive"
                >
                  <LogOut className="h-4 w-4" />
                  退出登录
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-muted text-muted-foreground">
              <LogIn className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">未登录</p>
              <p className="truncate text-xs text-muted-foreground">登录后可发帖互动</p>
            </div>
            <Button
              size="sm"
              className="h-8 shrink-0"
              onClick={() => navigate("/login", { state: { from: location.pathname } })}
            >
              登录
            </Button>
          </div>
        )}
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-background">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r bg-card lg:block">
        {sidebar}
      </aside>

      <div className="lg:pl-60">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur lg:px-8">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setOpen((v) => !v)}
            aria-label="菜单"
          >
            {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            {user ? (
              <UserAvatar
                username={user.username}
                nickname={user.nickname}
                hasAvatar={user.hasAvatar}
                className="h-7 w-7 lg:hidden"
              />
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="lg:hidden"
                onClick={() => navigate("/login", { state: { from: location.pathname } })}
              >
                登录
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
            <div className="absolute inset-y-0 left-0 w-64 border-r bg-card">
              {sidebar}
            </div>
          </div>
        )}

        <main className="mx-auto w-full max-w-6xl px-4 py-8 lg:px-8">
          {children ?? <Outlet />}
        </main>
        <ScrollToTop />
      </div>
    </div>
  )
}
