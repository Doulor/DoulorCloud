import * as React from "react"
import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom"
import { Loader2 } from "lucide-react"

import { LandingLayout } from "@/layouts/landing-layout"
import { DashboardLayout } from "@/layouts/dashboard-layout"
import { useAuth } from "@/hooks/use-auth"
import { communityApi } from "@/services/api"
import { Skeleton } from "@/components/ui/skeleton"
import { AnalyticsTracker } from "@/components/analytics-tracker"
import { CursorGlow } from "@/components/cursor-effect"

// 首屏必需的页面（访客第一眼就要看到）保持同步导入
import LandingPage from "@/pages/landing"
import LoginPage from "@/pages/login"
import RegisterPage from "@/pages/register"
import NotFoundPage from "@/pages/not-found"

// 其余页面按路由懒加载：不登录的访客不必为管理后台等重页面付出下载与解析成本。
// 其中 admin.tsx 单个文件就有 4000+ 行，是首屏包体的最大来源。
const DashboardPage = React.lazy(() => import("@/pages/dashboard"))
const DomainsPage = React.lazy(() => import("@/pages/domains"))
const EmailPage = React.lazy(() => import("@/pages/email"))
const StoragePage = React.lazy(() => import("@/pages/storage"))
const AiPage = React.lazy(() => import("@/pages/ai"))
const FrpPage = React.lazy(() => import("@/pages/frp"))
const ProfilePage = React.lazy(() => import("@/pages/profile"))
const ProxyPage = React.lazy(() => import("@/pages/proxy"))
const TempboxPage = React.lazy(() => import("@/pages/tempbox"))
const OAuthConsentPage = React.lazy(() => import("@/pages/oauth-consent"))
const SettingsPage = React.lazy(() => import("@/pages/settings"))
const DonationPage = React.lazy(() => import("@/pages/donations"))
const AchievementsPage = React.lazy(() => import("@/pages/achievements"))
const AdminPage = React.lazy(() => import("@/pages/admin"))
const CommunityPage = React.lazy(() => import("@/pages/community"))
const ChatPage = React.lazy(() => import("@/pages/chat"))

function PageLoader() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  )
}

function FullScreenLoader() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-sm space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </div>
  )
}

/**
 * 控制台外壳闸门。默认要求登录，但社区广场例外：
 * 游客也能进入（侧边栏照常在），只是侧边栏入口都引导去登录。
 * 这样「访问广场侧边栏必在」和「其余 tab 需登录」两个诉求在同一个外壳里满足。
 * 管理员在后台关闭「允许访客访问帖子广场」后，游客连广场也进不去。
 */
function DashboardGate() {
  const { user, loading } = useAuth()
  const location = useLocation()
  const isCommunity = location.pathname.startsWith("/dashboard/community")
  // 游客态才需要探测后台开关；已登录用户不受该设置影响
  const [guestAccess, setGuestAccess] = React.useState<boolean | null>(null)
  React.useEffect(() => {
    if (user || !isCommunity) return
    let cancelled = false
    communityApi
      .getConfig()
      .then((c) => {
        if (!cancelled) setGuestAccess(c.guestAccess)
      })
      .catch(() => {
        if (!cancelled) setGuestAccess(true)
      })
    return () => {
      cancelled = true
    }
  }, [user, isCommunity])

  if (loading) return <FullScreenLoader />
  if (!user && isCommunity && guestAccess === null) return <FullScreenLoader />
  const isPublic = isCommunity && guestAccess !== false
  if (!user && !isPublic) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }
  return <DashboardLayout allowGuest={!user} />
}

function RedirectIfAuthed({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <FullScreenLoader />
  if (user) return <Navigate to="/dashboard" replace />
  return <>{children}</>
}

/** 公开短链 /community[/:id] 收敛到控制台路由，保证侧边栏始终在场 */
function CommunityRedirect() {
  const { id } = useParams<{ id: string }>()
  return <Navigate to={id ? `/dashboard/community/${id}` : "/dashboard/community"} replace />
}

export default function App() {
  // 懒加载页面的加载态。放在 Routes 外层统一兜住，页面切换时只闪一个转圈。
  return (
    <React.Suspense fallback={<PageLoader />}>
      <AnalyticsTracker />
      <CursorGlow />
      <AppRoutes />
    </React.Suspense>
  )
}

function AppRoutes() {
  return (
    <Routes>
      <Route element={<LandingLayout />}>
        <Route index element={<LandingPage />} />
        <Route
          path="login"
          element={
            <RedirectIfAuthed>
              <LoginPage />
            </RedirectIfAuthed>
          }
        />
        <Route
          path="register"
          element={
            <RedirectIfAuthed>
              <RegisterPage />
            </RedirectIfAuthed>
          }
        />
        <Route path="community" element={<CommunityRedirect />} />
        <Route path="community/:id" element={<CommunityRedirect />} />
      </Route>

      <Route
        path="dashboard"
        element={<DashboardGate />}
      >
        <Route index element={<DashboardPage />} />
        <Route path="domains" element={<DomainsPage />} />
        <Route path="dns" element={<Navigate to="/dashboard/domains" replace />} />
        <Route path="email" element={<EmailPage />} />
        <Route path="storage" element={<StoragePage />} />
        <Route path="ai" element={<AiPage />} />
        <Route path="frp" element={<FrpPage />} />
        <Route path="proxy" element={<ProxyPage />} />
        <Route path="tempbox" element={<TempboxPage />} />
        <Route path="profile" element={<ProfilePage />} />
        <Route path="community" element={<CommunityPage inDashboard />} />
        <Route path="community/:id" element={<CommunityPage inDashboard />} />
        <Route path="chat" element={<ChatPage />} />
        <Route path="achievements" element={<AchievementsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="donations" element={<DonationPage />} />
        <Route path="admin" element={<AdminPage />} />
      </Route>

      {/* 临时分享箱公开页（无需登录） */}
      <Route path="t" element={<TempboxPage />} />

      {/*
        OAuth 同意页：必须是公开路由，不能放进 DashboardGate。
        第三方站点把用户送来时，用户可能还没登录 —— 那种情况由
        /api/oauth/authorize 先 302 到登录页，登录后再回到 authorize，最终才到本页。
        若把它关在 DashboardGate 后面，未登录用户会在这里被二次拦截、丢掉回跳链路。
      */}
      <Route path="oauth/consent" element={<OAuthConsentPage />} />

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  )
}