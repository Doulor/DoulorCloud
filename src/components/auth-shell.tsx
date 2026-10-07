import * as React from "react"
import { Link } from "react-router-dom"

import { Logo } from "@/components/logo"
import { GitHubMark } from "@/components/github-mark"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useT } from "@/i18n"
import { REPO_URL } from "@/lib/site-links"

interface AuthShellProps {
  title: string
  /** 可选：不传就只显示标题（注册页已不再展示副标题） */
  description?: React.ReactNode
  footer: React.ReactNode
  children: React.ReactNode
}

export function AuthShell({ title, description, footer, children }: AuthShellProps) {
  const { t } = useT()
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center px-4 py-16 sm:py-24">
      <div className="mb-8">
        <Logo className="text-lg" />
      </div>
      <Card className="w-full">
        <CardHeader className="space-y-2">
          <CardTitle className="text-xl">{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
      <p className="mt-6 text-center text-sm text-muted-foreground">{footer}</p>
      {/* 开源仓库入口。放在认证页是因为：从搜索引擎或别人分享直接落到登录/注册页的人
          比到落地页的多，这里补一个入口最省事。样式刻意低调，不抢表单的注意力。 */}
      <a
        href={REPO_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
      >
        <GitHubMark className="h-3.5 w-3.5" />
        {t("landing.footer.repo")}
      </a>
    </div>
  )
}

export function AuthFooterLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      className="font-medium text-foreground underline-offset-4 hover:underline"
    >
      {label}
    </Link>
  )
}
