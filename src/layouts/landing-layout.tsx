import { Link, Outlet, useLocation } from "react-router-dom"
import { ArrowRight } from "lucide-react"

import { Logo } from "@/components/logo"
import { ThemeToggle } from "@/components/theme-toggle"
import { ScrollToTop } from "@/components/scroll-to-top"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/hooks/use-auth"
import { cn } from "@/lib/utils"

export function LandingLayout() {
  const { user } = useAuth()
  const location = useLocation()

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-20 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-4 px-4 lg:px-8">
          <Logo />
          <nav className="ml-6 hidden items-center gap-1 md:flex">
            <a
              href="#features"
              className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
            >
              功能
            </a>
            <a
              href="#how"
              className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
            >
              原理
            </a>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            {user ? (
              <Button asChild>
                <Link to="/dashboard">
                  进入控制台
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
                    登录
                  </Link>
                </Button>
                <Button asChild>
                  <Link to="/register">注册</Link>
                </Button>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1">
        <Outlet />
      </main>

      <ScrollToTop />

      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 text-sm text-muted-foreground sm:flex-row lg:px-8">
          <div className="flex items-center gap-2">
            <Logo className="text-sm" />
          </div>
          <p>© {new Date().getFullYear()} Doulor Cloud</p>
        </div>
      </footer>
    </div>
  )
}
