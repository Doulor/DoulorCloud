import * as React from "react"
import { Link, Outlet, useLocation } from "react-router-dom"
import { ArrowRight } from "lucide-react"

import { Logo } from "@/components/logo"
import { ThemeToggle } from "@/components/theme-toggle"
import { LangToggle } from "@/components/lang-toggle"
import { ScrollToTop } from "@/components/scroll-to-top"
import { PageEnter } from "@/components/page-enter"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/hooks/use-auth"
import { useT } from "@/i18n"
import { cn } from "@/lib/utils"

export function LandingLayout() {
  const { user } = useAuth()
  const location = useLocation()
  const { t } = useT()

  /**
   * 顶栏的「功能 / 更新 / 下载 / 常见问题」都是 `/#xxx` 锚点，而 react-router
   * **不会**自动滚动到对应元素（历史上没做这件事 ⇒ 点了没反应，2026-10-02 站长反馈）。
   * 这里监听 hash 变化手动滚；刚挂载时目标可能还没渲染出来，所以带重试。
   * 顶栏是 sticky，靠 section 的 scroll-margin-top 留出偏移（见 index.css）。
   */
  React.useEffect(() => {
    const hash = location.hash.replace(/^#/, "")
    if (!hash) return
    let attempts = 0
    let timer = 0
    const tick = () => {
      const el = document.getElementById(hash)
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" })
      } else if (attempts++ < 20) {
        timer = window.setTimeout(tick, 50)
      }
    }
    tick()
    return () => window.clearTimeout(timer)
  }, [location.hash])

  return (
    <div className="flex min-h-screen flex-col">
      {/* 这层刻意不铺 bg-background：底色由 body 提供，云纹背景画在 body 上，
          这里再铺一次不透明色就会把它整块盖住。
          顶栏用 glass-panel —— 与控制台一致的亚克力面板（原先只有 bg-background/80 + backdrop-blur）。 */}
      <header className="glass-panel sticky top-0 z-20 border-b">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-4 px-4 lg:px-8">
          <Logo />
          <nav className="ml-6 hidden items-center gap-1 md:flex">
            <Link
              to="/#features"
              className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
            >
              {t("landing.features")}
            </Link>
            <Link
              to="/#updates"
              className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
            >
              {t("landing.updates")}
            </Link>
            <Link
              to="/#download"
              className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
            >
              {t("landing.download")}
            </Link>
            <Link
              to="/#faq"
              className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
            >
              {t("landing.faq")}
            </Link>
            <Link
              to="/#contact"
              className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
            >
              {t("landing.contact")}
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <LangToggle />
            <ThemeToggle />
            {user ? (
              <Button asChild>
                <Link to="/dashboard">
                  {t("landing.enterDashboard")}
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            ) : (
              <>
                <Button variant="ghost" asChild className="hidden sm:inline-flex">
                  <Link
                    to="/login"
                    state={{ from: location.pathname }}
                    className={cn("hidden sm:inline-flex")}
                  >
                    {t("nav.login")}
                  </Link>
                </Button>
                <Button asChild>
                  <Link to="/register">{t("nav.register")}</Link>
                </Button>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1">
        {/* 页面内容渐入：只包内容区，顶栏在外面 ⇒ 切页时顶栏不会跟着闪 */}
        <PageEnter>
          <Outlet />
        </PageEnter>
      </main>

      <ScrollToTop />

      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 text-sm text-muted-foreground sm:flex-row lg:px-8">
          <div className="flex items-center gap-2">
            <Logo className="text-sm" />
          </div>
          <div className="flex items-center gap-4">
            <Link to="/terms" className="hover:text-foreground">{t("legal.terms")}</Link>
            <Link to="/privacy" className="hover:text-foreground">{t("legal.privacy")}</Link>
            <p>© {new Date().getFullYear()} Doulor Cloud</p>
          </div>
        </div>
      </footer>
    </div>
  )
}
