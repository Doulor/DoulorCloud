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
} from "lucide-react"

import { Logo } from "@/components/logo"
import { ThemeToggle } from "@/components/theme-toggle"
import { ScrollToTop } from "@/components/scroll-to-top"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
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
import { authApi } from "@/services/api"
import { cn } from "@/lib/utils"

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
  { to: "/dashboard/settings", label: "设置", icon: Settings, end: false },
  { to: "/dashboard/donations", label: "捐献", icon: Heart, end: false },
]

const adminNav = [
  { to: "/dashboard/admin", label: "管理", icon: ShieldCheck, end: false },
]

export function DashboardLayout() {
  const { user, setUser } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [open, setOpen] = React.useState(false)

  const handleLogout = async () => {
    try {
      await authApi.logout()
    } finally {
      setUser(null)
      navigate("/login")
    }
  }

  const isAdmin = user?.role === "admin"
  const nav = isAdmin ? [...baseNav, ...adminNav] : baseNav
  const initials = user?.username?.slice(0, 1).toUpperCase() ?? "U"

  const sidebar = (
    <div className="flex h-full flex-col gap-6 px-3 py-4">
      <div className="px-3 pt-1">
        <Logo />
      </div>
      <nav className="flex flex-col gap-1">
        {nav.map((item) => {
          const active = item.end
            ? location.pathname === item.to
            : location.pathname.startsWith(item.to)
          return (
            <Link
              key={item.to}
              to={item.to}
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
            </Link>
          )
        })}
      </nav>
      <div className="mt-auto flex flex-col gap-2 px-3">
        <Separator className="mb-2" />
        <div className="flex items-center gap-3">
          <Avatar className="h-8 w-8">
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{user?.username}</p>
            <p className="truncate text-xs text-muted-foreground">
              {user?.namespace}.doulor.cn
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
              <DropdownMenuLabel>{user?.email}</DropdownMenuLabel>
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
            <Avatar className="h-7 w-7 lg:hidden">
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
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
          <Outlet />
        </main>
        <ScrollToTop />
      </div>
    </div>
  )
}
