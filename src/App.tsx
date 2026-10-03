import * as React from "react"
import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom"
import { Loader2 } from "lucide-react"

import { LandingLayout } from "@/layouts/landing-layout"
import { DashboardLayout } from "@/layouts/dashboard-layout"
import { useAuth } from "@/hooks/use-auth"
import { communityApi } from "@/services/api"
import { AnalyticsTracker } from "@/components/analytics-tracker"
import { CursorGlow } from "@/components/cursor-effect"
import { AppealAckGate } from "@/components/appeal-ack-dialog"
import { NoticeAckGate } from "@/components/notice-ack-dialog"

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
const FeedbackPage = React.lazy(() => import("@/pages/feedback"))
const AchievementsPage = React.lazy(() => import("@/pages/achievements"))
const LeaderboardPage = React.lazy(() => import("@/pages/leaderboard"))
const PointsPage = React.lazy(() => import("@/pages/points"))
const AdminPage = React.lazy(() => import("@/pages/admin"))
const MessagesPage = React.lazy(() => import("@/pages/messages"))
const DmPage = React.lazy(() => import("@/pages/dm"))
const CommunityPage = React.lazy(() => import("@/pages/community"))
const ToolboxPage = React.lazy(() => import("@/pages/toolbox"))
const ToolboxDetailPage = React.lazy(() => import("@/pages/toolbox-detail"))
const SpacePage = React.lazy(() => import("@/pages/space"))
const ActivityPage = React.lazy(() => import("@/pages/activity"))
const AppealPage = React.lazy(() => import("@/pages/appeal"))
const ChatPage = React.lazy(() => import("@/pages/chat"))
const TermsPage = React.lazy(() => import("@/pages/terms"))
const PrivacyPage = React.lazy(() => import("@/pages/privacy"))
const ForgotPasswordPage = React.lazy(() => import("@/pages/forgot-password"))
const ResetPasswordPage = React.lazy(() => import("@/pages/reset-password"))

function PageLoader() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  )
}

/*
 * 这里原本有一个 FullScreenLoader —— 屏幕正中一个三行骨架。
 * 已移除：进入页面时已经有开屏动画盖住加载期，骨架紧接着开屏淡出再闪一下反而更乱；
 * 而且认证请求通常远早于开屏结束就回来了，那段骨架多数时候根本看不到。
 * 现在 loading 期间直接不渲染，露出 body 的底色与云纹背景，视觉上是干净的。
 */

/**
 * 控制台外壳闸门。默认要求登录，但两类公开页例外：
 *   · 社区广场：游客也能进（侧边栏照常在），是否开放由后台开关控制；
 *   · 临时分享箱：分享链接 /t?code=... 收敛到这里，收件人无需登录即可查看下载。
 * 让它们都走同一个外壳，就能满足「访问即见侧边栏」和「其余 tab 需登录」两个诉求。
 */
function DashboardGate() {
  const { user, loading } = useAuth()
  const location = useLocation()
  const isCommunity = location.pathname.startsWith("/dashboard/community")
  // 分享箱公开页：任何人（含访客）都能进 —— 查看/下载本就不需要登录
  const isTempbox = location.pathname.startsWith("/dashboard/tempbox")
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

  // 加载期不渲染任何东西（原为一个居中骨架，已按要求去掉）：
  // 露出 body 底色与云纹背景即可，等状态就绪直接进页面，由 PageEnter 做渐入。
  if (loading) return null
  if (!user && isCommunity && guestAccess === null) return null
  const isPublic = isTempbox || (isCommunity && guestAccess !== false)
  if (!user && !isPublic) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }
  return <DashboardLayout allowGuest={!user} />
}

function RedirectIfAuthed({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return null
  if (user) return <Navigate to="/dashboard" replace />
  return <>{children}</>
}

/** 公开短链 /community[/:id] 收敛到控制台路由，保证侧边栏始终在场 */
function CommunityRedirect() {
  const { id } = useParams<{ id: string }>()
  return <Navigate to={id ? `/dashboard/community/${id}` : "/dashboard/community"} replace />
}

/**
 * 公开短链 /t?code=... 收敛到控制台路由。
 *
 * 分享箱原先是脱离外壳的独立页（无侧边栏、无 max-w 容器），在桌面宽屏下
 * 两栏 grid 会横向铺满整屏，比例失真。收敛进 /dashboard/tempbox 后，
 * 与社区广场一样走同一个外壳：侧边栏在场、内容落在 max-w-6xl 容器里。
 * ⚠️ 必须带上 location.search —— 接收码 `?code=` 全靠它透传，丢了就解不开。
 */
function TempboxRedirect() {
  const location = useLocation()
  return <Navigate to={`/dashboard/tempbox${location.search}`} replace />
}

export default function App() {
  // 懒加载页面的加载态。放在 Routes 外层统一兜住，页面切换时只闪一个转圈。
  // 开屏动画不在这里 —— 它直接写在 index.html 里，那样页面一解析就显示，
  // 不必等这个 1.6 MB 的 JS 包下载执行完（等 React 挂载时页面早出来了，再盖一层没意义）。
  return (
    <React.Suspense fallback={<PageLoader />}>
      <AnalyticsTracker />
      <CursorGlow />
      {/* 申诉回复强制确认：全站挂一次，登录后只要有未读回复就弹不可关闭的窗 */}
      <AppealAckGate />
      {/* 管理端通知强制已读：同样全站挂一次 */}
      <NoticeAckGate />
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
        <Route path="terms" element={<TermsPage />} />
        <Route path="privacy" element={<PrivacyPage />} />
        {/* 封禁申诉：必须是公开路由（被封禁用户没有会话） */}
        <Route path="appeal" element={<AppealPage />} />
        <Route path="forgot-password" element={<ForgotPasswordPage />} />
        <Route path="reset-password" element={<ResetPasswordPage />} />
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
        <Route path="toolbox" element={<ToolboxPage />} />
        <Route path="toolbox/:toolId" element={<ToolboxDetailPage />} />
        <Route path="chat" element={<ChatPage />} />
        <Route path="achievements" element={<AchievementsPage />} />
        <Route path="leaderboard" element={<LeaderboardPage />} />
        <Route path="points" element={<PointsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="messages" element={<MessagesPage />} />
        {/* 一对一私信：带用户名就是打开某个会话，不带就是纯列表 */}
        <Route path="dm" element={<DmPage />} />
        <Route path="dm/:username" element={<DmPage />} />
        {/* 消息中心每个分类都有自己的 URL（深链）：/dashboard/messages/<system|site|social|event> */}
        <Route path="messages/:category" element={<MessagesPage />} />
        <Route path="donations" element={<DonationPage />} />
        <Route path="feedback" element={<FeedbackPage />} />
        <Route path="admin" element={<AdminPage />} />
      </Route>

      {/* 临时分享箱公开短链：收敛到控制台路由，保证侧边栏在场且比例正常 */}
      <Route path="t" element={<TempboxRedirect />} />

      {/*
        个人空间：公开页（无需登录）—— 社区里点别人头像就跳这里。
        路径刻意选 /space/<用户名> 而不是 /u/<用户名>：`/u/*` 这条 Route 已经
        被 API Worker 占着（公开头像 /u/<用户名>/avatar），走 SPA 会被它拦掉；
        放 /space/* 则天然由静态站点 Worker 兜底（SPA fallback），不需要动
        Cloudflare 上的 Route 配置。
      */}
      <Route path="space/:username" element={<SpacePage />} />

      {/*
        活动详情 / 分享页：公开页（无需登录）。
        活动卡片上的「分享」复制这个链接，别人点开直接看到活动内容并参与；
        未登录时展示「登录后参与」。与 /space/* 同理走 SPA fallback。
      */}
      <Route path="activity/:id" element={<ActivityPage />} />

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